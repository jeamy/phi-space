// Budget-bounded snapshot installation under closed admission. Historical pending work is evidence, never executable work.
import { createHash, randomBytes } from "node:crypto";
import * as core from "./core.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import { claimPage, setRestored, type ClaimRec } from "./claims.ts";
import { diskMapOf } from "./store/types.ts";

export type RestoreState = { recoveryId: string; argumentHash: string; snapshotHash: string; incarnation: string; primaryEpoch: number; startedAt: number; waitUntil: number; stage: "entries" | "claims" | "generations" | "gates" | "waiting" | "completed"; cursor: number; kind: "data" | "control";
	/** The claim stage's cursor: which of the source's claim maps (its historical ones first) and the key restored last. */
	claimSource?: "restored" | "rpc"; claimKey?: string };
/** The recovery ID that fences run gates of a restore: the restore ID itself if it is a valid gate ID, else a stable hash. */
export const runRecoveryIdOf = (recoveryId: string): string => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(recoveryId) ? recoveryId : "restore-" + createHash("sha256").update(recoveryId).digest("hex").slice(0, 32);
export const snapshotHash = (s: core.SpaceState): string => digestJson(s);
export type RestoreArgs = { recoveryId: string; expectedDataIncarnation: string; expectedPrimaryEpoch: number; snapshotHash: string; kind: "data" | "control" };
export function beginRestore(s: core.SpaceState, now: number, o: RestoreArgs): RestoreState {
	if (!o.recoveryId || o.recoveryId.length > 256 || !/^[a-f0-9]{64}$/.test(o.snapshotHash) || !["data", "control"].includes(o.kind) || !Number.isSafeInteger(o.expectedPrimaryEpoch) || o.expectedPrimaryEpoch < 0 || !Number.isSafeInteger(o.expectedPrimaryEpoch + 1)) throw new core.IllegalArgumentError("invalid restore identity, snapshot hash or epoch");
	const hash = digestJson(o);
	if (s.restore) { if (s.restore.recoveryId === o.recoveryId && s.restore.argumentHash === hash) return core.plain(s.restore); if (s.restore.stage !== "completed") throw new core.PermissionError("a different restore is already installed"); }
	if (!s.spaceId || s.incarnation !== o.expectedDataIncarnation || (s.primaryEpoch ?? 1) !== o.expectedPrimaryEpoch) throw new core.PermissionError("restore incarnation or epoch precondition failed");
	const restoration: RestoreState = { recoveryId: o.recoveryId, argumentHash: hash, snapshotHash: o.snapshotHash, incarnation: randomBytes(4).toString("hex"), primaryEpoch: o.kind === "control" ? 1 : o.expectedPrimaryEpoch + 1, startedAt: now, waitUntil: now + 62000, stage: "entries", cursor: 0, kind: o.kind };
	// Clearing a collection records one empty assignment, not a rewrite of the old values.
	s.entries = []; s.txns = {}; s.regs = []; s.waiters = []; s.outbox = []; s.jobs = []; s.releaseQueue = []; s.mailboxes = { boxes: {} };
	s.rpc = { generations: {}, claims: {}, bytes: 0, reservedBytes: 0 }; s.restoredClaims = {}; delete s.restoredBytes; s.invalidGenerations = {}; s.nextId = 1;
	s.stream = { rev: 0, floor: 0, bytes: 0, log: [] }; s.incarnation = restoration.incarnation; s.primaryEpoch = restoration.primaryEpoch; s.restore = restoration;
	core.fenceGatesForRestore(s, now, runRecoveryIdOf(o.recoveryId)); // local run gates become historical evidence until the run is reconciled
	core.touch(s, now); return core.plain(s.restore);
}
export function restoreBatch(s: core.SpaceState, now: number, source: core.SpaceState): RestoreState {
	const r = s.restore;
	if (!r || r.stage === "completed") throw new core.PermissionError("no active restore");
	if (source.spaceId !== s.spaceId || snapshotHash(source) !== r.snapshotHash) throw new core.PermissionError("snapshot content or space id changed");
	if (r.stage === "entries") {
		if (r.kind === "control" && !s.entries.some(e => e.type === "Bootstrap")) {
			const marker = core.initialState(); marker.incarnation = r.incarnation;
			core.write(marker, now, { type: "Bootstrap", fields: { state: "closed" } }, null, core.FOREVER);
			if (!core.importRestoredEntry(s, now, marker.entries[0]!)) return core.plain(r);
			s.nextId = Math.max(s.nextId, marker.nextId);
		}
		for (; r.cursor < source.entries.length; r.cursor++) {
			const e = source.entries[r.cursor]!;
			if (e.writtenUnder !== null || e.expires <= now) continue;
			const control = r.kind === "control";
			if (control && ["Enroll", "Bootstrap", "Command", "RouterLease", "FederationPolicy"].includes(e.type)) continue;
			const copy = core.plain(e); copy.takenBy = null; copy.readBy = [];
			if (control && copy.type === "PeerKey") copy.fields.state = "revoked";
			else if (control && copy.type === "Member") copy.fields.state = "recoveryBlocked";
			else if (!control) copy.restoredUnverified = true;
			if (!core.importRestoredEntry(s, now, copy)) return core.plain(r);
		}
		r.stage = "claims"; r.cursor = 0;
	}
	if (r.stage === "claims") {
		// the source's historical claims, then its current ones (a key in both counts once, as its current claim), each in
		// key order from the key restored last: claims on the disk are never listed whole, a map in memory is sorted
		// once per call
		const pager = (map: Record<string, ClaimRec> | undefined) => {
			if (diskMapOf(map)) return (after: string | null) => claimPage(map, after, 64);
			const keys = Object.keys(map ?? {}).sort();
			return (after: string | null) => { let lo = 0, hi = keys.length; while (lo < hi) { const m = (lo + hi) >> 1; if (after !== null && keys[m]! <= after) lo = m + 1; else hi = m; } return keys.slice(lo, lo + 64).map((k) => [k, map![k]!] as [string, ClaimRec]); };
		};
		const sources = { restored: pager(source.restoredClaims), rpc: pager(source.rpc?.claims) };
		for (;;) {
			const from = r.claimSource ?? "restored", page = sources[from](r.claimKey ?? null);
			if (!page.length) { if (from === "rpc") break; r.claimSource = "rpc"; delete r.claimKey; continue; }
			for (const [key, c] of page) {
				if (from === "restored" && source.rpc?.claims[key] !== undefined) { r.claimKey = key; continue; }
				const cost = Buffer.byteLength(JSON.stringify(c)) + Buffer.byteLength(JSON.stringify(key)) + 256;
				const historyBytes = core.claimBytes(s) + cost;
				if (historyBytes > core.limitsOf(s).maxClaimBytes || core.overheadBytes(s) + cost + s.entries.reduce((n, e) => n + (e.size ?? Buffer.byteLength(JSON.stringify(e.fields))), 0) > core.limitsOf(s).maxDocBytes) throw new core.ResourceExhausted("restored history violates current space limits");
				if (cost + 1024 > core.limitsOf(s).maxCommitBytes) throw new core.ResourceExhausted("historical claim does not fit the restore budget");
				if (!core.maintenanceStep(s, cost, now, `restore-claim:${from}:${key}`)) return core.plain(r);
				const copy = core.plain(c); delete copy.reservedResultBytes;
				setRestored(s, key, copy); core.touch(s, now);
				r.claimKey = key;
			}
		}
		r.stage = "generations"; r.cursor = 0; delete r.claimKey; delete r.claimSource; core.touch(s, now);
	}
	if (r.stage === "generations") {
		const generations = [...new Set([...Object.keys(source.invalidGenerations ?? {}), ...Object.keys(source.rpc?.generations ?? {})])];
		for (; r.cursor < generations.length; r.cursor++) {
			const id = generations[r.cursor]!;
			const cost = Buffer.byteLength(JSON.stringify(id)) + 64, lim = core.limitsOf(s);
			if (cost + 1024 > lim.maxCommitBytes || core.claimBytes(s) + cost > lim.maxClaimBytes || core.overheadBytes(s) + cost + s.entries.reduce((n, e) => n + (e.size ?? Buffer.byteLength(JSON.stringify(e.fields))), 0) > lim.maxDocBytes) throw new core.ResourceExhausted("restored generation violates current space limits");
			if (!core.maintenanceStep(s, cost, now, `restore-generation:${r.cursor}`)) return core.plain(r);
			s.invalidGenerations![id] = true; core.touch(s, now);
		}
		r.stage = "gates"; r.cursor = 0; core.touch(s, now);
	}
	if (r.stage === "gates") { // run gates of the snapshot: compact evidence, never an executable transition
		const runs = Object.keys(source.runGates ?? {}).sort();
		for (; r.cursor < runs.length; r.cursor++) {
			const g = source.runGates![runs[r.cursor]!]!, cost = 1024;
			if (!core.maintenanceStep(s, cost, now, `restore-gate:${r.cursor}`)) return core.plain(r);
			core.importRestoredGate(s, now, g, runRecoveryIdOf(r.recoveryId));
		}
		r.stage = "waiting"; r.cursor = 0; core.touch(s, now);
	}

	return core.plain(r);
}
/** Only after fencing, control acknowledgement and matching external/local boot installation have been verified by the caller. */
export function completeRestore(s: core.SpaceState, now: number, recoveryId: string): void {
	if (s.restore?.recoveryId === recoveryId && s.restore.stage === "completed") return;
	if (!s.restore || s.restore.recoveryId !== recoveryId || s.restore.stage !== "waiting" || now < s.restore.waitUntil) throw new core.PermissionError("restore cannot be released before acknowledgement and old grant expiry");
	s.restore.stage = "completed"; core.touch(s, now);
}
export function releaseRestored(s: core.SpaceState, now: number, recoveryId: string, scope: { type?: string; runId?: string; entryIds?: string[] }): number {
	if (!s.restore || s.restore.recoveryId !== recoveryId || s.restore.stage !== "completed") throw new core.PermissionError("restored data is not active");
	if (!scope.type && !scope.runId && !scope.entryIds?.length) throw new core.IllegalArgumentError("explicit restore release scope required");
	let count = 0;
	for (const e of s.entries) if (e.restoredUnverified && (!scope.type || e.types.includes(scope.type)) && (!scope.runId || e.fields.runId === scope.runId) && (!scope.entryIds || scope.entryIds.includes(e.id))) {
		if (!core.releaseRestoredEntry(s, now, e)) break;
		count++;
	}
	return count;
}
