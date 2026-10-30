---
standard: help_workflow
id: help.workflow.stage_v2_local_durable
title: "Stufe 2 (v2-local-durable): SQLite-Persistenz, Alarme & Subagent"
short: "Erweitert Stufe 1 um Speicherung in einer SQLite-Datei, wiederholsichere Aufrufe, geplante Alarme und eine Suche über alle Threads."
tags: [v2, sqlite, durable, requestref, alarms, timerlock, subagent, search_history]
owner: client
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# Stufe 2 (v2-local-durable): SQLite-Persistenz, Alarme & Subagent

## Überblick {#overview}

Stufe 2 macht den Chat dauerhaft: Die Daten liegen in einer Datei und überstehen einen Neustart des Programms. Dazu kommen zwei Funktionen, die erst damit sinnvoll sind. Das sind geplante Erinnerungen und eine Suche, die frühere Gespräche durchsucht.

## Topologie: Space-Verteilung {#topology}

Das Programm `help-site/examples/v2-local-durable/run.ts` ergänzt die zwei Funktionen aus dem Earendil-Artikel, **geplante Aufgaben (`schedule`-Alarme)** und die **konversationsübergreifende Suche per Subagent (`search_history`)**, rein mit `phi-spaces`-Mitteln.

- **1 Prozess**, **1 Host** auf einer **SQLite-Datei** (`chat-v2.sqlite`, eigener Speicher von phi-spaces).
- **1 benannter Space** (`chat-v2`): Threads, `Msg`, `ChatTask`, `ScheduledJob`, `TimerLock`, Subagent-Entries – alles persistent in einem Space.
- Für die Crash-Demo wird der Host geschlossen und **auf derselben SQLite-Datei neu geöffnet**: der Space überlebt den simulierten Neustart, offene Leases werden gereapt.

## Arbeitsablauf {#workflow}

### Schritt 1: SQLite-Speicher und wiederholsichere Aufrufe {#step-1-sqlite-claims}

Statt des Speichers im Arbeitsspeicher öffnet das Programm `await openSqliteHost(dbPath)`, den eigenen SQLite-Speicher: WAL-Modus, ein Schreib-Thread, standardmäßig `synchronous=FULL`. Genau ein Prozess besitzt die Datei über die Sperre `<pfad>.owner`; ein zweiter erhält `StoreUnavailable`. Das ist weder ein pi-durable-Speicher noch eine JSONL-Datei.

Wiederholungen fängt die Chat-Engine selbst ab. `createThread` schreibt mit `unique: ["threadId"]` und legt die `requestId` im `Thread`-Entry ab; `submitMessage` leitet `msgId` und `taskId` aus der `requestId` ab und prüft zuerst, ob die Nachricht schon existiert. Dieselbe `requestId` liefert also das erste Ergebnis, dieselbe `requestId` mit anderen Argumenten einen Fehler. Die Request-Claims des Spaces (`RequestRef`, `issueGeneration`) nutzt die Engine nicht; sie stehen in der [Claims-API](help.api.phispaces_claims#overview).

### Schritt 2: Geplante Alarme über ScheduledJob + TimerLock-Lease {#step-2-alarms}

1. Eine Erinnerung plant `engine.scheduleReminder({ jobId, threadId, instruction, requestedBy, delayMs, requestId })`; das Programm nutzt `delayMs: 60`. Dabei entstehen:
   - einen `ScheduledJob`-Entry mit `status: "pending"` und `FOREVER`-Lease,
   - einen `TimerLock`-Entry `{ jobId, threadId, executeAt }` mit **`lease = delayMs`**.
2. Solange `TimerLock` im Space existiert, ist der Auftrag noch nicht fällig.
3. Das Programm schließt den Host und wartet 90 ms. Nach dem Neuöffnen derselben SQLite-Datei entfernt der Reaper von `startService` den abgelaufenen `TimerLock`.
4. `tickAlarms()` nimmt den fälligen `ScheduledJob` unter einer Transaktion, entfernt einen noch vorhandenen Lock, schreibt den Job mit `status: "triggered"` zurück und legt gleichzeitig den Wakeup-`ChatTask` an.

### Schritt 3: Konversationsübergreifende Suche per Search-Subagent {#step-3-subagent}

1. In Thread 1 schreibt `alice`: *„Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.“*
2. In Thread 2 fragt `bob`: *„Was haben wir bezüglich des Event-Stores entschieden?“*
3. Der Haupt-Worker legt einen `SearchTask` (`{ searchId, parentThreadId, question }`) im Space ab.
4. Der **Search-Subagent-Worker** nimmt `SearchTask` unter einer Transaktion, durchsucht mit `space.readAll({ type: "Msg" })` alle Threads (ignoriert eigene Subagent-Daten), schreibt für jeden Suchbegriff einen `SubagentStep`-Entry (für die Sidebar-Ansicht) und committet das `SearchResult` unter dem zweiten `CompletionProfile`.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
```

The program creates the file in a temporary directory and deletes it at the end. The command below, run from the repository root, starts such a store as a service of its own. `--store` takes a file or `memory`, `--listen` an address `unix:/path.sock` or `tcp:HOST:PORT`.

```bash
npm run space-server -- --store chat.sqlite --listen unix:/tmp/space.sock
```

Das Programm legt die Datei in einem temporären Verzeichnis an und löscht sie am Ende. Einen solchen Speicher startet der Befehl unten im Repository-Root als eigenen Dienst. `--store` nimmt eine Datei oder `memory`, `--listen` eine Adresse `unix:/pfad.sock` oder `tcp:HOST:PORT`.

```bash
npm run space-server -- --store chat.sqlite --listen unix:/tmp/space.sock
```

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): Prozess-Entkopplung über SpaceService & RemoteSpace](help.workflow.stage_v3_remote_socket#overview)
