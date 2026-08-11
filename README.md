# jiffy-messaging

Messaging between two users of a host platform, where the host platform
decides who is allowed to talk to whom. jiffy-messaging does not know what
a mentor or a mentee is. It knows that some external system granted user A
a conversation with user B, and it takes that grant as given.

It can run two ways from the same core:

- **Embedded**, as an npm package inside another Node process, called
  directly with no network hop.
- **Standalone**, as its own HTTP and WebSocket service, in a container.

Which mode you use is a deployment decision, not a code change. Both sides
share the same core service and the same storage and auth ports - see
[Architecture](#architecture) below and [PHASES.md](./PHASES.md) for how
this was built, in order.

## Install

```
npm install jiffy-messaging
```

## Embedded usage

```ts
import {
  createEmbeddedMessaging,
  PostgresConversationStore,
  PostgresMessageStore,
} from 'jiffy-messaging'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const embedded = createEmbeddedMessaging({
  conversations: new PostgresConversationStore(pool),
  messages: new PostgresMessageStore(pool),
  tokenVerifier: myTokenVerifier, // whatever verifies your platform's own tokens
})

const conversation = await embedded.messaging.createConversation(['mentor_1', 'mentee_1'])
await embedded.messaging.sendMessage({
  conversationId: conversation.id,
  senderId: 'mentor_1',
  body: 'How did the last session go?',
})
```

A runnable version of this, using in-memory adapters so it needs nothing
else running, is in [examples/embedded.ts](./examples/embedded.ts):

```
pnpm example:embedded
```

## Standalone usage

```
docker compose up
```

brings up Postgres, Redis, and two instances of the service on ports 8080
and 8081 (see [docker-compose.yml](./docker-compose.yml)). From there it's
a REST API plus a WebSocket for live delivery:

| Method | Path                          | Does                                    |
| ------ | ----------------------------- | ---------------------------------------- |
| POST   | /conversations                | Create a conversation                    |
| GET    | /conversations                | List the caller's conversations          |
| GET    | /conversations/:id            | Get one conversation                     |
| POST   | /conversations/:id/messages   | Send a message                           |
| GET    | /conversations/:id/messages   | List messages (`?limit=`, `?before=`)    |
| POST   | /conversations/:id/read       | Mark the conversation read               |
| GET    | /health                       | Liveness, no dependency checks           |
| GET    | /ready                        | Readiness, checks the database           |
| GET    | /metrics                      | Prometheus metrics                       |

Every route above the health/metrics group needs `Authorization: Bearer
<token>`. Connect to the WebSocket at `ws://host:port/?token=<token>` -
the token travels as a query parameter since browsers cannot set custom
headers on a WebSocket handshake. A connected client receives every new
message in a conversation it participates in, pushed as JSON.

A runnable version of the REST-plus-WebSocket flow above is in
[examples/networked.ts](./examples/networked.ts):

```
pnpm example:networked
```

## Configuration

Read by `src/main.ts` (the standalone server), all as environment
variables:

| Variable            | Required | Purpose                                                             |
| -------------------- | -------- | --------------------------------------------------------------------- |
| `DATABASE_URL`       | yes      | Postgres connection string                                          |
| `JWT_SECRET`         | one of these two | HMAC secret for token verification                          |
| `JWT_JWKS_URI`       |          | JWKS endpoint for token verification (wins if both are set)         |
| `PORT`               |          | Defaults to 8080                                                    |
| `JWT_ISSUER`         |          | Expected `iss` claim, if the platform sets one                      |
| `JWT_AUDIENCE`       |          | Expected `aud` claim, if the platform sets one                      |
| `JWT_USER_ID_CLAIM`  |          | Claim holding the user id, defaults to `sub`                        |
| `REDIS_URL`          |          | Unset runs a single instance; set to run more than one (see below)  |
| `LOG_LEVEL`          |          | Defaults to `info`                                                  |

## Architecture

Ports and adapters. The core (`src/core`, `src/domain`) has no framework
or database dependency - it depends only on the interfaces in `src/ports`,
never a concrete implementation:

- `ConversationStore` / `MessageStore` - persistence. Implemented by
  `src/adapters/in-memory` (tests, examples) and `src/adapters/postgres`
  (real use).
- `TokenVerifier` - authentication. Implemented by `src/adapters/jwt`
  against whatever platform is embedding or calling this service.
- `MessageBus` - real-time delivery. Implemented by
  `src/adapters/in-process` (single instance) and `src/adapters/redis`
  (more than one instance behind a load balancer - a message published on
  one instance still reaches a client connected to another).

`src/http` and `src/websocket` are the standalone-container adapters,
built on the same ports and the same core service; `src/embedded.ts` is
the in-process adapter. Neither is required by the other - an embedder
never pulls in Express or ws.

## Development

```
pnpm install
pnpm test            # fast, no infrastructure needed
pnpm test:integration # needs a real Postgres - see docker-compose.yml
pnpm typecheck
pnpm lint
pnpm build
```

## Kubernetes

Manifests and usage are in [k8s/](./k8s/README.md).

## Releasing

Pushing a tag matching `v*` builds and pushes a container image to GHCR
and publishes the npm package, via `.github/workflows/release.yml`.
Publishing to npm needs an `NPM_TOKEN` repo secret; nothing else does.

## Status

Complete - all 20 phases in [PHASES.md](./PHASES.md).

## License

MIT
