// Starts the filesystem service (docs/zanzibar-agent-filesystem-plan.en.md). Phase 1 so far: the store with its owner
// lock, the reaper, admission and the deployment state; the adapters follow.
//
//   FILES_DATA_DIR=…/data   (default: spaces-files/.local/data; created with mode 700, refused if others can reach it)
//   FILES_STATE_DIR=…/state (default: spaces-files/.local/state; the deployment state, never inside the data directory)
//   FILES_MEM=1             in memory, throwaway
import { ROOT, loadDotEnv } from "./env.ts";
import { join } from "node:path";
import { FilesService } from "./service.ts";

loadDotEnv();
const mem = process.env.FILES_MEM === "1";
const dataDir = mem ? null : process.env.FILES_DATA_DIR || join(ROOT, ".local", "data");
const stateDir = mem ? null : process.env.FILES_STATE_DIR || join(ROOT, ".local", "state");

// The handlers come first: whoever reads the ready line may signal at once, before another statement of this file runs.
let service: FilesService | undefined;
let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	setTimeout(() => process.exit(0), 3000).unref();
	await service?.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try { service = await FilesService.open({ dataDir, stateDir }); }
catch (e) {
	console.error(`[files] cannot start: ${(e as Error).message}`);
	process.exit(1);
}
if (stopping) { await service.close(); process.exit(0); }
// nothing listens yet: keep the process (and the owner lock) alive until a signal
setInterval(() => {}, 1 << 30);
// the tests wait for this line
console.log(`[files] ready (store ${service.storePath ?? "memory"})`);
