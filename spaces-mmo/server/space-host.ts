// The space process: owns the two spaces of spaces-mmo, each in its own store (phi-spaces' own SQLite store) and on its
// own socket. The world space is shared by every process; the accounts space (credentials, web sessions) only by the
// web process, which is the only one told its address. No game logic runs here.
//
//   SPACES_MMO_LISTEN=unix:/tmp/spaces-mmo-world.sock             (default) or tcp:0.0.0.0:3900
//   SPACES_MMO_ACCOUNTS_LISTEN=unix:/tmp/spaces-mmo-accounts.sock (default) or tcp:127.0.0.1:3901
//   SPACES_MMO_DATA=…/.local                                      directory of world.sqlite and accounts.sqlite
//   SPACES_MMO_MEM=1                                              in memory, throwaway (tests)
import { ROOT } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FOREVER, PhiSpaces, serveSpace, SpaceService, startService, StaticIdentity } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { NAMES_LOCK } from "./model.ts";
import { DEFAULT_ACCOUNTS, DEFAULT_SPACE, parseTarget } from "./space.ts";

const MiB = 1024 * 1024;

/** One store served on one socket; every client of the socket is the same internal peer. */
async function serveStore(listen: string, dbPath: string | null, peer: string) {
	const harness = dbPath ? await openSqliteHost(dbPath) : openOwnMemoryHost();
	const stopService = await startService(harness, ctx, { watchDebounceMs: 50 });
	const identity = new StaticIdentity({ [peer]: { principal: { peerId: peer }, roles: ["member"] } });
	const server = await serveSpace(new SpaceService({ host: harness, ctx, identity }), { listen: parseTarget(listen), connection: () => ({ peerId: peer }) });
	const local = new PhiSpaces(harness, ctx);
	// every process connects as the same peer: the per-owner caps cover all of them together
	await local.setLimits({ maxTxnsPerOwner: 1000, maxWaitersPerOwner: 1000, maxRegsPerOwner: 1000, ...(dbPath ? { maxClaimBytes: 512 * MiB, maxDocBytes: 640 * MiB } : {}) });
	return { local, async close() { await server.close(); await stopService(); await harness.close(ctx); } };
}

export async function startSpaceHost(o: { listen?: string; accountsListen?: string; dataDir?: string | null } = {}) {
	if (o.dataDir) await mkdir(o.dataDir, { recursive: true });
	const listen = o.listen ?? DEFAULT_SPACE, accountsListen = o.accountsListen ?? DEFAULT_ACCOUNTS;
	const world = await serveStore(listen, o.dataDir ? join(o.dataDir, "world.sqlite") : null, "peer-mmo-world");
	const accounts = await serveStore(accountsListen, o.dataDir ? join(o.dataDir, "accounts.sqlite") : null, "peer-mmo-web");
	// the lock every registration takes while it claims a name; written once, when the store is new
	if (!(await accounts.local.count({ type: NAMES_LOCK.type }))) await accounts.local.write({ type: NAMES_LOCK.type, fields: { ...NAMES_LOCK.fields } }, null, FOREVER);
	return { listen, accountsListen, async close() { await world.close(); await accounts.close(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const mem = process.env.SPACES_MMO_MEM === "1";
	const dataDir = mem ? null : process.env.SPACES_MMO_DATA || join(ROOT, ".local");
	const host = await startSpaceHost({ listen: process.env.SPACES_MMO_LISTEN || DEFAULT_SPACE, accountsListen: process.env.SPACES_MMO_ACCOUNTS_LISTEN || DEFAULT_ACCOUNTS, dataDir });
	// the starter and the tests wait for this line
	console.log(`[space] ready: world on ${host.listen}, accounts on ${host.accountsListen} (${dataDir ?? "memory"})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
