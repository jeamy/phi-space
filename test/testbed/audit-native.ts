// Read-only durable-store audit. Uses the storage library's delta semantics, including array operations.
import {DatabaseSync} from 'node:sqlite';
import {apply} from '@earendil-works/chord/delta';
import {argHash,rpcDomain} from '../../src/index.ts';
const [path,mode,prefix]=process.argv.slice(2);
if(!path||!['root','member'].includes(mode??'')||!prefix||!/^[A-Za-z0-9._-]{1,64}$/.test(prefix))throw Error('database, root|member and bounded run prefix required');
const db=new DatabaseSync(path,{readOnly:true});
try{
 db.exec('BEGIN');const docs:Array<{kind:string;value:any}>=[];
 const revisions=db.prepare('SELECT kind,content FROM document_revisions WHERE document_id=? ORDER BY seq');
 for(const row of db.prepare('SELECT id,kind FROM documents').all()){
  let value:any;for(const revision of revisions.all(row.id as string)){const data=JSON.parse(revision.content as string);value=revision.kind==='base'?data:apply(value,data);}
  docs.push({kind:JSON.parse(row.kind as string),value});
 }
 if(mode==='root'){
  const allParents=docs.filter(d=>d.kind==='phi-spaces.federation-operations').flatMap(d=>Object.values(d.value.operations??{}) as any[]),parents=allParents.filter(p=>p.id.startsWith(prefix+'-')),ids=new Set(parents.flatMap(p=>Object.values(p.children) as string[]));
  const commands=docs.filter(d=>d.kind==='phi-spaces.router-command'&&ids.has(d.value.command?.id)).map(d=>d.value.command);
  console.log(JSON.stringify({parents:parents.map(p=>({id:p.id,phase:p.phase,kind:p.kind,result:p.result??null})),commands:commands.map(c=>({id:c.id,state:c.state,steps:c.steps.map((s:any)=>{const domain=rpcDomain({method:s.method,args:s.args},s.principal);return{target:s.target,principal:s.principal,method:s.method,domainMethod:domain.method,argumentHash:argHash(domain.method,domain.args),generation:s.generation,generationAdmitUntil:s.generationAdmitUntil??null,requestId:s.requestId,state:s.state,evidence:s.evidence??null,result:s.result??null};})})),historicalReviewParents:allParents.filter(p=>!p.id.startsWith(prefix+'-')&&p.phase==='needsReview').map(p=>p.id)}));
 }else{
  const spaces=docs.filter(d=>d.kind==='phi-spaces.named-space'||d.kind==='phi-spaces.space').map(d=>({spaceId:d.value.spaceId,incarnation:d.value.incarnation,activeTransactions:Object.keys(d.value.txns??{}),claims:Object.values(d.value.rpc?.claims??{}),scopedEntries:(d.value.entries??[]).filter((e:any)=>e.fields?.runId===prefix).map((e:any)=>({id:e.id,type:e.type,fields:e.fields,owner:e.owner}))}));
  console.log(JSON.stringify({spaces}));
 }
}finally{db.close();}
