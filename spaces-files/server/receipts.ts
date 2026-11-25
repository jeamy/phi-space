// Receipts (docs/zanzibar-agent-filesystem-plan.en.md, sections 3 and 6.2): only a successful mutation, including an
// idempotent no-op, commits a receipt, together with its changed rows and audit row, and so consumes its operation ID.
// A retry with the same ID and digest returns the recorded outcome; another digest is `requestMismatch`. A failed
// attempt writes no receipt. The caller looks a receipt up only after the current authorization has passed, so a
// replay learns nothing its caller may no longer see.
//
// Budgets (section 3): receipts are bounded by count per tenant. Ordinary mutations and idempotent no-ops use at most
// `maxReceipts`; security actions (revocations, membership removal, actor disablement) may also draw on
// `securityReceiptReserve`. A live receipt is never evicted: at the bound, expired receipts are pruned first (the time
// floor persisted before), and only then does the mutation fail with `capacityExceeded`.
import type { PhiSpaces } from "phi-spaces";
import type { EntryDraft } from "phi-spaces/core";
import type { DeploymentState } from "./deployment.ts";
import type { OpIdActor, VerifiedOpId } from "./opids.ts";
import { CapacityExceeded, receipt, T } from "./schema.ts";

export class RequestMismatch extends Error {
	readonly code = "requestMismatch";
	constructor() { super("the operation ID already has a successful receipt with other arguments"); this.name = "RequestMismatch"; }
}

export type Outcome = Record<string, string | number | boolean | null>;
export type Pool = "ordinary" | "security";
export type ReceiptLimits = { maxReceipts: number; securityReceiptReserve: number };

/** Receipts removed in one commit: the takes must fit the commit budget. */
export const PRUNE_BATCH = 256;

const key = (actor: OpIdActor, operationId: string) => ({ type: T.receipt, fields: { actorKind: actor.actorKind, actorId: actor.actorId, operationId } });

/** The recorded outcome of an earlier success with this ID and digest, or null when the ID is unused (order of checks,
 *  step 7). Another digest is `requestMismatch`. */
export async function lookupReceipt(space: PhiSpaces, actor: OpIdActor, operationId: string, digest: string): Promise<Outcome | null> {
	const r = await space.readIfExists(key(actor, operationId), 0);
	if (r === null) return null;
	if (r.fields.digest !== digest) throw new RequestMismatch();
	return r.fields.outcome as Outcome;
}

/** The receipt row a successful mutation commits with its changes. */
export const receiptRow = (actor: OpIdActor, id: VerifiedOpId, digest: string, outcome: Outcome): EntryDraft =>
	receipt(actor.actorKind, actor.actorId, id.operationId, digest, outcome, id.expiry);

/**
 * Makes room for one more receipt of `pool`, or throws `capacityExceeded` without removing a live one. Runs in the
 * tenant queue before the mutation's commit.
 */
export async function reserveReceipt(space: PhiSpaces, state: DeploymentState, limits: ReceiptLimits, pool: Pool): Promise<void> {
	const bound = limits.maxReceipts + (pool === "security" ? limits.securityReceiptReserve : 0);
	if ((await space.count({ type: T.receipt })) < bound) return;
	await pruneReceipts(space, state, PRUNE_BATCH);
	if ((await space.count({ type: T.receipt })) >= bound) throw new CapacityExceeded(`the tenant holds ${bound} unexpired receipts (${pool} pool)`);
}

/**
 * Deletes up to `limit` expired receipts, earliest expiry first, in one commit. An ID is rejected from its expiry
 * instant on before any lookup (opids.ts), so removing its receipt lets no duplicate through. The time floor is
 * persisted first: a clock that goes back after a restart cannot revive the IDs (section 6.2).
 */
export async function pruneReceipts(space: PhiSpaces, state: DeploymentState, limit: number): Promise<number> {
	const now = state.now();
	const expired = (await space.readAll({ type: T.receipt }))
		.filter((r) => (r.fields.expiry as number) <= now)
		.sort((a, b) => (a.fields.expiry as number) - (b.fields.expiry as number))
		.slice(0, limit);
	if (expired.length === 0) return 0;
	state.commitFloor(now);
	await space.batch(expired.map((r) => ({ op: "take" as const, template: { type: T.receipt, fields: { actorKind: r.fields.actorKind, actorId: r.fields.actorId, operationId: r.fields.operationId } } })));
	return expired.length;
}
