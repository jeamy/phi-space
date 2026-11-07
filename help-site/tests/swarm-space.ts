// The swarm Space of a test. By default it lives in this process (space-side.ts, memory). `HELP_SPACE_SERVER` names a
// separate space process instead, reached over a unix socket the way the hub reaches it in production:
// `rust/target/release/phi-space-server` (started with `--profile help`) or `server/space-host.ts` (the TypeScript one).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { connectSpace, type Meter } from "phi-spaces";
import type { SwarmSpace } from "../server/social/batch.ts";
import { openSwarmSide, SWARM_ALIAS, type SwarmSide } from "../server/social/space-side.ts";
import { retentionConfig } from "../server/social/retention.ts";

const SERVER = process.env.HELP_SPACE_SERVER || null;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const separateSpace = SERVER !== null;

export interface TestSwarmSpace {
	space: SwarmSpace;
	/** The store, when it is in this process (null against a separate server). */
	side: SwarmSide | null;
	close(): Promise<void>;
}

function command(): { cmd: string; args: string[] } {
	if (SERVER!.endsWith(".ts")) return { cmd: process.execPath, args: ["--experimental-strip-types", "--no-warnings", resolve(ROOT, SERVER!)] };
	return { cmd: SERVER!, args: ["--profile", "help"] };
}

/** `maxEntries`: the cap of the space side's purge (null: no purge; the default). `retentionMs`: how often it looks.
 *  `inProcess`: always in this process (a test that serves or cuts the store itself). */
export async function swarmSpace(o: { maxEntries?: number | null; retentionMs?: number; meter?: Meter; inProcess?: boolean; file?: string } = {}): Promise<TestSwarmSpace> {
	const maxEntries = o.maxEntries ?? null;
	if (!SERVER || o.inProcess) {
		const side = await openSwarmSide(ctx, { file: o.file ?? null, retention: maxEntries === null ? null : retentionConfig(maxEntries), meter: o.meter, retentionMs: o.retentionMs });
		return { space: side.space, side, close: () => side.close() };
	}
	const dir = await mkdtemp(join(tmpdir(), "swarm-space-"));
	const listen = `unix:${join(dir, "s.sock")}`;
	const { cmd, args } = command();
	const child: ChildProcess = spawn(cmd, args, {
		cwd: ROOT,
		env: { ...process.env, ...(o.file ? { SWARM_MEM: "0", SWARM_DB: o.file } : { SWARM_MEM: "1" }), SWARM_LISTEN: listen, SWARM_MAX_ENTRIES: String(maxEntries ?? 0), SWARM_RETENTION_MS: String(o.retentionMs ?? 10_000) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let err = "";
	child.stderr!.on("data", (d) => { err += d; });
	await new Promise<void>((ok, fail) => {
		let out = "";
		const timer = setTimeout(() => fail(new Error(`space server did not start: ${err}`)), 20_000);
		child.stdout!.on("data", (d) => { out += d; if (out.includes("[space] ready")) { clearTimeout(timer); ok(); } });
		child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`space server ended (${code}): ${err}`)); });
	});
	const c = connectSpace(listen, { space: SWARM_ALIAS, callTimeoutMs: 30_000 });
	return {
		space: c.space, side: null,
		close: async () => {
			c.close();
			const gone = new Promise((r) => child.once("exit", r));
			child.kill("SIGTERM");
			await gone;
			await rm(dir, { recursive: true, force: true });
		},
	};
}
