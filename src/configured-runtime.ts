import {createConfiguredRoot,type RootConfig} from './configured-root.ts';
import {CapabilityDirectory,CAPABILITY_HEARTBEAT_MS} from "./capability-directory.ts";
import {ReplicaNoticeBoard} from "./replica-notice.ts";
import {totalmem,freemem,availableParallelism} from "node:os";
import {MemberLifecycle} from "./membership.ts";
// Deployed composition from explicitly provisioned identities, pinned keys and independently supplied boot records.
import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { privateFile, loadFileSigner } from "./keys.ts";
import { NetbirdDirectory, GateIdentity, type GroupRoles } from "./gate.ts";
import { GrantAuthority, GrantVerifier } from "./grants.ts";
import { SpaceKeyDirectory } from "./enroll.ts";
import { RemoteSpace } from "./remote.ts";
import { socketTransport } from "./socket.ts";
import { startFederationHost } from "./runtime.ts";
import { TlsRecoveryRegister, type RegisterTlsClient } from "./tls-register.ts";
import { SshRecoveryRegister } from "./ssh-register.ts";
import { SocketRecoveryRegister } from "./register-service.ts";
import { SqliteRecoveryRegister } from "./recovery-register.ts";
import { BootBlocked, type HostBootState } from "./boot.ts";
import { Registry, snapshotSpace } from "./spaces.ts";
import type { Json } from "./core.ts";
import { startConfiguredRecovery, type PrivateRecoveryConfig } from "./configured-recovery.ts";
import {RouterLeaseAuthority,DelegationVerifier} from "./delegation.ts";
import {FederationPolicyAuthority,verifyFederationPolicy} from "./federation-policy.ts";
import type { Algorithm } from "./auth.ts";

export type FederationConfig = {
 root?:RootConfig;
 capabilities?: {dataSpaces?:string[];tools?:string[];models?:string[];hostBindings?:Record<string,string>};
	hostId: string; peerId: string; authorityId: string; controlHostId: string; controlSpaceId: string;
	listen: { host: string; port: number }; mode: "control" | "member";
	keyFile: string; registerTls?: RegisterTlsClient; registerReadSocket?: string; registerSshTarget?: string; installedRegisterFile: string;
	recovery?: PrivateRecoveryConfig;
	/** Explicit logical Member/Space installed by signed Control commands. */
	membership?:{memberId:string;spaceId:string};
	management: { url: string; tokenFile: string }; groupRoles?: GroupRoles;
	control: { address: { host: string; port: number }; algorithm: Algorithm; publicKey: string };
};
export async function startConfiguredFederation(host: Harness, ctx: Context, configFile: string) {
	const raw = { commit: host.commit.bind(host), snapshot: host.snapshot.bind(host) };
	const config = JSON.parse(privateFile(configFile).toString("utf8")) as FederationConfig;
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
		await directory.refresh();
		const ownPeer = await directory.lookup(config.listen.host);
		if (!ownPeer || ownPeer.id !== config.peerId) throw new Error("listen address does not belong to the provisioned NetBird peer");
		const installedAuthority = await installed.get<any>(`installed-authority:${config.controlSpaceId}`);
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
		if(control){control.directory=new CapabilityDirectory({host,ctx,spaceId:config.controlSpaceId,assertAuthority:assertControl,hostForPeer:p=>config.capabilities?.hostBindings?.[p]});control.replicaNotices=new ReplicaNoticeBoard({host,ctx,controlSpaceId:config.controlSpaceId,assertAuthority:assertControl,hostForPeer:p=>config.capabilities?.hostBindings?.[p]});control.leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:config.controlSpaceId,authorityId,peerId:controlPeer.id,signer,keys,assertAuthority:assertControl});control.routing=new FederationPolicyAuthority({host,ctx,controlSpaceId:config.controlSpaceId,authorityId,peerId:controlPeer.id,signer,assertAuthority:assertControl});}
		const grantVerifier=new GrantVerifier({authorityId,issuerHostId:config.controlHostId,algorithm:config.control.algorithm,publicKey:controlPublicKey});
		const delegation=new DelegationVerifier({host,ctx,authorityId,controlSpaceId:config.controlSpaceId,supervisorPeerId:controlPeer.id,supervisorKey:{algorithm:config.control.algorithm,publicKey:controlPublicKey},keys,grants:grantVerifier,policy:async()=>{if(control){const p=(await control.routing!.state()).policy;if(!p)throw new Error("no federation policy installed");return p;}return verifyFederationPolicy(await controlRemote!.requestRoutingPolicy(),{authorityId,peerId:controlPeer.id,algorithm:config.control.algorithm,publicKey:controlPublicKey});}});

		const membership=config.membership?new MemberLifecycle({host,ctx,memberId:config.membership.memberId,spaceId:config.membership.spaceId,authorityId,peerId:config.peerId,signer,controlPin:{issuer:controlPeer.id,algorithm:config.control.algorithm,publicKey:controlPublicKey},assertAuthority:async()=>{const b=await external.get<any>(`boot:${config.hostId}`);if(b?.value.state!=="active"||b.value.spaces?.[config.membership!.spaceId]?.authorityId!==authorityId)throw new BootBlocked("Member boot authority changed");}}):undefined;
        let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;
        if(config.root){try{root=await createConfiguredRoot({host,ctx,hostId:config.hostId,peerId:config.peerId,ownAddress:config.listen.host,authorityId,controlSpaceId:config.controlSpaceId,controlSigner:signer,keys,directory,groupRoles,external,installed,grants:control!.authority,leases:control!.leases!,root:config.root,assertControl,checkControlAuthority});control!.membership=root.membership;control!.profiles=root.profiles;control!.withAdmin=root.withAdmin;}catch(e){await root?.close();throw e;}}
		let runtime:Awaited<ReturnType<typeof startFederationHost>>;try{runtime = await startFederationHost(host, ctx, { ...config, membership, ...(membership&&controlRemote?{refreshPolicy:async()=>membership.installPolicy(await controlRemote!.requestRoutingPolicy())}:{}), authorityId, directory, groupRoles, keys, control, delegation, verifier: grantVerifier, boot: { external, installed } });}catch(e){await root?.close();throw e;}
		let recovery: Awaited<ReturnType<typeof startConfiguredRecovery>> | undefined;
		try { if (config.recovery) recovery = await startConfiguredRecovery(host, raw, ctx, { ...config, authorityId, signer, controlKey: { algorithm: config.control.algorithm, publicKey: controlPublicKey }, config: config.recovery, external, installed }); await host.snapshot(Registry, ctx); } catch (e) { await recovery?.close();await root?.close(); await runtime.close(); throw e; }
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
		return { ...runtime, root, service: nativeService, config, trustedConnection, close: async () => { capabilityStopped=true;if(capabilityTimer)clearTimeout(capabilityTimer);await capabilityActive;try { try { await recovery?.close(); } finally { try{await root?.close();}finally{await runtime.close();} } } finally { controlSocket?.close(); external.close(); installed.close(); } } };
	} catch (e) { controlSocket?.close(); external.close(); installed.close(); throw e; }
}
