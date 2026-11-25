// The occupancy from the objects' footprints (shared/footprints.ts; docs/3d-welt-und-raster-plan-2026-11-21.en.md section
// 3, "Occupancy"): it gives the plots' occupancy, and what differs is named by room, cell and object. Every stack checks
// it on the store it leaves (tests/stack.ts), the engine walks on every state they reach (rust/mmo-engine/tests/common/walk.rs);
// the Rust copy (rust/mmo-engine/src/footprints.rs) has the same case and the same lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILD, MOVE, occupancyOf, SHARE, storeOccupancyReport, type OccupancyEntry } from "../shared/footprints.ts";

const entry = (type: string, fields: Record<string, unknown>): OccupancyEntry => ({ type, types: [type], fields });

test("footprints give the plots' occupancy, and what differs is named", () => {
	const all = [
		entry("Room", { roomId: "r", ground: ["......", "......", "......"] }),
		entry("Building", { buildId: "h", room: "r", x: 1, y: 1, w: 2, h: 2 }),
		entry("Scenery", { sceneryId: "s", room: "r", x: 0, y: 0, w: 1, h: 1, through: true }),
		entry("Beacon", { beaconId: "f", room: "r", x: 4, y: 0 }),
		...[[1, 1], [2, 1], [1, 2], [2, 2]].map(([x, y]) => entry("Plot", { room: "r", x, y, of: "h" })),
	];
	assert.deepEqual(storeOccupancyReport(all, { rooms: "required" }), []);
	const o = occupancyOf(6, 3, all);
	assert.deepEqual([o.ids[o.at[7]!], o.flags[7], o.ids[o.at[4]!], o.flags[4], o.at[0]], ["h", MOVE | BUILD | SHARE, "f", MOVE | BUILD, -1]);
	all.pop();
	all.push(entry("Plot", { room: "r", x: 5, y: 2, of: "gone" }));
	assert.deepEqual(storeOccupancyReport(all, { rooms: "required" }), ["r 2,2: plots say nothing, footprints h", "r 5,2: plots say gone, footprints nothing"]);
});

test("overlapping footprints, a footprint beyond the room and a room that is not there are reported", () => {
	const all = [
		entry("Room", { roomId: "r", ground: ["....", "...."] }),
		entry("Bed", { bedId: "a", room: "r", x: 0, y: 0, w: 2, h: 1 }),
		entry("Tree", { treeId: "t", room: "r", x: 1, y: 0, w: 1, h: 1 }),
		entry("Field", { fieldId: "f", room: "r", x: 3, y: 1, w: 2, h: 1 }),
		entry("Ruin", { buildId: "x", room: "elsewhere", x: 0, y: 0, w: 1, h: 1 }),
	];
	assert.deepEqual(storeOccupancyReport(all, { rooms: "required" }), [
		"elsewhere: occupied cells in a room that is not there",
		"r 1,0: footprints of a and t overlap",
		"r 4,1: the footprint of f reaches outside the room",
		"r 0,0: plots say nothing, footprints a",
		"r 1,0: plots say nothing, footprints a",
		"r 3,1: plots say nothing, footprints f",
	]);
	// without a Room entry (a test that loads no world) the room is compared on a grid as large as what lies in it
	assert.deepEqual(storeOccupancyReport(all).slice(0, 1), ["elsewhere 0,0: plots say nothing, footprints x"]);
});
