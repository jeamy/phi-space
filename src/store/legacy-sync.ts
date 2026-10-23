// pi-durable's storage as a store of the primary/sync journal (store/sync-store.ts): its StorageWrites are the deltas,
// the marker is a session document of its own kind. Only types come from pi-durable; the storage object is the
// caller's. It stays until U5 moves replicated pi-durable deployments to the own store.
import type { Storage, StorageWrite, DocumentId, DocumentRecord, Seq } from "@earendil-works/pi-durable";
import type { Context } from "../context.ts";
import { canonicalJson, digestJson } from "../canonical.ts";
import { canonicalCopy } from "../json.ts";
import type { Json } from "../core.ts";
import type { SyncCodec, SyncMarker, SyncStore } from "./sync-store.ts";

const MARKER_KIND = "phi-spaces.primary-sync-storage-marker";
const address = (spaceId: string) => ({ kind: MARKER_KIND, key: spaceId, scope: { kind: "session" as const } });
const canonical = (v: unknown) => canonicalJson(v as Json);

export const LEGACY_CODEC: SyncCodec<StorageWrite> = {
	format: "pi-durable",
	markerWrite: (spaceId, value, existing, newId) => existing !== null
		? { type: "document.change", id: existing as DocumentId, content: { version: 1, kind: "base", value: value as never } }
		: { type: "document.create", record: { ...address(spaceId), id: newId as DocumentId }, content: { version: 1, kind: "base", value: value as never } },
	markerOf: (w, spaceId) => {
		if (w.type !== "document.create" && w.type !== "document.change") return null;
		if (w.content.kind !== "base" || w.content.version !== 1) return null;
		if (w.type === "document.create" && canonical({ kind: w.record.kind, key: w.record.key, scope: w.record.scope }) !== canonical(address(spaceId))) return null;
		return { value: w.content.value, ref: w.type === "document.create" ? w.record.id : w.id };
	},
	touches: (w, ref) => (w.type === "document.create" && w.record.kind === MARKER_KIND) || ((w.type === "document.change" || w.type === "document.retire") && w.id === ref),
	bootstrapWrite: (w) => ["conversation", "entry", "task", "submission", "document.create"].includes(w.type),
};

async function scanAll<T>(scan: (cursor: any) => Promise<{ items: readonly T[]; next?: any }>): Promise<T[]> {
	const out: T[] = [];
	let cursor: any;
	do { const page = await scan(cursor); out.push(...page.items); cursor = page.next; } while (cursor !== undefined);
	return out;
}

/**
 * The complete live content of a store as creates in dependency order (conversations, entries, tasks, submissions,
 * then documents of the session, conversation and task scopes), and its digest. The replication marker is excluded.
 * Only current document state is captured: as-of history of rewindable documents does not replicate.
 */
async function capture(storage: Storage, ctx: Context): Promise<{ writes: StorageWrite[]; digest: string }> {
	// Storage IDs are minted numbers: ascending numeric order is creation order (parents before children).
	const order = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
	const byId = <T extends { id: unknown }>(xs: T[]) => [...new Map(xs.map((x) => [String(x.id), x])).values()].sort((a, b) => order(a.id, b.id));
	const conversations = byId(await scanAll((c) => storage.scanConversations({}, 256, c, ctx)));
	const entries = byId((await Promise.all(conversations.map((c) => scanAll((cur) => storage.scanEntries({ conversationId: c.id }, 256, cur, ctx))))).flat());
	const tasks = byId(await scanAll((c) => storage.scanTasks({}, 256, c, ctx))), submissions = byId(await scanAll((c) => storage.scanSubmissions({}, 256, c, ctx)));
	const scopes = [{ kind: "session" as const }, ...conversations.map((c) => ({ kind: "conversation" as const, conversationId: c.id })), ...tasks.map((t) => ({ kind: "task" as const, taskId: t.id }))];
	const docs: StorageWrite[] = [];
	for (const scope of scopes) for (const r of byId(await scanAll((c) => storage.scanDocuments({ scope: scope as any, at: "current" }, 256, c, ctx)))) {
		if (r.kind === MARKER_KIND) continue;
		const d = await storage.document(r.id, "current", ctx);
		if (!d) throw new Error("document vanished during capture");
		const { createdAt: _c, retiredAt: _r, ...record } = r as DocumentRecord & { retiredAt?: Seq };
		docs.push({ type: "document.create", record: record as any, content: { version: d.version, kind: "base", value: d.value } });
	}
	const writes: StorageWrite[] = [...conversations.map((value) => ({ type: "conversation" as const, value })), ...entries.map((value) => ({ type: "entry" as const, value })), ...tasks.map((value) => ({ type: "task" as const, value })), ...submissions.map((value) => ({ type: "submission" as const, value })), ...docs];
	return { writes: canonicalCopy(writes), digest: digestJson(writes) };
}

const wrapped = new WeakMap<Storage, SyncStore<StorageWrite>>();

/** pi-durable's storage as a SyncStore (the same adapter for the same storage). */
export function legacySyncStore(storage: Storage): SyncStore<StorageWrite> {
	let s = wrapped.get(storage);
	if (s) return s;
	s = {
		codec: LEGACY_CODEC,
		async marker(spaceId, ctx) {
			const record = await storage.findDocument(address(spaceId), "current", ctx);
			if (!record) return null;
			const doc = await storage.document(record.id, "current", ctx);
			if (!doc || doc.version !== 1) throw new Error("storage replication marker missing or invalid");
			return { ref: record.id, value: doc.value as SyncMarker };
		},
		commit: (writes, ctx) => storage.commit(writes, ctx),
		capture: (ctx) => capture(storage, ctx),
		async isEmpty(ctx) {
			const docs = await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 1, undefined, ctx), conversations = await storage.scanConversations({}, 1, undefined, ctx), tasks = await storage.scanTasks({}, 1, undefined, ctx), submissions = await storage.scanSubmissions({}, 1, undefined, ctx);
			return !docs.items.length && !conversations.items.length && !tasks.items.length && !submissions.items.length;
		},
		mintId: () => storage.mintId<DocumentId>(),
	};
	wrapped.set(storage, s);
	return s;
}
