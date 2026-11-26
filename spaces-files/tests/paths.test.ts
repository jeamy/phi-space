// Canonical paths, file contents, the request digest and the byte limits against the Space's limits
// (docs/zanzibar-agent-filesystem-plan.en.md, section 5, paths and contents; sections 3 and 6.2 for the digest).
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, FOREVER } from "phi-spaces/core";
import { checkContents, parsePath, pathString } from "../server/paths.ts";
import { contentDigest, requestDigest } from "../server/digest.ts";
import { assertLimitsFit, assertRowFits, DEFAULT_FS_LIMITS } from "../server/limits.ts";
import { audit, CapacityExceeded, content, InvalidInput, node, receipt } from "../server/schema.ts";
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

test("contents: bytes kept as given, bounded by maxFileBytes", () => {
	for (const b of [new Uint8Array(0), Buffer.from([0xef, 0xbb, 0xbf, 0x41]), Buffer.from([0xff, 0xfe, 0x00, 0xd8]), Buffer.from("Cafe\u0301")])
		assert.equal(checkContents(b), b, "any bytes, also invalid UTF-8");
	assert.throws(() => checkContents("text"), InvalidInput, "a string is not bytes");
	assert.throws(() => checkContents(7), InvalidInput);
	assert.equal(checkContents(new Uint8Array(10), { maxFileBytes: 10 }).length, 10);
	assert.throws(() => checkContents(new Uint8Array(11), { maxFileBytes: 10 }), CapacityExceeded);
});

test("the request digest: canonical arguments, operation name included, contents by their exact bytes", () => {
	const d = (op: string, args: Record<string, string | number>) => requestDigest(op, args);
	const path = (p: string) => pathString(parsePath(p, "write"));
	assert.equal(d("write", { path: path("Café"), v: 0 }), d("write", { path: path("Café"), v: 0 }), "two spellings of one name");
	assert.equal(d("write", { a: 1, b: "x" }), d("write", { b: "x", a: 1 }), "key order");
	assert.notEqual(d("write", { a: 1 }), d("mkdir", { a: 1 }), "the operation name");
	assert.notEqual(contentDigest(Buffer.from("Cafe\u0301")), contentDigest(Buffer.from("Caf\u00e9")), "contents are not normalized");
	assert.equal(contentDigest(new Uint8Array([1, 2])), contentDigest(Buffer.from([1, 2])));
	assert.match(contentDigest(new Uint8Array(0)), /^[0-9a-f]{64}$/);
	assert.match(d("write", {}), /^[0-9a-f]{64}$/);
});

test("the limits fit the Space's limits in their worst case, and rows are measured exactly", async () => {
	assertLimitsFit(L, DEFAULT_LIMITS);
	assert.throws(() => assertLimitsFit({ ...L, maxListPage: 100_000 }, DEFAULT_LIMITS), /directory listing/);
	assertLimitsFit({ ...L, maxDirEntries: 4096 }, DEFAULT_LIMITS); // a directory larger than one reply is listed by pages
	assert.throws(() => assertLimitsFit(L, { ...DEFAULT_LIMITS, maxCommitBytes: 3 * 1024 }), /a save/);
	assert.throws(() => assertLimitsFit({ ...L, maxTenantBytes: 62 * 1024 * 1024 }, DEFAULT_LIMITS), /audit reserve/);
	assert.throws(() => assertLimitsFit({ ...L, maxFileBytes: L.maxContentBytes + 1 }, DEFAULT_LIMITS), /content quota/);
	await assert.rejects(FilesService.open({ dataDir: null, stateDir: null, blobDir: null, limits: { maxFileBytes: 2 * L.maxContentBytes } }), /content quota/);
	// contents are not rows: a file far beyond the Space's entry limit is allowed
	assert.ok(L.maxFileBytes > DEFAULT_LIMITS.maxEntryBytes);
	assert.throws(() => assertRowFits({ text: "\u0007".repeat(DEFAULT_LIMITS.maxEntryBytes / 6 + 1) }, DEFAULT_LIMITS), CapacityExceeded);

	// a creating save in its worst case is one commit: a node with the longest name of quotes, its content row, a receipt
	// and an audit row
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	try {
		await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "s" });
		const ref = { blobId: "b".repeat(22), size: L.maxFileBytes, keyGeneration: 1 };
		const rows = [
			node("n".repeat(22), "p".repeat(22), '"'.repeat(L.maxNameBytes), "file"),
			content("n".repeat(22), 1, ref),
			receipt("agent", "a".repeat(128), "o".repeat(200), "d".repeat(64), { version: 1 }, Date.now()),
			audit(99, Date.now(), { kind: "agent", id: "a".repeat(128) }, "write", ["n".repeat(22)], "o".repeat(200), "ok"),
		];
		for (const r of rows) assertRowFits(r.fields, DEFAULT_LIMITS);
		const results = await s.inTenant("acme", (sp) => sp.batch([
			{ op: "begin" },
			...rows.map((entry) => ({ op: "write" as const, entry, txn: "$", lease: FOREVER })),
			{ op: "commit", txn: "$" },
		]));
		assert.equal(results.length, 6);
		assert.equal((await s.inTenant("acme", (sp) => sp.readIfExists({ type: "FsContent" }, 0)))?.fields.size, L.maxFileBytes);
	} finally { await s.close(); }
});
