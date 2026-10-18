// Container fencing (docs/federation-plan-v3.md 5.5, plan 3.3) for a host that is a docker container started by a
// systemd user unit, as host-a on big. It runs on the docker host, outside the fenced container, behind the same
// mutual-TLS `serveFencing` service as the netcup adapter. Only pinned host IDs can be fenced; a caller never names a
// container. "Restart-locked" means three independent locks, each re-read by `verify`: the container is stopped, its
// docker restart policy is `no`, and a drop-in keeps its unit from starting.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { atomicJsonFile } from "./json-file.ts";
import { join } from "node:path";
import type { FenceProof, FencingAdapter } from "./replica-control.ts";

export class ContainerFencingError extends Error {}
export type ContainerPin = { container: string; unit: string };
export type CommandRunner = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
/** Runs a command without a shell; output is bounded. */
export const execRunner: CommandRunner = (command, args) => new Promise(resolve => {
	execFile(command, args, { timeout: 120_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) =>
		resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, UNIT = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}\.service$/;
const DROP_IN = "zz-phi-spaces-fenced.conf";

export class ContainerFencing implements FencingAdapter {
	readonly kind = "container" as const;
	private pins: Record<string, ContainerPin>; private run: CommandRunner; private unitDir: string; private stateFile: string;
	/** `unitDir` is the systemd user unit directory; `stateFile` keeps the restart policy that fence replaced. */
	constructor(o: { pins: Record<string, ContainerPin>; unitDir: string; stateFile: string; run?: CommandRunner }) {
		for (const [h, p] of Object.entries(o.pins)) if (!NAME.test(h) || !NAME.test(String(p?.container)) || !UNIT.test(String(p?.unit))) throw new ContainerFencingError(`invalid container pin for ${h}`);
		this.pins = { ...o.pins }; this.run = o.run ?? execRunner; this.unitDir = o.unitDir; this.stateFile = o.stateFile;
	}
	private pinned(hostId: string): ContainerPin {
		const pin = Object.hasOwn(this.pins, hostId) ? this.pins[hostId] : undefined;
		if (!pin) throw new ContainerFencingError(`${hostId} is not a container fencing target`);
		return pin;
	}
	private dropIn(pin: ContainerPin) { return join(this.unitDir, pin.unit + ".d", DROP_IN); }
	private async must(command: string, args: string[]): Promise<string> {
		const r = await this.run(command, args);
		if (r.code !== 0) throw new ContainerFencingError(`${command} ${args[0] ?? ""} failed: ${r.stderr.trim().slice(0, 200)}`);
		return r.stdout;
	}
	private async live(pin: ContainerPin) {
		const i = JSON.parse(await this.must("docker", ["inspect", "--format", "{{json .State.Running}} {{json .HostConfig.RestartPolicy.Name}}", pin.container]).then(s => "[" + s.trim().split(" ").join(",") + "]"));
		const unit = (await this.run("systemctl", ["--user", "is-active", pin.unit])).stdout.trim();
		return { running: i[0] === true, restartPolicy: String(i[1]), unit, dropIn: existsSync(this.dropIn(pin)) };
	}
	private saved(): Record<string, { restartPolicy: string }> { return atomicJsonFile<Record<string, { restartPolicy: string }>>(this.stateFile, () => ({})).read(); }
	private save(v: Record<string, { restartPolicy: string }>) { atomicJsonFile(this.stateFile, () => ({})).write(v); }
	async fence(hostId: string, reason: string): Promise<FenceProof> {
		const pin = this.pinned(hostId);let live = await this.live(pin);
		const state = this.saved();if (!state[hostId]) { state[hostId] = { restartPolicy: live.restartPolicy }; this.save(state); }
		// The unit lock first: a stopped container must not come back through its unit or an operator restart.
		mkdirSync(join(this.unitDir, pin.unit + ".d"), { recursive: true });
		writeFileSync(this.dropIn(pin), `# phi-spaces fencing: ${reason.replace(/\n/g, " ").slice(0, 200)}\n[Unit]\nConditionPathExists=/nonexistent/phi-spaces-fenced\n`, { mode: 0o644 });
		await this.must("systemctl", ["--user", "daemon-reload"]);
		await this.run("systemctl", ["--user", "stop", pin.unit]);
		if (live.restartPolicy !== "no") await this.must("docker", ["update", "--restart=no", pin.container]);
		if (live.running) await this.must("docker", ["stop", "--time", "30", pin.container]);
		live = await this.live(pin);
		if (live.running || live.restartPolicy !== "no" || !live.dropIn || live.unit === "active") throw new ContainerFencingError(`${pin.container} is not fenced (${JSON.stringify(live)})`);
		return { hostId, kind: this.kind, observedAt: Date.now(), evidence: { provider: "docker", container: pin.container, unit: pin.unit, running: false, restartPolicy: "no", unitLocked: true, reason }, restartLocked: true };
	}
	/** Re-reads the pinned container and unit; the proof's evidence never selects them. */
	async verify(proof: FenceProof): Promise<boolean> {
		try {
			if (proof?.kind !== this.kind || proof.restartLocked !== true) return false;
			const live = await this.live(this.pinned(proof.hostId));
			return !live.running && live.restartPolicy === "no" && live.dropIn && live.unit !== "active";
		} catch { return false; }
	}
	/** Called by releaseHostToQuarantine after the boot CAS: unlocks and starts the unit, whose daemon boots in quarantine. */
	async release(hostId: string, mode: "quarantine"): Promise<void> {
		if (mode !== "quarantine") throw new ContainerFencingError("release only leads into quarantine");
		const pin = this.pinned(hostId), state = this.saved(), previous = state[hostId]?.restartPolicy;
		// Without the state fence saved, a guessed restart policy would be a decision nobody made: fail closed.
		if (previous === undefined) throw new ContainerFencingError(`no saved fence state for ${hostId}; restore the state file entry or set the restart policy deliberately`);
		// A lock written under another drop-in name (an earlier release of this adapter) would keep the unit from
		// starting after ours is gone; it is reported, not removed: which version fenced the host is an operator decision.
		const dir = join(this.unitDir, pin.unit + ".d"), foreign = existsSync(dir) ? readdirSync(dir).filter(n => n !== DROP_IN && /^zz-.+-fenced\.conf$/.test(n)) : [];
		if (foreign.length) throw new ContainerFencingError(`${pin.unit} carries another fencing drop-in (${foreign.join(", ")}); remove it deliberately before release`);
		if (existsSync(this.dropIn(pin))) unlinkSync(this.dropIn(pin));
		await this.must("systemctl", ["--user", "daemon-reload"]);
		if (previous !== "no") await this.must("docker", ["update", `--restart=${previous}`, pin.container]);
		await this.must("systemctl", ["--user", "start", pin.unit]);
		const live = await this.live(pin);if (!live.running) throw new ContainerFencingError(`${pin.container} did not start`);
		delete state[hostId]; this.save(state);
	}
}
