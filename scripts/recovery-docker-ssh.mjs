#!/usr/bin/env node
// The signed private service verifies operator/host roles; SSH fixes the container and recovery socket home.
import { spawn } from 'node:child_process';
const [hostId,container,home]=process.argv.slice(2);
if(process.env.SSH_ORIGINAL_COMMAND!=='phi-spaces-recovery'||!hostId||!/^phi-spaces-test-(host-a|host-b|member-1|member-2)-1$/.test(container||'')||!['/data/phase1b','/data/phase1b-restore-source','/data/phase1b-restore-target','/data/phase1b-control-source','/data/phase1b-control-target','/data/phase1b-control-member'].includes(home))throw new Error('recovery bridge target refused');
let input='',bytes=0;for await(const part of process.stdin){bytes+=part.length;if(bytes>256*1024)throw new Error('recovery request exceeds budget');input+=part.toString();}
const envelope=JSON.parse(input);if(envelope?.call?.hostId!==hostId)throw new Error('signed recovery host mismatch');
await new Promise((resolve,reject)=>{
 const child=spawn('docker',['exec','-i',container,'node',`${home}/federation-host.mjs`,'recovery-call',home],{stdio:['pipe','pipe','ignore']});let output=Buffer.alloc(0),done=false;
 const finish=error=>{if(done)return;done=true;clearTimeout(timer);child.kill();error?reject(error):(process.stdout.write(output),resolve());};const timer=setTimeout(()=>finish(new Error('recovery bridge timed out')),10000);
 child.on('error',finish);child.stdin.on('error',finish);child.stdout.on('data',data=>{output=Buffer.concat([output,data]);if(output.length>256*1024)finish(new Error('recovery reply exceeds budget'));});child.on('close',code=>finish(code?new Error('private recovery command failed'):undefined));child.stdin.end(input);
});
