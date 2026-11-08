// Hints from what one carries (docs/siedeln.en.md "Hinweise"): what can be made of it now, what is still missing for it,
// and where it goes on from there (corn to the mill and the flour to the bakehouse, a goat into a pen for its milk). The
// world's recipes and steps come with the page (ItemUses), so the hints follow the world and cost the space nothing.
// Pure, so it is tested without a browser. Every text is German with its English in client/i18n/en.ts.
import type { ItemUses, PlanView } from "../shared/frames.ts";

export type Hint = { id: string; text: string; /** the command it suggests, as a button */ line?: string; /** the carried things it is about */ about: string[] };

type Recipe = ItemUses["recipes"][number];
const list = (xs: Array<{ name: string; count: number }>) => xs.map((n) => `${n.count} ${n.name}`).join(", ");
/** The plan's name as one says it ("im Backhaus"), or its key. */
const planName = (plans: PlanView[], key: string) => plans.find((p) => p.key === key)?.name ?? key;

/** The hints for a pack (`carried`: how many of each thing by name), most useful first: what can be made now, then
 *  what needs a tool or a building, what lacks a single piece, and where a thing goes on. `owned`: the plans of the
 *  buildings the player has (no "bau …" for those). */
export function hintsFor(carried: ReadonlyMap<string, number>, uses: ItemUses, plans: PlanView[], owned: ReadonlySet<string> = new Set()): Hint[] {
	const has = (name: string) => carried.get(name) ?? 0;
	const make: Hint[] = [], tool: Hint[] = [], at: Hint[] = [], near: Hint[] = [], steps: Hint[] = [];
	const then = (thing: string) => {
		const next = uses.recipes.filter((r) => r.needs.some((n) => n.name === thing)).slice(0, 2);
		return next.length ? ` Aus ${thing} wird dann ${next.map((r) => (r.at ? `${r.name} (${planName(plans, r.at)})` : r.name)).join(", ")}.` : "";
	};
	for (const r of uses.recipes) {
		const enough = r.needs.every((n) => has(n.name) >= n.count);
		const about = r.needs.map((n) => n.name);
		if (enough && r.at) {
			at.push({ id: `at:${r.key}`, about, text: `Aus ${list(r.needs)} wird ${r.name}: das geht an einem Bau „${planName(plans, r.at)}“${r.tool ? ` mit ${r.tool}` : ""}.${owned.has(r.at) ? "" : ` Gibt es keinen, kann man einen bauen („bau ${r.at}“).`}` });
		} else if (enough && r.tool && !has(r.tool)) {
			const tr = uses.recipes.find((x) => x.name === r.tool);
			tool.push({ id: `tool:${r.key}`, about, text: `Für ${r.name} hast du alles, nur ${r.tool} fehlt dir als Werkzeug.${tr ? ` Das Werkzeug ${r.tool} braucht ${list(tr.needs)}.` : ""}` });
		} else if (enough) {
			make.push({ id: `craft:${r.key}`, about, line: `craft ${r.key}`, text: `Aus ${list(r.needs)} kannst du ${r.name} herstellen („craft ${r.key}“).${then(r.name)}` });
		} else if (!r.at && r.needs.every((n) => has(n.name) > 0)) {
			const short = r.needs.map((n) => ({ name: n.name, count: n.count - has(n.name) })).filter((n) => n.count > 0);
			if (short.length === 1 && short[0]!.count === 1) near.push({ id: `near:${r.key}`, about, text: `Noch 1 ${short[0]!.name}, dann kannst du ${r.name} herstellen.` });
		}
	}
	for (const s of uses.steps ?? []) {
		if (!has(s.from)) continue;
		const where = planName(plans, s.at), build = owned.has(s.at) ? "" : ` Gibt es keinen, kann man einen bauen („bau ${s.at}“).`;
		const text = s.kind === "grind"
			? `Die ${where} mahlt ${s.from} zu ${s.to} („${s.line}“).${build}${then(s.to)}`
			: `${s.from}: gibt ${s.to} in einem Bau „${where}“ („${s.line}“, dann „einsammeln“).${build}${then(s.to)}`;
		steps.push({ id: `step:${s.at}:${s.from}`, about: [s.from], text });
	}
	return [...make, ...tool, ...at, ...near, ...steps];
}
