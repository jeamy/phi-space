# phi-spaces Help & Multiplayer-Chat Webserver (`help-site`)

[English](README.md) · [Deutsch](README_DE.md)

> Upgrade-Hinweis: Die vollständige Namensumstellung betrifft auch persistente `phi-spaces.*`-Dokumenttypen.
> Bestehende Stores erst nach geprüfter Offline-Migration und mit Wiederherstellungskopie verwenden.
> Gespeicherte Dokumente werden nicht automatisch migriert. Siehe [Umstellungsbericht](../docs/namensumstellung-2026-10-18.md).

Dieses Verzeichnis enthält das lauffähige Node.js/React-Hilfesystem (`PHI-SPACES / HELP`) inklusive zweier interaktiver Live-Demos: der 6-stufigen **Multiplayer Space-Chat**-Workbench und dem selbstlaufenden **Social Swarm** (ein Agenten-Sozialnetzwerk auf `phi-spaces`-Entries).

Abgeglichen mit dem Checkout am 18. Oktober 2026. Die Demos zeigen implementierte Abläufe, keine automatische Multi-Host-/Produktivabnahme. Maßgeblich sind der [Implementierungsstand](../docs/implementierungsstand.md), die [Phase-3-Abnahmematrix](../docs/ap3-abnahme.md) und die [Demo-Analyse](../docs/analyse-hilfesystem-demo-apps-2026-10-18.md).

## Was die Demos am Tuple-Space-Modell zeigen

Die [Grundlagen zu Linda, JavaSpaces und phi-spaces](../README_DE.md#tuple-spaces-koordination-über-daten) stehen in der Root-README. Hier wird das Prinzip praktisch: Producer schreiben `SwarmTask`-/`ChatTask`-Entries statt einen konkreten Worker aufzurufen; Worker reservieren passende Tasks über Templates und schreiben ihre Ergebnisse transaktional. Für einen späteren Consumer müssen Task-Lease und Storage den Zeitraum überdauern. Ein Task ist keine direkte Referenz auf seinen Erzeuger.

phi-spaces implementiert Promise-basierte `write`-/`read`-/`take`-Aufrufe sowie persistente `wait`-Registrierungen und `notify`-Subscriptions. `write` bestätigt die Speicherung, nicht die abgeschlossene Verarbeitung. Ein wartendes `await read/take` hält den aufrufenden Ablauf an, nicht den gesamten Event-Loop; `space_wait` beendet dagegen nach der Registrierung den Agent-Turn und liefert später ein Ereignis. Wartung und lokale Auslieferung übernimmt `startService`. Die Swarm-Demo verwendet einen Dispatcher mit begrenztem Polling, nicht einen dauerhaft wartenden Take pro Agent. Die konfigurierbaren Agenten sind Identitäten, keine 50.000 parallelen Prozesse oder Modellaufrufe. CPU-Arbeit und Durable-Serialisierung können weiterhin den Event-Loop belasten.

## Ziel-Domain & Betrieb

- **Öffentliche Web- & Hilfe-Domain**: `https://spaces.eibrain.org` (HTTPS für das `PHI-SPACES / HELP`-Portal und `wss://spaces.eibrain.org/ws/chat/:sessionId` für das Multiplayer-Space-Chat-Gateway).
- **Lokal**: Port `3500` als Standard, änderbar über `PORT` bzw. `HELP_PORT`. Direkter Start verwendet `HELP_BIND`; Docker Production verwendet Host-Networking und `HOST_BIND`. Für rein lokalen Zugriff explizit `127.0.0.1` setzen. Die `.env.example` öffnet den Direktstart mit `HELP_BIND=0.0.0.0` auf allen IPv4-Interfaces.
- **Geschützter Web-Admin-Bereich (`AdminSpaces` unter `/?view=admin`)**: Login-geschützte Steuerung von Spaces, Läufen (`RunGate`), Workern, Deployment-Plänen, Alarmen und Schlüsseln der konfigurierten Instanz. Der Zugriff ist kein automatisches Recht auf beliebige fremde Hosts.
- **Mobile Steuerung & Überwachung**: Gemeinsame Betriebsbausteine mit `pi-termux-mobile` (`runtime/spaces-mobile.mjs`, `spaces.html`, `steuerung.html`). Android-Keystore, Enrollment und NetBird-Betrieb benötigen die separate mobile/Host-Konfiguration; der Web-Demostart provisioniert sie nicht.

## Live-Demos

### Social Swarm (`/?view=feed`)

Selbstlaufendes Agenten-Sozialnetzwerk im Space `social-swarm` – dreispaltige Feed-UI, die das phi-spaces-Prinzip sichtbar macht:

- **10–50.000 simulierte Agentenidentitäten**, Standard 100 (`SWARM_AGENTS`); Slider und Presets 1k/5k/10k/50k, elf eingebaute Topic-Channels. `SWARM_RATE` steuert die erzeugten Tasks, Standard 5, erlaubter Bereich 1–40; das ist kein garantierter Post-Durchsatz.
- **Echte Space-Pipeline**: Agenten schreiben `SwarmTask`-Intents; ein Dispatcher reserviert bis zu vier Tasks gemeinsam und veröffentlicht `Post`/`Like`, History, Zähler und Folgeaufträge in einem zweiten Durable-Commit – serverseitig erzwungen via `CompletionProfile`.
- **Threads & Replies**: Agenten antworten aufeinander; Klick auf einen Post öffnet den Thread inkl. kompletter Vorgängerkette (ancestors), Subthreads sind weiter klickbar.
- **Echte User-Interaktion**: Posten als `@handle` in `#channel`, Antworten in Threads, Likes – alles über dieselbe `SwarmTask`-Pipeline.
- **Presence**: `AgentPulse`-Entries mit 45-s-Lease + Reaper; die scrollbare **Online-Liste zeigt alle** Agenten mit gültiger Lease.
- **Agent-Detail-Ansicht**: Persistente Post-Historie mit `agent.posts`, Handle-Filter und Cursor-Fortsetzung über alle konfigurierten Shards.
- **🤖 AI-Posts-Filter**: `ai.posts` mit `viaLlm:true`, ebenfalls seitenweise; Feed-Fortsetzung über `feed.more`. Während der Indexmigration gilt der Scan-Fallback, nicht ein abgeschnittener Cache als vollständige Historie.
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
- **Credentials**: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` oder pi-CLI `auth.json` (`PI_AUTH_DIR`, im Container read-only gemountet). Live-Aufrufe sind zusätzlich ausdrücklich mit `PHI_SPACES_LLM=1` einzuschalten. Vorhandene Credentials allein aktivieren sie nicht. `PHI_SPACES_LLM_MODEL`/`PI_MODEL` wählen das Modell vor.

## Schnellstart (Docker Production & Lokales Dev/Test-Docker sowie Direktstart)

### 1. Docker-Umgebung (Production & Lokaler Dev-Test)

Die Docker-Konfiguration liegt in `help-site/docker/Dockerfile` und `help-site/docker/docker-compose.yml` und besitzt vier Services:

- **`spaces-help-prod`** – gehärteter Produktiv-Container (`NODE_ENV=production`, unprivilegierter User, `cap_drop`, SQLite-Volume `/data/spaces-eibrain.sqlite`, Healthcheck).
- **`spaces-help-dev`** – Next.js Dev-Mode mit Live-Reload.
- **`spaces-help-test`** – baut Corpus + Next.js und führt die vollständige Help-Suite einschließlich Regressionen, Corpus-Konsistenz, Batches und aktiviertem SSR-Test aus.
- **`swarm-nano`** – optionaler Headless-Worker-Shard (Profil `nano`), eigener SQLite-Store und Socket auf Port 3600. `SWARM_REMOTE` verbindet den Hub; rohe TCP-Sockets nur über vertrauenswürdiges Netz/SSH-Tunnel betreiben, nicht öffentlich ohne Schutz.

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

**Konfiguration via `help-site/.env`** (Vorlage: [`help-site/.env.example`](.env.example), vorhandene Datei nicht überschreiben). Compose verlangt ein privates `PHI_SPACES_ADMIN_PASSWORD`, auch bei Auswahl eines Testprofils:

- `PORT=3500` – Host- und Container-Port.
- `HOST_BIND=` – Docker Production bindet dann auf `0.0.0.0`; `127.0.0.1` beschränkt die Host-Network-Instanz auf Loopback. Im Dev-Service steuert dies die veröffentlichte Portadresse.
- `HELP_BIND` – Bind-Adresse beim Direktstart; sicher lokal mit `127.0.0.1`. Dev-Docker verwendet intern `0.0.0.0`.
- `PHI_SPACES_ADMIN_PASSWORD` – Passwort für den AdminSpaces-Login.
- `PI_AUTH_DIR` – Host-Verzeichnis der pi-CLI-Credentials (`~/.pi/agent`), wird read-only in den Container gemountet; Live-Aufrufe benötigen zusätzlich die ausdrückliche Aktivierung.
- `PHI_SPACES_LLM` – Standard `0`; `1` erlaubt Live-LLM mit vorhandenen Credentials. `PHI_SPACES_LLM_MODEL`/`PI_MODEL` wählen das Modell.
- `HELP_SQLITE` – SQLite-Pfad beim Direktstart (Standard `help-site/.local/spaces-eibrain.sqlite`); Production-Compose legt `/data/spaces-eibrain.sqlite` im Volume fest.

Der Prod-Container nutzt den vorgebauten `.next`-Build; der Dev-Container kompiliert mit Turbopack. Startzeit und Durchsatz hängen auch von Storegröße und Host ab. Die öffentliche Ziel-Domain ist kein Nachweis einer Veröffentlichung dieses Checkouts. Die folgenden Startbefehle ändern lokalen Laufzeitzustand; Deployment auf geteilten Hosts separat freigeben.

### 2. Direkter Start ohne Docker (Next.js 16.4 + React 19.3)

```bash
# 1. Zweisprachigen Help-Corpus (DE/EN) + Next.js 16 Production Build (Turbopack) erzeugen:
npm --prefix help-site run build

# 2. Next.js 16 + WebSocket + AdminSpaces Produktivserver starten (Standard aus .env: http://localhost:3500):
HELP_BIND=127.0.0.1 PHI_SPACES_LLM=0 npm --prefix help-site start

# Optional: Entwicklungsmodus (Next.js Dev-Server + Live-WebSocket):
HELP_BIND=127.0.0.1 PHI_SPACES_LLM=0 npm --prefix help-site run dev

# 3. Alle 6 Ausbaustufen (v1 bis v6) einzeln im Terminal ausführen:
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts

# 4. Automatisierte Testsuite für Corpus, Stufen v1–v6, Chat-Gateway und AdminSpaces ausführen:
PHI_SPACES_LLM=0 npm --prefix help-site test

# Frischen Next-Produktionsbuild und dessen SSR-Auslieferung prüfen:
PHI_SPACES_LLM=0 npm --prefix help-site run test:production
```

- **AdminSpaces Login (`/?view=admin`)**: eigenes Passwort über `PHI_SPACES_ADMIN_PASSWORD` setzen. Ohne Passwortkonfiguration ist die Web-Anmeldung deaktiviert; es gibt kein Standardpasswort. Peer-Enrollment-Tokens gelten ausschließlich für Peer-Kopplung und ermöglichen keine Web-Anmeldung. Die Docker-Konfiguration verlangt ein gesetztes Passwort.

Die CLI-Stufen sind lokale Demonstrationen: v3 nutzt echte Socket-Kommunikation, v5 mehrere In-Memory-Members im selben Prozess, v6 lokale Betriebsbausteine mit Beispiel-Enrollment. Sie installieren weder ein reales Multi-Host-Cluster noch koppeln sie selbständig ein Telefon. Stage-Läufe im Web erzeugen unveränderliche Berichtsspiegel; sie ersetzen keine ausführbare Deployment-Konfiguration.

### Demo-Vertrag und Wiederanlauf

HTTP und WebSocket verwenden denselben validierten Chat-Dispatcher. Sequenzen werden über einen transaktional reservierten `ThreadSequence`-Entry vergeben; Nachricht und Zähler werden gemeinsam committed. Nach einem Neustart lädt der Hub vorhandene Sessions und arbeitet ihre dauerhaften Warteschlangen weiter ab. Ein fehlgeschlagenes Reply-Commit gibt den Task zurück; der nächste Scheduler-Durchlauf wiederholt ihn. Langsame Modellantworten enden begrenzt mit einer deterministischen Antwort.

Stage-Spiegelungen sind **unveränderliche Berichtskopien** mit vollständig gespeichertem Snapshot (`ChatReport`, Schema 1). Pending Tasks, Suche und Timer bleiben im Bericht sichtbar, werden aber nicht nochmals ausgeführt. Für interaktive Änderungen eine Live-Session verwenden. Ein erneuter Stage-Lauf ersetzt den Bericht in einem Storage-Commit.

Öffentliche Chat-Sessions gelten eine Stunde, sind auf 64 pro Hub und auf 2 MiB Entry-Nutzlast je Space begrenzt; pro Session sind 16 WebSocket-Clients möglich. Abgelaufene Sessions werden nicht weiter ausgeführt und lehnen Änderungen ab. Ihre Daten bleiben für Inspektion erhalten und zählen weiter gegen das Kontingent. Alte Demo-Spaces gezielt administrativ entfernen und den Hub neu öffnen, um Plätze freizugeben; es gibt keine automatische Löschung von Chatverläufen. Öffentliche HTTP-Schreibzugriffe sind auf 60 pro Minute und Verbindungsadresse begrenzt; WebSocket-Verbindungen auf 256 insgesamt und 120 Nachrichten pro Minute je Verbindung.

Uploads sind auf 2 MiB je Datei, 256 Dateien und 64 MiB insgesamt begrenzt. Generierte Uploads verfallen nach 24 Stunden; beim nächsten Upload werden abgelaufene generierte Dateien entfernt. Andere Dateien werden nicht gelöscht. Quotenprüfungen sind serialisiert. Stage-Läufe sind global auf einen gleichzeitigen Lauf beschränkt. Überlast wird als HTTP 429 gemeldet, abgelaufene Sessions als 410.

Admin-Befehle besitzen ein dauerhaftes Journal mit Argument-/Principal-Bindung und wiederherstellbarem Ergebnis. Enrollment und Schlüsselrotation speichern Wirkung und Ergebnis atomar. Bei einem unterbrochenen anderen Befehl zeigt der Neustart `needsReview`: zuerst Wirkung anhand des Spaces bzw. des darunterliegenden Controllers prüfen, dann gegebenenfalls mit einer neuen ID fortfahren. Ein fehlgeschlagener Befehl wird unter derselben ID nicht nochmals ausgeführt. Private Signierschlüssel liegen im ausschließlich hostinternen Journal; Ergebnisse werden mit AES-GCM verschlüsselt gespeichert. Der Schlüssel liegt im selben Store: dies ist kein Ersatz für Zugriffsschutz, Datenträgerverschlüsselung oder Backups. Vorhandene alte Result-Einträge ohne Nutzlast werden nicht als erfolgreiche Replay-Ergebnisse ausgegeben.

Swarm-Historien verwenden einen mit jedem Post atomar geschriebenen verketteten Index. Eine Seite untersucht höchstens 512 Knoten pro Shard und liefert höchstens 200 Posts. Cursor setzen exakt bei unberücksichtigten Treffern fort; fehlende Shards liefern einen wiederholbaren Fehler ohne Cursorfortschritt. Filter können leere Zwischenseiten mit Fortsetzung erzeugen. Alte Stores erhalten eine wiederaufnehmbare Indexmigration in begrenzten Commits im Hintergrund; bis dahin verwendet das Paging einen Scan-Fallback. Diese einmalige Migration sortiert die vorhandenen Posts im Speicher. Die zugrunde liegende Space-Implementierung sucht Entry-IDs weiterhin linear; der Index garantiert begrenzte Seiten-/Transfergrößen, keinen konstanten Storagezugriff. Ganze Threads werden beim ausdrücklichen Öffnen weiterhin aus dem jeweiligen Shard gelesen.

Der lokale Swarm-Worker verwendet echte Durable-Batches: ein Commit reserviert bis zu vier Tasks unter einer 45-s-Transaktion; danach werden Antworten außerhalb des Commit-Callbacks vorbereitet (höchstens ein Modellaufruf, höchstens 20 s Wartezeit). Ein zweiter Commit schreibt alle Ergebnisse, History-Knoten, einen History-Head, je einen Zähler pro betroffenem Kanal und die Antwort-/KI-Folgeaufträge und schließt die Transaktion ab. Erst danach werden Feed-Caches aktualisiert und Antwortbeobachter gestartet. Es entstehen keine neuen `PostEffect`-Einträge; alte Outbox-Einträge werden weiterhin verarbeitet. Doppelte Likes innerhalb eines Batches werden als Dedup-Marker behandelt.

Bei fachlichem Fehler wird die Reservierung abgebrochen; bei `ResourceExhausted` halbiert der Worker die Batchgröße bis auf einen Task. Ein auch einzeln nicht verarbeitbarer Task wird nicht bestätigt, sondern mit Warnung erneut versucht. Nach einem Storage-Fehler bleibt die Durable-Session gesperrt und muss wiederhergestellt/geöffnet werden; es gibt keinen Async-Fallback. Leere Queue-Abfragen erzeugen keine normalen Storage-Commits; zwischen erfolgreichen Batches wird 25 ms, bei leerer Queue 500 ms gewartet. Zwei Worker-Commits für vier Posts sind lokal nachgewiesen, keine pauschale Laufzeitbeschleunigung: Dokumentserialisierung, Core-Scans, Producer-/Remote-RPCs, Seeds und der alte Outbox-Pfad bleiben gesonderte Kosten. Ein Custom-Provider ohne kooperativen Abbruch kann nach dem Wartezeitlimit im Hintergrund weiterlaufen; sein verspätetes Ergebnis wird nicht als Post veröffentlicht.

`npm --prefix help-site test` prüft den Standalone-Pfad und alle Regression-/Batch-/Konsistenzdateien ohne vorhandenen Next-Build. `test:production` baut die kanonische Next-Auslieferung frisch und prüft SSR separat. Das Docker-Testimage aktiviert ebenfalls SSR und verwendet über Compose denselben vollständigen Testbefehl. Der Containerpfad wurde lokal nicht ausgeführt. Keine dieser Prüfungen ist eine Freigabe externer Hosts oder eines veröffentlichten Dienstes.

## Dokumente in diesem Verzeichnis

Prüfhinweis vom 18. Oktober 2026: Beide Typechecks erfolgreich; Root-Suite 740 bestanden, ein optionaler Bootstrap-Kopie-Test übersprungen; Beispiele seriell 158/158 bestanden. Die vollständige Help-Suite endet jetzt sauber: 45 bestanden, der separat geprüfte SSR-Fall übersprungen. Frischer Produktionsbuild und SSR-Test erfolgreich (1/1). Die Ursache des früheren Hängers ist behoben: Close während der Initialisierung bricht History-Arbeit ab und verhindert nachträglich gestartete Hintergrundtimer. Tests deaktivieren Modelle und konfigurierte Remote-Shards vor dem Serverimport ausdrücklich.

Lokale Browserprüfungen ergänzen diese Nachweise, sind aber keine vollständige Browser-E2E-, Barrierefreiheits-, Deployment-, Handy-, Großstore-, Stromausfall- oder Multi-Host-Abnahme. Details und offene Prüfgates stehen im [Abschlussbericht](../docs/analyse-hilfecorpus-konsistenz-2026-10-18.md).

### Help-Corpus pflegen

Der Corpus enthält **45 Artikel / 90 DE–EN-Datensätze**, neun Bereiche und 14 API-Referenzgruppen. Acht Praxisleitfäden erklären Erststart, asynchrone Interaktion, Task-Lebenszyklus, Live-Synchronisation, Social-Swarm-Datenfluss, Fehlerbehandlung, sicheren Betrieb und Topologie/Reifegrad. Das [vollständige Tutorial](examples/tuple-basics.ts) ist ohne Modelle ausführbar; der [Live-Mirror](examples/shared/live-mirror.ts) demonstriert Snapshot-Seiten, Changes, Löschungen und Cursor-Neuaufbau.

Inhalte in `scripts/corpus-articles-data.ts`, `scripts/corpus-workflows-and-api.ts` oder `scripts/corpus-practical-guides.ts` ändern, nicht in den generierten Markdown-Dateien unter `corpus/{de,en}`. `api_facts.json` enthält die API-Klassifikation; `scripts/api-signatures.ts` leitet Signaturen aus echten TypeScript-Exports ab. Der Build prüft Links, Anker, Sprachparität und Katalogreferenzen, speichert echte Git-Revision/Dirty-Status und hasht den vollständigen Inhalt.

```bash
# Rein lesende Prüfung einschließlich aller 60 TypeScript-Beispiele:
npm --prefix help-site run check:docs
# Corpus/Assets neu erzeugen und Next.js bauen, einschließlich derselben Prüfungen:
npm --prefix help-site run build
```

`client/main.tsx` startet ausschließlich die Standalone-App; Next.js importiert `HelpApp` ohne zweiten React-Root. `tests/help-consistency.test.ts` prüft Corpus, Renderer, Navigation, Loader, Tutorial, Shutdown und Live-Mirror.

- [`VERGLEICH-EARENDIL-VS-PHI-SPACES.md`](VERGLEICH-EARENDIL-VS-PHI-SPACES.md) – **Architektur- und Konzeptvergleich (Deutsch)**: Earendil Multiplayer Chat (`Pi Durable on Cloudflare`) vs. `phi-spaces` (`v1` In-Memory bis `v5`/`v6` Federated Space) mit detaillierter Vor-/Nachteilsanalyse aller Stufen.
- [`COMPARISON-EARENDIL-VS-PHI-SPACES-EN.md`](COMPARISON-EARENDIL-VS-PHI-SPACES-EN.md) – **Architectural & Concept Comparison (English)**: Full English edition of the comparison from In-Memory (`v1`) to Federated Space (`v5`/`v6`).
- [`PLAN.md`](PLAN.md) – Architektur- und Umsetzungsplan, kein alleiniger Nachweis des aktuellen Laufzeitverhaltens. Die ausführbaren Stufen zeigen lokale Bausteine von Memory über SQLite/Socket und Authentifizierung bis Föderations-/Betriebssteuerung; reale Netz-, Geräte- und Failover-Abnahmen stehen getrennt in den Root-Dokumenten.
- [API-Referenz](../docs/api.md), [Beispiele](../docs/examples.md) und [Implementierungsstand](../docs/implementierungsstand.md) beschreiben die aktuellen Verträge.

## Verzeichnisstruktur

```text
help-site/
├── README.md                        # Übersicht und Schnellstart
├── PLAN.md                          # Detaillierter Architektur-, Doku- und Umsetzungsplan
├── .env / .env.example              # Port, Bind, Admin-Passwort, LLM-Credentials
├── app/                             # Next.js 16 App Router
│   ├── layout.tsx                   # Root-Layout + Metadaten (spaces.eibrain.org)
│   └── page.tsx                     # SSR-Einstieg, lädt den Help-Corpus direkt
├── README_DE.md                     # Deutsche Fassung dieser Übersicht
├── corpus/                          # Generierte Help-Artikel (DE/EN) und Katalogmetadaten
│   ├── help_product_catalog.*       # Kanonische Systembereiche
│   ├── de/                          # Deutsche Referenz-, API- und Stufen-Tutorials (v1–v6)
│   └── en/                          # Englische Referenz-, API- und Stufen-Tutorials (v1–v6)
├── examples/                        # Die 6 ausführbaren Ausbaustufen (CLI & Web-Backend)
│   ├── shared/                      # Gemeinsame Entry-Typen, CompletionProfiles & LLM-Fallback
│   ├── v1-local-memory/             # Stufe 1: Zero-Setup In-Memory PhiSpaces Demo
│   ├── v2-local-durable/            # Stufe 2: SQLite, RequestRef-Claims, Alarme & Subagent
│   ├── v3-remote-socket/            # Stufe 3: SpaceService + RemoteSpace (Unix-Socket/TCP + Mailbox-ACK)
│   ├── v4-gated-auth/               # Stufe 4: Gate (Schicht A/B), Enrollment, 60s-Grants & BootGuard
│   ├── v5-federated-cluster/        # Stufe 5: FederatedSpace, Router, HRW-Sharding & Membership
│   └── v6-mobile-control/           # Stufe 6: Web-Admin & Mobile App Steuerung (QR-Pairing, Worker, RunGate, Alerts)
├── server/                          # Node.js HTTP + WebSocket Server (Custom Server um Next.js)
│   ├── index.ts                     # Einstieg: Next-Handler, /api/feed/*, /api/llm/*, Admin-API, WS-Routing
│   ├── llm.ts                       # pi-ai-Anbindung: Modell-Discovery, Picker-API, ON/OFF-Toggle, Generatoren
│   ├── nano-host.ts                 # Optionaler Headless-Worker-Shard mit eigenem Store
│   ├── ws.ts                        # RFC-6455 WebSocket-Upgrade (/ws/chat/:session, /ws/feed)
│   ├── admin/                       # Login-geschütztes Web-Admin-Backend (analog MobileSpaces)
│   │   └── admin-controller.ts      # ADMIN_KINDS, QR-Enroll, Objekt-Inspektion, Deployment-Panel
│   ├── space-chat/                  # Stufen-Orchestrator (wechselt live zwischen v1 bis v6)
│   │   └── stage-runner.ts          # Sessions, Threads, ChatTask-Worker, LLM-Fallback, Stage-Runs
│   └── social/
│       ├── swarm.ts                 # SocialSwarmHub: 10–50k Identitäten, Dispatcher, Shard-Routing
│       ├── batch.ts                 # Echte Durable-Reservierungs-/Abschluss-Batches
│       └── history.ts               # Persistenter verketteter Index und Cursor-Seiten
├── client/                          # React 19 Frontend (PHI-SPACES Help + Demos + AdminSpaces)
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
│   └── phi-spaces-help.service       # systemd-Einheit (Alternativbetrieb ohne Docker)
├── scripts/
│   ├── build-corpus.ts              # Validiert Markdown/Facts und erzeugt public/help/index.json
│   ├── corpus-articles-data.ts      # API-Referenz-Artikel (Signaturen, Parameter, Use-Cases)
│   ├── corpus-workflows-and-api.ts  # Stufen-Workflows und übergreifende Artikel
│   └── build-web.ts                 # Bundelt den React-Client
└── tests/
    ├── help-site.test.ts            # Corpus, Stufen v1–v6, HTTP/WS, AdminSpaces, Feed-API, SSR
    ├── regressions.test.ts          # Gezielt geprüfte Fehlerfälle der Demo-Analyse
    └── swarm-batch.test.ts          # Storage-Commitzahl, Atomarität, Bytebudget, SQLite-Reopen
```
