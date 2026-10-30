---
standard: help_topic
id: help.topic.local_client_and_named_spaces
title: "Local Client PhiSpaces, Named Spaces, and startService"
short: "How PhiSpaces operates on the default space or named spaces (NamedSpace) and how startService drives the reaper and event delivery."
tags: [phispaces, namedspace, registry, createspace, listspaces, startservice]
owner: client
related: [help.topic.agent_tools_and_replay, help.api.phispaces_write]
since: 0.0.1
---

# Local Client PhiSpaces, Named Spaces, and startService

## Overview {#overview}

The local client is the simplest way into phi-spaces: your program opens a space right inside its own process, with no network at all. For separate topics you create several named spaces, like folders in a cabinet. A small background service clears out what has expired and delivers notices.

### Technical Details {#technical-details}

A host (the own store) holds the default space (`phi-spaces.space`, alias `"default"`) plus resource-bounded isolated **named spaces** (`phi-spaces.named-space`) tracked in the `Registry` (`phi-spaces.registry`).

## Concept And System Model {#concept-model}

### Opening A Host {#open-host}

```ts
import { openOwnMemoryHost, openSqliteHost } from "phi-spaces";

const fileHost = await openSqliteHost("./spaces.db"); // SQLite, one process owns the file
const memoryHost = openOwnMemoryHost();               // memory only
await fileHost.close(ctx);
await memoryHost.close(ctx);
```

- A second process on the same file gets `StoreUnavailable`. Several processes share a space through the [service](help.topic.space_service_and_remote_space#standalone).
- The store is described under [the own store](help.topic.architecture_layers#own-store).

### Creating And Opening Named Spaces {#named-spaces}

```ts
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";

// 1. Create a named space for a chat session inside a host commit:
await host.commit(async (tx) => {
  await createSpace(tx, "chat-session-alpha", Date.now());
}, ctx);

// 2. Point a PhiSpaces client at the named space:
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, {
  space: "chat-session-alpha"
});

// 3. Start background reaper and local event delivery across all spaces:
const stopService = await startService(host, ctx);
```

- Passing `conversationId` to `PhiSpaces` enables strict ownership enforcement (a conversation can only commit/abort its own transactions and renew/cancel its own leases).
- Omitting `conversationId` (`undefined`) runs in host/administrative mode, unlocking `setCompletionProfiles` and `setLimits`.
- Without a `space` option, `startService` also watches named spaces created later.

### Package And Imports {#package-imports}

Projects depend on the library with `"phi-spaces": "file:.."` and import through the package name. There is no build step; `exports` points at the TypeScript sources. Only these subpaths are contract:

| Import | Content |
|---|---|
| `phi-spaces` | Public API (`PhiSpaces`, `RemoteSpace`, `serveSpace`, `SpaceService`, errors) |
| `phi-spaces/context` | `Context`, `BACKGROUND_CONTEXT` |
| `phi-spaces/core` | Pure semantics: `matches`, error classes, types |
| `phi-spaces/store/host` | The own store in memory (`openOwnMemoryHost`) |
| `phi-spaces/store/sqlite` | The own SQLite store (`openSqliteHost`) |
| `phi-spaces/store/documents` | Document helpers of the store |
| `phi-spaces/ws` | WebSocket gateway of the web processes (`upgradeWebSocket`) |

## See Also {#see-also}

- [The 8 LLM Agent Tools and Replay Safety](help.topic.agent_tools_and_replay#overview)
