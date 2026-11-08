// The frozen TypeScript engine as a process (docs/rust-portierung.en.md, R8.2): one JSON line in, one JSON line out, so the
// Rust engine (rust/mmo-engine, tests/engine_walk.rs) can be held against it step by step on a space of its own.
//
//   node --experimental-strip-types --no-warnings tests/r8/engine-driver.ts <oracle root> <space address> <seed> <clock ms>
//
// The engine is imported from the oracle (a worktree of the frozen commit); the clock and chance are a seeded source
// (server/engine/source.ts) whose clock is the driver's, moved by the steps.
// In:  {"op": "clock", "at": ms} | {"op": "load", "world": "leuchtfeuer", "replace"?: bool} | {"op": "dump"}
// Out: {"ok": true, "result"?: ...} or {"ok": false, "error": "<message>"}; "dump": every entry as the JSON text of
//      [type, types, fields] with the keys sorted, the list sorted.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [root, address, seedText, clockText] = process.argv.slice(2);
if (!root || !address || !seedText || !clockText) throw new Error("usage: engine-driver.ts <oracle root> <space address> <seed> <clock ms>");
process.env.SPACES_MMO_MSG_TRANSIENT = "0"; // every message an entry: the comparison sees what each command said
const from = (p: string) => import(pathToFileURL(join(root, "spaces-mmo", p)).href);

const source = await from("server/engine/source.ts");
const { loadWorld } = await from("server/engine/world.ts");
const { loadIntoSpace } = await from("server/engine/loader.ts");
const { WORLD_LOCK } = await from("server/model.ts");
const { connectSpace } = await from("server/space.ts");
const { FOREVER } = await import("phi-spaces");

let clock = Number(clockText);
const space = connectSpace(address).space;

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)])) : v);
const worlds = new Map<string, unknown>();
const world = async (id: string) => { if (!worlds.has(id)) worlds.set(id, await loadWorld(id)); return worlds.get(id); };

async function step(line: Record<string, unknown>): Promise<unknown> {
	switch (line.op) {
		case "clock": clock = Number(line.at); return null;
		case "load": {
			const w = await world(String(line.world));
			if (!(await space.readIfExists(WORLD_LOCK, 0))) await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER); // the space process writes it
			return await loadIntoSpace(space, w, { replace: !!line.replace });
		}
		case "dump": return (await space.readAll({})).map((e: { type: string; types: string[]; fields: unknown }) => JSON.stringify([e.type, e.types, canon(e.fields)])).sort();
		default: throw new Error(`unknown op ${String(line.op)}`);
	}
}

await source.withSource(source.seeded(Number(seedText), () => clock), async () => {
	for await (const text of createInterface({ input: process.stdin })) {
		if (!text.trim()) continue;
		let out: unknown;
		try { out = { ok: true, result: await step(JSON.parse(text)) }; }
		catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
		process.stdout.write(JSON.stringify(out) + "\n");
	}
});
process.exit(0);
