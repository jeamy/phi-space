// Device acceptance coordinator for the mobile Spaces control page (docs/betrieb-und-mobile-steuerung.md §8 B9).
import { openSqliteHost } from "../../../src/index.ts";
// The production composition (startFederationHost with grants, enrollment, control access, supervisor, run and worker
// commands) on a LAN address; the phone is pinned by its LAN IP (layer A fixture). State persists in <dir>, so a
// restart is a crash test. Usage: node --experimental-strip-types test/testbed/device/b9-coordinator.ts <dir> <bindIp> <phoneIp> [--netbird]
// --netbird: layer A from the real NetBird Management API (peer id and groups by overlay IP), queried over ssh on
// `big` so the API token never leaves that host; the phone peer must be connected to the overlay.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import {
	CONTROL_SPACE, GateIdentity, GrantAuthority, GrantVerifier, RunController, SpaceKeyDirectory, WorkerAssignments, WorkerSupervisor, bootstrapEnroll, core,
	createSpace, hashToken, listSpaces, loadFileSigner, localRunMember, newEnrollToken, provisionFileSigner, snapshotSpace, spaceDoc, startFederationHost,
} from "../../../src/index.ts";
import { SIEVE_WORKER_KIND, configureGatedSieveSpace, prepareSieveRun, type SieveConfig } from "../../../examples/sieve.ts";

const [dir, LAN, PHONE, mode] = process.argv.slice(2) as [string, string, string, string | undefined];
if (!dir || !LAN || !PHONE) throw new Error("usage: b9-coordinator.ts <dir> <bindIp> <phoneIp> [--netbird]");
const NETBIRD = mode === "--netbird";
type Peer = { id: string; name: string; ip: string; connected: boolean; groups: string[] };
const API = `import pathlib,json,urllib.request
e=dict(l.strip().split('=',1) for l in pathlib.Path('/media/docker/phi-spaces/netbird/secrets.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
req=urllib.request.Request('https://spacebird.eibrain.org/api/peers',headers={'Authorization':'Token '+e['NB_PAT'].strip().strip(chr(34)).strip(chr(39))})
print(json.dumps([{'id':p['id'],'name':p['name'],'ip':p['ip'],'connected':p['connected'],'groups':[g['name'] for g in p.get('groups',[])]} for p in json.loads(urllib.request.urlopen(req,timeout=20).read())]))`;
let peers: { at: number; list: Peer[] } = { at: 0, list: [] };
const netbirdPeers = async (): Promise<Peer[]> => {
	if (Date.now() - peers.at > 15_000) {
		const stdout = await new Promise<string>((resolve, reject) => {
			const child = execFile("ssh", ["-oBatchMode=yes", "-oConnectTimeout=10", "big", "python3", "-"], { timeout: 30_000 }, (e, out) => e ? reject(e) : resolve(out));
			child.stdin!.end(API); // the script travels on stdin; the token stays on big
		});
		peers = { at: Date.now(), list: JSON.parse(stdout) };
	}
	return peers.list;
};
const PORT = 17460, HOST_ID = "b9-coord";
const PHONE_PEER = NETBIRD ? (await netbirdPeers()).find(p => p.ip === PHONE)?.id ?? "" : "phone-b9";
if (!PHONE_PEER) throw new Error(`no NetBird peer with overlay IP ${PHONE}`);
mkdirSync(dir, { recursive: true });
const fresh = !existsSync(join(dir, "store"));
const h = await openSqliteHost(join(dir, "store", "space.sqlite"));
const keyFile = join(dir, "control.key"), signer = existsSync(keyFile) ? loadFileSigner(keyFile) : provisionFileSigner(keyFile);
const spaces: string[] = [];
for (const alias of ["sieve-a", "sieve-b"]) {
	const id = (await h.commit(tx => createSpace(tx, alias, Date.now()), ctx)).spaceId;
	await configureGatedSieveSpace(h, id); spaces.push(id);
}
await h.commit(tx => createSpace(tx, CONTROL_SPACE, Date.now()), ctx);
const controlId = (await listSpaces(h, ctx)).find(i => i.alias === CONTROL_SPACE)!.spaceId;
if (fresh) {
	const token = newEnrollToken();
	await bootstrapEnroll(h, ctx, { tokenHash: hashToken(token), allowedPeerId: PHONE_PEER });
	writeFileSync(join(dir, "bootstrap-token.txt"), token + "\n", { mode: 0o600 });
}
const isAdmin = async () => { const s = await snapshotSpace(h, controlId, ctx); return !!s && core.list(s, Date.now(), { type: "PeerKey", fields: { peerId: PHONE_PEER } }).some(e => e.fields.state === "active"); };
const directory = NETBIRD
	// Peer id, IP and connection state come from NetBird. Until the phone holds an active key, its role is
	// space-enroll (as an operator would group it for first pairing); afterwards its real NetBird groups apply.
	? { refresh: async () => { peers.at = 0; await netbirdPeers(); }, lookup: async (ip: string) => { const p = (await netbirdPeers()).find(x => x.ip === ip); return p && p.ip === PHONE && !(await isAdmin()) ? { ...p, groups: ["space-enroll"] } : p ?? null; } }
	: { refresh: async () => {}, lookup: async (ip: string) => ip === PHONE ? { id: PHONE_PEER, name: PHONE_PEER, ip, connected: true, groups: [(await isAdmin()) ? "space-admin" : "space-enroll"] } : null };
const groupRoles: Record<string, string[]> = { "space-hosts": ["member", "host", "router"], "space-admin": ["admin"], "space-observer": ["observer"], "space-enroll": ["unpaired"] };
const keys = new SpaceKeyDirectory(h, ctx, Date.now, controlId), identity = new GateIdentity();
const authority = new GrantAuthority({ authorityId: "b9", hostId: HOST_ID, signer, keys, identity, refreshIdentity: async (conn: any) => { const peer = conn.overlayIp ? await directory.lookup(conn.overlayIp) : null; return peer ? identity.authenticate({ ...conn, credentials: { roles: peer.groups.flatMap(g => groupRoles[g] ?? []) } }) : null; } });
const runs = new RunController({ host: h, ctx, member: id => localRunMember(h, ctx, id, (run, space) => prepareSieveRun(h, run.config as SieveConfig, { space }).then(() => {})) });
const workers = new WorkerAssignments({ host: h, ctx, authorityId: "b9", peerId: "b9-control", signer });
// The production composition: Gate, proof, enrollment, grants, control access, supervisor with run and worker commands.
const runtime = await startFederationHost(h, ctx, { hostId: HOST_ID, authorityId: "b9", unsafeSkipBootGuardForTests: true, keys, directory: directory as any, groupRoles,
	verifier: new GrantVerifier({ authorityId: "b9", issuerHostId: HOST_ID, algorithm: signer.algorithm, publicKey: signer.publicKey }),
	listen: { host: LAN, port: PORT }, revalidateMs: 0, control: { host: h, authority, runs, workers, runAdvanceMs: 1000 } });
const local = new WorkerSupervisor({ host: h, ctx, hostId: HOST_ID, authorityId: "b9", controllerPin: { issuer: "b9-control", algorithm: signer.algorithm, publicKey: signer.publicKey }, kinds: { sieve: SIEVE_WORKER_KIND }, fetch: () => workers.forHost(HOST_ID), backoff: { minMs: 50, maxMs: 1000 } });
const tick = setInterval(async () => {
	try {
		const summary = await local.reconcile();
		await h.commit(async tx => { const s = await spaceDoc(tx, controlId, Date.now()); for (const e of core.list(s, Date.now(), { type: "Capability", fields: { hostId: HOST_ID } })) core.probe(s, Date.now(), { id: e.id }, null, true); core.write(s, Date.now(), { type: "Capability", fields: { hostId: HOST_ID, at: Date.now(), resources: {}, tools: ["sieve"], models: [], metrics: { workers: summary as any } } }, null, 120_000); }, ctx);
	} catch (e) { console.error("tick", e); }
}, 2000);
console.log(JSON.stringify({ ready: true, directory: NETBIRD ? "netbird-management-api" : "fixture-pin", endpoint: `tcp://${LAN}:${PORT}`, controlHostId: HOST_ID, phonePeer: PHONE_PEER, members: spaces, controlSpaceId: controlId, fresh }));
const shutdown = async () => { clearInterval(tick); await local.stop(); await runtime.close(); await h.close(ctx); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
