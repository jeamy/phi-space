// Settlements, step 4 part 2 (docs/siedeln.md "Siedlungen und Besitz", engine/commands/settlement.ts): three huts of two
// owners found one; hut owners are settlers; closed, the ranks count; a guest is a helper at most; it ends with its huts.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { rankOf, settlementTick } from "../server/engine/commands/settlement.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { BuildingFields, SettlementFields, SiteFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
type P = { p: Player; me: string; acc: string };
async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const hut = (i: number, accountId: string, ownerName: string): BuildingFields => ({ buildId: `hut-${i}`, plan: "huette", name: "Hütte", room: "graue-bucht", x: 2 + i * 3, y: 2, w: 2, h: 2, owner: accountId, ownerName, accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 });
async function player(url: string, name: string, s: SpaceLike): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	const me = (await p.play()).me.charId;
	return { p, me, acc: String((await s.readAll({ type: "Character", fields: { charId: me } }))[0]!.fields.accountId) };
}

test("the rank: a hut makes a settler, a listed one what it was given, a guest a helper at most", () => {
	const s = { members: [{ accountId: "m", name: "M", rank: "siedler" }, { accountId: "h", name: "H", rank: "helfer" }] } as SettlementFields;
	const huts = [{ accountId: "a" }];
	assert.equal(rankOf(s, huts, { accountId: "a", guest: false }), "siedler");
	assert.equal(rankOf(s, huts, { accountId: "m", guest: false }), "siedler");
	assert.equal(rankOf(s, huts, { accountId: "h", guest: false }), "helfer");
	assert.equal(rankOf(s, huts, { accountId: "m", guest: true }), "helfer");
	assert.equal(rankOf(s, huts, { accountId: "x", guest: false }), "fremder");
	assert.equal(rankOf(s, huts, null), "fremder");
});

test("a settlement: founded from three huts of two owners; closed, strangers neither build nor help; taken in they may; it ends with its huts", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		const anna = await player(srv.url, "Anna", s), bert = await player(srv.url, "Bert", s), cara = await player(srv.url, "Cara", s);
		assert.match(await does(anna.p, "siedlung", "keine Siedlung"), /hier stehen 0 Hütten von 0 Besitzern \(nötig: 3 Hütten von 2\)/);
		await s.write({ type: "Building", fields: hut(0, anna.acc, "Anna") as never }, null, FOREVER);
		await s.write({ type: "Building", fields: hut(1, anna.acc, "Anna") as never }, null, FOREVER);
		assert.match(await does(anna.p, "siedlung gründen Neuhaven", "braucht es"), /3 Hütten von mindestens 2 Besitzern/);
		await s.write({ type: "Building", fields: hut(2, bert.acc, "Bert") as never }, null, FOREVER);
		assert.match(await does(cara.p, "siedlung gründen Neuhaven", "Hütte hat"), /gründet, wer hier eine Hütte hat/);
		assert.match(await does(anna.p, "siedlung gründen Neuhaven", "gründet die Siedlung"), /Anna gründet die Siedlung Neuhaven/);
		assert.match(await does(bert.p, "siedlung gründen Zweite", "schon eine"), /schon eine Siedlung/);
		assert.match(await does(anna.p, "siedlung", "Neuhaven"), /Neuhaven \(gegründet von Anna, offen\): 3 Hütten\. Siedler: Anna, Bert\. Du bist Siedler/);
		assert.match(await does(cara.p, "look", "Siedlung"), /Hier liegt die Siedlung Neuhaven/);

		// open: the ranks bind nobody; closed: Cara neither builds nor helps
		assert.doesNotMatch(await does(cara.p, "bau hütte", /steckt|passt|geschlossen|Baustelle/), /geschlossen/);
		for (const e of await s.readAll({ type: "Site" })) await s.takeIfExists({ id: e.id }, 0);
		assert.match(await does(cara.p, "siedlung zu", "entscheiden"), /Das entscheiden die Siedler von Neuhaven/);
		assert.match(await does(bert.p, "siedlung zu", "schließt"), /Bert schließt Neuhaven/);
		assert.match(await does(cara.p, "bau hütte", "geschlossen"), /Bauen dürfen hier nur Siedler\. Du bist Fremder/);
		assert.match(await does(cara.p, "arbeite", "geschlossen"), /Mitarbeiten dürfen hier nur Helfer und Siedler/);
		// a helper helps but does not build; a settler builds
		assert.match(await does(anna.p, "siedlung aufnehmen Cara helfer", "nimmt"), /Anna nimmt Cara als Helfer in Neuhaven auf/);
		assert.doesNotMatch(await does(cara.p, "arbeite", /Baustelle|geschlossen/), /geschlossen/);
		assert.match(await does(cara.p, "bau hütte", "geschlossen"), /Du bist Helfer/);
		await does(anna.p, "siedlung aufnehmen Cara", "nimmt");
		assert.doesNotMatch(await does(cara.p, "bau hütte", /steckt|passt|geschlossen/), /geschlossen/);
		assert.equal((await s.readAll({ type: "Site" })).map((e) => e.fields as unknown as SiteFields).length <= 1, true);
		await does(anna.p, "siedlung entlassen Cara", "entlässt");
		assert.match(await does(anna.p, "siedlung offen", "öffnet"), /Anna öffnet Neuhaven/);

		// a hut gone: too few, it ends; the huts stay
		assert.equal(await settlementTick(s, w, 60_000), 0);
		await s.takeIfExists({ type: "Building", fields: { buildId: "hut-2" } }, 0);
		assert.equal(await settlementTick(s, w, 60_000), 1);
		assert.equal(await s.count({ type: "Settlement" }), 0);
		assert.equal(await s.count({ type: "SettlementName" }), 0, "its name is free again");
		assert.equal(await s.count({ type: "Building", fields: { plan: "huette" } }), 2);
	} finally { await srv.close(); }
});
