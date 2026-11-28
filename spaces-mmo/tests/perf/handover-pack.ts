// What a ferry crossing between two regions costs by the size of the pack (server/engine/handover.ts, transfer.ts
// moveThings): two region spaces on SQLite as on the servers (tests/stack.ts startRegions, no world workers), one
// figure crossing west → nord → west …, HANDOVER_RUNS times for every pack size of HANDOVER_PACKS. The pack is made of
// things as they lie in a figure's pack on the test bed (a shell, a stone, driftwood: about 300 to 370 bytes an entry; the
// largest packs there held about 130 things on 2026-11-24). Measured apart: step 1 (handOff in the command's transaction,
// committed) and steps 2 to 4 (carryOne, what a world worker does once it has the Handover; the worker's wake-up is not in
// it, it does not depend on the pack), with the calls each step makes to each space.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/handover-pack.ts
//   SPACES_MMO_SPACE_SERVER=rust/target/release/mmo-space     the Rust space server (relative to spaces-mmo/)
//   HANDOVER_PACKS=0,10,40,64,130,300,1000 HANDOVER_RUNS=10
//
// Prints one JSON line per pack size: carry p50/p95 ms, calls to the region it leaves and the one it reaches, handOff p50.
import "../test-env.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { startRegions } from "../stack.ts";
import { loadWorld } from "../../server/engine/world.ts";
import { regionWorld } from "../../server/engine/regions.ts";
import { batch, carryOne } from "../../server/engine/transfer.ts";
import { handOff, handovers } from "../../server/engine/handover.ts";
import { WORLD_LOCK, actorToken, type CharacterFields } from "../../server/model.ts";
import type { CommandCtx } from "../../server/engine/context.ts";

const PACKS = (process.env.HANDOVER_PACKS || "0,10,40,64,130,300,1000").split(",").map(Number);
const RUNS = Number(process.env.HANDOVER_RUNS || "10");

/** Counts the calls made through it, by method. */
function counted(space: SpaceLike) {
	const calls = { n: 0 };
	const proxy = new Proxy(space, {
		get(target, key, receiver) {
			const v = Reflect.get(target, key, receiver);
			if (typeof v !== "function") return v;
			return (...args: unknown[]) => { calls.n++; return v.apply(target, args); };
		},
	});
	return { space: proxy as SpaceLike, calls };
}

/** Things as a pack holds them on the test bed. */
const KINDS = [
	{ type: "Shell", proto: "muschel", name: "Muschel", aliases: ["shell"], desc: "Eine rosa Muschel. Hält man sie ans Ohr, hört man die Flut.", glyph: { shape: "diamond", color: "#f0a6c0" } },
	{ type: "Stone", proto: "stein", name: "Stein", aliases: ["steine", "brocken", "geröll", "stone", "rock"], desc: "Ein grauer Brocken, schwer und kantig. Geröll vom Hang, oder frisch aus dem Steinbruch.", glyph: { shape: "diamond", color: "#8d8f93" } },
	{ type: "Wood", proto: "treibholz", name: "Treibholz", aliases: ["holz", "driftwood", "wood"], desc: "Ein Stück Holz, vom Meer glattgeschliffen und von der Sonne gebleicht. Es brennt gut.", glyph: { shape: "diamond", color: "#a07a50" } },
];
const thing = (charId: string, i: number) => {
	const k = KINDS[i % KINDS.length]!;
	return { type: k.type, types: ["Item", "Object"], fields: { itemId: `i-${charId}-${i}`, name: k.name, aliases: k.aliases, desc: k.desc, location: charId, x: -1, y: -1, glyph: k.glyph, locks: "get:all();drop:all();give:not guest()", proto: k.proto, flotsam: true } };
};

const world = await loadWorld("leuchtfeuer");
const parts = { west: regionWorld(world, "west"), nord: regionWorld(world, "nord") };
const ends = { west: { room: "klippenkopf", x: 12, y: 1 }, nord: { room: "moewenfels-strand", x: 12, y: 14 } } as const;
const dataDir = await mkdtemp(join(tmpdir(), "mmo-handover-pack-"));
const r = await startRegions({ workers: false, dataDir });
const at = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
try {
	for (const id of ["west", "nord"] as const) {
		const s = r.space(id);
		if (!(await s.count(WORLD_LOCK))) await s.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER);
		const room = parts[id].rooms.find((x) => x.roomId === ends[id].room)!;
		await s.write({ type: "Room", fields: { roomId: room.roomId, name: room.name, desc: "", ground: room.ground, spawn: room.spawn } }, null, FOREVER);
	}
	let seq = 0;
	// a first round of crossings, not counted: the servers and this process warm up
	for (const [i, n] of [40, ...PACKS].entries()) {
		const warm = i === 0;
		const carry: number[] = [], off: number[] = [], callsFrom: number[] = [], callsTo: number[] = [];
		for (let run = 0; run < RUNS; run++) {
			const charId = `c-${seq++}`, [from, to] = run % 2 === 0 ? (["west", "nord"] as const) : (["nord", "west"] as const);
			const a = r.space(from), b = r.space(to);
			const ch: CharacterFields = { charId, accountId: `a-${charId}`, name: `P${charId}`, ...ends[from], skin: 0, guest: false };
			await a.write({ type: "Account", fields: { accountId: ch.accountId, name: ch.name, guest: false, admin: false, createdAt: 1, touchedAt: 1 } }, null, FOREVER);
			await a.write({ type: "Character", fields: ch as never }, null, FOREVER);
			await a.write(actorToken(charId), null, FOREVER);
			await a.write({ type: "Spot", fields: { room: ch.room, x: ch.x, y: ch.y, charId, name: ch.name } }, null, FOREVER);
			for (let i = 0; i < n; i += 60) await batch(a, Array.from({ length: Math.min(60, n - i) }, (_, j) => ({ op: "write" as const, entry: thing(charId, i + j) as never, lease: FOREVER })));
			// step 1, as the command does it
			const t0 = performance.now();
			const txn = (await a.createTransaction(10_000)).id;
			await handOff({ space: a, txn, world: parts[from], actor: ch, account: null, msgLeaseMs: 60_000, cache: {} } satisfies CommandCtx, from, to, ends[to]);
			await a.commit(txn);
			off.push(performance.now() - t0);
			// steps 2 to 4, as a world worker of `from` does them once it has the Handover
			const [h] = await a.readAll({ type: "Handover", fields: { charId } });
			if (!h) throw new Error(`no Handover for ${charId}`);
			const ca = counted(a), cb = counted(b);
			const t1 = performance.now();
			await carryOne(ca.space, new Map([[to, cb.space]]), handovers(parts[from]), h);
			carry.push(performance.now() - t1);
			callsFrom.push(ca.calls.n); callsTo.push(cb.calls.n);
			const got = await b.count({ type: "Item", fields: { location: charId } }), left = await a.count({ type: "Item", fields: { location: charId } });
			if (got !== n || left !== 0) throw new Error(`${charId}: ${got} of ${n} things arrived, ${left} left behind`);
			// the figure leaves the world again: the next run starts from an empty pack
			for (;;) { const xs = await b.readAll({ type: "Item", fields: { location: charId } }, { limit: 60 }); if (!xs.length) break; await batch(b, xs.map((e) => ({ op: "take" as const, template: { id: e.id } }))); }
			for (const t of [{ type: "Character", fields: { charId } }, { type: "Spot", fields: { charId } }, { type: "Account", fields: { accountId: ch.accountId } }, actorToken(charId)]) await b.takeIfExists(t as never, 0);
		}
		if (!warm) console.log(JSON.stringify({ server: process.env.SPACES_MMO_SPACE_SERVER || "ts", things: n, runs: RUNS, carryP50: Math.round(at(carry, 0.5)), carryP95: Math.round(at(carry, 0.95)), msPerThing: n ? Math.round((at(carry, 0.5) / n) * 100) / 100 : null, callsFrom: at(callsFrom, 0.5), callsTo: at(callsTo, 0.5), handOffP50: Math.round(at(off, 0.5)) }));
	}
} finally { await r.close(); await rm(dataDir, { recursive: true, force: true }); }
process.exit(process.exitCode ?? 0);
