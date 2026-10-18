import test from "node:test";
import assert from "node:assert/strict";
import { GrantAuthority, GrantVerifier, GrantDenied, generateKey, PhiSpaces, core, type Grant, type SignedGrant, type Connection } from "../src/index.ts";
import { canonicalJson } from "../src/canonical.ts";
import { forEachBackend, ctx } from "./support/persistent.ts";

test("signed grants reject tampering, foreign keys/scopes, resolution effects and expiry at commit", async () => {
	let now = 10000;
	const key = generateKey("ed25519", "control"), principal = { peerId: "worker" }, id = { principal, roles: ["member"] };
	const conn: Connection = { peerId: "worker", state: { proof: { keyId: "app-1" } } };
	const grant: Grant = { id: "g", authorityId: "authority", issuerHostId: "control", principal, keyId: "app-1", scope: ["default"], roles: ["member"], issuedAt: now, expiresAt: now + 60000, purpose: "effect" };
	const sign = async (g: Grant): Promise<SignedGrant> => ({ grant: g, algorithm: key.signer.algorithm, signature: Buffer.from(await key.signer.sign(Buffer.from("phi-spaces/grant/v1\n" + canonicalJson(g as unknown as core.Json)))).toString("base64") });
	const verifier = new GrantVerifier({ authorityId: "authority", issuerHostId: "control", publicKey: key.publicKey, algorithm: "ed25519", now: () => now });
	const token = await sign(grant);
	assert.throws(() => verifier.check({ ...token, grant: { ...grant, scope: ["*"] } }, id, { method: "write" }, conn), GrantDenied);
	assert.throws(() => verifier.check(token, id, { method: "write", space: "other" }, conn), GrantDenied);
	assert.throws(() => verifier.check(token, id, { method: "write" }, { ...conn, state: { proof: { keyId: "app-2" } } }), GrantDenied);
	assert.throws(() => verifier.check(token, { ...id, principal: { peerId: "foreign" } }, { method: "write" }, conn), GrantDenied);
	const resolution = await sign({ ...grant, purpose: "resolution" });
	assert.throws(() => verifier.check(resolution, id, { method: "txn", args: { action: "commit" } }, conn), GrantDenied);
	assert.equal(verifier.check(resolution, id, { method: "pollOperation" }, conn).canExecutePending("take", null), false);
	await forEachBackend(async home => {
		now = 10000; const h = await home.open(), local = new PhiSpaces(h, ctx, () => now);
		await local.write({ type: "Seed", fields: {} });
		const authorization = verifier.check(token, id, { method: "write" }, conn), remote = new PhiSpaces(h, ctx, () => now, undefined, "worker", { authorization });
		now = grant.expiresAt - 2000;
		await assert.rejects(remote.write({ type: "Expired", fields: {} }), GrantDenied);
		assert.equal(await local.count({ type: "Expired" }), 0);
	});
});

test("grant issuance refreshes current identity every time and denies management outage or revoked key", async () => {
	const key = generateKey("ed25519", "control"), id = { principal: { peerId: "worker" }, roles: ["member"] };
	let refreshes = 0, down = false, active = true, roles = ["member"];
	const authority = new GrantAuthority({ authorityId: "authority", hostId: "control", signer: key.signer, identity: { authenticate: () => id }, keys: { find: async () => ({ peerId: "worker", principal: "worker", keyId: "app", state: active ? "active" : "revoked", algorithm: "ed25519", publicKey: key.publicKey, roles: ["member"], scope: ["jobs"] }) }, now: () => 1,
		refreshIdentity: async () => { refreshes++; if (down) throw new Error("management unavailable"); return { ...id, roles }; } });
	const conn = { peerId: "worker", state: { proof: { keyId: "app" } } };
	assert.deepEqual((await authority.issue(conn)).grant.scope, ["jobs"]);
	roles = []; await assert.rejects(authority.issue(conn), GrantDenied);
	assert.equal((await authority.issue(conn, "resolution")).grant.purpose, "resolution");
	down = true; await assert.rejects(authority.issue(conn), /management unavailable/); down = false;
	active = false; await assert.rejects(authority.issue(conn, "resolution"), GrantDenied);
	assert.equal(refreshes, 5);
});

test("transaction commit rechecks rights on its original entries after a role change", async () => {
	await forEachBackend(async home => {
		const h = await home.open(); let allowed = true;
		const authorization = { validUntil: 100000, roles: ["member"], check() {}, canExecutePending: () => allowed };
		const client = new PhiSpaces(h, ctx, () => 1, undefined, "worker", { authorization });
		const txn = await client.createTransaction(60000); await client.write({ type: "Protected", fields: {} }, txn.id);
		allowed = false; await assert.rejects(client.commit(txn.id), core.PermissionError);
		assert.equal(await new PhiSpaces(h, ctx, () => 1).count({ type: "Protected" }), 0);
		await client.abort(txn.id);
	});
});

test("control recovery disables A-only observer rights while retaining only enrollment for unpaired peers", async () => {
 const key=generateKey("ed25519","control");let roles=["observer"];
 const authority=new GrantAuthority({authorityId:"new-authority",hostId:"control",signer:key.signer,keys:{find:async()=>null},identity:{authenticate:()=>null},allowAOnly:async()=>false,refreshIdentity:async()=>({principal:{peerId:"peer"},roles}),now:()=>1});
 await assert.rejects(authority.issue({}),/A-only rights remain disabled/);
 roles=["observer","admin","unpaired"];const grant=await authority.issue({});assert.deepEqual(grant.grant.roles,["unpaired"]);assert.deepEqual(grant.grant.scope,["control"]);
 await assert.rejects(authority.issue({},"resolution"),/still-active app key/);
});

test('only a proven host can issue its own agent namespace without widening scope or roles',async()=>{
 const key=generateKey('ed25519','control');let roles=['host','member'];const identity={authenticate:()=>({principal:{peerId:'host-peer'},roles})};
 const authority=new GrantAuthority({authorityId:'authority',hostId:'control',signer:key.signer,identity,refreshIdentity:async()=>identity.authenticate(),keys:{find:async()=>({peerId:'host-peer',principal:'host-peer',keyId:'host-key',state:'active',algorithm:'ed25519',publicKey:key.publicKey,roles:['host','member'],scope:['jobs']})}});
 const conn={peerId:'host-peer',state:{proof:{keyId:'host-key'}}};const g=await authority.issue(conn,'effect','agent-1');assert.deepEqual(g.grant.principal,{peerId:'host-peer',agentId:'agent-1'});assert.deepEqual(g.grant.scope,['jobs']);assert.deepEqual(g.grant.roles,['host','member']);roles=['member'];await assert.rejects(authority.issue(conn,'effect','agent-1'));roles=['host'];await assert.rejects(authority.issue({peerId:'host-peer'},'effect','agent-1'));await assert.rejects(authority.issue(conn,'effect','../foreign'));
});
