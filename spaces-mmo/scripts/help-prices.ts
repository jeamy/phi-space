// npm run help:prices [-- --check]: writes the price list of the help (client/help/articles.ts, „Preise“ / „Prices“
// {#prices} in the trade article) from the world: for every thing a recipe makes, which traders buy and sell it at what
// base price and the department store's base price. The help is authored text; this one section is generated so it never
// drifts from worlds/leuchtfeuer/world.json (tests/help-prices.test.ts holds it, as tests/world-json.test.ts the JSON).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../server/env.ts";
import type { WorldDef } from "../shared/world-def.ts";
import { EN } from "../client/i18n/en.ts";

export const ARTICLES_PATH = join(ROOT, "client", "help", "articles.ts");

const TEXT = {
	de: {
		head: "## Preise {#prices}",
		intro: [
			"Jedes Ding, das man herstellt, hat Käufer. Die Tabelle nennt die **Grundpreise** in Münzen: was die Händler zahlen und, wo sie es auch verkaufen, was sie verlangen, und den Preis des Kaufhauses.",
			"",
			"- **Angebot und Nachfrage**: Ein Händler, der nichts von einem Ding hat, zahlt und verlangt mehr, bis doppelt so viel; hat er viel davon, weniger, bis zur Hälfte. Was er nur kauft, bringt er einmal am Welttag fort, dann steigt sein Preis wieder. Hat er vier Stück eines Dings dabei, kauft er keins mehr.",
			"- **Kaufhaus**: Es verlangt leer bis doppelt so viel wie seinen Preis und voll die Hälfte; es kauft an, was es führt, für sieben Zehntel davon und zahlt aus seiner Kasse.",
			"- **Mengenrabatt**: Für ein Los zahlt ein Händler Stück für Stück, jedes so, als hätte er die vorigen schon: Je mehr auf einmal, desto weniger je Stück. Tiere, die er verkauft, werden im Los billiger, jedes weitere eine Münze weniger, nie unter dem, was er selbst für eins zahlt.",
			"- Händler kaufen am Marktbrett, wo sie stehen: was dort angeboten wird und mindestens ihren Preis kostet, und sie sprechen Leute an, die so etwas tragen.",
		],
		cols: "| Ding | Händler zahlen | Händler verlangen | Kaufhaus |",
		none: "–",
	},
	en: {
		head: "## Prices {#prices}",
		intro: [
			"Everything you make has buyers. The table gives the **base prices** in coins: what the traders pay and, where they also sell it, what they ask, and the department store's price.",
			"",
			"- **Supply and demand**: a trader who has none of a thing pays and asks more, up to twice as much; with plenty of it, less, down to half. What it only buys it ships off once a world day, and its price rises again. With four of a thing in its pack it buys no more of it.",
			"- **Department store**: empty it asks up to twice its price and full half; it buys what it stocks for seven tenths of that and pays from its till.",
			"- **Quantity discount**: for a lot a trader pays piece by piece, each as if it held the ones before already: the more at once, the less each. Animals it sells get cheaper in a lot, each one more a coin less, never below what it pays for one itself.",
			"- Traders buy at the market board where they stand: what is offered there at their price or less, and they speak to people who carry such things.",
		],
		cols: "| Thing | Traders pay | Traders ask | Store |",
		none: "–",
	},
} as const;

const en = (de: string) => EN[de] ?? de;

/** The section „Preise“ (de) or „Prices“ (en) for world `w`, as it stands in the help. */
export function priceSection(w: WorldDef, lang: "de" | "en"): string {
	const t = TEXT[lang], name = (p: string) => { const n = w.prototypes.find((x) => x.key === p)?.name ?? p; return lang === "en" ? en(n) : n; };
	const room = (r: string) => { const n = (w.allRooms ?? w.rooms).find((x) => x.roomId === r)?.name ?? r; return lang === "en" ? en(n) : n; };
	const made = [...new Set(w.recipes.map((r) => r.makes))].sort((a, b) => name(a).localeCompare(name(b), lang));
	const rows = made.map((p) => {
		const buyers = w.npcs.filter((n) => (n.prices?.[p]?.[0] ?? 0) > 0).map((n) => `${n.name} (${room(n.room)}) ${n.prices![p]![0]}`);
		const sellers = w.npcs.filter((n) => (n.prices?.[p]?.[1] ?? 0) > 0).map((n) => `${n.name} ${n.prices![p]![1]}`);
		const store = w.shop?.prices[p];
		return `| ${name(p)} | ${buyers.join(", ") || t.none} | ${sellers.join(", ") || t.none} | ${store ?? t.none} |`;
	});
	return [t.head, "", ...t.intro, "", t.cols, "| --- | --- | --- | --- |", ...rows].join("\n");
}

/** `text` (articles.ts) with both sections replaced by what `w` gives; each runs from its heading to the next "## ". */
export function withPrices(text: string, w: WorldDef): string {
	for (const lang of ["de", "en"] as const) {
		const head = TEXT[lang].head, i = text.indexOf(head);
		if (i < 0) throw new Error(`articles.ts has no "${head}"`);
		const j = text.indexOf("\n\n## ", i + head.length);
		text = text.slice(0, i) + priceSection(w, lang) + text.slice(j);
	}
	return text;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const check = process.argv.includes("--check");
	const w = JSON.parse(readFileSync(join(ROOT, "worlds", "leuchtfeuer", "world.json"), "utf8")) as WorldDef;
	const old = readFileSync(ARTICLES_PATH, "utf8"), text = withPrices(old, w);
	if (check) { console.log(old === text ? "[help:prices] current" : "[help:prices] the price list in the help is not what the world gives; run npm run help:prices"); process.exit(old === text ? 0 : 1); }
	if (old !== text) writeFileSync(ARTICLES_PATH, text);
	console.log(`[help:prices] ${old === text ? "unchanged" : "written"}`);
}
