import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { createSpace, FOREVER, PiSpaces } from "./src/index.ts";
import { inspect } from "./test/testbed/inspect.ts";
import { actions } from "./test/tui/actions.ts";
import { Backend, clean, outcome, tapCounts } from "./test/tui/backend.ts";
import { render, type ScreenState } from "./test/tui/view.ts";

test("inspector reads named spaces, reservations, uncommitted entries and claims without touching live JSONL", async () => {
	const dir = await mkdtemp(join(tmpdir(), "spaces-inspect-test-"));
	const h = await Harness.open(await openNodeJsonlStorage(dir, ctx), { models: createModels(), registry: createRegistry() }, ctx);
	try {
		await h.commit(tx => createSpace(tx, "demo", Date.now()), ctx);
		const space = new PiSpaces(h, ctx, Date.now, undefined, undefined, { space: "demo" });
		const principal = { peerId: "tui-test" }, generation = (await space.issueGeneration(principal)).generation;
		await space.write({ type: "Task", fields: { n: 7 } }, null, FOREVER, { request: { principal, generation, requestId: "write" } });
		const txn = await space.createTransaction(FOREVER);
		await space.take({ type: "Task" }, 0, { txn: txn.id });
		await space.write({ type: "Result", fields: { n: 7 } }, txn.id, FOREVER);
		// A crashed writer's incomplete main line must be repaired only in the private inspection copy.
		await appendFile(join(dir, "main.jsonl"), '{"unfinished":');
		const files = (await readdir(dir)).filter(n => n.endsWith(".jsonl"));
		const before = await Promise.all(files.map(n => readFile(join(dir, n))));
		const result = await inspect(dir);
		assert.deepEqual(result.errors, []);
		const demo = result.spaces.find(s => s.alias === "demo")!;
		assert.ok(demo.items.some(i => i.type === "Task" && i.state === "reserved"));
		assert.ok(demo.items.some(i => i.type === "Result" && i.state === "uncommitted"));
		assert.ok(demo.items.some(i => i.kind === "claim" && i.state === "done"));
		assert.equal(demo.stats.txns, 1);
		assert.deepEqual(await Promise.all(files.map(n => readFile(join(dir, n)))), before);
	} finally { await h.close(ctx); await rm(dir, { recursive: true, force: true }); }
});

test("reports from a previous run are explicitly non-current; missing storage is an error", async () => {
	const dir = await mkdtemp(join(tmpdir(), "spaces-report-test-"));
	try {
		await writeFile(join(dir, "phone.json"), JSON.stringify({ config: { runId: "new" } }));
		await writeFile(join(dir, "report.json"), JSON.stringify({ runId: "old", passed: true }));
		assert.equal((await inspect(dir)).reports[0].current, false);
		assert.equal((await inspect(join(dir, "missing"))).errors.length, 1);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("dry-run never executes a command, failures cannot pass and interrupted remote calls remain unknown", async () => {
	const dir = await mkdtemp(join(tmpdir(), "spaces-tui-run-test-"));
	try {
		const backend = new Backend(process.cwd(), dir);
		const a = { id: "fake", group: "test", label: "fake", scope: "local" as const, program: "node" as const, args: ["-e", "throw new Error('expected failure')"], test: true };
		assert.equal((await backend.run(a, true, () => {})).status, "preview");
		assert.equal((await backend.run(a, false, () => {})).status, "failed");
		assert.equal(outcome({ ...a, scope: "remote" }, null, "SIGTERM", true), "unknown");
		assert.equal(outcome(a, 0, null), "passed");
		assert.equal(tapCounts("# tests 8\n# pass 7\n# fail 1\n# skipped 0\n")?.failed, 1);
		await assert.rejects(backend.run({ ...a, unavailable: "missing backend" }, false, () => {}), /missing backend/);
		assert.ok((await backend.history()).every(r => r.status !== "running"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("non-interactive remote mutations require explicit authorization before any connection", () => {
	const run = spawnSync(process.execPath, ["--experimental-strip-types", "test/tui/cli.ts", "--action", "up-core"], { encoding: "utf8", timeout: 10_000 });
	assert.equal(run.status, 1);
	assert.match(run.stderr, /--allow-remote/);
});

test("cancelling a real local subprocess records cancellation; truncated history stays unknown", async () => {
	const dir = await mkdtemp(join(tmpdir(), "spaces-tui-cancel-test-"));
	try {
		const backend = new Backend(process.cwd(), dir);
		const a = { id: "long", group: "test", label: "long", scope: "local" as const, program: "node" as const, args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], test: true };
		const running = backend.run(a, false, text => { if (text.includes("ready")) backend.cancel(); });
		assert.equal((await running).status, "cancelled");
		await writeFile(join(dir, "truncated.json"), '{"status":');
		assert.ok((await backend.history()).some(r => r.status === "unknown" && r.label.includes("truncated")));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("terminal control sequences are stripped from object content and rendering stays within screen", () => {
	const state: ScreenState = { tab: 0, service: "runner", dry: true, space: 0, item: 0, itemFocus: true, filter: "", itemsKind: "entry", detailOffset: 0, actions: actions("runner"), action: 0, history: [], report: 0, log: [], logOffset: 0, notice: "test", input: "" };
	state.snapshot = { version: 1, root: "/tmp", capturedAt: "now", errors: [], reports: [], spaces: [{ spaceId: "sp-test", alias: "demo", incarnation: "123", createdAt: 0, storage: "/tmp", truncated: 0, stats: { entries: 1, byType: { Task: 1 }, locked: 0, uncommitted: 0, expired: 0, txns: 0, waiters: 0, registrations: 0, outbox: 0, returned: 0 }, items: [{ kind: "entry", id: "e1", type: "Task", state: "visible", value: { text: "\x1b]52;c;attack\x07" } }] }] };
	for (const size of [[80, 24], [120, 36]]) {
		const screen = render(state, size[0], size[1]);
		assert.ok(!screen.includes("\x1b"));
		assert.equal(screen.split("\n").length, size[1]);
		assert.ok(screen.split("\n").every(l => l.length <= size[0]));
	}
	assert.equal(clean("\x1b[31mFAIL\x1b[0m"), "FAIL");
});

test("inspector sees live SQLite spaces through a consistent private backup",async()=>{
 const {PersistentHome,ctx}=await import("./test/support/persistent.ts"),{PiSpaces}=await import("./src/index.ts"),{inspect}=await import("./test/testbed/inspect.ts");
 const home=new PersistentHome("sqlite"),h=await home.open();try{const local=new PiSpaces(h,ctx);await local.write({type:"LiveSQLite",fields:{n:1}});const before=await local.stats();const result=await inspect(home.dir);assert.equal(result.errors.length,0);assert.equal(result.spaces.length,1);assert.ok(result.spaces[0]!.items.some(i=>i.type==="LiveSQLite"));assert.deepEqual(await local.stats(),before);}finally{await home.dispose();}
});
