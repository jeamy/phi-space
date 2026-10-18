---
standard: help_workflow
id: help.workflow.overview_v1_to_v6
title: "Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)"
short: "Wie das Earendil Multiplayer-Chat-Szenario vollständig mit nativen phi-spaces-Mitteln umgesetzt wird – vom Zero-Setup In-Memory-Space (v1) bis zum Cluster mit Mobile- & Web-Admin (v6)."
tags: [multiplayer, chat, tutorial, step-by-step, v1, v2, v3, v4, v5, v6, earendil]
owner: core
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v2_local_durable, help.workflow.stage_v3_remote_socket, help.workflow.stage_v4_gated_auth, help.workflow.stage_v5_federated_cluster, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)

## Überblick {#overview}

Dieses Referenzprojekt setzt alle Fähigkeiten des bekannten [Pi Durable on Cloudflare Multiplayer-Chats](help.topic.overview#overview) **ausschließlich mit den Mitteln von `phi-spaces`** um – ohne Cloudflare-spezifische APIs und ohne manuelle Sonder-Tabellen außerhalb des Spaces.

Damit man sowohl in wenigen Sekunden lokal starten als auch den Weg bis zur verteilten Produktion nachvollziehen kann, ist das Beispiel in **6 aufeinander aufbauende, einzeln ausführbare Versionen (`v1` bis `v6`)** gegliedert.

## Begriffs- und Systemmodell {#concept-model}

### Wie phi-spaces die 6 Kernanforderungen löst {#mapping-table}

| Funktion des Multiplayer-Chats | Lösung mit reinen `phi-spaces`-Mitteln |
|---|---|
| **1. Teilbare Session-Räume** | Jeder Chat-Raum ist ein isolierter **benannter Space (`NamedSpace`)** mit eigener `spaceId` und Revision `rev`. |
| **2. Mehrere Threads & Forking ohne Duplikate** | Threads sind `Thread`-Entries (`{ threadId, parentThreadId, forkUpToSeq }`); Reconnect-Retries werden nativ über **Request-Claims (`RequestRef` + `issueGeneration`)** dedupliziert. |
| **3. Multiplayer-Inbox & geordnete Antworten** | Jede Nachricht erzeugt in einer Transaktion `Msg` + `ChatTask`. Der Worker nimmt `ChatTask` exklusiv unter `txn` und muss laut **`CompletionProfile`** genau eine Antwort-`Msg` committen. |
| **4. Live-Streaming & Teilnehmer-Präsenz** | Initialer Snapshot über `readPage()`, Live-Deltas über `changes(afterRev)`; Anwesenheit über `Presence`-Entries mit **30-s-Space-Lease** und `renew()`. |
| **5. Geplante Aufgaben (`schedule` / Alarme)** | `ScheduledJob`-Entry (`FOREVER`) + `TimerLock`-Entry mit `leaseMs = delayMs`. Nach Ablauf der Lease räumt der `phi-spaces`-Reaper den Lock ab und löst idempotent den Wakeup-`ChatTask` aus. |
| **6. Konversationssuche per Subagent (`search_history`)** | `SearchTask`-Entry wird von einem Subagent-Worker unter `txn` genommen; er durchsucht alle Threads per `readAll({ type: "Msg" })`, protokolliert `SubagentStep`-Entries und committet `SearchResult` unter einem zweiten `CompletionProfile`. |

### Die 6 Stufen im Überblick {#six-stages}

1. **[Stufe 1 (`v1-local-memory`)](help.workflow.stage_v1_local_memory#overview)**: Zero-Setup im Arbeitsspeicher (`MemoryStorage` + `PhiSpaces`). Sofort ausführbar ohne Dateien oder Netzwerk.
2. **[Stufe 2 (`v2-local-durable`)](help.workflow.stage_v2_local_durable#overview)**: Lokale SQLite-Persistenz, `RequestRef`-Idempotenz, `readPage`/`changes`, `TimerLock`-Alarme und `search_history`-Subagent.
3. **[Stufe 3 (`v3-remote-socket`)](help.workflow.stage_v3_remote_socket#overview)**: Trennung in Server und Remote-Worker über `SpaceService`, `RemoteSpace` (Unix-Socket/TCP) und Consumer-Mailboxes (`events` + `ack`).
4. **[Stufe 4 (`v4-gated-auth`)](help.workflow.stage_v4_gated_auth#overview)**: Zwei-Schichten-Sicherheit (`startGate`, Ed25519-Challenge, Token-Enrollment, 60-s-Grants, Schlüsselrotation und Boot-Guard).
5. **[Stufe 5 (`v5-federated-cluster`)](help.workflow.stage_v5_federated_cluster#overview)**: Föderierter Cluster (`createFederationController`) mit 3 Member-Spaces, HRW-Routing nach `threadId` und `takeWaiting`-Waiter-Wettlauf — in der Demo als 4 Harnesses in einem Prozess simuliert.

Jede Stufen-Beschreibung enthält einen Abschnitt **Topologie: Space-Verteilung**, der zeigt, wie viele Harnesses/Spaces beteiligt sind und wie Entries verteilt werden.
6. **[Stufe 6 (`v6-mobile-control`)](help.workflow.stage_v6_mobile_control#overview)**: Vollständige Betriebssteuerung & Überwachung über die Mobile App (`pi-termux-mobile`) und den login-geschützten Web-Bereich **`AdminSpaces`** auf `https://spaces.eibrain.org`.

## Siehe auch {#see-also}

- [Stufe 1 (v1-local-memory): Sofortstart ohne Setup](help.workflow.stage_v1_local_memory#overview)
