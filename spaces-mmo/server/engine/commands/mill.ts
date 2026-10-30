// The windmill (docs/siedeln.md "Warenketten", step 3 part 2): grain brought to a mill becomes flour in the mill's
// own time, for whoever brought it.
//
// - Anyone may grind at any mill. `mahle` takes the mill's Building in the command's transaction, so loads brought at
//   once queue one after the other: a load starts when the one before is ground (`busyUntilWorldMs`) and is ready
//   `unitWorldMs` per unit later.
// - Each load is its own entry (MillLoad), with the time it is ready fixed when it is brought; nothing writes while the
//   mill grinds. `abholen` takes one's own loads that are ready, never the mill, so fetching never waits on grinding.
// - A storm surge on the mill's island grinds ahead (the only write of a tick). A mill that falls (demolished or a ruin)
//   gives the grain of loads not yet ground back to who brought it (build.ts stopLoads); a load is found at the
//   mill's place, standing or not.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type MillLoadFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, NotUnderstood, type CommandCtx } from "../context.ts";
import type { MillDef, WorldDef } from "../world.ts";
import { ARTICLE, buildingHere, distTo, giveBack, plural, planOf, putBack, SITE_REACH } from "./build.ts";
import { protoName } from "./garden.ts";
import { craft } from "./trade.ts";

const hours = (ms: number) => { const h = Math.round(ms / 3600_000); return h >= 1 ? `${h} ${h === 1 ? "Stunde" : "Stunden"}` : `${Math.max(1, Math.round(ms / 60_000))} Minuten`; };
function millOf(c: CommandCtx): MillDef {
	if (!c.world.mill) throw new CommandError("In dieser Welt mahlt keine Mühle.");
	return c.world.mill;
}
const millName = (c: CommandCtx, m: MillDef) => planOf(c.world, m.plan)?.name ?? m.plan;
/** The mill beside the actor, taken in the transaction. */
async function millHere(c: CommandCtx, m: MillDef): Promise<BuildingFields> {
	const name = millName(c, m);
	const b = await buildingHere(c, name, { own: false }).catch((e) => { throw e instanceof NotUnderstood ? new NotUnderstood(`Geh direkt neben eine ${name}.`) : e; });
	if (b.plan !== m.plan) throw new NotUnderstood(`Geh direkt neben eine ${name}.`);
	return b;
}
const grainNames = (c: CommandCtx, m: MillDef) => m.grinds.map((g) => protoName(c, g.from)).join(", ");

const mahle: Command = {
	key: "mahle", aliases: ["mahlen", "grind", "mühle", "muehle", "windmühle", "windmuehle", "mill"],
	help: "mahle [n|alle] <korn> – an einer Windmühle neben dir Korn zu Mehl mahlen lassen (mahle allein: wie lange sie zu tun hat)",
	async func(c, arg) {
		const m = millOf(c);
		const now = await worldNowOf(c.space, c.txn);
		const a = /^(?:(\d+|alle?|all)\s+)?(.*)$/i.exec(arg.trim().replace(/^(?:mein|meine|meinen|das|den|die)\s+/i, ""))!;
		if (!a[2]) {
			const b = await millHere(c, m);
			await putBack(c, b);
			const mine = (await c.space.readAll({ type: "MillLoad", fields: { buildId: b.buildId, charId: c.actor.charId } })).map((e) => fieldsOf<MillLoadFields>(e));
			const busy = Math.max(0, (b.busyUntilWorldMs ?? 0) - now);
			const lines = [busy ? `Die ${b.name} hat noch ${hours(busy)} zu mahlen.` : `Die ${b.name} steht still; sie mahlt, was man ihr bringt (${grainNames(c, m)}), ${hours(m.unitWorldMs)} je Handvoll.`,
				...mine.map((l) => l.readyWorldMs <= now ? `Fertig für dich: ${l.count} ${protoName(c, l.to)} („abholen“).` : `Dein ${protoName(c, l.from)} (${l.count}): fertig in etwa ${hours(l.readyWorldMs - now)}.`)];
			return msg(c, c.actor.charId, "info", lines.join("\n"));
		}
		const hits = itemsNamed(c.world, await inventory(c), a[2].replace(ARTICLE, ""));
		if (!hits.length) throw new NotUnderstood(`Du trägst nichts, was „${a[2].slice(0, 30)}“ heißt.`);
		const grind = m.grinds.find((g) => g.from === hits[0]!.f.proto);
		if (!grind) throw new CommandError(`Die Mühle mahlt nur Korn: ${grainNames(c, m)}.`);
		const b = await millHere(c, m);
		const waiting = await c.space.count({ type: "MillLoad", fields: { buildId: b.buildId, charId: c.actor.charId } });
		if (waiting >= m.maxLoads) throw new CommandError(`Bei der ${b.name} liegen schon ${waiting} Säcke von dir; hol erst dein Mehl ab („abholen“).`);
		const have = (await inventory(c)).filter((i) => i.f.proto === grind.from);
		const n = Math.min(a[1] && /^\d+$/.test(a[1]) ? Number(a[1]) : have.length, have.length, m.maxLoad);
		if (n <= 0) throw new CommandError(`Du hast kein ${protoName(c, grind.from)}.`);
		for (const it of have.slice(0, n)) if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${it.f.name} ist gerade nicht greifbar; bitte noch einmal.`);
		const ready = Math.max(now, b.busyUntilWorldMs ?? 0) + n * m.unitWorldMs;
		await putBack(c, { ...b, busyUntilWorldMs: ready });
		const load: MillLoadFields = { loadId: randomBytes(6).toString("hex"), buildId: b.buildId, room: b.room, x: b.x, y: b.y, w: b.w, h: b.h, charId: c.actor.charId, name: c.actor.name,
			from: grind.from, to: grind.to, count: n, readyWorldMs: ready, untilWorldMs: ready + m.keepWorldMs };
		await c.space.write({ type: "MillLoad", fields: load as never }, c.txn, FOREVER);
		const more = a[1] && /^\d+$/.test(a[1]) && Number(a[1]) > n && n === m.maxLoad ? ` Mehr als ${m.maxLoad} nimmt sie auf einmal nicht.` : "";
		await msg(c, "*", "emote", `${c.actor.name} schüttet ${plural(n, `Handvoll ${protoName(c, grind.from)}`, `Handvoll ${protoName(c, grind.from)}`)} in die ${b.name}.`);
		await msg(c, c.actor.charId, "info", `Dein ${protoName(c, grind.to)} ist in etwa ${hours(ready - now)} fertig; hol es dann hier ab („abholen“).${more}`);
	},
};

const abholen: Command = {
	key: "abholen", aliases: ["abhol", "hol-ab", "pickup"],
	help: "abholen – dein gemahlenes Mehl an der Mühle neben dir (bis zwei Schritte) abholen",
	async func(c) {
		const m = millOf(c);
		const now = await worldNowOf(c.space, c.txn);
		const mine = (await c.space.readAll({ type: "MillLoad", fields: { room: c.actor.room, charId: c.actor.charId } })).map((e) => fieldsOf<MillLoadFields>(e));
		const near = mine.filter((l) => distTo(c.actor, l) <= SITE_REACH);
		if (!near.length) throw new CommandError(mine.length ? `Geh näher an die ${planOf(c.world, m.plan)?.name ?? "Mühle"}.` : "Hier wartet kein Mehl auf dich.");
		const ready = near.filter((l) => l.readyWorldMs <= now);
		if (!ready.length) throw new CommandError(`Dein Korn ist noch nicht gemahlen; in etwa ${hours(Math.min(...near.map((l) => l.readyWorldMs)) - now)}.`);
		const got = new Map<string, number>();
		for (const l of ready) {
			if (!(await c.space.takeIfExists({ type: "MillLoad", fields: { loadId: l.loadId } }, NO_WAIT, { txn: c.txn }))) continue;
			await giveBack(c, [{ proto: l.to, count: l.count }]);
			got.set(l.to, (got.get(l.to) ?? 0) + l.count);
		}
		if (!got.size) throw new CommandError("Das ist gerade nicht greifbar; bitte noch einmal.");
		const left = near.length - ready.length;
		await msg(c, c.actor.charId, "info", `Du holst ${[...got].map(([p, n]) => `${n} ${protoName(c, p)}`).join(" und ")} ab.${left ? ` ${left} ${left === 1 ? "Sack mahlt" : "Säcke mahlen"} noch.` : ""}`);
	},
};

// the oven of a bakery: its recipes are made with craft beside it; "backe" names them as one says it
const backe: Command = {
	key: "backe", aliases: ["backen", "bake"],
	help: "backe [brot] – am Backhaus neben dir backen (ein Rezept am Bau, „craft“ zeigt, was es braucht)",
	async func(c, arg) {
		const ovens = c.world.recipes.filter((r) => r.at);
		const n = arg.trim().toLowerCase().replace(ARTICLE, "");
		const r = n ? ovens.find((x) => x.key === n || x.name.toLowerCase() === n || c.world.prototypes.find((p) => p.key === x.makes)?.aliases.includes(n)) : ovens[0];
		if (!r) throw new NotUnderstood(ovens.length ? `Backen kann man hier: ${ovens.map((x) => x.name).join(", ")}.` : "In dieser Welt bäckt niemand.");
		return craft.func(c, r.key);
	},
};

export const MILL_COMMANDS: Command[] = [mahle, abholen, backe];

/** A storm surge grinds the mills of its island ahead (engine/fire.ts stormTick names the room): the loads still waiting
 *  and the mill's queue move forward by `stormWorldMs`, never before now. */
export async function stormTurnsMills(space: SpaceLike, w: WorldDef, roomId: string | null): Promise<void> {
	const m = w.mill;
	if (!m || !roomId) return;
	const island = w.rooms.find((r) => r.roomId === roomId)?.island;
	const rooms = new Set(w.rooms.filter((r) => r.island === island).map((r) => r.roomId));
	const now = await worldNowOf(space);
	for (const e of await space.readAll({ type: "Building", fields: { plan: m.plan } })) {
		const b = fieldsOf<BuildingFields>(e);
		if (!rooms.has(b.room) || (b.busyUntilWorldMs ?? 0) <= now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Building", fields: { buildId: b.buildId } }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			const mill = fieldsOf<BuildingFields>(t);
			await space.write({ type: "Building", fields: { ...mill, busyUntilWorldMs: Math.max(now, (mill.busyUntilWorldMs ?? 0) - m.stormWorldMs) } as never }, txn, FOREVER);
			for (const le of await space.readAll({ type: "MillLoad", fields: { buildId: b.buildId } })) {
				const l = fieldsOf<MillLoadFields>(le);
				if (l.readyWorldMs <= now || !(await space.takeIfExists({ type: "MillLoad", fields: { loadId: l.loadId } }, NO_WAIT, { txn }))) continue;
				await space.write({ type: "MillLoad", fields: { ...l, readyWorldMs: Math.max(now, l.readyWorldMs - m.stormWorldMs) } as never }, txn, FOREVER);
			}
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
}
