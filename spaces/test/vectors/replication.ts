// R6b of docs/rust-portierung.en.md: the replication and recovery formats a second implementation must reproduce, before it
// writes them. replication.json holds the signed texts (fixed key, fixed values: every run writes the same file); the
// journal files hold a primary/sync history and the store it drives, as SQL like store.sql (minted ids are random,
// so only `npm run vectors -- --store` writes them anew).
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Json } from "../../src/core.ts";
import type { Signer } from "../../src/auth.ts";
import { canonicalJson, digestJson } from "../../src/canonical.ts";
import { signReplicaConfigNotice, type ReplicaConfigNotice } from "../../src/replica-notice.ts";
import { signControlHostChange, type ControlHostChange } from "../../src/control-host-change.ts";
import { authorityTransitionBytes, type AuthorityTransition } from "../../src/recovery.ts";
import { recoveryBytes, type RecoveryCall } from "../../src/recovery-service.ts";
import { PrimarySyncJournal, applyConfigTransition, bootstrapPrimarySync, materializeSyncHistory, primarySyncStorage, type PrimarySyncConfig } from "../../src/primary-sync.ts";
import { OwnSyncStore } from "../../src/store/sync-sqlite.ts";
import { PhiSpaces, FOREVER } from "../../src/index.ts";
import { createSpace, snapshotSpace } from "../../src/spaces.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";

export const T0 = 1_767_225_600_000;
const SEED = Buffer.alloc(32, 7);
/** The ed25519 test key of crypto.json, as a Signer. */
export function vectorSigner(): Signer & { publicKey: string } {
	const key = createPrivateKey({ key: Buffer.from("302e020100300506032b657004220420" + SEED.toString("hex"), "hex"), format: "der", type: "pkcs8" });
	const publicKey = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
	return { keyId: "vector-key", algorithm: "ed25519", publicKey, sign: (data: Uint8Array) => sign(null, data, key) };
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const signed = async (signer: Signer, text: Buffer) => ({ text: text.toString("utf8"), signature: b64(await signer.sign(text)) });

/** The signed texts: the replica transport (src/replica-transport.ts), notices, the control host change, the authority transition, a recovery call. */
export async function replicationVectors(): Promise<Record<string, unknown>> {
	const signer = vectorSigner();
	const ack = { revision: 7, hash: "ab".repeat(32), configHash: "cd".repeat(32) };
	const body = { version: 1, revision: 7, hash: ack.hash };
	const request = { from: "replica-a", to: "replica-b", method: "accept", nonce: "0a".repeat(16), ts: T0, bodyHash: digestJson(body as Json) };
	const response = { from: "replica-b", to: "replica-a", nonce: request.nonce, method: "accept", ok: true, result: ack, error: null };
	const refusal = { ...response, ok: false, result: null, error: "standby refused" };
	const notice: ReplicaConfigNotice = { authorityId: "authority", spaceId: "sp-0d7f3a52-6c1e-4b8a-9f21-3e5a7c9b1d04", recoveryId: "promote-1", primaryReplica: "replica-b", standbyReplica: "replica-a", primaryEpoch: 2, replicaConfigVersion: 2, durability: "sync", dataIncarnation: "1ed6e700" };
	const change: ControlHostChange = { recoveryId: "change-1", authorityId: "authority", controlSpaceId: notice.spaceId, fromHostId: "control-host", targetHostId: "control-host-b", primaryEpoch: 3, supervisorKey: signer.publicKey, algorithm: "ed25519", address: { host: "172.30.7.12", port: 7431 } };
	const transition: AuthorityTransition = { recoveryId: "control-restore-1", expectedAuthorityId: "authority", newAuthorityId: "a-00000000-0000-4000-8000-000000000001", controlSpaceId: notice.spaceId, targetHostId: "control-host-b", supervisorKey: signer.publicKey };
	const call: RecoveryCall = { hostId: "data-host-b", requestId: "00000000-0000-4000-8000-000000000002", method: "restoreDataSpace", args: { recoveryId: "restore-notes-1", space: notice.spaceId, snapshotRef: "notes.json", targetHostId: "data-host-b", expectedDataIncarnation: "1ed6e700", expectedPrimaryEpoch: 1 }, issuedAt: T0, expiresAt: T0 + 60_000 };
	const domain = (tag: string, v: unknown) => Buffer.from(tag + canonicalJson(v as Json));
	return {
		about: "signed texts of R6b (docs/rust-portierung.en.md): the ed25519 key of crypto.json; each text is the exact byte string signed",
		publicKey: signer.publicKey,
		replicaTransport: {
			body, request: { value: request, ...await signed(signer, domain("phi-spaces/replica-sync/v1/request\n", request)) },
			response: { value: response, ...await signed(signer, domain("phi-spaces/replica-sync/v1/response\n", response)) },
			refusal: { value: refusal, ...await signed(signer, domain("phi-spaces/replica-sync/v1/response\n", refusal)) },
		},
		replicaConfigNotice: await signReplicaConfigNotice(notice, signer),
		replicaConfigNoticeText: "phi-spaces/replica-config-notice/v1\n" + canonicalJson(notice as unknown as Json),
		controlHostChange: await signControlHostChange(change, signer),
		controlHostChangeText: "phi-spaces/control-host-change/v1\n" + canonicalJson(change as unknown as Json),
		authorityTransition: { transition, ...await signed(signer, authorityTransitionBytes(transition)) },
		recoveryCall: { call, ...await signed(signer, recoveryBytes(call)) },
	};
}

export const JOURNAL_SPACE = "sp-6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7", JOURNAL_INCARNATION = "5a6b7c8d";
/**
 * A primary/sync history in `dir`: a store bootstrapped single on replica-a (v3), two commits (v1), setStandby's
 * configuration entry to sync with replica-b (v2), one commit replica-b confirmed (v1). The files: primary.journal.sqlite,
 * standby.journal.sqlite and primary.store.sqlite.
 */
export async function writeJournals(dir: string): Promise<void> {
	let now = T0;
	const clock = () => ++now;
	const genesis: PrimarySyncConfig = { spaceId: JOURNAL_SPACE, authorityId: "authority", primaryEpoch: 1, replicaConfigVersion: 1, primaryReplica: "replica-a", standbyReplica: null, durability: "single" };
	const seedStore = new OwnSyncStore(join(dir, "primary.store.sqlite")), seeded = await seedStore.openHost();
	await seeded.commit((tx) => createSpace(tx, "ledger", clock(), { spaceId: JOURNAL_SPACE, incarnation: JOURNAL_INCARNATION }).then(() => {}), ctx);
	await new PhiSpaces(seeded, ctx, clock, undefined, undefined, { space: JOURNAL_SPACE }).write({ type: "Ledger", fields: { n: 0, label: "seeded" } }, null, FOREVER);
	await seeded.close(ctx);
	const primary = new PrimarySyncJournal(join(dir, "primary.journal.sqlite"), genesis, { self: "replica-a" });
	const standby = new PrimarySyncJournal(join(dir, "standby.journal.sqlite"), genesis, { self: "replica-b" });
	const raw = new OwnSyncStore(join(dir, "primary.store.sqlite"));
	await bootstrapPrimarySync(raw, primary, ctx, { now: clock });
	await raw.close(ctx);
	const writeAll = async (peer: PrimarySyncJournal | null, labels: string[]) => {
		const host = await primarySyncStorage(new OwnSyncStore(join(dir, "primary.store.sqlite")), primary, peer, { assertPrimary: async () => {}, now: clock }).open();
		for (const label of labels) await new PhiSpaces(host, ctx, clock, undefined, undefined, { space: JOURNAL_SPACE }).write({ type: "Ledger", fields: { label } }, null, FOREVER);
		await host.close(ctx);
	};
	await writeAll(null, ["single-1", "single-2"]);
	// what setStandby does: the standby catches up from the start, then confirms the configuration entry
	for (let r = 1; r <= primary.head().revision; r++) await standby.catchUp(primary.intent(r)!, async () => {});
	const store = new OwnSyncStore(join(dir, "primary.store.sqlite"));
	await applyConfigTransition(store, primary, { ...genesis, standbyReplica: "replica-b", durability: "sync", replicaConfigVersion: 2 }, { reason: "standby-1", peer: standby, ctx, assert: async () => {}, now: clock });
	await store.close(ctx);
	await writeAll(standby, ["sync-1"]);
	primary.close(); standby.close();
}

export const JOURNAL_FILES = ["primary.journal", "standby.journal", "primary.store"] as const;
const literal = (v: unknown): string => v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
/** Every table of a SQLite file and its rows, as SQL that recreates them (rows ordered by primary key). */
export function dumpSqlite(path: string, about: string): string {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all() as Array<{ type: string; name: string; sql: string }>;
		const out = [`-- written by test/vectors/build.ts --write --store: ${about}`, ...objects.map((o) => o.sql + ";")];
		for (const t of objects.filter((o) => o.type === "table")) {
			const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string; pk: number }>, pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
			for (const row of db.prepare(`SELECT * FROM ${t.name}${pk.length ? ` ORDER BY ${pk.join(", ")}` : ""}`).all() as Array<Record<string, unknown>>)
				out.push(`INSERT INTO ${t.name} (${cols.map((c) => c.name).join(", ")}) VALUES (${cols.map((c) => literal(row[c.name])).join(", ")});`);
		}
		return out.join("\n") + "\n";
	} finally { db.close(); }
}
export function loadSqlite(sql: string, path: string): void {
	const db = new DatabaseSync(path);
	try { db.exec(sql); } finally { db.close(); }
}

/** What the journal files answer: heads, positions, configurations, the kinds of their entries, and the standby's history materialized
 *  into a new store (which moves the standby's applied position: read from a fresh copy). */
export async function readJournals(dir: string): Promise<Json> {
	const genesis: PrimarySyncConfig = { spaceId: JOURNAL_SPACE, authorityId: "authority", primaryEpoch: 1, replicaConfigVersion: 1, primaryReplica: "replica-a", standbyReplica: null, durability: "single" };
	const view = (j: PrimarySyncJournal) => ({ head: j.head(), applied: j.appliedRevision, config: j.config, recoveredCommitted: j.recoveredCommitted, versions: Array.from({ length: j.head().revision }, (_, n) => j.intent(n + 1)!.version) });
	const primary = new PrimarySyncJournal(join(dir, "primary.journal.sqlite"), genesis, { self: "replica-a" });
	const standby = new PrimarySyncJournal(join(dir, "standby.journal.sqlite"), genesis, { self: "replica-b" });
	try {
		const raw = new OwnSyncStore(join(dir, "standby.store.sqlite"));
		await materializeSyncHistory(raw, standby, ctx);
		await raw.close(ctx);
		const host = await new OwnSyncStore(join(dir, "standby.store.sqlite")).openHost(), space = await snapshotSpace(host, JOURNAL_SPACE, ctx);
		await host.close(ctx);
		return { primary: view(primary), standby: view(standby), materialized: { entries: (space?.entries ?? []).map((e) => e.fields), spaceHash: digestJson(space as unknown as Json) } } as unknown as Json;
	} finally { primary.close(); standby.close(); }
}
