// A finger on the map and the names of figures side by side (client/touch.ts; docs/3d-welt-und-raster-plan-2026-11-21.en.md
// section 3, "2D", and section 2.3, decision 1): a tap on free ground near a figure, a thing or an exit names it within
// TOUCH_PX on the screen, else the cell; four figures side by side keep four names that cover none of the others.
import assert from "node:assert/strict";
import test from "node:test";
import { liftLabels, touchPick, touchTargets, TOUCH_PX, type LabelBox } from "../client/touch.ts";
import type { CharView, ObjView } from "../shared/frames.ts";

const char = (charId: string, x: number, y: number) => [charId, { charId, name: charId, x, y, skin: 0 } as unknown as CharView] as const;
const obj = (id: string, kind: string, x: number, y: number, more: Partial<ObjView> = {}) => [id, { id, kind, name: id, location: "r", x, y, ...more } as ObjView] as const;
/** A view of 16 pixels a cell, a figure's body 16 pixels above its cell's middle (scale 2 at nominal zoom). */
const screen = (x: number, y: number, body: boolean) => ({ x: (x + 0.5) * 16, y: (y + 0.5) * 16 - (body ? 16 : 0) });

test("a finger names what is near it on the screen; a cell with something on it, or nothing near, stays the cell", () => {
	const chars = new Map([char("me", 2, 2), char("anna", 10, 10)]);
	const objs = new Map([obj("fire", "beacon", 20, 4, { w: 2, h: 2 }), obj("way", "exit", 30, 0, { w: 2, h: 2, through: true }), obj("road", "road", 5, 5), obj("cart", "cart", 40, 40, { through: true })]);
	const targets = touchTargets(chars, objs, "r", "me");
	assert.equal(targets.length, 3, "anna, the fire and the exit; not the own figure, a road or something one walks through");
	const at = (x: number, y: number) => ({ x: Math.floor(x / 16), y: Math.floor(y / 16) });
	// on anna's cell: anna's cell
	assert.deepEqual(touchPick(at(168, 168), { x: 168, y: 168 }, targets, screen), { x: 10, y: 10 });
	// a cell beside her, the finger 17 px from her feet: her cell
	assert.deepEqual(touchPick(at(185, 168), { x: 185, y: 168 }, targets, screen), { x: 10, y: 10 });
	// on her body above her cell (the cell behind her): her cell
	assert.deepEqual(touchPick(at(168, 150), { x: 168, y: 150 }, targets, screen), { x: 10, y: 10 });
	// farther than TOUCH_PX: the cell under the finger
	assert.deepEqual(touchPick(at(168 + TOUCH_PX + 9, 168), { x: 168 + TOUCH_PX + 9, y: 168 }, targets, screen), { x: 12, y: 10 });
	// beside the fire's area: its nearest cell
	assert.deepEqual(touchPick(at(352, 70), { x: 352, y: 70 }, targets, screen), { x: 21, y: 4 });
	// beside the exit at the room's edge, the finger off the map: the exit's cell
	assert.deepEqual(touchPick(null, { x: 490, y: -6 }, targets, screen), { x: 30, y: 0 });
	// nothing near, off the map: nothing
	assert.equal(touchPick(null, { x: -60, y: -60 }, targets, screen), null);
	// of two, the nearer one
	const two = touchTargets(new Map([char("a", 0, 0), char("b", 2, 0)]), new Map(), "r", "me");
	assert.deepEqual(touchPick({ x: 1, y: 0 }, { x: 29, y: 8 }, two, screen), { x: 2, y: 0 });
	assert.deepEqual(touchPick({ x: 1, y: 0 }, { x: 19, y: 8 }, two, screen), { x: 0, y: 0 });
});

test("four figures side by side: four names, none covering another, the own one where it is", () => {
	const meets = (a: LabelBox, b: LabelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
		// two by two cells of 16 px, names 60 px wide and 12 high over each figure, at even and odd cells
		const boxes: LabelBox[] = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy], i) => ({ id: `f${i}`, x: (ox + dx!) * 16 + 8 - 30, y: (oy + dy!) * 16 - 20, w: 60, h: 12, first: i === 3 }));
		const lifts = liftLabels(boxes), placed = boxes.map((b) => ({ ...b, y: b.y - lifts.get(b.id)! }));
		for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!meets(placed[i]!, placed[j]!), `${placed[i]!.id} and ${placed[j]!.id}`);
		assert.equal(lifts.get("f3"), 0, "the own name stays over its figure");
	}
	// names apart from one another are not moved
	assert.deepEqual([...liftLabels([{ id: "a", x: 0, y: 0, w: 50, h: 12 }, { id: "b", x: 80, y: 0, w: 50, h: 12 }]).values()], [0, 0]);
});
