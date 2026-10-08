// The Session-scoped document that holds the default space (named spaces: spaces.ts). Its own module so that client.ts and meter.ts can both use it
// without importing each other (a cycle that only worked as long as nothing used the other side at load time).
import { defineDoc } from "@earendil-works/pi-durable";
import * as core from "./core.ts";
import type { SpaceState } from "./core.ts";

export const Space = defineDoc<SpaceState & Record<string, any>>({
	kind: "pi-spaces.space",
	version: 5, // 5: spaceId and incarnation (named spaces, see spaces.ts)
	scope: "session",
	initial: () => core.initialState() as SpaceState & Record<string, any>,
	migrate: (v, from) => core.migrate(v, from) as SpaceState & Record<string, any>,
});
