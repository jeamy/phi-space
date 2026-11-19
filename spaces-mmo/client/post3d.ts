// The picture of the 3D view after the scene is drawn (3D v3, docs/3D-V3/README.md), at every zoom: the scene goes into a
// half-float target with multisampling (the ambient occlusion is in the materials, worked out once per room: ao3d.ts), a
// bloom on what is far brighter than a white wall in the sun (fire, lamplit windows, the sun's glint on water), close up the depth-aware blur of the
// background (v2), and last the filmic tone curve and the display's colour space. Names and speech bubbles (layer 1) are
// drawn afterwards, straight to the screen, so they stay sharp and keep their colours.
import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { DepthTexture, HalfFloatType, NoToneMapping, Vector2, WebGLRenderTarget } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { aoOff } from "./ao3d.ts";

/** The numbers of the picture, in one place. The bloom starts at a brightness
 *  that follows the daylight, as an eye does: by day only what outshines sand in the sun, at night every lamp. */
export const POST = { samples: 4, bloomStrength: 0.22, bloomRadius: 0.5, bloomDay: 3.4, bloomNight: 1.2 };

export function createPost(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
	const ratio = renderer.getPixelRatio();
	// the targets keep the scene's depth (resolved from the multisampling) for the close-up blur; the composer clones the
	// first target with its depth texture
	const composer = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: POST.samples, depthTexture: new DepthTexture(1, 1) }));
	composer.setPixelRatio(ratio);
	composer.addPass(new RenderPass(scene, camera));
	const bloom = new UnrealBloomPass(new Vector2(1, 1), POST.bloomStrength, POST.bloomRadius, POST.bloomDay); composer.addPass(bloom);
	const bokeh = new BokehPass(scene, camera, { focus: 10, aperture: 0.0015, maxblur: 0.006 }); bokeh.enabled = false; composer.addPass(bokeh);
	composer.addPass(new OutputPass());
	// The blur reads the depth the scene left in the target it was drawn into (the bloom adds to that target without
	// swapping; the blur draws into the other one) instead of drawing the whole scene once more for a depth of its own.
	const blur = bokeh as unknown as { materialBokeh: import("three").ShaderMaterial; uniforms: Record<string, { value: unknown }>; _fsQuad: { render(r: WebGLRenderer): void }; _renderTargetDepth: WebGLRenderTarget };
	blur.materialBokeh.defines.DEPTH_PACKING = 0; blur.materialBokeh.needsUpdate = true;
	blur._renderTargetDepth.dispose();
	bokeh.setSize = (w: number, h: number) => { blur.uniforms.aspect!.value = w / h; };
	bokeh.render = (r: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget) => {
		blur.uniforms.tDepth!.value = readBuffer.depthTexture; blur.uniforms.tColor!.value = readBuffer.texture;
		blur.uniforms.nearClip!.value = camera.near; blur.uniforms.farClip!.value = camera.far;
		r.setRenderTarget(bokeh.renderToScreen ? null : writeBuffer);
		blur._fsQuad.render(r);
	};
	const direction = camera.position.clone();
	let noBlur = false, direct = false;
	return {
		/** The passes, for measurements. */
		composer,
		/** For measurements: the occlusion (ao3d.ts), the bloom, the edges' smoothing or the whole chain left out. */
		leaveOut(parts: { ao?: boolean; bloom?: boolean; smooth?: boolean; post?: boolean }) {
			aoOff(!!parts.ao); bloom.enabled = !parts.bloom; direct = !!parts.post;
			// without multisampling the blur would read the depth of a target that also holds it for drawing
			noBlur = !!parts.post || !!parts.smooth;
			// the edges' smoothing is the targets' multisampling: a target with another count is made anew
			const samples = parts.smooth ? 0 : POST.samples;
			for (const target of [composer.renderTarget1, composer.renderTarget2]) if (target.samples !== samples) { target.samples = samples; target.dispose(); }
		},
		/** Takes the numbers of POST anew. */
		tune() { bloom.strength = POST.bloomStrength; bloom.radius = POST.bloomRadius; },
		/** How light it is (1 day, 0 night): sets where the bloom starts. */
		daylight(d: number) { bloom.threshold = POST.bloomNight + (POST.bloomDay - POST.bloomNight) * d; },
		/** The picture's size in CSS pixels; the renderer's pixel ratio may have changed (the resolution follows the frame rate). */
		resize(w: number, h: number) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); },
		/** Draws one frame; `blur` (0 to 1) is how far the background is out of focus (the close level), `shadows` whether
		 *  the shadow map is drawn anew (else the last one stays). */
		render(blur: number, shadows = true) {
			if (noBlur) blur = 0;
			bokeh.enabled = blur > 0;
			if (blur > 0) {
				const uniforms = bokeh.uniforms as Record<"focus" | "aperture" | "maxblur", { value: number }>;
				camera.getWorldDirection(direction);
				uniforms.focus.value = Math.max(camera.near, (camera.position.y - 0.9) / Math.max(0.01, -direction.y));
				uniforms.aperture.value = 0.0015 * blur; uniforms.maxblur.value = 0.006 * blur;
			}
			const mask = camera.layers.mask, autoClear = renderer.autoClear, shadowAutoUpdate = renderer.shadowMap.autoUpdate, toneMapping = renderer.toneMapping;
			try {
				// the shadow map at most once a frame
				renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = shadows;
				camera.layers.set(0);
				if (direct) { renderer.setRenderTarget(null); renderer.render(scene, camera); } else composer.render();
				camera.layers.set(1); renderer.toneMapping = NoToneMapping; renderer.autoClear = false; renderer.clearDepth(); renderer.render(scene, camera);
			} finally { camera.layers.mask = mask; renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadowAutoUpdate; renderer.toneMapping = toneMapping; }
		},
		dispose() {
			for (const pass of composer.passes) pass.dispose();
			composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); composer.dispose();
		},
	};
}
