// Alerts and audit (docs/betrieb-und-mobile-steuerung.md §7.5, §8 B10). Alerts are hints derived from the durable
// state of runs, worker assignments and host reports; they are never a proof of a state. The monitor publishes only
// changes (new and resolved alerts), e.g. to a webhook such as ntfy. The audit view lists command results of the
// control Space without their payloads.
import type { Context } from "@earendil-works/chord";
import type { SpaceHost } from "./client.ts";
import { CAPABILITY_LEASE_MS } from "./capability-directory.ts";
import type { RunController } from "./run-controller.ts";
import { snapshotSpace } from "./spaces.ts";
import { appliedWorkers, type WorkerAssignments } from "./workers.ts";
import * as core from "./core.ts";

export type Alert = { key: string; severity: "warning" | "critical"; source: "run" | "worker" | "host"; subject: string; message: string };

/** Current alerts. `staleMs`: a host report older than this counts as missing (default: the Capability lease). */
export async function collectAlerts(o: { runs?: RunController; workers?: WorkerAssignments; host: SpaceHost; ctx: Context; controlSpaceId: string; now?: () => number; staleMs?: number }): Promise<Alert[]> {
	const now = (o.now ?? Date.now)(), stale = o.staleMs ?? CAPABILITY_LEASE_MS, out: Alert[] = [];
	for (const r of o.runs ? await o.runs.list(200) : []) {
		const subject = r.runId;
		if (r.state === "pauseIncomplete") out.push({ key: `run:${subject}:pauseIncomplete`, severity: "critical", source: "run", subject, message: `Pause unvollständig, fehlende ACKs: ${r.pending?.missing.join(", ") || "?"}` });
		else if (r.state === "needsReview") out.push({ key: `run:${subject}:needsReview`, severity: "critical", source: "run", subject, message: `Recovery ${r.recovery?.id ?? "?"} wartet auf eine Admin-Entscheidung` });
		else if (r.state === "reconciling") out.push({ key: `run:${subject}:reconciling`, severity: "warning", source: "run", subject, message: `Recovery ${r.recovery?.id ?? "?"} sammelt Member-Stände` });
		if (r.pending && Object.keys(r.pending.errors).length && r.state !== "pauseIncomplete") out.push({ key: `run:${subject}:errors:${r.pending.revision}`, severity: "warning", source: "run", subject, message: `${r.pending.kind} r${r.pending.revision}: ${Object.entries(r.pending.errors).map(([m, e]) => `${m}: ${e}`).join("; ").slice(0, 300)}` });
	}
	const control = await snapshotSpace(o.host, o.controlSpaceId, o.ctx);
	const applied = control ? appliedWorkers(control, now) : {};
	for (const a of o.workers ? (await o.workers.list()).assignments : []) {
		const subject = a.assignmentId, report = applied[a.hostId], state = report?.workers.assignments?.[a.assignmentId];
		if (a.count > 0 && (!report || now - report.at > stale)) { out.push({ key: `worker:${subject}:stale`, severity: "warning", source: "worker", subject, message: `Host ${a.hostId} meldet seit ${report ? Math.round((now - report.at) / 1000) + " s" : "jeher"} nichts; das beweist nicht, dass Worker beendet sind` }); continue; }
		if (!report) continue;
		if (report.workers.blocked) out.push({ key: `worker:${a.hostId}:blocked`, severity: "critical", source: "worker", subject: a.hostId, message: report.workers.blocked });
		if (state?.rejected) out.push({ key: `worker:${subject}:rejected`, severity: "critical", source: "worker", subject, message: state.rejected });
		else if (report.workers.generation < a.generation) out.push({ key: `worker:${subject}:pending:${a.generation}`, severity: "warning", source: "worker", subject, message: `Änderung (Generation ${a.generation}) von Host ${a.hostId} noch nicht übernommen` });
		if (state?.errors && state.lastError) out.push({ key: `worker:${subject}:error`, severity: "warning", source: "worker", subject, message: `${state.errors} Fehler, zuletzt: ${state.lastError}` });
	}
	const seen = new Set<string>();
	for (const e of control ? core.list(control, now, { type: "Capability" }) : []) {
		const hostId = String(e.fields.hostId), at = Number(e.fields.at);
		if (seen.has(hostId)) continue; seen.add(hostId);
		const fetchError = (e.fields.metrics as any)?.workers?.fetchError;
		if (typeof fetchError === "string") out.push({ key: `host:${hostId}:fetch`, severity: "warning", source: "host", subject: hostId, message: `Zuweisungen nicht abrufbar: ${fetchError}` });
		if (now - at > stale) out.push({ key: `host:${hostId}:stale`, severity: "warning", source: "host", subject: hostId, message: `letzter Heartbeat vor ${Math.round((now - at) / 1000)} s` });
	}
	return out.sort((a, b) => (a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === "critical" ? -1 : 1));
}

/** Calls `collect` periodically and `publish` only with changes; a failing publish is retried with the next pass. */
export function startAlertMonitor(o: { collect: () => Promise<Alert[]>; publish: (change: { raised: Alert[]; resolved: Alert[] }) => Promise<void>; intervalMs?: number; onError?: (e: unknown) => void }): { pass: () => Promise<void>; stop: () => Promise<void> } {
	let known = new Map<string, Alert>(), stopped = false, timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> = Promise.resolve();
	const pass = async () => {
		const current = new Map((await o.collect()).map(a => [a.key, a]));
		const raised = [...current.values()].filter(a => !known.has(a.key)), resolved = [...known.values()].filter(a => !current.has(a.key));
		if (raised.length || resolved.length) await o.publish({ raised, resolved });
		known = current; // only after a successful publish
	};
	const loop = () => { active = pass().catch(o.onError ?? (() => {})).then(() => { if (!stopped) timer = setTimeout(loop, o.intervalMs ?? 30_000); }); };
	loop();
	return { pass, stop: async () => { stopped = true; if (timer) clearTimeout(timer); await active; } };
}

/** A publisher for plain-text webhooks such as ntfy: one POST per change, title and priority as headers. */
export function webhookPublisher(url: string, o: { fetch?: typeof fetch; title?: string } = {}) {
	const u = new URL(url);
	if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new core.IllegalArgumentError("webhook URL must be http(s) without credentials");
	return async (change: { raised: Alert[]; resolved: Alert[] }) => {
		const lines = [...change.raised.map(a => `${a.severity === "critical" ? "!!" : "!"} ${a.subject}: ${a.message}`), ...change.resolved.map(a => `ok ${a.subject}: ${a.message}`)];
		const critical = change.raised.some(a => a.severity === "critical");
		const res = await (o.fetch ?? fetch)(url, { method: "POST", body: lines.join("\n").slice(0, 4000), headers: { "Content-Type": "text/plain; charset=utf-8", Title: o.title ?? "pi-spaces", Priority: critical ? "high" : "default" } });
		if (!res.ok) throw new Error(`webhook answered ${res.status}`);
	};
}

/** Recent command results of the control Space for admins: who asked what, when and with which outcome. */
export async function auditLog(host: SpaceHost, ctx: Context, controlSpaceId: string, o: { limit?: number; now?: () => number } = {}): Promise<Array<{ commandId: string; kind: string; state: string; requestedBy: string; at: number; error?: string }>> {
	const s = await snapshotSpace(host, controlSpaceId, ctx);
	if (!s) return [];
	return core.list(s, (o.now ?? Date.now)(), { type: "Result" }).map(e => e.fields as Record<string, any>)
		.map(f => ({ commandId: String(f.commandId), kind: String(f.kind), state: String(f.state), requestedBy: String(f.requestedBy ?? ""), at: Number(f.at), ...(f.error || f.result?.error ? { error: String(f.error ?? f.result.error).slice(0, 300) } : {}) }))
		.sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.min(o.limit ?? 100, 500)));
}
