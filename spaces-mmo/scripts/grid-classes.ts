// npm run grid:classes: writes the grid class table (shared/grid-format.ts GRID_CLASSES) as the Rust engine's copy,
// rust/mmo-engine/src/grid_classes.json (tests/grid-format.test.ts holds the two together).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GRID_CLASSES } from "../shared/grid-format.ts";

const out = join(import.meta.dirname, "..", "rust/mmo-engine/src/grid_classes.json");
writeFileSync(out, JSON.stringify(GRID_CLASSES, null, "\t") + "\n");
console.log(`[grid:classes] ${Object.keys(GRID_CLASSES).length} entry types → ${out}`);
