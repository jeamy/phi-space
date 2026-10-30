# Architekturvergleich: Earendil Multiplayer Chat (`Pi Durable on Cloudflare`) vs. `phi-spaces` (`v1` In-Memory bis `v5`/`v6` Federated Space)

**Stand:** 17. Oktober 2026, Persistenz-Zeile und Pfade am 30. Oktober 2026 nachgeführt  
**Bezug:**
- Vorlage: [Pi Durable on Cloudflare – Multiplayer Chat](https://earendil.com/posts/pi-durable-on-cloudflare/)
- Unsere Umsetzung: [`help-site/examples/v1..v6`](file:///media/data/programming/phi-spaces/help-site/examples) und [`help-site/examples/shared/chat-core.ts`](file:///media/data/programming/phi-spaces/help-site/examples/shared/chat-core.ts)
- Abgrenzung zum Aktor-Modell: [`agent/examples/chat.ts`](file:///media/data/programming/phi-spaces/agent/examples/chat.ts)
- Zielarchitektur ohne Pi-Durable: [`docs/umstellung-ohne-pi-durable.md`](file:///media/data/programming/phi-spaces/docs/umstellung-ohne-pi-durable.md)

---

## 1. Grundkonzept im Vergleich: Actor/Session-Hülle vs. Koordinationsraum (Tuple Space)

Obwohl beide Ansätze historisch aus der `@earendil-works`-Ökosphäre hervorgegangen sind und transaktionale Persistenz nutzen, verfolgen sie zwei grundlegend verschiedene Architekturmuster. Zudem existiert im Projekt ein Übergangspfad weg von externen Framework-Abhängigkeiten hin zu einer autarken Space-Laufzeit:

| Dimension | Earendil-Vorlage (`Pi Durable on Cloudflare`) | Unser `phi-spaces`-Ansatz (`v1` bis `v6`) | Status / Anmerkung |
|---|---|---|---|
| **Leitparadigma** | **Stateful Actor pro Session (Durable Object)**: Eine Session ist ein isoliertes Cloudflare Durable Object, das WebSockets, SQLite-DB, Alarm-Timer und den `pi-durable`-Harness in einer einzigen Objektinstanz kapselt. | **Entkoppelter Koordinationsraum (Tuple Space)**: Der Zustand liegt als Menge typisierter, unveränderlicher JSON-Entries (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`) in einem Space. Clients, Worker und Subagenten sind lose gekoppelte Teilnehmer. | ✅ Im Code umgesetzt ([`chat-core.ts`](file:///media/data/programming/phi-spaces/help-site/examples/shared/chat-core.ts)). |
| **Geschäftslogik & Zustand** | Im Methoden-Code der Durable-Object-Klasse (`Session`), die direkt `harness.commit(...)`, `conversation.submit(...)` und `watchEvents(...)` aufruft. | In unabhängigen Workern, die über das einheitliche `SpaceLike`-Interface (`write`, `read`, `take`, `wait`, `notify`, `createTransaction`, `commit`) mit dem Space interagieren. | ✅ Implementiert in `processNextChatTask` und `processNextSearchTask`. |
| **Koppelung Web-Server & KI-Worker** | **Eng gekoppelt (In-Object)**: WebSocket-Terminierung, Konversationszustand und Modellaufrufe laufen zwingend in derselben Cloudflare-Instanz. | **Frei wählbar (`v1`–`v6`)**: Kann im selben Prozess (`v1`/`v2`), über Unix-Socket/TCP getrennt (`v3`), kryptografisch gesichert (`v4`) oder über mehrere Server föderiert (`v5`/`v6`) laufen. | ⚠️ **Lücke:** In `v5-federated-cluster` läuft der Test aktuell in-process mit 4 `MemoryStorage`-Instanzen statt über echte TCP-Sockets. |
| **Plattformbindung** | Gebunden an **Cloudflare Workers & Durable Objects** (`DurableObjectState`, `ctx.storage.sql`, Hibernatable WebSockets, `alarm()`). | **Plattformunabhängig (Self-Hosted / On-Prem / VPS / Container / Mobile)**: Läuft überall, wo Node.js läuft (RAM, lokale SQLite/JSONL, Docker, Linux-VPS, Android/Termux). | ✅ Verifiziert auf Linux & Android/Termux. |
| **Persistenz-Abhängigkeit** | Fest verdrahtet mit Cloudflare Edge Storage und `@earendil-works/pi-durable`. | Eigener SQLite-Speicher ohne pi-durable ([`docs/umstellung-ohne-pi-durable.md`](file:///media/data/programming/phi-spaces/docs/umstellung-ohne-pi-durable.md)); pi-durable nutzt nur das optionale Paket `agent/`. | ✅ **Umgestellt:** Der Space ist unabhängig von `pi-durable`. |
| **Skalierungsmodell** | **Scale-to-Zero pro Session** (Hibernation bei Inaktivität; unbegrenzt viele kleine, voneinander komplett isolierte Sessions in der Cloud). | **Horizontale & vertikale Skalierung von Workern und Spaces**: Einzel-Space (`v1`–`v4`) bis zum geshardeten Multi-Member-Cluster (`v5` mit HRW-Routing nach `threadId`) und zentraler Betriebssteuerung (`v6`). | ✅ HRW-Routing in Core implementiert; siehe Abschnitt 2.8 für Cluster-Transaktionsgrenzen. |

> [!NOTE]
> **Koexistenz zweier Chat-Ansätze im Repository:**  
> Das Root-Beispiel [`agent/examples/chat.ts`](file:///media/data/programming/phi-spaces/agent/examples/chat.ts) implementiert den Chat als **Earendil-Aktor-Netzwerk**, in dem `alice`, `bob` und `carol` langlebige `pi-durable`-Conversations sind und der Space nur als Event-Bus dient.  
> Die Stufen `v1` bis `v6` in `help-site/examples/` ([`chat-core.ts`](file:///media/data/programming/phi-spaces/help-site/examples/shared/chat-core.ts)) demonstrieren hingegen die **reine Tuple-Space-Architektur**, die gänzlich ohne Aktor-Konversationen auskommt.

---

## 2. Mechanismus-für-Mechanismus-Vergleich

### 2.1 Session-Isolation und Multi-Konversationen (Threads & Forking)

- **Earendil-Vorlage**:
  - Jede Session-URL adressiert eine eigene Durable-Object-Instanz. Innerhalb dieser Instanz werden mehrere `pi-durable`-Conversations (`tx.createConversation`, `tx.forkConversation`) angelegt.
  - **Vorteil**: Jede Session hat ihre eigene kleine SQLite-Datenbank in der Cloudflare-Edge; `forkConversation` ist ein Copy-on-Write-Fork im Dokumentbaum mit $O(1)$-Aufwand.
  - **Nachteil**: Konversationen einer Session können niemals auf mehrere Knoten verteilt werden; Sessions sind unüberbrückbare Silos.
- **`phi-spaces`-Umsetzung**:
  - Jede Session ist ein **benannter Space (`NamedSpace`)** (bzw. in `v5` eine über `threadId` per HRW geshardete Menge von Member-Spaces). Threads und Nachrichten sind reguläre `Thread`- und `Msg`-Entries.
  - **Vorteil**: Threads, Nachrichten und Aufgaben sind normale Space-Entries, die jederzeit per Template abgefragt, gefiltert, archiviert (`archiveSpace`) und clusterweit durchsucht werden können.
  - ✅ **$O(1)$ Pointer-basiertes Thread-Forking (Copy-on-Write auf Tuple-Ebene):**  
    In [`chat-core.ts`](file:///media/data/programming/phi-spaces/help-site/examples/shared/chat-core.ts) schreibt `forkThread()` ausschließlich den neuen `Thread`-Metadateneintrag (`parentThreadId`, `forkUpToSeq`) mit 1 `RequestRef`-Claim ($O(1)$ Space-Entries, keine physische Duplizierung geerbter `Msg`-Entries). Beim Lesen und Inspizieren löst `SpaceChatEngine.resolveMessagesForThread()` die geerbten Nachrichten über die Ancestor-Pointer-Kette bis `forkUpToSeq` dynamisch auf.

---

### 2.2 Idempotenz bei Verbindungsabbruch (Command Receipts vs. `RequestRef`-Claims)

- **Earendil-Vorlage**:
  - Definiert manuell ein anwendungsspezifisches Dokument `ConversationCommandReceipts`, um bei `conversation.create` anhand der `requestId` zu prüfen, ob der Befehl vor einem WebSocket-Abbruch bereits ausgeführt wurde.
  - **Nachteil**: Muss vom Anwendungsentwickler für jeden neuen Befehlstyp per Hand entworfen und gepflegt werden.
- **`phi-spaces`-Umsetzung**:
  - Nutzt die **eingebaute Kern-Idempotenz von `phi-spaces` ([`src/claims.ts`](file:///media/data/programming/phi-spaces/src/claims.ts))**: Jede Mutation (`write`, `take`, `createTransaction`, `commit`, `abort`, `renew`, `cancel`, `wait`, `notify`) akzeptiert `{ request: { principal, generation, requestId } }`.
  - **Vorteil**: Universell für jede Space-Operation verfügbar, inklusive kanonischem RFC-8785-Argument-Hash (`RequestConflict` bei veränderten Parametern), 24-Stunden-Aufbewahrung und `pollOperation` / `resolveOperation` über Prozessneustarts hinweg.
  - ✅ **Persistente Admin-Idempotenz im Web-Admin ([`admin-controller.ts`](file:///media/data/programming/phi-spaces/help-site/server/admin/admin-controller.ts)):** `#operations` wird beim Serverstart aus den langlebigen `Result`-Entries des `CONTROL_SPACE` rekonstruiert, sodass Retries einer `commandId` auch nach Server-Neustarts idempotent beantwortet werden.

---

### 2.3 Geordnete Nachrichtenverarbeitung & Schutz vor unvollständigen Antworten

- **Earendil-Vorlage**:
  - Nutzt `conversation.submit({ ..., whenBusy: "followUp" })`. Während das Modell läuft, landen neue Teilnehmer-Nachrichten in der `pi-durable`-Inbox der Conversation.
  - **Vorteil**: Kompakter Code für reine 1:1-Konversationsschleifen.
  - **Nachteil**: Keine deklarative, vom Datenraum erzwungene Bedingung, welche Ergebnis-Artefakte ein Worker beim Abschluss einer Aufgabe zwingend hinterlassen muss.
- **`phi-spaces`-Umsetzung**:
  - Jede Teilnehmer-Nachricht schreibt in einer Transaktion die User-`Msg` und einen `ChatTask`-Entry. Ein Worker reserviert den `ChatTask` exklusiv per `space.take(..., { txn })`.
  - **Vorteil 1 (`CompletionProfile`)**: Der Space-Kern erzwingt beim `commit(txn)` serverseitig, dass für jeden genommenen `ChatTask` genau eine passende Antwort-`Msg` mit identischer `taskId` und `threadId` geschrieben wurde (`CompletionViolation` sonst!).
  - **Vorteil 2 (Worker-Freiheit)**: Beliebig viele heterogene Worker (Skripte, lokale Modelle, entfernte GPU-Worker über `RemoteSpace`) können `ChatTask`-Entries abarbeiten. Stürzt ein Worker ab, läuft die Transaktions-Lease ab und der `ChatTask` kehrt automatisch in den Space zurück.
  - ✅ **Gelöschte/fehlende Targets im Social Swarm ([`swarm.ts`](file:///media/data/programming/phi-spaces/help-site/server/social/swarm.ts)):**  
    Wird ein `Like`-Task für einen fehlenden Post verarbeitet, schreibt der Worker einen kurzlebigen `Like`-Dedup-Ack-Entry (TTL 60 s, `dedup: true`), damit das `CompletionProfile` sauber erfüllt wird.

---

### 2.4 Echtzeit-Streaming, Multiplayer-Presence & Disconnect-Verhalten

- **Earendil-Vorlage**:
  - Nutzt `watchEvents(harness, conversationId)` für Token-/Transcript-Streaming und speichert Teilnehmer-Präsenz über `socket.serializeAttachment({ username, conversationId })` auf den Cloudflare-WebSockets.
  - **Vorteil**: Token-genaues Streaming während der Modellgenerierung und WebSocket-Hibernation durch Cloudflare.
  - **Nachteil**: Präsenz ist an die WebSocket-Verbindung eines einzelnen Objekts gekoppelt und außerhalb nicht als abfragbarer Datenbestand sichtbar.
- **`phi-spaces`-Umsetzung**:
  - Teilnehmer-Präsenz ist ein echter **`Presence`-Entry im Space mit endlicher Lease (z.B. 30 s)**, der per Heartbeat (`space.renew`) verlängert wird und bei Ausfall automatisch durch den `phi-spaces`-Reaper abläuft.
  - Synchronisation via Snapshots (`readPage` mit `rev`) plus Commit-Deltas (`changes(afterRev)`) bzw. langlebige Consumer-Mailboxes (`events` + Präfix-`ack`).
  - **Vorteil**: Präsenz ist ein erstklassiger, abfragbarer Zustand im Space und kann clusterweit abgefragt werden.
  - **Nachteil / Realistische Grenze:** Da ein Space transaktionale Entries bei Commit veröffentlicht, ist er für diskrete Nachrichten optimiert, nicht für unkommittiertes Token-Streaming im Sub-Millisekunden-Takt.
  - ⚠️ **Disconnect-Verhalten bei mobilen Clients:** Bricht ein mobiler Client während eines offenen `take`-Aufrufs die Verbindung ab, bleibt die Aufgabe für die volle Dauer der Transaktions-Lease (z.B. 30–60 s) blockiert, bevor andere Worker sie übernehmen können.
  - ✅ **Exakte Lease-Ablaufverfolgung ([`chat-core.ts`](file:///media/data/programming/phi-spaces/help-site/examples/shared/chat-core.ts)):** `#presenceExpires` speichert die realen Rückgabewerte von `space.write` und `space.renew`, sodass Heartbeat-Verlängerungen im Snapshot exakt sichtbar sind.

---

### 2.5 Geplante Aufgaben (`schedule` / Alarme)

- **Earendil-Vorlage**:
  - Ein Durable Object besitzt **nur einen einzigen Hardware-Alarm** (`ctx.storage.setAlarm(timestamp)`). Die Anwendung muss bei jedem Aufwachen alle Tasks scannen, das Minimum aller Deadlines berechnen und den DO-Alarm neu programmieren.
- **`phi-spaces`-Umsetzung**:
  - Ein Space verwaltet **beliebig viele unabhängige Leases und Waiter-Deadlines gleichzeitig**.
  - Für eine geplante Aufgabe wird ein `ScheduledJob`-Entry (`FOREVER`) zusammen mit einem `TimerLock`-Entry (`lease = delayMs`) geschrieben.
  - Läuft `TimerLock` ab, räumt der Reaper den Lock ab und der Job wird transaktional in einen `ChatTask` überführt.
  - ✅ **Mehrfach-Alarm-Abarbeitung ([`stage-runner.ts`](file:///media/data/programming/phi-spaces/help-site/server/space-chat/stage-runner.ts)):**  
    `tickAlarms()` arbeitet alle gleichzeitig fälligen Alarme in einer Schleife (`for (let i = 0; i < triggered.length; i++) await processNextChatTask()`) vollständig ab.

---

### 2.6 Konversationsübergreifende Suche per Subagent (`search_history`)

- **Earendil-Vorlage**:
  - Das `search_history`-Tool erzeugt in derselben Session-DB eine Child-Conversation (`ownership: { kind: "task", taskId: api.taskId }`) und durchsucht die anderen Conversations über SQLite-Indizes.
- **`phi-spaces`-Umsetzung**:
  - Der Haupt-Worker legt einen `SearchTask`-Entry ab. Ein eigenständiger **Search-Subagent-Worker** nimmt `SearchTask`, durchsucht Threads, schreibt `SubagentStep`-Entries und committet das `SearchResult` unter einem zweiten `CompletionProfile`.
  - **Vorteil in Stufe `v3`–`v5`**: Subagent kann als getrennter Prozess auf einem anderen Rechner laufen; in Stufe `v5` durchsucht `federated.readAll` alle Member-Spaces des Clusters.
  - ✅ **Domänenneutrale Stopwort-Fallbacks & deduplizierte Suche:** Da `forkThread` geerbte Nachrichten per Pointer referenziert statt physisch zu kopieren, durchsucht `readAll({ type: "Msg" })` ausschließlich Original-Nachrichten ohne Fork-Duplikate; reine Stopwort-Anfragen nutzen neutrale Fallback-Begriffe (`["space", "entry", "chat"]`).

---

### 2.7 Hochverfügbarkeit, Replikation & Disaster Recovery (AP3)

- **Earendil-Vorlage**:
  - Verlässt sich vollständig auf die proprietäre Cloudflare-Speicherarchitektur. Der Entwickler hat keine Kontrolle über Replikations-Topologien, Split-Brain-Fencing oder gezielte Standby-Promotionen.
- **`phi-spaces`-Umsetzung**:
  - Bietet eine vollwertige, selbstgehostete Hochverfügbarkeits-Architektur über **Primary/Sync Replikation ([`src/primary-sync.ts`](file:///media/data/programming/phi-spaces/src/primary-sync.ts))** und **Replica-Control ([`src/replica-control.ts`](file:///media/data/programming/phi-spaces/src/replica-control.ts))**:
    - **Deterministisches Journal:** Synchrone Replikation von Commit-Intents an Standby-Replikate vor Beantwortung des Clients.
    - **Kryptografisches Fencing & Boot Guards:** `SimulatorFencing`, Netcup-SCP-Fencing ([`src/netcup-fencing.ts`](file:///media/data/programming/phi-spaces/src/netcup-fencing.ts)) und Container-Fencing ([`src/container-fencing.ts`](file:///media/data/programming/phi-spaces/src/container-fencing.ts)) stellen sicher, dass ein isolierter Primärknoten keine unberechtigten Schreibvorgänge ausführt.
    - **Kontrollierte Promotion & Degradation:** `promoteStandby` und `degradeToSingle` ermöglichen Failover ohne Datenverlust mit Epochen-Inkrementierung.

---

### 2.8 Cluster-Transaktionsgrenzen im HRW-Föderationsnetzwerk (Stufe v5)

- **Earendil-Vorlage**:
  - Innerhalb einer Session-DB sind alle Tabellen und Konversationen in einer lokalen Transaktion atomar manipulierbar.
- **`phi-spaces`-Umsetzung**:
  - Im Föderations-Cluster (`FederatedSpace` mit HRW-Sharding nach `threadId`) werden Threads auf verschiedene Member-Spaces verteilt.
  - ⚠️ **Harte architektonische Grenze:**  
    Eine Transaktion in `phi-spaces` ist **strikt an genau einen Member-Knoten gebunden**. Ein Versuch, innerhalb derselben Transaktion Entries zu schreiben, die nach HRW auf unterschiedliche Member gehören, wird mit `RoutingConflict` abgewiesen.
  - **Konsequenz für Entwickler:** Multi-Thread-Operationen (wie das Zusammenführen zweier Threads oder threadübergreifende Massen-Updates) können nicht in einer einzelnen ACID-Transaktion ausgeführt werden, sondern erfordern asynchrone Saga-/Task-Chains.

---

## 3. Durchgehende Steuerung & Einsicht: Anspruch vs. Realität

| Steuer- & Einsichtsebene | Spezifizierter Soll-Zustand (Dokumentation) | Tatsächlicher Ist-Zustand im Code | Status |
|---|---|---|---|
| **1. Space- & Objekt-Einsicht** | Einsicht über `listSpaces`, `readPage()`, `changes()` im Live-Inspector, `AdminSpaces`, Dashboard und TUI über alle Stufen (`chat-session-stage-v1..v6`). | Vollständig funktionsfähig inkl. echter Spiegelung der Stufen `v1`–`v6` via `mirrorStageSnapshot`. | ✅ Funktioniert wie dokumentiert. |
| **2. Space-Lebenszyklus (`SpaceLifecycle`)** | `apply({ action: "create" \| "archive" \| "reactivate" \| "delete" })` steuert Spaces lokal und über Föderationsgrenzen. | Backend und Web-Frontend (`AdminSpacesView.tsx`) unterstützen alle 4 Aktionen inkl. `deleteSpace`. | ✅ Funktioniert wie dokumentiert. |
| **3. Worker-Steuerung (`WorkerSupervisor`)** | Startet/stoppt Worker-Schleifen dynamisch (`chat-worker`, `search-subagent`, `sieve`). | Funktioniert lokal und im Admin-Controller mit gemeinsamen Exportern (`SIEVE_EXPORTER`). | ✅ Funktioniert wie dokumentiert. |
| **4. Laufsteuerung (`RunGate` / `RunController`)** | `RunController` sperrt/öffnet `RunGate` mit bestätigter ACK-Barriere in Stufe `v6`. | In Stufe `v6` und im `WebAdminController` vollständig implementiert und dokumentiert. | ✅ Funktioniert wie dokumentiert. |
| **5. Bootstrap-Config (`DeploymentController`)** | Deklaratives JSON-Schema richtet Spaces und Worker idempotent ein (in `AdminSpaces` Panel 7). | Vollständig implementiert und getestet (`test/test-deployment.test.ts`). | ✅ Funktioniert wie dokumentiert. |

---

## 4. Reale Vor- und Nachteile der Ausbaustufen (`v1` bis `v6`)

### Stufe `v1`: In-Memory Space (`MemoryStorage` + `PhiSpaces`)
- **Vorteile:** Null Setup, extrem schnell (< 5 ms Start), identische Semantik für Transaktionen, $O(1)$ Pointer-Thread-Forking und `CompletionProfiles`.
- **Echte Grenze:** Flüchtig; kein `RunGate` im Chat aktiv.

### Stufe `v2`: Lokaler Durable Space (`SQLite` / `JSONL` + `PhiSpaces`)
- **Vorteile:** Volle lokale Crash-Sicherheit (ACID), persistente `RequestRef`-Claims, TimerLock-Alarme überleben Serverneustart.
- **Echte Grenze:** Single-Owner-Dateisperre auf der SQLite-Datei; kein Multi-Process-Zugriff ohne Service-Schicht.

### Stufe `v3`: Entkoppelter Netzwerk-Space (`SpaceService` + `RemoteSpace` über Socket/TCP)
- **Vorteile:** Klare Trennung: Host-Prozess besitzt Speicher exklusiv; Web-Gateway und Worker laufen in getrennten Prozessen.
- **Echte Grenze:** Serialisierungsaufwand; Behandlung von `OutcomeUnknown` bei Socket-Abbrüchen während des Commits nötig.

### Stufe `v4`: Kryptografisch gesicherter Space (`startGate` Schicht A/B + 60s-Grants)
- **Vorteile:** Zero-Trust über NetBird-Identität (Schicht A) + Ed25519-Challenge (Schicht B); kurzlebige 60s-Grants; Key-Rotation.
- **Echte Grenze:** Höherer Einrichtungsaufwand für Schlüssel und Boot-Guard.

### Stufe `v5`: Föderierter Cluster (`FederatedSpace` + HRW-Routing)
- **Vorteile:** Horizontale Lastverteilung über Member-Spaces nach `threadId`; clusterweite Suchläufe über `federated.readAll`.
- **Echte Grenzen:**
  - Keine member-übergreifenden Transaktionen (`RoutingConflict`).
  - In `v5-federated-cluster/run.ts` läuft der Demo-Runner für schnellen Null-Konfigurations-Start in-process mit vier Harnesses (die echten TCP-Föderationstests liegen in `test/test-federation-runtime.test.ts`).

### Stufe `v6`: Mobile & Web Administration (`RunGate` + Smartphone-Steuerung)
- **Vorteile:** Zentrale Steuerung über Termux-Phone (`spaces.html`/`steuerung.html`) und Web (`AdminSpacesView`). Echte koordinierte Barrieren über `RunController`.
- **Echte Grenze:** Nur im Koordinator-Verbund voll nutzbar.

---

## 5. Zusammenfassende Entscheidungsmatrix

| Kriterium / Szenario | Empfehlung: Earendil Cloudflare DO | Empfehlung: `phi-spaces` (`v1`–`v6`) |
|---|---|---|
| **Serverless Scale-to-Zero für tausende meist inaktive Einzel-Sessions** | **Ideal**: Durable Objects schlafen kostenlos ein und wachen bei WebSocket/Alarm in Millisekunden auf. | Weniger geeignet, da der Space-Host als permanenter Server-Prozess läuft. |
| **Volle Datenhoheit, On-Premise, Linux-VPS, Docker oder Offline** | Nicht möglich (proprietäre Cloudflare-Plattformbindung). | **Ideal (`v1`–`v6`)**: Läuft komplett selbstgehostet auf Node.js + SQLite ohne Cloud-Zwang. |
| **Strikte serverseitige Ergebnisverträge für unzuverlässige KI-Worker** | Nicht vorhanden; muss manuell im Anwendungscode geprüft werden. | **Ideal**: Serverseitige `CompletionProfiles`, automatische Rückkehr bei Lease-Ablauf. |
| **Horizontale Skalierung großer Räume über mehrere Server** | Nicht möglich (eine Session ist fest an genau ein Durable Object gebunden). | **Ideal (`v5`)**: Deterministic HRW-Sharding verteilt Threads auf mehrere Hosts. |
| **Ausgereifte Hochverfügbarkeit & Disaster Recovery (AP3)** | Intransparente Cloudflare-Blackbox. | **Ideal**: Vollständige Transparenz mit Primary-Sync-Journal, Fencing und Standby-Promotion. |
| **Zeichen-für-Zeichen Token-Streaming (< 10 ms)** | **Ideal**: `watchEvents` streamt Tokens direkt aus der laufenden Modellgenerierung. | Nicht dafür konzipiert: Optimiert für diskrete transaktionale Zustandswechsel bei Commit. |
| **Schnelles Thread-Forking bei riesiger Historie (> 10.000 Msgs)** | **Ideal**: $O(1)$ Copy-on-Write im Dokumentbaum. | **Ideal**: $O(1)$ Pointer-basierte Copy-on-Write-Auflösung (`parentThreadId` + `forkUpToSeq`). |

---

## 6. Dokumentierte Lücken & Umsetzungsstatus

| ID | Komponente | Festgestellte Lücke / Fehler | Status & Umsetzung |
|---|---|---|---|
| **GAP-1** | `chat-core.ts` | **$O(N)$ Thread-Forking Duplizierung**: Geerbte Nachrichten wurden einzeln physisch neu geschrieben. | ✅ **ERLEDIGT**: `forkThread` schreibt nur noch den `Thread`-Eintrag ($O(1)$); `SpaceChatEngine.resolveMessagesForThread` löst Ancestor-Nachrichten bis `forkUpToSeq` per Pointer-Kette auf. |
| **GAP-2** | Doku / Stages | **`RunGate`-Verfügbarkeit ab v1 behauptet**: Chat-Stufen v1–v5 enthalten kein `RunGate`. | ✅ **ERLEDIGT**: Dokumentation und Vergleichstabellen präzisiert (`RunGate` als Stufe-`v6`-Feature klargestellt). |
| **GAP-3** | `stage-runner.ts` | **Alarm-Aufgabenverlust bei Mehrfach-Trigger**: `tickAlarms()` liefert N Alarme, verarbeitete aber nur 1. | ✅ **ERLEDIGT**: Schleife über alle ausgelösten Alarm-IDs in `stage-runner.ts` implementiert. |
| **GAP-4** | `chat-core.ts` / `swarm.ts` | **Unindizierte Scans & Stopwort-Bug**: Fallback auf "postgresql"; fehlende Template-Filter in `swarm.ts`. | ✅ **ERLEDIGT**: Neutrale Fallback-Begriffe `["space", "entry", "chat"]`; gezielte Space-Template-Filter in `swarm.ts`. |
| **GAP-5** | Doku | **Fehlende Replikations-Darstellung (AP3)**: Primary/Sync-Replikation fehlte im Vergleich. | ✅ **ERLEDIGT**: Kapitel 2.7 (AP3 Primary/Sync Replikation, Fencing, Promotion) ergänzt. |
| **GAP-6** | `AdminSpacesView`| **Fehlende Löschfunktion**: `deleteSpace` existierte im Backend, fehlte aber im Frontend. | ✅ **ERLEDIGT**: Lösch-Button mit Bestätigungsdialog in `AdminSpacesView.tsx` ergänzt. |
| **GAP-7** | `admin-controller`| **Flüchtige Idempotenz**: Admin-Operationen lagen nur in flüchtiger Map. | ✅ **ERLEDIGT**: `#operations` wird beim Server-Boot aus den persistenten `Result`-Einträgen im `CONTROL_SPACE` rekonstruiert. |
| **GAP-8** | `v5-cluster` | **In-Process Demo-Runner**: `v5-federated-cluster` nutzt 4 Memory-Harnesses für 0-Setup-Ausführung. | ℹ️ **Architekturentscheidung**: Schneller In-Process-Demo-Runner für die Hilfe-Workbench; echte TCP-Föderationstests laufen in `test/test-federation-runtime.test.ts`. |
