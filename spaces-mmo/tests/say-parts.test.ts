// A trader's list longer than one say (MAX_SAY 300) goes out in several says, cut at spaces; each part after the first
// begins with whom it is said to (server/npc/say-parts.ts sayParts; rust/mmo-engine/src/npc/economy.rs say_parts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sayParts } from "../server/npc/say-parts.ts";

test("a short text is one say; a long one several, none over the limit, nothing lost", () => {
	assert.deepEqual(sayParts("Fischerin, ich kaufe Treibholz (bis 2).", 300, "Fischerin,"), ["Fischerin, ich kaufe Treibholz (bis 2)."]);
	const items = Array.from({ length: 60 }, (_, i) => `Ding${i} (bis ${i})`);
	const text = `Fischerin, ich kaufe ${items.join(", ")} – in Münzen.`;
	const parts = sayParts(text, 300, "Fischerin,");
	assert.ok(parts.length > 1);
	for (const p of parts) assert.ok(p.length <= 300, `${p.length}: ${p}`);
	assert.ok(parts.slice(1).every((p) => p.startsWith("Fischerin, … ")));
	assert.equal([parts[0], ...parts.slice(1).map((p) => p.slice("Fischerin, … ".length))].join(" "), text);
});
