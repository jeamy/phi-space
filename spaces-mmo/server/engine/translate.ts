// Plain language into commands, first without a model: rules for the sentences people type most ("gehe nach osten",
// "nimm das holz auf", "kaufe muschel am markt", "biete muschel am markt für 2 an", "schau dich um"). What the rules do
// not understand goes to the model process if model calls are on (server/model-host.ts); otherwise the command is
// refused as before. The rules only rewrite lines that are not already commands, so a typed command never changes.

/** What the rules may look at: the room's exits (all their names), the market's listings, the actor's pack. */
export type TranslateView = { exits: Array<{ name: string; aliases: string[] }>; listings: Array<{ nr: number; itemName: string }>; carried: string[] };

const FILLER = /\b(bitte|mal|doch|jetzt|gerne?|ich|möchte|moechte|will|würde|wuerde|gern|please|i|want|would|like)\b/gi;
const ARTICLE = /^(den|dem|die|das|der|des|ein|eine|einen|einem|the|a|an)\s+/i;
const clean = (s: string) => s.toLowerCase().replace(/[.!?,;]+/g, " ").replace(FILLER, " ").replace(/\s+/g, " ").trim();
const noArticle = (s: string) => s.replace(ARTICLE, "").trim();

/** The command a sentence means, or null when the rules do not know. A rule that hits a typed command means the same
 *  ("gehe ost" → "go ost"), so commands keep working. */
export function translateRules(line: string, v: TranslateView): string | null {
	const s = clean(line);
	if (!s) return null;
	// walking: "gehe nach osten", "lauf richtung klippenpfad", "nach osten", "go to the east"
	const walk = /^(?:(?:geh|gehe|lauf|laufe|go|walk|reise)\s+)?(?:nach|richtung|zum|zur|zu|in den|in die|ins|to|towards)\s+(.+)$/.exec(s) ?? /^(?:geh|gehe|lauf|laufe)\s+(.+)$/.exec(s);
	if (walk) {
		const target = noArticle(walk[1]!);
		const exit = v.exits.find((e) => [e.name, ...e.aliases].map((n) => n.toLowerCase()).includes(target));
		if (exit) return `go ${exit.name}`;
	}
	// picking up: "nimm das holz auf", "heb die muschel auf", "pick up the shell"
	const up = /^(?:nimm|nehme|heb|hebe|sammle?)\s+(.+?)\s+auf$/.exec(s) ?? /^pick\s+up\s+(.+)$/.exec(s);
	if (up) return `get ${noArticle(up[1]!)}`;
	// buying at the market: "kaufe muschel am markt", "kaufe am markt die muschel", "buy the shell at the market"
	const buy = /^(?:kauf|kaufe|buy)\s+(.+?)\s+(?:am|vom|auf dem|at the|from the)\s+(?:markt|marktbrett|market)$/.exec(s) ?? /^(?:kauf|kaufe|buy)\s+(?:am|vom|at the)\s+(?:markt|marktbrett|market)\s+(.+)$/.exec(s);
	if (buy) {
		const what = noArticle(buy[1]!);
		const l = v.listings.find((x) => x.itemName.toLowerCase() === what || x.itemName.toLowerCase().startsWith(what));
		return l ? `market kaufe ${l.nr}` : "market";
	}
	// selling: "biete muschel am markt für 2 an", "verkaufe die muschel für 3 münzen", "sell the shell for 2"
	const sell = /^(?:biete|verkaufe|sell)\s+(.+?)\s+(?:(?:am|auf dem|at the)\s+(?:markt|marktbrett|market)\s+)?(?:für|fuer|for)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?(?:\s+an)?$/.exec(s);
	if (sell && !/\s(an|to)\s+\S+$/.test(sell[1]!)) return `market biete ${noArticle(sell[1]!)} für ${sell[2]}`;
	// a fire: "wirf das holz ins feuer", "leg holz ins feuer" (also run together: "legeholz ins feuer"); the longer verb first, or "leg" takes the "e" of "lege" for the thing
	const fire = /^(?:werfe|wirf|lege|leg|tue|tu|put|throw)\s*(.+?)\s+(?:ins|in das|in den|in die|into the|into|in)\s+(feuer|leuchtfeuer|fire|beacon)$/.exec(s);
	if (fire) return `put ${noArticle(fire[1]!)} in ${fire[2]}`;
	// looking and the rest
	if (/^(schau|sieh|guck|look)\s+(dich\s+)?(um|around)$|^umsehen$|^wo bin ich$|^where am i$/.test(s)) return "look";
	if (/^(was trage|was habe|was hab|inventar|what do (carry|have))$/.test(s)) return "inventory"; // "ich"/"i" are filler
	if (/^(wer ist (da|hier|online)|wer spielt|who is (here|online))$/.test(s)) return "who";
	if (/^(hilfe|was kann ich tun|what can i do)$/.test(s)) return "help";
	return null;
}
