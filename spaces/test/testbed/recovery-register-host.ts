// Isolated operator-owned register process. Does not touch the existing shared register.
import {join} from 'node:path';
import {openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {privateFile,SqliteRecoveryRegister,serveTlsRegister} from '../../src/index.ts';
const [home]=process.argv.slice(2);if(!home)throw Error('private register home required');
const config=JSON.parse(privateFile(join(home,'register.json')).toString());
if(!config.listen||!Number.isSafeInteger(config.listen.port)||config.listen.port<1024||config.listen.port>65535||!config.peers||!config.tls)throw Error('explicit isolated register provisioning required');
const lock=join(home,'owner.lock'),fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,mode:'isolated-register'})+'\n');closeSync(fd);
let db:SqliteRecoveryRegister|undefined,server:Awaited<ReturnType<typeof serveTlsRegister>>|undefined;
try {
 db=new SqliteRecoveryRegister(join(home,'register.sqlite'));
 server=await serveTlsRegister(db,{...config.listen,...config.tls,peers:config.peers});
 console.log(JSON.stringify({registerReady:true,address:server.address(),freshTlsPerBatch:true}));
 await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
} finally {await server?.close();db?.close();unlinkSync(lock);}
