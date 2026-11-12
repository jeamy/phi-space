// The player's tasks (server/todos.ts) from what the gateway sees of its own things, on the real world's data, and their English.
import { test } from "node:test";
import assert from "node:assert/strict";
import { todosFor } from "../server/todos.ts";
import { loadWorld } from "../server/engine/world.ts";
import { toEnglish } from "../client/i18n/index.ts";
import type { ObjView } from "../server/gateway.ts";
import type { HerdFields, MillLoadFields } from "../server/model.ts";

const w = await loadWorld("leuchtfeuer");
const H = 3600_000, now = 1000 * H, me = "c-me";
const at = { location: "graue-bucht", x: 4, y: 5 };
const objs: ObjView[] = [
	{ id: "f1", kind: "field", name: "Acker (Weizen)", ownerId: me, fieldStage: "reif", ...at },
	{ id: "f2", kind: "field", name: "Acker", ownerId: "c-other", fieldStage: "reif", ...at },
	{ id: "b1", kind: "bed", name: "Beet", ownerId: me, plants: [{ x: 0, y: 0, stage: 2, color: "#fff" }, { x: 1, y: 0, stage: 1, color: "#fff" }], wateredWorldMs: now - 30 * H, thirstMs: 24 * H, weedy: true, ...at },
	{ id: "s1", kind: "site", name: "Hütte", ownerId: me, missing: "2 Treibholz, 3 Arbeit", ...at },
	{ id: "g1", kind: "building", name: "Gehege", ownerId: me, herd: "ziege", ...at },
];
const herds = new Map<string, HerdFields>([["g1", { kind: "ziege", fedUntilWorldMs: now - H, atWorldMs: now - 400 * H, goods: 0, bred: 0 }]]);
const loads: MillLoadFields[] = [
	{ loadId: "l1", buildId: "m1", room: "graue-bucht", x: 9, y: 9, w: 2, h: 2, charId: me, name: "Ich", from: "weizen", to: "mehl", count: 3, readyWorldMs: now - H, untilWorldMs: now + 48 * H },
	{ loadId: "l2", buildId: "m1", room: "graue-bucht", x: 9, y: 9, w: 2, h: 2, charId: me, name: "Ich", from: "weizen", to: "mehl", count: 2, readyWorldMs: now + 5 * H, untilWorldMs: now + 48 * H },
];
const todos = todosFor(me, objs, herds, loads, w, now);
const texts = todos.map((t) => t.text);

test("a ripe field, a dry and weedy bed with ripe plants, a site, hungry animals with milk, flour at the mill", () => {
	assert.ok(texts.includes("Dein Acker (Weizen) in Graue Bucht (4 5) ist reif: ernten."), texts.join("\n"));
	assert.ok(texts.includes("In deinem Beet in Graue Bucht (4 5) ist 1 Pflanze reif: ernten („ernte“)."));
	assert.ok(texts.includes("Dein Beet in Graue Bucht (4 5) ist trocken: gießen („gieße“), sonst welken die Pflanzen."));
	assert.ok(texts.includes("In deinem Beet in Graue Bucht (4 5) wächst Unkraut: jäten („jäte“)."));
	assert.ok(texts.includes("Deine Baustelle Hütte in Graue Bucht (4 5): es fehlen noch 2 Treibholz, 3 Arbeit („liefere“, „arbeite“)."));
	assert.ok(texts.some((t) => /^In deinem Gehege .* liegt Milch bereit: einsammeln/.test(t)), texts.join("\n"));
	assert.ok(texts.includes("Die Tiere in deinem Gehege in Graue Bucht (4 5) sind hungrig: füttern („füttere“)."));
	assert.ok(texts.includes("3 Mehl wartet an der Windmühle in Graue Bucht (9 9): abholen („abholen“)."));
	assert.ok(texts.includes("2 Mehl ist an der Windmühle in Graue Bucht (9 9) in etwa 5 Stunden fertig."));
	assert.ok(!todos.some((t) => t.id.startsWith("f2")), "another's field is not mine");
});

test("the urgent ones first; without a clock nothing that goes by the time", () => {
	assert.deepEqual(todos.map((t) => t.rank), [...todos.map((t) => t.rank)].sort());
	assert.equal(todos.at(-1)!.rank, 2);
	const timeless = todosFor(me, objs, herds, loads, w, null).map((t) => t.id);
	assert.ok(timeless.includes("f1:reif") && timeless.includes("s1:bau"));
	assert.ok(!timeless.some((id) => id.endsWith(":durst") || id.endsWith(":hunger") || id.startsWith("l")));
});

test("the thirst goes by the patience as in the engine; a sponsor is told when the bed gets dry, nothing else of it", () => {
	const bed = (o: Partial<ObjView>): ObjView => ({ id: "b9", kind: "bed", name: "Beet", ownerId: me, owner: "Ich", plants: [{ x: 0, y: 0, stage: 1, color: "#fff" }], thirstMs: 24 * H, weedy: true, ...at, ...o });
	const durst = (o: Partial<ObjView>, patient: number, who = me) => todosFor(who, [bed(o)], herds, [], w, now, patient).filter((t) => t.id === "b9:durst").map((t) => t.text);
	// patience 24: the plants wilt after 24 × 24 hours; nothing before half of it, "soon" from half, "dry" from three quarters
	assert.deepEqual(durst({ wateredWorldMs: now - 30 * H }, 24), []);
	assert.deepEqual(durst({ wateredWorldMs: now - 300 * H }, 24), ["Dein Beet in Graue Bucht (4 5) braucht bald Wasser: gießen („gieße“)."]);
	assert.deepEqual(durst({ wateredWorldMs: now - 450 * H }, 24), ["Dein Beet in Graue Bucht (4 5) ist trocken: gießen („gieße“), sonst welken die Pflanzen."]);
	// only what grows needs water
	assert.deepEqual(durst({ wateredWorldMs: now - 450 * H, plants: [{ x: 0, y: 0, stage: 3, color: "#fff" }] }, 24), []);
	// a sponsor: the watering only, by the owner's name
	const sponsored = { ownerId: "c-ida", owner: "Ida", sponsorIds: [me], wateredWorldMs: now - 20 * H };
	assert.deepEqual(todosFor(me, [bed(sponsored)], herds, [], w, now).map((t) => t.text), ["Das Beet von Ida in Graue Bucht (4 5) ist trocken: gießen („gieße“), sonst welken die Pflanzen."]);
	assert.deepEqual(todosFor("c-stranger", [bed(sponsored)], herds, [], w, now), []);
	assert.equal(toEnglish("Das Beet von Ida in Graue Bucht (4 5) braucht bald Wasser: gießen („gieße“)."), "The Bed of Ida in Grey Bay (4 5) needs water soon: water it („water“).");
});

test("a building is told five days before its term on the second clock runs out, urgent on its last day", () => {
	const decay = 1000 * H, DAY = 24 * H, at = { location: "moewenfels-strand", x: 20, y: 6 };
	const b = (plan: string, name: string, term: number): ObjView => ({ id: "h1", kind: "building", name, plan, ownerId: me, term, ...at });
	const told = (o: ObjView, d: number | null) => todosFor(me, [o], herds, [], w, now, 1, d).map((t) => [t.text, t.rank]);
	assert.deepEqual(told(b("huette", "Hütte", decay + 6 * DAY), decay), [], "six days left: nothing yet");
	assert.deepEqual(told(b("huette", "Hütte", decay + 3 * DAY), decay), [["Deine Hütte in Möwenstrand (20 6) hält noch etwa 3 Tage: ausbessern („repariere“), sonst wird daraus eine Ruine.", 1]]);
	assert.deepEqual(told(b("steg", "Steg", decay + 5 * H), decay), [["Dein Steg in Möwenstrand (20 6) hält noch etwa 5 Stunden: ausbessern („repariere“), sonst wird daraus eine Ruine.", 0]]);
	assert.deepEqual(told(b("huette", "Hütte", decay + H), null), [], "without a clock nothing that goes by the time");
	assert.equal(toEnglish("Deine Hütte in Möwenstrand (20 6) hält noch etwa 3 Tage: ausbessern („repariere“), sonst wird daraus eine Ruine."), "Your Hut in Gull Beach (20 6) lasts about 3 days more: mend it („repair“), or it becomes a ruin.");
});

test("every task has its English, with the English commands", () => {
	for (const t of texts) {
		const en = toEnglish(t);
		assert.doesNotMatch(en, /\b(?:Dein|deinem|ist|sind|ernten|gießen|wartet|fehlen|hungrig|bereit|fertig)\b/, `${t}\n→ ${en}`);
	}
});
