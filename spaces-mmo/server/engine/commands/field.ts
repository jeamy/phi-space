// Fields, step 3 part 1 (docs/siedeln.en.md "Äcker und Getreide"): the big sister of the beds. A field is one entry over a
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
import { needRank } from "./settlement.ts";
import { needEpoch } from "./epoch.ts";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type FieldFields, type WorkRestFields } from "../../model.ts";
import { peek } from "../../space.ts";
import { decayNowOf, frozenUntil, patienceOf, worldNowOf } from "../clock.ts";
import { satedFactor } from "./food.ts";
import { workRestMs } from "../../settings.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { fogOf } from "../fire.ts";
import type { CropDef, FieldDef, WorldDef } from "../world.ts";
import { ARTICLE, besides, cells, freeCells, giveBack, human, lightFor, plural, refusal, releaseLight, SITE_REACH, takeNear, useLight, type Rect } from "./build.ts";
import { growFactor } from "./garden.ts";
import { randomBytes, timeNow } from "../source.ts";

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
export const fieldName = (f: FieldFields) => `Acker von ${f.ownerName}`;
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
	if (r.far) throw new NotUnderstood("Geh näher an den Acker heran (höchstens zwei Schritte entfernt).");
	return null;
}
async function fieldHere(c: CommandCtx): Promise<FieldFields> {
	const f = await fieldNear(c);
	if (!f) throw new NotUnderstood("Hier ist kein Acker. „flur anlegen“ legt eine an (mit einem Spaten, im Licht eines Feuers).");
	return f;
}
const writeField = (c: CommandCtx, f: FieldFields) => c.space.write({ type: "Field", fields: f as never }, c.txn, FOREVER);

/** A work point costs the figure a rest, the same as at a site (one body, one tiredness); throws while it rests. */
async function tire(c: CommandCtx, now: number): Promise<void> {
	const rest = await peek(c.space, { type: "WorkRest", fields: { charId: c.actor.charId } });
	const until = rest ? fieldsOf<WorkRestFields>(rest).untilWorldMs : 0;
	if (until > now) throw new CommandError(`Du bist noch müde von der letzten Arbeit; in etwa ${Math.max(1, Math.round((until - now) / 60_000))} Minuten wieder.`);
	if (rest) await c.space.takeIfExists({ id: rest.id }, NO_WAIT, { txn: c.txn });
	await c.space.write({ type: "WorkRest", fields: { charId: c.actor.charId, untilWorldMs: now + (await workRestMs(c.space)) / (await satedFactor(c, now)) } satisfies WorkRestFields as never }, c.txn, FOREVER);
}
/** Counts a work point; NPCs and automata may give at most half of them, as at a site. */
function credit(c: CommandCtx, f: FieldFields): void {
	if (!human(c)) {
		if (f.other >= Math.floor(f.workNeed / 2)) throw new CommandError("Diesen Acker bestellen Menschen; Helfer haben ihren Teil schon getan.");
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
	const dunged = f.dunged && f.stage !== "brach" ? "; gedüngt" : "";
	return `${fieldName(f)} (${f.w}×${f.h}${f.open ? ", offen für alle" : ""}${f.fenced ? ", eingezäunt" : ""}): ${what}${soil}${grazed}${dunged}.`;
};

/** The rectangles that cover the cell (x, y), the one with its corner there first, then those shifted by the fewest cells, so a cell
 *  beside a way or the water finds the room on the side that has some. */
export const around = (x: number, y: number, d: Pick<FieldDef, "w" | "h">): Rect[] => {
	const out: Rect[] = [];
	for (let dy = 0; dy < d.h; dy++) for (let dx = 0; dx < d.w; dx++) out.push({ x: x - dx, y: y - dy, w: d.w, h: d.h });
	return out.sort((a, b) => (x - a.x) + (y - a.y) - ((x - b.x) + (y - b.y)));
};

/** `[x y]`: a field beside the actor (or at x y), on Plot cells in the light of a fire. */
async function stake(c: CommandCtx, at: string): Promise<void> {
	const d = fieldDef(c), g = c.world.garden;
	if (!c.account || c.account.guest) throw new CommandError("Gäste helfen auf offenen Äckern mit, legen aber keine an; registriere dich dafür.");
	if (!human(c)) throw new CommandError("Äcker legen nur Menschen an.");
	await needEpoch(c, d.epoch, "Ein neuer Acker");
	await needRank(c, "siedler", "Äcker anlegen");
	if (g && !(await inventory(c)).some((i) => i.f.proto === g.spade)) throw new CommandError(`Einen Acker bricht man mit einem Spaten um („craft ${c.world.prototypes.find((p) => p.key === g.spade)?.name.toLowerCase() ?? g.spade}“).`);
	if ((await c.space.count({ type: "Field", fields: { accountId: c.account.accountId } })) >= d.maxFields) throw new CommandError(`Mehr als ${plural(d.maxFields, "Acker", "Äcker")} bestellt niemand allein.`);
	const light = await lightFor(c, d.points);
	if (typeof light === "string") throw new CommandError(light.replace("gebaut wird", "gepflügt wird").replace("Bau", "Acker"));
	const room = await roomOf(c);
	const m = /^(\d+)\s+(\d+)$/.exec(at.trim());
	// "flur anlegen x y": a field that covers that cell (its corner there first); on the cell one stands on, which may be a way,
	// it lies beside the figure, as without a cell
	const tries: Rect[] = !m || (Number(m[1]) === c.actor.x && Number(m[2]) === c.actor.y) ? besides(c, d) : around(Number(m[1]), Number(m[2]), d);
	let rect: Rect | null = null, why = "";
	for (const r of tries) { const no = await refusal(c, room, r, false, true); if (!no) { rect = r; break; } why ||= no; }
	if (!rect) throw new CommandError(`Hier passt kein Acker hin (${d.w}×${d.h}): ${why}`);
	const fieldId = `field-${randomBytes(6).toString("hex")}`, now = await worldNowOf(c.space, c.txn);
	for (const p of cells(rect)) {
		try { await c.space.write({ type: "Plot", fields: { room: room.roomId, x: p.x, y: p.y, of: fieldId } as never }, c.txn, FOREVER, { unique: ["room", "x", "y"] }); }
		catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Dort hat gerade jemand anderes umgebrochen."); throw e; }
	}
	await useLight(c, light.beaconId, light.use, d.points, light.fresh);
	const f: FieldFields = { fieldId, room: room.roomId, ...rect, owner: c.actor.charId, ownerName: c.actor.name, accountId: c.account.accountId, beaconId: light.beaconId, points: d.points,
		stage: "brach", crop: null, seeds: 0, seedNeed: 0, work: 0, workNeed: 0, yields: [], soil: 1, by: {}, human: 0, other: 0, lastGroup: null, tired: 0, lastHarvestWorldMs: 0,
		dueWorldMs: FOREVER, untilWorldMs: (await decayNowOf(c.space, c.txn)) + d.keepWorldMs, at: now };
	await writeField(c, f);
	await msg(c, "*", "info", `${c.actor.name} bricht einen Acker um (${rect.w}×${rect.h}). „bestelle <frucht>“ sät darauf: ${d.crops.map((x) => x.name).join(", ")}.`);
}

const flur: Command = {
	key: "flur", aliases: ["fluren", "acker", "äcker", "aecker", "field", "fields"],
	help: "flur – die Äcker hier (flur anlegen [x y]: mit einem Spaten einen Acker umbrechen; flur offen / flur zu: alle mitsäen und -ernten lassen oder nicht; flur aufgeben)",
	async func(c, arg) {
		const d = fieldDef(c);
		const [word = "", ...rest] = arg.trim().split(/\s+/);
		if (/^(?:anlegen|neu|new|umbrechen|\d+)$/i.test(word)) return stake(c, /^\d+$/.test(word) ? arg : rest.join(" "));
		if (/^(?:offen|öffnen|oeffnen|open|zu|schließen|schliessen|close)$/i.test(word)) {
			const f = await fieldHere(c);
			if (!mine(c, f)) throw new CommandError(`Das ist der ${fieldName(f)}; öffnen und schließen darf nur, wer ihn angelegt hat.`);
			const open = /^(?:offen|öffnen|oeffnen|open)$/i.test(word);
			const g = { ...f };
			if (open) g.open = true; else delete g.open;
			await writeField(c, g);
			return msg(c, "*", "info", open ? `${c.actor.name} öffnet den Acker: säen und ernten darf jetzt jeder, und jeder behält seinen Anteil.` : `${c.actor.name} schließt den Acker wieder für Fremde.`);
		}
		if (/^(?:aufgeben|weg|remove)$/i.test(word)) {
			const f = await fieldHere(c);
			if (!mine(c, f)) throw new CommandError(`Das ist der ${fieldName(f)}; aufgeben kann ihn nur, wer ihn angelegt hat.`);
			// what grows on it is lost: asked first, „flur aufgeben ja“ does it (the map's menu asks on the page and sends that)
			if (!/^(?:ja|yes)$/i.test(rest[0] ?? "")) { await writeField(c, f); return msg(c, c.actor.charId, "info", "Den Acker wirklich aufgeben? Was darauf wächst, geht verloren, und dort wächst wieder Gras. „flur aufgeben ja“ gibt ihn auf."); }
			await freeCells(c.space, c.txn, f.room, f.fieldId);
			await releaseLight(c.space, c.txn, f.beaconId, f.points);
			return msg(c, "*", "info", `${c.actor.name} gibt den Acker auf; dort wächst wieder Gras.`);
		}
		// "flur ansehen x y": the one field at that cell (the map's menu), else all of the room
		const [x, y] = /^(?:ansehen|look)$/i.test(word) ? rest.map(Number) : [];
		const one = (f: FieldFields) => x === undefined || y === undefined || (x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h);
		const all = (await c.space.readAll({ type: "Field", fields: { room: c.actor.room } })).map((e) => fieldsOf<FieldFields>(e)).filter(one);
		if (!all.length) return msg(c, c.actor.charId, "info", "Hier ist kein Acker. Mit einem Spaten bricht „flur anlegen“ eine um (im Licht eines Feuers).");
		const now = await worldNowOf(c.space, c.txn);
		await msg(c, c.actor.charId, "look", all.map((f) => describe(d, f, now)).join("\n"));
	},
};

const bestelle: Command = {
	key: "bestelle", aliases: ["bestellen", "pflüge", "pfluege", "pflügen", "pfluegen", "plough", "plow"],
	help: "bestelle [frucht] – den Acker neben dir bestellen: wer sie angelegt hat, wählt die Frucht; dann bringt jeder Saatgut und einen Arbeitspunkt (danach ruhst du eine Weile)",
	async func(c, arg) {
		const d = fieldDef(c);
		const said = arg.trim().replace(/^(?:mit\s+)?/i, "");
		const f = await fieldHere(c);
		if (!mayWork(c, f)) throw new CommandError(`Das ist der ${fieldName(f)}; bestellen darf ihn, wer ihn angelegt hat (oder jeder, wenn er offen ist).`);
		const now = await worldNowOf(c.space, c.txn);
		if (f.stage === "brach") {
			if (!mine(c, f)) throw new CommandError("Was auf dem Acker wächst, wählt, wer sie angelegt hat.");
			const crop = said ? cropNamed(d, said) : undefined;
			if (!crop) throw new NotUnderstood(`Was säst du? ${d.crops.map((x) => `${x.name} (Saatgut: ${c.world.prototypes.find((p) => p.key === x.seed)?.name ?? x.seed})`).join(", ")}. Zum Beispiel: bestelle ${d.crops[0]?.name.toLowerCase() ?? ""}`);
			const n = f.w * f.h;
			Object.assign(f, { ...fresh(f), stage: "saat", crop: crop.key, seeds: 0, seedNeed: Math.ceil(n / d.seedPerCells), workNeed: Math.ceil(n / d.sowPerCells) });
		} else if (f.stage !== "saat") throw new CommandError(f.stage === "waechst" ? `Auf dem Acker wächst schon ${cropOf(d, f.crop)?.name ?? f.crop}.` : `Der Acker ist ${STAGE[f.stage]}; jetzt wird geerntet („ernte“).`);
		else if (said && cropNamed(d, said)?.key !== f.crop) throw new CommandError(`Der Acker wird schon mit ${cropOf(d, f.crop)?.name ?? f.crop} bestellt.`);
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
		f.untilWorldMs = (await decayNowOf(c.space, c.txn)) + d.keepWorldMs;
		const done = f.seeds >= f.seedNeed && f.work >= f.workNeed;
		if (done) {
			const soil = soilFor(d, f, crop, now);
			const helpers = Object.entries(f.by).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} (${k})`).join(", ");
			Object.assign(f, { ...fresh(f), stage: "waechst", grazed: 0, soil: soil.factor, tired: soil.tired, yields: harvestOf(crop, f.w * f.h, soil.factor), dueWorldMs: now + crop.growWorldMs * growFactor(await fogOf(c.space, f.room), false) });
			await writeField(c, f);
			return msg(c, "*", "world", `Der ${fieldName(f)} ist mit ${crop.name} bestellt (${helpers}). Reif in etwa ${hours(f.dueWorldMs - now)}${soil.tired ? `; der Boden ist müde und gibt weniger` : ""}.`);
		}
		await writeField(c, f);
		const missing = [...(f.seeds < f.seedNeed ? [`${f.seedNeed - f.seeds} ${seedName}`] : []), ...(f.work < f.workNeed ? [`${f.workNeed - f.work} Arbeit`] : [])];
		await msg(c, "*", "emote", `${c.actor.name} ${worked ? "pflügt" : "bringt Saatgut für"} den Acker${seed.length ? ` (${seed.length} ${seedName})` : ""}; es fehlen noch ${missing.join(", ")}.`);
	},
};

/** `ernte` at a field (garden.ts hands it over when no bed is near): one work point, and its share of the yield into the
 *  worker's pack; the last point brings the field in. False when no field is near. */
export async function harvestField(c: CommandCtx): Promise<boolean> {
	const d = c.world.fields;
	if (!d) return false;
	const f = await fieldNear(c);
	if (!f) return false;
	if (!mayWork(c, f)) throw new CommandError(`Das ist der ${fieldName(f)}; ernten darf ihn, wer ihn angelegt hat (oder jeder, wenn er offen ist).`);
	const crop = cropOf(d, f.crop), now = await worldNowOf(c.space, c.txn);
	if (f.stage !== "reif" && f.stage !== "spaet") throw new CommandError(f.stage === "waechst" ? `${crop?.name ?? "Die Frucht"} ist noch nicht reif; in etwa ${hours(f.dueWorldMs - now)}.` : f.stage === "saat" ? "Der Acker wird erst bestellt („bestelle“)." : "Auf dem Acker wächst nichts; er liegt brach.");
	await tire(c, now);
	credit(c, f);
	const i = f.work++;
	const late = f.stage === "spaet";
	const share = f.yields.map((y) => { const n = shareOf(y.count, f.workNeed, i); return { proto: y.proto, count: late ? n - Math.round(n * d.lateLoss) : n }; });
	const got = await giveBack(c, share);
	f.untilWorldMs = (await decayNowOf(c.space, c.txn)) + d.keepWorldMs;
	if (f.work >= f.workNeed) {
		const helpers = Object.entries(f.by).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} (${k})`).join(", ");
		await writeField(c, { ...fresh(f), stage: "brach", crop: null, seeds: 0, seedNeed: 0, yields: [], soil: 1, dunged: false, lastGroup: crop?.group ?? null, lastHarvestWorldMs: now, dueWorldMs: FOREVER });
		await msg(c, "*", "world", `Die ${crop?.name ?? "Ernte"} des ${fieldName(f).replace("Acker", "Ackers")} ist eingebracht! Geerntet haben ${helpers}.`);
	} else {
		await writeField(c, f);
		await msg(c, "*", "emote", `${c.actor.name} erntet auf dem Acker (${f.work}/${f.workNeed}): ${got.join(", ") || "nichts mehr"}.`);
	}
	return true;
}

/** `pflanze` of a field's crop: grain has no place in a bed. Sows at a field in this room, else says where it grows; false when `said` is no crop. */
export async function sowOnField(c: CommandCtx, said: string): Promise<boolean> {
	const d = c.world.fields;
	const seedName = (x: CropDef) => c.world.prototypes.find((p) => p.key === x.seed)?.name ?? x.seed;
	const crop = d && (cropNamed(d, said) ?? d.crops.find((x) => seedName(x).toLowerCase() === said));
	if (!crop) return false;
	if (await c.space.count({ type: "Field", fields: { room: c.actor.room } })) { await bestelle.func(c, crop.key); return true; }
	throw new CommandError(`${crop.name} wächst nicht im Beet, sondern auf einem Acker. Neben deinem Acker sät „bestelle ${crop.key}“ (${Math.ceil(d.w * d.h / d.seedPerCells)}× ${seedName(crop)} als Saatgut). Einen Acker legt „flur anlegen“ an, mit einem Spaten, sobald die Insel ein Dorf ist.`);
}

/** Fertiliser (docs/schlachten.en.md): `dung.count` of `dung.proto` on a growing field raise its harvest by `dung.factor`, once
 *  a crop; the next fallow forgets it. No work point, no rest. */
const duenge: Command = {
	key: "dünge", aliases: ["duenge", "düngen", "duengen", "fertilise", "fertilize"],
	help: "dünge – den Acker neben dir düngen, während die Frucht wächst (Knochenmehl aus der Mühle): einmal je Frucht, die Ernte wird größer",
	async func(c) {
		const d = fieldDef(c), dung = d.dung;
		if (!dung) throw new CommandError("In dieser Welt düngt man nicht.");
		const f = await fieldHere(c);
		if (!mayWork(c, f)) throw new CommandError(`Das ist der ${fieldName(f)}; düngen darf ihn, wer ihn angelegt hat (oder jeder, wenn er offen ist).`);
		const crop = cropOf(d, f.crop);
		if (f.stage !== "waechst") throw new CommandError(f.stage === "brach" ? "Auf dem Acker wächst nichts; gedüngt wird, während eine Frucht wächst." : f.stage === "saat" ? "Der Acker wird erst bestellt; gedüngt wird, wenn die Frucht wächst." : `${crop?.name ?? "Die Frucht"} ist schon reif; jetzt wird geerntet.`);
		if (f.dunged) throw new CommandError(`Der ${fieldName(f)} ist für diese Frucht schon gedüngt.`);
		const name = c.world.prototypes.find((p) => p.key === dung.proto)?.name ?? dung.proto;
		const have = (await inventory(c)).filter((i) => i.f.proto === dung.proto).slice(0, dung.count);
		if (have.length < dung.count) throw new CommandError(`Zum Düngen brauchst du ${dung.count} ${name}; du trägst ${have.length}.`);
		for (const it of have) if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${it.f.name} ist gerade nicht greifbar; bitte noch einmal.`);
		await writeField(c, { ...f, dunged: true, yields: f.yields.map((y) => ({ ...y, count: Math.ceil(y.count * dung.factor) })) });
		await msg(c, "*", "emote", `${c.actor.name} streut ${dung.count} ${name} über den Acker; ${crop?.name ?? "die Frucht"} wird es danken.`);
	},
};

export const FIELD_COMMANDS: Command[] = [flur, bestelle, duenge];

/** A message from the world to everyone in a room. */
async function tell(space: SpaceLike, leaseMs: number, room: string, text: string, txn: string): Promise<void> {
	await space.write({ type: "Msg", fields: { room, to: "*", kind: "world", text, from: "", at: timeNow() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
}

/** The fields whose date has come (in the garden job, engine/worldevents.ts): growing ones ripen, ripe ones go late after
 *  their window, late ones lose their crop after another; a field nobody worked for its time goes back to grass. One held
 *  by a command right now is left for the next round. Writes nothing when no date has come. */
export async function fieldTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	const d = w.fields;
	if (!d) return 0;
	const now = await worldNowOf(space), kept = await decayNowOf(space), patient = await patienceOf(space), winter = await frozenUntil(space, now);
	let written = 0;
	for (const e of await space.readAll({ type: "Field" })) {
		const f0 = fieldsOf<FieldFields>(e);
		if (f0.dueWorldMs > now && f0.untilWorldMs > kept) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Field", fields: { fieldId: f0.fieldId } }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			const f = fieldsOf<FieldFields>(t), crop = cropOf(d, f.crop)?.name ?? "Die Frucht";
			if (f.untilWorldMs <= kept) {
				await freeCells(space, txn, f.room, f.fieldId);
				await releaseLight(space, txn, f.beaconId, f.points);
				await tell(space, leaseMs, f.room, `Der ${fieldName(f)} ist verwildert; dort wächst wieder Gras.`, txn);
			} else if (winter !== null && f.stage !== "brach") {
				await space.write({ type: "Field", fields: { ...f, dueWorldMs: winter } as never }, txn, FOREVER); // it stands still until the spring
			} else if (f.stage === "waechst") {
				const need = Math.ceil((f.w * f.h) / d.harvestPerCells);
				await space.write({ type: "Field", fields: { ...f, stage: "reif", workNeed: need, dueWorldMs: now + d.windowWorldMs * patient } as never }, txn, FOREVER);
				await tell(space, leaseMs, f.room, `${crop} auf dem ${fieldName(f)} ist reif: ${need} Hände-Stunden Ernte („ernte“ am Acker)${f.open ? ", jeder darf mithelfen" : ""}.`, txn);
			} else if (f.stage === "reif") {
				await space.write({ type: "Field", fields: { ...f, stage: "spaet", dueWorldMs: now + d.windowWorldMs * patient } as never }, txn, FOREVER);
				await tell(space, leaseMs, f.room, `${crop} auf dem ${fieldName(f)} ist überreif; was jetzt noch geerntet wird, ist weniger.`, txn);
			} else if (f.stage === "spaet") {
				await space.write({ type: "Field", fields: { ...fresh(f), stage: "brach", crop: null, seeds: 0, seedNeed: 0, yields: [], soil: 1, dunged: false, lastGroup: cropOf(d, f.crop)?.group ?? null, lastHarvestWorldMs: now, dueWorldMs: FOREVER } as never }, txn, FOREVER);
				await tell(space, leaseMs, f.room, `${crop} auf dem ${fieldName(f)} ist verdorben; der Acker liegt wieder brach.`, txn);
			} else await space.write({ type: "Field", fields: { ...f, dueWorldMs: FOREVER } as never }, txn, FOREVER);
			await space.commit(txn);
			written++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return written;
}

/** A field as the page draws it: its crop's colour and the stage. */
export const fieldView = (w: WorldDef, f: FieldFields) => ({ crop: cropOf(w.fields!, f.crop)?.name, color: cropOf(w.fields!, f.crop)?.color, model: cropOf(w.fields!, f.crop)?.model, stage: f.stage, progress: f.workNeed ? f.work / f.workNeed : 0 });
