// PrimarySyncJournal (src/primary-sync.ts) and the own store under it (OwnSyncStore) as a line-driven process, for
// rust/phi-store/tests/sync_journal.rs and sync_store.rs: each line is one operation on a named journal or store file, each
// answer its result or its refusal by name, and `rows`/`storeRows` the files' rows, so both sides can be held against each
// other entry for entry.
//
//   node --experimental-strip-types --no-warnings test/support/journal-driver.ts
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { PrimarySyncJournal, PrimarySyncBlocked, SyncJournalFull, CommitSealed, applyConfigTransition, bootstrapPrimarySync, materializeSyncHistory, recoverPrimarySync, recoverSealedWithoutStandby } from "../../src/primary-sync.ts";
import { OwnSyncStore } from "../../src/store/sync-sqlite.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";

type Line = Record<string, any>;
const journals = new Map<string, PrimarySyncJournal>(), paths = new Map<string, string>(), stores = new Map<string, OwnSyncStore>();
const store = (name: string) => { const s = stores.get(name); if (!s) throw new Error(`no store ${name}`); return s; };
const journal = (name: string) => { const j = journals.get(name); if (!j) throw new Error(`no journal ${name}`); return j; };
const refuse = (why: unknown) => async () => { if (typeof why === "string") throw new PrimarySyncBlocked(why); };

async function handle(q: Line): Promise<unknown> {
	switch (q.op) {
		case "open": {
			journals.get(q.name)?.close();
			journals.delete(q.name);
			const o = { ...(q.self ? { self: q.self } : {}), ...(q.maxIntentBytes ? { maxIntentBytes: q.maxIntentBytes } : {}), ...(q.maxHistoryBytes ? { maxHistoryBytes: q.maxHistoryBytes } : {}), ...(q.format ? { format: q.format } : {}) };
			journals.set(q.name, new PrimarySyncJournal(q.path, q.genesis, o));
			paths.set(q.name, q.path);
			return journal(q.name).head();
		}
		case "close": journals.get(q.name)?.close(); journals.delete(q.name); return null;
		case "seal": return journal(q.name).seal(q.deltas, q.validatedAt);
		case "sealBootstrap": return journal(q.name).sealBootstrap(q.chunks, q.storeHash, null, q.validatedAt);
		case "sealTransition": return journal(q.name).sealTransition(q.next, q.reason, q.mark, q.validatedAt);
		case "accept": return journal(q.name).accept(q.intent);
		case "acceptRefused": { const j = journal(q.name) as any, saved = j.assertStandby; j.assertStandby = refuse(q.why); try { return await j.accept(q.intent); } finally { j.assertStandby = saved; } }
		case "catchUp": return journal(q.name).catchUp(q.intent, refuse(q.why));
		case "begin": return journal(q.name).beginTransition(q.id, q.record);
		case "abandon": journal(q.name).abandonTransition(q.id); return null;
		case "save": journal(q.name).saveTransition(q.id, q.record); return null;
		case "transition": return journal(q.name).transition(q.id);
		case "markApplied": journal(q.name).markApplied(q.intent, q.recovered === true); return null;
		case "intent": return journal(q.name).intent(q.revision);
		case "bytes": return Buffer.byteLength(JSON.stringify(q.value)); // what a primary's budget counts of its rows
		case "state": {
			const j = journal(q.name);
			return { head: j.head(), applied: j.appliedRevision, config: j.config, configHash: j.configHash, recoveredCommitted: j.recoveredCommitted, open: j.openTransitionIds(), historyBytes: j.historyBytes, format: j.format ?? null };
		}
		case "rows": {
			const db = new DatabaseSync(paths.get(q.name)!, { readOnly: true });
			try { return { meta: db.prepare("SELECT key, value FROM sync_meta ORDER BY key").all(), intents: db.prepare("SELECT revision, hash, intent FROM sync_intents ORDER BY revision").all() }; } finally { db.close(); }
		}
		// the store side (OwnSyncStore and the functions of primary-sync.ts that work on a stopped store)
		case "storeOpen": await stores.get(q.store)?.close(); stores.set(q.store, new OwnSyncStore(q.path)); paths.set(`store:${q.store}`, q.path); return null;
		case "storeClose": await stores.get(q.store)?.close(); stores.delete(q.store); return null;
		case "storeCommit": await store(q.store).commit(q.deltas); return null;
		case "marker": return (await store(q.store).marker(q.spaceId))?.value ?? null;
		case "capture": return (await store(q.store).capture()).digest;
		case "storeRows": {
			const db = new DatabaseSync(paths.get(`store:${q.store}`)!, { readOnly: true });
			try { return { documents: db.prepare("SELECT kind, key, version, value FROM documents ORDER BY kind, key").all(), parts: db.prepare("SELECT kind, key, part, id, ord, value, at, grp, flag FROM parts ORDER BY kind, key, part, id").all(), meta: db.prepare("SELECT key, value FROM store_meta ORDER BY key").all() }; } finally { db.close(); }
		}
		case "bootstrap": return bootstrapPrimarySync(store(q.store), journal(q.name), ctx, { now: () => q.now, ...(q.chunkBytes ? { chunkBytes: q.chunkBytes } : {}) });
		case "materialize": await materializeSyncHistory(store(q.store), journal(q.name), ctx, q.why ? refuse(q.why) : undefined); return null;
		case "recover": await recoverPrimarySync(store(q.store), journal(q.name), q.peer ? journal(q.peer) : null, ctx, refuse(q.why)); return null;
		case "recoverSealed": return recoverSealedWithoutStandby(store(q.store), journal(q.name), ctx, refuse(q.why));
		case "transitionApply": return applyConfigTransition(store(q.store), journal(q.name), q.next, { reason: q.reason, peer: q.peer ? journal(q.peer) : null, ctx, assert: refuse(q.why), now: () => q.now });
		default: throw new Error(`unknown op ${q.op}`);
	}
}

for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const q = JSON.parse(text) as Line;
	let out: unknown;
	try { out = { ok: true, result: (await handle(q)) ?? null }; }
	catch (e) { out = { ok: false, error: { name: e instanceof SyncJournalFull ? "SyncJournalFull" : e instanceof PrimarySyncBlocked ? "PrimarySyncBlocked" : e instanceof CommitSealed ? "CommitSealed" : (e as Error).constructor.name, message: (e as Error).message } }; }
	console.log(JSON.stringify(out));
}
