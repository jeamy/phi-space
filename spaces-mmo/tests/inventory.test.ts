// The names of several things (server/engine/context.ts pluralOf): what `inventory` says.
import test from "node:test";
import assert from "node:assert/strict";
import { pluralOf } from "../server/engine/context.ts";

test("several things are named as German names them, stuffs stay", () => {
	const plural = (n: string) => pluralOf(n);
	assert.deepEqual(["Muschel", "Münze", "Kartoffel", "Perle"].map(plural), ["Muscheln", "Münzen", "Kartoffeln", "Perlen"]);
	assert.deepEqual(["Treibholz", "Tang", "Wolle", "Ziegel", "Holzbündel", "Spaten"].map(plural), ["Treibholz", "Tang", "Wolle", "Ziegel", "Holzbündel", "Spaten"]);
	assert.deepEqual(["Ei", "Tuch", "Kanne Wasser"].map(plural), ["Eier", "Tücher", "Kannen Wasser"]);
});
