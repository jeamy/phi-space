// The department store and the counting house, step 7 (docs/siedeln.en.md "Department store versus market board"). A department
// store is a shop anyone may use: `laden` shows its stock, `laden kaufe` and `laden verkaufe` trade with it at prices a simple
// rule leads (empty dear, full cheap), so trade goes on when nobody stands at the market board. It pays from its own till, so
// it mints nothing: its owner fills that with `laden einlegen` and takes the profit with `laden entnehme`. What it turned
// over counts in the rank of the settlements. A few tree seeds grow back on every shelf (world shop.stock, trade.ts restock), one
// of each a world day, as a trader's stock does: what they sell for goes into the till. In a counting house `kredit` lends coins from its till against a pledge kept in
// escrow; `tilge` pays them back with interest and frees it; when the time runs out, the pledge goes to the house.
// `wechsel <n>` writes a bill of exchange there: the n coins lie at the bill itself, so it is worth them wherever it goes
// (passed on, traded, in a hatch, to another region with its holder), and any counting house pays them out against it
// (`wechsel einlösen`); the house keeps a fee for writing it. Nothing is minted and nothing lost.
// A settlement's tax (`antrag steuer`, townhall.ts) is paid on each thing bought at its store, on top of the price, into the
// settlement's warehouse, like the tax on what is taken from it; without a warehouse in the room there is nowhere to keep it.
// Delivery orders fill the shelf: the owner posts `laden bestelle <n> <ding> für <m>`, the order boards of the region show
// it (trade.ts), and anyone brings the things with `laden liefere`, paid from the till. The coins promised stay in the till
// but are spoken for: neither the owner nor a sale to the store takes them, so a delivery is always paid.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type ItemFields, type LoanFields, type ShopOrderFields } from "../../model.ts";
import { decayNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, toPlayer, type CommandCtx } from "../context.ts";
import { peek } from "../../space.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import type { WorldDef } from "../world.ts";
import { ARTICLE, distTo, planOf, putBack, takeNear } from "./build.ts";
import { settlementIn } from "./settlement.ts";
import { consume, move } from "./trade.ts";
import { randomBytes, timeNow } from "../source.ts";

const coinsWord = (n: number) => `${n} Münze${n === 1 ? "" : "n"}`;
const protoName = (w: WorldDef, proto: string) => w.prototypes.find((p) => p.key === proto)?.name ?? proto;
const inside = async (space: SpaceLike, where: string, txn: string | null) => (await space.readAll({ type: "Item", fields: { location: where } }, txn ? { txn } : {})).map((e) => fieldsOf<ItemFields>(e));
/** What the shop asks for a thing with `stock` on its shelf: twice the price empty, half of it at `full` and more. */
export const shopPrice = (base: number, stock: number, full: number) => Math.max(1, Math.round(base * Math.max(0.5, 2 - (1.5 * stock) / full)));

const shopOf = (c: CommandCtx) => { const d = c.world.shop; if (!d) throw new CommandError("In dieser Welt gibt es keine Kaufhäuser."); return d; };
/** The tax on a thing bought at a store and the warehouse it goes to: none without a settlement tax or a warehouse here. */
async function salesTax(c: CommandCtx): Promise<{ tax: number; store: string } | null> {
	const tax = (await settlementIn(c.space, c.actor.room, c.txn))?.tax ?? 0;
	if (!tax) return null;
	const store = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } }, c.txn ? { txn: c.txn } : {})).map((e) => fieldsOf<BuildingFields>(e)).find((b) => planOf(c.world, b.plan)?.store);
	return store ? { tax, store: store.buildId } : null;
}
const take = async (c: CommandCtx, plan: string) => { const r = await takeNear<BuildingFields>(c, "Building", "buildId", 1, (b) => b.plan === plan); return "f" in r ? r.f : null; };

const laden: Command = {
	key: "laden", aliases: ["kaufhaus", "shop"],
	help: "laden – was das Kaufhaus neben dir führt und zu welchem Preis (laden kaufe <ding>; laden verkaufe <ding>; laden liefere <ding> für eine Bestellung; der Besitzer: laden einlegen <n>, laden entnehme <n>, laden bestelle <n> <ding> für <m>, laden storniere <ding>)",
	async func(c, arg) {
		const d = shopOf(c), [word = "", ...rest] = arg.trim().split(/\s+/), tail = rest.join(" ").replace(ARTICLE, "");
		const b = await take(c, d.plan);
		if (!b) throw new CommandError(`Das geht nur direkt neben ${planOf(c.world, d.plan)?.dative ?? "einem Kaufhaus"}.`);
		const held = await inside(c.space, b.buildId, c.txn), coin = c.world.currency, till = held.filter((i) => i.proto === coin), shelf = held.filter((i) => i.proto !== coin);
		const count = (proto: string) => shelf.filter((i) => i.proto === proto).length;
		const orders = (await c.space.readAll({ type: "ShopOrder", fields: { buildId: b.buildId } }, c.txn ? { txn: c.txn } : {})).map((e) => ({ e, f: fieldsOf<ShopOrderFields>(e) }));
		const promised = orders.reduce((n, o) => n + o.f.count * o.f.reward, 0), free = till.length - promised;
		const askFor = (proto: string) => shopPrice(d.prices[proto]!, count(proto), d.full), bid = (proto: string) => Math.max(1, Math.floor(shopPrice(d.prices[proto]!, count(proto) + 1, d.full) * d.buyShare));
		if (!word) {
			await putBack(c, b);
			const lines = [...new Set(shelf.map((i) => i.proto))].filter((p) => d.prices[p]).map((p) => `${protoName(c.world, p)} (${count(p)}): ${coinsWord(askFor(p))}`);
			const wanted = orders.map((o) => `${o.f.count}× ${o.f.protoName} zu ${coinsWord(o.f.reward)}`);
			return msg(c, c.actor.charId, "info", `${b.name} von ${b.ownerName}, in der Kasse ${coinsWord(till.length)}. ${lines.length ? `Im Regal: ${lines.join("; ")}.` : "Das Regal ist leer."} Es kauft: ${Object.keys(d.prices).map((p) => protoName(c.world, p)).join(", ")}.${wanted.length ? ` Bestellt („laden liefere <ding>“): ${wanted.join("; ")}.` : ""}`);
		}
		if (/^(?:kaufe|buy)$/i.test(word)) {
			const it = itemsNamed(c.world, shelf.map((f) => ({ f })) as never as Awaited<ReturnType<typeof inventory>>, tail)[0];
			if (!it || !d.prices[it.f.proto]) throw new CommandError(`Im Regal liegt kein ${tail.slice(0, 30)}.`);
			const price = askFor(it.f.proto), taxed = await salesTax(c), tax = taxed?.tax ?? 0, purse = (await inventory(c)).filter((i) => i.f.proto === coin);
			if (purse.length < price + tax) throw new CommandError(`Dafür brauchst du ${coinsWord(price + tax)}.`);
			for (const m of purse.slice(0, price)) await move(c, m.f, c.actor.charId, b.buildId);
			for (const m of purse.slice(price, price + tax)) await move(c, m.f, c.actor.charId, taxed!.store);
			await move(c, it.f, b.buildId, c.actor.charId);
			await putBack(c, { ...b, turnover: (b.turnover ?? 0) + price });
			await msg(c, "*", "info", `$you() $conj(kaufst|kauft) ${it.f.name} für ${coinsWord(price)} im ${b.name}.`, { templ: true });
			if (tax) await msg(c, c.actor.charId, "info", `${coinsWord(tax)} Steuer gehen ins Lager der Siedlung.`);
			return;
		}
		if (/^(?:verkaufe|sell)$/i.test(word)) {
			const it = itemsNamed(c.world, await inventory(c), tail)[0];
			if (!it) throw new NotUnderstood(`Du trägst nichts, was „${tail.slice(0, 30)}“ heißt.`);
			if (!d.prices[it.f.proto]) throw new CommandError(`${it.f.name} führt das Kaufhaus nicht.`);
			const price = bid(it.f.proto);
			if (free < price) throw new CommandError("Die Kasse des Kaufhauses ist zu leer dafür.");
			await move(c, it.f, c.actor.charId, b.buildId);
			for (const m of till.slice(0, price)) await move(c, m, b.buildId, c.actor.charId);
			await putBack(c, { ...b, turnover: (b.turnover ?? 0) + price });
			return msg(c, "*", "info", `$you() $conj(verkaufst|verkauft) ${it.f.name} für ${coinsWord(price)} ans ${b.name}.`, { templ: true });
		}
		if (/^(?:bestelle|bestellen|order)$/i.test(word)) {
			// laden bestelle <n> <ding> für <m>: the owner's delivery order, m coins each from the till
			if (b.accountId !== c.account?.accountId) throw new CommandError("Bestellen darf nur der Besitzer.");
			const m = /^(\d+)\s+(.+?)\s+(?:für|fuer|for)\s+(\d+)$/i.exec(tail);
			if (!m) throw new NotUnderstood("So geht es: laden bestelle 5 fisch für 2 (Münzen je Stück).");
			const n = Number(m[1]), reward = Number(m[3]), p = c.world.prototypes.find((x) => d.prices[x.key] && (x.key === m[2]!.toLowerCase() || x.name.toLowerCase() === m[2]!.toLowerCase() || x.aliases?.some((a) => a.toLowerCase() === m[2]!.toLowerCase())));
			if (!p) throw new CommandError(`${m[2]!.slice(0, 30)} führt das Kaufhaus nicht.`);
			if (n < 1 || n > d.orderMax || reward < 1) throw new CommandError(`Bestellt werden 1 bis ${d.orderMax} Stück für mindestens 1 Münze.`);
			if (orders.length >= d.orders) throw new CommandError(`Ein Kaufhaus hat höchstens ${d.orders} Bestellungen offen; „laden storniere <ding>“ nimmt eine zurück.`);
			if (orders.some((o) => o.f.proto === p.key)) throw new CommandError(`${p.name} ist schon bestellt.`);
			if (free < n * reward) throw new CommandError(`Dafür müssen ${coinsWord(n * reward)} frei in der Kasse liegen; frei sind ${coinsWord(Math.max(0, free))}.`);
			const o: ShopOrderFields = { orderId: `so-${randomBytes(6).toString("hex")}`, buildId: b.buildId, room: b.room, storeName: b.name, ownerName: b.ownerName, proto: p.key, protoName: p.name, count: n, reward };
			await c.space.write({ type: "ShopOrder", fields: o as never }, c.txn, FOREVER);
			await putBack(c, b);
			return msg(c, c.actor.charId, "info", `${b.name} bestellt ${n}× ${p.name} zu ${coinsWord(reward)}; die Auftragstafeln zeigen es.`);
		}
		if (/^(?:storniere|stornieren|cancel)$/i.test(word)) {
			if (b.accountId !== c.account?.accountId) throw new CommandError("Stornieren darf nur der Besitzer.");
			const o = orders.find((x) => x.f.proto === tail.toLowerCase() || x.f.protoName.toLowerCase() === tail.toLowerCase());
			if (!o) throw new CommandError(`${tail.slice(0, 30) || "Das"} ist nicht bestellt.`);
			if (!(await c.space.takeIfExists({ id: o.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Die Bestellung ist gerade nicht greifbar; bitte noch einmal.");
			await putBack(c, b);
			return msg(c, c.actor.charId, "info", `Die Bestellung von ${o.f.protoName} ist zurückgenommen.`);
		}
		if (/^(?:liefere|liefern|deliver)$/i.test(word)) {
			// anyone but the owner brings what is ordered (the owner would pay itself and count it as turnover), up to what is
			// still wanted, paid piece by piece from the till
			if (b.accountId === c.account?.accountId) throw new CommandError("Die eigene Bestellung beliefert man nicht; leg es mit „laden“ ins Regal oder storniere sie.");
			const am = /^(\d+|alle?|all)\s+(.+)$/i.exec(tail), name = am ? am[2]! : tail, k0 = am && /^\d+$/.test(am[1]!) ? Number(am[1]) : null;
			const it = itemsNamed(c.world, await inventory(c), name)[0];
			if (!it) throw new NotUnderstood(`Du trägst nichts, was „${name.slice(0, 30)}“ heißt.`);
			const o = orders.find((x) => x.f.proto === it.f.proto);
			if (!o) throw new CommandError(`${it.f.name} hat ${b.name} nicht bestellt.`);
			const mine = (await inventory(c)).filter((i) => i.f.proto === it.f.proto), k = Math.min(k0 ?? mine.length, mine.length, o.f.count);
			if (till.length < k * o.f.reward) throw new CommandError("Die Kasse des Kaufhauses ist zu leer dafür.");
			for (const i of mine.slice(0, k)) await move(c, i.f, c.actor.charId, b.buildId);
			for (const m of till.slice(0, k * o.f.reward)) await move(c, m, b.buildId, c.actor.charId);
			if (!(await c.space.takeIfExists({ id: o.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Die Bestellung ist gerade nicht greifbar; bitte noch einmal.");
			if (o.f.count > k) await c.space.write({ type: "ShopOrder", fields: { ...o.f, count: o.f.count - k } as never }, c.txn, FOREVER);
			await putBack(c, { ...b, turnover: (b.turnover ?? 0) + k * o.f.reward });
			return msg(c, "*", "info", `$you() $conj(lieferst|liefert) ${k}× ${it.f.name} ans ${b.name} und $conj(bekommst|bekommt) ${coinsWord(k * o.f.reward)}.`, { templ: true });
		}
		const n = Number(tail);
		if (/^(?:einlegen|deposit|entnehme|entnehmen|withdraw)$/i.test(word) && Number.isInteger(n) && n > 0) {
			if (b.accountId !== c.account?.accountId) throw new CommandError("Die Kasse gehört dem Besitzer.");
			const put = /^(?:einlegen|deposit)$/i.test(word), purse = (await inventory(c)).filter((i) => i.f.proto === coin);
			if ((put ? purse.length : free) < n) throw new CommandError(put || till.length < n ? `Dort sind keine ${coinsWord(n)}.` : `Davon sind ${coinsWord(promised)} für Bestellungen versprochen; frei sind ${coinsWord(Math.max(0, free))}.`);
			if (put) for (const m of purse.slice(0, n)) await move(c, m.f, c.actor.charId, b.buildId);
			else for (const m of till.slice(0, n)) await move(c, m, b.buildId, c.actor.charId);
			await putBack(c, b);
			return msg(c, c.actor.charId, "info", `In der Kasse sind jetzt ${coinsWord(till.length + (put ? n : -n))}.`);
		}
		throw new NotUnderstood("So geht es: laden, laden kaufe <ding>, laden verkaufe <ding>, laden liefere <ding>, laden einlegen <n>, laden entnehme <n>, laden bestelle <n> <ding> für <m>, laden storniere <ding>.");
	},
};

const kredit: Command = {
	key: "kredit", aliases: ["leihe", "credit", "loan"],
	help: "kredit <n> gegen <ding> – am Kontor neben dir Münzen gegen ein Pfand leihen; „tilge“ zahlt sie mit Zinsen zurück, sonst gehört das Pfand dem Kontor; „kredit“ allein zeigt deine Schuld",
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
	help: "tilge – am Kontor, bei dem du geliehen hast, den Kredit mit Zinsen zurückzahlen und das Pfand auslösen",
	async func(c) {
		const d = c.world.bank;
		if (!d) throw new CommandError("In dieser Welt gibt es keine Kontore.");
		const e = await c.space.takeIfExists({ type: "Loan", fields: { accountId: c.account?.accountId ?? "" } }, NO_WAIT, { txn: c.txn });
		if (!e) throw new CommandError("Du hast keinen Kredit.");
		const l = fieldsOf<LoanFields>(e), purse = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		const house = await peek(c.space, { type: "Building", fields: { buildId: l.buildId } }, { txn: c.txn });
		if (house && (fieldsOf<BuildingFields>(house).room !== c.actor.room || distTo(c.actor, fieldsOf<BuildingFields>(house)) > 1)) throw new CommandError("Getilgt wird am Kontor, bei dem du geliehen hast.");
		// the house is gone: nobody is owed the coins (the loan's end would give the pledge back as well, loanTick), so
		// they stay with the debtor; destroyed, they would be lost
		if (!house) {
			for (const p of await inside(c.space, l.loanId, c.txn)) await move(c, p, l.loanId, c.actor.charId);
			return void (await msg(c, c.actor.charId, "info", "Das Kontor steht nicht mehr: niemand nimmt deine Münzen, und du bekommst dein Pfand wieder."));
		}
		if (purse.length < l.owed) throw new CommandError(`Dafür brauchst du ${coinsWord(l.owed)}.`);
		for (const m of purse.slice(0, l.owed)) await move(c, m.f, c.actor.charId, l.buildId);
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
			await toPlayer(space, { room: l.room, to: l.charId, kind: "info", text: standing ? "Dein Kredit ist abgelaufen; das Pfand gehört jetzt dem Kontor." : "Dein Kontor steht nicht mehr; das Pfand ist wieder deins.", from: "", at: timeNow() }, txn);
			await space.commit(txn);
			ended++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return ended;
}

/** What a bill of exchange is worth: the coins lying at it. */
const worthOf = async (c: CommandCtx, bill: ItemFields) => (await inside(c.space, bill.itemId, c.txn)).filter((i) => i.proto === c.world.currency);

const wechsel: Command = {
	key: "wechsel", aliases: ["wechselbrief", "bill", "note"],
	help: "wechsel <n> – am Kontor neben dir n Münzen in einen Wechsel legen, den du weitergeben kannst; „wechsel einlösen“ zahlt jeden Wechsel, den du trägst, an einem Kontor aus; „wechsel“ allein zeigt deine",
	async func(c, arg) {
		const d = c.world.bank, n = d?.note;
		if (!d || !n) throw new CommandError("In dieser Welt gibt es keine Wechsel.");
		const word = arg.trim().toLowerCase(), bills = (await inventory(c)).filter((i) => i.f.proto === n.proto);
		if (!word) {
			const worth = await Promise.all(bills.map(async (b) => (await worthOf(c, b.f)).length));
			return msg(c, c.actor.charId, "info", bills.length ? `Du trägst ${bills.length} Wechsel über zusammen ${coinsWord(worth.reduce((a, x) => a + x, 0))}; jedes Kontor löst sie ein („wechsel einlösen“).` : `Du trägst keinen Wechsel. „wechsel <n>“ legt am Kontor n Münzen in einen, für ${coinsWord(n.fee)} Gebühr.`);
		}
		const b = await take(c, d.plan);
		if (!b) throw new CommandError(`Das geht nur direkt neben ${planOf(c.world, d.plan)?.dative ?? "einem Kontor"}.`);
		if (/^(?:einlösen|einloesen|einlöse|löse|loese|redeem|cash)$/.test(word)) {
			if (!bills.length) throw new CommandError("Du trägst keinen Wechsel.");
			let got = 0;
			for (const bill of bills) {
				for (const coin of await worthOf(c, bill.f)) { await move(c, coin, bill.f.itemId, c.actor.charId); got++; }
				await consume(c, bill.f, c.actor.charId);
			}
			await putBack(c, b);
			return msg(c, c.actor.charId, "info", `Das Kontor zahlt dir ${bills.length === 1 ? "den Wechsel" : `${bills.length} Wechsel`} aus: ${coinsWord(got)}.`);
		}
		if (!c.account || c.account.guest) throw new CommandError("Gäste schreiben keine Wechsel; registriere dich dafür.");
		const m = /^(\d+)(?:\s+münzen?|\s+muenzen?)?$/.exec(word);
		if (!m) throw new NotUnderstood("So geht es: wechsel 20, wechsel einlösen");
		const k = Number(m[1]);
		if (k < 1 || k > n.max) throw new CommandError(`Ein Wechsel hält 1 bis ${coinsWord(n.max)}.`);
		const purse = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		if (purse.length < k + n.fee) throw new CommandError(`Dafür brauchst du ${coinsWord(k + n.fee)} (${coinsWord(n.fee)} nimmt das Kontor).`);
		const p = await resolvePrototype(c.space, n.proto);
		if (!p) throw new CommandError("Das Kontor hat gerade kein Papier.");
		const bill = await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 }, { name: `Wechsel über ${coinsWord(k)}` });
		for (const coin of purse.slice(0, k)) await move(c, coin.f, c.actor.charId, bill.itemId);
		for (const coin of purse.slice(k, k + n.fee)) await move(c, coin.f, c.actor.charId, b.buildId);
		await putBack(c, b);
		await msg(c, c.actor.charId, "info", `Das Kontor schreibt dir einen Wechsel über ${coinsWord(k)}; ${coinsWord(n.fee)} behält es. Jedes Kontor zahlt ihn aus, auch an jemand anderen.`);
	},
};

export const SHOP_COMMANDS: Command[] = [laden, kredit, tilge, wechsel];
