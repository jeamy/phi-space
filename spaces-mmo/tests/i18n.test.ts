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

test("every command's help comes out in English, as the text help writes it and as the card of the commands shows it", async () => {
	const { helpLine, helpParts } = await import("../server/engine/commands/default.ts");
	await import("../server/engine/commands.ts");
	// every list of commands the engine offers (commands.ts commandsOf), each module's *_COMMANDS
	const lists = await Promise.all(["default", "trade", "scenery", "build", "interior", "sleep", "siteorder", "chapel", "townhall", "festival", "wind", "cart", "food", "shop", "signal", "fishing", "passage", "garden", "trees", "field", "beam", "mill", "quarry", "animals", "wild", "epoch", "settlement", "clock", "builder"].map(async (f) => Object.entries(await import(`../server/engine/commands/${f}.ts`)).filter(([k]) => k.endsWith("_COMMANDS")).flatMap(([, v]) => v as Array<{ key: string; help: string; hidden?: boolean }>)));
	const cmds = lists.flat().filter((c) => c.help && !c.hidden) as Parameters<typeof helpLine>[0][];
	assert.ok(cmds.length > 100, `${cmds.length} commands`);
	for (const c of cmds) {
		const { names, usage, text } = helpParts(c);
		assert.ok(EN[`${c.key}${usage ? ` ${usage}` : ""} – ${text}`] !== undefined, `no English for: ${c.help}`);
		assert.notEqual(toEnglish(text), text, `the card of ${c.key}`);
		assert.ok(toEnglish(helpLine(c)).startsWith(`${names.join("/")} `) && toEnglish(helpLine(c)) !== helpLine(c), `the line of ${c.key}: ${toEnglish(helpLine(c))}`);
	}
});
