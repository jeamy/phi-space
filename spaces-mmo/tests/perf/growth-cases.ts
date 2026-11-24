// Reproducible growth cases (docs/3d-welt-und-raster-plan-2026-11-21.en.md phase 0): the world as loaded, every room
// grown without the fill condition until none can grow, and for each room the steps it took (axis, seam, size) and its
// final size. Growth draws no chance, so the same world gives the same steps; after the switch the same run at scale 2
// is compared with this one (each seam and size times gridScale, the same order of sides).
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/growth-cases.ts [--write]
//
// Prints the cases as JSON; `--write` stores them as tests/reference/growth-scale1.json, which this run is then held to.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freeSide, growthTick } from "../../server/engine/commands/growth.ts";
import { loadWorld } from "../../server/engine/world.ts";
import type { RoomFields, RoomGrowthFields } from "../../server/model.ts";
import { startStack } from "../stack.ts";

const FILE = join(import.meta.dirname, "../reference/growth-scale1.json");
const w = await loadWorld();
const any = { ...w, growth: { ...w.growth!, fullShare: 0 } };
const stack = await startStack();
try {
	const s = stack.space;
	const growing = async () => (await s.readAll({ type: "Room" })).filter((r) => freeSide(any, r.fields as unknown as RoomFields, []) !== null).length;
	for (let runs = 0; (await growing()) && runs < 60; runs++) if (!(await growthTick(s, any, 60_000))) await new Promise((ok) => setTimeout(ok, 500));
	const growth = new Map((await s.readAll({ type: "RoomGrowth" })).map((e) => [String(e.fields.roomId), e.fields as unknown as RoomGrowthFields]));
	const cases = (await s.readAll({ type: "Room" })).map((e) => e.fields as unknown as RoomFields).sort((a, b) => a.roomId.localeCompare(b.roomId)).map((r) => ({
		roomId: r.roomId, size: `${r.ground[0]!.length}x${r.ground.length}`,
		steps: (growth.get(r.roomId)?.steps ?? []).map((st) => `${st.axis}@${st.at}+${st.size}`),
	}));
	const out = { world: w.id, gridScale: w.gridScale ?? 1, growth: w.growth, cases };
	if (process.argv.includes("--write")) { mkdirSync(join(FILE, ".."), { recursive: true }); writeFileSync(FILE, JSON.stringify(out, null, "\t") + "\n"); console.log(`written: ${FILE}`); }
	else {
		const kept = JSON.parse(readFileSync(FILE, "utf8"));
		const same = JSON.stringify(kept) === JSON.stringify(out);
		console.log(JSON.stringify({ rooms: cases.length, steps: cases.reduce((n, c) => n + c.steps.length, 0), sameAsReference: same }));
		if (!same) { console.log(JSON.stringify(out)); process.exitCode = 1; }
	}
} finally { await stack.close(); }
