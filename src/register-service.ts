// Private Unix endpoints: members can read metadata; only the operator endpoint can CAS.
import type { RecoveryRegister, RegisterRecord } from "./recovery-register.ts";
import { RegisterConflict } from "./recovery-register.ts";
import type { Json } from "./core.ts";
import { serveSpace, socketTransport, type SocketTransport } from "./socket.ts";
import { mkdirSync, lstatSync } from "node:fs";
import { dirname } from "node:path";

export async function serveRegister(register: RecoveryRegister, path: string, o: { writable?: boolean; maxFrameBytes?: number } = {}) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const parent = lstatSync(dirname(path));
	if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error("register socket directory must be private");
	return serveSpace({ async handleText(text) {
		try {
			const c = JSON.parse(text);
			if (typeof c.key !== "string" || !c.key || c.key.length > 512) throw new Error("invalid register key");
			if (c.method === "get") return JSON.stringify({ ok: true, result: await register.get(c.key) });
			if (c.method !== "compareAndSet" || !o.writable) return JSON.stringify({ ok: false, error: { code: "PermissionDenied", message: "this register endpoint is read-only" } });
			return JSON.stringify({ ok: true, result: await register.compareAndSet(c.key, c.expectedVersion, c.value) });
		} catch (e) { return JSON.stringify({ ok: false, error: { code: e instanceof RegisterConflict ? "RequestConflict" : "BadRequest", message: e instanceof Error ? e.message : String(e) } }); }
	} }, { listen: { path }, maxFrameBytes: o.maxFrameBytes ?? 256 * 1024 });
}
export class SocketRecoveryRegister implements RecoveryRegister {
	private transport: SocketTransport; private writable: boolean; private timeoutMs: number;
	constructor(path: string, o: { writable?: boolean; timeoutMs?: number } = {}) { this.transport = socketTransport({ path }); this.writable = o.writable ?? false; this.timeoutMs = o.timeoutMs ?? 4000; }
	private async call(c: Record<string, unknown>): Promise<any> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const reply = JSON.parse(await Promise.race([this.transport.request(JSON.stringify(c)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("independent register timed out")), this.timeoutMs); })]));
			if (!reply.ok) { if (reply.error?.code === "RequestConflict") throw new RegisterConflict(reply.error.message); throw new Error(reply.error?.message ?? "register unavailable"); }
			return reply.result;
		} finally { clearTimeout(timer); }
	}
	get<T extends Json>(key: string): Promise<RegisterRecord<T> | null> { return this.call({ method: "get", key }); }
	compareAndSet<T extends Json>(key: string, expectedVersion: number | null, value: T): Promise<RegisterRecord<T>> {
		if (!this.writable) return Promise.reject(new Error("member register access is read-only"));
		return this.call({ method: "compareAndSet", key, expectedVersion, value });
	}
	close(): void { this.transport.close(); }
}
