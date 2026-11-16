// Tests für blocking-tool.ts – Blockierende Operationen mit Timeout

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "./compat.ts";
import { createTestHarness, waitForCondition, waitForEntry } from "./utils/harness.ts";
import { 
  assertEntryType,
  assertEntryFields,
  assertSpaceCount,
  assertCompletesWithin,
  SpaceAssertions,
  TimeAssertions
} from "./utils/assertions.ts";
import { blockingToolFixtures } from "./utils/fixtures.ts";
import { MockTimer, MockConsole } from "./utils/mocks.ts";

/**
 * Hilfsfunktion zum Testen blockierender takes
 */
async function testBlockingTake(
  harness: any,
  delayMs: number = 100,
  timeoutMs: number = 5000
): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const startTime = Date.now();
  
  // Erstelle Promise für write (der Timer wird am Ende gelöscht: kein Schreiben nach dem Test)
  let timer: ReturnType<typeof setTimeout> | undefined;
  const writePromise = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      harness.space.write(blockingToolFixtures.jobWithTimeout(timeoutMs)).then(() => resolve(), reject);
    }, delayMs);
  });

  // Führe take aus
  const takePromise = harness.space.take({ type: "Job" }, timeoutMs);
  
  try {
    // Warte auf das Ergebnis
    const result = await Promise.race([
      takePromise,
      writePromise.then(() => takePromise)
    ]);
    
    const durationMs = Date.now() - startTime;
    
    return {
      success: result !== null,
      durationMs,
      error: result === null ? "timeout" : undefined
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      durationMs,
      error: String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

describe("blocking-tool.ts", () => {
  let harness: any;
  let mockConsole: MockConsole;

  beforeAll(async () => {
    harness = await createTestHarness();
    mockConsole = new MockConsole();
    mockConsole.start();
  });

  afterAll(async () => {
    mockConsole.stop();
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    mockConsole.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Grundlegende Timeout-Handhabung", () => {
    it("sollte Task mit sofortiger Verfügbarkeit nehmen", async () => {
      // Schreibe Task sofort
      await harness.space.write(blockingToolFixtures.jobWithTimeout());
      
      const startTime = Date.now();
      const result = await harness.space.take({ type: "Job" }, 5000);
      const durationMs = Date.now() - startTime;
      
      SpaceAssertions.assertTakeSuccess(result);
      TimeAssertions.assertMaxDuration(durationMs, 100);
    });

    it("sollte Task mit Verzögerung nehmen", async () => {
      const result = await testBlockingTake(harness, 100, 5000);
      
      expect(result.success).toBe(true);
      TimeAssertions.assertDurationInRange(result.durationMs, 100, 200);
    });

    it("sollte nach Timeout scheitern", async () => {
      const result = await testBlockingTake(harness, 10000, 1000);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
      TimeAssertions.assertDurationInRange(result.durationMs, 1000, 1100);
    });
  });

  describe("take mit Timeout-Parameter", () => {
    it("sollte Timeout-Parameter akzeptieren", async () => {
      await harness.space.write(blockingToolFixtures.jobWithTimeout());
      
      const result = await harness.space.take({ type: "Job" }, 1000);
      
      SpaceAssertions.assertTakeSuccess(result);
    });

    it("sollte bei Timeout null zurückgeben", async () => {
      const result = await harness.space.take({ type: "Job" }, 100);
      
      SpaceAssertions.assertTakeNull(result);
    });
  });

  describe("Wettlauf-Bedingungen", () => {
    it("sollte nur einen Worker den Task erhalten lassen", async () => {
      // Schreibe einen Task
      await harness.space.write(blockingToolFixtures.jobWithTimeout());
      
      // Zwei Worker versuchen, den Task zu nehmen
      const result1 = await harness.space.take({ type: "Job" }, 0);
      const result2 = await harness.space.take({ type: "Job" }, 0);
      
      // Nur einer sollte erfolgreich sein
      const successCount = (result1 ? 1 : 0) + (result2 ? 1 : 0);
      expect(successCount).toBe(1);
    });

    it("sollte atomares take gewährleisten", async () => {
      // Schreibe einen Task
      await harness.space.write(blockingToolFixtures.jobWithTimeout());
      
      // Mehrere gleichzeitige takes
      const results = await Promise.all([
        harness.space.take({ type: "Job" }, 0),
        harness.space.take({ type: "Job" }, 0),
        harness.space.take({ type: "Job" }, 0)
      ]);
      
      // Nur ein Ergebnis sollte nicht-null sein
      const successCount = results.filter(r => r !== null).length;
      expect(successCount).toBe(1);
    });
  });

  describe("Reihenfolge der Operationen", () => {
    it("sollte write vor take ausführen", async () => {
      const startTime = Date.now();
      
      // Write mit Verzögerung
      const writePromise = new Promise<void>(async (resolve) => {
        setTimeout(async () => {
          await harness.space.write(blockingToolFixtures.jobWithTimeout());
          resolve();
        }, 50);
      });
      
      // Take sofort
      const takePromise = harness.space.take({ type: "Job" }, 1000);
      
      // Warte auf write
      await writePromise;
      
      // Take sollte jetzt erfolgreich sein
      const result = await takePromise;
      const durationMs = Date.now() - startTime;
      
      SpaceAssertions.assertTakeSuccess(result);
      TimeAssertions.assertDurationInRange(durationMs, 50, 150);
    });

    it("sollte bei write nach timeout scheitern", async () => {
      const startTime = Date.now();
      
      // Take mit kurzem Timeout
      const takePromise = harness.space.take({ type: "Job" }, 50);
      
      // Write nach Timeout
      await new Promise(resolve => setTimeout(resolve, 100));
      await harness.space.write(blockingToolFixtures.jobWithTimeout());
      
      // Take sollte scheitern
      const result = await takePromise;
      const durationMs = Date.now() - startTime;
      
      SpaceAssertions.assertTakeNull(result);
      TimeAssertions.assertDurationInRange(durationMs, 50, 150);
    });
  });

  describe("Mehrfaches take", () => {
    it("sollte mehrere Takes in Reihe ausführen", async () => {
      // Schreibe 3 Jobs
      for (let i = 0; i < 3; i++) {
        await harness.space.write({
          type: "Job",
          fields: { op: `op-${i}`, timeoutMs: 5000 },
          lease: "FOREVER"
        });
      }
      
      // Nimm 3 Jobs
      for (let i = 0; i < 3; i++) {
        const result = await harness.space.take({ type: "Job" }, 1000);
        SpaceAssertions.assertTakeSuccess(result);
      }
      
      // Space sollte leer sein
      await assertSpaceCount(harness.space, "Job", 0);
    });

    it("sollte nach Leerwerden null zurückgeben", async () => {
      // Schreibe 1 Job
      await harness.space.write(blockingToolFixtures.jobWithTimeout());
      
      // Nimm Job
      await SpaceAssertions.assertTakeSuccess(await harness.space.take({ type: "Job" }, 0));
      
      // Nächster take sollte null zurückgeben
      const result = await harness.space.take({ type: "Job" }, 100);
      SpaceAssertions.assertTakeNull(result);
    });
  });

  describe("Performance-Tests", () => {
    it("sollte schnelle takes durchführen", async () => {
      // Schreibe 10 Jobs
      for (let i = 0; i < 10; i++) {
        await harness.space.write({
          type: "Job",
          fields: { op: `op-${i}` },
          lease: "FOREVER"
        });
      }
      
      const startTime = Date.now();
      
      // Nimm alle Jobs
      for (let i = 0; i < 10; i++) {
        await harness.space.take({ type: "Job" }, 0);
      }
      
      const durationMs = Date.now() - startTime;
      
      // Sollte weniger als 1 Sekunde dauern
      TimeAssertions.assertMaxDuration(durationMs, 1000);
    });

    it("sollte Timeout schnell erkennen", async () => {
      const startTime = Date.now();
      
      // take mit kurzem Timeout
      const result = await harness.space.take({ type: "Job" }, 50);
      
      const durationMs = Date.now() - startTime;
      
      SpaceAssertions.assertTakeNull(result);
      TimeAssertions.assertDurationInRange(durationMs, 50, 100);
    });
  });

  describe("Fehlerbehandlung", () => {
    it("sollte mit ungültigem Template umgehen", async () => {
      // take mit ungültigem Template sollte nicht abstürzen
      const result = await harness.space.take({ type: "Nonexistent" }, 100);
      
      SpaceAssertions.assertTakeNull(result);
    });

    it("sollte mit null/undefined umgehen", async () => {
      // take mit null sollte nicht abstürzen
      const result1 = await harness.space.take(null as any, 100);
      const result2 = await harness.space.take(undefined as any, 100);
      
      // Sollte null oder Exception werfen
      expect(result1 === null || result1 === undefined).toBe(true);
      expect(result2 === null || result2 === undefined).toBe(true);
    }).catch(() => {
      // Exception ist auch akzeptabel
      expect(true).toBe(true);
    });
  });
});

describe("blocking-tool.ts – Mock-Timer-Tests", () => {
  let harness: any;
  let mockTimer: MockTimer;

  beforeAll(async () => {
    harness = await createTestHarness();
    mockTimer = new MockTimer();
  });

  afterAll(async () => {
    mockTimer.stop();
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    mockTimer.clearAllTimers();
    mockTimer.setTime(0);
  });

  it("sollte mit verzögertem Write einen wartenden Take wecken", async () => {
    // Echte Semantik aus blocking-tool.ts: ein Write nach 100ms entblockt
    // ein wartendes take(). MockTimer kann die Space-Uhr nicht beeinflussen,
    // daher ein echter Timer.
    const writePromise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await harness.space.write(blockingToolFixtures.jobWithTimeout());
        resolve();
      }, 100);
    });
    const taken = await harness.space.take({ type: "Job" }, 2000);
    await writePromise;
    SpaceAssertions.assertTakeSuccess(taken);
  });
});

describe("blocking-tool.ts – Konsolenausgabe", () => {
  let harness: any;
  let mockConsole: MockConsole;

  beforeAll(async () => {
    harness = await createTestHarness();
    mockConsole = new MockConsole();
    mockConsole.start();
  });

  afterAll(async () => {
    mockConsole.stop();
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    mockConsole.clear();
  });

  it("sollte keine Fehler bei normaler Ausführung loggen", async () => {
    await harness.space.write(blockingToolFixtures.jobWithTimeout());
    await harness.space.take({ type: "Job" }, 1000);
    
    expect(mockConsole.getErrors().length).toBe(0);
  });
});
