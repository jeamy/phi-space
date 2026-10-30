// The core over the own store (docs/rust-portierung.md, R2): the lines of core-driver.ts, each one a commit of a Space
// document through the TypeScript store host, as the service runs operations (a fresh draft per commit, rolled back
// when the operation throws, the claims a map part on the disk once the document is stored). rust/phi-store's tests
// run the same lines through the Rust host and compare answers, state hashes and the rows of both files.
//
//   node --experimental-strip-types --no-warnings test/support/store-driver.ts
//
// In: core-driver.ts lines; `init` also takes `file` (a store file to create; absent: a store in memory). The line
// {"op": "close"} closes the store (its file can then be read). Out: as core-driver.ts.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as core from "../../src/core.ts";
import { digestJson } from "../../src/canonical.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { NamedSpace } from "../../src/spaces.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { openOwnMemoryHost, type OwnStoreHost } from "../../src/store/host.ts";
import { apply, install, reseed, tick, type Line } from "./core-driver.ts";
import type { Json } from "../../src/core.ts";

/** The key of the document the lines work on. */
export const KEY = "sp-walk";
let host: OwnStoreHost | null = null;
/** The host whose entry snapshots `snapshotPage` reads (snapshot.ts); a new one with every init. */
let snapshots = {};

const failure = (e: unknown) => ({ ok: false, error: (e as Error).constructor?.name ?? "Error", message: (e as Error).message });

/** The committed document as plain JSON (the claims read from the disk). */
async function committed(): Promise<Json> { return core.plain(((await host!.snapshot(NamedSpace, KEY, ctx)) ?? null) as unknown as Json); }
async function hash(): Promise<string> { return digestJson(await committed()); }

export async function step(l: Line): Promise<Record<string, unknown>> {
	if (l.op === "init") {
		await host?.close(ctx);
		reseed(String(l.seed ?? ""), l.now ?? 0);
		snapshots = {};
		host = typeof l.file === "string" ? await openSqliteHost(l.file) : openOwnMemoryHost();
		await host.commit(async (tx) => {
			const s = await tx.doc(NamedSpace, KEY, null);
			if (l.spaceId !== undefined) s.spaceId = l.spaceId;
			if (l.incarnation !== undefined) s.incarnation = l.incarnation;
			if (l.limits) s.limits = l.limits;
		}, ctx);
		return { ok: true, result: null, state: await hash() };
	}
	if (l.op === "close") { await host?.close(ctx); host = null; return { ok: true, result: null }; }
	tick(l);
	let out: Record<string, unknown>;
	try {
		const result = await host!.commit(async (tx) => {
			const s = await tx.doc(NamedSpace, KEY, null);
			core.beginCommit(s);
			return core.plain((apply(l, s, snapshots) ?? null) as Json);
		}, ctx);
		out = { ok: true, result };
	} catch (e) { out = failure(e); }
	const doc = await committed();
	out.state = digestJson(doc);
	if (l.dump) out.dump = doc;
	return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	install();
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	// one line after the other: each waits for the commit before it
	let chain = Promise.resolve();
	rl.on("line", (text) => {
		if (!text.trim()) return;
		chain = chain.then(async () => {
			let reply: Record<string, unknown>;
			try { reply = await step(JSON.parse(text) as Line); } catch (e) { reply = { ...failure(e), error: "DriverError" }; }
			process.stdout.write(JSON.stringify(reply) + "\n");
		});
	});
	rl.on("close", () => { chain = chain.then(async () => { await host?.close(ctx); }); });
}
