// What the model is told to answer a player's question about the game (server/model-host.ts): the facts of the things the
// question names (what it is, where it grows wild, who sells it, where the tide brings it, how it is made) worked out from
// the world definition, and the help topics that fit the words. Nothing here is invented: a question the facts and the help
// do not answer is answered with "I do not know".
import type { WorldDef } from "./world.ts";

/** Whether a sentence asks something (the facts are only added to those, a command needs none). */
export const isQuestion = (line: string): boolean =>
	/\?|^\s*(wo|wie|wieviele?|was|wer|wann|warum|wieso|weshalb|welche[rsmn]?|woher|wohin|wozu|womit|wofür|wovon|where|how|what|who|when|why|which)\b|\b(gibt es|gibts|kann man|kann ich|darf man|muss man|wie viele?|kostet|kosten|preise?|zahlt|bekomme ich für|can i|is there|are there|do i need|cost|costs|price|prices|pays?)\b/i.test(line);

const words = (line: string): string[] => line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean);
const STOP = new Set(["wo", "wie", "was", "wer", "wann", "man", "ich", "der", "die", "das", "den", "dem", "ein", "eine", "einen", "und", "oder", "bekommt", "bekomme", "gibt", "kann", "mit", "für", "von", "the", "how", "what", "where", "can", "get", "does", "work", "works"]);

/** The prototypes a sentence names: by name, key or alias (a plural or a longer form with the same start counts, from four letters). */
function named(w: WorldDef, line: string) {
	const ws = words(line).filter((x) => !STOP.has(x));
	return w.prototypes.filter((p) => [p.name, p.key, ...(p.aliases ?? [])].some((n) => {
		const a = n.toLowerCase();
		return ws.some((x) => x === a || (a.length >= 4 && x.length >= 4 && (x.startsWith(a) || a.startsWith(x))));
	})).slice(0, 3);
}

const roomName = (w: WorldDef, id: string) => w.rooms.find((r) => r.roomId === id)?.name ?? id;

/** What the world says about one thing, as short lines. */
function aboutThing(w: WorldDef, p: { key: string; name: string; desc?: string }): string[] {
	const out: string[] = [`${p.name}${p.desc ? `: ${p.desc}` : ""}`];
	const wild = (what: string, d: { decor: string; islands?: string[] } | undefined) => d && out.push(`  ${what} grows wild among the ${d.decor === "herbs" ? "herbs" : "flowers"} of ${d.islands?.length ? `the islands ${d.islands.join(", ")}` : "every island"}: "sammle samen" in a room with such plants finds its seed now and then (a short rest after each search).`);
	const crop = w.fields?.crops.find((c) => c.key === p.key || c.seed === p.key);
	if (crop) { out.push(`  ${crop.name} is a field crop (${crop.group}); seed: ${w.prototypes.find((s) => s.key === crop.seed)?.name ?? crop.seed}, grows ${Math.round(crop.growWorldMs / 3_600_000)} world hours in a field ("flur anlegen", then "bestelle ${crop.name.toLowerCase()}").`); wild(crop.name, crop.wild); }
	const sort = w.garden?.sorts.find((s) => s.key === p.key || s.seed === p.key);
	if (sort) { out.push(`  ${sort.name} is a plant for a ${sort.kind === "zier" ? "flower bed" : "garden bed"} (seed ${w.prototypes.find((s) => s.key === sort.seed)?.name ?? sort.seed}; "umgraben" with a spade, "pflanze ${sort.name.toLowerCase()}").`); wild(sort.name, sort.wild); }
	// every trader's two base prices (what it pays, what it asks), each where it trades
	const coins = (n: number) => `${n} coin${n === 1 ? "" : "s"}`;
	let priced = false;
	for (const n of w.npcs) {
		const [buy, sell] = n.prices?.[p.key] ?? [0, 0];
		if (!buy && !sell) continue;
		priced = true;
		const where = n.market ? ` at the market of ${roomName(w, n.market)}` : ` in ${roomName(w, n.room)}`;
		out.push(`  ${n.name}${where}: ${[buy > 0 ? `buys it for ${coins(buy)}` : "", sell > 0 ? `sells it for ${coins(sell)}${n.carry?.some((c) => c.proto === p.key) ? "" : " (when in stock)"}` : ""].filter(Boolean).join(", ")} (base prices).`);
	}
	const washed = w.flood.rooms.filter((fr) => (fr.protos ?? w.flood.protos).some((x) => x.proto === p.key)).map((fr) => roomName(w, fr.room));
	if (washed.length) out.push(`  The tide washes it up on the beaches of: ${washed.slice(0, 6).join(", ")}${washed.length > 6 ? " and more" : ""} ("get ${p.name.toLowerCase()}" picks it up).`);
	if (w.flood.staples?.things.some((t) => t.proto === p.key)) out.push("  The tide always brings some of it to every island.");
	for (const r of w.recipes.filter((x) => x.makes === p.key)) out.push(`  Made with "craft ${r.key}" from ${r.needs.map((n) => `${n.count} ${w.prototypes.find((q) => q.key === n.proto)?.name ?? n.proto}`).join(", ")}${r.tool ? `, with a ${w.prototypes.find((q) => q.key === r.tool)?.name ?? r.tool}` : ""}.`);
	const shop = w.shop?.prices?.[p.key];
	if (shop) out.push(`  A department store (kaufhaus) trades it for ${shop} coins (base price).`);
	// how the base prices move (the help's „Preise“, client/help/articles.ts): the model lists them with this
	if (priced || shop) out.push("  Prices vary: a trader with none of a thing pays and asks more, up to twice the base price; with plenty of it less, down to half; what it only buys it ships off once a world day and its price rises again; with four in its pack it buys no more. For a lot it pays piece by piece, each as if it held the ones before: the more at once, the less each. A department store asks up to twice its price when empty and half when full, and buys for seven tenths. The help article on trade lists every price („Preise“).");
	return out;
}

/** The help topics that fit a sentence best (by its words in the topic's key and text), at most `n`, each cut to `max` characters. */
export function helpFor(w: WorldDef, line: string, n = 2, max = 1400): string[] {
	const ws = words(line).filter((x) => x.length >= 4 && !STOP.has(x));
	return w.help.map((h) => {
		const text = h.text.toLowerCase(), key = h.key.toLowerCase();
		return { h, score: ws.reduce((s, x) => s + (key.includes(x) ? 5 : 0) + Math.min(5, text.split(x).length - 1), 0) };
	}).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, n).map(({ h }) => `[${h.key}] ${h.text.length > max ? `${h.text.slice(0, max)} …` : h.text}`);
}

/** Facts and help for a question, as the lines of a prompt; empty when the world knows nothing that fits. */
export function gameFacts(w: WorldDef, line: string): string[] {
	const things = named(w, line).flatMap((p) => aboutThing(w, p)), help = helpFor(w, line);
	return [...(things.length ? ["Facts about what the question names:", ...things] : []), ...(help.length ? ["Help topics:", ...help] : [])];
}
