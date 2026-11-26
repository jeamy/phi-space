// FORUM_SPACE_SERVER: the switch to the Rust server, and that it never falls back (docs/rust-portierung.en.md, R3).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spaceServer } from "../server/space-server.ts";

test("without the switch the space process is server/space-host.ts", () => {
	assert.equal(spaceServer({}), null);
	assert.equal(spaceServer({ FORUM_SPACE_SERVER: " " }), null);
});

test("the switch names the binary; one that is not there ends the start", () => {
	assert.deepEqual(spaceServer({ FORUM_SPACE_SERVER: process.execPath }), { command: process.execPath, args: [] });
	assert.throws(() => spaceServer({ FORUM_SPACE_SERVER: "/nonexistent/forum-space" }), /no such binary/);
});

test("the generic server is refused with the name of the project's binary", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "forum-space-server-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const old = join(dir, "phi-space-server");
	writeFileSync(old, "");
	assert.throws(() => spaceServer({ FORUM_SPACE_SERVER: old }), /generic server.*forum-space/);
});
