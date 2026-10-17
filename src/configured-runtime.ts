import {createConfiguredRoot,type RootConfig} from './configured-root.ts';
import {CapabilityDirectory,CAPABILITY_HEARTBEAT_MS} from "./capability-directory.ts";
import {ReplicaNoticeBoard} from "./replica-notice.ts";
import {totalmem,freemem,availableParallelism} from "node:os";
import {MemberLifecycle} from "./membership.ts";
// Deployed composition from explicitly provisioned identities, pinned keys and independently supplied boot records.
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { openSyncSpace, openSyncSpaces, sealedCandidateOf, sealedResolver, type SyncSpace, type SyncSpaceConfig } from "./sync-spaces.ts";
import { promotionEvidence } from "./primary-sync.ts";
import type { Context } from "@earendil-works/chord";
import { privateFile, loadFileSigner } from "./keys.ts";
import { NetbirdDirectory, GateIdentity, type GroupRoles } from "./gate.ts";
import { GrantAuthority, GrantVerifier } from "./grants.ts";
import { SpaceKeyDirectory } from "./enroll.ts";
import { RemoteSpace, TransportFailure } from "./remote.ts";
import { socketTransport } from "./socket.ts";
import { startFederationHost } from "./runtime.ts";
import { TlsRecoveryRegister, type RegisterTlsClient } from "./tls-register.ts";
import { SshRecoveryRegister } from "./ssh-register.ts";
import { SocketRecoveryRegister } from "./register-service.ts";
import { SqliteRecoveryRegister } from "./recovery-register.ts";
import { followControlHostChange } from "./control-host-change.ts";
import { EntryReplicationController } from "./entry-replication.ts";
import { EntryReplicationPump, EntryReplicationUnavailable } from "./entry-replication-stream.ts";
import { BootBlocked, type HostBootState } from "./boot.ts";
import { Registry, snapshotSpace, listSpaces } from "./spaces.ts";
import { installAdmittedPermit } from "./replica-control.ts";
import { canonicalJson } from "./canonical.ts";
import type { Json } from "./core.ts";
import { startConfiguredRecovery, type PrivateRecoveryConfig } from "./configured-recovery.ts";
import {RouterLeaseAuthority,DelegationVerifier} from "./delegation.ts";
import {FederationPolicyAuthority,verifyFederationPolicy,alignControlReplicaIn} from "./federation-policy.ts";
import type { Algorithm } from "./auth.ts";

export type FederationConfig = {
 root?:RootConfig;
 capabilities?: {dataSpaces?:string[];tools?:string[];models?:string[];hostBindings?:Record<string,string>};
	hostId: string; peerId: string; authorityId: string; controlHostId: string; controlSpaceId: string;
	listen: { host: string; port: number }; mode: "control" | "member";
	keyFile: string; registerTls?: RegisterTlsClient; registerReadSocket?: string; registerSshTarget?: string; installedRegisterFile: string;
	recovery?: PrivateRecoveryConfig;
	/** Recovery admin key pinned for control host changes after a control promotion (src/control-host-change.ts). */
	recoveryAdmin?: { algorithm: import("./auth.ts").Algorithm; publicKey: string };
	/**
	 * lww/set Member: the provisioned, fixed entry replication served in one main-store Space (`space`, alias or ID).
	 * `spaceId` is the logical replicated Space shared by all Members; `members` and `rules` are identical on all of
	 * them. `peers` pins the other Members for the entry stream (pulled from them, exported to them).
	 * `compactEveryMs` runs the history compaction (step 4) that often; absent, it never runs.
	 */
	entryReplication?: { space: string; spaceId: string; replicaId: string; incarnation: string; members: Array<{ replicaId: string; incarnation: string }>;
		rules: import("./entry-replication.ts").EntryReplicationRule[]; clockUncertaintyMs?: number; pollMs?: number; compactEveryMs?: number;
		peers?: Array<{ replicaId: string; hostId: string; peerId: string; address: { host: string; port: number } }> };
	/** Explicit logical Member/Space installed by signed Control commands. */
	membership?:{memberId:string;spaceId:string};
	management: { url: string; tokenFile: string }; groupRoles?: GroupRoles;
	control: { address: { host: string; port: number }; algorithm: Algorithm; publicKey: string };
	/** primary/sync Spaces, each in its own store with its replica listener on `listen.host` (sync-spaces.ts). */
	syncSpaces?: SyncSpaceConfig[];
};
/** Factories for the dedicated stores of primary/sync Spaces; supplied by the daemon, which owns the storage backend. */
export type SyncSpaceFactories = { openSyncStorage: (path: string) => Promise<Storage>; openSyncHarness: (storage: Storage) => Promise<Harness>;
	/** The main store runs on primary/sync (3.8): its current replica configuration, for every Space in it. */
	mainReplica?: () => import("./primary-sync.ts").PrimarySyncConfig;
	/** The last configuration transition of the main store's journal (v3 5.3.1 step 6). */
	mainTransition?: () => ReturnType<typeof import("./primary-sync.ts").lastConfigTransition>;
	/** NotCommitted evidence of the main store's journal (v3 6.2, promotionEvidence) for every Space in it. */
	mainPromotionProof?: (requestEpoch: number) => { hash: string } | null;
	/** How often a running host checks the register for a control host change (default 15 s). */
	followIntervalMs?: number };
export async function startConfiguredFederation(host: Harness, ctx: Context, configFile: string, factories?: SyncSpaceFactories) {
	const raw = { commit: host.commit.bind(host), snapshot: host.snapshot.bind(host) };
	let config = JSON.parse(privateFile(configFile).toString("utf8")) as FederationConfig;
	if (!config.hostId || !config.peerId || !config.authorityId || !config.controlHostId || !config.controlSpaceId || !["control", "member"].includes(config.mode)) throw new Error("incomplete federation provisioning");
	if(config.root&&config.mode!=='control')throw new BootBlocked('native Root must be co-located with authoritative Control');
	const signer = loadFileSigner(config.keyFile);
	if ([config.registerReadSocket,config.registerSshTarget,config.registerTls].filter(Boolean).length !== 1) throw new Error("configure exactly one independent register endpoint");
	const external = config.registerTls ? new TlsRecoveryRegister(config.registerTls) : config.registerSshTarget ? new SshRecoveryRegister(config.registerSshTarget) : new SocketRecoveryRegister(config.registerReadSocket!), installed = new SqliteRecoveryRegister(config.installedRegisterFile);
	const directory = new NetbirdDirectory({ url: config.management.url, token: privateFile(config.management.tokenFile).toString("utf8").trim() });
	const groupRoles = config.groupRoles ?? { "space-hosts": ["member", "host", "router"], "space-admin": ["admin"], "space-observer": ["observer"], "space-enroll": ["unpaired"] };
	let controlSocket: ReturnType<typeof socketTransport> | undefined;
	try {
		const boot = await external.get<HostBootState & Record<string, Json>>(`boot:${config.hostId}`);
		if (!boot || boot.value.hostId !== config.hostId || boot.value.state !== "active") throw new BootBlocked("configured host is not authorized for normal boot");
		// Re-admitted Spaces (readmitSpace by the operator, or the Space of a finished transition): install exactly the
		// active external permit locally when its data incarnation matches the local Space.
		for (const info of await listSpaces(host, ctx)) { const p = boot.value.spaces[info.spaceId], local = await installed.get(`installed:${config.hostId}:${info.spaceId}`);
			if (p?.state === "active" && p.dataIncarnation === info.incarnation && canonicalJson(local?.value ?? null) !== canonicalJson(p as unknown as Json)) await installAdmittedPermit({ external, installed, hostId: config.hostId, spaceId: info.spaceId, localDataIncarnation: info.incarnation }); }
		await directory.refresh();
		const ownPeer = await directory.lookup(config.listen.host);
		if (!ownPeer || ownPeer.id !== config.peerId) throw new Error("listen address does not belong to the provisioned NetBird peer");
		// Control promotion: follow a recorded, recovery-admin-signed change of the control host before anything else.
		if (config.recoveryAdmin) await followControlHostChange(external, installed, { controlSpaceId: config.controlSpaceId, configured: { hostId: config.controlHostId, authorityId: config.authorityId }, recoveryAdmin: config.recoveryAdmin });
		const installedAuthority = await installed.get<any>(`installed-authority:${config.controlSpaceId}`);
		// An installed host change carries the endpoint: this host now uses the promoted control host, its key and address.
		if (installedAuthority?.value.address) config = { ...config, controlHostId: installedAuthority.value.targetHostId, control: { ...config.control, address: installedAuthority.value.address, algorithm: installedAuthority.value.algorithm, publicKey: installedAuthority.value.supervisorKey } };
		const authorityId = installedAuthority?.value.authorityId ?? config.authorityId;
		const controlPublicKey = installedAuthority?.value.supervisorKey ?? config.control.publicKey;
		const authority = await external.get<any>(`authority:${config.controlSpaceId}`);
		if (!authority || authority.value.state !== "active" || authority.value.authorityId !== authorityId || authority.value.hostId !== config.controlHostId || authority.value.supervisorKey !== controlPublicKey) throw new BootBlocked("independent authority is not active or disagrees with installed control identity");
		if (installedAuthority?.value.targetHostId && installedAuthority.value.targetHostId !== config.controlHostId) throw new Error("control endpoint must be reprovisioned for the installed authority successor");
		const identity = new GateIdentity();
		let keys: import("./auth.ts").KeyDirectory, control: { host: Harness; authority: GrantAuthority; leases?:RouterLeaseAuthority; routing?:FederationPolicyAuthority;directory?:CapabilityDirectory;replicaNotices?:ReplicaNoticeBoard;membership?:import("./membership.ts").MembershipController;profiles?:import("./profile-transition.ts").ProfileTransitionController;withAdmin?:<T>(peerId:string,run:()=>Promise<T>)=>Promise<T> } | undefined;
		let controlRemote:RemoteSpace|undefined;
		if (config.mode === "control") {
			if (config.hostId !== config.controlHostId || (await host.snapshot(Registry, ctx))?.aliases.control !== config.controlSpaceId) throw new Error("configured control host or space identity disagrees with provisioned state");
			if (config.control.algorithm !== signer.algorithm || controlPublicKey !== signer.publicKey) throw new Error("provisioned control signer disagrees with installed authority");
			// v3 5.3.1 step 6: the policy step of the last control transition, before grants, leases or the Root exist.
			const transition = factories?.mainTransition?.();
			if (transition) { const t = transition.config, b = transition.previous; await host.commit(tx => alignControlReplicaIn(tx, config.controlSpaceId, authorityId, { transitionId: transition.transitionId, primaryEpoch: t.primaryEpoch, replicaConfigVersion: t.replicaConfigVersion, primaryReplica: t.primaryReplica }, { primaryEpoch: b.primaryEpoch, primaryReplica: b.primaryReplica }), ctx); }
			keys = new SpaceKeyDirectory(host, ctx, Date.now, config.controlSpaceId);
			control = { host, authority: new GrantAuthority({ authorityId, hostId: config.hostId, signer, keys, identity, allowAOnly: async () => { const state = await snapshotSpace(host, config.controlSpaceId, ctx), policy = await external.get<any>(`access:${authorityId}`); return policy ? policy.value.authorityId === authorityId && policy.value.aOnlyAllowed === true : state?.restore?.kind !== "control"; }, refreshIdentity: async conn => { await directory.refresh(); const peer = conn.overlayIp ? await directory.lookup(conn.overlayIp) : null; if (!peer) return null; return identity.authenticate({ ...conn, credentials: { roles: peer.groups.flatMap(g => groupRoles[g] ?? []) } }); } }) };
		} else {
			controlSocket = socketTransport(config.control.address);
			let remote: RemoteSpace;
			remote = new RemoteSpace(controlSocket, { space: "control", signer, expectedGateHostId: config.controlHostId, ownPeerId: config.peerId, grantProvider: () => remote.requestGrant() });
			await remote.authenticate();controlRemote=remote;
			keys = { find: (peerId, keyId) => remote.lookupPeerKey(peerId, keyId) };
		}
		const checkControlAuthority=(a:any)=>{if(a?.value.state!=="active"||a.value.authorityId!==authorityId||a.value.hostId!==config.controlHostId||a.value.supervisorKey!==controlPublicKey)throw new BootBlocked("control authority changed");};
        const assertControl=async()=>checkControlAuthority(await external.get<any>(`authority:${config.controlSpaceId}`));
		const controlPeer=config.mode==="control"?ownPeer:await directory.lookup(config.control.address.host);if(!controlPeer)throw new BootBlocked("control peer unavailable in provisioned directory");
		if(control){control.directory=new CapabilityDirectory({host,ctx,spaceId:config.controlSpaceId,assertAuthority:assertControl,hostForPeer:p=>config.capabilities?.hostBindings?.[p]});control.replicaNotices=new ReplicaNoticeBoard({host,ctx,controlSpaceId:config.controlSpaceId,assertAuthority:assertControl,hostForPeer:p=>config.capabilities?.hostBindings?.[p]});control.leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:config.controlSpaceId,authorityId,peerId:controlPeer.id,signer,keys,assertAuthority:assertControl,...(factories?.mainReplica?{controlEpoch:()=>factories.mainReplica!().primaryEpoch}:{})});control.routing=new FederationPolicyAuthority({host,ctx,controlSpaceId:config.controlSpaceId,authorityId,peerId:controlPeer.id,signer,assertAuthority:assertControl});}
		const grantVerifier=new GrantVerifier({authorityId,issuerHostId:config.controlHostId,algorithm:config.control.algorithm,publicKey:controlPublicKey});
		const verifierFor=(h:Harness,replicaConfig?:(spaceId:string)=>{replicaConfigVersion:number}|null)=>new DelegationVerifier({host:h,replicaConfig,ctx,authorityId,controlSpaceId:config.controlSpaceId,supervisorPeerId:controlPeer.id,supervisorKey:{algorithm:config.control.algorithm,publicKey:controlPublicKey},keys,grants:grantVerifier,policy:async()=>{if(control){const p=(await control.routing!.state()).policy;if(!p)throw new Error("no federation policy installed");return p;}return verifyFederationPolicy(await controlRemote!.requestRoutingPolicy(),{authorityId,peerId:controlPeer.id,algorithm:config.control.algorithm,publicKey:controlPublicKey});}});const delegation=verifierFor(host,factories?.mainReplica?()=>factories.mainReplica!():undefined);

		const membership=config.membership?new MemberLifecycle({host,ctx,memberId:config.membership.memberId,spaceId:config.membership.spaceId,authorityId,peerId:config.peerId,signer,controlPin:{issuer:controlPeer.id,algorithm:config.control.algorithm,publicKey:controlPublicKey},assertAuthority:async()=>{const b=await external.get<any>(`boot:${config.hostId}`);if(b?.value.state!=="active"||b.value.spaces?.[config.membership!.spaceId]?.authorityId!==authorityId)throw new BootBlocked("Member boot authority changed");}}):undefined;
        let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;
        if(config.root){try{root=await createConfiguredRoot({...(factories?.mainReplica?{controlEpoch:()=>factories.mainReplica!().primaryEpoch}:{}),host,ctx,hostId:config.hostId,peerId:config.peerId,ownAddress:config.listen.host,authorityId,controlSpaceId:config.controlSpaceId,controlSigner:signer,keys,directory,groupRoles,external,installed,grants:control!.authority,leases:control!.leases!,root:config.root,assertControl,checkControlAuthority});control!.membership=root.membership;control!.profiles=root.profiles;control!.withAdmin=root.withAdmin;}catch(e){await root?.close();throw e;}}
		const syncSpaces:SyncSpace[]=[];
		if(config.syncSpaces?.length){
			if(!factories)throw new Error("primary/sync Spaces need storage and Harness factories from the daemon");
			const r=await openSyncSpaces(config.syncSpaces,c=>openSyncSpace({config:c,hostId:config.hostId,authorityId,bindIp:config.listen.host,signer,external,installed,ctx,openStorage:factories.openSyncStorage,openHarness:factories.openSyncHarness}));
			syncSpaces.push(...r.opened);for(const f of r.failed)console.error(`primary/sync Space ${f.alias} stays unserved:`,f.error);
		}
		const optionFor=(sp:SyncSpace)=>{
			// The Member state of a replicated Space is part of that Space, so it follows the replicas.
			const lifecycle=sp.config.membership?new MemberLifecycle({host:sp.harness!,ctx,memberId:sp.config.membership.memberId,spaceId:sp.config.spaceId,authorityId,peerId:config.peerId,signer,controlPin:{issuer:controlPeer.id,algorithm:config.control.algorithm,publicKey:controlPublicKey},assertAuthority:async()=>{const b=await external.get<any>(`boot:${config.hostId}`);if(b?.value.state!=="active"||b.value.spaces?.[sp.config.spaceId]?.authorityId!==authorityId)throw new BootBlocked("Member boot authority changed");}}):undefined;
			return {spaceId:sp.config.spaceId,alias:sp.config.alias,host:sp.harness!,primaryEpoch:()=>sp.journal.config.primaryEpoch,delegation:verifierFor(sp.harness!,id=>id===sp.config.spaceId?sp.journal.config:null),
				membership:lifecycle,refreshPolicy:lifecycle&&controlRemote?async()=>lifecycle.installPolicy(await controlRemote!.requestRoutingPolicy()):undefined,
				onSealed:()=>resolveSealed(sp),sealedCandidate:()=>sealedOf(sp),promotionProof:async(_space:string|undefined,epoch:number)=>promotionEvidence(sp.journal,epoch,config.hostId)};};
		// A sealed, unconfirmed commit: the Space answers CommitSealed until this host resolved it and serves it anew.
		const sealedOf=sealedCandidateOf,resolver=sealedResolver({set:next=>runtime.setSyncSpace(next),serve:optionFor});
		const resolveSealed=(sp:SyncSpace)=>{void resolver.resolve(sp);};
		const syncOptions=syncSpaces.filter(sp=>sp.harness).map(optionFor);
		const unresolvedSyncSpaces=syncSpaces.filter(sp=>!sp.harness&&sp.role()==="primary"&&sealedOf(sp)).map(sp=>({spaceId:sp.config.spaceId,alias:sp.config.alias,sealed:sealedOf(sp)!}));
		// v3 5.3.1 step 5: a primary keeps offering the notice of its last transition until the router adopted it.
		let noticeTimer:ReturnType<typeof setTimeout>|undefined,noticeStopped=false,noticeActive:Promise<void>=Promise.resolve();
		const publishNotices=()=>{noticeActive=(async()=>{for(const sp of syncSpaces){const n=await sp.notice();if(!n)continue;if(control)await control.replicaNotices!.publish(n,{peerId:config.peerId,roles:["host"],key:{algorithm:signer.algorithm,publicKey:signer.publicKey}});else await controlRemote!.publishReplicaNotice(n);}})()
			.catch(e=>console.error("Replica notice:",e instanceof Error?e.message:String(e))).then(()=>{if(!noticeStopped)noticeTimer=setTimeout(publishNotices,CAPABILITY_HEARTBEAT_MS);});};
		// lww/set: the provisioned entry replication of one Space; its merge types bypass the core (step 1 serves local
		// writes and reads; import and export between Members follow in step 2).
		let merge: import("./service.ts").SpaceServiceOptions["merge"], entryExport: import("./runtime.ts").FederationHostOptions["entryExport"], entryController: EntryReplicationController | undefined;
		if (config.entryReplication) {
			const er = config.entryReplication, info = (await listSpaces(host, ctx)).find(i => i.spaceId === er.space || i.alias === er.space);
			if (er.compactEveryMs !== undefined && (!Number.isSafeInteger(er.compactEveryMs) || er.compactEveryMs < 1000)) throw new BootBlocked("entryReplication.compactEveryMs must be an integer of at least 1000");
			if (!info) throw new BootBlocked(`entry replication names an unknown Space ${er.space}`);
			const controller = entryController = new EntryReplicationController({ host, ctx, config: { spaceId: er.spaceId, authorityId, replicaId: er.replicaId, incarnation: er.incarnation, members: er.members, rules: er.rules },
				// Local calls are authorized by the space service, export by the front (pinned, proven peers), import by this host.
				authorize: async () => {},
				assertActive: async () => { const b = await external.get<any>(`boot:${config.hostId}`); if (b?.value.state !== "active" || b.value.spaces?.[info.spaceId]?.state !== "active") throw new BootBlocked("entry replica Space is not admitted"); },
				clockUncertaintyMs: () => er.clockUncertaintyMs ?? 1000 });
			const adapter = { controller, rules: er.rules };
			merge = space => (space ?? "default") === info.alias || space === info.spaceId ? adapter : undefined;
			const peers = new Set((er.peers ?? []).map(p => p.peerId));
			if (peers.size) entryExport = { peers, describe: async () => await controller.describeStream() as unknown as import("./core.ts").Json, changes: async (after, maxBytes) => await controller.streamChanges(after, maxBytes) as unknown as import("./core.ts").Json };
		}
		let runtime:Awaited<ReturnType<typeof startFederationHost>>;try{runtime = await startFederationHost(host, ctx, { ...config, ...(merge ? { merge } : {}), ...(entryExport ? { entryExport } : {}), syncSpaces: syncOptions, unresolvedSyncSpaces, ...(factories?.mainPromotionProof ? { promotionProof: async (_space: string | undefined, epoch: number) => factories.mainPromotionProof!(epoch) } : {}), membership, ...(membership&&controlRemote?{refreshPolicy:async()=>membership.installPolicy(await controlRemote!.requestRoutingPolicy())}:{}), authorityId, directory, groupRoles, keys, control, delegation, verifier: grantVerifier, boot: { external, installed, ...(factories?.mainReplica?{replicaConfig:()=>factories.mainReplica!()}:{}) } });}catch(e){for(const sp of syncSpaces)await sp.close();await root?.close();throw e;}
		if(syncSpaces.length)publishNotices();
		for(const sp of syncSpaces)if(!sp.harness&&sp.role()==="primary"&&sealedOf(sp))resolveSealed(sp);
		// The reaper can seal a candidate too, without any call noticing it.
		resolver.attach(syncSpaces);
		let recovery: Awaited<ReturnType<typeof startConfiguredRecovery>> | undefined;
		try { if (config.recovery) recovery = await startConfiguredRecovery(host, raw, ctx, { ...config, authorityId, signer, controlKey: { algorithm: config.control.algorithm, publicKey: controlPublicKey }, config: config.recovery, external, installed }); await host.snapshot(Registry, ctx); } catch (e) { await recovery?.close();await root?.close(); await runtime.close(); noticeStopped=true;if(noticeTimer)clearTimeout(noticeTimer);await noticeActive;for(const sp of syncSpaces)await sp.close().catch(()=>{}); throw e; }
        let capabilityTimer:ReturnType<typeof setTimeout>|undefined, capabilityStopped=false, capabilityActive:Promise<void>=Promise.resolve();
        const report=()=>({hostId:config.hostId,resources:{memoryBytes:totalmem(),cpus:availableParallelism()},tools:config.capabilities?.tools??[],models:config.capabilities?.models??[],metrics:{freeMemoryBytes:freemem()}});
        const heartbeat=()=>{capabilityActive=(async()=>{
            const r=report();
            for(const sid of config.capabilities?.dataSpaces??[]) await new CapabilityDirectory({host,ctx,spaceId:sid,assertAuthority:async()=>{const b=await external.get<any>(`boot:${config.hostId}`);if(b?.value.state!=="active"||b.value.spaces?.[sid]?.authorityId!==authorityId)throw new BootBlocked("Capability boot is fenced");}}).heartbeat(r,{peerId:config.hostId,roles:["host"]});
            if(control) await control.directory!.heartbeat(r,{peerId:config.peerId,roles:["host"]});
            else await controlRemote!.publishCapability(r);
        })().catch(e=>console.error("Capability heartbeat:",e instanceof Error?e.message:String(e))).then(()=>{if(!capabilityStopped)capabilityTimer=setTimeout(heartbeat,CAPABILITY_HEARTBEAT_MS);});};
        // Start only from explicit directory provisioning; a directory entry does not add a routing Member.
        if(config.capabilities)heartbeat();
		const trustedConnection = async () => { await directory.refresh(); const peer = await directory.lookup(config.listen.host); if (!peer || peer.id !== config.peerId) throw new Error("local service peer is no longer known to NetBird"); return { peerId: peer.id, overlayIp: peer.ip, credentials: { roles: peer.groups.flatMap(g => groupRoles[g] ?? []) } }; };
		const nativeService = { async handle(call: unknown, conn: import("./service.ts").Connection) { Object.assign(conn, await trustedConnection()); return runtime.service.handle(call, conn); } };
		// lww/set step 2: pull the entry stream of every pinned peer. Network failures are temporary and retried by the
		// pump; anything else stops it, is logged and restarts after a pause.
		const pumps: AbortController[] = [], pumpTransports: Array<{ close(): void }> = [];
		for (const peer of entryController ? config.entryReplication!.peers ?? [] : []) {
			const ac = new AbortController(); pumps.push(ac);
			const t = socketTransport(peer.address, { localAddress: config.listen.host, connectTimeoutMs: 8000 }); pumpTransports.push(t);
			const remote = new RemoteSpace(t, { signer, ownPeerId: config.peerId, expectedGateHostId: peer.hostId, attempts: 1, callTimeoutMs: 15_000 });
			const temporary = (e: unknown) => e instanceof TransportFailure || /timed out|ECONN|EHOST|closed|socket/i.test(e instanceof Error ? e.message : String(e));
			const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { await remote.authenticate(); return await f(); } catch (e) { if (temporary(e)) throw new EntryReplicationUnavailable(e instanceof Error ? e.message : String(e)); throw e; } };
			const source = { describe: () => wrap(() => remote.entryDescribe()), changes: (after: number, maxBytes: number) => wrap(() => remote.entryChanges(after, maxBytes)) };
			void (async () => {
				while (!ac.signal.aborted) {
					try {
						const d = await source.describe();
						if (d.source.replicaId !== peer.replicaId) throw new Error(`peer ${peer.peerId} serves replica ${d.source.replicaId}, not ${peer.replicaId}`);
						await new EntryReplicationPump({ target: entryController!, source, identity: d.source, pollMs: config.entryReplication!.pollMs ?? 2000 }).run(ac.signal);
					} catch (e) { if (ac.signal.aborted) break; if (!(e instanceof EntryReplicationUnavailable)) console.error(`Entry replication from ${peer.replicaId}:`, e instanceof Error ? e.message : String(e)); }
					await new Promise(r => setTimeout(r, 5000).unref?.());
				}
			})();
		}
		// lww/set step 4: compaction needs a recorded vector from every Member; until then it does nothing.
		let compactTimer: ReturnType<typeof setTimeout> | undefined, compactStopped = false;
		const compactEvery = entryController ? config.entryReplication!.compactEveryMs : undefined;
		const compactOnce = () => { void entryController!.compact(`compact-${Date.now()}`)
			.then(r => { if (r.dropped) console.log(`Entry replication compacted ${r.dropped} changes`); })
			.catch(e => console.error("Entry replication compaction:", e instanceof Error ? e.message : String(e)))
			.then(() => { if (!compactStopped) { compactTimer = setTimeout(compactOnce, compactEvery); compactTimer.unref?.(); } }); };
		if (compactEvery !== undefined) { compactTimer = setTimeout(compactOnce, compactEvery); compactTimer.unref?.(); }
		// Control promotion while running: a recorded, signed host change is installed at once and reported; the daemon
		// restarts through the start path, which uses the installed endpoint.
		let reportChange: (c: import("./control-host-change.ts").ControlHostChange) => void = () => {};
		const controlChanged = new Promise<import("./control-host-change.ts").ControlHostChange>(resolve => { reportChange = resolve; });
		const followTimer = config.recoveryAdmin ? setInterval(() => { void followControlHostChange(external, installed, { controlSpaceId: config.controlSpaceId, configured: { hostId: config.controlHostId, authorityId }, recoveryAdmin: config.recoveryAdmin! })
			.then(c => { if (c) reportChange(c); }).catch(e => console.error("Control host change:", e instanceof Error ? e.message : String(e))); }, factories?.followIntervalMs ?? 15_000) : undefined;
		followTimer?.unref?.();
		return { ...runtime, root, service: nativeService, config, trustedConnection, controlChanged, entryReplication: entryController, close: async () => { await resolver.stop(); if (followTimer) clearInterval(followTimer); compactStopped = true; if (compactTimer) clearTimeout(compactTimer); for (const ac of pumps) ac.abort(); for (const t of pumpTransports) t.close(); capabilityStopped=true;if(capabilityTimer)clearTimeout(capabilityTimer);await capabilityActive;noticeStopped=true;if(noticeTimer)clearTimeout(noticeTimer);await noticeActive;for(const sp of syncSpaces)await sp.close().catch(e=>console.error("primary/sync Space close:",e instanceof Error?e.message:String(e)));try { try { await recovery?.close(); } finally { try{await root?.close();}finally{await runtime.close();} } } finally { controlSocket?.close(); external.close(); installed.close(); } } };
	} catch (e) { controlSocket?.close(); external.close(); installed.close(); throw e; }
}

/**
 * Quarantine start (v3 5.3.1 step 7): a host released into quarantine serves nothing; it only opens the journals and
 * replica listeners of its primary/sync Spaces so a primary can run setStandby against it. `untilActive` resolves
 * once setStandby (or an operator) made the host active again; the daemon then restarts into the normal runtime.
 */
export async function startQuarantineReplicas(ctx: Context, configFile: string, factories: SyncSpaceFactories, o: { pollMs?: number } = {}) {
	const config = JSON.parse(privateFile(configFile).toString("utf8")) as FederationConfig;
	if (!config.syncSpaces?.length) throw new BootBlocked("quarantine start needs provisioned primary/sync Spaces");
	if ([config.registerReadSocket,config.registerSshTarget,config.registerTls].filter(Boolean).length !== 1) throw new Error("configure exactly one independent register endpoint");
	const external = config.registerTls ? new TlsRecoveryRegister(config.registerTls) : config.registerSshTarget ? new SshRecoveryRegister(config.registerSshTarget) : new SocketRecoveryRegister(config.registerReadSocket!), installed = new SqliteRecoveryRegister(config.installedRegisterFile);
	const state = async () => (await external.get<HostBootState & Record<string, Json>>(`boot:${config.hostId}`))?.value.state;
	if (await state() !== "quarantine") { external.close(); installed.close(); throw new BootBlocked("host is not in quarantine"); }
	const signer = loadFileSigner(config.keyFile);
	const r = await openSyncSpaces(config.syncSpaces, c => openSyncSpace({ config: c, hostId: config.hostId, authorityId: config.authorityId, bindIp: config.listen.host, signer, external, installed, ctx, openStorage: factories.openSyncStorage, openHarness: factories.openSyncHarness, listenOnly: true }));
	for (const f of r.failed) console.error(`primary/sync Space ${f.alias} has no quarantine listener:`, f.error);
	let stopped = false;
	const untilActive = async () => { while (!stopped) { try { if (await state() === "active") return true; } catch (e) { console.error("quarantine boot check:", e instanceof Error ? e.message : String(e)); } await new Promise(res => setTimeout(res, o.pollMs ?? 5000)); } return false; };
	return { spaces: r.opened, failed: r.failed, untilActive, close: async () => { stopped = true; for (const sp of r.opened) await sp.close(); external.close(); installed.close(); } };
}
