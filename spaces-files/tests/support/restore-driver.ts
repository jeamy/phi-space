// A restore that dies at one of its journal steps (docs/zanzibar-agent-filesystem-plan.en.md, section 6.5; phase 5
// exit evidence: restart at each restore step): runs restoreData and kills itself with SIGKILL right after the given
// step was journaled. The test resumes the restore in its own process and checks the outcome.
//
//   node --experimental-strip-types tests/support/restore-driver.ts <dataDir> <stateDir> <blobDir> <archive> <keyFile> <step>
import { readBackupKey } from "../../server/archive.ts";
import { restoreData, type RestoreStep } from "../../server/backup.ts";

const [dataDir, stateDir, blobDir, archive, keyFile, step] = process.argv.slice(2) as [string, string, string, string, string, RestoreStep];
await restoreData(archive, readBackupKey(keyFile), { dataDir, stateDir, blobDir }, (s) => { if (s === step) process.kill(process.pid, "SIGKILL"); });
process.stdout.write("no crash\n");
