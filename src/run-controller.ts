// Run control (docs/betrieb-und-mobile-steuerung.md §6, §8 B3): a durable journal of start/pause/resume/stop with
// monotone control revisions. Every Member of a run's manifest applies the command to its RunGate; a transition is
// complete only when every Member confirmed it with a matching ACK. A crash or a lost reply resends the same
// command (same revision and command ID), which the gate answers with its stored confirmation.
import type { Context } from "./context.ts";
import { defineDoc } from "./store/documents.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import type { SpaceHost, SpaceLike } from "./client.ts";
import { spaceDoc } from "./spaces.ts";
import * as core from "./core.ts";

export type RunSpec = { runId: string; kind: string; config: core.Json; members: string[] };
export type RunStatus = "preparing" | "running" | "pausing" | "pauseIncomplete" | "paused" | "resuming" | "stopping" | "stopped" | "reconciling" | "needsReview";
/** One Member of a run's manifest; `prepare` creates the run's tasks idempotently while its gate is preparing. */
export interface RunMember {
	readonly spaceId: string;
	prepare(run: RunSpec, gate: core.RunGateCommand): Promise<core.RunGateAck>;
	gate(command: core.RunGateCommand): Promise<core.RunGateAck>;
	/** Installs the recovery entry fence and returns the Member's view of the run (§6 Recovery-Sicht). */
	recover(runId: string, recoveryId: string): Promise<core.RunRecoveryView>;
}
/** The control authority and incarnation a transition was issued under; a restore changes it. */
export type RunIdentity = { authorityId: string | null; incarnation: string | null };
type Pending = { commandId: string; kind: core.RunGateKind; revision: number; acks: Record<string, core.RunGateAck>; errors: Record<string, string>; identity?: RunIdentity; recoveryId?: string; expect?: Record<string, { revision: number; state: core.RunGateState }>; then?: "resume" };
type Decision = "pause" | "stop" | "resume";
type Recovery = { id: string; commandId: string; stage: "required" | "gathering" | "review" | "deciding"; reason?: string; identity?: RunIdentity; abandoned?: { commandId: string; kind: core.RunGateKind; revision: number }; views: Record<string, core.RunRecoveryView>; errors: Record<string, string>; changed?: Record<string, string>; viewHash?: string; decision?: { commandId: string; decision: Decision; viewHash: string | null; auto: boolean }; partial?: string[] };
type RunRec = { spec: RunSpec; revision: number; state: core.RunGateState; pending?: Pending; recovery?: Recovery; issued: string[]; resolved?: Array<{ id: string; decision: Decision; auto: boolean }>; commands: Record<string, { hash: string; kind: string; revision: number }>; tuples: Record<string, { incarnation: string | null; authorityId: string | null }>; at: number; schedules?: Array<{ id: string; kind: "pause" | "resume"; at: number }> };
export type RunView = {
	runId: string; kind: string; members: string[]; revision: number; state: RunStatus;
	pending?: { commandId: string; kind: core.RunGateKind; revision: number; applied: string[]; fenced: string[]; missing: string[]; errors: Record<string, string> };
	recovery?: { id: string; stage: Recovery["stage"]; reason?: string; viewHash?: string; abandoned?: Recovery["abandoned"]; decision?: Recovery["decision"]; errors: Record<string, string>; changed?: Record<string, string>; partial?: string[]; views: Record<string, core.RunRecoveryView> };
};

export const RunJournal = defineDoc<{ runs: Record<string, RunRec> }>({
	kind: "phi-spaces.run-controller", version: 1, scope: "session", initial: () => ({ runs: {} }),
});
/** Another transition of the same run is still waiting for ACKs, or the run is under recovery; commands are serialized per run. */
export class RunBusy extends core.TransactionError {}
/** Reads a run's results from its Members (registered per run kind; e.g. the sieve). Never changes anything. */
export type RunExporter = (run: RunSpec, space: (spaceId: string) => SpaceLike) => Promise<{ complete: boolean; expected: number; found: number; missing: string[]; resultHash: string; summary: core.Json }>;

const MAX_RUNS = 1024, MAX_MEMBERS = 64, MAX_CONFIG_BYTES = 16 * 1024, MAX_COMMANDS = 256, MAX_ISSUED = 128;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const hashOf = digestJson;
const sameIdentity = (a: RunIdentity, b: RunIdentity) => a.authorityId === b.authorityId && a.incarnation === b.incarnation;
function validate(spec: RunSpec): void {
	if (!spec || !ID.test(spec.runId) || typeof spec.kind !== "string" || !ID.test(spec.kind)) throw new core.IllegalArgumentError("a run needs a runId and a kind");
	if (!Array.isArray(spec.members) || !spec.members.length || spec.members.length > MAX_MEMBERS || new Set(spec.members).size !== spec.members.length || !spec.members.every(m => typeof m === "string" && ID.test(m))) throw new core.IllegalArgumentError(`a run needs 1..${MAX_MEMBERS} distinct Members`);
	if (Buffer.byteLength(canonicalJson(spec.config)) > MAX_CONFIG_BYTES) throw new core.LimitError("run configuration is too large");
}
function issue(r: RunRec, p: Pending): Pending {
	r.issued.push(p.commandId);
	if (r.issued.length > MAX_ISSUED) r.issued.splice(0, r.issued.length - MAX_ISSUED);
	return p;
}
/** Stable control data of all views, without timestamps: what an admin decision is bound to. */
function viewHash(r: RunRec, views: Record<string, core.RunRecoveryView>): string {
	return hashOf({ runId: r.spec.runId, members: r.spec.members, journal: { revision: r.revision, state: r.state }, abandoned: r.recovery?.abandoned ?? null, views: r.spec.members.map(m => views[m] ?? null) } as unknown as core.Json);
}
function viewOf(r: RunRec): RunView {
	const v: RunView = { runId: r.spec.runId, kind: r.spec.kind, members: [...r.spec.members], revision: r.revision, state: r.state };
	const p = r.pending, q = r.recovery;
	if (q) v.recovery = { id: q.id, stage: q.stage, ...(q.reason ? { reason: q.reason } : {}), ...(q.viewHash ? { viewHash: q.viewHash } : {}), ...(q.abandoned ? { abandoned: { ...q.abandoned } } : {}), ...(q.decision ? { decision: { ...q.decision } } : {}), errors: { ...q.errors }, ...(q.changed ? { changed: { ...q.changed } } : {}), ...(q.partial ? { partial: [...q.partial] } : {}), views: core.plain(q.views) };
	if (p) {
		const errors = { ...p.errors };
		v.state = p.kind === "prepare" || p.kind === "release" ? "preparing" : p.kind === "pause" ? (Object.keys(errors).length ? "pauseIncomplete" : "pausing") : p.kind === "resume" ? "resuming" : "stopping";
		v.pending = { commandId: p.commandId, kind: p.kind, revision: p.revision, errors,
			applied: r.spec.members.filter(m => p.acks[m]?.phase === "applied"), fenced: r.spec.members.filter(m => p.acks[m]?.phase === "fenced"), missing: r.spec.members.filter(m => !p.acks[m]) };
	}
	if (q) v.state = q.stage === "review" || q.stage === "required" ? "needsReview" : "reconciling";
	return v;
}

export class RunController {
	private o: { host: SpaceHost; ctx: Context; member: (spaceId: string) => RunMember; now?: () => number; identity?: () => Promise<RunIdentity>; exporters?: Record<string, RunExporter>; space?: (spaceId: string) => SpaceLike };
	/** `identity`: the current control authority and incarnation; pending transitions of another one are never resent. */
	constructor(o: RunController["o"]) { this.o = o; }
	private now() { return (this.o.now ?? Date.now)(); }
	private async identity(): Promise<RunIdentity | undefined> { return this.o.identity ? core.plain(await this.o.identity()) : undefined; }
	private commit<T>(f: (runs: Record<string, RunRec>) => T): Promise<T> {
		return this.o.host.commit(async tx => f((await tx.doc(RunJournal)).runs), this.o.ctx);
	}

	/** Journals the run, prepares every Member behind a `preparing` gate and releases the gates once all are prepared. */
	async start(commandId: string, spec: RunSpec): Promise<RunView> {
		validate(spec);
		if (!ID.test(commandId)) throw new core.IllegalArgumentError("invalid command ID");
		const hash = hashOf({ op: "start", spec } as unknown as core.Json), identity = await this.identity();
		await this.commit(runs => {
			const old = Object.hasOwn(runs, spec.runId) ? runs[spec.runId] : undefined;
			if (old) {
				if (old.commands[commandId]?.hash === hash) return;
				throw new core.RunGateConflict(`run ${spec.runId} was already started by another command`);
			}
			if (Object.keys(runs).length >= MAX_RUNS) throw new core.ResourceExhausted("run journal is full");
			runs[spec.runId] = { spec: core.plain(spec), revision: 0, state: "preparing", at: this.now(), tuples: {}, issued: [], commands: { [commandId]: { hash, kind: "start", revision: 1 } } };
			const r = runs[spec.runId]!;
			r.pending = issue(r, { commandId, kind: "prepare", revision: 1, acks: {}, errors: {}, ...(identity ? { identity } : {}) });
		});
		return this.advance(spec.runId);
	}
	pause(commandId: string, runId: string): Promise<RunView> { return this.transition(commandId, runId, "pause"); }
	resume(commandId: string, runId: string): Promise<RunView> { return this.transition(commandId, runId, "resume"); }
	stop(commandId: string, runId: string): Promise<RunView> { return this.transition(commandId, runId, "stop"); }

	private async transition(commandId: string, runId: string, kind: "pause" | "resume" | "stop"): Promise<RunView> {
		if (!ID.test(commandId)) throw new core.IllegalArgumentError("invalid command ID");
		const hash = hashOf({ op: kind, runId }), identity = await this.identity();
		await this.commit(runs => {
			const r = Object.hasOwn(runs, runId) ? runs[runId] : undefined;
			if (!r) throw new core.IllegalArgumentError(`unknown run ${runId}`);
			const old = r.commands[commandId];
			if (old) { if (old.hash !== hash) throw new core.IllegalArgumentError("command ID was used for another command"); return; }
			if (r.recovery) throw new RunBusy(`run ${runId} is under recovery ${r.recovery.id}; resolve it first`);
			// A stop may replace an unfinished preparation (no transaction can be bound yet); anything else waits.
			const supersede = kind === "stop" && (r.pending?.kind === "prepare" || r.pending?.kind === "release");
			if (r.pending && !supersede) throw new RunBusy(`run ${runId} is still applying ${r.pending.kind} at revision ${r.pending.revision}`);
			const from = { pause: ["running"], resume: ["paused"], stop: ["preparing", "running", "paused"] }[kind];
			if (!from.includes(r.state)) throw new core.RunGateConflict(`cannot ${kind} run ${runId} while it is ${r.state}`);
			if (Object.keys(r.commands).length >= MAX_COMMANDS) throw new core.ResourceExhausted("run command history is full");
			r.pending = issue(r, { commandId, kind, revision: (r.pending?.revision ?? r.revision) + 1, acks: {}, errors: {}, ...(identity ? { identity } : {}) });
			r.commands[commandId] = { hash, kind, revision: r.pending.revision };
		});
		return this.advance(runId);
	}

	/**
	 * Starts the reconciliation of a run after a Control or Data restore (§6 Abgleich nach Restore). A pending
	 * transition is parked as evidence and never resent. Every Member installs the recovery entry fence and reports
	 * its view. Identical stable paused/stopped views of known origin are confirmed with fresh ACKs; anything else
	 * waits for `resolve`. `manifest` rebuilds a run the restored journal no longer knows.
	 */
	async reconcile(commandId: string, runId: string, recoveryId: string, manifest?: { kind: string; members: string[] }): Promise<RunView> {
		if (!ID.test(commandId) || !ID.test(recoveryId)) throw new core.IllegalArgumentError("invalid command or recovery ID");
		if (manifest) validate({ runId, kind: manifest.kind, config: null, members: manifest.members });
		const hash = hashOf({ op: "reconcile", runId, recoveryId, manifest: manifest ?? null } as unknown as core.Json), identity = await this.identity();
		await this.commit(runs => {
			let r = Object.hasOwn(runs, runId) ? runs[runId] : undefined;
			if (r?.commands[commandId]) { if (r.commands[commandId]!.hash !== hash) throw new core.IllegalArgumentError("command ID was used for another command"); return; }
			if (!r) {
				if (!manifest) throw new core.IllegalArgumentError(`run ${runId} is not in this journal; name its kind and Members`);
				if (Object.keys(runs).length >= MAX_RUNS) throw new core.ResourceExhausted("run journal is full");
				runs[runId] = { spec: { runId, kind: manifest.kind, config: null, members: [...manifest.members] }, revision: 0, state: "preparing", at: this.now(), tuples: {}, issued: [], commands: {} };
				r = runs[runId]!;
			} else if (manifest && canonicalJson([manifest.kind, manifest.members]) !== canonicalJson([r.spec.kind, r.spec.members])) throw new core.RunGateConflict("the manifest differs from the journal; review the journal first");
			if (r.recovery?.id === recoveryId) { r.commands[commandId] = { hash, kind: "reconcile", revision: r.revision }; return; }
			if (Object.keys(r.commands).length >= MAX_COMMANDS) throw new core.ResourceExhausted("run command history is full");
			const abandoned = r.pending ? { commandId: r.pending.commandId, kind: r.pending.kind, revision: r.pending.revision } : r.recovery?.abandoned;
			delete r.pending;
			r.recovery = { id: recoveryId, commandId, stage: "gathering", views: {}, errors: {}, ...(identity ? { identity } : {}), ...(abandoned ? { abandoned } : {}) };
			r.commands[commandId] = { hash, kind: "reconcile", revision: r.revision };
		});
		return this.advance(runId);
	}

	/**
	 * The admin decision after `needsReview` (resolveRunRecovery). It is bound to the reviewed views by their hash;
	 * every Member step compares and sets the reviewed gate state. `resume` first completes a pause barrier and is
	 * refused if any evidence shows the run stopped.
	 */
	async resolve(commandId: string, runId: string, o: { expectedViewHash: string; decision: Decision }): Promise<RunView> {
		if (!ID.test(commandId) || !["pause", "stop", "resume"].includes(o?.decision) || typeof o.expectedViewHash !== "string") throw new core.IllegalArgumentError("invalid recovery decision");
		const hash = hashOf({ op: "resolve", runId, ...o }), identity = await this.identity();
		await this.commit(runs => {
			const r = Object.hasOwn(runs, runId) ? runs[runId] : undefined;
			if (!r) throw new core.IllegalArgumentError(`unknown run ${runId}`);
			if (r.commands[commandId]) { if (r.commands[commandId]!.hash !== hash) throw new core.IllegalArgumentError("command ID was used for another command"); return; }
			const q = r.recovery;
			if (!q || q.stage !== "review") throw new core.RunGateConflict(`run ${runId} has no recovery waiting for a decision`);
			if (q.viewHash !== o.expectedViewHash) throw new core.RunGateConflict("the recovery views changed; review again");
			const views = r.spec.members.map(m => q.views[m]!);
			if (o.decision === "resume" && (r.state === "stopped" || views.some(v => v.stopped))) throw new core.RunGateConflict("a stopped run is never resumed");
			if (o.decision !== "stop" && views.some(v => !v.present || v.gate!.state === "preparing")) throw new core.RunGateConflict("Members without a prepared gate allow only stop");
			if (Object.keys(r.commands).length >= MAX_COMMANDS) throw new core.ResourceExhausted("run command history is full");
			const revision = Math.max(r.revision, q.abandoned?.revision ?? 0, ...views.map(v => v.maxRevision)) + 1;
			r.pending = issue(r, { commandId, kind: o.decision === "stop" ? "stop" : "pause", revision, acks: {}, errors: {}, recoveryId: q.id, expect: Object.fromEntries(views.filter(v => v.present).map(v => [v.spaceId!, { revision: v.gate!.revision, state: v.gate!.state }])), ...(o.decision === "resume" ? { then: "resume" as const } : {}), ...(identity ? { identity } : {}) });
			q.stage = "deciding"; q.decision = { commandId, decision: o.decision, viewHash: o.expectedViewHash, auto: false };
			r.commands[commandId] = { hash, kind: "resolve", revision };
		});
		return this.advance(runId);
	}

	private async gather(r: RunRec): Promise<"again" | "wait"> {
		const q = r.recovery!, runId = r.spec.runId;
		for (const spaceId of r.spec.members) {
			if (q.views[spaceId]?.stable) continue;
			let view: core.RunRecoveryView | undefined, error: string | undefined;
			try {
				view = await this.o.member(spaceId).recover(runId, q.id);
				if (view.runId !== runId || view.recoveryId !== q.id || (view.spaceId !== null && view.spaceId !== spaceId)) throw new core.TransactionError("recovery view does not match the request");
			} catch (e) { view = undefined; error = String((e as Error)?.message ?? e).slice(0, 256); }
			await this.commit(runs => {
				const cur = runs[runId]!.recovery;
				if (!cur || cur.id !== q.id || cur.stage !== "gathering") return;
				if (view) { cur.views[spaceId] = core.plain(view); delete cur.errors[spaceId]; } else cur.errors[spaceId] = error!;
			});
		}
		return this.commit(runs => {
			const cur = runs[runId]!, q = cur.recovery;
			if (!q || q.stage !== "gathering") return "again";
			if (!cur.spec.members.every(m => q.views[m]?.stable)) return "wait";
			const views = cur.spec.members.map(m => q.views[m]!);
			// ACKs from now on must come from the incarnations that reported these views.
			cur.tuples = Object.fromEntries(views.map(v => [v.spaceId ?? "", { incarnation: v.incarnation, authorityId: v.authorityId }]));
			const states = new Set(views.map(v => v.gate?.state ?? "missing"));
			const state = [...states][0];
			const clean = views.every(v => v.present && !v.fence && (!v.restored || (!v.restored.fence && v.restored.state === v.gate!.state && v.restored.revision === v.gate!.revision)));
			const known = views.every(v => cur.issued.includes(v.gate?.commandId ?? "") || (cur.resolved ?? []).some(x => v.gate?.commandId === x.id));
			const stopped = cur.state === "stopped" || views.some(v => v.stopped);
			if (clean && known && !q.abandoned && states.size === 1 && (state === "stopped" || (state === "paused" && !stopped))) {
				const revision = Math.max(cur.revision, ...views.map(v => v.maxRevision)) + 1, commandId = `${q.id}:confirm`;
				cur.pending = issue(cur, { commandId, kind: state === "paused" ? "pause" : "stop", revision, acks: {}, errors: {}, recoveryId: q.id, expect: Object.fromEntries(views.map(v => [v.spaceId!, { revision: v.gate!.revision, state: v.gate!.state }])), ...(q.identity ? { identity: q.identity } : {}) });
				q.stage = "deciding"; q.decision = { commandId, decision: state === "paused" ? "pause" : "stop", viewHash: null, auto: true };
				return "again";
			}
			q.stage = "review"; q.viewHash = viewHash(cur, q.views);
			return "wait";
		});
	}

	/**
	 * Sends the pending command to every Member that has not applied it and records the answers. Safe to repeat at
	 * any time, also after a restart. Fenced Members finish their bound transactions first; call again later.
	 * A transition issued under another control authority or incarnation is never resent, and a Member under a restore
	 * recovery takes no ordinary command: both start `reconcile` automatically (fence and gather only; decisions stay
	 * with `resolve` unless the views are unambiguous).
	 */
	async advance(runId: string): Promise<RunView> {
		for (;;) {
			const r = await this.commit(runs => core.plain(Object.hasOwn(runs, runId) ? runs[runId] : undefined));
			if (!r) throw new core.IllegalArgumentError(`unknown run ${runId}`);
			const identity = await this.identity();
			const issuedUnder = r.pending?.identity ?? r.recovery?.identity;
			if (identity && issuedUnder && !sameIdentity(identity, issuedUnder)) {
				// Control restore: never resend; reconcile under a recovery named after the new incarnation.
				const id = ("control-" + String(identity.incarnation ?? "unknown")).replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 90);
				return this.reconcile(`auto-${id}`, runId, id);
			}
			if (r.recovery?.stage === "required" || r.recovery?.stage === "review") return viewOf(r);
			if (r.recovery?.stage === "gathering") { if (await this.gather(r) === "again") continue; return (await this.status(runId))!; }
			const p = r.pending;
			if (!p) { if ((r.schedules ?? []).some(x => x.at <= this.now())) { await this.dueSchedules(runId); return (await this.status(runId))!; } return viewOf(r); }
			for (const spaceId of r.spec.members) {
				if (p.acks[spaceId]?.phase === "applied") continue;
				const command: core.RunGateCommand = { runId, commandId: p.commandId, kind: p.kind, revision: p.revision, ...(p.recoveryId ? { recoveryId: p.recoveryId } : {}), ...(p.expect?.[spaceId] ? { expect: p.expect[spaceId] } : {}) };
				let ack: core.RunGateAck | undefined, error: string | undefined;
				try {
					const member = this.o.member(spaceId);
					ack = p.kind === "prepare" ? await member.prepare(r.spec, command) : await member.gate(command);
					if (ack.spaceId !== spaceId || ack.runId !== runId || ack.revision !== p.revision || ack.commandId !== p.commandId || ack.kind !== p.kind) throw new core.TransactionError("ACK does not match the command");
				} catch (e) { ack = undefined; error = String((e as Error)?.message ?? e).slice(0, 256); }
				await this.commit(runs => {
					const cur = runs[runId]!, q = cur.pending;
					if (!q || q.commandId !== p.commandId) return; // another advance finished it
					if (ack) {
						const tuple = cur.tuples[spaceId];
						if (tuple && (tuple.incarnation !== ack.incarnation || tuple.authorityId !== ack.authorityId)) { q.errors[spaceId] = "Member incarnation or authority changed; recovery review required"; return; }
						cur.tuples[spaceId] ??= { incarnation: ack.incarnation, authorityId: ack.authorityId };
						q.acks[spaceId] = core.plain(ack); delete q.errors[spaceId];
					} else if (q.recoveryId && /review again|belongs to another command|under recovery/.test(error!) && cur.recovery?.id === q.recoveryId) {
						// The Member changed after the review (another state, command or recovery): gather fresh views; already applied steps stay visible.
						cur.recovery.partial = cur.spec.members.filter(m => q.acks[m]?.phase === "applied");
						cur.recovery.changed = { ...(cur.recovery.changed ?? {}), [spaceId]: error! }; cur.recovery.stage = "gathering"; cur.recovery.views = {};
						delete cur.recovery.viewHash; delete cur.recovery.decision; delete cur.pending;
					} else q.errors[spaceId] = error!;
				});
				if (!(await this.commit(runs => runs[runId]!.pending?.commandId === p.commandId))) break;
			}
			// Data restore on a Member: its gate carries the restore's recovery; reconcile under that recovery.
			const fenced = !p.recoveryId && (await this.commit(runs => Object.values(runs[runId]!.pending?.errors ?? {}))).map(e => /is under recovery ([a-zA-Z0-9._:-]+);/.exec(e)?.[1]).find(Boolean);
			if (fenced) return this.reconcile(`auto-${fenced}`.slice(0, 96), runId, fenced);
			const next = await this.commit(runs => {
				const cur = runs[runId]!, q = cur.pending;
				if (!q || q.commandId !== p.commandId) return "again";
				if (!cur.spec.members.every(m => q.acks[m]?.phase === "applied")) return "wait";
				const states = new Set(cur.spec.members.map(m => q.acks[m]!.state));
				if (states.size !== 1) { q.errors["*"] = `Members confirmed different states: ${[...states].join(", ")}`; return "wait"; }
				cur.revision = q.revision; cur.state = [...states][0]!; delete cur.pending;
				if (q.recoveryId && cur.recovery?.id === q.recoveryId) {
					cur.resolved ??= []; cur.resolved.push({ id: q.commandId, decision: cur.recovery.decision?.decision ?? (q.kind === "stop" ? "stop" : "pause"), auto: !!cur.recovery.decision?.auto });
					if (cur.resolved.length > 32) cur.resolved.splice(0, cur.resolved.length - 32);
					delete cur.recovery;
				}
				if (q.kind === "prepare") cur.pending = issue(cur, { commandId: `${q.commandId}:release`, kind: "release", revision: q.revision + 1, acks: {}, errors: {}, ...(q.identity ? { identity: q.identity } : {}) });
				if (q.then === "resume") cur.pending = issue(cur, { commandId: `${q.commandId}:resume`, kind: "resume", revision: q.revision + 1, acks: {}, errors: {}, ...(q.identity ? { identity: q.identity } : {}) });
				return cur.pending ? "again" : "done";
			});
			if (next !== "again") return (await this.status(runId))!;
		}
	}
	async status(runId: string): Promise<RunView | null> {
		return this.commit(runs => (Object.hasOwn(runs, runId) ? viewOf(runs[runId]!) : null));
	}
	/**
	 * Plan preview (dry run) of a start or transition: whether it would be accepted now and with which revision.
	 * Nothing is journaled or sent; the real command can still be refused if the state changes meanwhile.
	 */
	async preview(kind: "start" | "pause" | "resume" | "stop", runId: string, spec?: RunSpec): Promise<{ allowed: boolean; reason?: string; revision?: number; state?: RunStatus }> {
		try { if (kind === "start") validate(spec!); } catch (e) { return { allowed: false, reason: (e as Error).message }; }
		const view = await this.status(runId);
		if (kind === "start") return view ? { allowed: false, reason: `run ${runId} exists (${view.state})`, state: view.state } : { allowed: true, revision: 1 };
		if (!view) return { allowed: false, reason: `unknown run ${runId}` };
		if (view.recovery) return { allowed: false, reason: `run is under recovery ${view.recovery.id}`, state: view.state };
		const supersede = kind === "stop" && (view.pending?.kind === "prepare" || view.pending?.kind === "release");
		if (view.pending && !supersede) return { allowed: false, reason: `still applying ${view.pending.kind} at revision ${view.pending.revision}`, state: view.state };
		const from = { pause: ["running"], resume: ["paused"], stop: ["preparing", "running", "paused"] }[kind];
		const confirmed = view.pending ? "preparing" : view.state;
		if (!from.includes(confirmed)) return { allowed: false, reason: `cannot ${kind} while ${view.state}`, state: view.state };
		return { allowed: true, revision: (view.pending?.revision ?? view.revision) + 1, state: view.state };
	}
	/** The newest runs (at most `limit`), for overviews such as the mobile Spaces page. */
	async list(limit = 50): Promise<RunView[]> {
		return this.commit(runs => Object.values(runs).sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.min(limit, 200))).map(viewOf));
	}
	/** Runs with work left for the server-side loop: a transition waiting for ACKs or a recovery gathering views. */
	async pending(): Promise<string[]> {
		const now = this.now();
		return this.commit(runs => Object.values(runs).filter(r => r.pending || r.recovery?.stage === "gathering" || (r.schedules ?? []).some(x => x.at <= now)).map(r => r.spec.runId));
	}

	/**
	 * Schedules a pause or resume (e.g. a maintenance window). At its time the server loop issues it as an ordinary
	 * journaled command with the schedule ID as command ID; a schedule that is not applicable then is dropped and
	 * remembered as skipped. `cancel: true` removes it.
	 */
	async schedule(commandId: string, runId: string, o: { kind: "pause" | "resume"; at: number; cancel?: boolean }): Promise<{ runId: string; schedules: Array<{ id: string; kind: string; at: number }> }> {
		if (!ID.test(commandId) || !["pause", "resume"].includes(o?.kind) || !Number.isSafeInteger(o.at)) throw new core.IllegalArgumentError("a schedule needs a command ID, pause or resume and a time");
		return this.commit(runs => {
			const r = Object.hasOwn(runs, runId) ? runs[runId] : undefined;
			if (!r) throw new core.IllegalArgumentError(`unknown run ${runId}`);
			r.schedules ??= [];
			if (o.cancel) r.schedules = r.schedules.filter(x => x.id !== commandId);
			else if (!r.schedules.some(x => x.id === commandId)) {
				if (r.schedules.length >= 16) throw new core.ResourceExhausted("at most 16 schedules per run");
				r.schedules.push({ id: commandId, kind: o.kind, at: o.at });
				r.schedules.sort((a, b) => a.at - b.at);
			}
			return { runId, schedules: core.plain(r.schedules) };
		});
	}
	/** Issues due schedules (called by the server loop through `advance`). */
	private async dueSchedules(runId: string): Promise<void> {
		const now = this.now();
		const due = await this.commit(runs => { const r = runs[runId]; return r && !r.pending && !r.recovery ? core.plain((r.schedules ?? []).filter(x => x.at <= now)) : []; });
		for (const s of due) {
			await this.commit(runs => { const r = runs[runId]!; r.schedules = (r.schedules ?? []).filter(x => x.id !== s.id); });
			try { await this.transition(s.id, runId, s.kind); }
			catch (e) { if (!(e instanceof core.IllegalArgumentError || e instanceof core.TransactionError)) throw e; } // not applicable now: dropped
			return;
		}
	}

	/**
	 * Result export of a run: completeness against the manifest, missing tasks, a manifest hash and a result hash.
	 * A partial result is reported as such; the export never changes the run.
	 */
	async export(runId: string): Promise<{ runId: string; kind: string; state: RunStatus; manifestHash: string; complete: boolean; expected: number; found: number; missing: string[]; resultHash: string; summary: core.Json }> {
		const view = await this.status(runId);
		if (!view) throw new core.IllegalArgumentError(`unknown run ${runId}`);
		const spec = await this.commit(runs => core.plain(runs[runId]!.spec));
		const exporter = this.o.exporters?.[spec.kind];
		if (!exporter || !this.o.space) throw new core.IllegalArgumentError(`no exporter for run kind ${spec.kind}`);
		const r = await exporter(spec, this.o.space);
		return { runId, kind: spec.kind, state: view.state, manifestHash: hashOf({ runId, kind: spec.kind, config: spec.config, members: spec.members } as unknown as core.Json), ...r, missing: r.missing.slice(0, 50) };
	}
}

/** A Member in this host's own store. `prepare` writes the run's tasks; the gate exists before it is called. */
export function localRunMember(host: SpaceHost, ctx: Context, spaceId: string, prepare: (run: RunSpec, space: string) => Promise<void>, now: () => number = Date.now): RunMember {
	const gate = (command: core.RunGateCommand) => host.commit(async tx => core.applyRunGate(await spaceDoc(tx, spaceId, now()), now(), command), ctx);
	return {
		spaceId,
		gate,
		recover: (runId, recoveryId) => host.commit(async tx => core.recoverRunGate(await spaceDoc(tx, spaceId, now()), now(), { runId, recoveryId }), ctx),
		async prepare(run, command) {
			const [ack, open] = await host.commit(async tx => {
				const s = await spaceDoc(tx, spaceId, now()), ack = core.applyRunGate(s, now(), command);
				return [ack, core.runGateView(s, run.runId)?.state === "preparing"] as const;
			}, ctx);
			if (open) await prepare(run, spaceId); // a replay after release has nothing left to write
			return ack;
		},
	};
}

/**
 * Admin commands for the control-space supervisor: startRun, pauseRun, resumeRun, stopRun, reconcileRun and
 * resolveRunRecovery. A refusal becomes a
 * failed result; only unexpected errors make the supervisor retry the same job.
 */
export function runCommands(runs: RunController): Record<"startRun" | "pauseRun" | "resumeRun" | "stopRun" | "reconcileRun" | "resolveRunRecovery" | "listRuns" | "runStatus" | "scheduleRun" | "exportRun", (commandId: string, args: Record<string, core.Json>) => Promise<core.Json>> {
	const wrap = (f: (id: string, args: Record<string, core.Json>) => Promise<RunView>) => async (id: string, args: Record<string, core.Json>): Promise<core.Json> => {
		try { return (await f(id, args)) as unknown as core.Json; }
		catch (e) { if (e instanceof core.IllegalArgumentError || e instanceof core.TransactionError || e instanceof core.LimitError) return { phase: "failed", error: e.message }; throw e; }
	};
	const run = (args: Record<string, core.Json>) => String(args.runId ?? "");
	// `dryRun: true` answers with a preview instead of journaling the command.
	const or = (kind: "start" | "pause" | "resume" | "stop", f: (id: string, a: Record<string, core.Json>) => Promise<RunView>) => async (id: string, a: Record<string, core.Json>): Promise<core.Json> =>
		a.dryRun === true ? { dryRun: true, ...(await runs.preview(kind, run(a), kind === "start" ? { runId: run(a), kind: String(a.kind ?? ""), config: a.config ?? null, members: a.members as string[] } : undefined)) } as unknown as core.Json : wrap(f)(id, a);
	return {
		startRun: or("start", (id, a) => runs.start(id, { runId: run(a), kind: String(a.kind ?? ""), config: a.config ?? null, members: a.members as string[] })),
		pauseRun: or("pause", (id, a) => runs.pause(id, run(a))),
		resumeRun: or("resume", (id, a) => runs.resume(id, run(a))),
		stopRun: or("stop", (id, a) => runs.stop(id, run(a))),
		reconcileRun: wrap((id, a) => runs.reconcile(id, run(a), String(a.recoveryId ?? ""), a.members ? { kind: String(a.kind ?? ""), members: a.members as string[] } : undefined)),
		resolveRunRecovery: wrap((id, a) => runs.resolve(id, run(a), { expectedViewHash: String(a.expectedViewHash ?? ""), decision: a.decision as Decision })),
		// Read-only views for admins; they change nothing.
		listRuns: async (_id, a) => (await runs.list(Number(a.limit ?? 50))) as unknown as core.Json,
		runStatus: async (_id, a) => ((await runs.status(run(a))) ?? { phase: "failed", error: `unknown run ${run(a)}` }) as unknown as core.Json,
		scheduleRun: wrap(async (id, a) => (await runs.schedule(String(a.scheduleId ?? id), run(a), { kind: a.kind as "pause" | "resume", at: Number(a.at), cancel: a.cancel === true })) as unknown as RunView),
		exportRun: wrap(async (_id, a) => (await runs.export(run(a))) as unknown as RunView),
	};
}
