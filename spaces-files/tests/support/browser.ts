// The browser side for the adapter tests: a self-signed certificate made with openssl (a system tool, as in
// spaces/test/test-netcup-fencing.test.ts), a tiny HTTPS client with a cookie jar that follows no redirects, and the
// whole sign-in through the development IdP. Each browser is one jar, so two of them are two users.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevIdp, type DevIdp } from "../../server/dev-idp.ts";
import { serveHttp, type HttpServer } from "../../server/http.ts";
import { OidcClient } from "../../server/oidc.ts";
import type { FilesService } from "../../server/service.ts";

let tls: { cert: string; key: string } | undefined;
export function testCert(): { cert: string; key: string } {
	if (tls) return tls;
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-tls-"));
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "key.pem", "-out", "cert.pem",
			"-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { cwd: dir, stdio: "ignore" });
		tls = { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
		return tls;
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

export const freePort = () => new Promise<number>((resolve) => {
	const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

export type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json?: { ok: boolean; value?: any; error?: { code: string; message: string; currentVersion?: number } } };

export class Browser {
	readonly jar = new Map<string, string>();
	csrf = "";
	readonly origin: string;
	/** Where requests go when it is not the origin: a plain-HTTP server behind the proxy that serves the origin. */
	readonly base: string;
	constructor(origin: string, base?: string) { this.origin = origin; this.base = base ?? origin; }

	async request(method: string, path: string, o: { body?: string | Buffer; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Res> {
		const u = new URL(path, this.base);
		const headers: Record<string, string> = { ...(o.headers ?? {}) };
		if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
		const originHeader = o.origin === undefined ? (method === "GET" ? null : this.origin) : o.origin;
		if (originHeader !== null) headers.origin = originHeader;
		if (o.body !== undefined) headers["content-length"] = String(Buffer.byteLength(o.body));
		return new Promise((resolve, reject) => {
			const req = (u.protocol === "http:" ? http.request(u, { method, headers }, onRes) : https.request(u, { method, headers, ca: testCert().cert }, onRes));
			const self = this;
			function onRes(res: import("node:http").IncomingMessage) {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
						const [pair] = c.split(";");
						const i = pair.indexOf("=");
						const name = pair.slice(0, i), value = pair.slice(i + 1);
						if (/Max-Age=0/.test(c) || value === "") self.jar.delete(name); else self.jar.set(name, value);
					}
					const body = Buffer.concat(chunks).toString("utf8");
					let json;
					try { json = JSON.parse(body); } catch { /* a page */ }
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
				});
			}
			req.on("error", reject);
			req.end(o.body);
		});
	}

	/** One API call with this browser's CSRF token. */
	async call(op: string, args: Record<string, unknown> = {}): Promise<Res> {
		return this.request("POST", "/api/call", { body: JSON.stringify({ op, args }), headers: { "content-type": "application/json", "x-files-csrf": this.csrf } });
	}
	/** The value of a call, or the thrown public error. */
	async must<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
		const r = await this.call(op, args);
		if (!r.json?.ok) throw Object.assign(new Error(`${r.json?.error?.code}: ${r.json?.error?.message}`), { code: r.json?.error?.code, currentVersion: r.json?.error?.currentVersion });
		return r.json.value as T;
	}
	async opId(): Promise<string> { return (await this.must<string[]>("issueOperationIds", { count: 1 }))[0]; }
	async session(): Promise<Res> {
		const r = await this.request("GET", "/api/session");
		if (r.json?.ok) this.csrf = r.json.value.csrf;
		return r;
	}

	/** Signs in with a username and password (/auth/login shows the form, POST /auth/password). */
	async passwordSignIn(username: string, password: string, extra = ""): Promise<Res> {
		const r = await this.request("POST", "/auth/password", { body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}${extra}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
		await this.session();
		return r;
	}

	/** Signs in at the IdP as `subject`: /auth/login, the IdP's form, the callback. Answers the callback's response. */
	async signIn(idp: DevIdp, subject: string, tenant?: string): Promise<Res> {
		const start = await this.request("GET", "/auth/login" + (tenant ? `?tenant=${encodeURIComponent(tenant)}` : ""));
		if (start.status !== 302) throw new Error(`login answered ${start.status}`);
		const to = new URL(await idp.authorize(new URL(String(start.headers.location)).searchParams, subject));
		const cb = await this.request("GET", to.pathname + to.search);
		await this.session();
		return cb;
	}

	/** Signs in for recovery (/recovery/login?tenant=) and takes the recovery session's CSRF token. */
	async recoverySignIn(idp: DevIdp, subject: string, tenant: string): Promise<Res> {
		const start = await this.request("GET", `/recovery/login?tenant=${encodeURIComponent(tenant)}`);
		if (start.status !== 302) throw new Error(`recovery login answered ${start.status}`);
		const to = new URL(await idp.authorize(new URL(String(start.headers.location)).searchParams, subject));
		const cb = await this.request("GET", to.pathname + to.search);
		const r = await this.request("GET", "/api/recovery/session");
		if (r.json?.ok) this.csrf = r.json.value.csrf;
		return cb;
	}
	/** One recovery call. */
	async recover(op: string, args: Record<string, unknown> = {}): Promise<Res> {
		return this.request("POST", "/api/recovery", { body: JSON.stringify({ op, args }), headers: { "content-type": "application/json", "x-files-csrf": this.csrf } });
	}
}

export async function webStack(svc: FilesService, o: { maxInflight?: number } = {}): Promise<{ http: HttpServer; idp: DevIdp; origin: string; browser(): Browser; close(): Promise<void> }> {
	const port = await freePort();
	const origin = `https://localhost:${port}`;
	const idp = await startDevIdp({ clients: [{ clientId: "files-test", redirectUris: [`${origin}/auth/callback`] }] });
	const oidc = new OidcClient({ issuer: idp.issuer, clientId: "files-test", redirectUri: `${origin}/auth/callback` });
	const http = await serveHttp(svc, { listen: { host: "127.0.0.1", port }, tls: testCert(), origin, oidc, maxInflight: o.maxInflight });
	return { http, idp, origin, browser: () => new Browser(origin), close: async () => { await http.close(); await idp.close(); } };
}
