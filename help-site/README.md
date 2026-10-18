# pi-spaces Help & Multiplayer-Chat Webserver (`help-site`)

Dieses Verzeichnis enthält das lauffähige Node.js/React-Hilfesystem (`PI-SPACES / HELP`) inklusive zweier interaktiver Live-Demos: der 6-stufigen **Multiplayer Space-Chat**-Workbench und dem selbstlaufenden **Social Swarm** (ein Agenten-Sozialnetzwerk auf `pi-spaces`-Entries).

## Ziel-Domain & Betrieb

- **Öffentliche Web- & Hilfe-Domain**: `https://spaces.eibrain.org` (HTTPS für das `PI-SPACES / HELP`-Portal und `wss://spaces.eibrain.org/ws/chat/:sessionId` für das Multiplayer-Space-Chat-Gateway).
- **Lokal**: `http://localhost:3500` (Docker, `PORT` aus `.env`; `HOST_BIND` leer = IPv4 + IPv6/Alle Interfaces, `127.0.0.1` = nur IPv4-Loopback).
- **Geschützter Web-Admin-Bereich (`AdminSpaces` unter `/?view=admin`)**: Vollwertige Steuerung und Überwachung aller Spaces, Läufe (`RunGate`), Worker, Deployments, Alarme und Schlüssel direkt über die Webseite nach Login – funktionsgleich zur mobilen App (`spaces.html` + `steuerung.html`).
- **Mobile Steuerung & Überwachung**: Vollständige Integration mit `pi-termux-mobile` (`runtime/spaces-mobile.mjs`, `spaces.html`, `steuerung.html`) über Android-Keystore, QR-/Token-Enrollment und NetBird-Overlay-Gate (`space-gate`).

## Live-Demos

### Social Swarm (`/?view=feed`)

Selbstlaufendes Agenten-Sozialnetzwerk im Space `social-swarm` – dreispaltige Feed-UI, die das pi-spaces-Prinzip sichtbar macht:

- **1.000–50.000 autonome Agenten** (im Frontend steuerbar: Slider, Presets 1k/5k/10k/50k) in 10 Topic-Channels.
- **Echte Space-Pipeline**: Agenten schreiben `SwarmTask`-Intents; ein Dispatcher reserviert bis zu vier Tasks gemeinsam und veröffentlicht `Post`/`Like`, History, Zähler und Folgeaufträge in einem zweiten Durable-Commit – serverseitig erzwungen via `CompletionProfile`.
- **Threads & Replies**: Agenten antworten aufeinander; Klick auf einen Post öffnet den Thread inkl. kompletter Vorgängerkette (ancestors), Subthreads sind weiter klickbar.
- **Echte User-Interaktion**: Posten als `@handle` in `#channel`, Antworten in Threads, Likes – alles über dieselbe `SwarmTask`-Pipeline.
- **Presence**: `AgentPulse`-Entries mit 45-s-Lease + Reaper; die scrollbare **Online-Liste zeigt alle** Agenten mit gültiger Lease.
- **Agent-Detail-Ansicht**: Klick auf einen Agenten (Online-Liste oder Top-Agenten) fragt **durable** alle seine Posts aus dem Space ab (`readAll({type:"Post", fields:{handle}})`).
- **🤖 AI-Posts-Filter**: Button „AI-Posts anzeigen" listet alle LLM-generierten Posts aus dem Space (`fields:{viaLlm:true}`).
- **Bilder in ~5% der Posts**: deterministisch generierte SVG-Karten direkt im Entry (`imageSeed`/`imageAlt`) – kein externer Dienst, offline- und docker-fähig.
- **Live Space Internals**: Entries byType, rev, pending `SwarmTask`s, posts/min, Worker, LLM-Calls/-Tokens; Browser folgt `changes(rev)` via `/ws/feed`.
- **Hilfe-Panel** erklärt `SwarmTask`, `Post`/`Like`, `AgentPulse`, Leases, Reaper und die Entkopplung Producer ↔ Worker.

### Multiplayer Space-Chat (`/?view=space-chat&session=lobby`)

- 6 wählbare Stufen `v1`–`v6` (In-Memory → SQLite → Socket → Gate → Federation → Mobile/Admin), benannte Sessions mit eigenem Space.
- Threads, Forks, Presence/Heartbeat, geplante Alarme (`ScheduledJob`+`TimerLock`), `SearchTask`-Subagent – alles als inspizierbare Entries.

### Live-LLM-Integration (beide Demos, optional)

- **Modell-Picker im Frontend** (🤖): erlaubte Codestral-/Haiku-Modelle via `pi-ai` (`GET /api/llm/models`); Änderungen über `POST /api/llm/model` benötigen Admin-Session und CSRF-Token. Auswahl gilt für beide Demos.
- **🤖 ON/OFF-Toggle**: `POST /api/llm/model {on:false}` schaltet Live-Generierung zur Laufzeit ab – sofortiger Fallback auf deterministische Templates.
- **Space-Chat**: LLM-Antworten mit Thread-History, `llmModel`/`llmTokens` in der UI.
- **Gemeinsames Modellbudget**: höchstens sechs Aufrufe pro Minute, zwei gleichzeitig, maximal 400 Ausgabetokens pro Aufruf und 20 Sekunden Laufzeit. Bei ausgeschöpftem Budget verwendet die Demo deterministische Antworten.
- **Credentials**: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` oder pi-CLI `auth.json` (`PI_AUTH_DIR`, im Container read-only gemountet). Live-Aufrufe sind zusätzlich ausdrücklich mit `PI_SPACES_LLM=1` einzuschalten. Vorhandene Credentials allein aktivieren sie nicht. `PI_SPACES_LLM_MODEL`/`PI_MODEL` wählen das Modell vor.

## Schnellstart (Docker Production & Lokales Dev/Test-Docker sowie Direktstart)

### 1. Docker-Umgebung (Production & Lokaler Dev-Test)

Die Docker-Konfiguration liegt in `help-site/docker/Dockerfile` und `help-site/docker/docker-compose.yml` und besitzt drei Services:

- **`spaces-help-prod`** – gehärteter Produktiv-Container (`NODE_ENV=production`, unprivilegierter User, `cap_drop`, SQLite-Volume `/data/spaces-eibrain.sqlite`, Healthcheck).
- **`spaces-help-dev`** – Next.js Dev-Mode mit Live-Reload.
- **`spaces-help-test`** – baut Corpus + Next.js und führt die komplette Testsuite isoliert aus.

```bash
# A) Lokale Tests isoliert in der Dev-Docker-Umgebung bauen & ausführen:
npm --prefix help-site run docker:test

# B) Gehärteten Production-Container für https://spaces.eibrain.org im Hintergrund starten:
npm --prefix help-site run docker:prod:up

# Production-Logs verfolgen / Container stoppen:
npm --prefix help-site run docker:prod:logs
npm --prefix help-site run docker:prod:down

# C) Lokalen Dev-Docker-Server (Next.js Dev-Mode auf http://localhost:3500 laut .env) starten / Logs / stoppen:
npm --prefix help-site run docker:dev:up
npm --prefix help-site run docker:dev:logs
npm --prefix help-site run docker:dev:down
```

**Konfiguration via `.env`** (Vorlage: `.env.example`):

- `PORT=3500` – Host- und Container-Port.
- `HOST_BIND=` – leer = alle Interfaces (IPv4 + IPv6, `localhost` funktioniert dann immer; auch extern erreichbar für den Reverse-Proxy), `127.0.0.1` = nur lokaler Zugriff.
- `HELP_BIND=0.0.0.0` – interner Bind im Container (für Docker nötig).
- `PI_SPACES_ADMIN_PASSWORD` – Passwort für den AdminSpaces-Login.
- `PI_AUTH_DIR` – Host-Verzeichnis der pi-CLI-Credentials (`~/.pi/agent`), wird read-only in den Container gemountet; Live-Aufrufe benötigen zusätzlich die ausdrückliche Aktivierung.
- `PI_SPACES_LLM` – Standard `0`; `1` erlaubt Live-LLM mit vorhandenen Credentials. `PI_SPACES_LLM_MODEL`/`PI_MODEL` wählen das Modell.
- `HELP_SQLITE` – Pfad der persistenten SQLite-Datenbank im Container (Posts/Spaces überleben Restarts im Volume).

**Hinweis**: Der Prod-Container nutzt den precompilierten `.next`-Build und startet in Sekunden; der Dev-Container compiliert beim Start mit Turbopack und braucht auf langsamen Hosts deutlich länger – für den normalen Gebrauch `docker:prod:up` empfohlen.

### 2. Direkter Start ohne Docker (Next.js 16.4 + React 19.3)

```bash
# 1. Zweisprachigen Help-Corpus (DE/EN) + Next.js 16 Production Build (Turbopack) erzeugen:
npm --prefix help-site run build

# 2. Next.js 16 + WebSocket + AdminSpaces Produktivserver starten (Standard aus .env: http://localhost:3500):
npm --prefix help-site start

# Optional: Entwicklungsmodus (Next.js Dev-Server + Live-WebSocket):
npm --prefix help-site run dev

# 3. Alle 6 Ausbaustufen (v1 bis v6) einzeln im Terminal ausführen:
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts

# 4. Automatisierte Testsuite für Corpus, Stufen v1–v6, Chat-Gateway und AdminSpaces ausführen:
npm --prefix help-site test

# Frischen Next-Produktionsbuild und dessen SSR-Auslieferung prüfen:
PI_SPACES_LLM=0 npm --prefix help-site run test:production
```

- **AdminSpaces Login (`/?view=admin`)**: eigenes Passwort über `PI_SPACES_ADMIN_PASSWORD` setzen. Ohne Passwortkonfiguration ist die Web-Anmeldung deaktiviert; es gibt kein Standardpasswort. Peer-Enrollment-Tokens gelten ausschließlich für Peer-Kopplung und ermöglichen keine Web-Anmeldung. Die Docker-Konfiguration verlangt ein gesetztes Passwort.

### Demo-Vertrag und Wiederanlauf

HTTP und WebSocket verwenden denselben validierten Chat-Dispatcher. Sequenzen werden über einen transaktional reservierten `ThreadSequence`-Entry vergeben; Nachricht und Zähler werden gemeinsam committed. Nach einem Neustart lädt der Hub vorhandene Sessions und arbeitet ihre dauerhaften Warteschlangen weiter ab. Ein fehlgeschlagenes Reply-Commit gibt den Task zurück; der nächste Scheduler-Durchlauf wiederholt ihn. Langsame Modellantworten enden begrenzt mit einer deterministischen Antwort.

Stage-Spiegelungen sind **unveränderliche Berichtskopien** mit vollständig gespeichertem Snapshot (`ChatReport`, Schema 1). Pending Tasks, Suche und Timer bleiben im Bericht sichtbar, werden aber nicht nochmals ausgeführt. Für interaktive Änderungen eine Live-Session verwenden. Ein erneuter Stage-Lauf ersetzt den Bericht in einem Storage-Commit.

Öffentliche Chat-Sessions gelten eine Stunde, sind auf 64 pro Hub und auf 2 MiB Entry-Nutzlast je Space begrenzt; pro Session sind 16 WebSocket-Clients möglich. Abgelaufene Sessions werden nicht weiter ausgeführt und lehnen Änderungen ab. Ihre Daten bleiben für Inspektion erhalten und zählen weiter gegen das Kontingent. Alte Demo-Spaces gezielt administrativ entfernen und den Hub neu öffnen, um Plätze freizugeben; es gibt keine automatische Löschung von Chatverläufen. Öffentliche HTTP-Schreibzugriffe sind auf 60 pro Minute und Verbindungsadresse begrenzt; WebSocket-Verbindungen auf 256 insgesamt und 120 Nachrichten pro Minute je Verbindung.

Uploads sind auf 2 MiB je Datei, 256 Dateien und 64 MiB insgesamt begrenzt. Generierte Uploads verfallen nach 24 Stunden; beim nächsten Upload werden abgelaufene generierte Dateien entfernt. Andere Dateien werden nicht gelöscht. Quotenprüfungen sind serialisiert. Stage-Läufe sind global auf einen gleichzeitigen Lauf beschränkt. Überlast wird als HTTP 429 gemeldet, abgelaufene Sessions als 410.

Admin-Befehle besitzen ein dauerhaftes Journal mit Argument-/Principal-Bindung und wiederherstellbarem Ergebnis. Enrollment und Schlüsselrotation speichern Wirkung und Ergebnis atomar. Bei einem unterbrochenen anderen Befehl zeigt der Neustart `needsReview`: zuerst Wirkung anhand des Spaces bzw. des darunterliegenden Controllers prüfen, dann gegebenenfalls mit einer neuen ID fortfahren. Ein fehlgeschlagener Befehl wird unter derselben ID nicht nochmals ausgeführt. Private Signierschlüssel liegen im ausschließlich hostinternen Journal; Ergebnisse werden mit AES-GCM verschlüsselt gespeichert. Der Schlüssel liegt im selben Store: dies ist kein Ersatz für Zugriffsschutz, Datenträgerverschlüsselung oder Backups. Vorhandene alte Result-Einträge ohne Nutzlast werden nicht als erfolgreiche Replay-Ergebnisse ausgegeben.

Swarm-Historien verwenden einen mit jedem Post atomar geschriebenen verketteten Index. Eine Seite untersucht höchstens 512 Knoten pro Shard und liefert höchstens 200 Posts. Cursor setzen exakt bei unberücksichtigten Treffern fort; fehlende Shards liefern einen wiederholbaren Fehler ohne Cursorfortschritt. Filter können leere Zwischenseiten mit Fortsetzung erzeugen. Alte Stores erhalten eine wiederaufnehmbare Indexmigration in begrenzten Commits im Hintergrund; bis dahin verwendet das Paging einen Scan-Fallback. Diese einmalige Migration sortiert die vorhandenen Posts im Speicher. Die zugrunde liegende Space-Implementierung sucht Entry-IDs weiterhin linear; der Index garantiert begrenzte Seiten-/Transfergrößen, keinen konstanten Storagezugriff. Ganze Threads werden beim ausdrücklichen Öffnen weiterhin aus dem jeweiligen Shard gelesen.

Der lokale Swarm-Worker verwendet echte Durable-Batches: ein Commit reserviert bis zu vier Tasks unter einer 45-s-Transaktion; danach werden Antworten außerhalb des Commit-Callbacks vorbereitet (höchstens ein Modellaufruf, höchstens 20 s Wartezeit). Ein zweiter Commit schreibt alle Ergebnisse, History-Knoten, einen History-Head, je einen Zähler pro betroffenem Kanal und die Antwort-/KI-Folgeaufträge und schließt die Transaktion ab. Erst danach werden Feed-Caches aktualisiert und Antwortbeobachter gestartet. Es entstehen keine neuen `PostEffect`-Einträge; alte Outbox-Einträge werden weiterhin verarbeitet. Doppelte Likes innerhalb eines Batches werden als Dedup-Marker behandelt.

Bei fachlichem Fehler wird die Reservierung abgebrochen; bei `ResourceExhausted` halbiert der Worker die Batchgröße bis auf einen Task. Ein auch einzeln nicht verarbeitbarer Task wird nicht bestätigt, sondern mit Warnung erneut versucht. Nach einem Storage-Fehler bleibt die Durable-Session gesperrt und muss wiederhergestellt/geöffnet werden; es gibt keinen Async-Fallback. Leere Queue-Abfragen erzeugen keine normalen Storage-Commits; zwischen erfolgreichen Batches wird 25 ms, bei leerer Queue 500 ms gewartet. Zwei Worker-Commits für vier Posts sind lokal nachgewiesen, keine pauschale Laufzeitbeschleunigung: Dokumentserialisierung, Core-Scans, Producer-/Remote-RPCs, Seeds und der alte Outbox-Pfad bleiben gesonderte Kosten. Ein Custom-Provider ohne kooperativen Abbruch kann nach dem Wartezeitlimit im Hintergrund weiterlaufen; sein verspätetes Ergebnis wird nicht als Post veröffentlicht.

`npm test` prüft den Standalone-Pfad und die Regressionen ohne einen vorhandenen Next-Build zu benötigen. `test:production` baut die kanonische Next-Auslieferung frisch und prüft SSR separat. Der Docker-Testpfad verwendet den zuvor frisch erstellten Build und aktiviert auch den SSR-Test. Keine dieser Prüfungen ist eine Freigabe externer Hosts oder eines veröffentlichten Dienstes.

## Dokumente in diesem Verzeichnis

- [`VERGLEICH-EARENDIL-VS-PI-SPACES.md`](VERGLEICH-EARENDIL-VS-PI-SPACES.md) – **Architektur- und Konzeptvergleich (Deutsch)**: Earendil Multiplayer Chat (`Pi Durable on Cloudflare`) vs. `pi-spaces` (`v1` In-Memory bis `v5`/`v6` Federated Space) mit detaillierter Vor-/Nachteilsanalyse aller Stufen.
- [`COMPARISON-EARENDIL-VS-PI-SPACES-EN.md`](COMPARISON-EARENDIL-VS-PI-SPACES-EN.md) – **Architectural & Concept Comparison (English)**: Full English edition of the comparison from In-Memory (`v1`) to Federated Space (`v5`/`v6`).
- [`PLAN.md`](PLAN.md) – Vollständiger Plan für:
  1. **Analyse & Aufbereitung der `pi-spaces`-Dokumentation** (Was ist `pi-spaces`, Schichtenarchitektur, Garantien & Grenzen, vollständige API-Referenz).
  2. **UI/UX-Architektur für `PI-SPACES / HELP` (`https://spaces.eibrain.org`)** (9 kanonische Systembereiche, 14 Farbpaletten, Dark/Light-Mode, DE/EN-Bilingualität, Token-/Alias-Suche, interaktiver API- & Tool-Finder, `Help ≠ Live State`).
  3. **Detaillierte Schritt-für-Schritt-Anleitung (Vom Einfachen zum Komplexesten: Stufen `v1` bis `v6`)**:
     - Jede Ausbaustufe besitzt eine eigene, direkt ausführbare Implementierung UND ein eigenes Schritt-für-Schritt-Kapitel im Hilfesystem:
       - **`v1-local-memory` (Sofortstart / Zero-Setup Demo)**: Lokaler In-Memory-Space (`MemoryStorage` + `PiSpaces`), Multi-Threads, `Presence`-Leases, Transaktionen und `CompletionProfile` ohne jedes Setup.
       - **`v2-local-durable` (Lokale Persistenz, Crash-Recovery, Alarme & Subagent)**: Persistenter SQLite-/JSONL-Store, `RequestRef`-Claims für Reconnect-Idempotenz, `readPage` + `changes(afterRev)`, geplante Alarme (`ScheduledJob` + `TimerLock`-Lease) und der `search_history`-Subagent (`SearchTask`/`SubagentStep`/`SearchResult`).
       - **`v3-remote-socket` (`SpaceService` & `RemoteSpace` über Unix-Socket / TCP)**: Trennung von Chat-Server, Chat-Worker und Subagent in eigene Prozesse/Clients über `serveSpace`, `RemoteSpace`, Consumer-Mailboxes (`events`/`ack`) und `OutcomeUnknown`-Handling.
       - **`v4-gated-auth` (Overlay-Gate, Schicht-A/B-Auth, Enrollment & 60s-Grants)**: Kryptografischer Verbindungsbeweis (Ed25519/P-256), Token-Enrollment im `CONTROL_SPACE`, 60-Sekunden-Grants (`GrantAuthority`/`GrantVerifier`), Schlüsselrotation und `HostBootState`-Schutz.
       - **`v5-federated-cluster` (Föderierte Spaces mit Router, HRW-Sharding & `RunGate`)**: Mehrere Member-Spaces hinter `createFederationController` (`FederatedSpace`, `RouterLease`, Original-Principal-Delegation, HRW-Routing nach `threadId`, journalisierter Waiter-Wettlauf `takeWaiting`, `MembershipController`).
       - **`v6-mobile-control` (Steuerung & Überwachung über Web-Admin-Login & Mobile App `pi-termux-mobile`)**: Login-geschützter **AdminSpaces-Bereich** auf `https://spaces.eibrain.org` sowie Anbindung der Android-App (`spaces.html` & `steuerung.html` / `MobileSpaces`): Pairing per QR-Code (`enrollQr` / `createEnroll`), Live-Überwachung von Spaces/Objekten/Alerts (`objects`, `listAlerts`, `auditLog`), Skalieren der Chat-, Subagent- und Sieb-Worker (`setWorkers`), Pausieren/Fortsetzen über `RunGate` (`pauseRun`/`resumeRun`/`scheduleRun`), Lebenszyklus-Steuerung (`createSpace`/`archiveSpace`/`reactivateSpace`/`deleteSpace`) und Deployment-Planung (`planDeployment`/`exportDeployment`).
  4. **Konzeption, Umsetzung und Dokumentation des Beispiels „Multiplayer Space-Chat“** in Anlehnung an [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/), aber **vollständig umgesetzt mit nativen `pi-spaces`-Mitteln** über alle 6 Stufen (`v1`–`v6`).
  5. **Geschütztes Web-Admin-Portal (`/admin`) & Deployment-Architektur für `https://spaces.eibrain.org`**, Verzeichnisstruktur, Umsetzungsphasen und Verifikationsplan.

## Verzeichnisstruktur

```text
help-site/
├── README.md                        # Übersicht und Schnellstart
├── PLAN.md                          # Detaillierter Architektur-, Doku- und Umsetzungsplan
├── .env / .env.example              # Port, Bind, Admin-Passwort, LLM-Credentials
├── app/                             # Next.js 16 App Router
│   ├── layout.tsx                   # Root-Layout + Metadaten (spaces.eibrain.org)
│   └── page.tsx                     # SSR-Einstieg, lädt den Help-Corpus direkt
├── corpus/                          # Kanonischer, dateibasierter Help-Corpus (DE/EN, 37 Artikel)
│   ├── help_product_catalog.*       # Kanonische Systembereiche
│   ├── de/                          # Deutsche Referenz-, API- und Stufen-Tutorials (v1–v6)
│   └── en/                          # Englische Referenz-, API- und Stufen-Tutorials (v1–v6)
├── examples/                        # Die 6 ausführbaren Ausbaustufen (CLI & Web-Backend)
│   ├── shared/                      # Gemeinsame Entry-Typen, CompletionProfiles & LLM-Fallback
│   ├── v1-local-memory/             # Stufe 1: Zero-Setup In-Memory PiSpaces Demo
│   ├── v2-local-durable/            # Stufe 2: SQLite, RequestRef-Claims, Alarme & Subagent
│   ├── v3-remote-socket/            # Stufe 3: SpaceService + RemoteSpace (Unix-Socket/TCP + Mailbox-ACK)
│   ├── v4-gated-auth/               # Stufe 4: Gate (Schicht A/B), Enrollment, 60s-Grants & BootGuard
│   ├── v5-federated-cluster/        # Stufe 5: FederatedSpace, Router, HRW-Sharding & Membership
│   └── v6-mobile-control/           # Stufe 6: Web-Admin & Mobile App Steuerung (QR-Pairing, Worker, RunGate, Alerts)
├── server/                          # Node.js HTTP + WebSocket Server (Custom Server um Next.js)
│   ├── index.ts                     # Einstieg: Next-Handler, /api/feed/*, /api/llm/*, Admin-API, WS-Routing
│   ├── llm.ts                       # pi-ai-Anbindung: Modell-Discovery, Picker-API, ON/OFF-Toggle, Generatoren
│   ├── ws.ts                        # RFC-6455 WebSocket-Upgrade (/ws/chat/:session, /ws/feed)
│   ├── admin/                       # Login-geschütztes Web-Admin-Backend (analog MobileSpaces)
│   │   └── admin-controller.ts      # ADMIN_KINDS, QR-Enroll, Objekt-Inspektion, Deployment-Panel
│   ├── space-chat/                  # Stufen-Orchestrator (wechselt live zwischen v1 bis v6)
│   │   └── stage-runner.ts          # Sessions, Threads, ChatTask-Worker, LLM-Fallback, Stage-Runs
│   └── social/
│       └── swarm.ts                 # SocialSwarmHub: 1k–50k Agenten, SwarmTask→Post/Like-Pipeline,
│                                  #   AgentPulse-Leases, User-Posts, ai_reply & ~1% LLM-Posts,
│                                  #   durable Queries (agent.posts / ai.posts) via readAll
├── client/                          # React 19 Frontend (PI-SPACES Help + Demos + AdminSpaces)
│   ├── styles/layout.css            # Token-/Layout-System, Paletten, Feed-/Chat-/Picker-Styles
│   ├── App.tsx                      # Topbar, Routing (?view=feed|space-chat|admin|…)
│   ├── components/
│   │   ├── SocialFeedView.tsx       # Social-Feed: Threads+Ancestors, Filter, Controls
│   │   ├── SpaceChatWorkbench.tsx   # Multiplayer-Chat-Workbench mit Space-Inspector
│   │   ├── AdminSpacesView.tsx      # Login-geschützte Steuerung (Spaces, Worker, RunGate, Deploy)
│   │   └── LlmModelPicker.tsx       # Geteilter 🤖-Picker: Modellauswahl + ON/OFF-Toggle
│   └── lib/
│       ├── palettes.ts              # Farbpaletten (Dark/Light) & Kontrastberechnung
│       └── search.ts                # Token-/Alias-Suchalgorithmus
├── docker/
│   ├── Dockerfile                   # Multi-Stage: dev-test (Corpus+Build+Tests) & production
│   └── docker-compose.yml           # spaces-help-prod / -dev / -test, Ports via .env
├── deploy/                          # Reverse-Proxy- & Service-Vorlagen für spaces.eibrain.org
│   ├── Caddyfile
│   ├── nginx-spaces.eibrain.org.conf
│   └── pi-spaces-help.service       # systemd-Einheit (Alternativbetrieb ohne Docker)
├── scripts/
│   ├── build-corpus.ts              # Validiert Markdown/Facts und erzeugt public/help/index.json
│   ├── corpus-articles-data.ts      # API-Referenz-Artikel (Signaturen, Parameter, Use-Cases)
│   ├── corpus-workflows-and-api.ts  # Stufen-Workflows und übergreifende Artikel
│   └── build-web.ts                 # Bundelt den React-Client
└── tests/
    └── help-site.test.ts            # Corpus, Stufen v1–v6, Chat-WS, AdminSpaces, Feed-API
```
