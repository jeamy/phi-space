// The ground's materials in the 3D view (3D v3, docs/3D-V3/README.md): instead of the tile art, photographed surfaces
// (colour, normals, and occlusion with roughness: public/materials/<name>/, CC0, worlds/leuchtfeuer/assets/CREDITS.md)
// on the terraces of each tile kind. Sand is wet and dark where the water is near, and every surface varies a little
// over the room so the repeat of its picture does not show. A tile kind without a material here keeps the tile art, and
// until the pictures have loaded (or where the page is served without them) a surface shows its plain colour.
// Visual only.
import { SHORE_REACH, shoreTexture } from "./water3d.ts";
import { cellEdge } from "./cell3d.ts";
import { withAo } from "./ao3d.ts";
import type { TerraceLook } from "./terraces3d.ts";

type T = typeof import("three");
type Texture = import("three").Texture;

/** The material of each tile kind: its folder, how many world units (cells of scale 1) one picture covers, a tint (and a gain on it, where the
 *  photograph is darker than the game's ground), and whether it gets wet near the water. */
type Spec = { name: string; cells: number; tint: number; gain?: number; wet?: boolean };
export const GROUND: Record<string, Spec> = {
	".": { name: "sand", cells: 2, tint: 0xfff4de, gain: 1.3, wet: true },
	",": { name: "grass", cells: 2.5, tint: 0xd0f59a, gain: 1.15 },
	":": { name: "paving", cells: 2, tint: 0xe6e8ee },
	"_": { name: "planks", cells: 2, tint: 0xf2dcc0 },
	"#": { name: "plaster", cells: 1.5, tint: 0xf4ecda },
};
/** The earth of a terrace's wall, below the rounded edge. */
const EARTH: Spec = { name: "rock", cells: 2, tint: 0xb89a78 };

type Maps = { color: Texture; normal: Texture; arm: Texture };
const loading = new Map<string, Promise<Maps | null>>();
/** The three pictures of a material, loaded once and shared between rooms; null where they are not served. */
export function groundMaps(t: T, name: string, cells: number, anisotropy: number): Promise<Maps | null> {
	const id = `${name}@${cells}`;
	let p = loading.get(id);
	if (!p) {
		const loader = new t.TextureLoader();
		const one = (file: string, srgb: boolean) => loader.loadAsync(`/materials/${name}/${file}.jpg`).then((texture) => {
			texture.wrapS = texture.wrapT = t.RepeatWrapping; texture.repeat.set(1 / cells, 1 / cells); texture.anisotropy = anisotropy;
			if (srgb) texture.colorSpace = t.SRGBColorSpace;
			texture.userData.shared = true;
			return texture;
		});
		p = Promise.all([one("color", true), one("normal", false), one("arm", false)]).then(([color, normal, arm]) => ({ color, normal, arm }), () => null);
		loading.set(id, p);
	}
	return p;
}

const HEAD = /* glsl */ `
uniform sampler2D uWet;
uniform vec2 uRoom;
varying vec3 vGroundPos;
float groundHash( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
float groundNoise( vec2 p ) {
	vec2 i = floor( p ), f = fract( p ), u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( groundHash( i ), groundHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( groundHash( i + vec2( 0.0, 1.0 ) ), groundHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}`;
const COLOUR = (wet: boolean) => /* glsl */ `
	diffuseColor.rgb *= 0.86 + 0.28 * ( 0.6 * groundNoise( vGroundPos.xz * 0.37 ) + 0.4 * groundNoise( vGroundPos.xz * 1.3 + 7.0 ) );
	float groundWet = ${wet ? `smoothstep( 1.3, 0.55, texture2D( uWet, vGroundPos.xz / uRoom + 0.5 ).r * ${SHORE_REACH.toFixed(1)} + ( groundNoise( vGroundPos.xz * 2.4 ) - 0.5 ) * 0.35 )` : "0.0"};
	diffuseColor.rgb *= mix( 1.0, 0.58, groundWet );`;

/** The looks of a room's tile kinds: `look(key, plain)` gives a kind's three materials (top, rounded edge, wall), or
 *  null for a kind without a material here. `plain` is the colour it shows until its pictures are there. The looks own
 *  one small texture (how near the water is); `dispose` on any of the materials' userData frees it. */
export function groundLooks(t: T, ground: readonly string[], water: (key: string) => boolean, anisotropy: number, e = cellEdge()): (key: string, plain: number) => TerraceLook | null {
	const h = ground.length * e, w = (ground[0]?.length ?? 0) * e;
	// for every land cell how far the water is: the water's own shore texture with land and water swapped
	// (made with the first material: a room without any of these kinds makes none, and nothing would free it)
	let near: import("three").DataTexture | null = null;
	const uniforms = { uWet: { value: null as import("three").DataTexture | null }, uRoom: { value: new t.Vector2(Math.max(e, w), Math.max(e, h)) } };
	const make = (spec: Spec, plain: number, shade: number) => {
		const material = new t.MeshStandardMaterial({ color: new t.Color(plain).multiplyScalar(shade), roughness: 0.95, metalness: 0 });
		const wet = !!spec.wet, shore = near ??= shoreTexture(t, ground, (key) => !water(key), e);
		uniforms.uWet.value = shore;
		material.onBeforeCompile = (shader) => {
			Object.assign(shader.uniforms, uniforms);
			shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vGroundPos;")
				.replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvGroundPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
			shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${HEAD}`)
				.replace("#include <color_fragment>", `#include <color_fragment>\n${COLOUR(wet)}`)
				.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, 0.28, groundWet );");
			withAo(shader); // the room's occlusion (ao3d.ts)
		};
		material.customProgramCacheKey = () => `ground3d:${wet}`;
		material.userData.dispose = () => shore.dispose();
		void groundMaps(t, spec.name, spec.cells, anisotropy).then((m) => {
			if (!m) return;
			material.map = m.color; material.normalMap = m.normal; material.roughnessMap = m.arm; material.aoMap = m.arm;
			material.roughness = 1; material.color.setHex(spec.tint).multiplyScalar(shade * (spec.gain ?? 1)); material.needsUpdate = true;
		});
		return material;
	};
	const made = new Map<string, TerraceLook>();
	let wall: import("three").MeshStandardMaterial | null = null;
	return (key, plain) => {
		const spec = GROUND[key];
		if (!spec) return null;
		let look = made.get(key);
		if (!look) { look = { top: make(spec, plain, 1), flank: make(spec, plain, 0.88), wall: wall ??= make(EARTH, 0x6b5236, 1) }; made.set(key, look); }
		return look;
	};
}
