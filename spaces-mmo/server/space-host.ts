// The space process: owns the two spaces of spaces-mmo, each in its own store (phi-spaces' own SQLite store) and on its
// own socket. The world space is shared by every process; the accounts space (credentials, web sessions) only by the
// web process, which is the only one told its address. No game logic runs here.
//
//   SPACES_MMO_LISTEN=unix:/tmp/spaces-mmo-world.sock             (default) or tcp:0.0.0.0:3900
//   SPACES_MMO_ACCOUNTS_LISTEN=unix:/tmp/spaces-mmo-accounts.sock (default) or tcp:127.0.0.1:3901
//   SPACES_MMO_DATA=…/.local                                      directory of world.sqlite and accounts.sqlite
//   SPACES_MMO_MEM=1                                              in memory, throwaway (tests)
//   SPACES_MMO_COMPACT_MS=600000                                  how often the store file gives its free pages back
//                                                                 (expired claims, removed entries; 0: never; also once
//                                                                 at the start, before serving)
//   SPACES_MMO_SPACES=world,accounts                              which of the two this process serves (default both):
//                                                                 on two hosts, one each (docs/betrieb.md)
//   SPACES_MMO_REGION=west                                        the world space is this region's (world-west.sqlite):
//                                                                 one space process per region, each on a core of its own
import { ROOT } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FOREVER, PhiSpaces, serveSpace, SpaceService, startService, StaticIdentity } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost } from "phi-spaces/store/host";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { NAMES_LOCK, NPC_LOCK, WORLD_LOCK } from "./model.ts";
import { announce, DEFAULT_ACCOUNTS, DEFAULT_SPACE, parseTarget } from "./space.ts";

const MiB = 1024 * 1024;

/** One store served on one socket; every client of the socket is the same internal peer. */
async function serveStore(listen: string, dbPath: string | null, peer: string) {
	const harness = dbPath ? await openSqliteHost(dbPath) : openOwnMemoryHost();
	// the file only grows without this (the claims of ten minutes of calls come and go): once now, before anyone waits
	// (the first time it rewrites the file), then at a regular interval, between two of the writer's batches
	const compactMs = Number(process.env.SPACES_MMO_COMPACT_MS ?? 10 * 60_000);
	const compact = async (when: string) => {
		const r = await harness.compact().catch((e: Error) => ({ freedPages: 0, converted: false, error: e.message }));
		if (r?.error) console.error(`[space] compaction (${when}) of ${dbPath}: ${r.error}`);
		else if (r && (r.freedPages || r.converted)) console.log(`[space] compaction (${when}) of ${dbPath}: ${r.freedPages} free pages back${r.converted ? ", switched to incremental auto-vacuum" : ""}`);
	};
	if (dbPath && compactMs > 0) await compact("start");
	const compacting = dbPath && compactMs > 0 ? setInterval(() => void compact("interval"), compactMs) : null;
	compacting?.unref();
	const stopService = await startService(harness, ctx, { watchDebounceMs: 50 });
	const identity = new StaticIdentity({ [peer]: { principal: { peerId: peer }, roles: ["member"] } });
	// every process of the game is this one peer: the service's limits per peer (calls per second, blocking calls at once)
	// cover all of them together, so they are sized for the whole game, not for one client
	// waiting calls end at the commit that serves them, and a commit that appends to the change history does not walk it:
	// both off in phi-spaces by default, tested here (docs/betrieb.md, "Last und Latenz")
	harness.skipUnchangedRecords = true;
	const server = await serveSpace(new SpaceService({ host: harness, ctx, identity, maxCallsPerWindow: 50_000, maxPendingPerPrincipal: 4096, maxPendingPerPeer: 4096, wakeOnCommit: true }), { listen: parseTarget(listen), connection: () => ({ peerId: peer }), maxInflightPerConnection: 1024 });
	const local = new PhiSpaces(harness, ctx);
	// every process connects as the same peer: the per-owner caps cover all of them together
	// Every call of every process leaves a request claim whose result is kept for `claimResultMs`; the processes poll several
	// times a second, so at the default of 24 hours the claims alone fill maxClaimBytes within a day (the space then refuses
	// new requests: "the generation exceeds maxClaimBytes"). A repeat of a call comes within its retry window (a call times
	// out after 30 s, three attempts), so ten minutes keep exactly-once where it matters.
	const claimResultMs = Number(process.env.SPACES_MMO_CLAIM_RESULT_MS) > 0 ? Number(process.env.SPACES_MMO_CLAIM_RESULT_MS) : 10 * 60_000;
	// The space keeps a claim's hash until its generation stops admitting new request ids (default 1 hour): with results kept
	// only ten minutes, thousands of claims would sit expired but kept, and every commit's sweep would read them again.
	// The change history (what the web process follows) is kept up to maxLogBytes. The space copies and walks that history
	// with every commit, so its size is paid on every call: 4 MiB (the default) are some thousand batches and halved the
	// steps a space could take. 512 KiB hold several seconds at full load; a web process that falls further behind reads
	// the world again.
	const logBytes = Number(process.env.SPACES_MMO_LOG_BYTES) > 0 ? Number(process.env.SPACES_MMO_LOG_BYTES) : 512 * 1024;
	await local.setLimits({ maxTxnsPerOwner: 1000, maxWaitersPerOwner: 1000, maxRegsPerOwner: 1000, claimResultMs, generationAdmitMs: claimResultMs, maxLogBytes: logBytes, ...(dbPath ? { maxClaimBytes: 512 * MiB, maxDocBytes: 640 * MiB } : {}) });
	return { local, async close() { if (compacting) clearInterval(compacting); await server.close(); await stopService(); await harness.close(ctx); } };
}

export async function startSpaceHost(o: { listen?: string; accountsListen?: string; dataDir?: string | null; spaces?: readonly ("world" | "accounts")[]; region?: string } = {}) {
	if (o.dataDir) await mkdir(o.dataDir, { recursive: true });
	const listen = o.listen ?? DEFAULT_SPACE, accountsListen = o.accountsListen ?? DEFAULT_ACCOUNTS;
	const serves = o.spaces ?? ["world", "accounts"];
	const world = serves.includes("world") ? await serveStore(listen, o.dataDir ? join(o.dataDir, o.region ? `world-${o.region}.sqlite` : "world.sqlite") : null, "peer-mmo-world") : null;
	const accounts = serves.includes("accounts") ? await serveStore(accountsListen, o.dataDir ? join(o.dataDir, "accounts.sqlite") : null, "peer-mmo-web") : null;
	// the lock every registration takes while it claims a name; written once, when the store is new
	if (accounts && !(await accounts.local.count({ type: NAMES_LOCK.type }))) await accounts.local.write({ type: NAMES_LOCK.type, fields: { ...NAMES_LOCK.fields } }, null, FOREVER);
	// and the lock a world worker takes while it loads the world definition
	if (world && !(await world.local.count(WORLD_LOCK))) await world.local.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER);
	if (world && !(await world.local.count(NPC_LOCK))) await world.local.write({ type: NPC_LOCK.type, fields: { ...NPC_LOCK.fields } }, null, FOREVER);
	// the system bar lists the processes of the world's spaces and of the accounts space: one that serves only the
	// accounts (nano) announces itself there
	const proc = world ? announce(world.local, "space") : accounts ? announce(accounts.local, "space") : null;
	return { listen: world ? listen : null, accountsListen: accounts ? accountsListen : null, async close() { await proc?.stop(); await world?.close(); await accounts?.close(); } };
}

/** SPACES_MMO_SPACES: the spaces this process serves (world, accounts; default both). */
export function servedSpaces(v = process.env.SPACES_MMO_SPACES): ("world" | "accounts")[] {
	const list = (v || "world,accounts").split(",").map((x) => x.trim()).filter(Boolean);
	if (!list.length || list.some((x) => x !== "world" && x !== "accounts")) throw new Error(`SPACES_MMO_SPACES is world, accounts or both, not ${v}`);
	return list as ("world" | "accounts")[];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const mem = process.env.SPACES_MMO_MEM === "1";
	const dataDir = mem ? null : process.env.SPACES_MMO_DATA || join(ROOT, ".local");
	const region = process.env.SPACES_MMO_REGION || undefined;
	const host = await startSpaceHost({ listen: process.env.SPACES_MMO_LISTEN || DEFAULT_SPACE, accountsListen: process.env.SPACES_MMO_ACCOUNTS_LISTEN || DEFAULT_ACCOUNTS, dataDir, spaces: servedSpaces(), ...(region ? { region } : {}) });
	// the starter and the tests wait for this line
	console.log(`[space] ready: world on ${host.listen ?? "-"}, accounts on ${host.accountsListen ?? "-"} (${dataDir ?? "memory"})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
