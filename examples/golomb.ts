// Golomb ruler search coordinated through the space. Spec: docs/examples/golomb.md.
//
//   Master ──write──► GolombSearchTask (a2 ranges, status "pending")
//   Worker ──take──► DFS with branch-and-bound (bound = GolombBestKnown)
//   Worker ──write──► GolombRuler (strictly improving rulers) + GolombTaskDone
//   Master ──write──► GolombSearchDone when every task is done (or the known
//                     optimum was found); workers/monitor/validator end on it
//   Validator ──readAll──► GolombRuler (final validity check)
//   Monitor ──readAll──► GolombSearchProgress / GolombSummary
//
// Entries are {type, fields}; there is no update — a taken "pending" task is
// reported via a separate GolombTaskDone entry.
//
// Run: node --experimental-strip-types examples/golomb.ts <order> [options]
//   <order>           - Number of marks (n), e.g. 8, 10. Runtime grows exponentially.
//   --workers <num>   - Number of worker agents (default: 4)
//   --max-length <l>  - Search rulers up to this length (default: known optimal or n*(n-1))
//   --checkpoint <file> - Enable checkpointing with file path
//   --dir <dir>       - State directory (default: /tmp/pi-spaces-golomb-<rand>); persistent,
//                       a restarted master skips tasks with a GolombTaskDone entry
//   --out <file>      - Output file for best ruler (default: <dir>/GOL_<n>.txt)

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { FOREVER, JavaSpace, startService, type Taken } from "../src/index.ts";
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
	taskId: string;
	order: number;
	maxLength: number;
	startPos: number; // a2 range [startPos, endPos)
	endPos: number;
	status: "pending"; // always pending: a task is removed by take(), never updated
};

export type GolombRulerFields = {
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

	private space: JavaSpace;
	private workerId: string;
	private order: number;
	private maxLength: number;
	private cpPath?: string;

	constructor(space: JavaSpace, workerId: string, order: number, maxLength: number, cpPath?: string) {
		this.space = space;
		this.workerId = workerId;
		this.order = order;
		this.maxLength = maxLength;
		this.cpPath = cpPath;
		this.bound = maxLength + 1;
	}

	/** Take tasks until none are pending or the search is done. */
	async loop(): Promise<void> {
		for (;;) {
			const t = await this.space.take({ type: "GolombSearchTask", fields: { status: "pending" } }, 2000);
			if (!t) {
				if (await this.done()) return;
				continue;
			}
			const task = field<GolombSearchTask>(t);
			try {
				await this.run(task);
			} finally {
				// Whatever happened, the task is gone (taken); mark it so the master can finish.
				if (await this.done()) return;
			}
		}
	}

	private async done(): Promise<boolean> {
		return (await this.space.count({ type: "GolombSearchDone", fields: { order: this.order } })) > 0;
	}

	private async refreshBound(): Promise<void> {
		// Bound = min over all GolombBestKnown entries (master writes one per improvement).
		let min = this.maxLength + 1;
		for (const e of await this.space.readAll({ type: "GolombBestKnown", fields: { order: this.order } }))
			min = Math.min(min, field<GolombBestKnown>(e).length);
		this.bound = min;
	}

	private resumeA2(taskId: string): number | null {
		if (!this.cpPath || !existsSync(this.cpPath)) return null;
		try {
			const cp = JSON.parse(readFileSync(this.cpPath, "utf8")) as { taskId?: string; order?: number; nextA2?: number };
			return cp.taskId === taskId && cp.order === this.order && typeof cp.nextA2 === "number" ? cp.nextA2 : null;
		} catch {
			return null;
		}
	}

	async run(task: GolombSearchTask): Promise<{ rulers: GolombRulerFields[]; checked: number }> {
		console.log(`[Worker-${this.workerId}] task ${task.taskId}: a2 ∈ [${task.startPos}, ${task.endPos})`);
		const started = Date.now();
		const rulers: GolombRulerFields[] = [];
		const resumeFrom = this.resumeA2(task.taskId);
		let lastProgress = 0;

		for (let a2 = task.startPos; a2 < task.endPos; a2++) {
			if (resumeFrom !== null && a2 < resumeFrom) continue;
			await this.refreshBound();
			if (await this.done()) break; // another worker already found the optimum

			const distances = new BitSet(task.maxLength + 1);
			distances.set(a2);
			this.dfs([0, a2], distances, rulers);

			if (this.cpPath && a2 - lastProgress >= 25) {
				lastProgress = a2;
				const progress: GolombSearchProgress = {
					taskId: task.taskId, order: this.order, nextA2: a2 + 1,
					checkedPositions: this.checked, lastUpdate: new Date().toISOString(), workerId: this.workerId
				};
				await this.space.write({ type: "GolombSearchProgress", fields: progress }, null, 30 * 60_000);
				try {
					writeFileSync(this.cpPath, JSON.stringify({ taskId: task.taskId, order: this.order, nextA2: a2 + 1 }, null, 2));
				} catch { /* checkpoint best-effort */ }
			}
		}

		for (const r of rulers) {
			r.taskId = task.taskId;
			await this.space.write({ type: "GolombRuler", fields: r }, null, FOREVER);
			console.log(`[Worker-${this.workerId}] ruler length=${r.length} [${r.positions.join(",")}]`);
		}
		const done: GolombTaskDone = { taskId: task.taskId, workerId: this.workerId, rulersFound: rulers.length, checkedPositions: this.checked };
		await this.space.write({ type: "GolombTaskDone", fields: done }, null, FOREVER);
		console.log(`[Worker-${this.workerId}] task ${task.taskId} done in ${Date.now() - started}ms: ${rulers.length} rulers, ${this.checked} nodes`);
		return { rulers, checked: this.checked };
	}

	/** Branch-and-bound DFS from [0, a2]. Collects rulers with length < bound. */
	private dfs(marks: number[], distances: BitSet, out: GolombRulerFields[]): void {
		this.checked++;
		const n = marks.length;
		const last = marks[n - 1];
		if (last >= this.bound) return; // cannot improve on the best known ruler
		if (n === this.order) {
			out.push({
				taskId: undefined, order: this.order, length: last, positions: [...marks],
				distances: GolombRuler.getDistances(marks), missingDistances: GolombRuler.getMissingDistances(marks),
				isOptimal: last === optimal(this.order), foundAt: new Date().toISOString(), workerId: this.workerId
			});
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
			this.dfs([...marks, p], next, out);
		}
	}
}

/** Master: partitions the a2 space into tasks, waits for completion, writes the summary. */
export class GolombMaster {
	private taskCount = 0;

	private space: JavaSpace;
	private order: number;
	private maxLength: number;
	private numTasks: number;

	constructor(space: JavaSpace, order: number, maxLength: number, numTasks: number) {
		this.space = space;
		this.order = order;
		this.maxLength = maxLength;
		this.numTasks = numTasks;
	}

	async run(): Promise<GolombRulerFields | null> {
		const known = optimal(this.order);
		console.log(`[Master] order=${this.order}, searching rulers with length ≤ ${this.maxLength}${known ? ` (known optimal ${known})` : ""}`);
		// The LUT is used only to *judge* results (isOptimal, early exit) — never as a bound,
		// otherwise the workers could not find the optimal ruler themselves.

		// Resume: tasks with a GolombTaskDone entry are skipped; pending duplicates are not re-created.
		const doneIds = new Set((await this.space.readAll({ type: "GolombTaskDone" })).map((e) => field<GolombTaskDone>(e).taskId));
		const pendingIds = new Set((await this.space.readAll({ type: "GolombSearchTask", fields: { status: "pending" } })).map((e) => field<GolombSearchTask>(e).taskId));

		// a2 ≤ maxLength/2 by mirror symmetry (first gap ≤ last gap).
		const lastA2 = Math.ceil(this.maxLength / 2);
		const chunk = Math.max(1, Math.ceil(lastA2 / this.numTasks));
		for (let i = 0, start = 1; start <= lastA2; i++, start += chunk) {
			const taskId = `golomb-${this.order}-task-${i}`;
			const endPos = Math.min(start + chunk, lastA2 + 1);
			this.taskCount++;
			if (doneIds.has(taskId) || pendingIds.has(taskId)) continue;
			const task: GolombSearchTask = { taskId, order: this.order, maxLength: this.maxLength, startPos: start, endPos, status: "pending" };
			await this.space.write({ type: "GolombSearchTask", fields: task }, null, FOREVER);
			console.log(`[Master] task ${taskId}: a2 ∈ [${start}, ${endPos})`);
		}
		console.log(`[Master] ${this.taskCount} tasks (${doneIds.size} already done)`);

		let lastBest: number | null = null;
		for (;;) {
			const doneCount = await this.space.count({ type: "GolombTaskDone" });
			const rulers = await this.space.readAll({ type: "GolombRuler", fields: { order: this.order } });
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
					fields: { order: this.order, length: bestLength, positions: best.positions, source: best.workerId, updatedAt: new Date().toISOString() } satisfies GolombBestKnown
				}, null, FOREVER);
			}
			await this.space.write({
				type: "GolombSummary",
				fields: {
					order: this.order, totalRulers: rulers.length, shortestLength: bestLength,
					bestPositions: best?.positions ?? KNOWN_OPTIMAL_RULERS[this.order],
					searchCompleted: doneCount >= this.taskCount, updatedAt: new Date().toISOString()
				} satisfies GolombSummary
			}, null, FOREVER);
			console.log(`[Master] ${doneCount}/${this.taskCount} tasks done, ${rulers.length} rulers, best=${bestLength}`);

			const finished = doneCount >= this.taskCount;
			const optimalFound = best !== null && known !== undefined && best.length <= known;
			if (finished || optimalFound) {
				await this.space.write({ type: "GolombSearchDone", fields: { order: this.order } }, null, FOREVER);
				return best;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

/** Validator: waits for the end of the search, then checks every ruler once. */
export class GolombValidator {
	private space: JavaSpace;
	private order: number;

	constructor(space: JavaSpace, order: number) {
		this.space = space;
		this.order = order;
	}

	async run(): Promise<void> {
		while (!(await this.space.count({ type: "GolombSearchDone", fields: { order: this.order } })))
			await new Promise((r) => setTimeout(r, 2000));
		const rulers = await this.space.readAll({ type: "GolombRuler", fields: { order: this.order } });
		const invalid = rulers.filter((e) => !GolombRuler.isValid(field<GolombRulerFields>(e).positions));
		await this.space.write({
			type: "GolombValidation",
			fields: { order: this.order, total: rulers.length, invalid: invalid.length, checkedAt: new Date().toISOString() } satisfies GolombValidation
		}, null, FOREVER);
		console.log(`[Validator] ${rulers.length} rulers checked, ${invalid.length} invalid`);
	}
}

/** Monitor: periodic progress line until the search ends. */
export class GolombMonitor {
	private space: JavaSpace;
	private order: number;

	constructor(space: JavaSpace, order: number) {
		this.space = space;
		this.order = order;
	}

	async run(intervalMs = 10_000): Promise<void> {
		for (;;) {
			const summary = (await this.space.readAll({ type: "GolombSummary", fields: { order: this.order } })).at(-1);
			const progress = await this.space.readAll({ type: "GolombSearchProgress", fields: { order: this.order } });
			const nodes = progress.reduce((s, e) => s + field<GolombSearchProgress>(e).checkedPositions, 0);
			if (summary)
				console.log(`[Monitor] best=${field<GolombSummary>(summary).shortestLength} rulers=${field<GolombSummary>(summary).totalRulers} nodes=${nodes}`);
			if (await this.space.count({ type: "GolombSearchDone", fields: { order: this.order } })) return;
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
	const host = new JavaSpace(h, ctx);
	const stopService = await startService(h, ctx);

	try {
		const master = new GolombMaster(host, order, bound, workers * 2);
		const validator = new GolombValidator(host, order);
		const monitor = new GolombMonitor(host, order);
		const workerRuns = Array.from({ length: workers }, (_, i) =>
			new GolombWorker(host, `worker-${i}`, order, bound, checkpoint).loop()
		);

		const [best] = await Promise.all([master.run(), validator.run(), monitor.run(), ...workerRuns]);

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
