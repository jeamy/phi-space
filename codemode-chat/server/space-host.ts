// The space process: owns the one phi-space of the codemode chat (SQLite) and serves it over the phi-spaces socket
// transport. It holds no logic of the chat; every other process (web, judges, agents, models) connects to it and talks
// to the others only through it.
//
//   CODEMODE_LISTEN=unix:/tmp/codemode-space.sock   (default) or tcp:0.0.0.0:3800
//   CODEMODE_SQLITE=…/codemode-chat.sqlite          (default: codemode-chat/.local/codemode-chat.sqlite)
//   CODEMODE_MEM=1                                  in memory, throwaway (tests)
import { ROOT } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openMemoryStore, openSqliteStore } from "../../src/store/legacy.ts";
import { PhiSpaces, serveSpace, SpaceService, StaticIdentity, startService } from "../../src/index.ts";
import { announce, DEFAULT_SPACE, parseTarget } from "./space.ts";

export async function startSpaceHost(o: { listen?: string; dbPath?: string | null } = {}) {
	// the store of the space (no agent tools: every process reaches the space over the socket)
	const harness = o.dbPath ? await (async () => { await mkdir(dirname(o.dbPath!), { recursive: true }); return openSqliteStore(o.dbPath!, ctx); })() : await openMemoryStore(ctx);
	const stopService = await startService(harness, ctx, { watchDebounceMs: 50 });
	// every client is the same peer: the socket is internal (a unix socket, or TCP bound to an internal address)
	const identity = new StaticIdentity({ "peer-codemode": { principal: { peerId: "peer-codemode" }, roles: ["member"] } });
	const listen = o.listen ?? DEFAULT_SPACE;
	const server = await serveSpace(new SpaceService({ host: harness, ctx, identity }), { listen: parseTarget(listen), connection: () => ({ peerId: "peer-codemode" }) });
	const local = new PhiSpaces(harness, ctx);
	// every process connects as the same peer: the per-owner caps must cover all of them together (judges and agents
	// each hold a transaction and a waiting take); the size caps stay as they are
	await local.setLimits({ maxTxnsPerOwner: 1000, maxWaitersPerOwner: 1000, maxRegsPerOwner: 1000 });
	const presence = announce(local, "space");
	return {
		listen,
		async close() { await presence.stop(); await server.close(); await stopService(); await harness.close(ctx); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const mem = process.env.CODEMODE_MEM === "1";
	const dbPath = process.env.CODEMODE_SQLITE || join(ROOT, ".local", "codemode-chat.sqlite");
	const host = await startSpaceHost({ listen: process.env.CODEMODE_LISTEN || DEFAULT_SPACE, dbPath: mem ? null : dbPath });
	// the starter and the tests wait for this line
	console.log(`[space] ready on ${host.listen} (db ${mem ? "memory" : dbPath})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
