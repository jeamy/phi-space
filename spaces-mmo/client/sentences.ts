// Where a text of the world breaks into points (client/RichText.tsx).
/** Abbreviations a sentence does not end at. */
const NOT_THE_END = /(?:\b[zud]\.|\bca\.|\bNr\.|\bggf\.|\bbzw\.|\bvgl\.|\bB\.|\ba\.|\bh\.)$/;

/** The sentences of a text, the abbreviations left whole. */
export function sentences(text: string): string[] {
	const out: string[] = [];
	for (const part of text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„])/)) {
		const last = out.at(-1);
		if (last && NOT_THE_END.test(last)) out[out.length - 1] = `${last} ${part}`;
		else out.push(part);
	}
	return out;
}
