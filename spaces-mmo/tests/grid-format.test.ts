// The start check of the grid format (shared/grid-format.ts, server/engine/grid-format.ts): a legacy store starts, a
// store of another format, an unfinished migration, a definition of another scale and an entry type without a grid
// class are refused before anything is written; every entry type the server writes has a class; the Rust engine's copy
// of the table is this one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FOREVER, PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { classRow, GRID_CLASSES, gridRefusal } from "../shared/grid-format.ts";
import { checkGridFormat, GridFormatRefused } from "../server/engine/grid-format.ts";
import { loadWorld } from "../server/engine/world.ts";

const ROOT = join(import.meta.dirname, "..");
const w = await loadWorld();

async function withSpace(f: (space: PhiSpaces) => Promise<void>): Promise<void> {
	const host = openOwnMemoryHost(), space = new PhiSpaces(host, ctx);
	try { await f(space); } finally { await host.close(ctx); }
}

test("an empty and a legacy store start; nothing is written", async () => withSpace(async (space) => {
	await checkGridFormat(space, w);
	await space.write({ type: "Character", fields: { charId: "a", room: "graue-bucht", x: 3, y: 4 } }, null, FOREVER);
	await space.write({ type: "Driftwood", fields: { itemId: "d", location: "graue-bucht", x: 1, y: 1 } }, null, FOREVER);
	await space.write({ type: "Bundle", fields: { itemId: "b", location: "graue-bucht", x: 2, y: 1 } }, null, FOREVER);
	const before = (await space.stats()).entries;
	await checkGridFormat(space, w);
	assert.equal((await space.stats()).entries, before);
}));

test("a store of another grid format is refused, with the reason", async () => {
	const marker = (f: object) => withSpace(async (space) => {
		await space.write({ type: "GridFormat", fields: { worldId: w.id, gridScale: 1, occupancy: "plots", state: "complete", ...f } }, null, FOREVER);
		await assert.rejects(checkGridFormat(space, w), GridFormatRefused);
	});
	await marker({ gridScale: 2, derivedFrom: 1, occupancy: "footprints" });
	await marker({ occupancy: "footprints" });
	await marker({ state: "running" });
	await marker({ worldId: "elsewhere" });
	await marker({ derivedFrom: 1 });
	await withSpace(async (space) => {
		await space.write({ type: "GridFormat", fields: { worldId: w.id, gridScale: 1, occupancy: "plots", state: "complete" } }, null, FOREVER);
		await checkGridFormat(space, w); // the legacy format written out is the legacy format
	});
});

test("a definition of another scale and an unclassed entry type are refused", async () => withSpace(async (space) => {
	await assert.rejects(checkGridFormat(space, { ...w, gridScale: 2, derivedFrom: 1 }), /gridScale 2/);
	await space.write({ type: "Hovercraft", fields: { x: 1, y: 2 } }, null, FOREVER);
	await assert.rejects(checkGridFormat(space, w), /without a grid class: Hovercraft/);
}));

test("the pure rules", () => {
	assert.equal(gridRefusal(w, [], []), null);
	assert.equal(classRow("Bundle", w.typeclasses), "Item"); // Bundle → Driftwood → Item
	assert.equal(classRow("Character", w.typeclasses), "Character");
	assert.equal(classRow("Hovercraft", w.typeclasses), null);
	assert.match(gridRefusal(w, [{ worldId: w.id, gridScale: 1, occupancy: "plots", state: "complete" }, { worldId: w.id, gridScale: 1, occupancy: "plots", state: "complete" }], []) ?? "", /2 GridFormat entries/);
});

test("every entry type the server writes or reads has a grid class", () => {
	const files: string[] = [];
	const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts") && !p.includes(".test.")) files.push(p); } };
	walk(join(ROOT, "server"));
	walk(join(ROOT, "shared"));
	const types = new Set<string>();
	for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\btype: "([A-Z][A-Za-z]+)"|draftOf\("([A-Z][A-Za-z]+)"/g)) types.add((m[1] ?? m[2])!);
	for (const t of Object.keys(w.typeclasses)) types.add(t);
	const missing = [...types].filter((t) => classRow(t, w.typeclasses) === null).sort();
	assert.deepEqual(missing, [], `entry types without a row in GRID_CLASSES: ${missing.join(", ")}`);
});

test("the Rust engine keeps this table (rust/mmo-engine/src/grid_classes.json; npm run grid:classes)", () => {
	const kept = JSON.parse(readFileSync(join(ROOT, "rust/mmo-engine/src/grid_classes.json"), "utf8"));
	assert.deepEqual(kept, GRID_CLASSES);
});
