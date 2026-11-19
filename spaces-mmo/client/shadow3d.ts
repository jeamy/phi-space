// The sun's shadow map in two parts (3D v3, docs/3D-V3/README.md, "On a phone"): what stands still (the ground, the
// houses, the trees, the things) is drawn into it a few times a second and kept in a copy; in a frame in which only the
// figures moved the copy is put back and just the figures are drawn on top of it. Before, every step of a figure drew
// the whole map anew, all the houses and trees with it: on a phone more than half of a frame's draw calls.
// The figures are on their own layer (MOVING_LAYER), which the view's camera sees too; three draws a caster into the
// shadow map when the view's camera's layers take it, so the map is drawn twice with the camera's layers set to one part
// each time, the second time without clearing it.
import type { DirectionalLight, WebGLRenderer, WebGLRenderTarget } from "three";

type T = typeof import("three");

/** The layer of what moves often: the figures. The view's camera sees it with layer 0. */
export const MOVING_LAYER = 2;
const STILL = 1 << 0, MOVING = 1 << MOVING_LAYER;

export function splitShadows(t: T, renderer: WebGLRenderer, sun: DirectionalLight) {
	const map = renderer.shadowMap as unknown as { render(lights: unknown, scene: unknown, camera: { layers: { mask: number } }): void; autoUpdate: boolean; needsUpdate: boolean };
	const draw = map.render.bind(renderer.shadowMap);
	let kept: WebGLRenderTarget | null = null, still = true;
	map.render = (lights, scene, camera) => {
		if (!map.autoUpdate && !map.needsUpdate) return;
		const mask = camera.layers.mask, clear = renderer.clear;
		try {
			const shadow = sun.shadow, size = shadow.map?.width ?? 0;
			if (still || !kept || !shadow.map || kept.width !== size) {
				camera.layers.mask = STILL; draw(lights, scene, camera); still = false;
				const drawn = shadow.map;
				if (!drawn?.depthTexture) return;
				if (!kept || kept.width !== drawn.width || kept.height !== drawn.height) {
					kept?.depthTexture?.dispose(); kept?.dispose();
					const depth = new t.DepthTexture(drawn.width, drawn.height, drawn.depthTexture.type); depth.format = drawn.depthTexture.format;
					kept = new t.WebGLRenderTarget(drawn.width, drawn.height, { depthTexture: depth });
					renderer.initRenderTarget(kept);
				}
				renderer.copyTextureToTexture(drawn.depthTexture, kept.depthTexture!);
			} else renderer.copyTextureToTexture(kept.depthTexture!, shadow.map.depthTexture!);
			// the figures on top, into the map as it stands
			map.needsUpdate = true; camera.layers.mask = MOVING; renderer.clear = () => {};
			draw(lights, scene, camera);
		} finally { camera.layers.mask = mask; renderer.clear = clear; }
	};
	return {
		/** The still part is drawn anew with the next shadow map (the sun moved, a thing came or went, a detail changed). */
		redrawStill(): void { still = true; },
		dispose(): void { kept?.depthTexture?.dispose(); kept?.dispose(); kept = null; map.render = draw; },
	};
}
