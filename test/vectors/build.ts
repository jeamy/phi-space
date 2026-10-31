// R0 of docs/rust-portierung.md: what a second implementation of phi-spaces must reproduce, computed by this one.
// test/test-vectors.test.ts checks the files in this directory against the code; a change that moves a vector is a
// change of the contract (docs/wire-protokoll.md) and is written anew on purpose:
//
//   node --experimental-strip-types test/vectors/build.ts --write
//
// canonical.json  canonical JSON, numbers, key order, digests, JSON sizes
// crypto.json     generations (HMAC), app-key proofs and grants (Ed25519, ECDSA P-256), derived ids
// wire.json       a scripted session against the space service: every call and its reply, random values replaced
// store.sql       a store file written by a session like wire.json, as SQL; store.expected.json what reading it answers
//
// A write changes only what changed: P-256 signatures that still verify and the store files stay (each new store has
// new random ids); --store writes the store files anew, and so does a change of the store's schema.
import { createECDH, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, digestJson } from "../../src/canonical.ts";
import { jsonBytes } from "../../src/json.ts";
import { signedBytes, verifySignature, type Challenge } from "../../src/auth.ts";
import { verifyDetached } from "../../src/grants.ts";
import { hashToken, keyFingerprint } from "../../src/enroll.ts";
import { principalId } from "../../src/mailbox.ts";
import { argHash } from "../../src/claims.ts";
import { rpcDomain } from "../../src/rpc-domain.ts";
import type { Call } from "../../src/service.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { SpaceService, wellFormed, StaticIdentity, type Reply } from "../../src/service.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import type { ClosableStoreHost } from "../../src/store/types.ts";
import type { Json } from "../../src/core.ts";

export const DIR = fileURLToPath(new URL(".", import.meta.url));
/** The clock of every scripted session: a fixed start, moved only by the script. */
export const T0 = 1_700_000_000_000;

// ---- canonical JSON

/** Inputs as JSON text: what both sides parse before they encode. */
const CANONICAL_INPUTS = [
	"null", "true", "false", "0", "-0", "1", "-1", "1.5", "0.1", "1e21", "1e20", "123456789012345680000", "1e-6", "1e-7", "1.5e-7",
	"9007199254740991", "9007199254740993", "-9007199254740991", "5e-324", "1.7976931348623157e308", "100", "1E2", "0.000001",
	'""', '"a"', '"\\u0000\\u001f"', '"\\"\\\\/\\b\\f\\n\\r\\t"', '"\\u007f"', '"\\u2028\\u2029"', '"é€😀"', '"\\ud83d\\ude00"',
	"[]", "[1,[2,[3]]]", "{}", '{"b":1,"a":2}', '{"a":{"d":[{"z":1,"y":2}],"c":null}}',
	// UTF-16 order: "😀" (the surrogates 0xD83D 0xDE00) sorts before "\ue000" and "\uffff"; by code point or UTF-8 bytes it would sort after them
	'{"😀":1,"\\uffff":2,"\\ue000":3,"é":4,"z":5,"A":6,"":7,"aa":8,"a":9}',
	'{"x":-0,"y":[0.30000000000000004,1e-7,2e21]}',
	// JSON.parse puts array-index keys (0 to 2^32 - 2, no leading zero) first, ascending; the rest keep their order. This
	// is the order of JSON.stringify (jsonText, jsonBytes, the wire), not of the canonical form
	'{"b":1,"2":2,"1":3,"a":4,"01":5,"4294967295":6,"4294967294":7,"-1":8,"0":9}',
	// a repeated key: the last value, at the place of the first
	'{"a":1,"b":2,"a":3}',
];
/** Doubles by their bits (big-endian hex), for the number form alone: what JSON text cannot pin down (NaN, Infinity). */
const NUMBER_BITS = [
	"0000000000000000", "8000000000000000", "3ff0000000000000", "3fd3333333333334", "3fb999999999999a", "4415af1d78b58c40",
	"444b1ae4d6e2ef50", "3eb0c6f7a0b5ed8d", "3e7ad7f29abcaf48", "433fffffffffffff", "4340000000000000", "0000000000000001",
	"7fefffffffffffff", "c08f400000000000", "7ff0000000000000", "fff0000000000000", "7ff8000000000000",
];
const fromBits = (hex: string): number => Buffer.from(hex, "hex").readDoubleBE(0);

export function canonicalVectors(): Record<string, unknown> {
	const values = CANONICAL_INPUTS.map((input) => {
		const v = JSON.parse(input) as Json;
		return { input, canonical: canonicalJson(v), sha256: digestJson(v), jsonBytes: jsonBytes(v), jsonText: JSON.stringify(v) };
	});
	const numbers = NUMBER_BITS.map((bits) => {
		const n = fromBits(bits);
		try { return { bits, canonical: canonicalJson(n) }; } catch { return { bits, error: "non-finite" }; }
	});
	// a string with an unpaired surrogate: JSON text can carry it, the service never stores it (wellFormed), a store refuses it
	const lone = JSON.parse('"a\\ud800b"') as string;
	return {
		about: "canonical JSON (src/canonical.ts): RFC 8785 order by UTF-16 code units, ECMAScript number form, -0 as 0; sha256 is digestJson; jsonBytes the UTF-8 bytes of JSON.stringify (src/json.ts)",
		values, numbers,
		unpairedSurrogate: { input: '"a\\ud800b"', canonical: canonicalJson(lone), jsonBytes: jsonBytes(lone) },
		// what the service makes of a call's text
		wellFormed: ['"a\\ud800b"', '"\\ud83d"', '"\\ude00\\ud83d"', '"\\ud83d\\ud83d\\ude00"', '"\\ud83d\\u0041"', '{"\\ud800":[1,"\\udc00"]}', '"\\ud83d\\ude00"'].map((input) => ({ input, output: JSON.stringify(wellFormed(JSON.parse(input))) })),
	};
}

// ---- cryptography

const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";
const b64url = (b: Buffer) => b.toString("base64url");
/** The test keys: derived from fixed secrets, so every run makes the same ones (never use them anywhere else). */
export function testKeys() {
	const edSeed = Buffer.alloc(32, 7);
	const ed = createPrivateKey({ key: Buffer.from(ED25519_PKCS8_PREFIX + edSeed.toString("hex"), "hex"), format: "der", type: "pkcs8" });
	const edPublic = createPublicKey(ed).export({ type: "spki", format: "der" }).subarray(-32);
	const d = Buffer.alloc(32, 9);
	const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(d);
	const point = ecdh.getPublicKey();
	const p256 = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64url(d), x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) }, format: "jwk" });
	const p256Public = createPublicKey(p256).export({ type: "spki", format: "der" });
	return {
		ed25519: { seedHex: edSeed.toString("hex"), privateKey: ed, publicKey: edPublic.toString("base64") },
		p256: { dHex: d.toString("hex"), privateKey: p256, publicKey: p256Public.toString("base64") },
	};
}
const signWith = (algorithm: "ed25519" | "ecdsa-p256", key: ReturnType<typeof createPrivateKey>, message: Uint8Array) =>
	sign(algorithm === "ed25519" ? null : "sha256", message, key).toString("base64");

/** Generation records as claims.ts issueGeneration binds them (its HMAC covers {nonce, ...rec} in canonical form). */
const GENERATIONS = [
	{ signingKey: "11".repeat(32), nonce: "g" + "ab".repeat(16), rec: { primaryEpoch: 1, principal: { peerId: "local" }, incarnation: "0a1b2c3d", issuedAt: T0, admitUntil: T0 + 3_600_000, spaceId: "sp-00000000-0000-4000-8000-000000000001", authorityId: "local" } },
	{ signingKey: "ff".repeat(32), nonce: "g" + "01".repeat(16), rec: { primaryEpoch: 7, principal: { peerId: "peer-ä", agentId: "agent/1" }, incarnation: null, issuedAt: 0, admitUntil: 9007199254740991, spaceId: null, authorityId: "auth-1" } },
];
export const generationOf = (signingKey: string, nonce: string, rec: Json): string =>
	`${nonce}.${createHmac("sha256", signingKey).update(canonicalJson({ nonce, ...(rec as Record<string, Json>) })).digest("hex")}`;

const ARGUMENT_CALLS = [
	{ method: "write", args: { entry: { type: "Task", fields: { n: 1 } } } },
	{ method: "write", args: { entry: { type: "Task", fields: { n: 1 } }, leaseMs: "forever", txn: "t1", unique: ["n"] } },
	{ method: "take", args: { template: { type: "Task" }, timeoutMs: 1000, ifExists: true } },
	{ method: "read", args: { template: null, timeoutMs: null, deadline: 5 } },
	{ method: "txn", args: { action: "begin", leaseMs: 10000 } },
	{ method: "txn", args: { action: "commit", id: "t1" } },
	{ method: "lease", args: { action: "renew", id: "e1", ms: 1 } },
	{ method: "lease", args: { action: "cancel", id: "e1" } },
	{ method: "cancelOperation", args: { targetRequest: { generation: "g", requestId: "r1" } } },
	{ method: "notify", args: { template: { type: "Evt" }, leaseMs: 60000, handback: { a: 1 } } },
	{ method: "wait", args: { template: { type: "Evt" }, timeoutMs: 100, take: false } },
	{ method: "ack", args: { mailboxEpoch: "mb1", upTo: 3 } },
	{ method: "batch", args: { ops: [{ op: "begin" }] } },
];
export const CHALLENGE: Challenge = { gateHostId: "host-vector", observedPeerId: "peer-vector", connNonce: "01".repeat(32), protocol: 1, issuedAt: T0 };
export const GRANT = { id: "grant-1", authorityId: "auth-1", issuerHostId: "host-vector", principal: { peerId: "peer-vector" }, keyId: "key-1", scope: ["default"], roles: ["member"], issuedAt: T0, expiresAt: T0 + 30_000, purpose: "effect" };
export const grantBytes = (g: Json): Buffer => Buffer.from("phi-spaces/grant/v1\n" + canonicalJson(g));

export function cryptoVectors(): Record<string, unknown> {
	const keys = testKeys();
	const proof = signedBytes(CHALLENGE), grant = grantBytes(GRANT as unknown as Json);
	return {
		about: "generations: nonce + '.' + hex HMAC-SHA256(signingKey as UTF-8 text, canonicalJson({nonce, ...rec})) (src/claims.ts); proofs: signature over 'phi-spaces/auth/v1\\n' + canonicalJson(challenge) (src/auth.ts); grants: over 'phi-spaces/grant/v1\\n' + canonicalJson(grant) (src/grants.ts); Ed25519 public keys raw 32 bytes, P-256 SPKI DER, signatures DER, all base64. Ed25519 signatures are deterministic, P-256 ones are not: check them by verifying",
		generations: GENERATIONS.map((g) => ({ ...g, generation: generationOf(g.signingKey, g.nonce, g.rec as unknown as Json) })),
		keys: { ed25519: { seedHex: keys.ed25519.seedHex, publicKey: keys.ed25519.publicKey }, p256: { dHex: keys.p256.dHex, publicKey: keys.p256.publicKey } },
		proof: {
			challenge: CHALLENGE, signedText: proof.toString("utf8"),
			ed25519: signWith("ed25519", keys.ed25519.privateKey, proof), p256: signWith("ecdsa-p256", keys.p256.privateKey, proof),
		},
		grant: { grant: GRANT, signedText: grant.toString("utf8"), ed25519: signWith("ed25519", keys.ed25519.privateKey, grant), p256: signWith("ecdsa-p256", keys.p256.privateKey, grant) },
		derived: {
			principalId: [{ peerId: "local" }, { peerId: "p", agentId: "a" }].map((p) => ({ principal: p, id: principalId(p) })),
			keyFingerprint: [keys.ed25519.publicKey, keys.p256.publicKey].map((k) => ({ publicKey: k, fingerprint: keyFingerprint(k) })),
			hashToken: ["pair-token", "ä€"].map((t) => ({ token: t, sha256: hashToken(t) })),
			// what a request's arguments are bound to (resolveOperation names it): digestJson({method, args}) of the call's domain form
			argumentHash: ARGUMENT_CALLS.map((call) => { const d = rpcDomain(call as unknown as Call, { peerId: "local" }); return { call, domain: d, argumentHash: argHash(d.method, d.args) }; }),
			changeRequestHash: { principal: { peerId: "local" }, generation: GENERATIONS[0]!.nonce + ".x", requestId: "r1", sha256: digestJson([{ peerId: "local" }, GENERATIONS[0]!.nonce + ".x", "r1"]) },
		},
	};
}

// ---- wire session

type Step = { now?: number; call: Json; reply: Json };
export type Session = { steps: Step[]; close(): Promise<void> };

/**
 * The scripted session: one principal (peer "local", role member) on the default space, the clock fixed at T0 and moved
 * by the script, no background service (nothing happens between calls but what the calls do).
 */
export async function runSession(host: ClosableStoreHost, o: { only?: "reads" } = {}): Promise<Step[]> {
	let now = T0;
	const service = new SpaceService({ host, ctx, identity: new StaticIdentity({ local: { principal: { peerId: "local" }, roles: ["member"] } }), now: () => now });
	const steps: Step[] = [];
	let n = 0, generation = "";
	const call = async (method: string, args: Record<string, Json> = {}, request: string | false = `r${++n}`): Promise<Record<string, any>> => {
		const c: Record<string, Json> = { method, args };
		if (request) c.request = { generation, requestId: request };
		const reply = JSON.parse(await service.handleText(JSON.stringify(c), { peerId: "local" })) as Reply;
		steps.push({ now, call: c, reply: reply as unknown as Json });
		return reply as Record<string, any>;
	};
	await call("hello", { protocol: 1 }, false);
	if (o.only === "reads") {
		now = T0 + 5_000; // the clock where the writing session ended
		await call("count", { template: { type: "Task" } }, false);
		await call("readAll", { template: { type: "Task" } }, false);
		await call("readAll", { template: null, limit: 2 }, false);
		await call("changes", { afterRev: 0 }, false);
		return steps;
	}
	generation = (await call("generation", {}, false)).result.generation;
	const a = await call("write", { entry: { type: "Task", fields: { n: 1, name: "a", tags: ["x", "y"] } }, leaseMs: 60_000 });
	const aRequest = `r${n}`;
	const bArgs: Record<string, Json> = { entry: { type: "Task", types: ["Job"], fields: { n: 2, nested: { z: 1, a: [1.5, null, true] } } }, leaseMs: "forever" };
	const b = await call("write", bArgs);
	// the same request again: the stored answer; the same id with other arguments: a conflict
	await call("write", bArgs, `r${n}`);
	await call("write", { entry: { type: "Task", fields: { n: 3 } } }, aRequest);
	await call("count", { template: { type: "Task" } }, false);
	await call("count", { template: { type: "Job" } }, false);
	await call("read", { template: { type: "Task", fields: { n: 2 } } });
	await call("readAll", { template: { type: "Task" } }, false);
	await call("take", { template: { type: "Task", fields: { n: 1 } }, timeoutMs: 0 });
	await call("take", { template: { type: "Task", fields: { n: 9 } }, timeoutMs: 0 });
	const txn = (await call("txn", { action: "begin", leaseMs: 10_000 })).result.id as string;
	await call("write", { entry: { type: "Task", fields: { n: 4 } }, txn });
	await call("count", { template: { type: "Task" } }, false);
	await call("count", { template: { type: "Task" }, txn }, false);
	await call("txn", { action: "commit", id: txn });
	await call("txn", { action: "status", id: txn }, false);
	now += 1_000;
	await call("lease", { action: "renew", id: b.result.id, ms: 30_000 });
	await call("lease", { action: "cancel", id: a.result.id }); // taken above: no such lease any more
	await call("lease", { action: "cancel", id: (steps.find((s) => (s.call as any).args?.txn && (s.call as any).method === "write")!.reply as any).result.id });
	// a subscription and its mailbox: the event of a matching write, read and acknowledged
	const sub = await call("notify", { template: { type: "Evt" }, leaseMs: 60_000, handback: { tag: "h" } });
	await call("write", { entry: { type: "Evt", fields: { k: 1 } } });
	const events = (await call("events", { waitMs: 0 }, false)).result;
	await call("ack", { mailboxEpoch: events.mailboxEpoch, upTo: events.next });
	await call("events", { waitMs: 0, after: events.next }, false);
	await call("lease", { action: "cancel", id: sub.result.lease.id });
	await call("batch", { ops: [{ op: "write", entry: { type: "Task", fields: { n: 5 } } }, { op: "take", template: { type: "Task", fields: { n: 5 } } }, { op: "read", template: { type: "Task", fields: { n: 2 } } }] });
	await call("write", { entry: { type: "Key", fields: { key: "k1", v: 1 } }, unique: ["key"] });
	await call("write", { entry: { type: "Key", fields: { key: "k1", v: 2 } }, unique: ["key"] });
	// a take that waits: pending, still pending a second later, served by the write that follows, then polled done
	const waiting = `r${++n}`;
	await call("take", { template: { type: "Task", fields: { n: 7 } }, timeoutMs: 10_000, waitMs: 0 }, waiting);
	now += 1_000;
	await call("pollOperation", { targetRequest: { generation, requestId: waiting }, waitMs: 0 }, false);
	await call("write", { entry: { type: "Task", fields: { n: 7 } } });
	await call("pollOperation", { targetRequest: { generation, requestId: waiting }, waitMs: 0 }, false);
	// a take whose deadline passes
	const lapsing = `r${++n}`;
	await call("take", { template: { type: "Task", fields: { n: 8 } }, timeoutMs: 500, waitMs: 0 }, lapsing);
	now += 1_000;
	await call("pollOperation", { targetRequest: { generation, requestId: lapsing }, waitMs: 0 }, false);
	await call("resolveOperation", { targetRequest: { generation, requestId: waiting }, method: "take", argumentHash: "0".repeat(64), primaryEpoch: 0 }, false);
	const domain = rpcDomain({ method: "take", args: (steps.find((s) => (s.call as any).request?.requestId === waiting)!.call as any).args } as Call, { peerId: "local" });
	await call("resolveOperation", { targetRequest: { generation, requestId: waiting }, method: domain.method, argumentHash: argHash(domain.method, domain.args), primaryEpoch: 0 }, false);
	await call("changes", { afterRev: 0 }, false);
	await call("changes", { afterRev: 0, maxBytes: 300 }, false);
	await call("spaces", {}, false);
	now += 2_000;
	// refusals: each a code of the protocol
	await call("write", {}, `r${++n}`);
	await call("write", { entry: { type: "Task", fields: { n: 1 } } }, false);
	await call("nosuch", {}, false);
	await call("hello", { protocol: 2 }, false);
	await call("lease", { action: "renew", id: "e-unknown", ms: 1 });
	await call("txn", { action: "commit", id: txn });
	await call("read", { template: { type: "Task" } }, "r-unknown-generation-is-fine");
	// half an emoji arrives as U+FFFD
	await call("write", { entry: { type: "Cut", fields: { text: "a\ud83d", "\ude00": 1 } } });
	await call("take", { template: { type: "Cut" } });
	return steps;
}

/** Random values of a host (ids, incarnation, generations) become placeholders by their first appearance, so a session
 *  compares across runs and implementations. A replay learns each one from the reply that shows it first. */
export function normalize(steps: Step[]): Step[] {
	const names = new Map<string, string>();
	const counters = new Map<string, number>();
	const name = (kind: string, v: string) => { let p = names.get(v); if (!p) { const c = (counters.get(kind) ?? 0) + 1; counters.set(kind, c); p = `<${kind}${c}>`; names.set(v, p); } return p; };
	const scan = (v: unknown, key?: string): void => {
		if (typeof v === "string") {
			for (const m of v.matchAll(/g[0-9a-f]{32}\.[0-9a-f]{64}/g)) name("generation", m[0]);
			for (const m of v.matchAll(/host-[0-9a-f-]{36}/g)) name("host", m[0]);
			for (const m of v.matchAll(/sp-[0-9a-f-]{36}/g)) name("space", m[0]);
			for (const m of v.matchAll(/mb[0-9a-f]{32}/g)) name("mailbox", m[0]);
			if (key === "incarnation") name("incarnation", v);
		} else if (Array.isArray(v)) v.forEach((x) => scan(x));
		else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scan(x, k);
	};
	for (const s of steps) { scan(s.reply); scan(s.call); }
	// longest first: an incarnation never replaces part of a generation
	const order = [...names.keys()].sort((a, b) => b.length - a.length);
	const rewrite = (v: unknown, key?: string): unknown => {
		if (typeof v === "string") { let out = v; for (const k of order) out = out.split(k).join(names.get(k)!); return out; }
		if (Array.isArray(v)) return v.map((x) => rewrite(x));
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "process" && key === "result" ? "<process>" : rewrite(x, k)]));
		return v;
	};
	return steps.map((s) => ({ ...(s.now === undefined ? {} : { now: s.now }), call: rewrite(s.call) as Json, reply: rewrite(s.reply) as Json }));
}

export async function wireVectors(): Promise<Json> {
	const host = openOwnMemoryHost();
	try { return { about: "a session against SpaceService.handleText (src/service.ts): peer 'local' with role member, clock fixed at T0 and moved by the script, no background service; random values as <kindN> by first appearance (test/vectors/build.ts normalize)", t0: T0, steps: normalize(await runSession(host)) as unknown as Json }; }
	finally { await host.close(ctx); }
}

// ---- store file

const TABLES = ["store_meta", "documents", "parts"] as const;
const literal = (v: unknown): string => v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;

/** The store's tables and indexes and every row, as SQL that recreates the file's content (ordered by primary key). */
export function dumpStore(path: string): string {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all() as Array<{ sql: string }>).map((r) => r.sql + ";");
		const out = ["-- written by test/vectors/build.ts --write: a phi-spaces store (src/store/sqlite.ts) after the scripted session", ...schema];
		for (const t of TABLES) {
			const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; pk: number }>);
			const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
			for (const row of db.prepare(`SELECT * FROM ${t} ORDER BY ${pk.join(", ")}`).all() as Array<Record<string, unknown>>)
				out.push(`INSERT INTO ${t} (${cols.map((c) => c.name).join(", ")}) VALUES (${cols.map((c) => literal(row[c.name])).join(", ")});`);
		}
		return out.join("\n") + "\n";
	} finally { db.close(); }
}

/** A store file from the SQL of dumpStore, at `path`. */
export function loadStore(sql: string, path: string): void {
	const db = new DatabaseSync(path);
	try { db.exec(sql); } finally { db.close(); }
}

/** The CREATE statements of a dump: the schema a store file has. */
export const schemaOf = (sql: string): string[] => sql.split("\n").filter((l) => l.startsWith("CREATE "));

/** The schema a store opened now gets. */
export async function currentSchema(): Promise<string[]> {
	const dir = mkdtempSync(join(tmpdir(), "phi-schema-"));
	try { const path = join(dir, "s.sqlite"); await (await openSqliteHost(path)).close(ctx); return schemaOf(dumpStore(path)); }
	finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What the read-only session answers on the store file (not normalized: the file fixes its ids). */
export async function readStore(path: string): Promise<Json> {
	const host = await openSqliteHost(path);
	try { return (await runSession(host, { only: "reads" })).map(({ call, reply }) => ({ call, reply })) as unknown as Json; }
	finally { await host.close(ctx); }
}

async function writeStore(): Promise<{ sql: string; expected: Json }> {
	const dir = mkdtempSync(join(tmpdir(), "phi-vectors-"));
	try {
		const path = join(dir, "space.sqlite");
		const host = await openSqliteHost(path);
		try { await runSession(host); } finally { await host.close(ctx); }
		const sql = dumpStore(path);
		const fresh = join(dir, "fresh.sqlite");
		loadStore(sql, fresh);
		return { sql, expected: { about: "the read-only session (runSession only: 'reads') on the store loaded from store.sql", steps: await readStore(fresh) } };
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- files

export const json = (v: unknown): string => JSON.stringify(v, null, "\t") + "\n";
export const readVector = (file: string): string => readFileSync(join(DIR, file), "utf8");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	if (!process.argv.includes("--write")) { console.error("usage: node --experimental-strip-types test/vectors/build.ts --write"); process.exit(2); }
	const prior = (file: string): any => { try { return JSON.parse(readVector(file)); } catch { return null; } };
	writeFileSync(join(DIR, "canonical.json"), json(canonicalVectors()));
	const crypto = cryptoVectors() as any, old = prior("crypto.json"), p256 = crypto.keys.p256.publicKey;
	if (old && verifySignature({ algorithm: "ecdsa-p256", publicKey: p256 }, CHALLENGE, old.proof?.p256 ?? "")) crypto.proof.p256 = old.proof.p256;
	if (old && verifyDetached("ecdsa-p256", p256, grantBytes(GRANT as unknown as Json), old.grant?.p256 ?? "")) crypto.grant.p256 = old.grant.p256;
	writeFileSync(join(DIR, "crypto.json"), json(crypto));
	writeFileSync(join(DIR, "wire.json"), json(await wireVectors()));
	let storeSql: string | null = null;
	try { storeSql = readVector("store.sql"); } catch { /* none yet */ }
	const renew = process.argv.includes("--store") || storeSql === null || prior("store.expected.json") === null || JSON.stringify(schemaOf(storeSql)) !== JSON.stringify(await currentSchema());
	if (renew) {
		const store = await writeStore();
		writeFileSync(join(DIR, "store.sql"), store.sql);
		writeFileSync(join(DIR, "store.expected.json"), json(store.expected));
	}
	console.log(`wrote canonical.json, crypto.json, wire.json${renew ? ", store.sql, store.expected.json" : " (store files kept; --store writes them anew)"}`);
}
