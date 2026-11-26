// A development OpenID provider for the tests of the sign-in, taken over from spaces-files/server/dev-idp.ts (its
// command-line part left out, so this copy is not held equal to it): discovery, the code flow with PKCE, an ES256
// ID token with auth_time, an end-session endpoint; it proves nothing and listens on a loopback address only.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import http from "node:http";

/** `postLogoutRedirectUris`: where the end-session endpoint may send a browser back; by default `/` of each redirect URI's origin. */
export type DevIdpClient = { clientId: string; redirectUris: string[]; clientSecret?: string; postLogoutRedirectUris?: string[] };
export type DevIdp = {
	issuer: string;
	/** Tests: sign an ID token with these claims (iss and kid filled in unless given). */
	signIdToken(claims: Record<string, unknown>, o?: { kid?: string; key?: KeyObject; alg?: string }): string;
	/** Tests: what the login form posts, without a browser; answers the redirect location. */
	authorize(query: URLSearchParams, subject: string, o?: { authTime?: number }): Promise<string>;
	close(): Promise<void>;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startDevIdp(o: { host?: string; port?: number; clients: DevIdpClient[]; now?: () => number }): Promise<DevIdp> {
	const host = o.host ?? "127.0.0.1";
	if (!LOOPBACK.has(host)) throw new Error("the development IdP listens on a loopback address only");
	const now = o.now ?? Date.now;
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const kid = randomBytes(8).toString("base64url");
	const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; nonce: string; subject: string; exp: number; authTime?: number }>();
	let issuer = "";

	const signIdToken: DevIdp["signIdToken"] = (claims, k = {}) => {
		const header = { alg: k.alg ?? "ES256", typ: "JWT", kid: k.kid ?? kid };
		const body = { iss: issuer, ...claims };
		const data = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
		const sig = sign("sha256", Buffer.from(data), { key: k.key ?? privateKey, dsaEncoding: "ieee-p1363" });
		return `${data}.${sig.toString("base64url")}`;
	};

	/** Validates an authorization request; returns its client or an error text. */
	const check = (q: URLSearchParams) => {
		const c = o.clients.find((c) => c.clientId === q.get("client_id"));
		if (!c || !c.redirectUris.includes(q.get("redirect_uri") ?? "")) return "unknown client or redirect URI";
		if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state") || !q.get("nonce")) return "a code flow with PKCE (S256), state and nonce is required";
		return c;
	};
	const grant = (q: URLSearchParams, subject: string, authTime?: number) => {
		const code = randomBytes(24).toString("base64url");
		codes.set(code, { clientId: q.get("client_id")!, redirectUri: q.get("redirect_uri")!, challenge: q.get("code_challenge")!, nonce: q.get("nonce")!, subject, exp: now() + 60_000, authTime });
		const to = new URL(q.get("redirect_uri")!);
		to.searchParams.set("code", code);
		to.searchParams.set("state", q.get("state")!);
		return to.toString();
	};
	const token = (f: URLSearchParams) => {
		const code = f.get("code") ?? "";
		const g = codes.get(code);
		codes.delete(code); // single use
		if (!g || g.exp <= now()) return null;
		const c = o.clients.find((c) => c.clientId === g.clientId)!;
		if (f.get("grant_type") !== "authorization_code" || f.get("client_id") !== g.clientId || f.get("redirect_uri") !== g.redirectUri) return null;
		if (c.clientSecret !== undefined && f.get("client_secret") !== c.clientSecret) return null;
		if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== g.challenge) return null;
		const t = Math.floor(now() / 1000);
		// this provider keeps no session of its own: every authorization is an authentication of that moment
		return { id_token: signIdToken({ sub: g.subject, aud: g.clientId, iat: t, exp: t + 300, nonce: g.nonce, auth_time: g.authTime ?? t }), token_type: "Bearer" };
	};

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", issuer);
		const json = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(v)); };
		const body = async () => {
			let s = "";
			for await (const c of req) { s += c; if (s.length > 16 * 1024) break; }
			return new URLSearchParams(s);
		};
		if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration")
			return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"], code_challenge_methods_supported: ["S256"] });
		if (req.method === "GET" && url.pathname === "/jwks") return json(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }] });
		if (url.pathname === "/authorize") {
			const q = req.method === "POST" ? await body() : url.searchParams;
			const c = check(q);
			if (typeof c === "string") { res.writeHead(400, { "content-type": "text/plain" }); res.end(c); return; }
			const subject = q.get("subject");
			if (req.method === "POST" && subject && /^[A-Za-z0-9_.@-]{1,64}$/.test(subject)) { res.writeHead(302, { location: grant(q, subject) }); res.end(); return; }
			const hidden = [...q].filter(([k]) => k !== "subject").map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *" });
			res.end(`<!doctype html><meta charset="utf-8"><title>Development login</title><body style="font:16px system-ui;max-width:24rem;margin:4rem auto"><h1>Development login</h1><p>This identity provider proves nothing. It runs on this machine only.</p><form method="post">${hidden}<label>Subject <input name="subject" autofocus required pattern="[A-Za-z0-9_.@-]{1,64}"></label> <button>Sign in</button></form>`);
			return;
		}
		if (req.method === "GET" && url.pathname === "/logout") {
			// RP-initiated logout: nothing to end here, the browser goes back only to a place the client registered
			const c = o.clients.find((c) => c.clientId === url.searchParams.get("client_id"));
			const to = url.searchParams.get("post_logout_redirect_uri") ?? "";
			const allowed = c ? (c.postLogoutRedirectUris ?? c.redirectUris.map((r) => new URL(r).origin + "/")) : [];
			if (!allowed.includes(to)) { res.writeHead(400, { "content-type": "text/plain" }); res.end("unknown client or post-logout redirect URI"); return; }
			res.writeHead(302, { location: to }); res.end(); return;
		}
		if (req.method === "POST" && url.pathname === "/token") {
			const t = token(await body());
			return t ? json(200, t) : json(400, { error: "invalid_grant" });
		}
		json(404, { error: "not found" });
	});
	await new Promise<void>((r) => server.listen(o.port ?? 0, host, r));
	const addr = server.address() as { port: number };
	issuer = `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;
	return {
		get issuer() { return issuer; },
		signIdToken,
		authorize: async (q, subject, a = {}) => {
			const c = check(q);
			if (typeof c === "string") throw new Error(c);
			return grant(q, subject, a.authTime);
		},
		close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
	};
}

