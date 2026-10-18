// Classify exact journal transitions at Storage.commit, never by substring matching.
export const JOURNAL_KINDS=['parentAdmission','futureReservation','childAcceptance','childBinding','parentReady','childInflight','childCompletion','registration','candidate','winner','parentCompletion','futureRelease','parentCursor'] as const;
export function journalTransitions(kind:string,before:any,after:any,parentId:string,childIds:ReadonlySet<string>,budgetId:string):string[]{
 const found:string[]=[],count=(v:any)=>Object.keys(v??{}).length;
 if(kind==='phi-spaces.federation-operations'){
  const b=before?.operations?.[parentId],a=after?.operations?.[parentId];if(!a)return found;
  if(!b&&a.phase==='admitting')found.push('parentAdmission');
  if(b){
   if(count(a.children)>count(b.children))found.push('childBinding');
   if(b.phase!=='ready'&&a.phase==='ready')found.push('parentReady');
   if(count(a.registrations)>count(b.registrations))found.push('registration');
   if(count(a.candidates)>count(b.candidates))found.push('candidate');
   if(!b.winner&&a.winner)found.push('winner');
   if(b.phase!=='done'&&a.phase==='done')found.push('parentCompletion');
   if(a.cursor>b.cursor)found.push('parentCursor');
  }
 }else if(kind==='phi-spaces.router-command'){
  const b=before?.command,a=after?.command;if(!a||!childIds.has(a.id))return found;
  if(!b&&a.state==='accepted')found.push('childAcceptance');
  if(b&&a.steps.some((s:any,n:number)=>s.state==='inflight'&&b.steps[n]?.state!=='inflight'))found.push('childInflight');
  if(b&&b.state!=='completed'&&a.state==='completed')found.push('childCompletion');
 }else if(kind==='phi-spaces.router-journal'){
  const b=before?.future?.[budgetId],a=after?.future?.[budgetId];
  if(!b&&a)found.push('futureReservation');if(b&&!a)found.push('futureRelease');
 }
 return found;
}
