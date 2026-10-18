// Operator driver for the last phase 3 acceptance run, part A (docs/abnahme/ap3-abnahme.md), on two hosts without the control
// host: a ten-minute partition of a merge replication with concurrent writes, deletes, renewals and expiries (S1); a
// SIGKILL of each daemon that the next start clears by itself (B4); a stopped NetBird agent on the standby (B2); a
// primary/sync journal whose budget runs out (B3). Steps are recorded in <out>/state.json; a rerun continues after the
// last completed step. It changes real hosts: run it only with an explicit go (AGENTS.md).
//   node --experimental-strip-types test/testbed/scenarios/phase3-final.ts <config.json>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_SPACE, RemoteSpace, OutcomeUnknown, CommitSealedPending, FOREVER, loadFileSigner, socketTransport, core } from "../../../src/index.ts";

type Host = { hostId: string; ssh: string[]; container: string; home: string; service: string; gateIp: string };
type Config = {
	out: string; writeEveryMs: number;
	/** the drop rule on the standby host, against the primary's overlay address */
	partition: { chain: string; sourceIp: string };
	client: { keyFile: string; ownPeerId: string; localAddress: string; control: { host: string; port: number; hostId: string } };
	primary: Host; standby: Host;
	/** primary/sync Spaces: `sync` for process kills and the agent outage, `full` with a small journal budget */
	sync: { alias: string; countType: string }; full: { alias: string; countType: string; entryBytes: number };
	merge: { space: string; lww: string; key: string; set: string; partitionMs: number; stepMs: number };
	netbird: { unit: string; outageMs: number };
};
type Write = { n: number; requestId: string; label: string; status: "confirmed" | "pending" | "resolved"; issuedAt: number; decidedAt?: number; attempts: number; sealedAnswers: number; lastError?: string };
const cfg: Config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
mkdirSync(cfg.out, { recursive: true, mode: 0o700 });
const stateFile = join(cfg.out, "state.json");
const state: { done: Record<string, unknown>; generation?: string; writes: Write[] } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { done: {}, writes: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 1), { mode: 0o600 });
const log = (m: string, d?: unknown) => console.log(new Date().toISOString(), m, d === undefined ? "" : JSON.stringify(d).slice(0, 400));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function sh(h: Host, script: string, o: { allowFail?: boolean; timeoutMs?: number } = {}): string {
	try { return execFileSync("ssh", ["-o", "ConnectTimeout=10", ...h.ssh, "bash -s"], { input: "set -e\n" + script, encoding: "utf8", timeout: o.timeoutMs ?? 120_000, stdio: ["pipe", "pipe", "pipe"] }); }
	catch (e) { if (o.allowFail) return String((e as any).stdout ?? ""); throw new Error(`${h.hostId}: ${String((e as any).stderr ?? e).slice(0, 400)}`); }
}
const node = (h: Host, args: string) => sh(h, `docker exec -i ${h.container} node ${h.home}/federation-host.mjs ${args} ${h.home} </dev/null 2>&1 | grep -v -i -E "warn|trace-warnings"`, { timeoutMs: 300_000 }).trim().split("\n").at(-1)!;
const head = (h: Host, alias: string) => (JSON.parse(node(h, "sync-head")) as any[]).find(x => x.alias === alias);
const check = (cond: boolean, what: string) => { if (!cond) throw new Error("check failed: " + what); log("check", what); };
const mark = (h: Host) => "@" + sh(h, "date +%s").trim();
const journal = (h: Host, since: string, pattern: string) => sh(h, `journalctl -u ${h.service} --since '${since}' --no-pager -o cat | grep -F '${pattern}' || true`, { allowFail: true }).trim();
async function waitFor(h: Host, since: string, pattern: string, timeoutMs = 180_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) { const out = journal(h, since, pattern).split("\n").at(-1)!; if (out) return out; await sleep(3000); }
	throw new Error(`${h.hostId}: no '${pattern}' since ${since}`);
}
const P = cfg.primary, S = cfg.standby;

/** A connected client for one gate and Space (grants from the control host). */
async function client(h: Host, space: string) {
	const signer = loadFileSigner(cfg.client.keyFile), c = cfg.client;
	const ctl = socketTransport({ host: c.control.host, port: c.control.port }, { localAddress: c.localAddress, connectTimeoutMs: 8000 });
	const t = socketTransport({ host: h.gateIp, port: 7421 }, { localAddress: c.localAddress, connectTimeoutMs: 8000 });
	let control: RemoteSpace; control = new RemoteSpace(ctl, { space: CONTROL_SPACE, signer, ownPeerId: c.ownPeerId, expectedGateHostId: c.control.hostId, attempts: 2, grantProvider: () => control.requestGrant() });
	const remote = new RemoteSpace(t, { signer, ownPeerId: c.ownPeerId, expectedGateHostId: h.hostId, attempts: 1, callTimeoutMs: 30_000, grantProvider: () => control.requestGrant(), space });
	await control.authenticate(); await remote.authenticate();
	return { space: remote, close: () => { t.close(); ctl.close(); } };
}
const principal = () => ({ peerId: cfg.client.ownPeerId });

// ---- primary/sync load (as in phase3-partition.ts): one open outcome at a time, retried with the same request ID.
async function attempt(space: RemoteSpace, w: Write) {
	w.attempts++;
	try {
		await space.write({ type: cfg.sync.countType, fields: { label: w.label, n: w.n } }, null, FOREVER, { request: { principal: principal(), generation: state.generation!, requestId: w.requestId } });
		w.status = w.attempts === 1 ? "confirmed" : "resolved"; w.decidedAt = Date.now(); delete w.lastError;
	} catch (e) {
		if (e instanceof CommitSealedPending) w.sealedAnswers++;
		if (!(e instanceof OutcomeUnknown) && !/timed out|ECONN|EHOST|closed|socket|transport/i.test((e as Error).message)) throw e;
		w.status = "pending"; w.lastError = (e as Error).message.slice(0, 120);
	}
	save();
}
async function load(label: string, totalMs: number, events: Array<{ at: number; name: string; run: () => Promise<unknown> }> = []) {
	let c = await client(P, cfg.sync.alias);
	const started = Date.now(), done = new Set<string>(), results: Record<string, unknown> = {};
	try {
		while (Date.now() - started < totalMs || state.writes.some(w => w.status === "pending")) {
			for (const e of events) if (!done.has(e.name) && Date.now() - started >= e.at) { done.add(e.name); log("event", e.name); results[e.name] = await e.run(); results[e.name + "At"] = Date.now() - started; }
			const open = state.writes.find(w => w.status === "pending");
			try {
				if (open) await attempt(c.space, open);
				else if (Date.now() - started < totalMs) { const w: Write = { n: state.writes.length, requestId: `w-${state.writes.length}`, label, status: "pending", issuedAt: Date.now(), attempts: 0, sealedAnswers: 0 }; state.writes.push(w); await attempt(c.space, w); }
			} catch (e) { if (!/Unauthenticated|closed|ECONN/i.test((e as Error).message)) throw e; }
			// A restarted primary drops the session: reconnect.
			if (state.writes.some(w => w.status === "pending" && /ECONN|closed|socket|Unauthenticated/i.test(w.lastError ?? ""))) { c.close(); try { c = await client(P, cfg.sync.alias); } catch { /* not back yet */ } }
			if (Date.now() - started > totalMs + 600_000) throw new Error("pending writes did not resolve within 10 minutes after the phase");
			await sleep(cfg.writeEveryMs);
		}
	} finally { c.close(); }
	const mine = state.writes.filter(w => w.label === label);
	return { label, writes: mine.length, confirmed: mine.filter(w => w.status === "confirmed").length, resolved: mine.filter(w => w.status === "resolved").length,
		sealedAnswers: mine.reduce((n, w) => n + w.sealedAnswers, 0), longestOpenMs: Math.max(0, ...mine.filter(w => w.status === "resolved").map(w => w.decidedAt! - w.issuedAt)), events: results };
}
async function lossless(labels: string[]) {
	const c = await client(P, cfg.sync.alias);
	try {
		const items = await c.space.readAll({ type: cfg.sync.countType });
		const seen = new Map<string, number>(); for (const e of items as any[]) { const k = `${e.fields.label}/${e.fields.n}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
		const decided = state.writes.filter(w => labels.includes(w.label) && w.status !== "pending");
		const missing = decided.filter(w => seen.get(`${w.label}/${w.n}`) !== 1).map(w => `${w.label}/${w.n}`), extra = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
		check(!missing.length && !extra.length, `every decided write exactly once (${decided.length}; missing ${missing.join(",") || "none"}, duplicates ${extra.join(",") || "none"})`);
		return { decided: decided.length, entries: items.length };
	} finally { c.close(); }
}
const sameHeads = (alias: string) => { const a = head(P, alias), b = head(S, alias); check(a.head.hash === b.head.hash && a.applied === a.head.revision, `${alias}: primary and standby journal heads equal, nothing unresolved`); return a.head; };
const dropRule = `iifname "wt0" ip saddr ${cfg.partition.sourceIp} counter drop comment "phi-spaces-partition"`;
const cut = async () => { sh(S, `nft insert rule inet ${cfg.partition.chain} ${dropRule}`); return { cut: true }; };
const heal = async () => { const out = sh(S, `nft -a list chain inet ${cfg.partition.chain} | grep phi-spaces-partition || true`); const handle = out.match(/handle (\d+)/)?.[1], packets = out.match(/packets (\d+)/)?.[1]; if (handle) sh(S, `nft delete rule inet ${cfg.partition.chain} handle ${handle}`); return { healed: !!handle, droppedPackets: Number(packets ?? 0) }; };
/** SIGKILL of the daemon only. No operator step: the next start must clear the lock itself. */
async function kill(h: Host) {
	const lock = JSON.parse(sh(h, `docker exec ${h.container} cat ${h.home}/owner.lock`)), since = mark(h);
	check(typeof lock.startTime === "string" && typeof lock.bootId === "string", `${h.hostId}: the lock carries boot ID and start time`);
	sh(h, `docker exec ${h.container} sh -c 'kill -9 ${lock.pid}'`);
	const cleared = await waitFor(h, since, "staleOwnerLockCleared"), ready = await waitFor(h, since, '"ready":true');
	check(/"reason":"processGone"/.test(cleared), `${h.hostId}: the restarted daemon cleared the lock of its killed predecessor itself (same boot)`);
	return { killed: lock.pid, cleared: JSON.parse(cleared.slice(cleared.indexOf("{"))), ready: ready.slice(0, 120) };
}

// ---- merge (S1): every scenario writes through the gates; ids are the visible versions.
type MergeClient = Awaited<ReturnType<typeof client>>;
const mergeView = async (c: MergeClient) => {
	const lww = (await c.space.readAll({ type: cfg.merge.lww })).map((e: any) => ({ id: e.id, fields: e.fields, expires: e.expires })).sort((a, b) => a.id < b.id ? -1 : 1);
	const set = (await c.space.readAll({ type: cfg.merge.set })).map((e: any) => ({ id: e.id, fields: e.fields })).sort((a, b) => a.id < b.id ? -1 : 1);
	return { lww, set };
};
const lwwOf = async (c: MergeClient, key: string) => (await c.space.read({ type: cfg.merge.lww, fields: { [cfg.merge.key]: key } }, core.NO_WAIT) as any);
const retry = async <T>(what: string, f: () => Promise<T>): Promise<T> => { for (let n = 0; ; n++) { try { return await f(); } catch (e) { if (n >= 5) throw new Error(`${what}: ${(e as Error).message}`); await sleep(3000); } } };

const steps: Array<[string, () => Promise<unknown>]> = [
	["preflight", async () => {
		const bundles = [P, S].map(h => sh(h, `sha256sum /var/lib/phi-spaces/${h.home.split("/").pop()}/federation-host.mjs | cut -c1-16`).trim());
		check(bundles[0] === bundles[1], `same daemon bundle on both hosts (${bundles[0]})`);
		for (const alias of [cfg.sync.alias, cfg.full.alias]) { const a = head(P, alias), b = head(S, alias); check(a.head.hash === b.head.hash && a.config.primaryReplica === P.hostId, `${alias}: both replicas agree and the primary leads`); }
		const c = await client(P, cfg.sync.alias); try { state.generation = (await c.space.requestGeneration()).generation; } finally { c.close(); } save();
		return { bundle: bundles[0] };
	}],
	["merge-partition", async () => {
		const a = await client(P, cfg.merge.space), b = await client(S, cfg.merge.space), m = cfg.merge, k = (s: string) => ({ [m.key]: s });
		const converged = async (what: string, timeoutMs: number) => { const end = Date.now() + timeoutMs; for (;;) { const [x, y] = [await mergeView(a), await mergeView(b)]; if (JSON.stringify(x) === JSON.stringify(y)) return x; if (Date.now() > end) throw new Error(`no convergence ${what}: ${JSON.stringify({ x, y }).slice(0, 600)}`); await sleep(5000); } };
		try {
			// Before the cut: a set tag both sides see (for remove vs. renew) and an lww key for the old-put case.
			const tag = await a.space.write({ type: m.set, fields: { name: "t0" } }, null, FOREVER) as any;
			await a.space.write({ type: m.lww, fields: { ...k("ver"), v: 1 } }, null, FOREVER);
			await converged("before the cut", 120_000);
			const t0 = Date.now(), at = (ms: number) => sleep(Math.max(0, t0 + ms - Date.now()));
			await cut();
			const events: unknown[] = [];
			const ev = (name: string, v: unknown) => { events.push({ at: Date.now() - t0, name, v }); log("merge", { name }); };
			// Concurrent writes on a shared key and on own keys, the whole partition long.
			const background = (async () => { for (let n = 0; Date.now() - t0 < m.partitionMs - 30_000; n++) {
				await retry("background a", () => a.space.write({ type: m.lww, fields: { ...k("shared"), by: "a", n } }, null, FOREVER)); await retry("background b", () => b.space.write({ type: m.lww, fields: { ...k("shared"), by: "b", n } }, null, FOREVER));
				await retry("own a", () => a.space.write({ type: m.lww, fields: { ...k(`a-${n % 5}`), n } }, null, FOREVER)); await retry("own b", () => b.space.write({ type: m.set, fields: { name: `b-${n}` } }, null, FOREVER));
				await sleep(m.stepMs);
			} })();
			// An older put of b against a later delete of a: the tombstone wins, the put does not come back.
			await at(20_000); const own = await a.space.write({ type: m.lww, fields: { ...k("tomb"), by: "a" } }, null, FOREVER) as any; ev("a puts tomb", own.id);
			await at(30_000); ev("b puts tomb (older than the delete)", (await b.space.write({ type: m.lww, fields: { ...k("tomb"), by: "b" } }, null, FOREVER) as any).id);
			await at(60_000); await a.space.cancel((await lwwOf(a, "tomb")).id); ev("a deletes tomb", true);
			// A renewal before the expiry of the first version: natural expiry does not remove it.
			await at(70_000); const short = await a.space.write({ type: m.lww, fields: { ...k("renewed"), by: "a" } }, null, 120_000) as any; ev("a puts renewed (2 min)", short.id);
			// b: a winner with a deadline over an older forever version: after its expiry neither is visible.
			await at(80_000); ev("b puts ver v2 (2 min)", (await b.space.write({ type: m.lww, fields: { ...k("ver"), v: 2 } }, null, 120_000) as any).id);
			// Remove against renew of the same tag: add-wins, the renewal stays.
			await at(90_000); await a.space.cancel(tag.id); ev("a removes t0", true);
			await at(100_000); const renewedTag = await b.space.renew(tag.id, FOREVER); ev("b renews t0", renewedTag);
			await at(150_000); const r = (await lwwOf(a, "renewed")); await a.space.renew(r.id, 1_800_000); ev("a renews renewed (30 min)", true);
			await at(m.partitionMs); await background; const healed = await heal(); ev("heal", healed);
			const view = await converged("after healing", 300_000);
			const has = (key: string) => view.lww.find((e: any) => e.fields[m.key] === key);
			check(!has("tomb"), "an older put does not revive the tombstone");
			check(!!has("renewed") && has("renewed")!.expires > Date.now() + 600_000, "natural expiry did not remove the newer renewal");
			check(!has("ver"), "after the winner expired, the older forever version stays invisible");
			check(!view.set.some((e: any) => e.id === tag.id) && view.set.filter((e: any) => e.fields.name === "t0").length === 1, "remove against renew: the renewal of t0 stays (add-wins), the old tag does not");
			check(!!has("shared"), "the shared key converged to one version on both sides");
			return { partitionMs: Date.now() - t0, healed, events, view: { lww: view.lww.length, set: view.set.length, shared: has("shared")!.fields } };
		} finally { a.close(); b.close(); }
	}],
	["kill-standby", async () => { const r = await load("kill-standby", 120_000, [{ at: 20_000, name: "kill", run: () => kill(S) }]); return { ...r, heads: sameHeads(cfg.sync.alias), lossless: await lossless(["kill-standby"]) }; }],
	["kill-primary", async () => { const r = await load("kill-primary", 120_000, [{ at: 20_000, name: "kill", run: () => kill(P) }]); return { ...r, heads: sameHeads(cfg.sync.alias), lossless: await lossless(["kill-standby", "kill-primary"]) }; }],
	// The standby's NetBird agent goes away and comes back by itself (a transient unit; ssh to it does not use the overlay).
	["netbird-outage", async () => {
		const since = mark(S), seconds = Math.round(cfg.netbird.outageMs / 1000);
		const outage = async () => { sh(S, `systemd-run --unit=phi-spaces-nb-outage-$(date +%s) --collect sh -c 'systemctl stop ${cfg.netbird.unit}; sleep ${seconds}; systemctl start ${cfg.netbird.unit}'`); return { stoppedForS: seconds }; };
		const r = await load("netbird-outage", cfg.netbird.outageMs + 180_000, [{ at: 20_000, name: "agent-stop", run: outage }]);
		check(sh(S, `systemctl is-active ${cfg.netbird.unit}`).trim() === "active", "the agent is back");
		check(r.sealedAnswers > 0 && r.resolved > 0, "without the standby's overlay a write was sealed, and it resolved once the agent was back");
		// The standby's listeners on its overlay address: did the daemon keep running, and does its gate answer again?
		const restarts = journal(S, since, '"ready":true').split("\n").filter(Boolean).length, errors = journal(S, since, "Error").split("\n").filter(Boolean).slice(-5);
		const gate = await retry("standby gate", async () => { const c = await client(S, "default"); try { return (await c.space.info()).primaryEpoch; } finally { c.close(); } });
		return { ...r, heads: sameHeads(cfg.sync.alias), lossless: await lossless(["kill-standby", "kill-primary", "netbird-outage"]), standbyDaemonRestarts: restarts, standbyErrors: errors, standbyGateEpoch: gate };
	}],
	["journal-full", async () => {
		const c = await client(P, cfg.full.alias), pad = "x".repeat(cfg.full.entryBytes);
		try {
			let n = 0, refused: unknown;
			for (; n < 2000 && !refused; n++) await c.space.write({ type: cfg.full.countType, fields: { n, pad } }, null, FOREVER).catch(e => { refused = e; });
			check(refused instanceof core.ResourceExhausted && /journal/.test((refused as Error).message), `the full journal refused with ResourceExhausted (${String(refused).slice(0, 120)})`);
			const counted = await c.space.count({ type: cfg.full.countType });
			check(counted === n - 1, "reads are still served after the refusal");
			const heads = sameHeads(cfg.full.alias);
			const other = await client(P, cfg.sync.alias); try { await other.space.write({ type: cfg.sync.countType, fields: { label: "after-full", n: 0 } }, null, FOREVER); } finally { other.close(); }
			return { writes: n - 1, refusal: String(refused).slice(0, 200), counted, heads, otherSpaceWritable: true };
		} finally { c.close(); }
	}],
];
try {
	for (const [name, run] of steps) {
		if (name in state.done) { log("skip (done)", name); continue; }
		log("step", name); state.done[name] = await run(); save(); log("done", state.done[name]);
	}
	log("PASSED"); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: true, steps: state.done, writes: state.writes }, null, 1));
} catch (e) { log("FAILED", (e as Error).message); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: false, error: (e as Error).message, steps: state.done, writes: state.writes }, null, 1)); process.exitCode = 1; }
