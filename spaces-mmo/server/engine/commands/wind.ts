// Wind, weather of its own (docs/siedeln.en.md "Weather"): each island has a level that moves a step now and then, from a lull
// to a gale; a storm surge makes it a gale at once. A mill grinds by the wind that blows when the load comes. `wetter` tells
// it. An island nobody counted yet has the ordinary breeze, so a world needs nothing written to start.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type FogFields, type WindFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, msgOptions, roomOf } from "../context.ts";
import { peek } from "../../space.ts";
import type { WorldDef } from "../world.ts";
import { randomInt, timeNow } from "../source.ts";

const BREEZE = 1;
const levelOf = async (space: SpaceLike, island: string | undefined, txn: string | null = null) => { const e = island ? await peek(space, { type: "Wind", fields: { island } }, { txn }) : null; return e ? fieldsOf<WindFields>(e).level : BREEZE; };
const islandOf = (w: WorldDef, room: string) => w.rooms.find((r) => r.roomId === room)?.island;
/** How fast a mill in `room` grinds now: 1 is its plain pace. */
export const windFactor = async (space: SpaceLike, w: WorldDef, room: string, txn: string | null = null) => w.wind?.mill[await levelOf(space, islandOf(w, room), txn)] ?? 1;

async function setLevel(space: SpaceLike, w: WorldDef, island: string, level: number, leaseMs: number): Promise<boolean> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const was = await space.takeIfExists({ type: "Wind", fields: { island } }, NO_WAIT, { txn });
		const before = was ? fieldsOf<WindFields>(was).level : BREEZE;
		if (before === level) { await space.abort(txn); return false; }
		await space.write({ type: "Wind", fields: { island, level } satisfies WindFields as never }, txn, FOREVER);
		// the gale comes and goes aloud; the rest one reads with `wetter`
		const top = w.wind!.names.length - 1, text = level === top ? `Über ${island} frischt der Wind zum Sturm auf.` : before === top ? `Über ${island} lässt der Sturm nach.` : "";
		if (text) for (const r of w.rooms.filter((x) => x.island === island)) await space.write({ type: "Msg", fields: { room: r.roomId, to: "*", kind: "world", text, from: "", at: timeNow() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
		await space.commit(txn);
		return true;
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** Each island's wind moves a step up, a step down or stays. How many changed. */
export async function windTick(space: SpaceLike, w: WorldDef, leaseMs: number, rnd: (n: number) => number = (n) => randomInt(0, n)): Promise<number> {
	if (!w.wind) return 0;
	let changed = 0;
	for (const island of new Set(w.rooms.flatMap((r) => (r.island ? [r.island] : [])))) {
		const level = await levelOf(space, island), next = Math.max(0, Math.min(w.wind.names.length - 1, level + rnd(3) - 1));
		if (await setLevel(space, w, island, next, leaseMs)) changed++;
	}
	return changed;
}
/** A storm surge is a gale on its island (engine/fire.ts stormTick names the room). */
export async function stormRaisesWind(space: SpaceLike, w: WorldDef, roomId: string | null, leaseMs: number): Promise<void> {
	const island = roomId ? islandOf(w, roomId) : undefined;
	if (w.wind && island) await setLevel(space, w, island, w.wind.names.length - 1, leaseMs);
}

const wetter: Command = {
	key: "wetter", aliases: ["weather", "wind"],
	help: "wetter – wie der Wind hier steht und wie dicht der Nebel ist; der Wind treibt die Mühlen",
	async func(c) {
		const d = c.world.wind;
		if (!d) throw new CommandError("In dieser Welt gibt es kein Wetter.");
		const room = await roomOf(c), level = await levelOf(c.space, room.island, c.txn), fog = await peek(c.space, { type: "Fog", fields: { room: room.roomId } }, { txn: c.txn });
		const pace = d.mill[level] ?? 1, thick = fog ? fieldsOf<FogFields>(fog).level : 0;
		await msg(c, c.actor.charId, "info", `${d.names[level]}${room.island ? ` über ${room.island}` : ""}; ${pace === 1 ? "die Mühlen mahlen in ihrem Takt" : pace > 1 ? `die Mühlen mahlen ${pace}-mal so schnell` : "die Mühlen mahlen nur langsam"}. ${thick > 0 ? "Nebel liegt über dem Land." : "Die Sicht ist klar."}`);
	},
};

export const WIND_COMMANDS: Command[] = [wetter];
