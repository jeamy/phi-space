"use client";
// The tile map of the current room, drawn with PixiJS (docs/architektur.md, "Grafik"). React owns the frame; PixiJS
// only the canvas: the ground once per room, then one sprite per online character, updated from the frames the
// gateway sends. A tap on a cell is handed to `onCell`, which turns it into a text command; the map never changes the
// world by itself. pixi.js is imported in the browser only.
import { useEffect, useRef } from "react";
import type { CharView, ServerFrame } from "../server/gateway.ts";

type Hello = Extract<ServerFrame, { t: "hello" }>;
type Pixi = typeof import("pixi.js");
type Scene = { pixi: Pixi; chars: import("pixi.js").Container; skins: import("pixi.js").Texture[]; frames: Map<string, import("pixi.js").Texture>; sprites: Map<string, { body: import("pixi.js").Sprite; label: import("pixi.js").Text; x: number; y: number; row: number }> };

const ROW = { down: 0, left: 1, right: 2, up: 3 } as const;

export function MapView({ world, room, chars, me, onCell }: { world: Hello["world"]; room: Hello["room"]; chars: Map<string, CharView>; me: string; onCell: (x: number, y: number) => void }) {
	const host = useRef<HTMLDivElement>(null);
	const scene = useRef<Scene | null>(null);
	const latest = useRef({ chars, me, onCell });
	latest.current = { chars, me, onCell };

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
			const charLayer = new pixi.Container();
			charLayer.sortableChildren = true;
			a.stage.addChild(ground, charLayer);
			a.stage.eventMode = "static";
			a.stage.hitArea = a.screen;
			a.stage.on("pointertap", (e) => {
				const p = e.getLocalPosition(a.stage);
				const x = Math.floor(p.x / ts), y = Math.floor(p.y / ts);
				if (x >= 0 && y >= 0 && x < w && y < h) latest.current.onCell(x, y);
			});
			scene.current = { pixi, chars: charLayer, skins, frames: new Map(), sprites: new Map() };
			draw(scene.current, world, latest.current.chars, latest.current.me);
		})();
		return () => {
			dead = true;
			scene.current = null;
			app?.destroy(true, { children: true });
		};
	}, [world, room]);

	// the characters: every change of the map of online characters
	useEffect(() => { if (scene.current) draw(scene.current, world, chars, me); }, [world, chars, me]);

	return <div className="map" ref={host} />;
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
