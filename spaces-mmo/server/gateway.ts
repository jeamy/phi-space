// The gateway of the web process (docs/architektur.md, "Datenfluss zum Browser"): one WebSocket per playing browser.
// Inbound it turns command lines into Intent entries; outbound it follows the world space's change stream once and
// hands each client what concerns it: the characters online in its room, the things lying there and its exits, what
// it carries, and messages to the room or to it, rendered for it (FuncParser: $you(), $conj()).
// A character is online while a Session entry for it lives; the gateway holds one per open WebSocket and renews its
// lease, so a web process that dies takes its players offline within the lease.
import { randomBytes } from "node:crypto";
import { cutText, RevisionAhead, SnapshotExpired, type SpaceLike } from "phi-spaces";
import type { Me } from "./accounts.ts";
import { Chat, isChatFrame, isChatLine, type ChatClientFrame, type ChatFrame, type ChatUser } from "./chat.ts";
import { render } from "./engine/funcparser.ts";
import type { WorldDef } from "./engine/world.ts";
import { msUntilWorld, viewOf, worldNow, type WorldTimeView } from "./engine/worldtime.ts";
import { asFields, type AnimalFields, type BedFields, type BuildingFields, type FieldFields, type RuinFields, type SiteFields, type ListingFields, type OfferFields, type OrderFields, type BeaconFields, type FlameFields, type FogFields, type CharacterFields, type ExitFields, type Glyph, type IntentFields, type ItemFields, type MsgFields, type RoomFields, type SessionFields, type WorldClockFields } from "./model.ts";
import { bedPlantsView } from "./engine/commands/garden.ts";
import { fieldView } from "./engine/commands/field.ts";
import { wildKinds } from "./engine/commands/wild.ts";
import { envMs } from "./space.ts";
import { RegionSpaces } from "./region-spaces.ts";
import { setting } from "./settings.ts";
import type { WsConnection } from "phi-spaces/ws";

/** What a client sees of a character. */
export type CharView = { charId: string; name: string; x: number; y: number; skin: number; ai?: true; /** a settler (npc/settlers.ts): a script plays it, always marked */ settler?: true };
/** What a client sees of a thing or an exit: on the map when `location` is its room, in its pack when it is its charId. */
/** `icon`: the URL of a thing's picture (from its prototype); the map draws the glyph without one. */
/** A building plan as the page offers it (key for `bau <key> <x> <y>`, what it needs as text). */
export type PlanView = { key: string; name: string; w: number; h: number; needs: string; work: number; /** the island's epoch it needs ("Dorf"; none: the first) */ epoch?: string };
/** A site or building (docs/siedeln.md) covers `w`×`h` cells from x/y; `owner` built it, `progress` (0..1) of a site,
 *  `missing` what it still needs. */
export type ObjView = { id: string; kind: "item" | "exit" | "beacon" | "site" | "building" | "ruin" | "bed" | "field" | "animal"; name: string; location: string; x: number; y: number; glyph?: Glyph; icon?: string; until?: number;
	w?: number; h?: number; owner?: string; progress?: number; missing?: string; color?: string; /** the plan of a site, building or ruin (the 3D map draws each its own) */ plan?: string; /** the kind of animal a coop or pen houses */ herd?: string; /** a building's dog or cat on guard */ keeper?: string; /** an animal from the fog: hase, reh, fuchs, maus */ animal?: string;
	/** A bed: its plants at their cells (relative to the bed), when it was watered and how long its plants go without
	 *  water, whether weeds grow in it, and who may tend it besides the owner; `bedKind`: a flower bed or a community bed; `fenced`: hares keep out. An animal: the bed it came to (`target`). */
	bedKind?: "zier" | "gemein"; fenced?: boolean; plants?: Array<{ x: number; y: number; stage: number; color: string }>; wateredWorldMs?: number; thirstMs?: number; weedy?: boolean; sponsors?: string[]; target?: string;
	/** A field (field.ts): its stage (fallow, being sown, growing, ripe, late; `progress` of the sowing or the harvest),
	 *  `color` its crop's, `open`: everyone may sow and harvest. */
	fieldStage?: "brach" | "saat" | "waechst" | "reif" | "spaet"; open?: boolean };
/** `toMe`: meant for the viewer and from someone else: said to them alone (an offer, a sale), or naming them.
 *  `player`: the speaker is a player (not an NPC: the page offers a chat with them); `players`: in the list of who plays,
 *  the names that are players. */
export type MsgView = Pick<MsgFields, "kind" | "text" | "from" | "at" | "help"> & { ai?: true; toMe?: true; player?: true; players?: string[] };
/** What a client sees of trade: offers it made or got, the order board and the market board (the boards only in their
 *  room), its own taken order. */
/** The overview of the world (top left in the page): every room placed on it, with its ground, its fires and the
 *  ways to other places (ferries are the links between rooms that are not side by side). Sent once per connection. */
export type AtlasView = { rooms: Array<{ roomId: string; name: string; island: string; x: number; y: number; ground: string[]; fires: Array<{ x: number; y: number }> }>; links: Array<[string, string]> };
/** What changes on the overview: where the player is, the fog of each room, the rooms whose fire burns, and how many
 *  people and NPCs are online in each room. */
export type AtlasState = { here: string; fog: Record<string, number>; lit: string[]; people: Record<string, [number, number]> };
export type TradeView = {
	offersIn: Array<Pick<OfferFields, "offerId" | "fromName" | "giveNames" | "want">>;
	offersOut: Array<Pick<OfferFields, "offerId" | "toName" | "giveNames" | "want">>;
	orders: Array<{ nr: number; text: string; reward: number }> | null;
	/** The player's order; `here`: a board stands in this room (only there it is delivered or given up); `boards`: where. */
	myOrder: { text: string; needs: OrderFields["needs"]; here: boolean; boards: string[] } | null;
	listings: Array<{ nr: number; itemName: string; price: number; sellerName: string; mine: boolean }> | null;
};
/** Frames to the browser. */
export type ServerFrame =
	| { t: "hello"; build: string | null; world: Pick<WorldDef, "id" | "title" | "tileSize" | "tiles" | "skins" | "decor"> & { fuels: string[]; icons: string[]; plans: PlanView[] }; me: { charId: string; name: string; guest: boolean; admin: boolean }; room: RoomFields; chars: CharView[]; objs: ObjView[]; log: MsgView[]; fog: number; now: number; worldTime: WorldTimeView | null }
	| { t: "fog"; level: number }
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
export type ClientFrame = { t: "cmd"; line: string } | { t: "step"; seq: number; dx: number; dy: number } | ChatClientFrame;

const MAX_LINE = 300;
const RECENT = 40;
const INTENT_LEASE_MS = 30_000;
/** Against a flood of steps (the page paces them itself, client/walk.ts, at most one per WALK_MS): a client may have
 *  STEP_BURST steps in hand and gets one back every STEP_REFILL_MS; a step beyond that is dropped (the page then
 *  resynchronizes after a while). The page's pace never reaches the limit. */
const STEP_BURST = 8, STEP_REFILL_MS = 100;
/** Typed commands likewise: the settings' burst at once, then their rate per second (a person types far slower; a script that
 *  floods would fill the world's queue). Both buckets belong to the account, whatever number of pages it has open, and an
 *  account keeps at most MAX_PAGES pages: a further one closes the oldest. */
const MAX_PAGES = 4;
type Bucket = { left: number; at: number };
/** Takes one from the bucket (refilled by the time passed); false when it is empty. */
function spend(b: Bucket, burst: number, refillMs: number): boolean {
	const now = Date.now();
	b.left = Math.min(burst, b.left + (now - b.at) / refillMs); b.at = now;
	if (b.left < 1) return false;
	b.left -= 1;
	return true;
}

type Client = { ws: WsConnection; me: Me; room: string | null; lease: string | null; leaseRegion?: string; awaitsHello?: boolean; keep?: () => Promise<void>; timer: ReturnType<typeof setInterval> | null; atlas?: boolean; limits: { steps: Bucket; cmds: Bucket }; warned: number;
	/** The client's commands, one after another (a step counts the ones waiting before it). */ chain: Promise<void> };
/** At most this often the overview's state goes out after a change (people walk, fires burn down, fog moves). */
const ATLAS_MS = 1_000;

/** The characters a model plays (docs/modell-npcs.md: marked as AI wherever they appear). */
const charView = (c: CharacterFields, modelChars: ReadonlySet<string>): CharView => ({ charId: c.charId, name: c.name, x: c.x, y: c.y, skin: c.skin, ...(modelChars.has(c.charId) ? { ai: true as const } : {}), ...(c.charId.startsWith("npc-siedler-") ? { settler: true as const } : {}) });
const itemView = (f: ItemFields, protoIcons: ReadonlyMap<string, string>): ObjView => ({ id: f.itemId, kind: "item", name: f.name, location: f.location, x: f.x, y: f.y, glyph: f.glyph, ...(protoIcons.has(f.proto) ? { icon: protoIcons.get(f.proto)! } : {}) });
const exitView = (f: ExitFields): ObjView => ({ id: f.exitId, kind: "exit", name: f.name, location: f.location, x: f.x, y: f.y });
const msgView = (m: MsgFields, viewer: string, modelNames: ReadonlySet<string>, viewerName = "", players: ReadonlySet<string> = new Set()): MsgView => ({ kind: m.kind, text: m.actor ? render(m.text, { viewer, actor: m.actor, actorName: m.from }) : m.text, from: m.from, at: m.at, ...(modelNames.has(m.from) ? { ai: true as const } : {}), ...(forViewer(m, viewer, viewerName) ? { toMe: true as const } : {}),
	...(["say", "emote", "channel"].includes(m.kind) && m.fromId && !m.fromId.startsWith("npc-") ? { player: true as const } : {}),
	...(m.kind === "who" ? { players: whoNames(m.text).filter((n) => players.has(n)) } : {}),
	...(m.kind === "help" && m.help ? { help: m.help } : {}) });
/** The names in the list of who plays ("Gerade spielen 3: Anna (Graue Bucht), Bo (Fischerdorf)"). */
const whoNames = (text: string) => (text.split(": ").slice(1).join(": ")).split(", ").map((x) => x.replace(/\s*\([^)]*\)\s*$/, "").trim()).filter(Boolean);
/** Whether a message is meant for the viewer: written to them alone by someone else (not the answer to their own
 *  command, not an error), or someone else's words that name them. */
function forViewer(m: MsgFields, viewer: string, name: string): boolean {
	if (m.kind === "error" || (m.fromId ?? "") === viewer || (name && m.from === name)) return false;
	if (m.to === viewer) return !!m.fromId;
	if (!name || !["say", "emote", "channel"].includes(m.kind)) return false;
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "iu").test(m.text);
}

export class Gateway {
	readonly sessionLeaseMs = envMs("SPACES_MMO_SESSION_LEASE_MS", 30_000);
	#closed = false;
	#ready: Promise<void>;
	readonly #clients = new Set<Client>();
	// the world as the change stream showed it
	readonly #chars = new Map<string, CharacterFields>(); // by charId
	readonly #charOf = new Map<string, string>(); // space entry id -> charId
	readonly #charEntry = new Map<string, string>(); // charId -> its current space entry id (no scan per move)
	readonly #sessions = new Map<string, string>(); // session entry id -> charId
	readonly #online = new Map<string, number>(); // charId -> live sessions
	readonly #rooms = new Map<string, RoomFields>();
	readonly #objs = new Map<string, ObjView>(); // by itemId / exitId
	readonly #objOf = new Map<string, string>(); // space entry id -> itemId / exitId
	readonly #objEntry = new Map<string, string>(); // itemId / exitId / beaconId -> its current space entry id
	readonly #recent = new Map<string, MsgFields[]>(); // room -> last messages to everyone there
	readonly #flames = new Map<string, number>(); // beaconId -> until, in world time
	readonly #flameOf = new Map<string, string>(); // flame entry id -> beaconId
	readonly #fog = new Map<string, number>(); // room -> level
	#clock: WorldClockFields | null = null; // the world's clock entry (docs/weltzeit.md)
	#clockTimer: ReturnType<typeof setInterval> | null = null;
	readonly #offers = new Map<string, OfferFields>(); // entry id -> offer
	readonly #orders = new Map<string, OrderFields>(); // entry id -> order
	readonly #listings = new Map<string, ListingFields>(); // entry id -> listing
	// the revision of each region's stream the state above reflects; entries are kept by "region:id" (two spaces may
	// number their entries alike), and each character by the region whose stream showed it last
	readonly #applied = new Map<string, number>();
	readonly #charRegion = new Map<string, string>();
	readonly #regions: RegionSpaces;
	#atlasDue: ReturnType<typeof setTimeout> | null = null;
	readonly #waiting = new Set<{ region: string; rev: number; ok: () => void }>();
	#watch: Promise<void>;
	#modelChars!: Set<string>; #modelNames!: Set<string>; #protoIcons!: Map<string, string>;
	readonly #chat: Chat | null;

	private readonly space: SpaceLike;
	private readonly w: WorldDef;
	private readonly onActivity: (accountId: string) => void;
	private readonly build: string | null;

	/** `space`: the world's one space, or its region spaces (each followed; a character's intents and session go to the
	 *  region it stands in). `chatSpace`: where the chat between players keeps its entries (the accounts space). */
	constructor(space: SpaceLike | RegionSpaces, w: WorldDef, onActivity: (accountId: string) => void = () => {}, build: string | null = null, chatSpace: SpaceLike | null = null) {
		this.#regions = space instanceof RegionSpaces ? space : RegionSpaces.single(w, space);
		this.space = this.#regions.homeSpace; this.w = w; this.onActivity = onActivity; this.build = build;
		this.#modelChars = new Set(w.npcs.filter((n) => n.model).map((n) => `npc-${n.npcId}`));
		this.#protoIcons = new Map(w.prototypes.filter((p) => p.icon).map((p) => [p.key, `/assets/${w.id}/${p.icon}`]));
		this.#modelNames = new Set(w.npcs.filter((n) => n.model).map((n) => n.name));
		const follows = this.#regions.entries().map(([region, s]) => { let ready!: () => void; const p = new Promise<void>((r) => (ready = r)); return { p, run: this.#follow(region, s, ready) }; });
		this.#ready = Promise.all(follows.map((f) => f.p)).then(() => {});
		this.#watch = Promise.all(follows.map((f) => f.run)).then(() => {});
		// a regular reminder, so a browser that was hidden or lost frames shows the same hour again
		this.#clockTimer = setInterval(() => this.#broadcastTime(), 30_000);
		this.#clockTimer.unref?.();
		this.#chat = chatSpace ? new Chat(chatSpace, {
			person: (name) => {
				const n = name.toLowerCase();
				const c = [...this.#chars.values()].find((x) => x.name.toLowerCase() === n);
				return !c ? null : c.charId.startsWith("npc-") ? "npc" : { accountId: c.accountId, name: c.name, guest: c.guest };
			},
			nameOf: (accountId) => [...this.#chars.values()].find((x) => x.accountId === accountId)?.name ?? "",
			send: (accountId, f) => { for (const c of this.#clients) if (c.me.accountId === accountId) c.ws.send(f); },
			online: (accountId) => [...this.#clients].some((c) => c.me.accountId === accountId),
		}) : null;
	}

	/** The names of the players' characters (not NPCs), for the list of who plays. */
	#playerNames(): Set<string> { return new Set([...this.#chars.values()].filter((c) => !c.charId.startsWith("npc-")).map((c) => c.name)); }

	/** Chat messages players reported, newest first (for the admins; empty without chat). */
	async chatReports() { return this.#chat ? await this.#chat.reports() : []; }

	/** The player of a page as chat knows them: the name of their character now (a registration renames a guest's). */
	#chatUser(c: Client): ChatUser {
		const ch = this.#chars.get(c.me.charId);
		return { accountId: c.me.accountId, name: ch?.name ?? c.me.name, guest: c.me.guest };
	}

	/** A browser of `me` plays now. */
	async attach(ws: WsConnection, me: Me): Promise<void> {
		// the account's other pages share its buckets; beyond MAX_PAGES the oldest page is closed
		const mine = [...this.#clients].filter((x) => x.me.accountId === me.accountId);
		for (const old of mine.slice(0, Math.max(0, mine.length - MAX_PAGES + 1))) old.ws.close();
		const limits = mine.at(-1)?.limits ?? { steps: { left: STEP_BURST, at: Date.now() }, cmds: { left: await setting(this.space, "cmd.burst"), at: Date.now() } };
		const c: Client = { ws, me, room: null, lease: null, timer: null, limits, warned: 0, chain: Promise.resolve() };
		this.#clients.add(c);
		ws.onClose(() => {
			this.#clients.delete(c);
			if (c.timer) clearInterval(c.timer);
			if (c.lease) void this.#regions.get(c.leaseRegion ?? this.#regions.home)?.cancel(c.lease).catch(() => {});
		});
		ws.onMessage((text) => this.#inbound(c, text));
		await this.#ready;
		// the session lives in the character's region: after a crossing the next beat (or the crossing itself, #put)
		// writes it there and ends the old one
		const keep = async () => {
			try {
				const region = await this.#regionOf(me.charId);
				if (c.lease && c.leaseRegion !== region) { void this.#regions.get(c.leaseRegion ?? this.#regions.home)?.cancel(c.lease).catch(() => {}); c.lease = null; }
				const space = this.#regions.get(region)!;
				if (c.lease) { try { await space.renew(c.lease, this.sessionLeaseMs); return; } catch { c.lease = null; } }
				if (!this.#clients.has(c)) return;
				c.lease = (await space.write({ type: "Session", fields: asFields<SessionFields>({ sessionId: ws.id, charId: me.charId, accountId: me.accountId }) }, null, this.sessionLeaseMs)).id;
				c.leaseRegion = region;
				if (!this.#clients.has(c)) await space.cancel(c.lease).catch(() => {}); // closed while writing
			} catch (e) { console.error("[gateway] session:", (e as Error).message); }
		};
		c.keep = keep;
		await keep();
		// online now: if someone else stands on this character's cell meanwhile, the world moves it to a free one
		await this.#intent(c, "arrive");
		c.timer = setInterval(() => void keep(), Math.max(1000, Math.floor(this.sessionLeaseMs / 3)));
		c.timer.unref?.();
		// read your writes: the hello is built from the stream, so it waits until the stream has caught up with the space
		// as it is now (the player's own session, a registration that just renamed its character)
		await Promise.all(this.#regions.entries().map(async ([region, s]) => this.#reach(region, (await s.readPage({ type: "-" })).rev))).catch(() => {});
		this.#hello(c);
		await this.#chat?.attach(this.#chatUser(c), (f) => c.ws.send(f)).catch((e) => console.error("[chat] attach:", (e as Error).message));
	}

	/** The region a character stands in; on a ferry it is in none for a moment, and the one it lands in is waited for. */
	async #regionOf(charId: string): Promise<string> {
		if (this.#regions.size === 1) return this.#regions.home;
		for (let i = 0; i < 30 && !this.#closed; i++) {
			const r = this.#charRegion.get(charId);
			if (r && this.#chars.has(charId)) return r;
			await new Promise((ok) => setTimeout(ok, 100));
		}
		return this.#charRegion.get(charId) ?? this.#regions.home;
	}

	/** Resolves once the region's change stream has been applied up to `rev` (rejects after `ms`). */
	#reach(region: string, rev: number, ms = 5_000): Promise<void> {
		if ((this.#applied.get(region) ?? -1) >= rev) return Promise.resolve();
		return new Promise((ok, fail) => {
			const w = { region, rev, ok: () => { clearTimeout(timer); ok(); } };
			const timer = setTimeout(() => { this.#waiting.delete(w); fail(new Error(`change stream behind revision ${rev}`)); }, ms);
			this.#waiting.add(w);
		});
	}

	#advance(region: string, rev: number): void {
		this.#applied.set(region, rev);
		for (const w of this.#waiting) if (w.region === region && w.rev <= rev) { this.#waiting.delete(w); w.ok(); }
	}

	/** The clock as a browser is told it (null in a world that has none yet). */
	#worldTime(): WorldTimeView | null { return this.#clock ? viewOf(this.#clock, Date.now()) : null; }
	#broadcastTime(): void {
		const time = this.#worldTime();
		if (time) for (const c of this.#clients) if (c.room !== null) c.ws.send({ t: "time", time } satisfies ServerFrame);
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#clockTimer) clearInterval(this.#clockTimer);
		if (this.#atlasDue) clearTimeout(this.#atlasDue);
		for (const c of [...this.#clients]) c.ws.close();
		await this.#chat?.close();
		// its long call for changes (like the chat's) ends with the connection, not waited for to its end
		await Promise.race([this.#watch.catch(() => {}), new Promise((r) => setTimeout(r, 200).unref())]);
	}

	async #inbound(c: Client, text: string): Promise<void> {
		let f: ClientFrame;
		try { f = JSON.parse(text); } catch { return; }
		if (f?.t === "step") {
			const { seq, dx, dy } = f;
			if (!Number.isSafeInteger(seq) || ![dx, dy].every((d) => d === -1 || d === 0 || d === 1) || Math.abs(dx) + Math.abs(dy) !== 1) return;
			// a flood of steps (a stuck key, a script) is dropped beyond the burst; the page's pace never reaches the limit
			if (!spend(c.limits.steps, STEP_BURST, STEP_REFILL_MS)) return;
			c.chain = c.chain.then(() => this.#intent(c, `step ${dx} ${dy}`, { conn: c.ws.id, seq }));
			await c.chain;
			this.onActivity(c.me.accountId);
			return;
		}
		// the end-to-end encrypted chat's frames (server/chat.ts), counted like typed commands
		if (f && isChatFrame(f) && this.#chat) {
			if (!spend(c.limits.cmds, await setting(this.space, "cmd.burst"), 1000 / Math.max(1, await setting(this.space, "cmd.perSec")))) {
				c.ws.send({ t: "msg", m: { kind: "error", text: "Zu viele Nachrichten auf einmal; einen Moment bitte.", from: "", at: Date.now() } } satisfies ServerFrame);
				return;
			}
			const frame = f;
			c.chain = c.chain.then(() => this.#chat!.frame(this.#chatUser(c), frame, (x) => c.ws.send(x)));
			await c.chain;
			this.onActivity(c.me.accountId);
			return;
		}
		if (f?.t !== "cmd" || typeof f.line !== "string") return;
		const line = cutText(f.line.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), MAX_LINE);
		if (!line) return;
		// the command limits are the operator's settings (server/settings.ts), read at most every few seconds
		const cmdBurst = await setting(this.space, "cmd.burst"), cmdRefillMs = 1000 / Math.max(1, await setting(this.space, "cmd.perSec"));
		if (!(/^step\s/.test(line) ? spend(c.limits.steps, STEP_BURST, STEP_REFILL_MS) : spend(c.limits.cmds, cmdBurst, cmdRefillMs))) {
			if (Date.now() - c.warned > 2_000) { c.warned = Date.now(); c.ws.send({ t: "msg", m: { kind: "error", text: "Zu viele Befehle auf einmal; einen Moment bitte.", from: "", at: Date.now() } } satisfies ServerFrame); }
			return;
		}
		// chat between players never reaches the world (server/chat.ts): no world worker, no translation, no NPC reads it
		if (this.#chat && isChatLine(line)) {
			c.chain = c.chain.then(async () => { await this.#chat!.handle(this.#chatUser(c), line, (f) => c.ws.send(f)); });
			await c.chain;
			this.onActivity(c.me.accountId);
			return;
		}
		c.chain = c.chain.then(() => this.#intent(c, line));
		await c.chain;
		this.onActivity(c.me.accountId);
	}

	async #intent(c: Client, line: string, step?: { conn: string; seq: number }): Promise<void> {
		const intent: IntentFields = { intentId: randomBytes(8).toString("hex"), charId: c.me.charId, line, at: Date.now(), ...(step ? { step } : {}) };
		try { await this.#regions.get(await this.#regionOf(c.me.charId))!.write({ type: "Intent", fields: asFields(intent) }, null, INTENT_LEASE_MS); }
		catch { c.ws.send({ t: "msg", m: { kind: "error", text: "Die Welt ist gerade nicht erreichbar; bitte gleich noch einmal.", from: "", at: Date.now() } } satisfies ServerFrame); }
	}

	/** The building plans for the page's cell menu, with what each needs as text. */
	#plans(): PlanView[] {
		const name = (k: string) => this.w.prototypes.find((p) => p.key === k)?.name ?? k;
		return (this.w.building?.plans ?? []).map((p) => ({ key: p.key, name: p.name, w: p.w, h: p.h, needs: p.needs.map((n) => `${n.count} ${name(n.proto)}`).join(", "), work: p.work, ...((p.epoch ?? 1) > 1 ? { epoch: this.w.epochs?.names[p.epoch! - 1] ?? `Epoche ${p.epoch}` } : {}) }));
	}
	#hello(c: Client): void {
		const self = this.#chars.get(c.me.charId);
		const room = self ? this.#rooms.get(self.room) : undefined;
		// a character between two commits of a command (its arrival moves it): its next write in the stream brings the hello
		if (!self || !room) {
			if (c.awaitsHello) return;
			c.awaitsHello = true;
			setTimeout(() => { if (c.awaitsHello && this.#clients.has(c)) c.ws.send({ t: "msg", m: { kind: "error", text: "Deine Figur ist noch nicht in der Welt angekommen.", from: "", at: Date.now() } } satisfies ServerFrame); }, 2000).unref();
			return;
		}
		c.awaitsHello = false;
		c.room = self.room;
		const chars = [...this.#chars.values()].filter((ch) => ch.room === self.room && (ch.charId === self.charId || this.#online.get(ch.charId))).map((ch) => charView(ch, this.#modelChars));
		const objs = [...this.#objs.values()].filter((o) => o.location === self.room || o.location === self.charId).map((o) => this.#view(o));
		const log = (this.#recent.get(self.room) ?? []).map((m) => msgView(m, self.charId, this.#modelNames, self.name, this.#playerNames()));
		queueMicrotask(() => {
			c.ws.send({ t: "trade", trade: this.#trade(c) } satisfies ServerFrame);
			if (!c.atlas) { c.atlas = true; c.ws.send({ t: "atlas", atlas: this.#atlas() } satisfies ServerFrame); }
			c.ws.send({ t: "atlasState", state: this.#atlasState(c) } satisfies ServerFrame);
		});
		c.ws.send({ t: "hello", build: this.build, world: { id: this.w.id, title: this.w.title, tileSize: this.w.tileSize, tiles: this.w.tiles, skins: this.w.skins, ...(this.w.decor ? { decor: this.w.decor } : {}), fuels: Object.keys(this.w.fire.fuel).map((k) => this.w.prototypes.find((p) => p.key === k)?.name ?? k), icons: [...new Set([...this.#protoIcons.values(), ...(this.w.wild ? [`/assets/${this.w.id}/${this.w.wild.hare.icon}`] : [])])], plans: this.#plans() }, me: { charId: self.charId, name: self.name, guest: c.me.guest, admin: c.me.admin }, room, chars, objs, log, fog: this.#fog.get(self.room) ?? 0, now: Date.now(), worldTime: this.#worldTime() } satisfies ServerFrame);
	}

	/** Puts every entry `tmpl` matches, read in pages of bounded size (one snapshot: the pages share its token). */
	async #readPaged(region: string, space: SpaceLike, tmpl: { type: string; fields?: Record<string, string> }, msgs: MsgFields[]): Promise<void> {
		let after: string | null = null, token: string | undefined;
		do {
			const page: Awaited<ReturnType<SpaceLike["readPage"]>> = await space.readPage(tmpl, { after, token, maxBytes: 256 * 1024 });
			for (const e of page.items) this.#put(`${region}:${e.id}`, e.type, e.types, e.fields, msgs);
			after = page.next; token = page.token;
		} while (after !== null);
	}

	/** Reads the world once (from a revision taken before the reads) and then follows the change stream. Replaying ops
	 *  that the reads already showed is harmless: a put replaces, a del removes. */
	async #follow(region: string, space: SpaceLike, ready: () => void): Promise<void> {
		let rev = -1;
		const key = (id: string) => `${region}:${id}`;
		while (!this.#closed) {
			try {
				if (rev < 0) {
					rev = (await space.readPage({ type: "-" })).rev;
					const msgs: MsgFields[] = [];
					for (const type of ["Room", "Character", "Session", "Item", "Exit", "Beacon", "Flame", "Fog", "WorldClock", "Offer", "Order", "Listing", "Site", "Building", "Ruin", "Bed", "Field", "Animal"]) await this.#readPaged(region, space, { type }, msgs);
					await this.#readPaged(region, space, { type: "Msg", fields: { to: "*" } }, msgs); // #put keeps the last RECENT of each room
					this.#advance(region, rev);
					ready();
					for (const c of this.#clients) this.#hello(c); // after a restart of the stream
				}
				const ch = await space.changes(rev, { waitMs: 20_000 });
				for (const b of ch.batches) {
					const chars = new Map<string, string | null>(); // charId -> room before the batch
					const objs = new Map<string, string | null>(); // objId -> location before the batch
					const msgs: MsgFields[] = [];
					const fogs = new Set<string>(); // rooms whose fog changed
					let trade = false; // offers, orders or listings changed
					let clock = false; // the world clock was written
					const touch = (entryId: string, fields?: Record<string, unknown>, types?: string[]) => {
						entryId = key(entryId);
						const charId = this.#charOf.get(entryId) ?? this.#sessions.get(entryId) ?? (fields && (types?.includes("Character") || types?.includes("Session")) ? String(fields.charId) : undefined);
						if (charId && !chars.has(charId)) chars.set(charId, this.#chars.get(charId)?.room ?? null);
						const objId = this.#objOf.get(entryId) ?? this.#flameOf.get(entryId) ?? (fields && types?.includes("Item") ? String(fields.itemId) : fields && types?.includes("Exit") ? String(fields.exitId) : fields && (types?.includes("Beacon") || types?.includes("Flame")) ? String(fields.beaconId) : fields && (types?.includes("Site") || types?.includes("Building") || types?.includes("Ruin")) ? String(fields.buildId) : fields && types?.includes("Bed") ? String(fields.bedId) : fields && types?.includes("Field") ? String(fields.fieldId) : fields && types?.includes("Animal") ? String(fields.animalId) : undefined);
						if (fields && types?.includes("Fog")) fogs.add(String(fields.room));
						if (objId && !objs.has(objId)) objs.set(objId, this.#objs.get(objId)?.location ?? null);
					};
					for (const op of b.ops) {
						// a renewed session is the same session: the character did not change, nothing to announce
						const id = key(op.id);
						if (op.op === "put") { clock ||= op.type === "WorldClock"; if (!(op.type === "Session" && this.#sessions.has(id))) touch(op.id, op.fields, op.types); trade ||= ["Offer", "Order", "Listing"].includes(op.type); this.#put(id, op.type, op.types, op.fields, msgs); }
						else { touch(op.id); trade ||= this.#offers.has(id) || this.#orders.has(id) || this.#listings.has(id); this.#del(id); }
					}
					// first where everyone and everything is now (a client whose own room changed gets its hello), then what was said
					for (const [charId, roomBefore] of chars) this.#announce(charId, roomBefore);
					// someone with an open offer came, went or lost the connection: the trade lists change
					if (!trade && [...chars.keys()].some((id) => [...this.#offers.values()].some((o) => o.from === id || o.to === id))) trade = true;
					for (const [objId, before] of objs) this.#announceObj(objId, before);
					if (clock) { this.#broadcastTime(); for (const [id, o] of this.#objs) if (o.kind === "beacon") this.#announceObj(id, o.location); }
					if (trade) for (const c of this.#clients) if (c.room !== null) c.ws.send({ t: "trade", trade: this.#trade(c) } satisfies ServerFrame);
					if (chars.size || fogs.size || [...objs.keys()].some((id) => this.#objs.get(id)?.kind === "beacon")) this.#atlasChanged();
					for (const room of fogs) for (const c of this.#clients) if (c.room === room) c.ws.send({ t: "fog", level: this.#fog.get(room) ?? 0 } satisfies ServerFrame);
					for (const m of msgs) for (const c of this.#clients) if (m.to.startsWith("#") || (m.to === "*" ? c.room === m.room : c.me.charId === m.to)) c.ws.send({ t: "msg", m: msgView(m, c.me.charId, this.#modelNames, this.#chars.get(c.me.charId)?.name, m.kind === "who" ? this.#playerNames() : undefined) } satisfies ServerFrame);
				}
				rev = ch.next;
				this.#advance(region, rev);
			} catch (e) {
				if (this.#closed) break;
				const m = (e as Error).message;
				// the history moved past the cursor (or the space restarted): read everything again from now
				if (e instanceof SnapshotExpired || e instanceof RevisionAhead) { console.error(`[gateway] change stream of ${region}: ${m}; reading it again`); this.#reset(region); rev = -1; continue; }
				console.error("[gateway] change stream:", m);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	}

	/** Forgets what the region's stream showed (it is read again): the other regions' entries stay. */
	#reset(region: string): void {
		if (this.#regions.size === 1) {
			this.#clock = null;
			for (const m of [this.#chars, this.#charOf, this.#charEntry, this.#sessions, this.#online, this.#rooms, this.#objs, this.#objOf, this.#objEntry, this.#recent, this.#flames, this.#flameOf, this.#fog, this.#offers, this.#orders, this.#listings]) m.clear();
			return;
		}
		const mine = (id: string) => id.startsWith(`${region}:`);
		for (const m of [this.#charOf, this.#objOf, this.#sessions, this.#flameOf, this.#offers, this.#orders, this.#listings] as Array<Map<string, unknown>>) for (const id of [...m.keys()]) if (mine(id)) this.#del(id);
	}

	/** Applies a put; a message is collected in `msgs` to be sent after the batch. */
	#put(id: string, type: string, types: string[], fields: Record<string, unknown>, msgs: MsgFields[]): void {
		if (type === "WorldClock") this.#clock = fields as unknown as WorldClockFields;
		else if (type === "Room") { const r = fields as unknown as RoomFields; this.#rooms.set(r.roomId, r); }
		else if (type === "Character") {
			const c = fields as unknown as CharacterFields;
			const prev = this.#charEntry.get(c.charId);
			if (prev !== undefined && prev !== id) this.#charOf.delete(prev);
			this.#chars.set(c.charId, c); this.#charOf.set(id, c.charId); this.#charEntry.set(c.charId, id);
			// a character that crossed into another region: its pages' sessions follow it now, not at the next beat
			const region = id.slice(0, id.indexOf(":"));
			if (this.#charRegion.get(c.charId) !== region) {
				this.#charRegion.set(c.charId, region);
				for (const cl of this.#clients) if (cl.me.charId === c.charId && cl.leaseRegion && cl.leaseRegion !== region) void cl.keep?.();
			}
		}
		else if (type === "Session") {
			if (this.#sessions.has(id)) return; // a renewal
			const s = fields as unknown as SessionFields;
			this.#sessions.set(id, s.charId); this.#online.set(s.charId, (this.#online.get(s.charId) ?? 0) + 1);
		}
		else if (type === "Beacon") {
			const b = fields as unknown as BeaconFields;
			const o: ObjView = { id: b.beaconId, kind: "beacon", name: b.name, location: b.room, x: b.x, y: b.y };
			this.#setObj(id, o);
		}
		else if (type === "Ruin") {
			const r = fields as unknown as RuinFields;
			this.#setObj(id, { id: r.buildId, kind: "ruin", name: r.name, location: r.room, x: r.x, y: r.y, w: r.w, h: r.h, owner: r.ownerName, plan: r.plan });
		}
		else if (type === "Bed") {
			const b = fields as unknown as BedFields;
			this.#setObj(id, { id: b.bedId, kind: "bed", name: b.kind === "gemein" ? "Gemeinschaftsbeet" : b.kind === "zier" ? "Zierbeet" : "Beet", ...(b.kind ? { bedKind: b.kind } : {}), ...(b.fenced ? { fenced: true } : {}), location: b.room, x: b.x, y: b.y, w: b.w, h: b.h, owner: b.ownerName, plants: bedPlantsView(this.w, b), wateredWorldMs: b.wateredWorldMs, thirstMs: this.w.garden?.thirstWorldMs ?? 0, weedy: b.weedy, sponsors: b.sponsors.map((x) => x.name) });
		}
		else if (type === "Field") {
			const f = fields as unknown as FieldFields, v = fieldView(this.w, f);
			this.#setObj(id, { id: f.fieldId, kind: "field", name: v.crop ? `Flur (${v.crop})` : "Flur", location: f.room, x: f.x, y: f.y, w: f.w, h: f.h, owner: f.ownerName, fieldStage: v.stage, progress: v.progress, ...(v.color ? { color: v.color } : {}), ...(f.open ? { open: true } : {}), ...(f.fenced ? { fenced: true } : {}) });
		}
		else if (type === "Animal") {
			const a = fields as unknown as AnimalFields;
			const k = this.w.wild ? wildKinds(this.w.wild).find((x) => x.key === (a.kind ?? "hase")) : undefined;
			this.#setObj(id, { id: a.animalId, kind: "animal", animal: a.kind ?? "hase", name: a.name, location: a.room, x: a.x, y: a.y, target: a.bedId ?? a.target, glyph: { shape: "circle", color: "#a08a6a" }, ...(k ? { icon: `/assets/${this.w.id}/${k.icon}` } : {}) });
		}
		else if (type === "Site" || type === "Building") {
			const b = fields as unknown as SiteFields & BuildingFields;
			const site = type === "Site";
			const total = site ? b.needs.reduce((a, n) => a + n.count, 0) + b.workNeed : 0, have = site ? b.needs.reduce((a, n) => a + Math.min(n.have, n.count), 0) + b.work : 0;
			const missing = site ? [...b.needs.filter((n) => n.have < n.count).map((n) => `${n.count - n.have} ${n.name}`), ...(b.work < b.workNeed ? [`${b.workNeed - b.work} Arbeit`] : [])].join(", ") : undefined;
			const color = this.w.building?.plans.find((p) => p.key === b.plan)?.color;
			this.#setObj(id, { id: b.buildId, kind: site ? "site" : "building", name: b.name, location: b.room, x: b.x, y: b.y, w: b.w, h: b.h, owner: b.ownerName, plan: b.plan, ...(site ? { progress: total ? have / total : 0, missing } : {}), ...(color ? { color } : {}), ...(!site && b.herd ? { herd: b.herd.kind } : {}), ...(!site && b.keeper ? { keeper: b.keeper.kind } : {}), ...(!site && b.fenced ? { fenced: true } : {}) });
		}
		else if (type === "Flame") { const f = fields as unknown as FlameFields; this.#flames.set(f.beaconId, f.until); this.#flameOf.set(id, f.beaconId); }
		else if (type === "Fog") { const f = fields as unknown as FogFields; this.#fog.set(f.room, f.level); }
		else if (type === "Offer") this.#offers.set(id, fields as unknown as OfferFields);
		else if (type === "Order") this.#orders.set(id, fields as unknown as OrderFields);
		else if (type === "Listing") this.#listings.set(id, fields as unknown as ListingFields);
		else if (types.includes("Item") || types.includes("Exit")) {
			const o = types.includes("Item") ? itemView(fields as unknown as ItemFields, this.#protoIcons) : exitView(fields as unknown as ExitFields);
			this.#setObj(id, o);
		}
		else if (type === "Msg") {
			const m = fields as unknown as MsgFields;
			if (m.to === "*") {
				const list = this.#recent.get(m.room) ?? [];
				list.push(m); if (list.length > RECENT) list.shift();
				this.#recent.set(m.room, list);
			}
			msgs.push(m);
		}
	}

	/** An object's view under its (new) space entry id; the entry it had before is forgotten. */
	#setObj(id: string, o: ObjView): void {
		const prev = this.#objEntry.get(o.id);
		if (prev !== undefined && prev !== id) this.#objOf.delete(prev);
		this.#objs.set(o.id, o); this.#objOf.set(id, o.id); this.#objEntry.set(o.id, id);
	}

	#del(id: string): void {
		if (this.#offers.delete(id) || this.#orders.delete(id) || this.#listings.delete(id)) return;
		const beaconId = this.#flameOf.get(id);
		if (beaconId) { this.#flameOf.delete(id); if (![...this.#flameOf.values()].includes(beaconId)) this.#flames.delete(beaconId); return; }
		const charId = this.#charOf.get(id);
		if (charId) { this.#charOf.delete(id); if (this.#charEntry.get(charId) === id) { this.#charEntry.delete(charId); this.#chars.delete(charId); } return; }
		const objId = this.#objOf.get(id);
		if (objId) { this.#objOf.delete(id); if (this.#objEntry.get(objId) === id) { this.#objEntry.delete(objId); this.#objs.delete(objId); } return; }
		const s = this.#sessions.get(id);
		if (s) { this.#sessions.delete(id); const n = (this.#online.get(s) ?? 1) - 1; if (n > 0) this.#online.set(s, n); else this.#online.delete(s); }
	}

	/** After a batch: tells the clients of the character's room (and of the room it left) where it is now. */
	#announce(charId: string, roomBefore: string | null): void {
		const c = this.#chars.get(charId);
		const visible = !!c && !!this.#online.get(charId);
		for (const cl of this.#clients) {
			// its own room changed (a client not greeted yet gets its hello from attach)
			if (cl.me.charId === charId && c && (cl.awaitsHello || (cl.room !== null && cl.room !== c.room))) { this.#hello(cl); continue; }
			if (visible && cl.room === c!.room) cl.ws.send({ t: "char", c: charView(c!, this.#modelChars), ...(cl.me.charId === charId && c!.ack?.conn === cl.ws.id ? { ack: c!.ack.seq } : {}) } satisfies ServerFrame);
			else if (cl.room !== null && (cl.room === roomBefore || cl.room === c?.room)) cl.ws.send({ t: "gone", charId } satisfies ServerFrame);
		}
	}

	/** The client's view of trade, numbered like the text commands number them (order of posting). */
	#trade(c: Client): TradeView {
		const me = c.me.charId;
		const offers = [...this.#offers.values()];
		const orders = [...this.#orders.values()].sort((a, b) => a.orderId.localeCompare(b.orderId));
		const open = orders.filter((o) => !o.takenBy);
		const mine = orders.find((o) => o.takenBy === me);
		const listings = [...this.#listings.values()].sort((a, b) => a.at - b.at || a.listingId.localeCompare(b.listingId));
		return {
			// only offers whose other side is still here and online (leaving withdraws them anyway; a lost connection does not)
			offersIn: offers.filter((o) => o.to === me && this.#here(o.from, c.room)).map(({ offerId, fromName, giveNames, want }) => ({ offerId, fromName, giveNames, want })),
			offersOut: offers.filter((o) => o.from === me && this.#here(o.to, c.room)).map(({ offerId, toName, giveNames, want }) => ({ offerId, toName, giveNames, want })),
			orders: c.room && this.w.orders.rooms.includes(c.room) ? open.filter((o) => o.room === c.room).map((o, i) => ({ nr: i + 1, text: o.text, reward: o.reward.count })) : null,
			myOrder: mine ? { text: mine.text, needs: mine.needs, here: !!c.room && this.w.orders.rooms.includes(c.room), boards: this.w.orders.rooms.map((r) => this.#rooms.get(r)?.name ?? r) } : null,
			listings: c.room && this.w.market.rooms.includes(c.room) ? listings.filter((l) => l.room === c.room).map((l, i) => ({ nr: i + 1, itemName: l.itemName, price: l.price, sellerName: l.sellerName, mine: l.seller === me })) : null,
		};
	}

	/** The overview: the rooms with a place on it (rooms builders dug have none) and the ways between them. */
	#atlas(): AtlasView {
		const rooms = [...this.#rooms.values()].filter((r) => r.map).map((r) => ({ roomId: r.roomId, name: r.name, island: r.island ?? "", x: r.map!.x, y: r.map!.y, ground: r.ground, fires: this.w.beacons.filter((b) => b.room === r.roomId).map(({ x, y }) => ({ x, y })) }));
		const placed = new Set(rooms.map((r) => r.roomId)), links = new Map<string, [string, string]>();
		for (const e of this.w.exits) if (placed.has(e.room) && placed.has(e.destination)) links.set([e.room, e.destination].sort().join(" "), [e.room, e.destination].sort() as [string, string]);
		return { rooms, links: [...links.values()] };
	}

	#atlasState(c: Client): AtlasState {
		const people: Record<string, [number, number]> = {};
		for (const ch of this.#chars.values()) {
			if (!this.#online.get(ch.charId)) continue;
			const n = (people[ch.room] ??= [0, 0]);
			n[ch.charId.startsWith("npc-") ? 1 : 0]++;
		}
		const lit = this.w.beacons.filter((b) => this.#burns(this.#flames.get(b.beaconId) ?? 0)).map((b) => b.room);
		return { here: c.room ?? "", fog: Object.fromEntries(this.#fog), lit, people };
	}

	/** Something on the overview changed: its state goes out to every client once the short pause is over. */
	#atlasChanged(): void {
		if (this.#atlasDue) return;
		this.#atlasDue = setTimeout(() => {
			this.#atlasDue = null;
			for (const c of this.#clients) if (c.atlas) c.ws.send({ t: "atlasState", state: this.#atlasState(c) } satisfies ServerFrame);
		}, ATLAS_MS);
		this.#atlasDue.unref?.();
	}

	/** Whether a character is online and in `room`. */
	#here(charId: string, room: string | null): boolean {
		const ch = this.#chars.get(charId);
		return !!ch && ch.room === room && !!this.#online.get(charId);
	}

	/** A beacon with its fire's end (0: out). */
	#view(o: ObjView): ObjView {
		return o.kind === "beacon" ? { ...o, until: this.#realUntil(this.#flames.get(o.id) ?? 0) } : o;
	}

	/** Does a fire that burns until world time `until` burn now? */
	#burns(until: number): boolean { return !!this.#clock && until > worldNow(this.#clock, Date.now()); }

	/** The end of a fire for the browser, in its own real time (0: out). The map and the fire's countdown ask the browser's
	 *  clock; a paused world's fire has no end in sight, so far away. A change of the clock sends the beacons again. */
	#realUntil(until: number): number {
		const now = Date.now();
		if (!this.#clock || !this.#burns(until)) return 0;
		const wait = msUntilWorld(this.#clock, until, now);
		return now + (Number.isFinite(wait) ? wait : 10 * 365 * 24 * 3600_000);
	}

	/** After a batch: the clients that saw the object where it was, or see it where it is now (a room, a pack). */
	#announceObj(objId: string, before: string | null): void {
		const base = this.#objs.get(objId), o = base && this.#view(base);
		const sees = (cl: Client, loc: string | null | undefined) => !!loc && (cl.room === loc || cl.me.charId === loc);
		for (const cl of this.#clients) {
			if (o && sees(cl, o.location)) cl.ws.send({ t: "obj", o } satisfies ServerFrame);
			else if (sees(cl, before)) cl.ws.send({ t: "objgone", id: objId } satisfies ServerFrame);
		}
	}
}
