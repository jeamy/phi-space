// Scenery that stands in the way (docs/siedeln.en.md "Kulissen"): `räume` clears a piece beside one, work by work like a site; the
// last stroke frees its cells, gives what was in it and leaves a mark so that no new world version brings it back.
import { FOREVER, NO_WAIT } from "phi-spaces";
import { fieldsOf, type SceneryFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, NotUnderstood, type CommandCtx } from "../context.ts";
import { distTo, freeCells, giveBack, rested, SITE_REACH, tire } from "./build.ts";
import { needRank } from "./settlement.ts";

const nearby = async (c: CommandCtx, arg: string): Promise<SceneryFields> => {
	const at = /^(\d+)\s+(\d+)$/.exec(arg.trim());
	const here = (await c.space.readAll({ type: "Scenery", fields: { room: c.actor.room } })).map((e) => fieldsOf<SceneryFields>(e)).filter((s) => !s.through && distTo(c.actor, s) <= SITE_REACH);
	const hit = at ? here.find((s) => distTo({ x: Number(at[1]), y: Number(at[2]) }, s) === 0) : here.find((s) => !s.fixed) ?? here[0];
	if (!hit) throw new NotUnderstood("Hier steht nichts zum Abräumen. Stell dich neben eine alte Hütte, ein Boot, ein Netzgestell oder Fässer.");
	return hit;
};

const raeume: Command = {
	key: "räume", aliases: ["raeume", "räumen", "raeumen", "clear"],
	help: "räume [x y] – was neben dir (bis zwei Schritte) im Weg steht abräumen, eine alte Hütte, ein Boot: Arbeit für Arbeit, dann ist das Land frei und das Holz deins",
	async func(c, arg) {
		await needRank(c, "helfer", "Abräumen");
		const { now, rest } = await rested(c);
		const s = await nearby(c, arg);
		if (s.fixed) throw new CommandError(`${s.name} gehört fest hierher und bleibt stehen.`);
		const e = await c.space.takeIfExists({ type: "Scenery", fields: { sceneryId: s.sceneryId } }, NO_WAIT, { txn: c.txn });
		if (!e) throw new CommandError(`Daran arbeitet gerade jemand; gleich noch einmal.`);
		await tire(c, now, rest);
		const left = s.left - 1;
		if (left > 0) {
			await c.space.write({ type: "Scenery", fields: { ...s, left } as never }, c.txn, FOREVER);
			await msg(c, "*", "emote", `${c.actor.name} räumt auf: ${s.name}, noch ${left} Mal anpacken.`);
			return;
		}
		await freeCells(c.space, c.txn, s.room, s.sceneryId);
		await c.space.write({ type: "SceneryGone", fields: { sceneryId: s.sceneryId } }, c.txn, FOREVER);
		const got = await giveBack(c, s.yields);
		await msg(c, "*", "info", `${c.actor.name} hat ${s.name} abgeräumt; das Land ist frei.${got.length ? ` Für ${c.actor.name}: ${got.join(", ")}.` : ""}`);
	},
};

export const SCENERY_COMMANDS: Command[] = [raeume];
