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

A `@earendil-works/pi-durable` harness hosts the default space (`phi-spaces.space`, alias `"default"`) plus resource-bounded isolated **named spaces** (`phi-spaces.named-space`) tracked in the `Registry` (`phi-spaces.registry`).

## Concept And System Model {#concept-model}

### Creating And Opening Named Spaces {#named-spaces}

```ts
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";

// 1. Create a named space for a chat session inside a harness commit:
await harness.commit(async (tx) => {
  await createSpace(tx, "chat-session-alpha", Date.now());
}, ctx);

// 2. Point a PhiSpaces client at the named space:
const space = new PhiSpaces(harness, ctx, Date.now, meter, undefined, {
  space: "chat-session-alpha"
});

// 3. Start background reaper and local event delivery across all spaces:
const stopService = await startService(harness, ctx);
```

- Passing `conversationId` to `PhiSpaces` enables strict ownership enforcement (a conversation can only commit/abort its own transactions and renew/cancel its own leases).
- Omitting `conversationId` (`undefined`) runs in host/administrative mode, unlocking `setCompletionProfiles` and `setLimits`.

## See Also {#see-also}

- [The 8 LLM Agent Tools and Replay Safety](help.topic.agent_tools_and_replay#overview)
