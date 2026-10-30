// The epochs of an island, step 4 part 1 (docs/siedeln.md "Epochen: was die Stufe freischaltet"): an island counts its
// held stock, every building, bed and field by the light points it takes, and reaches the next epoch at a threshold
// (the settings epoch.dorf, epoch.stadt, epoch.netz, so a server with few players can lower them).
//
// - The count runs in the world worker (job "epoch", and once at its start) over the islands of its region; it writes
//   the island's Epoch entry only when the epoch changes, and tells every room of the island.
// - Falling back needs no mechanism of its own: what decays no longer counts. Buildings of a higher epoch stand and work
//   on; only new plans of that epoch are refused (`bau`, `flur anlegen`) until the stock is enough again.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BedFields, type BuildingFields, type EpochFields, type FieldFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, msgOptions, type CommandCtx } from "../context.ts";
import { peek } from "../../space.ts";
import { setting } from "../../settings.ts";
import type { WorldDef } from "../world.ts";

/** The island a room belongs to (undefined: none, then it has no epoch). */
export const islandOf = (w: WorldDef, roomId: string) => (w.allRooms ?? w.rooms).find((r) => r.roomId === roomId)?.island;
/** The thresholds from the second epoch on. */
export const thresholds = async (space: SpaceLike) => [await setting(space, "epoch.dorf"), await setting(space, "epoch.stadt"), await setting(space, "epoch.netz")];
/** The epoch a stock of `points` reaches (1: none of the thresholds), at most the world's last. */
export const epochFor = (points: number, limits: number[], count = limits.length + 1) => Math.min(count, 1 + limits.filter((t) => points >= t).length);
export const epochName = (w: WorldDef, epoch: number) => w.epochs?.names[epoch - 1] ?? `Epoche ${epoch}`;
/** The epoch's name with its article ("ein Dorf", "eine Stadt"). */
const a = (w: WorldDef, epoch: number) => w.epochs?.a[epoch - 1] ?? `Epoche ${epoch}`;

/** The held stock of every island of this region: buildings, beds and fields that still stand, by their light points. */
export async function islandPoints(space: SpaceLike, w: WorldDef, now: number): Promise<Map<string, { points: number; buildings: number; beds: number; fields: number }>> {
	const out = new Map<string, { points: number; buildings: number; beds: number; fields: number }>();
	for (const r of w.rooms) if (r.island && !out.has(r.island)) out.set(r.island, { points: 0, buildings: 0, beds: 0, fields: 0 });
	const add = (room: string, points: number | undefined, what: "buildings" | "beds" | "fields") => {
		const i = islandOf(w, room), t = i ? out.get(i) : undefined;
		if (t) { t.points += points ?? 1; t[what] += points ?? 1; }
	};
	for (const e of await space.readAll({ type: "Building" })) { const b = fieldsOf<BuildingFields>(e); if (b.untilWorldMs > now) add(b.room, b.points, "buildings"); }
	for (const e of await space.readAll({ type: "Bed" })) { const b = fieldsOf<BedFields>(e); if (b.untilWorldMs > now) add(b.room, b.points, "beds"); }
	for (const e of await space.readAll({ type: "Field" })) { const f = fieldsOf<FieldFields>(e); if (f.untilWorldMs > now) add(f.room, f.points, "fields"); }
	return out;
}

/** An island's epoch as written (1 without an entry). */
export async function epochOf(space: SpaceLike, island: string | undefined, txn: string | null = null): Promise<number> {
	if (!island) return 1;
	const e = await peek(space, { type: "Epoch", fields: { island } }, { txn });
	return e ? fieldsOf<EpochFields>(e).epoch : 1;
}

/** The count (job "epoch"): each island of the region whose epoch changed gets its entry written anew and is told. */
export async function epochTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<Array<{ island: string; epoch: number }>> {
	if (!w.epochs) return [];
	const now = await worldNowOf(space), limits = await thresholds(space), changed: Array<{ island: string; epoch: number }> = [];
	for (const [island, t] of await islandPoints(space, w, now)) {
		const epoch = epochFor(t.points, limits, w.epochs.names.length);
		if (epoch === (await epochOf(space, island))) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const old = await space.takeIfExists({ type: "Epoch", fields: { island } }, NO_WAIT, { txn });
			const was = old ? fieldsOf<EpochFields>(old).epoch : 1;
			if (was === epoch) { await space.abort(txn); continue; }
			if (epoch > 1 || old) await space.write({ type: "Epoch", fields: { island, epoch, points: t.points, at: now } satisfies EpochFields as never }, txn, FOREVER);
			const text = epoch > was
				? `${island} ist jetzt ${a(w, epoch)} (Epoche ${epoch}): ${unlocks(w, epoch) || "neue Pläne"} lassen sich jetzt bauen.`
				: `${island} ist wieder ${a(w, epoch)} (Epoche ${epoch}): zu viel ist verfallen. Was steht, arbeitet weiter; neue Pläne der höheren Stufe warten, bis der Bestand wieder reicht.`;
			for (const r of w.rooms.filter((x) => x.island === island)) {
				await space.write({ type: "Msg", fields: { room: r.roomId, to: "*", kind: "world", text, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
			}
			await space.commit(txn);
			changed.push({ island, epoch });
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return changed;
}

const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1);
/** What an epoch unlocks: the plans of exactly that epoch, and the fields. */
function unlocks(w: WorldDef, epoch: number): string {
	const names = (w.building?.plans ?? []).filter((p) => (p.epoch ?? 1) === epoch).map((p) => p.name);
	if ((w.fields?.epoch ?? 1) === epoch && epoch > 1) names.push("Fluren");
	return names.join(", ");
}

/** Throws when the actor's island has not reached `need` (a new plan of a higher epoch). */
export async function needEpoch(c: CommandCtx, need: number | undefined, what: string): Promise<void> {
	if (!need || need <= 1 || !c.world.epochs) return;
	const island = islandOf(c.world, c.actor.room), have = await epochOf(c.space, island, c.txn);
	if (have >= need) return;
	const limit = (await thresholds(c.space))[need - 2] ?? 0;
	throw new CommandError(`${what} braucht ${a(c.world, need)} (Epoche ${need}); ${island ?? "diese Insel"} hat noch nicht genug Bestand (ab ${limit} Punkten; „epoche“ zeigt, wie viele es sind).`);
}

const epoche: Command = {
	key: "epoche", aliases: ["epoch", "stufe"],
	help: "epoche – auf welcher Stufe diese Insel steht, wie viele Punkte ihr Bestand hat und was die nächste freischaltet",
	async func(c) {
		if (!c.world.epochs) throw new CommandError("In dieser Welt gibt es keine Epochen.");
		const island = islandOf(c.world, c.actor.room);
		if (!island) throw new CommandError("Dieser Ort gehört zu keiner Insel.");
		const now = await worldNowOf(c.space, c.txn), limits = await thresholds(c.space);
		const t = (await islandPoints(c.space, c.world, now)).get(island) ?? { points: 0, buildings: 0, beds: 0, fields: 0 };
		const epoch = await epochOf(c.space, island, c.txn), last = c.world.epochs.names.length;
		const parts = `Bauten ${t.buildings}, Beete ${t.beds}, Fluren ${t.fields}`;
		const next = epoch < last ? ` ${cap(a(c.world, epoch + 1))} braucht ${limits[epoch - 1]} Punkte${unlocks(c.world, epoch + 1) ? `; dann gibt es ${unlocks(c.world, epoch + 1)}` : ""}.` : "";
		const due = epochFor(t.points, limits, last) !== epoch ? " (Die Zählung holt das bald nach.)" : "";
		await msg(c, c.actor.charId, "info", `${island} ist ${a(c.world, epoch)} (Epoche ${epoch}): ${t.points} Punkte gehaltener Bestand (${parts}).${next}${due}`);
	},
};

export const EPOCH_COMMANDS: Command[] = [epoche];
