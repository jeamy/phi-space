// The space process: owns the one phi-space of the codemode chat (phi-spaces' own SQLite store) and serves it over the phi-spaces socket
// transport. It holds no logic of the chat; every other process (web, judges, agents, models) connects to it and talks
// to the others only through it.
//
//   CODEMODE_LISTEN=unix:/tmp/codemode-space.sock   (default) or tcp:0.0.0.0:3800
//   CODEMODE_SQLITE=…/codemode-space.sqlite          (default: codemode-chat/.local/codemode-space.sqlite)
//   CODEMODE_MEM=1                                  in memory, throwaway (tests)
// A store file of the earlier pi-durable format is refused, not taken over (its import is step U5 of
// docs/umstellung-ohne-pi-durable.md); the default file name changed with the format for that reason.
import { ROOT } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { PhiSpaces, serveSpace, SpaceService, StaticIdentity, startService } from "../../src/index.ts";
import { announce, DEFAULT_SPACE, parseTarget } from "./space.ts";

const MiB = 1024 * 1024;

export async function startSpaceHost(o: { listen?: string; dbPath?: string | null } = {}) {
	// the store of the space (no agent tools: every process reaches the space over the socket)
	const harness = o.dbPath ? await (async () => { await mkdir(dirname(o.dbPath!), { recursive: true }); return openSqliteHost(o.dbPath!); })() : openOwnMemoryHost();
	const stopService = await startService(harness, ctx, { watchDebounceMs: 50 });
	// every client is the same peer: the socket is internal (a unix socket, or TCP bound to an internal address)
	const identity = new StaticIdentity({ "peer-codemode": { principal: { peerId: "peer-codemode" }, roles: ["member"] } });
	const listen = o.listen ?? DEFAULT_SPACE;
	const server = await serveSpace(new SpaceService({ host: harness, ctx, identity }), { listen: parseTarget(listen), connection: () => ({ peerId: "peer-codemode" }) });
	const local = new PhiSpaces(harness, ctx);
	// every process connects as the same peer: the per-owner caps must cover all of them together (judges and agents
	// each hold a transaction and a waiting take). On the disk the claims of a day (24 h are kept) live there, not in
	// memory (docs/umstellung-ohne-pi-durable.md, D5): measured 23 800 per idle hour, about 240 MB a day, so twice that
	await local.setLimits({ maxTxnsPerOwner: 1000, maxWaitersPerOwner: 1000, maxRegsPerOwner: 1000, ...(o.dbPath ? { maxClaimBytes: 512 * MiB, maxDocBytes: 640 * MiB } : {}) });
	const presence = announce(local, "space");
	return {
		listen,
		async close() { await presence.stop(); await server.close(); await stopService(); await harness.close(ctx); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const mem = process.env.CODEMODE_MEM === "1";
	const dbPath = process.env.CODEMODE_SQLITE || join(ROOT, ".local", "codemode-space.sqlite");
	const host = await startSpaceHost({ listen: process.env.CODEMODE_LISTEN || DEFAULT_SPACE, dbPath: mem ? null : dbPath });
	// the starter and the tests wait for this line
	console.log(`[space] ready on ${host.listen} (db ${mem ? "memory" : dbPath})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
