// The help's search (HelpPanel.tsx): which articles a query finds, best first. Pure, so node tests it (tests/help.test.ts).
// Every word of the query must be found in an article, in any case, with plain vowels ("hühner" as "huhner" or
// "huehner"), and in either number: "schweine" finds "Schwein", "kühe" "Kuh", "geese" "goose". A word is found as a piece
// of the text (what one types finds what begins so, "stall" the "Hühnerstall"), as the same word without its plural
// ending, or as the start of a longer word ("hühner" the "Hühnerstall"). The engine stems names alike (server/engine/context.ts stem).
import type { Article, Lang } from "./articles.ts";

/** Lower case with plain vowels, also where they are written out: "Gänse" and "Gaense" → "ganse". Text and query are
 *  folded alike, so "Feuer" ("feur") is still found by "feuer". */
export const fold = (s: string) => s.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss").replace(/([aou])e/g, "$1");

/** English plurals that are not the singular with an ending. */
const IRREGULAR: Record<string, string> = { geese: "goose", mice: "mouse", cattle: "cow", oxen: "ox", feet: "foot", teeth: "tooth", children: "child", women: "woman", men: "man", calves: "calf", wolves: "wolf", leaves: "leaf" };

/** A folded word without its plural ending: "huhner" → "huhn", "kuhe" → "kuh", "schweine" → "schwein", "pigs" → "pig".
 *  At least three letters stay. */
export function stem(word: string): string {
	const w = fold(word);
	if (IRREGULAR[w]) return IRREGULAR[w]!;
	for (const end of ["ern", "er", "en", "e", "n", "s"]) if (w.length - end.length >= 3 && w.endsWith(end)) return w.slice(0, -end.length);
	return w;
}

const words = (s: string) => fold(s).match(/[a-z0-9]+/g) ?? [];

type Indexed = { text: string; stems: Set<string>; tokens: string[] };
const cache = new WeakMap<Article, Partial<Record<Lang, { all: Indexed; head: Indexed }>>>();
const indexed = (s: string): Indexed => { const tokens = [...new Set(words(s))]; return { text: fold(s), tokens, stems: new Set(tokens.map(stem)) }; };
function indexOf(a: Article, lang: Lang) {
	let byLang = cache.get(a);
	if (!byLang) cache.set(a, (byLang = {}));
	return (byLang[lang] ??= { all: indexed(`${a.title[lang]} ${a.short[lang]} ${a.body[lang]}`), head: indexed(`${a.title[lang]} ${a.short[lang]}`) });
}

/** Whether one word of a query (folded) is found in an indexed text. */
function found(q: string, at: Indexed): boolean {
	if (at.text.includes(q)) return true;
	const s = stem(q);
	if (at.stems.has(s)) return true;
	// a longer word that begins with it: "huhn" in "huhnerstall"; not for short stems, "ent" would find "entnimm"
	return s.length >= 4 && at.tokens.some((t) => t.startsWith(s));
}

/** The articles in which every word of `query` is found, those that name it in their title or summary first. */
export function searchArticles(articles: readonly Article[], query: string, lang: Lang): Article[] {
	const qs = words(query);
	if (!qs.length) return [...articles];
	const hits = articles.map((a, i) => {
		const { all, head } = indexOf(a, lang);
		if (!qs.every((q) => found(q, all))) return null;
		return { a, i, score: qs.filter((q) => found(q, head)).length };
	}).filter((h): h is NonNullable<typeof h> => !!h);
	return hits.sort((x, y) => y.score - x.score || x.i - y.i).map((h) => h.a);
}
