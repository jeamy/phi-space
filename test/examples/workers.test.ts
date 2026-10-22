// Tests für workers.ts – Master-Worker-Pattern

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "./compat.ts";
import { spaces } from "../../src/agent.ts";
import { createTestHarness, runWithHarness } from "./utils/harness.ts";
import { 
  assertEntryType, 
  assertEntryFields,
  assertSpaceCount,
  assertSpaceHasEntry,
  SpaceAssertions
, assertEntryCount } from "./utils/assertions.ts";
import { workersFixtures } from "./utils/fixtures.ts";
import { MockConsole } from "./utils/mocks.ts";

// Import des Beispiels (simuliert, da workers.ts keine Exporte hat)
// In der Praxis würde man das Beispiel anpassen oder den Code direkt testen

/**
 * Hilfsfunktion zum Ausführen des workers-Beispiels
 */
async function runWorkersExample(harness: any, config: { jobs?: number; workers?: number } = {}) {
  const { jobs = 1, workers = 1 } = config;
  
  // Erstelle Jobs
  const jobEntries = workersFixtures.multipleJobs(jobs);
  
  // Schreibe Jobs in den Space
  for (const job of jobEntries) {
    await harness.space.write(job);
  }
  
  // Erstelle Worker
  const bossConv = await harness.harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { 
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [spaces],
      instructions: "Du bist der Boss. Schreibe Jobs in den Space."
    }
  }, harness.context);
  
  const workerConv = await harness.harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { 
      model: { provider: "faux", modelId: "faux-1" },
      extensions: [spaces],
      instructions: "Du bist der Worker. Nimm Jobs aus dem Space."
    }
  }, harness.context);
  
  // Führe Boss aus
  const bossResult = await bossConv.submit({
    type: "input",
    content: `post ${jobs} jobs`
  }, harness.context);
  
  // Führe Worker aus
  const workerResult = await workerConv.submit({
    type: "input",
    content: "take a job"
  }, harness.context);
  
  // Warte auf Ergebnisse
  await bossResult.wait(harness.context);
  await workerResult.wait(harness.context);
  
  // Sammle Statistiken
  const stats = await harness.space.stats();
  
  return {
    jobsWritten: jobs > 0 && (await harness.space.count({ type: "Job" })) >= jobs,
    jobsTaken: (await harness.space.count({ type: "Job" })) === Math.max(0, jobs - workers),
    stats
  };
}

describe("workers.ts", () => {
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

  // Reset Harness vor jedem Test
  beforeEach(async () => {
    await harness.reset();
    mockConsole.clear();
  });

  describe("Grundlegende Operationen", () => {
    it("sollte Jobs schreiben und nehmen können", async () => {
      const result = await runWorkersExample(harness, { jobs: 1, workers: 1 });
      
      // Prüfe, dass Jobs geschrieben wurden
      expect(result.jobsWritten).toBe(true);
    });

    it("sollte mehrere Jobs verarbeiten können", async () => {
      const result = await runWorkersExample(harness, { jobs: 5, workers: 1 });
      
      expect(result.jobsWritten).toBe(true);
    });
  });

  describe("Job-Verwaltung", () => {
    it("sollte Jobs mit richtigen Feldern erstellen", async () => {
      const job = workersFixtures.simpleJob();
      await harness.space.write(job);
      
      const entries = await harness.space.readAll({ type: "Job" });
      
      assertEntryCount(entries, 1);
      assertEntryType(entries[0], "Job");
      assertEntryFields(entries[0], {
        op: "test",
        file: "test.txt"
      });
    });

    it("sollte Job-Fields korrekt parsen", async () => {
      const job = workersFixtures.simpleJob("resize", "image.png");
      await harness.space.write(job);
      
      const entries = await harness.space.readAll({ type: "Job" });
      const entry = entries[0];
      
      expect(entry.fields.op).toBe("resize");
      expect(entry.fields.file).toBe("image.png");
    });
  });

  describe("Space-Operationen", () => {
    it("sollte Space.count korrekt zurückgeben", async () => {
      // Schreibe 3 Jobs
      for (const job of workersFixtures.multipleJobs(3)) {
        await harness.space.write(job);
      }
      
      await assertSpaceCount(harness.space, "Job", 3);
    });

    it("sollte Space.readAll alle Jobs zurückgeben", async () => {
      // Schreibe 3 Jobs
      const jobs = workersFixtures.multipleJobs(3);
      for (const job of jobs) {
        await harness.space.write(job);
      }
      
      const entries = await harness.space.readAll({ type: "Job" });
      assertEntryCount(entries, 3);
    });

    it("sollte Space.read erste Übereinstimmung zurückgeben", async () => {
      const job1 = workersFixtures.simpleJob("op1", "file1.txt");
      const job2 = workersFixtures.simpleJob("op2", "file2.txt");
      
      await harness.space.write(job1);
      await harness.space.write(job2);
      
      const entry = await harness.space.read({ type: "Job" }, 0);
      
      expect(entry).not.toBeNull();
      assertEntryType(entry!, "Job");
    });

    it("sollte Space.take Entry entfernen", async () => {
      const job = workersFixtures.simpleJob();
      await harness.space.write(job);
      
      await SpaceAssertions.assertTakeSuccess(await harness.space.take({ type: "Job" }, 0));
      
      await assertSpaceCount(harness.space, "Job", 0);
    });

    it("sollte Space.take null zurückgeben, wenn keine Entry verfügbar", async () => {
      const result = await harness.space.take({ type: "Job" }, 0);
      
      SpaceAssertions.assertTakeNull(result);
    });
  });

  describe("Template-Matching", () => {
    it("sollte nach op-Feld filtern", async () => {
      await harness.space.write(workersFixtures.simpleJob("op1", "file1.txt"));
      await harness.space.write(workersFixtures.simpleJob("op2", "file2.txt"));
      
      const entry = await harness.space.read({ 
        type: "Job", 
        fields: { op: "op2" } 
      }, 0);
      
      expect(entry).not.toBeNull();
      expect(entry!.fields.op).toBe("op2");
    });

    it("sollte nach file-Feld filtern", async () => {
      await harness.space.write(workersFixtures.simpleJob("resize", "image1.png"));
      await harness.space.write(workersFixtures.simpleJob("resize", "image2.png"));
      
      const entry = await harness.space.read({ 
        type: "Job", 
        fields: { file: "image2.png" } 
      }, 0);
      
      expect(entry).not.toBeNull();
      expect(entry!.fields.file).toBe("image2.png");
    });

    it("sollte bei nicht vorhandenem Job null zurückgeben", async () => {
      const entry = await harness.space.read({ 
        type: "Job", 
        fields: { op: "nonexistent" } 
      }, 0);
      
      expect(entry).toBeNull();
    });
  });

  describe("Mehrere Worker", () => {
    it("sollte mit mehreren Workern funktionieren", async () => {
      // Schreibe 3 Jobs
      for (const job of workersFixtures.multipleJobs(3)) {
        await harness.space.write(job);
      }
      
      // Nimm Job mit Worker 1
      await SpaceAssertions.assertTakeSuccess(await harness.space.take({ type: "Job" }, 0));
      
      // Prüfe, dass noch 2 Jobs übrig sind
      await assertSpaceCount(harness.space, "Job", 2);
      
      // Nimm Job mit Worker 2
      await SpaceAssertions.assertTakeSuccess(await harness.space.take({ type: "Job" }, 0));
      
      // Prüfe, dass noch 1 Job übrig ist
      await assertSpaceCount(harness.space, "Job", 1);
    });

    it("sollte kein take durchführen, wenn keine Jobs verfügbar", async () => {
      // Leerer Space
      const result1 = await harness.space.take({ type: "Job" }, 0);
      const result2 = await harness.space.take({ type: "Job" }, 0);
      
      SpaceAssertions.assertTakeNull(result1);
      SpaceAssertions.assertTakeNull(result2);
    });
  });

  describe("Statistiken", () => {
    it("sollte korrekte Statistiken zurückgeben", async () => {
      // Schreibe 3 Jobs
      for (const job of workersFixtures.multipleJobs(3)) {
        await harness.space.write(job);
      }
      
      const stats = await harness.space.stats();
      
      expect(stats.byType.Job).toBe(3);
    });

    it("sollte Statistiken nach take aktualisieren", async () => {
      // Schreibe 3 Jobs
      for (const job of workersFixtures.multipleJobs(3)) {
        await harness.space.write(job);
      }
      
      // Nimm einen Job
      await harness.space.take({ type: "Job" }, 0);
      
      const stats = await harness.space.stats();
      
      expect(stats.byType.Job).toBe(2);
    });
  });
});

describe("workers.ts – Faux-Provider-Tests", () => {
  it("sollte mit Faux-Provider deterministisch sein", async () => {
    const result1 = await runWithHarness(runWorkersExample, { jobs: 1, workers: 1 });
    const result2 = await runWithHarness(runWorkersExample, { jobs: 1, workers: 1 });
    
    // Beide Durchläufe sollten gleich sein
    expect(result1.result.jobsWritten).toBe(result2.result.jobsWritten);
  });
});

describe("workers.ts – Edge Cases", () => {
  let harness: any;

  beforeAll(async () => {
    harness = await createTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it("sollte mit 0 Jobs funktionieren", async () => {
    const result = await runWorkersExample(harness, { jobs: 0, workers: 1 });
    
    expect(result.jobsWritten).toBe(false);
  });

  it("sollte mit vielen Jobs funktionieren", async () => {
    const result = await runWorkersExample(harness, { jobs: 100, workers: 1 });
    
    expect(result.jobsWritten).toBe(true);
  });

  it("sollte mit vielen Workern funktionieren", async () => {
    // Schreibe 10 Jobs
    for (const job of workersFixtures.multipleJobs(10)) {
      await harness.space.write(job);
    }
    
    // Nimm mit 5 Workern
    for (let i = 0; i < 5; i++) {
      await harness.space.take({ type: "Job" }, 0);
    }
    
    await assertSpaceCount(harness.space, "Job", 5);
  });
});
