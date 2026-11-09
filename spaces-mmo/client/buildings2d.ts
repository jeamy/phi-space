// What a finished building looks like on the 2D map: each plan its own picture from plain shapes, for what is no house a
// thing of its own (a barrel, a pit, a fence). The 3D map has its models in props3d.ts. `x`, `y`, `w`, `h` in pixels.
import type { Graphics } from "pixi.js";

const LINE = "#2a1d10", ROOF = "#5b3a22", DARK = "#2a1d10", WOOD = "#8a6a44", WOOD_DARK = "#5b3a22", STONE = "#8d8f93", STONE_DARK = "#5f6166";
const edge = { width: 2, color: LINE };

/** Walls, a roof and a door at the bottom, as every house. */
function house(g: Graphics, x: number, y: number, w: number, h: number, wall: string, roof = ROOF, ts = h): void {
	g.rect(x + 3, y + h * 0.35, w - 6, h * 0.65 - 3).fill({ color: wall }).stroke(edge);
	g.poly([x, y + h * 0.4, x + w / 2, y + 2, x + w, y + h * 0.4]).fill({ color: roof }).stroke(edge);
	g.rect(x + w / 2 - ts * 0.2, y + h - ts * 0.55, ts * 0.4, ts * 0.55 - 3).fill({ color: DARK });
}
const shadow = (g: Graphics, cx: number, y: number, rx: number, ry: number) => g.ellipse(cx, y, rx, ry).fill({ color: "#000000", alpha: 0.28 });

function barrel(g: Graphics, x: number, y: number, ts: number): void {
	const cx = x + ts / 2, r = ts * 0.32, top = y + ts * 0.3, bottom = y + ts - 3, ry = ts * 0.12;
	shadow(g, cx, bottom, r + 3, ry * 0.8);
	g.roundRect(cx - r, top, r * 2, bottom - top, 4).fill({ color: "#8a5a30" }).stroke(edge);
	for (const d of [-0.5, 0, 0.5]) g.rect(cx + r * d - 0.5, top + ry, 1, bottom - top - ry - 2).fill({ color: WOOD_DARK });
	for (const t of [0.42, 0.78]) g.rect(cx - r, top + (bottom - top) * t - 1, r * 2, 3).fill({ color: "#3b2a18" });
	g.ellipse(cx, top, r, ry).fill({ color: "#6b4426" }).stroke(edge);
	g.ellipse(cx, top + 1, r - 3, ry - 2).fill({ color: "#4f8fb0" });
}

/** The hive: a straw skep in rings on a little stand, its dark entrance at the foot. */
function hive(g: Graphics, x: number, y: number, ts: number): void {
	const cx = x + ts / 2, r = ts * 0.3, foot = y + ts * 0.78, top = y + ts * 0.22;
	shadow(g, cx, y + ts - 3, r + 3, ts * 0.08);
	g.rect(cx - r - 2, foot, r * 2 + 4, ts * 0.08).fill({ color: WOOD_DARK }).stroke(edge);
	g.ellipse(cx, foot, r, foot - top).fill({ color: "#d8a83a" }).stroke(edge);
	g.rect(cx - r - 1, foot, r * 2 + 2, 2).fill({ color: WOOD_DARK });
	for (const t of [0.3, 0.55, 0.8]) g.rect(cx - r * Math.sqrt(1 - (1 - t) ** 2) + 2, foot - (foot - top) * (1 - t), 2 * (r * Math.sqrt(1 - (1 - t) ** 2) - 2), 1.5).fill({ color: "#a87a22" });
	g.ellipse(cx, foot - 3, 3, 2.5).fill({ color: "#2a1a10" });
}

function scarecrow(g: Graphics, x: number, y: number, ts: number): void {
	const cx = x + ts / 2, arm = y + ts * 0.42;
	shadow(g, cx, y + ts - 3, ts * 0.22, ts * 0.07);
	g.rect(cx - 1.5, y + ts * 0.2, 3, ts * 0.78).fill({ color: WOOD_DARK });
	g.rect(x + ts * 0.1, arm, ts * 0.8, 3).fill({ color: WOOD_DARK });
	g.poly([cx - ts * 0.2, arm - 1, cx + ts * 0.2, arm - 1, cx + ts * 0.16, y + ts * 0.74, cx - ts * 0.16, y + ts * 0.74]).fill({ color: "#a2503c" }).stroke({ width: 1.5, color: LINE });
	for (const s of [-1, 1]) g.rect(cx + s * ts * 0.42 - 2, arm + 2, 4, 5).fill({ color: "#d9b44a" });
	g.circle(cx, y + ts * 0.26, ts * 0.13).fill({ color: "#d9c48a" }).stroke({ width: 1.5, color: LINE });
	g.poly([cx - ts * 0.24, y + ts * 0.2, cx + ts * 0.24, y + ts * 0.2, cx, y + 1]).fill({ color: "#4a3a28" }).stroke({ width: 1.5, color: LINE });
}

function windmill(g: Graphics, x: number, y: number, w: number, h: number): void {
	const cx = x + w / 2, hub = y + h * 0.3;
	shadow(g, cx, y + h - 3, w * 0.34, h * 0.06);
	g.poly([cx - w * 0.18, y + h * 0.26, cx + w * 0.18, y + h * 0.26, cx + w * 0.3, y + h - 3, cx - w * 0.3, y + h - 3]).fill({ color: "#c8b48a" }).stroke(edge);
	g.rect(cx - w * 0.07, y + h * 0.74, w * 0.14, h * 0.26 - 3).fill({ color: DARK });
	g.poly([cx - w * 0.2, y + h * 0.27, cx, y + h * 0.1, cx + w * 0.2, y + h * 0.27]).fill({ color: ROOF }).stroke(edge);
	const r = Math.min(w, h) * 0.44;
	for (const [dx, dy] of [[1, 0.28], [-0.28, 1], [-1, -0.28], [0.28, -1]] as const) {
		const nx = -dy * 0.2, ny = dx * 0.2;
		g.poly([cx + dx * r * 0.2, hub + dy * r * 0.2, cx + dx * r, hub + dy * r, cx + (dx + nx) * r, hub + (dy + ny) * r, cx + (dx * 0.2 + nx) * r, hub + (dy * 0.2 + ny) * r]).fill({ color: "#efe6d0" }).stroke({ width: 1.5, color: LINE });
	}
	g.circle(cx, hub, 3).fill({ color: DARK });
}

function bakery(g: Graphics, x: number, y: number, w: number, h: number, ts: number): void {
	g.rect(x + w * 0.68, y + 1, w * 0.12, h * 0.34).fill({ color: "#7a4032" }).stroke(edge);
	house(g, x, y, w, h, "#b0604a", ROOF, ts);
	// the oven's mouth instead of a door
	g.circle(x + w / 2, y + h * 0.76, ts * 0.27).fill({ color: DARK });
	g.circle(x + w / 2, y + h * 0.8, ts * 0.15).fill({ color: "#e8913a" });
}

function coop(g: Graphics, x: number, y: number, w: number, h: number): void {
	g.rect(x + 3, y + h * 0.42, w * 0.72, h * 0.58 - 3).fill({ color: "#a0784a" }).stroke(edge);
	g.poly([x, y + h * 0.48, x + w * 0.4, y + 2, x + w * 0.8, y + h * 0.48]).fill({ color: ROOF }).stroke(edge);
	g.rect(x + w * 0.28, y + h * 0.62, h * 0.32, h * 0.38 - 3).fill({ color: DARK });
	// the ramp and a run of wire
	g.poly([x + w * 0.74, y + h * 0.72, x + w * 0.76, y + h * 0.6, x + w - 2, y + h - 3, x + w - 8, y + h - 3]).fill({ color: "#c9a26b" }).stroke({ width: 1.5, color: LINE });
	for (const [px, py] of [[x + 12, y + h * 0.8], [x + w * 0.62, y + h * 0.8]] as const) g.circle(px, py, 2.5).fill({ color: "#efe6d0" });
}

function pen(g: Graphics, x: number, y: number, w: number, h: number, ts: number): void {
	g.rect(x + 3, y + 3, w - 6, h - 6).fill({ color: "#a8b866", alpha: 0.65 });
	// rails, posts, a gate at the bottom, a trough and a little shelter
	const gate = x + w / 2;
	g.rect(x + 3, y + 5, w - 6, 3).fill({ color: WOOD });
	for (const px of [x + 3, x + w - 6]) g.rect(px, y + 5, 3, h - 10).fill({ color: WOOD });
	g.rect(x + 3, y + h - 8, gate - x - ts * 0.5 - 3, 3).fill({ color: WOOD });
	g.rect(gate + ts * 0.5, y + h - 8, x + w - 3 - gate - ts * 0.5, 3).fill({ color: WOOD });
	for (let i = 0; i <= 3; i++) for (const py of [y + 3, y + h - 11]) { const px = x + 2 + (i * (w - 9)) / 3; if (py < y + h / 2 || Math.abs(px - gate) > ts * 0.5) g.rect(px, py, 5, 9).fill({ color: WOOD_DARK }); }
	g.rect(x + ts * 0.4, y + ts * 0.5, ts * 1.1, ts * 0.65).fill({ color: "#8a7a4a" }).stroke(edge);
	g.poly([x + ts * 0.25, y + ts * 0.62, x + ts * 0.95, y + ts * 0.2, x + ts * 1.65, y + ts * 0.62]).fill({ color: ROOF }).stroke(edge);
	g.roundRect(x + w - ts * 1.3, y + h - ts * 0.95, ts * 0.9, ts * 0.3, 3).fill({ color: "#6b4426" }).stroke({ width: 1.5, color: LINE });
	g.rect(x + w - ts * 1.22, y + h - ts * 0.9, ts * 0.74, ts * 0.12).fill({ color: "#d9b44a" });
}

function loom(g: Graphics, x: number, y: number, w: number, h: number): void {
	shadow(g, x + w / 2, y + h - 3, w * 0.44, h * 0.08);
	for (const px of [x + w * 0.1, x + w * 0.86]) g.rect(px, y + 3, 5, h - 6).fill({ color: WOOD }).stroke({ width: 1.5, color: LINE });
	g.rect(x + w * 0.08, y + 4, w * 0.84, 4).fill({ color: WOOD_DARK });
	g.rect(x + w * 0.08, y + h * 0.78, w * 0.84, 4).fill({ color: WOOD_DARK });
	// the warp above, the woven cloth below
	for (let i = 0; i < 12; i++) g.rect(x + w * 0.17 + (i * w * 0.64) / 11, y + 8, 1, h * 0.36).fill({ color: "#e8dfc8" });
	g.rect(x + w * 0.17, y + h * 0.44, w * 0.65, h * 0.34).fill({ color: "#7a5a8a" });
	for (let i = 1; i < 4; i++) g.rect(x + w * 0.17, y + h * (0.44 + i * 0.085), w * 0.65, 1).fill({ color: "#a58ab5" });
}

function storehouse(g: Graphics, x: number, y: number, w: number, h: number, ts: number): void {
	g.rect(x + 3, y + h * 0.3, w - 6, h * 0.7 - 3).fill({ color: "#7a6a52" }).stroke(edge);
	for (let i = 1; i < 6; i++) g.rect(x + 3 + (i * (w - 6)) / 6, y + h * 0.3, 1, h * 0.7 - 3).fill({ color: "#5e5040" });
	g.poly([x, y + h * 0.34, x + w * 0.14, y + 2, x + w * 0.86, y + 2, x + w, y + h * 0.34]).fill({ color: ROOF }).stroke(edge);
	const d = x + w / 2, dw = ts * 0.7, dt = y + h * 0.5;
	g.rect(d - dw, dt, dw * 2, y + h - 3 - dt).fill({ color: "#5b3a22" }).stroke(edge);
	g.rect(d - 1, dt, 2, y + h - 3 - dt).fill({ color: DARK });
	for (const [ax, bx] of [[d - dw, d], [d, d + dw]] as const) g.moveTo(ax, dt).lineTo(bx, y + h - 3).stroke({ width: 1.5, color: LINE });
}

function quarry(g: Graphics, x: number, y: number, w: number, h: number): void {
	const cx = x + w / 2, cy = y + h / 2;
	g.roundRect(x + 2, y + 2, w - 4, h - 4, 10).fill({ color: STONE }).stroke(edge);
	g.roundRect(x + w * 0.16, y + h * 0.16, w * 0.68, h * 0.68, 8).fill({ color: "#74767b" }).stroke({ width: 1.5, color: "#4a4c50" });
	g.roundRect(x + w * 0.3, y + h * 0.32, w * 0.4, h * 0.46, 6).fill({ color: STONE_DARK }).stroke({ width: 1.5, color: "#4a4c50" });
	for (const [dx, dy, r] of [[-0.08, 0.1, 5], [0.1, 0.16, 4], [0.03, -0.04, 3]] as const) g.circle(cx + dx * w, cy + dy * h, r).fill({ color: "#a9abb0" }).stroke({ width: 1, color: "#4a4c50" });
}

function clayPit(g: Graphics, x: number, y: number, w: number, h: number): void {
	const cx = x + w / 2, cy = y + h / 2;
	g.ellipse(cx, cy, w * 0.47, h * 0.45).fill({ color: "#a9774d" }).stroke(edge);
	g.ellipse(cx, cy + 2, w * 0.34, h * 0.32).fill({ color: "#8a5a38" }).stroke({ width: 1.5, color: "#5e3c24" });
	g.ellipse(cx, cy + 5, w * 0.2, h * 0.18).fill({ color: "#6a4228" });
	g.ellipse(cx + w * 0.04, cy + 8, w * 0.1, h * 0.06).fill({ color: "#7f9aa8" });
	// a plank down into it
	g.poly([x + w * 0.1, y + h * 0.3, x + w * 0.16, y + h * 0.24, x + w * 0.42, y + h * 0.5, x + w * 0.36, y + h * 0.56]).fill({ color: WOOD }).stroke({ width: 1, color: LINE });
}

/** The salt garden: a stone rim round four shallow basins of sea water, white salt drying in two, a rake. */
function saltGarden(g: Graphics, x: number, y: number, w: number, h: number): void {
	g.rect(x + 2, y + 2, w - 4, h - 4).fill({ color: STONE }).stroke(edge);
	const bw = (w - 10) / 2, bh = (h - 10) / 2;
	for (let i = 0; i < 4; i++) {
		const bx = x + 4 + (i % 2) * (bw + 2), by = y + 4 + Math.floor(i / 2) * (bh + 2);
		g.rect(bx, by, bw, bh).fill({ color: i === 1 || i === 2 ? "#f2f2ea" : "#7fa8b8" }).stroke({ width: 1, color: STONE_DARK });
	}
	g.poly([x + w * 0.2, y + h * 0.85, x + w * 0.24, y + h * 0.8, x + w * 0.7, y + h * 0.2, x + w * 0.66, y + h * 0.16]).fill({ color: WOOD }).stroke({ width: 1, color: LINE });
}

function brickworks(g: Graphics, x: number, y: number, w: number, h: number): void {
	g.rect(x + w * 0.66, y + 2, w * 0.2, h * 0.6).fill({ color: "#8a3f2a" }).stroke(edge);
	for (let i = 1; i < 4; i++) g.rect(x + w * 0.66, y + 2 + (i * h * 0.15), w * 0.2, 1).fill({ color: "#5e2a1c" });
	g.rect(x + 3, y + h * 0.46, w - 6, h * 0.54 - 3).fill({ color: "#b4553a" }).stroke(edge);
	g.poly([x + 3, y + h * 0.46, x + w * 0.3, y + h * 0.26, x + w * 0.6, y + h * 0.46]).fill({ color: ROOF }).stroke(edge);
	// the kiln's mouth with its fire, a stack of bricks
	g.roundRect(x + w * 0.16, y + h * 0.62, w * 0.3, h * 0.38 - 3, 6).fill({ color: DARK });
	g.roundRect(x + w * 0.22, y + h * 0.76, w * 0.18, h * 0.2, 3).fill({ color: "#e8913a" });
	for (const [px, py] of [[0.6, 0.82], [0.74, 0.82], [0.67, 0.7]] as const) g.rect(x + w * px, y + h * py, w * 0.13, h * 0.1).fill({ color: "#c86a4a" }).stroke({ width: 1, color: LINE });
}

function chapel(g: Graphics, x: number, y: number, w: number, h: number, ts: number): void {
	const tx = x + w * 0.5;
	g.rect(x + 4, y + h * 0.42, w - 8, h * 0.58 - 3).fill({ color: "#d8d2c2" }).stroke(edge);
	g.poly([x, y + h * 0.48, x + w * 0.16, y + h * 0.22, x + w * 0.84, y + h * 0.22, x + w, y + h * 0.48]).fill({ color: "#6a5a68" }).stroke(edge);
	// the little tower with its bell, a round window, an arched door
	g.rect(tx - ts * 0.3, y + h * 0.14, ts * 0.6, h * 0.34).fill({ color: "#e6e0d0" }).stroke(edge);
	g.poly([tx - ts * 0.4, y + h * 0.15, tx, y - ts * 0.15, tx + ts * 0.4, y + h * 0.15]).fill({ color: "#6a5a68" }).stroke(edge);
	g.circle(tx, y + h * 0.3, ts * 0.12).fill({ color: "#d9b44a" }).stroke({ width: 1, color: LINE });
	g.roundRect(tx - ts * 0.24, y + h * 0.62, ts * 0.48, h * 0.38 - 3, 8).fill({ color: DARK });
	for (const px of [x + w * 0.2, x + w * 0.8]) g.circle(px, y + h * 0.62, ts * 0.13).fill({ color: "#6fa3c8" }).stroke({ width: 1.5, color: LINE });
}

function park(g: Graphics, x: number, y: number, w: number, h: number, ts: number): void {
	g.roundRect(x + 2, y + 2, w - 4, h - 4, 12).fill({ color: "#6f9f5a" }).stroke({ width: 2, color: "#3f6236" });
	// a path across, a pond, a bench, trees and flowers
	g.rect(x + w / 2 - ts * 0.22, y + 3, ts * 0.44, h - 6).fill({ color: "#d8c79a" });
	g.rect(x + 3, y + h / 2 - ts * 0.22, w - 6, ts * 0.44).fill({ color: "#d8c79a" });
	g.circle(x + w / 2, y + h / 2, ts * 0.8).fill({ color: "#d8c79a" });
	g.circle(x + w / 2, y + h / 2, ts * 0.45).fill({ color: "#4f8fb0" }).stroke({ width: 2, color: STONE_DARK });
	for (const [px, py] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8]] as const) {
		g.rect(x + w * px - 2, y + h * py, 4, ts * 0.35).fill({ color: WOOD_DARK });
		g.circle(x + w * px, y + h * py - 2, ts * 0.42).fill({ color: "#3f7a44" }).stroke({ width: 1.5, color: "#2a5230" });
	}
	for (const [i, color] of ["#e86a8a", "#f0d050", "#efe6d0", "#b07ad8", "#e86a8a", "#f0d050"].entries()) g.circle(x + w * (0.66 + (i % 3) * 0.1), y + h * (0.7 + ((i / 3) | 0) * 0.12), 2.5).fill({ color });
}

function townHall(g: Graphics, x: number, y: number, w: number, h: number, ts: number): void {
	const cx = x + w / 2;
	g.rect(x + 3, y + h * 0.4, w - 6, h * 0.6 - 3).fill({ color: "#9c6b4e" }).stroke(edge);
	g.poly([x, y + h * 0.44, x + w * 0.1, y + h * 0.24, x + w * 0.9, y + h * 0.24, x + w, y + h * 0.44]).fill({ color: ROOF }).stroke(edge);
	// the clock tower, its flag, windows in a row, steps to the door
	g.rect(cx - ts * 0.55, y + h * 0.1, ts * 1.1, h * 0.5).fill({ color: "#b4876a" }).stroke(edge);
	g.poly([cx - ts * 0.7, y + h * 0.12, cx, y - ts * 0.2, cx + ts * 0.7, y + h * 0.12]).fill({ color: ROOF }).stroke(edge);
	g.circle(cx, y + h * 0.28, ts * 0.26).fill({ color: "#efe6d0" }).stroke({ width: 1.5, color: LINE });
	g.moveTo(cx, y + h * 0.28).lineTo(cx, y + h * 0.2).stroke({ width: 1.5, color: LINE });
	g.moveTo(cx, y + h * 0.28).lineTo(cx + ts * 0.14, y + h * 0.28).stroke({ width: 1.5, color: LINE });
	g.rect(cx - 0.75, y - ts * 0.55, 1.5, ts * 0.4).fill({ color: DARK });
	g.poly([cx, y - ts * 0.55, cx + ts * 0.4, y - ts * 0.44, cx, y - ts * 0.32]).fill({ color: "#c8483a" });
	for (const f of [0.14, 0.28, 0.68, 0.82]) g.rect(x + w * f, y + h * 0.56, ts * 0.32, ts * 0.42).fill({ color: "#e0c878" }).stroke({ width: 1.5, color: LINE });
	g.rect(cx - ts * 0.3, y + h * 0.66, ts * 0.6, h * 0.34 - 5).fill({ color: DARK });
	g.rect(cx - ts * 0.6, y + h - 6, ts * 1.2, 4).fill({ color: STONE });
}

function workshop(g: Graphics, x: number, y: number, w: number, h: number, ts: number): void {
	// open at the front: a roof on posts, a bench with a saw, a block
	g.rect(x + 4, y + h * 0.34, w - 8, h * 0.66 - 4).fill({ color: "#4a3a2a" });
	for (const px of [x + 4, x + w - 9]) g.rect(px, y + h * 0.3, 5, h * 0.7 - 3).fill({ color: "#7f5f3f" }).stroke({ width: 1.5, color: LINE });
	g.poly([x, y + h * 0.4, x + w * 0.1, y + 3, x + w * 0.9, y + 3, x + w, y + h * 0.4]).fill({ color: ROOF }).stroke(edge);
	g.rect(x + w * 0.16, y + h * 0.64, w * 0.5, h * 0.1).fill({ color: "#a98458" }).stroke({ width: 1.5, color: LINE });
	for (const px of [0.2, 0.58]) g.rect(x + w * px, y + h * 0.74, 3, h * 0.26 - 4).fill({ color: "#7f5f3f" });
	g.poly([x + w * 0.26, y + h * 0.5, x + w * 0.5, y + h * 0.5, x + w * 0.5, y + h * 0.58, x + w * 0.42, y + h * 0.64, x + w * 0.26, y + h * 0.64]).fill({ color: "#c0c4c8" }).stroke({ width: 1, color: LINE });
	g.rect(x + w * 0.74, y + h * 0.66, ts * 0.42, ts * 0.42).fill({ color: "#8a6a44" }).stroke({ width: 1.5, color: LINE });
	g.rect(x + w * 0.75, y + h * 0.55, 3, ts * 0.35).fill({ color: WOOD_DARK });
	g.rect(x + w * 0.73, y + h * 0.52, ts * 0.3, ts * 0.12).fill({ color: STONE_DARK });
}

/** The picture of a finished building of `plan`; a plan without one of its own is a house in its `color`. */
export function building2d(g: Graphics, plan: string | undefined, x: number, y: number, w: number, h: number, ts: number, color: string): void {
	if (plan === "regentonne") barrel(g, x, y, ts);
	else if (plan === "vogelscheuche") scarecrow(g, x, y, ts);
	else if (plan === "windmuehle") windmill(g, x, y, w, h);
	else if (plan === "backhaus") bakery(g, x, y, w, h, ts);
	else if (plan === "huehnerstall") coop(g, x, y, w, h);
	else if (plan === "bienenstock") hive(g, x, y, ts);
	else if (plan === "gehege") pen(g, x, y, w, h, ts);
	else if (plan === "webstuhl") loom(g, x, y, w, h);
	else if (plan === "lagerhaus") storehouse(g, x, y, w, h, ts);
	else if (plan === "steinbruch") quarry(g, x, y, w, h);
	else if (plan === "lehmgrube") clayPit(g, x, y, w, h);
	else if (plan === "salzgarten") saltGarden(g, x, y, w, h);
	else if (plan === "ziegelei") brickworks(g, x, y, w, h);
	else if (plan === "kapelle") chapel(g, x, y, w, h, ts);
	else if (plan === "park") park(g, x, y, w, h, ts);
	else if (plan === "rathaus") townHall(g, x, y, w, h, ts);
	else if (plan === "werkstatt") workshop(g, x, y, w, h, ts);
	else house(g, x, y, w, h, color, ROOF, ts);
}
