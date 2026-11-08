// What goes from one region to another (server/engine/transfer.ts): moveThings moves things in steps, written there
// first, and a try that died in between is finished by the next without writing a thing twice; carryOne holds the order
// in A's transaction, so an order whose steps fail is back for the next try and gone once they went through.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { FOREVER, PhiSpaces, openOwnMemoryHost, type SpaceLike } from "phi-spaces";
import { BACKGROUND_CONTEXT } from "phi-spaces/context";
import { carryOne, moveThings, THINGS_PER_STEP, type Carrier } from "../server/engine/transfer.ts";

const space = () => new PhiSpaces(openOwnMemoryHost(), BACKGROUND_CONTEXT);
const put = (s: SpaceLike, itemId: string, location: string, proto = "muschel") => s.write({ type: "Item", fields: { itemId, proto, name: proto, location, x: -1, y: -1 } }, null, FOREVER);
const at = async (s: SpaceLike, location: string) => (await s.readAll({ type: "Item", fields: { location } })).map((e) => String(e.fields.itemId)).sort();
const ids = (n: number, p = "i") => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, "0")}`).sort();

test("moveThings: more than a step's worth, each thing once; a try that died after writing is finished without doubles", async () => {
	const a = space(), b = space();
	const n = THINGS_PER_STEP * 2 + 7;
	for (const id of ids(n)) await put(a, id, "char-1");
	// an earlier try wrote five of them into B and died before it took them in A
	for (const id of ids(n).slice(0, 5)) await put(b, id, "char-1");
	assert.equal(await moveThings(a, b, "char-1", "char-1"), n - 5);
	assert.deepEqual(await at(a, "char-1"), []);
	assert.deepEqual(await at(b, "char-1"), ids(n));
	assert.equal(await moveThings(a, b, "char-1", "char-1"), 0, "nothing left: a second call does nothing");
});

test("moveThings: into another place they lie loose there; with `anywhere` one taken out in B since is not written again", async () => {
	const a = space(), b = space();
	for (const id of ids(3)) await put(a, id, "cou-1");
	// an earlier try got one into the chest, and its owner has already taken it out
	await put(b, "i000", "char-owner");
	assert.equal(await moveThings(a, b, "cou-1", "hut-1", { anywhere: true }), 2);
	assert.deepEqual(await at(b, "hut-1"), ["i001", "i002"]);
	assert.deepEqual(await at(b, "char-owner"), ["i000"]);
	assert.deepEqual(await at(a, "cou-1"), []);
	const one = (await b.readAll({ type: "Item", fields: { itemId: "i001" } }))[0]!.fields;
	assert.deepEqual([one.location, one.x, one.y], ["hut-1", -1, -1]);
});

test("moveThings: what a holder holds goes first and keeps its holder's id as its place", async () => {
	const a = space(), b = space();
	await put(a, "boat-1", "char-1", "kahn");
	await put(a, "fish-1", "boat-1", "hering");
	await put(a, "fish-2", "boat-1", "hering");
	await put(a, "shell-1", "char-1");
	assert.equal(await moveThings(a, b, "char-1", "char-1", { holders: ["kahn"] }), 4);
	assert.deepEqual(await at(b, "boat-1"), ["fish-1", "fish-2"]);
	assert.deepEqual(await at(b, "char-1"), ["boat-1", "shell-1"]);
	assert.equal((await a.readAll({ type: "Item" })).length, 0);
});

test("carryOne: an order whose steps fail is back for the next try; once they go through it is gone", async () => {
	const a = space(), b = space();
	await a.write({ type: "Parcel", fields: { parcelId: "p1", to: "b", from: "par-1" } }, null, FOREVER);
	for (const id of ids(4)) await put(a, id, "par-1");
	let fail = true;
	const parcels: Carrier<{ parcelId: string; to: string; from: string }> = {
		type: "Parcel", name: "parcel", to: (f) => f.to,
		async carry(here, there, f) {
			await moveThings(here, there, f.from, "box-1", { anywhere: true });
			if (fail) throw new Error("the worker dies");
		},
	};
	const regions = new Map([["b", b as SpaceLike]]);
	const order = async () => (await a.readAll({ type: "Parcel" }))[0]!;
	await assert.rejects(carryOne(a, regions, parcels, await order()), /dies/);
	assert.equal((await a.readAll({ type: "Parcel" })).length, 1, "the order is back");
	fail = false;
	await carryOne(a, regions, parcels, await order());
	assert.equal((await a.readAll({ type: "Parcel" })).length, 0);
	assert.deepEqual(await at(b, "box-1"), ids(4));
	assert.equal((await b.readAll({ type: "Item" })).length, 4, "nothing twice");
	// an order without an address for its region stays where it is
	await a.write({ type: "Parcel", fields: { parcelId: "p2", to: "nowhere", from: "par-2" } }, null, FOREVER);
	await assert.rejects(carryOne(a, regions, parcels, await order()), /no address for the region nowhere/);
	assert.equal((await a.readAll({ type: "Parcel" })).length, 1);
});
