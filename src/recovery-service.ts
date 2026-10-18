// Out-of-band recovery RPC: a private Unix socket and pinned operator/supervisor signatures.
import { randomUUID } from "node:crypto";
import { mkdirSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import type { Algorithm, Signer } from "./auth.ts";
import { verifyDetached } from "./grants.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import { serveSpace, socketTransport, type SocketTransport } from "./socket.ts";
import type { Json } from "./core.ts";
import { RecoveryBlocked } from "./recovery.ts";
import { RegisterConflict } from "./recovery-register.ts";

export type RecoveryCall = { hostId: string; requestId: string; method: string; args: Json; issuedAt: number; expiresAt: number };
export type SignedRecoveryCall = { call: RecoveryCall; algorithm: Algorithm; signature: string };
export const recoveryBytes = (call: RecoveryCall) => Buffer.from("phi-spaces/recovery-rpc/v1\n" + canonicalJson(call as unknown as Json));
export type RecoveryHandler = (call: RecoveryCall, role: "operator" | "supervisor" | "host") => Promise<Json>;
const SUPERVISOR = new Set(["restoreDataSpace", "advanceRestore", "restoreStatus", "releaseRestored", "controlAck"]);
export async function serveRecovery(o: { path: string; hostId: string; operator: { algorithm: Algorithm; publicKey: string }; supervisor?: () => Promise<{ algorithm: Algorithm; publicKey: string }>; hostKey?: (call: RecoveryCall) => Promise<{ algorithm: Algorithm; publicKey: string } | null>; handle: RecoveryHandler; now?: () => number }) {
	mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 });
	const parent = lstatSync(dirname(o.path));
	if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error("recovery socket directory must be private");
	// A replayed envelope (the same signed call within its validity window) gets the first reply: the handler, with its
	// fencing, snapshot loads and external CAS, runs once. A retry signs a new call and is judged on its own. Only verified
	// calls are remembered, so unsigned traffic cannot fill the table.
	const replies = new Map<string, { expiresAt: number; reply: Promise<Json> }>();
	return serveSpace({ async handleText(text) {
		try {
			const signed = JSON.parse(text) as SignedRecoveryCall, c = signed.call, now = (o.now ?? Date.now)();
			if (!c || c.hostId !== o.hostId || typeof c.requestId !== "string" || !c.requestId || c.requestId.length > 256 || typeof c.method !== "string" || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > 60000 || c.issuedAt > now + 2000 || now + 2000 >= c.expiresAt) throw new RecoveryBlocked("invalid recovery target, request identity or validity window");
			let role: "operator" | "supervisor" | "host" | undefined;
			if (signed.algorithm === o.operator.algorithm && verifyDetached(signed.algorithm, o.operator.publicKey, recoveryBytes(c), signed.signature)) role = "operator";
			else if (o.supervisor && SUPERVISOR.has(c.method)) { const key = await o.supervisor(); if (signed.algorithm === key.algorithm && verifyDetached(key.algorithm, key.publicKey, recoveryBytes(c), signed.signature)) role = "supervisor"; }
			if (!role && o.hostKey && c.method === "controlAck") { const key = await o.hostKey(c); if (key && signed.algorithm === key.algorithm && verifyDetached(key.algorithm, key.publicKey, recoveryBytes(c), signed.signature)) role = "host"; }
			if (!role) throw new RecoveryBlocked("recovery signature or method is not authorized");
			for (const [k, v] of replies) if (v.expiresAt <= now) replies.delete(k);
			const key = digestJson([signed.algorithm, signed.signature, c as unknown as Json]);
			let entry = replies.get(key);
			if (!entry) {
				if (replies.size >= 4096) throw new RecoveryBlocked("too many recovery calls in the validity window");
				entry = { expiresAt: c.expiresAt, reply: o.handle(c, role) };
				replies.set(key, entry);
			}
			return JSON.stringify({ ok: true, result: await entry.reply });
		} catch (e) { return JSON.stringify({ ok: false, error: { code: e instanceof RegisterConflict ? "RequestConflict" : "PermissionDenied", message: e instanceof Error ? e.message : String(e) } }); }
	} }, { listen: { path: o.path }, maxFrameBytes: 256 * 1024, maxConnections: 8, maxInflightPerConnection: 4 });
}
export class RecoveryClient {
	private transport: import("./remote.ts").Transport & { close?(): void }; private o: { hostId: string; signer: Signer; timeoutMs?: number; now?: () => number };
	constructor(path: string | (import("./remote.ts").Transport & { close?(): void }), o: { hostId: string; signer: Signer; timeoutMs?: number; now?: () => number }) { this.transport = typeof path === "string" ? socketTransport({ path }) : path; this.o = o; }
	async call(method: string, args: Json, requestId: string = randomUUID()): Promise<Json> {
		const now = (this.o.now ?? Date.now)(), call: RecoveryCall = { hostId: this.o.hostId, requestId, method, args, issuedAt: now, expiresAt: now + 60000 };
		const envelope: SignedRecoveryCall = { call, algorithm: this.o.signer.algorithm, signature: Buffer.from(await this.o.signer.sign(recoveryBytes(call))).toString("base64") };
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const reply = JSON.parse(await Promise.race([this.transport.request(JSON.stringify(envelope)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RecoveryBlocked("recovery endpoint timed out; query the same recovery id")), this.o.timeoutMs ?? 10000); })]));
			if (!reply.ok) { if (reply.error?.code === "RequestConflict") throw new RegisterConflict(reply.error.message); throw new RecoveryBlocked(reply.error?.message ?? "recovery endpoint refused the request"); }
			return reply.result;
		} finally { clearTimeout(timer); }
	}
	close(): void { this.transport.close?.(); }
}
