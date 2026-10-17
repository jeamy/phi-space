// netcup SCP REST fencing (docs/federation-plan-v3.md 5.5, plan 3.3) and its mutual-TLS service.
// The SCP token stays on the fencing host (vpsc); transition hosts use `TlsFencing`, a thin client. Only hosts in the
// local pin list (host ID -> server ID + MAC) can be fenced; a caller never supplies a server ID. With netcup,
// "restart-locked" means autostart off and the server observed SHUTOFF; the real barrier against an operator
// restart is the `fenced` boot state with revoked permits in the recovery register.
import tls from "node:tls";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { privateFile } from "./keys.ts";
import type { RegisterTlsClient, RegisterTlsIdentity } from "./tls-register.ts";
import type { FenceProof, FencingAdapter } from "./replica-control.ts";

const SCP = "https://www.servercontrolpanel.de";
type Fetch = typeof fetch;
export class NetcupError extends Error {}
export type NetcupServerPin = { serverId: number; mac: string };
type Live = { state: string; autostart: boolean };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Minimal SCP REST client: server state, interfaces, one-attribute patches with task polling. */
export class NetcupScp {
	private o: { fetch: Fetch; accessToken: () => Promise<string>; base: string; pollMs: number; taskTimeoutMs: number };
	constructor(o: { accessToken: () => Promise<string>; fetch?: Fetch; base?: string; pollMs?: number; taskTimeoutMs?: number }) {
		this.o = { fetch: o.fetch ?? fetch, accessToken: o.accessToken, base: o.base ?? SCP + "/scp-core/api/v1", pollMs: o.pollMs ?? 2000, taskTimeoutMs: o.taskTimeoutMs ?? 180_000 };
	}
	private async req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
		const r = await this.o.fetch(this.o.base + path, { method, headers: { Authorization: "Bearer " + await this.o.accessToken(), Accept: "application/json", ...body === undefined ? {} : { "Content-Type": "application/merge-patch+json" } }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
		const text = await r.text();let parsed: any = null;try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
		if (r.status === 503) throw new NetcupError("netcup node is in maintenance mode");
		if (r.status >= 400) throw new NetcupError(`netcup ${method} ${path.replace(/\?.*/, "")} failed: ${r.status} ${typeof parsed?.message === "string" ? parsed.message.slice(0, 200) : ""}`.trim());
		return { status: r.status, body: parsed };
	}
	async live(serverId: number): Promise<Live> {
		const s = (await this.req("GET", `/servers/${serverId}`)).body, li = s?.serverLiveInfo;
		if (s?.id !== serverId || typeof li?.state !== "string" || typeof li?.autostart !== "boolean") throw new NetcupError("unexpected netcup server response");
		return { state: li.state, autostart: li.autostart };
	}
	async macs(serverId: number): Promise<string[]> {
		const list = (await this.req("GET", `/servers/${serverId}/interfaces`)).body;
		if (!Array.isArray(list)) throw new NetcupError("unexpected netcup interface response");
		return list.map(i => String(i?.mac ?? "").toLowerCase());
	}
	/** One attribute per call (SCP rule); a 202 task is polled until FINISHED. */
	async patch(serverId: number, body: Record<string, unknown>, stateOption?: string): Promise<void> {
		const r = await this.req("PATCH", `/servers/${serverId}${stateOption ? "?stateOption=" + encodeURIComponent(stateOption) : ""}`, body);
		if (r.status !== 202) return;
		const uuid = r.body?.uuid;if (typeof uuid !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(uuid)) throw new NetcupError("netcup task without valid id");
		for (const deadline = Date.now() + this.o.taskTimeoutMs; Date.now() < deadline; await sleep(this.o.pollMs)) {
			const state = (await this.req("GET", `/tasks/${uuid}`)).body?.state;
			if (state === "FINISHED") return;
			if (["ERROR", "CANCELED", "ROLLBACK", "WAITING_FOR_CANCEL"].includes(state)) throw new NetcupError(`netcup task ${state}`);
		}
		throw new NetcupError("netcup task timed out");
	}
}

/** Previous autostart values, so release restores what fence changed. */
export interface NetcupFenceState { load(hostId: string): { autostart: boolean } | null; save(hostId: string, v: { autostart: boolean }): void; clear(hostId: string): void }
export function fileFenceState(path: string): NetcupFenceState {
	const read = (): Record<string, { autostart: boolean }> => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	const write = (v: Record<string, { autostart: boolean }>) => { writeFileSync(path + ".tmp", JSON.stringify(v), { mode: 0o600 }); renameSync(path + ".tmp", path); };
	return { load: h => read()[h] ?? null, save: (h, v) => write({ ...read(), [h]: v }), clear: h => { const all = read(); delete all[h]; write(all); } };
}
export function memoryFenceState(): NetcupFenceState {
	const m = new Map<string, { autostart: boolean }>();
	return { load: h => m.get(h) ?? null, save: (h, v) => void m.set(h, v), clear: h => void m.delete(h) };
}

export class NetcupFencing implements FencingAdapter {
	readonly kind = "cloud" as const;
	private scp: NetcupScp; private pins: Record<string, NetcupServerPin>; private state: NetcupFenceState;
	constructor(scp: NetcupScp, pins: Record<string, NetcupServerPin>, state: NetcupFenceState = memoryFenceState()) {
		for (const [h, p] of Object.entries(pins)) if (!h || !Number.isSafeInteger(p?.serverId) || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(String(p?.mac))) throw new NetcupError(`invalid netcup pin for ${h}`);
		this.scp = scp; this.pins = { ...pins }; this.state = state;
	}
	/** Server ID from the local pin list only, and the server must still carry the pinned MAC. */
	private async pinned(hostId: string): Promise<NetcupServerPin> {
		const pin = Object.hasOwn(this.pins, hostId) ? this.pins[hostId] : undefined;
		if (!pin) throw new NetcupError(`${hostId} is not a netcup fencing target`);
		if (!(await this.scp.macs(pin.serverId)).includes(pin.mac)) throw new NetcupError(`netcup server ${pin.serverId} no longer carries the pinned interface of ${hostId}`);
		return pin;
	}
	async fence(hostId: string, reason: string): Promise<FenceProof> {
		const pin = await this.pinned(hostId);let live = await this.scp.live(pin.serverId);
		if (!this.state.load(hostId)) this.state.save(hostId, { autostart: live.autostart });
		if (live.autostart !== false) await this.scp.patch(pin.serverId, { autostart: false });
		if (live.state !== "SHUTOFF") await this.scp.patch(pin.serverId, { state: "OFF" }, "POWEROFF");
		live = await this.scp.live(pin.serverId);
		if (live.state !== "SHUTOFF" || live.autostart !== false) throw new NetcupError(`netcup server ${pin.serverId} is ${live.state} (autostart ${live.autostart}); not fenced`);
		return { hostId, kind: this.kind, observedAt: Date.now(), evidence: { provider: "netcup", serverId: pin.serverId, state: live.state, autostart: live.autostart, reason }, restartLocked: true };
	}
	/** Re-queries the live state of the pinned server; the proof's evidence never selects the server. */
	async verify(proof: FenceProof): Promise<boolean> {
		try {
			if (proof?.kind !== this.kind || proof.restartLocked !== true) return false;
			const pin = await this.pinned(proof.hostId), live = await this.scp.live(pin.serverId);
			return live.state === "SHUTOFF" && live.autostart === false;
		} catch { return false; }
	}
	/** Called by releaseHostToQuarantine after the boot CAS: restores autostart, then powers on. */
	async release(hostId: string, mode: "quarantine"): Promise<void> {
		if (mode !== "quarantine") throw new NetcupError("release only leads into quarantine");
		const pin = await this.pinned(hostId), previous = this.state.load(hostId)?.autostart ?? true;let live = await this.scp.live(pin.serverId);
		if (live.autostart !== previous) await this.scp.patch(pin.serverId, { autostart: previous });
		if (live.state !== "RUNNING") await this.scp.patch(pin.serverId, { state: "ON" });
		live = await this.scp.live(pin.serverId);if (live.state !== "RUNNING") throw new NetcupError(`netcup server ${pin.serverId} did not start (${live.state})`);
		this.state.clear(hostId);
	}
}

/**
 * Access tokens from the offline refresh token file. Keycloak rotates refresh tokens, so read-refresh-write runs under
 * an exclusive lock file shared with the login script; the rotated token is written atomically (0600).
 */
export function fileTokenProvider(path: string, o: { fetch?: Fetch; oidc?: string; lockStaleMs?: number } = {}): () => Promise<string> {
	const f = o.fetch ?? fetch, oidc = o.oidc ?? SCP + "/realms/scp/protocol/openid-connect", lock = path + ".lock";let cached: { token: string; until: number } | null = null;
	const acquire = async () => {
		for (let i = 0; i < 300; i++) {
			try { closeSync(openSync(lock, "wx", 0o600)); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
			try { if (Date.now() - statSync(lock).mtimeMs > (o.lockStaleMs ?? 60_000)) unlinkSync(lock); } catch { /* removed meanwhile */ }
			await sleep(100);
		}
		throw new NetcupError("netcup token lock busy");
	};
	return async () => {
		if (cached && cached.until > Date.now()) return cached.token;
		await acquire();
		try {
			const state = JSON.parse(privateFile(path).toString("utf8"));
			if (typeof state.refreshToken !== "string") throw new NetcupError("no netcup refresh token stored");
			const r = await f(oidc + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ client_id: "scp", grant_type: "refresh_token", refresh_token: state.refreshToken }).toString(), signal: AbortSignal.timeout(30_000) });
			const tok: any = await r.json().catch(() => ({}));
			if (r.status !== 200 || typeof tok.access_token !== "string") throw new NetcupError(`netcup token refresh failed: ${typeof tok.error === "string" ? tok.error : r.status}`);
			if (typeof tok.refresh_token === "string" && tok.refresh_token !== state.refreshToken) {
				writeFileSync(path + ".tmp", JSON.stringify({ ...state, refreshToken: tok.refresh_token, rotatedAt: Math.floor(Date.now() / 1000) }, null, 1), { mode: 0o600 }); renameSync(path + ".tmp", path);
			}
			cached = { token: tok.access_token, until: Date.now() + Math.max(0, (Number(tok.expires_in) || 60) - 30) * 1000 };
			return cached.token;
		} finally { try { unlinkSync(lock); } catch { /* already gone */ } }
	};
}

// --- mutual-TLS service: only operator certificates may fence, verify or release. ---
const BUDGET = 64 * 1024;
const validProof = (p: any): p is FenceProof => !!p && typeof p === "object" && typeof p.hostId === "string" && typeof p.kind === "string" && typeof p.observedAt === "number" && typeof p.restartLocked === "boolean";
/** `allowAddresses`: optional source addresses; any other connection is dropped before the TLS handshake. */
export async function serveFencing(adapter: FencingAdapter, o: RegisterTlsIdentity & { host: string; port: number; peers: Record<string, { operator?: boolean }>; allowAddresses?: string[] }) {
	const open = new Set<tls.TLSSocket>();let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
	const server = tls.createServer({ ca: privateFile(o.caFile), cert: privateFile(o.certFile), key: privateFile(o.keyFile), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3", handshakeTimeout: 4000 }, socket => {
		const c = socket.getPeerCertificate(), fp = c.raw ? createHash("sha256").update(c.raw).digest("hex") : "";
		if (!socket.authorized || !o.peers[fp]?.operator || open.size >= 8) { socket.destroy(); return; }
		open.add(socket); socket.setTimeout(300_000, () => socket.destroy()); socket.on("error", () => {}); socket.on("close", () => open.delete(socket));
		let input = Buffer.alloc(0), started = false;
		socket.on("data", async data => {
			if (started) { socket.destroy(); return; }
			input = Buffer.concat([input, typeof data === "string" ? Buffer.from(data) : data]);if (input.length > BUDGET) { socket.destroy(); return; }
			const end = input.indexOf("\n");if (end < 0) return;started = true;
			try {
				const q = JSON.parse(input.subarray(0, end).toString("utf8"));
				if (typeof q.hostId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(q.hostId)) throw new NetcupError("invalid host ID");
				let result: unknown;
				if (q.method === "fence") { if (typeof q.reason !== "string" || q.reason.length > 200) throw new NetcupError("invalid reason"); result = await serial(() => adapter.fence(q.hostId, q.reason)); }
				else if (q.method === "verify") { if (!validProof(q.proof) || q.proof.hostId !== q.hostId) throw new NetcupError("invalid proof"); result = await serial(() => adapter.verify(q.proof)); }
				else if (q.method === "release") { await serial(() => adapter.release(q.hostId, "quarantine")); result = null; }
				else throw new NetcupError("unknown method");
				socket.end(JSON.stringify({ ok: true, result }) + "\n");
			} catch (e) { socket.end(JSON.stringify({ ok: false, error: { message: e instanceof Error ? e.message.slice(0, 300) : String(e) } }) + "\n"); }
		});
	});
	server.on("tlsClientError", () => {});
	if (o.allowAddresses) { const allow = new Set(o.allowAddresses); server.prependListener("connection", s => { if (!allow.has(String(s.remoteAddress).replace(/^::ffff:/, ""))) s.destroy(); }); }
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port, o.host, () => { server.removeListener("error", reject); resolve(); }); });
	return { address: () => server.address(), close: async () => { for (const s of open) s.destroy(); await new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res())); } };
}
/** Client side on the transition host; `kind` must match the remote adapter's kind. */
export class TlsFencing implements FencingAdapter {
	readonly kind: FencingAdapter["kind"]; private o: RegisterTlsClient;
	constructor(o: RegisterTlsClient & { kind?: FencingAdapter["kind"] }) { this.o = o; this.kind = o.kind ?? "cloud"; }
	private call(q: unknown): Promise<any> {
		const o = this.o, body = JSON.stringify(q) + "\n";
		return new Promise((resolve, reject) => {
			const socket = tls.connect({ host: o.host, port: o.port, servername: o.serverName, ca: privateFile(o.caFile), cert: privateFile(o.certFile), key: privateFile(o.keyFile), rejectUnauthorized: true, minVersion: "TLSv1.3" });
			let input = Buffer.alloc(0), done = false;
			const finish = (e?: Error, v?: unknown) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); e ? reject(e) : resolve(v); };
			const timer = setTimeout(() => finish(new Error("fencing service timed out")), o.timeoutMs ?? 240_000);
			socket.on("secureConnect", () => socket.write(body)); socket.on("error", e => finish(e)); socket.on("close", () => { if (!done) finish(new Error("fencing service disconnected")); });
			socket.on("data", d => { input = Buffer.concat([input, typeof d === "string" ? Buffer.from(d) : d]); if (input.length > BUDGET) return finish(new Error("fencing response exceeds budget")); const end = input.indexOf("\n"); if (end < 0) return; try { const r = JSON.parse(input.subarray(0, end).toString("utf8")); r.ok ? finish(undefined, r.result) : finish(new NetcupError(String(r.error?.message ?? "fencing refused"))); } catch (e) { finish(e as Error); } });
		});
	}
	async fence(hostId: string, reason: string): Promise<FenceProof> { const p = await this.call({ method: "fence", hostId, reason }); if (!validProof(p) || p.hostId !== hostId || p.kind !== this.kind) throw new NetcupError("invalid fencing proof"); return p; }
	async verify(proof: FenceProof): Promise<boolean> { return (await this.call({ method: "verify", hostId: proof.hostId, proof })) === true; }
	async release(hostId: string): Promise<void> { await this.call({ method: "release", hostId }); }
}
