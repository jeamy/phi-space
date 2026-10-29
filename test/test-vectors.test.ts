// R0 of docs/rust-portierung.md: the vectors in test/vectors/ are what a second implementation must reproduce. This test
// keeps them true of this one; when it fails, either the code broke the contract or the contract changed on purpose
// (then: node --experimental-strip-types test/vectors/build.ts --write, and docs/wire-protokoll.md follows).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { canonicalJson } from "../src/canonical.ts";
import { initialState } from "../src/core.ts";
import { issueGeneration } from "../src/claims.ts";
import { verifySignature } from "../src/auth.ts";
import { GrantVerifier, verifyDetached } from "../src/grants.ts";
import type { Json } from "../src/core.ts";
import { CHALLENGE, GRANT, T0, canonicalVectors, cryptoVectors, currentSchema, generationOf, grantBytes, loadStore, readStore, readVector, schemaOf, wireVectors } from "./vectors/build.ts";

const file = (name: string) => JSON.parse(readVector(name));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "phi-vec-")); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("canonical JSON, number form, key order, digests and sizes match canonical.json", () => {
	assert.deepEqual(canonicalVectors(), file("canonical.json"));
});

test("generations, proofs, grants and derived ids match crypto.json; P-256 signatures verify", () => {
	const want = file("crypto.json"), got = cryptoVectors() as Record<string, any>;
	// P-256 signatures are randomized: everything else is equal, those verify
	const strip = (v: Record<string, any>) => ({ ...v, proof: { ...v.proof, p256: "" }, grant: { ...v.grant, p256: "" } });
	assert.deepEqual(strip(got), strip(want));
	const { ed25519, p256 } = want.keys;
	for (const [algorithm, publicKey, sig] of [["ed25519", ed25519.publicKey, want.proof.ed25519], ["ecdsa-p256", p256.publicKey, want.proof.p256]] as const) {
		assert.ok(verifySignature({ algorithm, publicKey }, CHALLENGE, sig), `${algorithm} proof`);
		assert.ok(!verifySignature({ algorithm, publicKey }, { ...CHALLENGE, issuedAt: CHALLENGE.issuedAt + 1 }, sig), `${algorithm} proof of another challenge`);
	}
	for (const [algorithm, publicKey, sig] of [["ed25519", ed25519.publicKey, want.grant.ed25519], ["ecdsa-p256", p256.publicKey, want.grant.p256]] as const) {
		assert.ok(verifyDetached(algorithm, publicKey, grantBytes(GRANT as unknown as Json), sig), `${algorithm} grant bytes`);
		// the verifier builds the signed bytes itself: it accepts the vector's signature
		const verifier = new GrantVerifier({ authorityId: GRANT.authorityId, issuerHostId: GRANT.issuerHostId, publicKey, algorithm, now: () => T0 + 1_000 });
		const d = verifier.check({ grant: GRANT, algorithm, signature: sig }, { principal: GRANT.principal, roles: ["member", "admin"] }, { method: "read", space: "default" });
		assert.deepEqual(d.roles, ["member"]);
	}
});

test("issueGeneration still binds its records the way crypto.json describes", () => {
	const s = initialState();
	const key = "22".repeat(32);
	const g = issueGeneration(s, T0, { peerId: "local" }, { key });
	const [nonce] = g.generation.split(".");
	const rec = s.rpc!.generations[g.generation] as unknown as Json;
	assert.equal(g.generation, generationOf(key, nonce!, rec));
	// the key is used as text, not as the bytes its hex names
	assert.equal(g.generation.split(".")[1], createHmac("sha256", Buffer.from(key, "utf8")).update(canonicalJson({ nonce: nonce!, ...(rec as Record<string, Json>) })).digest("hex"));
});

test("the scripted service session answers as wire.json records", async () => {
	assert.deepEqual(await wireVectors(), file("wire.json"));
});

test("a store file loaded from store.sql opens and answers as store.expected.json; its schema is the current one", async () => {
	const d = tmp();
	const sql = readVector("store.sql");
	loadStore(sql, join(d, "old.sqlite"));
	assert.deepEqual(await readStore(join(d, "old.sqlite")), file("store.expected.json").steps);
	assert.deepEqual(await currentSchema(), schemaOf(sql));
});
