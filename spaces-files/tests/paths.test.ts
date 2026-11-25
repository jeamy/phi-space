// Canonical paths, text, the request digest and the byte limits against the Space's limits
// (docs/zanzibar-agent-filesystem-plan.en.md, section 5, paths and text; sections 3 and 6.2 for the digest).
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, FOREVER } from "phi-spaces/core";
import { checkText, parsePath, pathString } from "../server/paths.ts";
import { requestDigest } from "../server/digest.ts";
import { assertLimitsFit, assertRowFits, DEFAULT_FS_LIMITS, encodedBytes } from "../server/limits.ts";
import { CapacityExceeded, content, InvalidInput } from "../server/schema.ts";
import { FilesService } from "../server/service.ts";

const L = DEFAULT_FS_LIMITS;

test("paths: canonical segments, and every malformed form refused", () => {
	const ok: Array<[string, string, string[]]> = [
		["list", ".", []],
		["read", "a", ["a"]],
		["read", "a/b c/d.md", ["a", "b c", "d.md"]],
		["read", "Café/x", ["Café", "x"]],      // NFC
		["read", "A/a", ["A", "a"]],                       // case-sensitive
		["read", ".hidden/..x", [".hidden", "..x"]],       // dots inside names are names
		["grant", ".", []], ["revoke", ".", []], ["listGrants", ".", []], ["maintenancePutGrant", ".", []],
	];
	for (const [op, p, want] of ok) assert.deepEqual(parsePath(p, op), want, `${op} ${JSON.stringify(p)}`);
	const bad: Array<[string, string | unknown, typeof InvalidInput | typeof CapacityExceeded]> = [
		["read", ".", InvalidInput], ["write", ".", InvalidInput], ["mkdir", ".", InvalidInput],
		["read", "", InvalidInput], ["read", "/a", InvalidInput], ["read", "a/", InvalidInput], ["read", "a//b", InvalidInput],
		["read", "./a", InvalidInput], ["read", "a/.", InvalidInput], ["read", "a/../b", InvalidInput], ["read", "..", InvalidInput],
		["read", "a\\b", InvalidInput], ["read", "a\nb", InvalidInput], ["read", "a\u0000", InvalidInput], ["read", "a\u007f", InvalidInput],
		["read", "a\ud800", InvalidInput], ["read", 42, InvalidInput], ["read", null, InvalidInput],
		["read", Array(L.maxPathDepth + 1).fill("a").join("/"), CapacityExceeded],
		["read", "x".repeat(L.maxNameBytes + 1), CapacityExceeded],
		["read", "a/".repeat(2048) + "a", CapacityExceeded],
	];
	for (const [op, p, err] of bad) assert.throws(() => parsePath(p, op), err, `${op} ${JSON.stringify(p)}`);
	assert.deepEqual(parsePath(Array(L.maxPathDepth).fill("a").join("/"), "read").length, L.maxPathDepth);
	assert.deepEqual(parsePath("é".repeat(L.maxNameBytes / 2 - 0.5 | 0), "read").length, 1, "a name at its byte limit");
	assert.equal(pathString(["a", "b"]), "a/b");
	assert.equal(pathString([]), ".");
});

test("text: kept verbatim, well-formed only, bounded in UTF-8 bytes", () => {
	for (const t of ["", "﻿BOM", "tab\there\r\n", "\u0000\u0007", "Café", "😀"]) assert.equal(checkText(t), t);
	assert.notEqual(checkText("Café"), "Café", "text is not normalized");
	assert.throws(() => checkText("a\udc00"), InvalidInput);
	assert.throws(() => checkText(7), InvalidInput);
	assert.equal(checkText("x".repeat(L.maxTextBytes)).length, L.maxTextBytes);
	assert.throws(() => checkText("x".repeat(L.maxTextBytes + 1)), CapacityExceeded);
	assert.throws(() => checkText("é".repeat(L.maxTextBytes / 2 + 1)), CapacityExceeded, "measured in bytes, not characters");
});

test("the request digest: canonical arguments, operation name included, text verbatim", () => {
	const d = (op: string, args: Record<string, string | number>) => requestDigest(op, args);
	const path = (p: string) => pathString(parsePath(p, "write"));
	assert.equal(d("write", { path: path("Café"), v: 0 }), d("write", { path: path("Café"), v: 0 }), "two spellings of one name");
	assert.equal(d("write", { a: 1, b: "x" }), d("write", { b: "x", a: 1 }), "key order");
	assert.notEqual(d("write", { a: 1 }), d("mkdir", { a: 1 }), "the operation name");
	assert.notEqual(d("write", { text: "Café" }), d("write", { text: "Café" }), "text is not normalized");
	assert.match(d("write", {}), /^[0-9a-f]{64}$/);
});

test("the limits fit the Space's limits in their worst case, and rows are measured exactly", async () => {
	assertLimitsFit(L, DEFAULT_LIMITS);
	assert.throws(() => assertLimitsFit({ ...L, maxTextBytes: 11 * 1024 }, DEFAULT_LIMITS), /FsContent row/);
	assert.throws(() => assertLimitsFit({ ...L, maxDirEntries: 100_000 }, DEFAULT_LIMITS), /directory listing/);
	assert.throws(() => assertLimitsFit(L, { ...DEFAULT_LIMITS, maxCommitBytes: 100 * 1024 }), /a save/);

	// the worst text at the limit: only control characters, each six bytes of JSON
	const worst = checkText("\u0007".repeat(L.maxTextBytes));
	const row = content("n".repeat(22), 1, worst);
	assert.ok(encodedBytes(row.fields) > 6 * L.maxTextBytes);
	assertRowFits(row.fields, DEFAULT_LIMITS);
	assert.throws(() => assertRowFits({ text: "\u0007".repeat(DEFAULT_LIMITS.maxEntryBytes / 6 + 1) }, DEFAULT_LIMITS), CapacityExceeded);
	// and the Space takes it
	const s = await FilesService.open({ dataDir: null, stateDir: null });
	try {
		await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "s" });
		await s.inTenant("acme", (sp) => sp.write(row, null, FOREVER));
	} finally { await s.close(); }
});
