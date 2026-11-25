// The browser and admin adapter (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 5, phase 4): HTTPS only,
// the login through an OpenID provider (server/oidc.ts), the session as an opaque handle in a `__Host-` cookie
// (Secure, HttpOnly, SameSite=Strict), every mutation and every API call checked for the service's own origin and a
// CSRF token bound to the session before it reaches the service, and the page itself (web/).
//
// Routes: GET / and /app/* (the page), GET /auth/login[?tenant=], GET /auth/callback, POST /auth/select (the tenant
// choice after a login with several bindings), POST /auth/logout, GET /api/session, POST /api/call {op, args}.
// The identity comes from the verified ID token alone; no header, parameter or body names an actor or a tenant with
// authority: a tenant selector chooses only among the login index's bindings of that identity, and the tenant's
// FsActor row decides. Nothing is logged: not contents, not handles, not tokens, not paths.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import type { OidcClient, Pending, Verified } from "./oidc.ts";
import type { FilesService } from "./service.ts";
import { ADMIN_OPS, base64Chars, FILE_OPS, isObj, runOp, wireError } from "./wire.ts";
import { BadCall } from "./wire.ts";

export type HttpOptions = {
	listen: { host: string; port: number };
	tls: { cert: string | Buffer; key: string | Buffer };
	/** The service's public origin, e.g. `https://localhost:4200`: the only accepted Origin, the base of the redirect URI. */
	origin: string;
	oidc: OidcClient;
	/** Requests at once (default 64), counted from their arrival, before any session lookup: the one global bound of section 5. */
	maxInflight?: number;
	/** How long a started login may take (default 10 minutes). */
	loginTtlMs?: number;
	now?: () => number;
};

export type HttpServer = { port: number; close(): Promise<void> };

export const SESSION_COOKIE = "__Host-files";
const LOGIN_COOKIE = "__Host-files-login";
const CHOICE_COOKIE = "__Host-files-choice";
const CSRF_HEADER = "x-files-csrf";
const MAX_PENDING = 1000;
const OPS = { ...FILE_OPS, ...ADMIN_OPS };
/** The page's modules, served with their types stripped; nothing else under /app. */
const ASSETS: Record<string, string> = {
	"/app/app.ts": "web/app.ts",
	"/client/draft.ts": "client/draft.ts",
	"/app/style.css": "web/style.css",
};

const PAGE_HEADERS = {
	"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cross-origin-opener-policy": "same-origin",
	"strict-transport-security": "max-age=31536000",
};

function cookies(h: string | undefined): Map<string, string> {
	const m = new Map<string, string>();
	for (const part of (h ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
	}
	return m;
}
const cookie = (name: string, value: string, o: { maxAgeS: number; sameSite: "Strict" | "Lax" }) =>
	`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${o.sameSite}; Max-Age=${o.maxAgeS}`;
const clear = (name: string) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function serveHttp(svc: FilesService, o: HttpOptions): Promise<HttpServer> {
	const origin = new URL(o.origin).origin;
	if (!origin.startsWith("https://")) throw new Error("the public origin must be https");
	const now = o.now ?? Date.now;
	const ttl = o.loginTtlMs ?? 600_000;
	const maxInflight = o.maxInflight ?? 64;
	const maxBody = base64Chars(svc.limits.maxFileBytes) + 64 * 1024;
	const csrfKey = randomBytes(32);
	const csrfFor = (handle: string) => createHmac("sha256", csrfKey).update(handle).digest("base64url");
	// logins under way, by state; the browser that started one holds its binding in a cookie
	const logins = new Map<string, { pending: Pending; binding: string; tenant: string | null; exp: number }>();
	// verified identities choosing among several tenants, by the token in their cookie
	const choices = new Map<string, { who: Verified; tenants: string[]; exp: number }>();
	const prune = <V extends { exp: number }>(m: Map<string, V>) => {
		const t = now();
		for (const [k, v] of m) if (v.exp <= t) m.delete(k);
		while (m.size >= MAX_PENDING) m.delete(m.keys().next().value!);
	};
	let inflight = 0;

	const page = (res: import("node:http").ServerResponse, status: number, title: string, body: string, extra: Record<string, string | string[]> = {}) => {
		res.writeHead(status, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra });
		res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><link rel="stylesheet" href="/app/style.css"><main class="note"><h1>${esc(title)}</h1>${body}</main>`);
	};
	const json = (res: import("node:http").ServerResponse, status: number, v: unknown, extra: Record<string, string | string[]> = {}) => {
		res.writeHead(status, { ...PAGE_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra });
		res.end(JSON.stringify(v));
	};
	/** A browser request from this origin: Origin must be ours, and a Fetch Metadata header, where sent, same-origin. */
	const sameOrigin = (req: import("node:http").IncomingMessage) => {
		const site = req.headers["sec-fetch-site"];
		return req.headers.origin === origin && (site === undefined || site === "same-origin");
	};

	/** Logs the verified identity into `tenant` with a fresh handle, ending the browser's previous session. */
	const enter = async (res: import("node:http").ServerResponse, jar: Map<string, string>, who: Verified, tenant: string) => {
		const r = await svc.login(tenant, "user", who);
		const old = jar.get(SESSION_COOKIE);
		if (old) svc.state.endSession(old);
		const maxAgeS = Math.max(1, Math.floor((r.expiresAt - now()) / 1000));
		// a page, not a redirect: a SameSite=Strict cookie is not sent along a redirect chain that began at the IdP
		page(res, 200, "Signed in", `<p><a href="/">Continue</a></p><meta http-equiv="refresh" content="0;url=/">`,
			{ "set-cookie": [cookie(SESSION_COOKIE, r.handle, { maxAgeS, sameSite: "Strict" }), clear(LOGIN_COOKIE), clear(CHOICE_COOKIE)] });
	};

	const readBody = (req: import("node:http").IncomingMessage) => new Promise<Buffer | null>((resolve, reject) => {
		const len = Number(req.headers["content-length"] ?? NaN);
		if (Number.isFinite(len) && len > maxBody) { resolve(null); req.resume(); return; }
		const chunks: Buffer[] = [];
		let n = 0;
		req.on("data", (c: Buffer) => { n += c.length; if (n > maxBody) { resolve(null); req.destroy(); return; } chunks.push(c); });
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});

	const handle = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
		const url = new URL(req.url ?? "/", origin);
		const jar = cookies(req.headers.cookie);
		const route = `${req.method} ${url.pathname}`;

		if (route === "GET /") {
			res.writeHead(200, { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(readFileSync(join(ROOT, "web", "index.html")));
			return;
		}
		if (req.method === "GET" && Object.hasOwn(ASSETS, url.pathname)) {
			const file = ASSETS[url.pathname];
			const text = readFileSync(join(ROOT, file), "utf8");
			const js = file.endsWith(".ts");
			res.writeHead(200, { ...PAGE_HEADERS, "content-type": js ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control": "no-cache" });
			res.end(js ? stripTypeScriptTypes(text) : text);
			return;
		}
		if (route === "GET /auth/login") {
			prune(logins);
			const tenant = url.searchParams.get("tenant");
			const pending = await o.oidc.begin();
			const binding = randomBytes(24).toString("base64url");
			logins.set(pending.state, { pending, binding, tenant, exp: now() + ttl });
			res.writeHead(302, { ...PAGE_HEADERS, location: pending.authorizeUrl, "cache-control": "no-store",
				"set-cookie": cookie(LOGIN_COOKIE, binding, { maxAgeS: Math.floor(ttl / 1000), sameSite: "Lax" }) });
			res.end();
			return;
		}
		if (route === "GET /auth/callback") {
			const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
			const l = logins.get(state);
			logins.delete(state); // a state is used once
			if (!l || l.exp <= now() || !same(l.binding, jar.get(LOGIN_COOKIE) ?? "") || !code)
				return page(res, 400, "Sign-in failed", `<p>This sign-in was not started here, has expired or was used already. <a href="/auth/login">Sign in again</a></p>`, { "set-cookie": clear(LOGIN_COOKIE) });
			let who: Verified;
			try { who = await o.oidc.complete(l.pending, code); }
			catch { return page(res, 400, "Sign-in failed", `<p>The identity provider's answer could not be verified. <a href="/auth/login">Sign in again</a></p>`, { "set-cookie": clear(LOGIN_COOKIE) }); }
			const tenants = svc.state.tenantsFor(who.issuer, who.subject);
			if (l.tenant !== null && !tenants.includes(l.tenant)) return page(res, 403, "No access", `<p>This account has no access there.</p>`, { "set-cookie": clear(LOGIN_COOKIE) });
			const pick = l.tenant ?? (tenants.length === 1 ? tenants[0] : null);
			if (tenants.length === 0) return page(res, 403, "No access", `<p>This account has no access to any tenant.</p>`, { "set-cookie": clear(LOGIN_COOKIE) });
			if (pick !== null) return enter(res, jar, who, pick);
			prune(choices);
			const token = randomBytes(24).toString("base64url");
			choices.set(token, { who, tenants, exp: now() + ttl });
			const forms = tenants.map((t) => `<form method="post" action="/auth/select"><input type="hidden" name="tenant" value="${esc(t)}"><button>${esc(t)}</button></form>`).join("");
			return page(res, 200, "Choose a tenant", forms, { "set-cookie": [cookie(CHOICE_COOKIE, token, { maxAgeS: Math.floor(ttl / 1000), sameSite: "Strict" }), clear(LOGIN_COOKIE)] });
		}
		if (route === "POST /auth/select") {
			if (!sameOrigin(req)) return page(res, 403, "Refused", "<p>A request from another origin.</p>");
			const token = jar.get(CHOICE_COOKIE) ?? "";
			const c = choices.get(token);
			const body = await readBody(req);
			const tenant = body === null ? null : new URLSearchParams(body.toString("utf8")).get("tenant");
			if (!c || c.exp <= now()) return page(res, 400, "Sign-in failed", `<p>The choice has expired. <a href="/auth/login">Sign in again</a></p>`);
			if (tenant === null || !c.tenants.includes(tenant)) return page(res, 403, "No access", "<p>This account has no access there.</p>");
			choices.delete(token);
			return enter(res, jar, c.who, tenant);
		}
		if (route === "POST /auth/logout") {
			const h = jar.get(SESSION_COOKIE);
			if (!sameOrigin(req) || !h || !same(csrfFor(h), String(req.headers[CSRF_HEADER] ?? ""))) return json(res, 403, { ok: false, error: { code: "permissionDenied", message: "origin or CSRF token refused" } });
			svc.state.endSession(h);
			return json(res, 200, { ok: true, value: null }, { "set-cookie": clear(SESSION_COOKIE) });
		}
		if (route === "GET /api/session") {
			const h = jar.get(SESSION_COOKIE);
			const site = req.headers["sec-fetch-site"];
			if (site !== undefined && site !== "same-origin") return json(res, 403, { ok: false, error: { code: "permissionDenied", message: "a request from another origin" } });
			const v = h ? svc.state.lookupSession(h) : null;
			if (!h || !v) return json(res, 401, { ok: false, error: { code: "unauthenticated", message: "not signed in" } });
			return json(res, 200, { ok: true, value: { tenantId: v.tenantId, actor: { kind: v.actorKind, id: v.actorId }, expiresAt: v.expiresAt, csrf: csrfFor(h) } });
		}
		if (route === "POST /api/call") {
			const h = jar.get(SESSION_COOKIE);
			if (!sameOrigin(req) || !String(req.headers["content-type"] ?? "").startsWith("application/json"))
				return json(res, 403, { ok: false, error: { code: "permissionDenied", message: "a request from another origin" } });
			if (!h) return json(res, 401, { ok: false, error: { code: "unauthenticated", message: "not signed in" } });
			if (!same(csrfFor(h), String(req.headers[CSRF_HEADER] ?? ""))) return json(res, 403, { ok: false, error: { code: "permissionDenied", message: "CSRF token refused" } });
			const body = await readBody(req);
			if (body === null) return json(res, 413, { ok: false, error: { code: "capacityExceeded", message: "the request is too large" } });
			let msg: unknown;
			try { msg = JSON.parse(body.toString("utf8")); } catch { msg = undefined; }
			const r = isObj(msg) ? await runOp(OPS, svc, h, msg.op, msg.args) : { ok: false as const, error: wireError(new BadCall("a call is one JSON object {op, args}")) };
			return json(res, !r.ok && r.error.code === "unauthenticated" ? 401 : 200, r);
		}
		json(res, 404, { ok: false, error: { code: "notFound", message: "no such route" } });
	};

	const server = https.createServer({ cert: o.tls.cert, key: o.tls.key, minVersion: "TLSv1.2" }, (req, res) => {
		// the global bound: a request counts until it is answered; one with a session enters its tenant's queue, whose
		// own bound then applies, but the HTTP layer holds every request alike until it is answered
		if (inflight >= maxInflight) { json(res, 503, { ok: false, error: { code: "unavailable", message: "busy", retryAfterMs: 1000 } }, { "retry-after": "1" }); req.resume(); return; }
		inflight++;
		res.on("close", () => { inflight--; });
		handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { ok: false, error: { code: "internal", message: "internal error" } }); else res.destroy(); });
	});
	server.headersTimeout = 20_000;
	server.requestTimeout = 120_000;
	await new Promise<void>((r, j) => { server.once("error", j); server.listen(o.listen.port, o.listen.host, r); });
	return {
		port: (server.address() as { port: number }).port,
		close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
	};
}
