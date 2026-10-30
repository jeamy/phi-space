---
standard: help_workflow
id: help.workflow.overview_v1_to_v6
title: "Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)"
short: "Wie ein Mehrbenutzer-Chat mit phi-spaces entsteht: sechs lauffähige Stufen vom Programm im Arbeitsspeicher bis zum Betrieb über Handy und Web."
tags: [multiplayer, chat, tutorial, step-by-step, v1, v2, v3, v4, v5, v6, earendil]
owner: core
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v2_local_durable, help.workflow.stage_v3_remote_socket, help.workflow.stage_v4_gated_auth, help.workflow.stage_v5_federated_cluster, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)

## Überblick {#overview}

Diese Anleitung baut einen Mehrbenutzer-Chat mit phi-spaces in sechs Stufen. Jede Stufe ist ein eigenes kleines Programm, das du direkt starten kannst. Die erste läuft ohne Einrichtung im Arbeitsspeicher, die letzte zeigt die Steuerung über Handy und Web.

Weitere Beispiele außerhalb dieser sechs Stufen stehen unter [Beispiele](help.topic.examples#overview).

## Begriffs- und Systemmodell {#concept-model}

Das Projekt setzt die Fähigkeiten des bekannten [Pi Durable on Cloudflare Multiplayer-Chats](help.topic.overview#overview) **ausschließlich mit den Mitteln von `phi-spaces`** um: ohne Cloudflare-spezifische APIs und ohne Sonder-Tabellen außerhalb des Spaces. Die Stufen nutzen den eigenen Speicher von phi-spaces (SQLite-Datei oder Arbeitsspeicher); pi-durable braucht keines der sechs Programme. Die gemeinsame Chat-Logik steht in `help-site/examples/shared/chat-core.ts` (`SpaceChatEngine`), jedes Programm in `help-site/examples/v*/run.ts`.

### Wie phi-spaces die 6 Kernanforderungen löst {#mapping-table}

| Funktion des Multiplayer-Chats | Lösung mit reinen `phi-spaces`-Mitteln |
|---|---|
| **1. Teilbare Session-Räume** | Jeder Chat-Raum ist ein isolierter **benannter Space (`NamedSpace`)** mit eigener `spaceId` und Revision `rev`. |
| **2. Mehrere Threads & Forking ohne Duplikate** | Threads sind `Thread`-Entries (`{ threadId, parentThreadId, forkUpToSeq }`). Die Chat-Engine fängt Wiederholungen selbst ab: `Thread` per `write` mit `unique: ["threadId"]`, `msgId` und `taskId` abgeleitet aus der `requestId`. Ab Stufe 3 gibt `RemoteSpace` jeder Mutation zusätzlich eine eigene Request-Identität für Transport-Wiederholungen. |
| **3. Multiplayer-Inbox & geordnete Antworten** | Jede Nachricht erzeugt in einer Transaktion `Msg` + `ChatTask`. Der Worker nimmt `ChatTask` exklusiv unter `txn` und muss laut **`CompletionProfile`** genau eine Antwort-`Msg` committen. |
| **4. Live-Streaming & Teilnehmer-Präsenz** | Snapshot über `readPage()` (`inspectSnapshot()` liest alle Seiten), Live-Deltas stehen über `changes(afterRev)` bereit; Anwesenheit über `Presence`-Entries mit **30-s-Lease** und `renew()`. |
| **5. Geplante Aufgaben (`schedule` / Alarme)** | `ScheduledJob`-Entry (`FOREVER`) + `TimerLock`-Entry mit `leaseMs = delayMs`. Nach Ablauf der Lease räumt der Reaper von `startService` den Lock ab; `tickAlarms()` legt danach idempotent den Wakeup-`ChatTask` an. |
| **6. Konversationssuche per Subagent (`search_history`)** | `SearchTask`-Entry wird von einem Subagent-Worker unter `txn` genommen; er durchsucht alle Threads per `readAll({ type: "Msg" })`, protokolliert `SubagentStep`-Entries und committet `SearchResult` unter einem zweiten `CompletionProfile`. |

### Die 6 Stufen im Überblick {#six-stages}

1. **[Stufe 1 (`v1-local-memory`)](help.workflow.stage_v1_local_memory#overview)**: Zero-Setup im Arbeitsspeicher (`openOwnMemoryHost()` + `PhiSpaces`). Sofort ausführbar ohne Dateien oder Netzwerk.
2. **[Stufe 2 (`v2-local-durable`)](help.workflow.stage_v2_local_durable#overview)**: Eigener SQLite-Speicher (`openSqliteHost`), Wiederanlauf auf derselben Datei, `TimerLock`-Alarme und `search_history`-Subagent.
3. **[Stufe 3 (`v3-remote-socket`)](help.workflow.stage_v3_remote_socket#overview)**: Trennung in Server und Remote-Worker über `SpaceService`, `RemoteSpace` (Unix-Socket/TCP) und Consumer-Mailboxes (`events` + `ack`).
4. **[Stufe 4 (`v4-gated-auth`)](help.workflow.stage_v4_gated_auth#overview)**: Zwei-Schichten-Sicherheit (`startGate`, Ed25519-Challenge, Token-Enrollment, 60-s-Grants, Schlüsselrotation und Boot-Guard).
5. **[Stufe 5 (`v5-federated-cluster`)](help.workflow.stage_v5_federated_cluster#overview)**: Föderation über 3 Member-Spaces (`RouterController` + `FederatedSpace`), HRW-Routing nach `threadId` und clusterweites `readAll`; in der Demo als 4 Hosts in einem Prozess simuliert.

6. **[Stufe 6 (`v6-mobile-control`)](help.workflow.stage_v6_mobile_control#overview)**: Betriebssteuerung über die Mobile App (`pi-termux-mobile`) und den login-geschützten Web-Bereich **`AdminSpaces`** auf `https://spaces.eibrain.org`.

Jede Stufen-Beschreibung enthält einen Abschnitt **Topologie: Space-Verteilung**, der zeigt, wie viele Hosts und Spaces beteiligt sind und wie Entries verteilt werden.

## Siehe auch {#see-also}

- [Stufe 1 (v1-local-memory): Sofortstart ohne Setup](help.workflow.stage_v1_local_memory#overview)
