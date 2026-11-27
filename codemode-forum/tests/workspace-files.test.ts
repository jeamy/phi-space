// Files that are not text, from and into the room's workspace (docs/forum-seite-plan-2026-11-26.en.md, section 6,
// phase 6), against a real spaces-files (tests/support/files-service.ts): an upload sent again after a lost reply,
// and one whose sources process died after the write, is one file; a taken name gets a number; a name that lies is
// told by the contents; a revoked editor is refused in words. A picture of the workspace is shown as a picture and
// nothing else is. A PDF's text is taken out by the isolated sandbox, with its pages, and found by `search` with its
// page; a scanned, an encrypted, a broken one and one over the limit each say what they are; without a sandbox none
// is opened. A note on a file without text reaches the models. The sandbox's child reaches no file, not the Space's
// socket and no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../server/hub.ts";
import { startPdfWorker } from "../server/pdf-worker.ts";
import { extractIsolated, namespaces, spawnIsolated } from "../server/sandbox-host.ts";
import { startServer } from "./stack.ts";
import { filesService, type FilesService } from "./support/files-service.ts";
import { makePdf } from "./support/pdf.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan an app that shows the starry sky at a time and place.";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const iso = namespaces();
let seq = 0;
const room = (scenario: string) => `${scenario}-w${process.pid}-${seq++}`;

const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const upload = async (url: string, id: string, uploadId: string, name: string, bytes: Buffer) => {
	const r = await fetch(`${url}/api/rooms/${id}/upload?id=${uploadId}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) });
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

/** A room linked to `sky/plan` (editor) with nothing to read beside it. */
async function linked(srv: Awaited<ReturnType<typeof startServer>>, f: FilesService, id: string) {
	const agent = `room-${id}`;
	await until("the sources process to offer spaces-files", async () => (await getJson(srv.url, `/api/rooms/${id}/link`)).files);
	await f.must({ op: "agent", id: agent });
	await f.cmd({ op: "workspace", name: "sky" });
	await f.must({ op: "write", ws: "sky", path: "plan/needs.md", text: "# Needs\n" });
	await f.must({ op: "grant", ws: "sky", path: ".", relation: "editor", agent });
	const r = await post(srv.url, `/api/rooms/${id}/link`, { action: "link", project: { workspace: "sky", path: "plan" } });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return agent;
}

test("an upload is one file however often it is sent, a taken name gets a number, and a revoked editor is refused", async (t) => {
	const f = await filesService();
	const srv = await startServer({ fakes: THREE });
	const dir = mkdtempSync(join(tmpdir(), "fw-")), marker = join(dir, "upload-paused");
	t.after(async () => { await srv.close(); await f.close(); await rm(dir, { recursive: true, force: true }); });
	const sources = await srv.stack.sources({ env: f.env });
	const id = room("workspace"), agent = await linked(srv, f, id);

	const first = await upload(srv.url, id, "upload-tender-1", "tender.xlsx", Buffer.from("PK\x03\x04 a spreadsheet", "latin1"));
	assert.equal(first.status, 200, JSON.stringify(first.body));
	assert.deepEqual(first.body, { upload: { workspace: "sky", path: "plan/material/tender.xlsx", version: 1, kind: "zip", bytes: 18 }, again: false });
	// sent again after a lost reply: answered with the same file
	assert.deepEqual((await upload(srv.url, id, "upload-tender-1", "tender.xlsx", Buffer.from("PK\x03\x04 a spreadsheet", "latin1"))).body, { ...first.body, again: true });
	// another file of the same name gets a number; a name that lies is told by the contents
	assert.equal((await upload(srv.url, id, "upload-tender-2", "tender.xlsx", Buffer.from("PK\x03\x04 another", "latin1"))).body.upload.path, "plan/material/tender (2).xlsx");
	assert.equal((await upload(srv.url, id, "upload-chart-01", "chart.txt", PNG)).body.upload.kind, "png");
	assert.match((await upload(srv.url, id, "upload-secret-1", ".env", Buffer.from("KEY=1"))).body.error, /does not begin with a dot/);
	assert.match((await upload(srv.url, id, "upload-key-0001", "server.pem", Buffer.from("x"))).body.error, /Not a file to share/);
	assert.deepEqual((await f.must({ op: "list", ws: "sky", path: "plan/material" })).map((e: { name: string }) => e.name).sort(), ["chart.txt", "tender (2).xlsx", "tender.xlsx"]);
	assert.ok((await snapshot(srv.url, id)).lines.some((l) => /uploaded tender\.xlsx to sky\/plan\/material\/tender\.xlsx \(zip, 1 kB\)/.test(l.text)));

	// the sources process dies after spaces-files wrote the file and before its answer: the next one sends the same
	// write under the same operation ID, and spaces-files answers it from its receipt
	await srv.stack.kill(sources);
	const holding = await srv.stack.sources({ env: { ...f.env, FORUM_TEST: "1", FORUM_TEST_UPLOAD_PAUSE: marker } });
	const pending = upload(srv.url, id, "upload-photo-01", "photo.jpg", JPEG);
	await until("the write to be made", async () => existsSync(marker));
	await srv.stack.kill(holding, "SIGKILL");
	await srv.stack.sources({ env: f.env });
	const after = await pending;
	assert.equal(after.status, 200, JSON.stringify(after.body));
	assert.deepEqual([after.body.upload.path, after.body.upload.version, after.body.upload.kind], ["plan/material/photo.jpg", 1, "jpeg"]);
	assert.deepEqual((await f.must({ op: "list", ws: "sky", path: "plan/material" })).map((e: { name: string }) => e.name).sort(), ["chart.txt", "photo.jpg", "tender (2).xlsx", "tender.xlsx"]);
	assert.equal((await f.must({ op: "read", ws: "sky", path: "plan/material/photo.jpg" })).version, 1);

	// the folder's owner takes editor back: the next upload is refused in words
	await f.must({ op: "revoke", ws: "sky", path: ".", relation: "editor", agent });
	const refused = await upload(srv.url, id, "upload-late-001", "late.md", Buffer.from("late"));
	assert.equal(refused.status, 400);
	assert.match(refused.body.error, /cannot see it|may not|not allowed|permission/i);
});

test("a task's copy: pictures shown as pictures, PDFs read by the sandbox with their pages, notes for the models", { skip: iso ? false : "no isolation on this machine (user namespaces)" }, async (t) => {
	const f = await filesService();
	const srv = await startServer({ fakes: THREE });
	t.after(async () => { await srv.close(); await f.close(); });
	await srv.stack.sources({ env: { ...f.env, FORUM_PDF_MAX_PAGES: "3" } });
	const id = room("workspace");
	await linked(srv, f, id);
	await f.must({ op: "write", ws: "sky", path: "plan/photo.jpg", base64: JPEG.toString("base64") });
	await f.must({ op: "write", ws: "sky", path: "plan/sky.svg", text: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>' });
	await f.must({ op: "write", ws: "sky", path: "plan/tender.xlsx", base64: Buffer.from("PK\x03\x04 a spreadsheet", "latin1").toString("base64") });
	await f.must({ op: "write", ws: "sky", path: "plan/needs.pdf", base64: makePdf([["Needs of the sky app", "Comets come from the MPC."], ["Show every Messier object above the horizon."]]).toString("base64") });
	await f.must({ op: "write", ws: "sky", path: "plan/scan.pdf", base64: makePdf(["scan", "scan"]).toString("base64") });
	await f.must({ op: "write", ws: "sky", path: "plan/locked.pdf", base64: makePdf([["secret"]], { encrypted: true }).toString("base64") });
	await f.must({ op: "write", ws: "sky", path: "plan/broken.pdf", base64: Buffer.from("%PDF-1.4\nnothing that holds\n%%EOF").toString("base64") });
	await f.must({ op: "write", ws: "sky", path: "plan/atlas.pdf", base64: makePdf(Array.from({ length: 4 }, (_, i) => [`chart ${i + 1}`])).toString("base64") });

	// without a sandbox no PDF is opened: the copy says so
	assert.equal((await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, files: true })).status, 200);
	const blind = (await snapshot(srv.url, id)).blocks[0]!.blockId;
	const kinds = async (block: string) => Object.fromEntries(((await getJson(srv.url, `/api/rooms/${id}/files/${block}`)).files as Array<{ path: string; kind: string }>).map((x) => [x.path, x.kind]));
	assert.equal((await kinds(blind))["project/needs.pdf"], "pdf (no sandbox read its text)");

	await srv.stack.sandbox();
	await until("the sandbox to announce itself", async () => srv.stack.space.readIfExists({ type: "SandboxInfo" }, 0));
	assert.equal((await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, files: true })).status, 200);
	const block = (await snapshot(srv.url, id)).blocks[1]!.blockId;
	assert.deepEqual(await kinds(block), {
		"project/atlas.pdf": "pdf (has 4 pages; at most 3 are read)",
		"project/broken.pdf": "pdf (cannot be read (Invalid PDF structure.))",
		"project/locked.pdf": "pdf (is encrypted with a password)",
		"project/needs.md": "text",
		"project/needs.pdf": "pdf, text of 2 pages",
		"project/photo.jpg": "jpeg",
		"project/scan.pdf": "pdf (has 2 pages and no text: it is scanned or holds pictures only)",
		"project/sky.svg": "text",
		"project/tender.xlsx": "zip",
	});

	// a picture of the workspace as a picture, an SVG only as an image that runs nothing, anything else refused
	const pic = await fetch(`${srv.url}/api/rooms/${id}/preview?path=project/photo.jpg`);
	assert.equal(pic.headers.get("content-type"), "image/jpeg");
	assert.ok(Buffer.from(await pic.arrayBuffer()).equals(JPEG));
	const svg = await fetch(`${srv.url}/api/rooms/${id}/preview?path=project/sky.svg`);
	assert.equal(svg.headers.get("content-type"), "image/svg+xml");
	assert.match(svg.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
	assert.match((await getJson(srv.url, `/api/rooms/${id}/preview?path=project/needs.md`)).error, /is no picture \(text\)/);
	assert.match((await getJson(srv.url, `/api/rooms/${id}/preview?path=project/../../etc/passwd`)).error, /Not a file of the linked folders/);

	// a note on the spreadsheet; a run: the writer lists the copy, reads the PDF's text, searches it
	assert.equal((await post(srv.url, `/api/rooms/${id}/filenote`, { path: "project/tender.xlsx", text: "The tender as a spreadsheet; the deadlines are on the second sheet." })).status, 200);
	assert.equal((await getJson(srv.url, `/api/rooms/${id}/files/${block}`)).files.find((x: { path: string }) => x.path === "project/tender.xlsx").note, "The tender as a spreadsheet; the deadlines are on the second sheet.");
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { blockId: block, models: THREE, budgetTokens: 50_000 })).status, 200);
	await until("the run's end", async () => { const s = await snapshot(srv.url, id); return s.run && !s.run.active; }, 60_000);
	const calls = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id } }, { limit: 40 })).map((e) => e.fields as unknown as { kind: string; read: boolean; prompt: string });
	const second = calls.find((c) => c.kind === "outline" && c.read)!.prompt;
	assert.ok(second.includes("needs.pdf  (" ) && second.includes("bytes, pdf, text of 2 pages)"), second);
	assert.ok(second.includes("tender.xlsx  (18 bytes, zip, not readable here; the person's note: The tender as a spreadsheet; the deadlines are on the second sheet.)"), second);
	assert.ok(second.includes('> search Messier\n"Messier": 1 lines\nproject/needs.pdf:6 (page 2): Show every Messier object above the horizon.'), second);
});

test("the sandbox's child reaches no file, not the Space's socket and no network, and reads PDFs there", { skip: iso ? false : "no isolation on this machine (user namespaces)" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "fs-")), sock = join(dir, "space.sock");
	const space = net.createServer((s) => s.end()).listen(sock), outside = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
	t.after(async () => { space.close(); outside.close(); await rm(dir, { recursive: true, force: true }); });
	await new Promise((r) => setTimeout(r, 100));
	const probe = fileURLToPath(new URL("./support/isolation-probe.ts", import.meta.url)), secret = fileURLToPath(new URL("../server/env.ts", import.meta.url));
	const child = spawnIsolated(probe, [sock, secret, "127.0.0.1", String((outside.address() as net.AddressInfo).port)], { iso: iso!, hide: [dir] });
	let out = "";
	child.stdout.on("data", (c: Buffer) => (out += c));
	child.stdin.end();
	await new Promise((r) => child.on("exit", r));
	const got = JSON.parse(out.trim()) as Record<string, string>;
	assert.equal(got.file, "ERR_ACCESS_DENIED");
	assert.ok(["ENOENT", "EACCES", "ECONNREFUSED"].includes(got.socket!), got.socket);
	assert.ok(["ENETUNREACH", "ECONNREFUSED", "EACCES", "timeout"].includes(got.network!), got.network);
	// the same isolation around the reader: a PDF read, and one that never ends is cut at its time
	const r = await extractIsolated(makePdf([["one"], ["two", "three"]]), { pages: 300, textBytes: 2_000_000 }, { iso: iso!, hide: [dir] });
	assert.deepEqual(r, { ok: true, pages: 2, text: "--- page 1 ---\none\n\n--- page 2 ---\ntwo\nthree\n" });
	const slow = await extractIsolated(makePdf(Array.from({ length: 300 }, (_, i) => [`page ${i}`])), { pages: 300, textBytes: 2_000_000 }, { iso: iso!, hide: [dir], timeoutMs: 50 });
	assert.deepEqual(slow, { ok: false, code: "sandbox", message: "reading the PDF took longer than 0 s" });
});

test("the pdf worker of the containers reads a PDF handed over its socket and refuses anything else", { skip: iso ? false : "no isolation on this machine (user namespaces)" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "fp-")), sock = join(dir, "pdf.sock");
	const w = await startPdfWorker(sock, { timeoutMs: 20_000 });
	t.after(async () => { await w.close(); await rm(dir, { recursive: true, force: true }); });
	assert.equal(w.isolation, "unshare");
	const via = { iso: { mode: "worker" as const, socket: sock }, hide: [] };
	assert.deepEqual(await extractIsolated(makePdf([["one"], ["two"]]), { pages: 300, textBytes: 2_000_000 }, via), { ok: true, pages: 2, text: "--- page 1 ---\none\n\n--- page 2 ---\ntwo\n" });
	assert.equal((await extractIsolated(makePdf([["a"], ["b"]]), { pages: 1, textBytes: 2_000_000 }, via) as { code: string }).code, "pages");
	const raw = (text: string) => new Promise<string>((ok) => { let out = ""; const c = net.createConnection(sock, () => c.end(text)); c.on("data", (d) => (out += d)); c.on("close", () => ok(out.trim())); });
	assert.equal(JSON.parse(await raw("GET / HTTP/1.0\n\n")).message, "no request");
	assert.equal(JSON.parse(await raw(JSON.stringify({ pages: 3, textBytes: 1000, bytes: 50 }) + "\n%PDF")).message, "the PDF arrived incomplete");
	assert.match((await extractIsolated(Buffer.from("x"), { pages: 3, textBytes: 1000 }, { iso: { mode: "worker", socket: join(dir, "none.sock") }, hide: [] }) as { message: string }).message, /cannot be reached \(ENOENT\)/);
});
