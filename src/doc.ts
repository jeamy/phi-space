// The Session-scoped document that holds the space. Its own module so that client.ts and meter.ts can both use it
// without importing each other (a cycle that only worked as long as nothing used the other side at load time).
import { defineDoc } from "@earendil-works/pi-durable";
import * as core from "./core.ts";
import type { SpaceState } from "./core.ts";

export const Space = defineDoc<SpaceState & Record<string, any>>({
	kind: "pi-spaces.space",
	version: 4,
	scope: "session",
	initial: () => core.initialState() as SpaceState & Record<string, any>,
	migrate: (v, from) => core.migrate(v, from) as SpaceState & Record<string, any>,
});
