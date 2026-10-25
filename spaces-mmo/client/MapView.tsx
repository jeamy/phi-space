"use client";
// The tile map of the current room, drawn with PixiJS (docs/architektur.md, "Grafik"). React owns the frame; PixiJS
// only the canvas: the ground once per room, exits and things on it, then one sprite per online character, updated from the frames the
// gateway sends. A tap on a cell is handed to `onCell`, which turns it into a text command; the map never changes the
// world by itself. pixi.js is imported in the browser only.
import { useEffect, useRef } from "react";
import type { CharView, ObjView, ServerFrame } from "../server/gateway.ts";

type Hello = Extract<ServerFrame, { t: "hello" }>;
type Pixi = typeof import("pixi.js");
type Scene = { pixi: Pixi; chars: import("pixi.js").Container; objs: import("pixi.js").Container; fog: import("pixi.js").Graphics; size: { w: number; h: number }; skins: import("pixi.js").Texture[]; frames: Map<string, import("pixi.js").Texture>; sprites: Map<string, { body: import("pixi.js").Sprite; label: import("pixi.js").Text; x: number; y: number; row: number }> };

const ROW = { down: 0, left: 1, right: 2, up: 3 } as const;

export function MapView({ world, room, chars, objs, me, fog, onCell }: { world: Hello["world"]; room: Hello["room"]; chars: Map<string, CharView>; objs: Map<string, ObjView>; me: string; fog: number; onCell: (x: number, y: number) => void }) {
	const host = useRef<HTMLDivElement>(null);
	const scene = useRef<Scene | null>(null);
	const latest = useRef({ chars, objs, me, fog, onCell });
	latest.current = { chars, objs, me, fog, onCell };

	// the ground: built again when the room changes
	useEffect(() => {
		let dead = false;
		let app: import("pixi.js").Application | null = null;
		const ts = world.tileSize, w = room.ground[0]!.length, h = room.ground.length;
		void (async () => {
			const pixi = await import("pixi.js");
			const a = new pixi.Application();
			await a.init({ width: w * ts, height: h * ts, background: "#0b1016", antialias: false, resolution: Math.max(1, Math.round(window.devicePixelRatio || 1)), autoDensity: true });
			if (dead) { a.destroy(true, { children: true }); return; }
			app = a;
			// autoDensity sets the CSS size inline; the stylesheet scales the canvas to its frame instead (pointer events
			// follow, PixiJS maps them through the element's box)
			a.canvas.style.width = "100%";
			a.canvas.style.height = "auto";
			host.current?.replaceChildren(a.canvas);
			a.canvas.setAttribute("aria-label", `Karte: ${room.name}`);
			const load = async (sheet: string) => {
				const t = await pixi.Assets.load<import("pixi.js").Texture>(`/assets/${world.id}/${sheet}`);
				t.source.scaleMode = "nearest";
				return t;
			};
			const sheets = new Map<string, import("pixi.js").Texture>();
			for (const t of Object.values(world.tiles)) if (!sheets.has(t.sheet)) sheets.set(t.sheet, await load(t.sheet));
			const skins = await Promise.all(world.skins.map((s) => load(s.sheet)));
			if (dead) return;
			const ground = new pixi.Container();
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const t = world.tiles[room.ground[y]![x]!]!;
				const s = new pixi.Sprite(new pixi.Texture({ source: sheets.get(t.sheet)!.source, frame: new pixi.Rectangle(t.x, t.y, ts, ts) }));
				s.position.set(x * ts, y * ts);
				ground.addChild(s);
			}
			const objLayer = new pixi.Container();
			const charLayer = new pixi.Container();
			charLayer.sortableChildren = true;
			const fogLayer = new pixi.Graphics();
			fogLayer.eventMode = "none";
			a.stage.addChild(ground, objLayer, charLayer, fogLayer);
			a.stage.eventMode = "static";
			a.stage.hitArea = a.screen;
			a.stage.on("pointertap", (e) => {
				const p = e.getLocalPosition(a.stage);
				const x = Math.floor(p.x / ts), y = Math.floor(p.y / ts);
				if (x >= 0 && y >= 0 && x < w && y < h) latest.current.onCell(x, y);
			});
			scene.current = { pixi, chars: charLayer, objs: objLayer, fog: fogLayer, size: { w: w * ts, h: h * ts }, skins, frames: new Map(), sprites: new Map() };
			draw(scene.current, world, latest.current.chars, latest.current.me);
			drawObjs(scene.current, world, room.roomId, latest.current.objs);
			drawFog(scene.current, latest.current.fog);
		})();
		return () => {
			dead = true;
			scene.current = null;
			app?.destroy(true, { children: true });
		};
	}, [world, room]);

	// the characters: every change of the map of online characters
	useEffect(() => { if (scene.current) draw(scene.current, world, chars, me); }, [world, chars, me]);
	// things and exits: few per room, drawn again on every change
	useEffect(() => { if (scene.current) drawObjs(scene.current, world, room.roomId, objs); }, [world, room, objs]);
	// the fog of the room as a veil over everything
	useEffect(() => { if (scene.current) drawFog(scene.current, fog); }, [fog]);

	return <div className="map" ref={host} />;
}

/** Exits as marked cells with their name, things lying in the room as glyphs (no item graphics are licensed yet). */
function drawObjs(s: Scene, world: Hello["world"], roomId: string, objs: Map<string, ObjView>): void {
	const ts = world.tileSize, p = s.pixi;
	for (const child of s.objs.removeChildren()) child.destroy({ children: true });
	for (const o of objs.values()) {
		if (o.location !== roomId) continue;
		const x = o.x * ts, y = o.y * ts, cx = x + ts / 2, cy = y + ts / 2;
		if (o.kind === "beacon") {
			// a fire that burns: flames in a ring; one that is out: a cold, dark ring
			const lit = (o.until ?? 0) > Date.now();
			const g = new p.Graphics().circle(cx, cy, 13).fill({ color: lit ? "#3a2412" : "#2b2f33" }).stroke({ width: 2, color: lit ? "#8a5a2b" : "#5a6068" });
			if (lit) g.circle(cx, cy, 9).fill({ color: "#f08a24" }).circle(cx, cy + 2, 5).fill({ color: "#ffd84a" });
			const label = new p.Text({ text: o.name, style: { fontFamily: "sans-serif", fontSize: 10, fill: lit ? "#ffd84a" : "#c0c6cc", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(cx, y + ts);
			s.objs.addChild(g, label);
			continue;
		}
		if (o.kind === "exit") {
			const g = new p.Graphics().rect(x + 2, y + 2, ts - 4, ts - 4).fill({ color: "#AED83C", alpha: 0.22 }).stroke({ width: 2, color: "#AED83C" });
			const label = new p.Text({ text: o.name, style: { fontFamily: "sans-serif", fontSize: 10, fill: "#AED83C", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 0);
			label.position.set(cx, y + ts);
			s.objs.addChild(g, label);
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

/** Fog levels 1..3 as a growing grey veil (0: none). */
function drawFog(s: Scene, level: number): void {
	s.fog.clear();
	const alpha = [0, 0.22, 0.42, 0.62][Math.max(0, Math.min(3, level))]!;
	if (alpha) s.fog.rect(0, 0, s.size.w, s.size.h).fill({ color: "#c9d2da", alpha });
}

/** Brings the sprites in line with `chars`: new ones appear, gone ones are removed, moved ones face the way they went. */
function draw(s: Scene, world: Hello["world"], chars: Map<string, CharView>, me: string): void {
	const ts = world.tileSize;
	for (const [id, sp] of s.sprites) if (!chars.has(id)) { sp.body.destroy(); sp.label.destroy(); s.sprites.delete(id); }
	for (const c of chars.values()) {
		const skin = world.skins[c.skin % world.skins.length]!, tex = s.skins[c.skin % s.skins.length]!;
		let sp = s.sprites.get(c.charId);
		const row = !sp ? ROW.down : c.x > sp.x ? ROW.right : c.x < sp.x ? ROW.left : c.y < sp.y ? ROW.up : c.y > sp.y ? ROW.down : sp.row;
		if (!sp) {
			const body = new s.pixi.Sprite();
			const label = new s.pixi.Text({ text: c.name, style: { fontFamily: "sans-serif", fontSize: 11, fill: c.charId === me ? "#AED83C" : "#ffffff", stroke: { color: "#000000", width: 3 } } });
			label.anchor.set(0.5, 1);
			s.chars.addChild(body, label);
			sp = { body, label, x: c.x, y: c.y, row };
			s.sprites.set(c.charId, sp);
		}
		const key = `${c.skin % s.skins.length}:${row}`;
		let frame = s.frames.get(key);
		if (!frame) { frame = new s.pixi.Texture({ source: tex.source, frame: new s.pixi.Rectangle(0, row * skin.frameH, skin.frameW, skin.frameH) }); s.frames.set(key, frame); }
		sp.body.texture = frame;
		sp.body.position.set(c.x * ts + (ts - skin.frameW) / 2, c.y * ts + ts - skin.frameH);
		sp.body.zIndex = c.y * 2;
		sp.label.text = c.name;
		sp.label.position.set(c.x * ts + ts / 2, c.y * ts + ts - skin.frameH);
		sp.label.zIndex = c.y * 2 + 1;
		Object.assign(sp, { x: c.x, y: c.y, row });
	}
}
