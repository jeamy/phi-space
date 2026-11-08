// The look of one's figure in 3D (server/engine/appearance.ts, the `avatar` command, client/AvatarPanel.tsx): the line is
// read strictly, the figure is built from it, and everyone's page gets it with the character and keeps it after a step.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as t from "three";
import { appearanceLine, DEFAULT_APPEARANCE, isAppearance, parseAppearance, type Appearance } from "../server/engine/appearance.ts";
import type { CharView, ServerFrame } from "../server/gateway.ts";
import { Player, startRegions, startWeb } from "./stack.ts";

test("the avatar line is read strictly and round-trips", () => {
	const a = parseAppearance("figur 2 farbe 5 haar 4 haut 3 hut 4 brille ja handschuhe ja");
	assert.deepEqual(a, { body: 1, coat: 4, hair: 3, skin: 2, hat: 3, glasses: true, gloves: true } satisfies Appearance);
	assert.deepEqual(parseAppearance(appearanceLine(a as Appearance)), a);
	// English words, any order, only what changes
	assert.deepEqual(parseAppearance("glasses yes figure 3", DEFAULT_APPEARANCE), { ...DEFAULT_APPEARANCE, glasses: true, body: 2 });
	for (const bad of ["figur 5", "figur 0", "farbe 9", "hut", "brille vielleicht", "mantel 2", "figur 1.5", ""]) assert.ok("error" in parseAppearance(bad), bad);
	assert.ok(isAppearance(DEFAULT_APPEARANCE));
	assert.ok(!isAppearance({ ...DEFAULT_APPEARANCE, coat: 8 }));
	assert.ok(!isAppearance({ ...DEFAULT_APPEARANCE, extra: 1 }));
});

test("a chosen look builds its figure: glasses, gloves and the hat add parts, the colour is the chosen one", () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) } });
	return import("../client/figure3d.ts").then(({ makeFigure }) => {
		const count = (g: t.Object3D) => { let n = 0; g.traverse((o) => { if ((o as t.Mesh).isMesh) n++; }); return n; };
		const plain = makeFigure(t, { id: "x", skin: 0, own: true, ai: false, style: DEFAULT_APPEARANCE });
		const dressed = makeFigure(t, { id: "x", skin: 0, own: true, ai: false, style: { ...DEFAULT_APPEARANCE, hat: 3, glasses: true, gloves: true, coat: 1 } });
		assert.ok(count(dressed.group) >= count(plain.group) + 9, `${count(dressed.group)} vs ${count(plain.group)}`);
		const colours = new Set<number>(); dressed.group.traverse((o) => { const m = (o as t.Mesh).material as t.MeshStandardMaterial | undefined; if (m?.color) colours.add(m.color.getHex()); });
		assert.ok(colours.has(0xb5533c), "the chosen red clothes");
		// the tall type stands taller than the plain one
		assert.ok(makeFigure(t, { id: "x", skin: 0, own: false, ai: false, style: { ...DEFAULT_APPEARANCE, body: 3 } }).body.scale.y > plain.body.scale.y);
	}).finally(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); });
});

test("avatar sets the look on the character and it stays through a step; avatar zurück takes it away", { timeout: 180_000 }, async () => {
	const r = await startRegions();
	const web = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	try {
		const a = new Player(web.url);
		assert.equal((await a.post("/api/register", { name: "Anna", password: "pw-anna-1234" })).status, 200);
		const me = (await a.play()).me.charId;
		a.send("avatar figur 2 farbe 3 hut 4 brille ja");
		const seen = (await a.until((f) => f.t === "char" && f.c.charId === me && f.c.look?.body === 1, 15_000)) as Extract<ServerFrame, { t: "char" }>;
		assert.deepEqual(seen.c.look, { ...DEFAULT_APPEARANCE, body: 1, coat: 2, hat: 3, glasses: true });
		await a.heard("Deine Figur: Figur Seefahrerin");

		// a wrong line changes nothing
		a.send("avatar hut 9");
		await a.heard("Bei hut geht eine Zahl von 1 bis 4.");

		// a step rewrites the character: the look goes along
		const from = a.frames.length;
		a.ws!.send(JSON.stringify({ t: "step", seq: 1, dx: 1, dy: 0 }));
		a.ws!.send(JSON.stringify({ t: "step", seq: 2, dx: -1, dy: 0 }));
		const moved = (await a.until((f) => f.t === "char" && f.c.charId === me && f.ack !== undefined, 15_000, from)) as { c: CharView };
		assert.deepEqual(moved.c.look, seen.c.look);

		// a page opened anew (and so everyone's in the room: the same charView) gets it with the hello
		await a.leave();
		const hello = await a.play();
		assert.equal(hello.chars.find((x) => x.charId === me)?.look?.hat, 3);

		a.send("avatar zurück");
		await a.until((f) => f.t === "char" && f.c.charId === me && !f.c.look, 15_000);
		await a.leave();
	} finally { await web.close(); await r.close(); }
});
