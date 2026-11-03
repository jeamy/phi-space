// The island railway's tracks (engine/rail.ts): which links between rooms they follow and which cells they lie on.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { railLinks, stationEnds, trackCells, trainIn } from "../server/engine/rail.ts";
import { loadWorld } from "../server/engine/world.ts";

const w = await loadWorld();

test("the tracks join the stations of an island the shortest way, never over the water, and need two stations", () => {
	const links = w.exits.map((e) => [e.room, e.destination] as [string, string]);
	assert.equal(railLinks(w.rooms, links, ["graue-bucht"]).size, 0, "one station: no track");
	const net = railLinks(w.rooms, links, ["graue-bucht", "klippenkopf"]);
	for (const l of ["graue-bucht|klippenpfad", "klippenpfad|graue-bucht", "klippenpfad|klippenkopf", "klippenkopf|klippenpfad"]) assert.ok(net.has(l), l);
	assert.equal(net.size, 4, "only the way between them");
	// a station on another island makes no track across the ferry
	assert.equal(railLinks(w.rooms, links, ["graue-bucht", "kupferhafen-markt"]).size, 0);
	// three stations: a tree, each link once each way
	const three = railLinks(w.rooms, links, ["graue-bucht", "klippenkopf", "fischerdorf"]);
	assert.ok(three.has("graue-bucht|klippenpfad") && [...three].every((l) => { const [a, b] = l.split("|"); return w.rooms.find((r) => r.roomId === a)?.island === w.rooms.find((r) => r.roomId === b)?.island; }));
});

test("in a room the track runs from the station's ends to each exit, around what stands, over land only", () => {
	const ground = [
		"........",
		"........",
		"..~~~...",
		"........",
	];
	const station = { x: 0, y: 0, w: 2, h: 1 };
	assert.deepEqual(stationEnds(station), [{ x: -1, y: 0 }, { x: 2, y: 0 }]);
	const [run] = trackCells(ground, station, [{ x: 7, y: 3 }], new Set(["4,0", "4,1"]));
	assert.ok(run, "a run");
	assert.deepEqual(run[0], { x: 1, y: 0 }, "from the end of the station's own track");
	assert.deepEqual(run[1], { x: 2, y: 0 }, "out beside it");
	assert.deepEqual(run.at(-1), { x: 7, y: 3 }, "to the exit");
	assert.ok(run.every((c) => ground[c.y]![c.x] !== "~"), "never on the water");
	assert.ok(!run.some((c) => (c.x === 4 && c.y <= 1)), "around what stands");
	for (let i = 1; i < run.length; i++) assert.equal(Math.abs(run[i]!.x - run[i - 1]!.x) + Math.abs(run[i]!.y - run[i - 1]!.y), 1, "cell to cell");
	// walled in by what stands: over it rather than not at all
	const walled = trackCells(ground, station, [{ x: 7, y: 0 }], new Set(["3,0", "3,1", "3,3"]));
	assert.equal(walled.length, 1);
	// an end of the station inside what stands (a bed beside it): from the other end
	const beside = trackCells(ground, { x: 2, y: 0, w: 2, h: 1 }, [{ x: 7, y: 0 }], new Set(["4,0"]));
	assert.deepEqual(beside[0]![1], { x: 1, y: 0 }, "out of the free end");
	assert.ok(!beside[0]!.some((c) => c.x === 4 && c.y === 0), "never under the bed");
	// no station: from the first exit to the others
	assert.equal(trackCells(ground, null, [{ x: 0, y: 3 }, { x: 7, y: 0 }], new Set())[0]![0]!.x, 0);
});

test("the timetable: the train stands at the stations the first half of each period, and without one always", () => {
	assert.deepEqual([0, 599_000, 600_000, 900_000, 1_200_000].map((t) => trainIn(t, 1_200_000)), [0, 0, 600_000, 300_000, 0]);
	assert.equal(trainIn(123_456), 0);
});
