// Space lifecycle (docs/betrieb-und-mobile-steuerung.md §5, §7.3, §8 B7): idempotent creation, archiving and checked
// deletion of named Spaces on their own host. Creation reuses an existing alias (project start reuses Spaces).
// Archiving keeps the data readable and refuses new work. Deletion needs an archived, empty Space that is no
// federation Member and retains no claims or mailbox results; its spaceId stays reserved as a tombstone.
// The control host sends signed instructions; each host verifies them against the pinned control key.
import type { Context } from "./context.ts";
import { defineDoc } from "./store/documents.ts";
import { diskMapOf } from "./store/types.ts";
import type { Algorithm, Signer } from "./auth.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import type { SpaceHost } from "./client.ts";
import { verifyDetached } from "./grants.ts";
import { CONTROL_SPACE } from "./enroll.ts";
import { DEFAULT_ALIAS, Registry, createSpace, spaceDoc, type SpaceInfo } from "./spaces.ts";
import * as core from "./core.ts";

export type SpaceAction = "create" | "archive" | "reactivate" | "delete";
export type SpaceLifecycleRequest = { commandId: string; action: SpaceAction; alias?: string; spaceId?: string; limits?: Partial<core.Limits>; profiles?: core.CompletionProfile[] };
export type SpaceLifecycleResult = { commandId: string; action: SpaceAction; spaceId: string; alias: string; state: "active" | "archived" | "deleted"; existed?: boolean };
/** A lifecycle step that is refused because the Space still holds data, work or references. */
export class SpaceInUse extends core.TransactionError {}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const hashOf = digestJson;
export const SpaceLifecycleJournal = defineDoc<{ commands: Record<string, { hash: string; result: SpaceLifecycleResult }> }>({
	kind: "phi-spaces.space-lifecycle", version: 1, scope: "session", initial: () => ({ commands: {} }),
});

function why(s: Readonly<core.SpaceState>, now: number): string | undefined {
	if (s.membership && s.membership.state !== "detached") return `it is a federation Member (${s.membership.state}); removeMember first`;
	if (s.entries.length) return `it still holds ${s.entries.length} entries; export and purge them first`;
	if (Object.keys(s.txns).length || s.waiters.length || s.regs.length || (s.jobs ?? []).length || (s.releaseQueue ?? []).length) return "it still has open transactions, waits, registrations or follow-up work";
	const disk = diskMapOf(s.rpc?.claims);
	if ((disk ? disk.any() : Object.keys(s.rpc?.claims ?? {}).length) || Object.keys(s.restoredClaims ?? {}).length) return "it retains request claims until their results expire";
	if (Object.values(s.mailboxes?.boxes ?? {}).some(b => b.events.length)) return "mailboxes still hold undelivered results";
	if (Object.values(s.runGates ?? {}).some(g => g.state !== "stopped" || g.recovery)) return "a run on it is not stopped";
	if (s.restore && s.restore.stage !== "completed") return "a restore is in progress";
	void now;
	return undefined;
}

/** Host side: applies lifecycle requests to this host's own Spaces, idempotently per command ID. */
export class SpaceLifecycle {
	private o: { host: SpaceHost; ctx: Context; now?: () => number };
	constructor(o: SpaceLifecycle["o"]) { this.o = o; }
	async apply(q: SpaceLifecycleRequest): Promise<SpaceLifecycleResult> {
		if (!q || !ID.test(q.commandId) || !["create", "archive", "reactivate", "delete"].includes(q.action)) throw new core.IllegalArgumentError("invalid Space lifecycle request");
		if (q.action === "create" ? typeof q.alias !== "string" : typeof q.spaceId !== "string") throw new core.IllegalArgumentError(q.action === "create" ? "create needs an alias" : `${q.action} needs a spaceId`);
		const hash = hashOf({ action: q.action, alias: q.alias ?? null, spaceId: q.spaceId ?? null, limits: q.limits ?? null, profiles: q.profiles ?? null });
		return this.o.host.commit(async tx => {
			const j = await tx.doc(SpaceLifecycleJournal), old = j.commands[q.commandId];
			if (old) { if (old.hash !== hash) throw new core.IllegalArgumentError("command ID was used for another lifecycle request"); return core.plain(old.result); }
			if (Object.keys(j.commands).length >= 4096) throw new core.ResourceExhausted("lifecycle journal is full");
			const now = (this.o.now ?? Date.now)(), r = await tx.doc(Registry);
			let result: SpaceLifecycleResult;
			if (q.action === "create") {
				const existed = Object.hasOwn(r.aliases, q.alias!);
				const info = await createSpace(tx, q.alias!, now);
				const s = await spaceDoc(tx, info.spaceId, now);
				if (existed && s.archived) throw new core.RunGateConflict(`alias ${q.alias} names an archived Space; reactivate it instead`);
				if (!existed) { if (q.limits) core.setLimits(s, q.limits, now); if (q.profiles) core.setCompletionProfiles(s, q.profiles, now); }
				else if ((q.limits && canonicalJson(core.limitsOf(s) as any) !== canonicalJson({ ...core.limitsOf(s), ...q.limits } as any)) || (q.profiles && canonicalJson((s.completionProfiles ?? []) as any) !== canonicalJson(q.profiles as any))) throw new core.RunGateConflict(`Space ${q.alias} exists with other limits or profiles; it is reused only unchanged`);
				result = { commandId: q.commandId, action: "create", spaceId: info.spaceId, alias: info.alias, state: "active", ...(existed ? { existed: true } : {}) };
			} else {
				const info: SpaceInfo | undefined = r.spaces[q.spaceId!];
				if (!info || info.deletedAt) throw new core.IllegalArgumentError(`no Space ${q.spaceId} on this host`);
				if (info.spaceId === r.defaultSpaceId || info.alias === DEFAULT_ALIAS || info.alias === CONTROL_SPACE) throw new core.PermissionError("the default and the control Space have no lifecycle");
				const s = await spaceDoc(tx, info.spaceId, now);
				core.settle(s, now);
				if (q.action === "archive") {
					if (!s.archived) {
						const reason = s.membership && s.membership.state !== "detached" ? `it is a federation Member (${s.membership.state}); removeMember first` : Object.keys(s.txns).length ? "it has open transactions" : Object.values(s.runGates ?? {}).some(g => g.state !== "stopped") ? "a run on it is not stopped" : undefined;
						if (reason) throw new SpaceInUse(`cannot archive: ${reason}`);
						s.archived = { at: now, commandId: q.commandId }; core.touch(s, now);
					}
					result = { commandId: q.commandId, action: "archive", spaceId: info.spaceId, alias: info.alias, state: "archived" };
				} else if (q.action === "reactivate") {
					if (s.archived) { delete s.archived; core.touch(s, now); }
					result = { commandId: q.commandId, action: "reactivate", spaceId: info.spaceId, alias: info.alias, state: "active" };
				} else {
					if (!s.archived) throw new SpaceInUse("cannot delete: archive the Space first");
					const reason = why(s, now);
					if (reason) throw new SpaceInUse(`cannot delete: ${reason}`);
					delete r.aliases[info.alias];
					r.spaces[info.spaceId] = { ...info, deletedAt: now };
					result = { commandId: q.commandId, action: "delete", spaceId: info.spaceId, alias: info.alias, state: "deleted" };
				}
			}
			j.commands[q.commandId] = { hash, result };
			return core.plain(result);
		}, this.o.ctx);
	}
}

export type SignedLifecycle<T> = { value: T; issuer: string; algorithm: Algorithm; signature: string };
export type LifecyclePin = { issuer: string; algorithm: Algorithm; publicKey: string };
export type SpaceLifecycleInstruction = SpaceLifecycleRequest & { authorityId: string; hostId: string };
const bytes = (kind: "instruction" | "result", v: unknown) => Buffer.from(`phi-spaces/space-lifecycle-${kind}/v1\n` + canonicalJson(v as core.Json));
export async function signLifecycle<T>(kind: "instruction" | "result", value: T, issuer: string, signer: Signer): Promise<SignedLifecycle<T>> {
	return { value: core.plain(value), issuer, algorithm: signer.algorithm, signature: Buffer.from(await signer.sign(bytes(kind, value))).toString("base64") };
}
export function verifyLifecycle<T>(kind: "instruction" | "result", t: SignedLifecycle<T>, pin: LifecyclePin): T {
	if (!t || typeof t !== "object" || t.issuer !== pin.issuer || t.algorithm !== pin.algorithm || typeof t.signature !== "string" || !verifyDetached(pin.algorithm, pin.publicKey, bytes(kind, t.value), t.signature)) throw new core.PermissionError(`invalid Space lifecycle ${kind} signature`);
	return core.plain(t.value);
}

/** Host side of the wire: verifies the control signature and binding, applies locally, signs the result. */
export class SpaceLifecycleService {
	private o: { lifecycle: SpaceLifecycle; hostId: string; authorityId: string; peerId: string; signer: Signer; controlPin: LifecyclePin; assertAuthority: () => Promise<void> };
	constructor(o: SpaceLifecycleService["o"]) { this.o = o; }
	async apply(t: SignedLifecycle<SpaceLifecycleInstruction>): Promise<SignedLifecycle<SpaceLifecycleResult>> {
		const q = verifyLifecycle("instruction", t, this.o.controlPin);
		if (q.authorityId !== this.o.authorityId || q.hostId !== this.o.hostId) throw new core.PermissionError("Space lifecycle instruction belongs to another authority or host");
		await this.o.assertAuthority();
		const { authorityId: _a, hostId: _h, ...request } = q;
		const result = await this.o.lifecycle.apply(request);
		await this.o.assertAuthority();
		return signLifecycle("result", result, this.o.peerId, this.o.signer);
	}
}

/** Control side: the admin commands createSpace, archiveSpace, reactivateSpace and deleteSpace for a target host. */
export function spaceCommands(o: { authorityId: string; peerId: string; signer: Signer; hostPin: (hostId: string) => Promise<LifecyclePin>; send: (hostId: string, t: SignedLifecycle<SpaceLifecycleInstruction>) => Promise<SignedLifecycle<SpaceLifecycleResult>> }): Record<"createSpace" | "archiveSpace" | "reactivateSpace" | "deleteSpace", (commandId: string, args: Record<string, core.Json>) => Promise<core.Json>> {
	const run = (action: SpaceAction) => async (commandId: string, a: Record<string, core.Json>): Promise<core.Json> => {
		const hostId = String(a.hostId ?? "");
		const q: SpaceLifecycleInstruction = { commandId, action, authorityId: o.authorityId, hostId, ...(action === "create" ? { alias: String(a.alias ?? "") } : { spaceId: String(a.spaceId ?? "") }), ...(a.limits ? { limits: a.limits as Partial<core.Limits> } : {}), ...(a.profiles ? { profiles: a.profiles as unknown as core.CompletionProfile[] } : {}) };
		let reply: SignedLifecycle<SpaceLifecycleResult>;
		try { reply = await o.send(hostId, await signLifecycle("instruction", q, o.peerId, o.signer)); }
		catch (e) {
			// Refusals by the host are results; an unreachable host stays "applying" and the supervisor retries.
			const m = String((e as Error)?.message ?? e);
			if (/cannot (archive|delete)|IllegalArgument|invalid|no Space|exists with other|names an archived|have no lifecycle|another authority|was used for another/.test(m)) return { phase: "failed", error: m.slice(0, 512) };
			throw e;
		}
		const result = verifyLifecycle("result", reply, await o.hostPin(hostId));
		if (result.commandId !== commandId || result.action !== action) throw new core.PermissionError("Space lifecycle result does not match the command");
		return result as unknown as core.Json;
	};
	return { createSpace: run("create"), archiveSpace: run("archive"), reactivateSpace: run("reactivate"), deleteSpace: run("delete") };
}
