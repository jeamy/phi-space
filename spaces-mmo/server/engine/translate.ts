// Plain language into commands, first without a model: rules for the sentences people type most ("gehe nach osten",
// "nimm das holz auf", "kaufe muschel am markt", "biete muschel am markt für 2 an", "schau dich um"). What the rules do
// not understand goes to the model process if model calls are on (server/model-host.ts); otherwise the command is
// refused as before. The rules only rewrite lines that are not already commands, so a typed command never changes.

/** What the rules may look at: the room's exits (all their names), the market's listings, the actor's pack, who else
 *  is here (to tell a request to someone from a command). */
export type TranslateView = { exits: Array<{ name: string; aliases: string[] }>; listings: Array<{ nr: number; itemName: string }>; carried: string[]; people: string[] };

const FILLER = /\b(bitte|mal|doch|jetzt|noch|auch|einfach|schnell|gerne?|ich|möchte|moechte|will|würde|wuerde|gern|please|i|want|would|like)\b/gi;
const ARTICLE = /^(den|dem|die|das|der|des|ein|eine|einen|einem|the|a|an)\s+/i;
const GREETING = /^(hallo|hi|hey|moin|servus|hello)\b\s*/;
/** A greeting alone, with a name, or with a name and a comma before more: "hallo", "hallo henning!", "moin Bo, wie geht's?" */
const GREETED = /^(?:hallo|hi|hey|moin|servus|hello|guten (?:tag|morgen|abend))(?![\p{L}\p{N}_-])(?:\s*[.!?]*|\s*,?\s*[\p{L}\p{N}_-]+\s*(?:[.!?]*|[,:]\s*\S.*))$/iu;
const clean = (s: string) => s.toLowerCase().replace(/[.!?,;]+/g, " ").replace(FILLER, " ").replace(/\s+/g, " ").trim().replace(GREETING, "");
const noArticle = (s: string) => s.replace(ARTICLE, "").trim();
/** "ein stück holz" → "holz", "etwas tang" → "tang": the thing, without article and measure. */
const thing = (s: string) => noArticle(s).replace(/^(?:stück|stueck|stückchen|bisschen|etwas|piece of|some|bit of)\s+(?:von\s+|vom\s+|of\s+)?/i, "").replace(ARTICLE, "").trim();

/** The command a sentence means, or null when the rules do not know. A rule that hits a typed command means the same
 *  ("gehe ost" → "go ost"), so commands keep working. */
export function translateRules(line: string, v: TranslateView): string | null {
	// speaking to someone: "hallo ines, leg holz ins feuer", "Ines: wie geht's?", "hey Bo, wohin fährst du?" is talk for
	// them to hear, not a command for oneself
	// (also without a comma, "ines leg holz ins feuer", and with the name at the end, "leg holz nach, ines")
	const here = (name: string | undefined) => !!name && v.people.some((p) => p.toLowerCase() === name.toLowerCase());
	const addressed = /^(?:(?:hallo|hi|hey|moin|servus|hello|guten (?:tag|morgen|abend))\s+)?([\p{L}\p{N}_-]+)(?:\s*[,:!]\s*|\s+)\S/iu.exec(line.trim());
	const last = /\S\s*,\s*([\p{L}\p{N}_-]+)\s*[.!?]*$/u.exec(line.trim());
	if (here(addressed?.[1]) || here(last?.[1])) return `say ${line.trim()}`;
	// a greeting is talk, also to someone who is not here: "hallo", "hallo henning", "moin Bo, wie geht's?"
	if (GREETED.test(line.trim())) return `say ${line.trim()}`;
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
	if (up) return `get ${thing(up[1]!)}`;
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
	// the chest of one's building: "leg das holz in die truhe", "nimm 2 muscheln aus der kiste"
	const store = /^(?:lege|leg|tue|tu|packe|pack|put)\s*(.+?)\s+(?:in die|in das|ins|in|into the|into)\s+(?:truhe|kiste|chest|lager|lagerhaus|warehouse)$/.exec(s);
	if (store) return `verstaue ${noArticle(store[1]!)}`;
	const fromChest = /^(?:nimm|nehme|hole|hol|take)\s+(.+?)\s+(?:aus der|aus dem|aus|from the|from)\s+(?:truhe|kiste|chest|lager|lagerhaus|warehouse)$/.exec(s);
	if (fromChest) return `entnimm ${noArticle(fromChest[1]!)}`;
	// a fire: "wirf das holz ins feuer", "leg holz ins feuer" (also run together: "legeholz ins feuer"); the longer verb first, or "leg" takes the "e" of "lege" for the thing
	const fire = /^(?:werfe|wirf|lege|leg|tue|tu|put|throw)\s*(.+?)\s+(?:ins|in das|in den|in die|into the|into|in)\s+(feuer|leuchtfeuer|fire|beacon)$/.exec(s);
	if (fire) return `put ${thing(fire[1]!)} in ${fire[2]}`;
	// giving: "gib ines ein stück holz" (the person first), "gib das holz an ines", "schenk bo die muschel"
	const giveTo = /^(?:gib|gebe|schenk|schenke|reich|reiche|give|hand)\s+(\S+)\s+(.+)$/.exec(s);
	const person = giveTo && v.people.find((p) => p.toLowerCase() === giveTo[1]);
	if (giveTo && person && !/^(?:an|to|zu)\s/.test(giveTo[2]!)) return `give ${thing(giveTo[2]!)} an ${person}`;
	const giveThing = /^(?:gib|gebe|schenk|schenke|reich|reiche|give|hand)\s+(.+?)\s+(?:an|to|zu)\s+(\S+)$/.exec(s);
	const to = giveThing && v.people.find((p) => p.toLowerCase() === giveThing[2]);
	// a typed "give münze an Bert" stays as it is; only a thing with article or measure is rewritten
	if (giveThing && to && thing(giveThing[1]!) !== giveThing[1]) return `give ${thing(giveThing[1]!)} an ${to}`;
	// looking and the rest
	if (/^(schau|sieh|guck|look)\s+(dich\s+)?(um|around)$|^umsehen$|^wo bin ich$|^where am i$/.test(s)) return "look";
	if (/^(was trage|was habe|was hab|inventar|what do (carry|have))$/.test(s)) return "inventory"; // "ich"/"i" are filler
	if (/^(wer ist (da|hier|online)|wer spielt|who is (here|online))$/.test(s)) return "who";
	if (/^(hilfe|was kann ich tun|what can i do)$/.test(s)) return "help";
	return null;
}
