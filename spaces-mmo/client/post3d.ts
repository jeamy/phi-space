// The picture of the 3D view after the scene is drawn (3D v3, docs/3D-V3/README.md), at every zoom: the scene goes into a
// half-float target with multisampling, then ambient occlusion (corners and the foot of every wall and trunk darken), a
// bloom on what is far brighter than a white wall in the sun (fire, lamplit windows, the sun's glint on water), close up the depth-aware blur of the
// background (v2), and last the filmic tone curve and the display's colour space. Names and speech bubbles (layer 1) are
// drawn afterwards, straight to the screen, so they stay sharp and keep their colours.
import type { Line, Mesh, Object3D, PerspectiveCamera, Points, Scene, Sprite, WebGLRenderer } from "three";
import { HalfFloatType, NoToneMapping, Vector2, WebGLRenderTarget } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/** The numbers of the picture, in one place. `aoRadius` is in world units (a cell is 1). The bloom starts at a brightness
 *  that follows the daylight, as an eye does: by day only what outshines sand in the sun, at night every lamp. */
export const POST = { samples: 4, aoScale: 0.5, aoRadius: 0.45, aoIntensity: 1, bloomStrength: 0.22, bloomRadius: 0.5, bloomDay: 3.4, bloomNight: 1.2 };

export function createPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
	const ratio = renderer.getPixelRatio();
	const composer = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: POST.samples }));
	composer.setPixelRatio(ratio);
	composer.addPass(new RenderPass(scene, camera));
	const ao = new GTAOPass(scene, camera, 1, 1);
	ao.updateGtaoMaterial({ radius: POST.aoRadius, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, screenSpaceRadius: false });
	ao.blendIntensity = POST.aoIntensity; composer.addPass(ao);
	// the occlusion is soft by nature: at POST.aoScale of the picture's size it costs a quarter (its own pass over the scene,
	// its samples and its smoothing) and looks the same but for the thinnest gaps
	const aoSize = ao.setSize.bind(ao);
	ao.setSize = (w: number, h: number) => aoSize(Math.max(1, Math.round(w * POST.aoScale)), Math.max(1, Math.round(h * POST.aoScale)));
	const bloom = new UnrealBloomPass(new Vector2(1, 1), POST.bloomStrength, POST.bloomRadius, POST.bloomDay); composer.addPass(bloom);
	const bokeh = new BokehPass(scene, camera, { focus: 10, aperture: 0.0015, maxblur: 0.006 }); bokeh.enabled = false; composer.addPass(bokeh);
	composer.addPass(new OutputPass());
	// The occlusion and the blur draw the scene once more with one material for everything, to get its depth. A sprite
	// (an item's picture, a plant) would lie there as a flat quad, and glass or a soft shadow as a wall: they sit out.
	const hidden: Object3D[] = [];
	// an invisible group is left alone with all that is in it (the island's blocks at room zoom, the cards), and a mesh of
	// several materials sits out only when none of them writes depth
	const flatMaterial = (m: Mesh["material"]) => (Array.isArray(m) ? m.length > 0 && m.every((x) => x.transparent && !x.depthWrite) : !!m && m.transparent && !m.depthWrite);
	const hideIn = (o: Object3D) => {
		if (!o.visible) return;
		if ((o as Sprite).isSprite || (o as Points).isPoints || (o as Line).isLine || flatMaterial((o as Mesh).material)) { o.visible = false; hidden.push(o); return; }
		const children = o.children;
		for (let i = 0; i < children.length; i++) hideIn(children[i]!);
	};
	const hide = () => hideIn(scene);
	const show = () => { for (const o of hidden) o.visible = true; hidden.length = 0; };
	const patched = ao as unknown as { _overrideVisibility(): void; _restoreVisibility(): void };
	patched._overrideVisibility = hide; patched._restoreVisibility = show;
	const blurDepth = bokeh.render.bind(bokeh);
	bokeh.render = (...args: Parameters<typeof blurDepth>) => { hide(); try { blurDepth(...args); } finally { show(); } };
	const direction = camera.position.clone();
	return {
		/** The passes, for measurements. */
		composer,
		/** Takes the numbers of POST anew. */
		tune() { ao.updateGtaoMaterial({ radius: POST.aoRadius }); ao.blendIntensity = POST.aoIntensity; bloom.strength = POST.bloomStrength; bloom.radius = POST.bloomRadius; },
		/** How light it is (1 day, 0 night): sets where the bloom starts. */
		daylight(d: number) { bloom.threshold = POST.bloomNight + (POST.bloomDay - POST.bloomNight) * d; },
		/** The picture's size in CSS pixels; the renderer's pixel ratio may have changed (the resolution follows the frame rate). */
		resize(w: number, h: number) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); },
		/** Draws one frame; `blur` (0 to 1) is how far the background is out of focus (the close level), `shadows` whether
		 *  the shadow map is drawn anew (else the last one stays). */
		render(blur: number, shadows = true) {
			bokeh.enabled = blur > 0;
			if (blur > 0) {
				const uniforms = bokeh.uniforms as Record<"focus" | "aperture" | "maxblur", { value: number }>;
				camera.getWorldDirection(direction);
				uniforms.focus.value = Math.max(camera.near, (camera.position.y - 0.9) / Math.max(0.01, -direction.y));
				uniforms.aperture.value = 0.0015 * blur; uniforms.maxblur.value = 0.006 * blur;
			}
			const mask = camera.layers.mask, autoClear = renderer.autoClear, shadowAutoUpdate = renderer.shadowMap.autoUpdate, toneMapping = renderer.toneMapping;
			try {
				// the shadow map at most once a frame, not again for the occlusion's and the blur's own passes over the scene
				renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = shadows;
				camera.layers.set(0); composer.render();
				camera.layers.set(1); renderer.toneMapping = NoToneMapping; renderer.autoClear = false; renderer.clearDepth(); renderer.render(scene, camera);
			} finally { camera.layers.mask = mask; renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadowAutoUpdate; renderer.toneMapping = toneMapping; }
		},
		dispose() {
			for (const pass of composer.passes) pass.dispose();
			composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); composer.dispose();
		},
	};
}
