// The models' photographed surfaces in the 3D view (3D v3, docs/3D-V3/README.md): the procedural models have no texture
// coordinates, so a surface is laid on them from three sides by the place on the model (triplanar), chosen per part by
// the part's colour: bark, thatch, brick, slate, wood, stone and plaster. The pictures (public/materials/<name>/, CC0,
// worlds/leuchtfeuer/assets/CREDITS.md) are put into two array textures, one layer per surface: the colour, and the
// occlusion with the roughness. A surface keeps the part's own colour (the picture is divided by its mean) and gets its
// relief from the picture's brightness. Until the pictures are there, or where the page is served without them, the
// models show their plain colours. Visual only.

type T = typeof import("three");

/** The surfaces, in the order of their layers; `span` is how many cells one picture covers on a model. */
export const SURFACES = [
	{ name: "bark", span: 0.7 }, { name: "thatch", span: 0.9 }, { name: "brick", span: 0.62 }, { name: "slate", span: 0.6 },
	{ name: "wood", span: 1.1 }, { name: "rock", span: 1.0 }, { name: "plaster", span: 1.2 },
] as const;
export type Surface = typeof SURFACES[number]["name"];

/** Which surface a part of this colour carries (the colours of props3d.ts and buildings3d.ts). */
const BY_COLOUR: Record<number, Surface> = {
	0x6b4a2e: "bark",
	0xb8954e: "thatch", 0xa98545: "thatch", 0xc4a25c: "thatch",
	0xa5503a: "brick",
	0x5a5f70: "slate",
	0x8a6a44: "wood", 0x5b3a22: "wood",
	0x8a8577: "rock", 0x6a675e: "rock",
	0xd9cfb5: "plaster",
};
/** A part's layer, counted from 1; 0 for a part without a surface. `named` overrides the colour's own. A leaf has the
 *  layer after the last picture: no picture, but a leaf's own sheen. */
export const LEAF_LAYER = SURFACES.length + 1;
export function surfaceLayer(colour: number, named?: Surface | "none" | "leaf"): number {
	if (named === "leaf") return LEAF_LAYER;
	const name = named ?? BY_COLOUR[colour];
	return name && name !== "none" ? SURFACES.findIndex((s) => s.name === name) + 1 : 0;
}

const SIZE = 512, LAYERS = SURFACES.length;
type Uniforms = {
	uSurfaceColor: { value: import("three").DataArrayTexture }; uSurfaceArm: { value: import("three").DataArrayTexture };
	uSurfaceMean: { value: import("three").Vector3[] }; uSurfaceSpan: { value: number[] }; uSurfaceOn: { value: number };
};
let uniforms: Uniforms | null = null;

/** The uniforms of the surfaces, shared by every material that shows them; the pictures load once, in the background. */
export function surfaceUniforms(t: T): Uniforms {
	if (uniforms) return uniforms;
	const empty = () => { const x = new t.DataArrayTexture(new Uint8Array(4 * LAYERS).fill(255), 1, 1, LAYERS); x.needsUpdate = true; x.userData.shared = true; return x; };
	const u: Uniforms = uniforms = {
		uSurfaceColor: { value: empty() }, uSurfaceArm: { value: empty() },
		uSurfaceMean: { value: SURFACES.map(() => new t.Vector3(1, 1, 1)) }, uSurfaceSpan: { value: SURFACES.map((s) => s.span) }, uSurfaceOn: { value: 0 },
	};
	if (typeof document === "undefined") return u;
	const loader = new t.ImageLoader();
	const pixels = (image: HTMLImageElement) => {
		const c = document.createElement("canvas"); c.width = c.height = SIZE;
		const g = c.getContext("2d", { willReadFrequently: true })!;
		// the array's rows start at the bottom, a picture's at the top
		g.translate(0, SIZE); g.scale(1, -1); g.drawImage(image, 0, 0, SIZE, SIZE);
		return g.getImageData(0, 0, SIZE, SIZE).data;
	};
	void Promise.all(SURFACES.flatMap((s) => [loader.loadAsync(`/materials/${s.name}/color.jpg`), loader.loadAsync(`/materials/${s.name}/arm.jpg`)])).then((images) => {
		const color = new Uint8Array(SIZE * SIZE * 4 * LAYERS), arm = new Uint8Array(SIZE * SIZE * 4 * LAYERS);
		SURFACES.forEach((_, i) => {
			const c = pixels(images[i * 2]!), a = pixels(images[i * 2 + 1]!);
			color.set(c, i * SIZE * SIZE * 4); arm.set(a, i * SIZE * SIZE * 4);
			// the picture's mean colour as the shader reads it (linear), from every 16th pixel
			let r = 0, g = 0, b = 0, n = 0;
			const linear = (v: number) => Math.pow(v / 255, 2.2);
			for (let k = 0; k < c.length; k += 64) { r += linear(c[k]!); g += linear(c[k + 1]!); b += linear(c[k + 2]!); n++; }
			u.uSurfaceMean.value[i]!.set(r / n, g / n, b / n);
		});
		const array = (data: Uint8Array, srgb: boolean) => {
			const x = new t.DataArrayTexture(data, SIZE, SIZE, LAYERS);
			x.wrapS = x.wrapT = t.RepeatWrapping; x.minFilter = t.LinearMipmapLinearFilter; x.magFilter = t.LinearFilter; x.generateMipmaps = true;
			if (srgb) x.colorSpace = t.SRGBColorSpace;
			x.needsUpdate = true; x.userData.shared = true;
			return x;
		};
		u.uSurfaceColor.value.dispose(); u.uSurfaceArm.value.dispose();
		u.uSurfaceColor.value = array(color, true); u.uSurfaceArm.value = array(arm, false); u.uSurfaceOn.value = 1;
	}, () => { /* served without the pictures: the plain colours stay */ });
	return u;
}

/** Declarations for a fragment shader that shows the surfaces; it needs `vModelPos`, `vModelNormal` and `vSurface`. */
export const SURFACE_HEAD = /* glsl */ `
uniform sampler2DArray uSurfaceColor;
uniform sampler2DArray uSurfaceArm;
uniform vec3 uSurfaceMean[ ${LAYERS} ];
uniform float uSurfaceSpan[ ${LAYERS} ];
uniform float uSurfaceOn;
varying vec3 vModelNormal;
varying float vSurface;
// the surface seen from the three axes, mixed by how far the face looks along each; the sides keep the picture upright
vec3 surfaceSample( sampler2DArray map, vec3 p, vec3 w, float layer ) {
	return texture( map, vec3( p.zy, layer ) ).rgb * w.x + texture( map, vec3( p.xz, layer ) ).rgb * w.y + texture( map, vec3( p.xy, layer ) ).rgb * w.z;
}`;
/** After `color_fragment`: sets `surfaceArm` (occlusion, roughness) and `surfaceHigh` (the relief) and tints the colour. */
export const SURFACE_COLOUR = /* glsl */ `
	// read for every fragment (a texture read inside a branch has no slope to choose its level by), used where there is one
	float surfaceLeaf = step( ${LAYERS}.5, vSurface );
	float surfaceIs = step( 0.5, uSurfaceOn ) * step( 0.5, vSurface ) * ( 1.0 - surfaceLeaf );
	int surfaceAt = int( clamp( vSurface - 0.5, 0.0, ${LAYERS - 1}.0 ) );
	float surfaceLayer = float( surfaceAt );
	vec3 surfaceW = pow( abs( normalize( vModelNormal ) ), vec3( 4.0 ) );
	surfaceW /= surfaceW.x + surfaceW.y + surfaceW.z;
	vec3 surfaceP = vModelPos / uSurfaceSpan[ surfaceAt ];
	vec3 surfaceTint = clamp( surfaceSample( uSurfaceColor, surfaceP, surfaceW, surfaceLayer ) / uSurfaceMean[ surfaceAt ], 0.0, 2.2 );
	vec3 surfaceArm = surfaceSample( uSurfaceArm, surfaceP, surfaceW, surfaceLayer );
	diffuseColor.rgb *= mix( vec3( 1.0 ), surfaceTint * mix( 1.0, surfaceArm.r, 0.8 ), surfaceIs );
	float surfaceHigh = dot( surfaceTint, vec3( 0.333 ) ) * surfaceIs;
	surfaceArm.g = mix( mix( -1.0, 0.5, surfaceLeaf ), surfaceArm.g, surfaceIs );`;
