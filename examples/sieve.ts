// A bounded segmented sieve, coordinated by one local durable space.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { createHash } from "node:crypto";
import { core, FOREVER, PhiSpaces, canonicalJson, type RunExporter, type SpaceHost, type SpaceLike, type WorkerKind, spaceDoc } from "../src/index.ts";

export type SieveConfig = { runId: string; start: number; end: number; blockSize: number };
export type SieveTask = SieveConfig & { taskId: string; rangeStart: number; rangeEnd: number };
export type SieveResult = { runId: string; taskId: string; rangeStart: number; rangeEnd: number; primes: number[] };
const Runs = defineDoc<{ configs: SieveConfig[]; seeds?: Record<string, { spaceId: string; next: number }> }>({
  kind: "pi-spaces.example-sieve-runs", version: 1, scope: "session", initial: () => ({ configs: [] })
});

function validate(config: SieveConfig): void {
  if (!config.runId || config.runId.length > 128 || !Number.isSafeInteger(config.start) ||
      !Number.isSafeInteger(config.end) || config.start < 0 || config.end <= config.start || config.end > 10_000_000 ||
      !Number.isSafeInteger(config.blockSize) || config.blockSize < 1 || config.blockSize > 4096 ||
      Math.ceil((config.end - config.start) / config.blockSize) > 1000) {
    throw new Error("Sieve needs a runId, 0 <= start < end <= 10000000, blockSize 1..4096 and at most 1000 blocks");
  }
}

/** Returns all primes in the half-open interval. Bounds keep allocations and result entries small. */
export function segmentedSieve(start: number, end: number): number[] {
  validate({ runId: "segment", start, end, blockSize: end - start });
  const upper = Math.floor(Math.sqrt(end - 1));
  const base = new Uint8Array(upper + 1);
  const composite = new Uint8Array(end - start);
  for (let p = 2; p <= upper; p++) {
    if (base[p]) continue;
    for (let multiple = p * p; multiple <= upper; multiple += p) base[multiple] = 1;
    for (let multiple = Math.max(p * p, Math.ceil(start / p) * p); multiple < end; multiple += p) {
      composite[multiple - start] = 1;
    }
  }
  const primes: number[] = [];
  for (let value = Math.max(2, start); value < end; value++) if (!composite[value - start]) primes.push(value);
  return primes;
}

export const SIEVE_COMPLETION_PROFILE = { taskType: "SieveTask", resultTypes: ["SieveResult"], equalFields: ["runId", "taskId", "rangeStart", "rangeEnd"], maxResultCount: 1 };
/** With a RunGate: tasks are takeable only while their run is running (docs/betrieb-und-mobile-steuerung.md §6). */
export const SIEVE_GATED_PROFILE = { ...SIEVE_COMPLETION_PROFILE, gateField: "runId", maxLeaseMs: 60_000 };

/** Configure a Space for gated sieve runs once, before workers open transactions. */
export async function configureGatedSieveSpace(host: SpaceHost, space?: string): Promise<void> {
  await host.commit(async tx => {
    const s = await spaceDoc(tx, space, Date.now());
    const prior = (s.completionProfiles ?? []).find(p => p.taskType === "SieveTask");
    if (prior && canonicalJson(prior as any) === canonicalJson(SIEVE_GATED_PROFILE as any)) return;
    if (prior) throw new Error("Space already has an ungated SieveTask profile");
    core.setCompletionProfiles(s, [...(s.completionProfiles ?? []), SIEVE_GATED_PROFILE]);
  }, ctx);
}

/** Creation is resumable: each seed and its durable cursor commit together, within the space's byte budget. */
export async function prepareSieveRun(host: SpaceHost, config: SieveConfig, options: { space?: string; gate?: { commandId: string; revision: number } } = {}): Promise<string[]> {
  validate(config);
  const count = Math.ceil((config.end - config.start) / config.blockSize);
  const seedKey = canonicalJson([config.runId]);
  for (;;) {
    const done = await host.commit(async tx => {
      const runs = await tx.doc(Runs);
      const space = await spaceDoc(tx, options.space, Date.now());
      const prior = runs.configs.find(c => c.runId === config.runId);
      if (prior && canonicalJson(prior) !== canonicalJson(config)) throw new Error("Sieve run configuration changed");
      if (!prior && runs.configs.length >= 128) throw new Error("Example supports at most 128 runs per store");
      const profile = (space.completionProfiles ?? []).find(p => p.taskType === "SieveTask");
      if (options.gate) {
        if (profile?.gateField !== "runId") throw new Error("gated sieve runs need configureGatedSieveSpace first");
        core.applyRunGate(space, Date.now(), { runId: config.runId, kind: "prepare", ...options.gate }); // idempotent; written with the first seed
      } else if (!profile) core.setCompletionProfiles(space, [...(space.completionProfiles ?? []), SIEVE_COMPLETION_PROFILE]);
      runs.seeds ??= {};
      if (!runs.seeds[seedKey]) runs.seeds[seedKey] = { spaceId: space.spaceId!, next: prior ? count : 0 };
      const seed = runs.seeds[seedKey]!;
      if (seed.spaceId !== space.spaceId) throw new Error("Sieve run belongs to another space");
      if (!prior) runs.configs.push({ ...config });
      if (seed.next < count) {
        const i = seed.next, start = config.start + i * config.blockSize;
        core.write(space, Date.now(), { type: "SieveTask", fields: { ...config, taskId: `${config.runId}:${i}`, rangeStart: start, rangeEnd: Math.min(start + config.blockSize, config.end) } }, null, FOREVER);
        seed.next++;
      }
      return seed.next === count;
    }, ctx);
    if (done) return Array.from({ length: count }, (_, i) => `${config.runId}:${i}`);
  }
}

/** Each worker owns its reservation; results and consumed task are committed together. */
export async function processSieveTask(space: SpaceLike, runId: string, options: {
  leaseMs?: number; crashAfterTake?: boolean; beforeCommit?: () => Promise<void>
} = {}): Promise<boolean> {
  const txn = await space.createTransaction(options.leaseMs ?? 30_000);
  try {
    const entry = await space.take({ type: "SieveTask", fields: { runId } }, 0, { txn: txn.id });
    if (!entry) { await space.abort(txn.id); return false; }
    if (options.crashAfterTake) return false; // leave the reservation for expiry/reopen tests
    const task = entry.fields as SieveTask;
    const result: SieveResult = { runId, taskId: task.taskId, rangeStart: task.rangeStart, rangeEnd: task.rangeEnd,
      primes: segmentedSieve(task.rangeStart, task.rangeEnd) };
    await space.write({ type: "SieveResult", fields: result }, txn.id, FOREVER);
    await options.beforeCommit?.();
    await space.commit(txn.id);
    return true;
  } catch (error) {
    await space.abort(txn.id).catch(() => {});
    throw error;
  }
}

export function normalizeSieveRunConfig(runId: string, rawConfig?: Record<string, unknown>): SieveConfig {
  const cfg = rawConfig ?? {};
  return {
    runId,
    start: Number(cfg.start ?? 1),
    end: Number(cfg.end ?? 1001),
    blockSize: Number(cfg.blockSize ?? 128),
  };
}

/** Result export for `RunController` (kind "sieve"): completeness per expected task, hash over all results in order. */
export const SIEVE_EXPORTER: RunExporter = async (run, space) => {
  const config = normalizeSieveRunConfig(run.runId, run.config as Record<string, unknown> | undefined);
  validate(config);
  const hash = createHash("sha256"), missing: string[] = [];
  let found = 0, primes = 0, first: number | null = null, last: number | null = null;
  for (let start = config.start, i = 0; start < config.end; start += config.blockSize, i++) {
    const taskId = `${config.runId}:${i}`;
    let result: SieveResult | undefined;
    for (const member of run.members) {
      const entries = await space(member).readAll({ type: "SieveResult", fields: { runId: config.runId, taskId } });
      if (entries.length > 1) throw new Error(`Duplicate member result for ${taskId}`);
      if (!entries.length) continue;
      const candidate = entries[0]!.fields as SieveResult;
      validateSieveResult(candidate, config, i);
      if (result && canonicalJson(result as unknown as core.Json) !== canonicalJson(candidate as unknown as core.Json)) throw new Error(`Conflicting member results for ${taskId}`);
      result = candidate;
    }
    if (!result) { missing.push(taskId); continue; }
    found++; primes += result.primes.length; hash.update(canonicalJson(result as unknown as core.Json));
    if (result.primes.length) { first ??= result.primes[0]!; last = result.primes[result.primes.length - 1]!; }
  }
  const expected = Math.ceil((config.end - config.start) / config.blockSize);
  return { complete: missing.length === 0, expected, found, missing, resultHash: hash.digest("hex"), summary: { primes, first, last, range: [config.start, config.end] } };
};

/** Registered worker kind for `WorkerSupervisor`: one sieve task per step, bound to the assignment's run. */
export const SIEVE_WORKER_KIND: WorkerKind = { requiresRun: true, step: ({ space, runId }) => processSieveTask(space, runId!) };

export function validateSieveResult(result: SieveResult, config: SieveConfig, index: number): void {
  const start = config.start + index * config.blockSize, end = Math.min(start + config.blockSize, config.end);
  const taskId = `${config.runId}:${index}`;
  if (result.runId !== config.runId || result.taskId !== taskId || result.rangeStart !== start || result.rangeEnd !== end) throw new Error(`Result range mismatch or identity mismatch for ${taskId}`);
  if (!Array.isArray(result.primes) || result.primes.some((p, j) => !Number.isSafeInteger(p) || p < Math.max(2, start) || p >= end || (j > 0 && p <= result.primes[j - 1]!))) throw new Error(`Invalid result sequence for ${taskId}`);
}

/** Look up every expected ID: never infer completeness from a truncated result list/count. */
export async function collectSieveResults(space: SpaceLike, config: SieveConfig): Promise<number[]> {
  validate(config);
  const primes: number[] = [];
  for (let start = config.start, i = 0; start < config.end; start += config.blockSize, i++) {
    const taskId = `${config.runId}:${i}`;
    const entries = await space.readAll({ type: "SieveResult", fields: { runId: config.runId, taskId } });
    if (entries.length !== 1) throw new Error(`Expected exactly one result for ${taskId}; got ${entries.length}`);
    const result = entries[0].fields as SieveResult;
    validateSieveResult(result, config, i);
    primes.push(...result.primes);
  }
  return primes;
}

export async function runSieve(options: { start?: number; end?: number; blockSize?: number; workers?: number } = {}) {
  const config = { runId: randomUUID(), start: options.start ?? 1, end: options.end ?? 1001, blockSize: options.blockSize ?? 128 };
  validate(config);
  const workers = options.workers ?? 4;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) throw new Error("workers must be 1..32");
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
  const host = new PhiSpaces(h, ctx);
  try {
    await prepareSieveRun(h, config);
    await Promise.all(Array.from({ length: workers }, (_, i) => (async () => {
      const worker = new PhiSpaces(h, ctx, Date.now, undefined, i + 1);
      while (await processSieveTask(worker, config.runId)) { /* next task */ }
    })()));
    const primes = await collectSieveResults(host, config);
    return { config, primes };
  } finally { await h.close(ctx); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const result = await runSieve({ end: args[0] === undefined ? 1001 : Number(args[0]), workers: args[1] === undefined ? 4 : Number(args[1]) });
  console.log(`${result.primes.length} primes in [${result.config.start}, ${result.config.end})`);
  console.log(result.primes.join(" "));
}
