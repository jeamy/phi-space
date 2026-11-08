// Pure, versioned conversion from the authoritative 2D grid to visual 2.5D heights and colours. Nothing here affects
// walkability, collision or any other server rule (docs/architektur.en.md, "3D-Ansicht").
export const TERRAIN_RENDERER_VERSION = 3;

export type Tile3d = { color: number; height: number; water: boolean };

/** Version 2 (docs/3D-V2): the kinds stand on terraces, so the beach steps up to the paving and the grass. One height per
 *  kind, never per cell: neighbours of a kind meet flush, and only a change of kind makes a step with a side face. */
const KNOWN: Record<string, Tile3d> = {
	"~": { color: 0x5b8fd6, height: 0.06, water: true },
	".": { color: 0xdcc286, height: 0.2, water: false },
	":": { color: 0x9a9ea6, height: 0.36, water: false },
	",": { color: 0x8fc25a, height: 0.5, water: false },
};

/** FNV-1a, kept here instead of relying on a runtime or library-specific string hash. */
export function stableHash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return h >>> 0;
}

/** Visual profile for a tile. Unknown world tiles get a stable muted colour and a modest height. */
export function tile3d(key: string, walk: boolean): Tile3d {
	const known = KNOWN[key];
	if (known) return known;
	const h = stableHash(key);
	const r = 72 + (h & 31), g = 82 + ((h >>> 5) & 31), b = 76 + ((h >>> 10) & 31);
	return { color: (r << 16) | (g << 8) | b, height: walk ? 0.3 : 0.12, water: !walk };
}

/** A tiny deterministic surface variation. It is deliberately visual-only and bounded to 0.03 world units. */
export function terrainHeight(roomId: string, ground: string[], tiles: Record<string, { walk: boolean }>, x: number, y: number): number {
	const key = ground[y]?.[x] ?? "";
	const profile = tile3d(key, !!tiles[key]?.walk);
	if (profile.water) return profile.height;
	const h = stableHash(`${TERRAIN_RENDERER_VERSION}:${roomId}:${x}:${y}`);
	return profile.height + ((h / 0xffffffff) * 2 - 1) * 0.03;
}
