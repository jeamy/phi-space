// Lock strings as in Evennia (docs/evennia-abbildung.md, "Locks"): `get:all();give:not guest();traverse:perm(Player)`.
// Builders write them, so they are untrusted text: a small recursive-descent parser over a fixed set of functions,
// never evaluated as code. An access type without a lock is allowed.

/** Permission levels, lowest first (Evennia's hierarchy). */
export const LEVELS = ["Guest", "Player", "Builder", "Admin"] as const;
export type Level = (typeof LEVELS)[number];
export const levelIndex = (l: string): number => LEVELS.findIndex((x) => x.toLowerCase() === l.toLowerCase());

/** What a lock asks about the one who tries. `holds`: carries an item with this itemId or prototype key. */
export type LockCtx = { level: Level; guest: boolean; charId: string; holds: (key: string) => boolean };

type Node =
	| { op: "or" | "and"; a: Node; b: Node }
	| { op: "not"; a: Node }
	| { op: "fn"; name: string; arg: string };

const FUNCS: Record<string, { args: 0 | 1; run: (c: LockCtx, arg: string) => boolean }> = {
	all: { args: 0, run: () => true },
	none: { args: 0, run: () => false },
	guest: { args: 0, run: (c) => c.guest },
	perm: { args: 1, run: (c, a) => levelIndex(c.level) >= levelIndex(a) },
	id: { args: 1, run: (c, a) => c.charId === a },
	holds: { args: 1, run: (c, a) => c.holds(a) },
};

export class LockError extends Error {}

const MAX_LOCK = 500;

/** Parses one lock expression (the part after `access:`). */
function parseExpr(src: string): Node {
	const tokens = src.match(/\(|\)|[A-Za-z_][\w-]*|[^\s()]+/g) ?? [];
	let i = 0;
	const peek = () => tokens[i]?.toLowerCase();
	const next = () => tokens[i++];
	const or = (): Node => { let a = and(); while (peek() === "or") { next(); a = { op: "or", a, b: and() }; } return a; };
	const and = (): Node => { let a = not(); while (peek() === "and") { next(); a = { op: "and", a, b: not() }; } return a; };
	const not = (): Node => (peek() === "not" ? (next(), { op: "not", a: not() }) : atom());
	const atom = (): Node => {
		const t = next();
		if (t === undefined) throw new LockError("Ausdruck endet zu früh");
		if (t === "(") { const e = or(); if (next() !== ")") throw new LockError("„)“ fehlt"); return e; }
		// own keys only: "constructor" or "toString" must not reach Object.prototype
		const fn = Object.hasOwn(FUNCS, t.toLowerCase()) ? FUNCS[t.toLowerCase()] : undefined;
		if (!fn) throw new LockError(`unbekannte Funktion „${t.slice(0, 20)}“ (erlaubt: ${Object.keys(FUNCS).join(", ")})`);
		if (next() !== "(") throw new LockError(`„(“ fehlt nach ${t}`);
		let arg = "";
		if (peek() !== ")") arg = next() ?? "";
		if (next() !== ")") throw new LockError(`${t}() nimmt ${fn.args ? "ein Argument" : "keine Argumente"}`);
		if (fn.args === 1 && !arg) throw new LockError(`${t}() braucht ein Argument`);
		if (fn.args === 0 && arg) throw new LockError(`${t}() nimmt keine Argumente`);
		if (t.toLowerCase() === "perm" && levelIndex(arg) < 0) throw new LockError(`perm(): eine dieser Stufen: ${LEVELS.join(", ")}`);
		return { op: "fn", name: t.toLowerCase(), arg };
	};
	const e = or();
	if (i < tokens.length) throw new LockError(`unerwartet: „${tokens[i]!.slice(0, 20)}“`);
	return e;
}

/** `access:expr;access:expr` → access type → parsed expression. Throws LockError with a readable reason. */
export function parseLocks(s: string): Map<string, Node> {
	if (s.length > MAX_LOCK) throw new LockError(`höchstens ${MAX_LOCK} Zeichen`);
	const out = new Map<string, Node>();
	for (const part of s.split(";").map((p) => p.trim()).filter(Boolean)) {
		const colon = part.indexOf(":");
		const access = part.slice(0, colon).trim().toLowerCase();
		if (colon <= 0 || !/^[a-z]{1,20}$/.test(access)) throw new LockError(`„${part.slice(0, 30)}“: erwartet zugriff:ausdruck`);
		out.set(access, parseExpr(part.slice(colon + 1)));
	}
	return out;
}

function run(n: Node, c: LockCtx): boolean {
	switch (n.op) {
		case "or": return run(n.a, c) || run(n.b, c);
		case "and": return run(n.a, c) && run(n.b, c);
		case "not": return !run(n.a, c);
		case "fn": return FUNCS[n.name]!.run(c, n.arg);
	}
}

/** Whether `access` is granted. A lock string that does not parse (stored before a check existed) denies. */
export function allowed(locks: string, access: string, c: LockCtx): boolean {
	let parsed: Map<string, Node>;
	try { parsed = parseLocks(locks ?? ""); } catch { return false; }
	const n = parsed.get(access.toLowerCase());
	return n ? run(n, c) : true;
}
