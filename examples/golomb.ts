// Golomb ruler search coordinated through the space. Spec: docs/examples/golomb.md.
//
//   Master ──write──► GolombSearchTask (a2 ranges, status "pending")
//   Worker ──take──► DFS with branch-and-bound (bound = GolombBestKnown)
//   Worker ──write──► GolombRuler (strictly improving rulers) + GolombTaskDone
//   Master ──write──► GolombSearchDone when every task is done (or the known
//                     optimum was found); workers/monitor/validator end on it
//   Validator ──readAll──► GolombRuler (final validity check)
//   Monitor ──readAll──► completed task counters / GolombSummary
//
// Entries are {type, fields}; there is no update — a taken "pending" task is
// reported via a separate GolombTaskDone entry.
//
// Run: node --experimental-strip-types examples/golomb.ts <order> [options]
//   <order>           - Number of marks (n), e.g. 8, 10. Runtime grows exponentially.
//   --workers <num>   - Number of worker agents (default: 4)
//   --max-length <l>  - Search rulers up to this length (default: known optimal or n*(n-1))
//   --checkpoint <prefix> - Write per-task completion receipts; incomplete DFS work is rerun
//   --dir <dir>       - State directory (default: /tmp/pi-spaces-golomb-<rand>); persistent,
//                       a restarted master skips tasks with a GolombTaskDone entry
//   --out <file>      - Output file for best ruler (default: <dir>/GOL_<n>.txt)

import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { FOREVER, PiSpaces, Space, startService, type Taken } from "../src/index.ts";
import { createModels } from "@earendil-works/pi-ai/models";

// Known optimal lengths for Golomb rulers (canonical table, OEIS A003022)
export const KNOWN_OPTIMAL_LENGTHS: Record<number, number> = {
	2: 1, 3: 3, 4: 6, 5: 11, 6: 17, 7: 25, 8: 34,
	9: 44, 10: 55, 11: 72, 12: 85, 13: 106, 14: 127,
	15: 151, 16: 177, 17: 199, 18: 216, 19: 246, 20: 283,
	21: 333, 22: 356, 23: 372, 24: 425, 25: 480, 26: 492
};

// Verified optimal rulers for small orders (all distances pairwise distinct, length = table value)
export const KNOWN_OPTIMAL_RULERS: Record<number, number[]> = {
	2: [0, 1],
	3: [0, 1, 3],
	4: [0, 1, 4, 6],
	5: [0, 1, 4, 9, 11],
	6: [0, 1, 4, 10, 12, 17],
	7: [0, 1, 4, 10, 18, 23, 25],
	8: [0, 1, 4, 9, 15, 22, 32, 34],
	9: [0, 1, 5, 12, 25, 27, 35, 41, 44],
	10: [0, 1, 6, 10, 23, 26, 34, 41, 53, 55]
};

/** Bitset over distances. Sized to the bound; a Golomb ruler never needs an index beyond its length. */
export class BitSet {
	private data: Uint8Array;
	private size: number;

	constructor(size: number) {
		this.size = size;
		this.data = new Uint8Array(Math.ceil(size / 8));
	}

	set(bit: number): void {
		if (bit >= this.size) this.expand(bit + 1);
		this.data[bit >> 3] |= 1 << (bit & 7);
	}

	private expand(size: number): void {
		const d = new Uint8Array(Math.ceil(size / 8));
		d.set(this.data);
		this.data = d;
		this.size = size;
	}

	get(bit: number): boolean {
		return bit < this.size && (this.data[bit >> 3] & (1 << (bit & 7))) !== 0;
	}

	toArray(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.size; i++) if (this.get(i)) out.push(i);
		return out;
	}

	static fromArray(bits: number[], size?: number): BitSet {
		const b = new BitSet(size ?? Math.max(...bits, 0) + 1);
		for (const bit of bits) b.set(bit);
		return b;
	}

	clone(): BitSet {
		const c = new BitSet(this.size);
		c.data.set(this.data);
		return c;
	}
}

export class GolombRuler {
	/** Strictly increasing, non-negative marks; every pairwise distance at most once. */
	static isValid(positions: number[]): boolean {
		if ((positions.length && positions[0] !== 0) || positions.some(p => !Number.isSafeInteger(p))) return false;
		const seen = new Set<number>();
		for (let i = 0; i < positions.length; i++) {
			if (positions[i] < 0 || (i > 0 && positions[i] <= positions[i - 1])) return false;
			for (let j = i + 1; j < positions.length; j++) {
				const d = positions[j] - positions[i];
				if (seen.has(d)) return false;
				seen.add(d);
			}
		}
		return true;
	}

	static length(positions: number[]): number {
		return positions.length === 0 ? 0 : positions[positions.length - 1];
	}

	static getDistances(positions: number[]): number[] {
		const distances: number[] = [];
		for (let i = 0; i < positions.length; i++)
			for (let j = i + 1; j < positions.length; j++) distances.push(positions[j] - positions[i]);
		return distances.sort((a, b) => a - b);
	}

	/** Distances in [1, maxLength] (default: ruler length) that the ruler does not measure. */
	static getMissingDistances(positions: number[], maxLength?: number): number[] {
		const have = new Set(this.getDistances(positions));
		const upTo = maxLength ?? this.length(positions);
		const missing: number[] = [];
		for (let d = 1; d <= upTo; d++) if (!have.has(d)) missing.push(d);
		return missing;
	}
}

// Space entry field schemas (see docs/examples/golomb.md §4)
export type GolombSearchTask = {
	runId?: string;
	taskId: string;
	order: number;
	maxLength: number;
	startPos: number; // a2 range [startPos, endPos)
	endPos: number;
	status: "pending"; // always pending: a task is removed by take(), never updated
};

export type GolombRulerFields = {
	runId?: string;
	taskId?: string;
	order: number;
	length: number;
	positions: number[];
	distances: number[];
	missingDistances: number[];
	isOptimal: boolean; // length equals the known optimal length for this order
	foundAt: string; // ISO timestamp
	workerId: string;
};

export type GolombBestKnown = {
	order: number;
	length: number;
	positions: number[];
	source: string; // "LUT" or worker id
	updatedAt: string;
};

type GolombSearchProgress = {
	taskId: string;
	order: number;
	nextA2: number;
	checkedPositions: number;
	lastUpdate: string;
	workerId: string;
};

type GolombTaskDone = {
	runId?: string;
	taskId: string;
	workerId: string;
	rulersFound: number;
	checkedPositions: number;
};

type GolombSearchDone = { order: number };

type GolombSummary = {
	order: number;
	totalRulers: number;
	shortestLength: number;
	bestPositions?: number[];
	searchCompleted: boolean;
	updatedAt: string;
};

type GolombValidation = {
	order: number;
	total: number;
	invalid: number;
	checkedAt: string;
};

const field = <T>(e: Taken) => e.fields as T;
const optimal = (order: number) => KNOWN_OPTIMAL_LENGTHS[order];

/** Worker agent: takes pending tasks, runs bounded DFS, reports via GolombTaskDone. */
export class GolombWorker {
	private bound: number; // only rulers strictly shorter than this are interesting
	private checked = 0;

	private space: PiSpaces;
	private workerId: string;
	private order: number;
	private maxLength: number;
	private cpPath?: string;
	private runId: string;
	private txn?: string;
	private renewedAt = 0;

	constructor(space: PiSpaces, workerId: string, order: number, maxLength: number, cpPath?: string, runId = `golomb-${order}-${maxLength}`) {
		this.space = space;
		this.workerId = workerId;
		this.order = order;
		this.maxLength = maxLength;
		this.cpPath = cpPath;
		this.bound = maxLength + 1;
		this.runId = runId;
	}

	/** Take tasks until none are pending or the search is done. */
	async loop(): Promise<void> {
		for (;;) {
			if (await this.done()) return;
			const txn = await this.space.createTransaction(120_000);
			const t = await this.space.take({ type: "GolombSearchTask", fields: { status: "pending", runId: this.runId, order: this.order } }, 2000, { txn: txn.id });
			if (!t) {
				await this.space.abort(txn.id);
				if (await this.done()) return;
				continue;
			}
			const task = field<GolombSearchTask>(t);
			try {
				this.txn = txn.id;
				this.renewedAt = Date.now();
				await this.run(task, txn.id);
				await this.space.commit(txn.id);
				// Checkpoints are completion receipts only. Partial DFS work is rerun after failure.
				if (this.cpPath) {
					const path = `${this.cpPath}.${encodeURIComponent(this.runId)}.${encodeURIComponent(task.taskId)}.json`;
					writeFileSync(`${path}.tmp`, JSON.stringify({ runId: this.runId, taskId: task.taskId, completed: true }));
					renameSync(`${path}.tmp`, path);
				}
			} catch (error) {
				await this.space.abort(txn.id).catch(() => {});
				throw error;
			} finally {
				this.txn = undefined;
			}
		}
	}

	private async done(): Promise<boolean> {
		return (await this.space.count({ type: "GolombSearchDone", fields: { runId: this.runId } })) > 0;
	}

	private async refreshBound(): Promise<void> {
		// Bound = min over all GolombBestKnown entries (master writes one per improvement).
		let min = this.maxLength + 1;
		for (const e of await this.space.readAll({ type: "GolombBestKnown", fields: { runId: this.runId } }))
			min = Math.min(min, field<GolombBestKnown>(e).length);
		this.bound = Math.min(this.bound, min);
	}

	async run(task: GolombSearchTask, txn: string | null = null): Promise<{ rulers: GolombRulerFields[]; checked: number }> {
		if (task.order !== this.order || task.maxLength !== this.maxLength || (task.runId && task.runId !== this.runId)) throw new Error("Task does not match worker configuration");
		this.checked = 0;
		this.bound = this.maxLength + 1;
		console.log(`[Worker-${this.workerId}] task ${task.taskId}: a2 ∈ [${task.startPos}, ${task.endPos})`);
		const started = Date.now();
		const rulers: GolombRulerFields[] = [];

		for (let a2 = task.startPos; a2 < task.endPos; a2++) {
			await this.refreshBound();
			if (await this.done()) break; // another worker already found the optimum

			const distances = new BitSet(task.maxLength + 1);
			distances.set(a2);
			await this.dfs([0, a2], distances, rulers);
		}

		for (const r of rulers) {
			r.taskId = task.taskId;
			r.runId = this.runId;
			await this.space.write({ type: "GolombRuler", fields: r }, txn, FOREVER);
			console.log(`[Worker-${this.workerId}] ruler length=${r.length} [${r.positions.join(",")}]`);
		}
		const done: GolombTaskDone = { runId: this.runId, taskId: task.taskId, workerId: this.workerId, rulersFound: rulers.length, checkedPositions: this.checked };
		await this.space.write({ type: "GolombTaskDone", fields: done }, txn, FOREVER);
		console.log(`[Worker-${this.workerId}] task ${task.taskId} done in ${Date.now() - started}ms: ${rulers.length} rulers, ${this.checked} nodes`);
		return { rulers, checked: this.checked };
	}

	/** Branch-and-bound DFS from [0, a2]. Collects rulers with length < bound. */
	private async dfs(marks: number[], distances: BitSet, out: GolombRulerFields[]): Promise<void> {
		this.checked++;
		if (this.checked % 2048 === 0) {
			await yieldTurn();
			if (this.txn && Date.now() - this.renewedAt > 10_000) {
				await this.space.renew(this.txn, 120_000);
				this.renewedAt = Date.now();
			}
		}
		const n = marks.length;
		const last = marks[n - 1];
		if (last >= this.bound) return; // cannot improve on the best known ruler
		if (n === this.order) {
			out.push({
				taskId: undefined, order: this.order, length: last, positions: [...marks],
				distances: GolombRuler.getDistances(marks), missingDistances: GolombRuler.getMissingDistances(marks),
				isOptimal: last === optimal(this.order), foundAt: new Date().toISOString(), workerId: this.workerId
			});
			this.bound = last; // retain strictly improving candidates only
			return;
		}
		const isLastMark = n === this.order - 1;
		const a2 = marks[1];
		for (let p = last + 1; p < this.bound; p++) {
			// Mirror symmetry: first gap a2 must not exceed the last gap p - last.
			if (isLastMark && p - last < a2) continue;
			let ok = true;
			for (const m of marks) if (distances.get(p - m)) { ok = false; break; }
			if (!ok) continue;
			const next = distances.clone();
			for (const m of marks) next.set(p - m);
			await this.dfs([...marks, p], next, out);
		}
	}
}

/** Master: partitions the a2 space into tasks, waits for completion, writes the summary. */
export class GolombMaster {
	private taskCount = 0;

	private space: PiSpaces;
	private order: number;
	private maxLength: number;
	private numTasks: number;
	private runId: string;

	constructor(space: PiSpaces, order: number, maxLength: number, numTasks: number, runId = `golomb-${order}-${maxLength}`) {
		this.space = space;
		this.order = order;
		this.maxLength = maxLength;
		this.numTasks = numTasks;
		this.runId = runId;
	}

	async run(): Promise<GolombRulerFields | null> {
		this.taskCount = 0;
		const config = { runId: this.runId, order: this.order, maxLength: this.maxLength, numTasks: this.numTasks };
		const prior = await this.space.read({ type: "GolombRun", fields: { runId: this.runId } }, 0);
		if (prior && Object.entries(config).some(([key, value]) => prior.fields[key] !== value)) throw new Error("Run configuration changed; use a new runId or state directory");
		if (!prior) await this.space.write({ type: "GolombRun", fields: config }, null, FOREVER);
		const known = optimal(this.order);
		console.log(`[Master] order=${this.order}, searching rulers with length ≤ ${this.maxLength}${known ? ` (known optimal ${known})` : ""}`);
		// The CLI uses the LUT length as an inclusive target, never its reference positions.

		// Resume: tasks with a GolombTaskDone entry are skipped; pending duplicates are not re-created.
		const doneIds = new Set((await this.space.readAll({ type: "GolombTaskDone", fields: { runId: this.runId } })).map((e) => field<GolombTaskDone>(e).taskId));
		const pendingIds = new Set((await this.space.readAll({ type: "GolombSearchTask", fields: { runId: this.runId } })).map((e) => field<GolombSearchTask>(e).taskId));

		// a2 ≤ maxLength/2 by mirror symmetry (first gap ≤ last gap).
		const lastA2 = Math.ceil(this.maxLength / 2);
		const chunk = Math.max(1, Math.ceil(lastA2 / this.numTasks));
		for (let i = 0, start = 1; start <= lastA2; i++, start += chunk) {
			const taskId = `golomb-${this.order}-task-${i}`;
			const endPos = Math.min(start + chunk, lastA2 + 1);
			this.taskCount++;
			if (doneIds.has(taskId) || pendingIds.has(taskId)) continue;
			const task: GolombSearchTask = { runId: this.runId, taskId, order: this.order, maxLength: this.maxLength, startPos: start, endPos, status: "pending" };
			await this.space.write({ type: "GolombSearchTask", fields: task }, null, FOREVER);
			console.log(`[Master] task ${taskId}: a2 ∈ [${start}, ${endPos})`);
		}
		console.log(`[Master] ${this.taskCount} tasks (${doneIds.size} already done)`);

		let lastBest: number | null = null;
		for (;;) {
			const doneCount = await this.space.count({ type: "GolombTaskDone", fields: { runId: this.runId } });
			const rulers = await this.space.readAll({ type: "GolombRuler", fields: { runId: this.runId } });
			let best: GolombRulerFields | null = null;
			for (const e of rulers) {
				const r = field<GolombRulerFields>(e);
				if (!best || r.length < best.length) best = r;
			}
			const bestLength = best?.length ?? this.maxLength;
			if (best && bestLength !== lastBest) {
				lastBest = bestLength;
				await this.space.write({
					type: "GolombBestKnown",
					fields: { runId: this.runId, order: this.order, length: bestLength, positions: best.positions, source: best.workerId, updatedAt: new Date().toISOString() }
				}, null, FOREVER);
			}
			const oldSummaries = await this.space.readAll({ type: "GolombSummary", fields: { runId: this.runId } });
			for (const e of oldSummaries) await this.space.take({ id: e.id }, 0);
			await this.space.write({
				type: "GolombSummary",
				fields: {
					order: this.order, runId: this.runId, totalRulers: rulers.length, shortestLength: bestLength,
					bestPositions: best?.positions ?? null,
					searchCompleted: doneCount >= this.taskCount, updatedAt: new Date().toISOString()
					}
			}, null, FOREVER);
			console.log(`[Master] ${doneCount}/${this.taskCount} tasks done, ${rulers.length} rulers, best=${bestLength}`);

			const finished = doneCount >= this.taskCount;
			const optimalFound = best !== null && known !== undefined && best.length <= known;
			if (finished || optimalFound) {
				if (!(await this.space.count({ type: "GolombSearchDone", fields: { runId: this.runId } }))) await this.space.write({ type: "GolombSearchDone", fields: { runId: this.runId, order: this.order } }, null, FOREVER);
				return best;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

/** Validator: waits for the end of the search, then checks every ruler once. */
export class GolombValidator {
	private space: PiSpaces;
	private order: number;
	private runId?: string;

	constructor(space: PiSpaces, order: number, runId?: string) {
		this.space = space;
		this.order = order;
		this.runId = runId;
	}

	async run(): Promise<void> {
		while (!(await this.space.count({ type: "GolombSearchDone", fields: this.runId ? { runId: this.runId } : { order: this.order } })))
			await new Promise((r) => setTimeout(r, 2000));
		const rulers = await this.space.readAll({ type: "GolombRuler", fields: this.runId ? { runId: this.runId } : { order: this.order } });
		const invalid = rulers.filter((e) => { const r = field<GolombRulerFields>(e); return r.positions.length !== this.order || r.length !== GolombRuler.length(r.positions) || !GolombRuler.isValid(r.positions); });
		await this.space.write({
			type: "GolombValidation",
			fields: { order: this.order, total: rulers.length, invalid: invalid.length, checkedAt: new Date().toISOString() } satisfies GolombValidation
		}, null, FOREVER);
		console.log(`[Validator] ${rulers.length} rulers checked, ${invalid.length} invalid`);
		if (invalid.length) throw new Error("Invalid search results");
	}
}

/** Monitor: periodic progress line until the search ends. */
export class GolombMonitor {
	private space: PiSpaces;
	private order: number;
	private runId?: string;

	constructor(space: PiSpaces, order: number, runId?: string) {
		this.space = space;
		this.order = order;
		this.runId = runId;
	}

	async run(intervalMs = 10_000): Promise<void> {
		for (;;) {
			const fields: Record<string, string | number> = this.runId ? { runId: this.runId } : { order: this.order };
			const summary = (await this.space.readAll({ type: "GolombSummary", fields })).at(-1);
			const completed = await this.space.readAll({ type: "GolombTaskDone", fields });
			const nodes = completed.reduce((s, e) => s + field<GolombTaskDone>(e).checkedPositions, 0);
			if (summary)
				console.log(`[Monitor] best=${field<GolombSummary>(summary).shortestLength} rulers=${field<GolombSummary>(summary).totalRulers} completedNodes=${nodes}`);
			if (await this.space.count({ type: "GolombSearchDone", fields })) return;
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}
}

function parseArgs() {
	const a = process.argv.slice(2);
	const val = (name: string) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };
	const order = parseInt(a.find((x, i) => !x.startsWith("--") && !a[i - 1]?.startsWith("--")) ?? "8");
	return {
		order,
		workers: parseInt(val("--workers") ?? "4"),
		maxLength: val("--max-length") !== undefined ? parseInt(val("--max-length")!) : undefined,
		checkpoint: val("--checkpoint"),
		dir: val("--dir") ?? mkdtempSync(join(tmpdir(), "pi-spaces-golomb-")),
		out: val("--out")
	};
}

async function main() {
		const { order, workers, maxLength, checkpoint, dir, out } = parseArgs();
		if (!Number.isSafeInteger(workers) || workers < 1 || workers > 64 || (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1))) throw new Error("workers must be 1..64 and max-length a positive integer");
	if (!Number.isInteger(order) || order < 2 || order > 25) {
		console.error("order must be an integer between 2 and 25");
		process.exit(1);
	}
	const bound = maxLength ?? KNOWN_OPTIMAL_LENGTHS[order] ?? order * (order - 1);
	const outFile = out ?? join(dir, `GOL_${order}.txt`);
	console.log(`Golomb ruler search: order=${order}, workers=${workers}, length ≤ ${bound}\nstate ${dir}`);

	const registry = createRegistry();
	const h = await Harness.open(await openNodeJsonlStorage(dir, ctx), { models: createModels(), registry }, ctx);
	h.resume();
		const host = new PiSpaces(h, ctx);
		// This CLI is the sole process permitted to own this store. Recover abandoned reservations
		// before the master enumerates pending tasks; otherwise locked tasks could be recreated.
		const state = await h.snapshot(Space, ctx);
		for (const txn of Object.values(state?.txns ?? {})) await host.abort(txn.id).catch(() => {});
	const stopService = await startService(h, ctx);

	try {
		const master = new GolombMaster(host, order, bound, workers * 2);
			const validator = new GolombValidator(host, order, `golomb-${order}-${bound}`);
			const monitor = new GolombMonitor(host, order, `golomb-${order}-${bound}`);
		const workerRuns = Array.from({ length: workers }, (_, i) =>
			new GolombWorker(host, `worker-${i}`, order, bound, checkpoint).loop()
		);

			const [best] = await Promise.all([master.run(), monitor.run(), ...workerRuns]);
			await validator.run();

		if (best) {
			const text = [
				`order=${order}`, `length=${best.length}`, `positions=${best.positions.join(" ")}`,
				`distances=${best.distances.join(" ")}`, `missing=${best.missingDistances.join(" ")}`,
				`isOptimal=${best.isOptimal}`, `worker=${best.workerId}`
			].join("\n") + "\n";
			writeFileSync(outFile, text);
			console.log(`\nBest ruler written to ${outFile}:\n${text}`);
		} else {
			console.log(`\nNo ruler with length ≤ ${bound} found.`);
			if (KNOWN_OPTIMAL_RULERS[order]) console.log(`Known optimal: ${KNOWN_OPTIMAL_LENGTHS[order]} → [${KNOWN_OPTIMAL_RULERS[order].join(" ")}]`);
		}
		console.log("space:", JSON.stringify(await host.stats()));
	} finally {
		await stopService();
		await h.close(ctx);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
