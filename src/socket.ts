// A stream-socket transport for the `space` service (AP 1.8/1.9 plumbing, federation-plan-v3.md 4.2): the server side
// serves a SpaceService on a unix socket (private, mode 0600) or a TCP port, the client side is a `Transport` for
// RemoteSpace. No dependencies, no TLS: the unix socket is protected by file permissions, TCP is meant for the overlay
// address of the host (WireGuard binds the peer) behind the gate. Who the peer is comes from the `connection` callback
// of the server, never from the bytes a client sends.
//
// Frame: u32 length, u32 call id (big endian), then `length` bytes of UTF-8 JSON. Calls on one connection run
// concurrently; the reply carries the id of its call. A frame over the limit is a protocol violation and ends the
// connection (4.2: frame limit, connection limit, idle limit).
import net from "node:net";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import type { Connection, SpaceService } from "./service.ts";
import type { Transport } from "./remote.ts";
import { DEFAULT_LIMITS } from "./core.ts";

const HEADER = 8;

/** Incremental frame reader: feed chunks, get whole frames; throws when a frame announces more than `max` bytes. */
class FrameReader {
	private buf: Buffer = Buffer.alloc(0);
	max: number;
	constructor(max: number) { this.max = max; }
	push(chunk: Buffer | string, onFrame: (id: number, text: string) => void): void {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk; // no encoding is set: always bytes
		this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);
		for (;;) {
			if (this.buf.length < HEADER) return;
			const n = this.buf.readUInt32BE(0);
			if (n > this.max) throw new Error(`frame of ${n} bytes exceeds the limit of ${this.max}`);
			if (this.buf.length < HEADER + n) return;
			const id = this.buf.readUInt32BE(4);
			const text = this.buf.subarray(HEADER, HEADER + n).toString("utf8");
			this.buf = this.buf.subarray(HEADER + n);
			onFrame(id, text);
		}
	}
}
function frame(id: number, text: string): Buffer {
	const body = Buffer.from(text, "utf8");
	const out = Buffer.allocUnsafe(HEADER + body.length);
	out.writeUInt32BE(body.length, 0);
	out.writeUInt32BE(id, 4);
	body.copy(out, HEADER);
	return out;
}

export type ListenTarget = { path: string } | { host: string; port: number };
export type ServeOptions = {
	listen: ListenTarget;
	/** What the host knows about the peer of this socket; the identity adapter of the service turns it into an identity. */
	connection?: (socket: net.Socket) => Connection | null | Promise<Connection | null>; // null: the peer is refused and the connection closed
	maxFrameBytes?: number;
	maxConnections?: number;
	maxInflightPerConnection?: number;
	/** Identify immediately, including silent sockets (used by the overlay gate). */
	identifyOnConnect?: boolean;
	/** A connection with no traffic for this long is closed (default 5 minutes). */
	idleMs?: number;
};
export type SpaceServer = {
	address(): string | net.AddressInfo | null;
	connections(): number;
	close(): Promise<void>;
};

export async function serveSpace(service: Pick<SpaceService, "handleText">, o: ServeOptions): Promise<SpaceServer> {
	const maxFrame = o.maxFrameBytes ?? DEFAULT_LIMITS.maxFrameBytes;
	if (!Number.isSafeInteger(maxFrame) || maxFrame < 256) throw new Error("maxFrameBytes must be an integer >= 256");
	const maxConns = o.maxConnections ?? 64;
	const maxInflight = o.maxInflightPerConnection ?? 32;
	const idleMs = o.idleMs ?? 5 * 60_000;
	const open = new Set<net.Socket>();
	let owned: { dev: number; ino: number } | undefined;
	if ("path" in o.listen) await prepareSocketPath(o.listen.path);
	const server = net.createServer((socket) => {
		if (open.size >= maxConns) { socket.destroy(); return; }
		open.add(socket);
		socket.setNoDelay(true);
		socket.setTimeout(idleMs, () => socket.destroy());
		const reader = new FrameReader(maxFrame - HEADER);
		let inflight = 0;
		let conn: Promise<Connection> | undefined;
		const identify = () => conn ??= Promise.resolve().then(() => o.connection ? o.connection(socket) : {}).then(c => {
			if (c === null) { socket.destroy(); throw new Error("refused"); }
			return c;
		});
		// Attach a rejection handler even if this socket never sends a request.
		if (o.identifyOnConnect) void identify().catch(() => socket.destroy());
		const reply = (id: number, text: string) => { if (!socket.destroyed) socket.write(frame(id, text)); };
		socket.on("data", (chunk) => {
			try {
				reader.push(chunk, (id, text) => {
					if (inflight >= maxInflight) { reply(id, JSON.stringify({ ok: false, error: { code: "ResourceExhausted", message: `at most ${maxInflight} calls at once per connection` } })); return; }
					inflight++;
					identify().then((c) => service.handleText(text, c, maxFrame - HEADER))
						.then((r) => reply(id, r), (e) => { console.error("phi-spaces socket: internal error", e); reply(id, JSON.stringify({ ok: false, error: { code: "Internal", message: "internal error" } })); })
						.finally(() => { inflight--; });
				});
			} catch { socket.destroy(); } // a frame over the limit: protocol violation
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => open.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		if ("path" in o.listen) {
			server.listen(o.listen.path, () => {
				try { const path = (o.listen as { path: string }).path; chmodSync(path, 0o600); owned = lstatSync(path); resolve(); }
				catch (e) { server.close(); reject(e); }
			});
		} else server.listen(o.listen.port, o.listen.host, resolve);
	});
	return {
		address: () => server.address(),
		connections: () => open.size,
		close: async () => {
			for (const s of open) s.destroy();
			await new Promise<void>((r) => server.close(() => r()));
			if ("path" in o.listen) {
				try { const current = lstatSync(o.listen.path); if (owned && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(o.listen.path); }
				catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
			}
		},
	};
}

async function prepareSocketPath(path: string): Promise<void> {
	let old;
	try { old = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
	if (!old.isSocket()) throw new Error(`refusing to replace a non-socket path: ${path}`);
	const stale = await new Promise<boolean>((resolve, reject) => {
		const probe = net.createConnection(path);
		const timer = setTimeout(() => { probe.destroy(); reject(new Error(`socket is busy or unresponsive: ${path}`)); }, 250);
		probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
		probe.once("error", e => { clearTimeout(timer); probe.destroy(); const code = (e as NodeJS.ErrnoException).code; if (code === "ECONNREFUSED" || code === "ENOENT") resolve(true); else reject(e); });
	});
	if (!stale) throw new Error(`a server is already listening at ${path}`);
	try {
		const current = lstatSync(path);
		if (!current.isSocket() || current.ino !== old.ino || current.dev !== old.dev) throw new Error("socket path changed during stale-file check");
		unlinkSync(path);
	} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

export type SocketTransportOptions = { connectTimeoutMs?: number;
	/**
	 * A call without an answer after this long fails and its connection is dropped (the next call connects anew); a late
	 * answer is discarded. Absent: wait as long as the connection lives (a cut overlay can hold it for many minutes).
	 */
	requestTimeoutMs?: number; maxFrameBytes?: number; /** Source address of the connection (a host with several overlay or loopback addresses). */ localAddress?: string };
export type SocketTransport = Transport & { close(): void };

/**
 * A Transport over one socket, connected on first use and again after a loss. Every call is one frame out, one frame in;
 * calls run concurrently. When the connection breaks, every call waiting on it fails (RemoteSpace retries them with the
 * same identity on a fresh connection).
 */
export function socketTransport(target: ListenTarget, o: SocketTransportOptions = {}): SocketTransport {
	const maxFrame = o.maxFrameBytes ?? DEFAULT_LIMITS.maxFrameBytes;
	let socket: net.Socket | undefined;
	let connecting: Promise<net.Socket> | undefined;
	let opening: net.Socket | undefined;
	let closed = false;
	let nextId = 1;
	const pending = new Map<number, { socket: net.Socket; resolve: (t: string) => void; reject: (e: Error) => void }>();
	const failAll = (e: Error, source?: net.Socket) => { for (const [id, p] of pending) if (!source || p.socket === source) { p.reject(e); pending.delete(id); } };

	const connect = (): Promise<net.Socket> => {
		if (closed) return Promise.reject(new Error("closed"));
		if (socket && !socket.destroyed) return Promise.resolve(socket);
		connecting ??= new Promise<net.Socket>((resolve, reject) => {
			const s = "path" in target ? net.createConnection(target.path) : net.createConnection({ port: target.port, host: target.host, ...(o.localAddress ? { localAddress: o.localAddress } : {}) });
			opening = s;
			const reader = new FrameReader(maxFrame - HEADER);
			const timer = setTimeout(() => s.destroy(new Error("connect timed out")), o.connectTimeoutMs ?? 5_000);
			s.setNoDelay(true);
			s.once("connect", () => { clearTimeout(timer); socket = s; resolve(s); });
			s.on("data", (chunk) => {
				try { reader.push(chunk, (id, text) => { const p = pending.get(id); if (p) { pending.delete(id); p.resolve(text); } }); }
				catch (e) { s.destroy(e as Error); }
			});
			s.on("error", (e) => { clearTimeout(timer); reject(e); failAll(e, s); });
			s.on("close", () => { clearTimeout(timer); reject(new Error("connection lost")); if (socket === s) socket = undefined; failAll(new Error("connection lost"), s); });
		}).finally(() => { connecting = undefined; opening = undefined; });
		return connecting;
	};
	return {
		async request(text: string): Promise<string> {
			if (Buffer.byteLength(text) + HEADER > maxFrame) throw new Error("request exceeds maxFrameBytes");
			const s = await connect();
			return new Promise<string>((resolve, reject) => {
				const id = nextId++ >>> 0 || nextId++;
				const timer = o.requestTimeoutMs === undefined ? undefined : setTimeout(() => { if (pending.delete(id)) { reject(new Error("request timed out")); s.destroy(); } }, o.requestTimeoutMs);
				const done = <T,>(f: (v: T) => void) => (v: T) => { clearTimeout(timer); f(v); };
				pending.set(id, { socket: s, resolve: done(resolve), reject: done(reject) });
				s.write(frame(id, text), (e) => { if (e) { pending.delete(id); clearTimeout(timer); reject(e); } });
			});
		},
		close() { closed = true; opening?.destroy(); socket?.destroy(); socket = undefined; failAll(new Error("closed")); },
	};
}
