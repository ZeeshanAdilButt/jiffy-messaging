# Production deployment

Running the published image as a standalone service on a single host,
behind a reverse proxy that terminates TLS. [k8s/](../k8s/README.md)
covers the cluster path instead; everything about the database, the
configuration, and the proxy below applies to both.

For the ordered steps of an actual first deploy, and how to undo one, see
[preflight-checklist.md](./preflight-checklist.md).

## Contents

- [The database](#the-database)
- [Configuration](#configuration)
- [Running the image](#running-the-image)
- [Reverse proxy and TLS](#reverse-proxy-and-tls)
- [Health and readiness](#health-and-readiness)
- [Metrics](#metrics)
- [More than one instance](#more-than-one-instance)
- [Upgrading](#upgrading)

## The database

This service owns its storage. Give it a database of its own rather than
pointing it at the one the host platform already uses.

[schema.sql](../src/adapters/postgres/schema.sql) creates three tables:
`conversations`, `conversation_participants`, and `messages`. Every query
in the Postgres adapter names those tables unqualified, so they resolve
through whatever `search_path` the connection has. Point the service at a
shared database and those three names get claimed in that database's
`public` schema, next to the platform's own tables, where a future
platform migration is free to collide with them. Nothing enforces the
separation but the connection string.

Two ways to get that separation, in order of preference.

**A separate database.** On a managed provider this is usually a single
action in the console. On Neon, create a new database inside the existing
project: it lands on the same compute and the same branch, and it costs
nothing extra, but the tables are unreachable from the platform's own
connection string. Creating a whole separate project also works and gets
you independent branching and backups, at the cost of a second compute to
keep track of.

**A separate schema.** If a second database is not an option, create a
schema and pin the connection to it:

```sql
CREATE SCHEMA jiffy_messaging;
```

```
postgres://user:password@host/appdb?options=-c%20search_path%3Djiffy_messaging
```

node-postgres forwards `options` in the startup packet, so every
connection in the pool resolves the unqualified table names to that
schema. Apply the schema with the same `search_path` set, or the tables
land in `public` and the pin silently points at nothing.

### Applying the schema

There is no migration framework and no migration step in the container.
The schema is applied once, out of band, before the first start:

```
psql "$DATABASE_URL" -f src/adapters/postgres/schema.sql
```

Every statement is `CREATE TABLE IF NOT EXISTS` or
`CREATE INDEX IF NOT EXISTS`, so re-running it against an existing
database is a no-op rather than an error.

`gen_random_uuid()` is built into Postgres 13 and later. On 12 or older
you need `CREATE EXTENSION pgcrypto` first.

### TLS on the database connection

node-postgres reads `sslmode` out of the connection string, so a managed
provider needs no extra configuration beyond getting it into
`DATABASE_URL`.

Use `sslmode=verify-full` with any provider whose certificate chains to a
public CA, which covers Neon, RDS, and Supabase. `sslmode=require` also
connects, but node-postgres treats it as deprecated and logs a warning on
startup telling you to use `verify-full` if you want the behavior you are
already getting. Save yourself the log line.

Connection strings copied out of the Neon console may carry
`channel_binding=require` as well. node-postgres does not implement that
parameter and ignores it, which is harmless; drop it or leave it.

The pool is a plain `pg.Pool` with default sizing, so it opens up to ten
connections per instance. Point it at a pooled endpoint if your provider
offers one and your instance count makes that worthwhile.

## Configuration

Everything the process reads, and nothing else. `DATABASE_URL`, `PORT`,
the `JWT_*` set, `REDIS_URL`, and `CORS_ORIGIN` are parsed by `parseEnv` in
[src/main.ts](../src/main.ts), which runs before anything connects to
anything, so a bad value fails the start with a named error instead of
half-booting. `LOG_LEVEL` is read separately by
[src/observability/logger.ts](../src/observability/logger.ts) at import
time.

| Variable            | Required         | Default | Purpose                                                    |
| ------------------- | ---------------- | ------- | ---------------------------------------------------------- |
| `DATABASE_URL`      | yes              |         | Postgres connection string for this service's own database |
| `JWT_SECRET`        | one of these two |         | HMAC secret used to verify incoming tokens                 |
| `JWT_JWKS_URI`      | one of these two |         | JWKS endpoint, used instead of a secret                    |
| `CORS_ORIGIN`       | yes              |         | Comma-separated browser origins allowed to call the REST API - see [Cross-origin requests from a browser](#cross-origin-requests-from-a-browser) |
| `JWT_ISSUER`        | no               | unset   | Expected `iss` claim, checked only when set                |
| `JWT_AUDIENCE`      | no               | unset   | Expected `aud` claim, checked only when set                |
| `JWT_USER_ID_CLAIM` | no               | `sub`   | Claim carrying the platform's user id                      |
| `PORT`              | no               | `8080`  | Listen port                                                |
| `REDIS_URL`         | no               | unset   | Required to run more than one instance, not before         |
| `LOG_LEVEL`         | no               | `info`  | pino level                                                 |

Anything else in the environment is ignored. The image sets
`NODE_ENV=production` itself.

**`DATABASE_URL`.** Missing it is a hard failure at start:
`Missing required environment variable: DATABASE_URL`. See
[The database](#the-database) for what should be on the other end of it.

**`JWT_SECRET`.** The shared HMAC secret this service verifies bearer
tokens against. It has to be byte-identical to the secret the platform
signs those tokens with. Not equivalent, not the same passphrase run
through a different encoder: the same bytes. A trailing newline picked up
by copy-paste is enough to make every request 401 with nothing in the log
to explain it beyond `Invalid token: signature verification failed`.

Generate one and put it in both places at the same time:

```
openssl rand -base64 48
```

The platform side reads it under whatever name that codebase gives it,
commonly something like `JIFFY_MESSAGING_JWT_SECRET`. Rotating it means
restarting both sides; tokens minted under the old secret stop verifying
the moment this service restarts, so clients see a burst of 401s and
re-request a token. Short token lifetimes keep that burst small.

**`JWT_JWKS_URI`.** For a platform that has moved to rotating keys behind
a JWKS endpoint. It wins if both it and `JWT_SECRET` are set, so do not
leave a stale secret in the environment expecting it to be a fallback.
Nothing here caches beyond what jose's `createRemoteJWKSet` does on its
own, and an unreachable JWKS endpoint fails token verification rather than
the process.

**`JWT_ISSUER` and `JWT_AUDIENCE`.** Passed to jose's `jwtVerify` only
when set. Leave them unset and a token signed with the right secret
verifies regardless of what it claims about itself; that is fine when the
secret has exactly one holder, and pointless risk when it might not stay
that way. Set both to whatever the platform signs.

They are strict once set. `JWT_ISSUER=platform-api` against a token minted
with `iss: "platform-api "` is a 401, and the two sides drifting is the
most common cause of a deploy where the health checks pass and every real
request fails.

**`JWT_USER_ID_CLAIM`.** Leave it unset unless the platform puts its user
id somewhere other than `sub`. The verifier rejects a token whose named
claim is missing or is not a non-empty string, so a wrong value here fails
closed rather than authenticating the wrong person.

**`PORT`.** Defaults to 8080, which is what the image exposes and what the
compose healthcheck and the k8s probes assume. Change the host side of the
port mapping instead if 8080 is taken; there is no reason to move the
container-internal port.

**`REDIS_URL`.** Not required for one instance, required for more than
one. [More than one instance](#more-than-one-instance) has the reasoning.
Setting it for a single instance is harmless but buys nothing and adds a
dependency that `/ready` does not check.

**`LOG_LEVEL`.** A pino level: `trace`, `debug`, `info`, `warn`, `error`,
`fatal`, or `silent`. `info` gives you one line per HTTP request via
pino-http, plus connection open and close for every WebSocket. Output is
JSON on stdout, with no log file and no rotation of its own, so whatever
supervises the container owns that.

## Running the image

The image is published on every `v*` tag and is public:

```
ghcr.io/zeeshanadilbutt/jiffy-messaging:0.1.0
```

Tags are `<major>.<minor>.<patch>`, `<major>.<minor>`, and `latest`. Pin
production to the full version. `latest` moving under a host that pulls on
restart is how you find out about a release you did not intend to deploy.

The direct form:

```
docker run -d --name jiffy-messaging \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file .env \
  ghcr.io/zeeshanadilbutt/jiffy-messaging:0.1.0
```

Or use [docker-compose.prod.yml](../docker-compose.prod.yml), which is the
same thing with a restart policy, a healthcheck on `/ready`, and
configuration read from `.env`:

```
cp .env.example .env
# fill in real values
docker compose -f docker-compose.prod.yml up -d
```

`.env` is gitignored. [.env.example](../.env.example) documents every
variable and holds no real values.

Note the `127.0.0.1` in the port mapping. The service has no TLS of its
own and its `/metrics` endpoint is unauthenticated, so binding it to
loopback and letting the proxy be the only thing that can reach it is the
right default. Drop that prefix only if something other than a proxy on
the same host has to connect.

The root `docker-compose.yml` is a development environment. It builds from
source, runs a throwaway Postgres and Redis, hardcodes a dev secret, and
starts two instances so cross-instance delivery is visible locally. None
of that belongs in production; use the `.prod` file.

## Reverse proxy and TLS

Browsers and mobile clients reach this over HTTPS and WSS, which means a
proxy in front terminating TLS. Two settings in that proxy decide whether
live delivery works, and getting either wrong fails in a way that looks
like the service is fine.

### The WebSocket upgrade

**A proxy that does not forward the `Upgrade` and `Connection` headers
breaks real-time delivery while leaving the REST API working perfectly.**

This is worth being blunt about because of how it presents. Messages send
successfully, history loads, read state updates, `/health` and `/ready`
are green, and the service logs nothing wrong, because from its side no
upgrade request ever arrived: the proxy consumed those headers and
forwarded an ordinary GET. The only symptom is that nobody receives
anything until they reload. It reads as a bug in the client.

**Caddy** forwards the upgrade without being asked. `reverse_proxy`
handles it natively, and the header manipulation you would write for nginx
is not just unnecessary here, it is a way to break it. Do not add
`header_up Connection` or `header_up Upgrade` to a Caddy site block.

```
messaging.example.com {
    encode gzip

    # /metrics is unauthenticated. Do not publish it. Two handle blocks
    # rather than a bare respond, because handle blocks are mutually
    # exclusive and evaluated in the order written, so this does not
    # depend on remembering Caddy's implicit directive ordering.
    handle /metrics {
        respond 404
    }

    handle {
        reverse_proxy 127.0.0.1:8080 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-Proto https
        }
    }
}
```

Validate before reloading, which catches a typo without taking the site
down:

```
caddy validate --config /path/to/Caddyfile --adapter caddyfile
```

**nginx** needs it spelled out, and needs HTTP/1.1, since upgrades do not
exist in HTTP/1.0:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name messaging.example.com;

    location /metrics {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Sockets here are idle by design. See below.
        proxy_read_timeout 3600s;
    }
}
```

IIS with ARR needs `webSocket enabled="true"` in `applicationHost.config`,
which is off in some default installs.

Verify the upgrade survives the proxy rather than assuming it does. A
handshake that reaches the service answers `101`, and one the proxy ate
answers `200` or `400`:

```
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  "https://messaging.example.com/?token=$TOKEN"
```

`HTTP/1.1 101 Switching Protocols` means the path is clear. `401` means
the path is clear and the token is wrong, which is also a pass for this
purpose.

### Idle timeouts

The second silent failure. This service pushes to clients and never pings
them, and a conversation that nobody is typing in produces no frames in
either direction. A proxy that closes idle upstream connections closes
live sockets on a quiet chat.

nginx's `proxy_read_timeout` defaults to 60 seconds, which means a client
gets disconnected a minute into every quiet stretch. Raise it, as above.
Caddy sets no read timeout on a proxied stream by default and needs
nothing. Clients should reconnect on close regardless, but a
reconnect-every-60-seconds loop is a bad way to find that out.

### Forwarded client addresses

Express `trust proxy` is not enabled, deliberately: honoring
`X-Forwarded-For` means trusting whatever set it, and that is a decision
for a deployment rather than a default.

The consequence behind a proxy is that the IP-based rate limiter sees the
proxy's address on every request, so its 300-requests-per-minute budget
becomes one shared budget across all clients rather than one per client.
The per-user limiter is unaffected, because it keys on the verified user
id from the token, and that is the limit that actually matters on the
authenticated surface.

express-rate-limit notices the mismatch and logs a validation warning once
on the first proxied request:

```
ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
```

That warning is expected behind a proxy with this configuration. If the
shared IP budget is a problem, rate limit at the proxy, where the real
client address is known and trusted.

The WebSocket connection limiter has the same property for the same
reason, and its comment in
[websocket-server.ts](../src/websocket/websocket-server.ts) says so: 20
connection attempts per minute, keyed on the proxy's address behind a
proxy.

### Cross-origin requests from a browser

The REST surface is meant to be called directly by a browser on a
different origin from this service - the platform's own web app mints a
messaging token server-side (so `JWT_SECRET` never reaches the client) and
then calls `/conversations` and friends from the browser itself, the same
origin the WebSocket already connects from. `CORS_ORIGIN` (see Repository
variables in [vps-deploy.md](./vps-deploy.md#repository-variables)) is
required for exactly this: it is a comma-separated allowlist passed to the
`cors` middleware, mounted ahead of everything else in `createHttpApp` so
the preflight OPTIONS request - which carries no bearer token, by design -
is answered before it can reach the auth middleware and get 401'd.

Authorization is not a CORS-safelisted header, so every authenticated call
from a browser is preceded by a preflight. With `CORS_ORIGIN` unset (or
pointed at the wrong origin), that preflight either 401s or succeeds with
no `Access-Control-Allow-Origin` on the response - either way the browser
blocks the real request before it is ever sent, and it looks like a dead
network connection from the client, not an auth failure.

Do not reach for a wildcard origin; the surface is authenticated and every
route is a real user's private data. List the exact origins that need to
reach it.

If instead your integration calls this service server to server - the
platform's own API, on the loopback address, with a token minted for the
acting user, and only the WebSocket talks to this service directly from a
browser - CORS_ORIGIN still has to be set to something for the process to
start, but nothing needs to be listed in it beyond what genuinely calls
the REST API from a browser; WebSocket handshakes are not subject to CORS
either way.

## Health and readiness

Both are unauthenticated and are not rate limited, because a load
balancer, kubelet, or scrape has no token to send and should never be
throttled.

| Path      | Checks                 | Meaning                                  |
| --------- | ---------------------- | ---------------------------------------- |
| `/health` | The process only       | This process is up and serving HTTP      |
| `/ready`  | `SELECT 1` on the pool | This instance can serve real traffic now |

The split is deliberate. `/health` touching no dependency is what stops a
slow or briefly unreachable database from getting a process killed and
restarted when it would have recovered on its own. `/ready` returning 503
takes an instance out of rotation without restarting it, which is the
right response to exactly that situation.

`/ready` does not check Redis. A multi-instance deployment whose Redis is
down still reports ready and still serves REST correctly; what it loses is
cross-instance delivery.

Verifying a deploy:

```
curl -fsS http://127.0.0.1:8080/health     # {"status":"ok"}
curl -fsS http://127.0.0.1:8080/ready      # {"status":"ready"}
curl -fsS https://messaging.example.com/health
```

`/health` passing while `/ready` returns 503 means the process is fine and
the database is not: wrong `DATABASE_URL`, a firewall or IP allowlist in
the way, or a TLS mode the provider will not accept.

## Metrics

`GET /metrics` serves the Prometheus text format from
[src/observability/metrics.ts](../src/observability/metrics.ts): the
prom-client default process and Node runtime collectors, plus four of our
own.

| Metric                                          | Type      | Labels                      |
| ----------------------------------------------- | --------- | --------------------------- |
| `jiffy_messaging_http_requests_total`           | counter   | `method`, `route`, `status` |
| `jiffy_messaging_http_request_duration_seconds` | histogram | `method`, `route`, `status` |
| `jiffy_messaging_websocket_connections_active`  | gauge     |                             |
| `jiffy_messaging_messages_published_total`      | counter   |                             |

Everything is per instance and per process. The connections gauge counts
sockets held by the instance answering the scrape, not by the deployment,
and it resets to zero on restart along with the counters.

The endpoint is unauthenticated and sits ahead of the auth middleware, so
do not publish it. Block it at the proxy, as both examples above do, and
scrape it over the loopback address.

## More than one instance

A WebSocket client is connected to exactly one instance. Without a shared
bus, a message sent through instance A never reaches a client holding a
socket on instance B, and the send still returns 201, so this too fails
quietly.

Set `REDIS_URL` on every instance and they publish to a shared Redis
channel instead of an in-process emitter. Nothing else changes, and no
session affinity is needed on the load balancer.

Rate limiting stays per instance. Both HTTP limiters and the WebSocket
connection limiter hold their counters in memory, so the effective limit
per client is the configured limit times the instance count.

## Upgrading

Note the digest you are running before you change the tag, so a rollback
does not depend on a tag still pointing where it did:

```
docker image inspect --format '{{index .RepoDigests 0}}' \
  ghcr.io/zeeshanadilbutt/jiffy-messaging:0.1.0
```

Then edit the tag in `docker-compose.prod.yml`, pull, and recreate:

```
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Rolling back is the same two commands with the previous tag or digest.
The schema is additive and applied out of band, so a version rollback does
not need a database rollback unless a release says otherwise.
