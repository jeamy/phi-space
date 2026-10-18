import test from 'node:test';
import assert from 'node:assert/strict';
import {journalTransitions,JOURNAL_KINDS} from './testbed/scenarios/journal-checkpoints.ts';
const id='probe',children=new Set(['owned-child']),budget='owned-budget';
const classify=(kind:string,b:any,a:any)=>journalTransitions(kind,b,a,id,children,budget);
test('journal classifier excludes other Parents, commands, budgets and unrelated document families',()=>{
 for(const kind of ['phi-spaces.federation-operations','phi-spaces.router-command','phi-spaces.router-journal','other'])assert.deepEqual(classify(kind,{}, {operations:{other:{phase:'done'}},command:{id:'other',state:'accepted'},future:{other:{slots:1}}}),[]);
});
test('journal classifier covers every selected transition and excludes unchanged replay',()=>{
 const samples:any={parentAdmission:[undefined, {phase:'admitting',children:{},registrations:{},candidates:{},cursor:0}],childBinding:[{children:{}},{children:{a:'owned-child'}}],parentReady:[{phase:'admitting'},{phase:'ready'}],registration:[{registrations:{}},{registrations:{a:'event'}}],candidate:[{candidates:{}},{candidates:{a:{event:{}}}}],winner:[{}, {winner:{member:'a'}}],parentCompletion:[{phase:'ready'},{phase:'done'}],parentCursor:[{cursor:0},{cursor:1}]};
 const seen=new Set<string>();
 for(const [kind,[b,a]] of Object.entries(samples) as any){const before={operations:{[id]:b}},after={operations:{[id]:a}};assert.ok(classify('phi-spaces.federation-operations',before,after).includes(kind));assert.deepEqual(classify('phi-spaces.federation-operations',after,after),[]);seen.add(kind);}
 const commands:any={childAcceptance:[null,{id:'owned-child',state:'accepted',steps:[{state:'prepared'}]}],childInflight:[{id:'owned-child',state:'accepted',steps:[{state:'prepared'}]},{id:'owned-child',state:'applying',steps:[{state:'inflight'}]}],childCompletion:[{id:'owned-child',state:'applying',steps:[{state:'inflight'}]},{id:'owned-child',state:'completed',steps:[{state:'done'}]}]};
 for(const [kind,[b,a]] of Object.entries(commands) as any){assert.deepEqual(classify('phi-spaces.router-command',{command:b},{command:a}),[kind]);assert.deepEqual(classify('phi-spaces.router-command',{command:a},{command:a}),[]);seen.add(kind);}
 const reserved={future:{[budget]:{slots:12,bytesPerSlot:65536}}};assert.deepEqual(classify('phi-spaces.router-journal',{},reserved),['futureReservation']);assert.deepEqual(classify('phi-spaces.router-journal',reserved,{}),['futureRelease']);seen.add('futureReservation');seen.add('futureRelease');assert.deepEqual([...seen].sort(),[...JOURNAL_KINDS].sort());
});
