// Password sign-in and plain HTTP behind a TLS proxy (server/passwords.ts, server/http.ts): a username is the subject of
// the issuer `local`; a wrong password, an unknown username and a request from another origin change nothing; failed
// attempts lock a username for a window; plain HTTP listens only on a loopback address, the public origin stays https.
import test from "node:test";
import assert from "node:assert/strict";
import { serveHttp } from "../server/http.ts";
import { Attempts, hashPassword, LOCAL_ISSUER, verifyPassword } from "../server/passwords.ts";
import { FilesService } from "../server/service.ts";
import { Browser, freePort } from "./support/browser.ts";

const ORIGIN = "https://files.example";
const PW = "correct horse battery";

async function setup() {
	const clock = { t: Date.now() };
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, now: () => clock.t });
	await svc.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: LOCAL_ISSUER, subject: "lea" });
	svc.state.setPassword("lea", await hashPassword(PW));
	const port = await freePort();
	const http = await serveHttp(svc, { listen: { host: "127.0.0.1", port }, origin: ORIGIN, attempts: new Attempts({ perUser: 3, windowMs: 60_000, now: () => clock.t }), now: () => clock.t });
	const browser = () => new Browser(ORIGIN, `http://127.0.0.1:${port}`);
	return { svc, clock, browser, done: async () => { await http.close(); await svc.close(); } };
}

test("hashes: scrypt with a salt each, a short password refused, an unknown user costs a verification and fails", async () => {
	const a = await hashPassword(PW), b = await hashPassword(PW);
	assert.notEqual(a, b);
	assert.equal(await verifyPassword(PW, a), true);
	assert.equal(await verifyPassword(PW + "x", a), false);
	assert.equal(await verifyPassword(PW, null), false);
	await assert.rejects(hashPassword("short"), /at least 12/);
});

test("password sign-in over plain HTTP behind the proxy: the form, a session, and the cookie as before", async () => {
	const { browser, done } = await setup();
	try {
		const lea = browser();
		const form = await lea.request("GET", "/auth/login");
		assert.equal(form.status, 200);
		assert.match(form.body, /type="password"/);
		const ok = await lea.passwordSignIn("lea", PW);
		assert.equal(ok.status, 200);
		const set = ([] as string[]).concat(ok.headers["set-cookie"] ?? []).find((c) => c.startsWith("__Host-files="))!;
		for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) assert.ok(set.includes(attr), attr);
		assert.equal(ok.headers["strict-transport-security"], "max-age=31536000", "the public origin is https");
		assert.deepEqual(await lea.must("workspaces"), ["lea"]);
		// usernames are case-insensitive on the way in
		const again = browser();
		assert.equal((await again.passwordSignIn("LEA", PW)).status, 200);
		assert.deepEqual(await again.must("workspaces"), ["lea"]);
	} finally { await done(); }
});

test("a wrong password, an unknown user and another origin change nothing; failures lock a username for a window", async () => {
	const { svc, clock, browser, done } = await setup();
	try {
		const b = browser();
		assert.equal((await b.passwordSignIn("lea", "wrong password!!")).status, 401);
		assert.equal((await b.passwordSignIn("nobody", PW)).status, 401);
		assert.equal((await b.passwordSignIn("../lea", PW)).status, 401);
		assert.equal(b.jar.has("__Host-files"), false);
		const cross = await b.request("POST", "/auth/password", { body: `username=lea&password=${encodeURIComponent(PW)}`, headers: { "content-type": "application/x-www-form-urlencoded" }, origin: "https://evil.example" });
		assert.equal(cross.status, 403);
		assert.equal(b.jar.has("__Host-files"), false);
		// one failure so far for lea; the third locks her, and then even the right password is refused unchecked
		assert.equal((await b.passwordSignIn("lea", "wrong again!!!")).status, 401);
		assert.equal((await b.passwordSignIn("lea", "wrong a third!")).status, 401);
		assert.equal((await b.passwordSignIn("lea", PW)).status, 429);
		assert.equal(b.jar.has("__Host-files"), false);
		clock.t += 61_000;
		assert.equal((await b.passwordSignIn("lea", PW)).status, 200, "the window has passed");
		// a removed password signs in no more
		svc.state.removePassword("lea");
		assert.equal((await browser().passwordSignIn("lea", PW)).status, 401);
	} finally { await done(); }
});

test("plain HTTP only on a loopback address; the public origin only https", async () => {
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	try {
		await assert.rejects(serveHttp(svc, { listen: { host: "0.0.0.0", port: 0 }, origin: ORIGIN }), /loopback/);
		await assert.rejects(serveHttp(svc, { listen: { host: "127.0.0.1", port: 0 }, origin: "http://files.example" }), /https/);
	} finally { await svc.close(); }
});
