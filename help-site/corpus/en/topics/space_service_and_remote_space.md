---
standard: help_topic
id: help.topic.space_service_and_remote_space
title: "SpaceService, RemoteSpace, and Network Transports"
short: "How SpaceService enforces role policies, how the standalone service runs, and how RemoteSpace communicates over in-process, Unix socket, TCP, or pi-serverd transports with stable retries."
tags: [spaceservice, remotespace, socket, tcp, policy, identityadapter, outcomeunknown]
owner: remote
related: [help.workflow.stage_v3_remote_socket, help.api.space_service_and_remote]
since: 0.0.1
---

# SpaceService, RemoteSpace, and Network Transports

## Overview {#overview}

As soon as several processes or machines use the same space, a service is needed in the middle. The space then runs in one process, and the others connect through a socket. If an answer gets lost on the way, the client repeats the call safely. To your program this looks almost like a local space.

### Technical Details {#technical-details}

When web servers, workers, and subagents run in separate processes or on different machines, `SpaceService` (`src/service.ts`) handles server-side dispatch while `RemoteSpace` (`src/remote.ts`) provides the client implementation.

## Concept And System Model {#concept-model}

### Standalone Service {#standalone}

```sh
npm run space-server -- --store ./space.db --listen unix:/tmp/space.sock
npm run space-server -- --store memory --listen tcp:127.0.0.1:7777
```

`src/standalone.ts` serves the own store with no pi-durable, no model and no agent, and starts the background maintenance with it. Once the service is ready it prints `[phi-spaces] ready on …`.

**Security boundary:** Every connection is the same peer (`--peer`, default `local`) with the `member` role. Whoever can reach the socket uses the space. So keep it on a unix socket or an internal address, or put the [overlay gate](help.topic.gate_auth_grants_and_recovery#overview) in front. An open TCP port is not protected.

### Client Helpers {#client-helpers}

`src/space-client.ts` holds what every process needs that uses a space somewhere else:

| Function | Content |
|---|---|
| `parseTarget(spec)` | `unix:/path`, `tcp:host:port` or a bare path becomes a listen target |
| `connectSpace(spec, options?)` | Returns `{ space, transport, close }`; defaults: call 30 s, connecting 5 s, 3 attempts |
| `readExisting` / `takeExisting` | Like `readIfExists`/`takeIfExists`, but tell "gone" (`null`) from "held" (`StillHeld`) |
| `peek(space, template)` | First match as a snapshot, without a claim |
| `takeAll(space, template)` | Takes every match free right now and returns the count |
| `awaitWork(space, template, waitMs, halt?)` | A blocking `read` without a transaction: `true` once work is there |
| `keepAlive(space, lease, leaseMs)` | Renews a lease every `leaseMs / 3`; returns the stop function |
| `cutText(text, max)` | Cuts text without leaving half an emoji |

```ts
import { connectSpace } from "phi-spaces";

const { space: client, close } = connectSpace("unix:/tmp/space.sock");
await client.write({ type: "Job", fields: { id: 1 } });
close();
```

For their browser connections, web processes use the WebSocket gateway `upgradeWebSocket(req, socket, head, { maxMessagesPerMin })` from `phi-spaces/ws` (RFC 6455, text only, frames up to 1 MiB).

### Authentication Via IdentityAdapter And Policy {#identity-and-policy}

`SpaceService` never trusts a principal sent inside a client JSON payload. Instead, its `IdentityAdapter` (`StaticIdentity` locally or `GateIdentity` over NetBird/Layer B) derives the `Principal` and roles (`DEFAULT_POLICY`: `admin`, `host`, `member`, `observer`, `resolution`, `unpaired`) from the trusted `Connection` context. `Policy` checks allowed methods and entry types before executing any call. A type grant covers subtypes: a write is allowed as soon as its type or one of its declared supertypes is granted. Because the writer declares the supertypes, a role granted `Job` can also write `{ type: "X", types: ["Job"] }`; type grants are therefore no integrity boundary for subtypes. Federation members, in contrast, enforce the supertypes declared in their type policy.

### Stable Retries And OutcomeUnknown In RemoteSpace {#remote-retries}

Before its first mutation, `RemoteSpace` automatically calls `hello` and `generation` and assigns a stable `requestId` to every mutating call. If a reply is lost on the socket/TCP transport, `RemoteSpace` retries with the **exact same `requestId`**. If `maxClientWaitMs` expires, it throws `OutcomeUnknown` while the host operation continues and can be resolved via `pollOperation`. Unclassified host errors arrive as code `Internal` with the fixed message `internal error`; only the host logs the actual error.

### When Waiting Calls Look Again {#polling}

Long waits (`read`/`take` in state `pending`, `events`, `changes`) run in rounds inside the service, at most 25 s per long poll.

- **Default**: The service looks again every 50 ms.
- **With `wakeOnCommit: true`** (`SpaceServiceOptions`, opt-in): It looks at the first commit, then for `read`, `take` and `events` at most every 25 ms. Without a commit it looks after 1 s at the latest. spaces-mmo turns this on.
- **Locally**: A waiting `PhiSpaces` call is woken by the change and then pauses for 20 ms plus up to 20 ms of jitter. A burst of writes thus costs one round, and many waiters do not all look in the same instant.

### Text, Statistics And The Space List {#service-details}

- **Well-formed text**: The service replaces an unpaired surrogate in any string or key with U+FFFD before anything sees the call, the argument hash included (`wellFormed`).
- **Typed misses**: `read` and `take` carry `locked` through the service; `hello` advertises the feature `read.locked`.
- **`spaces` / `RemoteSpace.spaces()`**: Lists the host's spaces (`spaceId`, `alias`, `createdAt`), including those created at runtime. The `observer` role may call it.
- **`RemoteSpace.statsWithRevision()`**: Returns the figures with the revision and `streamId` they were read at, plus `process` (CPU time and memory of the serving process). Two calls thus give the commits in between.

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): SpaceService & RemoteSpace in Practice](help.workflow.stage_v3_remote_socket#overview)
- [SpaceService, serveSpace & RemoteSpace API](help.api.space_service_and_remote)
