import {defineDocFamily} from '@earendil-works/pi-durable';
import type {FederationPolicy,FederationMember} from './routing-semantics.ts';
export type Operation={hash:string;oldPolicy:FederationPolicy;nextPolicy:FederationPolicy;members:FederationMember[];phase:'freezing'|'installing'|'publishing'|'resuming'|'completed';cursor:number};
export const ProfileTransitions=defineDocFamily<{operations:Record<string,Operation>},null>({kind:'phi-spaces.profile-transitions',version:1,scope:'session',family:true,initial:()=>({operations:{}})});
