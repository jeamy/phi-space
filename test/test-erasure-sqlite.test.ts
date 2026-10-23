import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {compactErasedSqlite} from '../src/erasure-sqlite.ts';
import {principalId} from '../src/mailbox.ts';
import {DataAdminController} from '../src/data-admin.ts';
import {createSpace,spaceDoc,snapshotSpace} from '../src/spaces.ts';
import * as core from '../src/core.ts';
import {PersistentHome,ctx} from './support/persistent.ts';
test('the own store after an erasure: compaction removes the erased bytes from file and WAL and keeps the live state',async()=>{
 const home=new PersistentHome('own-sqlite');try{
  let host=await home.open();const sid=(await host.commit(tx=>createSpace(tx,'jobs',1000),ctx)).spaceId;
  const payload='unique-personal-erasure-payload-771203';
  await host.commit(async tx=>{const s=await spaceDoc(tx,sid,1000);core.write(s,1000,{type:'Secret',fields:{payload,pad:payload.repeat(300)}},null,core.FOREVER,principalId({peerId:'subject'}));core.write(s,1000,{type:'Keep',fields:{n:1}},null,core.FOREVER,principalId({peerId:'other'}));},ctx);
  const admin=()=>new DataAdminController({host,ctx,authorize:async()=>{},assertAuthority:async()=>{},now:()=>1001});await admin().execute('erase','deletePrincipal',sid,'admin',{peerId:'subject'});
  // deleted rows are overwritten in the file (node's SQLite has secure_delete on), and a clean close empties the WAL;
  // a killed process leaves the older page images, the erased payload with them, in the WAL: its files are copied as
  // they are while the host runs
  const expected=JSON.stringify(await snapshotSpace(host,sid,ctx)),live=join(home.dir,'store.sqlite'),path=join(home.dir,'killed.sqlite');
  for(const x of ['','-wal','-shm'])try{copyFileSync(live+x,path+x);}catch{}
  await assert.rejects(compactErasedSqlite(live,async()=>{}),/another process owns the store/,'a running host keeps its store');await home.close(host);
  const bytes=()=>[path,path+'-wal'].map(f=>{try{return readFileSync(f).toString('latin1');}catch{return '';}}).join('');
  assert.ok(bytes().includes(payload),'test must start with the erased payload still in the WAL');
  await assert.rejects(compactErasedSqlite(path,async()=>{throw Error('not fenced');}),/not fenced/);
  const result=await compactErasedSqlite(path,async()=>{});assert.equal(result.completed,true);
  assert.ok(!bytes().includes(payload),'no erased byte is left in file or WAL');
  const {openSqliteHost}=await import('../src/store/sqlite.ts'),h=await openSqliteHost(path);try{assert.equal(JSON.stringify(await snapshotSpace(h,sid,ctx)),expected,'the live state is kept');}finally{await h.close(ctx);}
 }finally{await home.dispose();}
});
