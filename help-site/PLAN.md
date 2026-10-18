# Detaillierter Architektur-, Dokumentations- und Umsetzungsplan: `PI-SPACES / HELP` & Multiplayer Space-Chat

Stand: 2026-10-15
Zielverzeichnis: `/media/data/programming/pi-spaces/help-site/`
Öffentliche Ziel-Domain: `https://spaces.eibrain.org`
Mobile Integration: `pi-termux-mobile` (`/media/data/programming/pi-termux-mobile`, `spaces.html` & `steuerung.html`)
Fachliche Vorlage für das Praxisbeispiel: [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) – **vollständig neu gedacht und umgesetzt mit nativen `pi-spaces`-Mitteln (in 6 Ausbaustufen `v1` bis `v6`)**

---

## 1. Zielsetzung und Grundprinzip

Ziel dieses Vorhabens ist ein **Next.js- und React-basierter Webserver (`help-site/`)**, der zwei eng verzahnte Aufgaben erfüllt:

1. **Kanonisches High-End-Hilfesystem (`PI-SPACES / HELP`)**:
   - Beantwortet präzise, quellcode- und vertragsgebunden:
     - **Was ist `pi-spaces`?** (Idee, Tuple-Space-Paradigma, Abgrenzung, Einsatzgebiete)
     - **Wie ist `pi-spaces` aufgebaut?** (Schichtenarchitektur von `src/core.ts` über `SpaceService`/`RemoteSpace` und NetBird-Gate bis zu `FederatedSpace`, Replikation und Betriebserweiterung)
     - **Was kann `pi-spaces`?** (Atomare Commits, Leases, Transaktionen, Claims, Mailboxes, CompletionProfiles, verbindliche Garantien vs. explizite Grenzen)
     - **Wie lautet die API?** (Interaktiver API- & Tool-Finder sowie vollständige Referenz für `PiSpaces`, `RemoteSpace`, `SpaceService`, Agent-Tools, `FederationController`, `RunController` und Fehlerklassen)
     - **Wie baut man ein System mit `pi-spaces` Schritt für Schritt auf?** (Vom einzelnen Space bis zum verteilten Multiplayer-System)
2. **Vollständige Umsetzung und Dokumentation eines `pi-spaces`-Referenzprojekts: „Multiplayer Space-Chat“**:
   - Das im Blogpost *Pi Durable on Cloudflare* gezeigte Szenario (teilbare Session-URLs, mehrere Konversationen & Forking, idempotente Befehle bei Verbindungsabbruch, Multiplayer-Nachrichten mit Inbox-Reihenfolge, Live-Streaming & Teilnehmer-Präsenz, geplante Aufgaben/Alarme sowie ein Subagent zur Konversationssuche) wird **nicht** über rohe Cloudflare-Durable-Object- oder interne `pi-durable`-Session-Primitiven nachgebaut, sondern **vollständig mit den Mitteln von `pi-spaces`** (`NamedSpace`, `EntryDraft`/`Template`, `RequestRef`-Claims, `Lease`/`renew`, `Txn` + `CompletionProfile`, `readPage` + `changes`, `notify`/`wait` + Consumer-Mailboxes) realisiert.

---

## 2. Analyse der bestehenden `pi-spaces`-Dokumentation (`docs/`)

Die Auswertung aller Dokumente in `/media/data/programming/pi-spaces/docs/` ergibt folgendes Gesamtbild, das als **einzige Wahrheitsquelle (Single Source of Truth)** in den Help-Corpus einfließt:

### 2.1 Was ist `pi-spaces`?

- `pi-spaces` ist ein transaktionaler, persistenter Koordinationsraum (inspiriert von Linda / JavaSpaces), implementiert in TypeScript (ESM) als Erweiterung für `@earendil-works/pi-durable` (mit geplantem eigenständigem `SpaceHost`-Unterbau gemäß `docs/umstellung-ohne-pi-durable.md`).
- **Grundprinzip**: Teilnehmer (Clients, Worker-Schleifen, KI-Agenten, Koordinatoren) rufen sich nicht direkt gegenseitig auf, sondern koordinieren sich über typisierte JSON-Objekte (**Entries** `{ type, types?, fields }`) in logischen Räumen (**Spaces**).
- **Entkopplung in Raum und Zeit**:
  - Ein Produzent schreibt (`write`) eine Aufgabe, Nachricht oder Beobachtung mit einer Ablaufzeit (**Lease**).
  - Ein Konsument liest (`read`) oder entnimmt exklusiv (`take`) passende Entries anhand eines **Templates** (`{ type?, fields?, id? }`, wobei fehlende oder `null`-Felder als Wildcards wirken).
  - Ist noch kein passender Entry vorhanden, wartet der Aufrufer entweder blockierend (`read`/`take` mit `timeout`) oder registriert einen dauerhaften, nichtblockierenden Auftrag (`wait` / `notify`), der auch Prozessneustarts überlebt.

### 2.2 Wie ist `pi-spaces` aufgebaut? (Die 6 Architekturschichten)

| Schicht | Quellmodule | Aufgaben und Mechanismen |
|---|---|---|
| **1. Reiner Kern & Dokumentmodell** | `src/core.ts`, `src/doc.ts`, `src/spaces.ts`, `src/canonical.ts` | Deterministische Zustandsmaschine mit explizitem `now`. Dokumentversion 5: Default-Space (`pi-spaces.space`), benannte Spaces (`pi-spaces.named-space`) und Registry (`pi-spaces.registry`, Alias $\rightarrow$ unveränderliche `spaceId`). Jeder Entry besitzt eine globale ID `gid = <spaceId>/<localId>` (`localId` = Inkarnation + monotoner Zähler). |
| **2. Claims, Streams, Seiten & Mailboxes** | `src/claims.ts`, `src/stream.ts`, `src/snapshot.ts`, `src/paging.ts`, `src/mailbox.ts` | **Ein Commit, eine Wahrheit:** Space-Mutation, Request-Claim (`{ principal, generation, requestId }` + RFC-8785 Argument-Hash), Revisionsnummer (`rev`), Mailbox-Event und Byte-Budget-Reservierung erfolgen im selben atomaren Commit. `readPage` liefert konsistente, bytebegrenzte Snapshot-Seiten (`token`, `rev`, `streamId`); `changes(afterRev)` liefert Commit-Batches; Mailboxes (`events`/`ack`) sichern Event-Zustellung mit Präfix-ACK und `mailboxEpoch` ab. |
| **3. Lokaler Client, Agent-Tools & Service** | `src/client.ts`, `src/index.ts`, `src/service.ts`, `src/remote.ts`, `src/socket.ts`, `src/pi-server.ts`, `src/meter.ts` | `PiSpaces` (lokale API) und `RemoteSpace` (Netzwerk-Client) implementieren denselben Basisvertrag `SpaceLike`. `src/index.ts` stellt 8 replay-sichere LLM-Tools (`space_write`, `space_read`, `space_take`, `space_list`, `space_txn`, `space_wait`, `space_notify`, `space_lease`) sowie Reaper & Event-Delivery (`startService`) bereit. `SpaceService` bedient Requests über In-Process-, Unix-Socket- (`0600`), TCP- oder `pi-serverd`-Transport. |
| **4. Overlay-Gate, Auth, Grants & Recovery (Phase 1b)** | `src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/rotation.ts`, `src/supervisor.ts`, `src/runtime.ts`, `src/boot.ts`, `src/restore.ts`, `src/recovery-*.ts` | **Schicht A:** NetBird-WireGuard-Peer-Identität und Gruppen (`space-hosts`, `space-admin`, `space-observer`). **Schicht B:** Verbindungsgebundene Ed25519/P-256-Challenge (30 s). Token-/QR-Enrollment im Control Space, 60-s-Kurzzeit-Grants (`effect` vs. `resolution`), Schlüsselrotation, externes CAS-Boot-Register und journalisierter Control-/Data-Restore (`restoredUnverified` Quarantäne bis `releaseRestored`). |
| **5. Federation, Router & Membership (Phase 2)** | `src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts`, `src/capability-directory.ts`, `src/data-admin.ts` | `RouterController` mit Command-Zustandsmaschine (`accepted` $\rightarrow$ `applying` $\rightarrow$ `completed`/`failed`/`needsReview`) und 1–1024 Journal-Partitionen. Signierte `RouterLease` & Original-Principal-Delegation. `FederationPolicy` (`local`, `expand` nach Typ, HRW über Feldwert, Capacity/Capability). `FederatedSpace` inkl. journalisiertem Waiter-Wettlauf bei `takeWaiting`. Membership (`addMember`, `drain`, `freezeForRemoval`, `EmptyProof`, `removeMember`) und `DistributedPrincipalErasure`. |
| **6. Betriebserweiterung (Phase 2b) & Replikation (Phase 3)** | `src/run-controller.ts`, `src/run-member.ts`, `src/workers.ts`, `src/space-lifecycle.ts`, `src/deployment.ts`, `src/dashboard.ts`, `src/entry-replication.ts`, `src/primary-sync.ts`, `src/replica-control.ts` | `RunGate` im Core (Tasks nur bei `running` nehmbar), `RunController`, signierte `WorkerAssignments` + `WorkerSupervisor`, deklaratives Deployment (`npm run bootstrap`), lesendes HTTP+SSE-Dashboard (`src/dashboard.ts`) und TUI (`test/tui/`). Phase-3-Bausteine: HLC/LWW/Add-Wins-Replikation, gepagter Snapshot-/Stream-Transfer, Primary-Sync-Unterbau und Netcup-mTLS-Fencing. |

### 2.3 Was kann `pi-spaces`? (Verbindliche Garantien vs. Grenzen)

Gemäß `docs/implementierungsstand.md` und `docs/federation-plan-v3.md` muss das Hilfesystem strikt zwischen **nachgewiesenen Garantien** und **bewussten Grenzen** unterscheiden:

- **Garantien**:
  - **Atomarer Commit**: Space-Mutation, Claim-Ergebnis, Revision und Mailbox-Event werden unteilbar geschrieben.
  - **Idempotente Retries über Neustarts**: Gleiches `{ principal, generation, requestId }` mit identischem Argument-Hash liefert innerhalb der Aufbewahrungsfrist exakt dasselbe Ergebnis ohne zweite Mutation; abweichende Argumente werfen `RequestConflict`.
  - **Exklusive Arbeitsvergabe (`take` unter `txn`)**: Höchstens eine aktive Reservierung je Entry; bei `abort` oder Ablauf der Transaktions-Lease kehrt der Entry automatisch in den Space zurück.
  - **Serverseitige Ergebnisprüfung (`CompletionProfile`)**: Ein Take-Transaktions-Commit wird mit `CompletionViolation` abgewiesen, wenn die geforderten Ergebnis-Entries (Typ, korrelierende Felder, Mindest-/Höchstanzahl) nicht in derselben Transaktion geschrieben wurden.
  - **Feste Ressourcen- und Byte-Budgets (`DEFAULT_LIMITS`)**: 64 KiB pro Entry, 192 KiB Commit-Batch, 256 KiB Frame, 128 MiB Gesamtdokument, 64 MiB Entries, 32 MiB Claims, 8 MiB Outbox/Mailbox; Reservierung für Commit *und* Abort vor jeder Transaktionserweiterung.
- **Explizite Grenzen**:
  - Keine globale FIFO-Garantie über Einträge hinweg.
  - Kein allgemeines Exactly-once für externe Seiteneffekte (HTTP-Aufrufe, E-Mails, Modellkosten) ohne eigene Idempotenz-ID am Zielsystem.
  - `OutcomeUnknown` bei Client-Timeout bedeutet *nicht*, dass die Operation fehlgeschlagen ist – der Client muss mit derselben `requestId` über `pollOperation` nachfragen.
  - Phase 1, 1b, 2 und 2b sind umgesetzt; Phase 3 (Replikation / Promotion) ist in Bausteinen vorhanden, aber noch nicht für den Produktivbetrieb freigegeben.

---

## 3. Design- und UX-Architektur von `PI-SPACES / HELP`

Die gestalterische und strukturelle Architektur definiert den Standard für `PI-SPACES / HELP`:

### 3.1 Visuelles System, Typografie und 14 Farbpaletten

- **Typografie**:
  - Fließtext & Überschriften: `--font-geist-sans` (Geist Sans / System-UI-Fallback), markante Display-Headlines mit engem Tracking (`letter-spacing: -0.06em` bis `-0.07em`, `text-wrap: balance`).
  - Technische Bezeichner, IDs, Badges, Nummern, Eyebrows und Code: `--font-geist-mono` (Geist Mono / Monospace), `font-variant-numeric: tabular-nums`.
- **Theme-Engine (`Dark` / `Light` + 14 Paletten)**:
  - Persistenz in `localStorage` (`pi-spaces-help-locale`, `pi-spaces-help-mode`, `pi-spaces-help-palette`).
  - Dynamische CSS-Custom-Properties auf `:root[data-mode="dark|light"][data-palette="..."]`:
    - Alle 14 Paletten: `spaces_default` (mit `#AED83C` / `#152B35` / `#5C8EA0`), `ocean_pulse`, `amber_signal`, `raspberry_velvet`, `duo_neon`, `infrared_blueprint`, `jade_clay`, `violet_cream`, `pearl_graphite`, `cobalt_saffron`, `classic_amber`, `jade_mono`, `cyan_mono`, `violet_mono`.
    - Automatische WCAG-Kontrastberechnung (`#101010` vs. `#FFFFFF`) für `--accent-ink` auf Primär-Buttons und aktiven Badges.

### 3.2 App-Shell und 3-Spalten-Workspace

```text
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ PI-SPACES / HELP    [ 🔍 Systeme, Methoden, Entry-Typen, Fehler … (Ctrl K) ] [DE|EN] [🌙|☀️] [🎨] │
├─────────────────────┬────────────────────────────────────────────────────┬───────────────┤
│ SIDEBAR (280px)     │ HAUPTBEREICH (.content-scroll, max 1120px)         │ TOC (250px)   │
│                     │                                                    │               │
│ • Help-Übersicht    │ - HomeView (Hero + 2-Lane Flow + 9 System-Karten)  │ AUF DIESER    │
│ • Alle Inhalte      │ - AreaView (Systembereich + Artikelkarten)         │ SEITE         │
│ • API & Tool Finder │ - ApiFinderView (Facettensuche über API & Tools)   │ • Überblick   │
│ • Live Space-Chat   │ - ArticleView (Markdown + Ressourcen + Provenienz) │ • Begriffsmod.│
│ ─────────────────── │ - SearchView (Token-/Alias-Volltextsuche)          │ • Ablauf      │
│ 01 System Map       │ - SpaceChatWorkbench (Interaktives Live-Beispiel)  │ • Grenzen     │
│ 02 Core & Txns      │                                                    │ ───────────── │
│ 03 Claims & Streams │                                                    │ Help ≠ State  │
│ 04 Client & Tools   │                                                    │ Stabile       │
│ 05 Service & Remote │                                                    │ Verträge hier.│
│ 06 Gate & Recovery  │                                                    │ Live-Daten im │
│ 07 Federation & HRW │                                                    │ Inspector.    │
│ 08 Betrieb & Replik.│                                                    │               │
│ 09 Schritt-für-Schr.│                                                    │               │
│ ─────────────────── │                                                    │               │
│ ● Offline-Snapshot  │                                                    │               │
└─────────────────────┴────────────────────────────────────────────────────┴───────────────┘
```

### 3.3 Die 9 kanonischen Systembereiche (`corpus/help_product_catalog.yaml`)

Das gesamte Wissen über `pi-spaces` wird in **9 kanonische Systembereiche** gegliedert:

1. **`01` – Spaces System Map (`spaces_system_map`)**
   - *Was ist `pi-spaces`?* Technische Produktkarte für Tuple-Spaces, Entries, Templates, Leases, Transaktionen, Schichtenmodell und die Grenze zwischen lokalem `PiSpaces`, `RemoteSpace` und `FederatedSpace`.
   - Artikel: `help.topic.overview`, `help.topic.architecture_layers`, `help.topic.guarantees_and_boundaries`, `help.topic.data_and_consistency_model`.
2. **`02` – Core, Entries & Transaktionen (`core_entries_transactions`)**
   - Reine Zustandsmaschine (`src/core.ts`), Dokumentversion 5 (`pi-spaces.space`, `pi-spaces.named-space`, `pi-spaces.registry`), globale IDs (`gid`), Subtypen, Wildcard-Matching, Leases, Transaktionen und `CompletionProfile`.
   - Artikel: `help.topic.entries_and_templates`, `help.topic.leases_and_transactions`, `help.topic.completion_profiles`, `help.topic.limits_and_quotas`.
3. **`03` – Durable Claims, Streams & Mailboxes (`claims_streams_mailboxes`)**
   - Request-Claims (`{ principal, generation, requestId }`), kanonischer JSON-Hash (RFC 8785), `readPage`-Snapshots (`token`, `rev`, `streamId`), `changes(afterRev)`-Revisionsströme und langlebige Consumer-Mailboxes (`events`, Präfix-`ack`, `mailboxEpoch`).
   - Artikel: `help.topic.request_claims_and_generations`, `help.topic.snapshots_and_change_streams`, `help.topic.durable_mailboxes_and_ack`.
4. **`04` – Lokaler Client & Agent-Tools (`client_and_agent_tools`)**
   - `PiSpaces`-Client, benannte Spaces (`createSpace`, `listSpaces`), Reaper & Event-Delivery (`startService`) sowie die 8 replay-sicheren LLM-Agent-Tools (`space_write`, `space_read`, `space_take`, `space_list`, `space_txn`, `space_wait`, `space_notify`, `space_lease`).
   - Artikel: `help.topic.local_client_pispaces`, `help.topic.agent_tools_and_replay`, `help.topic.reaper_and_event_delivery`.
5. **`05` – SpaceService, RemoteSpace & Transporte (`service_remote_transport`)**
   - Transportunabhängiger `SpaceService`, `IdentityAdapter` & Rollen-`Policy`, `RemoteSpace` mit automatischem Retry, Unix-Socket (`0600`), TCP, `pi-serverd`-Integration und Umgang mit `OutcomeUnknown`.
   - Artikel: `help.topic.space_service_and_policy`, `help.topic.remote_space_and_transports`, `help.topic.error_handling_and_outcome_unknown`.
6. **`06` – Overlay-Gate, Authentisierung & Recovery (`gate_auth_recovery`)**
   - NetBird-Overlay (Schicht A), verbindungsgebundene Ed25519/P-256-Challenge (Schicht B), Token-/QR-Enrollment, 60-Sekunden-Grants (`effect` vs. `resolution`), Schlüsselrotation, CAS-Boot-Register und journalisierter Control-/Data-Restore (`restoredUnverified`).
   - Artikel: `help.topic.gate_and_two_layer_auth`, `help.topic.enrollment_grants_and_rotation`, `help.topic.boot_guard_and_restore`.
7. **`07` – Federation, Router & Membership (`federation_router_membership`)**
   - `RouterController` & Journal-Partitionen, signierte `RouterLease` & Original-Principal-Delegation, `FederationPolicy` (`local`, `expand` nach Typ/HRW/Capacity/Capability), `FederatedSpace` (inkl. Waiter-Wettlauf), Membership-Lifecycle und `DistributedPrincipalErasure`.
   - Artikel: `help.topic.router_and_journals`, `help.topic.delegation_and_routing_policy`, `help.topic.federated_space_and_waiter_race`, `help.topic.membership_and_principal_erasure`.
8. **`08` – Betrieb, Läufe, Worker & Replikation (`operations_runs_replication`)**
   - `RunGate` & `RunController`, signierte `WorkerAssignments` & `WorkerSupervisor`, deklaratives Bootstrap (`npm run bootstrap`), Dashboard & TUI, Phase-3-Replikation (HLC/LWW/Add-Wins/Primary-Sync) und Ausblick auf den eigenständigen Host ohne `pi-durable`.
   - Artikel: `help.topic.runs_and_workers`, `help.topic.bootstrap_dashboard_and_tui`, `help.topic.replication_phase3`, `help.topic.standalone_runtime_outlook`.
9. **`09` – Schritt-für-Schritt-Aufbau & Multiplayer Space-Chat (`step_by_step_and_multiplayer_chat`)**
   - Kompletter Konstruktionsleitfaden vom ersten Space bis zur vollständigen Multiplayer-Chat-Anwendung mit ausschließlich `pi-spaces`-Mitteln sowie dem interaktiven API- & Tool-Finder.
   - Artikel: `help.workflow.build_system_step_by_step`, `help.workflow.multiplayer_space_chat`, `help.workflow.multiplayer_threads_and_forks`, `help.workflow.multiplayer_alarms_and_subagent`.

### 3.4 Kanonische Artikelstruktur und Stilregeln

Jeder Themenartikel in `corpus/{de,en}/topics/<topic>.md` folgt der standardisierten Struktur mit expliziten, sprachunabhängigen `{#anchor}`-IDs:

```markdown
---
standard: help_topic
id: help.topic.<topic>
title: "<Lokalisierter Titel>"
short: "<Präzise Kurzbeschreibung, max. 240 Zeichen>"
tags: [<sprachunabhängige Suchbegriffe>]
owner: <core|client|tools|remote|security|federation|ops|workflow>
related: [help.topic.*, help.api.*, help.workflow.*]
since: 0.0.1
---

# <Lokalisierter Titel>

## Überblick {#overview}
## Begriffs- und Systemmodell {#concept-model}
## Begriffe und Identitäten {#terms-and-identities}
## Arbeitsablauf {#workflow}
## Regeln, Garantien und Grenzen {#rules-and-boundaries}
## Beispiele {#examples}
## Fehler und Diagnose {#failures-and-diagnostics}
## Technische Referenz {#technical-reference}
## Provenienz und Nachweise {#provenance-and-evidence}
## Siehe auch {#see-also}
```

### 3.5 Interaktiver API- & Tool-Finder

Unter dem Bereich `API & Tools` bietet das Hilfesystem einen facettierten technischen Finder über alle öffentlichen Exporte aus `src/index.ts` und `docs/api.md`:

- **Modus-Tabs**: `API & Agent-Tools` (alle Methoden, Klassen und Tools) vs. `Architektur-Module` (die Paketschichten `core`, `client`, `service`, `remote`, `gate/auth`, `federation`, `ops`).
- **Schicht-Filter-Chips**: `ALLE`, `_CORE`, `_CLIENT`, `_TOOLS`, `_REMOTE`, `_SECURITY`, `_FEDERATION`, `_OPS`.
- **5 technische Facetten-Dropdowns**:
  1. `Kategorie`: `Mutation`, `Query / Snapshot`, `Wait / Stream / Mailbox`, `Transaction / Lease`, `Security / Grant`, `Federation / Routing`, `Operations / Run`.
  2. `Ausführung`: `Blocking (Timeout)`, `Non-Blocking / Event`, `Synchronous / Pure`, `Journaled / Multi-Step`.
  3. `Idempotenz`: `RequestRef Claim`, `Task Claim (replay: safe)`, `Read-Only Snapshot`, `CAS / Epoch-Bound`.
  4. `Scope`: `Single Space`, `Named Spaces / Host`, `Remote (Socket/TCP)`, `Federated (Multi-Member)`.
  5. `Rolle`: `User / Conversation`, `Worker / Consumer`, `Host / Supervisor Admin`, `Router`.

---

## 4. Das 6-Stufen-Evolutionsmodell („Vom Einfachen zum Komplexesten inkl. Mobile Control“: `v1` bis `v6`)

Damit Einsteiger sofort ohne Hürden lokal starten können und Fortgeschrittene denselben Anwendungsfall Schritt für Schritt bis zur voll ausgebauten, kryptografisch gesicherten Multi-Member-Federation **inklusive Steuerung und Überwachung über die mobile App (`pi-termux-mobile`)** ausbauen können, wird das Multiplayer-Space-Chat-Beispiel in **6 aufeinander aufbauenden, einzeln ausführbaren Versionen (`v1` bis `v6`)** umgesetzt und dokumentiert.

Weil `PiSpaces` und `RemoteSpace` denselben Basisvertrag `SpaceLike` erfüllen und `FederatedSpace` die verteilte Entsprechung bereitstellt, bleibt das **fachliche Chat-Datenmodell (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`) über alle 6 Versionen identisch** – es ändert sich von Stufe zu Stufe nur die darunterliegende `pi-spaces`-Infrastruktur und Betriebsschicht!

### Übersicht der 6 Ausbaustufen

| Version | Verzeichnis / Modus | Infrastruktur & Storage | Neu hinzukommende `pi-spaces`-Mittel | Ziel & Einsatzzweck |
|---|---|---|---|---|
| **`v1`** | `examples/v1-local-memory/` | 1 Prozess, `MemoryStorage`, kein Setup | `PiSpaces`, `NamedSpace`, `write`/`read`/`take`, `Lease` (`renew`), `Txn` (`createTransaction`/`commit`/`abort`), `CompletionProfile`, `startService` | **Sofortstart für Demo & schnelle Tests**: Läuft überall in < 1 Sekunde ohne Dateien, Ports oder Keys. Zeigt Threads, Forking, Multiplayer-Presence und transaktionale Worker. |
| **`v2`** | `examples/v2-local-durable/` | 1 Prozess, persistenter Store (`SQLite` oder `JSONL`) | `issueGeneration` + `RequestRef`-Claims (Reconnect-Idempotenz), `readPage`-Snapshots (`rev`), `changes(afterRev)`-Stream, `TimerLock`-Leases für `schedule`-Alarme, `SearchTask`/`SubagentStep`/`SearchResult` | **Lokale Dauerhaftigkeit & Crash-Recovery**: Überlebt `SIGKILL` und Server-Neustarts ohne Datenverlust oder doppelte Ausführung; führt Alarme und den `search_history`-Subagenten ein. |
| **`v3`** | `examples/v3-remote-socket/` | Getrennte Client-/Worker-Verbindungen über Unix-Socket (`0600`) oder TCP (`127.0.0.1`) | `SpaceService`, `serveSpace`, `RemoteSpace`, `socketTransport`, `StaticIdentity`/`GateIdentity`, Rollen-`Policy`, Consumer-Mailboxes (`events` + Präfix-`ack`), `pollOperation` bei `OutcomeUnknown` | **Echte Netzwerk-Entkopplung (`RemoteSpace`)**: Web-Gateway, Chat-Worker und Search-Subagent greifen nicht mehr direkt auf den Harness zu, sondern kommunizieren als Remote-Clients über Socket/TCP und Mailboxes. |
| **`v4`** | `examples/v4-gated-auth/` | Mehrere Prozesse/Hosts hinter `startGate` + `CONTROL_SPACE` + `SqliteRecoveryRegister` | **Schicht A** (`PeerDirectory`/NetBird-Rollen), **Schicht B** (`ProvingService` Ed25519/P-256 Challenge), Token-Enrollment (`createEnroll`/`bootstrapEnroll`), 60-s-Grants (`GrantAuthority`/`GrantVerifier`), `rotateKey`, `installBootGuard` | **Zero-Trust & Mehr-Host-Sicherheit**: Jeder Remote-Worker beweist seinen privaten Schlüssel beim Verbindungsaufbau, holt vor Mutationen kurzlebige 60-s-Grants und prüft Boot-Berechtigungen. |
| **`v5`** | `examples/v5-federated-cluster/` | Koordinator (`Control` + `Router`) + 3 Data-Member-Spaces | `createFederationController`, `RouterController` (Journal-Partitionen), signierte `RouterLease` & Original-Principal-Delegation, `FederationPolicy` (`expand` + HRW nach `threadId`), `FederatedSpace` (`takeWaiting` Wettlauf), `MembershipController` & Phase-3-LWW-Presence | **Föderierte Skalierung (Cluster)**: Horizontale Verteilung der Chat-Threads per HRW über mehrere Member-Spaces, föderierte Subagent-Suche und journalisierter Waiter-Wettlauf für Worker. |
| **`v6`** | `examples/v6-mobile-control/` | Cluster + `pi-termux-mobile` (`spaces.html` & `steuerung.html`) + Web-Gateway (`spaces.eibrain.org`) | `MobileSpaces`-Brücke, Android-Keystore-Pairing via QR (`enrollQr`), Admin-Commands (`startRun`/`pauseRun`/`resumeRun`/`stopRun`/`scheduleRun`, `setWorkers`/`listWorkers`, `createSpace`/`archiveSpace`, `listAlerts`, `auditLog`), `WorkerSupervisor` & `RunController` | **Mobile Steuerung & Überwachung (Production Ops)**: Komplette Überwachung und Administration des Multiplayer-Space-Chat-Clusters vom Smartphone (`pi-termux-mobile`) und über `https://spaces.eibrain.org`. |

---

### Detaillierte Schritt-für-Schritt-Anleitung von `v1` bis `v5` im Hilfesystem

Für jede der 5 Stufen enthält das Hilfesystem ein vollständiges, eigenständiges Kapitel mit Architekturdiagramm, komplettem Code, Startbefehl und interaktiver Live-Ansicht:

#### Stufe 1 (`v1-local-memory`): Der einfachste lokale Space-Chat (Zero-Setup)

1. **Harness & benannten Space im Speicher öffnen**:
   - `const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx)`
   - `await harness.commit(tx => createSpace(tx, "chat-v1", Date.now()), ctx)`
   - `const space = new PiSpaces(harness, ctx, Date.now, meter, undefined, { space: "chat-v1" })`
   - `const stopService = await startService(harness, ctx)`
2. **`CompletionProfile` registrieren**:
   - `await space.setCompletionProfiles([{ taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }])`
3. **Multiplayer-Teilnehmer & Presence über Leases**:
   - `const presenceLease = await space.write({ type: "Presence", fields: { participantId: "alice", username: "Alice", activeThreadId: "main", status: "online" } }, null, 30_000)`
   - Heartbeat alle 10 Sekunden: `await space.renew(presenceLease.id, 30_000)`
4. **Nachricht senden & transaktional beantworten**:
   - User schreibt `Msg` + `ChatTask`.
   - Worker startet `const txn = await space.createTransaction(30_000)`, entnimmt `const task = await space.take({ type: "ChatTask" }, 5_000, { txn: txn.id })`, schreibt die Antwort-`Msg` unter `txn.id` und ruft `await space.commit(txn.id)` auf.
5. **Ausführung**:
   - `node --experimental-strip-types help-site/examples/v1-local-memory/run.ts` (läuft sofort ohne Argumente durch und zeigt den kompletten Ablauf im Terminal oder im Browser).

#### Stufe 2 (`v2-local-durable`): Persistenz (SQLite), Idempotenz (`RequestRef`), Alarme & Subagent

1. **Wechsel von `MemoryStorage` auf `openNodeSqliteStorage`**:
   - Austausch einer einzigen Zeile beim Öffnen des Harness: Alle Entries, Leases, Transaktionen und Claims überleben nun Prozess-Neustarts.
2. **Reconnect-Sicherheit mit `issueGeneration` & `RequestRef`**:
   - Vor dem ersten Befehl öffnet die Session für jeden Teilnehmer eine Generation: `const { generation } = await space.issueGeneration(principal)`.
   - Beim Erstellen eines Threads (`thread.create`), beim Forken (`thread.fork`) und beim Senden einer Nachricht (`message.submit`) wird `{ request: { principal, generation, requestId } }` mitgegeben.
   - Wird dieselbe Nachricht nach einem WebSocket-Abbruch erneut gesendet, liefert `space.write` dank `src/claims.ts` das gespeicherte Ergebnis zurück – es entsteht kein doppelter Thread und keine doppelte Nachricht.
3. **Live-UI-Synchronisation über `readPage` und `changes(afterRev)`**:
   - Beim Verbinden liest der Server `const snapshot = await space.readPage(null)` und merkt sich `snapshot.rev`.
   - Bei jeder Änderung ruft er `const delta = await space.changes(lastRev)` auf und streamt die neuen Commit-Batches über WebSocket an die verbundenen Browser.
4. **Geplante Aufgaben (`schedule`) mit `ScheduledJob` und `TimerLock`-Lease**:
   - Das `schedule`-Tool schreibt `ScheduledJob` (`FOREVER`) und `TimerLock` (`lease = delayMs`).
   - Sobald `TimerLock` abläuft (durch `startService` / Reaper entfernt), erkennt der `SpaceAlarmScheduler`, dass ein `ScheduledJob` mit `status: "pending"` ohne aktiven `TimerLock` vorliegt, und erzeugt in einer Space-Transaktion genau einmal den Wakeup-`ChatTask`.
5. **Konversationsübergreifende Suche (`search_history`) mit Subagent-Worker**:
   - Zweites `CompletionProfile`: `SearchTask` $\rightarrow$ `SearchResult`.
   - Der Subagent-Worker nimmt `SearchTask` unter einer Transaktion, durchsucht mit `readAll({ type: "Msg" })` alle Threads, schreibt `SubagentStep`-Entries für die Sidebar-Transparenz und committet `SearchResult`.

#### Stufe 3 (`v3-remote-socket`): Entkoppelte Prozesse mit `SpaceService` und `RemoteSpace`

1. **Space-Host als eigener Server-Endpunkt (`serveSpace`)**:
   - Der Host startet `const service = new SpaceService({ host: harness, ctx, identity: new StaticIdentity(...), policy: CHAT_POLICY })` und horcht über `serveSpace(service, { listen: { path: "/tmp/pi-spaces-chat.sock" }, connection })` (oder TCP Port).
2. **Web-Gateway, Chat-Worker und Search-Subagent als `RemoteSpace`-Clients**:
   - Jeder Dienst verbindet sich über `new RemoteSpace(socketTransport({ path: "/tmp/pi-spaces-chat.sock" }), { principal })`.
   - Der Anwendungscode für `write`, `take`, `readAll`, `createTransaction`, `commit` und `renew` bleibt **unverändert**, da `RemoteSpace` ebenfalls `SpaceLike` implementiert!
3. **Ereignisgesteuerte Worker über Consumer-Mailboxes (`wait`, `events`, `ack`)**:
   - Statt Polling registriert der Remote-Worker `await remoteSpace.wait({ type: "ChatTask" }, { take: true, target: "self", timeout: FOREVER, txnLeaseMs: 60_000 })`.
   - Er liest seine Mailbox über `const page = await remoteSpace.events("self", { after: cursor, waitMs: 5_000 })`, verarbeitet den bereits unter einer frischen Transaktion reservierten `ChatTask`, committet die Antwort-`Msg` und bestätigt den Empfang mit `await remoteSpace.ack("self", page.mailboxEpoch, page.next)`.
4. **Umgang mit `OutcomeUnknown`**:
   - Fällt die Socket-Verbindung während eines Commits aus, fängt der Worker `OutcomeUnknown` ab und fragt mit `await remoteSpace.pollOperation(request)` den tatsächlichen Ausgang ab.

#### Stufe 4 (`v4-gated-auth`): Zwei-Schichten-Sicherheit (Gate, Schlüssel-Challenge & 60s-Grants)

1. **Aufbau von Control-Space und Data-Space mit `startFederationHost` / `startGate`**:
   - Schicht A prüft die Peer-Identität und Gruppen (`space-hosts`, `space-admin`, `space-user`) über das `PeerDirectory` (`NetbirdDirectory` bzw. lokales Multi-Peer-Verzeichnis für die Demo).
   - Schicht B verlangt beim Verbindungsaufbau eine kryptografische Signatur (`Ed25519` / `P-256`) über die Verbindungs-Challenge (`{ gateHostId, observedPeerId, connNonce }`).
2. **Token-Enrollment neuer Chat-Worker oder Administratoren**:
   - Der Supervisor erzeugt per `createEnroll` ein Einmal-Token; der neue Worker schreibt sich über `bootstrapEnroll` / `enroll` im `CONTROL_SPACE` ein.
3. **Kurzlebige 60-Sekunden-Grants (`grantProvider`)**:
   - Vor jedem `RemoteSpace`-Aufruf holt der Client über `requestGrant("effect")` einen vom Control-Host signierten Grant (gültig max. 60 s), den der Data-Space über `GrantVerifier.check(...)` vor dem Commit verifiziert.
4. **Schlüsselrotation im laufenden Betrieb (`rotateKey`)**:
   - Live-Demonstration, wie ein Chat-Worker seinen Schlüssel ohne Unterbrechung und ohne Verlust seiner Rollen rotiert.

#### Stufe 5 (`v5-federated-cluster`): Horizontale Skalierung mit `FederatedSpace`, HRW-Routing & `RunGate`

1. **Cluster aus Koordinator (`Control` + `Router`) und 3 Member-Spaces (`member-1`, `member-2`, `member-3`)**:
   - Initialisierung über `createFederationController` mit `journalPartitions: 4` und `renewableRouterLease`.
2. **Deklarative `FederationPolicy` für den Multiplayer-Chat**:
   - `Thread`, `Msg` und `ChatTask` werden per **`expand` mit HRW (Highest Random Weight) über das Schlüsselfeld `threadId`** geroutet: Alle Nachrichten und Aufgaben desselben Threads landen deterministisch auf demselben Member-Space, sodass lokale Transaktionen und `CompletionProfiles` pro Thread ohne Cross-Node-Locking greifen!
   - `SearchTask` und `SearchResult` nutzen die föderierte Suche (`FederatedSpace.readAll` über alle 3 Members), sodass der `search_history`-Subagent Antworten aus Threads findet, die auf *anderen* Member-Hosts liegen!
3. **Journalisierter Waiter-Wettlauf (`takeWaiting`)**:
   - Globale Worker rufen `federatedSpace.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)` auf; der Router registriert Waiter auf allen Members, kürt im Journal exakt einen Gewinner und gibt parallele Reservierungen auf anderen Members automatisch frei.
4. **Betriebssteuerung im Live-Cluster (`MembershipController` & `RunController`)**:
   - **Live-Drain eines Members**: Über `membership.execute(cmdId, "drain", "member-3")` nimmt `member-3` keine neuen Threads mehr an, während laufende Transaktionen sauber abschließen.
   - **Globales `RunGate` (`pause` / `resume`)**: Über `RunController` lassen sich alle Chat-Worker über sämtliche Members hinweg mit bestätigter ACK-Barriere pausieren (z.B. für Wartung oder Profil-Übergang) und wieder fortsetzen.
   - **LWW-Replikation für globale Teilnehmer-Präsenz (Phase-3-Vorschau)**: Einsatz von `EntryReplicationController` (HLC + LWW), um `Presence`-Einträge verzögerungstolerant zwischen Standorten zu spiegeln.

#### Stufe 6 (`v6-mobile-control`): Steuerung & Überwachung über die Mobile App (`pi-termux-mobile`)

Diese Stufe verbindet den Multiplayer-Space-Chat-Cluster direkt mit der vorhandenen mobilen Anwendung in `/media/data/programming/pi-termux-mobile` (`runtime/spaces-mobile.mjs`, `runtime/public/spaces.html`, `runtime/public/steuerung.html`):

1. **Geräteschlüssel & QR-/Token-Pairing (`spaces.html`)**:
   - Der Koordinator erzeugt über den Supervisor (`createEnroll`) ein zeitlich begrenztes, an die NetBird-Peer-ID des Smartphones gebundenes Enrollment-Token und stellt es als `enrollQr`-String bereit.
   - Auf dem Smartphone erzeugt `MobileSpaces.call("prepare", ...)` einen Hardware-gestützten Schlüssel im **Android Keystore** (`createAndroidSigner`), koppelt das Gerät per `enroll` als `admin` gegen den `CONTROL_SPACE` und speichert das Profil unter Dateirechten `0600`.
   - Schlüsselbeweis (`authenticate`) und unterbrechungsfreie eigene Schlüsselrotation (`rotate` / `rotationStatus`) sind direkt vom Handy ausführbar.
2. **Mobile Live-Überwachung von Chat-Spaces, Hinweisen und Audit (`spaces.html` & `steuerung.html`)**:
   - **Data-Space-Inspektion (`objects`)**: In `spaces.html` wählt der Benutzer einen Session-/Member-Space (`dataHost`) und liest über einen vom Control-Host ausgestellten 60-s-Grant `info()`, `stats()` und die aktuellen Space-Objekte (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`).
   - **Alarme & Hinweise (`listAlerts`)**: `collectAlerts` (`src/alerts.ts`) meldet auf dem Handy sofort ungewöhnliche Zustände im Chat-Cluster (z.B. `pauseIncomplete`, `needsReview`, Worker ohne frischen Heartbeat, ablaufende `RouterLease` oder Quota-Druck).
   - **Audit-Log (`auditLog`)**: Zeigt auf dem Smartphone alle ausgeführten Admin-Commands und deren `Result`-Status ohne geheime Token-Payloads.
3. **Mobile Steuerung von Workern, Läufen (`RunGate`) und Spaces (`steuerung.html`)**:
   - Alle Steuerbefehle auf dem Handy (`ADMIN_KINDS` in `runtime/spaces-mobile.mjs`) speichern vor dem Versand ihre `commandId = m-<kind>-<hex>` lokal im Profil. Bei Doppeltippen, Funkloch oder Verbindungsabbruch sendet die App **dieselbe `commandId`** erneut („Ausgang wird geprüft“ statt doppelter Ausführung!).
   - **Chat- und Subagent-Worker skalieren (`listWorkers` / `setWorkers`)**:
     - Über das Formular *Worker* in `steuerung.html` setzt der Admin vom Handy aus die gewünschte Anzahl für `kind: "chat-worker"` oder `kind: "search-subagent"` auf einem Ziel-Host und Ziel-Space (`count: 0..64`).
     - Der lokale `WorkerSupervisor` holt die signierten `WorkerAssignments` über das Gate ab, startet zusätzliche Worker-Schleifen oder fährt sie bei `count: 0` nach Abschluss der aktuell laufenden `ChatTask`-Transaktion sauber herunter.
   - **Chat-Verarbeitung pausieren, fortsetzen & zeitgesteuert planen (`startRun` / `pauseRun` / `resumeRun` / `stopRun` / `scheduleRun`)**:
     - Über den `RunController` (`RunGate`) kann der Admin vom Smartphone aus die Annahme neuer `ChatTask`-Takes für einen Lauf/Space über alle beteiligten Members hinweg mit bestätigter ACK-Barriere pausieren (z.B. für ein Wartungsfenster oder `scheduleRun`), während laufende Antworten noch sauber committen.
   - **Session-Spaces verwalten (`createSpace` / `archiveSpace` / `reactivateSpace` / `deleteSpace`)**:
     - Neue benannte Chat-Spaces lassen sich direkt vom Handy aus idempotent auf einem Host anlegen, nach Abschluss einer Veranstaltung schreibgeschützt archivieren (`archiveSpace` – Verlauf bleibt lesbar, neue `write`/`take`/`txn` sind gesperrt!) oder nach Leerungsprüfung löschen.

---

### Interaktiver Stufen-Umschalter (`v1` bis `v6`) & Mobile-Control-Panel in der Web-UI

In der Web-Oberfläche (`PI-SPACES / HELP` $\rightarrow$ **Live Space-Chat**) befindet sich oben eine **6-Stufen-Architekturleiste (`v1` | `v2` | `v3` | `v4` | `v5` | `v6`)**:

- Der Benutzer kann jederzeit zwischen den 6 Stufen umschalten.
- Je nach gewählter Stufe zeigt das **rechte Inspector-Panel** live die stufenspezifischen Interna:
  - In **`v1`**: In-Memory-Entries (`Thread`, `Msg`, `ChatTask`, `Presence`), aktive Leases und Transaktionen.
  - In **`v2`**: Zusätzlich SQLite-Dateigröße, `rev`-Stream, `RequestRef`-Claims-Tabelle, `TimerLock`-Countdowns und `SubagentStep`-Traces.
  - In **`v3`**: Zusätzlich `SpaceService`-Socket-Frames, aktive Consumer-Mailboxes (`mailboxEpoch`, `seq`, `ackedUpTo`) und Retry-Simulation („Antwortverlust injizieren $\rightarrow$ automatisches `pollOperation` beobachten“).
  - In **`v4`**: Zusätzlich verbundene Peer-Identitäten (Schicht A), Public-Key-Fingerprints (Schicht B), aktive 60-s-Grants mit Ablauf-Countdown und einen Button *„Worker-Key live rotieren“*.
  - In **`v5`**: Zusätzlich die 3 Member-Spaces (`member-1`, `member-2`, `member-3`) mit HRW-Platzierung je `threadId` sowie das `RouterController`-Command-Journal (`accepted` $\rightarrow$ `applying` $\rightarrow$ `completed`).
  - In **`v6` (Mobile Control & Monitoring)**:
    - Zeigt einen **QR-/Token-Enrollment-Generator (`enrollQr`)** zum Koppeln von `pi-termux-mobile` sowie eine **eingebettete interaktive Vorschau von `spaces.html` und `steuerung.html`**, mit der man die exakten Handy-Befehle (`setWorkers`, `pauseRun`/`resumeRun`, `archiveSpace`, `listAlerts`, `auditLog`, Wiederholung derselben `commandId` bei Timeout) direkt im Browser oder über das gekoppelte Smartphone gegen den Space-Chat ausführen kann!

---

## 5. Das Referenzprojekt: „Multiplayer Space-Chat“ (Earendil-Szenario umgesetzt mit `pi-spaces`-Mitteln)

Der Artikel [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) demonstriert einen Multiplayer-Chat im 90s-Stil mit fünf Kernfähigkeiten. In unserem Projekt werden **alle fünf Fähigkeiten ausschließlich über `pi-spaces`-Konzepte und -APIs** realisiert.

### 5.1 Gegenüberstellung: Earendil Cloudflare-Post vs. Unsere `pi-spaces`-Umsetzung

| Anforderung aus dem Earendil-Artikel | Dortige Umsetzung (Cloudflare DO + raw `pi-durable`) | Unsere Umsetzung **mit reinen `pi-spaces`-Mitteln** |
|---|---|---|
| **1. Isolierte, teilbare Sessions per URL** | 1 Cloudflare Durable Object (`Session`) mit eigener SQLite-DB pro `sessionId`. | **1 benannter Space (`NamedSpace`) pro `sessionId`** (`createSpace(tx, sessionAlias, now)` / `new PiSpaces(host, ctx, Date.now, meter, undefined, { space: sessionId })`). Jeder Space besitzt eigene Entries, eigene Revisionsfolge (`rev`), eigene Request-Claims und eigene Limits. |
| **2. Mehrere Konversationen & Forking ohne Duplikate bei Reconnect** | `tx.createConversation` / `tx.forkConversation` + eigenes `ConversationCommandReceipts`-Dokument für `requestId`. | **Entries vom Typ `Thread` und `Msg` + native `pi-spaces` Request-Claims (`RequestRef`)**: Jedes `thread.create` und `thread.fork` wird mit `{ principal, generation, requestId }` über `space.write()` bzw. eine Space-Transaktion (`space.createTransaction` + `space.commit`) ausgeführt. Ein Reconnect-Retry mit derselben `requestId` gibt dank `src/claims.ts` sofort das gespeicherte Ergebnis zurück. Beim Forken kopiert oder referenziert eine Space-Transaktion den Eltern-Stand bis `forkUpToSeq` atomar. |
| **3. Multiplayer-Nachrichten mit Namens-Attribuierung & geordneter Abarbeitung** | `conversation.submit({ content: attributedPrompt(username, text), requestId, whenBusy: "followUp" })`. | **Transaktionale `ChatTask`-Queue im Space + `CompletionProfile`**: Jede Teilnehmer-Nachricht schreibt idempotent per `RequestRef` den User-`Msg`-Entry (`{ threadId, seq, author, role: "user", text }`) und einen `ChatTask`-Entry (`{ taskId, threadId, seq, author, text }`). Der Space-Chat-Worker entnimmt `ChatTask` exklusiv unter einer Space-Transaktion (`space.take(..., { txn })`), liest den Thread-Verlauf per `space.readAll({ type: "Msg", fields: { threadId } })` und committet die Assistant-`Msg` unter erzwungenem **`CompletionProfile`** (`ChatTask` $\rightarrow$ genau 1 `Msg`). Weitere Nachrichten warten geordnet als `ChatTask`-Entries im Space. |
| **4. Live-Streaming & Multiplayer-Presence über denselben WebSocket** | `watchEvents(harness, conversationId)` + WebSocket-Attachments für Presence. | **Kombination aus `readPage` (Snapshot), `changes(afterRev)` (Delta-Stream), Consumer-Mailbox (`notify`/`events`/`ack`) und `Presence`-Entries mit Space-Leases**: Beim Beitreten schreibt der Teilnehmer einen `Presence`-Entry (`{ participantId, username, threadId, status }`) mit einer **Space-Lease (`ttlMs = 30_000`)**, die per `space.renew(leaseId, 30_000)` verlängert wird. Fällt ein Client weg, räumt der `pi-spaces`-Reaper die Lease ab und feuert eine Revisionsänderung. Der WebSocket streamt initial `readPage` (`snapshot`) und danach jede `changes(afterRev)`-Batch in Echtzeit an alle Browser im selben Space. |
| **5. Aufwachen für geplante Aufgaben (`schedule`-Tool / Alarme)** | Durable Task schläft bis Deadline; `#refreshAlarm()` projiziert früheste Task-Deadline auf den einzigen Cloudflare DO `alarm()`. | **Persistente Space-Waiter / Timer-Leases + `SpaceAlarmScheduler`**: Wenn der Agent das `schedule`-Tool aufruft (z.B. „Prüfe in 2 Minuten den Systemstatus / das Wetter“), schreibt er einen `ScheduledJob`-Entry (`{ jobId, threadId, instruction, executeAt, status: "scheduled" }`, `FOREVER`) sowie einen **`TimerGate`-Entry mit `leaseMs = delayMs`** (bzw. registriert einen persistenten `space.wait()` mit `timeout = delayMs` und `handback`). Nach Ablauf der Frist – auch nach komplettem Server-Neustart aus SQLite! – erkennt der `pi-spaces`-Reaper (`startService` + `SpaceAlarmScheduler`, der die früheste Ablaufzeit aus `snapshotSpace` überwacht) den abgelaufenen Timer und wandelt den `ScheduledJob` transaktional und idempotent in einen ausführbaren `ChatTask` um. |
| **6. Konversationsübergreifende Suche per Subagent (`search_history`)** | Replay-sicheres Tool erzeugt Child-Conversation (`ownerTaskId: api.taskId`), sucht mit `search_conversations` in anderen Conversations und gibt nur die Antwort zurück. | **Subagent-Koordination über `SearchTask`-, `SubagentStep`- und `SearchResult`-Entries im Space**: Ruft der Haupt-Worker/Agent `search_history(question)` auf, schreibt er idempotent (gekeyt über `searchId = "search:" + taskId`) einen `SearchTask`-Entry (`{ searchId, parentThreadId, question }`) und wartet per `space.read({ type: "SearchResult", fields: { searchId } }, timeoutMs)` auf das Ergebnis. Ein spezialisierter **Search-Subagent-Worker** nimmt den `SearchTask` unter einer Space-Transaktion (`txn`), durchsucht per `space.readAll({ type: "Msg" })` alle Top-Level-Threads des Spaces (ignoriert eigene Subagent-Spuren und frühere Suchergebnisse), protokolliert seine Zwischenschritte als `SubagentStep`-Entries (damit sie in der UI-Sidebar live inspiziert werden können!) und committet das finale `SearchResult` unter einem eigenen **`CompletionProfile`**. Bei Absturz und Replay findet der Aufrufer über `searchId` / `RequestRef` sofort den bestehenden `SearchTask` bzw. das fertige `SearchResult`. |

### 5.2 Datenmodell des Multiplayer Space-Chats (Alle Entry-Typen im Session-Space)

Alle Zustände einer Chat-Session liegen transparent als typisierte Entries im jeweiligen benannten Space (`space = "chat-session-<id>"`) und können deshalb im UI-Inspector live beobachtet werden:

```ts
// 1. Konversations-Thread (Root oder Fork eines bestehenden Threads)
type ThreadEntry = {
  type: "Thread";
  fields: {
    threadId: string;
    title: string;
    parentThreadId: string | null; // null bei neuem Thread, gesetzt bei Fork
    forkUpToSeq: number | null;    // kopiert/erbt Nachrichten bis einschließlich dieser seq
    createdBy: string;
    createdAt: number;
  };
};

// 2. Kommittierte Chat-Nachricht (User, Assistant oder System-Alarm)
type MsgEntry = {
  type: "Msg";
  fields: {
    msgId: string;
    threadId: string;
    seq: number;
    author: string;                // z.B. "alice", "bob", "pi-agent", "scheduler"
    role: "user" | "assistant" | "alarm";
    text: string;
    taskId: string | null;         // Korrelationsfeld für CompletionProfile!
    subagentSearchId: string | null; // Verweis auf Subagent-Lauf in der Sidebar
    createdAt: number;
  };
};

// 3. Zu bearbeitender Agent-Auftrag (Durable Inbox im Space)
type ChatTaskEntry = {
  type: "ChatTask";
  fields: {
    taskId: string;
    threadId: string;
    triggerSeq: number;
    author: string;
    prompt: string;
    kind: "user_message" | "scheduled_wakeup";
    createdAt: number;
  };
};

// 4. Teilnehmer-Präsenz (mit kurzer Space-Lease, z.B. 30s, erneuert via space.renew)
type PresenceEntry = {
  type: "Presence";
  fields: {
    participantId: string;
    username: string;
    activeThreadId: string;
    status: "online" | "typing" | "idle";
    updatedAt: number;
  };
};

// 5. Geplante Aufgabe (schedule-Tool) + zugehöriger TimerLock mit Lease = delayMs
type ScheduledJobEntry = {
  type: "ScheduledJob";
  fields: {
    jobId: string;
    threadId: string;
    instruction: string;
    requestedBy: string;
    executeAt: number;
    status: "pending" | "triggered";
    createdAt: number;
  };
};

type TimerLockEntry = {
  type: "TimerLock";
  fields: {
    jobId: string;
    threadId: string;
    executeAt: number;
  };
  // Wird mit lease = delayMs geschrieben. Solange TimerLock existiert, ist der Job noch nicht fällig.
  // Läuft die Lease ab (auch nach Server-Pause/Neustart), entfernt der Reaper TimerLock automatisch!
};

// 6. Subagent-Historien-Suche (search_history)
type SearchTaskEntry = {
  type: "SearchTask";
  fields: {
    searchId: string;
    parentThreadId: string;
    parentTaskId: string;
    question: string;
    createdAt: number;
  };
};

type SubagentStepEntry = {
  type: "SubagentStep";
  fields: {
    searchId: string;
    stepIndex: number;
    queryTerm: string;
    matchCount: number;
    matchedSnippets: Array<{ threadId: string; seq: number; author: string; excerpt: string }>;
    createdAt: number;
  };
};

type SearchResultEntry = {
  type: "SearchResult";
  fields: {
    searchId: string;
    parentThreadId: string;
    answer: string;
    citedThreadIds: string[];
    createdAt: number;
  };
};
```

### 5.3 Die zwei `CompletionProfile`-Verträge des Space-Chats

Vor dem Start der Worker installiert der Host im Session-Space zwei verbindliche Abschlussprofile (`space.setCompletionProfiles(...)`):

1. **`ChatTask`-Abschlussprofil**:

   ```ts
   {
     taskType: "ChatTask",
     resultType: "Msg",
     matchFields: ["taskId", "threadId"],
     minResults: 1,
     maxResults: 1,
   }
   ```

   *Wirkung*: Kein `ChatTask` kann aus dem Space entfernt (committet) werden, ohne dass im selben Transaktions-Commit genau eine zugehörige Antwort-`Msg` mit derselben `taskId` und `threadId` geschrieben wird.

2. **`SearchTask`-Abschlussprofil**:

   ```ts
   {
     taskType: "SearchTask",
     resultType: "SearchResult",
     matchFields: ["searchId", "parentThreadId"],
     minResults: 1,
     maxResults: 1,
   }
   ```

   *Wirkung*: Der Search-Subagent kann seinen `SearchTask` nur abschließen, wenn er im selben Commit das strukturierte `SearchResult` ablegt.

### 5.4 Der Demo-Durchlauf (1:1 zum Earendil-Artikel, aber auf `pi-spaces`)

Benutzer können im Browser (auch mit zwei nebeneinander geöffneten Browserfenstern oder im Split-Screen-Multiplayer-Simulator der UI) exakt die Sequenz aus dem Earendil-Post durchspielen und dabei rechts im **Live Space-Inspector** jede Space-Operation beobachten:

1. **Session erstellen & zweites Teilnehmerfenster öffnen**:
   - Erzeugt den benannten Space `chat-session-<id>` und registriert `alice` und `bob` über `Presence`-Entries mit 30-s-Leases.
2. **In Thread 1 schreiben**:
   - `alice` sendet: *„Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.“*
   - `ChatTask` wird geschrieben $\rightarrow$ unter Transaktion `txn` genommen $\rightarrow$ Agent bestätigt und committet `Msg` unter `CompletionProfile`.
3. **Neuen Thread erstellen (oder Thread ab Nachricht #1 forken)**:
   - `bob` klickt auf *„Neuer Thread“* oder *„Fork ab dieser Nachricht“* (abgesichert über `RequestRef`-Claim).
4. **In Thread 2 nach früherer Entscheidung fragen**:
   - `bob` fragt: *„Was haben wir bezüglich des Event-Stores entschieden?“*
   - Der Haupt-Agent erkennt die Frage außerhalb des aktuellen Thread-Kontexts und schreibt einen `SearchTask` (`search_history`).
   - Der **Search-Subagent-Worker** nimmt `SearchTask` unter einer eigenen Transaktion, sucht mit `readAll({ type: "Msg" })` nach `"event store"` / `"PostgreSQL"`, schreibt seine Suchschritte als `SubagentStep`-Entries und committet `SearchResult` mit Zitat auf Thread 1.
5. **Subagent in der Sidebar öffnen**:
   - In der Sidebar erscheinen alle `SearchTask`-Läufe; ein Klick zeigt die exakten `SubagentStep`-Entries, Suchbegriffe, Treffer und die Transaktions-ID.
6. **Geplante Aufgabe (`schedule`) testen**:
   - `alice` schreibt: *„Erinnere uns in 15 Sekunden daran, das Backup-Fenster zu prüfen.“*
   - Der Agent legt einen `ScheduledJob`-Entry (`FOREVER`) und einen `TimerLock`-Entry mit `leaseMs = 15_000` an.
   - Selbst wenn alle Browserfenster geschlossen oder der Server-Worker kurz pausiert wird: Sobald die `TimerLock`-Lease abläuft, räumt der `pi-spaces`-Reaper den Lock ab, der `SpaceAlarmScheduler` erzeugt idempotent den Wakeup-`ChatTask`, und die Erinnerung erscheint als `Msg` im Thread.

---

## 6. Technische Architektur des Node.js + React Servers (`help-site/`)

### 6.1 Backend (`help-site/server/`)

- **Laufzeit**: Node.js (`>= 22.19.0`, direkt ausführbar mit `node --experimental-strip-types`), persistenter Storage über `openNodeSqliteStorage` (Standard: `.local/help-site-spaces.sqlite`) oder optional `MemoryStorage` für schnelle automatisierte Tests.
- **HTTP-Endpunkte**:
  - `GET /` und statische Assets (`/assets/*`): Liefert die gebaute React-Applikation (`PI-SPACES / HELP`) aus.
  - `GET /help/index.json`: Liefert den validierten, zweisprachigen Help-Index (`schema: "pi-spaces-help-site-index-v1"`, `areas`, `apiEntries`, `articles`, `stats`, Repository-Commit-Provenienz).
  - `GET /help/articles/:locale/:type/:slug.md`: Liefert den Markdown-Quelltext eines Artikels aus `help-site/corpus/`.
  - `POST /api/chat/sessions`: Erstellt oder öffnet einen benannten Session-Space (`chat-session-<id>`) und gibt `{ sessionId, spaceId, url }` zurück.
  - `GET /api/chat/sessions/:sessionId/inspect`: Liefert für den Live-Space-Inspector den aktuellen Space-Snapshot (`stats`, alle Entries gruppiert nach `Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `TimerLock`, `SearchTask`, `SubagentStep`, `SearchResult`, aktive Transaktionen, Waiter, Claims und nächste Alarm-Deadline).
- **WebSocket-Endpunkt (`/ws/chat/:sessionId`)**:
  - Implementiert ein sauberes JSON-Protokoll für den Multiplayer-Chat:
    - **Client $\rightarrow$ Server**:
      - `participant.join` (`{ participantId, username, activeThreadId, requestId }`) $\rightarrow$ schreibt/erneuert `Presence`-Entry mit 30-s-Lease.
      - `participant.heartbeat` (`{ leaseId }`) $\rightarrow$ ruft `space.renew(leaseId, 30_000)` auf.
      - `thread.create` (`{ title, requestId }`) $\rightarrow$ schreibt `Thread`-Entry mit `RequestRef`.
      - `thread.fork` (`{ parentThreadId, upToSeq, title, requestId }`) $\rightarrow$ kopiert relevante Historie / legt Fork-`Thread` in einer Space-Transaktion mit `RequestRef` an.
      - `message.submit` (`{ threadId, content, requestId }`) $\rightarrow$ schreibt User-`Msg` + `ChatTask` in einer Space-Transaktion mit `RequestRef`.
      - `alarm.schedule` (`{ threadId, delayMs, instruction, requestId }`) $\rightarrow$ erlaubt auch direktes Auslösen eines geplanten Jobs zu Testzwecken.
    - **Server $\rightarrow$ Client**:
      - `session.snapshot`: Vollständiger initialer Stand aus `readPage` (`rev`, `threads`, `messages`, `presence`, `scheduledJobs`, `subagentRuns`, `spaceStats`).
      - `session.changes`: Inkrementelle Deltas aus `space.changes(afterRev)` bei jedem Space-Commit (neue `Msg`, `ChatTask`-Reservierung, `Presence`-Änderung, `SubagentStep`, `TimerLock`-Ablauf).

### 6.2 Frontend (`help-site/client/`)

Das React-Frontend vereint das **`PI-SPACES / HELP`-Designsystem** mit der **interaktiven Multiplayer-Space-Chat-Workbench**:

1. **`App.tsx` (Topbar + 3-Spalten-Workspace)**:
   - Topbar mit `PI-SPACES / HELP`, globaler Suche (`Ctrl+K` / `/`), `DE`/`EN`-Umschalter, `Dark`/`Light`-Umschalter und dem 14-Paletten-Picker.
   - URL-Synchronisation über `URLSearchParams` (`?area=...`, `?article=...#anchor`, `?q=...`, `?view=api-finder`, `?view=space-chat&session=...`).
2. **`HomeView.tsx`**:
   - **Hero**: High-End-Hero (*„Schreiben. Koordinieren. Überleben.“* / *„Write. Coordinate. Survive.“*) mit Primär-Button *„Spaces System Map öffnen“*, Sekundär-Button *„Multiplayer Space-Chat starten“* und Such-Fokus.
   - **Sektion `01` – Kanonisches Ausführungsmodell (`execution-model`)**:
     - Spur 1 (`LOCAL / SINGLE-HOST`): `01 Entry / Template` $\rightarrow$ `02 Atomic Harness Commit (Mutation + Claim + Rev)` $\rightarrow$ `03 Reaper / Mailbox / Snapshot`.
     - Spur 2 (`FEDERATED / MULTI-HOST`): `01 Gate & 60s Grant (Layer A/B)` $\rightarrow$ `02 Router Journal & Delegation (HRW / Expand)` $\rightarrow$ `03 Member Space Commit & Prefix-ACK`.
   - **Sektion `02` – Neun Systeme (`help-area-grid`)**:
     - Die 9 nummerierten Bereichskarten (`01` bis `09`) mit Direktlinks zu den wichtigsten Artikeln.
   - **Sektion `03` – Source-eigener Bestand (`corpus-metrics`)**:
     - 4 große Kennzahlen-Kacheln (Anzahl dokumentierter API-Methoden & Agent-Tools, Anzahl kanonischer Referenzthemen, Anzahl verifizierter Architektur- & Beispielpfade, `EN/DE`-Bilingualität).
3. **`ApiFinderView.tsx`**:
   - Facettierte Echtzeit-Filterung über alle Methoden von `PiSpaces`, `RemoteSpace`, `SpaceService`, die 8 Agent-Tools, `RouterController`, `FederatedSpace`, `RunController` und Fehlerklassen.
4. **`ArticleView.tsx`**:
   - Rendert Markdown-Artikel mit Tabellen, Codeblöcken, stabilen `{#anchor}`-Überschriften, Breadcrumbs, Ressourcen-Karten, verwandten Einträgen und rechter `AUF DIESER SEITE`-TOC-Spalte.
5. **`SpaceChatWorkbench.tsx` (Das interaktive Multiplayer-Beispiel)**:
   - Bietet eine **Split-Ansicht**:
     - **Links (Multiplayer Chat mit 90s-Terminal-/IRC-Akzenten innerhalb des Designsystems)**:
       - Umschaltbarer oder paralleler Teilnehmer-Modus (z.B. „Als `alice` senden“ / „Als `bob` senden“ oder zweites Browserfenster per teilbarer Session-URL öffnen).
       - Thread-Liste inklusive **Fork-Baum** (*„Fork ab Nachricht #n“*) und **Subagent-Runs** (`search_history`-Inspektor).
       - Geplante Alarme mit Live-Countdown der `TimerLock`-Lease (`expires - now`).
     - **Rechts (Live `pi-spaces` Inspector)**:
       - Zeigt in Echtzeit den Zustand des zugrunde liegenden benannten Spaces: aktuelle Revision `rev`, aktive `Presence`-Leases mit Restlaufzeit, offene `ChatTask`- und `SearchTask`-Transaktionen, geprüfte `CompletionProfiles`, `RequestRef`-Claims und die rohen Space-Entries.

### 6.3 Geschützter Web-Admin-Bereich (`AdminSpaces`) & Produktiv-Deployment unter `https://spaces.eibrain.org`

Die Webseite unter **`https://spaces.eibrain.org`** bietet neben dem öffentlichen Hilfesystem und der Multiplayer-Chat-Demo einen **login-geschützten Bereich `AdminSpaces` (`?view=admin` bzw. `/admin`)**, über den sich sämtliche Spaces, Läufe, Worker, Deployments und Schlüssel **genauso wie in der mobilen App (`spaces.html` + `steuerung.html`)** steuern und überwachen lassen.

Dabei wird der Vertrag für das HTTPS-Browser-Gateway aus `docs/federation-plan-v3.md` (§3) und `docs/betrieb-und-mobile-steuerung.md` (§2, §3: *„Optionales HTTPS-Gateway: Anmeldung je Benutzer“*) exakt umgesetzt:

```text
   Öffentlicher Browser / Web-Admin             Smartphone (pi-termux-mobile)
          │                                            │
          │ HTTPS / WSS                                │ NetBird WireGuard Overlay
          │ https://spaces.eibrain.org                 │ tcp://100.x.x.x:<gate-port>
          │  ├─ Öffentlich: /help, /chat               │ + Android Keystore Ed25519/P-256
          │  └─ Geschützt:  /admin (Login + CSRF)      │
          ▼                                            │
┌───────────────────────────────┐                      │
│ Reverse Proxy (Nginx / Caddy) │                      │
│ TLS-Terminierung (Let's Encr.)│                      │
└──────────────┬────────────────┘                      │
               │ http://127.0.0.1:8790                 │
               ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Node.js Host (help-site/server/index.ts + pi-spaces Runtime)             │
│  ├─ Help-Server (/help/index.json, /help/articles/*, React UI)           │
│  ├─ Browser-Chat-Gateway (/api/chat/*, /ws/chat/:sessionId)              │
│  ├─ Web-Admin-Gateway (/api/admin/* -> WebAdminSpaces mit Ed25519-Signer)│
│  ├─ space-gate (auf NetBird-Overlay-IP / lokalem Socket)                 │
│  └─ Control Space, Supervisor, Router & Session-Data-Spaces (SQLite)     │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 1. Login & Authentifizierung für den `AdminSpaces`-Bereich (`server/admin/admin-auth.ts`)

- **Zweistufiges Sicherheitsmodell für das Web-Gateway**:
  1. **Benutzer-Anmeldung am Webserver (`POST /api/admin/login`)**:
     - Login über Admin-Benutzername + Passwort (gehasht mit `node:crypto.scryptSync` und verglichen mit `timingSafeEqual`) **oder** Erstkopplung per einmaligem Enrollment-Token (`enrollQr` / Bootstrap-Token).
     - Nach erfolgreichem Login setzt der Server ein signiertes `HttpOnly; Secure; SameSite=Strict`-Session-Cookie plus ein `X-CSRF-Token` für alle schreibenden `/api/admin/*`-Aufrufe.
     - Strikte Rate-Limits pro IP (Schutz gegen Brute-Force) und sofortige Session-Invalidierung bei `POST /api/admin/logout`.
  2. **Kryptografische Bindung an den `CONTROL_SPACE` (`server/admin/admin-controller.ts`)**:
     - Das Web-Gateway führt keine direkten, unautorisierten DB-Schreibzugriffe aus, sondern nutzt exakt dieselbe Architektur wie `MobileSpaces` in `pi-termux-mobile/runtime/spaces-mobile.mjs`:
     - Das Gateway verwaltet ein privates Admin-Profil (`0600`) mit einem eigenen `Ed25519`-/`P-256`-Schlüssel (`provisionFileSigner` / `loadFileSigner` aus `src/keys.ts`), authentifiziert sich per Schicht-B-Challenge (`remote.authenticate()`) am `space-gate`, bezieht vor Operationen kurzlebige 60-Sekunden-Grants (`requestGrant()`) und sendet Admin-Befehle als `Command`-Entries in den `CONTROL_SPACE`.

#### 2. Funktionsumfang im `AdminSpaces`-Webbereich (`client/components/admin/AdminSpacesView.tsx`)

Nach dem Login in `AdminSpaces` stehen auf der Webseite **alle Funktionen aus `spaces.html` und `steuerung.html`** in einer übersichtlichen High-End-Oberfläche zur Verfügung:

| Bereich in `AdminSpaces` | Funktionen auf der Webseite (1:1 zu `spaces.html` & `steuerung.html`) | Backend-Wirkung im `CONTROL_SPACE` / Data-Space |
|---|---|---|
| **1. Identität, Pairing & Schlüssel (`spaces.html`)** | Eigenes Admin-Profil prüfen (`status`, `authenticate`), eigenes Schlüsselpaar rotieren (`rotate`, `rotationStatus`), **Enrollment-Token & QR-Code (`createEnroll` / `enrollQr`) erzeugen**, um ein Smartphone (`pi-termux-mobile`) oder einen neuen Host zu koppeln, sowie kompromittierte Peers widerrufen (`revokePeer`). | `Supervisor` (`createEnroll`, `rotateKey`, `revokePeer`), `ProvingService` |
| **2. Space-Inspektor (`spaces.html`)** | Beliebigen Data-Space (`default`, `chat-session-*`, `member-1..3`, `sieve-*`) auswählen und live `info()`, `stats()` (Entries, Txns, Waiter, Byte-Budgets) sowie die enthaltenen Entries (`objects` / `readAll`) untersuchen und filtern. | `RemoteSpace.info()`, `stats()`, `readAll()` mit 60-s-Grant |
| **3. Hinweise & Alarme (`steuerung.html`)** | Aktive Systemwarnungen laden und überwachen (`listAlerts`): unvollständige Pause (`pauseIncomplete`), offene Recovery-Prüfung (`needsReview`), veraltete Worker-Heartbeats, ablaufende `RouterLease` oder Quota-Warnungen. | `collectAlerts` (`src/alerts.ts`) |
| **4. Vorgänge (`steuerung.html`)** | Liste aller gesendeten Admin-Aufträge (`operations` / `result`) mit Status (`sending`, `notSent`, `sent`, `completed`, `failed`, `duplicate`). Vor dem Senden wird die `commandId` persistent gespeichert – ein Klick auf *„Erneut prüfen / senden“* bei Timeout nutzt exakt dieselbe `commandId` ohne Zweitausführung. | `Command`- und `Result`-Entries im `CONTROL_SPACE` |
| **5. Läufe & `RunGate`-Steuerung (`steuerung.html`)** | Aktive Läufe laden (`listRuns`, `runStatus`), neuen Sieb- oder Batch-Lauf starten (`startRun`), **Plan-Vorschau (`dryRun: true`)** prüfen, Lauf über alle Members mit ACK-Barriere **pausieren (`pauseRun`), fortsetzen (`resumeRun`), stoppen (`stopRun`)**, zeitgesteuert planen (`scheduleRun`), Ergebnisse mit Manifest-Hash exportieren (`exportRun`) und nach einem Restore Recovery-Entscheidungen treffen (`reconcileRun`, `resolveRunRecovery`). | `RunController` (`src/run-controller.ts`), `RunGate` im Core |
| **6. Worker-Steuerung (`steuerung.html`)** | Registrierte Worker laden (`listWorkers`: Soll-Anzahl gegen gemeldeten Ist-Stand aus `Capability`-Heartbeat + Alter) und Worker-Anzahl je Host, Workerart (`chat-worker`, `search-subagent`, `sieve`) und Ziel-Space setzen (`setWorkers`, `count: 0..64`; `0` stoppt sauber nach dem laufenden Task). | `WorkerAssignments` & `WorkerSupervisor` (`src/workers.ts`) |
| **7. Spaces-Lebenszyklus (`steuerung.html`)** | Neue benannte Spaces idempotent auf einem Host anlegen oder wiederverwenden (`createSpace`), bestehende Spaces schreibgeschützt archivieren (`archiveSpace`), reaktivieren (`reactivateSpace`) oder nach Leerungsprüfung löschen (`deleteSpace`). | `SpaceLifecycle` (`src/space-lifecycle.ts`) |
| **8. Deployment & Audit (`steuerung.html`)** | Deklarative Deployment-Config (JSON) im Browser bearbeiten, **Plan anzeigen (`planDeployment`)**, anwenden (`applyDeployment`), aktuellen Stand exportieren (`exportDeployment`) sowie das **Audit-Log (`auditLog`)** aller Admin-Befehle (ohne geheime Token-Payloads) einsehen. | `DeploymentController` (`src/deployment.ts`), `auditLog` (`src/alerts.ts`) |

#### 3. Reverse-Proxy- und Server-Konfiguration (`help-site/deploy/`)

- `help-site/deploy/nginx-spaces.eibrain.org.conf` und `help-site/deploy/Caddyfile` (inkl. TLS, WebSocket-Upgrade für `/ws/chat/`, Cookie-/Header-Weiterleitung für `/api/admin/` und Security-Headern).
- `help-site/deploy/pi-spaces-help.service` (systemd-Unit für den dauerhaften Betrieb auf dem Server).

---

## 7. Vollständiger Artikel- und Inhaltskatalog (`help-site/corpus/`)

Jeder der folgenden Artikel wird sowohl auf **Deutsch (`corpus/de/...`)** als auch auf **Englisch (`corpus/en/...`)** samt zugehöriger Fakten-Datei angelegt:

### 7.1 Konzept- und Architekturthemen (`topics/`)

1. `help.topic.overview` – **pi-spaces Systemüberblick**: Was ist `pi-spaces`, das Tuple-Space-Modell, Zusammenspiel von `PiSpaces`, `SpaceService`, `RemoteSpace` und `FederatedSpace`.
2. `help.topic.architecture_layers` – **Schichtenarchitektur und Modul-Landkarte**: Alle Module aus `src/` von `core.ts` bis `replica-control.ts` und ihre Abhängigkeitsrichtung.
3. `help.topic.guarantees_and_boundaries` – **Verbindliche Garantien und Systemgrenzen**: Was lokal, über RPC und in der Federation garantiert ist (und was bewusst nicht garantiert wird).
4. `help.topic.entries_and_templates` – **Entries, Subtypen und Template-Matching**: `EntryDraft`, `types`, `Template`, tiefe JSON-Gleichheit, Wildcards und globale IDs (`gid`).
5. `help.topic.leases_and_transactions` – **Leases, Transaktionen und Sichtbarkeit**: `write`, `take`, `read`, `IfExists`, Sperren, `createTransaction`, `commit`, `abort`, `renew` und `cancel`.
6. `help.topic.completion_profiles` – **Serverseitige Ergebnisverträge (`CompletionProfile`)**: Warum ein Task-Take nur mit passendem Ergebnis-Write committen darf.
7. `help.topic.limits_and_quotas` – **Ressourcen-, Byte- und Owner-Budgets (`DEFAULT_LIMITS`)**: 64-KiB-Entries, 192-KiB-Commits, 256-KiB-Frames, Reservierung für Commit & Abort.
8. `help.topic.request_claims_and_generations` – **Request-Claims, Generationen und Idempotenz**: `{ principal, generation, requestId }`, RFC-8785-Argument-Hash, `pollOperation`, `resolveOperation` und `ResultExpired`.
9. `help.topic.snapshots_and_change_streams` – **Snapshot-Seiten (`readPage`) und Revisionsströme (`changes`)**: Konsistente Paginierung mit `token`/`rev` und Aufholen von Commits.
10. `help.topic.durable_mailboxes_and_ack` – **Dauerhafte Mailboxes (`events` / `ack`), `wait` und `notify`**: Nichtblockierendes Warten, `mailboxEpoch`, Präfix-ACK und Gap-Behandlung.
11. `help.topic.local_client_pispaces` – **Der lokale Client `PiSpaces` und benannte Spaces**: Default-Space vs. `NamedSpace`, `createSpace`, `listSpaces`, Ownership durch `conversationId`.
12. `help.topic.agent_tools_and_replay` – **Die 8 LLM-Agent-Tools und Replay-Sicherheit**: `space_write`, `space_read`, `space_take`, `space_list`, `space_txn`, `space_wait`, `space_notify`, `space_lease` und Task-Claims.
13. `help.topic.space_service_and_policy` – **`SpaceService`, `IdentityAdapter` und Rollen-`Policy`**: Authentisierung an der Vertrauensgrenze und Typ-/Methodenautorisierung.
14. `help.topic.remote_space_and_transports` – **`RemoteSpace`, Socket-/TCP-Transport und `pi-serverd`**: Verbindungsaufbau, `hello`, automatische Retries und `OutcomeUnknown`.
15. `help.topic.gate_and_two_layer_auth` – **Overlay-Gate, NetBird (Schicht A) und App-Challenge (Schicht B)**: WireGuard-Peer-Bindung, Verbindungs-Quoten, Ed25519/P-256-Beweis, Token-Enrollment, 60-s-Grants und Schlüsselrotation.
16. `help.topic.boot_guard_and_restore` – **Boot-Register, Fencing und Control-/Data-Restore**: `SqliteRecoveryRegister`, `HostBootState`, `RecoveryController` und `restoredUnverified`-Quarantäne.
17. `help.topic.federation_router_and_policy` – **Federation, `RouterController`, Delegation und HRW-Routing**: Journal-Partitionen, `RouterLease`, `FederationPolicy`, `FederatedSpace`, Waiter-Wettlauf, Membership und Principal-Erasure.
18. `help.topic.operations_runs_and_replication` – **Betriebserweiterung (`RunGate`, Worker, Bootstrap) und Phase-3-Replikation**: Steuerung laufender Jobs, HLC/LWW/Add-Wins, Primary-Sync und der Ausblick auf den eigenständigen Host ohne `pi-durable`.

### 7.2 Praxis-Workflows und 6-Stufen-Anleitungen (`workflows/`)

19. `help.workflow.overview_v1_to_v6` – **Übersicht des 6-Stufen-Evolutionsmodells (`v1` bis `v6`)**: Vom lokalen Zero-Setup In-Memory-Space bis zur föderierten Multi-Member-Architektur mit mobiler Steuerung unter `spaces.eibrain.org`.
20. `help.workflow.stage_v1_local_memory` – **Stufe 1 (`v1-local-memory`)**: Lokaler Sofortstart ohne Setup – `MemoryStorage`, `PiSpaces`, Threads, `Presence`-Leases, Transaktionen und `CompletionProfile`.
21. `help.workflow.stage_v2_local_durable` – **Stufe 2 (`v2-local-durable`)**: Lokale Persistenz mit SQLite, `RequestRef`-Claims für Reconnect-Idempotenz, `readPage`/`changes`, geplante Alarme (`TimerLock`-Leases) und der `search_history`-Subagent.
22. `help.workflow.stage_v3_remote_socket` – **Stufe 3 (`v3-remote-socket`)**: Prozess-Entkopplung über `SpaceService` und `RemoteSpace` (Unix-Socket/TCP), Consumer-Mailboxes (`events` + Präfix-`ack`) und `OutcomeUnknown`-Auflösung.
23. `help.workflow.stage_v4_gated_auth` – **Stufe 4 (`v4-gated-auth`)**: Zero-Trust-Mehrhost-Betrieb mit `startGate` (Schicht A Peer-Identität + Schicht B Ed25519/P-256 Challenge), Token-Enrollment, 60-Sekunden-Grants (`effect`/`resolution`), Schlüsselrotation und `HostBootState`-Boot-Guard.
24. `help.workflow.stage_v5_federated_cluster` – **Stufe 5 (`v5-federated-cluster`)**: Horizontale Skalierung mit `createFederationController` (`RouterController`, `RouterLease`, Original-Principal-Delegation, `FederationPolicy` mit HRW-Sharding nach `threadId`, `FederatedSpace` mit `takeWaiting`-Wettlauf, `MembershipController` und Phase-3-LWW-Replikation).
25. `help.workflow.stage_v6_mobile_control` – **Stufe 6 (`v6-mobile-control`)**: Steuerung & Überwachung über die Mobile App (`pi-termux-mobile`, `spaces.html` & `steuerung.html`) sowie Deployment unter `https://spaces.eibrain.org` (Android-Keystore, QR-Pairing `enrollQr`, `setWorkers`, `RunGate`-Pause/Resume, `createSpace`/`archiveSpace`, `listAlerts` & `auditLog`).

### 7.3 Strukturierte API-Einträge (`api/`)

26. Vollständige Einzelreferenzen für den **API- & Tool-Finder**:
    - `help.api.pispaces_write`, `help.api.pispaces_read`, `help.api.pispaces_take`, `help.api.pispaces_read_page`, `help.api.pispaces_changes`, `help.api.pispaces_txn`, `help.api.pispaces_lease`, `help.api.pispaces_wait_notify`, `help.api.pispaces_events_ack`, `help.api.pispaces_claims`, `help.api.pispaces_completion_profiles`, `help.api.agent_tools`, `help.api.remote_space`, `help.api.space_service`, `help.api.federation_controller`, `help.api.run_controller`.

---

## 8. Technische Randbedingungen und Einhaltung von `AGENTS.md`

Gemäß `/media/data/programming/pi-spaces/AGENTS.md` gelten folgende Regeln verbindlich:

1. **Keine ungefragten neuen npm-Abhängigkeiten**:
   - In `pi-spaces` ist `esbuild` (`^0.25.0`), TypeScript (`^7.0.2`), `@types/node` (`^26.6.4`), `@earendil-works/pi-durable`, `@earendil-works/pi-ai` und `@earendil-works/chord` bereits installiert.
   - **Für das Backend (`help-site/server/`)** werden **keinerlei neue Abhängigkeiten** benötigt:
     - HTTP-Server und statische Auslieferung nutzen `node:http`, `node:fs/promises` und `node:path` (wie `src/dashboard.ts`).
     - Der WebSocket-Server nutzt einen kompakten, standardkonformen RFC-6455-Upgrade-Handler auf Basis von `node:http` und `node:crypto` (ohne externes `ws`-Paket!).
     - Die Persistenz nutzt den bereits vorhandenen SQLite-/JSONL-/Memory-Adapter von `@earendil-works/pi-durable` und die lokale Bibliothek `../src/index.ts`.
   - **Für das React-Frontend (`help-site/client/`)** gibt es zwei saubere Wege:
     - **Option A (Zero-Install, sofort ohne `npm install` lauffähig)**: Ein leichtgewichtiges JSX-Runtime-Shim in `help-site/client/lib/react-shim.ts` (oder lokales Vendor-Bundle), das mit `esbuild` (`--jsx=automatic`) zu einem einzigen schnellen Browser-Bundle kompiliert wird – komplett ohne Netz-Download oder Änderung an `package.json`.
     - **Option B (Mit Freigabe)**: Installation von `react` und `react-dom` nach ausdrücklicher Freigabe durch den Benutzer.
     - *Empfehlung im Plan*: Die Komponenten in `help-site/client/` werden in sauberem, standardkonformem `.tsx` (mit Hooks `useState`, `useEffect`, `useMemo`, `useRef`) geschrieben, sodass sie sowohl mit dem Zero-Install-Runtime-Shim über `esbuild` sofort ohne Installation bauen als auch jederzeit 1:1 mit `react`/`react-dom` laufen.
2. **Bestehende Suite bleibt unberührt und grün**:
   - `tsconfig.json` im Hauptverzeichnis wird nicht gebrochen; `npm run typecheck` und `npm test` laufen nach jedem Schritt.

---

## 9. Umsetzungsphasen (Arbeitspakete)

### Phase 1: Kanonischer Help-Corpus & Index-Generator (`help-site/corpus/` & `help-site/scripts/build-corpus.ts`)

1. Anlegen von `help-site/corpus/help_product_catalog.yaml` mit den 9 Systembereichen.
2. Erstellen der zweisprachigen Artikel (`de` und `en`) für Architektur, Konzepte, Garantien/Grenzen, die 7-stufige Schritt-für-Schritt-Anleitung, die 3 Multiplayer-Chat-Dokumentationskapitel und die 16 API-Referenzeinträge.
3. Implementieren von `help-site/scripts/build-corpus.ts`:
   - Prüft Frontmatter, `{#anchor}`-Parität zwischen `de` und `en`, interne `help.*`-Links und Vollständigkeit des Katalogs.
   - Generiert `help-site/dist/public/help/index.json` (inkl. Inhaltsverzeichnis `toc`, Wortanzahl, Suchtext, API-Facetten und Git-Commit-Provenienz).

### Phase 2: Die 6 ausführbaren Ausbaustufen des Multiplayer Space-Chats (`help-site/examples/v1..v6` & `help-site/server/space-chat/`)

1. **`examples/shared/`**: Gemeinsame Entry-Schemata (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `TimerLock`, `SearchTask`, `SubagentStep`, `SearchResult`), die zwei `CompletionProfiles` und der deterministische Scripted-Agent.
2. **`examples/v1-local-memory/`**: Zero-Setup In-Memory-Version (`MemoryStorage` + `PiSpaces`), direkt per CLI oder im Browser startbar.
3. **`examples/v2-local-durable/`**: Persistente SQLite-Version mit `issueGeneration` / `RequestRef`-Claims, `readPage`/`changes`, `SpaceAlarmScheduler` (`TimerLock`-Lease-Ablauf) und `search_history`-Subagent.
4. **`examples/v3-remote-socket/`**: Client/Server-Version mit `SpaceService` (`serveSpace` über Unix-Socket/TCP), getrennten `RemoteSpace`-Clients für Web-Gateway, Chat-Worker und Subagent sowie Consumer-Mailbox-Steuerung (`wait` + `events` + `ack`).
5. **`examples/v4-gated-auth/`**: Gesicherte Version mit `startGate` (Schicht A Peer-Rollen + Schicht B Ed25519/P-256 Challenge), Token-Enrollment im `CONTROL_SPACE`, 60-Sekunden-Grants (`GrantAuthority`/`GrantVerifier`), Live-Schlüsselrotation und `SqliteRecoveryRegister` + `installBootGuard`.
6. **`examples/v5-federated-cluster/`**: Vollständige Cluster-Version mit `createFederationController` (Koordinator + 3 Member-Spaces, HRW-Routing nach `threadId`, `FederatedSpace` mit `takeWaiting`-Waiter-Wettlauf, `MembershipController`-Drain und Phase-3-LWW-Replikationsvorschau).
7. **`examples/v6-mobile-control/`**: Mobile-Steuerungs- und Überwachungs-Version für `pi-termux-mobile` (`spaces.html` & `steuerung.html`): QR-Enrollment (`enrollQr`), Live-Objektansicht (`objects`), Worker-Skalierung (`setWorkers` / `WorkerSupervisor`), `RunController`/`RunGate`-Pause/Resume/Schedule, Space-Lebenszyklus (`createSpace`/`archiveSpace`), Alerts (`collectAlerts`) und Audit-Log (`auditLog`).
8. **`server/space-chat/stage-runner.ts` & `deploy/`**: Einheitlicher Orchestrator für die Web-Workbench (`v1`–`v6`) sowie Reverse-Proxy- und systemd-Konfiguration für `https://spaces.eibrain.org`.

### Phase 3: Node.js HTTP/WebSocket-Server & React-UI (`help-site/server/` & `help-site/client/`)

1. **`help-site/server/index.ts`**: Node.js-Server mit Help-API (`/help/index.json`, `/help/articles/...`), Space-Chat-REST-API (`/api/chat/...`), RFC-6455-WebSocket-Server (`/ws/chat/:sessionId`) für Live-`readPage`-Snapshots und `changes(afterRev)`-Broadcasts.
2. **`help-site/client/`**:
   - High-End-Styling (Topbar, 14 Farbpaletten, Dark/Light, DE/EN, 3-Spalten-Workspace, 2-Lane-Systemmodell, 9 Systemkarten, Corpus-Metrics, API- & Tool-Finder, Markdown-Renderer mit `#anchor`-Support und rechter TOC-Spalte).
   - Integrierte **`SpaceChatWorkbench`**: Multiplayer-Chat-Oberfläche (Threads, Forking, Teilnehmer-Umschalter/Mehr-Tab-Synchronisation, Countdown für geplante Alarme, Subagent-Trace-Viewer) kombiniert mit dem **Live `pi-spaces` Inspector** (Echtzeit-Anzeige von `rev`, Entries, Leases, Transaktionen und Claims).

### Phase 4: Verifikation und Tests (`help-site/tests/`)

1. **`corpus.test.ts`**: Prüft Schema, DE/EN-Parität, stabile Anker und Suchfunktion (inkl. Kurz-Tokens wie `tx`, `gid`, `ack`, `hrw`).
2. **`chat-session.test.ts`**: Automatisierter End-to-End-Test des gesamten Earendil-Demo-Ablaufs auf `pi-spaces`:
   - Idempotentes Thread-Create & Fork bei wiederholter `requestId`.
   - Multiplayer-Nachrichten von `alice` und `bob` mit `CompletionProfile`-Prüfung.
   - `Presence`-Lease-Erneuerung und automatischer Ablauf nach Timeout.
   - Geplante Aufgabe (`TimerLock`-Lease läuft ab $\rightarrow$ Wakeup-`ChatTask` erzeugt Alarm-`Msg`, auch über Reopen eines persistenten Stores hinweg).
   - `search_history`-Subagent findet die `"PostgreSQL"`-Entscheidung aus Thread 1, schreibt `SubagentStep`-Entries und committet `SearchResult` für Thread 2.
3. **`server-http.test.ts`**: Prüft die HTTP-Routen, den WebSocket-Handshake/Live-Stream und das gebaute Frontend-Bundle.
4. Abschließender Lauf von `npm run typecheck` und `npm test` im Hauptprojekt.
