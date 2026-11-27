// The sign-in of the forum (docs/forum-seite-plan-2026-11-26.en.md, section 5, phase 1): without FORUM_LOGIN the forum
// is open as before; with it every API call and the WebSocket need a signed-in person, a change also our origin and the
// session's CSRF token; the callback sets a __Host- cookie on a page (not a redirect); administrators are named by
// identity and the admin password is taken only from scripts; signing out goes on to the provider.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loginConfig, parseAdmins, userIdOf } from "../server/auth.ts";
import { startServer, startStack, type Stack } from "./stack.ts";
import { startDevIdp, type DevIdp } from "./support/dev-idp.ts";

const ORIGIN = "http://localhost:4100";
type Res = { status: number; headers: http.IncomingHttpHeaders; body: string; json?: any };

/** A browser without a browser: a cookie jar, our origin on every request unless told otherwise. */
class Browser {
	jar = new Map<string, string>();
	csrf = "";
	readonly base: string;
	constructor(base: string) { this.base = base; }
	request(method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Res> {
		const u = new URL(path, this.base);
		const body = o.body === undefined ? undefined : JSON.stringify(o.body);
		const headers: Record<string, string> = { ...(body ? { "content-type": "application/json" } : {}), ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(o.headers ?? {}) };
		return new Promise((ok, fail) => {
			const req = http.request(u, { method, headers }, (res) => {
				let s = "";
				res.on("data", (c) => (s += c));
				res.on("end", () => {
					for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
						const [kv] = c.split(";"); const i = kv!.indexOf("=");
						const k = kv!.slice(0, i), v = kv!.slice(i + 1);
						if (v === "" || /Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v);
					}
					let json: unknown; try { json = JSON.parse(s); } catch { /* a page */ }
					ok({ status: res.statusCode ?? 0, headers: res.headers, body: s, json });
				});
			});
			req.on("error", fail);
			req.end(body);
		});
	}
	/** /auth/login, the provider's form as `subject`, the callback; then the session's CSRF token. */
	async signIn(idp: DevIdp, subject: string): Promise<Res> {
		const start = await this.request("GET", "/auth/login");
		assert.equal(start.status, 302);
		const back = new URL(await idp.authorize(new URL(String(start.headers.location)).searchParams, subject));
		const cb = await this.request("GET", back.pathname + back.search);
		const me = await this.request("GET", "/api/me");
		if (me.status === 200) this.csrf = me.json.csrf;
		return cb;
	}
	post(path: string, body: unknown, o: { csrf?: string; origin?: string | null } = {}) {
		return this.request("POST", path, { body, headers: { "x-forum-csrf": o.csrf ?? this.csrf }, ...(o.origin !== undefined ? { origin: o.origin } : {}) });
	}
}

/** A WebSocket upgrade by hand: the status line the server answers with. */
function upgrade(base: string, path: string, headers: Record<string, string>): Promise<number> {
	return new Promise((ok) => {
		const req = http.request(new URL(path, base), { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
		req.on("upgrade", (res, socket) => { socket.destroy(); ok(res.statusCode ?? 0); });
		req.on("response", (res) => { res.resume(); ok(res.statusCode ?? 0); });
		req.on("error", () => ok(0));
		req.end();
	});
}

let stack: Stack, idp: DevIdp;
test.before(async () => {
	stack = await startStack({ agents: false, model: false });
	idp = await startDevIdp({ clients: [{ clientId: "forum-test", clientSecret: "s3cret", redirectUris: [`${ORIGIN}/auth/callback`] }] });
});
test.after(async () => { await idp.close(); await stack.close(); });

const signedIn = async (o: { admins?: string; now?: () => number } = {}) => {
	const login = loginConfig({ FORUM_LOGIN: "oidc", FORUM_PUBLIC_ORIGIN: ORIGIN, FORUM_OIDC_ISSUER: idp.issuer, FORUM_OIDC_CLIENT_ID: "forum-test", FORUM_OIDC_CLIENT_SECRET: "s3cret", FORUM_ADMINS: o.admins ?? "" });
	return startServer({ stack, login, ...(o.now ? { now: o.now } : {}) });
};

test("without FORUM_LOGIN the forum is open as before, and has no sign-in routes", async () => {
	const srv = await startServer({ stack, login: null });
	try {
		const b = new Browser(srv.url);
		assert.deepEqual((await b.request("GET", "/api/me")).json, { login: false });
		assert.equal((await b.request("GET", "/api/rooms/open")).status, 200);
		assert.equal((await b.request("GET", "/auth/login")).status, 404);
		assert.equal(await upgrade(srv.url, "/ws/open", { origin: "https://elsewhere.example" }), 101);
	} finally { await srv.close(); }
});

test("the configuration: FORUM_LOGIN is oidc or nothing, an origin is https or loopback, administrators are pairs", () => {
	assert.equal(loginConfig({}), null);
	assert.throws(() => loginConfig({ FORUM_LOGIN: "password" }), /must be "oidc"/);
	assert.throws(() => loginConfig({ FORUM_LOGIN: "oidc", FORUM_OIDC_ISSUER: "https://id.example", FORUM_OIDC_CLIENT_ID: "x", FORUM_PUBLIC_ORIGIN: "http://forum.example" }), /https/);
	assert.throws(() => loginConfig({ FORUM_LOGIN: "oidc", FORUM_PUBLIC_ORIGIN: ORIGIN }), /FORUM_OIDC_ISSUER/);
	assert.deepEqual([...parseAdmins(" https://id.example/realms/phi  abc ; https://id.example/realms/phi def ")], ["https://id.example/realms/phi abc", "https://id.example/realms/phi def"]);
	assert.throws(() => parseAdmins("only-an-issuer"), /issuer subject/);
});

test("with FORUM_LOGIN nothing is shown before a sign-in: API, WebSocket, the admin password's browser login", async () => {
	const srv = await signedIn();
	try {
		const b = new Browser(srv.url);
		const me = await b.request("GET", "/api/me");
		assert.equal(me.status, 401);
		assert.deepEqual(me.json, { login: true, user: null });
		for (const p of ["/api/rooms/lobby", "/api/system", "/api/models", "/api/sources", "/api/rooms/lobby/plan/b1.md", "/api/plan/lobby/b1.md", "/api/rooms/lobby/talk/b1", "/api/admin/models"])
			assert.equal((await b.request("GET", p)).status, 401, p);
		assert.equal((await b.post("/api/rooms/lobby/stop", {})).status, 401, "a run is not stopped by a stranger");
		assert.equal(await upgrade(srv.url, "/ws/lobby", { origin: ORIGIN }), 401);
		assert.equal((await b.request("POST", "/api/admin/login", { body: { password: "x" } })).status, 401);
	} finally { await srv.close(); }
});

test("sign-in: a page with a __Host- cookie (Strict, Secure, HttpOnly), the person, the CSRF token on every change", async () => {
	const srv = await signedIn();
	try {
		const b = new Browser(srv.url);
		const cb = await b.signIn(idp, "lea");
		assert.equal(cb.status, 200, "a page, not a redirect: a Strict cookie set at the end of the provider's redirects would not be sent");
		assert.match(cb.body, /http-equiv="refresh" content="0;url=\/"/);
		const set = ([] as string[]).concat(cb.headers["set-cookie"] ?? []).find((c) => c.startsWith("__Host-forum="))!;
		for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) assert.ok(set.includes(attr), attr);
		const me = (await b.request("GET", "/api/me")).json;
		assert.equal(me.user.id, userIdOf(idp.issuer, "lea"));
		assert.match(me.user.name, /^Person /);
		assert.equal(me.admin, false);
		assert.equal((await b.post("/api/rooms", { room: "lea-home" })).status, 200);
		assert.equal((await b.request("GET", "/api/rooms/lea-home")).status, 200);
		assert.equal(await upgrade(srv.url, "/ws/lea-home", { origin: ORIGIN, cookie: `__Host-forum=${b.jar.get("__Host-forum")}` }), 101);
		assert.equal(await upgrade(srv.url, "/ws/lea-home", { origin: "https://evil.example", cookie: `__Host-forum=${b.jar.get("__Host-forum")}` }), 401, "another site's page");
		// a change: our origin and the session's token, or nothing
		assert.equal((await b.post("/api/me", { name: "Lea" }, { csrf: "forged" })).status, 401);
		assert.equal((await b.post("/api/me", { name: "Lea" }, { origin: "https://evil.example" })).status, 401);
		assert.equal((await b.post("/api/me", { name: "Lea" }, { origin: null })).status, 401);
		const renamed = await b.post("/api/me", { name: "  Lea   Berg " });
		assert.equal(renamed.status, 200);
		assert.equal(renamed.json.user.name, "Lea Berg");
		assert.equal((await b.post("/api/me", { name: "" })).status, 400);
		// a state is used once; a callback without this browser's login cookie is refused
		const again = await new Browser(srv.url).request("GET", "/auth/login");
		const back = new URL(await idp.authorize(new URL(String(again.headers.location)).searchParams, "lea"));
		assert.equal((await new Browser(srv.url).request("GET", back.pathname + back.search)).status, 400, "another browser's callback");
		// the same person again: the same ID and the name kept
		const b2 = new Browser(srv.url);
		await b2.signIn(idp, "lea");
		assert.equal((await b2.request("GET", "/api/me")).json.user.name, "Lea Berg");
	} finally { await srv.close(); }
});

test("administrators by identity; the admin password only from scripts", async () => {
	process.env.FORUM_ADMIN_PASSWORD = "pw-for-scripts";
	const srv = await signedIn({ admins: `${idp.issuer} ada` });
	try {
		const ada = new Browser(srv.url), lea = new Browser(srv.url);
		await ada.signIn(idp, "ada");
		await lea.signIn(idp, "lea");
		assert.equal((await ada.request("GET", "/api/me")).json.admin, true);
		assert.equal((await ada.request("GET", "/api/admin/session")).json.admin, true);
		assert.equal((await ada.request("GET", "/api/admin/session")).json.signIn, true, "with a sign-in the panel names administrators by identity, not by the password");
		assert.equal((await lea.request("GET", "/api/admin/session")).json.admin, false);
		assert.equal((await lea.request("GET", "/api/admin/models")).status, 403);
		assert.equal((await ada.request("GET", "/api/admin/models")).status, 200);
		// models, providers and limits from the page: administrators only
		assert.equal((await lea.request("GET", "/api/admin/providers")).status, 403);
		assert.equal((await lea.post("/api/admin/providers/job", { procId: "x", provider: "anthropic", kind: "logout" })).status, 403);
		assert.equal((await lea.post("/api/admin/limits", { perMin: 1 })).status, 403);
		assert.equal((await ada.request("GET", "/api/admin/providers")).status, 200);
		assert.equal((await ada.post("/api/admin/limits", { perMin: 5 })).json.effective.perMin, 5);
		assert.match((await ada.post("/api/admin/limits", { perMin: 100_000 })).json.error, /above the operator's ceiling/);
		assert.equal((await lea.post("/api/admin/login", { password: "pw-for-scripts" })).status, 404, "no browser login with the password");
		// a script: the password as x-admin-token, without a session
		const script = new Browser(srv.url);
		assert.equal((await script.request("GET", "/api/admin/models", { headers: { "x-admin-token": "pw-for-scripts" } })).status, 200);
		assert.equal((await script.request("GET", "/api/admin/models", { headers: { "x-admin-token": "wrong" } })).status, 401);
	} finally { process.env.FORUM_ADMIN_PASSWORD = ""; await srv.close(); }
});

test("sign-out ends the session here and names the provider's end-session address", async () => {
	const srv = await signedIn();
	try {
		const b = new Browser(srv.url);
		await b.signIn(idp, "lea");
		assert.equal((await b.request("POST", "/auth/logout", { headers: { "x-forum-csrf": "forged" } })).status, 403);
		const out = await b.request("POST", "/auth/logout", { headers: { "x-forum-csrf": b.csrf } });
		assert.equal(out.status, 200);
		const next = new URL(out.json.next);
		assert.equal(next.origin + next.pathname, `${idp.issuer}/logout`);
		assert.equal(next.searchParams.get("post_logout_redirect_uri"), `${ORIGIN}/`);
		assert.equal(b.jar.has("__Host-forum"), false);
		assert.equal((await b.request("GET", "/api/me")).status, 401);
		// a new sign-in in a browser ends that browser's session before
		await b.signIn(idp, "lea");
		const first = b.jar.get("__Host-forum")!;
		await b.signIn(idp, "lea");
		assert.equal((await new Browser(srv.url).request("GET", "/api/me", { headers: { cookie: `__Host-forum=${first}` } })).status, 401);
	} finally { await srv.close(); }
});

test("rooms: the owner invites by ID; a room one has no role in does not exist; a viewer reads and changes nothing", async () => {
	const srv = await signedIn({ admins: `${idp.issuer} ada` });
	try {
		const owner = new Browser(srv.url), mia = new Browser(srv.url), tom = new Browser(srv.url), ada = new Browser(srv.url);
		for (const [b, who] of [[owner, "olga"], [mia, "mia"], [tom, "tom"], [ada, "ada"]] as const) await b.signIn(idp, who);
		const id = async (b: Browser) => (await b.request("GET", "/api/me")).json.user.id as string;
		assert.equal((await owner.post("/api/rooms", { room: "sky app" })).status, 400, "a name of letters, digits, dots, dashes");
		assert.equal((await owner.post("/api/rooms", { room: "sky-app" })).status, 200);
		assert.equal((await mia.post("/api/rooms", { room: "sky-app" })).status, 400, "a name that is taken");
		assert.deepEqual((await owner.request("GET", "/api/rooms")).json.rooms, [{ room: "sky-app", role: "owner", state: "new", tasks: 0 }]);
		// nobody else is in it: not a stranger, not an administrator; the answer does not tell that it exists
		for (const b of [mia, tom, ada]) {
			assert.equal((await b.request("GET", "/api/rooms/sky-app")).status, 404);
			assert.equal((await b.request("GET", "/api/rooms/no-such-room")).status, 404);
			assert.equal(await upgrade(srv.url, "/ws/sky-app", { origin: ORIGIN, cookie: `__Host-forum=${b.jar.get("__Host-forum")}` }), 401);
		}
		assert.equal((await tom.post("/api/rooms/sky-app/stop", {})).status, 404);
		// the owner invites mia as a member, tom to read along
		assert.equal((await owner.post("/api/rooms/sky-app/access", { userId: "not-an-id", role: "member" })).status, 400);
		assert.equal((await owner.post("/api/rooms/sky-app/access", { userId: await id(mia), role: "member" })).status, 200);
		const a = await owner.post("/api/rooms/sky-app/access", { userId: await id(tom), role: "viewer" });
		assert.deepEqual({ members: a.json.members.map((p: { name: string }) => p.name), viewers: a.json.viewers.length }, { members: [(await mia.request("GET", "/api/me")).json.user.name], viewers: 1 });
		assert.deepEqual((await mia.request("GET", "/api/rooms")).json.rooms, [{ room: "sky-app", role: "member", state: "new", tasks: 0 }]);
		// with a task the room is idle in the list
		assert.equal((await mia.post("/api/rooms/sky-app/task", { brief: "An app that shows the starry sky for a place and a time.", lang: "en" })).status, 200);
		assert.deepEqual((await owner.request("GET", "/api/rooms")).json.rooms.map((r: { state: string; tasks: number }) => [r.state, r.tasks]), [["idle", 1]]);
		assert.equal((await mia.request("GET", "/api/rooms/sky-app")).status, 200);
		assert.equal((await tom.request("GET", "/api/rooms/sky-app")).status, 200);
		assert.equal(await upgrade(srv.url, "/ws/sky-app", { origin: ORIGIN, cookie: `__Host-forum=${tom.jar.get("__Host-forum")}` }), 101);
		// a viewer changes nothing; a member writes but does not manage the room
		assert.equal((await tom.post("/api/rooms/sky-app/stop", {})).status, 403);
		assert.equal((await tom.post("/api/rooms/sky-app/message", { text: "hello" })).status, 403);
		assert.equal((await mia.post("/api/rooms/sky-app/stop", {})).status, 200);
		assert.equal((await mia.post("/api/rooms/sky-app/access", { userId: await id(ada), role: "member" })).status, 403);
		// the room's defaults: its owner sets them within the ceilings, its people read them, a member changes none
		assert.equal((await mia.post("/api/rooms/sky-app/settings", { rounds: 1 })).status, 403);
		assert.equal((await tom.post("/api/rooms/sky-app/settings", { rounds: 1 })).status, 403);
		assert.match((await owner.post("/api/rooms/sky-app/settings", { budgetTokens: 10_000_000 })).json.error, /above the operator's ceiling/);
		assert.match((await owner.post("/api/rooms/sky-app/settings", { models: ["a/b", "c/d", "e/f"] })).json.error, /not available/);
		assert.deepEqual((await owner.post("/api/rooms/sky-app/settings", { rounds: 1, way: "turns", budgetTokens: 50_000, personWaitS: 30 })).json.defaults, { rounds: 1, way: "turns", budgetTokens: 50_000, personWaitS: 30 });
		assert.deepEqual((await mia.request("GET", "/api/rooms/sky-app/settings")).json.defaults.budgetTokens, 50_000);
		assert.match(JSON.stringify((await mia.request("GET", "/api/rooms/sky-app")).json.lines), /set the room's defaults: way turns; 1 rounds; budget 50000 tokens; waits 30 s for the person/);
		// the link to a workspace: only its owner makes or removes it; its people see it (files.test.ts has the rest)
		for (const action of ["check", "link", "unlink"]) for (const who of [mia, tom]) assert.equal((await who.post("/api/rooms/sky-app/link", { action })).status, 403, action);
		assert.equal((await mia.request("GET", "/api/rooms/sky-app/link")).json.agent, "room-sky-app");
		assert.match((await owner.post("/api/rooms/sky-app/link", { action: "check" })).json.error, /No sources process is connected to spaces-files/);
		assert.equal((await mia.request("GET", "/api/rooms/sky-app/access")).status, 200, "a member reads who is in the room");
		assert.equal((await owner.post("/api/rooms/sky-app/access", { userId: await id(owner), role: null })).status, 400, "the owner keeps the room");
		// taken out again: the room is gone for her
		assert.equal((await owner.post("/api/rooms/sky-app/access", { userId: await id(mia), role: null })).status, 200);
		assert.equal((await mia.request("GET", "/api/rooms/sky-app")).status, 404);
		assert.deepEqual((await mia.request("GET", "/api/rooms")).json.rooms, []);
	} finally { await srv.close(); }
});

test("a session ends twelve hours after the sign-in, however busy it was", async () => {
	let skew = 0;
	const srv = await signedIn({ now: () => Date.now() + skew });
	try {
		const b = new Browser(srv.url);
		await b.signIn(idp, "lea");
		assert.equal((await b.request("GET", "/api/me")).status, 200);
		skew = 12 * 3600_000 - 60_000;
		assert.equal((await b.request("GET", "/api/me")).status, 200, "a minute before the end");
		skew = 12 * 3600_000 + 1000;
		const r = await b.request("GET", "/api/me");
		assert.deepEqual({ status: r.status, json: r.json }, { status: 401, json: { login: true, user: null } });
		assert.equal((await b.post("/api/rooms", { room: "late" })).status, 401);
		assert.equal(await upgrade(srv.url, "/ws/late", { origin: ORIGIN, cookie: `__Host-forum=${b.jar.get("__Host-forum")}` }), 401);
	} finally { await srv.close(); }
});
