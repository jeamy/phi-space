// The warehouse, step 5 part 1 (docs/siedeln.md "Siedlungen und Besitz", engine/commands/build.ts): without a settlement
// its owner's chest; in one everyone may lay in, and take by rank up to a quota per world day; closed, strangers stay out;
// a log shows who moved what; what a settlement laid in does not leave with the owner.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { BuildingFields, CharacterFields, SettlementFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
type P = { p: Player; me: string; acc: string };
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function player(url: string, name: string, s: SpaceLike): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	const me = (await p.play()).me.charId;
	const ch = await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, name);
	return { p, me, acc: String(ch!.fields.accountId) };
}
const give = async (s: SpaceLike, charId: string, proto: string, count: number) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; for (let i = 0; i < count; i++) await spawn(s, null, w, p, { location: charId, x: -1, y: -1 }); };
const carried = async (s: SpaceLike, charId: string, proto: string) => s.count({ type: "Item", fields: { location: charId, proto } });
const building = (buildId: string, plan: string, x: number, y: number, size: number[], acc: string, name: string): BuildingFields => ({ buildId, plan, name: plan === "huette" ? "Hütte" : "Lagerhaus", room: "graue-bucht", x, y, w: size[0]!, h: size[1]!, owner: acc, ownerName: name, accountId: acc, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 });

test("a warehouse: its owner's chest alone; in a settlement shared by rank, with a quota and a log; closed, strangers stay out", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		const anna = await player(srv.url, "Anna", s), bert = await player(srv.url, "Bert", s);
		const at = (await s.readAll({ type: "Character", fields: { charId: anna.me } }))[0]!.fields as unknown as CharacterFields;
		const atB = (await s.readAll({ type: "Character", fields: { charId: bert.me } }))[0]!.fields as unknown as CharacterFields;
		// a store beside Anna and a second one of the same id cannot be: Bert walks to it
		const store = building("store", "lagerhaus", at.x + 1, at.y, [3, 2], anna.acc, "Anna");
		await s.write({ type: "Building", fields: store as never }, null, FOREVER);
		assert.ok(atB.room === at.room);
		bert.p.send(`move ${at.x} ${at.y + 1}`);
		await eventually(async () => { const c = (await s.readAll({ type: "Character", fields: { charId: bert.me } }))[0]!.fields as unknown as CharacterFields; return Math.abs(c.x - at.x) <= 1 && c.y >= at.y - 1 && c.y <= at.y + 2 ? c : null; }, 15_000, "Bert beside the store");

		await give(s, anna.me, "tang", 30);
		await give(s, bert.me, "tang", 1);

		// no settlement: the owner's chest, without a quota; a stranger may not
		assert.match(await does(anna.p, "verstaue alle tang", "Lager"), /Du legst 30 Tang in das Lager/);
		assert.match(await does(anna.p, "lager", "Im Lager"), /^Im Lager \(30\/120\): 30 Tang\.$/);
		assert.match(await does(bert.p, "lager", "gehört"), /Dieses Lagerhaus gehört Anna; allen dient es erst in einer Siedlung/);
		assert.match(await does(bert.p, "entnimm tang", "gehört"), /gehört Anna/);
		assert.match(await does(anna.p, "entnimm 5 tang", "Du nimmst"), /Du nimmst 5 Tang aus dem Lager\.$/);

		// a settlement: Anna a settler by her hut, Bert a stranger with a quota of two, also when he asks for more
		await s.write({ type: "Building", fields: building("hut", "huette", 2, 2, [2, 2], anna.acc, "Anna") as never }, null, FOREVER);
		const town: SettlementFields = { settlementId: "st", name: "Neuhaven", nameKey: "neuhaven", room: "graue-bucht", founder: anna.acc, founderName: "Anna", members: [], closed: false, at: 0 };
		await s.write({ type: "Settlement", fields: town as never }, null, FOREVER);
		assert.match(await does(bert.p, "lager", "Im Lager"), /Du darfst heute noch 2 von 2 Dingen nehmen\./);
		assert.match(await does(bert.p, "entnimm 5 tang", "Du nimmst"), /Du nimmst 2 Tang aus dem Lager\. Mehr steht dir heute nicht zu\./);
		assert.equal(await carried(s, bert.me, "tang"), 3);
		assert.match(await does(bert.p, "entnimm tang", "zusteht"), /Für heute hast du aus dem Lager genommen/);
		assert.match(await does(bert.p, "verstaue tang", "Du legst"), /Du legst 1 Tang in das Lager/, "laying in is always welcome");
		// Anna's quota counts from now: five taken before the settlement count too, twenty a day
		assert.match(await does(anna.p, "lager", "Im Lager"), /noch 15 von 20/);
		assert.match(await does(anna.p, "lager log", "Lagerbuch"), /Bert legt ein: 1 Tang\n {2}Bert nimmt: 2 Tang\n {2}Anna nimmt: 5 Tang\n {2}Anna legt ein: 30 Tang/);
		// the owner cannot carry off what the settlement laid in
		assert.match(await does(anna.p, "reisse lagerhaus ab", "gehört"), /Im Lager liegt noch, was der Siedlung gehört/);

		// closed: a stranger stays out; taken in as a helper the quota is five (two of them used today)
		await s.takeIfExists({ type: "Settlement", fields: { settlementId: "st" } }, 0);
		await s.write({ type: "Settlement", fields: { ...town, closed: true } as never }, null, FOREVER);
		assert.match(await does(bert.p, "entnimm tang", "geschlossen"), /Neuhaven ist geschlossen: an das Lager dürfen nur Helfer und Siedler/);
		await s.takeIfExists({ type: "Settlement", fields: { settlementId: "st" } }, 0);
		await s.write({ type: "Settlement", fields: { ...town, closed: true, members: [{ accountId: bert.acc, name: "Bert", rank: "helfer" }] } as never }, null, FOREVER);
		assert.match(await does(bert.p, "lager", "Im Lager"), /noch 3 von 5/);

		// a line in plain words reaches the store as well
		assert.match(await does(bert.p, "nimm 2 tang aus dem lager", "aus dem Lager"), /Du nimmst 2 Tang aus dem Lager/);
	} finally { await srv.close(); }
});
