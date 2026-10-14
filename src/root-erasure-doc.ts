import {defineDocFamily} from '@earendil-works/pi-durable';
import type {Principal} from './claims.ts';
export type RootErasureOperation={hash:string;subjectHash:string;principal?:Principal;phase:'collecting'|'children'|'parents'|'completed';partition:number;cursor:number;parents:number;children:number;routerIds:string[];partitions:number};
export const RootErasures=defineDocFamily<{operations:Record<string,RootErasureOperation>},null>({kind:'pi-spaces.root-erasures',version:1,scope:'session',family:true,initial:()=>({operations:{}})});
export const ErasedEntryDigests=defineDocFamily<{digests:Record<string,true>},null>({kind:'pi-spaces.erased-entry-digests',version:1,scope:'session',family:true,initial:()=>({digests:{}})});
