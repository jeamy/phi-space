// The vectors of the JavaScript primitives the Rust engine must reproduce (docs/rust-portierung.en.md, R8.2): run with the
// root of a checkout of the frozen commit (the oracle) and the file to write, e.g.
//   node --experimental-strip-types tests/r8/primitives.ts /media/data/programming/phi-oracle-2698bad ../rust/mmo-engine/tests/vectors/primitives.json
// What goes in:
// - every regular expression literal of server/engine and shared (file:line, source, flags), each run as a scan
//   (matchAll with the pattern made global, so the first match is what exec gives) over a corpus: the string literals of
//   the oracle's tests and world plus edge cases (umlauts, ß/ẞ, emoji, ſ, the Kelvin sign, line and space separators);
//   per pattern only the inputs it matches, every match as [UTF-16 index, the groups (null when one took no part)];
// - the collation: the corpus words sorted with localeCompare() and with localeCompare(…, "de") (a stable sort from the
//   corpus order), and the sign for neighbouring pairs;
// - toLowerCase / toUpperCase, UTF-16 length, NFKD and Number() of every input; the strings Math.round, Math.floor and
//   String() make of edge numbers;
// - the pure helpers every command uses, from the oracle's own modules: stem, pluralOf, typos, render, parseLocks and
//   allowed, byName and itemsNamed over the things of Leuchtfeuer.
import ts from "typescript";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const [root, out] = [process.argv[2], process.argv[3]];
if (!root || !out) throw new Error("usage: primitives.ts <oracle root> <out.json>");

const tsFiles = (d: string): string[] => readdirSync(d).flatMap((n) => {
	const p = join(d, n);
	return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
});
const parse = (f: string) => ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
const visit = (sf: ts.SourceFile, fn: (n: ts.Node) => void) => { const v = (n: ts.Node) => { fn(n); ts.forEachChild(n, v); }; v(sf); };

// the patterns
const patterns = new Map<string, { at: string[]; source: string; flags: string }>();
for (const f of [...tsFiles(join(root, "spaces-mmo/server/engine")), ...tsFiles(join(root, "spaces-mmo/shared"))].sort()) {
	const sf = parse(f);
	visit(sf, (n) => {
		if (n.kind !== ts.SyntaxKind.RegularExpressionLiteral) return;
		const t = n.getText(sf), i = t.lastIndexOf("/");
		const source = t.slice(1, i), flags = [...t.slice(i + 1)].sort().join("");
		const at = `${relative(join(root, "spaces-mmo"), f)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
		const key = `/${source}/${flags}`;
		const p = patterns.get(key);
		if (p) p.at.push(at); else patterns.set(key, { at: [at], source, flags });
	});
}

// the corpus
const corpus = new Set<string>();
const take = (s: string) => { if (s.length <= 240) corpus.add(s); };
for (const f of [...tsFiles(join(root, "spaces-mmo/tests")), ...tsFiles(join(root, "spaces-mmo/worlds"))].sort()) {
	const sf = parse(f);
	visit(sf, (n) => {
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) take(n.text);
		else if (ts.isTemplateExpression(n)) { take(n.head.text); for (const s of n.templateSpans) take(s.literal.text); }
	});
}
const EDGE = [
	"", " ", "  ", "\t", "\n", "\r", "\r\n", " ", " ", " ", " ", "　", "﻿", "\u000b", "\u000c",
	"ä", "Ä", "ö", "Ö", "ü", "Ü", "ß", "ẞ", "SS", "ss", "Straße", "STRASSE", "straße", "Strasse", "ſ", "s", "S", "K", "k", "K",
	"İ", "ı", "i", "I", "Σ", "σ", "ς", "ΌΣΟΣ", "Ǆ", "ǅ", "ǆ", "ﬁ", "ﬀ", "Å", "Å", "é", "é", "É", "É", "ñ", "ñ",
	"😀", "👋🏽", "🔥 Feuer", "a😀b", "٣", "３", "Ⅻ", "½", "²", "x²", "①",
	"0", "1", "42", "007", "-3", "3.5", "1e3", "0x10", " 12 ", "12abc", "1,5", "10×", "×", "3 x Holz", "3x holz", "2 mal tang", "5 stück muscheln",
	"hallo", "Hallo Ines", "hallo, Ines!", "Hallo Ines! Wie heißt du?", "moin", "Moin Bo", "guten Tag", "Guten Morgen, Hinnerk.", "hey: was", "hi_du", "hallox",
	"hallo,ines", "hallo ,Ines", "hallo , Ines: geh", "hallo1", "hallo-du", "hallo_du", "hallo ines.", "hi!", "hi !", "hi , du", "Moin Bo: geh nord", "moin,Bo", "guten abendx", "guten abend, Ines", "servus😀", "hallo😀", "hallo 😀", "Hallo Ïnes!", "HALLO INES", "hallö", "hallo\u00a0Ines", "hallo\tInes", "hallo Ines,", "hallo Ines, wie geht es?", "hallo Ines:", "hallo Ines: ", "hallo Ines ! ", "Ines, hallo", "Ines: hallo", "sag Hallo", "sag hallo Ines", "geh nord", "nord", "n", "Nord", "NORD", "nimm treibholz", "nimm 3 treibholz", "gib 6 münzen an Bert",
	"lege holz ins feuer", "kaufe tran", "verkaufe 2 perlen", "market zurück 3", "beam graue bucht", "beam Gräue Bücht", "Graue Bucht", "graue-bucht", "Kupferhafen", "Köhlerwald",
	"Möwenfels", "Ærø", "Øy", "Łódź", "Œuvre", "Ÿ", "ÿ", "Æ", "æ", "Þ", "ð", "Ð",
	"a", "A", "b", "B", "z", "Z", "_", "-", "'", "a-b", "a_b", "a b", "a'b", "a.b", "a,b", "a!b", "a?b", "...", "!!!", "?", "!", ".", ",", ":", ";",
	"x".repeat(41), "y".repeat(30), "Z".repeat(31),
	"inf", "nan", "NaN", "Infinity", "+Infinity", "-Infinity", "infinity", "0b11", "0o7", "0X1f", "-0x10", "1_000", "\ufeff5", "5\u00a0", "5e", ".5", "5.", "+5", "-0", "1e1000", "1e-1000", "00", "0.0", "1.2.3", "٣٣", "５", "12 34", "e5", "-", "+", "1e+5", "1E5",
];
for (const s of EDGE) corpus.add(s);
const inputs = [...corpus];

// a scan the way matchAll makes it: lastIndex advances by one code unit (by one code point with u) past an empty match
function scan(re: RegExp, s: string): [number, ...(string | null)[]][] {
	const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
	return [...s.matchAll(g)].map((m) => [m.index!, ...[...m].map((x) => (x === undefined ? null : x))]);
}
const pats = [...patterns.values()].map((p) => {
	const re = new RegExp(p.source, p.flags);
	const hits: [number, ...[number, ...(string | null)[]][]][] = [];
	inputs.forEach((s, i) => { const m = scan(re, s); if (m.length) hits.push([i, ...m]); });
	return { at: p.at, source: p.source, flags: p.flags, hits };
});

// collation: the words of the corpus (letters, digits, blanks and dashes; the names of rooms, figures and things)
const words = inputs.filter((s) => s.length > 0 && s.length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’-]*$/u.test(s));
const root_ = [...words].sort((a, b) => a.localeCompare(b)), de = [...words].sort((a, b) => a.localeCompare(b, "de"));
const signs = (list: string[], locale?: string) => list.slice(1).map((b, i) => Math.sign(locale ? list[i]!.localeCompare(b, locale) : list[i]!.localeCompare(b)));

// numbers
const NUMS = [0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, -0.49999999999999994, 1e21, 1e-7, 123456789012345680000, 4503599627370495.5, -4503599627370495.5,
	Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0.1 + 0.2, 1 / 3, 2 / 3, 10 / 3, 99.99, 12.345, 1e300 * 10, -1e300 * 10, NaN, 5e-324, 0.000001, 1234.5678, -7.5, 7.5, 1e20, 1e21 - 1];
const num = (n: number) => (Number.isNaN(n) ? "NaN" : n === Infinity ? "Infinity" : n === -Infinity ? "-Infinity" : Object.is(n, -0) ? "-0" : String(n));
const numbers = NUMS.map((n) => ({ n: num(n), round: num(Math.round(n)), floor: num(Math.floor(n)), ceil: num(Math.ceil(n)), trunc: num(Math.trunc(n)), text: String(n) }));

const strings = inputs.map((s) => ({ lower: s.toLowerCase(), upper: s.toUpperCase(), len16: s.length, nfkd: s.normalize("NFKD"), number: num(Number(s)) }));

// the helpers
const from = (p: string) => import(pathToFileURL(join(root, "spaces-mmo", p)).href);
const ctx = await from("server/engine/context.ts"), fp = await from("server/engine/funcparser.ts"), lk = await from("server/engine/locks.ts");
const world = await (await from("server/engine/world.ts")).loadWorld("leuchtfeuer");
const names = [...new Set([...words, ...world.prototypes.flatMap((p: { name: string; aliases: string[] }) => [p.name, ...p.aliases]), ...(world.animals?.kinds ?? []).map((k: { name: string }) => k.name)])];
const typoPairs: [string, string, number, number][] = [];
names.forEach((a, i) => { for (const b of [names[i + 1], names[(i * 7 + 3) % names.length], a.slice(1), a + "e", [...a].reverse().join("")]) if (b !== undefined) for (const m of [0, 1, 2]) typoPairs.push([a, b, m, ctx.typos(a, b, m)]); });
const TEXTS = ["$you() $conj(hebst|hebt) den Stein auf.", "Da $conj(stehst|steht) $you(). $you() $conj(lachst|lacht)!", "$you(): $conj(a|b|c) $conj(nur) $conj() $other(x) $you(x)", "Ja? $you()", "$you()$you() $conj(|leer)", "Gruß, $you()… und $you()", "😀 $you() $conj(ä|ö)"];
const renders = TEXTS.flatMap((t) => [true, false].map((self) => [t, self, fp.render(t, { viewer: self ? "c1" : "c2", actor: "c1", actorName: "Ines" })]));
const lockTexts = [...new Set<string>([...world.prototypes.map((p: { locks?: string }) => p.locks ?? ""), ...(world.exits ?? []).map((e: { locks?: string }) => e.locks ?? ""),
	"", "get:all()", "get:none()", "GET:ALL()", "get:not guest()", "traverse:perm(Player)", "traverse:perm(builder) or id(c1)", "get:holds(schluessel) and not guest();give:perm(Admin)",
	"get:(all() or none()) and not (guest())", "get:all();get:none()", "get:none();give:all();get:all()", "get:", ":all()", "get all()", "g3t:all()", "get:foo()", "get:perm()", "get:perm(King)",
	"get:all(x)", "get:id()", "get:all() and", "get:(all()", "get:all())", "get:constructor()", "get:toString()", "x".repeat(501), "get:all();;  ;", " get : all ( ) ", "get:not not all()", "get:all() or", "get:holds(a b)", "get:id(c1) extra", "a".repeat(21) + ":all()", "ä:all()", "get:allx()", "get:all-x()"])];
const LCTX = [{ level: "Guest", guest: true, charId: "c1", holds: [] }, { level: "Player", guest: false, charId: "c2", holds: ["schluessel"] }, { level: "Builder", guest: false, charId: "c1", holds: ["a"] }, { level: "Admin", guest: false, charId: "c3", holds: [] }];
const ACCESS = ["get", "GET", "give", "traverse", "use", "x"];
const locks = lockTexts.map((l) => {
	let parsed: string[] | string;
	try { parsed = [...lk.parseLocks(l).keys()]; } catch (e) { parsed = (e as Error).message; }
	return { l, parsed, allowed: LCTX.map((c) => ACCESS.map((a) => lk.allowed(l, a, { ...c, holds: (k: string) => c.holds.includes(k) }))) };
});
const things = world.prototypes.map((p: { key: string; name: string; aliases: string[] }, i: number) => ({ name: p.name, aliases: p.aliases, proto: p.key, ...(i % 3 ? { x: (i * 5) % 17, y: (i * 3) % 11 } : {}) }));
const list = things.map((f: unknown, i: number) => ({ e: { fields: f, i }, f }));
const queries = [...new Set([...names, ...names.map((n) => n.slice(0, 3)), ...names.map((n) => n.toUpperCase() + "n"), ...names.map((n) => n.slice(1)), ...EDGE.slice(0, 60)])];
const idx = (r: Array<{ e: { i: number } }>) => r.map((x) => x.e.i);
const lookups = queries.map((q) => [q, idx(ctx.byName(list, q)), idx(ctx.byName(list, q, { x: 4, y: 2 })), idx(ctx.itemsNamed(world, list, q)), idx(ctx.itemsNamed(world, list, q, { x: 9, y: 7 }))]);
const helpers = { stem: names.map((n) => [n, ctx.stem(n)]), plural: [...names, ...Object.getOwnPropertyNames(Object.prototype)].map((n) => [n, String(ctx.pluralOf(n, world)), String(ctx.pluralOf(n))]), typos: typoPairs, renders, locks, access: ACCESS, lockCtx: LCTX, things, lookups };

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ oracle: { node: process.version, icu: process.versions.icu, unicode: process.versions.unicode }, inputs, patterns: pats, collation: { words, root: root_, de, rootSigns: signs(root_), deSigns: signs(de, "de") }, numbers, strings, helpers }));
console.log(`${pats.length} patterns over ${inputs.length} inputs (${pats.reduce((n, p) => n + p.hits.length, 0)} matching), ${words.length} words, ${numbers.length} numbers -> ${out}`);
