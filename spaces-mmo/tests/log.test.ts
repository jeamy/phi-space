// The game log (client/log.ts): the same error twice in a row shows once; everything else is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLine, LOG_LINES } from "../client/log.ts";

const line = (kind: string, text: string) => ({ kind, text });

test("the same error in a row shows once", () => {
	let log: Array<{ kind: string; text: string }> = [];
	for (let i = 0; i < 9; i++) log = appendLine(log, line("error", "Da geht es nicht weiter."));
	assert.equal(log.length, 1);
});

test("a different line in between, or another kind, keeps both", () => {
	let log = appendLine([], line("error", "Da geht es nicht weiter."));
	log = appendLine(log, line("info", "Die Flut spült Treibholz an."));
	log = appendLine(log, line("error", "Da geht es nicht weiter."));
	assert.equal(log.length, 3);
	log = appendLine(log, line("say", "hallo"));
	log = appendLine(log, line("say", "hallo"));
	assert.equal(log.length, 5, "only errors are folded");
});

test("the log keeps the last lines", () => {
	let log: Array<{ kind: string; text: string }> = [];
	for (let i = 0; i < LOG_LINES + 20; i++) log = appendLine(log, line("say", `z${i}`));
	assert.equal(log.length, LOG_LINES);
	assert.equal(log.at(-1)!.text, `z${LOG_LINES + 19}`);
});
