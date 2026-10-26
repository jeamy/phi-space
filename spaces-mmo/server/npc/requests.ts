// What people ask an NPC in plain words, and what the keeper can do about it without a model: bring wood to the fire.
// "hi ines, geh holz sammeln", "ines, sammle bitte drei Scheit Treibholz", "bitte an ines, holz zu sammeln": the sentence
// names her and asks for wood, so she walks to the driftwood, picks it up, takes it to the fire and says what she did.
// With a model (docs/modell-npcs.md) the model answers; this is the script that answers when it is off or asleep.
import { fieldsOf, type ItemFields } from "../model.ts";
import type { Npc } from "./scripts.ts";

export type Request = { kind: "gather"; count: number } | { kind: "feed" } | { kind: "greet" } | { kind: "unclear" };

const NUMBER: Record<string, number> = { ein: 1, eine: 1, einen: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, fünf: 5 };
const GREETING = /\b(hallo|hi|moin|hello|servus|guten (tag|abend|morgen))\b/i;
const WOOD = /\b(treibholz|holz|scheite?|brennholz|driftwood|wood)\b/i;
const FETCH = /\b(samm\w*|hol(e|en|t)?|such\w*|bring\w*|besorg\w*|geh\w*|lauf\w*|beschaff\w*|collect|fetch|gather|get)\b/i;
const FEED = /\b(leg\w*|wirf\w*|werf\w*|füttere\w*|nachlegen|nachlege\w*|feed|put|throw)\b/i;

/** What `text` asks of the NPC called `name`; null when the sentence is not meant for her (her name is not in it). */
export function requestOf(text: string, name: string): Request | null {
	if (!new RegExp(`(^|[^\\p{L}])${name}([^\\p{L}]|$)`, "iu").test(text)) return null;
	const wood = WOOD.test(text);
	if (wood && FEED.test(text) && /\b(feuer|leuchtfeuer|fire)\b/i.test(text)) return { kind: "feed" };
	if (wood && FETCH.test(text)) {
		const n = /\b(\d+)\b/.exec(text)?.[1] ?? Object.keys(NUMBER).find((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
		const count = n === undefined ? 2 : /^\d+$/.test(n) ? Number(n) : NUMBER[n.toLowerCase()]!;
		return { kind: "gather", count: Math.max(1, Math.min(4, count)) };
	}
	if (GREETING.test(text) && text.replace(GREETING, "").replace(new RegExp(name, "i"), "").replace(/[^\p{L}]/gu, "").length < 3) return { kind: "greet" };
	return { kind: "unclear" };
}

const reach = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const isWood = (name: string) => /holz/i.test(name);
const scheite = (n: number) => `${n} Scheit${n === 1 ? "" : "e"}`;

/** Walks to driftwood in the room, picks up up to `count` pieces, takes them to the fire and puts them in. Says what it
 *  does and what came of it. Every step is a command like a player's; a step that fails (someone was faster) is left out. */
export async function gather(n: Npc, me: { name: string; charId: string }, from: string, count: number, position: () => Promise<{ x: number; y: number; room: string } | null>): Promise<void> {
	const carried = async () => (await n.space.readAll({ type: "Item", fields: { location: me.charId } })).map((e) => fieldsOf<ItemFields>(e)).filter((i) => isWood(i.name));
	const skipped = new Set<string>();
	let got = (await carried()).length;
	const start = got;
	// count 0: "put wood in the fire": what she carries goes in; with nothing in her pack she fetches one piece first
	if (count === 0) { if (got) await n.act(`say Gern, ich lege nach.`); else { count = 1; await n.act(`say Gern, ich hole erst ein Scheit Treibholz.`); } }
	else await n.act(`say Mach ich, ${from}: ich hole ${scheite(count)} Treibholz.`);
	for (let guard = 0; guard < count * 3 && got - start < count && !n.halt.aborted; guard++) {
		const here = await position();
		if (!here) break;
		const lying = (await n.space.readAll({ type: "Item", fields: { location: here.room } })).map((e) => fieldsOf<ItemFields>(e))
			.filter((i) => isWood(i.name) && !skipped.has(i.itemId)).sort((a, b) => reach(here, a) - reach(here, b));
		const piece = lying[0];
		if (!piece) break;
		if (reach(here, piece) > 0) await n.act(`move ${piece.x} ${piece.y}`);
		await n.act(`get ${piece.name}`);
		const after = (await carried()).length;
		if (after > got) got = after; else skipped.add(piece.itemId);
	}
	const mine = await carried();
	if (!mine.length) { await n.act(`say Am Strand liegt gerade kein Treibholz, ${from}. Die Flut bringt bald neues.`); return; }
	const beacon = n.world.beacons.find((b) => b.beaconId === n.def.beacon);
	const at = await position();
	if (beacon && at && at.room === beacon.room) {
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
			if (reach((await position()) ?? at, beacon) <= 1) break;
			await n.act(`move ${beacon.x + dx} ${beacon.y + dy}`);
		}
		if (reach((await position()) ?? at, beacon) <= 1) {
			for (let i = 0; i < mine.length && !n.halt.aborted; i++) await n.act(`put ${mine[i]!.name} in ${beacon.aliases?.[0] ?? "feuer"}`);
			await n.act(`say Fertig, ${from}: ${scheite(mine.length)} liegen im Feuer.`);
			return;
		}
	}
	await n.act(`say Ich habe ${scheite(mine.length)} gesammelt, ${from}, komme aber nicht ans Feuer.`);
}

/** A request the script cannot do. */
export const unclear = (from: string) => `Das habe ich nicht verstanden, ${from}. Ich hüte das Feuer und hole auf Wunsch Treibholz: sag zum Beispiel „Ines, hol Holz“.`;
