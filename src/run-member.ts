// Remote run Members (docs/betrieb-und-mobile-steuerung.en.md §8 B4). The run controller signs every RunGate command;
// the Member host verifies it against the pinned controller key, applies it to its own Space and signs the ACK.
// The signature authorizes the effect, not the transport: a relayed or replayed instruction changes nothing new,
// because the gate answers a repeated command with its stored confirmation.
import type { Context } from "./context.ts";
import { canonicalJson } from "./canonical.ts";
import type { Algorithm, Signer } from "./auth.ts";
import type { SpaceHost } from "./client.ts";
import { signatureOf, signedBy } from "./grants.ts";
import { listSpaces, spaceDoc } from "./spaces.ts";
import { localRunMember, type RunMember, type RunSpec } from "./run-controller.ts";
import * as core from "./core.ts";

/** The wire code of a refused run gate instruction: the class kept, as `RemoteSpace` turns it back (a conflict stays a
 *  `TransactionError`, a bad instruction an `IllegalArgumentError`), so the run controller fails the command instead of
 *  retrying it. What has no class of its own (no run gates here, a missing proof) stays `PermissionDenied`. */
export function runGateRefusal(e: unknown): { code: string; message: string } {
	const message = e instanceof Error ? e.message : String(e);
	const code = e instanceof core.PermissionError ? "PermissionDenied" : e instanceof core.LimitError ? "ResourceExhausted" : e instanceof core.CompletionViolation ? "CompletionViolation"
		: e instanceof core.TransactionError ? "TransactionError" : e instanceof core.UniqueConflict ? "UniqueConflict" : e instanceof core.IllegalArgumentError || e instanceof TypeError ? "BadRequest" : "PermissionDenied";
	return { code, message };
}

/** How long a signed recovery instruction holds: a fence that a captured one could set again must not outlive its reason. */
export const RECOVER_TTL_MS = 60_000;
/** A gate command, or `kind: "recover"` (revision 0, commandId = recoveryId) for the recovery fence and view. */
export type RunGateInstruction = (core.RunGateCommand | { runId: string; commandId: string; kind: "recover"; revision: 0; recoveryId: string; expiresAt: number }) & { authorityId: string; spaceId: string; spec?: RunSpec };
export type SignedRun<T> = { value: T; issuer: string; algorithm: Algorithm; signature: string };
export type RunPin = { issuer: string; algorithm: Algorithm; publicKey: string };
/** Registered host code that writes a run's tasks while its gate is preparing. Never a shell command. */
export type RunPreparer = (run: RunSpec, spaceId: string) => Promise<void>;

const bytes = (kind: "instruction" | "ack", v: unknown) => Buffer.from(`phi-spaces/run-gate-${kind}/v1\n` + canonicalJson(v as core.Json));
export async function signRun<T>(kind: "instruction" | "ack", value: T, issuer: string, signer: Signer): Promise<SignedRun<T>> {
	return { value: core.plain(value), issuer, algorithm: signer.algorithm, signature: await signatureOf(signer, bytes(kind, value)) };
}
export function verifyRun<T>(kind: "instruction" | "ack", t: SignedRun<T>, pin: RunPin): T {
	if (!signedBy(t, pin, bytes(kind, t?.value))) throw new core.PermissionError(`invalid run gate ${kind} signature`);
	return core.plain(t.value);
}

/** The preparer of a configured host (`runGates`): the tasks a run's own manifest names, each bound to the run. Idempotent. */
export const tasksPreparer = (host: SpaceHost, ctx: Context, now: () => number = Date.now): RunPreparer => async (run, spaceId) => {
	const tasks = (run.config as { tasks?: Array<{ type: string; fields?: core.Fields }> } | null)?.tasks;
	if (!Array.isArray(tasks) || tasks.length > 64) throw new core.IllegalArgumentError("a tasks run names at most 64 tasks");
	await host.commit(async tx => {
		const s = await spaceDoc(tx, spaceId, now());
		for (const t of tasks) {
			const fields = { ...t.fields, runId: run.runId };
			if (!core.count(s, now(), { type: t.type, fields })) core.write(s, now(), { type: t.type, fields }, null, core.FOREVER);
		}
	}, ctx);
};

/** The Member side: one per host, for every local Space that takes part in controlled runs. */
export class RunGateService {
	private o: { host: SpaceHost; ctx: Context; authorityId: string; peerId: string; signer: Signer; controllerPin: RunPin; preparers: Record<string, RunPreparer>; assertAuthority: () => Promise<void>; now?: () => number };
	constructor(o: RunGateService["o"]) { this.o = o; }
	async apply(t: SignedRun<RunGateInstruction>): Promise<SignedRun<core.RunGateAck | core.RunRecoveryView>> {
		const q = verifyRun("instruction", t, this.o.controllerPin);
		if (q.authorityId !== this.o.authorityId) throw new core.PermissionError("run gate instruction belongs to another authority");
		if (typeof q.spaceId !== "string" || !(await listSpaces(this.o.host, this.o.ctx)).some(i => i.spaceId === q.spaceId)) throw new core.IllegalArgumentError("run gate instruction names no local Space");
		if (q.kind === "recover") {
			if (typeof q.recoveryId !== "string") throw new core.IllegalArgumentError("recover needs a recovery ID");
			if (typeof q.expiresAt !== "number" || !(q.expiresAt > (this.o.now ?? Date.now)())) throw new core.PermissionError("this recovery instruction has expired");
			await this.o.assertAuthority();
			const view = await localRunMember(this.o.host, this.o.ctx, q.spaceId, async () => {}, this.o.now).recover(q.runId, q.recoveryId);
			await this.o.assertAuthority();
			return signRun("ack", view, this.o.peerId, this.o.signer);
		}
		const command: core.RunGateCommand = { runId: q.runId, commandId: q.commandId, kind: q.kind, revision: q.revision, ...(q.recoveryId !== undefined ? { recoveryId: q.recoveryId } : {}), ...(q.expect !== undefined ? { expect: q.expect } : {}) };
		let prepare: RunPreparer = async () => { throw new core.IllegalArgumentError("only prepare instructions carry a run"); };
		if (q.kind === "prepare") {
			const spec = q.spec;
			if (!spec || spec.runId !== q.runId || !Array.isArray(spec.members) || !spec.members.includes(q.spaceId)) throw new core.IllegalArgumentError("prepare needs the run's manifest including this Space");
			const registered = Object.hasOwn(this.o.preparers, spec.kind) ? this.o.preparers[spec.kind] : undefined;
			if (!registered) throw new core.IllegalArgumentError(`no registered preparer for run kind ${spec.kind}`);
			prepare = registered;
		}
		await this.o.assertAuthority();
		const member = localRunMember(this.o.host, this.o.ctx, q.spaceId, prepare, this.o.now);
		const ack = q.kind === "prepare" ? await member.prepare(q.spec!, command) : await member.gate(command);
		await this.o.assertAuthority();
		return signRun("ack", ack, this.o.peerId, this.o.signer);
	}
}

/** The controller side of a Member on another host; `send` carries the signed instruction (e.g. RemoteSpace.requestRunGate). */
export function remoteRunMember(o: { now?: () => number; spaceId: string; authorityId: string; peerId: string; signer: Signer; memberPin: RunPin; send: (t: SignedRun<RunGateInstruction>) => Promise<SignedRun<core.RunGateAck | core.RunRecoveryView>> }): RunMember {
	const call = async <T extends { spaceId: string | null }>(command: RunGateInstruction extends infer I ? Omit<I & {}, "authorityId" | "spaceId" | "spec"> : never, spec?: RunSpec): Promise<T> => {
		const q = { ...command, authorityId: o.authorityId, spaceId: o.spaceId, ...(spec ? { spec } : {}) } as RunGateInstruction;
		const ack = verifyRun("ack", await o.send(await signRun("instruction", q, o.peerId, o.signer)), o.memberPin) as unknown as T;
		if (ack.spaceId !== o.spaceId) throw new core.PermissionError("run gate ACK names another Space");
		return ack;
	};
	return {
		spaceId: o.spaceId,
		prepare: (run, command) => call<core.RunGateAck>(command, run),
		gate: command => call<core.RunGateAck>(command),
		recover: (runId, recoveryId) => call<core.RunRecoveryView>({ runId, commandId: recoveryId, kind: "recover", revision: 0, recoveryId, expiresAt: (o.now ?? Date.now)() + RECOVER_TTL_MS } as never),
	};
}
