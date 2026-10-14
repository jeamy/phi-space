import type {ProfileTransitionController} from './profile-transition.ts';
import type {DataAdminController} from "./data-admin.ts";
import type {CapabilityDirectory} from "./capability-directory.ts";
import type {MemberLifecycle,MembershipController} from "./membership.ts";
// One composition root for the persistent host: gate -> enrollment -> control rules -> proof -> space.
// The control primary is supplied explicitly; members never mint grants from a local key/cache snapshot.
import type {FederationPolicyAuthority} from "./federation-policy.ts";
import type {DelegationVerifier,RouterLeaseAuthority} from "./delegation.ts";
import { RotationService } from "./rotation.ts";
import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { SpaceService, type Call, type Reply, type Connection } from "./service.ts";
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

export type FederationHostOptions = Omit<GateOptions, "keys"> & {
	hostId: string; authorityId: string; keys: KeyDirectory; verifier: GrantVerifier;
	boot?: { external: RecoveryRegister; installed: RecoveryRegister };
	/** Explicit fixture mode. Never set in a deployed host. */
	unsafeSkipBootGuardForTests?: true;
	/** Only the control runtime supplies these. An injected control Host must be authoritative, never a restored replica. */
	delegation?: DelegationVerifier;
	membership?: MemberLifecycle;
	refreshPolicy?:()=>Promise<void>;
	control?: { host: SpaceHost; authority: GrantAuthority; leases?: RouterLeaseAuthority; routing?: FederationPolicyAuthority; directory?: CapabilityDirectory; dataAdmin?:DataAdminController; membership?: MembershipController; profiles?:ProfileTransitionController; withAdmin?:<T>(peerId:string,run:()=>Promise<T>)=>Promise<T> };
};
export async function startFederationHost(host: Harness, ctx: Context, o: FederationHostOptions) {
	if (o.control && o.control.host !== host) throw new Error("the authoritative control runtime must use its own harness");
	if (!o.boot && !o.unsafeSkipBootGuardForTests) throw new Error("a federation host requires independent boot authorization and local installation");
	const stopBoot = o.boot ? installBootGuard(host, ctx, { ...o.boot, hostId: o.hostId, authorityId: o.authorityId }) : undefined;
	const identity = new GateIdentity();
	const service = new SpaceService({ host, ctx, identity, hostId: o.hostId, authorityId: o.authorityId, now: o.now,
		epochForSpace: async space => { const info = (await listSpaces(host, ctx)).find(i => i.spaceId === space || i.alias === (space ?? "default")); return info ? (await snapshotSpace(host, info.spaceId, ctx))?.primaryEpoch ?? 1 : 0; },
		authorize: async (call,id,conn)=>{const auth=call.frame?.delegation?o.delegation?await o.delegation.check(call,id,conn):await Promise.reject(new Error("delegation not configured")):o.verifier.check(call.frame?.grant,id,call,conn);await o.refreshPolicy?.();auth.check();return auth;} });
	const noticeService = o.delegation || o.membership ? {handle:async(c:unknown,conn:Connection):Promise<Reply>=>{ if(!["epochNotice","membershipInstruction"].includes((c as any)?.method))return service.handle(c,conn);try{const id=await identity.authenticate(conn);if(!(conn.state as any)?.proof||!id?.roles.some(r=>["router","host","admin"].includes(r)))throw new Error("epoch notice requires proven service peer");if((c as any).method==="membershipInstruction"){if(!o.membership)throw new Error("membership not configured");return{ok:true,result:await o.membership.apply((c as any).args?.instruction) as any};}if(!o.delegation)throw new Error("delegation not configured");await o.delegation.epochNotice((c as any).args?.signedNotice,(c as any).space);return{ok:true,result:{installed:true}};}catch(e){return{ok:false,error:{code:"PermissionDenied",message:e instanceof Error?e.message:String(e)}};}},handleText:async(t:string,conn:Connection,max?:number):Promise<string>=>{let c:any;try{c=JSON.parse(t);}catch{return service.handleText(t,conn,max);}if(!["epochNotice","membershipInstruction"].includes(c?.method))return service.handleText(t,conn,max);if(Buffer.byteLength(t)>(max??256*1024))return JSON.stringify({ok:false,error:{code:"ResourceExhausted",message:"notice frame too large"}});return JSON.stringify(await noticeService!.handle(c,conn));}} : undefined;
	const proof = new ProvingService(noticeService??service, { gateHostId: o.hostId, keys: o.keys, now: o.now });
	let chain: { handle(c: unknown, conn: Connection): Promise<Reply>; handleText(t: string, conn: Connection, bytes?: number): Promise<string> } = proof;
	let stopSupervisor: (() => Promise<void>) | undefined;
	let stopMaintenance: (() => Promise<void>) | undefined;
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
					if (["grant", "keyLookup", "routerLease", "routingPolicy", "capabilityHeartbeat"].includes((c as any)?.method)) { if (Buffer.byteLength(t) > (bytes ?? 256 * 1024)) return JSON.stringify({ ok: false, error: { code: "ResourceExhausted", message: "grant request exceeds frame budget" } }); return JSON.stringify(await this.handle(c, conn)); }
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
            stopSupervisor = await new Supervisor(o.control.host, ctx, {
                now:o.now,...(Object.keys(asyncCommands).length?{asyncCommands}:{}),
                ...(o.control.routing?{commands:{setPolicy:async(tx,args)=>{
                    const p=await o.control!.routing!.applyIn(tx,args.policy as any,Number(args.expectedVersion));return {policyVersion:p.policyVersion};
                }}}:{})
            }).start();
		}
		stopMaintenance = await startService(host, ctx, { now: o.now });
		gate = await startGate(chain, { ...o, keys: o.keys });
		let closed = false;
		return { ...gate, service: chain, close: async () => { if (closed) return; closed = true; try { await gate!.close(); await stopSupervisor?.(); await stopMaintenance?.(); } finally { stopBoot?.(); } } };
	} catch (e) { try { await gate?.close(); await stopSupervisor?.(); await stopMaintenance?.(); } finally { stopBoot?.(); } throw e; }
}
