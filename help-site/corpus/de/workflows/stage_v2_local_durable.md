---
standard: help_workflow
id: help.workflow.stage_v2_local_durable
title: "Stufe 2 (v2-local-durable): SQLite-Persistenz, Alarme & Subagent"
short: "Erweitert Stufe 1 um SQLite-Speicherung, neustartfeste RequestRef-Claims, TimerLock-Leases für geplante Alarme und den search_history-Subagenten."
tags: [v2, sqlite, durable, requestref, alarms, timerlock, subagent, search_history]
owner: client
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# Stufe 2 (v2-local-durable): SQLite-Persistenz, Alarme & Subagent

## Überblick {#overview}

Stufe 2 (`help-site/examples/v2-local-durable/run.ts`) macht den Multiplayer Space-Chat dauerhaft über Prozessneustarts hinweg und fügt genau die zwei fortgeschrittenen Funktionen aus dem Earendil-Artikel hinzu: **geplante Aufgaben (`schedule`-Alarme)** und die **konversationsübergreifende Suche per Subagent (`search_history`)** – beides rein mit `pi-spaces`-Mitteln.

## Topologie: Space-Verteilung {#topology}

- **1 Prozess**, **1 Harness** auf einer **SQLite-Datei** (`chat-v2.sqlite`).
- **1 benannter Space** (`chat-v2`): Threads, `Msg`, `ChatTask`, `ScheduledJob`, `TimerLock`, Subagent-Entries – alles persistent in einem Space.
- Für die Crash-Demo wird der Harness geschlossen und **auf derselben SQLite-Datei neu geöffnet**: der Space überlebt den simulierten Neustart, offene Leases werden gereapt.

## Arbeitsablauf {#workflow}

### Schritt 1: SQLite-Storage und RequestRef-Claims {#step-1-sqlite-claims}

Statt `MemoryStorage` öffnet der Host `await openNodeSqliteStorage(dbPath)`. Für jeden Teilnehmer wird `const { generation } = await space.issueGeneration(principal)` ausgestellt. Wird `createThread` oder `submitMessage` nach einem Verbindungsabbruch mit derselben `requestId` wiederholt, gibt `pi-spaces` exakt das erste Ergebnis zurück.

### Schritt 2: Geplante Alarme über ScheduledJob + TimerLock-Lease {#step-2-alarms}

1. Wenn ein Teilnehmer oder Agent eine Erinnerung plant (z.B. `scheduleReminder(threadId, "Backup-Fenster prüfen", 200)`), schreibt er:
   - einen `ScheduledJob`-Entry mit `status: "pending"` und `FOREVER`-Lease,
   - einen `TimerLock`-Entry `{ jobId, threadId, executeAt }` mit **`lease = delayMs`**.
2. Solange `TimerLock` im Space existiert, ist der Auftrag noch nicht fällig.
3. Sobald `delayMs` verstrichen ist – selbst wenn der Prozess zwischendurch geschlossen und auf derselben SQLite-Datei neu geöffnet wurde! –, entfernt der `pi-spaces`-Reaper den abgelaufenen `TimerLock`.
4. `tickAlarms()` nimmt den nun ungesperrten `ScheduledJob` unter einer Transaktion, schreibt ihn mit `status: "triggered"` zurück und legt gleichzeitig den fälligen Wakeup-`ChatTask` an.

### Schritt 3: Konversationsübergreifende Suche per Search-Subagent {#step-3-subagent}

1. In Thread 1 schreibt `alice`: *„Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.“*
2. In Thread 2 fragt `bob`: *„Was haben wir bezüglich des Event-Stores entschieden?“*
3. Der Haupt-Worker legt einen `SearchTask` (`{ searchId, parentThreadId, question }`) im Space ab.
4. Der **Search-Subagent-Worker** nimmt `SearchTask` unter einer Transaktion, durchsucht mit `space.readAll({ type: "Msg" })` alle Threads (ignoriert eigene Subagent-Daten), schreibt für jeden Suchbegriff einen `SubagentStep`-Entry (für die Sidebar-Ansicht) und committet das `SearchResult` unter dem zweiten `CompletionProfile`.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
```

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): Prozess-Entkopplung über SpaceService & RemoteSpace](help.workflow.stage_v3_remote_socket#overview)
