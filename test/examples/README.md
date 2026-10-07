# 🧪 Test-Suite für pi-spaces Beispiele

**Version:** 1.0  
**Datum:** 2026-10-06  
**Status:** In Bearbeitung  
**Zweck:** Zentrale Test-Suite für alle pi-spaces Beispiele.

---

## 📋 Inhaltsverzeichnis

1. [Übersicht](#1-übersicht)
2. [Test-Organisation](#2-test-organisation)
3. [Test-Kategorien](#3-test-kategorien)
4. [Test-Ausführung](#4-test-ausführung)
5. [Test-Beispiele](#5-test-beispiele)
6. [Test-Abdeckung](#6-test-abdeckung)
7. [Performance-Tests](#7-performance-tests)

---

---

## 1. Übersicht

Diese Test-Suite validiert alle pi-spaces Beispiele auf:
- **Korrektheit**: Richtige Ergebnisse
- **Robustheit**: Fehlerbehandlung, Edge Cases
- **Performance**: Durchsatz, Latenz
- **Determinismus**: Reproduzierbarkeit
- **Integration**: Zusammenarbeit mehrerer Agenten

---

## 2. Test-Organisation

```
test/examples/
├── README.md                    ← Sie sind hier
├── utils/                      # Test-Hilfsfunktionen
│   ├── harness.ts              # Test-Harness-Setup
│   ├── assertions.ts           # Custom Assertions
│   ├── fixtures.ts             # Test-Daten
│   └── mocks.ts                # Mock-Implementierungen
├── workers.test.ts             # Master-Worker Tests
├── blocking-tool.test.ts       # Timeout Tests
├── sensor-pipeline.test.ts     # Pipeline Tests
├── chat.test.ts                # Chat Tests
├── arxiv-research.test.ts      # LLM Pipeline Tests
├── dark-energy-research.test.ts # Erweiterte Pipeline Tests
├── golomb.test.ts              # Golomb-Lineal Tests
├── integration/                # Integration-Tests
│   ├── master-worker.test.ts   # Master-Worker Integration
│   ├── pipeline.test.ts        # Pipeline Integration
│   └── distributed.test.ts      # Verteilte Tests
└── e2e/                       # End-to-End Tests
    ├── full-pipeline.test.ts   # Vollständige Pipeline
    └── recovery.test.ts        # Recovery-Tests
```

---

## 3. Test-Kategorien

| **Kategorie** | **Beschreibung** | **Tools** | **Beispiele** | **Ziel** |
|---------------|------------------|-----------|---------------|----------|
| **Unit-Tests** | Einzelne Funktionen und Komponenten | Vitest | Alle | 80% Abdeckung |
| **Integration-Tests** | Zusammenwirkung mehrerer Komponenten | Vitest | `sensor-pipeline.ts`, `arxiv-research.ts` | 70% Abdeckung |
| **E2E-Tests** | Komplette Durchläufe | Custom Runner | `dark-energy-research.ts` | Vollständige Validierung |
| **Performance-Tests** | Durchsatz und Latenz | Custom Benchmarks | `golomb.ts`, `sensor-pipeline.ts` | Performance-Ziele |
| **Stress-Tests** | Belastungstests | Custom | `arxiv-research.ts` | Robustheit unter Last |

---

## 4. Test-Ausführung

Die Suite läuft mit dem **eingebauten Node-Testrunner** (`node:test`) — kein Vitest, keine
zusätzliche Abhängigkeit. Die Datei [`compat.ts`](compat.ts) bildet die benutzte
Vitest-Oberfläche (`describe/it/test/expect/vi`, `expect.extend`, Vitests
`test(name, fn, { timeout })`-Signatur) auf `node:test` + `node:assert` ab.

```bash
# Alle Beispiel-Tests (im Repo-Root)
npm run test:examples

# Einzelne Datei
node --experimental-strip-types --test test/examples/golomb.test.ts

# Einzelner Test (Node-Testrunner-Filter)
node --experimental-strip-types --test --test-name-pattern "T9.1.1" test/examples/arxiv-research.test.ts
```

Stand: **132 Tests, alle grün** (lokal gemessen, ~11 s). Es gibt keine Coverage- und
keine separaten unit/integration/e2e-Skripte — Befehle, die es nicht gibt, werden hier
nicht dokumentiert.

## 5. Test-Beispiele

### 5.1 workers.test.ts

**Fokus:** Master-Worker-Pattern, `write`/`take` Operationen

```typescript
import { describe, it, expect, beforeAll, afterAll } from "./compat.ts";
import { createTestHarness } from "./utils/harness";
import { workersExample } from "../../examples/workers";

describe("workers.ts", () => {
  let harness: any;
  
  beforeAll(async () => {
    harness = await createTestHarness();
  });
  
  afterAll(async () => {
    await harness.close();
  });

  it("sollte Job schreiben und nehmen können", async () => {
    const result = await workersExample(harness);
    
    expect(result.jobWritten).toBe(true);
    expect(result.jobTaken).toBe(true);
    expect(result.jobCount).toBe(1);
  });

  it("sollte keine doppelten Takes zulassen", async () => {
    const result = await workersExample(harness, { workers: 2 });
    
    expect(result.jobWritten).toBe(true);
    expect(result.jobTaken).toBe(true);
    expect(result.uniqueTakes).toBe(1); // Nur ein Worker erhält den Job
  });

  it("sollte mit mehreren Jobs funktionieren", async () => {
    const result = await workersExample(harness, { jobs: 10, workers: 3 });
    
    expect(result.jobWritten).toBe(true);
    expect(result.jobsTaken).toBe(10);
    expect(result.workerCounts).toEqual([4, 3, 3]); // Große Gleichverteilung
  });
});
```

### 5.2 blocking-tool.test.ts

**Fokus:** Timeout-Handhabung, blockierende Operationen

```typescript
import { describe, it, expect, beforeAll, afterAll } from "./compat.ts";
import { createTestHarness } from "./utils/harness";
import { blockingToolExample } from "../../examples/blocking-tool";

describe("blocking-tool.ts", () => {
  let harness: any;
  
  beforeAll(async () => {
    harness = await createTestHarness();
  });
  
  afterAll(async () => {
    await harness.close();
  });

  it("sollte Task mit Timeout nehmen können", async () => {
    const result = await blockingToolExample(harness, { delayMs: 100, timeoutMs: 5000 });
    
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeLessThan(5100);
  });

  it("sollte nach Timeout scheitern", async () => {
    const result = await blockingToolExample(harness, { delayMs: 10000, timeoutMs: 1000 });
    
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });

  it("sollte sofort verfügbare Tasks nehmen", async () => {
    const result = await blockingToolExample(harness, { delayMs: 0, timeoutMs: 1000 });
    
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeLessThan(100);
  });
});
```

### 5.3 chat.test.ts

**Fokus:** Space-Events, Publish-Subscribe, Ring-Kommunikation

```typescript
import { describe, it, expect, beforeAll, afterAll } from "./compat.ts";
import { createTestHarness } from "./utils/harness";
import { chatExample } from "../../examples/chat";

describe("chat.ts", () => {
  let harness: any;
  
  beforeAll(async () => {
    harness = await createTestHarness();
  });
  
  afterAll(async () => {
    await harness.close();
  });

  it("sollte Ring-Kommunikation durchführen", async () => {
    const result = await chatExample(harness, { turns: 5 });
    
    expect(result.messages.length).toBe(6); // n=0 bis n=5
    expect(result.path).toEqual(["host", "alice", "bob", "carol", "alice", "bob"]);
  });

  it("sollte deterministisch sein", async () => {
    const result1 = await chatExample(harness, { topic: "Test" });
    const result2 = await chatExample(harness, { topic: "Test" });
    
    expect(result1.messages).toEqual(result2.messages);
    expect(result1.path).toEqual(result2.path);
  });

  it("sollte alle Nachrichten im Space behalten", async () => {
    const result = await chatExample(harness, { turns: 3 });
    
    const spaceMsgs = await harness.space.readAll({ type: "Msg" });
    expect(spaceMsgs.length).toBe(4); // n=0,1,2,3
  });

  it("sollte nach MAX_TURNS stoppen", async () => {
    const result = await chatExample(harness, { maxTurns: 3 });
    
    expect(result.messages.length).toBe(4); // n=0,1,2,3
    expect(result.completed).toBe(true);
  });

  it("sollte mit mehr Agenten funktionieren", async () => {
    const result = await chatExample(harness, { names: ["alice", "bob", "carol", "dave"] });
    
    expect(result.messages.length).toBeGreaterThan(3);
    expect(result.path.length).toBeGreaterThan(3);
  });
});
```

### 5.4 sensor-pipeline.test.ts

**Fokus:** Pipeline-Architektur, Transaktionen, Deduplizierung

```typescript
import { describe, it, expect, beforeAll, afterAll } from "./compat.ts";
import { createTestHarness } from "./utils/harness";
import { sensorPipelineExample } from "../../examples/sensor-pipeline";

describe("sensor-pipeline.ts", () => {
  let harness: any;
  
  beforeAll(async () => {
    harness = await createTestHarness();
  });
  
  afterAll(async () => {
    await harness.close();
  });

  it("sollte Fenster erstellen und Daten sammeln", async () => {
    const result = await sensorPipelineExample(harness);
    
    expect(result.windowsCreated).toBeGreaterThan(0);
    expect(result.readingsCollected).toBeGreaterThan(0);
    expect(result.doneMessages).toBeGreaterThan(0);
  });

  it("sollte Daten aggregieren", async () => {
    const result = await sensorPipelineExample(harness);
    
    expect(result.summariesCreated).toBeGreaterThan(0);
    expect(result.reportsCreated).toBeGreaterThan(0);
  });

  it("sollte Duplikate ignorieren", async () => {
    const result = await sensorPipelineExample(harness, {
      samples: [
        { source: "station", window: "w1", ts: 0, kind: "temp", value: 10 },
        { source: "station", window: "w1", ts: 0, kind: "temp", value: 10 }, // Duplicate
        { source: "station", window: "w1", ts: 5, kind: "temp", value: 11 }
      ]
    });
    
    expect(result.duplicatesIgnored).toBe(1);
    expect(result.validReadings).toBe(2);
  });

  it("sollte ungültige Werte ablehnen", async () => {
    const result = await sensorPipelineExample(harness, {
      samples: [
        { source: "station", window: "w1", ts: 0, kind: "temp", value: 10 },
        { source: "station", window: "w1", ts: 5, kind: "temp", value: "invalid" },
        { source: "station", window: "w1", ts: 10, kind: "temp", value: 11 }
      ]
    });
    
    expect(result.rejectedValues).toBe(1);
    expect(result.validReadings).toBe(2);
  });

  it("sollte Statistiken korrekt berechnen", async () => {
    const result = await sensorPipelineExample(harness, {
      samples: [
        { source: "station", window: "w1", ts: 0, kind: "temp", value: 10 },
        { source: "station", window: "w1", ts: 5, kind: "temp", value: 12 },
        { source: "station", window: "w1", ts: 10, kind: "temp", value: 14 }
      ]
    });
    
    const summary = result.summaries[0];
    expect(summary.stats.temp.n).toBe(3);
    expect(summary.stats.temp.min).toBe(10);
    expect(summary.stats.temp.max).toBe(14);
    expect(summary.stats.temp.avg).toBeCloseTo(12);
  });

  it("sollte Transaktionen atomar ausführen", async () => {
    const result = await sensorPipelineExample(harness, { crash: true });
    
    // Bei Absturz sollte kein Summary geschrieben werden
    expect(result.summariesCreated).toBe(0);
    // Window sollte wieder verfügbar sein (Lease-Ablauf)
    expect(result.windowAvailable).toBe(true);
  });
});
```

### 5.5 golomb.test.ts

**Fokus:** Branch-and-Bound, BitSet-Optimierung, Checkpointing

```typescript
import { describe, it, expect } from "./compat.ts";
import { GolombRuler, BitSet } from "../../examples/golomb";

describe("golomb.ts – Utilities", () => {
  describe("GolombRuler", () => {
    it("sollte gültige Lineale validieren", () => {
      // Ordnung 4: [0, 1, 4, 6]
      expect(GolombRuler.isValid([0, 1, 4, 6])).toBe(true);
      
      // Ordnung 5: [0, 1, 4, 9, 11]
      expect(GolombRuler.isValid([0, 1, 4, 9, 11])).toBe(true);
      
      // Ordnung 3: [0, 1, 3]
      expect(GolombRuler.isValid([0, 1, 3])).toBe(true);
    });

    it("sollte ungültige Lineale ablehnen", () => {
      // Duplizierte Differenz: [0, 1, 2, 4] hat Differenz 1 doppelt
      expect(GolombRuler.isValid([0, 1, 2, 4])).toBe(false);
      
      // Duplizierte Differenz: [0, 1, 3, 4] hat Differenz 1 doppelt
      expect(GolombRuler.isValid([0, 1, 3, 4])).toBe(false);
    });

    it("sollte Distanzen korrekt berechnen", () => {
      const positions = [0, 1, 4, 6];
      const distances = GolombRuler.getDistances(positions);
      
      expect(distances).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("sollte fehlende Distanzen korrekt berechnen", () => {
      const positions = [0, 1, 4, 6];
      const missing = GolombRuler.getMissingDistances(positions, 6);
      
      expect(missing).toEqual([]); // Alle Differenzen von 1-6 sind vorhanden
    });

    it("sollte fehlende Distanzen für unvollständige Lineale berechnen", () => {
      const positions = [0, 1, 4];
      const missing = GolombRuler.getMissingDistances(positions, 4);
      
      expect(missing).toContain(2);
      expect(missing).toContain(3);
    });
  });

  describe("BitSet", () => {
    it("sollte Bits setzen und lesen", () => {
      const bs = new BitSet(10);
      
      bs.set(3);
      bs.set(5);
      bs.set(7);
      
      expect(bs.get(3)).toBe(true);
      expect(bs.get(5)).toBe(true);
      expect(bs.get(7)).toBe(true);
      expect(bs.get(4)).toBe(false);
    });

    it("sollte auto-expandieren", () => {
      const bs = new BitSet(10);
      
      bs.set(15);
      expect(bs.get(15)).toBe(true);
      expect(bs.get(20)).toBe(false);
    });

    it("sollte klonen können", () => {
      const bs1 = new BitSet(10);
      bs1.set(3);
      bs1.set(5);
      
      const bs2 = bs1.clone();
      bs2.set(7);
      
      expect(bs1.get(7)).toBe(false);
      expect(bs2.get(7)).toBe(true);
      expect(bs2.get(3)).toBe(true);
    });

    it("sollte toArray funktionieren", () => {
      const bs = new BitSet(10);
      bs.set(1);
      bs.set(3);
      bs.set(7);
      
      expect(bs.toArray()).toEqual([1, 3, 7]);
    });

    it("sollte fromArray funktionieren", () => {
      const bs = BitSet.fromArray([1, 3, 7], 10);
      
      expect(bs.get(1)).toBe(true);
      expect(bs.get(3)).toBe(true);
      expect(bs.get(7)).toBe(true);
      expect(bs.get(2)).toBe(false);
    });
  });
});

describe("golomb.ts – Integration", () => {
  // Integrationstests mit Space
  // Wird in separater Datei implementiert
});
```

### 5.6 arxiv-research.test.ts

**Fokus:** LLM-Pipeline, arXiv-Suche, Klassifikation, Analyse

```typescript
import { describe, it, expect, beforeAll, afterAll } from "./compat.ts";
import { createTestHarness } from "./utils/harness";

describe("arxiv-research.ts", () => {
  // Unit-Tests für Utility-Funktionen
  describe("Utility Functions", () => {
    it("sollte arXiv-ID parsen können", () => {
      // Wird implementiert, wenn arxiv-tool.ts Tests verfügbar sind
    });
  });

  // Integration-Tests
  describe("Integration", () => {
    let harness: any;
    
    beforeAll(async () => {
      harness = await createTestHarness();
    });
    
    afterAll(async () => {
      await harness.close();
    });

    it("sollte Papers crawlen und speichern", async () => {
      // Mock arXiv API für Tests
      // Wird implementiert
    });

    it("sollte Papers klassifizieren", async () => {
      // Mock LLM für Tests
      // Wird implementiert
    });

    it("sollte Analysen durchführen", async () => {
      // Wird implementiert
    });

    it("sollte Präsentation erstellen", async () => {
      // Wird implementiert
    });
  });
});
```

### 5.7 dark-energy-research.test.ts

**Fokus:** Erweiterte Pipeline mit allen Agenten

```typescript
import { describe, it, expect, beforeAll, afterAll } from "./compat.ts";
import { createTestHarness } from "./utils/harness";

describe("dark-energy-research.ts", () => {
  let harness: any;
  
  beforeAll(async () => {
    harness = await createTestHarness();
  });
  
  afterAll(async () => {
    await harness.close();
  });

  // E2E-Tests
  describe("End-to-End", () => {
    it("sollte komplette Pipeline durchlaufen", async () => {
      // Mock LLM und arXiv API
      // Wird implementiert
    }, { timeout: 60_000 });

    it("sollte alle Phasen abschließen", async () => {
      // Crawling → Classification → Summarization → Analysis → Presentation
      // Wird implementiert
    }, { timeout: 60_000 });

    it("sollte Chat-Funktionalität unterstützen", async () => {
      // Wird implementiert
    }, { timeout: 60_000 });

    it("sollte Monitoring-Daten liefern", async () => {
      // Wird implementiert
    }, { timeout: 60_000 });
  });
});
```

---

## 6. Test-Abdeckung

Es gibt **kein Coverage-Reporting** — die Suite deckt: die öffentlichen Helfer der Beispiele
(`collect`, `analyse`, `present`, `GolombRuler`, `BitSet`, …), die Space-Semantik
(transaktionales take/commit, Crash-Rückgabe über Txn-Lease, deduplizierte Schreiber,
Ring-Chat über Notify) und die Agenten-Prompts über den Faux-Provider. Was die Tests nicht
abdecken: echte LLM-Läufe (`--live`, arXiv/Dark-Energy-Pipelines mit echtem Modell) und
parallele Worker über Prozessgrenzen hinweg.

## 7. Performance-Tests

### 7.1 Performance-Test-Organisation

```
test/examples/performance/
├── workers.perf.ts       # Master-Worker Performance
├── sensor-pipeline.perf.ts # Pipeline Performance
├── chat.perf.ts         # Chat Performance
└── golomb.perf.ts       # Golomb-Lineal Performance
```

### 7.2 Performance-Metriken

| **Test** | **Beispiel** | **Metrik** | **Zielwert** | **Aktuell** |
|----------|--------------|------------|--------------|-------------|
| Durchsatz | `workers.ts` | Tasks/s | ≥ 100 | - |
| Latenz | `workers.ts` | Task → Result | ≤ 100ms | - |
| Durchsatz | `sensor-pipeline.ts` | Readings/s | ≥ 500 | - |
| Latenz | `sensor-pipeline.ts` | Reading → Summary | ≤ 500ms | - |
| Latenz | `golomb.ts` (n=8) | Suche → Ergebnis | ≤ 1 Minute | - |
| Latenz | `golomb.ts` (n=10) | Suche → Ergebnis | ≤ 10 Minuten | - |
| Speicher | Alle | RAM pro Host | ≤ 1GB | - |
| CPU | Alle | Auslastung | ≤ 80% | - |

### 7.3 Performance-Test-Implementierung

```typescript
// Beispiel: workers.perf.ts
import { describe, it, expect } from "./compat.ts";
import { performance } from "perf_hooks";
import { workersExample } from "../../examples/workers";

describe("Performance: workers.ts", () => {
  it("sollte ≥ 100 Tasks/s verarbeiten", async () => {
    const start = performance.now();
    const numTasks = 1000;
    
    for (let i = 0; i < numTasks; i++) {
      await workersExample(undefined, { jobs: 1 });
    }
    
    const duration = performance.now() - start;
    const throughput = numTasks / (duration / 1000);
    
    expect(throughput).toBeGreaterThanOrEqual(100);
  }, { timeout: 30_000 });

  it("sollte Latenz ≤ 100ms haben", async () => {
    const start = performance.now();
    await workersExample(undefined, { jobs: 1 });
    const duration = performance.now() - start;
    
    expect(duration).toBeLessThanOrEqual(100);
  });
});
```

---

---

## Zusammenfassung

### Aktueller Status

- ✅ **Test-Verzeichnisstruktur erstellt**
- ✅ **Test-Beispiele für alle Beispiele definiert**
- ✅ **Test-Kategorien und Abdeckung dokumentiert**
- ✅ **Performance-Tests geplant**
- ⚠️ **Test-Implementierung in Arbeit** (0% abgeschlossen)

### Nächste Schritte

1. **🔄 Test-Hilfsfunktionen implementieren** (PRIO: ⭐⭐⭐)
   - `utils/harness.ts` – Test-Harness-Setup
   - `utils/assertions.ts` – Custom Assertions
   - `utils/fixtures.ts` – Test-Daten
   - `utils/mocks.ts` – Mock-Implementierungen

2. **🧪 Test-Dateien implementieren** (PRIO: ⭐⭐⭐)
   - `workers.test.ts`
   - `blocking-tool.test.ts`
   - `chat.test.ts`
   - `sensor-pipeline.test.ts`
   - `golomb.test.ts`
   - `arxiv-research.test.ts`
   - `dark-energy-research.test.ts`

3. **⚡ Performance-Tests implementieren** (PRIO: ⭐⭐)
   - `performance/workers.perf.ts`
   - `performance/sensor-pipeline.perf.ts`
   - `performance/chat.perf.ts`
   - `performance/golomb.perf.ts`

4. **📊 Test-Abdeckung erhöhen** (PRIO: ⭐⭐⭐)
   - Unit-Tests: ≥ 80%
   - Integration-Tests: ≥ 80%
   - E2E-Tests: ≥ 60%

---

**Dokument erstellt am 2026-10-06**
**Verantwortlich:** pi-spaces Team
**Version:** 1.0
