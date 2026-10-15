// Durable callers store the returned clock atomically with the corresponding entry change.
export type HybridClock = { physical: number; logical: number };
export class ReplicationClockError extends Error {}
export function validateHybridClock(value: HybridClock): void {
 if (!value || Object.keys(value).sort().join(',') !== 'logical,physical' || !Number.isSafeInteger(value.physical) || value.physical < 0 || !Number.isSafeInteger(value.logical) || value.logical < 0) throw new ReplicationClockError('invalid hybrid clock');
}
export function compareHybridClock(a: HybridClock, b: HybridClock): number {
 return a.physical < b.physical ? -1 : a.physical > b.physical ? 1 : a.logical < b.logical ? -1 : a.logical > b.logical ? 1 : 0;
}
export function advanceHybridClock(local: HybridClock, now: number, remote?: HybridClock, maxFutureMs = 60000): HybridClock {
 validateHybridClock(local);
 if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxFutureMs) || maxFutureMs < 0) throw new ReplicationClockError('invalid clock time or future bound');
 if (remote) { validateHybridClock(remote); if (remote.physical - now > maxFutureMs) throw new ReplicationClockError('remote clock exceeds future bound'); }
 const physical = Math.max(now, local.physical, remote?.physical ?? 0);
 const logical = physical === local.physical && physical === remote?.physical ? Math.max(local.logical, remote.logical) + 1
  : physical === local.physical ? local.logical + 1 : physical === remote?.physical ? remote.logical + 1 : 0;
 if (!Number.isSafeInteger(logical)) throw new ReplicationClockError('hybrid clock exhausted');
 return { physical, logical };
}
