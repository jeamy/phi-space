#!/usr/bin/env node
// Which files depend on @earendil-works/pi-durable (and @earendil-works/chord, which comes with it): directly, with the
// names they import, and transitively through the files they import. The inventory of work package U0 in
// docs/umstellung-ohne-pi-durable.md; read-only, no dependencies.
//
//   node scripts/durable-imports.mjs            a markdown report
//   node scripts/durable-imports.mjs --json     the same as JSON
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "examples", "test", "scripts", "codemode-chat/server", "codemode-chat/tests", "codemode-chat/app", "codemode-chat/client", "help-site"];
const EXT = /\.(ts|tsx|mts|mjs|js)$/;
const SKIP = /(^|\/)(node_modules|\.next|dist|\.local|evidence)(\/|$)/;
const PACKAGES = ["@earendil-works/pi-durable", "@earendil-works/chord"];

/** Every source file under the scanned directories. */
function files(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name), rel = relative(ROOT, p);
		if (SKIP.test(rel)) continue;
		if (statSync(p).isDirectory()) files(p, out);
		else if (EXT.test(name) && !name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

/** The imports of a file: static (import/export … from), side-effect and dynamic ones, with the names and whether
 *  the whole statement is type-only. */
function importsOf(text) {
	const found = [];
	const stmt = /(?:^|\n|;)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
	for (let m; (m = stmt.exec(text)); ) {
		const clause = m[3];
		const braces = /\{([\s\S]*?)\}/.exec(clause);
		const names = braces ? braces[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
		const star = /\*\s+as\s+(\w+)/.exec(clause), def = /^(\w+)\s*(,|$)/.exec(clause.trim());
		if (star) names.push(`* as ${star[1]}`);
		else if (def && def[1] !== "type") names.push(`default as ${def[1]}`);
		if (/^\*$/.test(clause.trim())) names.push("*");
		found.push({ spec: m[4], names, typeOnly: !!m[2] || (names.length > 0 && names.every((n) => n.startsWith("type "))) });
	}
	for (const m of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) found.push({ spec: m[1], names: [], typeOnly: false });
	for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) found.push({ spec: m[1], names: ["(dynamic)"], typeOnly: false });
	return found;
}

/** A relative import resolved to a scanned file (TypeScript may name .ts as .js). */
function resolveSpec(from, spec) {
	if (!spec.startsWith(".")) return null;
	const base = resolve(dirname(from), spec);
	for (const c of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return c;
	return null;
}

const all = DIRS.flatMap((d) => files(join(ROOT, d)));
const graph = new Map(); // file -> { direct: Map<package subpath, {names, typeOnly}>, local: Set<file> }
for (const f of all) {
	const text = readFileSync(f, "utf8"), direct = new Map(), local = new Set();
	for (const i of importsOf(text)) {
		const pkg = PACKAGES.find((p) => i.spec === p || i.spec.startsWith(`${p}/`));
		if (pkg) {
			const cur = direct.get(i.spec) ?? { names: new Set(), typeOnly: true };
			for (const n of i.names) cur.names.add(n.replace(/^type\s+/, "type "));
			cur.typeOnly &&= i.typeOnly;
			direct.set(i.spec, cur);
			continue;
		}
		const r = resolveSpec(f, i.spec);
		if (r) local.add(r);
	}
	graph.set(f, { direct, local });
}

// transitive: a file depends on the packages when it imports (at any depth) a file that imports them directly
const reaches = new Map();
const visit = (f, stack = new Set()) => {
	if (reaches.has(f)) return reaches.get(f);
	if (stack.has(f)) return null; // a cycle: decided by the rest of the walk
	stack.add(f);
	const g = graph.get(f);
	let via = g.direct.size ? f : null;
	if (!via) for (const l of g.local) { if (graph.has(l) && visit(l, stack)) { via = l; break; } }
	stack.delete(f);
	reaches.set(f, via);
	return via;
};
for (const f of all) visit(f);

const rel = (f) => relative(ROOT, f);
const direct = all.filter((f) => graph.get(f).direct.size).map((f) => ({
	file: rel(f),
	imports: [...graph.get(f).direct].map(([spec, v]) => ({ spec, names: [...v.names].sort(), typeOnly: v.typeOnly })),
}));
const transitive = all.filter((f) => !graph.get(f).direct.size && reaches.get(f)).map((f) => ({ file: rel(f), via: rel(reaches.get(f)) }));
const symbols = new Map();
for (const d of direct) for (const i of d.imports) for (const n of i.names) { const k = `${i.spec} ${n.replace(/^type /, "")}`; symbols.set(k, (symbols.get(k) ?? 0) + 1); }
const area = (f) => f.split("/").slice(0, f.startsWith("codemode-chat/") ? 2 : 1).join("/");
const count = (list) => Object.entries(list.reduce((a, x) => ((a[area(x.file)] = (a[area(x.file)] ?? 0) + 1), a), {})).sort();

if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ scanned: all.length, direct, transitive, symbols: Object.fromEntries([...symbols].sort()) }, null, 2));
} else {
	const out = [];
	out.push(`Scanned ${all.length} files in ${DIRS.join(", ")}.`, "");
	out.push(`Direct importers: ${direct.length} (${count(direct).map(([a, n]) => `${a} ${n}`).join(", ")}).`);
	out.push(`Transitive only: ${transitive.length} (${count(transitive).map(([a, n]) => `${a} ${n}`).join(", ")}).`, "");
	out.push("## Imported names (number of files)", "");
	for (const [k, n] of [...symbols].sort()) out.push(`- \`${k}\` ${n}`);
	out.push("", "## Direct importers", "");
	for (const d of direct) out.push(`- \`${d.file}\`: ${d.imports.map((i) => `${i.spec}${i.typeOnly ? " (types only)" : ""} { ${i.names.join(", ")} }`).join("; ")}`);
	out.push("", "## Transitive importers (through)", "");
	for (const t of transitive) out.push(`- \`${t.file}\` ← \`${t.via}\``);
	console.log(out.join("\n"));
}
