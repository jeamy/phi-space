// R3, slice 7 (docs/rust-portierung.md): a store goes from the TypeScript server to the Rust server and back with work
// open, each killed hard: a held transaction, a blocked take, a registration and its events, decided results. The same
// request ids are answered the same on every server. It needs the Rust server: PHI_SPACES_SERVER_CMD.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketTransport, type Transport } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUST = process.env.PHI_SPACES_SERVER_CMD?.trim().split(/\s+/);
const TS = [process.execPath, "--experimental-strip-types", "--no-warnings", "src/standalone.ts"];

function server(cmd: string[], store: string, sock: string): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd[0]!, [...cmd.slice(1), "--store", store, "--listen", `unix:${sock}`], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const seen = (d: Buffer) => { out += d; if (out.includes("ready on")) resolve(p); };
		p.stdout!.on("data", seen);
		p.stderr!.on("data", (d: Buffer) => { out += d; });
		p.on("exit", (code) => reject(new Error(`${cmd[0]} exited (${code}):\n${out}`)));
	});
}
const killed = (p: ChildProcess) => new Promise<void>((r) => { p.removeAllListeners("exit"); p.once("exit", () => r()); p.kill("SIGKILL"); });

test("TypeScript to Rust to TypeScript and to Rust again, killed hard each time, with open work and the same request ids", async (t) => {
	if (!RUST) return t.skip("needs PHI_SPACES_SERVER_CMD");
	const dir = mkdtempSync("/tmp/phi-hand-"), store = join(dir, "s.sqlite"), sock = join(dir, "s.sock");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	let wire: Transport & { close(): void } = socketTransport({ path: sock });
	const on = async (cmd: string[], work: () => Promise<void>) => {
		const p = await server(cmd, store, sock);
		wire = socketTransport({ path: sock });
		try { await work(); } finally { wire.close(); await killed(p); rmSync(sock, { force: true }); }
	};
	const raw = (text: string) => wire.request(text);
	const call = async (o: unknown) => JSON.parse(await raw(JSON.stringify(o))) as { ok: boolean; result: any; error?: { code: string } };
	let generation = "", txn = "", wait = "", second = "";
	const request = (requestId: string) => ({ generation, requestId });
	const write = (id: string, type: string, fields: object, extra: object = {}) => JSON.stringify({ method: "write", request: request(id), args: { entry: { type, fields }, ...extra } });
	const replies = new Map<string, string>();
	const once = async (id: string, text: string) => { const r = await raw(text); replies.set(id, r); return JSON.parse(r) as { ok: boolean; result: any }; };
	const same = async (id: string, text: string) => assert.equal(await raw(text), replies.get(id), `the stored answer of ${id}`);
	const texts = {
		w1: () => write("w1", "Job", { n: 1 }),
		w2: () => write("w2", "Job", { n: 2 }),
		lease: () => write("lease", "Temp", { n: 3 }, { leaseMs: 3_600_000 }),
		held: () => JSON.stringify({ method: "take", request: request("held"), args: { template: { type: "Job", fields: { n: 1 } }, txn, waitMs: 0 } }),
		blocked: () => JSON.stringify({ method: "take", request: request("blocked"), args: { template: { type: "Late" }, timeoutMs: 3_600_000, waitMs: 0 } }),
		late: () => write("late", "Late", { v: 42 }),
		commit: () => JSON.stringify({ method: "txn", request: request("commit"), args: { action: "commit", id: txn } }),
	};

	await on(TS, async () => {
		generation = (await call({ method: "generation" })).result.generation;
		assert.equal((await once("w1", texts.w1())).ok, true);
		assert.equal((await once("w2", texts.w2())).ok, true);
		assert.equal((await once("lease", texts.lease())).ok, true);
		txn = (await call({ method: "txn", request: request("begin"), args: { action: "begin", leaseMs: 3_600_000 } })).result.id;
		assert.equal((await once("held", texts.held())).result.state, "done");
		assert.equal((await once("blocked", texts.blocked())).result.state, "pending");
		wait = (await call({ method: "notify", request: request("reg"), args: { template: { type: "Note" }, leaseMs: 3_600_000 } })).result.eventId;
		assert.ok((await call({ method: "write", request: request("note"), args: { entry: { type: "Note", fields: {} } } })).ok);
	});

	await on(RUST, async () => {
		await same("w2", texts.w2());
		await same("held", texts.held());
		assert.equal((await call({ method: "count", args: { template: { type: "Job" } } })).result.value, 1, "the held take is still out");
		assert.equal((await call({ method: "pollOperation", args: { targetRequest: request("blocked") } })).result.state, "pending", "the blocked take goes on");
		const events = (await call({ method: "events", args: {} })).result.events as { event: { eventId: string } }[];
		assert.ok(events.some((e) => e.event.eventId === wait), "the event of a registration TypeScript took");
		assert.equal((await once("late", texts.late())).ok, true);
		const served = (await call({ method: "pollOperation", args: { targetRequest: request("blocked"), waitMs: 2_000 } })).result;
		assert.equal(served.state, "done", "a write in Rust serves a take that waits since TypeScript");
		assert.equal(served.result.fields.v, 42);
		assert.equal((await once("commit", texts.commit())).ok, true);
		assert.equal((await call({ method: "count", args: { template: { type: "Job" } } })).result.value, 1);
		second = (await call({ method: "notify", request: request("reg2"), args: { template: { type: "Note2" }, leaseMs: 3_600_000 } })).result.eventId;
		assert.equal((await call({ method: "write", request: request("note2"), args: { entry: { type: "Note2", fields: {} } } })).ok, true);
	});

	await on(TS, async () => {
		for (const id of ["w1", "w2", "lease", "held", "late", "commit"] as const) await same(id, texts[id]());
		assert.equal((await call({ method: "pollOperation", args: { targetRequest: request("blocked") } })).result.result.fields.v, 42, "a result decided in Rust");
		assert.equal((await call({ method: "count", args: { template: { type: "Job" } } })).result.value, 1);
		assert.equal((await call({ method: "count", args: { template: { type: "Temp" } } })).result.value, 1);
		assert.ok(((await call({ method: "events", args: {} })).result.events as { event: { eventId: string } }[]).some((e) => e.event.eventId === second), "the event Rust queued");
		const fresh = (await call({ method: "generation" })).result.generation;
		assert.equal((await call({ method: "write", request: { generation: fresh, requestId: "after" }, args: { entry: { type: "Job", fields: { n: 9 } } } })).ok, true);
		assert.equal((await call({ method: "txn", request: request("again"), args: { action: "begin", leaseMs: 1000 } })).ok, true);
	});

	await on(RUST, async () => {
		for (const id of ["w1", "w2", "lease", "held", "late", "commit"] as const) await same(id, texts[id]());
		assert.equal((await call({ method: "count", args: { template: { type: "Job" } } })).result.value, 2, "and what TypeScript wrote last");
	});
});
