"use client";
// Optional Three.js view of the same authoritative 2D room as MapView. Heights, lighting and decoration are visual
// only; clicks are converted back to integer grid cells and every action still goes through a server command.
//
// The renderer, camera and render loop are made once; a room change swaps only the ground and its things. The camera looks
// at the middle of the room and stays there (it moves only when the player turns or zooms the view), so a step moves the
// figure and nothing else: no sliding ground, no rebuilt scene.
import { useEffect, useRef, useState } from "react";
import type { CharView, ObjView } from "../server/gateway.ts";
import { animateFigure, makeFigure, type Figure } from "./figure3d.ts";
import type { MapRendererProps } from "./MapRenderer.tsx";
import { tile3d } from "./terrain3d.ts";
import { loadTileLooks, type TileLook } from "./tiles3d.ts";

type T = typeof import("three");
type O3 = import("three").Object3D;
type Entry = { obj: O3; target: import("three").Vector3; fig?: Figure; flame?: { light: import("three").PointLight; cone: O3 } };
type Scene3D = {
	t: T;
	renderer: import("three").WebGLRenderer;
	scene: import("three").Scene;
	camera: import("three").PerspectiveCamera;
	fog: import("three").FogExp2;
	host: HTMLDivElement;
	canvas: HTMLCanvasElement;
	room: MapRendererProps["room"];
	world: MapRendererProps["world"];
	ground: import("three").Group | null;
	water: Array<{ material: import("three").MeshStandardMaterial; look: TileLook }>;
	chars: Map<string, Entry>;
	objs: Map<string, Entry>;
	angle: number;
	zoom: number;
	/** the distance of the camera to the middle of the room, and the fog level: together they give the fog's density */
	dist: number;
	level: number;
	size: { w: number; h: number };
	frame: number;
	resize: ResizeObserver;
};

const LONG_PRESS_MS = 500;
const DRAG_PX = 8;
const ZOOM_MIN = 0.5, ZOOM_MAX = 3;
const ELEVATION = (52 * Math.PI) / 180;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export function MapView3D(props: MapRendererProps) {
	const host = useRef<HTMLDivElement>(null);
	const state = useRef<Scene3D | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const [ready, setReady] = useState(false);
	// what the mouse does to the view: the wheel zooms, dragging turns (the pointer code reads these through a ref)
	const view = useRef({ zoomBy: (_f: number) => {}, turned: (_a: number) => {} });
	const [angle, setAngle] = useState(() => stored("mmo.3d.angle", Math.PI / 4));
	const [zoom, setZoom] = useState(() => stored("mmo.3d.zoom", 1));
	view.current = { zoomBy: (f) => setZoom((z) => clamp(z * f, ZOOM_MIN, ZOOM_MAX)), turned: (a) => setAngle(a) };

	// once: the renderer, the lights, the camera and the loop
	useEffect(() => {
		let dead = false;
		void (async () => {
			try {
				const t = await import("three");
				if (dead || !host.current) return;
				const renderer = new t.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
				renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
				renderer.outputColorSpace = t.SRGBColorSpace;
				renderer.setClearColor(0x10171c, 1);
				renderer.domElement.addEventListener("contextmenu", prevent);
				host.current.querySelector(".map-canvas")?.replaceChildren(renderer.domElement);

				const scene = new t.Scene();
				const fog = new t.FogExp2(0xb8c1c7, 0); scene.fog = fog;
				const camera = new t.PerspectiveCamera(38, 1, 0.1, 160);
				scene.add(new t.HemisphereLight(0xd9edff, 0x3a4a2a, 1.7));
				const sun = new t.DirectionalLight(0xfff1cf, 2.2);
				sun.position.set(-6, 12, 8); scene.add(sun);

				const s: Scene3D = { t, renderer, scene, camera, fog, host: host.current, canvas: renderer.domElement, room: props.room, world: props.world, ground: null, water: [], chars: new Map(), objs: new Map(), angle: stored("mmo.3d.angle", Math.PI / 4), zoom: stored("mmo.3d.zoom", 1), dist: 30, level: 0, size: { w: 0, h: 0 }, frame: 0, resize: null as unknown as ResizeObserver };
				s.resize = new ResizeObserver(() => resize(s));
				s.resize.observe(host.current);
				pointer(s, latest, view);
				state.current = s;
				resize(s);

				let before = performance.now();
				const frame = (now: number) => {
					if (dead) return;
					const dt = Math.min(0.05, (now - before) / 1000); before = now;
					step(s, dt, now / 1000, latest.current.me);
					s.renderer.render(s.scene, s.camera);
					s.frame = requestAnimationFrame(frame);
				};
				s.frame = requestAnimationFrame(frame);
				setReady(true);
			} catch (e) {
				if (!dead) latest.current.onFail(`3D konnte nicht gestartet werden (${(e as Error).message || "WebGL nicht verfügbar"}).`);
			}
		})();
		return () => {
			dead = true;
			const s = state.current;
			if (!s) return;
			cancelAnimationFrame(s.frame); s.resize.disconnect(); unpointer(s); dispose(s.scene); s.renderer.dispose(); s.canvas.remove(); state.current = null;
		};
	}, []);

	// per room: the ground and the things on it; the renderer and the camera stay
	useEffect(() => {
		const s = state.current;
		if (!ready || !s) return;
		let dead = false;
		s.room = props.room; s.world = props.world;
		for (const m of [s.chars, s.objs]) for (const id of [...m.keys()]) remove(s, m, id);
		void (async () => {
			let looks = new Map<string, TileLook>();
			try { looks = await loadTileLooks(s.t, props.world, s.renderer.capabilities.getMaxAnisotropy()); } catch { /* flat colours */ }
			if (dead || state.current !== s) return;
			if (s.ground) { s.scene.remove(s.ground); dispose(s.ground); }
			s.water = [];
			s.ground = buildTerrain(s, looks);
			s.scene.add(s.ground);
			sync(s, latest.current.chars, latest.current.objs, latest.current.me, true);
			resize(s);
		})();
		return () => { dead = true; };
	}, [ready, props.room.roomId, props.world.id]);

	useEffect(() => { if (state.current) sync(state.current, props.chars, props.objs, props.me, false); }, [props.chars, props.objs, props.me]);
	useEffect(() => { if (state.current) applyFog(state.current, props.fog); }, [props.fog, ready]);
	useEffect(() => {
		store("mmo.3d.angle", angle); store("mmo.3d.zoom", zoom);
		if (state.current) { state.current.angle = angle; state.current.zoom = zoom; positionCamera(state.current); }
	}, [angle, zoom, ready]);

	return (
		<div className="map map-3d" ref={host}>
			<div className="map-canvas" />
			<div className="map-zoom map-3d-controls" role="group" aria-label="3D-Ansicht">
				<button onClick={() => setAngle((a) => a - Math.PI / 4)} aria-label="Karte links drehen">↶</button>
				<button onClick={() => setAngle((a) => a + Math.PI / 4)} aria-label="Karte rechts drehen">↷</button>
				<button onClick={() => setZoom((z) => clamp(z + 0.2, ZOOM_MIN, ZOOM_MAX))} aria-label="Vergrößern">+</button>
				<button onClick={() => setZoom((z) => clamp(z - 0.2, ZOOM_MIN, ZOOM_MAX))} aria-label="Verkleinern">−</button>
			</div>
			<span className="map-mode-label">3D · Darstellung, Spielregeln bleiben 2D</span>
		</div>
	);
}

const dims = (room: MapRendererProps["room"]) => ({ w: room.ground[0]?.length ?? 0, h: room.ground.length });

/** The ground: one instanced box per tile kind, the tile art on top, plain earth on the sides. Boxes touch (no seams). */
function buildTerrain(s: Scene3D, looks: Map<string, TileLook>): import("three").Group {
	const { t, room, world } = s, { w, h } = dims(room);
	const group = new t.Group(); group.userData.owned = true;
	const byTile = new Map<string, Array<{ x: number; y: number }>>();
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = room.ground[y]![x]!; const a = byTile.get(k) ?? []; a.push({ x, y }); byTile.set(k, a); }
	const geometry = new t.BoxGeometry(1, 1, 1);
	for (const [key, cells] of byTile) {
		const visual = tile3d(key, !!world.tiles[key]?.walk), look = looks.get(key);
		const top = new t.MeshStandardMaterial({ color: look ? 0xffffff : visual.color, map: look?.frames[0] ?? null, roughness: visual.water ? 0.3 : 0.95, metalness: visual.water ? 0.1 : 0 });
		const side = new t.MeshStandardMaterial({ color: new t.Color(visual.color).multiplyScalar(visual.water ? 0.6 : 0.72), roughness: 1 });
		const mesh = new t.InstancedMesh(geometry, [side, side, top, side, side, side], cells.length);
		const matrix = new t.Matrix4();
		cells.forEach((c, i) => {
			const height = surface(room, world, c.x, c.y);
			matrix.compose(new t.Vector3(c.x - w / 2 + 0.5, height / 2, c.y - h / 2 + 0.5), new t.Quaternion(), new t.Vector3(1, Math.max(0.04, height), 1));
			mesh.setMatrixAt(i, matrix);
		});
		mesh.instanceMatrix.needsUpdate = true; group.add(mesh);
		if (look && look.frames.length > 1) s.water.push({ material: top, look });
	}
	return group;
}

/** Every frame: the water moves, figures and things glide to their cell and the figures walk; the camera does not follow. */
function step(s: Scene3D, dt: number, time: number, me: string): void {
	for (const w of s.water) w.material.map = w.look.frames[Math.floor((time * 1000) / w.look.frameMs) % w.look.frames.length]!;
	const k = 1 - Math.exp(-12 * dt);
	for (const [id, e] of s.chars) {
		const x0 = e.obj.position.x, z0 = e.obj.position.z;
		e.obj.position.lerp(e.target, id === me ? k : k * 0.9);
		if (e.fig) animateFigure(e.fig, e.obj.position.x - x0, e.obj.position.z - z0, dt, time);
	}
	for (const e of s.objs.values()) {
		e.obj.position.lerp(e.target, k);
		if (e.flame) { const on = e.flame.light.userData.lit as boolean; e.flame.cone.visible = on; e.flame.cone.scale.y = on ? 1 + Math.sin(time * 9 + e.obj.id) * 0.07 : 1; }
	}
}

function sync(s: Scene3D, chars: Map<string, CharView>, objs: Map<string, ObjView>, me: string, snap: boolean): void {
	if (!s.ground) return; // the room's ground is not built yet: the build calls this when it is
	for (const id of [...s.chars.keys()]) if (!chars.has(id)) remove(s, s.chars, id);
	for (const [id, c] of chars) {
		let e = s.chars.get(id);
		if (!e) {
			const fig = makeFigure(s.t, { id, skin: c.skin, own: id === me, ai: !!c.ai });
			fig.group.add(label(s.t, c.name, id === me ? "#dfff73" : c.ai ? "#9fd3ff" : "#ffffff"));
			e = { obj: fig.group, target: at(s, c.x, c.y, 0), fig }; e.obj.position.copy(e.target); s.scene.add(e.obj); s.chars.set(id, e);
		}
		e.target.copy(at(s, c.x, c.y, 0));
		if (snap) e.obj.position.copy(e.target);
	}
	for (const id of [...s.objs.keys()]) if (!objs.has(id) || objs.get(id)?.location !== s.room.roomId) remove(s, s.objs, id);
	for (const [id, obj] of objs) {
		if (obj.location !== s.room.roomId) continue;
		let e = s.objs.get(id);
		if (!e) { e = object(s.t, obj); e.target.copy(at(s, obj.x, obj.y, 0)); e.obj.position.copy(e.target); s.scene.add(e.obj); s.objs.set(id, e); }
		e.target.copy(at(s, obj.x, obj.y, 0));
		if (e.flame) { const lit = (obj.until ?? 0) > Date.now(); e.flame.light.userData.lit = lit; e.flame.light.intensity = lit ? 4 : 0; }
	}
}

function object(t: T, obj: ObjView): Entry {
	const group = new t.Group(); group.userData.owned = true;
	const e: Entry = { obj: group, target: new t.Vector3() };
	if (obj.kind === "beacon") {
		const bowl = new t.Mesh(new t.CylinderGeometry(0.2, 0.28, 0.3, 10), new t.MeshStandardMaterial({ color: 0x6e4a2b, roughness: 1 })); bowl.position.y = 0.15; group.add(bowl);
		const cone = new t.Mesh(new t.ConeGeometry(0.17, 0.5, 10), new t.MeshStandardMaterial({ color: 0xffa23a, emissive: 0xff7a14, emissiveIntensity: 1.6, transparent: true, opacity: 0.92 })); cone.position.y = 0.55; group.add(cone);
		const light = new t.PointLight(0xff9d32, 0, 4); light.position.y = 0.8; group.add(light);
		e.flame = { light, cone };
	} else if (obj.kind === "exit") {
		const ring = new t.Mesh(new t.TorusGeometry(0.2, 0.055, 8, 18), new t.MeshStandardMaterial({ color: 0x91b8d0 })); ring.position.y = 0.2; ring.rotation.x = Math.PI / 2; group.add(ring);
	} else {
		const rock = new t.Mesh(new t.DodecahedronGeometry(0.15), new t.MeshStandardMaterial({ color: Number.parseInt(obj.glyph?.color.slice(1) ?? "b9c26d", 16), roughness: 0.85 })); rock.position.y = 0.16; group.add(rock);
	}
	return e;
}

function label(t: T, text: string, color: string): import("three").Sprite {
	const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!;
	canvas.width = 256; canvas.height = 48; ctx.font = "600 22px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
	ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.strokeText(text.slice(0, 24), 128, 24); ctx.fillStyle = color; ctx.fillText(text.slice(0, 24), 128, 24);
	const texture = new t.CanvasTexture(canvas); texture.colorSpace = t.SRGBColorSpace;
	const sprite = new t.Sprite(new t.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
	sprite.position.y = 1.4; sprite.scale.set(1.8, 0.34, 1); sprite.renderOrder = 10; return sprite;
}

/** The visual height of a cell: the tile's own height. (terrain3d's small per-cell variation is left out here: even a
 *  hundredth of a unit between neighbours shows as a dark seam between the tiles.) */
function surface(room: MapRendererProps["room"], world: MapRendererProps["world"], x: number, y: number): number {
	const key = room.ground[y]?.[x] ?? "";
	return tile3d(key, !!world.tiles[key]?.walk).height;
}

/** The world position of a cell, standing on its ground. */
function at(s: Scene3D, x: number, y: number, above: number): import("three").Vector3 {
	const { w, h } = dims(s.room);
	return new s.t.Vector3(x - w / 2 + 0.5, surface(s.room, s.world, x, y) + above, y - h / 2 + 0.5);
}

/** The camera looks at the middle of the room from a distance that shows all of it; only turning and zooming move it. */
function positionCamera(s: Scene3D): void {
	const { w, h } = dims(s.room), aspect = s.camera.aspect || 1;
	const radius = Math.hypot(w, h) / 2;
	const half = Math.min(Math.atan(Math.tan((s.camera.fov * Math.PI) / 360) * aspect), (s.camera.fov * Math.PI) / 360);
	const d = (radius / Math.sin(half)) * 0.74 / s.zoom;
	s.camera.position.set(Math.cos(s.angle) * Math.cos(ELEVATION) * d, 0.2 + Math.sin(ELEVATION) * d, Math.sin(s.angle) * Math.cos(ELEVATION) * d);
	s.camera.lookAt(0, 0.2, 0);
	s.dist = d; applyFog(s, s.level);
}
/** How much of the middle of the room the fog hides, by level (the haze at the camera's distance): 0, 20 %, 35 %, 50 %.
 *  FogExp2 hides 1 − e^−(density·distance)², so the density follows from the distance: a fixed density would drown the
 *  whole room in grey as soon as the camera has to stand far enough away to show all of it. */
const FOG_HIDES = [0, 0.2, 0.35, 0.5];
function applyFog(s: Scene3D, level: number): void {
	s.level = clamp(level, 0, 3);
	const hides = FOG_HIDES[s.level]!;
	s.fog.density = hides > 0 ? Math.sqrt(-Math.log(1 - hides)) / Math.max(1, s.dist) : 0;
}
/** Sets the drawing size only when it really changed: setSize clears the picture, and a clear that nothing needs is a flicker. */
function resize(s: Scene3D): void {
	const box = s.host.getBoundingClientRect(), w = Math.max(1, Math.round(box.width)), h = Math.max(260, Math.round(box.height || box.width * 0.62));
	if (w !== s.size.w || h !== s.size.h) { s.size = { w, h }; s.renderer.setSize(w, h, false); s.camera.aspect = w / h; s.camera.updateProjectionMatrix(); }
	positionCamera(s);
}

function pointer(s: Scene3D, latest: { current: MapRendererProps }, view: { current: { zoomBy: (f: number) => void; turned: (angle: number) => void } }): void {
	const t = s.t, ray = new t.Raycaster(), mouse = new t.Vector2(), plane = new t.Plane(new t.Vector3(0, 1, 0), -0.25), hit = new t.Vector3();
	const cell = (e: PointerEvent) => {
		const r = s.canvas.getBoundingClientRect(); mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(mouse, s.camera);
		if (!ray.ray.intersectPlane(plane, hit)) return null;
		const { w, h } = dims(s.room), x = Math.floor(hit.x + w / 2), y = Math.floor(hit.z + h / 2);
		return x >= 0 && y >= 0 && x < w && y < h ? { x, y } : null;
	};
	let down: { x: number; y: number; at: { x: number; y: number } | null; long: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
	const onDown = (e: PointerEvent) => { if (e.button === 2) return; const at = cell(e); down = { x: e.clientX, y: e.clientY, at, long: false, timer: setTimeout(() => { if (down?.at) { down.long = true; latest.current.onMenu(down.at.x, down.at.y, e.clientX, e.clientY); } }, LONG_PRESS_MS) }; };
	// dragging turns the view: left and right around the room (the camera follows the pointer live, the state is set when the pointer is lifted)
	let last = 0, dragged = false;
	const onMove = (e: PointerEvent) => {
		if (!down) return;
		if (!dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) { dragged = true; clearTimeout(down.timer); down.at = null; last = down.x; s.canvas.setPointerCapture?.(e.pointerId); }
		if (!dragged) return;
		s.angle -= (e.clientX - last) * 0.008; last = e.clientX;
		positionCamera(s);
	};
	const onUp = () => { if (!down) return; clearTimeout(down.timer); if (down.at && !down.long) latest.current.onCell(down.at.x, down.at.y); if (dragged) view.current.turned(s.angle); dragged = false; down = null; };
	const onWheel = (e: WheelEvent) => { e.preventDefault(); view.current.zoomBy(Math.exp(-Math.sign(e.deltaY) * 0.12)); };
	const onContext = (e: MouseEvent) => { e.preventDefault(); const at = cell(e as PointerEvent); if (at) latest.current.onMenu(at.x, at.y, e.clientX, e.clientY); };
	Object.assign(s.canvas.dataset, { map3d: "1" }); s.canvas.addEventListener("pointerdown", onDown); s.canvas.addEventListener("pointermove", onMove); s.canvas.addEventListener("pointerup", onUp); s.canvas.addEventListener("pointercancel", onUp); s.canvas.addEventListener("contextmenu", onContext); s.canvas.addEventListener("wheel", onWheel, { passive: false });
	(s.canvas as HTMLCanvasElement & { mapCleanup?: () => void }).mapCleanup = () => { s.canvas.removeEventListener("pointerdown", onDown); s.canvas.removeEventListener("pointermove", onMove); s.canvas.removeEventListener("pointerup", onUp); s.canvas.removeEventListener("pointercancel", onUp); s.canvas.removeEventListener("contextmenu", onContext); s.canvas.removeEventListener("wheel", onWheel); };
}
function unpointer(s: Scene3D): void { (s.canvas as HTMLCanvasElement & { mapCleanup?: () => void }).mapCleanup?.(); }
function prevent(e: Event): void { e.preventDefault(); }
function stored(key: string, fallback: number): number { try { const raw = localStorage.getItem(key); if (raw === null) return fallback; const n = Number(raw); return Number.isFinite(n) ? n : fallback; } catch { return fallback; } }
function store(key: string, value: number): void { try { localStorage.setItem(key, String(value)); } catch { /* private window */ } }
function remove(s: Scene3D, map: Map<string, Entry>, id: string): void { const e = map.get(id); if (e) { s.scene.remove(e.obj); dispose(e.obj); } map.delete(id); }
/** Frees what the 3D object made; the textures shared between rooms (tile art, the shadow) live on. */
function dispose(root: O3): void {
	root.traverse((o) => {
		const m = o as import("three").Mesh;
		m.geometry?.dispose?.();
		const materials = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
		for (const material of materials) { const mm = material as import("three").MeshStandardMaterial; if (mm.map && !mm.map.userData.shared) mm.map.dispose(); material.dispose(); }
	});
}
