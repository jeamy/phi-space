// What a finger means on the map (client/cellActions.ts) and the way a tap walks (client/walk.ts nextStep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellAbout, cellEntries, hereEntries, itemEntries, tapTarget } from "../client/cellActions.ts";
import { nextStep } from "../client/walk.ts";
import { sentences } from "../client/sentences.ts";
import type { CharView, ObjView } from "../server/gateway.ts";

const char = (charId: string, name: string, x: number, y: number) => ({ charId, name, x, y }) as CharView;
const obj = (o: Partial<ObjView> & { id: string; kind: ObjView["kind"]; x: number; y: number }) => ({ name: o.id, location: "r", ...o }) as ObjView;
const me = char("me", "Mira", 5, 5);
const chars = new Map([["me", me], ["o", char("o", "Ines", 8, 5)]]);
const objs = new Map([
	["hut", obj({ id: "hut", kind: "building", name: "Hütte", owner: "Mira", ownerId: "me", plan: "huette", x: 10, y: 10, w: 3, h: 2 })],
	["wood", obj({ id: "wood", kind: "item", name: "Treibholz", x: 2, y: 2 })],
	["door", obj({ id: "door", kind: "exit", name: "ost", x: 23, y: 8 })],
]);
const input = { chars, objs, self: me, room: "r", me: "me", plans: [], guest: false, fuel: undefined, onPlans: () => {} };

test("a tap opens what stands on that cell; the cell beside it stays free ground to walk to", () => {
	assert.deepEqual(tapTarget({ x: 11, y: 11 }, chars, objs, "r", "me"), { x: 11, y: 11 });
	assert.deepEqual(tapTarget({ x: 8, y: 5 }, chars, objs, "r", "me"), { x: 8, y: 5 });
	assert.equal(tapTarget({ x: 7, y: 5 }, chars, objs, "r", "me"), null);
	assert.equal(tapTarget({ x: 16, y: 3 }, chars, objs, "r", "me"), null);
	assert.deepEqual(tapTarget({ x: 5, y: 5 }, chars, objs, "r", "me"), { x: 5, y: 5 });
});

test("an exit under the finger is walked to, not taken for what stands beside it", () => {
	const near = new Map([...chars, ["b", char("b", "Bo", 22, 8)]]);
	assert.equal(tapTarget({ x: 23, y: 8 }, near, objs, "r", "me"), null);
});

test("the entries of a building cover its whole area", () => {
	const labels = cellEntries({ ...input, at: { x: 12, y: 11 } }).map((e) => e.label);
	assert.ok(labels.includes("Hütte von Mira ansehen"));
	assert.ok(!labels.includes("Bauen …"));
});

test("a free cell offers the walk and building", () => {
	const plan = [{ key: "huette", name: "Hütte", w: 3, h: 2, needs: "", work: 1 }] as never;
	let asked = false;
	const es = cellEntries({ ...input, plans: plan, at: { x: 16, y: 3 }, onPlans: () => { asked = true; } });
	assert.ok(es.some((e) => e.line === "move 16 3"));
	es.find((e) => e.label === "Bauen …")!.run!();
	assert.ok(asked);
});

test("the sheet's head names the thing and finds its help", () => {
	assert.deepEqual(cellAbout({ x: 10, y: 10 }, chars, objs, "r"), { title: "Hütte von Mira", article: "help.game.build" });
	assert.equal(cellAbout({ x: 8, y: 5 }, chars, objs, "r").title, "Ines");
	const stone = new Map([["s", obj({ id: "s", kind: "scenery", name: "Hoher Stein", desc: "Ein aufrechter Stein.", x: 3, y: 3 })]]);
	assert.deepEqual(cellAbout({ x: 3, y: 3 }, chars, stone, "r"), { title: "Hoher Stein", desc: "Ein aufrechter Stein." }, "scenery tells what it is, no general article");
});

test("the way goes around what stands in it, and none is none", () => {
	const wall = (x: number, y: number) => x >= 0 && y >= 0 && x < 5 && y < 5 && !(x === 2 && y < 4);
	assert.deepEqual(nextStep(wall, { x: 0, y: 0 }, { x: 4, y: 0 }), [0, 1]);
	assert.equal(nextStep(wall, { x: 1, y: 1 }, { x: 1, y: 1 }), null);
	const closed = (x: number, y: number) => x >= 0 && y >= 0 && x < 5 && y < 5 && x !== 2;
	assert.equal(nextStep(closed, { x: 0, y: 0 }, { x: 4, y: 0 }), null);
});

test("a carried thing shows what it can do here and now, nothing it cannot", () => {
	const uses = { recipes: [{ key: "tangseil", name: "Tangseil", needs: [{ name: "Tang", count: 3 }] }, { key: "tuch", name: "Tuch", needs: [{ name: "Wolle", count: 3 }], tool: "Spindel", at: "webstuhl" }], feed: { huhn: ["Hafer"] }, offerings: ["Perle"], flowers: [], chests: ["huette"], stores: [] };
	const pack = (n: string, k: number) => Array.from({ length: k }, (_, i): [string, ObjView] => [`${n}${i}`, obj({ id: `${n}${i}`, kind: "item", name: n, location: "me", x: 0, y: 0 })]);
	const at = (...more: Array<[string, ObjView]>) => ({ ...input, objs: new Map<string, ObjView>(more) });
	const lines = (n: string, i: ReturnType<typeof at>) => itemEntries(n, i, uses, { fuels: ["Treibholz"] }).map((e) => e.line);
	assert.deepEqual(lines("Hafer", at(...pack("Hafer", 1))), [], "far from everything: only laying down and looking");
	assert.deepEqual(lines("Tang", at(...pack("Tang", 2))), [], "two of three");
	assert.deepEqual(lines("Tang", at(...pack("Tang", 3))), ["craft tangseil"]);
	const coop: [string, ObjView] = ["c", obj({ id: "c", kind: "building", name: "Hühnerstall", plan: "huehnerstall", herd: "huhn", x: 6, y: 5, w: 2, h: 1 })];
	assert.ok(lines("Hafer", at(coop, ...pack("Hafer", 1))).includes("füttere Hafer"));
	assert.ok(!lines("Stein", at(coop, ...pack("Stein", 1))).includes("füttere Stein"));
	const site: [string, ObjView] = ["s", obj({ id: "s", kind: "site", name: "Hütte", ownerId: "me", missing: "2 Treibholz, 5 Arbeit", x: 6, y: 5, w: 2, h: 2 })];
	assert.ok(lines("Treibholz", at(site, ...pack("Treibholz", 1))).includes("liefere Treibholz"));
	assert.ok(!lines("Tang", at(site, ...pack("Tangseil", 1), ...pack("Tang", 1))).includes("liefere Tangseil"), "Tang is not the Tangseil");
	const fire: [string, ObjView] = ["b", obj({ id: "b", kind: "beacon", name: "Leuchtfeuer", x: 6, y: 5 })];
	assert.ok(lines("Treibholz", at(fire, ...pack("Treibholz", 1))).includes("put Treibholz in Leuchtfeuer"));
	const ines = new Map([["me", me], ["o", char("o", "Ines", 6, 5)]]);
	assert.deepEqual(itemEntries("Hafer", { ...at(...pack("Hafer", 1)), chars: ines, offer: () => {} }, uses, { fuels: [], market: () => {} }).map((e) => e.line), ["give Hafer an Ines", "#offer Ines", "#sell"]);
	assert.deepEqual(itemEntries("Hafer", { ...at(...pack("Hafer", 1)), chars: ines, guest: true }, uses, { fuels: [] }), [], "a guest gives nothing");
});

test("an own fallow field offers what one carries to sow", () => {
	const field = (more: Array<[string, ObjView]>) => new Map<string, ObjView>([["f", obj({ id: "f", kind: "field", ownerId: "me", owner: "Mira", fieldStage: "brach", x: 6, y: 5, w: 4, h: 4 })], ...more]);
	const lines = (o: Map<string, ObjView>) => cellEntries({ ...input, at: { x: 6, y: 5 }, objs: o }).map((e) => e.line);
	assert.ok(lines(field([])).includes("bestelle"));
	const carried = lines(field([["h", obj({ id: "h", kind: "item", name: "Hafer", location: "me", x: 0, y: 0 })], ["l", obj({ id: "l", kind: "item", name: "Leinsamen", location: "me", x: 0, y: 0 })]]));
	assert.ok(carried.includes("bestelle hafer") && carried.includes("bestelle flachs") && !carried.includes("bestelle"));
});

test("the bar offers a field once, for the cell one stands on, not for every cell around", () => {
	const spade = new Map([...objs, ["spade", obj({ id: "spade", kind: "item", name: "Spaten", location: "me", x: -1, y: -1 })]]);
	const lines = hereEntries({ chars, objs: spade, self: me, room: "r", me: "me", plans: [], guest: false, fuel: undefined }).map((e) => e.line).filter((l) => l.startsWith("flur anlegen"));
	assert.deepEqual(lines, ["flur anlegen"], "on one's own cell, which may be a way, the field lies beside the figure");
});

test("a long text falls into sentences, an abbreviation does not end one", () => {
	assert.deepEqual(sentences("Eins, z. B. dies. Zwei „look“. Drei."), ["Eins, z. B. dies.", "Zwei „look“.", "Drei."]);
});
