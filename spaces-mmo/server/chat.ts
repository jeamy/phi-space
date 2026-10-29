// Chat between players (docs/siedeln.md, "Chat zwischen Spielern"): talks between two, groups by invitation, blocks,
// reports. It runs in the web process and keeps its entries in the accounts space: the one space every region shares
// and only the web process reaches (the dashboard leaves it out). A chat line never reaches the world: no world worker,
// no translation, no NPC and no model reads it.
//
// Messages are end-to-end encrypted (client/chatcrypto.ts): the page seals a copy for every reader with that reader's
// public key and sends the boxes (frame "chatsend"); this module checks who may read the talk and keeps each copy as a
// ChatMsg entry with a lease. It never sees a text: a typed "chat <name> <text>" is sealed by the page before it is sent,
// and a plain one is refused. What it does see is who talks to whom and when, group names and members. Each account's
// key is a ChatKey entry: the public key and the private key sealed with the player's chat password (a backup only the
// player can open, so another device reads the same talks). The notes of a group (someone joined or left) are plain.
// What arrives while a reader is away waits for the next login, and the last messages of each talk come back with every
// page. The gateway is told of new messages, invitations and memberships by the accounts space's change stream.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, RevisionAhead, SnapshotExpired, type SpaceLike } from "phi-spaces";
import { envMs } from "./space.ts";

/** `box`: the sealed copy (JSON of client/chatcrypto.ts Box); `note`: a plain note of a group instead. */
export type ChatMsgFields = { msgId: string; to: string; conv: string; title: string; fromId: string; fromName: string; box?: string; note?: string; at: number };
export type ChatKeyFields = { accountId: string; pub: string; wrapped: string; salt: string; iter: number; at: number };
type Box = { iv: string; ct: string; pub: string };
export type ChatGroupFields = { groupId: string; name: string; key: string; owner: string; at: number };
export type ChatMemberFields = { groupId: string; accountId: string; at: number };
export type ChatInviteFields = { inviteId: string; groupId: string; to: string; fromId: string; at: number };
export type ChatBlockFields = { who: string; whom: string; at: number };
export type ChatReportFields = { reportId: string; by: string; byName: string; fromId: string; fromName: string; text: string; at: number };

/** A talk as the page shows it: with one person (`id` their account) or a group (`id` the group). */
export type ChatConv = { kind: "dm" | "group"; id: string; title: string };
/** A message as the page gets it: sealed (`box`, the page opens it) or a note of the group (`note`, `from` empty). */
export type ChatView = { id: string; conv: ChatConv; from: string; fromId: string; at: number; mine?: true; box?: Box; note?: string };
/** A key backup as the page sends and gets it (client/chatcrypto.ts KeyBackup). */
export type ChatKeyView = { pub: string; wrapped: string; salt: string; iter: number };
/** The player's groups (with the names of their members), the invitations waiting and whom they ignore. */
export type ChatState = { groups: Array<{ groupId: string; name: string; members: string[]; owner: boolean }>; invites: Array<{ groupId: string; name: string; from: string }>; blocked: string[] };
export type ChatFrame =
	| { t: "chat"; m: ChatView }
	| { t: "chatlog"; msgs: ChatView[] }
	| { t: "chats"; state: ChatState }
	| { t: "chatopen"; conv: ChatConv }
	/** The player's account and key backup (null: no chat key yet). */
	| { t: "chatme"; accountId: string; key: ChatKeyView | null }
	/** The readers of a talk with their public keys (the page seals a copy for each); `missing`: readers without a key. */
	| { t: "chatkeys"; conv: ChatConv; readers: Array<{ accountId: string; name: string; pub: string }>; missing: string[]; req: number };
/** Frames of the page for chat (besides the text commands). */
export type ChatClientFrame =
	| { t: "chatkey"; key: ChatKeyView; replace?: boolean }
	| { t: "chatkeys"; conv: { kind: "dm" | "group"; id: string }; req: number }
	| { t: "chatsend"; msgId: string; conv: { kind: "dm" | "group"; id: string }; copies: Array<{ to: string; box: Box }> }
	| { t: "chatreport"; msgId: string; text: string };
type Note = { t: "msg"; m: { kind: "info" | "error"; text: string; from: string; at: number } };

/** Someone chat can address: a player's account and the name of their character. */
export type ChatUser = { accountId: string; name: string; guest: boolean };
export type ChatHooks = {
	/** The player of that character name (case-insensitive), "npc" for an NPC, null for nobody. */
	person(name: string): ChatUser | "npc" | null;
	/** The current name of an account's character (a registration renames a guest's). */
	nameOf(accountId: string): string;
	/** To every open page of the account (in this web process). */
	send(accountId: string, f: ChatFrame | Note): void;
	/** Whether the account has a page open here. */
	online(accountId: string): boolean;
};

class ChatError extends Error {}

/** The words a chat line starts with; everything else goes to the world. */
const LINE = /^(chat|tell|whisper|flüstere|fluestere|flüster|gruppe|group|ignoriere|ignore|erlaube|unignore|melde|report)(?=\s|$)/i;
const SUB = new Set(["neu", "new", "lade", "invite", "annehmen", "accept", "ablehnen", "decline", "verlasse", "leave", "entferne", "remove"]);
const GROUP_NAME = /^[\p{L}\p{N}_-]{2,20}$/u;
const MAX_BOX = 4000;
const B64 = /^[A-Za-z0-9+/=]+$/;
/** How long a message stays (for the next login and the talk's history), how many of a talk each reader keeps, how long
 *  an invitation waits, how big a group gets, how many one founds, how long a report stays. */
const MSG_MS = () => envMs("SPACES_MMO_CHAT_MSG_MS", 7 * 24 * 3600_000);
const KEEP = 50;
const INVITE_MS = () => envMs("SPACES_MMO_CHAT_INVITE_MS", 24 * 3600_000);
const GROUP_MAX = 20, OWN_MAX = 10;
const REPORT_MS = 30 * 24 * 3600_000;
const id = () => randomBytes(8).toString("hex");
const fields = <T>(e: { fields: Record<string, unknown> }) => e.fields as unknown as T;

export const isChatLine = (line: string) => LINE.test(line);
export const isChatFrame = (f: { t?: unknown }): f is ChatClientFrame => f.t === "chatkey" || f.t === "chatkeys" || f.t === "chatsend" || f.t === "chatreport";
const NOT_PLAIN = "Chat-Nachrichten gehen nur verschlüsselt, aus dem Chat der Seite (Reiter „Chats“); dort richtest du ihn mit einem Chat-Passwort ein.";

export class Chat {
	#closed = false;
	readonly #follow: Promise<void>;
	/** The accounts a known chat entry concerns, by entry id (a removal names only the id). */
	readonly #concerns = new Map<string, { accounts: string[]; group?: string }>();
	private readonly space: SpaceLike;
	private readonly hooks: ChatHooks;
	constructor(space: SpaceLike, hooks: ChatHooks) {
		this.space = space; this.hooks = hooks;
		this.#follow = this.#run();
	}
	async close(): Promise<void> { this.#closed = true; await this.#follow.catch(() => {}); }

	/** A new page of `me`: the talks so far (what came meanwhile among them) and the state. */
	async attach(me: ChatUser, send: (f: ChatFrame) => void): Promise<void> {
		const msgs = (await this.space.readAll({ type: "ChatMsg", fields: { to: me.accountId } })).map((e) => fields<ChatMsgFields>(e)).sort((a, b) => a.at - b.at);
		send({ t: "chatme", accountId: me.accountId, key: await this.#key(me.accountId) });
		send({ t: "chatlog", msgs: msgs.slice(-300).map((m) => this.#view(m)) });
		send({ t: "chats", state: await this.state(me.accountId) });
	}

	/** Runs a chat line of `me`; false when the line is not one (it goes to the world). */
	async handle(me: ChatUser, line: string, reply: (f: ChatFrame | Note) => void): Promise<boolean> {
		const m = LINE.exec(line);
		if (!m) return false;
		const verb = m[1]!.toLowerCase(), rest = line.slice(m[0].length).trim();
		try {
			if (["chat", "tell", "whisper", "flüstere", "fluestere", "flüster"].includes(verb)) await this.#direct(me, rest, reply);
			else if (verb === "gruppe" || verb === "group") await this.#group(me, rest, reply);
			else if (verb === "ignoriere" || verb === "ignore") await this.#ignore(me, rest, reply);
			else if (verb === "erlaube" || verb === "unignore") await this.#allow(me, rest, reply);
			else throw new ChatError("Gemeldet wird über „Melden“ an einer Nachricht im Chat der Seite.");
		} catch (e) {
			if (e instanceof ChatError) reply(note("error", e.message));
			else { console.error("[chat]", (e as Error).message); reply(note("error", "Der Chat ist gerade nicht erreichbar; bitte gleich noch einmal.")); }
		}
		return true;
	}

	/** A chat frame of the page: a key, the readers of a talk, a sealed message, a report. */
	async frame(me: ChatUser, f: ChatClientFrame, reply: (f: ChatFrame | Note) => void): Promise<void> {
		try {
			if (f.t === "chatkey") await this.#setKey(me, f, reply);
			else if (f.t === "chatkeys") { const r = await this.#readers(me, f.conv); reply({ t: "chatkeys", conv: r.conv, readers: r.readers.filter((x) => x.pub).map((x) => ({ accountId: x.accountId, name: x.name, pub: x.pub! })), missing: r.readers.filter((x) => !x.pub).map((x) => x.name), req: Number(f.req) || 0 }); }
			else if (f.t === "chatsend") await this.#send(me, f);
			else await this.#report(me, f, reply);
		} catch (e) {
			if (e instanceof ChatError) reply(note("error", e.message));
			else { console.error("[chat]", (e as Error).message); reply(note("error", "Der Chat ist gerade nicht erreichbar; bitte gleich noch einmal.")); }
		}
	}

	/** The groups, invitations and blocks of an account. */
	async state(accountId: string): Promise<ChatState> {
		const groups: ChatState["groups"] = [];
		for (const mem of (await this.space.readAll({ type: "ChatMember", fields: { accountId } })).map((e) => fields<ChatMemberFields>(e))) {
			const g = await this.#groupById(mem.groupId);
			if (!g) continue;
			const members = (await this.#members(g.groupId)).map((x) => this.hooks.nameOf(x.accountId)).sort((a, b) => a.localeCompare(b));
			groups.push({ groupId: g.groupId, name: g.name, members, owner: g.owner === accountId });
		}
		const invites: ChatState["invites"] = [];
		for (const inv of (await this.space.readAll({ type: "ChatInvite", fields: { to: accountId } })).map((e) => fields<ChatInviteFields>(e))) {
			const g = await this.#groupById(inv.groupId);
			if (g) invites.push({ groupId: g.groupId, name: g.name, from: this.hooks.nameOf(inv.fromId) });
		}
		const blocked = (await this.space.readAll({ type: "ChatBlock", fields: { who: accountId } })).map((e) => this.hooks.nameOf(fields<ChatBlockFields>(e).whom)).sort();
		return { groups: groups.sort((a, b) => a.name.localeCompare(b.name)), invites, blocked };
	}

	/** The reports for the admins, newest first. */
	async reports(): Promise<ChatReportFields[]> {
		return (await this.space.readAll({ type: "ChatReport" })).map((e) => fields<ChatReportFields>(e)).sort((a, b) => b.at - a.at);
	}

	// ---- talks between two ----

	async #direct(me: ChatUser, rest: string, reply: (f: ChatFrame | Note) => void): Promise<void> {
		const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
		if (!m) throw new ChatError("So geht es: chat <name> <text>, z. B. chat Ines hallo. „chat <name>“ allein öffnet das Gespräch.");
		const p = this.#player(m[1]!);
		if (p.accountId === me.accountId) throw new ChatError("Mit dir selbst kannst du nicht chatten.");
		if (m[2]!.trim()) throw new ChatError(NOT_PLAIN);
		reply({ t: "chatopen", conv: { kind: "dm", id: p.accountId, title: p.name } });
	}

	// ---- groups ----

	async #group(me: ChatUser, rest: string, reply: (f: ChatFrame | Note) => void): Promise<void> {
		if (!rest) { reply(note("info", this.#describe(await this.state(me.accountId)))); return; }
		const [first = "", ...more] = rest.split(/\s+/);
		const sub = first.toLowerCase(), args = more.join(" ");
		if (!SUB.has(sub)) {
			// "gruppe <name> <text>": a message to the group
			const g = await this.#mine(me, first);
			if (args.trim()) throw new ChatError(NOT_PLAIN);
			reply({ t: "chatopen", conv: { kind: "group", id: g.groupId, title: g.name } });
			return;
		}
		if (sub === "neu" || sub === "new") {
			if (me.guest) throw new ChatError("Gäste können keine Gruppe gründen; registriere dich dafür.");
			const name = args.trim();
			if (!GROUP_NAME.test(name) || SUB.has(name.toLowerCase())) throw new ChatError("Ein Gruppenname hat 2 bis 20 Buchstaben, Ziffern, - oder _, z. B. gruppe neu Bautrupp.");
			if (await this.#groupByName(name)) throw new ChatError(`Eine Gruppe „${name}“ gibt es schon.`);
			if ((await this.space.count({ type: "ChatGroup", fields: { owner: me.accountId } })) >= OWN_MAX) throw new ChatError(`Du verwaltest schon ${OWN_MAX} Gruppen.`);
			const g: ChatGroupFields = { groupId: id(), name, key: name.toLowerCase(), owner: me.accountId, at: Date.now() };
			try { await this.space.write({ type: "ChatGroup", fields: g as never }, null, FOREVER, { unique: ["key"] }); }
			catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new ChatError(`Eine Gruppe „${name}“ gibt es schon.`); throw e; }
			await this.space.write({ type: "ChatMember", fields: { groupId: g.groupId, accountId: me.accountId, at: Date.now() } satisfies ChatMemberFields as never }, null, FOREVER);
			reply(note("info", `Gruppe „${name}“ gegründet. Lade ein mit: gruppe lade <name> in ${name}`));
			return;
		}
		if (sub === "lade" || sub === "invite") {
			if (me.guest) throw new ChatError("Gäste können niemanden in eine Gruppe einladen; registriere dich dafür.");
			const m = /^(\S+)\s+(?:(?:in|zu|to|into)\s+)?(\S+)(?:\s+ein)?$/i.exec(args.trim());
			if (!m) throw new ChatError("So geht es: gruppe lade <name> in <gruppe>");
			const g = await this.#mine(me, m[2]!), p = this.#player(m[1]!);
			if ((await this.#members(g.groupId)).some((x) => x.accountId === p.accountId)) throw new ChatError(`${p.name} ist schon in „${g.name}“.`);
			if ((await this.space.readAll({ type: "ChatInvite", fields: { groupId: g.groupId, to: p.accountId } })).length) throw new ChatError(`${p.name} ist schon eingeladen.`);
			if ((await this.#members(g.groupId)).length >= GROUP_MAX) throw new ChatError(`„${g.name}“ ist voll (${GROUP_MAX}).`);
			if (await this.#blocks(p.accountId, me.accountId)) throw new ChatError(`${p.name} nimmt keine Einladungen von dir an.`);
			await this.space.write({ type: "ChatInvite", fields: { inviteId: id(), groupId: g.groupId, to: p.accountId, fromId: me.accountId, at: Date.now() } satisfies ChatInviteFields as never }, null, INVITE_MS());
			reply(note("info", `${p.name} ist in „${g.name}“ eingeladen.`));
			return;
		}
		if (sub === "annehmen" || sub === "accept" || sub === "ablehnen" || sub === "decline") {
			const g = await this.#groupByName(args.trim());
			const inv = g && (await this.space.takeIfExists({ type: "ChatInvite", fields: { groupId: g.groupId, to: me.accountId } }, NO_WAIT));
			if (!g || !inv) throw new ChatError(`Du hast keine Einladung in „${args.trim().slice(0, 20)}“.`);
			if (sub === "ablehnen" || sub === "decline") { reply(note("info", `Einladung in „${g.name}“ abgelehnt.`)); return; }
			if ((await this.#members(g.groupId)).length >= GROUP_MAX) throw new ChatError(`„${g.name}“ ist inzwischen voll.`);
			await this.space.write({ type: "ChatMember", fields: { groupId: g.groupId, accountId: me.accountId, at: Date.now() } satisfies ChatMemberFields as never }, null, FOREVER);
			await this.#note(g, `${me.name} ist der Gruppe beigetreten.`);
			return;
		}
		if (sub === "verlasse" || sub === "leave") {
			const g = await this.#mine(me, args.trim());
			await this.space.takeIfExists({ type: "ChatMember", fields: { groupId: g.groupId, accountId: me.accountId } }, NO_WAIT);
			const left = await this.#members(g.groupId);
			if (!left.length) {
				// the last one out: the group ends, its invitations with it
				await this.space.takeIfExists({ type: "ChatGroup", fields: { groupId: g.groupId } }, NO_WAIT);
				for (const e of await this.space.readAll({ type: "ChatInvite", fields: { groupId: g.groupId } })) await this.space.takeIfExists({ id: e.id }, NO_WAIT);
				reply(note("info", `Du hast „${g.name}“ verlassen; die Gruppe ist aufgelöst.`));
				return;
			}
			if (g.owner === me.accountId) {
				// the longest member manages it now
				const next = left.sort((a, b) => a.at - b.at)[0]!;
				const e = await this.space.takeIfExists({ type: "ChatGroup", fields: { groupId: g.groupId } }, NO_WAIT);
				if (e) await this.space.write({ type: "ChatGroup", fields: { ...fields<ChatGroupFields>(e), owner: next.accountId } as never }, null, FOREVER);
			}
			reply(note("info", `Du hast „${g.name}“ verlassen.`));
			await this.#note(g, `${me.name} hat die Gruppe verlassen.`);
			return;
		}
		// entferne <name> aus <gruppe>
		const m = /^(\S+)\s+(?:(?:aus|from)\s+)?(\S+)$/i.exec(args.trim());
		if (!m) throw new ChatError("So geht es: gruppe entferne <name> aus <gruppe>");
		const g = await this.#mine(me, m[2]!), p = this.#player(m[1]!);
		if (g.owner !== me.accountId) throw new ChatError(`Nur wer „${g.name}“ verwaltet, kann jemanden entfernen.`);
		if (p.accountId === me.accountId) throw new ChatError("Dich selbst nimmst du mit „gruppe verlasse“ heraus.");
		if (!(await this.space.takeIfExists({ type: "ChatMember", fields: { groupId: g.groupId, accountId: p.accountId } }, NO_WAIT))) throw new ChatError(`${p.name} ist nicht in „${g.name}“.`);
		reply(note("info", `${p.name} ist nicht mehr in „${g.name}“.`));
		await this.#note(g, `${p.name} wurde aus der Gruppe entfernt.`);
	}

	// ---- blocks and reports ----

	async #ignore(me: ChatUser, rest: string, reply: (f: ChatFrame | Note) => void): Promise<void> {
		if (!rest) { const b = (await this.state(me.accountId)).blocked; reply(note("info", b.length ? `Du ignorierst: ${b.join(", ")}. „erlaube <name>“ hebt es auf.` : "Du ignorierst niemanden.")); return; }
		const p = this.#player(rest.split(/\s+/)[0]!);
		if (p.accountId === me.accountId) throw new ChatError("Dich selbst kannst du nicht ignorieren.");
		if (!(await this.#blocks(me.accountId, p.accountId))) await this.space.write({ type: "ChatBlock", fields: { who: me.accountId, whom: p.accountId, at: Date.now() } satisfies ChatBlockFields as never }, null, FOREVER);
		// what they invited you to waits no longer
		for (const e of await this.space.readAll({ type: "ChatInvite", fields: { to: me.accountId, fromId: p.accountId } })) await this.space.takeIfExists({ id: e.id }, NO_WAIT);
		reply(note("info", `Du ignorierst ${p.name}: keine Nachrichten und Einladungen mehr. „erlaube ${p.name}“ hebt es auf.`));
	}

	async #allow(me: ChatUser, rest: string, reply: (f: ChatFrame | Note) => void): Promise<void> {
		if (!rest) throw new ChatError("So geht es: erlaube <name>");
		const p = this.#player(rest.split(/\s+/)[0]!);
		if (!(await this.space.takeIfExists({ type: "ChatBlock", fields: { who: me.accountId, whom: p.accountId } }, NO_WAIT))) throw new ChatError(`Du ignorierst ${p.name} nicht.`);
		reply(note("info", `${p.name} kann dir wieder schreiben.`));
	}

	/** A report: the reader opened the message on their page and hands its text to the admins (the server cannot check
	 *  it against the sealed copy; the report says so). */
	async #report(me: ChatUser, r: Extract<ChatClientFrame, { t: "chatreport" }>, reply: (f: ChatFrame | Note) => void): Promise<void> {
		const msgId = typeof r.msgId === "string" ? r.msgId : "";
		const m = msgId && (await this.space.readAll({ type: "ChatMsg", fields: { msgId, to: me.accountId } }))[0];
		if (!m) throw new ChatError("Diese Nachricht gibt es nicht (mehr).");
		const f = fields<ChatMsgFields>(m);
		if (f.fromId === me.accountId || !f.fromId) throw new ChatError("Melden kannst du nur Nachrichten anderer.");
		const text = typeof r.text === "string" ? r.text.slice(0, 1000) : "";
		await this.space.write({ type: "ChatReport", fields: { reportId: id(), by: me.accountId, byName: me.name, fromId: f.fromId, fromName: f.fromName, text, at: Date.now() } satisfies ChatReportFields as never }, null, REPORT_MS);
		reply(note("info", `Gemeldet. Die Admins sehen sich die Nachricht von ${f.fromName} an.`));
	}

	// ---- helpers ----

	#player(name: string): ChatUser {
		const p = this.hooks.person(name);
		if (p === "npc") throw new ChatError(`${name} ist keine Spielerin und kein Spieler; mit NPCs sprichst du mit „say“.`);
		if (!p) throw new ChatError(`Niemand heißt „${name.slice(0, 20)}“.`);
		return p;
	}
	async #groupById(groupId: string): Promise<ChatGroupFields | null> {
		const e = (await this.space.readAll({ type: "ChatGroup", fields: { groupId } }))[0];
		return e ? fields<ChatGroupFields>(e) : null;
	}
	async #groupByName(name: string): Promise<ChatGroupFields | null> {
		const e = (await this.space.readAll({ type: "ChatGroup", fields: { key: name.toLowerCase() } }))[0];
		return e ? fields<ChatGroupFields>(e) : null;
	}
	/** A group `me` is in, by name. */
	async #mine(me: ChatUser, name: string): Promise<ChatGroupFields> {
		const g = await this.#groupByName(name);
		if (!g || !(await this.space.count({ type: "ChatMember", fields: { groupId: g.groupId, accountId: me.accountId } }))) throw new ChatError(`Du bist in keiner Gruppe „${name.slice(0, 20)}“. „gruppe“ zeigt deine Gruppen.`);
		return g;
	}
	async #members(groupId: string): Promise<ChatMemberFields[]> {
		return (await this.space.readAll({ type: "ChatMember", fields: { groupId } })).map((e) => fields<ChatMemberFields>(e));
	}
	/** Whether `who` ignores `whom`. */
	async #blocks(who: string, whom: string): Promise<boolean> {
		return (await this.space.count({ type: "ChatBlock", fields: { who, whom } })) > 0;
	}
	/** Writes a copy for one reader; each reader keeps the last KEEP of a talk. */
	async #store(f: ChatMsgFields): Promise<void> {
		await this.space.write({ type: "ChatMsg", fields: f as never }, null, MSG_MS());
		const all = await this.space.readAll({ type: "ChatMsg", fields: { to: f.to, conv: f.conv } });
		if (all.length > KEEP) for (const e of all.sort((a, b) => Number(a.fields.at) - Number(b.fields.at)).slice(0, all.length - KEEP)) await this.space.takeIfExists({ id: e.id }, NO_WAIT);
	}
	/** A plain note to every member of the group (someone joined, left, was removed): no text of anyone's. */
	async #note(g: ChatGroupFields, text: string): Promise<void> {
		const msgId = id(), at = Date.now();
		for (const x of await this.#members(g.groupId)) await this.#store({ msgId, to: x.accountId, conv: `g:${g.groupId}`, title: g.name, fromId: "", fromName: "", note: text, at });
	}
	async #key(accountId: string): Promise<ChatKeyView | null> {
		const e = (await this.space.readAll({ type: "ChatKey", fields: { accountId } }))[0];
		if (!e) return null;
		const k = fields<ChatKeyFields>(e);
		return { pub: k.pub, wrapped: k.wrapped, salt: k.salt, iter: k.iter };
	}
	/** A new key (the first, or a new one after a forgotten password: `replace`) or the same key under a new password. */
	async #setKey(me: ChatUser, f: Extract<ChatClientFrame, { t: "chatkey" }>, reply: (f: ChatFrame | Note) => void): Promise<void> {
		const k = f.key;
		if (!k || typeof k.pub !== "string" || typeof k.wrapped !== "string" || typeof k.salt !== "string" || !Number.isInteger(k.iter)) throw new ChatError("Ungültiger Schlüssel.");
		if (!B64.test(k.pub) || k.pub.length > 200 || k.wrapped.length > 2000 || !/^[A-Za-z0-9+/=.]+$/.test(k.wrapped) || !B64.test(k.salt) || k.salt.length > 100 || k.iter < 100_000 || k.iter > 10_000_000) throw new ChatError("Ungültiger Schlüssel.");
		const old = await this.#key(me.accountId);
		if (old && old.pub !== k.pub && !f.replace) throw new ChatError("Es gibt schon einen Chat-Schlüssel; entsperre ihn mit deinem Chat-Passwort.");
		await this.space.takeIfExists({ type: "ChatKey", fields: { accountId: me.accountId } }, NO_WAIT);
		await this.space.write({ type: "ChatKey", fields: { accountId: me.accountId, pub: k.pub, wrapped: k.wrapped, salt: k.salt, iter: k.iter, at: Date.now() } satisfies ChatKeyFields as never }, null, FOREVER);
		// every page of the account learns the key (another device unlocks it with the password)
		this.hooks.send(me.accountId, { t: "chatme", accountId: me.accountId, key: { pub: k.pub, wrapped: k.wrapped, salt: k.salt, iter: k.iter } });
		reply(note("info", !old ? "Chat eingerichtet. Deine Nachrichten sind Ende-zu-Ende verschlüsselt." : old.pub === k.pub ? "Chat-Passwort geändert." : "Neuer Chat-Schlüssel: was für den alten geschrieben wurde, ist nicht mehr lesbar."));
	}
	/** Who reads a talk of `me`: between two, both (unless the other ignores `me`); in a group, its members (but those
	 *  who ignore `me`). With each reader's public key, if they have one. */
	async #readers(me: ChatUser, conv: { kind: "dm" | "group"; id: string }): Promise<{ conv: ChatConv; groupId: string; readers: Array<{ accountId: string; name: string; pub: string | null }> }> {
		const withKey = async (accountId: string) => ({ accountId, name: accountId === me.accountId ? me.name : this.hooks.nameOf(accountId), pub: (await this.#key(accountId))?.pub ?? null });
		if (conv?.kind === "dm") {
			const other = String(conv.id);
			const name = this.hooks.nameOf(other);
			if (!name || other === me.accountId) throw new ChatError("Dieses Gespräch gibt es nicht.");
			if (await this.#blocks(other, me.accountId)) throw new ChatError(`${name} nimmt keine Nachrichten von dir an.`);
			return { conv: { kind: "dm", id: other, title: name }, groupId: "", readers: [await withKey(other), await withKey(me.accountId)] };
		}
		const g = conv?.kind === "group" ? await this.#groupById(String(conv.id)) : null;
		if (!g || !(await this.space.count({ type: "ChatMember", fields: { groupId: g.groupId, accountId: me.accountId } }))) throw new ChatError("Du bist nicht in dieser Gruppe.");
		const readers = [];
		for (const x of await this.#members(g.groupId)) if (x.accountId === me.accountId || !(await this.#blocks(x.accountId, me.accountId))) readers.push(await withKey(x.accountId));
		return { conv: { kind: "group", id: g.groupId, title: g.name }, groupId: g.groupId, readers };
	}
	/** A sealed message: a copy for each reader of the talk that has a key, each sealed by `me`'s key. */
	async #send(me: ChatUser, f: Extract<ChatClientFrame, { t: "chatsend" }>): Promise<void> {
		if (typeof f.msgId !== "string" || !/^[0-9a-f]{16}$/.test(f.msgId) || !Array.isArray(f.copies)) throw new ChatError("Ungültige Nachricht.");
		const mine = await this.#key(me.accountId);
		if (!mine) throw new ChatError(NOT_PLAIN);
		const r = await this.#readers(me, f.conv);
		const allowed = new Map(r.readers.filter((x) => x.pub).map((x) => [x.accountId, x]));
		if (!f.copies.length || f.copies.length > allowed.size) throw new ChatError("Ungültige Nachricht.");
		const seen = new Set<string>();
		for (const c of f.copies) {
			const b = c?.box;
			if (!allowed.has(c?.to) || seen.has(c.to) || !b || b.pub !== mine.pub || ![b.iv, b.ct, b.pub].every((x) => typeof x === "string" && B64.test(x)) || b.ct.length > MAX_BOX || b.iv.length > 40) throw new ChatError("Ungültige Nachricht.");
			seen.add(c.to);
		}
		if (!seen.has(me.accountId)) throw new ChatError("Ungültige Nachricht.");
		if ((await this.space.count({ type: "ChatMsg", fields: { msgId: f.msgId } })) > 0) throw new ChatError("Diese Nachricht ist schon angekommen.");
		const at = Date.now();
		for (const c of f.copies) {
			const conv = r.groupId ? `g:${r.groupId}` : c.to === me.accountId ? `dm:${r.conv.id}` : `dm:${me.accountId}`;
			const title = r.groupId ? r.conv.title : c.to === me.accountId ? r.conv.title : me.name;
			await this.#store({ msgId: f.msgId, to: c.to, conv, title, fromId: me.accountId, fromName: me.name, box: JSON.stringify({ iv: c.box.iv, ct: c.box.ct, pub: c.box.pub }), at });
		}
	}
	#view(m: ChatMsgFields): ChatView {
		const [kind, convId] = m.conv.startsWith("g:") ? ["group", m.conv.slice(2)] as const : ["dm", m.conv.slice(3)] as const;
		const title = kind === "dm" ? this.hooks.nameOf(convId) || m.title : m.title;
		let box: Box | undefined;
		try { box = m.box ? JSON.parse(m.box) as Box : undefined; } catch { box = undefined; }
		return { id: m.msgId, conv: { kind, id: convId, title }, from: m.fromId ? this.hooks.nameOf(m.fromId) || m.fromName : "", fromId: m.fromId, at: m.at, ...(m.fromId && m.fromId === m.to ? { mine: true as const } : {}), ...(box ? { box } : {}), ...(m.note ? { note: m.note } : {}) };
	}
	#describe(s: ChatState): string {
		const parts = [s.groups.length ? `Deine Gruppen: ${s.groups.map((g) => `${g.name} (${g.members.join(", ")})`).join("; ")}.` : "Du bist in keiner Gruppe. „gruppe neu <name>“ gründet eine."];
		if (s.invites.length) parts.push(`Einladungen: ${s.invites.map((i) => `${i.name} von ${i.from} („gruppe annehmen ${i.name}“)`).join(", ")}.`);
		return parts.join(" ");
	}

	// ---- the change stream: delivery and state ----

	async #run(): Promise<void> {
		let rev = -1;
		while (!this.#closed) {
			try {
				if (rev < 0) {
					rev = (await this.space.readPage({ type: "-" })).rev;
					this.#concerns.clear();
					for (const type of ["ChatGroup", "ChatMember", "ChatInvite", "ChatBlock"]) for (const e of await this.space.readAll({ type })) this.#remember(e.id, type, e.fields);
				}
				const ch = await this.space.changes(rev, { waitMs: 20_000 });
				for (const b of ch.batches) {
					const touched = new Set<string>(), groups = new Set<string>();
					for (const op of b.ops) {
						if (op.op === "put") {
							if (op.type === "ChatMsg") { const m = fields<ChatMsgFields>(op); this.hooks.send(m.to, { t: "chat", m: this.#view(m) }); continue; }
							if (!["ChatGroup", "ChatMember", "ChatInvite", "ChatBlock"].includes(op.type)) continue;
							const c = this.#remember(op.id, op.type, op.fields);
							for (const a of c.accounts) touched.add(a);
							if (c.group) groups.add(c.group);
							if (op.type === "ChatInvite") {
								const inv = fields<ChatInviteFields>(op), g = await this.#groupById(inv.groupId);
								if (g) this.hooks.send(inv.to, note("info", `${this.hooks.nameOf(inv.fromId)} lädt dich in die Gruppe „${g.name}“ ein: „gruppe annehmen ${g.name}“ oder „gruppe ablehnen ${g.name}“.`));
							}
						} else {
							const c = this.#concerns.get(op.id);
							if (!c) continue;
							this.#concerns.delete(op.id);
							for (const a of c.accounts) touched.add(a);
							if (c.group) groups.add(c.group);
						}
					}
					for (const g of groups) for (const x of await this.#members(g)) touched.add(x.accountId);
					for (const a of touched) if (this.hooks.online(a)) this.hooks.send(a, { t: "chats", state: await this.state(a) });
				}
				rev = ch.next;
			} catch (e) {
				if (this.#closed) break;
				if (e instanceof SnapshotExpired || e instanceof RevisionAhead) { rev = -1; continue; }
				console.error("[chat] change stream:", (e as Error).message);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	}
	#remember(entryId: string, type: string, f: Record<string, unknown>): { accounts: string[]; group?: string } {
		const c = type === "ChatGroup" ? { accounts: [String(f.owner)], group: String(f.groupId) }
			: type === "ChatMember" ? { accounts: [String(f.accountId)], group: String(f.groupId) }
			: type === "ChatInvite" ? { accounts: [String(f.to)] }
			: { accounts: [String(f.who)] };
		this.#concerns.set(entryId, c);
		return c;
	}
}

const note = (kind: "info" | "error", text: string): Note => ({ t: "msg", m: { kind, text, from: "", at: Date.now() } });
