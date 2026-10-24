// The agents' work when a task is created (a TaskRequest from the web process): the verifier agent writes a check rule
// for a custom task, or the criteria of a text task and three agents review them. The model calls go to the model
// process; the cross-check of a rule runs in this process's sandbox. The answer is a TaskReady entry, written in the
// same transaction that takes the request.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { plain, sandboxSlot, testRule, type Codemode } from "./judge.ts";
import { addUsage, clipWords, NO_USAGE, tallyCriteria, type CriterionVote, type Usage } from "./llm.ts";
import { callModel } from "./run.ts";
import { taskWaitMs } from "./limits.ts";
import { customSpec, customTask, expectedOf, taskFromSpec, textSpec, textTask, type Task } from "./tasks.ts";

/** What the web process asks for: `verify` a custom task (spec), `criteria` for a text task (its question). */
export type TaskRequest = { requestId: string; session: string; kind: "verify" | "criteria"; task: Record<string, unknown>; client?: { ip: string; admin: boolean };
	/** By when the web process wants the answer: no model call is asked for after it, the agent answers with what it has. */
	deadline?: number; ts: number };
/** The answer: the task to open (its spec, with the rule or the criteria), the line for the block, the calls' usage. */
export type TaskReady = { requestId: string; session: string; ok: boolean; task?: Record<string, unknown>; verdict?: string | null; usage?: Usage; error?: string; ts: number };

/** The request's deadline (one from before deadlines: its time plus the usual wait). */
export const deadlineOf = (req: TaskRequest) => req.deadline ?? req.ts + taskWaitMs();

const call = (req: TaskRequest, n: string, kind: "verify" | "criteria" | "reviewCriteria", task: Task, more: Record<string, unknown> = {}) =>
	({ callId: `${req.requestId}-${n}`, session: req.session, kind, agent: 0, gen: 0, lang: "en" as const, task: task.kind === "text" ? { taskId: "text", text: textSpec(task) } : { taskId: "custom", custom: customSpec(task) }, ...(req.client ? { client: req.client } : {}), ts: Date.now(), ...more });

/** The verifier agent writes a check rule from the description and the examples; the rule must pass testRule (accept
 *  every example result, reject obvious wrong ones) before it decides anything, else the agent tries again with the
 *  reason (three tries). When no rule passes, the examples stay the exact oracle. */
export async function verifyTask(space: SpaceLike, txn: string, cm: Codemode, req: TaskRequest): Promise<Omit<TaskReady, "requestId" | "session" | "ts">> {
	const task = taskFromSpec(req.task);
	if (!task) return { ok: false, error: "Unknown task" };
	let usage = NO_USAGE, feedback: string | undefined;
	if (!task.cases.every((c) => expectedOf(c).length)) return { ok: true, task: req.task, verdict: "No check rule: the verifier needs an expected result in every case", usage };
	for (let attempt = 0; attempt < 3; attempt++) {
		const r = await callModel(space, txn, call(req, `v${attempt}`, "verify", task, feedback ? { feedback } : {}), deadlineOf(req));
		if (r.usage) usage = addUsage(usage, r.usage); // a failed call was paid too
		if (!r.ok || !r.value) { feedback = plain(r.error ?? "verifier failed"); if (/off|budget|not allowed|no time left|did not answer in time/.test(feedback)) break; continue; }
		const v = r.value as { check: string; model: string; usage?: Usage };
		if (v.usage) usage = addUsage(usage, v.usage);
		const why = await sandboxSlot(() => testRule(cm, task, v.check, expectedOf));
		if (why === null) return { ok: true, task: { taskId: "custom", custom: customSpec(customTask({ ...customSpec(task), check: v.check, checkBy: "verifier" })) }, verdict: `Check rule written by the verifier agent (${v.model}): other right results count too`, usage };
		feedback = why;
	}
	return { ok: true, task: req.task, verdict: `No check rule (${feedback ?? "verifier failed"}): results must match the examples`, usage };
}

/** A text task without criteria: the verifier agent writes them, then three agents review them and the majority keeps,
 *  corrects or drops each (a wrong fact in a criterion misleads every judge). A model that fails gives way to the next
 *  one, at most six tries. */
export async function writeCriteria(space: SpaceLike, txn: string, req: TaskRequest, models: string[]): Promise<Omit<TaskReady, "requestId" | "session" | "ts">> {
	let task = taskFromSpec(req.task);
	if (!task) return { ok: false, error: "Unknown task" };
	const until = deadlineOf(req);
	const c = await callModel(space, txn, call(req, "c", "criteria", task), until);
	if (!c.ok || !c.value) return { ok: false, error: c.error ?? "the criteria agent failed", ...(c.usage ? { usage: c.usage } : {}) };
	const cv = c.value as { criteria: string[]; model: string; usage?: Usage };
	if (cv.criteria.length < 1) return { ok: false, error: "The criteria agent wrote no criteria; please write some" };
	task = textTask({ prompt: task.prompt.en, criteria: cv.criteria, criteriaBy: "verifier" });
	let verdict = `Criteria written by the verifier agent (${cv.model})`, usage = cv.usage ?? NO_USAGE;
	const order = [...models.filter((m) => m !== cv.model), ...models.filter((m) => m === cv.model)];
	const reviews: Array<{ votes: CriterionVote[]; model: string }> = [], failed = new Set<string>();
	for (let tries = 0; reviews.length < 3 && tries < 6 && Date.now() < until; ) {
		const left = order.filter((m) => !failed.has(m));
		if (!left.length) break;
		const batch = await Promise.all(Array.from({ length: 3 - reviews.length }, (_, i) => {
			const n = tries++, model = left[(reviews.length + i) % left.length]!;
			return callModel(space, txn, call(req, `r${n}`, "reviewCriteria", task!, { agent: reviews.length + i, model }), until).then((r) => ({ r, model }));
		}));
		for (const { r, model } of batch) {
			if (r.ok && r.value) { const v = r.value as { votes: CriterionVote[]; model: string; usage?: Usage }; reviews.push(v); if (v.usage) usage = addUsage(usage, v.usage); }
			else {
				if (r.usage) usage = addUsage(usage, r.usage);
				if (Date.now() < until) { failed.add(model); console.error("[criteria] review failed", r.error); }
			}
		}
	}
	if (reviews.length === 3) {
		const t = tallyCriteria(task.criteria ?? [], reviews.map((r) => r.votes));
		if (t.changes.length) task = textTask({ prompt: task.prompt.en, criteria: t.criteria, criteriaBy: "verifier" });
		verdict += `; reviewed by 3 agents (${reviews.map((r) => r.model).join(", ")}), the majority decides: ` + (t.changes.length ? t.changes.map((x) => `C${x.index + 1} ${x.to ? `corrected (${x.votes} of 3): "${clipWords(x.from, 160)}" → "${clipWords(x.to, 160)}"` : `dropped (${x.votes} of 3): "${clipWords(x.from, 160)}"`}`).join("; ") : "all kept");
	} else verdict += Date.now() >= until ? "; no time was left for the review by 3 agents, the criteria stay unreviewed" : "; the review by 3 agents failed, the criteria stay unreviewed";
	return { ok: true, task: { taskId: "text", text: textSpec(task) }, verdict, usage };
}

export { NO_WAIT };
