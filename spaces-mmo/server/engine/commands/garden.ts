// Gardens, step 2 (docs/siedeln.en.md "Gärten"): a player digs a bed in the light with a spade, plants seeds from the
// wild flora, waters it with cans from a rain barrel, weeds it and harvests what is ripe; a sponsor may tend a bed
// without owning it.
//
// - Three kinds of bed: a garden bed (vegetables and flowers), a flower bed (flowers only; only there do sorts cross) and
//   a community bed (3×3, one per fire, everyone tends it and harvests into their own pack).
// - Crossing: a ripe flower with a flower of another sort beside it gives now and then a seed of a crossing, a variety of
//   its own colour that its breeder may name (`benenne`). The variety lives on the seed and the plant (it keeps the
//   prototype of the sort it grew from), so it travels to other regions with whoever carries it; the name is `unique`
//   within the region's space. Crossing is rolled at the harvest, which writes the bed anyway.
//
// - A bed stands on Plot entries like a building (one per cell, `unique` on room and cell) and takes light of a fire.
// - Its plants live inside the Bed entry, and the bed carries one date: the earliest stage change of its plants. A stage
//   change or a watering is one write of the bed, whatever grows in it; the garden tick looks only at beds whose date
//   has come, and writes nothing otherwise (the doc's acceptance: writes only at stage changes and waterings).
// - Fog slows growth and weeds slow it too: the factor is taken when the bed is written anyway (planting, a stage
//   change), never by rewriting beds when the fog moves.
// - A plant that reaches its next stage dry (no water for `thirstWorldMs`) wilts; a ripe plant wilts after its time.
// - Harvesting takes the bed in the command's transaction: ten at one bed, and every ripe plant goes to exactly one.
import { needRank } from "./settlement.ts";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BedFields, type BedPlant, type BuildingFields, type ItemFields, type SeedRestFields, type Variety, type VarietyFields } from "../../model.ts";
import { peek } from "../../space.ts";
import { decayNowOf, frozenUntil, patienceOf, worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, levelOf, msg, NotUnderstood, pluralOf, roomOf, type CommandCtx } from "../context.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import { fogOf } from "../fire.ts";
import type { GardenDef, SortDef, WorldDef } from "../world.ts";
import { harvestField, sowOnField } from "./field.ts";
import { harvestTree, meansTree, plantTree } from "./trees.ts";
import { collect, meansYield } from "./animals.ts";
import { ARTICLE, besides, buildingHere, cells, freeCells, giveBack, human, lightFor, plural, putBack, refusal, releaseLight, SITE_REACH, takeNear, useLight, type Rect } from "./build.ts";
import { random, randomBytes, randomInt } from "../source.ts";
import { creditDeed } from "../deeds.ts";

const STAGES = ["Saat", "Keim", "reif", "welk"] as const;
export const garden = (c: CommandCtx): GardenDef => {
	const g = c.world.garden;
	if (!g) throw new CommandError("In dieser Welt wächst nichts in Beeten.");
	return g;
};
export const sortOf = (g: GardenDef, key: string): SortDef | undefined => g.sorts.find((s) => s.key === key);
export const protoName = (c: CommandCtx, key: string) => c.world.prototypes.find((p) => p.key === key)?.name ?? key;
const mine = (c: CommandCtx, b: BedFields) => b.accountId === c.account?.accountId;
/** The most plants one who did not dig a community bed takes from it at one harvest. */
const COMMONS_TAKE = 2;
/** Watering, weeding, harvesting: the owner, the sponsors, and everyone at a community bed. */
export const mayTend = (c: CommandCtx, b: BedFields) => b.kind === "gemein" || mine(c, b) || b.sponsors.some((s) => s.charId === c.actor.charId);
/** Planting: the owner, and at a community bed everyone with an account. */
const mayPlant = (c: CommandCtx, b: BedFields) => mine(c, b) || (b.kind === "gemein" && !!c.account && !c.account.guest);
export const bedName = (b: BedFields) => (b.kind === "gemein" ? "Gemeinschaftsbeet" : `${b.kind === "zier" ? "Zierbeet" : "Beet"} von ${b.ownerName}`);
/** What a plant is: its variety, else its sort (two plants of one sort but different varieties cross). */
const strain = (p: BedPlant) => p.variety?.id ?? p.sort;
const plantName = (g: GardenDef, p: BedPlant) => p.variety?.name || (p.variety ? `Kreuzung (${sortOf(g, p.sort)?.name ?? p.sort})` : sortOf(g, p.sort)?.name ?? p.sort);
const colorOf = (g: GardenDef, p: BedPlant) => p.variety?.color ?? sortOf(g, p.sort)?.color ?? "#7fae6a";
const hours = (ms: number) => { const h = Math.round(ms / 3600_000); return h >= 1 ? `${h} ${h === 1 ? "Stunde" : "Stunden"}` : `${Math.max(1, Math.round(ms / 60_000))} Minuten`; };

/** How much slower things grow: fog (0 to 3) and weeds. Taken when the bed is written anyway. */
export const growFactor = (fog: number, weedy: boolean) => (1 + 0.5 * Math.max(0, fog)) * (weedy ? 1.5 : 1);
export const nextDue = (plants: BedPlant[]) => plants.reduce((m, p) => Math.min(m, p.dueWorldMs), FOREVER);

/** The plants whose date has come move on (or wilt, dry or past their time); true when anything changed. Each plant that
 *  sprouts or ripens may bring weeds. */
export function advance(g: GardenDef, b: BedFields, now: number, fog: number, rnd: () => number = random, patient = 1, frozen: number | null = null): boolean {
	let changed = false;
	const weedy = b.weedy; // weeds of this round count from the next: plants that move on together keep one date
	for (const p of b.plants) {
		if (p.dueWorldMs > now) continue;
		changed = true;
		// winter: it stands still and is not lost; from the spring on it goes on, watered
		if (frozen !== null) { if (p.stage < 3) { p.dueWorldMs = frozen; b.wateredWorldMs = frozen; } continue; }
		const sort = sortOf(g, p.sort);
		if (!sort || p.stage >= 2 || now - b.wateredWorldMs > g.thirstWorldMs * patient) { p.stage = 3; p.dueWorldMs = FOREVER; continue; }
		p.stage = (p.stage + 1) as 1 | 2;
		p.dueWorldMs = now + (p.stage === 1 ? sort.grow[1] * growFactor(fog, weedy) : sort.ripeWorldMs * patient);
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

/** A bed within reach (`own`: one's own; `may`: one this figure may do something at), taken in the transaction. */
export async function bedHere(c: CommandCtx, o: { own?: boolean; may?: (b: BedFields) => boolean; reach?: number } = {}): Promise<BedFields> {
	const r = await takeNear<BedFields>(c, "Bed", "bedId", o.reach ?? SITE_REACH, (b) => (!o.own || mine(c, b)) && (!o.may || o.may(b)));
	if ("f" in r) return r.f;
	throw new NotUnderstood(r.far ? (o.own ? "Geh näher an dein Beet heran." : "Geh näher an das Beet heran (höchstens zwei Schritte entfernt).") : "Hier ist kein Beet. „umgraben“ legt eins an (mit einem Spaten).");
}
/** The bed one waters, weeds or harvests: one near that the actor may tend before any other, so one's own bed counts
 *  though a stranger's lies behind the figure too; with none such, the nearest bed (its command then says whose it is). */
const tendedBed = (c: CommandCtx): Promise<BedFields> => bedHere(c, { may: (b) => mayTend(c, b) }).catch((e) => { if (e instanceof NotUnderstood) return bedHere(c); throw e; });
export const writeBed = (c: CommandCtx, b: BedFields) => c.space.write({ type: "Bed", fields: b as never }, c.txn, FOREVER);
const describe = async (c: CommandCtx, g: GardenDef, b: BedFields, now: number) => {
	const count = new Map<string, number>();
	for (const p of b.plants) { const k = `${plantName(g, p)} (${STAGES[p.stage]})`; count.set(k, (count.get(k) ?? 0) + 1); }
	const plants = count.size ? [...count].map(([k, n]) => `${n}× ${k}`).join(", ") : "noch nichts gepflanzt";
	const ago = now - b.wateredWorldMs;
	// only what still grows needs water (a bed of wilted plants wants planting, todos.ts)
	const growing = b.plants.some((p) => p.stage < 2);
	const water = growing && ago > g.thirstWorldMs * 0.75 * (await patienceOf(c.space, c.txn)) ? "braucht Wasser" : `gegossen vor ${hours(ago)}`;
	return `${bedName(b)}${b.kind === "gemein" ? `, angelegt von ${b.ownerName}` : ""} (${b.w}×${b.h}): ${plants}; ${water}${b.weedy ? ", voller Unkraut" : ""}${b.sponsors.length ? `; Paten: ${b.sponsors.map((s) => s.name).join(", ")}` : ""}.`;
};

/** The word that names a kind of bed: a flower bed or a community bed (none: a garden bed). */
const KIND_WORD = /^(?:(zier(?:beet)?|blumen(?:beet)?|flowers?)|(gemeinschaft(?:sbeet)?|gemeinsam|gemein|community))(?:\s+|$)/i;

/** A bed goes back to grass: its cells, its light and, for a community bed, the fire's place for one. */
async function freeBed(space: SpaceLike, txn: string, b: BedFields): Promise<void> {
	await freeCells(space, txn, b.room, b.bedId);
	await releaseLight(space, txn, b.beaconId, b.points);
	if (b.kind === "gemein") await space.takeIfExists({ type: "BedCommons", fields: { bedId: b.bedId } }, 5_000, { txn });
}

/** `[zier|gemeinschaft] [x y]`: digs a garden bed, a flower bed or a community bed. */
async function dig(c: CommandCtx, arg: string): Promise<void> {
	const g = garden(c);
	const k = KIND_WORD.exec(arg.trim());
	const kind = k?.[1] ? "zier" as const : k?.[2] ? "gemein" as const : undefined;
	const at = k ? arg.trim().slice(k[0].length) : arg;
	const size = kind === "gemein" ? g.commons : g.bed;
	if (!c.account || c.account.guest) throw new CommandError("Gäste können als Pate gießen und ernten, aber kein eigenes Beet anlegen; registriere dich dafür.");
	if (!human(c)) throw new CommandError("Beete legen nur Menschen an.");
	await needRank(c, "siedler", "Beete anlegen");
	if (!(await inventory(c)).some((i) => i.f.proto === g.spade)) throw new CommandError(`Zum Umgraben brauchst du einen ${protoName(c, g.spade)} („craft ${protoName(c, g.spade).toLowerCase()}“).`);
	// a community bed is no one's: it does not count to the digger's beds
	if (kind !== "gemein" && (await c.space.count({ type: "Bed", fields: { accountId: c.account.accountId } })) - (await c.space.count({ type: "Bed", fields: { accountId: c.account.accountId, kind: "gemein" } })) >= g.maxBeds) throw new CommandError(`Mehr als ${g.maxBeds} Beete pflegt niemand (ein Gemeinschaftsbeet zählt nicht dazu).`);
	const light = await lightFor(c, size.points);
	if (typeof light === "string") throw new CommandError(light.replace("gebaut wird", "gegärtnert wird").replace("Bau", "Beet"));
	if (kind === "gemein" && (await peek(c.space, { type: "BedCommons", fields: { beaconId: light.beaconId } }))) throw new CommandError("Im Licht dieses Feuers liegt schon ein Gemeinschaftsbeet; pflanze dort mit („beet“ zeigt es).");
	const room = await roomOf(c);
	const m = /^(\d+)\s+(\d+)$/.exec(at.trim());
	const tries: Rect[] = m ? [{ x: Number(m[1]), y: Number(m[2]), w: size.w, h: size.h }] : besides(c, size);
	let rect: Rect | null = null, why = "";
	for (const r of tries) { const no = await refusal(c, room, r, true, true); if (!no) { rect = r; break; } why ||= no; }
	if (!rect) throw new CommandError(`Hier passt kein Beet hin: ${why}`);
	const bedId = `bed-${randomBytes(6).toString("hex")}`, now = await worldNowOf(c.space, c.txn);
	for (const p of cells(rect)) {
		try { await c.space.write({ type: "Plot", fields: { room: room.roomId, x: p.x, y: p.y, of: bedId } as never }, c.txn, FOREVER, { unique: ["room", "x", "y"] }); }
		catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Dort hat gerade jemand anderes umgegraben."); throw e; }
	}
	if (kind === "gemein") {
		// one per fire: `unique` on the fire, so two digging at once do not both get one
		try { await c.space.write({ type: "BedCommons", fields: { beaconId: light.beaconId, bedId } as never }, c.txn, FOREVER, { unique: ["beaconId"] }); }
		catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Im Licht dieses Feuers hat gerade jemand ein Gemeinschaftsbeet angelegt."); throw e; }
	}
	await useLight(c, light.beaconId, light.use, size.points, light.fresh);
	const b: BedFields = { ...(kind ? { kind } : {}), bedId, room: room.roomId, ...rect, owner: c.actor.charId, ownerName: c.actor.name, accountId: c.account.accountId, beaconId: light.beaconId, points: size.points,
		sponsors: [], plants: [], wateredWorldMs: now, weedy: false, dueWorldMs: FOREVER, untilWorldMs: (await decayNowOf(c.space, c.txn)) + g.bed.keepWorldMs, at: now };
	await writeBed(c, b);
	await msg(c, "*", "info", kind === "gemein" ? `${c.actor.name} legt ein Gemeinschaftsbeet an (${rect.w}×${rect.h}): pflanzen darf jeder mit Konto, gießen, jäten und ernten alle.`
		: kind === "zier" ? `${c.actor.name} gräbt ein Zierbeet um (${rect.w}×${rect.h}): nur Blumen wachsen darin, und nebeneinander kreuzen sie sich manchmal.`
		: `${c.actor.name} gräbt ein Beet um (${rect.w}×${rect.h}). „pflanze <samen>“ setzt etwas hinein.`);
}

const umgraben: Command = {
	key: "umgraben", aliases: ["umgrabe", "dig-bed"],
	help: "umgraben [zier|gemeinschaft] [x y] – mit einem Spaten neben dir ein Beet anlegen (im Licht eines Feuers): ein Gartenbeet, ein Zierbeet (nur Blumen, sie kreuzen sich) oder ein Gemeinschaftsbeet (3×3, eins je Feuer, für alle)",
	func: (c, arg) => dig(c, arg),
};

const beet: Command = {
	key: "beet", aliases: ["beete", "bed", "beds"],
	help: "beet – die Beete hier (beet anlegen [zier|gemeinschaft] [x y]: umgraben; beet aufgeben [ja x y]: dein Beet neben dir wieder zu Gras)",
	async func(c, arg) {
		const g = garden(c);
		const [word = "", ...rest] = arg.trim().split(/\s+/);
		if (/^(?:anlegen|neu|new|umgraben|\d+)$/i.test(word) || KIND_WORD.test(word)) return dig(c, /^\d+$/.test(word) || KIND_WORD.test(word) ? arg : rest.join(" "));
		if (/^(?:aufgeben|abreissen|abreißen|weg|remove)$/i.test(word)) {
			// „beet aufgeben ja x y“ (the map's menu): the one of one's beds on that cell, not just the nearest
			const [cx, cy] = [Number(rest[1]), Number(rest[2])], at = Number.isInteger(cx) && Number.isInteger(cy) && rest.length >= 3;
			// the operator (an admin) gives up anyone's bed beside it, a forsaken one in the way; its owner is told
			if (!c.account && c.loadAccount) { c.account = await c.loadAccount(); delete c.loadAccount; }
			const admin = levelOf(c.account) === "Admin";
			const b = await bedHere(c, { own: !admin, reach: 1, ...(at ? { may: (x: BedFields) => cx >= x.x && cy >= x.y && cx < x.x + x.w && cy < x.y + x.h } : {}) });
			// what grows in it is lost: asked first, „beet aufgeben ja“ does it (the map's menu asks on the page and sends that)
			if (!/^(?:ja|yes)$/i.test(rest[0] ?? "")) { await writeBed(c, b); return msg(c, c.actor.charId, "info", "Das Beet wirklich aufgeben? Was darin wächst, geht verloren, und dort wächst wieder Gras. „beet aufgeben ja“ gibt es auf."); }
			await freeBed(c.space, c.txn, b);
			if (b.owner !== c.actor.charId) await msg(c, b.owner, "info", `${c.actor.name} hat dein ${b.kind === "gemein" ? "Gemeinschaftsbeet" : b.kind === "zier" ? "Zierbeet" : "Beet"} in ${(await roomOf(c)).name} aufgelöst; dort wächst wieder Gras.`);
			return msg(c, "*", "info", `${c.actor.name} gibt das ${b.kind === "gemein" ? "Gemeinschaftsbeet" : b.kind === "zier" ? "Zierbeet" : "Beet"} auf; dort wächst wieder Gras.`);
		}
		// "beet ansehen x y": the one bed at that cell (the map's menu), else all of the room
		const [x, y] = /^(?:ansehen|look)$/i.test(word) ? rest.map(Number) : [];
		const one = (b: BedFields) => x === undefined || y === undefined || (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h);
		const beds = (await c.space.readAll({ type: "Bed", fields: { room: c.actor.room } })).map((e) => fieldsOf<BedFields>(e)).filter(one);
		if (!beds.length) return msg(c, c.actor.charId, "info", `Hier ist kein Beet. Mit einem ${protoName(c, g.spade)} legt „umgraben“ eins an.`);
		const now = await worldNowOf(c.space, c.txn);
		await msg(c, c.actor.charId, "look", (await Promise.all(beds.map((b) => describe(c, g, b, now)))).join("\n"));
	},
};

const pflanze: Command = {
	key: "pflanze", aliases: ["pflanz", "pflanzen", "säe", "säen", "saee", "sae", "plant", "sow", "setze-samen"],
	help: "pflanze [anzahl] <samen> [x y] – Samen in dein Beet oder ins Gemeinschaftsbeet neben dir setzen (bis zwei Schritte; eine Pflanze je Zelle; ins Zierbeet nur Blumen; z. B. pflanze 3 strandnelken). Korn, Kartoffeln, Rüben und Flachs wachsen auf dem Acker: „bestelle“. Der Samen eines Baums (Birkensamen, Weidensteckling, Apfelkerne, Birnenkerne, Eichel) kommt mit einem Spaten neben dich in die Erde",
	async func(c, arg) {
		// a tree's seed: a tree beside one (trees.ts)
		if (await plantTree(c, arg)) return;
		const g = garden(c);
		// "pflanze 3 strandnelken": that many of one kind, each in a free cell of the bed
		const counted = /^(\d+)\s+(.+)$/.exec(arg.trim()), want = counted ? Number(counted[1]) : 1;
		const m = /^(.+?)(?:\s+(\d+)\s+(\d+))?$/.exec((counted ? counted[2]! : arg).trim().replace(/\s+(?:in|ins)\s+(?:das\s+|mein\s+)?beet$/i, ""));
		if (!m || !m[1]) throw new NotUnderstood("Was pflanzt du? Zum Beispiel: pflanze strandnelke");
		if (want < 1) throw new CommandError("Wie viele? Zum Beispiel: pflanze 3 strandnelken");
		const seeds = (await inventory(c)).filter((i) => g.sorts.some((s) => s.seed === i.f.proto));
		// a sort's name means its plain seeds before a crossing of it, unless it is the crossing's own name
		const said = m[1].replace(ARTICLE, "").trim().toLowerCase(), hits = itemsNamed(c.world, seeds, said);
		const hit = hits.find((i) => !i.f.variety || [i.f.name, ...i.f.aliases].some((a) => a.toLowerCase() === said)) ?? hits[0];
		if (!hit && (await sowOnField(c, said))) return;
		if (!hit) throw new NotUnderstood(seeds.length ? `Du hast keinen Samen, der „${m[1].slice(0, 30)}“ heißt. Du trägst: ${[...new Set(seeds.map((s) => s.f.name))].join(", ")}.` : "Du trägst keine Samen. „sammle samen“ sucht welche in der wilden Flora.");
		const sort = g.sorts.find((s) => s.seed === hit.f.proto)!;
		const b = await bedHere(c, { may: (x) => mayPlant(c, x) }).catch(async (e) => {
			if (e instanceof NotUnderstood && c.account?.guest && (await c.space.count({ type: "Bed", fields: { room: c.actor.room, kind: "gemein" } }))) throw new CommandError("Gäste gießen, jäten und ernten am Gemeinschaftsbeet; pflanzen darf, wer sich registriert hat.");
			throw e;
		});
		if (b.kind === "zier" && sort.kind !== "zier") throw new CommandError(`Ins Zierbeet kommen nur Blumen; ${sort.name} gehört in ein Gartenbeet.`);
		const free = cells(b).filter((p) => !b.plants.some((q) => q.x === p.x && q.y === p.y));
		const first = m[2] !== undefined ? free.findIndex((p) => p.x === Number(m[2]) && p.y === Number(m[3])) : 0;
		if (first < 0 || !free.length) throw new CommandError(free.length ? "Diese Zelle gehört nicht zum Beet oder ist schon bepflanzt." : "Das Beet ist voll; ernte erst oder jäte das Welke aus.");
		// the named cell first, then the next free ones
		const targets = [...free.slice(first), ...free.slice(0, first)].slice(0, want);
		const same = hits.filter((i) => i.f.proto === hit.f.proto && (i.f.variety ?? "") === (hit.f.variety ?? ""));
		const label = want > 1 ? `${want} ${pluralOf(hit.f.name, c.world)}` : hit.f.name;
		if (same.length < want) throw new CommandError(`Du trägst nur ${same.length}× ${hit.f.name}.`);
		const bedWord = b.kind === "gemein" ? "Gemeinschaftsbeet" : b.kind === "zier" ? "Zierbeet" : "Beet";
		if (targets.length < want) throw new CommandError(targets.length === 1 ? `Im ${bedWord} ist nur eine Zelle frei, nicht genug für ${label}.` : `Im ${bedWord} sind nur ${targets.length} Zellen frei, nicht genug für ${label}.`);
		for (const seed of same.slice(0, want)) if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: seed.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Der Samen ist gerade nicht greifbar; bitte noch einmal.");
		const now = await worldNowOf(c.space, c.txn), factor = growFactor(await fogOf(c.space, b.room), b.weedy);
		for (const cell of targets) b.plants.push({ x: cell.x, y: cell.y, sort: sort.key, stage: 0, dueWorldMs: now + sort.grow[0] * factor, ...(hit.f.variety ? { variety: hit.f.variety } : {}) });
		// planting waters the seed
		b.wateredWorldMs = now;
		b.untilWorldMs = (await decayNowOf(c.space, c.txn)) + g.bed.keepWorldMs;
		b.dueWorldMs = nextDue(b.plants);
		await writeBed(c, b);
		if (b.kind === "gemein") await creditDeed(c, "beet");
		const what = hit.f.variety ? plantName(g, b.plants.at(-1)!) : sort.name;
		await msg(c, "*", "emote", `${c.actor.name} setzt ${want > 1 ? `${want} ${pluralOf(what, c.world)}` : what} ins ${bedWord}.`);
	},
};

const giesse: Command = {
	key: "gieße", aliases: ["giesse", "gießen", "giessen", "gieß", "giess", "gies", "water"],
	help: "gieße – ein Beet neben dir gießen: deins, eins als Pate oder das Gemeinschaftsbeet (braucht eine Kanne Wasser aus der Regentonne)",
	async func(c) {
		const g = garden(c);
		const can = (await inventory(c)).find((i) => i.f.proto === g.can);
		if (!can) throw new CommandError(`Du hast keine ${protoName(c, g.can)}. An einer Regentonne füllt „schöpfe“ eine.`);
		const b = await tendedBed(c);
		if (!mayTend(c, b)) throw new CommandError(`Das ist das ${bedName(b)}; gießen dürfen der Besitzer und seine Paten.`);
		if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: can.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Die Kanne ist gerade nicht greifbar; bitte noch einmal.");
		const now = await worldNowOf(c.space, c.txn);
		b.wateredWorldMs = now;
		b.untilWorldMs = (await decayNowOf(c.space, c.txn)) + g.bed.keepWorldMs;
		await writeBed(c, b);
		if (b.kind === "gemein") await creditDeed(c, "beet");
		await msg(c, "*", "emote", mine(c, b) ? `${c.actor.name} gießt das ${b.kind === "gemein" ? "Gemeinschaftsbeet" : "Beet"}.` : `${c.actor.name} gießt das ${bedName(b)}.`);
	},
};

const jaete: Command = {
	key: "jäte", aliases: ["jaete", "jäten", "jaeten", "jät", "jaet", "weed"],
	help: "jäte – Unkraut und Welkes aus einem Beet neben dir ziehen (deins, als Pate oder das Gemeinschaftsbeet)",
	async func(c) {
		const g = garden(c);
		const b = await tendedBed(c);
		if (!mayTend(c, b)) throw new CommandError(`Das ist das ${bedName(b)}; jäten dürfen der Besitzer und seine Paten.`);
		const wilted = b.plants.filter((p) => p.stage === 3).length;
		if (!b.weedy && !wilted) throw new CommandError("Das Beet ist sauber; hier gibt es nichts zu jäten.");
		const now = await worldNowOf(c.space, c.txn);
		b.weedy = false;
		b.plants = b.plants.filter((p) => p.stage !== 3);
		b.dueWorldMs = nextDue(b.plants);
		b.untilWorldMs = (await decayNowOf(c.space, c.txn)) + g.bed.keepWorldMs;
		await writeBed(c, b);
		if (b.kind === "gemein") await creditDeed(c, "beet");
		await msg(c, "*", "emote", `${c.actor.name} jätet das Beet${wilted ? ` und zieht ${plural(wilted, "welke Pflanze", "welke Pflanzen")} heraus` : ""}.`);
	},
};

/** The ripe flowers that cross at this harvest, each with the neighbour it crossed with: a flower with another strain
 *  beside it (not across a corner; a wilted one does not count) crosses at `crossChance`. */
export function crossings(g: GardenDef, b: BedFields, ripe: BedPlant[], rnd: () => number = random): Map<BedPlant, BedPlant> {
	const out = new Map<BedPlant, BedPlant>();
	for (const p of ripe) {
		if (sortOf(g, p.sort)?.kind !== "zier") continue;
		const beside = b.plants.filter((q) => q !== p && q.stage < 3 && sortOf(g, q.sort)?.kind === "zier" && Math.abs(q.x - p.x) + Math.abs(q.y - p.y) === 1 && strain(q) !== strain(p));
		if (beside.length && rnd() < g.crossChance) out.set(p, beside[Math.floor(rnd() * beside.length) % beside.length]!);
	}
	return out;
}
/** Between two colours, a little off to one side, so two crossings of the same pair differ. */
export function mixColor(a: string, b: string, rnd: () => number = random): string {
	const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16) || 0;
	return `#${[0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round((ch(a, i) + ch(b, i)) / 2 + (rnd() - 0.5) * 48))).toString(16).padStart(2, "0")).join("")}`;
}
/** A variety named after its plant was set gets its name at the harvest (one read per unnamed variety in the bed). */
async function namesOf(c: CommandCtx, plants: BedPlant[]): Promise<void> {
	for (const id of new Set(plants.filter((p) => p.variety && !p.variety.name).map((p) => p.variety!.id))) {
		const e = await peek(c.space, { type: "Variety", fields: { varietyId: id } });
		if (e) for (const p of plants) if (p.variety?.id === id) p.variety = { ...p.variety, name: fieldsOf<VarietyFields>(e).name };
	}
}
/** What a thing of a variety is called and looks like: "Abendrot" and "Abendrot-Samen", or before it has a name "Kreuzungssamen". */
function varietyOwn(proto: { name: string; aliases: string[]; desc: string; glyph: ItemFields["glyph"] }, v: Variety, seed: boolean): Partial<ItemFields> {
	const n = v.name.toLowerCase();
	return {
		name: v.name ? (seed ? `${v.name}-Samen` : v.name) : seed ? "Kreuzungssamen" : proto.name,
		aliases: v.name ? (seed ? [`${n}-samen`, `${n}samen`, n] : [n]) : seed ? ["kreuzung", "kreuzungssamen"] : proto.aliases,
		desc: seed ? `Samen einer Kreuzung${v.name ? ` namens ${v.name}` : ""}, gezogen von ${v.breederName}. ${proto.desc}` : `${proto.desc} Eine Züchtung von ${v.breederName}.`,
		glyph: { ...proto.glyph, color: v.color }, variety: v,
	};
}
/** Like giveBack, and a thing of a variety keeps it (its name, colour, breeder). */
async function giveOwn(c: CommandCtx, what: Array<{ proto: string; count: number; variety?: Variety }>): Promise<string[]> {
	const sum = new Map<string, { proto: string; count: number; variety?: Variety }>();
	for (const x of what) { const k = `${x.proto}|${x.variety?.id ?? ""}`; sum.set(k, { ...x, count: (sum.get(k)?.count ?? 0) + x.count }); }
	const out: string[] = [];
	for (const x of sum.values()) {
		if (x.count <= 0) continue;
		if (!x.variety) { out.push(...(await giveBack(c, [x]))); continue; }
		const p = await resolvePrototype(c.space, x.proto);
		if (!p) continue;
		const own = varietyOwn(p, x.variety, garden(c).sorts.some((s) => s.seed === x.proto));
		for (let i = 0; i < x.count; i++) await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 }, own);
		out.push(`${x.count} ${own.name}`);
	}
	return out;
}

const ernte: Command = {
	key: "ernte", aliases: ["ernten", "pflücke", "pfluecke", "harvest"],
	help: "ernte – was in einem Beet neben dir reif ist, in deine Tasche (deins, als Pate oder vom Gemeinschaftsbeet ein Teil; dazu gibt es Samen); an einem reifen Acker (ernte flur, wenn auch ein Beet nah ist) ein Arbeitspunkt der Ernte und dein Anteil; an deinem Baum (ernte baum) sein Obst, seine Eicheln oder Ruten",
	async func(c, arg) {
		const g = garden(c);
		if (/^(?:die\s+|der\s+|das\s+)?(?:flur|acker|feld|field)$/i.test(arg.trim())) {
			if (await harvestField(c)) return;
			throw new NotUnderstood("Hier ist kein Acker. „flur anlegen“ legt eine an (mit einem Spaten, im Licht eines Feuers).");
		}
		// a tree named: its crop (trees.ts)
		if (meansTree(c.world, arg) && (await harvestTree(c, true))) return;
		// no bed near, but a field or a tree that bears: its harvest (field.ts, trees.ts)
		const b = await tendedBed(c).catch(async (e) => { if (e instanceof NotUnderstood && ((await harvestField(c)) || (await harvestTree(c, false)))) return null; throw e; });
		if (!b) return;
		if (!mayTend(c, b)) throw new CommandError(`Das ist das ${bedName(b)}; ernten dürfen der Besitzer und seine Paten.`);
		const allRipe = b.plants.filter((p) => p.stage === 2);
		if (!allRipe.length) throw new CommandError("Im Beet ist noch nichts reif.");
		// a community bed is shared: one harvest takes a part, the rest stays for the others (its digger at most two thirds,
		// anyone else at most half and at most two plants; a single ripe plant may be taken)
		const share = b.kind !== "gemein" ? allRipe.length : mine(c, b) ? Math.max(1, Math.floor((allRipe.length * 2) / 3)) : Math.min(COMMONS_TAKE, Math.max(1, Math.floor(allRipe.length / 2)));
		const ripe = allRipe.slice(0, share), left = allRipe.length - ripe.length;
		const now = await worldNowOf(c.space, c.txn);
		await namesOf(c, ripe);
		const crossed = b.kind === "zier" ? crossings(g, b, ripe) : new Map<BedPlant, BedPlant>();
		const got: Array<{ proto: string; count: number; variety?: Variety }> = [], news: string[] = [];
		for (const p of ripe) {
			const sort = sortOf(g, p.sort);
			if (!sort) continue;
			const seeds = 1 + (randomInt(0, 10) < 3 ? 1 : 0), other = crossed.get(p);
			got.push({ ...sort.yields, ...(p.variety ? { variety: p.variety } : {}) }, { proto: sort.seed, count: other ? seeds - 1 : seeds, ...(p.variety ? { variety: p.variety } : {}) });
			if (other) {
				got.push({ proto: sort.seed, count: 1, variety: { id: `var-${randomBytes(6).toString("hex")}`, name: "", color: mixColor(colorOf(g, p), colorOf(g, other)), breeder: c.actor.charId, breederName: c.actor.name } });
				news.push(`${plantName(g, p)} und ${plantName(g, other)}`);
			}
		}
		const names = await giveOwn(c, got);
		const taken = new Set(ripe);
		b.plants = b.plants.filter((p) => !taken.has(p));
		b.dueWorldMs = nextDue(b.plants);
		b.untilWorldMs = (await decayNowOf(c.space, c.txn)) + g.bed.keepWorldMs;
		await writeBed(c, b);
		if (b.kind === "gemein") await creditDeed(c, "beet");
		await msg(c, "*", "emote", `${c.actor.name} erntet ${mine(c, b) && b.kind !== "gemein" ? `das ${b.kind === "zier" ? "Zierbeet" : "Beet"}` : `das ${bedName(b)}`}: ${names.join(", ")}.`);
		if (left) await msg(c, c.actor.charId, "info", `Am Gemeinschaftsbeet nimmt jeder nur einen Teil: ${left === 1 ? "eine reife Pflanze bleibt" : `${left} reife Pflanzen bleiben`} für die anderen.`);
		if (news.length) await msg(c, c.actor.charId, "info", `Unter den Samen ${news.length === 1 ? "ist eine Kreuzung" : "sind Kreuzungen"} aus ${news.join("; aus ")}! Was daraus wächst, hat eine eigene Farbe; „benenne <name>“ gibt der neuen Sorte einen Namen.`);
	},
};

const pate: Command = {
	key: "pate", aliases: ["paten", "patin", "sponsor"],
	help: "pate <name> – jemanden dein Beet neben dir gießen, jäten und ernten lassen (pate weg <name> beendet es; pate allein: wer es darf)",
	async func(c, arg) {
		const [first = "", ...rest] = arg.trim().split(/\s+/);
		const remove = /^(?:weg|ende|kündige|kuendige|stop|remove)$/i.test(first);
		const name = (remove ? rest.join(" ") : arg).trim();
		const b = await bedHere(c, { own: true, may: (x) => x.kind !== "gemein", reach: SITE_REACH });
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
	help: "sammle samen – in der wilden Flora hier nach Samen suchen (findet nicht immer etwas; an dieser Stelle danach eine kurze Pause)",
	async func(c, arg) {
		// "sammle eier": what the animals gave (animals.ts)
		if (meansYield(c, arg)) return collect(c, arg);
		const g = garden(c);
		if (arg.trim() && !/^(?:samen|seeds?|saatgut)$/i.test(arg.trim().replace(ARTICLE, ""))) throw new NotUnderstood("Gesammelt werden hier Samen („sammle samen“) und im Stall, was die Tiere geben („sammle eier“); Dinge am Strand hebst du mit „get“ auf.");
		const now = await worldNowOf(c.space, c.txn);
		const rest = await peek(c.space, { type: "SeedRest", fields: { charId: c.actor.charId, room: c.actor.room } });
		const until = rest ? fieldsOf<SeedRestFields>(rest).untilWorldMs : 0;
		if (until > now) throw new CommandError(`Du hast hier eben erst gesucht; in etwa ${hours(until - now)} wieder.`);
		const room = c.world.rooms.find((r) => r.roomId === c.actor.room);
		const decor = new Set((room?.decor ?? []).join(""));
		const grows = (s: Pick<SortDef, "wild">) => !!s.wild && g.decor[s.wild.decor].some((k) => decor.has(k)) && (!s.wild.islands || s.wild.islands.includes(room?.island ?? ""));
		// the wild flora gives seeds of garden sorts and of field crops (wild barley, flax, beet), the wild trees theirs
		const t = c.world.trees, woods = !!t && t.decor.some((k) => decor.has(k));
		const wild: Array<{ seed: string }> = [...[...g.sorts, ...(c.world.fields?.crops ?? [])].filter(grows), ...(woods ? t!.sorts.filter((s) => !!s.wild && (!s.wild.islands || s.wild.islands.includes(room?.island ?? ""))) : [])];
		if (!wild.length) throw new CommandError("Hier wächst nichts Wildes, das Samen trägt.");
		if (rest) await c.space.takeIfExists({ id: rest.id }, NO_WAIT, { txn: c.txn });
		await c.space.write({ type: "SeedRest", fields: { charId: c.actor.charId, room: c.actor.room, untilWorldMs: now + g.seedRestWorldMs } satisfies SeedRestFields as never }, c.txn, FOREVER);
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

/** A name a variety may have: letters (a space, a hyphen or an apostrophe between them), and nothing the world or the
 *  commands already mean, so "give Kohl" never finds a flower someone named Kohl. */
async function nameRefused(c: CommandCtx, name: string): Promise<string | null> {
	if (name.length < 3 || name.length > 24 || !/^\p{L}[\p{L}' -]*\p{L}$/u.test(name)) return "Ein Sortenname hat 3 bis 24 Buchstaben (Leerzeichen und Bindestrich dazwischen gehen).";
	const n = name.toLowerCase(), g = garden(c);
	const taken = [...c.world.prototypes.flatMap((p) => [p.key, p.name, ...p.aliases]), ...g.sorts.flatMap((s) => [s.key, s.name, ...s.aliases]), ...(c.world.fields?.crops ?? []).flatMap((s) => [s.key, s.name, ...s.aliases]), "kreuzung", "kreuzungssamen", "samen"];
	if (taken.some((t) => t.toLowerCase() === n)) return `„${name}“ heißt schon etwas in dieser Welt; wähle einen eigenen Namen.`;
	const { commandsOf } = await import("../commands.ts");
	if ((await commandsOf(c)).has(n) || (await commandsOf(c)).has(n.split(/\s+/)[0]!)) return `„${name}“ ist ein Befehl; wähle einen anderen Namen.`;
	return null;
}

const benenne: Command = {
	key: "benenne", aliases: ["benennen", "taufe", "name-variety"],
	help: "benenne [nr] <name> – deiner Kreuzung einen Namen geben (nur wer sie gezogen hat, nur einmal; ihre Samen trägst du bei dir; die Tasche wählt sie mit #<id>)",
	async func(c, arg) {
		garden(c);
		const m = /^(?:(?:#(\S+)|(\d+))\s+)?(.+)$/.exec(arg.trim().replace(/^(?:die\s+)?(?:kreuzung|sorte)\s+(?:als\s+)?/i, ""));
		if (!m) throw new NotUnderstood("Wie soll die neue Sorte heißen? Zum Beispiel: benenne Abendrot");
		const held = (await inventory(c)).filter((i) => i.f.variety && !i.f.variety.name && i.f.variety.breeder === c.actor.charId);
		const ids = [...new Set(held.map((i) => i.f.variety!.id))];
		if (!ids.length) throw new CommandError("Du trägst keine unbenannte Kreuzung, die du gezogen hast. Kreuzungen entstehen im Zierbeet, wenn verschiedene Blumen nebeneinander reifen.");
		const sortOfSeed = (id: string) => garden(c).sorts.find((s) => held.some((i) => i.f.variety!.id === id && (i.f.proto === s.seed || i.f.proto === s.yields.proto)))?.name ?? "?";
		if (ids.length > 1 && !m[1] && !m[2]) throw new NotUnderstood(`Du trägst mehrere Kreuzungen; welche? ${ids.map((id, i) => `${i + 1}: aus ${sortOfSeed(id)} (${held.find((x) => x.f.variety!.id === id)!.f.variety!.color})`).join(", ")}. Zum Beispiel: benenne 1 ${m[3]!.slice(0, 24)}`);
		// the pack names one by its id (a number counts in the order the server lists them)
		const id = m[1] ? ids.find((x) => x === m[1]) : ids[m[2] ? Number(m[2]) - 1 : 0];
		if (!id) throw new NotUnderstood(m[1] ? "Diese Kreuzung trägst du nicht, oder sie ist nicht deine." : `So viele Kreuzungen trägst du nicht (${ids.length}).`);
		const name = m[3]!.trim().replace(/\s+/g, " ").replace(/^\p{Ll}/u, (x) => x.toUpperCase());
		const no = await nameRefused(c, name);
		if (no) throw new CommandError(no);
		if (await peek(c.space, { type: "Variety", fields: { varietyId: id } })) throw new CommandError("Diese Kreuzung hat schon einen Namen.");
		const v0 = held.find((i) => i.f.variety!.id === id)!.f.variety!, v: Variety = { ...v0, name };
		const sort = garden(c).sorts.find((s) => held.some((i) => i.f.variety!.id === id && (i.f.proto === s.seed || i.f.proto === s.yields.proto)));
		try {
			await c.space.write({ type: "Variety", fields: { varietyId: id, name, nameKey: name.toLowerCase(), sort: sort?.key ?? "", color: v.color, breeder: v.breeder, breederName: v.breederName, at: await worldNowOf(c.space, c.txn) } satisfies VarietyFields as never }, c.txn, FOREVER, { unique: ["nameKey"] });
		} catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError(`Eine Sorte namens „${name}“ gibt es schon; wähle einen anderen Namen.`); throw e; }
		// what one carries of it takes the name now; plants of it in beds take it at their harvest
		for (const i of held.filter((x) => x.f.variety!.id === id)) {
			const p = await resolvePrototype(c.space, i.f.proto);
			if (!p || !(await c.space.takeIfExists({ type: "Item", fields: { itemId: i.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) continue;
			await c.space.write({ type: i.e.type, types: i.e.types, fields: { ...i.f, ...varietyOwn(p, v, garden(c).sorts.some((s) => s.seed === i.f.proto)) } as never }, c.txn, FOREVER);
		}
		await msg(c, "*", "info", `${c.actor.name} nennt die neue Sorte aus ${sort?.name ?? "dem Zierbeet"} „${name}“.`);
	},
};

export const GARDEN_COMMANDS: Command[] = [beet, umgraben, pflanze, giesse, jaete, ernte, pate, sammle, schoepfe, benenne];

/** The garden's recurring job (engine/worldevents.ts, "garden"): beds whose date has come move their plants on, each in a
 *  transaction of its own (one held by a command right now is left for the next round); a bed nobody tended for its time
 *  goes back to grass and gives its light back; seed rests that are over go. Writes nothing when no date has come. */
export async function gardenTick(space: SpaceLike, w: WorldDef): Promise<number> {
	const g = w.garden;
	if (!g) return 0;
	const now = await worldNowOf(space), kept = await decayNowOf(space), patient = await patienceOf(space), winter = await frozenUntil(space, now), glass = g.greenhouse;
	const houses = winter === null || !glass ? [] : (await space.readAll({ type: "Building", fields: { plan: glass.plan } })).map((e) => fieldsOf<BuildingFields>(e));
	let written = 0;
	for (const e of await space.readAll({ type: "Bed" })) {
		const b = fieldsOf<BedFields>(e);
		if (b.dueWorldMs > now && b.untilWorldMs > kept) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Bed", fields: { bedId: b.bedId } }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			const bed = fieldsOf<BedFields>(t);
			if (bed.dueWorldMs > now && bed.untilWorldMs > kept) { await space.abort(txn); continue; } // the read was older: done already
			if (bed.untilWorldMs <= kept) await freeBed(space, txn, bed);
			else {
				advance(g, bed, now, await fogOf(space, bed.room), random, patient, houses.some((h) => h.room === bed.room && Math.max(h.x - (bed.x + bed.w - 1), bed.x - (h.x + h.w - 1), h.y - (bed.y + bed.h - 1), bed.y - (h.y + h.h - 1)) <= glass!.reach) ? null : winter);
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
export const bedPlantsView = (w: WorldDef, b: BedFields) => b.plants.map((p) => ({ x: p.x - b.x, y: p.y - b.y, stage: p.stage, color: p.variety?.color ?? w.garden?.sorts.find((s) => s.key === p.sort)?.color ?? "#7fae6a", model: w.garden?.sorts.find((s) => s.key === p.sort)?.model }));
