// Festivals and the park, the rest of step 6 (docs/siedeln.en.md "Parks", "Feste"): beside a park a settler opens a flower
// show or a harvest festival with `fest`; it runs on world time, one at a time per room, and a settlement rests after one.
// With `zeige` everyone registered gives a thing up to it: a flower for the show (a named sort beats a bred one, a bred one a
// wild one), crops for the festival (the most wins). At its end the count (job "epoch") names the winner, who fetches the
// prize with `nachlass`, online or not; with fewer than two taking part nobody wins anything, so it mints no coins alone.
// The settlers of the world take part and count as a second; one of them that wins takes the honour and no coins.
// `pflege` gives a flower to the park once a world day: reputation for whoever tends it, and in the rank of the settlements
// each who tended lately counts a point.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type EstateFields, type ItemFields, type ParkCareFields, type SettlementFields, type ShowEntryFields, type ShowFields, type ShowKind } from "../../model.ts";
import { decayNowOf, seasonNow, worldNowOf } from "../clock.ts";
import { SEASONS } from "../worldtime.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, type CommandCtx } from "../context.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import { peek } from "../../space.ts";
import type { FestivalDef, WorldDef } from "../world.ts";
import { distTo, planOf } from "./build.ts";
import { hutsIn, rankOf, settlementIn } from "./settlement.ts";
import { consume } from "./trade.ts";
import { randomBytes, randomInt, timeNow } from "../source.ts";

const NAME: Record<ShowKind, string> = { blumen: "Blumenschau", ernte: "Erntefest", regatta: "Regatta" };
/** The seasons of each festival, by `SEASONS`. */
const ALLOWED: Record<ShowKind, number[]> = { blumen: [0, 1], ernte: [2], regatta: [0, 1, 2] };
const REGATTA_CREW = 2; // a boat is worth twice its rower: the sailing boat over the rowing boat, then the wind and the crew
const defOf = (c: CommandCtx): FestivalDef => { const d = c.world.festival; if (!d) throw new CommandError("In dieser Welt gibt es keine Feste."); return d; };
export const flowers = (w: WorldDef) => (w.garden?.sorts ?? []).filter((s) => s.kind === "zier").map((s) => s.yields.proto);
export const crops = (w: WorldDef) => (w.fields?.crops ?? []).flatMap((x) => x.yields.map((y) => y.proto)).filter((p) => !p.startsWith("samen-"));
const members = (c: CommandCtx) => { if (!c.account || c.account.guest) throw new CommandError("Gäste machen hier nicht mit; registriere dich dafür."); return c.account; };
const placeOf = (d: FestivalDef, kind: ShowKind) => (kind === "regatta" ? d.regatta ?? d.plan : d.plan);
const parkBeside = async (c: CommandCtx, d: FestivalDef, plan = d.plan) => (await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan } }, { txn: c.txn })).some((e) => distTo(c.actor, fieldsOf<BuildingFields>(e)) <= 1);
const atPark = (c: CommandCtx, d: FestivalDef, plan = d.plan) => `direkt neben ${planOf(c.world, plan)?.dative ?? "einem Park"}`;
/** What a flower is worth at the show: a named sort over a bred one over a wild one. */
const bloom = (f: ItemFields) => (f.variety ? (f.variety.name ? 3 : 2) : 1);
const ending = (d: FestivalDef) => `${Math.round(d.showWorldMs / (24 * 3600_000))} Tage`;
const entriesOf = async (space: SpaceLike, showId: string, txn: string | null = null) => (await space.readAll({ type: "ShowEntry", fields: { showId } }, txn ? { txn } : {})).map((e) => fieldsOf<ShowEntryFields>(e));
/** First by score, the earlier of equal ones ahead. */
const ranked = (xs: ShowEntryFields[]) => [...xs].sort((a, b) => b.score - a.score || a.at - b.at);

const fest: Command = {
	key: "fest", aliases: ["festival", "feier"],
	help: "fest blumen|ernte – als Siedler an einem Park eine Blumenschau oder ein Erntefest eröffnen; „fest“ allein zeigt das laufende",
	async func(c, arg) {
		const d = defOf(c), word = arg.trim().toLowerCase();
		const open = await peek(c.space, { type: "Show", fields: { room: c.actor.room } }, { txn: c.txn });
		if (!word) {
			if (!open) return msg(c, c.actor.charId, "info", "Hier läuft kein Fest. Siedler eröffnen an einem Park eines mit „fest blumen“ oder „fest ernte“.");
			const s = fieldsOf<ShowFields>(open), first = ranked(await entriesOf(c.space, s.showId, c.txn));
			return msg(c, c.actor.charId, "info", `${NAME[s.kind]} von ${s.settlementName}: ${first.length ? first.map((x) => `${x.charName} mit ${x.name}${s.kind === "ernte" ? ` (${x.score})` : ""}`).join(", ") : "noch hat niemand etwas gezeigt"}. „zeige <ding>“ macht mit.`);
		}
		const kind: ShowKind | null = /^(?:blumen|blumenschau|flowers)$/.test(word) ? "blumen" : /^(?:ernte|erntefest|harvest)$/.test(word) ? "ernte" : d.regatta && /^(?:regatta|race)$/.test(word) ? "regatta" : null;
		if (!kind) throw new NotUnderstood("So eröffnest du eines: fest blumen, fest ernte oder fest regatta.");
		const account = members(c);
		if (!(await parkBeside(c, d, placeOf(d, kind)))) throw new CommandError(`${kind === "regatta" ? "Eine Regatta" : "Dieses Fest"} eröffnet man ${atPark(c, d, placeOf(d, kind))}.`);
		const season = await seasonNow(c.space, await worldNowOf(c.space, c.txn));
		if (season !== null && !ALLOWED[kind].includes(season)) throw new CommandError(`${NAME[kind]} ist nicht jetzt: ${ALLOWED[kind].map((i) => SEASONS[i]).join(", ")}.`);
		const s = await settlementIn(c.space, c.actor.room, c.txn);
		if (!s) throw new CommandError("Feste feiert eine Siedlung; hier ist keine.");
		if (rankOf(s, await hutsIn(c.space, c.world, s.room, c.txn), account) !== "siedler") throw new CommandError(`Feste eröffnen die Siedler von ${s.name}.`);
		if (open) throw new CommandError("Hier läuft schon ein Fest.");
		const now = await decayNowOf(c.space, c.txn);
		if ((s.showRestWorldMs ?? 0) > now) throw new CommandError(`${s.name} hat gerade erst gefeiert; das nächste Fest braucht noch etwas Zeit.`);
		const show: ShowFields = { showId: randomBytes(6).toString("hex"), room: s.room, settlementId: s.settlementId, settlementName: s.name, kind, byName: c.actor.name, endsWorldMs: now + d.showWorldMs };
		try { await c.space.write({ type: "Show", fields: show as never }, c.txn, FOREVER, { unique: ["room"] }); }
		catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Hier läuft schon ein Fest."); throw e; }
		await msg(c, "*", "world", `${c.actor.name} eröffnet in ${s.name} ${kind === "blumen" ? "eine Blumenschau" : kind === "ernte" ? "ein Erntefest" : "eine Regatta"}! ${ending(d)} lang ${kind === "regatta" ? "meldet am Steg, wer mag, sein Boot" : `zeigt am Park, wer mag, ${kind === "blumen" ? "seine schönste Blume" : "seine Ernte"}`} („zeige <ding>“).`);
	},
};

const zeige: Command = {
	key: "zeige", aliases: ["ausstellen", "exhibit"],
	help: "zeige <ding> – am Park eine Blume zur Blumenschau oder Ernte zum Erntefest geben; was gezeigt ist, bleibt beim Fest",
	async func(c, arg) {
		const d = defOf(c), account = members(c);
		const open = await peek(c.space, { type: "Show", fields: { room: c.actor.room } }, { txn: c.txn });
		if (!open) throw new CommandError("Hier läuft kein Fest.");
		const s = fieldsOf<ShowFields>(open), boats = [c.world.boat?.proto, c.world.boat?.sail].filter((b): b is string => !!b), allowed = s.kind === "blumen" ? flowers(c.world) : s.kind === "ernte" ? crops(c.world) : boats;
		if (!(await parkBeside(c, d, placeOf(d, s.kind)))) throw new CommandError(`Gezeigt wird ${atPark(c, d, placeOf(d, s.kind))}.`);
		const thing = arg.trim();
		if (!thing) throw new NotUnderstood(`Was zeigst du? ${s.kind === "blumen" ? "Eine Blume." : s.kind === "ernte" ? "Etwas von deiner Ernte." : "Dein Boot."}`);
		const it = itemsNamed(c.world, await inventory(c), thing)[0];
		if (!it) throw new NotUnderstood(`Du trägst nichts, was „${thing.slice(0, 30)}“ heißt.`);
		if (!allowed.includes(it.f.proto)) throw new CommandError(`${it.f.name} gehört nicht ${s.kind === "blumen" ? "zur Blumenschau" : s.kind === "ernte" ? "zum Erntefest" : "zur Regatta"}.`);
		const mine = await c.space.takeIfExists({ type: "ShowEntry", fields: { showId: s.showId, accountId: account.accountId } }, NO_WAIT, { txn: c.txn });
		const had = mine && fieldsOf<ShowEntryFields>(mine);
		if (had && s.kind !== "ernte") throw new CommandError(`Du zeigst schon ${had.name}.`);
		if (s.kind !== "regatta") await consume(c, it.f, c.actor.charId); // a boat stays with its owner
		const entry: ShowEntryFields = { showId: s.showId, accountId: account.accountId, charName: c.actor.name, name: had?.name ?? (it.f.variety?.name || it.f.name), ...(account.settler ? { figure: true } : {}), score: s.kind === "blumen" ? bloom(it.f) : s.kind === "regatta" ? (boats.indexOf(it.f.proto) + 1) * REGATTA_CREW + randomInt(0, REGATTA_CREW + 1) : (had?.score ?? 0) + 1, at: had?.at ?? timeNow() };
		await c.space.write({ type: "ShowEntry", fields: entry as never }, c.txn, FOREVER);
		await msg(c, "*", "info", s.kind === "regatta" ? `$you() $conj(meldest|meldet) ${entry.name} zur Regatta.` : s.kind === "blumen" ? `$you() $conj(zeigst|zeigt) ${entry.name} auf der Blumenschau.` : `$you() $conj(legst|legt) ${it.f.name} zum Erntefest (${entry.score}).`, { templ: true });
	},
};

const pflege: Command = {
	key: "pflege", aliases: ["pflegen", "tend"],
	help: "pflege – einmal am Tag eine Blume in den Park neben dir setzen: das bringt dir Ruf und der Siedlung Rang",
	async func(c) {
		const d = defOf(c), account = members(c);
		if (!(await parkBeside(c, d))) throw new CommandError(`Pflegen kann man nur ${atPark(c, d)}.`);
		const now = await decayNowOf(c.space, c.txn), key = { room: c.actor.room, accountId: account.accountId };
		const held = await c.space.takeIfExists({ type: "ParkCare", fields: key }, NO_WAIT, { txn: c.txn });
		const had = held && fieldsOf<ParkCareFields>(held);
		if (had && had.lastWorldMs + d.careWorldMs > now) throw new CommandError("Der Park ist für heute gepflegt; morgen wieder.");
		const it = (await inventory(c)).find((i) => flowers(c.world).includes(i.f.proto));
		if (!it) throw new CommandError("Zum Pflegen brauchst du eine Blume.");
		await consume(c, it.f, c.actor.charId);
		const care: ParkCareFields = { ...key, charName: c.actor.name, points: (had?.points ?? 0) + 1, lastWorldMs: now };
		await c.space.write({ type: "ParkCare", fields: care as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(pflanzt|pflanzt) ${it.f.name} in den Park.`, { templ: true });
	},
};

/** Who tended the park of a room lately (the rank of the settlements). */
export async function tendersIn(space: SpaceLike, w: WorldDef, room: string, now: number): Promise<number> {
	if (!w.festival) return 0;
	return (await space.readAll({ type: "ParkCare", fields: { room } })).filter((e) => fieldsOf<ParkCareFields>(e).lastWorldMs + w.festival!.tendedWorldMs > now).length;
}

/** The shows whose time is over end (in the job of the epochs): the entries go, the winner's prize waits as an estate, and
 *  the settlement rests. Without its settlement a show lapses. */
export async function showTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	const d = w.festival;
	if (!d) return 0;
	const now = await decayNowOf(space);
	let ended = 0;
	for (const e of await space.readAll({ type: "Show" })) {
		if (fieldsOf<ShowFields>(e).endsWorldMs > now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const taken = await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
			if (!taken) { await space.abort(txn); continue; } // another worker came first
			const s = fieldsOf<ShowFields>(taken), all = ranked(await entriesOf(space, s.showId, txn));
			for (const x of await space.readAll({ type: "ShowEntry", fields: { showId: s.showId } }, { txn })) await space.takeIfExists({ id: x.id }, NO_WAIT, { txn });
			const held = await space.takeIfExists({ type: "Settlement", fields: { settlementId: s.settlementId } }, NO_WAIT, { txn });
			if (held) {
				await space.write({ type: "Settlement", fields: { ...fieldsOf<SettlementFields>(held), showRestWorldMs: now + d.restWorldMs } as never }, txn, FOREVER);
				const won = all.length >= 2 ? all[0]! : null;
				if (won && !won.figure) {
					const coin = await resolvePrototype(space, w.currency);
					const est: EstateFields = { estateId: `est-${s.showId}`, accountId: won.accountId, ownerName: won.charName, room: s.room, name: NAME[s.kind], untilWorldMs: now + (w.building?.estateWorldMs ?? 30 * 24 * 3600_000) };
					await space.write({ type: "Estate", fields: est as never }, txn, FOREVER);
					if (coin) for (let i = 0; i < d.prize; i++) await spawn(space, txn, w, coin, { location: est.estateId, x: -1, y: -1 });
				}
				const text = `${NAME[s.kind]} von ${s.settlementName} ist zu Ende: ${won?.figure ? `Es gewinnt ${won.charName} mit ${won.name}${s.kind === "ernte" ? ` (${won.score})` : ""}, zur Ehre der Siedlung.` : won ? `${won.charName} gewinnt mit ${won.name}${s.kind === "ernte" ? ` (${won.score})` : ""} ${d.prize} Münzen; abzuholen hier mit „nachlass“.` : "zu wenige haben mitgemacht, einen Preis gibt es nicht."}`;
				await space.write({ type: "Msg", fields: { room: s.room, to: "*", kind: "world", text, from: "", at: timeNow() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
			}
			await space.commit(txn);
			ended++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return ended;
}

export const FESTIVAL_COMMANDS: Command[] = [fest, zeige, pflege];
