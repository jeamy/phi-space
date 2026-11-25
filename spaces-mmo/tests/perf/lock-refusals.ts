// How many building commands the room lock refuses (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "Locks":
// with two players and the room's settlers building in the same room, at most 1 % of the building commands are refused
// for the lock; above that the lock is taken with a short wait before it refuses). Two world workers, the npc process
// with the bay's three settlers (no model calls; each given the material of its three buildings, so that it stakes them
// out within the run rather than after gathering for long), and two players beside each other in the bay who stake out a hut beside
// them and give it up again, with a pause of LOCK_PAUSE_MS (random up to that) between their commands, for
// LOCK_SECONDS.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/lock-refusals.ts
//   SPACES_MMO_WORLD_CMD=rust/target/release/mmo-world (SPACES_MMO_WORLD_MIXED=1) for the Rust world workers.
//
// Prints one JSON line: per party (players, settlers) the building commands answered and how many were refused for the
// lock (LOCK_HELD), for the fire's light held by another (the LightUse entry, build.ts lightFor) and for anything else
// (no place, no light left), and the share refused for the lock. A settler's commands are read from what it is told: its
// refusals as messages to it (kept in the space for a while), its successes from what the room is told.
import type { SpaceLike } from "phi-spaces";
import type { ServerFrame } from "../../server/gateway.ts";
import { LOCK_HELD } from "../../server/engine/room-lock.ts";
import { resolvePrototype, spawn } from "../../server/engine/prototypes.ts";
import { loadWorld, walkable } from "../../server/engine/world.ts";
import { eventually, heldCells, lightFire, Player, startServer, startStack } from "../stack.ts";

const SECONDS = Number(process.env.LOCK_SECONDS ?? 180), PAUSE_MS = Number(process.env.LOCK_PAUSE_MS ?? 1_500);
const ROOM = "graue-bucht";
const w = await loadWorld();
const settlers = w.npcs.filter((n) => n.settler && n.room === ROOM);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Msg = Extract<ServerFrame, { t: "msg" }>["m"];
type P = { p: Player; me: string; name: string };

const kinds = { lock: new RegExp(LOCK_HELD.replace(/[.;]/g, "\\$&")), light: /Gerade baut jemand anderes im Licht/ };
const tally = () => ({ commands: 0, lock: 0, light: 0, other: 0, done: 0 });
const others = new Map<string, number>();
const count = (t: ReturnType<typeof tally>, text: string, ok: boolean) => { t.commands++; if (ok) t.done++; else if (kinds.lock.test(text)) t.lock++; else if (kinds.light.test(text)) t.light++; else { t.other++; const k = text.slice(0, 60); others.set(k, (others.get(k) ?? 0) + 1); } };
/** A building command's answer as one's own: one's own line told to the room, or an error told to oneself. */
const STAKED = (name: string) => new RegExp(`^${name} (steckt eine Baustelle ab|gibt die Baustelle)`);
/** What a settler is refused when it builds or digs (settlers.ts: bau, umgraben). */
const BUILDING_REFUSAL = /Hier wird gerade gebaut|Gerade baut jemand anderes|Hier passt kein|Das Licht des Feuers reicht|Dort |Damit wäre|So nah am Feuer|Gäste|Mehr als/;

async function player(url: string, name: string): Promise<P> {
	const p = new Player(url);
	if ((await p.post("/api/register", { name, password: "geheim-123" })).status !== 200) throw new Error(`register ${name}`);
	return { p, me: (await p.play()).me.charId, name };
}
async function answer(a: P, line: string): Promise<{ ok: boolean; text: string }> {
	const from = a.p.frames.length;
	a.p.send(line);
	const f = await a.p.until((f) => f.t === "msg" && (STAKED(a.name).test(f.m.text) || f.m.kind === "error"), 60_000, from);
	const m = (f as Extract<ServerFrame, { t: "msg" }>).m;
	return { ok: m.kind !== "error", text: m.text };
}
async function at(space: SpaceLike, a: P, x: number, y: number): Promise<void> {
	a.p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 60_000, `${a.name} at ${x},${y}`);
}
/** A cell with free grass round it for a hut beside, `n` of them apart from each other. */
async function spots(space: SpaceLike, room: string, n: number): Promise<Array<{ x: number; y: number }>> {
	const ground = w.rooms.find((r) => r.roomId === room)!.ground as string[], held = await heldCells(space, room);
	const fire = w.beacons.find((b) => (b.covers ?? [b.room]).includes(room))!;
	const out: Array<{ x: number; y: number }> = [];
	for (let y = 3; y < ground.length - 3 && out.length < n; y++) for (let x = 3; x < ground[0]!.length - 3 && out.length < n; x++) {
		let free = !out.some((o) => Math.abs(o.x - x) < 4 && Math.abs(o.y - y) < 4) && (fire.room !== room || Math.max(Math.abs(x - fire.x), Math.abs(y - fire.y)) > 4);
		for (let j = y - 2; j <= y + 2 && free; j++) for (let i = x - 2; i <= x + 2 && free; i++) free = walkable(w, ground, i, j) && ground[j]?.[i] !== ":" && !held.has(`${i},${j}`);
		if (free) out.push({ x, y });
	}
	if (out.length < n) throw new Error(`only ${out.length} free spots in ${room}`);
	return out;
}

const env = { SPACES_MMO_NPCS: settlers.map((n) => n.npcId).join(","), SPACES_MMO_SETTLERS_MIN: String(w.npcs.filter((n) => n.settler).length + 2) }; // every settler of the world may play (they go online in their order); the npc process plays the bay's
const stack = await startStack({ worlds: 2, worldEnv: env });
const srv = await startServer({ stack });
try {
	const s = stack.space;
	for (const b of w.beacons) await lightFire(s, (SECONDS + 600) * 1_000, b.beaconId);
	// the material of a hut, a barrel and a scarecrow in each settler's pack, so their building falls into the run
	for (const n of settlers) for (const [key, count] of [["treibholz", 11], ["tangseil", 4]] as const) {
		const proto = (await eventually(() => resolvePrototype(s, key), 10_000, `prototype ${key}`))!;
		for (let i = 0; i < count; i++) await spawn(s, null, w, proto, { location: `npc-${n.npcId}`, x: -1, y: -1 });
	}
	await stack.npcProcess();
	const players = [await player(srv.url, "Ada"), await player(srv.url, "Bea")];
	const places = await spots(s, ROOM, 2);
	for (const [i, a] of players.entries()) await at(s, a, places[i]!.x, places[i]!.y);
	const settlerIds = new Set(settlers.map((n) => `npc-${n.npcId}`)), settlerNames = settlers.map((n) => n.name);
	const ours = tally(), theirs = tally(), byCommand = { bau: 0, abriss: 0 };
	const seen = new Set<string>();
	let told = 0; // every message to a settler: that they play
	const end = Date.now() + SECONDS * 1_000;
	const watch = (async () => {
		while (Date.now() < end + 5_000) {
			for (const e of await s.readAll({ type: "Msg" })) {
				const m = e.fields as unknown as Msg & { to: string };
				if (seen.has(e.id) || !settlerIds.has(m.to)) continue;
				seen.add(e.id); told++;
				if (m.kind === "error" && BUILDING_REFUSAL.test(m.text)) count(theirs, m.text, false);
			}
			await sleep(1_000);
		}
	})();
	await Promise.all(players.map(async (a) => {
		// a site staked is given up again; a refused abriss is sent again, as a player would
		let open = false;
		while (Date.now() < end || open) {
			const r = await answer(a, open ? "abriss baustelle" : "bau hütte");
			count(ours, r.text, r.ok);
			if (!r.ok && kinds.lock.test(r.text)) byCommand[open ? "abriss" : "bau"]++;
			if (r.ok) open = !open;
			await sleep(Math.random() * PAUSE_MS);
		}
	}));
	await watch;
	// a settler's success is told to its room, which Ada stands in
	for (const f of players[0]!.p.frames) if (f.t === "msg" && settlerNames.some((n) => new RegExp(`^${n} (steckt eine Baustelle ab|gräbt)`).test(f.m.text))) count(theirs, f.m.text, true);
	const share = (t: ReturnType<typeof tally>) => (t.commands ? Math.round((t.lock / t.commands) * 10_000) / 100 : 0);
	const all = { commands: ours.commands + theirs.commands, lock: ours.lock + theirs.lock };
	console.log(JSON.stringify({ seconds: SECONDS, pauseMs: PAUSE_MS, world: process.env.SPACES_MMO_WORLD_CMD ? (process.env.SPACES_MMO_WORLD_MIXED === "1" ? "mixed" : "rust") : "ts", players: { ...ours, lockPercent: share(ours), lockBy: byCommand }, settlers: { ...theirs, lockPercent: share(theirs), told, said: players[0]!.p.frames.filter((f) => f.t === "msg" && settlerNames.some((n) => f.m.text.startsWith(`${n} `))).length }, lockPercent: all.commands ? Math.round((all.lock / all.commands) * 10_000) / 100 : 0, otherwise: Object.fromEntries(others) }));
	if (process.env.LOCK_TRACE === "1") console.error(players[0]!.p.frames.filter((f) => f.t === "msg" && settlerNames.some((n) => f.m.text.startsWith(`${n} `))).map((f) => (f as Extract<ServerFrame, { t: "msg" }>).m.text.slice(0, 80)).join("\n"));
} finally {
	await srv.close();
	await stack.close();
}
