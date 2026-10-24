// The gateway of the web process (docs/architektur.md, "Datenfluss zum Browser"): one WebSocket per playing browser.
// Inbound it turns command lines into Intent entries; outbound it follows the world space's change stream once and
// hands each client what concerns its room: characters that are online there, and messages to the room or to it.
// A character is online while a Session entry for it lives; the gateway holds one per open WebSocket and renews its
// lease, so a web process that dies takes its players offline within the lease.
import { randomBytes } from "node:crypto";
import type { SpaceLike } from "phi-spaces";
import type { Me } from "./accounts.ts";
import type { WorldDef } from "./engine/world.ts";
import { asFields, type CharacterFields, type IntentFields, type MsgFields, type RoomFields, type SessionFields } from "./model.ts";
import { envMs } from "./space.ts";
import type { WsConnection } from "./ws.ts";

/** What a client sees of a character. */
export type CharView = { charId: string; name: string; x: number; y: number; skin: number };
/** Frames to the browser. */
export type ServerFrame =
	| { t: "hello"; world: Pick<WorldDef, "id" | "title" | "tileSize" | "tiles" | "skins">; me: { charId: string; name: string; guest: boolean; admin: boolean }; room: RoomFields; chars: CharView[]; log: MsgView[] }
	| { t: "char"; c: CharView }
	| { t: "gone"; charId: string }
	| { t: "msg"; m: MsgView };
export type MsgView = Pick<MsgFields, "kind" | "text" | "from" | "at">;
/** Frames from the browser. */
export type ClientFrame = { t: "cmd"; line: string };

const MAX_LINE = 300;
const RECENT = 40;
const INTENT_LEASE_MS = 30_000;

type Client = { ws: WsConnection; me: Me; room: string | null; lease: string | null; timer: ReturnType<typeof setInterval> | null };

const view = (c: CharacterFields): CharView => ({ charId: c.charId, name: c.name, x: c.x, y: c.y, skin: c.skin });

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
	readonly #recent = new Map<string, MsgView[]>(); // room -> last messages to everyone there
	#applied = -1; // the revision the state above reflects
	readonly #waiting = new Set<{ rev: number; ok: () => void }>();
	#watch: Promise<void>;

	private readonly space: SpaceLike;
	private readonly w: WorldDef;
	private readonly onActivity: (accountId: string) => void;

	constructor(space: SpaceLike, w: WorldDef, onActivity: (accountId: string) => void = () => {}) {
		this.space = space; this.w = w; this.onActivity = onActivity;
		let ready!: () => void;
		this.#ready = new Promise((r) => (ready = r));
		this.#watch = this.#follow(ready);
	}

	/** A browser of `me` plays now. */
	async attach(ws: WsConnection, me: Me): Promise<void> {
		const c: Client = { ws, me, room: null, lease: null, timer: null };
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

	async close(): Promise<void> {
		this.#closed = true;
		for (const c of [...this.#clients]) c.ws.close();
		await this.#watch.catch(() => {});
	}

	async #inbound(c: Client, text: string): Promise<void> {
		let f: ClientFrame;
		try { f = JSON.parse(text); } catch { return; }
		if (f?.t !== "cmd" || typeof f.line !== "string") return;
		const line = f.line.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LINE);
		if (!line) return;
		const intent: IntentFields = { intentId: randomBytes(8).toString("hex"), charId: c.me.charId, line, at: Date.now() };
		try { await this.space.write({ type: "Intent", fields: asFields(intent) }, null, INTENT_LEASE_MS); }
		catch { c.ws.send({ t: "msg", m: { kind: "error", text: "Die Welt ist gerade nicht erreichbar; bitte gleich noch einmal.", from: "", at: Date.now() } } satisfies ServerFrame); }
		this.onActivity(c.me.accountId);
	}

	#hello(c: Client): void {
		const self = this.#chars.get(c.me.charId);
		const room = self ? this.#rooms.get(self.room) : undefined;
		if (!self || !room) { c.ws.send({ t: "msg", m: { kind: "error", text: "Deine Figur ist noch nicht in der Welt angekommen.", from: "", at: Date.now() } } satisfies ServerFrame); return; }
		c.room = self.room;
		const chars = [...this.#chars.values()].filter((ch) => ch.room === self.room && (ch.charId === self.charId || this.#online.get(ch.charId))).map(view);
		c.ws.send({ t: "hello", world: { id: this.w.id, title: this.w.title, tileSize: this.w.tileSize, tiles: this.w.tiles, skins: this.w.skins }, me: { charId: self.charId, name: self.name, guest: c.me.guest, admin: c.me.admin }, room, chars, log: this.#recent.get(self.room) ?? [] } satisfies ServerFrame);
	}

	/** Reads the world once (from a revision taken before the reads) and then follows the change stream. Replaying ops
	 *  that the reads already showed is harmless: a put replaces, a del removes. */
	async #follow(ready: () => void): Promise<void> {
		let rev = -1;
		while (!this.#closed) {
			try {
				if (rev < 0) {
					rev = (await this.space.readPage({ type: "-" })).rev;
					for (const e of await this.space.readAll({ type: "Room" })) this.#put(e.id, e.type, e.fields);
					for (const e of await this.space.readAll({ type: "Character" })) this.#put(e.id, e.type, e.fields);
					for (const e of await this.space.readAll({ type: "Session" })) this.#put(e.id, e.type, e.fields);
					for (const e of await this.space.readAll({ type: "Msg", fields: { to: "*" } })) this.#put(e.id, e.type, e.fields);
					this.#advance(rev);
					ready();
					for (const c of this.#clients) this.#hello(c); // after a restart of the stream
				}
				const ch = await (this.space.changes as (r: number, o: { waitMs: number }) => ReturnType<SpaceLike["changes"]>)(rev, { waitMs: 20_000 });
				for (const b of ch.batches) {
					const touched = new Map<string, string | null>(); // charId -> room before the batch
					const before = (id: string) => { if (!touched.has(id)) touched.set(id, this.#chars.get(id)?.room ?? null); };
					for (const op of b.ops) {
						if (op.op === "put") {
							const charId = op.type === "Character" ? String(op.fields.charId) : op.type === "Session" ? String(op.fields.charId) : null;
							if (charId) before(charId);
							this.#put(op.id, op.type, op.fields);
						} else {
							const charId = this.#charOf.get(op.id) ?? this.#sessions.get(op.id);
							if (charId) before(charId);
							this.#del(op.id);
						}
					}
					for (const [charId, roomBefore] of touched) this.#announce(charId, roomBefore);
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
		this.#chars.clear(); this.#charOf.clear(); this.#sessions.clear(); this.#online.clear(); this.#rooms.clear(); this.#recent.clear();
	}

	#put(id: string, type: string, fields: Record<string, unknown>): void {
		if (type === "Room") { const r = fields as unknown as RoomFields; this.#rooms.set(r.roomId, r); }
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
		else if (type === "Msg") {
			const m = fields as unknown as MsgFields;
			const v: MsgView = { kind: m.kind, text: m.text, from: m.from, at: m.at };
			if (m.to === "*") {
				const list = this.#recent.get(m.room) ?? [];
				list.push(v); if (list.length > RECENT) list.shift();
				this.#recent.set(m.room, list);
			}
			for (const c of this.#clients) if (m.to === "*" ? c.room === m.room : c.me.charId === m.to) c.ws.send({ t: "msg", m: v } satisfies ServerFrame);
		}
	}

	#del(id: string): void {
		const charId = this.#charOf.get(id);
		if (charId) { this.#charOf.delete(id); if (![...this.#charOf.values()].includes(charId)) this.#chars.delete(charId); return; }
		const s = this.#sessions.get(id);
		if (s) { this.#sessions.delete(id); const n = (this.#online.get(s) ?? 1) - 1; if (n > 0) this.#online.set(s, n); else this.#online.delete(s); }
	}

	/** After a batch: tells the clients of the character's room (and of the room it left) where it is now. */
	#announce(charId: string, roomBefore: string | null): void {
		const c = this.#chars.get(charId);
		const visible = !!c && !!this.#online.get(charId);
		for (const cl of this.#clients) {
			if (cl.me.charId === charId && c && cl.room !== c.room) { this.#hello(cl); continue; } // its own room changed
			if (visible && cl.room === c!.room) cl.ws.send({ t: "char", c: view(c!) } satisfies ServerFrame);
			else if (cl.room !== null && (cl.room === roomBefore || cl.room === c?.room)) cl.ws.send({ t: "gone", charId } satisfies ServerFrame);
		}
	}
}
