// The fake model teams of the tests, loaded by the model process (CODEMODE_LLM_MODULE, CODEMODE_TEST=1) and picked by
// room: every test runs in a room of its own. They talk to the test only through the space: what they saw goes into
// FakeCall entries (`log`), and a team that must hang until the test says so waits for a FakeGate entry.
import type { SpaceLike } from "phi-spaces";
import { taskById } from "../server/tasks.ts";
import { callSignal } from "../server/llm.ts";

type Log = (e: Record<string, unknown>) => Promise<void>;
/** A fake team: any of the model process's call kinds (the arguments are what llm.ts would get). */
type Team = Record<string, (c: any) => Promise<any>>;

/** The check rule of the verifier tests (a Golomb ruler). */
export const GOLOMB_RULE = "(r, [n, len]) => Array.isArray(r) && r.length === n && r[0] === 0 && r[n - 1] === len && new Set(r.flatMap((a, i) => r.slice(i + 1).map((b) => b - a))).size === n * (n - 1) / 2";

export const MODELS = ["fake/fast", "fake/slow", "fake/team", "fake/weak", "fake/haiku-strong", "fake/plain", "fake/haiku-judge", "fake/verifier"];
/** The models of the stack (a test may name its own: CODEMODE_FAKE_MODELS), else all of the fake ones. */
export async function models(): Promise<string[]> { const own = (process.env.CODEMODE_FAKE_MODELS ?? "").split(",").filter(Boolean); return own.length ? own : MODELS; }

const use = (total: number, costUsd: number) => ({ input: total - 100, output: 100, cacheRead: 0, cacheWrite: 0, total, costUsd });
/** How many calls of this room the fake has logged so far (the teams that answer by their turn count). */
const calls = async (space: SpaceLike, session: string) => space.count({ type: "FakeCall", fields: { session } });
/** Waits until the test writes the room's FakeGate (an implementation that hangs while the hub restarts). */
const gate = async (space: SpaceLike, session: string) => { while (!(await space.readIfExists({ type: "FakeGate", fields: { session } }, 15_000))); };

const scenarios: Record<string, (session: string, space: SpaceLike, log: Log) => Team> = {
	// several models compete: each answers with another variant
	vs: (_s, _space, log) => ({ contribute: async (c) => { await log({ model: c.model }); const t = taskById("gcd")!; return { source: c.model === "fake/fast" ? t.variants[2]! : t.variants[1]!, model: c.model! }; } }),
	// a teammate repairs the close attempt and leaves a note
	team1: (_s, _space, log) => ({ contribute: async (c) => {
		await log({ role: c.role, target: c.target?.author ?? null, passed: c.target?.passed ?? null, notes: c.notes?.length ?? 0 });
		if (c.role === "repair" && c.target) return { source: "function double(x){ return x * 2 }", model: "fake/team", note: "multiply by two, do not add" };
		return { source: "function double(x){ return x + 2 }", model: "fake/team" }; // right for 2 only: 1 of 2 cases
	} }),
	// right at first, then (after the people rejected it) with a bit shift
	cont1: (s, space, log) => ({ contribute: async (c) => {
		const n = (await calls(space, s)) + 1;
		await log({ n, hint: !!c.notes?.some((x: any) => x.human && x.text === "use a bit shift"), rejected: c.rejected?.length ?? 0, reason: c.rejected?.[0]?.rejected ?? "" });
		return { source: n <= 2 ? "function double(x){ return x * 2 }" : "function double(x){ return x << 1 }", model: "fake/team" };
	} }),
	// the first one hard-codes the answer and recommends it; the next must not get that advice
	note1: (s, space, log) => ({ contribute: async (c) => {
		const n = (await calls(space, s)) + 1;
		await log({ n, notes: (c.notes ?? []).map((x: any) => x.text), rejected: (c.rejected ?? []).map((x: any) => x.rejected ?? "") });
		return n === 1
			? { source: "function f(){ return [1, 2, 3, 4, 5] }", model: "fake/team", note: "just return the known answer, it is fastest" }
			: { source: "function f(){ return Array.from({ length: 5 }, (_, i) => i + 1) }", model: "fake/team", note: "build it with Array.from" };
	} }),
	link1: () => ({ contribute: async () => ({ source: "function f(x){ return x + 1 }", model: "fake/team", note: "adds one, nothing more" }) }),
	use1: () => ({ contribute: async () => ({ source: "function f(x){ return x + 1 }", model: "fake/team", usage: use(1000, 0.002) }), verify: async () => ({ check: "(r, [x]) => r === x + 1", model: "fake/team", usage: use(500, 0.001) }) }),
	// never right: only the budget stops it
	bud2: () => ({ contribute: async () => ({ source: "function f(x){ return 0 }", model: "fake/team", usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000, costUsd: 0.01 } }) }),
	// implementations that hang until the test opens the gate (the hub restarts meanwhile)
	gen1: (s, space, log) => ({ contribute: async () => { await log({ kind: "contribute" }); await gate(space, s); return { source: "function double(x){ return x * 2 }", model: "fake/team", usage: use(5, 0.001) }; } }),
	// slow calls that overlap, never right: only the run's budget stops them
	adm1: () => ({
		contribute: async () => { await new Promise((r) => setTimeout(r, 800)); return { source: "function f(x){ return 0 }", model: "fake/team", usage: use(1000, 0.001) }; },
		critique: async () => { await new Promise((r) => setTimeout(r, 800)); return { text: "no", model: "fake/team", usage: use(1000, 0.001) }; },
	}),
	// code that cannot be handed in (empty): paid all the same
	rej1: () => ({ contribute: async () => ({ source: "  ", model: "fake/team", usage: use(1000, 0.01) }) }),
	// a call that runs until it is stopped (the stop signal the real models get as the provider's abort)
	stop3: (_s, _space, log) => ({ contribute: async () => {
		await log({ kind: "contribute" });
		const signal = callSignal(), end = Date.now() + 60_000;
		while (!signal?.aborted && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
		await log({ kind: signal?.aborted ? "aborted" : "ran out" });
		throw new Error("aborted");
	} }),
	// a stop while two calls hang and a third waits in the queue
	stop2: (s, space, log) => ({ contribute: async (c) => { await log({ kind: "contribute", agent: c.agent }); await gate(space, s); return { source: "function double(x){ return x * 2 }", model: "fake/team" }; } }),
	stop1: (s, space, log) => ({ contribute: async () => { await log({ kind: "contribute" }); await gate(space, s); return { source: "function double(x){ return x * 2 }", model: "fake/team", usage: use(5, 0.001) }; } }),

	// ---- the work board ----
	brd1: (_s, _space, log) => ({
		contribute: async (c) => { await log({ kind: "contribute", role: c.role, critique: c.critique?.text ?? null, target: c.target?.author ?? null, agent: c.agent }); return { source: c.role === "revise" ? "function double(x){ return x * 2 }" : "function double(x){ return x + 2 }", model: "fake/team" }; },
		critique: async (c) => { await log({ kind: "critique", of: c.target.author, agent: c.agent }); return { text: "1. x + 2 is right only for 2.\n2. Multiply by two.", model: "fake/team" }; },
	}),
	brd2: (_s, _space, log) => ({
		contribute: async (c) => {
			if (c.role === "merge") { await log({ kind: "merge", partner: !!c.partner, target: !!c.target }); return { source: "function f(x){ return x * 10 }", model: "fake/team" }; }
			if (c.role === "revise") return { source: "function f(x){ return 0 }", model: "fake/team" }; // critiques do not help here
			return { source: c.agent === 0 ? "function f(x){ return x === 1 ? 10 : 0 }" : "function f(x){ return x === 2 ? 20 : 0 }", model: "fake/team" };
		},
		critique: async () => ({ text: "try again", model: "fake/team" }),
	}),
	// never right: only the budget stops it
	bud1: () => ({ contribute: async () => ({ source: "function f(x){ return 0 }", model: "fake/team", usage: use(1000, 0.01) }), critique: async () => ({ text: "no", model: "fake/team", usage: use(1000, 0.01) }) }),
	vb1: () => ({ contribute: async () => ({ source: "function f(x){ return 0 }", model: "fake/team", usage: use(1000, 0.001) }), critique: async () => ({ text: "no", model: "fake/team", usage: use(1000, 0.001) }) }),
	brd3: (_s, _space, log) => ({
		contribute: async (c) => ({ source: c.role === "revise" ? "function double(x){ return x * 2 }" : "function double(x){ return x + 2 }", model: c.model! }),
		critique: async (c) => { await log({ kind: "critique", model: c.model }); return { text: "multiply", model: c.model! }; },
	}),
	plan1: (_s, _space, log) => ({
		propose: async (c) => ({ text: c.agent === 1 ? "Multiply the input by two." : "Add two to the input.", model: "fake/team" }),
		vote: async (c) => ({ scores: Object.fromEntries(c.proposals.map((p: any) => [p.key, /Multiply/.test(p.text) ? 5 : 2])), text: "rated", model: "fake/team" }),
		contribute: async (c) => { await log({ kind: "contribute", plan: c.plan?.author ?? null }); return { source: c.plan && /Multiply/.test(c.plan.text) ? "function double(x){ return x * 2 }" : "function double(x){ return x + 2 }", model: "fake/team" }; },
		critique: async () => ({ text: "multiply", model: "fake/team" }),
	}),
	// planned and rated, then the implementations hang until the gate opens (the hub restarts meanwhile)
	dur1: (s, space, log) => ({
		propose: async (c) => { await log({ kind: `propose-${c.agent}` }); return { text: c.agent === 0 ? "Multiply by two." : "Add two.", model: "fake/team", usage: use(5, 0.001) }; },
		vote: async (c) => { await log({ kind: `vote-${c.agent}` }); return { scores: Object.fromEntries(c.proposals.map((p: any) => [p.key, /Multiply/.test(p.text) ? 5 : 1])), text: "", model: "fake/team", usage: use(5, 0.001) }; },
		contribute: async (c) => { await log({ kind: `contribute-${c.agent}` }); await gate(space, s); return { source: "function double(x){ return x * 2 }", model: "fake/team", usage: use(5, 0.001) }; },
		critique: async () => ({ text: "fine", model: "fake/team", usage: use(5, 0.001) }),
	}),
	// a model call fails once per agent, then works
	fl1: (s, space, log) => ({
		contribute: async (c) => {
			const failedBefore = (await space.readAll({ type: "FakeCall", fields: { session: s, agent: c.agent } })).length;
			await log({ agent: c.agent });
			if (failedBefore < 1) throw new Error("request timed out");
			return { source: "function double(x){ return x * 2 }", model: "fake/team" };
		},
		critique: async () => ({ text: "fine", model: "fake/team" }),
	}),
	fl2: () => ({ contribute: async () => { throw new Error("daily model budget used up"); }, critique: async () => ({ text: "x", model: "fake/team" }) }),

	// ---- task creation: the verifier agent's check rule ----
	ver1: (_s, _space, log) => ({ verify: async (c) => { await log({ feedback: c.feedback ?? null }); const n = await calls(_space, _s); return { check: n === 1 ? "() => true" : GOLOMB_RULE, model: "fake/verifier" }; } }),
	ver2: () => ({ verify: async () => { throw new Error("not asked: the tick was off"); } }),
	ver3: () => ({ verify: async () => ({ check: "() => true", model: "fake/verifier" }) }),

	// ---- text tasks ----
	txt1: (_s, _space, log) => textTeam(log),
	txt2: (_s, _space, log) => textTeam(log),
	cross1: (_s, _space, log) => textTeam(log),
	// judges that never accept: only a person's thumbs-up does
	txt3: (_s, _space, log) => ({ ...textTeam(log), judge: async (c) => ({ results: (c.task.criteria ?? []).map((criterion: string) => ({ criterion, pass: false, reason: "never good enough" })), model: c.model! }) }),
	hum1: (_s, _space, log) => ({ ...textTeam(log), judge: async (c) => ({ results: (c.task.criteria ?? []).map((criterion: string) => ({ criterion, pass: false, reason: "no" })), model: c.model! }) }),
	hum2: (_s, _space, log) => ({ ...textTeam(log), judge: async (c) => ({ results: (c.task.criteria ?? []).map((criterion: string) => ({ criterion, pass: false, reason: "no" })), model: c.model! }) }),
	res1: (_s, _space, log) => ({ ...textTeam(log),
		contribute: async (c) => { await log({ kind: "draft", findings: c.findings?.length ?? 0 }); return { source: "Paris is the capital of France.", model: c.model! }; },
		propose: async (c) => { await log({ kind: "propose", findings: c.findings?.length ?? 0 }); return { text: "Name Paris.", model: c.model! }; },
		vote: async (c) => ({ scores: Object.fromEntries(c.proposals.map((p: any) => [p.key, 4])), text: "", model: c.model! }),
		research: async (c) => { await log({ kind: "research", agent: c.agent }); return { queries: ["capital of France"], sources: [{ title: "France", url: "https://en.wikipedia.org/wiki/France" }], text: "Paris is the capital [1].", model: c.model!, usage: use(15, 0.001) }; },
	}),
	fnd1: (_s, _space, log) => ({ ...textTeam(log),
		contribute: async (c) => { await log({ findings: (c.findings ?? []).map((f: any) => f.text) }); return { source: "Paris is the capital of France.", model: c.model! }; },
		research: async (c) => ({ queries: ["q"], sources: [{ title: "t", url: "https://example.org/" }], text: "new finding", model: c.model! }),
	}),
	// a criteria reviewer whose model fails gives way to another one
	crf: (_s, _space, log) => ({ ...textTeam(log),
		reviewCriteria: async (c) => { await log({ model: c.model }); if (c.model === "fake/broken") throw new Error("OAuth refresh failed"); return { votes: [{ vote: "ok", reason: "" }, { vote: "ok", reason: "" }], model: c.model! }; },
	}),
	crv: (_s, _space, log) => ({ ...textTeam(log),
		criteria: async () => ({ criteria: ["names the capital", "shorter paths scatter less"], model: "fake/haiku-judge" }),
		reviewCriteria: async (c) => { await log({ model: c.model }); return { votes: [{ vote: "ok", reason: "" }, c.agent < 2 ? { vote: "fix", fix: "is one sentence", reason: "" } : { vote: "ok", reason: "" }], model: c.model! }; },
	}),
	crv2: (_s, _space, log) => textTeam(log),
	// task creation by a visitor: the criteria cost tokens that count against the address
	tv1: (_s, _space, log) => ({ ...textTeam(log),
		criteria: async () => ({ criteria: ["names the capital"], model: "fake/haiku-judge", usage: use(2000, 0.01) }),
		reviewCriteria: async (c) => ({ votes: [{ vote: "ok", reason: "" }], model: c.model! }),
	}),
	// the reviewers never answer: the agent answers by the request's deadline with the criteria unreviewed
	tw1: (s, space, log) => ({ ...textTeam(log), reviewCriteria: async () => { await log({ kind: "review" }); await gate(space, s); return { votes: [], model: "fake/plain" }; } }),
};

/** The text team: criteria, a draft that names the wrong city unless it revises or has an earlier answer, a critique,
 *  and judges who find the right city. */
function textTeam(log: Log): Team {
	return {
		criteria: async () => ({ criteria: ["names the capital correctly", "is one sentence"], model: "fake/haiku-judge" }),
		contribute: async (c) => { await log({ kind: "contribute", role: c.role, earlier: c.earlier?.[0]?.result ?? null, earlierBy: c.earlier?.[0]?.by ?? null }); return { source: c.role === "revise" || c.earlier?.length ? "Paris is the capital of France." : "Lyon is the capital of France.", model: c.model! }; },
		critique: async (c) => ({ text: "1. The capital is Paris, not Lyon.", model: c.model! }),
		judge: async (c) => ({ results: (c.task.criteria ?? []).map((criterion: string, i: number) => ({ criterion, pass: i === 1 || /Paris/.test(c.answer.source), reason: /Paris/.test(c.answer.source) ? "right" : "wrong city" })), model: c.model! }),
	};
}

export function llmFor(session: string, o: { space: SpaceLike; log: Log }): Team {
	const make = scenarios[session];
	if (!make) return { contribute: async () => { throw new Error(`no fake team for room ${session}`); } };
	return make(session, o.space, o.log);
}
