// The register of sources (docs/forum-seite-plan-2026-11-26.en.md, section 6, phase 7): every source a task reads is
// proposed when the task is created, the same source of a second task stays one entry, a person adds one by hand and
// accepts or declines (with the reason); the sections that cite a source are worked out from the documents as they
// stand; the register is saved as sources.md beside the documents, a retry once, a second save on top of the first.
import test from "node:test";
import assert from "node:assert/strict";
import type { Snapshot } from "../server/hub.ts";
import { writeVersion, type Revision } from "../server/plandoc.ts";
import { startServer } from "./stack.ts";
import { filesService } from "./support/files-service.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
let seq = 0;
const room = (s: string) => `${s}-g${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const getJson = async (url: string, path: string) => (await (await fetch(url + path)).json()) as any;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 40_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

test("the register: a task's sources proposed once, a link added by hand, a word on each, the citing sections", async (t) => {
	const srv = await startServer({ fakes: THREE });
	t.after(() => srv.close());
	const id = room("register"), space = srv.stack.space;
	await srv.stack.sources();
	const docs = [{ name: "catalogue.md", text: "# Catalogue\nThe Yale Bright Star Catalogue, 9110 stars.\n" }, { name: "notes.md", text: "Nothing cited.\n" }];
	const a = (await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the requirements of an app that shows the sky.", kind: "document", name: "requirements", docs, by: "Lea" })).body.blockId as string;
	const write = async (blockId: string, r: Revision) => { const x = await space.createTransaction(30_000); await writeVersion(space, x.id, 3600_000, { session: id, blockId, table: "A" }, { author: "M1", model: "fake/alpha" }, r); await space.commit(x.id); };
	await write(a, { changes: [{ title: "Stars", text: "The stars come from `catalogue.md`, as it says:\n> `catalogue.md`: The Yale Bright Star Catalogue, 9110 stars." }, { title: "Screen", text: "Dark red, see https://example.org/night-vision for why." }] });

	let reg = (await getJson(srv.url, `/api/rooms/${id}/register`)).refs as any[];
	assert.deepEqual(reg.map((r) => [r.kind, r.title, r.state, r.by]), [["docs", "catalogue.md", "proposed", "Lea"], ["docs", "notes.md", "proposed", "Lea"]]);
	assert.deepEqual(reg[0].cites, [{ blockId: a, doc: "requirements.md", section: "Stars" }]);
	assert.deepEqual(reg[1].cites, []);

	// the requirements read by a second task: a source of the room's own, proposed once however often it is read
	const b = (await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the architecture of the app along the requirements.", kind: "document", name: "architecture", room: [a], by: "Lea" })).body.blockId as string;
	await write(b, { changes: [{ title: "Data", text: "As `requirements.md` asks, the stars are read once." }] });
	reg = (await getJson(srv.url, `/api/rooms/${id}/register`)).refs;
	const roomRef = reg.find((r) => r.kind === "room");
	assert.equal(roomRef.title, "requirements.md, version 1 (a draft)");
	assert.deepEqual(roomRef.cites, [{ blockId: b, doc: "architecture.md", section: "Data" }]);
	assert.equal(reg.length, 3);

	// a link by hand: refused without an address, the same address twice one entry; cited where its address stands
	assert.match((await post(srv.url, `/api/rooms/${id}/register`, { op: "add", address: "night vision", by: "Lea" })).body.error, /named by its address/);
	assert.match((await post(srv.url, `/api/rooms/${id}/register`, { op: "add", address: "file:///etc/passwd", by: "Lea" })).body.error, /named by its address/);
	const link = await post(srv.url, `/api/rooms/${id}/register`, { op: "add", address: "https://example.org/night-vision", title: "Night vision and red light", note: "Why the screen is red", by: "Lea" });
	assert.equal(link.status, 200, JSON.stringify(link.body));
	assert.equal(link.body.again, false);
	assert.equal((await post(srv.url, `/api/rooms/${id}/register`, { op: "add", address: "https://example.org/night-vision", by: "Lea" })).body.again, true);
	reg = (await getJson(srv.url, `/api/rooms/${id}/register`)).refs;
	assert.equal(reg.length, 4);
	assert.deepEqual(reg.find((r) => r.kind === "link").cites, [{ blockId: a, doc: "requirements.md", section: "Screen" }]);

	// a word on a source: declining needs the reason; each word is a line in the room, the same word again none
	const cat = reg[0].refId;
	assert.match((await post(srv.url, `/api/rooms/${id}/register`, { op: "decide", refId: cat, state: "declined", by: "Lea" })).body.error, /needs the reason/);
	assert.match((await post(srv.url, `/api/rooms/${id}/register`, { op: "decide", refId: "rnothere", state: "accepted", by: "Lea" })).body.error, /No such source/);
	assert.equal((await post(srv.url, `/api/rooms/${id}/register`, { op: "decide", refId: cat, state: "declined", reason: "The fifth edition is out of date", by: "Lea" })).body.ref.state, "declined");
	const ok = await post(srv.url, `/api/rooms/${id}/register`, { op: "decide", refId: cat, state: "accepted", licence: "public domain", by: "Max" });
	assert.deepEqual([ok.body.ref.state, ok.body.ref.reason, ok.body.ref.licence, ok.body.ref.decidedBy], ["accepted", undefined, "public domain", "Max"]);
	await post(srv.url, `/api/rooms/${id}/register`, { op: "decide", refId: cat, state: "accepted", licence: "public domain", by: "Max" });
	const lines = ((await getJson(srv.url, `/api/rooms/${id}`)) as Snapshot).lines.map((l) => l.text);
	assert.equal(lines.filter((l) => /the source "catalogue\.md"/.test(l)).length, 2, lines.join("\n"));
	assert.ok(lines.some((l) => l === 'Lea declined the source "catalogue.md": The fifth edition is out of date'));
	assert.ok(lines.some((l) => /Lea added the source "Night vision and red light" to the register: https:\/\/example\.org\/night-vision/.test(l)));
});

test("the register saved as sources.md: a retry is one version, a second save goes on top of the first", async (t) => {
	const f = await filesService();
	const srv = await startServer({ fakes: THREE });
	t.after(async () => { await srv.close(); await f.close(); });
	await srv.stack.sources({ env: f.env });
	const id = room("regsave"), agent = `room-${id}`;
	await until("the sources process to offer spaces-files", async () => (await getJson(srv.url, `/api/rooms/${id}/link`)).files);
	await f.must({ op: "agent", id: agent });
	await f.cmd({ op: "workspace", name: "sky" });
	await f.must({ op: "write", ws: "sky", path: "plan/needs.md", text: "# Needs\n" });
	await f.must({ op: "grant", ws: "sky", path: ".", relation: "editor", agent });
	assert.equal((await post(srv.url, `/api/rooms/${id}/link`, { action: "link", project: { workspace: "sky", path: "plan" } })).status, 200);
	await post(srv.url, `/api/rooms/${id}/task`, { brief: "Write the requirements of an app that shows the sky.", kind: "document", name: "requirements", docs: [{ name: "catalogue.md", text: "Stars.\n" }], by: "Lea" });
	const read = async () => { const r = await f.must({ op: "read", ws: "sky", path: "plan/sources.md" }); return { text: Buffer.from(r.base64, "base64").toString("utf8"), version: r.version as number }; };
	const save = (saveId: string) => post(srv.url, `/api/rooms/${id}/save/register`, { id: saveId });

	const first = await save("register-save-1");
	assert.equal(first.status, 200, JSON.stringify(first.body));
	assert.deepEqual([first.body.save.path, first.body.save.fileVersion, first.body.save.blockId], ["plan/sources.md", 1, "register"]);
	const one = await read();
	assert.match(one.text, /^# Sources\n/);
	assert.match(one.text, /## Proposed, not decided\n\n- \*\*catalogue\.md\*\* \(uploaded document\)\n {2}brought by Lea; licence not known\n {2}cited in no section/);
	// the register changes, then the lost reply's save is sent again: the save already made, the file as it was
	await post(srv.url, `/api/rooms/${id}/register`, { op: "add", address: "https://example.org/stars", title: "Star list", by: "Lea" });
	assert.deepEqual([(await save("register-save-1")).body.again, (await read()).version], [true, 1]);
	assert.equal((await read()).text, one.text);
	// a new save writes the register as it is now on top of version 1
	const second = await save("register-save-2");
	assert.equal(second.body.save.fileVersion, 2, JSON.stringify(second.body));
	assert.match((await read()).text, /Star list\*\* \(link\) <https:\/\/example\.org\/stars>/);
	assert.ok(((await getJson(srv.url, `/api/rooms/${id}`)) as Snapshot).lines.some((l) => /saved the register of sources \(2 sources\) to sky\/plan\/sources\.md \(file version 2\)/.test(l.text)));
	assert.equal((await getJson(srv.url, `/api/rooms/${id}/register`)).saved.fileVersion, 2);
});
