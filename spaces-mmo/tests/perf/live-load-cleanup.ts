// After live-load.ts: removes its figures from the world. Their coins go back to a trader (Kalle, or in a region without
// him another NPC there: they got them from the traders, so the world keeps its coins), then their guest accounts are
// taken; the world's own cleanup (world-host.ts, every SPACES_MMO_CLEANUP_MS) then removes each character with what it
// carried, its cell and what it gave to the fires. Waits until every character is gone. With SPACES_MMO_REGIONS (the
// world in regions, docs/welt-aufteilen.md) it does this in every region. Run where `phi-spaces` resolves and the spaces
// are reachable, e.g. in the web container (docs/betrieb.md, "Lasttest"):
//
//   node --experimental-strip-types live-load-cleanup.ts bots.json [tcp:127.0.0.1:3950]
import { readFileSync } from "node:fs";
import { connectSpace, FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";

const [file, address = process.env.SPACES_MMO_SPACE ?? "tcp:127.0.0.1:3950"] = process.argv.slice(2);
if (!file) throw new Error("usage: live-load-cleanup.ts bots.json [address]");
const bots = JSON.parse(readFileSync(file, "utf8")) as { charId: string; name: string }[];
const addresses = (process.env.SPACES_MMO_REGIONS ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.slice(x.indexOf("=") + 1));
const conns = (addresses.length ? addresses : [address]).map((a) => connectSpace(a, { callTimeoutMs: 20_000 }));
const close = () => { for (const c of conns) c.close(); };

let coins = 0, accounts = 0;
/** The NPC a region's coins go back to: Kalle where he is, else the first NPC standing there. */
const traderIn = async (space: SpaceLike) => {
	const npcs = (await space.readAll({ type: "Character" })).map((e) => String(e.fields.charId)).filter((id) => id.startsWith("npc-"));
	return npcs.includes("npc-kalle") ? "npc-kalle" : npcs[0] ?? null;
};
for (const { space } of conns) {
	const to = await traderIn(space);
	for (const b of bots) {
		const accountId = (await space.readAll({ type: "Character", fields: { charId: b.charId } }, { limit: 1 }))[0]?.fields.accountId;
		if (!accountId) continue;
		for (const e of to ? await space.readAll({ type: "Item", fields: { location: b.charId, proto: "muenze" } }) : []) {
			const t = await space.createTransaction(30_000);
			const c = await space.takeIfExists({ type: "Item", id: e.id }, NO_WAIT, { txn: t.id });
			if (c) { await space.write({ type: c.type, types: c.types.slice(1), fields: { ...c.fields, location: to } }, t.id, FOREVER); coins++; }
			await space.commit(t.id);
		}
		if (await space.takeIfExists({ type: "Account", fields: { accountId: String(accountId), guest: true } }, NO_WAIT)) accounts++;
	}
}
console.log(`${coins} coins back to the traders, ${accounts} of ${bots.length} guest accounts taken in ${conns.length} space(s); waiting for the world's cleanup`);
const ids = new Set(bots.map((b) => b.charId));
const end = Date.now() + 5 * 60_000;
for (;;) {
	let left = 0;
	for (const { space } of conns) left += (await space.readAll({ type: "Character", fields: { guest: true } })).filter((c) => ids.has(String(c.fields.charId))).length;
	if (!left) { console.log("every figure is gone"); break; }
	if (Date.now() > end) { console.error(`${left} figures still there after 5 minutes`); process.exitCode = 1; break; }
	await new Promise((r) => setTimeout(r, 5_000));
}
close();
