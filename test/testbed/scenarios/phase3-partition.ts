// Operator driver for the phase 3.7 run (docs/abnahme/ap3-replikation.md): continuous writes through the gate of a primary/sync
// Space while the overlay between primary and standby is cut (a short and a long partition), process kills of standby
// and primary, then a failover whose sealed fork is answered NotCommitted by the promoted standby, and the way back
// (quarantine, wipe, setStandby). Every write carries its own number and request ID; a sealed or unknown outcome is
// retried with the same ID until it is decided. Steps are recorded in <out>/state.json; a rerun continues after the
// last completed step. It changes real hosts: run it only with an explicit go (AGENTS.md).
//   node --experimental-strip-types test/testbed/scenarios/phase3-partition.ts <config.json>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_SPACE, RemoteSpace, RemoteError, OutcomeUnknown, CommitSealedPending, TlsRecoveryRegister, TlsFencing, FOREVER, loadFileSigner, readmitSpace, releaseHostToQuarantine, socketTransport, claims } from "../../../src/index.ts";

type Host = { hostId: string; ssh: string[]; container: string; home: string; service: string; gateIp: string; syncDir: string };
type Config = {
	out: string; alias: string; countType: string;
	/** partition lengths in ms: a short rehearsal, then the long one (10 minutes) */
	shortPartitionMs: number; partitionMs: number; writeEveryMs: number;
	/** the drop rule on the standby host, against the primary's overlay address */
	partition: { chain: string; sourceIp: string };
	operator: { register: ConstructorParameters<typeof TlsRecoveryRegister>[0]; fencing: ConstructorParameters<typeof TlsFencing>[0] };
	tool: { controlRegister: unknown; fencing: unknown };
	client: { keyFile: string; ownPeerId: string; localAddress: string; control: { host: string; port: number; hostId: string } };
	primary: Host; standby: Host;
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
let lastToolOutput = "";
const node = (h: Host, args: string, input?: unknown) => {
	const run = `docker exec -i ${h.container} node ${h.home}/federation-host.mjs ${args} ${h.home}`, filter = `2>&1 | grep -v -i -E "warn|trace-warnings"`;
	lastToolOutput = sh(h, input === undefined ? `${run} </dev/null ${filter}` : `${run} <<'PHI_SPACES_JSON' ${filter}\n${JSON.stringify(input)}\nPHI_SPACES_JSON`, { timeoutMs: 600_000 }).trim();
	return lastToolOutput.split("\n").at(-1)!;
};
const head = (h: Host) => (JSON.parse(node(h, "sync-head")) as any[]).find(x => x.alias === cfg.alias);
const tool = (op: Record<string, unknown>) => {
	const r = node(cfg.standby, "sync", { alias: cfg.alias, ...cfg.tool, ...op });
	// On a crash the last line is only the runtime banner: keep the whole output for the report.
	try { return JSON.parse(r); } catch { const full = sh(cfg.standby, `journalctl -n 0 >/dev/null 2>&1 || true`, { allowFail: true }); void full; throw new Error(`sync tool ${String(op.op)}: ${lastToolOutput.slice(-1500)}`); }
};
const service = (h: Host, action: "start" | "stop") => sh(h, `systemctl ${action} ${h.service}`, { allowFail: action === "stop" });
async function waitFor(h: Host, since: string, pattern: string, timeoutMs = 180_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const out = sh(h, `journalctl -u ${h.service} --since '${since}' --no-pager -o cat | grep -F '${pattern}' | tail -1 || true`, { allowFail: true }).trim();
		if (out) return out;
		await sleep(3000);
	}
	throw new Error(`${h.hostId}: no '${pattern}' since ${since}`);
}
const mark = (h: Host) => "@" + sh(h, "date +%s").trim();
async function waitSsh(h: Host, timeoutMs = 300_000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { sh(h, "true", { timeoutMs: 15_000 }); return; } catch { await sleep(5000); } } throw new Error(`${h.hostId}: ssh did not return`); }
const check = (cond: boolean, what: string) => { if (!cond) throw new Error("check failed: " + what); log("check", what); };
const P = cfg.primary, S = cfg.standby;

/** A connected client for one gate: the Space and the host's default Space (to show other Spaces stay usable). */
async function client(h: Host) {
	const signer = loadFileSigner(cfg.client.keyFile), c = cfg.client;
	const ctl = socketTransport({ host: c.control.host, port: c.control.port }, { localAddress: c.localAddress, connectTimeoutMs: 8000 });
	const t = socketTransport({ host: h.gateIp, port: 7421 }, { localAddress: c.localAddress, connectTimeoutMs: 8000 }), t2 = socketTransport({ host: h.gateIp, port: 7421 }, { localAddress: c.localAddress, connectTimeoutMs: 8000 });
	let control: RemoteSpace; control = new RemoteSpace(ctl, { space: CONTROL_SPACE, signer, ownPeerId: c.ownPeerId, expectedGateHostId: c.control.hostId, attempts: 2, grantProvider: () => control.requestGrant() });
	const opts = { signer, ownPeerId: c.ownPeerId, expectedGateHostId: h.hostId, attempts: 1, callTimeoutMs: 30_000, grantProvider: () => control.requestGrant() };
	const space = new RemoteSpace(t, { ...opts, space: cfg.alias }), other = new RemoteSpace(t2, { ...opts, space: "default" });
	await control.authenticate(); await space.authenticate(); await other.authenticate();
	return { space, other, close: () => { t.close(); t2.close(); ctl.close(); } };
}
const principal = () => ({ peerId: cfg.client.ownPeerId });
const fieldsOf = (w: Write) => ({ label: w.label, n: w.n });
/** One attempt for a write: confirmed/resolved, or still pending (sealed, unknown, transport). Anything else stops the run. */
async function attempt(space: RemoteSpace, w: Write) {
	w.attempts++;
	try {
		await space.write({ type: cfg.countType, fields: fieldsOf(w) }, null, FOREVER, { request: { principal: principal(), generation: state.generation!, requestId: w.requestId } });
		w.status = w.attempts === 1 ? "confirmed" : "resolved"; w.decidedAt = Date.now(); delete w.lastError;
	} catch (e) {
		if (e instanceof CommitSealedPending) w.sealedAnswers++;
		if (!(e instanceof OutcomeUnknown) && !/timed out|ECONN|EHOST|closed|socket|transport/i.test((e as Error).message)) throw e;
		w.status = "pending"; w.lastError = (e as Error).message.slice(0, 120);
	}
	save();
}
/**
 * Writes every `writeEveryMs` on the primary for `totalMs`; a pending write is retried (same ID) before a new one is
 * issued, so at most one outcome is open. `events` run at their offsets (partition, heal, kills).
 */
async function load(label: string, totalMs: number, events: Array<{ at: number; name: string; run: () => Promise<unknown> }> = []) {
	const c = await client(P), started = Date.now(), done = new Set<string>(), probes: unknown[] = [], results: Record<string, unknown> = {};
	try {
		while (Date.now() - started < totalMs || state.writes.some(w => w.status === "pending")) {
			for (const e of events) if (!done.has(e.name) && Date.now() - started >= e.at) { done.add(e.name); log("event", e.name); results[e.name] = await e.run(); results[e.name + "At"] = Date.now() - started; }
			const open = state.writes.find(w => w.status === "pending");
			if (open) await attempt(c.space, open);
			else if (Date.now() - started < totalMs) { const w: Write = { n: state.writes.length, requestId: `w-${state.writes.length}`, label, status: "pending", issuedAt: Date.now(), attempts: 0, sealedAnswers: 0 }; state.writes.push(w); await attempt(c.space, w); }
			// While a commit of the Space is sealed: its reads answer CommitSealed, other Spaces of the host keep working.
			if (state.writes.some(w => w.status === "pending") && probes.length < 3) {
				const read = await c.space.count({ type: cfg.countType }).then(v => ({ ok: v }), e => ({ code: e instanceof RemoteError ? e.code : (e as Error).message.slice(0, 80) }));
				const other = await c.other.count(null).then(v => ({ ok: v }), e => ({ error: (e as Error).message.slice(0, 80) }));
				probes.push({ at: Date.now() - started, read, other });
			}
			if (Date.now() - started > totalMs + 600_000) throw new Error("pending writes did not resolve within 10 minutes after the phase");
			await sleep(cfg.writeEveryMs);
		}
	} finally { c.close(); }
	const mine = state.writes.filter(w => w.label === label);
	return { label, writes: mine.length, confirmed: mine.filter(w => w.status === "confirmed").length, resolved: mine.filter(w => w.status === "resolved").length,
		sealedAnswers: mine.reduce((n, w) => n + w.sealedAnswers, 0), longestOpenMs: Math.max(0, ...mine.filter(w => w.status === "resolved").map(w => w.decidedAt! - w.issuedAt)), probes, events: results };
}
/** Every decided write exactly once on the primary; both journal heads equal. */
async function lossless(h: Host, labels: string[]) {
	const c = await client(h);
	try {
		const items = await c.space.readAll({ type: cfg.countType });
		const seen = new Map<string, number>(); for (const e of items as any[]) { const k = `${e.fields.label}/${e.fields.n}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
		const decided = state.writes.filter(w => labels.includes(w.label) && w.status !== "pending");
		const missing = decided.filter(w => seen.get(`${w.label}/${w.n}`) !== 1).map(w => `${w.label}/${w.n}`);
		const extra = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
		check(!missing.length && !extra.length, `every decided write exactly once (${decided.length} writes; missing ${missing.join(",") || "none"}, duplicates ${extra.join(",") || "none"})`);
		return { decided: decided.length, entries: items.length };
	} finally { c.close(); }
}
const sameHeads = () => { const a = head(P), b = head(S); check(a.head.hash === b.head.hash && a.applied === a.head.revision, "primary and standby journal heads are equal, nothing unresolved"); return a.head; };
const dropRule = `iifname "wt0" ip saddr ${cfg.partition.sourceIp} counter drop comment "phi-spaces-partition"`;
const cut = async () => { sh(S, `nft insert rule inet ${cfg.partition.chain} ${dropRule}`); return { cut: true }; };
const heal = async () => { const out = sh(S, `nft -a list chain inet ${cfg.partition.chain} | grep phi-spaces-partition || true`); const handle = out.match(/handle (\d+)/)?.[1], packets = out.match(/packets (\d+)/)?.[1]; if (handle) sh(S, `nft delete rule inet ${cfg.partition.chain} handle ${handle}`); return { healed: !!handle, droppedPackets: Number(packets ?? 0) }; };
/** SIGKILL of the daemon (not the container); the operator step removes the owner lock once the process is gone. */
const kill = async (h: Host) => {
	const pid = JSON.parse(sh(h, `docker exec ${h.container} cat ${h.home}/owner.lock`)).pid;
	// kill and test are shell builtins in the container image, so they run through sh.
	sh(h, `docker exec ${h.container} sh -c 'kill -9 ${pid}; for i in $(seq 1 30); do [ -d /proc/${pid} ] || break; sleep 1; done; [ ! -d /proc/${pid} ] && rm -f ${h.home}/owner.lock'`);
	return { killed: pid };
};
const forkHash = (w: Write) => claims.argHash("write", { entry: { type: cfg.countType, fields: fieldsOf(w) }, txn: null, lease: FOREVER } as never);

const steps: Array<[string, () => Promise<unknown>]> = [
	["preflight", async () => {
		const bundles = [P, S].map(h => sh(h, `sha256sum /var/lib/phi-spaces/${h.home.split("/").pop()}/federation-host.mjs | cut -c1-16`).trim());
		check(bundles[0] === bundles[1], `same daemon bundle on both hosts (${bundles[0]})`);
		const a = head(P), b = head(S); check(a.head.hash === b.head.hash && a.config.primaryReplica === P.hostId, "both replicas agree and the primary leads");
		const c = await client(P); try { state.generation = (await c.space.requestGeneration()).generation; } finally { c.close(); } save();
		return { bundle: bundles[0], head: a.head };
	}],
	["partition-short", async () => { const r = await load("short", cfg.shortPartitionMs + 60_000, [{ at: 20_000, name: "cut", run: cut }, { at: 20_000 + cfg.shortPartitionMs, name: "heal", run: heal }]); check(r.sealedAnswers > 0 && r.resolved > 0, "the partition sealed a write, and it resolved after healing"); return { ...r, heads: sameHeads(), lossless: await lossless(P, ["short"]) }; }],
	["partition-long", async () => { const r = await load("long", cfg.partitionMs + 120_000, [{ at: 60_000, name: "cut", run: cut }, { at: 60_000 + cfg.partitionMs, name: "heal", run: heal }]); check(r.sealedAnswers > 0 && r.resolved > 0, "the long partition sealed a write, and it resolved after healing"); return { ...r, heads: sameHeads(), lossless: await lossless(P, ["short", "long"]) }; }],
	// With the bounded standby wait (f96a7f7) a cut overlay turns the pending commit into CommitSealed within seconds.
	["partition-bounded", async () => {
		const bundles = [P, S].map(h => sh(h, `sha256sum /var/lib/phi-spaces/${h.home.split("/").pop()}/federation-host.mjs | cut -c1-16`).trim());
		check(bundles[0] === bundles[1], `same daemon bundle on both hosts (${bundles[0]})`);
		const r = await load("bounded", 180_000 + 60_000, [{ at: 30_000, name: "cut", run: cut }, { at: 210_000, name: "heal", run: heal }]);
		const first = (r.probes as any[])[0];
		check(r.sealedAnswers > 0 && r.resolved > 0 && first?.read?.code === "CommitSealed" && first?.other?.ok !== undefined, "the cut turned the commit into CommitSealed at once; other Spaces stayed usable; it resolved after healing");
		return { bundle: bundles[0], ...r, heads: sameHeads(), lossless: await lossless(P, ["short", "long", "bounded"]) };
	}],
	["kill-standby", async () => { const r = await load("kill-standby", 120_000, [{ at: 20_000, name: "kill", run: () => kill(S) }]); return { ...r, heads: sameHeads(), lossless: await lossless(P, ["short", "long", "bounded", "kill-standby"]) }; }],
	["kill-primary", async () => { const r = await load("kill-primary", 120_000, [{ at: 20_000, name: "kill", run: () => kill(P) }]); return { ...r, heads: sameHeads(), lossless: await lossless(P, ["short", "long", "bounded", "kill-standby", "kill-primary"]) }; }],
	["fork", async () => {
		// A fresh generation (it admits for an hour; NotCommitted needs it still admitting), issued while the standby confirms.
		const c = await client(P);
		try {
			state.generation = (await c.space.requestGeneration()).generation; save();
			service(S, "stop");
			const w: Write = { n: state.writes.length, requestId: "fork", label: "fork", status: "pending", issuedAt: Date.now(), attempts: 0, sealedAnswers: 0 }; state.writes.push(w); await attempt(c.space, w);
			const h = head(P); check(w.status === "pending" && h.head.revision === h.applied + 1, "the unconfirmed fork write stays a sealed candidate");
			return { fork: h.head, write: w, generation: state.generation };
		} finally { c.close(); }
	}],
	["promote", async () => { service(S, "stop"); const r = tool({ op: "promote", tid: "part-promote", epoch: head(S).config.primaryEpoch, version: head(S).config.replicaConfigVersion }); check(r.config?.primaryReplica === S.hostId && r.proof?.evidence?.state === "SHUTOFF", "standby promoted after a verified fence"); return r; }],
	["degrade", async () => { const r = tool({ op: "degrade", tid: "part-degrade", epoch: head(S).config.primaryEpoch, version: head(S).config.replicaConfigVersion }); check(r.config?.durability === "single", "single durability after degradeToSingle"); return r; }],
	["start-new-primary", async () => { const t = mark(S); service(S, "start"); return { ready: await waitFor(S, t, '"ready":true') }; }],
	["not-committed", async () => {
		const fork = state.writes.find(w => w.requestId === "fork")!, c = await client(S);
		try {
			const target = { generation: (state.done.fork as any).generation as string, requestId: fork.requestId };
			const v = await c.space.resolveOperation(target, "write", forkHash(fork), 1) as any;
			check(v.state === "done" && v.error?.code === "NotCommitted", "the fork sealed only on the fenced primary is NotCommitted");
			const late = await c.space.write({ type: cfg.countType, fields: fieldsOf(fork) }, null, FOREVER, { request: { principal: principal(), ...target } }).then(() => "applied", e => e instanceof claims.NotCommitted ? "NotCommitted" : (e as Error).message);
			check(late === "NotCommitted", "the late original call meets the negative claim");
			const n = (await c.space.readAll({ type: cfg.countType, fields: fieldsOf(fork) })).length;
			check(n === 0, "the fork never took effect");
			fork.status = "resolved"; fork.lastError = "NotCommitted"; save();
			return { resolution: v, late, forkEntries: n, epoch: (await c.space.info()).primaryEpoch };
		} finally { c.close(); }
	}],
	["release", async () => { const reg = new TlsRecoveryRegister(cfg.operator.register), b = await releaseHostToQuarantine(reg, P.hostId, "part-release", new TlsFencing(cfg.operator.fencing)); await waitSsh(P); return { state: b.state }; }],
	["wipe-old", async () => { service(P, "stop"); sh(P, `docker start ${P.container} >/dev/null`); return JSON.parse(node(P, "sync", { op: "wipe", alias: cfg.alias })); }],
	["start-quarantine", async () => { const t = mark(P); service(P, "start"); return { quarantine: await waitFor(P, t, '"quarantine":true') }; }],
	["set-standby", async () => { service(S, "stop"); const t = mark(P), r = tool({ op: "set-standby", tid: "part-standby", target: P.hostId }); return { setStandby: r, left: await waitFor(P, t, '"leftQuarantine":true') }; }],
	["readmit", async () => {
		const reg = new TlsRecoveryRegister(cfg.operator.register), b = (await reg.get<any>("boot:" + P.hostId))!.value, done: string[] = [];
		for (const [id, p] of Object.entries<any>(b.spaces)) if (p.role === "local" && p.state === "revoked") { await readmitSpace(reg, P.hostId, id, { transitionId: "part-readmit", expectedDataIncarnation: p.dataIncarnation }); done.push(id); }
		return { readmitted: done };
	}],
	["start-old", async () => { const t = mark(P); service(P, "start"); const ready = await waitFor(P, t, '"ready":true'); check(head(P).config.standbyReplica === P.hostId, "the old primary is the sync standby"); return { ready }; }],
	["start-new", async () => { const t = mark(S); service(S, "start"); return { ready: await waitFor(S, t, '"ready":true') }; }],
	["lossless-after", async () => lossless(S, ["short", "long", "bounded", "kill-standby", "kill-primary"])],
	["compare", async () => {
		service(S, "stop"); service(P, "stop");
		const st = (h: Host) => JSON.parse(node(h, "sync", { op: "status", alias: cfg.alias, materialize: true, countType: cfg.countType }));
		const a = st(S), b = st(P), fork = (state.done.fork as any).fork;
		const at = (path: string, h: Host) => sh(h, `python3 -c "import sqlite3,glob,sys;p=sorted(glob.glob('${path}'))[-1];print(sqlite3.connect(p).execute('select hash from sync_intents where revision=${fork.revision}').fetchone()[0])"`).trim();
		const newAt = at(`${S.syncDir}/journal.sqlite`, S), asideAt = at(`${P.syncDir}.aside-*/journal.sqlite`, P);
		check(a.entries === b.entries && a.snapshot === b.snapshot && a.head.hash === b.head.hash, "both materialized replicas are identical");
		check(asideAt === fork.hash && newAt !== fork.hash, "the fork is only in the old primary's set-aside history");
		for (const h of [P, S]) { const t = mark(h); service(h, "start"); await waitFor(h, t, '"ready":true'); }
		return { newPrimary: { head: a.head, entries: a.entries, snapshot: a.snapshot, atFork: newAt }, oldPrimary: { head: b.head, entries: b.entries, snapshot: b.snapshot, asideAtFork: asideAt } };
	}],
];
try {
	for (const [name, run] of steps) {
		if (name in state.done) { log("skip (done)", name); continue; }
		log("step", name); state.done[name] = await run(); save(); log("done", state.done[name]);
	}
	log("PASSED"); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: true, steps: state.done, writes: state.writes }, null, 1));
} catch (e) { log("FAILED", (e as Error).message); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: false, error: (e as Error).message, steps: state.done, writes: state.writes }, null, 1)); process.exitCode = 1; }
