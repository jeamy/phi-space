// Roads and carts, step 8 (docs/siedeln.en.md "Road", "Cart, wagon"). A road is a plan built beside an exit: it links the two
// rooms of that exit, within an island. A cart stands in a room with its cargo at `cartId`; its owner loads it, sends it to a
// room the roads reach, and it goes a room at a time on the world clock, with nobody beside it.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type CartFields, type ExitFields, type ItemFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import type { WorldDef } from "../world.ts";
import { ARTICLE, distTo, EXIT_REACH, giveBack } from "./build.ts";
import { placeIn, relocate } from "./default.ts";
import { consume, move } from "./trade.ts";

/** Room to rooms the roads join: a road beside an exit links its two ends, both ways. */
export async function roadLinks(space: SpaceLike, w: WorldDef, txn: string | null = null): Promise<Map<string, Set<string>>> {
	const links = new Map<string, Set<string>>(), o = txn ? { txn } : {};
	if (!w.cart) return links;
	const roads = (await space.readAll({ type: "Building", fields: { plan: w.cart.road } }, o)).map((e) => fieldsOf<BuildingFields>(e));
	if (!roads.length) return links;
	const link = (a: string, b: string) => { if (!links.has(a)) links.set(a, new Set()); links.get(a)!.add(b); };
	for (const e of await space.readAll({ type: "Exit" }, o)) {
		const x = fieldsOf<ExitFields>(e);
		if (roads.some((r) => r.room === x.location && distTo(x, r) <= EXIT_REACH)) { link(x.location, x.destination); link(x.destination, x.location); }
	}
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
	help: "karren – deine Karren; karren stelle, karren lade <ding>, karren entlade, karren fahre <ort> (nur auf Straßen), karren nimm",
	async func(c, arg) {
		const d = c.world.cart;
		if (!d) throw new CommandError("In dieser Welt gibt es keine Karren.");
		if (!c.account || c.account.guest) throw new CommandError("Gäste haben keine Karren; registriere dich dafür.");
		const [word = "", ...rest] = arg.trim().split(/\s+/), tail = rest.join(" ").replace(ARTICLE, "");
		if (!word) {
			const carts = (await c.space.readAll({ type: "Cart" }, { txn: c.txn })).map((e) => fieldsOf<CartFields>(e)).filter((x) => x.accountId === c.account!.accountId);
			const lines = await Promise.all(carts.map(async (x) => `in ${nameOf(c, x.room)}${x.path.length ? `, unterwegs nach ${nameOf(c, x.path.at(-1)!)}` : ""}, ${(await cargoOf(c, x.cartId)).length} von ${d.capacity} Stück geladen`));
			return msg(c, c.actor.charId, "info", lines.length ? `Deine Karren: ${lines.join("; ")}.` : "Du hast keinen Karren draußen. „karren stelle“ stellt einen ab, den du trägst.");
		}
		if (/^(?:stelle|abstellen|place)$/i.test(word)) {
			const it = (await inventory(c)).find((i) => i.f.proto === d.proto);
			if (!it) throw new CommandError("Du trägst keinen Karren.");
			await consume(c, it.f, c.actor.charId);
			await put(c, { cartId: `cart-${randomBytes(6).toString("hex")}`, accountId: c.account.accountId, charId: c.actor.charId, ownerName: c.actor.name, room: c.actor.room, x: c.actor.x, y: c.actor.y, path: [], dueWorldMs: FOREVER });
			return msg(c, "*", "info", "$you() $conj(stellst|stellt) einen Karren ab.", { templ: true });
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
		throw new NotUnderstood("So geht es: karren, karren stelle, karren lade <ding>, karren entlade, karren fahre <ort>, karren nimm.");
	},
};

/** The carts whose date has come go a room on (in the job of the garden). How many moved. */
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
			const f = fieldsOf<CartFields>(t), [next, ...rest] = f.path, target = next ? w.rooms.find((r) => r.roomId === next) : undefined;
			// a road that fell meanwhile does not stop it: the way was open when it left
			await space.write({ type: "Cart", fields: { ...f, ...(target ? { room: target.roomId, x: target.spawn?.x ?? f.x, y: target.spawn?.y ?? f.y } : {}), path: rest, dueWorldMs: rest.length ? now + d.hopWorldMs : FOREVER } as never }, txn, FOREVER);
			if (!rest.length && target) await space.write({ type: "Msg", fields: { room: target.roomId, to: f.charId, kind: "info", text: `Dein Karren ist in ${target.name} angekommen.`, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: f.charId, kind: "info" }));
			await space.commit(txn);
			moved++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return moved;
}

const zug: Command = {
	key: "zug", aliases: ["bahn", "train"],
	help: "zug <ort> – neben einem Bahnhof mit der Inselbahn zu einem anderen Bahnhof dieser Insel fahren; „zug“ allein zeigt die Bahnhöfe",
	async func(c, arg) {
		const d = c.world.rail;
		if (!d) throw new CommandError("In dieser Welt fährt keine Bahn.");
		const island = c.world.rooms.find((r) => r.roomId === c.actor.room)?.island;
		const stations = (await c.space.readAll({ type: "Building", fields: { plan: d.plan } }, { txn: c.txn })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => c.world.rooms.find((r) => r.roomId === b.room)?.island === island);
		if (!stations.some((b) => b.room === c.actor.room && distTo(c.actor, b) <= 1)) throw new CommandError("Der Zug hält nur an Bahnhöfen; stell dich neben einen.");
		// one stop a room, however many stations stand in it
		const others = stations.filter((b, i) => b.room !== c.actor.room && stations.findIndex((x) => x.room === b.room) === i), word = arg.trim().toLowerCase();
		const names = others.map((b) => nameOf(c, b.room)).join(", ");
		if (!word) return msg(c, c.actor.charId, "info", names ? `Der Zug fährt nach: ${names}, für ${d.fare} Münze${d.fare === 1 ? "" : "n"}.` : "Auf dieser Insel gibt es keinen anderen Bahnhof.");
		const to = others.find((b) => nameOf(c, b.room).toLowerCase() === word || b.room === word);
		if (!to) throw new NotUnderstood(`Dorthin fährt kein Zug.${names ? ` Er fährt nach: ${names}.` : ""}`);
		const purse = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		if (purse.length < d.fare) throw new CommandError(`Die Fahrt kostet ${d.fare} Münze${d.fare === 1 ? "" : "n"}.`);
		for (const m of purse.slice(0, d.fare)) await consume(c, m.f, c.actor.charId);
		await msg(c, "*", "info", `$you() $conj(steigst|steigt) in den Zug nach ${nameOf(c, to.room)}.`, { templ: true });
		const dest = await roomOf(c, to.room), at = await placeIn(c, dest, { x: to.x, y: to.y + to.h });
		await relocate(c, { room: dest.roomId, x: at.x, y: at.y }, { spot: false });
		await msg(c, "*", "info", "$you() $conj(steigst|steigt) aus dem Zug.", { templ: true, room: dest.roomId });
	},
};

export const CART_COMMANDS: Command[] = [karren, zug];
