// The .env loader: values already in the environment win over the file, comments and quotes are not part of a value.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../server/env.ts";

test("loadDotEnv keeps the environment and strips comments and quotes", () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-env-"));
	try {
		const file = join(dir, ".env");
		writeFileSync(file, "# comment\nFILES_TEST_A=\"one\" # note\nFILES_TEST_B=two\n");
		process.env.FILES_TEST_B = "kept";
		delete process.env.FILES_TEST_A;
		loadDotEnv(file);
		assert.equal(process.env.FILES_TEST_A, "one");
		assert.equal(process.env.FILES_TEST_B, "kept");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.FILES_TEST_A;
		delete process.env.FILES_TEST_B;
	}
});
