import { defineDocFamily } from './store/documents.ts';
import type {Principal} from './claims.ts';
export type RootErasureOperation={hash:string;subjectHash:string;principal?:Principal;phase:'collecting'|'children'|'parents'|'completed';partition:number;cursor:number;parents:number;children:number;routerIds:string[];partitions:number};
export const RootErasures=defineDocFamily<{operations:Record<string,RootErasureOperation>},null>({kind:'phi-spaces.root-erasures',version:1,scope:'session',family:true,initial:()=>({operations:{}})});
export const ErasedEntryDigests=defineDocFamily<{digests:Record<string,true>},null>({kind:'phi-spaces.erased-entry-digests',version:1,scope:'session',family:true,initial:()=>({digests:{}})});
