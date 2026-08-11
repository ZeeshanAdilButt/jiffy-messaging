# Build phases

Each phase leaves the repo in a working, tested, committed state. Phases
are ordered by real dependency, not difficulty. The core (phases 2 to 5)
has no framework or database dependency by design, so it can be tested and
reasoned about on its own before any transport or storage concern touches
it.

1. Project scaffold. Tooling, lint, format, test runner, CI skeleton,
   license, README stub.
2. Domain types. Conversation, Message, Participant. Plain TypeScript,
   no I/O.
3. Ports. The interfaces the core depends on: conversation storage,
   message storage, and token verification. No implementation yet.
4. In-memory adapter. Implements the storage ports without a database, so
   the core can be exercised end to end in tests.
5. Core service layer. Create conversation, send message, list messages,
   mark read. Built against the ports only, tested against the in-memory
   adapter.
6. Postgres adapter. Implements the same storage ports for real.
7. JWT verification adapter. Verifies tokens issued by a consuming
   platform. This is the plug-in boundary: any platform whose users carry
   a JWT can sit in front of this service without it knowing anything
   platform-specific.
8. Package entry point. A factory that wires ports and core into a single
   importable object for in-process embedding, no network hop.
9. HTTP layer. REST routes over the core, for standalone use.
10. WebSocket layer. Real-time delivery, authenticated through the same
    token verification port.
11. Standalone server. Wires HTTP, WebSocket, the Postgres adapter, and
    the JWT adapter into one runnable process.
12. Containerization. Dockerfile and a docker-compose file for local
    development against a real Postgres instance.
13. Cross-instance fan-out. A Redis pub/sub adapter so a message sent
    while a recipient is connected to one running instance still reaches
    them on another. Without this, running more than one instance breaks
    delivery.
14. Kubernetes manifests. Deployment, Service, ConfigMap, Secret template,
    horizontal pod autoscaler.
15. Health and readiness probes wired to the manifests above.
16. Rate limiting on both the HTTP and WebSocket surfaces.
17. Structured logging and basic metrics.
18. Integration tests against the real Postgres adapter and the HTTP and
    WebSocket layers end to end, not just the in-memory unit tests from
    phase 5.
19. CI and CD. Lint, typecheck, and test on every pull request. Build and
    push a versioned image on tag. Publish the package build on tag.
20. Documentation and an example consumer showing both the embedded and
    the networked integration.
