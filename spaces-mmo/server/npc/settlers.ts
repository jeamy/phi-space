// The settlers (docs/siedeln.md "Wenige Spieler: die Welt packt mit an"): script figures that play like people where too
// few people play. Each lives on one fire's island (its rooms are its `home`, it takes no ferry) and plays through the
// commands a player types: it gathers driftwood, kelp and shells, twists rope, stakes out a hut and a rain barrel,
// builds them and a coop, helps at the sites of others, digs a bed or two, looks for seeds, plants, waters, weeds and
// harvests, sells what it does not need at its island's market and buys what its site lacks, repairs what it built, and
// feeds its fire when it burns low. No model calls: its account is an NPC's.
//
// - How many play: the setting settlers.min, spread over the regions by how many settlers live there, less the people
//   online in the region; the settlers of a region go online in a fixed order and leave in the reverse one, so the
//   same ones stay when the number shrinks. One that leaves keeps what it built (it decays like anyone's).
// - Light: a settler stakes out only while its fire keeps `settlers.reserve` of its light free (build.ts lightFor), so
//   people who come still find building land.
// - One command a round, then a rest at the pace of economy.ts (slower while no person is on the island).
import { randomInt } from "node:crypto";
import { PATH } from "../engine/commands/build.ts";
import { enoughHuts, settlementIn } from "../engine/commands/settlement.ts";
import { regionWorld } from "../engine/regions.ts";
import { flameOf } from "../engine/fire.ts";
import { clockOf } from "../engine/clockcache.ts";
import { setting } from "../settings.ts";
import type { NpcDef, WorldDef } from "../engine/world.ts";
import { fieldsOf, type BedFields, type BuildingFields, type ListingFields, type SiteFields, type WorkRestFields } from "../model.ts";
import { gather, look, nextTo, rest, travel, type Look } from "./economy.ts";
import type { Npc, Script } from "./scripts.ts";

type Rect = { x: number; y: number; w: number; h: number };
const dist = (p: { x: number; y: number }, r: Rect) => Math.max(Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1)));
const count = (l: Look, proto: string) => l.pack.filter((i) => i.proto === proto).length;
const nameOf = (w: WorldDef, proto: string) => w.prototypes.find((p) => p.key === proto)?.name ?? proto;
/** What lies on the beaches and what a hut, a barrel and a spade are made of. */
const RAW = ["treibholz", "tang", "muschel"];
/** What a settler builds, one after the other: with two beds five points towards its island's epoch each. */
const PLANS = ["huette", "regentonne", "huehnerstall"];
/** How much of each raw thing it carries at most: enough for a site, and one kind never crowds out the others. */
const RAW_MAX = 8;

/** The settlers of the region this process plays (all without regions), in their fixed order. */
const regionSettlers = (() => {
	let cached: NpcDef[] | null = null;
	return (w: WorldDef): NpcDef[] => {
		if (cached) return cached;
		const region = process.env.SPACES_MMO_REGION;
		const rooms = new Set((region && w.regions?.length ? regionWorld(w, region).rooms : w.rooms).map((r) => r.roomId));
		return (cached = w.npcs.filter((n) => n.settler && rooms.has(n.room)));
	};
})();

/** Whether this settler should play now: its place in the region's order is below the region's share of settlers.min,
 *  less the people online here. */
export async function wanted(n: Npc): Promise<boolean> {
	const all = n.world.npcs.filter((x) => x.settler).length, mine = regionSettlers(n.world);
	const rank = mine.findIndex((x) => x.npcId === n.def.npcId);
	if (rank < 0 || !all) return false;
	const people = (await n.space.readAll({ type: "Session" })).filter((e) => !String(e.fields.charId).startsWith("npc-")).length;
	const target = Math.round(((await setting(n.space, "settlers.min")) * mine.length) / all) - people;
	return rank < target;
}

/** Walks to a free cell beside `r` (a site, a building, a bed): false when it stands there already. */
async function besideOf(n: Npc, l: Look, r: Rect & { room: string }, reach = 1): Promise<boolean> {
	if (!(await travel(n, l, r.room))) return true;
	if (dist(l.me, r) <= reach && dist(l.me, r) > 0) return false;
	const ground = n.world.rooms.find((x) => x.roomId === r.room)?.ground ?? [];
	const busy = new Set([...(await n.space.readAll({ type: "Character", fields: { room: r.room } })), ...(await n.space.readAll({ type: "Plot", fields: { room: r.room } }))].map((e) => `${e.fields.x},${e.fields.y}`));
	for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
		if (dist({ x, y }, r) !== 1 || busy.has(`${x},${y}`) || !",.:".includes(ground[y]?.[x] ?? "~")) continue;
		await n.act(`move ${x} ${y}`);
		return true;
	}
	return false;
}

const onPath = (w: WorldDef, r: Rect & { room: string }) => {
	const ground = w.rooms.find((x) => x.roomId === r.room)?.ground ?? [];
	for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (ground[y]?.[x] === PATH) return true;
	return false;
};
/** A free place of w×h in the room: on grass (else sand), off paths, doors and fires, nothing on it, cells to walk round
 *  it. Picked at random, so settlers spread over the room. */
async function freeGround(n: Npc, room: string, w: number, h: number): Promise<{ x: number; y: number } | null> {
	const ground = n.world.rooms.find((r) => r.roomId === room)?.ground ?? [];
	const busy = new Set([...(await n.space.readAll({ type: "Plot", fields: { room } })), ...(await n.space.readAll({ type: "Item", fields: { location: room } })), ...(await n.space.readAll({ type: "Character", fields: { room } }))].map((e) => `${e.fields.x},${e.fields.y}`));
	const near = [...n.world.exits.filter((e) => e.room === room), ...n.world.beacons.filter((b) => b.room === room)];
	const fits = (x0: number, y0: number, tile: string) => {
		for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (ground[y]?.[x] !== tile || busy.has(`${x},${y}`) || near.some((e) => Math.max(Math.abs(e.x - x), Math.abs(e.y - y)) <= 2)) return false;
		return true;
	};
	for (const tile of [",", "."]) {
		const all: Array<{ x: number; y: number }> = [];
		for (let y = 1; y < ground.length - h; y++) for (let x = 1; x < (ground[0]?.length ?? 0) - w; x++) if (fits(x, y, tile)) all.push({ x, y });
		if (all.length) return all[randomInt(0, all.length)]!;
	}
	return null;
}

export function siedler(): Script {
	// a plan that failed (no light, no room) is not tried again for a while: round counts
	const backoff = new Map<string, number>();
	let round = 0, homeAt = 0;
	const may = (what: string) => (backoff.get(what) ?? 0) <= round;
	const later = (what: string, rounds: number) => backoff.set(what, round + rounds);
	return async (n) => {
		round++;
		if (!(await wanted(n))) {
			if (n.isOnline()) { await n.act("emote macht für heute Schluss."); await n.setOnline(false); }
			await n.sleep(n.pace(10 * 60_000, 20_000));
			return;
		}
		if (!n.isOnline()) await n.setOnline(true);
		const l = await look(n);
		if (!l) { await n.sleep(1000); return; }
		const w = n.world, me = l.me, homes = n.def.home ?? [n.def.room];
		if (!homes.includes(me.room)) { await travel(n, l, n.def.room); await n.sleep(await rest(n, me.room)); return; }
		await act(n, l, w, homes);
		await n.sleep(await rest(n, me.room));
	};

	/** One step: the first thing that needs doing. */
	async function act(n: Npc, l: Look, w: WorldDef, homes: string[]): Promise<void> {
		const me = l.me, now = (await clockOf(n.space).now()) ?? 0;
		const g = w.garden;
		// the fire first: when it burns low, wood carried goes into it
		const fire = w.beacons.find((b) => b.beaconId === n.def.beacon);
		const fuels = Object.keys(w.fire.fuel), fuel = l.pack.filter((i) => fuels.includes(i.proto));
		if (fire && fuel.length) {
			const f = await flameOf(n.space, fire.beaconId), piece = Math.min(...Object.values(w.fire.fuel));
			if (!f || f.until - now < piece * 2) {
				if (!(await travel(n, l, fire.room))) return;
				if (Math.max(Math.abs(me.x - fire.x), Math.abs(me.y - fire.y)) <= 1) await n.act(`put ${fuel[0]!.name} in ${fire.aliases[0] ?? "feuer"}`);
				else await nextTo(n, l, fire);
				return;
			}
		}
		const rested = await n.space.readIfExists({ type: "WorkRest", fields: { charId: me.charId } }, 0).then((e) => (e ? fieldsOf<WorkRestFields>(e).untilWorldMs : 0)).catch(() => 0);
		const tired = rested > now;
		const sites = homes.length ? (await n.space.readAll({ type: "Site" })).map((e) => fieldsOf<SiteFields>(e)).filter((s) => homes.includes(s.room)) : [];
		const own = sites.find((s) => s.accountId === me.charId);
		// what it staked out on a path before the paths were closed to building goes: it builds again elsewhere
		const astray = [own, ...(await n.space.readAll({ type: "Building", fields: { accountId: me.charId } })).map((e) => fieldsOf<BuildingFields>(e))].find((r) => r && onPath(w, r));
		if (astray) { if (!(await besideOf(n, l, astray))) await n.act(`abriss ${astray === own ? "baustelle" : astray.name}`); return; }
		// its own site: deliver what it carries of what is missing, then work; what is missing it gathers below
		if (own && (await atSite(n, l, own, tired))) return;
		// the sites of others on its island: bring what they need, lend a hand now and then
		for (const s of sites.filter((x) => x !== own)) if (await atSite(n, l, s, tired || round % 3 !== 0)) return;

		const buildings = (await n.space.readAll({ type: "Building" })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => b.accountId === me.charId);
		// repairs: what it built and that will not stand two more days
		for (const b of buildings) {
			const cost = w.building?.plans.find((p) => p.key === b.plan)?.repair ?? [];
			if (b.untilWorldMs - now > 2 * 24 * 3600_000 || !cost.every((r) => count(l, r.proto) >= r.count)) continue;
			if (!(await besideOf(n, l, b))) await n.act(`repariere ${b.name}`);
			return;
		}
		// the beds: harvest, weed, water, plant
		const beds = g ? (await n.space.readAll({ type: "Bed" })).map((e) => fieldsOf<BedFields>(e)).filter((b) => b.accountId === me.charId) : [];
		for (const b of beds) if (await tend(n, l, b, buildings, now)) return;

		// a plan of its own when it has none going: the hut, then the rain barrel (the server refuses without light)
		const has = (plan: string) => buildings.some((b) => b.plan === plan);
		if (!own) for (const plan of PLANS) {
			if (has(plan) || !may(plan) || !w.building?.plans.some((p) => p.key === plan)) continue;
			if (!homes.includes(me.room) || !w.beacons.some((b) => b.covers.includes(me.room))) continue;
			const def = w.building.plans.find((p) => p.key === plan)!, at = await freeGround(n, me.room, def.w, def.h);
			later(plan, 20); // seen again in twenty rounds: built, staked or refused
			if (at) { await n.act(`bau ${def.name.toLowerCase()} ${at.x} ${at.y}`); return; }
			continue;
		}
		// three huts of two owners in its room and no settlement yet: it founds one, named after the place
		if (has("huette") && w.settlement && may("siedlung")) {
			later("siedlung", 40);
			const hut = buildings.find((b) => b.plan === "huette")!;
			const huts = (await n.space.readAll({ type: "Building", fields: { room: hut.room, plan: w.settlement.plan } })).map((e) => fieldsOf<BuildingFields>(e));
			if (me.room === hut.room && enoughHuts(w, huts) && !(await settlementIn(n.space, hut.room))) { await n.act(`siedlung gründen ${w.rooms.find((r) => r.roomId === hut.room)?.name ?? me.name}`); return; }
		}
		// a spade and up to its beds
		if (g && beds.length < (w.settlers?.maxBeds ?? 1) && has("huette")) {
			if (!count(l, g.spade)) { if (await craft(n, l, w, g.spade)) return; }
			else if (may("beet")) {
				later("beet", 15);
				const at = await freeGround(n, me.room, g.bed.w, g.bed.h);
				if (at) { await n.act(`umgraben ${at.x} ${at.y}`); return; }
			}
		}
		// rope from kelp when it has kelp to spare
		if (count(l, "tang") >= 3 && count(l, "tangseil") < 2) { await n.act("craft tangseil"); return; }
		// what it does not need goes to the market of its island, when it has one; what it lacks for a site it buys there
		const heap = l.pack.filter((i) => !RAW.includes(i.proto) && i.proto !== "tangseil" && i.proto !== g?.spade && i.proto !== g?.can && i.proto !== w.currency && n.world.prototypes.find((p) => p.key === i.proto)?.typeclass !== "Seed");
		if (await trade(n, l, w, homes, heap, own)) return;
		// the hut's chest takes what piles up
		const hut = buildings.find((b) => b.plan === "huette");
		if (hut && heap.length > 6 && may("chest")) { later("chest", 10); if (!(await besideOf(n, l, hut))) await n.act(`verstaue alle ${heap[0]!.name}`); return; }
		// gather: what lies on the beaches of its rooms, moving on to the next room when nothing is left here
		if (await gather(n, l, RAW.filter((p) => count(l, p) < RAW_MAX))) return;
		homeAt = (homeAt + 1) % homes.length;
		if (homes.length > 1 && round % 4 === 0) await travel(n, l, homes[homeAt]!);
	}

	/** At the island's market: one thing it does not need on the board, or the first thing its site lacks off it. */
	async function trade(n: Npc, l: Look, w: WorldDef, homes: string[], heap: Look["pack"], site: SiteFields | undefined): Promise<boolean> {
		const market = homes.find((r) => w.market.rooms.includes(r));
		if (!market || !may("market")) return false;
		const coins = count(l, w.currency), lacks = site?.needs.filter((x) => x.have < x.count && !count(l, x.proto)).map((x) => x.name) ?? [];
		if (heap.length < 2 && !(coins && lacks.length)) return false;
		if (!(await travel(n, l, market))) return true;
		later("market", 12);
		const board = (await n.space.readAll({ type: "Listing", fields: { room: market } })).map((e) => fieldsOf<ListingFields>(e)).sort((a, b) => a.at - b.at || a.listingId.localeCompare(b.listingId));
		const i = board.findIndex((x) => x.seller !== l.me.charId && x.price <= coins && lacks.includes(x.itemName));
		if (i >= 0) { await n.act(`market kaufe ${i + 1}`); return true; }
		if (heap.length >= 2 && board.filter((x) => x.seller === l.me.charId).length < 3) { await n.act(`market biete ${heap[0]!.name} für ${2 + (round % 3)}`); return true; }
		return false;
	}

	/** At a site (its own or another's): deliver what it carries of what is missing, or work (`noWork`: not this round). */
	async function atSite(n: Npc, l: Look, s: SiteFields, noWork: boolean): Promise<boolean> {
		const give = s.needs.find((x) => x.have < x.count && count(l, x.proto) > 0);
		const work = !noWork && s.work < s.workNeed;
		if (!give && !work) {
			// its own: make what is missing from what it has (rope from kelp), else gather below
			if (s.accountId === l.me.charId) { const rope = s.needs.find((x) => x.proto === "tangseil" && x.have < x.count); if (rope && count(l, "tang") >= 3) { await n.act("craft tangseil"); return true; } }
			return false;
		}
		if (await besideOf(n, l, s, 2)) return true;
		await n.act(give ? `liefere ${give.name}` : "arbeite");
		return true;
	}

	/** Makes a thing by its recipe, or gathers what it needs: false when it neither can nor finds anything. */
	async function craft(n: Npc, l: Look, w: WorldDef, proto: string): Promise<boolean> {
		const r = w.recipes.find((x) => x.makes === proto);
		if (!r) return false;
		const lack = r.needs.find((x) => count(l, x.proto) < x.count);
		if (!lack) { await n.act(`craft ${r.key}`); return true; }
		if (lack.proto === "tangseil" && count(l, "tang") >= 3) { await n.act("craft tangseil"); return true; }
		return gather(n, l, [lack.proto, ...(lack.proto === "tangseil" ? ["tang"] : [])]);
	}

	/** Tends a bed of its own: harvest, weed, water (a can from its barrel), plant a seed it carries, look for seeds. */
	async function tend(n: Npc, l: Look, b: BedFields, buildings: BuildingFields[], now: number): Promise<boolean> {
		const g = n.world.garden!;
		const near = async (line: string) => { if (!(await besideOf(n, l, b))) await n.act(line); return true; };
		if (b.plants.some((p) => p.stage === 2)) return near("ernte");
		if (b.weedy || b.plants.some((p) => p.stage === 3)) return near("jäte");
		const growing = b.plants.some((p) => p.stage < 2);
		if (growing && now - b.wateredWorldMs > g.thirstWorldMs * 0.6) {
			if (count(l, g.can)) return near("gieße");
			const barrel = buildings.find((x) => x.plan === g.barrel);
			if (barrel && may("schoepfe")) { later("schoepfe", 6); if (!(await besideOf(n, l, barrel))) await n.act("schöpfe"); return true; }
		}
		const seed = l.pack.find((i) => g.sorts.some((s) => s.seed === i.proto && (b.kind !== "zier" || s.kind === "zier")));
		if (b.plants.length < b.w * b.h) {
			if (seed) return near(`pflanze ${seed.name}`);
			if (may("samen")) { later("samen", 8); await n.act("sammle samen"); return true; }
		}
		return false;
	}
}

export const SETTLER_SCRIPTS: Record<string, () => Script> = { siedler };
