// Semantic examples of the distance rules (docs/3d-welt-und-raster-plan-2026-11-21.en.md phase 0 and section 2.1
// "Ranges": "test all sides and the first cell outside reach"; the rules are those of docs/raster-inventur-2026-11-24.en.md
// section 1). For each rule a target and the actor's cells around it on all eight sides, from on the target to the first
// cell outside the rule, each with the rule's answer at scale 1. tests/reference/semantic-scale1.json keeps them
// (`node --no-warnings --experimental-strip-types tests/semantic-examples.ts --write`), tests/semantic-examples.test.ts
// holds the engine's helpers to them at scale 1 and the conversion of plan section 2.2 at scale 2: every legacy point
// becomes (2x, 2y), every area its position and footprint × 2, a fire or exit point a 2 × 2 area; a length doubles, a
// ring "beside" becomes "within the doubled reach and not on the footprint", Manhattan "=== 1" between bed plants
// becomes "<= 2". The answer must stay the same. The bounds at scale 2 are those of the engine's rule table
// (shared/rules.ts, `ROW`); the reaches of the world definition are scaled by world:json, here value × scale.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ruleAt, type RuleName } from "../shared/rules.ts";

export type Rect = { x: number; y: number; w: number; h: number };
export type Cell = { x: number; y: number };
/** `point-rect`: Chebyshev from a cell to the nearest cell of a footprint (build.ts distTo); `point-point`: Chebyshev
 *  between two cells (context.ts reach); `rect-rect`: Chebyshev gap between two footprints (wild.ts gap, garden.ts:535);
 *  `manhattan`: |dx| + |dy| between two cells. */
export type Metric = "point-rect" | "point-point" | "rect-rect" | "manhattan";
/** How the target converts: `area` × 2, `point` (2x, 2y), `area-point` a fire or exit point that becomes a 2 × 2 area
 *  (its rule then measures to that footprint). */
export type Target = "area" | "point" | "area-point";
/** `le`/`gt` with a length (doubles), `eq1` a ring beside (becomes 1 to 2), `zero` on the footprint (stays). */
export type Test = { op: "le" | "gt"; value: number } | { op: "eq1" } | { op: "zero" } | { op: "manhattan1" };
export type Rule = { name: string; places: string; metric: Metric; target: Target; test: Test; actorW?: number; actorH?: number };

/** The rules of inventory section 1, one target each. */
export const RULES: Rule[] = [
	{ name: "BESIDE", places: "30 places, e.g. build.ts:566, animals.ts:73, fishing.ts:27; sleep.ts:84 and shop.ts:183 as > 1", metric: "point-rect", target: "area", test: { op: "le", value: 1 } },
	{ name: "REACH_POINT", places: "default.ts:288 (pick up), cart.ts:46, npc/settlers.ts:135", metric: "point-point", target: "point", test: { op: "le", value: 1 } },
	{ name: "FEED_FIRE", places: "default.ts:418 (> 1: too far), npc/economy.ts:403", metric: "point-point", target: "area-point", test: { op: "gt", value: 1 } },
	{ name: "SITE_REACH", places: "build.ts:270 and its uses", metric: "point-rect", target: "area", test: { op: "le", value: 2 } },
	{ name: "EXIT_REACH", places: "build.ts:80, 388", metric: "point-point", target: "area-point", test: { op: "le", value: 2 } },
	{ name: "FIRE_CLEARANCE", places: "build.ts:102", metric: "point-point", target: "area-point", test: { op: "le", value: 1 } },
	{ name: "PASSAGE", places: "occupancy.ts:34 isPassage", metric: "point-point", target: "area-point", test: { op: "le", value: 1 } },
	{ name: "RING_BESIDE", places: "npc/economy.ts:172 stepBeside, build.ts:124", metric: "point-rect", target: "area", test: { op: "eq1" } },
	{ name: "ON_FOOTPRINT", places: "build.ts:48 atCell and others (=== 0)", metric: "point-rect", target: "area", test: { op: "zero" } },
	{ name: "SCARE_REACH", places: "wild.ts:298 (wild.scareReach)", metric: "rect-rect", target: "point", test: { op: "le", value: 3 } },
	{ name: "SCARECROW_REACH", places: "wild.ts:66 (wild.scarecrowReach; a bed and a scarecrow)", metric: "rect-rect", target: "area", test: { op: "le", value: 3 }, actorW: 2, actorH: 2 },
	{ name: "GREENHOUSE_REACH", places: "garden.ts:535 (garden.greenhouse.reach; a bed and a greenhouse)", metric: "rect-rect", target: "area", test: { op: "le", value: 3 }, actorW: 2, actorH: 2 },
	{ name: "SETTLER_CLEARANCE", places: "npc/settlers.ts:91", metric: "point-point", target: "area-point", test: { op: "le", value: 2 } },
	{ name: "MOVE_BUILDING", places: "build.ts:185 (> 3: too far from the old place)", metric: "point-rect", target: "area", test: { op: "gt", value: 3 } },
	{ name: "FLOWER_CROSS", places: "garden.ts:297", metric: "manhattan", target: "point", test: { op: "manhattan1" } },
];

/** The row of the rule table (shared/rules.ts) each rule takes its bound from; the others are values of the world
 *  definition (wild.scareReach, wild.scarecrowReach, garden.greenhouse.reach) or on the footprint (no bound). */
export const ROW: Partial<Record<string, RuleName>> = {
	BESIDE: "BESIDE", REACH_POINT: "REACH_POINT", FEED_FIRE: "FEED_FIRE", SITE_REACH: "SITE_REACH", EXIT_REACH: "EXIT_REACH",
	FIRE_CLEARANCE: "FIRE_CLEARANCE", PASSAGE: "PASSAGE", RING_BESIDE: "BESIDE", SETTLER_CLEARANCE: "SETTLER_CLEARANCE",
	MOVE_BUILDING: "MOVE_BUILDING", FLOWER_CROSS: "FLOWER_NEIGHBOUR",
};

/** The target of every rule at scale 1: an area of 3 × 2 at (10, 8), or the cell (10, 8). */
const AREA: Rect = { x: 10, y: 8, w: 3, h: 2 }, POINT: Cell = { x: 10, y: 8 };

export const chebyshevToRect = (p: Cell, r: Rect) => Math.max(Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1)));
export const rectGap = (a: Rect, b: Rect) => Math.max(0, b.x - (a.x + a.w - 1), a.x - (b.x + b.w - 1), b.y - (a.y + a.h - 1), a.y - (b.y + b.h - 1));
export const pointRect = (p: Cell): Rect => ({ ...p, w: 1, h: 1 });

/** The rule's distance between the actor (a cell, or the footprint at the cell) and the target. */
export function distance(rule: Rule, actor: Cell, target: Rect, scale: number): number {
	const a: Rect = { ...actor, w: (rule.actorW ?? 1) * scale, h: (rule.actorH ?? 1) * scale };
	if (rule.metric === "manhattan") return Math.abs(actor.x - target.x) + Math.abs(actor.y - target.y);
	if (rule.metric === "rect-rect") return rectGap(a, target);
	// a point rule to a target that is a footprint at scale 2 (fire, exit) measures to its footprint
	return chebyshevToRect(actor, target);
}

/** The rule's answer for a distance, at `scale`. */
export function answer(rule: Rule, d: number, scale: number): boolean {
	const t = rule.test, row = ROW[rule.name];
	const bound = (v: number) => (row ? ruleAt(row, scale) : v * scale);
	if (t.op === "le") return d <= bound(t.value);
	if (t.op === "gt") return d > bound(t.value);
	if (t.op === "eq1") return d >= 1 && d <= bound(1); // the ring beside: 1 to the reach (inventory 1.3)
	if (t.op === "zero") return d === 0;
	return d >= 1 && d <= bound(1); // FLOWER_CROSS: Manhattan within the reach, not the same cell
}

/** The target at scale 1 and its conversion to `scale` (plan section 2.2). */
export function targetAt(rule: Rule, scale: number): Rect {
	if (rule.target === "area") return { x: AREA.x * scale, y: AREA.y * scale, w: AREA.w * scale, h: AREA.h * scale };
	if (rule.target === "point") return { x: POINT.x * scale, y: POINT.y * scale, w: 1, h: 1 };
	return { x: POINT.x * scale, y: POINT.y * scale, w: scale, h: scale }; // a fire or exit: 2 × 2 at scale 2
}

/** The actor's cells around the target at scale 1: on all eight sides, from the target's edge to two cells beyond the
 *  last answer that changes (the first cell outside reach and one more). */
function actorsOf(rule: Rule): Cell[] {
	const r = targetAt(rule, 1), t = rule.test, far = (t.op === "le" || t.op === "gt" ? t.value : 1) + 2;
	const out: Cell[] = [];
	for (let d = 0; d <= far; d++) {
		const xs = [r.x - d, r.x + Math.floor((r.w - 1) / 2), r.x + r.w - 1 + d], ys = [r.y - d, r.y + Math.floor((r.h - 1) / 2), r.y + r.h - 1 + d];
		// the actor's own footprint lies to the right of and below its cell: on the west and north it starts farther out
		const aw = (rule.actorW ?? 1) - 1, ah = (rule.actorH ?? 1) - 1;
		for (const [i, x] of xs.entries()) for (const [j, y] of ys.entries()) if (i !== 1 || j !== 1 || d === 0) out.push({ x: i === 0 ? x - aw : x, y: j === 0 ? y - ah : y });
	}
	return [...new Map(out.map((c) => [`${c.x},${c.y}`, c])).values()];
}

export type Example = { actor: Cell; distance: number; answer: boolean };
export type Examples = { rules: Array<Rule & { target1: Rect; examples: Example[] }> };

/** All examples, answered at scale 1. */
export function examples(): Examples {
	return {
		rules: RULES.map((rule) => {
			const target1 = targetAt(rule, 1);
			return { ...rule, target1, examples: actorsOf(rule).map((actor) => { const d = distance(rule, actor, target1, 1); return { actor, distance: d, answer: answer(rule, d, 1) }; }) };
		}),
	};
}

export const FILE = join(import.meta.dirname, "reference/semantic-scale1.json");
if (process.argv[1] === import.meta.filename && process.argv.includes("--write")) {
	writeFileSync(FILE, JSON.stringify(examples(), null, "\t") + "\n");
	console.log(`written: ${FILE}`);
}
