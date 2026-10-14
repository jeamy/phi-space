// Durable, fail-closed profile replacement. Remote effects never run inside Control commits.
import type {Context} from '@earendil-works/chord';
import {createHash} from 'node:crypto';
import {canonicalJson} from './canonical.ts';
import type {SpaceHost} from './client.ts';
import {FederationRouting} from './federation-policy.ts';
import {FederationOperations} from './federated-space.ts';
import {parentJournalKey} from './federation-journals.ts';
import {MembershipJournal,signMembership,verifyMembership,type MembershipTransport,type MembershipInstruction} from './membership.ts';
import {validateProfileOnlyChange} from './profile-policy.ts';
import {validateFederationPolicy,RoutingConflict,type FederationPolicy,type FederationMember} from './routing-semantics.ts';
import type {Signer} from './auth.ts';
import {spaceDoc} from './spaces.ts';
import {ProfileTransitions,type Operation} from './profile-transition-doc.ts';
export {ProfileTransitions} from './profile-transition-doc.ts';
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
export class ProfileTransitionController{
 private o:{host:SpaceHost;ctx:Context;controlSpaceId:string;authorityId:string;federationId:string;journalPartitions:number;peerId:string;signer:Signer;transport:MembershipTransport;assertAuthority:()=>Promise<void>;authorize:()=>Promise<void>};
 constructor(o:ProfileTransitionController['o']){this.o=o;}
 private async check(){await this.o.authorize();await this.o.assertAuthority();}
 async start(id:string,next:FederationPolicy){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)||['constructor','prototype','__proto__'].includes(id))throw new RoutingConflict('invalid profile transition ID');await this.check();
  return this.o.host.commit(async tx=>{
   await this.check();const ledger=await tx.doc(ProfileTransitions,this.o.controlSpaceId,null),old=ledger.operations[id],h=hash(next);if(old){if(old.hash!==h)throw new RoutingConflict('profile transition ID changed policy');return copy(old);}
   if(Object.values(ledger.operations).some(op=>op.phase!=='completed')||Object.keys(ledger.operations).length>=32)throw new RoutingConflict('profile transition already active or history full');
   const state=await tx.doc(FederationRouting,this.o.controlSpaceId,null);if(!state.policy||state.policy.authorityId!==this.o.authorityId)throw new RoutingConflict('profile transition authority missing');validateProfileOnlyChange(state.policy,next);validateFederationPolicy({...next,policyVersion:1},state.members,null);validateFederationPolicy({...next,completionProfiles:state.policy.completionProfiles},state.members,state.policy);
   const members=Object.values(state.members);if(!members.length||members.some(m=>m.state!=='active'))throw new RoutingConflict('all Members must be active before profile transition');
   const membership=await tx.doc(MembershipJournal,this.o.controlSpaceId,null);if(Object.values(membership.operations).some(op=>!['completed','failed'].includes(op.phase)))throw new RoutingConflict('membership transition is pending');
   const parents:any[]=[];for(let n=0;n<this.o.journalPartitions;n++){const d=await tx.doc(FederationOperations,parentJournalKey(this.o.federationId,this.o.journalPartitions,n),null);parents.push(...Object.values(d.operations));}
   if(parents.some(p=>p.phase!=='done')||parents.some(p=>p.kind==='txn'&&(p.args as any)?.action==='begin'&&!parents.some(done=>done.kind==='txn'&&(done.args as any)?.originId===p.id&&['commit','abort'].includes((done.args as any)?.action))))throw new RoutingConflict('Root work must settle before profile transition');
   const op:Operation={hash:h,oldPolicy:copy(state.policy),nextPolicy:copy(next),members:copy(members),phase:'freezing',cursor:0};ledger.operations[id]=op;await this.check();return copy(op);
  },this.o.ctx);
 }
 async advance(id:string){
  await this.check();const current=(await this.o.host.snapshot(ProfileTransitions,this.o.controlSpaceId,this.o.ctx))?.operations[id];if(!current)throw new RoutingConflict('unknown profile transition');if(current.phase==='completed')return copy(current);
  if(current.phase==='publishing')return this.o.host.commit(async tx=>{
   await this.check();const d=await tx.doc(ProfileTransitions,this.o.controlSpaceId,null),op=d.operations[id]!,state=await tx.doc(FederationRouting,this.o.controlSpaceId,null);if(op.phase!=='publishing')return copy(op);
   if(hash(state.policy)!==hash(op.oldPolicy)||op.members.some(m=>hash(state.members[m.id]?.target)!==hash(m.target)))throw new RoutingConflict('profile transition policy or targets changed; remain frozen');
   state.policy=copy(op.nextPolicy);const control=await spaceDoc(tx,this.o.controlSpaceId,Date.now());control.authorityCounters??={routerEpoch:0,policyVersion:0};control.authorityCounters.policyVersion=op.nextPolicy.policyVersion;op.phase='resuming';op.cursor=0;await this.check();return copy(op);
  },this.o.ctx);
  const action:MembershipInstruction['action']=current.phase==='freezing'?'profileFreeze':current.phase==='installing'?'profileInstall':'profileResume',member=current.members[current.cursor]!;
  const instruction={id,authorityId:this.o.authorityId,memberId:member.id,spaceId:member.target.spaceId,action,policy:current.nextPolicy,previousPolicy:current.oldPolicy};
  const pin=await this.o.transport.pin(member);const proof=verifyMembership('proof',await this.o.transport.apply(member,await signMembership('instruction',instruction,this.o.peerId,this.o.signer)),pin);
  if(proof.id!==id||proof.authorityId!==this.o.authorityId||proof.memberId!==member.id||proof.spaceId!==member.target.spaceId||proof.action!==action||proof.state!==(action==='profileResume'?'active':'profileFrozen'))throw new RoutingConflict('profile transition proof binding mismatch');
  return this.o.host.commit(async tx=>{
   await this.check();const d=await tx.doc(ProfileTransitions,this.o.controlSpaceId,null),op=d.operations[id]!;if(op.hash!==current.hash)throw new RoutingConflict('profile transition changed');if(op.phase!==current.phase||op.cursor!==current.cursor)return copy(op);
   const state=await tx.doc(FederationRouting,this.o.controlSpaceId,null);if(op.members.some(m=>hash(state.members[m.id]?.target)!==hash(m.target)))throw new RoutingConflict('profile transition target changed; remain frozen');op.cursor++;
   if(op.cursor===op.members.length){op.cursor=0;op.phase=op.phase==='freezing'?'installing':op.phase==='installing'?'publishing':'completed';}await this.check();return copy(op);
  },this.o.ctx);
 }
 async execute(id:string,next:FederationPolicy){await this.start(id,next);for(;;){const op=await this.advance(id);if(op.phase==='completed')return op;}}
}
