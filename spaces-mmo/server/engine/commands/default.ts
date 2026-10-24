// The commands every character has (Evennia's default command set, docs/phasen.md Phase 1). Each runs inside the
// transaction its intent is taken in: what it changes and what it says commit together, or not at all. An item changes
// hands by being taken (it is then held by this transaction, invisible to every other) and written anew.
import { FOREVER, NO_WAIT } from "phi-spaces";
import { fieldsOf, type CharacterFields, type ExitFields, type HelpEntryFields, type ItemFields, type SessionFields } from "../../model.ts";
import type { CmdSet, Command } from "../cmdsets.ts";
import { byName, check, CommandError, exitsHere, inventory, itemsHere, msg, reach, roomOf, type CommandCtx } from "../context.ts";
import { findPath, walkable } from "../world.ts";

const MAX_SAY = 300;

/** Test hook: SPACES_MMO_FAULT_PAUSE=give:4000 waits that long inside `give`, between taking the item and writing it
 *  to the receiver, so a test can kill the world worker there. */
async function faultPause(where: string): Promise<void> {
	const [w, ms] = (process.env.SPACES_MMO_FAULT_PAUSE ?? "").split(":");
	if (w === where && Number(ms) > 0) await new Promise((r) => setTimeout(r, Number(ms)));
}

/** Characters with a live session (`room` null: all rooms). */
export async function online(c: Pick<CommandCtx, "space">, room: string | null): Promise<CharacterFields[]> {
	const live = new Set((await c.space.readAll({ type: "Session" })).map((s) => fieldsOf<SessionFields>(s).charId));
	return (await c.space.readAll({ type: "Character", fields: room ? { room } : {} })).map((e) => fieldsOf<CharacterFields>(e)).filter((ch) => live.has(ch.charId));
}

/** Moves the actor to `to` in its room; an exit on that cell is taken at once. */
async function moveTo(c: CommandCtx, to: { x: number; y: number }): Promise<void> {
	const exit = (await exitsHere(c)).find((x) => x.f.x === to.x && x.f.y === to.y);
	if (exit) return traverse(c, exit.f);
	await relocate(c, { room: c.actor.room, x: to.x, y: to.y });
}

/** Takes the actor's character and writes it at a new place. */
async function relocate(c: CommandCtx, to: { room: string; x: number; y: number }): Promise<void> {
	const e = await c.space.take({ type: "Character", fields: { charId: c.actor.charId } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Deine Figur ist gerade nicht greifbar; bitte noch einmal.");
	await c.space.write({ type: "Character", fields: { ...fieldsOf<CharacterFields>(e), ...to } as never }, c.txn, FOREVER);
}

export async function traverse(c: CommandCtx, exit: ExitFields): Promise<void> {
	await check(c, exit.locks, "traverse", `Der Weg nach ${exit.name} ist dir versperrt.`);
	const dest = await roomOf(c, exit.destination);
	await relocate(c, { room: dest.roomId, x: exit.arrive.x, y: exit.arrive.y });
	await msg(c, "*", "info", `$you() $conj(gehst|geht) nach ${exit.name}.`, { templ: true });
	await msg(c, "*", "info", `$you() $conj(kommst|kommt) an.`, { templ: true, room: dest.roomId });
	await msg(c, c.actor.charId, "look", await describeRoom(c, dest.roomId, true), { room: dest.roomId });
}

async function describeRoom(c: CommandCtx, roomId: string, arriving = false): Promise<string> {
	const room = await roomOf(c, roomId);
	const exits = (await exitsHere(c, roomId)).map((x) => x.f.name).sort();
	const items = (await c.space.readAll({ type: "Item", fields: { location: roomId } })).map((e) => fieldsOf<ItemFields>(e).name).sort();
	const others = (await online(c, roomId)).filter((ch) => ch.charId !== c.actor.charId).map((ch) => ch.name);
	return [
		room.name, room.desc,
		exits.length ? `Ausgänge: ${exits.join(", ")}.` : "Kein Weg führt hinaus.",
		...(items.length ? [`Hier liegt: ${items.join(", ")}.`] : []),
		arriving && !others.length ? "Niemand ist hier." : others.length ? `Hier sind: ${others.join(", ")}.` : "Niemand sonst ist hier.",
	].join("\n");
}

const look: Command = {
	key: "look", aliases: ["schau", "sieh", "l"],
	help: "look [ding] – sich umsehen, oder ein Ding, einen Ausgang, eine Person ansehen",
	async func(c, arg) {
		if (!arg) return msg(c, c.actor.charId, "look", await describeRoom(c, c.actor.room));
		const item = byName([...(await inventory(c)), ...(await itemsHere(c))], arg, c.actor)[0];
		if (item) return msg(c, c.actor.charId, "look", `${item.f.name}\n${item.f.desc || "Nichts Besonderes."}`);
		const exit = byName(await exitsHere(c), arg)[0];
		if (exit) return msg(c, c.actor.charId, "look", `${exit.f.name}: ${exit.f.desc || "ein Weg"}`);
		const person = (await online(c, c.actor.room)).find((ch) => ch.name.toLowerCase().startsWith(arg.toLowerCase()));
		if (person) return msg(c, c.actor.charId, "look", `${person.name} steht hier.`);
		throw new CommandError(`Hier ist nichts, was „${arg.slice(0, 30)}“ heißt.`);
	},
};

const say: Command = {
	key: "say", aliases: ["sag", "sage", "'"],
	help: "say <text> – etwas sagen; alle hier hören es (kurz: '<text>)",
	async func(c, text) {
		if (!text) throw new CommandError("Was möchtest du sagen? Zum Beispiel: say Hallo");
		await msg(c, "*", "say", `${c.actor.name}: ${text.slice(0, MAX_SAY)}`);
	},
};

const emote: Command = {
	key: "emote", aliases: ["geste", "pose", ":"],
	help: "emote <tut etwas> – eine Handlung zeigen, z. B. emote winkt (kurz: :winkt)",
	async func(c, text) {
		if (!text) throw new CommandError("Was tust du? Zum Beispiel: emote winkt");
		await msg(c, "*", "emote", `${c.actor.name} ${text.slice(0, MAX_SAY)}`);
	},
};

const who: Command = {
	key: "who", aliases: ["wer"],
	help: "who – wer gerade spielt",
	async func(c) {
		const rooms = new Map((await c.space.readAll({ type: "Room" })).map((e) => [String(e.fields.roomId), String(e.fields.name)]));
		const list = (await online(c, null)).map((ch) => `${ch.name} (${rooms.get(ch.room) ?? ch.room})`).sort();
		await msg(c, c.actor.charId, "who", `Gerade spielen ${list.length}: ${list.join(", ")}`);
	},
};

const move: Command = {
	key: "move", aliases: ["laufe", "lauf"],
	help: "move <x> <y> – zu einer Stelle gehen, den ganzen Weg",
	async func(c, arg) {
		const [x, y] = arg.split(/\s+/).map(Number);
		if (!Number.isInteger(x) || !Number.isInteger(y) || arg.split(/\s+/).length !== 2) throw new CommandError("So geht es: move <x> <y>, zum Beispiel move 10 8");
		const room = await roomOf(c);
		const path = findPath(c.world, room.ground, c.actor, { x: x!, y: y! });
		if (!path) throw new CommandError("Dorthin führt kein Weg.");
		if (path.length) await moveTo(c, { x: x!, y: y! });
	},
};

const step: Command = {
	key: "step", aliases: ["schritt"],
	help: "step <dx> <dy> – einen Schritt gehen (das tun Klick und Pfeiltaste)",
	async func(c, arg) {
		const [dx, dy] = arg.split(/\s+/).map(Number);
		if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx!) + Math.abs(dy!) !== 1) throw new CommandError("So geht es: step <dx> <dy> mit einem Schritt, z. B. step 1 0");
		const to = { x: c.actor.x + dx!, y: c.actor.y + dy! };
		if (!walkable(c.world, (await roomOf(c)).ground, to.x, to.y)) throw new CommandError("Da geht es nicht weiter.");
		await moveTo(c, to);
	},
};

const go: Command = {
	key: "go", aliases: ["geh", "gehe"],
	help: "go <richtung> – einen Ausgang nehmen, von überall im Raum (oder nur den Namen tippen, z. B. ost)",
	async func(c, arg) {
		const exit = byName(await exitsHere(c), arg)[0];
		if (!exit) throw new CommandError(arg ? `Hier gibt es keinen Ausgang „${arg.slice(0, 20)}“.` : "Wohin? Zum Beispiel: go ost");
		await traverse(c, exit.f);
	},
};

const get: Command = {
	key: "get", aliases: ["nimm", "heb", "take"],
	help: "get <ding> – etwas aufheben, das neben dir liegt",
	async func(c, arg) {
		if (!arg) throw new CommandError("Was möchtest du aufheben? Zum Beispiel: get treibholz");
		const found = byName(await itemsHere(c), arg, c.actor);
		const item = found.find((i) => reach(i.f, c.actor) <= 1);
		if (!item) throw new CommandError(found.length ? `${found[0]!.f.name} liegt zu weit weg; geh näher heran.` : `Hier liegt nichts, was „${arg.slice(0, 30)}“ heißt.`);
		await check(c, item.f.locks, "get", `${item.f.name} lässt sich nicht aufheben.`);
		// held by another world worker right now: someone else is faster
		const e = await c.space.take({ type: "Item", fields: { itemId: item.f.itemId, location: c.actor.room } }, NO_WAIT, { txn: c.txn });
		if (!e) throw new CommandError("Zu spät – jemand anderes war schneller.");
		await c.space.write({ type: e.type, types: e.types.slice(1), fields: { ...fieldsOf<ItemFields>(e), location: c.actor.charId, x: -1, y: -1 } as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(hebst|hebt) ${item.f.name} auf.`, { templ: true });
	},
};

const drop: Command = {
	key: "drop", aliases: ["leg", "lege", "lass"],
	help: "drop <ding> – etwas ablegen, wo du stehst",
	async func(c, arg) {
		const item = byName(await inventory(c), arg)[0];
		if (!item) throw new CommandError(arg ? `Du trägst nichts, was „${arg.slice(0, 30)}“ heißt.` : "Was möchtest du ablegen?");
		await check(c, item.f.locks, "drop", `${item.f.name} lässt sich nicht ablegen.`);
		const e = await c.space.take({ type: "Item", fields: { itemId: item.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn });
		if (!e) throw new CommandError(`${item.f.name} ist gerade nicht greifbar.`);
		await c.space.write({ type: e.type, types: e.types.slice(1), fields: { ...fieldsOf<ItemFields>(e), location: c.actor.room, x: c.actor.x, y: c.actor.y } as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(legst|legt) ${item.f.name} ab.`, { templ: true });
	},
};

const give: Command = {
	key: "give", aliases: ["gib"],
	help: "give <ding> an <person> – jemandem hier etwas geben (nicht als Gast)",
	async func(c, arg) {
		const m = /^(.+?)\s+(?:an|to|zu)\s+(.+)$/i.exec(arg) ?? /^(.+)\s+(\S+)$/.exec(arg);
		if (!m) throw new CommandError("So geht es: give <ding> an <person>");
		const item = byName(await inventory(c), m[1]!)[0];
		if (!item) throw new CommandError(`Du trägst nichts, was „${m[1]!.slice(0, 30)}“ heißt.`);
		const who = (await c.space.readAll({ type: "Character", fields: { room: c.actor.room } })).map((e) => fieldsOf<CharacterFields>(e))
			.filter((ch) => ch.charId !== c.actor.charId).find((ch) => ch.name.toLowerCase() === m[2]!.trim().toLowerCase());
		if (!who) throw new CommandError(`Hier ist niemand namens „${m[2]!.slice(0, 30)}“.`);
		await check(c, item.f.locks, "give", c.account?.guest ? "Gäste können nichts weitergeben; registriere dich dafür." : `${item.f.name} lässt sich nicht weitergeben.`);
		const e = await c.space.take({ type: "Item", fields: { itemId: item.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn });
		if (!e) throw new CommandError(`${item.f.name} ist gerade nicht greifbar.`);
		await faultPause("give");
		await c.space.write({ type: e.type, types: e.types.slice(1), fields: { ...fieldsOf<ItemFields>(e), location: who.charId, x: -1, y: -1 } as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `$you() $conj(gibst|gibt) ${who.name} ${item.f.name}.`, { templ: true });
	},
};

const inv: Command = {
	key: "inventory", aliases: ["inventar", "i", "inv"],
	help: "inventory – was du trägst",
	async func(c) {
		const names = (await inventory(c)).map((i) => i.f.name).sort();
		await msg(c, c.actor.charId, "info", names.length ? `Du trägst: ${names.join(", ")}.` : "Du trägst nichts.");
	},
};

/** A command's help line with every word it answers to, English and German: "get/nimm/heb/take <ding> – …". The
 *  names come from key and aliases, so the list cannot drift from what the parser accepts. */
export function helpLine(cmd: Command): string {
	const names = [cmd.key, ...(cmd.aliases ?? []).filter((a) => /^\p{L}{2,}$/u.test(a))];
	return `${names.join("/")}${cmd.help.startsWith(cmd.key) ? cmd.help.slice(cmd.key.length) : ` – ${cmd.help}`}`;
}

/** The help: without a topic the intro, the commands this actor has, the topics; with one, the command or topic.
 *  Commands answer to English and German names alike; no switch is needed. */
export function helpCommand(commands: () => Command[]): Command {
	return {
		key: "help", aliases: ["hilfe", "?"],
		help: "help [befehl|thema] – diese Hilfe",
		async func(c, arg) {
			const topics = (await c.space.readAll({ type: "HelpEntry" })).map((e) => fieldsOf<HelpEntryFields>(e));
			if (!arg) {
				const intro = topics.find((t) => t.key === "intro")?.text ?? "";
				const lines = commands().map((cmd) => `  ${helpLine(cmd)}`);
				const more = topics.filter((t) => t.key !== "intro").map((t) => t.key).sort();
				return msg(c, c.actor.charId, "help", [intro, "Befehle:", ...lines, ...(more.length ? [`Themen: ${more.join(", ")} (help <thema>)`] : [])].filter(Boolean).join("\n"));
			}
			const a = arg.toLowerCase();
			const cmd = commands().find((x) => x.key === a || x.aliases?.includes(a));
			if (cmd) return msg(c, c.actor.charId, "help", helpLine(cmd));
			const t = topics.find((x) => x.key === a);
			if (t) return msg(c, c.actor.charId, "help", `${t.key} (${t.category})\n${t.text}`);
			throw new CommandError(`Zu „${arg.slice(0, 20)}“ gibt es keine Hilfe. „help“ zeigt alles.`);
		},
	};
}

export const DEFAULT_COMMANDS: Command[] = [look, say, emote, who, move, step, go, get, drop, give, inv];

/** One command per exit of the room (its name and aliases), above the defaults: typing "ost" takes the exit. */
export async function exitCmdSet(c: CommandCtx): Promise<CmdSet> {
	return {
		key: "exits", priority: 10, mergeType: "Union",
		commands: (await exitsHere(c)).map(({ f }) => ({ key: f.name, aliases: f.aliases, help: `${f.name} – ${f.desc || "ein Ausgang"}`, func: (cc) => traverse(cc, f) })),
	};
}
