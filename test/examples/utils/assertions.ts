// Custom Assertions für phi-spaces Tests
// Erweitert Vitest/Jest Assertions um Space-spezifische Prüfungen

import { expect } from "../compat.ts";
import type { PhiSpaces, Taken } from "../../../src/index.ts";
import type { PhiSpaces as Space } from "../../../src/index.ts";
type Entry = Taken;
import type { TestHarness } from "./harness.ts";

/**
 * Prüft, dass eine Entry vom erwarteten Typ ist
 */
export function assertEntryType(entry: Entry, expectedType: string): void {
  expect(entry.type).toBe(expectedType);
}

/**
 * Prüft, dass eine Entry die erwarteten Felder enthält
 */
export function assertEntryFields(entry: Entry, expectedFields: Record<string, any>): void {
  for (const [key, expectedValue] of Object.entries(expectedFields)) {
    expect(entry.fields).toHaveProperty(key);
    expect((entry.fields as any)[key]).toEqual(expectedValue);
  }
}

/**
 * Prüft, dass eine Collection von Entries die erwartete Anzahl hat
 */
export function assertEntryCount(
  entries: Entry[],
  expectedCount: number,
  message?: string
): void {
  expect(entries.length, message).toBe(expectedCount);
}

/**
 * Prüft, dass ein Feld in einer Entry einen bestimmten Typ hat
 */
export function assertFieldType(
  entry: Entry,
  fieldName: string,
  expectedType: "string" | "number" | "boolean" | "object" | "array"
): void {
  expect(typeof (entry.fields as any)[fieldName]).toBe(expectedType);
}

/**
 * Prüft, dass alle Entries einen eindeutigen ID-Wert haben
 */
export function assertUniqueIds(entries: Entry[], idField: string = "id"): void {
  const ids = entries.map(e => (e.fields as any)[idField]);
  const uniqueIds = new Set(ids);
  expect(ids.length).toBe(uniqueIds.size);
}

/**
 * Prüft, dass keine Duplikate in einem Array existieren
 */
export function assertNoDuplicates<T>(array: T[], getKey?: (item: T) => any): void {
  const keyFn = getKey || ((item: T) => item);
  const seen = new Set();
  for (const item of array) {
    const key = keyFn(item);
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
}

/**
 * Prüft, dass ein Space die erwartete Anzahl von Entries eines Typs enthält
 */
export async function assertSpaceCount(
  space: any,
  type: string,
  expectedCount: number,
  message?: string
): Promise<void> {
  const count = await space.count({ type });
  expect(count, message || `Expected ${expectedCount} entries of type ${type}, got ${count}`).toBe(expectedCount);
}

/**
 * Prüft, dass ein Space mindestens N Entries eines Typs enthält
 */
export async function assertSpaceCountAtLeast(
  space: any,
  type: string,
  minCount: number,
  message?: string
): Promise<void> {
  const count = await space.count({ type });
  expect(count, message || `Expected at least ${minCount} entries of type ${type}, got ${count}`).toBeGreaterThanOrEqual(minCount);
}

/**
 * Prüft, dass ein Space genau eine Entry eines Typs mit bestimmten Feldern enthält
 */
export async function assertSpaceHasEntry(
  space: any,
  template: any,
  message?: string
): Promise<Entry> {
  const entries = await space.readAll(template);
  expect(entries.length, message || `Expected exactly one entry matching ${JSON.stringify(template)}`).toBe(1);
  return entries[0];
}

/**
 * Prüft, dass ein Space keine Entries eines Typs enthält
 */
export async function assertSpaceEmpty(
  space: any,
  template: any,
  message?: string
): Promise<void> {
  const entries = await space.readAll(template);
  expect(entries.length, message || `Expected no entries matching ${JSON.stringify(template)}`).toBe(0);
}

/**
 * Prüft, dass eine Operation innerhalb eines Zeitlimits abgeschlossen wird
 */
export async function assertCompletesWithin(
  operation: () => Promise<any>,
  timeout: number,
  message?: string
): Promise<any> {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(message || `Operation did not complete within ${timeout}ms`));
    }, timeout);
  });
  
  return Promise.race([operation(), timeoutPromise]);
}

/**
 * Prüft, dass eine asynchrone Operation Ablehnt
 */
export async function assertRejects(
  operation: () => Promise<any>,
  errorType?: any,
  message?: string
): Promise<void> {
  try {
    await operation();
    throw new Error(message || "Expected operation to reject");
  } catch (error) {
    if (errorType && !(error instanceof errorType)) {
      throw new Error(
        message || `Expected error of type ${errorType.name}, got ${(error as Error).constructor.name}`
      );
    }
  }
}

/**
 * Prüft, dass ein String einem Muster entspricht
 */
export function assertMatchesPattern(
  str: string,
  pattern: RegExp | string,
  message?: string
): void {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  expect(str, message || `Expected '${str}' to match ${regex}`).toMatch(regex);
}

/**
 * Prüft, dass ein Objekt die erwartete Struktur hat
 */
export function assertObjectStructure(
  obj: any,
  expectedStructure: Record<string, string>,
  message?: string
): void {
  for (const [key, expectedType] of Object.entries(expectedStructure)) {
    expect(obj, message || `Expected ${key} to exist`).toHaveProperty(key);
    expect(typeof obj[key], message || `Expected ${key} to be of type ${expectedType}`).toBe(expectedType);
  }
}

/**
 * Prüft, dass zwei Objekte strukturell gleich sind (nicht referentiell)
 */
export function assertDeepEqual<T>(actual: T, expected: T, message?: string): void {
  expect(actual, message).toEqual(expected);
}

/**
 * Prüft, dass ein Array ein bestimmtes Element enthält
 */
export function assertContains<T>(array: T[], element: T, message?: string): void {
  expect(array, message || `Expected array to contain ${JSON.stringify(element)}`).toContainEqual(element);
}

/**
 * Prüft, dass ein Array alle Elemente eines anderen Arrays enthält
 */
export function assertContainsAll<T>(array: T[], elements: T[], message?: string): void {
  for (const element of elements) {
    expect(array, message || `Expected array to contain all elements`).toContainEqual(element);
  }
}

/**
 * Space-spezifische Assertions
 */
export const SpaceAssertions = {
  /**
   * Prüft, dass ein Take erfolgreich war
   */
  assertTakeSuccess(result: any): void {
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
  },
  
  /**
   * Prüft, dass ein Take null zurückgegeben hat (keine Entry gefunden)
   */
  assertTakeNull(result: any): void {
    expect(result).toBeNull();
  },
  
  /**
   * Prüft, dass ein Write erfolgreich war
   */
  async assertWriteSuccess(space: any, entry: Entry): Promise<void> {
    const entries = await space.readAll({ type: entry.type });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const found = entries.find((e: Taken) => 
      JSON.stringify(e.fields) === JSON.stringify(entry.fields)
    );
    expect(found).toBeDefined();
  },
  
  /**
   * Prüft, dass ein Template korrekt formattiert ist
   */
  assertValidTemplate(template: any): void {
    expect(template).toBeDefined();
    expect(typeof template).toBe("object");
    if (template.type) {
      expect(typeof template.type).toBe("string");
    }
    if (template.fields) {
      expect(typeof template.fields).toBe("object");
    }
  }
};

/**
 * Zeitbasierte Assertions
 */
export const TimeAssertions = {
  /**
   * Prüft, dass eine Dauer innerhalb eines Bereichs liegt
   */
  assertDurationInRange(duration: number, min: number, max: number, message?: string): void {
    expect(duration, message || `Expected duration between ${min} and ${max}ms, got ${duration}`)
      .toBeGreaterThanOrEqual(min);
    expect(duration, message).toBeLessThanOrEqual(max);
  },
  
  /**
   * Prüft, dass eine Dauer maximal einen Wert hat
   */
  assertMaxDuration(duration: number, max: number, message?: string): void {
    expect(duration, message || `Expected duration ≤ ${max}ms, got ${duration}`)
      .toBeLessThanOrEqual(max);
  },
  
  /**
   * Prüft, dass eine Dauer mindestens einen Wert hat
   */
  assertMinDuration(duration: number, min: number, message?: string): void {
    expect(duration, message || `Expected duration ≥ ${min}ms, got ${duration}`)
      .toBeGreaterThanOrEqual(min);
  }
};

/**
 * Statistik-Assertions
 */
export const StatsAssertions = {
  /**
   * Prüft, dass ein Durchschnittswert im erwarteten Bereich liegt
   */
  assertAverageInRange(values: number[], min: number, max: number, message?: string): void {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    expect(avg, message || `Expected average between ${min} and ${max}, got ${avg}`)
      .toBeGreaterThanOrEqual(min);
    expect(avg, message).toBeLessThanOrEqual(max);
  },
  
  /**
   * Prüft, dass ein Minimum-Wert korrekt ist
   */
  assertMinValue(values: number[], expectedMin: number, message?: string): void {
    const min = Math.min(...values);
    expect(min, message || `Expected min ${expectedMin}, got ${min}`).toBe(expectedMin);
  },
  
  /**
   * Prüft, dass ein Maximum-Wert korrekt ist
   */
  assertMaxValue(values: number[], expectedMax: number, message?: string): void {
    const max = Math.max(...values);
    expect(max, message || `Expected max ${expectedMax}, got ${max}`).toBe(expectedMax);
  },
  
  /**
   * Prüft, dass eine Standardabweichung im erwarteten Bereich liegt
   */
  assertStdDevInRange(values: number[], min: number, max: number, message?: string): void {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    expect(stdDev, message || `Expected stdDev between ${min} and ${max}, got ${stdDev}`)
      .toBeGreaterThanOrEqual(min);
    expect(stdDev, message).toBeLessThanOrEqual(max);
  }
};
