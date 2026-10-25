// Scripts of the npc process. A script is one round of an NPC's life: it reads the world, types at most a few commands
// (npc.act waits until each is taken) and sleeps; the npc process calls it again and again. Pauses are game time.
import type { SpaceLike } from "phi-spaces";
import { flameOf } from "../engine/fire.ts";
import { gameMs } from "../engine/time.ts";
import type { NpcDef, WorldDef } from "../engine/world.ts";
import { fieldsOf, type CharacterFields, type ExitFields, type MsgFields } from "../model.ts";

export type Npc = {
	def: NpcDef; charId: string; space: SpaceLike; world: WorldDef; halt: AbortSignal;
	sleep(ms: number): Promise<void>;
	/** Types a command (an intent) and waits until a world worker has taken it. */
	act(line: string): Promise<void>;
};
export type Script = (npc: Npc) => Promise<void>;

/** The NPC's character, or null while the world has not created it yet (the npc process may start first). */
const self = async (n: Npc) => { const e = await n.space.readIfExists({ type: "Character", fields: { charId: n.charId } }, 5_000); return e ? fieldsOf<CharacterFields>(e) : null; };

/** The beacon keeper: watches its fire and says when it grows weak, goes out or burns again; greets who says hello. */
function waerter(): Script {
	let state: "ok" | "low" | "out" | null = null;
	let seen = Date.now();
	const greeted = new Map<string, number>();
	return async (n) => {
		const beacon = n.world.beacons.find((b) => b.beaconId === n.def.beacon);
		if (beacon) {
			const f = await flameOf(n.space, beacon.beaconId), now = Date.now();
			const piece = Math.min(...Object.values(n.world.fire.fuel).map((ms) => gameMs(ms)));
			const next = !f || f.until <= now ? "out" : f.until - now < piece * 1.5 ? "low" : "ok";
			if (state !== null && next !== state) {
				if (next === "low") await n.act("say Das Feuer wird schwach – bringt Treibholz!");
				else if (next === "out") await n.act("say Das Feuer ist aus! Ohne Licht frisst uns der Nebel.");
				else await n.act("say Danke! So brennt es wieder.");
			}
			state = next;
		}
		// greetings: whoever said hello in this room since the last round (once per name in a while)
		const me = await self(n);
		if (!me) { await n.sleep(1000); return; }
		const said = (await n.space.readAll({ type: "Msg", fields: { room: me.room, to: "*", kind: "say" } })).map((e) => fieldsOf<MsgFields>(e)).filter((m) => m.at > seen && m.from !== me.name);
		seen = Date.now();
		for (const m of said) {
			if (!/\b(hallo|hi|moin|hello|servus)\b/i.test(m.text)) continue;
			if (Date.now() - (greeted.get(m.from) ?? 0) < gameMs(10 * 60_000)) continue;
			greeted.set(m.from, Date.now());
			await n.act(`say Willkommen am Feuer, ${m.from}!`);
		}
		await n.sleep(gameMs(3_000, 100));
	};
}

/** The ferryman: walks to the exit of the room he is in, takes it, rests, and goes back the same way. Fog that hides
 *  the way stops him until it clears (the world refuses the step; he tries again later). */
function faehrmann(): Script {
	return async (n) => {
		const me = await self(n);
		if (!me) { await n.sleep(1000); return; }
		const exits = (await n.space.readAll({ type: "Exit", fields: { location: me.room } })).map((e) => fieldsOf<ExitFields>(e));
		const exit = exits[0];
		if (!exit) { await n.sleep(gameMs(30_000)); return; }
		await n.act(`move ${exit.x} ${exit.y}`);
		const after = await self(n);
		await n.sleep(after && after.room !== me.room ? gameMs(30_000) : gameMs(15_000));
	};
}

const MAKERS: Record<string, () => Script> = { waerter, faehrmann };

/** A fresh instance of the named script (state such as "already greeted" is per NPC), or undefined. */
export const scriptFor = (name: string): Script | undefined => (Object.hasOwn(MAKERS, name) ? MAKERS[name]!() : undefined);
