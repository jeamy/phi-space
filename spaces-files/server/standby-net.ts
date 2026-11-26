// The standby on another machine (docs/zanzibar-agent-filesystem-plan.en.md, section 6.7): `serveStandby` runs there
// beside the standby's directories (server/standby-host.ts is its process), `netStandby` is the primary's side, the
// `StateReplica` and `BlobReplica` of server/standby.ts over TLS 1.3 with mutual authentication: the standby accepts
// only a client certificate its CA signed (the primary's), and the primary accepts only a server certificate its own
// CA pin signed. Frames are phi-spaces' socket frames (u32 length, u32 id, JSON), one call at a time in order, so a
// unit never overtakes the blob or the unit sent before it.
//
// A unit of the deployment state must be confirmed before the transaction that made it returns, and that transaction
// is synchronous. The client therefore keeps its connection in a worker thread: the service's thread hands the unit
// over and waits (Atomics.wait, bounded) for the worker's answer; after a timeout the replica is broken, since a late
// answer would leave the order unknown, and the primary must open again (which seeds anew). The blob calls are asynchronous and go through the
// same worker, in the same order.
import tls from "node:tls";
import type net from "node:net";
import { fileURLToPath } from "node:url";
import { isMainThread, MessageChannel, parentPort, receiveMessageOnPort, Worker, workerData, type MessagePort } from "node:worker_threads";
import { encodeFrame, FrameReader } from "./agent-net.ts";
import { localStandby, StandbyRefused, type BlobReplica, type StateReplica } from "./standby.ts";

export type StandbyTls = { cert: string | Buffer; key: string | Buffer; /** The CA that signed the other side's certificate. */ ca: string | Buffer };
const MAX_FRAME = 512 * 1024 * 1024;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** The standby's server: one primary at a time, every call against the local directories. */
export async function serveStandby(o: { stateDir: string; blobDir: string; host: string; port: number; tls: StandbyTls }): Promise<{ address(): net.AddressInfo; close(): Promise<void> }> {
	const local = await localStandby({ stateDir: o.stateDir, blobDir: o.blobDir });
	const handle = async (m: Record<string, any>): Promise<unknown> => {
		switch (m.op) {
			case "seed": local.state.seed(m.n, (m.entries as Array<{ name: string; bytes: string }>).map((e) => ({ name: e.name, bytes: Buffer.from(e.bytes, "base64") }))); return null;
			case "accept": local.state.accept({ n: m.n, changeset: Buffer.from(m.changeset, "base64"), files: (m.files as Array<{ name: string; bytes: string }>).map((f) => ({ name: f.name, bytes: Buffer.from(f.bytes, "base64") })) }); return null;
			case "write": await local.blobs.write(m.tenantId, m.path, Buffer.from(m.sealed, "base64")); return null;
			case "remove": await local.blobs.remove(m.tenantId, m.path); return null;
			case "names": return local.blobs.names(m.tenantId);
			default: throw new Error(`unknown call ${String(m.op)}`);
		}
	};
	const open = new Set<tls.TLSSocket>();
	const server = tls.createServer({ ...o.tls, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (socket) => {
		// one primary: a second connection waits for nothing, it is refused
		if (open.size >= 1) { socket.destroy(); return; }
		open.add(socket);
		const reader = new FrameReader(MAX_FRAME);
		let chain = Promise.resolve();
		socket.on("data", (chunk: Buffer) => {
			try {
				reader.push(chunk, (id, text) => {
					chain = chain.then(async () => {
						let reply: unknown;
						try { reply = { ok: true, value: await handle(JSON.parse(text)) }; }
						catch (e) { reply = { ok: false, error: (e as Error).message }; }
						if (!socket.destroyed) socket.write(encodeFrame(id, JSON.stringify(reply)));
					});
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
		close: async () => { for (const s of open) s.destroy(); await new Promise<void>((r) => server.close(() => r())); local.close(); },
	};
}

type Target = { host: string; port: number; servername?: string; tls: StandbyTls; timeoutMs?: number };

/** The primary's side: the standby's two interfaces over one TLS connection in a worker thread. */
export function netStandby(t: Target): { state: StateReplica; blobs: BlobReplica; close(): void } {
	// word 0: 0 while a synchronous call waits, 1 once the worker answered; the answer itself comes on `detail`
	const signal = new Int32Array(new SharedArrayBuffer(4));
	const detail = new MessageChannel();
	const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { target: t, signal, detail: detail.port2 }, transferList: [detail.port2] });
	worker.unref();
	let next = 1;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	worker.on("message", (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
		const p = pending.get(m.id);
		pending.delete(m.id);
		if (m.ok) p?.resolve(m.value); else p?.reject(new StandbyRefused(`the standby refused: ${m.error}`));
	});
	worker.on("error", (e: Error) => { for (const p of pending.values()) p.reject(new StandbyRefused(e.message)); pending.clear(); });
	const timeoutMs = t.timeoutMs ?? 10_000;
	const call = (op: string, args: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
		const id = next++;
		pending.set(id, { resolve, reject });
		worker.postMessage({ id, op, args });
	});
	let broken: string | null = null;
	/** A call the service's thread waits for (a unit of the synchronous state transaction). */
	const callSync = (op: string, args: Record<string, unknown>): void => {
		// a call that timed out may still be answered later: the order on the wire is no longer known, so no more
		if (broken) throw new StandbyRefused(broken);
		Atomics.store(signal, 0, 0);
		worker.postMessage({ id: next++, op, args, sync: true });
		if (Atomics.wait(signal, 0, 0, timeoutMs) === "timed-out") {
			broken = `the standby did not answer ${op} within ${timeoutMs} ms`;
			throw new StandbyRefused(broken);
		}
		const r = receiveMessageOnPort(detail.port1)?.message as { ok: boolean; error?: string } | undefined;
		if (!r?.ok) throw new StandbyRefused(`the standby refused ${op}: ${r?.error ?? "no answer"}`);
	};
	return {
		state: {
			seed: (n, entries) => callSync("seed", { n, entries: entries.map((e) => ({ name: e.name, bytes: b64(e.bytes) })) }),
			accept: (u) => callSync("accept", { n: u.n, changeset: b64(u.changeset), files: u.files.map((f) => ({ name: f.name, bytes: b64(f.bytes) })) }),
		},
		blobs: {
			write: async (tenantId, path, sealed) => { await call("write", { tenantId, path, sealed: b64(sealed) }); },
			remove: async (tenantId, path) => { await call("remove", { tenantId, path }); },
			names: async (tenantId) => (await call("names", { tenantId })) as string[],
		},
		close: () => { detail.port1.close(); void worker.terminate(); },
	};
}

if (!isMainThread && workerData?.target) {
	const t = workerData.target as Target, signal = workerData.signal as Int32Array, detail = workerData.detail as MessagePort;
	let socket: tls.TLSSocket | null = null;
	let ready: Promise<tls.TLSSocket> | null = null;
	const waiting = new Map<number, (text: string) => void>();
	let seq = 1;
	const connect = (): Promise<tls.TLSSocket> => {
		if (ready) return ready;
		ready = new Promise((resolve, reject) => {
			const s = tls.connect({ host: t.host, port: t.port, servername: t.servername ?? t.host, ...t.tls, minVersion: "TLSv1.3" });
			const reader = new FrameReader(MAX_FRAME);
			s.once("secureConnect", () => { socket = s; resolve(s); });
			s.on("data", (c: Buffer) => { try { reader.push(c, (id, text) => { const w = waiting.get(id); waiting.delete(id); w?.(text); }); } catch { s.destroy(); } });
			s.on("error", (e) => reject(e));
			s.on("close", () => { socket = null; ready = null; for (const w of waiting.values()) w(JSON.stringify({ ok: false, error: "connection closed" })); waiting.clear(); });
		});
		return ready;
	};
	const send = async (m: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }> => {
		try {
			const s = socket ?? await connect();
			const id = seq++;
			const text = await new Promise<string>((resolve) => { waiting.set(id, resolve); s.write(encodeFrame(id, JSON.stringify(m))); });
			return JSON.parse(text);
		} catch (e) { ready = null; return { ok: false, error: (e as Error).message }; }
	};
	let chain = Promise.resolve();
	parentPort!.on("message", (m: { id: number; op: string; args: Record<string, unknown>; sync?: boolean }) => {
		chain = chain.then(async () => {
			const r = await send({ op: m.op, ...m.args });
			if (m.sync) {
				detail.postMessage({ ok: r.ok, error: r.error });
				Atomics.store(signal, 0, 1);
				Atomics.notify(signal, 0);
			} else parentPort!.postMessage({ id: m.id, ...r });
		});
	});
}
