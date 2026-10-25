// The npc process (docs/phasen.md Phase 2): characters played by scripts, not by people and not by models. An NPC is a
// character like any other: it is online while this process keeps its Session entry, and it acts only by writing
// intents, which a world worker runs like a player's commands (locks, fog and transactions apply to it the same way).
// Scripts (server/npc/scripts.ts) look at the world through reads and decide what to type next.
//
//   SPACES_MMO_SPACE        the world space (default unix:/tmp/spaces-mmo-world.sock)
//   SPACES_MMO_TIME_SCALE   factor on game durations (the scripts' pauses scale with it)
import "./env.ts";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadWorld, type WorldDef } from "./engine/world.ts";
import { scriptFor, type Npc } from "./npc/scripts.ts";
import { asFields, type IntentFields, type SessionFields } from "./model.ts";
import { connectSpace, DEFAULT_SPACE } from "./space.ts";

const SESSION_LEASE_MS = 30_000;

export async function startNpcs(o: { space?: string; world?: WorldDef } = {}) {
	const w = o.world ?? (await loadWorld());
	const conn = connectSpace(o.space ?? (process.env.SPACES_MMO_SPACE || DEFAULT_SPACE));
	const space = conn.space;
	const halt = new AbortController();
	const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); halt.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
	const runs: Promise<void>[] = [];
	for (const def of w.npcs) {
		const script = scriptFor(def.script);
		if (!script) { console.error(`[npc] ${def.npcId}: unknown script ${def.script}`); continue; }
		const charId = `npc-${def.npcId}`;
		let lease: string | null = null;
		const keep = async () => {
			try {
				if (lease) { try { await space.renew(lease, SESSION_LEASE_MS); return; } catch { lease = null; } }
				lease = (await space.write({ type: "Session", fields: asFields<SessionFields>({ sessionId: `npc-${randomBytes(4).toString("hex")}`, charId, accountId: charId }) }, null, SESSION_LEASE_MS)).id;
			} catch { /* the space is not reachable now: the next beat tries again */ }
		};
		const npc: Npc = {
			def, charId, space, world: w, halt: halt.signal, sleep,
			async act(line) {
				const intent: IntentFields = { intentId: randomBytes(8).toString("hex"), charId, line, at: Date.now() };
				await space.write({ type: "Intent", fields: asFields(intent) }, null, 30_000);
				// one command at a time: wait until a world worker has taken it
				for (let i = 0; i < 100 && !halt.signal.aborted; i++) {
					if (!(await space.count({ type: "Intent", fields: { charId } }))) return;
					await sleep(50);
				}
			},
		};
		runs.push((async () => {
			await keep();
			const beat = setInterval(() => void keep(), SESSION_LEASE_MS / 3);
			beat.unref?.();
			try {
				while (!halt.signal.aborted) {
					try { await script(npc); } catch (e) { if (!halt.signal.aborted) { console.error(`[npc] ${def.npcId}:`, (e as Error).message); await sleep(1000); } }
				}
			} finally {
				clearInterval(beat);
				if (lease) await space.cancel(lease).catch(() => {});
			}
		})());
	}
	return { async close() { halt.abort(); await Promise.all(runs); conn.close(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const npcs = await startNpcs();
	// the starter and the tests wait for this line
	console.log("[npc] ready");
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await npcs.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
