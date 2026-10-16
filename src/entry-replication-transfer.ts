// Persistent transfer metadata and immutable page storage. No public RPC or implicit authorization.
import { defineDocFamily } from '@earendil-works/pi-durable';
import type { ReplicatedEntryChange } from './entry-replication.ts';
export type EntrySnapshotManifest = {
 version: 1; id: string; spaceId: string; authorityId: string; configHash: string;
 sourceReplicaId: string; sourceIncarnation: string; revision: number;
 eventCount: number; bytes: number; pageBytes: number; pageCount: number;
 expiresAt: number; seedHash: string; rootHash: string;
};
export type EntrySnapshotPage = { snapshotId: string; index: number; offset: number; next: number; events: ReplicatedEntryChange[]; previousHash: string; sha256: string };
export type EntrySnapshotSegment = { manifest: EntrySnapshotManifest; overlayThrough: number };
export type EntrySnapshotImport = {
 maintenanceRequestId?: string; manifest: EntrySnapshotManifest; phase: 'receiving' | 'completed' | 'aborting' | 'aborted' | 'consolidating' | 'retiring' | 'retired';
 nextPage: number; nextOffset: number; chainHash: string; receivedBytes: number;
 reservedBytes: number; cleanupCursor: number; result?: { added: number; revision: number; sourceRevision: number };
};
export type EntrySnapshotTransfersState = { retainedBytes: number; transfers: Record<string, EntrySnapshotImport> };
export const EntrySnapshotTransfers = defineDocFamily<EntrySnapshotTransfersState, null>({ kind: 'pi-spaces.entry-snapshot-transfers', version: 1, scope: 'session', family: true, initial: () => ({ retainedBytes: 0, transfers: {} }) });
export const EntrySnapshotChunks = defineDocFamily<{ page: EntrySnapshotPage | null }, null>({ kind: 'pi-spaces.entry-snapshot-chunk', version: 1, scope: 'session', family: true, initial: () => ({ page: null }) });

export type EntrySnapshotMaintenanceJob = {
 requestId: string; phase: 'copying' | 'cleaning' | 'completed';
 manifest: EntrySnapshotManifest; nextPage: number; overlayCount: number;
 previous: Array<{ snapshotId: string; pageCount: number; nextPage: number }>;
};
/** One durable, bounded replacement job; old pages remain reachable until publication. */
export const EntrySnapshotMaintenance = defineDocFamily<{ job: EntrySnapshotMaintenanceJob | null }, null>({ kind: 'pi-spaces.entry-snapshot-maintenance', version: 1, scope: 'session', family: true, initial: () => ({ job: null }) });
