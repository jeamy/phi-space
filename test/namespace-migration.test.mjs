import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {createRegistry,Harness} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {PhiSpaces,FOREVER} from '../src/index.ts';
import {migrateNamespace} from '../scripts/migrate-namespace.mjs';

async function fixture(run) {
 const dir=await mkdtemp(join(tmpdir(),'phi-namespace-test-')),input=join(dir,'before.sqlite'),output=join(dir,'after.sqlite');
 try {
  const h=await Harness.open(await openNodeSqliteStorage(input),{registry:createRegistry(),models:createModels()},ctx);
  try{await new PhiSpaces(h,ctx).write({type:'Preserved',fields:{text:'unchanged',n:42}},null,FOREVER);}finally{await h.close(ctx);}
  const db=new DatabaseSync(input);
  try{for(const row of db.prepare('SELECT id,kind FROM documents').all()){
   const kind=JSON.parse(row.kind).replace('phi-spaces.','former-fixture.');
   db.prepare("UPDATE documents SET kind=?,record=json_set(record,'$.kind',?) WHERE id=?").run(JSON.stringify(kind),kind,row.id);
  }}finally{db.close();}
  await run({dir,input,output});
 }finally{await rm(dir,{recursive:true,force:true});}
}

test('namespace copy migration: dry-run is read-only; new store reopens with identical entry and original stays unchanged',async()=>fixture(async({input,output})=>{
 const original=await readFile(input);
 const dry=await migrateNamespace({input,from:'former-fixture'});assert.equal(dry.applied,false);assert.ok(dry.renamed>=2);
 assert.deepEqual(await readFile(input),original);
 const result=await migrateNamespace({input,output,from:'former-fixture',apply:true});assert.equal(result.payloadsUnchanged,true);
 assert.deepEqual(await readFile(input),original);
 const h=await Harness.open(await openNodeSqliteStorage(output),{registry:createRegistry(),models:createModels()},ctx);
 try{const entry=await new PhiSpaces(h,ctx).read({type:'Preserved'},0);assert.deepEqual(entry.fields,{text:'unchanged',n:42});}finally{await h.close(ctx);}
 await assert.rejects(migrateNamespace({input,output,from:'former-fixture',apply:true}),/already exists/);
}));

test('namespace copy migration: failure before publication leaves input intact and no output',async()=>fixture(async({input,output})=>{
 const before=await readFile(input);
 await assert.rejects(migrateNamespace({input,output,from:'former-fixture',apply:true,beforePublish:()=>{throw Error('injected');}}),/injected/);
 await assert.rejects(access(output),{code:'ENOENT'});assert.deepEqual(await readFile(input),before);
 await assert.rejects(migrateNamespace({input,output:input,from:'former-fixture',apply:true}),/must differ/);
}));

test('namespace copy migration: target address collision and replicated marker fail closed',async()=>fixture(async({input,output})=>{
 const db=new DatabaseSync(input);
 try{
  const row=db.prepare('SELECT * FROM documents LIMIT 1').get();const record=JSON.parse(row.record),kind=record.kind.replace('former-fixture.','phi-spaces.');
  record.id=9999;record.kind=kind;
  db.prepare('INSERT INTO documents(id,kind,family,key_value,scope_kind,owner_id,created_at,retired_at,record) VALUES(?,?,?,?,?,?,?,?,?)').run(record.id,JSON.stringify(kind),row.family,row.key_value,row.scope_kind,row.owner_id,row.created_at,null,JSON.stringify(record));
 }finally{db.close();}
 await assert.rejects(migrateNamespace({input,output,from:'former-fixture',apply:true}),/collision/);
 const changed=new DatabaseSync(input);
 try{changed.prepare('DELETE FROM documents WHERE id=9999').run();const row=changed.prepare('SELECT id FROM documents LIMIT 1').get();const kind='former-fixture.primary-sync-storage-marker';changed.prepare("UPDATE documents SET kind=?,record=json_set(record,'$.kind',?) WHERE id=?").run(JSON.stringify(kind),kind,row.id);}finally{changed.close();}
 await assert.rejects(migrateNamespace({input,output,from:'former-fixture',apply:true}),/Replicated/);
 await assert.rejects(access(output),{code:'ENOENT'});
}));
