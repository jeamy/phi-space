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
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "./context.ts";
import { openSqliteHost } from "./store/sqlite.ts";
import type { Context } from "./context.ts";
import type { SpaceHost } from "./client.ts";
import { meter as processMeter, type Meter, type MeterSnapshot } from "./meter.ts";
import { NamedSpace, Registry, UnknownSpaceError, listSpaces, snapshotSpace, spaceDoc, type RegistryState, type SpaceInfo } from "./spaces.ts";
import { Space } from "./doc.ts";
import { GateIdentity } from "./gate.ts";
import { DEFAULT_POLICY, SpaceService, type Connection } from "./service.ts";
import { serveSpace, type SpaceServer } from "./socket.ts";
import { connectSpace } from "./space-client.ts";
import { RemoteSpace } from "./remote.ts";
import * as core from "./core.ts";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** A space served by another process. `addresses` (`unix:/path` or `tcp:host:port`, parseTarget) are tried in order
 *  until one answers; the one that answered is tried first next time. `space` names a space of that service by id or
 *  alias (omitted: its default space); `*` takes every space the service lists (`spaces`), each with its stats. */
export type AppSource = { id: string; label: string; addresses: string[]; space?: string };

/** The default addresses of the projects' space processes: the unix socket of a plain start (`npm start`, `dev`), the
 *  port `docker:local:up` publishes on loopback, then the loopback end of the tunnel to nano on big (docs/dashboard.md). The spaces-mmo accounts space (credentials, sessions) is left out on
 *  purpose. The help system's hub serves only figures (stats and its list of spaces, HELP_SPACE_LISTEN), no entries. */
export const ALL_SPACES = "*";

export const DEFAULT_APPS: AppSource[] = [
	{ id: "codemode-chat", label: "Codemode Chat", addresses: ["unix:/tmp/codemode-space.sock", "tcp:127.0.0.1:3810", "tcp:127.0.0.1:3800"] },
	{ id: "spaces-mmo", label: "spaces-mmo · Welt", addresses: ["unix:/tmp/spaces-mmo-world.sock", "tcp:127.0.0.1:3960", "tcp:127.0.0.1:3950"] },
	// the shard keeps its posts in the named space "social-swarm" (help-site SWARM_ALIAS), its default space stays empty
	{ id: "help-swarm", label: "Help · Swarm-Shard", addresses: ["unix:/tmp/swarm-b.sock", "tcp:127.0.0.1:3600"], space: "social-swarm" },
	{ id: "help-hub", label: "Help · Hub", addresses: ["unix:/tmp/help-space.sock", "tcp:127.0.0.1:3520"], space: ALL_SPACES },
];

/** `id[@space]=address[|address…]` entries, comma separated (DASHBOARD_APPS, `--app`); a default id keeps its label,
 *  and its space unless one is given. */
export function parseApps(spec: string): AppSource[] {
	return spec.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
		const m = /^([^=@\s]+)(?:@([^=\s]+))?=(.+)$/.exec(part);
		if (!m) throw new Error(`an app is id[@space]=address[|address…], not ${part}`);
		const addresses = m[3]!.split("|").map((a) => a.trim()).filter(Boolean);
		if (!addresses.length) throw new Error(`app ${m[1]} has no address`);
		const known = DEFAULT_APPS.find((d) => d.id === m[1]);
		const space = m[2] ?? known?.space;
		return { id: m[1]!, label: known?.label ?? m[1]!, addresses, ...(space ? { space } : {}) };
	});
}

const APP_HISTORY = 90;
/** An app source of every space its service lists; polled every APP_ALL_EVERY-th round (one stats call per space). */
const APP_ALL_EVERY = 5;
/** At most this many spaces of one app are read per poll, the newest first. */
const APP_MAX_SPACES = 100;
/** Aliases `prefix-<id>` with at least this many of one prefix fold into one row (a chat's sessions). */
const APP_GROUP_MIN = 3;
/** How far the dashboard pages into an app's entries (by position, oldest first). */
const APP_PAGE_CEILING = 2000;

type AppState = AppSource & {
	/** The address in use (or tried last). */
	address: string;
	online: boolean;
	error: string | null;
	alias: string | null;
	spaceId: string | null;
	/** Summed over its spaces for an app of every space. */
	stats: core.SpaceStats | null;
	/** An app of every space: each space (or folded group) with its stats, most entries first. */
	spaces?: AppSpace[];
	/** Visible entries per poll, oldest first (sparkline). */
	history: number[];
	/** Commits per minute between two polls, oldest first: the space's revision read with its stats. */
	activity: number[];
	/** Change of the visible entries per minute between the last two polls. */
	entriesPerMin: number;
	checkedAt: number;
};

export type AppSpace = { alias: string; spaces: number; stats: core.SpaceStats };

/** The sum of several spaces' stats (counts, types, bytes). */
export function sumStats(all: readonly core.SpaceStats[]): core.SpaceStats {
	const r: core.SpaceStats = { entries: 0, byType: {}, locked: 0, uncommitted: 0, expired: 0, txns: 0, waiters: 0, registrations: 0, outbox: 0, returned: 0, bytes: { entries: 0, outbox: 0, claims: 0, waiters: 0, registrations: 0, txns: 0, total: 0 } };
	for (const st of all) {
		for (const k of ["entries", "locked", "uncommitted", "expired", "txns", "waiters", "registrations", "outbox", "returned"] as const) r[k] += st[k] ?? 0;
		for (const [t, n] of Object.entries(st.byType)) r.byType[t] = (r.byType[t] ?? 0) + n;
		for (const k of Object.keys(r.bytes!) as (keyof NonNullable<core.SpaceStats["bytes"]>)[]) r.bytes![k] += st.bytes?.[k] ?? 0;
	}
	return r;
}

/** Spaces `prefix-<id>` fold into `prefix-*` when APP_GROUP_MIN or more share the prefix; most entries first. */
export function groupSpaces(list: readonly { alias: string; stats: core.SpaceStats }[]): AppSpace[] {
	const prefix = (alias: string) => { const i = alias.lastIndexOf("-"); return i > 0 ? alias.slice(0, i + 1) : null; };
	const counts = new Map<string, number>();
	for (const x of list) { const p = prefix(x.alias); if (p) counts.set(p, (counts.get(p) ?? 0) + 1); }
	const rows = new Map<string, { alias: string; members: core.SpaceStats[] }>();
	for (const x of list) {
		const p = prefix(x.alias);
		const key = p && (counts.get(p) ?? 0) >= APP_GROUP_MIN ? `${p}*` : x.alias;
		const row = rows.get(key) ?? rows.set(key, { alias: key, members: [] }).get(key)!;
		row.members.push(x.stats);
	}
	return [...rows.values()].map((r) => ({ alias: r.alias, spaces: r.members.length, stats: r.members.length === 1 ? r.members[0]! : sumStats(r.members) }))
		.sort((a, b) => b.stats.entries - a.stats.entries || a.alias.localeCompare(b.alias));
}

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
	type AppEntry = AppState & { conn: ReturnType<typeof connectSpace> | null; last: { rev: number; streamId: string; entries: number; at: number } | null;
		/** An app of every space: one RemoteSpace per space on the same connection, and the revision each was read at. */
		views: Map<string, RemoteSpace>; revs: Map<string, { rev: number; streamId: string }>; round: number };
	const apps = new Map<string, AppEntry>();
	for (const a of o.apps ?? []) apps.set(a.id, { ...a, addresses: [...a.addresses], address: a.addresses[0]!, online: false, error: null, alias: null, spaceId: null, stats: null, history: [], activity: [], entriesPerMin: 0, checkedAt: 0, conn: null, last: null, views: new Map(), revs: new Map(), round: 0 });
	const appView = (a: AppState): AppState => ({ id: a.id, label: a.label, addresses: a.addresses, ...(a.space ? { space: a.space } : {}), address: a.address, online: a.online, error: a.error, alias: a.alias, spaceId: a.spaceId, stats: a.stats, ...(a.spaces ? { spaces: a.spaces } : {}), history: a.history, activity: a.activity, entriesPerMin: a.entriesPerMin, checkedAt: a.checkedAt });
	const appList = (): AppState[] => [...apps.values()].map(appView);
	const connectApp = async (a: AppEntry) => {
		if (!a.conn) {
			// the address that answered last first, then the others in their order
			const order = [a.address, ...a.addresses.filter((x) => x !== a.address)];
			const errors: string[] = [];
			for (const address of order) {
				const conn = connectSpace(address, { callTimeoutMs: 5_000, connectTimeoutMs: 1_000, attempts: 1, ...(a.space && a.space !== ALL_SPACES ? { space: a.space } : {}) });
				try {
					const hello = await conn.space.info();
					a.conn = conn;
					a.address = address;
					a.alias = hello.alias;
					a.spaceId = hello.spaceId;
					break;
				} catch (e) {
					conn.close();
					errors.push(`${address}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			if (!a.conn) { a.address = a.addresses[0]!; throw new Error(errors.join("; ")); }
		}
		return a.conn.space;
	};
	const dropApp = (a: AppEntry, e: unknown) => {
		a.conn?.close();
		a.conn = null;
		a.views.clear();
		a.online = false;
		a.error = e instanceof Error ? e.message : String(e);
	};
	/** Every space of the app's service: stats per space, summed; commits are counted per space (its own stream). */
	const statsOfAll = async (a: AppEntry): Promise<{ stats: core.SpaceStats; commits: number | null }> => {
		const service = await connectApp(a);
		const listed = (await service.spaces()).sort((x, y) => y.createdAt - x.createdAt).slice(0, APP_MAX_SPACES);
		const read = await Promise.all(listed.map(async (s) => {
			let view = a.views.get(s.spaceId);
			if (!view) a.views.set(s.spaceId, view = new RemoteSpace(a.conn!.transport, { space: s.spaceId, callTimeoutMs: 5_000, attempts: 1 }));
			try { return { ...s, ...(await view.statsWithRevision()) }; }
			catch (e) { if (e instanceof UnknownSpaceError || /unknown space/i.test(String(e))) return null; throw e; } // deleted meanwhile
		}));
		const live = read.filter((x) => x !== null);
		let commits: number | null = a.revs.size > 0 ? 0 : null;
		const revs = new Map<string, { rev: number; streamId: string }>();
		for (const x of live) {
			const before = a.revs.get(x.spaceId);
			if (commits !== null && before && before.streamId === x.streamId && x.rev >= before.rev) commits += x.rev - before.rev;
			revs.set(x.spaceId, { rev: x.rev, streamId: x.streamId });
		}
		a.revs = revs;
		for (const id of a.views.keys()) if (!revs.has(id)) a.views.delete(id);
		a.spaces = groupSpaces(live.map((x) => ({ alias: x.alias, stats: x.stats })));
		return { stats: sumStats(live.map((x) => x.stats)), commits };
	};
	let polling = false;
	const pollApps = async (): Promise<void> => {
		if (polling || apps.size === 0) return;
		polling = true;
		try {
			const changed: AppState[] = [];
			await Promise.all([...apps.values()].map(async (a) => {
				const all = a.space === ALL_SPACES;
				// an app of every space costs its service a stats call per space: it is read every few rounds only
				if (all && a.round++ % APP_ALL_EVERY !== 0 && a.online) return;
				try {
					let st: core.SpaceStats, rev: number, streamId: string;
					if (all) {
						const r = await statsOfAll(a);
						st = r.stats;
						// the commits since the poll before, counted per space, carried on as one running revision
						rev = (a.last?.rev ?? 0) + (r.commits ?? 0);
						streamId = r.commits === null ? `restart:${now()}` : a.last?.streamId ?? "all";
					} else ({ stats: st, rev, streamId } = await (await connectApp(a)).statsWithRevision());
					const t = now();
					// commits and entry change per minute since the poll before; a new stream (the space restarted) starts over
					const prev = a.last && a.last.streamId === streamId && rev >= a.last.rev ? a.last : null;
					const minutes = prev ? Math.max(t - prev.at, 1) / 60_000 : 0;
					if (prev) {
						a.activity.push(Math.round(((rev - prev.rev) / minutes) * 10) / 10);
						if (a.activity.length > APP_HISTORY) a.activity.shift();
						a.entriesPerMin = Math.round(((st.entries - prev.entries) / minutes) * 10) / 10;
					}
					a.last = { rev, streamId, entries: st.entries, at: t };
					a.stats = st;
					a.online = true;
					a.error = null;
					a.history.push(st.entries);
					if (a.history.length > APP_HISTORY) a.history.shift();
				} catch (e) { dropApp(a, e); a.last = null; a.revs.clear(); a.spaces = undefined; }
				a.checkedAt = now();
				// every poll goes out (the activity curve moves on while a space is quiet); the page refetches entries
				// only when the stats changed
				changed.push(appView(a));
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
			// an app of every space shows its figures only (the help hub's service allows no reads)
			if (a.space === ALL_SPACES) return send(res, 403, { error: "Einträge nicht freigegeben", app: appView(a) });
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
				// a service that allows no reads is still online
				if (/not allowed|PermissionDenied/.test(String(e))) return send(res, 403, { error: "Einträge nicht freigegeben", app: appView(a) });
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
  --app id[@space]=address[|address…]
                    show the space of another process (repeatable; replaces the defaults and DASHBOARD_APPS);
                    the defaults: codemode-chat, spaces-mmo world, help swarm shard, help hub, each on its unix
                    socket, else the loopback port of docker:local, else the tunnel port on big; @space picks a
                    named space of that service (default: its default space; help-swarm: social-swarm), @* every
                    space it lists (stats only; help-hub)
  --no-apps         show no app spaces

Environment (also read from the repository's .env; set values win): DASHBOARD_APPS (as --app, comma separated),
DASHBOARD_PORT, DASHBOARD_BIND, DASHBOARD_DIR, DASHBOARD_SQLITE (defaults of the flags above).`;

/** Reads the repository's .env like the projects' server/env.ts: values already in the environment win. */
function loadDotEnv(file: string): void {
	if (!existsSync(file)) return;
	for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const val = line.slice(eq + 1).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
		if (process.env[key] === undefined) process.env[key] = val;
	}
}

async function main(argv: string[]): Promise<void> {
	loadDotEnv(join(fileURLToPath(import.meta.url), "..", "..", ".env"));
	const env = process.env;
	const a = new Map<string, string>();
	const appArgs: AppSource[] = [];
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i]!;
		if (k === "--help" || k === "-h") return void console.log(usage);
		if (k === "--no-socket" || k === "--no-apps") { a.set(k.slice(2), ""); continue; }
		const v = argv[i + 1];
		if (!v || v.startsWith("--")) throw new Error(`${k} needs a value\n\n${usage}`);
		if (k === "--app") {
			appArgs.push(...parseApps(v));
			i++;
			continue;
		}
		a.set(k, v);
		i++;
	}
	const sqlite = a.get("--sqlite") ?? (a.has("--dir") ? undefined : env.DASHBOARD_SQLITE || undefined);
	const dir = a.get("--dir") ?? (sqlite ? undefined : env.DASHBOARD_DIR || undefined);
	if ((dir ? 1 : 0) + (sqlite ? 1 : 0) !== 1) throw new Error(`exactly one of --dir/--sqlite is required\n\n${usage}`);
	const ctx = BACKGROUND_CONTEXT;
	// the dashboard process owns the store (its owner lock): it also serves the space socket below
	const harness = await openSqliteHost(dir ? join(dir, "store.sqlite") : sqlite!);
	const store = dir ?? dirname(resolve(sqlite!));
	const dashboard = await startDashboard({
		host: harness, ctx,
		bind: a.get("--bind") ?? (env.DASHBOARD_BIND || "127.0.0.1"),
		port: Number.parseInt(a.get("--port") ?? env.DASHBOARD_PORT ?? "8787", 10) || 8787,
		serve: a.has("no-socket") ? null : { socket: a.get("--socket") ?? `${store.replace(/\/+$/, "")}/space.sock` },
		apps: a.has("no-apps") ? [] : appArgs.length > 0 ? appArgs : env.DASHBOARD_APPS ? parseApps(env.DASHBOARD_APPS) : DEFAULT_APPS,
	});
	console.log(`dashboard: ${dashboard.url} (read-only)`);
	if (dashboard.socketPath) console.log(`space service: unix socket ${dashboard.socketPath} (local admin; point clients at it)`);
	const shutdown = async () => { await dashboard.close(); await harness.close(ctx); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

const invoked = pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
if (invoked) await main(process.argv.slice(2));
