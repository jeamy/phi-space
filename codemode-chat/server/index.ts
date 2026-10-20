// Codemode chat: HTTP + WebSocket server around the Next.js 16 app (the API and /ws are served here, pages by Next).
// Run: node --experimental-strip-types codemode-chat/server/index.ts [--dev]
// Env (also read from codemode-chat/.env): PORT (3700), CODEMODE_BIND (127.0.0.1), CODEMODE_SQLITE (default .local/codemode-chat.sqlite), CODEMODE_CHAT_LLM=1,
//      CODEMODE_REMOTE (judge shard on nano: tcp:host:port or unix:/path), CODEMODE_HOST_NAME (name in the system bar),
//      CODEMODE_ADMIN_TOKEN (switches the model agents via POST /api/llm with the header x-admin-token; unset: switching is off),
//      CODEMODE_REQ_PER_MIN (API requests and WebSocket connects per client IP and minute, default 120),
//      CODEMODE_TTL_HOURS (lifetime of a room's entries in hours, default 24; 0 = until the block is deleted).
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ROOT } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { spaces, startService } from "../../src/index.ts";
import { loadCodemode } from "./judge.ts";
import { execute, MAX_CALL_CHARS, type ExecEvent } from "./runner.ts";
import { CodeChatHub, type LlmApi } from "./hub.ts";
import { adminModels, llmInfo, setLlm } from "./llm.ts";
import { remoteJudgeSpace } from "./shard.ts";
import { upgradeWebSocket } from "./ws.ts";
import { TASKS } from "./tasks.ts";

const ID = /^[a-zA-Z0-9._-]{1,48}$/;
const CANDIDATE = /^[a-z0-9-]{1,40}$/;

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

/** Constant-time check of a presented admin token; without a configured token nobody is admin. */
function tokenOk(got: unknown): boolean {
	const want = process.env.CODEMODE_ADMIN_TOKEN;
	if (!want || typeof got !== "string") return false;
	const h = (v: string) => createHash("sha256").update(v).digest();
	return timingSafeEqual(h(want), h(got));
}

const ADMIN_COOKIE = "codemode_admin";
const ADMIN_TTL_MS = 12 * 3600_000;
const cookieOf = (req: http.IncomingMessage, name: string): string | undefined => {
	for (const part of String(req.headers.cookie ?? "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
	return undefined;
};

export async function startServer(o: { port?: number; bind?: string; sqlitePath?: string | null; remote?: string | null; useNext?: boolean; dev?: boolean; llm?: LlmApi } = {}) {
	const cm = await loadCodemode();
	if (!cm) throw new Error("@earendil-works/pi-codemode could not be loaded");
	const registry = createRegistry();
	registry.install(spaces);
	const storage = o.sqlitePath ? await (async () => { await mkdir(dirname(o.sqlitePath!), { recursive: true }); return openNodeSqliteStorage(o.sqlitePath!); })() : new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
	const stopService = await startService(harness, ctx, { watchDebounceMs: 400 });
	const remoteSpec = o.remote === undefined ? process.env.CODEMODE_REMOTE : o.remote;
	const hub = new CodeChatHub(harness, cm, remoteSpec ? { remote: remoteJudgeSpace(remoteSpec), remoteLabel: process.env.CODEMODE_REMOTE_NAME ?? "nano", ...(o.llm ? { llm: o.llm } : {}) } : (o.llm ? { llm: o.llm } : {}));
	if (remoteSpec) console.log(`[codemode] judge shard configured: ${remoteSpec}`);
	await hub.restoreAdmin(); // the admin's choice of models from before

	let nextHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null = null;
	let nextUpgrade: ((req: http.IncomingMessage, socket: any, head: Buffer) => void) | null = null;
	if (o.useNext) {
		const mod = await import("next");
		const app = ((mod as any).default ?? mod)({ dev: Boolean(o.dev), dir: ROOT });
		await app.prepare();
		nextHandler = app.getRequestHandler();
		if (typeof app.getUpgradeHandler === "function") nextUpgrade = app.getUpgradeHandler();
	}

	const allowed = quota(Number(process.env.CODEMODE_REQ_PER_MIN ?? 120));
	const runsByIp = new Map<string, number>(); // ▶ runs in flight per client: one at a time
	// admin sessions after a login with the token (HttpOnly cookie); a POST with the cookie must also carry the header
	// x-codemode-admin (a cross-site form cannot set it), or the token itself as x-admin-token (scripts, tests)
	const adminSessions = new Map<string, number>();
	const loginTries = quota(10);
	const isAdmin = (req: http.IncomingMessage): boolean => {
		if (tokenOk(req.headers["x-admin-token"])) return true;
		const sid = cookieOf(req, ADMIN_COOKIE), until = sid ? adminSessions.get(sid) : undefined;
		if (!sid || !until || until < Date.now()) { if (sid) adminSessions.delete(sid); return false; }
		return req.method === "GET" || req.headers["x-codemode-admin"] === "1";
	};
	const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
	const readBody = (req: http.IncomingMessage) => new Promise<Record<string, any>>((ok, fail) => {
		let n = 0; const parts: Buffer[] = [];
		req.on("data", (c: Buffer) => { n += c.length; if (n > 64_000) { fail(new Error("Body too large")); req.destroy(); } else parts.push(c); });
		req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { fail(new Error("Invalid JSON")); } });
		req.on("error", fail);
	});

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			const p = url.pathname;
			if (p === "/healthz") return json(res, 200, { ok: true });
			if (p === "/api/tasks" && req.method === "GET") return json(res, 200, TASKS.map(({ id, title, fn, prompt }) => ({ id, title, fn, prompt })));
			if (p.startsWith("/api/") && !allowed(clientIp(req))) return json(res, 429, { error: "Too many requests; retry in a minute" });
			if (p === "/api/system") return json(res, 200, await hub.systemInfo()); // a shard call each time: under the quota
			if (p === "/api/llm") {
				if (req.method !== "POST") return json(res, 200, await llmInfo());
				// switching the model agents is an operator action, not a visitor's
				if (!isAdmin(req)) return json(res, 403, { error: "Admin token required" });
				return json(res, 200, await setLlm(await readBody(req)));
			}
			// ---- admin panel: login with the token, then the choice of models ----
			if (p === "/api/admin/session" && req.method === "GET") return json(res, 200, { admin: isAdmin(req), available: !!process.env.CODEMODE_ADMIN_TOKEN });
			if (p === "/api/admin/login" && req.method === "POST") {
				if (!loginTries(clientIp(req))) return json(res, 429, { error: "Too many login attempts; retry in a minute" });
				if (!tokenOk((await readBody(req)).token)) return json(res, 403, { error: "Wrong admin token" });
				const sid = randomBytes(24).toString("hex");
				adminSessions.set(sid, Date.now() + ADMIN_TTL_MS);
				const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": `${ADMIN_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TTL_MS / 1000}${secure}` });
				return res.end(JSON.stringify({ admin: true }));
			}
			if (p === "/api/admin/logout" && req.method === "POST") {
				const sid = cookieOf(req, ADMIN_COOKIE);
				if (sid) adminSessions.delete(sid);
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
				return res.end(JSON.stringify({ admin: false }));
			}
			if (p === "/api/admin/models") {
				if (!isAdmin(req)) return json(res, 403, { error: "Admin login required" });
				if (req.method === "POST") {
					const b = await readBody(req);
					if (b.allowed !== null && !Array.isArray(b.allowed)) return json(res, 400, { error: "allowed: a list of model labels, or null for the default" });
					if (Array.isArray(b.allowed)) {
						const known = new Set((await adminModels()).models.map((m) => m.label));
						const unknown = (b.allowed as unknown[]).map(String).filter((l) => !known.has(l));
						if (unknown.length) return json(res, 400, { error: `Unknown models: ${unknown.slice(0, 5).join(", ")}` });
					}
					await hub.saveAllowedModels(b.allowed === null ? null : (b.allowed as unknown[]).map(String));
					if (typeof b.on === "boolean") await setLlm({ on: b.on });
				}
				return json(res, 200, await adminModels());
			}
			const plan = /^\/api\/sessions\/([^/]+)\/plan\/([^/]+)$/.exec(p);
			if (plan && req.method === "GET") {
				if (!ID.test(plan[1]!) || !/^[a-z0-9-]{1,80}$/.test(plan[2]!)) return json(res, 400, { error: "Invalid id" });
				const got = await hub.plan(plan[1]!, plan[2]!);
				return got ? json(res, 200, got) : json(res, 404, { error: "Unknown plan" });
			}
			const src = /^\/api\/sessions\/([^/]+)\/source\/([^/]+)$/.exec(p);
			if (src && req.method === "GET") {
				if (!ID.test(src[1]!) || !CANDIDATE.test(src[2]!)) return json(res, 400, { error: "Invalid id" });
				const details = await hub.details(src[1]!, src[2]!); // code, case results, lineage
				return details === null ? json(res, 404, { error: "Unknown contribution" }) : json(res, 200, details);
			}
			const ex = /^\/api\/sessions\/([^/]+)\/exec$/.exec(p);
			if (ex && req.method === "POST") {
				// ▶ of a contribution: its function against the task's cases plus an optional call, streamed as NDJSON;
				// closing the request (the page's Stop) aborts the sandbox
				const b = await readBody(req);
				const candidateId = String(b.candidateId ?? ""), call = typeof b.call === "string" ? b.call.trim() : "";
				if (!ID.test(ex[1]!) || !CANDIDATE.test(candidateId)) return json(res, 400, { error: "Invalid id" });
				if (call.length > MAX_CALL_CHARS) return json(res, 400, { error: `A call has at most ${MAX_CALL_CHARS} characters` });
				const ip = clientIp(req);
				if ((runsByIp.get(ip) ?? 0) >= 1) return json(res, 429, { error: "One run at a time; stop the other one first" });
				const target = await hub.execTarget(ex[1]!, candidateId);
				// a candidate the shard is judging right now is invisible for those seconds
				if (!target) return json(res, 404, { error: "Unknown contribution, or it is being judged on the shard right now; try again in a moment" });
				runsByIp.set(ip, (runsByIp.get(ip) ?? 0) + 1);
				const stop = new AbortController();
				res.on("close", () => { if (!res.writableFinished) stop.abort(); });
				try {
					let started = false;
					const line = (e: ExecEvent) => {
						if (!started) { started = true; res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" }); }
						if (!res.destroyed) res.write(JSON.stringify(e) + "\n");
					};
					const end = await execute(cm, target.task, target.source, call, line, stop.signal);
					line(end);
					res.end();
				} catch (e) {
					if (!res.headersSent) return json(res, 429, { error: (e as Error).message });
					res.end();
				} finally {
					const n = (runsByIp.get(ip) ?? 1) - 1;
					if (n > 0) runsByIp.set(ip, n); else runsByIp.delete(ip);
				}
				return;
			}
			const m = /^\/api\/sessions\/([^/]+)(?:\/(task|run|stop|code|delete|veto|hint|accept))?$/.exec(p);
			if (m) {
				const id = m[1]!, action = m[2];
				if (!ID.test(id)) return json(res, 400, { error: "Invalid session id" });
				if (!action && req.method === "GET") return json(res, 200, await hub.snapshot(id));
				if (req.method !== "POST") return json(res, 405, { error: "POST expected" });
				const b = await readBody(req);
				if (action === "task") await hub.setTask(id, b.text ? { text: b.text } : b.custom ? { custom: b.custom } : { taskId: b.taskId });
				else if (action === "code") return json(res, 200, { candidateId: await hub.submitCode(id, b.author, b.source) });
				else if (action === "run") await hub.startRun(id, b);
				else if (action === "stop") await hub.stopRun(id, b); // {by, reason}: the reason goes to the agents
				else if (action === "accept") { // a person's thumbs-up on a text answer ({candidateId, by, reason, undo})
					if (!CANDIDATE.test(String(b.candidateId ?? ""))) return json(res, 400, { error: "Invalid id" });
					await hub.accept(id, String(b.candidateId), b);
				}
				else if (action === "delete") await hub.deleteBlock(id, String(b.blockId ?? ""));
				else if (action === "hint") await hub.hint(id, b); // a person's guidance for the agents ({blockId?, text, by})
				else if (action === "veto") { // a person's "not like this" on a contribution ({candidateId, by, reason, undo})
					if (!CANDIDATE.test(String(b.candidateId ?? ""))) return json(res, 400, { error: "Invalid id" });
					await hub.veto(id, String(b.candidateId), b);
				}
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
		void hub.attach(m[1]!, ws).catch(() => ws.close());
	});
	const port = o.port ?? Number(process.env.PORT ?? 3700), bind = o.bind ?? process.env.CODEMODE_BIND ?? "127.0.0.1";
	await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, bind, () => ok()); });
	const addr = server.address();
	const actual = typeof addr === "object" && addr ? addr.port : port;
	return {
		url: `http://127.0.0.1:${actual}`, port: actual, hub,
		async close() { await hub.close(); await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); for (const s of conns) s.destroy(); }); await stopService(); await harness.close(ctx); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const srv = await startServer({ sqlitePath: process.env.CODEMODE_SQLITE ?? join(ROOT, ".local", "codemode-chat.sqlite"), useNext: true, dev: process.argv.includes("--dev") });
	console.log(`PHI-SPACES / CODEMODE CHAT (Next.js 16) listening on ${srv.url}`);
	const dev = process.argv.includes("--dev");
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
		// dev: exit at once, so `node --watch` can start the replacement before Next's dev lock is still held
		if (dev) process.exit(0);
		setTimeout(() => process.exit(0), 3000).unref();
		void srv.close().finally(() => process.exit(0));
	});
}
