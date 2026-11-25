// Operation IDs (docs/zanzibar-agent-filesystem-plan.en.md, section 6.2): every tenant file or admin mutation carries
// one the service issued. An ID is signed with the current signing-key generation over the tenant, the actor kind and
// ID, the issue time, the generation and a random nonce. Verification accepts a generation whose own `validUntil` has
// not passed, rejects an ID whose issue time is at least one retry window old or later than the clock plus the allowed
// skew, and does so before any receipt lookup. Issuance and verification use the deployment state's effective clock,
// which never goes back; the floor is persisted before an issuance and before an expiry decision.
//
// Format: "o1." + base64url(canonical JSON payload) + "." + base64url(HMAC-SHA-256).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "phi-spaces";
import type { DeploymentState } from "./deployment.ts";
import { InvalidInput } from "./schema.ts";

const PREFIX = "o1.";
const MAC_CONTEXT = "phi-spaces-files operation ID v1\0";
/** The longest ID the service accepts; an issued one stays well below (tenant 62, actor ID 128 characters). */
export const MAX_OPERATION_ID_CHARS = 512;

/** The signature is invalid, the ID belongs to another actor or tenant, its generation is retired, or its issue time
 *  lies outside the retry window (section 5). */
export class OperationIdRejected extends Error {
	readonly code = "operationIdRejected";
	constructor(message: string) { super(message); this.name = "OperationIdRejected"; }
}

export type OpIdActor = { tenantId: string; actorKind: "user" | "agent" | "recoverer"; actorId: string };
export type OpIdConfig = { retryWindowMs: number; clockSkewMs: number; maxOperationIdsPerCall: number };
/** What a verified ID tells: when its receipt expires (issue time plus the window). */
export type VerifiedOpId = { operationId: string; issuedAt: number; generation: number; expiry: number };

type Payload = { t: string; k: string; a: string; i: number; g: number; n: string };

const mac = (secret: Buffer, payload: string): Buffer => createHmac("sha256", secret).update(MAC_CONTEXT).update(payload).digest();

/** Signs `count` IDs for the actor (section 5, `issueOperationIds`). Writes nothing but the time floor. */
export function issueOperationIds(state: DeploymentState, actor: OpIdActor, count: unknown, cfg: OpIdConfig): string[] {
	if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > cfg.maxOperationIdsPerCall)
		throw new InvalidInput(`count must be an integer from 1 to ${cfg.maxOperationIdsPerCall}`);
	const now = state.now();
	// an ID never carries a time above the durable floor, so after a restart it cannot look like one from the future
	state.commitFloor(now);
	const key = state.currentKey();
	if (!key) throw new Error("no current signing key");
	const ids: string[] = [];
	for (let j = 0; j < (count as number); j++) {
		const p: Payload = { t: actor.tenantId, k: actor.actorKind, a: actor.actorId, i: now, g: key.generation, n: randomBytes(16).toString("base64url") };
		const payload = canonicalJson(p);
		ids.push(PREFIX + Buffer.from(payload, "utf8").toString("base64url") + "." + mac(key.secret, payload).toString("base64url"));
	}
	return ids;
}

/** Verifies an ID for this actor now (order of checks, step 5), or throws `operationIdRejected`. */
export function verifyOperationId(state: DeploymentState, actor: OpIdActor, id: unknown, cfg: OpIdConfig): VerifiedOpId {
	const reject = (why: string) => new OperationIdRejected(`operation ID rejected: ${why}`);
	if (typeof id !== "string" || id.length > MAX_OPERATION_ID_CHARS || !id.startsWith(PREFIX)) throw reject("malformed");
	const parts = id.slice(PREFIX.length).split(".");
	if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw reject("malformed");
	const payload = Buffer.from(parts[0], "base64url").toString("utf8");
	let p: Payload;
	try { p = JSON.parse(payload) as Payload; } catch { throw reject("malformed"); }
	if (typeof p !== "object" || p === null || typeof p.t !== "string" || typeof p.k !== "string" || typeof p.a !== "string" || !Number.isSafeInteger(p.i) || !Number.isSafeInteger(p.g) || typeof p.n !== "string" || canonicalJson(p) !== payload)
		throw reject("malformed");
	const now = state.now();
	const key = state.keyFor(p.g, now);
	if (!key) throw reject("its key generation is unknown or retired");
	const got = Buffer.from(parts[1], "base64url"), want = mac(key.secret, payload);
	if (got.length !== want.length || !timingSafeEqual(got, want)) throw reject("bad signature");
	if (p.t !== actor.tenantId || p.k !== actor.actorKind || p.a !== actor.actorId) throw reject("issued to another actor or tenant");
	if (p.i > now + cfg.clockSkewMs) throw reject("issued in the future");
	const expiry = p.i + cfg.retryWindowMs;
	if (now >= expiry) {
		// the decision rests on `now`: the floor must hold it before the caller hears of it (section 6.2)
		state.commitFloor(now);
		throw reject("expired");
	}
	return { operationId: id, issuedAt: p.i, generation: p.g, expiry };
}
