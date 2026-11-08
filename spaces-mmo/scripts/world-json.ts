// npm run world:json [-- --check] [-- <world id>]: writes worlds/<id>/world.json, the world definition the engine reads
// (server/engine/world.ts loadWorld; docs/rust-portierung.en.md, R8.0 item 1), from worlds/<id>/world.ts, the program that
// generates it (seeded rooms, computed exits, placed NPCs). The JSON is checked in: both the TypeScript and the Rust
// engine read only it. After a change to the world's .ts files run this; --check only says whether the file is current
// (tests/world-json.test.ts does the same).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../server/env.ts";
import type { WorldDef } from "../shared/world-def.ts";

/** The JSON text of world `id` as its generator makes it. */
export async function worldJson(id: string): Promise<string> {
	const w = (await import(pathToFileURL(join(ROOT, "worlds", id, "world.ts")).href)).world as WorldDef;
	return JSON.stringify(w, null, "\t") + "\n";
}
export const worldJsonPath = (id: string) => join(ROOT, "worlds", id, "world.json");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2), check = args.includes("--check"), id = args.find((a) => !a.startsWith("--")) ?? "leuchtfeuer";
	const text = await worldJson(id), path = worldJsonPath(id);
	let old = ""; try { old = readFileSync(path, "utf8"); } catch {}
	if (check) { console.log(old === text ? `[world:json] ${id}: current` : `[world:json] ${id}: world.json is not what world.ts makes; run npm run world:json`); process.exit(old === text ? 0 : 1); }
	if (old !== text) writeFileSync(path, text);
	console.log(`[world:json] ${id}: ${old === text ? "unchanged" : "written"} (${text.length} bytes)`);
}
