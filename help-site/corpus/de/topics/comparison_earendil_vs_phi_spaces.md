---
standard: help_topic
id: help.topic.comparison_earendil_vs_phi_spaces
title: "Konzeptvergleich: Earendil Multiplayer Chat vs. phi-spaces (v1 bis v6)"
short: "Vergleich des Cloudflare-Durable-Object-Ansatzes und von pi-durable 1.4.0 mit dem Tuple-Space-Modell von phi-spaces, samt Vor- und Nachteilen von In-Memory (v1) bis Federated Space (v5/v6)."
tags: [comparison, earendil, cloudflare, durable-objects, pi-durable, pros-cons, v1, v2, v3, v4, v5, v6, federated]
owner: core
related: [help.topic.overview, help.workflow.overview_v1_to_v6, help.topic.federation_router_and_membership]
since: 0.0.1
---

# Konzeptvergleich: Earendil Multiplayer Chat vs. phi-spaces (v1 bis v6)

## Überblick {#overview}

Earendil baut mit pi-durable eine Laufzeit für KI-Agenten und zeigt damit einen Mehrbenutzer-Chat auf Cloudflare. Dieser Artikel stellt diese Bauweise neben phi-spaces. Kurz gesagt: pi-durable führt einen Agenten aus, phi-spaces koordiniert die Zusammenarbeit mehrerer Teilnehmer. Die beiden ersetzen einander nicht, und zusammen passen sie gut.

### Technische Details {#technical-details}

Zwei Dinge sind zu trennen: die Vorlage [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) als Architektur und pi-durable als Paket. `phi-spaces` baut nicht auf pi-durable auf: Der Space hat einen eigenen Speicher und braucht weder pi-durable noch Chord oder pi-ai. Nur das optionale Paket `agent/` verbindet beide (siehe [Zwei getrennte Speicher](help.topic.agent_tools_and_replay#two-stores)). Die Architekturen unterscheiden sich so:

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
| **6. Subagent-Suche (`search_history`)** | Child-Conversation in derselben lokalen DO-SQLite-DB. | Entkoppelter Subagent-Worker über `SearchTask` / `SubagentStep` / `SearchResult`, in `v5` **clusterweit über mehrere Hosts**. |

### phi-spaces und pi-durable 1.4.0 {#pi-durable-today}

Stand 30.10.2026, verglichen mit dem veröffentlichten Release 1.4.0 (`docs/vergleich-pi-durable.en.md`):

| Bereich | `phi-spaces` | pi-durable 1.4.0 |
|---|---|---|
| **Hauptzweck** | Gemeinsame Daten und Arbeit zwischen Teilnehmern koordinieren | Persistente Agenten und ihre Ausführung betreiben |
| **Zentrale Abstraktion** | Space mit per Template auffindbaren Entries | Conversation mit Transkript, Submissions und Tasks |
| **Arbeitsverteilung** | Konkurrierende Verbraucher übernehmen Arbeit mit `take` | Scheduler führt besitzgebundene Tasks aus; kein entsprechendes `take` |
| **Modellintegration** | Nicht im Space-Kern; Anwendungen oder `agent/` | Eingebaut über pi-ai |
| **Commit-Verarbeitung** | Ein Schreib-Thread bündelt Commits; der nächste Commit darf schon auf dem vorbereiteten Zustand aufsetzen; Antworten warten aufs dauerhafte Schreiben | Eine Mutationslinie bleibt während des Storage-Aufrufs belegt |
| **Standard-Sync** | WAL mit `synchronous=FULL` | Node-SQLite: WAL mit `synchronous=NORMAL` |
| **Speicherplattformen** | Eigener Memory- und Node-SQLite-Store | Memory, SQLite, JSONL, IndexedDB und Cloudflare-Durable-Object-SQLite |
| **Netzwerkdienst** | In-Process, Unix-Socket, TCP, Adapter für pi-server | Harness-/Storage-Bibliothek; Netzwerkhosting ist eine zusätzliche Integration |

Die Tabelle vergleicht Standards, keine Leistung: Einen kontrollierten Benchmark gegen 1.4.0 gibt es nicht. Die Speicherdateien sind nicht austauschbar. Seit 1.4.0 ist „pi-durable schreibt immer das ganze Dokument“ ebenfalls falsch: Jede Dokumentdefinition legt mit `checkpointWhen` fest, wann eine vollständige Basis entsteht.

### Neuerer Earendil-Stand {#earendil-main}

Der unveröffentlichte Earendil-`main` (geprüft: Commit `50af8c1` vom 30.10.2026) ist neuer als der Release und nicht mit 1.4.0 gleichzusetzen. Er bringt Group Commit, einen `StoreStorage` auf Chord v2 und „deferred commits“: Fortschritt wird sichtbar, bevor er gespeichert ist, standardmäßig bis zu 1 s früher. „Nur phi-spaces hat Group Commit“ gilt also nicht allgemein. phi-spaces bestätigt seine Commits weiterhin erst nach dem Schreiben. Dieser Stand wurde gelesen, aber weder installiert noch ausgeführt.

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

### Vor- und Nachteile der Stufen v1 (In-Memory) bis v5/v6 (Federated Space) {#stages-pros-cons}

| Ausbaustufe | Zentrale Vorteile | Bewusste Grenzen / Nachteile |
|---|---|---|
| **`v1` In-Memory Space** (`openOwnMemoryHost()` + `PhiSpaces`) | **0 ms Setup**, volle Space-Einsicht, `SpaceLifecycle`, `WorkerSupervisor` und `DeploymentController` direkt im RAM; ideal für Tests & Prototyping. | Zustand ist flüchtig (verloren bei Prozessende); auf einen einzelnen Node.js-Prozess beschränkt; kein `RunGate` im Chat aktiv. |
| **`v2` Local Durable Space** (`openSqliteHost()` + `PhiSpaces`) | **ACID-Commits** in einer SQLite-Datei (Standard `synchronous=FULL`); Thread-Fork über einen Verweis auf den Eltern-Thread; steuer- und einsehbar über `AdminSpaces`, Live-Dashboard (`npm run dashboard`), TUI (`npm run tui`) und `npm run bootstrap`. | Ein Besitzer (nur 1 Host-Prozess auf der Datei, `.owner`-Sperre); kein Serverless-Scale-to-Zero. |
| **`v3` Remote Socket Space** (`SpaceService` + `RemoteSpace`) | **Prozess-Entkopplung**: Web-Gateway, Chat-Worker, Subagent und Inspector verbinden über Unix-Socket/TCP; ereignisgesteuerte Mailboxes (`events` + `ack`). | Zusätzlicher Serialisierungs- und Socket-I/O-Hop; Aufrufer müssen bei Verbindungsabbruch `OutcomeUnknown` via `pollOperation` auflösen. |
| **`v4` Gated Auth Space** (`startGate` Schicht A/B + 60s-Grants) | **Steuerung von außen mit Schlüsselbeweis**: Smartphone (`pi-termux-mobile`), CLI und Web-Admin koppeln sich per QR/Token (`enrollQr`) und steuern/inspizieren Spaces mit 60-s-Grants. | Höherer Einrichtungsaufwand (Key-Management, Enrollment, Boot-Register); neue Remote-Grants benötigen erreichbaren Control-Host. |
| **`v5`/`v6` Federated Space & Cluster-Admin** (`FederatedSpace` + HRW + `RunGate` in v6 + AP3-Replikationsbausteine) | **Verteilung auf mehrere Hosts**: Orchestriert mehrere Member-Hosts; `RunGate` in v6 für bestätigte Barrieren; Primary/Sync-Replikation und Promotion sind implementiert. | Phase 3 ist nicht vollständig abgenommen, daraus folgt keine Hochverfügbarkeits-Zusage. Keine member-übergreifenden Transaktionen (`RoutingConflict`); HRW-Member-Menge nach Federation-Plan v3 fest (`MigrationRequired` bei Entfernung); Test in v5 läuft in-process mit Hosts im Arbeitsspeicher. |

### Wann ist welches Modell überlegen? {#decision-guide}

- **Wähle das Cloudflare-DO-Modell**, wenn du tausende kleine, voneinander komplett isolierte Chat-Sessions in einer Serverless-Cloud mit *Scale-to-Zero* betreiben willst und keine externen Worker-Flotten oder On-Premise-Hoheit benötigst.
- **Wähle pi-durable**, wenn ein Agent Modell- und Werkzeugarbeit nach Neustarts fortsetzen soll oder du Conversation-Forks, Promptaufbau und Modellkontext brauchst. Für etwas atomar mitgespeicherten Zustand reichen pi-durable-Dokumente.
- **Wähle `phi-spaces` (`v1`–`v6`)**, wenn du **Infrastruktur-Unabhängigkeit** (Docker, Linux-VPS, lokal, Mobile), **serverseitig erzwungene Ergebnisverträge (`CompletionProfiles`)**, **entkoppelte heterogene Worker/Subagenten**, **HRW-Sharding über mehrere Hosts**, **selbstgehostete Primary/Sync-Replikation mit Fencing (AP3, nicht vollständig abgenommen)** oder eine **integrierte Betriebs- und Laufsteuerung (`RunGate` ab v6, `WorkerSupervisor`, Mobile/Web-Admin)** benötigst. Auch ein Dienst ganz ohne Agenten passt hierher.
- **Nimm beide**, wenn mehrere persistente Agenten zusammenarbeiten sollen: agentenintern pi-durable, agentenübergreifend phi-spaces.

## Siehe auch {#see-also}

- [Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW-Sharding und Membership](help.topic.federation_router_and_membership#overview)
