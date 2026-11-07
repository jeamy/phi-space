// Everything a federation needs before its first start, as a provisioning leaves it: certificates, keys, stores, permits, configs.
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_SPACE, FOREVER, SqliteRecoveryRegister, core, createSpace, listSpaces, provisionFileSigner, spaceDoc, createEnroll, hashToken, newEnrollToken } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { FederationRouting, applyFederationPolicyIn } from "../../../src/federation-policy.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";
import { IP, PORT, POLICY, peer } from "./net.ts";

export async function provision(dir: string, phone?: { ip: string }) {
	const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
	openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=ca", "-days", "2"]);
	for (const name of ["server", "control", "member", "operator"]) {
		openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
		writeFileSync(join(dir, `${name}.ext`), name === "server" ? `subjectAltName=IP:${IP.register}\nextendedKeyUsage=serverAuth\n` : "extendedKeyUsage=clientAuth\n");
		openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`]);
		chmodSync(join(dir, `${name}.key`), 0o600); chmodSync(join(dir, `${name}.crt`), 0o600);
	}
	chmodSync(join(dir, "ca.crt"), 0o600);
	const identity = (name: string) => ({ caFile: "/fed/ca.crt", certFile: `/fed/${name}.crt`, keyFile: `/fed/${name}.key` });
	const print = (name: string) => createHash("sha256").update(new X509Certificate(readFileSync(join(dir, `${name}.crt`))).raw).digest("hex");
	const write = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v), { mode: 0o600 });
	write("register-peers.json", { [print("control")]: {}, [print("member")]: {}, [print("operator")]: { operator: true } });
	write("register.json", { host: IP.register, port: PORT.register, ...identity("server"), file: "/fed/external.sqlite", peersFile: "/fed/register-peers.json" });
	const peers = [peer("control-peer", IP.control, ["space-hosts"]), peer("member-peer", IP.member, ["space-hosts"]), peer("user", IP.client, ["space-hosts"]), peer("router-peer", IP.router, ["space-hosts"]), peer("boss", IP.admin, ["space-admin"])];
	if (phone) peers.push(peer("phone", phone.ip, ["space-enroll"]));
	write("peers.json", peers);
	write("token", "local");
	const key = (name: string) => provisionFileSigner(join(dir, `${name}.json`));
	const controlKey = key("control-key"), memberKey = key("member-key"), userKey = key("user-key"), routerKey = key("router-key"), rootRouter = key("root-router"), rootHost = key("root-host"), adminKey = key("admin-key");
	const now = Date.now();
	const control = await openSqliteHost(join(dir, "control.sqlite"));
	const space = await control.commit((tx) => createSpace(tx, CONTROL_SPACE, now), ctx);
	await control.commit(async (tx) => {
		const s = await spaceDoc(tx, space.spaceId, now);
		const put = (peerId: string, k: typeof memberKey, roles: string[]) => core.write(s, now, { type: "PeerKey", fields: { peerId, keyId: k.keyId, principal: peerId, algorithm: k.algorithm, publicKey: k.publicKey, roles, scope: ["*"], state: "active" } }, null, FOREVER);
		put("member-peer", memberKey, ["host"]); put("user", userKey, ["member"]); put("router-peer", routerKey, ["host", "router", "member"]); put("control-peer", rootRouter, ["host", "router", "member"]); put("control-peer", rootHost, ["host", "member"]); put("boss", adminKey, ["admin"]);
	}, ctx);
	await control.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	let token: string | undefined;
	if (phone) { token = newEnrollToken(); await createEnroll(control, ctx, { tokenHash: hashToken(token), role: "member", allowedPeerId: "phone", scope: ["*"], ttlMs: 3_600_000 }); }
	const target = (hostId: string) => ({ authorityId: "authority", hostId, spaceId: "sp-unused", dataIncarnation: "00000000", primaryEpoch: 1 });
	await control.commit(async (tx) => { const d = await tx.doc(FederationRouting, space.spaceId, null); d.members.a = { id: "a", state: "active", target: target("data-host") } as never; d.members.b = { id: "b", state: "active", target: target("other-host") } as never; await applyFederationPolicyIn(tx, space.spaceId, "authority", POLICY(1), 0); }, ctx);
	const permit = (incarnation: string) => ({ state: "active", authorityId: "authority", dataIncarnation: incarnation, role: "local", transitionId: "t1" });
	const external = new SqliteRecoveryRegister(join(dir, "external.sqlite")), installed = new SqliteRecoveryRegister(join(dir, "installed-control.sqlite"));
	const spaces: Record<string, unknown> = {};
	for (const i of await listSpaces(control, ctx)) { spaces[i.spaceId] = permit(i.incarnation); await installed.compareAndSet(`installed:control-host:${i.spaceId}`, null, permit(i.incarnation) as never); }
	installed.close();
	await control.close(ctx);
	await external.compareAndSet("boot:control-host", null, { hostId: "control-host", state: "active", spaces } as never);
	await external.compareAndSet(`authority:${space.spaceId}`, null, { state: "active", authorityId: "authority", hostId: "control-host", supervisorKey: controlKey.publicKey });
	const seed = await openSqliteHost(join(dir, "member.sqlite"));
	const jobs = await seed.commit((tx) => createSpace(tx, "jobs", now), ctx), notes = await seed.commit((tx) => createSpace(tx, "notes", now), ctx);
	await seed.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
	const memberSpaces: Record<string, unknown> = {};
	for (const i of await listSpaces(seed, ctx)) memberSpaces[i.spaceId] = permit(i.incarnation);
	await seed.close(ctx);
	// the Root's one Member is this Space; a Root starts only on a table it was provisioned for
	const jobsInfo = { hostId: "data-host", spaceId: jobs.spaceId, authorityId: "authority", dataIncarnation: jobs.incarnation, primaryEpoch: 1 };
	const table = await openSqliteHost(join(dir, "control.sqlite"));
	await table.commit(async (tx) => { const d = await tx.doc(FederationRouting, space.spaceId, null); d.members = { a: { id: "a", state: "active", target: jobsInfo } } as never; }, ctx);
	await table.close(ctx);
	await external.compareAndSet("boot:data-host", null, { hostId: "data-host", state: "active", spaces: memberSpaces } as never);
	external.close();
	const base = (name: string, host: string, port: number) => ({ authorityId: "authority", controlHostId: "control-host", controlSpaceId: space.spaceId, listen: { host, port }, keyFile: `/fed/${name}-key.json`, installedRegisterFile: `/fed/installed-${name}.sqlite`, registerTls: { ...identity(name), host: IP.register, port: PORT.register, batchReads: true }, management: { url: `http://${IP.management}:8080`, tokenFile: "/fed/token" }, control: { address: { host: IP.control, port: PORT.control }, algorithm: controlKey.algorithm, publicKey: controlKey.publicKey } });
	// the admin commands of the Root, for the peer `boss` only (driver step `admin`)
	const root = { id: "root", keyFile: "/fed/root-router.json", hostKeyFile: "/fed/root-host.json", leaseFile: "/fed/root-lease", journalPartitions: 1, adminPeer: { peerId: "boss", address: IP.admin }, commands: { runs: true, workers: true, spaces: true, deployment: true, dataAdmin: true }, members: { a: { target: jobsInfo, peerId: "member-peer", keyId: memberKey.keyId, algorithm: memberKey.algorithm, publicKey: memberKey.publicKey, address: { host: IP.member, port: PORT.member } } } };
	write("control.config.json", { ...base("control", IP.control, PORT.control), root, hostId: "control-host", peerId: "control-peer", mode: "control", capabilities: { hostBindings: { "control-peer": "control-host", "member-peer": "data-host" } } });
	write("member.config.json", { ...base("member", IP.member, PORT.member), hostId: "data-host", peerId: "member-peer", mode: "member", membership: { memberId: "a", spaceId: jobs.spaceId }, capabilities: { tools: ["sieve"], models: [], dataSpaces: [jobs.spaceId] }, runGates: true, spaceLifecycle: true });
	write("state.json", { controlSpace: space.spaceId, jobs: jobs.spaceId, notes: notes.spaceId });
	return { token, controlSpace: space.spaceId, jobs: jobs.spaceId };
}
