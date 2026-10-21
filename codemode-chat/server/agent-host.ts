// The agents process: takes the agent slots of runs from the shared space and works as those agents until their runs
// are over (run.ts), and does the agents' work when a task is created (task-agent.ts: a check rule, criteria). Nothing it knows lives only in memory: a slot is held under a transaction it renews, so a process
// that dies lets it lapse and another agents process takes the slot over, with the run's work items where they were.
//
//   CODEMODE_SPACE=unix:/tmp/codemode-space.sock   (default) or tcp:nano:3800
//   CODEMODE_AGENT_SLOTS=16                         agents this process works as at most at once
import "./env.ts";
import { pathToFileURL } from "node:url";
import { announce, connectSpace, entryLeaseMs, keepAlive } from "./space.ts";
import { NO_WAIT } from "../../src/index.ts";
import { loadCodemode } from "./judge.ts";
import { agentLoop, ITEM_LEASE_MS, type Slot } from "./run.ts";
import { deadlineOf, verifyTask, writeCriteria, type TaskRequest } from "./task-agent.ts";

/** How long one blocking take waits for a free slot (below the client's call timeout). */
const WAIT_MS = 5_000;

export async function startAgentHost(o: { space?: string; slots?: number } = {}) {
	const conn = connectSpace(o.space);
	const space = conn.space, ttl = entryLeaseMs();
	const presence = announce(space, "agents");
	const max = Math.max(1, o.slots ?? Number(process.env.CODEMODE_AGENT_SLOTS ?? 16));
	// every transaction in progress (slots and work items): a shutdown aborts them, so nothing stays held for a process that
	// is gone (a waiting take is kept in the space and would catch the next slot)
	const open = new Set<string>();
	let stopping = false, active = 0;
	const agents = new Set<Promise<void>>();
	const deps = { space, ttl, open, stopping: () => stopping };

	/** Takes one free slot (a blocking take under a renewed transaction) and works as that agent; true when it got one. */
	const takeSlot = async (): Promise<boolean> => {
		const t = await space.createTransaction(ITEM_LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, ITEM_LEASE_MS);
		const release = async (commit: boolean) => { stop(); open.delete(t.id); await (commit ? space.commit(t.id) : space.abort(t.id)).catch(() => {}); };
		try {
			const e = await space.take({ type: "AgentSlot" }, WAIT_MS, { txn: t.id });
			if (!e) { await release(false); return false; }
			const slot = e.fields as unknown as Slot;
			active++;
			const work = (async () => {
				let finished = false;
				try { await agentLoop(deps, slot); finished = !stopping; }
				catch (err) { console.error("[agents] agent stopped", slot.runId, slot.agent, (err as Error).message); }
				// the run is over: the slot is used up; on a shutdown or a failure it goes back for another process
				finally { active--; await release(finished); }
			})();
			agents.add(work); void work.finally(() => agents.delete(work));
			return true;
		} catch (err) { await release(false); throw err; }
	};
	/** A task request (a check rule, criteria): taken, done and answered with a TaskReady in one transaction. */
	const cm = await loadCodemode();
	const takeTask = async (): Promise<boolean> => {
		const t = await space.createTransaction(ITEM_LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, ITEM_LEASE_MS);
		try {
			const e = await space.take({ type: "TaskRequest" }, WAIT_MS, { txn: t.id });
			if (!e) { await space.abort(t.id); return false; }
			const req = e.fields as unknown as TaskRequest;
			let ready;
			try {
				// the web process stopped waiting for it: nothing is asked of the models any more
				if (Date.now() >= deadlineOf(req)) ready = { ok: false, error: "the request waited too long for an agent" };
				else if (req.kind === "verify") { if (!cm) throw new Error("@earendil-works/pi-codemode could not be loaded"); ready = await verifyTask(space, t.id, cm, req); }
				else {
					const info = (await space.readIfExists({ type: "ModelInfo" }, NO_WAIT))?.fields as { info?: { models?: Array<{ label: string }> } } | undefined;
					ready = await writeCriteria(space, t.id, req, (info?.info?.models ?? []).map((m) => m.label));
				}
			} catch (err) { ready = { ok: false, error: String((err as Error).message ?? err).slice(0, 300) }; }
			await space.write({ type: "TaskReady", fields: { requestId: req.requestId, session: req.session, ...ready, ts: Date.now() } as never }, t.id, 15 * 60_000);
			await space.commit(t.id);
			return true;
		} catch (err) { await space.abort(t.id).catch(() => {}); throw err; }
		finally { stop(); open.delete(t.id); }
	};
	// two requests at once: one long task creation (criteria and their review) does not hold up the next room's
	const tasks = Promise.all([0, 1].map(async () => {
		while (!stopping) {
			try { await takeTask(); }
			catch (e) { if (!stopping) { console.error("[agents] task request failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); } }
		}
	}));
	const loop = (async () => {
		while (!stopping) {
			if (active >= max) { await new Promise((r) => setTimeout(r, 500)); continue; }
			try { await takeSlot(); }
			catch (e) { if (!stopping) { console.error("[agents] taking a slot failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); } }
		}
	})();
	return {
		async close() {
			stopping = true;
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled([loop, tasks, ...agents]), new Promise((r) => setTimeout(r, 3000))]);
			await presence.stop(); conn.close();
		},
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const host = await startAgentHost();
	console.log(`[agents] working from ${process.env.CODEMODE_SPACE || "unix:/tmp/codemode-space.sock"}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
