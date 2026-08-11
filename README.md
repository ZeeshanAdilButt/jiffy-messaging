# jiffy-messaging

Messaging between two users of a host platform, where the host platform
decides who is allowed to talk to whom. jiffy-messaging does not know what
a mentor or a mentee is. It knows that some external system granted user A
a conversation with user B, and it takes that grant as given.

It can run two ways from the same core:

- **Embedded**, as an npm package inside another Node process, called
  directly with no network hop.
- **Standalone**, as its own HTTP and WebSocket service, in a container.

Which mode you use is a deployment decision, not a code change. See
[PHASES.md](./PHASES.md) for how this is being built, in order.

## Status

Early. Phase 1 of 20.

## License

MIT
