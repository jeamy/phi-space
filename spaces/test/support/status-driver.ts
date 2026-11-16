// MemberStatusDirectory (src/capability-directory.ts) over scripted probes, for rust/phi-host/tests/member_status.rs: each reply carries
// the routing and the directory entries of the control Space, so both sides can be held against each other.
//
//   node --experimental-strip-types --no-warnings test/support/status-driver.ts
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { createSpace, spaceDoc, snapshotSpace } from "../../src/spaces.ts";
import { FederationRouting } from "../../src/federation-policy.ts";
import { MemberStatusDirectory } from "../../src/capability-directory.ts";
import * as core from "../../src/core.ts";

type Line = Record<string, any>;
const SPACE = "sp-00000000-0000-4000-8000-000000000001";
const host = openOwnMemoryHost();
await host.commit((tx) => createSpace(tx, "control", 1000, { spaceId: SPACE, incarnation: "0a0b0c0d" }), ctx);
let clock = 10_000, plan: any[] = [], authority: boolean[] = [];
const routing = (edit: (d: any) => void) => host.commit(async (tx) => { edit(await tx.doc(FederationRouting, SPACE, null)); }, ctx);
const directory = new MemberStatusDirectory({ host, ctx, controlSpaceId: SPACE, now: () => clock,
	assertAuthority: async () => { if (authority.shift() === false) throw new Error("no authority"); },
	probe: async (id) => {
		const next = plan.shift() ?? {};
		clock += next.takes ?? 0;
		if (next.moves) await routing((d) => { d.members[id].target.primaryEpoch += 1; });
		if (next.leaves) await routing((d) => { delete d.members[id]; });
		if (next.fails) throw new Error("no answer");
		return { revision: next.revision ?? 5, free: next.free ?? null, lag: next.lag ?? null };
	} });
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	if (l.routing) await routing((d) => { Object.assign(d, l.routing); });
	if (l.capability) await host.commit(async (tx) => { const s = await spaceDoc(tx, SPACE, clock); core.write(s, clock, { type: "Capability", fields: l.capability }, null, 120_000); }, ctx);
	clock += l.tick ?? 0;
	plan = l.plan ?? []; authority = l.authority ?? [];
	let refused: string | null = null;
	if (l.refresh) try { await directory.refresh(); } catch (e) { refused = (e as Error).message; }
	const state = await snapshotSpace(host, SPACE, ctx), now = clock;
	const entries = state!.entries.filter((e: any) => ["MemberStatus", "Capability"].includes(e.type) && e.expires > now).map((e: any) => [e.type, e.fields, e.expires]);
	console.log(JSON.stringify({ refused, routing: (await host.snapshot(FederationRouting, SPACE, ctx)) ?? { members: {} }, entries }));
}
