import test from "node:test";
import assert from "node:assert/strict";
import { persistentSpaceLimits } from "../server/space-host.ts";

const MiB = 1024 * 1024;

test("persistent capacity leaves admission headroom above the formerly full 512 MiB claim history", () => {
	const limits = persistentSpaceLimits({});
	assert.deepEqual(limits, { maxClaimBytes: 1024 * MiB, maxDocBytes: 1280 * MiB });
	const existingClaims = 536_792_567, requestAndResult = 2 * 64 * 1024;
	assert.ok(existingClaims + requestAndResult > 512 * MiB);
	assert.ok(existingClaims + requestAndResult < limits.maxClaimBytes);
	assert.ok(limits.maxDocBytes > limits.maxClaimBytes);
});

test("persistent claim and document capacities accept operator overrides and blank defaults", () => {
	assert.deepEqual(persistentSpaceLimits({ CODEMODE_MAX_CLAIM_MIB: " 768 ", CODEMODE_MAX_DOC_MIB: "1024" }),
		{ maxClaimBytes: 768 * MiB, maxDocBytes: 1024 * MiB });
	assert.deepEqual(persistentSpaceLimits({ CODEMODE_MAX_CLAIM_MIB: " ", CODEMODE_MAX_DOC_MIB: "" }), persistentSpaceLimits({}));
});

test("invalid or inconsistent persistent capacities fail closed", () => {
	for (const value of ["0", "-1", "NaN", "Infinity", "1.5", String(Number.MAX_SAFE_INTEGER)]) {
		assert.throws(() => persistentSpaceLimits({ CODEMODE_MAX_CLAIM_MIB: value }), /CODEMODE_MAX_CLAIM_MIB/);
		assert.throws(() => persistentSpaceLimits({ CODEMODE_MAX_DOC_MIB: value }), /CODEMODE_MAX_DOC_MIB/);
	}
	assert.throws(() => persistentSpaceLimits({ CODEMODE_MAX_CLAIM_MIB: "1024", CODEMODE_MAX_DOC_MIB: "1024" }), /must exceed/);
	assert.throws(() => persistentSpaceLimits({ CODEMODE_MAX_CLAIM_MIB: "1280", CODEMODE_MAX_DOC_MIB: "1024" }), /must exceed/);
});
