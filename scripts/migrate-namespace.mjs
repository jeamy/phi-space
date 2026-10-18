// Offline namespace migration for unreplicated durable SQLite v1 stores. Never edits the input.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { access, chmod, lstat, realpath, mkdtemp, rm, link, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tables = ['durable_schema','durable_metadata','record_ids','conversations','entries','tasks','submissions','documents','document_revisions'];
const namespace = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
function hashRows(rows) {
  const hash=createHash('sha256');
  for(const row of rows)hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
}
function inspect(db, from, to) {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw Error('SQLite integrity check failed');
  const present = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name).sort();
  if (JSON.stringify(present) !== JSON.stringify([...tables].sort())) throw Error('Unsupported or journal-bearing SQLite schema');
  if (db.prepare('SELECT version FROM durable_schema WHERE singleton=1').get()?.version !== 1) throw Error('Unsupported durable schema version');
  const docs = db.prepare('SELECT * FROM documents ORDER BY id').all();
  const changed=[], addresses=new Set();
  for (const row of docs) {
    const kind = JSON.parse(row.kind), record = JSON.parse(row.record);
    if (typeof kind !== 'string' || record.kind !== kind || record.id !== row.id) throw Error('Document metadata/index mismatch');
    if (/\.(primary-sync-storage-marker|control-replica-marker|entry-replica|entry-replica-peers)$/.test(kind)) throw Error('Replicated stores require a coordinated journal-aware migration');
    const next = kind.startsWith(from+'.') ? to+kind.slice(from.length) : kind;
    if (next !== kind) changed.push({id:row.id,kind:next});
    if (row.retired_at === null) {
      const address=JSON.stringify([next,row.scope_kind,row.owner_id,row.family,row.key_value]);
      if (addresses.has(address)) throw Error('Target namespace/address collision');
      addresses.add(address);
    }
  }
  const fingerprints={};
  for(const table of tables) {
    const rows = table === 'documents' ? docs.map(row=>{
      const record=JSON.parse(row.record), kind=JSON.parse(row.kind);
      const next=kind.startsWith(from+'.')?to+kind.slice(from.length):kind;
      return {...row,kind:JSON.stringify(next),record:JSON.stringify({...record,kind:next})};
    }) : db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate();
    fingerprints[table]=hashRows(rows);
  }
  return {changed,documents:docs.length,fingerprints};
}

export async function migrateNamespace({input,output,from,to='phi-spaces',apply=false,beforePublish}) {
  if (!namespace(from)||!namespace(to)||from===to) throw Error('Distinct valid source/target namespaces required');
  const source=resolve(input), stat=await lstat(source);
  if(!stat.isFile()||stat.isSymbolicLink()||await realpath(source)!==source)throw Error('Input must be a regular, non-symlink SQLite file');
  if(apply&&!output)throw Error('A new output path is required; in-place migration is forbidden');
  const target=output?resolve(output):null;
  if(target===source)throw Error('Input and output must differ');
  if(target)try{await access(target);throw Error('Output already exists; refusing overwrite');}catch(error){if(error.code!=='ENOENT')throw error;}
  const db=new DatabaseSync(source,{readOnly:true});
  let work;
  try {
    const plan=inspect(db,from,to);
    if(!apply)return {applied:false,documents:plan.documents,renamed:plan.changed.length};
    if(await realpath(dirname(target))!==dirname(target))throw Error('Output parent must not contain symlinks');
    work=await mkdtemp(join(dirname(target),'.phi-namespace-'));
    const staged=join(work,'store.sqlite');
    await backup(db,staged);
    await chmod(staged,0o600);
    const copy=new DatabaseSync(staged);
    let result;
    try {
      copy.exec('PRAGMA synchronous=FULL');
      const snapshot=inspect(copy,from,to);
      copy.exec('BEGIN IMMEDIATE');
      try {
        const update=copy.prepare("UPDATE documents SET kind=?,record=json_set(record,'$.kind',?) WHERE id=?");
        for(const row of snapshot.changed)update.run(JSON.stringify(row.kind),row.kind,row.id);
        const verified=inspect(copy,from,to);
        if(verified.changed.length||JSON.stringify(snapshot.fingerprints)!==JSON.stringify(verified.fingerprints))throw Error('Migration changed more than namespace metadata');
        copy.exec('COMMIT');
        result={applied:true,documents:snapshot.documents,renamed:snapshot.changed.length,payloadsUnchanged:true};
      }catch(error){copy.exec('ROLLBACK');throw error;}
      copy.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    }finally{copy.close();}
    await beforePublish?.();
    const file=await open(staged,'r');try{await file.sync();}finally{await file.close();}
    await link(staged,target); // Atomic publication, fails rather than overwriting a racing target.
    const directory=await open(dirname(target),'r');try{await directory.sync();}finally{await directory.close();}
    return result;
  }finally{db.close();if(work)await rm(work,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2), options={};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(key==='--apply')options.apply=true;
    else if(['--input','--output','--from','--to'].includes(key)&&args[i+1]&&!args[i+1].startsWith('--'))options[key.slice(2)]=args[++i];
    else throw Error('Usage: migrate-namespace.mjs --input FILE --from NAMESPACE [--to NAMESPACE] [--output NEW_FILE --apply]');
  }
  if(!options.input)throw Error('--input is required');
  console.log(JSON.stringify(await migrateNamespace(options)));
}
