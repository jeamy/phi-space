// The sky of the 3D view (3D v3, docs/3D-V3/README.md): a physical sky whose sun follows the world's clock, and the light
// of that sky on everything as an environment map (reflections and the fill light that the hemisphere light used to
// fake). Below the horizon the sky darkens to a studio floor, so the diorama block stands out and the light from below is
// weaker than the light from above; at night a dim blue glow stays. The fog takes the sky's own colour at the horizon,
// so the block's far edge and the void meet without a seam. Visual only.
import { Sky } from "three/addons/objects/Sky.js";
import { skyAt, type V3 } from "./camera3d.ts";

type T = typeof import("three");

/** How bright the sky is against the sun (the directional light): the sky shader's own values are made for a far
 *  lower exposure, and at 1 its horizon at noon would be three times white. */
const SKY_GAIN = 0.4;
/** How often the environment map is rendered anew: when the world's clock moved by this many hours. */
const ENV_STEP_HOURS = 0.1;

export type Atmosphere = {
	/** Sets the sky for a world hour and a fog level (0 to 3); renders the environment map anew when either moved enough.
	 *  Returns whether it did. */
	update(hour: number, fogLevel: number): boolean;
	dispose(): void;
};

export function createAtmosphere(t: T, renderer: import("three").WebGLRenderer, scene: import("three").Scene, fog: import("three").FogExp2): Atmosphere {
	const sky = new Sky();
	const material = sky.material as import("three").ShaderMaterial, u = material.uniforms as Record<string, { value: unknown }>;
	u.nightGlow = { value: 0 }; u.skyGain = { value: SKY_GAIN };
	material.fragmentShader = material.fragmentShader
		.replace("uniform float showSunDisc;", "uniform float showSunDisc;\n\t\tuniform float nightGlow;\n\t\tuniform float skyGain;")
		.replace("gl_FragColor = vec4( texColor, 1.0 );", `texColor *= skyGain;
			texColor += vec3( 0.035, 0.055, 0.11 ) * nightGlow * ( 2.0 - abs( direction.y ) );
			texColor *= mix( vec3( 1.0 ), vec3( 0.36, 0.35, 0.33 ), smoothstep( 0.0, -0.7, direction.y ) );
			gl_FragColor = vec4( texColor, 1.0 );`);
	// drawn after everything solid, so only the pixels that show sky run its shader (clouds and scattering)
	sky.scale.setScalar(1000); sky.frustumCulled = false; sky.renderOrder = 1000; sky.userData.unshaded = true; sky.userData.sky = true;
	scene.add(sky);

	// the same sky without its sun disc, for the environment map (the sun itself is the directional light)
	const envScene = new t.Scene(), envSky = new t.Mesh(sky.geometry, material);
	envSky.scale.setScalar(1000); envSky.frustumCulled = false; envScene.add(envSky);
	const pmrem = new t.PMREMGenerator(renderer);
	let env: import("three").WebGLRenderTarget | null = null;
	// one pixel of the sky a little below the horizon, for the fog's colour
	const probe = new t.WebGLRenderTarget(1, 1, { type: t.HalfFloatType }), probeCamera = new t.PerspectiveCamera(4, 1, 0.1, 10), pixel = new Uint16Array(4);
	let doneHour = Infinity, doneFog = -1;

	const set = (hour: number, fogLevel: number) => {
		const at = skyAt(hour), sun = at.sun as V3;
		(u.sunPosition!.value as import("three").Vector3).set(sun[0], sun[1], sun[2]);
		// haze with the game's fog: a clear coast, then milky, then overcast
		u.turbidity!.value = 2.5 + fogLevel * 3; u.rayleigh!.value = 1.6 - fogLevel * 0.25;
		u.mieCoefficient!.value = 0.004 + fogLevel * 0.004; u.mieDirectionalG!.value = 0.8;
		u.cloudCoverage!.value = 0.3 + fogLevel * 0.18; u.cloudDensity!.value = 0.45 + fogLevel * 0.1; u.time!.value = hour * 600;
		u.nightGlow!.value = Math.min(1, Math.max(0, -at.sunElevation / (8 * Math.PI / 180) + 0.25));
	};
	return {
		update(hour, fogLevel) {
			set(hour, fogLevel);
			if (Math.abs(hour - doneHour) < ENV_STEP_HOURS && fogLevel === doneFog) return false;
			doneHour = hour; doneFog = fogLevel;
			u.showSunDisc!.value = 0;
			const next = pmrem.fromScene(envScene, 0, 0.1, 10);
			const at = skyAt(hour).sun, away = Math.atan2(at[2], at[0]) + Math.PI / 2;
			probeCamera.position.set(0, 0, 0); probeCamera.lookAt(Math.cos(away), -0.3, Math.sin(away));
			const target = renderer.getRenderTarget();
			renderer.setRenderTarget(probe); renderer.render(envScene, probeCamera);
			renderer.readRenderTargetPixels(probe, 0, 0, 1, 1, pixel);
			renderer.setRenderTarget(target);
			u.showSunDisc!.value = 1;
			const half = t.DataUtils.fromHalfFloat;
			fog.color.setRGB(half(pixel[0]!), half(pixel[1]!), half(pixel[2]!));
			scene.environment = next.texture;
			env?.dispose(); env = next;
			return true;
		},
		dispose() {
			scene.remove(sky); scene.environment = null;
			env?.dispose(); pmrem.dispose(); probe.dispose(); sky.geometry.dispose(); material.dispose();
		},
	};
}
