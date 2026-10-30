// Fields, step 3 part 1 (docs/siedeln.md "Äcker und Getreide"): the big sister of the beds. A field is one entry over a
// larger area (its cells are Plot entries like a building's), carries one crop at a time, and needs little daily care
// but two bursts of work: sowing (`bestelle`: seed and work points) and the harvest in its window (`ernte` at the field:
// a work point each, ten hands bring in in an hour what one needs a day for).
//
// - Every work point is counted on the Field entry taken in the command's transaction, as on a building site: ten at once
//   bring a field in exactly once. Each harvest point hands its worker a share of the whole yield, fixed when the sowing
//   was done; the shares add up to the yield exactly, and the last point turns the field fallow.
// - Crop rotation: the same crop group twice in a row tires the soil (less yield), a different group or a rest heals it.
//   The counter stands on the field.
// - The field tick (in the garden job) writes a field only when its date comes: it ripens, its window passes (each share
//   then loses a part), the crop is lost; and a field nobody worked for its time goes back to grass.
import { needEpoch } from "./epoch.ts";
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type FieldFields, type WorkRestFields } from "../../model.ts";
import { peek } from "../../space.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { fogOf } from "../fire.ts";
import type { CropDef, FieldDef, WorldDef } from "../world.ts";
import { ARTICLE, besides, cells, freeCells, giveBack, human, lightFor, plural, refusal, releaseLight, SITE_REACH, takeNear, useLight, type Rect } from "./build.ts";
import { growFactor } from "./garden.ts";

const STAGE: Record<FieldFields["stage"], string> = { brach: "brach", saat: "wird bestellt", waechst: "wächst", reif: "reif", spaet: "überreif" };
const fieldDef = (c: CommandCtx): FieldDef => {
	const d = c.world.fields;
	if (!d) throw new CommandError("In dieser Welt gibt es keine Äcker.");
	return d;
};
export const cropOf = (d: FieldDef, key: string | null): CropDef | undefined => d.crops.find((x) => x.key === key);
const cropNamed = (d: FieldDef, said: string): CropDef | undefined => {
	const n = said.trim().toLowerCase().replace(ARTICLE, "");
	return d.crops.find((x) => x.key === n || x.name.toLowerCase() === n || x.aliases.includes(n));
};
export const fieldName = (f: FieldFields) => `Flur von ${f.ownerName}`;
const mine = (c: CommandCtx, f: FieldFields) => f.accountId === c.account?.accountId;
/** Sowing and harvesting: the owner, or everyone on a field the owner opened. */
const mayWork = (c: CommandCtx, f: FieldFields) => mine(c, f) || !!f.open;
const hours = (ms: number) => { const h = Math.round(ms / 3600_000); return h >= 1 ? `${h} ${h === 1 ? "Stunde" : "Stunden"}` : `${Math.max(1, Math.round(ms / 60_000))} Minuten`; };

/** The soil for a crop sown now: how often its group came before in a row (a rest of `fallowWorldMs` since the last
 *  harvest heals it) and the yield's factor. */
export function soilFor(d: FieldDef, f: Pick<FieldFields, "lastGroup" | "tired" | "lastHarvestWorldMs">, crop: CropDef, now: number): { tired: number; factor: number } {
	const tired = f.lastGroup === crop.group && now - f.lastHarvestWorldMs < d.fallowWorldMs ? f.tired + 1 : 0;
	return { tired, factor: d.tired[Math.min(tired, d.tired.length - 1)] ?? 1 };
}
/** What the whole harvest gives: per yield the cells times its count per cell times the soil's factor. */
export const harvestOf = (crop: CropDef, cellCount: number, factor: number) => crop.yields.map((y) => ({ proto: y.proto, count: Math.floor(cellCount * y.perCell * factor) }));
/** The share of work point `i` (0-based) of `need`: the shares of all points add up to `total` exactly. */
export const shareOf = (total: number, need: number, i: number) => Math.floor((total * (i + 1)) / need) - Math.floor((total * i) / need);

/** The field within SITE_REACH of the actor, taken in the transaction; null when there is none near. */
async function fieldNear(c: CommandCtx): Promise<FieldFields | null> {
	const r = await takeNear<FieldFields>(c, "Field", "fieldId", SITE_REACH);
	if ("f" in r) return r.f;
	if (r.far) throw new NotUnderstood("Geh näher an die Flur heran (höchstens zwei Schritte entfernt).");
	return null;
}
async function fieldHere(c: CommandCtx): Promise<FieldFields> {
	const f = await fieldNear(c);
	if (!f) throw new NotUnderstood("Hier ist keine Flur. „flur anlegen“ legt eine an (mit einem Spaten, im Licht eines Feuers).");
	return f;
}
const writeField = (c: CommandCtx, f: FieldFields) => c.space.write({ type: "Field", fields: f as never }, c.txn, FOREVER);

/** A work point costs the figure a rest, the same as at a site (one body, one tiredness); throws while it rests. */
async function tire(c: CommandCtx, now: number): Promise<void> {
	const rest = await peek(c.space, { type: "WorkRest", fields: { charId: c.actor.charId } });
	const until = rest ? fieldsOf<WorkRestFields>(rest).untilWorldMs : 0;
	if (until > now) throw new CommandError(`Du bist noch müde von der letzten Arbeit; in etwa ${Math.max(1, Math.round((until - now) / 60_000))} Minuten wieder.`);
	if (rest) await c.space.takeIfExists({ id: rest.id }, NO_WAIT, { txn: c.txn });
	await c.space.write({ type: "WorkRest", fields: { charId: c.actor.charId, untilWorldMs: now + (c.world.building?.restWorldMs ?? 3600_000) } satisfies WorkRestFields as never }, c.txn, FOREVER);
}
/** Counts a work point; NPCs and automata may give at most half of them, as at a site. */
function credit(c: CommandCtx, f: FieldFields): void {
	if (!human(c)) {
		if (f.other >= Math.floor(f.workNeed / 2)) throw new CommandError("Diese Flur bestellen Menschen; Helfer haben ihren Teil schon getan.");
		f.other++;
	} else f.human++;
	f.by = { ...f.by, [c.actor.name]: (f.by[c.actor.name] ?? 0) + 1 };
}
const fresh = (f: FieldFields): FieldFields => ({ ...f, work: 0, workNeed: 0, human: 0, other: 0, by: {} });

const describe = (d: FieldDef, f: FieldFields, now: number) => {
	const crop = cropOf(d, f.crop);
	const soil = f.lastGroup && f.tired > 0 ? `; der Boden ist müde (${f.tired + 1}× ${f.lastGroup} hintereinander)` : f.lastGroup ? `; zuletzt ${f.lastGroup}` : "";
	const what = f.stage === "brach" ? "liegt brach"
		: f.stage === "saat" ? `wird mit ${crop?.name ?? f.crop} bestellt: ${f.seeds}/${f.seedNeed} Saatgut, ${f.work}/${f.workNeed} Arbeit`
		: f.stage === "waechst" ? `${crop?.name ?? f.crop} wächst, reif in etwa ${hours(f.dueWorldMs - now)}`
		: `${crop?.name ?? f.crop} ist ${STAGE[f.stage]}: Ernte ${f.work}/${f.workNeed}${f.stage === "spaet" ? ", jeder Anteil verliert schon" : `, noch etwa ${hours(f.dueWorldMs - now)}`}`;
	const grazed = f.grazed && f.stage !== "brach" ? `; Rehe haben daran gefressen (${f.grazed}×)` : "";
	return `${fieldName(f)} (${f.w}×${f.h}${f.open ? ", offen für alle" : ""}${f.fenced ? ", eingezäunt" : ""}): ${what}${soil}${grazed}.`;
};

/** `[x y]`: a field beside the actor (or at x y), on Plot cells in the light of a fire. */
async function stake(c: CommandCtx, at: string): Promise<void> {
	const d = fieldDef(c), g = c.world.garden;
	if (!c.account || c.account.guest) throw new CommandError("Gäste helfen auf offenen Fluren mit, legen aber keine an; registriere dich dafür.");
	if (!human(c)) throw new CommandError("Fluren legen nur Menschen an.");
	await needEpoch(c, d.epoch, "Eine neue Flur");
	if (g && !(await inventory(c)).some((i) => i.f.proto === g.spade)) throw new CommandError(`Eine Flur bricht man mit einem Spaten um („craft ${c.world.prototypes.find((p) => p.key === g.spade)?.name.toLowerCase() ?? g.spade}“).`);
	if ((await c.space.count({ type: "Field", fields: { accountId: c.account.accountId } })) >= d.maxFields) throw new CommandError(`Mehr als ${plural(d.maxFields, "Flur", "Fluren")} bestellt niemand allein.`);
	const light = await lightFor(c, d.points);
	if (typeof light === "string") throw new CommandError(light.replace("gebaut wird", "gepflügt wird").replace("Bau", "Acker"));
	const room = await roomOf(c);
	const m = /^(\d+)\s+(\d+)$/.exec(at.trim());
	const tries: Rect[] = m ? [{ x: Number(m[1]), y: Number(m[2]), w: d.w, h: d.h }] : besides(c, d);
	let rect: Rect | null = null, why = "";
	for (const r of tries) { const no = await refusal(c, room, r); if (!no) { rect = r; break; } why ||= no; }
	if (!rect) throw new CommandError(`Hier passt keine Flur hin (${d.w}×${d.h}): ${why}`);
	const fieldId = `field-${randomBytes(6).toString("hex")}`, now = await worldNowOf(c.space, c.txn);
	for (const p of cells(rect)) {
		try { await c.space.write({ type: "Plot", fields: { room: room.roomId, x: p.x, y: p.y, of: fieldId } as never }, c.txn, FOREVER, { unique: ["room", "x", "y"] }); }
		catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Dort hat gerade jemand anderes umgebrochen."); throw e; }
	}
	await useLight(c, light.beaconId, light.use, d.points, light.fresh);
	const f: FieldFields = { fieldId, room: room.roomId, ...rect, owner: c.actor.charId, ownerName: c.actor.name, accountId: c.account.accountId, beaconId: light.beaconId, points: d.points,
		stage: "brach", crop: null, seeds: 0, seedNeed: 0, work: 0, workNeed: 0, yields: [], soil: 1, by: {}, human: 0, other: 0, lastGroup: null, tired: 0, lastHarvestWorldMs: 0,
		dueWorldMs: FOREVER, untilWorldMs: now + d.keepWorldMs, at: now };
	await writeField(c, f);
	await msg(c, "*", "info", `${c.actor.name} bricht eine Flur um (${rect.w}×${rect.h}). „bestelle <frucht>“ sät darauf: ${d.crops.map((x) => x.name).join(", ")}.`);
}

const flur: Command = {
	key: "flur", aliases: ["fluren", "acker", "äcker", "aecker", "field", "fields"],
	help: "flur – die Fluren hier (flur anlegen [x y]: mit einem Spaten eine Flur umbrechen; flur offen / flur zu: alle mitsäen und -ernten lassen oder nicht; flur aufgeben)",
	async func(c, arg) {
		const d = fieldDef(c);
		const [word = "", ...rest] = arg.trim().split(/\s+/);
		if (/^(?:anlegen|neu|new|umbrechen|\d+)$/i.test(word)) return stake(c, /^\d+$/.test(word) ? arg : rest.join(" "));
		if (/^(?:offen|öffnen|oeffnen|open|zu|schließen|schliessen|close)$/i.test(word)) {
			const f = await fieldHere(c);
			if (!mine(c, f)) throw new CommandError(`Das ist die ${fieldName(f)}; öffnen und schließen darf nur, wer sie angelegt hat.`);
			const open = /^(?:offen|öffnen|oeffnen|open)$/i.test(word);
			const g = { ...f };
			if (open) g.open = true; else delete g.open;
			await writeField(c, g);
			return msg(c, "*", "info", open ? `${c.actor.name} öffnet die Flur: säen und ernten darf jetzt jeder, und jeder behält seinen Anteil.` : `${c.actor.name} schließt die Flur wieder für Fremde.`);
		}
		if (/^(?:aufgeben|weg|remove)$/i.test(word)) {
			const f = await fieldHere(c);
			if (!mine(c, f)) throw new CommandError(`Das ist die ${fieldName(f)}; aufgeben kann sie nur, wer sie angelegt hat.`);
			await freeCells(c.space, c.txn, f.room, f.fieldId);
			await releaseLight(c.space, c.txn, f.beaconId, f.points);
			return msg(c, "*", "info", `${c.actor.name} gibt die Flur auf; dort wächst wieder Gras.`);
		}
		const all = (await c.space.readAll({ type: "Field", fields: { room: c.actor.room } })).map((e) => fieldsOf<FieldFields>(e));
		if (!all.length) return msg(c, c.actor.charId, "info", "Hier ist keine Flur. Mit einem Spaten bricht „flur anlegen“ eine um (im Licht eines Feuers).");
		const now = await worldNowOf(c.space, c.txn);
		await msg(c, c.actor.charId, "look", all.map((f) => describe(d, f, now)).join("\n"));
	},
};

const bestelle: Command = {
	key: "bestelle", aliases: ["bestellen", "pflüge", "pfluege", "pflügen", "pfluegen", "plough", "plow"],
	help: "bestelle [frucht] – die Flur neben dir bestellen: wer sie angelegt hat, wählt die Frucht; dann bringt jeder Saatgut und einen Arbeitspunkt (danach ruhst du eine Weile)",
	async func(c, arg) {
		const d = fieldDef(c);
		const said = arg.trim().replace(/^(?:mit\s+)?/i, "");
		const f = await fieldHere(c);
		if (!mayWork(c, f)) throw new CommandError(`Das ist die ${fieldName(f)}; bestellen darf sie, wer sie angelegt hat (oder jeder, wenn sie offen ist).`);
		const now = await worldNowOf(c.space, c.txn);
		if (f.stage === "brach") {
			if (!mine(c, f)) throw new CommandError("Was auf der Flur wächst, wählt, wer sie angelegt hat.");
			const crop = said ? cropNamed(d, said) : undefined;
			if (!crop) throw new NotUnderstood(`Was säst du? ${d.crops.map((x) => `${x.name} (Saatgut: ${c.world.prototypes.find((p) => p.key === x.seed)?.name ?? x.seed})`).join(", ")}. Zum Beispiel: bestelle ${d.crops[0]?.name.toLowerCase() ?? ""}`);
			const n = f.w * f.h;
			Object.assign(f, { ...fresh(f), stage: "saat", crop: crop.key, seeds: 0, seedNeed: Math.ceil(n / d.seedPerCells), workNeed: Math.ceil(n / d.sowPerCells) });
		} else if (f.stage !== "saat") throw new CommandError(f.stage === "waechst" ? `Auf der Flur wächst schon ${cropOf(d, f.crop)?.name ?? f.crop}.` : `Die Flur ist ${STAGE[f.stage]}; jetzt wird geerntet („ernte“).`);
		else if (said && cropNamed(d, said)?.key !== f.crop) throw new CommandError(`Die Flur wird schon mit ${cropOf(d, f.crop)?.name ?? f.crop} bestellt.`);
		const crop = cropOf(d, f.crop)!;
		// seed: what one carries of it, up to what is still missing
		const seed = (await inventory(c)).filter((i) => i.f.proto === crop.seed && !i.f.variety).slice(0, Math.max(0, f.seedNeed - f.seeds));
		for (const it of seed) if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${it.f.name} ist gerade nicht greifbar; bitte noch einmal.`);
		f.seeds += seed.length;
		// a work point, unless the figure rests (bringing seed needs no rest)
		let worked = false;
		if (f.work < f.workNeed) {
			try { await tire(c, now); credit(c, f); f.work++; worked = true; }
			catch (e) { if (!seed.length || !(e instanceof CommandError)) throw e; }
		}
		const seedName = c.world.prototypes.find((p) => p.key === crop.seed)?.name ?? crop.seed;
		if (!seed.length && !worked) throw new CommandError(f.seeds < f.seedNeed ? `Es fehlt Saatgut: ${f.seedNeed - f.seeds} ${seedName}.` : "Die Arbeit ist getan.");
		f.untilWorldMs = now + d.keepWorldMs;
		const done = f.seeds >= f.seedNeed && f.work >= f.workNeed;
		if (done) {
			const soil = soilFor(d, f, crop, now);
			const helpers = Object.entries(f.by).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} (${k})`).join(", ");
			Object.assign(f, { ...fresh(f), stage: "waechst", grazed: 0, soil: soil.factor, tired: soil.tired, yields: harvestOf(crop, f.w * f.h, soil.factor), dueWorldMs: now + crop.growWorldMs * growFactor(await fogOf(c.space, f.room), false) });
			await writeField(c, f);
			return msg(c, "*", "world", `Die ${fieldName(f)} ist mit ${crop.name} bestellt (${helpers}). Reif in etwa ${hours(f.dueWorldMs - now)}${soil.tired ? `; der Boden ist müde und gibt weniger` : ""}.`);
		}
		await writeField(c, f);
		const missing = [...(f.seeds < f.seedNeed ? [`${f.seedNeed - f.seeds} ${seedName}`] : []), ...(f.work < f.workNeed ? [`${f.workNeed - f.work} Arbeit`] : [])];
		await msg(c, "*", "emote", `${c.actor.name} ${worked ? "pflügt" : "bringt Saatgut für"} die Flur${seed.length ? ` (${seed.length} ${seedName})` : ""}; es fehlen noch ${missing.join(", ")}.`);
	},
};

/** `ernte` at a field (garden.ts hands it over when no bed is near): one work point, and its share of the yield into the
 *  worker's pack; the last point brings the field in. False when no field is near. */
export async function harvestField(c: CommandCtx): Promise<boolean> {
	const d = c.world.fields;
	if (!d) return false;
	const f = await fieldNear(c);
	if (!f) return false;
	if (!mayWork(c, f)) throw new CommandError(`Das ist die ${fieldName(f)}; ernten darf sie, wer sie angelegt hat (oder jeder, wenn sie offen ist).`);
	const crop = cropOf(d, f.crop), now = await worldNowOf(c.space, c.txn);
	if (f.stage !== "reif" && f.stage !== "spaet") throw new CommandError(f.stage === "waechst" ? `${crop?.name ?? "Die Frucht"} ist noch nicht reif; in etwa ${hours(f.dueWorldMs - now)}.` : f.stage === "saat" ? "Die Flur wird erst bestellt („bestelle“)." : "Auf der Flur wächst nichts; sie liegt brach.");
	await tire(c, now);
	credit(c, f);
	const i = f.work++;
	const late = f.stage === "spaet";
	const share = f.yields.map((y) => { const n = shareOf(y.count, f.workNeed, i); return { proto: y.proto, count: late ? n - Math.round(n * d.lateLoss) : n }; });
	const got = await giveBack(c, share);
	f.untilWorldMs = now + d.keepWorldMs;
	if (f.work >= f.workNeed) {
		const helpers = Object.entries(f.by).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} (${k})`).join(", ");
		await writeField(c, { ...fresh(f), stage: "brach", crop: null, seeds: 0, seedNeed: 0, yields: [], soil: 1, lastGroup: crop?.group ?? null, lastHarvestWorldMs: now, dueWorldMs: FOREVER });
		await msg(c, "*", "world", `Die ${crop?.name ?? "Ernte"} der ${fieldName(f)} ist eingebracht! Geerntet haben ${helpers}.`);
	} else {
		await writeField(c, f);
		await msg(c, "*", "emote", `${c.actor.name} erntet auf der Flur (${f.work}/${f.workNeed}): ${got.join(", ") || "nichts mehr"}.`);
	}
	return true;
}

export const FIELD_COMMANDS: Command[] = [flur, bestelle];

/** A message from the world to everyone in a room. */
async function tell(space: SpaceLike, leaseMs: number, room: string, text: string, txn: string): Promise<void> {
	await space.write({ type: "Msg", fields: { room, to: "*", kind: "world", text, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
}

/** The fields whose date has come (in the garden job, engine/worldevents.ts): growing ones ripen, ripe ones go late after
 *  their window, late ones lose their crop after another; a field nobody worked for its time goes back to grass. One held
 *  by a command right now is left for the next round. Writes nothing when no date has come. */
export async function fieldTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	const d = w.fields;
	if (!d) return 0;
	const now = await worldNowOf(space);
	let written = 0;
	for (const e of await space.readAll({ type: "Field" })) {
		const f0 = fieldsOf<FieldFields>(e);
		if (f0.dueWorldMs > now && f0.untilWorldMs > now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Field", fields: { fieldId: f0.fieldId } }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			const f = fieldsOf<FieldFields>(t), crop = cropOf(d, f.crop)?.name ?? "Die Frucht";
			if (f.untilWorldMs <= now) {
				await freeCells(space, txn, f.room, f.fieldId);
				await releaseLight(space, txn, f.beaconId, f.points);
				await tell(space, leaseMs, f.room, `Die ${fieldName(f)} ist verwildert; dort wächst wieder Gras.`, txn);
			} else if (f.stage === "waechst") {
				const need = Math.ceil((f.w * f.h) / d.harvestPerCells);
				await space.write({ type: "Field", fields: { ...f, stage: "reif", workNeed: need, dueWorldMs: now + d.windowWorldMs } as never }, txn, FOREVER);
				await tell(space, leaseMs, f.room, `${crop} auf der ${fieldName(f)} ist reif: ${need} Hände-Stunden Ernte („ernte“ an der Flur)${f.open ? ", jeder darf mithelfen" : ""}.`, txn);
			} else if (f.stage === "reif") {
				await space.write({ type: "Field", fields: { ...f, stage: "spaet", dueWorldMs: now + d.windowWorldMs } as never }, txn, FOREVER);
				await tell(space, leaseMs, f.room, `${crop} auf der ${fieldName(f)} ist überreif; was jetzt noch geerntet wird, ist weniger.`, txn);
			} else if (f.stage === "spaet") {
				await space.write({ type: "Field", fields: { ...fresh(f), stage: "brach", crop: null, seeds: 0, seedNeed: 0, yields: [], soil: 1, lastGroup: cropOf(d, f.crop)?.group ?? null, lastHarvestWorldMs: now, dueWorldMs: FOREVER } as never }, txn, FOREVER);
				await tell(space, leaseMs, f.room, `${crop} auf der ${fieldName(f)} ist verdorben; die Flur liegt wieder brach.`, txn);
			} else await space.write({ type: "Field", fields: { ...f, dueWorldMs: FOREVER } as never }, txn, FOREVER);
			await space.commit(txn);
			written++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return written;
}

/** A field as the page draws it: its crop's colour and the stage. */
export const fieldView = (w: WorldDef, f: FieldFields) => ({ crop: cropOf(w.fields!, f.crop)?.name, color: cropOf(w.fields!, f.crop)?.color, stage: f.stage, progress: f.workNeed ? f.work / f.workNeed : 0 });
