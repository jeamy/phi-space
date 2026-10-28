// After live-load.ts: removes its figures from the world. Their coins go back to Kalle (they got them from him, so the
// world keeps its coins), then their guest accounts are taken; the world's own cleanup (world-host.ts, every
// SPACES_MMO_CLEANUP_MS) then removes each character with what it carried, its cell and what it gave to the fires.
// Waits until every character is gone. Run where `phi-spaces` resolves and the world space is reachable, e.g. in the
// web container (docs/betrieb.md, "Lasttest"):
//
//   node --experimental-strip-types live-load-cleanup.ts bots.json [tcp:127.0.0.1:3950]
import { readFileSync } from "node:fs";
import { connectSpace, FOREVER, NO_WAIT } from "phi-spaces";

const [file, address = process.env.SPACES_MMO_SPACE ?? "tcp:127.0.0.1:3950"] = process.argv.slice(2);
if (!file) throw new Error("usage: live-load-cleanup.ts bots.json [address]");
const bots = JSON.parse(readFileSync(file, "utf8")) as { charId: string; name: string }[];
const { space, close } = connectSpace(address, { callTimeoutMs: 20_000 });
const COINS_TO = "npc-kalle";

let coins = 0, accounts = 0;
for (const b of bots) {
	const accountId = (await space.readAll({ type: "Character", fields: { charId: b.charId } }, { limit: 1 }))[0]?.fields.accountId;
	for (const e of await space.readAll({ type: "Item", fields: { location: b.charId, proto: "muenze" } })) {
		const t = await space.createTransaction(30_000);
		const c = await space.takeIfExists({ type: "Item", id: e.id }, NO_WAIT, { txn: t.id });
		if (c) { await space.write({ type: c.type, types: c.types.slice(1), fields: { ...c.fields, location: COINS_TO } }, t.id, FOREVER); coins++; }
		await space.commit(t.id);
	}
	if (accountId && await space.takeIfExists({ type: "Account", fields: { accountId: String(accountId), guest: true } }, NO_WAIT)) accounts++;
}
console.log(`${coins} coins back to ${COINS_TO}, ${accounts} of ${bots.length} guest accounts taken; waiting for the world's cleanup`);
const ids = new Set(bots.map((b) => b.charId));
const end = Date.now() + 5 * 60_000;
for (;;) {
	const left = (await space.readAll({ type: "Character", fields: { guest: true } })).filter((c) => ids.has(String(c.fields.charId))).length;
	if (!left) { console.log("every figure is gone"); break; }
	if (Date.now() > end) { console.error(`${left} figures still there after 5 minutes`); process.exitCode = 1; break; }
	await new Promise((r) => setTimeout(r, 5_000));
}
close();
