// The row changes of the own SQLite store (store/sqlite.ts) and how they are applied: by its writer thread
// (store/sqlite-writer.ts) for the commits of an open store, and directly on a stopped store file by the primary/sync
// replication (store/sync-store.ts: a standby materializing its history, a bootstrap, a recovery). One place, so both
// write the very same rows.
import type { DatabaseSync } from "node:sqlite";

/** A row change: a document (whole value or head), a retired document, a part row, a deleted part row, a store_meta
 *  value (the replication marker, written in the same transaction as the data it marks). */
export type WriteOp =
	| { t: "doc"; kind: string; key: string; version: number; value: string }
	| { t: "retire"; kind: string; key: string }
	| { t: "part"; kind: string; key: string; part: string; id: string; ord: number; value: string; at: number | null; grp: string | null; flag: number | null }
	| { t: "partDel"; kind: string; key: string; part: string; id: string }
	| { t: "meta"; key: string; value: string };

export type OpStatements = Record<WriteOp["t"] | "retireParts" | "seq", ReturnType<DatabaseSync["prepare"]>>;

export function prepareOps(db: DatabaseSync): OpStatements {
	return {
		doc: db.prepare("INSERT INTO documents (kind, key, version, value) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET version = excluded.version, value = excluded.value"),
		retire: db.prepare("DELETE FROM documents WHERE kind = ? AND key = ?"),
		retireParts: db.prepare("DELETE FROM parts WHERE kind = ? AND key = ?"),
		part: db.prepare("INSERT INTO parts (kind, key, part, id, ord, value, at, grp, flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, key, part, id) DO UPDATE SET ord = excluded.ord, value = excluded.value, at = excluded.at, grp = excluded.grp, flag = excluded.flag"),
		partDel: db.prepare("DELETE FROM parts WHERE kind = ? AND key = ? AND part = ? AND id = ?"),
		meta: db.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
		seq: db.prepare("UPDATE store_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'commit_seq'"),
	};
}

/** Applies `ops` inside the caller's transaction and counts it as one commit (commit_seq). */
export function applyOps(stmts: OpStatements, ops: readonly WriteOp[]): void {
	for (const op of ops) {
		if (op.t === "doc") stmts.doc.run(op.kind, op.key, op.version, op.value);
		else if (op.t === "retire") { stmts.retire.run(op.kind, op.key); stmts.retireParts.run(op.kind, op.key); }
		else if (op.t === "part") stmts.part.run(op.kind, op.key, op.part, op.id, op.ord, op.value, op.at, op.grp, op.flag);
		else if (op.t === "partDel") stmts.partDel.run(op.kind, op.key, op.part, op.id);
		else stmts.meta.run(op.key, op.value);
	}
	stmts.seq.run();
}
