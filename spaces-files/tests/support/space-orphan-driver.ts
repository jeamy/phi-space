// A service with its Space process that the test kills with SIGKILL (tests/space-process.test.ts): it creates the
// tenant acme, prints `space <pid>` and waits.
//
//   node --experimental-strip-types tests/support/space-orphan-driver.ts <dataDir> <stateDir> <blobDir> <command as JSON>
import { FilesService } from "../../server/service.ts";

const [dataDir, stateDir, blobDir, command] = process.argv.slice(2) as [string, string, string, string];
const svc = await FilesService.open({ dataDir, stateDir, blobDir, spaceProcess: JSON.parse(command) as string[] });
await svc.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
process.stdout.write(`space ${svc.store.pid}\n`);
setInterval(() => {}, 1 << 30);
