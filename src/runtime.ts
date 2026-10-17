import type {ProfileTransitionController} from './profile-transition.ts';
import type {DataAdminController} from "./data-admin.ts";
import type {CapabilityDirectory} from "./capability-directory.ts";
import type {MemberLifecycle,MembershipController} from "./membership.ts";
import type {RunGateService} from "./run-member.ts";
import {runCommands,type RunController} from "./run-controller.ts";
import {appliedWorkers,workerCommands,type WorkerAssignments} from "./workers.ts";
import {CONTROL_SPACE} from "./enroll.ts";
import type {SpaceLifecycleService,spaceCommands} from "./space-lifecycle.ts";
import {deploymentCommands,type DeploymentController} from "./deployment.ts";
import {auditLog,collectAlerts} from "./alerts.ts";
// One composition root for the persistent host: gate -> enrollment -> control rules -> proof -> space.
// The control primary is supplied explicitly; members never mint grants from a local key/cache snapshot.
import type {FederationPolicyAuthority} from "./federation-policy.ts";
import type {DelegationVerifier,RouterLeaseAuthority} from "./delegation.ts";
import { RotationService } from "./rotation.ts";
import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Json } from "./core.ts";
import { SpaceService, sealedReply, type Call, type Reply, type Connection } from "./service.ts";
import { GateIdentity, startGate, type GateOptions } from "./gate.ts";
import { ProvingService, type KeyDirectory } from "./auth.ts";
import { EnrollmentService } from "./enroll.ts";
import { ControlAccess, Supervisor } from "./supervisor.ts";
import { GrantAuthority, GrantVerifier } from "./grants.ts";
import { startService } from "./index.ts";
import { listSpaces, snapshotSpace } from "./spaces.ts";
import type { SpaceHost } from "./client.ts";
import { installBootGuard } from "./boot.ts";
import type { RecoveryRegister } from "./recovery-register.ts";

export type UnresolvedSyncSpace = { spaceId: string; alias: string; sealed: { revision: number; hash: string } };
type SyncEntry = NonNullable<FederationHostOptions["syncSpaces"]>[number];
export type FederationHostOptions = Omit<GateOptions, "keys"> & {
	hostId: string; authorityId: string; keys: KeyDirectory; verifier: GrantVerifier;
	boot?: { external: RecoveryRegister; installed: RecoveryRegister; /** main store on primary/sync: its journal configuration for every Space in it */ replicaConfig?: (spaceId: string) => import("./primary-sync.ts").PrimarySyncConfig | null };
	/**
	 * primary/sync Spaces, each in its own dedicated store (one commit history per Space, v3 7.2): calls naming the
	 * Space go to a service over that Harness, with its own delegation verifier; boot guard and replica wiring are the
	 * caller's (configured-runtime).
	 */
	syncSpaces?: Array<{ spaceId: string; alias: string; host: Harness; delegation?: import("./delegation.ts").DelegationVerifier; primaryEpoch: () => number;
		/** Member lifecycle of this Space in its own store; membership instructions naming the Space go here. */
		membership?: import("./membership.ts").MemberLifecycle; refreshPolicy?: () => Promise<void>;
		/** A commit of this Space was sealed but not confirmed; the caller resolves it and serves the Space anew (setSyncSpace). */
		onSealed?: () => void; sealedCandidate?: () => { revision: number; hash: string } | null;
		/** NotCommitted evidence of this Space's journal (v3 6.2). */
		promotionProof?: (space: string | undefined, requestEpoch: number) => Promise<{ hash: string } | null> }>;
	/** primary/sync Spaces whose sealed candidate is not resolved yet: answered with `CommitSealed` until setSyncSpace. */
	unresolvedSyncSpaces?: UnresolvedSyncSpace[];
	/** Explicit fixture mode. Never set in a deployed host. */
	unsafeSkipBootGuardForTests?: true;
	/** Only the control runtime supplies these. An injected control Host must be authoritative, never a restored replica. */
	delegation?: DelegationVerifier;
	membership?: MemberLifecycle;
	/** Applies signed RunGate instructions of the run controller to this host's Spaces. */
	runGates?: RunGateService;
	/** Applies signed Space lifecycle instructions (create, archive, reactivate, delete) to this host's Spaces. */
	spaceLifecycle?: SpaceLifecycleService;
	refreshPolicy?:()=>Promise<void>;
	/** lww/set types of this host's main-store Spaces, served by entry replication (docs/ap3-replikation.md). */
	merge?: import("./service.ts").SpaceServiceOptions["merge"];
	/** Entry stream export of this host's merge replica to its pinned peers (docs/ap3-replikation.md, step 2). */
	entryExport?: { peers: ReadonlySet<string>; describe: () => Promise<Json>; changes: (after: number, maxBytes: number) => Promise<Json> };
	control?: { host: SpaceHost; authority: GrantAuthority; leases?: RouterLeaseAuthority; routing?: FederationPolicyAuthority; directory?: CapabilityDirectory; replicaNotices?: import("./replica-notice.ts").ReplicaNoticeBoard; dataAdmin?:DataAdminController; membership?: MembershipController; profiles?:ProfileTransitionController; runs?: RunController; runAdvanceMs?: number; workers?: WorkerAssignments; spaces?: ReturnType<typeof spaceCommands>; deployment?: DeploymentController; withAdmin?:<T>(peerId:string,run:()=>Promise<T>)=>Promise<T> };
};
export async function startFederationHost(host: Harness, ctx: Context, o: FederationHostOptions) {
	if (o.control && o.control.host !== host) throw new Error("the authoritative control runtime must use its own harness");
	if (!o.boot && !o.unsafeSkipBootGuardForTests) throw new Error("a federation host requires independent boot authorization and local installation");
	const stopBoot = o.boot ? installBootGuard(host, ctx, { ...o.boot, hostId: o.hostId, authorityId: o.authorityId }) : undefined;
	const identity = new GateIdentity();
	const service = new SpaceService({ host, ctx, identity, hostId: o.hostId, authorityId: o.authorityId, now: o.now, ...(o.merge ? { merge: o.merge } : {}),
		epochForSpace: async space => { const info = (await listSpaces(host, ctx)).find(i => i.spaceId === space || i.alias === (space ?? "default")); return info ? o.boot?.replicaConfig?.(info.spaceId)?.primaryEpoch ?? (await snapshotSpace(host, info.spaceId, ctx))?.primaryEpoch ?? 1 : 0; },
		authorize: async (call,id,conn)=>{const auth=call.frame?.delegation?o.delegation?await o.delegation.check(call,id,conn):await Promise.reject(new Error("delegation not configured")):o.verifier.check(call.frame?.grant,id,call,conn);await o.refreshPolicy?.();auth.check();return auth;} });
	const syncServices = new Map<string, SpaceService | { handle: (c: unknown, conn: Connection) => Promise<Reply>; handleText: (t: string, conn: Connection) => Promise<string> }>(), mainSpaces = await listSpaces(host, ctx);
	// The current entry of every primary/sync Space: served, or unresolved after a sealed commit (setSyncSpace swaps them).
	const syncEntries: Array<SyncEntry | UnresolvedSyncSpace> = [];
	const makeSyncService = (sp: SyncEntry) => new SpaceService({ host: sp.host, ctx, identity, hostId: o.hostId, authorityId: o.authorityId, now: o.now, epochForSpace: async () => sp.primaryEpoch(), ...(sp.onSealed ? { onSealed: sp.onSealed } : {}), ...(sp.sealedCandidate ? { sealedCandidate: sp.sealedCandidate } : {}), ...(sp.promotionProof ? { promotionProof: sp.promotionProof } : {}),
			authorize: async (call,id,conn)=>{const auth=call.frame?.delegation?sp.delegation?await sp.delegation.check(call,id,conn):await Promise.reject(new Error("delegation not configured")):o.verifier.check(call.frame?.grant,id,call,conn);await (sp.refreshPolicy ?? o.refreshPolicy)?.();auth.check();return auth;} });
	const sealedService = (u: UnresolvedSyncSpace) => {
		const handle = async (_c: unknown, conn: Connection): Promise<Reply> => await identity.authenticate(conn) ? sealedReply(u.sealed) : { ok: false, error: { code: "Unauthenticated", message: "the connection has no known identity" } };
		return { handle, handleText: async (_t: string, conn: Connection) => JSON.stringify(await handle(undefined, conn)) };
	};
	for (const u of o.unresolvedSyncSpaces ?? []) {
		if (mainSpaces.some(i => i.spaceId === u.spaceId || i.alias === u.alias) || syncServices.has(u.spaceId) || syncServices.has(u.alias)) throw new Error(`primary/sync Space ${u.alias} needs its own store and a unique ID and alias`);
		syncServices.set(u.spaceId, sealedService(u)); syncServices.set(u.alias, sealedService(u)); syncEntries.push(u);
	}
	for (const sp of o.syncSpaces ?? []) {
		if (sp.host === host || mainSpaces.some(i => i.spaceId === sp.spaceId || i.alias === sp.alias) || syncServices.has(sp.spaceId) || syncServices.has(sp.alias)) throw new Error(`primary/sync Space ${sp.alias} needs its own store and a unique ID and alias`);
		const svc = makeSyncService(sp);
		syncServices.set(sp.spaceId, svc); syncServices.set(sp.alias, svc); syncEntries.push(sp);
	}
	const syncEntry = (space: unknown) => syncEntries.find(sp => sp.spaceId === space || sp.alias === space);
	const pick = (c: unknown) => syncServices.get((c as any)?.space) ?? service;
	const dispatch = syncServices.size || o.syncSpaces?.length ? { handle: (c: unknown, conn: Connection) => pick(c).handle(c as any, conn), handleText: async (t: string, conn: Connection, bytes?: number) => { let c: unknown; try { c = JSON.parse(t); } catch { return service.handleText(t, conn, bytes); } return pick(c).handleText(t, conn, bytes); } } : service;
	const notices=["epochNotice","membershipInstruction","runGateInstruction","spaceLifecycleInstruction","entryDescribe","entryChanges"];
	const noticeService = o.delegation || o.membership || o.runGates || o.spaceLifecycle || o.entryExport || (o.syncSpaces ?? []).some(sp => sp.membership) ? {handle:async(c:unknown,conn:Connection):Promise<Reply>=>{ if(!notices.includes((c as any)?.method))return dispatch.handle(c as any,conn);try{const id=await identity.authenticate(conn);if(!(conn.state as any)?.proof||!id?.roles.some(r=>["router","host","admin"].includes(r)))throw new Error("epoch notice requires proven service peer");
		// lww/set step 2: the entry stream of this host's replica, only for the pinned peers of the same replication.
		if((c as any).method==="entryDescribe"||(c as any).method==="entryChanges"){if(!o.entryExport)throw new Error("entry replication not configured");if(!conn.peerId||!o.entryExport.peers.has(conn.peerId))throw new Error("peer is not a replica of this entry replication");
		 return{ok:true,result:(c as any).method==="entryDescribe"?await o.entryExport.describe():await o.entryExport.changes(Number((c as any).args?.after),Number((c as any).args?.maxBytes))};}
		if((c as any).method==="spaceLifecycleInstruction"){if(!o.spaceLifecycle)throw new Error("space lifecycle not configured");return{ok:true,result:await o.spaceLifecycle.apply((c as any).args?.instruction) as any};}if((c as any).method==="runGateInstruction"){if(!o.runGates)throw new Error("run gates not configured");return{ok:true,result:await o.runGates.apply((c as any).args?.instruction) as any};}if((c as any).method==="membershipInstruction"){const inst=(c as any).args?.instruction,lifecycleEntry=syncEntries.find(sp=>sp.spaceId===inst?.value?.spaceId&&('sealed' in sp||sp.membership));if(lifecycleEntry&&'sealed' in lifecycleEntry)return sealedReply(lifecycleEntry.sealed);const lifecycle=(lifecycleEntry as SyncEntry|undefined)?.membership??o.membership;if(!lifecycle)throw new Error("membership not configured");return{ok:true,result:await lifecycle.apply(inst) as any};}const sync=syncEntry((c as any).space);if(sync&&'sealed' in sync)return sealedReply(sync.sealed);const verifier=sync?sync.delegation:o.delegation;if(!verifier)throw new Error("delegation not configured");await verifier.epochNotice((c as any).args?.signedNotice,(c as any).space);return{ok:true,result:{installed:true}};}catch(e){return{ok:false,error:{code:"PermissionDenied",message:e instanceof Error?e.message:String(e)}};}},handleText:async(t:string,conn:Connection,max?:number):Promise<string>=>{let c:any;try{c=JSON.parse(t);}catch{return dispatch.handleText(t,conn,max);}if(!notices.includes(c?.method))return dispatch.handleText(t,conn,max);if(Buffer.byteLength(t)>(max??256*1024))return JSON.stringify({ok:false,error:{code:"ResourceExhausted",message:"notice frame too large"}});return JSON.stringify(await noticeService!.handle(c,conn));}} : undefined;
	const proof = new ProvingService(noticeService??dispatch, { gateHostId: o.hostId, keys: o.keys, now: o.now });
	let chain: { handle(c: unknown, conn: Connection): Promise<Reply>; handleText(t: string, conn: Connection, bytes?: number): Promise<string> } = proof;
	let stopSupervisor: (() => Promise<void>) | undefined;
    let supervisor: Supervisor | undefined;
	let stopMaintenance: (() => Promise<void>) | undefined;
	const syncStops = new Map<string, () => Promise<void>>();
	let gate: Awaited<ReturnType<typeof startGate>> | undefined;
	try {
		if (o.control) {
			const access = new ControlAccess(proof, { identity, host: o.control.host, ctx });
			const enrollment = new EnrollmentService(access, { host: o.control.host, ctx, now: o.now, keys: o.keys });
			const inner = new RotationService(enrollment, { host: o.control.host, ctx, keys: o.keys, identity, verifier: o.verifier, now: o.now }), authority = o.control.authority;
			chain = {
				async handle(c, conn) {
					if ((c as any)?.method === "keyLookup") {
						const id = await identity.authenticate(conn), state = conn.state as import("./auth.ts").AuthState | undefined;
						const key = state?.proof && conn.peerId ? await o.keys.find(conn.peerId, state.proof.keyId) : undefined;
						if (!key || key.state !== "active" || !id?.roles.some(r => ["host", "admin", "router"].includes(r))) return { ok: false, error: { code: !state?.proof ? "ProofRequired" : "PermissionDenied", message: "key lookup requires a currently proven service host or admin" } };
						const a = (c as any).args;
						if (typeof a?.peerId !== "string" || typeof a?.keyId !== "string") return { ok: false, error: { code: "BadRequest", message: "peerId and keyId required" } };
						return { ok: true, result: await o.keys.find(a.peerId, a.keyId) as any };
					}
                    if((c as any)?.method==="workerAssignments") {
                     // Only the own share, for the host proven on this connection; the request carries no host.
                     try{const id=await identity.authenticate(conn),proof=(conn.state as any)?.proof,key=proof&&conn.peerId?await o.keys.find(conn.peerId,proof.keyId):null;
                      if(!id||!proof||!key||key.state!=="active"||!key.roles.includes("host")||!id.roles.includes("host")||!o.control!.workers)throw Error("worker assignments require a currently proven host");
                      const list=await o.control!.workers.forHost(id.principal.peerId);const current=await o.keys.find(id.principal.peerId,proof.keyId);if(!current||current.state!=="active"||!current.roles.includes("host"))throw Error("host key no longer authorized");return{ok:true,result:list as any};
                     }catch(e){return{ok:false,error:{code:"PermissionDenied",message:e instanceof Error?e.message:String(e)}};}
                    }
                    if((c as any)?.method==="replicaNotice") {
                     // v3 5.3.1 step 5: a proven primary host leaves its own signed notice for the router to adopt.
                     try{const id=await identity.authenticate(conn),proof=(conn.state as any)?.proof,key=proof&&conn.peerId?await o.keys.find(conn.peerId,proof.keyId):null;
                      if(!id||!proof||!key||key.state!=="active"||!key.roles.includes("host")||!id.roles.includes("host")||!o.control!.replicaNotices)throw Error("replica notices require a currently proven host");
                      const auth=o.verifier.check((c as any).frame?.grant,id,{method:"write",space:"control"},conn);auth.check();
                      if(!auth.roles.includes("host"))throw Error("notice grant does not authorize host publication");
                      const r=await o.control!.replicaNotices.publish((c as any).args?.notice,{peerId:id.principal.peerId,roles:auth.roles,key:{algorithm:key.algorithm,publicKey:key.publicKey},check:async()=>{auth.check();const current=await o.keys.find(id.principal.peerId,proof.keyId);if(!current||current.state!=="active"||!current.roles.includes("host"))throw Error("host key no longer authorized");}});return{ok:true,result:r as any};
                     }catch(e){return{ok:false,error:{code:"PermissionDenied",message:e instanceof Error?e.message:String(e)}};}
                    }
                    if((c as any)?.method==="capabilityHeartbeat") {
                     try{const id=await identity.authenticate(conn),proof=(conn.state as any)?.proof,key=proof&&conn.peerId?await o.keys.find(conn.peerId,proof.keyId):null;
                      if(!id||!proof||!key||key.state!=="active"||!key.roles.includes("host")||!id.roles.includes("host")||!o.control!.directory)throw Error("capability requires a currently proven host");
                      const auth=o.verifier.check((c as any).frame?.grant,id,{method:"write",space:"control"},conn);auth.check();
                      if(!auth.roles.includes("host"))throw Error("capability grant does not authorize host publication");
                      const lease=await o.control!.directory.heartbeat((c as any).args?.report,{peerId:id.principal.peerId,roles:auth.roles,check:async()=>{auth.check();const current=await o.keys.find(id.principal.peerId,proof.keyId);if(!current||current.state!=="active"||!current.roles.includes("host"))throw Error("host key no longer authorized");}});return{ok:true,result:lease as any};
                     }catch(e){return{ok:false,error:{code:"PermissionDenied",message:e instanceof Error?e.message:String(e)}};}
                    }
					if((c as any)?.method==="routingPolicy") {
					 try{const id=await identity.authenticate(conn),proof=(conn.state as any)?.proof,key=proof&&conn.peerId?await o.keys.find(conn.peerId,proof.keyId):null;if(!key||key.state!=="active"||!id?.roles.some(r=>["host","router","admin"].includes(r))||!o.control!.routing)throw new Error("policy requires proven service peer");o.verifier.check((c as any).frame?.grant,id,{method:"hello",space:"control"},conn).check();return{ok:true,result:await o.control!.routing.signed() as any};}catch(e){return{ok:false,error:{code:"PermissionDenied",message:e instanceof Error?e.message:String(e)}};}
					}

					if((c as any)?.method==="routerLease") {
					 try { const id=await identity.authenticate(conn),proof=(conn.state as any)?.proof;if(!id||!proof||!id.roles.includes("router")||!o.control!.leases)throw new Error("lease requires proven router and configured control authority");o.verifier.check((c as any).frame?.grant,id,{method:"generation",space:"control"},conn).check();return{ok:true,result:await o.control!.leases.issue(id.principal.peerId,proof.keyId,(c as any).args?.renew) as any}; } catch(e){return{ok:false,error:{code:"PermissionDenied",message:e instanceof Error?e.message:String(e)}};}
					}

					if ((c as { method?: string } | null)?.method === "grant") {
						try { return { ok: true, result: await authority.issue(conn, (c as any).args?.purpose ?? "effect",(c as any).args?.agentId) as any }; }
						catch (e) { return { ok: false, error: { code: !(conn.state as any)?.proof && (conn.credentials as any)?.roles?.some((r: string) => ["admin", "host"].includes(r)) ? "ProofRequired" : "PermissionDenied", message: e instanceof Error ? e.message : String(e) } }; }
					}
					return inner.handle(c, conn);
				},
				async handleText(t, conn, bytes) {
					let c: unknown; try { c = JSON.parse(t); } catch { return inner.handleText(t, conn, bytes); }
					if (["grant", "keyLookup", "routerLease", "routingPolicy", "capabilityHeartbeat", "replicaNotice", "workerAssignments"].includes((c as any)?.method)) { if (Buffer.byteLength(t) > (bytes ?? 256 * 1024)) return JSON.stringify({ ok: false, error: { code: "ResourceExhausted", message: "grant request exceeds frame budget" } }); return JSON.stringify(await this.handle(c, conn)); }
					return inner.handleText(t, conn, bytes);
				},
			};
            const asyncCommands:NonNullable<import("./supervisor.ts").SupervisorOptions["asyncCommands"]>={};
            if(o.control.dataAdmin) for(const kind of ["purgeTasks","deletePrincipal"] as const) {
                asyncCommands[kind]=(id,args,admin)=>o.control!.dataAdmin!.execute(id,kind,String(args.spaceId??""),admin,(kind==="purgeTasks"?args.template:args.principal) as any) as any;
            }
            const administer=<T>(peerId:string,run:()=>Promise<T>)=>o.control!.withAdmin?o.control!.withAdmin(peerId,run):run();
            if(o.control.profiles)asyncCommands.migrateProfiles=async(id,args,admin)=>administer(admin,()=>o.control!.profiles!.execute(id,args.policy as any)) as any;
            if(o.control.membership) for(const kind of ["addMember","drain","removeMember"] as const) {
                asyncCommands[kind]=async(id,args,admin)=>{
                    const r=await administer(admin,()=>o.control!.membership!.execute(id,kind==="addMember"?"add":kind==="drain"?"drain":"remove",args.member as any,args.newDefault as any));
                    return {phase:r.phase,memberId:r.member.id,...(r.error?{error:r.error}:{}),...(r.policy?{policyVersion:r.policy.policyVersion}:{})};
                };
            }
            if(o.control.runs)Object.assign(asyncCommands,runCommands(o.control.runs));
            if(o.control.workers){const ch=o.control.host;Object.assign(asyncCommands,workerCommands(o.control.workers,async()=>{const id=(await listSpaces(ch,ctx)).find(i=>i.alias===CONTROL_SPACE)?.spaceId;const s=id?await snapshotSpace(ch,id,ctx):undefined;return s?appliedWorkers(s,(o.now??Date.now)()):{};}));}
            if(o.control.spaces)Object.assign(asyncCommands,o.control.spaces);
            if(o.control.deployment)Object.assign(asyncCommands,deploymentCommands(o.control.deployment));
            {const ch=o.control.host,runs=o.control.runs,workers=o.control.workers,controlId=async()=>(await listSpaces(ch,ctx)).find(i=>i.alias===CONTROL_SPACE)?.spaceId??"";
             // Read-only admin views: alerts derived from runs, workers and host reports, and the command audit.
             asyncCommands.listAlerts=async()=>await collectAlerts({runs,workers,host:ch,ctx,controlSpaceId:await controlId(),now:o.now}) as any;
             asyncCommands.auditLog=async(_id,a)=>await auditLog(ch,ctx,await controlId(),{limit:Number(a.limit??100),now:o.now}) as any;}
            supervisor = new Supervisor(o.control.host, ctx, {
                now:o.now,...(Object.keys(asyncCommands).length?{asyncCommands}:{}),
                ...(o.control.routing?{commands:{setPolicy:async(tx,args)=>{
                    const p=await o.control!.routing!.applyIn(tx,args.policy as any,Number(args.expectedVersion));return {policyVersion:p.policyVersion};
                }}}:{})
            });
		}
		const mainService = await startService(host, ctx, { now: o.now });
		stopMaintenance = async () => { for (const stop of [...syncStops.values()]) await stop(); syncStops.clear(); await mainService(); };
		// Reaper and delivery of every served primary/sync Space run on its own Harness.
		for (const sp of o.syncSpaces ?? []) {
			try { syncStops.set(sp.spaceId, await startService(sp.host, ctx, { now: o.now, space: sp.alias })); }
			catch (e) { syncServices.delete(sp.spaceId); syncServices.delete(sp.alias); console.error(`primary/sync Space ${sp.alias} stays unserved:`, e instanceof Error ? e.message : String(e)); }
		}
		gate = await startGate(chain, { ...o, keys: o.keys });
        // Recovered remote jobs may need this Control endpoint for fresh Member key lookup.
        // All proof, grant, Control access and boot guards are installed before listening.
        if(supervisor)stopSupervisor=await supervisor.start();
        // Transitions waiting for Member ACKs continue server side, also when no client is connected.
        if(o.control?.runs){const runs=o.control.runs;let busy=false;const timer=setInterval(()=>{if(busy)return;busy=true;void (async()=>{try{for(const id of await runs.pending())await runs.advance(id).catch(()=>{});}finally{busy=false;}})();},o.control.runAdvanceMs??1000);timer.unref?.();const prior=stopSupervisor;stopSupervisor=async()=>{clearInterval(timer);await prior?.();};}
		let closed = false;
		/**
		 * Swaps a primary/sync Space while running: unresolved after a sealed commit (its reaper stops, calls get
		 * `CommitSealed`), or served again over the reopened Harness with a new service and reaper.
		 */
		const setSyncSpace = async (next: SyncEntry | UnresolvedSyncSpace) => {
			const i = syncEntries.findIndex(sp => sp.spaceId === next.spaceId);
			if (i < 0 || syncEntries[i]!.alias !== next.alias) throw new Error(`primary/sync Space ${next.alias} is not provisioned on this host`);
			const stop = syncStops.get(next.spaceId); syncStops.delete(next.spaceId);
			if ("sealed" in next) { const svc = sealedService(next); syncServices.set(next.spaceId, svc); syncServices.set(next.alias, svc); syncEntries[i] = next; await stop?.(); return; }
			await stop?.();
			const svc = makeSyncService(next);
			// Without its reaper the Space is still served; every regular operation settles expiries itself.
			try { syncStops.set(next.spaceId, await startService(next.host, ctx, { now: o.now, space: next.alias })); }
			catch (e) { console.error(`primary/sync Space ${next.alias} is served without its reaper:`, e instanceof Error ? e.message : String(e)); }
			syncServices.set(next.spaceId, svc); syncServices.set(next.alias, svc); syncEntries[i] = next;
		};
		return { ...gate, service: chain, setSyncSpace, close: async () => { if (closed) return; closed = true; try { await gate!.close(); await stopSupervisor?.(); await stopMaintenance?.(); } finally { stopBoot?.(); } } };
	} catch (e) { try { await gate?.close(); await stopSupervisor?.(); await stopMaintenance?.(); } finally { stopBoot?.(); } throw e; }
}
