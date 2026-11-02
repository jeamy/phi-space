// PrimarySyncJournal (src/primary-sync.ts) as a line-driven process, for rust/phi-store/tests/sync_journal.rs: each line is one
// operation on a named journal file, each answer its result or its refusal by name, and `rows` the file's rows, so both
// sides can be held against each other entry for entry.
//
//   node --experimental-strip-types --no-warnings test/support/journal-driver.ts
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { PrimarySyncJournal, PrimarySyncBlocked, SyncJournalFull } from "../../src/primary-sync.ts";

type Line = Record<string, any>;
const journals = new Map<string, PrimarySyncJournal>(), paths = new Map<string, string>();
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
		case "state": {
			const j = journal(q.name);
			return { head: j.head(), applied: j.appliedRevision, config: j.config, configHash: j.configHash, recoveredCommitted: j.recoveredCommitted, open: j.openTransitionIds(), historyBytes: j.historyBytes, format: j.format ?? null };
		}
		case "rows": {
			const db = new DatabaseSync(paths.get(q.name)!, { readOnly: true });
			try { return { meta: db.prepare("SELECT key, value FROM sync_meta ORDER BY key").all(), intents: db.prepare("SELECT revision, hash, intent FROM sync_intents ORDER BY revision").all() }; } finally { db.close(); }
		}
		default: throw new Error(`unknown op ${q.op}`);
	}
}

for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const q = JSON.parse(text) as Line;
	let out: unknown;
	try { out = { ok: true, result: (await handle(q)) ?? null }; }
	catch (e) { out = { ok: false, error: { name: e instanceof SyncJournalFull ? "SyncJournalFull" : e instanceof PrimarySyncBlocked ? "PrimarySyncBlocked" : (e as Error).constructor.name, message: (e as Error).message } }; }
	console.log(JSON.stringify(out));
}
