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

test("a figure that offers a trade has accept and decline first (a tap on its speech bubble opens this menu)", () => {
	const offersIn = [{ fromName: "Ines", giveNames: ["Münze"], want: [{ name: "Muschel", count: 1 }] }];
	const lines = cellEntries({ ...input, offersIn, at: { x: 8, y: 5 } });
	assert.deepEqual(lines.slice(0, 2).map((e) => e.line), ["accept Ines", "decline Ines"]);
	assert.equal(lines[0]!.label, "accept Ines – 1 Münze für 1 Muschel");
	assert.ok(!cellEntries({ ...input, at: { x: 8, y: 5 } }).some((e) => e.line.startsWith("accept")), "no offer, no accept");
	assert.ok(!cellEntries({ ...input, offersIn: [{ ...offersIn[0]!, fromName: "Bente" }], at: { x: 8, y: 5 } }).some((e) => e.line.startsWith("accept")), "only the one who offered");
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
	const uses = { recipes: [{ key: "tangseil", name: "Tangseil", needs: [{ name: "Tang", count: 3 }] }, { key: "tuch", name: "Tuch", needs: [{ name: "Wolle", count: 3 }], tool: "Spindel", at: "webstuhl" }], feed: { huhn: ["Hafer"] }, offerings: ["Perle"], flowers: [], chests: ["huette"], stores: [], steps: [] };
	const pack = (n: string, k: number) => Array.from({ length: k }, (_, i): [string, ObjView] => [`${n}${i}`, obj({ id: `${n}${i}`, kind: "item", name: n, location: "me", x: 0, y: 0 })]);
	// alone in the room: whom to give or offer to is the business of the cases with people below
	const at = (...more: Array<[string, ObjView]>) => ({ ...input, chars: new Map([["me", me]]), objs: new Map<string, ObjView>(more) });
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
	// anyone in the room, not only beside one: the nearest first
	const far = new Map([["me", me], ["f", char("f", "Fern", 18, 12)], ["o", char("o", "Ines", 6, 5)]]);
	assert.deepEqual(itemEntries("Hafer", { ...at(...pack("Hafer", 1)), chars: far, offer: () => {} }, uses, { fuels: [] }).map((e) => e.line), ["give Hafer an Ines", "#offer Ines", "give Hafer an Fern", "#offer Fern"]);
	// registered players only: no guest, no NPC, no settler
	const crowd = new Map<string, CharView>([["me", me], ["o", char("o", "Ines", 6, 5)], ["g", { ...char("g", "Gast-12", 6, 6), guest: true }], ["n", char("npc-marta", "Marta", 7, 5)], ["a", { ...char("x", "Hark", 7, 6), ai: true }], ["s", { ...char("npc-siedler-1", "Ole", 7, 7), settler: true }]]);
	assert.deepEqual(itemEntries("Hafer", { ...at(...pack("Hafer", 1)), chars: crowd, offer: () => {} }, uses, { fuels: [] }).map((e) => e.line), ["give Hafer an Ines", "#offer Ines"]);
});

test("a bed offers only the seeds that grow in it: flowers anywhere, vegetables not in the flower bed, a field's seed never", () => {
	const beds = { flowers: ["Strandnelkensamen"], plants: ["Strandkohlsamen"], field: ["Rübensamen", "Leinsamen", "Weizen"] };
	const carried = ["Strandnelkensamen", "Strandkohlsamen", "Rübensamen", "Leinsamen", "Abendrot-Samen", "Weizen", "Muschel"].map((n): [string, ObjView] => [n, obj({ id: n, kind: "item", name: n, location: "me", x: 0, y: 0 })]);
	const lines = (bedKind: ObjView["bedKind"], b?: typeof beds) => cellEntries({ ...input, beds: b, at: { x: 6, y: 5 }, objs: new Map<string, ObjView>([["b", obj({ id: "b", kind: "bed", name: "Beet", ownerId: "me", owner: "Mira", bedKind, plants: [], x: 6, y: 5, w: 2, h: 2 })], ...carried]) }).map((e) => e.line).filter((l) => l.startsWith("pflanze"));
	assert.deepEqual(lines(undefined, beds), ["pflanze Strandnelkensamen", "pflanze Strandkohlsamen", "pflanze Abendrot-Samen"]);
	assert.deepEqual(lines("zier", beds), ["pflanze Strandnelkensamen", "pflanze Abendrot-Samen"], "the flower bed takes flowers and their crossings");
	assert.deepEqual(lines("gemein", beds), ["pflanze Strandnelkensamen", "pflanze Strandkohlsamen", "pflanze Abendrot-Samen"]);
	assert.ok(lines("zier").includes("pflanze Rübensamen"), "without the world's list every seed is offered");
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

test("feeding is offered at a coop only while animals live in it", () => {
	const coop = (herd?: string) => new Map<string, ObjView>([["c", obj({ id: "c", kind: "building", name: "Hühnerstall", plan: "huehnerstall", ownerId: "thees", ...(herd ? { herd } : {}), x: 6, y: 5, w: 2, h: 1 })]]);
	const lines = (o: Map<string, ObjView>) => cellEntries({ ...input, at: { x: 6, y: 5 }, objs: o }).map((e) => e.line);
	const labels = (o: Map<string, ObjView>) => cellEntries({ ...input, at: { x: 6, y: 5 }, objs: o }).map((e) => e.label);
	assert.equal(labels(coop("huhn")).filter((l) => /ansehen/.test(l)).length, 1, "one way to look at a coop, not two with different answers");
	assert.ok(lines(coop("huhn")).includes("stall") && lines(coop()).includes("stall"));
	assert.ok(lines(coop("huhn")).includes("füttere"));
	assert.ok(!lines(coop()).includes("füttere") && lines(coop()).includes("stall"), "an empty coop can only be looked at");
});

test("the large ship offers its timetable and a ride to every other island", () => {
	const ship = new Map<string, ObjView>([["liner", obj({ id: "liner", kind: "liner", name: "Großes Schiff", fare: 3, routes: [{ island: "Nord", room: "n" }, { island: "Ost", room: "o" }], x: 6, y: 5, w: 5, h: 1 })]]);
	const es = cellEntries({ ...input, at: { x: 8, y: 5 }, objs: ship });
	assert.ok(es.some((e) => e.line === "fahrplan") && es.some((e) => e.line === "einschiffen Nord" && /3 Münzen/.test(e.label)) && es.some((e) => e.line === "einschiffen Ost"));
	assert.deepEqual(cellAbout({ x: 8, y: 5 }, new Map(), ship, "r"), { title: "Großes Schiff", article: "help.game.village#travel" });
	assert.equal(tapTarget({ x: 8, y: 5 }, new Map(), ship, "r", "me")?.x, 8, "a tap on the ship opens its menu");
});

test("a jetty, a station and an own cart offer what they are for", () => {
	const item = (n: string): [string, ObjView] => [n, obj({ id: n, kind: "item", name: n, location: "me", x: 0, y: 0 })];
	const at = (o: ObjView, ...more: Array<[string, ObjView]>) => cellEntries({ ...input, at: { x: o.x, y: o.y }, objs: new Map<string, ObjView>([[o.id, o], ...more]), sail: ["Nord"] }).map((e) => e.line);
	const jetty = obj({ id: "j", kind: "building", name: "Steg", plan: "steg", x: 6, y: 5, w: 2, h: 1 });
	assert.ok(!at(jetty).includes("rudere"), "no boat, no rowing");
	assert.deepEqual(at(jetty, item("Ruderboot"), item("Segelboot")).filter((l) => /^(rudere|segle|luke)/.test(l)), ["rudere", "segle Nord", "luke", "luke entlade alle"]);
	assert.ok(at(obj({ id: "b", kind: "building", name: "Bahnhof", plan: "bahnhof", x: 6, y: 5, w: 3, h: 2 })).includes("zug"));
	const cart = obj({ id: "k", kind: "cart", name: "Karren von Mira", ownerId: "me", x: 6, y: 5 });
	assert.deepEqual(at(cart, item("Tang")).filter((l) => l.startsWith("karren")), ["karren", "karren lade Tang", "karren entlade", "karren nimm"]);
	assert.ok(!at({ ...cart, ownerId: "other" }).includes("karren"), "only the owner's cart");
});

test("with the world's places, boats, trains and carts get one entry per place", () => {
	const rooms = [{ roomId: "a", name: "Anlegestelle", island: "I" }, { roomId: "b", name: "Bucht", island: "I" }, { roomId: "c", name: "Cairn", island: "I" }, { roomId: "r", name: "Rand", island: "J" }];
	const travel = { rooms, stops: { jetties: ["r", "b", "c"], stations: ["b", "r"], trainFare: 1, roads: [["r", "b"], ["b", "c"]] as Array<[string, string]> } };
	const item = (n: string): [string, ObjView] => [n, obj({ id: n, kind: "item", name: n, location: "me", x: 0, y: 0 })];
	const lines = (o: ObjView, room: string, ...more: Array<[string, ObjView]>) => cellEntries({ ...input, room, at: { x: o.x, y: o.y }, objs: new Map<string, ObjView>([[o.id, { ...o, location: room }], ...more]), travel, sail: [] }).map((e) => e.line);
	assert.deepEqual(lines(obj({ id: "j", kind: "building", name: "Steg", plan: "steg", x: 6, y: 5, w: 2, h: 1 }), "a", item("Ruderboot")).filter((l) => l.startsWith("rudere")), ["rudere Bucht", "rudere Cairn"], "this island's jetties, not this room, not another island");
	assert.deepEqual(lines(obj({ id: "b", kind: "building", name: "Bahnhof", plan: "bahnhof", x: 6, y: 5, w: 3, h: 2 }), "a").filter((l) => l.startsWith("zug")), ["zug Bucht"]);
	assert.deepEqual(lines(obj({ id: "k", kind: "cart", name: "Karren", ownerId: "me", x: 6, y: 5 }), "r").filter((l) => l.startsWith("karren fahre")), ["karren fahre Bucht", "karren fahre Cairn"], "the rooms the roads reach, nearest first");
});

test("beside a coop that is still a site, \"what is missing?\" asks the site, not the animals", () => {
	const site = obj({ id: "s", kind: "site", name: "Hühnerstall", owner: "Keno", ownerId: "k", plan: "huehnerstall", x: 6, y: 5, w: 2, h: 1 });
	const lines = cellEntries({ ...input, objs: new Map([["s", site]]), at: { x: 6, y: 5 } }).map((e) => e.line);
	assert.ok(lines.includes("baustelle 6 5"), lines.join(" | "));
	assert.ok(!lines.includes("stall"));
	const coop = obj({ id: "c", kind: "building", name: "Hühnerstall", owner: "Keno", ownerId: "k", plan: "huehnerstall", x: 6, y: 5, w: 2, h: 1 });
	assert.ok(cellEntries({ ...input, objs: new Map([["c", coop]]), at: { x: 6, y: 5 } }).some((e) => e.line === "stall"), "a finished coop shows its animals");
});

test("\"Truhe ansehen\" only at an own building whose plan has a chest: a hut yes, a scarecrow or a coop no", () => {
	const plans = [{ key: "huette", name: "Hütte", w: 2, h: 2, needs: "", work: 1, chest: true as const }, { key: "vogelscheuche", name: "Vogelscheuche", w: 1, h: 1, needs: "", work: 1 }, { key: "huehnerstall", name: "Hühnerstall", w: 2, h: 1, needs: "", work: 1 }];
	const self = char("me", "Ich", 5, 5);
	const at = (plan: string) => {
		const b = obj({ id: "b", kind: "building", name: plan, x: 6, y: 5, w: 1, h: 1, plan, ownerId: "me", owner: "Ich" });
		return cellEntries({ at: { x: 6, y: 5 }, chars: new Map([["me", self]]), objs: new Map([["b", b]]), self, room: "r", me: "me", plans, guest: false, fuel: undefined, onPlans: () => {} }).map((e) => e.line);
	};
	assert.ok(at("huette").includes("truhe"));
	assert.ok(!at("vogelscheuche").includes("truhe"));
	assert.ok(!at("huehnerstall").includes("truhe"));
});

test("a building with recipes offers what one carries enough for, and the list of what is made there", () => {
	const recipes = [
		{ key: "bohle", name: "Bohle", needs: [{ name: "Treibholz", count: 2 }], tool: "Muschelmesser", at: "werkstatt" },
		{ key: "tauwerk", name: "Tauwerk", needs: [{ name: "Tangseil", count: 3 }], at: "werkstatt" },
		{ key: "brot", name: "Brot", needs: [{ name: "Mehl", count: 2 }], at: "backhaus" },
	];
	const shop = obj({ id: "w", kind: "building", name: "Werkstatt", owner: "Ines", ownerId: "o", plan: "werkstatt", x: 6, y: 5, w: 3, h: 2 });
	const carried = (name: string, n: number) => Array.from({ length: n }, (_, i): [string, ObjView] => [`${name}${i}`, obj({ id: `${name}${i}`, kind: "item", name, location: "me", x: -1, y: -1 })]);
	const at = (...items: Array<[string, ObjView]>) => cellEntries({ ...input, recipes, objs: new Map([["w", shop], ...items]), at: { x: 6, y: 5 } }).map((e) => e.line);
	assert.ok(at().includes("craft hier"), "anyone's workshop: what is made there");
	assert.ok(!at().some((l) => l.startsWith("craft bohle")), "nothing carried");
	assert.ok(!at(...carried("Treibholz", 2)).includes("craft bohle"), "the knife is missing");
	assert.ok(at(...carried("Treibholz", 2), ...carried("Muschelmesser", 1)).includes("craft bohle"));
	assert.ok(!at(...carried("Mehl", 2)).includes("craft brot"), "the bakery's recipe is not the workshop's");
	const hut = cellEntries({ ...input, at: { x: 10, y: 10 } }).map((e) => e.line);
	assert.ok(!hut.includes("craft hier"), "without the world's recipes nothing is offered");
});

test("the butcher's shop offers to slaughter each animal one carries, with a knife; else the command that says what is missing", () => {
	const shop = obj({ id: "m", kind: "building", name: "Metzgerei", owner: "Ines", ownerId: "o", plan: "metzgerei", x: 6, y: 5, w: 2, h: 2 });
	const carried = (name: string): [string, ObjView] => [name, obj({ id: name, kind: "item", name, location: "me", x: -1, y: -1 })];
	const at = (...items: Array<[string, ObjView]>) => cellEntries({ ...input, objs: new Map([["m", shop], ...items]), at: { x: 6, y: 5 } }).map((e) => e.line);
	assert.ok(at().includes("schlachte"), "nothing carried: the command explains");
	assert.ok(at(carried("Huhn")).includes("schlachte"), "no knife: the command explains");
	const both = at(carried("Huhn"), carried("Schwein"), carried("Ferkel"), carried("Schlachtmesser"));
	assert.ok(both.includes("schlachte huhn") && both.includes("schlachte schwein"));
	assert.ok(!both.includes("schlachte ferkel"), "the young grow up first");
});

test("beside a windmill: each thing it grinds that one carries, bones too", () => {
	const mill = obj({ id: "m", kind: "building", name: "Windmühle", owner: "Ines", ownerId: "o", plan: "windmuehle", x: 6, y: 5, w: 2, h: 2 });
	const carried = (name: string): [string, ObjView] => [name, obj({ id: name, kind: "item", name, location: "me", x: -1, y: -1 })];
	const lines = cellEntries({ ...input, grinds: ["Weizen", "Knochen"], objs: new Map([["m", mill], carried("Knochen"), carried("Weizen"), carried("Tang")]), at: { x: 6, y: 5 } }).map((e) => e.line);
	assert.ok(lines.includes("mahle alle Knochen") && lines.includes("mahle alle Weizen"));
	assert.ok(!lines.includes("mahle alle Tang"));
});

test("one's own field or bed can be given up from the map, after a question; someone else's cannot", () => {
	const at = (o: ObjView) => cellEntries({ ...input, objs: new Map([["x", o]]), at: { x: 6, y: 5 } });
	const field = (ownerId: string) => obj({ id: "x", kind: "field", ownerId, owner: "Mira", fieldStage: "brach", x: 6, y: 5, w: 4, h: 4 });
	const bed = (ownerId: string) => obj({ id: "x", kind: "bed", name: "Beet", ownerId, owner: "Mira", plants: [], x: 6, y: 5, w: 2, h: 2 });
	const give = at(field("me")).find((e) => e.line === "flur aufgeben");
	assert.ok(give?.confirm, "asked first: the crop is lost");
	assert.ok(!at(field("other")).some((e) => e.line === "flur aufgeben"));
	assert.ok(at(bed("me")).find((e) => e.line === "beet aufgeben")?.confirm);
	assert.ok(!at(bed("other")).some((e) => e.line === "beet aufgeben"));
});
