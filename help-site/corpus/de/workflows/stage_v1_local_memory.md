---
standard: help_workflow
id: help.workflow.stage_v1_local_memory
title: "Stufe 1 (v1-local-memory): Lokaler Sofortstart ohne Setup"
short: "Die einfachste lauffähige Version des Multiplayer Space-Chats im Arbeitsspeicher: Threads, Forking, Presence-Leases und transaktionale Antwortverarbeitung."
tags: [v1, memory, quickstart, pispaces, thread, fork, presence, completionprofile]
owner: client
related: [help.workflow.overview_v1_to_v6, help.workflow.stage_v2_local_durable]
since: 0.0.1
---

# Stufe 1 (v1-local-memory): Lokaler Sofortstart ohne Setup

## Überblick {#overview}

Stufe 1 (`help-site/examples/v1-local-memory/run.ts`) benötigt keinerlei Einrichtung, Datenbankdateien oder offene Ports. Sie öffnet einen `MemoryStorage`-Harness, legt einen benannten Space an und demonstriert das komplette Grundmodell des Multiplayer Space-Chats in unter einer Sekunde.

## Topologie: Space-Verteilung {#topology}

- **1 Prozess**, **1 Harness** auf `MemoryStorage` (flüchtig, kein Restart-Szenario).
- **1 benannter Space** (`chat-v1`): alle Entries (`Presence`, `Thread`, `Msg`, `ChatTask`) liegen in genau diesem Space.
- Clients (alice/bob) und Worker greifen in-process über dasselbe `PiSpaces`-Objekt zu — kein Socket, keine Datei, kein Netz.

## Arbeitsablauf {#workflow}

### Schritt 1: Space und CompletionProfile initialisieren {#step-1-init}

```ts
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
await harness.commit((tx) => createSpace(tx, "chat-v1", Date.now()), ctx);
const space = new PiSpaces(harness, ctx, Date.now, meter, undefined, { space: "chat-v1" });
const stopService = await startService(harness, ctx);

await space.setCompletionProfiles([
  { taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }
]);
```

### Schritt 2: Teilnehmer-Präsenz mit Space-Lease anlegen {#step-2-presence}

Wenn `alice` und `bob` den Chat betreten, schreibt jeder Client einen `Presence`-Entry mit 30 Sekunden Lease (`30_000` ms) und verlängert ihn per `space.renew(lease.id, 30_000)`.

### Schritt 3: Nachricht schreiben, transaktional beantworten und Thread forken {#step-3-chat-and-fork}

1. `alice` schreibt in einer Transaktion ihre `Msg` (`seq: 1`) und den zugehörigen `ChatTask`.
2. Der Chat-Worker nimmt `ChatTask` unter einer Transaktion (`space.take(..., { txn })`), erzeugt die Antwort-`Msg` (`seq: 2`) mit derselben `taskId` und ruft `space.commit(txn)` auf.
3. `bob` forkt den Thread ab `seq: 2` (`forkThread` kopiert die sichtbaren Nachrichten bis `seq <= 2` in einer Transaktion in den neuen Fork-Thread).

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
```

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): SQLite, RequestRef-Claims, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)
