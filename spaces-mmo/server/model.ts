// The entries of spaces-mmo (docs/evennia-abbildung.md). The world space holds the game; the accounts space only the
// credentials, the web sessions and the lock that keeps names unique. Every entry has its own id field (accountId,
// charId, …): a change is a take and a write, which gives the entry a new space id, so nothing refers to space ids.
import type { Fields } from "phi-spaces";

/** World space. `guest` accounts carry a lease (renewed on activity); registered ones live until deleted. `perms`:
 *  levels granted on top (Builder); an admin has every level. */
export type AccountFields = { accountId: string; name: string; guest: boolean; admin: boolean; createdAt: number; touchedAt: number; perms?: string[]; npc?: boolean;
	/** An NPC that plays like a person (server/npc/settlers.ts): it may build and sow like one. */
	settler?: boolean };
/** One character per account; `guest` mirrors the account so the cleanup can find orphans. A character's location is
 *  always a room (`room`); items use `location`, which may also be a character. */
/** `ack`: the last numbered step of a page this character took (client/walk.ts): the connection and its step number,
 *  written with every such step, also one that could not be taken, so the page knows which of its steps are done. */
export type CharacterFields = { charId: string; accountId: string; name: string; room: string; x: number; y: number; skin: number; guest: boolean; ack?: { conn: string; seq: number };
	/** Why the last step was not taken (engine/commands/default.ts: told once per reason); gone with the next move. */
	refused?: string };

/** How an object looks on the map until it has a sprite (no item graphics are licensed yet). */
export type Glyph = { shape: "circle" | "square" | "diamond"; color: string };
/** A thing: on the ground of a room (`location` = roomId, at x/y) or carried (`location` = charId, x/y = -1). The entry
 *  type is its typeclass, the supertypes include "Item" and "Object". */
export type ItemFields = { itemId: string; name: string; aliases: string[]; desc: string; location: string; x: number; y: number; glyph: Glyph; locks: string; proto: string; flotsam?: boolean; expiresWorldMs?: number;
	/** A tool: uses left (it breaks at 0). */ wear?: number;
	/** On the market board: `location` is "market", these name the listing and who gets it back. */ listing?: string; seller?: string;
	/** A bred sort (garden.ts): seeds and flowers of a crossing carry it, so it travels with them to other regions. */ variety?: Variety };
/** A crossing of two sorts in a flower bed (docs/siedeln.md "Vermehren und züchten"): its own colour and its breeder;
 *  `name` stays empty until the breeder names it (`benenne`). The thing keeps the prototype of the sort it grew from. */
export type Variety = { id: string; name: string; color: string; breeder: string; breederName: string };
/** A name given to a variety, `unique` on `nameKey` within its region's space. */
export type VarietyFields = { varietyId: string; name: string; nameKey: string; sort: string; color: string; breeder: string; breederName: string; at: number };
/** A way out of a room, on a cell of it; stepping on the cell or `go <name>` leads to `destination`, arriving at `arrive`. */
export type ExitFields = { exitId: string; name: string; aliases: string[]; desc: string; location: string; destination: string; x: number; y: number; arrive: { x: number; y: number }; locks: string; fogMax?: number };
/** A label on an object (Tags cannot be array fields: templates match whole values). */
export type TagFields = { target: string; key: string; category: string };
/** A template to spawn items from; `parent` names the prototype whose fields it extends. */
/** `icon`: a picture of the thing, a 32×32 PNG below the world's assets (e.g. "items/tang.png"); without one the map
 *  draws its glyph. */
export type PrototypeFields = { key: string; parent: string | null; typeclass: string; name: string; desc: string; aliases: string[]; glyph: Glyph; locks: string; wear?: number; icon?: string };
/** A beacon: where a fire can burn. It is also the lock every change of its fire takes (feeding, the fire tick), so
 *  two players feeding at once cannot light two flames. `lit` is what the fire tick last saw. */
export type BeaconFields = { beaconId: string; name: string; aliases: string[]; room: string; x: number; y: number; covers: string[]; lit: boolean };
/** A fire: it burns while the world time is before `until` (world milliseconds, docs/weltzeit.md); it stays as an entry
 *  when it has gone out, and the clock decides. `litAt`: since when it burns, in world time. */
export type FlameFields = { beaconId: string; until: number; litAt: number };
/** What a character has put into a beacon (its reputation there). */
export type ContributionFields = { beaconId: string; charId: string; name: string; pieces: number; ms: number };
/** The fog of a room, 0 (clear) to the world's maximum; the fog tick raises it without fire and lowers it with fire. */
export type FogFields = { room: string; level: number };
/** An island's epoch (engine/commands/epoch.ts): written by the count only when it changes; none means the first.
 *  `points`: the held stock it was reached with. */
/** A settlement (engine/commands/settlement.ts), one per room: `members` lists who was taken in (hut owners are settlers
 *  without it), `closed`: the ranks count. */
export type SettlementMember = { accountId: string; name: string; rank: "helfer" | "siedler" };
export type SettlementFields = { settlementId: string; name: string; nameKey: string; room: string; founder: string; founderName: string; members: SettlementMember[]; closed: boolean; at: number };
export type EpochFields = { island: string; epoch: number; points: number; at: number };
/** A recurring job (Evennia's Script/TickerHandler): due at `due`; the world worker that takes it runs it once. */
/** The world's clock (docs/weltzeit.md), one entry per world: the world time is `worldAnchorMs + (now - realAnchorMs) * rate`
 *  (unless `paused`). A change takes the entry and writes it again with both anchors moved to the moment of the change. */
export type WorldClockFields = { worldId: string; epoch: number; realAnchorMs: number; worldAnchorMs: number; rate: number; paused: boolean; version: number };
/** A date in world time (docs/weltzeit.md): fires once when the world time reaches `dueWorldMs`. `kind` names the handler
 *  (server/engine/worldevents.ts); `scheduleId` is the deterministic key (one entry per id). `missed`: what a late one does
 *  (the clock was behind: a restart, a pause): `once` runs it, `coalesce` runs it once and goes on from now; a later
 *  `replay-bounded` is not implemented. */
export type WorldScheduleFields = { scheduleId: string; clockEpoch: number; dueWorldMs: number; kind: string; payload: Record<string, unknown>; missed: "once" | "coalesce" | "replay-bounded" };
/** What a schedule leaves for the processes that watch the world: one entry per `eventId` (`evening:e1:d183`), so a day's
 *  event exists once however many workers run the schedule. It lapses (real time) after a few minutes. */
export type WorldEventFields = { eventId: string; kind: string; worldMs: number; epoch: number; day: number };
/** A direct trade: `from` offers the items `give` (still in its pack until accepted) to `to`, for `want` (names and
 *  counts, taken from `to`'s pack on accept). Accepting moves all of it in one transaction or nothing. */
export type OfferFields = { offerId: string; from: string; fromName: string; to: string; toName: string; give: string[]; giveNames: string[]; want: Array<{ name: string; count: number }>; room: string; at: number };
/** A listing on the market board: the item waits in escrow (location "market") until bought, withdrawn or the lease
 *  ends (then the market ticker gives it back). Prices are counted in coins (prototype `currency` of the world). */
export type ListingFields = { listingId: string; seller: string; sellerName: string; itemId: string; itemName: string; price: number; room: string; at: number; expiresWorldMs?: number };
/** A job on the order board (master–worker): posted by the world, taken by one player, delivered for a reward. */
export type OrderFields = { orderId: string; kind: string; text: string; needs: Array<{ proto: string; count: number }>; reward: { proto: string; count: number }; takenBy: string; room: string; expiresWorldMs?: number };
/** A help topic of the world. */
export type HelpEntryFields = { key: string; category: string; text: string };
/** Which version of a world's definition the space holds (written by the loader). */
export type WorldLoadedFields = { worldId: string; version: number; at: number };
/** A room of the loaded world: its grid of tile keys, one string per row. */
export type RoomFields = { roomId: string; name: string; desc: string; ground: string[]; decor?: string[]; spawn?: { x: number; y: number }; map?: { x: number; y: number }; island?: string };
/** A character being played right now: held by the web process with a short lease while the WebSocket is open. */
export type SessionFields = { sessionId: string; charId: string; accountId: string };
/** One command line, written by the web process (or later an NPC), taken by a world worker. */
/** `step`: a numbered step of a page (its connection and number), acknowledged on the character. */
export type IntentFields = { intentId: string; charId: string; line: string; at: number; asked?: string; step?: { conn: string; seq: number } };
/** A sentence no rule understood, for the model process to turn into a command (an Intent with `asked`). */
/** A line for the model to read; `why`: why the command itself refused it, said when the model cannot read it either. */
export type TranslateFields = { reqId: string; charId: string; accountId: string; guest: boolean; line: string; room: string; at: number; why?: string };
/** Output: to one character (`to` = its charId), to everyone in `room` (`to` = "*"), or to everyone on a channel
 *  (`to` = "#hafen"). With `actor` (a charId) the text
 *  holds FuncParser calls ($you(), $conj(a|b)) that the gateway renders for each reader. */
/** `fromId`: the speaker's charId (NPCs start with "npc-"), so model NPCs answer people, not each other. */
export type MsgFields = { room: string; to: string; kind: MsgKind; text: string; from: string; at: number; actor?: string; fromId?: string; help?: HelpView };
/** The answer of `help` in parts, for the page's command window (the text stays for the log and text mode): the intro,
 *  the commands (every name, the arguments, what it does), the topics, or one topic. */
export type HelpView = { intro?: string; commands?: Array<{ names: string[]; usage: string; text: string }>; topics?: string[]; topic?: { key: string; category: string; text: string } };
export type MsgKind = "say" | "emote" | "system" | "look" | "error" | "help" | "who" | "info" | "channel" | "world";

/** Accounts space. `key` is the lower-cased name; a `pending` credential belongs to a registration in progress. */
export type CredentialFields = { key: string; name: string; accountId: string; salt: string; hash: string; state: "pending" | "active" };
/** A web login: `key` is the SHA-256 of the cookie value (the cookie itself is never stored). */
export type WebSessionFields = { key: string; accountId: string; at: number };
/** The one lock entry every registration takes (in a transaction) while it checks and claims a name. */
export const NAMES_LOCK = { type: "Lock", fields: { name: "names" } } as const;
/** World space: one token per character. A world worker takes it (in the command's transaction) before it takes the
 *  character's oldest intent and writes it back on commit, so one character's commands run one after another, in
 *  order, while other characters' commands run in parallel on other workers. */
export const actorToken = (charId: string) => ({ type: "ActorToken", fields: { charId } });
/** World space: the cell a character stands on while it is online (engine/occupancy.ts). Written with the space's
 *  `unique` check on room and cell, so two characters never hold one cell, without a lock on the room. */
export type SpotFields = { room: string; x: number; y: number; charId: string; name: string };
/** World space: the lock a world worker takes while it loads the world definition, so two loading at once cannot
 *  both spawn the placed items. */
export const WORLD_LOCK = { type: "Lock", fields: { name: "world" } } as const;
/** World space: the lock under which an npc process claims a role (so two processes never play one) and under which
 *  an NPC is woken (so no more than SPACES_MMO_NPC_MAX are awake). */
export const NPC_LOCK = { type: "Lock", fields: { name: "npc" } } as const;
/** An npc process plays this role while the lease lives. */
export type NpcOwnerFields = { npcId: string; owner: string };
/** A model NPC is awake (answers with the model) while this lives; its lease is renewed whenever it is spoken to. */
/** A model role that is awake until a world time (docs/weltzeit.md); the sweep removes it when that has passed. */
export type NpcAwakeFields = { npcId: string; since: number; untilWorldMs: number };
/** What a model NPC remembers (≤ 4 KiB), written by itself with NOTE lines. */
export type NpcMemoryFields = { npcId: string; text: string };

/** Building (docs/siedeln.md): a site where people deliver and work until its plan is done. `buildId` stays the same
 *  when the site becomes a building. `needs`: per prototype what the plan asks and what was delivered; `work`/`workNeed`
 *  the work points; `human`/`other`: what people and what NPCs or automata gave (at most half may come from others).
 *  `beaconId`: the fire whose light it uses (engine/build.ts). The site lapses at `untilWorldMs` without progress. */
export type SiteFields = { buildId: string; plan: string; name: string; room: string; x: number; y: number; w: number; h: number; owner: string; ownerName: string; accountId: string;
	needs: Array<{ proto: string; name: string; count: number; have: number }>; work: number; workNeed: number; human: number; other: number; beaconId: string; points: number; by: Record<string, number>; untilWorldMs: number; at: number };
/** A finished building; it stands while it is kept (`untilWorldMs`, renewed by repairs). `by`: who built it, with what they gave. */
export type BuildingFields = { buildId: string; plan: string; name: string; room: string; x: number; y: number; w: number; h: number; owner: string; ownerName: string; accountId: string; beaconId: string; points: number; by: Record<string, number>; untilWorldMs: number; builtAt: number;
	/** A rain barrel's cans at `waterAtWorldMs`; it gains one every so often (engine/commands/garden.ts barrelWater). */
	water?: number; waterAtWorldMs?: number;
	/** A mill's: when the last load waiting is ground (engine/commands/mill.ts); a new load starts there. */
	busyUntilWorldMs?: number;
	/** A coop's or pen's herd (engine/commands/animals.ts): the animals lie in it as things (location: the buildId); here
	 *  their kind, how long they are fed, and since `atWorldMs` what they gave (`goods`) and how near a young one is
	 *  (`bred`), both counted on when the herd is next touched. */
	herd?: HerdFields;
	/** A dog or cat left here as a guard (engine/commands/animals.ts; it lies in it as a thing, like a herd): its kind and
	 *  how long it is fed. `fenced`: a coop with a fence round it (the foxes do not get in). */
	keeper?: { kind: string; fedUntilWorldMs: number }; fenced?: boolean };
export type HerdFields = { kind: string; fedUntilWorldMs: number; atWorldMs: number; goods: number; bred: number };
/** A load of grain at a mill (`buildId`, its place kept so it is found when the mill is gone): `count` of `from`, ground
 *  to `to` at `readyWorldMs` for the figure that brought it. A load whose mill fell before it was ground gives its grain
 *  back (`to` = `from`). It goes, unfetched, at `untilWorldMs`. */
export type MillLoadFields = { loadId: string; buildId: string; room: string; x: number; y: number; w: number; h: number; charId: string; name: string; from: string; to: string; count: number; readyWorldMs: number; untilWorldMs: number };
/** A plant in a bed, at a cell of it: its sort, its stage (0 seed, 1 sprout, 2 ripe, 3 wilted) and when the next is due. */
export type BedPlant = { x: number; y: number; sort: string; stage: 0 | 1 | 2 | 3; dueWorldMs: number; variety?: Variety };
/** A bed (docs/siedeln.md "Gärten"): cells like a building's (Plot entries), its plants inside it, so a stage change or
 *  a watering is one write of the bed whatever grows in it. `dueWorldMs`: the earliest date of its plants (the garden
 *  tick looks at nothing else); `wateredWorldMs`: the last watering; `sponsors`: who may tend it besides the owner;
 *  `untilWorldMs`: a bed nobody tends goes back to grass. `kind`: a flower bed ("zier": flowers only, and only there
 *  sorts cross) or a community bed ("gemein": everyone may tend it); without one a garden bed of the owner's.
 *  `fenced`: a fence keeps the hares out (engine/commands/wild.ts). */
export type BedFields = { kind?: "zier" | "gemein"; fenced?: boolean; bedId: string; room: string; x: number; y: number; w: number; h: number; owner: string; ownerName: string; accountId: string; beaconId: string; points: number;
	sponsors: Array<{ charId: string; name: string }>; plants: BedPlant[]; wateredWorldMs: number; weedy: boolean; dueWorldMs: number; untilWorldMs: number; at: number };
/** A field (docs/siedeln.md "Äcker und Getreide", engine/commands/field.ts): one entry over its cells (Plot entries like a
 *  building's), one crop at a time. `stage`: fallow, being sown (seed and work delivered so far), growing, ripe, late
 *  (the window passed: each share loses part). `dueWorldMs`: the next stage the field tick writes (ripe, late, lost);
 *  `yields`: what the whole harvest gives (fixed when the sowing is done), handed out in shares per work point;
 *  `lastGroup`/`tired`: the crop group harvested last and how often in a row (the soil's counter); `open`: everyone may
 *  sow and harvest, not only the owner. `human`/`other`: work points by people and by NPCs or automata. */
export type FieldFields = { fieldId: string; room: string; x: number; y: number; w: number; h: number; owner: string; ownerName: string; accountId: string; beaconId: string; points: number; open?: boolean;
	stage: "brach" | "saat" | "waechst" | "reif" | "spaet"; crop: string | null; seeds: number; seedNeed: number; work: number; workNeed: number; yields: Array<{ proto: string; count: number }>; soil: number;
	by: Record<string, number>; human: number; other: number; lastGroup: string | null; tired: number; lastHarvestWorldMs: number; dueWorldMs: number; untilWorldMs: number; at: number;
	/** A fence round the field (the deer stay out); how often deer grazed the crop growing now (each bite costs yield). */
	fenced?: boolean; grazed?: number };
/** Wild from the fog at a bed, a field, a coop or a chest (engine/commands/wild.ts): it eats at `eatsAtWorldMs` unless someone scares it off
 *  before (a take of this entry: whoever comes first saves the bed). */
export type AnimalFields = { animalId: string; kind: "hase" | "reh" | "fuchs" | "maus"; name: string; room: string; x: number; y: number; bedId?: string; eatsAtWorldMs: number; at: number;
	/** What the other kinds came for: a field (reh), a coop (fuchs), a building with a chest (maus). */
	target?: string };
/** How long a figure waits before it looks for wild seeds again (the sweep removes it). */
export type SeedRestFields = { charId: string; untilWorldMs: number };
/** What is left of a building that was not kept: it still covers its cells until `untilWorldMs` (the sweep removes it). */
export type RuinFields = { buildId: string; plan: string; name: string; room: string; x: number; y: number; w: number; h: number; owner: string; ownerName: string; accountId: string; untilWorldMs: number };
/** What lay in a chest of a building that fell into ruin: its things wait (location `estateId`) for their owner until
 *  `untilWorldMs`, then they are gone. */
export type EstateFields = { estateId: string; accountId: string; ownerName: string; room: string; name: string; untilWorldMs: number };
/** One cell a site or building stands on, written with the space's `unique` check on room and cell: two never share one. */
export type PlotFields = { room: string; x: number; y: number; of: string };
/** How much of a fire's light the sites and buildings that use it take (engine/build.ts, "Lichtpunkte"). */
export type LightUseFields = { beaconId: string; used: number };
/** A character's work at a site makes it tired until `untilWorldMs` (the sweep removes it). */
export type WorkRestFields = { charId: string; untilWorldMs: number };

export const asFields = <T extends object>(f: T): Fields => f as unknown as Fields;
export const fieldsOf = <T>(e: { fields: Fields }): T => e.fields as unknown as T;
