// What a player chose for the look of their figure (the `avatar` command, the "Figur" panel of the page): a figure type,
// the colour of the clothes, hair and skin, and the accessories. Only the 3D map draws it (client/figure3d.ts); the 2D
// map keeps its sprite (`skin`). Small indices into fixed palettes, so that what is stored and sent to everyone stays
// small and cannot carry anything but a choice. Shared by the server (parse and check) and the page (panel, figure).

export type Appearance = {
	/** index into FIGURES */ body: number;
	/** index into COATS */ coat: number;
	/** index into HAIRS */ hair: number;
	/** index into SKINS */ skin: number;
	/** index into HATS (0: none) */ hat: number;
	glasses: boolean;
	gloves: boolean;
};

export const FIGURES = ["Wanderer", "Seefahrerin", "Kräftig", "Schlaksig"] as const;
export const COATS = [
	{ name: "Blau", color: 0x3f6fa8 }, { name: "Rot", color: 0xb5533c }, { name: "Grün", color: 0x4f8a4a }, { name: "Violett", color: 0x8a5aa8 },
	{ name: "Ocker", color: 0xc9a23c }, { name: "Petrol", color: 0x2f7f86 }, { name: "Grau", color: 0x6d7076 }, { name: "Weiß", color: 0xe4ddcc },
] as const;
export const HAIRS = [
	{ name: "Schwarz", color: 0x15120f }, { name: "Dunkelbraun", color: 0x2a1c12 }, { name: "Braun", color: 0x5b3a1e }, { name: "Blond", color: 0xc4952e },
	{ name: "Rot", color: 0x9a3b1f }, { name: "Grau", color: 0x8d8d90 }, { name: "Weiß", color: 0xe8e4dc }, { name: "Blau", color: 0x3a5fa8 },
] as const;
export const SKINS = [
	{ name: "Hell", color: 0xf0c8a0 }, { name: "Rosig", color: 0xe8b894 }, { name: "Mittel", color: 0xdcae82 }, { name: "Gebräunt", color: 0xc08a5c }, { name: "Dunkel", color: 0x95643f },
] as const;
export const HATS = ["ohne", "Hut", "Mütze", "Kapitänsmütze"] as const;

export const DEFAULT_APPEARANCE: Appearance = { body: 0, coat: 0, hair: 1, skin: 0, hat: 0, glasses: false, gloves: false };

/** The words of the command, German and English, and how many choices each has (booleans: ja/nein). */
const KEYS: Array<{ key: keyof Appearance; words: string[]; count?: number }> = [
	{ key: "body", words: ["figur", "figure", "typ"], count: FIGURES.length },
	{ key: "coat", words: ["farbe", "color", "colour", "kleidung"], count: COATS.length },
	{ key: "hair", words: ["haar", "haare", "hair"], count: HAIRS.length },
	{ key: "skin", words: ["haut", "skin"], count: SKINS.length },
	{ key: "hat", words: ["hut", "hat"], count: HATS.length },
	{ key: "glasses", words: ["brille", "glasses"] },
	{ key: "gloves", words: ["handschuhe", "gloves"] },
];
const YES = new Set(["ja", "yes", "an", "on", "1"]), NO = new Set(["nein", "no", "aus", "off", "0"]);

/** True when `v` is a well-formed appearance (every index in range, nothing else in it). */
export function isAppearance(v: unknown): v is Appearance {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	if (Object.keys(o).length !== KEYS.length) return false;
	return KEYS.every(({ key, count }) => count === undefined ? typeof o[key] === "boolean" : Number.isInteger(o[key]) && (o[key] as number) >= 0 && (o[key] as number) < count);
}

/** Reads `figur 2 farbe 3 haar 1 haut 2 hut 0 brille ja handschuhe nein` (numbers count from 1, any subset, in any
 *  order) on top of `base`. Returns the new appearance, or why the line is not one. */
export function parseAppearance(line: string, base: Appearance = DEFAULT_APPEARANCE): Appearance | { error: string } {
	const words = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length || words.length % 2) return { error: "So geht es: avatar figur 1 farbe 2 haar 3 haut 1 hut 2 brille ja handschuhe nein" };
	const out: Appearance = { ...base };
	for (let i = 0; i < words.length; i += 2) {
		const def = KEYS.find((k) => k.words.includes(words[i]!)), value = words[i + 1]!;
		if (!def) return { error: `„${words[i]!.slice(0, 20)}“ kenne ich nicht; es gibt figur, farbe, haar, haut, hut, brille und handschuhe.` };
		if (def.count === undefined) {
			if (!YES.has(value) && !NO.has(value)) return { error: `Bei ${def.words[0]} geht ja oder nein.` };
			(out[def.key] as boolean) = YES.has(value);
		} else {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1 || n > def.count) return { error: `Bei ${def.words[0]} geht eine Zahl von 1 bis ${def.count}.` };
			(out[def.key] as number) = n - 1;
		}
	}
	return out;
}

/** The command line that sets `a` (the panel sends it). */
export function appearanceLine(a: Appearance): string {
	return `figur ${a.body + 1} farbe ${a.coat + 1} haar ${a.hair + 1} haut ${a.skin + 1} hut ${a.hat + 1} brille ${a.glasses ? "ja" : "nein"} handschuhe ${a.gloves ? "ja" : "nein"}`;
}

/** In words, for the player: what the figure looks like now. */
export function describeAppearance(a: Appearance): string {
	const extras = [a.hat ? HATS[a.hat] : "", a.glasses ? "Brille" : "", a.gloves ? "Handschuhe" : ""].filter(Boolean);
	return `Figur ${FIGURES[a.body]}, Kleidung ${COATS[a.coat]!.name}, Haar ${HAIRS[a.hair]!.name}, Haut ${SKINS[a.skin]!.name}.${extras.length ? ` Dazu: ${extras.join(", ")}.` : ""}`;
}
