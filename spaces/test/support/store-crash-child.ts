// The child of the crash tests (test/test-own-store.test.ts): opens the own SQLite store at argv[2] and commits until it
// is killed. Every commit writes a pair of entries (the same `i`, halves 0 and 1; `i` counts from argv[3]); once a commit
// is acknowledged it prints "ACK <i>". Eight commits are in flight at a time, so batches hold several.
import { BACKGROUND_CONTEXT as ctx, FOREVER, Space, core } from "../../src/index.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";

const host = await openSqliteHost(process.argv[2]!);
process.stdout.write("OPEN\n");
let next = Number(process.argv[3] ?? 0);
await Promise.all(Array.from({ length: 8 }, async () => {
	for (;;) {
		const i = next++;
		await host.commit(async (tx) => {
			const s = await tx.doc(Space) as core.SpaceState, now = Date.now();
			for (const half of [0, 1]) core.write(s, now, { type: "Pair", fields: { i, half } }, null, FOREVER);
		}, ctx);
		process.stdout.write(`ACK ${i}\n`);
	}
}));
