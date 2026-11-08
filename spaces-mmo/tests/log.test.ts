// The game log (client/log.ts): the same error twice in a row shows once; everything else is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendLine, isForMe, LOG_LINES } from "../client/log.ts";

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

test("coming and going is told apart from the rest of the log", async () => {
	const { isComing } = await import("../client/log.ts");
	for (const t of ["Strandläufer-5535 geht nach ost.", "Strandläufer-3559 kommt an.", "Kai kommt mit dem Kahn an.", "Du gehst nach möwenfels.", "Du kommst an."]) assert.ok(isComing(line("info", t)), t);
	for (const t of ["Die Flut spült Treibholz an.", "Bo: ich geht nach ost.", "Kai legt Treibholz ins Feuer."]) assert.ok(!isComing(line(t.startsWith("Bo") ? "say" : "info", t)), t);
});

test("the events in two parts: what is for the own figure, and what happens around it", () => {
	for (const l of [{ kind: "echo" }, { kind: "hint" }, { kind: "error" }, { kind: "info", mine: true as const }, { kind: "say", toMe: true as const }]) assert.equal(isForMe(l), true, JSON.stringify(l));
	for (const l of [{ kind: "say" }, { kind: "world" }, { kind: "info" }, { kind: "system" }]) assert.equal(isForMe(l), false, JSON.stringify(l));
});

test("log: the count of a part since the last line looked at; \"An dich\" counts only what others said or offered", async () => {
	const { newSince } = await import("../client/log.ts");
	const answer = () => ({ kind: "info", mine: true as const }), offer = { kind: "info", mine: true as const, toMe: true as const }, whisper = { kind: "say", toMe: true as const };
	const list = [answer(), offer, answer(), whisper, answer()];
	assert.equal(newSince(list, undefined), 0, "never looked: nothing new yet");
	assert.equal(newSince(list, list[0]), 4);
	assert.equal(newSince(list, list[0], { toMe: true }), 2, "the offer and the whisper, not the answers");
	assert.equal(newSince(list, list[3], { toMe: true }), 0);
	assert.equal(newSince(list, null, { toMe: true }), 2, "looked when the part was empty: all of it");
	assert.equal(newSince(list, answer()), 5, "a line no longer kept: all of it");
});
