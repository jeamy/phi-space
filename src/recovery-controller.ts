// A durable single-space recovery state machine. Only the private recovery service receives this capability.
import { defineDoc, type Session } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { canonicalJson, digestJson } from "./canonical.ts";
import { Registry, spaceDoc, snapshotSpace } from "./spaces.ts";
import { beginRestore, restoreBatch, completeRestore, releaseRestored, snapshotHash } from "./restore.ts";
import type { RecoveryRegister } from "./recovery-register.ts";
import { RegisterConflict } from "./recovery-register.ts";
import { RecoveryBlocked } from "./recovery.ts";
import type { HostBootState, SpaceBootPermit } from "./boot.ts";
import * as core from "./core.ts";

export type DataRestoreRequest = { recoveryId: string; space: string; snapshotRef: string; targetHostId: string; expectedDataIncarnation: string; expectedPrimaryEpoch: number };
export type RecoveryJob = { request: DataRestoreRequest; sourceHostId: string; argsHash: string; snapshotHash: string; state: "blocked" | "importing" | "waiting" | "installing" | "completed"; priorPermit: SpaceBootPermit; incarnation?: string; primaryEpoch?: number; error?: string };
export const RecoveryJobs = defineDoc<{ jobs: Record<string, RecoveryJob>; releases: Record<string, { hash: string; count: number; completed: boolean }> }>({ kind: "phi-spaces.recovery-jobs", version: 1, scope: "session", initial: () => ({ jobs: {}, releases: {} }) });
type RawHost = Pick<Session, "commit" | "snapshot">;
export type RecoveryControllerOptions = {
	host: RawHost; ctx: Context; hostId: string; authorityId: string;
	/** Writable operator capability. Never handed to the normal space service. */
	external: RecoveryRegister; installed: RecoveryRegister;
	loadSnapshot: (reference: string) => Promise<core.SpaceState>;
	verifyFence: (oldHostId: string) => Promise<{ hostId: string; restartLocked: boolean }>;
	/** Records the new tuple on the control primary and must return its durable receipt. */
	acknowledgeControl: (job: RecoveryJob) => Promise<{ recoveryId: string; space: string; incarnation: string; primaryEpoch: number; authorityId: string }>;
	now?: () => number;
};
export class RecoveryController {
	private o: RecoveryControllerOptions;
	constructor(o: RecoveryControllerOptions) { this.o = o; }
	private reserve(s: core.SpaceState, record: unknown, now: number) { const bytes = Buffer.byteLength(JSON.stringify(record)) + 512; if (!core.maintenanceStep(s, bytes, now, "recovery-journal")) throw new core.ResourceExhausted("recovery metadata exceeds the commit budget"); }
	private now = () => (this.o.now ?? Date.now)();
	private async job(id: string): Promise<RecoveryJob> { const job = (await this.o.host.snapshot(RecoveryJobs, this.o.ctx))?.jobs[id]; if (!job) throw new RecoveryBlocked("unknown recovery request"); return core.plain(job); }
	async submit(request: DataRestoreRequest): Promise<RecoveryJob> {
		if (![request.recoveryId, request.space, request.snapshotRef, request.targetHostId, request.expectedDataIncarnation].every(v => typeof v === "string" && v.length > 0 && v.length <= 512) || request.recoveryId.length > 256 || request.targetHostId !== this.o.hostId || !Number.isSafeInteger(request.expectedPrimaryEpoch) || request.expectedPrimaryEpoch < 0) throw new RecoveryBlocked("invalid recovery request or target");
		const argsHash = digestJson(request);
		const existing = (await this.o.host.snapshot(RecoveryJobs, this.o.ctx))?.jobs[request.recoveryId];
		if (existing) { if (existing.argsHash !== argsHash) throw new RegisterConflict("recovery id has different arguments"); return core.plain(existing); }
		const source = await this.o.loadSnapshot(request.snapshotRef);
		if (source.spaceId !== request.space) throw new RecoveryBlocked("snapshot belongs to another space");
		const boot = await this.o.external.get<HostBootState & Record<string, core.Json>>(`boot:${this.o.hostId}`), permit = boot?.value.spaces[request.space];
		if (!boot || !permit || permit.authorityId !== this.o.authorityId || permit.dataIncarnation !== request.expectedDataIncarnation || (permit.primaryEpoch ?? 1) !== request.expectedPrimaryEpoch || permit.durability === "sync") throw new RecoveryBlocked("restore needs matching single-space boot configuration; sync requires promotion");
		const placement = await this.o.external.get<any>(`placement:${request.space}`);
		if (!placement || placement.value.authorityId !== this.o.authorityId || placement.value.incarnation !== request.expectedDataIncarnation || (placement.value.primaryEpoch ?? 1) !== request.expectedPrimaryEpoch || typeof placement.value.hostId !== "string") throw new RecoveryBlocked("independent placement disagrees with expected source");
		const sourceHostId = placement.value.hostId as string, proof = await this.o.verifyFence(sourceHostId);
		if (!proof.restartLocked || proof.hostId !== sourceHostId) throw new RecoveryBlocked("independent fencing with restart lock required");
		const transitionKey = `data-transition:${request.space}`, prior = await this.o.external.get<any>(transitionKey);
		if (prior && prior.value.argsHash !== argsHash && prior.value.state !== "completed") throw new RegisterConflict("another space transition is active");
		const job: RecoveryJob = { request, sourceHostId, argsHash, snapshotHash: snapshotHash(source), state: "blocked", priorPermit: core.plain(permit) };
		const target = await snapshotSpace(this.o.host, request.space, this.o.ctx);
		if (!target || target.incarnation !== request.expectedDataIncarnation || (target.primaryEpoch ?? 1) !== request.expectedPrimaryEpoch) throw new RecoveryBlocked("target space is not provisioned with the expected tuple");
		if (Buffer.byteLength(JSON.stringify(job)) + 1536 > core.limitsOf(target).maxCommitBytes) throw new core.ResourceExhausted("recovery journal cannot fit the current commit budget");
		if (prior?.value.argsHash !== argsHash) await this.o.external.compareAndSet(transitionKey, prior?.version ?? null, { argsHash, recoveryId: request.recoveryId, expectedDataIncarnation: request.expectedDataIncarnation, targetHostId: request.targetHostId, sourceHostId, authorityId: this.o.authorityId, state: "restoring" });
		// Revoke admission before any import. Retrying a lost response observes the same transition and revoked tuple.
		if (permit.state !== "revoked") await this.o.external.compareAndSet(`boot:${this.o.hostId}`, boot.version, { ...boot.value, spaces: { ...boot.value.spaces, [request.space]: { ...permit, state: "revoked" } } } as any);
		await this.o.host.commit(async tx => { const s = await spaceDoc(tx, request.space, this.now()); this.reserve(s, job, this.now()); const jobs = await tx.doc(RecoveryJobs); const old = jobs.jobs[request.recoveryId]; if (old && old.argsHash !== argsHash) throw new RegisterConflict("recovery id conflict"); jobs.jobs[request.recoveryId] ??= job; }, this.o.ctx);
		return this.job(request.recoveryId);
	}
	async advance(id: string): Promise<RecoveryJob> {
		const job = await this.job(id), now = this.now();
		if (job.state === "completed") return job;
		const transitionBefore = await this.o.external.get<any>(`data-transition:${job.request.space}`);
		if (!transitionBefore || transitionBefore.value.argsHash !== job.argsHash) throw new RecoveryBlocked("independent transition changed or is unavailable");
		const proof = await this.o.verifyFence(job.sourceHostId);
		if (!proof.restartLocked || proof.hostId !== job.sourceHostId) throw new RecoveryBlocked("source host fencing no longer verified");
		if (["blocked", "importing"].includes(job.state)) {
			const source = await this.o.loadSnapshot(job.request.snapshotRef);
			if (snapshotHash(source) !== job.snapshotHash) throw new RecoveryBlocked("snapshot changed during recovery");
			await this.o.host.commit(async tx => {
				const jobs = await tx.doc(RecoveryJobs), current = jobs.jobs[id]!;
				if (!["blocked", "importing"].includes(current.state)) return;
				const s = await spaceDoc(tx, job.request.space, now); this.reserve(s, current, now);
				if (current.state === "blocked") {
					const restored = beginRestore(s, now, { recoveryId: id, expectedDataIncarnation: job.request.expectedDataIncarnation, expectedPrimaryEpoch: job.request.expectedPrimaryEpoch, snapshotHash: job.snapshotHash, kind: "data" });
					(await tx.doc(Registry)).spaces[job.request.space]!.incarnation = restored.incarnation;
					current.incarnation = restored.incarnation; current.primaryEpoch = restored.primaryEpoch; current.state = "importing";
				}
				const before = `${s.restore!.stage}:${s.restore!.cursor}`;
				const state = restoreBatch(s, now, source); if (`${state.stage}:${state.cursor}` === before) throw new core.ResourceExhausted("next restore item cannot fit together with the recovery journal; increase the administrative commit budget");
				if (state.stage === "waiting") current.state = "waiting";
			}, this.o.ctx);
			return this.job(id);
		}
		const s = await snapshotSpace(this.o.host, job.request.space, this.o.ctx);
		if (!s?.restore || s.restore.recoveryId !== id || s.incarnation !== job.incarnation || s.primaryEpoch !== job.primaryEpoch || !job.incarnation || job.primaryEpoch === undefined) throw new RecoveryBlocked("restore state was lost or changed");
		const published = await this.o.external.get<any>(`data-transition:${job.request.space}`);
		if (!published || published.value.argsHash !== job.argsHash || published.value.incarnation && (published.value.incarnation !== job.incarnation || published.value.primaryEpoch !== job.primaryEpoch)) throw new RecoveryBlocked("published recovery tuple changed");
		if (!published.value.incarnation) await this.o.external.compareAndSet(`data-transition:${job.request.space}`, published.version, { ...published.value, incarnation: job.incarnation, primaryEpoch: job.primaryEpoch });
		const ack = await this.o.acknowledgeControl(job);
		if (ack.recoveryId !== id || ack.space !== job.request.space || ack.incarnation !== job.incarnation || ack.primaryEpoch !== job.primaryEpoch || ack.authorityId !== this.o.authorityId) throw new RecoveryBlocked("control acknowledgement disagrees with restored tuple");
		if (now < s.restore.waitUntil) return job;
		await this.o.host.commit(async tx => { const state = await spaceDoc(tx, job.request.space, now); this.reserve(state, job, now); (await tx.doc(RecoveryJobs)).jobs[id]!.state = "installing"; completeRestore(state, now, id); }, this.o.ctx);
		const permit: SpaceBootPermit = { ...job.priorPermit, state: "active", dataIncarnation: job.incarnation, primaryEpoch: job.primaryEpoch, transitionId: id };
		const localKey = `installed:${this.o.hostId}:${job.request.space}`, local = await this.o.installed.get<any>(localKey);
		if (canonicalJson(local?.value ?? null) !== canonicalJson(permit as any)) await this.o.installed.compareAndSet(localKey, local?.version ?? null, permit as any);
		const boot = await this.o.external.get<HostBootState & Record<string, core.Json>>(`boot:${this.o.hostId}`);
		if (!boot || boot.value.state !== "active") throw new RecoveryBlocked("host remains fenced or quarantined");
		const current = boot.value.spaces[job.request.space];
		if (current?.transitionId === id && current.state === "active" && canonicalJson(current as any) !== canonicalJson(permit as any)) throw new RecoveryBlocked("external active tuple disagrees with restored tuple");
		if (current?.transitionId !== id || current.state !== "active") {
			if (!current || current.dataIncarnation !== job.request.expectedDataIncarnation || current.state !== "revoked") throw new RecoveryBlocked("external space tuple changed during restore");
			await this.o.external.compareAndSet(`boot:${this.o.hostId}`, boot.version, { ...boot.value, spaces: { ...boot.value.spaces, [job.request.space]: permit } } as any);
		}
		const transition = await this.o.external.get<any>(`data-transition:${job.request.space}`);
		if (!transition || transition.value.argsHash !== job.argsHash) throw new RecoveryBlocked("external recovery transition changed");
		if (transition.value.state !== "completed") await this.o.external.compareAndSet(`data-transition:${job.request.space}`, transition.version, { ...transition.value, state: "completed", incarnation: job.incarnation, primaryEpoch: job.primaryEpoch });
		const placement = await this.o.external.get<any>(`placement:${job.request.space}`);
		if (!placement || placement.value.authorityId !== this.o.authorityId || ![job.request.expectedDataIncarnation, job.incarnation].includes(placement.value.incarnation)) throw new RecoveryBlocked("independent placement changed during restore");
		if (placement.value.incarnation !== job.incarnation) await this.o.external.compareAndSet(`placement:${job.request.space}`, placement.version, { ...placement.value, hostId: this.o.hostId, incarnation: job.incarnation, primaryEpoch: job.primaryEpoch, recoveryId: id });
		await this.o.host.commit(async tx => { this.reserve(await spaceDoc(tx, job.request.space, now), job, now); (await tx.doc(RecoveryJobs)).jobs[id]!.state = "completed"; }, this.o.ctx);
		return this.job(id);
	}
	async status(id: string): Promise<RecoveryJob> { return this.job(id); }
	async release(request: { commandId: string; recoveryId: string; scope: { type?: string; runId?: string; entryIds?: string[] } }): Promise<{ count: number; completed: boolean }> {
		if (!request.scope || typeof request.scope !== "object" || Array.isArray(request.scope) || (request.scope.type !== undefined && (typeof request.scope.type !== "string" || !request.scope.type)) || (request.scope.runId !== undefined && (typeof request.scope.runId !== "string" || !request.scope.runId)) || (request.scope.entryIds !== undefined && (!Array.isArray(request.scope.entryIds) || request.scope.entryIds.length > 10000 || !request.scope.entryIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 512)))) throw new RecoveryBlocked("invalid restore release scope");
		if (typeof request.commandId !== "string" || !request.commandId || request.commandId.length > 256) throw new RecoveryBlocked("invalid release command identity");
		const job = await this.job(request.recoveryId); if (job.state !== "completed") throw new RecoveryBlocked("restore has not completed");
		const bootKey = `boot:${this.o.hostId}`, localKey = `installed:${this.o.hostId}:${job.request.space}`;
		const boot = await this.o.external.get<any>(bootKey), local = await this.o.installed.get<any>(localKey), permit = boot?.value.spaces[job.request.space];
		if (!local || boot?.value.state !== "active" || !permit || permit.state !== "active" || permit.authorityId !== this.o.authorityId || permit.dataIncarnation !== job.incarnation || permit.primaryEpoch !== job.primaryEpoch || canonicalJson(permit) !== canonicalJson(local?.value ?? null)) throw new RecoveryBlocked("release requires matching current external and local boot authorization");
		const hash = digestJson(request);
		return this.o.host.commit(async tx => {
			const jobs = await tx.doc(RecoveryJobs), prior = jobs.releases[request.commandId];
			if (prior && prior.hash !== hash) throw new RegisterConflict("release command has different arguments");
			if (prior?.completed) return { count: prior.count, completed: true };
			const s = await spaceDoc(tx, job.request.space, this.now()); this.reserve(s, { commandId: request.commandId, hash, count: prior?.count ?? 0, completed: false }, this.now());
			const count = releaseRestored(s, this.now(), request.recoveryId, request.scope);
			const remaining = s.entries.some(e => e.restoredUnverified && (!request.scope.type || e.types.includes(request.scope.type)) && (!request.scope.runId || e.fields.runId === request.scope.runId) && (!request.scope.entryIds || request.scope.entryIds.includes(e.id)));
			const record = { hash, count: (prior?.count ?? 0) + count, completed: !remaining }; jobs.releases[request.commandId] = record;
			if ((await this.o.external.get(bootKey))?.version !== boot.version || (await this.o.installed.get(localKey))?.version !== local.version) throw new RecoveryBlocked("boot authorization changed during release");
			return { count: record.count, completed: record.completed };
		}, this.o.ctx);
	}
}

/** Bind only data-recovery methods to the signed private service. No arbitrary host commits or normal space methods. */
export function dataRecoveryHandler(controller: RecoveryController): import("./recovery-service.ts").RecoveryHandler {
	return async call => {
		const args = call.args;
		if (!args || typeof args !== "object" || Array.isArray(args)) throw new RecoveryBlocked("recovery arguments must be an object");
		if (call.method === "restoreDataSpace") return await controller.submit(args as unknown as DataRestoreRequest) as unknown as core.Json;
		if (["advanceRestore", "restoreStatus"].includes(call.method)) {
			if (typeof args.recoveryId !== "string" || !args.recoveryId) throw new RecoveryBlocked("recovery identity required");
			return await (call.method === "advanceRestore" ? controller.advance(args.recoveryId) : controller.status(args.recoveryId)) as unknown as core.Json;
		}
		if (call.method === "releaseRestored") return await controller.release(args as any) as unknown as core.Json;
		throw new RecoveryBlocked("method is not supported by the data recovery endpoint");
	};
}
