// Fields, step 3 part 1 (docs/siedeln.md "Äcker und Getreide", engine/commands/field.ts): a field is staked out with a
// spade in the light, its owner chooses the crop, seed and work sow it (on an open field anyone helps); when it is ripe,
// ten hands at once bring it in exactly once, every grain in someone's pack; the same crop group twice tires the soil.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { harvestOf, shareOf, soilFor } from "../server/engine/commands/field.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld, walkable } from "../server/engine/world.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import type { FieldFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const w = await loadWorld();
const d = w.fields!;
const crop = (k: string) => d.crops.find((c) => c.key === k)!;

test("the soil: the same group twice in a row gives less, another group or a rest heals it; the shares add up to the yield", () => {
	const DAY = 24 * 3600_000;
	const after = (lastGroup: string | null, tired = 0) => ({ lastGroup, tired, lastHarvestWorldMs: 10 * DAY });
	assert.deepEqual(soilFor(d, after(null), crop("gerste"), 11 * DAY), { tired: 0, factor: 1 });
	assert.deepEqual(soilFor(d, after("Getreide"), crop("weizen"), 11 * DAY), { tired: 1, factor: d.tired[1] }, "barley after wheat: both grain");
	assert.deepEqual(soilFor(d, after("Getreide", 1), crop("hafer"), 11 * DAY), { tired: 2, factor: d.tired[2] });
	assert.equal(soilFor(d, after("Getreide", 5), crop("hafer"), 11 * DAY).factor, d.tired.at(-1));
	assert.deepEqual(soilFor(d, after("Getreide", 1), crop("kartoffel"), 11 * DAY), { tired: 0, factor: 1 }, "potatoes after grain");
	assert.deepEqual(soilFor(d, after("Getreide", 1), crop("gerste"), 10 * DAY + d.fallowWorldMs), { tired: 0, factor: 1 }, "a rest heals");
	const tiredYield = harvestOf(crop("gerste"), 16, d.tired[1]!)[0]!.count;
	assert.ok(tiredYield < harvestOf(crop("gerste"), 16, 1)[0]!.count, "müder Boden gibt weniger");
	for (const [total, need] of [[16, 8], [9, 8], [3, 8], [24, 7]] as const) {
		let sum = 0;
		for (let i = 0; i < need; i++) sum += shareOf(total, need, i);
		assert.equal(sum, total, `${total} in ${need} shares`);
	}
});

type P = { p: Player; me: string; name: string };
async function player(url: string, name: string): Promise<P> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId, name };
}
async function does(p: Player, line: string, text: string | RegExp, ms = 40_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function give(space: SpaceLike, charId: string, proto: string, count: number): Promise<void> {
	const p = (await eventually(() => resolvePrototype(space, proto), 10_000, `prototype ${proto}`))!;
	for (let i = 0; i < count; i++) await spawn(space, null, w, p, { location: charId, x: -1, y: -1 });
}
async function walk(a: P, space: SpaceLike, x: number, y: number): Promise<void> {
	a.p.send(`move ${x} ${y}`);
	await eventually(async () => { const c = (await space.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 40_000, `${a.name} at ${x},${y}`);
}
const pack = async (space: SpaceLike, charId: string, proto: string) => (await space.readAll({ type: "Item", fields: { location: charId, proto } })).length;
const theField = async (space: SpaceLike) => (await space.readAll({ type: "Field" }))[0]?.fields as unknown as FieldFields | undefined;
const rested = async (space: SpaceLike) => { for (const e of await space.readAll({ type: "WorkRest" })) await space.takeIfExists({ id: e.id }, 0); };

test("a field: staked out with a spade, sown with seed and work, brought in by ten hands exactly once", { timeout: 300_000 }, async () => {
	// 0.001: a world hour (the rest after work) is 3.6 s
	// a village at once (the threshold 0): the count at the world's start writes it, and fields may be staked out
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001", SPACES_MMO_EPOCH_DORF: "0" } });
	try {
		const s = srv.stack.space;
		const boss = await player(srv.url, "Bäuerin");
		await lightFire(s, 3_600_000, "feuer-bucht");
		await walk(boss, s, 16, 11);
		assert.match(await does(boss.p, "flur anlegen", "Spaten"), /bricht man mit einem Spaten/);
		await give(s, boss.me, "spaten", 1);
		let staked = "";
		for (let i = 0; i < 5 && !staked.includes("bricht eine Flur"); i++) {
			for (const e of await s.readAll({ type: "Item", fields: { location: "graue-bucht" } })) if (Number(e.fields.x) >= 14 && Number(e.fields.y) >= 12) await s.takeIfExists({ id: e.id }, 0);
			staked = await does(boss.p, "flur anlegen", /bricht eine Flur um|passt keine Flur/);
		}
		assert.match(staked, /Bäuerin bricht eine Flur um \(4×4\)/);
		const f0 = (await theField(s))!;
		assert.equal((await s.readAll({ type: "Plot", fields: { of: f0.fieldId } })).length, 16, "one entry, sixteen cells");
		assert.match(await does(boss.p, "flur anlegen", "Flur"), /Mehr als 1 Flur/);
		await boss.p.until((f) => f.t === "obj" && f.o.kind === "field" && f.o.fieldStage === "brach" && f.o.w === 4, 10_000);

		// sowing: the owner chooses, seed and work; a stranger may not until the field is open
		assert.match(await does(boss.p, "bestelle", "Was säst du"), /Gerste/);
		await give(s, boss.me, "gerste", 5);
		assert.match(await does(boss.p, "bestelle gerste", "pflügt"), /4 Gerste\); es fehlen noch 1 Arbeit/);
		assert.equal(await pack(s, boss.me, "gerste"), 1, "only what it needs is taken");
		const helper = await player(srv.url, "Knecht");
		await walk(helper, s, f0.x + 1, f0.y - 1);
		assert.match(await does(helper.p, "bestelle", "darf"), /wer sie angelegt hat/);
		assert.match(await does(boss.p, "flur offen", "öffnet"), /säen und ernten darf jetzt jeder/);
		assert.match(await does(helper.p, "bestelle", "bestellt"), /ist mit Gerste bestellt \(Bäuerin \(1\), Knecht \(1\)\)\. Reif in etwa/);
		let f = (await theField(s))!;
		assert.equal(f.stage, "waechst");
		assert.deepEqual(f.yields, [{ proto: "gerste", count: 16 }]);
		assert.match(await does(boss.p, "ernte", "nicht reif"), /noch nicht reif/);
		// a bed of the owner's beside her as well as the field: plain "ernte" means the bed, "ernte flur" the field
		const accountId = String((await s.readAll({ type: "Character", fields: { charId: boss.me } }))[0]!.fields.accountId);
		await s.write({ type: "Bed", fields: { bedId: "bed-near", room: "graue-bucht", x: 17, y: 10, w: 1, h: 1, owner: boss.me, ownerName: "Bäuerin", accountId, beaconId: "feuer-bucht", points: 1, sponsors: [], plants: [], wateredWorldMs: 0, weedy: false, dueWorldMs: FOREVER, untilWorldMs: FOREVER, at: 0 } as never }, null, FOREVER);
		assert.match(await does(boss.p, "ernte", "Beet"), /Im Beet ist noch nichts reif/);
		assert.match(await does(boss.p, "ernte flur", "nicht reif"), /Gerste ist noch nicht reif/);
		await s.takeIfExists({ type: "Bed", fields: { bedId: "bed-near" } }, 0);

		// its time comes (the date moved forward): the field tick makes it ripe
		const t = (await s.take({ type: "Field", fields: { fieldId: f.fieldId } }, 5_000))!;
		await s.write({ type: "Field", fields: { ...(t.fields as unknown as FieldFields), dueWorldMs: (await worldNowOf(s)) - 1 } as never }, null, FOREVER);
		await boss.p.until((x) => x.t === "msg" && /Gerste auf der Flur von Bäuerin ist reif: 8 Hände-Stunden/.test(x.m.text), 30_000);
		f = (await theField(s))!;
		assert.equal(f.stage, "reif");

		// ten hands around it, beside it and two cells away, harvest at once: eight points, every grain once
		const room = w.rooms.find((r) => r.roomId === "graue-bucht")!;
		const taken = new Set((await s.readAll({ type: "Plot", fields: { room: "graue-bucht" } })).map((e) => `${e.fields.x},${e.fields.y}`));
		const fire = w.beacons.find((b) => b.beaconId === "feuer-bucht")!;
		const ring: Array<[number, number]> = [];
		for (let y = f.y - 2; y < f.y + f.h + 2; y++) for (let x = f.x - 2; x < f.x + f.w + 2; x++)
			if (!taken.has(`${x},${y}`) && walkable(w, room.ground, x, y) && Math.max(Math.abs(x - fire.x), Math.abs(y - fire.y)) > 1 && !(x === f.x + 1 && y === f.y - 1)) ring.push([x, y]);
		const crew: P[] = [boss, helper];
		for (let i = 0; crew.length < 10; i++) { const a = await player(srv.url, `Schnitter${i}`); crew.push(a); }
		// a cell flotsam or someone else took meanwhile is skipped
		for (const a of crew) {
			if (a === helper) continue;
			for (;;) {
				const [x, y] = ring.shift()!;
				for (const e of await s.readAll({ type: "Item", fields: { location: "graue-bucht" } })) if (e.fields.x === x && e.fields.y === y) await s.takeIfExists({ id: e.id }, 0);
				a.p.send(`move ${x} ${y}`);
				const there = await eventually(async () => { const c = (await s.readAll({ type: "Character", fields: { charId: a.me } }))[0]?.fields; return c?.x === x && c?.y === y; }, 15_000, "").then(() => true, () => false);
				if (there) break;
			}
		}
		await rested(s);
		for (let round = 0; round < 4 && (await theField(s))?.stage !== "brach"; round++) {
			if (round) { await new Promise((ok) => setTimeout(ok, 4_000)); await rested(s); }
			await Promise.all(crew.map((a) => does(a.p, "ernte", /erntet auf der Flur|eingebracht|liegt brach|müde|greifbar|darf/)));
			await new Promise((ok) => setTimeout(ok, 500));
		}
		await eventually(async () => (await theField(s))?.stage === "brach", 30_000, "the field brought in");
		await boss.p.until((x) => x.t === "msg" && /Die Gerste der Flur von Bäuerin ist eingebracht!/.test(x.m.text), 10_000);
		let total = 0, hands = 0;
		for (const a of crew) { const n = (await pack(s, a.me, "gerste")) - (a === boss ? 1 : 0); total += n; if (n) hands++; }
		assert.equal(total, 16, "every grain in exactly one pack");
		assert.equal(hands, 8, "eight work points, eight hands, two each");
		f = (await theField(s))!;
		assert.equal(f.lastGroup, "Getreide");
		assert.equal(f.crop, null);
		assert.match(await does(crew[9]!.p, "ernte", "brach"), /liegt brach/);

		// the same group again: the soil is tired
		await rested(s);
		await give(s, boss.me, "hafer", 4);
		await does(boss.p, "bestelle hafer", "pflügt");
		await rested(s);
		assert.match(await does(boss.p, "bestelle", "bestellt"), /der Boden ist müde und gibt weniger/);
		f = (await theField(s))!;
		assert.deepEqual(f.yields, [{ proto: "hafer", count: Math.floor(16 * d.tired[1]!) }]);
		assert.match(await does(boss.p, "flur", "Flur von Bäuerin"), /Hafer wächst/);
		for (const a of crew) await a.p.leave();
	} finally { await srv.close(); }
});
