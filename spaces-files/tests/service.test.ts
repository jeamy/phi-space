// The service's store: tenant Spaces reserved idempotently and kept apart, the data directory restricted to the service
// account, and the owner lock across processes: a second process is refused, a killed owner releases the store, and
// the data survives (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 6.1; phase 1 exit evidence).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOREVER } from "phi-spaces/core";
import { FilesService, InvalidTenant, prepareDataDir, tenantAlias } from "../server/service.ts";

const LAUNCH = join(import.meta.dirname, "..", "server", "launch.ts");
const ADMIN = { actorId: "lea", homeName: "lea", issuer: "https://id.example", subject: "sub-lea" };
const scratch = () => mkdtempSync(join(tmpdir(), "spaces-files-"));

test("tenant IDs map to valid Space aliases and nothing else", () => {
	assert.equal(tenantAlias("acme"), "t-acme");
	for (const bad of ["", "Acme", "-x", "a/b", "a".repeat(63), "ä"]) assert.throws(() => tenantAlias(bad), InvalidTenant);
});

test("tenant Spaces are reserved idempotently and stay apart", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null });
	try {
		const a = await s.reserveTenantSpace("acme");
		assert.deepEqual(await s.reserveTenantSpace("acme"), a);
		await s.createTenant("acme", ADMIN);
		await s.createTenant("globex", ADMIN);
		assert.deepEqual(await s.tenants(), ["acme", "globex"]);
		await s.inTenant("acme", (sp) => sp.write({ type: "Probe", fields: { n: 1 } }, null, FOREVER));
		assert.equal((await s.inTenant("acme", (sp) => sp.readIfExists({ type: "Probe" }, 0)))?.fields.n, 1);
		assert.equal(await s.inTenant("globex", (sp) => sp.readIfExists({ type: "Probe" }, 0)), null);
	} finally { await s.close(); }
});

test("the data directory must not be reachable by group or others", async () => {
	const root = scratch();
	try {
		const fresh = join(root, "fresh");
		await prepareDataDir(fresh);
		const open = join(root, "open");
		mkdirSync(open, { mode: 0o755 }); chmodSync(open, 0o755);
		await assert.rejects(prepareDataDir(open), /reachable by group or others/);
		await assert.rejects(FilesService.open({ dataDir: open, stateDir: join(root, "state") }), /chmod 700/);
		await assert.rejects(FilesService.open({ dataDir: fresh, stateDir: join(fresh, "state") }), /must not overlap/);
		await assert.rejects(FilesService.open({ dataDir: join(fresh, "inner"), stateDir: fresh }), /must not overlap/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

type Run = { child: ChildProcess; ready: Promise<void>; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string }> };

function launch(dataDir: string): Run {
	const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", LAUNCH], { env: { ...process.env, NODE_TEST_CONTEXT: "", FILES_DATA_DIR: dataDir, FILES_STATE_DIR: join(dataDir, "..", "state"), FILES_MEM: "" }, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	const ready = new Promise<void>((resolve, reject) => {
		child.stdout!.on("data", (d) => { out += d; if (out.includes("[files] ready")) resolve(); });
		child.on("exit", () => reject(new Error(`exited before ready: ${err}`)));
	});
	ready.catch(() => {});
	child.stderr!.on("data", (d) => { err += d; });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string }>((r) => child.on("close", (code, signal) => r({ code, signal, err })));
	return { child, ready, exited };
}

test("one process owns the store; a killed owner releases it and the data survives", { timeout: 60_000 }, async () => {
	const dir = join(scratch(), "data");
	const children: ChildProcess[] = [];
	const start = (d: string) => { const r = launch(d); children.push(r.child); return r; };
	try {
		const first = start(dir);
		await first.ready;

		const second = start(dir);
		const refused = await second.exited;
		assert.equal(refused.code, 1);
		// the deployment state is opened first, so its lock refuses the second process before the store's would
		assert.match(refused.err, /another process owns the deployment state/);
		// with a deployment state of its own, the store's owner lock refuses it
		await assert.rejects(FilesService.open({ dataDir: dir, stateDir: join(dir, "..", "state-2") }), /another process owns the store/);

		first.child.kill("SIGKILL");
		assert.equal((await first.exited).signal, "SIGKILL");

		// the store reopens after the crash; write through the service, close cleanly, and find it in a new process's store
		const s = await FilesService.open({ dataDir: dir, stateDir: join(dir, "..", "state") });
		await s.createTenant("acme", ADMIN);
		await s.inTenant("acme", (sp) => sp.write({ type: "Probe", fields: { n: 7 } }, null, FOREVER));
		await s.close();

		const third = start(dir);
		await third.ready;
		third.child.kill("SIGTERM");
		const end = await third.exited; assert.equal(end.code, 0, `a clean shutdown exits with 0 (${JSON.stringify(end)})`);

		const again = await FilesService.open({ dataDir: dir, stateDir: join(dir, "..", "state") });
		try {
			assert.deepEqual(await again.tenants(), ["acme"]);
			assert.equal((await again.inTenant("acme", (sp) => sp.readIfExists({ type: "Probe" }, 0)))?.fields.n, 7);
		} finally { await again.close(); }
	} finally {
		for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
		rmSync(join(dir, ".."), { recursive: true, force: true });
	}
});
