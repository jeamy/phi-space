// Gardens, step 2 part 1 (docs/siedeln.md "Gärten"): a player digs a bed in the light with a spade, plants seeds from the
// wild flora, waters it with cans from a rain barrel, weeds it and harvests what is ripe; a sponsor may tend a bed
// without owning it.
//
// - A bed stands on Plot entries like a building (one per cell, `unique` on room and cell) and takes light of a fire.
// - Its plants live inside the Bed entry, and the bed carries one date: the earliest stage change of its plants. A stage
//   change or a watering is one write of the bed, whatever grows in it; the garden tick looks only at beds whose date
//   has come, and writes nothing otherwise (the doc's acceptance: writes only at stage changes and waterings).
// - Fog slows growth and weeds slow it too: the factor is taken when the bed is written anyway (planting, a stage
//   change), never by rewriting beds when the fog moves.
// - A plant that reaches its next stage dry (no water for `thirstWorldMs`) wilts; a ripe plant wilts after its time.
// - Harvesting takes the bed in the command's transaction: ten at one bed, and every ripe plant goes to exactly one.
import { randomBytes, randomInt } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BedFields, type BedPlant, type BuildingFields, type SeedRestFields } from "../../model.ts";
import { peek } from "../../space.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { byName, CommandError, inventory, msg, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { fogOf } from "../fire.ts";
import type { GardenDef, SortDef, WorldDef } from "../world.ts";
import { ARTICLE, besides, buildingHere, cells, freeCells, giveBack, human, lightFor, plural, putBack, refusal, releaseLight, SITE_REACH, takeNear, useLight, type Rect } from "./build.ts";

const STAGES = ["Saat", "Keim", "reif", "welk"] as const;
const garden = (c: CommandCtx): GardenDef => {
	const g = c.world.garden;
	if (!g) throw new CommandError("In dieser Welt wächst nichts in Beeten.");
	return g;
};
const sortOf = (g: GardenDef, key: string): SortDef | undefined => g.sorts.find((s) => s.key === key);
const protoName = (c: CommandCtx, key: string) => c.world.prototypes.find((p) => p.key === key)?.name ?? key;
const mayTend = (c: CommandCtx, b: BedFields) => b.accountId === c.account?.accountId || b.sponsors.some((s) => s.charId === c.actor.charId);
const hours = (ms: number) => { const h = Math.round(ms / 3600_000); return h >= 1 ? `${h} ${h === 1 ? "Stunde" : "Stunden"}` : `${Math.max(1, Math.round(ms / 60_000))} Minuten`; };

/** How much slower things grow: fog (0 to 3) and weeds. Taken when the bed is written anyway. */
export const growFactor = (fog: number, weedy: boolean) => (1 + 0.5 * Math.max(0, fog)) * (weedy ? 1.5 : 1);
const nextDue = (plants: BedPlant[]) => plants.reduce((m, p) => Math.min(m, p.dueWorldMs), FOREVER);

/** The plants whose date has come move on (or wilt, dry or past their time); true when anything changed. Each plant that
 *  sprouts or ripens may bring weeds. */
export function advance(g: GardenDef, b: BedFields, now: number, fog: number, rnd: () => number = Math.random): boolean {
	let changed = false;
	for (const p of b.plants) {
		if (p.dueWorldMs > now) continue;
		changed = true;
		const sort = sortOf(g, p.sort);
		if (!sort || p.stage >= 2 || now - b.wateredWorldMs > g.thirstWorldMs) { p.stage = 3; p.dueWorldMs = FOREVER; continue; }
		p.stage = (p.stage + 1) as 1 | 2;
		p.dueWorldMs = now + (p.stage === 1 ? sort.grow[1] * growFactor(fog, b.weedy) : sort.ripeWorldMs);
		if (!b.weedy && rnd() < 0.2) b.weedy = true;
	}
	b.dueWorldMs = nextDue(b.plants);
	return changed;
}

/** A rain barrel's cans now: what it held, and one more every `barrelFillWorldMs` since, up to its size. */
export function barrelWater(g: GardenDef, b: BuildingFields, now: number): { cans: number; at: number } {
	const at = b.waterAtWorldMs ?? b.builtAt, have = b.water ?? 1;
	const gained = Math.floor(Math.max(0, now - at) / g.barrelFillWorldMs);
	if (have + gained >= g.barrelCap) return { cans: g.barrelCap, at: now };
	return { cans: have + gained, at: at + gained * g.barrelFillWorldMs };
}

/** A bed within reach (`own`: one's own), taken in the transaction. */
async function bedHere(c: CommandCtx, o: { own?: boolean; reach?: number } = {}): Promise<BedFields> {
	const r = await takeNear<BedFields>(c, "Bed", "bedId", o.reach ?? SITE_REACH, (b) => !o.own || b.accountId === c.account?.accountId);
	if ("f" in r) return r.f;
	throw new NotUnderstood(r.far ? (o.own ? "Geh näher an dein Beet heran." : "Geh näher an das Beet heran (höchstens zwei Schritte entfernt).") : "Hier ist kein Beet. „umgraben“ legt eins an (mit einem Spaten).");
}
const writeBed = (c: CommandCtx, b: BedFields) => c.space.write({ type: "Bed", fields: b as never }, c.txn, FOREVER);
const describe = (c: CommandCtx, g: GardenDef, b: BedFields, now: number) => {
	const count = new Map<string, number>();
	for (const p of b.plants) { const k = `${sortOf(g, p.sort)?.name ?? p.sort} (${STAGES[p.stage]})`; count.set(k, (count.get(k) ?? 0) + 1); }
	const plants = count.size ? [...count].map(([k, n]) => `${n}× ${k}`).join(", ") : "noch nichts gepflanzt";
	const ago = now - b.wateredWorldMs;
	const water = ago > g.thirstWorldMs * 0.75 ? "braucht Wasser" : `gegossen vor ${hours(ago)}`;
	return `Beet von ${b.ownerName} (${b.w}×${b.h}): ${plants}; ${water}${b.weedy ? ", voller Unkraut" : ""}${b.sponsors.length ? `; Paten: ${b.sponsors.map((s) => s.name).join(", ")}` : ""}.`;
};

async function dig(c: CommandCtx, at: string): Promise<void> {
	const g = garden(c);
	if (!c.account || c.account.guest) throw new CommandError("Gäste können als Pate gießen und ernten, aber kein eigenes Beet anlegen; registriere dich dafür.");
	if (!human(c)) throw new CommandError("Beete legen nur Menschen an.");
	if (!(await inventory(c)).some((i) => i.f.proto === g.spade)) throw new CommandError(`Zum Umgraben brauchst du einen ${protoName(c, g.spade)} („craft ${protoName(c, g.spade).toLowerCase()}“).`);
	if ((await c.space.count({ type: "Bed", fields: { accountId: c.account.accountId } })) >= g.maxBeds) throw new CommandError(`Mehr als ${g.maxBeds} Beete pflegt niemand.`);
	const light = await lightFor(c, g.bed.points);
	if (typeof light === "string") throw new CommandError(light.replace("gebaut wird", "gegärtnert wird").replace("Bau", "Beet"));
	const room = await roomOf(c);
	const m = /^(\d+)\s+(\d+)$/.exec(at.trim());
	const tries: Rect[] = m ? [{ x: Number(m[1]), y: Number(m[2]), w: g.bed.w, h: g.bed.h }] : besides(c, g.bed);
	let rect: Rect | null = null, why = "";
	for (const r of tries) { const no = await refusal(c, room, r); if (!no) { rect = r; break; } why ||= no; }
	if (!rect) throw new CommandError(`Hier passt kein Beet hin: ${why}`);
	const bedId = `bed-${randomBytes(6).toString("hex")}`, now = await worldNowOf(c.space, c.txn);
	for (const p of cells(rect)) {
		try { await c.space.write({ type: "Plot", fields: { room: room.roomId, x: p.x, y: p.y, of: bedId } as never }, c.txn, FOREVER, { unique: ["room", "x", "y"] }); }
		catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Dort hat gerade jemand anderes umgegraben."); throw e; }
	}
	await useLight(c, light.beaconId, light.use, g.bed.points, light.fresh);
	const b: BedFields = { bedId, room: room.roomId, ...rect, owner: c.actor.charId, ownerName: c.actor.name, accountId: c.account.accountId, beaconId: light.beaconId, points: g.bed.points,
		sponsors: [], plants: [], wateredWorldMs: now, weedy: false, dueWorldMs: FOREVER, untilWorldMs: now + g.bed.keepWorldMs, at: now };
	await writeBed(c, b);
	await msg(c, "*", "info", `${c.actor.name} gräbt ein Beet um (${rect.w}×${rect.h}). „pflanze <samen>“ setzt etwas hinein.`);
}

const umgraben: Command = {
	key: "umgraben", aliases: ["umgrabe", "dig-bed"],
	help: "umgraben [x y] – mit einem Spaten neben dir ein Beet anlegen (im Licht eines Feuers)",
	func: (c, arg) => dig(c, arg),
};

const beet: Command = {
	key: "beet", aliases: ["beete", "bed", "beds", "garten", "garden"],
	help: "beet – die Beete hier (beet anlegen [x y]: umgraben; beet aufgeben: dein Beet neben dir wieder zu Gras)",
	async func(c, arg) {
		const g = garden(c);
		const [word = "", ...rest] = arg.trim().split(/\s+/);
		if (/^(?:anlegen|neu|new|umgraben|\d+)$/i.test(word)) return dig(c, /^\d+$/.test(word) ? arg : rest.join(" "));
		if (/^(?:aufgeben|abreissen|abreißen|weg|remove)$/i.test(word)) {
			const b = await bedHere(c, { own: true, reach: 1 });
			await freeCells(c.space, c.txn, b.room, b.bedId);
			await releaseLight(c.space, c.txn, b.beaconId, b.points);
			return msg(c, "*", "info", `${c.actor.name} gibt das Beet auf; dort wächst wieder Gras.`);
		}
		const beds = (await c.space.readAll({ type: "Bed", fields: { room: c.actor.room } })).map((e) => fieldsOf<BedFields>(e));
		if (!beds.length) return msg(c, c.actor.charId, "info", `Hier ist kein Beet. Mit einem ${protoName(c, g.spade)} legt „umgraben“ eins an.`);
		const now = await worldNowOf(c.space, c.txn);
		await msg(c, c.actor.charId, "look", beds.map((b) => describe(c, g, b, now)).join("\n"));
	},
};

const pflanze: Command = {
	key: "pflanze", aliases: ["pflanz", "pflanzen", "säe", "säen", "saee", "sae", "plant", "sow", "setze-samen"],
	help: "pflanze <samen> [x y] – Samen in dein Beet neben dir setzen (bis zwei Schritte; eine Pflanze je Zelle)",
	async func(c, arg) {
		const g = garden(c);
		const m = /^(.+?)(?:\s+(\d+)\s+(\d+))?$/.exec(arg.trim().replace(/\s+(?:in|ins)\s+(?:das\s+|mein\s+)?beet$/i, ""));
		if (!m || !m[1]) throw new NotUnderstood("Was pflanzt du? Zum Beispiel: pflanze strandnelke");
		const seeds = (await inventory(c)).filter((i) => g.sorts.some((s) => s.seed === i.f.proto));
		const hit = byName(seeds, m[1].replace(ARTICLE, ""))[0];
		if (!hit) throw new NotUnderstood(seeds.length ? `Du hast keinen Samen, der „${m[1].slice(0, 30)}“ heißt. Du trägst: ${[...new Set(seeds.map((s) => s.f.name))].join(", ")}.` : "Du trägst keine Samen. „sammle samen“ sucht welche in der wilden Flora.");
		const sort = g.sorts.find((s) => s.seed === hit.f.proto)!;
		const b = await bedHere(c, { own: true });
		const free = cells(b).filter((p) => !b.plants.some((q) => q.x === p.x && q.y === p.y));
		const cell = m[2] !== undefined ? free.find((p) => p.x === Number(m[2]) && p.y === Number(m[3])) : free[0];
		if (!cell) throw new CommandError(free.length ? "Diese Zelle gehört nicht zum Beet oder ist schon bepflanzt." : "Das Beet ist voll; ernte erst oder jäte das Welke aus.");
		if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: hit.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Der Samen ist gerade nicht greifbar; bitte noch einmal.");
		const now = await worldNowOf(c.space, c.txn);
		b.plants.push({ x: cell.x, y: cell.y, sort: sort.key, stage: 0, dueWorldMs: now + sort.grow[0] * growFactor(await fogOf(c.space, b.room), b.weedy) });
		// planting waters the seed
		b.wateredWorldMs = now;
		b.untilWorldMs = now + g.bed.keepWorldMs;
		b.dueWorldMs = nextDue(b.plants);
		await writeBed(c, b);
		await msg(c, "*", "emote", `${c.actor.name} setzt ${sort.name} ins Beet.`);
	},
};

const giesse: Command = {
	key: "gieße", aliases: ["giesse", "gießen", "giessen", "gieß", "giess", "gies", "water"],
	help: "gieße – ein Beet neben dir gießen, deins oder eins, dessen Pate du bist (braucht eine Kanne Wasser aus der Regentonne)",
	async func(c) {
		const g = garden(c);
		const can = (await inventory(c)).find((i) => i.f.proto === g.can);
		if (!can) throw new CommandError(`Du hast keine ${protoName(c, g.can)}. An einer Regentonne füllt „schöpfe“ eine.`);
		const b = await bedHere(c);
		if (!mayTend(c, b)) throw new CommandError(`Das ist das Beet von ${b.ownerName}; gießen dürfen der Besitzer und seine Paten.`);
		if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: can.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Die Kanne ist gerade nicht greifbar; bitte noch einmal.");
		const now = await worldNowOf(c.space, c.txn);
		b.wateredWorldMs = now;
		b.untilWorldMs = now + g.bed.keepWorldMs;
		await writeBed(c, b);
		await msg(c, "*", "emote", b.accountId === c.account?.accountId ? `${c.actor.name} gießt das Beet.` : `${c.actor.name} gießt das Beet von ${b.ownerName}.`);
	},
};

const jaete: Command = {
	key: "jäte", aliases: ["jaete", "jäten", "jaeten", "jät", "jaet", "weed"],
	help: "jäte – Unkraut und Welkes aus einem Beet neben dir ziehen (deins oder als Pate)",
	async func(c) {
		const g = garden(c);
		const b = await bedHere(c);
		if (!mayTend(c, b)) throw new CommandError(`Das ist das Beet von ${b.ownerName}; jäten dürfen der Besitzer und seine Paten.`);
		const wilted = b.plants.filter((p) => p.stage === 3).length;
		if (!b.weedy && !wilted) throw new CommandError("Das Beet ist sauber; hier gibt es nichts zu jäten.");
		const now = await worldNowOf(c.space, c.txn);
		b.weedy = false;
		b.plants = b.plants.filter((p) => p.stage !== 3);
		b.dueWorldMs = nextDue(b.plants);
		b.untilWorldMs = now + g.bed.keepWorldMs;
		await writeBed(c, b);
		await msg(c, "*", "emote", `${c.actor.name} jätet das Beet${wilted ? ` und zieht ${plural(wilted, "welke Pflanze", "welke Pflanzen")} heraus` : ""}.`);
	},
};

const ernte: Command = {
	key: "ernte", aliases: ["ernten", "pflücke", "pfluecke", "harvest"],
	help: "ernte – was in einem Beet neben dir reif ist, in deine Tasche (deins oder als Pate); dazu gibt es Samen",
	async func(c) {
		const g = garden(c);
		const b = await bedHere(c);
		if (!mayTend(c, b)) throw new CommandError(`Das ist das Beet von ${b.ownerName}; ernten dürfen der Besitzer und seine Paten.`);
		const ripe = b.plants.filter((p) => p.stage === 2);
		if (!ripe.length) throw new CommandError("Im Beet ist noch nichts reif.");
		const got: Array<{ proto: string; count: number }> = [];
		for (const p of ripe) {
			const sort = sortOf(g, p.sort);
			if (!sort) continue;
			got.push(sort.yields, { proto: sort.seed, count: 1 + (randomInt(0, 10) < 3 ? 1 : 0) });
		}
		const sum = new Map<string, number>(); for (const x of got) sum.set(x.proto, (sum.get(x.proto) ?? 0) + x.count);
		const names = await giveBack(c, [...sum].map(([proto, count]) => ({ proto, count })));
		const now = await worldNowOf(c.space, c.txn);
		b.plants = b.plants.filter((p) => p.stage !== 2);
		b.dueWorldMs = nextDue(b.plants);
		b.untilWorldMs = now + g.bed.keepWorldMs;
		await writeBed(c, b);
		await msg(c, "*", "emote", `${c.actor.name} erntet ${b.accountId === c.account?.accountId ? "das Beet" : `das Beet von ${b.ownerName}`}: ${names.join(", ")}.`);
	},
};

const pate: Command = {
	key: "pate", aliases: ["paten", "patin", "sponsor"],
	help: "pate <name> – jemanden dein Beet neben dir gießen, jäten und ernten lassen (pate weg <name> beendet es; pate allein: wer es darf)",
	async func(c, arg) {
		const [first = "", ...rest] = arg.trim().split(/\s+/);
		const remove = /^(?:weg|ende|kündige|kuendige|stop|remove)$/i.test(first);
		const name = (remove ? rest.join(" ") : arg).trim();
		const b = await bedHere(c, { own: true, reach: SITE_REACH });
		if (!name) { await writeBed(c, b); return msg(c, c.actor.charId, "info", b.sponsors.length ? `Paten deines Beets: ${b.sponsors.map((s) => s.name).join(", ")}.` : "Dein Beet hat keinen Paten. „pate <name>“ lässt jemanden gießen, jäten und ernten."); }
		if (remove) {
			const before = b.sponsors.length;
			b.sponsors = b.sponsors.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
			await writeBed(c, b);
			if (b.sponsors.length === before) throw new CommandError(`${name.slice(0, 30)} ist kein Pate deines Beets.`);
			return msg(c, "*", "info", `${c.actor.name} beendet die Patenschaft von ${name} für das Beet.`);
		}
		const who = (await c.space.readAll({ type: "Character" })).map((e) => fieldsOf<{ charId: string; name: string }>(e)).find((x) => x.name.toLowerCase() === name.toLowerCase());
		if (!who) throw new CommandError(`Eine Figur „${name.slice(0, 30)}“ ist auf dieser Insel nicht bekannt.`);
		if (who.charId === c.actor.charId) throw new CommandError("Dein eigenes Beet pflegst du ohnehin.");
		if (b.sponsors.some((s) => s.charId === who.charId)) throw new CommandError(`${who.name} ist schon Pate.`);
		if (b.sponsors.length >= 5) throw new CommandError("Mehr als fünf Paten hat kein Beet.");
		b.sponsors = [...b.sponsors, { charId: who.charId, name: who.name }];
		await writeBed(c, b);
		await msg(c, "*", "info", `${c.actor.name} macht ${who.name} zum Paten des Beets: gießen, jäten und ernten darf ${who.name} jetzt auch.`);
	},
};

const sammle: Command = {
	key: "sammle", aliases: ["sammeln", "samen", "seeds", "gather"],
	help: "sammle samen – in der wilden Flora hier nach Samen suchen (findet nicht immer etwas; danach eine Weile Pause)",
	async func(c, arg) {
		const g = garden(c);
		if (arg.trim() && !/^(?:samen|seeds?|saatgut)$/i.test(arg.trim().replace(ARTICLE, ""))) throw new NotUnderstood("Gesammelt werden hier Samen („sammle samen“); Dinge am Strand hebst du mit „get“ auf.");
		const now = await worldNowOf(c.space, c.txn);
		const rest = await peek(c.space, { type: "SeedRest", fields: { charId: c.actor.charId } });
		const until = rest ? fieldsOf<SeedRestFields>(rest).untilWorldMs : 0;
		if (until > now) throw new CommandError(`Du hast hier eben erst gesucht; in etwa ${hours(until - now)} wieder.`);
		const room = c.world.rooms.find((r) => r.roomId === c.actor.room);
		const decor = new Set((room?.decor ?? []).join(""));
		const grows = (s: SortDef) => !!s.wild && g.decor[s.wild.decor].some((k) => decor.has(k)) && (!s.wild.islands || s.wild.islands.includes(room?.island ?? ""));
		const wild = g.sorts.filter(grows);
		if (!wild.length) throw new CommandError("Hier wächst nichts Wildes, das Samen trägt.");
		if (rest) await c.space.takeIfExists({ id: rest.id }, NO_WAIT, { txn: c.txn });
		await c.space.write({ type: "SeedRest", fields: { charId: c.actor.charId, untilWorldMs: now + g.seedRestWorldMs } satisfies SeedRestFields as never }, c.txn, FOREVER);
		if (randomInt(0, 1000) >= g.seedChance * 1000) return msg(c, c.actor.charId, "info", "Du suchst zwischen den Pflanzen, findest aber keine reifen Samen.");
		const sort = wild[randomInt(0, wild.length)]!;
		const got = await giveBack(c, [{ proto: sort.seed, count: 1 }]);
		await msg(c, c.actor.charId, "info", `Du findest ${got.join(", ")}.`);
	},
};

const schoepfe: Command = {
	key: "schöpfe", aliases: ["schoepfe", "schöpfen", "schoepfen", "schöpf", "schoepf", "fülle", "fuelle", "fill"],
	help: "schöpfe – an einer Regentonne neben dir eine Kanne Wasser füllen",
	async func(c) {
		const g = garden(c);
		const barrel = c.world.building?.plans.find((p) => p.key === g.barrel);
		const b = await buildingHere(c, barrel?.name ?? g.barrel, { own: false }).catch((e) => { throw e instanceof NotUnderstood ? new NotUnderstood(`Geh direkt neben eine ${barrel?.name ?? "Regentonne"}.`) : e; });
		if (b.plan !== g.barrel) { await putBack(c, b); throw new NotUnderstood(`Geh direkt neben eine ${barrel?.name ?? "Regentonne"}.`); }
		const now = await worldNowOf(c.space, c.txn);
		const w = barrelWater(g, b, now);
		if (w.cans < 1) { await putBack(c, b); throw new CommandError(`Die ${b.name} ist leer; in etwa ${hours(w.at + g.barrelFillWorldMs - now)} hat sie wieder eine Kanne (bei Sturmflut ist sie voll).`); }
		await putBack(c, { ...b, water: w.cans - 1, waterAtWorldMs: w.at });
		await giveBack(c, [{ proto: g.can, count: 1 }]);
		await msg(c, c.actor.charId, "info", `Du füllst eine ${protoName(c, g.can)} (noch ${w.cans - 1} in der Tonne).`);
	},
};

export const GARDEN_COMMANDS: Command[] = [beet, umgraben, pflanze, giesse, jaete, ernte, pate, sammle, schoepfe];

/** The garden's recurring job (engine/worldevents.ts, "garden"): beds whose date has come move their plants on, each in a
 *  transaction of its own (one held by a command right now is left for the next round); a bed nobody tended for its time
 *  goes back to grass and gives its light back; seed rests that are over go. Writes nothing when no date has come. */
export async function gardenTick(space: SpaceLike, w: WorldDef): Promise<number> {
	const g = w.garden;
	if (!g) return 0;
	const now = await worldNowOf(space);
	let written = 0;
	for (const e of await space.readAll({ type: "Bed" })) {
		const b = fieldsOf<BedFields>(e);
		if (b.dueWorldMs > now && b.untilWorldMs > now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Bed", fields: { bedId: b.bedId } }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			const bed = fieldsOf<BedFields>(t);
			if (bed.untilWorldMs <= now) {
				await freeCells(space, txn, bed.room, bed.bedId);
				await releaseLight(space, txn, bed.beaconId, bed.points);
			} else {
				advance(g, bed, now, await fogOf(space, bed.room));
				await space.write({ type: "Bed", fields: bed as never }, txn, FOREVER);
			}
			await space.commit(txn);
			written++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	for (const e of await space.readAll({ type: "SeedRest" })) if (Number(e.fields.untilWorldMs) <= now) await space.takeIfExists({ id: e.id }, NO_WAIT);
	return written;
}

/** A storm surge fills the rain barrels of its island (engine/fire.ts stormTick names the room). */
export async function stormFillsBarrels(space: SpaceLike, w: WorldDef, roomId: string | null): Promise<void> {
	const g = w.garden;
	if (!g || !roomId) return;
	const island = w.rooms.find((r) => r.roomId === roomId)?.island;
	const rooms = new Set(w.rooms.filter((r) => r.island === island).map((r) => r.roomId));
	const now = await worldNowOf(space);
	for (const e of await space.readAll({ type: "Building", fields: { plan: g.barrel } })) {
		const b = fieldsOf<BuildingFields>(e);
		if (!rooms.has(b.room) || (b.water ?? 0) >= g.barrelCap) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Building", fields: { buildId: b.buildId } }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			await space.write({ type: "Building", fields: { ...fieldsOf<BuildingFields>(t), water: g.barrelCap, waterAtWorldMs: now } as never }, txn, FOREVER);
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
}

/** A bed as the page draws it: its plants at their cells (relative to the bed), with the colour of their sort. */
export const bedPlantsView = (w: WorldDef, b: BedFields) => b.plants.map((p) => ({ x: p.x - b.x, y: p.y - b.y, stage: p.stage, color: w.garden?.sorts.find((s) => s.key === p.sort)?.color ?? "#7fae6a" }));
