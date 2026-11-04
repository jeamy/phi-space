import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export function createClosePost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
	let composer: EffectComposer | null = null, bokeh: BokehPass | null = null;
	let width = 1, height = 1;
	const direction = camera.position.clone();
	return {
		resize(w: number, h: number) {
			width = w; height = h; composer?.setSize(w, h);
		},
		render(amount: number) {
			if (!amount) { renderer.render(scene, camera); return; }
			if (!composer) {
				composer = new EffectComposer(renderer); composer.setPixelRatio(Math.min(1, renderer.getPixelRatio()));
				composer.addPass(new RenderPass(scene, camera));
				bokeh = new BokehPass(scene, camera, { focus: 10, aperture: 0.0015, maxblur: 0.006 });
				composer.addPass(bokeh); composer.addPass(new OutputPass());
				composer.setSize(width, height);
			}
			const uniforms = bokeh!.uniforms as Record<"focus" | "aperture" | "maxblur", { value: number }>;
			camera.getWorldDirection(direction);
			uniforms.focus.value = Math.max(camera.near, (camera.position.y - 0.9) / Math.max(0.01, -direction.y));
			uniforms.aperture.value = 0.0015 * amount; uniforms.maxblur.value = 0.006 * amount;
			const mask = camera.layers.mask, background = scene.background, autoClear = renderer.autoClear, shadowAutoUpdate = renderer.shadowMap.autoUpdate;
			try {
				renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
				camera.layers.set(0); composer.render();
				camera.layers.set(1); scene.background = null; renderer.autoClear = false; renderer.clearDepth(); renderer.render(scene, camera);
			} finally { camera.layers.mask = mask; scene.background = background; renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadowAutoUpdate; }
		},
		dispose() {
			for (const pass of composer?.passes ?? []) pass.dispose();
			composer?.dispose(); composer = null; bokeh = null;
		},
	};
}
