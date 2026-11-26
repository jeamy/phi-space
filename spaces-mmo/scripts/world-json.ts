// npm run world:json [-- --check] [-- <world id>]: writes worlds/<id>/world.json, the world definition the engine reads
// (server/engine/world.ts loadWorld; docs/rust-portierung.en.md, R8.0 item 1), from worlds/<id>/world.ts, the program that
// generates it (seeded rooms, computed exits, placed NPCs), and beside it world-scale2.json, the same world at grid scale
// 2 derived from it (shared/world-scale.ts; loaded with SPACES_MMO_GRID_SCALE=2). The JSON is checked in: both the
// TypeScript and the Rust engine read only it. After a change to the world's .ts files run this; --check only says
// whether the files are current (tests/world-json.test.ts does the same).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../server/env.ts";
import type { WorldDef } from "../shared/world-def.ts";
import { scaleWorld } from "../shared/world-scale.ts";
import { worldFile } from "../server/engine/world.ts";

/** The scales a world's definition is written at. */
export const SCALES = [1, 2];
/** The JSON text of world `id` at `scale` as its generator makes it (scale 1) or derived from that. */
export async function worldJson(id: string, scale = 1): Promise<string> {
	const w = (await import(pathToFileURL(join(ROOT, "worlds", id, "world.ts")).href)).world as WorldDef;
	return JSON.stringify(scale === 1 ? w : scaleWorld(w, scale), null, "\t") + "\n";
}
export const worldJsonPath = (id: string, scale = 1) => join(ROOT, "worlds", id, worldFile(scale));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2), check = args.includes("--check"), id = args.find((a) => !a.startsWith("--")) ?? "leuchtfeuer";
	let stale = false;
	for (const scale of SCALES) {
		const text = await worldJson(id, scale), path = worldJsonPath(id, scale), file = worldFile(scale);
		let old = ""; try { old = readFileSync(path, "utf8"); } catch {}
		if (check) { console.log(old === text ? `[world:json] ${id} ${file}: current` : `[world:json] ${id}: ${file} is not what world.ts makes; run npm run world:json`); stale ||= old !== text; continue; }
		if (old !== text) writeFileSync(path, text);
		console.log(`[world:json] ${id} ${file}: ${old === text ? "unchanged" : "written"} (${text.length} bytes)`);
	}
	if (check) process.exit(stale ? 1 : 0);
}
