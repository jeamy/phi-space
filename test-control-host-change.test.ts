import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import {SqliteRecoveryRegister,provisionFileSigner,signControlHostChange,recordControlHostChange,followControlHostChange,ControlHostChangeBlocked,type ControlHostChange} from './src/index.ts';

test('a control host change keeps the authority, is recorded only after the promotion and is followed with the pinned admin key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'host-change-')),reg=new SqliteRecoveryRegister(join(dir,'external.sqlite')),local=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));
 try{
  const admin=provisionFileSigner(join(dir,'admin.json')),other=provisionFileSigner(join(dir,'other.json')),aKey=provisionFileSigner(join(dir,'a.json')),bKey=provisionFileSigner(join(dir,'b.json'));
  const pin={algorithm:admin.algorithm,publicKey:admin.publicKey},cs='sp-control';
  const permit=(role:string,state:string,e:number)=>({state,authorityId:'auth',dataIncarnation:'inc',role,primaryEpoch:e,replicaConfigVersion:e,durability:'single',transitionId:'t'});
  await reg.compareAndSet('authority:'+cs,null,{authorityId:'auth',hostId:'a',supervisorKey:aKey.publicKey,state:'active',lineage:{}});
  await reg.compareAndSet('boot:a',null,{hostId:'a',state:'active',spaces:{[cs]:permit('primary','active',1)}});
  await reg.compareAndSet('boot:b',null,{hostId:'b',state:'active',spaces:{[cs]:permit('standby','active',1)}});
  const change:ControlHostChange={recoveryId:'promote-b',authorityId:'auth',controlSpaceId:cs,fromHostId:'a',targetHostId:'b',primaryEpoch:2,supervisorKey:bKey.publicKey,algorithm:bKey.algorithm,address:{host:'100.64.0.2',port:7421}};
  const signed=await signControlHostChange(change,admin);
  // Not before the promotion is in the register, never with another signer.
  await assert.rejects(recordControlHostChange(reg,signed,pin),/not the active primary/);
  await assert.rejects(recordControlHostChange(reg,await signControlHostChange(change,other),pin),ControlHostChangeBlocked);
  const b=await reg.get<any>('boot:b'),a=await reg.get<any>('boot:a');
  await reg.compareAndSet('boot:b',b!.version,{...b!.value,spaces:{[cs]:permit('primary','active',2)}});
  await assert.rejects(recordControlHostChange(reg,signed,pin),/old control host still holds/);
  await reg.compareAndSet('boot:a',a!.version,{...a!.value,state:'fenced',spaces:{[cs]:permit('primary','revoked',1)}});
  await assert.rejects(recordControlHostChange(reg,{...signed,change:{...change,authorityId:'other-auth'}},pin),ControlHostChangeBlocked,'a changed body breaks the signature');
  await recordControlHostChange(reg,signed,pin);await recordControlHostChange(reg,signed,pin);
  const rec=(await reg.get<any>('authority:'+cs))!.value;assert.deepEqual([rec.authorityId,rec.hostId,rec.supervisorKey,rec.hostChange],['auth','b',bKey.publicKey,'promote-b']);
  // A host configured for a follows: endpoint, key and authority installed locally; repeating is a no-op.
  const o={controlSpaceId:cs,configured:{hostId:'a',authorityId:'auth'},recoveryAdmin:pin};
  await assert.rejects(followControlHostChange(reg,local,{...o,recoveryAdmin:{algorithm:other.algorithm,publicKey:other.publicKey}}),/invalid recovery admin signature/);
  assert.equal((await followControlHostChange(reg,local,o))?.targetHostId,'b');assert.equal(await followControlHostChange(reg,local,o),null);
  const inst=(await local.get<any>('installed-authority:'+cs))!.value;assert.deepEqual([inst.targetHostId,inst.supervisorKey,inst.address.host,inst.authorityId],['b',bKey.publicKey,'100.64.0.2','auth']);
  // The way back: a second change to a, followed from b.
  const back:ControlHostChange={...change,recoveryId:'promote-a',fromHostId:'b',targetHostId:'a',primaryEpoch:3,supervisorKey:aKey.publicKey,address:{host:'100.64.0.1',port:7421}};
  const a2=await reg.get<any>('boot:a'),b2=await reg.get<any>('boot:b');
  await reg.compareAndSet('boot:a',a2!.version,{hostId:'a',state:'active',spaces:{[cs]:permit('primary','active',3)}});await reg.compareAndSet('boot:b',b2!.version,{hostId:'b',state:'fenced',spaces:{[cs]:permit('primary','revoked',2)}});
  await assert.rejects(recordControlHostChange(reg,await signControlHostChange({...back,recoveryId:'promote-b'},admin),pin),/not active on the old control host|already used/);
  await recordControlHostChange(reg,await signControlHostChange(back,admin),pin);
  assert.equal((await followControlHostChange(reg,local,o))?.targetHostId,'a');
  assert.equal((await local.get<any>('installed-authority:'+cs))!.value.address.host,'100.64.0.1');
  // A host that never followed and is configured for a needs nothing.
  const fresh=new SqliteRecoveryRegister(join(dir,'fresh.sqlite'));assert.equal(await followControlHostChange(reg,fresh,o),null);fresh.close();
 }finally{reg.close();local.close();rmSync(dir,{recursive:true,force:true});}
});
