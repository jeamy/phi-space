// The sweep (docs/weltzeit.en.md): what the world gave a world-time life to is taken away when that time is up. A lease of the
// space cannot do this, because a lease runs on real time and does not stand still with the clock. Flotsam of the tide, jobs
// of the order board and listings of the market carry `expiresWorldMs`; the date `tick.sweep` calls this every few world
// seconds. Each thing is taken in a transaction of its own, so what someone picks up or buys at that moment is theirs.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type ItemFields, type ListingFields, type OrderFields, type WantedFields } from "../model.ts";
import { decayNowOf, worldNowOf } from "./clock.ts";
import { buildSweep } from "./commands/build.ts";
import { toPlayer } from "./context.ts";
import { resolvePrototype, spawn } from "./prototypes.ts";
import { timeNow } from "./source.ts";
import type { WorldDef } from "./world.ts";

async function takeIfLapsed(space: SpaceLike, id: string, type: string): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		if (!(await space.takeIfExists({ type, id }, NO_WAIT, { txn }))) { await space.abort(txn); return; } // taken right now
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** A wanted notice whose time is up: taken, and the one who sought it told (its coins go back with the market tick). */
async function wantedLapsed(space: SpaceLike, id: string, w?: WorldDef): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const e = await space.takeIfExists({ type: "Wanted", id }, NO_WAIT, { txn });
		if (!e) { await space.abort(txn); return; } // delivered or taken back right now
		const f = fieldsOf<WantedFields>(e), lot = (f.count ?? 1) > 1 ? `${f.count}× ${f.protoName}` : f.protoName;
		const board = (w?.allRooms ?? w?.rooms ?? []).find((r) => r.roomId === f.room)?.name ?? f.room;
		await toPlayer(space, { room: f.room, to: f.buyer, kind: "info", text: `Dein Gesuch nach ${lot} am Marktbrett (${board}) ist abgelaufen; niemand hat geliefert. Deine ${f.price} Münze${f.price === 1 ? "" : "n"} bekommst du zurück.`, from: "Marktbrett", fromId: "market", at: timeNow() }, txn);
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** A thing whose time has come (PrototypeFields.turns): fresh meat spoils and goes, a young animal grows up where it is
 *  (in a pack, a chest or its house); its owner is told when it was carried. A thing on the market board waits until it is
 *  back with its seller. */
async function turnItem(space: SpaceLike, id: string, w?: WorldDef): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const e = await space.takeIfExists({ type: "Item", id }, NO_WAIT, { txn });
		if (!e) { await space.abort(txn); return; } // taken right now
		const f = fieldsOf<ItemFields>(e), p = await resolvePrototype(space, f.proto);
		// in a building's chest beside a barrel or a crate (WorldDef.keeps) it keeps fresh: it turns that much later, once
		const keeper = !f.kept && p?.turns && f.turnsAtMs !== undefined ? w?.keeps?.find((k) => k.keeps.includes(f.proto)) : undefined;
		if (keeper && (await space.count({ type: "Building", fields: { buildId: f.location } }, txn)) && (await space.count({ type: "Item", fields: { location: f.location, proto: keeper.proto } }, txn))) {
			await space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, turnsAtMs: f.turnsAtMs! + p!.turns!.afterMs * (keeper.factor - 1), kept: true } as never }, txn, FOREVER);
			await space.commit(txn);
			return;
		}
		const into = p?.turns?.into ? await resolvePrototype(space, p.turns.into) : null;
		if (into && w) await spawn(space, txn, w, into, { location: f.location, x: f.x, y: f.y });
		const room = (await space.readAll({ type: "Character", fields: { charId: f.location } }, { txn }))[0]?.fields.room;
		if (typeof room === "string") await toPlayer(space, { room, to: f.location, kind: "info", text: into ? `Dein ${f.name} ist herangewachsen: jetzt ${/e$/.test(into.name) ? "eine" : "ein"} ${into.name}.` : `${f.name} ist verdorben; du wirfst es weg. Geräuchert, gepökelt oder gekocht hält es länger.`, from: "", fromId: "", at: timeNow() }, txn);
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** Flotsam, open or taken jobs, listings and awake roles whose world time is up are removed (a listing's item goes back to its seller with
 *  the market tick, as when its lease used to end). A thing picked up is stripped of the date (the `get` command), so what is carried stays. */
export async function sweepTick(space: SpaceLike, w?: WorldDef): Promise<void> {
	const now = await worldNowOf(space), kept = await decayNowOf(space);
	for (const e of await space.readAll({ type: "Item", fields: { flotsam: true } })) {
		const f = fieldsOf<ItemFields>(e);
		if (f.expiresWorldMs !== undefined && f.expiresWorldMs <= now) await takeIfLapsed(space, e.id, "Item");
	}
	for (const e of await space.readAll({ type: "NpcAwake" })) if (Number(e.fields.untilWorldMs ?? 0) <= kept) await takeIfLapsed(space, e.id, "NpcAwake"); // a role awake until a world time
	for (const e of await space.readAll({ type: "Order" })) if ((fieldsOf<OrderFields>(e).expiresWorldMs ?? Infinity) <= now) await takeIfLapsed(space, e.id, "Order");
	for (const e of await space.readAll({ type: "Listing" })) if ((fieldsOf<ListingFields>(e).expiresWorldMs ?? Infinity) <= kept) await takeIfLapsed(space, e.id, "Listing");
	for (const e of await space.readAll({ type: "Wanted" })) if ((fieldsOf<WantedFields>(e).expiresWorldMs ?? Infinity) <= kept) await wantedLapsed(space, e.id, w); // its coins go back with the market tick
	for (const e of await space.readAll({ type: "Item", fields: { turns: true } })) {
		const f = fieldsOf<ItemFields>(e);
		if (!f.listing && (f.turnsAtMs ?? Infinity) <= kept) await turnItem(space, e.id, w); // spoiled or grown up
	}
	await buildSweep(space, w); // sites without progress, buildings not kept, ruins and estates whose time is up (docs/siedeln.en.md)
}
