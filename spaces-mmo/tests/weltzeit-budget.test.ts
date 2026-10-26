// The narrative budget of a role counts by world day (docs/weltzeit.md, "Modellbudgets"): the key carries the clock epoch
// and the day, a new world day gives a new count, and the operator's real limits (per UTC day and per minute) stay on top.
// Its own file: it turns the scripted model on for this process.
process.env.SPACES_MMO_LLM = "1";
process.env.SPACES_MMO_LLM_MODULE = "tests/fake-llm.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { ClockCache, worldDayKey } from "../server/engine/clockcache.ts";
import { complete } from "../server/llm.ts";
import { WORLD_DAY_MS, WORLD_HOUR_MS } from "../server/engine/worldtime.ts";
import { startStack } from "./stack.ts";

const keys = async (s: { readAll: Function }) => ((await s.readAll({ type: "LlmCount" })) as Array<{ fields: { key: string; used: number } }>).map((e) => `${e.fields.key}=${e.fields.used}`).sort();

test("the day of a role's budget is the world day: the same key all day, a new one at the day's edge; the real limits count on", async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space, real0 = Date.now();
		// the world clock: day 0 at 08:00 when made, a day passes in 24 real seconds (rate 3600)
		await s.write({ type: "WorldClock", fields: { worldId: "t", epoch: 2, realAnchorMs: real0, worldAnchorMs: 8 * WORLD_HOUR_MS, rate: 3600, paused: false, version: 1 } as never }, null, FOREVER);
		assert.equal(await worldDayKey(s, real0), "e2:d0");
		assert.equal(await worldDayKey(s, real0 + 4_000), "e2:d0", "08:00 + 4 s at rate 3600 = 12:00");
		assert.equal(await worldDayKey(s, real0 + 5_000 + 11_000), "e2:d1", "16 real seconds: 08:00 + 16 h = day 1, 00:00");
		assert.equal(await new ClockCache(s).now(real0), 8 * WORLD_HOUR_MS);

		const ask = (day: string | null) => complete(s, "You are Ines", "Heard: hallo", { maxTokens: 50, own: { key: "npc:ines", perDay: 1, ...(day ? { day } : {}) } });
		assert.ok(await ask("e2:d0"), "the first answer of the day");
		assert.equal(await ask("e2:d0"), null, "her one answer a day is used");
		assert.ok(await ask("e2:d1"), "a new world day: a new count");
		assert.equal(await ask("e2:d1"), null);
		const k = await keys(s);
		assert.ok(k.includes("npc:ines:e2:d0=1") && k.includes("npc:ines:e2:d1=1"), `the keys carry epoch and day: ${k.join(", ")}`);
		// the operator's limits are real time and do not care: they were counted for all four tries that got through the role's own
		assert.ok(k.some((x) => /^day:\d{4}-\d\d-\d\d=2$/.test(x)), `the UTC day counted both answers: ${k.join(", ")}`);
		assert.ok(k.some((x) => /^min:/.test(x)));
		assert.equal(WORLD_DAY_MS, 24 * WORLD_HOUR_MS);
	} finally { await stack.close(); }
});
