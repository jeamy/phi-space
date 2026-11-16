// Read-only view of an own store file (src/store/sqlite.ts) for the test-bed audits: every document whole, a Space with
// its parts (entries, claims, …) joined in, from one consistent read transaction. Opens no host and takes no owner
// lock, so it reads a live daemon's store as well as a copy.
import { DatabaseSync } from "node:sqlite";
import { SPACE_PARTS } from "../../src/doc.ts";
import { joinParts, type PartRow, type PartSpec } from "../../src/store/parts.ts";

/** The parts of the document kinds that have any (the Spaces); other documents are their row. */
const PARTS: Record<string, readonly PartSpec[]> = { "phi-spaces.space": SPACE_PARTS, "phi-spaces.named-space": SPACE_PARTS };

export function readStoreDocuments(path: string): Array<{ kind: string; key: string; value: any }> {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec("BEGIN");
		const docs: Array<{ kind: string; key: string; value: any }> = [];
		const rowsOf = db.prepare("SELECT part, id, ord, value FROM parts WHERE kind = ? AND key = ? ORDER BY part, ord");
		for (const d of db.prepare("SELECT kind, key, value FROM documents ORDER BY kind, key").all() as Array<{ kind: string; key: string; value: string }>) {
			const parts = PARTS[d.kind];
			let value: any = JSON.parse(d.value);
			if (parts) {
				const rows = new Map<string, PartRow[]>();
				for (const r of rowsOf.all(d.kind, d.key) as Array<{ part: string; id: string; ord: number; value: string }>) {
					if (!rows.has(r.part)) rows.set(r.part, []);
					rows.get(r.part)!.push({ part: r.part, id: r.id, ord: r.ord, value: JSON.parse(r.value) });
				}
				value = joinParts(value, parts, rows);
			}
			docs.push({ kind: d.kind, key: d.key, value });
		}
		db.exec("COMMIT");
		return docs;
	} finally { db.close(); }
}
