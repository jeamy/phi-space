---
standard: help_workflow
id: help.workflow.stage_v1_local_memory
title: "Stufe 1 (v1-local-memory): Lokaler Sofortstart ohne Setup"
short: "Die einfachste lauffähige Version des Chats im Arbeitsspeicher: Threads, Abzweigungen, Anwesenheit und Antworten in einer Transaktion."
tags: [v1, memory, quickstart, phispaces, thread, fork, presence, completionprofile]
owner: client
related: [help.workflow.overview_v1_to_v6, help.workflow.stage_v2_local_durable]
since: 0.0.1
---

# Stufe 1 (v1-local-memory): Lokaler Sofortstart ohne Setup

## Überblick {#overview}

Stufe 1 ist der einfachste Einstieg: ein Programm ohne Datenbank, ohne Netzwerk und ohne Konfiguration. Es zeigt, wie zwei Personen einen Chat betreten, schreiben, eine Antwort bekommen und ein Gespräch abzweigen. Alles liegt im Arbeitsspeicher und ist nach dem Programmende weg.

## Topologie: Space-Verteilung {#topology}

Das Programm `help-site/examples/v1-local-memory/run.ts` öffnet einen Host im Arbeitsspeicher (`openOwnMemoryHost()`) und legt einen benannten Space an.

- **1 Prozess**, **1 Host** im Arbeitsspeicher (`openOwnMemoryHost()`; flüchtig, kein Restart-Szenario).
- **1 benannter Space** (`chat-v1`): alle Entries (`Presence`, `Thread`, `Msg`, `ChatTask`) liegen in genau diesem Space.
- Clients (alice/bob) und Worker greifen in-process über dasselbe `PhiSpaces`-Objekt zu — kein Socket, keine Datei, kein Netz.

## Arbeitsablauf {#workflow}

### Schritt 1: Space und CompletionProfile initialisieren {#step-1-init}

```ts
const host = openOwnMemoryHost();
await host.commit((tx) => createSpace(tx, "chat-v1", Date.now()), ctx);
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: "chat-v1" });
const stopService = await startService(host, ctx);

await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
```

### Schritt 2: Teilnehmer-Präsenz mit Space-Lease anlegen {#step-2-presence}

Wenn `alice` und `bob` den Chat betreten, schreibt `engine.joinOrRefreshPresence(...)` für jeden einen `Presence`-Entry mit 30 Sekunden Lease (`30_000` ms). `engine.renewPresence(participantId, ms)` verlängert ihn über `space.renew(leaseId, ms)`; das Programm verlängert `alice` auf 45 Sekunden.

### Schritt 3: Nachricht schreiben, transaktional beantworten und Thread forken {#step-3-chat-and-fork}

1. `alice` schreibt in einer Transaktion ihre `Msg` (`seq: 1`) und den zugehörigen `ChatTask`.
2. Der Chat-Worker nimmt `ChatTask` unter einer Transaktion (`space.take(..., { txn })`), erzeugt die Antwort-`Msg` (`seq: 2`) mit derselben `taskId` und ruft `space.commit(txn)` auf.
3. `bob` forkt den Thread ab `seq: 2` (`forkThread` schreibt nur Parent-Verweis und Grenze; geerbte Nachrichten bis `seq <= 2` werden beim Lesen aufgelöst, nicht physisch kopiert).

Das Programm ruft `createThread` zusätzlich zweimal mit derselben `requestId` auf: Die Wiederholung liefert denselben Thread und legt keinen zweiten an.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
```

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): SQLite, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)
