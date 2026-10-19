// Codemode chat: HTTP + WebSocket server around the Next.js 16 app (the API and /ws are served here, pages by Next).
// Run: node --experimental-strip-types codemode-chat/server/index.ts [--dev]
// Env (also read from codemode-chat/.env): PORT (3700), CODEMODE_BIND (127.0.0.1), CODEMODE_SQLITE (default .local/codemode-chat.sqlite), CODEMODE_CHAT_LLM=1,
//      CODEMODE_REMOTE (judge shard on nano: tcp:host:port or unix:/path), CODEMODE_HOST_NAME (name in the system bar).
import http from "node:http";
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
import { CodeChatHub } from "./hub.ts";
import { llmInfo, setLlm } from "./llm.ts";
import { remoteJudgeSpace } from "./shard.ts";
import { upgradeWebSocket } from "./ws.ts";
import { TASKS } from "./tasks.ts";

const ID = /^[a-zA-Z0-9._-]{1,48}$/;

export async function startServer(o: { port?: number; bind?: string; sqlitePath?: string | null; remote?: string | null; useNext?: boolean; dev?: boolean } = {}) {
	const cm = await loadCodemode();
	if (!cm) throw new Error("@earendil-works/pi-codemode could not be loaded");
	const registry = createRegistry();
	registry.install(spaces);
	const storage = o.sqlitePath ? await (async () => { await mkdir(dirname(o.sqlitePath!), { recursive: true }); return openNodeSqliteStorage(o.sqlitePath!); })() : new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
	const stopService = await startService(harness, ctx, { watchDebounceMs: 400 });
	const remoteSpec = o.remote === undefined ? process.env.CODEMODE_REMOTE : o.remote;
	const hub = new CodeChatHub(harness, cm, remoteSpec ? { remote: remoteJudgeSpace(remoteSpec), remoteLabel: process.env.CODEMODE_REMOTE_NAME ?? "nano" } : {});
	if (remoteSpec) console.log(`[codemode] judge shard configured: ${remoteSpec}`);

	let nextHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null = null;
	let nextUpgrade: ((req: http.IncomingMessage, socket: any, head: Buffer) => void) | null = null;
	if (o.useNext) {
		const mod = await import("next");
		const app = ((mod as any).default ?? mod)({ dev: Boolean(o.dev), dir: ROOT });
		await app.prepare();
		nextHandler = app.getRequestHandler();
		if (typeof app.getUpgradeHandler === "function") nextUpgrade = app.getUpgradeHandler();
	}

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
			if (p === "/api/system") return json(res, 200, await hub.systemInfo());
			if (p === "/api/tasks" && req.method === "GET") return json(res, 200, TASKS.map(({ id, title, fn, prompt }) => ({ id, title, fn, prompt })));
			if (p === "/api/llm") return json(res, 200, req.method === "POST" ? await setLlm(await readBody(req)) : await llmInfo());
			const m = /^\/api\/sessions\/([^/]+)(?:\/(message|task|run|stop|code))?$/.exec(p);
			if (m) {
				const id = m[1]!, action = m[2];
				if (!ID.test(id)) return json(res, 400, { error: "Invalid session id" });
				if (!action && req.method === "GET") return json(res, 200, await hub.snapshot(id));
				if (req.method !== "POST") return json(res, 405, { error: "POST expected" });
				const b = await readBody(req);
				if (action === "message") await hub.message(id, b.author, b.text);
				else if (action === "task") await hub.setTask(id, b.custom ? { custom: b.custom } : { taskId: b.taskId });
				else if (action === "code") return json(res, 200, { candidateId: await hub.submitCode(id, b.author, b.source) });
				else if (action === "run") await hub.startRun(id, b);
				else if (action === "stop") await hub.stopRun(id);
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
	let sockets = 0;
	server.on("upgrade", (req, socket, head) => {
		const m = /^\/ws\/([a-zA-Z0-9._-]{1,48})$/.exec(new URL(req.url ?? "/", "http://localhost").pathname);
		if (!m) { if (nextUpgrade) nextUpgrade(req, socket, head); else socket.destroy(); return; }
		if (sockets >= 256) return void socket.destroy();
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
		async close() { await hub.close(); await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }); await stopService(); await harness.close(ctx); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const srv = await startServer({ sqlitePath: process.env.CODEMODE_SQLITE ?? join(ROOT, ".local", "codemode-chat.sqlite"), useNext: true, dev: process.argv.includes("--dev") });
	console.log(`PHI-SPACES / CODEMODE CHAT (Next.js 16) listening on ${srv.url}`);
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void srv.close().finally(() => process.exit(0)));
}
