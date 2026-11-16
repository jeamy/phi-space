#!/usr/bin/env node
// The core of phi-spaces knows nothing of the applications built on it (docs/umstellung-verzeichnisse.en.md): no file
// of the package (src/, test/, scripts/, agent/, examples/, the Rust core crates rust/phi-*, the manifests) imports or
// names a path of spaces-mmo, codemode-chat or the help site outside a comment, and in Cargo's resolved graph no core
// crate depends on an application crate (normal, build or dev). Comments may cite an application as a reason.
// Read-only, no dependencies; needs cargo on the PATH for the graph.
//
//   node checks/layering.mjs     exit 1 on a reference, a dependency, a scanned path that is missing, or no cargo
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { APPS, PACKAGE, REPO } from "./roots.mjs";

/** The package's directories (from the package root) and the manifests in it that are scanned. */
const DIRS = ["src", "test", "scripts", "agent", "examples"];
const RUST = join(PACKAGE, "rust");
const MANIFESTS = ["package.json", "tsconfig.json", "tsconfig.build.json", "rust/Cargo.toml"];
/** Files that may still name an application, each with its reason (paths from the package root). Phase 3 empties it. */
const ALLOWED = {
	"package.json": "the scripts that start and test the applications; phase 3 moves them to the thin root manifest (D3)",
	"rust/Cargo.toml": "the one workspace still holds the application crates and their dev profile; phase 3 splits it (D1)",
};
const EXT = /\.(ts|tsx|mts|mjs|js|json|rs|toml|sh|ya?ml)$/;
const SKIP = /(^|\/)(node_modules|target|\.next|dist|\.local|evidence)(\/|$)/;
const NAMES = new RegExp(`(?<![\\w.-])(${APPS.map((a) => a.replace(/[-]/g, "\\-")).join("|")})(?![\\w-])`, "g");

const problems = [];
const core = [...DIRS, ...(existsSync(RUST) ? readdirSync(RUST).filter((d) => d.startsWith("phi-")).map((d) => `rust/${d}`) : [])];
for (const d of [...DIRS, ...MANIFESTS]) if (!existsSync(join(PACKAGE, d))) problems.push(`${d}: not found in the package`);
if (!core.some((d) => d.startsWith("rust/"))) problems.push("rust/phi-*: no Rust core crate found");

function files(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (SKIP.test(relative(PACKAGE, p).split(sep).join("/"))) continue;
		if (statSync(p).isDirectory()) files(p, out);
		else if (EXT.test(name) || name.startsWith("Dockerfile")) out.push(p);
	}
	return out;
}

/** The text without its comments: line and block comments in code, `#` in shell, TOML and YAML. JSON has none. Strings that
 *  hold `//` (URLs) keep it, as the lookbehind leaves `://` alone. */
function code(text, name) {
	if (/\.(sh|toml|ya?ml)$/.test(name) || name.startsWith("Dockerfile")) return text.replace(/(^|\s)#.*$/gm, "$1");
	if (name.endsWith(".json")) return text;
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

let scanned = 0;
const paths = [...core.filter((d) => existsSync(join(PACKAGE, d))).flatMap((d) => files(join(PACKAGE, d))), ...MANIFESTS.map((m) => join(PACKAGE, m)).filter(existsSync)];
for (const f of paths) {
	const file = relative(PACKAGE, f).split(sep).join("/");
	scanned++;
	if (file in ALLOWED) continue;
	const lines = code(readFileSync(f, "utf8"), f.split("/").pop()).split("\n");
	for (const [i, line] of lines.entries()) {
		const found = line.match(NAMES);
		if (found) problems.push(`${relative(REPO, f)}:${i + 1}: names ${[...new Set(found)].join(", ")}`);
	}
}

// Cargo's resolved graph: the core crates are the packages under rust/phi-*, every other workspace member is an
// application crate; no dependency of any kind may lead from the one to the other.
let metadata;
try {
	metadata = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--offline", "--manifest-path", join(RUST, "Cargo.toml")], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
} catch (e) {
	problems.push(`cargo metadata failed (cargo on the PATH, the lockfile current?): ${String(e.stderr || e.message).trim().split("\n").at(-1)}`);
}
let crates = 0;
if (metadata) {
	const inCore = (p) => relative(RUST, p.manifest_path).split(sep)[0].startsWith("phi-");
	const members = new Set(metadata.workspace_members);
	const byId = new Map(metadata.packages.map((p) => [p.id, p]));
	const coreIds = new Set(metadata.packages.filter((p) => members.has(p.id) && inCore(p)).map((p) => p.id));
	const appIds = new Set(metadata.packages.filter((p) => members.has(p.id) && !inCore(p)).map((p) => p.id));
	crates = coreIds.size;
	for (const node of metadata.resolve.nodes) {
		if (!coreIds.has(node.id)) continue;
		for (const dep of node.deps) {
			if (!appIds.has(dep.pkg)) continue;
			const kinds = dep.dep_kinds.map((k) => k.kind ?? "normal").join("/");
			problems.push(`${byId.get(node.id).name} depends on the application crate ${byId.get(dep.pkg).name} (${kinds})`);
		}
	}
	if (!crates) problems.push("cargo metadata: no core crate under rust/phi-*");
}

if (problems.length) {
	console.error(`the core names an application:\n${problems.map((p) => `  ${p}`).join("\n")}`);
	process.exit(1);
}
console.log(`the core names no application (${scanned} files, ${crates} core crates, ${Object.keys(ALLOWED).length} allowed until phase 3)`);
