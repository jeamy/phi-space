// The 14 canonical PI-SPACES / HELP color palettes (Dark & Light modes) and WCAG contrast helper.

export interface PaletteModeColors {
	a: string;
	b: string;
	c: string;
	editableInput: string;
	labelWhite: string;
	labelGrey: string;
	iconWhite: string;
	iconGrey: string;
}

export interface ThemePalette {
	id: string;
	label: { de: string; en: string };
	dark: PaletteModeColors;
	light: PaletteModeColors;
}

export const PALETTES: ThemePalette[] = [
	{
		id: "spaces_default",
		label: { de: "PI-SPACES Standard", en: "PI-SPACES Default" },
		dark: { a: "#AED83C", b: "#152B35", c: "#5C8EA0", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#AED83C", b: "#82A8BA", c: "#5C8EA0", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "ocean_pulse",
		label: { de: "Ozean-Puls", en: "Ocean Pulse" },
		dark: { a: "#55A8FF", b: "#1E3531", c: "#8B80F9", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#55A8FF", b: "#7CC8BE", c: "#8B80F9", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "amber_signal",
		label: { de: "Bernstein-Signal", en: "Amber Signal" },
		dark: { a: "#E4AE34", b: "#091F29", c: "#F06292", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#E4AE34", b: "#78B2CA", c: "#F06292", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "raspberry_velvet",
		label: { de: "Himbeer-Samt", en: "Raspberry Velvet" },
		dark: { a: "#B24C70", b: "#251F11", c: "#D577A4", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#9B415F", b: "#B0A180", c: "#C96C96", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "duo_neon",
		label: { de: "Duo-Neon", en: "Duo Neon" },
		dark: { a: "#96E255", b: "#1A270D", c: "#E4529B", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#96E255", b: "#C5E29A", c: "#E4529B", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "infrared_blueprint",
		label: { de: "Infrarot-Blueprint", en: "Infrared Blueprint" },
		dark: { a: "#FF4E64", b: "#161E3F", c: "#39D6FF", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#CF344C", b: "#A9B5E8", c: "#188DAE", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "jade_clay",
		label: { de: "Jade & Ton", en: "Jade Clay" },
		dark: { a: "#35CFA2", b: "#2C2118", c: "#D36A3A", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#238F74", b: "#BFA58E", c: "#B6532E", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "violet_cream",
		label: { de: "Violett-Creme", en: "Violet Cream" },
		dark: { a: "#C084FC", b: "#2B183A", c: "#F4D35E", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#7E4BC2", b: "#CDB9E8", c: "#C08B16", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "pearl_graphite",
		label: { de: "Perle & Graphit", en: "Pearl Graphite" },
		dark: { a: "#E6E0C8", b: "#20242A", c: "#FF5A36", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#655F51", b: "#B8BDC5", c: "#D2432A", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "cobalt_saffron",
		label: { de: "Kobalt & Safran", en: "Cobalt Saffron" },
		dark: { a: "#3B67FF", b: "#241B10", c: "#E7C447", editableInput: "#3B82F6", labelWhite: "#E8EAED", labelGrey: "#969CA3", iconWhite: "#E2E6EA", iconGrey: "#A1A8AF" },
		light: { a: "#254CC9", b: "#C8B58E", c: "#A97912", editableInput: "#2563EB", labelWhite: "#F1F3F5", labelGrey: "#62676D", iconWhite: "#ECEFF2", iconGrey: "#555B62" },
	},
	{
		id: "classic_amber",
		label: { de: "Klassischer Bernstein", en: "Classic Amber" },
		dark: { a: "#F0B33A", b: "#2F2A22", c: "#A86B16", editableInput: "#3B82F6", labelWhite: "#FFF3CC", labelGrey: "#C58A38", iconWhite: "#FFE5A6", iconGrey: "#B77A2B" },
		light: { a: "#B26B00", b: "#D4C7B0", c: "#8C5200", editableInput: "#2563EB", labelWhite: "#FFF0C2", labelGrey: "#7A5A26", iconWhite: "#FFE1A0", iconGrey: "#6A4A1A" },
	},
	{
		id: "jade_mono",
		label: { de: "Jade-Mono", en: "Jade Mono" },
		dark: { a: "#42DCA3", b: "#123247", c: "#2A8A69", editableInput: "#3B82F6", labelWhite: "#D9FFF0", labelGrey: "#83B7A2", iconWhite: "#D0FBEA", iconGrey: "#76A894" },
		light: { a: "#138A61", b: "#A9C8D4", c: "#0F6E50", editableInput: "#2563EB", labelWhite: "#E8FFF5", labelGrey: "#4E7162", iconWhite: "#E0FFF1", iconGrey: "#3E6253" },
	},
	{
		id: "cyan_mono",
		label: { de: "Cyan-Mono", en: "Cyan Mono" },
		dark: { a: "#55D6F2", b: "#18264D", c: "#2D94AA", editableInput: "#3B82F6", labelWhite: "#DDF8FF", labelGrey: "#82B7C4", iconWhite: "#D5F5FF", iconGrey: "#72A7B5" },
		light: { a: "#147E96", b: "#AEBCE6", c: "#0E6578", editableInput: "#2563EB", labelWhite: "#E8FAFF", labelGrey: "#4E6F78", iconWhite: "#E0F7FF", iconGrey: "#3E6069" },
	},
	{
		id: "violet_mono",
		label: { de: "Violett-Mono", en: "Violet Mono" },
		dark: { a: "#B389FF", b: "#3A1729", c: "#7D5AC7", editableInput: "#3B82F6", labelWhite: "#F1E6FF", labelGrey: "#A897C6", iconWhite: "#ECDDFF", iconGrey: "#9683B6" },
		light: { a: "#6E45B8", b: "#D7B6C8", c: "#53308D", editableInput: "#2563EB", labelWhite: "#F6EEFF", labelGrey: "#655474", iconWhite: "#F1E6FF", iconGrey: "#554565" },
	},
];

export function contrastInkForHex(hex: string): "#101010" | "#FFFFFF" {
	const channel = (offset: number) => {
		const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const lum = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
	return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? "#101010" : "#FFFFFF";
}

export function applyThemeToDocument(mode: "dark" | "light", paletteId: string): void {
	const palette = PALETTES.find((p) => p.id === paletteId) ?? PALETTES[0]!;
	const colors = palette[mode];
	const forceWhiteInk = palette.id === "jade_mono" || palette.id === "classic_amber";
	const root = document.documentElement;
	root.dataset.mode = mode;
	root.dataset.palette = palette.id;

	const vars: Record<string, string> = {
		"--color-a": colors.a,
		"--color-b": colors.b,
		"--color-c": colors.c,
		"--editable-input": colors.editableInput,
		"--palette-label-white": colors.labelWhite,
		"--palette-label-grey": colors.labelGrey,
		"--palette-icon-white": colors.iconWhite,
		"--palette-icon-grey": colors.iconGrey,
		"--accent-ink": forceWhiteInk ? "#FFFFFF" : contrastInkForHex(colors.a),
	};
	for (const [k, v] of Object.entries(vars)) {
		root.style.setProperty(k, v);
	}
}
