// The tenant Spaces in a process of their own (docs/zanzibar-agent-filesystem-plan.en.md, section 8, separate Space
// process): the service reaches them over a private socket in the data directory; the Space process killed in the
// middle of a commit is an unknown outcome (admission closes), and after the restart the retry with the same operation
// ID applies exactly once, whether the commit had happened or not; a killed service leaves no Space process behind.
// This file runs the TypeScript Space process, or the binary FILES_SPACE_SERVER names; `npm run test:space` runs every
// suite against one (tests/support/space-mode.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilesService, tenantAlias, type FaultPoint } from "../server/service.ts";
import { T } from "../server/schema.ts";

// the TypeScript Space process, or the binary FILES_SPACE_SERVER names (the Rust files-space)
const bin = process.env.FILES_SPACE_SERVER;
const SPACE_HOST = bin && bin !== "ts" ? [bin] : [process.execPath, "--no-warnings", "--experimental-strip-types", fileURLToPath(new URL("../server/space-host.ts", import.meta.url))];
const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) => {
	for (const end = Date.now() + ms; !(await ok());) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 25)); }
};

function dirs() {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-sp-"));
	return { root, o: { dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "blobs"), spaceProcess: SPACE_HOST, saveTxnLeaseMs: 300 } };
}

/** Calls until the reopened tenant has let the dead transactions lapse (`unavailable` meanwhile). */
async function retrying<T>(f: () => Promise<T>): Promise<T> {
	for (let i = 0; ; i++) {
		try { return await f(); }
		catch (e) { if ((e as { code?: string }).code !== "unavailable" || i > 200) throw e; await new Promise((r) => setTimeout(r, 25)); }
	}
}

test("the tenant Spaces run in the Space process, on a socket in the data directory", async () => {
	const d = dirs();
	const s = await FilesService.open(d.o);
	try {
		assert.ok(s.store.pid !== undefined && alive(s.store.pid));
		assert.equal(s.store.where, `unix:${join(d.o.dataDir, "space.sock")}`);
		assert.equal(statSync(d.o.dataDir).mode & 0o777, 0o700, "only the service user reaches the socket");
		await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
		const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
		await s.write(lea, "lea", "a.md", Buffer.from("hi"), 0, (await s.issueOperationIds(lea, 1))[0]);
		assert.deepEqual(await s.tenants(), ["acme"]);
		assert.ok((await s.health()).store, "the service reads the store's sizes from the file");
		assert.ok(await s.compact() !== undefined);
		const pid = s.store.pid!;
		await s.close();
		assert.equal(alive(pid), false, "close stops the Space process");
		const again = await FilesService.open(d.o);
		try { assert.equal((await again.read(lea, "lea", "a.md")).bytes.toString(), "hi"); }
		finally { await again.close(); }
	} finally { await s.close(); rmSync(d.root, { recursive: true, force: true }); }
});

for (const [point, committed] of [["commit:before", false], ["commit:after", true]] as const) {
	test(`the Space process killed ${committed ? "after the commit, before its reply" : "as the commit is sent"}: unknown outcome, then the retry applies once`, async () => {
		const d = dirs();
		let armed: FaultPoint | null = null;
		let s: FilesService | undefined;
		const kill = async () => { const pid = s!.store.pid!; process.kill(pid, "SIGKILL"); await until("the Space process to die", () => !alive(pid)); };
		s = await FilesService.open({ ...d.o, faultHook: async (p) => {
			if (p !== armed) return;
			armed = null;
			await kill();
			// after the commit its reply was on the way: for the service it is lost all the same
			if (p === "commit:after") throw new Error("the reply was lost");
		} });
		try {
			await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
			const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
			const [first, op] = await s.issueOperationIds(lea, 2);
			assert.deepEqual(await s.write(lea, "lea", "f.md", Buffer.from("one"), 0, first), { version: 1 });
			armed = point;
			await assert.rejects(s.write(lea, "lea", "f.md", Buffer.from("two"), 1, op), code("unavailable"));
			assert.equal(s.admission.open, false, "admission is closed: the outcome is unknown, and the Space process is gone");
			await assert.rejects(s.read(lea, "lea", "f.md"), code("unavailable"));
			await s.close();

			// the restart: a new Space process on the same store; sessions and operation IDs live in the deployment state
			s = await FilesService.open(d.o);
			const seen = await retrying(() => s!.read(lea, "lea", "f.md"));
			assert.equal(seen.version, committed ? 2 : 1, committed ? "the commit happened" : "the commit never arrived");
			assert.deepEqual(await retrying(() => s!.write(lea, "lea", "f.md", Buffer.from("two"), 1, op)), { version: 2 }, "the retry with the same operation ID");
			assert.deepEqual(await s.write(lea, "lea", "f.md", Buffer.from("two"), 1, op), { version: 2 }, "and again, from its receipt");
			const now = await s.read(lea, "lea", "f.md");
			assert.deepEqual([now.version, now.bytes.toString()], [2, "two"]);
			assert.equal(await s.store.space(tenantAlias("acme")).count({ type: T.receipt, fields: { operationId: op } }), 1, "applied once");
		} finally { await s?.close(); rmSync(d.root, { recursive: true, force: true }); }
	});
}

test("a killed service leaves no Space process behind, and the next start opens the store", async () => {
	const d = dirs();
	try {
		const driver = fileURLToPath(new URL("./support/space-orphan-driver.ts", import.meta.url));
		const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", driver, d.o.dataDir, d.o.stateDir, d.o.blobDir, JSON.stringify(SPACE_HOST)], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_TEST_CONTEXT: "" } });
		const pid = await new Promise<number>((resolve, reject) => {
			let out = "";
			child.stdout.on("data", (b) => { out += b; const m = /space (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
			child.once("exit", () => reject(new Error(`the driver ended: ${out}`)));
		});
		assert.ok(alive(pid));
		child.kill("SIGKILL");
		await until("the orphaned Space process to end", () => !alive(pid));
		const s = await FilesService.open(d.o);
		try { assert.deepEqual(await s.tenants(), ["acme"]); }
		finally { await s.close(); }
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

const RUST = fileURLToPath(new URL("../rust/target/release/files-space", import.meta.url));
test("one store from the TypeScript Space process to the Rust one and back", { skip: !existsSync(RUST) && "no rust/target/release/files-space (cargo build --release in spaces-files/rust)" }, async () => {
	const d = dirs();
	const TS = [process.execPath, "--no-warnings", "--experimental-strip-types", fileURLToPath(new URL("../server/space-host.ts", import.meta.url))];
	try {
		let s = await FilesService.open({ ...d.o, spaceProcess: TS });
		await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
		const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
		const put = async (v: number, text: string) => s.write(lea, "lea", "f.md", Buffer.from(text), v, (await s.issueOperationIds(lea, 1))[0]);
		await put(0, "ts");
		await s.close();
		for (const [cmd, v, text] of [[[RUST], 1, "rust"], [TS, 2, "ts again"]] as const) {
			s = await FilesService.open({ ...d.o, spaceProcess: cmd });
			try {
				assert.equal((await s.read(lea, "lea", "f.md")).version, v);
				assert.deepEqual(await put(v, text), { version: v + 1 });
				await s.createTenant(`t${v}`, { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
				assert.deepEqual(await s.tenants(), ["acme", ...(v === 2 ? ["t1", "t2"] : ["t1"])]);
			} finally { await s.close(); }
		}
		s = await FilesService.open({ ...d.o, spaceProcess: [RUST] });
		try { assert.equal((await s.read(lea, "lea", "f.md")).bytes.toString(), "ts again"); }
		finally { await s.close(); }
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});
