// Settlements, step 4 part 2 (docs/siedeln.en.md "Siedlungen und Besitz"): enough huts of more than one owner in a room may
// found a settlement (`siedlung gründen <name>`): a name, members and rules, on one entry per room.
//
// - Ranks: stranger, helper (delivers and works at sites), settler (also builds, digs and ploughs here). Whoever owns a hut
//   in the room is a settler without being listed; others are taken in by a settler. A guest is a helper at most.
// - A settlement starts open: the ranks then bind nobody. `siedlung zu` makes them count, `siedlung offen` lifts it.
// - It lasts while its huts do: when too few stand (they decay like any building), the count (job "epoch") ends it. What
//   stands there stays; the land and the buildings never belonged to it.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type SettlementFields, type SettlementMember } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, msgOptions, NotUnderstood, type CommandCtx } from "../context.ts";
import { peek } from "../../space.ts";
import type { WorldDef } from "../world.ts";
import { hallIn, zonesLine } from "./townhall.ts";
import { tendersIn } from "./festival.ts";
import { worldNowOf } from "../clock.ts";

export type Rank = "fremder" | "helfer" | "siedler";
const ORDER: Rank[] = ["fremder", "helfer", "siedler"];
const RANK_NAME: Record<Rank, string> = { fremder: "Fremder", helfer: "Helfer", siedler: "Siedler" };
const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

export const hutsIn = async (space: SpaceLike, w: WorldDef, room: string, txn: string | null = null) => (await space.readAll({ type: "Building", fields: { room, plan: w.settlement?.plan ?? "" } }, txn ? { txn } : {})).map((e) => fieldsOf<BuildingFields>(e));
/** Whether huts of this many owners make a settlement. */
export const enoughHuts = (w: WorldDef, huts: Array<Pick<BuildingFields, "accountId">>) => !!w.settlement && huts.length >= w.settlement.huts && new Set(huts.map((h) => h.accountId)).size >= w.settlement.owners;
export const settlementIn = async (space: SpaceLike, room: string, txn: string | null = null) => { const e = await peek(space, { type: "Settlement", fields: { room } }, { txn }); return e ? fieldsOf<SettlementFields>(e) : null; };

/** The rank of the actor in a settlement: a hut here makes a settler, a guest is a helper at most. */
export function rankOf(s: SettlementFields, huts: Array<Pick<BuildingFields, "accountId">>, account: { accountId: string; guest: boolean } | null | undefined): Rank {
	if (!account) return "fremder";
	const r: Rank = huts.some((h) => h.accountId === account.accountId) ? "siedler" : s.members.find((m) => m.accountId === account.accountId)?.rank ?? "fremder";
	return account.guest && r === "siedler" ? "helfer" : r;
}

/** In a closed settlement: throws unless the actor has at least `need`. `what`: the deed ("Hier bauen"). */
export async function needRank(c: CommandCtx, need: "helfer" | "siedler", what: string): Promise<void> {
	if (!c.world.settlement) return;
	const s = await settlementIn(c.space, c.actor.room, c.txn);
	if (!s?.closed) return;
	const have = rankOf(s, await hutsIn(c.space, c.world, s.room, c.txn), c.account);
	if (ORDER.indexOf(have) < ORDER.indexOf(need)) throw new CommandError(`${s.name} ist geschlossen: ${what} dürfen hier nur ${need === "siedler" ? "Siedler" : "Helfer und Siedler"}. Du bist ${RANK_NAME[have]}; ein Siedler kann dich aufnehmen.`);
}

/** The settlements whose huts are too few now go (in the job of the epochs); nothing is written while they stand. */
export async function settlementTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	if (!w.settlement) return 0;
	let gone = 0;
	for (const e of await space.readAll({ type: "Settlement" })) {
		const s = fieldsOf<SettlementFields>(e);
		if (enoughHuts(w, await hutsIn(space, w, s.room))) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			if (!(await space.takeIfExists({ type: "Settlement", fields: { settlementId: s.settlementId } }, NO_WAIT, { txn }))) { await space.abort(txn); continue; }
			await space.takeIfExists({ type: "SettlementName", fields: { nameKey: s.nameKey } }, NO_WAIT, { txn }); // the name is free again
			for (const z of await space.readAll({ type: "Zone", fields: { room: s.room } })) await space.takeIfExists({ id: z.id }, NO_WAIT, { txn }); // its zones go with it
			await space.write({ type: "Msg", fields: { room: s.room, to: "*", kind: "world", text: `${s.name} gibt es nicht mehr: zu wenige Hütten stehen noch. Was hier steht, bleibt.`, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
			await space.commit(txn);
			gone++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return gone;
}

const defOf = (c: CommandCtx) => { const d = c.world.settlement; if (!d) throw new CommandError("In dieser Welt gibt es keine Siedlungen."); return d; };
const NAME = /^[\p{L}][\p{L} '-]{1,29}$/u;

async function found(c: CommandCtx, name: string): Promise<void> {
	const d = defOf(c), n = name.trim().replace(/\s+/g, " ");
	if (!c.account || c.account.guest) throw new CommandError("Gäste gründen keine Siedlung; registriere dich dafür.");
	if (!NAME.test(n)) throw new NotUnderstood("So gründest du eine: siedlung gründen <name> (2 bis 30 Buchstaben).");
	const huts = await hutsIn(c.space, c.world, c.actor.room, c.txn);
	if (!huts.some((h) => h.accountId === c.account!.accountId)) throw new CommandError("Eine Siedlung gründet, wer hier eine Hütte hat.");
	if (!enoughHuts(c.world, huts)) throw new CommandError(`Für eine Siedlung braucht es ${d.huts} Hütten von mindestens ${d.owners} Besitzern in einem Raum; hier stehen ${huts.length}.`);
	const s: SettlementFields = { settlementId: randomBytes(6).toString("hex"), name: n, nameKey: key(n), room: c.actor.room, founder: c.account.accountId, founderName: c.actor.name, members: [], closed: false, at: Date.now() };
	try {
		await c.space.write({ type: "Settlement", fields: s as never }, c.txn, FOREVER, { unique: ["room"] });
		await c.space.write({ type: "SettlementName", fields: { nameKey: s.nameKey } as never }, c.txn, FOREVER, { unique: ["nameKey"] });
	} catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Hier gibt es schon eine Siedlung, oder der Name ist vergeben."); throw e; }
	await msg(c, "*", "world", `${c.actor.name} gründet die Siedlung ${n}! Wer hier eine Hütte hat, ist Siedler.`);
}

/** The settlement here, taken in the transaction, for a settler of it. */
async function manage(c: CommandCtx): Promise<SettlementFields> {
	defOf(c);
	const e = await c.space.takeIfExists({ type: "Settlement", fields: { room: c.actor.room } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Hier ist keine Siedlung. „siedlung gründen <name>“ gründet eine.");
	const s = fieldsOf<SettlementFields>(e);
	if (rankOf(s, await hutsIn(c.space, c.world, s.room, c.txn), c.account) !== "siedler") throw new CommandError(`Das entscheiden die Siedler von ${s.name}.`);
	return s;
}
const put = (c: CommandCtx, s: SettlementFields) => c.space.write({ type: "Settlement", fields: s as never }, c.txn, FOREVER);

/** The settlements of this space, the best first: what they hold standing, in the points of the epochs (a park weighs most).
 *  Each region is a space of its own, so the list is that of the region. */
export async function settlementRanks(space: SpaceLike, w: WorldDef): Promise<Array<{ name: string; points: number; parks: number; tenders: number }>> {
	const buildings = (await space.readAll({ type: "Building" })).map((e) => fieldsOf<BuildingFields>(e));
	const now = await worldNowOf(space);
	return (await Promise.all((await space.readAll({ type: "Settlement" })).map(async (e) => {
		const s = fieldsOf<SettlementFields>(e), here = buildings.filter((b) => b.room === s.room), tenders = await tendersIn(space, w, s.room, now);
		return { name: s.name, points: here.reduce((n, b) => n + (b.points ?? 1), 0) + tenders, parks: here.filter((b) => b.plan === "park").length, tenders };
	}))).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}

const siedlung: Command = {
	key: "siedlung", aliases: ["settlement", "dorfrat"],
	help: "siedlung – die Siedlung hier: Name, Hütten, wer dazugehört (siedlung gründen <name>; aufnehmen <name> [helfer]; entlassen <name>; zu; offen; rang)",
	async func(c, arg) {
		const d = defOf(c);
		const [word = "", ...rest] = arg.trim().split(/\s+/), tail = rest.join(" ");
		if (/^(?:gründen|gruenden|gründe|gruende|found)$/i.test(word)) return found(c, tail);
		if (/^(?:rang|rangliste|rank)$/i.test(word)) {
			const ranks = await settlementRanks(c.space, c.world);
			return msg(c, c.actor.charId, "info", ranks.length ? `Die Siedlungen dieser Gegend: ${ranks.map((r, i) => `${i + 1}. ${r.name}, ${r.points} Punkte${r.parks ? ` (${r.parks === 1 ? "ein Park" : `${r.parks} Parks`}${r.tenders ? `, gepflegt von ${r.tenders}` : ""})` : ""}`).join("; ")}.` : "In dieser Gegend gibt es noch keine Siedlung.");
		}
		if (/^(?:zu|schließen|schliessen|close)$/i.test(word) || /^(?:offen|auf|öffnen|oeffnen|open)$/i.test(word)) {
			const s = await manage(c), closed = /^(?:zu|schl|close)/i.test(word);
			if (await hallIn(c.space, c.world, s.room, c.txn)) throw new CommandError(`In ${s.name} entscheidet das Rathaus: „antrag ${closed ? "zu" : "offen"}“ stellt es zur Abstimmung.`);
			await put(c, { ...s, closed });
			return msg(c, "*", "info", closed ? `${c.actor.name} schließt ${s.name}: bauen dürfen hier nur noch Siedler, liefern und arbeiten auch Helfer.` : `${c.actor.name} öffnet ${s.name}: hier darf wieder jeder bauen und helfen.`);
		}
		if (/^(?:aufnehmen|nimm|nehme|add)$/i.test(word)) {
			const m = /^(.+?)(?:\s+als)?(?:\s+(helfer|siedler))?$/i.exec(tail.replace(/\s+auf$/i, ""));
			if (!m) throw new NotUnderstood("So nimmst du jemanden auf: siedlung aufnehmen <name> [helfer].");
			const s = await manage(c);
			const who = (await c.space.readAll({ type: "Character" })).map((e) => fieldsOf<{ charId: string; name: string; accountId: string; guest: boolean }>(e)).find((x) => x.name.toLowerCase() === m[1]!.toLowerCase());
			if (!who) throw new CommandError(`Eine Figur „${m[1]!.slice(0, 30)}“ ist hier nicht bekannt.`);
			const rank: SettlementMember["rank"] = who.guest || m[2]?.toLowerCase() === "helfer" ? "helfer" : "siedler";
			await put(c, { ...s, members: [...s.members.filter((x) => x.accountId !== who.accountId), { accountId: who.accountId, name: who.name, rank }] });
			return msg(c, "*", "info", `${c.actor.name} nimmt ${who.name} als ${RANK_NAME[rank]} in ${s.name} auf.`);
		}
		if (/^(?:entlassen|entlasse|remove)$/i.test(word)) {
			const s = await manage(c), left = s.members.filter((x) => x.name.toLowerCase() !== tail.toLowerCase());
			await put(c, { ...s, members: left });
			if (left.length === s.members.length) throw new CommandError(`${tail.slice(0, 30)} ist nicht aufgenommen (Hüttenbesitzer sind von selbst Siedler).`);
			return msg(c, "*", "info", `${c.actor.name} entlässt ${tail} aus ${s.name}.`);
		}
		if (word) throw new NotUnderstood("„siedlung“ zeigt die Siedlung hier; dazu gründen, aufnehmen, entlassen, zu, offen.");
		const huts = await hutsIn(c.space, c.world, c.actor.room, c.txn), s = await settlementIn(c.space, c.actor.room, c.txn);
		if (!s) return msg(c, c.actor.charId, "info", `Hier ist keine Siedlung; hier stehen ${huts.length} Hütten von ${new Set(huts.map((h) => h.accountId)).size} Besitzern (nötig: ${d.huts} Hütten von ${d.owners}).${enoughHuts(c.world, huts) ? " „siedlung gründen <name>“ gründet eine, wenn du hier eine Hütte hast." : ""}`);
		const owners = [...new Set(huts.map((h) => h.ownerName))];
		const named = (r: string) => s.members.filter((m) => m.rank === r).map((m) => m.name);
		const zones = await zonesLine(c.space, s.room);
		await msg(c, c.actor.charId, "info", `${s.name} (gegründet von ${s.founderName}, ${s.closed ? "geschlossen" : "offen"}): ${huts.length} Hütten. Siedler: ${[...owners, ...named("siedler")].join(", ")}.${named("helfer").length ? ` Helfer: ${named("helfer").join(", ")}.` : ""} Du bist ${RANK_NAME[rankOf(s, huts, c.account)]}.${zones ? ` Zonen: ${zones}.` : ""}${s.tax ? ` Steuer: ${s.tax} Münzen je Stück aus dem Lager.` : ""}`);
	},
};

export const SETTLEMENT_COMMANDS: Command[] = [siedlung];
