// Who a person is in the forum (docs/forum-seite-plan-2026-11-26.en.md, section 5): with FORUM_LOGIN=oidc the browser
// signs in at the identity provider (server/oidc.ts: the code flow with PKCE, the ID token verified here), and the
// identity is the pair (issuer, subject) and nothing else from the token. Without FORUM_LOGIN the forum is open as
// before, for play on one machine.
//
// Kept in the space, so that a restart of the web process keeps them:
//   ForumUser    one person: the identity, a display name the person chooses, the first sign-in; unique per user
//   UserSession  one signed-in browser: the hash of its handle (never the handle), the user, the CSRF token, the
//                absolute end; leased for the idle time, the lease renewed at most once a minute while it is used
// The login in progress (state, nonce, PKCE verifier) lives in this process only, for ten minutes: there is one web
// process, and a login that a restart interrupts is simply started again.
//
// Env: FORUM_LOGIN=oidc; FORUM_PUBLIC_ORIGIN (the browser's origin, the only Origin accepted, the base of the redirect
// URI; https, or http on a loopback name); FORUM_OIDC_ISSUER, FORUM_OIDC_CLIENT_ID, FORUM_OIDC_CLIENT_SECRET,
// FORUM_OIDC_CA (a PEM file); FORUM_ADMINS (`issuer subject;issuer subject`: the administrators, by identity).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type http from "node:http";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { OidcClient, type Pending, type Verified } from "./oidc.ts";
import { takeExisting } from "./space.ts";

export const SESSION_COOKIE = "__Host-forum";
const LOGIN_COOKIE = "__Host-forum-login";
export const CSRF_HEADER = "x-forum-csrf";
const LOGIN_TTL_MS = 10 * 60_000;
const IDLE_MS = 3600_000, ABSOLUTE_MS = 12 * 3600_000, RENEW_EVERY_MS = 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ForumUser = { userId: string; issuer: string; subject: string; name: string; first: number };
type UserSession = { key: string; userId: string; csrf: string; expiresAt: number; ts: number };
/** A signed-in request: who, whether an administrator, the session's CSRF token. */
export type Who = { user: ForumUser; admin: boolean; csrf: string };

export type LoginConfig = { origin: string; oidc: OidcClient; admins: Set<string> };

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const same = (a: string, b: string) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return timingSafeEqual(x, y); };
/** The user's ID: derived from the identity, so a second sign-in finds the same person without an index. */
export const userIdOf = (issuer: string, subject: string) => "u" + createHash("sha256").update(`${issuer}\n${subject}`).digest("base64url").slice(0, 22);
const identityKey = (issuer: string, subject: string) => `${issuer} ${subject}`;

/** The sign-in from the environment: null without FORUM_LOGIN; FORUM_LOGIN set to anything but `oidc`, or `oidc`
 *  without what it needs, refuses the start rather than running open by mistake. */
export function loginConfig(env: Record<string, string | undefined> = process.env): LoginConfig | null {
	const mode = (env.FORUM_LOGIN ?? "").trim();
	if (mode === "") return null;
	if (mode !== "oidc") throw new Error(`FORUM_LOGIN must be "oidc" or empty, got ${mode}`);
	const origin = new URL(env.FORUM_PUBLIC_ORIGIN || "http://localhost:4100").origin;
	const u = new URL(origin);
	if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error("FORUM_PUBLIC_ORIGIN must be https (http only on a loopback name)");
	if (!env.FORUM_OIDC_ISSUER || !env.FORUM_OIDC_CLIENT_ID) throw new Error("FORUM_LOGIN=oidc needs FORUM_OIDC_ISSUER and FORUM_OIDC_CLIENT_ID");
	const oidc = new OidcClient({
		issuer: env.FORUM_OIDC_ISSUER, clientId: env.FORUM_OIDC_CLIENT_ID, redirectUri: `${origin}/auth/callback`,
		...(env.FORUM_OIDC_CLIENT_SECRET ? { clientSecret: env.FORUM_OIDC_CLIENT_SECRET } : {}),
		...(env.FORUM_OIDC_CA ? { ca: readFileSync(env.FORUM_OIDC_CA, "utf8") } : {}),
	});
	return { origin, oidc, admins: parseAdmins(env.FORUM_ADMINS ?? "") };
}

/** FORUM_ADMINS: `issuer subject` pairs separated by `;`. */
export function parseAdmins(raw: string): Set<string> {
	const out = new Set<string>();
	for (const part of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
		const m = /^(\S+)\s+(\S+)$/.exec(part);
		if (!m) throw new Error(`FORUM_ADMINS: "${part}" is not "issuer subject"`);
		out.add(identityKey(m[1]!, m[2]!));
	}
	return out;
}

export const cookieOf = (req: http.IncomingMessage, name: string): string | undefined => {
	for (const part of String(req.headers.cookie ?? "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
	return undefined;
};
const cookie = (name: string, value: string, o: { maxAgeS: number; sameSite: "Strict" | "Lax" }) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${o.sameSite}; Max-Age=${o.maxAgeS}`;
const clear = (name: string) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

/** A short page of the sign-in itself (an error, or the step back into the forum). */
function page(res: http.ServerResponse, status: number, title: string, body: string, headers: Record<string, string | string[]> = {}, refresh?: string) {
	res.writeHead(status, { ...PAGE_HEADERS, ...headers });
	res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="0;url=${esc(refresh)}">` : ""}<title>${esc(title)}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 16px"><h1 style="font-size:1.3rem">${esc(title)}</h1>${body}</body>`);
}

export class Auth {
	readonly #logins = new Map<string, { pending: Pending; binding: string; exp: number }>();
	readonly #renewed = new Map<string, number>();
	readonly config: LoginConfig;
	readonly space: SpaceLike;
	readonly now: () => number;
	constructor(config: LoginConfig, space: SpaceLike, now: () => number = Date.now) { this.config = config; this.space = space; this.now = now; }

	get origin(): string { return this.config.origin; }

	/** A browser request from our own origin: Origin must be ours, and a Fetch Metadata header, where sent, same-origin. */
	sameOrigin(req: http.IncomingMessage): boolean {
		const site = req.headers["sec-fetch-site"];
		return req.headers.origin === this.config.origin && (site === undefined || site === "same-origin");
	}

	/** The signed-in person of a request, or null. Renews the session's idle lease at most once a minute. */
	async who(req: http.IncomingMessage): Promise<Who | null> {
		const h = cookieOf(req, SESSION_COOKIE);
		if (!h || !/^[A-Za-z0-9_-]{43}$/.test(h)) return null;
		const key = sha(h);
		const e = await this.space.readIfExists({ type: "UserSession", fields: { key } }, NO_WAIT);
		if (!e) return null;
		const s = e.fields as unknown as UserSession;
		const now = this.now();
		if (s.expiresAt <= now) return null;
		const user = await this.space.readIfExists({ type: "ForumUser", fields: { userId: s.userId } }, NO_WAIT);
		if (!user) return null;
		if (now - (this.#renewed.get(key) ?? 0) >= RENEW_EVERY_MS) {
			this.#renewed.set(key, now);
			if (this.#renewed.size > 4096) this.#renewed.clear();
			await this.space.renew(e.id, Math.min(IDLE_MS, s.expiresAt - now)).catch(() => { /* taken meanwhile: it ends */ });
		}
		const u = user.fields as unknown as ForumUser;
		return { user: u, admin: this.config.admins.has(identityKey(u.issuer, u.subject)), csrf: s.csrf };
	}

	/** A request that changes something: the session, our origin and the session's CSRF token. */
	async whoChanging(req: http.IncomingMessage): Promise<Who | null> {
		if (!this.sameOrigin(req)) return null;
		const w = await this.who(req);
		if (!w) return null;
		return same(w.csrf, String(req.headers[CSRF_HEADER] ?? "")) ? w : null;
	}

	/** GET /auth/login: a fresh login (state, nonce, verifier) and the way to the provider. The login cookie binds the
	 *  callback to this browser; it is Lax, since the callback arrives as a navigation from the provider's site. */
	async begin(res: http.ServerResponse): Promise<void> {
		const now = this.now();
		for (const [k, v] of this.#logins) if (v.exp <= now) this.#logins.delete(k);
		if (this.#logins.size >= 1024) return page(res, 503, "Sign-in busy", "<p>Too many sign-ins at once. Try again in a minute.</p>");
		const pending = await this.config.oidc.begin();
		const binding = randomBytes(32).toString("base64url");
		this.#logins.set(pending.state, { pending, binding, exp: now + LOGIN_TTL_MS });
		res.writeHead(302, { location: pending.authorizeUrl, "cache-control": "no-store", "set-cookie": cookie(LOGIN_COOKIE, binding, { maxAgeS: LOGIN_TTL_MS / 1000, sameSite: "Lax" }) });
		res.end();
	}

	/** GET /auth/callback: the code exchanged and the ID token verified, the person found or made, a session. The
	 *  answer is a page that moves on to the forum, not a redirect: a SameSite=Strict cookie set at the end of a redirect
	 *  chain that began at the provider is not sent with the next request of that chain. */
	async complete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
		const l = this.#logins.get(state);
		this.#logins.delete(state);
		const again = `<p><a href="/auth/login">Sign in again</a></p>`;
		if (!l || l.exp <= this.now() || !code || !same(l.binding, cookieOf(req, LOGIN_COOKIE) ?? "")) return page(res, 400, "Sign-in failed", `<p>This sign-in was not started here, has expired or was used already.</p>${again}`, { "set-cookie": clear(LOGIN_COOKIE) });
		let who: Verified;
		try { who = await this.config.oidc.complete(l.pending, code); }
		catch { return page(res, 400, "Sign-in failed", `<p>The identity provider's answer could not be verified.</p>${again}`, { "set-cookie": clear(LOGIN_COOKIE) }); }
		const user = await this.#person(who);
		const handle = randomBytes(32).toString("base64url");
		// a new sign-in in this browser ends the one before
		const old = cookieOf(req, SESSION_COOKIE);
		if (old) await this.#end(old);
		const now = this.now();
		const s: UserSession = { key: sha(handle), userId: user.userId, csrf: randomBytes(24).toString("base64url"), expiresAt: now + ABSOLUTE_MS, ts: now };
		await this.space.write({ type: "UserSession", fields: s as never }, null, IDLE_MS);
		page(res, 200, "Signed in", `<p>Signed in. <a href="/">Go on to the forum</a></p>`, { "set-cookie": [cookie(SESSION_COOKIE, handle, { maxAgeS: ABSOLUTE_MS / 1000, sameSite: "Strict" }), clear(LOGIN_COOKIE)] }, "/");
	}

	/** POST /auth/logout: the session ends here; the answer names the provider's end-session address, where the page
	 *  goes on so that the next sign-in asks again. A provider that cannot be reached keeps nothing alive here. */
	async logout(req: http.IncomingMessage): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
		const h = cookieOf(req, SESSION_COOKIE);
		if (!this.sameOrigin(req) || !h || !(await this.whoChanging(req))) return { status: 403, body: { error: "Origin or CSRF token refused" }, headers: {} };
		await this.#end(h);
		let next: string | null = null;
		try { next = await this.config.oidc.endSessionUrl(`${this.config.origin}/`); } catch { /* signed out here all the same */ }
		return { status: 200, body: { next }, headers: { "set-cookie": clear(SESSION_COOKIE) } };
	}

	/** Sets the person's display name (1 to 40 characters, one line). */
	async rename(userId: string, raw: unknown): Promise<ForumUser> {
		const name = String(raw ?? "").replace(/\s+/g, " ").trim();
		if (!name || name.length > 40) throw new Error("A name has 1 to 40 characters");
		const t = await this.space.createTransaction(30_000);
		try {
			const e = await takeExisting(this.space, { type: "ForumUser", fields: { userId } }, { txn: t.id });
			if (!e) throw new Error("No such person");
			const u = { ...(e.fields as unknown as ForumUser), name };
			await this.space.write({ type: "ForumUser", fields: u as never }, t.id, FOREVER);
			await this.space.commit(t.id);
			return u;
		} catch (err) { await this.space.abort(t.id).catch(() => {}); throw err; }
	}

	async #end(handle: string): Promise<void> {
		if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) return;
		while (await this.space.takeIfExists({ type: "UserSession", fields: { key: sha(handle) } }, NO_WAIT)) { /* every copy */ }
	}

	/** The person of a verified identity: found by its ID, or made on the first sign-in with a name to change later. */
	async #person(who: Verified): Promise<ForumUser> {
		const userId = userIdOf(who.issuer, who.subject), now = this.now();
		for (let attempt = 0; attempt < 3; attempt++) {
			const e = await this.space.readIfExists({ type: "ForumUser", fields: { userId } }, NO_WAIT);
			if (e) {
				const u = e.fields as unknown as ForumUser;
				if (u.issuer !== who.issuer || u.subject !== who.subject) throw new Error("an identity collides with another person's ID");
				return u;
			}
			const u: ForumUser = { userId, issuer: who.issuer, subject: who.subject, name: `Person ${userId.slice(1, 5)}`, first: now };
			try { await this.space.write({ type: "ForumUser", fields: u as never }, null, FOREVER, { unique: ["userId"] }); return u; }
			catch { /* a second sign-in of the same person made it first: read it */ }
		}
		throw new Error("The person could not be stored");
	}
}
