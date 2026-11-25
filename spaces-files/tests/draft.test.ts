// The editor's draft (client/draft.ts; plan phase 4: a version conflict preserves the user's draft): no answer, refusal
// or conflict loses what the user typed, a lost reply is retried with its operation ID, and only a committed save moves
// the base.
import test from "node:test";
import assert from "node:assert/strict";
import { afterLostReply, afterSave, dirty, edit, openDraft, operationIdFor, rebase } from "../client/draft.ts";

test("a conflict keeps the draft and names the newer version; rebasing keeps the text", () => {
	let d = edit(openDraft("dispatch", "brief.md", "v3", 3), "lea's edit");
	assert.ok(dirty(d));
	d = afterSave(d, { error: "versionConflict", currentVersion: 4 });
	assert.equal(d.text, "lea's edit");
	assert.equal(d.baseVersion, 3);
	assert.equal(d.conflictVersion, 4);
	assert.match(d.status, /version 4/);
	d = rebase(d, "v4", 4);
	assert.deepEqual([d.text, d.baseVersion, d.conflictVersion], ["lea's edit", 4, null]);
	d = afterSave(d, { version: 5 });
	assert.deepEqual([d.text, d.baseText, d.baseVersion, dirty(d)], ["lea's edit", "lea's edit", 5, false]);
});

test("refusals keep the draft", () => {
	for (const error of ["notFound", "permissionDenied", "unauthenticated", "capacityExceeded"]) {
		const d = afterSave(edit(openDraft("w", "f", "a", 1), "b"), { error });
		assert.equal(d.text, "b", error);
		assert.equal(d.baseVersion, 1, error);
		assert.match(d.status, /draft is kept/, error);
	}
});

test("a lost reply: the same text goes out with the same operation ID, changed text with a fresh one", async () => {
	let d = edit(openDraft("w", "f", "a", 1), "b");
	d = afterLostReply(d, "o1.lost", "b");
	assert.equal(await operationIdFor(d, async () => "o1.fresh"), "o1.lost");
	assert.equal(await operationIdFor(edit(d, "c"), async () => "o1.fresh"), "o1.fresh");
	d = afterSave(d, { version: 2 });
	assert.equal(await operationIdFor(d, async () => "o1.fresh"), "o1.fresh");
});
