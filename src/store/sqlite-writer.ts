// The writer of the SQLite store (store/sqlite.ts), on a thread of its own: a synchronous COMMIT with
// synchronous=FULL waits for the disk, and on the main thread that would stop every request of the space meanwhile.
// It gets batches of rows (whatever commits came while the previous batch was written) and writes each batch in one
// transaction; the main thread acknowledges those commits only when the batch is written.
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { applyOps, prepareOps, type OpStatements, type WriteOp } from "./sqlite-ops.ts";

// Tests only (crash tests, test/test-own-store.test.ts): PHI_SPACES_WRITER_PAUSE=<before-commit|after-commit>:<batch>:<file>
// stops this thread at that point of that batch for good, after writing <file>, so a test can kill the process there.
const pause = (() => { const [at, batch, file] = (process.env.PHI_SPACES_WRITER_PAUSE ?? "").split(":"); return at && file ? { at, batch: Number(batch), file } : null; })();
const hold = (at: string, batch: number) => {
	if (!pause || pause.at !== at || pause.batch !== batch) return;
	writeFileSync(pause.file, at);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // until the process is killed
};

export type { WriteOp };
export type WriterRequest = { type: "open"; path: string; synchronous: "FULL" | "NORMAL" } | { type: "write"; batch: number; ops: WriteOp[] } | { type: "close" };
export type WriterReply = { type: "opened" } | { type: "written"; batch: number } | { type: "failed"; batch: number | null; error: string } | { type: "closed" };

let db: DatabaseSync | null = null;
let stmts: OpStatements | null = null;
const reply = (r: WriterReply) => parentPort!.postMessage(r);

parentPort!.on("message", (m: WriterRequest) => {
	if (m.type === "open") {
		try {
			db = new DatabaseSync(m.path, { timeout: 10_000 });
			db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${m.synchronous};`);
			stmts = prepareOps(db);
			reply({ type: "opened" });
		} catch (e) { reply({ type: "failed", batch: null, error: (e as Error).message }); }
		return;
	}
	if (m.type === "close") { try { db?.close(); } finally { db = null; reply({ type: "closed" }); } return; }
	if (!db || !stmts) { reply({ type: "failed", batch: m.batch, error: "the store is not open" }); return; }
	try {
		db.exec("BEGIN IMMEDIATE");
		applyOps(stmts, m.ops);
		hold("before-commit", m.batch);
		db.exec("COMMIT");
		hold("after-commit", m.batch);
		reply({ type: "written", batch: m.batch });
	} catch (e) {
		try { db.exec("ROLLBACK"); } catch { /* the transaction may already be gone */ }
		reply({ type: "failed", batch: m.batch, error: (e as Error).message });
	}
});
