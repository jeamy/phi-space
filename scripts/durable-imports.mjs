#!/usr/bin/env node
// Which files depend on @earendil-works/pi-durable (and @earendil-works/chord, which comes with it, and pi-ai, which
// only agents need): directly, with the names they import, and transitively through the files they import. The
// inventory of work package U0 in docs/umstellung-ohne-pi-durable.md, now also its guard; read-only, no dependencies.
//
//   node scripts/durable-imports.mjs            a markdown report
//   node scripts/durable-imports.mjs --json     the same as JSON
//   node scripts/durable-imports.mjs --check    exit 1 when a file outside ALLOWED depends on them
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "examples", "test", "scripts", "codemode-chat/server", "codemode-chat/tests", "codemode-chat/app", "codemode-chat/client", "help-site"];
const EXT = /\.(ts|tsx|mts|mjs|js)$/;
const SKIP = /(^|\/)(node_modules|\.next|dist|\.local|evidence)(\/|$)/;
const PACKAGES = ["@earendil-works/pi-durable", "@earendil-works/chord", "@earendil-works/pi-ai"];
/** Where these packages may still be used, directly or not (U6–U8 shrink this list to the agent package). */
const ALLOWED = [
	"src/agent.ts", "src/with-agent.ts", "test/agent-integration.test.ts", // the agent package (U6)
	"examples/", "test/examples/", "test/testbed/", "help-site/", "scripts/spike-durable.ts", // tools and examples (U8)
];
/** pi-ai alone (models, no durable store) is also allowed here: the chat calls models itself. */
const ALLOWED_PI_AI = ["codemode-chat/"];

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

if (process.argv.includes("--check")) {
	// the packages each file reaches, directly or through the files it imports
	const reached = new Map();
	const packagesOf = (f, stack = new Set()) => {
		if (reached.has(f)) return reached.get(f);
		const out = new Set();
		if (stack.has(f)) return out; // a cycle: the rest of the walk decides
		stack.add(f);
		const g = graph.get(f);
		for (const spec of g.direct.keys()) out.add(PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`)));
		for (const l of g.local) if (graph.has(l)) for (const p of packagesOf(l, stack)) out.add(p);
		stack.delete(f);
		reached.set(f, out);
		return out;
	};
	const within = (f, list) => list.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a));
	const outside = [];
	for (const f of all) {
		const file = rel(f), pkgs = [...packagesOf(f)];
		if (!pkgs.length || within(file, ALLOWED)) continue;
		const durable = pkgs.filter((p) => !p.endsWith("/pi-ai"));
		if (durable.length || !within(file, ALLOWED_PI_AI)) outside.push(`${file}: ${pkgs.join(", ")}`);
	}
	if (outside.length) { console.error(`pi-durable, chord or pi-ai outside the allowed files:\n${outside.map((f) => `  ${f}`).join("\n")}`); process.exit(1); }
	console.log(`no pi-durable, chord or pi-ai outside the allowed paths (${direct.length + transitive.length} files inside them)`);
} else if (process.argv.includes("--json")) {
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
