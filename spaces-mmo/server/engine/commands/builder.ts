// Builder and admin commands (docs/phasen.md Phase 1): shaping the world from inside it. Each carries a `cmd` lock, so
// for everyone below the level the command does not exist. Lock strings a builder writes are parsed before they are
// stored; a string that does not parse is refused with the reason.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type Taken } from "phi-spaces";
import { fieldsOf, roomToken, type AccountFields, type ExitFields, type ItemFields, type RoomFields, type TagFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { byName, CommandError, exitsHere, inventory, itemsHere, msg, roomOf, type CommandCtx } from "../context.ts";
import { LEVELS, LockError, parseLocks } from "../locks.ts";
import { DEFAULT_ITEM_LOCKS, newItemId, resolvePrototype, spawn as spawnItem } from "../prototypes.ts";
import { draftOf, typeChain } from "../typeclasses.ts";
import { walkable } from "../world.ts";

const BUILDER = "cmd:perm(Builder)";
const ADMIN = "cmd:perm(Admin)";
const NAME = /^[\p{L}\p{N} _'-]{1,40}$/u;

type Target = { kind: "item" | "exit" | "room"; e: Taken; id: string; name: string };

/** The thing a builder means: "hier" (the room), something carried, lying here, or an exit here. */
async function target(c: CommandCtx, name: string): Promise<Target> {
	const n = name.trim();
	if (["hier", "here"].includes(n.toLowerCase())) {
		const e = await c.space.readIfExists({ type: "Room", fields: { roomId: c.actor.room } }, NO_WAIT);
		if (!e) throw new CommandError("Dieser Ort ist verschwunden.");
		return { kind: "room", e, id: c.actor.room, name: String(e.fields.name) };
	}
	const item = byName([...(await inventory(c)), ...(await itemsHere(c))], n, c.actor)[0];
	if (item) return { kind: "item", e: item.e, id: item.f.itemId, name: item.f.name };
	const exit = byName(await exitsHere(c), n)[0];
	if (exit) return { kind: "exit", e: exit.e, id: exit.f.exitId, name: exit.f.name };
	throw new CommandError(`Hier ist nichts, was „${n.slice(0, 30)}“ heißt.`);
}

/** Takes the entry and writes it with changed fields, keeping its typeclass. */
async function rewrite(c: CommandCtx, e: Taken, change: Record<string, unknown>): Promise<void> {
	const t = await c.space.take({ type: e.type, id: e.id }, NO_WAIT, { txn: c.txn });
	if (!t) throw new CommandError("Das ist gerade in Benutzung; bitte gleich noch einmal.");
	await c.space.write({ type: t.type, types: t.types.slice(1), fields: { ...t.fields, ...change } as never }, c.txn, FOREVER);
}

/** `links = rechts`, both trimmed; null without "=". */
const assignment = (arg: string): [string, string] | null => {
	const i = arg.indexOf("=");
	return i < 0 ? null : [arg.slice(0, i).trim(), arg.slice(i + 1).trim()];
};

const checkedLocks = (s: string): string => {
	try { parseLocks(s); return s; } catch (e) { throw new CommandError(`Lock-String ungültig: ${(e as LockError).message}`); }
};

/** A walkable cell next to `at` that holds no exit (where someone arriving stands). */
function arrivalNear(c: CommandCtx, ground: string[], at: { x: number; y: number }, exits: Array<{ x: number; y: number }>): { x: number; y: number } {
	for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
		const p = { x: at.x + dx, y: at.y + dy };
		if (walkable(c.world, ground, p.x, p.y) && !exits.some((x) => x.x === p.x && x.y === p.y)) return p;
	}
	throw new CommandError("Neben dieser Stelle ist kein Platz zum Ankommen.");
}

async function writeExit(c: CommandCtx, f: ExitFields): Promise<void> {
	await c.space.write(draftOf("Exit", c.world.typeclasses, f), c.txn, FOREVER);
}

const dig: Command = {
	key: "dig", aliases: ["grabe", "grab"], locks: BUILDER,
	help: "dig <name> = <richtung>[, <zurück>] – einen neuen Raum anlegen und hier einen Ausgang dorthin öffnen",
	async func(c, arg) {
		const a = assignment(arg);
		const [ways = "", back = ""] = (a?.[1] ?? "").split(",").map((s) => s.trim());
		if (!a || !NAME.test(a[0]) || !NAME.test(ways)) throw new CommandError("So geht es: dig <name> = <richtung>[, <zurück>]");
		const here = await roomOf(c);
		const exitsHereNow = (await exitsHere(c)).map((x) => x.f);
		if (exitsHereNow.some((x) => x.x === c.actor.x && x.y === c.actor.y)) throw new CommandError("Hier ist schon ein Ausgang; stell dich auf eine andere Stelle.");
		const roomId = `r-${randomBytes(5).toString("hex")}`, d = c.world.dig;
		await c.space.write(draftOf("Room", c.world.typeclasses, { roomId, name: a[0], desc: d.desc, ground: d.ground, spawn: d.spawn } satisfies RoomFields), c.txn, FOREVER);
		await c.space.write(roomToken(roomId), c.txn, FOREVER);
		const backExit = back ? [{ x: d.spawn.x, y: d.spawn.y }] : [];
		await writeExit(c, { exitId: `x-${randomBytes(5).toString("hex")}`, name: ways, aliases: [], desc: `Nach ${a[0]}.`, location: here.roomId, destination: roomId, x: c.actor.x, y: c.actor.y, arrive: arrivalNear(c, d.ground, d.spawn, backExit), locks: "" });
		if (back) await writeExit(c, { exitId: `x-${randomBytes(5).toString("hex")}`, name: back, aliases: [], desc: `Zurück nach ${here.name}.`, location: roomId, destination: here.roomId, x: d.spawn.x, y: d.spawn.y, arrive: arrivalNear(c, here.ground, c.actor, [...exitsHereNow, { x: c.actor.x, y: c.actor.y }]), locks: "" });
		await msg(c, c.actor.charId, "info", `Raum „${a[0]}“ (${roomId}) angelegt; der Ausgang „${ways}“ liegt, wo du stehst${back ? `, zurück führt „${back}“` : ""}.`);
	},
};

const open: Command = {
	key: "open", aliases: ["öffne", "oeffne"], locks: BUILDER,
	help: "open <richtung> = <raum> – hier einen Ausgang in einen bestehenden Raum öffnen (Name oder Raum-ID)",
	async func(c, arg) {
		const a = assignment(arg);
		if (!a || !NAME.test(a[0]) || !a[1]) throw new CommandError("So geht es: open <richtung> = <raum>");
		const rooms = (await c.space.readAll({ type: "Room" })).map((e) => fieldsOf<RoomFields>(e));
		const dest = rooms.find((r) => r.roomId === a[1]) ?? rooms.find((r) => r.name.toLowerCase() === a[1]!.toLowerCase());
		if (!dest) throw new CommandError(`Einen Raum „${a[1]!.slice(0, 30)}“ gibt es nicht.`);
		if ((await exitsHere(c)).some((x) => x.f.x === c.actor.x && x.f.y === c.actor.y)) throw new CommandError("Hier ist schon ein Ausgang; stell dich auf eine andere Stelle.");
		const spawnAt = dest.spawn ?? { x: Math.floor((dest.ground[0]?.length ?? 1) / 2), y: Math.floor(dest.ground.length / 2) };
		const arrive = walkable(c.world, dest.ground, spawnAt.x, spawnAt.y) ? spawnAt : arrivalNear(c, dest.ground, spawnAt, []);
		await writeExit(c, { exitId: `x-${randomBytes(5).toString("hex")}`, name: a[0], aliases: [], desc: `Nach ${dest.name}.`, location: c.actor.room, destination: dest.roomId, x: c.actor.x, y: c.actor.y, arrive, locks: "" });
		await msg(c, c.actor.charId, "info", `Ausgang „${a[0]}“ nach ${dest.name} geöffnet.`);
	},
};

const create: Command = {
	key: "create", aliases: ["erschaffe"], locks: BUILDER,
	help: "create <name>[:<typklasse>] – ein neues Ding erschaffen, wo du stehst",
	async func(c, arg) {
		const [name = "", tc = "Item"] = arg.split(":").map((s) => s.trim());
		if (!NAME.test(name)) throw new CommandError("So geht es: create <name>[:<typklasse>]");
		let chain: string[];
		try { chain = typeChain(tc, c.world.typeclasses); } catch (e) { throw new CommandError((e as Error).message); }
		if (!chain.includes("Item")) throw new CommandError(`„${tc}“ ist keine Typklasse für Dinge.`);
		const item: ItemFields = { itemId: newItemId(), name, aliases: [], desc: "", location: c.actor.room, x: c.actor.x, y: c.actor.y, glyph: { shape: "square", color: "#9aa3ad" }, locks: DEFAULT_ITEM_LOCKS, proto: "" };
		await c.space.write(draftOf(tc, c.world.typeclasses, item), c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(erschaffst|erschafft) ${name}.`, { templ: true });
	},
};

const spawn: Command = {
	key: "spawn", aliases: ["erzeuge"], locks: BUILDER,
	help: "spawn <prototyp> – ein Ding nach einem Prototyp erschaffen, wo du stehst (spawn ohne Namen listet sie)",
	async func(c, arg) {
		if (!arg) {
			const keys = (await c.space.readAll({ type: "Prototype" })).map((e) => String(e.fields.key)).sort();
			return msg(c, c.actor.charId, "info", `Prototypen: ${keys.join(", ")}`);
		}
		const p = await resolvePrototype(c.space, arg.trim().toLowerCase());
		if (!p) throw new CommandError(`Einen Prototyp „${arg.slice(0, 30)}“ gibt es nicht. „spawn“ listet sie.`);
		const item = await spawnItem(c.space, c.txn, c.world, p, { location: c.actor.room, x: c.actor.x, y: c.actor.y });
		await msg(c, "*", "info", `$you() $conj(erschaffst|erschafft) ${item.name}.`, { templ: true });
	},
};

const set: Command = {
	key: "set", aliases: ["setze"], locks: BUILDER,
	help: "set <ding>/<feld> = <wert> – ein Feld ändern: name, desc, aliases (mit Kommas), locks; „hier“ ist der Raum",
	async func(c, arg) {
		const a = assignment(arg);
		const slash = a?.[0].lastIndexOf("/") ?? -1;
		if (!a || slash <= 0) throw new CommandError("So geht es: set <ding>/<feld> = <wert>");
		const t = await target(c, a[0].slice(0, slash));
		const field = a[0].slice(slash + 1).trim().toLowerCase();
		const allowedFields = t.kind === "room" ? ["name", "desc"] : ["name", "desc", "aliases", "locks"];
		if (!allowedFields.includes(field)) throw new CommandError(`Änderbar: ${allowedFields.join(", ")}`);
		if (field === "name" && !NAME.test(a[1])) throw new CommandError("Ein Name hat 1 bis 40 Buchstaben, Ziffern, Leerzeichen, ' oder -.");
		if (a[1].length > 1000) throw new CommandError("Höchstens 1000 Zeichen.");
		const value = field === "aliases" ? a[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10) : field === "locks" ? checkedLocks(a[1]) : a[1];
		await rewrite(c, t.e, { [field]: value });
		await msg(c, c.actor.charId, "info", `${t.name}: ${field} geändert.`);
	},
};

const lock: Command = {
	key: "lock", aliases: ["sperre"], locks: BUILDER,
	help: "lock <ding> = <lock-string> – Zugriffe regeln, z. B. lock tür = traverse:perm(Builder) (help bauen)",
	async func(c, arg) {
		const a = assignment(arg);
		if (!a) throw new CommandError("So geht es: lock <ding> = <lock-string>");
		const t = await target(c, a[0]);
		if (t.kind === "room") throw new CommandError("Räume haben noch keine Locks.");
		await rewrite(c, t.e, { locks: checkedLocks(a[1]) });
		await msg(c, c.actor.charId, "info", `${t.name}: Locks gesetzt.`);
	},
};

const tag: Command = {
	key: "tag", aliases: ["markiere"], locks: BUILDER,
	help: "tag <ding> = <tag>[:<kategorie>] – ein Tag anheften; = -<tag> nimmt es ab; tag <ding> listet sie",
	async func(c, arg) {
		const a = assignment(arg);
		const t = await target(c, a ? a[0] : arg);
		if (!a) {
			const tags = (await c.space.readAll({ type: "Tag", fields: { target: t.id } })).map((e) => fieldsOf<TagFields>(e)).map((x) => `${x.key}:${x.category}`);
			return msg(c, c.actor.charId, "info", tags.length ? `Tags von ${t.name}: ${tags.join(", ")}` : `${t.name} hat keine Tags.`);
		}
		const remove = a[1].startsWith("-");
		const [key = "", category = "allgemein"] = a[1].replace(/^-/, "").split(":").map((s) => s.trim().toLowerCase());
		if (!/^[\p{L}\p{N}_-]{1,30}$/u.test(key) || !/^[\p{L}\p{N}_-]{1,30}$/u.test(category)) throw new CommandError("Tags und Kategorien: 1 bis 30 Buchstaben, Ziffern, _ oder -.");
		const fields: TagFields = { target: t.id, key, category };
		if (remove) {
			if (!(await c.space.take({ type: "Tag", fields: fields as never }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${t.name} hat das Tag ${key}:${category} nicht.`);
		} else if (!(await c.space.readIfExists({ type: "Tag", fields: fields as never }, NO_WAIT))) await c.space.write({ type: "Tag", fields: fields as never }, c.txn, FOREVER);
		await msg(c, c.actor.charId, "info", `${t.name}: Tag ${key}:${category} ${remove ? "abgenommen" : "angeheftet"}.`);
	},
};

const examine: Command = {
	key: "examine", aliases: ["untersuche", "ex"], locks: BUILDER,
	help: "examine <ding> – alle Felder, Typklasse und Tags eines Dings, Ausgangs oder des Raums („hier“)",
	async func(c, arg) {
		const t = await target(c, arg || "hier");
		const tags = (await c.space.readAll({ type: "Tag", fields: { target: t.id } })).map((e) => `${e.fields.key}:${e.fields.category}`);
		const fields = Object.entries(t.e.fields).filter(([k]) => k !== "ground").map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
		await msg(c, c.actor.charId, "info", [`${t.name} (${t.e.types.join(" < ")})`, ...fields, `  tags: ${tags.length ? tags.join(", ") : "–"}`].join("\n"));
	},
};

const destroy: Command = {
	key: "destroy", aliases: ["vernichte", "zerstöre", "zerstoere"], locks: BUILDER,
	help: "destroy <ding> – ein Ding oder einen Ausgang hier vernichten (mit seinen Tags)",
	async func(c, arg) {
		const t = await target(c, arg);
		if (t.kind === "room") throw new CommandError("Räume lassen sich noch nicht vernichten.");
		if (!(await c.space.take({ type: t.e.type, id: t.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Das ist gerade in Benutzung; bitte gleich noch einmal.");
		for (const tg of await c.space.readAll({ type: "Tag", fields: { target: t.id } })) await c.space.take({ type: "Tag", id: tg.id }, NO_WAIT, { txn: c.txn });
		await msg(c, "*", "info", `$you() $conj(vernichtest|vernichtet) ${t.name}.`, { templ: true });
	},
};

const perm: Command = {
	key: "perm", aliases: ["rechte"], locks: ADMIN,
	help: `perm <name> = <stufe> – einem registrierten Konto eine Stufe geben (${LEVELS.filter((l) => l !== "Guest" && l !== "Admin").join(", ")})`,
	async func(c, arg) {
		const a = assignment(arg);
		const level = LEVELS.find((l) => l.toLowerCase() === a?.[1].toLowerCase());
		if (!a || !level || level === "Guest" || level === "Admin") throw new CommandError("So geht es: perm <name> = Builder|Player");
		const e = (await c.space.readAll({ type: "Account", fields: { guest: false } })).find((x) => String(x.fields.name).toLowerCase() === a[0].toLowerCase());
		if (!e) throw new CommandError(`Ein registriertes Konto „${a[0].slice(0, 30)}“ gibt es nicht.`);
		const acc = fieldsOf<AccountFields>(e);
		await rewrite(c, e, { perms: level === "Builder" ? [...new Set([...(acc.perms ?? []), "Builder"])] : (acc.perms ?? []).filter((p) => p !== "Builder") });
		await msg(c, c.actor.charId, "info", `${acc.name} ist jetzt ${level}.`);
	},
};

export const BUILDER_COMMANDS: Command[] = [dig, open, create, spawn, set, lock, tag, examine, destroy, perm];
