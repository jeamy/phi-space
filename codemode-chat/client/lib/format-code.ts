// Code as the page shows it: a contribution written on one long line (the scripted agents' variants, some models'
// answers) is broken into lines and indented, for reading only; what is judged and run stays the source as handed in.
// No parser: a tokenizer that knows strings, template literals, comments and regular expressions, and breaks
//   after the `{` of a block (after `)`, `=>`, `else`, `try`, `finally`, `do`) and before its `}`,
//   after a `;` outside parentheses (so the head of a `for` stays on its line).
// Object literals stay on their line. Code that already has its lines is left as it is.

const LONG = 100;

/** Does this source look squeezed onto few lines (a line longer than LONG characters with a block or a `;` in it)? */
export const isSqueezed = (src: string): boolean => src.split("\n").some((l) => l.length > LONG && /[{;]/.test(l));

type Tok = { t: string; kind: "str" | "comment" | "regex" | "word" | "punct" | "space" };

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>", "return", "typeof", "case", "of", "in", "&&", "||", "??", "==", "===", "!=", "!==", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "?.(", ""]);

function tokens(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	const last = () => { for (let k = out.length - 1; k >= 0; k--) if (out[k]!.kind !== "space" && out[k]!.kind !== "comment") return out[k]!.t; return ""; };
	while (i < src.length) {
		const c = src[i]!, d = src[i + 1];
		if (/\s/.test(c)) { let j = i; while (j < src.length && /\s/.test(src[j]!)) j++; out.push({ t: src.slice(i, j), kind: "space" }); i = j; continue; }
		if (c === "/" && d === "/") { let j = src.indexOf("\n", i); if (j < 0) j = src.length; out.push({ t: src.slice(i, j), kind: "comment" }); i = j; continue; }
		if (c === "/" && d === "*") { let j = src.indexOf("*/", i + 2); j = j < 0 ? src.length : j + 2; out.push({ t: src.slice(i, j), kind: "comment" }); i = j; continue; }
		if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1; out.push({ t: src.slice(i, j + 1), kind: "str" }); i = j + 1; continue; }
		if (c === "`") { i = template(src, i, out); continue; }
		if (c === "/" && REGEX_BEFORE.has(last())) {
			let j = i + 1, cls = false;
			while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
			j++;
			while (j < src.length && /[a-z]/i.test(src[j]!)) j++;
			out.push({ t: src.slice(i, j), kind: "regex" }); i = j; continue;
		}
		if (/[\p{L}\p{N}_$]/u.test(c)) { let j = i; while (j < src.length && /[\p{L}\p{N}_$.]/u.test(src[j]!) && !(src[j] === "." && src[j + 1] === ".")) j++; out.push({ t: src.slice(i, j), kind: "word" }); i = j; continue; }
		const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
		const op = ["===", "!==", "...", "**=", "??=", "&&=", "||="].includes(three) ? three : ["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "+=", "-=", "*=", "/=", "%=", "++", "--", "**"].includes(two) ? two : c;
		out.push({ t: op, kind: "punct" }); i += op.length;
	}
	return out;
}

/** A template literal from `start` (its backtick), with `${…}` nested to any depth; pushed as one string token. */
function template(src: string, start: number, out: Tok[]): number {
	let j = start + 1;
	while (j < src.length && src[j] !== "`") {
		if (src[j] === "\\") { j += 2; continue; }
		if (src[j] === "$" && src[j + 1] === "{") {
			let depth = 1; j += 2;
			while (j < src.length && depth) {
				if (src[j] === "`") { const sub: Tok[] = []; j = template(src, j, sub); continue; }
				if (src[j] === '"' || src[j] === "'") { const q = src[j]; j++; while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1; j++; continue; }
				if (src[j] === "{") depth++; else if (src[j] === "}") depth--;
				j++;
			}
			continue;
		}
		j++;
	}
	out.push({ t: src.slice(start, j + 1), kind: "str" });
	return j + 1;
}

const BLOCK_AFTER = new Set([")", "=>", "else", "try", "finally", "do"]);
const KEEP_AFTER_CLOSE = new Set([")", ",", ";", "]", "else", "catch", "finally", "while", ".", "?.", ":"]);

/** The source broken into lines and indented with a tab, if it looks squeezed; otherwise as it is. */
export function formatCode(src: string): string {
	if (!isSqueezed(src)) return src;
	const toks = tokens(src);
	// for each `{`: is it a block? for each `(`: depth, so `;` inside a for head stays
	const stack: Array<{ block: boolean; parens: number }> = [{ block: true, parens: 0 }];
	let out = "", indent = 0, prev = "", pendingBreak = false;
	const nl = () => { out = out.replace(/[ \t]+$/, ""); out += "\n" + "\t".repeat(indent); };
	const next = (k: number) => { for (let m = k + 1; m < toks.length; m++) if (toks[m]!.kind !== "space") return toks[m]!.t; return ""; };
	toks.forEach((tok, k) => {
		if (tok.kind === "space") {
			if (tok.t.includes("\n")) pendingBreak = true;
			else if (!out.endsWith("\t") && !out.endsWith("\n") && out) out += " ";
			return;
		}
		const top = stack[stack.length - 1]!;
		if (tok.t === "}" && tok.kind === "punct") {
			const open = stack.length > 1 ? stack.pop()! : top;
			if (open.block) { indent = Math.max(0, indent - 1); nl(); out += "}"; pendingBreak = !KEEP_AFTER_CLOSE.has(next(k)); if (!pendingBreak && /^[a-z]/.test(next(k))) out += " "; }
			else out += "}";
			prev = "}";
			return;
		}
		if (pendingBreak) { pendingBreak = false; nl(); }
		out += tok.t;
		if (tok.kind === "comment" && tok.t.startsWith("//")) pendingBreak = true;
		if (tok.kind === "punct") {
			if (tok.t === "(") top.parens++;
			else if (tok.t === ")") top.parens = Math.max(0, top.parens - 1);
			else if (tok.t === "{") {
				const block = BLOCK_AFTER.has(prev);
				stack.push({ block, parens: 0 });
				if (block) { indent++; if (next(k) !== "}") pendingBreak = true; }
			} else if (tok.t === ";" && top.parens === 0 && top.block) pendingBreak = next(k) !== "}" && next(k) !== "";
		}
		prev = tok.t;
	});
	return out.replace(/[ \t]+$/gm, "");
}
