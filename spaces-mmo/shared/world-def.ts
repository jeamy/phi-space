// The world definition, what a world brings (worlds/<id>/world.json): rooms, tiles, skins, prototypes, help and the numbers
// of its rules. Its types, shared by the engine and the browser (docs/rust-portierung.en.md, R8.0 items 1 and 3).
import type { BeaconFields, ExitFields, HelpEntryFields, PrototypeFields, SceneryFields } from "./model.ts";

/** A 32×32 cut of a sheet (pixel offsets); `walk`: characters may stand on it. `auto`: drawn as an autotile (RPG Maker
 *  VX layout, 2×3 tiles per block, composed from quarter tiles by its neighbours), one block per animation frame;
 *  `x`/`y` stay the flat fallback. */
export type TileDef = { sheet: string; x: number; y: number; walk: boolean; auto?: { blocks: Array<{ x: number; y: number }>; frameMs: number } };
/** Something drawn over a ground tile (a flower, a bush, a small tree): a `w`×`h` cut of a sheet, standing on the bottom of
 *  its cell (taller cuts reach into the cell above), optionally tinted; `upright` ones stand among the figures (one behind
 *  it is hidden), the others lie flat under things and figures. Only for the eye: it changes no rule. */
export type DecorDef = { sheet: string; x: number; y: number; w: number; h: number; tint?: number; upright?: boolean; /** the 3D map's model instead of the picture (client/props3d.ts) */ model?: "tree" | "conifer" | "bush" | "berrybush" | "flower" | "herb" | "grass" | "fern" };
/** A character sheet: 4 frames per row, rows down, left, right, up. */
export type SkinDef = { sheet: string; frameW: number; frameH: number };
/** `map`: where the room lies on the overview of the world (one unit per room; rooms of one island side by side),
 *  `island`: the island it belongs to (the overview groups and names them). */
/** `decor`: the same grid as `ground`, a key of the world's `decor` or a space per cell. */
export type RoomDef = { roomId: string; name: string; desc: string; ground: string[]; decor?: string[]; spawn: { x: number; y: number }; map?: { x: number; y: number }; island?: string };
export type ExitDef = Omit<ExitFields, "location" | "locks"> & { room: string; locks?: string };
/** An item the world places once: spawned only while no item with its itemId exists anywhere. */
export type PlacedDef = { itemId: string; proto: string; room: string; x: number; y: number };
export type SceneryDef = Omit<SceneryFields, "left">;
/** Festivals at the plan `plan` (engine/commands/festival.ts): each lasts `showWorldMs`, the settlement then rests `restWorldMs`, the winner gets `prize` coins. A figure tends once per `careWorldMs` and counts in the rank for `tendedWorldMs` after. */
export type FestivalDef = { /** A regatta starts at this plan, not at `plan`. */ regatta?: string; plan: string; showWorldMs: number; restWorldMs: number; prize: number; careWorldMs: number; tendedWorldMs: number };

export type WorldDef = {
	id: string; title: string; tileSize: number; tiles: Record<string, TileDef>; skins: SkinDef[]; rooms: RoomDef[]; start: string; guestName: string;
	/** What a room's `decor` grid names (plants and the like). */
	decor?: Record<string, DecorDef>;
	/** Raised when the definition changes: a world worker loads a newer version (rooms, exits, prototypes, help). */
	version: number;
	/** The hour of day 0 a new world's clock starts at (default 8; docs/weltzeit.en.md). */
	startHour?: number;
	/** A daily `evening` event at this world hour (docs/weltzeit.en.md): the schedule is made with the world. */
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
	/** What stands in the rooms besides plants (commands/scenery.ts). */
	scenery?: SceneryDef[];
	/** What a piece of scenery is, by its name. */ sceneryAbout?: Record<string, string>;
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
	/** What a figure carries (engine/pack.ts): `max` load where the setting `pack.max` does not answer, `load` by
	 *  prototype (1 where it names none; the currency weighs nothing). Without it a pack has no limit. A chest then
	 *  has no limit (only the pack has one). */
	pack?: { max: number; load: Record<string, number>; /** Things that raise what a figure carries while it carries one (each kind once): a leather bag. */ bags?: Record<string, number> };
	/** Where market boards stand (each its own listings) and how long a listing stays. */
	market: { rooms: string[]; listMs: number };
	/** Recipes: what goes in (used up), which tool is needed (it wears by one), what comes out (`count` of it, one without);
	 *  `at`: only beside a building of that plan (the bakery's oven). */
	recipes: Array<{ key: string; name: string; needs: Array<{ proto: string; count: number }>; tool?: string; makes: string; count?: number; at?: string }>;
	/** The order board: jobs the world posts (up to `max` open), each lasting `leaseMs` once posted. */
	orders: { rooms: string[]; max: number; everyMs: number; leaseMs: number; kinds: Array<{ key: string; text: string; needs: Array<{ proto: string; count: number }>; reward: { proto: string; count: number }; rooms?: string[] }> };
	/** What can be built (docs/siedeln.en.md): plans and the rules of building. Without it nothing can be built. */
	building?: BuildingDef;
	/** Gardens (docs/siedeln.en.md "Gärten"): beds, what grows in them and how. Without it nothing is planted. */
	garden?: GardenDef;
	/** Trees (docs/siedeln.en.md "Bäume"): planted in the light with a spade, grown over days, felled with an axe for
	 *  logs, picked for fruit. Without it nothing but the scenery's trees stands. */
	trees?: TreesDef;
	wild?: WildDef;
	/** The epochs of an island (docs/siedeln.en.md "Epochen"): their names from the first on (`a`: with the article, "ein
	 *  Dorf"), and how often the count runs. The thresholds are settings (epoch.dorf, epoch.stadt, epoch.netz). */
	epochs?: { names: string[]; a: string[]; checkWorldMs: number };
	/** The settlers (docs/siedeln.en.md "Wenige Spieler"): what share of a fire's light they leave free for people, and how
	 *  many beds each digs. How many play at once is the setting settlers.min, less the people online. */
	settlers?: { reserve: number; maxBeds: number };
	/** A settlement needs `huts` buildings of the plan `plan` of at least `owners` owners in one room. */
	settlement?: { plan: string; huts: number; owners: number };
	/** Fields (docs/siedeln.en.md "Äcker und Getreide"): one crop on a larger area, sown and brought in by many hands. */
	fields?: FieldDef;
	/** The windmill (docs/siedeln.en.md "Warenketten"): grain brought to it becomes flour in its own time. */
	mill?: MillDef;
	/** A quarry: `plan` beside one, with `tool`, a work gives `count` of `makes` and a rest (docs/siedeln.en.md "Stoffe"). */
	quarry?: { plan: string; tool: string; makes: string; count: number };
	/** The salt garden (engine/commands/quarry.ts `harke`): beside a building of `plan`, `count` of `makes` as work, without a tool. */
	salt?: { plan: string; makes: string; count: number };
	/** A clay pit, the same with a spade. */
	clay?: { plan: string; tool: string; makes: string; count: number };
	/** Town halls: `plan`, and how long a motion is open. */
	townhall?: { plan: string; voteWorldMs: number; zoneRadius: number; maxTax: number };
	/** Chapels: `plan`, what may be offered, and how long a blessing lasts. */
	chapel?: { plan: string; offerings: string[]; blessWorldMs: number };
	/** Wind (engine/commands/wind.ts): each `stepMs` an island's level moves a step; `names` by level, the last a gale, `mill` how fast a mill grinds at it. */
	wind?: { stepMs: number; names: string[]; mill: number[] };
	/** Rooms grow (engine/commands/growth.ts): by `strip` cells of `tile` once `fullShare` of the land is taken, up to `maxW`×`maxH`. */
	growth?: { strip: number; fullShare: number; maxW: number; maxH: number; tile: string };
	/** Food (engine/commands/food.ts): how long each thing keeps a figure sated, up to `maxWorldMs` ahead; sated, the rest after work is divided by `restFactor`. */
	food?: { foods: Record<string, number>; maxWorldMs: number; restFactor: number; /** A table in the chest of the building one eats in: what one eats there sates `factor` times as long. */ table?: { proto: string; factor: number } };
	/** Things that keep others fresh in a building's chest (sweep.ts turnItem): when a thing of `keeps` would turn there
	 *  beside one of `proto`, it turns `factor` times as late instead, once (a barrel for juice, soup and meat, a crate for fruit). */
	keeps?: Array<{ proto: string; keeps: string[]; factor: number }>;
	/** Fishing (engine/commands/fishing.ts): beside `plan`, with a `net`, a weighted catch. */
	fishing?: { plan: string; net: string; catch: Array<{ proto: string; weight: number }> };
	/** A department store (engine/commands/shop.ts): the things it deals in by base price; its price runs from twice that on an empty shelf to half at `full`, it pays `buyShare` of it, and `turnoverPerPoint` coins turned over are a point of rank. */
	shop?: { plan: string; prices: Record<string, number>; full: number; buyShare: number; turnoverPerPoint: number; /** Delivery orders a store keeps open at once, and pieces in one (`laden bestelle`). */ orders: number; orderMax: number };
	/** A counting house: a loan is up to `pledgeShare` of the pledge's base price, runs `termWorldMs` of the second clock, at `interest`. */
	bank?: { plan: string; pledgeShare: number; termWorldMs: number; interest: number; /** The bill of exchange (shop.ts `wechsel`): a thing of `proto` that holds up to `max` coins (they lie at it), written for `fee` coins to the house. */ note?: { proto: string; max: number; fee: number } };
	/** A rowing boat (engine/commands/fishing.ts) goes between the jetties of an island; `sand` is dug with `tool` on `tile`. */
	boat?: { proto: string; sail?: string; /** How many things the hatch of each boat holds (`luke`, fishing.ts). */ hatch?: Record<string, number> };
	sand?: { tool: string; makes: string; count: number; tile: string };
	/** Roads and carts (engine/commands/cart.ts, road.ts): `road` the key of a road (and of the single road cells of old, which the sweep takes away), `proto` the cart as a thing, `capacity` its cargo, `hopWorldMs` a room of its way. */
	cart?: { road: string; proto: string; capacity: number; hopWorldMs: number;
		/** A planned road (engine/commands/road.ts): from `epoch`, `stonePer` cells take one `stone`, plus `wood` of `woodProto`;
		 *  `workPer` cells one work (at least `minWork`); the vote lasts `voteWorldMs`, the building `siteWorldMs`, the road `keepWorldMs`
		 *  (the setting `keepSetting` when set); `repair` mends it; `points` it adds to its island's stock. */
		route?: { epoch: number; stone: string; stonePer: number; woodProto: string; wood: number; workPer: number; minWork: number; voteWorldMs: number; siteWorldMs: number; keepWorldMs: number; keepSetting?: string; repair: Array<{ proto: string; count: number }>; points: number } };
	/** The large ship (engine/liner.ts, engine/commands/fishing.ts): one ship sails a loop over the bays of all islands, lies `stayWorldMs` in each and takes `unitWorldMs` per map cell between two; ferries stay on demand. */
	liner?: { fare: number; stayWorldMs: number; unitWorldMs: number };
	/** The island railway (engine/commands/cart.ts): between the buildings of `plan` on an island, for `fare` coins. */
	rail?: { plan: string; fare: number; /** The timetable: the train stands at every station for the first half of each period (engine/rail.ts trainIn). */ everyWorldMs?: number; /** Freight: things at most per load (for one fare), and how long they wait at the station in world time. */ freight?: { capacity: number; keepWorldMs: number } };
	festival?: FestivalDef;
	/** Animals on the farm (docs/siedeln.en.md "Tiere auf dem Hof"): kept in a building of their plan, fed, giving yields. */
	animals?: AnimalsDef;
	/** How the world splits into region spaces when SPACES_MMO_REGIONS names them (engine/regions.ts); without it the
	 *  whole world is one space. */
	regions?: RegionDef[];
	/** Set on the part of the world one region runs (regionWorld): its id and every room of the whole world. */
	region?: string;
	allRooms?: RoomDef[];
	/** In a region: every fire of the whole world (where one can beam to, also in another region). */
	allBeacons?: WorldDef["beacons"];
};
/** A plan (docs/siedeln.en.md, "Was man baut"): its footprint `w`×`h`, what it needs delivered, the work points, what it
 *  counts towards the epoch and takes of a fire's light (`points`), how long it stands without repair. */
/** `chest`: how many things its chest holds (none without; no limit where the world has `pack`, engine/pack.ts); `repair`: what a repair costs (it then stands `keepWorldMs` again). */
/** `dative`: the plan with its article as one says "neben einer Hütte" (default "einem <name>"). `epoch`: the island's
 *  epoch from which a new one may be staked out (default 1; docs/siedeln.en.md "Epochen"). */
/** `sparesTools`: a recipe made beside it wears a tool half as fast. */
/** A building's inside (docs/innenraeume.en.md): its ground (the world's tiles, `#` walls and `_` floor in Leuchtfeuer), where one
 *  arrives coming in (`spawn`), the door cell inside that leads out, and its furnishings: fixed pieces, each with what it is
 *  for (`use`: the hearth cooks the building's recipes, the chest is the building's chest, the bed is for sleep). */
export type InteriorDef = { ground: string[]; spawn: { x: number; y: number }; door: { x: number; y: number };
	furniture: Array<{ kind: string; name: string; x: number; y: number; use?: "cook" | "chest" | "sleep"; desc: string }> };
export type PlanDef = { /** Its inside, which the owner and its guests go into (`betrete`). */ interior?: InteriorDef; /** It must stand beside an exit (a road). */ atExit?: boolean; /** A room holds one of it at most, built or staked (a station). */ onePerRoom?: boolean; /** It must touch water. */ shore?: boolean; /** It lies on the water, one end at the shore (a jetty; engine/commands/build.ts waterRefusal). */ water?: boolean; /** Light points it adds to its fire (a lighthouse). */ lightBonus?: number; /** A signal fire: those in rooms one way apart form a chain, and the fires of a burning one share their light (fire.ts chainsOf). */ signal?: boolean; /** A lighthouse: its fire also covers the rooms up to this many ways from its room, on its island (fire.ts coversOf). */ lightRooms?: number; /** The admin's setting in world days that replaces `keepWorldMs` (server/settings.ts). */ keepSetting?: string; /** A green zone of a town hall admits it. */ green?: boolean; sparesTools?: boolean; store?: boolean; epoch?: number; dative?: string; key: string; name: string; aliases: string[]; w: number; h: number; needs: Array<{ proto: string; count: number }>; work: number; points: number; keepWorldMs: number; color: string; chest?: number; repair: Array<{ proto: string; count: number }> };
/** `lightPoints`: what a fire's light carries; `siteWorldMs`: how long a site waits for progress; `maxSites`: open sites per
 *  account; `maxBuildings`: buildings and sites per account where no setting `build.max<epoch>` answers (the operator's,
 *  by the epoch of the island built on); `uncounted`: plans that do not count towards it (small things, animal houses). */
/** `ruinWorldMs`: how long a ruin stays; `estateWorldMs`: how long what lay in its chest waits for its owner. */
/** A sort that grows in a bed: from seed (`seed`, a prototype) to sprout after `grow[0]`, to ripe after `grow[1]`, ripe
 *  for `ripeWorldMs`, then it wilts. A harvest gives `yields` and a seed (sometimes two). `wild`: where its seeds are found
 *  in the wild flora (rooms whose decor has flowers or herbs, on these islands; without islands everywhere). */
export type SortDef = { /** Its form on the 3D map (client/props3d.ts). */ model?: "flower" | "rose" | "mist" | "cabbage" | "carrot" | "hops"; key: string; name: string; aliases: string[]; kind: "nutz" | "zier"; seed: string; grow: [number, number]; ripeWorldMs: number; yields: { proto: string; count: number }; color: string;
	wild?: { decor: "flowers" | "herbs"; islands?: string[] } };
/** `bed`: the size of a bed, the light it takes, how long it stays without care; `spade`: the tool that digs one;
 *  `can`: a can of water (from the rain barrel, the building plan `barrel`, which holds `barrelCap` cans and gains one
 *  every `barrelFillWorldMs`, all at a storm surge on its island); `thirstWorldMs`: how long a bed's plants go
 *  without water before the next stage finds them dry and they wilt; `seedRestWorldMs`/`seedChance`: how often one
 *  looks for wild seeds and how often one finds some. `commons`: a community bed (its size and light; one per fire,
 *  not counted to anyone's beds); `crossChance`: how often a ripe flower beside another sort in a flower bed gives a
 *  seed of a crossing. */
export type GardenDef = { /** A bed this near a building of this plan grows through the winter. */ greenhouse?: { plan: string; reach: number }; bed: { w: number; h: number; points: number; keepWorldMs: number }; commons: { w: number; h: number; points: number }; crossChance: number; maxBeds: number; spade: string; can: string; barrel: string; barrelCap: number; barrelFillWorldMs: number;
	thirstWorldMs: number; seedRestWorldMs: number; seedChance: number; decor: { flowers: string[]; herbs: string[] }; sorts: SortDef[] };
/** A kind of tree: its seed (what one plants), how long its stages take (seedling to young tree, young to grown; world
 *  time times the patience, so in the second clock), what felling it gives and whether its stump sprouts again (back to a
 *  young tree), and what it bears (`crop`: every `everyWorldMs` times the patience; `seedChance`: a seed comes along).
 *  `wild`: where its seed is found by „sammle samen“ (on the cells of the trees' decor, on these islands). */
export type TreeSortDef = { key: string; name: string; /** "eine Birke", "ein Apfelbaum" */ a: string; /** "die Birke", "den Apfelbaum" (as one fells it) */ the: string; aliases: string[]; /** Its form on the 3D map (client/props3d.ts). */ model: "tree" | "conifer"; seed: string; grow: [number, number];
	fell: Array<{ proto: string; count: number }>; sprouts?: boolean; crop?: { yields: Array<{ proto: string; count: number }>; everyWorldMs: number; seedChance?: number; /** what one does to take it: picks fruit, cuts the rods */ cut?: boolean }; color: string; fruit?: string;
	wild?: { islands?: string[] } };
/** `points`: the light a tree takes, `maxTrees` per account; `spade` plants, `axe` fells (a tool that wears); `decor`:
 *  the decor cells where wild trees stand (their seeds are found there). */
export type TreesDef = { points: number; maxTrees: number; spade: string; axe: string; decor: string[]; sorts: TreeSortDef[] };
/** The wild from the fog (docs/siedeln.en.md "Wild im Nebel"), first the hares in the beds: every `checkWorldMs` a room
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
	prey?: PreyDef[]; guards?: GuardDef[]; keepers?: KeeperDef[]; fieldFence?: Array<{ proto: string; count: number }>; coopFence?: Array<{ proto: string; count: number }>;
	/** What each fence costs instead, of planks (taken when the first cost is not carried). */ fenceAlt?: Array<{ proto: string; count: number }>; fieldFenceAlt?: Array<{ proto: string; count: number }>; coopFenceAlt?: Array<{ proto: string; count: number }> };
/** A kind of wild beside the hare: `reh` grazes a growing field (each bite costs `bite` of its yield, never below `keep`),
 *  `fuchs` takes an animal from a house of `houses` (never the last), `maus` eats up to `take` of `eats` from a chest
 *  (never the last; a `trap` in the chest catches it). `nom`/`the`/`acc`/`none`: "ein Reh", "das Reh", "das Reh", "kein
 *  Reh"; `goes`: how it moves ("zieht"); `to`: where it goes, `{owner}` for the target's owner. `dayFactor`: its chance by day (the fox comes almost only at night). */
export type PreyDef = { key: "reh" | "fuchs" | "maus" | "moewe"; name: string; aliases: string[]; nom: string; the: string; acc: string; none: string; goes: string; to: string; icon: string;
	chance: [number, number, number, number]; nightFactor: number; dayFactor?: number; eatAfterWorldMs: number;
	bite?: number; keep?: number; houses?: string[]; eats?: string[]; take?: number; trap?: string };
/** `by`: a herd kind or a keeper kind; fed, it keeps `kinds` from its room, and says `says` when one comes. */
export type GuardDef = { by: string; kinds: string[]; says: string };
/** A dog or cat: the prototype it is as a thing, what it eats (one thing keeps it fed `AnimalsDef.feedWorldMs`). */
export type KeeperDef = { key: string; proto: string; name: string; the: string; acc: string; none: string; feed: string[] };
/** A crop of a field: its seed (a prototype, for grain the grain itself), the `group` it rotates in (the same group
 *  twice in a row tires the soil), how long it grows once sown, what each cell gives (some of it the next seed), its
 *  colour when ripe, and where its seed is found in the wild flora (like a garden sort's). */
export type CropDef = { /** Its form on the 3D map (client/props3d.ts). */ model?: "grain" | "tuber" | "beet" | "flax"; key: string; name: string; aliases: string[]; group: string; seed: string; growWorldMs: number; yields: Array<{ proto: string; perCell: number }>; color: string; wild?: SortDef["wild"] };
/** A field of `w`×`h` cells takes `points` of a fire's light, at most `maxFields` per account, and goes back to grass
 *  after `keepWorldMs` without work. Sowing takes a seed per `seedPerCells` cells and a work point per `sowPerCells`,
 *  the harvest a work point per `harvestPerCells` (the same rest as on a site). It is ripe for `windowWorldMs`; after
 *  that each share loses `lateLoss` to the field for another window, then the crop is lost. `tired`: the yield's
 *  factor by how often its crop's group came before it in a row (rest for `fallowWorldMs` heals the soil). */
export type FieldDef = { epoch?: number; w: number; h: number; points: number; maxFields: number; keepWorldMs: number; seedPerCells: number; sowPerCells: number; harvestPerCells: number;
	windowWorldMs: number; lateLoss: number; tired: number[]; fallowWorldMs: number; crops: CropDef[]; /** Fertiliser (`dünge`, engine/commands/field.ts): `count` of `proto` on a growing field raises its harvest by `factor`, once a crop. */ dung?: { proto: string; count: number; factor: number } };
/** The mill is the building plan `plan`; it grinds one unit of grain (`grinds`: what becomes what) per `unitWorldMs`, one
 *  load after the other, at most `maxLoad` units a load and `maxLoads` waiting loads per figure; a storm surge on its
 *  island grinds `stormWorldMs` ahead. Flour nobody fetches goes after `keepWorldMs`. */
export type MillDef = { plan: string; grinds: Array<{ from: string; to: string }>; unitWorldMs: number; maxLoad: number; maxLoads: number; stormWorldMs: number; keepWorldMs: number };
/** A kind of animal: the prototype it is as a thing (bought, carried, put in), the plan that houses it, what one gives
 *  every `everyWorldMs` while fed (`yields`, a prototype), what it eats, and how often two fed ones get a young one. */
export type AnimalKindDef = { /** One of this for every `per` yields, as it comes. */ also?: { proto: string; per: number }; /** From this epoch of the island on. */ epoch?: number; key: string; proto: string; name: string; plural: string; plan: string; yields: string; everyWorldMs: number; feed: string[]; breedWorldMs: number; /** What `schlachte` gives of one (engine/commands/animals.ts); none: it is not slaughtered. */ slaughter?: Array<{ proto: string; count: number }>; /** A young one of the kind (a chick, a piglet): it goes into the house like the kind, and grows up there (PrototypeFields.turns); until then it gives nothing. */ young?: string };
/** `houses`: how many a building of each plan holds (one kind at a time); one thing of feed keeps one animal fed for
 *  `feedWorldMs`, up to `fedMaxWorldMs` ahead; yields wait in the house, at most `nestMax` per animal. */
export type AnimalsDef = { /** Buildings of `houses` one account may own where the operator's setting `animals.houses` does not answer. */ maxHouses?: number; kinds: AnimalKindDef[]; houses: Record<string, number>; /** Slaughtering (`schlachte`): the tools it takes, the best first (worn by one each time), how many of a kind stay in the house, and a building of `shop`'s plan in the room that gives `bonus` more of the first thing an animal gives (the butcher's shop). */ butcher?: { tools: string[]; keep: number; shop?: { plan: string; bonus: number } }; feedWorldMs: number; fedMaxWorldMs: number; nestMax: number };
/** `store` (a plan whose chest a settlement shares, docs/siedeln.en.md "Siedlungen und Besitz"): `quota`: how many things a rank
 *  may take per world day; `logKeepMs`: how long a line of the log stays (real time, it must outlast the quota's day);
 *  `logShow`: how many lines `lager log` shows. */
export type StoreDef = { quota: { fremder: number; helfer: number; siedler: number }; logKeepMs: number; logShow: number };
export type BuildingDef = { /** Shutters in a building's chest (build.ts buildSweep): when its term runs out they are used up and it stands `share` of its term again. */ shutters?: { proto: string; share: number }; store?: StoreDef; plans: PlanDef[]; lightPoints: number; /** What each epoch of the fire's island above the first adds to its light (the setting light.epoch overrides it). */ lightPerEpoch?: number; /** `perPlayer` more points for each registered player who built here within `activeMs` (of the second clock), up to `max` in all. */ lightGrowth?: { perPlayer: number; max: number; activeMs: number }; siteWorldMs: number; maxSites: number; maxBuildings: number; uncounted?: string[]; ruinWorldMs: number; estateWorldMs: number };
export type NpcDef = {
	npcId: string; name: string; skin: number; room: string; x: number; y: number; script: string; beacon?: string;
	/** In world hours: the NPC is there from `presentFromHour` to `presentUntilHour` (over midnight too), else away. */
	plan?: { presentFromHour: number; presentUntilHour: number };
	/** A model role (docs/modell-npcs.en.md): who it is, which events wake it, its model calls per day. Without model calls
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
	/** A villager (script "dorfbewohner"): comes once a settlement of its rooms has this many times five buildings. */
	villager?: number;
};

/** A region (server/engine/regions.ts): a group of islands with a space of its own. */
export type RegionDef = {
	regionId: string;
	/** The islands (RoomDef.island) of this region. */
	islands: string[];
	/** Where a new character of this region starts (a room of the region). */
	start: string;
};
