// The room as a diorama block (docs/3D-V2/README.md): under the tiles a cut block whose land sides show rock strata and
// whose sea sides show the water as a volume, with a soft shadow below it on the void. The island level draws every room
// of the atlas as such a block, with a plain lid of tile colours instead of the tile art. Visual only.
import { tile3d } from "./terrain3d.ts";
import { fishBody, fishTail, tailRoot, type FishKind } from "./fish3d.ts";
import { propMaterial } from "./props3d.ts";
import { groundMaps } from "./ground3d.ts";
import { cellEdge } from "./cell3d.ts";

type T = typeof import("three");
type Geo = import("three").BufferGeometry;

/** How deep the block reaches below the ground (world units; a cell of scale 1 is 1). */
export const BLOCK_DEPTH = 2.6;

let strata: import("three").CanvasTexture | null = null;
/** The rock strata of a land side, top to bottom: earth, sand, a dark seam, sandstone, clay, grey rock. Until the
 *  photographed rock has loaded this is the side's colour, afterwards its tint over the rock. */
function strataTexture(t: T): import("three").CanvasTexture {
	if (strata) return strata;
	const c = document.createElement("canvas"); c.width = 8; c.height = 256;
	const g = c.getContext("2d")!;
	const bands: Array<[number, string]> = [[0.08, "#5b4632"], [0.2, "#6b5a46"], [0.26, "#4a3a2c"], [0.44, "#7a6a56"], [0.5, "#3e3025"], [0.7, "#6e6152"], [0.78, "#56493c"], [1, "#4a4a4e"]];
	let from = 0;
	for (const [to, colour] of bands) { g.fillStyle = colour; g.fillRect(0, from * 256, 8, (to - from) * 256 + 1); from = to; }
	strata = new t.CanvasTexture(c); strata.colorSpace = t.SRGBColorSpace; strata.userData.shared = true;
	return strata;
}

/** How much brighter the strata's tint is over the photographed rock than as a colour of its own. */
const STRATA_GAIN = 2.3;
/** The material of a block's land sides: photographed rock (ground3d.ts) tinted by the strata, whose bands waver a
 *  little along the side. The uv is in cells (u along the side, v down from the top); `depth` is the block's depth. */
function rockSide(t: T, depth: number, anisotropy: number): import("three").MeshStandardMaterial {
	const material = new t.MeshStandardMaterial({ roughness: 1, metalness: 0 });
	const uniforms = { uStrata: { value: strataTexture(t) }, uStrataGain: { value: 1 }, uDepth: { value: depth } };
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vBlockUv;")
			.replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvBlockUv = uv;");
		shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nuniform sampler2D uStrata;\nuniform float uStrataGain;\nuniform float uDepth;\nvarying vec2 vBlockUv;")
			.replace("#include <color_fragment>", `#include <color_fragment>
	float strataAt = vBlockUv.y / uDepth + 0.022 * sin( vBlockUv.x * 0.53 + 1.0 ) + 0.012 * sin( vBlockUv.x * 1.7 );
	diffuseColor.rgb *= texture2D( uStrata, vec2( 0.5, clamp( strataAt, 0.004, 0.996 ) ) ).rgb * uStrataGain;`);
	};
	material.customProgramCacheKey = () => "block3d:rock";
	void groundMaps(t, "rock", 2, anisotropy).then((m) => {
		if (!m) return;
		material.map = m.color; material.normalMap = m.normal; material.roughnessMap = m.arm; material.aoMap = m.arm;
		uniforms.uStrataGain.value = STRATA_GAIN; material.needsUpdate = true;
	});
	return material;
}

let blob: import("three").CanvasTexture | null = null;
function blobTexture(t: T): import("three").CanvasTexture {
	if (blob) return blob;
	const c = document.createElement("canvas"); c.width = c.height = 128;
	const g = c.getContext("2d")!, grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
	grad.addColorStop(0, "rgba(0,0,0,.6)"); grad.addColorStop(0.6, "rgba(0,0,0,.3)"); grad.addColorStop(1, "rgba(0,0,0,0)");
	g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
	blob = new t.CanvasTexture(c); blob.userData.shared = true;
	return blob;
}

/** One quad per border cell and side, from `bottom` up to `top`, facing out; the land ones in one geometry with uvs on the
 *  strata (v by height, so the bands line up along the whole side), the sea ones in another with a colour per vertex. */
/** A border cell's sea side: its two ends and the way into the room (for the seabed and the fish behind it). */
export type SeaEdge = { ax: number; az: number; bx: number; bz: number; ix: number; iz: number };
/** `e` is a cell's edge in world units (cell3d.ts): the quads are a cell long, the strata and the seabed in world units. */
export function sides(t: T, ground: string[], water: (key: string) => boolean, depth: number, e = cellEdge()): { land: Geo; sea: Geo; bed: Geo; edges: SeaEdge[] } {
	const h = ground.length, w = ground[0]?.length ?? 0;
	const land = { pos: [] as number[], uv: [] as number[] }, sea = { pos: [] as number[], col: [] as number[] };
	const bed = { pos: [] as number[], col: [] as number[] }, edges: SeaEdge[] = [];
	// sand seen through water: tinted towards the sea's blue
	const sand = new t.Color(0xc9b27a).lerp(new t.Color(0x2f8fb0), 0.55), dark = new t.Color(0x0c2a3c);
	const top = 0, bottom = -depth;
	const deep = new t.Color(0x0f3f62), light = new t.Color(0x4aa6d6);
	// behind a sea side, seen through it: the seabed slopes from deep at the edge up into the room (SEABED cells in), and a
	// dark wall closes the volume there; both face the outside viewer
	const SEABED = 1.6, rise = -0.3, low = bottom + 0.15;
	const tri = (o: { pos: number[]; col: number[] }, p: number[], cs: import("three").Color[]) => { o.pos.push(...p); for (const c of cs) o.col.push(c.r, c.g, c.b); };
	const quad = (ax: number, az: number, bx: number, bz: number, wet: boolean, ix = 0, iz = 0) => {
		// two triangles from b to a, so that with a on the left of an outside viewer the face looks out (counter-clockwise)
		const p = [bx, top, bz, ax, top, az, bx, bottom, bz, ax, top, az, ax, bottom, az, bx, bottom, bz];
		if (wet) {
			sea.pos.push(...p); for (const y of [top, top, bottom, top, bottom, bottom]) { const c = y === top ? light : deep; sea.col.push(c.r, c.g, c.b); }
			edges.push({ ax, az, bx, bz, ix, iz });
			const fx = SEABED * ix, fz = SEABED * iz, e = 0.02;
			const nax = ax + ix * e, naz = az + iz * e, nbx = bx + ix * e, nbz = bz + iz * e;
			// the slope: near edge low, far edge high (its face up and out)
			tri(bed, [nbx, low, nbz, nax + fx, rise, naz + fz, nax, low, naz, nbx, low, nbz, nbx + fx, rise, nbz + fz, nax + fx, rise, naz + fz], [sand, sand, sand, sand, sand, sand].map((c, i) => c.clone().multiplyScalar(i === 1 || i === 4 || i === 5 ? 0.95 : 0.55)));
			// the back wall from the top of the slope up to the water
			tri(bed, [nbx + fx, top - 0.05, nbz + fz, nax + fx, top - 0.05, naz + fz, nbx + fx, rise, nbz + fz, nax + fx, top - 0.05, naz + fz, nax + fx, rise, naz + fz, nbx + fx, rise, nbz + fz], [dark, dark, dark, dark, dark, dark]);
		}
		else { land.pos.push(...p); const u0 = ax + az, u1 = bx + bz; land.uv.push(u1, depth, u0, depth, u1, 0, u0, depth, u0, 0, u1, 0); }
	};
	// a cell's border in world units, n cells from the room's west (north) edge
	const bx = (n: number) => (n - w / 2) * e, bz = (n: number) => (n - h / 2) * e;
	for (let x = 0; x < w; x++) {
		quad(bx(x + 1), bz(0), bx(x), bz(0), water(ground[0]![x]!), 0, 1); // north, facing -z
		quad(bx(x), bz(h), bx(x + 1), bz(h), water(ground[h - 1]![x]!), 0, -1); // south, facing +z
	}
	for (let y = 0; y < h; y++) {
		quad(bx(0), bz(y), bx(0), bz(y + 1), water(ground[y]![0]!), 1, 0); // west, facing -x
		quad(bx(w), bz(y + 1), bx(w), bz(y), water(ground[y]![w - 1]!), -1, 0); // east, facing +x
	}
	const a = new t.BufferGeometry(); a.setAttribute("position", new t.Float32BufferAttribute(land.pos, 3)); a.setAttribute("uv", new t.Float32BufferAttribute(land.uv, 2)); a.computeVertexNormals();
	const b = new t.BufferGeometry(); b.setAttribute("position", new t.Float32BufferAttribute(sea.pos, 3)); b.setAttribute("color", new t.Float32BufferAttribute(sea.col, 3)); b.computeVertexNormals();
	const c = new t.BufferGeometry(); c.setAttribute("position", new t.Float32BufferAttribute(bed.pos, 3)); c.setAttribute("color", new t.Float32BufferAttribute(bed.col, 3)); c.computeVertexNormals();
	return { land: a, sea: b, bed: c, edges };
}

/** The block under a room's tiles: its sides and the shadow it casts on the void below; `e` a cell's edge (cell3d.ts). */
export function blockUnder(t: T, ground: string[], tiles: Record<string, { walk: boolean }>, depth = BLOCK_DEPTH, anisotropy = 4, e = cellEdge()): import("three").Group {
	const group = new t.Group(), h = ground.length * e, w = (ground[0]?.length ?? 0) * e;
	const water = (key: string) => tile3d(key, !!tiles[key]?.walk).water;
	const { land, sea, bed, edges } = sides(t, ground, water, depth, e);
	group.add(new t.Mesh(land, rockSide(t, depth, anisotropy)));
	// the seabed and its back wall first, then the sea's side over them: lighter at the surface, deep below, a little
	// light of its own (the hemisphere's ground colour would turn a side face green), and clear enough to see the sand
	// slope and the fish through it
	const floor = new t.Mesh(bed, new t.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: t.DoubleSide }));
	floor.userData.unshaded = true; group.add(floor);
	const glass = new t.Mesh(sea, new t.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.05, emissive: 0x0b4a78, emissiveIntensity: 0.6, transparent: true, opacity: 0.45, depthWrite: false }));
	glass.renderOrder = 3; glass.userData.unshaded = true; group.add(glass);
	group.userData.seaEdges = edges;
	const shadow = new t.Mesh(new t.PlaneGeometry(w * 1.5, h * 1.6), new t.MeshBasicMaterial({ map: blobTexture(t), transparent: true, depthWrite: false, fog: false }));
	shadow.rotation.x = -Math.PI / 2; shadow.position.y = -depth - 1.4;
	group.add(shadow);
	return group;
}

/** A neighbour's block for the island level: a lid of flat tile colours at the tiles' heights (one merged geometry, no
 *  art), its sides, its shadow. Cheap enough to draw every room of an island at once. `ground` is the atlas's preview,
 *  one cell per `sample` × `sample` game cells: one world unit at every scale (cell3d.ts). */
export function islandBlock(t: T, ground: string[], tiles: Record<string, { walk: boolean }>, haze = 0, depth = BLOCK_DEPTH): import("three").Group {
	const group = blockUnder(t, ground, tiles, depth, 4, 1), h = ground.length, w = ground[0]?.length ?? 0;
	const pos: number[] = [], col: number[] = [], c = new t.Color(), grey = new t.Color(0x8a919c);
	const box = (x: number, z: number, top: number, colour: number) => {
		c.setHex(colour).lerp(grey, Math.min(0.85, Math.max(0, haze)));
		const x1 = x + 1, z1 = z + 1, s = 0.72;
		// the top and the four sides of a cell's column from 0 to its height (sides darker)
		const faces: Array<[number[], number]> = [
			[[x, top, z, x, top, z1, x1, top, z, x1, top, z, x, top, z1, x1, top, z1], 1],
			[[x, 0, z1, x1, 0, z1, x, top, z1, x1, 0, z1, x1, top, z1, x, top, z1], s],
			[[x1, 0, z, x, 0, z, x1, top, z, x, 0, z, x, top, z, x1, top, z], s],
			[[x1, 0, z1, x1, 0, z, x1, top, z1, x1, 0, z, x1, top, z, x1, top, z1], s],
			[[x, 0, z, x, 0, z1, x, top, z, x, 0, z1, x, top, z1, x, top, z], s],
		];
		for (const [p, k] of faces) { pos.push(...p); for (let i = 0; i < 6; i++) col.push(c.r * k, c.g * k, c.b * k); }
	};
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const key = ground[y]![x]!, v = tile3d(key, !!tiles[key]?.walk);
		box(x - w / 2, y - h / 2, v.height, v.color);
	}
	const lid = new t.BufferGeometry(); lid.setAttribute("position", new t.Float32BufferAttribute(pos, 3)); lid.setAttribute("color", new t.Float32BufferAttribute(col, 3)); lid.computeVertexNormals();
	group.add(new t.Mesh(lid, new t.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true })));
	return group;
}

/** A room's name card over its block on the island level: the name and how many are there, the same size on the screen
 *  however far the camera stands. */
export function nameCard(t: T, name: string, people: number, here: boolean): import("three").Sprite {
	const canvas = document.createElement("canvas"), g = canvas.getContext("2d")!, text = people > 0 ? `${name} · ${people}` : name;
	canvas.width = 512; canvas.height = 96; g.font = "700 40px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
	const wide = Math.min(500, g.measureText(text).width + 48);
	g.fillStyle = here ? "rgba(174,216,60,.95)" : "rgba(244,234,208,.92)";
	g.beginPath(); g.roundRect((512 - wide) / 2, 12, wide, 72, 18); g.fill();
	g.fillStyle = "#2b2418"; g.fillText(text, 256, 49);
	const texture = new t.CanvasTexture(canvas); texture.colorSpace = t.SRGBColorSpace;
	const sprite = new t.Sprite(new t.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false, fog: false }));
	sprite.userData.px = [210, 39]; sprite.center.set(0.5, 0); sprite.renderOrder = 12;
	return sprite;
}

/** A fish behind the sea side, and where it swims: along its edge, to and fro, at its own depth. A herring swims in a
 *  school (the members share one path, each a little offset); the plaice glides over the sand slope. `pos`, `turn` and
 *  `beat` are where it is now, which way it looks and how its tail stands (swimFish). */
export type Fish = { kind: FishKind; x: number; z: number; dx: number; dz: number; span: number; y: number; ix: number; iz: number; phase: number; speed: number; hx: number; hz: number; along: number; inward: number; scale: number; pos: { x: number; y: number; z: number }; turn: number; beat: number };
/** Fish for the sea sides of the room's block: where each swims; `fishSchool` draws them, `swimFish` moves them. `w` and
 *  `h0` are the room's extent in world units; the fish's number goes by the sea sides' length, not their cells. */
export function fishFor(edges: SeaEdge[], w: number, h0: number, seed: number, depth = BLOCK_DEPTH): Fish[] {
	if (!edges.length) return [];
	let h = seed || 1;
	const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10_000) / 10_000; };
	const length = edges.reduce((sum, e) => sum + Math.hypot(e.bx - e.ax, e.bz - e.az), 0);
	const units = Math.min(8, Math.max(2, Math.round(length / 6))), out: Fish[] = [];
	const bed = (inward: number) => -depth + 0.15 + (-0.3 + depth - 0.15) * (inward / 1.6);
	for (let u = 0; u < units; u++) {
		const e = edges[Math.floor(rnd() * edges.length)]!, k = rnd(), r = rnd();
		const kind: FishKind = r < 0.45 ? "hering" : r < 0.78 ? "dorsch" : "scholle";
		const members = kind === "hering" ? 4 + Math.floor(rnd() * 4) : 1;
		const base = { kind, x: e.ax + (e.bx - e.ax) * k, z: e.az + (e.bz - e.az) * k, dx: (e.bx - e.ax) / Math.hypot(e.bx - e.ax, e.bz - e.az), dz: (e.bz - e.az) / Math.hypot(e.bx - e.ax, e.bz - e.az), span: 1 + rnd() * 2.5, ix: e.ix, iz: e.iz, phase: rnd() * Math.PI * 2, speed: (kind === "scholle" ? 0.12 : 0.25) + rnd() * 0.3, hx: w / 2 - 0.25, hz: h0 / 2 - 0.25 };
		const y = kind === "scholle" ? bed(0.32) + 0.03 : -0.4 - rnd() * (depth - 1.3);
		for (let m = 0; m < members; m++) {
			const scale = kind === "hering" ? 1.3 + rnd() * 0.3 : 1.4 + rnd() * 0.5;
			out.push({ ...base, scale, y: y + (m ? (rnd() - 0.5) * 0.25 : 0), along: m ? (rnd() - 0.5) * 0.7 : 0, inward: kind === "scholle" ? 0.32 : 0.3 + (m ? rnd() * 0.25 : 0.05), pos: { x: 0, y: 0, z: 0 }, turn: 0, beat: 0 });
		}
	}
	return out;
}
/** The fish as meshes (fish3d.ts models, the shared model material): all bodies of a kind are one instanced mesh and all
 *  its tails another, so a room's fish are at most six draw calls. `draw` puts them where `swimFish` moved them. */
export function fishSchool(t: T, fish: Fish[]): { group: import("three").Group; draw(): void } {
	const group = new t.Group(); group.renderOrder = 2;
	const kinds = [...new Set(fish.map((f) => f.kind))].map((kind) => {
		const members = fish.filter((f) => f.kind === kind);
		const body = new t.InstancedMesh(fishBody(t, kind), propMaterial(t), members.length), tail = new t.InstancedMesh(fishTail(t, kind), propMaterial(t), members.length);
		// under water nothing casts or takes the sun's shadow (MapView3D shade)
		body.userData.unshaded = tail.userData.unshaded = true;
		group.add(body, tail);
		return { kind, members, body, tail };
	});
	const whole = new t.Matrix4(), part = new t.Matrix4(), q = new t.Quaternion(), e = new t.Euler(), p = new t.Vector3(), size = new t.Vector3();
	return {
		group,
		draw() {
			for (const k of kinds) {
				const root = tailRoot(k.kind);
				k.members.forEach((f, i) => {
					whole.compose(p.set(f.pos.x, f.pos.y, f.pos.z), q.setFromEuler(e.set(0, f.turn, 0)), size.setScalar(f.scale));
					k.body.setMatrixAt(i, whole);
					// the tail turns about its root at the body's back end (sideways; the flat plaice's up and down)
					part.makeRotationFromEuler(k.kind === "scholle" ? e.set(0, 0, f.beat) : e.set(0, f.beat, 0)).setPosition(root, 0, 0);
					k.tail.setMatrixAt(i, part.premultiply(whole));
				});
				for (const mesh of [k.body, k.tail]) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
			}
		},
	};
}
/** Moves the fish to time `time` (seconds): each swims to and fro along its edge, turns at the ends and beats its tail. */
export function swimFish(fish: Fish[], time: number): void {
	for (const f of fish) {
		const a = time * f.speed + f.phase, along = Math.sin(a) * f.span + f.along, dir = Math.cos(a) >= 0 ? 1 : -1;
		const inward = f.inward + (f.kind === "scholle" ? 0 : 0.08 * Math.sin(a * 1.7 + f.along * 5));
		// never past the block's corners: there it would hang in the air
		f.pos.x = Math.max(-f.hx, Math.min(f.hx, f.x + f.dx * along + f.ix * inward)); f.pos.z = Math.max(-f.hz, Math.min(f.hz, f.z + f.dz * along + f.iz * inward));
		f.pos.y = f.y + (f.kind === "scholle" ? 0 : Math.sin(a * 2.3 + f.along * 3) * 0.05);
		f.turn = Math.atan2(-f.dz * dir, f.dx * dir);
		// the tail beats faster the faster the fish goes
		f.beat = Math.sin(time * (9 + f.speed * 14) + f.phase * 3 + f.along * 7) * 0.45 * (f.kind === "scholle" ? 0.6 : 1);
	}
}
