// What a finger means on the map (client/cellActions.ts) and the way a tap walks (client/walk.ts nextStep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellAbout, cellEntries, hereEntries, tapTarget } from "../client/cellActions.ts";
import { nextStep } from "../client/walk.ts";
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
});

test("the way goes around what stands in it, and none is none", () => {
	const wall = (x: number, y: number) => x >= 0 && y >= 0 && x < 5 && y < 5 && !(x === 2 && y < 4);
	assert.deepEqual(nextStep(wall, { x: 0, y: 0 }, { x: 4, y: 0 }), [0, 1]);
	assert.equal(nextStep(wall, { x: 1, y: 1 }, { x: 1, y: 1 }), null);
	const closed = (x: number, y: number) => x >= 0 && y >= 0 && x < 5 && y < 5 && x !== 2;
	assert.equal(nextStep(closed, { x: 0, y: 0 }, { x: 4, y: 0 }), null);
});

test("the bar offers a field once, for the cell one stands on, not for every cell around", () => {
	const spade = new Map([...objs, ["spade", obj({ id: "spade", kind: "item", name: "Spaten", location: "me", x: -1, y: -1 })]]);
	const lines = hereEntries({ chars, objs: spade, self: me, room: "r", me: "me", plans: [], guest: false, fuel: undefined }).map((e) => e.line).filter((l) => l.startsWith("flur anlegen"));
	assert.deepEqual(lines, ["flur anlegen 5 5"]);
});
