// The Session-scoped document that holds the default space (named spaces: spaces.ts). Its own module so that client.ts and meter.ts can both use it
// without importing each other (a cycle that only worked as long as nothing used the other side at load time).
import { defineDoc } from "./store/documents.ts";
import * as core from "./core.ts";
import type { SpaceState } from "./core.ts";

/** The big collections of a Space, whose records are values (replaced, never changed in place): the own store drafts
 *  them without copying and keeps them as rows of their own. */
export const SPACE_PARTS = [
	{ path: ["entries"], kind: "array" },
	// a day of claims is far more than memory should hold (docs/umstellung-ohne-pi-durable.md, U2c): on the disk, by key;
	// indexed by decision time, generation and dropped result for the sweep (claims.ts)
	{ path: ["rpc", "claims"], kind: "map", disk: { at: "decidedAt", group: "generation", flag: "resultExpired" } },
	{ path: ["rpc", "generations"], kind: "map" },
	{ path: ["stream", "log"], kind: "array" },
] as const;

export const Space = defineDoc<SpaceState & Record<string, any>>({
	kind: "phi-spaces.space",
	version: 5, // 5: spaceId and incarnation (named spaces, see spaces.ts)
	scope: "session",
	initial: () => core.initialState() as SpaceState & Record<string, any>,
	migrate: (v, from) => core.migrate(v, from) as SpaceState & Record<string, any>,
	// Compact the delta tail periodically: without a base every read replays the
	// whole journal, so unbounded spaces degrade to O(history) per read.
	checkpointWhen: (v, _ops, info) => checkpointDue(v, info),
	parts: SPACE_PARTS,
});

let checkpointLimit = Infinity;
/**
 * Caps the size of a base written for a Space (process-wide, only ever lowered). A base is one write of the whole
 * value, and a primary/sync journal takes a bounded commit (docs/abnahme/ap3-primary-sync.md): a larger base would refuse
 * every later commit of that Space. primarySyncStorage sets it from its journal; without it nothing changes.
 */
export function limitCheckpointBytes(bytes: number): void { checkpointLimit = Math.min(checkpointLimit, bytes); }
/** A base every 500 deltas; under a cap only if the value fits, tried again every 50 deltas (else the tail stays). */
export function checkpointDue(value: unknown, info: { deltasSinceBase: number }): boolean {
	if (info.deltasSinceBase < 500) return false;
	if (checkpointLimit === Infinity) return true;
	return info.deltasSinceBase % 50 === 0 && Buffer.byteLength(JSON.stringify(value)) <= checkpointLimit;
}
