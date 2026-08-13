<h1 align="center">jiffy-messaging</h1>

<p align="center">
  Conversations and messages between users, for services that need
  messaging without owning it.
</p>

<p align="center">
  <a href="https://github.com/ZeeshanAdilButt/jiffy-messaging/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/ZeeshanAdilButt/jiffy-messaging/actions/workflows/ci.yml/badge.svg">
  </a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-5FA04E?logo=node.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

jiffy-messaging holds no opinion about who is allowed to talk to whom. Your
service decides that and creates the conversation; from then on this
handles storage, authorization against the conversation's participants,
history, read state, and live delivery.

It runs two ways from one core:

```
   embed it                              or run it
┌──────────────────┐              ┌──────────────────────┐
│  your service    │              │  your service        │
│  ┌────────────┐  │              └──────────┬───────────┘
│  │   jiffy    │  │                REST + WebSocket
│  └─────┬──────┘  │              ┌──────────▼───────────┐
└────────┼─────────┘              │  jiffy-messaging     │
         │                        └──────────┬───────────┘
    ┌────▼─────┐                        ┌────▼─────┐
    │ Postgres │                        │ Postgres │  + Redis
    └──────────┘                        └──────────┘   (multi-instance)
```

Same core, same ports, same behavior. Which one you use is a deployment
choice, not a rewrite.

## Why

Messaging is one of those features that looks small until you build it:
participant checks on every read and write, pagination, read state,
delivering to a client connected to a different replica than the one that
handled the send. This packages that once, behind an interface that does
not care whether it is a function call or an HTTP request.

## Contents

- [Install](#install)
- [Embedded usage](#embedded-usage)
- [Standalone usage](#standalone-usage)
- [HTTP API](#http-api)
- [WebSocket](#websocket)
- [Host authorization](#host-authorization)
- [Configuration](#configuration)
- [Running more than one instance](#running-more-than-one-instance)
- [Production deployment](#production-deployment)
- [Kubernetes](#kubernetes)
- [Architecture](#architecture)
- [Development](#development)

## Install

```
npm install jiffy-messaging
```

Or run it as a service — see [Standalone usage](#standalone-usage).

## Embedded usage

```ts
import {
  createEmbeddedMessaging,
  PostgresConversationStore,
  PostgresMessageStore,
} from 'jiffy-messaging'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const messaging = createEmbeddedMessaging({
  conversations: new PostgresConversationStore(pool),
  messages: new PostgresMessageStore(pool),
  tokenVerifier: myTokenVerifier, // verifies your service's own tokens
  // Optional. Omit it and any two authenticated callers may talk to each
  // other - see "Host authorization" below.
  // conversationGate: myConversationGate,
})

const conversation = await messaging.messaging.createConversation('user_1', ['user_1', 'user_2'])

await messaging.messaging.sendMessage({
  conversationId: conversation.id,
  senderId: 'user_1',
  body: 'Hello',
})

const history = await messaging.messaging.listMessages(conversation.id, 'user_2', { limit: 50 })
await messaging.messaging.markRead(conversation.id, 'user_2', new Date())
```

Every call after `createConversation` verifies the acting user is a
participant, and throws `NotAParticipantError` if not.

A runnable version using in-memory adapters, so it needs no database:

```
make example-embedded
```

## Standalone usage

```
make up
```

Brings up Postgres, Redis, and two service instances on ports 8080 and 8081. Or run the published image directly:

```
docker run -p 8080:8080 \
  -e DATABASE_URL=postgres://user:pass@host:5432/jiffy_messaging \
  -e JWT_SECRET=your-secret \
  ghcr.io/zeeshanadilbutt/jiffy-messaging:latest
```

Apply [src/adapters/postgres/schema.sql](./src/adapters/postgres/schema.sql)
to your database once before first run.

A runnable client exercising the REST and WebSocket flow end to end:

```
make example-networked
```

Running behind a reverse proxy (the documented VPS deployment uses nginx;
a typical Kubernetes ingress is the same shape) is the expected setup, not
an edge case: the standalone server trusts one hop of `X-Forwarded-For` by
default, which is what lets the IP-based rate limiter (see
[Configuration](#configuration)) see the actual client address instead of
the proxy's own address for every request. If your proxy chain has more
than one hop in front of this process, or you are exposing it directly
with no proxy at all, that needs to change — see `trustProxy` on
`createHttpApp`'s config, and make sure whatever sits in front of this
service is actually setting `X-Forwarded-For` itself rather than passing
through whatever a client sent (nginx does this by default; verify it if
you are fronting with something else).

## HTTP API

Every route below takes `Authorization: Bearer <token>`, verified through
the `TokenVerifier` your deployment configures.

| Method | Path                        | Body / query                   | Returns             |
| ------ | --------------------------- | ------------------------------ | ------------------- |
| POST   | /conversations              | `{ participantIds: string[] }` | 201, conversation   |
| GET    | /conversations              |                                | 200, conversation[] |
| GET    | /conversations/:id          |                                | 200, conversation   |
| POST   | /conversations/:id/messages | `{ body: string }`             | 201, message        |
| GET    | /conversations/:id/messages | `?limit=50&before=<ISO date>`  | 200, message[]      |
| POST   | /conversations/:id/read     |                                | 204                 |

`participantIds` on POST /conversations is capped at 50 entries; a longer
array gets a 400 rather than being accepted and inserted one row at a
time. GET .../messages defaults to `limit=50` when omitted and clamps any
larger value down to 200 - there is no way to ask for a whole
conversation's history in one request.

Errors: 400 malformed input, 401 missing or invalid token, 403 not a
participant (or, with a conversation gate configured, not authorized by
it), 404 unknown conversation, 429 rate limited.

Unauthenticated operational routes:

| Method | Path     | Purpose                                    |
| ------ | -------- | ------------------------------------------ |
| GET    | /health  | Liveness. No dependency checks             |
| GET    | /ready   | Readiness. Checks the database, 503 if not |
| GET    | /metrics | Prometheus metrics                         |

## WebSocket

```
ws://host:8080/?token=<token>
```

The token travels as a query parameter because browsers cannot set custom
headers on a WebSocket handshake. It is verified during the upgrade — an
unauthenticated caller never gets an open socket. If the token carries an
expiration, the connection is closed once it is reached, even if the
socket was still otherwise idle and open - a live connection does not
outlive the token that opened it.

A connected client receives every new message in every conversation it
participates in, pushed as JSON:

```json
{
  "id": "...",
  "conversationId": "...",
  "senderId": "user_1",
  "body": "Hello",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Delivery is push-only; send messages over the REST API.

## Host authorization

By default, any two authenticated callers may open a conversation with
each other and it stays usable forever - `POST /conversations` only checks
that the caller listed themselves in `participantIds`, nothing about
whether they should be talking to the other id(s) at all. That is the
right default for a service with no relationship model of its own (a
generic chat app where anyone can DM anyone), and it is what you get with
no further configuration.

A host that decides who may talk to whom - accepted contacts, team
membership, an accepted-share rule, anything - plugs that decision in by
implementing `ConversationGate`:

```ts
interface ConversationGate {
  canCreateConversation(requesterId: string, participantIds: string[]): Promise<boolean>
}
```

Pass an instance as `conversationGate` to `createEmbeddedMessaging`,
`createHttpApp`, or `createServer`. It is called before a conversation is
created, and again before every message send - so a relationship that
stops being true after creation (a revoked share, a removed contact) stops
the conversation from accepting new messages on the very next attempt,
without anything needing to actively archive it.

Two adapters ship with the package:

- `AllowAllGate` - the default. Always returns true. Passing it explicitly
  reads the same as omitting the option.
- `HttpConversationGate` - calls back to a host's own HTTP endpoint to ask
  the question, authenticated with a shared secret sent as
  `Authorization: Bearer <secret>`. Fails closed: unreachable, slow past
  its timeout, a non-2xx response, or a body other than `{ allowed: true }`
  are all treated as "not allowed" rather than opening the door because
  the thing meant to decide couldn't be reached.

```ts
import { HttpConversationGate } from 'jiffy-messaging'

const gate = new HttpConversationGate({
  url: 'https://api.example.com/internal/messaging/can-create-conversation',
  secret: process.env.CONVERSATION_GATE_SECRET!,
})
```

The standalone server builds one automatically from `CONVERSATION_GATE_URL`
and `CONVERSATION_GATE_SECRET` — see [Configuration](#configuration).

Writing your own adapter is just implementing the one-method interface -
nothing else in this package needs to know your relationship model exists.

## Configuration

| Variable                   | Required         | Purpose                                                                                          |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | yes              | Postgres connection string                                                                       |
| `JWT_SECRET`               | one of these two | HMAC secret for token verification                                                               |
| `JWT_JWKS_URI`             |                  | JWKS endpoint for token verification, wins if both are set                                       |
| `PORT`                     |                  | Defaults to 8080                                                                                  |
| `JWT_ISSUER`               | recommended      | Expected `iss` claim. Unset logs a warning at startup                                            |
| `JWT_AUDIENCE`             | recommended      | Expected `aud` claim. Unset logs a warning at startup                                            |
| `JWT_USER_ID_CLAIM`        |                  | Claim holding the user id, defaults to `sub`                                                     |
| `REDIS_URL`                |                  | Required to run more than one instance, see below                                                |
| `LOG_LEVEL`                |                  | Defaults to `info`                                                                                |
| `CONVERSATION_GATE_URL`    |                  | Host endpoint for authorization decisions, see [Host authorization](#host-authorization)         |
| `CONVERSATION_GATE_SECRET` |                  | Bearer credential sent to that endpoint. Must be set together with the URL above, or not at all  |

A token with no `exp` (expiration) claim is always rejected, regardless of
any of the above — that is not configurable. `JWT_ISSUER` and
`JWT_AUDIENCE` stay optional rather than required, since making them
mandatory would break a deployment that has not set them yet, but leaving
both unset means this service accepts a correctly-signed token issued for
a completely different platform or consumer as long as the signature
checks out. Set both in production; the process logs a warning at startup
if either is missing.

## Running more than one instance

A WebSocket client is connected to exactly one instance. Without a shared
bus, a message sent through instance A never reaches a client holding a
socket on instance B.

Set `REDIS_URL` and instances publish to a shared Redis channel instead of
an in-process emitter, so delivery works regardless of which instance
handled the send. Everything else is unchanged.

Rate limiting stays per instance — each enforces its own counters, so the
effective limit is the configured limit times the instance count.

## Production deployment

[docs/deployment.md](./docs/deployment.md) covers running the published
image on a single host: giving the service a database of its own, what
every environment variable actually does, and the reverse proxy in front
of it. Read the proxy section before writing one. A proxy that does not
forward the WebSocket upgrade leaves the REST API working and silently
kills live delivery, and nothing in the logs says so.

[docs/preflight-checklist.md](./docs/preflight-checklist.md) is the
ordered list for a first deploy, with what to verify after each step and
how to undo it.

```
cp .env.example .env
# fill in real values
docker compose -f docker-compose.prod.yml up -d
```

## Kubernetes

Deployment, Service, ConfigMap, Secret template, and HPA are in
[k8s/](./k8s/README.md).

```
make k8s-validate     # client-side validation, no cluster needed
make k8s-deploy       # applies k8s/ to the current context
```

## Architecture

Ports and adapters. The core (`src/core`, `src/domain`) has no framework or
database dependency — it depends only on interfaces in `src/ports`:

| Port                               | Purpose            | Implementations                                                       |
| ---------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `ConversationStore`/`MessageStore` | Persistence        | `adapters/in-memory`, `adapters/postgres`                             |
| `TokenVerifier`                    | Authentication     | `adapters/jwt` (HMAC secret or JWKS endpoint)                         |
| `MessageBus`                       | Real-time delivery | `adapters/in-process`, `adapters/redis`                               |
| `ConversationGate`                 | Host authorization | `adapters/conversation-gate` (`AllowAllGate`, `HttpConversationGate`) |

`src/http` and `src/websocket` are the standalone-service adapters;
`src/embedded.ts` is the in-process one. Both sit on the same core, and
neither depends on the other — embedding this never pulls in Express or ws.

Implement `TokenVerifier` yourself to plug in an auth scheme the JWT
adapter does not cover; nothing in the core will notice.

## Development

```
make help          # every target
make install
make test          # fast, no infrastructure
make test-all      # adds integration tests, needs Postgres
make check         # lint, typecheck, test, build
```

Integration tests run against a real Postgres:

```
make up-deps       # Postgres and Redis only
make test-integration
```

## Releasing

Push a tag matching `v*`. CI builds and pushes the container image to GHCR
and publishes the npm package.

## License

MIT
