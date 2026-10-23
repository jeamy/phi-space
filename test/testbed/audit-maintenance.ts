// Read-only proof of live profile and erasure maintenance. Never exports signing material.
import {readStoreDocuments} from './read-store.ts';
const [path]=process.argv.slice(2);if(!path)throw Error('owned database required');
{
 const docs=readStoreDocuments(path);
 const operations=(kind:string)=>docs.filter(d=>d.kind===kind).flatMap(d=>Object.entries(d.value.operations??{}).map(([id,v])=>({id,...v as any})));
 console.log(JSON.stringify({profiles:operations('phi-spaces.profile-transitions'),erasures:operations('phi-spaces.root-erasures'),parents:operations('phi-spaces.federation-operations').map(p=>({id:p.id,phase:p.phase,erased:p.erased??null})),routing:docs.filter(d=>d.kind==='phi-spaces.federation-routing').map(d=>({policy:d.value.policy,members:d.value.members})),spaces:docs.filter(d=>['phi-spaces.space','phi-spaces.named-space'].includes(d.kind)).map(d=>({spaceId:d.value.spaceId,membership:d.value.membership??null,completionProfiles:d.value.completionProfiles??[],erasureEpoch:d.value.erasureEpoch??0,entries:(d.value.entries??[]).length,privacyEntries:(d.value.entries??[]).filter((e:any)=>e.fields?.deletionProbe).length,activeTransactions:Object.keys(d.value.txns??{}).length}))}));
}
