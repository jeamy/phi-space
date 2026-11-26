// Scale (docs/zanzibar-agent-filesystem-plan.en.md, section 8, scale; measurements in docs/operator-guide.en.md):
// paginated listings whose every page rechecks access, with cursors bound to tenant, actor and directory; a directory
// larger than one reply is listed by pages and refused whole.
import test from "node:test";
import assert from "node:assert/strict";
import { FilesService } from "../server/service.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };

async function setup() {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, limits: { maxDirEntries: 40, maxListPage: 8 } });
	await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	const by = { actorKind: "user" as const, actorId: "adm" };
	for (const u of ["lea", "max"]) await s.provisionActor("acme", by, "user", u, u, { issuer: "i", subject: u });
	const h: Record<string, string> = {};
	for (const u of ["adm", "lea", "max"]) h[u] = (await s.login("acme", "user", { issuer: "i", subject: u })).handle;
	const id = async (who: string) => (await s.issueOperationIds(h[who], 1))[0];
	await s.grant(h.lea, "lea", ".", "viewer", { kind: "user", id: "max" }, await id("lea"));
	await s.mkdir(h.lea, "lea", "big", await id("lea"));
	for (let i = 0; i < 20; i++) await s.write(h.lea, "lea", `big/f${String(i).padStart(2, "0")}`, Buffer.from("x"), 0, await id("lea"));
	return { s, h, id };
}

test("pages: in name order, every page rechecks access, cursors are bound and do not outlive the process", async () => {
	const { s, h, id } = await setup();
	try {
		await assert.rejects(s.list(h.max, "lea", "big"), code("capacityExceeded"), "larger than one reply: by pages");
		const names: string[] = [];
		let cursor: string | null = null, pages = 0;
		do {
			const p = await s.listPage(h.max, "lea", "big", cursor, 6);
			names.push(...p.entries.map((e) => e.name));
			cursor = p.next; pages++;
			// an entry created mid-listing appears exactly when its name sorts after the cursor
			if (pages === 1) { await s.write(h.lea, "lea", "big/a-early", Buffer.from("x"), 0, await id("lea")); await s.write(h.lea, "lea", "big/z-late", Buffer.from("x"), 0, await id("lea")); }
		} while (cursor !== null);
		assert.equal(pages, 4);
		assert.deepEqual(names, [...Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}`), "z-late"]);
		await assert.rejects(s.listPage(h.max, "lea", "big", null, 9), code("invalidInput"), "above maxListPage");

		// a cursor is the caller's, for this directory, in this process
		const first = await s.listPage(h.max, "lea", "big", null, 4);
		await assert.rejects(s.listPage(h.lea, "lea", "big", first.next, 4), code("invalidInput"), "another actor's cursor");
		await s.mkdir(h.lea, "lea", "other", await id("lea"));
		await assert.rejects(s.listPage(h.max, "lea", "other", first.next, 4), code("invalidInput"), "another directory's cursor");
		await assert.rejects(s.listPage(h.max, "lea", "big", first.next!.replace(/^./, (c) => c === "A" ? "B" : "A"), 4), code("invalidInput"), "a forged cursor");
		await assert.rejects(s.listPage(h.max, "lea", "big", `${first.next!.split(".")[0]}.f99`, 4), code("invalidInput"), "a cursor for another name");

		// after the revocation the next page answers like the first call would
		await s.revoke(h.lea, "lea", ".", "viewer", { kind: "user", id: "max" }, await id("lea"));
		await assert.rejects(s.listPage(h.max, "lea", "big", first.next, 4), code("notFound"));
	} finally { await s.close(); }
});
