// The agents process: takes the agent slots of runs from the shared space and works as those agents until their runs
// are over (run.ts). Nothing it knows lives only in memory: a slot is held under a transaction it renews, so a process
// that dies lets it lapse and another agents process takes the slot over, with the run's work items where they were.
// Taken over from codemode-chat/server/agent-host.ts.
//
//   FORUM_SPACE=unix:/tmp/codemode-forum-space.sock   (default) or tcp:host:4180
//   FORUM_AGENT_SLOTS=16                              agents this process works as at most at once
import "./env.ts";
import { pathToFileURL } from "node:url";
import { NO_WAIT } from "phi-spaces";
import { announce, awaitWork, connectSpace, DEFAULT_SPACE, entryLeaseMs, keepAlive } from "./space.ts";
import { agentLoop, ITEM_LEASE_MS, type Slot } from "./run.ts";

export async function startAgentHost(o: { space?: string; slots?: number } = {}) {
	const conn = connectSpace(o.space);
	const space = conn.space, ttl = entryLeaseMs();
	const presence = announce(space, "agents");
	const max = Math.max(1, o.slots ?? Number(process.env.FORUM_AGENT_SLOTS ?? 16));
	// every transaction in progress (slots and work items): a shutdown aborts them, so nothing stays held for a process that
	// is gone (a waiting take is kept in the space and would catch the next slot)
	const open = new Set<string>();
	let stopping = false, active = 0;
	const halt = new AbortController();
	const agents = new Set<Promise<void>>();
	const deps = { space, ttl, open, stopping: () => stopping };

	/** Takes one free slot (under a renewed transaction) and works as that agent; true when it got one. */
	const takeSlot = async (): Promise<boolean> => {
		if (!(await awaitWork(space, { type: "AgentSlot" }, halt.signal))) return false; // idle: waiting holds nothing
		const t = await space.createTransaction(ITEM_LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, ITEM_LEASE_MS);
		const release = async (commit: boolean) => { stop(); open.delete(t.id); await (commit ? space.commit(t.id) : space.abort(t.id)).catch(() => {}); };
		try {
			const e = await space.take({ type: "AgentSlot" }, NO_WAIT, { txn: t.id });
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
	const loop = (async () => {
		while (!stopping) {
			if (active >= max) { await new Promise((r) => setTimeout(r, 500)); continue; }
			try { await takeSlot(); }
			catch (e) { if (!stopping) { console.error("[agents] taking a slot failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); } }
		}
	})();
	return {
		async close() {
			stopping = true; halt.abort();
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled([loop, ...agents]), new Promise((r) => setTimeout(r, 3000))]);
			await presence.stop(); conn.close();
		},
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const host = await startAgentHost();
	console.log(`[agents] working from ${process.env.FORUM_SPACE || DEFAULT_SPACE}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
