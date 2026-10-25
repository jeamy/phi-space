// Loading a world definition into the space (Evennia's batch processors; docs/evennia-abbildung.md). Under the world
// lock and in one transaction: rooms, exits, prototypes and help topics are written when missing, or replaced when the
// space holds an older version of the world (or `replace` is asked for); a placed item is spawned only while no item
// with its itemId exists anywhere, so a restart never brings back what a player picked up, and two world workers
// starting together cannot both spawn it. Rooms and things builders made are never touched.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { actorToken, fieldsOf, roomToken, WORLD_LOCK, type AccountFields, type BeaconFields, type CharacterFields, type ExitFields, type FogFields, type RoomFields, type WorldLoadedFields } from "../model.ts";
import { ensureTickers } from "./ticker.ts";
import { readExisting, StillHeld } from "../space.ts";
import { resolveFrom, spawn } from "./prototypes.ts";
import { draftOf } from "./typeclasses.ts";
import type { WorldDef } from "./world.ts";

export type LoadResult = { loaded: boolean; version: number; spawned: string[] };

/** Writes the missing actor tokens (one per character) and room tokens (one per room), under the world lock so two
 *  workers never write two tokens for one character or room. A token held right now by a worker exists. */
export async function ensureTokens(space: SpaceLike): Promise<number> {
	const txn = (await space.createTransaction(30_000)).id;
	try {
		if (!(await space.take(WORLD_LOCK, 20_000, { txn }))) throw new Error("the world lock stayed taken");
		const wanted = [
			...(await space.readAll({ type: "Character" })).map((e) => actorToken(String(e.fields.charId))),
			...(await space.readAll({ type: "Room" })).map((e) => roomToken(String(e.fields.roomId))),
		];
		let written = 0;
		for (const token of wanted) {
			try { if (await readExisting(space, token, { txn })) continue; } catch (e) { if (e instanceof StillHeld) continue; throw e; }
			await space.write(token, txn, FOREVER);
			written++;
		}
		await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, txn, FOREVER);
		await space.commit(txn);
		return written;
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

export async function loadIntoSpace(space: SpaceLike, w: WorldDef, o: { replace?: boolean; txnMs?: number; tickers?: Array<{ key: string; everyMs: number }> } = {}): Promise<LoadResult> {
	const txn = (await space.createTransaction(o.txnMs ?? 30_000)).id;
	try {
		if (!(await space.take(WORLD_LOCK, 20_000, { txn }))) throw new Error("the world lock stayed taken");
		const marker = await space.readIfExists({ type: "WorldLoaded", fields: { worldId: w.id } }, NO_WAIT, { txn });
		const have = marker ? fieldsOf<WorldLoadedFields>(marker).version : 0;
		const replace = !!o.replace || have < w.version;
		/** Writes `draft` keyed by `key`: when missing, or (replacing) instead of what is there. */
		const upsert = async (type: string, key: Record<string, string>, draft: Parameters<SpaceLike["write"]>[0]) => {
			const old = await space.readIfExists({ type, fields: key }, NO_WAIT, { txn });
			if (old && !replace) return;
			if (old) await space.take({ type, id: old.id }, NO_WAIT, { txn });
			await space.write(draft, txn, FOREVER);
		};
		for (const r of w.rooms) await upsert("Room", { roomId: r.roomId }, draftOf("Room", w.typeclasses, { roomId: r.roomId, name: r.name, desc: r.desc, ground: r.ground, spawn: r.spawn } satisfies RoomFields));
		for (const e of w.exits) {
			const { room, ...rest } = e;
			await upsert("Exit", { exitId: e.exitId }, draftOf("Exit", w.typeclasses, { ...rest, location: room, locks: e.locks ?? "" } satisfies ExitFields));
		}
		for (const p of w.prototypes) await upsert("Prototype", { key: p.key }, { type: "Prototype", fields: p as never });
		for (const h of w.help) await upsert("HelpEntry", { key: h.key }, { type: "HelpEntry", fields: h as never });
		// placed items, when the definition is (re)loaded: only those that exist nowhere (one held right now, being picked
		// up, counts as existing). Between reloads an item a player used up stays gone.
		const spawned: string[] = [];
		if (replace) for (const obj of w.objects) {
			let there: unknown;
			try { there = await readExisting(space, { type: "Item", fields: { itemId: obj.itemId } }, { txn }); } catch (e) { if (e instanceof StillHeld) continue; throw e; }
			if (there) continue;
			// resolved from the definition: the prototypes written above are not visible outside this transaction
			await spawn(space, txn, w, resolveFrom(w.prototypes, obj.proto)!, { itemId: obj.itemId, location: obj.room, x: obj.x, y: obj.y });
			spawned.push(obj.itemId);
		}
		// Phase 2: beacons (a reload keeps whether one burns), the fog of the rooms they cover, the tickers, the NPCs
		for (const b of w.beacons) {
			const old = await space.readIfExists({ type: "Beacon", fields: { beaconId: b.beaconId } }, 2_000, { txn });
			if (old && !replace) continue;
			if (old) await space.take({ type: "Beacon", id: old.id }, NO_WAIT, { txn });
			await space.write({ type: "Beacon", fields: { ...b, lit: old ? !!old.fields.lit : false } satisfies BeaconFields as never }, txn, FOREVER);
		}
		for (const room of new Set(w.beacons.flatMap((b) => b.covers))) {
			if (!(await space.readIfExists({ type: "Fog", fields: { room } }, 2_000, { txn }))) await space.write({ type: "Fog", fields: { room, level: w.fog.start } satisfies FogFields as never }, txn, FOREVER);
		}
		await ensureTickers(space, o.tickers ?? [], txn);
		for (const n of w.npcs) {
			const charId = `npc-${n.npcId}`;
			try { if (await readExisting(space, { type: "Character", fields: { charId } }, { txn })) continue; } catch (e) { if (e instanceof StillHeld) continue; throw e; }
			const now = Date.now();
			await space.write({ type: "Account", fields: { accountId: charId, name: n.name, guest: false, admin: false, npc: true, createdAt: now, touchedAt: now } satisfies AccountFields as never }, txn, FOREVER);
			await space.write({ type: "Character", fields: { charId, accountId: charId, name: n.name, room: n.room, x: n.x, y: n.y, skin: n.skin, guest: false } satisfies CharacterFields as never }, txn, FOREVER);
			await space.write(actorToken(charId), txn, FOREVER);
		}
		if (replace) {
			if (marker) await space.take({ type: "WorldLoaded", id: marker.id }, NO_WAIT, { txn });
			await space.write({ type: "WorldLoaded", fields: { worldId: w.id, version: w.version, at: Date.now() } satisfies WorldLoadedFields as never }, txn, FOREVER);
		}
		await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, txn, FOREVER);
		await space.commit(txn);
		return { loaded: replace, version: w.version, spawned };
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}
