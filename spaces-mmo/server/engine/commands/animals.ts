// Animals on the farm (docs/siedeln.md "Tiere auf dem Hof", step 3 part 3): hens in a coop, sheep and goats in a pen.
//
// - An animal is a thing (bought from Gesa, carried, traded); `einstallen` puts it into its owner's coop or pen, where it
//   lies like a chest's content (location: the buildId). Demolition gives it back, a ruin keeps it for the owner's
//   estate (build.ts), without code of its own.
// - The house carries its herd (BuildingFields.herd): the kind, how long it is fed, and the yields and young counted
//   on lazily, like the rain barrel's water: whenever a command takes the house, herdNow brings it up to now. No tick
//   writes for animals.
// - Fed animals give their yield (an egg a day, wool every other day, milk a day), up to a few per animal waiting; hungry
//   ones give nothing until fed again, and lose nothing. Two fed ones of a kind now and then get a young one, until the
//   house is full. Anyone may feed (`füttere`), only the owner puts in, takes out and collects.
import { FOREVER, NO_WAIT } from "phi-spaces";
import { fieldsOf, type BuildingFields, type HerdFields, type ItemFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, NotUnderstood, type CommandCtx } from "../context.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import type { AnimalKindDef, AnimalsDef } from "../world.ts";
import { ARTICLE, giveBack, planOf, putBack, takeNear } from "./build.ts";
import { protoName } from "./garden.ts";

const hours = (ms: number) => { const h = Math.round(ms / 3600_000); return h >= 1 ? `${h} ${h === 1 ? "Stunde" : "Stunden"}` : `${Math.max(1, Math.round(ms / 60_000))} Minuten`; };
const few = (k: AnimalKindDef, n: number) => `${n} ${n === 1 ? k.name : k.plural}`;
function animalsOf(c: CommandCtx): AnimalsDef {
	if (!c.world.animals) throw new CommandError("In dieser Welt hält niemand Tiere.");
	return c.world.animals;
}
const houseNames = (c: CommandCtx, d: AnimalsDef) => Object.keys(d.houses).map((p) => planOf(c.world, p)?.name ?? p).join(" oder ");
// "der Stall" for every house (coop or pen), so the sentences need no article per plan

/** The herd brought up to `now`: what the fed time since `atWorldMs` gave, and the young born (at most up to `max`). */
export function herdNow(k: AnimalKindDef, d: AnimalsDef, h: HerdFields, n: number, max: number, now: number): HerdFields & { born: number } {
	const dt = Math.max(0, Math.min(now, h.fedUntilWorldMs) - h.atWorldMs);
	const goods = Math.min(n * d.nestMax, h.goods + (dt * n) / k.everyWorldMs);
	let bred = n >= 2 && n < max ? h.bred + dt / k.breedWorldMs : 0;
	const born = Math.max(0, Math.min(Math.floor(bred), max - n));
	bred -= born;
	if (n + born >= max) bred = 0;
	return { ...h, goods, bred, atWorldMs: Math.max(h.atWorldMs, now), born };
}

type House = { b: BuildingFields; k: AnimalKindDef | undefined; n: number; max: number; now: number };
/** The coop or pen beside the actor, taken in the transaction (one another command holds is waited for through its
 *  cells) and its herd brought up to now; young born meanwhile are put in it. */
async function houseHere(c: CommandCtx, d: AnimalsDef): Promise<House> {
	const r = await takeNear<BuildingFields>(c, "Building", "buildId", 1, (b) => !!d.houses[b.plan]);
	if (!("f" in r)) throw new NotUnderstood(`Geh direkt neben einen Stall (${houseNames(c, d)}).`);
	const b = r.f, now = await worldNowOf(c.space, c.txn), max = d.houses[b.plan]!;
	const inside = (await c.space.readAll({ type: "Item", fields: { location: b.buildId } })).map((e) => fieldsOf<ItemFields>(e));
	const k = d.kinds.find((x) => x.key === b.herd?.kind) ?? d.kinds.find((x) => inside.some((i) => i.proto === x.proto));
	const n = k ? inside.filter((i) => i.proto === k.proto).length : 0;
	if (!k || !b.herd) return { b, k, n, max, now };
	const h = herdNow(k, d, b.herd, n, max, now);
	if (h.born) {
		const p = await resolvePrototype(c.space, k.proto);
		if (p) for (let i = 0; i < h.born; i++) await spawn(c.space, c.txn, c.world, p, { location: b.buildId, x: -1, y: -1 });
	}
	const { born, ...herd } = h;
	if (born) await msg(c, "*", "emote", `Im Stall von ${b.ownerName} ${born === 1 ? `ist ein junges ${k.name}` : `sind ${born} junge ${k.plural}`} dazugekommen.`);
	return { b: { ...b, herd }, k, n: n + born, max, now };
}
const mine = (c: CommandCtx, b: BuildingFields) => b.accountId === c.account?.accountId;
const fedText = (h: HerdFields | undefined, now: number) => !h || h.fedUntilWorldMs <= now ? "hungrig („füttere“)" : `satt noch ${hours(h.fedUntilWorldMs - now)}`;

const stall: Command = {
	key: "stall", aliases: ["ställe", "staelle", "gehege", "coop", "pen"],
	help: "stall – die Tiere im Hühnerstall oder Gehege neben dir: wie viele, ob sie satt sind, was bereitliegt",
	async func(c) {
		const d = animalsOf(c);
		const { b, k, n, max, now } = await houseHere(c, d);
		await putBack(c, b);
		if (!k || !n) return msg(c, c.actor.charId, "info", `${b.name} von ${b.ownerName}: leer (Platz für ${max}). ${mine(c, b) ? "„einstallen <tier>“ bringt ein Tier hinein; Tiere verkauft Gesa am Markt von Kupferhafen." : ""}`.trim());
		const ready = Math.floor(b.herd?.goods ?? 0);
		await msg(c, c.actor.charId, "info", `${b.name} von ${b.ownerName}: ${few(k, n)} (Platz für ${max}), ${fedText(b.herd, now)}. ${ready ? `Bereit: ${ready} ${protoName(c, k.yields)} („einsammeln“).` : `Noch kein ${protoName(c, k.yields)} bereit.`} Sie fressen ${k.feed.map((p) => protoName(c, p)).join(", ")}.`);
	},
};

const einstallen: Command = {
	key: "einstallen", aliases: ["stalle", "einstellen"],
	help: "einstallen <tier> – ein Tier, das du trägst, in deinen Hühnerstall oder dein Gehege neben dir bringen",
	async func(c, arg) {
		const d = animalsOf(c);
		const carried = (await inventory(c)).filter((i) => d.kinds.some((k) => k.proto === i.f.proto));
		const hits = arg.trim() ? itemsNamed(c.world, carried, arg.replace(ARTICLE, "")) : carried;
		if (!hits.length) throw new NotUnderstood(carried.length ? `Du trägst kein Tier, das „${arg.slice(0, 30)}“ heißt.` : "Du trägst kein Tier. Hühner, Schafe und Ziegen verkauft Gesa am Markt von Kupferhafen.");
		const it = hits[0]!.f, k = d.kinds.find((x) => x.proto === it.proto)!;
		const { b, k: has, n, max, now } = await houseHere(c, d);
		if (!mine(c, b)) throw new CommandError(`Der Stall gehört ${b.ownerName}; einstallen darf nur der Besitzer.`);
		if (b.plan !== k.plan) throw new CommandError(`${k.plural} wohnen im ${planOf(c.world, k.plan)?.name ?? k.plan}, nicht im ${b.name}.`);
		if (has && n && has.key !== k.key) throw new CommandError(`Hier stehen schon ${has.plural}; eine Art je Stall.`);
		if (n >= max) throw new CommandError(`Der Stall ist voll (${max}).`);
		const e = await c.space.takeIfExists({ type: "Item", fields: { itemId: it.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn });
		if (!e) throw new CommandError(`${it.name} ist gerade nicht greifbar; bitte noch einmal.`);
		await c.space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, location: b.buildId, x: -1, y: -1 } as never }, c.txn, FOREVER);
		const herd: HerdFields = b.herd && n ? { ...b.herd, kind: k.key } : { kind: k.key, fedUntilWorldMs: now, atWorldMs: now, goods: 0, bred: 0 };
		await putBack(c, { ...b, herd });
		await msg(c, "*", "emote", `${c.actor.name} bringt ein ${k.name} in den Stall (${few(k, n + 1)}).`);
		if (herd.fedUntilWorldMs <= now) await msg(c, c.actor.charId, "info", `Sie sind hungrig: „füttere“ mit ${k.feed.map((p) => protoName(c, p)).join(", ")}.`);
	},
};

const ausstallen: Command = {
	key: "ausstallen", aliases: ["ausstellen"],
	help: "ausstallen [tier] – ein Tier aus deinem Hühnerstall oder Gehege neben dir nehmen",
	async func(c) {
		const d = animalsOf(c);
		const { b, k, n } = await houseHere(c, d);
		if (!mine(c, b)) throw new CommandError(`Der Stall gehört ${b.ownerName}.`);
		if (!k || !n) throw new CommandError("Im Stall ist kein Tier.");
		const one = (await c.space.readAll({ type: "Item", fields: { location: b.buildId, proto: k.proto } }))[0];
		const e = one && (await c.space.takeIfExists({ id: one.id }, NO_WAIT, { txn: c.txn }));
		if (!e) throw new CommandError("Das Tier ist gerade nicht greifbar; bitte noch einmal.");
		await c.space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, location: c.actor.charId, x: -1, y: -1 } as never }, c.txn, FOREVER);
		// the last one out: the house is empty again (the map shows no animals, another kind may come in)
		if (n === 1) { const { herd: _, ...empty } = b; await putBack(c, empty); }
		else await putBack(c, b);
		await msg(c, "*", "emote", `${c.actor.name} nimmt ein ${k.name} aus dem Stall.`);
	},
};

const fuettere: Command = {
	key: "füttere", aliases: ["fuettere", "füttern", "fuettern", "futter"],
	help: "füttere [n] [futter] – die Tiere im Stall oder Gehege neben dir füttern (jeder darf; ein Futter macht ein Tier einen Tag satt)",
	async func(c, arg) {
		const d = animalsOf(c);
		const m = /^(?:(\d+|alle?)\s+)?(.*)$/i.exec(arg.trim().replace(/^(?:die|den)\s+(?:tiere|hühner|huehner|schafe|ziegen)(?:\s+mit)?\s*/i, "").replace(/^mit\s+/i, ""))!;
		const { b, k, n, now } = await houseHere(c, d);
		if (!k || !n || !b.herd) throw new CommandError("Im Stall ist kein Tier zu füttern.");
		const feed = (await inventory(c)).filter((i) => k.feed.includes(i.f.proto));
		const named = m[2] ? itemsNamed(c.world, await inventory(c), m[2].replace(ARTICLE, "")) : feed;
		if (m[2] && named.length && !k.feed.includes(named[0]!.f.proto)) throw new CommandError(`${named[0]!.f.name} mögen ${k.plural} nicht; sie fressen ${k.feed.map((p) => protoName(c, p)).join(", ")}.`);
		const offer = m[2] ? named.filter((i) => i.f.proto === named[0]!.f.proto) : feed;
		if (!offer.length) throw new CommandError(`Du hast kein Futter. ${k.plural} fressen ${k.feed.map((p) => protoName(c, p)).join(", ")}.`);
		const per = d.feedWorldMs / n, from = Math.max(now, b.herd.fedUntilWorldMs);
		const room = now + d.fedMaxWorldMs - from;
		if (room < per) throw new CommandError(`Die ${k.plural} sind satt (noch ${hours(from - now)}).`);
		const want = Math.min(Math.floor(room / per), offer.length, m[1] && /^\d+$/.test(m[1]) ? Number(m[1]) : Infinity);
		const used = new Map<string, number>();
		for (const it of offer.slice(0, want)) {
			if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) continue;
			used.set(it.f.name, (used.get(it.f.name) ?? 0) + 1);
		}
		const count = [...used.values()].reduce((a, x) => a + x, 0);
		if (!count) throw new CommandError("Das Futter ist gerade nicht greifbar; bitte noch einmal.");
		const until = from + count * per;
		await putBack(c, { ...b, herd: { ...b.herd, fedUntilWorldMs: until } });
		await msg(c, "*", "emote", `${c.actor.name} füttert die ${k.plural} von ${b.ownerName} mit ${[...used].map(([nm, x]) => `${x} ${nm}`).join(" und ")}; satt für etwa ${hours(until - now)}.`);
	},
};

/** Collects what the herd beside the actor gave (the owner only); also reached from "sammle eier" (garden.ts). */
export async function collect(c: CommandCtx): Promise<void> {
	const d = animalsOf(c);
	const { b, k, n, now } = await houseHere(c, d);
	if (!mine(c, b)) throw new CommandError(`Was die Tiere von ${b.ownerName} geben, sammelt ${b.ownerName}.`);
	if (!k || !n || !b.herd) throw new CommandError("Im Stall ist kein Tier.");
	const whole = Math.floor(b.herd.goods);
	if (!whole) {
		const next = b.herd.fedUntilWorldMs <= now ? "sie sind hungrig („füttere“)" : `das nächste in etwa ${hours(((1 - (b.herd.goods % 1)) * k.everyWorldMs) / n)}`;
		throw new CommandError(`Noch kein ${protoName(c, k.yields)} bereit; ${next}.`);
	}
	await putBack(c, { ...b, herd: { ...b.herd, goods: b.herd.goods - whole } });
	const got = await giveBack(c, [{ proto: k.yields, count: whole }]);
	await msg(c, c.actor.charId, "info", `Du sammelst ${got.join(", ")} im Stall.`);
}

const einsammeln: Command = {
	key: "einsammeln", aliases: ["melke", "melken", "schere", "scheren", "eier"],
	help: "einsammeln – Eier, Wolle oder Milch deiner Tiere im Stall oder Gehege neben dir (auch: sammle eier, melke, schere)",
	async func(c) { await collect(c); },
};

/** Whether "sammle <arg>" means a yield of the animals ("sammle eier", "die wolle"). */
export const meansYield = (c: CommandCtx, arg: string) => {
	const n = arg.trim().toLowerCase().replace(ARTICLE, "");
	return !!n && (c.world.animals?.kinds ?? []).some((k) => { const p = c.world.prototypes.find((x) => x.key === k.yields); return !!p && [p.key, p.name, ...p.aliases].some((a) => a.toLowerCase() === n); });
};

export const ANIMAL_COMMANDS: Command[] = [stall, einstallen, ausstallen, fuettere, einsammeln];
