// Acceptance of Phase 2 (docs/phasen.md): time in the world. Game durations run fast (SPACES_MMO_TIME_SCALE), so a
// ten-minute log burns for seconds. A fire goes out by itself at the computed moment, the fog rises and swallows the
// ways, feeding brings it back; the tide brings flotsam that leaves again; channels, reputation, scripted NPCs that run
// for (game) hours without leaving entries behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readClock } from "../server/engine/clock.ts";
import { isLit } from "../server/engine/fire.ts";
import { msUntilWorld, worldNow } from "../server/engine/worldtime.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";
import type { ServerFrame } from "../server/gateway.ts";
import type { SpaceLike } from "phi-spaces";

const charAt = async (space: SpaceLike, charId: string) => (await space.readIfExists({ type: "Character", fields: { charId } }, 5_000))!.fields as Record<string, any>;
const fog = async (space: SpaceLike, room: string) => Number((await space.readIfExists({ type: "Fog", fields: { room } }, 2_000))?.fields.level);
const flame = async (space: SpaceLike) => (await space.readIfExists({ type: "Flame", fields: { beaconId: "feuer-bucht" } }, 0))?.fields as { until: number } | undefined;

async function player(url: string, name: string): Promise<{ p: Player; me: string }> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
async function does(p: Player, line: string, text: string | RegExp, ms = 10_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function walk(p: Player, space: SpaceLike, me: string, x: number, y: number) {
	p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = await charAt(space, me); return c.x === x && c.y === y; }, 10_000, `at ${x},${y}`);
}

test("a fire goes out by itself at the computed moment; without it the fog rises and closes the ways, feeding opens them", async () => {
	// 0.005: a log burns 3 s, a fog step takes 0.6 s
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.005" } });
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Feuerwart");
		// no fire: the fog climbs from 2 to 3 and the way east is gone
		await eventually(async () => (await fog(space, "graue-bucht")) === 3, 10_000, "fog 3");
		assert.match(await does(a.p, "go ost", "zu dicht"), /Weg nach ost findest du nicht\. Entzünde das Leuchtfeuer hier/);
		await walk(a.p, space, a.me, 5, 7);
		await does(a.p, "nimm treibholz", "Du hebst Treibholz auf.");
		await walk(a.p, space, a.me, 9, 9); // next to the beacon in the cobble ring
		const clock = await readClock(space);
		await does(a.p, "lege holz ins feuer", /Du legst Treibholz ins Leuchtfeuer/);
		const f = (await flame(space))!;
		const burns = f.until - worldNow(clock);
		assert.ok(burns > 540_000 && burns <= 600_000, `a log burns ten world minutes (3 s at this rate), ${burns} ms`);
		// the fire clears the fog; the way opens again
		await eventually(async () => (await fog(space, "graue-bucht")) <= 2, 10_000, "fog falls");
		const n = a.p.frames.length;
		a.p.send("go ost");
		await a.p.until((fr) => fr.t === "hello" && fr.room.roomId === "klippenpfad", 10_000, n);
		// it goes out at the computed moment, by the clock, and its rooms hear it
		const left = msUntilWorld(clock, f.until, Date.now());
		await new Promise((r) => setTimeout(r, Math.max(0, left - 400)));
		assert.ok(isLit(await flame(space) as never, worldNow(clock)), "still burning shortly before");
		await eventually(async () => !isLit(await flame(space) as never, worldNow(clock)), Math.max(0, msUntilWorld(clock, f.until, Date.now())) + 1_500, "out at the computed moment");
		await a.p.until((fr) => fr.t === "msg" && fr.m.text.includes("ist erloschen"), 5_000);
		await eventually(async () => (await fog(space, "klippenpfad")) === 3, 10_000, "fog back to 3");
		// away from the fire the fog closes the ways and says where the light is; toward it one finds the way
		assert.match(await does(a.p, "go ost", "zu dicht"), /Weg nach ost findest du nicht\. Das Leuchtfeuer steht in Graue Bucht; den Weg nach west dorthin findest du noch\./);
		const back = a.p.frames.length;
		a.p.send("go west");
		await a.p.until((fr) => fr.t === "hello" && fr.room.roomId === "graue-bucht", 10_000, back);
		assert.equal(await does(a.p, "ruf", "Ruf"), "Dein Ruf: 1 Scheit in 1 Leuchtfeuer.");
		await a.p.leave();
	} finally { await srv.close(); }
});

test("the tide brings flotsam up to a limit; what nobody picks up leaves again, what is picked up stays", async () => {
	// 0.02: a wave every 1.2 s, flotsam lies 6 s
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.02" } });
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Strandgut");
		const flotsam = () => space.readAll({ type: "Item", fields: { location: "graue-bucht", flotsam: true } });
		const first = (await eventually(async () => (await flotsam())[0], 10_000, "first flotsam"))!;
		await a.p.until((f) => f.t === "msg" && f.m.text.startsWith("Die Flut spült"), 5_000);
		await walk(a.p, space, a.me, Number(first.fields.x), Number(first.fields.y));
		await does(a.p, `get ${first.fields.name}`, "Du hebst");
		const kept = (await space.readAll({ type: "Item", fields: { location: a.me } }))[0]!;
		const lying = (await flotsam()).map((e) => String(e.fields.itemId));
		for (let i = 0; i < 10; i++) { assert.ok((await flotsam()).length <= 4, "at most four pieces lie there"); await new Promise((r) => setTimeout(r, 300)); }
		await new Promise((r) => setTimeout(r, 4_000));
		const now = new Set((await flotsam()).map((e) => String(e.fields.itemId)));
		assert.ok(lying.every((id) => !now.has(id)), "the old flotsam left with the tide");
		assert.ok(await space.readIfExists({ type: "Item", fields: { itemId: kept.fields.itemId } }, 1_000), "what was picked up stays");
		await a.p.leave();
	} finally { await srv.close(); }
});

test("channels reach every room; reputation and the beacon list who fed it", async () => {
	const srv = await startServer();
	try {
		const a = await player(srv.url, "Rufer"), b = await player(srv.url, "Hoerer");
		b.p.send("go ost");
		await b.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, 1);
		assert.equal(await does(a.p, "ruf", "Leuchtfeuer"), "Du hast noch in kein Leuchtfeuer nachgelegt.");
		a.p.send("kanal hafen Hallo von der Bucht");
		await b.p.until((f) => f.t === "msg" && f.m.text === "[hafen] Rufer: Hallo von der Bucht");
		assert.match(await does(a.p, "kanal", "Kanäle"), /hafen/);
		assert.match(await does(a.p, "kanal nirgends hi", "gibt es nicht"), /nirgends/);
		await walk(a.p, srv.stack.space, a.me, 5, 7);
		await does(a.p, "get treibholz", "Du hebst");
		await walk(a.p, srv.stack.space, a.me, 10, 10);
		await does(a.p, "put treibholz in feuer", "ins Leuchtfeuer");
		await b.p.until((f) => f.t === "msg" && f.m.text === "Das Leuchtfeuer flammt auf.", 5_000);
		assert.match(await does(a.p, "look feuer", "Leuchtfeuer:"), /brennt noch etwa 10 Minuten\.\nAm meisten nachgelegt: Rufer \(1\)\./);
		assert.match(await does(a.p, "look", "Graue Bucht"), /Das Leuchtfeuer brennt noch/);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("scripted NPCs: the ferryman crosses for game hours without leaving entries behind; the keeper warns and greets", async () => {
	// 0.002: ten seconds are more than an hour of game time
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002", SPACES_MMO_MSG_LEASE_MS: "2000" } });
	const srv = await startServer({ stack });
	try {
		const space = stack.space;
		// a fire that burns the whole test keeps the fog down and the ways open
		await lightFire(space, 120_000);
		await eventually(async () => (await fog(space, "graue-bucht")) === 0, 20_000, "fog cleared");
		const a = await player(srv.url, "Gast");
		await stack.npcProcess();
		a.p.send("who");
		await a.p.until((f) => f.t === "msg" && /Bo \(/.test(f.m.text) && /Ines \(/.test(f.m.text), 40_000);
		await does(a.p, "say hallo zusammen", "Willkommen am Feuer, Gast!");
		const rooms: string[] = [];
		const sample = async () => {
			const s = await space.stats();
			return { entries: s.entries, intents: s.byType.Intent ?? 0, sessions: s.byType.Session ?? 0, msgs: s.byType.Msg ?? 0, tokens: s.byType.ActorToken ?? 0 };
		};
		let mid = await sample();
		for (let i = 0; i < 100; i++) {
			const room = String((await charAt(space, "npc-bo")).room);
			if (rooms.at(-1) !== room) rooms.push(room);
			if (i === 50) mid = await sample();
			await new Promise((r) => setTimeout(r, 100));
		}
		const end = await sample();
		assert.ok(rooms.length >= 6, `Bo crossed back and forth (${rooms.join(" → ")})`);
		assert.ok(end.intents <= 3, `no intents pile up (${end.intents})`);
		assert.equal(end.sessions, 3, "Ines, Bo and the player are online");
		// one token per character (a token a worker holds right now is invisible to a count: wait for each one)
		for (const c of await space.readAll({ type: "Character" })) assert.ok(await space.readIfExists({ type: "ActorToken", fields: { charId: c.fields.charId } }, 5_000), `token of ${c.fields.charId}`);
		assert.ok(end.tokens <= (await space.count({ type: "Character" })), "never more tokens than characters");
		assert.ok(end.entries <= mid.entries + 25, `entries stay bounded (${mid.entries} → ${end.entries})`);
		// the keeper notices a fire that is gone
		await space.take({ type: "Flame", fields: { beaconId: "feuer-bucht" } }, 2_000);
		await a.p.until((f) => f.t === "msg" && f.m.text === "Ines: Das Feuer ist aus! Ohne Licht frisst uns der Nebel.", 20_000);
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("pages learn the build: /api/me and every hello name it, and NPC names cannot be registered", async () => {
	const srv = await startServer({ build: "build-42" });
	try {
		const p = new Player(srv.url);
		assert.equal((await p.me()).build, "build-42");
		await p.post("/api/guest");
		assert.equal((await p.play()).build, "build-42");
		assert.equal((await new Player(srv.url).post("/api/register", { name: "ines", password: "geheim-123" })).status, 409);
		await p.leave();
	} finally { await srv.close(); }
});

test("feeding several at once: \"lege 5 hölzer ins feuer\" puts in what one carries, up to five, in one line", async () => {
	const { loadWorld } = await import("../server/engine/world.ts");
	const { resolvePrototype, spawn } = await import("../server/engine/prototypes.ts");
	const srv = await startServer();
	try {
		const space = srv.stack.space, w = await loadWorld();
		const a = await player(srv.url, "Heizer");
		const wood = (await resolvePrototype(space, "treibholz"))!;
		for (let i = 0; i < 3; i++) await spawn(space, null, w, wood, { location: a.me, x: -1, y: -1 });
		await walk(a.p, space, a.me, 10, 10);
		const said = await does(a.p, "lege 5 hölzer ins feuer", "ins Leuchtfeuer");
		assert.match(said, /^Du legst 3 Treibholz ins Leuchtfeuer \(mehr hast du nicht dabei\)\. Es brennt noch etwa 30 Minuten\.$/);
		assert.equal((await space.readAll({ type: "Item", fields: { location: a.me } })).length, 0, "all three went in");
		for (let i = 0; i < 3; i++) await spawn(space, null, w, wood, { location: a.me, x: -1, y: -1 });
		assert.match(await does(a.p, "put zwei treibholz in feuer", "ins Leuchtfeuer"), /^Du legst 2 Treibholz ins Leuchtfeuer\. Es brennt noch etwa 50 Minuten\.$/);
		assert.match(await does(a.p, "lege holz ins feur", "ins Leuchtfeuer"), /^Du legst Treibholz ins Leuchtfeuer\. Es brennt noch etwa 60 Minuten\.$/, "one, and a typo in the fire");
		for (let i = 0; i < 2; i++) await spawn(space, null, w, wood, { location: a.me, x: -1, y: -1 });
		assert.match(await does(a.p, "lege 5 holstücke ins feuer", "ins Leuchtfeuer"), /^Du legst 2 Treibholz ins Leuchtfeuer \(mehr hast du nicht dabei\)\. Es brennt noch etwa 80 Minuten\.$/, "a measure in the name, and a typo");
		await a.p.leave();
	} finally { await srv.close(); }
});
