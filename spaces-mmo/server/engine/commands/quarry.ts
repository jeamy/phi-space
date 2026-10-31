// The quarry, step 5 part 2 (docs/siedeln.md "Stoffe"): beside a quarry, anyone's, a pickaxe breaks stone. It is work: the
// tool wears, and the figure rests afterwards like after `arbeite`.
import { fieldsOf, type BuildingFields } from "../../model.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, type CommandCtx } from "../context.ts";
import { distTo, planOf, rested, tire } from "./build.ts";
import type { WorldDef } from "../world.ts";
import { needRank } from "./settlement.ts";
import { consume, move } from "./trade.ts";

/** One work at a pit: `q`'s plan beside the actor, its tool in the pack. A tool without wear (the spade) stays whole. */
async function dig(c: CommandCtx, q: NonNullable<WorldDef["quarry"]>, what: string, done: string, tired: string): Promise<void> {
	const plan = planOf(c.world, q.plan);
	const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan: q.plan } })).some((e) => distTo(c.actor, fieldsOf<BuildingFields>(e)) <= 1);
	if (!near) throw new CommandError(`${what} direkt neben ${plan?.dative ?? "einer Grube"}.`);
	await needRank(c, "helfer", tired);
	const { now, rest } = await rested(c);
	const tool = (await inventory(c)).find((i) => i.f.proto === q.tool);
	if (!tool) throw new CommandError(`Dafür brauchst du ein Werkzeug: ${q.tool}.`);
	const p = await resolvePrototype(c.space, q.makes);
	if (!p) throw new CommandError("Der Steinbruch ist kaputt.");
	const left = tool.f.wear === undefined ? 1 : tool.f.wear - 1;
	if (left <= 0) await consume(c, tool.f, c.actor.charId);
	else if (tool.f.wear !== undefined) await move(c, tool.f, c.actor.charId, c.actor.charId, { wear: left });
	for (let i = 0; i < q.count; i++) await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 });
	await tire(c, now, rest);
	await msg(c, "*", "info", `$you() ${done.replace("%", `${q.count} ${p.name}`)}${left <= 0 ? ` Die ${tool.f.name} zerbricht dabei.` : ""}`, { templ: true });
}

const breche: Command = {
	key: "breche", aliases: ["brechen", "quarry"],
	help: "breche – am Steinbruch neben dir mit einer Spitzhacke Stein brechen (danach ruhst du eine Weile)",
	async func(c: CommandCtx) {
		if (!c.world.quarry) throw new CommandError("In dieser Welt gibt es keine Steinbrüche.");
		await dig(c, c.world.quarry, "Stein bricht man", "$conj(brichst|bricht) % aus dem Fels.", "Stein brechen");
	},
};

const steche: Command = {
	key: "steche", aliases: ["stechen", "clay"],
	help: "steche – an der Lehmgrube neben dir mit einem Spaten Lehm stechen (danach ruhst du eine Weile)",
	async func(c: CommandCtx) {
		if (!c.world.clay) throw new CommandError("In dieser Welt gibt es keine Lehmgruben.");
		await dig(c, c.world.clay, "Lehm sticht man", "$conj(stichst|sticht) % aus der Grube.", "Lehm stechen");
	},
};

export const QUARRY_COMMANDS: Command[] = [breche, steche];
