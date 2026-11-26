// The standby on another machine (docs/zanzibar-agent-filesystem-plan.en.md, section 6.7): server/standby-host.ts as a
// process of its own, reached over mutual TLS (server/standby-net.ts). After a mix of changes every table, both key
// files and the blobs are the same there; a client certificate the standby does not know is refused, so the service
// does not open; a standby that dies closes admission and nothing more is answered; the next start seeds it anew.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CONTENT_KEYS_FILE, KEYS_FILE, STATE_FILE } from "../server/deployment.ts";
import { FilesService } from "../server/service.ts";
import { netStandby } from "../server/standby-net.ts";

const HOST = fileURLToPath(new URL("../server/standby-host.ts", import.meta.url));
const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };

function cert(dir: string, name: string, cn: string): { cert: string; key: string; certFile: string; keyFile: string } {
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`,
		"-days", "2", "-subj", `/CN=${cn}`, "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { cwd: dir, stdio: "ignore" });
	return { cert: readFileSync(join(dir, `${name}.pem`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8"), certFile: join(dir, `${name}.pem`), keyFile: join(dir, `${name}.key`) };
}

function tables(stateDir: string): Record<string, unknown[]> {
	const db = new DatabaseSync(join(stateDir, STATE_FILE), { readOnly: true });
	try {
		const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
		return Object.fromEntries(names.map((n) => {
			const cols = (db.prepare(`PRAGMA table_info("${n}")`).all() as Array<{ cid: number }>).map((c) => c.cid + 1).join(", ");
			return [n, db.prepare(`SELECT * FROM "${n}" ORDER BY ${cols}`).all().map((r) => ({ ...r }))];
		}));
	} finally { db.close(); }
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-standby-net-"));
	const tlsDir = join(root, "tls");
	execFileSync("mkdir", ["-m", "700", tlsDir]);
	const primary = cert(tlsDir, "primary", "files-primary"), standby = cert(tlsDir, "standby", "localhost"), stranger = cert(tlsDir, "stranger", "stranger");
	const a = { dataDir: join(root, "a", "data"), stateDir: join(root, "a", "state"), blobDir: join(root, "a", "blobs") };
	const b = { stateDir: join(root, "b", "state"), blobDir: join(root, "b", "blobs") };
	return { root, primary, standby, stranger, a, b };
}

async function startStandby(o: ReturnType<typeof setup>): Promise<{ child: ChildProcess; port: number }> {
	const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", HOST, "--state", o.b.stateDir, "--blobs", o.b.blobDir,
		"--listen", "127.0.0.1:0", "--cert", o.standby.certFile, "--key", o.standby.keyFile, "--ca", o.primary.certFile], { stdio: ["ignore", "pipe", "inherit"] });
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		child.stdout!.on("data", (c: Buffer) => { out += c; const m = /ready on [^:]+:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
		child.once("exit", (c) => reject(new Error(`the standby ended (${c})`)));
	});
	return { child, port };
}
const stop = (c: ChildProcess) => new Promise<void>((r) => { if (c.exitCode !== null) return r(); c.once("exit", () => r()); c.kill("SIGKILL"); });
const target = (o: ReturnType<typeof setup>, port: number, who = o.primary) =>
	netStandby({ host: "127.0.0.1", port, servername: "localhost", tls: { cert: who.cert, key: who.key, ca: o.standby.cert }, timeoutMs: 5000 });

test("over mutual TLS every table, both key files and the blobs reach a standby process", async () => {
	const o = setup();
	const { child, port } = await startStandby(o);
	try {
		const s = await FilesService.open({ ...o.a, standby: target(o, port) });
		try {
			await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
			const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
			const ids = await s.issueOperationIds(lea, 2);
			await s.write(lea, "lea", "a.md", Buffer.from("one"), 0, ids[0]);
			await s.write(lea, "lea", "b.md", Buffer.from("two"), 0, ids[1]);
			s.state.rotateKey(60_000);
			s.state.rotateContentKey();
			s.state.rosterAdd("acme", "i", "ops");
			s.state.operatorAudit("test.net", { n: 1 });
			assert.deepEqual(tables(o.b.stateDir), tables(o.a.stateDir));
			for (const f of [KEYS_FILE, CONTENT_KEYS_FILE]) assert.deepEqual(readFileSync(join(o.b.stateDir, f)), readFileSync(join(o.a.stateDir, f)), f);
			const list = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((p) => /\/[A-Za-z0-9_-]{22}$/.test(p)).sort();
			assert.deepEqual(list(o.b.blobDir), list(o.a.blobDir));
			assert.equal(list(o.b.blobDir).length, 2);
		} finally { await s.close(); }
	} finally { await stop(child); rmSync(o.root, { recursive: true, force: true }); }
});

test("a client certificate the standby does not know is refused: the service does not open", async () => {
	const o = setup();
	const { child, port } = await startStandby(o);
	try {
		await assert.rejects(FilesService.open({ ...o.a, standby: target(o, port, o.stranger) }), code("unavailable"));
		// and a standby whose certificate the primary does not pin is refused from this side
		const wrongPin = netStandby({ host: "127.0.0.1", port, servername: "localhost", tls: { cert: o.primary.cert, key: o.primary.key, ca: o.stranger.cert }, timeoutMs: 5000 });
		await assert.rejects(FilesService.open({ ...o.a, standby: wrongPin }), code("unavailable"));
	} finally { await stop(child); rmSync(o.root, { recursive: true, force: true }); }
});

test("a standby that dies closes admission; the next start seeds it anew", async () => {
	const o = setup();
	let { child, port } = await startStandby(o);
	try {
		const s = await FilesService.open({ ...o.a, standby: target(o, port) });
		try {
			await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
			await stop(child);
			await assert.rejects(s.login("acme", "user", { issuer: "i", subject: "lea" }), code("unavailable"), "no handle is handed out");
			assert.equal(s.admission.open, false, "admission is closed");
			assert.equal((tables(o.b.stateDir).sessions ?? []).length, 0, "the standby never has the session");
		} finally { await s.close(); }
		// the standby comes back on the same directories (another port), the primary starts again and seeds it
		({ child, port } = await startStandby(o));
		const again = await FilesService.open({ ...o.a, standby: target(o, port) });
		try {
			const lea = (await again.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
			assert.ok(lea);
			assert.deepEqual(tables(o.b.stateDir), tables(o.a.stateDir));
		} finally { await again.close(); }
	} finally { await stop(child); rmSync(o.root, { recursive: true, force: true }); }
});
