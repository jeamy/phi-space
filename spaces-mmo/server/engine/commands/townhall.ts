// The town hall, step 6 part 5 (docs/siedeln.en.md "Rathaus"): where one stands in a settlement, the settlers decide by vote.
// `antrag` puts one motion up, beside the hall: closing or opening the settlement, or plain words that only get recorded. Each
// settler votes once with `stimme`, the last vote counts; after a world day the count (job "epoch") ends it: more yes than no
// carries it. A hall takes the closing out of one settler's hands: `siedlung zu` and `offen` then point here.
// A motion of a zone goes up anywhere in the settlement, for the ground around the one who puts it: a green zone keeps that
// ground for beds and green plans, a right of way free of everything. What stands there stays; zones end with the settlement.
// `antrag steuer <n>` sets the coins per thing taken from the warehouse; they stay in it, for the settlement.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type MotionFields, type MotionKind, type SettlementFields, type VoteFields, type ZoneFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, msgOptions, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { peek } from "../../space.ts";
import type { WorldDef } from "../world.ts";
import { distTo, planOf } from "./build.ts";
import { hutsIn, rankOf, settlementIn } from "./settlement.ts";

/** Whether a town hall stands in the room. */
export const hallIn = async (space: SpaceLike, w: WorldDef, room: string, txn: string | null = null) => !!w.townhall && (await space.count({ type: "Building", fields: { room, plan: w.townhall.plan } }, txn)) > 0;

const WHAT: Record<string, string> = { zu: "die Siedlung schließen", offen: "die Siedlung öffnen", gruen: "eine Grünzone", weg: "ein Wegerecht", frei: "die Zonen aufheben" };
const said = (m: MotionFields) => (m.kind === "steuer" ? `die Steuer auf ${m.tax} Münzen je Stück aus dem Lager setzen` : WHAT[m.kind] ? `${WHAT[m.kind]}${m.zone ? ` (${m.zone.w}×${m.zone.h} ab Feld ${m.zone.x}, ${m.zone.y})` : ""}` : `„${m.text}“`);
const ZONE: Record<string, "gruen" | "weg" | "frei"> = { "grünzone": "gruen", gruenzone: "gruen", greenzone: "gruen", wegerecht: "weg", "right of way": "weg", "zone frei": "frei" };
const isIn = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

/** Why the zones of the room forbid `cells` (null: they do not). `green`: a bed or a green plan, which a green zone admits. */
export async function zoneRefusal(c: CommandCtx, room: string, cells: Array<{ x: number; y: number }>, green: boolean): Promise<string | null> {
	if (!c.world.townhall) return null;
	for (const e of await c.space.readAll({ type: "Zone", fields: { room } })) {
		const z = fieldsOf<ZoneFields>(e);
		if (z.kind === "gruen" && green) continue;
		if (cells.some((p) => isIn(p, z))) return z.kind === "weg" ? "Dort liegt ein Wegerecht; das bleibt frei." : "Das ist Grünzone; dort gehen nur Beete und Parks.";
	}
	return null;
}
/** The zones of a room in a line for `siedlung`. */
export const zonesLine = async (space: SpaceLike, room: string) => (await space.readAll({ type: "Zone", fields: { room } })).map((e) => fieldsOf<ZoneFields>(e)).map((z) => `${z.kind === "weg" ? "Wegerecht" : "Grünzone"} ${z.w}×${z.h} ab Feld ${z.x}, ${z.y}`).join("; ");
/** What a carried motion of a zone does, in the transaction of the count. */
async function applyZone(space: SpaceLike, m: MotionFields, txn: string): Promise<void> {
	if (m.kind === "gruen" || m.kind === "weg") await space.write({ type: "Zone", fields: { zoneId: m.motionId, room: m.room, settlementId: m.settlementId, kind: m.kind, ...m.zone! } satisfies ZoneFields as never }, txn, FOREVER);
	else for (const e of await space.readAll({ type: "Zone", fields: { room: m.room } })) if (isIn(m.zone!, fieldsOf<ZoneFields>(e))) await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
}
const yes = (votes: VoteFields[]) => votes.filter((v) => v.yes).length;
const no = (votes: VoteFields[]) => votes.length - yes(votes);
const votesOn = async (space: SpaceLike, motionId: string) => (await space.readAll({ type: "Vote", fields: { motionId } })).map((e) => fieldsOf<VoteFields>(e));

/** The settlement here for a settler of it. `doing`: for the refusal. */
async function ofSettler(c: CommandCtx, doing: string): Promise<SettlementFields> {
	const s = await settlementIn(c.space, c.actor.room, c.txn);
	if (!s) throw new CommandError("Hier ist keine Siedlung.");
	if (rankOf(s, await hutsIn(c.space, c.world, s.room, c.txn), c.account) !== "siedler") throw new CommandError(`${doing} dürfen die Siedler von ${s.name}.`);
	return s;
}

/** The area of a zone around the actor, cut at the room's edge; "frei" means the actor's own cell. */
async function zoneAt(c: CommandCtx, kind: string, radius: number) {
	const { x, y } = c.actor;
	if (kind === "frei") return { x, y, w: 1, h: 1 };
	const room = await roomOf(c), right = Math.min(room.ground[0]!.length - 1, x + radius), bottom = Math.min(room.ground.length - 1, y + radius);
	const left = Math.max(0, x - radius), top = Math.max(0, y - radius);
	return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

const antrag: Command = {
	key: "antrag", aliases: ["motion", "beantrage"],
	help: "antrag <zu|offen|text> – am Rathaus einen Antrag stellen, über den die Siedler einen Tag lang abstimmen; „antrag grünzone“, „antrag wegerecht“, „antrag zone frei“ für die Fläche um dich; „antrag steuer <n>“ für das Lager; „antrag“ allein zeigt den laufenden",
	async func(c, arg) {
		const d = c.world.townhall;
		if (!d) throw new CommandError("In dieser Welt gibt es keine Rathäuser.");
		const text = arg.trim().replace(/\s+/g, " ");
		const open = await peek(c.space, { type: "Motion", fields: { room: c.actor.room } }, { txn: c.txn });
		if (!text) {
			if (!open) return msg(c, c.actor.charId, "info", "Hier läuft kein Antrag.");
			const m = fieldsOf<MotionFields>(open);
			const votes = await votesOn(c.space, m.motionId);
			return msg(c, c.actor.charId, "info", `${m.byName} beantragt: ${said(m)}. Bisher ${yes(votes)} dafür, ${no(votes)} dagegen.`);
		}
		const word = text.toLowerCase(), zone = Object.hasOwn(ZONE, word) ? ZONE[word] : undefined;
		const halls = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan: d.plan } }, { txn: c.txn })).map((e) => fieldsOf<BuildingFields>(e));
		if (zone && !halls.length) throw new CommandError("Zonen setzt ein Rathaus; hier steht keines.");
		if (!zone && !halls.some((b) => distTo(c.actor, b) <= 1)) throw new CommandError(`Anträge stellt man direkt neben ${planOf(c.world, d.plan)?.dative ?? "einem Rathaus"}.`);
		const s = await ofSettler(c, "Anträge stellen");
		const taxed = /^steuer\s+(\d+)$/i.exec(text);
		if (taxed && Number(taxed[1]) > d.maxTax) throw new CommandError(`Mehr als ${d.maxTax} Münzen je Stück trägt kein Lager.`);
		if (open) throw new CommandError("Hier läuft schon ein Antrag; erst wenn er entschieden ist, kommt der nächste.");
		const kind: MotionKind = taxed ? "steuer" : zone ?? (/^(?:zu|schließen|schliessen|close)$/i.test(text) ? "zu" : /^(?:offen|auf|öffnen|oeffnen|open)$/i.test(text) ? "offen" : "text");
		if (kind === "text" && text.length > 120) throw new NotUnderstood("Ein Antrag hat höchstens 120 Zeichen.");
		if ((kind === "zu" || kind === "offen") && s.closed === (kind === "zu")) throw new CommandError(`${s.name} ist schon ${s.closed ? "geschlossen" : "offen"}.`);
		const m: MotionFields = { motionId: randomBytes(6).toString("hex"), room: s.room, settlementId: s.settlementId, settlementName: s.name, by: c.account!.accountId, byName: c.actor.name, kind, text: kind === "text" ? text : "", endsWorldMs: (await worldNowOf(c.space, c.txn)) + d.voteWorldMs, ...(zone ? { zone: await zoneAt(c, zone, d.zoneRadius) } : {}), ...(taxed ? { tax: Number(taxed[1]) } : {}) };
		try { await c.space.write({ type: "Motion", fields: m as never }, c.txn, FOREVER, { unique: ["room"] }); }
		catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Hier läuft schon ein Antrag; erst wenn er entschieden ist, kommt der nächste."); throw e; }
		await c.space.write({ type: "Vote", fields: { motionId: m.motionId, accountId: m.by, yes: true } satisfies VoteFields as never }, c.txn, FOREVER);
		await msg(c, "*", "world", `${c.actor.name} beantragt im Rathaus von ${s.name}: ${said(m)}. Die Siedler stimmen einen Tag lang ab („stimme ja“ oder „stimme nein“).`);
	},
};

const stimme: Command = {
	key: "stimme", aliases: ["vote", "abstimmen"],
	help: "stimme ja|nein – als Siedler über den laufenden Antrag hier abstimmen; die letzte Stimme zählt",
	async func(c, arg) {
		const w = arg.trim().toLowerCase(), ja = /^(?:ja|yes|dafür|dafuer)$/.test(w), nein = /^(?:nein|no|dagegen)$/.test(w);
		if (!ja && !nein) throw new NotUnderstood("So stimmst du ab: stimme ja, oder stimme nein.");
		const s = await ofSettler(c, "Abstimmen");
		const e = await peek(c.space, { type: "Motion", fields: { room: s.room } }, { txn: c.txn });
		if (!e) throw new CommandError("Hier läuft kein Antrag.");
		const { motionId } = fieldsOf<MotionFields>(e), mine: VoteFields = { motionId, accountId: c.account!.accountId, yes: ja };
		await c.space.takeIfExists({ type: "Vote", fields: { motionId, accountId: mine.accountId } }, 5_000, { txn: c.txn });
		await c.space.write({ type: "Vote", fields: mine as never }, c.txn, FOREVER);
		const votes = [...(await votesOn(c.space, motionId)).filter((v) => v.accountId !== mine.accountId), mine];
		await msg(c, c.actor.charId, "info", `Deine Stimme zählt: ${ja ? "dafür" : "dagegen"}. Bisher ${yes(votes)} dafür, ${no(votes)} dagegen.`);
	},
};

/** The motions whose day is over are decided (in the job of the epochs); without their settlement they lapse. */
export async function motionTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	if (!w.townhall) return 0;
	const now = await worldNowOf(space);
	let ended = 0;
	for (const e of await space.readAll({ type: "Motion" })) {
		if (fieldsOf<MotionFields>(e).endsWorldMs > now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const taken = await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
			if (!taken) { await space.abort(txn); continue; } // a vote or another worker came first; the next count sees it
			const m = fieldsOf<MotionFields>(taken), votes = await votesOn(space, m.motionId), carried = yes(votes) > no(votes);
			const held = await space.takeIfExists({ type: "Settlement", fields: { settlementId: m.settlementId } }, NO_WAIT, { txn });
			if (held) {
				const s = fieldsOf<SettlementFields>(held);
				await space.write({ type: "Settlement", fields: (!carried ? s : m.kind === "zu" || m.kind === "offen" ? { ...s, closed: m.kind === "zu" } : m.kind === "steuer" ? { ...s, tax: m.tax! } : s) as never }, txn, FOREVER);
				if (carried && m.zone) await applyZone(space, m, txn);
				const text = `Abstimmung in ${s.name}: ${said(m)} ist ${carried ? "angenommen" : "abgelehnt"}, ${yes(votes)} dafür, ${no(votes)} dagegen.`;
				await space.write({ type: "Msg", fields: { room: m.room, to: "*", kind: "world", text, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
			}
			await space.commit(txn);
			ended++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	// the votes of what is decided; one cast while its motion ended goes with the next count
	const open = new Set((await space.readAll({ type: "Motion" })).map((e) => fieldsOf<MotionFields>(e).motionId));
	for (const e of await space.readAll({ type: "Vote" })) if (!open.has(fieldsOf<VoteFields>(e).motionId)) await space.takeIfExists({ id: e.id }, NO_WAIT);
	return ended;
}

export const TOWNHALL_COMMANDS: Command[] = [antrag, stimme];
