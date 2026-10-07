// A bounded segmented sieve, coordinated by one local durable space.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { core, FOREVER, PiSpaces, Space, canonicalJson, type SpaceHost } from "../src/index.ts";

export type SieveConfig = { runId: string; start: number; end: number; blockSize: number };
export type SieveTask = SieveConfig & { taskId: string; rangeStart: number; rangeEnd: number };
export type SieveResult = { runId: string; taskId: string; rangeStart: number; rangeEnd: number; primes: number[] };
const Runs = defineDoc<{ configs: SieveConfig[] }>({
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

/** Creation and every task are one commit; duplicate coordinators cannot seed a second copy. */
export async function prepareSieveRun(host: SpaceHost, config: SieveConfig): Promise<string[]> {
  validate(config);
  return host.commit(async tx => {
    const runs = await tx.doc(Runs);
    const prior = runs.configs.find(c => c.runId === config.runId);
    if (prior && canonicalJson(prior) !== canonicalJson(config)) throw new Error("Sieve run configuration changed");
    if (!prior && runs.configs.length >= 128) throw new Error("Example supports at most 128 runs per store");
    const taskIds: string[] = [];
    const space = await tx.doc(Space);
    for (let start = config.start, i = 0; start < config.end; start += config.blockSize, i++) {
      const taskId = `${config.runId}:${i}`;
      taskIds.push(taskId);
      if (!prior) core.write(space, Date.now(), {
        type: "SieveTask", fields: { ...config, taskId, rangeStart: start, rangeEnd: Math.min(start + config.blockSize, config.end) }
      }, null, FOREVER);
    }
    if (!prior) runs.configs.push({ ...config });
    return taskIds;
  }, ctx);
}

/** Each worker owns its reservation; results and consumed task are committed together. */
export async function processSieveTask(space: PiSpaces, runId: string, options: {
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

/** Look up every expected ID: never infer completeness from a truncated result list/count. */
export async function collectSieveResults(space: PiSpaces, config: SieveConfig): Promise<number[]> {
  validate(config);
  const primes: number[] = [];
  for (let start = config.start, i = 0; start < config.end; start += config.blockSize, i++) {
    const taskId = `${config.runId}:${i}`;
    const entries = await space.readAll({ type: "SieveResult", fields: { runId: config.runId, taskId } });
    if (entries.length !== 1) throw new Error(`Expected exactly one result for ${taskId}; got ${entries.length}`);
    const result = entries[0].fields as SieveResult;
    const end = Math.min(start + config.blockSize, config.end);
    if (result.rangeStart !== start || result.rangeEnd !== end) throw new Error(`Result range mismatch for ${taskId}`);
    if (!Array.isArray(result.primes) || result.primes.some((p, j) => !Number.isSafeInteger(p) || p < Math.max(2, start) || p >= end || (j > 0 && p <= result.primes[j - 1]))) {
      throw new Error(`Invalid result sequence for ${taskId}`);
    }
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
  const host = new PiSpaces(h, ctx);
  try {
    await prepareSieveRun(h, config);
    await Promise.all(Array.from({ length: workers }, (_, i) => (async () => {
      const worker = new PiSpaces(h, ctx, Date.now, undefined, i + 1);
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
