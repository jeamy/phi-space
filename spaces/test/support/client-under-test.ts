// The client a test runs (docs/rust-portierung.en.md, section 5 and R8.1). Without PHI_SPACES_CLIENT_CMD: the TypeScript
// RemoteSpace and socket transport. With it: that program (rust/target/release/phi-client-driver) as one process for the
// whole test file, every RemoteSpace method one JSON line to it. A transport the test builds itself (a lossy link, an
// in-process service) is relayed: each request text the Rust client sends comes back here and the test's transport
// answers it, so the same faults reach the Rust retry, identity and poll logic. The pauses between retries are relayed
// to the test's `sleep` the same way, a clock (`now`) is handed over with every call. A missing binary fails the test; it
// never falls back to the TypeScript client.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	RemoteSpace, OutcomeUnknown, UnsupportedOperation, socketTransport, StillHeld, readExisting as tsReadExisting, takeExisting as tsTakeExisting,
	peek as tsPeek, takeAll as tsTakeAll, type RemoteOptions, type Transport, type SpaceLike, type Taken,
} from "../../src/index.ts";
import { CommitSealedPending, TransportFailure, toError } from "../../src/remote.ts";
import type { ListenTarget, SocketTransport, SocketTransportOptions } from "../../src/socket.ts";
import type { Template } from "../../src/core.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CMD = process.env.PHI_SPACES_CLIENT_CMD?.trim() ? process.env.PHI_SPACES_CLIENT_CMD.trim().split(/\s+/) : null;
/** The tests run another implementation of the client. */
export const OTHER_CLIENT = CMD !== null;

type Line = { id?: number; ok?: boolean; result?: unknown; error?: { kind: string; code?: string; message?: string; requiredBytes?: number; request?: { generation: string; requestId: string }; why?: string }; ask?: number; transport?: number; text?: string; sleep?: number; space?: number; ready?: boolean };

class Driver {
	private proc: ChildProcess;
	private next = 0;
	private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private ready: Promise<void>;
	/** The test's own transports behind relay ids, and the sleeps of the spaces that relay them. */
	readonly relays = new Map<number, Transport>();
	readonly sleeps = new Map<number, (ms: number) => Promise<void>>();
	private busy = 0;

	constructor(cmd: string[]) {
		this.proc = spawn(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
		let up!: () => void, down!: (e: Error) => void;
		this.ready = new Promise((r, j) => { up = r; down = j; });
		this.proc.on("error", (e) => down(e));
		this.proc.on("exit", (code) => { const e = new Error(`the client driver exited (${code})`); down(e); for (const w of this.waiting.values()) w.reject(e); this.waiting.clear(); });
		createInterface({ input: this.proc.stdout! }).on("line", (text) => {
			const m = JSON.parse(text) as Line;
			if (m.ready) return up();
			if (m.ask !== undefined) return void this.answer(m);
			const w = this.waiting.get(m.id!);
			if (!w) return;
			this.waiting.delete(m.id!);
			this.idle();
			if (m.ok) w.resolve(m.result); else w.reject(errorOf(m.error!));
		});
		this.unref();
	}
	// the driver keeps the test process alive only while a call is out
	private unref() { this.proc.unref(); (this.proc.stdout as unknown as { unref(): void }).unref(); (this.proc.stdin as unknown as { unref(): void }).unref(); }
	private idle() { if (--this.busy === 0) this.unref(); }
	private refer() { if (this.busy++ === 0) { this.proc.ref(); (this.proc.stdout as unknown as { ref(): void }).ref(); (this.proc.stdin as unknown as { ref(): void }).ref(); } }

	private async answer(m: Line) {
		const send = (a: Record<string, unknown>) => this.proc.stdin!.write(JSON.stringify({ answer: m.ask, ...a }) + "\n");
		if (m.sleep !== undefined) { await (this.sleeps.get(m.space!) ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(m.sleep); return send({ ok: true, text: "" }); }
		const t = this.relays.get(m.transport!);
		if (!t) return send({ ok: false, message: "no such transport" });
		try { send({ ok: true, text: await t.request(m.text!) }); } catch (e) { send({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
	}

	async op(line: Record<string, unknown>): Promise<unknown> {
		this.refer();
		try { await this.ready; } catch (e) { this.idle(); throw e; }
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
			this.proc.stdin!.write(JSON.stringify({ id, ...line }) + "\n");
		});
	}
}

function errorOf(e: NonNullable<Line["error"]>): Error {
	switch (e.kind) {
		case "Remote": return toError({ code: e.code as never, message: e.message ?? "", ...(e.requiredBytes === undefined ? {} : { requiredBytes: e.requiredBytes }) });
		case "OutcomeUnknown": return new OutcomeUnknown(e.request!, e.why ?? "");
		case "CommitSealedPending": return new CommitSealedPending(e.request!, e.why ?? "");
		case "Unsupported": return new UnsupportedOperation(e.message);
		case "StillHeld": return new StillHeld(e.message);
		default: return new TransportFailure(e.message);
	}
}

let driver: Driver | undefined;
const theDriver = () => (driver ??= new Driver(CMD!));

const RUST = Symbol("rust client");
type RustTransport = SocketTransport & { [RUST]: Promise<number> };
type RustSpace = RemoteSpace & { [RUST]: Promise<number> };

/** A socket transport of the client under test (`socketTransport` of src/socket.ts, or the Rust one). */
export function clientSocketTransport(target: ListenTarget, o: SocketTransportOptions = {}): SocketTransport {
	if (!OTHER_CLIENT) return socketTransport(target, o);
	const d = theDriver();
	if (o.localAddress) throw new Error("the Rust client driver takes no localAddress");
	const id = d.op({ op: "newSocket", target: "path" in target ? `unix:${target.path}` : `tcp:${target.host}:${target.port}`, ...(o.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: o.connectTimeoutMs }), ...(o.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: o.requestTimeoutMs }), ...(o.maxFrameBytes === undefined ? {} : { maxFrameBytes: o.maxFrameBytes }) }).then((r) => (r as { transport: number }).transport);
	return {
		[RUST]: id,
		async request(text: string) {
			try { return await d.op({ op: "request", transport: await id, text }) as string; } catch (e) { throw new Error((e as Error).message); }
		},
		close() { void id.then((transport) => d.op({ op: "closeTransport", transport })).catch(() => {}); },
	} as RustTransport;
}

/** A RemoteSpace of the client under test. */
export function remoteSpace(transport: Transport, o: RemoteOptions = {}): RemoteSpace {
	if (!OTHER_CLIENT) return new RemoteSpace(transport, o);
	for (const k of ["random", "newRequestId", "grantProvider", "delegationProvider", "signer", "expectedGateHostId", "ownPeerId"] as const) if (o[k] !== undefined) throw new Error(`the Rust client driver does not take ${k} (docs/rust-portierung.en.md, R8.1)`);
	const d = theDriver();
	const transportId = (transport as Partial<RustTransport>)[RUST] ?? d.op({ op: "newRelay" }).then((r) => { const id = (r as { transport: number }).transport; d.relays.set(id, transport); return id; });
	const { sleep, now, ...plain } = o;
	const id = transportId.then((t) => d.op({ op: "newSpace", transport: t, options: { ...plain, ...(sleep ? { sleep: "relay" } : {}), ...(now ? { now: now() } : {}) } })).then((r) => { const s = (r as { space: number }).space; if (sleep) d.sleeps.set(s, sleep); return s; });
	const call = async (method: string, args: unknown[]) => d.op({ op: "call", space: await id, method, args, ...(now ? { now: now() } : {}) });
	return new Proxy({ [RUST]: id } as RustSpace, {
		get(target, prop) {
			if (prop === RUST) return target[RUST];
			if (prop === "then" || typeof prop === "symbol") return undefined; // not a promise
			if (prop === "counters") throw new Error("read the counters with countersOf()");
			return (...args: unknown[]) => call(prop, args);
		},
	});
}

/** The retries and unknown outcomes of a client so far. */
export async function countersOf(space: RemoteSpace): Promise<{ retries: number; unknown: number }> {
	const rust = (space as Partial<RustSpace>)[RUST];
	if (!rust) return { ...space.counters };
	return await theDriver().op({ op: "call", space: await rust, method: "counters", args: [] }) as { retries: number; unknown: number };
}

// The helpers of src/space-client.ts: those of the Rust client for its spaces, the TypeScript ones otherwise.
const helper = <A extends unknown[], R>(name: string, ts: (s: SpaceLike, ...a: A) => Promise<R>) => async (s: SpaceLike, ...a: A): Promise<R> => {
	const rust = (s as Partial<RustSpace>)[RUST];
	return rust ? await theDriver().op({ op: "call", space: await rust, method: name, args: a }) as R : ts(s, ...a);
};
export const readExisting = helper<[Template, number, { txn?: string | null }?], Taken | null>("readExisting", tsReadExisting);
export const takeExisting = helper<[Template, number, { txn?: string | null }?], Taken | null>("takeExisting", tsTakeExisting);
export const peek = helper<[Template, { txn?: string | null }?], Taken | null>("peek", tsPeek);
export const takeAll = helper<[Template, { txn?: string | null }?], number>("takeAll", tsTakeAll);
