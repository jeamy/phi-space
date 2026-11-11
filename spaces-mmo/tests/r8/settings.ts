// The operator's settings of the frozen web process as data (docs/rust-portierung.en.md, R8.5): every setting the admin's
// window shows (server/settings.ts SETTINGS), in its order, with label, unit, help, env, default and range. The Rust web
// process keeps them in rust/mmo-web/src/settings.json.
//
//   node --experimental-strip-types --no-warnings tests/r8/settings.ts <oracle root> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error("usage: settings.ts <oracle root> <out.json>");
const { SETTINGS } = await import(pathToFileURL(join(root, "spaces-mmo", "server/settings.ts")).href);
writeFileSync(out, JSON.stringify(SETTINGS, null, "\t") + "\n");
console.log(`${SETTINGS.length} settings -> ${out}`);
