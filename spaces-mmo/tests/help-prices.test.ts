// The price list of the help (client/help/articles.ts, {#prices}) is what the world gives (scripts/help-prices.ts): every
// thing a recipe makes has a trader who buys it and a department store price, and the list in the help is current.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../server/env.ts";
import type { WorldDef } from "../shared/world-def.ts";
import { ARTICLES_PATH, withPrices } from "../scripts/help-prices.ts";

const w = JSON.parse(readFileSync(join(ROOT, "worlds", "leuchtfeuer", "world.json"), "utf8")) as WorldDef;

test("everything made has a buyer and a store price", () => {
	for (const p of new Set(w.recipes.map((r) => r.makes))) {
		assert.ok(w.npcs.some((n) => (n.prices?.[p]?.[0] ?? 0) > 0), `${p}: no trader buys it`);
		assert.ok((w.shop?.prices[p] ?? 0) > 0, `${p}: no department store price`);
	}
});

test("the help's price list is current (npm run help:prices)", () => {
	const text = readFileSync(ARTICLES_PATH, "utf8");
	assert.equal(withPrices(text, w), text);
});
