// The quarry, step 5 part 2 (docs/siedeln.md "Stoffe"): beside a quarry, anyone's, a pickaxe breaks stone. It is work: the
// tool wears, and the figure rests afterwards like after `arbeite`.
import { fieldsOf, type BuildingFields } from "../../model.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, type CommandCtx } from "../context.ts";
import { distTo, planOf, rested, tire } from "./build.ts";
import { needRank } from "./settlement.ts";
import { consume, move } from "./trade.ts";

const breche: Command = {
	key: "breche", aliases: ["brechen", "quarry"],
	help: "breche – am Steinbruch neben dir mit einer Spitzhacke Stein brechen (danach ruhst du eine Weile)",
	async func(c: CommandCtx) {
		const q = c.world.quarry;
		if (!q) throw new CommandError("In dieser Welt gibt es keine Steinbrüche.");
		const plan = planOf(c.world, q.plan);
		const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan: q.plan } })).some((e) => distTo(c.actor, fieldsOf<BuildingFields>(e)) <= 1);
		if (!near) throw new CommandError(`Stein bricht man direkt neben ${plan?.dative ?? "einem Steinbruch"}.`);
		await needRank(c, "helfer", "Stein brechen");
		const { now, rest } = await rested(c);
		const tool = (await inventory(c)).find((i) => i.f.proto === q.tool);
		if (!tool) throw new CommandError(`Dafür brauchst du ein Werkzeug: ${q.tool}.`);
		const p = await resolvePrototype(c.space, q.makes);
		if (!p) throw new CommandError("Der Steinbruch ist kaputt.");
		const left = (tool.f.wear ?? 1) - 1;
		if (left <= 0) await consume(c, tool.f, c.actor.charId);
		else await move(c, tool.f, c.actor.charId, c.actor.charId, { wear: left });
		for (let i = 0; i < q.count; i++) await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 });
		await tire(c, now, rest);
		await msg(c, "*", "info", `$you() $conj(brichst|bricht) ${q.count} ${p.name} aus dem Fels.${left <= 0 ? ` Die ${tool.f.name} zerbricht dabei.` : ""}`, { templ: true });
	},
};

export const QUARRY_COMMANDS: Command[] = [breche];
