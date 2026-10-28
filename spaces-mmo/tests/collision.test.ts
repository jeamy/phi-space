// Two characters never stand on one cell (engine/occupancy.ts): every position change writes the cell's Spot with the
// space's unique check, so even two world workers moving several players onto one cell at once let exactly one arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, Player, startServer, startStack } from "./stack.ts";
import { WALK_MS } from "../client/walk.ts";
import type { ServerFrame } from "../server/gateway.ts";
import type { SpaceLike } from "phi-spaces";

const charAt = async (space: SpaceLike, charId: string) => (await space.readIfExists({ type: "Character", fields: { charId } }, 5_000))!.fields as Record<string, any>;
async function player(url: string, name: string): Promise<{ p: Player; me: string }> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
async function walk(p: Player, space: SpaceLike, me: string, x: number, y: number) {
	p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = await charAt(space, me); return c.x === x && c.y === y; }, 10_000, `at ${x},${y}`);
}
async function does(p: Player, line: string, text: string, ms = 10_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && f.m.text.includes(text), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}

test("a step onto someone is refused, a walk goes around them", async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Anna"), b = await player(srv.url, "Bert");
		await walk(a.p, space, a.me, 15, 8);
		await walk(b.p, space, b.me, 16, 8);
		assert.equal(await does(a.p, "step 1 0", "steht schon"), "Dort steht schon Bert.");
		assert.equal(await does(a.p, "move 16 8", "steht schon"), "Dort steht schon Bert.");
		await walk(a.p, space, a.me, 17, 8); // around Bert
		const pa = await charAt(space, a.me), pb = await charAt(space, b.me);
		assert.notDeepEqual([pa.x, pa.y], [pb.x, pb.y]);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("at a door nobody blocks: a step goes onto the cell before the exit where someone stands, and on through the exit", async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Anna"), b = await player(srv.url, "Bert");
		await walk(b.p, space, b.me, 22, 8); // the cell before the way east (23,8)
		await walk(a.p, space, a.me, 21, 8);
		a.p.send("step 1 0");
		await eventually(async () => { const c = await charAt(space, a.me); return c.x === 22 && c.y === 8; }, 10_000, "Anna next to Bert's cell");
		assert.equal((await space.readAll({ type: "Spot", fields: { charId: a.me } })).length, 0, "a passage holds no cell");
		const n = a.p.frames.length;
		a.p.send("step 1 0");
		await a.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, n);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("ten players walk onto one cell at once across two world workers: exactly one arrives", async () => {
	const srv = await startServer();
	try {
		await srv.stack.worldProcess();
		const space = srv.stack.space;
		const ps = await Promise.all(Array.from({ length: 10 }, async () => { const p = new Player(srv.url); await p.post("/api/guest"); return { p, me: (await p.play()).me.charId }; }));
		for (const { p } of ps) p.send("move 18 8");
		await eventually(async () => !(await space.count({ type: "Intent" })), 20_000, "all moves taken");
		await new Promise((r) => setTimeout(r, 500)); // the last ones commit
		const at = await Promise.all(ps.map(({ me }) => charAt(space, me)));
		assert.equal(at.filter((c) => c.x === 18 && c.y === 8).length, 1, "one stands on 18,8");
		assert.equal(new Set(at.map((c) => `${c.x},${c.y}`)).size, 10, "ten players, ten cells");
		await Promise.all(ps.map(({ p }) => p.leave()));
	} finally { await srv.close(); }
});

test("arriving through an exit where someone stands lands on the arrival cell too (a door is a passage), never on the exit", async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Ankunft"), b = await player(srv.url, "Wache");
		const n = b.p.frames.length;
		b.p.send("go ost");
		await b.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, n);
		assert.deepEqual([(await charAt(space, b.me)).x, (await charAt(space, b.me)).y], [1, 8], "Wache stands on the arrival cell");
		const m = a.p.frames.length;
		a.p.send("go ost");
		await a.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, m);
		const pa = await charAt(space, a.me);
		assert.deepEqual([pa.x, pa.y], [1, 8], "on the arrival cell, with Wache: nobody holds a cell at a door");
		assert.equal((await space.readAll({ type: "Spot", fields: { room: "klippenpfad", x: 1, y: 8 } })).length, 0, "no Spot at a door");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("a player who comes back to a cell someone took meanwhile is moved to a free one", async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Rueckkehr"), b = await player(srv.url, "Platzhalter");
		await walk(a.p, space, a.me, 14, 9);
		await a.p.leave(); // offline: Rueckkehr no longer occupies the cell
		await eventually(async () => !(await space.readAll({ type: "Session" })).some((s) => s.fields.charId === a.me), 5_000, "offline");
		await walk(b.p, space, b.me, 14, 9);
		await a.p.play();
		await eventually(async () => { const c = await charAt(space, a.me); return c.x !== 14 || c.y !== 9; }, 10_000, "moved off the taken cell");
		const pa = await charAt(space, a.me);
		assert.ok(Math.abs(pa.x - 14) + Math.abs(pa.y - 9) <= 2, "next to it");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("nobody walks into the fire: a step onto the beacon is refused, a walk goes around it", async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Vorsicht");
		await walk(a.p, space, a.me, 9, 9); // just north of the beacon at 9,10
		assert.match(await does(a.p, "step 0 1", "Leuchtfeuer"), /da läuft man nicht hinein/);
		assert.match(await does(a.p, "move 9 10", "Leuchtfeuer"), /da läuft man nicht hinein/);
		await walk(a.p, space, a.me, 9, 11); // the other side: around the fire
		await a.p.leave();
	} finally { await srv.close(); }
});

test("a flood of steps does not queue a long walk: of twenty sent at once a few are taken; the page's pace is always taken", async () => {
	const srv = await startServer();
	try {
		const a = await player(srv.url, "Eilige");
		a.p.send("move 4 13"); // on the grass, the whole row east of it free
		await eventually(async () => (await charAt(srv.stack.space, a.me)).x === 4, 10_000, "at the start");
		for (let i = 0; i < 20; i++) a.p.send("step 1 0");
		await new Promise((r) => setTimeout(r, 2_000));
		const x = Number((await charAt(srv.stack.space, a.me)).x);
		assert.ok(x > 4 && x - 4 <= 10, `the burst of eight (and what refills meanwhile), not the flood of twenty (${x - 4} steps)`);
		// at the page's pace (client/walk.ts) every step is taken
		await new Promise((r) => setTimeout(r, 600));
		for (let i = 0; i < 6; i++) { a.p.send("step 1 0"); await new Promise((r) => setTimeout(r, WALK_MS)); }
		await eventually(async () => (await charAt(srv.stack.space, a.me)).x === x + 6, 10_000, "six more at the page's pace");
		await a.p.leave();
	} finally { await srv.close(); }
});

test("standing still sends no positions: a renewed session is no move (the page would take it for an answer)", async () => {
	// 1.5 s session leases: the gateway (in this process) renews every 0.5 s
	process.env.SPACES_MMO_SESSION_LEASE_MS = "1500";
	const srv = await startServer();
	process.env.SPACES_MMO_SESSION_LEASE_MS = "";
	try {
		const a = await player(srv.url, "Stille");
		await new Promise((r) => setTimeout(r, 1_000));
		const from = a.p.frames.length;
		await new Promise((r) => setTimeout(r, 3_000));
		const own = a.p.frames.slice(from).filter((f) => (f.t === "char" && f.c.charId === a.me) || (f.t === "gone" && f.charId === a.me));
		assert.equal(own.length, 0, JSON.stringify(own));
		await a.p.leave();
	} finally { await srv.close(); }
});

test("a flood of typed commands is cut after the account's burst, across all its pages; a fifth page closes the oldest", async () => {
	const stack = await startStack();
	try {
		const web = await stack.webProcess({ SPACES_MMO_CMD_BURST: "5", SPACES_MMO_CMD_PER_SEC: "1", SPACES_MMO_REQ_PER_MIN: "100000" });
		const a = await player(web.url, "Flut");
		const second = new Player(web.url); second.cookie = a.p.cookie; await second.play(); // the same account in a second page
		const from = a.p.frames.length;
		for (let i = 1; i <= 6; i++) a.p.send(`say a${i}`);
		for (let i = 1; i <= 6; i++) second.send(`say b${i}`);
		await a.p.until((f) => f.t === "msg" && f.m.kind === "error" && /Zu viele Befehle/.test(f.m.text), 10_000, from);
		await new Promise((r) => setTimeout(r, 1_500));
		const said = a.p.frames.slice(from).filter((f) => f.t === "msg" && f.m.kind === "say").length;
		assert.ok(said >= 5 && said <= 7, `the burst of five (and what refilled meanwhile), not twelve: ${said}`);
		// a third, fourth and fifth page: the account keeps four, the oldest (a) is closed
		const more = [new Player(web.url), new Player(web.url), new Player(web.url)];
		for (const p of more) { p.cookie = a.p.cookie; await p.play(); }
		await eventually(async () => a.p.ws?.readyState === WebSocket.CLOSED, 5_000, "the oldest page closed");
		assert.equal(second.ws?.readyState, WebSocket.OPEN);
		for (const p of [second, ...more]) await p.leave();
	} finally { await stack.close(); }
});

test("a step that is not taken says why, once: a held key against the fire gets one hint, not one per step", async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		const a = await player(srv.url, "Hinweis");
		await walk(a.p, space, a.me, 9, 9); // just north of the beacon at 9,10
		const from = a.p.frames.length;
		for (let seq = 1; seq <= 3; seq++) { a.p.ws!.send(JSON.stringify({ t: "step", seq, dx: 0, dy: 1 })); await new Promise((r) => setTimeout(r, WALK_MS)); }
		await a.p.until((f) => f.t === "char" && f.c.charId === a.me && f.ack === 3, 10_000, from);
		await new Promise((r) => setTimeout(r, 500));
		const hints = a.p.frames.slice(from).filter((f) => f.t === "msg" && f.m.kind === "error").map((f) => (f as Extract<ServerFrame, { t: "msg" }>).m.text);
		assert.deepEqual(hints, ["Dort brennt das Leuchtfeuer; da läuft man nicht hinein."]);
		// a step that is taken clears it: the next refusal is told again
		await walk(a.p, space, a.me, 8, 9);
		await walk(a.p, space, a.me, 9, 9);
		const again = a.p.frames.length;
		a.p.ws!.send(JSON.stringify({ t: "step", seq: 4, dx: 0, dy: 1 }));
		await a.p.until((f) => f.t === "msg" && f.m.kind === "error" && /Leuchtfeuer/.test(f.m.text), 10_000, again);
		await a.p.leave();
	} finally { await srv.close(); }
});
