// fileCredentialStore (src/live-models.ts): the credentials of a process that logs in, in a file of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentialStore } from "../src/live-models.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "phi-cred-"));

test("the file is created with mode 600 in a directory of mode 700, filled once from the seed, the seed never written", async () => {
	const root = scratch();
	try {
		const seed = join(root, "auth.json");
		writeFileSync(seed, JSON.stringify({ anthropic: { type: "api_key", key: "seed-key" } }));
		const file = join(root, "auth", "credentials.json");
		const s = fileCredentialStore(file, { seedFrom: seed });
		assert.equal(statSync(join(root, "auth")).mode & 0o777, 0o700);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(await s.read("anthropic"), { type: "api_key", key: "seed-key" });
		await s.modify("openai", async () => ({ type: "api_key", key: "new-key" }));
		assert.deepEqual(JSON.parse(readFileSync(seed, "utf8")), { anthropic: { type: "api_key", key: "seed-key" } }, "the seed stays as it was");
		// a second start reads the file, not the seed
		writeFileSync(seed, JSON.stringify({ other: { type: "api_key", key: "later" } }));
		const again = fileCredentialStore(file, { seedFrom: seed });
		assert.deepEqual((await again.list()).map((c) => c.providerId).sort(), ["anthropic", "openai"]);
		await again.delete("anthropic");
		assert.equal(await fileCredentialStore(file, { seedFrom: null }).read("anthropic"), undefined);
		assert.deepEqual(readdirSync(join(root, "auth")), ["credentials.json"], "no temporary file is left");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("writes of one provider are serialized: the second sees the first's result", async () => {
	const root = scratch();
	try {
		const file = join(root, "c.json");
		const s = fileCredentialStore(file, { seedFrom: null });
		await s.modify("p", async () => ({ type: "oauth", access: "a0", refresh: "r0", expires: 0 }));
		const seen: string[] = [];
		const refresh = (s.modify("p", async (cur) => { seen.push(String((cur as { access: string }).access)); await new Promise((r) => setTimeout(r, 30)); return { type: "oauth", access: "a1", refresh: "r1", expires: 1 }; }));
		const second = s.modify("p", async (cur) => { seen.push(String((cur as { access: string }).access)); return undefined; });
		await Promise.all([refresh, second]);
		assert.deepEqual(seen, ["a0", "a1"]);
		assert.equal((JSON.parse(readFileSync(file, "utf8")) as Record<string, { access: string }>).p!.access, "a1", "the refreshed token is on the disk");
		// a failing write leaves the old value and does not stop the next one
		await assert.rejects(s.modify("p", async () => { throw new Error("refresh failed"); }), /refresh failed/);
		assert.equal(((await s.read("p")) as { access: string }).access, "a1");
		await s.modify("p", async () => ({ type: "api_key", key: "k" }));
		assert.equal(((await s.read("p")) as { key: string }).key, "k");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
