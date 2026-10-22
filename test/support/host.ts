// The host a test runs on: PHI_SPACES_STORE=own gives phi-spaces' own store host (docs/umstellung-ohne-pi-durable.md,
// U2), anything else the pi-durable host of the move (store/legacy.ts). The same suite thus checks both.
import type { Context } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { openMemoryStore } from "../../src/store/legacy.ts";
import type { ClosableStoreHost } from "../../src/store/types.ts";

/** Which store the tests run on. */
export const STORE = process.env.PHI_SPACES_STORE === "own" ? "own" : "legacy";

/** A throwaway host in memory, of the store the tests run on. */
export async function openTestHost(ctx: Context): Promise<ClosableStoreHost> {
	return STORE === "own" ? openOwnMemoryHost() : openMemoryStore(ctx);
}
