// Offline physical-history maintenance for an explicitly fenced owned testbed home.
import {join} from 'node:path';
import {openSync,writeFileSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {privateFile,TlsRecoveryRegister,compactErasedSqlite} from '../../src/index.ts';
const [home]=process.argv.slice(2);if(!home||!existsSync(join(home,'restart.lock')))throw Error('restart-locked owned home required');
const cfg=JSON.parse(privateFile(join(home,'federation.json')).toString()),lock=join(home,'owner.lock'),fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,mode:'erase-compact'})+'\n');closeSync(fd);const external=new TlsRecoveryRegister(cfg.registerTls);
const fenced=async()=>{const b=await external.get<any>('boot:'+cfg.hostId),owner=JSON.parse(privateFile(lock).toString());if(owner.pid!==process.pid||owner.mode!=='erase-compact'||!b||b.value.hostId!==cfg.hostId||b.value.state!=='fenced'||Object.values(b.value.spaces).some((p:any)=>p.authorityId!==cfg.authorityId))throw Error('exclusive independent host fence required');};
try{console.log(JSON.stringify(await compactErasedSqlite(join(home,'harness.sqlite'),fenced)));}finally{external.close();unlinkSync(lock);}
