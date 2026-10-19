// Headless judge shard ("nano"): owns its own SpaceHost + SQLite and serves the `codemode-judge` space over the
// phi-spaces socket transport. Judge workers run HERE: candidates the hub (big) writes into this space are taken,
// run in this machine's sandbox and answered with CodeScore entries, so the CPU cost of judging lands on nano.
//
//   CODEMODE_LISTEN=unix:/tmp/codemode-b.sock   (default) or tcp:0.0.0.0:3800
//   CODEMODE_DB=/data/codemode-b.sqlite         (default: codemode-chat/.local/codemode-b.sqlite; CODEMODE_MEM=1 = throwaway)
//   CODEMODE_HOST_NAME=nano                     name shown in the hub's system bar (default: hostname)
//   CODEMODE_JUDGES=2                           parallel judge workers
//
// Hub side (big): CODEMODE_REMOTE=unix:/tmp/codemode-b.sock  or  CODEMODE_REMOTE=tcp:nano:3800
import { ROOT } from "./env.ts";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSpace, FOREVER, NO_WAIT, PhiSpaces, serveSpace, SpaceService, spaces, StaticIdentity, startService, TransactionError } from "../../src/index.ts";
import { judgeInSlot, loadCodemode, sandboxSlot, TIMEOUT_MS, type Codemode } from "./judge.ts";
import { hostFacts, JUDGE_ALIAS, parseTarget } from "./shard.ts";
import { taskFromSpec } from "./tasks.ts";

const DAY = 24 * 3600_000;

export async function startJudgeHost(o: { listen?: string; dbPath?: string | null; judges?: number } = {}) {
	const cm = await loadCodemode();
	if (!cm) throw new Error("@earendil-works/pi-codemode could not be loaded");
	const registry = createRegistry();
	registry.install(spaces);
	const storage = o.dbPath ? await (async () => { await mkdir(dirname(o.dbPath!), { recursive: true }); return openNodeSqliteStorage(o.dbPath!); })() : new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
	const stopService = await startService(harness, ctx, { watchDebounceMs: 400 });
	const info = await harness.commit((tx) => createSpace(tx, JUDGE_ALIAS, Date.now()), ctx);
	const space = (as?: number) => new PhiSpaces(harness, ctx, Date.now, undefined, as, { space: info.spaceId });

	const facts = hostFacts();
	const own = space();
	while (await own.take({ type: "HostInfo" }, NO_WAIT)); // one HostInfo, replaced on every start
	await own.write({ type: "HostInfo", fields: facts as never }, null, FOREVER);

	const identity = new StaticIdentity({ "peer-hub": { principal: { peerId: "peer-hub" }, roles: ["member"] } });
	const server = await serveSpace(new SpaceService({ host: harness, ctx, identity }), { listen: parseTarget(o.listen ?? "unix:/tmp/codemode-b.sock"), connection: () => ({ peerId: "peer-hub" }) });

	let stopping = false;
	const loops: Promise<void>[] = [];
	const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
	/** One judge: the sandbox slot first, then the transaction (its lease only covers the judging). A failing round is
	 *  logged and retried after a pause; the loop ends only on close(), never silently on an error. */
	const worker = async (id: number, cmx: Codemode) => {
		const r = space(300 + id);
		while (!stopping) {
			try {
				const judged = await sandboxSlot(async () => {
					const t = await r.createTransaction(TIMEOUT_MS + 30_000);
					let c;
					try { c = await r.take({ type: "CodeCandidate" }, NO_WAIT, { txn: t.id }); }
					catch (e) { await r.abort(t.id).catch(() => {}); throw e; }
					if (!c) { await r.abort(t.id); return false; }
					const f = c.fields as Record<string, any>;
					const task = taskFromSpec(f);
					const v = task ? await judgeInSlot(cmx, task, String(f.source ?? "")) : { ok: false, ms: TIMEOUT_MS, error: "unknown task" };
					try {
						await r.write({ type: "CodeScore", fields: { session: f.session, blockId: f.blockId, candidateId: f.candidateId, author: f.author, via: f.via, host: facts.name, gen: f.gen, ok: v.ok, ms: v.ms, ...(v.error ? { error: v.error } : {}), source: f.source, ts: f.ts } as never }, t.id, DAY);
						await r.commit(t.id);
					} catch (e) {
						await r.abort(t.id).catch(() => {});
						if (!(e instanceof TransactionError)) throw e;
					}
					return true;
				});
				if (!judged) await pause(250);
			} catch (e) {
				if (stopping) return;
				console.error("[nano] judge round failed", e);
				await pause(1_000);
			}
		}
	};
	for (let i = 0; i < (o.judges ?? 2); i++) loops.push(worker(i, cm).catch((e) => console.error("[nano] worker stopped", e)));

	return {
		spaceId: info.spaceId,
		async close() { stopping = true; await Promise.allSettled(loops); await server.close(); await stopService(); await harness.close(ctx); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const mem = process.env.CODEMODE_MEM === "1";
	const dbPath = process.env.CODEMODE_DB ?? join(ROOT, ".local", "codemode-b.sqlite");
	const listen = process.env.CODEMODE_LISTEN ?? "unix:/tmp/codemode-b.sock";
	const host = await startJudgeHost({ listen, dbPath: mem ? null : dbPath, judges: Number(process.env.CODEMODE_JUDGES ?? 2) });
	console.log(`[nano] judge shard live on ${listen} (space ${host.spaceId}, db ${mem ? "memory" : dbPath})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
