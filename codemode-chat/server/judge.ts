// The judge: runs one contribution in a QuickJS sandbox that can reach no tool, checks it against the task's cases and
// times the bench. Whatever the source is (agent, model or human), it is data and only ever runs here.
import { pathToFileURL } from "node:url";
import type { Task } from "./tasks.ts";

export type Verdict = { ok: boolean; ms: number; error?: string };
type Sandbox = { execute(code: string): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>; close(): Promise<void> };
export type Codemode = { CodemodeSandbox: new (o: { timeoutMs: number; tools: []; memoryLimitBytes?: number }) => Sandbox };

export const TIMEOUT_MS = 5000;
export const MAX_SOURCE_CHARS = 16_000;
const MAX_PARALLEL = 2;

/** Loads pi-codemode (PI_CODEMODE_DIR overrides the location); null when it cannot be loaded. */
export async function loadCodemode(dir = process.env.PI_CODEMODE_DIR): Promise<Codemode | null> {
	try {
		return (dir ? await import(pathToFileURL(`${dir}/dist/index.js`).href) : await import("@earendil-works/pi-codemode")) as Codemode;
	} catch { return null; }
}

/** Process-wide cap on running sandboxes, so a busy public endpoint cannot start unbounded workers. */
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
	running++;
	try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

export async function judge(cm: Codemode, task: Task, source: string): Promise<Verdict> {
	if (source.length > MAX_SOURCE_CHARS) return { ok: false, ms: TIMEOUT_MS, error: "source too long" };
	return slot(async () => {
		const sandbox = new cm.CodemodeSandbox({ timeoutMs: TIMEOUT_MS, tools: [], memoryLimitBytes: 64 * 1024 * 1024 });
		try {
			const r = await sandbox.execute(`${source}
const __cases = ${JSON.stringify(task.cases)};
for (const c of __cases) {
	const got = ${task.fn}(...c.args);
	if (JSON.stringify(got) !== JSON.stringify(c.expect)) return { ok: false, error: "wrong on " + JSON.stringify(c.args).slice(0, 80) };
}
const __t = Date.now();
${task.bench}
return { ok: true, ms: Date.now() - __t };`);
			if (!r.ok) return { ok: false, ms: TIMEOUT_MS, error: (r.error?.message ?? "failed").slice(0, 200) };
			const v = r.value as { ok: boolean; ms?: number; error?: string };
			return v.ok ? { ok: true, ms: v.ms ?? 0 } : { ok: false, ms: TIMEOUT_MS, error: v.error };
		} catch (e) {
			return { ok: false, ms: TIMEOUT_MS, error: (e as Error).message.slice(0, 200) };
		} finally {
			await sandbox.close().catch(() => {});
		}
	});
}
