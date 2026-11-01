// Beaming: from wherever one stands to the room of a burning fire, for coins and with a pause after it, so no way has to be
// walked again. The fires hold the world together (docs/siedeln.en.md, "Epochen": the net, epoch 4): only the target needs a
// fire, and it must burn. The cost is the coins per field of distance on the world
// map, the pause and the epoch from which it is allowed are the admin's settings (beam.cost, beam.cooldown, beam.epoch).
// Within a region the target's fire is checked; to another region the character goes over like on a ferry (handover.ts) and
// the command cannot see that region's fires: the world map offers only burning ones, and a dark one is a place like another.
import { NO_WAIT, FOREVER } from "phi-spaces";
import { fieldsOf, type BeamRestFields } from "../../model.ts";
import { peek } from "../../space.ts";
import { setting } from "../../settings.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { flameOf, isLit } from "../fire.ts";
import { handOff } from "../handover.ts";
import type { RoomDef, WorldDef } from "../world.ts";
import { human, plural } from "./build.ts";
import { crossing, describeRoom, dropOffers, placeIn, relocate } from "./default.ts";
import { needEpoch } from "./epoch.ts";
import { consume } from "./trade.ts";

type Fire = WorldDef["beacons"][number];
type Target = { fire: Fire; room: RoomDef; cost: number; lit: boolean | null };

const roomOfId = (w: WorldDef, id: string): RoomDef | undefined => (w.allRooms ?? w.rooms).find((r) => r.roomId === id);
/** Fields of distance on the world map between two rooms, at least one. */
export const fieldsBetween = (a: RoomDef | undefined, b: RoomDef | undefined): number => (a?.map && b?.map ? Math.max(1, Math.abs(a.map.x - b.map.x) + Math.abs(a.map.y - b.map.y)) : 1);
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Every other fire of the world with what it costs from here; `lit` is known for the fires of this region only. */
async function targets(c: CommandCtx, now: number): Promise<Target[]> {
	const per = await setting(c.space, "beam.cost"), from = roomOfId(c.world, c.actor.room), here = new Set(c.world.beacons.map((b) => b.beaconId));
	const out: Target[] = [];
	for (const fire of c.world.allBeacons ?? c.world.beacons) {
		const room = roomOfId(c.world, fire.room);
		if (!room || fire.room === c.actor.room) continue;
		out.push({ fire, room, cost: per * fieldsBetween(from, room), lit: here.has(fire.beaconId) ? isLit(await flameOf(c.space, fire.beaconId, c.txn ?? undefined), now) : null });
	}
	return out.sort((a, b) => a.cost - b.cost || a.room.name.localeCompare(b.room.name));
}

const place = (t: Target) => `${t.room.name}${t.room.island ? ` (${t.room.island})` : ""}`;

const beam: Command = {
	key: "beam", aliases: ["beame", "beamen"],
	help: "beam [ort] – zu einem brennenden Feuer springen, von wo du stehst (kostet Münzen, danach eine Pause); ohne Ort zeigt es die Ziele",
	async func(c, arg) {
		if (!human(c)) throw new CommandError("Beamen können nur Menschen.");
		await needEpoch(c, await setting(c.space, "beam.epoch"), "Das Beamen");
		const now = await worldNowOf(c.space, c.txn);
		const all = await targets(c, now);
		const coins = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		const rest = await peek(c.space, { type: "BeamRest", fields: { charId: c.actor.charId } });
		const until = rest ? fieldsOf<BeamRestFields>(rest).untilWorldMs : 0;
		if (!arg.trim()) {
			return msg(c, c.actor.charId, "info", [
				`Hierhin kannst du beamen (zu einem brennenden Feuer; du trägst ${plural(coins.length, "Münze", "Münzen")}${until > now ? `; die Pause dauert noch etwa ${Math.max(1, Math.round((until - now) / 60_000))} Minuten` : ""}):`,
				...all.map((t) => `  ${place(t)}: ${plural(t.cost, "Münze", "Münzen")}${t.lit === false ? " (das Feuer ist aus)" : ""}  – beam ${t.room.name}`),
			].join("\n"));
		}
		const want = norm(arg);
		let found = all.filter((t) => [t.fire.beaconId, t.room.roomId, t.room.name, t.fire.name].some((n) => norm(n) === want));
		if (!found.length) found = all.filter((t) => [t.room.name, t.fire.name, t.room.island ?? ""].some((n) => norm(n).includes(want)));
		if (!found.length) throw new NotUnderstood(`Dorthin führt kein Feuer: „${arg.trim().slice(0, 30)}“. „beam“ zeigt die Ziele.`);
		if (found.length > 1) throw new CommandError(`Meinst du ${found.slice(0, 5).map(place).join(" oder ")}? Schreib den Ort genauer.`);
		const t = found[0]!;
		if (until > now) throw new CommandError(`Du hast eben erst gebeamt; in etwa ${Math.max(1, Math.round((until - now) / 60_000))} Minuten wieder.`);
		if (t.lit === false) throw new CommandError(`Das Feuer in ${t.room.name} ist aus; beamen kann man nur zu einem brennenden Feuer.`);
		if (coins.length < t.cost) throw new CommandError(`Nach ${t.room.name} zu beamen kostet ${plural(t.cost, "Münze", "Münzen")}, du hast ${coins.length}.`);
		for (const coin of coins.slice(0, t.cost)) await consume(c, coin.f, c.actor.charId);
		const pause = (await setting(c.space, "beam.cooldown")) * 60_000;
		if (rest) await c.space.takeIfExists({ id: rest.id }, NO_WAIT, { txn: c.txn });
		if (pause > 0) await c.space.write({ type: "BeamRest", fields: { charId: c.actor.charId, untilWorldMs: now + pause } satisfies BeamRestFields as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(löst|löst) $conj(dich|sich) auf.`, { templ: true });
		const landing = { x: t.fire.x, y: t.fire.y + 1 }, toRegion = crossing(c.world, t.room.roomId);
		await dropOffers(c);
		if (toRegion) { await handOff(c, c.world.region!, toRegion, { room: t.room.roomId, ...landing }); return; }
		const dest = await roomOf(c, t.room.roomId), at = await placeIn(c, dest, landing);
		await relocate(c, { room: dest.roomId, x: at.x, y: at.y }, { spot: false });
		await msg(c, "*", "info", `$you() $conj(erscheinst|erscheint) im Licht des Feuers.`, { templ: true, room: dest.roomId });
		await msg(c, c.actor.charId, "look", await describeRoom(c, dest.roomId, true), { room: dest.roomId });
	},
};

export const BEAM_COMMANDS: Command[] = [beam];
