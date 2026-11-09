// The English over the game (client/i18n): a sentence of the world comes out whole, with its values, and en.ts keeps what it needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EN } from "../client/i18n/en.ts";
import { extract } from "../scripts/i18n-extract.ts";
import { toEnglish } from "../client/i18n/index.ts";
import { loadWorld } from "../server/engine/world.ts";

test("every translation keeps the values of its German, and hardly any text lacks one", () => {
	for (const [de, en] of Object.entries(EN)) for (const slot of de.match(/\{\d\}/g) ?? []) assert.ok(en.includes(slot), `${de} → ${en}: ${slot}`);
	const { ui, game, world } = extract();
	const german = [...ui, ...game, ...world].filter((t) => /[äöüß]|\b(der|die|das|und|nicht|ist|du|Du)\b/.test(t));
	const missing = german.filter((t) => !(t in EN));
	assert.ok(missing.length < german.length * 0.05, `${missing.length} of ${german.length} lack their English: ${missing.slice(0, 20).join(" | ")}`);
});

test("the English help names commands that work, and every thing can be typed by its English name", async () => {
	for (const en of Object.values(EN)) for (const [, cmd] of en.matchAll(/„([^“]+)“/g)) assert.doesNotMatch(cmd!, /^(?:füttere|bestelle|flur|räume|zeige|fest|einstallen|ausstallen|einsammeln|nachlass|pflege|siedlung|market (?:biete|kaufe|zurück)|offer zurück)\b/, en);
	const w = await loadWorld();
	for (const p of w.prototypes) {
		const english = EN[p.name];
		if (english) assert.ok([p.name, p.key, ...p.aliases].some((a) => a.toLowerCase() === english.toLowerCase()), `${p.name}: "${english}" cannot be typed`);
	}
});

test("the world's sentences come out whole: values, things, plural endings", () => {
	for (const [de, en] of [
		["Du trägst: 5 Muscheln, 3 Treibholz.", /5 Shells.*3 Driftwood/i],
		["Graue Bucht", /Grey Bay/],
		// a value in bold (client/RichText.tsx) keeps its marks and is translated inside them
		["Gesa bietet dir **3 Treibholz** für **2 Münzen** an. „accept Gesa“ nimmt an, „decline Gesa“ lehnt ab.", /^Gesa offers you \*\*3 Driftwood\*\* for \*\*2 coins\*\*\./i],
		["Die Luft ist klar.", /air is clear/i],
		["Dafür brauchst du 3 Münzen.", /3 coins/],
		["Deine Baustelle Hütte: was fehlt?", /^Your site Hut: what's missing\?$/],
		["Baustelle Hütte von Mira: was fehlt?", /^Site Hut of Mira: what's missing\?$/],
		["Chat mit Ines", /^Chat with Ines$/],
		["Hafer wächst nicht im Beet, sondern auf einem Acker.", /^Oats: this grows on a field, not in a bed\.$/],
		["Neben deinem Acker sät „bestelle hafer“ (4× Hafer als Saatgut).", /^Beside your field, „plough hafer“ sows it \(4× Oats as seed\)\.$/],
		["Das Leuchtfeuer brennt noch etwa 12 Minuten.", /^The Beacon burns for about 12 more minutes\.$/],
		["Ausgänge: ost (Klippenpfad), west (Fischerdorf).", /^Exits: east \(Cliff Path\), west \(Fishing Village\)\.$/],
	] as const) assert.match(toEnglish(de), en, de);
});
