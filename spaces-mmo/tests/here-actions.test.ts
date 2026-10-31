// The bar "Hier möglich" (client/cellActions.ts): what the menus around the figure offer, each once; seeds only where wild
// plants grow.
import assert from "node:assert/strict";
import test from "node:test";
import { hereEntries, wildHere } from "../client/cellActions.ts";
import type { CharView, ObjView } from "../server/gateway.ts";

const self = { charId: "c", name: "Ole", x: 5, y: 5, skin: 0 } as CharView;
const input = (o: ObjView[], wild = true) => ({ chars: new Map([["c", self]]), objs: new Map(o.map((x) => [x.id, x])), self, room: "r", me: "c", plans: [], guest: false, fuel: undefined, wild });
const site = (x: number): ObjView => ({ id: "s", kind: "site", name: "Hütte", location: "r", x, y: 5, w: 2, h: 2, owner: "Ole", ownerId: "c", progress: 0.2 });

test("the bar comes in the order of what waits: the harvest before the work on a site, the seeds last", () => {
	const lines = hereEntries(input([site(7), { id: "b", kind: "bed", name: "Beet", location: "r", x: 4, y: 5, w: 1, h: 1, owner: "Ole", ownerId: "c", plants: [{ x: 4, y: 5, sort: "kohl", stage: 2 }] } as unknown as ObjView])).map((e) => e.line);
	const at = (r: RegExp) => lines.findIndex((l) => r.test(l));
	assert.ok(at(/^ernte/) >= 0, lines.join());
	assert.ok(at(/^ernte/) < at(/^(?:arbeite|liefere)/), lines.join());
	assert.equal(lines.at(-1), "sammle samen");
});

test("a site two cells away shows what can be done at it, once, though it covers several cells; one further away nothing", () => {
	const lines = hereEntries(input([site(7)])).map((e) => e.line);
	assert.ok(lines.some((l) => /arbeite|liefere/.test(l)), lines.join());
	assert.equal(new Set(lines).size, lines.length);
	assert.ok(!lines.some((l) => l.startsWith("move ") || l === "look" || l === "who" || l === "reputation"), "no going, no looking");
	assert.ok(!hereEntries(input([site(9)])).some((e) => /arbeite|liefere/.test(e.line)));
});

test("seeds are offered where wild plants grow", () => {
	assert.ok(hereEntries(input([])).some((e) => e.line === "sammle samen"));
	assert.ok(!hereEntries(input([], false)).some((e) => e.line === "sammle samen"));
	const decor = { "*": { model: "flower" }, T: { model: "tree" } };
	assert.equal(wildHere(decor, ["  *  "]), true);
	assert.equal(wildHere(decor, ["  T  "]), false);
	assert.equal(wildHere(decor, undefined), false);
});
