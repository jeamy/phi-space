// Read-only proof of live profile and erasure maintenance. Never exports signing material.
import {DatabaseSync} from 'node:sqlite';
import {apply} from '@earendil-works/chord/delta';
const [path]=process.argv.slice(2);if(!path)throw Error('owned database required');const db=new DatabaseSync(path,{readOnly:true});
try{
 db.exec('BEGIN');const docs:any[]=[];
 for(const row of db.prepare('SELECT id,kind FROM documents WHERE retired_at IS NULL').all()){
  let value:any;for(const r of db.prepare('SELECT kind,content FROM document_revisions WHERE document_id=? ORDER BY seq').all(row.id as number)){const content=JSON.parse(r.content as string);value=r.kind==='base'?content:apply(value,content);}docs.push({kind:JSON.parse(row.kind as string),value});
 }
 const operations=(kind:string)=>docs.filter(d=>d.kind===kind).flatMap(d=>Object.entries(d.value.operations??{}).map(([id,v])=>({id,...v as any})));
 console.log(JSON.stringify({profiles:operations('phi-spaces.profile-transitions'),erasures:operations('phi-spaces.root-erasures'),parents:operations('phi-spaces.federation-operations').map(p=>({id:p.id,phase:p.phase,erased:p.erased??null})),routing:docs.filter(d=>d.kind==='phi-spaces.federation-routing').map(d=>({policy:d.value.policy,members:d.value.members})),spaces:docs.filter(d=>['phi-spaces.space','phi-spaces.named-space'].includes(d.kind)).map(d=>({spaceId:d.value.spaceId,membership:d.value.membership??null,completionProfiles:d.value.completionProfiles??[],erasureEpoch:d.value.erasureEpoch??0,entries:(d.value.entries??[]).length,privacyEntries:(d.value.entries??[]).filter((e:any)=>e.fields?.deletionProbe).length,activeTransactions:Object.keys(d.value.txns??{}).length}))}));
}finally{db.close();}
