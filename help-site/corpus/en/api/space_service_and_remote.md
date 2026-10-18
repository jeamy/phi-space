---
standard: help_api
id: help.api.space_service_and_remote
title: "SpaceService, serveSpace & RemoteSpace – Network RPC over Socket & TCP"
short: "Exposes spaces over Unix socket, TCP, or pi-serverd with role policies and serves RemoteSpace clients with stable retry identity."
tags: [spaceservice, servespace, remotespace, sockettransport, inprocesstransport]
owner: remote
related: [help.topic.space_service_and_remote_space, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# SpaceService, serveSpace & RemoteSpace – Network RPC over Socket & TCP

## Overview {#overview}

`serveSpace(service, { listen, connection })` binds `SpaceService` to a Unix socket or TCP port. `new RemoteSpace(socketTransport(target), options)` connects as a client implementing `SpaceLike`.

## Technical Reference {#technical-reference}

```ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
```

## Roles And Failure Modes {#parameters}

- **`SpaceService`**: Transport-independent facade over `SpaceHost`; assigns each connection a trusted `Principal` via `IdentityAdapter` and enforces role policies.
- **`serveSpace`**: Binds the service to a Unix socket (`{ path }`) or TCP (`{ host, port }`); alternatively as a `pi-serverd` plugin.
- **`RemoteSpace`**: Full `SpaceLike` client with stable retry identity; blocking calls return `OutcomeUnknown` on transport failure and are resolved via `pollOperation`.
- **`inProcessTransport`**: The same client facade without networking – ideal for testing the remote boundary.

## Typical Use Cases {#use-cases}

- **Process separation (v3)**: Web server, chat worker, and subagent run as dedicated processes accessing the same chat space via `RemoteSpace` over a Unix socket.
- **Shared mailboxes**: Each remote consumer owns a durable mailbox; `events`/`ack` behave over the socket exactly as they do locally.
- **pi-server hosting**: `pi-serverd` exposes spaces as a persistent service to multiple machines on the network.
