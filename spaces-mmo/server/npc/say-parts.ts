// A trader's long answer in several says (rust/mmo-engine/src/npc/economy.rs say_parts).

/** What one say carries (MAX_SAY of the say command; it cuts the rest). */
export const SAY_MAX = 300;

/** A text longer than one say, cut at spaces into says of at most `max` characters; each part after the first begins
 *  with `lead` (whom it is said to) and "…" (a word longer than a say on its own, which a trade list never has, is cut
 *  by the say command). */
export function sayParts(text: string, max: number, lead = ""): string[] {
	if (text.length <= max) return [text];
	const more = lead ? `${lead} …` : "…";
	const parts: string[] = [];
	let cur = "";
	for (const word of text.split(" ").filter(Boolean)) {
		if (cur && cur !== more && cur.length + 1 + word.length > max) { parts.push(cur); cur = more; }
		cur = cur ? `${cur} ${word}` : word;
	}
	if (cur && cur !== more) parts.push(cur);
	return parts;
}
