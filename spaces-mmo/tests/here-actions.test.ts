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

test("what is done and cannot be done again leaves the bar until it can: mending before a term's last days, work while resting, what is not ready", () => {
	const DAY = 24 * 3_600_000, decay = 100 * DAY;
	const wood = { id: "i1", kind: "item", name: "Treibholz", location: "c", x: -1, y: -1 } as ObjView;
	const hut = (term: number | undefined): ObjView => ({ id: "h", kind: "building", name: "Hütte", plan: "huette", location: "r", x: 6, y: 5, w: 2, h: 2, owner: "Ole", ownerId: "c", ...(term === undefined ? {} : { term }) });
	const road = (term: number): ObjView => ({ id: "rd", kind: "road", name: "Straße nach Mitte", location: "r", x: 4, y: 5, through: true, runs: [[{ x: 4, y: 5 }, { x: 4, y: 6 }]], roadState: "built", roadTo: "m", term });
	const plans = [{ key: "huette", name: "Hütte", w: 2, h: 2, needs: "", work: 1, repair: [{ name: "Treibholz", count: 1 }] }];
	const lines = (o: ObjView[], more: { decay?: number; tired?: boolean; todos?: [] } = {}) => hereEntries({ ...input([wood, ...o]), plans, ...more }).map((e) => e.line);
	// just mended (40 days ahead): neither the building nor the road is offered; in its last five days both are; without the clock as before
	assert.ok(!lines([hut(decay + 40 * DAY), road(decay + 40 * DAY)], { decay }).some((l) => l.startsWith("repariere") || l === "straße repariere"));
	assert.ok(lines([hut(decay + 4 * DAY), road(decay + 4 * DAY)], { decay }).includes("repariere @6,5"));
	assert.ok(lines([hut(decay + 4 * DAY), road(decay + 4 * DAY)], { decay }).includes("straße repariere"));
	assert.ok(lines([hut(decay + 40 * DAY)]).includes("repariere @6,5"), "no clock: offered");
	assert.ok(lines([hut(undefined)], { decay }).includes("repariere @6,5"), "no term: offered");
	// work while the figure rests: gone, and back when the rest is over; delivering stays
	const pick = { id: "i2", kind: "item", name: "Treibholz", location: "c", x: -1, y: -1 } as ObjView;
	const withSite = [pick, site(7)];
	assert.ok(lines(withSite).includes("arbeite"));
	assert.ok(!lines(withSite, { tired: true }).includes("arbeite"));
	assert.ok(lines(withSite, { tired: false }).includes("arbeite"));
	// a yield is offered only when the tasks say it is ready (the bar now has them, as the menu)
	const coop: ObjView = { id: "k", kind: "building", name: "Hühnerstall", plan: "huehnerstall", location: "r", x: 6, y: 5, w: 2, h: 1, owner: "Ole", ownerId: "c", herd: "huhn" };
	assert.ok(lines([coop]).some((l) => l.startsWith("einsammeln")), "no tasks: offered");
	assert.ok(!lines([coop], { todos: [] }).some((l) => l.startsWith("einsammeln")), "nothing ready: not offered");
	// a road voted on: the vote only for those who may cast it (the settlers of its two places), as the server decides
	const voted: ObjView = { ...road(0), roadState: "vote", voterIds: ["acc-a"] };
	const votes = (account?: string) => hereEntries({ ...input([voted]), plans, ...(account ? { account } : {}) }).map((e) => e.line).filter((l) => l.startsWith("straße ja") || l.startsWith("straße nein"));
	assert.deepEqual(votes("acc-a"), ["straße ja Mitte", "straße nein Mitte"]);
	assert.deepEqual(votes("acc-b"), [], "not a voter");
	assert.deepEqual(votes(), [], "no account known");
});
