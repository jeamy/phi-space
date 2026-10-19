// Plain-text test cases are turned into JSON.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCases } from "../client/lib/cases.ts";

test("JSON stays as it is", () => {
	assert.deepEqual(parseCases('[{"args":[2],"expect":4},{"args":[5],"expect":10}]'), [{ args: [2], expect: 4 }, { args: [5], expect: 10 }]);
	assert.deepEqual(parseCases('{"args":[1,2],"expect":3}'), [{ args: [1, 2], expect: 3 }]);
});

test("the example: a result without input", () => {
	assert.deepEqual(parseCases("Ergebnis: 0 1 4 9 11"), [{ args: [], expect: [0, 1, 4, 9, 11] }]);
	assert.deepEqual(parseCases("Result: 0, 1, 4, 9, 11"), [{ args: [], expect: [0, 1, 4, 9, 11] }]);
	assert.deepEqual(parseCases("0 1 4 9 11"), [{ args: [], expect: [0, 1, 4, 9, 11] }]);
	assert.deepEqual(parseCases("[0,1,4,9,11]"), [{ args: [], expect: [0, 1, 4, 9, 11] }]); // other JSON values are a result
});

test("inputs with arrows and on separate lines", () => {
	assert.deepEqual(parseCases("5 -> 120"), [{ args: [5], expect: 120 }]);
	assert.deepEqual(parseCases("3 4 => 12\n10 5 → 50"), [{ args: [3, 4], expect: 12 }, { args: [10, 5], expect: 50 }]);
	assert.deepEqual(parseCases("[3,1,2] -> [1,2,3]"), [{ args: [[3, 1, 2]], expect: [1, 2, 3] }]); // a JSON array is one argument
	assert.deepEqual(parseCases("Eingabe: 3 4\nErgebnis: 12\nEingabe: 2 2\nErgebnis: 4"), [{ args: [3, 4], expect: 12 }, { args: [2, 2], expect: 4 }]);
	assert.deepEqual(parseCases("Eingabe: 5 -> Ergebnis: 120"), [{ args: [5], expect: 120 }]);
});

test("several right results: oder / or / |", () => {
	assert.deepEqual(parseCases("Eingabe: 5 11\nErgebnis: [0,1,4,9,11] oder [0,2,7,10,11]"), [{ args: [5, 11], expectAny: [[0, 1, 4, 9, 11], [0, 2, 7, 10, 11]] }]);
	assert.deepEqual(parseCases("4 -> 2 or -2"), [{ args: [4], expectAny: [2, -2] }]);
	assert.deepEqual(parseCases("x -> a | b | c"), [{ args: ["x"], expectAny: ["a", "b", "c"] }]);
	assert.deepEqual(parseCases('1 -> "this or that"'), [{ args: [1], expect: "this or that" }]); // one JSON string
	assert.deepEqual(parseCases('[{"args":[4],"expectAny":[2,-2]}]'), [{ args: [4], expectAny: [2, -2] }]);
});

test("input lines alone are calls without a fixed result (for a check rule)", () => {
	assert.deepEqual(parseCases("Eingabe: 5 11\nInput: 4 6"), [{ args: [5, 11] }, { args: [4, 6] }]);
	assert.deepEqual(parseCases('[{"args":[5,11]}]'), [{ args: [5, 11] }]);
});

test("single values: numbers, booleans, text", () => {
	assert.deepEqual(parseCases("Ergebnis: 42"), [{ args: [], expect: 42 }]);
	assert.deepEqual(parseCases("true"), [{ args: [], expect: true }]);
	assert.deepEqual(parseCases("hallo -> hello world"), [{ args: ["hallo"], expect: "hello world" }]);
});

test("empty input and comment lines", () => {
	assert.equal(parseCases(""), null);
	assert.equal(parseCases("   \n  "), null);
	assert.equal(parseCases("# nothing"), null);
	assert.deepEqual(parseCases("# note\n7 -> 49"), [{ args: [7], expect: 49 }]);
});
