// A room as a project (docs/forum-seite-plan-2026-11-26.en.md, section 6, phase 7): a task is a plan or a document,
// a document is held against its own criteria and its prompts speak of a document; a task may read the room's other
// documents as they stand when it is created (the accepted version where there is one), and a later version of them
// does not move under it.
import test from "node:test";
import assert from "node:assert/strict";
import type { Snapshot } from "../server/hub.ts";
import { headOf, writeVersion, type Revision } from "../server/plandoc.ts";
import { DOCUMENT_CRITERIA, FIXED_CRITERIA } from "../server/plantask.ts";
import { askSources } from "../server/source-host.ts";
import { startServer } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
let seq = 0;
const room = (scenario: string) => `${scenario}-k${process.pid}-${seq++}`;
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

test("a document is held against its own criteria and its prompts say document; a plan's say plan", async (t) => {
	const srv = await startServer({ fakes: THREE });
	t.after(() => srv.close());
	const id = room("pictures"), space = srv.stack.space;
	assert.match((await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the requirements of an app that shows the sky.", kind: "document" })).body.error, /needs a name/);
	assert.match((await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the requirements of an app that shows the sky.", kind: "letter", name: "x" })).body.error, /a plan or a document/);
	const doc = await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the requirements of an app that shows the sky.", kind: "document", name: "requirements", criteria: "Every requirement can be tested." });
	assert.equal(doc.status, 200, JSON.stringify(doc.body));
	assert.match((await post(srv.url, `/api/rooms/${id}/task`, { brief: "Another document of the same name here.", kind: "document", name: "Requirements" })).body.error, /named Requirements already|named requirements already/i);
	const s = await snapshot(srv.url, id);
	assert.deepEqual([s.blocks[0]!.kind, s.blocks[0]!.name], ["document", "requirements"]);
	assert.ok(s.lines.some((l) => /Document task "requirements" created/.test(l.text)));
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { blockId: doc.body.blockId, models: THREE, budgetTokens: 200_000, way: "parallel", rounds: 1 })).status, 200);
	await until("the end of the run", async () => { const x = await snapshot(srv.url, id); return x.run && !x.run.active ? x : null; });
	const prompts = (await space.readAll({ type: "FakeCall", fields: { session: id } }, { limit: 80 })).map((e) => e.fields as { kind: string; prompt?: string }).filter((c) => c.prompt);
	const kickoff = prompts.find((c) => c.kind === "kickoff")!.prompt!;
	assert.ok(kickoff.includes(`The document will be held against these criteria:\n${[...DOCUMENT_CRITERIA, "Every requirement can be tested."].map((c, i) => `${i + 1}. ${c}`).join("\n")}`), kickoff);
	assert.ok(kickoff.includes("what the document must achieve"), kickoff);
	for (const c of prompts) assert.ok(!/\bthe plan\b|\ba plan\b|this plan/.test(c.prompt!.replace(/"""[\s\S]*?"""/g, "")), `${c.kind}: ${c.prompt}`);
	const review = prompts.find((c) => c.kind === "review")?.prompt ?? "";
	assert.equal((review.match(/^\d+ met: "<words of the document>"/gm) ?? []).length, 4, review);

	// a plan task beside it keeps the plan's words and its seven criteria
	const plan = await post(srv.url, `/api/rooms/${id}/task`, { brief: "Plan an app that shows the starry sky at a time and place.", name: "skyplan" });
	// a plan may be named too: the name is its file's
	assert.deepEqual(((await snapshot(srv.url, id)).blocks.find((x) => x.blockId === plan.body.blockId)! as { kind?: string; name?: string }).name, "skyplan");
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { blockId: plan.body.blockId, models: THREE, budgetTokens: 200_000, way: "parallel", rounds: 1 })).status, 200);
	await until("the end of the second run", async () => { const x = await snapshot(srv.url, id); return x.run && !x.run.active && x.run.blockId === plan.body.blockId ? x : null; });
	const kick2 = (await space.readAll({ type: "FakeCall", fields: { session: id, kind: "kickoff" } }, { limit: 20 })).map((e) => e.fields as { prompt: string }).find((c) => c.prompt.includes("starry sky"))!.prompt;
	assert.ok(kick2.includes(`The plan will be held against these criteria:\n${FIXED_CRITERIA.map((c, i) => `${i + 1}. ${c}`).join("\n")}`), kick2);
	assert.ok(kick2.includes("what the plan must achieve"));
});

test("a document written against another's accepted version reads that version, and a later one does not move under it", async (t) => {
	const srv = await startServer({ fakes: THREE });
	t.after(() => srv.close());
	const id = room("project"), space = srv.stack.space;
	await srv.stack.sources();
	const a = (await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the requirements of an app that shows the sky.", kind: "document", name: "requirements" })).body.blockId as string;
	const write = async (r: Revision) => { const t = await space.createTransaction(30_000); await writeVersion(space, t.id, 3600_000, { session: id, blockId: a, table: "A" }, { author: "M1", model: "fake/alpha" }, r); await space.commit(t.id); };
	await write({ changes: [{ title: "Must", text: "Stars to magnitude 6." }] });
	await write({ changes: [{ sectionId: "s1", base: 1, text: "Stars to magnitude 6, the planets." }] });
	await write({ changes: [{ sectionId: "s1", base: 2, text: "Stars to magnitude 6, the planets, the Messier objects." }] });
	assert.equal((await post(srv.url, `/api/rooms/${id}/accept`, { blockId: a, version: 3, table: "A" })).status, 200);
	await write({ changes: [{ sectionId: "s1", base: 3, text: "A draft after the acceptance." }] });
	assert.equal((await headOf(space, { session: id, blockId: a, table: "A" }))!.version, 4);
	const b = await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the architecture of the app along the requirements.", kind: "document", name: "architecture", room: [a] });
	assert.equal(b.status, 200, JSON.stringify(b.body));
	const blockB = b.body.blockId as string;
	const src = (await snapshot(srv.url, id)).blocks.find((x) => x.blockId === blockB)!.sources[0]!;
	assert.deepEqual([src.sourceId, src.kind, src.files], ["room", "room", 1]);
	assert.equal(src.name, "requirements.md: version 3, accepted by a person");
	const read = async () => (await askSources(space, { requestId: `rd-${Date.now()}-${Math.random().toString(36).slice(2)}`, session: id, blockId: blockB, op: "call", sourceId: "room", call: { op: "read", path: "requirements.md" }, ts: Date.now() })).text!;
	assert.match(await read(), /the Messier objects\./);
	assert.doesNotMatch(await read(), /A draft after the acceptance/);
	// requirements go on to version 5 and are accepted again: the architecture's copy stays at version 3
	await write({ changes: [{ sectionId: "s1", base: 4, text: "Version five." }] });
	assert.equal((await post(srv.url, `/api/rooms/${id}/accept`, { blockId: a, version: 5, table: "A" })).status, 200);
	assert.match(await read(), /the Messier objects\./);
	const search = (await askSources(space, { requestId: `sr-${Date.now()}`, session: id, blockId: blockB, op: "call", sourceId: "room", call: { op: "search", query: "Messier" }, ts: Date.now() })).text!;
	assert.match(search, /requirements\.md:\d+: .*Messier objects/);
	// a document with no version yet cannot be read, nor a block of another room
	const c = (await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write a comparison of the catalogues for the app.", kind: "document", name: "comparison" })).body.blockId as string;
	assert.match((await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the test plan of the app along the others.", kind: "document", name: "tests", room: [c] })).body.error, /comparison: no document yet/);
	assert.match((await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the test plan of the app along the others.", kind: "document", name: "tests", room: ["bnothere"] })).body.error, /not a task of this room/);
});
