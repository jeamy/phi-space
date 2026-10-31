// The chat between players (server/chat.ts, docs/siedeln.en.md "Chat zwischen Spielern") with the world in its regions:
// end-to-end encrypted talks between two and in groups, as the page does it (client/chatcrypto.ts, run here in Node),
// across regions, waiting for a login, invitations that are taken or lapse, ignoring, guests, reports. The server keeps
// sealed copies only: no text of a message is in any space.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { startServer as startWeb } from "../server/index.ts";
import { connectSpace } from "../server/space.ts";
import type { ChatFrame, ChatView } from "../server/chat.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { aad, newKey, openBox, sealFor, unlock } from "../client/chatcrypto.ts";
import { Player, startRegions } from "./stack.ts";

type Me = { p: Player; name: string; accountId: string; priv: CryptoKey; pub: string };
const raw = (p: Player, f: unknown) => p.ws!.send(JSON.stringify(f));
const frame = async <T extends ChatFrame["t"]>(p: Player, t: T, from = 0, pred: (f: Extract<ChatFrame, { t: T }>) => boolean = () => true, ms = 10_000) =>
	(await p.until((f) => f.t === t && pred(f as never), ms, from)) as unknown as Extract<ChatFrame, { t: T }>;
const note = async (p: Player, text: string, from: number) => ((await p.until((f) => f.t === "msg" && f.m.text.includes(text), 10_000, from)) as Extract<ServerFrame, { t: "msg" }>).m.text;

async function register(url: string, name: string): Promise<Player> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: `pw-${name}-123` })).status, 200);
	await p.play();
	return p;
}
/** Sets up the chat key as the page does: a new key, its backup to the server. */
async function setup(p: Player, name: string, password: string): Promise<Me> {
	const me = await frame(p, "chatme");
	assert.equal(me.key, null, "no key yet");
	const k = await newKey(password);
	const from = p.frames.length;
	raw(p, { t: "chatkey", key: k.backup });
	await note(p, "Chat eingerichtet", from);
	return { p, name, accountId: me.accountId, priv: k.priv, pub: k.backup.pub };
}
let req = 0;
/** Seals `text` for every reader of the talk and sends the copies (client/useChat.ts sendText). */
async function say(me: Me, conv: { kind: "dm" | "group"; id: string }, text: string): Promise<string[]> {
	const n = ++req, from = me.p.frames.length;
	raw(me.p, { t: "chatkeys", conv, req: n });
	const keys = await frame(me.p, "chatkeys", from, (f) => f.req === n);
	const msgId = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
	const groupId = keys.conv.kind === "group" ? keys.conv.id : "";
	const copies = [];
	for (const r of keys.readers) copies.push({ to: r.accountId, box: await sealFor(me.priv, me.pub, r.pub, text, aad(msgId, me.accountId, r.accountId, groupId)) });
	raw(me.p, { t: "chatsend", msgId, conv: keys.conv, copies });
	return keys.missing;
}
const read = (me: { priv: CryptoKey; accountId: string }, m: ChatView) => openBox(me.priv, m.box!, aad(m.id, m.fromId, me.accountId, m.conv.kind === "group" ? m.conv.id : ""));
/** The next message `me` gets in a talk with `title`, opened. */
async function heard(me: Me, title: string, from: number): Promise<{ m: ChatView; text: string }> {
	const f = await frame(me.p, "chat", from, (x) => x.m.conv.title === title && !!x.m.box && !x.m.mine);
	return { m: f.m, text: await read(me, f.m) };
}

/** The regions and a web process, for a test of its own. */
async function chatStack() {
	const r = await startRegions();
	const web = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	return { web, stop: async () => { await web.close(); await r.close(); } };
}

test("chat: end-to-end encrypted talks across regions, waiting for the next login, groups by invitation, ignoring, guests", { timeout: 240_000 }, async () => {
	process.env.SPACES_MMO_CHAT_INVITE_MS = "2000"; // an invitation lapses quickly here (read when one is written)
	const r = await startRegions();
	const srv = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	const accounts = connectSpace(r.accounts);
	try {
		const anna = await setup(await register(srv.url, "Anna"), "Anna", "anna-chat-pw");
		const bertP = await register(srv.url, "Bert");
		const bert = await setup(bertP, "Bert", "bert-chat-pw");
		const caraP = await register(srv.url, "Cara");
		const cara = await setup(caraP, "Cara", "cara-chat-pw");
		// newcomers start in the regions in turn: Anna and Bert play in different ones
		const regionOf = async (name: string) => { for (const id of r.ids) if ((await r.space(id).readAll({ type: "Character", fields: { name } })).length) return id; return null; };
		assert.notEqual(await regionOf("Anna"), await regionOf("Bert"), "two regions");

		// a plain text never reaches the server's store: the page seals it; a plain line is refused
		let from = anna.p.frames.length;
		anna.p.send("chat Bert ganz offen");
		assert.match(await note(anna.p, "verschlüsselt", from), /nur verschlüsselt/);
		// "chat <name>" opens the talk
		from = anna.p.frames.length;
		anna.p.send("chat bert");
		const open = await frame(anna.p, "chatopen", from);
		assert.deepEqual(open.conv, { kind: "dm", id: bert.accountId, title: "Bert" });

		// between two regions
		from = bert.p.frames.length;
		await say(anna, open.conv, "Treffen am Feuer der Grauen Bucht?");
		const got = await heard(bert, "Anna", from);
		assert.equal(got.text, "Treffen am Feuer der Grauen Bucht?");
		assert.equal(got.m.from, "Anna");
		// only the readers can open it: Cara's key cannot
		await assert.rejects(read(cara, got.m));

		// Bert is away; what Anna writes waits for his next login
		await bert.p.leave();
		await say(anna, open.conv, "Bring Holz mit.");
		await bert.p.play();
		const log = await frame(bert.p, "chatlog");
		const texts = await Promise.all(log.msgs.filter((m) => m.box).map((m) => read(bert, m)));
		assert.deepEqual(texts, ["Treffen am Feuer der Grauen Bucht?", "Bring Holz mit."]);
		// another device of Bert: the key from the server's backup, with the chat password (a wrong one fails)
		const me2 = await frame(bert.p, "chatme");
		await assert.rejects(unlock(me2.key!, "falsch-falsch"), /stimmt nicht/);
		const again = await unlock(me2.key!, "bert-chat-pw");
		assert.equal(await read({ priv: again, accountId: bert.accountId }, log.msgs.at(-1)!), "Bring Holz mit.");

		// a group by invitation: Bert accepts, Cara's invitation lapses
		from = anna.p.frames.length;
		anna.p.send("gruppe neu Bautrupp");
		await note(anna.p, "gegründet", from);
		from = bert.p.frames.length;
		anna.p.send("gruppe lade Bert in Bautrupp");
		await note(bert.p, "lädt dich in die Gruppe „Bautrupp“", from);
		assert.equal((await frame(bert.p, "chats", from, (f) => f.state.invites.length === 1)).state.invites[0]!.from, "Anna");
		bert.p.send("gruppe annehmen Bautrupp");
		const state = (await frame(anna.p, "chats", from, (f) => f.state.groups[0]?.members.length === 2)).state;
		assert.deepEqual(state.groups[0]!.members, ["Anna", "Bert"]);
		anna.p.send("gruppe lade Cara in Bautrupp");
		await frame(cara.p, "chats", 0, (f) => f.state.invites.length === 1);
		await new Promise((ok) => setTimeout(ok, 3_000));
		from = cara.p.frames.length;
		cara.p.send("gruppe annehmen Bautrupp");
		assert.match(await note(cara.p, "keine Einladung", from), /keine Einladung/);
		const group = { kind: "group" as const, id: state.groups[0]!.groupId };
		from = bert.p.frames.length;
		await say(anna, group, "Wer bringt Tangseile?");
		assert.equal((await heard(bert, "Bautrupp", from)).text, "Wer bringt Tangseile?");

		// ignoring: Bert ignores Anna; she can no longer write to him, and her group messages skip him
		from = bert.p.frames.length;
		bert.p.send("ignoriere Anna");
		await note(bert.p, "Du ignorierst Anna", from);
		from = anna.p.frames.length;
		raw(anna.p, { t: "chatkeys", conv: { kind: "dm", id: bert.accountId }, req: 999 });
		assert.match(await note(anna.p, "nimmt keine Nachrichten", from), /Bert nimmt keine Nachrichten von dir an/);
		raw(anna.p, { t: "chatkeys", conv: group, req: 1000 });
		assert.deepEqual((await frame(anna.p, "chatkeys", from, (f) => f.req === 1000)).readers.map((x) => x.name), ["Anna"]);
		bert.p.send("erlaube Anna");

		// a report: Bert hands the text of Anna's message to the admins
		from = bert.p.frames.length;
		raw(bert.p, { t: "chatreport", msgId: got.m.id, text: got.text });
		await note(bert.p, "Gemeldet", from);
		const reports = await accounts.space.readAll({ type: "ChatReport" });
		assert.equal(reports.length, 1);
		assert.equal(reports[0]!.fields.fromName, "Anna");

		// guests chat, but found no group; NPCs are not chatted with
		const guest = new Player(srv.url);
		assert.equal((await guest.post("/api/guest")).status, 200);
		await guest.play();
		from = guest.frames.length;
		guest.send("gruppe neu Gaeste");
		assert.match(await note(guest, "Gäste können keine Gruppe", from), /registriere dich/);
		guest.send("chat Ines");
		assert.match(await note(guest, "keine Spielerin", from), /mit NPCs sprichst du mit „say“/);

		// what a player says and the list of who plays mark the players (the page makes their names a menu: chat, invite,
		// ignore); `who` lists the guest's region
		from = guest.frames.length;
		guest.send("who");
		const who = ((await guest.until((f) => f.t === "msg" && f.m.kind === "who", 10_000, from)) as Extract<ServerFrame, { t: "msg" }>).m;
		const gname = who.from;
		assert.deepEqual(who.players, [gname], JSON.stringify(who));
		guest.send("say hallo zusammen");
		const said = ((await guest.until((f) => f.t === "msg" && f.m.kind === "say" && f.m.text.endsWith("hallo zusammen"), 10_000, from)) as Extract<ServerFrame, { t: "msg" }>).m;
		assert.equal(said.player, true);

		// no text of a message in any space: the accounts space keeps sealed copies, the world never saw the talk
		const stored = JSON.stringify(await accounts.space.readAll({ type: "ChatMsg" }));
		for (const t of ["Treffen am Feuer", "Bring Holz", "Tangseile", "ganz offen"]) assert.ok(!stored.includes(t), t);
		for (const id of r.ids) {
			const msgs = JSON.stringify(await r.space(id).readAll({ type: "Msg" }));
			for (const t of ["Treffen am Feuer", "Bautrupp", "ganz offen"]) assert.ok(!msgs.includes(t), `${id}: ${t}`);
		}
		for (const p of [anna.p, bert.p, cara.p, guest]) await p.leave();
	} finally { accounts.close(); await srv.close(); await r.close(); delete process.env.SPACES_MMO_CHAT_INVITE_MS; }
});

test("what is written to a player without a key is told to them and arrives once they set up the chat", { timeout: 180_000 }, async () => {
	const { web, stop } = await chatStack();
	try {
		const a = await register(web.url, "Waltraud"), b = await register(web.url, "Bodo");
		const alice = await setup(a, "Waltraud", "alice-chat-pw");
		const bob = await frame(b, "chatme");
		const seenFrom = b.frames.length;
		const conv = { kind: "dm" as const, id: bob.accountId };
		assert.deepEqual(await say(alice, conv, "erste Nachricht"), ["Bodo"]);
		await say(alice, conv, "zweite Nachricht");
		await note(b, "möchte dir im Chat schreiben", seenFrom);
		const waiting = await frame(b, "chats", seenFrom, (f) => f.state.waiting.some((w) => w.count === 2));
		assert.deepEqual(waiting.state.waiting, [{ from: "Waltraud", count: 2 }]);

		// the sender's own copies, as its page has them
		const own = a.frames.filter((f): f is Extract<ChatFrame, { t: "chat" }> => f.t === "chat" && !!f.m.box);
		assert.equal(own.length, 2);
		const k = await newKey("bodo-chat-pw");
		const from = a.frames.length, fromB = b.frames.length;
		raw(b, { t: "chatkey", key: k.backup });
		const asked = await frame(a, "chatreseal", from);
		assert.equal(asked.items.length, 2);
		for (const it of asked.items) {
			const m = own.find((f) => f.m.id === it.msgId)!.m;
			const text = await openBox(alice.priv, m.box!, aad(it.msgId, alice.accountId, alice.accountId, it.groupId));
			raw(a, { t: "chatdeliver", msgId: it.msgId, to: it.to, box: await sealFor(alice.priv, alice.pub, it.pub, text, aad(it.msgId, alice.accountId, it.to, it.groupId)) });
		}
		const got = await Promise.all(asked.items.map(async (it) => {
			const f = await frame(b, "chat", fromB, (x) => x.m.id === it.msgId);
			return openBox(k.priv, f.m.box!, aad(it.msgId, alice.accountId, bob.accountId, ""));
		}));
		assert.deepEqual(got.sort(), ["erste Nachricht", "zweite Nachricht"]);
		await frame(b, "chats", fromB, (f) => f.state.waiting.length === 0);

		// a second page of the sender finds nothing left to hand on
		const again = a.frames.length;
		raw(a, { t: "chatwaiting" });
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(!a.frames.slice(again).some((f) => f.t === "chatreseal"));
	} finally { await stop(); }
});

test("a locked sender hands on after the unlock: the page asks, and only the sender can", { timeout: 180_000 }, async () => {
	const { web, stop } = await chatStack();
	try {
		const a = await register(web.url, "Wanda"), b = await register(web.url, "Bruno");
		const alice = await setup(a, "Wanda", "alice-chat-pw");
		const bob = await frame(b, "chatme");
		await say(alice, { kind: "dm", id: bob.accountId }, "später");
		await frame(b, "chats", 0, (f) => f.state.waiting.length === 1);
		const k = await newKey("bruno-chat-pw");
		const fromB = b.frames.length;
		raw(b, { t: "chatkey", key: k.backup });
		await note(b, "Chat eingerichtet", fromB);
		const from = a.frames.length;
		raw(a, { t: "chatwaiting" });
		const asked = await frame(a, "chatreseal", from);
		assert.equal(asked.items.length, 1);
		// another player cannot deliver in the sender's place
		const it = asked.items[0]!, before = b.frames.length;
		raw(b, { t: "chatdeliver", msgId: it.msgId, to: it.to, box: await sealFor(k.priv, k.backup.pub, it.pub, "untergeschoben", aad(it.msgId, bob.accountId, it.to, "")) });
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(!b.frames.slice(before).some((f) => f.t === "chat"));
	} finally { await stop(); }
});
