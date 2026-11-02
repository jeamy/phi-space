"use client";
// The tile map of the current room, drawn with PixiJS (docs/architektur.en.md, "Grafik"). React owns the frame; PixiJS
// only the canvas: the ground once per room (autotiled water whose waves move), exits and things on it, one sprite per
// online character that glides from cell to cell with its walking frames, a flickering fire, and the fog as a veil with
// clearings around the own character and a burning fire. A zoom of 2 or 3 follows the own character; dragging looks
// around, two fingers pinch through the zoom steps. A tap on a cell goes to `onCell`, a long press or a right click to
// `onMenu`; the map never changes the world by itself. pixi.js is imported in the browser only; without WebGL `onFail` says so and the page plays as text.
import { building2d } from "./buildings2d.ts";
import { useEffect, useRef, useState } from "react";
import type { CharView, ObjView, ServerFrame } from "../server/gateway.ts";
import { pinch } from "./pinch.ts";
import { tr } from "./i18n/index.ts";
import { WALK_MS } from "./walk.ts";

type Hello = Extract<ServerFrame, { t: "hello" }>;
type Px = typeof import("pixi.js");
type Sp = { body: InstanceType<Px["Sprite"]>; label: InstanceType<Px["Text"]>; tx: number; ty: number; px: number; py: number; row: number; skin: number; movedAt?: number };
type Scene = {
	pixi: Px; app: InstanceType<Px["Application"]>; cam: InstanceType<Px["Container"]>;
	water: Array<InstanceType<Px["Container"]>>; waterMs: number;
	objs: InstanceType<Px["Container"]>; chars: InstanceType<Px["Container"]>; fog: InstanceType<Px["Graphics"]>;
	flames: Array<InstanceType<Px["Graphics"]>>;
	skins: Array<InstanceType<Px["Texture"]>>; frames: Map<string, InstanceType<Px["Texture"]>>; sprites: Map<string, Sp>;
	/** The pictures of things, by URL (loaded with the scene; a thing without one is drawn as its glyph). */
	icons: Map<string, InstanceType<Px["Texture"]>>;
	size: { w: number; h: number }; ts: number;
	/** The canvas fills its frame (a phone): the frame's size, the sheet's height over it (`inset` follows `insetGoal`), the zoom steps. */
	fill: boolean; vp: { w: number; h: number }; inset: number; insetGoal: number; zooms: readonly number[];
	/** The marked end of a walk. */ goal: InstanceType<Px["Graphics"]>;
	/** The scenery drawn last, and the dust of what was cleared. */ scenery: Map<string, ObjView>; dust: Array<InstanceType<Px["Graphics"]>>;
	/** Camera: zoom and how far the player dragged the view away from the own character. */
	view: { zoom: number; panX: number; panY: number };
	fogLevel: number; fogDirty: boolean;
};

const ROW = { down: 0, left: 1, right: 2, up: 3 } as const;
/** px per second: a cell in a little less than the walk's pace (client/walk.ts), so a held key glides on without a
 *  stop in every cell */
const SPEED = (32 * 1000) / WALK_MS * 1.1;
/** The walking frames keep going this long after the figure reached its cell (the next step is on its way). */
const WALK_GRACE_MS = WALK_MS + 60;
const STEP_MS = 130; // one walking frame
const LONG_PRESS_MS = 500;
const DRAG_PX = 12;
const ZOOMS = [1, 2, 3] as const;
/** Sea drawn around the room when the canvas fills the screen, in cells: a phone held upright is taller than a room. */
const SEA_MARGIN = 14;
/** The zoom steps of a filling canvas: a third smaller, the art's size, a third larger and twice it, each a whole number of
 *  device pixels per art pixel, so the pixels stay sharp (on a 3× screen 2/3, 1, 4/3, 2; on a 2× screen 1/2, 1, 3/2, 2; on a
 *  plain screen 1, 2, where a third would not be sharp). */
export function fillZooms(dpr: number): number[] {
	const d = Math.max(1, Math.round(dpr));
	return [...new Set([2 / 3, 1, 4 / 3, 2].map((z) => Math.max(1, Math.round(z * d)) / d))];
}
/** How far two fingers spread (or close) before the zoom goes one step: the zoom stays an integer, for sharp pixels. */
const PINCH_STEP = 1.35;
/** Above this many characters in a room only the own name and the names close by are shown. */
const CROWD = 8;
/** Text is drawn at this resolution, so names stay sharp when the map is zoomed. */
const TEXT_RES = 3;

/** Quarter tiles of an RPG Maker VX autotile block (in 16 px units) for each corner of a cell and each case. */
const QUARTER: Record<"TL" | "TR" | "BL" | "BR", Record<"center" | "inner" | "vedge" | "hedge" | "outer", [number, number]>> = {
	TL: { center: [2, 4], inner: [2, 0], vedge: [0, 4], hedge: [2, 2], outer: [0, 2] },
	TR: { center: [1, 4], inner: [3, 0], vedge: [3, 4], hedge: [1, 2], outer: [3, 2] },
	BL: { center: [2, 3], inner: [2, 1], vedge: [0, 3], hedge: [2, 5], outer: [0, 5] },
	BR: { center: [1, 3], inner: [3, 1], vedge: [3, 3], hedge: [1, 5], outer: [3, 5] },
};

const stored = (key: string, fallback: number) => { try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : fallback; } catch { return fallback; } };
const store = (key: string, v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* private window */ } };

export function MapView({ world, room, chars, objs, me, fog, onCell, onMenu, onFail, controls, fill = false, insetBottom = 0, goal = null }: {
	world: Hello["world"]; room: Hello["room"]; chars: Map<string, CharView>; objs: Map<string, ObjView>; me: string; fog: number;
	onCell: (x: number, y: number) => void; onMenu: (x: number, y: number, clientX: number, clientY: number) => void; onFail: (why: string) => void;
	controls?: React.ReactNode; fill?: boolean; insetBottom?: number; goal?: { x: number; y: number } | null;
}) {
	const host = useRef<HTMLDivElement>(null);
	const scene = useRef<Scene | null>(null);
	const zoomKey = fill ? "mmo.zoom.fill" : "mmo.zoom";
	const [zoom, setZoom] = useState(() => stored(zoomKey, 1));
	// exits outside the picture, as signs at its edge (a filling canvas only)
	const [edges, setEdges] = useState<Edge[]>([]);
	const latest = useRef({ chars, objs, me, fog, onCell, onMenu, onFail, zoom, setZoom, setEdges, insetBottom });
	latest.current = { chars, objs, me, fog, onCell, onMenu, onFail, zoom, setZoom, setEdges, insetBottom };

	// the scene: built again when the room changes
	useEffect(() => {
		let dead = false;
		let app: InstanceType<Px["Application"]> | null = null;
		let observer: ResizeObserver | null = null;
		const ts = world.tileSize, w = room.ground[0]!.length, h = room.ground.length;
		void (async () => {
			const pixi = await import("pixi.js");
			const a = new pixi.Application();
			try {
				await a.init({ width: fill ? Math.max(1, host.current!.clientWidth) : w * ts, height: fill ? Math.max(1, host.current!.clientHeight) : h * ts, background: "#0b1016", antialias: false, preference: "webgl", resolution: Math.max(1, Math.round(window.devicePixelRatio || 1)), autoDensity: true });
			} catch (e) {
				latest.current.onFail(`Die Karte braucht WebGL (${(e as Error).message || "nicht verfügbar"}); das Spiel läuft als Text weiter.`);
				return;
			}
			if (dead) { a.destroy(true, { children: true }); return; }
			app = a;
			// autoDensity sets the CSS size inline; the stylesheet scales the canvas to its frame instead (pointer events
			// follow, PixiJS maps them through the element's box)
			a.canvas.style.width = "100%";
			a.canvas.style.height = fill ? "100%" : "auto";
			host.current?.querySelector(".map-canvas")?.replaceChildren(a.canvas);
			a.canvas.setAttribute("aria-label", `Karte: ${room.name}`);
			a.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
			const load = async (sheet: string) => {
				const t = await pixi.Assets.load<InstanceType<Px["Texture"]>>(`/assets/${world.id}/${sheet}`);
				t.source.scaleMode = "nearest";
				return t;
			};
			const sheets = new Map<string, InstanceType<Px["Texture"]>>();
			for (const t of Object.values(world.tiles)) if (!sheets.has(t.sheet)) sheets.set(t.sheet, await load(t.sheet));
			const plantSheets = [...new Set(Object.values(world.decor ?? {}).map((d) => d.sheet))].filter((u) => !sheets.has(u));
			await Promise.all(plantSheets.map(async (u) => { try { sheets.set(u, await load(u)); } catch { /* plants are for the eye: the room stands without */ } }));
			const skins = await Promise.all(world.skins.map((s) => load(s.sheet)));
			const icons = new Map<string, InstanceType<Px["Texture"]>>();
			await Promise.all(world.icons.map(async (url) => {
				try { const t = await pixi.Assets.load<InstanceType<Px["Texture"]>>(url); t.source.scaleMode = "nearest"; icons.set(url, t); } catch { /* the glyph stands in */ }
			}));
			if (dead) return;
			const cut = new Map<string, InstanceType<Px["Texture"]>>();
			const tex = (sheet: string, x: number, y: number, size: number) => {
				const key = `${sheet}:${x}:${y}:${size}`;
				let t = cut.get(key);
				if (!t) { t = new pixi.Texture({ source: sheets.get(sheet)!.source, frame: new pixi.Rectangle(x, y, size, size) }); cut.set(key, t); }
				return t;
			};
			// ground: flat tiles, and the autotiles as one layer per animation frame
			const cam = new pixi.Container();
			const ground = new pixi.Container();
			const frameCount = Math.max(1, ...Object.values(world.tiles).map((t) => t.auto?.blocks.length ?? 1));
			const water = Array.from({ length: frameCount }, () => new pixi.Container());
			water.forEach((c, i) => { c.visible = i === 0; });
			const key = (x: number, y: number) => room.ground[y]?.[x];
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const k = key(x, y)!, t = world.tiles[k]!;
				if (!t.auto) { const s = new pixi.Sprite(tex(t.sheet, t.x, t.y, ts)); s.position.set(x * ts, y * ts); ground.addChild(s); continue; }
				// a neighbour outside the room counts as the same (the sea goes on)
				const same = (nx: number, ny: number) => nx < 0 || ny < 0 || nx >= w || ny >= h || key(nx, ny) === k;
				for (const [corner, dx, dy] of [["TL", -1, -1], ["TR", 1, -1], ["BL", -1, 1], ["BR", 1, 1]] as const) {
					const v = same(x, y + dy), hz = same(x + dx, y), d = same(x + dx, y + dy);
					const [qx, qy] = QUARTER[corner][v && hz && d ? "center" : v && hz ? "inner" : v ? "vedge" : hz ? "hedge" : "outer"];
					water.forEach((layer, f) => {
						const b = t.auto!.blocks[f % t.auto!.blocks.length]!;
						const s = new pixi.Sprite(tex(t.sheet, b.x + qx * 16, b.y + qy * 16, 16));
						s.position.set(x * ts + (dx > 0 ? 16 : 0), y * ts + (dy > 0 ? 16 : 0));
						layer.addChild(s);
					});
				}
			}
			// the sea goes on around the room: one plain cell per frame of the waves
			const sea = fill ? Object.values(world.tiles).find((t) => t.auto) : undefined;
			if (sea) for (let y = -SEA_MARGIN; y < h + SEA_MARGIN; y++) for (let x = -SEA_MARGIN; x < w + SEA_MARGIN; x++) {
				if (x >= 0 && y >= 0 && x < w && y < h) continue;
				water.forEach((layer, f) => {
					const b = sea.auto!.blocks[f % sea.auto!.blocks.length]!;
					const s = new pixi.Sprite(tex(sea.sheet, b.x + 16, b.y + 48, ts));
					s.position.set(x * ts, y * ts);
					layer.addChild(s);
				});
			}
			const objLayer = new pixi.Container();
			const charLayer = new pixi.Container();
			charLayer.sortableChildren = true;
			// plants: flat ones under the things, upright ones among the figures (sorted like them, just in front of one on
			// the same cell, so its name stays readable)
			const flat = new pixi.Container();
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const d = world.decor?.[room.decor?.[y]?.[x] ?? " "], sheet = d && sheets.get(d.sheet);
				if (!d || !sheet) continue;
				const sp = new pixi.Sprite(new pixi.Texture({ source: sheet.source, frame: new pixi.Rectangle(d.x, d.y, d.w, d.h) }));
				sp.position.set(x * ts + (ts - d.w) / 2, (y + 1) * ts - d.h);
				if (d.tint !== undefined) sp.tint = d.tint;
				if (d.upright) { sp.zIndex = y * ts * 2 + 0.5; charLayer.addChild(sp); } else flat.addChild(sp);
			}
			const fogLayer = new pixi.Graphics();
			const goalMark = new pixi.Graphics();
			cam.addChild(ground, ...water, flat, goalMark, objLayer, charLayer, fogLayer);
			a.stage.addChild(cam);
			const s: Scene = {
				pixi, app: a, cam, water, waterMs: Math.min(...Object.values(world.tiles).map((t) => t.auto?.frameMs ?? Infinity)),
				objs: objLayer, chars: charLayer, fog: fogLayer, flames: [], skins, frames: new Map(), sprites: new Map(), icons,
				size: { w: w * ts, h: h * ts }, ts, view: { zoom: latest.current.zoom, panX: 0, panY: 0 }, fogLevel: latest.current.fog, fogDirty: true,
				fill, vp: { w: a.screen.width, h: a.screen.height }, inset: latest.current.insetBottom, insetGoal: latest.current.insetBottom, zooms: fill ? fillZooms(window.devicePixelRatio || 1) : ZOOMS, goal: goalMark, scenery: new Map(), dust: [],
			};
			// the frame changes with a turned phone and the browser's bars
			if (fill) {
				s.view.zoom = nearest(s.zooms, s.view.zoom); latest.current.setZoom(s.view.zoom);
				observer = new ResizeObserver(() => { const b = host.current; if (!b || !b.clientWidth || !b.clientHeight || (b.clientWidth === s.vp.w && b.clientHeight === s.vp.h)) return; a.renderer.resize(b.clientWidth, b.clientHeight); s.vp = { w: b.clientWidth, h: b.clientHeight }; s.fogDirty = true; });
				observer.observe(host.current!);
			}
			scene.current = s;
			pointer(s, (cx, cy) => {
				const x = Math.floor(cx / ts), y = Math.floor(cy / ts);
				return x >= 0 && y >= 0 && x < w && y < h ? { x, y } : null;
			}, latest);
			draw(s, latest.current.chars, latest.current.me);
			drawObjs(s, room.roomId, latest.current.objs, latest.current.me);
			let t = 0;
			let edgeMs = 0, edgeKey = "";
			a.ticker.add((tk) => {
				t += tk.deltaMS; frame(s, world, latest.current.me, room.roomId, latest.current.objs, t, tk.deltaMS);
				if (!s.fill || (edgeMs += tk.deltaMS) < 300) return;
				edgeMs = 0;
				const now = offscreenExits(s, room.roomId, latest.current.objs), key = JSON.stringify(now);
				if (key !== edgeKey) { edgeKey = key; latest.current.setEdges(now); }
			});
		})();
		return () => {
			dead = true;
			scene.current = null;
			observer?.disconnect();
			app?.destroy(true, { children: true });
		};
	}, [world, room, fill]);

	// the characters: every change of the map of online characters (the ticker glides them there)
	useEffect(() => { if (scene.current) draw(scene.current, chars, me); }, [chars, me]);
	// things and exits: few per room, drawn again on every change
	useEffect(() => { if (scene.current) drawObjs(scene.current, room.roomId, objs, me); }, [room, objs, chars, me]);
	useEffect(() => { if (scene.current) { scene.current.fogLevel = fog; scene.current.fogDirty = true; } }, [fog]);
	useEffect(() => { if (scene.current) scene.current.insetGoal = insetBottom; }, [insetBottom]);
	useEffect(() => { const s = scene.current; if (!s) return; s.goal.clear(); if (goal) s.goal.roundRect(goal.x * s.ts + 2, goal.y * s.ts + 2, s.ts - 4, s.ts - 4, 5).fill({ color: "#AED83C", alpha: 0.22 }).stroke({ width: 2, color: "#AED83C" }); }, [goal]);
	useEffect(() => { store(zoomKey, zoom); if (scene.current && scene.current.view.zoom !== zoom) { scene.current.view = { zoom, panX: 0, panY: 0 }; scene.current.fogDirty = true; } }, [zoom]);

	return (
		<div className={`map${fill ? " fill" : ""}`} ref={host}>
			<div className="map-canvas" />
			<div className="map-zoom" role="group" aria-label="Zoom">
				{fill ? <button aria-label="Zoom ändern" onClick={() => { const zs = fillZooms(window.devicePixelRatio || 1); setZoom(zs[(zs.indexOf(zoom) + 1) % zs.length]!); }}>Zoom</button>
					: ZOOMS.map((z) => <button key={z} aria-pressed={zoom === z} onClick={() => setZoom(z)}>{z}×</button>)}
			</div>
			{edges.map((e) => <button key={e.id} className={`map-edge ${e.side}`} style={{ "--pos": `${e.pos}px` } as React.CSSProperties} onClick={() => onCell(e.x, e.y)}>{e.name}</button>)}
			{controls}
		</div>
	);
}

type Edge = { id: string; name: string; x: number; y: number; side: "left" | "right" | "top" | "bottom"; pos: number };
const nearest = (zs: readonly number[], z: number) => zs.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a));

/** The exits of the room that lie outside the picture: at which edge a sign for each goes, and where along it. */
function offscreenExits(s: Scene, roomId: string, objs: Map<string, ObjView>): Edge[] {
	const z = s.view.zoom, free = s.vp.h - s.insetGoal, out: Edge[] = [];
	for (const o of objs.values()) {
		if (o.kind !== "exit" || o.location !== roomId) continue;
		const x = (o.x + 0.5) * s.ts * z + s.cam.position.x, y = (o.y + 0.5) * s.ts * z + s.cam.position.y;
		if (x >= 0 && y >= 0 && x <= s.vp.w && y <= free) continue;
		const side = x < 0 ? "left" : x > s.vp.w ? "right" : y < 0 ? "top" : "bottom";
		const pos = side === "left" || side === "right" ? Math.max(120, Math.min(free - 60, y)) : Math.max(70, Math.min(s.vp.w - 70, x));
		out.push({ id: o.id, name: tr(o.to ?? o.name), x: o.x, y: o.y, side, pos: Math.round(pos / 8) * 8 });
	}
	return out;
}

/** Taps, long presses, right clicks, drags and pinches on the canvas. A drag (zoomed in) moves the view and is no tap; a
 *  pinch steps the zoom and is neither. */
function pointer(s: Scene, cellAt: (x: number, y: number) => { x: number; y: number } | null, latest: { current: { me: string; onCell: (x: number, y: number) => void; onMenu: (x: number, y: number, cx: number, cy: number) => void; zoom: number; setZoom: (z: number) => void } }) {
	const stage = s.app.stage;
	stage.eventMode = "static";
	stage.hitArea = s.app.screen;
	const fingers = pinch();
	let mid: { x: number; y: number } | null = null;
	// the wheel goes through the zoom steps of a filling map (a framed one has its buttons, and the page scrolls past it)
	if (s.fill) s.app.canvas.addEventListener("wheel", (e) => {
		e.preventDefault();
		const i = s.zooms.indexOf(latest.current.zoom), next = s.zooms[i + (e.deltaY < 0 ? 1 : -1)];
		if (next) latest.current.setZoom(next);
	}, { passive: false });
	s.app.canvas.addEventListener("pointercancel", (e) => { mid = null; fingers.up(e.pointerId); if (down) { clearTimeout(down.timer); down = null; } });
	let down: { x: number; y: number; panX: number; panY: number; dragged: boolean; pressed: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
	const cell = (e: { getLocalPosition: (c: InstanceType<Px["Container"]>) => { x: number; y: number } }) => { const p = e.getLocalPosition(s.cam); return cellAt(p.x, p.y); };
	stage.on("pointerdown", (e) => {
		if (e.button === 2) return; // the right click opens the menu below
		if (fingers.down(e.pointerId, e.global.x, e.global.y)) { if (down) clearTimeout(down.timer); down = null; return; }
		if (fingers.active) return;
		const at = cell(e), client = { x: e.client.x, y: e.client.y };
		down = { x: e.global.x, y: e.global.y, panX: s.view.panX, panY: s.view.panY, dragged: false, pressed: false, timer: setTimeout(() => {
			if (!down || down.dragged || !at) return;
			down.pressed = true;
			latest.current.onMenu(at.x, at.y, client.x, client.y);
		}, LONG_PRESS_MS) };
	});
	stage.on("pointermove", (e) => {
		const spread = fingers.move(e.pointerId, e.global.x, e.global.y);
		if (spread !== null) {
			const i = s.zooms.indexOf(latest.current.zoom);
			const next = spread > PINCH_STEP ? s.zooms[i + 1] : spread < 1 / PINCH_STEP ? s.zooms[i - 1] : undefined;
			const c = fingers.center!;
			// the fingers carry the map along, and what lies between them stays there through a zoom step
			if (s.fill && mid) { s.view.panX += c.x - mid.x; s.view.panY += c.y - mid.y; }
			mid = c;
			if (next) {
				const own = s.sprites.get(latest.current.me);
				if (s.fill && own) {
					const z = s.view.zoom, wx = (c.x - s.cam.position.x) / z, wy = (c.y - s.cam.position.y) / z, ts = s.ts;
					s.view = { zoom: next, panX: c.x - wx * next - (s.vp.w / 2 - (own.px + ts / 2) * next), panY: c.y - wy * next - ((s.vp.h - s.inset) / 2 - (own.py + ts / 2) * next) };
					s.fogDirty = true;
				}
				latest.current.setZoom(next); fingers.rebase();
			}
			return;
		}
		if (!down) return;
		const dx = e.global.x - down.x, dy = e.global.y - down.y;
		if (!down.dragged && Math.hypot(dx, dy) > DRAG_PX) { down.dragged = true; clearTimeout(down.timer); }
		if (down.dragged && (s.fill || s.view.zoom > 1)) { s.view.panX = down.panX + dx; s.view.panY = down.panY + dy; s.fogDirty = true; }
	});
	const up = (e: { pointerId: number; getLocalPosition: (c: InstanceType<Px["Container"]>) => { x: number; y: number } }, inside: boolean) => {
		fingers.up(e.pointerId); mid = null;
		if (!down) return;
		clearTimeout(down.timer);
		const tap = !down.dragged && !down.pressed;
		down = null;
		const at = inside ? cell(e) : null;
		if (tap && at) latest.current.onCell(at.x, at.y);
	};
	stage.on("pointerup", (e) => up(e, true));
	stage.on("pointerupoutside", (e) => up(e, false));
	stage.on("rightclick", (e) => { const at = cell(e); if (at) latest.current.onMenu(at.x, at.y, e.client.x, e.client.y); });
}

/** One frame: glide and animate the characters, move the waves, let the fire flicker, follow the own character with
 *  the camera, redraw the fog's clearings when something moved. */
function frame(s: Scene, world: Hello["world"], me: string, roomId: string, objs: Map<string, ObjView>, t: number, dt: number): void {
	const ts = s.ts, ownAt = s.sprites.get(me);
	for (const [id, sp] of s.sprites) {
		const skin = world.skins[sp.skin % world.skins.length]!;
		const gx = sp.tx * ts, gy = sp.ty * ts;
		const dx = gx - sp.px, dy = gy - sp.py, dist = Math.hypot(dx, dy);
		const moving = dist > 0.5;
		if (dist > ts * 3) { sp.px = gx; sp.py = gy; } // a jump (another room, a long walk): no slow slide across the map
		else if (moving) { const k = Math.min(1, (SPEED * dt) / 1000 / dist); sp.px += dx * k; sp.py += dy * k; if (id === me) s.fogDirty = true; }
		if (moving) sp.movedAt = t;
		const col = moving || t - (sp.movedAt ?? -Infinity) < WALK_GRACE_MS ? Math.floor(t / STEP_MS) % 4 : 0;
		const fk = `${sp.skin % s.skins.length}:${sp.row}:${col}`;
		let tex = s.frames.get(fk);
		if (!tex) { tex = new s.pixi.Texture({ source: s.skins[sp.skin % s.skins.length]!.source, frame: new s.pixi.Rectangle(col * skin.frameW, sp.row * skin.frameH, skin.frameW, skin.frameH) }); s.frames.set(fk, tex); }
		sp.body.texture = tex;
		sp.body.position.set(sp.px + (ts - skin.frameW) / 2, sp.py + ts - skin.frameH);
		sp.body.zIndex = sp.py * 2;
		sp.label.position.set(sp.px + ts / 2, sp.py + ts - skin.frameH);
		sp.label.zIndex = id === me ? Number.MAX_SAFE_INTEGER : sp.py * 2 + 1; // the own name on top of all others
		// names: all of them in a quiet room; in a crowd only the own one and those standing close by
		const near = !!ownAt && Math.max(Math.abs(sp.tx - ownAt.tx), Math.abs(sp.ty - ownAt.ty)) <= 2;
		sp.label.visible = id === me || s.sprites.size <= CROWD || near;
	}
	if (s.water.length > 1 && Number.isFinite(s.waterMs)) { const f = Math.floor(t / s.waterMs) % s.water.length; s.water.forEach((c, i) => { c.visible = i === f; }); }
	s.flames.forEach((g, i) => { const k = 1 + 0.12 * Math.sin(t / 85 + i * 2) + 0.06 * Math.sin(t / 37 + i); g.scale.set(k, 2 - k); g.alpha = 0.85 + 0.15 * Math.sin(t / 60 + i); });
	// camera: zoomed in, the own character in the middle (plus how far the player dragged), never past the map's edge
	const z = s.view.zoom, own = s.sprites.get(me);
	s.cam.scale.set(z);
	if (s.fill && own) {
		// the own character in the middle of what the sheet leaves free; a step brings a dragged view back to it
		s.inset += (s.insetGoal - s.inset) * Math.min(1, dt / 120);
		if (own.px !== own.tx * ts || own.py !== own.ty * ts) { s.view.panX *= 0.85; s.view.panY *= 0.85; }
		const edge = SEA_MARGIN * ts * z;
		const cx = s.vp.w / 2 - (own.px + ts / 2) * z + s.view.panX, cy = (s.vp.h - s.inset) / 2 - (own.py + ts / 2) * z + s.view.panY;
		s.cam.position.set(Math.round(Math.min(edge, Math.max(s.vp.w - s.size.w * z - edge, cx))), Math.round(Math.min(edge, Math.max(s.vp.h - s.size.h * z - edge, cy))));
	}
	else if (z === 1 || !own) s.cam.position.set(0, 0);
	else {
		const vw = s.size.w, vh = s.size.h;
		const cx = vw / 2 - (own.px + ts / 2) * z + s.view.panX, cy = vh / 2 - (own.py + ts / 2) * z + s.view.panY;
		s.cam.position.set(Math.min(0, Math.max(vw - s.size.w * z, cx)), Math.min(0, Math.max(vh - s.size.h * z, cy)));
	}
	for (const g of [...s.dust]) { g.alpha -= dt / 900; g.scale.set(1 + (1 - g.alpha) * 0.04); if (g.alpha <= 0) { s.dust.splice(s.dust.indexOf(g), 1); g.destroy(); } }
	if (s.fogDirty) { s.fogDirty = false; drawFog(s, roomId, objs, own); }
}

/** Fog levels 1..3 as a growing grey veil (0: none), with a clearing around the own character and a larger one around
 *  a burning fire. */
function drawFog(s: Scene, roomId: string, objs: Map<string, ObjView>, own: Sp | undefined): void {
	const g = s.fog, ts = s.ts;
	g.clear();
	const alpha = [0, 0.22, 0.42, 0.62][Math.max(0, Math.min(3, s.fogLevel))]!;
	if (!alpha) return;
	const m = s.fill ? SEA_MARGIN * ts : 0;
	g.rect(-m, -m, s.size.w + 2 * m, s.size.h + 2 * m).fill({ color: "#c9d2da", alpha });
	if (own) g.circle(own.px + ts / 2, own.py + ts / 2, ts * 2.2).cut();
	for (const o of objs.values()) if (o.kind === "beacon" && o.location === roomId && (o.until ?? 0) > Date.now()) g.circle(o.x * ts + ts / 2, o.y * ts + ts / 2, ts * 4).cut();
}

/** Scenery drawn from plain shapes, weathered: the room's huts, nets, boats, barrels and jetties. */
function sceneryView(p: Px, o: ObjView, ts: number): InstanceType<Px["Graphics"]> {
	const x = o.x * ts, y = o.y * ts, w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts, g = new p.Graphics();
	if (o.model === "huette") {
		g.poly([x + 4, y + h * 0.45, x + w - 2, y + h * 0.4, x + w - 4, y + h - 2, x + 6, y + h - 3]).fill({ color: "#6d6256" }).stroke({ width: 2, color: "#2a241d" });
		g.poly([x - 2, y + h * 0.5, x + w * 0.46, y + 2, x + w + 2, y + h * 0.42]).fill({ color: "#4a4038" }).stroke({ width: 2, color: "#2a241d" });
		g.rect(x + w * 0.42, y + h * 0.66, 14, h * 0.34 - 3).fill({ color: "#2a241d" });
	} else if (o.model === "netz") {
		for (const px of [x + 6, x + w - 6]) g.rect(px - 2, y + 2, 4, h - 4).fill({ color: "#5b4530" });
		g.rect(x + 6, y + 4, w - 12, 2).fill({ color: "#5b4530" });
		for (let i = 0; i < 12; i++) { const a = x + 9 + (i * (w - 18)) / 11; g.moveTo(a, y + 6).lineTo(a + 3, y + h - 6).stroke({ width: 1, color: "#c8c0a8", alpha: 0.8 }); }
		for (const dy of [12, 19]) g.moveTo(x + 9, y + dy).lineTo(x + w - 9, y + dy).stroke({ width: 1, color: "#c8c0a8", alpha: 0.8 });
	} else if (o.model === "boot") {
		g.poly([x + 2, y + 8, x + w - 2, y + 8, x + w - 12, y + h - 3, x + 12, y + h - 3]).fill({ color: "#6b4a2e" }).stroke({ width: 2, color: "#2a1d10" });
		for (const dx of [0.33, 0.66]) g.rect(x + w * dx, y + 9, 3, h - 13).fill({ color: "#3e2a18" });
	} else if (o.model === "felsen" || o.model === "mauer" || o.model === "turm") {
		const n = Math.max(1, Math.round(w / ts)) * (o.model === "mauer" ? 2 : 1);
		for (let i = 0; i < n; i++) g.roundRect(x + 2 + (i * w) / n, y + (o.model === "turm" ? 2 : h * 0.35) + (i % 2) * 3, w / n + 2, h * (o.model === "turm" ? 0.9 : 0.55), 5).fill({ color: i % 2 ? "#7c8086" : "#6b6f75" }).stroke({ width: 2, color: "#34373b" });
	} else if (o.model === "kisten") {
		for (const dx of [0, 1]) { g.rect(x + dx * ts + 4, y + 6, ts - 8, ts - 9).fill({ color: "#8a6a44" }).stroke({ width: 2, color: "#3e2a18" }); g.moveTo(x + dx * ts + 4, y + 6).lineTo(x + dx * ts + ts - 4, y + ts - 3).stroke({ width: 1.5, color: "#3e2a18" }); }
	} else if (o.model === "stand") {
		g.rect(x + 3, y + 14, w - 6, h - 16).fill({ color: "#6b4a2e" }).stroke({ width: 2, color: "#2a1d10" });
		for (let i = 0; i < 6; i++) g.rect(x + 2 + (i * (w - 4)) / 6, y + 2, (w - 4) / 6, 12).fill({ color: i % 2 ? "#e8e0cc" : "#b5533c" });
	} else if (o.model === "meiler") {
		g.ellipse(x + w / 2, y + h * 0.58, w * 0.46, h * 0.4).fill({ color: "#3b3430" }).stroke({ width: 2, color: "#1b1715" });
		g.circle(x + w / 2, y + h * 0.3, 4).fill({ color: "#8d8d8d", alpha: 0.6 }); g.circle(x + w / 2 + 3, y + h * 0.16, 6).fill({ color: "#a8a8a8", alpha: 0.4 });
	} else if (o.model === "becken") {
		g.roundRect(x + 2, y + 2, w - 4, h - 4, 6).fill({ color: "#cfe0e6" }).stroke({ width: 3, color: "#8a7a66" });
		g.moveTo(x + w * 0.5, y + 3).lineTo(x + w * 0.5, y + h - 3).stroke({ width: 3, color: "#8a7a66" });
	} else if (o.model === "rumpf") {
		g.poly([x + 2, y + h * 0.3, x + w - 2, y + h * 0.2, x + w - 16, y + h - 3, x + 14, y + h - 3]).fill({ color: "#5e4028", alpha: 0.5 }).stroke({ width: 2, color: "#2a1d10" });
		for (let i = 1; i < 6; i++) g.rect(x + (i * w) / 6, y + 6, 4, h - 10).fill({ color: "#7a5c3e" });
	} else if (o.model === "faesser") {
		for (const dx of [0, 1]) { g.roundRect(x + dx * ts + 5, y + 5, ts - 10, ts - 8, 6).fill({ color: "#4b3626" }).stroke({ width: 2, color: "#1f160e" }); g.rect(x + dx * ts + 5, y + 13, ts - 10, 2).fill({ color: "#8a8f94" }); }
	} else {
		g.rect(x, y, w, h).fill({ color: "#7a5c3e" });
		const across = w >= h;
		for (let i = 0; i <= (across ? w : h) / 8; i++) { if (across) g.rect(x + i * 8, y, 1.5, h).fill({ color: "#3e2a18" }); else g.rect(x, y + i * 8, w, 1.5).fill({ color: "#3e2a18" }); }
	}
	return g;
}

/** Exits as marked cells with their name, things lying in the room as their pictures (or glyphs where a thing has
 *  none), a beacon as a fire in a ring (its flames flicker in `frame`) or a cold ring. */
/** A fence round a bed, field or coop of w×h cells: a light rail with posts at the corners and between the cells. */
function fence2d(g: InstanceType<Px["Graphics"]>, x: number, y: number, w: number, h: number, ts: number): void {
	g.rect(x + 0.5, y + 0.5, w * ts - 1, h * ts - 1).stroke({ width: 1.5, color: "#c9a46a" });
	for (let fx = 0; fx <= w; fx++) for (const fy of [0, h]) g.rect(x + fx * ts - 1.5, y + fy * ts - 1.5, 3, 3).fill({ color: "#8a6a3a" });
	for (let fy = 1; fy < h; fy++) for (const fx of [0, w]) g.rect(x + fx * ts - 1.5, y + fy * ts - 1.5, 3, 3).fill({ color: "#8a6a3a" });
}

function drawObjs(s: Scene, roomId: string, objs: Map<string, ObjView>, me: string): void {
	const ts = s.ts, p = s.pixi;
	for (const child of s.objs.removeChildren()) child.destroy({ children: true });
	s.flames = [];
	s.fogDirty = true;
	// what was cleared goes in a puff of dust
	for (const [id, o] of s.scenery) if (!objs.has(id) && o.location === roomId) {
		const g = new p.Graphics(), w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts;
		for (let i = 0; i < 9; i++) g.circle(o.x * ts + (w * ((i * 37) % 10)) / 10, o.y * ts + (h * ((i * 53) % 10)) / 10, 5 + (i % 4) * 3).fill({ color: "#b9a98c", alpha: 0.7 });
		s.cam.addChild(g); s.dust.push(g);
	}
	s.scenery = new Map([...objs].filter(([, o]) => o.kind === "scenery"));
	for (const o of objs.values()) {
		if (o.location !== roomId) continue;
		const x = o.x * ts, y = o.y * ts, cx = x + ts / 2, cy = y + ts / 2;
		if (o.kind === "scenery") { s.objs.addChild(sceneryView(p, o, ts)); continue; }
		if (o.kind === "liner") {
			// the large ship in the bay (App, engine/liner.ts): a dark hull with a white deckhouse and a funnel
			const w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts, along = w > h, inset = ts * 0.15;
			const g = new p.Graphics().roundRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset, ts * 0.35).fill({ color: "#2a2f38" }).stroke({ width: 2, color: "#9a2a22" });
			g.rect(along ? x + w * 0.35 : x + ts * 0.3, along ? y + ts * 0.3 : y + h * 0.35, along ? w * 0.25 : ts * 0.4, along ? ts * 0.4 : h * 0.25).fill({ color: "#ece6d6" });
			g.circle(along ? x + w * 0.55 : cx, along ? cy : y + h * 0.55, ts * 0.12).fill({ color: "#3a3d44" }).stroke({ width: 2, color: "#9a2a22" });
			const label = new p.Text({ text: tr(o.name), resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#f0e6d2", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(x + w / 2, y + h);
			s.objs.addChild(g, label);
			continue;
		}
		if (o.kind === "beacon") {
			const lit = (o.until ?? 0) > Date.now();
			const ring = new p.Graphics().circle(cx, cy, 13).fill({ color: lit ? "#3a2412" : "#2b2f33" }).stroke({ width: 2, color: lit ? "#8a5a2b" : "#5a6068" });
			s.objs.addChild(ring);
			if (lit) {
				const flame = new p.Graphics().circle(0, 0, 9).fill({ color: "#f08a24" }).circle(0, 2, 5).fill({ color: "#ffd84a" });
				flame.position.set(cx, cy);
				s.objs.addChild(flame);
				s.flames.push(flame);
			}
			const label = new p.Text({ text: o.name, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: lit ? "#ffd84a" : "#c0c6cc", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(cx, y + ts);
			s.objs.addChild(label);
			continue;
		}
		if (o.kind === "zone") {
			// a zone of the town hall: a tint over its ground, the name in the corner
			const w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts;
			const g = new p.Graphics().rect(x, y, w, h).fill({ color: o.color ?? "#5fbf6a", alpha: 0.16 }).stroke({ width: 1, color: o.color ?? "#5fbf6a", alpha: 0.7 });
			const label = new p.Text({ text: tr(o.name), resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 9, fill: o.color ?? "#5fbf6a", stroke: { color: "#000000", width: 3 } } });
			label.position.set(x + 3, y + 2);
			s.objs.addChildAt(g, 0);
			s.objs.addChild(label);
			continue;
		}
		if (o.kind === "bed") {
			// a bed: dug soil with furrows, each plant at its cell by its stage (seed, sprout, ripe in the sort's colour, wilted)
			const w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts;
			const g = new p.Graphics().rect(x + 2, y + 2, w - 4, h - 4).fill({ color: "#6b4a2e" }).stroke({ width: 2, color: "#3e2a18" });
			// a fence: a light rail around it with posts at the corners and between the cells
			if (o.fenced) fence2d(g, x, y, o.w ?? 1, o.h ?? 1, ts);
			for (let fy = y + 6; fy < y + h - 4; fy += 6) g.rect(x + 4, fy, w - 8, 1).fill({ color: "#4e3520" });
			if (o.weedy) for (const [wx, wy] of [[0.2, 0.3], [0.7, 0.2], [0.45, 0.75], [0.85, 0.8]] as const) g.rect(x + w * wx, y + h * wy, 2, 3).fill({ color: "#5f8a3a" });
			for (const pl of o.plants ?? []) {
				const px = x + pl.x * ts + ts / 2, py = y + pl.y * ts + ts / 2;
				if (pl.stage === 0) g.circle(px, py + 3, 2).fill({ color: "#2e1e10" });
				else if (pl.stage === 1) { g.rect(px - 0.5, py - 1, 1.5, 6).fill({ color: "#4f8a3a" }); g.ellipse(px - 3, py - 1, 3, 1.6).fill({ color: "#6fb04a" }); g.ellipse(px + 3, py - 2, 3, 1.6).fill({ color: "#6fb04a" }); }
				else if (pl.stage === 2) { g.rect(px - 0.5, py, 1.5, 7).fill({ color: "#4f8a3a" }); g.circle(px, py - 2, 5.5).fill({ color: pl.color }).stroke({ width: 1, color: "#1a1410", alpha: 0.6 }); }
				else g.poly([px - 4, py + 5, px, py - 3, px + 4, py + 5]).fill({ color: "#7a6a4a", alpha: 0.9 });
			}
			const label = new p.Text({ text: `Beet von ${o.owner ?? ""}`, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#f0e6d2", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(x + w / 2, y + h);
			s.objs.addChild(g, label);
			continue;
		}
		if (o.kind === "field") {
			// a field: soil in rows; fallow light with a few tufts, being sown the furrows so far, growing green shoots,
			// ripe the crop's colour (late a little faded)
			const w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts, stage = o.fieldStage ?? "brach";
			const g = new p.Graphics().rect(x + 1, y + 1, w - 2, h - 2).fill({ color: stage === "brach" ? "#8a6e48" : "#5e4028" }).stroke({ width: 2, color: "#3e2a18" });
			const rows = Math.max(2, Math.floor(h / 8));
			for (let r = 0; r < rows; r++) {
				const ry = y + 4 + (r + 0.5) * ((h - 8) / rows);
				if (stage === "brach") { if (r % 2) for (let tx = x + 6 + (r % 3) * 5; tx < x + w - 4; tx += 17) g.rect(tx, ry - 2, 2, 3).fill({ color: "#6f8a3a" }); continue; }
				if (stage === "saat") { if (r / rows < (o.progress ?? 0)) g.rect(x + 4, ry, w - 8, 2).fill({ color: "#3e2a18" }); continue; }
				g.rect(x + 4, ry, w - 8, 2).fill({ color: "#3e2a18" });
				const color = stage === "waechst" ? "#6fb04a" : o.color ?? "#d9b44a", tall = stage === "waechst" ? 3 : 6;
				for (let tx = x + 5; tx < x + w - 4; tx += 4) g.rect(tx, ry - tall, 2, tall).fill({ color, alpha: stage === "spaet" ? 0.6 : 1 });
			}
			if (o.fenced) fence2d(g, x, y, o.w ?? 1, o.h ?? 1, ts);
			const label = new p.Text({ text: `${o.name} von ${o.owner ?? ""}`, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#f0e6d2", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(x + w / 2, y + h);
			s.objs.addChild(g, label);
			continue;
		}
		if (o.kind === "ruin") {
			const w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts;
			const g = new p.Graphics().rect(x + 3, y + h * 0.45, w - 6, h * 0.55 - 3).fill({ color: "#6b6f73", alpha: 0.8 }).stroke({ width: 2, color: "#2b2f33" });
			g.poly([x + 3, y + h * 0.45, x + w * 0.3, y + h * 0.3, x + w * 0.45, y + h * 0.45]).fill({ color: "#55595d" });
			const label = new p.Text({ text: `Ruine (${o.name})`, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#c0c6cc", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(x + w / 2, y + h);
			s.objs.addChild(g, label);
			continue;
		}
		if (o.kind === "site" || o.kind === "building") {
			// a building as its picture (buildings2d.ts); a site as staked-out ground with
			// posts at the corners and a bar of how far it is
			const w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts, color = o.color ?? "#8a6a44";
			const g = new p.Graphics();
			if (o.kind === "building") {
				building2d(g, o.plan, x, y, w, h, ts, color);
				if (o.fenced) fence2d(g, x, y, o.w ?? 1, o.h ?? 1, ts);
			} else {
				// one's own site stands out at once: a bright border, and its label says so
				g.rect(x + 2, y + 2, w - 4, h - 4).fill({ color: "#c9a26b", alpha: 0.35 }).stroke(o.ownerId === me ? { width: 3, color: "#dfff73" } : { width: 2, color: "#7a5a36", alpha: 0.9 });
				for (const [px, py] of [[x + 3, y + 3], [x + w - 7, y + 3], [x + 3, y + h - 7], [x + w - 7, y + h - 7]] as const) g.rect(px, py, 4, 4).fill({ color: "#5b3a22" });
				g.rect(x + 6, y + h - 10, (w - 12) * Math.min(1, o.progress ?? 0), 4).fill({ color: "#AED83C" });
			}
			const own = o.ownerId === me;
			const label = new p.Text({ text: `${tr(o.kind === "site" ? (own ? `Deine Baustelle: ${o.name}` : `Baustelle ${o.name} von ${o.owner ?? ""}`) : `${o.name} von ${o.owner ?? ""}`)}${o.orders?.length ? ` · ${tr("Aushang")}` : ""}`, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: o.kind === "site" && own ? "#dfff73" : "#f0e6d2", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(x + w / 2, y + h);
			s.objs.addChild(g, label);
			continue;
		}
		if (o.kind === "exit") {
			const g = new p.Graphics().rect(x + 2, y + 2, ts - 4, ts - 4).fill({ color: "#AED83C", alpha: 0.22 }).stroke({ width: 2, color: "#AED83C" });
			const label = new p.Text({ text: tr(o.to ?? o.name), resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#AED83C", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(cx, y + ts);
			s.objs.addChild(g, label);
			continue;
		}
		const icon = o.icon && s.icons.get(o.icon);
		if (icon) {
			// a little smaller than the cell, standing on its lower edge, with a soft shadow under it
			const shadow = new p.Graphics().ellipse(cx, y + ts - 4, 9, 3).fill({ color: "#000000", alpha: 0.28 });
			const sp = new p.Sprite(icon);
			sp.width = sp.height = ts - 6;
			sp.position.set(x + 3, y + 1);
			s.objs.addChild(shadow, sp);
			continue;
		}
		const color = o.glyph?.color ?? "#9aa3ad", shape = o.glyph?.shape ?? "square";
		const g = new p.Graphics();
		if (shape === "circle") g.circle(cx, cy + 4, 6);
		else if (shape === "diamond") g.poly([cx, cy - 4, cx + 7, cy + 4, cx, cy + 12, cx - 7, cy + 4]);
		else g.rect(cx - 8, cy, 16, 9);
		g.fill({ color }).stroke({ width: 1.5, color: "#1b1b1b" });
		s.objs.addChild(g);
	}
}

/** Brings the sprites in line with `chars`: new ones appear where they are, gone ones are removed, moved ones get a
 *  new target (the ticker glides them there, facing the way they go). */
function draw(s: Scene, chars: Map<string, CharView>, me: string): void {
	const ts = s.ts;
	for (const [id, sp] of s.sprites) if (!chars.has(id)) { sp.body.destroy(); sp.label.destroy(); s.sprites.delete(id); }
	for (const c of chars.values()) {
		let sp = s.sprites.get(c.charId);
		if (sp && sp.label.text !== c.name) sp.label.text = c.name; // an alias shows at once
		if (!sp) {
			const body = new s.pixi.Sprite();
			const label = new s.pixi.Text({ text: c.name, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 11, fill: c.charId === me ? "#AED83C" : c.ai ? "#9fd3ff" : "#ffffff", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 1);
			s.chars.addChild(body, label);
			sp = { body, label, tx: c.x, ty: c.y, px: c.x * ts, py: c.y * ts, row: ROW.down, skin: c.skin };
			s.sprites.set(c.charId, sp);
		}
		if (c.x !== sp.tx || c.y !== sp.ty) sp.row = c.x > sp.tx ? ROW.right : c.x < sp.tx ? ROW.left : c.y < sp.ty ? ROW.up : ROW.down;
		Object.assign(sp, { tx: c.x, ty: c.y, skin: c.skin });
		sp.label.text = c.ai ? `${c.name} (KI)` : c.settler ? `${c.name} (Siedler)` : c.name; // a model or a script plays it: always marked
	}
	s.fogDirty = true;
}
