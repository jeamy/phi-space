// The mobile sieve scenario (test/testbed/scenarios/sieve-mobile.ts) as a regression test: small, fast, real storage.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./testbed/scenarios/sieve-mobile.ts", import.meta.url).pathname;
const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", script, ...args], { encoding: "utf8", timeout: 90_000 });

test("sieve-mobile: create, run and evaluate pass with lost calls, dying workers and a host restart", () => {
	const dir = mkdtempSync(join(tmpdir(), "sieve-mobile-"));
	try {
		const small = ["--dir", dir, "--end", "401", "--block", "64", "--work-ms", "20", "--offline-ms", "150", "--lease-ms", "300", "--drop", "0.5"];
		for (const phase of [["create"], ["run", "--host-restart"], ["evaluate"]]) {
			const r = run(...phase, ...small);
			assert.equal(r.status, 0, `${phase[0]} failed:\n${r.stdout}\n${r.stderr}`);
		}
		const e = run("evaluate", ...small);
		assert.match(e.stdout, /RESULT: PASSED/);
		assert.match(e.stdout, /78 primes/); // pi(400) = 78
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sieve-mobile: usage errors and a missing run are reported, not ignored", () => {
	const dir = mkdtempSync(join(tmpdir(), "sieve-mobile-"));
	try {
		assert.equal(run("evaluate", "--dir", dir).status, 1);
		assert.equal(run("create", "--bogus").status, 2);
		assert.equal(run("create", "--dir", dir, "--end", "5", "--start", "9").status, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
