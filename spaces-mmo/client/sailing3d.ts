// The sail to another island in the 3D view (engine/commands/fishing.ts `segle`), like the row (rowing3d.ts), in one of two
// modes the player chooses as it sets off (App.tsx): at work it only casts off and sails out of the old place (SAIL_OUT_MS),
// then comes in to the new one and lies alongside (SAIL_IN_MS). At leisure the camera also goes out to sea after the
// casting off and looks back at the island the boat leaves (SAIL_LOOK_MS; the page holds the old place meanwhile), and at
// the new place it first looks from the sea at the island the boat comes to (SAIL_LOOK_MS), before it lies alongside. The
// paths and the camera's share are pure, so they are tested without a browser.
import { merge, plainMaterial, type T } from "./props3d.ts";

/** How long the boat casts off and sails out, how long each look at the island lasts (at leisure), and how long it takes
 *  to come in and lie alongside. */
export const SAIL_OUT_MS = 5_000, SAIL_LOOK_MS = 5_000, SAIL_IN_MS = 5_000;
/** How far out the boat lies from a shore it lands on without a jetty (cells). */
export const SAIL_REACH = 5;
/** The two ways of sailing: at leisure with a look back at the island and one at the island it comes to, at work only
 *  casting off and coming in. */
export type SailMode = "freizeit" | "arbeit";

/** The old place's part (`out`) or the new place's (`in`) of a sail: how long it lasts and how far from the mooring (cells)
 *  the boat is at its far end. At leisure each part has its look at the island too, and the boat goes twice as far. */
export function sailPlan(mode: SailMode, kind: "out" | "in"): { ms: number; far: number } {
	const leisure = mode === "freizeit";
	return { ms: (kind === "out" ? SAIL_OUT_MS : SAIL_IN_MS) + (leisure ? SAIL_LOOK_MS : 0), far: leisure ? 16 : 8 };
}

/** How much the camera looks from the sea at the island at `p` (0..1 of the part's time), 0 the player's own view: at
 *  leisure it goes out once the boat has cast off and stays to the end of the old place; at the new place it looks first
 *  and comes back to the player's view for the coming in. At work never. */
export function lookShare(mode: SailMode, kind: "out" | "in", p: number): number {
	if (mode !== "freizeit") return 0;
	const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
	return kind === "out" ? smooth((p - 0.42) / 0.16) : 1 - smooth((p - 0.44) / 0.16);
}

type P = { x: number; y: number };
/** Where a boat lands on a shore without a jetty (the bay a sail ends in): the first water from the figure's cell
 *  (`at`, in cells) in the direction with the nearest open water, a cell's middle, and the way out from there. Null where
 *  no water is near. */
export function shorePath(ground: readonly string[], water: (key: string) => boolean, at: P): { moor: P; out: P } | null {
	// beyond the map's edge counts as open water, but the boat lands inside the map
	const wet = (x: number, y: number) => { const row = ground[y]; return row === undefined || x < 0 || x >= row.length || water(row[x]!); };
	const inside = (x: number, y: number) => y >= 0 && y < ground.length && x >= 0 && x < (ground[y]?.length ?? 0);
	const x0 = Math.floor(at.x), y0 = Math.floor(at.y);
	let best: { k: number; dx: number; dy: number } | null = null;
	for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
		for (let k = 1; k <= 8; k++) {
			if (!inside(x0 + dx * k, y0 + dy * k)) break;
			if (!wet(x0 + dx * k, y0 + dy * k)) continue;
			// open water: most of the way out beyond it is water too
			let open = 0;
			for (let j = 1; j <= 4; j++) if (wet(x0 + dx * (k + j), y0 + dy * (k + j))) open++;
			if (open >= 3 && (!best || k < best.k)) best = { k, dx, dy };
			break;
		}
	}
	if (!best) return null;
	const moor = { x: x0 + best.dx * best.k + 0.5, y: y0 + best.dy * best.k + 0.5 };
	return { moor, out: { x: moor.x + best.dx * SAIL_REACH, y: moor.y + best.dy * SAIL_REACH } };
}

/** Where along its way the boat is at `p` (0..1 of its time) as a share of the way: going out it gathers way and keeps it,
 *  coming in it loses it and stops alongside. */
export function sailShare(kind: "out" | "in", p: number): number {
	const q = Math.min(1, Math.max(0, p));
	return kind === "out" ? q * q : 1 - (1 - q) * (1 - q);
}

/** How the boat sails at `p` of its time: how full the sails are (0 lowered, 1 set), how far it heels, how much it
 *  pitches in the swell and how much wake it throws. Going out it sets sail at the jetty, heels as it gathers way and is at
 *  sea in the second half; coming in it sails full, then lowers the sails in its last third. */
export function sailState(kind: "out" | "in", p: number): { set: number; heel: number; swell: number; wake: number } {
	const q = Math.min(1, Math.max(0, p));
	if (kind === "out") {
		const set = Math.min(1, q / 0.12), sea = Math.max(0, (q - 0.5) / 0.5);
		return { set, heel: 0.08 + 0.14 * Math.min(1, q / 0.5) + 0.04 * sea, swell: 0.4 + 0.6 * sea, wake: Math.min(1, q / 0.3) };
	}
	const down = q >= 1 ? 1 : Math.max(0, (q - 0.66) / 0.34);
	return { set: 1 - down, heel: 0.18 * (1 - down), swell: 0.7 * (1 - q) + 0.2, wake: 1 - q };
}

/** A curved sail between its tack (at the mast's foot or the bow), head and clew, in the boat's x/y plane, bellied out to
 *  +z by `belly` (its middle most, its edges not at all). */
function sailGeometry(t: T, tack: [number, number], head: [number, number], clew: [number, number], belly: number): import("three").BufferGeometry {
	const n = 6, pos: number[] = [], idx: number[] = [];
	for (let i = 0; i <= n; i++) {
		const s = i / n; // up the luff
		const lx = tack[0] + (head[0] - tack[0]) * s, ly = tack[1] + (head[1] - tack[1]) * s;
		const ex = clew[0] + (head[0] - clew[0]) * s, ey = clew[1] + (head[1] - clew[1]) * s;
		for (let j = 0; j <= n; j++) {
			const r = j / n; // across, from the luff to the leech
			pos.push(lx + (ex - lx) * r, ly + (ey - ly) * r, belly * Math.sin(Math.PI * r) * (1 - s * 0.7) * (s < 1 ? 1 : 0));
		}
	}
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
		const a = i * (n + 1) + j, b = a + 1, c = a + n + 1, d = c + 1;
		idx.push(a, c, b, b, c, d);
	}
	const g = new t.BufferGeometry();
	g.setAttribute("position", new t.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

export type Sailboat = {
	group: import("three").Group;
	/** turned round the mast by the wind (the mainsail on it) */ boom: import("three").Group;
	main: import("three").Mesh; jib: import("three").Mesh; flag: import("three").Mesh;
	/** foam at the bow and behind the stern */ wake: import("three").Mesh[];
	/** the arm on the tiller, turned with it */ tiller: import("three").Group;
};

/** A sailing boat with a cabin top, its bow to +x: a hull with a keel, a mast with a boom, a mainsail and a jib, a pennant
 *  at the masthead, a rudder with its tiller, and foam it throws (`wake`). About twice the rowing boat. */
export function sailboat(t: T): Sailboat {
	const group = new t.Group();
	const hullC = 0xf0ece2, stripe = 0x2f5f8a, wood = 0x9a7048, dark = 0x5a3e26, deck = 0xb8916a, keelC = 0x3a3a40;
	const hull = merge(t, [
		// the bottom, the sides, the transom and the bow meeting in a point
		{ g: new t.BoxGeometry(2.0, 0.16, 0.86), c: hullC, p: [-0.2, 0.08, 0], m: "none" },
		{ g: new t.BoxGeometry(2.0, 0.34, 0.07), c: hullC, p: [-0.2, 0.25, 0.43], m: "none" },
		{ g: new t.BoxGeometry(2.0, 0.34, 0.07), c: hullC, p: [-0.2, 0.25, -0.43], m: "none" },
		{ g: new t.BoxGeometry(0.07, 0.34, 0.86), c: hullC, p: [-1.2, 0.25, 0], m: "none" },
		{ g: new t.BoxGeometry(0.7, 0.34, 0.07), c: hullC, p: [1.06, 0.25, 0.22], r: [0, 0.56, 0], m: "none" },
		{ g: new t.BoxGeometry(0.7, 0.34, 0.07), c: hullC, p: [1.06, 0.25, -0.22], r: [0, -0.56, 0], m: "none" },
		{ g: new t.BoxGeometry(0.6, 0.14, 0.7), c: hullC, p: [1.0, 0.09, 0], r: [0, Math.PI / 4, 0], s: [1, 1, 0.6], m: "none" },
		// a blue stripe along the gunwale, the deck forward with a small cabin top, the cockpit floor aft
		{ g: new t.BoxGeometry(2.04, 0.06, 0.9), c: stripe, p: [-0.2, 0.43, 0], s: [1, 1, 1], m: "none" },
		{ g: new t.BoxGeometry(0.72, 0.05, 0.74), c: deck, p: [0.58, 0.44, 0], m: "none" },
		{ g: new t.BoxGeometry(0.62, 0.18, 0.56), c: hullC, p: [0.02, 0.52, 0], m: "none" },
		{ g: new t.BoxGeometry(0.5, 0.03, 0.46), c: stripe, p: [0.02, 0.62, 0], m: "none" },
		{ g: new t.BoxGeometry(0.98, 0.03, 0.76), c: deck, p: [-0.74, 0.2, 0], m: "none" },
		// the keel and the rudder blade under the stern
		{ g: new t.BoxGeometry(0.9, 0.32, 0.06), c: keelC, p: [0.0, -0.14, 0], m: "none" },
		{ g: new t.BoxGeometry(0.2, 0.42, 0.04), c: keelC, p: [-1.26, 0.0, 0], m: "none" },
		// the mast and the forestay's fitting at the bow
		{ g: new t.CylinderGeometry(0.035, 0.045, 2.5, 6), c: wood, p: [0.3, 1.66, 0], m: "none" },
		{ g: new t.BoxGeometry(0.1, 0.06, 0.1), c: dark, p: [1.3, 0.46, 0], m: "none" },
	], "sailboat");
	group.add(new t.Mesh(hull, plainMaterial(t)));
	// the stays: thin lines from the masthead to the bow and the stern
	const stay = (from: [number, number], to: [number, number]) => {
		const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy);
		const m = new t.Mesh(new t.BoxGeometry(len, 0.012, 0.012), new t.MeshStandardMaterial({ color: 0x444444, roughness: 0.6 }));
		m.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0); m.rotation.z = Math.atan2(dy, dx);
		group.add(m);
	};
	stay([0.3, 2.88], [1.3, 0.48]); stay([0.3, 2.88], [-1.2, 0.46]);
	const cloth = new t.MeshStandardMaterial({ color: 0xf6f0e0, roughness: 0.85, side: t.DoubleSide });
	// the boom swings on the mast; the mainsail hangs from the mast and lies along it
	const boom = new t.Group(); boom.position.set(0.3, 0.74, 0);
	const spar = new t.Mesh(new t.BoxGeometry(1.4, 0.05, 0.05), new t.MeshStandardMaterial({ color: wood, roughness: 0.9 })); spar.position.x = -0.68;
	const main = new t.Mesh(sailGeometry(t, [0, 0.04], [0, 2.08], [-1.34, 0.06], 0.22), cloth);
	boom.add(spar, main); group.add(boom);
	const jib = new t.Mesh(sailGeometry(t, [1.24, -0.24], [0.33, 1.9], [0.22, -0.2], 0.16), cloth);
	jib.position.set(0, 0.74, 0); group.add(jib);
	// a red pennant at the masthead
	const flagGeo = new t.BufferGeometry();
	flagGeo.setAttribute("position", new t.Float32BufferAttribute([0, 0.08, 0, 0, -0.08, 0, -0.42, 0, 0], 3));
	flagGeo.computeVertexNormals();
	const flag = new t.Mesh(flagGeo, new t.MeshStandardMaterial({ color: 0xc8342c, roughness: 0.8, side: t.DoubleSide }));
	flag.position.set(0.3, 2.9, 0); group.add(flag);
	// the tiller on the rudder's head, which the sailor holds
	const tiller = new t.Group(); tiller.position.set(-1.22, 0.46, 0);
	const arm = new t.Mesh(new t.BoxGeometry(0.62, 0.04, 0.04), new t.MeshStandardMaterial({ color: dark, roughness: 0.9 })); arm.position.x = 0.3;
	tiller.add(arm); group.add(tiller);
	// foam: a fan at the bow, a trail behind the stern
	const foam = new t.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
	const bow = new t.Mesh(new t.PlaneGeometry(0.9, 1.3), foam); bow.rotation.x = -Math.PI / 2; bow.position.set(1.0, 0.03, 0);
	const trail = new t.Mesh(new t.PlaneGeometry(2.4, 0.7), foam.clone()); trail.rotation.x = -Math.PI / 2; trail.position.set(-2.4, 0.02, 0);
	for (const w of [bow, trail]) { w.userData.unshaded = true; w.renderOrder = 2; group.add(w); }
	return { group, boom, main, jib, flag, wake: [bow, trail], tiller };
}

type Sailor = { group: import("three").Object3D; body: import("three").Object3D; mesh: import("three").Object3D; legL: import("three").Object3D; legR: import("three").Object3D; armL: import("three").Object3D; armR: import("three").Object3D; head?: import("three").Object3D };
/** Seats a figure (figure3d.ts) aft in the cockpit facing forward, one hand on the tiller; its shadow and ring stay ashore. */
export function seatSailor(f: Sailor): void {
	for (const c of f.group.children) if (c !== f.body && c !== f.mesh) c.visible = false;
	f.group.position.set(-0.78, -0.02, 0.2); f.group.rotation.y = Math.PI / 2;
	f.legL.rotation.x = f.legR.rotation.x = -Math.PI / 2;
	f.armL.rotation.x = -0.9; f.armR.rotation.x = -0.35;
}

/** One frame of the sail at time `s` (seconds) in the state `st` (sailState): the sails filled and lowered, the boom out to
 *  leeward, the pennant streaming, the boat heeling and pitching in the swell, the foam, the tiller and the sailor's arm and
 *  head with it. `hull` is what heels (the boat with the sailor in it). */
export function sailTick(b: Sailboat, hull: import("three").Object3D, s: number, st: ReturnType<typeof sailState>, sailor?: Sailor): void {
	const gust = 1 + Math.sin(s * 1.3) * 0.08 + Math.sin(s * 3.1) * 0.04;
	const set = Math.max(0.04, st.set);
	b.main.scale.set(1, set, (0.25 + 0.75 * st.set) * gust); b.jib.scale.set(1, set, (0.25 + 0.75 * st.set) * gust);
	b.boom.rotation.y = 0.35 * st.set + Math.sin(s * 0.9) * 0.04 * st.set;
	b.flag.rotation.y = 0.35 + Math.sin(s * 9) * 0.25; b.flag.scale.y = 1 + Math.sin(s * 13) * 0.2;
	hull.rotation.x = -st.heel * gust; // leeward is -z, away from the boom's side
	hull.rotation.z = Math.sin(s * 1.7) * 0.05 * st.swell;
	hull.position.y = Math.sin(s * 1.7 + 0.6) * 0.06 * st.swell;
	(b.wake[0]!.material as import("three").MeshBasicMaterial).opacity = 0.35 * st.wake * (0.8 + 0.2 * Math.sin(s * 6));
	(b.wake[1]!.material as import("three").MeshBasicMaterial).opacity = 0.25 * st.wake;
	b.wake[1]!.scale.x = 0.6 + 0.4 * st.wake;
	const steer = Math.sin(s * 0.8) * 0.12;
	b.tiller.rotation.y = steer;
	if (sailor) { sailor.armR.rotation.x = -0.35 + steer * 0.6; if (sailor.head) sailor.head.rotation.y = Math.sin(s * 0.5) * 0.3; }
}
