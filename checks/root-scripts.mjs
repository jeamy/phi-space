#!/usr/bin/env node
// The root package.json is a thin manifest (docs/umstellung-verzeichnisse.en.md, D3): its scripts run the checks in
// checks/, forward to the package in spaces/ or start an application. This keeps each of them pointing at something
// that exists: a forward `npm --prefix <dir> run <name>` (or `start`, `test`) names a script of that directory's
// package.json; a script that runs the package's file directly from the root (so that relative paths in its arguments
// keep meaning the repository root) is the package's own script of the same name with `spaces/` before the file, and
// the file exists. Every script of the package except its `test` has a root script. Read-only, no dependencies.
//
//   node checks/root-scripts.mjs     exit 1 on a script that points nowhere or has drifted from the package's
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PACKAGE, PACKAGE_PREFIX, REPO } from "./roots.mjs";

const read = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};
const root = read(REPO);
const pkg = read(PACKAGE);
const pkgDir = relative(REPO, PACKAGE);
const problems = [];

for (const [name, command] of Object.entries(root)) {
	for (const part of command.split("&&").map((p) => p.trim())) {
		const forward = part.match(/^npm --prefix (\S+) (?:run (\S+)|(start|test))\b/);
		if (forward) {
			const [, dir, run, builtin] = forward;
			const target = run ?? builtin;
			if (!existsSync(join(REPO, dir, "package.json"))) problems.push(`${name}: ${dir}/package.json not found`);
			else if (!(target in read(join(REPO, dir)))) problems.push(`${name}: ${dir} has no script ${target}`);
			continue;
		}
		const file = part.split(/\s+/).slice(1).find((a) => !a.startsWith("-"));
		if (!file) { problems.push(`${name}: neither a forward nor a file: ${part}`); continue; }
		if (!file.includes("*") && !existsSync(join(REPO, file))) problems.push(`${name}: ${file} not found`);
		if (file.startsWith(PACKAGE_PREFIX) && pkgDir) {
			const own = part.replace(` ${PACKAGE_PREFIX}`, " ");
			if (!(name in pkg)) problems.push(`${name}: runs a file of ${pkgDir}/, which has no script of that name`);
			else if (pkg[name] !== own) problems.push(`${name}: drifted from ${pkgDir}/package.json (${JSON.stringify(pkg[name])})`);
		}
	}
}
for (const name of Object.keys(pkg)) if (name !== "test" && !(name in root)) problems.push(`${pkgDir}/package.json ${name}: no root script`);
if (!pkgDir) problems.push("the package is the repository root: nothing to forward to (checks/roots.mjs)");

if (problems.length) {
	console.error(`the root scripts point nowhere:\n${problems.map((p) => `  ${p}`).join("\n")}`);
	process.exit(1);
}
console.log(`the root scripts reach their targets (${Object.keys(root).length} scripts, ${Object.keys(pkg).length} in ${pkgDir}/)`);
