import {checkErasureBarrier,validateErasureBarrier} from './erasure-barrier.ts';
import {readRegisterRecords,type RegisterRecord} from './recovery-register.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import {hasAdminKey,SpaceKeyDirectory} from './enroll.ts';
// Native hosted-agent Root, co-located with its authoritative Control store.
import {existsSync,writeFileSync,renameSync} from 'node:fs';
import type {Context} from '@earendil-works/chord';
import type {SpaceHost} from './client.ts';
import type {KeyDirectory,Signer} from './auth.ts';
import type {RecoveryRegister} from './recovery-register.ts';
import type {PeerDirectory,GroupRoles} from './gate.ts';
import {loadFileSigner,privateFile} from './keys.ts';
import {canonicalJson} from './canonical.ts';
import {snapshotSpace,NamedSpace} from './spaces.ts';
import {BootBlocked} from './boot.ts';
import {GrantAuthority} from './grants.ts';
import {RouterLeaseAuthority,type SignedRouterLease,signDelegation,delegationForCall} from './delegation.ts';
import {FederationJournalLayout} from './federation-journals.ts';
import {createFederationController} from './federation-controller.ts';
import {RemoteSpace} from './remote.ts';
import {socketTransport} from './socket.ts';
import {FederationRouting} from './federation-policy.ts';
import {ReplicaNoticeBoard,adoptReplicaConfigNotice} from './replica-notice.ts';
import type {TargetBinding} from './router.ts';
import type {Principal} from './claims.ts';
export type RootConfig={id:string;keyFile:string;hostKeyFile:string;adminPeer?:{peerId:string;address:string};leaseFile:string;journalPartitions:number;allowMembershipCommands?:boolean;statusIntervalMs?:number;members:Record<string,{target:TargetBinding;peerId:string;keyId:string;algorithm:Signer['algorithm'];publicKey:string;address:{host:string;port:number};
 /** primary/sync Members: every other replica host that an adopted ReplicaConfigNotice may name as primary */
 replicas?:Record<string,{peerId:string;keyId:string;algorithm:Signer['algorithm'];publicKey:string;address:{host:string;port:number}}>}>;};
type Endpoint={peerId:string;keyId:string;algorithm:Signer['algorithm'];publicKey:string;address:{host:string;port:number}};
const endpointOf=(m:RootConfig['members'][string],hostId:string):Endpoint|undefined=>hostId===m.target.hostId?m:m.replicas?.[hostId];
/** A persisted target is provisioned if it is the provisioned one, or (replicated Members) the same Space on a provisioned replica host. */
const provisionedTarget=(m:RootConfig['members'][string]|undefined,t:TargetBinding)=>!!m&&(canonicalJson(m.target as any)===canonicalJson(t as any)||!!m.replicas&&!!endpointOf(m,t.hostId)&&t.spaceId===m.target.spaceId&&t.authorityId===m.target.authorityId);
export async function createConfiguredRoot(o:{host:SpaceHost;ctx:Context;hostId:string;peerId:string;authorityId:string;controlSpaceId:string;controlSigner:Signer;keys:KeyDirectory;directory:PeerDirectory;ownAddress:string;groupRoles:GroupRoles;external:RecoveryRegister;installed:RecoveryRegister;grants:GrantAuthority;leases:RouterLeaseAuthority;root:RootConfig;assertControl:()=>Promise<void>;controlEpoch?:()=>number;checkControlAuthority?:(record:RegisterRecord|null)=>void}){
 const cfg=o.root;if(!o.controlSigner.publicKey||!cfg.id||!cfg.keyFile||!cfg.hostKeyFile||!cfg.leaseFile||!cfg.members||Object.keys(cfg.members).length>32)throw new BootBlocked('incomplete native Root provisioning');
 const interval=cfg.statusIntervalMs??10000;if(!Number.isSafeInteger(interval)||interval<1000||interval>15000)throw new BootBlocked('Root status interval must be 1000..15000 ms');
 const signer=loadFileSigner(cfg.keyFile),hostSigner=loadFileSigner(cfg.hostKeyFile),sockets=new Map<string,ReturnType<typeof socketTransport>>();
 const controlState=()=>o.host.snapshot(NamedSpace,o.controlSpaceId,o.ctx);
 const assertRoot=async()=>{
  const requests=[{peerId:o.peerId,keyId:signer.keyId},{peerId:o.peerId,keyId:hostSigner.keyId}],readControl=async()=>o.keys instanceof SpaceKeyDirectory?o.keys.inspect(requests):{state:await controlState(),keys:o.keys.findMany?await o.keys.findMany(requests):await Promise.all(requests.map(k=>o.keys.find(k.peerId,k.keyId)))};
  let b:any,view:Awaited<ReturnType<typeof readControl>>,local:any,records:Record<string,RegisterRecord|null>|undefined;
  if(o.checkControlAuthority){
   [view,local]=await Promise.all([readControl(),o.installed.get<any>('installed:'+o.hostId+':'+o.controlSpaceId)]);
   records=await readRegisterRecords(o.external,['erasure:'+o.controlSpaceId,'authority:'+o.controlSpaceId,'boot:'+o.hostId]);
   o.checkControlAuthority(records['authority:'+o.controlSpaceId]!);b=records['boot:'+o.hostId];
  }else{[,b,view,local]=await Promise.all([o.assertControl(),o.external.get<any>('boot:'+o.hostId),readControl(),o.installed.get<any>('installed:'+o.hostId+':'+o.controlSpaceId)]);}
  const s=view.state,permit=b?.value.spaces?.[o.controlSpaceId];
  if(b?.value.state!=='active'||b.value.hostId!==o.hostId||!s||s.spaceId!==o.controlSpaceId||!permit||permit.state!=='active'||permit.authorityId!==o.authorityId||permit.dataIncarnation!==s.incarnation||(permit.primaryEpoch??1)!==(o.controlEpoch?.()??s.primaryEpoch??1)||permit.authorityMarker&&s.acceptedAuthorityId!==o.authorityId||!['local','primary'].includes(permit.role)||!local||canonicalJson(local.value)!==canonicalJson(permit))throw new BootBlocked('Root lacks matching independent/local Control boot permission');
  if((permit.erasureEpoch??0)!==(s.erasureEpoch??0))throw new BootBlocked('Root deletion epoch disagrees with its permit');try{if(records)validateErasureBarrier(records['erasure:'+o.controlSpaceId]!,o.controlSpaceId,s,Date.now());else await checkErasureBarrier(o.external,o.controlSpaceId,s);}catch(e){throw new BootBlocked((e as Error).message);}
  const [k,hk]=view.keys;if(!k||k.state!=='active'||k.publicKey!==signer.publicKey||k.algorithm!==signer.algorithm||!k.roles.includes('router'))throw new BootBlocked('Root needs its active enrolled router key');
  if(!hk||hk.state!=='active'||hk.publicKey!==hostSigner.publicKey||hk.algorithm!==hostSigner.algorithm||!hk.roles.includes('host'))throw new BootBlocked('Root needs its separate active enrolled host key');
  const own=await o.directory.lookup(o.ownAddress);if(!own||own.id!==o.peerId)throw new BootBlocked('Root own overlay binding changed');
  await Promise.all(Object.values(cfg.members).flatMap(m=>[m,...Object.values(m.replicas??{})].map(async e=>{const peer=await o.directory.lookup(e.address.host);if(!peer||peer.id!==e.peerId||m.target.authorityId!==o.authorityId)throw new BootBlocked('Root Member overlay or authority pin disagrees');})));
  return {router:k,host:hk};
 };
 const adminContext=new AsyncLocalStorage<string>();
 const connection=async(keySigner:Signer=hostSigner)=>{
  const verified=await assertRoot(),k=keySigner.keyId===signer.keyId?verified.router:keySigner.keyId===hostSigner.keyId?verified.host:null,peer=await o.directory.lookup(o.ownAddress);if(!peer||peer.id!==o.peerId||!k||k.state!=='active'||k.publicKey!==keySigner.publicKey||k.algorithm!==keySigner.algorithm)throw new BootBlocked('Root local proven key or overlay binding changed');return {peerId:o.peerId,overlayIp:peer.ip,credentials:{roles:peer.groups.flatMap(g=>o.groupRoles[g]??[])},state:{proof:{keyId:k.keyId,principal:k.principal,roles:k.roles,scope:k.scope,at:Date.now()}}};
 };
 // The directory lookup of this host is explicitly supplied below, never inferred from a request body.
 const grant=async(p:Principal)=>{if(p.peerId!==o.peerId)throw new BootBlocked('native Root only grants its own hosted-agent namespace');return o.grants.issue(await connection(),'effect',p.agentId);};
 let current:SignedRouterLease|undefined;
 const retained=existsSync(cfg.leaseFile)?JSON.parse(privateFile(cfg.leaseFile).toString()):undefined;
 if(!retained&&await o.host.snapshot(FederationJournalLayout,cfg.id,o.ctx))throw new BootBlocked('existing Root journal has lost its lease record');
 const save=(t:SignedRouterLease)=>{writeFileSync(cfg.leaseFile+'.tmp',JSON.stringify(t)+'\n',{mode:0o600});renameSync(cfg.leaseFile+'.tmp',cfg.leaseFile);};
 const retainLease=async()=>{if(!current||Date.now()+45000>=current.lease.expiresAt){const prior=current??retained;current=await o.leases.issue(o.peerId,signer.keyId,prior?{id:prior.lease.id,routerEpoch:prior.lease.routerEpoch,token:prior}:undefined);if(prior&&(current.lease.id!==prior.lease.id||current.lease.routerEpoch!==prior.lease.routerEpoch))throw new BootBlocked('Root lease changed during reopen');save(current);}return current;};
 const lease=async()=>{await assertRoot();return retainLease();};
 // The endpoint follows the current routing target: after an adopted ReplicaConfigNotice calls go to the new primary.
 const socketFor=(id:string,hostId:string)=>{const m=cfg.members[id],e=m&&endpointOf(m,hostId);if(!e)throw new BootBlocked('Member endpoint is not provisioned');const key=id+'@'+hostId;let socket=sockets.get(key);if(!socket){socket=socketTransport(e.address);sockets.set(key,socket);}return socket;};
 const transport=(id:string)=>{if(!cfg.members[id])throw new BootBlocked('Member endpoint is not provisioned');return{request:async(text:string)=>{const st=await o.host.snapshot(FederationRouting,o.controlSpaceId,o.ctx),hostId=st?.members[id]?.target.hostId??cfg.members[id]!.target.hostId;return socketFor(id,hostId).request(text);}};};
 let timer:ReturnType<typeof setTimeout>|undefined,stopped=false,active:Promise<void>=Promise.resolve();
 try{
  await assertRoot();const controller=await createFederationController({...(o.controlEpoch?{controlEpoch:o.controlEpoch}:{}),host:o.host,ctx:o.ctx,id:cfg.id,journalPartitions:cfg.journalPartitions,controlSpaceId:o.controlSpaceId,authorityId:o.authorityId,routerPeerId:o.peerId,routerSigner:signer,controlPeerId:o.peerId,controlSigner:o.controlSigner,controlPublicKey:o.controlSigner.publicKey!,transport,lease,grant,assertAuthority:async()=>{await assertRoot();},authorizeLease:lease,authorizeAdmin:async()=>{await assertRoot();if(!cfg.allowMembershipCommands||!cfg.adminPeer||adminContext.getStore()!==cfg.adminPeer.peerId)throw new BootBlocked('native Root requires a provisioned Supervisor administrator context');await o.directory.refresh();const p=await o.directory.lookup(cfg.adminPeer.address),s=await snapshotSpace(o.host,o.controlSpaceId,o.ctx);if(!p||p.id!==cfg.adminPeer.peerId||!p.groups.some(g=>o.groupRoles[g]?.includes('admin'))||!s||!hasAdminKey(s,Date.now(),p.id))throw new BootBlocked('native Root administrator key or overlay role is inactive');},memberPin:async member=>{const m=cfg.members[member.id];if(!m||canonicalJson(m.target as any)!==canonicalJson(member.target as any))throw new BootBlocked('membership target is not provisioned');const k=await o.keys.find(m.peerId,m.keyId);if(!k||k.state!=='active'||k.algorithm!==m.algorithm||k.publicKey!==m.publicKey||!k.roles.includes('host'))throw new BootBlocked('Member key pin is not active');return{issuer:m.peerId,algorithm:m.algorithm,publicKey:m.publicKey};},probeStatus:async(id,target)=>{
   const state=await controller.policy.state(),m=cfg.members[id];if(!provisionedTarget(m,target))throw new BootBlocked('status target is not provisioned');const p={peerId:o.peerId,agentId:'root-status'};
   const remote=new RemoteSpace(transport(id),{space:target.spaceId,signer,expectedGateHostId:target.hostId,ownPeerId:o.peerId,attempts:1,grantProvider:async()=>await grant(p) as any,delegationProvider:async(call,g)=>await signDelegation(signer,delegationForCall({call,principal:p,lease:await lease(),policyVersion:state.policy!.policyVersion,spaceId:target.spaceId,primaryEpoch:target.primaryEpoch,grant:g as any,now:Date.now(),replicaConfigVersion:state.members[id]?.replication?.replicaConfigVersion})) as any});await remote.authenticate();const info:any=await remote.info();if(info.spaceId!==target.spaceId||info.hostId!==target.hostId||info.incarnation!==target.dataIncarnation||info.authorityId!==target.authorityId||info.primaryEpoch!==target.primaryEpoch)throw new BootBlocked('Member status target identity changed');return{revision:info.rev,free:null,lag:null};
  }});
  const state=await controller.policy.state();for(const m of Object.values(state.members))if(!provisionedTarget(cfg.members[m.id],m.target))throw new BootBlocked('persisted Member target differs from Root provisioning');
  // v3 5.3.1 step 5: adopt published ReplicaConfigNotices before probing; the register decides, the signer is pinned.
  const notices=new ReplicaNoticeBoard({host:o.host,ctx:o.ctx,controlSpaceId:o.controlSpaceId,assertAuthority:async()=>{await assertRoot();}});
  const issuerKey=async(hostId:string)=>{for(const m of Object.values(cfg.members)){const e=endpointOf(m,hostId);if(e)return{algorithm:e.algorithm,publicKey:e.publicKey};}return null;};
  const adoptNotices=async()=>{await assertRoot();const r=await notices.adoptAll(t=>adoptReplicaConfigNotice(o.host,o.ctx,{controlSpaceId:o.controlSpaceId,authorityId:o.authorityId,register:o.external,issuerKey},t));for(const x of r.refused)console.error('Root replica notice refused:',x);return r;};
  const heartbeat=()=>{active=adoptNotices().catch(e=>console.error('Root replica notices:',e instanceof Error?e.message:String(e))).then(()=>controller.directory!.refresh()).catch(e=>console.error('Root Member status:',e instanceof Error?e.message:String(e))).then(()=>{if(!stopped)timer=setTimeout(heartbeat,interval);});};heartbeat();
  return{...controller,adoptReplicaNotices:adoptNotices,withAdmin:<T>(peerId:string,run:()=>Promise<T>)=>adminContext.run(peerId,run),close:async()=>{stopped=true;if(timer)clearTimeout(timer);await active;for(const s of sockets.values())s.close();}};
 }catch(e){for(const s of sockets.values())s.close();throw e;}
}
