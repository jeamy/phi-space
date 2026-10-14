// Private operator helper for owned native acceptance fixtures. Tokens enter through stdin only.
import {readFileSync} from 'node:fs';
import {RemoteSpace,socketTransport,provisionFileSigner,loadFileSigner,TlsRecoveryRegister,hashToken,core} from '../../../src/index.ts';
let input='';for await(const part of process.stdin){input+=part.toString();if(Buffer.byteLength(input)>256*1024)throw Error('operator input exceeds budget');}
const q=JSON.parse(input);let result:unknown;
if(q.action==='key'||q.action==='keyInfo') {const key=q.action==='key'?provisionFileSigner(q.path):loadFileSigner(q.path);result={keyId:key.keyId,algorithm:key.algorithm,publicKey:key.publicKey};}
else if(q.action==='register'){
 const cfg=JSON.parse(readFileSync(q.config,'utf8'));if(!cfg.allowedKeys.includes(q.key))throw Error('register key is outside owned fixture');const register=new TlsRecoveryRegister(cfg.register);try{if(q.write){result=await register.compareAndSet(q.key,q.expected,q.value);}else result=await register.get(q.key);}finally{register.close();}
}else{
 const signer=loadFileSigner(q.keyFile),socket=socketTransport(q.address);let r:RemoteSpace;r=new RemoteSpace(socket,{space:'control',signer,ownPeerId:q.peerId,expectedGateHostId:q.hostId,grantProvider:()=>r.requestGrant(),callTimeoutMs:15000,attempts:1});
 try{
  if(q.action!=='enroll')await r.authenticate();
  if(q.action==='enroll')result=await r.enroll(q.token);
  else if(q.action==='createEnroll'||q.action==='command'){
   const commandId=q.commandId;await r.write({type:'Command',fields:{commandId,kind:q.action==='command'?q.kind:'createEnroll',args:q.action==='command'?q.args:{tokenHash:hashToken(q.token),role:q.role,allowedPeerId:q.allowedPeerId,scope:['*']}}},null,core.FOREVER);
   let found;for(let i=0;i<150;i++){found=await r.read({type:'Result',fields:{commandId}},0);if(found)break;await new Promise(resolve=>setTimeout(resolve,100));}if(found?.fields.state!=='completed')throw Error('enrollment command not completed');result={completed:true,result:found.fields.result};
  }else if(q.action==='directory')result=await r.readAll({type:q.type});
  else throw Error('unknown operator action');
 }finally{socket.close();}
}
console.log(JSON.stringify(result));
