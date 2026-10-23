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
	// the historical claims after a restore: as many, on the disk as well (counted by restoredBytes, walked by key)
	{ path: ["restoredClaims"], kind: "map", disk: { at: "decidedAt", group: "generation", flag: "resultExpired" } },
	{ path: ["rpc", "generations"], kind: "map" },
	{ path: ["stream", "log"], kind: "array" },
] as const;

export const Space = defineDoc<SpaceState & Record<string, any>>({
	kind: "phi-spaces.space",
	version: 5, // 5: spaceId and incarnation (named spaces, see spaces.ts)
	scope: "session",
	initial: () => core.initialState() as SpaceState & Record<string, any>,
	migrate: (v, from) => core.migrate(v, from) as SpaceState & Record<string, any>,
	parts: SPACE_PARTS,
});


