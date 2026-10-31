// Orders of a site, step 5 part 3 (docs/siedeln.md, engine/commands/siteorder.ts): the wage lies in the order, whoever
// delivers or works is paid in that command, what is left goes back, and the day labourer works for it.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { CharacterFields, SiteFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const give = async (s: SpaceLike, charId: string, proto: string, count: number) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; for (let i = 0; i < count; i++) await spawn(s, null, w, p, { location: charId, x: -1, y: -1 }); };
const coins = (s: SpaceLike, at: string) => s.count({ type: "Item", fields: { location: at, proto: "muenze" } });
const join = async (srv: Awaited<ReturnType<typeof startServer>>, name: string) => {
	const p = new Player(srv.url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
};

test("a wage: held by the order, paid in the command, the rest goes back", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		const a = await join(srv, "Bauherrin"), b = await join(srv, "Zutraeger");
		await give(s, a.me, "muenze", 12);
		await give(s, b.me, "treibholz", 3);
		await does(a.p, "bau hütte", "steckt eine Baustelle ab");
		const site = (await eventually(async () => (await s.readAll({ type: "Site" }))[0], 10_000, "site"))!.fields as unknown as SiteFields;
		await does(b.p, "move " + (site.x - 1) + " " + site.y, /./).catch(() => "");
		await eventually(async () => { const c = (await s.readAll({ type: "Character", fields: { charId: b.me } }))[0]!.fields as unknown as CharacterFields; return c.x === site.x - 1 && c.y === site.y; }, 15_000, "walked");

		assert.match(await does(b.p, "aushang 2 treibholz je 1", "gehört"), /nur, wem die Baustelle gehört/);
		assert.match(await does(a.p, "aushang 3 treibholz je 9", "kostet"), /kostet 27 Münzen, du hast 12/);
		assert.match(await does(a.p, "aushang 2 gold je 1", "braucht"), /braucht die Hütte nicht/);
		assert.match(await does(a.p, "aushang 2 treibholz je 3", "hängt"), /hängt an der Hütte aus: 2 Treibholz, je 3 Münzen/);
		assert.equal(await coins(s, a.me), 6);
		assert.match(await does(a.p, "aushang 1 treibholz je 1", "schon"), /schon ein Aushang/);
		assert.match(await does(b.p, "baustelle", "Lohn:"), /Lohn: 2 Treibholz, je 3 Münzen/);

		assert.match(await does(b.p, "liefere 1 treibholz", "Lohn"), /Lohn: 3 Münzen/);
		assert.equal(await coins(s, b.me), 3);
		assert.match(await does(a.p, "aushang", "Ausgehängt"), /1 Treibholz, je 3 Münzen/);
		assert.match(await does(a.p, "aushang ab", "zurück"), /bekommst 3 Münzen zurück/);
		assert.equal(await coins(s, a.me), 9);
		assert.equal(await s.count({ type: "SiteOrder" }), 0);
		assert.doesNotMatch(await does(b.p, "liefere 1 treibholz", "lieferst"), /Lohn/);

		await does(a.p, "aushang 2 arbeit je 2", "hängt");
		assert.equal(await coins(s, a.me), 5);
		await does(a.p, "abriss baustelle", "gibt die Baustelle");
		await eventually(async () => (await coins(s, a.me)) === 9, 10_000, "the wage is back");
		assert.equal(await s.count({ type: "SiteOrder" }), 0);
	} finally { await srv.close(); }
});

test("the day labourer works for a wage and for nothing else", { timeout: 120_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_NPCS: "wolter" } });
	try {
		const s = srv.stack.space;
		await srv.stack.npcProcess();
		await lightFire(s, 3_600_000, "feuer-bucht");
		const a = await join(srv, "Meisterin");
		await give(s, a.me, "muenze", 4);
		await does(a.p, "bau hütte", "steckt eine Baustelle ab");
		await does(a.p, "aushang 2 arbeit je 2", "hängt");
		// the site is held while someone works on it: a look may miss it
		const site = (await eventually(async () => { const f = (await s.readAll({ type: "Site" }))[0]?.fields as unknown as SiteFields | undefined; return f && f.work >= 1 ? f : undefined; }, 60_000, "Wolter works"))!;
		assert.ok(site.by.Wolter! >= 1);
		await eventually(async () => (await coins(s, "npc-wolter")) >= 2, 10_000, "paid");
	} finally { await srv.close(); }
});
