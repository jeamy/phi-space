// Authenticated replica-sync transport between a primary and its standby (plan 3.2/3.5). Every request and response
// is signed with the host's enrolled key under its own domain tag and checked against the pinned key of the other
// host; a response is bound to the request nonce, so an ACK cannot be replayed onto another request. The transport
// authenticates the peer; the journal still decides (configuration, chain, permits) and stays idempotent.
import { randomBytes, createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { Algorithm, Signer } from "./auth.ts";
import type { Transport } from "./remote.ts";
import { verifyDetached } from "./grants.ts";
import type { Json } from "./core.ts";
import { PrimarySyncBlocked, type PrimaryIntent, type PrimarySyncAck, type PrimarySyncJournal } from "./primary-sync.ts";
import type { StandbyTarget } from "./replica-control.ts";

export type ReplicaPin = { hostId: string; algorithm: Algorithm; publicKey: string };
type Method = "accept" | "catchUp" | "head";
type Request = { from: string; to: string; method: Method; nonce: string; ts: number; bodyHash: string };
type Signed<T> = { value: T; signature: string };
const DOMAIN = { request: "pi-spaces/replica-sync/v1/request\n", response: "pi-spaces/replica-sync/v1/response\n" };
const bytes = (kind: keyof typeof DOMAIN, v: unknown) => Buffer.from(DOMAIN[kind] + canonicalJson(v as Json));
const digest = (v: unknown) => createHash("sha256").update(canonicalJson((v ?? null) as Json)).digest("hex");
const sign = async <T>(kind: keyof typeof DOMAIN, value: T, signer: Signer): Promise<Signed<T>> => ({ value, signature: Buffer.from(await signer.sign(bytes(kind, value))).toString("base64") });
const verify = (kind: keyof typeof DOMAIN, s: Signed<unknown>, pin: ReplicaPin) => !!s && typeof s.signature === "string" && verifyDetached(pin.algorithm, pin.publicKey, bytes(kind, s.value), s.signature);
export class ReplicaTransportRefused extends Error {}

/** Client side: the signed counterpart of a PrimarySyncPeer and StandbyTarget. */
export function signedReplicaPeer(o: { transport: Transport; signer: Signer; self: string; remote: ReplicaPin; now?: () => number }): StandbyTarget {
	const call = async (method: Method, body: unknown): Promise<any> => {
		const req: Request = { from: o.self, to: o.remote.hostId, method, nonce: randomBytes(16).toString("hex"), ts: (o.now ?? Date.now)(), bodyHash: digest(body) };
		const reply = JSON.parse(await o.transport.request(JSON.stringify({ request: await sign("request", req, o.signer), body })));
		const v = reply?.value;
		if (!verify("response", reply, o.remote) || v?.from !== o.remote.hostId || v?.to !== o.self || v?.nonce !== req.nonce || v?.method !== method) throw new ReplicaTransportRefused("unauthenticated replica response");
		if (v.ok !== true) throw new PrimarySyncBlocked(`standby refused: ${String(v.error).slice(0, 200)}`);
		return v.result;
	};
	return { hostId: o.remote.hostId, head: () => call("head", null), accept: (i: PrimaryIntent) => call("accept", i), catchUp: (i: PrimaryIntent) => call("catchUp", i) };
}

/**
 * Server side for a replica journal: verifies the pinned sender, a fresh timestamp and an unused nonce, then lets the
 * journal decide. Errors are signed answers too, so the caller can tell a refusal from a forged reply.
 */
export function replicaSyncHandler(o: { journal: () => PrimarySyncJournal; signer: Signer; self: string; remotes: ReplicaPin[]; assertQuarantine: () => Promise<void>; now?: () => number; windowMs?: number }) {
	const seen = new Map<string, number>(), window = o.windowMs ?? 60_000;
	return async (text: string): Promise<string> => {
		const now = (o.now ?? Date.now)(), q = JSON.parse(text), req = q?.request?.value as Request | undefined, pin = o.remotes.find(p => p.hostId === req?.from);
		if (!req || !pin || req.to !== o.self || !verify("request", q.request, pin)) throw new ReplicaTransportRefused("unauthenticated replica request");
		if (!Number.isSafeInteger(req.ts) || Math.abs(now - req.ts) > window || typeof req.nonce !== "string" || !/^[0-9a-f]{32}$/.test(req.nonce) || req.bodyHash !== digest(q.body)) throw new ReplicaTransportRefused("stale or altered replica request");
		for (const [n, at] of seen) if (now - at > 2 * window) seen.delete(n);
		if (seen.has(req.nonce)) throw new ReplicaTransportRefused("replayed replica request");
		seen.set(req.nonce, now);
		let result: PrimarySyncAck | null = null, error: string | null = null;
		try {
			const j = o.journal();
			if (req.method === "head") result = j.head();
			else if (req.method === "accept") result = await j.accept(q.body);
			else if (req.method === "catchUp") result = await j.catchUp(q.body, o.assertQuarantine);
			else throw new PrimarySyncBlocked("unknown replica method");
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		return JSON.stringify(await sign("response", { from: o.self, to: req.from, nonce: req.nonce, method: req.method, ok: error === null, result, error }, o.signer));
	};
}
