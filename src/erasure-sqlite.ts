// Maintenance of an exclusively owned, stopped pi-durable SQLite store, schema v1 only.
// Removes obsolete logical revisions and free pages; media snapshots require the archive policy.
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {apply} from '@earendil-works/chord/delta';
export async function compactErasedSqlite(path:string,assertExclusiveFenced:()=>Promise<void>){
 await assertExclusiveFenced();const absolute=resolve(path),stat=lstatSync(absolute);if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(absolute)!==absolute)throw Error('owned regular SQLite file required');
 const db=new DatabaseSync(absolute);let documents=0,revisionsRemoved=0;
 try{
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON');
  if(db.prepare('SELECT version FROM durable_schema WHERE singleton=1').get()?.version!==1)throw Error('unsupported durable SQLite schema');
  db.exec('BEGIN IMMEDIATE');
  try{
   const revisions=db.prepare('SELECT seq,kind,version,content FROM document_revisions WHERE document_id=? ORDER BY seq');
   for(const row of db.prepare("SELECT id,kind,retired_at FROM documents WHERE scope_kind='session'").all()){
    const kind=JSON.parse(row.kind as string);if(typeof kind!=='string'||!kind.startsWith('pi-spaces.'))continue;
    const rows=revisions.all(row.id as number);if(row.retired_at!==null){db.prepare('DELETE FROM document_revisions WHERE document_id=?').run(row.id as number);revisionsRemoved+=rows.length;continue;}
    let base=-1;for(let i=0;i<rows.length;i++)if(rows[i]!.kind==='base')base=i;if(base<0)throw Error('missing durable document base');let value=JSON.parse(rows[base]!.content as string);const version=rows[base]!.version;
    for(const r of rows.slice(base+1)){if(r.kind!=='delta'||r.version!==version)throw Error('invalid durable document revision chain');value=apply(value,JSON.parse(r.content as string));}
    const last=rows.at(-1)!;db.prepare('DELETE FROM document_revisions WHERE document_id=?').run(row.id as number);db.prepare("INSERT INTO document_revisions(document_id,seq,kind,version,content) VALUES(?,?,'base',?,?)").run(row.id as number,last.seq as number,version as number,JSON.stringify(value));documents++;revisionsRemoved+=rows.length-1;
   }
   await assertExclusiveFenced();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(checkpoint&&Number(checkpoint.busy)!==0)throw Error('SQLite history checkpoint is busy; remain fenced');
  db.exec('VACUUM');const finalCheckpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(finalCheckpoint&&Number(finalCheckpoint.busy)!==0)throw Error('compacted SQLite checkpoint is busy; remain fenced');await assertExclusiveFenced();if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('compacted SQLite integrity check failed');
  return{documents,revisionsRemoved,completed:true};
 }finally{db.close();}
}
