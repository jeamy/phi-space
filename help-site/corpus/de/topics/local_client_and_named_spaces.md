---
standard: help_topic
id: help.topic.local_client_and_named_spaces
title: "Lokaler Client PiSpaces, benannte Spaces und startService"
short: "Wie PiSpaces auf dem Default-Space oder benannten Spaces (NamedSpace) arbeitet und wie startService Reaper und Event-Delivery betreibt."
tags: [pispaces, namedspace, registry, createspace, listspaces, startservice]
owner: client
related: [help.topic.agent_tools_and_replay, help.api.pispaces_write]
since: 0.0.1
---

# Lokaler Client PiSpaces, benannte Spaces und startService

## Überblick {#overview}

Ein `@earendil-works/pi-durable`-Harness verwaltet standardmäßig den Default-Space (`pi-spaces.space`, Alias `"default"`) sowie über die `Registry` (`pi-spaces.registry`) mehrere durch Ressourcenlimits begrenzte isolierte **benannte Spaces** (`pi-spaces.named-space`).

## Begriffs- und Systemmodell {#concept-model}

### Benannte Spaces anlegen und öffnen {#named-spaces}

```ts
import { createSpace, listSpaces, PiSpaces, startService } from "pi-spaces";

// 1. Benannten Space für eine Chat-Session im Harness-Commit anlegen:
await harness.commit(async (tx) => {
  await createSpace(tx, "chat-session-alpha", Date.now());
}, ctx);

// 2. Client auf diesen benannten Space richten:
const space = new PiSpaces(harness, ctx, Date.now, meter, undefined, {
  space: "chat-session-alpha"
});

// 3. Hintergrunddienst (Reaper + lokale Zustellung) für alle Spaces starten:
const stopService = await startService(harness, ctx);
```

- Wird im `PiSpaces`-Konstruktor `conversationId` übergeben, prüft der Client strikt die Ownership (eine Conversation darf nur ihre eigenen Transaktionen committen/abbrechen und nur ihre eigenen Leases verlängern/kündigen).
- Lässt Host-Code `conversationId` weg (`undefined`), agiert der Client administrativ und darf `setCompletionProfiles` sowie `setLimits` aufrufen.

## Siehe auch {#see-also}

- [Die 8 LLM-Agent-Tools und Replay-Sicherheit](help.topic.agent_tools_and_replay#overview)
