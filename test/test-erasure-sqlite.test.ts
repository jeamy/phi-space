import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {compactErasedSqlite} from '../src/erasure-sqlite.ts';
import {principalId} from '../src/mailbox.ts';
import {DataAdminController} from '../src/data-admin.ts';
import {createSpace,spaceDoc,snapshotSpace} from '../src/spaces.ts';
import * as core from '../src/core.ts';
import {PersistentHome,ctx} from './support/persistent.ts';
test('exclusive SQLite history compaction preserves live state and replay receipts while removing erased historical payloads',async()=>{
 const home=new PersistentHome('sqlite');try{
  let host=await home.open();const sid=(await host.commit(tx=>createSpace(tx,'jobs',1000),ctx)).spaceId;
  const payload='unique-personal-erasure-payload-394148';await host.commit(async tx=>{const s=await spaceDoc(tx,sid,1000);core.write(s,1000,{type:'Secret',fields:{payload}},null,core.FOREVER,principalId({peerId:'subject'}));core.write(s,1000,{type:'Keep',fields:{ok:true}},null,core.FOREVER,principalId({peerId:'other'}));},ctx);
  const admin=()=>new DataAdminController({host,ctx,authorize:async()=>{},assertAuthority:async()=>{},now:()=>1001});const receipt=await admin().execute('erase','deletePrincipal',sid,'admin',{peerId:'subject'});const expected=await snapshotSpace(host,sid,ctx);const paths=(v:any,p=''):string[]=>typeof v==='string'&&v.includes(payload)?[p]:v&&typeof v==='object'?Object.entries(v).flatMap(([k,x])=>paths(x,p+'.'+k)):[];assert.deepEqual(paths(expected),[],'current state must already be logically erased');await home.close(host);
  const actualPath=join(home.dir,'harness.sqlite');
  const db=new DatabaseSync(actualPath,{readOnly:true});try{assert.ok(JSON.stringify(db.prepare('SELECT content FROM document_revisions').all()).includes(payload),'test must contain obsolete personal history');}finally{db.close();}
  await assert.rejects(compactErasedSqlite(actualPath,async()=>{throw Error('not fenced');}),/not fenced/);
  const result=await compactErasedSqlite(actualPath,async()=>{});assert.ok(result.revisionsRemoved>0);const audit=new DatabaseSync(actualPath,{readOnly:true});try{const remaining=audit.prepare('SELECT d.kind,r.kind AS revisionKind FROM documents d JOIN document_revisions r ON r.document_id=d.id WHERE instr(r.content,?)>0').all(payload);assert.deepEqual(remaining,[], 'remaining personal revisions');}finally{audit.close();}assert.ok(!readFileSync(actualPath).includes(Buffer.from(payload)));await compactErasedSqlite(actualPath,async()=>{});
  host=await home.open();assert.deepEqual(await snapshotSpace(host,sid,ctx),expected);assert.deepEqual(await admin().execute('erase','deletePrincipal',sid,'admin',{peerId:'subject'}),receipt);await host.commit(async tx=>{core.write(await spaceDoc(tx,sid,1002),1002,{type:'After',fields:{}},null,core.FOREVER);},ctx);
 }finally{await home.dispose();}
});
