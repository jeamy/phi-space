// The water's surface in the 3D view (3D v3, docs/3D-V3/README.md): instead of the tile art a surface that mirrors the sky,
// with ripples that run with the time, a colour that deepens away from the shore, and foam where it meets the land. The
// shore comes from the room's grid: every water cell knows how many cells it is from the nearest land (`shoreDistances`),
// which the surface reads as a small texture. Visual only.

type T = typeof import("three");

/** How far out the shore still shows (cells): beyond it the water has its deep colour. */
export const SHORE_REACH = 4;

/** For every cell of the grid (row by row) how far it is from the nearest land, in cells: 0 on land, 1 beside it,
 *  diagonal steps count √2, never more than `reach`. Beyond the room's edge lies open water. */
export function shoreDistances(ground: readonly string[], water: (key: string) => boolean, reach = SHORE_REACH): Float32Array {
	const h = ground.length, w = ground[0]?.length ?? 0, d = new Float32Array(w * h).fill(reach), diagonal = Math.SQRT2;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!water(ground[y]![x]!)) d[y * w + x] = 0;
	const relax = (x: number, y: number, dx: number, dy: number, step: number) => {
		const nx = x + dx, ny = y + dy;
		if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
		const via = d[ny * w + nx]! + step;
		if (via < d[y * w + x]!) d[y * w + x] = via;
	};
	// two sweeps (a chamfer distance): down and right, then up and left
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { relax(x, y, -1, 0, 1); relax(x, y, 0, -1, 1); relax(x, y, -1, -1, diagonal); relax(x, y, 1, -1, diagonal); }
	for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { relax(x, y, 1, 0, 1); relax(x, y, 0, 1, 1); relax(x, y, 1, 1, diagonal); relax(x, y, -1, 1, diagonal); }
	return d;
}

/** The time the ripples run with, in seconds (the view sets it once a frame). */
const time = { value: 0 };
export function setWaterTime(seconds: number): void { time.value = seconds % 3600; }

const HEAD = /* glsl */ `
uniform float uWaterTime;
uniform sampler2D uShore;
uniform vec2 uRoom;
uniform vec3 uShallow;
uniform vec3 uDeep;
varying vec3 vWaterPos;
float waterHash( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
float waterNoise( vec2 p ) {
	vec2 i = floor( p ), f = fract( p ), u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( waterHash( i ), waterHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( waterHash( i + vec2( 0.0, 1.0 ) ), waterHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float waterHeight( vec2 p ) {
	float t = uWaterTime;
	return 0.5 * sin( dot( p, vec2( 0.8, 0.6 ) ) * 2.1 + t * 1.1 ) + 0.3 * sin( dot( p, vec2( -0.5, 0.86 ) ) * 3.7 - t * 1.5 )
		+ 0.2 * sin( dot( p, vec2( 0.3, -0.95 ) ) * 6.3 + t * 2.2 ) + 0.45 * waterNoise( p * 4.0 + vec2( t * 0.3, -t * 0.22 ) ) + 0.25 * waterNoise( p * 9.0 - vec2( t * 0.4, t * 0.1 ) );
}`;
/** The shore's value at the waterline (the texture runs from 0 on land to 1 at SHORE_REACH; the line lies half a cell out). */
const LINE = (0.5 / SHORE_REACH).toFixed(4);
const COLOUR = /* glsl */ `
	float waterShore = texture2D( uShore, vWaterPos.xz / uRoom + 0.5 ).r;
	float waterDeep = smoothstep( ${LINE}, 0.85, waterShore );
	diffuseColor.rgb = mix( uShallow, uDeep, waterDeep );
	float waterGrain = waterNoise( vWaterPos.xz * 3.0 + vec2( uWaterTime * 0.15, uWaterTime * 0.11 ) );
	// foam: a ragged band at the land, and lines of it that run in towards the shore
	float waterFoam = smoothstep( ${LINE} + 0.12, ${LINE} + 0.01, waterShore + ( waterGrain - 0.5 ) * 0.08 ) * ( 0.5 + 0.5 * waterGrain );
	float waterRun = smoothstep( 0.8, 0.97, sin( waterShore * 34.0 + uWaterTime * 1.3 + waterGrain * 2.0 ) * 0.5 + 0.5 );
	waterFoam = clamp( max( waterFoam, waterRun * smoothstep( ${LINE} + 0.34, ${LINE} + 0.04, waterShore ) * waterGrain ), 0.0, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.9, 0.93, 0.93 ), waterFoam );`;
const NORMAL = /* glsl */ `
	{
		vec2 at = vWaterPos.xz; float e = 0.04, steep = 0.05 + 0.07 * waterDeep;
		float here = waterHeight( at );
		vec3 up = normalize( vec3( ( here - waterHeight( at + vec2( e, 0.0 ) ) ) / e * steep, 1.0, ( here - waterHeight( at + vec2( 0.0, e ) ) ) / e * steep ) );
		normal = normalize( ( viewMatrix * vec4( up, 0.0 ) ).xyz );
	}`;

/** The material of a room's water surface (a face that looks up): `ground` gives the shore. It owns a small texture;
 *  `material.userData.dispose` frees it. */
export function waterMaterial(t: T, ground: readonly string[], water: (key: string) => boolean): import("three").MeshStandardMaterial {
	const h = ground.length, w = ground[0]?.length ?? 0, distances = shoreDistances(ground, water), data = new Uint8Array(w * h);
	for (let i = 0; i < data.length; i++) data[i] = Math.round((distances[i]! / SHORE_REACH) * 255);
	const shore = new t.DataTexture(data, w, h, t.RedFormat, t.UnsignedByteType);
	shore.magFilter = shore.minFilter = t.LinearFilter; shore.needsUpdate = true;
	const material = new t.MeshStandardMaterial({ color: 0xffffff, roughness: 0.07, metalness: 0, envMapIntensity: 1.25 });
	const uniforms = { uWaterTime: time, uShore: { value: shore }, uRoom: { value: new t.Vector2(w, h) }, uShallow: { value: new t.Color(0x4f9a94) }, uDeep: { value: new t.Color(0x0d3350) } };
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vWaterPos;")
			.replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvec4 waterAt = vec4( transformed, 1.0 );\n\t#ifdef USE_INSTANCING\n\t\twaterAt = instanceMatrix * waterAt;\n\t#endif\n\tvWaterPos = ( modelMatrix * waterAt ).xyz;");
		shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${HEAD}`)
			.replace("#include <color_fragment>", `#include <color_fragment>\n${COLOUR}`)
			.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, 0.85, waterFoam );")
			.replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${NORMAL}`);
	};
	material.customProgramCacheKey = () => "water3d";
	material.userData.dispose = () => shore.dispose();
	return material;
}
