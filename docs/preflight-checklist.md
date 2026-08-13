# Preflight checklist

The ordered steps for a first production deploy, what to check after each
one, and how to undo it. [deployment.md](./deployment.md) explains why any
of this is the way it is; this is the list you work through with a
terminal open.

Nothing here is reversible-by-accident except step 8, and step 8 is one
command to undo.

## Decide before you start

Five things need a value before the first command. None of them can be
changed later without a restart, and two of them cannot be changed on one
side alone.

| Value           | Who decides                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Database        | A new database, or a new schema in an existing one. Not the platform's own tables. See [deployment.md](./deployment.md#the-database) |
| `JWT_SECRET`    | Generated once, set identically here and on the platform API. Step 2                                                                 |
| `JWT_ISSUER`    | Whatever the platform signs as `iss`. Must match exactly or every request 401s                                                       |
| `JWT_AUDIENCE`  | Whatever the platform signs as `aud`. Same                                                                                           |
| Public hostname | The name clients will use for HTTPS and WSS. Needs a DNS record before the proxy can get a certificate                               |

You also need to know whether the platform puts its user id in `sub`. If
it does, leave `JWT_USER_ID_CLAIM` unset. If it does not, that variable
has to name the claim it uses.

Single instance is the assumption throughout. `REDIS_URL` stays unset
until there is a second instance, and adding one later is a config change
and a restart, not a migration.

## 1. Create the database

Create a database this service owns, on the same Postgres the platform
already uses or a separate one. On Neon that is a new database inside the
existing project.

Note the connection string with `sslmode=verify-full` appended.

**Verify.** Connect and confirm you land somewhere empty:

```
psql "$DATABASE_URL" -c '\dt'
```

`Did not find any relations.` is the expected answer. Anything listing the
platform's tables means the connection string points at the shared
database and the next step will create tables next to them.

**Roll back.** Drop the database. Nothing else has touched it yet.

## 2. Generate the shared secret

```
openssl rand -base64 48
```

Put it straight into a password manager. This one value is what stands
between a stranger and every conversation in the system, and it has to
exist in two places at once.

**The platform API needs the same bytes.** The service verifies tokens the
platform signs, with an HMAC secret, which means both sides hold the same
string. In a NestJS host it is typically read under a name like
`JIFFY_MESSAGING_JWT_SECRET`; whatever it is called there, it is the same
value that goes into `JWT_SECRET` here.

Copy it once and paste it twice from the same clipboard entry. Do not
retype it, and check for a trailing newline or space, because the failure
mode is every request 401ing with a signature error and no other clue.

**Verify.** Compare a hash of both sides rather than the secret itself:

```
printf %s "$JWT_SECRET" | sha256sum
```

Same eight leading characters on both hosts is enough to know they match.

**Roll back.** Generate a new one and update both sides. There is nothing
persisted that depends on it.

## 3. Apply the schema

```
psql "$DATABASE_URL" -f src/adapters/postgres/schema.sql
```

If you took the separate-schema route instead of a separate database, set
`search_path` for this connection too, or the tables land in `public` and
the service will not find them.

**Verify.**

```
psql "$DATABASE_URL" -c '\dt'
```

Three tables: `conversations`, `conversation_participants`, `messages`.

**Roll back.** `DROP TABLE messages, conversation_participants, conversations;`
Safe while the service has never run. Not safe afterwards.

## 4. Write the environment file

On the host, in the directory you will run compose from:

```
cp .env.example .env
```

Fill in `DATABASE_URL`, `JWT_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE`.
Leave `REDIS_URL` and `JWT_JWKS_URI` commented out. Leave `PORT` at 8080.

**Verify.** Confirm the file is not world-readable and is not tracked:

```
git check-ignore -v .env
```

**Roll back.** Delete the file.

## 5. Pull the image

```
docker pull ghcr.io/zeeshanadilbutt/jiffy-messaging:0.1.0
```

**Verify.** Record the digest now, so a rollback later does not depend on
a tag still pointing where it does today:

```
docker image inspect --format '{{index .RepoDigests 0}}' \
  ghcr.io/zeeshanadilbutt/jiffy-messaging:0.1.0
```

**Roll back.** `docker image rm` the tag.

## 6. Start the service

```
docker compose -f docker-compose.prod.yml up -d
```

**Verify.** Three things, in order.

Config parsed and the process is listening. A bad environment fails here
with a named error rather than a stack trace:

```
docker compose -f docker-compose.prod.yml logs
```

Expect one line: `jiffy-messaging listening`, with
`"mode":"single instance, in-process"`.

Liveness and readiness, on the loopback address:

```
curl -fsS http://127.0.0.1:8080/health   # {"status":"ok"}
curl -fsS http://127.0.0.1:8080/ready    # {"status":"ready"}
```

`/health` passing while `/ready` returns 503 means the process is fine and
the database is not. Check `DATABASE_URL`, then the provider's IP
allowlist.

The container's own healthcheck agrees:

```
docker compose -f docker-compose.prod.yml ps
```

`healthy`, not `starting` or `unhealthy`.

**Roll back.** `docker compose -f docker-compose.prod.yml down`. The
database keeps whatever it has, which at this point is nothing.

## 7. Verify a token end to end

Before putting a proxy in front, prove the two sides agree about tokens.
Mint one from the platform API the way a client would, then use it:

```
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/conversations
```

`200` with `[]` is the answer you want. It proves the secret, the issuer,
the audience, and the user id claim all line up, which is the single most
likely thing to be wrong and the least obvious once traffic is flowing.

`401` means one of those four does not match. The response body does not
say which, so check them in that order.

**Roll back.** Nothing to undo. Fix the mismatched value in `.env`,
`docker compose -f docker-compose.prod.yml up -d` to restart with it.

## 8. Put the proxy in front

Add the site block, using the config in
[deployment.md](./deployment.md#reverse-proxy-and-tls) for whichever proxy
is already running on the host. Point DNS at it first, or the certificate
request fails.

Reload the proxy rather than restarting it, so nothing else it serves goes
down with it.

**Verify.** TLS and the REST path:

```
curl -fsS https://messaging.example.com/health
```

Then the part that breaks silently. A handshake that reaches the service
answers `101`; one the proxy consumed answers `200` or `400`:

```
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  "https://messaging.example.com/?token=$TOKEN"
```

`101 Switching Protocols` is the pass. `401` also proves the path is clear
and only says the token is stale.

Do not skip this because REST works. REST working is not evidence about
the upgrade path, and if the upgrade is broken you will find out from
users reporting that messages only appear after a reload.

Last, confirm `/metrics` is not reachable from outside:

```
curl -s -o /dev/null -w '%{http_code}\n' https://messaging.example.com/metrics
```

`404`. Anything else means the block did not take, and an unauthenticated
endpoint is publishing your traffic shape.

**Roll back.** Remove the site block and reload the proxy. The service
keeps running on loopback and only the platform API can reach it.

## 9. Turn it on for clients

Set the platform API's own configuration to point at this service:

- The base URL. Use `http://127.0.0.1:8080` for the server-to-server
  calls, not the public hostname. Same host, no TLS handshake, no
  round-trip through the proxy.
- The shared secret from step 2.
- The issuer and audience, matching what is in `.env` here.

Restart the platform API so it picks them up.

**Verify.** From a real client: open a conversation, send a message, and
confirm it arrives on a second signed-in session without a reload. That
last part is the only check that exercises the WebSocket end to end
through the proxy with a real token.

**Roll back.** Unset the messaging configuration on the platform API and
restart it. A platform built to treat missing messaging configuration as
"messaging is off" degrades to hiding the feature rather than erroring,
which makes this the safest switch in the list. Confirm that is how it
behaves before relying on it.

## Rolling back a version later

Pull the previous tag or the digest recorded in step 5, edit the image
line in `docker-compose.prod.yml`, and recreate:

```
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The schema is applied out of band and is additive, so a version rollback
does not need a database rollback unless a release note says otherwise.

## If you have to stop everything

```
docker compose -f docker-compose.prod.yml down
```

Messages already stored stay stored. Clients get a closed socket and a
connection refused on the REST calls the platform API proxies, which
surfaces as a 503 from the platform rather than a broken page, assuming
the platform treats an unreachable messaging service that way.
