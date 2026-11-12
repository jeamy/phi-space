// Trees (docs/siedeln.en.md "Bäume"): a player plants a tree's seed with a spade in the light of a fire, the tree grows
// over days, and then it stands until it is felled. Felled with an axe it gives logs (a log stands for driftwood: every
// recipe, site and fire takes it as such, PrototypeFields.stands); a birch and a willow sprout again from the stump. A
// fruit tree bears every day or so (apples, pears, acorns), a willow is cut for rods and logs without being felled.
//
// - A tree stands on one Plot entry like a bed (`unique` on room and cell) and takes light of a fire.
// - It carries one date: when it grows on, or when its crop is ripe. The tree tick (in the garden job) writes a tree only
//   when that date has come, and never otherwise. Its stages run on the world clock times the patience, so in the second
//   clock: a birch stands in three days whatever the world's rate. Fog slows it when the date is set, winter holds it.
// - Felling and harvesting take the tree in the command's transaction: two at one tree, and its crop goes to one.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type TreeFields } from "../../model.ts";
import { frozenUntil, patienceOf, worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, levelOf, msg, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { fogOf } from "../fire.ts";
import type { TreeSortDef, TreesDef, WorldDef } from "../world.ts";
import { ARTICLE, besides, distTo, freeCells, giveBack, human, lightFor, refusal, releaseLight, rested, SITE_REACH, takeNear, tire, useLight, type Rect } from "./build.ts";
import { growFactor, protoName } from "./garden.ts";
import { needRank } from "./settlement.ts";
import { consume, move } from "./trade.ts";
import { randomBytes, randomInt } from "../source.ts";

const STAGES = ["Setzling", "junger Baum", "ausgewachsen"] as const;
export const sortOfTree = (d: TreesDef, key: string): TreeSortDef | undefined => d.sorts.find((s) => s.key === key);
const sortName = (d: TreesDef, t: TreeFields) => sortOfTree(d, t.sort)?.name ?? t.sort;
const mine = (c: CommandCtx, t: TreeFields) => !!c.account && t.accountId === c.account.accountId;
/** A span as one says it: minutes, hours, from two days on days. */
const span = (ms: number) => {
	const h = Math.round(ms / 3600_000);
	if (h >= 48) return `${Math.round(h / 24)} Tagen`;
	return h >= 1 ? `${h} ${h === 1 ? "Stunde" : "Stunden"}` : `${Math.max(1, Math.round(ms / 60_000))} Minuten`;
};

/** When a tree in `stage` next changes: grows on (seedling, young tree) or bears (grown); FOREVER when nothing comes. */
export function nextDate(s: TreeSortDef, stage: number, now: number, fog: number, patient: number): number {
	if (stage < 2) return now + s.grow[stage]! * patient * growFactor(fog, false);
	return s.crop ? now + s.crop.everyWorldMs * patient : FOREVER;
}

/** A tree whose date has come grows on or bears; true when anything changed. In winter it waits for the spring. */
export function advanceTree(d: TreesDef, t: TreeFields, now: number, fog: number, patient: number, frozen: number | null): boolean {
	if (t.dueWorldMs > now) return false;
	const s = sortOfTree(d, t.sort);
	if (frozen !== null) t.dueWorldMs = frozen;
	else if (!s) t.dueWorldMs = FOREVER;
	else if (t.stage < 2) { t.stage = (t.stage + 1) as 1 | 2; t.dueWorldMs = nextDate(s, t.stage, now, fog, patient); }
	else if (s.crop) { t.ripe = true; t.dueWorldMs = FOREVER; }
	else t.dueWorldMs = FOREVER;
	return true;
}

const trees = (c: CommandCtx): TreesDef => {
	const d = c.world.trees;
	if (!d) throw new CommandError("In dieser Welt pflanzt niemand Bäume.");
	return d;
};

/** `pflanze <samen> [x y]` with a tree's seed: a seedling on a free cell beside one, in the light of a fire. False when the
 *  line names no tree seed one carries (the garden's pflanze goes on with it). */
export async function plantTree(c: CommandCtx, arg: string): Promise<boolean> {
	const d = c.world.trees;
	if (!d) return false;
	const m = /^(.+?)(?:\s+(\d+)\s+(\d+))?$/.exec(arg.trim().replace(/\s+(?:in\s+die\s+erde|ein)$/i, ""));
	if (!m || !m[1]) return false;
	// among all the seeds one carries, so a near name of a garden seed stays the garden's
	const seed = (proto: string) => d.sorts.some((s) => s.seed === proto) || !!c.world.garden?.sorts.some((s) => s.seed === proto) || !!c.world.fields?.crops.some((s) => s.seed === proto);
	const hit = itemsNamed(c.world, (await inventory(c)).filter((i) => seed(i.f.proto)), m[1].replace(ARTICLE, "").trim().toLowerCase())[0];
	if (!hit || !d.sorts.some((s) => s.seed === hit.f.proto)) return false;
	const sort = d.sorts.find((s) => s.seed === hit.f.proto)!;
	if (!c.account || c.account.guest) throw new CommandError("Gäste pflanzen keine Bäume; registriere dich dafür.");
	if (!human(c)) throw new CommandError("Bäume pflanzen nur Menschen.");
	await needRank(c, "siedler", "Bäume pflanzen");
	if (!(await inventory(c)).some((i) => i.f.proto === d.spade)) throw new CommandError(`Zum Pflanzen brauchst du einen ${protoName(c, d.spade)} („craft ${protoName(c, d.spade).toLowerCase()}“).`);
	if ((await c.space.count({ type: "Tree", fields: { accountId: c.account.accountId } })) >= d.maxTrees) throw new CommandError(`Mehr als ${d.maxTrees} Bäume pflanzt niemand; fälle erst einen.`);
	const light = await lightFor(c, d.points);
	if (typeof light === "string") throw new CommandError(light.replace("gebaut wird", "gepflanzt wird").replace("Bau", "Baum"));
	const room = await roomOf(c);
	const tries: Rect[] = m[2] !== undefined ? [{ x: Number(m[2]), y: Number(m[3]), w: 1, h: 1 }] : besides(c, { w: 1, h: 1 });
	let rect: Rect | null = null, why = "";
	for (const r of tries) { const no = await refusal(c, room, r, true, true); if (!no) { rect = r; break; } why ||= no; }
	if (!rect) throw new CommandError(`Hier passt kein Baum hin: ${why}`);
	if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: hit.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Der Samen ist gerade nicht greifbar; bitte noch einmal.");
	const treeId = `tree-${randomBytes(6).toString("hex")}`, now = await worldNowOf(c.space, c.txn);
	try { await c.space.write({ type: "Plot", fields: { room: room.roomId, x: rect.x, y: rect.y, of: treeId } as never }, c.txn, FOREVER, { unique: ["room", "x", "y"] }); }
	catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Dort hat gerade jemand anderes gegraben."); throw e; }
	await useLight(c, light.beaconId, light.use, d.points, light.fresh);
	const t: TreeFields = { treeId, sort: sort.key, room: room.roomId, x: rect.x, y: rect.y, w: 1, h: 1, owner: c.actor.charId, ownerName: c.actor.name, accountId: c.account.accountId, beaconId: light.beaconId, points: d.points,
		stage: 0, dueWorldMs: nextDate(sort, 0, now, await fogOf(c.space, room.roomId), await patienceOf(c.space, c.txn)), at: now };
	await c.space.write({ type: "Tree", fields: t as never }, c.txn, FOREVER);
	await msg(c, "*", "emote", `${c.actor.name} pflanzt ${hit.f.name} ein: Hier wächst bald ${sort.a}. „baum“ zeigt, wie weit er ist.`);
	return true;
}

/** What one tree is now, for `baum`. */
function describe(d: TreesDef, t: TreeFields, now: number): string {
	const s = sortOfTree(d, t.sort);
	const left = t.dueWorldMs < FOREVER ? span(Math.max(0, t.dueWorldMs - now)) : "";
	const state = t.stage === 0 ? `${STAGES[0]}, ein junger Baum in etwa ${left}` : t.stage === 1 ? `${STAGES[1]}, ausgewachsen in etwa ${left}`
		: t.ripe ? `ausgewachsen; ${s?.crop?.cut ? "die Ruten sind lang genug zum Schneiden" : `${s?.fruit ?? "die Früchte"} hängen reif daran`}`
		: s?.crop ? `ausgewachsen; ${s.crop.cut ? "die Ruten wachsen nach" : `trägt wieder ${s.fruit ?? "Früchte"}`} in etwa ${left}` : "ausgewachsen";
	return `${sortName(d, t)} von ${t.ownerName} (${t.x} ${t.y}): ${state}.`;
}

const baum: Command = {
	key: "baum", aliases: ["bäume", "baeume", "tree", "trees"],
	help: "baum – die gepflanzten Bäume hier und wie weit sie sind (baum ansehen x y: der Baum dort); pflanzen: pflanze <samen> mit einem Spaten, fällen: fälle, ernten: ernte baum",
	async func(c, arg) {
		const d = trees(c);
		const [word = "", ...rest] = arg.trim().split(/\s+/);
		const [x, y] = /^(?:ansehen|look)$/i.test(word) ? rest.map(Number) : [];
		const here = (await c.space.readAll({ type: "Tree", fields: { room: c.actor.room } })).map((e) => fieldsOf<TreeFields>(e)).filter((t) => x === undefined || y === undefined || (t.x === x && t.y === y));
		if (!here.length) return msg(c, c.actor.charId, "info", `Hier steht kein gepflanzter Baum. Mit einem ${protoName(c, d.spade)} pflanzt „pflanze ${protoName(c, d.sorts[0]!.seed).toLowerCase()}“ einen (im Licht eines Feuers).`);
		const now = await worldNowOf(c.space, c.txn);
		await msg(c, c.actor.charId, "look", here.map((t) => describe(d, t, now)).join("\n"));
	},
};

/** The tree within reach the actor may fell (its own; an admin's any; `x y`: the one on that cell), taken in the
 *  transaction. */
async function treeHere(c: CommandCtx, arg: string, admin: boolean): Promise<TreeFields> {
	const at = /^(\d+)\s+(\d+)$/.exec(arg.trim());
	const where = (t: TreeFields) => !at || (t.x === Number(at[1]) && t.y === Number(at[2]));
	const r = await takeNear<TreeFields>(c, "Tree", "treeId", SITE_REACH, (t) => where(t) && (admin || mine(c, t)));
	if ("f" in r) return r.f;
	const other = (await c.space.readAll({ type: "Tree", fields: { room: c.actor.room } })).map((e) => fieldsOf<TreeFields>(e)).find((t) => where(t) && distTo(c.actor, t) <= SITE_REACH);
	if (other) throw new CommandError(`Dieser Baum (${sortName(c.world.trees!, other)}) gehört ${other.ownerName}; fällen darf ihn nur, wer ihn gepflanzt hat.`);
	throw new NotUnderstood(r.far ? "Geh näher an deinen Baum heran (höchstens zwei Schritte entfernt)." : "Hier steht kein Baum, den du gepflanzt hast.");
}

const faelle: Command = {
	key: "fälle", aliases: ["faelle", "fällen", "faellen", "fäll", "fell", "chop"],
	help: "fälle [x y] – deinen ausgewachsenen Baum neben dir mit einer Axt fällen: er gibt Scheite (sie zählen wie Treibholz); Birke und Kopfweide treiben aus dem Stumpf wieder aus (danach ruhst du eine Weile)",
	async func(c, arg) {
		const d = trees(c);
		if (!c.account && c.loadAccount) { c.account = await c.loadAccount(); delete c.loadAccount; }
		const axe = (await inventory(c)).find((i) => i.f.proto === d.axe);
		if (!axe) throw new CommandError(`Zum Fällen brauchst du eine ${protoName(c, d.axe)} („craft ${protoName(c, d.axe).toLowerCase()}“).`);
		const { now, rest } = await rested(c);
		const t = await treeHere(c, arg, levelOf(c.account) === "Admin");
		const s = sortOfTree(d, t.sort);
		if (!s) throw new CommandError("Diesen Baum kennt die Welt nicht mehr.");
		if (t.stage < 2) throw new CommandError(`${s.name}: noch zu jung zum Fällen; ausgewachsen in etwa ${span(Math.max(0, t.dueWorldMs - now))}.`);
		const left = axe.f.wear === undefined ? 1 : axe.f.wear - 1;
		if (left <= 0) await consume(c, axe.f, c.actor.charId);
		else if (axe.f.wear !== undefined) await move(c, axe.f, c.actor.charId, c.actor.charId, { wear: left });
		const got = await giveBack(c, s.fell);
		if (s.sprouts) {
			const { ripe: _, ...young } = t;
			await c.space.write({ type: "Tree", fields: { ...young, stage: 1, dueWorldMs: nextDate(s, 1, now, await fogOf(c.space, t.room), await patienceOf(c.space, c.txn)) } satisfies TreeFields as never }, c.txn, FOREVER);
		} else {
			await freeCells(c.space, c.txn, t.room, t.treeId);
			await releaseLight(c.space, c.txn, t.beaconId, t.points);
		}
		await tire(c, now, rest);
		if (t.owner !== c.actor.charId) await msg(c, t.owner, "info", `${c.actor.name} hat ${s.the} von dir in ${(await roomOf(c)).name} gefällt.`);
		await msg(c, "*", "info", `${c.actor.name} fällt ${s.the}: ${got.join(", ")}.${s.sprouts ? " Aus dem Stumpf treibt ein neuer Baum aus." : " Das Land ist wieder frei."}${left <= 0 ? ` Die ${axe.f.name} zerbricht dabei.` : ""}`);
	},
};

/** The crop of one's tree within reach (`ernte baum`, or `ernte` without a bed or field near): what it bears, and now and
 *  then a seed with it. False when no tree that bears stands within reach and `named` is false. */
export async function harvestTree(c: CommandCtx, named: boolean): Promise<boolean> {
	const d = c.world.trees;
	if (!d) return false;
	const bears = (t: TreeFields) => !!sortOfTree(d, t.sort)?.crop;
	const near = (await c.space.readAll({ type: "Tree", fields: { room: c.actor.room } })).map((e) => fieldsOf<TreeFields>(e)).filter((t) => bears(t) && distTo(c.actor, t) <= SITE_REACH);
	if (!near.length) { if (named) throw new NotUnderstood("Hier steht kein Baum, der etwas trägt (höchstens zwei Schritte entfernt)."); return false; }
	const own = near.filter((t) => mine(c, t));
	if (!own.length) throw new CommandError(`Dieser Baum (${sortName(d, near[0]!)}) gehört ${near[0]!.ownerName}; ernten darf nur, wer ihn gepflanzt hat.`);
	if (!own.some((t) => t.ripe)) {
		const now = await worldNowOf(c.space, c.txn), next = own.reduce((a, t) => (t.dueWorldMs < a.dueWorldMs ? t : a));
		const s = sortOfTree(d, next.sort)!;
		throw new CommandError(next.stage < 2 ? `${s.name}: noch zu jung zum Tragen; ausgewachsen in etwa ${span(Math.max(0, next.dueWorldMs - now))}.` : `${s.name}: noch nichts reif; in etwa ${span(Math.max(0, next.dueWorldMs - now))} wieder.`);
	}
	const r = await takeNear<TreeFields>(c, "Tree", "treeId", SITE_REACH, (t) => mine(c, t) && !!t.ripe);
	if (!("f" in r)) throw new CommandError("Der Baum ist gerade nicht greifbar; bitte noch einmal.");
	const t = r.f, s = sortOfTree(d, t.sort)!, crop = s.crop!;
	const now = await worldNowOf(c.space, c.txn);
	const what = [...crop.yields, ...(crop.seedChance && randomInt(0, 100) < crop.seedChance * 100 ? [{ proto: s.seed, count: 1 }] : [])];
	const got = await giveBack(c, what);
	const { ripe: _, ...picked } = t;
	await c.space.write({ type: "Tree", fields: { ...picked, dueWorldMs: nextDate(s, 2, now, 0, await patienceOf(c.space, c.txn)) } satisfies TreeFields as never }, c.txn, FOREVER);
	await msg(c, "*", "emote", `${c.actor.name} ${crop.cut ? "schneidet" : "erntet"} ${s.the}: ${got.join(", ")}.`);
	return true;
}

/** A line of `ernte` that means a tree: "baum", "obst", a sort or what it bears. */
export function meansTree(w: WorldDef, arg: string): boolean {
	const d = w.trees, said = arg.trim().replace(ARTICLE, "").trim().toLowerCase();
	if (!d || !said) return false;
	if (/^(?:baum|bäume|baeume|obst|früchte|fruechte|ruten|tree|trees|fruit)$/.test(said)) return true;
	return d.sorts.some((s) => [s.key, s.name, ...s.aliases, ...(s.fruit ? [s.fruit] : [])].some((n) => n.toLowerCase() === said));
}

export const TREE_COMMANDS: Command[] = [baum, faelle];

/** The trees' part of the garden job (world-host.ts): trees whose date has come grow on or bear, each in a transaction
 *  of its own (one held by a command right now is left for the next round). Writes nothing when no date has come. */
export async function treeTick(space: SpaceLike, w: WorldDef): Promise<number> {
	const d = w.trees;
	if (!d) return 0;
	const now = await worldNowOf(space);
	const due = (await space.readAll({ type: "Tree" })).map((e) => fieldsOf<TreeFields>(e)).filter((t) => t.dueWorldMs <= now);
	if (!due.length) return 0;
	const patient = await patienceOf(space), winter = await frozenUntil(space, now);
	let written = 0;
	for (const t of due) {
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const e = await space.takeIfExists({ type: "Tree", fields: { treeId: t.treeId } }, NO_WAIT, { txn });
			if (!e) { await space.abort(txn); continue; }
			const tree = fieldsOf<TreeFields>(e);
			if (!advanceTree(d, tree, now, await fogOf(space, tree.room), patient, winter)) { await space.abort(txn); continue; }
			await space.write({ type: "Tree", fields: tree as never }, txn, FOREVER);
			await space.commit(txn);
			written++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return written;
}

/** A tree as the page draws it. */
export const treeView = (w: WorldDef, t: TreeFields) => {
	const s = w.trees?.sorts.find((x) => x.key === t.sort);
	return { name: s?.name ?? t.sort, model: s?.model ?? "tree", color: s?.color ?? "#6a8a3a", stage: t.stage, ripe: !!t.ripe, cut: !!s?.crop?.cut };
};
