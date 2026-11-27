// The join with spaces-files, reading (docs/forum-seite-plan-2026-11-26.en.md, section 6, phase 5), against a real
// spaces-files service with its agent socket (spaces-files/tests/support/agent-host-fixture.ts, started as a process):
// a room linked to granted folders copies them and nothing beside them, a run's writer reads the copy, the agent's own
// folders are refused, each limit holds at its edge, denied names stay out while other kinds are listed by their
// content, a revocation stops the next copy and leaves the taken one, and a sources process killed with a copy taken
// leaves nothing a reader sees.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../server/hub.ts";
import { filesLimits, kindOf, walkFolders, type FilesReader } from "../server/files.ts";
import type { PlanSource } from "../server/sources.ts";
import { startServer } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan an app that shows the starry sky at a time and place.";
const FIXTURE = fileURLToPath(new URL("../../spaces-files/tests/support/agent-host-fixture.ts", import.meta.url));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let seq = 0;
const room = (scenario: string) => `${scenario}-f${process.pid}-${seq++}`;

/** spaces-files in memory with one agent socket; `cmd` sends one fixture command and returns its answer. */
async function filesService() {
	const dir = mkdtempSync(join(tmpdir(), "ff-"));
	chmodSync(dir, 0o700);
	const socket = join(dir, "agent.sock");
	const child: ChildProcess = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", FIXTURE, socket], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
	assert.deepEqual(JSON.parse(String((await lines.next()).value)), { ready: true });
	let chain = Promise.resolve() as Promise<unknown>;
	const cmd = (c: Record<string, unknown>): Promise<{ ok: boolean; value?: any; code?: string; message?: string }> => {
		const next = chain.then(async () => { child.stdin!.write(JSON.stringify(c) + "\n"); return JSON.parse(String((await lines.next()).value)); });
		chain = next.catch(() => {});
		return next as Promise<any>;
	};
	const must = async (c: Record<string, unknown>) => { const r = await cmd(c); assert.ok(r.ok, `${JSON.stringify(c)}: ${r.message}`); return r.value; };
	return { socket, cmd, must, env: { FORUM_FILES_SOCKET: socket, FORUM_FILES_TENANT: "acme", FORUM_FILES_HOST: "forum-host" },
		async close() { child.stdin!.end(); await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); }); child.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); } };
}

const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const getJson = async (url: string, path: string) => (await (await fetch(url + path)).json()) as any;
const snapshot = (url: string, id: string) => getJson(url, `/api/rooms/${id}`) as Promise<Snapshot>;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 40_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** The fixture's folders for a room: `ref` (only read) and `sky/plan` (the project), with things beside both. */
async function material(f: Awaited<ReturnType<typeof filesService>>, agent: string) {
	await f.must({ op: "workspace", name: "ref" });
	await f.must({ op: "workspace", name: "sky" });
	await f.must({ op: "workspace", name: "private" });
	await f.must({ op: "write", ws: "ref", path: "catalogue.csv", text: "id,name,magnitude\nM31,Andromeda Galaxy,3.4\nM42,Orion Nebula,4.0\n" });
	await f.must({ op: "write", ws: "sky", path: "plan/needs.md", text: "# Needs\nShow every Messier object above the horizon.\nComets come from the MPC.\n" });
	await f.must({ op: "write", ws: "sky", path: "plan/photo.jpg", base64: JPEG.toString("base64") });
	await f.must({ op: "write", ws: "sky", path: "plan/chart.txt", base64: PNG.toString("base64") }); // a picture whose name says text
	await f.must({ op: "write", ws: "sky", path: "plan/.env", text: "KEY=secret-of-the-folder\n" });
	await f.must({ op: "write", ws: "sky", path: "plan/notes/deep/later.md", text: "Later: planets.\n" });
	await f.must({ op: "write", ws: "sky", path: "drafts/beside.md", text: "Beside the project folder.\n" });
	await f.must({ op: "write", ws: "private", path: "diary.md", text: "Not granted.\n" });
	await f.must({ op: "grant", ws: "ref", path: ".", relation: "viewer", agent });
	await f.must({ op: "grant", ws: "sky", path: ".", relation: "editor", agent });
}

test("a linked room copies the granted folders and nothing beside them, and the writer reads the copy", async (t) => {
	const f = await filesService();
	const srv = await startServer();
	t.after(async () => { await srv.close(); await f.close(); });
	await srv.stack.sources({ env: f.env });
	const id = room("workspace"), agent = `room-${id}`;
	await until("the sources process to offer spaces-files", async () => (await getJson(srv.url, `/api/rooms/${id}/link`)).files);
	assert.deepEqual(await getJson(srv.url, `/api/rooms/${id}/link`), { agent, files: { tenant: "acme", host: "forum-host" }, link: null });

	// before the agent is registered, spaces-files does not know it; registered, it sees its own home only, which is offered
	// as nothing
	const notYet = await post(srv.url, `/api/rooms/${id}/link`, { action: "check" });
	assert.equal(notYet.status, 400);
	assert.match(notYet.body.error, /not registered in spaces-files.*\(unauthenticated\)/);
	await f.must({ op: "agent", id: agent });
	assert.deepEqual((await post(srv.url, `/api/rooms/${id}/link`, { action: "check" })).body.check, { agent, workspaces: [], folders: [] });
	// a task cannot ask for the workspace before the room is linked
	assert.match((await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, files: true })).body.error, /not linked/);

	await material(f, agent);
	const checked = await post(srv.url, `/api/rooms/${id}/link`, { action: "check", read: { workspace: "ref" }, project: { workspace: "sky", path: "plan" } });
	assert.deepEqual(checked.body.check, { agent, workspaces: ["ref", "sky"], folders: [{ role: "read", workspace: "ref", path: "", entries: 1 }, { role: "project", workspace: "sky", path: "plan", entries: 5 }] });
	// the agent's own home, a workspace it owns, and one it was not granted are refused
	const refused = async (project: Record<string, string>, why: RegExp) => { const r = await post(srv.url, `/api/rooms/${id}/link`, { action: "link", project }); assert.equal(r.status, 400); assert.match(r.body.error, why); };
	await refused({ workspace: agent }, /owns it; a room must never be able to grant what it reads/);
	await f.must({ op: "workspace", name: "owned", owner: agent });
	await refused({ workspace: "owned" }, /owns it/);
	await refused({ workspace: "private" }, /cannot see it.*\(notFound\)/);
	await refused({ workspace: "sky", path: "../ref" }, /not a path in the workspace/);
	assert.equal((await snapshot(srv.url, id)).link, null);

	const linked = await post(srv.url, `/api/rooms/${id}/link`, { action: "link", read: { workspace: "ref" }, project: { workspace: "sky", path: "plan" } });
	assert.equal(linked.status, 200, JSON.stringify(linked.body));
	assert.deepEqual((await snapshot(srv.url, id)).link, { tenant: "acme", read: { workspace: "ref", path: "" }, project: { workspace: "sky", path: "plan" } });
	assert.ok((await snapshot(srv.url, id)).lines.some((l) => /linked the room to the workspace: reading ref, project folder sky\/plan/.test(l.text)));

	const created = await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, files: true });
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const block = (await snapshot(srv.url, id)).blocks[0]!;
	const src = block.sources[0] as PlanSource;
	assert.deepEqual([src.sourceId, src.kind, src.files, src.texts, src.tenant], ["files", "files", 5, 3, "acme"]);
	// every file of the two folders by its content, the denied name left out, nothing beside the folders
	assert.deepEqual((await getJson(srv.url, `/api/rooms/${id}/files/${block.blockId}`)).files, [
		{ path: "project/chart.txt", size: PNG.length, kind: "png" },
		{ path: "project/needs.md", size: 79, kind: "text" },
		{ path: "project/notes/deep/later.md", size: 16, kind: "text" },
		{ path: "project/photo.jpg", size: JPEG.length, kind: "jpeg" },
		{ path: "reference/catalogue.csv", size: 64, kind: "text" }]);
	const stored = JSON.stringify((await srv.stack.space.readAll({ type: "SourceFile", fields: { session: id } }, { limit: 50 })).map((e) => e.fields));
	for (const absent of ["secret-of-the-folder", "Beside the project folder", "Not granted"]) assert.ok(!stored.includes(absent), absent);

	// a run: the outline lists the copy, reads a text, asks for the picture it cannot read and searches
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { blockId: block.blockId, models: THREE, budgetTokens: 50_000 })).status, 200);
	await until("the run's end", async () => { const s = await snapshot(srv.url, id); return s.run && !s.run.active; }, 60_000);
	const calls = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id } }, { limit: 40 })).map((e) => e.fields as unknown as { kind: string; read: boolean; prompt: string });
	const first = calls.find((c) => c.kind === "outline" && !c.read)!.prompt, second = calls.find((c) => c.kind === "outline" && c.read)!.prompt;
	assert.match(first, /- files: a copy of the room's workspace \(reference\/: material that is only read, project\/: the project's folder; 3 files as text/);
	assert.ok(second.includes("> list project/\nproject: 1 directories, 3 files\nnotes/  (1 files)\nchart.txt  (16 bytes, png, not readable here)\nneeds.md  (79 bytes)\nphoto.jpg  (12 bytes, jpeg, not readable here)"), second);
	assert.ok(second.includes("> read project/needs.md\nproject/needs.md (lines 1-3 of 3)\n# Needs\nShow every Messier object above the horizon."));
	assert.ok(second.includes("> read project/photo.jpg\nproject/photo.jpg is a file of kind jpeg with 12 bytes; only its name, kind and size are known here"));
	assert.ok(second.includes('> search Messier\n"Messier": 1 lines\nproject/needs.md:2: Show every Messier object above the horizon.'));
	for (const type of ["FilesRequest", "FilesResult"]) assert.equal(await srv.stack.space.count({ type, fields: { session: id } }), 0, type);
});

test("a revocation stops the next copy and leaves the taken one; unlinking says so in the room", async (t) => {
	const f = await filesService();
	const srv = await startServer();
	t.after(async () => { await srv.close(); await f.close(); });
	await srv.stack.sources({ env: f.env });
	const id = room("plain"), agent = `room-${id}`;
	await f.must({ op: "agent", id: agent });
	await material(f, agent);
	await until("the sources process to offer spaces-files", async () => (await getJson(srv.url, `/api/rooms/${id}/link`)).files);
	assert.equal((await post(srv.url, `/api/rooms/${id}/link`, { action: "link", read: { workspace: "ref" }, project: { workspace: "sky", path: "plan" } })).status, 200);
	assert.equal((await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, files: true })).status, 200);
	const taken = (await snapshot(srv.url, id)).blocks[0]!;

	await f.must({ op: "revoke", ws: "ref", path: ".", relation: "viewer", agent });
	const next = await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, files: true });
	assert.equal(next.status, 400);
	assert.match(next.body.error, /cannot see it.*\(notFound\)/);
	assert.equal((await snapshot(srv.url, id)).blocks.length, 1);
	// the copy taken before is still the task's, and still read
	assert.equal((await getJson(srv.url, `/api/rooms/${id}/files/${taken.blockId}`)).files.length, 5);
	const { askSources } = await import("../server/source-host.ts");
	const read = await askSources(srv.stack.space, { requestId: `r-${id}`, session: id, blockId: taken.blockId, op: "call", sourceId: "files", call: { op: "read", path: "reference/catalogue.csv" }, ts: Date.now() });
	assert.match(read.text!, /M31,Andromeda Galaxy/);

	assert.equal((await post(srv.url, `/api/rooms/${id}/link`, { action: "unlink" })).status, 200);
	const s = await snapshot(srv.url, id);
	assert.equal(s.link, null);
	assert.ok(s.lines.some((l) => /unlinked the room from the workspace; tasks keep the copies they took/.test(l.text)));
});

test("a sources process killed with a copy taken: another one copies again, and nothing of the first attempt is read", async (t) => {
	const f = await filesService(), marker = join(mkdtempSync(join(tmpdir(), "ff-pause-")), "held");
	const srv = await startServer();
	t.after(async () => { await srv.close(); await f.close(); await rm(join(marker, ".."), { recursive: true, force: true }); });
	const env = { ...f.env, FORUM_TEST: "1", FORUM_TEST_FILES_PAUSE: marker };
	const first = await srv.stack.sources({ env, leaseMs: 1500 });
	const id = room("plain"), agent = `room-${id}`;
	await f.must({ op: "agent", id: agent });
	await material(f, agent);
	await until("the sources process to offer spaces-files", async () => (await getJson(srv.url, `/api/rooms/${id}/link`)).files);
	assert.equal((await post(srv.url, `/api/rooms/${id}/link`, { action: "link", read: { workspace: "ref" }, project: { workspace: "sky", path: "plan" } })).status, 200);
	const creating = post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, files: true });
	await until("the first sources process to hold the copy", async () => existsSync(marker));
	assert.equal(await srv.stack.space.count({ type: "SourceFile", fields: { session: id } }), 1, "the first part was written");
	await srv.stack.kill(first, "SIGKILL");
	await srv.stack.sources({ env, leaseMs: 1500 }); // the marker is there: this one does not hold
	const created = await creating;
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const src = (await srv.stack.space.readAll({ type: "PlanSource", fields: { session: id } }, { limit: 5 })).map((e) => e.fields as unknown as PlanSource);
	assert.equal(src.length, 1);
	// the parts and pages there are are the second copy's: three texts in one part each, one index page
	const parts = (await srv.stack.space.readAll({ type: "SourceFile", fields: { session: id } }, { limit: 50 })).map((e) => e.fields as { copy?: string });
	assert.deepEqual([parts.length, new Set(parts.map((p) => p.copy)).size, parts[0]!.copy], [3, 1, src[0]!.copy]);
	assert.equal(await srv.stack.space.count({ type: "SourceIndex", fields: { session: id } }), 1);
});

// ---- the walk's limits, each at its edge (a reader in memory; the same code the sources process runs) ----

/** A tree as spaces-files lists it: paths to bytes; a path ending in / is an empty directory. */
function reader(tree: Record<string, Buffer | string>): FilesReader & { fetched: number } {
	const files = new Map(Object.entries(tree).map(([p, b]) => [p, Buffer.isBuffer(b) ? b : Buffer.from(b)]));
	const r = {
		fetched: 0,
		async listPage(ws: string, path: string, cursor?: string | null) {
			const at = `${ws}/${path === "." ? "" : path}`.replace(/\/$/, "") + "/";
			const names = new Map<string, "dir" | "file">();
			for (const p of files.keys()) if (p.startsWith(at)) { const rest = p.slice(at.length), cut = rest.indexOf("/"); names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? "file" : "dir"); }
			const all = [...names].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, kind]) => ({ name, kind }));
			// two entries a page, so paging is walked too
			const from = cursor ? Number(cursor) : 0;
			return { entries: all.slice(from, from + 2), next: from + 2 < all.length ? String(from + 2) : null };
		},
		async read(ws: string, path: string) { const b = files.get(`${ws}/${path}`)!; r.fetched += b.length; return { bytes: b, version: 1 }; },
	};
	return r;
}
const link = { read: null, project: { workspace: "w", path: "" } };
const lim = (o: Partial<ReturnType<typeof filesLimits>>) => ({ ...filesLimits({}), ...o });

test("the walk: kinds by content, denied names left out, every limit at its edge", async () => {
	assert.deepEqual([kindOf(Buffer.from("# Ä")), kindOf(JPEG), kindOf(PNG), kindOf(Buffer.from("%PDF-1.7")), kindOf(Buffer.from([0xc3, 0x28])), kindOf(Buffer.from("a\0b")), kindOf(Buffer.from("PK\x03\x04"))],
		["text", "jpeg", "png", "pdf", "binary", "binary", "zip"]);
	const walked = await walkFolders(reader({ "w/a.md": "A", "w/.env": "X=1", "w/k/id_rsa": "k", "w/pic.md": PNG, "w/big.txt": "x".repeat(200_001), "w/sub/b.md": "B" }), link);
	assert.deepEqual(walked.map((x) => [x.path, x.kind, x.text !== undefined]), [["project/a.md", "text", true], ["project/big.txt", "text (too large to copy)", false], ["project/pic.md", "png", false], ["project/sub/b.md", "text", true]]);

	const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`w/f${String(i).padStart(3, "0")}.md`, "x"]));
	assert.equal((await walkFolders(reader(many(10)), link, lim({ files: 10 }))).length, 10);
	await assert.rejects(walkFolders(reader(many(11)), link, lim({ files: 10 })), /more than 10 files/);
	const deep = (n: number) => ({ [`w/${Array.from({ length: n - 1 }, (_, i) => `d${i}`).join("/")}/x.md`]: "x" });
	assert.equal((await walkFolders(reader(deep(8)), link, lim({ depth: 8 }))).length, 1);
	await assert.rejects(walkFolders(reader(deep(9)), link, lim({ depth: 8 })), /deeper than 8 levels/);
	assert.equal((await walkFolders(reader({ "w/a.md": "x".repeat(600), "w/b.md": "x".repeat(400) }), link, lim({ textBytes: 1000 }))).length, 2);
	await assert.rejects(walkFolders(reader({ "w/a.md": "x".repeat(600), "w/b.md": "x".repeat(401) }), link, lim({ textBytes: 1000 })), /more than 1 kB together/);
	assert.equal((await walkFolders(reader({ "w/a.bin": Buffer.alloc(1_000_000, 1) }), link, lim({ readBytes: 1_000_000 }))).length, 1);
	await assert.rejects(walkFolders(reader({ "w/a.bin": Buffer.alloc(1_000_001, 1) }), link, lim({ readBytes: 1_000_000 })), /more than 1 MB/);
});
