// Operator driver for the primary/sync cycle inside the federation daemons (docs/ap3-replica-control.md): sync writes,
// a sealed fork, netcup fencing, promote and degradeToSingle on the standby, release of the old primary into
// quarantine, wipe, quarantine start, setStandby, re-admission, restarts in a safe order, writes in the new direction
// and a materialized comparison. Every step is recorded in <out>/state.json; a rerun continues after the last
// completed step. It changes real hosts: run it only with an explicit go (AGENTS.md).
//   node --experimental-strip-types test/testbed/scenarios/phase3-daemon-cycle.ts <config.json>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_SPACE, RemoteSpace, TlsRecoveryRegister, TlsFencing, FOREVER, loadFileSigner, readmitSpace, releaseHostToQuarantine, socketTransport } from "../../../src/index.ts";

type Host = { hostId: string; ssh: string[]; container: string; home: string; service: string; gateIp: string; /** host path of the sync store */ syncDir: string };
type Config = {
	out: string; alias: string; countType: string;
	operator: { register: ConstructorParameters<typeof TlsRecoveryRegister>[0]; fencing: ConstructorParameters<typeof TlsFencing>[0] };
	/** sync tool credentials on the standby host (container paths): register writes for both boot records and fencing */
	tool: { controlRegister: unknown; fencing: unknown };
	client: { keyFile: string; ownPeerId: string; localAddress: string; control: { host: string; port: number; hostId: string } };
	primary: Host; standby: Host;
};
const cfg: Config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
mkdirSync(cfg.out, { recursive: true, mode: 0o700 });
const stateFile = join(cfg.out, "state.json"), state: { done: Record<string, unknown> } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { done: {} };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 1), { mode: 0o600 });
const log = (m: string, d?: unknown) => console.log(new Date().toISOString(), m, d === undefined ? "" : JSON.stringify(d).slice(0, 400));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Runs a shell script on a host (stdin carries the script, so nested ssh hops need no extra quoting). */
function sh(h: Host, script: string, o: { allowFail?: boolean; timeoutMs?: number } = {}): string {
	try { return execFileSync("ssh", ["-o", "ConnectTimeout=10", ...h.ssh, "bash -s"], { input: "set -e\n" + script, encoding: "utf8", timeout: o.timeoutMs ?? 120_000, stdio: ["pipe", "pipe", "pipe"] }); }
	catch (e) { if (o.allowFail) return String((e as any).stdout ?? ""); throw new Error(`${h.hostId}: ${String((e as any).stderr ?? e).slice(0, 400)}`); }
}
const node = (h: Host, args: string, input?: unknown) => {
	// The here-document belongs to docker exec, before the pipe; the filter only drops runtime warnings.
	const run = `docker exec -i ${h.container} node ${h.home}/federation-host.mjs ${args} ${h.home}`, filter = `2>&1 | grep -v -i -E "warn|trace-warnings"`;
	return sh(h, input === undefined ? `${run} </dev/null ${filter}` : `${run} <<'PI_SPACES_JSON' ${filter}\n${JSON.stringify(input)}\nPI_SPACES_JSON`, { timeoutMs: 600_000 }).trim().split("\n").at(-1)!;
};
const head = (h: Host) => (JSON.parse(node(h, "sync-head")) as any[]).find(x => x.alias === cfg.alias);
const tool = (op: Record<string, unknown>) => { const r = node(cfg.standby, "sync", { alias: cfg.alias, ...cfg.tool, ...op }); try { return JSON.parse(r); } catch { throw new Error(`sync tool: ${r.slice(0, 300)}`); } };
const service = (h: Host, action: "start" | "stop") => sh(h, `systemctl ${action} ${h.service}`, { allowFail: action === "stop" });
/** Waits for a journal line of the service after `since` (a ready, quarantine or exit marker), never a fixed sleep. */
async function waitFor(h: Host, since: string, pattern: string, timeoutMs = 180_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const out = sh(h, `journalctl -u ${h.service} --since '${since}' --no-pager -o cat | grep -F '${pattern}' | tail -1 || true`, { allowFail: true }).trim();
		if (out) return out;
		await sleep(3000);
	}
	throw new Error(`${h.hostId}: no '${pattern}' since ${since}`);
}
/** Journal position as the host's own epoch seconds: no time zone or clock offset between driver and host. */
const mark = (h: Host) => "@" + sh(h, "date +%s").trim();
async function waitSsh(h: Host, timeoutMs = 300_000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { try { sh(h, "true", { timeoutMs: 15_000 }); return; } catch { await sleep(5000); } } throw new Error(`${h.hostId}: ssh did not return`); }

async function writes(h: Host, count: number, label: string) {
	const signer = loadFileSigner(cfg.client.keyFile), c = cfg.client;
	const ctl = socketTransport({ host: c.control.host, port: c.control.port }, { localAddress: c.localAddress, connectTimeoutMs: 8000 });
	const t = socketTransport({ host: h.gateIp, port: 7421 }, { localAddress: c.localAddress, connectTimeoutMs: 8000 });
	let control: RemoteSpace; control = new RemoteSpace(ctl, { space: CONTROL_SPACE, signer, ownPeerId: c.ownPeerId, expectedGateHostId: c.control.hostId, attempts: 2, grantProvider: () => control.requestGrant() });
	const space = new RemoteSpace(t, { space: cfg.alias, signer, ownPeerId: c.ownPeerId, expectedGateHostId: h.hostId, attempts: 1, callTimeoutMs: 30_000, grantProvider: () => control.requestGrant() });
	const out: any = { host: h.hostId, writes: [] as unknown[] };
	try {
		await control.authenticate(); await space.authenticate(); out.primaryEpoch = (await space.info()).primaryEpoch;
		for (let n = 0; n < count; n++) { try { await space.write({ type: cfg.countType, fields: { label, n } }, null, FOREVER); out.writes.push({ n, ok: true }); } catch (e) { out.writes.push({ n, ok: false, error: (e as Error).message.slice(0, 160) }); break; } }
		try { out.count = await space.count({ type: cfg.countType }); } catch (e) { out.countError = (e as Error).message.slice(0, 160); }
	} finally { t.close(); ctl.close(); }
	return out;
}
const check = (cond: boolean, what: string) => { if (!cond) throw new Error("check failed: " + what); log("check", what); };

const P = cfg.primary, S = cfg.standby;
const steps: Array<[string, () => Promise<unknown>]> = [
	["preflight", async () => { const a = head(P), b = head(S); check(a.head.hash === b.head.hash && a.config.primaryReplica === P.hostId, "both replicas agree and the primary leads"); return { primary: a.head, standby: b.head }; }],
	["write-before", async () => { const r = await writes(P, 5, "before"); check(r.writes.every((w: any) => w.ok), "five sync writes through the primary gate"); check(head(S).head.hash === head(P).head.hash, "the standby confirmed every write"); return r; }],
	["stop-standby", async () => { service(S, "stop"); return { stopped: true }; }],
	["fork", async () => { const r = await writes(P, 1, "fork"), h = head(P); check(!r.writes[0].ok && h.head.revision === h.applied + 1, "the unconfirmed write stays a sealed candidate"); return { client: r, fork: h.head }; }],
	["promote", async () => { service(S, "stop"); const r = tool({ op: "promote", tid: "cycle-promote", epoch: head(S).config.primaryEpoch, version: head(S).config.replicaConfigVersion }); check(r.config?.primaryReplica === S.hostId && r.proof?.evidence?.state === "SHUTOFF", "standby promoted after a verified fence"); return r; }],
	["degrade", async () => { const r = tool({ op: "degrade", tid: "cycle-degrade", epoch: head(S).config.primaryEpoch, version: head(S).config.replicaConfigVersion }); check(r.config?.durability === "single", "single durability after degradeToSingle"); return r; }],
	["start-new-primary", async () => { const t = mark(S); service(S, "start"); return { ready: await waitFor(S, t, '"ready":true') }; }],
	["write-single", async () => { const r = await writes(S, 3, "single"); check(r.writes.every((w: any) => w.ok), "single writes on the promoted primary"); return r; }],
	["release", async () => { const reg = new TlsRecoveryRegister(cfg.operator.register), b = await releaseHostToQuarantine(reg, P.hostId, "cycle-release", new TlsFencing(cfg.operator.fencing)); await waitSsh(P); return { state: b.state }; }],
	["wipe-old", async () => { service(P, "stop"); sh(P, `docker start ${P.container} >/dev/null`); return JSON.parse(node(P, "sync", { op: "wipe", alias: cfg.alias })); }],
	["start-quarantine", async () => { const t = mark(P); service(P, "start"); return { quarantine: await waitFor(P, t, '"quarantine":true') }; }],
	["set-standby", async () => { service(S, "stop"); const t = mark(P), r = tool({ op: "set-standby", tid: "cycle-standby", target: P.hostId }); return { setStandby: r, left: await waitFor(P, t, '"leftQuarantine":true') }; }],
	["readmit", async () => {
		const reg = new TlsRecoveryRegister(cfg.operator.register), b = (await reg.get<any>("boot:" + P.hostId))!.value, done: string[] = [];
		for (const [id, p] of Object.entries<any>(b.spaces)) if (p.role === "local" && p.state === "revoked") { await readmitSpace(reg, P.hostId, id, { transitionId: "cycle-readmit", expectedDataIncarnation: p.dataIncarnation }); done.push(id); }
		return { readmitted: done };
	}],
	["start-old", async () => { const t = mark(P); service(P, "start"); const ready = await waitFor(P, t, '"ready":true'); check(head(P).config.standbyReplica === P.hostId, "the old primary is the sync standby"); return { ready }; }],
	["start-new", async () => { const t = mark(S); service(S, "start"); return { ready: await waitFor(S, t, '"ready":true') }; }],
	["write-after", async () => { const r = await writes(S, 3, "after"); check(r.writes.every((w: any) => w.ok), "sync writes in the new direction"); check(head(S).head.hash === head(P).head.hash, "the new standby confirmed every write"); return r; }],
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
	log("PASSED"); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: true, steps: state.done }, null, 1));
} catch (e) { log("FAILED", (e as Error).message); writeFileSync(join(cfg.out, "report.json"), JSON.stringify({ passed: false, error: (e as Error).message, steps: state.done }, null, 1)); process.exitCode = 1; }
