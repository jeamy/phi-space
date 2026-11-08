// An alias (server/accounts.ts setAlias) changes the name shown, nothing else: the login stays, names stay unique.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { Player, startRegions, startWeb } from "./stack.ts";

test("an alias is what others see: the login name stays and no name exists twice", { timeout: 180_000 }, async () => {
	const r = await startRegions();
	const web = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	try {
		const a = new Player(web.url), b = new Player(web.url);
		assert.equal((await a.post("/api/register", { name: "admin", password: "pw-admin-123" })).status, 200);
		assert.equal((await b.post("/api/register", { name: "Berta", password: "pw-berta-123" })).status, 200);
		const me = (await a.play()).me.charId;
		// a building of theirs in another region than it may stand in: the sentences of the world follow the alias everywhere
		const s = r.space(r.ids.at(-1)!);
		await s.write({ type: "Building", fields: { buildId: "b-alias", plan: "huette", name: "Hütte", room: "krabbenbucht", x: 3, y: 3, w: 2, h: 2, owner: me, ownerName: "admin", accountId: "x" } as never }, null, FOREVER);
		const charId = (await a.post("/api/alias", { alias: "Kaiser" }));
		assert.equal(charId.status, 200);
		assert.deepEqual([charId.body.account.name, charId.body.account.alias], ["admin", "Kaiser"]);
		await a.until((f) => f.t === "char" && f.c.name === "Kaiser", 10_000);
		assert.equal((await s.readAll({ type: "Building", fields: { buildId: "b-alias" } }))[0]!.fields.ownerName, "Kaiser");

		// neither someone's login nor someone's alias, an NPC's name neither, and a registration cannot take the alias
		assert.equal((await a.post("/api/alias", { alias: "berta" })).status, 409);
		assert.equal((await b.post("/api/alias", { alias: "kaiser" })).status, 409);
		assert.equal((await a.post("/api/alias", { alias: "Ines" })).status, 409);
		assert.equal((await new Player(web.url).post("/api/register", { name: "KAISER", password: "pw-kaiser-123" })).status, 409);

		// the login is the old name, not the alias
		const again = new Player(web.url);
		assert.equal((await again.post("/api/login", { name: "Kaiser", password: "pw-admin-123" })).status, 403);
		const back = await again.post("/api/login", { name: "admin", password: "pw-admin-123" });
		assert.equal(back.status, 200);
		assert.equal(back.body.account.alias, "Kaiser");

		// back to the login name: the alias is free for others
		const none = await a.post("/api/alias", { alias: "" });
		assert.equal(none.body.account.alias, undefined);
		assert.equal((await b.post("/api/alias", { alias: "Kaiser" })).status, 200);
		await a.leave();
	} finally { await web.close(); await r.close(); }
});
