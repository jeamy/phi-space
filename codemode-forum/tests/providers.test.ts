// Models and their providers from the page (docs/forum-seite-plan-2026-11-26.en.md, section 8, phase 4): a login runs in
// the model process through pi-ai's real Models and the real credential file; what the administrator types crosses the
// space sealed, so the key's bytes are nowhere in the space's file; a wrong answer fails without being quoted back; a
// sign-in shows its link and device code and takes a pasted code; a refreshed token is written to the file and survives
// a restart; a model process killed during a login lets it lapse and does not run it again; the test call and removal.
// The provider is the made-up one of tests/providers.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { startServer, startStack, type Stack } from "./stack.ts";
import { checkLimits, checkRoom, effectiveLimits } from "../server/settings.ts";
import { answerAad, loginKeys, open, seal } from "../server/seal.ts";

const TOKEN = "pw-providers-test";
type Srv = Awaited<ReturnType<typeof startServer>>;
const call = async (srv: Srv, path: string, body?: unknown, token = TOKEN) => {
	const r = await fetch(`${srv.url}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { status: r.status, json: (await r.json()) as any };
};
const until = async <T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> => {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`waited in vain for ${what}`);
		await new Promise((r) => setTimeout(r, 150));
	}
};
type Ctx = { root: string; authFile: string; stack: Stack; srv: Srv; model: ChildProcess };
async function setUp(env: Record<string, string> = {}): Promise<Ctx> {
	process.env.FORUM_ADMIN_PASSWORD = TOKEN;
	const root = mkdtempSync(join(tmpdir(), "forum-providers-"));
	const authFile = join(root, "auth", "credentials.json");
	const stack = await startStack({ dbPath: join(root, "space.sqlite"), model: false, agents: false });
	const model = await stack.model({ fakes: true, providers: true, authFile, env: { FORUM_LLM: "1", ...env } });
	const srv = await startServer({ stack, login: null });
	return { root, authFile, stack, srv, model };
}
const tearDown = async (c: Ctx) => { process.env.FORUM_ADMIN_PASSWORD = ""; await c.srv.close(); await c.stack.close(); rmSync(c.root, { recursive: true, force: true }); };
const procWith = (srv: Srv) => until("a model process with the test provider", async () => ((await call(srv, "/admin/providers")).json.procs as any[]).find((p) => p.providers.some((x: any) => x.id === "forum-test")));
const testProvider = async (srv: Srv) => ((await call(srv, "/admin/providers")).json.procs as any[]).flatMap((p) => p.providers).find((x: any) => x.id === "forum-test");
const loginOf = async (srv: Srv, loginId: string) => ((await call(srv, "/admin/providers")).json.logins as any[]).find((l) => l.loginId === loginId);
/** The next open question of a login, after `seen` prompts. */
const question = (srv: Srv, loginId: string, seen: number) => until(`question ${seen + 1}`, async () => {
	const l = await loginOf(srv, loginId);
	if (l && l.state !== "running") throw new Error(`the login ended: ${l.state} ${l.error ?? ""}`);
	return (l?.prompts ?? []).filter((p: any) => p.prompt).at(seen);
});

test("seal: an answer opens only with the login's key, for the prompt it was sealed to", () => {
	const k = loginKeys(), other = loginKeys();
	const s = seal(k.publicKey, "sk-test-secret", answerAad("l1", "p2", "proc"));
	assert.equal(open(k.privateKey, s, answerAad("l1", "p2", "proc")), "sk-test-secret");
	assert.throws(() => open(k.privateKey, s, answerAad("l1", "p3", "proc")), "another prompt");
	assert.throws(() => open(other.privateKey, s, answerAad("l1", "p2", "proc")), "another login's key");
	assert.ok(!JSON.stringify(s).includes("sk-test-secret"));
});

test("ceilings: a value above the operator's is refused, one saved below a ceiling lowered later is cut to it", () => {
	const c = { perMin: 20, perDay: 500, personTokensPerDay: 1_000_000, runBudgetTokens: 300_000, personWaitS: 120 };
	assert.throws(() => checkLimits({ perMin: 21 }, c), /above the operator's ceiling 20/);
	assert.throws(() => checkLimits({ runBudgetTokens: 300_001 }, c), /above the operator's ceiling/);
	assert.deepEqual(checkLimits({ perMin: 10, runBudgetTokens: 200_000 }, c), { perMin: 10, runBudgetTokens: 200_000 });
	assert.deepEqual(effectiveLimits({ perMin: 10, runBudgetTokens: 200_000 }, { ...c, perMin: 5, runBudgetTokens: 100_000 }), { perMin: 5, perDay: 500, personTokensPerDay: 1_000_000, runBudgetTokens: 100_000 });
	// a token ceiling of 0 is none: any value stands
	assert.deepEqual(checkLimits({ runBudgetTokens: 5_000_000 }, { ...c, runBudgetTokens: 0 }), { runBudgetTokens: 5_000_000 });
	assert.throws(() => checkRoom({ personWaitS: 121 }, { allowed: [], runCeiling: 0, c }), /above the operator's ceiling 120/);
	assert.throws(() => checkRoom({ budgetTokens: 50_000 }, { allowed: [], runCeiling: 40_000, c }), /above the operator's ceiling 40000/);
	assert.throws(() => checkRoom({ models: ["a/1", "a/2"] }, { allowed: ["a/1", "a/2"], runCeiling: 0, c }), /3 to 5/);
});

test("a key login through every kind of prompt; the key crosses sealed and is nowhere in the space's file; removal", async () => {
	const c = await setUp();
	try {
		assert.equal((await call(c.srv, "/admin/providers", undefined, "")).status, 403, "administrators only");
		const proc = await procWith(c.srv);
		assert.equal((await testProvider(c.srv)).state, null);
		const key = `sk-test-${randomBytes(18).toString("hex")}`;
		const { jobId } = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "login", auth: "api_key" })).json;
		const q1 = await question(c.srv, jobId, 0);
		assert.deepEqual(q1.prompt, { type: "select", message: "Which region?", options: [{ id: "eu", label: "Europe" }, { id: "us", label: "America", description: "slower from here" }] });
		assert.ok(q1.publicKey, "a prompt that expects an answer carries the login's key");
		const info = ((await loginOf(c.srv, jobId)).prompts as any[]).find((p) => p.event?.type === "info");
		assert.deepEqual(info.event.links, [{ url: "https://console.example.invalid/keys", label: "Test console" }]);
		assert.equal((await call(c.srv, "/admin/providers/answer", { loginId: jobId, promptId: q1.promptId, value: "eu" })).status, 200);
		const q2 = await question(c.srv, jobId, 1);
		assert.equal(q2.prompt.type, "text");
		await call(c.srv, "/admin/providers/answer", { loginId: jobId, promptId: q2.promptId, value: "team" });
		const q3 = await question(c.srv, jobId, 2);
		assert.equal(q3.prompt.type, "secret");
		await call(c.srv, "/admin/providers/answer", { loginId: jobId, promptId: q3.promptId, value: key });
		const done = await until("the login done", async () => { const l = await loginOf(c.srv, jobId); return l && l.state !== "running" ? l : null; });
		assert.equal(done.state, "done", done.error);
		assert.deepEqual(await until("the stored key", async () => (await testProvider(c.srv))?.stored && (await testProvider(c.srv))), { id: "forum-test", name: "FORUM test provider", models: 1, apiKey: "Test key", oauth: "Sign in with the test account", state: { type: "api_key", source: "stored credential" }, stored: true });
		// the key is in the model process's file (mode 600), and in no file of the space
		assert.equal(statSync(c.authFile).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(c.authFile, "utf8"))["forum-test"].key, key);
		for (const f of ["space.sqlite", "space.sqlite-wal", "space.sqlite-shm"]) {
			let bytes: Buffer; try { bytes = readFileSync(join(c.root, f)); } catch { continue; }
			assert.equal(bytes.indexOf(key), -1, `the key in ${f}`);
			assert.equal(bytes.indexOf(key.slice(8)), -1, `the key's secret part in ${f}`);
		}
		assert.ok(!JSON.stringify((await call(c.srv, "/admin/providers")).json).includes(key.slice(8)));
		// an answer to a question that is no longer open is refused
		assert.match((await call(c.srv, "/admin/providers/answer", { loginId: jobId, promptId: q3.promptId, value: key })).json.error, /no longer open/);
		// a wrong key fails the login, and the message that quoted it comes back without it
		const wrong = `wrong-${randomBytes(9).toString("hex")}`;
		const j2 = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "login", auth: "api_key" })).json.jobId;
		for (const [i, v] of [[0, "us"], [1, "team"], [2, wrong]] as const) await call(c.srv, "/admin/providers/answer", { loginId: j2, promptId: (await question(c.srv, j2, i)).promptId, value: v });
		const failed = await until("the wrong key refused", async () => { const l = await loginOf(c.srv, j2); return l && l.state !== "running" ? l : null; });
		assert.equal(failed.state, "failed");
		assert.match(failed.error, /is not a test key/);
		assert.ok(!failed.error.includes(wrong) && !failed.error.includes(wrong.slice(-12)), failed.error);
		// the test call: a few tokens of the cheapest model, booked
		const t = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "test" })).json.jobId;
		const r = await until("the test result", async () => ((await call(c.srv, "/admin/providers")).json.results as any[]).find((x) => x.jobId === t));
		assert.deepEqual([r.ok, r.model], [true, "forum-test/echo"], r.error);
		// removed: the provider has no credentials, the file no key; the audit names every step, never the key
		const out = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "logout" })).json.jobId;
		await until("the removal", async () => ((await call(c.srv, "/admin/providers")).json.results as any[]).find((x) => x.jobId === out)?.ok);
		await until("no credentials", async () => (await testProvider(c.srv))?.state === null);
		assert.equal(JSON.parse(readFileSync(c.authFile, "utf8"))["forum-test"], undefined);
		assert.match((await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "logout" })).json.error, /no credentials to remove/);
		const audit = (await c.stack.space.readAll({ type: "AdminAudit" }, { limit: 50 })).map((e) => (e.fields as { what: string }).what);
		assert.deepEqual(audit.sort(), ["provider login", "provider login", "provider logout", "provider test"]);
		assert.ok(!JSON.stringify(await c.stack.space.readAll({ type: "AdminAudit" }, { limit: 50 })).includes(key.slice(8)));
	} finally { await tearDown(c); }
});

test("a sign-in: its link, its device code, a pasted code; a refreshed token is kept in the file and survives a restart", async () => {
	const c = await setUp({ FORUM_TEST_OAUTH_EXPIRES_MS: "0" });
	try {
		let proc = await procWith(c.srv);
		const { jobId } = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "login", auth: "oauth" })).json;
		const q = await question(c.srv, jobId, 0);
		assert.equal(q.prompt.type, "manual_code");
		const events = ((await loginOf(c.srv, jobId)).prompts as any[]).filter((p) => p.event).map((p) => p.event);
		assert.deepEqual(events, [{ type: "auth_url", url: "https://auth.example.invalid/authorize?client=forum", instructions: "Open the link and sign in" }, { type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://auth.example.invalid/device", expiresInSeconds: 600 }]);
		await call(c.srv, "/admin/providers/answer", { loginId: jobId, promptId: q.promptId, value: "code-ok" });
		assert.equal((await until("signed in", async () => { const l = await loginOf(c.srv, jobId); return l && l.state !== "running" ? l : null; })).state, "done");
		assert.equal(JSON.parse(readFileSync(c.authFile, "utf8"))["forum-test"].refresh, "refresh-1");
		// the token expired at once: the test call refreshes it, and the refreshed one is written to the file
		const t = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "test" })).json.jobId;
		assert.equal((await until("the test", async () => ((await call(c.srv, "/admin/providers")).json.results as any[]).find((x) => x.jobId === t))).ok, true);
		assert.equal(JSON.parse(readFileSync(c.authFile, "utf8"))["forum-test"].refresh, "refresh-2");
		// a new model process on the same file starts from the refreshed token
		await c.stack.kill(c.model);
		await c.stack.model({ fakes: true, providers: true, authFile: c.authFile, env: { FORUM_LLM: "1" } });
		proc = await until("the new process", async () => ((await call(c.srv, "/admin/providers")).json.procs as any[]).find((p) => p.procId !== proc.procId && p.providers.some((x: any) => x.id === "forum-test" && x.stored)));
		const t2 = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "test" })).json.jobId;
		assert.equal((await until("the test after the restart", async () => ((await call(c.srv, "/admin/providers")).json.results as any[]).find((x) => x.jobId === t2))).ok, true);
		assert.equal(JSON.parse(readFileSync(c.authFile, "utf8"))["forum-test"].refresh, "refresh-2", "not signed in again, not refreshed again");
		// a wrong code is refused without being quoted
		const j3 = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "login", auth: "oauth" })).json.jobId;
		await call(c.srv, "/admin/providers/answer", { loginId: j3, promptId: (await question(c.srv, j3, 0)).promptId, value: "code-not-this-one" });
		const bad = await until("the wrong code refused", async () => { const l = await loginOf(c.srv, j3); return l && l.state !== "running" ? l : null; });
		assert.deepEqual([bad.state, bad.error.includes("code-not-this-one")], ["failed", false]);
	} finally { await tearDown(c); }
});

test("a model process killed during a login: the login lapses, is not run again, and left no credential", async () => {
	const c = await setUp({ FORUM_LOGIN_LEASE_MS: "1500" });
	try {
		const proc = await procWith(c.srv);
		const { jobId } = (await call(c.srv, "/admin/providers/job", { procId: proc.procId, provider: "forum-test", kind: "login", auth: "api_key" })).json;
		const q = await question(c.srv, jobId, 0);
		await c.stack.kill(c.model, "SIGKILL");
		await until("the login lapsed", async () => !(await loginOf(c.srv, jobId)));
		assert.match((await call(c.srv, "/admin/providers/answer", { loginId: jobId, promptId: q.promptId, value: "eu" })).json.error, /no longer open|login is over/);
		// a new process does not take it up again
		await c.stack.model({ fakes: true, providers: true, authFile: c.authFile, env: { FORUM_LLM: "1" } });
		await until("the new process", async () => ((await call(c.srv, "/admin/providers")).json.procs as any[]).some((p) => p.procId !== proc.procId));
		await new Promise((r) => setTimeout(r, 1500));
		const st = (await call(c.srv, "/admin/providers")).json;
		assert.equal(st.logins.filter((l: any) => l.loginId === jobId).length, 0);
		assert.equal(st.pending.length, 0, "the job was taken by the process that died");
		assert.equal(JSON.parse(readFileSync(c.authFile, "utf8"))["forum-test"], undefined);
		// cancelling a login: the page takes its entry, the flow stops
		const p2 = st.procs.find((p: any) => p.procId !== proc.procId);
		const j2 = (await call(c.srv, "/admin/providers/job", { procId: p2.procId, provider: "forum-test", kind: "login", auth: "oauth" })).json.jobId;
		await question(c.srv, j2, 0);
		await call(c.srv, "/admin/providers/cancel", { loginId: j2 });
		const ended = await until("the cancelled login", async () => { const l = await loginOf(c.srv, j2); return l && l.state !== "running" ? l : null; });
		assert.deepEqual([ended.state, ended.error], ["failed", "The login was cancelled"]);
	} finally { await tearDown(c); }
});
