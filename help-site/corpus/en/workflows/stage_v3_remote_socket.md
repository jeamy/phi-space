---
standard: help_workflow
id: help.workflow.stage_v3_remote_socket
title: "Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Socket/TCP"
short: "Separates store, gateway, chat worker, and search subagent: one service exposes the space over socket or TCP, everyone else is a client."
tags: [v3, remotespace, spaceservice, servespace, socket, mailbox, events, ack]
owner: remote
related: [help.workflow.stage_v2_local_durable, help.workflow.stage_v4_gated_auth]
since: 0.0.1
---

# Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Socket/TCP

## Overview {#overview}

In Stage 3, the chat interface, worker, and search no longer work directly on the store. A service exposes the space over a socket, and everyone involved connects as a client. That lets you split the parts across separate processes or machines.

## Topology: Space Distribution {#topology}

In `help-site/examples/v3-remote-socket/run.ts`, the host exposes the space via `SpaceService` and `serveSpace` on a Unix domain socket (`serveSpace` can do TCP as well); gateway, worker, and subagent operate through `RemoteSpace`.

- **1 process, 1 host** (own SQLite store + `serveSpace`) exposes the `chat-v3` space over a **Unix socket** (`space.sock`).
- **3 separate `RemoteSpace` clients**, each with its own transport, access the same space: gateway (UI), chat worker, search subagent. All three connect as peer `remote-chat-peer` and therefore share one consumer mailbox; the program reads it through the worker.
- Distribution: **1 space, 1 server, 3 remote clients**. The socket boundary is real, the process boundary is not; the same engine runs unchanged against `RemoteSpace`.

## Workflow {#workflow}

### Step 1: Serve SpaceService On A Unix Socket {#step-1-serve}

```ts
const service = new SpaceService({
  host,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "remote-chat-peer", credentials: { roles: ["admin", "member"] } })
});
```

### Step 2: Connect RemoteSpace Clients {#step-2-remote-clients}

```ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
```

Because `RemoteSpace` implements the same `SpaceLike` interface as `PhiSpaces`, `SpaceChatEngine` from `help-site/examples/shared/chat-core.ts` runs unmodified over the wire protocol. The program also registers a `notify` subscription with `target: "self"`, reads the mailbox with `events({ waitMs: 50 })`, and acknowledges it with `ack(mailboxEpoch, next)`.

A standalone project needs less code: `connectSpace("unix:/path.sock")` from `phi-spaces` returns `{ space, close }`. `npm run space-server -- --store FILE|memory --listen unix:/path.sock` starts the server for it; there every connection is the same peer `local` with role `member`, so whoever reaches the socket uses the space.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
```

## See Also {#see-also}

- [Stage 4 (v4-gated-auth): Overlay Gate, Layer A/B & 60s Grants](help.workflow.stage_v4_gated_auth#overview)
