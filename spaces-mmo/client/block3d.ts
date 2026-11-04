// The room as a diorama block (docs/3D-V2/README.md): under the tiles a cut block whose land sides show rock strata and
// whose sea sides show the water as a volume, with a soft shadow below it on the void. The island level draws every room
// of the atlas as such a block, with a plain lid of tile colours instead of the tile art. Visual only.
import { tile3d } from "./terrain3d.ts";
import { fishModel, type FishKind } from "./fish3d.ts";
import { propMaterial } from "./props3d.ts";

type T = typeof import("three");
type Geo = import("three").BufferGeometry;

/** How deep the block reaches below the ground (world units; a cell is 1). */
export const BLOCK_DEPTH = 2.6;

let strata: import("three").CanvasTexture | null = null;
/** The rock strata of a land side, top to bottom: earth, sand, a dark seam, sandstone, clay, grey rock. */
function strataTexture(t: T): import("three").CanvasTexture {
	if (strata) return strata;
	const c = document.createElement("canvas"); c.width = 8; c.height = 256;
	const g = c.getContext("2d")!;
	const bands: Array<[number, string]> = [[0.08, "#5b4632"], [0.2, "#6b5a46"], [0.26, "#4a3a2c"], [0.44, "#7a6a56"], [0.5, "#3e3025"], [0.7, "#6e6152"], [0.78, "#56493c"], [1, "#4a4a4e"]];
	let from = 0;
	for (const [to, colour] of bands) { g.fillStyle = colour; g.fillRect(0, from * 256, 8, (to - from) * 256 + 1); from = to; }
	strata = new t.CanvasTexture(c); strata.colorSpace = t.SRGBColorSpace; strata.magFilter = t.NearestFilter; strata.userData.shared = true;
	return strata;
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
export function sides(t: T, ground: string[], water: (key: string) => boolean, depth: number): { land: Geo; sea: Geo; bed: Geo; edges: SeaEdge[] } {
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
		else { land.pos.push(...p); const u0 = ax + az, u1 = bx + bz; land.uv.push(u1, 1, u0, 1, u1, 0, u0, 1, u0, 0, u1, 0); }
	};
	const x0 = -w / 2, z0 = -h / 2;
	for (let x = 0; x < w; x++) {
		quad(x0 + x + 1, z0, x0 + x, z0, water(ground[0]![x]!), 0, 1); // north, facing -z
		quad(x0 + x, z0 + h, x0 + x + 1, z0 + h, water(ground[h - 1]![x]!), 0, -1); // south, facing +z
	}
	for (let y = 0; y < h; y++) {
		quad(x0, z0 + y, x0, z0 + y + 1, water(ground[y]![0]!), 1, 0); // west, facing -x
		quad(x0 + w, z0 + y + 1, x0 + w, z0 + y, water(ground[y]![w - 1]!), -1, 0); // east, facing +x
	}
	const a = new t.BufferGeometry(); a.setAttribute("position", new t.Float32BufferAttribute(land.pos, 3)); a.setAttribute("uv", new t.Float32BufferAttribute(land.uv, 2)); a.computeVertexNormals();
	const b = new t.BufferGeometry(); b.setAttribute("position", new t.Float32BufferAttribute(sea.pos, 3)); b.setAttribute("color", new t.Float32BufferAttribute(sea.col, 3)); b.computeVertexNormals();
	const c = new t.BufferGeometry(); c.setAttribute("position", new t.Float32BufferAttribute(bed.pos, 3)); c.setAttribute("color", new t.Float32BufferAttribute(bed.col, 3)); c.computeVertexNormals();
	return { land: a, sea: b, bed: c, edges };
}

/** The block under a room's tiles: its sides and the shadow it casts on the void below. */
export function blockUnder(t: T, ground: string[], tiles: Record<string, { walk: boolean }>, depth = BLOCK_DEPTH): import("three").Group {
	const group = new t.Group(), h = ground.length, w = ground[0]?.length ?? 0;
	const water = (key: string) => tile3d(key, !!tiles[key]?.walk).water;
	const { land, sea, bed, edges } = sides(t, ground, water, depth);
	const tex = strataTexture(t);
	group.add(new t.Mesh(land, new t.MeshStandardMaterial({ map: tex, roughness: 1 })));
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
 *  art), its sides, its shadow. Cheap enough to draw every room of an island at once. */
export function islandBlock(t: T, ground: string[], tiles: Record<string, { walk: boolean }>, haze = 0, depth = BLOCK_DEPTH): import("three").Group {
	const group = blockUnder(t, ground, tiles, depth), h = ground.length, w = ground[0]?.length ?? 0;
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
 *  school (the members share one path, each a little offset); the plaice glides over the sand slope. */
export type Fish = { group: import("three").Group; tail: import("three").Mesh; kind: FishKind; x: number; z: number; dx: number; dz: number; span: number; y: number; ix: number; iz: number; phase: number; speed: number; hx: number; hz: number; along: number; inward: number };
/** Fish for the sea sides of the room's block (fish3d.ts models, the shared model material); `swimFish` moves them. */
export function fishFor(t: T, edges: SeaEdge[], w: number, h0: number, seed: number, depth = BLOCK_DEPTH): Fish[] {
	if (!edges.length) return [];
	let h = seed || 1;
	const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10_000) / 10_000; };
	const units = Math.min(8, Math.max(2, Math.round(edges.length / 6))), out: Fish[] = [], material = propMaterial(t);
	const bed = (inward: number) => -depth + 0.15 + (-0.3 + depth - 0.15) * (inward / 1.6);
	for (let u = 0; u < units; u++) {
		const e = edges[Math.floor(rnd() * edges.length)]!, k = rnd(), r = rnd();
		const kind: FishKind = r < 0.45 ? "hering" : r < 0.78 ? "dorsch" : "scholle";
		const members = kind === "hering" ? 4 + Math.floor(rnd() * 4) : 1;
		const base = { kind, x: e.ax + (e.bx - e.ax) * k, z: e.az + (e.bz - e.az) * k, dx: e.bx - e.ax, dz: e.bz - e.az, span: 1 + rnd() * 2.5, ix: e.ix, iz: e.iz, phase: rnd() * Math.PI * 2, speed: (kind === "scholle" ? 0.12 : 0.25) + rnd() * 0.3, hx: w / 2 - 0.25, hz: h0 / 2 - 0.25 };
		const y = kind === "scholle" ? bed(0.32) + 0.03 : -0.4 - rnd() * (depth - 1.3);
		for (let m = 0; m < members; m++) {
			const { group, tail } = fishModel(t, kind, material);
			group.scale.setScalar(kind === "hering" ? 1.3 + rnd() * 0.3 : 1.4 + rnd() * 0.5);
			group.traverse((o) => { o.userData.unshaded = true; });
			group.renderOrder = 2;
			out.push({ ...base, group, tail, y: y + (m ? (rnd() - 0.5) * 0.25 : 0), along: m ? (rnd() - 0.5) * 0.7 : 0, inward: kind === "scholle" ? 0.32 : 0.3 + (m ? rnd() * 0.25 : 0.05) });
		}
	}
	return out;
}
/** Moves the fish to time `time` (seconds): each swims to and fro along its edge, turns at the ends and beats its tail. */
export function swimFish(fish: Fish[], time: number): void {
	for (const f of fish) {
		const a = time * f.speed + f.phase, along = Math.sin(a) * f.span + f.along, dir = Math.cos(a) >= 0 ? 1 : -1;
		const inward = f.inward + (f.kind === "scholle" ? 0 : 0.08 * Math.sin(a * 1.7 + f.along * 5));
		// never past the block's corners: there it would hang in the air
		const x = Math.max(-f.hx, Math.min(f.hx, f.x + f.dx * along + f.ix * inward)), z = Math.max(-f.hz, Math.min(f.hz, f.z + f.dz * along + f.iz * inward));
		f.group.position.set(x, f.y + (f.kind === "scholle" ? 0 : Math.sin(a * 2.3 + f.along * 3) * 0.05), z);
		f.group.rotation.y = Math.atan2(-f.dz * dir, f.dx * dir);
		// the tail beats faster the faster the fish goes (sideways; the flat plaice's up and down)
		const beat = Math.sin(time * (9 + f.speed * 14) + f.phase * 3 + f.along * 7) * 0.45;
		if (f.kind === "scholle") f.tail.rotation.z = beat * 0.6; else f.tail.rotation.y = beat;
	}
}
