// Recovery console composition. The caller holds exclusive harness ownership and starts neither agents nor a normal gate.
import type { Session } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { privateFile, loadFileSigner } from "./keys.ts";
import { TlsRecoveryRegister, type RegisterTlsClient } from "./tls-register.ts";
import { SshRecoveryRegister } from "./ssh-register.ts";
import { SqliteRecoveryRegister } from "./recovery-register.ts";
import { MemberTransitionInstaller } from "./member-transition.ts";
import { ControlRecoveryController, controlRecoveryHandler } from "./control-recovery.ts";
import { RecoveryBlocked } from "./recovery.ts";
import { serveRecovery } from "./recovery-service.ts";
import { verifySshFence } from "./fencing.ts";
import { basename, join } from "node:path";
export type RecoveryOnlyConfig = {hostId:string;path:string;installedRegisterFile:string;operatorKeyFile:string;supervisorKeyFile:string;snapshotDirectory:string;fenceTargets:Record<string,string>;registerTls?:RegisterTlsClient;registerSshTarget?:string};
export async function startRecoveryOnly(host:Pick<Session,"commit"|"snapshot">,ctx:Context,configFile:string,assertQuiesced:()=>Promise<{hostId:string;normalStopped:boolean;restartLocked:boolean}>){
 const c=JSON.parse(privateFile(configFile).toString()) as RecoveryOnlyConfig;
 if(!c.hostId||!c.path||!c.snapshotDirectory||!c.fenceTargets||!!c.registerTls===!!c.registerSshTarget)throw new RecoveryBlocked("incomplete recovery-only provisioning");
 const status=await assertQuiesced();if(status.hostId!==c.hostId||!status.normalStopped||!status.restartLocked)throw new RecoveryBlocked("exclusive stopped and restart-locked normal runtime is required");
 const operator=loadFileSigner(c.operatorKeyFile),supervisor=loadFileSigner(c.supervisorKeyFile),external=c.registerTls?new TlsRecoveryRegister(c.registerTls):new SshRecoveryRegister(c.registerSshTarget!,10000,{operator:true}),installed=new SqliteRecoveryRegister(c.installedRegisterFile);
 const options={host,ctx,hostId:c.hostId,external,installed,operator,supervisor,assertQuiesced,loadSnapshot:async(ref:string)=>{if(!ref||ref!==basename(ref)||ref.length>256||!/^[A-Za-z0-9_.-]+\.json$/.test(ref))throw new RecoveryBlocked("invalid provisioned snapshot reference");return JSON.parse(privateFile(join(c.snapshotDirectory,ref)).toString());},verifyFence:(id:string)=>verifySshFence(external,id,c.fenceTargets)};
 try{
  const controller=new ControlRecoveryController(options),member=new MemberTransitionInstaller({...options,pinned:{algorithm:operator.algorithm,publicKey:operator.publicKey}});
  const service=await serveRecovery({path:c.path,hostId:c.hostId,operator:{algorithm:operator.algorithm,publicKey:operator.publicKey},handle:controlRecoveryHandler(controller,member)});
  return{close:async()=>{try{await service.close();}finally{external.close();installed.close();}}};
 }catch(e){external.close();installed.close();throw e;}
}

// Member installation needs a public operator pin, not the operator or control signing private key.
export type MemberRecoveryOnlyConfig = {hostId:string;path:string;installedRegisterFile:string;operator:{algorithm:import("./auth.ts").Algorithm;publicKey:string};registerTls:RegisterTlsClient};
export async function startMemberRecoveryOnly(host:Pick<Session,"commit"|"snapshot">,ctx:Context,configFile:string,assertQuiesced:()=>Promise<{hostId:string;normalStopped:boolean;restartLocked:boolean}>){
 const c=JSON.parse(privateFile(configFile).toString()) as MemberRecoveryOnlyConfig;
 if(!c.hostId||!c.path||!c.installedRegisterFile||!c.operator?.publicKey||!["ed25519","ecdsa-p256"].includes(c.operator.algorithm)||!c.registerTls)throw new RecoveryBlocked("incomplete member recovery provisioning");
 const status=await assertQuiesced();if(status.hostId!==c.hostId||!status.normalStopped||!status.restartLocked)throw new RecoveryBlocked("exclusive stopped and restart-locked member runtime is required");
 const external=new TlsRecoveryRegister(c.registerTls),installed=new SqliteRecoveryRegister(c.installedRegisterFile);
 try{
  const member=new MemberTransitionInstaller({host,ctx,hostId:c.hostId,external,installed,pinned:c.operator,assertQuiesced});
  const service=await serveRecovery({path:c.path,hostId:c.hostId,operator:c.operator,handle:async(call,role)=>{if(role!=="operator"||call.method!=="installAuthority"||!call.args||typeof call.args!=="object"||Array.isArray(call.args))throw new RecoveryBlocked("member recovery permits only signed authority installation");return await member.advance((call.args as any).proof) as any;}});
  return{close:async()=>{try{await service.close();}finally{external.close();installed.close();}}};
 }catch(e){external.close();installed.close();throw e;}
}
