// codemode-forum, the web process: HTTP + WebSocket server around the Next.js app (the API and /ws are served here,
// pages by Next). It holds no data of its own: rooms and runs live in the shared space (space-host.ts), which it
// reaches over FORUM_SPACE; agents and models run in their own processes. `npm run dev` starts them all.
// Taken over from codemode-chat/server/index.ts.
// Run: node --experimental-strip-types codemode-forum/server/index.ts [--dev]
// Env (also read from codemode-forum/.env): PORT (4100), FORUM_BIND (127.0.0.1), FORUM_SPACE (unix:/tmp/codemode-forum-space.sock),
//      FORUM_HOST_NAME (name in the system bar),
//      FORUM_ADMIN_PASSWORD (the admin login; scripts may send it as the header x-admin-token; unset: no admin),
//      FORUM_REQ_PER_MIN (API requests and WebSocket connects per client IP and minute, default 120),
//      FORUM_TTL_HOURS (lifetime of a room's entries in hours, default 8760; 0 = for good).
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ROOT } from "./env.ts";
import { pathToFileURL } from "node:url";
import { NO_WAIT } from "phi-spaces";
import { upgradeWebSocket } from "phi-spaces/ws";
import { ForumHub } from "./hub.ts";
import { announce, connectSpace, takeAll } from "./space.ts";

const ID = /^[a-zA-Z0-9._-]{1,48}$/;

/** The client address: behind the local reverse proxy (loopback peer) the last x-forwarded-for hop, else the peer. */
function clientIp(req: http.IncomingMessage): string {
	const peer = req.socket.remoteAddress ?? "local";
	const xff = req.headers["x-forwarded-for"];
	if (!/^(127\.|::1$|::ffff:127\.)/.test(peer) || typeof xff !== "string" || !xff.trim()) return peer;
	return xff.split(",").at(-1)!.trim() || peer;
}

/** Sliding one-minute request quota per client IP (at most 4096 tracked addresses). */
function quota(perMin: number): (ip: string) => boolean {
	const seen = new Map<string, { at: number; count: number }>();
	return (ip) => {
		const now = Date.now();
		if (seen.size >= 4096) for (const [k, v] of seen) if (now - v.at >= 60_000) seen.delete(k);
		let v = seen.get(ip);
		if (!v || now - v.at >= 60_000) { if (!v && seen.size >= 4096) return false; v = { at: now, count: 0 }; seen.set(ip, v); }
		return ++v.count <= perMin;
	};
}

/** The admin password from .env. */
const adminSecret = (): string | undefined => process.env.FORUM_ADMIN_PASSWORD || undefined;

/** Constant-time check of a presented admin password; without a configured one nobody is admin. */
function tokenOk(got: unknown): boolean {
	const want = adminSecret();
	if (!want || typeof got !== "string") return false;
	const h = (v: string) => createHash("sha256").update(v).digest();
	return timingSafeEqual(h(want), h(got));
}

const ADMIN_COOKIE = "forum_admin";
const ADMIN_TTL_MS = 12 * 3600_000;
const cookieOf = (req: http.IncomingMessage, name: string): string | undefined => {
	for (const part of String(req.headers.cookie ?? "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
	return undefined;
};

/** `space`: the shared space (default FORUM_SPACE, else unix:/tmp/codemode-forum-space.sock). */
export async function startServer(o: { port?: number; bind?: string; space?: string; useNext?: boolean; dev?: boolean } = {}) {
	const conn = connectSpace(o.space);
	const hub = new ForumHub(conn.space);
	const presence = announce(conn.space, "web");

	let nextHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null = null;
	let nextUpgrade: ((req: http.IncomingMessage, socket: any, head: Buffer) => void) | null = null;
	if (o.useNext) {
		const mod = await import("next");
		const app = ((mod as any).default ?? mod)({ dev: Boolean(o.dev), dir: ROOT });
		await app.prepare();
		nextHandler = app.getRequestHandler();
		if (typeof app.getUpgradeHandler === "function") nextUpgrade = app.getUpgradeHandler();
	}

	const allowed = quota(Number(process.env.FORUM_REQ_PER_MIN ?? 120));
	// admin sessions after a login with the password (HttpOnly cookie); a POST with the cookie must also carry the header
	// x-forum-admin (a cross-site form cannot set it), or the password itself as x-admin-token (scripts, tests). A session
	// is an AdminSession entry in the space (leased for its lifetime), so every web process knows it and a restart keeps
	// it; the entry holds the hash of the cookie, never the cookie itself
	const sessionKey = (sid: string) => createHash("sha256").update(sid).digest("hex");
	const loginTries = quota(10);
	const isAdmin = async (req: http.IncomingMessage): Promise<boolean> => {
		if (tokenOk(req.headers["x-admin-token"])) return true;
		const sid = cookieOf(req, ADMIN_COOKIE);
		if (!sid || !/^[0-9a-f]{48}$/.test(sid)) return false;
		if (!(await conn.space.readIfExists({ type: "AdminSession", fields: { key: sessionKey(sid) } }, NO_WAIT))) return false;
		return req.method === "GET" || req.headers["x-forum-admin"] === "1";
	};
	const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
	const readBody = (req: http.IncomingMessage, max = 64_000) => new Promise<Record<string, any>>((ok, fail) => {
		let n = 0; const parts: Buffer[] = [];
		req.on("data", (c: Buffer) => { n += c.length; if (n > max) { fail(new Error("Body too large")); req.destroy(); } else parts.push(c); });
		req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { fail(new Error("Invalid JSON")); } });
		req.on("error", fail);
	});

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			const p = url.pathname;
			if (p === "/healthz") return json(res, 200, { ok: true });
			if (p.startsWith("/api/") && !allowed(clientIp(req))) return json(res, 429, { error: "Too many requests; retry in a minute" });
			if (p === "/api/system") return json(res, 200, await hub.systemInfo());
			if (p === "/api/models" && req.method === "GET") return json(res, 200, (await hub.modelInfo()).info);
			// the repositories a task may name as a source: only an admin may, so only an admin learns their names
			if (p === "/api/sources" && req.method === "GET") { const admin = await isAdmin(req); return json(res, 200, { repos: admin ? await hub.repos() : [], hosts: admin ? await hub.gitHosts() : [] }); }
			// ---- admin panel: login with the password from .env, then the choice of models ----
			if (p === "/api/admin/session" && req.method === "GET") return json(res, 200, { admin: (await isAdmin(req)), available: !!adminSecret() });
			if (p === "/api/admin/login" && req.method === "POST") {
				if (!loginTries(clientIp(req))) return json(res, 429, { error: "Too many login attempts; retry in a minute" });
				const body = await readBody(req);
				if (!tokenOk(body.password)) return json(res, 403, { error: "Wrong admin password" });
				const sid = randomBytes(24).toString("hex");
				await conn.space.write({ type: "AdminSession", fields: { key: sessionKey(sid), ts: Date.now() } }, null, ADMIN_TTL_MS);
				const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": `${ADMIN_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TTL_MS / 1000}${secure}` });
				return res.end(JSON.stringify({ admin: true }));
			}
			if (p === "/api/admin/logout" && req.method === "POST") {
				const sid = cookieOf(req, ADMIN_COOKIE);
				if (sid) await takeAll(conn.space, { type: "AdminSession", fields: { key: sessionKey(sid) } });
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
				return res.end(JSON.stringify({ admin: false }));
			}
			if (p === "/api/admin/models") {
				if (!(await isAdmin(req))) return json(res, 403, { error: "Admin login required" });
				if (req.method === "POST") {
					const b = await readBody(req);
					if (b.allowed !== null && !Array.isArray(b.allowed)) return json(res, 400, { error: "allowed: a list of model labels, or null for the choice of FORUM_MODELS" });
					if (Array.isArray(b.allowed)) {
						const known = new Set((await hub.modelInfo()).admin.models.map((m) => m.label));
						const unknown = (b.allowed as unknown[]).map(String).filter((l) => !known.has(l));
						if (unknown.length) return json(res, 400, { error: `Unknown models: ${unknown.slice(0, 5).join(", ")}` });
					}
					await hub.saveAllowedModels(b.allowed === null ? null : (b.allowed as unknown[]).map(String));
					if (typeof b.on === "boolean") await hub.saveLlmOn(b.on);
				}
				// what the model process published, with the choice just saved (it takes it over within 10 s)
				const admin = (await hub.modelInfo()).admin;
				return json(res, 200, req.method === "POST" ? { ...admin, ...(await hub.adminChoice()) } : admin);
			}
			// the result as Markdown with its appendix: /api/plan/<room>/<block>.md (the plan's address), the same under
			// /api/rooms; ?table= and ?version= name another version, ?plain=1 leaves the appendix out
			const pl = /^\/api\/rooms\/([^/]+)\/plan\/([a-z0-9]{1,40})(\.md)?$/.exec(p) ?? /^\/api\/plan\/([^/]+)\/([a-z0-9]{1,40})(\.md)$/.exec(p);
			if (pl && req.method === "GET") {
				if (!ID.test(pl[1]!)) return json(res, 400, { error: "Invalid room id" });
				const v = url.searchParams.get("version");
				if (v !== null && !/^\d{1,6}$/.test(v)) return json(res, 400, { error: "Invalid version" });
				if (pl[3]) {
					const md = await hub.planMarkdown(pl[1]!, pl[2]!, { table: url.searchParams.get("table"), ...(v === null ? {} : { version: Number(v) }), plain: url.searchParams.get("plain") === "1" });
					if (md === null) return json(res, 404, { error: "No document yet" });
					res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", ...(url.searchParams.get("download") === "1" ? { "content-disposition": `attachment; filename="plan-${pl[2]}.md"` } : {}) });
					return res.end(md);
				}
				const got = await hub.plan(pl[1]!, pl[2]!, v === null ? undefined : Number(v), url.searchParams.get("table"));
				return got ? json(res, 200, got) : json(res, 404, { error: "No document yet" });
			}
			const oc = /^\/api\/rooms\/([^/]+)\/outcome\/([a-z0-9]{1,40})$/.exec(p);
			if (oc && req.method === "GET") return ID.test(oc[1]!) ? json(res, 200, await hub.outcome(oc[1]!, oc[2]!)) : json(res, 400, { error: "Invalid room id" });
			const tk = /^\/api\/rooms\/([^/]+)\/talk\/([a-z0-9]{1,40})$/.exec(p);
			if (tk && req.method === "GET") return ID.test(tk[1]!) ? json(res, 200, await hub.talk(tk[1]!, tk[2]!, url.searchParams.get("table"))) : json(res, 400, { error: "Invalid room id" });
			const m = /^\/api\/rooms\/([^/]+)(?:\/(task|run|stop|message|accept|objection))?$/.exec(p);
			if (m) {
				const id = m[1]!, action = m[2];
				if (!ID.test(id)) return json(res, 400, { error: "Invalid room id" });
				if (!action && req.method === "GET") return json(res, 200, await hub.snapshot(id));
				if (!action || req.method !== "POST") return json(res, 405, { error: "POST expected" });
				// a task may bring documents (sources.ts: at most 800 kB together)
				const b = await readBody(req, action === "task" ? 1_500_000 : 64_000);
				// a visitor's run: the default token budget at most, counted against the day's allowance of the address
				if (action === "task") return json(res, 200, { ok: true, ...(await hub.createTask(id, { brief: b.brief, lang: b.lang, outline: b.outline, criteria: b.criteria, docs: b.docs, repo: b.repo, admin: await isAdmin(req) })) });
				if (action === "run") return json(res, 200, { ok: true, ...(await hub.startRun(id, { blockId: b.blockId, way: b.way, rounds: b.rounds, models: b.models, perModel: b.perModel, budgetTokens: b.budgetTokens, budgetUsd: b.budgetUsd, client: { ip: clientIp(req), admin: await isAdmin(req) } })) });
				if (action === "accept") return json(res, 200, { ok: true, ...(await hub.accept(id, { blockId: b.blockId, version: b.version, by: b.by, table: b.table })) });
				if (action === "objection") return json(res, 200, { ok: true, ...(await hub.object(id, { blockId: b.blockId, section: b.section, text: b.text, fix: b.fix, by: b.by, table: b.table })) });
				if (action === "message") return json(res, 200, { ok: true, ...(await hub.say(id, { blockId: b.blockId, thread: b.thread, text: b.text, by: b.by })) });
				await hub.stopRun(id);
				return json(res, 200, { ok: true });
			}
			if (nextHandler) return await nextHandler(req, res);
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("Not found");
		} catch (e) {
			json(res, 400, { error: (e as Error).message });
		}
	};

	const server = http.createServer((req, res) => void handle(req, res));
	// upgraded sockets (our /ws and Next's HMR) are not closed by server.close(): track every socket and destroy them on shutdown
	const conns = new Set<import("node:net").Socket>();
	server.on("connection", (s) => { conns.add(s); s.on("close", () => conns.delete(s)); });
	let sockets = 0;
	server.on("upgrade", (req, socket, head) => {
		const m = /^\/ws\/([a-zA-Z0-9._-]{1,48})$/.exec(new URL(req.url ?? "/", "http://localhost").pathname);
		if (!m) { if (nextUpgrade) nextUpgrade(req, socket, head); else socket.destroy(); return; }
		if (sockets >= 256 || !allowed(clientIp(req))) return void socket.destroy();
		const ws = upgradeWebSocket(req, socket, head);
		if (!ws) return;
		sockets++; ws.onClose(() => { sockets--; });
		void hub.attach(m[1]!, ws).catch((e) => { console.error("[forum] websocket attach failed", (e as Error).message); ws.close(); });
	});
	const port = o.port ?? Number(process.env.PORT ?? 4100), bind = o.bind ?? process.env.FORUM_BIND ?? "127.0.0.1";
	await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, bind, () => ok()); });
	const addr = server.address();
	const actual = typeof addr === "object" && addr ? addr.port : port;
	return {
		url: `http://127.0.0.1:${actual}`, port: actual, hub,
		async close() { await hub.close(); await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); for (const s of conns) s.destroy(); }); await presence.stop(); conn.close(); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const srv = await startServer({ useNext: true, dev: process.argv.includes("--dev") });
	console.log(`PHI-SPACES / CODEMODE FORUM listening on ${srv.url}`);
	const dev = process.argv.includes("--dev");
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
		// dev: exit at once, so `node --watch` can start the replacement before Next's dev lock is still held
		if (dev) process.exit(0);
		setTimeout(() => process.exit(0), 3000).unref();
		void srv.close().finally(() => process.exit(0));
	});
}
