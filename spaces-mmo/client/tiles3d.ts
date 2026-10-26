// Textures for the 3D map: the world's own tile art (the same sheets the 2D map draws), cut into one small canvas
// texture per tile kind (and per animation frame for water). Cutting them apart keeps mipmaps clean at the edges, and the
// textures are cached per world, so entering another room neither redraws nor flashes.
import type { MapRendererProps } from "./MapRenderer.tsx";

type T = typeof import("three");
type World = MapRendererProps["world"];
export type TileLook = { frames: import("three").Texture[]; frameMs: number };

/** The four quarters of an autotile's open water: [quarter column, quarter row, x, y in the 32×32 tile] (MapView.tsx QUARTER.center). */
const WATER_CENTER: Array<[number, number, number, number]> = [[2, 4, 0, 0], [1, 4, 16, 0], [2, 3, 0, 16], [1, 3, 16, 16]];

const sheets = new Map<string, Promise<HTMLImageElement>>();
function sheet(url: string): Promise<HTMLImageElement> {
	let p = sheets.get(url);
	if (!p) {
		p = new Promise((ok, fail) => { const img = new Image(); img.onload = () => ok(img); img.onerror = () => fail(new Error(`${url} lädt nicht`)); img.src = url; });
		p.catch(() => sheets.delete(url)); // a failed sheet may be asked for again
		sheets.set(url, p);
	}
	return p;
}

const looks = new Map<string, Promise<Map<string, TileLook>>>();

/** One look per tile key; a tile whose sheet does not load is left out (the caller draws it in its flat colour). */
export function loadTileLooks(t: T, world: World, anisotropy: number): Promise<Map<string, TileLook>> {
	let p = looks.get(world.id);
	if (!p) {
		p = build(t, world, anisotropy);
		looks.set(world.id, p);
	}
	return p;
}

async function build(t: T, world: World, anisotropy: number): Promise<Map<string, TileLook>> {
	const ts = world.tileSize, out = new Map<string, TileLook>();
	const texture = (canvas: HTMLCanvasElement) => {
		const tex = new t.CanvasTexture(canvas);
		tex.colorSpace = t.SRGBColorSpace;
		tex.magFilter = t.NearestFilter; // crisp pixel art up close,
		tex.minFilter = t.LinearMipmapLinearFilter; // smooth when far away: nothing shimmers when the view moves
		tex.anisotropy = anisotropy;
		tex.userData.shared = true;
		return tex;
	};
	await Promise.all(Object.entries(world.tiles).map(async ([key, def]) => {
		try {
			const img = await sheet(`/assets/${world.id}/${def.sheet}`);
			const cut = (draw: (g: CanvasRenderingContext2D) => void) => {
				const c = document.createElement("canvas"); c.width = c.height = ts;
				const g = c.getContext("2d")!; g.imageSmoothingEnabled = false; draw(g);
				return texture(c);
			};
			if (def.auto) {
				const frames = def.auto.blocks.map((b) => cut((g) => { for (const [qx, qy, dx, dy] of WATER_CENTER) g.drawImage(img, b.x + qx * 16, b.y + qy * 16, 16, 16, dx, dy, 16, 16); }));
				out.set(key, { frames, frameMs: def.auto.frameMs });
			} else out.set(key, { frames: [cut((g) => g.drawImage(img, def.x, def.y, ts, ts, 0, 0, ts, ts))], frameMs: 0 });
		} catch { /* flat colour instead */ }
	}));
	return out;
}
