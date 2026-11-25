// The agent adapter (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 5): one local unix socket per enrolled
// agent host and tenant, configured by the host operator. The socket's directory decides who may connect (Node.js
// exposes no peer credentials), so the host peer behind it is a configuration fact, not a claim of the caller; the
// tenant is fixed by the same configuration (decided 2026-11-25), and the agent cannot choose another.
//
// Each call is one frame of phi-spaces' socket transport (`serveSpace`, `socketTransport`) holding JSON
// `{op, args, frame: {agent}}`; the reply is `{ok: true, value}` or `{ok: false, error: {code, message, …}}`. The frame
// rule is the agent-host contract's (spaces/src/service.ts, frame.agent): `agent` is 1 to 128 characters of
// A-Z a-z 0-9 _ . : -, and a call without one acts for nobody: the host peer itself is no actor. The adapter speaks its
// own protocol, never the Space protocol: the tenant Spaces stay unexposed.
import { chmodSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { serveSpace, type SpaceServer } from "phi-spaces";
import { Unauthenticated } from "./schema.ts";
import type { FilesService } from "./service.ts";
import { base64Chars, BadCall, FILE_OPS, isObj, runOp, wireError, type Reply } from "./wire.ts";

export const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export type AgentSocketOptions = {
	/** The socket's path; its directory must not be reachable by others (group access is the host user's way in). */
	path: string;
	/** The enrolled host peer this socket stands for. */
	hostPeerId: string;
	/** The one tenant its agents act in. */
	tenantId: string;
	maxConnections?: number;
};

/** The frame bound: the largest write (base64 of `maxFileBytes`) with room for its arguments. */
export const agentFrameBytes = (maxFileBytes: number) => base64Chars(maxFileBytes) + 64 * 1024;

/** Refuses a socket directory that others can reach (mode bits for "other"), or that is no directory. */
export function checkSocketDir(path: string): void {
	const dir = dirname(path);
	const st = lstatSync(dir);
	if (!st.isDirectory()) throw new Error(`the agent socket's directory is not a directory: ${dir}`);
	if ((st.mode & 0o007) !== 0) throw new Error(`the agent socket's directory is reachable by others (mode ${(st.mode & 0o777).toString(8)}): ${dir}`);
}

export async function serveAgentSocket(svc: FilesService, o: AgentSocketOptions): Promise<SpaceServer> {
	checkSocketDir(o.path);
	const maxFrame = agentFrameBytes(svc.limits.maxFileBytes);
	// one session per agent of this host; logged in on first use and again when the deployment state no longer knows it
	const sessions = new Map<string, Promise<string>>();
	const login = (agent: string, fresh = false) => {
		let p = fresh ? undefined : sessions.get(agent);
		if (!p) {
			p = svc.login(o.tenantId, "agent", { enrolledHostPeerId: o.hostPeerId, agentId: agent }).then((r) => r.handle);
			sessions.set(agent, p);
			p.catch(() => { if (sessions.get(agent) === p) sessions.delete(agent); });
		}
		return p;
	};
	const call = async (text: string): Promise<Reply> => {
		let msg: unknown;
		try { msg = JSON.parse(text); } catch { return { ok: false, error: wireError(new BadCall("a call is one JSON object")) }; }
		if (!isObj(msg)) return { ok: false, error: wireError(new BadCall("a call is one JSON object")) };
		const agent = isObj(msg.frame) ? msg.frame.agent : undefined;
		if (agent === undefined) return { ok: false, error: wireError(new Unauthenticated()) };
		if (typeof agent !== "string" || !AGENT_ID.test(agent)) return { ok: false, error: wireError(new BadCall("frame.agent must be 1 to 128 characters of A-Z a-z 0-9 _ . : -")) };
		let handle: string;
		try { handle = await login(agent); } catch (e) { return { ok: false, error: wireError(e) }; }
		let r = await runOp(FILE_OPS, svc, handle, msg.op, msg.args);
		// an expired or ended session: log in once more; a disabled or unknown actor fails the login itself
		if (!r.ok && r.error.code === "unauthenticated" && svc.state.lookupSession(handle) === null) {
			try { handle = await login(agent, true); } catch (e) { return { ok: false, error: wireError(e) }; }
			r = await runOp(FILE_OPS, svc, handle, msg.op, msg.args);
		}
		return r;
	};
	const server = await serveSpace({ handleText: async (text) => JSON.stringify(await call(text)) }, {
		listen: { path: o.path },
		maxFrameBytes: maxFrame,
		maxConnections: o.maxConnections ?? 16,
		connection: () => ({}),
	});
	// serveSpace leaves the socket at mode 600; the host's OS user reaches it through the directory's group
	chmodSync(o.path, 0o660);
	return server;
}

/** The launcher's FILES_AGENT_SOCKETS: `hostPeer@tenant=/absolute/path;…`. */
export function parseAgentSockets(spec: string): Array<{ hostPeerId: string; tenantId: string; path: string }> {
	return spec.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
		const m = /^([^@=\s]+)@([^@=\s]+)=(\/\S+)$/.exec(s);
		if (!m) throw new Error(`FILES_AGENT_SOCKETS: "${s}" is not hostPeer@tenant=/absolute/path`);
		return { hostPeerId: m[1], tenantId: m[2], path: m[3] };
	});
}
