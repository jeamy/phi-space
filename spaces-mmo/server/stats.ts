// The statistics page (client/StatsPanel.tsx, GET /api/stats): the players and what the world holds, read from every
// region and added up: the players, the settlers and the figures a model plays (each marked); scripted NPCs are left out. What others see of a player is what the game
// shows anyway: the figure's name (never the login name), where it stands (a passenger of the large ship only as
// "aboard", not where it goes), since when it plays, its reputation, how often it travelled, what it owns and carries.
import type { SpaceLike } from "phi-spaces";
import { fieldsOf, type AccountFields, type BedFields, type BuildingFields, type CharacterFields, type ContributionFields, type FieldFields, type ParkCareFields, type SessionFields } from "./model.ts";
import type { RegionSpaces } from "./region-spaces.ts";
import { TRIPS, type Trip, type TravelFields } from "./engine/travel.ts";
import type { WorldDef } from "./engine/world.ts";

export type { Trips, PlayerStat, WorldStats } from "../shared/frames.ts";
import type { Trips, PlayerStat, WorldStats } from "../shared/frames.ts";

const KIND_ORDER = { player: 0, settler: 1, ai: 2 } as const;
const noTrips = (): Trips => Object.fromEntries(TRIPS.map((k) => [k, 0])) as Trips;

async function all(space: SpaceLike, type: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	let after: string | null = null, token: string | undefined;
	do {
		const page: Awaited<ReturnType<SpaceLike["readPage"]>> = await space.readPage({ type }, { after, token, maxBytes: 256 * 1024 });
		for (const e of page.items) out.push(fieldsOf(e));
		after = page.next; token = page.token;
	} while (after !== null);
	return out;
}

const TYPES = ["Account", "Character", "Session", "Contribution", "ParkCare", "Travel", "Building", "Bed", "Field", "Site", "Settlement"] as const;

export async function collectStats(regions: RegionSpaces, w: WorldDef): Promise<WorldStats> {
	const read: Record<(typeof TYPES)[number], Array<Record<string, unknown>>> = Object.fromEntries(TYPES.map((t) => [t, []])) as never;
	const missing: string[] = [];
	const spaceOf = new Map<string, SpaceLike>(); // charId -> the region it stands in
	await Promise.all(regions.entries().map(async ([region, space]) => {
		try {
			const got = await Promise.all(TYPES.map((t) => all(space, t)));
			TYPES.forEach((t, i) => read[t].push(...got[i]!));
			for (const c of got[TYPES.indexOf("Character")]!) spaceOf.set(String(c.charId), space);
		} catch { missing.push(region); }
	}));
	// one account and one figure per id (a crossing may show one twice for a moment)
	const ai = new Set(w.npcs.filter((n) => n.model).map((n) => `npc-${n.npcId}`));
	const accounts = new Map<string, AccountFields>();
	for (const a of read.Account as AccountFields[]) accounts.set(a.accountId, a);
	const kindOf = (c: CharacterFields): PlayerStat["kind"] | null => {
		const a = accounts.get(c.accountId);
		if (!a) return null;
		if (a.settler || c.charId.startsWith("npc-siedler-")) return "settler";
		if (ai.has(c.charId)) return "ai";
		return a.npc || c.charId.startsWith("npc-") ? null : "player";
	};
	const chars = new Map<string, CharacterFields & { kind: PlayerStat["kind"] }>();
	for (const c of read.Character as CharacterFields[]) { const kind = kindOf(c); if (kind) chars.set(c.charId, { ...c, kind }); }
	const live = new Set((read.Session as SessionFields[]).map((s) => s.charId));
	const rooms = new Map((w.allRooms ?? w.rooms).map((r) => [r.roomId, r]));
	const pieces = new Map<string, { pieces: number; beacons: Set<string> }>();
	for (const c of read.Contribution as ContributionFields[]) {
		const p = pieces.get(c.charId) ?? { pieces: 0, beacons: new Set<string>() };
		p.pieces += c.pieces; p.beacons.add(c.beaconId); pieces.set(c.charId, p);
	}
	const parks = new Map<string, number>();
	for (const p of read.ParkCare as ParkCareFields[]) parks.set(p.accountId, (parks.get(p.accountId) ?? 0) + Number(p.points));
	const trips = new Map<string, Trips>(), total = noTrips();
	for (const t of read.Travel as TravelFields[]) {
		if (!chars.has(t.charId)) continue;
		const mine = trips.get(t.charId) ?? noTrips();
		for (const k of TRIPS) { mine[k] += t[k] ?? 0; total[k] += t[k] ?? 0; }
		trips.set(t.charId, mine);
	}
	const owned = (rows: Array<{ accountId: string }>) => { const m = new Map<string, number>(); for (const r of rows) m.set(r.accountId, (m.get(r.accountId) ?? 0) + 1); return m; };
	const buildings = read.Building as BuildingFields[], beds = read.Bed as BedFields[], fields = read.Field as FieldFields[];
	const ownB = owned(buildings), ownBeds = owned(beds), ownF = owned(fields);
	const ownPlans = new Map<string, Map<string, number>>();
	for (const b of buildings) {
		const m = ownPlans.get(b.accountId) ?? new Map<string, number>();
		m.set(b.plan, (m.get(b.plan) ?? 0) + 1); ownPlans.set(b.accountId, m);
	}
	const planName = (key: string) => w.building?.plans.find((p) => p.key === key)?.name ?? key;
	// the pack of each figure listed, read where it stands (by its location, not every thing of the world)
	const packs = new Map<string, Array<{ name: string; count: number }>>();
	await Promise.all([...chars.keys()].map(async (charId) => {
		const space = spaceOf.get(charId);
		if (!space) return;
		const n = new Map<string, number>();
		try { for (const e of await space.readAll({ type: "Item", fields: { location: charId } })) { const name = String(e.fields.name); n.set(name, (n.get(name) ?? 0) + 1); } } catch { return; }
		packs.set(charId, [...n].map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name, "de")));
	}));
	const list: PlayerStat[] = [...chars.values()].map((c) => {
		const a = accounts.get(c.accountId)!, room = rooms.get(c.room), p = pieces.get(c.charId);
		return {
			charId: c.charId, name: c.name, kind: c.kind, guest: a.guest, online: live.has(c.charId),
			since: a.guest ? a.createdAt : (a.registeredAt ?? a.createdAt),
			at: c.aboard ? { aboard: true as const } : { room: c.room, roomName: room?.name ?? c.room, island: room?.island ?? null, x: c.x, y: c.y },
			reputation: { pieces: p?.pieces ?? 0, beacons: p?.beacons.size ?? 0, parks: parks.get(c.accountId) ?? 0 },
			trips: trips.get(c.charId) ?? noTrips(),
			owns: {
				buildings: ownB.get(c.accountId) ?? 0, beds: ownBeds.get(c.accountId) ?? 0, fields: ownF.get(c.accountId) ?? 0,
				plans: [...(ownPlans.get(c.accountId) ?? [])].map(([plan, count]) => ({ plan, name: planName(plan), count })).sort((x, y) => y.count - x.count),
				carries: packs.get(c.charId) ?? [],
			},
		};
	}).sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || Number(y.online) - Number(x.online) || Number(x.guest) - Number(y.guest) || x.name.localeCompare(y.name, "de"));
	const people = list.filter((p) => p.kind === "player");
	const byPlan = new Map<string, number>();
	for (const b of buildings) byPlan.set(b.plan, (byPlan.get(b.plan) ?? 0) + 1);
	return {
		at: Date.now(),
		players: { total: people.length, registered: people.filter((p) => !p.guest).length, guests: people.filter((p) => p.guest).length, online: people.filter((p) => p.online).length, settlers: list.filter((p) => p.kind === "settler").length, ai: list.filter((p) => p.kind === "ai").length },
		trips: total,
		buildings: { total: buildings.length, houses: byPlan.get("huette") ?? 0, byPlan: [...byPlan].map(([plan, count]) => ({ plan, name: planName(plan), count })).sort((x, y) => y.count - x.count) },
		beds: beds.length, fields: fields.length, sites: read.Site.length,
		settlements: new Set((read.Settlement as Array<{ settlementId: string }>).map((s) => s.settlementId)).size,
		list, missing,
	};
}

/** The statistics, read at most every `ttlMs` (everyone shares one reading; a reading in progress is waited for). */
export function statsCache(regions: RegionSpaces, w: WorldDef, ttlMs = 20_000): () => Promise<WorldStats> {
	let last: { at: number; value: Promise<WorldStats> } | null = null;
	return () => {
		if (!last || Date.now() - last.at > ttlMs) {
			const value = collectStats(regions, w);
			last = { at: Date.now(), value };
			value.catch(() => { if (last?.value === value) last = null; });
		}
		return last.value;
	};
}
