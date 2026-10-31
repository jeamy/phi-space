// The chapel, step 6 part 2 (docs/siedeln.md "Epoch 2"): beside one, anyone's, `opfere` gives up a thing of worth for a
// blessing: for a world day the rest after work is half as long. It is voluntary, nothing needs a chapel. A blessing is one
// entry per figure in its region; it does not cross over with it.
import { FOREVER, NO_WAIT } from "phi-spaces";
import { fieldsOf, type BlessingFields, type BuildingFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, NotUnderstood, type CommandCtx } from "../context.ts";
import { peek } from "../../space.ts";
import { distTo, planOf } from "./build.ts";
import { consume } from "./trade.ts";

/** The blessing of a figure, when it still holds. */
export async function blessed(c: CommandCtx, now: number): Promise<boolean> {
	if (!c.world.chapel) return false;
	const e = await peek(c.space, { type: "Blessing", fields: { charId: c.actor.charId } });
	return !!e && fieldsOf<BlessingFields>(e).untilWorldMs > now;
}

const opfere: Command = {
	key: "opfere", aliases: ["opfern", "sacrifice"],
	help: "opfere <ding> – an einer Kapelle neben dir etwas Wertvolles opfern: einen Tag lang ruhst du nach der Arbeit nur halb so lange",
	async func(c: CommandCtx, arg) {
		const ch = c.world.chapel;
		if (!ch) throw new CommandError("In dieser Welt gibt es keine Kapellen.");
		const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan: ch.plan } })).some((e) => distTo(c.actor, fieldsOf<BuildingFields>(e)) <= 1);
		if (!near) throw new CommandError(`Opfern kann man nur direkt neben ${planOf(c.world, ch.plan)?.dative ?? "einer Kapelle"}.`);
		const names = ch.offerings.map((p) => c.world.prototypes.find((x) => x.key === p)?.name ?? p).join(", ");
		if (!arg.trim()) throw new NotUnderstood(`Was opferst du? Willkommen sind: ${names}.`);
		const it = itemsNamed(c.world, await inventory(c), arg.trim())[0];
		if (!it) throw new NotUnderstood(`Du trägst nichts, was „${arg.trim().slice(0, 30)}“ heißt.`);
		if (!ch.offerings.includes(it.f.proto)) throw new CommandError(`${it.f.name} ist kein Opfer. Willkommen sind: ${names}.`);
		await consume(c, it.f, c.actor.charId);
		const now = await worldNowOf(c.space, c.txn);
		await c.space.takeIfExists({ type: "Blessing", fields: { charId: c.actor.charId } }, NO_WAIT, { txn: c.txn });
		await c.space.write({ type: "Blessing", fields: { charId: c.actor.charId, untilWorldMs: now + ch.blessWorldMs } satisfies BlessingFields as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(opferst|opfert) ${it.f.name}. Ein stiller Segen liegt nun auf $you().`, { templ: true });
	},
};

export const CHAPEL_COMMANDS: Command[] = [opfere];
