"use client";
// Optional Three.js view of the same authoritative 2D room as MapView. Heights, lighting and decoration are visual
// only; clicks are converted back to integer grid cells and every action still goes through a server command.
//
// The renderer, camera and render loop are made once; a room change swaps only the ground and its things. The camera looks
// at the middle of the room and stays there (it moves only when the player drags, turns or zooms the view), so a step moves
// the figure and nothing else: no sliding ground, no rebuilt scene.
import { useEffect, useRef, useState } from "react";
import type { AtlasState, AtlasView, CharView, ObjView } from "../server/gateway.ts";
import { animateFigure, makeFigure, type Figure } from "./figure3d.ts";
import type { MapRendererProps } from "./MapRenderer.tsx";
import { pinch } from "./pinch.ts";
import { tr } from "./i18n/index.ts";
import { buildingModel, linerGeometry, sceneryModel } from "./buildings3d.ts";
import { buildingGeometry, cropGeometry, fenceGeometry, fieldCropGeometry, fireGeometry, jettyGeometry, keeperGeometry, PLANT_VARIANTS, placeLook, plantGeometry, prepareModelDetails, propMaterial, propMesh, propShadow, setNight, ruinGeometry, signGeometry, siteGeometry, wildGeometry, type PlantModel } from "./props3d.ts";
import { railPoints, sleeperSpots, stepsAt } from "./trackShape.ts";
import { closeBlur, detailCells, frameSummary } from "./closeup3d.ts";
import { START_VIEW } from "./viewPreferences.ts";
import { atModelLevel, updateModelDetails, type ModelLevel } from "./modelDetail3d.ts";
import { stableHash, tile3d } from "./terrain3d.ts";
import { cameraElevation, clampTilt, clampZoom, daylightAt, wheelView, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "./camera3d.ts";
import { calendar, shownWorldMs, WORLD_HOUR_MS } from "../server/engine/worldtime.ts";
import { fishItem, fishModel, type FishKind } from "./fish3d.ts";
import { blockUnder, fishFor, islandBlock, nameCard, swimFish, type Fish, type SeaEdge } from "./block3d.ts";
import { loadDecorLooks, loadTileLooks, type TileLook } from "./tiles3d.ts";

type T = typeof import("three");
type O3 = import("three").Object3D;
type Entry = { obj: O3; target: import("three").Vector3; fig?: Figure; flame?: { light: import("three").PointLight; cone: O3 }; kind?: string; progress?: number; sig?: string; /** The name on a figure. */ shown?: string };
/** What a bed shows: rebuilt when its plants or weeds change. */
const bedSig = (o: ObjView) => (o.kind === "track" ? (o.runs ?? []).map((r) => r.map((c) => `${c.x},${c.y}`).join(" ")).join("|") : o.kind === "bed" ? `${o.weedy ? 1 : 0}${o.fenced ? "f" : ""}|${(o.plants ?? []).map((p) => `${p.x},${p.y},${p.stage},${p.color}`).join(";")}` : o.kind === "field" ? `${o.fieldStage}|${o.cropModel ?? ""}|${o.color ?? ""}${o.fenced ? "f" : ""}` : o.kind === "building" && (o.herd || o.keeper || o.fenced) ? `${o.herd ?? ""}|${o.keeper ?? ""}|${o.fenced ? "f" : ""}` : undefined);
type Scene3D = {
	t: T;
	renderer: import("three").WebGLRenderer;
	post: ReturnType<typeof import("./closeuppost3d.ts").createClosePost>;
	measurement: { at: number; times: number[]; calls: number[]; zooms: number[]; remaining: number } | null;
	detailAt: number;
	catalogue?: boolean;
	scene: import("three").Scene;
	camera: import("three").PerspectiveCamera;
	fog: import("three").FogExp2;
	/** the sun: its shadow map is fitted to the room (lightRoom) */
	sun: import("three").DirectionalLight;
	/** the sky's light, dimmed with the sun at night (daylight) */
	hemi: import("three").HemisphereLight;
	/** the daylight last applied (1 day, 0 night) and when it was last worked out */
	light: number;
	lightAt: number;
	/** the fish behind the room's sea sides (block3d.ts) */
	fish: Fish[];
	/** dev only: a world hour that overrides the clock for the light (probeHour) */
	hourProbe?: number | null;
	host: HTMLDivElement;
	canvas: HTMLCanvasElement;
	room: MapRendererProps["room"];
	world: MapRendererProps["world"];
	ground: import("three").Group | null;
	/** the other rooms of the island as blocks round this one, and what they were built for */
	island: import("three").Group | null;
	islandFor: string;
	/** the middle of the island and how far its blocks reach from it: the camera turns to it on the island level */
	islandMid: { x: number; z: number; reach: number };
	/** whether the names of figures and things show (not on the island level) */
	named: boolean;
	/** the speech bubbles over figures: who, the sprite, when it goes */
	bubbles: Map<string, { sprite: import("three").Sprite; until: number; key: string }>;
	/** the plants on the ground (built again when a building, site, ruin or bed comes onto them or goes), their pictures,
	 *  and the covered cells they were built for */
	plants: import("three").Group | null;
	plantLooks: Map<string, import("three").Texture>;
	plantsFor: string;
	water: Array<{ material: import("three").MeshStandardMaterial; look: TileLook }>;
	paving: import("three").InstancedMesh | null;
	pavingFor: string;
	chars: Map<string, Entry>;
	objs: Map<string, Entry>;
	angle: number;
	zoom: number;
	tilt: number;
	/** how far the player dragged the view from the middle of the room, on the ground (world x and z) */
	panX: number;
	panZ: number;
	/** the distance of the camera to the middle of the room, and the fog level: together they give the fog's density */
	dist: number;
	level: number;
	size: { w: number; h: number };
	frame: number;
	resize: ResizeObserver;
};

const LONG_PRESS_MS = 500;
const DRAG_PX = 12;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export function MapView3D(props: MapRendererProps) {
	const host = useRef<HTMLDivElement>(null);
	const state = useRef<Scene3D | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const [ready, setReady] = useState(false);
	const [measuring, setMeasuring] = useState(false);
	const [remaining, setRemaining] = useState(32);
	const [measurementNote, setMeasurementNote] = useState("");
	const [report, setReport] = useState<(ReturnType<typeof frameSummary> & { zoom: number[]; viewport: number[]; userAgent: string }) | null>(null);
	// what the mouse and fingers do to the view: the wheel and a pinch zoom, dragging turns (the pointer code reads these through a ref)
	const view = useRef({ zoomBy: (_f: number) => {}, turned: (_a: number) => {}, tiltBy: (_d: number) => {} });
	const [angle, setAngle] = useState(() => stored("mmo.3d.angle", START_VIEW.angle));
	const [zoom, setZoom] = useState(() => clampZoom(stored("mmo.3d.zoom", START_VIEW.zoom)));
	const [tilt, setTilt] = useState(() => clampTilt(stored("mmo.3d.tilt", START_VIEW.tilt)));
	view.current = { zoomBy: (f) => setZoom((z) => clampZoom(z * f)), turned: (a) => setAngle(a), tiltBy: (d) => setTilt((v) => clampTilt(v + d)) };
	const previousReset = useRef(props.viewReset);
	useEffect(() => {
		if (previousReset.current === props.viewReset) return;
		previousReset.current = props.viewReset;
		setAngle(START_VIEW.angle); setZoom(START_VIEW.zoom); setTilt(START_VIEW.tilt);
		const s = state.current;
		if (s) { s.angle = START_VIEW.angle; s.zoom = START_VIEW.zoom; s.tilt = START_VIEW.tilt; s.panX = s.panZ = 0; positionCamera(s); }
	}, [props.viewReset]);

	// once: the renderer, the lights, the camera and the loop
	useEffect(() => {
		let dead = false;
		const visibility = () => { if (document.hidden && state.current?.measurement) { state.current.measurement = null; setMeasuring(false); setMeasurementNote("Messung abgebrochen: Tab war im Hintergrund. Bitte erneut messen."); } };
		document.addEventListener("visibilitychange", visibility);
		void (async () => {
			try {
				const [t, { createClosePost }] = await Promise.all([import("three"), import("./closeuppost3d.ts")]);
				if (dead || !host.current) return;
				const renderer = new t.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
				renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
				renderer.outputColorSpace = t.SRGBColorSpace;
				renderer.setClearColor(0x10171c, 1);
				renderer.domElement.addEventListener("contextmenu", prevent);
				host.current.querySelector(".map-canvas")?.replaceChildren(renderer.domElement);

				const scene = new t.Scene();
				const fog = new t.FogExp2(0xb8c1c7, 0); scene.fog = fog;
				const camera = new t.PerspectiveCamera(38, 1, 0.1, 160); camera.layers.enable(1);
				const post = createClosePost(renderer, scene, camera); renderer.info.autoReset = false;
				const hemi = new t.HemisphereLight(0xd9edff, 0x3a4a2a, 1.7); scene.add(hemi);
				const sun = new t.DirectionalLight(0xfff1cf, 2.2);
				sun.position.set(-6, 12, 8); scene.add(sun); scene.add(sun.target);
				// the sun casts shadows (v2): one map fitted to the room, smaller on a phone (lightRoom)
				const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
				renderer.shadowMap.enabled = true; renderer.shadowMap.type = t.PCFSoftShadowMap;
				sun.castShadow = true; sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
				scene.background = skyTexture(t);

				const s: Scene3D = { t, renderer, post, measurement: null, detailAt: -Infinity, scene, camera, fog, sun, hemi, light: -1, lightAt: 0, fish: [], host: host.current, canvas: renderer.domElement, room: props.room, world: props.world, ground: null, island: null, islandFor: "", islandMid: { x: 0, z: 0, reach: 0 }, named: true, bubbles: new Map(), plants: null, plantLooks: new Map(), plantsFor: "-", water: [], paving: null, pavingFor: "", chars: new Map(), objs: new Map(), angle: stored("mmo.3d.angle", START_VIEW.angle), zoom: clampZoom(stored("mmo.3d.zoom", START_VIEW.zoom)), tilt: clampTilt(stored("mmo.3d.tilt", START_VIEW.tilt)), panX: 0, panZ: 0, dist: 30, level: 0, size: { w: 0, h: 0 }, frame: 0, resize: null as unknown as ResizeObserver };
				s.resize = new ResizeObserver(() => resize(s));
				s.resize.observe(host.current);
				pointer(s, latest, view);
				state.current = s;
				resize(s);

				let before = performance.now();
				const frame = (now: number) => {
					if (dead) return;
					const elapsed = now - before, dt = Math.min(0.05, elapsed / 1000); before = now;
					if (document.hidden) {
						if (s.measurement) { s.measurement = null; setMeasuring(false); setMeasurementNote("Messung abgebrochen: Tab war im Hintergrund. Bitte erneut messen."); }
						s.frame = requestAnimationFrame(frame); return;
					}
					s.renderer.info.reset();
					step(s, dt, now / 1000, latest.current.me);
					bubbleTick(s);
					if (s.fish.length && s.zoom > 0.3) swimFish(s.fish, now / 1000);
					if (now - s.lightAt > 500) { s.lightAt = now; daylight(s, latest.current.worldTime ?? null); }
					if (now - s.detailAt >= 150) { updateModelDetails(t, s.scene, s.camera, s.zoom); s.detailAt = now; }
					s.post.render(closeBlur(s.zoom));
					if (s.measurement) {
						const m = s.measurement, seconds = Math.max(0, 32 - Math.floor((now - m.at) / 1000));
						if (seconds !== m.remaining) { m.remaining = seconds; setRemaining(seconds); }
						if (now - m.at >= 2000) { m.times.push(elapsed); m.calls.push(renderer.info.render.calls); m.zooms.push(s.zoom); }
						if (now - m.at >= 32000) {
							setReport({ ...frameSummary(m.times, m.calls, renderer.info.render.triangles, renderer.info.memory.geometries), zoom: [Math.min(...m.zooms), Math.max(...m.zooms)], viewport: [s.size.w, s.size.h, renderer.getPixelRatio()], userAgent: navigator.userAgent });
							s.measurement = null; setMeasuring(false);
						}
					}
					s.frame = requestAnimationFrame(frame);
				};
				s.frame = requestAnimationFrame(frame);
				setReady(true);
			} catch (e) {
				if (!dead) latest.current.onFail(`3D konnte nicht gestartet werden (${(e as Error).message || "WebGL nicht verfügbar"}).`);
			}
		})();
		return () => {
			dead = true; document.removeEventListener("visibilitychange", visibility);
			const s = state.current;
			if (!s) return;
			if (s.measurement) { s.measurement = null; setMeasuring(false); setMeasurementNote("Messung abgebrochen: 3D-Ansicht wurde neu gestartet. Bitte erneut messen."); }
			cancelAnimationFrame(s.frame); s.resize.disconnect(); unpointer(s); s.post.dispose(); dispose(s.scene); s.renderer.dispose(); s.canvas.remove(); state.current = null;
		};
	}, []);

	// per room: the ground and the things on it; the renderer and the camera stay
	useEffect(() => {
		const s = state.current;
		if (!ready || !s) return;
		let dead = false;
		if (s.room.roomId !== props.room.roomId) { s.panX = 0; s.panZ = 0; }
		s.room = props.room; s.world = props.world;
		for (const m of [s.chars, s.objs]) for (const id of [...m.keys()]) remove(s, m, id);
		void (async () => {
			let looks = new Map<string, TileLook>(), plants = new Map<string, import("three").Texture>();
			try { looks = await loadTileLooks(s.t, props.world, s.renderer.capabilities.getMaxAnisotropy()); } catch { /* flat colours */ }
			try { plants = await loadDecorLooks(s.t, props.world); } catch { /* a bare room */ }
			if (dead || state.current !== s) return;
			if (s.ground) { s.scene.remove(s.ground); dispose(s.ground); }
			s.water = []; s.paving = null; s.pavingFor = "";
			s.ground = buildTerrain(s, looks);
			shade(s.ground, true);
			s.scene.add(s.ground);
			lightRoom(s);
			s.plantLooks = plants; s.plantsFor = "-"; // sync builds the plants
			sync(s, latest.current.chars, latest.current.objs, latest.current.me, true);
			resize(s);
		})();
		return () => { dead = true; };
	}, [ready, props.room, props.world]);

	useEffect(() => { if (state.current) sync(state.current, props.chars, props.objs, props.me, false); }, [props.chars, props.objs, props.me]);
	useEffect(() => { if (state.current) applyFog(state.current, props.fog); }, [props.fog, ready]);
	// what was said: a bubble over the speaker for a few seconds, shown up close (zoom ≥ 1.6)
	useEffect(() => { if (state.current && ready) speak(state.current, props.said ?? []); }, [props.said, props.chars, ready]);
	// the island round the room: rebuilt when the room, the map, the fog or the people on it change
	// (the blocks only for the room, the map and the fog; the people only redraw the name cards, which is cheap)
	const islandKey = props.atlas && props.atlasState ? `${props.room.roomId}|${props.atlas.rooms.length}|${JSON.stringify(props.atlasState.fog)}` : "";
	const cardsKey = props.atlasState ? `${islandKey}|${JSON.stringify(props.atlasState.people)}` : "";
	useEffect(() => {
		const s = state.current;
		if (!ready || !s || s.islandFor === islandKey) return;
		if (s.island) { s.scene.remove(s.island); dispose(s.island); s.island = null; }
		s.islandFor = islandKey;
		if (!props.atlas || !props.atlasState) return;
		s.island = buildIsland(s, props.atlas, props.atlasState);
		shade(s.island, true); s.scene.add(s.island); positionCamera(s);
	}, [ready, islandKey]);
	useEffect(() => {
		const s = state.current;
		if (ready && s?.island && props.atlas && props.atlasState) { islandCards(s, props.atlas, props.atlasState); positionCamera(s); }
	}, [ready, cardsKey]);
	useEffect(() => {
		store("mmo.3d.angle", angle); store("mmo.3d.zoom", zoom); store("mmo.3d.tilt", tilt);
		if (state.current) { state.current.angle = angle; state.current.zoom = zoom; state.current.tilt = tilt; positionCamera(state.current); }
	}, [angle, zoom, tilt, ready]);
	// where the camera stands, for the arrows (they follow the view)
	const onTurn = props.onTurn;
	useEffect(() => { onTurn?.(angle); }, [angle, onTurn]);

	return (
		<div className="map map-3d" ref={host}>
			<div className="map-canvas" />
			{/* close up the edges darken and the fog becomes a vignette (v2, close level) */}
			<div className="map-3d-vignette" aria-hidden="true" style={{ opacity: clamp((zoom - 1) / 2.5, 0, 0.85) }} />
			<div className="map-zoom map-3d-controls" role="group" aria-label="3D-Ansicht">
				<button onClick={() => setAngle((a) => a - Math.PI / 4)} aria-label="Karte links drehen">↶</button>
				<button onClick={() => setAngle((a) => a + Math.PI / 4)} aria-label="Karte rechts drehen">↷</button>
				<button onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label="Vergrößern">+</button>
				<button onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label="Verkleinern">−</button>
			</div>
			<div className={`map-performance${report || measurementNote ? " has-result" : ""}`} role="group" aria-label="3D-Leistungsmessung">
				{tilt !== 0 && <button onClick={() => setTilt(0)} title="Alt+Mausrad neigt die Kamera; klicken setzt die Neigung zurück" aria-label="Manuelle Kameraneigung zurücksetzen">Neigung {tilt > 0 ? "+" : ""}{tilt}°</button>}
				<button disabled={!ready || measuring} title="2 Sekunden aufwärmen, dann 30 Sekunden messen. Tab geöffnet lassen. Das Ergebnis erscheint hier." onClick={() => { if (state.current) { state.current.measurement = { at: performance.now(), times: [], calls: [], zooms: [], remaining: 32 }; setRemaining(32); setMeasurementNote(""); setReport(null); setMeasuring(true); } }} aria-label="3D-Leistung 30 Sekunden messen">{measuring ? `Messung läuft … ${remaining} s` : "FPS messen"}</button>
				{measurementNote && <output className="map-performance-result" role="status">{measurementNote}</output>}
				{report && <output className="map-performance-result" role="status">Ergebnis: {report.fps.toFixed(1)} FPS · p95 {report.p95Ms.toFixed(1)} ms</output>}
				{report && <button title={JSON.stringify(report, null, 2)} onClick={() => {
					const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })), link = document.createElement("a");
					link.href = url; link.download = "spaces-mmo-3d-performance.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
				}} aria-label="3D-Messung als JSON herunterladen">JSON herunterladen ↓</button>}
				{(report || measurementNote) && <button onClick={() => { setReport(null); setMeasurementNote(""); }} aria-label="FPS-Ergebnis schließen">Schließen</button>}
			</div>
			{props.controls}
			<span className="map-mode-label">3D · Darstellung, Spielregeln bleiben 2D</span>
		</div>
	);
}

const dims = (room: MapRendererProps["room"]) => ({ w: room.ground[0]?.length ?? 0, h: room.ground.length });

/** The ground: one instanced box per tile kind, the tile art on top, plain earth on the sides. Boxes touch (no seams).
 *  The plants stand on it as pictures that face the camera (flat ones smaller). */
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
		// which cell each instance is: a click hits the column it lands on (pointer, cell)
		mesh.userData.cells = cells;
		const matrix = new t.Matrix4();
		cells.forEach((c, i) => {
			const height = surface(room, world, c.x, c.y);
			matrix.compose(new t.Vector3(c.x - w / 2 + 0.5, height / 2, c.y - h / 2 + 0.5), new t.Quaternion(), new t.Vector3(1, Math.max(0.04, height), 1));
			mesh.setMatrixAt(i, matrix);
		});
		mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); group.add(mesh);
		if (look && look.frames.length > 1) s.water.push({ material: top, look });
	}
	// the room as a diorama block: strata and sea under the tiles, its shadow on the void (block3d.ts)
	const block = blockUnder(t, room.ground, world.tiles);
	block.userData.block = true;
	s.fish = fishFor(t, block.userData.seaEdges as SeaEdge[], w, h, stableHash(room.roomId));
	for (const f of s.fish) block.add(f.group);
	swimFish(s.fish, 0);
	group.add(block);
	return group;
}

/** The plants of the room, never on a cell a building, site, ruin or bed covers: trees and bushes as models, flowers and
 *  herbs as pictures that face the camera (flat ones smaller). */
function buildPlants(s: Scene3D, covered: Set<string>): import("three").Group {
	const { t, room, world } = s, { w, h } = dims(room), plants = s.plantLooks;
	const group = new t.Group(); group.userData.owned = true;
	const materials = new Map<string, import("three").SpriteMaterial>();
	// trees and bushes as models (props3d.ts), one instanced mesh per shape; turn and size come from the cell
	const models = new Map<string, Array<{ x: number; y: number; turn: number; size: number }>>();
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const key = room.decor?.[y]?.[x] ?? " ", d = world.decor?.[key];
		if (!d?.model || covered.has(`${x},${y}`)) continue;
		const look = placeLook(`${room.roomId}:${x}:${y}`), at = `${d.model}:${look.variant}:${d.tint ?? ""}:${Math.floor(x / 4)},${Math.floor(y / 4)}`;
		const list = models.get(at) ?? []; list.push({ x, y, turn: look.turn, size: look.size }); models.set(at, list);
	}
	for (const [at, cells] of models) {
		const [model, variant, tint] = at.split(":") as [PlantModel, string, string];
		const mesh = new t.InstancedMesh(plantGeometry(t, model, Number(variant) % PLANT_VARIANTS, tint ? Number(tint) : undefined), propMaterial(t), cells.length);
		const matrix = new t.Matrix4(), q = new t.Quaternion(), up = new t.Vector3(0, 1, 0);
		cells.forEach((c, i) => { matrix.compose(new t.Vector3(c.x - w / 2 + 0.5, surface(room, world, c.x, c.y), c.y - h / 2 + 0.5), q.setFromAxisAngle(up, c.turn), new t.Vector3(c.size, c.size, c.size)); mesh.setMatrixAt(i, matrix); });
		mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); group.add(mesh);
		const tall = model === "tree" || model === "conifer";
		if (model === "tree" || model === "conifer" || model === "bush" || model === "berrybush") for (const c of cells) { const sh = propShadow(t, tall ? 1.1 : 0.8, tall ? 1.1 : 0.8); sh.position.set(c.x - w / 2 + 0.5, surface(room, world, c.x, c.y) + 0.012, c.y - h / 2 + 0.5); group.add(sh); }
	}
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const key = room.decor?.[y]?.[x] ?? " ", d = world.decor?.[key], map = plants.get(key);
		if (!d || !map || d.model || covered.has(`${x},${y}`)) continue;
		let material = materials.get(key);
		if (!material) { material = new t.SpriteMaterial({ map, color: d.tint ?? 0xffffff, alphaTest: 0.5 }); materials.set(key, material); }
		const sprite = new t.Sprite(material), size = d.upright ? 1 : 0.6;
		sprite.center.set(0.5, 0);
		sprite.scale.set((d.w / world.tileSize) * size, (d.h / world.tileSize) * size, 1);
		sprite.position.set(x - w / 2 + 0.5, surface(room, world, x, y), y - h / 2 + 0.5);
		group.add(sprite);
	}
	return group;
}

/** Every frame: the water moves, figures and things glide to their cell and the figures walk; the camera does not follow. */
function step(s: Scene3D, dt: number, time: number, me: string): void {
	for (const w of s.water) w.material.map = w.look.frames[Math.floor((time * 1000) / w.look.frameMs) % w.look.frames.length]!;
	pavingDetail(s);
	const k = 1 - Math.exp(-12 * dt);
	for (const [id, e] of s.chars) {
		const x0 = e.obj.position.x, z0 = e.obj.position.z;
		e.obj.position.lerp(e.target, id === me ? k : k * 0.9);
		if (e.fig) animateFigure(e.fig, e.obj.position.x - x0, e.obj.position.z - z0, dt, time);
	}
	for (const e of s.objs.values()) {
		if (e.kind === "animal") {
			// an animal from the fog hops towards its cell and turns to where it goes
			const body = e.obj.getObjectByName("body"), dx = e.target.x - e.obj.position.x, dz = e.target.z - e.obj.position.z, far = Math.hypot(dx, dz);
			if (body && far > 0.05) { body.rotation.y = Math.atan2(dx, dz); body.position.y = Math.abs(Math.sin(time * 14)) * 0.12; }
			else if (body) body.position.y = 0;
		}
		e.obj.position.lerp(e.target, k);
		if (e.flame) {
			// the fire's light flickers, and reaches further in the dark (daylight sets s.light)
			const on = e.flame.light.userData.lit as boolean, dark = 1 - Math.max(0, s.light), id = e.obj.id;
			const flicker = 1 + Math.sin(time * 9 + id) * 0.06 + Math.sin(time * 23.7 + id * 3) * 0.05 + Math.sin(time * 5.3 + id * 7) * 0.04;
			e.flame.cone.visible = on; e.flame.cone.scale.y = on ? 1 + Math.sin(time * 9 + id) * 0.07 : 1;
			e.flame.light.intensity = on ? (4 + 6 * dark) * flicker : 0; e.flame.light.distance = 4 + 3 * dark;
		}
	}
}

function pavingDetail(s: Scene3D): void {
	if (!s.ground) return;
	if (s.zoom < 2) { if (s.paving) s.paving.visible = false; return; }
	const { w, h } = dims(s.room), x = Math.floor(s.panX + w / 2), y = Math.floor(s.panZ + h / 2), key = `${x},${y}`;
	if (s.paving && s.pavingFor === key) { s.paving.visible = true; return; }
	if (s.paving) { s.ground.remove(s.paving); dispose(s.paving); }
	const cells = detailCells(s.room.ground, x, y), t = s.t;
	const stones = new t.InstancedMesh(new t.BoxGeometry(0.225, 0.018, 0.225), new t.MeshStandardMaterial({ roughness: 1 }), Math.max(1, cells.length * 16));
	const matrix = new t.Matrix4(), colour = new t.Color();
	let i = 0;
	for (const cell of cells) for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
		matrix.makeTranslation(cell.x - w / 2 + 0.125 + col / 4, surface(s.room, s.world, cell.x, cell.y) + 0.01, cell.y - h / 2 + 0.125 + row / 4);
		stones.setMatrixAt(i, matrix);
		stones.setColorAt(i++, colour.setHex(0x9a9ea6).multiplyScalar(0.85 + (stableHash(`${s.room.roomId}:${cell.x}:${cell.y}:${row}:${col}`) % 25) / 100));
	}
	stones.count = i; stones.instanceMatrix.needsUpdate = true; if (stones.instanceColor) stones.instanceColor.needsUpdate = true;
	stones.computeBoundingSphere(); stones.receiveShadow = true;
	s.ground.add(stones); s.paving = stones; s.pavingFor = key;
}

function sync(s: Scene3D, chars: Map<string, CharView>, objs: Map<string, ObjView>, me: string, snap: boolean): void {
	if (!s.ground) return; // the room's ground is not built yet: the build calls this when it is
	for (const id of [...s.chars.keys()]) if (!chars.has(id)) remove(s, s.chars, id);
	for (const [id, c] of chars) {
		let e = s.chars.get(id);
		// an alias shows at once: the figure is made anew under its new name
		if (e && e.shown !== c.name) { remove(s, s.chars, id); e = undefined; }
		if (!e) {
			const fig = makeFigure(s.t, { id, skin: c.skin, own: id === me, ai: !!c.ai });
			fig.group.add(label(s.t, c.settler ? `${c.name} (Siedler)` : c.name, id === me ? "#dfff73" : c.ai ? "#9fd3ff" : "#ffffff"));
			e = { obj: fig.group, target: at(s, c.x, c.y, 0), fig, shown: c.name }; e.obj.position.copy(e.target); shade(e.obj, false); if (!s.named) e.obj.traverse((o) => { if (o.userData.label) o.visible = false; }); fitSprites(s, e.obj); s.scene.add(e.obj); s.chars.set(id, e);
		}
		e.target.copy(at(s, c.x, c.y, 0));
		if (snap) e.obj.position.copy(e.target);
	}
	for (const id of [...s.objs.keys()]) if (!objs.has(id) || objs.get(id)?.location !== s.room.roomId) {
		const e = s.objs.get(id)!;
		// cleared scenery sinks away instead of vanishing
		if (e.kind === "scenery" && !objs.has(id)) { s.objs.delete(id); fadeOut(s, e.obj); } else remove(s, s.objs, id);
	}
	for (const [id, obj] of objs) {
		if (obj.location !== s.room.roomId) continue;
		let e = s.objs.get(id);
		// a site that became a building (or got further) is drawn anew
		if (e && (e.kind !== obj.kind || e.progress !== obj.progress || e.sig !== bedSig(obj))) { remove(s, s.objs, id); e = undefined; }
		if (!e) { e = obj.kind === "track" ? track(s, obj) : object(s.t, obj, me); prepareModelDetails(s.t, e.obj); e.target.copy(placeOf(s, obj)); e.obj.position.copy(e.target); shade(e.obj, true); if (!s.named) e.obj.traverse((o) => { if (o.userData.label) o.visible = false; }); fitSprites(s, e.obj); s.scene.add(e.obj); s.objs.set(id, e); }
		e.target.copy(placeOf(s, obj));
		if (e.flame) { const lit = (obj.until ?? 0) > Date.now(); e.flame.light.userData.lit = lit; }
	}
	// nothing grows where something is built or dug
	const covered = new Set<string>();
	for (const o of objs.values()) if (o.location === s.room.roomId && (o.kind === "building" || o.kind === "site" || o.kind === "ruin" || o.kind === "bed" || o.kind === "field"))
		for (let y = o.y; y < o.y + (o.h ?? 1); y++) for (let x = o.x; x < o.x + (o.w ?? 1); x++) covered.add(`${x},${y}`);
	const key = [...covered].sort().join(";");
	if (key !== s.plantsFor) {
		if (s.plants) { s.scene.remove(s.plants); dispose(s.plants); }
		s.plants = buildPlants(s, covered); shade(s.plants, false); s.scene.add(s.plants); s.plantsFor = key;
	}
}

/** Where an object stands: its cell, or the middle of the cells a site or building covers. */
function placeOf(s: Scene3D, obj: ObjView): import("three").Vector3 {
	if (obj.kind === "track") return new s.t.Vector3(); // its pieces stand where they lie
	const v = at(s, obj.x, obj.y, 0);
	v.x += ((obj.w ?? 1) - 1) / 2; v.z += ((obj.h ?? 1) - 1) / 2;
	return v;
}

/** The island railway's tracks (App, engine/rail.ts): sleepers on every cell and two rails from cell to cell, on the
 *  ground of each cell. */
function track(s: Scene3D, obj: ObjView): Entry {
	const t = s.t, group = new t.Group(); group.userData.owned = true;
	const rail = new t.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.4 }), wood = new t.MeshStandardMaterial({ color: 0x4a3522, roughness: 1 });
	const sleeper = new t.BoxGeometry(0.1, 0.03, 0.42), bars = new Map<string, import("three").BufferGeometry>();
	for (const run of obj.runs ?? []) run.forEach((c, i) => {
		const here = at(s, c.x, c.y, 0), { d1, d2 } = stepsAt(run, i);
		// the piece's points are in cell units (x right, y down = world x, z)
		if (i > 0 || !obj.fromStation) for (const k of sleeperSpots(d1, d2)) {
			const m = new t.Mesh(sleeper, wood); m.position.set(here.x + k.x, here.y + 0.02, here.z + k.y); m.rotation.y = Math.atan2(k.ax, k.ay); group.add(m);
		}
		for (const side of [0.12, -0.12]) {
			const pts = railPoints(d1, d2, side);
			for (let n = 0; n + 1 < pts.length; n++) {
				const a = pts[n]!, b = pts[n + 1]!, len = Math.hypot(b.x - a.x, b.y - a.y), key = len.toFixed(3);
				if (!bars.has(key)) bars.set(key, new t.BoxGeometry(len + 0.02, 0.04, 0.04));
				const m = new t.Mesh(bars.get(key)!, rail);
				m.position.set(here.x + (a.x + b.x) / 2, here.y + 0.05, here.z + (a.y + b.y) / 2); m.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x); group.add(m);
			}
		}
	});
	return { obj: group, target: new t.Vector3(), kind: "track", sig: bedSig(obj) };
}

function object(t: T, obj: ObjView, me: string): Entry {
	const group = new t.Group(); group.userData.owned = true;
	const e: Entry = { obj: group, target: new t.Vector3(), kind: obj.kind, ...(obj.progress !== undefined ? { progress: obj.progress } : {}), ...(obj.kind === "bed" || obj.kind === "field" || obj.kind === "building" ? { sig: bedSig(obj) } : {}) };
	if (obj.kind === "cart") {
		// a two-wheeled cart: a box of planks on an axle, its shafts on the ground
		const wood = new t.MeshStandardMaterial({ color: 0x8a6a44, roughness: 1 }), dark = new t.MeshStandardMaterial({ color: 0x4a3522, roughness: 1 });
		const box = new t.Mesh(new t.BoxGeometry(0.7, 0.22, 0.46), wood); box.position.y = 0.34; group.add(box);
		for (const z of [-0.26, 0.26]) {
			const wheel = new t.Mesh(new t.CylinderGeometry(0.2, 0.2, 0.05, 12), dark); wheel.rotation.x = Math.PI / 2; wheel.position.set(0, 0.2, z); group.add(wheel);
			const shaft = new t.Mesh(new t.BoxGeometry(0.42, 0.04, 0.04), dark); shaft.position.set(0.52, 0.16, z * 0.8); shaft.rotation.z = -0.35; group.add(shaft);
		}
		group.add(propShadow(t, 0.7, 0.5));
		return e;
	}
	if (obj.kind === "train") {
		// the island railway's train at the platform (App, engine/rail.ts): a little engine and a carriage on the station's
		// own track, which runs along its front (buildings3d.ts station)
		const mat = (c: number) => new t.MeshStandardMaterial({ color: c, roughness: 0.7 });
		const green = mat(0x2f5a3a), black = mat(0x222428), red = mat(0x8a2a22), cream = mat(0xe8e0c8);
		const z = (obj.h ?? 1) * 0.34, len = Math.min(2.6, (obj.w ?? 1) * 0.9), x0 = -len / 2;
		const box = (w: number, h: number, d: number, m: import("three").Material, x: number, y: number) => { const b = new t.Mesh(new t.BoxGeometry(w, h, d), m); b.position.set(x, y, z); group.add(b); };
		// the engine: a boiler, a cab, a chimney
		const engine = len * 0.45;
		const boiler = new t.Mesh(new t.CylinderGeometry(0.13, 0.13, engine * 0.62, 12), green); boiler.rotation.z = Math.PI / 2; boiler.position.set(x0 + engine * 0.31, 0.38, z); group.add(boiler);
		box(engine * 0.36, 0.34, 0.3, green, x0 + engine * 0.8, 0.42);
		box(engine * 0.42, 0.04, 0.34, black, x0 + engine * 0.8, 0.61);
		const chimney = new t.Mesh(new t.CylinderGeometry(0.05, 0.04, 0.16, 8), black); chimney.position.set(x0 + engine * 0.12, 0.56, z); group.add(chimney);
		box(engine, 0.08, 0.28, black, x0 + engine / 2, 0.24);
		// the carriage, cream with a red band and a dark roof
		const car = len - engine - 0.06, cx = x0 + engine + 0.06 + car / 2;
		box(car, 0.3, 0.3, cream, cx, 0.42); box(car + 0.01, 0.06, 0.31, red, cx, 0.36); box(car + 0.06, 0.04, 0.34, black, cx, 0.59); box(car, 0.08, 0.28, black, cx, 0.24);
		for (const wx of [x0 + engine * 0.2, x0 + engine * 0.75, cx - car * 0.3, cx + car * 0.3]) for (const side of [-0.15, 0.15]) {
			const wheel = new t.Mesh(new t.CylinderGeometry(0.07, 0.07, 0.03, 10), black); wheel.rotation.x = Math.PI / 2; wheel.position.set(wx, 0.2, z + side); group.add(wheel);
		}
		return e;
	}
	if (obj.kind === "liner") {
		// the large ship lying in the bay by its timetable (App, engine/liner.ts), its bow to +x, turned when it lies along y
		const ship = propMesh(t, linerGeometry(t, Math.max(obj.w ?? 1, obj.h ?? 1)));
		if ((obj.h ?? 1) > 1) ship.rotation.y = -Math.PI / 2;
		group.add(ship);
		return e;
	}
	if (obj.kind === "zone") {
		// a zone of the town hall: a tint just above the ground
		const tint = new t.Mesh(new t.BoxGeometry(obj.w ?? 1, 0.01, obj.h ?? 1), new t.MeshBasicMaterial({ color: Number.parseInt((obj.color ?? "#5fbf6a").slice(1), 16), transparent: true, opacity: 0.22, depthWrite: false }));
		tint.position.y = 0.03; group.add(tint);
		return e;
	}
	if (obj.kind === "bed") {
		// dug soil a little above the grass; each plant at its cell by its stage
		const w = obj.w ?? 1, d = obj.h ?? 1;
		const soil = new t.Mesh(new t.BoxGeometry(w * 0.92, 0.08, d * 0.92), new t.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 })); soil.position.y = 0.04; group.add(soil);
		if (obj.fenced) group.add(propMesh(t, fenceGeometry(t, w, d))); // hares keep out (wild.ts)
		const stem = new t.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 1 });
		for (const p of obj.plants ?? []) {
			const px = p.x - (w - 1) / 2, pz = p.y - (d - 1) / 2;
			if (p.model) { const crop = propMesh(t, cropGeometry(t, p.model, p.stage, Number.parseInt(p.color.slice(1), 16))); crop.position.set(px, 0.08, pz); crop.rotation.y = placeLook(`${obj.id}:${p.x}:${p.y}`).turn; group.add(crop); continue; }
			if (p.stage === 0) { const s0 = new t.Mesh(new t.SphereGeometry(0.04, 6, 4), new t.MeshStandardMaterial({ color: 0x2e1e10 })); s0.position.set(px, 0.1, pz); group.add(s0); continue; }
			const tall = p.stage === 1 ? 0.2 : p.stage === 2 ? 0.38 : 0.15;
			const st = new t.Mesh(new t.CylinderGeometry(0.03, 0.03, tall, 5), p.stage === 3 ? new t.MeshStandardMaterial({ color: 0x7a6a4a }) : stem); st.position.set(px, 0.08 + tall / 2, pz); group.add(st);
			if (p.stage === 2) { const head = new t.Mesh(new t.SphereGeometry(0.17, 10, 8), new t.MeshStandardMaterial({ color: Number.parseInt(p.color.slice(1), 16), roughness: 0.7 })); head.position.set(px, 0.08 + tall + 0.08, pz); group.add(head); }
		}
		if (obj.weedy) for (const [wx, wz] of [[-0.3, 0.25], [0.3, -0.3], [0.1, 0.35]] as const) { const weed = new t.Mesh(new t.ConeGeometry(0.04, 0.14, 4), stem); weed.position.set(wx * w, 0.15, wz * d); group.add(weed); }
		return e;
	}
	if (obj.kind === "field") {
		// ploughed soil in rows along x; on it by the stage short green shoots, or tall stalks in the crop's colour
		const w = obj.w ?? 1, d = obj.h ?? 1, stage = obj.fieldStage ?? "brach";
		const soil = new t.Mesh(new t.BoxGeometry(w * 0.96, 0.06, d * 0.96), new t.MeshStandardMaterial({ color: stage === "brach" ? 0x7a6040 : 0x5e4028, roughness: 1 })); soil.position.y = 0.03; group.add(soil);
		if (obj.fenced) group.add(propMesh(t, fenceGeometry(t, w, d))); // deer keep out (wild.ts)
		if (stage === "brach") return e;
		if (obj.cropModel && stage !== "saat") {
			const ripe = stage === "reif" || stage === "spaet", color = Number.parseInt((obj.color ?? "#d9b44a").slice(1), 16);
			const crop = propMesh(t, fieldCropGeometry(t, obj.cropModel, w, d, ripe ? 1 : 0.4, color, stage === "spaet")); crop.position.y = 0.06; group.add(crop);
			return e;
		}
		const ridge = new t.MeshStandardMaterial({ color: 0x4e3420, roughness: 1 });
		const crop = new t.MeshStandardMaterial({ color: stage === "reif" || stage === "spaet" ? Number.parseInt((obj.color ?? "#d9b44a").slice(1), 16) : 0x5f9a3a, roughness: 0.9 });
		if (stage === "spaet") crop.color.multiplyScalar(0.7);
		const rows = Math.max(2, d * 2), tall = stage === "saat" ? 0 : stage === "waechst" ? 0.18 : 0.42;
		for (let r = 0; r < rows; r++) {
			const z = -d / 2 + (r + 0.5) * (d / rows);
			const bank = new t.Mesh(new t.BoxGeometry(w * 0.9, 0.05, 0.12), ridge); bank.position.set(0, 0.08, z); group.add(bank);
			// a sowing in progress: the furrows so far, no plants yet
			if (!tall) { if (r / rows >= (obj.progress ?? 0)) bank.visible = false; continue; }
			const row = new t.Mesh(new t.BoxGeometry(w * 0.88, tall, 0.14), crop); row.position.set(0, 0.1 + tall / 2, z); group.add(row);
		}
		return e;
	}
	// houses, sites, ruins, the fire and exits are models (props3d.ts), a variant per thing (its id)
	const w = obj.w ?? 1, d = obj.h ?? 1, variant = placeLook(obj.id).variant;
	if (obj.kind === "ruin") {
		group.add(propShadow(t, w * 1.05, d * 1.05), propMesh(t, ruinGeometry(t, w, d, variant)));
		return e;
	}
	if (obj.kind === "building" || obj.kind === "site") {
		const color = Number.parseInt((obj.color ?? "#8a6a44").slice(1), 16);
		group.add(propShadow(t, w * 1.15, d * 1.15));
		const body = propMesh(t, obj.kind === "building" ? (buildingModel(t, obj.plan, w, d, variant) ?? buildingGeometry(t, obj.plan, w, d, color, variant, obj.herd)) : siteGeometry(t, obj.plan, w, d, color, obj.progress ?? 0));
		group.add(body);
		// one's own site says so above it
		if (obj.kind === "site" && obj.ownerId === me) { const mark = label(t, "Deine Baustelle", "#dfff73"); mark.position.y = 1.3; group.add(mark); }
		// a coop with a fence round it (foxes keep out), a dog or cat on guard at its front corner (wild.ts, animals.ts)
		if (obj.kind === "building" && obj.fenced) group.add(propMesh(t, fenceGeometry(t, w + 0.5, d + 0.5)));
		if (obj.kind === "building" && obj.keeper) { const k = propMesh(t, keeperGeometry(t, obj.keeper, variant)); k.position.set(w / 2 + 0.05, 0, d / 2 + 0.05); k.rotation.y = 0.6; group.add(k); }
		return e;
	}
	if (obj.kind === "animal") {
		// a hare, deer, fox, mouse or gull (wild.ts): it hops or trots and looks where it goes (step)
		const body = propMesh(t, wildGeometry(t, obj.animal, variant)); body.rotation.y = (variant / 3) * Math.PI * 2; body.name = "body";
		const size = obj.animal === "reh" ? 0.8 : obj.animal === "maus" ? 0.2 : obj.animal === "moewe" ? 0.35 : 0.5;
		group.add(propShadow(t, size, size), body);
		return e;
	}
	if (obj.kind === "beacon") {
		group.add(propShadow(t, 1.1, 1.1), propMesh(t, fireGeometry(t)));
		const cone = new t.Mesh(new t.ConeGeometry(0.17, 0.5, 7), new t.MeshStandardMaterial({ color: 0xffa23a, emissive: 0xff7a14, emissiveIntensity: 1.6, transparent: true, opacity: 0.92, flatShading: true })); cone.position.y = 0.6; group.add(cone);
		const light = new t.PointLight(0xff9d32, 0, 4); light.position.y = 0.85; group.add(light);
		e.flame = { light, cone };
	} else if (obj.kind === "scenery") {
		const w = obj.w ?? 1, d = obj.h ?? 1;
		const mesh = sceneryModel(t, obj.model, w, d, variant) ?? (["huette", "felsen", "mauer", "turm", "meiler"].includes(obj.model ?? "") ? ruinGeometry(t, w, d, variant) : obj.model === "netz" ? fenceGeometry(t, w, d) : obj.model === "steg" ? jettyGeometry(t, w, d) : siteGeometry(t, undefined, w, d, 0x6b4a2e, 1));
		group.add(propMesh(t, mesh));
	} else if (obj.kind === "exit") {
		const sign = propMesh(t, signGeometry(t)); sign.rotation.y = (variant / 3) * Math.PI * 2; group.add(sign);
		const mark = label(t, tr(obj.to ?? obj.name), "#AED83C"); mark.position.y = 1.1; group.add(mark);
	} else if (fishItem(obj.icon)) {
		// a fish (fresh or smoked) lies on its side on the ground instead of its picture (fish3d.ts)
		const f = fishItem(obj.icon)!, fish = fishModel(t, f.kind, propMaterial(t), f.smoked);
		fish.group.rotation.x = Math.PI / 2; fish.group.position.y = 0.03; fish.group.scale.setScalar(1.4); fish.tail.rotation.y = 0.25;
		const turn = new t.Group(); turn.rotation.y = (variant / 3) * Math.PI * 2; turn.add(fish.group);
		group.add(propShadow(t, 0.45, 0.2), turn);
	} else if (obj.icon) {
		// the thing's picture as a small sign that always faces the camera
		const sprite = new t.Sprite(new t.SpriteMaterial({ map: iconTexture(t, obj.icon), transparent: true, alphaTest: 0.1 }));
		sprite.position.y = 0.28; sprite.scale.set(0.5, 0.5, 1); group.add(sprite);
	} else {
		const rock = new t.Mesh(new t.DodecahedronGeometry(0.15), new t.MeshStandardMaterial({ color: Number.parseInt(obj.glyph?.color.slice(1) ?? "b9c26d", 16), roughness: 0.85 })); rock.position.y = 0.16; group.add(rock);
	}
	return e;
}

/** A thing's picture as a texture, loaded once per URL and kept sharp (pixel art). */
const iconTextures = new Map<string, import("three").Texture>();
function iconTexture(t: T, url: string): import("three").Texture {
	let tex = iconTextures.get(url);
	if (!tex) {
		tex = new t.TextureLoader().load(url);
		tex.magFilter = t.NearestFilter; tex.minFilter = t.NearestFilter; tex.colorSpace = t.SRGBColorSpace;
		tex.userData.shared = true; // kept when a thing goes (dispose)
		iconTextures.set(url, tex);
	}
	return tex;
}

function label(t: T, text: string, color: string): import("three").Sprite {
	const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!;
	canvas.width = 256; canvas.height = 48; ctx.font = "600 22px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
	ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.strokeText(text.slice(0, 24), 128, 24); ctx.fillStyle = color; ctx.fillText(text.slice(0, 24), 128, 24);
	const texture = new t.CanvasTexture(canvas); texture.colorSpace = t.SRGBColorSpace;
	// the same size on the screen at every zoom (v2): close up a name no longer covers the figure
	const sprite = new t.Sprite(new t.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false }));
	sprite.position.y = 1.4; sprite.userData.px = [180, 34]; sprite.renderOrder = 10; sprite.userData.label = true; return sprite;
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

/** The cells between two blocks on the island level. */
const ISLAND_GAP = 5;
/** The other rooms of the island this one lies on, as blocks round it at their places on the world map (AtlasView x, y:
 *  one step per room), each with a lid of flat tile colours greyed by its fog, and a name card with how many are there.
 *  The room's own name card floats over its own block. Tapping a block does nothing: changing rooms stays a command. */
function buildIsland(s: Scene3D, atlas: AtlasView, state: AtlasState): import("three").Group {
	const { t, room, world } = s, group = new t.Group(); group.userData.owned = true;
	const here = atlas.rooms.find((r) => r.roomId === room.roomId);
	if (!here) return group;
	const { w, h } = dims(room), cards = new t.Group(); cards.userData.cards = true;
	const mids: Array<{ x: number; z: number }> = [];
	for (const r of atlas.rooms) {
		if (r.island !== here.island) continue;
		const x = (r.x - here.x) * (w + ISLAND_GAP), z = (r.y - here.y) * (h + ISLAND_GAP);
		if (r.roomId !== room.roomId) {
			const block = islandBlock(t, r.ground, world.tiles, (state.fog[r.roomId] ?? 0) / 3.5);
			block.position.set(x, 0, z); group.add(block);
		}
		mids.push({ x, z });
	}
	group.add(cards);
	islandCards(s, atlas, state, group);
	const mx = mids.reduce((a, m) => a + m.x, 0) / mids.length, mz = mids.reduce((a, m) => a + m.z, 0) / mids.length;
	s.islandMid = { x: mx, z: mz, reach: Math.max(...mids.map((m) => Math.hypot(m.x - mx, m.z - mz))) + Math.hypot(w, h) / 2 };
	return group;
}

const BUBBLE_MS = 8000, BUBBLE_ZOOM = 1.6;
/** A speech bubble: the speaker's words on a light card with a tail, the same size on the screen. */
function bubble(t: T, text: string): import("three").Sprite {
	const canvas = document.createElement("canvas"), g = canvas.getContext("2d")!;
	canvas.width = 512; canvas.height = 160; g.font = "500 30px sans-serif"; g.textBaseline = "middle";
	const words = text.split(/\s+/), lines: string[] = [];
	for (const word of words) { const last = lines[lines.length - 1]; if (last !== undefined && g.measureText(`${last} ${word}`).width < 440) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word); }
	const shown = lines.slice(0, 2); if (lines.length > 2) shown[1] = `${shown[1]!.slice(0, 26)}…`;
	const wide = Math.min(500, Math.max(...shown.map((l) => g.measureText(l).width)) + 40), high = 24 + shown.length * 38;
	g.fillStyle = "rgba(244,234,208,.96)"; g.beginPath(); g.roundRect((512 - wide) / 2, 4, wide, high, 18); g.fill();
	g.beginPath(); g.moveTo(240, 4 + high); g.lineTo(256, 4 + high + 22); g.lineTo(272, 4 + high); g.fill();
	g.fillStyle = "#2b2418"; shown.forEach((l, i) => g.fillText(l, (512 - wide) / 2 + 20, 4 + 12 + 19 + i * 38));
	const texture = new t.CanvasTexture(canvas); texture.colorSpace = t.SRGBColorSpace;
	const sprite = new t.Sprite(new t.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false, fog: false }));
	sprite.center.set(0.5, 0); sprite.userData.px = [290, 91]; sprite.position.y = 1.85; sprite.renderOrder = 11;
	return sprite;
}
/** Puts a bubble over each figure whose name said something in the last seconds (the latest line wins), and takes off the
 *  ones that are over. */
function speak(s: Scene3D, said: Array<{ from: string; text: string; at: number }>): void {
	const now = Date.now(), latest = new Map<string, { text: string; at: number }>();
	for (const m of said) if (now - m.at < BUBBLE_MS) latest.set(m.from, m);
	for (const [id, e] of s.chars) {
		const m = e.shown ? latest.get(e.shown) : undefined, had = s.bubbles.get(id), key = m ? `${m.at}:${m.text}` : "";
		if (had && had.key === key) continue;
		if (had) { e.obj.remove(had.sprite); dispose(had.sprite); s.bubbles.delete(id); }
		if (!m) continue;
		// the log line names the speaker first ("Name: text"); the bubble stands over them already
		const words = m.text.startsWith(`${e.shown}:`) ? m.text.slice(e.shown!.length + 1).trim() : m.text;
		const sprite = bubble(s.t, words); sprite.visible = s.zoom >= BUBBLE_ZOOM; fitSprites(s, sprite);
		e.obj.add(sprite); s.bubbles.set(id, { sprite, until: m.at + BUBBLE_MS, key });
	}
}
/** Every frame: bubbles show only up close and go when their time is over. */
function bubbleTick(s: Scene3D): void {
	if (!s.bubbles.size) return;
	const now = Date.now(), near = s.zoom >= BUBBLE_ZOOM;
	for (const [id, b] of s.bubbles) {
		if (now > b.until) { b.sprite.parent?.remove(b.sprite); dispose(b.sprite); s.bubbles.delete(id); continue; }
		b.sprite.visible = near;
	}
}

/** The name cards over the island's blocks: each room's name and how many are there, drawn again when the counts change. */
function islandCards(s: Scene3D, atlas: AtlasView, state: AtlasState, group = s.island): void {
	const cards = group?.children.find((o) => o.userData.cards);
	const here = atlas.rooms.find((r) => r.roomId === s.room.roomId);
	if (!cards || !here) return;
	for (const c of [...cards.children]) { cards.remove(c); dispose(c); }
	const { w, h } = dims(s.room);
	for (const r of atlas.rooms) {
		if (r.island !== here.island) continue;
		const [humans = 0, npcs = 0] = state.people[r.roomId] ?? [];
		const card = nameCard(s.t, r.name, humans + npcs, r.roomId === s.room.roomId);
		card.position.set((r.x - here.x) * (w + ISLAND_GAP), 1.2, (r.y - here.y) * (h + ISLAND_GAP) - r.ground.length / 2 - 1);
		cards.add(card);
	}
	fitSprites(s, cards);
}

/** Names, cards and bubbles keep a size in screen pixels (`userData.px`, width and height): a sprite without size
 *  attenuation is measured in parts of the view's height, so the same name would be tiny on a phone held sideways and
 *  large on one held upright. */
function fitSprites(s: Scene3D, root: O3): void {
	const perPx = (2 * Math.tan((s.camera.fov * Math.PI) / 360)) / Math.max(1, s.size.h || 900);
	root.traverse((o) => { const px = o.userData.px as [number, number] | undefined; if (px) { o.layers.set(1); o.scale.set(px[0] * perPx, px[1] * perPx, 1); } });
}

/** Every mesh of `root` casts a shadow; the ground and the things lying on it also take them (`receive`). Sprites and the
 *  soft blobs under things neither cast nor take one. */
function shade(root: O3, receive: boolean): void {
	root.traverse((o) => {
		const m = o as import("three").Mesh;
		if (!m.isMesh) return;
		// under water nothing casts or takes the sun's shadow (block3d.ts: the sea side, the seabed, the fish)
		if (m.userData.unshaded) { m.castShadow = m.receiveShadow = false; return; }
		const basic = (Array.isArray(m.material) ? m.material[0] : m.material)?.type === "MeshBasicMaterial";
		m.castShadow = !basic; m.receiveShadow = receive && !basic;
	});
}
/** Fits the sun's shadow map to the room: an orthographic box round the block, the sun high in the south-west. */
function lightRoom(s: Scene3D): void {
	const { w, h } = dims(s.room), r = Math.hypot(w, h) / 2 + 2, cam = s.sun.shadow.camera;
	s.sun.position.set(-r * 0.55, r * 1.1, r * 0.75); s.sun.target.position.set(0, 0, 0);
	cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 0.5; cam.far = r * 4; cam.updateProjectionMatrix();
}
/** Day and night from the world's clock: the sun sinks to a pale moonlight, warm at dawn and dusk, the sky darkens, and
 *  the lamplit faces of the models glow (props3d.ts, setNight). Visual only; without a clock it stays day. */
const NOON = 0xfff1cf, MOON = 0x8fa6d8, DUSK = 0xffa25a;
function daylight(s: Scene3D, clock: { v: import("../server/engine/worldtime.ts").WorldTimeView; at: number } | null): void {
	const hour = s.hourProbe != null ? s.hourProbe : clock ? calendar(shownWorldMs(clock.v, clock.at, Date.now())).millisOfDay / WORLD_HOUR_MS : 12;
	const d = Math.round(daylightAt(hour) * 100) / 100;
	if (d === s.light) return;
	s.light = d;
	const dusk = 4 * d * (1 - d);
	s.sun.intensity = 2.2 * (0.14 + 0.86 * d);
	s.sun.color.setHex(MOON).lerp(new s.t.Color(NOON), d).lerp(new s.t.Color(DUSK), dusk * 0.55);
	s.hemi.intensity = 1.7 * (0.32 + 0.68 * d);
	s.hemi.color.setHex(0x5a6c9e).lerp(new s.t.Color(0xd9edff), d);
	s.scene.backgroundIntensity = 0.4 + 0.6 * d;
	setNight(Math.min(1, (1 - d) * 1.3));
}
let sky: import("three").CanvasTexture | null = null;
/** The void round the block: a dusk gradient instead of black, lighter towards the horizon. */
function skyTexture(t: T): import("three").CanvasTexture {
	if (sky) return sky;
	const c = document.createElement("canvas"); c.width = 2; c.height = 256;
	const g = c.getContext("2d")!, grad = g.createLinearGradient(0, 0, 0, 256);
	grad.addColorStop(0, "#141a26"); grad.addColorStop(0.55, "#26324a"); grad.addColorStop(1, "#3c4d66");
	g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
	sky = new t.CanvasTexture(c); sky.colorSpace = t.SRGBColorSpace; sky.userData.shared = true;
	return sky;
}

/** The camera looks at the middle of the room (moved by the drag) from a distance that shows all of it at zoom 1; only
 *  dragging, turning and zooming move it. Its elevation follows the zoom (camera3d.ts): steep from afar, flat up close.
 *  The far plane follows the distance, so the room stays in view at the island's end of the slider. */
function positionCamera(s: Scene3D): void {
	if (s.catalogue) return;
	const { w, h } = dims(s.room), aspect = s.camera.aspect || 1, elevation = cameraElevation(s.zoom, s.tilt);
	// from the approach outwards the view turns from the room to the middle of the island, and may be dragged over all of it
	const toIsland = s.island && s.islandMid.reach > 0 ? clamp((0.6 - s.zoom) / 0.3, 0, 1) : 0, reach = s.islandMid.reach * toIsland;
	s.panX = clamp(s.panX, -w / 2 - reach, w / 2 + reach); s.panZ = clamp(s.panZ, -h / 2 - reach, h / 2 + reach);
	const lookX = s.panX + s.islandMid.x * toIsland, lookZ = s.panZ + s.islandMid.z * toIsland;
	const radius = Math.hypot(w, h) / 2;
	const half = Math.min(Math.atan(Math.tan((s.camera.fov * Math.PI) / 360) * aspect), (s.camera.fov * Math.PI) / 360);
	const d = (radius / Math.sin(half)) * 0.74 / s.zoom;
	s.camera.position.set(lookX + Math.cos(s.angle) * Math.cos(elevation) * d, 0.2 + Math.sin(elevation) * d, lookZ + Math.sin(s.angle) * Math.cos(elevation) * d);
	s.camera.lookAt(lookX, 0.2, lookZ);
	const far = d + radius * 4 + 60;
	if (Math.abs(s.camera.far - far) > 1) { s.camera.far = far; s.camera.updateProjectionMatrix(); }
	s.dist = d; applyFog(s, s.level);
	const cards = s.island?.children.find((o) => o.userData.cards);
	if (cards) cards.visible = s.zoom <= 0.6;
	// the neighbours stand round the room up to the room level; closer in they would only crowd the edges
	for (const o of s.island?.children ?? []) if (!o.userData.cards) o.visible = s.zoom <= 1.2;
	// on the island level the rooms' cards speak; the names of figures and things would only crowd them
	const named = s.zoom > 0.6;
	if (named !== s.named) { s.named = named; for (const m of [s.chars, s.objs]) for (const e of m.values()) e.obj.traverse((o) => { if (o.userData.label) o.visible = named; }); }
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
	if (w !== s.size.w || h !== s.size.h) { s.size = { w, h }; s.renderer.setSize(w, h, false); s.post.resize(w, h); s.camera.aspect = w / h; s.camera.updateProjectionMatrix(); fitSprites(s, s.scene); }
	positionCamera(s);
}

function showCatalogue(s: Scene3D, names: string[], level: ModelLevel): void {
	const { t } = s, previous = s.scene.getObjectByName("model-catalogue");
	if (previous) { s.scene.remove(previous); dispose(previous); }
	for (const child of s.scene.children) if (!(child instanceof t.Light) && child !== s.sun.target) child.visible = false;
	const gallery = new t.Group(); gallery.name = "model-catalogue"; gallery.userData.modelCatalogue = true; gallery.userData.owned = true;
	const columns = 5, rows = Math.ceil(names.length / columns);
	for (const [index, name] of names.entries()) {
		const [kind, model] = name.split(":"), group = new t.Group();
		atModelLevel(level, () => {
			let geometry: import("three").BufferGeometry | null = null;
			if (kind === "plant") geometry = plantGeometry(t, model as PlantModel, 0);
			else if (kind === "crop") geometry = cropGeometry(t, model as Parameters<typeof cropGeometry>[1], 2, 0xd2a181);
			else if (kind === "field") geometry = fieldCropGeometry(t, model as Parameters<typeof fieldCropGeometry>[1], 2, 2, 1, 0xd3b963, false);
			else if (kind === "scenery") geometry = sceneryModel(t, model, 2, 2, 0);
			else if (kind === "wild") geometry = wildGeometry(t, model, 0);
			else if (kind === "keeper") geometry = keeperGeometry(t, model!, 0);
			else if (kind === "pen") geometry = buildingGeometry(t, "gehege", 2, 2, 0x9a7a4a, 0, model);
			else if (kind === "figure") group.add(makeFigure(t, { id: "catalogue", skin: 0, own: true, ai: false }).group);
			else if (kind === "cart" || kind === "train") group.add(object(t, { id: name, kind, name, location: s.room.roomId, x: 0, y: 0 } as ObjView, "").obj);
			else if (kind === "track") {
				const { w, h } = dims(s.room);
				group.add(track(s, { id: name, kind: "track", name, location: s.room.roomId, x: 0, y: 0, runs: [[{ x: w / 2 - 1, y: h / 2 }, { x: w / 2, y: h / 2 }, { x: w / 2 + 1, y: h / 2 + 1 }]] } as ObjView).obj);
			} else if (kind === "liner") geometry = linerGeometry(t, 8);
			else if (kind === "site") geometry = siteGeometry(t, "huette", 2, 2, 0x9a7a4a, 0.6);
			else if (kind === "ruin") geometry = ruinGeometry(t, 2, 2, 0);
			else if (kind === "sign") geometry = signGeometry(t);
			else if (kind === "fire") geometry = fireGeometry(t);
			else if (kind === "fish" || kind === "smoked") { const f = fishModel(t, model as FishKind, propMaterial(t), kind === "smoked"); f.tail.rotation.y = 0.3; group.add(f.group); }
			else if (kind === "fence") geometry = fenceGeometry(t, 2, 2);
			else geometry = buildingModel(t, name, 2, 2, 0) ?? buildingGeometry(t, name, 2, 2, 0x9a7a4a, 0);
			if (geometry) group.add(propMesh(t, geometry));
			prepareModelDetails(t, group);
			group.traverse((o) => { const mesh = o as import("three").Mesh; if (mesh.geometry?.userData.modelVariant) { mesh.geometry = mesh.geometry.userData.modelVariant(level); mesh.userData.modelLevel = level; } if (o.userData.detailOnly) o.visible = level === "near"; });
		});
		const bounds = new t.Box3().setFromObject(group), size = bounds.getSize(new t.Vector3()), factor = Math.min(kind === "fish" || kind === "smoked" ? 9 : 1, 2.8 / Math.max(size.x, size.z), 2.7 / size.y);
		group.scale.setScalar(factor); group.position.set((index % columns - 2) * 3.5, -bounds.min.y * factor, (Math.floor(index / columns) - (rows - 1) / 2) * 4);
		gallery.add(group);
		const plate = new t.Mesh(new t.BoxGeometry(3.1, 0.06, 3.1), new t.MeshStandardMaterial({ color: 0x668e45, roughness: 1 })); plate.position.set(group.position.x, -0.07, group.position.z); gallery.add(plate);
		const caption = label(t, name, "#e5e9ed"); caption.position.set(group.position.x, -0.1, group.position.z + 1.7); gallery.add(caption);
	}
	s.catalogue = true; s.zoom = 1.4; s.scene.add(gallery); shade(gallery, true);
	s.camera.position.set(0, 22, 27); s.camera.lookAt(0, 0, 0); s.camera.updateProjectionMatrix(); fitSprites(s, gallery);
}

function pointer(s: Scene3D, latest: { current: MapRendererProps }, view: { current: { zoomBy: (f: number) => void; turned: (angle: number) => void; tiltBy: (degrees: number) => void } }): void {
	const t = s.t, ray = new t.Raycaster(), mouse = new t.Vector2(), plane = new t.Plane(new t.Vector3(0, 1, 0), -0.25), hit = new t.Vector3();
	/** The point of the ground at a place on the screen. */
	const ground = (x: number, y: number) => {
		const r = s.canvas.getBoundingClientRect(); mouse.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
		s.camera.updateMatrixWorld(); ray.setFromCamera(mouse, s.camera);
		return ray.ray.intersectPlane(plane, hit);
	};
	/** The cell under the pointer: the column of the terrain the ray meets first (the terraces stand at different heights,
	 *  so a flat plane would name the cell behind a raised one); off the terrain, none. */
	const cell = (e: PointerEvent) => {
		const r = s.canvas.getBoundingClientRect(); mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
		s.camera.updateMatrixWorld(); ray.setFromCamera(mouse, s.camera);
		const columns = s.ground?.children.filter((o) => (o as import("three").InstancedMesh).isInstancedMesh && o.userData.cells) ?? [];
		const first = ray.intersectObjects(columns, false)[0];
		const cells = first?.object.userData.cells as Array<{ x: number; y: number }> | undefined;
		if (first && cells && first.instanceId !== undefined) return cells[first.instanceId] ?? null;
		if (!ground(e.clientX, e.clientY)) return null;
		const { w, h } = dims(s.room), x = Math.floor(hit.x + w / 2), y = Math.floor(hit.z + h / 2);
		return x >= 0 && y >= 0 && x < w && y < h ? { x, y } : null;
	};
	/** The cell of the figure whose speech bubble is under the pointer (a tap there opens that figure's menu: accept an
	 *  offer it made, look at it, chat), or none. */
	// sprites live on layer 1 (fitSprites): a ray of its own sees them
	const talkRay = new t.Raycaster(); talkRay.layers.set(1);
	const bubbleAt = (x: number, y: number) => {
		const shown = [...s.bubbles].filter(([, b]) => b.sprite.visible);
		if (!shown.length) return null;
		const r = s.canvas.getBoundingClientRect(); mouse.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
		s.camera.updateMatrixWorld(); talkRay.setFromCamera(mouse, s.camera);
		const first = talkRay.intersectObjects(shown.map(([, b]) => b.sprite), false)[0];
		const id = first && shown.find(([, b]) => b.sprite === first.object)?.[0], c = id ? latest.current.chars.get(id) : undefined;
		return c ? { x: c.x, y: c.y } : null;
	};
	// for automated checks in development only: the cell a screen point names, and where a point of a cell is on the screen
	if (process.env.NODE_ENV !== "production") Object.assign(s.canvas, {
		probeCell: (clientX: number, clientY: number) => cell({ clientX, clientY } as PointerEvent),
		probeBubble: (clientX: number, clientY: number) => bubbleAt(clientX, clientY),
		probeDetail: () => {
			const barrels: Array<{ near: boolean; distance: number }> = [];
			s.scene.traverse((o) => { const mesh = o as import("three").Mesh; if (String(mesh.geometry?.userData.model ?? "").startsWith("barrel")) barrels.push({ near: mesh.userData.modelLevel === "near", distance: s.camera.position.distanceTo(mesh.getWorldPosition(new t.Vector3())) }); });
			return { barrels, cobblestones: s.paving?.visible ? s.paving.count : 0, blur: closeBlur(s.zoom) };
		},
		probeView: () => ({ zoom: s.zoom, angle: s.angle, tilt: s.tilt, elevation: cameraElevation(s.zoom, s.tilt), bubbles: s.bubbles.size }),
		probeCatalogue: (names: string[], level: ModelLevel = "room") => showCatalogue(s, names, level),
		probeModels: () => {
			const models: Array<{ name: string; level: string; triangles: number }> = [];
			s.scene.traverse((o) => { const mesh = o as import("three").Mesh; if (mesh.geometry?.userData.modelVariant) models.push({ name: mesh.geometry.userData.model, level: mesh.userData.modelLevel ?? "room", triangles: mesh.geometry.getAttribute("position").count / 3 }); });
			return models;
		},
		/** a world hour for the light instead of the clock (screenshots of the night) */
		probeHour: (hour: number | null) => { s.hourProbe = hour; s.lightAt = 0; },
		probeScreen: (x: number, y: number, dx = 0, dz = 0) => { const p = at(s, x, y, 0).add(new t.Vector3(dx, 0, dz)).project(s.camera), r = s.canvas.getBoundingClientRect(); return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }; },
	});
	let down: { x: number; y: number; at: { x: number; y: number } | null; talk?: boolean; long: boolean; turn: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
	const fingers = pinch();
	const onDown = (e: PointerEvent) => {
		if (e.button === 2) return;
		// a second finger: a pinch, no tap, no long press, no turn
		if (fingers.down(e.pointerId, e.clientX, e.clientY)) { if (down) clearTimeout(down.timer); if (dragged) view.current.turned(s.angle); down = null; dragged = false; return; }
		if (fingers.active) return;
		// the wheel held down turns the view (no tap, no menu)
		if (e.button === 1) { e.preventDefault(); down = { x: e.clientX, y: e.clientY, at: null, long: false, turn: true, timer: setTimeout(() => {}, 0) }; return; }
		// a speech bubble stands over its speaker (also over the sea): a tap on it is a tap on the speaker's menu
		const talk = bubbleAt(e.clientX, e.clientY), at = talk ?? cell(e); down = { x: e.clientX, y: e.clientY, at, talk: !!talk, long: false, turn: false, timer: setTimeout(() => { if (down?.at) { down.long = true; latest.current.onMenu(down.at.x, down.at.y, e.clientX, e.clientY); } }, LONG_PRESS_MS) };
	};
	// dragging moves the view over the ground as in 2D, the ground stays under the pointer; with the wheel held down or
	// with Shift it turns the view
	// around the room (the camera follows the pointer live, the angle is kept when the pointer is lifted)
	let last = { x: 0, y: 0 }, dragged = false;
	const onMove = (e: PointerEvent) => {
		const spread = fingers.move(e.pointerId, e.clientX, e.clientY);
		// two fingers zoom and turn at once: the room turns with them (the state too: its effect would set the old angle back)
		if (spread !== null) {
			// what lies between the fingers stays there: the view moves over the ground by what the zoom and the turn shifted
			const c = fingers.center!, before = ground(c.x, c.y)?.clone(), a = s.angle - fingers.twist, z = clampZoom(s.zoom * spread);
			view.current.zoomBy(spread); view.current.turned(a);
			s.angle = a; s.zoom = z; positionCamera(s);
			const after = ground(c.x, c.y);
			if (before && after) { s.panX += before.x - after.x; s.panZ += before.z - after.z; positionCamera(s); }
			fingers.rebase();
			return;
		}
		if (!down) return;
		if (!dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) { dragged = true; clearTimeout(down.timer); down.at = null; last = { x: down.x, y: down.y }; s.canvas.setPointerCapture?.(e.pointerId); }
		if (!dragged) return;
		const dx = e.clientX - last.x, dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
		if (down.turn || e.shiftKey) s.angle += dx * 0.008; // the room turns with the pointer
		else {
			// world units per pixel at the point looked at; the ground is foreshortened in depth by the camera's elevation
			const unit = (2 * s.dist * Math.tan((s.camera.fov * Math.PI) / 360)) / Math.max(1, s.size.h);
			const fx = -Math.cos(s.angle), fz = -Math.sin(s.angle); // forward on the ground; right is (-fz, fx)
			const side = dx * unit, depth = (dy * unit) / Math.sin(cameraElevation(s.zoom, s.tilt));
			s.panX += fz * side + fx * depth; s.panZ += -fx * side + fz * depth;
		}
		positionCamera(s);
	};
	const onUp = (e: PointerEvent) => { fingers.up(e.pointerId); if (!down) return; clearTimeout(down.timer); if (down.at && !down.long) { if (down.talk) latest.current.onMenu(down.at.x, down.at.y, e.clientX, e.clientY); else latest.current.onCell(down.at.x, down.at.y); } if (dragged) view.current.turned(s.angle); dragged = false; down = null; };
	// a click of the wheel scrolls the page by itself in some browsers: not on the map
	const onMouseDown = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };
	let mapAlt = false;
	const onMapAlt = (e: KeyboardEvent) => {
		if (e.key !== "Alt") return;
		if (e.type === "keyup" && mapAlt) { e.preventDefault(); mapAlt = false; return; }
		if (s.canvas.matches(":hover") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); mapAlt = e.type === "keydown"; }
	};
	const onBlur = () => { mapAlt = false; };
	window.addEventListener("keydown", onMapAlt, true); window.addEventListener("keyup", onMapAlt, true); window.addEventListener("blur", onBlur);
	const onWheel = (e: WheelEvent) => { e.preventDefault(); const action = wheelView(e.deltaY, e.altKey); if (e.altKey) { mapAlt = true; view.current.tiltBy(action.tiltDelta); } else view.current.zoomBy(action.zoomFactor); };
	const onContext = (e: MouseEvent) => { e.preventDefault(); const at = cell(e as PointerEvent); if (at) latest.current.onMenu(at.x, at.y, e.clientX, e.clientY); };
	Object.assign(s.canvas.dataset, { map3d: "1" }); s.canvas.addEventListener("pointerdown", onDown); s.canvas.addEventListener("pointermove", onMove); s.canvas.addEventListener("pointerup", onUp); s.canvas.addEventListener("pointercancel", onUp); s.canvas.addEventListener("contextmenu", onContext); s.canvas.addEventListener("wheel", onWheel, { passive: false }); s.canvas.addEventListener("mousedown", onMouseDown);
	(s.canvas as HTMLCanvasElement & { mapCleanup?: () => void }).mapCleanup = () => { window.removeEventListener("keydown", onMapAlt, true); window.removeEventListener("keyup", onMapAlt, true); window.removeEventListener("blur", onBlur); s.canvas.removeEventListener("pointerdown", onDown); s.canvas.removeEventListener("pointermove", onMove); s.canvas.removeEventListener("pointerup", onUp); s.canvas.removeEventListener("pointercancel", onUp); s.canvas.removeEventListener("contextmenu", onContext); s.canvas.removeEventListener("wheel", onWheel); s.canvas.removeEventListener("mousedown", onMouseDown); };
}
function fadeOut(s: Scene3D, obj: O3): void {
	const from = performance.now();
	const tick = () => {
		const k = 1 - (performance.now() - from) / 900;
		if (k <= 0 || state3dGone(s)) { s.scene.remove(obj); dispose(obj); return; }
		obj.scale.set(k, k * k, k);
		requestAnimationFrame(tick);
	};
	tick();
}
const state3dGone = (s: Scene3D) => !s.canvas.isConnected;
function unpointer(s: Scene3D): void { (s.canvas as HTMLCanvasElement & { mapCleanup?: () => void }).mapCleanup?.(); }
function prevent(e: Event): void { e.preventDefault(); }
function stored(key: string, fallback: number): number { try { const raw = localStorage.getItem(key); if (raw === null) return fallback; const n = Number(raw); return Number.isFinite(n) ? n : fallback; } catch { return fallback; } }
function store(key: string, value: number): void { try { localStorage.setItem(key, String(value)); } catch { /* private window */ } }
function remove(s: Scene3D, map: Map<string, Entry>, id: string): void { const e = map.get(id); if (e) { s.scene.remove(e.obj); dispose(e.obj); } map.delete(id); }
/** Frees what the 3D object made; the textures shared between rooms (tile art, the shadow) live on. */
function dispose(root: O3): void {
	root.traverse((o) => {
		const m = o as import("three").Mesh;
		// the models' geometries and materials are made once and shared (props3d.ts): only what an object owns goes
		if (!m.geometry?.userData.shared) m.geometry?.dispose?.();
		const materials = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
		for (const material of materials) { if (material.userData.shared) continue; const mm = material as import("three").MeshStandardMaterial; if (mm.map && !mm.map.userData.shared) mm.map.dispose(); material.dispose(); }
	});
}
