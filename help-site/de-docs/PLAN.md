# Detaillierter Architektur-, Dokumentations- und Umsetzungsplan: `PHI-SPACES / HELP` & Multiplayer Space-Chat

Stand: 2026-10-15
Hinweis: Dies ist der ursprüngliche Plan; §2.3 (Phase 3), §3, die Snippets der Stufen 3 bis 5 in §4, §6.2 und §7 wurden im Oktober 2026 gegen den Code geprüft. Was noch abweicht: Das Frontend entsteht mit Next.js (`app/`) und ist eine einzige Komponente, `HelpApp` in `client/App.tsx`, die die Ansichten selbst zeichnet (`client/components/` enthält nur die Live- und Admin-Ansichten, die App-Einführungen und die Modellauswahl); die Stufen-Runner `examples/v3`, `v4` und `v5` nutzen eine kleinere API-Fläche, als §4 zuerst vorsah (siehe dort: v5 setzt `RouterController` und `FederatedSpace` direkt zusammen, ohne `createFederationController`, `takeWaiting` oder `RunController`); das Corpus hat 26 Themen, 7 Workflows und 14 API-Artikel statt der 18/7/16 des ursprünglichen Plans; die Seite hat Apps über den Plan hinaus (Einführungen zu Social-Swarm-Feed, Codemode-Chat, spaces-mmo und Space-Statistik); der Server-Standardport ist 3500. Die Server-Routen in §6.1, §6.3, §8 und die Arbeitspakete in §9 sind der ursprüngliche Plan und wurden nicht erneut geprüft.
Zielverzeichnis: `/media/data/programming/phi-spaces/help-site/`
Öffentliche Ziel-Domain: `https://spaces.eibrain.org`
Mobile Integration: `pi-termux-mobile` (`/media/data/programming/pi-termux-mobile`, `spaces.html` & `steuerung.html`)
Fachliche Vorlage für das Praxisbeispiel: [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) – **vollständig neu gedacht und umgesetzt mit nativen `phi-spaces`-Mitteln (in 6 Ausbaustufen `v1` bis `v6`)**

---

## 1. Zielsetzung und Grundprinzip

Ziel dieses Vorhabens ist ein **Next.js- und React-basierter Webserver (`help-site/`)**, der zwei eng verzahnte Aufgaben erfüllt:

1. **Kanonisches High-End-Hilfesystem (`PHI-SPACES / HELP`)**:
   - Beantwortet präzise, quellcode- und vertragsgebunden:
     - **Was ist `phi-spaces`?** (Idee, Tuple-Space-Paradigma, Abgrenzung, Einsatzgebiete)
     - **Wie ist `phi-spaces` aufgebaut?** (Schichtenarchitektur von `src/core.ts` über `SpaceService`/`RemoteSpace` und NetBird-Gate bis zu `FederatedSpace`, Replikation und Betriebserweiterung)
     - **Was kann `phi-spaces`?** (Atomare Commits, Leases, Transaktionen, Claims, Mailboxes, CompletionProfiles, verbindliche Garantien vs. explizite Grenzen)
     - **Wie lautet die API?** (Interaktiver API- & Tool-Finder sowie vollständige Referenz für `PhiSpaces`, `RemoteSpace`, `SpaceService`, Agent-Tools, `FederationController`, `RunController` und Fehlerklassen)
     - **Wie baut man ein System mit `phi-spaces` Schritt für Schritt auf?** (Vom einzelnen Space bis zum verteilten Multiplayer-System)
2. **Vollständige Umsetzung und Dokumentation eines `phi-spaces`-Referenzprojekts: „Multiplayer Space-Chat“**:
   - Das im Blogpost *Pi Durable on Cloudflare* gezeigte Szenario (teilbare Session-URLs, mehrere Konversationen & Forking, idempotente Befehle bei Verbindungsabbruch, Multiplayer-Nachrichten mit Inbox-Reihenfolge, Live-Streaming & Teilnehmer-Präsenz, geplante Aufgaben/Alarme sowie ein Subagent zur Konversationssuche) wird **nicht** über rohe Cloudflare-Durable-Object- oder interne `pi-durable`-Session-Primitiven nachgebaut, sondern **vollständig mit den Mitteln von `phi-spaces`** (`NamedSpace`, `EntryDraft`/`Template`, `RequestRef`-Claims, `Lease`/`renew`, `Txn` + `CompletionProfile`, `readPage` + `changes`, `notify`/`wait` + Consumer-Mailboxes) realisiert.

---

## 2. Analyse der bestehenden `phi-spaces`-Dokumentation (`docs/`)

Die Auswertung aller Dokumente in `/media/data/programming/phi-spaces/docs/` ergibt folgendes Gesamtbild, das als **einzige Wahrheitsquelle (Single Source of Truth)** in den Help-Corpus einfließt:

### 2.1 Was ist `phi-spaces`?

- `phi-spaces` ist ein transaktionaler, persistenter Koordinationsraum (inspiriert von Linda / JavaSpaces), implementiert in TypeScript (ESM) mit eigenem Store (SQLite, `src/store/`), ohne pi-durable (Entscheidung D6, `docs/umstellung-u0-bestand.en.md`; `docs/umstellung-ohne-pi-durable.en.md`); das optionale `agent/`-Paket verbindet pi-durable-Agenten.
- **Grundprinzip**: Teilnehmer (Clients, Worker-Schleifen, KI-Agenten, Koordinatoren) rufen sich nicht direkt gegenseitig auf, sondern koordinieren sich über typisierte JSON-Objekte (**Entries** `{ type, types?, fields }`) in logischen Räumen (**Spaces**).
- **Entkopplung in Raum und Zeit**:
  - Ein Produzent schreibt (`write`) eine Aufgabe, Nachricht oder Beobachtung mit einer Ablaufzeit (**Lease**).
  - Ein Konsument liest (`read`) oder entnimmt exklusiv (`take`) passende Entries anhand eines **Templates** (`{ type?, fields?, id? }`, wobei fehlende oder `null`-Felder als Wildcards wirken).
  - Ist noch kein passender Entry vorhanden, wartet der Aufrufer entweder blockierend (`read`/`take` mit `timeout`) oder registriert einen dauerhaften, nichtblockierenden Auftrag (`wait` / `notify`), der auch Prozessneustarts überlebt.

### 2.2 Wie ist `phi-spaces` aufgebaut? (Die 6 Architekturschichten)

| Schicht | Quellmodule | Aufgaben und Mechanismen |
|---|---|---|
| **1. Reiner Kern & Dokumentmodell** | `src/core.ts`, `src/doc.ts`, `src/spaces.ts`, `src/canonical.ts` | Deterministische Zustandsmaschine mit explizitem `now`. Dokumentversion 5: Default-Space (`phi-spaces.space`), benannte Spaces (`phi-spaces.named-space`) und Registry (`phi-spaces.registry`, Alias $\rightarrow$ unveränderliche `spaceId`). Jeder Entry besitzt eine globale ID `gid = <spaceId>/<localId>` (`localId` = Inkarnation + monotoner Zähler). |
| **2. Claims, Streams, Seiten & Mailboxes** | `src/claims.ts`, `src/stream.ts`, `src/snapshot.ts`, `src/paging.ts`, `src/mailbox.ts` | **Ein Commit, eine Wahrheit:** Space-Mutation, Request-Claim (`{ principal, generation, requestId }` + RFC-8785 Argument-Hash), Revisionsnummer (`rev`), Mailbox-Event und Byte-Budget-Reservierung erfolgen im selben atomaren Commit. `readPage` liefert konsistente, bytebegrenzte Snapshot-Seiten (`token`, `rev`, `streamId`); `changes(afterRev)` liefert Commit-Batches; Mailboxes (`events`/`ack`) sichern Event-Zustellung mit Präfix-ACK und `mailboxEpoch` ab. |
| **3. Lokaler Client, Agent-Tools & Service** | `src/client.ts`, `src/index.ts`, `src/service.ts`, `src/remote.ts`, `src/socket.ts`, `src/pi-server.ts`, `src/meter.ts` | `PhiSpaces` (lokale API) und `RemoteSpace` (Netzwerk-Client) implementieren denselben Basisvertrag `SpaceLike`. `src/index.ts` stellt 8 replay-sichere LLM-Tools (`space_write`, `space_read`, `space_take`, `space_list`, `space_txn`, `space_wait`, `space_notify`, `space_lease`) sowie Reaper & Event-Delivery (`startService`) bereit. `SpaceService` bedient Requests über In-Process-, Unix-Socket- (`0600`), TCP- oder `pi-serverd`-Transport. |
| **4. Overlay-Gate, Auth, Grants & Recovery (Phase 1b)** | `src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/rotation.ts`, `src/supervisor.ts`, `src/runtime.ts`, `src/boot.ts`, `src/restore.ts`, `src/recovery-*.ts` | **Schicht A:** NetBird-WireGuard-Peer-Identität und Gruppen (`space-hosts`, `space-admin`, `space-observer`). **Schicht B:** Verbindungsgebundene Ed25519/P-256-Challenge (30 s). Token-/QR-Enrollment im Control Space, 60-s-Kurzzeit-Grants (`effect` vs. `resolution`), Schlüsselrotation, externes CAS-Boot-Register und journalisierter Control-/Data-Restore (`restoredUnverified` Quarantäne bis `releaseRestored`). |
| **5. Federation, Router & Membership (Phase 2)** | `src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts`, `src/capability-directory.ts`, `src/data-admin.ts` | `RouterController` mit Command-Zustandsmaschine (`accepted` $\rightarrow$ `applying` $\rightarrow$ `completed`/`failed`/`needsReview`) und 1–1024 Journal-Partitionen. Signierte `RouterLease` & Original-Principal-Delegation. `FederationPolicy` (`local`, `expand` nach Typ, HRW über Feldwert, Capacity/Capability). `FederatedSpace` inkl. journalisiertem Waiter-Wettlauf bei `takeWaiting`. Membership (`addMember`, `drain`, `freezeForRemoval`, `EmptyProof`, `removeMember`) und `DistributedPrincipalErasure`. |
| **6. Betriebserweiterung (Phase 2b) & Replikation (Phase 3)** | `src/run-controller.ts`, `src/run-member.ts`, `src/workers.ts`, `src/space-lifecycle.ts`, `src/deployment.ts`, `src/dashboard.ts`, `src/entry-replication.ts`, `src/primary-sync.ts`, `src/replica-control.ts` | `RunGate` im Core (Tasks nur bei `running` nehmbar), `RunController`, signierte `WorkerAssignments` + `WorkerSupervisor`, deklaratives Deployment (`npm run bootstrap`), lesendes HTTP+SSE-Dashboard (`src/dashboard.ts`) und TUI (`test/tui/`). Phase-3-Bausteine: HLC/LWW/Add-Wins-Replikation, gepagter Snapshot-/Stream-Transfer, Primary-Sync-Unterbau und Netcup-mTLS-Fencing. |

### 2.3 Was kann `phi-spaces`? (Verbindliche Garantien vs. Grenzen)

Gemäß `docs/implementierungsstand.en.md` und `docs/federation-plan-v3.en.md` muss das Hilfesystem strikt zwischen **nachgewiesenen Garantien** und **bewussten Grenzen** unterscheiden:

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
  - Phase 1, 1b, 2 und 2b sind umgesetzt. Phase 3 (Replikation / Promotion) besitzt Implementierungen und dokumentierte Tests, ist aber nicht vollständig abgenommen (offene Gates in `docs/_attic/abnahme/ap3-abnahme.en.md`); das Hilfesystem darf sie daher nicht als Produktionsgarantie darstellen.

---

## 3. Design- und UX-Architektur von `PHI-SPACES / HELP`

Die gestalterische und strukturelle Architektur definiert den Standard für `PHI-SPACES / HELP`:

### 3.1 Visuelles System, Typografie und 14 Farbpaletten

- **Typografie**:
  - Fließtext & Überschriften: `--font-geist-sans` (`"Geist"` mit System-UI-Fallback; es werden keine Schriftdateien mitgeliefert), die Startseiten-Headline mit engem Tracking (`letter-spacing: -0.065em`).
  - Technische Bezeichner, IDs, Badges, Nummern, Eyebrows und Code: `--font-geist-mono` (`"Geist Mono"` mit Monospace-Fallback).
- **Theme-Engine (`Dark` / `Light` + 14 Paletten)**:
  - Persistenz in `localStorage` (`phi-spaces-help-locale`, `phi-spaces-help-mode`, `phi-spaces-help-palette`); die Sprache kann auch aus `?lang=` kommen.
  - `applyThemeToDocument` (`client/lib/palettes.ts`) setzt `data-mode="dark|light"` und `data-palette="..."` auf `<html>` und schreibt die Palettenfarben als CSS-Custom-Properties auf das Wurzelelement (`--color-a/b/c`, `--editable-input`, Label- und Icon-Grautöne); `client/styles/layout.css` leitet daraus die Flächen ab.
    - Alle 14 Paletten: `spaces_default` (dunkel: `#AED83C` / `#152B35` / `#5C8EA0`; hell nutzt `#82A8BA` als zweite Farbe), `ocean_pulse`, `amber_signal`, `raspberry_velvet`, `duo_neon`, `infrared_blueprint`, `jade_clay`, `violet_cream`, `pearl_graphite`, `cobalt_saffron`, `classic_amber`, `jade_mono`, `cyan_mono`, `violet_mono`.
    - `--accent-ink` auf Primär-Buttons und aktiven Badges ist `#101010` oder `#FFFFFF`, je nachdem, was den höheren WCAG-Kontrast zur Akzentfarbe der Palette hat; `jade_mono` und `classic_amber` verwenden immer Weiß.

### 3.2 App-Shell und 3-Spalten-Workspace

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☰  PHI-SPACES / HELP   [ ⌕ Systeme, API-Methoden, Entry-Typen, Stufen v1–v6, Fehler … Ctrl K ] │
│    [◉ Space Chat] [● Multiplayer Chat (v1–v6)] [⚙ ADMINSPACES]   [DE|EN] [☾|☀] [Palette]     │
├─────────────────────────┬──────────────────────────────────────────────┬─────────────────────┤
│ SEITENLEISTE (280px)    │ HAUPTBEREICH (.content-scroll, bis 1160px)   │ TOC (250px)         │
│ NAVIGATION              │                                              │ AUF DIESER SEITE    │
│ • Help-Übersicht        │ - home (Hero, Ausführungsmodell, Bereichs-   │ • (Überschriften    │
│ • Alle Inhalte          │   karten, Corpus-Kennzahlen)                 │   des Artikels)     │
│ • API & Tool Finder     │ - area (ein Systembereich + Artikelkarten)   │ ─────────────────── │
│ • Space Chat Feed       │ - browse / search (Volltext über Bereiche    │ Help ≠ Live State   │
│ • Codemode-Chat         │   und Artikel)                               │ Stabile Verträge    │
│ • Multiplayer Space-    │ - api-finder (Facetten über API & Tools)     │ hier, Live-Daten im │
│   Chat (v1–v6)          │ - article (Markdown, Verwandtes, Provenienz) │ Chat-Inspector und  │
│ • spaces-mmo            │ - space-chat / feed (Live-Ansichten + Leiste)│ in AdminSpaces.     │
│ • Space-Statistik       │ - intro (kurze Seite vor jeder App)          │                     │
│ • AdminSpaces Steuerung │ - admin (AdminSpaces, Login)                 │ (nur bei Artikeln   │
│ 9 KANONISCHE SYSTEME    │                                              │  mit Inhalts-       │
│ 01 … 09                 │                                              │  verzeichnis)       │
│ ● spaces.eibrain.org ·  │                                              │                     │
│   Corpus-Hash           │                                              │                     │
└─────────────────────────┴──────────────────────────────────────────────┴─────────────────────┘
```

Auf schmalen Bildschirmen wird die Seitenleiste zur Schublade (`☰`, Wischen zum Schließen), die auch die Palettenauswahl enthält; die rechte Spalte wird im Artikel zu einem aufklappbaren „Auf dieser Seite“. Ohne Inhaltsverzeichnis hat das Layout zwei Spalten.

### 3.3 Die 9 kanonischen Systembereiche (`corpus/help_product_catalog.json`)

Das gesamte Wissen über `phi-spaces` wird in **9 kanonische Systembereiche** gegliedert (`areas` im Katalog; der neunte hat `kind: "reference"`, die übrigen `"system"`). Der Katalog ordnet jedem Bereich seine Artikel über die ID zu; die vollständige Artikelliste ist §7:

1. **`01` – Spaces System Map (`spaces_system_map`)**
   - Technische Systemkarte für Tuple-Spaces, die 6 Architekturschichten, das Daten- und Konsistenzmodell sowie verbindliche Garantien und Grenzen.
   - Artikel: `help.topic.overview`, `help.topic.apps`, `help.topic.architecture_layers`, `help.topic.guarantees_and_boundaries`, `help.topic.comparison_earendil_vs_phi_spaces`, `help.topic.async_interaction`, `help.topic.topology_and_readiness`.
2. **`02` – Core, Entries & Transaktionen (`core_entries_transactions`)**
   - Reine Zustandsmaschine, Dokumentversion 5, globale IDs (gid), Subtypen, Wildcard-Templates, Leases, Transaktionen, CompletionProfiles und Byte-Budgets.
   - Artikel: `help.topic.entries_and_templates`, `help.topic.leases_and_transactions`, `help.topic.completion_profiles_and_limits`, `help.topic.task_lifecycle`.
3. **`03` – Claims, Streams & Mailboxes (`claims_streams_mailboxes`)**
   - Idempotente Request-Claims (RequestRef + Generation), RFC-8785-Argument-Hashes, bytebegrenzte Snapshot-Seiten (readPage), Revisionsströme (changes) und Consumer-Mailboxes (events/ack).
   - Artikel: `help.topic.request_claims_and_generations`, `help.topic.snapshots_and_change_streams`, `help.topic.durable_mailboxes_and_ack`, `help.topic.live_sync_recipe`.
4. **`04` – Lokaler Client & Agent-Tools (`client_and_agent_tools`)**
   - Lokaler Client PhiSpaces, benannte Spaces (NamedSpace/Registry), Reaper und Event-Delivery (startService) sowie die 8 replay-sicheren LLM-Agent-Tools.
   - Artikel: `help.topic.local_client_and_named_spaces`, `help.topic.agent_tools_and_replay`, `help.topic.first_running_space`, `help.topic.examples`.
5. **`05` – SpaceService, RemoteSpace & Transporte (`service_remote_transport`)**
   - Transportunabhängiger SpaceService, Rollen-Policy, RemoteSpace über Unix-Socket, TCP und pi-serverd sowie sichere Auflösung von OutcomeUnknown.
   - Artikel: `help.topic.space_service_and_remote_space`, `help.topic.failure_playbook`.
6. **`06` – Overlay-Gate, Authentisierung & Recovery (`gate_auth_recovery`)**
   - Zwei-Schichten-Sicherheit (Schicht A NetBird-Peer, Schicht B Ed25519/P-256 Challenge), Token-/QR-Enrollment, 60-s-Grants, Schlüsselrotation, Boot-Guard und Restore.
   - Artikel: `help.topic.gate_auth_grants_and_recovery`, `help.topic.safe_operations`.
7. **`07` – Federation, Router & Membership (`federation_router_membership`)**
   - RouterController mit Journal-Partitionen, signierte RouterLease und Delegation, FederationPolicy (HRW/Expand), FederatedSpace, Waiter-Wettlauf, Membership und Principal-Erasure.
   - Artikel: `help.topic.federation_router_and_membership`.
8. **`08` – Betrieb, Mobile/Web-Admin & Replikation (`operations_runs_replication`)**
   - RunGate & RunController, WorkerSupervisor, Space-Lebenszyklus, Steuerung über Mobile App (pi-termux-mobile) & Web-Admin (AdminSpaces) sowie Phase-3-Replikation.
   - Artikel: `help.topic.operations_mobile_and_replication`, `help.topic.social_swarm_pipeline`.
9. **`09` – Schritt-für-Schritt (v1–v6) & API-Index (`step_by_step_and_api_reference`)**
   - Praxisleitfaden vom lokalen Zero-Setup-Space (v1) bis zum föderierten Cluster mit Mobile/Web-Admin (v6) am Multiplayer Space-Chat sowie der facettierte API- & Tool-Finder.
   - Artikel: `help.workflow.overview_v1_to_v6`, `help.workflow.stage_v1_local_memory`, `help.workflow.stage_v2_local_durable`, `help.workflow.stage_v3_remote_socket`, `help.workflow.stage_v4_gated_auth`, `help.workflow.stage_v5_federated_cluster`, `help.workflow.stage_v6_mobile_control`.

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

Unter dem Bereich `API & Tools` bietet das Hilfesystem einen facettierten technischen Finder über alle öffentlichen Exporte aus `src/index.ts` und `docs/api.en.md`:

- **Modus-Tabs**: `API & Tools` (alle API- und Agent-Tool-Artikel, mit Anzahl) vs. `Architektur-Pakete` (die Modulpakete des Index: `core`, `client`, `service`, `remote`, `gate/auth`, `federation`, `ops`).
- **Anbieter-Filter-Chips**: `ALL`, `_CORE`, `_CLIENT`, `_TOOLS`, `_REMOTE`, `_SECURITY`, `_FEDERATION`, `_OPS`, dazu eine Freitextsuche.
- **4 Facetten-Dropdowns** (Werte aus dem `api`-Frontmatter der Artikel):
  1. `Category`: `Mutation`, `Query / Snapshot`, `Transaction / Lease`, `Wait / Mailbox`, `Security / Grant`, `Federation / Routing`, `Operations / RunGate`.
  2. `Execution`: `Atomic Commit`, `Blocking Wait`, `Non-Blocking Event`, `Snapshot / Stream`, `Replay-Safe Tool`, `RPC Retry`, `Crypto Challenge`, `Journaled Command`, `ACK Barrier`.
  3. `Idempotency`: `RequestRef Claim`, `Task Claim (replay: safe)`, `Read-Only Snapshot`, `CAS / Epoch-Bound`.
  4. `Scope`: `Single or RemoteSpace`, `Single Space`, `Conversation-Owned`, `Unix Socket / TCP`, `Control & Data Host`, `Multi-Member Cluster`, `Coordinator Control`.

---

## 4. Das 6-Stufen-Evolutionsmodell („Vom Einfachen zum Komplexesten inkl. Mobile Control“: `v1` bis `v6`)

Damit Einsteiger sofort ohne Hürden lokal starten können und Fortgeschrittene denselben Anwendungsfall Schritt für Schritt bis zur voll ausgebauten, kryptografisch gesicherten Multi-Member-Federation **inklusive Steuerung und Überwachung über die mobile App (`pi-termux-mobile`)** ausbauen können, wird das Multiplayer-Space-Chat-Beispiel in **6 aufeinander aufbauenden, einzeln ausführbaren Versionen (`v1` bis `v6`)** umgesetzt und dokumentiert.

Weil `PhiSpaces` und `RemoteSpace` denselben Basisvertrag `SpaceLike` erfüllen und `FederatedSpace` die verteilte Entsprechung bereitstellt, bleibt das **fachliche Chat-Datenmodell (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`) über alle 6 Versionen identisch** – es ändert sich von Stufe zu Stufe nur die darunterliegende `phi-spaces`-Infrastruktur und Betriebsschicht!

### Übersicht der 6 Ausbaustufen

| Version | Verzeichnis / Modus | Infrastruktur & Storage | Neu hinzukommende `phi-spaces`-Mittel | Ziel & Einsatzzweck |
|---|---|---|---|---|
| **`v1`** | `examples/v1-local-memory/` | 1 Prozess, `openOwnMemoryHost()` (Store im Speicher), kein Setup | `PhiSpaces`, `NamedSpace`, `write`/`read`/`take`, `Lease` (`renew`), `Txn` (`createTransaction`/`commit`/`abort`), `CompletionProfile`, `startService` | **Sofortstart für Demo & schnelle Tests**: Läuft überall in < 1 Sekunde ohne Dateien, Ports oder Keys. Zeigt Threads, Forking, Multiplayer-Presence und transaktionale Worker. |
| **`v2`** | `examples/v2-local-durable/` | 1 Prozess, persistenter phi-spaces-Store (`openSqliteHost`, SQLite) | `issueGeneration` + `RequestRef`-Claims (Reconnect-Idempotenz), `readPage`-Snapshots (`rev`), `changes(afterRev)`-Stream, `TimerLock`-Leases für `schedule`-Alarme, `SearchTask`/`SubagentStep`/`SearchResult` | **Lokale Dauerhaftigkeit & Crash-Recovery**: Überlebt `SIGKILL` und Server-Neustarts ohne Datenverlust oder doppelte Ausführung; führt Alarme und den `search_history`-Subagenten ein. |
| **`v3`** | `examples/v3-remote-socket/` | Getrennte Client-/Worker-Verbindungen über Unix-Socket (`0600`) oder TCP (`127.0.0.1`) | `SpaceService`, `serveSpace`, `RemoteSpace`, `socketTransport`, `StaticIdentity`/`GateIdentity`, Rollen-`Policy`, Consumer-Mailboxes (`events` + Präfix-`ack`), `pollOperation` bei `OutcomeUnknown` | **Echte Netzwerk-Entkopplung (`RemoteSpace`)**: Web-Gateway, Chat-Worker und Search-Subagent greifen nicht mehr direkt auf den Harness zu, sondern kommunizieren als Remote-Clients über Socket/TCP und Mailboxes. |
| **`v4`** | `examples/v4-gated-auth/` | Mehrere Prozesse/Hosts hinter `startGate` + `CONTROL_SPACE` + `SqliteRecoveryRegister` | **Schicht A** (`PeerDirectory`/NetBird-Rollen), **Schicht B** (`ProvingService` Ed25519/P-256 Challenge), Token-Enrollment (`createEnroll`/`bootstrapEnroll`), 60-s-Grants (`GrantAuthority`/`GrantVerifier`), `rotateKey`, `installBootGuard` | **Zero-Trust & Mehr-Host-Sicherheit**: Jeder Remote-Worker beweist seinen privaten Schlüssel beim Verbindungsaufbau, holt vor Mutationen kurzlebige 60-s-Grants und prüft Boot-Berechtigungen. |
| **`v5`** | `examples/v5-federated-cluster/` | Koordinator-Host (`RouterController` + `FederatedSpace`) + 3 Member-Spaces, in einem Prozess simuliert | `RouterController` (Journal-Partitionen), `FederationPolicy` (`expand` + HRW nach `threadId`), `FederatedSpace` (`write`, `readAll`; `takeWaiting` als API), `EntryReplicationController` (LWW-Presence, Phase-3-Vorschau) | **Föderierte Skalierung (Cluster)**: Horizontale Verteilung der Chat-Threads per HRW über mehrere Member-Spaces und clusterweite Lesezugriffe für die Subagent-Suche. |
| **`v6`** | `examples/v6-mobile-control/` | Cluster + `pi-termux-mobile` (`spaces.html` & `steuerung.html`) + Web-Gateway (`spaces.eibrain.org`) | `MobileSpaces`-Brücke, Android-Keystore-Pairing via QR (`enrollQr`), Admin-Commands (`startRun`/`pauseRun`/`resumeRun`/`stopRun`/`scheduleRun`, `setWorkers`/`listWorkers`, `createSpace`/`archiveSpace`, `listAlerts`, `auditLog`), `WorkerSupervisor` & `RunController` | **Mobile Steuerung & Überwachung (Production Ops)**: Komplette Überwachung und Administration des Multiplayer-Space-Chat-Clusters vom Smartphone (`pi-termux-mobile`) und über `https://spaces.eibrain.org`. |

---

### Detaillierte Schritt-für-Schritt-Anleitung von `v1` bis `v5` im Hilfesystem

Für jede der 5 Stufen enthält das Hilfesystem ein vollständiges, eigenständiges Kapitel mit Architekturdiagramm, komplettem Code, Startbefehl und interaktiver Live-Ansicht:

#### Stufe 1 (`v1-local-memory`): Der einfachste lokale Space-Chat (Zero-Setup)

1. **Harness & benannten Space im Speicher öffnen**:
   - `const host = openOwnMemoryHost()`
   - `await host.commit(async (tx) => { await createSpace(tx, "chat-v1", Date.now()); }, ctx)`
   - `const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: "chat-v1" })`
   - `const stopService = await startService(host, ctx)`
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

1. **Wechsel von `openOwnMemoryHost()` auf `openSqliteHost(dbPath)`**:
   - Austausch einer einzigen Zeile beim Öffnen des Hosts: Alle Entries, Leases, Transaktionen und Claims überleben nun Prozess-Neustarts.
2. **Reconnect-Sicherheit mit `issueGeneration` & `RequestRef`**:
   - Vor dem ersten Befehl öffnet die Session für jeden Teilnehmer eine Generation: `const { generation } = await space.issueGeneration(principal)`.
   - Beim Erstellen eines Threads (`thread.create`), beim Forken (`thread.fork`) und beim Senden einer Nachricht (`message.submit`) wird `{ request: { principal, generation, requestId } }` mitgegeben.
   - Wird dieselbe Nachricht nach einem WebSocket-Abbruch erneut gesendet, liefert `space.write` dank `src/claims.ts` das gespeicherte Ergebnis zurück – es entsteht kein doppelter Thread und keine doppelte Nachricht.
3. **Live-UI-Synchronisation über `readPage` und `changes(afterRev)`**:
   - Beim Verbinden liest der Server `const snapshot = await space.readPage(null)` und merkt sich `snapshot.rev`.
   - Bei jeder Änderung ruft er `const delta = await space.changes(lastRev)` auf und streamt die neuen Commit-Batches über WebSocket an die verbundenen Browser.
4. **Geplante Aufgaben (`schedule`) mit `ScheduledJob` und `TimerLock`-Lease**:
   - Das `schedule`-Tool schreibt `ScheduledJob` (`FOREVER`) und `TimerLock` (`lease = delayMs`).
   - Sobald `TimerLock` abläuft (durch `startService` / Reaper entfernt), erkennt `SpaceChatEngine.tickAlarms()` (`examples/shared/chat-core.ts`), dass ein `ScheduledJob` mit `status: "pending"` ohne aktiven `TimerLock` vorliegt, und erzeugt in einer Space-Transaktion genau einmal den Wakeup-`ChatTask`.
5. **Konversationsübergreifende Suche (`search_history`) mit Subagent-Worker**:
   - Zweites `CompletionProfile`: `SearchTask` $\rightarrow$ `SearchResult`.
   - Der Subagent-Worker nimmt `SearchTask` unter einer Transaktion, durchsucht mit `readAll({ type: "Msg" })` alle Threads, schreibt `SubagentStep`-Entries für die Sidebar-Transparenz und committet `SearchResult`.

#### Stufe 3 (`v3-remote-socket`): Entkoppelte Prozesse mit `SpaceService` und `RemoteSpace`

1. **Space-Host als eigener Server-Endpunkt (`serveSpace`)**:
   - Der Host startet `const service = new SpaceService({ host, ctx, identity: new GateIdentity(), policy: DEFAULT_POLICY })` und horcht über `serveSpace(service, { listen: { path: socketPath }, connection: () => ({ peerId, credentials: { roles: ["admin", "member"] } }) })`. Die Demo nutzt einen Unix-Socket; `StaticIdentity` und ein TCP-Ziel sind die Alternativen.
2. **Web-Gateway, Chat-Worker und Search-Subagent als `RemoteSpace`-Clients**:
   - Jeder Dienst verbindet sich über `new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" })`.
   - Der Anwendungscode für `write`, `take`, `readAll`, `createTransaction`, `commit` und `renew` bleibt **unverändert**, da `RemoteSpace` ebenfalls `SpaceLike` implementiert!
3. **Ereignisgesteuerte Zustellung über Consumer-Mailboxes (`notify`, `events`, `ack`)**:
   - Der Worker registriert ein dauerhaftes Abonnement: `await workerRemote.notify({ type: "Msg" }, { target: "self", lease: FOREVER, handback })`. `RemoteSpace.wait(template, { take: true, target: "self", timeout, txnLeaseMs })` parkt einen Take auf dieselbe Weise, die Demo nutzt es aber nicht.
   - Er liest seine Mailbox über `const page = await workerRemote.events({ waitMs: 50 })` und bestätigt den Empfang mit `await workerRemote.ack(page.mailboxEpoch, page.next)`; die Registrierung endet mit `cancel(lease.id)`.
4. **Umgang mit `OutcomeUnknown`** (API-Vertrag, von der Demo nicht provoziert):
   - Fällt die Verbindung während eines Commits aus, fängt der Aufrufer `OutcomeUnknown` ab und fragt mit `await remoteSpace.pollOperation(request)` den tatsächlichen Ausgang ab.

#### Stufe 4 (`v4-gated-auth`): Zwei-Schichten-Sicherheit (Gate, Schlüssel-Challenge & 60s-Grants)

1. **Control-Host und Data-Host mit `startFederationHost`**:
   - Zwei persistente Hosts mit je eigenem Store laufen hinter echten TCP-Gates auf `127.0.0.1`; `startFederationHost` setzt Gate, Boot-Guard (`SqliteRecoveryRegister`, `HostBootState`) und Dienst zusammen.
   - Schicht A prüft Peer-Identität und Gruppen über ein `PeerDirectory`; die Demo nutzt ein simuliertes Verzeichnis (Peer `chat-worker` in der Gruppe `space-enroll`, Gruppen über `groupRoles` auf Rollen abgebildet), der Betrieb `NetbirdDirectory`.
   - Schicht B verlangt beim Verbindungsaufbau eine `Ed25519`-Signatur über die Verbindungs-Challenge (`{ gateHostId, observedPeerId, connNonce, protocol, issuedAt }`, 30 s gültig): `controlClient.authenticate()`.
2. **Token-Enrollment des Chat-Workers**:
   - Die Demo schreibt das Einmal-Token mit `bootstrapEnroll(controlStore, ctx, { tokenHash: hashToken(token), allowedPeerId })`; der Worker schreibt sich mit `controlClient.enroll(token)` im `CONTROL_SPACE` ein. Das Supervisor-Kommando `createEnroll` ist der Betriebsweg für weitere Tokens; die Demo nutzt es nicht.
3. **Kurzlebige 60-Sekunden-Grants (`grantProvider`)**:
   - Der Data-Host startet mit `grantProvider: () => controlClient.requestGrant("effect")`; der Control-Host signiert den Grant (`GrantAuthority`, höchstens 60 s gültig), und der Verifier (`GrantVerifier`) prüft ihn, bevor eine Mutation angewendet wird.
4. **Schlüsselrotation im laufenden Betrieb (`rotateKey`)**:
   - Der Worker holt `rotationChallenge(...)`, ruft `rotateKey(challenge, replacementKey.signer)` auf und authentisiert sich erneut mit dem neuen Schlüssel; die Demo prüft danach die Zustände des alten und des neuen Schlüssels.

#### Stufe 5 (`v5-federated-cluster`): Horizontale Skalierung mit `FederatedSpace` & HRW-Routing

1. **Cluster aus Koordinator und 3 Member-Spaces (`member-1`, `member-2`, `member-3`), in einem Prozess simuliert**:
   - Der Koordinator-Host (im Arbeitsspeicher) trägt einen `RouterController` (`router-root` plus 2 Partition-Router, `journalPartitions: 2`) und den `FederatedSpace` `fed-v5`; die drei Members sind getrennte Hosts im Arbeitsspeicher. `FederationIO` ist ein In-Process-Adapter auf die `PhiSpaces`-Objekte der Members.
   - Der Runner setzt diese Klassen direkt zusammen. Er nutzt weder `createFederationController` noch ein Gate, einen Control-Space oder eine signierte `RouterLease`.
2. **Deklarative `FederationPolicy` für den Multiplayer-Chat**:
   - `Thread`, `Msg` und `ChatTask` werden per **`expand` mit HRW (Highest Random Weight) über das Schlüsselfeld `threadId`** geroutet: Alle Nachrichten und Aufgaben desselben Threads landen deterministisch im selben Member-Space, sodass lokale Transaktionen und `CompletionProfiles` pro Thread ohne knotenübergreifende Sperren funktionieren.
   - Clusterweite Lesezugriffe nutzen `federated.readAll(template, principal)`; es fragt jeden Member, auf den das Template passen kann, sodass der `search_history`-Subagent Antworten aus Threads auf *anderen* Members findet.
3. **Waiter-Wettlauf (`takeWaiting`), nur als API**:
   - `federatedSpace.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)` nimmt eine Aufgabe von dem Member, der zuerst eine hat. Der v5-Runner ruft es nicht auf.
4. **Presence-Replikation (Phase-3-Vorschau)**:
   - Zwei `EntryReplicationController`-Instanzen (`rep-1` auf `member-1`, `rep-2` auf `member-2`) replizieren `Presence`-Einträge mit HLC + LWW; der Runner trägt die Änderungen selbst zwischen ihnen. Phase 3 ist nicht vollständig abgenommen, daher ist dies eine Vorschau.
   - Membership-Kommandos (`MembershipController`, Drain) und Laufsteuerung (`RunController`, `RunGate`) gehören nicht zum v5-Runner; sie gehören zum Federation-Controller und zu Stufe 6.

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

In der Web-Oberfläche (`PHI-SPACES / HELP` $\rightarrow$ **Live Space-Chat**) befindet sich oben eine **6-Stufen-Architekturleiste (`v1` | `v2` | `v3` | `v4` | `v5` | `v6`)**:

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

## 5. Das Referenzprojekt: „Multiplayer Space-Chat“ (Earendil-Szenario umgesetzt mit `phi-spaces`-Mitteln)

Der Artikel [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) demonstriert einen Multiplayer-Chat im 90s-Stil mit fünf Kernfähigkeiten. In unserem Projekt werden **alle fünf Fähigkeiten ausschließlich über `phi-spaces`-Konzepte und -APIs** realisiert.

### 5.1 Gegenüberstellung: Earendil Cloudflare-Post vs. Unsere `phi-spaces`-Umsetzung

| Anforderung aus dem Earendil-Artikel | Dortige Umsetzung (Cloudflare DO + raw `pi-durable`) | Unsere Umsetzung **mit reinen `phi-spaces`-Mitteln** |
|---|---|---|
| **1. Isolierte, teilbare Sessions per URL** | 1 Cloudflare Durable Object (`Session`) mit eigener SQLite-DB pro `sessionId`. | **1 benannter Space (`NamedSpace`) pro `sessionId`** (`createSpace(tx, sessionAlias, now)` / `new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: sessionId })`). Jeder Space besitzt eigene Entries, eigene Revisionsfolge (`rev`), eigene Request-Claims und eigene Limits. |
| **2. Mehrere Konversationen & Forking ohne Duplikate bei Reconnect** | `tx.createConversation` / `tx.forkConversation` + eigenes `ConversationCommandReceipts`-Dokument für `requestId`. | **Entries vom Typ `Thread` und `Msg` + native `phi-spaces` Request-Claims (`RequestRef`)**: Jedes `thread.create` und `thread.fork` wird mit `{ principal, generation, requestId }` über `space.write()` bzw. eine Space-Transaktion (`space.createTransaction` + `space.commit`) ausgeführt. Ein Reconnect-Retry mit derselben `requestId` gibt dank `src/claims.ts` sofort das gespeicherte Ergebnis zurück. Beim Forken kopiert oder referenziert eine Space-Transaktion den Eltern-Stand bis `forkUpToSeq` atomar. |
| **3. Multiplayer-Nachrichten mit Namens-Attribuierung & geordneter Abarbeitung** | `conversation.submit({ content: attributedPrompt(username, text), requestId, whenBusy: "followUp" })`. | **Transaktionale `ChatTask`-Queue im Space + `CompletionProfile`**: Jede Teilnehmer-Nachricht schreibt idempotent per `RequestRef` den User-`Msg`-Entry (`{ threadId, seq, author, role: "user", text }`) und einen `ChatTask`-Entry (`{ taskId, threadId, seq, author, text }`). Der Space-Chat-Worker entnimmt `ChatTask` exklusiv unter einer Space-Transaktion (`space.take(..., { txn })`), liest den Thread-Verlauf per `space.readAll({ type: "Msg", fields: { threadId } })` und committet die Assistant-`Msg` unter erzwungenem **`CompletionProfile`** (`ChatTask` $\rightarrow$ genau 1 `Msg`). Weitere Nachrichten warten geordnet als `ChatTask`-Entries im Space. |
| **4. Live-Streaming & Multiplayer-Presence über denselben WebSocket** | `watchEvents(harness, conversationId)` + WebSocket-Attachments für Presence. | **Kombination aus `readPage` (Snapshot), `changes(afterRev)` (Delta-Stream), Consumer-Mailbox (`notify`/`events`/`ack`) und `Presence`-Entries mit Space-Leases**: Beim Beitreten schreibt der Teilnehmer einen `Presence`-Entry (`{ participantId, username, threadId, status }`) mit einer **Space-Lease (`ttlMs = 30_000`)**, die per `space.renew(leaseId, 30_000)` verlängert wird. Fällt ein Client weg, räumt der `phi-spaces`-Reaper die Lease ab und feuert eine Revisionsänderung. Der WebSocket streamt initial `readPage` (`snapshot`) und danach jede `changes(afterRev)`-Batch in Echtzeit an alle Browser im selben Space. |
| **5. Aufwachen für geplante Aufgaben (`schedule`-Tool / Alarme)** | Durable Task schläft bis Deadline; `#refreshAlarm()` projiziert früheste Task-Deadline auf den einzigen Cloudflare DO `alarm()`. | **Persistente Space-Waiter / Timer-Leases + `SpaceChatEngine.tickAlarms()`**: Wenn der Agent das `schedule`-Tool aufruft (z.B. „Prüfe in 2 Minuten den Systemstatus / das Wetter“), schreibt er einen `ScheduledJob`-Entry (`{ jobId, threadId, instruction, executeAt, status: "scheduled" }`, `FOREVER`) sowie einen **`TimerLock`-Entry mit `lease = delayMs`** (bzw. registriert einen persistenten `space.wait()` mit `timeout = delayMs` und `handback`). Nach Ablauf der Frist – auch nach komplettem Server-Neustart aus SQLite! – erkennt der `phi-spaces`-Reaper (`startService`; `tickAlarms()` in `examples/shared/chat-core.ts` erkennt den abgelaufenen Timer) den abgelaufenen Timer und wandelt den `ScheduledJob` transaktional und idempotent in einen ausführbaren `ChatTask` um. |
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

### 5.4 Der Demo-Durchlauf (1:1 zum Earendil-Artikel, aber auf `phi-spaces`)

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
   - Selbst wenn alle Browserfenster geschlossen oder der Server-Worker kurz pausiert wird: Sobald die `TimerLock`-Lease abläuft, räumt der `phi-spaces`-Reaper den Lock ab, `tickAlarms()` erzeugt idempotent den Wakeup-`ChatTask`, und die Erinnerung erscheint als `Msg` im Thread.

---

## 6. Technische Architektur des Node.js + React Servers (`help-site/`)

### 6.1 Backend (`help-site/server/`)

- **Laufzeit**: Node.js (`>= 22.19.0`, direkt ausführbar mit `node --experimental-strip-types`), persistenter phi-spaces-Store über `openSqliteHost` (Standard: `.local/help-site-spaces.sqlite`) oder optional `openOwnMemoryHost` für schnelle automatisierte Tests.
- **HTTP-Endpunkte**:
  - `GET /` und statische Assets (`/assets/*`): Liefert die gebaute React-Applikation (`PHI-SPACES / HELP`) aus.
  - `GET /help/index.json`: Liefert den validierten, zweisprachigen Help-Index (`schema: "phi-spaces-help-site-index-v1"`, `areas`, `apiEntries`, `articles`, `stats`, Repository-Commit-Provenienz).
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

Das React-Frontend ist eine Next.js-16-/React-19-App. `app/layout.tsx` setzt Metadaten und die Vorgaben für `data-mode`/`data-palette` und importiert `client/styles/layout.css`; `app/page.tsx` ist eine Server-Komponente, die `public/help/index.json` liest und `<HelpApp initialIndex={...} />` rendert. `client/main.tsx` ist nur der eigenständige Einstieg, der dieselbe Komponente einbindet. Es gibt keine Dateien je Ansicht: `HelpApp` in `client/App.tsx` hält die Shell und zeichnet die Ansichten selbst; `client/components/` enthält die größeren Live- und Admin-Ansichten.

1. **`client/App.tsx` (`HelpApp`: Topbar + 3-Spalten-Workspace)**:
   - Topbar mit `PHI-SPACES / HELP`, globaler Suche (`Ctrl K` / `/`), Schaltflächen für den Space-Chat-Feed, den Multiplayer-Chat (v1–v6) und AdminSpaces, `DE`/`EN`-Umschalter, `Dark`/`Light`-Umschalter und 14-Paletten-Auswahl; die Seitenleiste steht in §3.2.
   - Die aktuelle Ansicht ist ein `ViewState` (`client/lib/help-navigation.ts`) mit den Arten `home`, `area`, `article`, `search`, `browse`, `api-finder`, `space-chat`, `feed`, `intro` und `admin`. `parseHelpView` und `helpUrl` bilden ihn auf die URL ab: `?lang=`, `?area=...`, `?article=...#anchor`, `?q=...`, `?owner=...&type=...`, `?view=api-finder` (mit `mode`, `oq`, `provider`, `category`, `execution`, `idempotency`, `scope`), `?view=space-chat&session=...&stage=v1..v6`, `?view=feed`, `?view=admin`, `?view=intro&app=...`.
   - Index und Artikel kommen aus `public/help/index.json` und `/help/articles/...` (`client/lib/index-load.ts`, `article-load.ts`); die Suche ist ein Token-/Alias-Scorer (`client/lib/search.ts`).
2. **Startseite (in `App.tsx`)**:
   - **Hero**: *„Schreiben. Koordinieren. Überleben.“* / *„Write. Coordinate. Survive.“* mit den Schaltflächen *„Ersten vollständigen Space starten“* (`help.topic.first_running_space`), *„Beispiele starten“* (`help.topic.examples`), *„Alle Apps im Überblick“* (`help.topic.apps`), dem AdminSpaces-Login und einem Link zum GitHub-Repository.
   - **Sektion `01` – Kanonisches Modell (`execution-model`)**:
     - Spur `LOCAL` (v1–v3 einzelner Space): `01 Input & Claim` (Entry + RequestRef) $\rightarrow$ `02 Atomic Commit` (Txn + CompletionProfile) $\rightarrow$ `03 Reactive Stream` (readPage / changes / Mailbox).
     - Spur `CLUSTER` (v4 Gate, v5 Routing, v6 Betrieb): `01 Zero-Trust Gate` (Layer A/B + 60s Grant) $\rightarrow$ `02 Router & Sharding` (HRW Policy & Journal) $\rightarrow$ `03 Operations Control` (RunGate & AdminSpaces).
   - **Sektion `02` – Neun Systeme (`help-area-grid`)**: die 9 nummerierten Bereichskarten (`01` bis `09`) mit Direktlinks zu ihren Artikeln.
   - **Sektion `03` – Source-eigener Bestand (`corpus-metrics`)**: 4 Kacheln (Anzahl der API- und Agent-Tool-Artikel, „6 Stufen“, Anzahl validierter Help-Identitäten, `DE / EN` mit Anker-Parität); drei davon führen zum Finder und zu den Listen.
3. **Bereichs-, Browse- und Suchansicht (in `App.tsx`)**: Die Bereichsansicht listet einen Systembereich mit seinen Artikelkarten; `browse` listet alle Inhalte (Filter nach `owner` und `type`, z.B. die Workflows); `search` zeigt passende Bereiche und Artikel.
4. **API-Finder (in `App.tsx`)**:
   - Zwei Tabs (`API & Tools`, `Architektur-Pakete`), Anbieter-Chips, eine Textabfrage und die vier Facetten-Dropdowns aus §3.5; die Trefferliste zeigt die passenden API-Artikel mit Anbieter und Idempotenzmodell.
5. **Artikelansicht (in `App.tsx`)**:
   - Rendert das Markdown eines Artikels (`client/lib/markdown.ts`: Tabellen, Codeblöcke, stabile `{#anchor}`-Überschriften) mit Breadcrumbs, Meta-Pillen, verwandten Artikeln und einer Fußzeile mit Help-ID, Wortzahl, Sprache und Quell-Commit (`repository@commit`, gegebenenfalls `+dirty`); die rechte Spalte `AUF DIESER SEITE` zeigt das Inhaltsverzeichnis und den Hinweis „Help ≠ Live State“.
6. **`client/components/SpaceChatWorkbench.tsx` (das interaktive Multiplayer-Beispiel, im Live-Rahmen mit der `SystemBar` darunter)**:
   - Eine **Stufenleiste `v1` bis `v6`** (Vorgabe `v2`) mit Link auf den Artikel der Stufe und einer Schaltfläche, die die Stufe auf dem Server ausführt und prüft (`POST /api/chat/stages/<stage>/run`) und den JSON-Bericht zeigt.
   - **Links (Multiplayer-Chat)**: Teilnehmerauswahl (`alice`, `bob`, ...), Thread-Liste und Thread-Anlage (`RequestRef`), Nachrichtenformular (`write` + `ChatTask`), Nachrichtenliste mit Rolle und Autor, Alarmformular (`ScheduledJob` mit `TimerLock`) und die Liste der geplanten Alarme.
   - **Rechts (Live-`phi-spaces`-Inspector, `readPage` + `changes`)**: aktuelle Space-Revision, die installierten Completion-Profile (`ChatTask`→`Msg`, `SearchTask`→`SearchResult`), `Presence`-Leases (30 s TTL), geplante Alarme und die Subagent-Spur.
   - Die Daten kommen über den WebSocket `/ws/chat/<session>` (`client/lib/chat-connection.ts`, mit Polling als Rückfall); Aktionen gehen mit jeweils neuer `requestId` an `/api/chat/sessions/<session>/action`.
7. **Weitere Komponenten**: `SocialFeedView.tsx` (der Social-Swarm-Feed), `AppIntro.tsx` (die kurze Einführung vor jeder App: Swarm, Codemode, Space-Chat, MMO, Statistik), `AdminSpacesView.tsx` (§6.3), `LlmModelPicker.tsx` und `LlmAllowedModels.tsx` (Modellwahl und ihre Freigabeliste), `SystemBar.tsx` (Hosts und Eintragsgrenzen unter den Live-Ansichten).

### 6.3 Geschützter Web-Admin-Bereich (`AdminSpaces`) & Produktiv-Deployment unter `https://spaces.eibrain.org`

Die Webseite unter **`https://spaces.eibrain.org`** bietet neben dem öffentlichen Hilfesystem und der Multiplayer-Chat-Demo einen **login-geschützten Bereich `AdminSpaces` (`?view=admin` bzw. `/admin`)**, über den sich sämtliche Spaces, Läufe, Worker, Deployments und Schlüssel **genauso wie in der mobilen App (`spaces.html` + `steuerung.html`)** steuern und überwachen lassen.

Dabei wird der Vertrag für das HTTPS-Browser-Gateway aus `docs/federation-plan-v3.en.md` (§3) und `docs/betrieb-und-mobile-steuerung.en.md` (§2, §3: *„Optionales HTTPS-Gateway: Anmeldung je Benutzer“*) exakt umgesetzt:

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
               │ http://127.0.0.1:3500                 │
               ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Node.js Host (help-site/server/index.ts + phi-spaces Runtime)             │
│  ├─ Help-Server (/help/index.json, /help/articles/*, React UI)           │
│  ├─ Browser-Chat-Gateway (/api/chat/*, /ws/chat/:sessionId)              │
│  ├─ Web-Admin-Gateway (/api/admin/* -> WebAdminSpaces mit Ed25519-Signer)│
│  ├─ space-gate (auf NetBird-Overlay-IP / lokalem Socket)                 │
│  └─ Control Space, Supervisor, Router & Session-Data-Spaces (SQLite)     │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 1. Login & Authentifizierung für den `AdminSpaces`-Bereich (`server/admin/admin-controller.ts`)

- **Zweistufiges Sicherheitsmodell für das Web-Gateway**:
  1. **Benutzer-Anmeldung am Webserver (`POST /api/admin/login`)**:
     - Login über Admin-Benutzername + Passwort (gehasht mit `node:crypto.scryptSync` und verglichen mit `timingSafeEqual`) **oder** Erstkopplung per einmaligem Enrollment-Token (`enrollQr` / Bootstrap-Token).
     - Nach erfolgreichem Login setzt der Server ein signiertes `HttpOnly; Secure; SameSite=Strict`-Session-Cookie plus ein `X-CSRF-Token` für alle schreibenden `/api/admin/*`-Aufrufe.
     - Strikte Rate-Limits pro IP (Schutz gegen Brute-Force) und sofortige Session-Invalidierung bei `POST /api/admin/logout`.
  2. **Kryptografische Bindung an den `CONTROL_SPACE` (`server/admin/admin-controller.ts`)**:
     - Das Web-Gateway führt keine direkten, unautorisierten DB-Schreibzugriffe aus, sondern nutzt exakt dieselbe Architektur wie `MobileSpaces` in `pi-termux-mobile/runtime/spaces-mobile.mjs`:
     - Das Gateway verwaltet ein privates Admin-Profil (`0600`) mit einem eigenen `Ed25519`-/`P-256`-Schlüssel (`provisionFileSigner` / `loadFileSigner` aus `src/keys.ts`), authentifiziert sich per Schicht-B-Challenge (`remote.authenticate()`) am `space-gate`, bezieht vor Operationen kurzlebige 60-Sekunden-Grants (`requestGrant()`) und sendet Admin-Befehle als `Command`-Entries in den `CONTROL_SPACE`.

#### 2. Funktionsumfang im `AdminSpaces`-Webbereich (`client/components/AdminSpacesView.tsx`)

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
- `help-site/deploy/phi-spaces-help.service` (systemd-Unit für den dauerhaften Betrieb auf dem Server).

---

## 7. Vollständiger Artikel- und Inhaltskatalog (`help-site/corpus/`)

Jeder der folgenden Artikel existiert sowohl auf **Deutsch (`corpus/de/...`)** als auch auf **Englisch (`corpus/en/...`)** mit gleichen IDs und Ankern; die ID ist `help.<Art>.<Dateiname>` (`help.topic.*`, `help.workflow.*`, `help.api.*`). Der Katalog `corpus/help_product_catalog.json` ordnet sie den Bereichen aus §3.3 zu; `corpus/api_facts.json` hält die geprüften API-Fakten. Die Beschreibung ist die `short`-Zeile des deutschen Artikels.

### 7.1 Konzept- und Architekturthemen (`topics/`)

1. `help.topic.agent_tools_and_replay` – **Die 8 LLM-Agent-Tools und Replay-Sicherheit**: Wie KI-Agenten über space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify und space_lease sicher koordinieren.
2. `help.topic.apps` – **Apps auf phi-spaces**: Die fünf Anwendungen im Überblick: Agenten-Schwarm, Codemode-Chat, Multiplayer Space-Chat, das Rollenspiel spaces-mmo und die Space-Statistik.
3. `help.topic.architecture_layers` – **Schichtenarchitektur und Modul-Landkarte**: Zuordnung der wichtigsten Quellmodule in src/ zu den 6 Architekturschichten, von der reinen Zustandsmaschine über den eigenen Speicher bis zu Federation, RunGate und Replikation.
4. `help.topic.async_interaction` – **Asynchronität, Waiter und Agent-Turns**: Aufrufe an einen Space liefern ein Promise, dein Programm kann also währenddessen anderes tun. Manche Aufrufe warten auf einen Eintrag, andere melden sich später von selbst. Diese Anleitung erklärt, worauf ein Aufruf wartet und welchen Weg du wann nimmst.
5. `help.topic.comparison_earendil_vs_phi_spaces` – **Konzeptvergleich: Earendil Multiplayer Chat vs. phi-spaces (v1 bis v6)**: Vergleich des Cloudflare-Durable-Object-Ansatzes und von pi-durable 1.4.0 mit dem Tuple-Space-Modell von phi-spaces, samt Vor- und Nachteilen von In-Memory (v1) bis Federated Space (v5/v6).
6. `help.topic.completion_profiles_and_limits` – **CompletionProfiles und Ressourcen-Limits**: Serverseitige Ergebnisprüfung beim Commit von Take-Transaktionen (CompletionProfile) sowie die festen Byte- und Owner-Quoten (DEFAULT_LIMITS).
7. `help.topic.durable_mailboxes_and_ack` – **Dauerhafte Mailboxes (events / ack), wait und notify**: Wie nichtblockierendes wait und notify Ereignisse in persistente Consumer-Mailboxes zustellen und was Präfix-ACK von einem Transaktions-Commit unterscheidet.
8. `help.topic.entries_and_templates` – **Entries, Subtypen und Template-Matching**: Aufbau von Entries ({type, types?, fields}), globale Identitäten (gid), hierarchische Subtypen und exakte Wildcard-Regeln beim Template-Matching.
9. `help.topic.examples` – **Beispiele: Was es gibt und wie man sie startet**: Alle ausführbaren Beispiele auf einen Blick: was sie zeigen, wie man sie startet und welche echte Modelle brauchen und Tokens kosten.
10. `help.topic.failure_playbook` – **Fehlerdiagnose und sichere nächste Schritte**: Wenn ein Aufruf scheitert, ist nicht immer klar, ob er gewirkt hat. Diese Anleitung zeigt für jeden Fehler den sicheren nächsten Schritt. Die wichtigste Regel: Unklar heißt nicht fehlgeschlagen. Wiederhole also mit derselben Request-ID, nie mit einer neuen.
11. `help.topic.federation_router_and_membership` – **Federation, Router, HRW-Sharding und Membership**: Wie createFederationController mehrere Member-Spaces über HRW-Routing, signierte Delegationen und journalisierte Waiter-Wettläufe zu einem Cluster verbindet.
12. `help.topic.first_running_space` – **Erster vollständiger Space: Aufgabe bis Ergebnis**: Dieses Beispiel zeigt den ganzen Weg einer Aufgabe in einem Space: schreiben, ansehen, übernehmen und mit einem Ergebnis abschließen. Du brauchst dafür kein Modell, keine Zugangsdaten und keinen Server. Es reichen Node und die vorhandenen Abhängigkeiten des Repositorys.
13. `help.topic.gate_auth_grants_and_recovery` – **Overlay-Gate, Schicht-A/B-Auth, 60s-Grants und Recovery**: Zwei-Schichten-Authentisierung (NetBird-Peer + Ed25519/P-256 Challenge), Token/QR-Enrollment, kurzlebige 60-Sekunden-Grants, Schlüsselrotation, Boot-Guard und Restore.
14. `help.topic.guarantees_and_boundaries` – **Verbindliche Garantien und Systemgrenzen**: Was phi-spaces bei lokalen Commits, Retries, Transaktionen, Restores und in der Federation verbindlich garantiert – und was bewusst ausgeschlossen ist.
15. `help.topic.leases_and_transactions` – **Leases, Transaktionen und Sichtbarkeit**: Wie Leases selbstheilende Zustände ermöglichen und wie Transaktionen (createTransaction, commit, abort) Writes und Takes atomar isolieren.
16. `help.topic.live_sync_recipe` – **Live-UI: Snapshot, Changes und Wiederaufbau**: Eine Oberfläche soll den Inhalt eines Space zeigen und aktuell bleiben. Dazu lädt sie erst den vollständigen Stand und wendet danach jede Änderung an. Erst wenn alles geladen ist, zeigt sie das Ergebnis, damit nie eine halbe Liste erscheint.
17. `help.topic.local_client_and_named_spaces` – **Lokaler Client PhiSpaces, benannte Spaces und startService**: Wie PhiSpaces auf dem Default-Space oder benannten Spaces (NamedSpace) arbeitet und wie startService Reaper und Event-Delivery betreibt.
18. `help.topic.operations_mobile_and_replication` – **Betriebserweiterung (RunGate, Worker, Mobile/Web-Admin) & Phase-3-Replikation**: Wie Läufe über RunGate-Barrieren, Worker über signierte Zuweisungen und Spaces über die Mobile App (pi-termux-mobile) sowie den Web-Admin-Bereich (AdminSpaces) gesteuert werden.
19. `help.topic.overview` – **phi-spaces Systemüberblick: Was es ist und was es kann**: Einstieg in phi-spaces: was es ist, wie das transaktionale Tuple-Space-Modell funktioniert, welche Probleme es löst und was es vom Einzelprozess bis zum föderierten Verbund mit Mobile- und Web-Administration kann.
20. `help.topic.request_claims_and_generations` – **Request-Claims, Generationen und Idempotenz**: Wie phi-spaces über {principal, generation, requestId} und kanonische RFC-8785-Hashes doppelte Mutationen nach Verbindungsabbruch oder Neustart verhindert.
21. `help.topic.safe_operations` – **Sicher starten, Modelle begrenzen, Daten sichern**: Diese Anleitung sagt, wie du die Hilfeseite sicher startest, Modellkosten begrenzt und Daten sicherst. Anmeldung im Web, Kopplung von Geräten und Berechtigungen im Netz sind dabei drei getrennte Dinge. phi-spaces ist experimentell, also prüfe es selbst, bevor wichtige Daten davon abhängen.
22. `help.topic.snapshots_and_change_streams` – **Snapshot-Seiten (readPage) und Revisionsströme (changes)**: Wie Clients mit readPage konsistente, bytebegrenzte Snapshots lesen und über changes(afterRev) lückenlos nachfolgende Commits streamen.
23. `help.topic.social_swarm_pipeline` – **Social Swarm: Datenfluss, Batches und Shards**: Social Swarm ist eine Demo der Hilfeseite: Viele simulierte Figuren schreiben Beiträge in einen gemeinsamen Feed. Sie zeigt, wie man viele kleine Aufgaben gebündelt und damit günstig verarbeitet. Diese Anleitung erklärt den Datenfluss und was bei Ausfall eines Teils passiert.
24. `help.topic.space_service_and_remote_space` – **SpaceService, RemoteSpace und Netzwerk-Transporte**: Wie SpaceService Rollen-Policies erzwingt, wie der eigenständige Dienst läuft und wie RemoteSpace über In-Process, Unix-Socket, TCP oder pi-serverd mit stabilen Retries kommuniziert.
25. `help.topic.task_lifecycle` – **Task-Lebenszyklus und sichere Wiederholung**: Eine Aufgabe ist ein Eintrag im Space. Ein Worker übernimmt sie, arbeitet und schließt sie zusammen mit dem Ergebnis ab. Diese Anleitung zeigt diesen Weg und was bei Fehlern passiert, damit nichts verloren geht oder doppelt läuft.
26. `help.topic.topology_and_readiness` – **Topologien, API-Grenzen und Abnahmestand**: Ein laufendes Beispiel zeigt einen Ablauf, aber noch keinen ausfallsicheren Betrieb. Diese Anleitung sagt für jede Stufe, was sie wirklich prüft und was nicht. So siehst du, was du für deinen Einsatz selbst nachweisen musst.

### 7.2 Praxis-Workflows und 6-Stufen-Anleitungen (`workflows/`)

27. `help.workflow.overview_v1_to_v6` – **Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)**: Wie ein Mehrbenutzer-Chat mit phi-spaces entsteht: sechs lauffähige Stufen vom Programm im Arbeitsspeicher bis zum Betrieb über Handy und Web.
28. `help.workflow.stage_v1_local_memory` – **Stufe 1 (v1-local-memory): Lokaler Sofortstart ohne Setup**: Die einfachste lauffähige Version des Chats im Arbeitsspeicher: Threads, Abzweigungen, Anwesenheit und Antworten in einer Transaktion.
29. `help.workflow.stage_v2_local_durable` – **Stufe 2 (v2-local-durable): SQLite-Persistenz, Alarme & Subagent**: Erweitert Stufe 1 um Speicherung in einer SQLite-Datei, wiederholsichere Aufrufe, geplante Alarme und eine Suche über alle Threads.
30. `help.workflow.stage_v3_remote_socket` – **Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace über Socket/TCP**: Trennt Speicher, Gateway, Chat-Worker und Search-Subagent: Ein Dienst stellt den Space über Socket oder TCP bereit, alle anderen sind Clients.
31. `help.workflow.stage_v4_gated_auth` – **Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B, Enrollment & 60s-Grants**: Sichert den Multiplayer Space-Chat mit startFederationHost, kryptografischer Verbindungs-Challenge (Ed25519), Token-Enrollment, 60-Sekunden-Grants und Boot-Guard ab.
32. `help.workflow.stage_v5_federated_cluster` – **Stufe 5 (v5-federated-cluster): Föderierte Spaces, HRW-Sharding & Router**: Verteilt Threads per Router auf 3 Member-Spaces: HRW-Platzierung je threadId, clusterweites Lesen und LWW-Presence, simuliert in einem Prozess.
33. `help.workflow.stage_v6_mobile_control` – **Stufe 6 (v6-mobile-control): Steuerung über Mobile App & Web-Admin (spaces.eibrain.org)**: Komplette Administration und Überwachung des Space-Clusters über die Android-App (pi-termux-mobile) und den login-geschützten Web-Bereich AdminSpaces.

### 7.3 Strukturierte API-Einträge (`api/`)

34. `help.api.agent_tools` – **Agent-Tools (spaces) & startService – Replay-sichere LLM-Werkzeuge**: Stellt KI-Agenten 8 replay-sichere Tools mit Request-Identität pro Aufruf und Ownership-Schutz bereit; startService betreibt Reaper und Zustellung.
35. `help.api.federation_controller` – **createFederationController & FederatedSpace – Router, HRW-Sharding & Membership**: Verbindet Router-Journal-Partitionen, signierte RouterLease, Original-Principal-Delegation, HRW-Policy, Waiter-Wettlauf und Membership-Lifecycle.
36. `help.api.gate_auth_grants` – **Gate, Schicht A/B, Enrollment, 60s-Grants & Rotation**: Kombiniert NetBird-Peer-Auflösung (Schicht A), Ed25519/P-256-Challenge (Schicht B), QR/Token-Enrollment, 60-s-Grants und atomare Schlüsselrotation.
37. `help.api.operations_runs_workers` – **RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Betriebserweiterung (B2–B10)**: Steuert Läufe über RunGate-ACK-Barrieren, weist Hosts signierte Worker-Listen zu, verwaltet Space-Lebenszyklen und Deployments und speist AdminSpaces und die mobile Steuerung.
38. `help.api.phispaces_claims` – **Request-Claims & Generationen – Neustartfeste Idempotenz**: Bindet Mutationen und blockierende Operationen atomar an {principal, generation, requestId} und einen kanonischen RFC-8785-Argument-Hash.
39. `help.api.phispaces_completion_profiles` – **setCompletionProfiles & setLimits – Serverseitige Ergebnis- und Budgetverträge**: Erzwingt vor dem Commit einer Take-Transaktion den erwarteten Ergebnistyp, korrelierende Felder (equalFields) und Anzahl; verwaltet Byte-Limits.
40. `help.api.phispaces_lease` – **Leases – renew & cancel**: Verlängert oder beendet die Lebensdauer eigener Entries, Transaktionen, Notify-Abos und Waiter (Grundlage für Presence & Heartbeats).
41. `help.api.phispaces_read` – **read & readIfExists – Entry zerstörungsfrei lesen**: Sucht einen passenden sichtbaren Entry anhand eines Templates (fehlende/null-Felder sind Wildcards) und wartet bis zum Timeout.
42. `help.api.phispaces_read_page_changes` – **readPage & changes – Konsistente Snapshots und Revisionsströme**: Liest bytebegrenzte Seiten eines unveränderlichen Snapshots (mit token und rev) und holt nachfolgende Commit-Batches über changes(afterRev) auf.
43. `help.api.phispaces_take` – **take & takeIfExists – Entry exklusiv entnehmen oder reservieren**: Entfernt einen passenden Entry sofort destruktiv oder reserviert ihn exklusiv unter einer Transaktion (Rückkehr bei Abort/Lease-Ablauf).
44. `help.api.phispaces_txn` – **Transaktionen – createTransaction, commit & abort**: Bündelt Takes (Reservierungen) und Writes (unsichtbare Entwürfe) atomar; prüft beim Commit alle CompletionProfiles und Byte-Budgets.
45. `help.api.phispaces_wait_notify_mailbox` – **wait, notify, events & ack – Reaktive Zustellung und Consumer-Mailboxes**: Parkt langlebige Read/Take-Wünsche oder Event-Abos ohne Turn-Blockade; liefert Ergebnisse über dauerhafte Mailboxes mit Präfix-ACK.
46. `help.api.phispaces_write` – **write – Entry schreiben**: Legt einen neuen typisierten Entry mit Lebensdauer an; unterstützt Request-Replay, atomare Singleton-Anlage per unique und transiente Ausgaben.
47. `help.api.space_service_and_remote` – **SpaceService, serveSpace & RemoteSpace – Netzwerk-RPC über Socket & TCP**: Veröffentlicht Spaces über Unix-Socket oder TCP, auch als eigenständiger Dienst oder über pi-serverd, mit Rollen-Policy, und bedient RemoteSpace-Clients mit stabiler Retry-Identität.

---

## 8. Technische Randbedingungen und Einhaltung von `AGENTS.md`

Gemäß `/media/data/programming/phi-spaces/AGENTS.md` gelten folgende Regeln verbindlich:

1. **Keine ungefragten neuen npm-Abhängigkeiten**:
   - In `phi-spaces` sind `esbuild` (`^0.25.0`), TypeScript (`^7.0.2`) und `@types/node` bereits installiert (pi-durable, pi-ai und chord nur im `agent/`-Paket).
   - **Für das Backend (`help-site/server/`)** werden **keinerlei neue Abhängigkeiten** benötigt:
     - HTTP-Server und statische Auslieferung nutzen `node:http`, `node:fs/promises` und `node:path` (wie `src/dashboard.ts`).
     - Der WebSocket-Server nutzt einen kompakten, standardkonformen RFC-6455-Upgrade-Handler auf Basis von `node:http` und `node:crypto` (ohne externes `ws`-Paket!).
     - Die Persistenz nutzt den phi-spaces-Store (SQLite oder Speicher) über die lokale Bibliothek `phi-spaces` (`file:..`).
   - **Für das React-Frontend (`help-site/client/`)** gab es zwei Wege (umgesetzt wurde Option B: `help-site/package.json` führt `next` 16, `react` 19 und `react-dom` 19; das Frontend baut mit Next.js, `app/`, und `scripts/build-web.ts`):
     - **Option A (Zero-Install, sofort ohne `npm install` lauffähig)**: Ein leichtgewichtiges JSX-Runtime-Shim in `help-site/client/lib/react-shim.ts` (oder lokales Vendor-Bundle), das mit `esbuild` (`--jsx=automatic`) zu einem einzigen schnellen Browser-Bundle kompiliert wird – komplett ohne Netz-Download oder Änderung an `package.json`.
     - **Option B (Mit Freigabe)**: Installation von `react` und `react-dom` nach ausdrücklicher Freigabe durch den Benutzer.
     - *Empfehlung im Plan*: Die Komponenten in `help-site/client/` werden in sauberem, standardkonformem `.tsx` (mit Hooks `useState`, `useEffect`, `useMemo`, `useRef`) geschrieben, sodass sie sowohl mit dem Zero-Install-Runtime-Shim über `esbuild` sofort ohne Installation bauen als auch jederzeit 1:1 mit `react`/`react-dom` laufen.
2. **Bestehende Suite bleibt unberührt und grün**:
   - `tsconfig.json` im Hauptverzeichnis wird nicht gebrochen; `npm run typecheck` und `npm test` laufen nach jedem Schritt.

---

## 9. Umsetzungsphasen (Arbeitspakete)

### Phase 1: Kanonischer Help-Corpus & Index-Generator (`help-site/corpus/` & `help-site/scripts/build-corpus.ts`)

1. Anlegen von `help-site/corpus/help_product_catalog.json` mit den 9 Systembereichen.
2. Erstellen der zweisprachigen Artikel (`de` und `en`) für Architektur, Konzepte, Garantien/Grenzen, die 7-stufige Schritt-für-Schritt-Anleitung, die 3 Multiplayer-Chat-Dokumentationskapitel und die 14 API-Referenzeinträge.
3. Implementieren von `help-site/scripts/build-corpus.ts`:
   - Prüft Frontmatter, `{#anchor}`-Parität zwischen `de` und `en`, interne `help.*`-Links und Vollständigkeit des Katalogs.
   - Generiert `help-site/dist/public/help/index.json` (inkl. Inhaltsverzeichnis `toc`, Wortanzahl, Suchtext, API-Facetten und Git-Commit-Provenienz).

### Phase 2: Die 6 ausführbaren Ausbaustufen des Multiplayer Space-Chats (`help-site/examples/v1..v6` & `help-site/server/space-chat/`)

1. **`examples/shared/`**: Gemeinsame Entry-Schemata (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `TimerLock`, `SearchTask`, `SubagentStep`, `SearchResult`), die zwei `CompletionProfiles` und der deterministische Scripted-Agent.
2. **`examples/v1-local-memory/`**: Zero-Setup In-Memory-Version (`MemoryStorage` + `PhiSpaces`), direkt per CLI oder im Browser startbar.
3. **`examples/v2-local-durable/`**: Persistente SQLite-Version mit `issueGeneration` / `RequestRef`-Claims, `readPage`/`changes`, `SpaceAlarmScheduler` (`TimerLock`-Lease-Ablauf) und `search_history`-Subagent.
4. **`examples/v3-remote-socket/`**: Client/Server-Version mit `SpaceService` (`serveSpace` über Unix-Socket/TCP), getrennten `RemoteSpace`-Clients für Web-Gateway, Chat-Worker und Subagent sowie Consumer-Mailbox-Steuerung (`wait` + `events` + `ack`).
5. **`examples/v4-gated-auth/`**: Gesicherte Version mit `startGate` (Schicht A Peer-Rollen + Schicht B Ed25519/P-256 Challenge), Token-Enrollment im `CONTROL_SPACE`, 60-Sekunden-Grants (`GrantAuthority`/`GrantVerifier`), Live-Schlüsselrotation und `SqliteRecoveryRegister` + `installBootGuard`.
6. **`examples/v5-federated-cluster/`**: Cluster-Version mit `RouterController` (`router-root` + 2 Partition-Router), `FederatedSpace` (4 Hosts im Arbeitsspeicher: Koordinator + 3 Member-Spaces, HRW-Routing nach `threadId`, clusterweites `readAll`) und der Phase-3-LWW-Presence-Vorschau (`EntryReplicationController`).
7. **`examples/v6-mobile-control/`**: Mobile-Steuerungs- und Überwachungs-Version für `pi-termux-mobile` (`spaces.html` & `steuerung.html`): QR-Enrollment (`enrollQr`), Live-Objektansicht (`objects`), Worker-Skalierung (`setWorkers` / `WorkerSupervisor`), `RunController`/`RunGate`-Pause/Resume/Schedule, Space-Lebenszyklus (`createSpace`/`archiveSpace`), Alerts (`collectAlerts`) und Audit-Log (`auditLog`).
8. **`server/space-chat/stage-runner.ts` & `deploy/`**: Einheitlicher Orchestrator für die Web-Workbench (`v1`–`v6`) sowie Reverse-Proxy- und systemd-Konfiguration für `https://spaces.eibrain.org`.

### Phase 3: Node.js HTTP/WebSocket-Server & React-UI (`help-site/server/` & `help-site/client/`)

1. **`help-site/server/index.ts`**: Node.js-Server mit Help-API (`/help/index.json`, `/help/articles/...`), Space-Chat-REST-API (`/api/chat/...`), RFC-6455-WebSocket-Server (`/ws/chat/:sessionId`) für Live-`readPage`-Snapshots und `changes(afterRev)`-Broadcasts.
2. **`help-site/client/`**:
   - High-End-Styling (Topbar, 14 Farbpaletten, Dark/Light, DE/EN, 3-Spalten-Workspace, 2-Lane-Systemmodell, 9 Systemkarten, Corpus-Metrics, API- & Tool-Finder, Markdown-Renderer mit `#anchor`-Support und rechter TOC-Spalte).
   - Integrierte **`SpaceChatWorkbench`**: Multiplayer-Chat-Oberfläche (Threads, Forking, Teilnehmer-Umschalter/Mehr-Tab-Synchronisation, Countdown für geplante Alarme, Subagent-Trace-Viewer) kombiniert mit dem **Live `phi-spaces` Inspector** (Echtzeit-Anzeige von `rev`, Entries, Leases, Transaktionen und Claims).

### Phase 4: Verifikation und Tests (`help-site/tests/`)

Umgesetzt sind `tests/help-consistency.test.ts`, `tests/help-site.test.ts`, `tests/regressions.test.ts` und weitere (`npm --prefix help-site test`); die folgenden Namen sind der ursprüngliche Plan.

1. **`corpus.test.ts`**: Prüft Schema, DE/EN-Parität, stabile Anker und Suchfunktion (inkl. Kurz-Tokens wie `tx`, `gid`, `ack`, `hrw`).
2. **`chat-session.test.ts`**: Automatisierter End-to-End-Test des gesamten Earendil-Demo-Ablaufs auf `phi-spaces`:
   - Idempotentes Thread-Create & Fork bei wiederholter `requestId`.
   - Multiplayer-Nachrichten von `alice` und `bob` mit `CompletionProfile`-Prüfung.
   - `Presence`-Lease-Erneuerung und automatischer Ablauf nach Timeout.
   - Geplante Aufgabe (`TimerLock`-Lease läuft ab $\rightarrow$ Wakeup-`ChatTask` erzeugt Alarm-`Msg`, auch über Reopen eines persistenten Stores hinweg).
   - `search_history`-Subagent findet die `"PostgreSQL"`-Entscheidung aus Thread 1, schreibt `SubagentStep`-Entries und committet `SearchResult` für Thread 2.
3. **`server-http.test.ts`**: Prüft die HTTP-Routen, den WebSocket-Handshake/Live-Stream und das gebaute Frontend-Bundle.
4. Abschließender Lauf von `npm run typecheck` und `npm test` im Hauptprojekt.
