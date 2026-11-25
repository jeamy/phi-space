// The space process: owns the one phi-space of codemode-forum (phi-spaces' own SQLite store) and serves it over the
// phi-spaces socket transport. It holds no logic of the forum; every other process (web, agents, model) connects to it
// and talks to the others only through it. Taken over from codemode-chat/server/space-host.ts.
//
//   FORUM_LISTEN=unix:/tmp/codemode-forum-space.sock   (default) or tcp:0.0.0.0:4180
//   FORUM_SQLITE=…/forum-space.sqlite                  (default: codemode-forum/.local/forum-space.sqlite)
//   FORUM_MEM=1                                        in memory, throwaway (tests)
import { ROOT } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { PhiSpaces, serveSpace, SpaceService, StaticIdentity, startService } from "phi-spaces";
import { announce, DEFAULT_SPACE, parseTarget } from "./space.ts";

const MiB = 1024 * 1024;

export function persistentSpaceLimits(env: Readonly<Record<string, string | undefined>> = process.env) {
	const bytes = (name: string, fallback: number) => {
		const raw = env[name]?.trim(), value = raw ? Number(raw) : fallback;
		if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value * MiB)) {
			throw new Error(`${name} must be a positive safe integer in MiB`);
		}
		return value * MiB;
	};
	const maxClaimBytes = bytes("FORUM_MAX_CLAIM_MIB", 1024);
	const maxDocBytes = bytes("FORUM_MAX_DOC_MIB", 1280);
	if (maxDocBytes <= maxClaimBytes) throw new Error("FORUM_MAX_DOC_MIB must exceed FORUM_MAX_CLAIM_MIB");
	return { maxClaimBytes, maxDocBytes };
}

export async function startSpaceHost(o: { listen?: string; dbPath?: string | null } = {}) {
	const capacity = o.dbPath ? persistentSpaceLimits() : {};
	// the store of the space (no agent tools: every process reaches the space over the socket)
	const harness = o.dbPath ? await (async () => { await mkdir(dirname(o.dbPath!), { recursive: true }); return openSqliteHost(o.dbPath!); })() : openOwnMemoryHost();
	const stopService = await startService(harness, ctx, { watchDebounceMs: 50 });
	// every client is the same peer: the socket is internal (a unix socket, or TCP bound to an internal address)
	const identity = new StaticIdentity({ "peer-forum": { principal: { peerId: "peer-forum" }, roles: ["member"] } });
	const listen = o.listen ?? DEFAULT_SPACE;
	// the per-peer limits (default 1024 calls/s, 128 waiting calls) are meant for one remote peer; here they cover every role
	// at once, and a refused call can be the abort that frees an item's transaction (it then holds the run for its lease)
	const local = new PhiSpaces(harness, ctx);
	// every process connects as the same peer: the per-owner caps must cover all of them together (agents and model
	// processes each hold a transaction). Retained claims live on disk; these capacities are not model quotas.
	await local.setLimits({ maxTxnsPerOwner: 1000, maxWaitersPerOwner: 1000, maxRegsPerOwner: 1000, ...capacity });
	// Apply persistent capacities before accepting requests against an already populated store.
	const server = await serveSpace(new SpaceService({ host: harness, ctx, identity, maxCallsPerWindow: 50_000, maxPendingPerPrincipal: 4096, maxPendingPerPeer: 4096 }), { listen: parseTarget(listen), connection: () => ({ peerId: "peer-forum" }) });
	const presence = announce(local, "space");
	return {
		listen,
		async close() { await presence.stop(); await server.close(); await stopService(); await harness.close(ctx); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const mem = process.env.FORUM_MEM === "1";
	const dbPath = process.env.FORUM_SQLITE || join(ROOT, ".local", "forum-space.sqlite");
	const host = await startSpaceHost({ listen: process.env.FORUM_LISTEN || DEFAULT_SPACE, dbPath: mem ? null : dbPath });
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	// the starter and the tests wait for this line; it comes after the handlers, since whoever reads it may signal at once
	console.log(`[space] ready on ${host.listen} (db ${mem ? "memory" : dbPath})`);
}
