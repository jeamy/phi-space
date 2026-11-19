// The ambient occlusion of the 3D view, worked out once per room instead of in every frame (3D v3, docs/3D-V3/README.md).
// Measured on a phone the occlusion in the picture (GTAOPass) cost a third of a frame, and neither fewer samples nor the
// picture's own depth made it cheaper. Here the room is drawn once from straight above into a depth: that is the height
// of whatever stands at each point (the ground, a wall, a roof, a tree's crown). The heights are blurred by about the
// occlusion's reach, and a surface lower than the blurred height round it lies in a hollow: the ground at the foot of a
// wall or under a crown, a wall near its foot, a figure standing beside a house. Every lit material reads that height at
// its own point in the world (one texture read) and darkens its light by how far it lies below it.
// Figures and the sky stay out of the height (they are not what darkens), and so do the things the picture's occlusion
// left out: sprites, points, lines, and what is see-through without depth. Outside the room's rectangle nothing darkens
// (the island's other rooms, far away and small).
import type { Mesh, Object3D, OrthographicCamera, Scene, ShaderMaterial, Texture, Vector4, WebGLRenderer, WebGLRenderTarget } from "three";

type T = typeof import("three");
type Shader = { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string };

/** The numbers of the occlusion: how dark a hollow gets at most, how deep (in world units, a cell is 1) a surface must
 *  lie under the heights round it to get that dark, how far the heights are blurred, and texels per cell. */
export const AO = { strength: 0.45, depth: 0.7, reach: 0.45, texels: 8 };

const uniforms = { uAoMap: { value: null as Texture | null }, uAoRect: { value: null as Vector4 | null }, uAoStrength: { value: 0 }, uAoDepth: { value: AO.depth } };
let on = AO.strength;

const VERTEX_HEAD = "varying vec3 vAoWorld;";
const VERTEX = `
	{
		vec4 aoAt = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
			aoAt = instanceMatrix * aoAt;
		#endif
		vAoWorld = ( modelMatrix * aoAt ).xyz;
	}`;
const FRAGMENT_HEAD = "uniform sampler2D uAoMap;\nuniform vec4 uAoRect;\nuniform float uAoStrength;\nuniform float uAoDepth;\nvarying vec3 vAoWorld;";
// after the lights: the whole diffuse light, as the picture's occlusion darkened the whole picture (the sky's light alone
// is too faint to show it), and the reflections with it
const FRAGMENT = `
	{
		vec2 aoUv = ( vAoWorld.xz - uAoRect.xy ) * uAoRect.zw;
		if ( uAoStrength > 0.0 && aoUv.x >= 0.0 && aoUv.x <= 1.0 && aoUv.y >= 0.0 && aoUv.y <= 1.0 ) {
			float aoKeep = 1.0 - uAoStrength * clamp( ( texture2D( uAoMap, aoUv ).r - vAoWorld.y ) / uAoDepth, 0.0, 1.0 );
			reflectedLight.directDiffuse *= aoKeep; reflectedLight.indirectDiffuse *= aoKeep;
			reflectedLight.directSpecular *= mix( 1.0, aoKeep, 0.5 ); reflectedLight.indirectSpecular *= aoKeep;
		}
	}`;

/** Puts the occlusion into a lit material's shader (an onBeforeCompile of its own calls this at its end). */
export function withAo(shader: Shader): void {
	if (!shader.fragmentShader.includes("#include <aomap_fragment>") || !shader.vertexShader.includes("#include <project_vertex>")) return;
	Object.assign(shader.uniforms, uniforms);
	shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${VERTEX_HEAD}`).replace("#include <project_vertex>", `#include <project_vertex>${VERTEX}`);
	shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${FRAGMENT_HEAD}`).replace("#include <aomap_fragment>", `#include <aomap_fragment>${FRAGMENT}`);
}

let installed = false;
/** Every MeshStandardMaterial without an onBeforeCompile of its own takes the occlusion; one with `userData.noAo` (under
 *  the ground: the block's sides, the seabed, the fish) does not. */
export function installAo(t: T): void {
	if (installed) return;
	installed = true;
	uniforms.uAoRect.value = new t.Vector4(0, 0, 0, 0);
	const proto = t.MeshStandardMaterial.prototype as unknown as { onBeforeCompile(this: { userData: Record<string, unknown> }, shader: Shader): void; customProgramCacheKey(this: { userData: Record<string, unknown>; onBeforeCompile: () => void }): string };
	proto.onBeforeCompile = function (shader) { if (!this.userData.noAo) withAo(shader); };
	proto.customProgramCacheKey = function () { return `${this.userData.noAo ? "" : "ao:"}${this.onBeforeCompile.toString()}`; };
}

/** For measurements: the occlusion left out (it stays baked). */
export function aoOff(off: boolean): void { uniforms.uAoStrength.value = off ? 0 : on; }

/** Takes the numbers of AO anew (a bake takes the reach and the texels). */
export function tuneAo(): void { on = AO.strength; uniforms.uAoDepth.value = AO.depth; if (uniforms.uAoStrength.value > 0) uniforms.uAoStrength.value = on; }

/** Draws the heights of a room and blurs them; `hide` takes out what is not to darken and puts it back. */
export function createAoBaker(t: T, renderer: WebGLRenderer) {
	const camera: OrthographicCamera = new t.OrthographicCamera();
	camera.up.set(0, 0, -1); // the picture's up is the world's −z: its v grows towards −z
	const TOP = 30, FAR = 60; // a point cleared lies at TOP − FAR, under everything
	const depthOnly = new t.MeshBasicMaterial({ colorWrite: false, side: t.DoubleSide });
	let depth: WebGLRenderTarget | null = null, a: WebGLRenderTarget | null = null, b: WebGLRenderTarget | null = null;
	const blur: ShaderMaterial = new t.ShaderMaterial({
		uniforms: { tIn: { value: null }, uStep: { value: new t.Vector2() }, uSigma: { value: 1 }, uFromDepth: { value: 0 }, uTop: { value: TOP }, uSpan: { value: FAR } },
		vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
		fragmentShader: `uniform sampler2D tIn; uniform vec2 uStep; uniform float uSigma; uniform float uFromDepth; uniform float uTop; uniform float uSpan;
varying vec2 vUv;
float heightAt( vec2 uv ) { float v = texture2D( tIn, uv ).r; return uFromDepth > 0.5 ? uTop - v * uSpan : v; }
void main() {
	float sum = 0.0, weights = 0.0;
	for ( int i = -16; i <= 16; i++ ) {
		float x = float( i );
		if ( abs( x ) > 2.5 * uSigma ) continue;
		float w = exp( -0.5 * x * x / ( uSigma * uSigma ) );
		sum += w * heightAt( vUv + uStep * x ); weights += w;
	}
	gl_FragColor = vec4( sum / weights, 0.0, 0.0, 1.0 );
}`,
		depthTest: false, depthWrite: false,
	});
	const quad = new t.Mesh(new t.PlaneGeometry(2, 2), blur); quad.frustumCulled = false;
	const quadScene = new t.Scene(); quadScene.add(quad);
	const quadCamera = new t.Camera();
	const target = (w: number, h: number, withDepth: boolean) => new t.WebGLRenderTarget(w, h, { type: t.HalfFloatType, format: t.RedFormat, minFilter: t.LinearFilter, magFilter: t.LinearFilter, depthBuffer: withDepth, ...(withDepth ? { depthTexture: new t.DepthTexture(w, h, t.FloatType) } : {}) });
	const free = () => { for (const r of [depth, a, b]) { r?.depthTexture?.dispose(); r?.dispose(); } depth = a = b = null; };
	const pass = (from: Texture, to: WebGLRenderTarget, step: [number, number], fromDepth: boolean, sigma: number) => {
		const u = blur.uniforms as Record<string, { value: unknown }>;
		u.tIn!.value = from; (u.uStep!.value as import("three").Vector2).set(step[0], step[1]); u.uFromDepth!.value = fromDepth ? 1 : 0; u.uSigma!.value = sigma;
		renderer.setRenderTarget(to); renderer.render(quadScene, quadCamera);
	};
	return {
		/** Bakes the occlusion of the rectangle from (x0, z0) of w × d world units. */
		bake(scene: Scene, rect: { x0: number; z0: number; w: number; d: number }, hide: (out: boolean) => void): void {
			const W = Math.max(4, Math.min(2048, Math.ceil(rect.w * AO.texels))), H = Math.max(4, Math.min(2048, Math.ceil(rect.d * AO.texels)));
			if (!depth || depth.width !== W || depth.height !== H) { free(); depth = target(W, H, true); a = target(W, H, false); b = target(W, H, false); }
			camera.left = -rect.w / 2; camera.right = rect.w / 2; camera.top = rect.d / 2; camera.bottom = -rect.d / 2; camera.near = 0; camera.far = FAR;
			camera.position.set(rect.x0 + rect.w / 2, TOP, rect.z0 + rect.d / 2); camera.lookAt(rect.x0 + rect.w / 2, 0, rect.z0 + rect.d / 2);
			camera.updateProjectionMatrix(); camera.updateMatrixWorld(); camera.layers.set(0);
			const before = renderer.getRenderTarget(), override = scene.overrideMaterial, background = scene.background, fog = scene.fog;
			const shadowAuto = renderer.shadowMap.autoUpdate, shadowNeeds = renderer.shadowMap.needsUpdate, autoClear = renderer.autoClear;
			try {
				renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false; renderer.autoClear = true;
				scene.overrideMaterial = depthOnly; scene.background = null; scene.fog = null; hide(true);
				renderer.setRenderTarget(depth); renderer.clear(); renderer.render(scene, camera);
			} finally {
				hide(false); scene.overrideMaterial = override; scene.background = background; scene.fog = fog;
				renderer.shadowMap.autoUpdate = shadowAuto; renderer.shadowMap.needsUpdate = shadowNeeds; renderer.autoClear = autoClear;
			}
			const sigma = Math.max(1, (AO.reach * AO.texels) / 2);
			pass(depth!.depthTexture!, a!, [1 / W, 0], true, sigma);
			pass(a!.texture, b!, [0, 1 / H], false, sigma);
			renderer.setRenderTarget(before);
			// the map's u runs along +x, its v from the far edge (z0 + d) towards −z
			uniforms.uAoMap.value = b!.texture; uniforms.uAoRect.value!.set(rect.x0, rect.z0 + rect.d, 1 / rect.w, -1 / rect.d); uniforms.uAoStrength.value = on;
		},
		/** No room: nothing darkens. */
		clear(): void { uniforms.uAoStrength.value = 0; uniforms.uAoMap.value = null; },
		dispose(): void { free(); blur.dispose(); quad.geometry.dispose(); depthOnly.dispose(); },
	};
}

/** What stays out of the heights: sprites, points, lines, what is see-through without depth, and the parts `out` names. */
export function aoHider(scene: Scene, out: () => Iterable<Object3D | null | undefined>) {
	const hidden: Object3D[] = [];
	const flat = (m: Mesh["material"]) => (Array.isArray(m) ? m.length > 0 && m.every((x) => x.transparent && !x.depthWrite) : !!m && m.transparent && !m.depthWrite);
	const walk = (o: Object3D) => {
		if (!o.visible) return;
		if ((o as import("three").Sprite).isSprite || (o as import("three").Points).isPoints || (o as import("three").Line).isLine || o.userData.sky || flat((o as Mesh).material)) { o.visible = false; hidden.push(o); return; }
		for (let i = 0; i < o.children.length; i++) walk(o.children[i]!);
	};
	return (hide: boolean) => {
		if (!hide) { for (const o of hidden) o.visible = true; hidden.length = 0; return; }
		for (const o of out()) if (o?.visible) { o.visible = false; hidden.push(o); }
		walk(scene);
	};
}
