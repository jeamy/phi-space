// What the web process and the browser say to each other (docs/rust-portierung.en.md, R8.0 item 3): the game frames
// (server/gateway.ts), the chat frames (server/chat.ts), the overview of the world (server/stats.ts) and the to-dos
// (server/todos.ts). These are the contract the page depends on; in R8 they are generated from the Rust web process.
import type { Glyph, MsgFields, OfferFields, OrderFields, RoomFields } from "./model.ts";
import type { CropDef, SortDef, WorldDef } from "./world-def.ts";
import type { WorldTimeView } from "./worldtime.ts";
import type { Timetable } from "./liner.ts";
import type { Appearance } from "./appearance.ts";

/** The ways of travel the statistics count (server/engine/travel.ts). */
export const TRIPS = ["beam", "ship", "sail", "row", "train"] as const;
export type Trip = (typeof TRIPS)[number];

/** One task: its words, where it is (room and cell), and how urgent (0 now, 1 soon, 2 when there is time). */
export type Todo = { id: string; text: string; room: string; x: number; y: number; rank: 0 | 1 | 2 };

/** What a client sees of a character. */
export type CharView = { charId: string; name: string; x: number; y: number; skin: number; /** the chosen look of the figure in 3D (engine/appearance.ts) */ look?: Appearance; /** on board of the large ship, on its way to this island (only its own page shows it: others do not see it) */ aboard?: { island: string; arriveWorldMs: number; /** the room of the destination and of the bay it was boarded in: the page shows the next stop to leave at (engine/liner.ts nextStop) */ to?: string; from?: string }; ai?: true; /** a settler (npc/settlers.ts): a script plays it, always marked */ settler?: true };
/** What a client sees of a thing or an exit: on the map when `location` is its room, in its pack when it is its charId. */
/** `icon`: the URL of a thing's picture (from its prototype); the map draws the glyph without one. */
/** A building plan as the page offers it (key for `bau <key> <x> <y>`, what it needs as text). */
/** What the page needs to say what a carried thing can do (client/cellActions.ts itemEntries), by the names shown. */
export type ItemUses = { recipes: Array<{ key: string; name: string; needs: Array<{ name: string; count: number }>; tool?: string; at?: string }>; /** by herd or keeper */ feed: Record<string, string[]>; offerings: string[]; flowers: string[]; /** plans with a chest of one's own, plans of a store for all */ chests: string[]; stores: string[];
	/** What turns one thing into another outside the recipes (client/hints.ts): a mill grinds corn, a pen or coop keeps
	 *  an animal that yields; `at` the plan, `line` the command. */
	steps: Array<{ kind: "grind" | "keep"; from: string; to: string; at: string; line: string }> };
export type PlanView = { key: string; name: string; w: number; h: number; needs: string; work: number; /** the island's epoch it needs ("Dorf"; none: the first) */ epoch?: string; /** a chest of its owner's own (not a store for all): "truhe" opens it */ chest?: true };
/** A site or building (docs/siedeln.en.md) covers `w`×`h` cells from x/y; `owner` built it, `progress` (0..1) of a site,
 *  `missing` what it still needs. */
export type ObjView = { id: string; kind: "item" | "exit" | "beacon" | "site" | "building" | "ruin" | "bed" | "field" | "animal" | "scenery" | "zone" | "cart" | "liner" | "track" | "train"; name: string; location: string; x: number; y: number; glyph?: Glyph; icon?: string; until?: number;
	w?: number; h?: number; /** Scenery: what it is. */ desc?: string; /** Scenery: its picture, how much work it still takes, whether it stays or is walked over. */ model?: string; left?: number; fixed?: boolean; through?: boolean; /** An exit: the place it leads to (its `name` is what `go` takes), and that room's id. */ to?: string; toRoom?: string; /** Tracks of the island railway (made by the client, engine/rail.ts): the runs of cells, each from a station's own track when `fromStation`. */ runs?: Array<Array<{ x: number; y: number }>>; fromStation?: boolean; /** The owner's name as shown and their character (a name can change, an alias; the id cannot). */ owner?: string; ownerId?: string; sponsorIds?: string[]; /** What a site has hung out, with a wage per piece (`proto` "": work). */ orders?: Array<{ proto: string; name: string; left: number; pay: number }>; progress?: number; missing?: string; color?: string; /** The large ship (made by the client from the timetable): its fare and the islands it goes to. */ fare?: number; /** It is running in or out of the bay: no boarding. */ gliding?: boolean; routes?: Array<{ island: string; room: string }>; /** the plan of a site, building or ruin (the 3D map draws each its own) */ plan?: string; /** the kind of animal a coop or pen houses */ herd?: string; /** a building's dog or cat on guard */ keeper?: string; /** a thing's load (engine/pack.ts), in a world with loads */ load?: number; /** an animal from the fog: hase, reh, fuchs, maus, moewe */ animal?: string;
	/** A bed: its plants at their cells (relative to the bed), when it was watered and how long its plants go without
	 *  water, whether weeds grow in it, and who may tend it besides the owner; `bedKind`: a flower bed or a community bed; `fenced`: hares keep out. An animal: the bed it came to (`target`). */
	bedKind?: "zier" | "gemein"; fenced?: boolean; plants?: Array<{ x: number; y: number; stage: number; color: string; model?: SortDef["model"] }>; wateredWorldMs?: number; thirstMs?: number; weedy?: boolean; sponsors?: string[]; target?: string;
	/** A field (field.ts): its stage (fallow, being sown, growing, ripe, late; `progress` of the sowing or the harvest),
	 *  `color` its crop's, `open`: everyone may sow and harvest. */
	fieldStage?: "brach" | "saat" | "waechst" | "reif" | "spaet"; cropModel?: CropDef["model"]; open?: boolean };
/** `toMe`: meant for the viewer and from someone else: said to them alone (an offer, a sale), or naming them.
 *  `player`: the speaker is a player (not an NPC: the page offers a chat with them); `players`: in the list of who plays,
 *  the names that are players. `mine`: addressed to the viewer's figure alone (the answer to its own command, a whisper,
 *  an offer) or what that figure did, told to the room ("Du stellst 3 Brot her."): the page shows these apart from what
 *  happens around it. */
export type MsgView = Pick<MsgFields, "kind" | "text" | "from" | "at" | "help"> & { ai?: true; toMe?: true; mine?: true; player?: true; players?: string[] };
/** What a client sees of trade: offers it made or got, the order board and the market board (the boards only in their
 *  room), its own taken order. */
/** The overview of the world (top left in the page): every room placed on it, with its ground, its fires and the
 *  ways to other places (ferries are the links between rooms that are not side by side). Sent once per connection. */
export type AtlasView = { rooms: Array<{ roomId: string; name: string; island: string; x: number; y: number; ground: string[]; fires: Array<{ x: number; y: number }> }>; links: Array<[string, string]> };
/** What changes on the overview: where the player is, the fog of each room, the rooms whose fire burns, and how many
 *  people and NPCs are online in each room. */
/** What a player owns, for the marks on the overview. */
export type AtlasOwned = { id: string; kind: "site" | "building" | "bed" | "field" | "ruin"; name: string; room: string; x: number; y: number; /** a site's, building's or ruin's plan (a chest of one's own: ItemUses.chests) */ plan?: string };
export type AtlasState = { /** What the player's own things want of it now (server/todos.ts). */ todos: Todo[]; here: string; fog: Record<string, number>; lit: string[]; people: Record<string, [number, number]>; mine: AtlasOwned[]; /** The epoch of each island that has left the first (the header shows the one the player stands on); null in a world without epochs. */ epochs: Record<string, number> | null; /** Coins per field of distance for beaming (the admin's setting), for the price on the map. */ beamCost: number; /** The most a figure carries (the setting pack.max); null in a world without loads. */ packMax: number | null; /** Where a boat, a train and a cart can go in this region: the rooms with a jetty or a station (and the fare), the rooms a road joins. */ stops: { jetties: string[]; stations: string[]; trainFare: number; roads: Array<[string, string]> } };
export type TradeView = {
	offersIn: Array<Pick<OfferFields, "offerId" | "fromName" | "giveNames" | "want">>;
	offersOut: Array<Pick<OfferFields, "offerId" | "toName" | "giveNames" | "want">>;
	orders: Array<{ nr: number; text: string; reward: number }> | null;
	/** The player's order; `here`: a board stands in this room (only there it is delivered or given up); `boards`: where. */
	myOrder: { text: string; needs: OrderFields["needs"]; here: boolean; boards: string[] } | null;
	listings: Array<{ nr: number; itemName: string; /** how many for the price together */ count: number; price: number; sellerName: string; mine: boolean }> | null;
	/** The board's wanted notices (numbered on their own), null where no board stands. */
	wanted: Array<{ nr: number; protoName: string; count: number; price: number; buyerName: string; mine: boolean;
		/** who would deliver for how much more; whether a trader deals in it at all; when it lapses (real ms, null: unknown) */
		replies: Array<{ name: string; ask: number }>; traded: boolean; until: number | null }> | null;
	/** Until when (world time) the figure rests from searching for seeds in this room, null: it does not (the page then offers the search). */
	seedRestUntilWorldMs: number | null;
};
/** Frames to the browser. */
export type ServerFrame =
	| { t: "hello"; wind: string; build: string | null; world: Pick<WorldDef, "id" | "title" | "tileSize" | "tiles" | "skins" | "decor"> & { fuels: string[]; icons: string[]; plans: PlanView[]; uses: ItemUses; /** The large ship's period and the rooms it lies in (engine/liner.ts). */ liner?: Timetable & { /** What the ride costs and where it goes: the island and the bay room of each. */ fare: number; routes: Array<{ island: string; room: string }>; /** The island of the room the page opens in (a sailing boat goes to the others). */ island: string }; /** The island railway: the plan of its stations (engine/rail.ts draws the tracks between them) and its timetable. */ rail?: { plan: string; everyWorldMs?: number } }; me: { charId: string; name: string; guest: boolean; admin: boolean }; room: RoomFields; chars: CharView[]; objs: ObjView[]; log: MsgView[]; fog: number; now: number; worldTime: WorldTimeView | null }
	| { t: "fog"; level: number }
	| { t: "wind"; wind: string }
	/** The world clock changed (or the regular reminder): the browser interpolates from it; it decides nothing by it. */
	| { t: "time"; time: WorldTimeView }
	| { t: "trade"; trade: TradeView }
	/** `ack`: for the own character only, the number of the last step of this page it took (client/walk.ts). */
	| { t: "char"; c: CharView; ack?: number }
	| { t: "gone"; charId: string }
	| { t: "obj"; o: ObjView }
	| { t: "objgone"; id: string }
	| { t: "msg"; m: MsgView }
	| { t: "atlas"; atlas: AtlasView }
	| { t: "atlasState"; state: AtlasState }
	/** Chat between players (server/chat.ts): a message, the talks so far, groups and invitations, a talk to open. */
	| ChatFrame;
/** Frames from the browser. */
/** Frames from the browser: a typed command, or a numbered step of the own character (the page walks ahead of the
 *  server and matches the answers by number, client/walk.ts). */
export type ClientFrame = { t: "cmd"; line: string; /** the language the page shows, German when left out */ lang?: "en" } | { t: "step"; seq: number; dx: number; dy: number } | ChatClientFrame;

/** A sealed chat message (client/chatcrypto.ts Box). */
export type Box = { iv: string; ct: string; pub: string };
/** A talk as the page shows it: with one person (`id` their account) or a group (`id` the group). */
export type ChatConv = { kind: "dm" | "group"; id: string; title: string };
/** A message as the page gets it: sealed (`box`, the page opens it) or a note of the group (`note`, `from` empty). */
export type ChatView = { id: string; conv: ChatConv; from: string; fromId: string; at: number; mine?: true; box?: Box; note?: string };
/** A key backup as the page sends and gets it (client/chatcrypto.ts KeyBackup). */
export type ChatKeyView = { pub: string; wrapped: string; salt: string; iter: number };
/** A message of the sender's that a reader can get now: `pub` their new key. */
export type ChatResealItem = { msgId: string; to: string; pub: string; groupId: string };
/** The player's groups (with the names of their members), the invitations waiting and whom they ignore. */
export type ChatState = { groups: Array<{ groupId: string; name: string; members: string[]; owner: boolean }>; invites: Array<{ groupId: string; name: string; from: string }>; blocked: string[];
	/** Who wrote to a player without a chat key, and how many messages wait for it. */ waiting: Array<{ from: string; count: number }> };
export type ChatFrame =
	| { t: "chat"; m: ChatView }
	| { t: "chatlog"; msgs: ChatView[] }
	| { t: "chats"; state: ChatState }
	| { t: "chatopen"; conv: ChatConv }
	/** To the sender's pages: open these of your own copies and seal them for their reader. */
	| { t: "chatreseal"; items: ChatResealItem[] }
	/** The player's account and key backup (null: no chat key yet). */
	| { t: "chatme"; accountId: string; key: ChatKeyView | null }
	/** The readers of a talk with their public keys (the page seals a copy for each); `missing`: readers without a key. */
	| { t: "chatkeys"; conv: ChatConv; readers: Array<{ accountId: string; name: string; pub: string }>; missing: string[]; req: number };
/** Frames of the page for chat (besides the text commands). */
export type ChatClientFrame =
	| { t: "chatkey"; key: ChatKeyView; replace?: boolean }
	| { t: "chatkeys"; conv: { kind: "dm" | "group"; id: string }; req: number }
	| { t: "chatsend"; msgId: string; conv: { kind: "dm" | "group"; id: string }; copies: Array<{ to: string; box: Box }> }
	| { t: "chatreport"; msgId: string; text: string }
	/** An unlocked page asks what it can hand on now. */
	| { t: "chatwaiting" }
	/** A message handed on to a reader who has a key now. */
	| { t: "chatdeliver"; msgId: string; to: string; box: Box };

export type Trips = Record<Trip, number>;
export type PlayerStat = {
	charId: string; name: string; guest: boolean; online: boolean;
	/** a person, a settler (an NPC that plays like one) or a figure a model plays */ kind: "player" | "settler" | "ai";
	/** registered (a guest: since when it plays), ms since 1970 */ since: number;
	/** where it stands (offline: where it last stood); `aboard`: on the large ship, nothing more */
	at: { room: string; roomName: string; island: string | null; x: number; y: number } | { aboard: true } | null;
	reputation: { pieces: number; beacons: number; parks: number; /** services to the community (Deed) */ deeds: number };
	trips: Trips;
	owns: { buildings: number; beds: number; fields: number; plans: Array<{ plan: string; name: string; count: number }>;
		/** what the figure carries: each kind with how many, the most first */ carries: Array<{ name: string; count: number }> };
};
export type WorldStats = {
	at: number;
	players: { total: number; registered: number; guests: number; online: number; settlers: number; ai: number };
	trips: Trips;
	buildings: { total: number; houses: number; byPlan: Array<{ plan: string; name: string; count: number }> };
	beds: number; fields: number; sites: number; settlements: number;
	list: PlayerStat[];
	/** regions that could not be read: the numbers are without them */ missing: string[];
};
