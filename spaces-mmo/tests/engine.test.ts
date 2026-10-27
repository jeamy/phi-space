// The pure parts of the Phase 1 engine: lock strings, the FuncParser, command set merging, typeclass chains.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, LockError, parseLocks, type LockCtx } from "../server/engine/locks.ts";
import { render } from "../server/engine/funcparser.ts";
import { merge, type Command } from "../server/engine/cmdsets.ts";
import { typeChain } from "../server/engine/typeclasses.ts";

const who = (o: Partial<LockCtx> = {}): LockCtx => ({ level: "Player", guest: false, charId: "c-1", holds: () => false, ...o });

test("lock strings: functions, not/and/or, parentheses; a missing access type is allowed", () => {
	const locks = "get:all();give:not guest();traverse:perm(Builder) or holds(schluessel);use:(id(c-1) or perm(Admin)) and not guest();none:none()";
	assert.equal(allowed(locks, "get", who({ guest: true, level: "Guest" })), true);
	assert.equal(allowed(locks, "give", who({ guest: true, level: "Guest" })), false);
	assert.equal(allowed(locks, "give", who()), true);
	assert.equal(allowed(locks, "traverse", who()), false);
	assert.equal(allowed(locks, "traverse", who({ level: "Builder" })), true);
	assert.equal(allowed(locks, "traverse", who({ level: "Admin" })), true, "levels are a hierarchy");
	assert.equal(allowed(locks, "traverse", who({ holds: (k) => k === "schluessel" })), true);
	assert.equal(allowed(locks, "use", who()), true);
	assert.equal(allowed(locks, "use", who({ charId: "c-2" })), false);
	assert.equal(allowed(locks, "use", who({ charId: "c-2", level: "Admin" })), true);
	assert.equal(allowed(locks, "none", who({ level: "Admin" })), false);
	assert.equal(allowed(locks, "drop", who()), true, "no lock for drop");
	assert.equal(allowed("GET:ALL()", "get", who()), true, "case does not matter");
});

test("lock strings are parsed, never evaluated: anything outside the grammar is refused with a reason", () => {
	for (const bad of ["get:constructor()", "get:process.exit()", "get:all", "get:perm()", "get:perm(Gott)", "get:all() or", "get:(all()", "get:all() all()", "get all()", "x y:all()", "get:id()", "get:all(1)", "a".repeat(501)]) {
		assert.throws(() => parseLocks(bad), LockError, bad);
		assert.equal(allowed(bad, "get", who({ level: "Admin" })), false, `a broken stored lock denies: ${bad}`);
	}
	assert.doesNotThrow(() => parseLocks(""));
	assert.match((() => { try { parseLocks("get:hack()"); return ""; } catch (e) { return (e as Error).message; } })(), /unbekannte Funktion/);
});

test("FuncParser: $you() and $conj(a|b) render for the actor and for everyone else", () => {
	const t = "$you() $conj(hebst|hebt) die Münze auf. Dann $conj(gehst|geht) $you() weiter.";
	assert.equal(render(t, { viewer: "c-1", actor: "c-1", actorName: "Mira" }), "Du hebst die Münze auf. Dann gehst du weiter.");
	assert.equal(render(t, { viewer: "c-2", actor: "c-1", actorName: "Mira" }), "Mira hebt die Münze auf. Dann geht Mira weiter.");
	assert.equal(render("$you() $conj(kaputt) $other(x)", { viewer: "c-2", actor: "c-1", actorName: "Mira" }), "Mira $conj(kaputt) $other(x)", "unknown or malformed calls stay");
});

test("command sets merge by priority: Union adds and overrides, Replace drops what is below, Remove takes names out", () => {
	const cmd = (key: string, tag: string, aliases: string[] = []): Command => ({ key, aliases, help: tag, func: async () => {} });
	const m = merge([
		{ key: "exits", priority: 10, mergeType: "Union", commands: [cmd("look", "exit-look")] },
		{ key: "default", priority: 0, mergeType: "Union", commands: [cmd("look", "default-look", ["l"]), cmd("say", "say")] },
	]);
	assert.equal(m.get("look")!.help, "exit-look", "the higher priority wins a shared name");
	assert.equal(m.get("l")!.help, "default-look", "an alias it does not override stays");
	assert.equal(m.get("say")!.help, "say");
	const r = merge([
		{ key: "default", priority: 0, mergeType: "Union", commands: [cmd("look", "a"), cmd("say", "b")] },
		{ key: "dark", priority: 5, mergeType: "Replace", commands: [cmd("feel", "c")] },
		{ key: "mute", priority: 6, mergeType: "Remove", commands: [cmd("feel", "")] },
	]);
	assert.deepEqual([...r.keys()], []);
});

test("typeclasses: a type and its supertypes, world classes below the engine's, cycles and unknowns refused", () => {
	assert.deepEqual(typeChain("Coin", { Coin: "Item" }), ["Coin", "Item", "Object"]);
	assert.deepEqual(typeChain("Exit"), ["Exit", "Object"]);
	assert.throws(() => typeChain("Drache"), /unbekannte Typklasse/);
	for (const proto of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.throws(() => typeChain(proto), /unbekannte Typklasse/, proto);
	assert.throws(() => typeChain("A", { A: "B", B: "A" }), /im Kreis/);
	assert.deepEqual(typeChain("Item", { Item: "Coin", Coin: "Item" }), ["Item", "Object"], "a world cannot move the engine's classes");
});

test("names with a typo still mean the thing: one from four letters, two from eight; exact names and prefixes come first", async () => {
	const { byName, typos } = await import("../server/engine/context.ts");
	const t = (name: string, aliases: string[] = []) => ({ e: {} as never, f: { name, aliases } });
	const things = [t("Leuchtfeuer", ["feuer"]), t("Treibholz", ["holz"]), t("Muschel")];
	const one = (n: string) => byName(things, n).map((x) => x.f.name);
	assert.deepEqual(one("feur"), ["Leuchtfeuer"], "a letter missing");
	assert.deepEqual(one("fueer"), ["Leuchtfeuer"], "two letters swapped");
	assert.deepEqual(one("treibhloz"), ["Treibholz"]);
	assert.deepEqual(one("leuchtfuer"), ["Leuchtfeuer"]);
	assert.deepEqual(one("muschl"), ["Muschel"]);
	assert.deepEqual(one("hol"), ["Treibholz"], "a prefix, as before");
	assert.deepEqual(one("hut"), [], "short words must match: no guess from three letters");
	assert.deepEqual(one("faden"), [], "more than one letter off in a short word is another word");
	assert.equal(typos("ost", "ots", 1), 1);
});
