// The 3D ground as rounded terraces (terrace.ts gives the outlines): one mesh per land kind, its cells and every higher
// one, extruded up to the kind's height with an edge that rounds down where lower ground lies beyond. Corners are round in
// plan, edges round in height; the middle of every cell keeps its height (terrain3d.ts), so nothing on it moves.
// At the room's edge a terrace's corners stay square, so it stands flush on the block below (block3d.ts).
import { outlineLoops, rounded, terraces, withHoles, type Pt } from "./terrace.ts";

type T = typeof import("three");

/** How far a corner rounds in plan (cells). */
export const CORNER = 0.42;

export type TerraceLook = { top: import("three").Material; flank: import("three").Material; wall: import("three").Material };

/** The terraces of a room as meshes, lowest first; `look(key)` gives each kind's materials (top, the rounded edge, the
 *  wall below it). The meshes are centred like the cells: cell x,y lies at x - w/2 .. x - w/2 + 1. */
export function terraceMeshes(t: T, ground: readonly string[], kind: (key: string) => { height: number; water: boolean }, look: (key: string) => TerraceLook): import("three").Mesh[] {
	const h = ground.length, w = ground[0]?.length ?? 0;
	const out: import("three").Mesh[] = [];
	for (const terrace of terraces(ground, kind)) {
		// corners on the room's edge stay square: rounded, they would leave a notch over the block's corner
		const outside = (p: Pt) => p[0] <= 0 || p[1] <= 0 || p[0] >= w || p[1] >= h;
		const shapes = withHoles(outlineLoops(w, h, terrace.at)).map(({ outer, holes }) => {
			const shape = new t.Shape(rounded(outer, CORNER, 6, outside).map(([x, y]) => new t.Vector2(x, -y)));
			for (const hole of holes) shape.holes.push(new t.Path(rounded(hole, CORNER, 6, outside).map(([x, y]) => new t.Vector2(x, -y))));
			return shape;
		});
		if (!shapes.length) continue;
		const { thick, size } = terrace, edge = thick > 0.005;
		const geo = new t.ExtrudeGeometry(shapes, { depth: terrace.height - (edge ? thick : 0), steps: 1, curveSegments: 1, bevelEnabled: edge, bevelThickness: thick, bevelSize: size, bevelOffset: -size, bevelSegments: 5 });
		const mesh = new t.Mesh(profile(t, geo, terrace.bottom, w, h), [look(terrace.key).top, look(terrace.key).flank, look(terrace.key).wall]);
		mesh.userData.pick = true; mesh.userData.terrace = terrace.key;
		out.push(mesh);
	}
	return out;
}

/** An extruded terrace as the ground needs it: without the bevelled underside (it would show as a groove at the foot), its
 *  wall reaching down to `bottom`, lying with y up, and its faces in three groups: the top (0), the rounded edge (1, uvs
 *  from above, so the tile art runs on over it) and the upright wall (2). */
function profile(t: T, geo: import("three").ExtrudeGeometry, bottom: number, w: number, h: number): import("three").BufferGeometry {
	const pos = geo.getAttribute("position") as import("three").BufferAttribute, uv = geo.getAttribute("uv") as import("three").BufferAttribute;
	const caps = new Set<number>();
	for (const g of geo.groups) if (g.materialIndex === 0) for (let i = g.start; i < g.start + g.count; i++) caps.add(i);
	const parts: number[][] = [[], [], []];
	const a = new t.Vector3(), b = new t.Vector3(), c = new t.Vector3();
	for (let i = 0; i < pos.count; i += 3) {
		// the shape lies in x,y with z its height: the underside and its bevel are below 0
		if (pos.getZ(i) < -1e-6 || pos.getZ(i + 1) < -1e-6 || pos.getZ(i + 2) < -1e-6) continue;
		// a terrace without a rounded edge has its underside at 0: that one goes too
		if (caps.has(i)) { if (Math.max(pos.getZ(i), pos.getZ(i + 1), pos.getZ(i + 2)) > 1e-6) parts[0]!.push(i); continue; }
		a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
		const n = b.sub(a).cross(c.sub(a)).normalize();
		parts[Math.abs(n.z) > 0.05 ? 1 : 2]!.push(i);
	}
	const P: number[] = [], U: number[] = [], out = new t.BufferGeometry();
	let start = 0;
	parts.forEach((list, group) => {
		for (const i of list) for (let k = i; k < i + 3; k++) {
			const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
			// lying: x stays, the height becomes y, the shape's y (minus the row) becomes z; centred on the room
			P.push(x - w / 2, Math.abs(z) < 1e-6 ? bottom : z, -y - h / 2);
			if (group === 2) U.push(uv.getX(k), uv.getY(k)); else U.push(x, y);
		}
		out.addGroup(start * 3, list.length * 3, group);
		start += list.length;
	});
	out.setAttribute("position", new t.Float32BufferAttribute(P, 3));
	out.setAttribute("uv", new t.Float32BufferAttribute(U, 2));
	out.computeVertexNormals();
	geo.dispose();
	return out;
}
