// A process that dies in the middle of a save (docs/zanzibar-agent-filesystem-plan.en.md, section 6.3, phase 3 exit
// evidence): it creates the tenant acme with lea and `f.txt` at version 1 ("one"), prints the session handle and an
// unused operation ID as one JSON line, then saves "two" over version 1 and kills itself with SIGKILL at the given
// fault point. The test reopens the same directories and checks what survived.
//
//   node --experimental-strip-types tests/support/crash-driver.ts <dataDir> <stateDir> <blobDir> <point>
import { FilesService, type FaultPoint } from "../../server/service.ts";

const [dataDir, stateDir, blobDir, point] = process.argv.slice(2) as [string, string, string, FaultPoint];
let armed = false;
const svc = await FilesService.open({
	dataDir, stateDir, blobDir, saveTxnLeaseMs: 300,
	faultHook: (p) => { if (armed && p === point) process.kill(process.pid, "SIGKILL"); },
});
await svc.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
const { handle } = await svc.login("acme", "user", { issuer: "i", subject: "lea" });
const [first, second] = await svc.issueOperationIds(handle, 2);
await svc.write(handle, "lea", "f.txt", Buffer.from("one"), 0, first);
process.stdout.write(JSON.stringify({ handle, opId: second }) + "\n");
armed = true;
await svc.write(handle, "lea", "f.txt", Buffer.from("two"), 1, second);
process.stdout.write("no crash\n");
await svc.close();
