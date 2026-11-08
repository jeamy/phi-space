// Trade and economy (docs/phasen.en.md Phase 4). Every exchange moves its items in the command's transaction: a trade takes
// both sides and writes them swapped, a purchase takes the listing, the coins and the item, a craft takes the inputs and
// writes the output. When anything is missing the transaction aborts and nothing has moved, so an item is never doubled
// or lost however many trades race each other.
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, type AccountFields, type BuildingFields, type CharacterFields, type ItemFields, type ListingFields, type OfferFields, type WantedFields, type OrderFields, type ShopOrderFields } from "../../model.ts";
import { readExisting, StillHeld, peek } from "../../space.ts";
import type { Command } from "../cmdsets.ts";
import { byName, CommandError, NotUnderstood, inventory, msg, stem, type CommandCtx, itemsNamed } from "../context.ts";
import { bau, chestForSale, distTo, planOf } from "./build.ts";
import { boardLines } from "./siteorder.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import { decayNowOf, patienceOf, worldNowOf } from "../clock.ts";
import type { WorldDef } from "../world.ts";
import { randomBytes, randomInt, timeNow } from "../source.ts";

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

/** Items of `inv` that satisfy `spec` (each item used once), or the name of what is missing (`unknown`: nothing carried
 *  goes by that name). A name is taken as `byName` takes it ("muscheln" are the "Muschel"), of one kind; a name that is
 *  exactly a thing of the world means that thing only ("tang" is never the "Tangseil" byName finds by its beginning). */
function pick(inv: Inv, spec: Array<{ name: string; count: number }>, world: WorldDef): { items: Inv } | { missing: string; unknown: boolean } {
	const used = new Set<string>(), items: Inv = [];
	for (const want of spec) {
		const free = inv.filter((i) => !used.has(i.f.itemId));
		let hits = free.filter((i) => names(i.f).includes(want.name) || i.f.proto === want.name);
		const near = hits.length ? undefined : itemsNamed(world, free, want.name)[0];
		if (near) hits = free.filter((i) => i.f.proto === near.f.proto);
		if (hits.length < want.count) return { missing: `${want.count}× ${hits[0]?.f.name ?? want.name}`, unknown: !hits.length };
		for (const h of hits.slice(0, want.count)) { used.add(h.f.itemId); items.push(h); }
	}
	return { items };
}
const byProto = (inv: Inv, proto: string, count: number): Inv | null => { const hits = inv.filter((i) => i.f.proto === proto); return hits.length >= count ? hits.slice(0, count) : null; };

/** Takes an item where it is and writes it at `location` (a pack, or the market's escrow). */
export async function move(c: CommandCtx, item: ItemFields, from: string, to: string, extra: Partial<ItemFields> = {}): Promise<void> {
	const e = await c.space.take({ type: "Item", fields: { itemId: item.itemId, location: from } }, NO_WAIT, { txn: c.txn });
	if (!e) throw new CommandError(`${item.name} ist nicht mehr da.`);
	const { listing: _l, seller: _s, ...rest } = fieldsOf<ItemFields>(e);
	await c.space.write({ type: e.type, types: e.types.slice(1), fields: { ...rest, location: to, x: -1, y: -1, ...extra } as never }, c.txn, FOREVER);
}
/** Takes an item for good (used up). */
export async function consume(c: CommandCtx, item: ItemFields, from: string): Promise<void> {
	// a boat with cargo in its hatch (fishing.ts) or a bill with its coins (shop.ts) is not used up: what it holds would be left without a place
	if (c.world.boat?.hatch?.[item.proto] && (await c.space.count({ type: "Item", fields: { location: item.itemId } }, c.txn))) throw new CommandError(`In der Luke von ${item.name} liegt noch etwas; entlade sie erst („luke entlade alle“).`);
	if (c.world.bank?.note?.proto === item.proto && (await c.space.count({ type: "Item", fields: { location: item.itemId } }, c.txn))) throw new CommandError(`${item.name} wird am Kontor eingelöst („wechsel einlösen“).`);
	if (!(await c.space.take({ type: "Item", fields: { itemId: item.itemId, location: from } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${item.name} ist nicht mehr da.`);
}

function noGuest(c: CommandCtx): void {
	if (!c.account || c.account.guest) throw new CommandError("Gäste können nicht tauschen oder handeln; registriere dich dafür.");
}
const list = (xs: string[]) => xs.join(", ");
/** Things by kind with their count: ["Münze", "Münze", "Perle"] → "2× Münze, Perle"; `want` specs likewise. */
export function counted(xs: string[] | Array<{ name: string; count: number }>): string {
	const m = new Map<string, number>();
	for (const x of xs) { const [n, k] = typeof x === "string" ? [x, 1] : [x.name.charAt(0).toUpperCase() + x.name.slice(1), x.count]; m.set(n, (m.get(n) ?? 0) + k); }
	return list([...m].map(([n, k]) => (k > 1 ? `${k}× ${n}` : n)));
}

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
		if (!m) throw new NotUnderstood("So geht es: offer <dinge> an <person> [für <dinge>], z. B. offer treibholz an Bert für münze");
		const got = pick(await inventory(c), parseSpec(m[1]!), c.world);
		if ("missing" in got) throw new (got.unknown ? NotUnderstood : CommandError)(`Du hast nicht: ${got.missing}.`);
		const who = (await c.space.readAll({ type: "Character", fields: { room: c.actor.room } })).map((e) => fieldsOf<CharacterFields>(e)).find((ch) => ch.charId !== c.actor.charId && !ch.aboard && ch.name.toLowerCase() === m[2]!.toLowerCase());
		if (!who) throw new NotUnderstood(`Hier ist niemand namens „${m[2]!.slice(0, 30)}“.`);
		const want = m[3] ? parseSpec(m[3]) : [];
		const o: OfferFields = { offerId: `o-${randomBytes(5).toString("hex")}`, from: c.actor.charId, fromName: c.actor.name, to: who.charId, toName: who.name, give: got.items.map((i) => i.f.itemId), giveNames: got.items.map((i) => i.f.name), want, room: c.actor.room, at: timeNow() };
		await c.space.write({ type: "Offer", fields: o as never }, c.txn, OFFER_MS);
		const wants = want.length ? ` für ${counted(want)}` : " als Geschenk";
		await msg(c, who.charId, "info", `${c.actor.name} bietet dir ${counted(o.giveNames)}${wants} an. „accept ${c.actor.name}“ nimmt an, „decline ${c.actor.name}“ lehnt ab.`);
		await msg(c, c.actor.charId, "info", `Du bietest ${who.name} ${counted(o.giveNames)}${wants} an.`);
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
			const e = await peek(c.space, { type: "Item", fields: { itemId: id, location: o.f.from } });
			if (!e) throw new CommandError(`Das Angebot gilt nicht mehr: ${o.f.fromName} hat nicht mehr alles.`);
			await move(c, fieldsOf<ItemFields>(e), o.f.from, c.actor.charId);
		}
		// my side: what they want, from my pack
		const got = pick(await inventory(c), o.f.want, c.world);
		if ("missing" in got) throw new CommandError(`Dir fehlt für diesen Tausch: ${got.missing}.`);
		for (const i of got.items) await move(c, i.f, c.actor.charId, o.f.from);
		const back = got.items.length ? ` gegen ${counted(got.items.map((i) => i.f.name))}` : "";
		await msg(c, o.f.from, "info", `${c.actor.name} nimmt dein Angebot an: ${counted(o.f.giveNames)}${back}.`);
		await msg(c, c.actor.charId, "info", `Tausch mit ${o.f.fromName}: du bekommst ${counted(o.f.giveNames)}${back}.`);
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
/** The wanted notices of a board, numbered on their own (order of posting). */
async function wanteds(space: SpaceLike, room: string): Promise<Array<{ e: Taken; f: WantedFields }>> {
	return (await space.readAll({ type: "Wanted", fields: { room } })).map((e) => ({ e, f: fieldsOf<WantedFields>(e) })).sort((a, b) => a.f.at - b.f.at || a.f.wantedId.localeCompare(b.f.wantedId));
}
/** How many wanted notices one may have open on a board. */
const WANTED_MAX = 5;
/** A thing of the world by its name, key or alias, also in another form ("ziegen" is the "Ziege"). */
function protoNamed(w: WorldDef, name: string): WorldDef["prototypes"][number] | undefined {
	const n = name.trim().toLowerCase().replace(/^(?:eine?n?|eine[rs]?|a|an)\s+/, "");
	return w.prototypes.find((p) => p.key === n || [p.name, ...(p.aliases ?? [])].some((a) => a.toLowerCase() === n))
		?? w.prototypes.find((p) => [p.name, ...(p.aliases ?? [])].some((a) => stem(a) === stem(n)));
}
const coins = (n: number) => `${n} Münze${n === 1 ? "" : "n"}`;
/** An answer to a notice as the board shows it: "Gesa: ab 8", or "Gesa: gerade keins" (ask 0: it sells it, has none now). */
export const replyText = (r: { name: string; ask: number }) => `${r.name}: ${r.ask ? `ab ${r.ask}` : "gerade keins"}`;
const roomName = (w: WorldDef, room: string) => (w.allRooms ?? w.rooms).find((r) => r.roomId === room)?.name ?? room;
/** The traders that sell `proto` (their price list's selling price), with where and for how much each. */
export function sellersOf(w: WorldDef, proto: string): Array<{ name: string; where: string; market: string | null; each: number }> {
	return w.npcs.flatMap((n) => { const each = n.prices?.[proto]?.[1] ?? 0; return each > 0 ? [{ name: n.name, where: roomName(w, n.market ?? n.room), market: n.market ?? null, each }] : []; });
}
/** What one who seeks `proto` at `room` hears at once when no trader at this board sells it ("" when one does). */
export function sellerHint(w: WorldDef, proto: string, protoName: string, room: string): string {
	const all = sellersOf(w, proto);
	if (all.some((s) => s.market === room)) return "";
	return all.length
		? `An diesem Brett verkauft kein Händler ${protoName}; ${all.map((s) => `${s.name} (${s.where}) verkauft es für ${coins(s.each)}`).join(", ")}. Hier kann nur liefern, wer es selbst hat.`
		: `${protoName} verkauft kein Händler; liefern kann nur, wer es selbst hat oder macht.`;
}
/** A listing's goods as said: "Muschel", "10× Muschel". */
export const lotOf = (l: Pick<ListingFields, "itemName" | "count">) => ((l.count ?? 1) > 1 ? `${l.count}× ${l.itemName}` : l.itemName);

const market: Command = {
	key: "market", aliases: ["markt"],
	help: "market – das Marktbrett: market biete <ding> [aus truhe [nr]] für <n>, market kaufe <ding> [für <n>] oder <nr>, market zurück <nr>; Gesuche: market suche <ding> für <n>, market liefere <nr> [für <n>], market antworte <nr> ab <n>, market suche zurück <nr> (Preise in Münzen)",
	async func(c, arg) {
		if (!c.world.market.rooms.includes(c.actor.room)) throw new CommandError(`Hier steht kein Marktbrett. Marktbretter stehen in: ${roomNames(c.world, c.world.market.rooms)}.`);
		const [verb = "", ...rest] = arg.trim().split(/\s+/);
		const all = await listings(c.space, c.actor.room);
		const nr = (s: string | undefined) => { const n = Number(s); if (!Number.isInteger(n) || n < 1 || n > all.length) throw new CommandError("Diese Nummer steht nicht auf dem Brett. „markt“ zeigt es."); return all[n - 1]!; };
		/** A lot on the board by what it is, not by its place, which moves when another buys first: "markt kaufe gans" (the
		 *  cheapest), "markt kaufe 10 muscheln für 15" (that count at that price; the page's buttons say it so). */
		const byLot = (s: string) => {
			const m = /^(?:(\d+)\s*[x×]?\s+)?(.+?)(?:\s+(?:für|fuer|for|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?)?$/i.exec(s.trim());
			if (!m) throw new NotUnderstood("So geht es: markt kaufe <ding>, auch markt kaufe 10 muscheln für 15 oder markt kaufe <nr>.");
			const name = m[2]!.trim(), p = protoNamed(c.world, name), count = m[1] ? Number(m[1]) : null, price = m[3] ? Number(m[3]) : null;
			const named = (l: ListingFields) => stem(l.itemName) === stem(name) || (!!p && stem(l.itemName) === stem(p.name));
			const fits = all.filter((l) => named(l.f) && l.f.seller !== c.actor.charId && (count === null || (l.f.count ?? 1) === count) && (price === null || l.f.price === price));
			if (!fits.length) {
				const any = all.some((l) => named(l.f));
				throw new CommandError(!any ? `Am Brett hängt nichts, was „${name.slice(0, 30)}“ heißt. „markt“ zeigt, was da ist.` : all.some((l) => named(l.f) && l.f.seller !== c.actor.charId) ? "So hängt es nicht mehr am Brett (jemand war schneller, oder Menge und Preis sind andere). „markt“ zeigt, was da ist." : "Das ist dein eigenes Angebot; „markt zurück“ holt es zurück.");
			}
			return fits.reduce((a, b) => (b.f.price < a.f.price ? b : a));
		};
		const coin = c.world.currency;
		const sought = await wanteds(c.space, c.actor.room);
		const wnr = (s: string | undefined) => { const n = Number(s); if (!Number.isInteger(n) || n < 1 || n > sought.length) throw new CommandError("Dieses Gesuch steht nicht am Brett. „markt“ zeigt es."); return sought[n - 1]!; };
		if (!verb) {
			const offered = all.length ? ["Marktbrett:", ...all.map((l, i) => `  ${i + 1}. ${lotOf(l.f)} für ${l.f.price} Münze${l.f.price === 1 ? "" : "n"} (von ${l.f.sellerName})`)] : ["Das Marktbrett ist leer. „markt biete <ding> für <n>“ stellt etwas ein."];
			const wanted = sought.length ? ["Gesuche („markt liefere <nr>“):", ...sought.map((w, i) => `  ${i + 1}. ${w.f.buyerName} sucht ${(w.f.count ?? 1) > 1 ? `${w.f.count}× ` : ""}${w.f.protoName}, zahlt ${coins(w.f.price)}${w.f.replies?.length ? ` (${w.f.replies.map(replyText).join(", ")})` : ""}`)] : [];
			return msg(c, c.actor.charId, "info", [...offered, ...wanted].join("\n"));
		}
		noGuest(c);
		// a wanted notice: "markt suche ziege für 5" puts the coins in escrow; "markt suche zurück <nr>" takes them back
		if (/^(suche|gesuch|want)$/i.test(verb)) {
			if (/^(zurück|zurueck|withdraw)$/i.test(rest[0] ?? "")) {
				const w = wnr(rest[1]);
				if (w.f.buyer !== c.actor.charId) throw new CommandError("Das ist nicht dein Gesuch.");
				if (!(await c.space.take({ type: "Wanted", id: w.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – jemand liefert gerade.");
				for (const e of await c.space.readAll({ type: "Item", fields: { location: "market", listing: w.f.wantedId } }, { txn: c.txn })) await move(c, fieldsOf<ItemFields>(e), "market", c.actor.charId);
				return msg(c, c.actor.charId, "info", `Du nimmst dein Gesuch nach ${w.f.protoName} zurück; deine ${coins(w.f.price)} hast du wieder.`);
			}
			// one thing or several of one kind, for one price together: "markt suche 3 ziegen für 12"
			const m = /^(.+?)\s+(?:für|fuer|for|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?$/i.exec(rest.join(" "));
			if (!m) throw new NotUnderstood("So geht es: markt suche <ding> für <n>, z. B. markt suche ziege für 5 oder markt suche 3 ziegen für 12");
			const price = Number(m[2]);
			if (price < 1 || price > 1000) throw new CommandError("Ein Preis liegt zwischen 1 und 1000 Münzen.");
			const spec = parseSpec(m[1]!)[0]!, count = Math.min(50, Math.max(1, spec.count));
			const p = protoNamed(c.world, spec.name);
			if (!p) throw new CommandError(`Ein Ding namens „${spec.name.slice(0, 30)}“ gibt es nicht.`);
			if (p.key === coin) throw new CommandError("Münzen gegen Münzen zu tauschen ergibt nichts; suche etwas anderes.");
			if (sought.filter((w) => w.f.buyer === c.actor.charId).length >= WANTED_MAX) throw new CommandError(`Du hast schon ${WANTED_MAX} Gesuche an diesem Brett; nimm erst eines zurück („markt suche zurück <nr>“).`);
			const pay = byProto(await inventory(c), coin, price);
			if (!pay) throw new CommandError(`Dafür brauchst du ${coins(price)}; sie liegen am Brett, bis jemand liefert.`);
			const wantedId = `w-${randomBytes(5).toString("hex")}`;
			for (const i of pay) await move(c, i.f, c.actor.charId, "market", { listing: wantedId, seller: c.actor.charId });
			await c.space.write({ type: "Wanted", fields: { wantedId, buyer: c.actor.charId, buyerName: c.actor.name, proto: p.key, protoName: p.name, ...(count > 1 ? { count } : {}), price, room: c.actor.room, at: timeNow(), expiresWorldMs: (await decayNowOf(c.space, c.txn)) + c.world.market.listMs } satisfies WantedFields as never }, c.txn, FOREVER);
			await msg(c, "*", "info", `$you() $conj(suchst|sucht) am Marktbrett ${count > 1 ? `${count}× ${p.name}` : p.name} und $conj(zahlst|zahlt) ${coins(price)}.`, { templ: true });
			const hint = sellerHint(c.world, p.key, p.name, c.actor.room);
			if (hint) await msg(c, c.actor.charId, "info", hint);
			return;
		}
		// delivering what a notice seeks: the thing goes to the one who seeks it, the coins in escrow to the one who brings it
		if (/^(liefere|deliver)$/i.test(verb)) {
			const w = wnr(rest[0]);
			// "markt liefere 2 für 8": the deliverer asks less than the notice pays; the rest goes back to the one who seeks
			const askM = /^(?:für|fuer|for|um)$/i.exec(rest[1] ?? "") ? Number(rest[2]) : NaN;
			if (rest[1] !== undefined && !(Number.isInteger(askM) && askM >= 1)) throw new NotUnderstood("So geht es: markt liefere <nr>, oder markt liefere <nr> für <n> (weniger als geboten; der Rest geht zurück).");
			if (w.f.buyer === c.actor.charId) throw new CommandError("Das ist dein eigenes Gesuch; „markt suche zurück“ nimmt es zurück.");
			const inv = await inventory(c), want = w.f.count ?? 1, lot = want > 1 ? `${want}× ${w.f.protoName}` : w.f.protoName;
			const things = (await Promise.all(inv.filter((i) => i.f.proto === w.f.proto).map(async (i) => ({ i, full: (await c.space.count({ type: "Item", fields: { location: i.f.itemId } }, c.txn)) > 0 })))).filter((x) => !x.full).map((x) => x.i).slice(0, want);
			const have = inv.filter((i) => i.f.proto === w.f.proto).length;
			if (things.length < want) throw new CommandError(have >= want ? `Leere erst, was in ${w.f.protoName} liegt.` : have ? `Gesucht sind ${lot}; du trägst nur ${have}.` : `${w.f.protoName} trägst du nicht bei dir.`);
			if (!(await c.space.take({ type: "Wanted", id: w.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – jemand anderes liefert gerade.");
			const escrow = await c.space.readAll({ type: "Item", fields: { location: "market", listing: w.f.wantedId } }, { txn: c.txn });
			const ask = Number.isNaN(askM) ? escrow.length : Math.min(askM, escrow.length), paid = escrow.slice(0, ask), back = escrow.slice(ask);
			for (const e of paid) await move(c, fieldsOf<ItemFields>(e), "market", c.actor.charId);
			for (const e of back) await move(c, fieldsOf<ItemFields>(e), "market", w.f.buyer);
			for (const t of things) await move(c, t.f, c.actor.charId, w.f.buyer);
			await msg(c, w.f.buyer, "info", `${c.actor.name} liefert dir ${lot} für dein Gesuch am Marktbrett (${c.world.rooms.find((r) => r.roomId === c.actor.room)?.name ?? c.actor.room}); die ${coins(paid.length)} hat ${c.actor.name}.${back.length ? ` ${coins(back.length)} bekommst du zurück.` : ""}`);
			return msg(c, "*", "info", `$you() $conj(lieferst|liefert) ${w.f.buyerName} ${lot} und $conj(bekommst|bekommt) ${coins(paid.length)}.`, { templ: true });
		}
		// an answer to a notice that pays too little: "markt antworte 2 ab 8" (a trader's, or a player's); the one who seeks hears it
		if (/^(antworte|answer)$/i.test(verb)) {
			const w = wnr(rest[0]);
			// "markt antworte 2 keins": one who sells it has none right now (ask 0)
			const none = /^(?:keine?s?|keins|nichts|none)$/i.test(rest.slice(1).join(" "));
			const m = /^(?:ab|für|fuer|for|from|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?$/i.exec(rest.slice(1).join(" "));
			if (!m && !none) throw new NotUnderstood("So geht es: markt antworte <nr> ab <n> (für wie viel du liefern würdest), oder markt antworte <nr> keins.");
			if (w.f.buyer === c.actor.charId) throw new CommandError("Das ist dein eigenes Gesuch.");
			const ask = none ? 0 : Number(m![1]);
			if (!none && ask <= w.f.price) throw new CommandError(`Für ${coins(w.f.price)} kannst du gleich liefern: „markt liefere ${rest[0]}“.`);
			if (ask > 1000) throw new CommandError("Ein Preis liegt zwischen 1 und 1000 Münzen.");
			if (!(await c.space.take({ type: "Wanted", id: w.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – jemand liefert gerade.");
			const replies = [...(w.f.replies ?? []).filter((r) => r.charId !== c.actor.charId), { charId: c.actor.charId, name: c.actor.name, ask }].slice(-5);
			await c.space.write({ type: "Wanted", fields: { ...w.f, replies } as never }, c.txn, FOREVER);
			const lot = (w.f.count ?? 1) > 1 ? `${w.f.count}× ${w.f.protoName}` : w.f.protoName;
			const board = c.world.rooms.find((r) => r.roomId === c.actor.room)?.name ?? c.actor.room;
			if (none) {
				await msg(c, w.f.buyer, "info", `${c.actor.name} antwortet auf dein Gesuch nach ${lot} am Marktbrett (${board}): ${w.f.protoName} hat ${c.actor.name} gerade nicht. Kommt wieder etwas herein, liefert ${c.actor.name}, solange dein Gesuch hängt.`);
				return msg(c, c.actor.charId, "info", `Du antwortest ${w.f.buyerName}: ${lot} hast du gerade nicht.`);
			}
			await msg(c, w.f.buyer, "info", `${c.actor.name} antwortet auf dein Gesuch nach ${lot} am Marktbrett (${board}): Für ${coins(w.f.price)} nicht, ab ${coins(ask)} liefert ${c.actor.name}.`);
			return msg(c, c.actor.charId, "info", `Du antwortest ${w.f.buyerName}: ${lot} ab ${coins(ask)}.`);
		}
		if (/^(biete|sell|verkaufe)$/i.test(verb)) {
			// one thing or a lot of one kind, for one price together: "markt biete 10 muscheln für 15", "… um 15 münzen"
			const m = /^(.+?)\s+(?:für|fuer|for|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?$/i.exec(rest.join(" "));
			if (!m) throw new NotUnderstood("So geht es: markt biete <ding> für <n>, auch markt biete 10 muscheln für 15");
			const price = Number(m[2]);
			if (price < 1 || price > 1000) throw new CommandError("Ein Preis liegt zwischen 1 und 1000 Münzen.");
			// "… aus truhe 2", "… aus der hütte": from a chest of one's own in this region, wherever one stands
			const fromChest = /^(.+?)\s+(?:aus|from)\s+(.+)$/i.exec(m[1]!);
			const chest = fromChest ? await chestForSale(c, fromChest[2]!) : null;
			const got = pick(chest ? chest.items : await inventory(c), parseSpec(fromChest ? fromChest[1]! : m[1]!).slice(0, 1), c.world);
			if ("missing" in got) throw new (got.unknown ? NotUnderstood : CommandError)(chest ? `In der Truhe ist nicht: ${got.missing}.` : `Du hast nicht: ${got.missing}.`);
			const item = got.items[0]!.f, listingId = `l-${randomBytes(5).toString("hex")}`;
			if (item.proto === "muenze") throw new CommandError("Münzen gegen Münzen zu tauschen ergibt nichts; stelle etwas anderes ans Marktbrett.");
			for (const i of got.items) await move(c, i.f, chest ? chest.b.buildId : c.actor.charId, "market", { listing: listingId, seller: c.actor.charId });
			const lot: ListingFields = { listingId, seller: c.actor.charId, sellerName: c.actor.name, itemId: item.itemId, itemName: item.name, ...(got.items.length > 1 ? { count: got.items.length } : {}), price, room: c.actor.room, at: timeNow(), expiresWorldMs: (await decayNowOf(c.space, c.txn)) + c.world.market.listMs };
			await c.space.write({ type: "Listing", fields: lot as never }, c.txn, FOREVER);
			return msg(c, "*", "info", `$you() $conj(hängst|hängt) ${lotOf(lot)} für ${price} Münze${price === 1 ? "" : "n"} ans Marktbrett${chest ? " (aus der Truhe)" : ""}.`, { templ: true });
		}
		if (/^(kaufe|buy)$/i.test(verb)) {
			const l = /^\d+$/.test(rest.join(" ").trim()) ? nr(rest[0]) : byLot(rest.join(" "));
			if (l.f.seller === c.actor.charId) throw new CommandError("Das ist dein eigenes Angebot; „markt zurück“ holt es zurück.");
			if (!(await c.space.take({ type: "Listing", id: l.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – jemand anderes kauft gerade.");
			const coins = byProto(await inventory(c), coin, l.f.price);
			if (!coins) throw new CommandError(`Dafür brauchst du ${l.f.price} Münze${l.f.price === 1 ? "" : "n"}.`);
			for (const m of coins) await move(c, m.f, c.actor.charId, l.f.seller);
			const goods = await c.space.readAll({ type: "Item", fields: { location: "market", listing: l.f.listingId } }, { txn: c.txn });
			if (!goods.length) throw new CommandError("Die Ware ist nicht mehr am Brett.");
			for (const g of goods) await move(c, fieldsOf<ItemFields>(g), "market", c.actor.charId);
			await msg(c, l.f.seller, "info", `${c.actor.name} kauft dein ${lotOf(l.f)} am Marktbrett (${c.world.rooms.find((r) => r.roomId === c.actor.room)?.name ?? c.actor.room}) für ${l.f.price} Münze${l.f.price === 1 ? "" : "n"}.`);
			return msg(c, "*", "info", `$you() $conj(kaufst|kauft) ${lotOf(l.f)} vom Marktbrett.`, { templ: true });
		}
		if (/^(zurück|zurueck|withdraw)$/i.test(verb)) {
			const l = nr(rest[0]);
			if (l.f.seller !== c.actor.charId) throw new CommandError("Das ist nicht dein Angebot.");
			if (!(await c.space.take({ type: "Listing", id: l.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – jemand kauft es gerade.");
			for (const g of await c.space.readAll({ type: "Item", fields: { location: "market", listing: l.f.listingId } }, { txn: c.txn })) await move(c, fieldsOf<ItemFields>(g), "market", c.actor.charId);
			return msg(c, c.actor.charId, "info", `Du holst ${lotOf(l.f)} vom Marktbrett zurück.`);
		}
		throw new NotUnderstood("Am Marktbrett: markt, markt biete <ding> für <n>, markt kaufe <nr>, markt zurück <nr>, markt suche <ding> für <n>, markt liefere <nr> [für <n>], markt antworte <nr> ab <n>, markt suche zurück <nr>.");
	},
};

/** How many rounds one `craft` may make: it stays one transaction. */
const MAX_CRAFT = 20;
const COUNT_WORDS: Record<string, number> = { ein: 1, eine: 1, einen: 1, eins: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10 };
/** "3 tangseile", "3x seil", "drei stück tangseil": the count and the rest; without a count one. */
function countOf(arg: string): { count: number; what: string } {
	const m = /^(\d+|\p{L}+)\s*(?:x|×|mal|stück|stueck)?\s+(.+)$/iu.exec(arg);
	const count = m ? (/^\d/.test(m[1]!) ? Number(m[1]) : COUNT_WORDS[m[1]!]) : undefined;
	return count === undefined ? { count: 1, what: arg } : { count, what: m![2]! };
}
/** A recipe by its key or name, then in any form or by what it makes is also called: "tangseile", "seil". The own name
 *  goes first: "tuch" is the cloth, though linen is called so too. */
function recipeNamed(w: WorldDef, what: string) {
	const own = (r: WorldDef["recipes"][number]) => [r.key, r.name];
	const also = (r: WorldDef["recipes"][number]) => w.prototypes.find((p) => p.key === r.makes)?.aliases ?? [];
	const is = (n: string) => n.toLowerCase() === what;
	const form = (n: string) => stem(n) === stem(what);
	return w.recipes.find((r) => own(r).some(is)) ?? w.recipes.find((r) => own(r).some(form)) ?? w.recipes.find((r) => also(r).some(is)) ?? w.recipes.find((r) => also(r).some(form));
}

export const craft: Command = {
	key: "craft", aliases: ["baue", "herstellen", "fertige"],
	help: "craft [anzahl] [rezept] – etwas herstellen, auch mehrmals (craft 3 tangseil); ohne Rezept die Liste",
	async func(c, arg) {
		const rs = c.world.recipes;
		if (!arg) {
			const show = (r: (typeof rs)[number]) => `  ${r.key}: ${list(r.needs.map((n) => `${n.count}× ${n.proto}`))}${r.tool ? `, Werkzeug: ${r.tool}` : ""}${r.at ? `, nur am Bau: ${planOf(c.world, r.at)?.name ?? r.at}` : ""}${(r.count ?? 1) > 1 ? ` (gibt ${r.count})` : ""}`;
			return msg(c, c.actor.charId, "info", ["Rezepte:", ...rs.map(show)].join("\n"));
		}
		const { count: want, what: a } = countOf(arg.trim().toLowerCase());
		const r = recipeNamed(c.world, a);
		// "baue eine hütte": a plan, not a recipe (engine/commands/build.ts)
		if (!r && planOf(c.world, arg.trim().toLowerCase().replace(/(?:\s+\d+){2}$/, ""))) return bau.func(c, arg);
		if (!r) throw new NotUnderstood(`Ein Rezept „${arg.slice(0, 30)}“ gibt es nicht. „craft“ zeigt die Rezepte.`);
		// a recipe of a building (the bakery's oven) is made beside one of its plan, anyone's
		if (r.at && !(await c.space.readAll({ type: "Building", fields: { room: c.actor.room, plan: r.at } })).some((e) => distTo(c.actor, fieldsOf<BuildingFields>(e)) <= 1))
			throw new CommandError(`${r.name} macht man nur direkt neben ${planOf(c.world, r.at)?.dative ?? `einem ${planOf(c.world, r.at)?.name ?? r.at}`}.`);
		if (want < 1) throw new NotUnderstood(`Wie viele? Zum Beispiel: craft 3 ${r.key}`);
		if (want > MAX_CRAFT) throw new CommandError(`Höchstens ${MAX_CRAFT} auf einmal.`);
		// as many rounds as the pack gives, up to the count; a tool that breaks hands over to the next of its kind
		const inv = await inventory(c);
		const used = new Set<string>(), inputs: Inv = [], wear = new Map<string, number>();
		const tools = r.tool ? inv.filter((i) => i.f.proto === r.tool) : [];
		// a workshop beside one: a tool wears half as fast there (docs/siedeln.en.md "Epoche 2")
		const near = r.tool ? (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => distTo(c.actor, b) <= 1) : [];
		const wearing = near.some((b) => planOf(c.world, b.plan)?.sparesTools) ? 0.5 : 1;
		let made = 0, lack = "";
		rounds: while (made < want) {
			const round: Inv = [];
			for (const n of r.needs) {
				const hits = inv.filter((i) => i.f.proto === n.proto && !used.has(i.f.itemId) && !round.includes(i)).slice(0, n.count);
				if (hits.length < n.count) { lack = `Dir fehlt: ${n.count}× ${n.proto}.`; break rounds; }
				round.push(...hits);
			}
			const tool = tools.find((i) => !round.includes(i) && !used.has(i.f.itemId) && (wear.get(i.f.itemId) ?? i.f.wear ?? 1) > 0);
			if (r.tool && !tool) { lack = `Dafür brauchst du ein Werkzeug: ${r.tool}.`; break; }
			if (tool) wear.set(tool.f.itemId, (wear.get(tool.f.itemId) ?? tool.f.wear ?? 1) - wearing);
			round.forEach((i) => { used.add(i.f.itemId); inputs.push(i); });
			made++;
		}
		if (!made) throw new CommandError(lack);
		for (const i of inputs) await consume(c, i.f, c.actor.charId);
		const broken: string[] = [];
		for (const t of tools) {
			const left = wear.get(t.f.itemId);
			if (left === undefined) continue;
			if (left <= 0) { await consume(c, t.f, c.actor.charId); broken.push(t.f.name); }
			else await move(c, t.f, c.actor.charId, c.actor.charId, { wear: left });
		}
		const p = await resolvePrototype(c.space, r.makes);
		if (!p) throw new CommandError("Das Rezept ist kaputt.");
		const n = (r.count ?? 1) * made;
		for (let i = 0; i < n; i++) await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 });
		await msg(c, "*", "info", `$you() $conj(stellst|stellt) ${n > 1 ? `${n} ${p.name}` : p.name} her.${broken.map((b) => ` Das ${b} zerbricht dabei.`).join("")}`, { templ: true });
		if (made < want) await msg(c, c.actor.charId, "info", `Für ${want} reicht es nicht, es wurden ${made}. ${lack}`);
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
			const sites = await boardLines(c.space, c.world);
			// the department stores' delivery orders of this region (shop.ts), delivered at the store
			// only orders of stores that still stand (one that fell leaves its orders behind, unseen)
			const standing = new Set((await c.space.readAll({ type: "Building", fields: { plan: c.world.shop?.plan ?? "" } })).map((e) => String(e.fields.buildId)));
			const stores = (await c.space.readAll({ type: "ShopOrder" })).map((e) => fieldsOf<ShopOrderFields>(e)).filter((o) => standing.has(o.buildId)).map((o) => `  ${o.storeName} von ${o.ownerName} (${roomNames(c.world, [o.room])}): ${o.count}× ${o.protoName} zu ${o.reward} Münze${o.reward === 1 ? "" : "n"}`);
			return msg(c, c.actor.charId, "info", [open.length ? "Auftragstafel:" : "Die Auftragstafel ist leer; bald kommen neue Aufträge.", ...lines, ...(sites.length ? ["Baustellen zahlen vor Ort beim Liefern und Mitarbeiten:", ...sites] : []), ...(stores.length ? ["Kaufhäuser bestellen („laden liefere <ding>“ dort):", ...stores] : []), ...(mine ? [`Dein Auftrag: ${mine.f.text} („order liefere“, sobald du alles hast)`] : [])].join("\n"));
		}
		noGuest(c);
		if (/^(nimm|take)$/i.test(verb)) {
			if (mine) throw new CommandError("Du hast schon einen Auftrag; liefere ihn erst oder gib ihn auf.");
			const o = open[Number(n) - 1];
			if (!o) throw new CommandError("Diese Nummer hängt nicht an der Tafel. „order“ zeigt sie.");
			if (!(await c.space.take({ type: "Order", id: o.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Zu spät – den hat gerade jemand genommen.");
			await c.space.write({ type: "Order", fields: { ...o.f, takenBy: c.actor.charId, expiresWorldMs: (await worldNowOf(c.space, c.txn)) + c.world.orders.leaseMs * (await patienceOf(c.space, c.txn)) } as never }, c.txn, FOREVER);
			return msg(c, c.actor.charId, "info", `Du übernimmst: ${o.f.text}`);
		}
		if (!mine) throw new CommandError("Du hast keinen Auftrag. „order nimm <nr>“ übernimmt einen.");
		if (/^(aufgeben|abandon)$/i.test(verb)) {
			if (!(await c.space.take({ type: "Order", id: mine.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Der Auftrag ist gerade nicht greifbar.");
			await c.space.write({ type: "Order", fields: { ...mine.f, takenBy: "", expiresWorldMs: (await worldNowOf(c.space, c.txn)) + c.world.orders.leaseMs * (await patienceOf(c.space, c.txn)) } as never }, c.txn, FOREVER);
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
		throw new NotUnderstood("An der Tafel: order, order nimm <nr>, order liefere, order aufgeben.");
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
		const o: OrderFields = { orderId: `j-${timeNow().toString(36)}-${randomBytes(3).toString("hex")}`, kind: k.key, text: k.text, needs: k.needs, reward: k.reward, takenBy: "", room, expiresWorldMs: (await worldNowOf(space)) + w.orders.leaseMs * (await patienceOf(space)) };
		await space.write({ type: "Order", fields: o as never }, null, FOREVER);
	}
}

/** Market ticker: an item in escrow whose listing lapsed goes back to its seller, the coins of a wanted notice that lapsed
 *  to its buyer. A listing or notice held right now (a purchase or delivery in progress) counts as alive. */
/** A trader gets back one thing it sells and started with, every RESTOCK_WORLD_MS of world time, up to what it started
 *  with (`carry`): what it sold lives on with the buyer, so without this its stock would end for good. */
export const RESTOCK_WORLD_MS = 24 * 3600_000;
type RestockFields = { charId: string; proto: string; nextWorldMs: number };
async function restock(space: SpaceLike, w: WorldDef): Promise<void> {
	const now = await worldNowOf(space);
	for (const n of w.npcs) {
		const sells = (n.carry ?? []).filter((c) => c.proto !== w.currency && (n.prices?.[c.proto]?.[1] ?? 0) > 0);
		if (!sells.length) continue;
		const charId = `npc-${n.npcId}`;
		if (!(await space.readAll({ type: "Character", fields: { charId } }, { limit: 1 })).length) continue; // in another region
		for (const c of sells) {
			const have = await space.count({ type: "Item", fields: { location: charId, proto: c.proto } });
			const e = await peek(space, { type: "Restock", fields: { charId, proto: c.proto } });
			const r = e ? fieldsOf<RestockFields>(e) : null;
			if (have >= c.count) { if (e) await space.takeIfExists({ type: "Restock", id: e.id }, NO_WAIT); continue; }
			if (r && r.nextWorldMs > now) continue;
			const txn = (await space.createTransaction(10_000)).id;
			try {
				if (e && !(await space.takeIfExists({ type: "Restock", id: e.id }, NO_WAIT, { txn }))) { await space.abort(txn); continue; } // another worker
				// the first time it runs short, the clock starts; one comes back when it is up
				if (r) { const p = await resolvePrototype(space, c.proto); if (p) await spawn(space, txn, w, p, { location: charId, x: -1, y: -1 }); }
				if (!r || have + 1 < c.count) await space.write({ type: "Restock", fields: { charId, proto: c.proto, nextWorldMs: now + RESTOCK_WORLD_MS } satisfies RestockFields as never }, txn, FOREVER);
				await space.commit(txn);
			} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
		}
	}
}

export async function marketTick(space: SpaceLike, w?: WorldDef): Promise<void> {
	if (w) await restock(space, w);
	for (const e of await space.readAll({ type: "Item", fields: { location: "market" } })) {
		const f = fieldsOf<ItemFields>(e);
		try { if (f.listing && (await readExisting(space, f.listing.startsWith("w-") ? { type: "Wanted", fields: { wantedId: f.listing } } : { type: "Listing", fields: { listingId: f.listing } }))) continue; } catch (err) { if (err instanceof StillHeld) continue; throw err; }
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ type: "Item", id: e.id }, NO_WAIT, { txn });
			if (t) { const { listing: _l, seller, ...rest } = fieldsOf<ItemFields>(t); await space.write({ type: t.type, types: t.types.slice(1), fields: { ...rest, location: seller ?? rest.location, x: -1, y: -1 } as never }, txn, FOREVER); }
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
}
