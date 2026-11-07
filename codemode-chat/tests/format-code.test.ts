// The page's code view (client/lib/format-code.ts): a contribution squeezed onto one line is shown broken into lines
// and indented; nothing but whitespace changes, and the result still parses.
import test from "node:test";
import assert from "node:assert/strict";
import { formatCode, isSqueezed } from "../client/lib/format-code.ts";
import { TASKS } from "../server/tasks.ts";

const parses = (src: string) => new Function(`return (async()=>{${src}\n})`);
const same = (a: string, b: string) => assert.equal(a.replace(/\s+/g, ""), b.replace(/\s+/g, ""));

test("every squeezed variant of the catalog: only whitespace changes, it still parses, and it has lines", () => {
	let n = 0;
	for (const t of TASKS) for (const v of t.variants) {
		if (!isSqueezed(v)) continue;
		n++;
		const f = formatCode(v);
		same(f, v);
		parses(f);
		assert.ok(f.split("\n").length > 2, `${t.id}: ${f.slice(0, 80)}`);
	}
	assert.ok(n >= 30, String(n));
});

test("blocks are broken, object literals, for heads, strings, templates and regular expressions are kept", () => {
	const src = 'async function f(){const o={a:1,b:"x{y};z"};for(let i=0;i<3;i++){if(/[{;]/.test(o.b))o.a++;else{o.a--}}try{await g(`a${{k:1}.k};{b}`)}catch(e){return null}return o.a/2}';
	assert.equal(formatCode(src), [
		"async function f(){",
		'\tconst o={a:1,b:"x{y};z"};',
		"\tfor(let i=0;i<3;i++){",
		"\t\tif(/[{;]/.test(o.b))o.a++;",
		"\t\telse{",
		"\t\t\to.a--",
		"\t\t}",
		"\t}",
		"\ttry{",
		"\t\tawait g(`a${{k:1}.k};{b}`)",
		"\t} catch(e){",
		"\t\treturn null",
		"\t}",
		"\treturn o.a/2",
		"}",
	].join("\n"));
	// code with its own lines is shown as it is
	const written = "function f(x) {\n  return x + 1;\n}";
	assert.equal(formatCode(written), written);
});
