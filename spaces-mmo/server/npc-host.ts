// The npc process (docs/phasen.md Phases 2 and 5, docs/modell-npcs.md): the world's NPCs. An NPC is a character like any
// other: it is online while this process keeps its Session entry, and it acts only by writing intents, which a world
// worker runs like a player's commands (locks, fog and transactions apply to it the same way). Scripts
// (server/npc/scripts.ts) look at the world through reads and decide what to type next; model roles answer with a
// model while awake (server/npc/minds.ts). Each role is claimed with a lease, so several npc processes share the roles
// and never play one twice; a process that dies loses its roles to another when the lease runs out.
//
//   SPACES_MMO_SPACE        the world space (default unix:/tmp/spaces-mmo-world.sock)
//   (the rhythm of the scripts and their timers follow the world clock's rate, not an environment variable)
//   SPACES_MMO_NPCS         the roles this process plays, by npcId with commas (default: all of the world)
//   SPACES_MMO_REGION       this process plays in that region's space (SPACES_MMO_SPACE): every role, but each only while
//                           its NPC stands there (it walks by the whole world's map, also across a ferry)
import "./env.ts";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ClockCache, paceMs, worldNowMs } from "./engine/clockcache.ts";
import { loadWorld, type WorldDef } from "./engine/world.ts";
import { presentAt } from "./engine/worldtime.ts";
import { claimRole } from "./npc/minds.ts";
import { scriptFor, type Npc } from "./npc/scripts.ts";
import { actorToken, asFields, type IntentFields, type SessionFields } from "./model.ts";
import { announce, connectSpace, DEFAULT_SPACE } from "./space.ts";

const SESSION_LEASE_MS = 30_000;
/** How long a role stays with a process that stopped renewing it (SPACES_MMO_NPC_ROLE_LEASE_MS): then another takes over. */
const roleLeaseMs = () => Number(process.env.SPACES_MMO_NPC_ROLE_LEASE_MS ?? 30_000);

export async function startNpcs(o: { space?: string; world?: WorldDef } = {}) {
	const w = o.world ?? (await loadWorld());
	const conn = connectSpace(o.space ?? (process.env.SPACES_MMO_SPACE || DEFAULT_SPACE));
	const space = conn.space;
	const halt = new AbortController();
	const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); halt.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
	const runs: Promise<void>[] = [];
	const starting: Promise<void>[] = [];
	const owner = `npc-proc-${randomBytes(4).toString("hex")}`;
	const clock = new ClockCache(space, w.id);
	/** The role's plan in world hours (docs/weltzeit.md): where the plan says away, the figure leaves (with a word) and its
	 *  script does not run; where it says present, it comes back. Read from the clock every round, so a restart or a role taken
	 *  over starts from what the hour says. False: the role is away now. */
	const atPlan = async (npc: Npc): Promise<boolean> => {
		const plan = npc.def.plan;
		if (!plan || npc.def.wanderer) return true;
		const at = await clock.now();
		if (at === null) return true; // no clock yet: no plan to follow
		const want = presentAt(plan, at);
		if (want && !npc.isOnline()) await npc.setOnline(true);
		else if (!want && npc.isOnline()) { await npc.act("emote geht nach Hause."); await npc.setOnline(false); }
		return want;
	};
	const only = (process.env.SPACES_MMO_NPCS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const regional = !!process.env.SPACES_MMO_REGION;
	for (const def of w.npcs) {
		if (only.length && !only.includes(def.npcId)) continue;
		if (!scriptFor(def.script)) { console.error(`[npc] ${def.npcId}: unknown script ${def.script}`); continue; }
		const charId = `npc-${def.npcId}`;
		// a wanderer is away until its event, a settler until its script finds too few people playing (npc/settlers.ts)
		let lease: string | null = null, online = !def.wanderer && !def.settler;
		let started!: () => void, startingDone = false;
		starting.push(new Promise<void>((resolve) => { started = resolve; }));
		const ready = () => { if (!startingDone) { startingDone = true; started(); } };
		const keep = async () => {
			try {
				// with regions every region's npc process plays every role, and an NPC is online only in the region it stands in
				const here = !regional || (await space.count({ type: "Character", fields: { charId } })) > 0;
				if (!online || !here) { if (lease) { await space.cancel(lease).catch(() => {}); lease = null; } return; }
				if (lease) { try { await space.renew(lease, SESSION_LEASE_MS); return; } catch { lease = null; } }
				lease = (await space.write({ type: "Session", fields: asFields<SessionFields>({ sessionId: `npc-${randomBytes(4).toString("hex")}`, charId, accountId: charId }) }, null, SESSION_LEASE_MS)).id;
			} catch { /* the space is not reachable now: the next beat tries again */ }
		};
		const npc: Npc = {
			def, charId, space, world: w, halt: halt.signal, sleep,
			async setOnline(on) { online = on; await keep(); if (on) await npc.act("arrive"); },
			isOnline: () => online,
			now: () => worldNowMs(space),
			pace: (worldMs, minMs) => paceMs(space, worldMs, minMs),
			async act(line) {
				const intent: IntentFields = { intentId: randomBytes(8).toString("hex"), charId, line, at: Date.now() };
				await space.write({ type: "Intent", fields: asFields(intent) }, null, 30_000);
				// one command at a time: wait until a world worker has taken it, then until its transaction is over (the
				// worker holds the character's token meanwhile; a read of the token waits for it), so the next look of
				// the script sees what the command did
				const giveUp = Date.now() + 5_000;
				for (let i = 0; Date.now() < giveUp && !halt.signal.aborted; i++) {
					if (!(await space.count({ type: "Intent", fields: { charId } }))) { await space.readIfExists(actorToken(charId), 5_000).catch(() => null); return; }
					await sleep(Math.min(250, 50 * 2 ** Math.min(i, 3))); // 50, 100, 200, 250 …: every look is a call to the space
				}
			},
		};
		runs.push((async () => {
			while (!halt.signal.aborted) {
				// a fresh script for every claim: what it has seen starts here, not at the process's start. It is made before
				// the claim: the claim is visible to everyone once committed, but its answer may come back here seconds later
				// under load, and what was said meanwhile belongs to this role already
				const script = scriptFor(def.script)!;
				// the role: claimed under the NPC lock; another process may hold it (then wait and try again)
				const role = await claimRole(space, def.npcId, owner, roleLeaseMs()).catch(() => null);
				if (!role) { ready(); await sleep(roleLeaseMs() / 2); continue; }
				let lost = false;
				await keep();
				ready();
				const beat = setInterval(() => {
					void keep();
					void space.renew(role, roleLeaseMs()).catch(() => { lost = true; });
				}, Math.min(SESSION_LEASE_MS, roleLeaseMs()) / 3);
				beat.unref?.();
				try {
					while (!halt.signal.aborted && !lost) {
						try { if (await atPlan(npc)) await script(npc); else await sleep(paceMs(space, 5_000, 200)); } catch (e) { if (!halt.signal.aborted) { console.error(`[npc] ${def.npcId}:`, (e as Error).message); await sleep(1000); } }
					}
				} finally {
					clearInterval(beat);
					if (lease) { await space.cancel(lease).catch(() => {}); lease = null; }
					await space.cancel(role).catch(() => {});
				}
			}
		})());
	}
	// The launcher and integration tests treat "ready" as usable: every role has either established its initial
	// session or found that another npc process already owns it.
	await Promise.all(starting);
	const proc = announce(conn.space, "npc");
	return { async close() { halt.abort(); await Promise.all(runs); await proc.stop(); conn.close(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const npcs = await startNpcs();
	// the starter and the tests wait for this line
	console.log("[npc] ready");
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await npcs.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
