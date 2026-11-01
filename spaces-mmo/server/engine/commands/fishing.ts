// Fishing, step 7 (docs/siedeln.en.md "Boats and fishing"): beside a jetty, anyone's, `wirf netz` brings a catch, now and then a
// find, and costs the rest that work costs; the net holds. A smokehouse turns fish into smoked fish by a recipe.
import { randomInt } from "node:crypto";
import { fieldsOf, type BuildingFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { handOff } from "../handover.ts";
import { regionOfRoom } from "../regions.ts";
import { distTo, giveBack, planOf, rested, tire } from "./build.ts";
import { worldNowOf } from "../clock.ts";
import { consume } from "./trade.ts";
import { dropOffers, placeIn, relocate } from "./default.ts";

const weighted = (xs: Array<{ proto: string; weight: number }>) => { let r = randomInt(0, xs.reduce((n, x) => n + x.weight, 0)); return xs.find((x) => (r -= x.weight) < 0)!; };

const wirf: Command = {
	key: "wirf", aliases: ["fische", "fish"],
	help: "wirf netz – an einem Steg neben dir das Netz auswerfen: Fisch, manchmal ein Fund; danach ruhst du eine Weile",
	async func(c, arg) {
		const d = c.world.fishing;
		if (!d) throw new CommandError("In dieser Welt wird nicht gefischt.");
		if (arg.trim() && !/^(?:(?:das\s+)?netz|net)$/i.test(arg.trim())) throw new NotUnderstood("So geht es: wirf netz");
		const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan: d.plan } })).some((e) => distTo(c.actor, fieldsOf<BuildingFields>(e)) <= 1);
		if (!near) throw new CommandError(`Das Netz wirft man direkt neben ${planOf(c.world, d.plan)?.dative ?? "einem Steg"} aus.`);
		if (!(await inventory(c)).some((i) => i.f.proto === d.net)) throw new CommandError("Dafür brauchst du ein Netz.");
		const { now, rest } = await rested(c);
		const got = weighted(d.catch);
		await giveBack(c, [{ proto: got.proto, count: 1 }]);
		await tire(c, now, rest);
		await msg(c, "*", "info", `$you() $conj(ziehst|zieht) ${c.world.prototypes.find((p) => p.key === got.proto)?.name ?? got.proto} aus dem Wasser.`, { templ: true });
	},
};

const rudere: Command = {
	key: "rudere", aliases: ["rudern", "row"],
	help: "rudere <ort> – mit einem Ruderboot vom Steg neben dir zu einem Steg dieser Insel; „rudere“ allein zeigt, wohin",
	async func(c, arg) {
		const d = c.world.boat, plan = c.world.fishing?.plan;
		if (!d || !plan) throw new CommandError("In dieser Welt gibt es keine Boote.");
		if (!(await inventory(c)).some((i) => i.f.proto === d.proto)) throw new CommandError("Dafür brauchst du ein Ruderboot.");
		const island = c.world.rooms.find((r) => r.roomId === c.actor.room)?.island;
		const jetties = (await c.space.readAll({ type: "Building", fields: { plan } })).map((e) => fieldsOf<BuildingFields>(e));
		if (!jetties.some((b) => b.room === c.actor.room && distTo(c.actor, b) <= 1)) throw new CommandError(`Abgelegt wird direkt neben ${planOf(c.world, plan)?.dative ?? "einem Steg"}.`);
		const there = c.world.rooms.filter((r) => r.island === island && r.roomId !== c.actor.room && jetties.some((b) => b.room === r.roomId));
		const word = arg.trim().toLowerCase();
		if (!word) return msg(c, c.actor.charId, "info", there.length ? `Stege gibt es in: ${there.map((r) => r.name).join(", ")}.` : "Auf dieser Insel gibt es keinen anderen Steg.");
		const to = there.find((r) => r.name.toLowerCase() === word || r.roomId === word);
		if (!to) throw new NotUnderstood(`Dorthin führt kein Steg.${there.length ? ` Stege gibt es in: ${there.map((r) => r.name).join(", ")}.` : ""}`);
		const jetty = jetties.find((b) => b.room === to.roomId)!, dest = await roomOf(c, to.roomId), at = await placeIn(c, dest, { x: jetty.x, y: jetty.y + 1 });
		await msg(c, "*", "info", `$you() $conj(ruderst|rudert) nach ${to.name}.`, { templ: true });
		await relocate(c, { room: dest.roomId, x: at.x, y: at.y }, { spot: false });
		await msg(c, "*", "info", `$you() $conj(legst|legt) am Steg an.`, { templ: true, room: dest.roomId });
	},
};

const schaufle: Command = {
	key: "schaufle", aliases: ["schaufeln", "dig sand"],
	help: "schaufle – am Strand mit dem Spaten Sand graben (danach ruhst du eine Weile)",
	async func(c) {
		const d = c.world.sand;
		if (!d) throw new CommandError("In dieser Welt gibt es keinen Sand.");
		const room = await roomOf(c);
		if (room.ground[c.actor.y]?.[c.actor.x] !== d.tile) throw new CommandError("Sand gräbt man am Strand.");
		if (!(await inventory(c)).some((i) => i.f.proto === d.tool)) throw new CommandError("Dafür brauchst du einen Spaten.");
		const { now, rest } = await rested(c);
		await giveBack(c, [{ proto: d.makes, count: d.count }]);
		await tire(c, now, rest);
		await msg(c, "*", "info", `$you() $conj(gräbst|gräbt) ${d.count} Sand aus dem Strand.`, { templ: true });
	},
};

const segle: Command = {
	key: "segle", aliases: ["segeln", "sail"],
	help: "segle <insel> – mit einem Segelboot vom Steg neben dir zu einer anderen Insel; „segle“ allein zeigt, wohin",
	async func(c, arg) {
		const d = c.world.boat, plan = c.world.fishing?.plan;
		if (!d?.sail || !plan) throw new CommandError("In dieser Welt gibt es keine Segelboote.");
		if (!(await inventory(c)).some((i) => i.f.proto === d.sail)) throw new CommandError("Dafür brauchst du ein Segelboot.");
		const here = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan } })).some((e) => distTo(c.actor, fieldsOf<BuildingFields>(e)) <= 1);
		if (!here) throw new CommandError(`Abgelegt wird direkt neben ${planOf(c.world, plan)?.dative ?? "einem Steg"}.`);
		const rooms = c.world.allRooms ?? c.world.rooms, mine = rooms.find((r) => r.roomId === c.actor.room)?.island;
		const islands = [...new Set(rooms.flatMap((r) => (r.island && r.island !== mine ? [r.island] : [])))];
		const word = arg.trim().toLowerCase(), to = islands.find((i) => i.toLowerCase() === word);
		if (!to) { if (word) throw new NotUnderstood(`Eine Insel „${arg.trim().slice(0, 30)}“ kennt niemand. Es gibt: ${islands.join(", ")}.`); return msg(c, c.actor.charId, "info", `Du kannst segeln nach: ${islands.join(", ")}.`); }
		// the first room of the island that has a spawn: a bay; the world's bays are written first
		const bay = rooms.find((r) => r.island === to && r.spawn)!, at = bay.spawn!;
		await msg(c, "*", "info", `$you() $conj(setzt|setzt) Segel nach ${to}.`, { templ: true });
		await tire(c, ...(await restOf(c)));
		const toRegion = c.world.region && !c.world.rooms.some((r) => r.roomId === bay.roomId) ? regionOfRoom({ ...c.world, rooms }, bay.roomId) : null;
		if (toRegion) { await dropOffers(c); return handOff(c, c.world.region!, toRegion, { room: bay.roomId, ...at }); }
		const dest = await roomOf(c, bay.roomId), cell = await placeIn(c, dest, at);
		await relocate(c, { room: dest.roomId, x: cell.x, y: cell.y }, { spot: false });
		await msg(c, "*", "info", `$you() $conj(legst|legt) in ${to} an.`, { templ: true, room: dest.roomId });
	},
};
const restOf = async (c: CommandCtx) => { const { now, rest } = await rested(c); return [now, rest] as const; };

/** When the line's ship lies in a bay: the first half of every period. The time to it, 0 while it lies there. */
export const shipIn = (now: number, everyWorldMs: number) => { const at = now % everyWorldMs; return at < everyWorldMs / 2 ? 0 : everyWorldMs - at; };
const bays = (c: CommandCtx) => { const rooms = c.world.allRooms ?? c.world.rooms, seen = new Map<string, (typeof rooms)[number]>(); for (const r of rooms) if (r.island && r.spawn && !seen.has(r.island)) seen.set(r.island, r); return seen; };

const fahrplan: Command = {
	key: "fahrplan", aliases: ["timetable", "schiff"],
	help: "fahrplan – wann das große Schiff in dieser Bucht liegt und wohin es fährt; „einschiffen <insel>“ fährt mit",
	async func(c) {
		const d = c.world.liner;
		if (!d) throw new CommandError("In dieser Welt gibt es keinen Fahrplan.");
		const wait = shipIn(await worldNowOf(c.space, c.txn), d.everyWorldMs), all = [...bays(c).keys()].join(", ");
		await msg(c, c.actor.charId, "info", `${wait ? `Das Schiff kommt in etwa ${Math.ceil(wait / 60_000)} Weltminuten.` : "Das Schiff liegt in den Buchten."} Es fährt nach ${all}, für ${d.fare} Münzen; die Fähren fahren jederzeit.`);
	},
};

const einschiffen: Command = {
	key: "einschiffen", aliases: ["board"],
	help: "einschiffen <insel> – in der Bucht auf das große Schiff gehen, wenn es da liegt (fahrplan)",
	async func(c, arg) {
		const d = c.world.liner;
		if (!d) throw new CommandError("In dieser Welt gibt es keinen Fahrplan.");
		const all = bays(c), here = [...all.values()].some((r) => r.roomId === c.actor.room), word = arg.trim().toLowerCase();
		if (!here) throw new CommandError("Das Schiff legt nur in den Buchten an.");
		const wait = shipIn(await worldNowOf(c.space, c.txn), d.everyWorldMs);
		if (wait) throw new CommandError(`Das Schiff kommt erst in etwa ${Math.ceil(wait / 60_000)} Weltminuten.`);
		const to = [...all.entries()].find(([island, r]) => island.toLowerCase() === word && r.roomId !== c.actor.room);
		if (!to) throw new NotUnderstood(`Das Schiff fährt nach: ${[...all.keys()].join(", ")}.`);
		const purse = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		if (purse.length < d.fare) throw new CommandError(`Die Fahrt kostet ${d.fare} Münzen.`);
		for (const m of purse.slice(0, d.fare)) await consume(c, m.f, c.actor.charId);
		const [island, bay] = to, at = bay.spawn!;
		await msg(c, "*", "info", `$you() $conj(gehst|geht) an Bord, nach ${island}.`, { templ: true });
		const toRegion = c.world.region && !c.world.rooms.some((r) => r.roomId === bay.roomId) ? regionOfRoom({ ...c.world, rooms: c.world.allRooms ?? c.world.rooms }, bay.roomId) : null;
		if (toRegion) { await dropOffers(c); return handOff(c, c.world.region!, toRegion, { room: bay.roomId, ...at }); }
		const dest = await roomOf(c, bay.roomId), cell = await placeIn(c, dest, at);
		await relocate(c, { room: dest.roomId, x: cell.x, y: cell.y }, { spot: false });
		await msg(c, "*", "info", `$you() $conj(kommst|kommt) in ${island} an.`, { templ: true, room: dest.roomId });
	},
};

export const FISHING_COMMANDS: Command[] = [wirf, rudere, segle, fahrplan, einschiffen, schaufle];
