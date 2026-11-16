#!/usr/bin/env node
// Projects built on phi-spaces (every top-level directory with its own package.json, except the agent package) import
// the library as the package `phi-spaces` and its exported subpaths, never relative paths into src/. Read-only, no
// dependencies; spaces-mmo/docs/paket.en.md (Phase P) explains the decision.
//
//   node checks/package-imports.mjs --check     exit 1 on a relative src/ import, an unexported subpath, a missing
//                                               export target, a linked phi-spaces that is not this checkout, or an
//                                               application that was not found
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { APPS, PACKAGE, REPO } from "./roots.mjs";
const EXT = /\.(ts|tsx|mts|mjs|js)$/;
const SKIP = /(^|\/)(node_modules|\.next|dist|\.local|evidence)(\/|$)/;
/** Projects that keep relative imports: the agent package reaches federation internals that are no public contract. */
const OWN = ["agent"];
/** Single files that may still import src/ relatively, each with its reason. */
const ALLOWED = {
	"help-site/examples/v5-federated-cluster/run.ts": "drives federation internals (router, entry replication) directly",
	"help-site/scripts/check-corpus-examples.ts": "writes import paths for a virtual file next to the root, as text",
};

const pkg = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
const exported = new Map(Object.entries(pkg.exports ?? {}).map(([k, v]) => [k === "." ? "phi-spaces" : `phi-spaces/${k.slice(2)}`, v]));
const projects = readdirSync(REPO).filter((d) => !d.startsWith(".") && d !== "node_modules" && !OWN.includes(d) && join(REPO, d) !== PACKAGE && existsSync(join(REPO, d, "package.json")));

function files(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name), rel = relative(REPO, p);
		if (SKIP.test(rel)) continue;
		if (statSync(p).isDirectory()) files(p, out);
		else if (EXT.test(name) && !name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

/** Module specifiers of static, side-effect, re-export and dynamic imports. */
function specsOf(text) {
	const out = [];
	for (const m of text.matchAll(/(?:^|\n|;)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g)) out.push(m[1]);
	for (const m of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
	for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
	return out;
}

const problems = [];
for (const [spec, target] of exported) if (typeof target !== "string" || !existsSync(join(PACKAGE, target))) problems.push(`package.json: export ${spec} -> ${target} does not exist`);
for (const app of APPS) if (!projects.includes(app)) problems.push(`${app}: not found as a project (no ${app}/package.json beside the package)`);
const linked = realpathSync(PACKAGE);
let scanned = 0;
for (const project of projects) {
	const link = join(REPO, project, "node_modules", "phi-spaces");
	if (existsSync(link) && realpathSync(link) !== linked) problems.push(`${project}/node_modules/phi-spaces is not this checkout's package (${realpathSync(link)})`);
	for (const f of files(join(REPO, project))) {
		const file = relative(REPO, f);
		scanned++;
		for (const spec of specsOf(readFileSync(f, "utf8"))) {
			if (spec.startsWith(".") && resolve(dirname(f), spec).startsWith(join(PACKAGE, "src") + "/") && !(file in ALLOWED)) problems.push(`${file}: relative import ${spec} (use phi-spaces)`);
			else if ((spec === "phi-spaces" || spec.startsWith("phi-spaces/")) && !exported.has(spec)) problems.push(`${file}: ${spec} is not exported by phi-spaces`);
		}
	}
}

if (process.argv.includes("--check")) {
	if (problems.length) { console.error(`phi-spaces package imports:\n${problems.map((p) => `  ${p}`).join("\n")}`); process.exit(1); }
	console.log(`phi-spaces imported as a package in ${projects.join(", ")} (${scanned} files, ${Object.keys(ALLOWED).length} allowed exceptions)`);
} else {
	console.log(problems.length ? problems.join("\n") : "no problems");
}
