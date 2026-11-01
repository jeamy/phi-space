// Rooms grow (docs/siedeln.en.md "Rooms grow"): when most of a room's building land is taken, the world adds a strip of grass on
// its east or south side, up to a size; after that only a new room helps. Only east and south: nothing that stands in a room
// has to move. A side with an exit near it, or without grass at its edge, stays as it is. What grew is an entry of its own,
// so a new version of the world file keeps it.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type ExitFields, type RoomFields, type RoomGrowthFields } from "../../model.ts";
import { msgOptions } from "../context.ts";
import { isPassage } from "../occupancy.ts";
import { walkable, type WorldDef } from "../world.ts";
import { PATH } from "./build.ts";

/** The ground of a room with its strips added. */
export function grownGround(ground: string[], g: Pick<RoomGrowthFields, "east" | "south">, tile: string): string[] {
	const wide = ground.map((row) => row + tile.repeat(g.east));
	return [...wide, ...Array.from({ length: g.south }, () => tile.repeat(wide[0]!.length))];
}
export const grownDecor = (decor: string[] | undefined, g: Pick<RoomGrowthFields, "east" | "south">) => decor && grownGround(decor, g, " ");

/** The side a room can grow to, with its grass: half of the edge must be grass and no exit within two cells of it. */
export function freeSide(w: WorldDef, room: RoomFields, exits: Array<{ x: number; y: number }>): "east" | "south" | null {
	const d = w.growth!, width = room.ground[0]!.length, height = room.ground.length;
	const grassy = (cells: string[]) => cells.filter((t) => t === d.tile).length * 2 >= cells.length;
	if (width + d.strip <= d.maxW && !exits.some((e) => e.x >= width - 2) && grassy(room.ground.map((r) => r[width - 1]!))) return "east";
	if (height + d.strip <= d.maxH && !exits.some((e) => e.y >= height - 2) && grassy([...room.ground[height - 1]!])) return "south";
	return null;
}

/** The rooms that are full enough grow by a strip (in the job of the epochs). How many grew. */
export async function growthTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	const d = w.growth;
	if (!d) return 0;
	let grew = 0;
	for (const e of await space.readAll({ type: "Room" })) {
		const room = fieldsOf<RoomFields>(e), exits = (await space.readAll({ type: "Exit", fields: { room: room.roomId } })).map((x) => fieldsOf<ExitFields>(x));
		const side = freeSide(w, room, exits);
		if (!side) continue;
		let land = 0;
		room.ground.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (walkable(w, room.ground, x, y) && row[x] !== PATH && !isPassage(exits, { x, y })) land++; });
		if (!land || (await space.count({ type: "Plot", fields: { room: room.roomId } })) < land * d.fullShare) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const taken = await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
			if (!taken) { await space.abort(txn); continue; }
			const was = await space.takeIfExists({ type: "RoomGrowth", fields: { roomId: room.roomId } }, NO_WAIT, { txn });
			const step = { east: side === "east" ? d.strip : 0, south: side === "south" ? d.strip : 0 };
			const before = was ? fieldsOf<RoomGrowthFields>(was) : { east: 0, south: 0 };
			await space.write({ type: "RoomGrowth", fields: { roomId: room.roomId, east: before.east + step.east, south: before.south + step.south } satisfies RoomGrowthFields as never }, txn, FOREVER);
			const decor = grownDecor(room.decor, step);
			await space.write({ type: taken.type, types: taken.types.slice(1), fields: { ...taken.fields, ground: grownGround(room.ground, step, d.tile), ...(decor ? { decor } : {}) } as never }, txn, FOREVER);
			await space.write({ type: "Msg", fields: { room: room.roomId, to: "*", kind: "world", text: `${room.name} wächst: Im ${side === "east" ? "Osten" : "Süden"} ist neues Land frei.`, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
			await space.commit(txn);
			grew++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return grew;
}
