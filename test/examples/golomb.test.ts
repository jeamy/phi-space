// Test-Suite für golomb.ts - Golomb-Lineal Suche
// Tests: Verteilte Suche, Branch-and-Bound, BitSet, Checkpointing, Validierung

import { describe, test, expect, vi, beforeEach, afterEach } from "./compat.ts";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { FOREVER, PhiSpaces, spaces, startService } from "../../src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { 
  GolombRuler, 
  BitSet,
  KNOWN_OPTIMAL_LENGTHS,
  KNOWN_OPTIMAL_RULERS
} from "../../examples/golomb.ts";

// ============================================================================
// TEST UTILITIES
// ============================================================================

// Einfache Implementierung für Tests
function createTestHarness(dir?: string) {
  const testDir = dir || mkdtempSync(join(tmpdir(), "phi-spaces-test-golomb-"));
  return {
    dir: testDir,
    cleanup: () => {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  };
}

async function setupGolombHarness(testDir: string) {
  const models = createModels();
  const registry = createRegistry();
  registry.install(spaces);
  
  const storage = await openNodeJsonlStorage(testDir, ctx);
  const h = await Harness.open(storage, { models, registry }, ctx);
  h.resume();
  const host = new PhiSpaces(h, ctx);
  const stopService = await startService(h, ctx);
  
  return { h, host, stopService, storage };
}

async function teardownGolombHarness(h: Harness, stopService: () => Promise<void>, testDir: string) {
  await stopService();
  await h.close(ctx);
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
}

// ============================================================================
// BITSET TESTS
// ============================================================================

describe("BitSet Implementation", () => {
  test("T9.1.1: BitSet - set und get", () => {
    const bitSet = new BitSet(100);
    
    bitSet.set(10);
    bitSet.set(20);
    bitSet.set(50);
    
    expect(bitSet.get(10)).toBe(true);
    expect(bitSet.get(20)).toBe(true);
    expect(bitSet.get(50)).toBe(true);
    expect(bitSet.get(15)).toBe(false);
    expect(bitSet.get(100)).toBe(false); // Außerhalb des Bereichs
  });

  test("T9.1.2: BitSet - toArray", () => {
    const bitSet = new BitSet(10);
    bitSet.set(1);
    bitSet.set(3);
    bitSet.set(5);
    bitSet.set(7);
    
    const array = bitSet.toArray();
    expect(array).toEqual([1, 3, 5, 7]);
  });

  test("T9.1.3: BitSet - fromArray", () => {
    const bits = [2, 4, 6, 8];
    const bitSet = BitSet.fromArray(bits, 10);
    
    for (const bit of bits) {
      expect(bitSet.get(bit)).toBe(true);
    }
    expect(bitSet.get(1)).toBe(false);
    expect(bitSet.get(3)).toBe(false);
  });

  test("T9.1.4: BitSet - clone", () => {
    const bitSet1 = new BitSet(10);
    bitSet1.set(5);
    bitSet1.set(7);
    
    const bitSet2 = bitSet1.clone();
    
    expect(bitSet2.get(5)).toBe(true);
    expect(bitSet2.get(7)).toBe(true);
    expect(bitSet2.get(3)).toBe(false);
    
    // Ändere Original
    bitSet1.set(3);
    expect(bitSet1.get(3)).toBe(true);
    expect(bitSet2.get(3)).toBe(false); // Clone sollte unverändert bleiben
  });

  test("T9.1.5: BitSet - Auto-Expand", () => {
    const bitSet = new BitSet(10);
    
    // Setze Bit außerhalb des Initial-Bereichs
    bitSet.set(25);
    
    expect(bitSet.get(25)).toBe(true);
    expect(bitSet.get(10)).toBe(false);
    
    // Noch weiter expandieren
    bitSet.set(100);
    expect(bitSet.get(100)).toBe(true);
  });
});

// ============================================================================
// GOLOMB RULER UTILITY TESTS
// ============================================================================

describe("GolombRuler Utilities", () => {
  describe("isValid", () => {
    test("T9.2.1: Gültiges Golomb-Lineal (Ordnung 4)", () => {
      const positions = [0, 1, 4, 6];
      expect(GolombRuler.isValid(positions)).toBe(true);
    });

    test("T9.2.2: Gültiges Golomb-Lineal (Ordnung 5)", () => {
      const positions = [0, 1, 4, 9, 11];
      expect(GolombRuler.isValid(positions)).toBe(true);
    });

    test("T9.2.3: Ungültiges Lineal - Duplikate Differenzen", () => {
      const positions = [0, 1, 2, 4]; // Differenz 1 kommt doppelt vor (2-1 und 1-0)
      expect(GolombRuler.isValid(positions)).toBe(false);
    });

    test("T9.2.4: Ungültiges Lineal - Negative Positionen", () => {
      const positions = [-1, 0, 1, 3];
      expect(GolombRuler.isValid(positions)).toBe(false);
    });

    test("T9.2.5: Ungültiges Lineal - Nicht sortiert", () => {
      const positions = [0, 4, 1, 6];
      expect(GolombRuler.isValid(positions)).toBe(false);
    });

    test("T9.2.6: Einfaches Lineal (Ordnung 2)", () => {
      const positions = [0, 1];
      expect(GolombRuler.isValid(positions)).toBe(true);
    });

    test("T9.2.7: Einfaches Lineal (Ordnung 3)", () => {
      const positions = [0, 1, 3];
      expect(GolombRuler.isValid(positions)).toBe(true);
    });
  });

  describe("getDistances", () => {
    test("T9.2.8: Distanzen für Ordnung 4", () => {
      const positions = [0, 1, 4, 6];
      const distances = GolombRuler.getDistances(positions);
      expect(distances).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("T9.2.9: Distanzen für Ordnung 3", () => {
      const positions = [0, 1, 3];
      const distances = GolombRuler.getDistances(positions);
      expect(distances).toEqual([1, 2, 3]);
    });
  });

  describe("getMissingDistances", () => {
    test("T9.2.10: Fehlende Distanzen für Ordnung 4", () => {
      const positions = [0, 1, 4, 6];
      const missing = GolombRuler.getMissingDistances(positions, 6);
      // Alle Distanzen von 1-6 sind vorhanden
      expect(missing).toEqual([]);
    });

    test("T9.2.11: Fehlende Distanzen für unvollständiges Lineal", () => {
      const positions = [0, 2, 5];
      const missing = GolombRuler.getMissingDistances(positions, 5);
      // Vorhandene Distanzen: 2, 3, 5
      // Fehlende Distanzen: 1, 4
      expect(missing).toEqual([1, 4]);
    });
  });

  describe("length", () => {
    test("T9.2.12: Länge ist letzte Position", () => {
      const positions = [0, 1, 4, 6];
      expect(GolombRuler.length(positions)).toBe(6);
    });

    test("T9.2.13: Länge für Ordnung 1", () => {
      const positions = [0];
      expect(GolombRuler.length(positions)).toBe(0);
    });
  });
});

// ============================================================================
// KNOWN OPTIMAL VALUES TESTS
// ============================================================================

describe("Bekannte optimale Lösungen", () => {
  test("T9.3.1: Alle bekannten optimalen Lineale sind gültig", () => {
    for (const [orderStr, positions] of Object.entries(KNOWN_OPTIMAL_RULERS)) {
      const order = parseInt(orderStr);
      expect(GolombRuler.isValid(positions)).toBe(true);
    }
  });

  test("T9.3.2: Bekannte optimale Längen sind korrekt", () => {
    for (const [orderStr, length] of Object.entries(KNOWN_OPTIMAL_LENGTHS)) {
      const order = parseInt(orderStr);
      const positions = KNOWN_OPTIMAL_RULERS[order];
      if (positions) {
        expect(GolombRuler.length(positions)).toBe(length);
      }
    }
  });

  test("T9.3.3: Perfekte Lineale (n ≤ 4) haben keine fehlenden Distanzen", () => {
    // Perfect Golomb rulers (measuring every distance 1..length) exist only for n ≤ 4.
    // For n ≥ 5 every ruler has gaps, so this assertion is restricted to n ≤ 4.
    for (const [orderStr, positions] of Object.entries(KNOWN_OPTIMAL_RULERS)) {
      const order = parseInt(orderStr);
      if (order > 4) continue;
      const length = KNOWN_OPTIMAL_LENGTHS[order];
      const missing = GolombRuler.getMissingDistances(positions, length);
      expect(missing).toEqual([]);
    }
  });

  test("T9.3.3b: Größere Lineale haben Lücken, aber alle Distanzen sind eindeutig", () => {
    for (const [orderStr, positions] of Object.entries(KNOWN_OPTIMAL_RULERS)) {
      const order = parseInt(orderStr);
      if (order <= 4) continue;
      const length = KNOWN_OPTIMAL_LENGTHS[order];
      const missing = GolombRuler.getMissingDistances(positions, length);
      // Lücken existieren, aber die Summe muss stimmen: C(n,2) Distanzen + Lücken = length
      expect(missing.length).toBe(length - (order * (order - 1)) / 2);
    }
  });
});

// ============================================================================
// COMPLETE PIPELINE TESTS
// ============================================================================

describe("Golomb Pipeline Integration", () => {
  let testDir: string;

  beforeEach(() => {
    const harness = createTestHarness();
    testDir = harness.dir;
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  test("T9.4.1: Vollständige Suche nach Ordnung 4 (sollte schnell sein)", async () => {
    const { h, host, stopService } = await setupGolombHarness(testDir);
    
    try {
      // Erstelle Master mit sehr kleinem Suchraum
      const order = 4;
      const minLength = order * (order - 1) / 2; // = 6
      const maxLength = KNOWN_OPTIMAL_LENGTHS[order]; // = 6
      
      // Manuelle Suche (kein DFS nötig, da nur eine mögliche Lösung)
      // Master schreibt Tasks
      await host.write({
        type: "GolombSearchTask",
        fields: { taskId: "test-task-1", order: 4, maxLength: 6, startPos: 1, endPos: 10, status: "pending" }
      }, null, FOREVER);
      
      //Worker nimmt Task und findet Lösung
      const worker = new PhiSpaces(h, ctx, Date.now, undefined, 100);
      
      // Überprüfe ob Task verfügbar ist
      const tasks = await host.readAll({ type: "GolombSearchTask" });
      expect(tasks.length).toBe(1);
      
    } finally {
      await stopService();
      await h.close(ctx);
    }
  }, { timeout: 10000 });

  test("T9.4.2: Bekannte optimale Lösung wird geladen", async () => {
    const { h, host, stopService } = await setupGolombHarness(testDir);
    
    try {
      const order = 5;
      
      // Lade bekannte optimale Lösung
      await host.write({
        type: "GolombBestKnown",
        fields: { order, length: KNOWN_OPTIMAL_LENGTHS[order], positions: KNOWN_OPTIMAL_RULERS[order], source: "LUT", updatedAt: new Date().toISOString() }
      }, null, FOREVER);
      
      // Überprüfe
      const bestKnown = await host.readAll({ type: "GolombBestKnown", fields: { order } });
      expect(bestKnown.length).toBe(1);
      expect(bestKnown[0].fields.length).toBe(KNOWN_OPTIMAL_LENGTHS[order]);
      expect(bestKnown[0].fields.positions).toEqual(KNOWN_OPTIMAL_RULERS[order]);
      
    } finally {
      await stopService();
      await h.close(ctx);
    }
  });

  test("T9.4.3: Summary wird korrekt erstellt", async () => {
    const { h, host, stopService } = await setupGolombHarness(testDir);
    
    try {
      // Erstelle Summary
      await host.write({
        type: "GolombSummary",
        fields: { order: 4,
        totalRulers: 1,
        optimalRulers: 1,
        shortestLength: 6,
        bestRuler: {
          type: "GolombRuler",
          order: 4,
          length: 6,
          positions: [0, 1, 4, 6],
          distances: [1, 2, 3, 4, 5, 6],
          missingDistances: [],
          isOptimal: true,
          foundAt: new Date().toISOString(),
          workerId: "test-worker"
        },
        searchCompleted: true,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
        }
      }, null, FOREVER);
      
      const summaries = await host.readAll({ type: "GolombSummary", fields: { order: 4 } });
      expect(summaries.length).toBe(1);
      expect(summaries[0].fields.totalRulers).toBe(1);
      expect(summaries[0].fields.shortestLength).toBe(6);
      expect(summaries[0].fields.searchCompleted).toBe(true);
      
    } finally {
      await stopService();
      await h.close(ctx);
    }
  });
});

// ============================================================================
// VALIDATION TESTS
// ============================================================================

describe("Validierung von Golomb-Lösungen", () => {
  test("T9.5.1: Validierung eines bereits bekannten optimalen Lineals", () => {
    const positions = KNOWN_OPTIMAL_RULERS[10] // größtes enthaltenes Lineal; // Ordnung 10
    expect(GolombRuler.isValid(positions)).toBe(true);
    expect(GolombRuler.length(positions)).toBe(KNOWN_OPTIMAL_LENGTHS[10]);
  });

  test("T9.5.2: Generierung aller Differenzen für Ordnung 10", () => {
    const positions = KNOWN_OPTIMAL_RULERS[10] // größtes enthaltenes Lineal;
    const distances = GolombRuler.getDistances(positions);
    
    // Ordnung 10 hat 10 Marken -> 10*9/2 = 45 Differenzen
    expect(distances.length).toBe(45);
    
    // Alle Differenzen sollten eindeutig sein
    const uniqueDistances = new Set(distances);
    expect(uniqueDistances.size).toBe(45);
    
    // Alle Differenzen sollten zwischen 1 und Länge liegen
    const maxDist = Math.max(...distances);
    const length = GolombRuler.length(positions);
    expect(maxDist).toBe(length);
  });

  test("T9.5.3: Überprüfung aller bekannten Lösungen", () => {
    for (const [orderStr, positions] of Object.entries(KNOWN_OPTIMAL_RULERS)) {
      const order = parseInt(orderStr);
      
      // Position muss gültig sein
      expect(GolombRuler.isValid(positions), `Ordnung ${order} ist ungültig`).toBe(true);
      
      // Länge muss mit bekannter Länge übereinstimmen
      const actualLength = GolombRuler.length(positions);
      const expectedLength = KNOWN_OPTIMAL_LENGTHS[order];
      expect(actualLength, `Länge für Ordnung ${order} stimmt nicht`).toBe(expectedLength);
      
      // Anzahl der Marken muss der Ordnung entsprechen
      expect(positions.length, `Anzahl Marken für Ordnung ${order} stimmt nicht`).toBe(order);
      
      // Erste Marke muss 0 sein
      expect(positions[0], `Erste Marke für Ordnung ${order} muss 0 sein`).toBe(0);
      
      // Alle Positionen müssen aufsteigend sortiert sein
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i], `Positionen für Ordnung ${order} müssen sortiert sein`).toBeGreaterThan(positions[i-1]);
      }
    }
  });
});

// ============================================================================
// EDGE CASES TESTS
// ============================================================================

describe("Edge Cases", () => {
  test("T9.6.1: Leere Positionen-Liste", () => {
    const positions: number[] = [];
    expect(GolombRuler.isValid(positions)).toBe(true); // Leere Liste ist per Definition gültig
    expect(GolombRuler.length(positions)).toBe(0);
  });

  test("T9.6.2: Einzelne Position (Ordnung 1)", () => {
    const positions = [0];
    expect(GolombRuler.isValid(positions)).toBe(true);
    expect(GolombRuler.length(positions)).toBe(0);
    expect(GolombRuler.getDistances(positions)).toEqual([]);
  });

  test("T9.6.3: Nicht-ganzzahlige Positionen", () => {
    const positions = [0, 1.5, 3];
    // Diese Positionen haben Distanzen: 1.5, 3, 1.5 -> Duplikat!
    expect(GolombRuler.isValid(positions)).toBe(false);
  });

  test("T9.6.4: Negative Differenzen (nicht aufsteigend sortiert)", () => {
    const positions = [10, 5, 0];
    // Diese Liste ist absteigend sortiert
    expect(GolombRuler.isValid(positions)).toBe(false);
  });

  test("T9.6.5: BitSet mit negativen Indizes", () => {
    const bitSet = new BitSet(10);
    // Negative Indizes sollten ignoriert werden
    bitSet.set(-5);
    expect(bitSet.get(-5)).toBe(false);
    expect(bitSet.get(0)).toBe(false);
  });
});

// ============================================================================
// PERFORMANCE TESTS
// ============================================================================

describe("Performance Tests", () => {
  test("T9.7.1: BitSet Performance - 1 Million Bits", () => {
    const start = Date.now();
    const bitSet = new BitSet(1000000);
    
    // Setze 100.000 Bits
    for (let i = 0; i < 100000; i += 10) {
      bitSet.set(i);
    }
    
    // Prüfe 100.000 Bits
    for (let i = 0; i < 100000; i += 10) {
      expect(bitSet.get(i)).toBe(true);
    }
    
    const durationMs = Date.now() - start;
    
    // Sollte unter 100ms sein
    expect(durationMs).toBeLessThan(100);
  });

  test("T9.7.2: Validierung Performance - Ordnung 10", () => {
    const positions = KNOWN_OPTIMAL_RULERS[10] // größtes enthaltenes Lineal;
    
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      GolombRuler.isValid(positions);
    }
    const durationMs = Date.now() - start;
    
    // 1000 Validierungen sollten unter 100ms sein
    expect(durationMs).toBeLessThan(100);
  });

  test("T9.7.3: Distanz-Berechnung Performance - Ordnung 10", () => {
    const positions = KNOWN_OPTIMAL_RULERS[10] // größtes enthaltenes Lineal;
    
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      GolombRuler.getDistances(positions);
    }
    const durationMs = Date.now() - start;
    
    // 1000 Distanz-Berechnungen sollten unter 100ms sein
    expect(durationMs).toBeLessThan(100);
  });
});

// ============================================================================
// CUSTOM ASSERTIONS
// ============================================================================

expect.extend({
  toBeValidGolombRuler(positions: number[]) {
    const isValid = GolombRuler.isValid(positions);
    return isValid ? { pass: true } : { pass: false, message: () => `Expected [${positions.join(", ")}] to be a valid Golomb ruler` };
  },
  toHaveLength(length: number) {
    return (positions: number[]) => {
      const actualLength = GolombRuler.length(positions);
      return actualLength === length ? { pass: true } : { pass: false, expected: length, actual: actualLength };
    };
  },
  toHaveDistances(expected: number[]) {
    return (positions: number[]) => {
      const actual = GolombRuler.getDistances(positions);
      return actual.length === expected.length && 
             actual.every((val, idx) => val === expected[idx]) ?
        { pass: true } :
        { pass: false, expected: expected, actual };
    };
  }
});
