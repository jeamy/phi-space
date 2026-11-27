// Pictures for the models (docs/forum-seite-plan-2026-11-26.en.md, section 6, phase 6): a picture added twice under
// one ID is one, a picture that carries metadata, lies about its kind or passes a limit is refused, a run without a
// model that takes pictures is refused, one model that takes them describes each picture before the kickoff, the
// description reaches every model and the picture only those that take it, and a person's correction counts.
import test from "node:test";
import assert from "node:assert/strict";
import type { Snapshot } from "../server/hub.ts";
import { checkJpeg, IMAGE_LIMITS } from "../server/images.ts";
import { startServer } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan an app that shows the starry sky at a time and place.";
let seq = 0;
const room = (scenario: string) => `${scenario}-i${process.pid}-${seq++}`;

/** A JPEG as the page's canvas makes one, by its segments (nothing here decodes it): JFIF, a frame of the given size,
 *  a scan of `fill` bytes. `exif`, `comment`: what a camera's file carries and the reduced copy must not. */
function jpeg(width: number, height: number, o: { exif?: boolean; comment?: boolean; fill?: number } = {}): Buffer {
	const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
	const sof = Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
		...(o.exif ? [seg(0xe1, Buffer.from("Exif\0\0GPS 48.2N 16.4E", "latin1"))] : []),
		...(o.comment ? [seg(0xfe, Buffer.from("taken at home", "latin1"))] : []),
		seg(0xc0, sof),
		seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
		Buffer.alloc(o.fill ?? 64, 0x55),
		Buffer.from([0xff, 0xd9]),
	]);
}

const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const upload = async (url: string, id: string, block: string, imageId: string, bytes: Buffer, name = "sketch.jpg", type = "image/jpeg") => {
	const r = await fetch(`${url}/api/rooms/${id}/images/${block}?id=${imageId}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const getJson = async (url: string, path: string) => (await (await fetch(url + path)).json()) as any;
const snapshot = (url: string, id: string) => getJson(url, `/api/rooms/${id}`) as Promise<Snapshot>;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 40_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
type Call = { model: string; kind: string; images: number; mimeTypes: string[]; prompt: string };

test("the segments of a JPEG: its size read, metadata and other kinds refused", () => {
	assert.deepEqual(checkJpeg(jpeg(1568, 900)), { width: 1568, height: 900 });
	assert.throws(() => checkJpeg(jpeg(800, 600, { exif: true })), /metadata \(Exif or XMP\)/);
	assert.throws(() => checkJpeg(jpeg(800, 600, { comment: true })), /comment/);
	assert.throws(() => checkJpeg(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")), /Not a JPEG/);
	assert.throws(() => checkJpeg(jpeg(800, 600).subarray(0, 30)), /broken/);
});

test("pictures of a task: one under one ID, refused beyond a limit, described once and seen only by the models that take them", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("pictures");
	assert.equal((await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).status, 200);
	const block = (await snapshot(srv.url, id)).blocks[0]!.blockId;

	// sent again after a lost reply: the same picture, once
	const first = await upload(srv.url, id, block, "pic-sketch-1", jpeg(1200, 800), "sky sketch.jpg");
	assert.equal(first.status, 200, JSON.stringify(first.body));
	assert.equal(first.body.again, false);
	const again = await upload(srv.url, id, block, "pic-sketch-1", jpeg(1200, 800), "sky sketch.jpg");
	assert.equal(again.body.again, true);
	assert.equal((await upload(srv.url, id, block, "pic-chart-02", jpeg(900, 1500), "../../chart.jpg")).status, 200);
	const listed = (await getJson(srv.url, `/api/rooms/${id}/images/${block}`)).images as Array<{ imageId: string; name: string; width: number; height: number; note: unknown }>;
	assert.deepEqual(listed.map((x) => [x.imageId, x.name, x.width, x.height, x.note]), [["pic-sketch-1", "sky sketch.jpg", 1200, 800, null], ["pic-chart-02", "chart.jpg", 900, 1500, null]]);
	assert.equal((await snapshot(srv.url, id)).blocks[0]!.images, 2);
	// the bytes as they were sent, as a picture and nothing else
	const got = await fetch(`${srv.url}/api/rooms/${id}/images/${block}/pic-sketch-1`);
	assert.equal(got.headers.get("content-type"), "image/jpeg");
	assert.match(got.headers.get("content-security-policy") ?? "", /sandbox/);
	assert.ok(Buffer.from(await got.arrayBuffer()).equals(jpeg(1200, 800)));

	// refused: metadata, a comment, a name that lies about its kind, too large in pixels or bytes, another type
	const refused = async (bytes: Buffer, why: RegExp, type?: string) => { const r = await upload(srv.url, id, block, `pic-bad-${seq++}x`, bytes, "x.jpg", type); assert.ok(r.status >= 400, JSON.stringify(r.body)); assert.match(r.body.error, why); };
	await refused(jpeg(800, 600, { exif: true }), /metadata \(Exif or XMP\)/);
	await refused(jpeg(800, 600, { comment: true }), /comment/);
	await refused(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), /Not a JPEG/);
	await refused(jpeg(1569, 600), /longer side has at most 1568 pixels \(this one 1569\)/);
	await refused(jpeg(800, 600, { fill: IMAGE_LIMITS.bytes }), /at most 400 kB/);
	await refused(jpeg(800, 600), /as image\/jpeg/, "image/png");
	assert.equal((await getJson(srv.url, `/api/rooms/${id}/images/${block}`)).images.length, 2);

	// a run whose table has no model that takes pictures is refused before it starts
	const blind = await post(srv.url, `/api/rooms/${id}/run`, { blockId: block, models: ["fake/beta", "fake/gamma", "fake/delta"], budgetTokens: 50_000 });
	assert.equal(blind.status, 400);
	assert.match(blind.body.error, /at least one model at the table must take pictures/);

	// alpha takes pictures: it describes each once before the kickoff; every kickoff names both descriptions, and only
	// alpha's carries the pictures
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { blockId: block, models: THREE, budgetTokens: 50_000 })).status, 200);
	await until("the run's end", async () => { const s = await snapshot(srv.url, id); return s.run && !s.run.active; }, 60_000);
	const calls = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id } }, { limit: 60 })).map((e) => e.fields as unknown as Call);
	const describe = calls.filter((c) => c.kind === "describe");
	assert.deepEqual(describe.map((c) => [c.model, c.images, c.mimeTypes]), [["fake/alpha", 1, ["image/jpeg"]], ["fake/alpha", 1, ["image/jpeg"]]]);
	assert.ok(describe.some((c) => c.prompt.includes('the picture "sky sketch.jpg"')));
	const kickoffs = calls.filter((c) => c.kind === "kickoff");
	assert.deepEqual(kickoffs.map((c) => [c.model, c.images]).sort(), [["fake/alpha", 2], ["fake/beta", 0], ["fake/gamma", 0]]);
	for (const c of kickoffs) {
		assert.ok(c.prompt.includes("1. sky sketch.jpg: A sketch of the evening sky with Orion low in the south, described by fake/alpha."), c.prompt);
		assert.ok(c.prompt.includes("2. chart.jpg: A sketch"));
		assert.equal(c.prompt.includes("They are attached to this message"), c.model === "fake/alpha");
	}
	// no call but alpha's got a picture, and a roll call none
	assert.ok(calls.every((c) => c.model === "fake/alpha" || c.images === 0));
	assert.ok(calls.filter((c) => c.kind === "rollcall").every((c) => c.images === 0));
	const notes = (await getJson(srv.url, `/api/rooms/${id}/images/${block}`)).images as Array<{ note: { text: string; by: string; model?: string } }>;
	assert.deepEqual(notes.map((x) => x.note.model), ["fake/alpha", "fake/alpha"]);

	// the person corrects a description: it counts, and the next run describes nothing again
	assert.equal((await post(srv.url, `/api/rooms/${id}/images/${block}/pic-chart-02/note`, { text: "A star chart of Cassiopeia drawn by hand; the labels read M52 and M103." })).status, 200);
	assert.equal((await getJson(srv.url, `/api/rooms/${id}/images/${block}`)).images[1].note.text, "A star chart of Cassiopeia drawn by hand; the labels read M52 and M103.");
	// (the block has its document now: the second run checks it and the table votes on it)
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { blockId: block, models: THREE, way: "parallel", rounds: 1, budgetTokens: 50_000 })).status, 200);
	await until("the second run's end", async () => { const s = await snapshot(srv.url, id); return s.run && !s.run.active && s.lines.filter((l) => /^Run finished/.test(l.text)).length >= 2; }, 60_000);
	const later = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id } }, { limit: 120 })).map((e) => e.fields as unknown as Call).slice(calls.length);
	assert.ok(later.length > 0);
	assert.equal(later.filter((c) => c.kind === "describe").length, 0);
	const work = later.filter((c) => c.kind !== "rollcall");
	assert.ok(work.length > 0 && work.every((c) => c.prompt.includes("2. chart.jpg: A star chart of Cassiopeia drawn by hand; the labels read M52 and M103.")), JSON.stringify(work.map((c) => c.kind)));

	// a member removes a picture; a task holds at most twelve
	assert.equal((await post(srv.url, `/api/rooms/${id}/images/${block}/pic-sketch-1/remove`, {})).status, 200);
	assert.deepEqual((await getJson(srv.url, `/api/rooms/${id}/images/${block}`)).images.map((x: { imageId: string }) => x.imageId), ["pic-chart-02"]);
	for (let i = 0; i < IMAGE_LIMITS.perTask - 1; i++) assert.equal((await upload(srv.url, id, block, `pic-many-${i}x`, jpeg(100, 100))).status, 200);
	const thirteenth = await upload(srv.url, id, block, "pic-many-last", jpeg(100, 100));
	assert.equal(thirteenth.status, 400);
	assert.match(thirteenth.body.error, /at most 12 pictures/);
	assert.ok((await snapshot(srv.url, id)).lines.some((l) => /added the picture sky sketch\.jpg \(1200 × 800, 1 kB\)/.test(l.text)));
});
