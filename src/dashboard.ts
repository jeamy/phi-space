// Read-only live dashboard over a phi-spaces host (docs/dashboard.md; design: docs/ui-mockups/).
// Phase 1 by decision: no mutation endpoint exists on the dashboard itself; the UI observes spaces, gauges, entries,
// transactions, waiters and the process meter. The optional space socket (`serve`) lets real clients produce the
// traffic the dashboard then shows; their identity comes from the trusted local boundary (file permissions of the
// unix socket), never from bytes a client sends — the same rule as socket.ts. Agents/mobiles have no data source
// in core, so the UI marks those panels as empty instead of inventing data.
//
// App sources: the spaces of the projects built on phi-spaces (codemode-chat, spaces-mmo, the help system's swarm shard)
// each run in their own process, which holds its store's owner lock. The dashboard reaches them only as a remote client of
// their socket and only with calls that leave nothing behind (`stats`, `readAll` pages): no read/take, so no request
// claims and no holds. Each poll is one call per app; a missing socket is an "offline" app, not an error.
//
// Live updates use Server-Sent Events, not a websocket: the stream is one-directional (server to browser), and
// `EventSource` reconnects by itself. On reconnect the browser re-baselines from the snapshot endpoints, so no
// event replay is needed and no update can be lost silently.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "./context.ts";
import { openSqliteHost } from "./store/sqlite.ts";
import type { Context } from "./context.ts";
import type { SpaceHost } from "./client.ts";
import { meter as processMeter, type Meter, type MeterSnapshot } from "./meter.ts";
import { NamedSpace, Registry, listSpaces, snapshotSpace, spaceDoc, type RegistryState, type SpaceInfo } from "./spaces.ts";
import { Space } from "./doc.ts";
import { GateIdentity } from "./gate.ts";
import { DEFAULT_POLICY, SpaceService, type Connection } from "./service.ts";
import { serveSpace, type SpaceServer } from "./socket.ts";
import { connectSpace } from "./space-client.ts";
import * as core from "./core.ts";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** A space served by another process: `address` is `unix:/path` or `tcp:host:port` (parseTarget). */
export type AppSource = { id: string; label: string; address: string };

/** The default addresses of the projects' space processes. The spaces-mmo accounts space (credentials, sessions) is left
 *  out on purpose; the help system's own space lives inside its web process without a socket, only its swarm shard has one. */
export const DEFAULT_APPS: AppSource[] = [
	{ id: "codemode-chat", label: "Codemode Chat", address: "unix:/tmp/codemode-space.sock" },
	{ id: "spaces-mmo", label: "spaces-mmo · Welt", address: "unix:/tmp/spaces-mmo-world.sock" },
	{ id: "help-swarm", label: "Help · Swarm-Shard", address: "unix:/tmp/swarm-b.sock" },
];

const APP_HISTORY = 90;
/** How far the dashboard pages into an app's entries (by position, oldest first). */
const APP_PAGE_CEILING = 2000;

type AppState = AppSource & {
	online: boolean;
	error: string | null;
	alias: string | null;
	spaceId: string | null;
	stats: core.SpaceStats | null;
	/** Visible entries per poll, oldest first (sparkline). */
	history: number[];
	checkedAt: number;
};

export type DashboardOptions = {
	host: SpaceHost;
	ctx: Context;
	meter?: Meter;
	/** Bind address; the default only listens on loopback. */
	bind?: string;
	port?: number;
	/** Directory with index.html/app.js; defaults to the `src/dashboard/` shipped next to this file. */
	publicDir?: string;
	/** Serve the space service on this unix socket so local clients can produce live traffic. */
	serve?: { socket: string } | null;
	now?: () => number;
	/** SSE batching: how long wakeups are collected before one push (default 200 ms). */
	flushMs?: number;
	/** Cadence of the metrics push (default 2000 ms). */
	metricsMs?: number;
	/** Spaces of other processes to show (default: none; the standalone start uses DEFAULT_APPS). */
	apps?: AppSource[];
	/** Cadence of the app polls (default 2000 ms). */
	appPollMs?: number;
};

export type Dashboard = {
	url: string;
	socketPath: string | null;
	connections(): number;
	close(): Promise<void>;
};

/** Every registered space with its current gauges. */
async function spaceDigest(host: SpaceHost, ctx: Context, now: () => number): Promise<Array<SpaceInfo & { stats: core.SpaceStats | null }>> {
	const infos = await listSpaces(host, ctx);
	return await Promise.all(infos.map(async (i) => {
		const s = await snapshotSpace(host, i.spaceId, ctx);
		return { ...i, stats: s ? core.stats(s, now()) : null };
	}));
}

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void => {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	res.writeHead(status, { "content-type": type, "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'" });
	res.end(text);
};

/** Read-only HTTP+SSE view of one host. Everything here is a projection of listSpaces/snapshotSpace/core.stats/Meter. */
export async function startDashboard(o: DashboardOptions): Promise<Dashboard> {
	const ctx = o.ctx;
	const now = o.now ?? Date.now;
	const meter = o.meter ?? processMeter;
	const bind = o.bind ?? "127.0.0.1";
	const port = o.port ?? 0;
	const flushMs = o.flushMs ?? 200;
	const metricsMs = o.metricsMs ?? 2000;
	const publicDir = resolve(o.publicDir ?? join(fileURLToPath(import.meta.url), "..", "dashboard"));
	const startedAt = now();

	// Register the default space so a fresh store is not an empty screen; `spaceDoc` (not a bare Registry touch)
	// creates the registry entry and the default space document in one commit.
	await o.host.commit(async (tx) => { await spaceDoc(tx, undefined, now()); }, ctx);

	// ---- live feed: one broadcaster for all SSE clients; watches wake it, one flush collects the woken spaces.
	const sse = new Set<ServerResponse>();
	let registry: RegistryState | undefined = await o.host.snapshot(Registry, ctx);
	const dirty = new Set<string>();
	let registryDirty = true;
	let flushTimer: NodeJS.Timeout | undefined;
	const push = (res: ServerResponse, event: unknown): void => { res.write(`data: ${JSON.stringify(event)}\n\n`); };
	const flush = async (): Promise<void> => {
		flushTimer = undefined;
		const woken = [...dirty];
		dirty.clear();
		if (sse.size === 0) return;
		const events: unknown[] = [];
		if (registryDirty) { registryDirty = false; events.push({ type: "spaces", spaces: await spaceDigest(o.host, ctx, now) }); }
		for (const id of woken) {
			const s = await snapshotSpace(o.host, id, ctx);
			events.push({ type: "space", spaceId: id, stats: s ? core.stats(s, now()) : null });
		}
		for (const res of sse) for (const e of events) push(res, e);
	};
	const schedule = (): void => { flushTimer ??= setTimeout(() => { void flush(); }, flushMs); };

	type Watch = { start(listener: (...args: never[]) => void | Promise<void>): unknown; stop(): unknown };
	const watches = new Map<string, Watch | undefined>();
	const registryWatch = await o.host.watchDoc(Registry, ctx) as Watch | undefined;
	registryWatch?.start(() => { registryDirty = true; void syncWatches(); schedule(); });
	const syncWatches = async (): Promise<void> => {
		registry = await o.host.snapshot(Registry, ctx);
		for (const i of await listSpaces(o.host, ctx)) {
			if (watches.has(i.spaceId)) continue;
			const w = (i.spaceId === registry?.defaultSpaceId
				? await o.host.watchDoc(Space, ctx)
				: await o.host.watchDoc(NamedSpace, i.spaceId, ctx)) as Watch | undefined;
			w?.start(() => { dirty.add(i.spaceId); schedule(); });
			watches.set(i.spaceId, w);
			dirty.add(i.spaceId); // a space that appeared while running gets its state pushed once, even if its wake was missed
		}
	};
	await syncWatches();
	const heartbeat = setInterval(() => { for (const res of sse) res.write(": hb\n\n"); }, 15_000);
	const metricsPush = setInterval(() => { if (sse.size === 0) return; const m: MeterSnapshot = meter.snapshot(10); for (const res of sse) push(res, { type: "metrics", ...m, uptimeMs: now() - startedAt, connections: spaceServer?.connections() ?? 0 }); }, metricsMs);

	// ---- optional space socket: the only way traffic appears; whoever may open the socket file is a local admin.
	let spaceServer: SpaceServer | undefined;
	if (o.serve) {
		const service = new SpaceService({ host: o.host, ctx, identity: new GateIdentity(), policy: DEFAULT_POLICY, now });
		const local: Connection = { peerId: "local", credentials: { roles: ["admin"] } };
		spaceServer = await serveSpace(service, { listen: { path: o.serve.socket }, connection: () => ({ ...local }) });
	}

	// ---- app sources: one connection per app, one `stats` call per poll; a failed call drops the connection
	const apps = new Map<string, AppState & { conn: ReturnType<typeof connectSpace> | null }>();
	for (const a of o.apps ?? []) apps.set(a.id, { ...a, online: false, error: null, alias: null, spaceId: null, stats: null, history: [], checkedAt: 0, conn: null });
	const appView = (a: AppState): AppState => ({ id: a.id, label: a.label, address: a.address, online: a.online, error: a.error, alias: a.alias, spaceId: a.spaceId, stats: a.stats, history: a.history, checkedAt: a.checkedAt });
	const appList = (): AppState[] => [...apps.values()].map(appView);
	const connectApp = async (a: AppState & { conn: ReturnType<typeof connectSpace> | null }) => {
		if (!a.conn) {
			a.conn = connectSpace(a.address, { callTimeoutMs: 5_000, connectTimeoutMs: 1_000, attempts: 1 });
			const hello = await a.conn.space.info();
			a.alias = hello.alias;
			a.spaceId = hello.spaceId;
		}
		return a.conn.space;
	};
	const dropApp = (a: AppState & { conn: ReturnType<typeof connectSpace> | null }, e: unknown) => {
		a.conn?.close();
		a.conn = null;
		a.online = false;
		a.error = e instanceof Error ? e.message : String(e);
	};
	let polling = false;
	const pollApps = async (): Promise<void> => {
		if (polling || apps.size === 0) return;
		polling = true;
		try {
			const changed: AppState[] = [];
			await Promise.all([...apps.values()].map(async (a) => {
				const before = JSON.stringify([a.online, a.error, a.stats]);
				try {
					const st = await (await connectApp(a)).stats();
					a.stats = st;
					a.online = true;
					a.error = null;
					a.history.push(st.entries);
					if (a.history.length > APP_HISTORY) a.history.shift();
				} catch (e) { dropApp(a, e); }
				a.checkedAt = now();
				if (JSON.stringify([a.online, a.error, a.stats]) !== before) changed.push(appView(a));
			}));
			if (changed.length > 0) for (const res of sse) push(res, { type: "apps", apps: changed });
		} finally { polling = false; }
	};
	await pollApps();
	const appTimer = apps.size > 0 ? setInterval(() => { void pollApps(); }, o.appPollMs ?? 2000) : undefined;

	// the shared palettes (a copy of the projects' client/lib/palettes.ts), served as plain JavaScript
	const palettesJs = stripTypeScriptTypes(await readFile(join(publicDir, "palettes.ts"), "utf-8"));

	const resolveSpace = async (name: string): Promise<SpaceInfo | undefined> =>
		(await listSpaces(o.host, ctx)).find((i) => i.spaceId === name || i.alias === name);

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url ?? "/", "http://dashboard.local");
		const path = url.pathname;
		if (req.method !== "GET") return send(res, 405, { error: "read-only: GET only" });
		if (path === "/palettes.js") return send(res, 200, palettesJs, MIME[".js"]);
		// static UI
		if (!path.startsWith("/api/")) {
			const name = path === "/" ? "index.html" : path.slice(1);
			const file = resolve(publicDir, name);
			if (!file.startsWith(publicDir + sep) || !MIME[extname(file)]) return send(res, 403, { error: "refused" });
			try { return send(res, 200, await readFile(file, "utf-8"), MIME[extname(file)]); }
			catch { return send(res, 404, { error: "not found" }); }
		}
		if (path === "/api/spaces") return send(res, 200, { now: now(), spaces: await spaceDigest(o.host, ctx, now) });
		if (path === "/api/metrics") return send(res, 200, { ...meter.snapshot(10), uptimeMs: now() - startedAt, connections: spaceServer?.connections() ?? 0 });
		if (path === "/api/live") {
			res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
			res.write("retry: 3000\n\n");
			sse.add(res);
			push(res, { type: "hello", spaces: await spaceDigest(o.host, ctx, now), apps: appList(), uptimeMs: now() - startedAt, connections: spaceServer?.connections() ?? 0 });
			req.on("close", () => { sse.delete(res); });
			return;
		}
		if (path === "/api/apps") return send(res, 200, { now: now(), apps: appList() });
		const appEntries = /^\/api\/apps\/([^/]+)\/entries$/.exec(path);
		if (appEntries) {
			const a = apps.get(decodeURIComponent(appEntries[1]!));
			if (!a) return send(res, 404, { error: "unknown app" });
			const type = url.searchParams.get("type");
			const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
			const after = Math.min(APP_PAGE_CEILING, Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0));
			try {
				// Oldest first, as the space lists them. One read of the first `after + limit + 1` entries, cut here: the
				// space's own snapshot pages would keep a snapshot in the app's cache (and count against its maxSnapshots)
				// for every page turned in the dashboard. The ceiling keeps that one read small.
				const p = await (await connectApp(a)).readPage(type ? { type } : null, { limit: after + limit + 1 });
				const items = p.items.slice(after, after + limit);
				const more = p.next !== null || p.items.length > after + limit;
				return send(res, 200, { app: appView(a), after, next: more && after + limit <= APP_PAGE_CEILING ? after + limit : null, entries: items.map((e) => ({ id: e.id, type: e.type, types: e.types, fields: e.fields, owner: e.owner })) });
			} catch (e) {
				dropApp(a, e);
				return send(res, 502, { error: a.error, app: appView(a) });
			}
		}
		const detail = /^\/api\/spaces\/([^/]+)$/.exec(path);
		if (detail) {
			const info = await resolveSpace(decodeURIComponent(detail[1]!));
			if (!info) return send(res, 404, { error: "unknown space" });
			const s = await snapshotSpace(o.host, info.spaceId, ctx);
			if (!s) return send(res, 404, { error: "space has no state" });
			const t = now();
			return send(res, 200, {
				info,
				stats: core.stats(s, t),
				txns: Object.values(s.txns).filter((x) => x.expires > t).map((x) => ({ id: x.id, expires: x.expires, owner: x.owner, reserved: x.reserved ?? null })),
				waiters: s.waiters.filter((w) => w.deadline > t || w.deadline === core.FOREVER).map((w) => ({ id: w.id, template: w.template, take: w.take, target: w.target, deadline: w.deadline })),
			});
		}
		const entries = /^\/api\/spaces\/([^/]+)\/entries$/.exec(path);
		if (entries) {
			const info = await resolveSpace(decodeURIComponent(entries[1]!));
			if (!info) return send(res, 404, { error: "unknown space" });
			const s = await snapshotSpace(o.host, info.spaceId, ctx);
			if (!s) return send(res, 404, { error: "space has no state" });
			const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
			const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
			const newest = [...s.entries].reverse(); // the table shows newest first; `after` is a cursor into that order
			return send(res, 200, {
				total: s.entries.length,
				after,
				next: after + limit < newest.length ? after + limit : null,
				entries: newest.slice(after, after + limit).map((e) => ({ id: e.id, type: e.type, types: e.types, fields: e.fields, expires: e.expires, takenBy: e.takenBy, writtenUnder: e.writtenUnder, owner: e.owner })),
			});
		}
		return send(res, 404, { error: "not found" });
	};

	const server = http.createServer((req, res) => { void handle(req, res).catch((e) => send(res, 500, { error: e instanceof Error ? e.message : String(e) })); });
	await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, bind, () => r()); });
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;

	return {
		url: `http://${bind}:${actualPort}`,
		socketPath: o.serve?.socket ?? null,
		connections: () => spaceServer?.connections() ?? 0,
		close: async () => {
			clearInterval(heartbeat);
			clearInterval(metricsPush);
			if (appTimer) clearInterval(appTimer);
			for (const a of apps.values()) a.conn?.close();
			if (flushTimer) clearTimeout(flushTimer);
			for (const w of watches.values()) await w?.stop();
			await registryWatch?.stop();
			for (const res of sse) res.destroy();
			sse.clear();
			await new Promise<void>((r) => server.close(() => r()));
			await spaceServer?.close();
		},
	};
}

// ---- standalone start: `npm run dashboard -- --dir <dir>` or `--sqlite <file>` (docs/dashboard.md).

const usage = `phi-spaces dashboard (read-only Phase 1)
  --dir <path>      open the store in a directory (<path>/store.sqlite, created if absent)
  --sqlite <file>   open a store file (exactly one of --dir/--sqlite is required)
  --port <n>        HTTP port (default 8787)
  --bind <addr>     bind address (default 127.0.0.1; loopback only by design)
  --socket <path>   unix socket for the space service (default: <store>/space.sock)
  --no-socket       do not serve the space service; the dashboard then shows a quiet store
  --app id=address  show the space of another process (repeatable; replaces the defaults: codemode-chat,
                    spaces-mmo world, help swarm shard on their default unix sockets)
  --no-apps         show no app spaces`;

async function main(argv: string[]): Promise<void> {
	const a = new Map<string, string>();
	const appArgs: AppSource[] = [];
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i]!;
		if (k === "--help" || k === "-h") return void console.log(usage);
		if (k === "--no-socket" || k === "--no-apps") { a.set(k.slice(2), ""); continue; }
		const v = argv[i + 1];
		if (!v || v.startsWith("--")) throw new Error(`${k} needs a value\n\n${usage}`);
		if (k === "--app") {
			const m = /^([^=]+)=(.+)$/.exec(v);
			if (!m) throw new Error(`--app is id=address, not ${v}\n\n${usage}`);
			appArgs.push({ id: m[1]!, label: m[1]!, address: m[2]! });
			i++;
			continue;
		}
		a.set(k, v);
		i++;
	}
	const dir = a.get("--dir"), sqlite = a.get("--sqlite");
	if ((dir ? 1 : 0) + (sqlite ? 1 : 0) !== 1) throw new Error(`exactly one of --dir/--sqlite is required\n\n${usage}`);
	const ctx = BACKGROUND_CONTEXT;
	// the dashboard process owns the store (its owner lock): it also serves the space socket below
	const harness = await openSqliteHost(dir ? join(dir, "store.sqlite") : sqlite!);
	const store = dir ?? dirname(resolve(sqlite!));
	const dashboard = await startDashboard({
		host: harness, ctx,
		bind: a.get("--bind") ?? "127.0.0.1",
		port: Number.parseInt(a.get("--port") ?? "8787", 10) || 8787,
		serve: a.has("no-socket") ? null : { socket: a.get("--socket") ?? `${store.replace(/\/+$/, "")}/space.sock` },
		apps: a.has("no-apps") ? [] : appArgs.length > 0 ? appArgs : DEFAULT_APPS,
	});
	console.log(`dashboard: ${dashboard.url} (read-only)`);
	if (dashboard.socketPath) console.log(`space service: unix socket ${dashboard.socketPath} (local admin; point clients at it)`);
	const shutdown = async () => { await dashboard.close(); await harness.close(ctx); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

const invoked = pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
if (invoked) await main(process.argv.slice(2));
