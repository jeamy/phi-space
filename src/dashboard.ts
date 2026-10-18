// Read-only live dashboard over a phi-spaces host (docs/dashboard.md; design: docs/ui-mockups/).
// Phase 1 by decision: no mutation endpoint exists on the dashboard itself; the UI observes spaces, gauges, entries,
// transactions, waiters and the process meter. The optional space socket (`serve`) lets real clients produce the
// traffic the dashboard then shows; their identity comes from the trusted local boundary (file permissions of the
// unix socket), never from bytes a client sends — the same rule as socket.ts. Agents/mobiles have no data source
// in core, so the UI marks those panels as empty instead of inventing data.
//
// Live updates use Server-Sent Events, not a websocket: the stream is one-directional (server to browser), and
// `EventSource` reconnects by itself. On reconnect the browser re-baselines from the snapshot endpoints, so no
// event replay is needed and no update can be lost silently.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Context } from "@earendil-works/chord";
import type { SpaceHost } from "./client.ts";
import { meter as processMeter, type Meter, type MeterSnapshot } from "./meter.ts";
import { NamedSpace, Registry, listSpaces, snapshotSpace, spaceDoc, type RegistryState, type SpaceInfo } from "./spaces.ts";
import { Space } from "./doc.ts";
import { GateIdentity } from "./gate.ts";
import { DEFAULT_POLICY, SpaceService, type Connection } from "./service.ts";
import { serveSpace, type SpaceServer } from "./socket.ts";
import * as core from "./core.ts";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

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

	const resolveSpace = async (name: string): Promise<SpaceInfo | undefined> =>
		(await listSpaces(o.host, ctx)).find((i) => i.spaceId === name || i.alias === name);

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const url = new URL(req.url ?? "/", "http://dashboard.local");
		const path = url.pathname;
		if (req.method !== "GET") return send(res, 405, { error: "read-only: GET only" });
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
			push(res, { type: "hello", spaces: await spaceDigest(o.host, ctx, now), uptimeMs: now() - startedAt, connections: spaceServer?.connections() ?? 0 });
			req.on("close", () => { sse.delete(res); });
			return;
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

// ---- standalone start: `npm run dashboard -- --dir <jsonl-dir>` or `--sqlite <file>` (docs/dashboard.md).

const usage = `phi-spaces dashboard (read-only Phase 1)
  --dir <path>      open a JSONL store directory
  --sqlite <file>   open a SQLite store file (exactly one of --dir/--sqlite is required)
  --port <n>        HTTP port (default 8787)
  --bind <addr>     bind address (default 127.0.0.1; loopback only by design)
  --socket <path>   unix socket for the space service (default: <store>/space.sock)
  --no-socket       do not serve the space service; the dashboard then shows a quiet store`;

async function main(argv: string[]): Promise<void> {
	const a = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i]!;
		if (k === "--help" || k === "-h") return void console.log(usage);
		if (k === "--no-socket") { a.set("no-socket", ""); continue; }
		const v = argv[i + 1];
		if (!v || v.startsWith("--")) throw new Error(`${k} needs a value\n\n${usage}`);
		a.set(k, v);
		i++;
	}
	const dir = a.get("--dir"), sqlite = a.get("--sqlite");
	if ((dir ? 1 : 0) + (sqlite ? 1 : 0) !== 1) throw new Error(`exactly one of --dir/--sqlite is required\n\n${usage}`);
	const ctx = BACKGROUND_CONTEXT;
	const storage = dir ? await openNodeJsonlStorage(dir, ctx) : await openNodeSqliteStorage(sqlite!);
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
	const store = dir ?? sqlite!;
	const dashboard = await startDashboard({
		host: harness, ctx,
		bind: a.get("--bind") ?? "127.0.0.1",
		port: Number.parseInt(a.get("--port") ?? "8787", 10) || 8787,
		serve: a.has("no-socket") ? null : { socket: a.get("--socket") ?? `${store.replace(/\/+$/, "")}/space.sock` },
	});
	console.log(`dashboard: ${dashboard.url} (read-only)`);
	if (dashboard.socketPath) console.log(`space service: unix socket ${dashboard.socketPath} (local admin; point clients at it)`);
	const shutdown = async () => { await dashboard.close(); await harness.close(ctx); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

const invoked = pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
if (invoked) await main(process.argv.slice(2));
