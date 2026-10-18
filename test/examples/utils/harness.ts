// Test-Harness-Utilities für phi-spaces Beispiele
// Bietet eine standardisierte Umgebung für Tests mit Harness, Space und Agenten

import { 
  BACKGROUND_CONTEXT as ctx
} from "@earendil-works/chord/context";
import { 
  createModels, 
  type Models 
} from "@earendil-works/pi-ai/models";
import { 
  fauxAssistantMessage, 
  fauxProvider, 
  fauxToolCall 
} from "@earendil-works/pi-ai/providers/faux";
import { 
  createRegistry, 
  Harness, 
  MemoryStorage 
} from "@earendil-works/pi-durable";
import { 
  FOREVER, 
  PhiSpaces,
  spaces, 
  type EntryDraft
} from "../../../src/index.ts";

/**
 * Test-Harness-Konfiguration
 */
export interface TestHarnessConfig {
  // Storage-Konfiguration
  useMemoryStorage?: boolean;
  useJsonlStorage?: boolean;
  storageDir?: string;
  
  // Modell-Konfiguration
  useFauxProvider?: boolean;
  fauxResponses?: any[];
  
  // Space-Konfiguration
  registerSpaces?: boolean;
  registerResearch?: boolean;
  
  // Timeout-Konfiguration
  defaultTimeout?: number;
}

/**
 * Test-Harness mit allen notwendigen Komponenten
 */
export interface TestHarness {
  harness: Harness;
  space: PhiSpaces;
  models: Models;
  config: TestHarnessConfig;
  context: typeof ctx;
  
  // Cleanup
  close: () => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Erstellt einen Test-Harness mit MemoryStorage und Faux-Provider
 */
export async function createTestHarness(config: TestHarnessConfig = {}): Promise<TestHarness> {
  const {
    useMemoryStorage = true,
    useJsonlStorage = false,
    useFauxProvider = true,
    registerSpaces = true,
    registerResearch = false,
    defaultTimeout = 30_000
  } = config;

  // Storage erstellen
  const storage = useMemoryStorage 
    ? new MemoryStorage() 
    : await import("@earendil-works/pi-durable/storage/jsonl/node").then(
        ({ openNodeJsonlStorage }) => openNodeJsonlStorage(config.storageDir || "/tmp/phi-spaces-test", ctx)
      );

  // Modelle erstellen
  const models = createModels();
  
  if (useFauxProvider) {
    const faux = fauxProvider();
    if (config.fauxResponses) {
      faux.setResponses(config.fauxResponses);
    } else {
      // Standard-Faux-Responses für Tests
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("space_write", { type: "Test", fields: {} }), { stopReason: "toolUse" }),
        fauxAssistantMessage("ok"),
        fauxAssistantMessage(fauxToolCall("space_take", { type: "Test" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("took it"),
      ]);
    }
    models.setProvider(faux.provider);
  }

  // Registry erstellen
  const registry = createRegistry();
  
  if (registerSpaces) {
    registry.install(spaces);
  }
  
  if (registerResearch) {
    const { research } = await import("../../../examples/arxiv-tool.ts");
    registry.install(research);
  }

  // Harness erstellen
  const harness = await Harness.open(storage, { models, registry }, ctx);
  const space = new PhiSpaces(harness, ctx);

  // Test-Harness-Objekt zurückgeben
  const result: TestHarness = {
    harness,
    space,
    models,
    config: {
      ...config,
      useMemoryStorage,
      useJsonlStorage,
      useFauxProvider,
      registerSpaces,
      registerResearch,
      defaultTimeout
    },
    context: ctx,
    
    async close() {
      await harness.close(ctx);
    },
    
    async reset() {
      await harness.close(ctx);
      // Neues Harness erstellen
      const newStorage = useMemoryStorage 
        ? new MemoryStorage() 
        : await import("@earendil-works/pi-durable/storage/jsonl/node").then(
            ({ openNodeJsonlStorage }) => openNodeJsonlStorage(config.storageDir || "/tmp/phi-spaces-test", ctx)
          );
      const newHarness = await Harness.open(newStorage, { models, registry }, ctx);
      result.harness = newHarness;
      result.space = new PhiSpaces(newHarness, ctx);
    }
  };
  return result;
}

/**
 * Erstellt einen Test-Harness speziell für Faux-Provider-Tests
 */
export async function createFauxHarness(responses: any[] = []): Promise<TestHarness> {
  return createTestHarness({
    useMemoryStorage: true,
    useFauxProvider: true,
    fauxResponses: responses,
    registerSpaces: true
  });
}

/**
 * Hilfsfunktion zum Ausführen von Beispielen mit Test-Harness
 */
export async function runWithHarness(
  exampleFn: (harness?: any, config?: any) => Promise<any>,
  config?: any
): Promise<any> {
  const harness = await createFauxHarness();
  try {
    const result = await exampleFn(harness, config);
    return { result, harness };
  } finally {
    await harness.close();
  }
}

/**
 * Erstellt Test-Daten für Space-Operationen
 */
export function createTestEntries(count: number, typeName: string = "Test"): EntryDraft[] {
  const entries: EntryDraft[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      type: typeName,
      fields: {
        id: `test-${typeName.toLowerCase()}-${i}`,
        value: i,
        timestamp: new Date().toISOString()
      }
    });
  }
  return entries;
}

/**
 * Hilfsfunktion zum Warten auf Bedingungen im Space
 */
export async function waitForCondition(
  space: PhiSpaces,
  condition: () => Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}

/**
 * Hilfsfunktion zum Warten auf Entry im Space
 */
export async function waitForEntry(
  space: PhiSpaces,
  template: any,
  timeout: number = 5000
) {
  const found = await waitForCondition(space, async () => {
    const entries = await space.readAll(template);
    return entries.length > 0;
  }, timeout);
  return found ? await space.read(template, timeout) : null;
}

/**
 * Hilfsfunktion zum Warten auf Count im Space
 */
export async function waitForCount(
  space: PhiSpaces,
  template: any,
  expectedCount: number,
  timeout: number = 5000
): Promise<boolean> {
  return waitForCondition(space, async () => {
    const count = await space.count(template);
    return count >= expectedCount;
  }, timeout);
}

/**
 * Erstellt einen einfachen Agenten für Tests
 */
export function createTestAgent(instructions: string, model?: { provider: string; modelId: string }) {
  return {
    model: model || { provider: "faux", modelId: "faux-1" },
    extensions: [spaces],
    instructions
  };
}
