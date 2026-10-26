// Drives the page's walk (client/walk.ts) over a real connection, as App.tsx does: a held arrow key steps every
// WALK_MS, answers are matched by number. Records where the figure is drawn over time, for the walk tests and for
// measuring a running server (tests/support/walk-measure.ts).
import { WALK_MS, Walker } from "../../client/walk.ts";
import type { ServerFrame } from "../../server/gateway.ts";
import type { Player } from "../stack.ts";

export type Sample = { t: number; x: number; y: number };

/** From `start` in the room of `hello`, holds (dx, dy) for `holdMs`, then lets go and waits `settleMs`; returns the
 *  drawn places (one sample per change), the server's last place and how many steps went out. */
export async function holdKey(p: Player, hello: Extract<ServerFrame, { t: "hello" }>, start: { x: number; y: number }, dx: number, dy: number, holdMs: number, settleMs = 3_000): Promise<{ drawn: Sample[]; server: { x: number; y: number } | null; sent: number }> {
	const w = new Walker(), me = hello.me.charId;
	w.reset(start);
	let server: { x: number; y: number } | null = { x: start.x, y: start.y }, read = p.frames.length, sent = 0;
	const t0 = Date.now(), drawn: Sample[] = [{ t: 0, ...start }];
	const draw = () => { const s = w.shown!; const last = drawn.at(-1)!; if (s.x !== last.x || s.y !== last.y) drawn.push({ t: Date.now() - t0, ...s }); };
	const pump = () => {
		for (const f of p.frames.slice(read)) if (f.t === "char" && f.c.charId === me) { server = { x: f.c.x, y: f.c.y }; if (w.report(f.c, f.ack, Date.now())) draw(); }
		read = p.frames.length;
	};
	const ground = hello.room.ground;
	const free = (x: number, y: number) => !!hello.world.tiles[ground[y]?.[x] ?? ""]?.walk;
	const timer = setInterval(() => {
		pump();
		const from = w.shown!;
		if (!free(from.x + dx, from.y + dy)) return;
		const st = w.step(dx, dy, Date.now());
		if (!st) return;
		p.ws!.send(JSON.stringify({ t: "step", seq: st.seq, dx: st.dx, dy: st.dy }));
		sent++;
		draw();
	}, WALK_MS);
	const watch = setInterval(pump, 10);
	await new Promise((r) => setTimeout(r, holdMs));
	clearInterval(timer);
	await new Promise((r) => setTimeout(r, settleMs));
	clearInterval(watch);
	pump();
	return { drawn, server, sent };
}
