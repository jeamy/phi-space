#!/usr/bin/env node
// Forced command for the existing testbed: all identifiers are pinned by authorized_keys, never selected by the caller.
import { execFileSync } from 'node:child_process';
const [hostId,unit,container,home]=process.argv.slice(2),command=process.env.SSH_ORIGINAL_COMMAND;
if(!hostId||!/^[A-Za-z0-9_.@-]+\.service$/.test(unit||'')||!/^pi-spaces-test-(host-a|host-b|member-1|member-2)-1$/.test(container||'')||!['/data/phase1b','/data/phase1b-restore-source','/data/phase1b-restore-target','/data/phase1b-control-source','/data/phase1b-control-target','/data/phase1b-control-member'].includes(home)||!['pi-spaces-fence','pi-spaces-fence-status'].includes(command))throw new Error('testbed fencing command refused');
const run=(program,args)=>execFileSync(program,args,{timeout:20000,encoding:'utf8',stdio:['ignore','pipe','ignore']});
if(command==='pi-spaces-fence'){
 const locked=JSON.parse(run('docker',['exec',container,'node',`${home}/federation-host.mjs`,'fence',home]));
 if(!locked.restartLocked||!locked.normalStopped)throw new Error('normal container runtime is not fenced');
 run('systemctl',['--user','stop',unit]);
}
const state=JSON.parse(run('docker',['exec',container,'node',`${home}/federation-host.mjs`,'status',home]));
const unitInfo=Object.fromEntries(run('systemctl',['--user','show',unit,'--property=LoadState,ActiveState,MainPID,ControlPID,KillMode']).trim().split('\n').map(line=>line.split('=')));
const stopped=unitInfo.LoadState==='loaded'&&['inactive','failed'].includes(unitInfo.ActiveState)&&unitInfo.MainPID==='0'&&unitInfo.ControlPID==='0'&&unitInfo.KillMode==='control-group'&&state.normalStopped===true;
process.stdout.write(JSON.stringify({hostId,restartLocked:state.restartLocked===true,stopped}));
