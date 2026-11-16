// The trusted admin effects of src/data-admin.ts on one named Space of an own store, for rust/phi-host/tests/data_admin.rs:
// one JSON line in, one JSON line out. The clock is the line's `now` (Date.now included); randomness is the seeded stream of
// core-driver.ts, started anew once the Space exists, so generation nonces and mailbox epochs are the same on both sides.
//
//   node --experimental-strip-types --no-warnings test/support/data-admin-driver.ts
//
// In:  {"reset": true, "store": "memory"|"sqlite", "seed": "<text>", "now": n}  a new store with the Space "jobs" (fixed id)
//      {"now": n, "seed": {...}}  one commit that writes a scripted state into the Space (see `seedSpace`)
//      {"now": n, "op": "purgeTasks"|"deletePrincipal"|"startDeletion"|"advanceDeletion", "id", "spaceId", "admin",
//       "template"|"principal", "kind"?, "authorized"?: false, "denyAt"?: n, "authority"?: false}
//      `op` "purgeTasks"/"deletePrincipal" is `execute`; "kind" overrides the kind it is given. `denyAt`: the n-th
//      authorization of this line refuses (counted over every commit the line makes).
//      {"now": n, "fill": n, "prefix": "<id prefix>"}  n purges of nothing (ids prefix-0 ...), to fill the journal
// Out: {"ok": true, "result": ...} or {"ok": false, "error": "<class>", "message": "..."}, with "journal" (the data-admin
//      document of the Space, null if none), "space" (the Space as stored, claims read through their map), "rpcBytes",
//      "reservedBytes".
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { DataAdminController } from "../../src/data-admin.ts";
import * as core from "../../src/core.ts";
import * as claims from "../../src/claims.ts";
import { appendMail, principalId } from "../../src/mailbox.ts";
import { createSpace, snapshotSpace, spaceDoc } from "../../src/spaces.ts";
import { defineDocFamily } from "../../src/store/documents.ts";
import { openOwnMemoryHost, type OwnStoreHost } from "../../src/store/host.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { install, reseed, tick } from "./core-driver.ts";

const SID = "sp-00000000-0000-4000-8000-000000000001", INC = "0a0b0c0d";
const Journal = defineDocFamily<{ commands: Record<string, unknown> }, null>({ kind: "phi-spaces.data-admin", version: 1, initial: () => ({ commands: {} }) });
type P = { peerId: string; agentId?: string };

install();
let host: OwnStoreHost | undefined, dir: string | undefined;
/** The generation of each principal (by principalId), as the seeds issued them. */
const gens = new Map<string, string>();
let calls = 0, denyAt = Infinity, authorized = true, authority = true, clock = 0;
const controller = () => new DataAdminController({
	host: host!, ctx, now: () => clock,
	authorize: async () => { calls++; if (!authorized || calls === denyAt) throw new core.PermissionError("scope revoked"); },
	assertAuthority: async () => { if (!authority) throw new core.PermissionError("not the authority"); },
});

/** A result of a claim or a historical claim: the view of the seed's k-th entry, a principal's id, or the JSON itself. */
function resultOf(s: core.SpaceState, now: number, spec: any, ids: string[]): core.Json {
	if (spec && typeof spec === "object" && !Array.isArray(spec) && "entry" in spec) return (core.list(s, now, { id: ids[spec.entry] ?? "none" })[0] ?? null) as unknown as core.Json;
	if (spec && typeof spec === "object" && !Array.isArray(spec) && "pid" in spec) return principalId(spec.pid);
	return spec ?? null;
}

/** Writes a scripted state, part by part in this order; generations it issues are kept once the commit stands. */
function seedSpace(s: core.SpaceState, now: number, d: any, issued: Map<string, string>): void {
	if (d.profiles) core.setCompletionProfiles(s, d.profiles.map((t: string) => ({ taskType: t, resultTypes: ["Result"], equalFields: ["n"], maxResultCount: 1 })), now);
	for (const r of d.regs ?? []) core.notify(s, now, { type: r.type }, null, core.FOREVER, null, principalId(r.target), undefined, r.consumer);
	const ids: string[] = [];
	for (const w of d.writes ?? []) ids.push(core.write(s, now, { type: w.type, fields: w.fields }, null, core.FOREVER, w.owner ? principalId(w.owner) : undefined).id);
	for (const c of d.claims ?? []) {
		const pid = principalId(c.principal);
		let g = issued.get(pid) ?? gens.get(pid);
		if (!g) { g = claims.issueGeneration(s, now, c.principal).generation; issued.set(pid, g); }
		const a = claims.admit(s, now, { principal: c.principal, generation: g, requestId: c.requestId }, "write", { r: c.requestId }, core.FOREVER, c.bound ?? 8192);
		if (a.kind !== "fresh") continue;
		if (c.state === "done") claims.decide(s, now, a.key, { state: "done", result: resultOf(s, now, c.result, ids) });
		else if (c.state === "cancelled") claims.decide(s, now, a.key, { state: "cancelled" });
	}
	for (const m of d.mail ?? []) appendMail(s, m.principal, { kind: "waiter", eventId: m.eventId, seq: 1, target: principalId(m.principal), handback: null, ...(m.entry === undefined ? {} : { entry: resultOf(s, now, { entry: m.entry }, ids) }) } as core.SpaceEvent, now);
	for (const r of d.restored ?? []) claims.setRestored(s, r.key, { method: "write", argHash: "0".repeat(64), deadline: now, state: "done", result: resultOf(s, now, r.result, ids), decidedAt: now, generation: "g-old", requestId: r.key, principal: r.principal } as claims.ClaimRec);
	for (const q of d.reads ?? []) { if (q.list) core.list(s, now, { type: q.type }); else core.probe(s, now, { type: q.type }, null, q.take === true); }
	if (d.waiter) core.addWaiter(s, now, { template: { type: "Never" }, take: false, target: principalId(d.waiter.principal), timeout: d.waiter.timeout });
	if (d.txn) core.createTxn(s, now, d.txn.lease);
	if (d.incarnation !== undefined) s.incarnation = d.incarnation;
	if (d.authority !== undefined) { if (d.authority === null) delete s.acceptedAuthorityId; else s.acceptedAuthorityId = d.authority; }
	if (d.limits) core.setLimits(s, d.limits, now);
}

const failure = (e: unknown) => ({ ok: false, error: (e as Error).constructor?.name ?? "Error", message: (e as Error).message });

async function run(l: any): Promise<Record<string, unknown>> {
	const admin = controller();
	if (l.fill !== undefined) {
		let last: unknown = null;
		for (let k = 0; k < l.fill; k++) last = await admin.execute(`${l.prefix}-${k}`, "purgeTasks", SID, "admin", { type: "None" });
		return { ok: true, result: core.plain(last as core.Json) };
	}
	if (l.seed !== undefined) {
		const issued = new Map<string, string>();
		await host!.commit(async (tx) => seedSpace(await spaceDoc(tx, SID, clock), clock, l.seed, issued), ctx);
		for (const [k, v] of issued) gens.set(k, v);
		return { ok: true, result: null };
	}
	const input = l.op === "purgeTasks" ? l.template : l.principal;
	switch (l.op) {
		case "purgeTasks": case "deletePrincipal": return { ok: true, result: core.plain(await admin.execute(l.id, l.kind ?? l.op, l.spaceId, l.admin, input) as unknown as core.Json) };
		case "startDeletion": return { ok: true, result: core.plain(await admin.startDeletion(l.id, l.spaceId, l.admin, input) as unknown as core.Json) };
		default: return { ok: true, result: core.plain(await admin.advanceDeletion(l.id, l.spaceId, l.admin, input) as unknown as core.Json) };
	}
}

for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text);
	clock = tick(l);
	if (l.reset) {
		await host?.close(ctx);
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "phi-data-admin-"));
		host = l.store === "sqlite" ? await openSqliteHost(join(dir, "s.sqlite")) : openOwnMemoryHost();
		await host.commit((tx) => createSpace(tx, "jobs", clock, { spaceId: SID, incarnation: INC }), ctx);
		reseed(String(l.seed ?? ""), clock);
		gens.clear();
	}
	calls = 0; denyAt = l.denyAt ?? Infinity; authorized = l.authorized !== false; authority = l.authority !== false;
	let out: Record<string, unknown>;
	try { out = l.reset ? { ok: true, result: null } : await run(l); } catch (e) { out = failure(e); }
	const space = core.plain(((await snapshotSpace(host!, SID, ctx)) ?? null) as unknown as core.Json) as any;
	out.journal = core.plain(((await host!.snapshot(Journal, SID, ctx)) ?? null) as unknown as core.Json);
	out.space = space;
	out.rpcBytes = space?.rpc?.bytes ?? null;
	out.reservedBytes = space?.rpc?.reservedBytes ?? null;
	process.stdout.write(JSON.stringify(out) + "\n");
}
await host?.close(ctx);
if (dir) rmSync(dir, { recursive: true, force: true });
