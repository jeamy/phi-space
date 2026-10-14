// A controlled profile transition never changes placement, hierarchy or authority.
import {canonicalJson} from './canonical.ts';
import {initialState,setCompletionProfiles} from './core.ts';
import type {FederationPolicy} from './routing-semantics.ts';
import {RoutingConflict} from './routing-semantics.ts';
export function validateProfileOnlyChange(old:FederationPolicy,next:FederationPolicy){
 if(next.policyVersion!==old.policyVersion+1||canonicalJson({...old,policyVersion:next.policyVersion,completionProfiles:next.completionProfiles} as any)!==canonicalJson(next as any))throw new RoutingConflict('profile transition may only change profiles and advance one policy version');
 setCompletionProfiles(initialState(),next.completionProfiles,0);
 return [...new Set([...old.completionProfiles,...next.completionProfiles].map(p=>p.taskType))];
}
