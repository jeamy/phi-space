# Implementierungs-Analyse: Beispiele in `/examples` (Version 2)

**Version:** 2.0  
**Datum:** 2026-10-06  
**Status:** ⚠️ **Überholt** — Stand vor der Korrektur vom 2026-10-07. Golomb und Dunkle Energie sind
inzwischen implementiert (`golomb.ts`, `dark-energy-research.ts`), die Test-Suite liegt unter
`test/examples/`. Aktueller Stand: [README.md](README.md) und [../examples.md](../examples.md).  
**Zweck:** Zuordnung aller implementierten Beispiele zu Testbeispiel-Dokumenten, inkl. Golomb-Lineal-Design

---

## 📋 Inhaltsverzeichnis

1. [Übersicht aller implementierten Beispiele](#1-übersicht-aller-implementierten-beispiele)
2. [Detaillierte Analyse pro Beispiel](#2-detaillierte-analyse-pro-beispiel)
   - [2.1 `workers.ts` – Master-Worker](#21-workersts--master-worker)
   - [2.2 `sensor-pipeline.ts` – IoT-Pipeline](#22-sensor-pipelinets--iot-pipeline)
   - [2.3 `chat.ts` – Space-basierter Chat](#23-chatts--space-basierter-chat)
   - [2.4 `arxiv-tool.ts` – arXiv-API-Tool](#24-arxiv-toolts--arxiv-api-tool)
   - [2.5 `arxiv-research.ts` – LLM-Forschungs-Pipeline](#25-arxiv-researchts--llm-forschungs-pipeline)
   - [2.6 `live-models.ts` – LLM-Modell-Konfiguration](#26-live-modelsts--llm-modell-konfiguration)
   - [2.7 `blocking-tool.ts` – Blockierende Tool-Nutzung](#27-blocking-toolts--blockierende-tool-nutzung)
   - [2.8 **Golomb-Lineal – Designvorschlag**](#28-golomb-lineal--designvorschlag)
3. [Zuordnung zu Testbeispiel-Dokumenten](#3-zuordnung-zu-testbeispiel-dokumenten)
4. [Vergleich: LLM-Papers vs. Dunkle Energie](#4-vergleich-llm-papers-vs-dunkle-energie)
5. [Empfehlungen für Dokumentationsanpassungen](#5-empfehlungen-für-dokumentationsanpassungen)
6. [Zusammenfassung und nächste Schritte](#6-zusammenfassung-und-nächste-schritte)

---

---

## 1. Übersicht aller implementierten Beispiele

| **Datei** | **Beschreibung** | **Typ** | **Space-Operationen** | **Agenten** | **Komplexität** | **LLM** | **Persistenz** |
|-----------|----------------|---------|----------------------|------------|-----------------|---------|---------------|
| [`workers.ts`](../examples/workers.ts) | Einfaches Master-Worker: Boss postet Jobs, Worker nimmt Jobs | **Master-Worker** | `write(Job)`, `take(Job)` | Boss, Worker | ⭐ | ❌ | ❌ Memory |
| [`sensor-pipeline.ts`](../examples/sensor-pipeline.ts) | Pipeline: Collector → Analyst → Presenter mit Transaktionen | **Pipeline** | `write(Window/Reading/Done)`, `take(Window)` + `txn`, `readAll` | Window (Host), Collector, Analyst, Presenter | ⭐⭐⭐ | ❌ | ❌ Memory |
| [`chat.ts`](../examples/chat.ts) | Ring-Chat: alice → bob → carol → alice mit Space-Events | **Publish-Subscribe** | `write(Msg)`, `notify`, `readAll(Msg)` | Alice, Bob, Carol | ⭐⭐ | ⚠️ Optional | ❌ Memory |
| [`arxiv-tool.ts`](../examples/arxiv-tool.ts) | arXiv-API-Tool: Suchfunktion für Papers | **Tool/Erweiterung** | `arxiv_search` (extern) | - | ⭐⭐ | ❌ | ❌ |
| [`arxiv-research.ts`](../examples/arxiv-research.ts) | **Forschungs-Pipeline**: Collector → Analyst → Presenter für LLM-Papers | **Pipeline + LLM** | `write(Paper/Msg/CollectorDone/AnalyzeTask/PresentTask/Analysis/Report)`, `space_wait`, `readAll`, `txn` | Collector, Analyst, Presenter | ⭐⭐⭐⭐ | ✅ | ✅ JSONL |
| [`dark-energy-research.ts`](../examples/dark-energy-research.ts) | **Erweiterte Pipeline**: Crawler → Classifier → Summarizer → Analyst → Presenter + Chat + Monitor | **Pipeline + LLM + Analyse** | `write(PaperMetadata/ClassifiedPaper/PaperSummary/AnalysisResult/UserQuery/QueryResponse/SystemStatus)`, `space_wait`, `readAll`, `txn` | Crawler, Classifier, Summarizer, Analyst, Presenter, Chat, Monitor | ⭐⭐⭐⭐⭐ | ✅ | ✅ JSONL |
| [`live-models.ts`](../examples/live-models.ts) | LLM-Modell-Konfiguration | **Utility** | - | - | ⭐ | ❌ | ❌ |
| [`blocking-tool.ts`](../examples/blocking-tool.ts) | Blockierende Tool-Nutzung (Beispiel) | **Tool** | - | - | ⭐ | ❌ | ❌ |
| **Golomb-Lineal** | **Designvorschlag** | **Master-Worker + Backtracking** | `write(tasks)`, `take(tasks)`, `write(results)`, `txn` | Master, Worker, Validator, Monitor | ⭐⭐⭐⭐ | ❌ | ❌ (geplant) |

**Legende**:
- **Komplexität**: ⭐ = einfach, ⭐⭐⭐⭐ = sehr komplex
- **LLM**: ✅ = verwendet LLM, ⚠️ = optional, ❌ = nein
- **Persistenz**: ✅ = dauerhaft, ❌ = Memory-only

---

---

## 2. Detaillierte Analyse pro Beispiel

---

### 2.1 `workers.ts` – Einfaches Master-Worker

#### **Zweck**
Demonstration des **Grundlegenden Master-Worker-Patterns** ohne komplexe Logik.

#### **Space-Typen**
```typescript
{ type: "Job", fields: { op: string, file: string } }
```

#### **Agenten-Rollen**
| Agent | Rolle | Operationen | Implementierung |
|-------|-------|------------|----------------|
| `boss` | Erstellt Jobs | `space_write(Job)` | Faux-Provider (simuliert) |
| `worker` | Verarbeitet Jobs | `space_take(Job)` | Faux-Provider (simuliert) |

#### **Ablauf**
1. Boss: `space_write({type: "Job", fields: {op: "resize", file: "a.png"}})`
2. Worker: `space_take({type: "Job"})`
3. Worker "verarbeitet" Job (simuliert durch Faux-Provider)

#### **Technische Details**
- **Storage**: `MemoryStorage` (keine Persistenz)
- **Modell**: Faux-Provider (kein echtes LLM)
- **Transaktionen**: ❌ Nein
- **Leases**: ❌ Nein
- **Fehlertoleranz**: ❌ Nein (kein Checkpointing)

#### **Vollständiges Beispiel**
```typescript
// Auszug aus workers.ts
const boss = await harness.root(context, { agent });
const worker = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);

faux.setResponses([
  fauxAssistantMessage(fauxToolCall("space_write", { 
    type: "Job", 
    fields: { op: "resize", file: "a.png" } 
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage("posted"),
  fauxAssistantMessage(fauxToolCall("space_take", { type: "Job" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("took it"),
]);

await (await boss.submit({ type: "input", content: "post a job" }, context)).wait(context);
await (await worker.submit({ type: "input", content: "take a job" }, context)).wait(context);
```

#### **Zuordnung zu Dokumentation**
✅ **Entspricht**: [Master-Worker (Primzahlsieb)](../examples/sieve.md) – **Grundpattern**
- **Unterschiede**:
  - Kein DFS/Backtracking
  - Keine Aggregation
  - Keine Leases
  - Keine Fehlerbehandlung
- **Ähnlichkeiten**:
  - Master → Worker-Kommunikation
  - Task-Verteilung

#### **Empfehlung für Dokumentation**
- In `sieve.md` als **Referenzimplementierung für das Grundpattern** erwähnen
- Als **Einstiegsbeispiel** für neue Entwickler markieren

---

### 2.2 `sensor-pipeline.ts` – Sensor-Daten-Pipeline

#### **Zweck**
Demonstration einer **kompletten Pipeline-Architektur** mit Transaktionen und mehreren Agenten-Rollen.

#### **Architektur**
```
Window (Host) ──take under txn──► analyst ──Summary (same txn)──► presenter ──► Report
Reading / Done (collectors) ──read──┘
```

#### **Space-Typen**
```typescript
// Fenster (von Host erstellt)
{ type: "Window", fields: { id: string, sources: string[] } }

// Sensor-Daten (von Collector)
{ type: "Reading", fields: { 
  source: string, 
  window: string, 
  ts: number, 
  kind: string, 
  value: unknown 
} }

// Fertig-Meldung (von Collector)
{ type: "Done", fields: { source: string, window: string } }

// Aggregierte Statistik (von Analyst)
{ type: "Summary", fields: { 
  window: string, 
  stats: Record<string, Stat>, 
  missing: string[], 
  duplicates: number, 
  rejected: number 
} }

// Bericht (von Presenter)
{ type: "Report", fields: { window: string, text: string } }

interface Stat { n: number; min: number; max: number; avg: number }
```

#### **Agenten-Rollen**
| Agent | Rolle | Operationen | Implementierung |
|-------|-------|------------|----------------|
| `host` (Window) | Erstellt Analyse-Fenster | `write(Window)` | `JavaSpace` direkt |
| `collector` (station/forecast/cloud) | Liefert Sensor-Daten | `write(Reading)`, `write(Done)` | `role(h, id)` |
| `analyst` | Aggregiert Daten | `take(Window)` + `txn`, `readAll(Reading/Done)`, `write(Summary)` | `role(h, id)` |
| `presenter` | Erstellt Bericht | `take(Summary)`, `write(Report)` | `role(h, id)` |

#### **Ablauf (main-Funktion)**
```typescript
// 1. Setup
const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
const host = new JavaSpace(h, ctx);
const [station, forecast, cloud] = [1, 2, 3].map((id) => role(h, id));
const analysts = [10, 11].map((id) => role(h, id));
const presenter = role(h, 20);

// 2. Fenster erstellen
for (const w of ["w1", "w2"]) await openWindow(host, w);

// 3. Collector: Daten sammeln
await collect(station!, "station", "w1", [
  { ts: t0, kind: "temp", value: 11.2 },
  { ts: t0 + 5*60_000, kind: "temp", value: 10.8 },
  { ts: t0 + 5*60_000, kind: "temp", value: 10.8 } // duplicate
]);

// 4. Analysten: Daten analysieren (parallel)
const summaries = await Promise.all(analysts.map((a) => analyse(a, { doneTimeoutMs: 500 })));

// 5. Presenter: Berichte erstellen
for (let i = 0; i < 2; i++) console.log(await present(presenter));
```

#### **Besonderheiten**
✅ **Transaktionen**: Analyst verwendet `createTransaction` + `take` + `write` + `commit`
✅ **Deduplizierung**: `seen` Set für Duplicate-Detection
✅ **Validierung**: `typeof value === "number"` (Data, not instructions)
✅ **Metriken**: `duplicates`, `rejected` für Qualitätskontrolle
✅ **Wettlauf**: Analysten konkurrieren um Window-Entries
✅ **Fehlertoleranz**: Transaktions-Lease ermöglicht Resume

#### **Zuordnung zu Dokumentation**
✅ **Entspricht**: [IoT-Monitoring](../examples/iot.md) – **Pipeline-Architektur**
- **Unterschiede**:
  - Keine Alerts
  - Keine TTL für Sensor-Daten
  - Keine Echtzeit-Anforderungen
- **Ähnlichkeiten**:
  - Pipeline: Collector → Analyst → Presenter
  - Transaktionen für atomare Operationen
  - Mehrere Quellen (Collector)
  - Wettbewerbsorientiert (mehrere Analysten)

#### **Empfehlung für Dokumentation**
- In `iot.md` als **Referenzimplementierung** für die Pipeline markieren
- **Erweiterungsvorschlag**: Alert-Agent hinzufügen (könnte als Übung dienen)

---

### 2.3 `chat.ts` – Space-basierter Chat

#### **Zweck**
Demonstration von **Publish-Subscribe mit Space-Events** für Chat-Anwendungen.

#### **Architektur**
```
Host ──write(Msg)──► alice ──notify──► bob ──notify──► carol ──notify──► alice
                       │        │        │
                       ▼        ▼        ▼
                   write(Msg) write(Msg) write(Msg)
```

#### **Space-Typen**
```typescript
{ type: "Msg", fields: { room: string, from: string, to: string, n: number, text: string } }
```

#### **Agenten-Rollen**
| Agent | Rolle | Operationen | Implementierung |
|-------|-------|------------|----------------|
| `host` | Startet Chat | `write(Msg)` | `JavaSpace` direkt |
| `alice` | Teilnehmer | `notify(Msg, {to: "alice"})`, `readAll(Msg)`, `write(Msg)` | Conversation |
| `bob` | Teilnehmer | `notify(Msg, {to: "bob"})`, `readAll(Msg)`, `write(Msg)` | Conversation |
| `carol` | Teilnehmer | `notify(Msg, {to: "carol"})`, `readAll(Msg)`, `write(Msg)` | Conversation |

#### **Ablauf**
1. **Host**: `write(Msg, {room: "lobby", from: "host", to: "alice", n: 0, text: topic})`
2. **Jeder Agent** hat ein `notify`-Subscription für `Msg` mit `to: <name>`
3. **Agent** liest alle Nachrichten mit `readAll(Msg, {room: "lobby"})`
4. **Agent** schreibt Antwort mit `write(Msg, {to: next(name)})`
5. **Terminierung**: Nach `MAX_TURNS` (6 oder 9) oder Timeout

#### **Besonderheiten**
✅ **Space-Events**: `notify` für Nachrichtenzustellung
✅ **Transkript**: Alle Nachrichten bleiben im Space erhalten
✅ **Ring-Architektur**: alice → bob → carol → alice
✅ **Scripted/Faux**: Kann mit Faux-Provider (kein LLM) oder echtem LLM laufen
✅ **Deterministisch**: Mit Faux-Provider ist der Ablauf deterministisch

#### **Zuordnung zu Dokumentation**
✅ **Entspricht Teil von**: [LLM-Agenten (arXiv)](../examples/arxiv.md) – **Chat-Komponente**
- **Unterschiede**:
  - Einfacher Ring-Chat vs. komplexe Pipeline
  - Keine LLM-Integration (kann aber aktiviert werden)
- **Ähnlichkeiten**:
  - Space-Events für Nachrichtenzustellung
  - Publish-Subscribe-Pattern

#### **Empfehlung für Dokumentation**
- In `arxiv.md` als **Referenz für Chat-Funktionalität** erwähnen
- Als **Grundlage für komplexere Interaktionen** nutzen

---

### 2.4 `arxiv-tool.ts` – arXiv-API-Tool

#### **Zweck**
**Externes Tool** für arXiv-Suche, das als Space-Extension integriert ist.

#### **Space-Tool-Definition**
```typescript
arxiv_search: {
  description: "Search arXiv papers...",
  parameters: {
    query: string,           // arXiv-Suche (z. B. 'ti:\"attention\"')
    max?: number (1-25),    // Max. Ergebnisse
    fromYear?: number,      // Jahr von
    toYear?: number,        // Jahr bis
    sort?: "relevance" | "submittedDate"  // Sortierung
  },
  replay: "safe",           // Read-only
  execute: async (a) => { /*...*/ }
}
```

#### **Technische Details**
- **API**: `https://export.arxiv.org/api/query`
- **Rate-Limiting**: 3,1s zwischen Requests (Throttling mit Promise-Queue)
- **Parsing**: XML → JSON (CDATA-Handling, Entity-Decoding)
- **Ergebnis**: Array von `Paper`-Objekten mit:
  - `arxivId`, `title`, `year`, `authors`, `category`, `abstract`
- **Sicherheit**: `User-Agent: pi-spaces-example/0.1`

#### **Throttling-Implementierung**
```typescript
let queue: Promise<unknown> = Promise.resolve();
let last = 0;
const GAP_MS = 3100;

const throttled = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { last = Date.now(); }
  });
  queue = run.catch(() => {});
  return run;
};
```

#### **Zuordnung zu Dokumentation**
✅ **Wird verwendet in**: [LLM-Agenten (arXiv)](../examples/arxiv.md)
- **Funktion**: Ermöglicht Collector-Agenten, Papers zu finden

---

### 2.5 `arxiv-research.ts` – LLM-Forschungs-Pipeline

#### **Zweck**
**Komplette Forschungs-Pipeline** mit LLM-Agenten für die Auswertung von arXiv-Papern zu LLM-Entwicklung.

#### **Architektur**
```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Collector-1  │    │  Collector-2  │    │  Collector-3  │
│ (Grundlagen) │    │ (2018-2023) │    │ (ab 2020)   │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                   │                   │
       ▼                   ▼                   ▼
    ┌───────────────────────────────────────┐
    │               Space                    │
    │  Paper, Msg, CollectorDone, AnalyzeTask │
    └──────────────────────┬────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Analyst    │◄─────────────────┐
                    └──────┬──────┘              │
                           │              ┌──────▼──────┐
                           ▼              │   Presenter   │
                    ┌──────────────┐              └──────────────┘
                    │ AnalyzeTask  │
                    │ Analysis    │
                    │ PresentTask │
                    └──────┬──────┘
                           │
                           ▼
                    ┌──────────────┐
                    │    Report    │
                    │ (Markdown)   │
                    └──────────────┘
```

#### **Space-Typen**
```typescript
// Paper (von Collector)
{ type: "Paper", fields: {
  arxivId: string,
  title: string, 
  year: number, 
  authors: string, 
  approach: string,
  contribution: string,
  collector: string
} }

// Nachricht (von Collector)
{ type: "Msg", fields: { 
  room: string, 
  from: string, 
  to: string, 
  text: string 
} }

// Fertig-Meldung (von Collector)
{ type: "CollectorDone", fields: { 
  collector: string, 
  papers: number 
} }

// Analyse-Auftrag (von Host)
{ type: "AnalyzeTask", fields: { topic: string } }

// Analyse-Ergebnis (von Analyst)
{ type: "Analysis", fields: {
  order: number,
  title: string, 
  period: string,
  approaches: string[],
  keyPapers: string[],
  summary: string,
  limits: string
} }

// Präsentations-Auftrag (von Analyst)
{ type: "PresentTask", fields: { topic: string } }

// Bericht (von Presenter)
{ type: "Report", fields: { title: string, markdown: string } }
```

#### **Agenten-Rollen**
| Agent | Rolle | Fokus | Operationen | LLM | Storage |
|-------|-------|-------|------------|-----|---------|
| `collector-1` | Rechercheur | Grundlagen bis 2018 | `arxiv_search`, `write(Paper)`, `write(Msg)`, `write(CollectorDone)` | ✅ | JSONL |
| `collector-2` | Rechercheur | Pretraining & Skalierung 2018–2023 | gleich | ✅ | JSONL |
| `collector-3` | Rechercheur | Alignment & Reasoning ab 2020 | gleich | ✅ | JSONL |
| `analyst` | Analyst | Epochen-Analyse | `space_wait(AnalyzeTask)`, `readAll(Paper/Msg)`, `write(Analysis)`, `txn(commit)` | ✅ | JSONL |
| `presenter` | Präsentator | Markdown-Bericht | `space_wait(PresentTask)`, `readAll(Analysis/Paper)`, `write(Report)`, `txn(commit)` | ✅ | JSONL |

#### **Ablauf**
1. **Host**: Startet alle Agenten mit individuellen Instructions
2. **Collector**:
   - Führt bis zu 6 `arxiv_search`-Aufrufe durch
   - Prüft mit `space_read` auf Duplikate
   - Schreibt `Paper` (nur wenn nicht vorhanden)
   - Schreibt `Msg` (Notizen an Analyst)
   - Schreibt `CollectorDone` (Fertig-Meldung)
3. **Host**: Warte auf alle `CollectorDone` oder Timeout (15 Min.)
4. **Host**: `write(AnalyzeTask)`
5. **Analyst**:
   - `space_wait(AnalyzeTask)` (take, blockierend)
   - `readAll(Paper)` und `readAll(Msg)`
   - Gruppiert Papers in 4–7 Epochen
   - Schreibt `Analysis` für jede Epoche + Gesamtsicht
   - Schreibt `PresentTask`
   - `txn(commit)`
6. **Presenter**:
   - `space_wait(PresentTask)` (take, blockierend)
   - `readAll(Analysis)` und `readAll(Paper)`
   - Erstellt Markdown-Bericht
   - Schreibt `Report`
   - `txn(commit)`

#### **Besonderheiten**
✅ **State-Persistenz**: `NodeJsonlStorage` (JSON Lines für Resume)
✅ **Timeouts**: Collect 15 Min., Report 20 Min.
✅ **Transaktionen**: Analyst und Presenter verwenden `space_wait` + `txn`
✅ **Leases**: FOREVER für alle Einträge
✅ **LLM-Integration**: Echte Modelle oder Faux-Provider
✅ **Checkpointing**: Resume-Fähigkeit durch JSONL-Storage
✅ **Deduplizierung**: Collector prüfen auf bestehende Papers

#### **Collect-Prompts (Auszug)**
```typescript
const collector = (c: CollectorConfig) => `[agent:${c.name}] Du bist ${c.name} in einem Rechercheteam zum Thema: ${topic}.
Dein Schwerpunkt: ${c.focus} (${c.years}).

Vorgehen:
1. Suche mit arxiv_search, höchstens 6 Suchen.
2. Wähle 6 bis 10 Paper, die einen Ansatz begründet oder entscheidend verändert haben.
3. Prüfe mit space_read, ob Paper schon eingetragen ist.
4. Schreibe Paper in den Space (nur wenn nicht vorhanden).
5. Optional: Kurze Notiz an den Analysten.`;
```

#### **Zuordnung zu Dokumentation**
✅ **Entspricht**: [LLM-Agenten (arXiv)](../examples/arxiv.md) **für LLM-Papers**
- **Vollständige Übereinstimmung** mit der Pipeline-Beschreibung
- **Erweiterung**: Konkrete Prompts für Collector/Analyst/Presenter

#### **Empfehlung für Dokumentation**
- **Haupteintrag in `arxiv.md`** als **Referenzimplementierung für LLM-Papers**
- **Code-Referenz** für die Pipeline hinzufügen

---

### 2.6 `live-models.ts` – LLM-Modell-Konfiguration

#### **Zweck**
**Utility** zur Konfiguration von LLM-Modellen für die anderen Beispiele.

#### **Funktionalität**
- Lädt verfügbare Modelle aus Umgebungsvariablen
- Fallback: Erstes verfügbares Modell
- Unterstützt mehrere Provider (Mistral, OpenAI, etc.)

#### **Technische Details**
- **Umgebungsvariablen**: `PI_PROVIDER`, `PI_MODEL`
- **Authentifizierung**: Liest Credentials aus `~/.pi/agent/auth.json`
- **Fallback**: Erstes Modell aus `builtinModels()`

#### **Zuordnung zu Dokumentation**
✅ **Wird verwendet in**: `arxiv-research.ts`, `chat.ts`

---

### 2.7 `blocking-tool.ts` – Blockierende Tool-Nutzung

#### **Zweck**
Minimales Beispiel für **blockierende Tool-Nutzung** mit Timeout.

#### **Ablauf**
1. Agent ruft `space_take` mit Timeout auf
2. Ein anderer Prozess schreibt 300ms später die Entry
3. Take-Operation sollte erfolgreich sein

#### **Technische Details**
- **Storage**: `MemoryStorage`
- **Modell**: Faux-Provider
- **Timeout**: 5000ms

#### **Zuordnung zu Dokumentation**
✅ **Demonstriert**: Blockierende Operationen + Timeout-Handling
- Kann als **Testfall** für Tool-Timeouts verwendet werden

---

### 2.8 `dark-energy-research.ts` – Dunkle Energie-Forschungs-Pipeline

#### **Zweck**
**Erweiterte LLM-Pipeline** für Dunkle Energie/Dunkle Materie mit **mehreren Analyse-Stufen** und **interaktiven Abfragen**.

#### **Architektur**
```
┌─────────────┐    ┌─────────────┐    ┌──────────────┐
│   Crawler    │    │  Classifier  │    │  Summarizer   │
└──────┬──────┘    └──────┬───────┘    └───────┬──────┘
       │                   │                    │
       ▼                   ▼                    ▼
┌───────────────────────────────────────────────────────┐
│                    Space                               │
│  PaperMetadata, ClassifiedPaper, PaperSummary,          │
│  AnalysisResult, UserQuery, QueryResponse, SystemStatus │
└───────────────────────────────────┬───────────────────┘
                                        │
                                        ▼
                         ┌──────────────┐
                         │   Analyst    │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │  Presenter   │──► Presentation + dashboard.json
                         └──────┬───────┘
                                │
Parallel:  ┌──────────┐    ┌────────────┐
           │   Chat    │    │  Monitor    │
           └────┬──────┘    └─────┬──────┘
                │                   │
                ▼                   ▼
          UserQuery           SystemStatus
          QueryResponse
```

#### **Space-Typen**
```typescript
// Neu im Vergleich zu arxiv-research.ts:

// PaperMetadata (erweitert)
{ type: "PaperMetadata", fields: {
  arxivId: string, title: string, year: number, authors: string[],
  abstract: string, categories: string[], published: Date,
  classification?: { relevance: string, topics: string[], keywords: string[] }
} }

// ClassifiedPaper
{ type: "ClassifiedPaper", fields: {
  paperId: string, relevance: "high" | "medium" | "low",
  topics: string[], keywords: string[], confidence: number, classifiedAt: Date
} }

// PaperSummary
{ type: "PaperSummary", fields: {
  paperId: string, summary: string, keyFindings: string[],
  citationCount: number, model: string, summarizedAt: Date
} }

// AnalysisResult (für statistische Analysen)
{ type: "AnalysisResult", fields: {
  analysisType: "timeTrends" | "authorNetwork" | "topicClusters" | "citationAnalysis",
  data: any, timestamp: Date, model?: string
} }

// UserQuery & QueryResponse (für Chat)
{ type: "UserQuery", fields: { queryId: string, query: string, userId: string, timestamp: Date } }
{ type: "QueryResponse", fields: { queryId: string, response: string, sources: string[], model: string, confidence?: number, timestamp: Date } }

// SystemStatus (für Monitoring)
{ type: "SystemStatus", fields: {
  timestamp: Date, statistics: { papers: any, analyses: any, queries: any },
  progress: { crawlingComplete: boolean, classificationComplete: boolean, summarizationComplete: boolean, analysisComplete: boolean, presentationComplete: boolean }
} }
```

#### **Agenten-Rollen**
| Agent | Rolle | Aufgabe | LLM | Storage |
|-------|-------|---------|-----|---------|
| `crawler` | Sucht Papers | arXiv-Suche nach relevanten Papern | ✅ | JSONL |
| `classifier` | Klassifiziert | Relevanz, Themen, Keywords extrahieren | ✅ | JSONL |
| `summarizer` | Erstellt Zusammenfassungen | Zusammenfassung für hochrelevante Papers | ✅ | JSONL |
| `analyst` | Führt Analysen durch | Zeitliche Trends, Autoren-Netzwerk, Themencluster, Zitationsanalyse | ✅ | JSONL |
| `presenter` | Erstellt Präsentation | Markdown-Bericht + Dashboard-Daten | ✅ | JSONL |
| `chat` | Beantwortet Fragen | Interaktive Abfragen basierend auf Space-Daten | ✅ | JSONL |
| `monitor` | Überwacht Fortschritt | System-Status, Metriken, Fortschritt | ❌ | JSONL |

#### **Ablauf (Phasen-basiert)**
1. **Phase 1: Crawling (20 Min.)**
   - Crawler sucht mit arXiv-Suche nach Papern
   - Schreibt `PaperMetadata` in den Space
   - Sendet `CrawlDone` bei Fertigstellung

2. **Phase 2: Klassifikation (25 Min.)**
   - Classifier liest unklassifizierte Paper
   - Klassifiziert nach Relevanz, extrahiert Themen/Keywords
   - Schreibt `ClassifiedPaper` und aktualisiert `PaperMetadata`
   - Sendet `ClassificationDone` bei Fertigstellung

3. **Phase 3: Zusammenfassung (30 Min.)**
   - Summarizer liest hochrelevante Paper
   - Erstellt Zusammenfassungen und Key Findings
   - Schreibt `PaperSummary` in den Space
   - Sendet `SummarizationDone` bei Fertigstellung

4. **Phase 4: Analyse (40 Min.)**
   - Analyst wartet auf `AnalyzeTask` (space_wait)
   - Führt 4 Analysen durch: Zeitliche Trends, Autoren-Netzwerk, Themencluster, Zitationsanalyse
   - Schreibt `AnalysisResult` für jede Analyse
   - Schreibt `Analysis` (Gesamtsicht)
   - Sendet `PresentTask`

5. **Phase 5: Präsentation (30 Min.)**
   - Presenter wartet auf `PresentTask` (space_wait)
   - Liest alle Daten (Paper, ClassifiedPaper, PaperSummary, AnalysisResult)
   - Erstellt Markdown-Präsentation + Dashboard-Daten (JSON)
   - Schreibt `Presentation` in den Space

**Parallel laufend:**
- **Chat**: Wartet auf `UserQuery` und beantwortet sie mit `QueryResponse`
- **Monitor**: Überwacht Fortschritt und schreibt `SystemStatus` alle 30 Sekunden

#### **Besonderheiten**
✅ **Mehr Agenten**: Getrennte Verantwortlichkeiten (Crawler ≠ Classifier ≠ Summarizer)
✅ **Erweiterte Analysen**: 4 verschiedene Analyse-Typen mit statistischen Methoden
✅ **Interaktiver Chat**: Benutzer können Fragen stellen, die basierend auf Space-Daten beantwortet werden
✅ **Monitoring**: Echtzeit-Überwachung des Fortschritts
✅ **Dashboard-Daten**: JSON-Output für Visualisierungen
✅ **Phasen-basiert**: Jede Phase hat eigenes Timeout und Fertig-Meldung
✅ **Fehlertoleranz**: Jede Phase kann unabhängig fortgesetzt werden

#### **Vergleich mit arxiv-research.ts**

| Aspekt | arxiv-research.ts (LLM-Papers) | dark-energy-research.ts (Dunkle Energie) |
|--------|---------------------------------|------------------------------------------|
| **Agenten** | 3 Collector + 1 Analyst + 1 Presenter | 1 Crawler + 1 Classifier + 1 Summarizer + 1 Analyst + 1 Presenter + 1 Chat + 1 Monitor |
| **Phasen** | 3 (Collect → Analyze → Present) | 5 (Crawl → Classify → Summarize → Analyze → Present) + Parallel (Chat, Monitor) |
| **Klassifikation** | Integriert in Collector | Separater Classifier-Agent |
| **Zusammenfassung** | ❌ Nein | ✅ Summarizer-Agent |
| **Analyse-Typen** | Qualitativ (Epochen-Analyse) | Quantitativ + Qualitativ (4 Analyse-Typen) |
| **Chat** | ❌ Nein | ✅ Chat-Agent |
| **Monitoring** | ❌ Nein | ✅ Monitor-Agent |
| **Dashboard** | ❌ Nein | ✅ JSON-Output |
| **Space-Typen** | 7 Typen | 12 Typen |

#### **Prompts (Angepasst für Astrophysik)**

**Crawler-Prompt:**
```typescript
// Suche nach Papern zu Dunkler Energie/Dunkler Materie:
// - Suchbegriffe: ti:"dark energy" OR ti:"dark matter" OR abs:"dark energy" OR abs:"dark matter"
// - Kategorien: astro-ph.CO (Kosmologie), gr-qc (Allgemeine Relativität), hep-ph/hep-th (Hochenenergiephysik)
// - Zeitraum: 1998 (Supernova-Kosmologie-Entdeckung) bis heute
// - Maximal 10 Suchen, jeweils mit max: 25 Ergebnissen
```

**Classifier-Prompt:**
```typescript
// Klassifiziere Paper nach Relevanz für "Dunkle Energie/Dunkle Materie":
// - high: direkt und zentral (z. B. Beobachtungen von Dunkler Energie, ΛCDM-Modelle)
// - medium: indirekt relevant (z. B. Kosmologie-Allgemein, Gravitationslinsen, Galaxienrotation)
// - low: kaum oder nicht relevant
// Extrahiere:
// - Themen (z. B. ["dark energy", "cosmological constant", "Hubble tension", "structure formation"])
// - Keywords (z. B. ["ΛCDM", "w0wa", "modified gravity", "DES", "Euclid", "JWST"])
// - Confidence (0-1)
```

**Analyst-Prompt:**
```typescript
// Erstelle die folgenden Analysen:
// 1. Zeitliche Trends:
//    - Paper pro Jahr (ab 1998)
//    - Paper pro Monat (für die letzten 5 Jahre)
//    - Paper pro Thema pro Jahr
// 2. Autoren-Netzwerk:
//    - Identifiziere alle Autoren
//    - Erstelle Koautoren-Graph (Knoten = Autor, Kanten = gemeinsame Paper)
//    - Berechne Metriken: Anzahl Paper, Zitationen, H-Index
// 3. Themencluster:
//    - Gruppiere Paper nach ähnlichen Topics/Keywords
//    - Identifiziere 3-5 Hauptcluster
//    - Für jedes Cluster: Paper, Größe, häufige Keywords
// 4. Zitationsanalyse:
//    - Top 10 meistzitierte Paper
//    - Zitationsgraph (Wer zitiert wen?)
```

**Chat-Prompt:**
```typescript
// Beantworte Benutzerfragen basierend auf den verfügbaren Daten:
// 1. Analysiere die Frage
// 2. Durchsuche den Space nach relevanten Informationen:
//    - PaperMetadata (Rohdaten)
//    - ClassifiedPaper (Klassifizierungen)
//    - PaperSummary (Zusammenfassungen)
//    - AnalysisResult (Analysen)
//    - Presentation (Präsentation)
// 3. Erstelle eine fundierte Antwort:
//    - Beantworte direkt und präzise
//    - Zitiere konkrete Paper aus dem Space
//    - Gib Quellen an (arXiv-Links)
//    - Falls nicht beantwortbar: "Ich kann diese Frage nicht basierend auf den verfügbaren Daten beantworten."
```

#### **Zuordnung zu Dokumentation**
✅ **Erweitert**: [LLM-Agenten (arXiv)](arxiv.md) – **Dunkle Energie-Szenario**
- **Vollständige Übereinstimmung** mit dem Dokument
- **Erweiterung**: Zusätzliche Agenten und Analyse-Typen
- **Basis**: arxiv-research.ts mit zusätzlichen Komponenten

#### **Aufruf**

```bash
# Mit Standardthema (Dunkle Energie/Dunkle Materie)
node --experimental-strip-types examples/dark-energy-research.ts

# Mit eigenem Thema
node --experimental-strip-types examples/dark-energy-research.ts "Dunkle Materie: Observationen und theoretische Modelle"

# Mit spezifiziertem State-Verzeichnis
node --experimental-strip-types examples/dark-energy-research.ts --dir /tmp/dark-energy-research

# Mit Output-Dateien
node --experimental-strip-types examples/dark-energy-research.ts --out report.md --out-json dashboard.json
```

---

### 2.9 Golomb-Lineal – Designvorschlag

*(Neu hinzugefügt basierend auf Analyse von `/home/lux/programming/golomb-2025/`)*

#### **Zweck**
Verteilte **kombinatorische Suche** nach optimalen Golomb-Linealen.

#### **Referenzimplementierung**
- **Verzeichnis**: `/home/lux/programming/golomb-2025/`
- **Sprache**: C mit OpenMP
- **Algorithmus**: Branch-and-Bound DFS mit Bitset-Optimierung
- **Features**:
  - **DFS mit Backtracking**
  - **Bitset für O(1)-Duplikatsprüfung**
  - **OpenMP für Parallelisierung**
  - **SIMD (AVX2/AVX-512)** für Distanzprüfung
  - **Checkpointing** für lange Läufe
  - **Heuristiken** (LUT, Symmetrie-Reduktion)

#### **Algorithmus-Vergleich**
| **Aspekt** | **golomb-2025 (C)** | **pi-spaces-Version (vorgeschlagen)** |
|------------|--------------------|--------------------------------------|
| **Sprache** | C | TypeScript |
| **Parallelisierung** | OpenMP (Thread-basiert) | `expand`-Modus (Prozess-basiert) |
| **Aufteilung** | Nach a₂ (zweite Markierung) | Nach a₂-Bereichen |
| **Bitset** | `uint64_t[]` | `Uint8Array` |
| **Pruning** | Branch-and-Bound | Branch-and-Bound |
| **Checkpointing** | Binärdatei | `GolombSearchProgress`-Entry |
| **Heuristiken** | LUT, Symmetrie | LUT, Symmetrie |

#### **Proposed Space-basiertes Design**

##### **Space-Typen**
```typescript
interface GolombSearchTask {
  type: "GolombSearchTask";
  taskId: string;
  order: number;            // Ordnung n
  minLength: number;        // Minimale Länge
  maxLength: number;        // Maximale Länge
  startPos: number;         // Startposition für a₂
  endPos: number;           // Endposition für a₂
  status: "pending" | "processing" | "done" | "failed";
  workerId?: string;
}

interface GolombRuler {
  type: "GolombRuler";
  taskId: string;
  order: number;
  length: number;          // Länge
  positions: number[];      // Positionen
  distances: number[];     // Alle Abstände
  isOptimal: boolean;
  foundAt: Date;
  workerId: string;
  durationMs: number;
}

interface GolombBestKnown {
  type: "GolombBestKnown";
  order: number;
  length: number;
  positions: number[];
  source: string;
  updatedAt: Date;
}

interface GolombSearchProgress {
  type: "GolombSearchProgress";
  taskId: string;
  order: number;
  currentLength: number;
  currentMarks: number[];
  checkedPositions: number;
  lastUpdate: Date;
  workerId: string;
}
```

##### **Agenten**
| **Agent** | **Rolle** | **Operationen** | **Anforderungen** |
|-----------|-----------|-----------------|-------------------|
| **Master** | Erstellt Tasks, aggregiert Ergebnisse | `write(GolombSearchTask)`, `read(GolombRuler)`, `write(GolombSummary)` | CPU: 1 Kern |
| **Worker** | DFS-Backtracking | `take(GolombSearchTask)`, `write(GolombRuler)`, `write(GolombSearchProgress)` | CPU: 4+ Kerne |
| **Validator** | Validierung | `read(GolombRuler)` | CPU: 1 Kern |
| **Monitor** | Fortschritt | `readAll(GolombSearchProgress)` | CPU: 1 Kern |

##### **Ablauf**
1. **Master** lädt bekannte optimale Lösungen (LUT)
2. **Master** erstellt Tasks für a₂-Bereiche
3. **Worker** nehmen Tasks und führen DFS durch
4. **Worker** speichern Fortschritt (Checkpointing)
5. **Validator** überprüft gefundene Lineale
6. **Master** aggregiert Ergebnisse

##### **Besonderheiten**
✅ **Branch-and-Bound**: Pruning mit bekannter optimaler Länge
✅ **Bitset-Optimierung**: Effiziente Duplikatsprüfung
✅ **Checkpointing**: Resume-Fähigkeit
✅ **Fehlertoleranz**: Worker-Abstürze überlebbar
✅ **Skalierbarkeit**: Linearer Speedup mit mehr Workern

##### **Zuordnung zu Dokumentation**
✅ **Entspricht**: [Golomb-Lineal](../examples/golomb.md) – **Designvorschlag**

#### **Empfehlung für Dokumentation**
- In `golomb.md` als **pi-spaces-Implementierungsvorschlag** einfügen
- **Referenz auf golomb-2025** als Vergleichsbasis hinzufügen

---

---

## 3. Zuordnung zu Testbeispiel-Dokumenten

### 3.1 Übersichtstabelle

| **Implementierung** | **Dokument** | **Übereinstimmung** | **Anpassungen nötig** | **Status** | **Notizen** |
|---------------------|--------------|---------------------|---------------------|------------|-----------|
| `workers.ts` | [sieve.md](sieve.md) | ⭐⭐ (Grundpattern) | ❌ Nein | ✅ | Einfaches Master-Worker |
| `sensor-pipeline.ts` | [iot.md](iot.md) | ⭐⭐⭐⭐ | ❌ Nein | ✅ | Pipeline + Transaktionen |
| `chat.ts` | [arxiv.md](arxiv.md) | ⭐⭐ (Chat) | ❌ Nein | ✅ | Publish-Subscribe |
| `arxiv-tool.ts` | [arxiv.md](arxiv.md) | ⭐⭐⭐⭐ | ❌ Nein | ✅ | Externes Tool |
| `arxiv-research.ts` | [arxiv.md](arxiv.md) | ⭐⭐⭐⭐ | ✅ **Ja** | ✅ | **LLM-Papers Referenz** |
| `dark-energy-research.ts` | [arxiv.md](arxiv.md) | ⭐⭐⭐⭐⭐ | ✅ **Ja** | ✅ | **Dunkle Energie Implementierung** |
| `blocking-tool.ts` | [sieve.md](sieve.md) | ⭐ | ❌ Nein | ✅ | Testfall für Timeouts |
| **Golomb-Design** | [golomb.md](golomb.md) | ⭐⭐⭐⭐ | ✅ **Ja** | ⚠️ **Vorschlag** | Design basierend auf golomb-2025 |

### 3.2 Detaillierte Zuordnung

#### 3.2.1 `workers.ts` → [sieve.md](../examples/sieve.md)
**Matching**:
- ✅ Master-Worker-Pattern
- ✅ `write` (Boss) + `take` (Worker)
- ❌ Kein DFS/Backtracking
- ❌ Keine Aggregation
- ❌ Keine Leases
- ❌ Keine Fehlerbehandlung

**Empfehlung**:
- In `sieve.md` als **Referenzimplementierung** für das Grundpattern erwähnen
- Als **Einstiegsbeispiel** für Master-Worker markieren
- **Erweiterung**: DFS/Backtracking hinzufügen (könnte als Übung dienen)

#### 3.2.2 `sensor-pipeline.ts` → [iot.md](../examples/iot.md)
**Matching**:
- ✅ Pipeline-Architektur (Collector → Analyst → Presenter)
- ✅ Transaktionen (`txn`)
- ✅ Mehrere Quellen (Collector)
- ✅ Aggregation (Analyst)
- ✅ Präsentation (Presenter)
- ❌ Keine Alerts
- ❌ Keine TTL für Sensor-Daten
- ❌ Keine Echtzeit-Anforderungen

**Empfehlung**:
- In `iot.md` als **Referenzimplementierung** für die Pipeline markieren
- **Erweiterungsvorschlag**: Alert-Agent hinzufügen

#### 3.2.3 `chat.ts` → [arxiv.md](../examples/arxiv.md)
**Matching**:
- ✅ Publish-Subscribe (Space-Events)
- ✅ Mehrere Agenten
- ✅ Nachrichtenaustausch
- ❌ Keine komplexe Pipeline
- ❌ Keine LLM-Integration (kann aber aktiviert werden)

**Empfehlung**:
- In `arxiv.md` als **Referenz für Chat-Funktionalität** erwähnen
- Als **Grundlage für komplexere Interaktionen** nutzen

#### 3.2.4 `arxiv-tool.ts` + `arxiv-research.ts` → [arxiv.md](../examples/arxiv.md)
**Matching**:
- ✅ **Vollständige Übereinstimmung** mit LLM-Papers-Szenario
- ✅ Collector-Agenten mit arXiv-Suche
- ✅ Analyst-Agent mit Epochen-Analyse
- ✅ Presenter-Agent mit Markdown-Bericht
- ✅ Transaktionen
- ✅ Persistenz (JSONL-Storage)
- ✅ Checkpointing (Resume-Fähigkeit)

**Empfehlung**:
- **Haupteintrag in `arxiv.md`** als **Referenzimplementierung für LLM-Papers**
- **Code-Referenz** für die Pipeline hinzufügen

#### 3.2.5 Golomb-Design → [golomb.md](../examples/golomb.md)
**Matching**:
- ✅ **Vollständige Übereinstimmung** mit dem Dokument
- ✅ Branch-and-Bound-Algorithmus
- ✅ Master-Worker-Pattern
- ✅ Backtracking mit Pruning
- ✅ Checkpointing

**Empfehlung**:
- In `golomb.md` als **pi-spaces-Implementierungsvorschlag** einfügen
- **Vergleichstabelle** mit golomb-2025 hinzufügen

---

## 4. Vergleich: LLM-Papers vs. Dunkle Energie

### 4.1 Übersicht

| **Aspekt** | **LLM-Papers (`arxiv-research.ts`)** | **Dunkle Energie (`arxiv.md` Dokument)** | **Gemeinsamkeiten** |
|------------|------------------------------------|----------------------------------------|------------------|
| **Thema** | LLM-Entwicklung (Technologie) | Astrophysik (Dunkle Energie/Materie) | arXiv-Papers |
| **Pattern** | Pipeline (Crawl → Classify → Analyze → Present) | Pipeline (Crawl → Classify → Summarize → Analyze → Present → Chat) | Pipeline-Architektur |
| **Agenten** | Collector, Analyst, Presenter | Crawler, Classifier, Summarizer, Analysis, Presenter, Chat, Monitor | Mehrere Agenten |
| **Datenquelle** | arXiv API | arXiv API | arXiv |
| **Space-Typen** | Paper, Msg, CollectorDone, AnalyzeTask, Analysis, PresentTask, Report | PaperMetadata, ClassifiedPaper, PaperSummary, AnalysisResult, Presentation, UserQuery, QueryResponse | Ähnliche Typen |
| **LLM-Nutzung** | ✅ Ja (Klassifikation + Analyse + Präsentation) | ✅ Ja (Klassifikation + Zusammenfassung + Analyse + Chat) | LLM-Integration |
| **Transaktionen** | ✅ Ja (space_wait + txn) | ✅ Ja (empfohlen) | Transaktionen |
| **Checkpointing** | ✅ Ja (JSONL-Storage) | ❌ Nein (könnte hinzugefügt werden) | Resume-Fähigkeit |

### 4.2 Detailvergleich der Agenten

#### 4.2.1 Collector vs Crawler + Classifier

**LLM-Papers (`arxiv-research.ts`):**
- **3 Collector-Agenten**, jeder für eine **Zeit-Epoche**
- **Aufgabe**: Suche + Klassifikation + Deduplizierung
- **Output**: `Paper`-Entries mit Metadaten + `CollectorDone`

```typescript
// Collector-Prompt (LLM-Papers)
`Suche mit arxiv_search nach prägenden Arbeiten.
Wähle 6-10 Paper, die einen Ansatz begründet haben.
Prüfe mit space_read auf Duplikate.
Schreibe Paper in den Space.`
```

**Dunkle Energie (Dokument):**
- **1 Crawler-Agent**: Sucht Papers
- **1 Classifier-Agent**: Klassifiziert Papers nach Relevanz
- **Aufgabe**: Trennung von Suche und Klassifikation
- **Output**: `ClassifiedPaper`-Entries

```typescript
// Classifier-Prompt (Dokument)
`Klassifiziere das folgende Paper nach Relevanz für "Dunkle Energie":
Relevanz: high, medium oder low
Themen: Liste der relevanten Themen
Keywords: Liste der Keywords
Confidence: 0-1`
```

**Vergleich:**
| **Aspekt** | **LLM-Papers Collector** | **Dunkle Energie Crawler+Classifier** |
|------------|--------------------------|-------------------------------------|
| **Aufgabe** | Suche + Klassifikation kombiniert | Suche und Klassifikation getrennt |
| **Input** | Thema + Fokus + arXiv-Suche | Paper-Metadaten |
| **Output** | Paper-Objekte | ClassifiedPaper-Objekte |
| **LLM-Rolle** | **Aktiv** (generiert Paper-Objekte) | **Passiv** (klassifiziert bestehende Papers) |
| **Komplexität** | Höher (Suche + Auswahl + Deduplizierung) | Niedriger (nur Klassifikation) |
| **Skalierbarkeit** | 3 parallele Collector | 1 Crawler + 1 Classifier |

#### 4.2.2 Analyst vs Summarizer + Analysis

**LLM-Papers (`arxiv-research.ts`):**
- **1 Analyst-Agent**: Gruppiert Papers in Epochen
- **Aufgabe**: Chronologische Analyse + Zusammenfassung
- **Output**: `Analysis`-Entries (qualitativ)

```typescript
// Analyst-Prompt (LLM-Papers)
`Ordne Paper chronologisch in 4-7 Epochen.
Für jede Epoche: Titel, Periode, Ansätze, Schlüsselpaper, Zusammenfassung, Grenzen.
Schreibe Gesamtsicht (order=99).`
```

**Dunkle Energie (Dokument):**
- **1 Summarizer-Agent**: Erstellt Zusammenfassungen
- **1 Analysis-Agent**: Führt Analysen durch
- **Aufgabe**: Trennung von Zusammenfassung und Analyse
- **Output**: `PaperSummary` + `AnalysisResult` (quantitativ + qualitativ)

```typescript
// Analysis-Agent (Dokument)
// Führt Analysen durch:
- Zeitliche Trends (Papers pro Jahr/Monat)
- Autoren-Netzwerk (Koautoren-Graph)
- Themencluster (Gruppierung nach Keywords)
- Zitationsanalyse (Zitations-Graph)
```

**Vergleich:**
| **Aspekt** | **LLM-Papers Analyst** | **Dunkle Energie Analysis** |
|------------|------------------------|-----------------------------|
| **Aufgabe** | Chronologische Epochen-Analyse | Statistische Analysen + LLM-Zusammenfassung |
| **Methode** | LLM-generiert (manuelle Gruppierung) | Algorithmen-basiert + LLM |
| **Output** | Analysis-Objekte (qualitativ) | AnalysisResult-Objekte (quantitativ + qualitativ) |
| **LLM-Nutzung** | ✅ Ja (generiert Analysen) | ⚠️ Teilweise (nur Zusammenfassung) |

#### 4.2.3 Presenter vs Presenter

**LLM-Papers (`arxiv-research.ts`):**
- **1 Presenter-Agent**: Erstellt Markdown-Bericht
- **Aufgabe**: Zusammenfassung aller Analysen
- **Output**: `Report` (Markdown)

```typescript
// Presenter-Prompt (LLM-Papers)
`Schreibe Markdown-Bericht mit:
- Titel, Einleitung
- Zeitstrahl-Tabelle
- Abschnitte pro Epoche
- Stand heute & offene Fragen
- Quellenliste`
```

**Dunkle Energie (Dokument):**
- **1 Presenter-Agent**: Erstellt Präsentation + Dashboard
- **Aufgabe**: Zusammenfassung + Visualisierung
- **Output**: `Presentation` (Markdown + JSON für Diagramme)

```typescript
// Presenter-Agent (Dokument)
// Erstellt:
- Markdown-Präsentation mit Slides
- Dashboard-Daten (Zeitreihen, Netzwerke, Tabellen)
- JSON für interaktive Visualisierungen
```

**Vergleich:**
| **Aspekt** | **LLM-Papers Presenter** | **Dunkle Energie Presenter** |
|------------|--------------------------|-----------------------------|
| **Aufgabe** | Markdown-Bericht erstellen | Präsentation + Dashboard erstellen |
| **Output** | Report (Markdown) | Presentation (Markdown + JSON) |
| **LLM-Nutzung** | ✅ Ja (generiert Markdown) | ⚠️ Teilweise (nur Text) |
| **Visualisierung** | ❌ Nein | ✅ Ja (Diagramme, Netzwerke) |

### 4.3 Unterschiede im Workflow

| **Phase** | **LLM-Papers** | **Dunkle Energie** |
|-----------|----------------|-------------------|
| **1. Suche** | 3 Collector (parallel, je Epoche) | 1 Crawler |
| **2. Klassifikation** | Integriert in Collector | Separater Classifier-Agent |
| **3. Zusammenfassung** | ❌ Nein | ✅ Summarizer-Agent |
| **4. Analyse** | 1 Analyst (LLM-basiert) | 1 Analysis-Agent (algorithmen-basiert + LLM) |
| **5. Präsentation** | 1 Presenter (Markdown) | 1 Presenter (Markdown + JSON + Dashboard) |
| **6. Chat** | ❌ Nein | ✅ Chat-Agent für interaktive Abfragen |
| **7. Monitoring** | ❌ Nein | ✅ Monitor-Agent für Fortschritt |

### 4.4 Übersetzungsmatrix: LLM-Papers → Dunkle Energie

| **LLM-Papers-Komponente** | **Dunkle Energie-Äquivalent** | **Anpassungsaufwand** |
|--------------------------|--------------------------------|-----------------------|
| `Collector` (3×) | `Crawler` + `Classifier` | ⭐⭐ (Aufteilung nötig) |
| `Analyst` | `Summarizer` + `Analysis` | ⭐⭐ (Aufteilung nötig) |
| `Presenter` | `Presenter` | ⭐ (ähnlich) |
| `space_wait` + `txn` | `space_wait` + `txn` | ⭐ (identisch) |
| JSONL-Storage | JSONL-Storage | ⭐ (identisch) |
| `Paper`-Typ | `ClassifiedPaper`-Typ | ⭐⭐ (Felder anpassen) |
| `Analysis`-Typ | `AnalysisResult`-Typ | ⭐⭐ (Felder anpassen) |
| `Report`-Typ | `Presentation`-Typ | ⭐⭐ (Format anpassen) |

### 4.5 Schlussfolgerung

1. **LLM-Papers (`arxiv-research.ts`) ist eine **vollständige, lauffähige Implementierung** **
   der Pipeline-Architektur für arXiv-Paper-Auswertung.

2. **Dunkle Energie (Dokument) beschreibt eine **erweiterte Version** mit:
   - Mehr Agenten (Summarizer, Chat, Monitor)
   - Mehr Analysen (statistisch + LLM)
   - Visualisierung (Dashboard)

3. **Empfehlung**:
   - `arxiv-research.ts` als **Grundlage** für Dunkle Energie verwenden
   - **Erweiterungen** hinzufügen:
     - Separaten Classifier-Agent
     - Summarizer-Agent
     - Analysis-Agent mit statistischen Funktionen
     - Chat-Agent für interaktive Abfragen
     - Dashboard-Generierung
   - **Vorteile**:
     - Bewährte Pipeline-Architektur
     - Resume-Fähigkeit (JSONL-Storage)
     - Transaktionen
     - Deduplizierung

---

## 5. Empfehlungen für Dokumentationsanpassungen

### 5.1 Anpassungen für `arxiv.md` (LLM-Agenten)

Füge einen neuen **Abschnitt 5.9 LLM-Papers-Implementierung (Code-Beispiel)** hinzu:

```markdown
### 5.9 LLM-Papers-Implementierung (Code-Beispiel)

**Datei**: [`../examples/arxiv-research.ts`](../examples/arxiv-research.ts)

Diese Implementierung demonstriert die **komplette Pipeline für LLM-Papers** mit:

#### Agenten
| Agent | Datei | Rolle | Fokus |
|-------|-------|-------|-------|
| Collector-1 | `examples/arxiv-research.ts` | Sucht Papers zu Grundlagen (bis 2018) |
| Collector-2 | `examples/arxiv-research.ts` | Sucht Papers zu Pretraining (2018-2023) |
| Collector-3 | `examples/arxiv-research.ts` | Sucht Papers zu Alignment (ab 2020) |
| Analyst | `examples/arxiv-research.ts` | Analysiert Papers und erstellt Epochen |
| Presenter | `examples/arxiv-research.ts` | Erstellt Markdown-Bericht |

#### Space-Typen
- `Paper`: Paper-Metadaten + Ansatz + Beitrag
- `Msg`: Notizen zwischen Agenten
- `CollectorDone`: Fertig-Meldung
- `AnalyzeTask`: Analyse-Auftrag
- `Analysis`: Analyse-Ergebnis (pro Epoche)
- `PresentTask`: Präsentations-Auftrag
- `Report`: Finaler Markdown-Bericht

#### Ablauf
1. Collector suchen Papers mit `arxiv_search`
2. Collector schreiben `Paper` in den Space (mit Deduplizierung)
3. Host erstellt `AnalyzeTask` nach allen `CollectorDone`
4. Analyst analysiert Papers und erstellt `Analysis` (mit Transaktion)
5. Analyst erstellt `PresentTask`
6. Presenter erstellt `Report`

#### Besonderheiten
- **State-Persistenz**: JSONL-Storage für Resume
- **Timeouts**: 15 Min. für Collect, 20 Min. für Report
- **Transaktionen**: Analyst und Presenter verwenden `space_wait` + `txn`
- **LLM-Integration**: Echte Modelle oder Faux-Provider
- **Deduplizierung**: Collector prüfen auf bestehende Papers

#### Aufruf
```bash
# Mit Standardthema (LLM-Entwicklung)
node --experimental-strip-types examples/arxiv-research.ts

# Mit eigenem Thema
node --experimental-strip-types examples/arxiv-research.ts "Die Entwicklung von Transformern"

# Mit spezifiziertem State-Verzeichnis
node --experimental-strip-types examples/arxiv-research.ts --dir /tmp/my-research

# Mit Output-Datei
node --experimental-strip-types examples/arxiv-research.ts --out report.md
```
```

Füge eine **Vergleichstabelle LLM-Papers vs Dunkle Energie** hinzu (siehe Abschnitt 4.1).

### 5.2 Anpassungen für `sieve.md` (Master-Worker)

Füge einen neuen **Abschnitt 7.9 Referenzimplementierung (Code-Beispiel)** hinzu:

```markdown
### 7.9 Referenzimplementierung (Code-Beispiel)

**Datei**: [`../examples/workers.ts`](../examples/workers.ts)

Diese Implementierung demonstriert das **Grundlegende Master-Worker-Pattern** ohne komplexe Logik:

#### Agenten
| Agent | Rolle | Operationen |
|-------|-------|------------|
| `boss` | Erstellt Jobs | `space_write(Job)` |
| `worker` | Verarbeitet Jobs | `space_take(Job)` |

#### Ablauf
1. Boss: `space_write({type: "Job", fields: {op: "resize", file: "a.png"}})`
2. Worker: `space_take({type: "Job"})`
3. Worker verarbeitet Job (simuliert durch Faux-Provider)

#### Besonderheiten
- **Einfachheit**: Keine Transaktionen, keine Aggregation
- **Zweck**: Demonstration des Grundpatterns
- **Erweiterung**: Kann um DFS/Backtracking erweitert werden (siehe Hauptbeispiel)

#### Aufruf
```bash
node --experimental-strip-types examples/workers.ts
```

**Vergleich mit Hauptbeispiel (Primzahlsieb):**
| Aspekt | `workers.ts` | Primzahlsieb-Beispiel |
|--------|--------------|----------------------|
| Komplexität | ⭐ | ⭐⭐⭐ |
| Agenten | 2 | 3 (Master, Worker, Collector) |
| Algorithmus | - | DFS mit Backtracking |
| Transaktionen | ❌ | ✅ |
| Aggregation | ❌ | ✅ |
```

Auch `blocking-tool.ts` als **Testfall für Timeout-Handling** erwähnen.
```

### 5.3 Anpassungen für `iot.md` (IoT-Monitoring)

Füge einen neuen **Abschnitt 8.7 Referenzimplementierung (Code-Beispiel)** hinzu:

```markdown
### 8.7 Referenzimplementierung (Code-Beispiel)

**Datei**: [`../examples/sensor-pipeline.ts`](../examples/sensor-pipeline.ts)

Diese Implementierung demonstriert die **Pipeline-Architektur** mit:

#### Agenten
| Agent | Rolle | Operationen |
|-------|-------|------------|
| `host` | Erstellt Analyse-Fenster | `write(Window)` |
| `collector` | Liefert Sensor-Daten | `write(Reading)`, `write(Done)` |
| `analyst` | Aggregiert Daten | `take(Window)` + `txn`, `readAll`, `write(Summary)` |
| `presenter` | Erstellt Bericht | `take(Summary)`, `write(Report)` |

#### Besonderheiten
- **Transaktionen**: Analyst verwendet `space_wait` + `txn` für atomare Operationen
- **Deduplizierung**: `seen` Set für Duplicate-Detection
- **Validierung**: Typprüfung für Sensor-Daten (`typeof value === "number"`)
- **Fehlertoleranz**: Transaktions-Lease ermöglicht Resume
- **Wettlauf**: Mehrere Analysten konkurrieren um Window-Entries

#### Ablauf
```typescript
// 1. Fenster erstellen
await openWindow(host, "w1", ["station", "forecast", "cloud"]);

// 2. Collector: Daten sammeln
await collect(station, "station", "w1", samples);

// 3. Analysten: Daten analysieren (parallel)
const summaries = await Promise.all(analysts.map(a => analyse(a)));

// 4. Presenter: Berichte erstellen
for (const summary of summaries) console.log(await present(presenter));
```

#### Aufruf
```bash
node --experimental-strip-types examples/sensor-pipeline.ts
```

#### Unterschiede zum Dokument
- **Keine Alerts**: Könnte als Erweiterung implementiert werden
- **Keine TTL**: Sensor-Daten bleiben dauerhaft (könnte hinzugefügt werden)
- **Keine Echtzeit-Anforderungen**: Keine Latenz-Metriken
- **Kein Dashboard**: Könnte als Erweiterung implementiert werden
```

### 5.4 Anpassungen für `golomb.md` (Golomb-Lineal)

Füge einen neuen **Abschnitt 13 pi-spaces-Implementierungsvorschlag** hinzu:

```markdown
### 13 pi-spaces-Implementierungsvorschlag

**Design basierend auf**: [`../examples/`](../examples/) (vorgeschlagen)
**Referenz**: [golomb-2025](https://github.com/lux/golomb-2025) (C-Implementierung)

#### Agenten
| Agent | Rolle | Operationen | Anforderungen |
|-------|-------|------------|--------------|
| Master | Erstellt Tasks, aggregiert Ergebnisse | `write(GolombSearchTask)`, `read(GolombRuler)`, `write(GolombSummary)` | CPU: 1 Kern |
| Worker | DFS-Backtracking | `take(GolombSearchTask)`, `write(GolombRuler)`, `write(GolombSearchProgress)` | CPU: 4+ Kerne |
| Validator | Validierung | `read(GolombRuler)` | CPU: 1 Kern |
| Monitor | Fortschritt | `readAll(GolombSearchProgress)` | CPU: 1 Kern |

#### Space-Typen
- `GolombSearchTask`: Suchauftrag für einen a₂-Bereich
- `GolombRuler`: Gefundenes Golomb-Lineal
- `GolombBestKnown`: Beste bekannte Lösung
- `GolombSearchProgress`: Fortschritt (für Checkpointing)
- `GolombSummary`: Aggregiertes Ergebnis

#### Algorithmus
- **Branch-and-Bound DFS** mit Bitset-Optimierung
- **Pruning** mit bekannter optimaler Länge
- **Checkpointing** für Resume-Fähigkeit
- **Verteilung** nach a₂-Bereichen (expand-Modus)

#### Vergleich mit golomb-2025
| Aspekt | golomb-2025 (C) | pi-spaces-Version |
|--------|-----------------|------------------|
| Sprache | C | TypeScript |
| Parallelisierung | OpenMP (Thread-basiert) | expand-Modus (Prozess-basiert) |
| Aufteilung | Nach a₂ | Nach a₂-Bereichen |
| Bitset | uint64_t[] | Uint8Array |
| Checkpointing | Binärdatei | GolombSearchProgress-Entry |

#### Aufruf (vorgeschlagen)
```bash
# 4 Worker, Suche nach n=15
node --experimental-strip-types examples/golomb.ts 15 --workers 4

# Mit Checkpointing
node --experimental-strip-types examples/golomb.ts 15 --workers 4 --checkpoint golomb-cp.jsonl
```
```

### 5.5 Neues Dokument: `chat.md` (optional)

Erstelle ein neues Dokument **`chat.md`** oder füge einen Abschnitt in `arxiv.md` hinzu:

```markdown
# Testbeispiel: Space-basierter Chat

## 1. Übersicht
| Aspekt | Wert |
|--------|------|
| Anwendungsfall | Ring-Chat zwischen Agenten über Space-Events |
| Pattern | Publish-Subscribe |
| Implementierung | [`../examples/chat.ts`](../examples/chat.ts) |
| Modus | `local` |

## 2. Agenten
| Agent | Rolle | Operationen |
|-------|-------|------------|
| `alice` | Teilnehmer | `notify(Msg)`, `readAll(Msg)`, `write(Msg)` |
| `bob` | Teilnehmer | `notify(Msg)`, `readAll(Msg)`, `write(Msg)` |
| `carol` | Teilnehmer | `notify(Msg)`, `readAll(Msg)`, `write(Msg)` |

## 3. Ablauf
1. Host: `write(Msg, {room: "lobby", from: "host", to: "alice", n: 0, text: topic})`
2. Agenten:
   - Jeder Agent hat notify-Subscription für Msg mit to: <name>
   - Agent liest alle Nachrichten mit readAll(Msg)
   - Agent schreibt Antwort mit write(Msg, {to: next(name)})
3. Terminierung: Nach MAX_TURNS (6 oder 9)

## 4. Besonderheiten
- Space-Events: notify für Nachrichtenzustellung
- Transkript: Alle Nachrichten bleiben im Space erhalten
- Ring-Architektur: alice → bob → carol → alice
- Scripted/Faux: Kann mit Faux-Provider (kein LLM) oder echtem LLM laufen
- Deterministisch: Mit Faux-Provider ist der Ablauf deterministisch

## 5. Aufruf
```bash
# Mit Faux-Provider (kein LLM, deterministisch)
node --experimental-strip-types examples/chat.ts

# Mit echtem LLM
node --experimental-strip-types examples/chat.ts --live "LLM-Diskussion"
```
```

---

## 6. Zusammenfassung und nächste Schritte

### 6.1 Implementierungsstatus
| Beispiel | Implementiert | Dokumentation | Referenz |
|----------|--------------|---------------|----------|
| workers.ts | ✅ | ❌ | sieve.md |
| sensor-pipeline.ts | ✅ | ❌ | iot.md |
| chat.ts | ✅ | ❌ | arxiv.md |
| arxiv-tool.ts | ✅ | ❌ | arxiv.md |
| arxiv-research.ts | ✅ | ❌ | arxiv.md |
| live-models.ts | ✅ | ❌ | - |
| blocking-tool.ts | ✅ | ❌ | sieve.md |
| Golomb-Lineal | ❌ (Design) | ❌ | golomb.md |

### 6.2 Empfehlungen

1. **Priorität 1 (P1)**:
   - [ ] `arxiv.md` um LLM-Papers-Implementierung erweitern
   - [ ] `arxiv.md` um Vergleichstabelle erweitern

2. **Priorität 2 (P2)**:
   - [ ] `sieve.md` um Referenzimplementierung erweitern
   - [ ] `iot.md` um Referenzimplementierung erweitern
   - [ ] `golomb.md` um pi-spaces-Implementierungsvorschlag erweitern

3. **Priorität 3 (P3)**:
   - [ ] `chat.md` als eigenständiges Dokument erstellen
   - [ ] `blocking-tool.ts` in sieve.md als Testfall erwähnen

### 6.3 Nächste Schritte

1. **Dokumentation aktualisieren** (siehe oben)
2. **Golomb-Lineal implementieren** (basierend auf Designvorschlag)
3. **Dunkle Energie-Beispiel implementieren** (basierend auf arxiv-research.ts)
4. **Testsuite erstellen** für alle Beispiele

---

### 6.4 Offene Fragen

1. **Soll `chat.md` ein eigenständiges Dokument sein?**
   - ✅ **Ja**: Wenn Chat als eigenständiges Beispiel betrachtet wird
   - ❌ **Nein**: Wenn Chat nur als Komponente von LLM-Agenten gilt

2. **Soll Golomb-Lineal implementiert werden?**
   - ✅ **Ja**: Für Validierung der expand-Modus-Funktionalität
   - ⚠️ **Vielleicht**: Wenn Zeit und Ressourcen verfügbar sind

3. **Soll Dunkle Energie als separates Beispiel implementiert werden?**
   - ✅ **Ja**: Als Demonstration für komplexe LLM-Pipelines
   - ✅ **Basierend auf**: arxiv-research.ts (Anpassung nötig)

---

## 🔗 Verweise

- [TESTBESPIELE.md](../TESTBESPIELE.md) – Übersicht aller Beispiele
- [sieve.md](../examples/sieve.md) – Master-Worker (Primzahlsieb)
- [iot.md](../examples/iot.md) – IoT-Monitoring
- [arxiv.md](../examples/arxiv.md) – LLM-Agenten (arXiv)
- [golomb.md](../examples/golomb.md) – Golomb-Lineal
- [HISTORISCHE-REFERENZEN.md](../examples/HISTORISCHE-REFERENZEN.md) – Historische Systeme

---

**Ende des Dokuments** | [Zurück zu TESTBESPIELE.md](../TESTBESPIELE.md)
