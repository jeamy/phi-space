// The people of the archipelago (docs/welt.md): script NPCs that gather, keep fires, craft, trade and talk. They act
// only by typing the commands a player types (npc.act → an intent the world worker runs), so every exchange of theirs is
// a player's exchange, in one transaction, nothing lost or doubled (Phase 4). No model calls. A round looks at the world
// once, types at most one or two commands and rests a few game seconds; the world worker refuses what has become
// impossible meanwhile (someone was faster), and the next round looks again.
//
//   sammler     gathers what washes up in its home rooms and sells it at its market
//   huter       keeps its island's fire burning; gathers or buys wood for it
//   haendler    travels between the markets of its route; buys cheap, sells dear
//   handwerker  gathers and buys the inputs of its recipes, crafts, sells what it made
//   plauderer   walks about, tells what it knows: prices, fires, orders, stories, now and then on the harbour channel
//
// All of them answer trade offers by their price list, tell people who speak to them what they buy and sell, and the
// traders and keepers offer people coins for what they want.
import { randomInt } from "node:crypto";
import { flameOf } from "../engine/fire.ts";
import { gameMs } from "../engine/time.ts";
import type { WorldDef } from "../engine/world.ts";
import { fieldsOf, type CharacterFields, type ItemFields, type ListingFields, type MsgFields, type OfferFields, type OrderFields } from "../model.ts";
import { byPerson, humansIn, newHeard, self, type Npc, type Script } from "./scripts.ts";

/** One round of a trader or a worker: every look is several calls to the space (each a transaction), and players do not
 *  wait on a trader as they do on the keeper, so the rounds are not short. */
const round = () => gameMs(8_000, 200);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pick = <T>(xs: T[]): T | undefined => xs[randomInt(0, Math.max(1, xs.length))];

/** What the NPC sees this round: itself, its pack and what lies in its room. */
type Look = { me: CharacterFields; pack: ItemFields[]; ground: ItemFields[] };
async function look(n: Npc): Promise<Look | null> {
	const me = await self(n);
	if (!me) return null;
	const pack = (await n.space.readAll({ type: "Item", fields: { location: me.charId } })).map((e) => fieldsOf<ItemFields>(e));
	const ground = (await n.space.readAll({ type: "Item", fields: { location: me.room } })).map((e) => fieldsOf<ItemFields>(e));
	return { me, pack, ground };
}

const buyPrice = (n: Npc, proto: string) => (proto === n.world.currency ? 1 : (n.def.prices?.[proto]?.[0] ?? 0));
const sellPrice = (n: Npc, proto: string) => (proto === n.world.currency ? 1 : (n.def.prices?.[proto]?.[1] ?? 0));
const coinsOf = (n: Npc, l: Look) => l.pack.filter((i) => i.proto === n.world.currency);
const protoName = (w: WorldDef, proto: string) => w.prototypes.find((p) => p.key === proto)?.name ?? proto;
/** The prototype a player means by a name ("münze", "holz", "Treibholz"). */
const protoOf = (w: WorldDef, name: string) => {
	const n = name.trim().toLowerCase();
	return w.prototypes.find((p) => p.key === n || p.name.toLowerCase() === n || p.aliases.includes(n))?.key;
};
const roomName = (w: WorldDef, roomId: string) => w.rooms.find((r) => r.roomId === roomId)?.name ?? roomId;
const islandOf = (w: WorldDef, roomId: string) => w.rooms.find((r) => r.roomId === roomId)?.island ?? w.title;

/** The name of the first exit on the shortest way from one room to another (over the world's exits), or null. */
export function wayTo(w: WorldDef, from: string, to: string): string | null {
	if (from === to) return null;
	const first = new Map<string, string>([[from, ""]]);
	let frontier = [from];
	while (frontier.length) {
		const next: string[] = [];
		for (const r of frontier) for (const e of w.exits.filter((x) => x.room === r)) {
			if (first.has(e.destination)) continue;
			first.set(e.destination, first.get(r) || e.name);
			if (e.destination === to) return first.get(to)!;
			next.push(e.destination);
		}
		frontier = next;
	}
	return null;
}

/** One step of the way to `room`: true when the NPC is there already. */
async function travel(n: Npc, l: Look, room: string): Promise<boolean> {
	if (l.me.room === room) return true;
	const exit = wayTo(n.world, l.me.room, room);
	if (exit) await n.act(`go ${exit}`);
	return !exit;
}

/** Picks up the nearest thing of `protos` lying here (walks to it first): true when it did something. */
async function gather(n: Npc, l: Look, protos: string[]): Promise<boolean> {
	const d = (i: ItemFields) => Math.max(Math.abs(i.x - l.me.x), Math.abs(i.y - l.me.y));
	const there = l.ground.filter((i) => protos.includes(i.proto)).sort((a, b) => d(a) - d(b))[0];
	if (!there) return false;
	if (d(there) <= 1) await n.act(`get ${there.name}`);
	else await n.act(`move ${there.x} ${there.y}`);
	return true;
}

/** At a market: puts one carried thing it sells on the board (at most three of its own hang there). */
async function sell(n: Npc, l: Look, except: string[] = []): Promise<boolean> {
	if (!n.world.market.rooms.includes(l.me.room)) return false;
	const listings = (await n.space.readAll({ type: "Listing", fields: { room: l.me.room } })).map((e) => fieldsOf<ListingFields>(e));
	if (listings.filter((x) => x.seller === l.me.charId).length >= 3) return false;
	const item = l.pack.find((i) => i.proto !== n.world.currency && sellPrice(n, i.proto) > 0 && !except.includes(i.proto));
	if (!item) return false;
	await n.act(`market biete ${item.name} für ${sellPrice(n, item.proto)}`);
	return true;
}

/** At a market: buys the first thing on the board it pays at least the price for (and has the coins), unless it holds
 *  four of it already. */
async function buy(n: Npc, l: Look, only?: string[]): Promise<boolean> {
	if (!n.world.market.rooms.includes(l.me.room)) return false;
	const listings = (await n.space.readAll({ type: "Listing", fields: { room: l.me.room } })).map((e) => fieldsOf<ListingFields>(e)).sort((a, b) => a.at - b.at || a.listingId.localeCompare(b.listingId));
	const coins = coinsOf(n, l).length;
	const i = listings.findIndex((x) => {
		const p = protoOf(n.world, x.itemName);
		return !!p && x.seller !== l.me.charId && (!only || only.includes(p)) && x.price <= buyPrice(n, p) && x.price <= coins && l.pack.filter((it) => it.proto === p).length < 4;
	});
	if (i < 0) return false;
	await n.act(`market kaufe ${i + 1}`);
	return true;
}

/** Answers the oldest trade offer made to it by its price list: what it gets is worth what it would pay, what it gives
 *  what it asks; coins count one. A gift it takes with thanks. */
async function answerOffers(n: Npc, l: Look): Promise<boolean> {
	const o = (await n.space.readAll({ type: "Offer", fields: { to: l.me.charId } })).map((e) => fieldsOf<OfferFields>(e)).sort((a, b) => a.at - b.at)[0];
	if (!o) return false;
	const gets = (await Promise.all(o.give.map((id) => n.space.readIfExists({ type: "Item", fields: { itemId: id } }, 1_000)))).filter((e) => !!e).map((e) => fieldsOf<ItemFields>(e!));
	if (!o.want.length) {
		await n.act(`accept ${o.fromName}`);
		await n.act(`say Danke, ${o.fromName}! Das kann ich gut brauchen.`);
		return true;
	}
	const worth = gets.reduce((s, i) => s + buyPrice(n, i.proto), 0);
	let asked = 0, missing = "", notMine = "";
	for (const w of o.want) {
		const p = protoOf(n.world, w.name);
		const price = p ? sellPrice(n, p) : 0;
		if (!p || (p !== n.world.currency && !price)) { notMine ||= w.name; continue; }
		if (l.pack.filter((i) => i.proto === p).length < w.count) missing ||= protoName(n.world, p);
		asked += price * w.count;
	}
	if (notMine) { await n.act(`decline ${o.fromName}`); await n.act(`say ${o.fromName}, ${notMine} gebe ich nicht her.`); return true; }
	if (missing) { await n.act(`decline ${o.fromName}`); await n.act(`say ${o.fromName}, ${missing} habe ich gerade nicht.`); return true; }
	if (worth >= asked && worth > 0) {
		await n.act(`accept ${o.fromName}`);
		await n.act(`say Abgemacht, ${o.fromName}.`);
		return true;
	}
	await n.act(`decline ${o.fromName}`);
	const fair = gets.length ? `Für ${gets.map((i) => i.name).join(", ")} gebe ich höchstens ${plural(worth, "Münze", "Münzen")}` : "Davon halte ich nichts";
	await n.act(`say ${o.fromName}, das ist mir zu wenig. ${fair}.`);
	return true;
}

/** What it buys and sells, said to someone who asked. */
function tradeTalk(n: Npc, to: string): string {
	const prices = Object.entries(n.def.prices ?? {});
	const buys = prices.filter(([, [b]]) => b > 0).map(([p, [b]]) => `${protoName(n.world, p)} (bis ${b})`);
	const sells = prices.filter(([, [, s]]) => s > 0).map(([p, [, s]]) => `${protoName(n.world, p)} (${s})`);
	if (!buys.length && !sells.length) return `${to}, ${pick(n.def.lines ?? []) ?? "schön, dich zu sehen."}`;
	return [`${to},`, buys.length ? `ich kaufe ${buys.join(", ")}` : "", buys.length && sells.length ? "und" : "", sells.length ? `verkaufe ${sells.join(", ")}` : "", `– in Münzen. Biete mir etwas an: offer <ding> an ${n.def.name} für <n> münze.`].filter(Boolean).join(" ");
}

/** The common part of every round: offers first, then whoever spoke to it. True when it did something. */
function social(): (n: Npc, l: Look) => Promise<boolean> {
	const heard = newHeard();
	const greeted = new Map<string, number>();
	return async (n, l) => {
		if (await answerOffers(n, l)) return true;
		const said = (await heard(n, l.me)).filter(byPerson);
		const named = said.find((m: MsgFields) => m.text.toLowerCase().includes(n.def.name.toLowerCase()));
		if (named) { await n.act(`say ${n.def.script === "plauderer" ? `${named.from}, ${pick(n.def.lines ?? []) ?? "ja?"}` : tradeTalk(n, named.from)}`); return true; }
		const hello = said.find((m) => /\b(hallo|hi|moin|servus|hello|hey)\b/i.test(m.text) && Date.now() - (greeted.get(m.from) ?? 0) > gameMs(10 * 60_000));
		if (hello && randomInt(0, 3) === 0) { greeted.set(hello.from, Date.now()); await n.act(`say Moin, ${hello.from}.`); return true; }
		return false;
	};
}

/** Offers a person here coins for something it buys and they carry (once per person and thing every ten game
 *  minutes, and only while no offer of its own waits). */
function pitcher(): (n: Npc, l: Look, protos?: string[]) => Promise<boolean> {
	const pitched = new Map<string, number>();
	return async (n, l, protos) => {
		if ((await n.space.count({ type: "Offer", fields: { from: l.me.charId } })) > 0) return false;
		const people = await humansIn(n, l.me.room);
		if (!people.length) return false;
		const coins = coinsOf(n, l).length;
		for (const ch of (await n.space.readAll({ type: "Character", fields: { room: l.me.room } })).map((e) => fieldsOf<CharacterFields>(e)).filter((c) => people.includes(c.name))) {
			const theirs = (await n.space.readAll({ type: "Item", fields: { location: ch.charId } })).map((e) => fieldsOf<ItemFields>(e));
			const want = theirs.find((i) => (!protos || protos.includes(i.proto)) && buyPrice(n, i.proto) > 0 && i.proto !== n.world.currency && buyPrice(n, i.proto) <= coins && Date.now() - (pitched.get(`${ch.charId}:${i.proto}`) ?? 0) > gameMs(10 * 60_000));
			if (!want) continue;
			pitched.set(`${ch.charId}:${want.proto}`, Date.now());
			const price = buyPrice(n, want.proto);
			await n.act(`offer ${price} münze an ${ch.name} für ${want.name.toLowerCase()}`);
			await n.act(`say ${ch.name}, für dein ${want.name} zahle ich ${plural(price, "Münze", "Münzen")}. „accept ${n.def.name}“, wenn du einverstanden bist.`);
			return true;
		}
		return false;
	};
}

/** Now and then a line of its own, while people are there to hear it. */
function chatter(everyMs: number): (n: Npc, l: Look) => Promise<boolean> {
	let last = Date.now() - randomInt(0, everyMs);
	return async (n, l) => {
		if (Date.now() - last < gameMs(everyMs) || !n.def.lines?.length) return false;
		last = Date.now();
		if (!(await humansIn(n, l.me.room)).length) return false;
		await n.act(`say ${pick(n.def.lines)!}`);
		return true;
	};
}

function sammler(): Script {
	const talk = social(), say = chatter(3 * 60_000);
	let home = 0;
	return async (n) => {
		const l = await look(n);
		if (!l) { await n.sleep(1000); return; }
		const goods = Object.entries(n.def.prices ?? {}).filter(([, [, s]]) => s > 0).map(([p]) => p);
		const homes = n.def.home ?? [l.me.room];
		const carried = l.pack.filter((i) => goods.includes(i.proto));
		const done = (await talk(n, l)) || (await say(n, l));
		if (!done) {
			const toSell = carried.length >= 3 || (carried.length && !l.ground.some((i) => goods.includes(i.proto)) && !homes.includes(l.me.room));
			if (toSell && n.def.market) {
				// at the market: one thing on the board per round; when nothing more goes up, back to the beaches
				if ((await travel(n, l, n.def.market)) && !(await sell(n, l))) { home = (home + 1) % homes.length; await travel(n, l, homes[home]!); }
			}
			else if (!homes.includes(l.me.room)) await travel(n, l, homes[home]!);
			else if (!(await gather(n, l, goods))) {
				if (carried.length && n.def.market) await travel(n, l, n.def.market);
				else { home = (home + 1) % homes.length; await travel(n, l, homes[home]!); }
			}
		}
		await n.sleep(round());
	};
}

function huter(): Script {
	const talk = social(), say = chatter(4 * 60_000), offer = pitcher();
	let home = 0;
	return async (n) => {
		const l = await look(n);
		if (!l) { await n.sleep(1000); return; }
		const beacon = n.world.beacons.find((b) => b.beaconId === n.def.beacon);
		if (!beacon) { await n.sleep(gameMs(60_000)); return; }
		const fuels = Object.keys(n.world.fire.fuel);
		const fuel = l.pack.filter((i) => fuels.includes(i.proto));
		const f = await flameOf(n.space, beacon.beaconId), now = Date.now();
		const piece = Math.min(...Object.values(n.world.fire.fuel).map((ms) => gameMs(ms)));
		const weak = !f || f.until - now < piece * 3;
		const homes = n.def.home ?? [beacon.room];
		let acted = (await talk(n, l));
		if (!acted && weak && fuel.length) {
			if (await travel(n, l, beacon.room)) {
				if (Math.max(Math.abs(l.me.x - beacon.x), Math.abs(l.me.y - beacon.y)) <= 1) await n.act(`put ${fuel[0]!.name} in ${beacon.aliases[0] ?? "feuer"}`);
				else await nextTo(n, l, beacon);
			}
			acted = true;
		}
		if (!acted && fuel.length < 3) {
			acted = (homes.includes(l.me.room) && (await gather(n, l, fuels))) || (await buy(n, l, fuels)) || (await offer(n, l, fuels));
			if (!acted && fuel.length < 1 && homes.length > 1) { home = (home + 1) % homes.length; acted = !(await travel(n, l, homes[home]!)); }
		}
		if (!acted) acted = (await offer(n, l, fuels)) || (await say(n, l));
		if (!acted && l.me.room !== beacon.room) await travel(n, l, beacon.room);
		await n.sleep(round());
	};
}

/** Walks to a free cell next to `at` (a fire): the first one no one stands on. */
async function nextTo(n: Npc, l: Look, at: { x: number; y: number }): Promise<void> {
	const ground = n.world.rooms.find((r) => r.roomId === l.me.room)?.ground ?? [];
	const busy = new Set((await n.space.readAll({ type: "Character", fields: { room: l.me.room } })).map((e) => `${e.fields.x},${e.fields.y}`));
	for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
		const x = at.x + dx, y = at.y + dy;
		if (busy.has(`${x},${y}`) || !",.:".includes(ground[y]?.[x] ?? "~")) continue;
		await n.act(`move ${x} ${y}`);
		return;
	}
}

function haendler(): Script {
	const talk = social(), say = chatter(3 * 60_000), offer = pitcher();
	let at = 0, rounds = 0;
	return async (n) => {
		const l = await look(n);
		if (!l) { await n.sleep(1000); return; }
		const route = n.def.route ?? [l.me.room];
		const target = route[at % route.length]!;
		if (l.me.room !== target) { if (!(await talk(n, l))) await travel(n, l, target); await n.sleep(round()); return; }
		// at a market of its route: buys below its price, asks more than it paid; after a while it moves on
		const acted = (await talk(n, l)) || (await buy(n, l)) || (await sell(n, l)) || (await offer(n, l)) || (await say(n, l));
		rounds++;
		if (route.length > 1 && (rounds > 12 || (!acted && rounds > 4))) { at++; rounds = 0; }
		await n.sleep(round());
	};
}

function handwerker(): Script {
	const talk = social(), say = chatter(3 * 60_000), offer = pitcher();
	return async (n) => {
		const l = await look(n);
		if (!l) { await n.sleep(1000); return; }
		const recipes = n.world.recipes.filter((r) => n.def.crafts?.includes(r.key));
		const has = (proto: string, count: number) => l.pack.filter((i) => i.proto === proto).length >= count;
		const can = recipes.find((r) => r.needs.every((x) => has(x.proto, x.count)) && (!r.tool || has(r.tool, 1)));
		const inputs = [...new Set(recipes.flatMap((r) => r.needs.map((x) => x.proto)))];
		const products = l.pack.filter((i) => recipes.some((r) => r.makes === i.proto) && sellPrice(n, i.proto) > 0);
		const homes = n.def.home ?? [l.me.room];
		let acted = await talk(n, l);
		// a tool it needs and lacks comes first: it makes one when it can
		const toolless = recipes.find((r) => r.tool && !has(r.tool, 1));
		const toolRecipe = toolless && recipes.find((r) => r.makes === toolless.tool && r.needs.every((x) => has(x.proto, x.count)));
		if (!acted && (toolRecipe || can)) { await n.act(`craft ${(toolRecipe ?? can)!.key}`); acted = true; }
		// its last tool it keeps
		const keep = recipes.flatMap((r) => (r.tool && !has(r.tool, 2) ? [r.tool] : []));
		if (!acted && products.length >= 2 && n.def.market) { if (await travel(n, l, n.def.market)) acted = await sell(n, l, keep); else acted = true; }
		if (!acted) acted = (await buy(n, l, inputs)) || (await offer(n, l, inputs));
		if (!acted && homes.includes(l.me.room)) acted = await gather(n, l, inputs);
		if (!acted && !homes.includes(l.me.room) && !(products.length && n.def.market === l.me.room)) acted = !(await travel(n, l, homes[0]!));
		if (!acted) await say(n, l);
		await n.sleep(round());
	};
}

function plauderer(): Script {
	const talk = social(), say = chatter(2 * 60_000);
	let lastGossip = Date.now() - randomInt(0, gameMs(8 * 60_000)), home = 0;
	return async (n) => {
		const l = await look(n);
		if (!l) { await n.sleep(1000); return; }
		let acted = (await talk(n, l)) || (await say(n, l));
		if (!acted && Date.now() - lastGossip > gameMs(8 * 60_000)) {
			lastGossip = Date.now();
			const g = await gossip(n);
			if (g) { await n.act(randomInt(0, 2) && (await humansIn(n, l.me.room)).length ? `say ${g}` : `kanal ${n.world.channels[0] ?? "hafen"} ${g}`); acted = true; }
		}
		if (!acted) {
			const homes = n.def.home ?? [l.me.room];
			if (!homes.includes(l.me.room)) await travel(n, l, homes[home]!);
			else if (randomInt(0, 6) === 0 && homes.length > 1) { home = (home + 1) % homes.length; await travel(n, l, homes[home]!); }
			else if (randomInt(0, 3) === 0) {
				const ground = n.world.rooms.find((r) => r.roomId === l.me.room)?.ground ?? [];
				const x = Math.min(22, Math.max(1, l.me.x + randomInt(-4, 5))), y = Math.min(14, Math.max(1, l.me.y + randomInt(-3, 4)));
				if (",.".includes(ground[y]?.[x] ?? "~")) await n.act(`move ${x} ${y}`);
			}
		}
		await n.sleep(round());
	};
}

/** Something true about the world, told like news: a price on a board, a fire that is out, an order that pays well. */
async function gossip(n: Npc): Promise<string | null> {
	const w = n.world;
	const told: string[] = [];
	const listing = pick((await n.space.readAll({ type: "Listing" })).map((e) => fieldsOf<ListingFields>(e)));
	if (listing) told.push(`Am Marktbrett in ${roomName(w, listing.room)} gibt es ${listing.itemName} für ${plural(listing.price, "Münze", "Münzen")}.`);
	for (const b of w.beacons) {
		const f = await flameOf(n.space, b.beaconId);
		if (!f || f.until <= Date.now()) told.push(`Das ${b.name} auf ${islandOf(w, b.room)} ist aus – dort steigt der Nebel.`);
	}
	const order = pick((await n.space.readAll({ type: "Order" })).map((e) => fieldsOf<OrderFields>(e)).filter((o) => !o.takenBy));
	if (order) told.push(`An der Tafel in ${roomName(w, order.room)}: ${order.text} ${plural(order.reward.count, "Münze", "Münzen")} Lohn.`);
	return pick(told) ?? null;
}

export const ECONOMY: Record<string, () => Script> = { sammler, huter, haendler, handwerker, plauderer };
