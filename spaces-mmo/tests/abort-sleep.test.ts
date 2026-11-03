// The sleep of the npc and world processes leaves no listener behind on the signal it listens to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { abortableSleep } from "../server/abort-sleep.ts";

test("a finished sleep removes its abort listener", async () => {
	const halt = new AbortController();
	await Promise.all(Array.from({ length: 200 }, () => abortableSleep(halt.signal, 1)));
	assert.equal(getEventListeners(halt.signal, "abort").length, 0);
});

test("an abort ends the sleep at once and leaves nothing behind", async () => {
	const halt = new AbortController();
	const sleeping = abortableSleep(halt.signal, 60_000);
	assert.equal(getEventListeners(halt.signal, "abort").length, 1);
	halt.abort();
	await sleeping;
	assert.equal(getEventListeners(halt.signal, "abort").length, 0);
});

test("a sleep on an aborted signal returns at once", async () => {
	const halt = new AbortController();
	halt.abort();
	await abortableSleep(halt.signal, 60_000);
});
