// Entry replication as a process (docs/rust-portierung.en.md, R6b step 5): replicas of one EntryReplicationController
// configuration, each on its own store file of one directory, and one JSON line per call, so that
// rust/phi-service/tests/entry_walk.rs runs the same calls through phi_service::entry on a copy and compares every answer
// and in the end every row. The process lives as long as the walk: an exported snapshot is kept in memory, as on a host.
//
//   In:  {"op": "open", "dir": "...", "now": <ms>, "replicas": ["a", ...], "limits": {...}, "setup"?: true}
//        {"op": "call", "replica": "a", "method": "<controller method>", "args": [...], "now": <ms>, "seed": "...",
//         "active"?: false, "uncertainty"?: <ms>}
//        {"op": "reopen", "replica": "a"}: the host anew, as after a restart (the exported snapshots are gone)
//        {"op": "close"}
//   Out: {"ok": true, "result": ...} or {"ok": false, "error": "<class>", "message": "...", "cursor"?: n}
//
// `setup` creates each file with its default Space, so that the Rust side starts from a copy of the same files. A call
// with `active: false` is refused by the replica's check, as a host whose boot record no longer admits the Space.
// Randomness (a snapshot's id) is the seeded stream of core-driver.ts, anew with each line.
import { join } from "node:path";
import { createInterface } from "node:readline";
import { install, reseed, tick } from "./core-driver.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { spaceDoc } from "../../src/spaces.ts";
import { EntryReplicationController } from "../../src/entry-replication.ts";
import { EntryStreamCursorConflict } from "../../src/entry-replication-stream.ts";
import type { ClosableStoreHost } from "../../src/store/types.ts";

install();
class BootBlocked extends Error {}
type Replica = { host: ClosableStoreHost; controller: EntryReplicationController };
type Line = Record<string, any> & { op: string };
let dir = "", names: string[] = [], limits: Record<string, number> = {}, retention = 1000;
const replicas = new Map<string, Replica>();
let active = true, uncertainty = 0, clock = 0;

export const ENTRY_RULES = [{ type: "Sensor", variant: "lww", keyFields: ["sensorId"] }, { type: "Pair", variant: "lww", keyFields: ["a", "b"] }, { type: "Tag", variant: "set" }] as const;
const config = (name: string) => ({ spaceId: "board", authorityId: "authority", replicaId: name, incarnation: `i-${name}`, members: names.map((r) => ({ replicaId: r, incarnation: `i-${r}` })), rules: ENTRY_RULES.map((r) => ({ ...r })) as never });

async function open(name: string): Promise<Replica> {
	const host = await openSqliteHost(join(dir, `${name}.sqlite`));
	const controller = new EntryReplicationController({ host, ctx, config: config(name), ...limits, requestRetentionMs: retention,
		authorize: async () => { if (!active) throw new BootBlocked("entry replica Space is not admitted"); },
		assertActive: async () => { if (!active) throw new BootBlocked("entry replica Space is not admitted"); },
		now: () => clock, clockUncertaintyMs: () => uncertainty });
	return { host, controller };
}

async function step(l: Line): Promise<unknown> {
	switch (l.op) {
		case "open": {
			dir = l.dir; names = l.replicas; limits = l.limits ?? {}; retention = l.retention ?? 1000; clock = tick(l as { now?: number });
			for (const name of names) {
				const r = await open(name);
				if (l.setup) await r.host.commit((tx) => spaceDoc(tx, undefined, clock).then(() => {}), ctx);
				replicas.set(name, r);
			}
			return null;
		}
		case "call": {
			clock = tick(l as { now?: number }); reseed(l.seed ?? "", clock); active = l.active !== false; uncertainty = l.uncertainty ?? 0;
			const c = replicas.get(l.replica)!.controller as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
			if (typeof c[l.method] !== "function") throw new Error(`no method ${l.method}`);
			const out = await c[l.method]!.apply(c, l.args ?? []);
			return out === undefined ? null : out;
		}
		case "reopen": {
			const r = replicas.get(l.replica)!;
			await r.host.close(ctx);
			replicas.set(l.replica, await open(l.replica));
			return null;
		}
		case "close": {
			for (const r of replicas.values()) await r.host.close(ctx);
			replicas.clear();
			return null;
		}
	}
	throw new Error(`unknown op ${l.op}`);
}

const lines = createInterface({ input: process.stdin });
for await (const text of lines) {
	let reply: unknown;
	try { reply = { ok: true, result: await step(JSON.parse(text)) }; }
	catch (e) {
		const err = e as Error;
		reply = { ok: false, error: err?.constructor?.name ?? "Error", message: err?.message ?? String(e), ...(e instanceof EntryStreamCursorConflict ? { cursor: e.cursor } : {}) };
	}
	process.stdout.write(JSON.stringify(reply) + "\n");
}
