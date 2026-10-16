// Worker control (docs/betrieb-und-mobile-steuerung.md §7.3, §8 B6). The control host keeps the desired worker state
// per host (`WorkerAssignments`); each host pulls only its own signed list and reconciles registered worker kinds
// locally (`WorkerSupervisor`). The last accepted list is persisted, so local workers keep running while the
// coordinator is unreachable (v3 5.2). Workers are in-process loops of registered code: they coordinate work, they
// do not add CPU parallelism. Status travels back as `metrics.workers` of the host's Capability heartbeat.
import type { Context } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import type { Algorithm, Signer } from "./auth.ts";
import { canonicalJson } from "./canonical.ts";
import { PiSpaces, type SpaceHost, type SpaceLike } from "./client.ts";
import { verifyDetached } from "./grants.ts";
import { listSpaces } from "./spaces.ts";
import * as core from "./core.ts";

export type WorkerSpec = { assignmentId: string; hostId: string; kind: string; targetSpace: string; count: number; runId?: string; generation: number };
export type WorkerList = { authorityId: string; incarnation: string | null; hostId: string; generation: number; assignments: WorkerSpec[] };
export type SignedWorkers = { value: WorkerList; issuer: string; algorithm: Algorithm; signature: string };
export type WorkerPin = { issuer: string; algorithm: Algorithm; publicKey: string };

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const MAX_COUNT = 64, MAX_PER_HOST = 32, MAX_ASSIGNMENTS = 1024, MAX_COMMANDS = 1024;
const bytes = (v: WorkerList) => Buffer.from("pi-spaces/worker-assignments/v1\n" + canonicalJson(v as unknown as core.Json));
const hashOf = (v: unknown) => createHash("sha256").update(canonicalJson(v as core.Json)).digest("hex");
export function verifyWorkers(t: SignedWorkers, pin: WorkerPin): WorkerList {
	if (!t || typeof t !== "object" || t.issuer !== pin.issuer || t.algorithm !== pin.algorithm || typeof t.signature !== "string" || !verifyDetached(pin.algorithm, pin.publicKey, bytes(t.value), t.signature)) throw new core.PermissionError("invalid worker assignment signature");
	return core.plain(t.value);
}

export const WorkerJournal = defineDoc<{ generation: number; assignments: Record<string, WorkerSpec>; commands: Record<string, { hash: string; generation: number }> }>({
	kind: "pi-spaces.worker-assignments", version: 1, scope: "session", initial: () => ({ generation: 0, assignments: {}, commands: {} }),
});

/** Control side: the desired worker state. `setWorkers` admin commands land here; hosts read their signed share. */
export class WorkerAssignments {
	private o: { host: SpaceHost; ctx: Context; authorityId: string; peerId: string; signer: Signer; identity?: () => Promise<{ incarnation: string | null }>; now?: () => number };
	constructor(o: WorkerAssignments["o"]) { this.o = o; }
	/** count 0 stops every worker of the assignment after its current task; the assignment stays as the stop instruction. */
	async set(commandId: string, a: { assignmentId: string; hostId: string; kind: string; targetSpace: string; count: number; runId?: string }): Promise<WorkerSpec> {
		if (!ID.test(commandId) || !a || ![a.assignmentId, a.hostId, a.kind, a.targetSpace].every(v => typeof v === "string" && ID.test(v)) || (a.runId !== undefined && !ID.test(a.runId)) || !Number.isSafeInteger(a.count) || a.count < 0 || a.count > MAX_COUNT) throw new core.IllegalArgumentError(`a worker assignment needs IDs, a kind, a target Space and a count 0..${MAX_COUNT}`);
		const input = { assignmentId: a.assignmentId, hostId: a.hostId, kind: a.kind, targetSpace: a.targetSpace, count: a.count, ...(a.runId !== undefined ? { runId: a.runId } : {}) };
		const hash = hashOf(input);
		return this.o.host.commit(async tx => {
			const d = await tx.doc(WorkerJournal);
			const old = d.commands[commandId];
			if (old) { if (old.hash !== hash) throw new core.IllegalArgumentError("command ID was used for another worker assignment"); return core.plain(d.assignments[a.assignmentId] ?? { ...input, generation: old.generation }); }
			const prior = d.assignments[a.assignmentId];
			if (prior && prior.hostId !== a.hostId) throw new core.RunGateConflict("an assignment keeps its host; stop it and create another");
			if (!prior && (Object.keys(d.assignments).length >= MAX_ASSIGNMENTS || Object.values(d.assignments).filter(x => x.hostId === a.hostId).length >= MAX_PER_HOST)) throw new core.ResourceExhausted("worker assignment directory is full");
			if (Object.keys(d.commands).length >= MAX_COMMANDS) throw new core.ResourceExhausted("worker command history is full");
			d.generation++;
			d.assignments[a.assignmentId] = { ...input, generation: d.generation };
			d.commands[commandId] = { hash, generation: d.generation };
			return core.plain(d.assignments[a.assignmentId]!);
		}, this.o.ctx);
	}
	/** The signed list of one host. `hostId` must come from the authenticated connection, never from the request. */
	async forHost(hostId: string): Promise<SignedWorkers> {
		const d = await this.o.host.snapshot(WorkerJournal, this.o.ctx);
		const incarnation = this.o.identity ? (await this.o.identity()).incarnation : null;
		const value: WorkerList = { authorityId: this.o.authorityId, incarnation, hostId, generation: d?.generation ?? 0, assignments: Object.values(d?.assignments ?? {}).filter(a => a.hostId === hostId).sort((x, y) => x.assignmentId.localeCompare(y.assignmentId)) };
		return { value, issuer: this.o.peerId, algorithm: this.o.signer.algorithm, signature: Buffer.from(await this.o.signer.sign(bytes(value))).toString("base64") };
	}
	async list(): Promise<{ generation: number; assignments: WorkerSpec[] }> {
		const d = await this.o.host.snapshot(WorkerJournal, this.o.ctx);
		return { generation: d?.generation ?? 0, assignments: Object.values(d?.assignments ?? {}).map(a => core.plain(a)) };
	}
}

/** What a host reports in `metrics.workers` of its Capability heartbeat. */
export type WorkerSummary = {
	authorityId: string | null; incarnation: string | null; generation: number; at: number; blocked?: string; fetchError?: string;
	assignments: Record<string, { kind: string; targetSpace: string; runId?: string; desired: number; active: number; stopping: number; tasks: number; errors: number; lastError?: string; rejected?: string }>;
};
/** The applied worker state per host, read from the Capability entries of the control Space (may be stale: see `at`). */
export function appliedWorkers(control: Readonly<core.SpaceState>, now: number): Record<string, { at: number; workers: WorkerSummary }> {
	const out: Record<string, { at: number; workers: WorkerSummary }> = {};
	for (const e of core.list(control, now, { type: "Capability" })) {
		const f = e.fields as Record<string, any>, w = f.metrics?.workers;
		if (typeof f.hostId === "string" && w && typeof w === "object" && (!out[f.hostId] || out[f.hostId]!.at < Number(f.at))) out[f.hostId] = { at: Number(f.at), workers: core.plain(w) };
	}
	return out;
}

/** One unit of registered work: true if a task was completed, false if none was available right now. */
export type WorkerKind = { step(ctx: { space: SpaceLike; spaceId: string; runId?: string; signal: AbortSignal }): Promise<boolean>; requiresRun?: boolean };
type Loop = { ctrl: AbortController; done: Promise<void> };
type Running = { spec: WorkerSpec; loops: Loop[]; stopping: Loop[]; tasks: number; errors: number; lastError?: string };
const WorkerState = defineDoc<{ authorityId: string | null; incarnation: string | null; generation: number; assignments: WorkerSpec[] }>({
	kind: "pi-spaces.worker-supervisor", version: 1, scope: "session", initial: () => ({ authorityId: null, incarnation: null, generation: 0, assignments: [] }),
});
export const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
	if (signal.aborted) return resolve();
	const t = setTimeout(done, ms);
	function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
	signal.addEventListener("abort", done, { once: true });
});

/** Host side: reconciles the persisted desired state with running loops of registered worker kinds. */
export class WorkerSupervisor {
	private o: { host: SpaceHost; ctx: Context; hostId: string; authorityId: string; controllerPin: WorkerPin; kinds: Record<string, WorkerKind>; fetch: () => Promise<SignedWorkers>; space?: (spaceId: string) => SpaceLike; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; backoff?: { minMs: number; maxMs: number } };
	private running = new Map<string, Running>();
	private rejected = new Map<string, string>();
	private blocked: string | undefined;
	private fetchError: string | undefined;
	constructor(o: WorkerSupervisor["o"]) { this.o = o; }
	private now() { return (this.o.now ?? Date.now)(); }

	/** One pass: fetch and verify the host's list, persist an acceptable one, then scale the loops to it. */
	async reconcile(): Promise<WorkerSummary> {
		let list: WorkerList | undefined;
		try {
			list = verifyWorkers(await this.o.fetch(), this.o.controllerPin);
			if (list.hostId !== this.o.hostId || list.authorityId !== this.o.authorityId) throw new core.PermissionError("worker list belongs to another host or authority");
			if (!Array.isArray(list.assignments) || list.assignments.some(a => a.hostId !== this.o.hostId)) throw new core.PermissionError("worker list contains another host's assignment");
			this.fetchError = undefined;
		} catch (e) { list = undefined; this.fetchError = String((e as Error)?.message ?? e).slice(0, 256); }
		const accepted = await this.o.host.commit(async tx => {
			const d = await tx.doc(WorkerState);
			if (list) {
				const known = d.generation > 0;
				if (known && (d.authorityId !== list.authorityId || d.incarnation !== list.incarnation)) this.blocked = `control identity changed (${d.incarnation} -> ${list.incarnation}); accept it explicitly with acceptControlIdentity`;
				else {
					this.blocked = undefined;
					if (!known || list.generation > d.generation) { d.authorityId = list.authorityId; d.incarnation = list.incarnation; d.generation = list.generation; d.assignments = core.plain(list.assignments); }
				}
			}
			return core.plain(d);
		}, this.o.ctx);
		await this.apply(accepted.assignments);
		return this.summary(accepted);
	}
	/** After a verified Control restore: the next list of this identity is accepted although its generation restarted. */
	async acceptControlIdentity(incarnation: string | null): Promise<void> {
		await this.o.host.commit(async tx => { const d = await tx.doc(WorkerState); d.incarnation = incarnation; d.generation = 0; }, this.o.ctx);
		this.blocked = undefined;
	}
	private async apply(specs: WorkerSpec[]): Promise<void> {
		const local = new Set((await listSpaces(this.o.host, this.o.ctx)).map(i => i.spaceId));
		const wanted = new Map(specs.map(s => [s.assignmentId, s]));
		this.rejected.clear();
		for (const [id, r] of this.running) {
			if (!wanted.has(id)) { r.spec = { ...r.spec, count: 0 }; this.scale(r, 0); }
			if (!wanted.has(id) && !r.loops.length && !r.stopping.length) this.running.delete(id);
		}
		for (const spec of specs) {
			const kind = Object.hasOwn(this.o.kinds, spec.kind) ? this.o.kinds[spec.kind] : undefined;
			const reason = !kind ? `no registered worker kind ${spec.kind}` : !local.has(spec.targetSpace) ? `target Space ${spec.targetSpace} is not on this host` : kind.requiresRun && !spec.runId ? `worker kind ${spec.kind} needs a runId` : undefined;
			let r = this.running.get(spec.assignmentId);
			if (reason) { this.rejected.set(spec.assignmentId, reason); if (r) this.scale(r, 0); continue; }
			const old = r;
			if (r && (r.spec.kind !== spec.kind || r.spec.targetSpace !== spec.targetSpace || r.spec.runId !== spec.runId)) { this.scale(r, 0); r = undefined; }
			// A restarted assignment shares the list of loops still finishing their task under the old target.
			if (!r) { r = { spec, loops: [], stopping: old?.stopping ?? [], tasks: 0, errors: 0 }; this.running.set(spec.assignmentId, r); }
			r.spec = spec;
			this.scale(r, spec.count);
		}
	}
	private scale(r: Running, count: number): void {
		while (r.loops.length > count) {
			const l = r.loops.pop()!, list = r.stopping;
			l.ctrl.abort(); list.push(l);
			void l.done.finally(() => { const i = list.indexOf(l); if (i >= 0) list.splice(i, 1); });
		}
		while (r.loops.length < count) {
			const ctrl = new AbortController(), loop: Loop = { ctrl, done: Promise.resolve() };
			loop.done = this.loop(r, ctrl.signal);
			r.loops.push(loop);
		}
	}
	/** Stop is checked between steps (a task is never cut off); a wait for work is interrupted at once. */
	private async loop(r: Running, signal: AbortSignal): Promise<void> {
		const kind = this.o.kinds[r.spec.kind]!, spec = r.spec;
		const space = (this.o.space ?? (id => new PiSpaces(this.o.host, this.o.ctx, this.o.now, undefined, undefined, { space: id })))(spec.targetSpace);
		const sleep = this.o.sleep ?? abortableSleep, { minMs, maxMs } = this.o.backoff ?? { minMs: 100, maxMs: 5000 };
		let delay = 0;
		while (!signal.aborted) {
			try {
				if (await kind.step({ space, spaceId: spec.targetSpace, ...(spec.runId ? { runId: spec.runId } : {}), signal })) { r.tasks++; delay = 0; await new Promise(res => setImmediate(res)); continue; }
			} catch (e) { r.errors++; r.lastError = String((e as Error)?.message ?? e).slice(0, 256); }
			delay = Math.min(maxMs, Math.max(minMs, delay * 2)); // no work, gate closed or an error: back off, never spin
			await sleep(delay, signal);
		}
	}
	summary(state?: { authorityId: string | null; incarnation: string | null; generation: number }): WorkerSummary {
		const assignments: WorkerSummary["assignments"] = {};
		for (const [id, r] of this.running) assignments[id] = { kind: r.spec.kind, targetSpace: r.spec.targetSpace, ...(r.spec.runId ? { runId: r.spec.runId } : {}), desired: r.spec.count, active: r.loops.length, stopping: r.stopping.length, tasks: r.tasks, errors: r.errors, ...(r.lastError ? { lastError: r.lastError } : {}) };
		for (const [id, reason] of this.rejected) assignments[id] = { ...(assignments[id] ?? { kind: "?", targetSpace: "?", desired: 0, active: 0, stopping: 0, tasks: 0, errors: 0 }), rejected: reason };
		return { authorityId: state?.authorityId ?? null, incarnation: state?.incarnation ?? null, generation: state?.generation ?? 0, at: this.now(), ...(this.blocked ? { blocked: this.blocked } : {}), ...(this.fetchError ? { fetchError: this.fetchError } : {}), assignments };
	}
	/** Stops every loop after its current step and waits for them. */
	async stop(): Promise<void> {
		const all = [...this.running.values()].flatMap(r => { this.scale(r, 0); return r.stopping.map(l => l.done); });
		await Promise.allSettled(all);
		this.running.clear();
	}
}

/** Runs `reconcile` periodically and hands each summary to `publish` (e.g. the Capability heartbeat). */
export function startWorkerSupervisor(s: WorkerSupervisor, o: { intervalMs?: number; publish?: (summary: WorkerSummary) => Promise<void>; onError?: (e: unknown) => void } = {}): () => Promise<void> {
	let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> = Promise.resolve();
	const run = () => { active = s.reconcile().then(sum => o.publish?.(sum)).catch(o.onError ?? (() => {})).then(() => { if (!stopped) timer = setTimeout(run, o.intervalMs ?? 15_000); }); };
	run();
	return async () => { stopped = true; if (timer) clearTimeout(timer); await active; await s.stop(); };
}

/** The `setWorkers` admin command for the control-space supervisor; refusals become failed results. */
export function workerCommands(w: WorkerAssignments, applied?: () => Promise<Record<string, { at: number; workers: WorkerSummary }>>): Record<"setWorkers" | "listWorkers", (commandId: string, args: Record<string, core.Json>) => Promise<core.Json>> {
	return {
		/** Read-only: desired assignments and the last applied state per host (with its age). */
		async listWorkers() { const d = await w.list(); return { ...d, applied: applied ? await applied() : {} } as unknown as core.Json; },
		async setWorkers(id, a) {
			try { return (await w.set(id, { assignmentId: String(a.assignmentId ?? ""), hostId: String(a.hostId ?? ""), kind: String(a.kind ?? ""), targetSpace: String(a.targetSpace ?? ""), count: Number(a.count), ...(a.runId !== undefined && a.runId !== null ? { runId: String(a.runId) } : {}) })) as unknown as core.Json; }
			catch (e) { if (e instanceof core.IllegalArgumentError || e instanceof core.TransactionError || e instanceof core.LimitError) return { phase: "failed", error: e.message }; throw e; }
		},
	};
}
