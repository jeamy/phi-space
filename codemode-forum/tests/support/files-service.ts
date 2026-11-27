// spaces-files in memory with one agent socket (spaces-files/tests/support/agent-host-fixture.ts, started as a
// process), for the tests that link a room to it: `cmd` sends one fixture command and returns its answer, `must` the
// value of one that has to succeed, `env` the variables of a sources process that reaches it.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../../../spaces-files/tests/support/agent-host-fixture.ts", import.meta.url));

export type FilesService = Awaited<ReturnType<typeof filesService>>;
export async function filesService() {
	const dir = mkdtempSync(join(tmpdir(), "ff-"));
	chmodSync(dir, 0o700);
	const socket = join(dir, "agent.sock");
	const child: ChildProcess = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", FIXTURE, socket], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
	assert.deepEqual(JSON.parse(String((await lines.next()).value)), { ready: true });
	let chain = Promise.resolve() as Promise<unknown>;
	const cmd = (c: Record<string, unknown>): Promise<{ ok: boolean; value?: any; code?: string; message?: string }> => {
		const next = chain.then(async () => { child.stdin!.write(JSON.stringify(c) + "\n"); return JSON.parse(String((await lines.next()).value)); });
		chain = next.catch(() => {});
		return next as Promise<any>;
	};
	const must = async (c: Record<string, unknown>) => { const r = await cmd(c); assert.ok(r.ok, `${JSON.stringify(c)}: ${r.message}`); return r.value; };
	return { socket, cmd, must, env: { FORUM_FILES_SOCKET: socket, FORUM_FILES_TENANT: "acme", FORUM_FILES_HOST: "forum-host" },
		async close() { child.stdin!.end(); await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); }); child.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); } };
}
