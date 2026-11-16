//! Plain language into commands without a model (`server/engine/translate.ts`): rules for the sentences people type most.
use crate::js::{caps, re, trim};

/// `TranslateView`: what the rules may look at.
pub struct View { pub exits: Vec<(String, Vec<String>)>, pub listings: Vec<String>, pub carried: Vec<String>, pub people: Vec<String> }

const FILLER: &str = r"\b(bitte|mal|doch|jetzt|noch|auch|einfach|schnell|gerne?|ich|möchte|moechte|will|würde|wuerde|gern|please|i|want|would|like)\b";
const ARTICLE: &str = r"^(den|dem|die|das|der|des|ein|eine|einen|einem|the|a|an)\s+";

fn clean(s: &str) -> String {
	let s = re(r"[.!?,;]+", "g").replace(&s.to_lowercase(), " ");
	let s = re(FILLER, "gi").replace(&s, " ");
	let s = re(r"\s+", "g").replace(&s, " ");
	re(r"^(hallo|hi|hey|moin|servus|hello)\b\s*", "").replace(trim(&s), "")
}
fn no_article(s: &str) -> String { trim(&re(ARTICLE, "i").replace(s, "")).to_owned() }
/// `thing`: "ein stück holz" → "holz".
fn thing(s: &str) -> String {
	let s = re(r"^(?:stück|stueck|stückchen|bisschen|etwas|piece of|some|bit of)\s+(?:von\s+|vom\s+|of\s+)?", "i").replace(&no_article(s), "");
	trim(&re(ARTICLE, "i").replace(&s, "")).to_owned()
}
fn g(m: &[Option<String>], i: usize) -> String { m.get(i).cloned().flatten().unwrap_or_default() }

/// `translateRules`: the command a sentence means, or None.
pub fn translate_rules(line: &str, v: &View) -> Option<String> {
	let t = trim(line);
	let here = |name: Option<String>| name.is_some_and(|n| !n.is_empty() && v.people.iter().any(|p| p.to_lowercase() == n.to_lowercase()));
	let addressed = caps(&re(r"^(?:(?:hallo|hi|hey|moin|servus|hello|guten (?:tag|morgen|abend))\s+)?([\p{L}\p{N}_-]+)(?:\s*[,:!]\s*|\s+)\S", "iu"), t);
	let last = caps(&re(r"\S\s*,\s*([\p{L}\p{N}_-]+)\s*[.!?]*$", "u"), t);
	if here(addressed.and_then(|m| m.get(1).cloned().flatten())) || here(last.and_then(|m| m.get(1).cloned().flatten())) { return Some(format!("say {t}")); }
	if re(r"^(?:hallo|hi|hey|moin|servus|hello|guten (?:tag|morgen|abend))(?![\p{L}\p{N}_-])(?:\s*[.!?]*|\s*,?\s*[\p{L}\p{N}_-]+\s*(?:[.!?]*|[,:]\s*\S.*))$", "iu").test(t) { return Some(format!("say {t}")); }
	let s = clean(line);
	if s.is_empty() { return None; }
	if let Some(walk) = caps(&re(r"^(?:(?:geh|gehe|lauf|laufe|go|walk|reise)\s+)?(?:nach|richtung|zum|zur|zu|in den|in die|ins|to|towards)\s+(.+)$", ""), &s).or_else(|| caps(&re(r"^(?:geh|gehe|lauf|laufe)\s+(.+)$", ""), &s)) {
		let target = no_article(&g(&walk, 1));
		if let Some((name, _)) = v.exits.iter().find(|(n, a)| std::iter::once(n).chain(a.iter()).any(|x| x.to_lowercase() == target)) { return Some(format!("go {name}")); }
	}
	if let Some(up) = caps(&re(r"^(?:nimm|nehme|heb|hebe|sammle?)\s+(.+?)\s+auf$", ""), &s).or_else(|| caps(&re(r"^pick\s+up\s+(.+)$", ""), &s)) { return Some(format!("get {}", thing(&g(&up, 1)))); }
	if let Some(buy) = caps(&re(r"^(?:kauf|kaufe|buy)\s+(.+?)\s+(?:am|vom|auf dem|at the|from the)\s+(?:markt|marktbrett|market)$", ""), &s).or_else(|| caps(&re(r"^(?:kauf|kaufe|buy)\s+(?:am|vom|at the)\s+(?:markt|marktbrett|market)\s+(.+)$", ""), &s)) {
		let what = no_article(&g(&buy, 1));
		return Some(match v.listings.iter().find(|x| { let l = x.to_lowercase(); l == what || l.starts_with(&what) }) { Some(l) => format!("market kaufe {}", l.to_lowercase()), None => "market".into() });
	}
	if let Some(sell) = caps(&re(r"^(?:biete|verkaufe|sell)\s+(.+?)\s+(?:(?:am|auf dem|at the)\s+(?:markt|marktbrett|market)\s+)?(?:für|fuer|for|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?(?:\s+an)?$", ""), &s) {
		if !re(r"\s(an|to)\s+\S+$", "").test(&g(&sell, 1)) { return Some(format!("market biete {} für {}", no_article(&g(&sell, 1)), g(&sell, 2))); }
	}
	if let Some(want) = caps(&re(r"^(?:suche|such|want)\s+(?:(?:am|auf dem|at the)\s+(?:markt|marktbrett|market)\s+)?(.+?)\s+(?:(?:am|auf dem|at the)\s+(?:markt|marktbrett|market)\s+)?(?:für|fuer|for|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?$", ""), &s) {
		return Some(format!("market suche {} für {}", no_article(&g(&want, 1)), g(&want, 2)));
	}
	if let Some(burn) = caps(&re(r"^(?:brenne|brennen|burn)\s+(?:(\d+)\s+)?(?:ziegel|ziegelsteine?|bricks?)$", ""), &s) {
		let n = g(&burn, 1);
		return Some(format!("craft {}ziegel", if n.is_empty() { String::new() } else { format!("{n} ") }));
	}
	if let Some(store) = caps(&re(r"^(?:lege|leg|tue|tu|packe|pack|put)\s*(.+?)\s+(?:in die|in das|ins|in|into the|into)\s+(?:truhe|kiste|chest|lager|lagerhaus|warehouse)$", ""), &s) { return Some(format!("verstaue {}", no_article(&g(&store, 1)))); }
	if let Some(to) = caps(&re(r"^(?:lege|leg|tue|tu|packe|pack|put|schicke|schick|send)\s*(.+?)\s+(?:in die|in meine|in|into the|into my|into|to)\s+(?:truhe|kiste|chest)\s+(?:(?:der|meiner|von der|in der|im|in den|in|am|an der|auf|bei|of the|of my|at|in the)\s+)?(.+)$", ""), &s) { return Some(format!("verstaue {} in {}", no_article(&g(&to, 1)), g(&to, 2))); }
	if let Some(from) = caps(&re(r"^(?:nimm|nehme|hole|hol|take)\s+(.+?)\s+(?:aus der|aus dem|aus|from the|from)\s+(?:truhe|kiste|chest|lager|lagerhaus|warehouse)$", ""), &s) { return Some(format!("entnimm {}", no_article(&g(&from, 1)))); }
	if let Some(fire) = caps(&re(r"^(?:werfe|wirf|lege|leg|tue|tu|put|throw)\s*(.+?)\s+(?:ins|in das|in den|in die|into the|into|in)\s+(feuer|leuchtfeuer|fire|beacon)$", ""), &s) { return Some(format!("put {} in {}", thing(&g(&fire, 1)), g(&fire, 2))); }
	let give_to = caps(&re(r"^(?:gib|gebe|schenk|schenke|reich|reiche|give|hand)\s+(\S+)\s+(.+)$", ""), &s);
	if let Some(gt) = &give_to {
		if let Some(person) = v.people.iter().find(|p| p.to_lowercase() == g(gt, 1)) {
			if !re(r"^(?:an|to|zu)\s", "").test(&g(gt, 2)) { return Some(format!("give {} an {person}", thing(&g(gt, 2)))); }
		}
	}
	if let Some(gt) = caps(&re(r"^(?:gib|gebe|schenk|schenke|reich|reiche|give|hand)\s+(.+?)\s+(?:an|to|zu)\s+(\S+)$", ""), &s) {
		if let Some(to) = v.people.iter().find(|p| p.to_lowercase() == g(&gt, 2)) {
			if thing(&g(&gt, 1)) != g(&gt, 1) { return Some(format!("give {} an {to}", thing(&g(&gt, 1)))); }
		}
	}
	if re(r"^(schau|sieh|guck|look)\s+(dich\s+)?(um|around)$|^umsehen$|^wo bin ich$|^where am i$", "").test(&s) { return Some("look".into()); }
	if re(r"^(was trage|was habe|was hab|inventar|what do (carry|have))$", "").test(&s) { return Some("inventory".into()); }
	if re(r"^(wer ist (da|hier|online)|wer spielt|who is (here|online))$", "").test(&s) { return Some("who".into()); }
	if re(r"^(hilfe|was kann ich tun|what can i do)$", "").test(&s) { return Some("help".into()); }
	None
}
