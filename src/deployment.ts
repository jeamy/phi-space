// Deployment bootstrap (docs/betrieb-und-mobile-steuerung.md §4, §8 B8). A declarative config names hosts, Spaces,
// routing and workers by alias only. The coordinator keeps the alias -> ID mapping, computes a plan against it and
// applies it idempotently through the existing building blocks: Space lifecycle (B7) and worker assignments (B6).
// Host installation, NetBird join and enrollment are prerequisites, not steps here: an alias must be bound to an
// enrolled host whose Capability heartbeat is fresh. Workers are registered with count 0; `startWorkers` starts them.
import type { Context } from "./context.ts";
import { defineDoc } from "@earendil-works/pi-durable";
import { digestJson } from "./canonical.ts";
import type { SpaceHost } from "./client.ts";
import type { WorkerAssignments } from "./workers.ts";
import { CAPABILITY_LEASE_MS } from "./capability-directory.ts";
import { snapshotSpace } from "./spaces.ts";
import * as core from "./core.ts";

export type DeploymentConfig = {
	schemaVersion: 1; deployment: string; configRevision?: number; coordinator: string;
	hosts: Array<{ alias: string; ssh?: string; role: "coordinator" | "member-host" }>;
	spaces: Array<{ alias: string; host: string; purpose: "control" | "data"; maxSpaceBytes?: number; limits?: Partial<core.Limits>; profiles?: core.CompletionProfile[] }>;
	routing?: { profile: "single-member-sieve" | "sieve-hrw-by-taskid"; member?: string; members?: string[] };
	workers?: Array<{ alias: string; host: string; kind: string; targetSpace: string; count: number; runId?: string }>;
	mobile?: { access: "native-overlay" | "browser-gateway"; enrollmentRole: "admin" | "observer" };
	credentials?: { source: "host-secret-store" };
};
export type PlanStep = { key: string; action: string; status: "ok" | "create" | "reuse" | "blocked" | "conflict" | "skip"; detail: string };
export type DeploymentPlan = { deployment: string; configHash: string; ready: boolean; steps: PlanStep[] };

const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/, ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const SECRET_KEY = /token|secret|password|passwd|private|apikey|api_key|bearer|seed|mnemonic/i;
const hashOf = digestJson;
/** A stable sub-request ID of one deployment step (bounded length, valid as command ID). */
const sub = (...parts: string[]) => "dep-" + hashOf(parts).slice(0, 40);

/** Validates and normalizes a config. Every problem is listed; secrets anywhere in the file are refused. */
export function validateDeployment(raw: unknown): { config?: DeploymentConfig; configHash?: string; errors: string[] } {
	const errors: string[] = [];
	const scan = (v: unknown, path: string) => {
		if (typeof v === "string" && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v) || /^(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9]{16,}/.test(v))) errors.push(`${path}: looks like a secret; keep credentials in the host secret store`);
		if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (SECRET_KEY.test(k)) errors.push(`${path}.${k}: secret fields are not allowed in the config`); scan(x, `${path}.${k}`); }
	};
	scan(raw, "$");
	const c = raw as DeploymentConfig;
	if (!c || typeof c !== "object" || Array.isArray(c)) return { errors: ["config must be a JSON object"] };
	const known = ["schemaVersion", "deployment", "configRevision", "coordinator", "hosts", "spaces", "routing", "workers", "mobile", "credentials"];
	for (const k of Object.keys(c)) if (!known.includes(k)) errors.push(`unknown field ${k}`);
	if (c.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (typeof c.deployment !== "string" || !ALIAS.test(c.deployment)) errors.push("deployment: lower-case alias required");
	if (c.configRevision !== undefined && (!Number.isSafeInteger(c.configRevision) || c.configRevision < 1)) errors.push("configRevision must be a positive integer");
	const hosts = Array.isArray(c.hosts) ? c.hosts : (errors.push("hosts must be a list"), []);
	const spaces = Array.isArray(c.spaces) ? c.spaces : (errors.push("spaces must be a list"), []);
	const workers = c.workers === undefined ? [] : Array.isArray(c.workers) ? c.workers : (errors.push("workers must be a list"), []);
	if (hosts.length > 64 || spaces.length > 128 || workers.length > 128) errors.push("at most 64 hosts, 128 Spaces and 128 workers");
	const unique = (list: Array<{ alias: string }>, what: string) => { const seen = new Set<string>(); for (const x of list) { if (!x || typeof x.alias !== "string" || !ALIAS.test(x.alias)) errors.push(`${what}: invalid alias ${JSON.stringify(x?.alias)}`); else if (seen.has(x.alias)) errors.push(`${what}: duplicate alias ${x.alias}`); else seen.add(x.alias); } return seen; };
	const hostAliases = unique(hosts, "hosts"), spaceAliases = unique(spaces, "spaces"); unique(workers, "workers");
	for (const h of hosts) if (h && !["coordinator", "member-host"].includes(h.role)) errors.push(`hosts.${h.alias}: role must be coordinator or member-host`);
	if (!hostAliases.has(c.coordinator)) errors.push("coordinator must name a host");
	else if (hosts.find(h => h.alias === c.coordinator)?.role !== "coordinator" || hosts.filter(h => h.role === "coordinator").length !== 1) errors.push("exactly the coordinator host has role coordinator");
	for (const s of spaces) {
		if (!s) continue;
		if (!hostAliases.has(s.host)) errors.push(`spaces.${s.alias}: unknown host ${s.host}`);
		if (!["control", "data"].includes(s.purpose)) errors.push(`spaces.${s.alias}: purpose must be control or data`);
		if (s.purpose === "control" && s.host !== c.coordinator) errors.push(`spaces.${s.alias}: the control Space lives on the coordinator`);
		if (s.maxSpaceBytes !== undefined && (!Number.isSafeInteger(s.maxSpaceBytes) || s.maxSpaceBytes < 1024)) errors.push(`spaces.${s.alias}: maxSpaceBytes must be an integer of at least 1024`);
		if (s.limits !== undefined && (typeof s.limits !== "object" || Array.isArray(s.limits))) errors.push(`spaces.${s.alias}: limits must be an object`);
	}
	if (spaces.filter(s => s?.purpose === "control").length !== 1) errors.push("exactly one control Space is required");
	const dataSpaces = new Set(spaces.filter(s => s?.purpose === "data").map(s => s.alias));
	if (c.routing !== undefined) {
		const r = c.routing;
		if (r.profile === "single-member-sieve") { if (!r.member || !dataSpaces.has(r.member)) errors.push("routing.member must name a data Space"); }
		else if (r.profile === "sieve-hrw-by-taskid") { if (!Array.isArray(r.members) || r.members.length < 2 || !r.members.every(m => dataSpaces.has(m))) errors.push("routing.members must name at least two data Spaces"); }
		else errors.push("routing.profile must be single-member-sieve or sieve-hrw-by-taskid");
	}
	for (const w of workers) {
		if (!w) continue;
		if (!hostAliases.has(w.host)) errors.push(`workers.${w.alias}: unknown host ${w.host}`);
		const target = spaces.find(s => s?.alias === w.targetSpace);
		if (!target || target.purpose !== "data") errors.push(`workers.${w.alias}: targetSpace must name a data Space`);
		else if (target.host !== w.host) errors.push(`workers.${w.alias}: workers run on the host of their target Space`);
		if (typeof w.kind !== "string" || !ID.test(w.kind)) errors.push(`workers.${w.alias}: invalid kind`);
		if (!Number.isSafeInteger(w.count) || w.count < 0 || w.count > 64) errors.push(`workers.${w.alias}: count must be 0..64`);
		if (w.runId !== undefined && !ID.test(w.runId)) errors.push(`workers.${w.alias}: invalid runId`);
	}
	if (c.credentials !== undefined && c.credentials.source !== "host-secret-store") errors.push("credentials.source must be host-secret-store");
	if (errors.length) return { errors };
	const config = core.plain(c);
	return { config, configHash: hashOf(config), errors };
}

type StepRec = { status: "done" | "failed" | "pending" | "skipped"; result?: core.Json; error?: string };
type Job = { deployment: string; configHash: string; config: DeploymentConfig; state: "applying" | "blocked" | "completed"; steps: Record<string, StepRec>; at: number };
export const DeploymentState = defineDoc<{ hosts: Record<string, string>; spaces: Record<string, { host: string; spaceId: string }>; jobs: Record<string, Job> }>({
	kind: "phi-spaces.deployment", version: 1, scope: "session", initial: () => ({ hosts: {}, spaces: {}, jobs: {} }),
});
export type DeploymentPorts = {
	/** Fresh Capability heartbeat of an enrolled host (e.g. from appliedWorkers/Capability entries). */
	hostStatus: (hostId: string) => Promise<{ fresh: boolean; at?: number }>;
	/** Admin command handler of the Space lifecycle (spaceCommands().createSpace). */
	createSpace: (commandId: string, args: Record<string, core.Json>) => Promise<core.Json>;
	workers?: WorkerAssignments;
	/** The coordinator's control Space ID. */
	controlSpaceId: string;
};

/** Coordinator side: alias bindings, plan, idempotent apply, worker start and export. */
export class DeploymentController {
	private o: { host: SpaceHost; ctx: Context; ports: DeploymentPorts; now?: () => number };
	constructor(o: DeploymentController["o"]) { this.o = o; }
	private now() { return (this.o.now ?? Date.now)(); }
	private state() { return this.o.host.snapshot(DeploymentState, this.o.ctx).then(s => core.plain(s ?? { hosts: {}, spaces: {}, jobs: {} })); }

	/** Binds a host alias to an enrolled hostId. An alias never silently moves to another host. */
	async bindHost(alias: string, hostId: string): Promise<{ alias: string; hostId: string }> {
		if (!ALIAS.test(alias) || typeof hostId !== "string" || !ID.test(hostId)) throw new core.IllegalArgumentError("bindHost needs an alias and a hostId");
		return this.o.host.commit(async tx => {
			const d = await tx.doc(DeploymentState), old = d.hosts[alias];
			if (old && old !== hostId) throw new core.RunGateConflict(`host alias ${alias} is bound to ${old}`);
			if (Object.entries(d.hosts).some(([a, id]) => id === hostId && a !== alias)) throw new core.RunGateConflict(`host ${hostId} already has another alias`);
			d.hosts[alias] = hostId;
			return { alias, hostId };
		}, this.o.ctx);
	}

	/** What apply would do, without any effect. */
	async plan(raw: unknown): Promise<DeploymentPlan> {
		const v = validateDeployment(raw);
		if (!v.config) return { deployment: String((raw as any)?.deployment ?? "?"), configHash: "", ready: false, steps: v.errors.map((e, i) => ({ key: `config:${i}`, action: "validate", status: "conflict", detail: e })) };
		const c = v.config, st = await this.state(), steps: PlanStep[] = [];
		for (const h of c.hosts) {
			const id = st.hosts[h.alias];
			if (!id) { steps.push({ key: `host:${h.alias}`, action: "bind", status: "blocked", detail: "host alias is not bound to an enrolled host; enroll it, then bindHost" }); continue; }
			const s = await this.o.ports.hostStatus(id).catch(() => ({ fresh: false }));
			steps.push({ key: `host:${h.alias}`, action: "check", status: s.fresh ? "ok" : "blocked", detail: s.fresh ? `${id} reports a fresh heartbeat` : `${id} has no fresh Capability heartbeat` });
		}
		for (const s of c.spaces) {
			const bound = st.spaces[s.alias];
			if (s.purpose === "control") { steps.push({ key: `space:${s.alias}`, action: "control", status: bound && bound.spaceId !== this.o.ports.controlSpaceId ? "conflict" : "reuse", detail: "the coordinator's control Space" }); continue; }
			if (bound && bound.host !== s.host) steps.push({ key: `space:${s.alias}`, action: "create", status: "conflict", detail: `alias is bound to ${bound.spaceId} on ${bound.host}; Spaces do not move hosts` });
			else steps.push({ key: `space:${s.alias}`, action: "create", status: bound ? "reuse" : "create", detail: bound ? `existing ${bound.spaceId}, reused unchanged` : `new Space on ${s.host}` });
		}
		if (c.routing) steps.push({ key: "routing", action: "policy", status: "skip", detail: `profile ${c.routing.profile}: membership and policy are applied with addMember/setPolicy (not part of this bootstrap)` });
		const assigned = this.o.ports.workers ? (await this.o.ports.workers.list()).assignments : [];
		for (const w of c.workers ?? []) {
			const key = `worker:${w.alias}`;
			if (!this.o.ports.workers) { steps.push({ key, action: "register", status: "blocked", detail: "no worker assignment directory configured" }); continue; }
			const old = assigned.find(a => a.assignmentId === `${c.deployment}.${w.alias}`), target = st.spaces[w.targetSpace]?.spaceId;
			if (!old) steps.push({ key, action: "register", status: "create", detail: `${w.kind} on ${w.host}, registered with count 0; startWorkers sets ${w.count}` });
			else if (old.hostId === st.hosts[w.host] && old.kind === w.kind && old.targetSpace === target && old.runId === w.runId) steps.push({ key, action: "register", status: "reuse", detail: `unchanged definition; current count ${old.count} is kept` });
			else if (old.count > 0) steps.push({ key, action: "register", status: "conflict", detail: `definition changed while ${old.count} workers run; stop them (count 0) first` });
			else steps.push({ key, action: "register", status: "create", detail: "stopped assignment gets the new definition with count 0" });
		}
		return { deployment: c.deployment, configHash: v.configHash!, ready: !steps.some(s => s.status === "blocked" || s.status === "conflict"), steps };
	}

	/**
	 * Applies a config once per deployment and config hash; a repeated apply resumes the same job. Steps use stable
	 * sub-request IDs, so an unknown outcome is resolved by repeating them. A blocked or conflicting plan changes nothing.
	 */
	async apply(raw: unknown): Promise<{ deployment: string; configHash: string; state: Job["state"]; steps: Record<string, StepRec>; plan?: DeploymentPlan }> {
		const plan = await this.plan(raw);
		const v = validateDeployment(raw);
		if (!v.config) return { deployment: plan.deployment, configHash: "", state: "blocked", steps: {}, plan };
		const c = v.config, key = c.deployment;
		const job = await this.o.host.commit(async tx => {
			const d = await tx.doc(DeploymentState), old = d.jobs[key];
			// A blocked job is corrected by a new config (created Spaces stay bound and are reused); only a job that
			// may still have steps in flight blocks another config.
			if (old && old.configHash !== v.configHash && old.state === "applying") throw new core.RunGateConflict(`deployment ${key} is still applying another config; repeat it until it completes or blocks`);
			if (!old || old.configHash !== v.configHash) {
				if (Object.keys(d.jobs).length >= 64 && !old) throw new core.ResourceExhausted("deployment journal is full");
				d.jobs[key] = { deployment: key, configHash: v.configHash!, config: core.plain(c), state: "applying", steps: {}, at: this.now() };
			}
			return core.plain(d.jobs[key]!);
		}, this.o.ctx);
		if (job.state === "completed") return { deployment: key, configHash: job.configHash, state: job.state, steps: job.steps };
		if (!plan.ready) {
			await this.record(key, job.configHash, d => { d.state = "blocked"; });
			return { deployment: key, configHash: job.configHash, state: "blocked", steps: job.steps, plan };
		}
		const st = await this.state();
		for (const s of c.spaces) {
			const step = `space:${s.alias}`;
			if (job.steps[step]?.status === "done") continue;
			if (s.purpose === "control") { await this.space(key, job.configHash, s.alias, s.host, this.o.ports.controlSpaceId, step); continue; }
			const limits = { ...(s.limits ?? {}), ...(s.maxSpaceBytes ? { maxSpaceBytes: s.maxSpaceBytes } : {}) };
			const r = await this.o.ports.createSpace(sub(key, job.configHash, "space", s.alias), { hostId: st.hosts[s.host]!, alias: s.alias, ...(Object.keys(limits).length ? { limits: limits as core.Json } : {}), ...(s.profiles ? { profiles: s.profiles as unknown as core.Json } : {}) }) as any;
			if (r?.phase === "failed" || typeof r?.spaceId !== "string") {
				await this.record(key, job.configHash, d => { d.steps[step] = { status: "failed", error: String(r?.error ?? "no spaceId").slice(0, 512) }; d.state = "blocked"; });
				return this.view(key);
			}
			await this.space(key, job.configHash, s.alias, s.host, r.spaceId, step, r);
		}
		const bound = (await this.state()).spaces, assigned = (await this.o.ports.workers?.list())?.assignments ?? [];
		for (const w of c.workers ?? []) {
			const step = `worker:${w.alias}`;
			if (job.steps[step]?.status === "done") continue;
			const old = assigned.find(a => a.assignmentId === `${key}.${w.alias}`);
			if (old && old.hostId === st.hosts[w.host] && old.kind === w.kind && old.targetSpace === bound[w.targetSpace]!.spaceId && old.runId === w.runId) {
				await this.record(key, job.configHash, d => { d.steps[step] = { status: "done", result: old as unknown as core.Json }; }); // running workers keep their count
				continue;
			}
			const spec = await this.o.ports.workers!.set(sub(key, job.configHash, "worker", w.alias), { assignmentId: `${key}.${w.alias}`, hostId: st.hosts[w.host]!, kind: w.kind, targetSpace: bound[w.targetSpace]!.spaceId, count: 0, ...(w.runId ? { runId: w.runId } : {}) });
			await this.record(key, job.configHash, d => { d.steps[step] = { status: "done", result: spec as unknown as core.Json }; });
		}
		if (c.routing) await this.record(key, job.configHash, d => { d.steps.routing = { status: "skipped", error: "membership and policy are separate admin commands" }; });
		await this.record(key, job.configHash, d => { d.state = "completed"; });
		return this.view(key);
	}
	private async space(key: string, hash: string, alias: string, host: string, spaceId: string, step: string, result?: core.Json) {
		await this.record(key, hash, (d, all) => {
			const old = all.spaces[alias];
			if (old && (old.spaceId !== spaceId || old.host !== host)) throw new core.RunGateConflict(`Space alias ${alias} is bound to ${old.spaceId}`);
			all.spaces[alias] = { host, spaceId };
			d.steps[step] = { status: "done", result: (result ?? { spaceId }) as core.Json };
		});
	}
	private record(key: string, hash: string, f: (job: Job, all: { hosts: Record<string, string>; spaces: Record<string, { host: string; spaceId: string }> }) => void) {
		return this.o.host.commit(async tx => { const d = await tx.doc(DeploymentState), j = d.jobs[key]; if (!j || j.configHash !== hash) throw new core.RunGateConflict("deployment job changed"); f(j, d); }, this.o.ctx);
	}
	private async view(key: string) {
		const j = (await this.state()).jobs[key]!;
		return { deployment: key, configHash: j.configHash, state: j.state, steps: j.steps };
	}

	/** Starts (or rescales) the registered workers of a completed deployment to their configured counts. */
	async startWorkers(commandId: string, deployment: string): Promise<Array<{ alias: string; count: number; generation: number }>> {
		if (!ID.test(commandId)) throw new core.IllegalArgumentError("invalid command ID");
		const st = await this.state(), job = st.jobs[deployment];
		if (!job || job.state !== "completed") throw new core.RunGateConflict(`deployment ${deployment} is not completed`);
		const out = [];
		for (const w of job.config.workers ?? []) {
			const spec = await this.o.ports.workers!.set(sub(commandId, w.alias), { assignmentId: `${deployment}.${w.alias}`, hostId: st.hosts[w.host]!, kind: w.kind, targetSpace: st.spaces[w.targetSpace]!.spaceId, count: w.count, ...(w.runId ? { runId: w.runId } : {}) });
			out.push({ alias: w.alias, count: spec.count, generation: spec.generation });
		}
		return out;
	}

	/** The applied state for export and diff: bindings, last config per deployment and current worker counts. */
	async export(deployment: string): Promise<{ deployment: string; configHash: string | null; state: string | null; hosts: Record<string, string>; spaces: Record<string, { host: string; spaceId: string }>; workers: Array<{ alias: string; count: number }> ; config: DeploymentConfig | null }> {
		const st = await this.state(), job = st.jobs[deployment];
		const assigned = this.o.ports.workers ? (await this.o.ports.workers.list()).assignments : [];
		const workers = (job?.config.workers ?? []).map(w => ({ alias: w.alias, count: assigned.find(a => a.assignmentId === `${deployment}.${w.alias}`)?.count ?? 0 }));
		return { deployment, configHash: job?.configHash ?? null, state: job?.state ?? null, hosts: st.hosts, spaces: st.spaces, workers, config: job?.config ?? null };
	}
}

/** Admin commands for the control-space supervisor. Refusals become failed results; plans are read-only. */
export function deploymentCommands(d: DeploymentController): Record<"planDeployment" | "applyDeployment" | "bindHostAlias" | "startWorkers" | "exportDeployment", (commandId: string, args: Record<string, core.Json>) => Promise<core.Json>> {
	const wrap = (f: (id: string, a: Record<string, core.Json>) => Promise<unknown>) => async (id: string, a: Record<string, core.Json>): Promise<core.Json> => {
		try { return (await f(id, a)) as core.Json; }
		catch (e) { if (e instanceof core.IllegalArgumentError || e instanceof core.TransactionError || e instanceof core.LimitError) return { phase: "failed", error: e.message }; throw e; }
	};
	return {
		planDeployment: wrap((_id, a) => d.plan(a.config)),
		applyDeployment: wrap((_id, a) => d.apply(a.config)),
		bindHostAlias: wrap((_id, a) => d.bindHost(String(a.alias ?? ""), String(a.hostId ?? ""))),
		startWorkers: wrap((id, a) => d.startWorkers(id, String(a.deployment ?? ""))),
		exportDeployment: wrap((_id, a) => d.export(String(a.deployment ?? ""))),
	};
}

/** `hostStatus` from the control Space: fresh while the host's newest Capability heartbeat is within its lease. */
export function capabilityHostStatus(host: SpaceHost, ctx: Context, controlSpaceId: string, now: () => number = Date.now): DeploymentPorts["hostStatus"] {
	return async hostId => {
		const s = await snapshotSpace(host, controlSpaceId, ctx), t = now();
		const at = Math.max(-Infinity, ...(s ? core.list(s, t, { type: "Capability", fields: { hostId } }).map(e => Number(e.fields.at)) : []));
		return Number.isFinite(at) ? { fresh: t - at < CAPABILITY_LEASE_MS, at } : { fresh: false };
	};
}
