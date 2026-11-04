// The counterpart of power-loss-probe.ts on the space's own store, with the same arguments, lines and failures, so a
// comparison changes nothing but the store. --backend own commits the same document, --backend space writes entries
// through PhiSpaces. strong is synchronous=FULL (the default), weak is NORMAL. Runs without pi-durable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx, FOREVER, NO_WAIT, PhiSpaces, openSqliteHost } from "../../src/index.ts";
import { defineDoc } from "../../src/store/documents.ts";

const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const mode = process.argv[2], backend = arg("--backend"), profile = arg("--profile"), id = arg("--run-id"), directory = arg("--dir");
assert.ok(mode === "write" || mode === "verify", "mode: write or verify");
assert.ok(backend === "own" || backend === "space", "--backend own|space is required");
assert.ok(profile === "strong" || profile === "weak", "--profile strong|weak is required");
assert.ok(id && /^[a-zA-Z0-9_-]{8,80}$/.test(id), "provide a fresh --run-id of 8-80 safe characters");
assert.ok(directory, "--dir is required; never use production state");
const dir = resolve(directory), marker = join(dir, ".power-loss-probe.json"), file = join(dir, "space.sqlite");
const identity = { version: 1, id, backend, profile };
if (mode === "write") {
	mkdirSync(dir, { recursive: true });
	assert.equal(readdirSync(dir).length, 0, "write mode refuses any nonempty directory");
	writeFileSync(marker, JSON.stringify(identity), { flag: "wx", flush: true });
} else {
	assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), identity, "not this probe's disposable state");
	assert.ok(existsSync(file), "missing store");
}

const State = defineDoc<{ id: string | null; n: number; digest: string }>({
	kind: "phi-spaces.power-loss-probe", version: 1,
	initial: () => ({ id: null, n: 0, digest: "" }),
});
const digest = (n: number) => createHash("sha256").update(`${id}:${n}:${"probe".repeat(1024)}`).digest("hex");
const host = await openSqliteHost(file, { synchronous: profile === "strong" ? "FULL" : "NORMAL" });
const space = new PhiSpaces(host, ctx);

if (mode === "verify") {
	const ack = Number(arg("--ack"));
	assert.ok(Number.isSafeInteger(ack) && ack > 0, "--ack must be the highest acknowledgement observed by the controlling host");
	let persisted: number;
	if (backend === "own") {
		const value = await host.snapshot(State, ctx);
		assert.ok(value, "the acknowledged document was lost");
		assert.equal(value.id, id, "the acknowledged run identity was lost");
		assert.ok(value.n >= ack, `lost acknowledged commits: durable=${value.n}, acknowledged=${ack}`);
		assert.equal(value.digest, digest(value.n), "document contents are inconsistent");
		persisted = value.n;
	} else {
		// Each acknowledged entry by itself: an unacknowledged one that survived must not cover for a lost one.
		for (let n = 1; n <= ack; n++) {
			const entry = await space.read({ type: "Probe", fields: { n } }, NO_WAIT);
			assert.ok(entry, `lost acknowledged commits: entry ${n} is missing`);
			assert.equal(entry.fields.digest, digest(n), "entry contents are inconsistent");
		}
		persisted = await space.count({ type: "Probe" });
	}
	await host.close(ctx);
	const db = new DatabaseSync(file, { readOnly: true });
	try { assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); }
	finally { db.close(); }
	console.log(JSON.stringify({ kind: "verified", id, backend, profile, acknowledged: ack, persisted }));
} else {
	const count = Number(arg("--commits") ?? 100_000), writers = Number(arg("--writers") ?? 1);
	let next = 0, acknowledged = 0;
	const done = new Set<number>();
	// n is claimed before the commit, so with several writers it counts only once all below it are done
	const emit = async (n: number, start: number) => {
		done.add(n);
		while (done.delete(acknowledged + 1)) acknowledged++;
		const line = JSON.stringify({ kind: "ack", id, backend, profile, n: acknowledged, ms: performance.now() - start, t: Date.now() });
		if (!process.stdout.write(`${line}\n`)) await once(process.stdout, "drain");
	};
	await Promise.all(Array.from({ length: writers }, async () => {
		while (next < count) {
			const start = performance.now();
			let n = 0;
			if (backend === "own") {
				await host.commit(async tx => {
					const value = await tx.doc(State);
					n = value.n + 1; value.id = id; value.n = n; value.digest = digest(n);
				}, ctx);
				next = n;
			} else {
				n = ++next;
				await space.write({ type: "Probe", fields: { n, digest: digest(n) } }, null, FOREVER);
			}
			await emit(n, start);
		}
	}));
	// Do not turn the power-loss scenario into a graceful database close.
	setInterval(() => {}, 60_000);
	await new Promise(() => {});
}
