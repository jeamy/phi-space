// Food, step 7 (docs/siedeln.en.md "Food"): `iss` eats a thing and keeps the figure sated for a while, the better food the
// longer; whoever is sated rests less after work. There is no hunger: nobody loses anything, whoever does not eat only works at
// the base pace. Like a blessing it is one entry per figure in its region.
import { FOREVER, NO_WAIT } from "phi-spaces";
import { fieldsOf, type SatedFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, NotUnderstood, type CommandCtx } from "../context.ts";
import { peek } from "../../space.ts";
import { consume } from "./trade.ts";

/** How much shorter the rest is for a figure that is sated now: 1 when it is not. */
export async function satedFactor(c: CommandCtx, now: number): Promise<number> {
	const d = c.world.food;
	if (!d) return 1;
	const e = await peek(c.space, { type: "Sated", fields: { charId: c.actor.charId } });
	return e && fieldsOf<SatedFields>(e).untilWorldMs > now ? d.restFactor : 1;
}

const iss: Command = {
	key: "iss", aliases: ["esse", "essen", "eat"],
	help: "iss <ding> – etwas essen: Satt ruhst du nach der Arbeit kürzer; Brot hält länger als ein Ei",
	async func(c, arg) {
		const d = c.world.food;
		if (!d) throw new CommandError("In dieser Welt isst man nicht.");
		const names = () => Object.keys(d.foods).map((p) => c.world.prototypes.find((x) => x.key === p)?.name ?? p).join(", ");
		if (!arg.trim()) throw new NotUnderstood(`Was isst du? Satt machen: ${names()}.`);
		const it = itemsNamed(c.world, await inventory(c), arg.trim())[0];
		if (!it) throw new NotUnderstood(`Du trägst nichts, was „${arg.trim().slice(0, 30)}“ heißt.`);
		const ms = d.foods[it.f.proto];
		if (!ms) throw new CommandError(`${it.f.name} macht nicht satt. Das tun: ${names()}.`);
		await consume(c, it.f, c.actor.charId);
		const now = await worldNowOf(c.space, c.txn), held = await c.space.takeIfExists({ type: "Sated", fields: { charId: c.actor.charId } }, NO_WAIT, { txn: c.txn });
		const from = held ? Math.max(now, fieldsOf<SatedFields>(held).untilWorldMs) : now;
		await c.space.write({ type: "Sated", fields: { charId: c.actor.charId, untilWorldMs: Math.min(now + d.maxWorldMs, from + ms) } satisfies SatedFields as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(isst|isst) ${it.f.name}.`, { templ: true });
	},
};

export const FOOD_COMMANDS: Command[] = [iss];
