// German is what the game is written in; English lies over it. `tr` turns any text of the game into the chosen language, the
// world's sentences with their values too: en.ts holds their templates ({0}, {1} … for a value), scripts/i18n-extract.ts finds
// them in the sources. `watchPage` applies it to everything the page shows, so no component has to know.
import { EN } from "./en.ts";

export type Lang = "de" | "en";
const KEY = "mmo-help-lang";
export function language(): Lang {
	if (typeof window === "undefined") return "de";
	try { const v = localStorage.getItem(KEY); if (v === "de" || v === "en") return v; } catch { /* storage may be blocked */ }
	return "de";
}
/** The whole page goes over to the language: a reload is the one way every text already shown follows. */
export function setLanguage(l: Lang): void {
	try { localStorage.setItem(KEY, l); } catch { /* storage may be blocked */ }
	location.reload();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Pattern = { re: RegExp; slots: number[]; en: string };
let patterns: Pattern[] | null = null;
/** The templates, longest fixed text first: the most particular one wins. */
function compiled(): Pattern[] {
	if (patterns) return patterns;
	patterns = [];
	const list = Object.entries(EN).filter(([de]) => /\{\d\}/.test(de)).sort(([a], [b]) => b.replace(/\{\d\}/g, "").length - a.replace(/\{\d\}/g, "").length);
	for (const [de, en] of list) {
		const fixed = de.replace(/\{\d\}/g, "").trim();
		if (fixed.length < 4) continue; // "{0} {1}" would match anything
		const slots: number[] = [];
		const body = de.split(/(\{\d\})/).map((p) => { const m = /^\{(\d)\}$/.exec(p); if (!m) return escape(p); slots.push(Number(m[1])); return "(.*?)"; }).join("");
		patterns.push({ re: new RegExp(`^${body}$`, "su"), slots, en });
	}
	return patterns;
}

let known: RegExp | null = null;
/** The rest of a text no template fits: what is known in it, longest first ("Baustelle Hütte" as two things). */
function phrases(text: string): string {
	known ??= new RegExp(`(?<![\\p{L}])(?:${Object.keys(EN).filter((k) => !k.includes("{") && ((k.length >= 4 && /^\p{Lu}/u.test(k)) || k === "ost" || k === "süd" || k === "nord")).sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\p{L}])`, "gu");
	return text.replace(known, (m) => EN[m] ?? m);
}

const cache = new Map<string, string>();
function translate(text: string, depth: number): string {
	const exact = EN[text];
	if (exact !== undefined) return exact;
	// a value set in bold (client/RichText.tsx) is translated inside its marks
	const bold = /^\*\*((?:(?!\*\*).)+)\*\*$/su.exec(text);
	if (bold) return `**${translate(bold[1]!, depth)}**`;
	// several values in bold with words between ("**3 Treibholz** für **2 Münzen**"): each piece by itself
	if (!bold && depth >= 1 && depth <= 2 && /\*\*.+?\*\*/su.test(text) && !/\{/.test(text)) {
		const pieces = text.split(/(\*\*.+?\*\*)/su);
		if (pieces.length > 3) return pieces.map((p) => {
			if (/^\*\*.+\*\*$/su.test(p)) return translate(p, depth + 1);
			const core = p.trim();
			if (!core) return p;
			return p.replace(core, core === "für" ? "for" : translate(core, depth + 1));
		}).join("");
	}
	// " für 2 Münzen" of an offer: too short a template for the patterns below
	const price = /^(\s*)für (.+)$/su.exec(text);
	if (price && depth <= 2) return `${price[1]!}for ${translate(price[2]!, depth + 1)}`;
	// "5 Muscheln": the thing, its number stays
	const counted = /^(\d+×?\s+)(.+)$/.exec(text);
	if (counted) {
		const word = counted[2]!, one = word.replace(/n$/, "");
		if (EN[word] !== undefined) return counted[1]! + EN[word]!;
		// the German plural of a thing whose singular is known
		if (one !== word && EN[one] !== undefined) return `${counted[1]!}${EN[one]!}s`;
	}
	for (const p of compiled()) {
		const m = p.re.exec(text);
		if (!m) continue;
		let out = p.en;
		// a German plural ending as a value ("Münze{1}") is the English one
		p.slots.forEach((slot, i) => { const v = m[i + 1]!; out = out.split(`{${slot}}`).join(/^(?:n|e|en)$/.test(v) ? "s" : depth > 2 ? v : translate(v, depth + 1)); });
		return out;
	}
	// a list of things, or sentences put together
	if (depth <= 2 && /, /.test(text) && text.length < 200 && text.split(", ").every((p) => /^(\d+×?\s+)?\p{Lu}/u.test(p))) return text.split(", ").map((p) => translate(p, depth + 1)).join(", ");
	return phrases(text);
}

/** The English of a text, whatever the page's language (the tests). */
export const toEnglish = (text: string) => translate(text, 0);

/** `text` in the chosen language; what is not known stays as it is. Lines and sentences go one by one when the whole is not known. */
export function tr(text: string): string {
	if (language() === "de" || !text.trim()) return text;
	const known = cache.get(text);
	if (known !== undefined) return known;
	const body = text.trim();
	// the room's text comes as lines, some answers as sentences put together
	const lines = body.split("\n");
	let out = lines.length > 1 ? lines.map((l) => tr(l)).join("\n") : translate(body, 0);
	if (lines.length === 1 && EN[body] === undefined && !/\{/.test(body)) {
		const parts = body.split(/(?<=[.!?:])\s+(?=[\p{Lu}„])/u);
		if (parts.length > 1) out = parts.map((s) => translate(s, 0)).join(" ");
	}
	out = text.replace(body, out);
	if (cache.size > 5000) cache.clear();
	cache.set(text, out);
	return out;
}

const ATTRS = ["placeholder", "title", "aria-label"];
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);
function translateNode(n: Node): void {
	if (n.nodeType === Node.TEXT_NODE) {
		const parent = n.parentElement;
		if (!parent || SKIP.has(parent.tagName) || parent.closest("[data-no-tr]")) return;
		const v = n.nodeValue ?? "", t = tr(v);
		if (t !== v) n.nodeValue = t;
		return;
	}
	if (n.nodeType !== Node.ELEMENT_NODE) return;
	const el = n as Element;
	if (SKIP.has(el.tagName) || el.closest("[data-no-tr]")) return;
	for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const t = tr(v); if (t !== v) el.setAttribute(a, t); } }
	for (const c of el.childNodes) translateNode(c);
}

/** Keeps the page in the chosen language, whatever React or the world writes into it. */
export function watchPage(): () => void {
	if (language() === "de") return () => {};
	document.documentElement.lang = "en";
	translateNode(document.body);
	const seen = new MutationObserver((changes) => {
		for (const c of changes) {
			if (c.type === "characterData") translateNode(c.target);
			else if (c.type === "attributes") translateNode(c.target);
			else c.addedNodes.forEach(translateNode);
		}
	});
	seen.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
	return () => seen.disconnect();
}
