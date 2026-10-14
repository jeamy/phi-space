// Protected directory entries are published by proven hosts; routing status by the lease owner.
import type {Context} from '@earendil-works/chord';
import type {SpaceHost} from './client.ts';
import * as core from './core.ts';
import {spaceDoc} from './spaces.ts';
import {FederationRouting} from './federation-policy.ts';
import type {TargetBinding} from './router.ts';
import {canonicalJson} from './canonical.ts';

export const CAPABILITY_LEASE_MS=120000, CAPABILITY_HEARTBEAT_MS=60000, MEMBER_STATUS_LEASE_MS=30000;
export type CapabilityReport={hostId:string;resources:core.Fields;tools:string[];models:string[];metrics:core.Fields};
function validate(r:CapabilityReport) {
 if(!r || typeof r.hostId!=='string'||!r.hostId||r.hostId.length>128 || typeof r.resources!=="object" || typeof r.metrics!=="object" || !r.resources || !r.metrics || Array.isArray(r.resources)||Array.isArray(r.metrics) || !Array.isArray(r.tools)||!Array.isArray(r.models)||![...r.tools,...r.models].every(n=>typeof n==='string'&&n.length>0&&n.length<=128) || Buffer.byteLength(JSON.stringify(r))>16384) throw new core.IllegalArgumentError('invalid capability report');
}
function replace(s:core.SpaceState,now:number,type:string,key:string,value:string,fields:core.Fields,lease:number) {
 const old=core.list(s,now,{type,fields:{[key]:value}});
 // A bounded directory record must not become arbitrarily large through duplicate heartbeats.
 if(old.length>4) throw new core.ResourceExhausted('duplicate directory records');
 for(const e of old) core.probe(s,now,{type,id:e.id},null,true);
 return core.write(s,now,{type,fields},null,lease);
}
export class CapabilityDirectory {
 private o:{host:SpaceHost;ctx:Context;spaceId:string;hostForPeer?:(peerId:string)=>string|undefined;assertAuthority:()=>Promise<void>;now?:()=>number};
 constructor(o:CapabilityDirectory['o']){this.o=o;}
 /** peerId/roles MUST be supplied by the authenticated connection, never by the body. */
 async heartbeat(r:CapabilityReport,identity:{peerId:string;roles:readonly string[];check?:()=>void|Promise<void>}) {
  validate(r);if(!identity.roles.includes('host') || (this.o.hostForPeer?.(identity.peerId)??identity.peerId)!==r.hostId) throw new core.PermissionError('only the associated proven host publishes its capability');
  await identity.check?.();await this.o.assertAuthority();
  return this.o.host.commit(async tx=>{await identity.check?.();await this.o.assertAuthority();const now=(this.o.now??Date.now)();const s=await spaceDoc(tx,this.o.spaceId,now);return replace(s,now,'Capability','hostId',r.hostId,{...structuredClone(r),at:now},CAPABILITY_LEASE_MS);},this.o.ctx);
 }
}
export class MemberStatusDirectory {
 private o:{host:SpaceHost;ctx:Context;controlSpaceId:string;assertAuthority:()=>Promise<void>;now?:()=>number;probe:(memberId:string,target:Readonly<TargetBinding>)=>Promise<{revision:number;free:number|null;lag:number|null}>};
 constructor(o:MemberStatusDirectory['o']){this.o=o;}
 async refresh() {
  await this.o.assertAuthority();const st=await this.o.host.snapshot(FederationRouting,this.o.controlSpaceId,this.o.ctx);
  for(const m of Object.values(st?.members??{})) {
   if(!['active','draining'].includes(m.state))continue;
   const at=(this.o.now??Date.now)();let result:Awaited<ReturnType<MemberStatusDirectory['o']['probe']>>|undefined;
   try{result=await this.o.probe(m.id,structuredClone(m.target));if(!Number.isSafeInteger(result.revision)||result.revision<0||result.free!==null&&(!Number.isFinite(result.free)||result.free<0)||result.lag!==null&&(!Number.isFinite(result.lag)||result.lag<0))throw Error('invalid member status');}catch{result=undefined;}
   await this.o.assertAuthority();
   await this.o.host.commit(async tx=>{
    await this.o.assertAuthority();const now=(this.o.now??Date.now)();const current=(await tx.doc(FederationRouting,this.o.controlSpaceId,null)).members[m.id];
    if(!current||canonicalJson(current.target as any)!==canonicalJson(m.target as any)||!['active','draining'].includes(current.state))return;
    const s=await spaceDoc(tx,this.o.controlSpaceId,now);
    const caps=core.list(s,now,{type:'Capability',fields:{hostId:m.target.hostId}}).sort((a,b)=>Number(b.fields.at)-Number(a.fields.at))[0];
    const fresh=!!result&&now-at<MEMBER_STATUS_LEASE_MS;
    if(fresh&&result!.free!==null)current.capacity={free:result!.free,at};else delete current.capacity;
    if(fresh&&caps)current.capabilities={names:[...(caps.fields.tools as string[]),...(caps.fields.models as string[])],at:Number(caps.fields.at)};else delete current.capabilities;
    replace(s,now,'MemberStatus','memberId',m.id,{memberId:m.id,hostId:m.target.hostId,reachable:fresh,at,revision:fresh?result!.revision:null,lag:fresh?result!.lag:null,capacity:fresh?result!.free:null},MEMBER_STATUS_LEASE_MS);
   },this.o.ctx);
  }
 }
 start(intervalMs=15000,onError:(e:unknown)=>void=()=>{}) {
  let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;let active:Promise<void>=Promise.resolve();
  const run=()=>{active=this.refresh().catch(onError).then(()=>{if(!stopped)timer=setTimeout(run,intervalMs);});};run();
  return async()=>{stopped=true;if(timer)clearTimeout(timer);await active;};
 }
}
