// Node.js HTTP + WebSocket Server for PHI-SPACES / HELP (https://spaces.eibrain.org).
// Serves:
//   - Static React HelpApp & assets (/ and /assets/*)
//   - Canonical bilingual Help corpus (/help/index.json and /help/articles/*)
//   - Interactive Multiplayer Space-Chat REST & WebSocket Gateway (/api/chat/* and /ws/chat/:sessionId)
//   - Stage v1..v6 live runner (/api/chat/stages/:stage/run)
//   - Login-protected AdminSpaces API (/api/admin/*) matching pi-termux-mobile (spaces.html + steuerung.html)

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PUBLIC_DIR = join(ROOT, "dist", "public");

function loadDotEnvIfPresent(): void {
	const envFile = join(ROOT, ".env");
	if (!existsSync(envFile)) return;
	for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		if (process.env[key] === undefined) {
			process.env[key] = val;
		}
	}
}
loadDotEnvIfPresent();
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Meter, spaces, startService, RemoteSpace, socketTransport, type ListenTarget } from "../../src/index.ts";
import { WebAdminController } from "./admin/admin-controller.ts";
import { SpaceChatHub, type StageId } from "./space-chat/stage-runner.ts";
import { SocialSwarmHub, SWARM_ALIAS } from "./social/swarm.ts";
import { chatReplyGenerator, isLlmActive, listLlmModels, setLlmActive, setLlmModel, sharedLlm, swarmPostGenerator, swarmReplyGenerator } from "./llm.ts";
import { upgradeWebSocket } from "./ws.ts";
import { UploadStore } from "./uploads.ts";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".woff2": "font/woff2",
};

// Image upload: raw bytes (<= 2 MB) land next to the SQLite store, not inside the
// space document – posts only carry the /uploads/... URL.
const UPLOAD_MIME: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};
const UPLOAD_MAX = 2 * 1024 * 1024;

export interface HelpServerOptions {
	bind?: string;
	port?: number;
	sqlitePath?: string | null;
	publicDir?: string;
	adminPassword?: string;
	/** Use full Next.js 16 RequestHandler (enabled by default in CLI / production start). */
	useNext?: boolean;
	dev?: boolean;
}

export interface RunningHelpServer {
	url: string;
	port: number;
	admin: WebAdminController;
	chatHub: SpaceChatHub;
	swarm: SocialSwarmHub;
	close(): Promise<void>;
}

function parseCookies(header: string | undefined): Record<string, string> {
	if (!header) return {};
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx > 0) {
			out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
		}
	}
	return out;
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > maxBytes) throw new Error("body too large (max 2 MB)");
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 65_536): Promise<Record<string, any>> {
	const buf = await readRawBody(req, maxBytes);
	if (buf.length === 0) return {};
	return JSON.parse(buf.toString("utf8"));
}

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): void {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...extraHeaders,
	});
	res.end(JSON.stringify(body));
}

export async function startHelpServer(options: HelpServerOptions = {}): Promise<RunningHelpServer> {
	const bind = options.bind ?? process.env.HELP_BIND ?? "127.0.0.1";
	const port = options.port ?? Number(process.env.PORT ?? process.env.HELP_PORT ?? 3500);
	const publicDir = resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
	const requests = new Map<string, { at: number; count: number }>();

	const meter = new Meter();
	const registry = createRegistry();
	registry.install(spaces);

	const storage = options.sqlitePath
		? await (async () => {
				await mkdir(dirname(options.sqlitePath!), { recursive: true });
				return await openNodeSqliteStorage(options.sqlitePath!);
			})()
		: new MemoryStorage();
	// Uploaded images live beside the durable store (prod: /data/uploads on the volume).
	const uploadDir = join(dirname(options.sqlitePath ?? join(ROOT, ".local", "help.sqlite")), "uploads");
	const uploads = new UploadStore(uploadDir);

	const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
	const admin = new WebAdminController({
		host: harness,
		ctx,
		meter,
		adminPassword: options.adminPassword,
	});
	await admin.initialize();
	// Every commit notifies the doc watch; without debouncing that costs a full settle scan per
	// commit (~30/s under swarm load). 400ms collapses the storm – expiry stays lazy-correct.
	const stopService = await startService(harness, ctx, { watchDebounceMs: 400 });
	const llmChat = await chatReplyGenerator();
	const llmSwarm = await swarmReplyGenerator();
	const llmSwarmPost = await swarmPostGenerator();
	const chatHub = new SpaceChatHub(harness, ctx, meter, llmChat ?? undefined);
	await chatHub.initialize();
	await chatHub.ensureSession("lobby");
	const swarm = new SocialSwarmHub(harness, ctx, meter, {
		adminCheck: (password: string) => admin.verifyPassword(password),
	});
	if (llmSwarm) swarm.setReplyGenerator(llmSwarm);
	if (llmSwarmPost) swarm.setPostGenerator(llmSwarmPost);
	// Optional second shard on another host (plan: big + nano). SWARM_REMOTE=tcp:host:port or unix:/path.
	if (process.env.SWARM_REMOTE) {
		const spec = process.env.SWARM_REMOTE;
		const target: ListenTarget = spec.startsWith("tcp:")
			? { host: spec.slice(4).split(":")[0]!, port: Number(spec.slice(4).split(":")[1]) }
			: { path: spec.replace(/^unix:/, "") };
		// requestTimeoutMs: an unanswered call on a cut socket fails fast and the
		// transport reconnects on the next call — without it shard reads hang forever.
		swarm.attachRemoteShard(new RemoteSpace(socketTransport(target, {
			connectTimeoutMs: Number(process.env.SWARM_REMOTE_CONNECT_TIMEOUT ?? 5_000),
			requestTimeoutMs: Number(process.env.SWARM_REMOTE_TIMEOUT ?? 20_000),
		}), {
			space: SWARM_ALIAS,
			// Query traffic must fail fast: the defaults (5 × 35 s round trips) let a dead
			// shard stall a single read for minutes. Swarm-side guards bound the rest.
			callTimeoutMs: Number(process.env.SWARM_REMOTE_CALL_TIMEOUT ?? 8_000),
			attempts: Number(process.env.SWARM_REMOTE_ATTEMPTS ?? 3),
		}), "b-", spec);
		console.log(`[swarm] remote shard configured: ${spec} (space alias ${SWARM_ALIAS})`);
	}
	// The swarm starts AFTER server.listen below: its workers would otherwise pin the
	// event loop at ~100% CPU and starve nextApp.prepare() for minutes on boot.
	let swarmReady: Promise<void> | null = null;
	const llm = await sharedLlm();
	if (llm) console.log(`[llm] live replies enabled via ${llm.label} (PHI_SPACES_LLM=0 disables)`);

	let nextHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
	let nextUpgrade: ((req: IncomingMessage, socket: any, head: Buffer) => void) | null = null;
	if (options.useNext) {
		const nextMod = await import("next");
		const createNext = (nextMod.default ?? nextMod) as any;
		const nextApp = createNext({
			dev: Boolean(options.dev),
			dir: ROOT,
		});
		await nextApp.prepare();
		nextHandler = nextApp.getRequestHandler();
		if (typeof nextApp.getUpgradeHandler === "function") {
			nextUpgrade = nextApp.getUpgradeHandler();
		}
	}

	const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url ?? "/", "https://spaces.eibrain.org");
		const pathname = url.pathname;
		const method = req.method ?? "GET";

		try {
			if (method === "POST" && !pathname.startsWith("/api/admin/")) {
				const now = Date.now(), ip = req.socket.remoteAddress ?? "local";
				for (const [key, value] of requests) if (now - value.at >= 60_000) requests.delete(key);
				const value = requests.get(ip) ?? { at: now, count: 0 };
				if ((requests.size >= 1024 && !requests.has(ip)) || ++value.count > 60) return sendJson(res, 429, { error: "Demo request quota exceeded; retry after one minute" });
				requests.set(ip, value);
			}
			// ---- 1. Space-Chat Public REST API ----
			if (pathname === "/api/chat/sessions" && method === "POST") {
				const body = await readJsonBody(req);
				const sessionId =
					String(body.sessionId ?? "").trim() || `room-${Date.now().toString(36).slice(-5)}`;
				const session = await chatHub.ensureSession(sessionId);
				const snapshot = await session.engine.inspectSnapshot();
				return sendJson(res, 200, {
					sessionId: session.sessionId,
					spaceId: session.spaceId,
					shareUrl: `/?view=space-chat&session=${encodeURIComponent(session.sessionId)}`,
					snapshot,
				});
			}

			const sessionMatch = /^\/api\/chat\/sessions\/([a-zA-Z0-9._-]+)(?:\/([a-z]+))?$/.exec(pathname);
			if (sessionMatch) {
				const sessionId = sessionMatch[1]!;
				const action = sessionMatch[2];
				const session = await chatHub.ensureSession(sessionId);

				if (!action && method === "GET") {
					const snapshot = await session.engine.inspectSnapshot();
					return sendJson(res, 200, {
						sessionId: session.sessionId,
						spaceId: session.spaceId,
						snapshot,
					});
				}
				if (action === "action" && method === "POST") {
					const body = await readJsonBody(req);
					const snapshot = await chatHub.executeAction(sessionId, body);
					return sendJson(res, 200, { ok: true, snapshot });
				}
			}

			const stageMatch = /^\/api\/chat\/stages\/(v[1-6])\/run$/.exec(pathname);
			if (stageMatch && method === "POST") {
				const stage = stageMatch[1] as StageId;
				const report = await chatHub.runStageDemo(stage);
				return sendJson(res, 200, { ok: true, stage, report });
			}

			// ---- 1b. Social Swarm feed REST fallback (/api/feed/*) ----
			if (pathname === "/api/feed/snapshot" && method === "GET") {
				const channel = url.searchParams.get("channel") ?? undefined;
				await swarm.whenReady();
				return sendJson(res, 200, { ...swarm.snapshot(channel), stats: await swarm.stats() });
			}

			// ---- 1b'. Test-system description: hosts (CPU, memory), entry cap and purge state per shard ----
			if (pathname === "/api/system" && method === "GET") {
				await swarm.whenReady();
				return sendJson(res, 200, await swarm.systemInfo());
			}

			// ---- 1c. Live LLM model selection (/api/llm/*) ----
			if (pathname === "/api/llm/models" && method === "GET") {
				return sendJson(res, 200, await listLlmModels());
			}
			if (pathname === "/api/llm/model" && method === "POST") {
				const session = admin.getSession(parseCookies(req.headers.cookie)["phi_spaces_admin_sid"]);
				if (!session) return sendJson(res, 401, { error: "Admin login required" });
				if (req.headers["x-csrf-token"] !== session.csrfToken) return sendJson(res, 403, { error: "Invalid CSRF token" });
				const body = await readJsonBody(req);
				if (typeof body.on === "boolean") setLlmActive(body.on);
				const label = body.model ? await setLlmModel(String(body.model)) : ((await sharedLlm())?.label ?? null);
				return sendJson(res, 200, { ok: true, current: label, on: isLlmActive() });
			}

			// ---- 1d. Image upload for feed posts (POST /api/upload, GET /uploads/*) ----
			if (pathname === "/api/upload" && method === "POST") {
				const mime = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
				const ext = UPLOAD_MIME[mime];
				if (!ext) return sendJson(res, 415, { error: "unsupported image type – use png, jpeg, gif or webp" });
				const buf = await readRawBody(req, UPLOAD_MAX);
				if (buf.length === 0) return sendJson(res, 400, { error: "empty upload" });
				const name = await uploads.put(buf, ext);
				return sendJson(res, 200, { url: `/uploads/${name}`, bytes: buf.length });
			}
			if (pathname.startsWith("/uploads/") && method === "GET") {
				const name = pathname.slice("/uploads/".length);
				if (!/^upl-[a-z0-9-]+\.(png|jpe?g|gif|webp)$/.test(name)) return sendJson(res, 403, { error: "forbidden" });
				if (!await uploads.existsFresh(name)) return sendJson(res, 404, { error: "expired or missing upload" });
				try {
					const content = await readFile(join(uploadDir, name));
					res.writeHead(200, {
						"content-type": MIME[extname(name)] ?? "application/octet-stream",
						"cache-control": "public, max-age=31536000, immutable",
						"x-content-type-options": "nosniff",
					});
					res.end(content);
				} catch {
					sendJson(res, 404, { error: "not found" });
				}
				return;
			}

			// ---- 2. Login-Protected AdminSpaces API (/api/admin/*) ----
			if (pathname.startsWith("/api/admin/")) {
				const cookies = parseCookies(req.headers.cookie);
				const sessionCookie = cookies["phi_spaces_admin_sid"];
				const clientIp = req.socket.remoteAddress ?? "local";

				if (pathname === "/api/admin/login" && method === "POST") {
					const body = await readJsonBody(req);
					const session = admin.login({
						username: body.username,
						password: body.password,
						enrollToken: body.enrollToken,
						ip: clientIp,
					});
					const isSecure = req.headers["x-forwarded-proto"] === "https";
					const cookieFlags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${isSecure ? "; Secure" : ""}`;
					return sendJson(
						res,
						200,
						{ authenticated: true, session },
						{ "set-cookie": `phi_spaces_admin_sid=${session.sessionId}; ${cookieFlags}` },
					);
				}

				if (pathname === "/api/admin/logout" && method === "POST") {
					admin.logout(sessionCookie);
					return sendJson(
						res,
						200,
						{ authenticated: false },
						{ "set-cookie": "phi_spaces_admin_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" },
					);
				}

				const activeSession = admin.getSession(sessionCookie);
				if (pathname === "/api/admin/session" && method === "GET") {
					if (!activeSession) return sendJson(res, 200, { authenticated: false });
					return sendJson(res, 200, { authenticated: true, session: activeSession });
				}

				if (!activeSession) {
					return sendJson(res, 401, { error: "Admin login required" });
				}

				if (method === "POST") {
					const csrfHeader = req.headers["x-csrf-token"];
					if (csrfHeader !== activeSession.csrfToken) {
						return sendJson(res, 403, { error: "Invalid CSRF token" });
					}
				}

				if (pathname === "/api/admin/overview" && method === "GET") {
					return sendJson(res, 200, await admin.overview());
				}

				if (pathname === "/api/admin/objects" && method === "GET") {
					const spaceParam = url.searchParams.get("space") ?? "default";
					const limitParam = Number(url.searchParams.get("limit") ?? 100);
					return sendJson(res, 200, await admin.inspectSpaceObjects(spaceParam, limitParam));
				}

				if (pathname === "/api/admin/command" && method === "POST") {
					const body = await readJsonBody(req);
					const outcome = await admin.executeCommand({
						commandId: body.commandId,
						kind: String(body.kind ?? ""),
						args: body.args ?? {},
						requestedBy: activeSession.username,
					});
					const overview = await admin.overview();
					return sendJson(res, 200, { ...outcome, overview });
				}
			}

			// ---- 3. Next.js 16 App Router & Help Corpus ----
			if (nextHandler && !pathname.startsWith("/help/")) {
				await nextHandler(req, res);
				return;
			}

			if (method !== "GET" && method !== "HEAD") {
				return sendJson(res, 405, { error: "Method not allowed" });
			}

			// Standalone mode serves its own build exclusively; Next mode has its explicit handler above.

			const relPath = pathname === "/" ? "index.html" : pathname.slice(1);
			const targetFile = resolve(publicDir, relPath);
			if (!targetFile.startsWith(publicDir + sep) && targetFile !== join(publicDir, "index.html")) {
				return sendJson(res, 403, { error: "Forbidden path" });
			}
			const ext = extname(targetFile);
			const mime = MIME[ext];
			if (!mime) {
				// SPA fallback to index.html for client-side routes
				const indexHtml = await readFile(join(publicDir, "index.html"), "utf8");
				res.writeHead(200, { "content-type": MIME[".html"] });
				res.end(indexHtml);
				return;
			}
			const content = await readFile(targetFile);
			res.writeHead(200, {
				"content-type": mime,
				"x-content-type-options": "nosniff",
			});
			res.end(content);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const status = message.includes("Ungültige Zugangsdaten") ? 401 : /quota|already running/.test(message) ? 429 : message.includes("expired") ? 410 : 400;
			sendJson(res, status, { error: message });
		}
	};

	const server = http.createServer((req, res) => {
		void handleHttp(req, res);
	});

	let websocketCount = 0;
	const acceptedSockets = new Set<ReturnType<typeof upgradeWebSocket>>();
	const acceptWebSocket: typeof upgradeWebSocket = (req, socket, head) => {
		if (websocketCount >= 256) { socket.destroy(); return null; }
		const ws = upgradeWebSocket(req, socket, head);
		if (ws) { websocketCount++; acceptedSockets.add(ws); ws.onClose(() => { websocketCount--; acceptedSockets.delete(ws); }); }
		return ws;
	};
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "https://spaces.eibrain.org");
		const m = /^\/ws\/chat\/([a-zA-Z0-9._-]+)$/.exec(url.pathname);
		if (m) {
			const ws = acceptWebSocket(req, socket, head);
			if (ws) {
				void chatHub.attachWebSocket(m[1]!, ws).catch(e => { ws.send({ type: "session.error", message: String(e) }); ws.close(); });
			}
			return;
		}
		if (url.pathname === "/ws/feed") {
			const ws = acceptWebSocket(req, socket, head);
			if (ws) {
				void swarm.attachWebSocket(ws).catch(() => ws.close());
			}
			return;
		}
		if (nextUpgrade) {
			nextUpgrade(req, socket, head);
			return;
		}
		socket.destroy();
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, bind, () => resolveListen());
	});

	// HTTP is listening – now spin the swarm up in the background.
	swarmReady = swarm.init();
	void swarmReady.then(() => console.log("[swarm] initialized – feed live")).catch((e) => console.error("[swarm] init failed:", e));

	const addr = server.address();
	const actualPort = typeof addr === "object" && addr ? addr.port : port;
	const hostLabel = bind.includes(":") ? `[${bind}]` : bind;

	return {
		url: `http://${hostLabel}:${actualPort}`,
		port: actualPort,
		admin,
		chatHub,
		swarm,
		async close() {
			for (const ws of acceptedSockets) ws?.close();
			await swarm.close();
			await chatHub.close();
			await admin.close();
			await new Promise<void>((r) => server.close(() => r()));
			await stopService();
			await harness.close(ctx);
		},
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const sqlitePath = process.env.HELP_SQLITE ?? join(ROOT, ".local", "spaces-eibrain.sqlite");
	const isDev = process.argv.includes("--dev");
	const srv = await startHelpServer({ sqlitePath, useNext: true, dev: isDev });
	console.log(`PHI-SPACES / HELP (Next.js 16 + React 19) & Multiplayer Space-Chat Server listening on ${srv.url}`);
	console.log(`Target production domain: https://spaces.eibrain.org`);
}
