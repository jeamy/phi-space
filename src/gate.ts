// The space gate (federation-plan-v3.md 4.2, 4.3 layer A; AP 1b.2): a TCP front for the `space` service that listens on the
// overlay address only and decides who may talk to it from the NetBird management API. The peer is identified by the source
// address of the connection (WireGuard binds that address to the peer's key, so another peer cannot use it), resolved to
// the immutable peer id and the groups of that peer, and the groups are mapped to roles. A peer whose groups map to no role
// gets no access at all. The result is handed to the service as the identity of the connection; nothing a client sends
// can change it.
//
// Layer A depends on the management API: answers are cached for at most `cacheMs` (60 s). When the API cannot be reached
// the cache is used until it is that old, then new connections are refused, and open connections are re-checked on
// every refresh: a peer that vanished or lost its roles is disconnected.
//
// Not here yet: layer B (the per-connection key challenge, needs PeerKey entries in the control space) and the grants
// of 4.4. A host that is not enrolled with a key therefore works under its group rules alone ("A-only").
import type net from "node:net";
import type { Connection, Identity, IdentityAdapter } from "./service.ts";
import { DEFAULT_PRIVILEGED, type AuthState, type KeyDirectory } from "./auth.ts";
import { serveSpace, type SpaceServer } from "./socket.ts";
import type { SpaceService } from "./service.ts";

/** What the directory knows about one peer of the overlay. */
export type PeerInfo = { id: string; name: string; ip: string; groups: string[]; connected: boolean };
export interface PeerDirectory {
	/** The peer that owns this overlay address, or null; throws DirectoryDown when no answer younger than the cache time exists. */
	lookup(ip: string): Promise<PeerInfo | null>;
	/** Fetch a fresh list now (errors propagate). */
	refresh(): Promise<void>;
}
export class DirectoryDown extends Error {}

export type NetbirdDirectoryOptions = {
	/** Base URL of the management server, for example https://spacebird.eibrain.org */
	url: string;
	/** A token of a service user that may read peers (role Auditor is enough). */
	token: string;
	cacheMs?: number; // at most 60 s (4.3)
	timeoutMs?: number;
	now?: () => number;
	fetch?: typeof fetch;
};

const bare = (ip: string): string => ip.replace(/^::ffff:/i, "");

/** Layer A against the NetBird management API: `GET /api/peers`, cached as a whole. */
export class NetbirdDirectory implements PeerDirectory {
	private o: Required<Omit<NetbirdDirectoryOptions, "fetch">> & { fetch: typeof fetch };
	private byIp = new Map<string, PeerInfo>();
	private fetchedAt = -Infinity;
	private inflight?: Promise<void>;
	/** How many times the management API was asked (an operator's view of the load, and for tests). */
	requests = 0;

	constructor(o: NetbirdDirectoryOptions) {
		const cacheMs = Math.min(o.cacheMs ?? 60_000, 60_000);
		if (!Number.isFinite(cacheMs) || cacheMs < 1) throw new Error("cacheMs must be between 1 and 60000");
		this.o = { cacheMs, timeoutMs: 4_000, now: Date.now, fetch: globalThis.fetch.bind(globalThis), ...o };
		this.o.cacheMs = cacheMs;
	}

	async refresh(): Promise<void> {
		this.inflight ??= (async () => {
			this.requests++;
			const ctl = new AbortController();
			const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
			try {
				const res = await this.o.fetch(`${this.o.url.replace(/\/+$/, "")}/api/peers`, { headers: { Authorization: `Token ${this.o.token}`, Accept: "application/json" }, signal: ctl.signal });
				if (!res.ok) throw new DirectoryDown(`the management API answered HTTP ${res.status}`);
				const list = (await res.json()) as Array<{ id: string; name?: string; ip?: string; connected?: boolean; groups?: Array<{ name?: string }> }>;
				if (!Array.isArray(list)) throw new DirectoryDown("the management API did not return a list of peers");
				const next = new Map<string, PeerInfo>();
				for (const p of list) if (typeof p.id === "string" && typeof p.ip === "string") next.set(bare(p.ip), { id: p.id, name: p.name ?? p.id, ip: bare(p.ip), groups: (p.groups ?? []).map((g) => g.name ?? "").filter(Boolean), connected: p.connected === true });
				this.byIp = next;
				this.fetchedAt = this.o.now();
			} catch (e) {
				throw e instanceof DirectoryDown ? e : new DirectoryDown(`the management API could not be reached: ${(e as Error).message}`);
			} finally { clearTimeout(timer); }
		})().finally(() => { this.inflight = undefined; });
		return this.inflight;
	}

	async lookup(ip: string): Promise<PeerInfo | null> {
		if (this.o.now() - this.fetchedAt >= this.o.cacheMs) {
			try { await this.refresh(); }
			catch (e) { if (this.o.now() - this.fetchedAt >= this.o.cacheMs) throw e; /* a younger answer exists: use it */ }
		}
		return this.byIp.get(bare(ip)) ?? null;
	}
}

// ---- roles

/** Group name -> roles. A peer gets the union over its groups; no mapped group, no access. */
export type GroupRoles = Record<string, readonly string[]>;
export const DEFAULT_GROUP_ROLES: GroupRoles = { "space-hosts": ["member"], "space-admin": ["admin"], "space-observer": ["observer"], "space-enroll": ["unpaired"] };
export const rolesOf = (groups: readonly string[], map: GroupRoles): string[] => [...new Set(groups.flatMap((g) => map[g] ?? []))].sort();

/**
 * The identity adapter that goes with the gate: the principal is the peer id. The roles are the groups' roles (layer A);
 * privileged ones are withheld until the connection has proven an app key (layer B, auth.ts), and with a proof the roles are
 * the intersection of the groups' and the key's: neither side can add what the other did not grant (4.3).
 */
export class GateIdentity implements IdentityAdapter {
	private privileged: readonly string[];
	constructor(o: { privilegedRoles?: readonly string[] } = {}) { this.privileged = o.privilegedRoles ?? DEFAULT_PRIVILEGED; }
	authenticate(conn: Connection): Identity | null {
		const roles = (conn.credentials as { roles?: unknown } | undefined)?.roles;
		if (!conn.peerId || !Array.isArray(roles) || roles.length === 0 || !roles.every((r) => typeof r === "string")) return null;
		const proof = (conn.state as AuthState | undefined)?.proof;
		const effective = proof ? (roles as string[]).filter((r) => proof.roles.includes(r)) : (roles as string[]).filter((r) => !this.privileged.includes(r));
		// Only withheld roles and no proof: the peer is known but may do nothing yet (the refusal then says a proof is required)
		return { principal: { peerId: conn.peerId }, roles: effective };
	}
}

// ---- the gate

export type GateOptions = {
	/** The overlay address and port. A wildcard address is refused: the gate must not answer on other interfaces. */
	listen: { host: string; port: number };
	directory: PeerDirectory;
	groupRoles?: GroupRoles;
	/** The control space's keys: open connections that proved a key are closed when the key is revoked or its roles change. */
	keys?: KeyDirectory;
	/** Time to identify the peer (4.2: handshake <= 5 s); a connection that is not identified by then is closed. */
	handshakeMs?: number;
	/** Connections per peer (4.2: 32) and new connections per peer per second (a bucket of the same size). */
	maxConnectionsPerPeer?: number;
	connectionsPerSecondPerPeer?: number;
	/** How often open connections are checked against the directory again (default 15 s). */
	revalidateMs?: number;
	maxFrameBytes?: number;
	maxConnections?: number;
	idleMs?: number;
	now?: () => number;
	/** Called when a connection is refused or closed by the gate: for audit logs. */
	onEvent?: (e: { event: "accepted" | "refused" | "revoked"; ip: string; peerId?: string; reason?: string }) => void;
};
export type Gate = SpaceServer & {
	/** Check every open connection against a fresh directory; closes those whose peer is gone or whose roles changed. Returns how many. */
	revalidate(): Promise<number>;
	peers(): Array<{ peerId: string; ip: string; roles: string[]; proven: boolean }>;
};

export async function startGate(service: Pick<SpaceService, "handleText">, o: GateOptions): Promise<Gate> {
	const wildcard = ["0.0.0.0", "::", "", "*"];
	if (wildcard.includes(o.listen.host)) throw new Error("the gate listens on the overlay address only, not on a wildcard address");
	const map = o.groupRoles ?? DEFAULT_GROUP_ROLES;
	const now = o.now ?? Date.now;
	const maxPerPeer = o.maxConnectionsPerPeer ?? 32;
	const rate = o.connectionsPerSecondPerPeer ?? 32;
	const handshakeMs = o.handshakeMs ?? 5_000;
	const open = new Map<net.Socket, { peerId: string; ip: string; roles: string[]; state: Record<string, unknown> }>();
	const buckets = new Map<string, { tokens: number; at: number }>(); // per source address, before the peer is known
	const event = (e: Parameters<NonNullable<GateOptions["onEvent"]>>[0]) => { try { o.onEvent?.(e); } catch { /* an audit hook must not break the gate */ } };

	const take = (key: string): boolean => {
		const t = now();
		const b = buckets.get(key) ?? { tokens: rate, at: t };
		b.tokens = Math.min(rate, b.tokens + ((t - b.at) / 1000) * rate);
		b.at = t;
		buckets.set(key, b);
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	};

	const identify = async (socket: net.Socket): Promise<Connection | null> => {
		const ip = bare(socket.remoteAddress ?? "");
		if (!take(ip)) { event({ event: "refused", ip, reason: "too many new connections from this address" }); return null; }
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const peer = await Promise.race([
				o.directory.lookup(ip),
				new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new DirectoryDown("the peer was not identified in time")), handshakeMs); }),
			]);
			if (!peer) { event({ event: "refused", ip, reason: "no peer owns this address" }); return null; }
			const roles = rolesOf(peer.groups, map);
			if (roles.length === 0) { event({ event: "refused", ip, peerId: peer.id, reason: "no group of this peer grants a role" }); return null; }
			if ([...open.values()].filter((c) => c.peerId === peer.id).length >= maxPerPeer) { event({ event: "refused", ip, peerId: peer.id, reason: `already ${maxPerPeer} connections` }); return null; }
			if (socket.destroyed) return null;
			const state: Record<string, unknown> = {};
			open.set(socket, { peerId: peer.id, ip, roles, state });
			socket.once("close", () => open.delete(socket));
			event({ event: "accepted", ip, peerId: peer.id });
			return { peerId: peer.id, overlayIp: ip, state, credentials: { roles, groups: peer.groups, name: peer.name } };
		} catch (e) {
			event({ event: "refused", ip, reason: (e as Error).message });
			return null;
		} finally { clearTimeout(timer); }
	};

	const server = await serveSpace(service, {
		listen: o.listen,
		connection: identify,
		identifyOnConnect: true,
		...(o.maxFrameBytes === undefined ? {} : { maxFrameBytes: o.maxFrameBytes }),
		...(o.maxConnections === undefined ? {} : { maxConnections: o.maxConnections }),
		...(o.idleMs === undefined ? {} : { idleMs: o.idleMs }),
	});

	let busy = false;
	const revalidate = async (): Promise<number> => {
		if (busy) return 0;
		busy = true;
		try {
			let down = false;
			try { await o.directory.refresh(); } catch { down = true; }
			let closed = 0;
			for (const [socket, c] of [...open]) {
				let reason: string | undefined;
				try {
					const peer = await o.directory.lookup(c.ip);
					if (!peer || peer.id !== c.peerId) reason = "the peer is gone";
					else if (rolesOf(peer.groups, map).join() !== c.roles.join()) reason = "the roles of the peer changed";
					const proof = (c.state as AuthState).proof;
					if (!reason && proof && o.keys) {
						const key = await o.keys.find(c.peerId, proof.keyId);
						if (!key || key.state !== "active") reason = "the key of this connection was revoked";
						else if (key.roles.join() !== proof.roles.join()) reason = "the roles of the key changed";
					}
				} catch { reason = down ? "the directory is unreachable and its cache has expired" : "the directory could not be read"; }
				if (reason) { event({ event: "revoked", ip: c.ip, peerId: c.peerId, reason }); socket.destroy(); open.delete(socket); closed++; }
			}
			return closed;
		} finally { busy = false; }
	};
	const timer = o.revalidateMs === 0 ? undefined : setInterval(() => void revalidate().catch(() => {}), o.revalidateMs ?? 15_000);
	timer?.unref();

	return {
		...server,
		revalidate,
		peers: () => [...open.values()].map((c) => ({ peerId: c.peerId, ip: c.ip, roles: [...c.roles], proven: (c.state as AuthState).proof !== undefined })),
		close: async () => { clearInterval(timer); await server.close(); },
	};
}
