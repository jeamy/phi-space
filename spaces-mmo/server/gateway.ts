// The gateway of the web process (docs/architektur.en.md, "Datenfluss zum Browser"): one WebSocket per playing browser.
// Inbound it turns command lines into Intent entries; outbound it follows the world space's change stream once and
// hands each client what concerns it: the characters online in its room, the things lying there and its exits, what
// it carries, and messages to the room or to it, rendered for it (FuncParser: $you(), $conj()).
// A character is online while a Session entry for it lives; the gateway holds one per open WebSocket and renews its
// lease, so a web process that dies takes its players offline within the lease.
import { randomBytes } from "node:crypto";
import { cutText, NO_WAIT, RevisionAhead, SnapshotExpired, type SpaceLike } from "phi-spaces";
import type { Me } from "./accounts.ts";
import { Chat, isChatFrame, isChatLine, type ChatClientFrame, type ChatFrame, type ChatUser } from "./chat.ts";
import { render } from "./engine/funcparser.ts";
import { sceneryText, type CropDef, type SortDef, type WorldDef } from "./engine/world.ts";
import { loadOf } from "./engine/pack.ts";
import { NOTICE_MS, whereTo } from "./engine/context.ts";
import { decayNow, msUntilWorld, viewOf, worldNow, type WorldTimeView } from "./engine/worldtime.ts";
import { baysOf, linerOf, type Timetable } from "./engine/liner.ts";
import { todosFor, type Todo } from "./todos.ts";
import { asFields, type HerdFields, type MillLoadFields, type EpochFields, type SeedRestFields, type AnimalFields, type BedFields, type BuildingFields, type FieldFields, type RuinFields, type SiteFields, type ListingFields, type WantedFields, type NoticeFields, type SceneryFields, type SiteOrderFields, type OfferFields, type OrderFields, type BeaconFields, type FlameFields, type FogFields, type CharacterFields, type ExitFields, type Glyph, type IntentFields, type ItemFields, type MsgFields, type RoomFields, type SessionFields, type CartFields, type WindFields, type WorldClockFields, type ZoneFields } from "./model.ts";
import { bedPlantsView } from "./engine/commands/garden.ts";
import { fieldView } from "./engine/commands/field.ts";
import { wildKinds } from "./engine/commands/wild.ts";
import { distTo, EXIT_REACH } from "./engine/commands/build.ts";
import { envMs } from "./space.ts";
import { RegionSpaces } from "./region-spaces.ts";
import { setting } from "./settings.ts";
import type { WsConnection } from "phi-spaces/ws";
import type { Appearance } from "./engine/appearance.ts";

/** At most this many kept messages to a player come with its page's first hello. */
const NOTICES_SHOWN = 200;
import type { CharView, ItemUses, PlanView, ObjView, MsgView, AtlasView, AtlasOwned, AtlasState, TradeView, ServerFrame, ClientFrame } from "../shared/frames.ts";
export type { CharView, ItemUses, PlanView, ObjView, MsgView, AtlasView, AtlasOwned, AtlasState, TradeView, ServerFrame, ClientFrame } from "../shared/frames.ts";
/** What things are good for in world `w`, sent with the page (the pack's buttons, client/hints.ts). */
export function usesOf(w: WorldDef): ItemUses {
	const name = (k: string) => w.prototypes.find((p) => p.key === k)?.name ?? k;
	const plans = w.building?.plans ?? [];
	return {
		recipes: w.recipes.map((r) => ({ key: r.key, name: r.name, needs: r.needs.map((n) => ({ name: name(n.proto), count: n.count })), ...(r.tool ? { tool: name(r.tool) } : {}), ...(r.at ? { at: r.at } : {}) })),
		feed: Object.fromEntries([...(w.animals?.kinds ?? []), ...(w.wild?.keepers ?? [])].map((k) => [k.key, k.feed.map(name)])),
		offerings: (w.chapel?.offerings ?? []).map(name),
		flowers: (w.garden?.sorts ?? []).filter((s) => s.kind === "zier").map((s) => name(s.yields.proto)),
		// a seed by what grows of it (the pack keeps them side by side); a crop sown from itself (Weizen) is left out
		seeds: Object.fromEntries([...(w.garden?.sorts ?? []), ...(w.fields?.crops ?? [])].map((s) => [s.seed, (Array.isArray(s.yields) ? s.yields[0] : s.yields)?.proto] as const).filter(([seed, grows]) => seed && grows && seed !== grows).map(([seed, grows]) => [name(seed), name(grows!)])),
		beds: {
			flowers: (w.garden?.sorts ?? []).filter((s) => s.kind === "zier").map((s) => name(s.seed)),
			plants: (w.garden?.sorts ?? []).filter((s) => s.kind !== "zier").map((s) => name(s.seed)),
			field: (w.fields?.crops ?? []).map((s) => s.seed).filter((seed) => !(w.garden?.sorts ?? []).some((s) => s.seed === seed)).map(name),
		},
		chests: plans.filter((p) => p.chest && !p.store).map((p) => p.key),
		stores: plans.filter((p) => p.store).map((p) => p.key),
		steps: [
			...(w.mill ? w.mill.grinds.map((g) => ({ kind: "grind" as const, from: name(g.from), to: name(g.to), at: w.mill!.plan, line: `mahle alle ${name(g.from).toLowerCase()}` })) : []),
			...(w.animals?.kinds ?? []).map((k) => ({ kind: "keep" as const, from: k.name, to: name(k.yields), at: k.plan, line: `einstallen ${k.name.toLowerCase()}` })),
		],
	};
}


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

type Client = { ws: WsConnection; me: Me; lang?: "en"; room: string | null; lease: string | null; leaseRegion?: string; awaitsHello?: boolean; keep?: () => Promise<void>; timer: ReturnType<typeof setInterval> | null; atlas?: boolean; limits: { steps: Bucket; cmds: Bucket }; warned: number;
	/** The client's commands, one after another (a step counts the ones waiting before it). */ chain: Promise<void> };
/** At most this often the overview's state goes out after a change (people walk, fires burn down, fog moves). */
const ATLAS_MS = 1_000;

/** The characters a model plays (docs/modell-npcs.en.md: marked as AI wherever they appear). */
const charView = (c: CharacterFields, modelChars: ReadonlySet<string>): CharView => ({ charId: c.charId, name: c.name, x: c.x, y: c.y, skin: c.skin, ...(c.look ? { look: c.look } : {}), ...(c.aboard ? { aboard: { island: c.aboard.island, arriveWorldMs: c.aboard.arriveWorldMs, to: c.aboard.to, ...(c.aboard.from ? { from: c.aboard.from } : {}) } } : {}), ...(modelChars.has(c.charId) ? { ai: true as const } : {}), ...(c.charId.startsWith("npc-siedler-") ? { settler: true as const } : {}), ...(c.guest ? { guest: true as const } : {}) });
const itemView = (f: ItemFields, protoIcons: ReadonlyMap<string, string>, w: WorldDef): ObjView => ({ id: f.itemId, kind: "item", name: f.name, location: f.location, x: f.x, y: f.y, glyph: f.glyph, ...(protoIcons.has(f.proto) ? { icon: protoIcons.get(f.proto)! } : {}), ...(w.pack ? { load: loadOf(w, f.proto) } : {}), ...(w.pack?.bags?.[f.proto] ? { bag: w.pack.bags[f.proto] } : {}) });
const exitView = (f: ExitFields, w: WorldDef): ObjView => ({ id: f.exitId, kind: "exit", name: f.name, to: whereTo(w, f), toRoom: f.destination, location: f.location, x: f.x, y: f.y });
const msgView = (m: MsgFields, viewer: string, modelNames: ReadonlySet<string>, viewerName = "", players: ReadonlySet<string> = new Set()): MsgView => ({ kind: m.kind, text: m.actor ? render(m.text, { viewer, actor: m.actor, actorName: m.from }) : m.text, from: m.from, at: m.at, ...(modelNames.has(m.from) ? { ai: true as const } : {}), ...(forViewer(m, viewer, viewerName) ? { toMe: true as const } : {}),
	// said to the viewer alone, or what its own figure did as the room is told ("$you() stellst 3 Brot her": „Du stellst …“;
	// "jeamy erntet auf dem Acker …", told as an emote like most deeds); what it says (talk, channels) stays with the room's talk
	...(m.to === viewer || m.actor === viewer || (m.fromId === viewer && m.kind !== "say" && m.kind !== "channel") ? { mine: true as const } : {}),
	...(["say", "emote", "channel"].includes(m.kind) && m.fromId && !m.fromId.startsWith("npc-") ? { player: true as const } : {}),
	...(m.kind === "who" ? { players: whoNames(m.text).filter((n) => players.has(n)) } : {}),
	...(m.kind === "help" && m.help ? { help: m.help } : {}) });
/** The names in the list of who plays ("Gerade spielen 3: Anna (Graue Bucht), Bo (Fischerdorf)"). */
const whoNames = (text: string) => (text.split(": ").slice(1).join(": ")).split(", ").map((x) => x.replace(/\s*\([^)]*\)\s*$/, "").trim()).filter(Boolean);
/** Whether a message is meant for the viewer: written to them alone by someone else (not the answer to their own
 *  command, not an error), someone else's words that name them, or someone else's deed told to the room that names
 *  them ("Anna gibt Bert Treibholz." for Bert). */
function forViewer(m: MsgFields, viewer: string, name: string): boolean {
	if (m.kind === "error" || (m.fromId ?? "") === viewer || (name && m.from === name)) return false;
	if (m.to === viewer) return !!m.fromId;
	if (!name || !(["say", "emote", "channel"].includes(m.kind) || (m.kind === "info" && m.actor))) return false;
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
	readonly #winds = new Map<string, number>();
	#yearDays = 0;
	#beamCost = 1;
	#packMax: number | null = null;
	#epochForce = 0;
	/** The name of the wind in a room; an island nobody counted yet has the breeze. */
	#windIn(room: string): string { return this.w.wind?.names[this.#winds.get(this.#rooms.get(room)?.island ?? "") ?? 1] ?? ""; }
	readonly #objs = new Map<string, ObjView>(); // by itemId / exitId
	readonly #objOf = new Map<string, string>(); // space entry id -> itemId / exitId
	readonly #objEntry = new Map<string, string>(); // itemId / exitId / beaconId -> its current space entry id
	readonly #recent = new Map<string, MsgFields[]>(); // room -> last messages to everyone there
	readonly #flames = new Map<string, number>(); // beaconId -> until, in world time
	readonly #flameOf = new Map<string, string>(); // flame entry id -> beaconId
	readonly #fog = new Map<string, number>(); // room -> level
	#clock: WorldClockFields | null = null; // the world's clock entry (docs/weltzeit.en.md)
	#clockTimer: ReturnType<typeof setInterval> | null = null;
	readonly #offers = new Map<string, OfferFields>(); // entry id -> offer
	readonly #orders = new Map<string, OrderFields>(); // entry id -> order
	readonly #listings = new Map<string, ListingFields>(); // entry id -> listing
	readonly #wanted = new Map<string, WantedFields>(); // entry id -> wanted notice
	readonly #notices = new Map<string, NoticeFields>(); // entry id (region:id) -> word for a player, kept 14 days (NOTICE_MS)
	readonly #seedRests = new Map<string, SeedRestFields>(); // entry id -> the rest of a figure after a search for seeds
	readonly #epochs = new Map<string, EpochFields>(); // entry id -> the epoch of an island
	readonly #siteOrders = new Map<string, SiteOrderFields>(); // entry id -> what a site hung out
	readonly #millLoads = new Map<string, MillLoadFields>(); // entry id -> grain at a mill (the players' tasks, todos.ts)
	readonly #herds = new Map<string, HerdFields>(); // building id -> its herd (the players' tasks)
	// the revision of each region's stream the state above reflects; entries are kept by "region:id" (two spaces may
	// number their entries alike), and each character by the region whose stream showed it last
	readonly #applied = new Map<string, number>();
	readonly #charRegion = new Map<string, string>();
	readonly #regions: RegionSpaces;
	#atlasDue: ReturnType<typeof setTimeout> | null = null;
	#atlasGeometryDirty = false;
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
		// the time moves the tasks on (a bed grows dry, flour gets ground) without any entry changing: the overview's state then too
		this.#clockTimer = setInterval(() => { this.#broadcastTime(); this.#atlasChanged(); }, 30_000);
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
	/** When a date of the second clock comes, in real ms (null: no clock, no date, the clock stands). */
	#lapse(atDecayMs: number | undefined): number | null {
		if (!this.#clock || atDecayMs === undefined) return null;
		const rate = this.#clock.decayRate ?? this.#clock.rate;
		if (this.#clock.paused || !(rate > 0)) return null;
		return Date.now() + Math.max(0, atDecayMs - decayNow(this.#clock)) / rate;
	}
	#worldTime(): WorldTimeView | null { return this.#clock ? { ...viewOf(this.#clock, Date.now()), yearDays: this.#yearDays } : null; }
	#broadcastTime(): void {
		void setting(this.space, "year.days").then((d) => { this.#yearDays = d; }, () => {}); // the next one carries it
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
		if (f.lang === "en") c.lang = "en"; else delete c.lang;
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
		const intent: IntentFields = { intentId: randomBytes(8).toString("hex"), charId: c.me.charId, line, at: Date.now(), ...(c.lang ? { lang: c.lang } : {}), ...(step ? { step } : {}) };
		try { await this.#regions.get(await this.#regionOf(c.me.charId))!.write({ type: "Intent", fields: asFields(intent) }, null, INTENT_LEASE_MS); }
		catch { c.ws.send({ t: "msg", m: { kind: "error", text: "Die Welt ist gerade nicht erreichbar; bitte gleich noch einmal.", from: "", at: Date.now() } } satisfies ServerFrame); }
	}

	/** The building plans for the page's cell menu, with what each needs as text. */
	#uses(): ItemUses { return usesOf(this.w); }

	#plans(): PlanView[] {
		const name = (k: string) => this.w.prototypes.find((p) => p.key === k)?.name ?? k;
		return (this.w.building?.plans ?? []).map((p) => ({ key: p.key, name: p.name, w: p.w, h: p.h, needs: p.needs.map((n) => `${n.count} ${name(n.proto)}`).join(", "), work: p.work, ...(p.chest && !p.store ? { chest: true as const } : {}), ...((p.epoch ?? 1) > 1 ? { epoch: this.w.epochs?.names[p.epoch! - 1] ?? `Epoche ${p.epoch}` } : {}) }));
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
		const chars = [...this.#chars.values()].filter((ch) => ch.room === self.room && (ch.charId === self.charId || (this.#online.get(ch.charId) && !ch.aboard))).map((ch) => charView(ch, this.#modelChars));
		const objs = [...this.#objs.values()].filter((o) => o.location === self.room || o.location === self.charId).map((o) => this.#view(o));
		// the word for this player of the last 14 days that it was told already comes with the room's lines (the page's
		// first hello fills its log with them; what is new comes right after as a message of its own, #tell)
		const kept = [...this.#notices.values()].filter((n) => n.charId === self.charId && n.told).map(({ noticeId: _n, charId: _c, told: _t, ...m }) => m as MsgFields);
		const lines = kept.length ? [...(this.#recent.get(self.room) ?? []), ...kept.sort((a, b) => a.at - b.at).slice(-NOTICES_SHOWN)].sort((a, b) => a.at - b.at) : this.#recent.get(self.room) ?? [];
		const log = lines.map((m) => msgView(m, self.charId, this.#modelNames, self.name, this.#playerNames()));
		queueMicrotask(() => {
			c.ws.send({ t: "trade", trade: this.#trade(c) } satisfies ServerFrame);
			this.#tell(c.me.charId); // word that waited while it was away
			if (!c.atlas) { c.atlas = true; c.ws.send({ t: "atlas", atlas: this.#atlas() } satisfies ServerFrame); }
			c.ws.send({ t: "atlasState", state: this.#atlasState(c) } satisfies ServerFrame);
		});
		c.ws.send({ t: "hello", wind: this.#windIn(self.room), build: this.build, world: { id: this.w.id, title: this.w.title, tileSize: this.w.tileSize, tiles: this.w.tiles, skins: this.w.skins, ...(this.w.decor ? { decor: this.w.decor } : {}), fuels: Object.keys(this.w.fire.fuel).map((k) => this.w.prototypes.find((p) => p.key === k)?.name ?? k), icons: [...new Set([...this.#protoIcons.values(), ...(this.w.wild ? [`/assets/${this.w.id}/${this.w.wild.hare.icon}`] : [])])], plans: this.#plans(), uses: this.#uses(), ...(this.w.liner ? { liner: { ...(() => { const t = linerOf(this.w)!; return { stops: t.stops, stayMs: t.stayMs, legMs: t.legMs, cycleMs: t.cycleMs }; })(), island: this.#rooms.get(self.room)?.island ?? "", fare: this.w.liner.fare, routes: [...baysOf(this.w.allRooms ?? this.w.rooms)].map(([island, r]) => ({ island, room: r.roomId })) } } : {}), ...(this.w.rail ? { rail: { plan: this.w.rail.plan, ...(this.w.rail.everyWorldMs ? { everyWorldMs: this.w.rail.everyWorldMs } : {}) } } : {}) }, me: { charId: self.charId, name: self.name, guest: c.me.guest, admin: c.me.admin }, room, chars, objs, log, fog: this.#fog.get(self.room) ?? 0, now: Date.now(), worldTime: this.#worldTime() } satisfies ServerFrame);
	}

	/** Tells a player the word waiting for it (model.ts NoticeFields), if one of its pages is in the world, and marks it
 *  told: shown once as new, on every page open now; it stays for its 14 days and comes with every later first hello. */
	#tell(charId: string): void {
		const pages = [...this.#clients].filter((c) => c.me.charId === charId && c.room !== null);
		if (!pages.length) return;
		for (const [id, n] of this.#notices) {
			if (n.charId !== charId || n.told) continue;
			this.#notices.set(id, { ...n, told: true });
			const { noticeId: _n, charId: _c, told: _t, ...m } = n;
			for (const c of pages) c.ws.send({ t: "msg", m: msgView(m, charId, this.#modelNames, this.#chars.get(charId)?.name) } satisfies ServerFrame);
			const [region, ...rest] = id.split(":"), space = this.#regions.get(region!);
			// written again as told, for the rest of its 14 days
			const left = n.at + NOTICE_MS - Date.now();
			if (space) void space.takeIfExists({ type: "Notice", id: rest.join(":") }, NO_WAIT).then((e) => e && left > 0 ? space.write({ type: "Notice", fields: { ...e.fields, told: true } as never }, null, left) : undefined).catch(() => {});
		}
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
					for (const type of ["Room", "Character", "Session", "Item", "Exit", "Beacon", "Flame", "Fog", "WorldClock", "Offer", "Order", "Listing", "Wanted", "Notice", "SeedRest", "Epoch", "SiteOrder", "Scenery", "Site", "Building", "Ruin", "Bed", "Field", "Animal", "Zone", "Wind", "Cart", "MillLoad"]) await this.#readPaged(region, space, { type }, msgs);
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
					const seeking = new Set<string>(); // figures whose rest from searching for seeds changed
					let clock = false; // the world clock was written
					const touch = (entryId: string, fields?: Record<string, unknown>, types?: string[]) => {
						entryId = key(entryId);
						const charId = this.#charOf.get(entryId) ?? this.#sessions.get(entryId) ?? (fields && (types?.includes("Character") || types?.includes("Session")) ? String(fields.charId) : undefined);
						if (charId && !chars.has(charId)) chars.set(charId, this.#chars.get(charId)?.room ?? null);
						const objId = this.#objOf.get(entryId) ?? this.#flameOf.get(entryId) ?? (fields && types?.includes("Item") ? String(fields.itemId) : fields && types?.includes("Exit") ? String(fields.exitId) : fields && (types?.includes("Beacon") || types?.includes("Flame")) ? String(fields.beaconId) : fields && types?.includes("Scenery") ? String(fields.sceneryId) : fields && (types?.includes("Site") || types?.includes("Building") || types?.includes("Ruin")) ? String(fields.buildId) : fields && types?.includes("Bed") ? String(fields.bedId) : fields && types?.includes("Field") ? String(fields.fieldId) : fields && types?.includes("Animal") ? String(fields.animalId) : fields && types?.includes("Zone") ? String(fields.zoneId) : fields && types?.includes("Cart") ? String(fields.cartId) : undefined);
						if (fields && types?.includes("Fog")) fogs.add(String(fields.room));
						if (objId && !objs.has(objId)) objs.set(objId, this.#objs.get(objId)?.location ?? null);
					};
					for (const op of b.ops) {
						// a renewed session is the same session: the character did not change, nothing to announce
						const id = key(op.id);
						if (op.op === "put") { clock ||= op.type === "WorldClock"; if (!(op.type === "Session" && this.#sessions.has(id))) touch(op.id, op.fields, op.types); trade ||= ["Offer", "Order", "Listing", "Wanted"].includes(op.type); if (op.type === "SeedRest") seeking.add(String(op.fields.charId)); this.#put(id, op.type, op.types, op.fields, msgs); }
						else { touch(op.id); trade ||= this.#offers.has(id) || this.#orders.has(id) || this.#listings.has(id) || this.#wanted.has(id); const sought = this.#seedRests.get(id); if (sought) seeking.add(sought.charId); this.#del(id); }
					}
					// first where everyone and everything is now (a client whose own room changed gets its hello), then what was said
					for (const [charId, roomBefore] of chars) this.#announce(charId, roomBefore);
					// someone with an open offer came, went or lost the connection: the trade lists change
					if (!trade && [...chars.keys()].some((id) => [...this.#offers.values()].some((o) => o.from === id || o.to === id))) trade = true;
					for (const [objId, before] of objs) this.#announceObj(objId, before);
					if (clock) { this.#broadcastTime(); for (const [id, o] of this.#objs) if (o.kind === "beacon") this.#announceObj(id, o.location); }
					for (const c of this.#clients) if (c.room !== null && (trade || seeking.has(c.me.charId))) c.ws.send({ t: "trade", trade: this.#trade(c) } satisfies ServerFrame);
					if (chars.size || fogs.size || objs.size) this.#atlasChanged();
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
			for (const m of [this.#chars, this.#charOf, this.#charEntry, this.#sessions, this.#online, this.#rooms, this.#objs, this.#objOf, this.#objEntry, this.#recent, this.#flames, this.#flameOf, this.#fog, this.#offers, this.#orders, this.#listings, this.#wanted, this.#notices, this.#seedRests, this.#epochs, this.#millLoads, this.#herds]) m.clear();
			return;
		}
		const mine = (id: string) => id.startsWith(`${region}:`);
		for (const m of [this.#charOf, this.#objOf, this.#sessions, this.#flameOf, this.#offers, this.#orders, this.#listings, this.#wanted, this.#notices, this.#seedRests, this.#epochs, this.#siteOrders, this.#millLoads] as Array<Map<string, unknown>>) for (const id of [...m.keys()]) if (mine(id)) this.#del(id);
	}

	/** Applies a put; a message is collected in `msgs` to be sent after the batch. */
	#put(id: string, type: string, types: string[], fields: Record<string, unknown>, msgs: MsgFields[]): void {
		if (type === "WorldClock") this.#clock = fields as unknown as WorldClockFields;
		if (type === "MillLoad") { this.#millLoads.set(id, fields as unknown as MillLoadFields); this.#atlasChanged(); return; }
		else if (type === "Room") {
			const r = fields as unknown as RoomFields, was = this.#rooms.get(r.roomId);
			this.#rooms.set(r.roomId, r);
			if (was && (was.ground.length !== r.ground.length || was.ground[0]!.length !== r.ground[0]!.length)) {
				this.#atlasChanged(true);
				for (const c of this.#clients) if (c.room === r.roomId) this.#hello(c);
			}
		}
		else if (type === "Character") {
			const c = fields as unknown as CharacterFields;
			const prev = this.#charEntry.get(c.charId), before = this.#chars.get(c.charId)?.name;
			if (prev !== undefined && prev !== id) this.#charOf.delete(prev);
			this.#chars.set(c.charId, c); this.#charOf.set(id, c.charId); this.#charEntry.set(c.charId, id);
			// a new name (an alias): what the character owns shows it at once
			if (before !== c.name) for (const o of this.#objs.values()) {
				const i = o.sponsorIds?.indexOf(c.charId) ?? -1;
				if (o.ownerId !== c.charId && i < 0) continue;
				if (o.ownerId === c.charId) o.owner = c.name;
				if (i >= 0) o.sponsors![i] = c.name;
				this.#announceObj(o.id, o.location);
			}
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
		else if (type === "Cart") {
			const f = fields as unknown as CartFields;
			this.#setObj(id, { id: f.cartId, kind: "cart", name: `Karren von ${this.#shownName(f.charId, f.ownerName)}`, ownerId: f.charId, location: f.room, x: f.x, y: f.y, glyph: { shape: "square", color: "#8a6a44" }, icon: "items/karren.png" });
		}
		else if (type === "Zone") {
			const z = fields as unknown as ZoneFields;
			this.#setObj(id, { id: z.zoneId, kind: "zone", name: z.kind === "weg" ? "Wegerecht" : "Grünzone", location: z.room, x: z.x, y: z.y, w: z.w, h: z.h, color: z.kind === "weg" ? "#e0c060" : "#5fbf6a" });
		}
		else if (type === "Ruin") {
			const r = fields as unknown as RuinFields;
			this.#setObj(id, { id: r.buildId, kind: "ruin", name: r.name, location: r.room, x: r.x, y: r.y, w: r.w, h: r.h, owner: this.#shownName(r.owner, r.ownerName), ownerId: r.owner, plan: r.plan });
		}
		else if (type === "Bed") {
			const b = fields as unknown as BedFields;
			this.#setObj(id, { id: b.bedId, kind: "bed", name: b.kind === "gemein" ? "Gemeinschaftsbeet" : b.kind === "zier" ? "Zierbeet" : "Beet", ...(b.kind ? { bedKind: b.kind } : {}), ...(b.fenced ? { fenced: true } : {}), location: b.room, x: b.x, y: b.y, w: b.w, h: b.h, owner: this.#shownName(b.owner, b.ownerName), ownerId: b.owner, plants: bedPlantsView(this.w, b), wateredWorldMs: b.wateredWorldMs, thirstMs: this.w.garden?.thirstWorldMs ?? 0, weedy: b.weedy, sponsors: b.sponsors.map((x) => this.#shownName(x.charId, x.name)), sponsorIds: b.sponsors.map((x) => x.charId) });
		}
		else if (type === "Field") {
			const f = fields as unknown as FieldFields, v = fieldView(this.w, f);
			this.#setObj(id, { id: f.fieldId, kind: "field", name: v.crop ? `Acker (${v.crop})` : "Acker", location: f.room, x: f.x, y: f.y, w: f.w, h: f.h, owner: this.#shownName(f.owner, f.ownerName), ownerId: f.owner, fieldStage: v.stage, progress: v.progress, ...(v.color ? { color: v.color } : {}), ...(v.model ? { cropModel: v.model } : {}), ...(f.open ? { open: true } : {}), ...(f.fenced ? { fenced: true } : {}) });
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
			if (!site && b.herd) this.#herds.set(b.buildId, b.herd); else this.#herds.delete(b.buildId);
			this.#setObj(id, { id: b.buildId, kind: site ? "site" : "building", name: b.name, location: b.room, x: b.x, y: b.y, w: b.w, h: b.h, owner: this.#shownName(b.owner, b.ownerName), ownerId: b.owner, plan: b.plan, ...(site ? { orders: this.#ordersOf(b.buildId) } : {}), ...(site ? { progress: total ? have / total : 0, missing } : {}), ...(color ? { color } : {}), ...(!site && b.herd ? { herd: b.herd.kind } : {}), ...(!site && b.keeper ? { keeper: b.keeper.kind } : {}), ...(!site && b.fenced ? { fenced: true } : {}) });
		}
		else if (type === "Flame") { const f = fields as unknown as FlameFields; this.#flames.set(f.beaconId, f.until); this.#flameOf.set(id, f.beaconId); }
		else if (type === "Wind") { const f = fields as unknown as WindFields; this.#winds.set(f.island, f.level); for (const c of this.#clients) if (c.room !== null && this.#rooms.get(c.room)?.island === f.island) c.ws.send({ t: "wind", wind: this.#windIn(c.room) } satisfies ServerFrame); }
		else if (type === "Fog") { const f = fields as unknown as FogFields; this.#fog.set(f.room, f.level); }
		else if (type === "Offer") this.#offers.set(id, fields as unknown as OfferFields);
		else if (type === "Order") this.#orders.set(id, fields as unknown as OrderFields);
		else if (type === "Listing") this.#listings.set(id, fields as unknown as ListingFields);
		else if (type === "Wanted") this.#wanted.set(id, fields as unknown as WantedFields);
		else if (type === "Notice") { const n = fields as unknown as NoticeFields; this.#notices.set(id, n); this.#tell(n.charId); }
		else if (type === "SeedRest") this.#seedRests.set(id, fields as unknown as SeedRestFields);
		else if (type === "Epoch") { this.#epochs.set(id, fields as unknown as EpochFields); this.#atlasChanged(); }
		else if (type === "Scenery") { const s = fields as unknown as SceneryFields; this.#setObj(id, { id: s.sceneryId, kind: "scenery", name: s.name, desc: sceneryText(this.w, s), location: s.room, x: s.x, y: s.y, w: s.w, h: s.h, model: s.model, left: s.left, ...(s.fixed ? { fixed: true } : {}), ...(s.through ? { through: true } : {}) }); }
		else if (type === "SiteOrder") { const o = fields as unknown as SiteOrderFields; this.#siteOrders.set(id, o); this.#showOrders(o.buildId); }
		else if (types.includes("Item") || types.includes("Exit")) {
			const o = types.includes("Item") ? itemView(fields as unknown as ItemFields, this.#protoIcons, this.w) : exitView(fields as unknown as ExitFields, this.w);
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
	/** The name of a character as it is now; `stored` when it is not known here. */
	#shownName(charId: string, stored: string): string { return this.#chars.get(charId)?.name ?? stored; }

	#setObj(id: string, o: ObjView): void {
		const prev = this.#objEntry.get(o.id);
		if (prev !== undefined && prev !== id) this.#objOf.delete(prev);
		this.#objs.set(o.id, o); this.#objOf.set(id, o.id); this.#objEntry.set(o.id, id);
	}

	#ordersOf(buildId: string): NonNullable<ObjView["orders"]> {
		return [...this.#siteOrders.values()].filter((o) => o.buildId === buildId).map((o) => ({ proto: o.proto, name: o.name, left: o.left, pay: o.pay }));
	}
	/** A site's orders changed: its pages see them on it. */
	#showOrders(buildId: string): void {
		const o = this.#objs.get(buildId);
		if (o) { o.orders = this.#ordersOf(buildId); this.#announceObj(buildId, o.location); }
	}

	#del(id: string): void {
		if (this.#millLoads.delete(id)) { this.#atlasChanged(); return; }
		const order = this.#siteOrders.get(id);
		if (order) { this.#siteOrders.delete(id); this.#showOrders(order.buildId); return; }
		if (this.#offers.delete(id) || this.#orders.delete(id) || this.#listings.delete(id) || this.#wanted.delete(id) || this.#notices.delete(id) || this.#seedRests.delete(id)) return;
		if (this.#epochs.delete(id)) { this.#atlasChanged(); return; }
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
			// a passenger of the large ship is gone from the room for the others
			if (visible && cl.room === c!.room && (!c!.aboard || cl.me.charId === charId)) cl.ws.send({ t: "char", c: charView(c!, this.#modelChars), ...(cl.me.charId === charId && c!.ack?.conn === cl.ws.id ? { ack: c!.ack.seq } : {}) } satisfies ServerFrame);
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
			seedRestUntilWorldMs: c.room ? Math.max(0, ...[...this.#seedRests.values()].filter((r) => r.charId === me && r.room === c.room).map((r) => r.untilWorldMs)) || null : null,
			listings: c.room && this.w.market.rooms.includes(c.room) ? listings.filter((l) => l.room === c.room).map((l, i) => ({ nr: i + 1, itemName: l.itemName, count: l.count ?? 1, price: l.price, sellerName: l.sellerName, mine: l.seller === me })) : null,
			wanted: c.room && this.w.market.rooms.includes(c.room) ? [...this.#wanted.values()].filter((w) => w.room === c.room).sort((a, b) => a.at - b.at || a.wantedId.localeCompare(b.wantedId)).map((w, i) => ({ nr: i + 1, protoName: w.protoName, count: w.count ?? 1, price: w.price, buyerName: w.buyerName, mine: w.buyer === me, replies: (w.replies ?? []).map((r) => ({ name: r.name, ask: r.ask })), traded: this.w.npcs.some((n) => (n.prices?.[w.proto]?.[1] ?? 0) > 0), until: this.#lapse(w.expiresWorldMs) })) : null,
		};
	}

	/** The overview: the rooms with a place on it (rooms builders dug have none) and the ways between them. */
	#atlas(): AtlasView {
		const rooms = [...this.#rooms.values()].filter((r) => r.map).map((r) => ({ roomId: r.roomId, name: r.name, island: r.island ?? "", x: r.map!.x, y: r.map!.y, ground: r.ground, fires: [...this.#objs.values()].filter((o) => o.kind === "beacon" && o.location === r.roomId).map(({ x, y }) => ({ x, y })), ...(this.w.market.rooms.includes(r.roomId) ? { market: true as const } : {}) }));
		const placed = new Set(rooms.map((r) => r.roomId)), links = new Map<string, [string, string]>();
		for (const e of this.w.exits) if (placed.has(e.room) && placed.has(e.destination)) links.set([e.room, e.destination].sort().join(" "), [e.room, e.destination].sort() as [string, string]);
		return { rooms, links: [...links.values()] };
	}

	/** What each character owns anywhere in the world (all regions come through this gateway). */
	#owned(): Map<string, AtlasOwned[]> {
		const out = new Map<string, AtlasOwned[]>();
		for (const o of this.#objs.values()) {
			if (!o.ownerId || (o.kind !== "site" && o.kind !== "building" && o.kind !== "bed" && o.kind !== "field" && o.kind !== "ruin")) continue;
			const list = out.get(o.ownerId) ?? [];
			list.push({ id: o.id, kind: o.kind, name: o.name, room: o.location, x: o.x, y: o.y, ...(o.plan ? { plan: o.plan } : {}) });
			out.set(o.ownerId, list);
		}
		return out;
	}

	/** The rooms with a jetty or a station and the rooms the roads join (a road beside an exit links its two ends, as the cart's own search sees it). */
	#stops(): AtlasState["stops"] {
		const built = (plan: string | undefined) => [...this.#objs.values()].filter((o) => o.kind === "building" && !!plan && o.plan === plan);
		const jetties = [...new Set(built(this.w.fishing?.plan).map((o) => o.location))], stations = [...new Set(built(this.w.rail?.plan).map((o) => o.location))];
		const roads = built(this.w.cart?.road), links: Array<[string, string]> = [];
		for (const e of this.w.exits) if (roads.some((r) => r.location === e.room && distTo(e, { x: r.x, y: r.y, w: r.w ?? 1, h: r.h ?? 1 }) <= EXIT_REACH)) links.push([e.room, e.destination]);
		return { jetties, stations, trainFare: this.w.rail?.fare ?? 1, roads: links };
	}

	#atlasState(c: Client, owned = this.#owned()): AtlasState {
		const people: Record<string, [number, number]> = {};
		for (const ch of this.#chars.values()) {
			if (!this.#online.get(ch.charId)) continue;
			const n = (people[ch.room] ??= [0, 0]);
			n[ch.charId.startsWith("npc-") ? 1 : 0]++;
		}
		const lit = this.w.beacons.filter((b) => this.#burns(this.#flames.get(b.beaconId) ?? 0)).map((b) => b.room);
		void setting(this.space, "beam.cost").then((n) => { this.#beamCost = n; }, () => {}); // the next state carries it
		void setting(this.space, "epoch.force").then((n) => { this.#epochForce = n; }, () => {});
		if (this.w.pack) void setting(this.space, "pack.max").then((n) => { this.#packMax = n; }, () => {});
		const todos = todosFor(c.me.charId, this.#objs.values(), this.#herds, this.#millLoads.values(), this.w, this.#clock ? worldNow(this.#clock, Date.now()) : null);
		return { todos, here: c.room ?? "", fog: Object.fromEntries(this.#fog), lit, people, mine: owned.get(c.me.charId) ?? [], epochs: !this.w.epochs ? null : this.#epochForce > 0 ? Object.fromEntries([...new Set(this.w.rooms.map((r) => r.island ?? ""))].map((i) => [i, this.#epochForce])) : Object.fromEntries([...this.#epochs.values()].map((e) => [e.island, e.epoch])), beamCost: this.#beamCost, packMax: this.w.pack ? this.#packMax ?? this.w.pack.max : null, stops: this.#stops() };
	}

	/** Something on the overview changed: its state goes out to every client once the short pause is over. */
	#atlasChanged(geometry = false): void {
		this.#atlasGeometryDirty ||= geometry;
		if (this.#atlasDue) return;
		this.#atlasDue = setTimeout(() => {
			this.#atlasDue = null;
			const owned = this.#owned(), atlas = this.#atlasGeometryDirty ? this.#atlas() : null;
			this.#atlasGeometryDirty = false;
			for (const c of this.#clients) if (c.atlas) {
				if (atlas) c.ws.send({ t: "atlas", atlas } satisfies ServerFrame);
				c.ws.send({ t: "atlasState", state: this.#atlasState(c, owned) } satisfies ServerFrame);
			}
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
