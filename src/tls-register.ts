// Independently hosted register over pinned mutual TLS; reader certificates never confer CAS rights.
import tls from "node:tls";
import { createHash } from "node:crypto";
import { privateFile } from "./keys.ts";
import { RegisterConflict, type RecoveryRegister, type RegisterRecord } from "./recovery-register.ts";
import type { Json } from "./core.ts";
export type RegisterTlsIdentity = { caFile: string; certFile: string; keyFile: string };
export type RegisterTlsClient = RegisterTlsIdentity & { host: string; port: number; serverName?: string; timeoutMs?: number };
export class TlsRecoveryRegister implements RecoveryRegister {
 private o: RegisterTlsClient;
 constructor(o: RegisterTlsClient) { this.o=o; }
 private call(call: unknown): Promise<any> {
  const o=this.o,body=JSON.stringify(call)+"\n";if(Buffer.byteLength(body)>256*1024) return Promise.reject(new Error("register request exceeds budget"));
  return new Promise((resolve,reject)=>{
   const socket=tls.connect({host:o.host,port:o.port,servername:o.serverName,ca:privateFile(o.caFile),cert:privateFile(o.certFile),key:privateFile(o.keyFile),rejectUnauthorized:true,minVersion:"TLSv1.3"});let input=Buffer.alloc(0),done=false;
   const finish=(error?:Error,value?:any)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};const timer=setTimeout(()=>finish(new Error("independent TLS register timed out")),o.timeoutMs??6000);
   socket.on("secureConnect",()=>socket.write(body));socket.on("error",e=>finish(e));socket.on("close",()=>{if(!done)finish(new Error("register disconnected"));});socket.on("data",data=>{input=Buffer.concat([input,typeof data==="string"?Buffer.from(data):data]);if(input.length>256*1024)return finish(new Error("register response exceeds budget"));const end=input.indexOf("\n");if(end<0)return;try{const r=JSON.parse(input.subarray(0,end).toString("utf8"));if(!r.ok){if(r.error?.code==="RequestConflict")return finish(new RegisterConflict(r.error.message));throw new Error(r.error?.message??"register refused request");}finish(undefined,r.result);}catch(e){finish(e as Error);}});
  });
 }
 get<T extends Json>(key:string):Promise<RegisterRecord<T>|null>{return this.call({method:"get",key});}
 compareAndSet<T extends Json>(key:string,expected:number|null,value:T):Promise<RegisterRecord<T>>{return this.call({method:"compareAndSet",key,expectedVersion:expected,value});}
 close():void{}
}
export async function serveTlsRegister(register:RecoveryRegister,o:RegisterTlsIdentity&{host:string;port:number;peers:Record<string,{operator?:boolean;writeKeys?:string[]}>}){
 const open=new Set<tls.TLSSocket>();
 const server=tls.createServer({ca:privateFile(o.caFile),cert:privateFile(o.certFile),key:privateFile(o.keyFile),requestCert:true,rejectUnauthorized:true,minVersion:"TLSv1.3",handshakeTimeout:4000},socket=>{
  const certificate=socket.getPeerCertificate(),fingerprint=certificate.raw?createHash("sha256").update(certificate.raw).digest("hex"):"",policy=o.peers[fingerprint];
  if(!socket.authorized||!policy||open.size>=32){socket.destroy();return;}open.add(socket);socket.setTimeout(8000,()=>socket.destroy());socket.on("error",()=>{});socket.on("close",()=>open.delete(socket));let input=Buffer.alloc(0),started=false;
  socket.on("data",async data=>{if(started){socket.destroy();return;}input=Buffer.concat([input,typeof data==="string"?Buffer.from(data):data]);if(input.length>256*1024){socket.destroy();return;}const end=input.indexOf("\n");if(end<0)return;started=true;
   try{const c=JSON.parse(input.subarray(0,end).toString("utf8"));if(typeof c.key!=="string"||!c.key||c.key.length>512)throw new Error("invalid register key");let result;
    if(c.method==="get")result=await register.get(c.key);else if(c.method==="compareAndSet"&&(policy.operator||policy.writeKeys?.includes(c.key)))result=await register.compareAndSet(c.key,c.expectedVersion,c.value);else throw new Error("certificate has no CAS permission for this register key");socket.end(JSON.stringify({ok:true,result})+"\n");
   }catch(e){socket.end(JSON.stringify({ok:false,error:{code:e instanceof RegisterConflict?"RequestConflict":"PermissionDenied",message:e instanceof Error?e.message:String(e)}})+"\n");}
  });
 });server.maxConnections=64;server.on("tlsClientError",()=>{});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(o.port,o.host,()=>{server.removeListener("error",reject);resolve();});});
 return{address:()=>server.address(),close:async()=>{for(const s of open)s.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
