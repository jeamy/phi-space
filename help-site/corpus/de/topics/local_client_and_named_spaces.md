---
standard: help_topic
id: help.topic.local_client_and_named_spaces
title: "Lokaler Client PhiSpaces, benannte Spaces und startService"
short: "Wie PhiSpaces auf dem Default-Space oder benannten Spaces (NamedSpace) arbeitet und wie startService Reaper und Event-Delivery betreibt."
tags: [phispaces, namedspace, registry, createspace, listspaces, startservice]
owner: client
related: [help.topic.agent_tools_and_replay, help.api.phispaces_write]
since: 0.0.1
---

# Lokaler Client PhiSpaces, benannte Spaces und startService

## Überblick {#overview}

Ein Host (der eigene Speicher) verwaltet standardmäßig den Default-Space (`phi-spaces.space`, Alias `"default"`) sowie über die `Registry` (`phi-spaces.registry`) mehrere durch Ressourcenlimits begrenzte isolierte **benannte Spaces** (`phi-spaces.named-space`).

## Begriffs- und Systemmodell {#concept-model}

### Benannte Spaces anlegen und öffnen {#named-spaces}

```ts
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";

// 1. Benannten Space für eine Chat-Session im Commit des Hosts anlegen:
await host.commit(async (tx) => {
  await createSpace(tx, "chat-session-alpha", Date.now());
}, ctx);

// 2. Client auf diesen benannten Space richten:
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, {
  space: "chat-session-alpha"
});

// 3. Hintergrunddienst (Reaper + lokale Zustellung) für alle Spaces starten:
const stopService = await startService(host, ctx);
```

- Wird im `PhiSpaces`-Konstruktor `conversationId` übergeben, prüft der Client strikt die Ownership (eine Conversation darf nur ihre eigenen Transaktionen committen/abbrechen und nur ihre eigenen Leases verlängern/kündigen).
- Lässt Host-Code `conversationId` weg (`undefined`), agiert der Client administrativ und darf `setCompletionProfiles` sowie `setLimits` aufrufen.

## Siehe auch {#see-also}

- [Die 8 LLM-Agent-Tools und Replay-Sicherheit](help.topic.agent_tools_and_replay#overview)
