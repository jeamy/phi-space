// The memory of a planning task (docs/codemode-planung.en.md, step 3): the paths of earlier bots that reached a shown
// episode's goal, frozen at the start of each generation, offered to a bot through `recall` and measured as coverage.
//
//   PlanMemory   one remembered path: { session, blockId, memoryId, candidateId, author, gen, episode, goal, path, ts }
//                (judge-host.ts writes it with the verdict; only sample episodes reached with every seed, never a
//                hidden one; the same path once per block)
//   MemoryFreeze { session, blockId, freezeId, memoryIds, ts }: the paths a generation's bots may recall. The run writes
//                one when a generation begins (run.ts), a contribution handed in by hand gets one of its own
//                (room.ts enqueueCandidate); the candidate carries its `freeze`, and the judge answers from it only.
//
// `recall` searches the frozen paths as a graph: along a path from step to step, and from one path to another where
// they pass within NEAR cells of each other in the same room, each such jump costing JUMP_CELLS cells of detour (the
// post's memory graph with a jump cost). It starts at the remembered cell nearest to the figure (in its room) and takes
// the cheapest way from there to the end of a path, where the goal held.
import { createHash } from "node:crypto";
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import type { PathStep } from "./bottask.ts";
import type { ChanceSeen, TideSeen } from "./toyisland.ts";

/** One path of the memory, as the judge gets it from the freeze. */
export type MemoryPath = { memoryId: string; gen: number; author: string; episode: string; goal: string; path: PathStep[]; /** an observation (goal "tide"): what the judge logged of a landing (step 7) or of a day of the chance tide (step 8) */ obs?: TideSeen | ChanceSeen };
export type Cell = { room: string; x: number; y: number };
/** What `recall` answers: the steps to walk (the first is the remembered cell to go to), how far that cell is, how many
 *  jumps between paths the way takes, and where they are. */
export type Recall =
	| { found: true; from: PathStep; distance: number; jumps: number; cost: number; steps: PathStep[]; links: Array<[PathStep, PathStep]> }
	| { found: false; reason: string };

/** "Near": in the same room, at most this many cells apart (Manhattan). */
export const NEAR = 3;
/** What a jump from one remembered path to another costs, in cells. */
export const JUMP_CELLS = 10;
/** The most paths a block remembers, and the most a freeze names. */
export const MAX_MEMORY = 300;

/** The same path gets the same id in a block, so a bot that walks it again adds nothing. */
export const memoryIdOf = (goal: string, path: PathStep[]): string => createHash("sha256").update(JSON.stringify([goal, path])).digest("hex").slice(0, 20);

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** The cheapest way from `from` through the memory to a place where `goal` held; the memory in its own order (the
 *  freeze's), ties going to the earlier path and step, so every judge answers the same. */
export function recall(memory: MemoryPath[], goal: string, from: Cell): Recall {
	const paths = memory.filter((m) => m.goal === goal && m.path.length);
	if (!paths.length) return { found: false, reason: "the memory holds no path to this goal" };
	// nodes: path i, step j; by room for the jumps
	const key = (i: number, j: number) => i * 1000 + j;
	const byRoom = new Map<string, Array<[number, number]>>();
	paths.forEach((p, i) => p.path.forEach((s, j) => { const l = byRoom.get(s[0]) ?? []; l.push([i, j]); byRoom.set(s[0], l); }));
	const starts = byRoom.get(from.room) ?? [];
	if (!starts.length) return { found: false, reason: `the memory holds no path through ${from.room}` };
	const best = new Map<number, number>(), prev = new Map<number, number>(), first = new Map<number, number>();
	// a small binary heap of [cost, node]
	const heap: Array<[number, number]> = [];
	const push = (c: number, n: number) => { heap.push([c, n]); for (let i = heap.length - 1; i > 0; ) { const p = (i - 1) >> 1; if (heap[p]![0] < heap[i]![0] || (heap[p]![0] === heap[i]![0] && heap[p]![1] <= heap[i]![1])) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; } };
	const pop = (): [number, number] => { const top = heap[0]!, last = heap.pop()!; if (heap.length) { heap[0] = last; for (let i = 0; ; ) { const l = 2 * i + 1, r = l + 1; let m = i; for (const c of [l, r]) if (c < heap.length && (heap[c]![0] < heap[m]![0] || (heap[c]![0] === heap[m]![0] && heap[c]![1] < heap[m]![1]))) m = c; if (m === i) break; [heap[m], heap[i]] = [heap[i]!, heap[m]!]; i = m; } } return top; };
	const relax = (n: number, c: number, from?: number) => { if (c < (best.get(n) ?? Infinity)) { best.set(n, c); if (from === undefined) prev.delete(n); else prev.set(n, from); push(c, n); } };
	// the way starts at the remembered cell nearest to the figure (several when they are as near), and goes on from there
	const near = Math.min(...starts.map(([i, j]) => { const s = paths[i]!.path[j]!; return dist(from, { x: s[1], y: s[2] }); }));
	for (const [i, j] of starts) { const s = paths[i]!.path[j]!, n = key(i, j), d = dist(from, { x: s[1], y: s[2] }); if (d === near && d < (best.get(n) ?? Infinity)) { first.set(n, d); relax(n, d); } }
	const done = new Set<number>();
	let end: number | null = null;
	while (heap.length) {
		const [c, n] = pop();
		if (done.has(n) || c > (best.get(n) ?? Infinity)) continue;
		done.add(n);
		const i = Math.floor(n / 1000), j = n % 1000, p = paths[i]!.path, s = p[j]!;
		if (j === p.length - 1) { end = n; break; }
		const t = p[j + 1]!;
		relax(key(i, j + 1), c + (t[0] === s[0] ? dist({ x: s[1], y: s[2] }, { x: t[1], y: t[2] }) : 1), n);
		for (const [k, l] of byRoom.get(s[0]) ?? []) {
			if (k === i) continue;
			const o = paths[k]!.path[l]!, d = dist({ x: s[1], y: s[2] }, { x: o[1], y: o[2] });
			if (d <= NEAR) relax(key(k, l), c + JUMP_CELLS + d, n);
		}
	}
	if (end === null) return { found: false, reason: "no remembered path leads on to the goal" };
	const chain: number[] = [];
	for (let n: number | undefined = end; n !== undefined; n = prev.get(n)) chain.unshift(n);
	const at = (n: number) => paths[Math.floor(n / 1000)]!.path[n % 1000]!;
	const steps: PathStep[] = [], links: Array<[PathStep, PathStep]> = [];
	chain.forEach((n, x) => {
		const s = at(n), before = chain[x - 1];
		if (before !== undefined && Math.floor(before / 1000) !== Math.floor(n / 1000)) links.push([at(before), s]);
		const last = steps.at(-1);
		if (!last || last[0] !== s[0] || last[1] !== s[1] || last[2] !== s[2]) steps.push([s[0], s[1], s[2]]);
	});
	const start = chain[0]!;
	return { found: true, from: at(start), distance: first.get(start) ?? 0, jumps: links.length, cost: best.get(end)!, steps, links };
}

/** Whether the memory covers an episode: it holds a way to the goal from a cell near the episode's start. */
export const covers = (memory: MemoryPath[], goal: string, start: Cell): boolean => { const r = recall(memory, goal, start); return r.found && r.distance <= NEAR; };

// ---- in the space ---------------------------------------------------------------------------------------------
type Store = Pick<SpaceLike, "readAll" | "readIfExists" | "write" | "take" | "count">;
type MemoryFields = MemoryPath & { session: string; blockId: string; candidateId: string; ts: number };
const byAge = (a: MemoryFields, b: MemoryFields) => a.ts - b.ts || a.memoryId.localeCompare(b.memoryId);

/** The freeze id of a run's generation (`gen` as the candidates count it, from 1). */
export const runFreezeId = (runId: string, gen: number): string => `${runId}-g${gen}`;

/** Writes a freeze of the block's memory as it stands: the ids of its paths, oldest first. */
export async function freezeMemory(space: Store, txn: string | null, ttl: number, k: { session: string; blockId: string; freezeId: string }): Promise<void> {
	if (await space.readIfExists({ type: "MemoryFreeze", fields: { session: k.session, blockId: k.blockId, freezeId: k.freezeId } }, NO_WAIT, { txn })) return;
	const rows = (await space.readAll({ type: "PlanMemory", fields: { session: k.session, blockId: k.blockId } }, { limit: MAX_MEMORY + 10, txn })).map((e) => e.fields as unknown as MemoryFields).sort(byAge);
	await space.write({ type: "MemoryFreeze", fields: { ...k, memoryIds: rows.slice(-MAX_MEMORY).map((m) => m.memoryId), ts: Date.now() } as never }, txn, ttl);
}

/** The paths of a freeze, in its order; none when the candidate has no freeze or it is gone. Paths the block dropped
 *  since (beyond MAX_MEMORY) are missing. */
export async function frozenMemory(space: Store, session: string, blockId: string, freezeId: string | undefined): Promise<MemoryPath[]> {
	if (!freezeId) return [];
	const f = await space.readIfExists({ type: "MemoryFreeze", fields: { session, blockId, freezeId } }, NO_WAIT);
	const ids = Array.isArray((f?.fields as { memoryIds?: unknown } | undefined)?.memoryIds) ? ((f!.fields as { memoryIds: string[] }).memoryIds) : [];
	if (!ids.length) return [];
	const rows = new Map((await space.readAll({ type: "PlanMemory", fields: { session, blockId } }, { limit: MAX_MEMORY + 10 })).map((e) => { const m = e.fields as unknown as MemoryFields; return [m.memoryId, m] as const; }));
	return ids.flatMap((id) => { const m = rows.get(id); return m ? [{ memoryId: m.memoryId, gen: m.gen, author: m.author, episode: m.episode, goal: m.goal, path: m.path, ...(m.obs ? { obs: m.obs } : {}) }] : []; });
}

/** A verdict's reached sample paths into the block's memory (in the verdict's transaction): a path the block holds
 *  already is skipped, beyond MAX_MEMORY the oldest give way. */
export async function remember(space: Store, txn: string, ttl: number, k: { session: string; blockId: string; candidateId: string; author: string; gen: number }, paths: Array<{ memoryId: string; episode: string; goal: string; path: PathStep[]; obs?: TideSeen | ChanceSeen }>): Promise<number> {
	let added = 0;
	for (const p of paths) {
		if (await space.readIfExists({ type: "PlanMemory", fields: { session: k.session, blockId: k.blockId, memoryId: p.memoryId } }, NO_WAIT, { txn })) continue;
		await space.write({ type: "PlanMemory", fields: { ...k, ...p, ts: Date.now() } as never }, txn, ttl);
		added++;
	}
	if (added && (await space.count({ type: "PlanMemory", fields: { session: k.session, blockId: k.blockId } }, txn)) > MAX_MEMORY) {
		const rows = (await space.readAll({ type: "PlanMemory", fields: { session: k.session, blockId: k.blockId } }, { limit: MAX_MEMORY + 50, txn })).sort((a, b) => byAge(a.fields as unknown as MemoryFields, b.fields as unknown as MemoryFields));
		for (const e of rows.slice(0, rows.length - MAX_MEMORY)) await space.take({ id: e.id }, NO_WAIT, { txn });
	}
	return added;
}
