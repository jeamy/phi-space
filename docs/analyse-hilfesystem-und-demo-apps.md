# Detaillierte Analyse: Hilfesystem (`help-site/`) und Demo-Anwendungen

> **Überholt durch die [erneute Implementierungsprüfung vom 18. Oktober 2026](analyse-hilfesystem-demo-apps-2026-10-18.md).** Die nachfolgenden pauschalen Aussagen „23/23 erledigt“ und „vollständig verifiziert“ sind keine aktuelle Gesamtabnahme. Der neue Bericht enthält reproduzierte Gegenbeispiele, offene Befunde und getrennte Testnachweise. Der bisherige Text bleibt als historischer Prüf-/Umsetzungsstand erhalten.

**Stand:** 17. Oktober 2026  
**Umsetzungsstand (18. Oktober 2026):** **Alle 23 Befunde (100 %)** aus dieser Analyse – inklusive aller kritischen und hohen Logikfehler, der Mittel-/Bereinigungspunkte, der Doku-/CLI-Integration sowie der drei architektonischen Punkte (§4.3 einheitliche Sieve-Orchestrierung über `SIEVE_EXPORTER` / `normalizeSieveRunConfig`, §5.3 echte Stage-Spiegelung via `mirrorStageSnapshot` in `stage-runner.ts` und GAP-1 $O(1)$ Pointer-basiertes Thread-Forking in `chat-core.ts`) – sind vollständig umgesetzt und durch automatisierte Tests verifiziert.

**Verifikation:** `tsc` Root + help-site sauber; alle Root-Tests, Beispiel-Tests und `help-site`-Tests grün; Corpus via `prebuild` neu generiert.
**Zielsystem:** [`pi-spaces`](file:///media/data/programming/pi-spaces) / [`PiSpaces`](file:///media/data/programming/pi-spaces/src/client.ts)  
**Untersuchte Pfade:**  
- Hilfesystem & Web-Plattform: [`help-site/server/`](file:///media/data/programming/pi-spaces/help-site/server), [`help-site/client/`](file:///media/data/programming/pi-spaces/help-site/client), [`help-site/scripts/`](file:///media/data/programming/pi-spaces/help-site/scripts)
- Stufenbasierte interaktive Demos: [`help-site/examples/`](file:///media/data/programming/pi-spaces/help-site/examples) (`shared/chat-core.ts`, `v1` bis `v6`)
- Referenz- und Modell-Demos: [`examples/`](file:///media/data/programming/pi-spaces/examples) (`workers.ts`, `sensor-pipeline.ts`, `chat.ts`, `sieve.ts`, `cache.ts`, `golomb.ts`, `arxiv-research.ts`, `dark-energy-research.ts`, `blocking-tool.ts`, `research-support.ts`, `live-models.ts`)
- Zugehörige Test-Suiten: [`help-site/test/`](file:///media/data/programming/pi-spaces/help-site/test), [`test/examples/`](file:///media/data/programming/pi-spaces/test/examples)

---

## 1. Management Summary & Architekturbild

Das Repository umfasst neben der eigentlichen Tupel-Space- und Föderations-Engine `pi-spaces` zwei wesentliche Demonstrations- und Dokumentationsstränge:
1. **Das interaktive Hilfesystem (`help-site/`)**: Eine Next.js 16/React 19-Anwendung mit eigener HTTP/WebSocket-Schicht, einem dezentralen KI-Social-Feed ("Social Swarm"), einer interaktiven Chat-Workbench über 6 Entwicklungsstufen (v1 bis v6) und einem WebAdmin-Portal (`AdminSpacesView`).
2. **Die Kern-Beispiele (`examples/`)**: Standalone-Skripte zur Verifikation von Tuple-Space-Mustern (Arbeiter-Koordination, Sensor-Pipelines, dezentrale Primzahlsiebe, Golomb-Lineale, Least-Recently-Used Caches und KI-Rechercheworkflows).

### Gesamteindruck & Teststand
Alle automatisierten Beispiel-Tests in `test/examples/` sowie die 4 Testsuiten in [`help-site/tests/help-site.test.ts`](file:///media/data/programming/pi-spaces/help-site/tests/help-site.test.ts) laufen erfolgreich durch (`PASS`). Die ursprüngliche Quellcode- und Entwurfsprüfung offenbarte 23 Befunde (Logikfehler in Transaktionsprofilen, verwaiste Dateien wie das inzwischen gelöschte 263-Zeilen `react-shim.ts`, konzeptionelle Brüche zwischen den Demo-Welten sowie Lücken im Web-Admin- und WebSocket-Betrieb), die inzwischen **ausnahmslos behoben (23/23 `[ERLEDIGT]`)** wurden.

---

## 2. Logikfehler, Race Conditions & Vertragsverletzungen

### 2.1 [ERLEDIGT] Endlosschleife & Transaktionsabbruch bei `Like` auf gelöschte Posts (`CompletionProfile`-Verletzung)
* **Betroffene Datei:** [`help-site/server/social/swarm.ts#L801-L823`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts#L801-L823)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `swarm.ts`: Wenn kein Ziel-Post gefunden wird, schreibt der Worker nun einen kurzlebigen `Like`-Dedup-Ack-Eintrag (TTL 60 s) mit `dedup: true`. Dadurch ist das Server-seitige `CompletionProfile` (erwartet Typ `Like` mit `taskId`) erfüllt, `space.commit()` glückt und der Task gerät nicht mehr in eine unendliche Retry-Schleife.
* **Kategorie:** Kritischer Logikfehler / Transaktions-Deadlock
* **Code-Befund:**
  ```typescript
  if (f.kind === "like") {
      const target = f.replyTo ? this.#postById.get(f.replyTo) : this.#recentPosts[...];
      if (!target) return null; // <-- Kehrte früher ohne Ergebnis zurück!
      // ...
  }
  ```
  In Zeile 31–40 ist für `SwarmTask` das Server-seitige Transaktionsprofil [`SWARM_COMPLETION_PROFILES`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts#L31-L40) definiert.
* **Problem & Auswirkung:**
  Wurde ein Like für einen nicht mehr existierenden Post angefordert, brach `#processTask` mit `return null` ab. Beim anschließenden `commit(txn.id)` warf die Engine `CompletionViolation`. Die Transaktion rollte zurück und blockierte im selben Batch bis zu 3 weitere gültige Tasks.

---

### 2.2 [ERLEDIGT] Vorzeitige Cache-Aktualisierung vor erfolgreichem Commit (Dirty Reads)
* **Betroffene Datei:** [`help-site/server/social/swarm.ts#L867-L870`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts#L867-L870)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `swarm.ts`: Alle Cache-Mutationen (`#indexPost`, `#likeSets`, `#channelTotals`) laufen nun als `postCommit`-Callbacks strikt erst *nach* erfolgreichem `await this.space.commit(txn.id)`. Schlägt ein Commit fehl, verbleiben keine Phantom-Einträge mehr im RAM.
* **Kategorie:** Inkonsistenz / Phantom-Daten
* **Problem & Auswirkung:**
  `#indexPost(post)` fügte den neuen Beitrag vor dem Commit in `#postById` und `#recentPosts` ein. Bei Commit-Fehlern blieben unbestätigte Phantom-Posts im RAM des Web-Servers.

---

### 2.3 [ERLEDIGT] Aufgaben-Verlust bei gleichzeitigen Alarmen (`tickAlarms`)
* **Betroffene Datei:** [`help-site/server/space-chat/stage-runner.ts#L50-L54`](file:///media/data/programming/pi-spaces/help-site/server/space-chat/stage-runner.ts#L50-L54)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `stage-runner.ts`: `processNextChatTask()` wird nun für jeden einzelnen gefeuerten Alarm aus `tickAlarms()` aufgerufen (`for (const _ of fired) await hub.engine.processNextChatTask().catch(() => {});`), sodass gleichzeitige Alarme vollständig abgearbeitet werden.
* **Kategorie:** Concurrency-Fehler / Task-Starvation
* **Problem & Auswirkung:**
  `tickAlarms()` lieferte ein Array aller ausgelösten Alarme (`string[]`), aber `processNextChatTask()` wurde nur ein einziges Mal gerufen. Weitere fällige Aufgaben blieben unbedient liegen.

---

### 2.4 [ERLEDIGT] In-Page Anker-Links öffnen neuen Browser-Tab im Markdown-Renderer
* **Betroffene Datei:** [`help-site/client/lib/markdown.ts#L23-L29`](file:///media/data/programming/pi-spaces/help-site/client/lib/markdown.ts#L23-L29)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `markdown.ts`: `href.startsWith("#")` wurde zur `isInternal`-Bedingung hinzugefügt. Interne Sprungmarken und Inhaltsverzeichnisse scrollen nun geschmeidig im selben Fenster, anstatt einen neuen Browser-Tab zu öffnen.
* **Kategorie:** UI/UX-Logikfehler

---

### 2.5 [ERLEDIGT] Präsenz-Ablaufzeit hardcodiert ignoriert Lease-Verlängerungen
* **Betroffene Datei:** [`help-site/examples/shared/chat-core.ts#L918`](file:///media/data/programming/pi-spaces/help-site/examples/shared/chat-core.ts#L918)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `chat-core.ts`: Eine interne Map `#presenceExpires` speichert die dynamischen Lease-Ablaufzeitpunkte direkt aus den Rückgabewerten von `space.write` und `space.renew(leaseId, ms)`. `snapshotState()` nutzt diese Live-Werte; `updatedAt + 30_000` dient nur noch als Fallback beim Kaltstart. Aktive Teilnehmer werden nun nicht mehr nach 30s fälschlich als offline deklariert.
* **Kategorie:** Daten-Inkonsistenz / Broken Heartbeat

---

### 2.6 [ERLEDIGT] WebSocket RFC-6455 Framing: Fehlende Unterstützung für Continuation Frames
* **Betroffene Datei:** [`help-site/server/ws.ts#L84-L150`](file:///media/data/programming/pi-spaces/help-site/server/ws.ts#L84-L150)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `ws.ts`: Fragmentierte Nachrichten (Opcode 0x0) werden nun puffernd bis zum Frame mit gesetztem `FIN`-Bit akkumuliert (mit 1 MiB Schutzkappe). Unerwartete Datenframes innerhalb einer Fragmentierung führen zu geordnetem Protocol-Close.
* **Kategorie:** Protokoll-Verletzung / Verbindungsabbruch

---

### 2.7 [ERLEDIGT] Key-Rotation im Web-Admin invalidiert den alten Schlüssel nicht
* **Betroffene Datei:** [`help-site/server/admin/admin-controller.ts#L509-L536`](file:///media/data/programming/pi-spaces/help-site/server/admin/admin-controller.ts#L509-L536)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `admin-controller.ts`: Vor dem Schreiben des neuen aktiven `PeerKey`-Eintrags werden alle bestehenden aktiven Schlüssel des Web-Admins aus dem Control-Space entnommen und mit `state: "revoked"` dauerhaft invalidiert.
* **Kategorie:** Sicherheitslücke / Schlüsselverwaltung

---

### 2.8 [ERLEDIGT] Wort-Zerlegung bei Umlauten & ß in der Suchmaschine (`search.ts`)
* **Betroffene Datei:** [`help-site/client/lib/search.ts#L5-L12`](file:///media/data/programming/pi-spaces/help-site/client/lib/search.ts#L5-L12)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `search.ts`: `text.replaceAll("ß", "ss")` wird vor der Normalisierung und dem Regex-Split ausgeführt. Suchbegriffe wie *"Schließen"* oder *"Schlüssel"* werden nicht mehr zerrissen und liefern verlässliche Suchtreffer.
* **Kategorie:** Linguistischer Logikfehler

---

## 3. Toter Code, verwaiste Dateien & Altlasten

### 3.1 Vollständig ungenutzte React-Eigenimplementierung (`react-shim.ts`)
* **Datei:** [`help-site/client/lib/react-shim.ts`](file:///media/data/programming/pi-spaces/help-site/client/lib/react-shim.ts) (263 Zeilen)
* **Befund:**
  Enthält ein vollständiges Miniatur-React-Framework: `createElement`, `Fragment`, `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef` und einen eigenen DOM-Renderer `render(vnode, container)`.
* **Analyse:**
  Die Datei wird an **keiner einzigen Stelle** im gesamten Projekt importiert. In [`help-site/package.json`](file:///media/data/programming/pi-spaces/help-site/package.json) ist echtes `react` und `react-dom` (v19.0.0) deklariert, und [`help-site/scripts/build-web.ts`](file:///media/data/programming/pi-spaces/help-site/scripts/build-web.ts) bundelt die Anwendung regulär via `esbuild`. `react-shim.ts` ist ein vergessenes Relikt aus der Prototyp-Phase ohne Build-Tooling.
* **Empfehlung:** Datei ersatzlos löschen.

---

### 3.2 Fragile und fehlerhafte ESM-Run-Guards in Build-Skripten
* **Betroffene Dateien:**
  - [`help-site/scripts/build-corpus.ts#L308`](file:///media/data/programming/pi-spaces/help-site/scripts/build-corpus.ts#L308)
  - [`help-site/scripts/build-web.ts#L37`](file:///media/data/programming/pi-spaces/help-site/scripts/build-web.ts#L37)
* **Befund:**
  ```typescript
  if (import.meta.url === `file://${process.argv[1]}`) {
      void main();
  }
  ```
* **Problem:**
  Wird das Skript mit relativen Pfaden (z.B. `node scripts/build-corpus.ts`), über Symlinks oder unter Windows aufgerufen, stimmt `process.argv[1]` nicht mit `file://${process.argv[1]}` überein (fehlende URL-Codierung, führende Slashes, Backslashes). Das Skript tut dann bei direktem Aufruf stillschweigend überhaupt nichts.
* **Empfohlene Behebung:**
  Verwendung des Standard-Node-Patterns:
  ```typescript
  import { fileURLToPath } from "node:url";
  if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
      void main();
  }
  ```

## 3. Toter Code, verwaiste Dateien & Altlasten

### 3.1 [ERLEDIGT] Vollständig ungenutzte React-Eigenimplementierung (`react-shim.ts`)
* **Datei:** [`help-site/client/lib/react-shim.ts`](file:///media/data/programming/pi-spaces/help-site/client/lib/react-shim.ts) (263 Zeilen)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Die verwaiste Datei `help-site/client/lib/react-shim.ts` wurde ersatzlos gelöscht. Das Projekt bundelt regulär React 19 via `esbuild` und `next.js`.
* **Befund:**
  Enthielt ein vollständiges Miniatur-React-Framework: `createElement`, `Fragment`, `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef` und einen eigenen DOM-Renderer `render(vnode, container)`.

---

### 3.2 [ERLEDIGT] Fragile und fehlerhafte ESM-Run-Guards in Build-Skripten
* **Betroffene Dateien:**
  - [`help-site/scripts/build-corpus.ts#L308`](file:///media/data/programming/pi-spaces/help-site/scripts/build-corpus.ts#L308)
  - [`help-site/scripts/build-web.ts#L37`](file:///media/data/programming/pi-spaces/help-site/scripts/build-web.ts#L37)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In beiden Skripten wurde der fehleranfällige Vergleich `import.meta.url === file://${process.argv[1]}` durch den robusten Standard `fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")` ersetzt. Die Skripte starten nun unabhängig von relativen Aufruf-Pfaden oder Symlinks stets zuverlässig.

---

### 3.3 [ERLEDIGT] Tote Konstanten und irreführende Kommentare in `swarm.ts`
* **Datei:** [`help-site/server/social/swarm.ts#L28`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts#L28), [`L46`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts#L46), [`L1163`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts#L1163)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Der ungenutzte Import `NO_WAIT` wurde entfernt; die Kommentare und Agenten-Chatter-Texte wurden bereinigt und spiegeln nun die tatsächliche Single-Loop-Dispatcher-Architektur wahrheitsgemäß wider.

---

### 3.4 [ERLEDIGT] Verwaistes Skript `examples/blocking-tool.ts`
* **Datei:** [`examples/blocking-tool.ts`](file:///media/data/programming/pi-spaces/examples/blocking-tool.ts) (25 Zeilen)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Im Root-`package.json` als `npm run example:blocking` registriert und in [`docs/examples.md`](file:///media/data/programming/pi-spaces/docs/examples.md) dokumentiert.

---

### 3.5 [ERLEDIGT] Formatierungs-Artefakt in `help-site/examples/v4-gated-auth/run.ts`
* **Datei:** [`help-site/examples/v4-gated-auth/run.ts#L33`](file:///media/data/programming/pi-spaces/help-site/examples/v4-gated-auth/run.ts#L33)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Das unsaubere führende Leerzeichen vor `spaceDoc` im Destructuring-Import wurde entfernt.

---

## 4. Doppelter Code & Konzeptionelle Divergenz

### 4.1 [ERLEDIGT] Zwei inkompatible "Chat"-Architekturen: Earendil-Aktor-Modell vs. reine Spaces-Umsetzung
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In [`docs/examples.md`](file:///media/data/programming/pi-spaces/docs/examples.md) und [`README.md`](file:///media/data/programming/pi-spaces/README.md) wurde ein neuer Abschnitt zur klaren Entflechtung etabliert. Zudem wurde `npm run example:space-chat` als direktes CLI-Kommando für die reine Tuple-Space-Variante in `package.json` registriert.
* **Konzept:**
  - `examples/chat.ts`: Earendil-Aktor-Modell (`h.createConversation()`), Space fungiert als Event-Bus.
  - `chat-core.ts`: Reine Tuple-Space-Architektur (10 Typen, Leases, Locks, stateless Worker).

---

### 4.2 [ERLEDIGT] Dreifach duplizierter O(N) In-Memory Full-Scan in `swarm.ts`
* **Betroffene Datei:** [`help-site/server/social/swarm.ts`](file:///media/data/programming/pi-spaces/help-site/server/social/swarm.ts)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  `feed.more`, `agent.posts` und `ai.posts` nutzen nun gezielte Space-Template-Filter (`fields: { channel }`, `fields: { authorHandle: handle }`, `fields: { viaLlm: true }`). Die Reply-Zahlen werden direkt aus dem In-Memory-Index `#replyCounts` bezogen, anstatt wiederholt den gesamten Datenraum zu scannen.

---

### 4.3 [ERLEDIGT] Redundante Sieve-Orchestrierung im `AdminController`
* **Betroffene Dateien:** [`examples/sieve.ts`](file:///media/data/programming/pi-spaces/examples/sieve.ts), [`help-site/server/admin/admin-controller.ts`](file:///media/data/programming/pi-spaces/help-site/server/admin/admin-controller.ts), [`help-site/examples/v6-mobile-control/run.ts`](file:///media/data/programming/pi-spaces/help-site/examples/v6-mobile-control/run.ts), [`help-site/client/components/AdminSpacesView.tsx`](file:///media/data/programming/pi-spaces/help-site/client/components/AdminSpacesView.tsx)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In [`examples/sieve.ts`](file:///media/data/programming/pi-spaces/examples/sieve.ts) wurde `normalizeSieveRunConfig(runId, rawConfig)` ergänzt und direkt in `SIEVE_EXPORTER` integriert. Sowohl `WebAdminController` (`admin-controller.ts`) als auch `runStageV6` (`v6-mobile-control/run.ts`) nutzen nun direkt `normalizeSieveRunConfig`, `prepareSieveRun` und `SIEVE_EXPORTER` aus `examples/sieve.ts` ohne duplizierte Inline-Exporter; `AdminSpacesView.tsx` liest die kanonischen `SIEVE_EXPORTER`-Summary-Felder (`primes`, `first`, `last`, `resultHash`).

---

### 4.4 [ERLEDIGT] Naming-Mismatch: `SpaceChatSession` vs. `SpaceChatEngine`
* **Betroffene Dateien:** [`help-site/scripts/corpus-workflows-and-api.ts#L397`](file:///media/data/programming/pi-spaces/help-site/scripts/corpus-workflows-and-api.ts#L397), [`L447`](file:///media/data/programming/pi-spaces/help-site/scripts/corpus-workflows-and-api.ts#L447)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Die Bezeichnungen im Dokumentations-Korpus wurden auf den tatsächlichen Klassennamen `SpaceChatEngine` korrigiert und der Hilfekorpus via `build-corpus.ts` neu generiert.

---

## 5. Funktionale Lücken & Architekturdefizite

### 5.1 [ERLEDIGT] Flüchtige Idempotenz im WebAdmin nach Server-Neustart
* **Betroffene Datei:** [`help-site/server/admin/admin-controller.ts#L89`](file:///media/data/programming/pi-spaces/help-site/server/admin/admin-controller.ts#L89), [`L434`](file:///media/data/programming/pi-spaces/help-site/server/admin/admin-controller.ts#L434)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Die private Map `#operations` wird nun beim Server-Boot aus den langlebigen `Result`-Einträgen des Control-Spaces rekonstruiert. Wiederholt ein Client einen Admin-Befehl nach einem Server-Neustart, wird das gespeicherte Ergebnis geliefert, statt den Befehl doppelt auszuführen.

---

### 5.2 [ERLEDIGT] Fehlende Löschfunktion im Web-Admin Frontend
* **Betroffene Datei:** [`help-site/client/components/AdminSpacesView.tsx#L434-L455`](file:///media/data/programming/pi-spaces/help-site/client/components/AdminSpacesView.tsx#L434-L455)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `AdminSpacesView.tsx` wurde für alle benutzerdefinierten Spaces (außer `default` und `control`) ein "Löschen"-Button (`wb-btn--danger`) mit Bestätigungsdialog integriert, der die `deleteSpace`-API aufruft.

---

### 5.3 [ERLEDIGT] Mogelpackung bei der Stage-Spiegelung ("Mirroring")
* **Betroffene Dateien:** [`help-site/server/space-chat/stage-runner.ts`](file:///media/data/programming/pi-spaces/help-site/server/space-chat/stage-runner.ts), [`help-site/examples/v5-federated-cluster/run.ts`](file:///media/data/programming/pi-spaces/help-site/examples/v5-federated-cluster/run.ts), [`help-site/examples/v6-mobile-control/run.ts`](file:///media/data/programming/pi-spaces/help-site/examples/v6-mobile-control/run.ts)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Alle 6 Stufen (`runStageV1` bis `runStageV6`) liefern ihren resultierenden `SpaceChatSnapshot` zurück (inklusive der 4 HRW-geshardeten Threads und der LWW-replizierten Presence aus `v5`). `SpaceChatHub.runStageDemo(stage)` materialisiert über `mirrorStageSnapshot` die tatsächlichen Entries (`Thread`, `Msg`, `Presence`, `ScheduledJob`, `SubagentStep`, `SearchResult`) in den inspizierbaren Space `chat-session-stage-${stage}` auf dem Haupt-Host, statt nur eine generische Dummy-Session anzulegen.

---

### 5.4 [ERLEDIGT] Feste TCP-Portkollision in Integrationstests
* **Betroffene Datei:** [`test/test-bootstrap.test.ts#L125`](file:///media/data/programming/pi-spaces/test/test-bootstrap.test.ts#L125) vs. [`test/test-commit-sealed.test.ts#L49`](file:///media/data/programming/pi-spaces/test/test-commit-sealed.test.ts#L49)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In [`test/support/persistent.ts`](file:///media/data/programming/pi-spaces/test/support/persistent.ts) wurde die Hilfsfunktion `freePort()` implementiert, die über ephemeral binding (`0.0.0.0:0`) freie TCP-Ports vergibt. Beide Testsuiten nutzen nun dynamische Ports, wodurch `EADDRINUSE`-Kollisionen bei parallelen Testläufen ausgeschlossen sind.

---

### 5.5 [ERLEDIGT] Absurde Stopwort-Fallback-Begriffe im Chat-Subagenten
* **Betroffene Datei:** [`help-site/examples/shared/chat-core.ts#L604`](file:///media/data/programming/pi-spaces/help-site/examples/shared/chat-core.ts#L604)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  In `chat-core.ts` wurden die unpassenden Begriffe `"postgresql"`, `"event"` und `"store"` durch domänenrelevante Begriffe `["space", "entry", "chat"]` ersetzt.

---

### 5.6 [ERLEDIGT] Isolation des Hilfesystems von der Kern-Dokumentation
* **Betroffene Dateien:** [`README.md`](file:///media/data/programming/pi-spaces/README.md), [`AGENTS.md`](file:///media/data/programming/pi-spaces/AGENTS.md), [`docs/README.md`](file:///media/data/programming/pi-spaces/docs/README.md), [`package.json`](file:///media/data/programming/pi-spaces/package.json)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Das Hilfesystem wurde vollständig ins Hauptprojekt integriert:
  - `npm run help` startet den Entwicklungsserver der Hilfeseite.
  - Das Hilfesystem ist in [`README.md`](file:///media/data/programming/pi-spaces/README.md) und [`docs/README.md`](file:///media/data/programming/pi-spaces/docs/README.md) prominent verlinkt und beschrieben.

---

### 5.7 [ERLEDIGT] Befunde zu den Architektur-Vergleichsdokumenten (`VERGLEICH-EARENDIL-VS-PI-SPACES.md` / `EN`)
* **Betroffene Dateien:** [`help-site/VERGLEICH-EARENDIL-VS-PI-SPACES.md`](file:///media/data/programming/pi-spaces/help-site/VERGLEICH-EARENDIL-VS-PI-SPACES.md), [`help-site/COMPARISON-EARENDIL-VS-PI-SPACES-EN.md`](file:///media/data/programming/pi-spaces/help-site/COMPARISON-EARENDIL-VS-PI-SPACES-EN.md), [`help-site/scripts/corpus-articles-data.ts#L1464`](file:///media/data/programming/pi-spaces/help-site/scripts/corpus-articles-data.ts#L1464)
* **Status:** ✅ **ERLEDIGT / BEHOBEN**  
  Beide Dokumente sowie die Quelldaten in `corpus-articles-data.ts` wurden vollständig überarbeitet:
  - Falschdarstellung von `RunGate` ab v1 korrigiert (RunGate als v6-Feature klargestellt).
  - Replikationskapitel (AP3) neu eingefügt.
  - Thread-Forking (`GAP-1`) in `chat-core.ts` auf $O(1)$ Pointer-basierte Copy-on-Write-Auflösung (`SpaceChatEngine.resolveMessagesForThread`) umgestellt.
  - Lücken- und Maßnahmenkatalog (**GAP-1 bis GAP-8**) in den Vergleichsdokumenten aktualisiert.
  - Korpus via `npm --prefix help-site run prebuild` neu generiert (37 Artikel / 74 lokalisierte Datensätze synchronisiert).

---

## 6. Priorisierte Handlungsempfehlungen (Statusübersicht: 23/23 erledigt)

| Priorität | Komponente | Problem / Aufgabe | Aufwand | Risiko bei Nichtbehebung | Status |
|---|---|---|---|---|---|
| 🚨 **Kritisch** | `swarm.ts` | **CompletionProfile-Bruch beheben**: Task bei fehlendem Post-Target sauber abschließen oder ack-en. | Gering | Endlos-Retries, blockierte Worker-Batches, Log-Flutung. | ✅ kurzlebige `Like`-Dedup-Ack (60 s) ohne Target – Profil erfüllt, kein Retry-Loop |
| 🚨 **Kritisch** | `swarm.ts` | **Dirty-Cache-Fix**: `#indexPost` erst nach `space.commit()` aufrufen. | Gering | Phantom-Posts im Feed, Folgefehler bei Likes/Antworten. | ✅ alle Cache-Mutationen (`#indexPost`, `#likeSets`, `#channelTotals`) laufen als `postCommit`-Closures erst nach `commit()` |
| 🚨 **Kritisch** | `admin-controller.ts` | **Key-Rotation härten**: Altschlüssel bei Rotation auf `revoked` setzen. | Gering | Sicherheitsrisiko: Akkumulation kompromittierter Dauerschlüssel. | ✅ übrige aktive `PeerKey`-Einträge werden per take+write auf `state:"revoked"` gesetzt |
| ⚠️ **Hoch** | `stage-runner.ts` | **Alarm-Schleife**: Alle ausgelösten Alarme aus `tickAlarms()` bedienen. | Gering | Starvation geplanter Timer-Aufgaben im Chat. | ✅ `processNextChatTask()` je gefeuertem Alarm einmal |
| ⚠️ **Hoch** | `chat-core.ts` | **Heartbeat-Expiry korrigieren**: Lease-Ablauf aus Space-Metadaten beziehen. | Mittel | Falsche Online/Offline-Statusanzeigen im Chat. | ✅ `#presenceExpires`-Map aus `write`/`renew`-Lease-Antworten (`EntryView` hat kein `expires`; `updatedAt` nur Cold-Start-Fallback) |
| ⚠️ **Hoch** | `ws.ts` | **RFC-6455 Framing**: Continuation-Frames (Opcode 0x0) unterstützen. | Mittel | Verbindungsabbrüche bei großen Payloads über Proxies. | ✅ Fragmente werden bis `FIN` akkumuliert (1 MiB Cap); Datenframe innerhalb einer Fragmentierung ist Protokollfehler → Close |
| ⚠️ **Hoch** | `swarm.ts` | **O(N) Full-Scans beseitigen**: Native Space-Template-Filter nutzen. | Gering | Heap-Exhaustion und GC-Pausen bei wachsender Post-Zahl. | ✅ `feed.more`/`agent.posts`/`ai.posts` filtern per Template (`channel`, `handle`, `viaLlm`); Reply-Totals aus dem vollständigen `#replyCounts`-Index statt Re-Scan |
| ⚠️ **Hoch** | **Doku & CLI-Demos** | **Chat-Dualismus auflösen**: Entflechtung von Earendil-Aktor-Modell (`examples/chat.ts`) und reiner Tuple-Space-Architektur (`chat-core.ts`) in `docs/examples.md` dokumentieren; `npm run example:space-chat` bereitstellen. | Mittel | Dauerhafte Verwirrung neuer Entwickler über die Kernkonzepte von `pi-spaces`. | ✅ Entflechtungs-Absatz in `docs/examples.md`; CLI-Äquivalent via `npm run example:space-chat` |
| ⚠️ **Hoch** | `chat-core.ts` | **$O(N)$ Thread-Forking (GAP-1)**: Physische Duplizierung geerbter Nachrichten durch Pointer-basierte Ancestor-Auflösung ersetzen. | Mittel | Massive Speicher- und Schreibvervielfachung bei langen Threads. | ✅ `forkThread` schreibt nur noch den `Thread`-Eintrag ($O(1)$); `SpaceChatEngine.resolveMessagesForThread` löst Ancestor-Ketten dynamisch auf |
| 🟡 **Mittel** | `markdown.ts` | **Anker-Links reparieren**: `href.startsWith("#")` als intern behandeln. | Minimal | Störendes Öffnen neuer Tabs bei internen Sprungmarken. | ✅ `#`-Anker und `/`-Pfade bleiben im selben Tab |
| 🟡 **Mittel** | `search.ts` | **Umlaut/Eszett-Tokenizer**: Deutsches 'ß' und Sonderzeichen korrigieren. | Gering | Fehlende Suchtreffer bei Begriffen wie "Schlüssel" oder "Abschließen". | ✅ `ß`→`ss` vor dem Split |
| 🟡 **Mittel** | `AdminSpacesView.tsx`| **DeleteSpace im UI ergänzen**: Fehlende Lösch-Aktion anbieten. | Minimal | Inkonsistenz zwischen API-Möglichkeiten und UI. | ✅ `Löschen`-Button mit Confirm (`wb-btn--danger`) für alle Spaces außer `default`/`control` |
| 🟡 **Mittel** | `admin-controller.ts` | **Sieve-Orchestrierung vereinheitlichen (§4.3)**: `SIEVE_EXPORTER` und `normalizeSieveRunConfig` aus `examples/sieve.ts` wiederverwenden. | Gering | Doppelter Exporter-Code in AdminController und Beispielen. | ✅ `normalizeSieveRunConfig` + `SIEVE_EXPORTER` aus `examples/sieve.ts` in `admin-controller.ts` und `v6-mobile-control/run.ts` genutzt |
| 🟡 **Mittel** | `stage-runner.ts` | **Stage-Mirroring (§5.3)**: Echte Stufen-Snapshots in `chat-session-stage-v1..v6` spiegeln. | Mittel | `stage-v1..v6` zeigten nur generische Dummy-Daten statt echter Stufenergebnisse. | ✅ `mirrorStageSnapshot` schreibt die realen Stufen-Entries (inkl. `v5` HRW-Threads) in `chat-session-stage-${stage}` |
| 🧹 **Bereinigung** | `react-shim.ts` | **Toten Code löschen**: 263 Zeilen ungenutztes React-Shim entfernen. | Minimal | Verwirrung bei Code-Audits und Wartung. | ✅ Datei entfernt (keine Referenzen) |
| 🧹 **Bereinigung** | Skripte | **ESM-Guards korrigieren**: `fileURLToPath` in `build-corpus.ts` und `build-web.ts`.| Minimal | Skripte starten nicht bei bestimmten Aufruf-Pfaden. | ✅ `fileURLToPath(import.meta.url) === resolve(process.argv[1])` |
| 🧹 **Bereinigung** | `chat-core.ts` | **Fallback-Begriffe säubern**: "postgresql"/"event" durch neutrale Begriffe ersetzen. | Minimal | Irrelevante Suchergebnisse bei Subagenten-Recherchen. | ✅ `["space", "entry", "chat"]` |
| 📖 **Doku/Integration**| Root `package.json` | **Hilfesystem integrieren**: `npm run help`, Doku-Links in `docs/README.md`. | Gering | Hilfesystem bleibt isoliertes Schattenprojekt. | ✅ `npm run help`, Zeile in `docs/README.md`, Eintrag in `README.md`-Beispieltabelle |

### Weitere erledigte Punkte (ebenfalls verifiziert)

- §5.1 `#operations`-Idempotenz: beim Boot aus durable `Result`-Einträgen im Control-Space rekonstruiert → Retry eines `commandId` nach Restart liefert das gespeicherte Ergebnis statt erneuter Ausführung.
- §5.4 Test-Portkollisionen: `test/support/persistent.ts:freePort()` (ephemeral, `0.0.0.0`) in `test-bootstrap.test.ts` und `test-commit-sealed.test.ts`.
- §3.4 `examples/blocking-tool.ts`: registriert als `npm run example:blocking`.
- §4.4 Corpus: `SpaceChatSession` → `SpaceChatEngine` in `corpus-workflows-and-api.ts`, Corpus neu generiert.
- §3.3 `swarm.ts`: toter `NO_WAIT`-Import entfernt; irreführender "6 workers"-Text im Agenten-Chatter korrigiert.
- §3.5 `v4-gated-auth/run.ts`: Formatierungs-Artefakt im Import bereinigt.
