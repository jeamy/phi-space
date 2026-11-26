// The browser and admin adapter (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 5, phase 4, and the
// acceptance case of phases 1 and 4): the sign-in through an OpenID provider with PKCE, state and nonce, the ID-token
// checks, the session cookie, a tenant selector that chooses only among the identity's bindings, two tenants with the
// same user name, expired sessions, and cross-origin or unbound requests that change nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { startDevIdp } from "../server/dev-idp.ts";
import { OidcClient } from "../server/oidc.ts";
import { FilesService } from "../server/service.ts";
import { Browser, webStack } from "./support/browser.ts";

async function setup(o: { maxInflight?: number } = {}) {
	const clock = { t: Date.now() };
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, now: () => clock.t });
	const web = await webStack(svc, o);
	const iss = web.idp.issuer;
	// lea is a user of acme and of globex, with the same name and the same identity in both
	await svc.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: iss, subject: "adm" });
	await svc.createTenant("globex", { actorId: "lea", homeName: "lea", issuer: iss, subject: "lea" });
	await svc.provisionActor("acme", { actorKind: "user", actorId: "adm" }, "user", "lea", "lea", { issuer: iss, subject: "lea" });
	return { svc, web, clock, done: async () => { await web.close(); await svc.close(); } };
}

test("sign-in: one binding enters at once; the session cookie is __Host-, Secure, HttpOnly, SameSite=Strict", async () => {
	const { web, done } = await setup();
	try {
		const adm = web.browser();
		const start = await adm.request("GET", "/auth/login");
		assert.equal(start.status, 302);
		const to = new URL(String(start.headers.location));
		for (const k of ["state", "nonce", "code_challenge"]) assert.ok(to.searchParams.get(k), k);
		assert.equal(to.searchParams.get("code_challenge_method"), "S256");
		const back = new URL(await web.idp.authorize(to.searchParams, "adm"));
		const ok = await adm.request("GET", back.pathname + back.search);
		assert.equal(ok.status, 200);
		assert.equal((await adm.request("GET", back.pathname + back.search)).status, 400, "a state is used once");
		const set = ([] as string[]).concat(ok.headers["set-cookie"] ?? []).find((c) => c.startsWith("__Host-files="))!;
		for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) assert.ok(set.includes(attr), attr);
		const s = await adm.session();
		assert.deepEqual({ tenant: s.json!.value.tenantId, actor: s.json!.value.actor, admin: s.json!.value.admin }, { tenant: "acme", actor: { kind: "user", id: "adm" }, admin: true });
		assert.deepEqual(await adm.must("workspaces"), ["adm"]);
	} finally { await done(); }
});

test("two tenants with the same user name: a choice among the bindings only, a fresh session per tenant", async () => {
	const { svc, web, done } = await setup();
	try {
		const lea = web.browser();
		const choice = await lea.signIn(web.idp, "lea");
		assert.match(choice.body, /Choose a tenant/);
		assert.equal(lea.csrf, "", "no session before the choice");
		// a forged selector: a tenant this identity has no binding in
		const forged = await lea.request("POST", "/auth/select", { body: "tenant=initech", headers: { "content-type": "application/x-www-form-urlencoded" } });
		assert.equal(forged.status, 403);
		const cross = await lea.request("POST", "/auth/select", { body: "tenant=acme", headers: { "content-type": "application/x-www-form-urlencoded" }, origin: "https://evil.example" });
		assert.equal(cross.status, 403);
		assert.equal((await lea.request("POST", "/auth/select", { body: "tenant=acme", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 200);
		await lea.session();
		const first = lea.jar.get("__Host-files")!;
		assert.equal((await lea.session()).json!.value.tenantId, "acme");
		assert.deepEqual(await lea.must("workspaces"), ["lea"]);
		assert.equal((await lea.session()).json!.value.admin, false);
		await lea.must("write", { workspace: "lea", path: "acme.txt", contents: Buffer.from("acme").toString("base64"), expectedVersion: 0, operationId: await lea.opId() });
		// switching is a new sign-in, straight into the named tenant; the old session ends
		await lea.signIn(web.idp, "lea", "globex");
		assert.equal((await lea.session()).json!.value.tenantId, "globex");
		assert.equal(svc.state.lookupSession(first), null, "the earlier session ended");
		const r = await lea.call("read", { workspace: "lea", path: "acme.txt" });
		assert.equal(r.json!.error!.code, "notFound", "globex's lea is another actor");
		// a selector at the start of the sign-in is checked the same way
		const other = web.browser();
		assert.equal((await other.signIn(web.idp, "lea", "initech")).status, 403);
		assert.equal((await other.signIn(web.idp, "nobody")).status, 403, "an identity without a binding");
	} finally { await done(); }
});

test("cross-origin and unbound requests change nothing", async () => {
	const { web, done } = await setup();
	try {
		const adm = web.browser();
		await adm.signIn(web.idp, "adm");
		const args = (id: string) => JSON.stringify({ op: "mkdir", args: { workspace: "adm", path: "x", operationId: id } });
		const json = { "content-type": "application/json" };
		const refused = [
			await adm.request("POST", "/api/call", { body: args(await adm.opId()), headers: { ...json, "x-files-csrf": adm.csrf }, origin: "https://evil.example" }),
			await adm.request("POST", "/api/call", { body: args(await adm.opId()), headers: { ...json, "x-files-csrf": adm.csrf }, origin: null }),
			await adm.request("POST", "/api/call", { body: args(await adm.opId()), headers: { ...json, "x-files-csrf": adm.csrf, "sec-fetch-site": "cross-site" } }),
			await adm.request("POST", "/api/call", { body: args(await adm.opId()), headers: json }),
			await adm.request("POST", "/api/call", { body: args(await adm.opId()), headers: { ...json, "x-files-csrf": "x".repeat(43) } }),
			await adm.request("POST", "/api/call", { body: args(await adm.opId()), headers: { "content-type": "text/plain", "x-files-csrf": adm.csrf } }),
		];
		for (const r of refused) assert.equal(r.status, 403, r.body);
		// another session's token is not this one's
		const lea = web.browser();
		await lea.signIn(web.idp, "lea", "acme");
		assert.equal((await adm.request("POST", "/api/call", { body: args(await adm.opId()), headers: { ...json, "x-files-csrf": lea.csrf } })).status, 403);
		assert.deepEqual(await adm.must("list", { workspace: "adm", path: "." }), [], "nothing was created");
		const logout = await adm.request("POST", "/auth/logout", { origin: "https://evil.example", headers: { "x-files-csrf": adm.csrf } });
		assert.equal(logout.status, 403);
		assert.equal((await adm.session()).status, 200, "still signed in");
		// a cross-site read of the session (and so of its CSRF token) is refused too
		assert.equal((await adm.request("GET", "/api/session", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
		// a sign-in callback this browser did not start (login CSRF) is refused
		const victim = web.browser();
		const start = await lea.request("GET", "/auth/login");
		const cb = new URL(await web.idp.authorize(new URL(String(start.headers.location)).searchParams, "lea"));
		assert.equal((await victim.request("GET", cb.pathname + cb.search)).status, 400);
		assert.equal(victim.jar.get("__Host-files"), undefined);
	} finally { await done(); }
});

test("expired and ended sessions; a body over the bound; the page and nothing else", async () => {
	const { web, clock, done } = await setup();
	try {
		const adm = web.browser();
		await adm.signIn(web.idp, "adm");
		assert.equal((await adm.call("workspaces")).status, 200);
		clock.t += 13 * 3600_000;
		const expired = await adm.call("workspaces");
		assert.equal(expired.status, 401);
		assert.equal(expired.json!.error!.code, "unauthenticated");
		clock.t = Date.now();
		await adm.signIn(web.idp, "adm");
		const big = await adm.request("POST", "/api/call", { body: Buffer.alloc(23 * 1024 * 1024, 0x61), headers: { "content-type": "application/json", "x-files-csrf": adm.csrf } });
		assert.equal(big.status, 413);
		assert.equal((await adm.request("POST", "/auth/logout", { headers: { "x-files-csrf": adm.csrf } })).status, 200);
		assert.equal((await adm.call("workspaces")).status, 401);
		const page = await adm.request("GET", "/");
		// the page names its files with a version, so a cache in front never pairs it with older ones; the files answer under it
		const v = /href="\/app\/style\.css\?v=([0-9a-f]{12})"/.exec(page.body)?.[1];
		assert.ok(v, "style.css carries a version");
		assert.match(page.body, new RegExp(`src="/app/app\\.ts\\?v=${v}"`));
		assert.equal((await adm.request("GET", `/app/style.css?v=${v}`)).status, 200);
		assert.equal(page.status, 200);
		assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
		assert.equal(page.headers["strict-transport-security"], undefined, "no HSTS for a loopback name");
		const js = await adm.request("GET", "/app/app.ts");
		assert.match(String(js.headers["content-type"]), /javascript/);
		assert.doesNotMatch(js.body, /: Promise</, "types stripped");
		for (const p of ["/app/../server/service.ts", "/server/service.ts", "/app/env.ts", "/.env"]) assert.equal((await adm.request("GET", p)).status, 404, p);
	} finally { await done(); }
});

test("the global bound refuses requests beyond it before any session lookup", async () => {
	const { web, done } = await setup({ maxInflight: 1 });
	try {
		const b = web.browser();
		await b.signIn(web.idp, "adm");
		// one request that never finishes its body holds the only slot
		const https = await import("node:https");
		const { testCert } = await import("./support/browser.ts");
		const held = https.request(new URL("/api/call", web.origin), { method: "POST", ca: testCert().cert, headers: { origin: web.origin, "content-type": "application/json", "content-length": "100", cookie: `__Host-files=${b.jar.get("__Host-files")}`, "x-files-csrf": b.csrf } });
		held.on("error", () => {});
		held.write("{");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((await web.browser().request("GET", "/api/session")).status, 503);
		held.destroy();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((await b.request("GET", "/api/session")).status, 200, "the slot is free again");
	} finally { await done(); }
});

test("the ID token: signature, issuer, audience, authorized party, expiry, issue time, nonce", async () => {
	const idp = await startDevIdp({ clients: [] });
	try {
		const c = new OidcClient({ issuer: idp.issuer, clientId: "files", redirectUri: "https://localhost/auth/callback" });
		const t = Math.floor(Date.now() / 1000);
		const good = { sub: "lea", aud: "files", iat: t, exp: t + 300, nonce: "n" };
		assert.deepEqual(await c.verifyIdToken(idp.signIdToken(good), "n"), { issuer: idp.issuer, subject: "lea" });
		const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
		const bad: Array<[string, string]> = [
			[idp.signIdToken(good, { key: other }), "signature"],
			[idp.signIdToken(good, { kid: "unknown" }), "unknown"],
			[idp.signIdToken(good, { alg: "none" }), "algorithm"],
			[idp.signIdToken(good, { alg: "RS256" }), "does not fit"],
			[idp.signIdToken({ ...good, iss: "https://evil.example" }), "issuer"],
			[idp.signIdToken({ ...good, aud: "other" }), "audience"],
			[idp.signIdToken({ ...good, aud: ["files", "other"] }), "authorized party"],
			[idp.signIdToken({ ...good, azp: "other" }), "authorized party"],
			[idp.signIdToken({ ...good, exp: t - 600 }), "expired"],
			[idp.signIdToken({ ...good, iat: t + 600 }), "future"],
			[idp.signIdToken({ ...good, nonce: "m" }), "nonce"],
			[idp.signIdToken({ ...good, sub: "" }), "subject"],
			["a.b", "JWS"],
		];
		for (const [jwt, why] of bad) await assert.rejects(c.verifyIdToken(jwt, "n"), new RegExp(why), why);
		assert.deepEqual(await c.verifyIdToken(idp.signIdToken({ ...good, aud: ["files", "other"], azp: "files" }), "n"), { issuer: idp.issuer, subject: "lea" });
		assert.throws(() => new OidcClient({ issuer: "http://idp.example", clientId: "x", redirectUri: "https://localhost/cb" }), /https/);
		// a login that demanded a fresh authentication: the token must carry an auth_time at or after it (within the skew)
		const after = Date.now();
		await assert.rejects(c.verifyIdToken(idp.signIdToken(good), "n", after), /fresh authentication/, "no auth_time");
		await assert.rejects(c.verifyIdToken(idp.signIdToken({ ...good, auth_time: t - 3600 }), "n", after), /fresh authentication/, "an hour old");
		await assert.rejects(c.verifyIdToken(idp.signIdToken({ ...good, auth_time: String(t) }), "n", after), /fresh authentication/, "no number");
		assert.deepEqual(await c.verifyIdToken(idp.signIdToken({ ...good, auth_time: t }), "n", after), { issuer: idp.issuer, subject: "lea" });
		assert.deepEqual(await c.verifyIdToken(idp.signIdToken({ ...good, auth_time: t - 3600 }), "n"), { issuer: idp.issuer, subject: "lea" }, "an ordinary login asks for none");
	} finally { await idp.close(); }
});

test("sign-out ends the session here and goes on to the provider's end-session endpoint", async () => {
	const { svc, web, done } = await setup();
	try {
		const adm = web.browser();
		await adm.signIn(web.idp, "adm");
		const handle = adm.jar.get("__Host-files")!;
		// an ordinary sign-in asks the provider for no fresh authentication
		const start = await web.browser().request("GET", "/auth/login");
		assert.equal(new URL(String(start.headers.location)).searchParams.has("max_age"), false);
		const out = await adm.request("POST", "/auth/logout", { headers: { "x-files-csrf": adm.csrf } });
		assert.equal(out.status, 200);
		assert.equal(svc.state.lookupSession(handle), null, "the session ended here");
		const next = new URL(out.json!.value.next);
		assert.equal(next.origin + next.pathname, `${web.idp.issuer}/logout`);
		assert.equal(next.searchParams.get("client_id"), "files-test");
		assert.equal(next.searchParams.get("post_logout_redirect_uri"), `${web.origin}/`);
		// the provider sends the browser back to the registered place and to no other
		const back = await fetch(next, { redirect: "manual" });
		assert.equal(back.status, 302);
		assert.equal(back.headers.get("location"), `${web.origin}/`);
		next.searchParams.set("post_logout_redirect_uri", "https://evil.example/");
		assert.equal((await fetch(next, { redirect: "manual" })).status, 400);
		// a provider that is gone does not keep the session alive
		const lea = web.browser();
		await lea.signIn(web.idp, "lea", "acme");
		const h2 = lea.jar.get("__Host-files")!;
		await web.idp.close();
		const gone = await lea.request("POST", "/auth/logout", { headers: { "x-files-csrf": lea.csrf } });
		assert.equal(gone.status, 200);
		assert.equal(svc.state.lookupSession(h2), null);
	} finally { await done(); }
});

test("Browser helper sanity: a browser without a session is refused at the API", async () => {
	const { web, done } = await setup();
	try {
		const b = new Browser(web.origin);
		assert.equal((await b.call("workspaces")).status, 401);
	} finally { await done(); }
});
