// The core as a process (docs/rust-portierung.en.md, R1): operations of src/core.ts, src/claims.ts and src/mailbox.ts on
// one SpaceState, one JSON line in, one JSON line out, so another implementation can be held against this one step by
// step (rust/phi-core/tests, the differential tests).
//
//   node --experimental-strip-types --no-warnings test/support/core-driver.ts
//
// In:  {"op": "<name>", "now": <ms>, ...arguments}   (first line: {"op": "init", "seed": "...", "spaceId"?, "incarnation"?})
// Out: {"ok": true, "result": ..., "state": "<sha256>"} or {"ok": false, "error": "<class>", "message": "...", "state": ...};
//      "dump": the whole state as well when the line asked for it ("dump": true), or always with --dump.
//
// Every operation is a commit of its own (core.beginCommit first, as spaces.ts opens a document). The clock is the
// line's `now`, Date.now included (parkOperation and the mailbox ack read it). Randomness is a counter stream from the
// seed: crypto.randomBytes(n) gives the next n bytes of SHA-256("phi-spaces/driver/v1\n<seed>\n<block>") blocks, so
// generation nonces, signing keys and mailbox epochs are the same on both sides.
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as core from "../../src/core.ts";
import * as claims from "../../src/claims.ts";
import * as mailbox from "../../src/mailbox.ts";
import { snapshotPage } from "../../src/snapshot.ts";
import { readChain } from "../../src/read-chain.ts";
import { digestJson } from "../../src/canonical.ts";
import type { Json } from "../../src/core.ts";

let seed = "", block = 0, pool = Buffer.alloc(0);
/** Starts the seeded stream and the clock anew (an init line). */
export function reseed(text: string, now: number): void { seed = text; block = 0; pool = Buffer.alloc(0); clock = now; }
/** The next `n` bytes of the seeded stream. */
export function seeded(n: number): Buffer {
	while (pool.length < n) { pool = Buffer.concat([pool, createHash("sha256").update(`phi-spaces/driver/v1\n${seed}\n${block++}`).digest()]); }
	const out = pool.subarray(0, n); pool = pool.subarray(n);
	return Buffer.from(out);
}
let clock = 0;
/** Sets the clock a line names (Date.now included) and returns the line's now. */
export function tick(l: { now?: number }): number { if (typeof l.now === "number") clock = l.now; return l.now ?? clock; }
const realNow = Date.now;
export function install(): void {
	(crypto as unknown as { randomBytes: (n: number) => Buffer }).randomBytes = (n: number) => seeded(n);
	syncBuiltinESMExports();
	Date.now = () => clock;
}

type Line = Record<string, any> & { op: string; now?: number };
let s: core.SpaceState = core.initialState();
/** The host whose entry snapshots (snapshot.ts) the line `snapshotPage` uses; a new one with every init. */
let host = {};
const opt = <T,>(v: T | undefined, d: T): T => (v === undefined ? d : v);

/** One operation on `s`; its result (the caller makes it plain JSON). `host`: whose entry snapshots it reads. */
export function apply(l: Line, s: core.SpaceState, host: object): unknown {
	const now = l.now ?? clock;
	switch (l.op) {
		// ---- entries, leases, expiry
		case "write": return core.write(s, now, l.entry, opt(l.txn, null), opt(l.lease, core.ANY), l.as);
		case "announce": return core.announce(s, now, l.entry, opt(l.txn, null), l.as);
		case "probe": { const p = core.probe(s, now, opt(l.tmpl, null), opt(l.txn, null), !!l.take, l.as); return p.status === "found" ? { status: p.status, entry: core.view(p.entry, s.spaceId) } : { status: p.status }; }
		case "count": return core.count(s, now, opt(l.tmpl, null), opt(l.txn, null), l.as);
		case "list": return core.list(s, now, opt(l.tmpl, null), opt(l.txn, null), opt(l.limit, Number.MAX_SAFE_INTEGER), l.as);
		case "listPage": return core.listPage(s, now, opt(l.tmpl, null), opt(l.txn, null), l.o ?? {}, l.as);
		case "snapshotPage": return snapshotPage(host, s, now, opt(l.tmpl, null), l.o ?? {}, l.as);
		case "renew": return core.renew(s, now, l.id, l.ms, l.as);
		case "cancel": core.cancel(s, now, l.id, l.as); return null;
		case "settle": core.settle(s, now); return null;
		case "nextExpiry": return core.nextExpiry(s);
		case "stats": return core.stats(s, now);
		// ---- transactions
		case "createTxn": return core.createTxn(s, now, opt(l.lease, core.ANY), l.as);
		case "commitTxn": core.commitTxn(s, now, l.id, l.as); return null;
		case "abortTxn": core.abortTxn(s, now, l.id, l.as); return null;
		case "releaseTxn": return core.releaseTxn(s, now, l.id);
		case "setLimits": return core.setLimits(s, l.limits, now);
		case "setCompletionProfiles": core.setCompletionProfiles(s, l.profiles, now); return null;
		case "applyRunGate": return core.applyRunGate(s, now, l.command);
		// ---- waiters, subscriptions
		case "addWaiter": return core.addWaiter(s, now, l.w);
		case "cancelWaiter": return core.cancelWaiter(s, l.id, now);
		case "park": core.parkOperation(s, l.key, opt(l.tmpl, null), !!l.take, opt(l.txn, null), l.deadline, !!l.ifExists, l.owner); return null;
		case "notify": return core.notify(s, now, opt(l.tmpl, null), opt(l.txn, null), opt(l.lease, core.ANY), opt(l.handback, null), opt(l.target, null), l.as, l.consumer);
		// ---- stream
		case "changes": return core.changes(s, l.afterRev, l.o ?? {});
		case "revision": return core.revision(s);
		// ---- claims
		case "issueGeneration": return claims.issueGeneration(s, now, l.principal, l.options ?? {});
		case "admit": return claims.admit(s, now, l.request, l.method, l.args, opt(l.deadline, core.FOREVER), opt(l.resultBound, 1024));
		case "decide": claims.decide(s, now, l.key, l.outcome); return null;
		case "lookup": return claims.lookup(s, l.request, now);
		case "cancelRequest": return claims.cancelRequest(s, now, l.target);
		case "pendingClaims": return claims.pendingClaims(s);
		case "resolveAdmission": return claims.resolveAdmission(s, now, l.request, l.method, l.argumentHash, l.primaryEpoch);
		case "needsMaintenance": return core.needsMaintenance(s, now);
		case "readChain": return readChain(s, now, opt(l.tmpl, null), l.o ?? {}, l.as);
		// ---- mailboxes
		case "events": return mailbox.mailboxPage(s, l.principal, now, l.o ?? {});
		case "appendMail": mailbox.appendMail(s, l.principal, l.event, now); return null;
		case "ack": return mailbox.ackMailbox(s, l.principal, l.mailboxEpoch, l.upTo);
		default: throw new TypeError(`core-driver: unknown op ${l.op}`);
	}
}

export type { Line };
export function step(l: Line, dumpAll = false): Record<string, unknown> {
	if (l.op === "init") {
		seed = String(l.seed ?? ""); block = 0; pool = Buffer.alloc(0); clock = l.now ?? 0;
		s = core.initialState();
		host = {};
		if (l.spaceId !== undefined) s.spaceId = l.spaceId;
		if (l.incarnation !== undefined) s.incarnation = l.incarnation;
		if (l.limits) s.limits = l.limits;
		return { ok: true, result: null, state: digestJson(s as unknown as Json), ...(l.dump || dumpAll ? { dump: core.plain(s) } : {}) };
	}
	if (typeof l.now === "number") clock = l.now;
	let out: Record<string, unknown>;
	try {
		core.beginCommit(s);
		out = { ok: true, result: core.plain((apply(l, s, host) ?? null) as Json) };
	} catch (e) {
		out = { ok: false, error: (e as Error).constructor?.name ?? "Error", message: (e as Error).message };
	}
	out.state = digestJson(core.plain(s) as unknown as Json);
	if (l.dump || dumpAll) out.dump = core.plain(s);
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	install();
	const dumpAll = process.argv.includes("--dump");
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const out: string[] = [];
	const flush = () => { if (out.length) { process.stdout.write(out.join("\n") + "\n"); out.length = 0; } };
	rl.on("line", (text) => {
		if (!text.trim()) return;
		let reply: Record<string, unknown>;
		try { reply = step(JSON.parse(text) as Line, dumpAll); } catch (e) { reply = { ok: false, error: "DriverError", message: (e as Error).message }; }
		out.push(JSON.stringify(reply));
		// the lines of one chunk go out together; a caller that writes one line and waits gets its answer at once
		if (out.length === 1) setImmediate(flush);
	});
	rl.on("close", () => { flush(); Date.now = realNow; });
}
