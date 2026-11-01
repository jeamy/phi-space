// The department store and the counting house, step 7 (docs/siedeln.en.md "Department store versus market board"). A department
// store is a shop anyone may use: `laden` shows its stock, `laden kaufe` and `laden verkaufe` trade with it at prices a simple
// rule leads (empty dear, full cheap), so trade goes on when nobody stands at the market board. It pays from its own till, so
// it mints nothing: its owner fills that with `laden einlegen` and takes the profit with `laden entnehme`. What it turned
// over counts in the rank of the settlements. In a counting house `kredit` lends coins from its till against a pledge kept in
// escrow; `tilge` pays them back with interest and frees it; when the time runs out, the pledge goes to the house.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type ItemFields, type LoanFields } from "../../model.ts";
import { decayNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, type CommandCtx } from "../context.ts";
import { peek } from "../../space.ts";
import type { WorldDef } from "../world.ts";
import { ARTICLE, distTo, planOf, putBack, takeNear } from "./build.ts";
import { consume, move } from "./trade.ts";

const coinsWord = (n: number) => `${n} Münze${n === 1 ? "" : "n"}`;
const protoName = (w: WorldDef, proto: string) => w.prototypes.find((p) => p.key === proto)?.name ?? proto;
const inside = async (space: SpaceLike, where: string, txn: string | null) => (await space.readAll({ type: "Item", fields: { location: where } }, txn ? { txn } : {})).map((e) => fieldsOf<ItemFields>(e));
/** What the shop asks for a thing with `stock` on its shelf: twice the price empty, half of it at `full` and more. */
export const shopPrice = (base: number, stock: number, full: number) => Math.max(1, Math.round(base * Math.max(0.5, 2 - (1.5 * stock) / full)));

const shopOf = (c: CommandCtx) => { const d = c.world.shop; if (!d) throw new CommandError("In dieser Welt gibt es keine Kaufhäuser."); return d; };
const take = async (c: CommandCtx, plan: string) => { const r = await takeNear<BuildingFields>(c, "Building", "buildId", 1, (b) => b.plan === plan); return "f" in r ? r.f : null; };

const laden: Command = {
	key: "laden", aliases: ["kaufhaus", "shop"],
	help: "laden – was das Kaufhaus neben dir führt und zu welchem Preis (laden kaufe <ding>; laden verkaufe <ding>; der Besitzer: laden einlegen <n>, laden entnehme <n>)",
	async func(c, arg) {
		const d = shopOf(c), [word = "", ...rest] = arg.trim().split(/\s+/), tail = rest.join(" ").replace(ARTICLE, "");
		const b = await take(c, d.plan);
		if (!b) throw new CommandError(`Das geht nur direkt neben ${planOf(c.world, d.plan)?.dative ?? "einem Kaufhaus"}.`);
		const held = await inside(c.space, b.buildId, c.txn), coin = c.world.currency, till = held.filter((i) => i.proto === coin), shelf = held.filter((i) => i.proto !== coin);
		const count = (proto: string) => shelf.filter((i) => i.proto === proto).length;
		const askFor = (proto: string) => shopPrice(d.prices[proto]!, count(proto), d.full), bid = (proto: string) => Math.max(1, Math.floor(shopPrice(d.prices[proto]!, count(proto) + 1, d.full) * d.buyShare));
		if (!word) {
			await putBack(c, b);
			const lines = [...new Set(shelf.map((i) => i.proto))].filter((p) => d.prices[p]).map((p) => `${protoName(c.world, p)} (${count(p)}): ${coinsWord(askFor(p))}`);
			return msg(c, c.actor.charId, "info", `${b.name} von ${b.ownerName}, in der Kasse ${coinsWord(till.length)}. ${lines.length ? `Im Regal: ${lines.join("; ")}.` : "Das Regal ist leer."} Es kauft: ${Object.keys(d.prices).map((p) => protoName(c.world, p)).join(", ")}.`);
		}
		if (/^(?:kaufe|buy)$/i.test(word)) {
			const it = itemsNamed(c.world, shelf.map((f) => ({ f })) as never as Awaited<ReturnType<typeof inventory>>, tail)[0];
			if (!it || !d.prices[it.f.proto]) throw new CommandError(`Im Regal liegt kein ${tail.slice(0, 30)}.`);
			const price = askFor(it.f.proto), purse = (await inventory(c)).filter((i) => i.f.proto === coin);
			if (purse.length < price) throw new CommandError(`Dafür brauchst du ${coinsWord(price)}.`);
			for (const m of purse.slice(0, price)) await move(c, m.f, c.actor.charId, b.buildId);
			await move(c, it.f, b.buildId, c.actor.charId);
			await putBack(c, { ...b, turnover: (b.turnover ?? 0) + price });
			return msg(c, "*", "info", `$you() $conj(kaufst|kauft) ${it.f.name} für ${coinsWord(price)} im ${b.name}.`, { templ: true });
		}
		if (/^(?:verkaufe|sell)$/i.test(word)) {
			const it = itemsNamed(c.world, await inventory(c), tail)[0];
			if (!it) throw new NotUnderstood(`Du trägst nichts, was „${tail.slice(0, 30)}“ heißt.`);
			if (!d.prices[it.f.proto]) throw new CommandError(`${it.f.name} führt das Kaufhaus nicht.`);
			const price = bid(it.f.proto);
			if (till.length < price) throw new CommandError("Die Kasse des Kaufhauses ist zu leer dafür.");
			await move(c, it.f, c.actor.charId, b.buildId);
			for (const m of till.slice(0, price)) await move(c, m, b.buildId, c.actor.charId);
			await putBack(c, { ...b, turnover: (b.turnover ?? 0) + price });
			return msg(c, "*", "info", `$you() $conj(verkaufst|verkauft) ${it.f.name} für ${coinsWord(price)} ans ${b.name}.`, { templ: true });
		}
		const n = Number(tail);
		if (/^(?:einlegen|deposit|entnehme|entnehmen|withdraw)$/i.test(word) && Number.isInteger(n) && n > 0) {
			if (b.accountId !== c.account?.accountId) throw new CommandError("Die Kasse gehört dem Besitzer.");
			const put = /^(?:einlegen|deposit)$/i.test(word), purse = (await inventory(c)).filter((i) => i.f.proto === coin);
			if ((put ? purse.length : till.length) < n) throw new CommandError(`Dort sind keine ${coinsWord(n)}.`);
			if (put) for (const m of purse.slice(0, n)) await move(c, m.f, c.actor.charId, b.buildId);
			else for (const m of till.slice(0, n)) await move(c, m, b.buildId, c.actor.charId);
			await putBack(c, b);
			return msg(c, c.actor.charId, "info", `In der Kasse sind jetzt ${coinsWord(till.length + (put ? n : -n))}.`);
		}
		throw new NotUnderstood("So geht es: laden, laden kaufe <ding>, laden verkaufe <ding>, laden einlegen <n>, laden entnehme <n>.");
	},
};

const kredit: Command = {
	key: "kredit", aliases: ["leihe", "credit", "loan"],
	help: "kredit <n> gegen <ding> – am Kontor neben dir Münzen gegen ein Pfand leihen; „tilge“ zahlt sie mit Zinsen zurück, sonst gehört das Pfand dem Kontor",
	async func(c, arg) {
		const d = c.world.bank;
		if (!d) throw new CommandError("In dieser Welt gibt es keine Kontore.");
		if (!c.account || c.account.guest) throw new CommandError("Gäste bekommen keinen Kredit; registriere dich dafür.");
		const mine = await peek(c.space, { type: "Loan", fields: { accountId: c.account.accountId } }, { txn: c.txn });
		const now = await decayNowOf(c.space, c.txn);
		if (!arg.trim()) return msg(c, c.actor.charId, "info", mine ? `Du schuldest ${coinsWord(fieldsOf<LoanFields>(mine).owed)}, noch etwa ${Math.max(1, Math.ceil((fieldsOf<LoanFields>(mine).untilWorldMs - now) / 86_400_000))} Tage.` : "Du hast keinen Kredit. „kredit <n> gegen <ding>“ leiht am Kontor Münzen gegen ein Pfand.");
		const m = /^(\d+)\s+gegen\s+(.+)$/i.exec(arg.trim());
		if (!m) throw new NotUnderstood("So geht es: kredit 5 gegen perle");
		if (mine) throw new CommandError("Du hast schon einen Kredit; tilge ihn erst.");
		const b = await take(c, d.plan);
		if (!b) throw new CommandError(`Das geht nur direkt neben ${planOf(c.world, d.plan)?.dative ?? "einem Kontor"}.`);
		const it = itemsNamed(c.world, await inventory(c), m[2]!.replace(ARTICLE, ""))[0];
		if (!it) throw new NotUnderstood(`Du trägst nichts, was „${m[2]!.slice(0, 30)}“ heißt.`);
		const n = Number(m[1]), worth = c.world.shop?.prices[it.f.proto] ?? 0, till = (await inside(c.space, b.buildId, c.txn)).filter((i) => i.proto === c.world.currency);
		if (n < 1 || n > worth * d.pledgeShare) throw new CommandError(worth ? `Auf ${it.f.name} gibt es höchstens ${coinsWord(Math.floor(worth * d.pledgeShare))}.` : `${it.f.name} nimmt das Kontor nicht als Pfand.`);
		if (till.length < n) throw new CommandError("Die Kasse des Kontors ist zu leer dafür.");
		const loan: LoanFields = { loanId: `loan-${randomBytes(6).toString("hex")}`, buildId: b.buildId, room: b.room, accountId: c.account.accountId, charId: c.actor.charId, charName: c.actor.name, owed: Math.ceil(n * (1 + d.interest)), untilWorldMs: now + d.termWorldMs };
		await move(c, it.f, c.actor.charId, loan.loanId);
		for (const coin of till.slice(0, n)) await move(c, coin, b.buildId, c.actor.charId);
		await c.space.write({ type: "Loan", fields: loan as never }, c.txn, FOREVER);
		await putBack(c, b);
		await msg(c, c.actor.charId, "info", `Du leihst ${coinsWord(n)} gegen ${it.f.name}. Zurück gehen ${coinsWord(loan.owed)} („tilge“), binnen ${Math.round(d.termWorldMs / 86_400_000)} Tagen.`);
	},
};

const tilge: Command = {
	key: "tilge", aliases: ["tilgen", "repay"],
	help: "tilge – am Kontor deinen Kredit zurückzahlen und das Pfand auslösen",
	async func(c) {
		const d = c.world.bank;
		if (!d) throw new CommandError("In dieser Welt gibt es keine Kontore.");
		const e = await c.space.takeIfExists({ type: "Loan", fields: { accountId: c.account?.accountId ?? "" } }, NO_WAIT, { txn: c.txn });
		if (!e) throw new CommandError("Du hast keinen Kredit.");
		const l = fieldsOf<LoanFields>(e), purse = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		const house = await peek(c.space, { type: "Building", fields: { buildId: l.buildId } }, { txn: c.txn });
		if (house && (fieldsOf<BuildingFields>(house).room !== c.actor.room || distTo(c.actor, fieldsOf<BuildingFields>(house)) > 1)) throw new CommandError("Getilgt wird am Kontor, bei dem du geliehen hast.");
		if (purse.length < l.owed) throw new CommandError(`Dafür brauchst du ${coinsWord(l.owed)}.`);
		for (const m of purse.slice(0, l.owed)) { if (house) await move(c, m.f, c.actor.charId, l.buildId); else await consume(c, m.f, c.actor.charId); }
		for (const p of await inside(c.space, l.loanId, c.txn)) await move(c, p, l.loanId, c.actor.charId);
		await msg(c, c.actor.charId, "info", `Du zahlst ${coinsWord(l.owed)} zurück und bekommst dein Pfand wieder.`);
	},
};

/** Loans whose time ran out end: the pledge goes to the house, or back to the debtor when the house is gone (job "epoch"). */
export async function loanTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	if (!w.bank) return 0;
	const now = await decayNowOf(space);
	let ended = 0;
	for (const e of await space.readAll({ type: "Loan" })) {
		if (fieldsOf<LoanFields>(e).untilWorldMs > now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			const l = fieldsOf<LoanFields>(t), standing = (await space.count({ type: "Building", fields: { buildId: l.buildId } })) > 0, to = standing ? l.buildId : l.charId;
			for (const i of await space.readAll({ type: "Item", fields: { location: l.loanId } })) {
				const it = await space.takeIfExists({ id: i.id }, NO_WAIT, { txn });
				if (it) await space.write({ type: it.type, types: it.types.slice(1), fields: { ...it.fields, location: to } as never }, txn, FOREVER);
			}
			await space.write({ type: "Msg", fields: { room: l.room, to: l.charId, kind: "info", text: standing ? "Dein Kredit ist abgelaufen; das Pfand gehört jetzt dem Kontor." : "Dein Kontor steht nicht mehr; das Pfand ist wieder deins.", from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: l.charId, kind: "info" }));
			await space.commit(txn);
			ended++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return ended;
}

export const SHOP_COMMANDS: Command[] = [laden, kredit, tilge];
