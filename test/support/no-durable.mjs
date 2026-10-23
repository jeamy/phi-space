// `node --import ./test/support/no-durable.mjs …`: every import of pi-durable, chord or pi-ai from this repository's own
// files fails, in this thread and in worker threads (the SQLite writer). The U3 acceptance runs the standalone service
// and its clients under it, so they are shown to need none of them (docs/umstellung-ohne-pi-durable.md, U3).
// Packages from elsewhere (the mobile runtime's pi-server and pi-client, which a test loads from its checkout) may use
// their own dependencies: only an import whose importer is a file of this repository outside node_modules is refused.
import { register } from "node:module";

const hooks = `
const blocked = /^@earendil-works\\/(pi-durable|chord|pi-ai)(\\/|$)/;
let root = "";
export async function initialize(data) { root = data.root; }
export async function resolve(specifier, context, next) {
	const parent = context.parentURL ?? "";
	const ours = !parent || (parent.startsWith(root) && !parent.includes("/node_modules/"));
	if (ours && blocked.test(specifier)) throw new Error("blocked by no-durable.mjs: " + specifier);
	return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, { data: { root: new URL("../../", import.meta.url).href } });
