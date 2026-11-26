// Tenant initialization (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 3): two commits, a named Space in
// provisioning admits nothing, the second commit holds FsMeta, the first administrator with home, both relations and
// the first audit row; a repeat answers alreadyExists, a crash between the commits is resumed, unknown versions and
// leftovers are refused, and the login index follows the commit and is rebuilt on start.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER } from "phi-spaces/core";
import { FilesService, InconsistentState, TenantProvisioning, tenantAlias } from "../server/service.ts";
import { InvalidInput, T, WORKSPACES } from "../server/schema.ts";

const ADMIN = { actorId: "lea", homeName: "Lea’s home", issuer: "https://id.example", subject: "sub-lea" };
const mem = () => FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
const raw = (s: FilesService, tenantId: string) => s.store.space(tenantAlias(tenantId));

test("a reserved Space admits nothing until its initialization commits", async () => {
	const s = await mem();
	try {
		assert.equal(await s.tenantState("acme"), "absent");
		await s.reserveTenantSpace("acme");
		assert.equal(await s.tenantState("acme"), "provisioning");
		await assert.rejects(s.inTenant("acme", async () => "ran"), TenantProvisioning);
		await assert.rejects(s.inTenant("acme", async () => "ran"), (e: Error & { code?: string }) => e.code === "unavailable");

		const r = await s.createTenant("acme", ADMIN);
		assert.equal(r.status, "created");
		assert.equal(await s.tenantState("acme"), "ready");
		assert.equal(await s.inTenant("acme", async () => "ran"), "ran");
	} finally { await s.close(); }
});

test("the second commit holds FsMeta, the admin with its home and relations, and the first audit row", async () => {
	const s = await mem();
	try {
		const r = await s.createTenant("acme", ADMIN);
		assert.ok(r.status === "created");
		const rows = await raw(s, "acme").readAll();
		const of = (type: string) => rows.filter((e) => e.type === type).map((e) => e.fields);
		assert.deepEqual(of(T.meta), [{ tenantId: "acme", schemaVersion: 1, formatVersion: 1 }]);
		assert.deepEqual(of(T.actor), [{ actorKind: "user", actorId: "lea", state: "enabled", homeNodeId: r.homeNodeId, issuer: ADMIN.issuer, subject: ADMIN.subject }]);
		assert.deepEqual(of(T.node), [{ nodeId: r.homeNodeId, parentId: WORKSPACES, name: "Lea’s home", kind: "dir" }]);
		assert.deepEqual(of(T.relation).map((f) => `${f.objectKind}:${f.objectId}#${f.relation}@${f.subjectKind}:${f.subjectId}`).sort(),
			[`node:${r.homeNodeId}#owner@user:lea`, "tenant:acme#admin@user:lea"]);
		const audit = of(T.audit);
		assert.equal(audit.length, 1);
		assert.deepEqual({ ...audit[0], time: 0 }, { seq: 1, time: 0, actorKind: "operator", actorId: "", operation: "createTenant", targets: [r.homeNodeId], operationId: "", outcome: "ok" });
		assert.equal(rows.length, 6);

		// a repeat changes nothing, whatever it names
		assert.deepEqual(await s.createTenant("acme", { ...ADMIN, actorId: "other" }), { status: "alreadyExists", tenantId: "acme" });
		assert.equal((await raw(s, "acme").readAll()).length, 6);
		assert.deepEqual(s.state.tenantsFor(ADMIN.issuer, ADMIN.subject), ["acme"]);
	} finally { await s.close(); }
});

test("input is checked before anything commits", async () => {
	const s = await mem();
	try {
		for (const bad of [{ actorId: "a b" }, { actorId: "" }, { homeName: "a/b" }, { homeName: ".." }, { homeName: "x\u0007" }, { issuer: "" }, { subject: "\n" }])
			await assert.rejects(s.createTenant("acme", { ...ADMIN, ...bad }), InvalidInput, JSON.stringify(bad));
		assert.equal(await s.tenantState("acme"), "absent");
		// the home name is stored in NFC
		const r = await s.createTenant("acme", { ...ADMIN, homeName: "Café" });
		assert.ok(r.status === "created");
		assert.equal((await raw(s, "acme").readIfExists({ type: T.node }, 0))?.fields.name, "Café");
	} finally { await s.close(); }
});

test("leftover rows and unknown versions in a tenant Space are refused, and suspend that tenant", async () => {
	const s = await mem();
	try {
		await s.reserveTenantSpace("acme");
		await raw(s, "acme").write({ type: "Stray", fields: {} }, null, FOREVER);
		await assert.rejects(s.createTenant("acme", ADMIN), InconsistentState);
		assert.equal(await s.tenantState("acme"), "provisioning");

		await s.reserveTenantSpace("globex");
		await raw(s, "globex").write({ type: T.meta, fields: { tenantId: "globex", schemaVersion: 99, formatVersion: 1 } }, null, FOREVER);
		await assert.rejects(s.inTenant("globex", async () => "ran"), InconsistentState);
		// an inconsistentState suspends that tenant until operator repair; the others keep running
		assert.equal(s.admission.suspended("globex"), "inconsistentState");
		await assert.rejects(s.createTenant("globex", ADMIN), (e: Error & { code?: string }) => e.code === "unavailable");
		s.admission.resume("globex");
		await assert.rejects(s.createTenant("globex", ADMIN), InconsistentState);
	} finally { await s.close(); }
});

test("on disk: a crash between the two commits is resumed, and the login index is rebuilt on start", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-tenant-"));
	const open = () => FilesService.open({ dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "blobs") });
	try {
		const a = await open();
		await a.reserveTenantSpace("acme"); // the first commit, then the process stops
		await a.close();

		const b = await open();
		assert.equal(await b.tenantState("acme"), "provisioning");
		const r = await b.createTenant("acme", ADMIN);
		assert.equal(r.status, "created");
		await b.createTenant("globex", { ...ADMIN, actorId: "lea-g" });
		assert.deepEqual(b.state.tenantsFor(ADMIN.issuer, ADMIN.subject), ["acme", "globex"]);
		b.state.replaceLogins([]); // as if the process died after the commit and before the index entry
		await b.close();

		const c = await open();
		try {
			assert.equal(await c.tenantState("acme"), "ready");
			assert.deepEqual(c.state.tenantsFor(ADMIN.issuer, ADMIN.subject), ["acme", "globex"]);
			assert.deepEqual(await c.createTenant("acme", ADMIN), { status: "alreadyExists", tenantId: "acme" });
		} finally { await c.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});
