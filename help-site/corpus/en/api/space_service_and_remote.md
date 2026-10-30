---
standard: help_api
id: help.api.space_service_and_remote
title: "SpaceService, serveSpace & RemoteSpace – Network RPC over Socket & TCP"
short: "Exposes spaces over Unix socket or TCP, also as a standalone service or through pi-serverd, with role policies, and serves RemoteSpace clients with stable retry identity."
tags: [spaceservice, servespace, remotespace, sockettransport, inprocesstransport]
owner: remote
related: [help.topic.space_service_and_remote_space, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# SpaceService, serveSpace & RemoteSpace – Network RPC over Socket & TCP

## Overview {#overview}

This lets several programs use the same space over a socket or TCP. `serveSpace` provides it on the server side, and `RemoteSpace` is the matching client. The client behaves like the local one, so you can use the same code.

## Technical Reference {#technical-reference}

`serveSpace(service, { listen, connection })` binds `SpaceService` to a Unix socket or TCP port. `new RemoteSpace(socketTransport(target), options)` connects as a client implementing `SpaceLike`. `npm run space-server -- --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT` starts the ready-made service (`src/standalone.ts`, no pi-durable, no model). There every connection is the same peer (`--peer`, otherwise `local`) with role `member`, so the socket belongs on a protected network or behind the gate.

```ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
```

## Roles And Failure Modes {#parameters}

- **`SpaceService`**: Transport-independent facade over `SpaceHost`; assigns each connection a trusted `Principal` via `IdentityAdapter` and enforces role policies.
- **`serveSpace`**: Binds the service to a Unix socket (`{ path }`) or TCP (`{ host, port }`). For the existing pi-server there are `withSpaceService` and `piServerTransport`.
- **`RemoteSpace`**: Full `SpaceLike` client with stable retry identity; blocking calls return `OutcomeUnknown` on transport failure and are resolved via `pollOperation`. It also offers `probe`, `batch`, `readChain`, `spaces()`, and `statsWithRevision()`; a feature an older server does not know gives `UnsupportedOperation`.
- **`inProcessTransport`**: The same client facade without networking – ideal for testing the remote boundary.
- **Errors**: The service sends error codes; `RemoteSpace` turns them into `RemoteError` or the local error class. Unclassified errors arrive as `Internal` with the message `internal error`, and only the host logs the cause.

### Service Methods And Roles {#methods-and-roles}

The service accepts `hello`, `generation`, `write`, `read`, `take`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `spaces`, `txn`, `lease`, `changes`, `wait`, `notify`, `events`, `ack`, and `batch`. `spaces` lists the host's spaces (`spaceId`, `alias`, `createdAt`), including those created at runtime. `hello` names the features; besides the methods these are `write.unique`, `write.transient`, `read.chain`, and `read.locked`.

| Role in `DEFAULT_POLICY` | Rights |
| --- | --- |
| `admin` | All methods, also beyond this list. |
| `host`, `member` | All methods named above. |
| `observer` | Reading and subscribing, including `spaces`, `stats`, `changes`, `notify`, `events`, `ack`; no writing. |
| `resolution` | Resolving open operations, `txn`, `lease`. |
| `unpaired` | Only `hello` and `generation`, plus its own pairing. |

Text is repaired on entry: `wellFormed` replaces an unpaired surrogate in strings and keys with U+FFFD before anything sees the call, including the argument hash. `maxPollMs` bounds a long poll (default 25 seconds). `wakeOnCommit` is optional and off by default: without it the service looks every 50 ms, with it at the first commit and then at most every 25 ms.

### Client Helpers {#client-helpers}

`phi-spaces` contains what every remote process needs. `parseTarget(spec)` reads `unix:/path`, `tcp:host:port`, or a bare path. `connectSpace(spec, { callTimeoutMs, connectTimeoutMs, attempts })` returns `{ space, transport, close }` (defaults 30 s, 5 s, 3 attempts); a blocking wait must stay below `callTimeoutMs`. Add `readExisting`, `takeExisting`, `StillHeld`, `peek`, `takeAll`, `awaitWork`, `keepAlive`, and `cutText`. The web processes' WebSocket gateway is in `phi-spaces/ws`: `upgradeWebSocket(req, socket, head, { maxMessagesPerMin })`, RFC 6455, text only, frames up to 1 MiB.

### The Host's Store {#store-host}

`openSqliteHost(path, options?)` opens the own SQLite store: WAL mode, one writer thread, `synchronous=FULL` by default, an owner lock in `path.owner`. A second process or a foreign file gives `StoreUnavailable`. `openOwnMemoryHost()` keeps everything in memory. Old pi-durable stores are not taken over. `OwnStoreHost.skipUnchangedRecords` is optional and off by default.

Three operations have similar names:

- `host.compact()` gives free pages of the SQLite file back: `{ freedPages, converted, error? }`, `null` in memory. The first call rewrites the file once with `VACUUM`, and commits wait meanwhile.
- `compactErasedSqlite(path, assertExclusiveFenced)` from `src/erasure-sqlite.ts` cleans a stopped file after an erasure, so no erased bytes stay in free pages or the WAL. The `phi-spaces` package does not export this function; it is a tool of the repository.
- `EntryReplicationController.compact(id)` compacts the history of replicated entries; see [Federation](help.api.federation_controller#parameters).

## Typical Use Cases {#use-cases}

- **Process separation (v3)**: Web server, chat worker, and subagent run as dedicated processes accessing the same chat space via `RemoteSpace` over a Unix socket.
- **Shared mailboxes**: Each remote consumer owns a durable mailbox; `events`/`ack` behave over the socket exactly as they do locally.
- **A service of its own**: `npm run space-server` provides a space with no further code; `pi-serverd` offers it as an additional service `space` when enabled for that.
