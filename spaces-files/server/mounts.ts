// Virtual files (docs/zanzibar-agent-filesystem-plan.en.md, section 8, virtual files; decided in section 5): read-only
// providers mounted as workspaces named `@<name>`. The service hands a provider the caller's verified binding and
// nothing else (no session, no Space, no service rights): the tenant, the actor and its identity (issuer and subject,
// or enrolled host peer and agent ID). The provider enforces the source application's own permissions for that
// identity; a mounted file can never be more visible than the source lets that identity see. Every call is live (no
// cache) and bounded by a deadline; whatever goes wrong fails closed.
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentIdentity, ActorKind, UserIdentity } from "./schema.ts";
import { NotFound } from "./schema.ts";

/** What a provider learns about a call: the verified binding of the caller, and the deadline as a signal. */
export type MountCaller = {
	readonly tenantId: string;
	readonly actor: { readonly kind: ActorKind; readonly id: string };
	readonly identity: Readonly<UserIdentity> | Readonly<AgentIdentity>;
	readonly signal: AbortSignal;
};

export type MountEntry = { name: string; kind: "dir" | "file" };

/**
 * A read-only provider. `visible` decides whether the mount appears in the caller's workspace list; `list` and `read`
 * take canonical path segments below the mount (`[]` is its root) and throw `NotFound` for what the caller may not see
 * as for what is absent. A file's `version` is the provider's own (it changes when the source changes).
 */
export interface MountProvider {
	visible(c: MountCaller): Promise<boolean>;
	list(c: MountCaller, segments: readonly string[]): Promise<MountEntry[]>;
	read(c: MountCaller, segments: readonly string[]): Promise<{ bytes: Buffer; version: number }>;
}

/** The key a caller has in a directory provider's access table. */
export function identityKey(c: Pick<MountCaller, "tenantId" | "actor" | "identity">): string {
	const i = c.identity as Record<string, string>;
	return c.actor.kind === "user" ? `${c.tenantId}/user:${i.issuer} ${i.subject}` : `${c.tenantId}/agent:${i.enrolledHostPeerId} ${i.agentId}`;
}

/**
 * A directory of this machine as a provider: `access` maps an identity key (`identityKey`) to the paths below the
 * root it may see ("" for all of it). The paths are this provider's permissions, standing in for a source
 * application's. Symbolic links are never followed, and nothing outside the root is reached.
 */
export function directoryProvider(root: string, access: Readonly<Record<string, readonly string[]>>): MountProvider {
	if (!isAbsolute(root)) throw new Error("a directory mount needs an absolute root");
	const allowed = (c: MountCaller): string[] => (access[identityKey(c)] ?? []).map((p) => p.replace(/^\/+|\/+$/g, ""));
	/** Whether the caller sees `segs`: on or below an allowed path, or above one (to walk down to it). */
	const sees = (c: MountCaller, segs: readonly string[]): "all" | "through" | null => {
		const p = segs.join("/");
		let through = false;
		for (const a of allowed(c)) {
			if (a === "" || p === a || p.startsWith(a + "/")) return "all";
			if (p === "" || a.startsWith(p + "/")) through = true;
		}
		return through ? "through" : null;
	};
	// the segments are canonical names (no separators, no dot segments), and no link is followed: nothing leaves the root
	const real = async (segs: readonly string[]): Promise<string> => {
		let at = await realpath(root);
		for (const s of segs) {
			at = join(at, s);
			const st = await lstat(at).catch(() => null);
			if (st === null || st.isSymbolicLink()) throw new NotFound();
		}
		return at;
	};
	return {
		async visible(c) { return allowed(c).length > 0; },
		async list(c, segs) {
			const how = sees(c, segs);
			if (how === null) throw new NotFound();
			const dir = await real(segs);
			if (!(await lstat(dir)).isDirectory()) throw new NotFound();
			const out: MountEntry[] = [];
			for (const e of await readdir(dir, { withFileTypes: true })) {
				if (!e.isDirectory() && !e.isFile()) continue;              // links, sockets and devices are not shown
				if (how === "through" && sees(c, [...segs, e.name]) === null) continue;
				out.push({ name: e.name, kind: e.isDirectory() ? "dir" : "file" });
			}
			return out;
		},
		async read(c, segs) {
			if (segs.length === 0 || sees(c, segs) !== "all") throw new NotFound();
			const file = await real(segs);
			const st = await lstat(file);
			if (!st.isFile()) throw new NotFound();
			return { bytes: await readFile(file, { signal: c.signal }), version: Math.max(1, Math.floor(st.mtimeMs)) };
		},
	};
}

/** The mounts of a deployment as the launcher reads them (`FILES_MOUNTS`): `[{name, kind: "directory", root, access}]`. */
export function parseMounts(text: string, source = "the mounts file"): Map<string, MountProvider> {
	let v: unknown;
	try { v = JSON.parse(text); } catch (e) { throw new Error(`${source} is no JSON: ${(e as Error).message}`); }
	if (!Array.isArray(v)) throw new Error(`${source} must hold a JSON array`);
	const out = new Map<string, MountProvider>();
	for (const m of v as Array<Record<string, unknown>>) {
		if (typeof m?.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(m.name)) throw new Error(`${source}: a mount name is 1 to 63 of a-z 0-9 _ - (got ${JSON.stringify(m?.name)})`);
		if (out.has(m.name)) throw new Error(`${source}: mount ${m.name} twice`);
		if (m.kind !== "directory") throw new Error(`${source}: mount ${m.name}: the only kind is "directory"`);
		if (typeof m.root !== "string" || !isAbsolute(m.root)) throw new Error(`${source}: mount ${m.name}: root must be an absolute path`);
		const access = m.access as Record<string, unknown>;
		if (typeof access !== "object" || access === null || Array.isArray(access) || Object.values(access).some((a) => !Array.isArray(a) || a.some((x) => typeof x !== "string")))
			throw new Error(`${source}: mount ${m.name}: access maps identity keys to arrays of paths`);
		out.set(m.name, directoryProvider(m.root, access as Record<string, string[]>));
	}
	return out;
}
