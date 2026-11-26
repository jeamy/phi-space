// Agent hosts on other machines (docs/zanzibar-agent-filesystem-plan.en.md, section 8, network agent hosts; decided in
// section 2): a TLS listener where an agent host proves the app key it enrolled, using phi-spaces' own proof
// (`ProvingService`, layer B of the federation) and pairing (`EnrollmentService`, `createEnroll`) over the service's
// control Space. There is no overlay here to name the peer, so the host names itself in `hello`; the name is worth
// nothing until a key enrolled for exactly that peer signs this connection's challenge (the challenge carries the
// claimed peer and this service's ID, and the enrollment token was bound to the peer by the operator). The proven
// peer ID becomes `enrolledHostPeerId`; the key's scope lists the tenants it may act in (`files:<tenant>`).
//
// Frames are phi-spaces' socket frames (u32 length, u32 call id, UTF-8 JSON) inside TLS. A connection answers:
//   {method: "hello", args: {peerId}}                       once, before anything else
//   {method: "generation"}                                  once per connection: the request generation of an enrollment
//   {method: "challenge" | "prove" | "enroll", …}           phi-spaces' proof and pairing
//   {op, args, frame: {agent, tenant}}                      a file operation, after the proof
// Every file operation looks the key up afresh, so a revoked host is refused at its next call.
import tls from "node:tls";
import type net from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { EnrollmentService, ProvingService, SpaceKeyDirectory, type AuthState } from "phi-spaces";
import { Unauthenticated } from "./schema.ts";
import type { FilesService } from "./service.ts";
import { AGENT_ID, agentFrameBytes } from "./agent-socket.ts";
import { BadCall, FILE_OPS, isObj, runOp, wireError, type Reply } from "./wire.ts";

/** The role an agent host's key carries, and the scope entry that lets it act in a tenant. */
export const HOST_ROLE = "host";
export const tenantScope = (tenantId: string) => `files:${tenantId}`;
/** A peer ID: the same syntax as an agent ID. */
export const PEER_ID = AGENT_ID;

export type AgentNetOptions = {
	host: string;
	port: number;
	cert: string | Buffer;
	key: string | Buffer;
	/** This service's ID in every challenge; a host checks it before it signs (default "spaces-files"). */
	gateHostId?: string;
	maxConnections?: number;
	/** A connection without traffic for this long is closed (default 5 minutes). */
	idleMs?: number;
};
export type AgentNetServer = { address(): net.AddressInfo; close(): Promise<void> };

const HEADER = 8;
export function encodeFrame(id: number, text: string): Buffer {
	const body = Buffer.from(text, "utf8");
	const out = Buffer.allocUnsafe(HEADER + body.length);
	out.writeUInt32BE(body.length, 0);
	out.writeUInt32BE(id, 4);
	body.copy(out, HEADER);
	return out;
}
/** Whole frames out of a byte stream; more than `max` announced bytes is a protocol violation (it throws). */
export class FrameReader {
	#buf: Buffer = Buffer.alloc(0);
	readonly max: number;
	constructor(max: number) { this.max = max; }
	push(chunk: Buffer, onFrame: (id: number, text: string) => void): void {
		this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
		for (;;) {
			if (this.#buf.length < HEADER) return;
			const n = this.#buf.readUInt32BE(0);
			if (n > this.max) throw new Error(`frame of ${n} bytes exceeds the limit of ${this.max}`);
			if (this.#buf.length < HEADER + n) return;
			const id = this.#buf.readUInt32BE(4), text = this.#buf.subarray(HEADER, HEADER + n).toString("utf8");
			this.#buf = this.#buf.subarray(HEADER + n);
			onFrame(id, text);
		}
	}
}

type Conn = { peerId?: string; credentials: { roles: string[] }; state: Record<string, unknown> };

export async function serveAgentNet(svc: FilesService, o: AgentNetOptions): Promise<AgentNetServer> {
	const gateHostId = o.gateHostId ?? "spaces-files";
	const keys = new SpaceKeyDirectory(svc.host, ctx);
	const maxFrame = agentFrameBytes(svc.limits.maxFileBytes);
	const sessions = new Map<string, Promise<string>>();
	const login = (peerId: string, tenantId: string, agent: string, fresh = false) => {
		const k = JSON.stringify([peerId, tenantId, agent]);
		let p = fresh ? undefined : sessions.get(k);
		if (!p) {
			p = svc.login(tenantId, "agent", { enrolledHostPeerId: peerId, agentId: agent }).then((r) => r.handle);
			sessions.set(k, p);
			p.catch(() => { if (sessions.get(k) === p) sessions.delete(k); });
		}
		return p;
	};
	const files = async (text: string, conn: Conn): Promise<Reply> => {
		let msg: unknown;
		try { msg = JSON.parse(text); } catch { return { ok: false, error: wireError(new BadCall("a call is one JSON object")) }; }
		if (!isObj(msg)) return { ok: false, error: wireError(new BadCall("a call is one JSON object")) };
		// the proof of this connection, and the key as the control Space has it now (a revocation ends access at once)
		const proof = (conn.state as AuthState).proof;
		if (!conn.peerId || !proof) return { ok: false, error: wireError(new Unauthenticated("prove the host's key first: hello, challenge, prove")) };
		const key = await keys.find(conn.peerId, proof.keyId);
		if (!key || key.state !== "active" || !key.roles.includes(HOST_ROLE)) return { ok: false, error: wireError(new Unauthenticated("the host's key is not active")) };
		const frame = isObj(msg.frame) ? msg.frame : {};
		const agent = frame.agent, tenant = frame.tenant;
		if (agent === undefined) return { ok: false, error: wireError(new Unauthenticated()) };
		if (typeof agent !== "string" || !AGENT_ID.test(agent)) return { ok: false, error: wireError(new BadCall("frame.agent must be 1 to 128 characters of A-Z a-z 0-9 _ . : -")) };
		if (typeof tenant !== "string" || !(key.scope ?? []).includes(tenantScope(tenant))) return { ok: false, error: wireError(new Unauthenticated("the host's key does not name this tenant")) };
		let handle: string;
		try { handle = await login(conn.peerId, tenant, agent); } catch (e) { return { ok: false, error: wireError(e) }; }
		let r = await runOp(FILE_OPS, svc, handle, msg.op, msg.args);
		if (!r.ok && r.error.code === "unauthenticated" && svc.state.lookupSession(handle) === null) {
			try { handle = await login(conn.peerId, tenant, agent, true); } catch (e) { return { ok: false, error: wireError(e) }; }
			r = await runOp(FILE_OPS, svc, handle, msg.op, msg.args);
		}
		return r;
	};
	const inner = {
		handleText: async (text: string, conn: Conn) => JSON.stringify(await files(text, conn)),
		handle: async () => ({ ok: false as const, error: { code: "BadRequest", message: "frames only" } }),
	};
	const now = () => svc.state.now();
	const proving = new ProvingService(inner as never, { gateHostId, keys, now });
	const chain = new EnrollmentService(proving as never, {
		keys, host: svc.host, ctx, now,
		onEvent: (e) => svc.state.operatorAudit("agentHost.enroll", { peerId: e.peerId, outcome: e.outcome, ...(e.keyId ? { keyId: e.keyId } : {}) }),
	});
	const handleText = async (text: string, conn: Conn): Promise<string> => {
		let msg: unknown;
		try { msg = JSON.parse(text); } catch { msg = null; }
		if (isObj(msg) && msg.method === "hello") {
			const peerId = isObj(msg.args) ? msg.args.peerId : undefined;
			if (typeof peerId !== "string" || !PEER_ID.test(peerId)) return JSON.stringify({ ok: false, error: { code: "BadRequest", message: "hello names a peer ID" } });
			if (conn.peerId !== undefined && conn.peerId !== peerId) return JSON.stringify({ ok: false, error: { code: "PermissionDenied", message: "this connection named another peer" } });
			conn.peerId = peerId;
			return JSON.stringify({ ok: true, result: { gateHostId } });
		}
		if (conn.peerId === undefined) return JSON.stringify({ ok: false, error: { code: "Unauthenticated", message: "say hello first" } });
		// the request generation an enrollment names: one per connection, so an unproven peer cannot fill the claims
		if (isObj(msg) && msg.method === "generation") {
			if (conn.state.generationIssued) return JSON.stringify({ ok: false, error: { code: "ResourceExhausted", message: "one generation per connection" } });
			conn.state.generationIssued = true;
			try { return JSON.stringify({ ok: true, result: await svc.hostEnrollGeneration(conn.peerId) }); }
			catch { return JSON.stringify({ ok: false, error: { code: "PermissionDenied", message: "enrollment refused" } }); }
		}
		return chain.handleText(text, conn as never);
	};

	const open = new Set<tls.TLSSocket>();
	const server = tls.createServer({ cert: o.cert, key: o.key, minVersion: "TLSv1.3" }, (socket) => {
		if (open.size >= (o.maxConnections ?? 64)) { socket.destroy(); return; }
		open.add(socket);
		socket.setNoDelay(true);
		socket.setTimeout(o.idleMs ?? 5 * 60_000, () => socket.destroy());
		// every connection starts unpaired: it may enroll with a token bound to the peer it named, or prove a key
		const conn: Conn = { credentials: { roles: ["unpaired"] }, state: {} };
		const reader = new FrameReader(maxFrame);
		let inflight = 0;
		socket.on("data", (chunk: Buffer) => {
			try {
				reader.push(chunk, (id, text) => {
					if (inflight >= 32) { socket.write(encodeFrame(id, JSON.stringify({ ok: false, error: { code: "ResourceExhausted", message: "at most 32 calls at once per connection" } }))); return; }
					inflight++;
					handleText(text, conn).then((r) => { if (!socket.destroyed) socket.write(encodeFrame(id, r)); },
						(e) => { console.error("[files] agent host connection: internal error", e); if (!socket.destroyed) socket.write(encodeFrame(id, JSON.stringify({ ok: false, error: { code: "internal", message: "internal error" } }))); })
						.finally(() => { inflight--; });
				});
			} catch { socket.destroy(); }
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => open.delete(socket));
	});
	server.on("tlsClientError", () => {});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port, o.host, resolve); });
	return {
		address: () => server.address() as net.AddressInfo,
		close: async () => { for (const s of open) s.destroy(); await new Promise<void>((r) => server.close(() => r())); },
	};
}

/** The launcher's FILES_AGENT_NET: `host:port`. */
export function parseListen(spec: string): { host: string; port: number } {
	const m = /^(\[[0-9a-fA-F:]+\]|[^:\s]+):(\d{1,5})$/.exec(spec.trim());
	if (!m || Number(m[2]) > 65535) throw new Error(`"${spec}" is not host:port`);
	return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
}
