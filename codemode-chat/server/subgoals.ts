// The subgoals of a plan (docs/codemode-planung.en.md, step 4): the rooms and conditions a bot passes on its way, as
// data. An agent writes them with its plan: on the work board in the planning round (run.ts `propose`, from the model's
// ```subgoals block), in a generation's turn before it writes the bot (the same call, or a scripted plan of the task).
//
//   Subgoals { session, blockId, runId, proposalId, author, via, subgoals, ts }: one per plan; the plan is the
//            CodeProposal with the same proposalId, a contribution follows it when its lineage names it.
//
// The bot reads them with `subgoals()` (no points); the judge hands them to the arena with a sample episode's first seed,
// and the arena marks each where the figure reached it, in turn (spaces-mmo/server/arena.ts, `path`). A hidden episode
// is played without them: it keeps no subgoals.
import { NO_WAIT, type SpaceLike } from "phi-spaces";

/** A subgoal: in `room` (any room when there is none), within 3 cells of `near`, and `holds` true: a goal as the arena
 *  scores it (`beacon:<id>`, `feed:<id>:<n>`) or `pack:<proto>` (the figure carries one). */
export type Subgoal = { room?: string; near?: { x: number; y: number }; holds?: string };
/** As the arena takes them (spaces-mmo/server/arena.ts MAX_SUBGOALS). */
export const MAX_SUBGOALS = 12;
const PREDICATE = /^(?:beacon:[\w-]+|feed:[\w-]+:\d+|pack:[\w-]+)$/;
const ROOM = /^[\w-]{1,60}$/;

/** A list of subgoals checked as the arena checks them, or why not. */
export function checkSubgoals(x: unknown): { ok: true; subgoals: Subgoal[] } | { ok: false; error: string } {
	if (!Array.isArray(x)) return { ok: false, error: "subgoals are a list" };
	if (!x.length || x.length > MAX_SUBGOALS) return { ok: false, error: `1 to ${MAX_SUBGOALS} subgoals` };
	const out: Subgoal[] = [];
	for (const [n, g] of x.entries()) {
		const o = (g && typeof g === "object" && !Array.isArray(g) ? g : null) as Record<string, unknown> | null, what = `subgoal ${n + 1}`;
		if (!o) return { ok: false, error: `${what} is no object` };
		const sg: Subgoal = {};
		if (o.room !== undefined) { if (typeof o.room !== "string" || !ROOM.test(o.room)) return { ok: false, error: `${what}: room is a room id` }; sg.room = o.room; }
		if (o.near !== undefined) {
			const c = (o.near && typeof o.near === "object" ? o.near : {}) as Record<string, unknown>;
			if (!sg.room || !Number.isInteger(c.x) || !Number.isInteger(c.y) || Number(c.x) < 0 || Number(c.y) < 0 || Number(c.x) > 99 || Number(c.y) > 99) return { ok: false, error: `${what}: near needs a room and whole cells` };
			sg.near = { x: Number(c.x), y: Number(c.y) };
		}
		if (o.holds !== undefined) { if (typeof o.holds !== "string" || !PREDICATE.test(o.holds)) return { ok: false, error: `${what}: holds is beacon:<id>, feed:<id>:<n> or pack:<proto>` }; sg.holds = o.holds; }
		if (!sg.room && !sg.holds) return { ok: false, error: `${what} names no room and no predicate` };
		out.push(sg);
	}
	return { ok: true, subgoals: out };
}

/** The ```subgoals block of a model's answer (a JSON list), if it has a valid one; and the text without it. */
export function extractSubgoals(text: string): { subgoals?: Subgoal[]; text: string } {
	const m = /```subgoals\s*\n([\s\S]*?)```/i.exec(text);
	if (!m) return { text };
	const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
	try {
		const c = checkSubgoals(JSON.parse(m[1]!));
		return c.ok ? { subgoals: c.subgoals, text: rest } : { text: rest };
	} catch { return { text: rest }; }
}

/** A subgoal in words, for prompts, critiques and the page. */
export const subgoalText = (g: Subgoal): string => [g.room ? `in ${g.room}` : "", g.near ? `near ${g.near.x},${g.near.y}` : "", g.holds ? `${g.holds} holds` : ""].filter(Boolean).join(", ");

// ---- in the space ---------------------------------------------------------------------------------------------
type Store = Pick<SpaceLike, "readIfExists" | "write">;
export type SubgoalsFields = { session: string; blockId: string; runId: string; proposalId: string; author: string; via: string; subgoals: Subgoal[]; ts: number };

export async function writeSubgoals(space: Store, txn: string | null, ttl: number, f: Omit<SubgoalsFields, "ts">): Promise<void> {
	await space.write({ type: "Subgoals", fields: { ...f, ts: Date.now() } as never }, txn, ttl);
}

/** The subgoals of the plan a contribution follows; none when it follows no plan or the plan named none. */
export async function subgoalsOf(space: Pick<SpaceLike, "readIfExists">, session: string, proposalId: string | undefined): Promise<Subgoal[]> {
	if (!proposalId) return [];
	const e = await space.readIfExists({ type: "Subgoals", fields: { session, proposalId } }, NO_WAIT);
	const c = checkSubgoals((e?.fields as { subgoals?: unknown } | undefined)?.subgoals);
	return c.ok ? c.subgoals : [];
}
