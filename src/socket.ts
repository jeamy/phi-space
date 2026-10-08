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
import { chmodSync, existsSync, unlinkSync } from "node:fs";
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
	connection?: (socket: net.Socket) => Connection | Promise<Connection>;
	maxFrameBytes?: number;
	maxConnections?: number;
	maxInflightPerConnection?: number;
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
	const maxConns = o.maxConnections ?? 64;
	const maxInflight = o.maxInflightPerConnection ?? 32;
	const idleMs = o.idleMs ?? 5 * 60_000;
	const open = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		if (open.size >= maxConns) { socket.destroy(); return; }
		open.add(socket);
		socket.setNoDelay(true);
		socket.setTimeout(idleMs, () => socket.destroy());
		const reader = new FrameReader(maxFrame);
		let inflight = 0;
		let conn: Promise<Connection> | undefined;
		const reply = (id: number, text: string) => { if (!socket.destroyed) socket.write(frame(id, text)); };
		socket.on("data", (chunk) => {
			try {
				reader.push(chunk, (id, text) => {
					if (inflight >= maxInflight) { reply(id, JSON.stringify({ ok: false, error: { code: "ResourceExhausted", message: `at most ${maxInflight} calls at once per connection` } })); return; }
					inflight++;
					conn ??= Promise.resolve(o.connection ? o.connection(socket) : {});
					conn.then((c) => service.handleText(text, c, maxFrame))
						.then((r) => reply(id, r), (e) => reply(id, JSON.stringify({ ok: false, error: { code: "Internal", message: e instanceof Error ? e.message : String(e) } })))
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
			if (existsSync(o.listen.path)) unlinkSync(o.listen.path); // a stale socket file of a killed process
			server.listen(o.listen.path, () => { chmodSync((o.listen as { path: string }).path, 0o600); resolve(); });
		} else server.listen(o.listen.port, o.listen.host, resolve);
	});
	return {
		address: () => server.address(),
		connections: () => open.size,
		close: async () => {
			for (const s of open) s.destroy();
			await new Promise<void>((r) => server.close(() => r()));
			if ("path" in o.listen && existsSync(o.listen.path)) unlinkSync(o.listen.path);
		},
	};
}

export type SocketTransportOptions = { connectTimeoutMs?: number; maxFrameBytes?: number };
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
	let nextId = 1;
	const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
	const failAll = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear(); };

	const connect = (): Promise<net.Socket> => {
		if (socket && !socket.destroyed) return Promise.resolve(socket);
		connecting ??= new Promise<net.Socket>((resolve, reject) => {
			const s = "path" in target ? net.createConnection(target.path) : net.createConnection(target.port, target.host);
			const reader = new FrameReader(maxFrame);
			const timer = setTimeout(() => s.destroy(new Error("connect timed out")), o.connectTimeoutMs ?? 5_000);
			s.setNoDelay(true);
			s.once("connect", () => { clearTimeout(timer); socket = s; resolve(s); });
			s.on("data", (chunk) => {
				try { reader.push(chunk, (id, text) => { const p = pending.get(id); if (p) { pending.delete(id); p.resolve(text); } }); }
				catch (e) { s.destroy(e as Error); }
			});
			s.on("error", (e) => { clearTimeout(timer); reject(e); failAll(e); });
			s.on("close", () => { clearTimeout(timer); if (socket === s) socket = undefined; failAll(new Error("connection lost")); });
		}).finally(() => { connecting = undefined; });
		return connecting;
	};
	return {
		async request(text: string): Promise<string> {
			const s = await connect();
			return new Promise<string>((resolve, reject) => {
				const id = nextId++ >>> 0 || nextId++;
				pending.set(id, { resolve, reject });
				s.write(frame(id, text), (e) => { if (e) { pending.delete(id); reject(e); } });
			});
		},
		close() { socket?.destroy(); socket = undefined; failAll(new Error("closed")); },
	};
}
