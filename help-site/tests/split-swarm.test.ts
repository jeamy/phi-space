import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { createSpace, FOREVER, listSpaces, Meter, openSqliteHost, PhiSpaces } from "phi-spaces";
import { appendHistory, ensureHistoryHead, historyPage } from "../server/social/history.ts";
import { SocialSwarmHub, type SwarmPost } from "../server/social/swarm.ts";
import { SWARM_ALIAS } from "../server/social/space-side.ts";
import { swarmSpace } from "./swarm-space.ts";

const run = promisify(execFile);

test("split-swarm moves the swarm Space into a store of its own: ids and the history chain stay, held entries are free", async () => {
	const dir = await mkdtemp(join(tmpdir(), "split-swarm-"));
	const from = join(dir, "spaces-eibrain.sqlite"), to = join(dir, "swarm.sqlite");
	try {
		// the help store as the hub wrote it: another Space beside the swarm's, posts with their chain, a held task
		const host = await openSqliteHost(from);
		await host.commit((tx) => createSpace(tx, "space-chat-lobby", Date.now()), ctx);
		const info = await host.commit((tx) => createSpace(tx, SWARM_ALIAS, Date.now()), ctx);
		const s = new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: info.spaceId });
		await ensureHistoryHead(s);
		const head = await s.take({ type: "PostHistoryHead" }, 0);
		await s.write({ type: "PostHistoryHead", fields: { ...head!.fields, ready: true } }, null, FOREVER);
		for (let i = 1; i <= 30; i++) {
			const post: SwarmPost = { postId: `post-${i}`, seq: i, taskId: `t-${i}`, author: "a", handle: "a", name: "A", hue: 0, channel: "home", text: `post ${i}`, replyTo: null, replyToHandle: null, at: 1_000 + i, likes: 0, replies: 0, imageSeed: null, imageAlt: null, imageUrl: null };
			const txn = await s.createTransaction(30_000);
			await appendHistory(s, post, txn.id);
			await s.write({ type: "Post", fields: { ...post } }, txn.id, FOREVER);
			await s.commit(txn.id);
		}
		await s.write({ type: "SwarmTask", fields: { taskId: "held" } }, null, FOREVER);
		const held = await s.createTransaction(60_000);
		assert.ok(await s.take({ type: "SwarmTask" }, 0, { txn: held.id }));
		await s.write({ type: "Post", fields: { postId: "unfinished" } }, held.id, FOREVER);
		const before = (await s.readAll({ type: "PostHistoryNode" }, { limit: 100 })).map((e) => e.id).sort();
		await host.close(ctx);

		const out = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/split-swarm.ts", from, to], { cwd: join(import.meta.dirname, "..") });
		assert.match(out.stdout, /moved \d+ of \d+ entries/);
		await assert.rejects(run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/split-swarm.ts", from, to], { cwd: join(import.meta.dirname, "..") }), /exists/);

		// the new store, opened by the swarm's space process (TypeScript, or the one HELP_SPACE_SERVER names)
		const t = await swarmSpace({ file: to, separate: true });
		const hub = new SocialSwarmHub(t.space, new Meter(), { produce: false, pulses: false, seedContent: false, maxEntries: null });
		try {
			assert.deepEqual((await t.space.readAll({ type: "PostHistoryNode" }, { limit: 100 })).map((e) => e.id).sort(), before, "the nodes keep their ids");
			const page = await historyPage(t.space, { beforeAt: Infinity, beforeId: "", limit: 512 });
			assert.equal(page.candidates.length, 30);
			assert.equal(page.next, "");
			assert.equal(await t.space.count({ type: "Post", fields: { postId: "unfinished" } }), 0, "written under an open transaction: dropped");
			await hub.init(); // the hub's dispatcher takes the task that was held
			const deadline = Date.now() + 10_000;
			while (await t.space.count({ type: "SwarmTask" }) > 0 || (await t.space.probe?.({ type: "SwarmTask" }, 0))?.locked) {
				assert.ok(Date.now() < deadline, "the freed task is processed"); await new Promise((r) => setTimeout(r, 50));
			}
			const id = (await t.space.write({ type: "Probe", fields: {} }, null, 1_000)).id;
			assert.ok(!before.includes(id), "new ids do not collide with the moved ones");

			// the old copy goes once the moved Space answers; the other Space of the help store stays
			const drop = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/drop-moved-swarm.ts", from, t.address!], { cwd: join(import.meta.dirname, "..") });
			assert.match(drop.stdout, /dropped social-swarm .*\d+ entries/);
			const after = await openSqliteHost(from);
			try { assert.deepEqual((await listSpaces(after, ctx)).map((i) => i.alias).filter((a) => a !== "default"), ["space-chat-lobby"]); }
			finally { await after.close(ctx); }
			assert.match((await run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/drop-moved-swarm.ts", from, t.address!], { cwd: join(import.meta.dirname, "..") })).stdout, /already dropped/);
		} finally { await hub.close(); await t.close(); }
		// without an answering moved Space nothing is dropped
		await assert.rejects(run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/drop-moved-swarm.ts", from, `unix:${join(dir, "none.sock")}`], { cwd: join(import.meta.dirname, "..") }));
	} finally { await rm(dir, { recursive: true, force: true }); }
});
