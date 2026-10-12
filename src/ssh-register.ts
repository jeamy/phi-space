// Read-only metadata over a pinned SSH forced command; no shell interpolation or operator CAS capability.
import { spawn } from "node:child_process";
import { RegisterConflict, type RecoveryRegister, type RegisterRecord } from "./recovery-register.ts";
import type { Json } from "./core.ts";
export class SshRecoveryRegister implements RecoveryRegister {
	private target: string; private timeoutMs: number; private operator: boolean;
	constructor(target: string, timeoutMs = 6000, o: { operator?: boolean } = {}) {
		if (!/^[A-Za-z0-9_.@:-]+$/.test(target) || target.startsWith("-")) throw new Error("invalid register SSH target");
		this.target = target; this.timeoutMs = timeoutMs; this.operator = o.operator ?? false;
	}
	private call<T>(call: Record<string, unknown>): Promise<T> {
		const key = call.key;
		if (typeof key !== "string" || !key || key.length > 512) return Promise.reject(new Error("invalid register key"));
		return new Promise((resolve, reject) => {
			const child = spawn("ssh", ["-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", this.target, this.operator ? "pi-spaces-register-operator" : "pi-spaces-register-read"], { stdio: ["pipe", "pipe", "ignore"] });
			let output = Buffer.alloc(0), settled = false;
			const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(value); };
			const timer = setTimeout(() => finish(new Error("independent SSH register timed out")), this.timeoutMs);
			child.on("error", e => finish(e)); child.stdin.on("error", e => finish(e));
			child.stdout.on("data", b => { output = Buffer.concat([output, b]); if (output.length > 256 * 1024) finish(new Error("register response exceeds budget")); });
			child.on("close", code => { if (code !== 0) return finish(new Error("register SSH command failed")); try { const r = JSON.parse(output.toString("utf8")); if (!r.ok) { if (r.error?.code === "RequestConflict") throw new RegisterConflict(r.error.message); throw new Error(r.error?.message ?? r.error ?? "register unavailable"); } finish(undefined, r.result); } catch (e) { finish(e as Error); } });
			child.stdin.end(JSON.stringify(call));
		});
	}
	get<T extends Json>(key: string): Promise<RegisterRecord<T> | null> { return this.call({ method: "get", key }); }
	compareAndSet<T extends Json>(key: string, expected: number | null, value: T): Promise<RegisterRecord<T>> { return this.operator ? this.call({ method: "compareAndSet", key, expectedVersion: expected, value }) : Promise.reject(new Error("SSH member register access is read-only")); }
	close(): void {}
}
