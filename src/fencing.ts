// F15: independent SSH verifies stopped normal service and a persistent restart lock; epoch is not fencing.
import { spawn } from "node:child_process";
import type { RecoveryRegister } from "./recovery-register.ts";
import type { HostBootState } from "./boot.ts";
import type { Json } from "./core.ts";
import { RecoveryBlocked } from "./recovery.ts";
export async function verifySshFence(register: RecoveryRegister, hostId: string, targets: Record<string, string>): Promise<{ hostId: string; restartLocked: boolean }> {
	const target = targets[hostId];
	if (!target || !/^[A-Za-z0-9_.@:-]+$/.test(target) || target.startsWith("-")) throw new RecoveryBlocked("no independently provisioned fencing endpoint for this host");
	const boot = await register.get<HostBootState & Record<string, Json>>(`boot:${hostId}`);
	if (!boot || Object.values(boot.value.spaces).some(s => s.durability === "sync" || !["local", "primary"].includes(s.role))) throw new RecoveryBlocked("F15 is restricted to single-space hosting without replicas");
	const status: any = await new Promise((resolve, reject) => {
		const process = spawn("ssh", ["-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", target, "pi-spaces-fence-status"], { stdio: ["ignore", "pipe", "ignore"] });
		let output = "", settled = false;
		const finish = (error?: Error, value?: any) => { if (settled) return; settled = true; clearTimeout(timer); process.kill(); error ? reject(error) : resolve(value); };
		const timer = setTimeout(() => finish(new RecoveryBlocked("independent fencing status timed out")), 10000);
		process.on("error", e => finish(e)); process.stdout.on("data", b => { output += b.toString("utf8"); if (Buffer.byteLength(output) > 8192) finish(new RecoveryBlocked("invalid fencing response")); });
		process.on("close", code => { if (code !== 0) return finish(new RecoveryBlocked("fencing SSH command failed")); try { finish(undefined, JSON.parse(output)); } catch { finish(new RecoveryBlocked("invalid fencing status")); } });
	});
	if (status.hostId !== hostId || status.restartLocked !== true || status.stopped !== true) throw new RecoveryBlocked("normal service is not independently stopped and restart-locked");
	if (boot.value.state !== "fenced") await register.compareAndSet(`boot:${hostId}`, boot.version, { ...boot.value, state: "fenced" });
	return { hostId, restartLocked: true };
}
