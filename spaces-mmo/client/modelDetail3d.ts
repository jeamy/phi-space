import type { BufferGeometry, Camera, Object3D } from "three";

type T = typeof import("three");
export type ModelLevel = "far" | "room" | "near";
let level: ModelLevel = "room";
export const modelLevel = () => level;
export function atModelLevel<R>(next: ModelLevel, build: () => R): R {
	const previous = level; level = next;
	try { return build(); } finally { level = previous; }
}

export function modelPrimitive(t: T, source: BufferGeometry): BufferGeometry {
	const p = (source as BufferGeometry & { parameters?: Record<string, number> }).parameters;
	if (!p) return source;
	const segments = level === "far" ? 5 : level === "room" ? 10 : 16;
	let out: BufferGeometry = source;
	if (source.type === "BoxGeometry" && level !== "far") {
		const { width: w, height: h, depth: d } = p, bevel = Math.min(w!, h!, d!) * (level === "near" ? 0.12 : 0.06);
		const shape = new t.Shape();
		shape.moveTo(-w! / 2 + bevel, -h! / 2 + bevel); shape.lineTo(w! / 2 - bevel, -h! / 2 + bevel); shape.lineTo(w! / 2 - bevel, h! / 2 - bevel); shape.lineTo(-w! / 2 + bevel, h! / 2 - bevel); shape.closePath();
		out = new t.ExtrudeGeometry(shape, { depth: d! - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: level === "near" ? 2 : 1, steps: 1, curveSegments: 1 });
		out.translate(0, 0, -d! / 2 + bevel);
	} else if (source.type === "CylinderGeometry") out = new t.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, segments, 1, !!p.openEnded, p.thetaStart, p.thetaLength);
	else if (source.type === "ConeGeometry") out = new t.ConeGeometry(p.radius, p.height, segments, 1, !!p.openEnded, p.thetaStart, p.thetaLength);
	else if (source.type === "SphereGeometry") out = new t.SphereGeometry(p.radius, segments, Math.max(3, segments / 2), p.phiStart, p.phiLength, p.thetaStart, p.thetaLength);
	else if (source.type === "CapsuleGeometry") out = new t.CapsuleGeometry(p.radius, p.height, level === "near" ? 4 : 2, segments);
	else if (source.type === "IcosahedronGeometry") out = level === "far" ? new t.IcosahedronGeometry(p.radius, 0) : lumpy(new t.IcosahedronGeometry(p.radius, p.radius! > LUMP_FROM ? (level === "near" ? 3 : 2) : 1), p.radius!);
	else if (source.type === "DodecahedronGeometry" && level === "far") out = new t.IcosahedronGeometry(p.radius, 0);
	else if (source.type === "TorusGeometry") out = new t.TorusGeometry(p.radius, p.tube, level === "near" ? 6 : 3, segments * 2, p.arc);
	if (out !== source) source.dispose();
	return out;
}

/** A ball this large is a crown, a bush or a boulder and gets lumps; a smaller one (a berry, a nut) stays round. */
const LUMP_FROM = 0.19;
/** Pushes a large ball's points in and out by their direction, so a crown is a lumpy mass and not a sphere. */
function lumpy(g: BufferGeometry, radius: number): BufferGeometry {
	if (radius <= LUMP_FROM) return g;
	const a = g.getAttribute("position");
	for (let i = 0; i < a.count; i++) {
		const x = a.getX(i) / radius, y = a.getY(i) / radius, z = a.getZ(i) / radius;
		const k = 1 + 0.12 * Math.sin(3.3 * x + 1.7) * Math.sin(2.9 * y + 0.4) * Math.sin(3.7 * z + 2.2) + 0.05 * Math.sin(5.1 * x + 4.3 * z + 0.9) * Math.sin(4.7 * y + 1.1);
		a.setXYZ(i, a.getX(i) * k, a.getY(i) * k, a.getZ(i) * k);
	}
	return g;
}

export function detailLevelAt(zoom: number, distance: number, current: ModelLevel): ModelLevel {
	if (zoom <= (current === "far" ? 0.65 : 0.55)) return "far";
	return zoom >= 2 && distance <= (current === "near" ? 18 : 16) ? "near" : "room";
}

export function updateModelDetails(t: T, root: Object3D, camera: Camera, zoom: number, nearLimit = 48): void {
	const position = new t.Vector3(), candidates: Array<{ mesh: import("three").Mesh; distance: number; next: ModelLevel }> = [];
	root.updateMatrixWorld(); camera.getWorldPosition(position);
	root.traverse((object) => {
		const mesh = object as import("three").Mesh, variants = mesh.geometry?.userData.modelVariant as ((level: ModelLevel) => BufferGeometry) | undefined;
		if (!variants || (!mesh.visible && !mesh.userData.detailOnly)) return;
		for (let parent = mesh.parent; parent; parent = parent.parent) if (!parent.visible || parent.userData.modelCatalogue) return;
		const sphere = (mesh as import("three").InstancedMesh).isInstancedMesh ? (mesh as import("three").InstancedMesh).boundingSphere : mesh.geometry.boundingSphere;
		const centre = sphere ? sphere.center.clone().applyMatrix4(mesh.matrixWorld) : mesh.getWorldPosition(new t.Vector3());
		const distance = centre.distanceTo(position), current = (mesh.userData.modelLevel ?? "room") as ModelLevel;
		candidates.push({ mesh, distance, next: detailLevelAt(zoom, distance, current) });
	});
	candidates.sort((a, b) => a.distance - (a.mesh.userData.modelLevel === "near" ? 0.35 : 0) - b.distance + (b.mesh.userData.modelLevel === "near" ? 0.35 : 0));
	let near = 0, triangles = 0;
	for (const c of candidates) {
		if (c.next === "near") {
			const base = c.mesh.geometry.userData.modelVariant("room") as BufferGeometry;
			const instances = (c.mesh as import("three").InstancedMesh).isInstancedMesh ? (c.mesh as import("three").InstancedMesh).count : 1;
			const estimate = base.getAttribute("position").count / 3 * 4 * instances;
			if (near >= nearLimit || triangles + estimate > 120_000) c.next = "room";
			else {
				const geometry = c.mesh.geometry.userData.modelVariant("near") as BufferGeometry, cost = geometry.getAttribute("position").count / 3 * instances;
				if (triangles + cost > 120_000) c.next = "room";
				else { near++; triangles += cost; }
			}
		}
		if (c.mesh.userData.detailOnly) c.mesh.visible = c.next === "near";
		if (c.mesh.userData.modelLevel === c.next) continue;
		c.mesh.geometry = c.mesh.geometry.userData.modelVariant(c.next);
		c.mesh.userData.modelLevel = c.next;
		if ((c.mesh as import("three").InstancedMesh).isInstancedMesh) (c.mesh as import("three").InstancedMesh).computeBoundingSphere();
	}
}
