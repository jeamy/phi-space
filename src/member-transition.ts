// Single-mode member installation: stopped normal runtime, blocked admission, bounded local reconciliation and outside-snapshot ACK.
import type { Session } from "@earendil-works/pi-durable";
import type { Context } from "./context.ts";
import type { RecoveryRegister } from "./recovery-register.ts";
import { canonicalJson, digestJson } from "./canonical.ts";
import { RecoveryBlocked, verifyAuthorityTransition, installAuthorityTransition, type SignedAuthorityTransition } from "./recovery.ts";
import type { Algorithm } from "./auth.ts";
import type { HostBootState, SpaceBootPermit } from "./boot.ts";
import { listSpaces, spaceDoc, snapshotSpace } from "./spaces.ts";
import * as core from "./core.ts";
export type MemberAuthorityAck = { hostId: string; recoveryId: string; authorityId: string; bootDigest: string; spaces: Record<string,{ incarnation: string; primaryEpoch: number }> };
export type MemberTransitionOptions = { host: Pick<Session,"commit" | "snapshot">; ctx: Context; hostId: string; external: RecoveryRegister; installed: RecoveryRegister; pinned: { algorithm: Algorithm; publicKey: string }; assertQuiesced: () => Promise<{ hostId: string; normalStopped: boolean; restartLocked: boolean }>; now?: () => number };
const digest = digestJson;
export class MemberTransitionInstaller {
 private o: MemberTransitionOptions;
 constructor(o: MemberTransitionOptions) { this.o = o; }
 async advance(proof: SignedAuthorityTransition): Promise<{ completed: boolean; ack?: MemberAuthorityAck }> {
  const o=this.o, t=await verifyAuthorityTransition(o.external,proof,o.pinned), quiesced=await o.assertQuiesced();
  if (quiesced.hostId !== o.hostId || !quiesced.normalStopped || !quiesced.restartLocked) throw new RecoveryBlocked("member normal runtime must be stopped with a persistent restart lock");
  const key=`boot:${o.hostId}`; let boot=await o.external.get<any>(key);
  if (!boot || boot.value.hostId !== o.hostId) throw new RecoveryBlocked("member boot authorization is absent");
  const infos=await listSpaces(o.host,o.ctx);
  if (infos.length !== Object.keys(boot.value.spaces).length || infos.some(i => !boot!.value.spaces[i.spaceId])) throw new RecoveryBlocked("member registry and independent boot space set disagree");
  for (const permit of Object.values(boot.value.spaces) as SpaceBootPermit[]) if (permit.durability === "sync" || !["local","primary"].includes(permit.role) || ![t.expectedAuthorityId,t.newAuthorityId].includes(permit.authorityId)) throw new RecoveryBlocked("single-mode transition cannot reconcile replicas or another authority");
  const priorAck=await o.installed.get<any>(`member-ack:${t.recoveryId}:${o.hostId}`);
  if (priorAck) {
   if (boot.value.state !== "active" || priorAck.value.bootDigest !== digest(boot.value)) throw new RecoveryBlocked("installed ACK no longer matches the external member boot configuration");
   for (const i of infos) { const local=await o.installed.get<any>(`installed:${o.hostId}:${i.spaceId}`), s=await snapshotSpace(o.host,i.spaceId,o.ctx); if (canonicalJson(local?.value ?? null) !== canonicalJson(boot.value.spaces[i.spaceId]) || s?.acceptedAuthorityId !== t.newAuthorityId || s.primaryEpoch !== 1 || s.incarnation !== boot.value.spaces[i.spaceId].dataIncarnation) throw new RecoveryBlocked("member local configuration disagrees with persisted ACK"); }
   await this.publishAck(priorAck.value);
   return { completed:true,ack:priorAck.value };
  }
  if (boot.value.state !== "quarantine") { boot=await o.external.compareAndSet(key,boot.version,{...boot.value,state:"quarantine",spaces:Object.fromEntries(Object.entries(boot.value.spaces).map(([id,p]) => [id,{...(p as any),state:"revoked"}]))}); }
  for (const info of infos) {
   const state=await snapshotSpace(o.host,info.spaceId,o.ctx), permit=boot.value.spaces[info.spaceId];
   if (!state || state.incarnation !== permit.dataIncarnation || state.authorityTransition && state.authorityTransition.stage !== "completed" && (state.authorityTransition.recoveryId !== t.recoveryId || state.authorityTransition.authorityId !== t.newAuthorityId)) throw new RecoveryBlocked("member space state or transition changed");
   if (state.authorityTransition?.stage === "completed" && state.authorityTransition.recoveryId === t.recoveryId && state.acceptedAuthorityId === t.newAuthorityId) continue;
   const now=(o.now??Date.now)();
   await o.host.commit(async tx => {
    const s=await spaceDoc(tx,info.spaceId,now);
    if (!core.maintenanceStep(s,512,now,"member-authority-transition")) throw new core.ResourceExhausted("member transition metadata exceeds commit budget");
    if (!s.authorityTransition || s.authorityTransition.recoveryId !== t.recoveryId) { s.authorityTransition={recoveryId:t.recoveryId,authorityId:t.newAuthorityId,stage:"clearing"}; s.waiters=[];s.regs=[];s.outbox=[];s.jobs=[];s.releaseQueue=[];s.mailboxes={boxes:{}};core.touch(s,now); }
    const step=s.authorityTransition;
    if (step.stage === "clearing") {
     const txn=Object.values(s.txns)[0];
     if (txn) { if ((txn as any).sealed || (txn as any).prepared) throw new RecoveryBlocked("sealed replica candidates require their separate reconciliation protocol"); core.abortTxn(s,now,txn.id,txn.owner??undefined); return; }
     step.stage="history";
    }
    if (step.stage === "history") {
     const pending=Object.entries(s.rpc?.claims??{}).find(([,c])=>c.state==="pending");
     if (pending) { const [id,c]=pending,copy=core.plain(c);delete copy.reservedResultBytes;const bytes=Buffer.byteLength(JSON.stringify(copy))+Buffer.byteLength(JSON.stringify(id))+256;if (core.overheadBytes(s)+bytes+s.entries.reduce((n,e)=>n+(e.size??Buffer.byteLength(JSON.stringify(e.fields))),0)>core.limitsOf(s).maxDocBytes || !core.maintenanceStep(s,bytes,now,"member-pending-history")) throw new core.ResourceExhausted("pending history cannot fit the transition budget");
      s.restoredClaims??={};s.restoredClaims[id]=copy;delete s.rpc!.claims[id];s.rpc!.bytes=Math.max(0,(s.rpc!.bytes??0)-Buffer.byteLength(JSON.stringify(c))-Buffer.byteLength(JSON.stringify(id))-2);s.rpc!.reservedBytes=Math.max(0,(s.rpc!.reservedBytes??0)-(c.reservedResultBytes??0));core.touch(s,now);return;
     }
     const decided=Object.values(s.rpc?.claims??{}).find(c=>c.state!=="pending"&&!c.orphanedAfterRestore);
     if(decided){const before=Buffer.byteLength(JSON.stringify(decided)),mark={recoveryId:t.recoveryId,authorityId:t.newAuthorityId},bytes=Buffer.byteLength(JSON.stringify(mark))+128;if(core.claimBytes(s)+bytes>core.limitsOf(s).maxClaimBytes||core.overheadBytes(s)+bytes+s.entries.reduce((n,e)=>n+(e.size??Buffer.byteLength(JSON.stringify(e.fields))),0)>core.limitsOf(s).maxDocBytes||!core.maintenanceStep(s,bytes,now,"member-orphaned-claim"))throw new core.ResourceExhausted("orphan audit exceeds current limits");decided.orphanedAfterRestore=mark;s.rpc!.bytes=(s.rpc!.bytes??0)+Buffer.byteLength(JSON.stringify(decided))-before;core.touch(s,now);return;}
     const historical=Object.values(s.restoredClaims??{}).find(c=>c.state!=="pending"&&!c.orphanedAfterRestore);
     if(historical){const mark={recoveryId:t.recoveryId,authorityId:t.newAuthorityId},bytes=Buffer.byteLength(JSON.stringify(mark))+128;if(core.claimBytes(s)+bytes>core.limitsOf(s).maxClaimBytes||core.overheadBytes(s)+bytes+s.entries.reduce((n,e)=>n+(e.size??Buffer.byteLength(JSON.stringify(e.fields))),0)>core.limitsOf(s).maxDocBytes||!core.maintenanceStep(s,bytes,now,"member-historical-orphan"))throw new core.ResourceExhausted("historical orphan audit exceeds current limits");historical.orphanedAfterRestore=mark;core.touch(s,now);return;}
     step.stage="generations";
    }
    if (step.stage === "generations") {
     const old=Object.keys(s.rpc?.generations??{}).find(id=>!s.invalidGenerations?.[id]);
     if (old) { const bytes=Buffer.byteLength(JSON.stringify(old))+64;if (core.claimBytes(s)+bytes>core.limitsOf(s).maxClaimBytes || core.overheadBytes(s)+bytes+s.entries.reduce((n,e)=>n+(e.size??Buffer.byteLength(JSON.stringify(e.fields))),0)>core.limitsOf(s).maxDocBytes || !core.maintenanceStep(s,bytes,now,"member-old-generation")) throw new core.ResourceExhausted("old generation cannot fit the transition budget");s.invalidGenerations??={};s.invalidGenerations[old]=true;core.touch(s,now);return; }
     if(s.rpc)s.rpc.authorityId=t.newAuthorityId;s.primaryEpoch=1;s.acceptedAuthorityId=t.newAuthorityId;step.stage="completed";core.touch(s,now);
    }
   },o.ctx);
   return {completed:false};
  }
  await installAuthorityTransition(o.installed,o.external,proof,o.pinned);
  const spaces:Record<string,SpaceBootPermit>={}, tuples:MemberAuthorityAck["spaces"]={};
  for(const i of infos){const s=(await snapshotSpace(o.host,i.spaceId,o.ctx))!;const permit={...boot.value.spaces[i.spaceId],state:"active",authorityId:t.newAuthorityId,dataIncarnation:s.incarnation!,primaryEpoch:1,transitionId:t.recoveryId,authorityMarker:true};spaces[i.spaceId]=permit;tuples[i.spaceId]={incarnation:s.incarnation!,primaryEpoch:1};const k=`installed:${o.hostId}:${i.spaceId}`,local=await o.installed.get<any>(k);if(canonicalJson(local?.value??null)!==canonicalJson(permit as any))await o.installed.compareAndSet(k,local?.version??null,permit as any);}
  const next:HostBootState={hostId:o.hostId,state:"active",spaces};
  if(canonicalJson(boot.value)!==canonicalJson(next as any))await o.external.compareAndSet(key,boot.version,next as any);
  const ack:MemberAuthorityAck={hostId:o.hostId,recoveryId:t.recoveryId,authorityId:t.newAuthorityId,bootDigest:digest(next),spaces:tuples};
  const localKey=`member-ack:${t.recoveryId}:${o.hostId}`,local=await o.installed.get<any>(localKey);if(local&&canonicalJson(local.value)!==canonicalJson(ack as any))throw new RecoveryBlocked("member ACK conflicts with local installation");if(!local)await o.installed.compareAndSet(localKey,null,ack as any);
  await this.publishAck(ack);
  return {completed:true,ack};
 }
 private async publishAck(ack: MemberAuthorityAck): Promise<void> {
  const key = `authority-ack:${ack.recoveryId}:${this.o.hostId}`, known = await this.o.external.get<any>(key);
  if (known && canonicalJson(known.value) !== canonicalJson(ack as any)) throw new RecoveryBlocked("member ACK conflicts with independent register");
  if (!known) await this.o.external.compareAndSet(key, null, ack as any);
 }
}
