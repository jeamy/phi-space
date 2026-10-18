---
standard: help_topic
id: help.topic.comparison_earendil_vs_phi_spaces
title: "Konzeptvergleich: Earendil Multiplayer Chat vs. phi-spaces (v1 bis v6)"
short: "Systematischer Vergleich des Cloudflare-Durable-Object-Ansatzes mit dem Tuple-Space-Modell von phi-spaces samt Vor- und Nachteilen von In-Memory (v1) bis Federated Space (v5/v6)."
tags: [comparison, earendil, cloudflare, durable-objects, pros-cons, v1, v2, v3, v4, v5, v6, federated]
owner: core
related: [help.topic.overview, help.workflow.overview_v1_to_v6, help.topic.federation_router_and_membership]
since: 0.0.1
---

# Konzeptvergleich: Earendil Multiplayer Chat vs. phi-spaces (v1 bis v6)

## Überblick {#overview}

Sowohl die Vorlage [Pi Durable on Cloudflare](help.workflow.overview_v1_to_v6#overview) als auch unser `phi-spaces`-Referenzprojekt nutzen `@earendil-works/pi-durable` als transaktionalen Speicherunterbau, verfolgen aber zwei grundlegend unterschiedliche Architekturparadigmen:

- **Earendil-Vorlage (Actor / Session-Hülle)**: Jede Session ist ein einzelnes Cloudflare Durable Object, das WebSockets, SQLite-Datenbank, den einzigen DO-Alarm und den `pi-durable`-Harness direkt in einer Objektinstanz kapselt.
- **`phi-spaces` (Entkoppelter Koordinationsraum / Tuple Space)**: Der gesamte Anwendungs- und Koordinationszustand liegt als Menge typisierter JSON-Entries (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`) in einem Space. Web-Gateway, KI-Worker, Subagenten und Administratoren sind lose gekoppelte Teilnehmer über den einheitlichen Vertrag `SpaceLike`.

## Begriffs- und Systemmodell {#concept-model}

### Gegenüberstellung der 6 Kernmechanismen {#mechanism-comparison}

| Mechanismus | Earendil Cloudflare DO | `phi-spaces` (`v1` bis `v6`) |
|---|---|---|
| **1. Session-Isolation** | 1 Durable Object Instanz pro `sessionId` (harte Silo-Grenze). | 1 benannter Space (`NamedSpace`) bzw. in `v5` HRW-Sharding nach `threadId` über mehrere Member-Spaces. |
| **2. Reconnect-Idempotenz** | Manuell programmiertes `ConversationCommandReceipts`-Dokument je Befehl. | **Eingebaute `RequestRef`-Claims (`src/claims.ts`)** mit kanonischem RFC-8785-Argument-Hash für alle Space-Mutationen. |
| **3. Geordnete Abarbeitung & Korrektheit** | `conversation.submit({ whenBusy: "followUp" })` ohne formale Ergebnisprüfung. | Exklusives `take` unter Space-Transaktion (`txn`) + serverseitig erzwungenes **`CompletionProfile`** (`ChatTask → Msg`). |
| **4. Live-Stream & Presence** | `watchEvents` + Cloudflare WebSocket-Attachments (nicht außerhalb abfragbar). | `readPage`-Snapshot + `changes(afterRev)` + Consumer-Mailboxes (`events`/`ack`) + **`Presence`-Entries mit 30-s-Space-Lease**. |
| **5. Geplante Aufgaben (Alarme)** | Nur 1 Hardware-Alarm je DO; manuelles `#refreshAlarm()` über alle Tasks nötig. | Beliebig viele parallele `ScheduledJob`- + `TimerLock`-Leases; automatischer Ablauf durch den `phi-spaces`-Reaper. |
| **6. Subagent-Suche (`search_history`)** | Child-Conversation in derselben lokalen DO-SQLite-DB. | Entkoppelter Subagent-Worker über `SearchTask` / `SubagentStep` / `SearchResult` – in `v5` **clusterweit über mehrere Hosts**! |

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

### Vor- und Nachteile der Stufen v1 (In-Memory) bis v5/v6 (Federated Space) {#stages-pros-cons}

| Ausbaustufe | Zentrale Vorteile | Bewusste Grenzen / Nachteile |
|---|---|---|
| **`v1` In-Memory Space** (`MemoryStorage` + `PhiSpaces`) | **0 ms Setup**, volle Space-Einsicht, `SpaceLifecycle`, `WorkerSupervisor` und `DeploymentController` direkt im RAM; ideal für Tests & Prototyping. | Zustand ist flüchtig (verloren bei Prozessende); auf einen einzelnen Node.js-Prozess beschränkt; kein `RunGate` im Chat aktiv. |
| **`v2` Local Durable Space** (`SQLite`/`JSONL` + `PhiSpaces`) | **Volle ACID-Dauerhaftigkeit** in einer Datei; $O(1)$ Pointer-basiertes Thread-Forking; steuer- und einsehbar über `AdminSpaces`, Live-Dashboard (`npm run dashboard`), TUI (`npm run tui`) und `npm run bootstrap`. | Single-Owner-Prinzip (nur 1 schreibender Host-Prozess auf der SQLite-Datei); kein Serverless-Scale-to-Zero. |
| **`v3` Remote Socket Space** (`SpaceService` + `RemoteSpace`) | **Prozess-Entkopplung**: Web-Gateway, Chat-Worker, Subagent und Inspector verbinden über Unix-Socket/TCP; ereignisgesteuerte Mailboxes (`events` + `ack`). | Zusätzlicher Serialisierungs- und Socket-I/O-Hop; Aufrufer müssen bei Verbindungsabbruch `OutcomeUnknown` via `pollOperation` auflösen. |
| **`v4` Gated Auth Space** (`startGate` Schicht A/B + 60s-Grants) | **Zero-Trust-Steuerung von außen**: Smartphone (`pi-termux-mobile`), CLI und Web-Admin koppeln sich per QR/Token (`enrollQr`) und steuern/inspizieren Spaces mit 60-s-Grants. | Höherer Einrichtungsaufwand (Key-Management, Enrollment, Boot-Register); neue Remote-Grants benötigen erreichbaren Control-Host. |
| **`v5`/`v6` Federated Space & Cluster-Admin** (`FederatedSpace` + HRW + `RunGate` in v6 + AP3-Replikation im Core) | **Horizontale Skalierung & Hochverfügbarkeit**: Orchestriert mehrere Member-Hosts; AP3 Primary/Sync Replikation im Core; `RunGate` in v6 für bestätigte Barrieren. | Keine member-übergreifenden Transaktionen (`RoutingConflict`); HRW-Member-Menge in v3 fest (`MigrationRequired` bei Entfernung); Test in v5 läuft in-process mit MemoryStorage. |

### Wann ist welches Modell überlegen? {#decision-guide}

- **Wähle das Cloudflare-DO-Modell**, wenn du tausende kleine, voneinander komplett isolierte Chat-Sessions in einer Serverless-Cloud mit *Scale-to-Zero* betreiben willst und keine externen Worker-Flotten oder On-Premise-Hoheit benötigst.
- **Wähle `phi-spaces` (`v1`–`v6`)**, wenn du **volle Infrastruktur-Unabhängigkeit** (Docker, Linux-VPS, lokal, Mobile), **serverseitig erzwungene Ergebnisverträge (`CompletionProfiles`)**, **entkoppelte heterogene Worker/Subagenten**, **horizontales HRW-Sharding über mehrere Hosts**, **selbstgehostete Primary/Sync-Replikation mit Fencing (AP3)** oder eine **integrierte Betriebs- und Laufsteuerung (`RunGate` ab v6, `WorkerSupervisor`, Mobile/Web-Admin)** benötigst.

## Siehe auch {#see-also}

- [Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW-Sharding und Membership](help.topic.federation_router_and_membership#overview)
