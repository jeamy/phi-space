// One-off: a world that ran as one space (world.sqlite) moves into its region spaces (engine/regions.ts). Run once,
// with the old space stopped (this opens its file) and the region spaces up but empty, before their world workers start:
//
//   SPACES_MMO_DATA=/data SPACES_MMO_REGIONS=west=tcp:…,nord=… node --experimental-strip-types server/migrate-regions.ts
//
// Every entry goes to the region of its room: characters with their accounts and what they carry, things lying in a
// room, fires, fog, contributions, market listings with their goods, orders. The clock goes to every region (the world
// goes on where it was); the model's memory and counts to the first. What the world workers make themselves (rooms,
// exits, prototypes, help, tokens, dates, locks) and what lapses anyway (sessions, cells, messages, intents) is left out.
// Each NPC gets its birth marker in the region it starts in, so no region makes a second one. The old file stays.
import "./env.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FOREVER, PhiSpaces, type Taken } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openSqliteHost } from "phi-spaces/store/sqlite";
import { loadWorld } from "./engine/world.ts";
import { regionOfRoom, regionsOf } from "./engine/regions.ts";
import { RegionSpaces } from "./region-spaces.ts";
import { envMs } from "./space.ts";
import { ROOT } from "./env.ts";

const w = await loadWorld();
const file = join(process.env.SPACES_MMO_DATA || join(ROOT, ".local"), "world.sqlite");
// a missing file would be made empty here, and an empty world moves nothing (and would say so as if it had)
if (!existsSync(file)) throw new Error(`${file} does not exist (is the volume mounted?)`);
const host = await openSqliteHost(file);
const old = new PhiSpaces(host, ctx);
const before = await old.stats();
console.log(`[migrate] ${file}: ${before.entries} entries; characters ${await old.count({ type: "Character" })}, accounts ${await old.count({ type: "Account" })}, things ${await old.count({ type: "Item" })}, coins ${await old.count({ type: "Coin" })}`);
if (!(await old.count({ type: "Character" }))) throw new Error(`${file} holds no character: nothing to move`);
const regions = RegionSpaces.connect(w, "");
if (regions.size < 2) throw new Error("SPACES_MMO_REGIONS must name the region spaces");
for (const [id, s] of regions.entries()) if ((await s.count({ type: "Character" })) || (await s.count({ type: "Item" }))) throw new Error(`the region ${id} is not empty: moved already?`);

const all = async (type: string) => old.readAll({ type });
const region = (room: unknown) => regionOfRoom(w, String(room));
const chars = new Map((await all("Character")).map((e) => [String(e.fields.charId), e]));
const charRegion = (charId: unknown) => { const c = chars.get(String(charId)); return c ? region(c.fields.room) : null; };
const beaconRegion = (beaconId: unknown) => { const b = w.beacons.find((x) => x.beaconId === beaconId); return b ? region(b.room) : null; };
const listings = await all("Listing");
const counts = new Map<string, number>();
const put = async (to: string | null, e: Taken, lease = FOREVER) => {
	const s = to ? regions.get(to) : undefined;
	if (!s) { console.error(`[migrate] no region for ${e.type} ${JSON.stringify(e.fields).slice(0, 120)}`); return; }
	await s.write({ type: e.type, types: e.types.slice(1), fields: e.fields as never }, null, lease);
	counts.set(`${to} ${e.types.includes("Item") ? "Item" : e.type}`, (counts.get(`${to} ${e.types.includes("Item") ? "Item" : e.type}`) ?? 0) + 1);
};
const guestMs = envMs("SPACES_MMO_GUEST_TTL_MS", 7 * 24 * 3600_000);

for (const e of chars.values()) await put(region(e.fields.room), e);
// an account goes with its character (one each)
const charOfAccount = new Map([...chars.values()].map((c) => [String(c.fields.accountId), String(c.fields.charId)]));
for (const e of await all("Account")) await put(charRegion(charOfAccount.get(String(e.fields.accountId))), e, e.fields.guest ? guestMs : FOREVER);
for (const e of await all("Item")) {
	const at = String(e.fields.location);
	const to = at === "market" ? region(listings.find((l) => l.fields.itemId === e.fields.itemId)?.fields.room) : chars.has(at) ? charRegion(at) : region(at);
	// flotsam lying about lapses with the tide; a thing the world placed or someone carries stays
	const flotsam = !chars.has(at) && at !== "market" && /^i-/.test(String(e.fields.itemId));
	await put(to, e, flotsam ? w.flood.lifetimeMs : FOREVER);
}
for (const e of listings) await put(region(e.fields.room), e, w.market.listMs);
for (const e of await all("Order")) await put(region(e.fields.room), e, w.orders.leaseMs);
for (const type of ["Beacon", "Flame", "Contribution"]) for (const e of await all(type)) await put(beaconRegion(e.fields.beaconId), e);
for (const e of await all("Fog")) await put(region(e.fields.room), e);
for (const e of await all("WorldClock")) for (const [id] of regions.entries()) await put(id, e);
for (const type of ["NpcMemory", "NpcVisit"]) for (const e of await all(type)) await put(charRegion(`npc-${e.fields.npcId}`) ?? regions.home, e);
for (const e of await all("LlmCount")) await put(regions.home, e, 24 * 3600_000);
for (const n of w.npcs) {
	const born = region(n.room);
	if (born && chars.has(`npc-${n.npcId}`)) await regions.get(born)!.write({ type: "NpcBorn", fields: { charId: `npc-${n.npcId}` } }, null, FOREVER);
}

console.log(`[migrate] ${file} into ${regionsOf(w).map((g) => g.regionId).join(", ")}:`);
for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
regions.close();
await host.close(ctx);
process.exit(0);
