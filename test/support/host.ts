// The host a test runs on (docs/umstellung-ohne-pi-durable.md, U2):
//   PHI_SPACES_STORE=own          phi-spaces' own store host, in memory
//   PHI_SPACES_STORE=own-sqlite   phi-spaces' own store host on a SQLite file (a temporary one per host)
//   anything else                 the pi-durable host of the move (store/legacy.ts)
// The same suite thus checks every store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { openMemoryStore } from "../../src/store/legacy.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { diskMapOf, type ClosableStoreHost } from "../../src/store/types.ts";

/** Which store the tests run on. */
/** A document as plain JSON, with a map part on the disk read whole (enumerating one fails in these tests). */
export const plainDoc = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => { const d = diskMapOf(x); return d ? Object.fromEntries(d.entries()) : x; })) as T;

export const STORE = process.env.PHI_SPACES_STORE === "own" ? "own" : process.env.PHI_SPACES_STORE === "own-sqlite" ? "own-sqlite" : "legacy";

let dir: string | null = null, n = 0;
const fileFor = () => {
	if (!dir) { dir = mkdtempSync(join(tmpdir(), "phi-spaces-store-")); process.once("exit", () => rmSync(dir!, { recursive: true, force: true })); }
	return join(dir, `${++n}.sqlite`);
};

/** A throwaway host of the store the tests run on. */
export async function openTestHost(ctx: Context): Promise<ClosableStoreHost> {
	if (STORE === "own") return openOwnMemoryHost();
	if (STORE === "own-sqlite") return openSqliteHost(fileFor(), { strictDiskMaps: true }); // a scan of the claims fails the test
	return openMemoryStore(ctx);
}
