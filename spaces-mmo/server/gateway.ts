// The gateway of the web process (docs/architektur.md, "Datenfluss zum Browser"): one WebSocket per playing browser.
// Inbound it turns command lines into Intent entries; outbound it follows the world space's change stream once and
// hands each client what concerns it: the characters online in its room, the things lying there and its exits, what
// it carries, and messages to the room or to it, rendered for it (FuncParser: $you(), $conj()).
// A character is online while a Session entry for it lives; the gateway holds one per open WebSocket and renews its
// lease, so a web process that dies takes its players offline within the lease.
import { randomBytes } from "node:crypto";
import type { SpaceLike } from "phi-spaces";
import type { Me } from "./accounts.ts";
import { render } from "./engine/funcparser.ts";
import type { WorldDef } from "./engine/world.ts";
import { msUntilWorld, viewOf, worldNow, type WorldTimeView } from "./engine/worldtime.ts";
import { asFields, type ListingFields, type OfferFields, type OrderFields, type BeaconFields, type FlameFields, type FogFields, type CharacterFields, type ExitFields, type Glyph, type IntentFields, type ItemFields, type MsgFields, type RoomFields, type SessionFields, type WorldClockFields } from "./model.ts";
import { envMs } from "./space.ts";
import type { WsConnection } from "./ws.ts";

/** What a client sees of a character. */
export type CharView = { charId: string; name: string; x: number; y: number; skin: number; ai?: true };
/** What a client sees of a thing or an exit: on the map when `location` is its room, in its pack when it is its charId. */
/** `icon`: the URL of a thing's picture (from its prototype); the map draws the glyph without one. */
export type ObjView = { id: string; kind: "item" | "exit" | "beacon"; name: string; location: string; x: number; y: number; glyph?: Glyph; icon?: string; until?: number };
/** `toMe`: meant for the viewer and from someone else: said to them alone (an offer, a sale), or naming them. */
export type MsgView = Pick<MsgFields, "kind" | "text" | "from" | "at"> & { ai?: true; toMe?: true };
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
	| { t: "hello"; build: string | null; world: Pick<WorldDef, "id" | "title" | "tileSize" | "tiles" | "skins" | "decor"> & { fuels: string[]; icons: string[] }; me: { charId: string; name: string; guest: boolean; admin: boolean }; room: RoomFields; chars: CharView[]; objs: ObjView[]; log: MsgView[]; fog: number; now: number; worldTime: WorldTimeView | null }
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
	| { t: "atlasState"; state: AtlasState };
/** Frames from the browser. */
/** Frames from the browser: a typed command, or a numbered step of the own character (the page walks ahead of the
 *  server and matches the answers by number, client/walk.ts). */
export type ClientFrame = { t: "cmd"; line: string } | { t: "step"; seq: number; dx: number; dy: number };

const MAX_LINE = 300;
const RECENT = 40;
const INTENT_LEASE_MS = 30_000;
/** Against a flood of steps (the page paces them itself, client/walk.ts, at most one per WALK_MS): a client may have
 *  STEP_BURST steps in hand and gets one back every STEP_REFILL_MS; a step beyond that is dropped (the page then
 *  resynchronizes after a while). The page's pace never reaches the limit. */
const STEP_BURST = 8, STEP_REFILL_MS = 100;

type Client = { ws: WsConnection; me: Me; room: string | null; lease: string | null; timer: ReturnType<typeof setInterval> | null; atlas?: boolean; steps?: { left: number; at: number };
	/** The client's commands, one after another (a step counts the ones waiting before it). */ chain: Promise<void> };
/** At most this often the overview's state goes out after a change (people walk, fires burn down, fog moves). */
const ATLAS_MS = 1_000;

/** The characters a model plays (docs/modell-npcs.md: marked as AI wherever they appear). */
let modelChars = new Set<string>(), modelNames = new Set<string>();
const charView = (c: CharacterFields): CharView => ({ charId: c.charId, name: c.name, x: c.x, y: c.y, skin: c.skin, ...(modelChars.has(c.charId) ? { ai: true as const } : {}) });
/** Prototype key → the URL of its icon (set from the world when the gateway starts). */
let protoIcons = new Map<string, string>();
const itemView = (f: ItemFields): ObjView => ({ id: f.itemId, kind: "item", name: f.name, location: f.location, x: f.x, y: f.y, glyph: f.glyph, ...(protoIcons.has(f.proto) ? { icon: protoIcons.get(f.proto)! } : {}) });
const exitView = (f: ExitFields): ObjView => ({ id: f.exitId, kind: "exit", name: f.name, location: f.location, x: f.x, y: f.y });
const msgView = (m: MsgFields, viewer: string, viewerName = ""): MsgView => ({ kind: m.kind, text: m.actor ? render(m.text, { viewer, actor: m.actor, actorName: m.from }) : m.text, from: m.from, at: m.at, ...(modelNames.has(m.from) ? { ai: true as const } : {}), ...(forViewer(m, viewer, viewerName) ? { toMe: true as const } : {}) });
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
	readonly #sessions = new Map<string, string>(); // session entry id -> charId
	readonly #online = new Map<string, number>(); // charId -> live sessions
	readonly #rooms = new Map<string, RoomFields>();
	readonly #objs = new Map<string, ObjView>(); // by itemId / exitId
	readonly #objOf = new Map<string, string>(); // space entry id -> itemId / exitId
	readonly #recent = new Map<string, MsgFields[]>(); // room -> last messages to everyone there
	readonly #flames = new Map<string, number>(); // beaconId -> until, in world time
	readonly #flameOf = new Map<string, string>(); // flame entry id -> beaconId
	readonly #fog = new Map<string, number>(); // room -> level
	#clock: WorldClockFields | null = null; // the world's clock entry (docs/weltzeit.md)
	#clockTimer: ReturnType<typeof setInterval> | null = null;
	readonly #offers = new Map<string, OfferFields>(); // entry id -> offer
	readonly #orders = new Map<string, OrderFields>(); // entry id -> order
	readonly #listings = new Map<string, ListingFields>(); // entry id -> listing
	#applied = -1; // the revision the state above reflects
	#atlasDue: ReturnType<typeof setTimeout> | null = null;
	readonly #waiting = new Set<{ rev: number; ok: () => void }>();
	#watch: Promise<void>;

	private readonly space: SpaceLike;
	private readonly w: WorldDef;
	private readonly onActivity: (accountId: string) => void;
	private readonly build: string | null;

	constructor(space: SpaceLike, w: WorldDef, onActivity: (accountId: string) => void = () => {}, build: string | null = null) {
		this.space = space; this.w = w; this.onActivity = onActivity; this.build = build;
		modelChars = new Set(w.npcs.filter((n) => n.model).map((n) => `npc-${n.npcId}`));
		protoIcons = new Map(w.prototypes.filter((p) => p.icon).map((p) => [p.key, `/assets/${w.id}/${p.icon}`]));
		modelNames = new Set(w.npcs.filter((n) => n.model).map((n) => n.name));
		let ready!: () => void;
		this.#ready = new Promise((r) => (ready = r));
		this.#watch = this.#follow(ready);
		// a regular reminder, so a browser that was hidden or lost frames shows the same hour again
		this.#clockTimer = setInterval(() => this.#broadcastTime(), 30_000);
		this.#clockTimer.unref?.();
	}

	/** A browser of `me` plays now. */
	async attach(ws: WsConnection, me: Me): Promise<void> {
		const c: Client = { ws, me, room: null, lease: null, timer: null, chain: Promise.resolve() };
		this.#clients.add(c);
		ws.onClose(() => {
			this.#clients.delete(c);
			if (c.timer) clearInterval(c.timer);
			if (c.lease) void this.space.cancel(c.lease).catch(() => {});
		});
		ws.onMessage((text) => this.#inbound(c, text));
		await this.#ready;
		const keep = async () => {
			try {
				if (c.lease) { try { await this.space.renew(c.lease, this.sessionLeaseMs); return; } catch { c.lease = null; } }
				if (!this.#clients.has(c)) return;
				c.lease = (await this.space.write({ type: "Session", fields: asFields<SessionFields>({ sessionId: ws.id, charId: me.charId, accountId: me.accountId }) }, null, this.sessionLeaseMs)).id;
				if (!this.#clients.has(c)) await this.space.cancel(c.lease).catch(() => {}); // closed while writing
			} catch (e) { console.error("[gateway] session:", (e as Error).message); }
		};
		await keep();
		// online now: if someone else stands on this character's cell meanwhile, the world moves it to a free one
		await this.#intent(c, "arrive");
		c.timer = setInterval(() => void keep(), Math.max(1000, Math.floor(this.sessionLeaseMs / 3)));
		c.timer.unref?.();
		// read your writes: the hello is built from the stream, so it waits until the stream has caught up with the space
		// as it is now (the player's own session, a registration that just renamed its character)
		await this.#reach((await this.space.readPage({ type: "-" })).rev).catch(() => {});
		this.#hello(c);
	}

	/** Resolves once the change stream has been applied up to `rev` (rejects after `ms`). */
	#reach(rev: number, ms = 5_000): Promise<void> {
		if (this.#applied >= rev) return Promise.resolve();
		return new Promise((ok, fail) => {
			const w = { rev, ok: () => { clearTimeout(timer); ok(); } };
			const timer = setTimeout(() => { this.#waiting.delete(w); fail(new Error(`change stream behind revision ${rev}`)); }, ms);
			this.#waiting.add(w);
		});
	}

	#advance(rev: number): void {
		this.#applied = rev;
		for (const w of this.#waiting) if (w.rev <= rev) { this.#waiting.delete(w); w.ok(); }
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
		await this.#watch.catch(() => {});
	}

	async #inbound(c: Client, text: string): Promise<void> {
		let f: ClientFrame;
		try { f = JSON.parse(text); } catch { return; }
		if (f?.t === "step") {
			const { seq, dx, dy } = f;
			if (!Number.isSafeInteger(seq) || ![dx, dy].every((d) => d === -1 || d === 0 || d === 1) || Math.abs(dx) + Math.abs(dy) !== 1) return;
			c.chain = c.chain.then(() => this.#intent(c, `step ${dx} ${dy}`, { conn: c.ws.id, seq }));
			await c.chain;
			this.onActivity(c.me.accountId);
			return;
		}
		if (f?.t !== "cmd" || typeof f.line !== "string") return;
		const line = f.line.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LINE);
		if (!line) return;
		c.chain = c.chain.then(() => this.#intent(c, line));
		await c.chain;
		this.onActivity(c.me.accountId);
	}

	async #intent(c: Client, line: string, step?: { conn: string; seq: number }): Promise<void> {
		// a flood of steps (a stuck key, a script) is dropped beyond the burst; the page's pace never reaches the limit
		if (/^step\s/.test(line)) {
			const now = Date.now(), b = c.steps ?? { left: STEP_BURST, at: now };
			b.left = Math.min(STEP_BURST, b.left + (now - b.at) / STEP_REFILL_MS); b.at = now;
			c.steps = b;
			if (b.left < 1) return;
			b.left -= 1;
		}
		const intent: IntentFields = { intentId: randomBytes(8).toString("hex"), charId: c.me.charId, line, at: Date.now(), ...(step ? { step } : {}) };
		try { await this.space.write({ type: "Intent", fields: asFields(intent) }, null, INTENT_LEASE_MS); }
		catch { c.ws.send({ t: "msg", m: { kind: "error", text: "Die Welt ist gerade nicht erreichbar; bitte gleich noch einmal.", from: "", at: Date.now() } } satisfies ServerFrame); }
	}

	#hello(c: Client): void {
		const self = this.#chars.get(c.me.charId);
		const room = self ? this.#rooms.get(self.room) : undefined;
		if (!self || !room) { c.ws.send({ t: "msg", m: { kind: "error", text: "Deine Figur ist noch nicht in der Welt angekommen.", from: "", at: Date.now() } } satisfies ServerFrame); return; }
		c.room = self.room;
		const chars = [...this.#chars.values()].filter((ch) => ch.room === self.room && (ch.charId === self.charId || this.#online.get(ch.charId))).map(charView);
		const objs = [...this.#objs.values()].filter((o) => o.location === self.room || o.location === self.charId).map((o) => this.#view(o));
		const log = (this.#recent.get(self.room) ?? []).map((m) => msgView(m, self.charId, self.name));
		queueMicrotask(() => {
			c.ws.send({ t: "trade", trade: this.#trade(c) } satisfies ServerFrame);
			if (!c.atlas) { c.atlas = true; c.ws.send({ t: "atlas", atlas: this.#atlas() } satisfies ServerFrame); }
			c.ws.send({ t: "atlasState", state: this.#atlasState(c) } satisfies ServerFrame);
		});
		c.ws.send({ t: "hello", build: this.build, world: { id: this.w.id, title: this.w.title, tileSize: this.w.tileSize, tiles: this.w.tiles, skins: this.w.skins, ...(this.w.decor ? { decor: this.w.decor } : {}), fuels: Object.keys(this.w.fire.fuel).map((k) => this.w.prototypes.find((p) => p.key === k)?.name ?? k), icons: [...new Set(protoIcons.values())] }, me: { charId: self.charId, name: self.name, guest: c.me.guest, admin: c.me.admin }, room, chars, objs, log, fog: this.#fog.get(self.room) ?? 0, now: Date.now(), worldTime: this.#worldTime() } satisfies ServerFrame);
	}

	/** Reads the world once (from a revision taken before the reads) and then follows the change stream. Replaying ops
	 *  that the reads already showed is harmless: a put replaces, a del removes. */
	async #follow(ready: () => void): Promise<void> {
		let rev = -1;
		while (!this.#closed) {
			try {
				if (rev < 0) {
					rev = (await this.space.readPage({ type: "-" })).rev;
					const msgs: MsgFields[] = [];
					for (const type of ["Room", "Character", "Session", "Item", "Exit", "Beacon", "Flame", "Fog", "WorldClock", "Offer", "Order", "Listing"]) for (const e of await this.space.readAll({ type })) this.#put(e.id, e.type, e.types, e.fields, msgs);
					for (const e of await this.space.readAll({ type: "Msg", fields: { to: "*" } })) this.#put(e.id, e.type, e.types, e.fields, msgs);
					this.#advance(rev);
					ready();
					for (const c of this.#clients) this.#hello(c); // after a restart of the stream
				}
				const ch = await (this.space.changes as (r: number, o: { waitMs: number }) => ReturnType<SpaceLike["changes"]>)(rev, { waitMs: 20_000 });
				for (const b of ch.batches) {
					const chars = new Map<string, string | null>(); // charId -> room before the batch
					const objs = new Map<string, string | null>(); // objId -> location before the batch
					const msgs: MsgFields[] = [];
					const fogs = new Set<string>(); // rooms whose fog changed
					let trade = false; // offers, orders or listings changed
					let clock = false; // the world clock was written
					const touch = (entryId: string, fields?: Record<string, unknown>, types?: string[]) => {
						const charId = this.#charOf.get(entryId) ?? this.#sessions.get(entryId) ?? (fields && (types?.includes("Character") || types?.includes("Session")) ? String(fields.charId) : undefined);
						if (charId && !chars.has(charId)) chars.set(charId, this.#chars.get(charId)?.room ?? null);
						const objId = this.#objOf.get(entryId) ?? this.#flameOf.get(entryId) ?? (fields && types?.includes("Item") ? String(fields.itemId) : fields && types?.includes("Exit") ? String(fields.exitId) : fields && (types?.includes("Beacon") || types?.includes("Flame")) ? String(fields.beaconId) : undefined);
						if (fields && types?.includes("Fog")) fogs.add(String(fields.room));
						if (objId && !objs.has(objId)) objs.set(objId, this.#objs.get(objId)?.location ?? null);
					};
					for (const op of b.ops) {
						// a renewed session is the same session: the character did not change, nothing to announce
						if (op.op === "put") { clock ||= op.type === "WorldClock"; if (!(op.type === "Session" && this.#sessions.has(op.id))) touch(op.id, op.fields, op.types); trade ||= ["Offer", "Order", "Listing"].includes(op.type); this.#put(op.id, op.type, op.types, op.fields, msgs); }
						else { touch(op.id); trade ||= this.#offers.has(op.id) || this.#orders.has(op.id) || this.#listings.has(op.id); this.#del(op.id); }
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
					for (const m of msgs) for (const c of this.#clients) if (m.to.startsWith("#") || (m.to === "*" ? c.room === m.room : c.me.charId === m.to)) c.ws.send({ t: "msg", m: msgView(m, c.me.charId, this.#chars.get(c.me.charId)?.name) } satisfies ServerFrame);
				}
				rev = ch.next;
				this.#advance(rev);
			} catch (e) {
				if (this.#closed) break;
				const m = (e as Error).message;
				// the history moved past the cursor (or the space restarted): read everything again from now
				if (/no longer kept|expired|ahead/i.test(m)) { this.#reset(); rev = -1; continue; }
				console.error("[gateway] change stream:", m);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	}

	#reset(): void {
		this.#clock = null;
		for (const m of [this.#chars, this.#charOf, this.#sessions, this.#online, this.#rooms, this.#objs, this.#objOf, this.#recent, this.#flames, this.#flameOf, this.#fog, this.#offers, this.#orders, this.#listings]) m.clear();
	}

	/** Applies a put; a message is collected in `msgs` to be sent after the batch. */
	#put(id: string, type: string, types: string[], fields: Record<string, unknown>, msgs: MsgFields[]): void {
		if (type === "WorldClock") this.#clock = fields as unknown as WorldClockFields;
		else if (type === "Room") { const r = fields as unknown as RoomFields; this.#rooms.set(r.roomId, r); }
		else if (type === "Character") {
			const c = fields as unknown as CharacterFields;
			for (const [eid, cid] of this.#charOf) if (cid === c.charId && eid !== id) this.#charOf.delete(eid);
			this.#chars.set(c.charId, c); this.#charOf.set(id, c.charId);
		}
		else if (type === "Session") {
			if (this.#sessions.has(id)) return; // a renewal
			const s = fields as unknown as SessionFields;
			this.#sessions.set(id, s.charId); this.#online.set(s.charId, (this.#online.get(s.charId) ?? 0) + 1);
		}
		else if (type === "Beacon") {
			const b = fields as unknown as BeaconFields;
			const o: ObjView = { id: b.beaconId, kind: "beacon", name: b.name, location: b.room, x: b.x, y: b.y };
			for (const [eid, oid] of this.#objOf) if (oid === o.id && eid !== id) this.#objOf.delete(eid);
			this.#objs.set(o.id, o); this.#objOf.set(id, o.id);
		}
		else if (type === "Flame") { const f = fields as unknown as FlameFields; this.#flames.set(f.beaconId, f.until); this.#flameOf.set(id, f.beaconId); }
		else if (type === "Fog") { const f = fields as unknown as FogFields; this.#fog.set(f.room, f.level); }
		else if (type === "Offer") this.#offers.set(id, fields as unknown as OfferFields);
		else if (type === "Order") this.#orders.set(id, fields as unknown as OrderFields);
		else if (type === "Listing") this.#listings.set(id, fields as unknown as ListingFields);
		else if (types.includes("Item") || types.includes("Exit")) {
			const o = types.includes("Item") ? itemView(fields as unknown as ItemFields) : exitView(fields as unknown as ExitFields);
			for (const [eid, oid] of this.#objOf) if (oid === o.id && eid !== id) this.#objOf.delete(eid);
			this.#objs.set(o.id, o); this.#objOf.set(id, o.id);
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

	#del(id: string): void {
		if (this.#offers.delete(id) || this.#orders.delete(id) || this.#listings.delete(id)) return;
		const beaconId = this.#flameOf.get(id);
		if (beaconId) { this.#flameOf.delete(id); if (![...this.#flameOf.values()].includes(beaconId)) this.#flames.delete(beaconId); return; }
		const charId = this.#charOf.get(id);
		if (charId) { this.#charOf.delete(id); if (![...this.#charOf.values()].includes(charId)) this.#chars.delete(charId); return; }
		const objId = this.#objOf.get(id);
		if (objId) { this.#objOf.delete(id); if (![...this.#objOf.values()].includes(objId)) this.#objs.delete(objId); return; }
		const s = this.#sessions.get(id);
		if (s) { this.#sessions.delete(id); const n = (this.#online.get(s) ?? 1) - 1; if (n > 0) this.#online.set(s, n); else this.#online.delete(s); }
	}

	/** After a batch: tells the clients of the character's room (and of the room it left) where it is now. */
	#announce(charId: string, roomBefore: string | null): void {
		const c = this.#chars.get(charId);
		const visible = !!c && !!this.#online.get(charId);
		for (const cl of this.#clients) {
			// its own room changed (a client not greeted yet gets its hello from attach)
			if (cl.me.charId === charId && c && cl.room !== null && cl.room !== c.room) { this.#hello(cl); continue; }
			if (visible && cl.room === c!.room) cl.ws.send({ t: "char", c: charView(c!), ...(cl.me.charId === charId && c!.ack?.conn === cl.ws.id ? { ack: c!.ack.seq } : {}) } satisfies ServerFrame);
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
