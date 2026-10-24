// Atomic client projection: publish only a complete snapshot plus contiguous deltas.
import type { SpaceLike } from "phi-spaces";
import { SnapshotExpired, RevisionAhead, type EntryView } from "phi-spaces/core";

export type LiveMirror = { streamId: string; rev: number; entries: Map<string, EntryView> };
type Reader = Pick<SpaceLike, "readPage" | "changes">;

export async function refreshMirror(space: Reader, previous?: LiveMirror, maxAttempts = 3): Promise<LiveMirror> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			let mirror: LiveMirror;
			if (previous) mirror = { ...previous, entries: new Map(previous.entries) };
			else {
				const first = await space.readPage(null, { maxBytes: 192_000 });
				mirror = { streamId: first.streamId, rev: first.rev, entries: new Map(first.items.map(e => [e.id, e])) };
				let page = first;
				while (page.next !== null) {
					page = await space.readPage(null, { token: first.token, after: page.next, maxBytes: 192_000 });
					if (page.streamId !== first.streamId || page.rev !== first.rev) throw new SnapshotExpired("Snapshot identity changed");
					for (const entry of page.items) mirror.entries.set(entry.id, entry);
				}
			}
			while (true) {
				const delta = await space.changes(mirror.rev, { maxBytes: 192_000 });
				if (delta.streamId !== mirror.streamId) throw new SnapshotExpired("Stream identity changed");
				for (const batch of delta.batches) for (const op of batch.ops) {
					if (op.op === "del") mirror.entries.delete(op.id);
					else mirror.entries.set(op.id, { id: op.id, type: op.type, types: op.types, fields: op.fields, owner: op.owner, ...(op.restoredUnverified ? { restoredUnverified: true } : {}) });
				}
				if (delta.more && delta.next <= mirror.rev) throw new Error("Change cursor did not advance");
				mirror.rev = delta.next;
				if (!delta.more) return mirror;
			}
		} catch (error) {
			if (!(error instanceof SnapshotExpired || error instanceof RevisionAhead)) throw error;
			previous = undefined; // Retry from scratch; never append a new baseline to old state.
			if (attempt + 1 === maxAttempts) throw error;
		}
	}
	throw new Error("No mirror attempt available");
}
