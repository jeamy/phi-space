// Acceptance of Phase 0 (docs/phasen.md): guests and accounts, one room, text and map, and what survives a process
// that dies. Every test starts its own space process and world worker (tests/stack.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, Player, startServer, startStack } from "./stack.ts";
import type { ServerFrame } from "../server/gateway.ts";
import type { SpaceLike } from "phi-spaces";

const charOf = (f: ServerFrame) => (f.t === "char" ? f.c : null);
/** Accounts or characters of players (the world's NPCs have their own, with ids npc-…). */
const players = async (space: SpaceLike, type: "Account" | "Character") => (await space.readAll({ type })).filter((e) => !String(e.fields.accountId).startsWith("npc-")).length;

test("two registered players see each other on the map and hear each other", async () => {
	const srv = await startServer();
	try {
		const a = new Player(srv.url), b = new Player(srv.url);
		assert.equal((await a.post("/api/register", { name: "Mira", password: "geheim-123" })).status, 200);
		assert.equal((await b.post("/api/register", { name: "Jon", password: "geheim-456" })).status, 200);
		assert.deepEqual((await a.me()).account, { name: "Mira", guest: false, admin: false });
		const ha = await a.play();
		assert.equal(ha.room.name, "Graue Bucht");
		assert.ok(ha.room.ground.length > 0 && ha.world.tiles["~"], "the hello frame carries the grid and its tiles");
		const hb = await b.play();
		assert.ok(hb.chars.some((c) => c.name === "Mira"), "Jon sees Mira, who was there first");
		await a.until((f) => charOf(f)?.name === "Jon"); // Mira sees Jon arrive
		b.send("say Hallo Mira");
		assert.equal(await a.heard("Hallo Mira"), "Jon: Hallo Mira");
		a.send("look");
		assert.match(await a.heard("Graue Bucht"), /Hier sind: Jon\./);
		a.send("who");
		assert.match(await a.heard("Gerade spielen"), /Gerade spielen 2: Jon \(Graue Bucht\), Mira \(Graue Bucht\)/);
		// a move is seen by the other one, a way into the water is refused
		b.send("move 3 8");
		await a.until((f) => charOf(f)?.name === "Jon" && f.t === "char" && f.c.x === 3 && f.c.y === 8);
		b.send("move 0 0");
		assert.equal(await b.heard("kein Weg"), "Dorthin führt kein Weg.");
		b.send("tanz");
		assert.match(await b.heard("Unbekannter Befehl"), /help/);
		await a.leave(); await b.leave();
	} finally { await srv.close(); }
});

test("a closed tab takes the character off the map and out of who", async () => {
	const srv = await startServer();
	try {
		const a = new Player(srv.url), b = new Player(srv.url);
		await a.post("/api/guest"); await b.post("/api/guest");
		await a.play();
		const hb = await b.play();
		await a.until((f) => charOf(f)?.charId === hb.me.charId);
		const from = a.frames.length;
		await b.leave();
		await a.until((f) => f.t === "gone" && f.charId === hb.me.charId, 10_000, from);
		a.send("who");
		assert.match(await a.heard("Gerade spielen"), /^Gerade spielen 1: /);
		await a.leave();
	} finally { await srv.close(); }
});

test("a web process that dies takes its players offline within the session lease, and a restart logs nobody out", async () => {
	const stack = await startStack();
	try {
		const env = { SPACES_MMO_SESSION_LEASE_MS: "1500" };
		const web1 = await stack.webProcess(env), web2 = await stack.webProcess(env);
		const a = new Player(web1.url), b = new Player(web2.url);
		await a.post("/api/register", { name: "Ada", password: "geheim-123" });
		await b.post("/api/guest");
		await a.play();
		const hb = await b.play();
		await a.until((f) => charOf(f)?.charId === hb.me.charId);
		const from = a.frames.length;
		await stack.kill(web2.child, "SIGKILL"); // no goodbye: only the lease ends the session
		await a.until((f) => f.t === "gone" && f.charId === hb.me.charId, 8_000, from);
		// web1 dies as well and comes back on its port: the login lives in the accounts space, not in the process
		await a.leave();
		await stack.kill(web1.child, "SIGKILL");
		const again = await stack.webProcess(env, web1.port);
		assert.deepEqual((await a.me()).account, { name: "Ada", guest: false, admin: false });
		assert.equal((await a.play()).me.name, "Ada");
		await a.leave();
		await stack.kill(again.child);
	} finally { await stack.close(); }
});

test("a world worker that dies loses nothing: positions stay, and a command sent meanwhile runs after the restart", async () => {
	const stack = await startStack();
	const srv = await startServer({ stack });
	try {
		const a = new Player(srv.url);
		await a.post("/api/guest");
		const h = await a.play();
		const at = (x: number, y: number) => (f: ServerFrame) => f.t === "char" && f.c.charId === h.me.charId && f.c.x === x && f.c.y === y;
		a.send("move 5 9");
		await a.until(at(5, 9));
		await stack.kill(stack.worlds[0]!, "SIGKILL");
		a.send("move 6 9"); // no world worker runs: the intent waits in the space
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(a.frames.some(at(6, 9)), false);
		await stack.worldProcess();
		await a.until(at(6, 9));
		await a.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("on SQLite the world and the logins survive a restart of the space process", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "mmo-data-"));
	const stack = await startStack({ dataDir });
	const srv = await startServer({ stack });
	try {
		const a = new Player(srv.url);
		await a.post("/api/register", { name: "Kai", password: "geheim-123" });
		const h = await a.play();
		a.send("move 7 9");
		await a.until((f) => f.t === "char" && f.c.charId === h.me.charId && f.c.x === 7 && f.c.y === 9);
		await a.leave();
		await stack.restartSpace();
		const again = await eventually(async () => (await a.me().catch(() => null))?.account, 15_000, "the login after the restart");
		assert.deepEqual(again, { name: "Kai", guest: false, admin: false });
		const back = new Player(srv.url);
		assert.equal((await back.post("/api/login", { name: "kai", password: "geheim-123" })).status, 200, "names are case-insensitive");
		await eventually(async () => {
			const c = await stack.space.readIfExists({ type: "Character", fields: { charId: h.me.charId } }, 0).catch(() => null);
			return c && c.fields.x === 7 && c.fields.y === 9;
		}, 15_000, "the position after the restart");
	} finally { await srv.close(); await stack.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("ten wrong passwords lock the name for a minute, even for the right one", async () => {
	const srv = await startServer();
	try {
		const a = new Player(srv.url);
		await a.post("/api/register", { name: "Rina", password: "geheim-123" });
		const thief = new Player(srv.url);
		for (let i = 0; i < 10; i++) assert.equal((await thief.post("/api/login", { name: "Rina", password: `falsch-${i}` })).status, 403);
		const locked = await new Player(srv.url).post("/api/login", { name: "rina", password: "geheim-123" });
		assert.equal(locked.status, 429);
		assert.match(locked.body.error, /Anmeldeversuche/);
	} finally { await srv.close(); }
});

test("two registrations of the same name at once: exactly one succeeds", async () => {
	const srv = await startServer();
	try {
		const tries = await Promise.all(Array.from({ length: 6 }, (_, i) => new Player(srv.url).post("/api/register", { name: i % 2 ? "Sol" : "SOL", password: `geheim-${i}00` })));
		assert.deepEqual(tries.map((t) => t.status).sort(), [200, 409, 409, 409, 409, 409]);
		assert.equal(await players(srv.stack.space, "Account"), 1);
	} finally { await srv.close(); }
});

test("a guest who registers keeps the same character, its place and its account", async () => {
	const srv = await startServer();
	try {
		const g = new Player(srv.url);
		assert.equal((await g.post("/api/guest")).body.account.guest, true);
		const h = await g.play();
		assert.match(h.me.name, /^Strandläufer-\d{4}$/);
		g.send("move 4 9");
		await g.until((f) => f.t === "char" && f.c.charId === h.me.charId && f.c.x === 4 && f.c.y === 9);
		await g.leave();
		const r = await g.post("/api/register", { name: "Lene", password: "geheim-123" });
		assert.equal(r.status, 200);
		assert.deepEqual(r.body.account, { name: "Lene", guest: false, admin: false });
		const again = await g.play();
		assert.equal(again.me.charId, h.me.charId, "the same character");
		assert.equal(again.me.name, "Lene");
		assert.ok(again.chars.some((c) => c.charId === h.me.charId && c.x === 4 && c.y === 9), "at the same place");
		assert.equal(await players(srv.stack.space, "Account"), 1, "converted, not copied");
		assert.equal(await players(srv.stack.space, "Character"), 1);
		// and the new name logs in from anywhere
		assert.equal((await new Player(srv.url).post("/api/login", { name: "Lene", password: "geheim-123" })).status, 200);
		await g.leave();
	} finally { await srv.close(); }
});

test("a registration that breaks off after claiming the name: the guest plays on, and the name is free again", async () => {
	const srv = await startServer({ accountOptions: { pendingMs: 1500 } });
	try {
		const g = new Player(srv.url);
		await g.post("/api/guest");
		srv.accounts.faults.afterPendingCredential = () => { throw new Error("the web process died here"); };
		assert.equal((await g.post("/api/register", { name: "Tamo", password: "geheim-123" })).status, 500);
		srv.accounts.faults = {};
		assert.equal((await g.me()).account.guest, true, "still a guest");
		const h = await g.play();
		g.send("look");
		await g.heard("Graue Bucht");
		await g.leave();
		// meanwhile the name is claimed (pending) …
		const other = new Player(srv.url);
		assert.equal((await other.post("/api/register", { name: "Tamo", password: "anderes-1" })).status, 409);
		assert.equal((await other.post("/api/login", { name: "Tamo", password: "geheim-123" })).status, 403, "a pending claim is no login");
		// … the guest's own retry takes its claim over …
		const retry = await g.post("/api/register", { name: "Tamo", password: "geheim-123" });
		assert.equal(retry.status, 200);
		assert.equal((await g.play()).me.charId, h.me.charId);
		await g.leave();
		// … and an abandoned claim lapses: another broken attempt, then someone else gets the name
		const g2 = new Player(srv.url);
		await g2.post("/api/guest");
		srv.accounts.faults.afterPendingCredential = () => { throw new Error("died again"); };
		assert.equal((await g2.post("/api/register", { name: "Wim", password: "geheim-123" })).status, 500);
		srv.accounts.faults = {};
		await new Promise((r) => setTimeout(r, 2500));
		assert.equal((await new Player(srv.url).post("/api/register", { name: "Wim", password: "anderes-1" })).status, 200);
	} finally { await srv.close(); }
});

test("a guest without activity disappears with its character when its lease runs out", async () => {
	const srv = await startServer({ accountOptions: { guestTtlMs: 2000 }, worldEnv: { SPACES_MMO_CLEANUP_MS: "300" } });
	try {
		const g = new Player(srv.url), kept = new Player(srv.url);
		await g.post("/api/guest");
		await kept.post("/api/register", { name: "Bleibt", password: "geheim-123" });
		const h = await g.play();
		await g.leave();
		await eventually(async () => (await srv.stack.space.count({ type: "Character", fields: { charId: h.me.charId } })) === 0, 10_000, "the guest's character removed");
		assert.equal((await g.me()).account, null, "the guest's login ends with its account");
		assert.equal(await players(srv.stack.space, "Character"), 1, "registered characters stay");
	} finally { await srv.close(); }
});

test("the setup token makes the first registered account an admin, and only the first", async () => {
	const srv = await startServer({ accountOptions: { setupToken: "einmal-xyz" } });
	try {
		assert.equal((await new Player(srv.url).post("/api/register", { name: "Wache", password: "geheim-123", setupToken: "falsch" })).body.account.admin, false);
		assert.equal((await new Player(srv.url).post("/api/register", { name: "Chefin", password: "geheim-123", setupToken: "einmal-xyz" })).body.account.admin, true);
		assert.equal((await new Player(srv.url).post("/api/register", { name: "Zweite", password: "geheim-123", setupToken: "einmal-xyz" })).body.account.admin, false);
	} finally { await srv.close(); }
});

test("requests: POSTs need the x-mmo header, names and passwords are checked, assets are served from the world only", async () => {
	const srv = await startServer();
	try {
		const bare = await fetch(srv.url + "/api/guest", { method: "POST" });
		assert.equal(bare.status, 403, "a cross-site form cannot set the header");
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "x", password: "geheim-123" })).status, 400);
		assert.equal((await p.post("/api/register", { name: "Strandläufer-1234", password: "geheim-123" })).status, 400, "guest names are reserved");
		assert.equal((await p.post("/api/register", { name: "Kurz", password: "kurz" })).status, 400);
		assert.equal((await p.post("/api/login", { name: "Niemand", password: "geheim-123" })).status, 403);
		const png = await fetch(srv.url + "/assets/leuchtfeuer/tilesets/Ground.png");
		assert.equal(png.status, 200);
		assert.equal(png.headers.get("content-type"), "image/png");
		for (const bad of ["/assets/leuchtfeuer/../world.ts", "/assets/leuchtfeuer/%2e%2e/world.ts", "/assets/leuchtfeuer/world.ts", "/assets/LEUCHT/x.png"]) assert.equal((await fetch(srv.url + bad)).status, 404, bad);
		// a game socket needs a login, and a foreign page may not open one with the cookie
		await p.post("/api/guest");
		await assert.rejects(new Player(srv.url).play(), /did not open/);
		const foreign = new WebSocket(srv.url.replace("http", "ws") + "/ws", { headers: { cookie: p.cookie, origin: "https://evil.example" } } as never);
		await assert.rejects(new Promise((ok, fail) => { foreign.onopen = ok; foreign.onerror = () => fail(new Error("refused")); }), /refused/);
	} finally { await srv.close(); }
});
