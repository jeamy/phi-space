// What the walks never reached in the frozen engine (docs/rust-portierung.en.md, R8.2): reads the V8 coverage the
// TypeScript driver wrote (every file below the directory: one folder per walk) (NODE_V8_COVERAGE, set by rust/mmo-engine/tests for its child) and lists, for each named file
// of the oracle, the lines no run of the driver executed (the innermost block over the line's first character had count
// 0 in every coverage file). A module is ported when its walks leave nothing here that is not named and justified.
// `--spans` also lists, within the lines that ran, the pieces that never did (a branch of a ternary, the right of `??`).
//
//   node --experimental-strip-types --no-warnings tests/r8/uncovered.ts [--spans] <coverage dir> <oracle file>...
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2), spans = argv.includes("--spans");
const [dir, ...files] = argv.filter((a) => a !== "--spans");
if (!dir || !files.length) throw new Error("usage: uncovered.ts <coverage dir> <oracle file>...");
type Range = { startOffset: number; endOffset: number; count: number };
// every coverage file below `dir` (one folder per walk)
const jsonFiles = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsonFiles(join(d, e.name)) : e.name.endsWith(".json") ? [join(d, e.name)] : []));
const runs = jsonFiles(dir).map((f) => JSON.parse(readFileSync(f, "utf8")) as { result: Array<{ url: string; functions: Array<{ ranges: Range[] }> }> });
for (const file of files) {
	const url = pathToFileURL(file).href, src = readFileSync(file, "utf8");
	const hit = new Uint8Array(src.length), zero = new Uint8Array(src.length);
	let seen = false;
	for (const run of runs) for (const script of run.result) {
		if (script.url !== url) continue;
		seen = true;
		// the innermost range decides: ranges sorted outer first (by start, then by length, longest first)
		const ranges = script.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
		const count = new Int32Array(src.length).fill(-1);
		for (const r of ranges) count.fill(r.count, r.startOffset, Math.min(r.endOffset, src.length));
		for (let i = 0; i < src.length; i++) { if (count[i]! > 0) hit[i] = 1; else if (count[i] === 0) zero[i] = 1; }
	}
	const lines = src.split("\n");
	const out: string[] = [];
	let at = 0;
	lines.forEach((line, n) => {
		const first = line.search(/\S/);
		const code = first >= 0 && !/^\s*(\/\/|\/\*|\*|import |export \{|export type|type |\}|\)|\];?$)/.test(line);
		if (seen && code && !hit[at + first]) out.push(`${n + 1}: ${line.trim().slice(0, 110)}`);
		else if (seen && code && spans) {
			// the pieces of a line that ran that never did themselves (at least three characters that are not blank)
			for (let i = first; i < line.length;) {
				if (hit[at + i] || !zero[at + i]) { i++; continue; }
				let j = i;
				while (j < line.length && !hit[at + j] && zero[at + j]) j++;
				const piece = line.slice(i, j).trim();
				if (piece.replace(/[\s)\]};,]/g, "").length >= 3) out.push(`${n + 1}:${i + 1}: … ${piece.slice(0, 100)}`);
				i = j;
			}
		}
		at += line.length + 1;
	});
	console.log(`${file}: ${seen ? `${out.length} ${spans ? "lines and pieces" : "lines"} never run` : "never loaded"}`);
	for (const l of out) console.log(`  ${l}`);
}
