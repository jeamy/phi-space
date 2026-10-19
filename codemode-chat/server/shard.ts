// The second ("nano") judge shard: connection helpers shared by the hub (big) and the headless host.
import os from "node:os";
import { RemoteSpace, socketTransport, type ListenTarget, type SpaceLike } from "../../src/index.ts";

export const JUDGE_ALIAS = "codemode-judge";
export type HostFacts = { name: string; cpu: string; cores: number; memGiB: number; platform: string; startedAt: number };

/** `tcp:host:port` or `unix:/path` (the same notation as SWARM_REMOTE / SWARM_LISTEN in the help system). */
export function parseTarget(spec: string): ListenTarget {
	if (spec.startsWith("tcp:")) {
		const [host, port] = spec.slice(4).split(":");
		if (!host || !Number.isSafeInteger(Number(port))) throw new Error(`tcp target expects host:port, got ${spec}`);
		return { host, port: Number(port) };
	}
	return { path: spec.replace(/^unix:/, "") };
}

export function remoteJudgeSpace(spec: string): SpaceLike {
	// Unanswered calls on a cut socket fail fast and the transport reconnects on the next call.
	return new RemoteSpace(socketTransport(parseTarget(spec), { connectTimeoutMs: Number(process.env.CODEMODE_REMOTE_CONNECT_TIMEOUT ?? 5_000), requestTimeoutMs: Number(process.env.CODEMODE_REMOTE_TIMEOUT ?? 20_000) }), {
		space: JUDGE_ALIAS,
		callTimeoutMs: Number(process.env.CODEMODE_REMOTE_CALL_TIMEOUT ?? 8_000),
		attempts: Number(process.env.CODEMODE_REMOTE_ATTEMPTS ?? 3),
	});
}

export function hostFacts(): HostFacts {
	const cpus = os.cpus();
	return {
		name: process.env.CODEMODE_HOST_NAME || os.hostname(),
		cpu: (cpus[0]?.model ?? "unknown CPU").replace(/\s+/g, " ").trim(),
		cores: os.availableParallelism?.() ?? cpus.length,
		memGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
		platform: `${os.type()} ${os.arch()}`,
		startedAt: Date.now(),
	};
}
