// Operator driver for the last phase 3 acceptance run, part B (docs/ap3-abnahme.md): writes routed by the native Root
// on the control host to a primary/sync Member (B1) through a partition, a fork answered NotCommitted after promotion,
// the way back with setStandby while the Root runs, and degradeToSingle without a fencing adapter (B5) with its way
// back. Each routed write has its own request ID; an open outcome is retried with the same ID until it is decided.
// Steps are recorded in <out>/state.json; a rerun continues after the last completed step. It changes real hosts:
// run it only with an explicit go (AGENTS.md).
//   node --experimental-strip-types test/testbed/scenarios/phase3-final-root.ts <config.json>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_SPACE, RemoteSpace, TlsRecoveryRegister, TlsFencing, loadFileSigner, readmitSpace, releaseHostToQuarantine, socketTransport } from "../../../src/index.ts";

type Host = { hostId: string; ssh: string[]; container: string; home: string; service: string; gateIp: string; syncDir: string };
type Config = {
	out: string; alias: string; type: string; writeEveryMs: number;
	/** the routed Member (for the fork's transaction) */
	member: string;
	partition: { chain: string; sourceIp: string };
	/** the acceptance hook of the Root's daemon on the control host (accept.sh on the jump host) */
	accept: { ssh: string[]; script: string };
	controlBundle: { ssh: string[]; container: string; path: string };
	operator: { register: ConstructorParameters<typeof TlsRecoveryRegister>[0]; fencing: ConstructorParameters<typeof TlsFencing>[0] };
	tool: { controlRegister: unknown; fencing: unknown };
	client: { keyFile: string; ownPeerId: string; localAddress: string; control: { host: string; port: number; hostId: string } };
	primary: Host; standby: Host;
};
type Write = { n: number; requestId: string; label: string; status: "confirmed" | "pending" | "resolved" | "failed"; issuedAt: number; decidedAt?: number; attempts: number; errors: string[]; txn?: unknown };
const cfg: Config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
mkdirSync(cfg.out, { recursive: true, mode: 0o700 });
const stateFile = join(cfg.out, "state.json");
const state: { done: Record<string, unknown>; writes: Write[] } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { done: {}, writes: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 1), { mode: 0o600 });
const log = (m: string, d?: unknown) => console.log(new Date().toISOString(), m, d === undefined ? "" : JSON.stringify(d).slice(0, 400));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const P = cfg.primary, S = cfg.standby;

function run(ssh: string[], script: string, o: { allowFail?: boolean; timeoutMs?: number; input?: string } = {}): string {
	try { return execFileSync("ssh", ["-o", "ConnectTimeout=10", ...ssh, o.input === undefined ? "bash -s" : script], { input: o.input ?? "set -e\n" + script, encoding: "utf8", timeout: o.timeoutMs ?? 120_000, stdio: ["pipe", "pipe", "pipe"] }); }
	catch (e) { if (o.allowFail) return String((e as any).stdout ?? ""); throw new Error(`${ssh.join(" ")}: ${String((e as any).stderr ?? e).slice(0, 400)}`); }
}
const sh = (h: Host, script: string, o: { allowFail?: boolean; timeoutMs?: number } = {}) => run(h.ssh, script, o);
let lastToolOutput = "";
const node = (h: Host, args: string, input?: unknown) => {
	const cmd = `docker exec -i ${h.container} node ${h.home}/federation-host.mjs ${args} ${h.home}`, filter = `2>&1 | grep -v -i -E "warn|trace-warnings"`;
	lastToolOutput = sh(h, input === undefined ? `${cmd} </dev/null ${filter}` : `${cmd} <<'PI_SPACES_JSON' ${filter}\n${JSON.stringify(input)}\nPI_SPACES_JSON`, { timeoutMs: 600_000 }).trim();
	return lastToolOutput.split("\n").at(-1)!;
};
const head = (h: Host) => (JSON.parse(node(h, "sync-head")) as any[]).find(x => x.alias === cfg.alias);
/** The sync tool on a host; a refused transition stays open and pauses writes, so the run stops with the full output. */
const tool = (h: Host, op: Record<string, unknown>) => {
	const r = node(h, "sync", { alias: cfg.alias, ...cfg.tool, ...op });
	try { return JSON.parse(r); } catch { throw new Error(`sync tool ${String(op.op)} on ${h.hostId}: ${lastToolOutput.slice(-1500)}`); }
};
const service = (h: Host, action: "start" | "stop") => sh(h, `systemctl ${action} ${h.service}`, { allowFail: action === "stop" });
const check = (cond: boolean, what: string) => { if (!cond) throw new Error("check failed: " + what); log("check", what); };
const mark = (h: Host) => "@" + sh(h, "date +%s").trim();
async function waitFor(h: Host, since: string, pattern: string, timeoutMs = 180_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) { const out = sh(h, `journalctl -u ${h.service} --since '${since}' --no-pager -o cat | grep -F '${pattern}' | tail -1 || true`, { allowFail: true }).trim(); if (out) return out; await sleep(3000); }
	throw new Error(`${h.hostId}: no '${pattern}' since ${since}`);
}
async function waitSsh(h: Host, timeoutMs = 300_000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { sh(h, "true", { timeoutMs: 15_000 }); return; } catch { await sleep(5000); } } throw new Error(`${h.hostId}: ssh did not return`); }
const sameHeads = () => { const a = head(S.hostId === state.done.primaryNow ? S : P), b = head(S.hostId === state.done.primaryNow ? P : S); check(a.head.hash === b.head.hash && a.applied === a.head.revision, "primary and standby journal heads are equal, nothing unresolved"); return a.head; };

// ---- the Root's acceptance hook
let commandSeq = 0;
function accept(command: Record<string, unknown>): any {
	const out = run(cfg.accept.ssh, `WAIT=60 bash ${cfg.accept.script}`, { input: JSON.stringify({ id: `final-${Date.now()}-${commandSeq++}`, ...command }), allowFail: true, timeoutMs: 200_000 }).trim().split("\n").at(-1) ?? "";
	try { return JSON.parse(out); } catch { return { passed: false, error: `no acceptance answer: ${out.slice(0, 200)}` }; }
}
/** One attempt of a routed write; an undecided outcome stays pending (same request ID next time). */
function attempt(w: Write) {
	w.attempts++;
	const r = accept({ action: "routed-write", type: cfg.type, requestId: w.requestId, fields: { label: w.label, n: w.n }, ...(w.txn ? { txn: w.txn } : {}) });
	if (r.passed) { w.status = w.attempts === 1 ? "confirmed" : "resolved"; w.decidedAt = Date.now(); }
	else { w.errors.push(String(r.error ?? r.timeout ?? "?").slice(0, 160)); if (/needs explicit review|requires explicit review|needs review/.test(String(r.error))) { w.status = "failed"; w.decidedAt = Date.now(); } else w.status = "pending"; }
	save(); return r;
}
const newWrite = (label: string, requestId = `rw-${state.writes.length}`): Write => { const w: Write = { n: state.writes.length, requestId, label, status: "pending", issuedAt: Date.now(), attempts: 0, errors: [] }; state.writes.push(w); save(); return w; };
async function load(label: string, totalMs: number, events: Array<{ at: number; name: string; run: () => Promise<unknown> }> = []) {
	const started = Date.now(), done = new Set<string>(), results: Record<string, unknown> = {};
	while (Date.now() - started < totalMs || state.writes.some(w => w.label === label && w.status === "pending")) {
		for (const e of events) if (!done.has(e.name) && Date.now() - started >= e.at) { done.add(e.name); log("event", e.name); results[e.name] = await e.run(); results[e.name + "At"] = Date.now() - started; }
		const open = state.writes.find(w => w.label === label && w.status === "pending");
		if (open) attempt(open); else if (Date.now() - started < totalMs) attempt(newWrite(label));
		if (Date.now() - started > totalMs + 900_000) throw new Error("routed writes did not resolve within 15 minutes after the phase");
		await sleep(cfg.writeEveryMs);
	}
	const mine = state.writes.filter(w => w.label === label);
	return { label, writes: mine.length, confirmed: mine.filter(w => w.status === "confirmed").length, resolved: mine.filter(w => w.status === "resolved").length, failed: mine.filter(w => w.status === "failed").length,
		longestOpenMs: Math.max(0, ...mine.filter(w => w.status === "resolved").map(w => w.decidedAt! - w.issuedAt)), errors: [...new Set(mine.flatMap(w => w.errors).map(e => e.replace(/[0-9a-f]{8,}/g, "…")))].slice(0, 8), events: results };
}
/** The member's target as the Root holds it. */
const rootTarget = () => { const r = accept({ action: "status" }); if (!r.passed) throw new Error("status: " + r.error); return r.result.members[cfg.member] ?? Object.values<any>(r.result.members)[0]; };
async function waitTarget(hostId: string, version: number, timeoutMs = 300_000) {
	const end = Date.now() + timeoutMs;
	for (;;) { const m = rootTarget(); if (m.target.hostId === hostId && m.replication?.replicaConfigVersion === version) return m; if (Date.now() > end) throw new Error(`Root did not adopt ${hostId}/v${version}: ${JSON.stringify(m).slice(0, 300)}`); await sleep(10_000); }
}

/** Direct admin read on a host's gate (grants from the control host). */
async function readAll(h: Host) {
	const signer = loadFileSigner(cfg.client.keyFile), c = cfg.client;
	const ctl = socketTransport({ host: c.control.host, port: c.control.port }, { localAddress: c.localAddress, connectTimeoutMs: 8000 }), t = socketTransport({ host: h.gateIp, port: 7421 }, { localAddress: c.localAddress, connectTimeoutMs: 8000 });
	let control: RemoteSpace; control = new RemoteSpace(ctl, { space: CONTROL_SPACE, signer, ownPeerId: c.ownPeerId, expectedGateHostId: c.control.hostId, attempts: 2, grantProvider: () => control.requestGrant() });
	const space = new RemoteSpace(t, { space: cfg.alias, signer, ownPeerId: c.ownPeerId, expectedGateHostId: h.hostId, attempts: 1, callTimeoutMs: 30_000, grantProvider: () => control.requestGrant() });
	try { await control.authenticate(); await space.authenticate(); const all: any[] = []; let cursor: string | null = null; do { const p: any = await space.readPage({ type: cfg.type }, { after: cursor }); all.push(...p.items); cursor = p.next; } while (cursor); return all; } finally { t.close(); ctl.close(); }
}
async function lossless(h: Host) {
	const items = await readAll(h), seen = new Map<string, number>();
	for (const e of items) { const k = `${e.fields.label}/${e.fields.n}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
	const decided = state.writes.filter(w => w.status === "confirmed" || w.status === "resolved"), failed = state.writes.filter(w => w.status === "failed");
	const missing = decided.filter(w => seen.get(`${w.label}/${w.n}`) !== 1).map(w => w.requestId), extra = [...seen].filter(([, n]) => n > 1).map(([k]) => k), ghost = failed.filter(w => seen.has(`${w.label}/${w.n}`)).map(w => w.requestId);
	check(!missing.length && !extra.length && !ghost.length, `every decided routed write exactly once, no failed one took effect (${decided.length}; missing ${missing.join(",") || "none"}, duplicates ${extra.join(",") || "none"}, failed with effect ${ghost.join(",") || "none"})`);
	return { decided: decided.length, failed: failed.length, entries: items.length };
}
const dropRule = `iifname "wt0" ip saddr ${cfg.partition.sourceIp} counter drop comment "pi-spaces-partition"`;
const cut = async () => { sh(S, `nft insert rule inet ${cfg.partition.chain} ${dropRule}`); return { cut: true }; };
const heal = async () => { const out = sh(S, `nft -a list chain inet ${cfg.partition.chain} | grep pi-spaces-partition || true`); const handle = out.match(/handle (\d+)/)?.[1], packets = out.match(/packets (\d+)/)?.[1]; if (handle) sh(S, `nft delete rule inet ${cfg.partition.chain} handle ${handle}`); return { healed: !!handle, droppedPackets: Number(packets ?? 0) }; };
const stopped = async (h: Host) => { service(h, "stop"); };
const started = async (h: Host) => { const t = mark(h); service(h, "start"); return waitFor(h, t, '"ready":true'); };
const cfgOf = (h: Host) => head(h).config;

const steps: Array<[string, () => Promise<unknown>]> = [
	["preflight", async () => {
		const bundles = [P, S].map(h => sh(h, `sha256sum /var/lib/pi-spaces/${h.home.split("/").pop()}/federation-host.mjs | cut -c1-16`).trim());
		bundles.push(run(cfg.controlBundle.ssh, `docker exec ${cfg.controlBundle.container} sha256sum ${cfg.controlBundle.path} | cut -c1-16`).trim());
		check(new Set(bundles).size === 1, `same daemon bundle on both replicas and the control host (${bundles[0]})`);
		const a = head(P), b = head(S); check(a.head.hash === b.head.hash && a.config.primaryReplica === P.hostId, "both replicas agree and the primary leads");
		const m = rootTarget(); check(m.target.hostId === P.hostId && m.state === "active", "the Root routes the member to the primary");
		return { bundle: bundles[0], member: m };
	}],
	["routed", async () => { const r = await load("routed", 60_000); check(r.confirmed === r.writes, "routed writes confirmed at once"); return { ...r, heads: sameHeads() }; }],
	["routed-partition", async () => {
		const r = await load("partition", 240_000, [{ at: 20_000, name: "cut", run: cut }, { at: 200_000, name: "heal", run: heal }]);
		check(r.resolved > 0 && r.failed === 0, "a routed write stayed open during the cut and was decided with the same request ID after healing");
		return { ...r, heads: sameHeads(), lossless: await lossless(P) };
	}],
	// The fork is a write of a routed transaction: it reuses the transaction's generation, so the commit sealed on the
	// primary alone is the write itself (a plain routed write would first commit a new generation).
	["fork", async () => {
		const begin = accept({ action: "routed-begin", member: cfg.member, requestId: "fork-txn", leaseMs: 60_000 });
		check(begin.passed === true, `routed transaction begun while the standby confirms (${String(begin.error ?? "")})`);
		await stopped(S);
		const w = newWrite("fork", "fork"); w.txn = begin.result.txn; const r = attempt(w);
		const h = head(P); check(w.status === "pending" && h.head.revision === h.applied + 1, "the routed fork write stays a sealed candidate on the primary only");
		const inIntent = sh(P, `python3 -c "import sqlite3;print(sqlite3.connect('${P.syncDir}/journal.sqlite').execute('select intent from sync_intents where revision=${h.head.revision}').fetchone()[0].count('\\"label\\":\\"fork\\"'))"`).trim();
		check(Number(inIntent) > 0, "the sealed candidate is the fork write itself, not a generation");
		return { fork: h.head, txn: begin.result.txn, answer: r };
	}],
	["promote", async () => { await stopped(P); const c = cfgOf(S), r = tool(S, { op: "promote", tid: "final-promote", epoch: c.primaryEpoch, version: c.replicaConfigVersion }); check(r.config?.primaryReplica === S.hostId && r.proof?.evidence?.state === "SHUTOFF", "standby promoted after a verified fence"); return r; }],
	["degrade", async () => { const c = cfgOf(S), r = tool(S, { op: "degrade", tid: "final-degrade", epoch: c.primaryEpoch, version: c.replicaConfigVersion }); check(r.config?.durability === "single", "single after degradeToSingle"); state.done.primaryNow = S.hostId; return r; }],
	["start-new-primary", async () => { const ready = await started(S); const m = await waitTarget(S.hostId, cfgOf(S).replicaConfigVersion); return { ready: ready.slice(0, 120), adopted: m }; }],
	["not-committed", async () => {
		const w = state.writes.find(x => x.requestId === "fork")!;
		for (let n = 0; n < 20 && w.status === "pending"; n++) { attempt(w); if (w.status === "pending") await sleep(15_000); }
		const d = accept({ action: "diagnose", requestId: "fork" });
		check(w.status === "failed" && JSON.stringify(d).includes("NotCommitted"), "the Root resolved the fork step on the promoted primary as NotCommitted (no effect)");
		const forks = (await readAll(S)).filter(e => e.fields.label === "fork").length;
		check(forks === 0, "the fork never took effect");
		return { errors: w.errors, diagnose: d, forkEntries: forks };
	}],
	["routed-single", async () => { const r = await load("single", 30_000); check(r.failed === 0, "routed writes go to the new primary"); return r; }],
	["release", async () => { const reg = new TlsRecoveryRegister(cfg.operator.register), b = await releaseHostToQuarantine(reg, P.hostId, "final-release", new TlsFencing(cfg.operator.fencing)); reg.close(); await waitSsh(P); return { state: b.state }; }],
	["wipe-old", async () => { service(P, "stop"); sh(P, `docker start ${P.container} >/dev/null`); return JSON.parse(node(P, "sync", { op: "wipe", alias: cfg.alias })); }],
	["start-quarantine", async () => { const t = mark(P); service(P, "start"); return { quarantine: await waitFor(P, t, '"quarantine":true') }; }],
	// The way back with the Root running: routed writes go on while the standby is set up and its notice is adopted.
	["set-standby", async () => {
		// The old primary leaves quarantine with set-standby and its quarantine daemon ends; it serves as the standby
		// only after the re-admission and a normal start, so that happens inside the event (writes go on meanwhile).
		const readmit = async () => {
			const reg = new TlsRecoveryRegister(cfg.operator.register), b = (await reg.get<any>("boot:" + P.hostId))!.value, readmitted: string[] = [];
			for (const [id, p] of Object.entries<any>(b.spaces)) if (p.role === "local" && p.state === "revoked") { await readmitSpace(reg, P.hostId, id, { transitionId: "final-readmit", expectedDataIncarnation: p.dataIncarnation }); readmitted.push(id); }
			reg.close(); return readmitted;
		};
		const res = await load("set-standby", 120_000, [{ at: 10_000, name: "set-standby", run: async () => {
			const before = cfgOf(S); let config = before, left: string | null = null;
			if (before.standbyReplica !== P.hostId || before.durability !== "sync") { await stopped(S); const t = mark(P); config = tool(S, { op: "set-standby", tid: "final-standby", target: P.hostId }).config; await started(S); left = await waitFor(P, t, '"leftQuarantine":true'); }
			const readmitted = await readmit(), ready = await started(P);
			return { config, left, readmitted, ready: ready.slice(0, 120) };
		} }]);
		const version = (res.events["set-standby"] as any).config.replicaConfigVersion, m = await waitTarget(S.hostId, version);
		const after = await load("after-standby", 30_000);
		check(res.failed === 0 && after.failed === 0 && after.confirmed + after.resolved === after.writes, "routed writes during and after set-standby are decided without review; the restored standby confirms");
		return { during: res, adopted: m, after, heads: sameHeads() };
	}],
	// B5: the standby (old primary) is lost; degrade without a fencing adapter revokes only its permit for this Space.
	["degrade-revoke", async () => {
		// Repeatable: a candidate and a degrade that already happened are not repeated.
		let w = state.writes.find(x => x.requestId === "revoke-candidate"), candidate: number;
		if (!w) {
			await stopped(P);
			w = newWrite("revoke", "revoke-candidate"); attempt(w);
			const h = head(S); check(w.status === "pending" && h.head.revision === h.applied + 1, "without the standby the routed write is a sealed candidate");
			candidate = h.head.revision; (state.done as any).revokeCandidate = candidate; save();
		} else candidate = (state.done as any).revokeCandidate;
		let r: any;
		if (cfgOf(S).durability === "sync") {
			await stopped(S);
			const c = cfgOf(S); r = tool(S, { op: "degrade", tid: "final-degrade-revoke", epoch: c.primaryEpoch, version: c.replicaConfigVersion, revokeStandbySpace: true, fencing: undefined });
			check(r.config?.durability === "single" && r.recoveredCommitted?.includes(candidate), "degrade without a fencing adapter completed the sealed candidate locally");
		} else r = { config: cfgOf(S), recoveredCommitted: head(S).recoveredCommitted };
		const reg = new TlsRecoveryRegister(cfg.operator.register), b = (await reg.get<any>("boot:" + P.hostId))!.value; reg.close();
		const sid = head(S).config.spaceId;
		check(b.state === "active" && b.spaces[sid].state === "revoked" && Object.entries<any>(b.spaces).filter(([k]) => k !== sid).every(([, p]) => p.state === "active"), "the old primary stays active; only its permit for this Space is revoked");
		await started(S); const m = await waitTarget(S.hostId, r.config.replicaConfigVersion);
		for (let n = 0; n < 20 && w.status === "pending"; n++) { attempt(w); if (w.status === "pending") await sleep(10_000); }
		check(w.status === "resolved", "the routed write of the completed candidate is decided with its original result (resolved at the successor: same host, new epoch)");
		return { degrade: r, adopted: m, write: w };
	}],
	["revoke-way-back", async () => {
		await stopped(P);// (repeatable: a previous attempt may have started it)
		const wipe = JSON.parse(node(P, "sync", { op: "wipe", alias: cfg.alias }));
		const ready = await started(P);// a normal start of the active host: its other Spaces are served, this one only listens
		const res = await load("revoke-back", 120_000, [{ at: 10_000, name: "set-standby", run: async () => { await stopped(S); const r = tool(S, { op: "set-standby", tid: "final-standby-2", target: P.hostId }); await started(S); return { config: r.config }; } }]);
		const m = await waitTarget(S.hostId, (res.events["set-standby"] as any).config.replicaConfigVersion);
		const after = await load("after-revoke", 30_000);
		check(after.failed === 0 && after.confirmed + after.resolved === after.writes, "routed writes are confirmed by the re-admitted standby");
		return { wipe, ready: ready.slice(0, 120), during: res, adopted: m, after, heads: sameHeads(), lossless: await lossless(S) };
	}],
];
try {
	for (const [name, run] of steps) {
		if (name in state.done) { log("skip (done)", name); continue; }
		log("step", name); state.done[name] = await run(); save(); log("done", state.done[name]);
	}
	log("PASSED"); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: true, steps: state.done, writes: state.writes }, null, 1));
} catch (e) { log("FAILED", (e as Error).message); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: false, error: (e as Error).message, steps: state.done, writes: state.writes }, null, 1)); process.exitCode = 1; }
