// The hints of the pack (client/hints.ts) on the world's own recipes and steps (server/gateway.ts usesOf), and their English.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hintsFor } from "../client/hints.ts";
import { toEnglish } from "../client/i18n/index.ts";
import { usesOf, type PlanView } from "../server/gateway.ts";
import { loadWorld } from "../server/engine/world.ts";

const w = await loadWorld("leuchtfeuer");
const uses = usesOf(w);
const plans = (w.building?.plans ?? []).map((p) => ({ key: p.key, name: p.name, ...(p.dative ? { dative: p.dative } : {}) }) as PlanView);
const hints = (pack: Record<string, number>, owned: string[] = []) => hintsFor(new Map(Object.entries(pack)), uses, plans, new Set(owned));
const texts = (pack: Record<string, number>, owned: string[] = []) => hints(pack, owned).map((h) => h.text);

test("enough Tang: a hint to make a rope, with its command and what the rope goes on into", () => {
	const h = hints({ Tang: 3 }).find((x) => x.id === "craft:tangseil")!;
	assert.equal(h.line, "craft tangseil");
	assert.match(h.text, /^Aus 3 Tang kannst du Tangseil herstellen \(„craft tangseil“\)\. Aus Tangseil wird dann .*Spaten/);
	assert.deepEqual(h.about, ["Tang"]);
});

test("one piece short: how many more; nothing for a pack that holds none of it", () => {
	assert.ok(texts({ Tang: 2 }).includes("Noch 1 Tang, dann kannst du Tangseil herstellen."));
	assert.ok(!hints({ Tang: 1 }).some((h) => h.id === "near:tangseil"));
	assert.deepEqual(hints({}), []);
});

test("the parts of a spade, and a tool that is missing (driftwood bundles need a shell knife)", () => {
	assert.ok(hints({ Treibholz: 2, Tangseil: 1 }).some((h) => h.id === "craft:spaten"));
	const bundle = hints({ Treibholz: 3 }).find((h) => h.id === "tool:holzbuendel")!;
	assert.match(bundle.text, /nur Muschelmesser fehlt dir als Werkzeug\. Das Werkzeug Muschelmesser braucht 2 Muschel, 1 Treibholz\./);
	assert.ok(hints({ Treibholz: 3, Muschelmesser: 1 }).some((h) => h.id === "craft:holzbuendel"));
	assert.ok(hints({ Muschel: 2, Treibholz: 1 }).some((h) => h.id === "craft:muschelmesser"));
});

test("wheat goes to the mill, the flour to the bakehouse; a goat into a pen for its milk", () => {
	const wheat = hints({ Weizen: 1 }).find((h) => h.id === "step:windmuehle:Weizen")!;
	assert.match(wheat.text, /^Die Windmühle mahlt Weizen zu Mehl \(„mahle alle weizen“\)\. Fehlt so ein Bau, kann man ihn bauen \(„bau windmuehle“\)\. Aus Mehl wird dann Brot \(Backhaus\)/);
	assert.doesNotMatch(hints({ Weizen: 1 }, ["windmuehle"]).find((h) => h.id === "step:windmuehle:Weizen")!.text, /bau windmuehle/);
	const goat = hints({ Ziege: 1 }).find((h) => h.id === "step:gehege:Ziege")!;
	assert.match(goat.text, /^Ziege: gibt Milch in einem Gehege \(„einstallen ziege“, dann „einsammeln“\)\. Fehlt so ein Bau, .* Aus Milch wird dann Käse/);
	const bread = hints({ Mehl: 2, "Kanne Wasser": 1, Treibholz: 1 }).find((h) => h.id === "at:brot")!;
	assert.match(bread.text, /wird Brot: das geht bei einem Backhaus\./);
});

test("what can be made now comes first", () => {
	const ids = hints({ Tang: 3, Weizen: 1 }).map((h) => h.id);
	assert.ok(ids.indexOf("craft:tangseil") < ids.indexOf("step:windmuehle:Weizen"));
});

test("every hint has its English", () => {
	const pack = { Tang: 2, Treibholz: 3, Muschel: 2, Weizen: 1, Ziege: 1, Mehl: 2, "Kanne Wasser": 1, Milch: 3 };
	const all = [...hints(pack), ...hints({ Tang: 3 })];
	for (const h of all) {
		const en = `Tipp: ${h.text}`.split(/(?<=[.!?:])\s+(?=[\p{Lu}„])/u).map(toEnglish).join(" ");
		assert.doesNotMatch(en, /\b(?:kannst|wird|fehlt|braucht|mahlt|gibt|wenn|bauen|Noch|dann|herstellen)\b/, en);
	}
});
