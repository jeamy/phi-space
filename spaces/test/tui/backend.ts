import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import type { Action, Service } from "./actions.ts";
import type { Inspection } from "../testbed/inspect.ts";

export type RunRecord = {
	version: 1; id: string; action: string; label: string; scope: string; command: string;
	startedAt: string; endedAt?: string; status: "running" | "passed" | "completed" | "failed" | "preview" | "cancelled" | "unknown";
	exitCode?: number | null; signal?: string | null; log: string; counts?: { tests: number; passed: number; failed: number; skipped: number };
};
export const clean = (s: string): string => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
export function commandFor(root: string, a: Action): { command: string; args: string[] } {
	return a.scope === "remote" ? { command: "bash", args: [join(root, "test/testbed/testbed.sh"), ...a.args] } : { command: a.program === "node" ? process.execPath : "npm", args: a.args };
}
export function outcome(a: Action, code: number | null, signal: string | null, cancelled = false): RunRecord["status"] {
	if (cancelled) return a.scope === "remote" ? "unknown" : "cancelled";
	return code === 0 && signal === null ? a.test ? "passed" : "completed" : "failed";
}
export function tapCounts(output: string): RunRecord["counts"] {
	const get = (key: string) => [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))].at(-1)?.[1];
	const tests = get("tests");
	return tests === undefined ? undefined : { tests: Number(tests), passed: Number(get("pass") ?? 0), failed: Number(get("fail") ?? 0), skipped: Number(get("skipped") ?? 0) };
}

export class Backend {
	readonly root: string;
	readonly reportsDir: string;
	active?: ChildProcess;
	constructor(root: string, reportsDir = join(root, "dist/tui-runs")) { this.root = root; this.reportsDir = reportsDir; }
	async history(): Promise<RunRecord[]> {
		try {
			const names = (await readdir(this.reportsDir)).filter(n => n.endsWith(".json")).sort().slice(-100).reverse();
			return await Promise.all(names.map(async n => {
				try {
					const r = JSON.parse(await readFile(join(this.reportsDir, n), "utf8")) as RunRecord;
					return r.status === "running" ? { ...r, status: "unknown" as const } : r;
				} catch {
					return { version: 1, id: n, action: "unknown", label: `Unlesbarer Bericht: ${n}`, scope: "unknown", command: "", startedAt: "unknown", status: "unknown", log: join(this.reportsDir, n.replace(/\.json$/, ".log")) } as RunRecord;
				}
			}));
		} catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
	}
	async run(a: Action, dry: boolean, onOutput: (text: string) => void): Promise<RunRecord> {
		if (a.unavailable) throw new Error(a.unavailable);
		if (this.active) throw new Error("Ein Vorgang läuft bereits");
		const spec = commandFor(this.root, a);
		const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
		await mkdir(this.reportsDir, { recursive: true });
		const record: RunRecord = { version: 1, id, action: a.id, label: a.label, scope: a.scope, command: [spec.command, ...spec.args].map(quote).join(" "), startedAt: new Date().toISOString(), status: dry ? "preview" : "running", log: join(this.reportsDir, `${id}.log`) };
		const reportFile = join(this.reportsDir, `${id}.json`);
		await writeFile(reportFile, JSON.stringify(record, null, 2), { mode: 0o600 });
		if (dry) {
			onOutput(`VORSCHAU: ${record.command}\nNichts ausgeführt; kein Testnachweis.\n`);
			await writeFile(record.log, `VORSCHAU: ${record.command}\n`, { mode: 0o600 });
			record.endedAt = new Date().toISOString();
		} else {
			const log = createWriteStream(record.log, { mode: 0o600 });
			const logged = finished(log); void logged.catch(() => {});
			let cancelled = false, tail = "";
			const child = spawn(spec.command, spec.args, { cwd: this.root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
			this.active = child;
			const collect = (chunk: Buffer) => { const text = chunk.toString(); tail = (tail + text).slice(-128_000); log.write(text); onOutput(text); };
			child.stdout!.on("data", collect); child.stderr!.on("data", collect);
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			this.cancel = () => {
				cancelled = true;
				this.signal(child, "SIGTERM");
				killTimer = setTimeout(() => this.signal(child, "SIGKILL"), 1500);
			};
			try {
				const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
					child.on("error", e => { collect(Buffer.from(`${e.message}\n`)); });
					child.on("close", (code, signal) => resolve({ code, signal }));
				});
				record.exitCode = result.code; record.signal = result.signal;
				record.status = outcome(a, result.code, result.signal, cancelled);
				record.counts = tapCounts(clean(tail));
			} finally {
				clearTimeout(killTimer); this.active = undefined; this.cancel = () => {};
				log.end(); await logged;
				record.endedAt = new Date().toISOString();
			}
		}
		await writeFile(reportFile, JSON.stringify(record, null, 2), { mode: 0o600 });
		return record;
	}
	cancel: () => void = () => {};
	private signal(child: ChildProcess, signal: NodeJS.Signals): void {
		try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
	}
	async snapshot(service: Service, localDir?: string): Promise<Inspection> {
		if (localDir) { const { inspect } = await import("../testbed/inspect.ts"); return inspect(localDir); }
		const a: Action = { id: "inspect", group: "", label: "", scope: "remote", args: ["inspect", service] };
		const spec = commandFor(this.root, a);
		const child = spawn(spec.command, spec.args, { cwd: this.root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
		let out = "", err = "", size = 0;
		const timer = setTimeout(() => this.signal(child, "SIGKILL"), 20_000);
		try {
			return await new Promise<Inspection>((resolve, reject) => {
				child.stdout!.on("data", c => { size += c.length; if (size > 32 * 1024 * 1024) this.signal(child, "SIGKILL"); else out += c.toString(); });
				child.stderr!.on("data", c => { err = (err + c.toString()).slice(-4000); });
				child.on("error", reject);
				child.on("close", code => {
					try {
						const value = JSON.parse(out.trim()) as Inspection;
						if (value.version !== 1 || !Array.isArray(value.spaces) || !Array.isArray(value.errors)) throw new Error("Ungültige Inspection-Antwort");
						if (code !== 0 && value.errors.length === 0) throw new Error(`Inspection beendet mit ${code}`);
						resolve(value);
					} catch { reject(new Error(clean(err || out || `Inspection fehlgeschlagen (Exit ${code}); Container/Artefakt prüfen`).trim())); }
				});
			});
		} finally { clearTimeout(timer); }
	}
}
