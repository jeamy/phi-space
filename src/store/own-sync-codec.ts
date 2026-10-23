// The own SQLite store's writes as the primary/sync journal checks them (store/sync-store.ts): row changes
// (store/sqlite-ops.ts), and the marker as a store_meta value written in the same transaction as the data it marks.
import type { SyncCodec } from "./sync-store.ts";
import type { WriteOp } from "./sqlite-ops.ts";

const PREFIX = "sync-marker:";
export const markerKey = (spaceId: string) => `${PREFIX}${spaceId}`;

export const OWN_CODEC: SyncCodec<WriteOp> = {
	format: "own",
	markerWrite: (spaceId, value) => ({ t: "meta", key: markerKey(spaceId), value: JSON.stringify(value) }),
	markerOf: (w, spaceId) => {
		if (w.t !== "meta" || w.key !== markerKey(spaceId)) return null;
		try { return { value: JSON.parse(w.value), ref: w.key }; } catch { return null; }
	},
	touches: (w) => w.t === "meta" && w.key.startsWith(PREFIX),
	bootstrapWrite: (w) => w.t === "doc" || w.t === "part",
};
