// Roads and carts, step 8 (docs/siedeln.en.md "Road", "Cart, wagon"). A road is planned and voted on (road.ts): it links the
// two rooms it runs between, within an island. A cart stands in a room with its cargo at `cartId`; its owner loads it, sends it to a
// room the roads reach, and it goes a room at a time on the world clock, with nobody beside it. On a standing route
// (`karren pendel`) it does so by itself: it loads from its owner's chests at one end, unloads into them at the other and
// comes back, as long as there is something to carry. Roads stay on their island; a cart crosses the water as a thing
// (`karren nimm`: in the pack, a boat's hatch or the railway's freight).
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type CartFields, type FreightFields, type ItemFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, roomOf, toPlayer, type CommandCtx } from "../context.ts";
import type { WorldDef } from "../world.ts";
import { trainIn } from "../rail.ts";
import { amount, ARTICLE, distTo, giveBack, planOf } from "./build.ts";
import { placeIn, relocate } from "./default.ts";
import { consume, move } from "./trade.ts";
import { countTrip } from "../travel.ts";
import { randomBytes, timeNow } from "../source.ts";
import { routeLinks, strasse } from "./road.ts";

/** Room to rooms the roads join, both ways: a finished road (road.ts) links the two rooms it runs between. */
export async function roadLinks(space: SpaceLike, w: WorldDef, txn: string | null = null): Promise<Map<string, Set<string>>> {
	const links = new Map<string, Set<string>>();
	if (!w.cart) return links;
	const link = (a: string, b: string) => { if (!links.has(a)) links.set(a, new Set()); links.get(a)!.add(b); };
	for (const [a, b] of await routeLinks(space, txn)) { link(a, b); link(b, a); }
	return links;
}
/** The rooms from `from` to `to` by road, without `from`; null when no road goes there. */
export function roadPath(links: Map<string, Set<string>>, from: string, to: string): string[] | null {
	const before = new Map<string, string>([[from, from]]), queue = [from];
	for (let i = 0; i < queue.length; i++) for (const n of links.get(queue[i]!) ?? []) {
		if (before.has(n)) continue;
		before.set(n, queue[i]!); queue.push(n);
		if (n === to) { const path = [to]; for (let at = to; before.get(at) !== from; at = before.get(at)!) path.unshift(before.get(at)!); return path; }
	}
	return null;
}

const nameOf = (c: CommandCtx, room: string) => (c.world.allRooms ?? c.world.rooms).find((r) => r.roomId === room)?.name ?? room;
const cargoOf = async (c: CommandCtx, cartId: string) => (await c.space.readAll({ type: "Item", fields: { location: cartId } }, { txn: c.txn })).map((e) => fieldsOf<ItemFields>(e));
/** The actor's cart here, taken in the transaction. */
async function mine(c: CommandCtx): Promise<CartFields> {
	const all = (await c.space.readAll({ type: "Cart", fields: { room: c.actor.room } }, { txn: c.txn })).map((e) => fieldsOf<CartFields>(e));
	const f = all.find((x) => x.accountId === c.account?.accountId && Math.max(Math.abs(x.x - c.actor.x), Math.abs(x.y - c.actor.y)) <= 1);
	if (!f) throw new CommandError("Neben dir steht kein Karren von dir.");
	if (!(await c.space.takeIfExists({ type: "Cart", fields: { cartId: f.cartId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Der Karren ist gerade nicht greifbar; bitte noch einmal.");
	return f;
}
const put = (c: CommandCtx, f: CartFields) => c.space.write({ type: "Cart", fields: f as never }, c.txn, FOREVER);

const karren: Command = {
	key: "karren", aliases: ["cart", "wagen"],
	help: "karren – deine Karren; karren stelle, karren lade <ding>, karren entlade, karren fahre <ort> (nur auf Straßen), karren pendel <ort> [mit <ding>], karren halt, karren nimm",
	async func(c, arg) {
		const d = c.world.cart;
		if (!d) throw new CommandError("In dieser Welt gibt es keine Karren.");
		if (!c.account || c.account.guest) throw new CommandError("Gäste haben keine Karren; registriere dich dafür.");
		const [word = "", ...rest] = arg.trim().split(/\s+/), tail = rest.join(" ").replace(ARTICLE, "");
		if (!word) {
			const carts = (await c.space.readAll({ type: "Cart" }, { txn: c.txn })).map((e) => fieldsOf<CartFields>(e)).filter((x) => x.accountId === c.account!.accountId);
			const lines = await Promise.all(carts.map(async (x) => `in ${nameOf(c, x.room)}${x.path.length ? `, unterwegs nach ${nameOf(c, x.path.at(-1)!)}` : ""}${x.route ? `, pendelt zwischen ${nameOf(c, x.route.from)} und ${nameOf(c, x.route.to)}` : ""}, ${(await cargoOf(c, x.cartId)).length} von ${d.capacity} Stück geladen`));
			return msg(c, c.actor.charId, "info", lines.length ? `Deine Karren: ${lines.join("; ")}.` : "Du hast keinen Karren draußen. „karren stelle“ stellt einen ab, den du trägst.");
		}
		if (/^(?:stelle|abstellen|place)$/i.test(word)) {
			const it = (await inventory(c)).find((i) => i.f.proto === d.proto);
			if (!it) throw new CommandError("Du trägst keinen Karren.");
			await consume(c, it.f, c.actor.charId);
			await put(c, { cartId: `cart-${randomBytes(6).toString("hex")}`, accountId: c.account.accountId, charId: c.actor.charId, ownerName: c.actor.name, room: c.actor.room, x: c.actor.x, y: c.actor.y, path: [], dueWorldMs: FOREVER });
			return msg(c, "*", "info", "$you() $conj(stellst|stellt) einen Karren ab.", { templ: true });
		}
		// a standing route ends wherever its cart is: it finishes the way it is on and stays
		if (/^(?:halt|stopp?|stop)$/i.test(word)) {
			let n = 0;
			for (const e of await c.space.readAll({ type: "Cart" }, { txn: c.txn })) {
				const x = fieldsOf<CartFields>(e);
				if (x.accountId !== c.account.accountId || !x.route || !(await c.space.takeIfExists({ id: e.id }, NO_WAIT, { txn: c.txn }))) continue;
				const { route: _r, ...rest } = x;
				await put(c, { ...rest, dueWorldMs: rest.path.length ? rest.dueWorldMs : FOREVER });
				n++;
			}
			if (!n) throw new CommandError("Kein Karren von dir pendelt.");
			return msg(c, c.actor.charId, "info", n === 1 ? "Dein Karren pendelt nicht mehr; er bleibt, wo er als Nächstes ankommt." : `${n} Karren pendeln nicht mehr.`);
		}
		const f = await mine(c);
		if (f.path.length) throw new CommandError("Der Karren ist unterwegs.");
		const cargo = await cargoOf(c, f.cartId);
		if (/^(?:lade|load)$/i.test(word)) {
			const it = itemsNamed(c.world, await inventory(c), tail)[0];
			if (!tail || !it) throw new NotUnderstood(`Du trägst nichts, was „${tail.slice(0, 30)}“ heißt.`);
			if (it.f.proto === d.proto) throw new CommandError("Ein Karren passt nicht auf einen Karren.");
			if (cargo.length >= d.capacity) throw new CommandError(`Mehr als ${d.capacity} Stück trägt er nicht.`);
			await move(c, it.f, c.actor.charId, f.cartId);
			await put(c, f);
			return msg(c, c.actor.charId, "info", `${it.f.name} liegt auf dem Karren (${cargo.length + 1} von ${d.capacity}).`);
		}
		if (/^(?:entlade|unload)$/i.test(word)) {
			for (const it of cargo) await move(c, it, f.cartId, c.actor.charId);
			await put(c, f);
			return msg(c, c.actor.charId, "info", cargo.length ? `Du nimmst ${cargo.length} Stück vom Karren.` : "Der Karren ist leer.");
		}
		if (/^(?:nimm|take)$/i.test(word)) {
			if (cargo.length) throw new CommandError("Erst entladen.");
			await giveBack(c, [{ proto: d.proto, count: 1 }]);
			return msg(c, c.actor.charId, "info", "Du nimmst den Karren wieder mit.");
		}
		if (/^(?:fahre|drive|go)$/i.test(word)) {
			const room = (c.world.rooms).find((r) => r.name.toLowerCase() === tail.toLowerCase() || r.roomId === tail);
			if (!room) throw new NotUnderstood(`Einen Ort „${tail.slice(0, 30)}“ kennt der Karren nicht.`);
			const path = roadPath(await roadLinks(c.space, c.world, c.txn), f.room, room.roomId);
			if (!path) throw new CommandError(`Nach ${room.name} führt keine Straße.`);
			await put(c, { ...f, path, dueWorldMs: (await worldNowOf(c.space, c.txn)) + d.hopWorldMs });
			return msg(c, "*", "info", `$you() $conj(schickst|schickt) den Karren nach ${room.name}.`, { templ: true });
		}
		if (/^(?:pendel|pendle|pendeln|route|shuttle)$/i.test(word)) {
			const m = /^(.+?)(?:\s+mit\s+(.+))?$/i.exec(tail)!;
			const room = c.world.rooms.find((r) => r.name.toLowerCase() === m[1]!.trim().toLowerCase() || r.roomId === m[1]!.trim());
			if (!room) throw new NotUnderstood(`Einen Ort „${m[1]!.slice(0, 30)}“ kennt der Karren nicht.`);
			if (room.roomId === f.room) throw new CommandError("Er pendelt zwischen zwei Orten; nenn den anderen.");
			if (!roadPath(await roadLinks(c.space, c.world, c.txn), f.room, room.roomId)) throw new CommandError(`Nach ${room.name} führt keine Straße.`);
			let proto: string | undefined;
			if (m[2]) {
				const p = c.world.prototypes.find((x) => [x.key, x.name, ...(x.aliases ?? [])].some((n) => n.toLowerCase() === m[2]!.replace(ARTICLE, "").trim().toLowerCase()));
				if (!p) throw new NotUnderstood(`„${m[2]!.slice(0, 30)}“ kennt der Karren nicht.`);
				proto = p.key;
			}
			const chest = (r: string) => c.space.readAll({ type: "Building", fields: { room: r, accountId: c.account!.accountId } }, { txn: c.txn }).then((xs) => xs.some((e) => { const p = planOf(c.world, String(e.fields.plan)); return !!p?.chest && !p.store; }));
			if (!(await chest(f.room)) || !(await chest(room.roomId))) throw new CommandError(`Zum Pendeln brauchst du an beiden Enden einen Bau mit Truhe: hier und in ${room.name}.`);
			await put(c, { ...f, route: { from: f.room, to: room.roomId, ...(proto ? { proto } : {}) }, dueWorldMs: await worldNowOf(c.space, c.txn) });
			return msg(c, c.actor.charId, "info", `Dein Karren pendelt jetzt zwischen ${nameOf(c, f.room)} und ${room.name}: hier lädt er ${proto ? `${c.world.prototypes.find((x) => x.key === proto)!.name} ` : ""}aus deiner Truhe, dort legt er es in deine Truhe und kommt zurück. Leer fährt er nicht. „karren halt“ beendet es.`);
		}
		throw new NotUnderstood("So geht es: karren, karren stelle, karren lade <ding>, karren entlade, karren fahre <ort>, karren pendel <ort> [mit <ding>], karren halt, karren nimm.");
	},
};

/** Moves what lies at `from` to `to` in the tick's transaction. */
async function shift(space: SpaceLike, txn: string, items: ItemFields[], from: string, to: string): Promise<number> {
	let n = 0;
	for (const it of items) {
		const e = await space.takeIfExists({ type: "Item", fields: { itemId: it.itemId, location: from } }, NO_WAIT, { txn });
		if (!e) continue;
		await space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, location: to, x: -1, y: -1 } as never }, txn, FOREVER);
		n++;
	}
	return n;
}
/** A cart on its route at one of its ends: at `to` it unloads into its owner's chests there (as far as they hold), at
 *  `from` it loads from them (what the route names, never coins, carts or a dog or cat on guard). The way it goes on,
 *  or [] to wait a while (a full chest, nothing to carry, no road). */
async function routeStop(space: SpaceLike, w: WorldDef, txn: string, f: CartFields): Promise<string[]> {
	const d = w.cart!, r = f.route!, keepers = new Set((w.wild?.keepers ?? []).map((k) => k.proto));
	const chests = (await space.readAll({ type: "Building", fields: { room: f.room, accountId: f.accountId } }, { txn })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => planOf(w, b.plan)?.chest && !planOf(w, b.plan)?.store);
	const inside = async (id: string) => (await space.readAll({ type: "Item", fields: { location: id } }, { txn })).map((e) => fieldsOf<ItemFields>(e));
	let cargo = await inside(f.cartId);
	if (f.room === r.to) {
		for (const b of chests) {
			// a chest has no limit where the world has loads (pack.ts: only the pack has one), else it holds its things
			const room = w.pack ? Infinity : planOf(w, b.plan)!.chest! - (await inside(b.buildId)).filter((i) => !keepers.has(i.proto)).length;
			const fit = Math.min(cargo.length, room);
			if (fit > 0) cargo = cargo.slice(await shift(space, txn, cargo.slice(0, fit), f.cartId, b.buildId));
		}
		return cargo.length ? [] : roadPath(await roadLinks(space, w, txn), f.room, r.from) ?? [];
	}
	if (f.room === r.from) {
		for (const b of chests) {
			const free = d.capacity - cargo.length;
			if (free <= 0) break;
			const goods = (await inside(b.buildId)).filter((i) => i.proto !== w.currency && i.proto !== d.proto && !keepers.has(i.proto) && (!r.proto || i.proto === r.proto));
			const n = await shift(space, txn, goods.slice(0, free), b.buildId, f.cartId);
			cargo = [...cargo, ...goods.slice(0, n)];
		}
		return cargo.length ? roadPath(await roadLinks(space, w, txn), f.room, r.to) ?? [] : [];
	}
	// left its route (driven elsewhere before): back to where it loads
	return roadPath(await roadLinks(space, w, txn), f.room, r.from) ?? [];
}

/** The carts whose date has come go a room on (in the job of the garden); a cart on a route at one of its ends loads or
 *  unloads and sets off, or waits a hop's time and looks again. How many moved or worked. */
export async function cartTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	const d = w.cart;
	if (!d) return 0;
	const now = await worldNowOf(space);
	let moved = 0;
	for (const e of await space.readAll({ type: "Cart" })) {
		if (fieldsOf<CartFields>(e).dueWorldMs > now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const t = await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
			if (!t) { await space.abort(txn); continue; }
			const f = fieldsOf<CartFields>(t);
			if (!f.path.length && f.route) {
				const path = await routeStop(space, w, txn, f);
				await space.write({ type: "Cart", fields: { ...f, path, dueWorldMs: now + d.hopWorldMs } as never }, txn, FOREVER);
				await space.commit(txn);
				moved++;
				continue;
			}
			const [next, ...rest] = f.path, target = next ? w.rooms.find((r) => r.roomId === next) : undefined;
			// a road that fell meanwhile does not stop it: the way was open when it left; on a route it works at the end
			await space.write({ type: "Cart", fields: { ...f, ...(target ? { room: target.roomId, x: target.spawn?.x ?? f.x, y: target.spawn?.y ?? f.y } : {}), path: rest, dueWorldMs: rest.length || f.route ? now + d.hopWorldMs : FOREVER } as never }, txn, FOREVER);
			if (!rest.length && target && !f.route) await toPlayer(space, { room: target.roomId, to: f.charId, kind: "info", text: `Dein Karren ist in ${target.name} angekommen.`, from: "", at: timeNow() }, txn);
			await space.commit(txn);
			moved++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return moved;
}

const zug: Command = {
	key: "zug", aliases: ["bahn", "train"],
	help: "zug <ort> – neben einem Bahnhof mit der Inselbahn zu einem anderen Bahnhof dieser Insel fahren; „zug“ allein zeigt die Bahnhöfe und den Fahrplan; „zug sende [n|alle] <ding> nach <ort>“ gibt Fracht auf, „zug abholen“ holt sie am Ziel",
	async func(c, arg) {
		const d = c.world.rail;
		if (!d) throw new CommandError("In dieser Welt fährt keine Bahn.");
		const island = c.world.rooms.find((r) => r.roomId === c.actor.room)?.island;
		const stations = (await c.space.readAll({ type: "Building", fields: { plan: d.plan } }, { txn: c.txn })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => c.world.rooms.find((r) => r.roomId === b.room)?.island === island);
		if (!stations.some((b) => b.room === c.actor.room && distTo(c.actor, b) <= 1)) throw new CommandError("Der Zug hält nur an Bahnhöfen; stell dich neben einen.");
		// one stop a room, however many stations stand in it
		const others = stations.filter((b, i) => b.room !== c.actor.room && stations.findIndex((x) => x.room === b.room) === i);
		const names = others.map((b) => nameOf(c, b.room)).join(", "), coins = `${d.fare} Münze${d.fare === 1 ? "" : "n"}`;
		const wait = trainIn(await worldNowOf(c.space, c.txn), d.everyWorldMs), when = wait ? ` Der Zug kommt in etwa ${Math.ceil(wait / 60_000)} Weltminuten.` : " Der Zug steht am Bahnsteig.";
		const mine = d.freight && c.account ? (await c.space.readAll({ type: "Freight", fields: { room: c.actor.room, accountId: c.account.accountId } }, { txn: c.txn })).map((e) => fieldsOf<FreightFields>(e)) : [];
		const stopAt = (name: string) => others.find((b) => nameOf(c, b.room).toLowerCase() === name.trim().toLowerCase() || b.room === name.trim().toLowerCase());
		const word = arg.trim().toLowerCase(), send = /^(?:sende|schicke|send)\s+(.+?)\s+nach\s+(.+)$/i.exec(arg.trim());
		if (!word) {
			let waiting = 0;
			for (const f of mine) waiting += await c.space.count({ type: "Item", fields: { location: f.freightId } }, c.txn);
			return msg(c, c.actor.charId, "info", (names ? `Der Zug fährt nach: ${names}, für ${coins}.${when}` : "Auf dieser Insel gibt es keinen anderen Bahnhof.") + (waiting ? ` Hier wartet Fracht für dich: ${waiting} Stück („zug abholen“).` : ""));
		}
		// what the railway carried for the actor to this station: all of it into the pack
		if (/^(?:abholen|hole|holen|fetch)$/.test(word)) {
			if (!mine.length) throw new CommandError("Hier wartet keine Fracht für dich.");
			let n = 0;
			for (const f of mine) {
				if (!(await c.space.takeIfExists({ type: "Freight", fields: { freightId: f.freightId } }, NO_WAIT, { txn: c.txn }))) continue;
				for (const e of await c.space.readAll({ type: "Item", fields: { location: f.freightId } }, { txn: c.txn })) { await move(c, fieldsOf<ItemFields>(e), f.freightId, c.actor.charId); n++; }
			}
			if (!n) throw new CommandError("Die Fracht ist gerade nicht greifbar; bitte noch einmal.");
			return msg(c, "*", "info", `$you() $conj(holst|holt) ${n} Stück Fracht vom Bahnsteig.`, { templ: true });
		}
		if (send) {
			if (!d.freight) throw new CommandError("Diese Bahn fährt keine Fracht.");
			if (!c.account || c.account.guest) throw new CommandError("Fracht schicken nur Registrierte; registriere dich dafür.");
			const dest = stopAt(send[2]!);
			if (!dest) throw new NotUnderstood(`Dorthin fährt kein Zug.${names ? ` Er fährt nach: ${names}.` : ""}`);
			if (wait) throw new CommandError(`Der Zug kommt erst in etwa ${Math.ceil(wait / 60_000)} Weltminuten.`);
			const pack = await inventory(c), what = send[1]!.replace(ARTICLE, "");
			const everything = /^(?:alle?|all)$/i.test(what), { n, name } = everything ? { n: null, name: "" } : amount(what);
			const goods = pack.filter((i) => i.f.proto !== c.world.currency);
			const hits = everything ? goods : (() => { const h = itemsNamed(c.world, goods, name); return h.length ? goods.filter((i) => i.f.proto === h[0]!.f.proto) : []; })();
			if (!hits.length) throw new NotUnderstood(`Du trägst nichts, was „${(name || what).slice(0, 30)}“ heißt (Münzen schickt man nicht).`);
			const purse = pack.filter((i) => i.f.proto === c.world.currency);
			if (purse.length < d.fare) throw new CommandError(`Eine Fracht kostet ${coins}.`);
			const k = Math.min(n ?? hits.length, hits.length, d.freight.capacity);
			for (const m of purse.slice(0, d.fare)) await consume(c, m.f, c.actor.charId);
			const f: FreightFields = { freightId: `freight-${randomBytes(6).toString("hex")}`, accountId: c.account.accountId, charId: c.actor.charId, ownerName: c.actor.name, room: dest.room, buildId: dest.buildId, untilWorldMs: (await worldNowOf(c.space, c.txn)) + d.freight.keepWorldMs };
			await c.space.write({ type: "Freight", fields: f as never }, c.txn, FOREVER);
			for (const i of hits.slice(0, k)) await move(c, i.f, c.actor.charId, f.freightId);
			const kinds = [...new Set(hits.slice(0, k).map((i) => i.f.name))].join(", ");
			return msg(c, c.actor.charId, "info", `Du gibst ${k}× ${kinds} als Fracht nach ${nameOf(c, dest.room)} auf; dort holst du sie mit „zug abholen“.${(n ?? hits.length) > k ? ` Mehr als ${d.freight.capacity} Stück nimmt der Zug auf einmal nicht.` : ""}`);
		}
		const to = stopAt(word);
		if (!to) throw new NotUnderstood(`Dorthin fährt kein Zug.${names ? ` Er fährt nach: ${names}.` : ""}`);
		if (wait) throw new CommandError(`Der Zug kommt erst in etwa ${Math.ceil(wait / 60_000)} Weltminuten.`);
		const purse = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		if (purse.length < d.fare) throw new CommandError(`Die Fahrt kostet ${coins}.`);
		for (const m of purse.slice(0, d.fare)) await consume(c, m.f, c.actor.charId);
		await countTrip(c, "train");
		await msg(c, "*", "info", `$you() $conj(steigst|steigt) in den Zug nach ${nameOf(c, to.room)}.`, { templ: true });
		const dest = await roomOf(c, to.room), at = await placeIn(c, dest, { x: to.x, y: to.y + to.h });
		await relocate(c, { room: dest.roomId, x: at.x, y: at.y }, { spot: false });
		await msg(c, "*", "info", "$you() $conj(steigst|steigt) aus dem Zug.", { templ: true, room: dest.roomId });
	},
};

export const CART_COMMANDS: Command[] = [karren, zug, strasse];
