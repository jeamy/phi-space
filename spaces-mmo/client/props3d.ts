// Models for the 3D map: trees and bushes, the hut, the rain barrel, the windmill, the bakery, the coop, the pen and the loom, a site that grows with its progress, a ruin, the
// fire's stone ring, a signpost at an exit. Built from primitives in a chunky low-poly style (faceted faces, a few warm
// colours, every face a shade lighter or darker), so they need no model file. Each model is one merged geometry with
// vertex colours, made once per kind and variant and shared (userData.shared: the map's dispose keeps it); where it
// stands, how it is turned and how large it is come from the place, so a room looks the same every time it is drawn.
// Everything here is visual only (docs/architektur.en.md, "3D-Ansicht").
import { stableHash } from "./terrain3d.ts";
import { withAo } from "./ao3d.ts";
import { atModelLevel, modelLevel, modelPrimitive, type ModelLevel } from "./modelDetail3d.ts";

import { SURFACE_COLOUR, SURFACE_HEAD, surfaceLayer, surfaceUniforms, type Surface } from "./surfaces3d.ts";
export type T = typeof import("three");
export type Geo = import("three").BufferGeometry;
export type V3 = [number, number, number];
/** One primitive of a model: its geometry, colour, place, turn and size. */
export type Part = { g: Geo; c: number; p?: V3; r?: V3; s?: V3; m?: Surface | "none" | "leaf" };
/** The colours of lamplight and embers: such faces glow when it gets dark (merge marks them, propMaterial lights them). */
export const LAMPLIGHT = new Set([0xf2c46a, 0xff8a2a]);
/** A part of this "colour" is white in the geometry and takes its colour from the instance (InstancedMesh.setColorAt):
 *  one geometry and one draw call for the blossoms of every colour. The rest of the model keeps its own colours. */
export const TINTED = -1;

export type PlantModel = "tree" | "conifer" | "bush" | "berrybush" | "flower" | "herb" | "grass" | "fern" | "palm" | TreeSortModel;
/** The forms of the planted tree sorts (world trees.sorts[].model): each its own trunk and crown. */
export type TreeSortModel = "birch" | "willow" | "apple" | "pear" | "oak";
export const TREE_SORT_MODELS: ReadonlySet<string> = new Set<TreeSortModel>(["birch", "willow", "apple", "pear", "oak"]);
/** Where a ripe crop hangs on a grown tree of each form (MapView3D): how far out, from which height, and how much higher. */
export const FRUIT_AT: Record<string, { out: number; low: number; step: number }> = {
	tree: { out: 0.42, low: 0.75, step: 0.18 }, apple: { out: 0.55, low: 0.62, step: 0.16 }, pear: { out: 0.3, low: 0.85, step: 0.26 },
};
/** How many shapes of each plant there are; a place picks one. */
export const PLANT_VARIANTS = 3;

export const BARK = 0x6b4a2e, LEAF = [0x4f8f3a, 0x5c9c42, 0x437d33], NEEDLE = [0x2f6b3a, 0x3a7a42, 0x285c33];
export const STONE = 0x8a8577, STONE_DARK = 0x6a675e, WOOD = 0x8a6a44, WOOD_DARK = 0x5b3a22, THATCH = [0xb8954e, 0xa98545, 0xc4a25c];

/** A place's own numbers: which variant, how far turned, how large (0.88 to 1.12). */
export function placeLook(key: string): { variant: number; turn: number; size: number } {
	const h = stableHash(key);
	return { variant: h % PLANT_VARIANTS, turn: (((h >>> 4) & 255) / 256) * Math.PI * 2, size: 0.88 + (((h >>> 12) & 255) / 255) * 0.24 };
}

/** A small deterministic random stream for the shape of one variant. */
export function rand(seed: string): () => number {
	let h = stableHash(seed) || 1;
	return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10_000) / 10_000; };
}

/** Faces that meet at less than this angle shade as one rounded surface; sharper edges stay edges. */
const CREASE = Math.cos(50 * Math.PI / 180);

/** The parts merged into one geometry: positions, a colour per part, and normals that are smooth across faces meeting
 *  at a shallow angle (a trunk, a crown, a bevel are round) and sharp where they meet steeply (a box keeps its edges). */
export function merge(t: T, parts: Part[], seed: string): Geo {
	const pos: number[] = [], col: number[] = [], glow: number[] = [], faces: number[] = [], surface: number[] = [], tint: number[] = [];
	const tinted = parts.some((part) => part.c === TINTED);
	const m = new t.Matrix4(), q = new t.Quaternion(), e = new t.Euler(), c = new t.Color(), edgeA = new t.Vector3(), edgeB = new t.Vector3(), origin = new t.Vector3(), normal = new t.Vector3();
	for (const part of parts) {
		const primitive = modelPrimitive(t, part.g), g = primitive.index ? primitive.toNonIndexed() : primitive;
		m.compose(new t.Vector3(...(part.p ?? [0, 0, 0])), q.setFromEuler(e.set(...(part.r ?? [0, 0, 0]))), new t.Vector3(...(part.s ?? [1, 1, 1])));
		g.applyMatrix4(m);
		const a = g.getAttribute("position");
		const own = part.c === TINTED ? 0 : 1;
		c.setHex(own ? part.c : 0xffffff);
		const lit = LAMPLIGHT.has(part.c) ? 1 : 0, layer = surfaceLayer(part.c, part.m);
		for (let i = 0; i < a.count; i += 3) {
			origin.fromBufferAttribute(a, i); edgeA.fromBufferAttribute(a, i + 1).sub(origin); edgeB.fromBufferAttribute(a, i + 2).sub(origin); normal.crossVectors(edgeA, edgeB);
			// the face's normal, its length the face's size (so a large face weighs more at a shared corner)
			faces.push(normal.x, normal.y, normal.z);
			for (let k = 0; k < 3; k++) { pos.push(a.getX(i + k), a.getY(i + k), a.getZ(i + k)); col.push(c.r, c.g, c.b); glow.push(lit); surface.push(layer); if (tinted) tint.push(1 - own); }
		}
		g.dispose(); if (g !== primitive) primitive.dispose();
	}
	const out = new t.BufferGeometry();
	out.setAttribute("position", new t.Float32BufferAttribute(pos, 3));
	out.setAttribute("color", new t.Float32BufferAttribute(col, 3));
	out.setAttribute("glow", new t.Float32BufferAttribute(glow, 1));
	out.setAttribute("surface", new t.Float32BufferAttribute(surface, 1));
	if (tinted) out.setAttribute("tint", new t.Float32BufferAttribute(tint, 1));
	out.setAttribute("normal", new t.Float32BufferAttribute(creaseNormals(pos, faces), 3));
	out.computeBoundingSphere();
	out.userData.shared = true; out.userData.model = seed;
	return out;
}

/** A normal per corner of a triangle list: the sum of the normals of the faces around that point which lie within
 *  CREASE of the corner's own face. `faces` holds each face's normal, unnormalised. */
export function creaseNormals(pos: readonly number[], faces: readonly number[]): number[] {
	const count = pos.length / 3, around = new Map<number | string, number[]>(), unit: number[] = new Array(faces.length);
	for (let f = 0; f < faces.length; f += 3) { const l = Math.hypot(faces[f]!, faces[f + 1]!, faces[f + 2]!) || 1; unit[f] = faces[f]! / l; unit[f + 1] = faces[f + 1]! / l; unit[f + 2] = faces[f + 2]! / l; }
	// A point's key is its place in steps of 1/2000. As one whole number where the model is small enough for that to be
	// exact (within 30 units of its origin: all but a long road or track), else as text: a crown of leaves is tens of
	// thousands of corners, and a string for each of them held the frame up when a tree's close level was first built.
	let reach = 0;
	for (let i = 0; i < pos.length; i++) { const a = Math.abs(pos[i]!); if (a > reach) reach = a; }
	const OFF = 60_000, SPAN = 2 * OFF + 1, whole = reach * 2000 < OFF;
	const key = (i: number): number | string => {
		const x = Math.round(pos[i * 3]! * 2000), y = Math.round(pos[i * 3 + 1]! * 2000), z = Math.round(pos[i * 3 + 2]! * 2000);
		return whole ? ((x + OFF) * SPAN + (y + OFF)) * SPAN + (z + OFF) : `${x},${y},${z}`;
	};
	const keys: Array<number | string> = new Array(count);
	// a face's three corners follow one another: it is in a point's list already only as the list's last entry
	for (let i = 0; i < count; i++) { const k = keys[i] = key(i), f = Math.floor(i / 3); let list = around.get(k); if (!list) around.set(k, list = []); if (list[list.length - 1] !== f) list.push(f); }
	const out: number[] = new Array(pos.length);
	for (let i = 0; i < count; i++) {
		const own = Math.floor(i / 3) * 3, ox = unit[own]!, oy = unit[own + 1]!, oz = unit[own + 2]!;
		let x = 0, y = 0, z = 0;
		for (const f of around.get(keys[i]!)!) { const j = f * 3; if (unit[j]! * ox + unit[j + 1]! * oy + unit[j + 2]! * oz >= CREASE) { x += faces[j]!; y += faces[j + 1]!; z += faces[j + 2]!; } }
		const l = Math.hypot(x, y, z);
		if (l > 0) { out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l; } else { out[i * 3] = ox; out[i * 3 + 1] = oy; out[i * 3 + 2] = oz; }
	}
	return out;
}

/** The grain every model's surface carries, by its place on the model (so it stays with a moving animal): two octaves
 *  of value noise, 0 to 1. It varies the colour and the roughness a little and bumps the surface. */
const GRAIN = /* glsl */ `
uniform float uNight;
varying float vGlow;
varying vec3 vModelPos;
float modelHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float modelNoise( vec3 p ) {
	vec3 i = floor( p ), f = fract( p ), u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( modelHash( i ), modelHash( i + vec3( 1, 0, 0 ) ), u.x ), mix( modelHash( i + vec3( 0, 1, 0 ) ), modelHash( i + vec3( 1, 1, 0 ) ), u.x ), u.y ),
		mix( mix( modelHash( i + vec3( 0, 0, 1 ) ), modelHash( i + vec3( 1, 0, 1 ) ), u.x ), mix( modelHash( i + vec3( 0, 1, 1 ) ), modelHash( i + vec3( 1, 1, 1 ) ), u.x ), u.y ), u.z );
}
float modelGrain( vec3 p ) { return 0.62 * modelNoise( p * 9.0 ) + 0.38 * modelNoise( p * 23.0 + 5.0 ); }
// the grain where a pixel covers px world units: an octave finer than two pixels would only flicker, its mean stands
// in for it and it is not worked out (the same on every screen: what is smaller than a pixel is not drawn)
float modelGrainAt( vec3 p, float px ) {
	float fine = smoothstep( 0.035, 0.02, px );
	return 0.62 * modelNoise( p * 9.0 ) + 0.38 * ( fine > 0.0 ? mix( 0.5, modelNoise( p * 23.0 + 5.0 ), fine ) : 0.5 );
}`;

let material: import("three").MeshStandardMaterial | null = null;
/** How dark it is, 0 by day to 1 at night: the lamplit faces of every model glow by it (setNight). */
const night = { value: 0 };
/** The one material of every model: the colours are in the vertices, and faces marked `glow` (merge) shine at night with
 *  their own colour, so windows, lanterns and kiln mouths light up without a light per house. */
export function propMaterial(t: T): import("three").MeshStandardMaterial {
	if (!material) {
		material = new t.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
		material.onBeforeCompile = (shader) => {
			shader.uniforms.uNight = night; Object.assign(shader.uniforms, surfaceUniforms(t));
			shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nattribute float glow;\nattribute float surface;\nattribute float tint;\nvarying float vGlow;\nvarying float vSurface;\nvarying vec3 vModelPos;\nvarying vec3 vModelNormal;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;\nvSurface = surface;\nvModelPos = position;\nvModelNormal = normal;")
				// an instance's colour (setColorAt) tints only the parts marked for it (TINTED), not the whole model
				.replace("#include <color_vertex>", "#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\n\tvColor.rgb = color * mix( vec3( 1.0 ), instanceColor.rgb, tint );\n#endif");
			shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${GRAIN}\n${SURFACE_HEAD}`)
				.replace("#include <color_fragment>", `#include <color_fragment>\n\tfloat modelPx = max( length( dFdx( vViewPosition ) ), length( dFdy( vViewPosition ) ) );\n\tfloat grain = modelGrainAt( vModelPos, modelPx );\n\tdiffuseColor.rgb *= 0.9 + 0.2 * grain;\n${SURFACE_COLOUR}`)
				.replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
	{
		// the grain as a bump: the surface leans by the slope of the grain, less with distance (it would flicker there)
		vec3 gx = dFdx( vViewPosition ), gy = dFdy( vViewPosition );
		vec3 r1 = cross( gy, normal ), r2 = cross( normal, gx );
		// far away the bump is nothing: its fine grain (16 noise values, up to 71 waves a unit) is worked out only where it
		// shows, near the camera and where a pixel is small enough for it
		float det = dot( gx, r1 ), bumpNear = smoothstep( 34.0, 5.0, length( vViewPosition ) ) * smoothstep( 0.03, 0.015, modelPx ), bump = 0.0;
		if ( bumpNear > 0.0 ) bump = ( ( grain + 0.5 * modelGrain( vModelPos * 3.1 + 11.0 ) ) * 0.012 + surfaceHigh * 0.03 ) * bumpNear;
		vec3 slope = sign( det ) * ( dFdx( bump ) * r1 + dFdy( bump ) * r2 );
		normal = normalize( abs( det ) * normal - slope );
	}`)
				.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = clamp( ( surfaceArm.g < 0.0 ? roughnessFactor : surfaceArm.g ) + ( grain - 0.5 ) * 0.2, 0.0, 1.0 );")
				.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow * uNight * 4.0;");
			withAo(shader); // the room's occlusion (ao3d.ts)
		};
		material.userData.shared = true;
	}
	return material;
}
/** Sets how dark it is for every model's lamplight (0 day, 1 night). */
export function setNight(n: number): void { night.value = Math.max(0, Math.min(1, n)); }

const cache = new Map<string, Geo>();
export function cached(key: string, make: () => Geo): Geo {
	const id = `${key}@${modelLevel()}`;
	let g = cache.get(id);
	if (!g) { g = make(); g.userData.modelVariant = (level: ModelLevel) => atModelLevel(level, () => cached(key, make)); cache.set(id, g); }
	return g;
}

export function detailGeometry(t: T, source: Geo): Geo {
	const parameters = (source as Geo & { parameters?: Record<string, unknown> }).parameters;
	if (!parameters) return source;
	const geometry = cached(`shape:${source.type}:${JSON.stringify(parameters)}`, () => merge(t, [{ g: source.clone(), c: 0xffffff }], `shape:${source.type}`));
	source.dispose(); return geometry;
}

export function prepareModelDetails(t: T, root: import("three").Object3D): void {
	root.traverse((object) => {
		const mesh = object as import("three").Mesh;
		if (mesh.isMesh && !mesh.geometry.userData.modelVariant && mesh.material instanceof t.MeshStandardMaterial && !mesh.material.map) mesh.geometry = detailGeometry(t, mesh.geometry);
	});
}

// ---- leaves ----

/** The shade inside a crown, behind its leaves. */
const SHADE = 0x2c5226, LEAF_LIGHT = [0x6aa84a, 0x4f8f3a, 0x5c9c42, 0x437d33], NEEDLE_LIGHT = [0x3f8048, 0x2f6b3a, 0x3a7a42, 0x285c33];

/** One leaf blade as four triangles (both sides), folded a little along its midrib: from `b` along `d` (a unit vector),
 *  `len` long and `wide` across; `turn` rolls it about its own axis. Pushed onto `out` as positions. */
function blade(out: number[], b: V3, d: V3, len: number, wide: number, turn: number): void {
	// a side vector across the leaf: any vector not along d, rolled by `turn`
	const ux = Math.abs(d[1]) > 0.9 ? 1 : 0, uy = Math.abs(d[1]) > 0.9 ? 0 : 1;
	let sx = d[1] * 0 - d[2] * uy, sy = d[2] * ux - d[0] * 0, sz = d[0] * uy - d[1] * ux;
	const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
	let fx = sy * d[2] - sz * d[1], fy = sz * d[0] - sx * d[2], fz = sx * d[1] - sy * d[0];
	const c = Math.cos(turn), n = Math.sin(turn);
	[sx, sy, sz, fx, fy, fz] = [sx * c + fx * n, sy * c + fy * n, sz * c + fz * n, fx * c - sx * n, fy * c - sy * n, fz * c - sz * n];
	const mid = len * 0.45, half = wide / 2, fold = len * 0.07;
	const T: V3 = [b[0] + d[0] * len, b[1] + d[1] * len, b[2] + d[2] * len];
	const L: V3 = [b[0] + d[0] * mid + sx * half + fx * fold, b[1] + d[1] * mid + sy * half + fy * fold, b[2] + d[2] * mid + sz * half + fz * fold];
	const R: V3 = [b[0] + d[0] * mid - sx * half + fx * fold, b[1] + d[1] * mid - sy * half + fy * fold, b[2] + d[2] * mid - sz * half + fz * fold];
	out.push(...b, ...R, ...T, ...b, ...T, ...L, ...b, ...T, ...R, ...b, ...L, ...T);
}
const unit = (x: number, y: number, z: number): V3 => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

/** Leaves as parts, one per colour of `colours`: `each(push)` calls `push(base, direction, length, width)` per leaf. */
function leaves(t: T, parts: Part[], colours: readonly number[], r: () => number, each: (push: (b: V3, d: V3, len: number, wide: number) => void) => void): void {
	const groups = colours.map(() => [] as number[]);
	each((b, d, len, wide) => blade(groups[Math.floor(r() * groups.length) % groups.length]!, b, d, len, wide, (r() - 0.5) * 1.6));
	groups.forEach((pos, i) => {
		if (!pos.length) return;
		const g = new t.BufferGeometry(); g.setAttribute("position", new t.Float32BufferAttribute(pos, 3));
		parts.push({ g, c: colours[i]!, m: "leaf" });
	});
}

/** A crown of balls as leaves: each ball (centre, radius) keeps a smaller dark mass inside, and leaves stand on its
 *  surface, pointing out and a little down, none where another ball covers the place. Far away the balls stay plain. */
function crown(t: T, parts: Part[], balls: Array<{ p: V3; radius: number; c: number }>, r: () => number, size: number, colours: readonly number[]): void {
	const level = modelLevel();
	for (const ball of balls) parts.push({ g: new t.IcosahedronGeometry(level === "far" ? ball.radius : ball.radius * 0.84, 0), c: level === "far" ? ball.c : SHADE, p: ball.p, r: [r() * 3, r() * 3, r() * 3] });
	if (level === "far") return;
	const dense = level === "near" ? 1500 : 800, long = level === "near" ? size * 0.85 : size;
	leaves(t, parts, colours, r, (push) => {
		for (const ball of balls) {
			const n = Math.round(dense * ball.radius * ball.radius);
			for (let i = 0; i < n; i++) {
				// evenly over the ball (a spiral), each a little off its place
				const y = 1 - (2 * (i + 0.5)) / n, ring = Math.sqrt(1 - y * y), a = i * 2.39996 + r() * 0.5;
				const dir: V3 = [ring * Math.cos(a), y, ring * Math.sin(a)], at = ball.radius * (0.86 + r() * 0.16);
				const b: V3 = [ball.p[0] + dir[0] * at, ball.p[1] + dir[1] * at, ball.p[2] + dir[2] * at];
				if (balls.some((o) => o !== ball && Math.hypot(b[0] - o.p[0], b[1] - o.p[1], b[2] - o.p[2]) < o.radius * 0.8)) continue;
				push(b, unit(dir[0] + (r() - 0.5) * 0.9, dir[1] + (r() - 0.5) * 0.9 - 0.25, dir[2] + (r() - 0.5) * 0.9), long * (0.7 + r() * 0.6), long * 0.5);
			}
		}
	});
}

/** A palm's frond from `top` towards `a`: a rib that rises and then hangs, with narrow leaflets down both its sides. */
function frond(t: T, parts: Part[], top: V3, a: number, len: number, c: number, r: () => number): void {
	const level = modelLevel(), hx = Math.cos(a), hz = Math.sin(a);
	const at = (k: number): V3 => [top[0] + hx * len * k, top[1] + len * (0.42 * k - 0.8 * k * k), top[2] + hz * len * k];
	const steps = level === "far" ? 2 : 5;
	for (let i = 0; i < steps; i++) {
		const p = at(i / steps), q = at((i + 1) / steps), dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], l = Math.hypot(dx, dy, dz);
		// a thin rib piece from p to q (a cylinder stands along y: turned to the piece's direction)
		parts.push({ g: fixed(t, new t.CylinderGeometry(0.008, 0.011, l, 4)), c: 0x6f8a3a, m: "none", p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], r: [0, -a, Math.atan2(dy, Math.hypot(dx, dz)) - Math.PI / 2] });
	}
	const pairs = level === "far" ? 5 : level === "near" ? 16 : 11;
	leaves(t, parts, [c, c === 0x5c9c42 ? 0x4f8f3a : 0x5c9c42], r, (push) => {
		for (let i = 0; i < pairs; i++) {
			const k = 0.1 + 0.9 * (i + 0.5) / pairs, b = at(k), long = len * 0.36 * Math.sin(Math.PI * (0.12 + 0.8 * k)) + 0.03;
			for (const side of [-1, 1]) push(b, unit(-hz * side * 0.85 + hx * 0.4, -0.35 - 0.5 * k + (r() - 0.5) * 0.2, hx * side * 0.85 + hz * 0.4), long, long * (level === "far" ? 0.36 : 0.2));
		}
	});
}

// ---- plants ----

/** A trunk piece from `a` to `b` (a cylinder turned along it). */
function limb(t: T, parts: Part[], a: V3, b: V3, r0: number, r1: number, c: number, m?: Part["m"]): void {
	const d = new t.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
	const q = new t.Quaternion().setFromUnitVectors(new t.Vector3(0, 1, 0), d.clone().normalize()), e = new t.Euler().setFromQuaternion(q);
	parts.push({ g: fixed(t, new t.CylinderGeometry(r1, r0, len, 6)), c, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], r: [e.x, e.y, e.z], ...(m ? { m } : {}) });
}

/** The planted sorts, each told apart from afar by its trunk and the shape of its crown:
 *  birch — slender, white with dark bands, a light, airy, narrow crown that hangs a little;
 *  willow (a pollard) — a short thick trunk with a knobby head and a shock of thin upright rods, grey-green;
 *  apple — a short crooked trunk, a low, wide, flat crown; pear — straight and tall, a narrow upright crown;
 *  oak — a thick trunk forking into big limbs, a broad, heavy crown of dark lumps. */
function treeSort(t: T, parts: Part[], model: TreeSortModel, variant: number, r: () => number): void {
	if (model === "birch") {
		const high = 1.05 + r() * 0.15, lean = (r() - 0.5) * 0.08;
		limb(t, parts, [0, 0, 0], [lean, high, 0], 0.06, 0.04, 0xe8e4d8, "none");
		// the dark bands of the bark
		for (let i = 0; i < 6; i++) { const y = 0.12 + i * (high - 0.2) / 6 + r() * 0.05; parts.push({ g: new t.CylinderGeometry(0.058 - y * 0.015, 0.06 - y * 0.015, 0.03 + r() * 0.03, 6), c: 0x2e2a26, p: [lean * y / high, y, 0], m: "none" }); }
		const light = [0x8cc060, 0x7ab04e, 0x9ccc6c], balls = [{ radius: 0.3, c: light[variant % 3]!, p: [lean, high + 0.12, 0] as V3 }];
		for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + r(); balls.push({ radius: 0.17 + r() * 0.06, c: light[(variant + i) % 3]!, p: [lean + Math.cos(a) * 0.17, high - 0.25 + r() * 0.4, Math.sin(a) * 0.17] }); }
		crown(t, parts, balls, r, 0.1, [0x9ccc6c, 0x8cc060, 0xa8d478]);
		return;
	}
	if (model === "willow") {
		const head = 0.55 + r() * 0.08;
		parts.push({ g: new t.CylinderGeometry(0.13, 0.16, head, 7), c: 0x5e4a36, m: "bark", p: [0, head / 2, 0] });
		parts.push({ g: new t.IcosahedronGeometry(0.19, 0), c: 0x4e3c2a, p: [0, head + 0.04, 0], s: [1, 0.7, 1] });
		const rods = 14 + (variant % 3) * 2, grey = [0x8aa070, 0x9ab07c, 0x7c9464];
		for (let i = 0; i < rods; i++) {
			const a = i * 2.39996 + r() * 0.4, out = 0.06 + r() * 0.08, tip = 0.45 + r() * 0.25, spread = 0.18 + r() * 0.16;
			const from: V3 = [Math.cos(a) * out, head + 0.08, Math.sin(a) * out], to: V3 = [Math.cos(a) * (out + spread), head + 0.08 + tip, Math.sin(a) * (out + spread)];
			limb(t, parts, from, to, 0.012, 0.007, 0x6e5a3e, "none");
		}
		// the narrow leaves along the rods, grey-green
		leaves(t, parts, grey, r, (push) => {
			for (let i = 0; i < rods * 9; i++) {
				const a = Math.floor(i / 9) * 2.39996, k = 0.3 + (i % 9) / 11, out = 0.1 + k * 0.26, up = head + 0.1 + k * 0.6;
				push([Math.cos(a) * out, up, Math.sin(a) * out], unit(Math.cos(a + (r() - 0.5) * 2), 0.2 + (r() - 0.5) * 0.6, Math.sin(a + (r() - 0.5) * 2)), 0.1, 0.022);
			}
		});
		return;
	}
	if (model === "apple") {
		// a short trunk that forks low; the crown wide and flat, lower than a tall tree's
		const fork = 0.42 + r() * 0.06;
		limb(t, parts, [0, 0, 0], [0.04, fork, 0], 0.09, 0.07, 0x5a4030, "bark");
		for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + r(); limb(t, parts, [0.04, fork - 0.03, 0], [Math.cos(a) * 0.32, fork + 0.32, Math.sin(a) * 0.32], 0.05, 0.03, 0x5a4030, "bark"); }
		const balls = [{ radius: 0.42, c: LEAF[variant % 3]!, p: [0, fork + 0.5, 0] as V3 }];
		for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 + r(); balls.push({ radius: 0.27 + r() * 0.07, c: LEAF[(variant + i) % 3]!, p: [Math.cos(a) * 0.45, fork + 0.36 + r() * 0.18, Math.sin(a) * 0.45] }); }
		for (const b of balls) b.p[1] = fork + (b.p[1] - fork) * 0.85;
		crown(t, parts, balls, r, 0.12, LEAF_LIGHT);
		return;
	}
	if (model === "pear") {
		// straight and tall, the crown narrow and upright like a flame
		const trunk = 0.6 + r() * 0.1;
		limb(t, parts, [0, 0, 0], [0, trunk, 0], 0.075, 0.055, 0x4a3a2c, "bark");
		const green = [0x4a8a3c, 0x3f7d34, 0x55944a], balls: Array<{ radius: number; c: number; p: V3 }> = [];
		for (let i = 0; i < 4; i++) { const k = i / 3; balls.push({ radius: 0.34 - k * 0.15, c: green[(variant + i) % 3]!, p: [(r() - 0.5) * 0.06, trunk + 0.22 + k * 0.62, (r() - 0.5) * 0.06] }); }
		for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + r(); balls.push({ radius: 0.22, c: green[(variant + i) % 3]!, p: [Math.cos(a) * 0.17, trunk + 0.3 + r() * 0.4, Math.sin(a) * 0.17] }); }
		crown(t, parts, balls, r, 0.11, [0x5a9a48, 0x4a8a3c, 0x62a250]);
		return;
	}
	// oak: thick and broad, big limbs, a heavy dark crown of many lumps
	const fork = 0.55 + r() * 0.08;
	limb(t, parts, [0, 0, 0], [0, fork, 0], 0.17, 0.13, 0x4e3e30, "bark");
	for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + r(); parts.push({ g: new t.BoxGeometry(0.3, 0.08, 0.1), c: 0x4e3e30, p: [Math.cos(a) * 0.15, 0.04, Math.sin(a) * 0.15], r: [0, -a, 0.3] }); }
	for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + r(); limb(t, parts, [0, fork - 0.05, 0], [Math.cos(a) * 0.42, fork + 0.4 + r() * 0.15, Math.sin(a) * 0.42], 0.08, 0.045, 0x4e3e30, "bark"); }
	const dark = [0x2f6a2c, 0x3a7632, 0x285e26], balls = [{ radius: 0.5, c: dark[variant % 3]!, p: [0, fork + 0.7, 0] as V3 }];
	for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2 + r(); balls.push({ radius: 0.3 + r() * 0.1, c: dark[(variant + i) % 3]!, p: [Math.cos(a) * 0.55, fork + 0.45 + r() * 0.45, Math.sin(a) * 0.55] }); }
	crown(t, parts, balls, r, 0.13, [0x3f7a36, 0x2f6a2c, 0x4a8640]);
}

/** A pollard willow's grown rods (MapView3D: while its crop is ripe): long thin wands from its head, to be cut. */
export function willowRods(t: T, variant: number): Geo {
	return cached(`willow-rods:${variant}`, () => {
		const r = rand(`willow-rods:${variant}`), parts: Part[] = [];
		for (let i = 0; i < 22; i++) {
			const a = i * 2.39996 + r() * 0.4, out = 0.06 + r() * 0.08, spread = 0.3 + r() * 0.2, tip = 0.85 + r() * 0.35;
			limb(t, parts, [Math.cos(a) * out, 0.66, Math.sin(a) * out], [Math.cos(a) * (out + spread), 0.66 + tip, Math.sin(a) * (out + spread)], 0.012, 0.006, 0x7a5a3a, "none");
		}
		leaves(t, parts, [0x8aa070, 0x9ab07c], r, (push) => {
			for (let i = 0; i < 22 * 8; i++) {
				const a = Math.floor(i / 8) * 2.39996, k = 0.35 + (i % 8) / 11, out = 0.12 + k * 0.4, up = 0.7 + k * 1.05;
				push([Math.cos(a) * out, up, Math.sin(a) * out], unit(Math.cos(a + (r() - 0.5) * 2), 0.1 + (r() - 0.5) * 0.6, Math.sin(a + (r() - 0.5) * 2)), 0.11, 0.022);
			}
		});
		return merge(t, parts, `willow-rods:${variant}`);
	});
}

/** A plant's geometry (about 1.7 units for a tree, 0.6 for a bush), standing on y = 0. */
export function plantGeometry(t: T, model: PlantModel, variant: number, color = 0xf4f0e6): Geo {
	return cached(`${model}:${variant}:${color}`, () => {
		const r = rand(`${model}:${variant}`), parts: Part[] = [];
		if (model === "flower" || model === "herb" || model === "grass" || model === "fern") {
			small(t, model, parts, r, variant, color);
			if (modelLevel() === "near" && model === "fern") for (let frond = 0; frond < 6; frond++) {
				const angle = frond * Math.PI / 3;
				for (let i = 1; i < 5; i++) for (const side of [-1, 1]) leaf(t, parts, [Math.cos(angle) * i * 0.065, 0.04 + i * 0.024, Math.sin(angle) * i * 0.065], angle + side * 0.8, 0.12 - i * 0.015, LEAF[variant % 3]!, 0.2);
			}
			return merge(t, parts, `${model}:${variant}`);
		}
		if (model === "palm") {
			// a trunk of rings that bends to one side, a crown of long drooping fronds and a few coconuts
			const bend = 0.18 + r() * 0.14, rings = 7, high = 1.45 + r() * 0.3;
			let top: V3 = [0, 0, 0];
			for (let i = 0; i < rings; i++) {
				const k = (i + 0.5) / rings, x = bend * k * k, y = high * k, rad = 0.075 - k * 0.025;
				parts.push({ g: new t.CylinderGeometry(rad * 0.9, rad, high / rings + 0.02, 7), c: i % 2 ? 0x8a6a44 : 0x7a5c3a, m: "bark", p: [x, y, 0], r: [0, 0, -2 * bend * k / high] });
				top = [bend, high, 0];
			}
			const fronds = 7 + (variant % 2);
			for (let i = 0; i < fronds; i++) {
				const a = (i / fronds) * Math.PI * 2 + r() * 0.3, len = 0.62 + r() * 0.16, c = [0x4f8f3a, 0x5c9c42, 0x3f7d33][(variant + i) % 3]!;
				frond(t, parts, top, a, len * 1.15, c, r);
			}
			for (let i = 0; i < 3; i++) { const a = i * 2.1 + r(); parts.push({ g: new t.IcosahedronGeometry(0.05, 0), c: 0x5b3f22, p: [top[0] + Math.cos(a) * 0.07, top[1] - 0.06, top[2] + Math.sin(a) * 0.07] }); }
			return merge(t, parts, `${model}:${variant}`);
		}
		if (TREE_SORT_MODELS.has(model)) treeSort(t, parts, model as TreeSortModel, variant, r);
		else if (model === "tree") {
			const trunk = 0.62 + r() * 0.18;
			parts.push({ g: new t.CylinderGeometry(0.07, 0.11, trunk, 6), c: BARK, p: [0, trunk / 2, 0] });
			for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + r(); parts.push({ g: new t.BoxGeometry(0.22, 0.06, 0.07), c: BARK, p: [Math.cos(a) * 0.1, 0.03, Math.sin(a) * 0.1], r: [0, -a, 0.25] }); }
			const balls = [{ radius: 0.46 + r() * 0.08, c: LEAF[variant % 3]!, p: [0, trunk + 0.42, 0] as V3 }];
			for (let i = 0; i < 3 + (variant % 2); i++) { const a = (i / 3.5) * Math.PI * 2 + r(); balls.push({ radius: 0.28 + r() * 0.1, c: LEAF[(variant + i) % 3]!, p: [Math.cos(a) * 0.3, trunk + 0.28 + r() * 0.42, Math.sin(a) * 0.3] }); }
			crown(t, parts, balls, r, 0.13, LEAF_LIGHT);
		} else if (model === "conifer") {
			parts.push({ g: new t.CylinderGeometry(0.06, 0.09, 0.4, 6), c: BARK, p: [0, 0.2, 0] });
			const tiers = 3 + (variant % 2);
			for (let i = 0; i < tiers; i++) {
				const k = i / tiers, rad = 0.46 - k * 0.3, hi = 0.62 - k * 0.12;
				const low = 0.48 + i * 0.36 - 0.2, far = modelLevel() === "far";
				parts.push({ g: new t.ConeGeometry(far ? rad : rad * 0.86, hi, 7), c: far ? NEEDLE[(variant + i) % 3]! : 0x1f4a2a, p: [0, low + hi / 2, 0], r: [0, r() * 3, 0] });
				// twigs of needles on the tier's slope, pointing out and down
				if (!far) leaves(t, parts, NEEDLE_LIGHT, r, (push) => {
					const count = Math.round((modelLevel() === "near" ? 420 : 240) * rad);
					for (let k = 0; k < count; k++) {
						// `wide` is 1 at the tier's rim and 0 at its tip; more twigs towards the rim, where the slope is larger
						const wide = Math.sqrt(r()) * 0.95, a = k * 2.39996 + r(), out = rad * 0.88 * wide;
						push([Math.cos(a) * out, low + (1 - wide) * hi, Math.sin(a) * out], unit(Math.cos(a), -0.55 + (r() - 0.5) * 0.4, Math.sin(a)), 0.1 + r() * 0.07, 0.035);
					}
				});
			}
		} else {
			const n = 3 + (variant % 2);
			const balls: Array<{ p: V3; radius: number; c: number }> = [];
			for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + r(); balls.push({ radius: 0.2 + r() * 0.09, c: LEAF[(variant + i) % 3]!, p: [Math.cos(a) * 0.15, 0.2 + r() * 0.14, Math.sin(a) * 0.15] }); }
			balls.push({ radius: 0.24, c: LEAF[variant % 3]!, p: [0, 0.34, 0] });
			crown(t, parts, balls, r, 0.085, LEAF_LIGHT);
			if (model === "berrybush") for (let i = 0; i < 9; i++) {
				const a = r() * Math.PI * 2, up = 0.18 + r() * 0.3;
				parts.push({ g: new t.IcosahedronGeometry(0.045, 0), c: 0xc8323a, p: [Math.cos(a) * 0.3, up, Math.sin(a) * 0.3] });
			}
		}
		if (modelLevel() === "near" && (model === "tree" || model === "conifer" || model === "apple" || model === "pear" || model === "oak")) for (let i = 0; i < 5; i++) parts.push({ g: new t.BoxGeometry(0.1, 0.009, 0.012), c: WOOD_DARK, p: [0, 0.1 + i * 0.085, 0.078], r: [0, i * 0.2, -0.1] });
		return merge(t, parts, `${model}:${variant}`);
	});
}

/** A stem from the ground, leaning `lean` towards `a`, with its tip returned. */
function stem(t: T, parts: Part[], x: number, z: number, high: number, a: number, lean: number, c: number, thick = 0.014): V3 {
	parts.push({ g: fixed(t, new t.CylinderGeometry(thick * 0.7, thick, high, modelLevel() === "near" ? 6 : 4)), c, p: [x + (Math.cos(a) * lean) / 2, high / 2, z + (Math.sin(a) * lean) / 2], r: [Math.sin(a) * lean / high, 0, -Math.cos(a) * lean / high] });
	return [x + Math.cos(a) * lean, high, z + Math.sin(a) * lean];
}
/** A geometry the level of detail leaves as it is (modelPrimitive refines only what still carries its parameters): for
 *  the parts of a plant a few pixels large. A leaf is a flattened ball of radius 0.5, which the refinement took for a crown
 *  and gave 320 triangles (1280 close up), and a thin stem got 10 or 16 sides: a flower had over 4000 triangles. */
function fixed(t: T, g: Geo): Geo { const out = new t.BufferGeometry().copy(g); g.dispose(); return out; }
/** A blossom at `p`: five petals round a yellow eye. */
function blossom(t: T, parts: Part[], p: V3, size: number, c: number, turn: number, eye = 0xe8c23a): void {
	for (let i = 0; i < 5; i++) {
		const a = turn + (i / 5) * Math.PI * 2;
		parts.push({ g: fixed(t, new t.IcosahedronGeometry(size * 0.6, 0)), c, p: [p[0] + Math.cos(a) * size, p[1], p[2] + Math.sin(a) * size], s: [1, 0.4, 1] });
	}
	parts.push({ g: fixed(t, new t.IcosahedronGeometry(size * 0.5, modelLevel() === "near" ? 1 : 0)), c: eye, p: [p[0], p[1] + size * 0.15, p[2]] });
}
/** A leaf: a flat lens from `p` towards `a`. */
function leaf(t: T, parts: Part[], p: V3, a: number, len: number, c: number, tilt = 0.5): void {
	parts.push({ g: fixed(t, new t.IcosahedronGeometry(0.5, modelLevel() === "near" ? 1 : 0)), c, p: [p[0] + (Math.cos(a) * len) / 2, p[1] + (tilt * len) / 2, p[2] + (Math.sin(a) * len) / 2], r: [0, -a, tilt], s: [len, 0.03, len * 0.4] });
	if (modelLevel() === "near") parts.push({ g: fixed(t, new t.BoxGeometry(len * 0.78, 0.004, 0.006)), c: 0x386b2e, p: [p[0] + Math.cos(a) * len / 2, p[1] + tilt * len / 2 + 0.012, p[2] + Math.sin(a) * len / 2], r: [0, -a, Math.atan(tilt)] });
}
/** The small plants of the ground, about 0.3 units high, a few to a cell. */
function small(t: T, model: PlantModel, parts: Part[], r: () => number, variant: number, color: number): void {
	const green = LEAF[variant % 3]!;
	if (model === "flower") {
		for (let i = 0; i < 4 + variant; i++) {
			const a = r() * 6.28, far = 0.08 + r() * 0.26, x = Math.cos(a) * far, z = Math.sin(a) * far;
			const tip = stem(t, parts, x, z, 0.16 + r() * 0.16, r() * 6.28, 0.03, green);
			leaf(t, parts, [x, 0.05, z], r() * 6.28, 0.11, green);
			blossom(t, parts, tip, 0.045, color, r() * 6.28);
		}
	} else if (model === "grass") {
		for (let i = 0; i < 12; i++) { const a = r() * 6.28, far = r() * 0.3; stem(t, parts, Math.cos(a) * far, Math.sin(a) * far, 0.14 + r() * 0.2, r() * 6.28, 0.07, LEAF[(variant + i) % 3]!, 0.012); }
	} else if (model === "herb") {
		for (let i = 0; i < 7; i++) leaf(t, parts, [0, 0.03, 0], (i / 7) * 6.28 + r(), 0.28 + r() * 0.1, LEAF[(variant + i) % 3]!, 0.7);
	} else {
		for (let i = 0; i < 6; i++) leaf(t, parts, [0, 0.04, 0], (i / 6) * 6.28 + r(), 0.36 + r() * 0.1, 0x3f7d3a, 0.35);
	}
}

/** What grows in a bed: its form, by the sort (world.garden.sorts[].model). */
export type CropModel = "flower" | "rose" | "mist" | "cabbage" | "carrot" | "hops";
/** A plant in a bed by its stage: seed (a mound), sprout, grown, wilted; `color` that of the sort or the variety. */
export function cropGeometry(t: T, model: CropModel, stage: number, color: number): Geo {
	return cached(`crop:${model}:${stage}:${color}`, () => {
		const r = rand(`crop:${model}:${stage}`), parts: Part[] = [], green = 0x4f8a3a, dry = 0x7a6a4a;
		if (stage === 0) parts.push({ g: new t.IcosahedronGeometry(0.1, 0), c: 0x4e3420, p: [0, 0.02, 0], s: [1, 0.45, 1] });
		else if (stage === 1) { for (let i = 0; i < 3; i++) leaf(t, parts, [0, 0.02, 0], (i / 3) * 6.28 + r(), 0.15, 0x6fb04a, 1); }
		else if (stage === 3) {
			for (let i = 0; i < 4; i++) leaf(t, parts, [0, 0.02, 0], (i / 4) * 6.28 + r(), 0.2, dry, 0.1);
			const tip = stem(t, parts, 0, 0, 0.16, r() * 6.28, 0.1, dry);
			parts.push({ g: new t.IcosahedronGeometry(0.04, 0), c: 0x5b4a33, p: tip });
		} else if (model === "cabbage") {
			parts.push({ g: new t.IcosahedronGeometry(0.17, 1), c: color, p: [0, 0.15, 0], s: [1, 0.85, 1] });
			for (let i = 0; i < 7; i++) leaf(t, parts, [0, 0.05, 0], (i / 7) * 6.28 + r(), 0.3, i % 2 ? color : green, 0.55);
		} else if (model === "carrot") {
			parts.push({ g: new t.ConeGeometry(0.075, 0.16, 6), c: color, p: [0, 0.05, 0], r: [Math.PI, 0, 0] });
			for (let i = 0; i < 6; i++) stem(t, parts, 0, 0, 0.26 + r() * 0.1, (i / 6) * 6.28 + r(), 0.09, 0x5c9c42, 0.016);
		} else if (model === "hops") {
			// a bine climbing its pole, the green cones hanging from it
			for (const side of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.024, 0.65, 0.024), c: WOOD_DARK, p: [side * 0.16, 0.325, 0] });
			parts.push({ g: new t.BoxGeometry(0.36, 0.022, 0.022), c: WOOD, p: [0, 0.64, 0] }, { g: new t.CylinderGeometry(0.006, 0.006, 0.55, 4), c: 0x69734b, p: [0, 0.29, 0] });
			for (let i = 0; i < 6; i++) { const a = i * 2.1 + r(), y = 0.1 + i * 0.08; leaf(t, parts, [Math.cos(a) * 0.03, y, Math.sin(a) * 0.03], a, 0.11, green, 0.4); }
			for (let i = 0; i < 4; i++) { const a = i * 1.7 + r(); parts.push({ g: new t.ConeGeometry(0.035, 0.08, 6), c: color, p: [Math.cos(a) * 0.07, 0.24 + i * 0.09, Math.sin(a) * 0.07], r: [Math.PI, 0, 0] }); }
		} else if (model === "rose") {
			for (let i = 0; i < 5; i++) { const a = (i / 5) * 6.28 + r(); leaf(t, parts, [0, 0.1 + r() * 0.15, 0], a, 0.15, 0x3f7d3a); }
			for (let i = 0; i < 3; i++) {
				const tip = stem(t, parts, (i - 1) * 0.08, r() * 0.1 - 0.05, 0.3 + r() * 0.12, r() * 6.28, 0.05, 0x3f7d3a, 0.02);
				parts.push({ g: new t.IcosahedronGeometry(0.075, 1), c: color, p: tip, s: [1, 0.85, 1] });
				parts.push({ g: new t.IcosahedronGeometry(0.04, 0), c: 0xffffff, p: [tip[0], tip[1] + 0.05, tip[2]] });
			}
		} else if (model === "mist") {
			const count = modelLevel() === "near" ? 14 : modelLevel() === "far" ? 4 : 8;
			for (let i = 0; i < count; i++) {
				const angle = i * 2.4, radius = 0.04 + (i % 3) * 0.035;
				const tip = stem(t, parts, Math.cos(angle) * radius, Math.sin(angle) * radius, 0.25 + r() * 0.14, angle, 0.025, 0x7fa89a, 0.007);
				parts.push({ g: new t.IcosahedronGeometry(0.021, 0), c: color, p: tip });
			}
			leaf(t, parts, [0, 0.05, 0], 1, 0.16, 0x7fa89a); leaf(t, parts, [0, 0.05, 0], 4, 0.16, 0x7fa89a);
		} else {
			for (let i = 0; i < 3; i++) {
				const tip = stem(t, parts, (i - 1) * 0.08, r() * 0.12 - 0.06, 0.26 + r() * 0.12, r() * 6.28, 0.05, green);
				blossom(t, parts, tip, 0.06, color, r() * 6.28);
			}
			for (let i = 0; i < 4; i++) leaf(t, parts, [0, 0.03, 0], (i / 4) * 6.28 + r(), 0.16, green);
		}
		return merge(t, parts, `crop:${model}:${stage}`);
	});
}

/** What stands on a field: its form, by the crop (world.fields.crops[].model). */
export type FieldModel = "grain" | "tuber" | "beet" | "flax";
/** A field's crop w×d in rows along x: `grown` 0.4 for young plants, 1 ripe; `color` its colour then, `limp` when it stands too long. */
export function fieldCropGeometry(t: T, model: FieldModel, w: number, d: number, grown: number, color: number, limp: boolean): Geo {
	return cached(`field:${model}:${w}:${d}:${grown}:${color}:${limp}`, () => {
		const r = rand(`field:${model}:${w}:${d}`), parts: Part[] = [], rows = Math.max(2, d * 2), each = model === "grain" || model === "flax" ? 6 : 3;
		const c = grown < 1 ? 0x5f9a3a : color, high = (model === "grain" ? 0.5 : model === "flax" ? 0.46 : 0.26) * grown;
		for (let row = 0; row < rows; row++) for (let i = 0; i < w * each; i++) {
			const x = -w / 2 + ((i + 0.5) / (w * each)) * w + (r() - 0.5) * 0.05, z = -d / 2 + ((row + 0.5) / rows) * d + (r() - 0.5) * 0.06;
			if (model === "grain" || model === "flax") {
				const tip = stem(t, parts, x, z, high * (0.85 + r() * 0.3), r() * 6.28, limp ? 0.16 : 0.04, c, 0.012);
				if (grown === 1 && model === "grain") parts.push({ g: new t.IcosahedronGeometry(0.03, 0), c, p: tip, s: [0.8, 2, 0.8] });
				if (grown === 1 && model === "flax") {
					if (modelLevel() === "near") blossom(t, parts, tip, 0.022, limp ? c : 0x6f8fe0, r() * Math.PI * 2);
					else parts.push({ g: new t.IcosahedronGeometry(0.03, 0), c: limp ? c : 0x6f8fe0, p: tip });
				}
				if (grown === 1 && model === "grain" && modelLevel() === "near") for (const side of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.006, 0.07, 0.005), c: 0xe4c26e, p: [tip[0] + side * 0.018, tip[1] + 0.035, tip[2]], r: [0, 0, side * -0.4] });
			} else {
				for (let k = 0; k < 4; k++) leaf(t, parts, [x, 0.01, z], (k / 4) * 6.28 + r(), high * 1.1, c, limp ? 0.1 : 0.8);
				if (model === "beet" && grown === 1) parts.push({ g: new t.IcosahedronGeometry(0.06, 0), c: 0xb8486a, p: [x, 0.03, z] });
			}
		}
		return merge(t, parts, `field:${model}`);
	});
}

// ---- buildings ----

/** A plank hut w×d on a stone plinth: corner posts, a straw gable roof with a ridge beam, a door and a window towards +z,
 *  a stone chimney, a stack of firewood beside it. About 1.7 units high for 2×2. */
export function hut(t: T, w: number, d: number, wall: number, variant: number): Geo {
	return cached(`hut:${w}x${d}:${wall}:${variant}`, () => {
		const r = rand(`hut:${variant}`), parts: Part[] = [], ww = w * 0.8, dd = d * 0.78, wh = 0.72, roofC = THATCH[variant % 3]!;
		parts.push({ g: new t.BoxGeometry(w * 0.9, 0.12, d * 0.9), c: STONE, p: [0, 0.06, 0] });
		parts.push({ g: new t.BoxGeometry(ww, wh, dd), c: wall, p: [0, 0.12 + wh / 2, 0] });
		// planks: a darker strip every so often around the walls
		for (let i = 1; i < 4; i++) parts.push({ g: new t.BoxGeometry(ww + 0.02, 0.03, dd + 0.02), c: WOOD_DARK, p: [0, 0.12 + (wh * i) / 4, 0] });
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push({ g: new t.BoxGeometry(0.11, wh + 0.06, 0.11), c: WOOD_DARK, p: [sx * ww / 2, 0.12 + wh / 2 + 0.03, sz * dd / 2] });
		// the gables (a triangle, extruded along x) and the two roof planes over them, the ridge along x
		const rise = 0.5, top = 0.12 + wh;
		const tri = new t.Shape(); tri.moveTo(-dd / 2, 0); tri.lineTo(dd / 2, 0); tri.lineTo(0, rise); tri.closePath();
		parts.push({ g: new t.ExtrudeGeometry(tri, { depth: ww, bevelEnabled: false }), c: wall, p: [-ww / 2, top, 0], r: [0, Math.PI / 2, 0] });
		const slope = Math.atan2(rise, dd / 2), len = Math.hypot(rise, dd / 2) + 0.16;
		for (const side of [-1, 1]) {
			parts.push({ g: new t.BoxGeometry(w * 0.98, 0.07, len), c: roofC, p: [0, top + rise / 2 + 0.04, side * (dd / 4 + 0.04)], r: [side * slope, 0, 0] });
			// v2: the thatch's eave as a darker, thicker edge
			parts.push({ g: new t.BoxGeometry(w * 1.0, 0.1, 0.07), c: WOOD_DARK, p: [0, top + rise / 2 + 0.02 - (len / 2) * Math.sin(slope), side * (dd / 4 + 0.04 + (len / 2) * Math.cos(slope))], r: [side * slope, 0, 0] });
		}
		parts.push({ g: new t.BoxGeometry(w * 1.0, 0.08, 0.1), c: WOOD_DARK, p: [0, top + rise + 0.05, 0] });
		// door and window on the front (+z), the chimney on one side of the ridge
		const front = dd / 2 + 0.015;
		parts.push({ g: new t.BoxGeometry(0.3, 0.48, 0.04), c: 0x3a2a18, p: [w > 1.5 ? -0.25 : 0, 0.12 + 0.24, front] });
		if (w > 1.5) {
			parts.push({ g: new t.BoxGeometry(0.28, 0.24, 0.04), c: WOOD_DARK, p: [0.35, 0.12 + 0.44, front] });
			parts.push({ g: new t.BoxGeometry(0.2, 0.16, 0.05), c: 0xf2c46a, p: [0.35, 0.12 + 0.44, front] }); // lamplight
		}
		const cx = (variant % 2 ? 1 : -1) * ww * 0.28;
		parts.push({ g: new t.BoxGeometry(0.16, 0.5, 0.16), c: STONE_DARK, p: [cx, top + rise * 0.55 + 0.2, -dd * 0.18] });
		// firewood stacked against the left wall
		for (let i = 0; i < 5; i++) parts.push({ g: new t.CylinderGeometry(0.045, 0.045, 0.34, 6), c: i % 2 ? BARK : WOOD, p: [-ww / 2 - 0.08, 0.17 + Math.floor(i / 3) * 0.08, -0.15 + (i % 3) * 0.1 + (i >= 3 ? 0.05 : 0)], r: [Math.PI / 2, 0, 0] });
		void r;
		return merge(t, parts, `hut:${variant}`);
	});
}

/** The rain barrel: staves, two iron hoops, rainwater at the top, on a flat stone. */
export function barrel(t: T, detailed = false): Geo {
	if (detailed) return cached("barrel:near", () => {
		const parts: Part[] = [
			{ g: new t.CylinderGeometry(0.36, 0.38, 0.08, 12), c: STONE, p: [0, 0.04, 0] },
			{ g: new t.CylinderGeometry(0.24, 0.24, 0.02, 24), c: 0x3d7fa0, p: [0, 0.68, 0] },
		];
		for (let i = 0; i < 20; i++) {
			const angle = i * Math.PI * 2 / 20;
			parts.push({ g: new t.BoxGeometry(0.077, 0.61, 0.035), c: i % 2 ? WOOD : WOOD_DARK, p: [Math.sin(angle) * 0.25, 0.39, Math.cos(angle) * 0.25], r: [0, angle, 0] });
		}
		for (const y of [0.22, 0.58]) {
			parts.push({ g: new t.TorusGeometry(0.272, 0.027, 6, 32), c: 0x44464a, p: [0, y, 0], r: [Math.PI / 2, 0, 0] });
			for (let i = 0; i < 8; i++) {
				const angle = i * Math.PI / 4;
				parts.push({ g: new t.IcosahedronGeometry(0.013, 0), c: 0x89909a, p: [Math.sin(angle) * 0.297, y, Math.cos(angle) * 0.297] });
			}
		}
		return merge(t, parts, "barrel:near");
	});
	return cached("barrel", () => modelLevel() === "near" ? barrel(t, true) : merge(t, [
		{ g: new t.CylinderGeometry(0.36, 0.38, 0.08, 8), c: STONE, p: [0, 0.04, 0] },
		{ g: new t.CylinderGeometry(0.27, 0.24, 0.62, 12), c: WOOD, p: [0, 0.39, 0] },
		{ g: new t.TorusGeometry(0.265, 0.025, 4, 14), c: 0x44464a, p: [0, 0.22, 0], r: [Math.PI / 2, 0, 0] },
		{ g: new t.TorusGeometry(0.275, 0.025, 4, 14), c: 0x44464a, p: [0, 0.58, 0], r: [Math.PI / 2, 0, 0] },
		{ g: new t.CylinderGeometry(0.24, 0.24, 0.02, 12), c: 0x3d7fa0, p: [0, 0.68, 0] },
	], "barrel"));
}

/** The hive: a straw skep of coiled rings on a stand of two driftwood boards, its entrance dark at the foot, a few bees
 *  about it. About 0.8 high. */
function hive(t: T): Geo {
	return cached("hive", () => {
		const straw = 0xd8a83a, parts: Part[] = [
			{ g: new t.BoxGeometry(0.6, 0.06, 0.6), c: WOOD_DARK, p: [0, 0.3, 0] },
			...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({ g: new t.BoxGeometry(0.06, 0.3, 0.06), c: WOOD_DARK, p: [sx! * 0.24, 0.15, sz! * 0.24] as V3 })),
			{ g: new t.SphereGeometry(0.27, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), c: straw, p: [0, 0.42, 0], s: [1, 1.45, 1] },
			{ g: new t.CylinderGeometry(0.27, 0.27, 0.1, 12), c: straw, p: [0, 0.38, 0] },
			{ g: new t.BoxGeometry(0.1, 0.06, 0.04), c: 0x2a1a10, p: [0, 0.37, 0.265] },
		];
		for (const [y, r] of [[0.48, 0.265], [0.6, 0.235], [0.71, 0.17]] as const) parts.push({ g: new t.TorusGeometry(r, 0.018, 4, 16), c: 0xa87a22, p: [0, y, 0], r: [Math.PI / 2, 0, 0] });
		for (const [x, y, z] of [[0.32, 0.62, 0.1], [-0.25, 0.75, 0.22], [0.12, 0.88, -0.2]] as const) parts.push({ g: new t.IcosahedronGeometry(0.025, 0), c: 0xe8b830, p: [x, y, z] });
		return merge(t, parts, "hive");
	});
}

/** The scarecrow: a driftwood post and crossbar in a patched shirt, a straw head under a wide hat, straw sticking out
 *  of the sleeves, on a little mound. About 1.3 units high. */
function scarecrow(t: T, variant: number): Geo {
	return cached(`scarecrow:${variant}`, () => {
		const shirt = [0x8a4a3a, 0x4a6a8a, 0x6a7a3a][variant % 3]!, straw = 0xd8b45a, parts: Part[] = [
			{ g: new t.CylinderGeometry(0.22, 0.3, 0.1, 8), c: 0x6b5236, p: [0, 0.05, 0] },
			{ g: new t.BoxGeometry(0.07, 1.05, 0.07), c: WOOD_DARK, p: [0, 0.55, 0] },
			{ g: new t.BoxGeometry(0.78, 0.06, 0.06), c: WOOD_DARK, p: [0, 0.82, 0] },
			{ g: new t.BoxGeometry(0.3, 0.36, 0.18), c: shirt, p: [0, 0.74, 0], r: [0, 0, 0.04] },
			{ g: new t.BoxGeometry(0.62, 0.12, 0.13), c: shirt, p: [0, 0.84, 0] },
			{ g: new t.BoxGeometry(0.1, 0.06, 0.19), c: 0xc8a050, p: [0.06, 0.66, 0.0] }, // a patch
			{ g: new t.ConeGeometry(0.06, 0.16, 5), c: straw, p: [0.39, 0.82, 0], r: [0, 0, -Math.PI / 2] },
			{ g: new t.ConeGeometry(0.06, 0.16, 5), c: straw, p: [-0.39, 0.82, 0], r: [0, 0, Math.PI / 2] },
			{ g: new t.ConeGeometry(0.1, 0.14, 6), c: straw, p: [0, 0.52, 0], r: [Math.PI, 0, 0] }, // straw from the shirt's hem
			{ g: new t.IcosahedronGeometry(0.14, 0), c: straw, p: [0, 1.05, 0] },
			{ g: new t.BoxGeometry(0.035, 0.035, 0.02), c: 0x2a2018, p: [-0.05, 1.07, 0.13] },
			{ g: new t.BoxGeometry(0.035, 0.035, 0.02), c: 0x2a2018, p: [0.05, 1.07, 0.13] },
			{ g: new t.CylinderGeometry(0.26, 0.26, 0.03, 9), c: 0x7a5a30, p: [0, 1.16, 0], r: [0.12, 0, 0.05] },
			{ g: new t.ConeGeometry(0.13, 0.2, 7), c: 0x7a5a30, p: [0, 1.27, 0], r: [0.12, 0, 0.05] },
		];
		return merge(t, parts, `scarecrow:${variant}`);
	});
}

/** The windmill: a tapering eight-sided tower of planks on a stone plinth, a thatched cap, and four linen sails on a hub
 *  towards +z (one turned a little per variant), a door at the foot. About 2.6 units high. */
function windmill(t: T, variant: number): Geo {
	return cached(`windmill:${variant}`, () => {
		const LINEN = 0xe8e0cc, parts: Part[] = [
			{ g: new t.CylinderGeometry(0.85, 0.9, 0.14, 8), c: STONE, p: [0, 0.07, 0] },
			{ g: new t.CylinderGeometry(0.42, 0.7, 1.6, 8), c: WOOD, p: [0, 0.94, 0] },
			{ g: new t.CylinderGeometry(0.6, 0.6, 0.05, 8), c: WOOD_DARK, p: [0, 0.6, 0] },
			{ g: new t.CylinderGeometry(0.5, 0.5, 0.05, 8), c: WOOD_DARK, p: [0, 1.2, 0] },
			{ g: new t.ConeGeometry(0.58, 0.55, 8), c: THATCH[variant % 3]!, p: [0, 2.0, 0] },
			{ g: new t.BoxGeometry(0.28, 0.46, 0.06), c: 0x3a2a18, p: [0, 0.37, 0.66], r: [-0.12, 0, 0] },
			{ g: new t.CylinderGeometry(0.07, 0.07, 0.36, 6), c: WOOD_DARK, p: [0, 1.85, 0.5], r: [Math.PI / 2, 0, 0] },
		];
		const turn = (variant * Math.PI) / 7;
		for (let i = 0; i < 4; i++) {
			const a = turn + (i * Math.PI) / 2, cx = Math.cos(a), cy = Math.sin(a), y = 1.85, z = 0.7;
			parts.push({ g: new t.BoxGeometry(0.05, 1.05, 0.04), c: WOOD_DARK, p: [-cy * 0.52, y + cx * 0.52, z], r: [0, 0, a] }); // the stock
			parts.push({ g: new t.BoxGeometry(0.24, 0.8, 0.02), c: LINEN, p: [-cy * 0.6 + cx * 0.13, y + cx * 0.6 + cy * 0.13, z + 0.02], r: [0, 0, a] }); // the sail
		}
		return merge(t, parts, `windmill:${variant}`);
	});
}

/** The bakery: a squat stone house with a plank roof, and beside it the round clay oven with its mouth and chimney.
 *  About 1.5 units high for 2×2. */
function bakery(t: T, w: number, d: number, variant: number): Geo {
	return cached(`bakery:${w}x${d}:${variant}`, () => {
		const CLAY = 0xb0604a, ww = w * 0.55, dd = d * 0.75, wh = 0.62, parts: Part[] = [
			{ g: new t.BoxGeometry(w * 0.92, 0.1, d * 0.9), c: STONE, p: [0, 0.05, 0] },
			{ g: new t.BoxGeometry(ww, wh, dd), c: STONE_DARK, p: [-w * 0.18, 0.1 + wh / 2, 0] },
			{ g: new t.BoxGeometry(ww + 0.16, 0.08, dd + 0.16), c: WOOD_DARK, p: [-w * 0.18, 0.1 + wh + 0.04, 0], r: [0, 0, 0.12] },
			{ g: new t.BoxGeometry(0.26, 0.42, 0.04), c: 0x3a2a18, p: [-w * 0.18, 0.1 + 0.21, dd / 2 + 0.015] },
			{ g: new t.SphereGeometry(0.42, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), c: CLAY, p: [w * 0.27, 0.1, 0.05] },
			{ g: new t.BoxGeometry(0.2, 0.16, 0.06), c: 0x2a1a10, p: [w * 0.27, 0.18, 0.46] },
			{ g: new t.BoxGeometry(0.14, 0.12, 0.05), c: 0xf2a04a, p: [w * 0.27, 0.17, 0.47] }, // embers
			{ g: new t.CylinderGeometry(0.07, 0.09, 0.4, 6), c: STONE_DARK, p: [w * 0.27, 0.62, -0.1] },
		];
		for (let i = 0; i < 3; i++) parts.push({ g: new t.CylinderGeometry(0.04, 0.04, 0.3, 6), c: i % 2 ? BARK : WOOD, p: [w * 0.27 + (i - 1) * 0.09, 0.14, -0.42], r: [0, 0, Math.PI / 2] });
		return merge(t, parts, `bakery:${variant}`);
	});
}

/** A hen, small, facing +z, at a place: body, tail, head, red comb. */
function henParts(t: T, x: number, z: number, turn: number): Part[] {
	const c = Math.cos(turn), s = Math.sin(turn), at = (dx: number, y: number, dz: number): V3 => [x + dx * c + dz * s, y, z - dx * s + dz * c];
	return [
		{ g: new t.IcosahedronGeometry(0.11, 0), c: 0xb0703a, p: at(0, 0.12, 0), s: [1, 0.9, 1.3] },
		{ g: new t.ConeGeometry(0.06, 0.12, 4), c: 0x6e3e1a, p: at(0, 0.2, -0.12), r: [-0.8, turn, 0] },
		{ g: new t.IcosahedronGeometry(0.065, 0), c: 0xb0703a, p: at(0, 0.24, 0.1) },
		{ g: new t.BoxGeometry(0.02, 0.05, 0.06), c: 0xd83a2a, p: at(0, 0.31, 0.1) },
	];
}

/** The hen house w×1: a little plank shed on legs, a pent roof, a ramp to its hatch towards +z, and hens about it. */
function coop(t: T, w: number, variant: number): Geo {
	return cached(`coop:${w}:${variant}`, () => {
		const ww = w * 0.55, parts: Part[] = [
			...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({ g: new t.BoxGeometry(0.06, 0.22, 0.06), c: WOOD_DARK, p: [-w * 0.18 + sx! * ww * 0.45, 0.11, sz! * 0.25] as V3 })),
			{ g: new t.BoxGeometry(ww, 0.4, 0.6), c: WOOD, p: [-w * 0.18, 0.42, 0] },
			{ g: new t.BoxGeometry(ww + 0.14, 0.05, 0.74), c: THATCH[variant % 3]!, p: [-w * 0.18, 0.66, 0], r: [0.22, 0, 0] },
			{ g: new t.BoxGeometry(0.14, 0.14, 0.03), c: 0x2a1a10, p: [-w * 0.18, 0.4, 0.31] },
			{ g: new t.BoxGeometry(0.14, 0.03, 0.42), c: WOOD_DARK, p: [-w * 0.18, 0.18, 0.48], r: [0.55, 0, 0] },
		];
		const r = rand(`coop:${variant}`);
		for (let i = 0; i < 3; i++) parts.push(...henParts(t, w * 0.12 + r() * w * 0.3, -0.25 + r() * 0.5, r() * Math.PI * 2));
		return merge(t, parts, `coop:${variant}`);
	});
}

/** The pen w×d: a driftwood fence of posts and two rails, a trough, a little shelter in a corner, and its animals: a
 *  sheep, a goat, a cow, a pig, two ducks by a puddle or two geese (none while it is empty). */
function pen(t: T, w: number, d: number, variant: number, herd: string | undefined): Geo {
	return cached(`pen:${w}x${d}:${variant}:${herd ?? ""}`, () => {
		const ww = w * 0.92, dd = d * 0.92, parts: Part[] = [];
		const posts = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n - 0.5);
		for (const f of posts(Math.round(w * 2))) for (const sz of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.07, 0.42, 0.07), c: WOOD_DARK, p: [f * ww, 0.21, (sz * dd) / 2] });
		for (const f of posts(Math.round(d * 2))) for (const sx of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.07, 0.42, 0.07), c: WOOD_DARK, p: [(sx * ww) / 2, 0.21, f * dd] });
		for (const y of [0.16, 0.33]) {
			for (const sz of [-1, 1]) parts.push({ g: new t.BoxGeometry(ww, 0.04, 0.04), c: WOOD, p: [0, y, (sz * dd) / 2] });
			for (const sx of [-1, 1]) parts.push({ g: new t.BoxGeometry(0.04, 0.04, dd), c: WOOD, p: [(sx * ww) / 2, y, 0] });
		}
		parts.push({ g: new t.BoxGeometry(0.5, 0.12, 0.18), c: WOOD_DARK, p: [ww * 0.2, 0.06, dd * 0.32] }); // the trough
		parts.push({ g: new t.BoxGeometry(0.7, 0.45, 0.6), c: WOOD, p: [-ww * 0.3, 0.23, -dd * 0.3] });  // the shelter
		parts.push({ g: new t.BoxGeometry(0.82, 0.05, 0.74), c: THATCH[variant % 3]!, p: [-ww * 0.3, 0.5, -dd * 0.3], r: [0.2, 0, 0] });
		const four = (fur: number, legs: number, head: number, x: number, horns: boolean) => {
			parts.push({ g: new t.IcosahedronGeometry(0.2, 0), c: fur, p: [x, 0.28, 0], s: [1.3, 0.9, 1] });
			parts.push({ g: new t.IcosahedronGeometry(0.09, 0), c: head, p: [x + 0.27, 0.34, 0] });
			if (modelLevel() === "near") {
				for (const side of [-1, 1]) parts.push({ g: new t.IcosahedronGeometry(0.012, 0), c: 0x171410, p: [x + 0.32, 0.36, side * 0.066] });
				if (herd === "schaf") for (let i = 0; i < 6; i++) parts.push({ g: new t.IcosahedronGeometry(0.065, 0), c: i % 2 ? fur : 0xf0ece0, p: [x - 0.13 + (i % 3) * 0.13, 0.4, i < 3 ? -0.08 : 0.08] });
				if (herd === "rind") for (const side of [-1, 1]) parts.push({ g: new t.IcosahedronGeometry(0.085, 0), c: 0xe5d9bc, p: [x - 0.04, 0.29, side * 0.17], s: [1.4, 1, 0.25] });
			}
			if (horns) for (const dz of [-0.04, 0.04]) parts.push({ g: new t.ConeGeometry(0.02, 0.12, 4), c: 0x5e5240, p: [x + 0.24, 0.46, dz], r: [0, 0, 0.5] });
			for (const [dx, dz] of [[-0.12, -0.08], [-0.12, 0.08], [0.14, -0.08], [0.14, 0.08]] as const) parts.push({ g: new t.BoxGeometry(0.04, 0.16, 0.04), c: legs, p: [x + dx, 0.08, dz] });
		};
		const fowl = (body: number, head: number, x: number, z: number, neck: number) => {
			parts.push({ g: new t.IcosahedronGeometry(0.1, 0), c: body, p: [x, 0.1, z], s: [1.4, 0.9, 1] });
			parts.push({ g: new t.BoxGeometry(0.04, neck, 0.04), c: body, p: [x + 0.11, 0.12 + neck / 2, z] });
			parts.push({ g: new t.IcosahedronGeometry(0.05, 0), c: head, p: [x + 0.12, 0.14 + neck, z] });
			parts.push({ g: new t.BoxGeometry(0.06, 0.02, 0.03), c: 0xe8902c, p: [x + 0.18, 0.14 + neck, z] });
			if (modelLevel() === "near") for (const side of [-1, 1]) parts.push({ g: new t.IcosahedronGeometry(0.008, 0), c: 0x171410, p: [x + 0.145, 0.15 + neck, z + side * 0.036] }, { g: new t.BoxGeometry(0.018, 0.045, 0.026), c: 0xd99a38, p: [x, 0.023, z + side * 0.03] });
		};
		if (herd === "schaf") four([0xe8e4d8, 0xd8d0c0, 0xf0ece0][variant % 3]!, 0x3a3430, 0x3a3430, ww * 0.1, false);
		if (herd === "ziege") four(0xa89a80, 0x5e5240, 0xa89a80, ww * 0.1, true);
		if (herd === "rind") four(0x7a5a3a, 0x4a3522, 0x7a5a3a, ww * 0.16, true);
		if (herd === "schwein") four(0xe8a0a0, 0xb06a6e, 0xf0b0ac, ww * 0.1, false);
		if (herd === "ente" || herd === "gans") {
			if (herd === "ente") parts.push({ g: new t.CylinderGeometry(0.3, 0.3, 0.02, 10), c: 0x3d7fa0, p: [ww * 0.15, 0.01, -dd * 0.05] }); // a puddle
			for (const [x, z] of [[ww * 0.05, 0.1], [ww * 0.25, -0.15]] as const) herd === "ente" ? fowl(0x8a7a5a, 0x2f6a4a, x, z, 0.04) : fowl(0xf0ece0, 0xf0ece0, x, z, 0.16);
		}
		return merge(t, parts, `pen:${variant}`);
	});
}

/** The loom w×1: an open lean-to on four posts and under it the loom's frame, a cloth on its beam, a stool. */
/** A jetty as a small bridge over its long side: planks on a low arch one can walk over, piles at each cell, a handrail on both sides. */
export function jettyGeometry(t: T, w: number, d: number): Geo {
	return cached(`jetty:${w}x${d}`, () => {
		const along = w >= d, long = (along ? w : d) * 0.98, wide = (along ? d : w) * 0.84, rise = 0.07, parts: Part[] = [], cells = Math.round(along ? w : d), n = cells * 7;
		const high = (f: number) => 0.12 + rise * (1 - 4 * f * f), slope = (f: number) => Math.atan((-8 * rise * f) / long);
		/** A beam `len` long over the bridge, at `at` along it and `side` across, leaning with the arch by `a`. */
		const beam = (len: number, tall: number, thick: number, at: number, y: number, side: number, a: number, c: number): Part => (along
			? { g: new t.BoxGeometry(len, tall, thick), c, p: [at, y, side], r: [0, 0, a] }
			: { g: new t.BoxGeometry(thick, tall, len), c, p: [side, y, at], r: [-a, 0, 0] });
		for (let i = 0; i < n; i++) {
			const f = (i + 0.5) / n - 0.5;
			parts.push(beam((long / n) * 0.86, 0.035, wide, f * long, high(f), 0, slope(f), i % 3 ? WOOD : 0x7a5c3a));
		}
		for (const sz of [-1, 1]) {
			const side = (sz * wide) / 2;
			for (let i = 0; i <= cells; i++) {
				const f = i / cells - 0.5, top = high(f) + 0.3;
				parts.push(beam(0.07, top + 0.2, 0.07, f * long, (top - 0.2) / 2, side, 0, WOOD_DARK));
			}
			for (let i = 0; i < cells; i++) {
				const f = (i + 0.5) / cells - 0.5, len = (long / cells) * 1.04;
				parts.push(beam(len, 0.04, 0.04, f * long, high(f) + 0.28, side, slope(f), WOOD));
				parts.push(beam(len, 0.03, 0.03, f * long, high(f) + 0.15, side, slope(f), WOOD));
			}
		}
		return merge(t, parts, "jetty");
	});
}

/** A built jetty: a flat deck of planks across its long side on piles standing in the water, a mooring post at each
 *  corner and a coiled rope; no arch and no rail (the bridge of jettyGeometry is the crossings' scenery). */
export function pierGeometry(t: T, w: number, d: number): Geo {
	return cached(`pier:${w}x${d}`, () => {
		const along = w >= d, long = (along ? w : d) * 0.98, wide = (along ? d : w) * 0.8, cells = Math.round(along ? w : d), n = cells * 6, deck = 0.14, parts: Part[] = [];
		const box = (lx: number, h: number, lz: number, at: number, y: number, side: number, c: number): Part => (along
			? { g: new t.BoxGeometry(lx, h, lz), c, p: [at, y, side] }
			: { g: new t.BoxGeometry(lz, h, lx), c, p: [side, y, at] });
		// the planks lie across, with a narrow gap between them
		for (let i = 0; i < n; i++) parts.push(box((long / n) * 0.88, 0.035, wide, ((i + 0.5) / n - 0.5) * long, deck, 0, i % 4 ? WOOD : 0x7a5c3a));
		// two stringers under them along the length, the piles down into the water
		for (const sz of [-1, 1]) {
			parts.push(box(long, 0.05, 0.06, 0, deck - 0.04, (sz * wide) / 2.6, WOOD_DARK));
			for (let i = 0; i <= cells; i++) parts.push(box(0.08, 0.6, 0.08, (i / cells - 0.5) * long * 0.96, deck - 0.3, (sz * wide) / 2.2, WOOD_DARK));
		}
		// mooring posts at the corners, a little above the deck
		for (const ex of [-1, 1]) for (const sz of [-1, 1]) parts.push(along
			? { g: new t.CylinderGeometry(0.05, 0.06, 0.22, 8), c: WOOD_DARK, p: [(ex * long) / 2.1, deck + 0.1, (sz * wide) / 2.2] }
			: { g: new t.CylinderGeometry(0.05, 0.06, 0.22, 8), c: WOOD_DARK, p: [(sz * wide) / 2.2, deck + 0.1, (ex * long) / 2.1] });
		parts.push({ g: new t.TorusGeometry(0.08, 0.025, 6, 12), c: 0xc8b48a, p: along ? [long * 0.3, deck + 0.04, wide * 0.15] : [wide * 0.15, deck + 0.04, long * 0.3], r: [Math.PI / 2, 0, 0] });
		return merge(t, parts, "pier");
	});
}

function loom(t: T, w: number, variant: number): Geo {
	return cached(`loom:${w}:${variant}`, () => {
		const ww = w * 0.85, cloth = [0x8a6a9a, 0x6a8a9a, 0x9a6a5a][variant % 3]!, parts: Part[] = [
			{ g: new t.BoxGeometry(w * 0.92, 0.06, 0.86), c: STONE, p: [0, 0.03, 0] },
			...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({ g: new t.BoxGeometry(0.07, 0.9, 0.07), c: WOOD_DARK, p: [sx! * ww / 2, 0.48, sz! * 0.36] as V3 })),
			{ g: new t.BoxGeometry(ww + 0.2, 0.05, 0.95), c: THATCH[variant % 3]!, p: [0, 0.95, 0], r: [0.18, 0, 0] },
			// the loom: two side frames, the beams, the warp and the cloth woven so far
			{ g: new t.BoxGeometry(0.05, 0.6, 0.4), c: WOOD, p: [-0.4, 0.36, 0] },
			{ g: new t.BoxGeometry(0.05, 0.6, 0.4), c: WOOD, p: [0.4, 0.36, 0] },
			{ g: new t.BoxGeometry(0.85, 0.05, 0.05), c: WOOD_DARK, p: [0, 0.64, -0.12] },
			{ g: new t.BoxGeometry(0.85, 0.05, 0.05), c: WOOD_DARK, p: [0, 0.32, 0.16] },
			{ g: new t.BoxGeometry(0.7, 0.3, 0.01), c: 0xe8e0cc, p: [0, 0.5, -0.0], r: [-0.8, 0, 0] },
			{ g: new t.BoxGeometry(0.7, 0.12, 0.012), c: cloth, p: [0, 0.37, 0.12], r: [-0.8, 0, 0] },
			{ g: new t.CylinderGeometry(0.1, 0.1, 0.22, 6), c: WOOD, p: [0, 0.11, 0.38] }, // the stool
		];
		return merge(t, parts, `loom:${variant}`);
	});
}

/** A building by its plan: the hut, the rain barrel, the scarecrow, the windmill, the bakery, the coop, the pen (with
 *  its `herd`), the loom, the jetty (a pier into the water), any other plan a hut in its colour. */
export function buildingGeometry(t: T, plan: string | undefined, w: number, d: number, color: number, variant: number, herd?: string): Geo {
	return plan === "regentonne" ? barrel(t) : plan === "vogelscheuche" ? scarecrow(t, variant % 3) : plan === "windmuehle" ? windmill(t, variant % 3) : plan === "backhaus" ? bakery(t, w, d, variant % 3) : plan === "huehnerstall" ? coop(t, w, variant % 3) : plan === "bienenstock" ? hive(t) : plan === "gehege" ? pen(t, w, d, variant % 3, herd) : plan === "webstuhl" ? loom(t, w, variant % 3) : plan === "steg" ? pierGeometry(t, w, d) : hut(t, w, d, color, variant % 3);
}

/** A hare, sitting up a little, its nose towards +z: body, haunches, head, long ears, a white scut. About 0.4 high. */
export function hareGeometry(t: T, variant: number): Geo {
	return cached(`hare:${variant}`, () => {
		const fur = [0x9a7f5e, 0x8a7258, 0xa88e6a][variant % 3]!, belly = 0xd9c9ae;
		return merge(t, [
			{ g: new t.IcosahedronGeometry(0.15, 0), c: fur, p: [0, 0.16, -0.04], s: [1, 0.95, 1.35] },
			{ g: new t.IcosahedronGeometry(0.1, 0), c: fur, p: [0.09, 0.1, -0.12] },
			{ g: new t.IcosahedronGeometry(0.1, 0), c: fur, p: [-0.09, 0.1, -0.12] },
			{ g: new t.IcosahedronGeometry(0.09, 0), c: belly, p: [0, 0.13, 0.08], s: [1, 1.1, 0.8] },
			{ g: new t.IcosahedronGeometry(0.095, 0), c: fur, p: [0, 0.3, 0.13], s: [0.95, 0.9, 1.15] },
			{ g: new t.BoxGeometry(0.045, 0.2, 0.025), c: fur, p: [0.04, 0.45, 0.09], r: [-0.35, 0, 0.18] },
			{ g: new t.BoxGeometry(0.045, 0.2, 0.025), c: fur, p: [-0.04, 0.45, 0.09], r: [-0.35, 0, -0.18] },
			{ g: new t.BoxGeometry(0.025, 0.14, 0.01), c: 0xd8a0a0, p: [0.04, 0.45, 0.105], r: [-0.35, 0, 0.18] },
			{ g: new t.BoxGeometry(0.025, 0.14, 0.01), c: 0xd8a0a0, p: [-0.04, 0.45, 0.105], r: [-0.35, 0, -0.18] },
			{ g: new t.IcosahedronGeometry(0.02, 0), c: 0x3a2a2a, p: [0, 0.3, 0.23] },
			{ g: new t.BoxGeometry(0.02, 0.02, 0.02), c: 0x111111, p: [0.055, 0.33, 0.19] },
			{ g: new t.BoxGeometry(0.02, 0.02, 0.02), c: 0x111111, p: [-0.055, 0.33, 0.19] },
			{ g: new t.IcosahedronGeometry(0.045, 0), c: 0xf2efe8, p: [0, 0.17, -0.25] },
			{ g: new t.BoxGeometry(0.04, 0.04, 0.12), c: fur, p: [0.05, 0.03, 0.12] },
			{ g: new t.BoxGeometry(0.04, 0.04, 0.12), c: fur, p: [-0.05, 0.03, 0.12] },
		], `hare:${variant}`);
	});
}

function closeEyes(t: T, parts: Part[], width: number, y: number, z: number): void {
	if (modelLevel() !== "near") return;
	for (const side of [-1, 1]) parts.push({ g: new t.IcosahedronGeometry(0.012, 0), c: 0x16120f, p: [side * width, y, z] });
}

function whiskers(t: T, y: number, z: number): Part[] {
	if (modelLevel() !== "near") return [];
	const parts: Part[] = [];
	for (const side of [-1, 1]) for (let i = -1; i <= 1; i++) parts.push({ g: new t.BoxGeometry(0.065, 0.002, 0.002), c: 0xd8cbb8, p: [side * 0.04, y + i * 0.008, z], r: [0, 0, side * i * 0.12] });
	return parts;
}

/** A deer, slender on four long legs, facing +z: body, neck and head, big ears, a white scut. */
function deerGeometry(t: T, variant: number): Geo {
	return cached(`deer:${variant}`, () => {
		const fur = [0xa0703e, 0x946638, 0xa87a48][variant % 3]!, dark = 0x4a3220;
		const parts: Part[] = [
			{ g: new t.IcosahedronGeometry(0.18, 0), c: fur, p: [0, 0.48, 0], s: [0.85, 0.85, 1.6] },
			{ g: new t.BoxGeometry(0.08, 0.26, 0.08), c: fur, p: [0, 0.66, 0.24], r: [0.45, 0, 0] },
			{ g: new t.IcosahedronGeometry(0.08, 0), c: fur, p: [0, 0.8, 0.32], s: [0.9, 0.9, 1.4] },
			{ g: new t.ConeGeometry(0.035, 0.12, 4), c: fur, p: [0.06, 0.9, 0.3], r: [0, 0, -0.5] },
			{ g: new t.ConeGeometry(0.035, 0.12, 4), c: fur, p: [-0.06, 0.9, 0.3], r: [0, 0, 0.5] },
			{ g: new t.IcosahedronGeometry(0.02, 0), c: 0x1a1410, p: [0, 0.79, 0.43] },
			{ g: new t.IcosahedronGeometry(0.045, 0), c: 0xf2efe8, p: [0, 0.52, -0.28] },
		];
		for (const [dx, dz] of [[-0.07, -0.18], [0.07, -0.18], [-0.07, 0.18], [0.07, 0.18]] as const) parts.push({ g: new t.BoxGeometry(0.035, 0.4, 0.035), c: dark, p: [dx, 0.2, dz] });
		closeEyes(t, parts, 0.056, 0.82, 0.385);
		return merge(t, parts, `deer:${variant}`);
	});
}

/** A fox, low and long, facing +z: rust body with a white chest, black socks, pointed ears, a bushy tail with a white tip. */
function foxGeometry(t: T, variant: number): Geo {
	return cached(`fox:${variant}`, () => {
		const fur = [0xc8642a, 0xb85a24, 0xd0703a][variant % 3]!;
		const parts: Part[] = [
			{ g: new t.IcosahedronGeometry(0.13, 0), c: fur, p: [0, 0.22, 0], s: [0.9, 0.85, 1.6] },
			{ g: new t.IcosahedronGeometry(0.07, 0), c: 0xf2efe8, p: [0, 0.2, 0.15] },
			{ g: new t.IcosahedronGeometry(0.08, 0), c: fur, p: [0, 0.3, 0.24] },
			{ g: new t.ConeGeometry(0.045, 0.12, 4), c: fur, p: [0, 0.27, 0.34], r: [Math.PI / 2, 0, 0] },
			{ g: new t.IcosahedronGeometry(0.015, 0), c: 0x111111, p: [0, 0.27, 0.4] },
			{ g: new t.ConeGeometry(0.03, 0.08, 4), c: 0x3a2418, p: [0.045, 0.39, 0.22] },
			{ g: new t.ConeGeometry(0.03, 0.08, 4), c: 0x3a2418, p: [-0.045, 0.39, 0.22] },
			{ g: new t.IcosahedronGeometry(0.07, 0), c: fur, p: [0, 0.22, -0.28], s: [0.9, 0.9, 2] },
			{ g: new t.IcosahedronGeometry(0.04, 0), c: 0xf2efe8, p: [0, 0.2, -0.42] },
		];
		for (const [dx, dz] of [[-0.06, -0.12], [0.06, -0.12], [-0.06, 0.12], [0.06, 0.12]] as const) parts.push({ g: new t.BoxGeometry(0.035, 0.16, 0.035), c: 0x2a1a12, p: [dx, 0.08, dz] });
		closeEyes(t, parts, 0.055, 0.33, 0.29); parts.push(...whiskers(t, 0.275, 0.36));
		return merge(t, parts, `fox:${variant}`);
	});
}

/** A mouse, tiny, facing +z: a grey body, round ears, a long thin tail. */
function mouseGeometry(t: T, variant: number): Geo {
	return cached(`mouse:${variant}`, () => {
		const fur = [0x8a8278, 0x7a6e62, 0x9a9088][variant % 3]!;
		return merge(t, [
			{ g: new t.IcosahedronGeometry(0.06, 0), c: fur, p: [0, 0.05, 0], s: [0.9, 0.8, 1.4] },
			{ g: new t.IcosahedronGeometry(0.035, 0), c: fur, p: [0, 0.06, 0.08] },
			{ g: new t.CylinderGeometry(0.025, 0.025, 0.01, 6), c: 0xd8a0a0, p: [0.025, 0.1, 0.07], r: [Math.PI / 2, 0, 0] },
			{ g: new t.CylinderGeometry(0.025, 0.025, 0.01, 6), c: 0xd8a0a0, p: [-0.025, 0.1, 0.07], r: [Math.PI / 2, 0, 0] },
			{ g: new t.IcosahedronGeometry(0.008, 0), c: 0x111111, p: [0, 0.06, 0.12] },
			{ g: new t.BoxGeometry(0.008, 0.008, 0.16), c: 0xc8a0a0, p: [0, 0.03, -0.15], r: [0.2, 0, 0] },
		], `mouse:${variant}`);
	});
}

/** A gull standing, facing +z: white body, grey wings with black tips, a yellow beak. */
function gullGeometry(t: T, variant: number): Geo {
	return cached(`gull:${variant}`, () => {
		const white = 0xf2f0ea, grey = [0x9aa4ae, 0x8a949e, 0xa8b0b8][variant % 3]!, black = 0x2a2a30, yellow = 0xe8b830;
		const parts: Part[] = [
			{ g: new t.IcosahedronGeometry(0.11, 0), c: white, p: [0, 0.2, 0], s: [0.85, 0.8, 1.4] },
			{ g: new t.IcosahedronGeometry(0.065, 0), c: white, p: [0, 0.31, 0.12] },
			{ g: new t.ConeGeometry(0.018, 0.08, 4), c: yellow, p: [0, 0.3, 0.2], r: [Math.PI / 2, 0, 0] },
			{ g: new t.IcosahedronGeometry(0.01, 0), c: 0x111111, p: [0.04, 0.33, 0.15] },
			{ g: new t.IcosahedronGeometry(0.01, 0), c: 0x111111, p: [-0.04, 0.33, 0.15] },
			{ g: new t.BoxGeometry(0.08, 0.025, 0.1), c: black, p: [0, 0.2, -0.17] },
		];
		for (const side of [-1, 1]) {
			parts.push({ g: new t.BoxGeometry(0.03, 0.08, 0.22), c: grey, p: [side * 0.09, 0.22, -0.02], r: [0, 0, side * 0.2] });
			parts.push({ g: new t.BoxGeometry(0.025, 0.05, 0.07), c: black, p: [side * 0.09, 0.22, -0.15], r: [0, 0, side * 0.2] });
			parts.push({ g: new t.CylinderGeometry(0.008, 0.008, 0.11, 4), c: yellow, p: [side * 0.035, 0.055, 0] });
		}
		return merge(t, parts, `gull:${variant}`);
	});
}

/** An animal from the fog by its kind (wild.ts): hare, deer, fox, mouse or gull. */
export function wildGeometry(t: T, kind: string | undefined, variant: number): Geo {
	return kind === "reh" ? deerGeometry(t, variant) : kind === "fuchs" ? foxGeometry(t, variant) : kind === "maus" ? mouseGeometry(t, variant) : kind === "moewe" ? gullGeometry(t, variant) : hareGeometry(t, variant);
}

/** A dog or a cat on guard at a building (animals.ts), facing +z: the dog stands with its tail up, the cat sits. */
export function keeperGeometry(t: T, kind: string, variant: number): Geo {
	return cached(`keeper:${kind}:${variant}`, () => {
		if (kind === "katze") {
			const fur = [0xc8904a, 0x6a6460, 0x2a2420][variant % 3]!;
			return merge(t, [
				{ g: new t.IcosahedronGeometry(0.1, 0), c: fur, p: [0, 0.12, 0], s: [1, 1.2, 1] },
				{ g: new t.IcosahedronGeometry(0.07, 0), c: fur, p: [0, 0.27, 0.03] },
				{ g: new t.ConeGeometry(0.025, 0.06, 4), c: fur, p: [0.035, 0.34, 0.03] },
				{ g: new t.ConeGeometry(0.025, 0.06, 4), c: fur, p: [-0.035, 0.34, 0.03] },
				{ g: new t.IcosahedronGeometry(0.012, 0), c: 0x6aa04a, p: [0.025, 0.28, 0.09] },
				{ g: new t.IcosahedronGeometry(0.012, 0), c: 0x6aa04a, p: [-0.025, 0.28, 0.09] },
				{ g: new t.BoxGeometry(0.025, 0.025, 0.2), c: fur, p: [0.06, 0.03, -0.06], r: [0, 0.7, 0] },
				...whiskers(t, 0.255, 0.095),
			], `keeper:${kind}`);
		}
		const fur = [0x8a6a4a, 0x4a3a2a, 0xc8b08a][variant % 3]!;
		const parts: Part[] = [
			{ g: new t.IcosahedronGeometry(0.13, 0), c: fur, p: [0, 0.25, 0], s: [0.9, 0.85, 1.5] },
			{ g: new t.IcosahedronGeometry(0.085, 0), c: fur, p: [0, 0.38, 0.2] },
			{ g: new t.BoxGeometry(0.06, 0.05, 0.08), c: fur, p: [0, 0.35, 0.3] },
			{ g: new t.IcosahedronGeometry(0.015, 0), c: 0x111111, p: [0, 0.37, 0.34] },
			{ g: new t.BoxGeometry(0.03, 0.08, 0.05), c: 0x3a2a1a, p: [0.07, 0.38, 0.18], r: [0, 0, -0.3] },
			{ g: new t.BoxGeometry(0.03, 0.08, 0.05), c: 0x3a2a1a, p: [-0.07, 0.38, 0.18], r: [0, 0, 0.3] },
			{ g: new t.BoxGeometry(0.03, 0.03, 0.14), c: fur, p: [0, 0.34, -0.22], r: [-0.8, 0, 0] },
		];
		for (const [dx, dz] of [[-0.06, -0.1], [0.06, -0.1], [-0.06, 0.1], [0.06, 0.1]] as const) parts.push({ g: new t.BoxGeometry(0.04, 0.18, 0.04), c: fur, p: [dx, 0.09, dz] });
		closeEyes(t, parts, 0.055, 0.4, 0.255);
		if (modelLevel() === "near") parts.push({ g: new t.TorusGeometry(0.066, 0.008, 4, 12), c: 0xa34c31, p: [0, 0.34, 0.18], r: [Math.PI / 2, 0, 0] });
		return merge(t, parts, `keeper:${kind}`);
	});
}

/** A fence round a bed w×d: driftwood posts of uneven height at the corners and between the cells, two rails on each
 *  side, a little gate in the front rail. */
export function fenceGeometry(t: T, w: number, d: number): Geo {
	return cached(`fence:${w}x${d}`, () => {
		const r = rand(`fence:${w}x${d}`), parts: Part[] = [], wood = 0x9a7a4a, grey = 0x8f8676;
		for (let i = 0; i <= w; i++) for (let j = 0; j <= d; j++) {
			if (i > 0 && i < w && j > 0 && j < d) continue;
			const hh = 0.34 + r() * 0.08;
			parts.push({ g: new t.BoxGeometry(0.07, hh, 0.07), c: r() < 0.5 ? wood : grey, p: [i - w / 2, hh / 2, j - d / 2], r: [0, r() * 0.6, (r() - 0.5) * 0.08] });
		}
		for (const y of [0.14, 0.27]) {
			parts.push({ g: new t.BoxGeometry(w, 0.04, 0.035), c: wood, p: [0, y, -d / 2] });
			parts.push({ g: new t.BoxGeometry(0.035, 0.04, d), c: wood, p: [-w / 2, y, 0] });
			parts.push({ g: new t.BoxGeometry(0.035, 0.04, d), c: wood, p: [w / 2, y, 0] });
			// the front: rails beside the gate, the gate's own boards a little darker
			parts.push({ g: new t.BoxGeometry(w / 2 - 0.25, 0.04, 0.035), c: wood, p: [-w / 4 - 0.125, y, d / 2] });
			parts.push({ g: new t.BoxGeometry(w / 2 - 0.25, 0.04, 0.035), c: wood, p: [w / 4 + 0.125, y, d / 2] });
			parts.push({ g: new t.BoxGeometry(0.46, 0.05, 0.03), c: WOOD_DARK, p: [0, y, d / 2 + 0.01] });
		}
		parts.push({ g: new t.BoxGeometry(0.04, 0.2, 0.03), c: WOOD_DARK, p: [0, 0.2, d / 2 + 0.01], r: [0, 0, 0.9] }); // the gate's brace
		return merge(t, parts, `fence:${w}x${d}`);
	});
}

/** A site w×d at `progress` (0..1): its corner posts and sill, the walls rising in planks, a scaffold that comes with
 *  them, a pile of driftwood and a coil of rope beside it. One geometry per tenth of progress. */
export function siteGeometry(t: T, plan: string | undefined, w: number, d: number, color: number, progress: number): Geo {
	const step = Math.round(Math.max(0, Math.min(1, progress)) * 10);
	return cached(`site:${plan}:${w}x${d}:${color}:${step}`, () => {
		const r = rand(`site:${step}`), parts: Part[] = [], ww = w * 0.8, dd = d * 0.78, done = step / 10, wh = 0.72 * done;
		parts.push({ g: new t.BoxGeometry(w * 0.9, 0.06, d * 0.9), c: 0x9a8160, p: [0, 0.03, 0] }); // trodden earth
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push({ g: new t.BoxGeometry(0.1, 0.85, 0.1), c: WOOD_DARK, p: [sx * ww / 2, 0.08 + 0.425, sz * dd / 2] });
		if (wh > 0.02) {
			const rows = Math.max(1, Math.round(done * 5));
			for (let i = 0; i < rows; i++) {
				const y = 0.08 + (i + 0.5) * (wh / rows);
				for (const side of [-1, 1]) {
					parts.push({ g: new t.BoxGeometry(ww, wh / rows - 0.015, 0.1), c: i % 2 ? color : WOOD, p: [0, y, side * dd / 2] });
					parts.push({ g: new t.BoxGeometry(0.1, wh / rows - 0.015, dd), c: i % 2 ? WOOD : color, p: [side * ww / 2, y, 0] });
				}
			}
		}
		// scaffold: a pole at each corner a little outside, rails at the height the walls have reached
		const sh = Math.max(0.5, wh + 0.3);
		for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) parts.push({ g: new t.CylinderGeometry(0.025, 0.025, sh, 5), c: 0xa58a5e, p: [sx * (ww / 2 + 0.16), sh / 2, sz * (dd / 2 + 0.16)] });
		for (const y of [sh * 0.45, sh - 0.04]) for (const side of [-1, 1]) {
			parts.push({ g: new t.BoxGeometry(ww + 0.32, 0.03, 0.03), c: 0xa58a5e, p: [0, y, side * (dd / 2 + 0.16)] });
			parts.push({ g: new t.BoxGeometry(0.03, 0.03, dd + 0.32), c: 0xa58a5e, p: [side * (ww / 2 + 0.16), y, 0] });
		}
		// what still waits to be built: the pile shrinks as the walls grow
		const logs = Math.max(1, Math.round((1 - done) * 6));
		for (let i = 0; i < logs; i++) parts.push({ g: new t.CylinderGeometry(0.045, 0.045, Math.min(0.5, ww * 0.6), 6), c: i % 2 ? WOOD : BARK, p: [(i % 3 - 1) * 0.1, 0.06 + Math.floor(i / 3) * 0.08, dd / 2 + 0.1], r: [0, 0, Math.PI / 2] });
		if (done < 1) parts.push({ g: new t.TorusGeometry(0.09, 0.035, 5, 10), c: 0x6f7a3c, p: [-ww / 2 + 0.12, 0.12, -dd / 2 - 0.08], r: [Math.PI / 2, 0, 0] });
		void r; void plan;
		return merge(t, parts, `site:${step}`);
	});
}

/** A ruin w×d: the plinth cracked, two wall stubs with jagged tops, roof beams fallen across, stones about. */
export function ruinGeometry(t: T, w: number, d: number, variant: number): Geo {
	return cached(`ruin:${w}x${d}:${variant}`, () => {
		const r = rand(`ruin:${variant}`), parts: Part[] = [], ww = w * 0.8, dd = d * 0.78;
		parts.push({ g: new t.BoxGeometry(w * 0.84, 0.08, d * 0.84), c: STONE, p: [0, 0.04, 0] });
		for (let i = 0; i < 4; i++) { const hh = 0.2 + r() * 0.45; parts.push({ g: new t.BoxGeometry(ww / 4 - 0.02, hh, 0.1), c: i % 2 ? WOOD_DARK : 0x6e5a40, p: [-ww / 2 + ww / 8 + (i * ww) / 4, 0.1 + hh / 2, -dd / 2] }); }
		for (let i = 0; i < 3; i++) { const hh = 0.12 + r() * 0.35; parts.push({ g: new t.BoxGeometry(0.1, hh, dd / 3 - 0.02), c: 0x6e5a40, p: [-ww / 2, 0.1 + hh / 2, -dd / 2 + dd / 6 + (i * dd) / 3] }); }
		parts.push({ g: new t.BoxGeometry(0.11, 0.6, 0.11), c: WOOD_DARK, p: [ww / 2, 0.4, dd / 2] });
		for (let i = 0; i < 3; i++) parts.push({ g: new t.BoxGeometry(w * 0.7, 0.07, 0.09), c: i ? 0x7a6a4a : WOOD_DARK, p: [(r() - 0.5) * 0.3, 0.14 + i * 0.06, (r() - 0.5) * dd * 0.6], r: [0, (r() - 0.5) * 1.2, (r() - 0.5) * 0.3] });
		for (let i = 0; i < 6; i++) parts.push({ g: new t.DodecahedronGeometry(0.06 + r() * 0.06, 0), c: STONE, p: [(r() - 0.5) * w * 1.05, 0.08, (r() - 0.5) * d * 1.05], r: [r() * 3, r() * 3, 0] });
		return merge(t, parts, `ruin:${variant}`);
	});
}

// ---- the fire, exits, a shadow ----

/** The fire's stone ring on a low plinth, logs leaning together in it (the flame and its light are the map's). */
export function fireGeometry(t: T): Geo {
	return cached("fire", () => {
		const parts: Part[] = [{ g: new t.CylinderGeometry(0.42, 0.46, 0.1, 10), c: STONE_DARK, p: [0, 0.05, 0] }];
		for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; parts.push({ g: new t.DodecahedronGeometry(0.1, 0), c: i % 3 ? STONE : STONE_DARK, p: [Math.cos(a) * 0.32, 0.15, Math.sin(a) * 0.32], r: [a, a * 2, 0] }); }
		for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; parts.push({ g: new t.CylinderGeometry(0.04, 0.05, 0.42, 6), c: i % 2 ? BARK : 0x3a2a1a, p: [Math.cos(a) * 0.09, 0.26, Math.sin(a) * 0.09], r: [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6] }); }
		return merge(t, parts, "fire");
	});
}

/** A signpost at an exit: a post and a board pointing on. */
export function signGeometry(t: T): Geo {
	return cached("sign", () => merge(t, [
		{ g: new t.BoxGeometry(0.08, 0.7, 0.08), c: WOOD_DARK, p: [0, 0.35, 0] },
		{ g: new t.BoxGeometry(0.42, 0.14, 0.04), c: WOOD, p: [0.1, 0.56, 0] },
		{ g: new t.ConeGeometry(0.1, 0.12, 3), c: WOOD, p: [0.36, 0.56, 0], r: [0, 0, -Math.PI / 2] },
		{ g: new t.DodecahedronGeometry(0.08, 0), c: STONE, p: [0.05, 0.03, 0.04] },
	], "sign"));
}

/** A flat disc on the ground, 1 across, dark at its middle and clear at its rim by the alpha of its vertices: `mid` at the
 *  centre, `ring` at 45 % of the radius. No texture: a canvas gradient as map or alpha map did not show in the 3D view
 *  (checked headless 2026-11-20: a plain colour showed, the gradient did not). */
function shadowDisc(t: T, mid: number, ring: number): Geo {
	const n = 24, pos: number[] = [0, 0, 0], col: number[] = [0, 0, 0, mid], idx: number[] = [];
	for (const [r, a] of [[0.225, ring], [0.5, 0]] as const) for (let k = 0; k < n; k++) { const q = (k / n) * Math.PI * 2; pos.push(Math.cos(q) * r, 0, Math.sin(q) * r); col.push(0, 0, 0, a); }
	for (let k = 0; k < n; k++) { const a = 1 + k, b = 1 + ((k + 1) % n), c = 1 + n + k, e = 1 + n + ((k + 1) % n); idx.push(0, b, a, a, b, e, a, e, c); }
	const g = new t.BufferGeometry();
	g.setAttribute("position", new t.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new t.Float32BufferAttribute(col, 4)); g.setIndex(idx);
	g.userData.shared = true;
	return g;
}
let shadowMaterial: import("three").MeshBasicMaterial | null = null, shadowGeo: Geo | null = null;
/** A soft round shadow on the ground, `w`×`d` across. */
export function propShadow(t: T, w: number, d: number): import("three").Mesh {
	if (!shadowMaterial) {
		shadowMaterial = new t.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: t.DoubleSide }); shadowMaterial.userData.shared = true;
		shadowGeo = shadowDisc(t, 0.42, 0.26);
	}
	const m = new t.Mesh(shadowGeo!, shadowMaterial); m.scale.set(w, 1, d); m.position.y = 0.012; m.renderOrder = 1;
	return m;
}
let contactMaterial: import("three").MeshBasicMaterial | null = null, contactGeo: Geo | null = null;
/** A darker shadow for a thing lying on the ground, shown as an upright picture, `w`×`d` across. Not fogged, as the picture
 *  above it is not. */
export function contactShadow(t: T, w: number, d: number): import("three").Mesh {
	if (!contactMaterial) {
		contactMaterial = new t.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, side: t.DoubleSide }); contactMaterial.userData.shared = true;
		contactGeo = shadowDisc(t, 0.55, 0.38);
	}
	const m = new t.Mesh(contactGeo!, contactMaterial); m.scale.set(w, 1, d); m.position.y = 0.02; m.renderOrder = 1;
	return m;
}
/** The soft shadows of many things as one instanced mesh (one draw call): each at `x, y, z`, `size` across. */
export function propShadows(t: T, spots: ReadonlyArray<{ x: number; y: number; z: number; size: number }>): import("three").InstancedMesh {
	const one = propShadow(t, 1, 1), mesh = new t.InstancedMesh(one.geometry, one.material, spots.length), matrix = new t.Matrix4();
	spots.forEach((s, i) => mesh.setMatrixAt(i, matrix.makeScale(s.size, 1, s.size).setPosition(s.x, s.y, s.z)));
	mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.renderOrder = 1;
	return mesh;
}

const plain = new Map<string, import("three").MeshStandardMaterial>();
/** A plain material that shows a merged geometry's own colours, without the models' grain and surfaces; shared. */
export function plainMaterial(t: T, roughness = 1, metalness = 0, emissive = 0): import("three").MeshStandardMaterial {
	const key = `${roughness}:${metalness}:${emissive}`;
	let m = plain.get(key);
	if (!m) { m = new t.MeshStandardMaterial({ vertexColors: true, roughness, metalness, emissive }); m.userData.shared = true; plain.set(key, m); }
	return m;
}
/** Parts built for one thing (a track, a bed, a field) as one mesh with a plain material: one draw call instead of one
 *  per part. The geometry is the thing's own and goes with it. */
export function solidMesh(t: T, parts: Part[], seed: string, roughness = 1, metalness = 0, emissive = 0): import("three").Mesh {
	const g = merge(t, parts.map((p) => ({ m: "none" as const, ...p })), seed); g.userData.shared = false;
	return new t.Mesh(g, plainMaterial(t, roughness, metalness, emissive));
}

/** A mesh of a shared geometry with the shared material. */
export function propMesh(t: T, g: Geo): import("three").Mesh {
	return new t.Mesh(g, propMaterial(t));
}
