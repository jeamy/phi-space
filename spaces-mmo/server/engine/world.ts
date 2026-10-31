// What a world brings (docs/architektur.md, "Verzeichnisaufbau"): rooms, the tiles their grids use, the character
// skins and the help text. The engine loads exactly one world (SPACES_MMO_WORLD); a world adds data, never engine rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import type { BeaconFields, ExitFields, HelpEntryFields, PrototypeFields } from "../model.ts";
import { parseLocks } from "./locks.ts";
import { typeChain } from "./typeclasses.ts";

/** A 32×32 cut of a sheet (pixel offsets); `walk`: characters may stand on it. `auto`: drawn as an autotile (RPG Maker
 *  VX layout, 2×3 tiles per block, composed from quarter tiles by its neighbours), one block per animation frame;
 *  `x`/`y` stay the flat fallback. */
export type TileDef = { sheet: string; x: number; y: number; walk: boolean; auto?: { blocks: Array<{ x: number; y: number }>; frameMs: number } };
/** Something drawn over a ground tile (a flower, a bush, a small tree): a `w`×`h` cut of a sheet, standing on the bottom of
 *  its cell (taller cuts reach into the cell above), optionally tinted; `upright` ones stand among the figures (one behind
 *  it is hidden), the others lie flat under things and figures. Only for the eye: it changes no rule. */
export type DecorDef = { sheet: string; x: number; y: number; w: number; h: number; tint?: number; upright?: boolean; /** the 3D map's model instead of the picture (client/props3d.ts) */ model?: "tree" | "conifer" | "bush" | "berrybush" };
/** A character sheet: 4 frames per row, rows down, left, right, up. */
export type SkinDef = { sheet: string; frameW: number; frameH: number };
/** `map`: where the room lies on the overview of the world (one unit per room; rooms of one island side by side),
 *  `island`: the island it belongs to (the overview groups and names them). */
/** `decor`: the same grid as `ground`, a key of the world's `decor` or a space per cell. */
export type RoomDef = { roomId: string; name: string; desc: string; ground: string[]; decor?: string[]; spawn: { x: number; y: number }; map?: { x: number; y: number }; island?: string };
export type ExitDef = Omit<ExitFields, "location" | "locks"> & { room: string; locks?: string };
/** An item the world places once: spawned only while no item with its itemId exists anywhere. */
export type PlacedDef = { itemId: string; proto: string; room: string; x: number; y: number };
export type WorldDef = {
	id: string; title: string; tileSize: number; tiles: Record<string, TileDef>; skins: SkinDef[]; rooms: RoomDef[]; start: string; guestName: string;
	/** What a room's `decor` grid names (plants and the like). */
	decor?: Record<string, DecorDef>;
	/** Raised when the definition changes: a world worker loads a newer version (rooms, exits, prototypes, help). */
	version: number;
	/** The hour of day 0 a new world's clock starts at (default 8; docs/weltzeit.md). */
	startHour?: number;
	/** A daily `evening` event at this world hour (docs/weltzeit.md): the schedule is made with the world. */
	evening?: { hour: number };
	/** Typeclasses below the engine's (name → parent). */
	typeclasses: Record<string, string | null>;
	prototypes: PrototypeFields[];
	objects: PlacedDef[];
	exits: ExitDef[];
	/** Help topics beyond the command list; `help` without a topic starts with `intro`. */
	help: HelpEntryFields[];
	/** What a room dug by a builder looks like until it is shaped. */
	dig: { ground: string[]; spawn: { x: number; y: number }; desc: string };
	/** Phase 2. Where fires can burn and which rooms each keeps clear of fog. */
	beacons: Array<Omit<BeaconFields, "lit">>;
	/** Burn time each fuel prototype gives, and the most a fire can hold. */
	fire: { fuel: Record<string, number>; maxMs: number };
	/** Fog levels 0..max; every `stepMs` it rises by one in rooms without a burning fire and falls by one with. */
	fog: { max: number; start: number; stepMs: number };
	/** The tide: every `everyMs` one piece of flotsam per room (up to `max` lying there) on a cell of `tile`; a room
	 *  may wash up its own things (`protos`) instead of the world's. */
	flood: { everyMs: number; lifetimeMs: number; rooms: Array<{ room: string; tile: string; max: number; protos?: Array<{ proto: string; weight: number }> }>; protos: Array<{ proto: string; weight: number }>;
		/** Every this many people online on an island, one more piece may lie on each of its beaches and one more comes with
		 *  each tide (default 3). */
		perPlayers?: number;
		/** What must always be there to build with: when fewer than `perIsland` of a thing (more by the people on the island)
		 *  lie on the beaches of an island, the tide brings up to `perTide` more; they lie `lifetimeMs`. */
		staples?: { lifetimeMs: number; perTide: number; things: Array<{ proto: string; perIsland: number }> } };
	/** A storm surge now and then: `count` things at once on a beach of one of `rooms`, announced on `channel`. */
	storm?: { everyMs: number; count: number; rooms: string[]; protos: Array<{ proto: string; weight: number }>; channel: string };
	/** Channels everyone hears, across rooms. */
	channels: string[];
	/** Characters played by scripts (the npc process), not by models. */
	npcs: NpcDef[];
	/** Phase 4. The prototype that counts as money (prices, rewards). */
	currency: string;
	/** Where market boards stand (each its own listings) and how long a listing stays. */
	market: { rooms: string[]; listMs: number };
	/** Recipes: what goes in (used up), which tool is needed (it wears by one), what comes out (`count` of it, one without);
	 *  `at`: only beside a building of that plan (the bakery's oven). */
	recipes: Array<{ key: string; name: string; needs: Array<{ proto: string; count: number }>; tool?: string; makes: string; count?: number; at?: string }>;
	/** The order board: jobs the world posts (up to `max` open), each lasting `leaseMs` once posted. */
	orders: { rooms: string[]; max: number; everyMs: number; leaseMs: number; kinds: Array<{ key: string; text: string; needs: Array<{ proto: string; count: number }>; reward: { proto: string; count: number }; rooms?: string[] }> };
	/** What can be built (docs/siedeln.md): plans and the rules of building. Without it nothing can be built. */
	building?: BuildingDef;
	/** Gardens (docs/siedeln.md "Gärten"): beds, what grows in them and how. Without it nothing is planted. */
	garden?: GardenDef;
	wild?: WildDef;
	/** The epochs of an island (docs/siedeln.md "Epochen"): their names from the first on (`a`: with the article, "ein
	 *  Dorf"), and how often the count runs. The thresholds are settings (epoch.dorf, epoch.stadt, epoch.netz). */
	epochs?: { names: string[]; a: string[]; checkWorldMs: number };
	/** The settlers (docs/siedeln.md "Wenige Spieler"): what share of a fire's light they leave free for people, and how
	 *  many beds each digs. How many play at once is the setting settlers.min, less the people online. */
	settlers?: { reserve: number; maxBeds: number };
	/** A settlement needs `huts` buildings of the plan `plan` of at least `owners` owners in one room. */
	settlement?: { plan: string; huts: number; owners: number };
	/** Fields (docs/siedeln.md "Äcker und Getreide"): one crop on a larger area, sown and brought in by many hands. */
	fields?: FieldDef;
	/** The windmill (docs/siedeln.md "Warenketten"): grain brought to it becomes flour in its own time. */
	mill?: MillDef;
	/** A quarry: `plan` beside one, with `tool`, a work gives `count` of `makes` and a rest (docs/siedeln.md "Stoffe"). */
	quarry?: { plan: string; tool: string; makes: string; count: number };
	/** A clay pit, the same with a spade. */
	clay?: { plan: string; tool: string; makes: string; count: number };
	/** Animals on the farm (docs/siedeln.md "Tiere auf dem Hof"): kept in a building of their plan, fed, giving yields. */
	animals?: AnimalsDef;
	/** How the world splits into region spaces when SPACES_MMO_REGIONS names them (engine/regions.ts); without it the
	 *  whole world is one space. */
	regions?: RegionDef[];
	/** Set on the part of the world one region runs (regionWorld): its id and every room of the whole world. */
	region?: string;
	allRooms?: RoomDef[];
};
/** A plan (docs/siedeln.md, "Was man baut"): its footprint `w`×`h`, what it needs delivered, the work points, what it
 *  counts towards the epoch and takes of a fire's light (`points`), how long it stands without repair. */
/** `chest`: how many things its chest holds (none without); `repair`: what a repair costs (it then stands `keepWorldMs` again). */
/** `dative`: the plan with its article as one says "neben einer Hütte" (default "einem <name>"). `epoch`: the island's
 *  epoch from which a new one may be staked out (default 1; docs/siedeln.md "Epochen"). */
/** `sparesTools`: a recipe made beside it wears a tool half as fast. */
export type PlanDef = { sparesTools?: boolean; store?: boolean; epoch?: number; dative?: string; key: string; name: string; aliases: string[]; w: number; h: number; needs: Array<{ proto: string; count: number }>; work: number; points: number; keepWorldMs: number; color: string; chest?: number; repair: Array<{ proto: string; count: number }> };
/** `lightPoints`: what a fire's light carries; `siteWorldMs`: how long a site waits for progress; `restWorldMs`: how long a
 *  figure rests after a work point; `maxSites`/`maxBuildings`: per account. */
/** `ruinWorldMs`: how long a ruin stays; `estateWorldMs`: how long what lay in its chest waits for its owner. */
/** A sort that grows in a bed: from seed (`seed`, a prototype) to sprout after `grow[0]`, to ripe after `grow[1]`, ripe
 *  for `ripeWorldMs`, then it wilts. A harvest gives `yields` and a seed (sometimes two). `wild`: where its seeds are found
 *  in the wild flora (rooms whose decor has flowers or herbs, on these islands; without islands everywhere). */
export type SortDef = { key: string; name: string; aliases: string[]; kind: "nutz" | "zier"; seed: string; grow: [number, number]; ripeWorldMs: number; yields: { proto: string; count: number }; color: string;
	wild?: { decor: "flowers" | "herbs"; islands?: string[] } };
/** `bed`: the size of a bed, the light it takes, how long it stays without care; `spade`: the tool that digs one;
 *  `can`: a can of water (from the rain barrel, the building plan `barrel`, which holds `barrelCap` cans and gains one
 *  every `barrelFillWorldMs`, all at a storm surge on its island); `thirstWorldMs`: how long a bed's plants go
 *  without water before the next stage finds them dry and they wilt; `seedRestWorldMs`/`seedChance`: how often one
 *  looks for wild seeds and how often one finds some. `commons`: a community bed (its size and light; one per fire,
 *  not counted to anyone's beds); `crossChance`: how often a ripe flower beside another sort in a flower bed gives a
 *  seed of a crossing. */
export type GardenDef = { bed: { w: number; h: number; points: number; keepWorldMs: number }; commons: { w: number; h: number; points: number }; crossChance: number; maxBeds: number; spade: string; can: string; barrel: string; barrelCap: number; barrelFillWorldMs: number;
	thirstWorldMs: number; seedRestWorldMs: number; seedChance: number; decor: { flowers: string[]; herbs: string[] }; sorts: SortDef[] };
/** The wild from the fog (docs/siedeln.md "Wild im Nebel"), first the hares in the beds: every `checkWorldMs` a room
 *  with beds rolls `chance[fog]` (by its fog level 0 to 3; `nightFactor` times that at night) for a hare, at most
 *  `maxPerRoom` at once. A hare eats `eatAfterWorldMs` after it came unless someone within `scareReach` scared it off;
 *  a bed with a fence (it costs `fence`) or within `scarecrowReach` of a scarecrow (the building plan `scarecrow`)
 *  loses nothing. */
/** `prey`: the other kinds (step 3 part 4), each with its own chances and wording. `guards`: what keeps a kind from every
 *  target in a room while fed (a herd kind, the geese, or a keeper, the dog and the cat); `keepers`: the animals one
 *  leaves at a building of one's own as a guard, fed like a herd. `fieldFence`/`coopFence`: what a fence round a field or
 *  a coop costs. */
export type WildDef = { checkWorldMs: number; chance: [number, number, number, number]; nightFactor: number; maxPerRoom: number; eatAfterWorldMs: number; scareReach: number;
	hare: { name: string; icon: string }; fence: Array<{ proto: string; count: number }>; scarecrow: string; scarecrowReach: number;
	prey?: PreyDef[]; guards?: GuardDef[]; keepers?: KeeperDef[]; fieldFence?: Array<{ proto: string; count: number }>; coopFence?: Array<{ proto: string; count: number }> };
/** A kind of wild beside the hare: `reh` grazes a growing field (each bite costs `bite` of its yield, never below `keep`),
 *  `fuchs` takes an animal from a house of `houses` (never the last), `maus` eats up to `take` of `eats` from a chest
 *  (never the last; a `trap` in the chest catches it). `nom`/`the`/`acc`/`none`: "ein Reh", "das Reh", "das Reh", "kein
 *  Reh"; `goes`: how it moves ("zieht"); `to`: where it goes, `{owner}` for the target's owner. `dayFactor`: its chance by day (the fox comes almost only at night). */
export type PreyDef = { key: "reh" | "fuchs" | "maus"; name: string; aliases: string[]; nom: string; the: string; acc: string; none: string; goes: string; to: string; icon: string;
	chance: [number, number, number, number]; nightFactor: number; dayFactor?: number; eatAfterWorldMs: number;
	bite?: number; keep?: number; houses?: string[]; eats?: string[]; take?: number; trap?: string };
/** `by`: a herd kind or a keeper kind; fed, it keeps `kinds` from its room, and says `says` when one comes. */
export type GuardDef = { by: string; kinds: string[]; says: string };
/** A dog or cat: the prototype it is as a thing, what it eats (one thing keeps it fed `AnimalsDef.feedWorldMs`). */
export type KeeperDef = { key: string; proto: string; name: string; the: string; acc: string; none: string; feed: string[] };
/** A crop of a field: its seed (a prototype, for grain the grain itself), the `group` it rotates in (the same group
 *  twice in a row tires the soil), how long it grows once sown, what each cell gives (some of it the next seed), its
 *  colour when ripe, and where its seed is found in the wild flora (like a garden sort's). */
export type CropDef = { key: string; name: string; aliases: string[]; group: string; seed: string; growWorldMs: number; yields: Array<{ proto: string; perCell: number }>; color: string; wild?: SortDef["wild"] };
/** A field of `w`×`h` cells takes `points` of a fire's light, at most `maxFields` per account, and goes back to grass
 *  after `keepWorldMs` without work. Sowing takes a seed per `seedPerCells` cells and a work point per `sowPerCells`,
 *  the harvest a work point per `harvestPerCells` (the same rest as on a site). It is ripe for `windowWorldMs`; after
 *  that each share loses `lateLoss` to the field for another window, then the crop is lost. `tired`: the yield's
 *  factor by how often its crop's group came before it in a row (rest for `fallowWorldMs` heals the soil). */
export type FieldDef = { epoch?: number; w: number; h: number; points: number; maxFields: number; keepWorldMs: number; seedPerCells: number; sowPerCells: number; harvestPerCells: number;
	windowWorldMs: number; lateLoss: number; tired: number[]; fallowWorldMs: number; crops: CropDef[] };
/** The mill is the building plan `plan`; it grinds one unit of grain (`grinds`: what becomes what) per `unitWorldMs`, one
 *  load after the other, at most `maxLoad` units a load and `maxLoads` waiting loads per figure; a storm surge on its
 *  island grinds `stormWorldMs` ahead. Flour nobody fetches goes after `keepWorldMs`. */
export type MillDef = { plan: string; grinds: Array<{ from: string; to: string }>; unitWorldMs: number; maxLoad: number; maxLoads: number; stormWorldMs: number; keepWorldMs: number };
/** A kind of animal: the prototype it is as a thing (bought, carried, put in), the plan that houses it, what one gives
 *  every `everyWorldMs` while fed (`yields`, a prototype), what it eats, and how often two fed ones get a young one. */
export type AnimalKindDef = { key: string; proto: string; name: string; plural: string; plan: string; yields: string; everyWorldMs: number; feed: string[]; breedWorldMs: number };
/** `houses`: how many a building of each plan holds (one kind at a time); one thing of feed keeps one animal fed for
 *  `feedWorldMs`, up to `fedMaxWorldMs` ahead; yields wait in the house, at most `nestMax` per animal. */
export type AnimalsDef = { kinds: AnimalKindDef[]; houses: Record<string, number>; feedWorldMs: number; fedMaxWorldMs: number; nestMax: number };
/** `store` (a plan whose chest a settlement shares, docs/siedeln.md "Siedlungen und Besitz"): `quota`: how many things a rank
 *  may take per world day; `logKeepMs`: how long a line of the log stays (real time, it must outlast the quota's day);
 *  `logShow`: how many lines `lager log` shows. */
export type StoreDef = { quota: { fremder: number; helfer: number; siedler: number }; logKeepMs: number; logShow: number };
export type BuildingDef = { store?: StoreDef; plans: PlanDef[]; lightPoints: number; siteWorldMs: number; restWorldMs: number; maxSites: number; maxBuildings: number; ruinWorldMs: number; estateWorldMs: number };
export type NpcDef = {
	npcId: string; name: string; skin: number; room: string; x: number; y: number; script: string; beacon?: string;
	/** In world hours: the NPC is there from `presentFromHour` to `presentUntilHour` (over midnight too), else away. */
	plan?: { presentFromHour: number; presentUntilHour: number };
	/** A model role (docs/modell-npcs.md): who it is, which events wake it, its model calls per day. Without model calls
	 *  (SPACES_MMO_LLM unset) or with its budget used up it dozes and speaks script lines. */
	model?: { persona: string; wake: string[]; budgetDay: number; dozing: string[] };
	/** A wanderer: appears only through its event, at most once per `cooldownMs`, leaves after `stayMs` without being
	 *  spoken to (game time). */
	wanderer?: { event: string; cooldownMs: number; stayMs: number };
	/** The economy (server/npc/economy.ts): the rooms it works in, the market it sells at, the rooms a trader travels
	 *  between, what it pays at most and asks per prototype ([buy, sell], 0: not), the recipes it makes, what it
	 *  carries when the world creates it, and what it says now and then. */
	home?: string[]; market?: string; route?: string[]; prices?: Record<string, [number, number]>; crafts?: string[];
	carry?: Array<{ proto: string; count: number }>; lines?: string[];
	/** A settler (server/npc/settlers.ts, script "siedler"): plays like a person on its home island, through the same
	 *  commands; it may build and sow (rules as for people), but only while the fire keeps `settlers.reserve` of its
	 *  light free for the people who come. Its account is an NPC's (no model calls), marked `settler`. */
	settler?: boolean;
};

import type { RegionDef } from "./regions.ts";

const WORLD_ID = /^[a-z0-9-]{1,40}$/;

/** The world named by SPACES_MMO_WORLD (default leuchtfeuer), checked: every row as wide as the first, every tile key
 *  known, every spawn walkable. */
export async function loadWorld(id = process.env.SPACES_MMO_WORLD || "leuchtfeuer"): Promise<WorldDef> {
	if (!WORLD_ID.test(id)) throw new Error(`SPACES_MMO_WORLD: a-z, 0-9 and -, got ${id}`);
	const w = (await import(join(ROOT, "worlds", id, "world.ts"))).world as WorldDef;
	const grid = (what: string, ground: string[], spawn: { x: number; y: number }) => {
		const width = ground[0]?.length ?? 0;
		if (!width || ground.some((row) => row.length !== width)) throw new Error(`${what}: rows of different width`);
		for (const row of ground) for (const k of row) if (!w.tiles[k]) throw new Error(`${what}: unknown tile ${k}`);
		if (!walkable(w, ground, spawn.x, spawn.y)) throw new Error(`${what}: spawn is not walkable`);
	};
	for (const r of w.rooms) {
		grid(`room ${r.roomId}`, r.ground, r.spawn);
		if (!r.decor) continue;
		if (r.decor.length !== r.ground.length || r.decor.some((row) => row.length !== r.ground[0]!.length)) throw new Error(`room ${r.roomId}: decor not the size of the ground`);
		for (const row of r.decor) for (const k of row) if (k !== " " && !w.decor?.[k]) throw new Error(`room ${r.roomId}: unknown decor ${k}`);
	}
	grid("dig template", w.dig.ground, w.dig.spawn);
	const room = (roomId: string) => w.rooms.find((r) => r.roomId === roomId);
	if (!room(w.start)) throw new Error(`world ${id}: unknown start room ${w.start}`);
	for (const p of w.prototypes) {
		typeChain(p.typeclass, w.typeclasses);
		if (p.parent && !w.prototypes.some((q) => q.key === p.parent)) throw new Error(`prototype ${p.key}: unknown parent ${p.parent}`);
		parseLocks(p.locks);
		if (p.icon && !worldAsset(id, p.icon)?.type.startsWith("image/")) throw new Error(`prototype ${p.key}: icon ${p.icon} is no picture in worlds/${id}/assets`);
	}
	for (const e of w.exits) {
		const from = room(e.room), to = room(e.destination);
		if (!from || !to) throw new Error(`exit ${e.exitId}: unknown room`);
		if (!walkable(w, from.ground, e.x, e.y) || !walkable(w, to.ground, e.arrive.x, e.arrive.y)) throw new Error(`exit ${e.exitId}: cell or arrival not walkable`);
		if (w.exits.some((o) => o.room === e.destination && o.x === e.arrive.x && o.y === e.arrive.y)) throw new Error(`exit ${e.exitId}: arrives on another exit`);
		parseLocks(e.locks ?? "");
	}
	for (const b of w.beacons) {
		const r = room(b.room);
		if (!r || !walkable(w, r.ground, b.x, b.y) || b.covers.some((c) => !room(c))) throw new Error(`beacon ${b.beaconId}: unknown room or not walkable`);
	}
	for (const p of Object.keys(w.fire.fuel)) if (!w.prototypes.some((q) => q.key === p)) throw new Error(`fire fuel: unknown prototype ${p}`);
	for (const f of w.flood.rooms) if (!room(f.room)) throw new Error(`flood: unknown room ${f.room}`);
	for (const p of w.flood.protos) if (!w.prototypes.some((q) => q.key === p.proto)) throw new Error(`flood: unknown prototype ${p.proto}`);
	for (const n of w.npcs) {
		const r = room(n.room);
		if (!r || !walkable(w, r.ground, n.x, n.y)) throw new Error(`npc ${n.npcId}: unknown room or not walkable`);
		if (n.beacon && !w.beacons.some((b) => b.beaconId === n.beacon)) throw new Error(`npc ${n.npcId}: unknown beacon`);
		for (const r of [...(n.home ?? []), ...(n.route ?? []), ...(n.market ? [n.market] : [])]) if (!room(r)) throw new Error(`npc ${n.npcId}: unknown room ${r}`);
		for (const p of [...Object.keys(n.prices ?? {}), ...(n.carry ?? []).map((c) => c.proto)]) if (!w.prototypes.some((q) => q.key === p)) throw new Error(`npc ${n.npcId}: unknown prototype ${p}`);
		for (const k of n.crafts ?? []) if (!w.recipes.some((r) => r.key === k)) throw new Error(`npc ${n.npcId}: unknown recipe ${k}`);
	}
	// the overview: no two rooms on one place
	const placed = new Map<string, string>();
	for (const r of w.rooms) if (r.map) {
		const k = `${r.map.x},${r.map.y}`;
		if (placed.has(k)) throw new Error(`rooms ${placed.get(k)} and ${r.roomId} on one place of the overview`);
		placed.set(k, r.roomId);
	}
	const proto = (k: string, what: string) => { if (!w.prototypes.some((q) => q.key === k)) throw new Error(`${what}: unknown prototype ${k}`); };
	proto(w.currency, "currency");
	for (const r of [...w.market.rooms, ...w.orders.rooms, ...w.orders.kinds.flatMap((k) => k.rooms ?? [])]) if (!room(r)) throw new Error(`market or order board: unknown room ${r}`);
	for (const p of [...w.flood.rooms.flatMap((r) => r.protos ?? []), ...(w.storm?.protos ?? [])]) proto(p.proto, "flood or storm");
	for (const r of w.storm?.rooms ?? []) if (!room(r)) throw new Error(`storm: unknown room ${r}`);
	for (const r of w.recipes) {
		r.needs.forEach((n) => proto(n.proto, `recipe ${r.key}`)); proto(r.makes, `recipe ${r.key}`); if (r.tool) proto(r.tool, `recipe ${r.key}`);
		if (r.at && !w.building?.plans.some((p) => p.key === r.at)) throw new Error(`recipe ${r.key}: unknown plan ${r.at}`);
	}
	if (w.mill) {
		if (!w.building?.plans.some((p) => p.key === w.mill!.plan)) throw new Error(`mill: unknown plan ${w.mill.plan}`);
		for (const g of w.mill.grinds) { proto(g.from, "mill"); proto(g.to, "mill"); }
	}
	for (const p of w.building?.plans ?? []) if (p.epoch !== undefined && (!w.epochs || p.epoch < 1 || p.epoch > w.epochs.names.length)) throw new Error(`plan ${p.key}: no epoch ${p.epoch}`);
	if (w.wild) {
		const wd = w.wild;
		for (const n of [...wd.fence, ...(wd.fieldFence ?? []), ...(wd.coopFence ?? [])]) proto(n.proto, "fence");
		for (const p of wd.prey ?? []) {
			[...(p.eats ?? []), ...(p.trap ? [p.trap] : [])].forEach((x) => proto(x, `wild ${p.key}`));
			for (const h of p.houses ?? []) if (!w.animals?.houses[h]) throw new Error(`wild ${p.key}: no animal house ${h}`);
		}
		for (const k of wd.keepers ?? []) [k.proto, ...k.feed].forEach((x) => proto(x, `keeper ${k.key}`));
		for (const g of wd.guards ?? []) if (!w.animals?.kinds.some((k) => k.key === g.by) && !wd.keepers?.some((k) => k.key === g.by)) throw new Error(`wild guard: unknown animal ${g.by}`);
	}
	for (const k of w.animals?.kinds ?? []) {
		[k.proto, k.yields, ...k.feed].forEach((p) => proto(p, `animal ${k.key}`));
		if (!w.animals!.houses[k.plan] || !w.building?.plans.some((p) => p.key === k.plan)) throw new Error(`animal ${k.key}: no house ${k.plan}`);
	}
	for (const k of w.orders.kinds) { k.needs.forEach((n) => proto(n.proto, `order ${k.key}`)); proto(k.reward.proto, `order ${k.key}`); }
	for (const o of w.objects) {
		const r = room(o.room);
		if (!r || !walkable(w, r.ground, o.x, o.y) || !w.prototypes.some((p) => p.key === o.proto)) throw new Error(`object ${o.itemId}: unknown room or prototype, or not on a walkable cell`);
	}
	return w;
}

/** A world's asset file (png or md below worlds/<id>/assets), or null for anything else. */
export function worldAsset(id: string, path: string): { body: Buffer; type: string } | null {
	if (!WORLD_ID.test(id) || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|md)$/.test(path)) return null;
	try { return { body: readFileSync(join(ROOT, "worlds", id, "assets", path)), type: path.endsWith(".png") ? "image/png" : "text/markdown; charset=utf-8" }; }
	catch { return null; }
}

export const walkable = (w: WorldDef, ground: string[], x: number, y: number): boolean =>
	Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < ground.length && x >= 0 && x < (ground[0]?.length ?? 0) && !!w.tiles[ground[y]![x]!]?.walk;

/** The shortest walk from one cell to another over walkable cells (4 directions) that are not `blocked` ("x,y"), at
 *  most `max` steps; null when there is none. The cells after the start, the target last. */
export function findPath(w: WorldDef, ground: string[], from: { x: number; y: number }, to: { x: number; y: number }, max = 40, blocked: ReadonlySet<string> = new Set()): Array<{ x: number; y: number }> | null {
	if (!walkable(w, ground, to.x, to.y) || blocked.has(`${to.x},${to.y}`)) return null;
	if (from.x === to.x && from.y === to.y) return [];
	const width = ground[0]!.length, key = (x: number, y: number) => y * width + x;
	const prev = new Map<number, number>([[key(from.x, from.y), -1]]);
	let frontier = [from];
	for (let step = 0; step < max && frontier.length; step++) {
		const next: Array<{ x: number; y: number }> = [];
		for (const c of frontier) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const x = c.x + dx, y = c.y + dy, k = key(x, y);
			if (prev.has(k) || !walkable(w, ground, x, y) || blocked.has(`${x},${y}`)) continue;
			prev.set(k, key(c.x, c.y));
			if (x === to.x && y === to.y) {
				const path: Array<{ x: number; y: number }> = [];
				for (let at = k; at !== key(from.x, from.y); at = prev.get(at)!) path.unshift({ x: at % width, y: Math.floor(at / width) });
				return path;
			}
			next.push({ x, y });
		}
		frontier = next;
	}
	return null;
}

/** The name of the first exit on the shortest way from one room to another (over the world's exits), or null. */
export function wayTo(w: WorldDef, from: string, to: string): string | null {
	if (from === to) return null;
	const first = new Map<string, string>([[from, ""]]);
	let frontier = [from];
	while (frontier.length) {
		const next: string[] = [];
		for (const r of frontier) for (const e of w.exits.filter((x) => x.room === r)) {
			if (first.has(e.destination)) continue;
			first.set(e.destination, first.get(r) || e.name);
			if (e.destination === to) return first.get(to)!;
			next.push(e.destination);
		}
		frontier = next;
	}
	return null;
}
