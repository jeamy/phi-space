// The game's help (client/help/articles.ts): every link and anchor resolves, both languages have the same structure, and
// every command the help names is one the engine really has (so the help cannot drift from the parser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTICLES, DEFAULT_ARTICLE, articleById, tocOf } from "../client/help/articles.ts";
import { renderMarkdownToHtml } from "../client/lib/markdown.ts";
import { DEFAULT_COMMANDS } from "../server/engine/commands/default.ts";
import { CLOCK_COMMANDS } from "../server/engine/commands/clock.ts";
import { TRADE_COMMANDS } from "../server/engine/commands/trade.ts";
import { BUILD_COMMANDS } from "../server/engine/commands/build.ts";
import { SITE_ORDER_COMMANDS } from "../server/engine/commands/siteorder.ts";
import { CHAPEL_COMMANDS } from "../server/engine/commands/chapel.ts";
import { TOWNHALL_COMMANDS } from "../server/engine/commands/townhall.ts";
import { FESTIVAL_COMMANDS } from "../server/engine/commands/festival.ts";
import { WIND_COMMANDS } from "../server/engine/commands/wind.ts";
import { CART_COMMANDS } from "../server/engine/commands/cart.ts";
import { FOOD_COMMANDS } from "../server/engine/commands/food.ts";
import { SHOP_COMMANDS } from "../server/engine/commands/shop.ts";
import { SIGNAL_COMMANDS } from "../server/engine/commands/signal.ts";
import { FISHING_COMMANDS } from "../server/engine/commands/fishing.ts";
import { GARDEN_COMMANDS } from "../server/engine/commands/garden.ts";
import { WILD_COMMANDS } from "../server/engine/commands/wild.ts";
import { FIELD_COMMANDS } from "../server/engine/commands/field.ts";
import { MILL_COMMANDS } from "../server/engine/commands/mill.ts";
import { QUARRY_COMMANDS } from "../server/engine/commands/quarry.ts";
import { ANIMAL_COMMANDS } from "../server/engine/commands/animals.ts";
import { BEAM_COMMANDS } from "../server/engine/commands/beam.ts";
import { EPOCH_COMMANDS } from "../server/engine/commands/epoch.ts";
import { SETTLEMENT_COMMANDS } from "../server/engine/commands/settlement.ts";
import { HELP_OF_KIND, HELP_OF_PLAN } from "../client/cellActions.ts";
import { LINE as CHAT_LINE } from "../server/chat.ts";

const LANGS = ["de", "en"] as const;

test("the default article exists and ids are unique", () => {
	assert.ok(articleById(DEFAULT_ARTICLE));
	assert.equal(new Set(ARTICLES.map((a) => a.id)).size, ARTICLES.length);
});

test("both languages carry the same sections, and every anchor is unique", () => {
	for (const a of ARTICLES) {
		const de = tocOf(a.body.de).map((h) => h.id), en = tocOf(a.body.en).map((h) => h.id);
		assert.deepEqual(de, en, `${a.id}: the sections differ between de and en`);
		assert.equal(new Set(de).size, de.length, `${a.id}: duplicate anchor`);
		for (const l of LANGS) assert.ok(a.title[l] && a.short[l], `${a.id}: title/short missing in ${l}`);
	}
});

test("help links point at existing articles and anchors", () => {
	for (const a of ARTICLES) for (const l of LANGS) {
		for (const m of a.body[l].matchAll(/\]\((help\.[a-z0-9.]+)(?:#([a-z0-9._-]+))?\)/g)) {
			const target = articleById(m[1]!);
			assert.ok(target, `${a.id}/${l}: link to unknown article ${m[1]}`);
			if (m[2]) assert.ok(tocOf(target.body[l]).some((h) => h.id === m[2]), `${a.id}/${l}: unknown anchor ${m[1]}#${m[2]}`);
		}
		const html = renderMarkdownToHtml(a.body[l]);
		assert.ok(!html.includes("|---") && !/<p>\|/.test(html), `${a.id}/${l}: a table was not rendered`);
		assert.ok(!/<script/i.test(html));
	}
});

test("every command in the command tables exists in the engine, under its English and German names", () => {
	const known = new Set([...DEFAULT_COMMANDS, ...TRADE_COMMANDS, ...CLOCK_COMMANDS, ...BUILD_COMMANDS, ...SITE_ORDER_COMMANDS, ...CHAPEL_COMMANDS, ...TOWNHALL_COMMANDS, ...FESTIVAL_COMMANDS, ...WIND_COMMANDS, ...CART_COMMANDS, ...FOOD_COMMANDS, ...SHOP_COMMANDS, ...SIGNAL_COMMANDS, ...FISHING_COMMANDS, ...GARDEN_COMMANDS, ...FIELD_COMMANDS, ...MILL_COMMANDS, ...QUARRY_COMMANDS, ...ANIMAL_COMMANDS, ...WILD_COMMANDS, ...EPOCH_COMMANDS, ...BEAM_COMMANDS, ...SETTLEMENT_COMMANDS].flatMap((c) => [c.key, ...(c.aliases ?? [])].map((n) => n.toLowerCase())));
	known.add("help"); known.add("hilfe"); known.add("?"); // helpCommand is built per room
	// the chat's words never reach the engine: the gateway catches them (server/chat.ts)
	for (const w of /\^\(([^)]+)\)/.exec(CHAT_LINE.source)![1]!.split("|")) known.add(w);
	const article = articleById("help.game.commands")!;
	for (const l of LANGS) {
		const rows = article.body[l].split("\n").filter((r) => r.startsWith("| `"));
		assert.ok(rows.length >= 18, "the command tables are present");
		for (const row of rows) {
			const cells = row.split("|").slice(1, -1).map((c) => c.trim());
			const first = /^`([^`\s]+)/.exec(cells[0]!)?.[1];
			assert.ok(first && known.has(first.toLowerCase()), `${l}: unknown command in ${cells[0]}`);
			if (cells.length === 3) for (const alias of [...cells[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/^[':]/, ""))) {
				if (!alias || /\s/.test(alias) || /^[a-zäöü]+$/i.test(alias) === false) continue;
				if (alias === "text" || alias === "winkt" || alias === "waves") continue; // short forms ('text, :winkt)
				assert.ok(known.has(alias.toLowerCase()), `${l}: unknown alias ${alias} of ${first}`);
			}
		}
	}
});

test("no help topic of the world is named like a command (help <topic> would answer with the command)", async () => {
	const { loadWorld } = await import("../server/engine/world.ts");
	const w = await loadWorld();
	const words = new Set([...DEFAULT_COMMANDS, ...TRADE_COMMANDS, ...CLOCK_COMMANDS, ...BUILD_COMMANDS, ...SITE_ORDER_COMMANDS, ...CHAPEL_COMMANDS, ...TOWNHALL_COMMANDS, ...SIGNAL_COMMANDS, ...GARDEN_COMMANDS, ...FIELD_COMMANDS, ...MILL_COMMANDS, ...QUARRY_COMMANDS, ...ANIMAL_COMMANDS, ...WILD_COMMANDS, ...EPOCH_COMMANDS, ...BEAM_COMMANDS, ...SETTLEMENT_COMMANDS].flatMap((c) => [c.key, ...(c.aliases ?? [])].map((n) => n.toLowerCase())));
	for (const t of w.help) assert.ok(!words.has(t.key.toLowerCase()), `help topic ${t.key} is also a command word`);
});

test("the articles the map menu opens (\"Was ist das?\") and their sections exist", () => {
	for (const ref of [...Object.values(HELP_OF_KIND), ...Object.values(HELP_OF_PLAN)]) {
		const [id, anchor] = ref.split("#");
		const a = articleById(id!);
		assert.ok(a, `unknown article ${ref}`);
		if (anchor) for (const l of LANGS) assert.ok(tocOf(a.body[l]).some((h) => h.id === anchor), `${ref}: no section in ${l}`);
	}
});

test("the search finds a word in either number, with or without umlauts, the best articles first", async () => {
	const { searchArticles, stem } = await import("../client/help/search.ts");
	const ids = (q: string, lang: "de" | "en" = "de") => searchArticles(ARTICLES, q, lang).map((a) => a.id);
	for (const q of ["hühner", "huhn", "Huehner", "kühe", "kuh", "gänse", "schweine", "schwein", "ziegen", "mäuse", "rinder", "bienenvölker", "trüffeln"]) assert.ok(ids(q).includes("help.game.animals"), q);
	for (const q of ["geese", "pigs", "cows", "mice", "hens"]) assert.ok(ids(q, "en").includes("help.game.animals"), q);
	assert.equal(ids("tiere")[0], "help.game.animals", "the article named so comes first");
	assert.ok(ids("schweine trüffel").includes("help.game.animals"), "every word must be found");
	assert.deepEqual(ids("schweine quasselstrippe"), []);
	assert.equal(ids("").length, ARTICLES.length);
	// a short stem finds only its own word, not every word that begins so
	assert.equal(stem("Enten"), "ent");
	const enten = new Set(ids("enten")), entnimm = new Set(ids("entnimm"));
	assert.ok([...entnimm].some((id) => !enten.has(id)), "\"enten\" does not find every article about \"entnimm\"");
});
