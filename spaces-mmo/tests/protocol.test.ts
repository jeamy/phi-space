// The protocol of the game socket (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 4, "Protocol version"): the
// page names the version it speaks when it connects (`/ws?v=2`), `hello` carries it with the world's grid scale, and a
// gateway refuses a page that names another or none: a tab opened before the switch reconnects after it and is told to
// load anew, so its steps never reach the engine. At scale 1 a numbered step is one cell (double steps at scale 2:
// tests/double-step.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, Player, startServer } from "./stack.ts";
import { PROTOCOL } from "../shared/frames.ts";
import type { ServerFrame } from "../server/gateway.ts";
import type { SpaceLike } from "phi-spaces";

const charAt = async (space: SpaceLike, charId: string) => (await space.readIfExists({ type: "Character", fields: { charId } }, 5_000))!.fields as Record<string, any>;

/** The frames a socket opened at `path` with `cookie` receives until the gateway closes it. */
async function refused(url: string, cookie: string, path: string): Promise<Array<Record<string, unknown>>> {
	const ws = new WebSocket(url.replace(/^http/, "ws") + path, { headers: { cookie } } as never);
	const frames: Array<Record<string, unknown>> = [];
	ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
	await new Promise<void>((ok, fail) => {
		const timer = setTimeout(() => fail(new Error(`${path}: not closed; frames ${JSON.stringify(frames)}`)), 10_000);
		ws.onclose = () => { clearTimeout(timer); ok(); };
	});
	return frames;
}

test("the socket's protocol: hello names it and the grid scale, a page with another or none is told to load anew", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const space = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Protokoll", password: "geheim-123" })).status, 200);
		const build = (await p.me()).build ?? null;

		// a tab from before the switch: no version; it knows no `reload`, but a hello of another build makes it load anew
		const old = await refused(srv.url, p.cookie, "/ws");
		assert.deepEqual(old, [{ t: "reload", protocol: PROTOCOL, build }, { t: "hello", build: build ?? `protocol-${PROTOCOL}` }]);
		// a page of another version (a newer page against an older gateway, or the other way round)
		assert.deepEqual(await refused(srv.url, p.cookie, "/ws?v=1"), [{ t: "reload", protocol: PROTOCOL, build }]);
		// a version that is no number counts as none
		for (const bad of ["/ws?v=02", "/ws?v=x", "/ws?v="]) assert.deepEqual(await refused(srv.url, p.cookie, bad), old, bad);
		// nothing of those sockets reached the world: no session was written for them
		assert.equal((await space.readAll({ type: "Session" })).length, 0);

		const hello = await p.play();
		assert.equal(hello.protocol, PROTOCOL);
		assert.equal(hello.gridScale, 1);
		const me = hello.me.charId;

		// at scale 1 a numbered step is one cell: a step of two is dropped by the gateway (no ack), one of one is taken
		p.send("move 8 9");
		await eventually(async () => { const c = await charAt(space, me); return c.x === 8 && c.y === 9; }, 10_000, "at 8,9");
		const from = p.frames.length;
		p.ws!.send(JSON.stringify({ t: "step", seq: 1, dx: 2, dy: 0 }));
		p.ws!.send(JSON.stringify({ t: "step", seq: 2, dx: 1, dy: 0 }));
		await p.until((f) => f.t === "char" && f.c.charId === me && f.ack === 2, 10_000, from);
		assert.deepEqual([(await charAt(space, me)).x, (await charAt(space, me)).y], [9, 9]);
		assert.equal(p.frames.slice(from).some((f: ServerFrame) => f.t === "char" && f.ack === 1), false, "the step of two had no answer");
		await p.leave();
	} finally { await srv.close(); }
});
