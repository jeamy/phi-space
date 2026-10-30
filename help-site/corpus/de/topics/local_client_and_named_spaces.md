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

Der lokale Client ist der einfachste Weg zu phi-spaces: Dein Programm öffnet einen Space direkt im eigenen Prozess, ganz ohne Netzwerk. Für getrennte Themen legst du mehrere benannte Spaces an, wie Ordner in einem Schrank. Ein kleiner Hintergrunddienst räumt Abgelaufenes auf und stellt Nachrichten zu.

### Technische Details {#technical-details}

Ein Host (der eigene Speicher) verwaltet standardmäßig den Default-Space (`phi-spaces.space`, Alias `"default"`) sowie über die `Registry` (`phi-spaces.registry`) mehrere durch Ressourcenlimits begrenzte isolierte **benannte Spaces** (`phi-spaces.named-space`).

## Begriffs- und Systemmodell {#concept-model}

### Einen Host öffnen {#open-host}

```ts
import { openOwnMemoryHost, openSqliteHost } from "phi-spaces";

const fileHost = await openSqliteHost("./spaces.db"); // SQLite, ein Prozess besitzt die Datei
const memoryHost = openOwnMemoryHost();               // nur im Arbeitsspeicher
await fileHost.close(ctx);
await memoryHost.close(ctx);
```

- Ein zweiter Prozess auf derselben Datei erhält `StoreUnavailable`. Mehrere Prozesse teilen einen Space über den [Dienst](help.topic.space_service_and_remote_space#standalone).
- Details zum Speicher stehen unter [Der eigene Speicher](help.topic.architecture_layers#own-store).

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
- Ohne `space`-Option überwacht `startService` auch später erzeugte benannte Spaces.

### Paket und Importe {#package-imports}

Projekte binden die Bibliothek mit `"phi-spaces": "file:.."` ein und importieren über den Paketnamen. Einen Build-Schritt gibt es nicht; `exports` zeigt auf die TypeScript-Quellen. Nur diese Unterpfade sind Vertrag:

| Import | Inhalt |
|---|---|
| `phi-spaces` | Öffentliche API (`PhiSpaces`, `RemoteSpace`, `serveSpace`, `SpaceService`, Fehler) |
| `phi-spaces/context` | `Context`, `BACKGROUND_CONTEXT` |
| `phi-spaces/core` | Reine Semantik: `matches`, Fehlerklassen, Typen |
| `phi-spaces/store/host` | Eigener Store im Speicher (`openOwnMemoryHost`) |
| `phi-spaces/store/sqlite` | Eigener SQLite-Store (`openSqliteHost`) |
| `phi-spaces/store/documents` | Dokument-Helfer des Stores |
| `phi-spaces/ws` | WebSocket-Gateway der Web-Prozesse (`upgradeWebSocket`) |

## Siehe auch {#see-also}

- [Die 8 LLM-Agent-Tools und Replay-Sicherheit](help.topic.agent_tools_and_replay#overview)
