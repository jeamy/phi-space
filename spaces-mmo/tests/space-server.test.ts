// SPACES_MMO_SPACE_SERVER: the switch to the Rust server, and that it never falls back (docs/rust-portierung.md, R3).
import test from "node:test";
import assert from "node:assert/strict";
import { spaceServer } from "../server/space-server.ts";

test("without the switch the space process is server/space-host.ts", () => {
	assert.equal(spaceServer({}), null);
	assert.equal(spaceServer({ SPACES_MMO_SPACE_SERVER: " " }), null);
});

test("the switch names the binary and its profile; one that is not there ends the start", () => {
	assert.deepEqual(spaceServer({ SPACES_MMO_SPACE_SERVER: process.execPath }), { command: process.execPath, args: ["--profile", "mmo"] });
	assert.throws(() => spaceServer({ SPACES_MMO_SPACE_SERVER: "/nonexistent/phi-space-server" }), /no such binary/);
});
