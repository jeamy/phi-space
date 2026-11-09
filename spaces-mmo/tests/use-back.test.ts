// The phone's back gesture over the page's layers (client/useBack.ts): one history entry of ours while any layer is open,
// and a layer that opens while the last one's back() is still on its way does not make the next close leave the game.
import { test } from "node:test";
import assert from "node:assert/strict";

// a browser history whose back() arrives later, as in a browser
const entries: string[] = ["game"];
let at = 0, listeners: Array<() => void> = [];
const pending: Array<() => void> = [];
Object.assign(globalThis, {
	matchMedia: () => ({ matches: true }), // a phone
	window: { addEventListener: (_: string, f: () => void) => { listeners.push(f); } },
	history: {
		pushState: () => { entries.splice(at + 1); entries.push("layer"); at++; },
		back: () => { pending.push(() => { if (at > 0) { at--; for (const f of listeners) f(); } else entries[0] = "left the game"; }); },
	},
});
const settle = () => { while (pending.length) pending.shift()!(); };
const { openLayer } = await import("../client/useBack.ts");

test("with a mouse the history is left alone", () => {
	const touch = (globalThis as unknown as { matchMedia: () => { matches: boolean } }).matchMedia;
	(globalThis as { matchMedia: unknown }).matchMedia = () => ({ matches: false });
	try {
		const before = at;
		openLayer(() => {})();
		settle();
		assert.equal(at, before);
	} finally { (globalThis as { matchMedia: unknown }).matchMedia = touch; }
});

test("a layer opened as another closes: the next close stays in the game, the gesture closes the right one", () => {
	const closed: string[] = [];
	// the map's menu, then one of its entries closes it and opens the help in the same moment
	const menu = openLayer(() => closed.push("menu"));
	assert.equal(at, 1);
	menu();
	const help = openLayer(() => closed.push("help"));
	settle();
	assert.equal(at, 1, "the help has its entry once the menu's back() has arrived");
	help();
	settle();
	assert.equal(at, 0, "back at the game");
	assert.equal(entries[0], "game", "never further back");
	// two layers, the gesture closes the top one and keeps an entry for the other
	openLayer(() => closed.push("panel"));
	openLayer(() => closed.push("sheet"));
	assert.equal(at, 1, "one entry for both");
	history.back(); settle();
	assert.deepEqual(closed, ["sheet"]);
	assert.equal(at, 1, "the panel keeps an entry");
	history.back(); settle();
	assert.deepEqual(closed, ["sheet", "panel"]);
	assert.equal(at, 0);
	assert.equal(entries[0], "game");
});
