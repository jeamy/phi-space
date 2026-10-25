// Acceptance of Phase 1 (docs/phasen.md): the world core after Evennia. Things are taken and written in the
// transaction of their command, so twenty hands on one coin leave it with exactly one, and a give survives its world
// process dying in the middle. Exits, builders, locks, tags and the world loader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, Player, startServer, startStack } from "./stack.ts";
import type { ServerFrame } from "../server/gateway.ts";
import type { SpaceLike } from "phi-spaces";

type Hello = Extract<ServerFrame, { t: "hello" }>;
const items = async (space: SpaceLike, fields: Record<string, unknown>) => (await space.readAll({ type: "Item", fields: fields as never })).map((e) => e.fields as Record<string, any>);
/** The item's committed state: waits while a transaction holds it. */
const settled = async (space: SpaceLike, itemId: string) => (await space.readIfExists({ type: "Item", fields: { itemId } }, 8_000))?.fields as Record<string, any> | undefined;
const charAt = async (space: SpaceLike, charId: string) => (await space.readIfExists({ type: "Character", fields: { charId } }, 5_000))!.fields as Record<string, any>;

/** A registered player in the game; `token` makes the first one admin. */
async function player(url: string, name: string, o: { token?: string; guest?: boolean } = {}): Promise<{ p: Player; h: Hello }> {
	const p = new Player(url);
	const r = o.guest ? await p.post("/api/guest") : await p.post("/api/register", { name, password: "geheim-123", ...(o.token ? { setupToken: o.token } : {}) });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return { p, h: await p.play() };
}
/** Sends a command and waits for a message containing `text`. */
async function does(p: Player, line: string, text: string | RegExp, ms = 10_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}

test("twenty players grab one coin at once across two world workers: exactly one gets it (nine stand within reach)", async () => {
	const srv = await startServer({ accountOptions: { setupToken: "t" } });
	try {
		await srv.stack.worldProcess(); // two world workers take intents in parallel
		const admin = await player(srv.url, "Wirtin", { token: "t" });
		admin.p.send("move 16 8"); // away from where new characters appear
		await eventually(async () => (await charAt(srv.stack.space, admin.h.me.charId)).x === 16, 10_000, "admin at 16,8");
		await does(admin.p, "spawn muenze", "erschaffst Münze");
		admin.p.send("move 20 7"); // off the coin's cell: no two characters share one, so the cell is for a player
		await eventually(async () => (await charAt(srv.stack.space, admin.h.me.charId)).x === 20, 10_000, "admin away");
		const [coin] = await items(srv.stack.space, { proto: "muenze" });
		assert.ok(coin);
		const players = await Promise.all(Array.from({ length: 20 }, () => player(srv.url, "", { guest: true })));
		// first everyone goes to a cell of their own on the grass (new characters crowd around the spawn and can stand
		// where the nine are going); the eleven far off stay there
		// (a crowd can block the way for a moment: a refused walk is sent again, as a player would)
		const goTo = async (i: number, x: number, y: number) => {
			for (let tries = 0; tries < 50; tries++) {
				const c = await charAt(srv.stack.space, players[i]!.h.me.charId);
				if (c.x === x && c.y === y) return;
				players[i]!.p.send(`move ${x} ${y}`);
				await new Promise((r) => setTimeout(r, 600));
			}
			throw new Error(`player ${i} did not reach ${x},${y}`);
		};
		await Promise.all(players.map((_, i) => (i < 9 ? goTo(i, i + 2, 13) : goTo(i, i - 7, 14))));
		// the coin's cell and its eight neighbours (all sand around 16,8): nine players within reach, eleven further off.
		// One after another, the middle first, so nobody is walled out by the others
		const ring = [[0, 0], [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([dx, dy]) => ({ x: Number(coin.x) + dx!, y: Number(coin.y) + dy! }));
		for (let i = 0; i < ring.length; i++) await goTo(i, ring[i]!.x, ring[i]!.y);
		const cells = new Set<string>();
		for (const { h } of players) { const c = await charAt(srv.stack.space, h.me.charId); cells.add(`${c.x},${c.y}`); }
		assert.equal(cells.size, 20, "twenty players on twenty different cells");
		const from = players.map(({ p }) => p.frames.length);
		for (const { p } of players) p.send("get münze");
		// every intent answered: the winner hears its success, every other one a refusal
		await Promise.all(players.map(({ p }, i) => p.until((f) => f.t === "msg" && (f.m.text.startsWith("Du hebst") || f.m.kind === "error"), 20_000, from[i])));
		const after = await settled(srv.stack.space, coin.itemId);
		const winners = players.filter(({ p }, i) => p.frames.slice(from[i]).some((f) => f.t === "msg" && f.m.text === "Du hebst Münze auf."));
		assert.equal(winners.length, 1, "exactly one success message");
		assert.equal(after?.location, winners[0]!.h.me.charId, "the coin is with the winner");
		assert.ok(players.indexOf(winners[0]!) < 9, "the winner stood within reach");
		assert.equal((await items(srv.stack.space, { proto: "muenze" })).length, 1, "still one coin");
		// the others saw it happen, rendered for them
		const other = players.find((x) => x !== winners[0])!;
		await other.p.until((f) => f.t === "msg" && f.m.text === `${winners[0]!.h.me.name} hebt Münze auf.`);
		await Promise.all([admin.p, ...players.map((x) => x.p)].map((p) => p.leave()));
	} finally { await srv.close(); }
});

test("one character's commands run in the order sent, even with two world workers taking intents in parallel", async () => {
	const srv = await startServer();
	try {
		await srv.stack.worldProcess();
		const a = await player(srv.url, "Ordnung"), b = await player(srv.url, "Zeuge");
		const from = b.p.frames.length;
		for (let i = 1; i <= 12; i++) a.p.send(`say ${i}`);
		b.p.send("say parallel"); // another character's command runs alongside
		await b.p.until((f) => f.t === "msg" && f.m.text === "Ordnung: 12", 20_000, from);
		const said = b.p.frames.slice(from).flatMap((f) => (f.t === "msg" && f.m.text.startsWith("Ordnung: ") ? [Number(f.m.text.slice(9))] : []));
		assert.deepEqual(said, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		assert.equal(await srv.stack.space.count({ type: "ActorToken", fields: { charId: a.h.me.charId } }), 1, "the token is back, once");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("a give whose world worker dies in the middle: the item is never lost or doubled, and the give completes later", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TXN_MS: "2000", SPACES_MMO_FAULT_PAUSE: "give:6000" } });
	const srv = await startServer({ stack });
	try {
		const a = await player(srv.url, "Anna"), b = await player(srv.url, "Bert");
		a.p.send("move 5 7");
		await eventually(async () => (await charAt(stack.space, a.h.me.charId)).x === 5, 10_000, "Anna at the driftwood");
		await does(a.p, "get treibholz", "Du hebst Treibholz auf.");
		a.p.send("give treibholz an Bert");
		await new Promise((r) => setTimeout(r, 1500)); // the world worker took the item and pauses before writing it on
		await stack.kill(stack.worlds[0]!, "SIGKILL");
		// its transaction lapses: the item is back with Anna, once
		assert.equal((await settled(stack.space, "treibholz-1"))?.location, a.h.me.charId);
		assert.equal((await items(stack.space, { itemId: "treibholz-1" })).length, 1);
		// a new world worker (without the pause) takes the intent that came back with the transaction
		await stack.worldProcess({ SPACES_MMO_FAULT_PAUSE: "" });
		await eventually(async () => (await settled(stack.space, "treibholz-1"))?.location === b.h.me.charId, 15_000, "the give completed");
		assert.equal((await items(stack.space, { itemId: "treibholz-1" })).length, 1, "never two");
		await b.p.until((f) => f.t === "msg" && f.m.text === "Anna gibt Bert Treibholz.");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("guests may pick things up and drop them, but not give them away", async () => {
	const srv = await startServer();
	try {
		const g = await player(srv.url, "", { guest: true }), h = await player(srv.url, "", { guest: true });
		g.p.send("move 14 5");
		await eventually(async () => (await charAt(srv.stack.space, g.h.me.charId)).y === 5, 10_000, "at the shell");
		await does(g.p, "get muschel", "Du hebst Muschel auf.");
		assert.equal(await does(g.p, `give muschel an ${h.h.me.name}`, "Gäste"), "Gäste können nichts weitergeben; registriere dich dafür.");
		assert.equal((await settled(srv.stack.space, "muschel-1"))?.location, g.h.me.charId);
		await does(g.p, "drop muschel", "Du legst Muschel ab.");
		assert.equal((await settled(srv.stack.space, "muschel-1"))?.location, "graue-bucht");
		await g.p.leave(); await h.p.leave();
	} finally { await srv.close(); }
});

test("things: get, inventory, look, drop; the map and the pack follow", async () => {
	const srv = await startServer();
	try {
		const a = await player(srv.url, "Ida"), b = await player(srv.url, "Ole");
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(a.p.frames.filter((f) => f.t === "hello").length, 1, "one hello per connection");
		assert.ok(a.h.objs.some((o) => o.id === "treibholz-1" && o.location === "graue-bucht" && o.kind === "item"), "the hello shows what lies here");
		assert.ok(a.h.objs.some((o) => o.id === "bucht-ost" && o.kind === "exit"), "and the exits");
		assert.match(await does(a.p, "look", "Ausgänge"), /Ausgänge: ost\.\nHier liegt: .*Treibholz/);
		assert.match(await does(a.p, "get treibholz", /weit weg|Hier liegt nichts/), /Treibholz liegt zu weit weg/);
		a.p.send("move 17 9");
		await eventually(async () => (await charAt(srv.stack.space, a.h.me.charId)).x === 17, 10_000, "next to the driftwood");
		const from = b.p.frames.length;
		await does(a.p, "nimm holz", "Du hebst Treibholz auf.");
		await b.p.until((f) => f.t === "objgone" && f.id === "treibholz-2", 10_000, from);
		await a.p.until((f) => f.t === "obj" && f.o.id === "treibholz-2" && f.o.location === a.h.me.charId);
		assert.equal(await does(a.p, "i", "Du trägst"), "Du trägst: Treibholz.");
		assert.match(await does(a.p, "look treibholz", "glatt geschliffen"), /^Treibholz\n/);
		a.p.send("move 16 10");
		await eventually(async () => (await charAt(srv.stack.space, a.h.me.charId)).y === 10, 10_000, "moved");
		await does(a.p, "drop treibholz", "Du legst Treibholz ab.");
		await b.p.until((f) => f.t === "obj" && f.o.id === "treibholz-2" && f.o.location === "graue-bucht" && f.o.x === 16 && f.o.y === 10);
		assert.equal(await does(a.p, "inventory", "Du trägst"), "Du trägst nichts.");
		await does(b.p, ":winkt", "Ole winkt");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("exits: go, the exit's name, or a step onto its cell lead to the next room; both rooms see it", async () => {
	const srv = await startServer();
	try {
		const a = await player(srv.url, "Rasmus"), b = await player(srv.url, "Selma");
		const fromB = b.p.frames.length;
		a.p.send("go ost");
		const there = (await a.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, 1)) as Hello;
		assert.equal(there.room.name, "Klippenpfad");
		assert.ok(there.objs.some((o) => o.id === "muschel-2"));
		await b.p.until((f) => f.t === "gone" && f.charId === a.h.me.charId, 10_000, fromB);
		await b.p.until((f) => f.t === "msg" && f.m.text === "Rasmus geht nach ost.", 10_000, fromB);
		// the arrival look reaches the player after its new hello (messages of a commit come after the moves)
		const helloAt = a.p.frames.indexOf(there);
		await a.p.until((f) => f.t === "msg" && f.m.text.startsWith("Klippenpfad\n"), 10_000, helloAt);
		assert.equal((await charAt(srv.stack.space, a.h.me.charId)).x, 1);
		// Selma follows by the exit's name; Rasmus sees her arrive
		const fromA = a.p.frames.length;
		b.p.send("klippenpfad");
		await a.p.until((f) => f.t === "char" && f.c.charId === b.h.me.charId, 10_000, fromA);
		await a.p.until((f) => f.t === "msg" && f.m.text === "Selma kommt an.", 10_000, fromA);
		// one step west from the arrival cell is the exit's cell: back to the bay
		const n = a.p.frames.length;
		a.p.send("step -1 0");
		const back = (await a.p.until((f) => f.t === "hello" && f.room.roomId === "graue-bucht", 10_000, n)) as Hello;
		assert.ok(back.chars.some((c) => c.charId === a.h.me.charId && c.x === 22 && c.y === 8));
		assert.match(await does(a.p, "go nirgends", "keinen Ausgang"), /nirgends/);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("builders shape the world: dig, open, create, set, lock, tag, examine, destroy, perm; others do not have these commands", async () => {
	const srv = await startServer({ accountOptions: { setupToken: "t" } });
	try {
		const admin = await player(srv.url, "Baumeisterin", { token: "t" }), bert = await player(srv.url, "Bert"), gast = await player(srv.url, "", { guest: true });
		assert.match(await does(bert.p, "dig Insel = nord", "Unbekannter Befehl"), /dig/);
		assert.doesNotMatch(await does(bert.p, "help", "Befehle:"), /dig\//);
		assert.match(await does(admin.p, "help", "Befehle:"), /dig\/grabe\/grab <name>/);
		// a new room with a way there and back
		await does(admin.p, "dig Nebelinsel = nord, süd", "Raum „Nebelinsel“");
		const n = admin.p.frames.length;
		admin.p.send("nord");
		const island = (await admin.p.until((f) => f.t === "hello" && f.room.name === "Nebelinsel", 10_000, n)) as Hello;
		assert.ok(island.objs.some((o) => o.kind === "exit" && o.name === "süd"));
		await does(admin.p, "süd", "Graue Bucht");
		await does(admin.p, "open tunnel = Nebelinsel", "Ausgang „tunnel“ nach Nebelinsel geöffnet.");
		// a thing, shaped and locked (made away from the exit cells: stepping on one would leave the room)
		admin.p.send("move 4 9");
		await eventually(async () => (await charAt(srv.stack.space, admin.h.me.charId)).x === 4, 10_000, "admin off the exits");
		await does(admin.p, "create Kiste:Item", "erschaffst Kiste");
		await does(admin.p, "set kiste/desc = Eine schwere Kiste aus Treibholz.", "desc geändert");
		await does(admin.p, "set kiste/aliases = truhe, box", "aliases geändert");
		assert.match(await does(admin.p, "lock kiste = get:bogus()", "ungültig"), /unbekannte Funktion „bogus“/);
		await does(admin.p, "lock truhe = get:perm(Builder)", "Locks gesetzt");
		await does(admin.p, "tag box = schwer:gewicht", "angeheftet");
		const ex = await does(admin.p, "examine kiste", "Kiste (");
		assert.match(ex, /Kiste \(Item < Object\)/);
		assert.match(ex, /locks: "get:perm\(Builder\)"/);
		assert.match(ex, /tags: schwer:gewicht/);
		const kiste = (await items(srv.stack.space, { name: "Kiste" }))[0]!;
		gast.p.send(`move ${Number(kiste.x) + 1} ${kiste.y}`); // next to it: the admin still stands on the chest's cell
		await eventually(async () => (await charAt(srv.stack.space, gast.h.me.charId)).x === Number(kiste.x) + 1, 10_000, "guest at the chest");
		assert.equal(await does(gast.p, "get kiste", "lässt sich"), "Kiste lässt sich nicht aufheben.");
		await does(admin.p, "destroy kiste", "vernichtest Kiste");
		assert.equal((await items(srv.stack.space, { name: "Kiste" })).length, 0);
		assert.equal(await srv.stack.space.count({ type: "Tag", fields: { target: kiste.itemId } }), 0, "its tags went with it");
		// spawn from a prototype; perm makes Bert a builder
		assert.match(await does(admin.p, "spawn", "Prototypen:"), /muenze, muschel, treibholz/);
		await does(admin.p, "spawn muschel", "erschaffst Muschel");
		assert.match(await does(admin.p, "create Ding:constructor", "Typklasse"), /unbekannte Typklasse/);
		await does(admin.p, "perm Bert = Builder", "Bert ist jetzt Builder.");
		await does(bert.p, "create Fass", "Du erschaffst Fass.");
		await Promise.all([admin.p, bert.p, gast.p].map((p) => p.leave()));
	} finally { await srv.close(); }
});

test("commands and names work in English and German alike, without a switch", async () => {
	const srv = await startServer({ accountOptions: { setupToken: "t" } });
	try {
		const a = await player(srv.url, "Zweisprachig", { token: "t" });
		const help = await does(a.p, "hilfe", "Befehle:");
		for (const line of ["look/schau/sieh", "get/nimm/heb/take", "give/gib", "dig/grabe/grab", "examine/untersuche", "destroy/vernichte/zerstöre"]) assert.ok(help.includes(line), line);
		assert.match(await does(a.p, "hilfe nimm", "get/"), /^get\/nimm\/heb\/take <ding>/);
		assert.match(await does(a.p, "schau", "Ausgänge"), /Graue Bucht/);
		a.p.send("laufe 5 7");
		await eventually(async () => (await charAt(srv.stack.space, a.h.me.charId)).x === 5, 10_000, "walked");
		await does(a.p, "nimm driftwood", "Du hebst Treibholz auf.");
		assert.equal(await does(a.p, "inventar", "Du trägst"), "Du trägst: Treibholz.");
		await does(a.p, "drop wood", "Du legst Treibholz ab.");
		a.p.send("move 4 9");
		await eventually(async () => (await charAt(srv.stack.space, a.h.me.charId)).y === 9, 10_000, "off the driftwood");
		await does(a.p, "erschaffe Fass", "Du erschaffst Fass.");
		await does(a.p, "markiere fass = voll", "angeheftet");
		await does(a.p, "untersuche fass", "tags: voll:allgemein");
		await does(a.p, "vernichte fass", "Du vernichtest Fass.");
		const n = a.p.frames.length;
		a.p.send("gehe east");
		await a.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, n);
		await a.p.leave();
	} finally { await srv.close(); }
});

test("the world loads once: world workers starting together place each item once, and a restart does not bring back what was picked up", async () => {
	const stack = await startStack({ worlds: 0 });
	const srv = await startServer({ stack });
	try {
		await Promise.all([stack.worldProcess(), stack.worldProcess(), stack.worldProcess()]);
		for (const id of ["treibholz-1", "treibholz-2", "muschel-1", "muschel-2"]) assert.equal((await items(stack.space, { itemId: id })).length, 1, id);
		assert.equal(await stack.space.count({ type: "Room" }), 2);
		assert.equal(await stack.space.count({ type: "Exit" }), 2);
		const a = await player(srv.url, "Finn");
		a.p.send("move 14 5");
		await eventually(async () => (await charAt(stack.space, a.h.me.charId)).y === 5, 10_000, "at the shell");
		await does(a.p, "get muschel", "Du hebst Muschel auf.");
		for (const w of [...stack.worlds]) await stack.kill(w);
		await stack.worldProcess();
		assert.equal((await items(stack.space, { itemId: "muschel-1" })).length, 1);
		assert.equal((await settled(stack.space, "muschel-1"))?.location, a.h.me.charId, "still in Finn's pack, not back on the sand");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});
