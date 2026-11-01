// Wind (docs/siedeln.en.md "Wind", engine/commands/wind.ts): an island's level moves a step at a time, a surge makes it a
// gale, a mill grinds by it, and `wetter` tells it. Festivals: a figure counts as a second and wins no coins.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { stormRaisesWind, windFactor, windTick } from "../server/engine/commands/wind.ts";
import { showTick } from "../server/engine/commands/festival.ts";
import { loadWorld } from "../server/engine/world.ts";
import { initialClock } from "../server/engine/worldtime.ts";
import type { SettlementFields, ShowEntryFields, ShowFields, WindFields } from "../server/model.ts";
import { startStack } from "./stack.ts";

const w = await loadWorld();
const room = w.rooms.find((r) => r.island)!, island = room.island!;
const levels = async (s: Awaited<ReturnType<typeof startStack>>["space"]) => (await s.readAll({ type: "Wind", fields: { island } })).map((e) => (e.fields as unknown as WindFields).level);

test("the wind: an ordinary breeze at first, a step at a time, never past its ends; a surge is a gale; a mill follows", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		assert.equal(await windFactor(s, w, room.roomId), 1, "nothing written yet");
		await windTick(s, w, 60_000, () => 1);
		assert.deepEqual(await levels(s), [], "it stayed: nothing written");
		await windTick(s, w, 60_000, () => 0);
		assert.deepEqual(await levels(s), [0]);
		assert.equal(await windFactor(s, w, room.roomId), 0.5);
		assert.equal(await windTick(s, w, 60_000, () => 0) >= 0, true);
		assert.deepEqual(await levels(s), [0], "a lull does not go lower");
		await stormRaisesWind(s, w, room.roomId, 60_000);
		assert.deepEqual(await levels(s), [3]);
		assert.equal(await windFactor(s, w, room.roomId), 2);
		await windTick(s, w, 60_000, () => 2);
		assert.deepEqual(await levels(s), [3], "a gale does not go higher");
	} finally { await stack.close(); }
});

test("a figure counts as a second at a festival; a person who beats it gets the coins, a figure that wins gets none", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
		const settlement = { settlementId: "n", name: "Neuhafen", nameKey: "neuhafen", room: room.roomId, founder: "a", founderName: "A", members: [], closed: false, at: 0 } satisfies SettlementFields;
		await s.write({ type: "Settlement", fields: settlement as never }, null, FOREVER);
		const round = async (id: string, first: Partial<ShowEntryFields>, second: Partial<ShowEntryFields>) => {
			await s.write({ type: "Show", fields: { showId: id, room: room.roomId, settlementId: "n", settlementName: "Neuhafen", kind: "blumen", byName: "A", endsWorldMs: 1 } satisfies ShowFields as never }, null, FOREVER, { unique: ["room"] });
			for (const [i, e] of [first, second].entries()) await s.write({ type: "ShowEntry", fields: { showId: id, accountId: `a${i}`, charName: `C${i}`, name: "Nelke", score: 2 - i, at: i, ...e } satisfies ShowEntryFields as never }, null, FOREVER);
			assert.equal(await showTick(s, w, 60_000), 1);
		};
		await round("one", {}, { figure: true });
		assert.equal((await s.readAll({ type: "Estate" })).length, 1, "the person beat the figure");
		await round("two", { figure: true }, {});
		assert.equal((await s.readAll({ type: "Estate" })).length, 1, "the figure won: no coins");
	} finally { await stack.close(); }
});
