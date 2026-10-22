// The writer of the SQLite store (store/sqlite.ts), on a thread of its own: a synchronous COMMIT with
// synchronous=FULL waits for the disk, and on the main thread that would stop every request of the space meanwhile.
// It gets batches of rows (whatever commits came while the previous batch was written) and writes each batch in one
// transaction; the main thread acknowledges those commits only when the batch is written.
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

// Tests only (crash tests, test/test-own-store.test.ts): PHI_SPACES_WRITER_PAUSE=<before-commit|after-commit>:<batch>:<file>
// stops this thread at that point of that batch for good, after writing <file>, so a test can kill the process there.
const pause = (() => { const [at, batch, file] = (process.env.PHI_SPACES_WRITER_PAUSE ?? "").split(":"); return at && file ? { at, batch: Number(batch), file } : null; })();
const hold = (at: string, batch: number) => {
	if (!pause || pause.at !== at || pause.batch !== batch) return;
	writeFileSync(pause.file, at);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // until the process is killed
};

/** A row change of a batch: a document (whole value or head), a retired document, a part row, a deleted part row. */
export type WriteOp =
	| { t: "doc"; kind: string; key: string; version: number; value: string }
	| { t: "retire"; kind: string; key: string }
	| { t: "part"; kind: string; key: string; part: string; id: string; ord: number; value: string; at: number | null; grp: string | null; flag: number | null }
	| { t: "partDel"; kind: string; key: string; part: string; id: string };
export type WriterRequest = { type: "open"; path: string; synchronous: "FULL" | "NORMAL" } | { type: "write"; batch: number; ops: WriteOp[] } | { type: "close" };
export type WriterReply = { type: "opened" } | { type: "written"; batch: number } | { type: "failed"; batch: number | null; error: string } | { type: "closed" };

let db: DatabaseSync | null = null;
let stmts: Record<WriteOp["t"] | "retireParts" | "seq", ReturnType<DatabaseSync["prepare"]>> | null = null;
const reply = (r: WriterReply) => parentPort!.postMessage(r);

parentPort!.on("message", (m: WriterRequest) => {
	if (m.type === "open") {
		try {
			db = new DatabaseSync(m.path, { timeout: 10_000 });
			db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${m.synchronous};`);
			stmts = {
				doc: db.prepare("INSERT INTO documents (kind, key, version, value) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET version = excluded.version, value = excluded.value"),
				retire: db.prepare("DELETE FROM documents WHERE kind = ? AND key = ?"),
				retireParts: db.prepare("DELETE FROM parts WHERE kind = ? AND key = ?"),
				part: db.prepare("INSERT INTO parts (kind, key, part, id, ord, value, at, grp, flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, key, part, id) DO UPDATE SET ord = excluded.ord, value = excluded.value, at = excluded.at, grp = excluded.grp, flag = excluded.flag"),
				partDel: db.prepare("DELETE FROM parts WHERE kind = ? AND key = ? AND part = ? AND id = ?"),
				seq: db.prepare("UPDATE store_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'commit_seq'"),
			};
			reply({ type: "opened" });
		} catch (e) { reply({ type: "failed", batch: null, error: (e as Error).message }); }
		return;
	}
	if (m.type === "close") { try { db?.close(); } finally { db = null; reply({ type: "closed" }); } return; }
	if (!db || !stmts) { reply({ type: "failed", batch: m.batch, error: "the store is not open" }); return; }
	try {
		db.exec("BEGIN IMMEDIATE");
		for (const op of m.ops) {
			if (op.t === "doc") stmts.doc.run(op.kind, op.key, op.version, op.value);
			else if (op.t === "retire") { stmts.retire.run(op.kind, op.key); stmts.retireParts.run(op.kind, op.key); }
			else if (op.t === "part") stmts.part.run(op.kind, op.key, op.part, op.id, op.ord, op.value, op.at, op.grp, op.flag);
			else stmts.partDel.run(op.kind, op.key, op.part, op.id);
		}
		stmts.seq.run();
		hold("before-commit", m.batch);
		db.exec("COMMIT");
		hold("after-commit", m.batch);
		reply({ type: "written", batch: m.batch });
	} catch (e) {
		try { db.exec("ROLLBACK"); } catch { /* the transaction may already be gone */ }
		reply({ type: "failed", batch: m.batch, error: (e as Error).message });
	}
});
