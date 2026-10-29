"use client";
// The tile map of the current room, drawn with PixiJS (docs/architektur.md, "Grafik"). React owns the frame; PixiJS
// only the canvas: the ground once per room (autotiled water whose waves move), exits and things on it, one sprite per
// online character that glides from cell to cell with its walking frames, a flickering fire, and the fog as a veil with
// clearings around the own character and a burning fire. A zoom of 2 or 3 follows the own character; dragging looks
// around, two fingers pinch through the zoom steps. A tap on a cell goes to `onCell`, a long press or a right click to
// `onMenu`; the map never changes the world by itself. pixi.js is imported in the browser only; without WebGL `onFail` says so and the page plays as text.
import { useEffect, useRef, useState } from "react";
import type { CharView, ObjView, ServerFrame } from "../server/gateway.ts";
import { pinch } from "./pinch.ts";
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
const DRAG_PX = 8;
const ZOOMS = [1, 2, 3] as const;
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

export function MapView({ world, room, chars, objs, me, fog, onCell, onMenu, onFail, controls }: {
	world: Hello["world"]; room: Hello["room"]; chars: Map<string, CharView>; objs: Map<string, ObjView>; me: string; fog: number;
	onCell: (x: number, y: number) => void; onMenu: (x: number, y: number, clientX: number, clientY: number) => void; onFail: (why: string) => void;
	controls?: React.ReactNode;
}) {
	const host = useRef<HTMLDivElement>(null);
	const scene = useRef<Scene | null>(null);
	const [zoom, setZoom] = useState(() => stored("mmo.zoom", 1));
	const latest = useRef({ chars, objs, me, fog, onCell, onMenu, onFail, zoom, setZoom });
	latest.current = { chars, objs, me, fog, onCell, onMenu, onFail, zoom, setZoom };

	// the scene: built again when the room changes
	useEffect(() => {
		let dead = false;
		let app: InstanceType<Px["Application"]> | null = null;
		const ts = world.tileSize, w = room.ground[0]!.length, h = room.ground.length;
		void (async () => {
			const pixi = await import("pixi.js");
			const a = new pixi.Application();
			try {
				await a.init({ width: w * ts, height: h * ts, background: "#0b1016", antialias: false, preference: "webgl", resolution: Math.max(1, Math.round(window.devicePixelRatio || 1)), autoDensity: true });
			} catch (e) {
				latest.current.onFail(`Die Karte braucht WebGL (${(e as Error).message || "nicht verfügbar"}); das Spiel läuft als Text weiter.`);
				return;
			}
			if (dead) { a.destroy(true, { children: true }); return; }
			app = a;
			// autoDensity sets the CSS size inline; the stylesheet scales the canvas to its frame instead (pointer events
			// follow, PixiJS maps them through the element's box)
			a.canvas.style.width = "100%";
			a.canvas.style.height = "auto";
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
			cam.addChild(ground, ...water, flat, objLayer, charLayer, fogLayer);
			a.stage.addChild(cam);
			const s: Scene = {
				pixi, app: a, cam, water, waterMs: Math.min(...Object.values(world.tiles).map((t) => t.auto?.frameMs ?? Infinity)),
				objs: objLayer, chars: charLayer, fog: fogLayer, flames: [], skins, frames: new Map(), sprites: new Map(), icons,
				size: { w: w * ts, h: h * ts }, ts, view: { zoom: latest.current.zoom, panX: 0, panY: 0 }, fogLevel: latest.current.fog, fogDirty: true,
			};
			scene.current = s;
			pointer(s, (cx, cy) => {
				const x = Math.floor(cx / ts), y = Math.floor(cy / ts);
				return x >= 0 && y >= 0 && x < w && y < h ? { x, y } : null;
			}, latest);
			draw(s, latest.current.chars, latest.current.me);
			drawObjs(s, room.roomId, latest.current.objs);
			let t = 0;
			a.ticker.add((tk) => { t += tk.deltaMS; frame(s, world, latest.current.me, room.roomId, latest.current.objs, t, tk.deltaMS); });
		})();
		return () => {
			dead = true;
			scene.current = null;
			app?.destroy(true, { children: true });
		};
	}, [world, room]);

	// the characters: every change of the map of online characters (the ticker glides them there)
	useEffect(() => { if (scene.current) draw(scene.current, chars, me); }, [chars, me]);
	// things and exits: few per room, drawn again on every change
	useEffect(() => { if (scene.current) drawObjs(scene.current, room.roomId, objs); }, [room, objs]);
	useEffect(() => { if (scene.current) { scene.current.fogLevel = fog; scene.current.fogDirty = true; } }, [fog]);
	useEffect(() => { store("mmo.zoom", zoom); if (scene.current) { scene.current.view = { zoom, panX: 0, panY: 0 }; scene.current.fogDirty = true; } }, [zoom]);

	return (
		<div className="map" ref={host}>
			<div className="map-canvas" />
			<div className="map-zoom" role="group" aria-label="Zoom">
				{ZOOMS.map((z) => <button key={z} aria-pressed={zoom === z} onClick={() => setZoom(z)}>{z}×</button>)}
			</div>
			{controls}
		</div>
	);
}

/** Taps, long presses, right clicks, drags and pinches on the canvas. A drag (zoomed in) moves the view and is no tap; a
 *  pinch steps the zoom and is neither. */
function pointer(s: Scene, cellAt: (x: number, y: number) => { x: number; y: number } | null, latest: { current: { onCell: (x: number, y: number) => void; onMenu: (x: number, y: number, cx: number, cy: number) => void; zoom: number; setZoom: (z: number) => void } }) {
	const stage = s.app.stage;
	stage.eventMode = "static";
	stage.hitArea = s.app.screen;
	const fingers = pinch();
	s.app.canvas.addEventListener("pointercancel", (e) => { fingers.up(e.pointerId); if (down) { clearTimeout(down.timer); down = null; } });
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
			const i = ZOOMS.indexOf(latest.current.zoom as (typeof ZOOMS)[number]);
			const next = spread > PINCH_STEP ? ZOOMS[i + 1] : spread < 1 / PINCH_STEP ? ZOOMS[i - 1] : undefined;
			if (next) { latest.current.setZoom(next); fingers.rebase(); }
			return;
		}
		if (!down) return;
		const dx = e.global.x - down.x, dy = e.global.y - down.y;
		if (!down.dragged && Math.hypot(dx, dy) > DRAG_PX) { down.dragged = true; clearTimeout(down.timer); }
		if (down.dragged && s.view.zoom > 1) { s.view.panX = down.panX + dx; s.view.panY = down.panY + dy; s.fogDirty = true; }
	});
	const up = (e: { pointerId: number; getLocalPosition: (c: InstanceType<Px["Container"]>) => { x: number; y: number } }, inside: boolean) => {
		fingers.up(e.pointerId);
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
	if (z === 1 || !own) s.cam.position.set(0, 0);
	else {
		const vw = s.size.w, vh = s.size.h;
		const cx = vw / 2 - (own.px + ts / 2) * z + s.view.panX, cy = vh / 2 - (own.py + ts / 2) * z + s.view.panY;
		s.cam.position.set(Math.min(0, Math.max(vw - s.size.w * z, cx)), Math.min(0, Math.max(vh - s.size.h * z, cy)));
	}
	if (s.fogDirty) { s.fogDirty = false; drawFog(s, roomId, objs, own); }
}

/** Fog levels 1..3 as a growing grey veil (0: none), with a clearing around the own character and a larger one around
 *  a burning fire. */
function drawFog(s: Scene, roomId: string, objs: Map<string, ObjView>, own: Sp | undefined): void {
	const g = s.fog, ts = s.ts;
	g.clear();
	const alpha = [0, 0.22, 0.42, 0.62][Math.max(0, Math.min(3, s.fogLevel))]!;
	if (!alpha) return;
	g.rect(0, 0, s.size.w, s.size.h).fill({ color: "#c9d2da", alpha });
	if (own) g.circle(own.px + ts / 2, own.py + ts / 2, ts * 2.2).cut();
	for (const o of objs.values()) if (o.kind === "beacon" && o.location === roomId && (o.until ?? 0) > Date.now()) g.circle(o.x * ts + ts / 2, o.y * ts + ts / 2, ts * 4).cut();
}

/** Exits as marked cells with their name, things lying in the room as their pictures (or glyphs where a thing has
 *  none), a beacon as a fire in a ring (its flames flicker in `frame`) or a cold ring. */
function drawObjs(s: Scene, roomId: string, objs: Map<string, ObjView>): void {
	const ts = s.ts, p = s.pixi;
	for (const child of s.objs.removeChildren()) child.destroy({ children: true });
	s.flames = [];
	s.fogDirty = true;
	for (const o of objs.values()) {
		if (o.location !== roomId) continue;
		const x = o.x * ts, y = o.y * ts, cx = x + ts / 2, cy = y + ts / 2;
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
			// a building as a house of its footprint (walls, a roof, a door at the bottom); a site as staked-out ground with
			// posts at the corners and a bar of how far it is
			const w = (o.w ?? 1) * ts, h = (o.h ?? 1) * ts, color = o.color ?? "#8a6a44";
			const g = new p.Graphics();
			if (o.kind === "building") {
				g.rect(x + 3, y + h * 0.35, w - 6, h * 0.65 - 3).fill({ color }).stroke({ width: 2, color: "#2a1d10" });
				g.poly([x, y + h * 0.4, x + w / 2, y + 2, x + w, y + h * 0.4]).fill({ color: "#5b3a22" }).stroke({ width: 2, color: "#2a1d10" });
				g.rect(x + w / 2 - ts * 0.2, y + h - ts * 0.55, ts * 0.4, ts * 0.55 - 3).fill({ color: "#2a1d10" });
			} else {
				g.rect(x + 2, y + 2, w - 4, h - 4).fill({ color: "#c9a26b", alpha: 0.35 }).stroke({ width: 2, color: "#7a5a36", alpha: 0.9 });
				for (const [px, py] of [[x + 3, y + 3], [x + w - 7, y + 3], [x + 3, y + h - 7], [x + w - 7, y + h - 7]] as const) g.rect(px, py, 4, 4).fill({ color: "#5b3a22" });
				g.rect(x + 6, y + h - 10, (w - 12) * Math.min(1, o.progress ?? 0), 4).fill({ color: "#AED83C" });
			}
			const label = new p.Text({ text: o.kind === "site" ? `Baustelle ${o.name}` : `${o.name} von ${o.owner ?? ""}`, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#f0e6d2", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(x + w / 2, y + h);
			s.objs.addChild(g, label);
			continue;
		}
		if (o.kind === "exit") {
			const g = new p.Graphics().rect(x + 2, y + 2, ts - 4, ts - 4).fill({ color: "#AED83C", alpha: 0.22 }).stroke({ width: 2, color: "#AED83C" });
			const label = new p.Text({ text: o.name, resolution: TEXT_RES, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#AED83C", stroke: { color: "#000000", width: 3 } } });
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
		sp.label.text = c.ai ? `${c.name} (KI)` : c.name; // a model plays it: always marked
	}
	s.fogDirty = true;
}
