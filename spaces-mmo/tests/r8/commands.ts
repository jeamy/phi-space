// The command tables of the frozen engine as data (docs/rust-portierung.en.md, R8.2): every command the default and the
// builder set offer, in the order commandsOf merges them (server/engine/commands.ts), with what the Rust engine needs to
// merge, offer and list them (key, aliases, the lock, hidden, the help line) and the module each comes from. The Rust
// engine keeps them in rust/mmo-engine/src/commands.json; its tests regenerate them from the oracle and compare.
//
//   node --experimental-strip-types --no-warnings tests/r8/commands.ts <oracle root> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error("usage: commands.ts <oracle root> <out.json>");
const from = (p: string) => import(pathToFileURL(join(root, "spaces-mmo", "server/engine", p)).href);

// commandsOf's order: the default set, then help; the builder set
const DEFAULT = [["default", "DEFAULT_COMMANDS"], ["trade", "TRADE_COMMANDS"], ["scenery", "SCENERY_COMMANDS"], ["build", "BUILD_COMMANDS"], ["interior", "INTERIOR_COMMANDS"], ["sleep", "SLEEP_COMMANDS"], ["siteorder", "SITE_ORDER_COMMANDS"], ["chapel", "CHAPEL_COMMANDS"], ["townhall", "TOWNHALL_COMMANDS"], ["festival", "FESTIVAL_COMMANDS"], ["wind", "WIND_COMMANDS"], ["cart", "CART_COMMANDS"], ["food", "FOOD_COMMANDS"], ["shop", "SHOP_COMMANDS"], ["signal", "SIGNAL_COMMANDS"], ["fishing", "FISHING_COMMANDS"], ["passage", "PASSAGE_COMMANDS"], ["garden", "GARDEN_COMMANDS"], ["trees", "TREE_COMMANDS"], ["field", "FIELD_COMMANDS"], ["beam", "BEAM_COMMANDS"], ["mill", "MILL_COMMANDS"], ["quarry", "QUARRY_COMMANDS"], ["animals", "ANIMAL_COMMANDS"], ["wild", "WILD_COMMANDS"], ["epoch", "EPOCH_COMMANDS"], ["settlement", "SETTLEMENT_COMMANDS"], ["clock", "CLOCK_COMMANDS"]];
type Command = { key: string; aliases?: string[]; locks?: string; hidden?: boolean; help: string };
const row = (module: string, c: Command) => ({ module, key: c.key, ...(c.aliases ? { aliases: c.aliases } : {}), ...(c.locks !== undefined ? { locks: c.locks } : {}), ...(c.hidden ? { hidden: true } : {}), help: c.help });

const defaults: unknown[] = [];
for (const [file, name] of DEFAULT) for (const c of (await from(`commands/${file}.ts`))[name!] as Command[]) defaults.push(row(file!, c));
defaults.push(row("default", (await from("commands/default.ts")).helpCommand(() => [])));
const builder = ((await from("commands/builder.ts")).BUILDER_COMMANDS as Command[]).map((c) => row("builder", c));
writeFileSync(out, JSON.stringify({ default: defaults, builder }, null, "\t") + "\n");
console.log(`${defaults.length} default and ${builder.length} builder commands -> ${out}`);
