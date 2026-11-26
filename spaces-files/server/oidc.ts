// The relying party of the browser login (docs/zanzibar-agent-filesystem-plan.en.md, section 2, *Identity*): OpenID
// Connect discovery, the authorization-code flow with PKCE (S256), state and nonce, the code exchanged at the token
// endpoint, and the ID token verified on the server: signature by the issuer's JWKS (RS256, ES256 or EdDSA), issuer,
// audience and authorized party, expiry, issue time within the clock skew, and the nonce of this login. A login may
// demand a fresh authentication (`max_age`, checked against the token's `auth_time`), and a sign-out can be carried
// on to the provider (`end_session_endpoint`, RP-initiated logout). Only node:http,
// node:https and node:crypto; an issuer must be https, except on a loopback address (the development IdP).
import { createHash, createPublicKey, randomBytes, verify as verifySig, type KeyObject } from "node:crypto";
import http from "node:http";
import https from "node:https";

export type OidcConfig = {
	issuer: string;
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
	/** PEM of a CA to trust for the issuer's TLS (a local IdP with its own certificate). */
	ca?: string;
	clockSkewMs?: number;
	now?: () => number;
};

export type Verified = { issuer: string; subject: string };

export class OidcError extends Error {
	constructor(message: string) { super(message); this.name = "OidcError"; }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_REPLY = 256 * 1024;
const b64u = (b: Buffer) => b.toString("base64url");

export function checkIssuerUrl(u: string): URL {
	let url: URL;
	try { url = new URL(u); } catch { throw new OidcError("the issuer is no URL"); }
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new OidcError("the issuer must be https (http only on a loopback address)");
	return url;
}

/** GET or POST (form) one JSON document, bounded, without redirects. */
export function fetchJson(url: string, o: { form?: Record<string, string>; ca?: string; basic?: [string, string] } = {}): Promise<Record<string, unknown>> {
	const u = checkIssuerUrl(url);
	const body = o.form ? new URLSearchParams(o.form).toString() : undefined;
	const headers: Record<string, string> = { accept: "application/json" };
	if (body !== undefined) { headers["content-type"] = "application/x-www-form-urlencoded"; headers["content-length"] = String(Buffer.byteLength(body)); }
	if (o.basic) headers.authorization = "Basic " + Buffer.from(`${encodeURIComponent(o.basic[0])}:${encodeURIComponent(o.basic[1])}`).toString("base64");
	const mod = u.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const req = mod.request(u, { method: body === undefined ? "GET" : "POST", headers, timeout: 10_000, ...(o.ca && u.protocol === "https:" ? { ca: o.ca } : {}) }, (res) => {
			const chunks: Buffer[] = [];
			let n = 0;
			res.on("data", (c: Buffer) => { n += c.length; if (n > MAX_REPLY) { req.destroy(new OidcError("the issuer's reply is too large")); return; } chunks.push(c); });
			res.on("end", () => {
				let j: unknown;
				try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(new OidcError(`the issuer answered ${res.statusCode} without JSON`)); return; }
				if (res.statusCode !== 200 || typeof j !== "object" || j === null || Array.isArray(j)) { reject(new OidcError(`the issuer answered ${res.statusCode}`)); return; }
				resolve(j as Record<string, unknown>);
			});
		});
		req.on("timeout", () => req.destroy(new OidcError("the issuer did not answer")));
		req.on("error", (e) => reject(e instanceof OidcError ? e : new OidcError(`the issuer is unreachable: ${e.message}`)));
		req.end(body);
	});
}

/** `authAfter` (ms): the provider must have authenticated the person at or after it; set by a login with `maxAgeS`. */
export type Pending = { state: string; nonce: string; verifier: string; authorizeUrl: string; authAfter?: number };

export class OidcClient {
	readonly #c: Required<Pick<OidcConfig, "issuer" | "clientId" | "redirectUri" | "clockSkewMs">> & OidcConfig;
	#meta?: { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: unknown };
	#keys = new Map<string, { key: KeyObject; alg?: string; kty: string; crv?: string }>();
	#keysAt = 0;

	constructor(c: OidcConfig) {
		checkIssuerUrl(c.issuer);
		this.#c = { clockSkewMs: 120_000, ...c };
	}
	get issuer(): string { return this.#c.issuer; }
	#now() { return (this.#c.now ?? Date.now)(); }

	async #discover() {
		if (this.#meta) return this.#meta;
		const m = await fetchJson(this.#c.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", { ca: this.#c.ca });
		if (m.issuer !== this.#c.issuer) throw new OidcError("the discovery document names another issuer");
		for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) if (typeof m[k] !== "string") throw new OidcError(`the discovery document lacks ${k}`);
		for (const k of ["token_endpoint", "jwks_uri"]) checkIssuerUrl(m[k] as string);
		this.#meta = m as never;
		return this.#meta!;
	}

	/** A new login: fresh state, nonce and PKCE verifier, and the URL to send the browser to. With `maxAgeS` the
	 *  provider is asked for an authentication no older than that (0: now), and the ID token must prove it: its
	 *  `auth_time` may lie before this login by `maxAgeS` and the clock skew, no more. */
	async begin(o: { maxAgeS?: number } = {}): Promise<Pending> {
		const m = await this.#discover();
		const state = b64u(randomBytes(32)), nonce = b64u(randomBytes(32)), verifier = b64u(randomBytes(32));
		const u = new URL(m.authorization_endpoint);
		u.search = new URLSearchParams({
			response_type: "code", client_id: this.#c.clientId, redirect_uri: this.#c.redirectUri, scope: "openid",
			state, nonce, code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
			// max_age gives the claim that is checked (auth_time); with 0, prompt=login also makes the provider ask in the
			// very second it last did (a provider compares whole seconds)
			...(o.maxAgeS !== undefined ? { max_age: String(o.maxAgeS) } : {}), ...(o.maxAgeS === 0 ? { prompt: "login" } : {}),
		}).toString();
		return { state, nonce, verifier, authorizeUrl: u.toString(), ...(o.maxAgeS !== undefined ? { authAfter: this.#now() - o.maxAgeS * 1000 } : {}) };
	}

	/** Exchanges the code of a returning browser and verifies its ID token against the pending login. */
	async complete(p: Pending, code: string): Promise<Verified> {
		const m = await this.#discover();
		const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: this.#c.redirectUri, code_verifier: p.verifier, client_id: this.#c.clientId };
		if (this.#c.clientSecret !== undefined) form.client_secret = this.#c.clientSecret;
		const tok = await fetchJson(m.token_endpoint, { form, ca: this.#c.ca });
		if (typeof tok.id_token !== "string") throw new OidcError("the token endpoint returned no ID token");
		return this.verifyIdToken(tok.id_token, p.nonce, p.authAfter);
	}

	/** Where to send the browser after the local sign-out so that the provider's session ends too, or null when the
	 *  provider names no end-session endpoint. No ID token is kept for a hint: the client ID names the party. */
	async endSessionUrl(postLogoutRedirectUri: string): Promise<string | null> {
		const m = await this.#discover();
		if (typeof m.end_session_endpoint !== "string") return null;
		const u = checkIssuerUrl(m.end_session_endpoint);
		u.searchParams.set("client_id", this.#c.clientId);
		u.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
		return u.toString();
	}

	async verifyIdToken(jwt: string, nonce: string, authAfter?: number): Promise<Verified> {
		const parts = jwt.split(".");
		if (parts.length !== 3) throw new OidcError("the ID token is no JWS");
		let header: Record<string, unknown>, claims: Record<string, unknown>;
		try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
		catch { throw new OidcError("the ID token is malformed"); }
		const alg = header.alg;
		if (alg !== "RS256" && alg !== "ES256" && alg !== "EdDSA") throw new OidcError("the ID token's algorithm is not accepted");
		const key = await this.#key(header.kid);
		const kty = alg === "RS256" ? "RSA" : alg === "ES256" ? "EC" : "OKP";
		if (key.kty !== kty || (key.alg !== undefined && key.alg !== alg) || (alg === "ES256" && key.crv !== "P-256")) throw new OidcError("the ID token's key does not fit its algorithm");
		const data = Buffer.from(`${parts[0]}.${parts[1]}`);
		const sig = Buffer.from(parts[2], "base64url");
		const ok = alg === "EdDSA" ? verifySig(null, data, key.key, sig)
			: verifySig("sha256", data, alg === "ES256" ? { key: key.key, dsaEncoding: "ieee-p1363" } : key.key, sig);
		if (!ok) throw new OidcError("the ID token's signature is invalid");
		const now = this.#now(), skew = this.#c.clockSkewMs;
		if (claims.iss !== this.#c.issuer) throw new OidcError("the ID token names another issuer");
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!aud.includes(this.#c.clientId)) throw new OidcError("the ID token is for another audience");
		if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== this.#c.clientId) throw new OidcError("the ID token's authorized party is another");
		if (typeof claims.exp !== "number" || claims.exp * 1000 <= now - skew) throw new OidcError("the ID token has expired");
		if (typeof claims.iat !== "number" || claims.iat * 1000 > now + skew) throw new OidcError("the ID token is issued in the future");
		if (claims.nonce !== nonce) throw new OidcError("the ID token's nonce is not this login's");
		if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) throw new OidcError("the ID token has no subject");
		if (authAfter !== undefined && (typeof claims.auth_time !== "number" || claims.auth_time * 1000 < authAfter - skew)) throw new OidcError("the ID token proves no fresh authentication");
		return { issuer: this.#c.issuer, subject: claims.sub };
	}

	async #key(kid: unknown) {
		if (kid !== undefined && typeof kid !== "string") throw new OidcError("the ID token's key ID is malformed");
		const find = () => kid === undefined ? (this.#keys.size === 1 ? [...this.#keys.values()][0] : undefined) : this.#keys.get(kid);
		let k = find();
		// an unknown key ID: the issuer may have rotated; fetch its keys again, at most once a minute
		if (!k && this.#now() - this.#keysAt >= 60_000) { await this.#loadKeys(); k = find(); }
		if (!k) throw new OidcError("the ID token's key is unknown");
		return k;
	}

	async #loadKeys() {
		const m = await this.#discover();
		const set = await fetchJson(m.jwks_uri, { ca: this.#c.ca });
		this.#keysAt = this.#now();
		const keys = new Map<string, { key: KeyObject; alg?: string; kty: string; crv?: string }>();
		for (const jwk of Array.isArray(set.keys) ? set.keys : []) {
			if (typeof jwk !== "object" || jwk === null || (jwk.use !== undefined && jwk.use !== "sig")) continue;
			try { keys.set(typeof jwk.kid === "string" ? jwk.kid : "", { key: createPublicKey({ key: jwk, format: "jwk" }), alg: jwk.alg, kty: jwk.kty, crv: jwk.crv }); }
			catch { /* a key this process cannot read is no key */ }
		}
		this.#keys = keys;
	}
}
