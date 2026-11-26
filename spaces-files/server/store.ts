// Where the tenant Spaces live (docs/zanzibar-agent-filesystem-plan.en.md, section 8, separate Space process; decided in
// section 2): in this process (`inProcessStore`, phi-spaces' own store opened here), or in a Space process of its own
// that this service alone reaches over a private unix socket (`spaceProcessStore`, server/space-host.ts or a binary
// with the same command line). Either way the service sees the same thing: a Space per alias, the creation of a
// tenant's Space, the list of aliases, compaction, and the store file for backups and sizes.
//
// Over the socket a call can fail in transit. Such a failure is `unavailable` (the client sends it again with its
// operation ID); a commit whose reply is lost is an unknown outcome, which the service already handles by closing
// admission until `resolveOutcomes` (section 6.1).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost, type OwnStoreHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { createSpace, listSpaces, OutcomeUnknown, PhiSpaces, RemoteSpace, socketTransport, startService, type BatchOp, type BatchResult, type Req, type SocketTransport, type SpaceLike } from "phi-spaces";
import { Unavailable } from "./admission.ts";

/** A tenant's Space as the service uses it. */
export type TenantSpace = SpaceLike & { batch(ops: readonly BatchOp[], o?: Req): Promise<BatchResult[]> };

export interface SpaceStore {
	/** The SQLite file of the store (null in memory): backups copy it, `health` reads its sizes. */
	readonly path: string | null;
	/** Where it runs: "in-process", or the Space process's socket. */
	readonly where: string;
	/** The Space process's ID (undefined in this process). */
	readonly pid?: number;
	space(alias: string): TenantSpace;
	createSpace(alias: string): Promise<{ spaceId: string; alias: string }>;
	aliases(): Promise<string[]>;
	compact(): Promise<{ freedPages: number; converted: boolean; error?: string } | null>;
	close(): Promise<void>;
}

/** The store opened in this process, with the reaper that clears reservations of abandoned transactions. */
export async function inProcessStore(file: string | null, now: () => number = Date.now): Promise<SpaceStore & { readonly host: OwnStoreHost }> {
	const host: OwnStoreHost = file === null ? openOwnMemoryHost() : await openSqliteHost(file);
	let stop: () => Promise<void>;
	try { stop = await startService(host, ctx, { now, watchDebounceMs: 50 }); }
	catch (e) { await host.close(ctx); throw e; }
	return {
		path: file, where: "in-process", host,
		space: (alias) => new PhiSpaces(host, ctx, now, undefined, undefined, { space: alias }),
		createSpace: async (alias) => { const i = await host.commit((tx) => createSpace(tx, alias, now()), ctx); return { spaceId: i.spaceId, alias: i.alias }; },
		aliases: async () => (await listSpaces(host, ctx)).map((s) => s.alias),
		compact: () => host.compact(),
		close: async () => { await stop(); await host.close(ctx); },
	};
}

/** The peer every call of this service is on the Space process's private socket. */
export const SPACE_PEER = "files";
/** The ready line of a Space process: `[files-space] ready on <listen> (store <file|memory>)`. */
export const SPACE_READY = /^\[files-space\] ready on /;

export type SpaceProcessOptions = {
	/** The program and its first arguments; the store and the socket follow as `--store FILE|memory --listen unix:PATH --exit-with-parent`. */
	command: readonly string[];
	file: string | null;
	/** The socket's directory (mode 700; the data directory); in memory a temporary one. */
	dir: string | null;
	startTimeoutMs?: number;
	/** The Space process ended without `close`: nothing this service does reaches the store any more. */
	onLost?: (code: number | null, signal: string | null) => void;
};

/** A transport failure or a reply lost on the way: the caller may send it again (`unavailable`). */
const transient = (e: unknown) => e instanceof OutcomeUnknown || (e as Error)?.constructor?.name === "TransportFailure";

/** Wraps every method of a Space so a failure in transit is `unavailable` instead of an internal error. */
function guarded(space: TenantSpace): TenantSpace {
	return new Proxy(space, {
		get(target, prop, receiver) {
			const v = Reflect.get(target, prop, receiver);
			if (typeof v !== "function") return v;
			return async (...args: unknown[]) => {
				try { return await v.apply(target, args); }
				catch (e) { if (transient(e)) throw new Unavailable("the Space process does not answer; retry later", 500); throw e; }
			};
		},
	});
}

/**
 * Starts the Space process on `file` and connects to it. The process exits when this one does (its stdin closes);
 * `close` stops it with SIGTERM and waits for it.
 */
export async function spaceProcessStore(o: SpaceProcessOptions): Promise<SpaceStore> {
	const temp = o.dir === null ? mkdtempSync(join(tmpdir(), "files-space-")) : null;
	const sock = join(o.dir ?? temp!, "space.sock");
	const listen = `unix:${sock}`;
	const [cmd, ...pre] = o.command;
	const child: ChildProcess = spawn(cmd, [...pre, "--store", o.file ?? "memory", "--listen", listen, "--exit-with-parent"], { stdio: ["pipe", "pipe", "inherit"], detached: true });       // its own process group: a Ctrl-C reaches this process, which stops it
	const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`the Space process (${cmd}) did not get ready`)), o.startTimeoutMs ?? 30_000);
			const lines = createInterface({ input: child.stdout! });
			lines.on("line", (l) => { if (SPACE_READY.test(l)) { clearTimeout(timer); resolve(); } else console.log(l); });
			child.once("error", (e) => { clearTimeout(timer); reject(e); });
			void exited.then((c) => { clearTimeout(timer); reject(new Error(`the Space process exited with ${c} before it got ready`)); });
		});
	} catch (e) {
		child.kill("SIGKILL");
		if (temp) rmSync(temp, { recursive: true, force: true });
		throw e;
	}
	let closing = false;
	child.once("exit", (code, signal) => { if (!closing) o.onLost?.(code, signal); });
	const transport: SocketTransport = socketTransport({ path: sock }, { connectTimeoutMs: 2_000, requestTimeoutMs: 35_000 });
	const remote = (space?: string) => new RemoteSpace(transport, { ...(space === undefined ? {} : { space }), attempts: 3, backoffMs: 50, maxBackoffMs: 500, callTimeoutMs: 30_000 });
	const admin = remote();
	// one client per alias: each says hello once and keeps its request generation
	const spaces = new Map<string, TenantSpace>();
	const call = async (method: string, args: Record<string, unknown>) => {
		let reply: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
		try { reply = JSON.parse(await transport.request(JSON.stringify({ method, args }))); }
		catch { throw new Unavailable("the Space process does not answer; retry later", 500); }
		if (!reply.ok) throw new Error(`${method}: ${reply.error?.code} ${reply.error?.message}`);
		return reply.result;
	};
	return {
		path: o.file, where: listen, pid: child.pid,
		space: (alias) => { let s = spaces.get(alias); if (!s) { s = guarded(remote(alias) as unknown as TenantSpace); spaces.set(alias, s); } return s; },
		createSpace: async (alias) => call("filesCreateSpace", { alias }) as Promise<{ spaceId: string; alias: string }>,
		aliases: async () => { try { return (await admin.spaces()).map((s) => s.alias); } catch (e) { if (transient(e)) throw new Unavailable("the Space process does not answer; retry later", 500); throw e; } },
		compact: async () => call("filesCompact", {}) as Promise<{ freedPages: number; converted: boolean; error?: string } | null>,
		close: async () => {
			closing = true;
			transport.close();
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
				await exited;
				clearTimeout(t);
			}
			if (temp) rmSync(temp, { recursive: true, force: true });
		},
	};
}
