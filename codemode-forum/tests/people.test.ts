// Sections written by people (docs/forum-seite-plan-2026-11-26.en.md, section 6, phase 7): a person's section and a
// model's on the same base. Whoever comes second is told the newer text: a model that revises after the person gets
// the person's text in its next try, and a person who writes after a model gets the model's text back and decides.
import test from "node:test";
import assert from "node:assert/strict";
import type { Snapshot } from "../server/hub.ts";
import { headOf, writeVersion } from "../server/plandoc.ts";
import { startServer } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan an app that shows the starry sky at a time and place.";
let seq = 0;
const room = (scenario: string) => `${scenario}-p${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

test("a person writes a section while a model's revision of it waits: the model is told the person's text", async (t) => {
	const srv = await startServer({ fakes: THREE });
	t.after(() => srv.close());
	const space = srv.stack.space, id = room("bhold");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "parallel" })).status, 200);
	await until("the revision to be asked for", async () => (await space.count({ type: "FakeCall", fields: { session: id, kind: "revise" } })) >= 1);
	const open = (await space.readAll({ type: "PlanObjection", fields: { session: id, blockId, table: "B", state: "open" } }, { limit: 10 })).map((e) => e.fields as { sectionId: string });
	const sectionId = open[0]!.sectionId, head = (await headOf(space, { session: id, blockId, table: "B" }))!;
	const rev = head.sections.find((x) => x.sectionId === sectionId)!.rev;
	const mine = await post(srv.url, `/api/rooms/${id}/section`, { blockId, table: "B", sectionId, base: rev, text: "The target value is 256, says Lea, with the reason in the brief.", by: "Lea" });
	assert.equal(mine.status, 200, JSON.stringify(mine.body));
	const after = (await headOf(space, { session: id, blockId, table: "B" }))!.sections.find((x) => x.sectionId === sectionId)!;
	assert.deepEqual([after.rev, after.author, after.model], [rev + 1, "Lea", "human"]);
	await space.write({ type: "FakeGate", fields: { session: id } }, null, 60_000);
	await until("the end of the run", async () => { const s = await snapshot(srv.url, id); return s.run && !s.run.active ? s : null; });
	// the held revision was written against the revision before the person's: not let in, tried again with her text
	const revises = (await space.readAll({ type: "FakeCall", fields: { session: id, kind: "revise" } }, { limit: 20 })).map((e) => e.fields as { prompt: string });
	assert.ok(revises.length >= 2, `${revises.length} revise calls`);
	assert.ok(revises.some((c) => c.prompt.includes("The target value is 256, says Lea")), "a revision was asked with the person's text");
	assert.ok((await snapshot(srv.url, id)).lines.some((l) => /Lea wrote the section/.test(l.text)));
});

test("a person who writes after a model gets the model's text back, and a new section of hers goes at the end", async (t) => {
	const srv = await startServer({ fakes: THREE });
	t.after(() => srv.close());
	const space = srv.stack.space, id = room("people");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	const write = async (author: string, model: string, r: Parameters<typeof writeVersion>[5]) => { const t = await space.createTransaction(30_000); await writeVersion(space, t.id, 3600_000, { session: id, blockId, table: "A" }, { author, model }, r); await space.commit(t.id); };
	await write("M1", "fake/alpha", { changes: [{ title: "Goal", text: "Show the sky." }] });
	// the page showed revision 1; a model revises first
	await write("M2", "fake/beta", { changes: [{ sectionId: "s1", base: 1, text: "Show the sky at a time and place." }] });
	const late = await post(srv.url, `/api/rooms/${id}/section`, { blockId, table: "A", sectionId: "s1", base: 1, text: "Show the sky, says Lea.", by: "Lea" });
	assert.equal(late.status, 409);
	assert.deepEqual([late.body.stale.rev, late.body.stale.text, late.body.stale.author], [2, "Show the sky at a time and place.", "M2"]);
	assert.equal((await headOf(space, { session: id, blockId, table: "A" }))!.version, 2);
	// she writes against the newer text now
	assert.deepEqual((await post(srv.url, `/api/rooms/${id}/section`, { blockId, table: "A", sectionId: "s1", base: 2, text: "Show the sky at a time and place, says Lea.", by: "Lea" })).body, { ok: true, version: 3 });
	assert.deepEqual((await post(srv.url, `/api/rooms/${id}/section`, { blockId, table: "A", title: "Open questions", text: "Which catalogue?", after: "s1", by: "Lea" })).body, { ok: true, version: 4 });
	const head = (await headOf(space, { session: id, blockId, table: "A" }))!;
	assert.deepEqual(head.sections.map((x) => [x.title, x.rev, x.author]), [["Goal", 3, "Lea"], ["Open questions", 1, "Lea"]]);
	assert.match((await post(srv.url, `/api/rooms/${id}/section`, { blockId, table: "A", title: "Goal", text: "Twice.", by: "Lea" })).body.error, /same title/);
	assert.match((await post(srv.url, `/api/rooms/${id}/section`, { blockId, table: "A", sectionId: "s1", text: "No base.", by: "Lea" })).body.error, /revision the change was written against/);
});
