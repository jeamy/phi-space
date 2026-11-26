// Virtual files (docs/zanzibar-agent-filesystem-plan.en.md, section 8, virtual files; decided in section 5): read-only
// providers mounted as `@<name>`. The provider sees the caller's verified binding and nothing else, enforces its own
// permissions for it, answers live, within a deadline, and fails closed; every mutation on a mount is refused, and the
// reserved names are never stored.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryProvider, identityKey, parseMounts, type MountCaller, type MountProvider } from "../server/mounts.ts";
import { NotFound } from "../server/schema.ts";
import { FilesService, type FilesServiceOptions } from "../server/service.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };

async function setup(mounts: Map<string, MountProvider>, o: Partial<FilesServiceOptions> = {}) {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, mounts, ...o });
	for (const t of ["acme", "globex"]) await s.createTenant(t, { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	const by = { actorKind: "user" as const, actorId: "adm" };
	await s.provisionActor("acme", by, "user", "lea", "lea", { issuer: "i", subject: "lea" });
	await s.provisionActor("acme", by, "user", "max", "max", { issuer: "i", subject: "max" });
	await s.provisionActor("acme", by, "agent", "bot", "bot", { enrolledHostPeerId: "host-1", agentId: "bot" });
	const h = {
		lea: (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle,
		max: (await s.login("acme", "user", { issuer: "i", subject: "max" })).handle,
		bot: (await s.login("acme", "agent", { enrolledHostPeerId: "host-1", agentId: "bot" })).handle,
		globex: (await s.login("globex", "user", { issuer: "i", subject: "adm" })).handle,
		adm: (await s.login("acme", "user", { issuer: "i", subject: "adm" })).handle,
	};
	return { s, h, id: async (k: keyof typeof h) => (await s.issueOperationIds(h[k], 1))[0] };
}

test("a provider sees the caller's verified binding and nothing else", async () => {
	const seen: MountCaller[] = [];
	const spy: MountProvider = {
		async visible(c) { seen.push(c); return true; },
		async list(c) { seen.push(c); return [{ name: "x.md", kind: "file" }]; },
		async read(c) { seen.push(c); return { bytes: Buffer.from("x"), version: 1 }; },
	};
	const { s, h } = await setup(new Map([["spy", spy]]));
	try {
		assert.deepEqual(await s.workspaces(h.lea), ["@spy", "lea"]);
		await s.list(h.bot, "@spy", ".");
		await s.read(h.lea, "@spy", "x.md");
		for (const c of seen) {
			assert.deepEqual(Object.keys(c).sort(), ["actor", "identity", "signal", "tenantId"]);
			assert.ok(Object.isFrozen(c.actor) && Object.isFrozen(c.identity));
			assert.ok(c.signal instanceof AbortSignal);
		}
		assert.deepEqual(seen.map((c) => [c.tenantId, c.actor, c.identity]), [
			["acme", { kind: "user", id: "lea" }, { issuer: "i", subject: "lea" }],
			["acme", { kind: "agent", id: "bot" }, { enrolledHostPeerId: "host-1", agentId: "bot" }],
			["acme", { kind: "agent", id: "bot" }, { enrolledHostPeerId: "host-1", agentId: "bot" }],
			["acme", { kind: "user", id: "lea" }, { issuer: "i", subject: "lea" }],
			["acme", { kind: "user", id: "lea" }, { issuer: "i", subject: "lea" }],
		]);
		await assert.rejects(s.list("no-session", "@spy", "."), code("unauthenticated"), "no provider call without a session");
		assert.equal(seen.length, 5);
	} finally { await s.close(); }
});

test("a directory mount: the source's permissions per identity, live reads, no links, read-only", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-mnt-"));
	mkdirSync(join(root, "a")); mkdirSync(join(root, "b"));
	writeFileSync(join(root, "a", "x.md"), "ax"); writeFileSync(join(root, "b", "y.md"), "by");
	symlinkSync("/etc/hostname", join(root, "a", "link"));
	const lea = { tenantId: "acme", actor: { kind: "user" as const, id: "lea" }, identity: { issuer: "i", subject: "lea" } };
	const max = { ...lea, actor: { kind: "user" as const, id: "max" }, identity: { issuer: "i", subject: "max" } };
	const docs = directoryProvider(root, { [identityKey(lea)]: [""], [identityKey(max)]: ["a"] });
	const { s, h, id } = await setup(new Map([["docs", docs]]));
	try {
		assert.deepEqual(await s.workspaces(h.max), ["@docs", "max"]);
		assert.deepEqual(await s.workspaces(h.bot), ["bot"], "no access, no mount");
		assert.deepEqual(await s.workspaces(h.globex), ["adm"], "the same subject in another tenant is another identity");
		assert.deepEqual(await s.list(h.lea, "@docs", "."), [{ name: "a", kind: "dir" }, { name: "b", kind: "dir" }]);
		assert.deepEqual(await s.list(h.max, "@docs", "."), [{ name: "a", kind: "dir" }], "only the way down to what max may see");
		assert.deepEqual(await s.list(h.max, "@docs", "a"), [{ name: "x.md", kind: "file" }], "a link is not shown");
		assert.deepEqual(await s.listPage(h.max, "@docs", "a", null, null), { entries: [{ name: "x.md", kind: "file" }], next: null });
		for (const p of [() => s.list(h.max, "@docs", "b"), () => s.read(h.max, "@docs", "b/y.md"), () => s.read(h.lea, "@docs", "a/link"), () => s.list(h.bot, "@docs", "."), () => s.read(h.lea, "@nothing", "x")])
			await assert.rejects(p(), code("notFound"));
		const first = await s.read(h.max, "@docs", "a/x.md");
		assert.equal(first.bytes.toString(), "ax");
		// live: the next read sees the source's change, with a new version
		writeFileSync(join(root, "a", "x.md"), "changed");
		utimesSync(join(root, "a", "x.md"), new Date(), new Date(Date.now() + 5000));
		const second = await s.read(h.max, "@docs", "a/x.md");
		assert.equal(second.bytes.toString(), "changed");
		assert.ok(second.version > first.version);
		// read-only, whether the mount exists or not; the reserved names are never stored
		const op = await id("lea");
		for (const p of [() => s.write(h.lea, "@docs", "a/new.md", Buffer.from("x"), 0, op), () => s.mkdir(h.lea, "@docs", "c", op),
			() => s.grant(h.lea, "@docs", ".", "viewer", { kind: "user", id: "max" }, op), () => s.remove(h.lea, "@docs", "a/x.md", null, op),
			() => s.move(h.lea, "@docs", "a/x.md", "lea", "x.md", op), () => s.move(h.lea, "lea", "x", "@docs", "x", op),
			() => s.restrict(h.lea, "@docs", "a", op), () => s.listGrants(h.lea, "@docs", "."), () => s.write(h.lea, "@nothing", "f", Buffer.from("x"), 0, op)])
			await assert.rejects(p(), code("permissionDenied"));
		await assert.rejects(s.createWorkspace(h.adm, "@docs", { kind: "user", id: "lea" }, await id("adm")), code("invalidInput"));
		await assert.rejects(s.registerActor(h.adm, "user", "eve", "@eve", { issuer: "i", subject: "eve" }, await id("adm")), code("invalidInput"));
	} finally { await s.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a late, failing or malformed provider fails closed and tells nothing of the source", async () => {
	const never: MountProvider = { visible: async () => true, list: () => new Promise(() => {}), read: () => new Promise(() => {}) };
	const leaky: MountProvider = { visible: async () => true, list: async () => { throw new Error("/srv/secret/path"); }, read: async () => ({ bytes: "no buffer" as unknown as Buffer, version: 1 }) };
	const odd: MountProvider = { visible: async () => true, list: async () => [{ name: "../up", kind: "file" }], read: async () => { throw new NotFound(); } };
	const hidden: MountProvider = { visible: () => new Promise(() => {}), list: async () => [], read: async () => { throw new NotFound(); } };
	const { s, h } = await setup(new Map([["never", never], ["leaky", leaky], ["odd", odd], ["hidden", hidden]]), { limits: { mountTimeoutMs: 100 } });
	try {
		assert.deepEqual(await s.workspaces(h.lea), ["@leaky", "@never", "@odd", "lea"], "a mount that does not answer in time is left out");
		await assert.rejects(s.list(h.lea, "@never", "."), code("unavailable"));
		await assert.rejects(s.read(h.lea, "@never", "f"), code("unavailable"));
		await assert.rejects(s.list(h.lea, "@leaky", "."), (e: Error & { code?: string }) => e.code === "unavailable" && !/secret/.test(e.message));
		await assert.rejects(s.read(h.lea, "@leaky", "f"), code("unavailable"));
		await assert.rejects(s.list(h.lea, "@odd", "."), code("unavailable"));
		await assert.rejects(s.read(h.lea, "@odd", "f"), code("notFound"));
		await assert.rejects(s.list(h.lea, "@hidden", "."), code("unavailable"));
		// the queue was never held by a provider: other work goes on
		assert.deepEqual(await s.list(h.lea, "lea", "."), []);
	} finally { await s.close(); }
});

test("the mounts file is checked", () => {
	assert.equal(parseMounts(JSON.stringify([{ name: "docs", kind: "directory", root: "/srv/docs", access: { "acme/user:i lea": [""] } }])).size, 1);
	for (const bad of ["{}", JSON.stringify([{ name: "Docs", kind: "directory", root: "/x", access: {} }]), JSON.stringify([{ name: "d", kind: "web", root: "/x", access: {} }]),
		JSON.stringify([{ name: "d", kind: "directory", root: "rel", access: {} }]), JSON.stringify([{ name: "d", kind: "directory", root: "/x", access: { k: "all" } }]),
		JSON.stringify([{ name: "d", kind: "directory", root: "/x", access: {} }, { name: "d", kind: "directory", root: "/y", access: {} }])])
		assert.throws(() => parseMounts(bad));
});
