// Trade and economy (docs/phasen.md Phase 4). Every exchange moves its items in the command's transaction: a trade takes
// both sides and writes them swapped, a purchase takes the listing, the coins and the item, a craft takes the inputs and
// writes the output. When anything is missing the transaction aborts and nothing has moved, so an item is never doubled
// or lost however many trades race each other.
import { randomBytes, randomInt } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, type AccountFields, type CharacterFields, type ItemFields, type ListingFields, type OfferFields, type OrderFields } from "../../model.ts";
import { readExisting, StillHeld } from "../../space.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, type CommandCtx } from "../context.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import { gameMs } from "../time.ts";
import type { WorldDef } from "../world.ts";

/** How long a trade offer waits for an answer (real time: the other one is at the keyboard now). */
const OFFER_MS = 120_000;

type Inv = Array<{ e: Taken; f: ItemFields }>;
const names = (f: ItemFields) => [f.name, ...f.aliases].map((s) => s.toLowerCase());

/** "2 muschel, treibholz" → [{ name: "muschel", count: 2 }, { name: "treibholz", count: 1 }]. */
export function parseSpec(s: string): Array<{ name: string; count: number }> {
	return s.split(/,|\sund\s|\sand\s/i).map((p) => p.trim()).filter(Boolean).map((p) => {
		const m = /^(\d+)\s*x?\s+(.+)$/i.exec(p);
		return m ? { name: m[2]!.trim().toLowerCase(), count: Math.min(50, Math.max(1, Number(m[1]))) } : { name: p.toLowerCase(), count: 1 };
	});
}

/** Items of `inv` that satisfy `spec` (each item used once), or the name of what is missing. */
function pick(inv: Inv, spec: Array<{ name: string; count: number }>): { items: Inv } | { missing: string } {
	const used = new Set<string>(), items: Inv = [];
	for (const want of spec) {
		const hits = inv.filter((i) => !used.has(i.f.itemId) && (names(i.f).includes(want.name) || i.f.proto === want.name));
		if (hits.length < want.count) return { missing: `${want.count}× ${want.name}` };
		for (const h of hits.slice(0, want.count)) { used.add(h.f.itemId); items.push(h); }
	}
	return { items };
}
const byProto = (inv: Inv, proto: string, count: number): Inv | null => { const hits = inv.filter((i) => i.f.proto === proto); return hits.length >= count ? hits.slice(0, count) : null; };

/** Takes an item where it is and writes it at `location` (a pack, or the market's escrow). */
async function move(c: CommandCtx, item: ItemFields, from: string, to: string, extra: Partial<ItemFields> = {}): Promise<void> {
	const e = await c.space.take({ type: "Item", fields: { itemId: item.itemId, location: from } }, NO_WAIT, { txn: c.txn });
	if (!e) throw new CommandError(`${item.name} ist nicht mehr da.`);
	const { listing: _l, seller: _s, ...rest } = fieldsOf<ItemFields>(e);
	await c.space.write({ type: e.type, types: e.types.slice(1), fields: { ...rest, location: to, x: -1, y: -1, ...extra } as never }, c.txn, FOREVER);
}
/** Takes an item for good (used up). */
async function consume(c: CommandCtx, item: ItemFields, from: string): Promise<void> {
	if (!(await c.space.take({ type: "Item", fields: { itemId: item.itemId, location: from } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${item.name} ist nicht mehr da.`);
}

function noGuest(c: CommandCtx): void {
	if (!c.account || c.account.guest) throw new CommandError("Gäste können nicht tauschen oder handeln; registriere dich dafür.");
}
const list = (xs: string[]) => xs.join(", ");

const offer: Command = {
	key: "offer", aliases: ["biete", "tausche"],
	help: "offer <dinge> an <person> [für <dinge>] – einen Tausch anbieten (offer zurück nimmt ihn zurück)",
	async func(c, arg) {
		noGuest(c);
		if (/^(zurück|zurueck|withdraw)$/i.test(arg.trim())) {
			let n = 0;
			for (const e of await c.space.readAll({ type: "Offer", fields: { from: c.actor.charId } })) if (await c.space.take({ type: "Offer", id: e.id }, NO_WAIT, { txn: c.txn })) n++;
			return msg(c, c.actor.charId, "info", n ? `${n} Angebot${n === 1 ? "" : "e"} zurückgenommen.` : "Du hast kein offenes Angebot.");
		}
		const m = /^(.+?)\s+(?:an|to)\s+(\S+)(?:\s+(?:für|fuer|for)\s+(.+))?$/i.exec(arg.trim());
		if (!m) throw new CommandError("So geht es: offer <dinge> an <person> [für <dinge>], z. B. offer treibholz an Bert für münze");
		const got = pick(await inventory(c), parseSpec(m[1]!));
		if ("missing" in got) throw new CommandError(`Du hast nicht: ${got.missing}.`);
		const who = (await c.space.readAll({ type: "Character", fields: { room: c.actor.room } })).map((e) => fieldsOf<CharacterFields>(e)).find((ch) => ch.charId !== c.actor.charId && ch.name.toLowerCase() === m[2]!.toLowerCase());
		if (!who) throw new CommandError(`Hier ist niemand namens „${m[2]!.slice(0, 30)}“.`);
		const want = m[3] ? parseSpec(m[3]) : [];
		const o: OfferFields = { offerId: `o-${randomBytes(5).toString("hex")}`, from: c.actor.charId, fromName: c.actor.name, to: who.charId, toName: who.name, give: got.items.map((i) => i.f.itemId), giveNames: got.items.map((i) => i.f.name), want, room: c.actor.room, at: Date.now() };
		await c.space.write({ type: "Offer", fields: o as never }, c.txn, OFFER_MS);
		const wants = want.length ? ` für ${list(want.map((w) => `${w.count}× ${w.name}`))}` : " als Geschenk";
		await msg(c, who.charId, "info", `${c.actor.name} bietet dir ${list(o.giveNames)}${wants} an. „accept ${c.actor.name}“ nimmt an, „decline ${c.actor.name}“ lehnt ab.`);
		await msg(c, c.actor.charId, "info", `Du bietest ${who.name} ${list(o.giveNames)}${wants} an.`);
	},
};

/** The offer to the actor from `name` (or the newest one). */
async function offerFor(c: CommandCtx, name: string): Promise<{ e: Taken; f: OfferFields } | null> {
	const all = (await c.space.readAll({ type: "Offer", fields: { to: c.actor.charId } })).map((e) => ({ e, f: fieldsOf<OfferFields>(e) }));
	const mine = name ? all.filter((o) => o.f.fromName.toLowerCase() === name.trim().toLowerCase()) : all;
	return mine.sort((a, b) => b.f.at - a.f.at)[0] ?? null;
}

const accept: Command = {
	key: "accept", aliases: ["annehmen", "nimm-an"],
	help: "accept [person] – ein Tauschangebot annehmen (alles wechselt auf einmal oder gar nicht)",
	async func(c, arg) {
		noGuest(c);
		const o = await offerFor(c, arg);
		if (!o) throw new CommandError("Dir liegt kein Angebot vor.");
		if (!(await c.space.take({ type: "Offer", id: o.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Das Angebot ist nicht mehr da.");
		const from = await c.space.readIfExists({ type: "Character", fields: { charId: o.f.from } }, 2_000);
		if (!from || fieldsOf<CharacterFields>(from).room !== c.actor.room) throw new CommandError(`${o.f.fromName} ist nicht mehr hier.`);
		const theirs = await c.space.readIfExists({ type: "Account", fields: { accountId: fieldsOf<CharacterFields>(from).accountId } }, 2_000);
		if (!theirs || fieldsOf<AccountFields>(theirs).guest) throw new CommandError("Mit Gästen kann man nicht tauschen.");
		// their side: exactly the items offered, still in their pack
		for (const id of o.f.give) {
			const e = await c.space.readIfExists({ type: "Item", fields: { itemId: id, location: o.f.from } }, NO_WAIT);
			if (!e) throw new CommandError(`Das Angebot gilt nicht mehr: ${o.f.fromName} hat nicht mehr alles.`);
			await move(c, fieldsOf<ItemFields>(e), o.f.from, c.actor.charId);
		}
		// my side: what they want, from my pack
		const got = pick(await inventory(c), o.f.want);
		if ("missing" in got) throw new CommandError(`Dir fehlt für diesen Tausch: ${got.missing}.`);
		for (const i of got.items) await move(c, i.f, c.actor.charId, o.f.from);
		const back = got.items.length ? ` gegen ${list(got.items.map((i) => i.f.name))}` : "";
		await msg(c, o.f.from, "info", `${c.actor.name} nimmt dein Angebot an: ${list(o.f.giveNames)}${back}.`);
		await msg(c, c.actor.charId, "info", `Tausch mit ${o.f.fromName}: du bekommst ${list(o.f.giveNames)}${back}.`);
	},
};

const decline: Command = {
	key: "decline", aliases: ["ablehnen"],
	help: "decline [person] – ein Tauschangebot ablehnen",
	async func(c, arg) {
		const o = await offerFor(c, arg);
		if (!o || !(await c.space.take({ type: "Offer", id: o.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Dir liegt kein Angebot vor.");
		await msg(c, o.f.from, "info", `${c.actor.name} lehnt dein Angebot ab.`);
		await msg(c, c.actor.charId, "info", `Du lehnst das Angebot von ${o.f.fromName} ab.`);
	},
};

/** The listings of one market board, numbered in order of posting. */
async function listings(space: SpaceLike, room: string): Promise<Array<{ e: Taken; f: ListingFields }>> {
	return (await space.readAll({ type: "Listing", fields: { room } })).map((e) => ({ e, f: fieldsOf<ListingFields>(e) })).sort((a, b) => a.f.at - b.f.at || a.f.listingId.localeCompare(b.f.listingId));
}

const market: Command = {
	key: "market", aliases: ["markt"],
	help: "market – das Marktbrett: market biete <ding> für <n>, market kaufe <nr>, market zurück <nr> (Preise in Münzen)",
	async func(c, arg) {
		if (!c.world.market.rooms.includes(c.actor.room)) throw new CommandError(`Hier steht kein Marktbrett. Marktbretter stehen in: ${roomNames(c.world, c.world.market.rooms)}.`);
		const [verb = "", ...rest] = arg.trim().split(/\s+/);
		const all = await listings(c.space, c.actor.room);
		const nr = (s: string | undefined) => { const n = Number(s); if (!Number.isInteger(n) || n < 1 || n > all.length) throw new CommandError("Diese Nummer steht nicht auf dem Brett. „markt“ zeigt es."); return all[n - 1]!; };
		const coin = c.world.currency;
		if (!verb) {
			return msg(c, c.actor.charId, "info", all.length ? ["Marktbrett:", ...all.map((l, i) => `  ${i + 1}. ${l.f.itemName} für ${l.f.price} Münze${l.f.price === 1 ? "" : "n"} (von ${l.f.sellerName})`)].join("\n") : "Das Marktbrett ist leer. „markt biete <ding> für <n>“ stellt etwas ein.");
		}
		noGuest(c);
		if (/^(biete|sell|verkaufe)$/i.test(verb)) {
			const m = /^(.+?)\s+(?:für|fuer|for)\s+(\d+)$/i.exec(rest.join(" "));
			if (!m) throw new CommandError("So geht es: markt biete <ding> für <n>");
			const price = Number(m[2]);
			if (price < 1 || price > 1000) throw new CommandError("Ein Preis liegt zwischen 1 und 1000 Münzen.");
			const got = pick(await inventory(c), parseSpec(m[1]!).slice(0, 1).map((s) => ({ ...s, count: 1 })));
			if ("missing" in got) throw new CommandError(`Du hast nicht: ${got.missing}.`);
			const item = got.items[0]!.f, listingId = `l-${randomBytes(5).toString("hex")}`;
			await move(c, item, c.actor.charId, "market", { listing: listingId, seller: c.actor.charId });
			await c.space.write({ type: "Listing", fields: { listingId, seller: c.actor.charId, sellerName: c.actor.name, itemId: item.itemId, itemName: item.name, price, room: c.actor.room, at: Date.now() } satisfies ListingFields as never }, c.txn, gameMs(c.world.market.listMs));
			return msg(c, "*", "info", `$you() $conj(hängst|hängt) ${item.name} für ${price} Münze${price === 1 ? "" : "n"} ans Marktbrett.`, { templ: true });
		}
		if (/^(kaufe|buy)$/i.test(verb)) {
			const l = nr(rest[0]);
			if (l.f.seller === c.actor.charId) throw new CommandError("Das ist dein eigenes Angebot; „markt zurück“ holt es zurück.");
			if (!(await c.space.take({ type: "Listing", id: l.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – jemand anderes kauft gerade.");
			const coins = byProto(await inventory(c), coin, l.f.price);
			if (!coins) throw new CommandError(`Dafür brauchst du ${l.f.price} Münze${l.f.price === 1 ? "" : "n"}.`);
			for (const m of coins) await move(c, m.f, c.actor.charId, l.f.seller);
			const item = await c.space.readIfExists({ type: "Item", fields: { itemId: l.f.itemId, location: "market" } }, NO_WAIT);
			if (!item) throw new CommandError("Die Ware ist nicht mehr am Brett.");
			await move(c, fieldsOf<ItemFields>(item), "market", c.actor.charId);
			await msg(c, l.f.seller, "info", `${c.actor.name} kauft dein ${l.f.itemName} für ${l.f.price} Münze${l.f.price === 1 ? "" : "n"}.`);
			return msg(c, "*", "info", `$you() $conj(kaufst|kauft) ${l.f.itemName} vom Marktbrett.`, { templ: true });
		}
		if (/^(zurück|zurueck|withdraw)$/i.test(verb)) {
			const l = nr(rest[0]);
			if (l.f.seller !== c.actor.charId) throw new CommandError("Das ist nicht dein Angebot.");
			if (!(await c.space.take({ type: "Listing", id: l.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – jemand kauft es gerade.");
			const item = await c.space.readIfExists({ type: "Item", fields: { itemId: l.f.itemId, location: "market" } }, NO_WAIT);
			if (item) await move(c, fieldsOf<ItemFields>(item), "market", c.actor.charId);
			return msg(c, c.actor.charId, "info", `Du holst ${l.f.itemName} vom Marktbrett zurück.`);
		}
		throw new CommandError("Am Marktbrett: markt, markt biete <ding> für <n>, markt kaufe <nr>, markt zurück <nr>.");
	},
};

const craft: Command = {
	key: "craft", aliases: ["baue", "herstellen", "fertige"],
	help: "craft [rezept] – etwas herstellen; ohne Rezept die Liste",
	async func(c, arg) {
		const rs = c.world.recipes;
		if (!arg) {
			const show = (r: (typeof rs)[number]) => `  ${r.key}: ${list(r.needs.map((n) => `${n.count}× ${n.proto}`))}${r.tool ? `, Werkzeug: ${r.tool}` : ""}`;
			return msg(c, c.actor.charId, "info", ["Rezepte:", ...rs.map(show)].join("\n"));
		}
		const a = arg.trim().toLowerCase();
		const r = rs.find((x) => x.key === a || x.name.toLowerCase() === a);
		if (!r) throw new CommandError(`Ein Rezept „${arg.slice(0, 30)}“ gibt es nicht. „craft“ zeigt die Rezepte.`);
		const inv = await inventory(c);
		const used = new Set<string>(), inputs: Inv = [];
		for (const n of r.needs) {
			const hits = inv.filter((i) => i.f.proto === n.proto && !used.has(i.f.itemId)).slice(0, n.count);
			if (hits.length < n.count) throw new CommandError(`Dir fehlt: ${n.count}× ${n.proto}.`);
			hits.forEach((h) => { used.add(h.f.itemId); inputs.push(h); });
		}
		const tool = r.tool ? inv.find((i) => i.f.proto === r.tool && !used.has(i.f.itemId)) : undefined;
		if (r.tool && !tool) throw new CommandError(`Dafür brauchst du ein Werkzeug: ${r.tool}.`);
		for (const i of inputs) await consume(c, i.f, c.actor.charId);
		let broke = false;
		if (tool) {
			const left = (tool.f.wear ?? 1) - 1;
			if (left <= 0) { await consume(c, tool.f, c.actor.charId); broke = true; }
			else await move(c, tool.f, c.actor.charId, c.actor.charId, { wear: left });
		}
		const p = await resolvePrototype(c.space, r.makes);
		if (!p) throw new CommandError("Das Rezept ist kaputt.");
		await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 });
		await msg(c, "*", "info", `$you() $conj(stellst|stellt) ${p.name} her.${broke ? ` Das ${tool!.f.name} zerbricht dabei.` : ""}`, { templ: true });
	},
};

async function ordersOf(space: SpaceLike): Promise<Array<{ e: Taken; f: OrderFields }>> {
	return (await space.readAll({ type: "Order" })).map((e) => ({ e, f: fieldsOf<OrderFields>(e) })).sort((a, b) => a.f.orderId.localeCompare(b.f.orderId));
}

const order: Command = {
	key: "order", aliases: ["auftrag", "auftraege", "aufträge"],
	help: "order – die Auftragstafel: order nimm <nr>, order liefere, order aufgeben (Lohn in Münzen)",
	async func(c, arg) {
		if (!c.world.orders.rooms.includes(c.actor.room)) throw new CommandError(`Hier hängt keine Auftragstafel. Tafeln hängen in: ${roomNames(c.world, c.world.orders.rooms)}.`);
		const [verb = "", n] = arg.trim().split(/\s+/);
		// the open orders of this board; one's own order can be delivered at any board
		const all = await ordersOf(c.space);
		const open = all.filter((o) => !o.f.takenBy && o.f.room === c.actor.room), mine = all.find((o) => o.f.takenBy === c.actor.charId);
		const reward = (o: OrderFields) => `${o.reward.count} Münze${o.reward.count === 1 ? "" : "n"}`;
		if (!verb) {
			const lines = open.map((o, i) => `  ${i + 1}. ${o.f.text} Lohn: ${reward(o.f)}`);
			return msg(c, c.actor.charId, "info", [open.length ? "Auftragstafel:" : "Die Auftragstafel ist leer; bald kommen neue Aufträge.", ...lines, ...(mine ? [`Dein Auftrag: ${mine.f.text} („order liefere“, sobald du alles hast)`] : [])].join("\n"));
		}
		noGuest(c);
		if (/^(nimm|take)$/i.test(verb)) {
			if (mine) throw new CommandError("Du hast schon einen Auftrag; liefere ihn erst oder gib ihn auf.");
			const o = open[Number(n) - 1];
			if (!o) throw new CommandError("Diese Nummer hängt nicht an der Tafel. „order“ zeigt sie.");
			if (!(await c.space.take({ type: "Order", id: o.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – den hat gerade jemand genommen.");
			await c.space.write({ type: "Order", fields: { ...o.f, takenBy: c.actor.charId } as never }, c.txn, gameMs(c.world.orders.leaseMs));
			return msg(c, c.actor.charId, "info", `Du übernimmst: ${o.f.text}`);
		}
		if (!mine) throw new CommandError("Du hast keinen Auftrag. „order nimm <nr>“ übernimmt einen.");
		if (/^(aufgeben|abandon)$/i.test(verb)) {
			if (!(await c.space.take({ type: "Order", id: mine.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Der Auftrag ist gerade nicht greifbar.");
			await c.space.write({ type: "Order", fields: { ...mine.f, takenBy: "" } as never }, c.txn, gameMs(c.world.orders.leaseMs));
			return msg(c, c.actor.charId, "info", "Du gibst den Auftrag zurück an die Tafel.");
		}
		if (/^(liefere|deliver)$/i.test(verb)) {
			const inv = await inventory(c), give: Inv = [];
			for (const need of mine.f.needs) {
				const hits = byProto(inv.filter((i) => !give.includes(i)), need.proto, need.count);
				if (!hits) throw new CommandError(`Dir fehlt noch: ${need.count}× ${need.proto}.`);
				give.push(...hits);
			}
			if (!(await c.space.take({ type: "Order", id: mine.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Der Auftrag ist gerade nicht greifbar.");
			for (const i of give) await consume(c, i.f, c.actor.charId);
			const p = await resolvePrototype(c.space, mine.f.reward.proto);
			if (!p) throw new CommandError("Der Lohn ist verschwunden.");
			for (let i = 0; i < mine.f.reward.count; i++) await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 });
			return msg(c, "*", "info", `$you() $conj(lieferst|liefert) einen Auftrag ab und $conj(bekommst|bekommt) ${reward(mine.f)}.`, { templ: true });
		}
		throw new CommandError("An der Tafel: order, order nimm <nr>, order liefere, order aufgeben.");
	},
};

export const TRADE_COMMANDS: Command[] = [offer, accept, decline, market, craft, order];

const roomNames = (w: WorldDef, rooms: string[]) => rooms.map((r) => w.rooms.find((x) => x.roomId === r)?.name ?? r).join(", ");

/** Order ticker: each board gets a new job while fewer than `max` are posted there. */
export async function ordersTick(space: SpaceLike, w: WorldDef): Promise<void> {
	for (const room of w.orders.rooms) {
		const kinds = w.orders.kinds.filter((k) => !k.rooms || k.rooms.includes(room));
		if (!kinds.length || (await space.count({ type: "Order", fields: { room } })) >= w.orders.max) continue;
		const k = kinds[randomInt(0, kinds.length)]!;
		const o: OrderFields = { orderId: `j-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, kind: k.key, text: k.text, needs: k.needs, reward: k.reward, takenBy: "", room };
		await space.write({ type: "Order", fields: o as never }, null, gameMs(w.orders.leaseMs));
	}
}

/** Market ticker: an item in escrow whose listing lapsed goes back to its seller. A listing held right now (a
 *  purchase in progress) counts as alive. */
export async function marketTick(space: SpaceLike): Promise<void> {
	for (const e of await space.readAll({ type: "Item", fields: { location: "market" } })) {
		const f = fieldsOf<ItemFields>(e);
		try { if (f.listing && (await readExisting(space, { type: "Listing", fields: { listingId: f.listing } }))) continue; } catch (err) { if (err instanceof StillHeld) continue; throw err; }
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Item", id: e.id }, NO_WAIT, { txn });
			if (t) { const { listing: _l, seller, ...rest } = fieldsOf<ItemFields>(t); await space.write({ type: t.type, types: t.types.slice(1), fields: { ...rest, location: seller ?? rest.location, x: -1, y: -1 } as never }, txn, FOREVER); }
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
}
