// The move of a world that ran as one space into its regions (server/migrate-regions.ts): every character exactly once,
// in the region of its room, no coin lost or made, and the moved world plays.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer as startWeb } from "../server/index.ts";
import { Player, startRegions, startServer, startStack } from "./stack.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("a world of one space moves into its regions: every character once, every coin kept, the moved world plays", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "mmo-migrate-"));
	try {
		// the world as one space, on SQLite, with a guest in it
		const stack = await startStack({ dataDir });
		const srv = await startServer({ stack });
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/guest")).status, 200);
		const me = (await p.play()).me.charId;
		await p.leave();
		const chars = (await stack.space.readAll({ type: "Character" })).map((e) => String(e.fields.charId)).sort();
		const coins = (await stack.space.readAll({ type: "Coin" })).length;
		await srv.close(); await stack.close();
		// the regions, empty; the move; then their world workers
		const r = await startRegions({ workers: false });
		try {
			const code = await new Promise<number | null>((ok) => {
				const c = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "server/migrate-regions.ts"], { cwd: ROOT, env: { ...process.env, SPACES_MMO_DATA: dataDir, SPACES_MMO_REGIONS: r.list }, stdio: ["ignore", "inherit", "inherit"] });
				c.on("exit", ok);
			});
			assert.equal(code, 0);
			await r.workers();
			const after: string[] = [];
			let coinsAfter = 0;
			for (const id of r.ids) {
				after.push(...(await r.space(id).readAll({ type: "Character" })).map((e) => String(e.fields.charId)));
				coinsAfter += (await r.space(id).readAll({ type: "Coin" })).length;
			}
			assert.deepEqual(after.sort(), chars, "every character exactly once (no NPC made twice)");
			assert.equal(coinsAfter, coins, "every coin kept");
			assert.equal((await r.space("west").readAll({ type: "Character", fields: { charId: me } })).length, 1, "the guest in the west, where it stood");
			// and the moved world plays (the accounts space is not moved: on the servers it stays as it is)
			const web = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
			try {
				const q = new Player(web.url);
				assert.equal((await q.post("/api/guest")).status, 200);
				assert.ok((await q.play()).room.roomId);
			} finally { await web.close(); }
		} finally { await r.close(); }
	} finally { await rm(dataDir, { recursive: true, force: true }); }
});
