// RunController (src/run-controller.ts) over scripted Members, for rust/phi-host/tests/run_controller.rs: the Members are real
// in-memory Spaces with a gated profile, so every ACK and recovery view is genuine; a `plan` adds faults per Member call. Each
// reply carries the Member calls made and the run-controller journal, so both sides can be held against each other.
//
//   node --experimental-strip-types --no-warnings test/support/run-controller-driver.ts
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { createSpace, spaceDoc } from "../../src/spaces.ts";
import { RunController, RunJournal, localRunMember, runCommands, type RunIdentity, type RunMember } from "../../src/run-controller.ts";
import * as core from "../../src/core.ts";

type Line = Record<string, any>;
/** The Members: `[spaceId, incarnation]`; the walk names them by their Space IDs. */
export const MEMBERS: Array<[string, string]> = [
	["sp-00000000-0000-4000-8000-00000000000a", "0000000a"],
	["sp-00000000-0000-4000-8000-00000000000b", "0000000b"],
	["sp-00000000-0000-4000-8000-00000000000c", "0000000c"],
];
const JOB_PROFILE: core.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" };
const DEFAULT_IDENTITY: RunIdentity = { authorityId: "authority", incarnation: "control-1" };
let clock = 0, plan: any[] = [], sent: unknown[] = [], identity: RunIdentity | undefined = DEFAULT_IDENTITY;
let control = openOwnMemoryHost(), data = openOwnMemoryHost();

async function open(): Promise<void> {
	control = openOwnMemoryHost(); data = openOwnMemoryHost();
	for (const [i, [spaceId, incarnation]] of MEMBERS.entries()) {
		await data.commit((tx) => createSpace(tx, `m${i}`, clock, { spaceId, incarnation }), ctx);
		await data.commit(async (tx) => { core.setCompletionProfiles(await spaceDoc(tx, spaceId, clock), [JOB_PROFILE], clock); }, ctx);
	}
	identity = DEFAULT_IDENTITY;
}
/** The next scripted fault of this line: a thrown transport error (`{throw: message}`, `{underRecovery: id}` name their own), a refusal (`refuse`), or a change to the genuine answer. */
const fault = (runId: string) => {
	const next = plan.shift();
	if (next === "throw") throw new Error("the line broke");
	if (next === "underRecovery") throw new Error(`run ${runId} is under recovery rec-1; only its decision applies`);
	if (next === "refuse") throw new core.RunGateConflict("the Member refuses"); // a refusal with its class, as the wire keeps it
	if (typeof next?.underRecovery === "string") throw new Error(`run ${runId} is under recovery ${next.underRecovery}; only its decision applies`);
	if (typeof next?.throw === "string") throw new Error(next.throw);
	return next;
};
const alter = <T extends { spaceId: string | null; incarnation: string | null }>(next: unknown, v: T): T => {
	if (next === "wrongSpace") v.spaceId = "other";
	if (next === "tuple") v.incarnation = "ffffffff";
	return v;
};
const member = (spaceId: string): RunMember => {
	const m = localRunMember(data, ctx, spaceId, async () => {}, () => clock);
	return {
		spaceId,
		prepare: async (run, c) => { sent.push([spaceId, "prepare", c, run]); const next = fault(c.runId); return alter(next, await m.prepare(run, c)); },
		gate: async (c) => { sent.push([spaceId, "gate", c]); const next = fault(c.runId); return alter(next, await m.gate(c)); },
		recover: async (runId, recoveryId) => { sent.push([spaceId, "recover", { runId, recoveryId }]); const next = fault(runId); return alter(next, await m.recover(runId, recoveryId)); },
	};
};
/** `identity: false` in a line: a host without a control identity. */
const controller = () => new RunController({ host: control, ctx, member, now: () => clock, ...(identity ? { identity: async () => identity! } : {}) });

await open();
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	if (l.reset) { await open(); console.log("{}"); continue; }
	if (typeof l.now === "number") clock = l.now;
	if ("identity" in l) identity = l.identity === false ? undefined : l.identity;
	if (!l.op) { console.log("{}"); continue; }
	plan = l.plan ?? []; sent = [];
	const runs = controller();
	let out: Record<string, unknown>;
	try {
		const result = l.op === "advance" ? await runs.advance(l.runId) : l.op === "pending" ? await runs.pending() : await runCommands(runs)[l.op as "startRun"](l.id, l.args ?? {});
		out = { ok: true, result };
	} catch (e) { out = { ok: false, error: (e as Error).constructor.name, message: (e as Error).message }; }
	console.log(JSON.stringify({ ...out, sent, journal: (await control.snapshot(RunJournal, ctx)) ?? null }));
}
