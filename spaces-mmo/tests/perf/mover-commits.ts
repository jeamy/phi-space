// How many commits the server-driven movers make (docs/3d-welt-und-raster-plan-2026-11-21.en.md acceptance case 6:
// "commits per second of the server-driven movers at the same number of figures, before and after"): a stack as on the
// servers without players (the space, one world worker that loads the world, one npc process without model calls),
// MOVERS_WARMUP_SECONDS (default 20) to settle, then MOVERS_SECONDS (default 60) counted from the space's change
// stream. Every commit that changes what a reader sees is one revision there (statsWithRevision), so the revisions in
// the window are the commits; the batches of the stream say which entry types they touched.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/mover-commits.ts
//   SPACES_MMO_SPACE_SERVER, SPACES_MMO_WORLD_CMD, SPACES_MMO_NPC_CMD: the Rust processes (tests/stack.ts).
//
// Prints one JSON line: the figures (NPC characters, animals, carts), commits and commits per second in the window, and
// per entry type the commits that touched it (a commit touching several types counts for each).
import type { RemoteSpace } from "phi-spaces";
import { startStack } from "../stack.ts";

const WARMUP = Number(process.env.MOVERS_WARMUP_SECONDS ?? 20), SECONDS = Number(process.env.MOVERS_SECONDS ?? 60);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const stack = await startStack();
try {
	const s = stack.space as unknown as RemoteSpace;
	await stack.npcProcess({ SPACES_MMO_LLM: "" });
	await sleep(WARMUP * 1000);
	const from = (await s.statsWithRevision()).rev, t0 = performance.now();
	await sleep(SECONDS * 1000);
	const to = (await s.statsWithRevision()).rev, seconds = (performance.now() - t0) / 1000;
	// the batches of the window: which types each commit touched (a deleted entry's type is known from its put before)
	const typeOf = new Map<string, string>(), byType: Record<string, number> = {};
	let after = from;
	const commits = to - from;
	while (after < to) {
		const ch = await s.changes(after, { maxBytes: 200 * 1024 });
		for (const b of ch.batches) {
			if (b.rev > to) break;
			const types = new Set<string>();
			for (const o of b.ops) { const t = o.op === "put" ? o.type : undefined; if (t) typeOf.set(o.id, t); types.add(t ?? typeOf.get(o.id) ?? "(deleted)"); }
			if (!types.size) types.add("(no visible op)");
			for (const t of types) byType[t] = (byType[t] ?? 0) + 1;
		}
		if (!ch.batches.length) break;
		after = ch.next;
	}
	const npcs = (await s.readAll({ type: "Character" })).filter((c) => String(c.fields.charId).startsWith("npc-")).length;
	const animals = await s.count({ type: "Animal" }), carts = await s.count({ type: "Cart" });
	console.log(JSON.stringify({
		processes: { space: process.env.SPACES_MMO_SPACE_SERVER ? "rust" : "ts", world: process.env.SPACES_MMO_WORLD_CMD ? "rust" : "ts", npc: process.env.SPACES_MMO_NPC_CMD ? "rust" : "ts" },
		figures: { npcs, animals, carts }, seconds: Math.round(seconds), commits, perSecond: Math.round((commits / seconds) * 100) / 100,
		byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1])),
	}));
} finally { await stack.close(); }
