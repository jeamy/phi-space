#!/usr/bin/env node
// The core of phi-spaces knows nothing of the applications built on it (docs/umstellung-verzeichnisse.en.md): no file
// of the package in spaces/ (src/, test/, scripts/, agent/, examples/, the Rust core crates rust/phi-*, the manifests)
// imports or names a path of spaces-mmo, codemode-chat or the help site outside a comment, and in Cargo's resolved graph
// no core crate depends on a crate outside the core workspace but from a registry (normal, build or dev). Comments may
// cite an application as a reason. The applications' own Cargo workspaces (<app>/rust, D1) resolve from their lockfiles
// (--locked) and share the core workspace's package fields, dependencies and release profile, and a registry crate the
// core resolves too resolves there to none of another version, so a core crate builds the same inside an application.
// Read-only, no dependencies; needs cargo on the PATH for the graphs.
//
//   node checks/layering.mjs     exit 1 on a reference, a dependency, a drifted application workspace, a scanned path
//                                that is missing, or no cargo
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { APPS, PACKAGE, REPO } from "./roots.mjs";

/** The package's directories (from the package root) and the manifests in it that are scanned. */
const DIRS = ["src", "test", "scripts", "agent", "examples"];
const RUST = join(PACKAGE, "rust");
const MANIFESTS = ["package.json", "tsconfig.json", "tsconfig.build.json", "rust/Cargo.toml"];
/** Files that may still name an application, each with its reason (paths from the package root). Empty since phase 3. */
const ALLOWED = {};
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

// Cargo's resolved graphs. The core crates are the core workspace's members; a dependency of one without a registry
// source (a path or git dependency) must be one of them.
function metadataOf(manifest) {
	try {
		return JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--offline", "--manifest-path", manifest], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }));
	} catch (e) {
		problems.push(`${relative(REPO, manifest)}: cargo metadata failed (cargo on the PATH, the lockfile there and current?): ${String(e.stderr || e.message).trim().split("\n").at(-1)}`);
	}
}
const registry = (p) => typeof p.source === "string" && p.source.startsWith("registry+");
/** name -> sorted versions of the registry crates a graph resolves. */
function versions(metadata) {
	const out = new Map();
	for (const p of metadata.packages) if (registry(p)) out.set(p.name, [...new Set([...(out.get(p.name) ?? []), p.version])].sort());
	return out;
}
/** The sections of a workspace manifest an application workspace copies from the core's, without comments. */
function shared(manifest) {
	const text = readFileSync(manifest, "utf8").replace(/(^|\s)#.*$/gm, "$1");
	return ["workspace.package", "workspace.dependencies", "profile.release"].map((name) => {
		const m = text.match(new RegExp(`^\\[${name.replace(".", "\\.")}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"));
		return [name, m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n") : null];
	});
}

let crates = 0, apps = 0;
const metadata = metadataOf(join(RUST, "Cargo.toml"));
if (metadata) {
	const members = new Set(metadata.workspace_members);
	const byId = new Map(metadata.packages.map((p) => [p.id, p]));
	crates = members.size;
	for (const id of members) if (!relative(RUST, byId.get(id).manifest_path).startsWith("phi-")) problems.push(`${relative(REPO, byId.get(id).manifest_path)}: a core workspace member outside rust/phi-*`);
	for (const node of metadata.resolve.nodes) {
		if (!members.has(node.id)) continue;
		for (const dep of node.deps) {
			const target = byId.get(dep.pkg);
			if (members.has(dep.pkg) || registry(target)) continue;
			const kinds = dep.dep_kinds.map((k) => k.kind ?? "normal").join("/");
			problems.push(`${byId.get(node.id).name} depends on ${target.name} outside the core (${relative(REPO, target.manifest_path)}, ${kinds})`);
		}
	}
	if (!crates) problems.push("cargo metadata: no core crate under rust/phi-*");
	const core = versions(metadata), coreShared = new Map(shared(join(RUST, "Cargo.toml")));
	for (const app of APPS) {
		const manifest = join(REPO, app, "rust", "Cargo.toml");
		if (!existsSync(manifest)) continue;
		apps++;
		for (const [name, body] of shared(manifest)) if (body !== coreShared.get(name)) problems.push(`${app}/rust/Cargo.toml: [${name}] differs from the core workspace's`);
		const own = metadataOf(manifest);
		if (!own) continue;
		for (const [name, vs] of versions(own)) {
			const theirs = core.get(name);
			const other = theirs ? vs.filter((v) => !theirs.includes(v)) : [];
			if (other.length) problems.push(`${app}/rust/Cargo.lock: ${name} ${other.join(", ")}, the core resolves ${theirs.join(", ")}`);
		}
	}
	if (!apps) problems.push("no application Cargo workspace found (<app>/rust/Cargo.toml)");
}

if (problems.length) {
	console.error(`the core names an application:\n${problems.map((p) => `  ${p}`).join("\n")}`);
	process.exit(1);
}
console.log(`the core names no application (${scanned} files, ${crates} core crates, ${apps} application workspaces in step)`);
