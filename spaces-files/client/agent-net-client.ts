// The agent host's side of the network adapter (server/agent-net.ts): a TLS transport that names the host's peer,
// proves its enrolled key on every connection before any call goes out, and reconnects (and proves again) after a
// loss; `enrollHost` pairs a new key with the operator's token; `hostKey` keeps the host's key in a file of its own.
// The transport plugs into `FilesAgentClient`, which adds the tenant to each call's frame.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";
import { AUTH_PROTOCOL, signedBytes, type Challenge, type Signer } from "phi-spaces";
import { encodeFrame, FrameReader } from "../server/agent-net.ts";

export type AgentNetTarget = {
	host: string;
	port: number;
	/** The CA (PEM) that signed the service's certificate. */
	ca?: string | Buffer;
	/** The name the certificate must carry (default: host). */
	servername?: string;
	/** The service's ID; a challenge naming another is not signed (default "spaces-files"). */
	gateHostId?: string;
	/** This host's peer ID, as the operator enrolled it. */
	peerId: string;
	maxFrameBytes?: number;
	connectTimeoutMs?: number;
};

/** A raw TLS connection with phi-spaces' frames: one frame out, one in, concurrent calls. */
class Conn {
	readonly #socket: tls.TLSSocket;
	readonly #pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
	#next = 1;
	#dead: Error | null = null;
	readonly ready: Promise<void>;
	constructor(t: AgentNetTarget) {
		this.#socket = tls.connect({ host: t.host, port: t.port, ca: t.ca, servername: t.servername ?? t.host, minVersion: "TLSv1.3" });
		const reader = new FrameReader(t.maxFrameBytes ?? 32 * 1024 * 1024);
		this.ready = new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.#socket.destroy(); reject(new Error("connect timeout")); }, t.connectTimeoutMs ?? 10_000);
			this.#socket.once("secureConnect", () => { clearTimeout(timer); resolve(); });
			this.#socket.once("error", (e) => { clearTimeout(timer); reject(e); });
		});
		this.#socket.on("data", (chunk: Buffer) => {
			try { reader.push(chunk, (id, text) => { const p = this.#pending.get(id); this.#pending.delete(id); p?.resolve(text); }); }
			catch (e) { this.#socket.destroy(e as Error); }
		});
		this.#socket.on("error", () => {});
		this.#socket.on("close", () => {
			this.#dead = new Error("connection closed");
			for (const p of this.#pending.values()) p.reject(this.#dead);
			this.#pending.clear();
		});
	}
	get dead(): boolean { return this.#dead !== null; }
	request(text: string): Promise<string> {
		if (this.#dead) return Promise.reject(this.#dead);
		const id = this.#next++;
		return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#socket.write(encodeFrame(id, text)); });
	}
	async call(method: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const r = JSON.parse(await this.request(JSON.stringify({ method, args, ...extra }))) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } };
		if (!r.ok) throw Object.assign(new Error(`${method}: ${r.error?.code} ${r.error?.message}`), { code: r.error?.code });
		return r.result ?? {};
	}
	close(): void { this.#socket.destroy(); }
}

/** A fresh challenge, checked as the proof asks: this service and this peer, or it is not signed. */
async function challenge(c: Conn, t: AgentNetTarget): Promise<Challenge> {
	await c.call("hello", { peerId: t.peerId });
	const r = await c.call("challenge", { protocol: AUTH_PROTOCOL });
	const ch: Challenge = { gateHostId: r.gateHostId as string, observedPeerId: r.observedPeerId as string, connNonce: r.connNonce as string, protocol: r.protocol as number, issuedAt: r.issuedAt as number };
	if (ch.gateHostId !== (t.gateHostId ?? "spaces-files")) throw new Error(`the challenge names service ${ch.gateHostId}, not the one meant`);
	if (ch.observedPeerId !== t.peerId) throw new Error(`the challenge names peer ${ch.observedPeerId}, not this host`);
	return ch;
}

/**
 * The transport for `FilesAgentClient`: connects on first use, proves the key, and on a lost connection connects and
 * proves again; a call in flight when the connection breaks fails (the client sends it again with its operation ID).
 */
export function agentNetTransport(t: AgentNetTarget, signer: Signer): { request(text: string): Promise<string>; close(): void } {
	let current: Promise<Conn> | null = null;
	let closed = false;
	const open = async (): Promise<Conn> => {
		const c = new Conn(t);
		try {
			await c.ready;
			const ch = await challenge(c, t);
			const signature = Buffer.from(await signer.sign(signedBytes(ch))).toString("base64");
			await c.call("prove", { keyId: signer.keyId, signature, challenge: ch });
			return c;
		} catch (e) { c.close(); throw e; }
	};
	const conn = async (): Promise<Conn> => {
		if (closed) throw new Error("closed");
		const have = current && await current.catch(() => null);
		if (have && !have.dead) return have;
		current = open();
		return current;
	};
	return {
		request: async (text) => (await conn()).request(text),
		close: () => { closed = true; void current?.then((c) => c.close(), () => {}); },
	};
}

/**
 * Enrolls this host's key with the operator's one-time token: the new key signs this connection's challenge, and the
 * service stores it for the peer the token was bound to. Returns the key ID (the service derives it from the key).
 */
export async function enrollHost(t: AgentNetTarget, token: string, signer: Signer & { publicKey: string }): Promise<{ keyId: string; tenants: string[] }> {
	const c = new Conn(t);
	try {
		await c.ready;
		const ch = await challenge(c, t);
		const { generation } = await c.call("generation", {});
		const signature = Buffer.from(await signer.sign(signedBytes(ch))).toString("base64");
		const r = await c.call("enroll", { token, algorithm: signer.algorithm, publicKey: signer.publicKey, signature, challenge: ch }, { request: { generation, requestId: randomUUID() } });
		return { keyId: r.keyId as string, tenants: ((r.scope as string[]) ?? []).filter((s) => s.startsWith("files:")).map((s) => s.slice(6)) };
	} finally { c.close(); }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const signerOf = (privateKey: KeyObject, keyId: string): Signer & { publicKey: string } => {
	const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.length);
	return { keyId, algorithm: "ed25519", publicKey: Buffer.from(raw).toString("base64"), sign: (d) => cryptoSign(null, Buffer.from(d), privateKey) };
};

/**
 * The host's Ed25519 key in a file of its own (PKCS#8 PEM, mode 600), made on first use. `keyId` is the one enrollment
 * returned (the service derives it from the public key); before enrollment any placeholder will do.
 */
export function hostKey(file: string, keyId = "unenrolled"): Signer & { publicKey: string } {
	if (!existsSync(file)) {
		const { privateKey } = generateKeyPairSync("ed25519");
		writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
	}
	return signerOf(createPrivateKey(readFileSync(file)), keyId);
}
