// Orders of a site, step 5 part 3 (docs/siedeln.md "Wenige Spieler: die Welt packt mit an"): the owner of a site hangs out
// what it lacks with a wage per piece or per work point, and whoever delivers or works there is paid, people and NPCs
// alike, through `liefere` and `arbeite`; nothing is reserved, the first to come earns.
//
// - The wage lies in the order from the moment it is hung out (the coins' location is the order), so an NPC is never
//   paid from nothing and a wage cannot be spent twice. Paying is part of the command's transaction, which holds the site.
// - What a finished, given up or lapsed site did not pay goes back: into the owner's pack, or as an estate at the site's
//   room while the owner is in another region.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type EstateFields, type ItemFields, type SiteFields, type SiteOrderFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, NotUnderstood, stem, type CommandCtx } from "../context.ts";
import type { WorldDef } from "../world.ts";
import { missing, settle, siteHere } from "./build.ts";

/** What an order shows: "5 Treibholz, je 2 Münzen". */
export const orderLine = (o: SiteOrderFields) => `${o.left} ${o.name}, je ${o.pay} Münze${o.pay === 1 ? "" : "n"}`;
export const ordersOfSite = async (space: SpaceLike, buildId: string, txn: string | null = null) => (await space.readAll({ type: "SiteOrder", fields: { buildId } }, txn ? { txn } : {})).map((e) => fieldsOf<SiteOrderFields>(e));

async function moveCoin(space: SpaceLike, txn: string, itemId: string, from: string, to: string): Promise<boolean> {
	const e = await space.takeIfExists({ type: "Item", fields: { itemId, location: from } }, NO_WAIT, { txn });
	if (!e) return false;
	await space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, location: to, x: -1, y: -1 } as never }, txn, FOREVER);
	return true;
}

/** Pays the actor for `n` pieces of `proto` (""; work) of the site: the order shrinks, and goes when nothing is left. */
export async function payFor(c: CommandCtx, buildId: string, proto: string, n: number): Promise<number> {
	const e = await c.space.takeIfExists({ type: "SiteOrder", fields: { buildId, proto } }, NO_WAIT, { txn: c.txn });
	if (!e) return 0;
	const o = fieldsOf<SiteOrderFields>(e), paid = Math.min(n, o.left), coins = (await c.space.readAll({ type: "Item", fields: { location: o.orderId } })).map((i) => fieldsOf<ItemFields>(i));
	let got = 0;
	for (const coin of coins.slice(0, paid * o.pay)) if (await moveCoin(c.space, c.txn, coin.itemId, o.orderId, c.actor.charId)) got++;
	if (o.left > paid) await c.space.write({ type: "SiteOrder", fields: { ...o, left: o.left - paid } as never }, c.txn, FOREVER);
	return got;
}

/** Closes the site's orders: their wages go back to the owner. How many coins. */
export async function closeOrders(space: SpaceLike, txn: string, s: Pick<SiteFields, "buildId" | "owner" | "ownerName" | "accountId" | "room" | "name">, estateUntil: number): Promise<number> {
	let back = 0;
	const here = (await space.count({ type: "Character", fields: { charId: s.owner } })) > 0;
	for (const e of await space.readAll({ type: "SiteOrder", fields: { buildId: s.buildId } })) {
		const o = fieldsOf<SiteOrderFields>(e);
		if (!(await space.takeIfExists({ type: "SiteOrder", fields: { orderId: o.orderId } }, NO_WAIT, { txn }))) continue;
		const to = here ? s.owner : `est-${o.orderId}`;
		let moved = 0;
		for (const coin of await space.readAll({ type: "Item", fields: { location: o.orderId } })) if (await moveCoin(space, txn, String(coin.fields.itemId), o.orderId, to)) moved++;
		if (moved && !here) await space.write({ type: "Estate", fields: { estateId: to, accountId: s.accountId, ownerName: s.ownerName, room: s.room, name: s.name, untilWorldMs: estateUntil } satisfies EstateFields as never }, txn, FOREVER);
		back += moved;
	}
	return back;
}

/** Until when wages wait as an estate for an owner in another region. */
export const keptUntil = async (c: CommandCtx) => (await worldNowOf(c.space, c.txn)) + (c.world.building?.estateWorldMs ?? 30 * 24 * 3600_000);

const WORK = /^(?:arbeit|arbeitspunkte?|arbeitsstunden?|work)$/i;
const aushang: Command = {
	key: "aushang", aliases: ["aushaengen", "aushängen", "hire"],
	help: "aushang <n> <ding|arbeit> je <münzen> – an deiner Baustelle Lohn für das Fehlende aushängen (aushang allein: was aushängt; aushang ab: Lohn zurück)",
	async func(c, arg) {
		const { s } = await siteHere(c, "");
		const orders = await ordersOfSite(c.space, s.buildId, c.txn);
		const a = arg.trim();
		if (!a) { await settle(c, s); return msg(c, c.actor.charId, "info", orders.length ? `Ausgehängt an der ${s.name}: ${orders.map(orderLine).join("; ")}.` : `An der ${s.name} hängt nichts aus. „aushang 5 treibholz je 1“ bietet Lohn für jedes Stück, „aushang 4 arbeit je 2“ für die Arbeit.`); }
		if (s.accountId !== c.account?.accountId) throw new CommandError("Aushängen darf nur, wem die Baustelle gehört.");
		if (/^(?:ab|weg|zurück|zurueck)$/i.test(a)) {
			const back = await closeOrders(c.space, c.txn, s, await keptUntil(c));
			await settle(c, s);
			return msg(c, c.actor.charId, "info", orders.length ? `Du nimmst den Aushang ab und bekommst ${back} Münzen zurück.` : "Hier hängt nichts von dir aus.");
		}
		const m = /^(\d+)\s+(.+?)\s+(?:je|für je|fuer je|pro stück|pro stueck|each)\s+(\d+)(?:\s+münzen?|\s+muenzen?)?$/i.exec(a);
		if (!m) throw new NotUnderstood("So: aushang 5 treibholz je 1, oder aushang 4 arbeit je 2.");
		const pay = Number(m[3]);
		if (pay < 1) throw new CommandError("Ein Aushang braucht Lohn, mindestens eine Münze.");
		const work = WORK.test(m[2]!), said = stem(m[2]!.toLowerCase());
		const need = work ? undefined : s.needs.find((x) => [x.proto, x.name, ...(c.world.prototypes.find((p) => p.key === x.proto)?.aliases ?? [])].some((w) => stem(w.toLowerCase()) === said));
		if (!work && !need) throw new CommandError(`Das braucht die ${s.name} nicht. Es fehlen ${missing(s).join(", ")}.`);
		const proto = need?.proto ?? "", open = work ? s.workNeed - s.work : need!.count - need!.have, name = work ? "Arbeit" : need!.name, n = Math.min(Number(m[1]), open);
		if (n <= 0) throw new CommandError(`${name} hat die Baustelle genug.`);
		if (orders.some((o) => o.proto === proto)) throw new CommandError(`Für ${name} hängt schon ein Aushang; „aushang ab“ nimmt ihn ab.`);
		const coins = (await inventory(c)).filter((i) => i.f.proto === c.world.currency);
		if (coins.length < n * pay) throw new CommandError(`Das kostet ${n * pay} Münzen, du hast ${coins.length}.`);
		const o: SiteOrderFields = { orderId: `so-${randomBytes(6).toString("hex")}`, buildId: s.buildId, siteName: s.name, room: s.room, x: s.x, y: s.y, w: s.w, h: s.h, ownerName: s.ownerName, proto, name, left: n, pay, at: await worldNowOf(c.space, c.txn) };
		for (const coin of coins.slice(0, n * pay)) if (!(await moveCoin(c.space, c.txn, coin.f.itemId, c.actor.charId, o.orderId))) throw new CommandError("Die Münzen sind gerade nicht greifbar; bitte noch einmal.");
		await c.space.write({ type: "SiteOrder", fields: o as never }, c.txn, FOREVER);
		await settle(c, s);
		await msg(c, "*", "info", `${c.actor.name} hängt an der ${s.name} aus: ${orderLine(o)}. Bezahlt wird beim Liefern und Mitarbeiten.`);
	},
};

export const SITE_ORDER_COMMANDS: Command[] = [aushang];
/** The board's lines for the sites of a region. */
export async function boardLines(space: SpaceLike, w: WorldDef): Promise<string[]> {
	const room = (id: string) => w.rooms.find((r) => r.roomId === id)?.name ?? id;
	return (await space.readAll({ type: "SiteOrder" })).map((e) => fieldsOf<SiteOrderFields>(e)).map((o) => `  ${o.siteName} von ${o.ownerName} in ${room(o.room)}: ${orderLine(o)}`);
}
