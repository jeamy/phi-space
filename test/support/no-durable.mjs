// `node --import ./test/support/no-durable.mjs …`: every import of pi-durable, chord or pi-ai fails, in this thread and
// in worker threads (the SQLite writer). The U3 acceptance runs the standalone service and its clients under it, so they
// are shown to need none of them (docs/umstellung-ohne-pi-durable.md, U3).
import { register } from "node:module";

const hooks = `
const blocked = /^@earendil-works\\/(pi-durable|chord|pi-ai)(\\/|$)/;
export async function resolve(specifier, context, next) {
	if (blocked.test(specifier)) throw new Error("blocked by no-durable.mjs: " + specifier);
	return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
