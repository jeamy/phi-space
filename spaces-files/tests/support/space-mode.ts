// Runs the suite against a Space process of its own (docs/zanzibar-agent-filesystem-plan.en.md, section 8): loaded
// with `--import` (through NODE_OPTIONS, so the drivers the tests start load it too), it points every FilesService.open
// that names no Space process at the one FILES_SPACE_SERVER names: `ts` for server/space-host.ts, or the path of a
// binary with the same command line (the Rust one). Without the variable it changes nothing.
import { fileURLToPath } from "node:url";
import { FilesService } from "../../server/service.ts";

const v = process.env.FILES_SPACE_SERVER;
if (v) FilesService.defaultSpaceProcess = v === "ts"
	? [process.execPath, "--no-warnings", "--experimental-strip-types", fileURLToPath(new URL("../../server/space-host.ts", import.meta.url))]
	: [v];
