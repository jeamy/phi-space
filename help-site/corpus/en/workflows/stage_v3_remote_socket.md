---
standard: help_workflow
id: help.workflow.stage_v3_remote_socket
title: "Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Socket/TCP"
short: "Decouples space host, web gateway, chat worker, and search subagent into separate RemoteSpace connections over Unix socket or TCP with consumer mailboxes."
tags: [v3, remotespace, spaceservice, servespace, socket, mailbox, events, ack]
owner: remote
related: [help.workflow.stage_v2_local_durable, help.workflow.stage_v4_gated_auth]
since: 0.0.1
---

# Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Socket/TCP

## Overview {#overview}

In Stage 3 (`help-site/examples/v3-remote-socket/run.ts`), the chat gateway, chat worker, and search subagent no longer touch the `Harness` directly. Instead, the host exposes the space via `SpaceService` and `serveSpace` on a Unix domain socket (or TCP port), and all participants operate through `RemoteSpace`.

## Topology: Space Distribution {#topology}

- **1 host** (harness + SQLite + `serveSpace`) exposes the `chat-v3` space over a **Unix socket** (`space.sock`).
- **3 separate `RemoteSpace` clients** access the same space: gateway (UI), chat worker, search subagent — each with its own transport and consumer mailbox.
- Distribution: **1 space, 1 server, 3 remote consumers** — a real socket boundary instead of a shared in-memory object; the same engine runs unchanged against `RemoteSpace`.

## Workflow {#workflow}

### Step 1: Serve SpaceService On A Unix Socket {#step-1-serve}

```ts
const service = new SpaceService({
  host: harness,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "local-worker", credentials: { roles: ["admin", "member"] } })
});
```

### Step 2: Connect RemoteSpace Clients {#step-2-remote-clients}

```ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
```

Because `RemoteSpace` implements the exact same `SpaceLike` interface as `PiSpaces`, `SpaceChatEngine` from `help-site/examples/shared/chat-core.ts` runs unmodified over the wire protocol! Additionally, the worker registers a `notify`/`wait` subscription and drains its consumer mailbox via `events()` + `ack()`.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
```

## See Also {#see-also}

- [Stage 4 (v4-gated-auth): Overlay Gate, Layer A/B & 60s Grants](help.workflow.stage_v4_gated_auth#overview)
