// The German texts of the game for client/i18n/en.ts: every string a player can see, from the sources, with {0}, {1} … where a
// template has a value. `node --experimental-strip-types scripts/i18n-extract.ts` prints JSON { group: [texts] }; tests/i18n.test.ts
// uses it to see that none lacks its English.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const ROOT = join(import.meta.dirname, "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
const SKIP = /client\/(help\/articles|i18n\/|lib\/|chatcrypto|figure3d|props3d|terrain3d|tiles3d)|server\/(llm|llm-status|space|launch|env|npc-host|model-host|space-host|world-host|settings)\.ts|server\/npc\//;

/** Whether a string reads as text for a person, not as code. */
function isText(s: string): boolean {
	const t = s.trim();
	if (t.length < 2 || !/\p{L}{2}/u.test(t)) return false;
	if (/^[a-z][\w-]*$/.test(t) && !/[äöüß]/.test(t)) return false; // an identifier, a key, a lower-case command word
	if (/^[\w.-]+\/[\w./-]*$|^https?:|^[.#]?[a-z-]+[:{(]|^\d+(px|ms|%)|^#[0-9a-f]{3,8}$|^[A-Z_]{2,}$|[{};]\s*$/.test(t)) return false;
	if (/^[A-Z][a-z]+[A-Z]/.test(t) || /^[a-z]+(-[a-z]+)+$/.test(t) || /^[a-z]+\.[a-z.]+$/.test(t)) return false; // TypeNames, css-words, dotted.keys
	return true;
}

/** `$you() $conj(gehst|geht) nach x` as the viewer and as the others read it. */
const forms = (s: string) => (!/\$you\(\)|\$conj\(/.test(s) ? [s] : [s.replace(/\$you\(\)/g, "Du").replace(/\$conj\(([^|)]*)\|[^)]*\)/g, "$1"), s.replace(/\$you\(\)/g, "{9}").replace(/\$conj\([^|)]*\|([^)]*)\)/g, "$1")]);

function textsOf(file: string): string[] {
	const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const out = new Set<string>();
	const add = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); if (isText(t)) for (const f of forms(t)) out.add(f); };
	const visit = (n: import("typescript").Node): void => {
		if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
			const up = n.parent;
			const key = (ts.isPropertyAssignment(up) && (up.name === n || /^(?:key|line)$/.test(up.name.getText()))) || (ts.isArrayLiteralExpression(up) && ts.isPropertyAssignment(up.parent) && up.parent.name.getText() === "aliases");
			const attr = ts.isJsxAttribute(up) && !["placeholder", "title", "aria-label", "label"].includes(up.name.getText());
			const compare = ts.isBinaryExpression(up) && /[=!]==?/.test(up.operatorToken.getText());
			const call = ts.isCallExpression(up) && /\.(startsWith|endsWith|includes|test|getItem|setItem|querySelector\w*|addEventListener|matchMedia|readAll|take|write|peek|takeIfExists|readIfExists|count)$|^(fetch|post|matchMedia|Number)$/.test(up.expression.getText());
			const sent = ts.isCallExpression(up) && up.expression.getText() === "send";
			if (!key && !attr && !compare && !call && !sent) add(n.text);
		} else if (ts.isJsxText(n)) add(n.text);
		else if (ts.isTemplateExpression(n)) {
			let i = 0, s = n.head.text;
			for (const span of n.templateSpans) s += `{${i++}}${span.literal.text}`;
			add(s);
		}
		ts.forEachChild(n, visit);
	};
	visit(src);
	return [...out];
}

export function extract(): Record<"ui" | "game" | "world", string[]> {
	const group = (dirs: string[]) => [...new Set(dirs.flatMap((d) => walk(join(ROOT, d))).filter((f) => !SKIP.test(f)).flatMap(textsOf))].sort();
	const ui = group(["client"]), world = group(["worlds"]);
	const game = group(["server", "shared"]).filter((t) => !ui.includes(t) && !world.includes(t));
	return { ui, game, world };
}

if (import.meta.main ?? process.argv[1]?.endsWith("i18n-extract.ts")) console.log(JSON.stringify(extract(), null, "\t"));
