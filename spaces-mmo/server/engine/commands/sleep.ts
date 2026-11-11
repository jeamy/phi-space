// Sleep (docs/innenraeume.en.md "Sleep", step 2): `schlafe` beside the bed of a hut one may go into lays the figure down.
// Asleep it does nothing: the next command it sends only wakes it. The sleep gives rested works, one per `sleep.rate`
// world minutes slept, at most `sleep.max` (with what was left from before); a rested work writes no rest after it
// (build.ts / field.ts `tire`), so sleep puts the tiredness off and does not replace it. Without a bed nothing changes.
//
// - `Sleep` (one per figure): where it lies and since when. Only inside a building: the command path looks for it only
//   when the actor is in an interior, so a step outside costs no read. Logged out in bed, it sleeps on.
// - `Rested` (one per figure): how many rested works are left; gone when they are used up.
// - Put out of the house (ausladen, the building gone: interior.ts) wakes the figure there.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type RestedFields, type SleepFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, toPlayer, type CommandCtx } from "../context.ts";
import { timeNow } from "../source.ts";
import { setting } from "../../settings.ts";
import { peek } from "../../space.ts";
import { distTo } from "./build.ts";
import { furnishingFor, isInterior, nearBuildings } from "./interior.ts";

type Space = Pick<SpaceLike, "readAll" | "readIfExists" | "write" | "takeIfExists">;

const works = (n: number) => (n === 1 ? "eine Arbeit" : `${n} Arbeiten`);

/** Wakes `charId` if it sleeps: its rested works grow by the time slept and its rest after the last work is over.
 *  Null when it did not sleep. */
export async function wake(space: Space, txn: string, charId: string): Promise<{ slept: number; left: number; gained: number } | null> {
	const e = await space.takeIfExists({ type: "Sleep", fields: { charId } }, NO_WAIT, { txn });
	if (!e) return null;
	const s = fieldsOf<SleepFields>(e), now = await worldNowOf(space as SpaceLike, txn);
	const rate = Math.max(1, await setting(space as SpaceLike, "sleep.rate")) * 60_000, max = await setting(space as SpaceLike, "sleep.max");
	const slept = Math.max(0, now - s.sinceWorldMs), gained = Math.floor(slept / rate);
	const held = await space.takeIfExists({ type: "Rested", fields: { charId } }, NO_WAIT, { txn });
	const before = held ? fieldsOf<RestedFields>(held).left : 0, left = Math.max(before, Math.min(max, before + gained));
	if (left > 0) {
		await space.write({ type: "Rested", fields: { charId, left } satisfies RestedFields as never }, txn, FOREVER);
		// whoever wakes rested is not tired from the work before it lay down
		if (gained > 0) await space.takeIfExists({ type: "WorkRest", fields: { charId } }, NO_WAIT, { txn });
	}
	return { slept, left, gained: left - before };
}

/** What waking says: how long it slept and how many works it now does without a rest. */
export function wokeText(w: { slept: number; left: number; gained: number }): string {
	const mins = Math.round(w.slept / 60_000), long = mins >= 120 ? `${Math.round(mins / 60)} Stunden` : `${mins} Minuten`;
	if (!w.left) return `Du wachst auf nach ${long} Schlaf; das war zu kurz, um ausgeruht zu sein.`;
	return `Du wachst auf nach ${long} Schlaf. Ausgeruht: ${works(w.left)} ohne Pause danach.`;
}

/** Wakes a figure put out of a house (interior.ts): told as a notice, it stands outside already. */
export async function wakeOutside(space: Space, txn: string, charId: string, room: string): Promise<void> {
	const w = await wake(space, txn, charId);
	if (w) await toPlayer(space as SpaceLike, { room, to: charId, kind: "info", text: wokeText(w), from: "", fromId: "", at: timeNow() }, txn);
}

/** The command path: an actor asleep (only inside a house) is woken by whatever it sends, and nothing else is done.
 *  True when it woke. */
export async function wokenBy(c: CommandCtx, line: string): Promise<boolean> {
	if (!isInterior(c.actor.room) || /^(schlafe|schlafen|sleep)\b/i.test(line)) return false;
	const w = await wake(c.space, c.txn, c.actor.charId);
	if (!w) return false;
	await msg(c, c.actor.charId, "info", wokeText(w));
	return true;
}

/** A work point: a rested figure spends one rested work and rests not; true then (the caller writes no rest). */
export async function spendRested(c: CommandCtx): Promise<boolean> {
	const e = await peek(c.space, { type: "Rested", fields: { charId: c.actor.charId } });
	if (!e) return false;
	const t = await c.space.takeIfExists({ id: e.id }, NO_WAIT, { txn: c.txn });
	if (!t) return false;
	const left = fieldsOf<RestedFields>(t).left - 1;
	if (left > 0) await c.space.write({ type: "Rested", fields: { charId: c.actor.charId, left } satisfies RestedFields as never }, c.txn, FOREVER);
	await msg(c, c.actor.charId, "info", left > 0 ? `Ausgeruht: noch ${works(left)} ohne Pause.` : "Das war die letzte Arbeit ohne Pause; nach der nächsten ruhst du wieder.");
	return true;
}

const schlafe: Command = {
	key: "schlafe", aliases: ["schlafen", "sleep"],
	help: "schlafe – im Bett der Hütte schlafen: je länger, desto mehr Arbeiten danach ohne Pause (bis acht); jeder Befehl weckt",
	async func(c) {
		const bed = await furnishingFor(c, "sleep");
		if (!bed) throw new CommandError("Schlafen kann man im Bett einer Hütte; geh hinein („betrete“ neben ihr).");
		if (!(await nearBuildings(c, "sleep")).length || distTo(c.actor, bed) > 1) throw new CommandError(`Geh zum ${bed.name}.`);
		if (await peek(c.space, { type: "Sleep", fields: { charId: c.actor.charId } })) throw new CommandError("Du schläfst schon.");
		const other = (await c.space.readAll({ type: "Sleep", fields: { bed: bed.sceneryId } })).map((e) => fieldsOf<SleepFields>(e))[0];
		if (other) throw new CommandError(`Im ${bed.name} schläft schon ${other.name}.`);
		const now = await worldNowOf(c.space, c.txn), rate = Math.max(1, await setting(c.space, "sleep.rate")), max = await setting(c.space, "sleep.max");
		await c.space.write({ type: "Sleep", fields: { charId: c.actor.charId, name: c.actor.name, room: c.actor.room, bed: bed.sceneryId, sinceWorldMs: now } satisfies SleepFields as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(legst|legt) $conj(dich|sich) ins ${bed.name} und $conj(schläfst|schläft) ein.`, { templ: true });
		await msg(c, c.actor.charId, "info", `Je ${rate} Minuten Schlaf arbeitest du danach einmal ohne Pause, bis ${max}; jeder Befehl weckt dich.`);
	},
};

export const SLEEP_COMMANDS: Command[] = [schlafe];
