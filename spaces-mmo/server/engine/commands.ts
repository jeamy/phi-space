// Runs one command line (docs/evennia-abbildung.md, "Ablauf eines Befehls"): the actor's command sets are merged
// (defaults, builder commands, one command per exit of the room), commands whose `cmd` lock the actor fails are
// dropped, and the command the first word names runs inside the intent's transaction.
import { distinct, merge, type CmdSet, type Command } from "./cmdsets.ts";
import { BUILDER_COMMANDS } from "./commands/builder.ts";
import { BUILD_COMMANDS } from "./commands/build.ts";
import { GARDEN_COMMANDS } from "./commands/garden.ts";
import { WILD_COMMANDS } from "./commands/wild.ts";
import { DEFAULT_COMMANDS, exitCmdSet, helpCommand } from "./commands/default.ts";
import { CLOCK_COMMANDS } from "./commands/clock.ts";
import { TRADE_COMMANDS } from "./commands/trade.ts";
import { randomBytes } from "node:crypto";
import { llmEnabled } from "../llm.ts";
import { fieldsOf, type ListingFields, type TranslateFields } from "../model.ts";
import { CommandError, NotUnderstood, exitsHere, inventory, lockCtx, msg, type CommandCtx } from "./context.ts";
import { translateRules, type TranslateView } from "./translate.ts";
import { allowed } from "./locks.ts";

export { CommandError, type CommandCtx };

/** The commands the actor has, by every name. */
export async function commandsOf(c: CommandCtx): Promise<Map<string, Command>> {
	const lc = await lockCtx(c);
	const offered = (cmds: Command[]) => cmds.filter((cmd) => !cmd.locks || allowed(cmd.locks, "cmd", lc));
	const exits = await exitCmdSet(c);
	let all: Map<string, Command> = new Map();
	// the help lists the commands, not the exits (look names those)
	const help = helpCommand(() => distinct(all).filter((cmd) => !exits.commands.includes(cmd)));
	const sets: CmdSet[] = [
		{ key: "default", priority: 0, mergeType: "Union", commands: offered([...DEFAULT_COMMANDS, ...TRADE_COMMANDS, ...BUILD_COMMANDS, ...GARDEN_COMMANDS, ...WILD_COMMANDS, ...CLOCK_COMMANDS, help]) },
		{ key: "builder", priority: 1, mergeType: "Union", commands: offered(BUILDER_COMMANDS) },
		exits,
	];
	all = merge(sets);
	return all;
}

const split = (line: string): [string, string] => {
	// "'text" and ":text" are say and emote without a space
	const short = /^(['":])(.*)$/s.exec(line);
	if (short) return [short[1] === ":" ? "emote" : "say", short[2]!.trim()];
	const verb = line.split(/\s+/)[0]!;
	return [verb, line.slice(verb.length).trim()];
};

/** What the translation rules may look at. */
async function viewFor(c: CommandCtx): Promise<TranslateView> {
	const listings = c.world.market.rooms.includes(c.actor.room) ? (await c.space.readAll({ type: "Listing", fields: { room: c.actor.room } })).map((e) => fieldsOf<ListingFields>(e)).sort((a, b) => a.at - b.at || a.listingId.localeCompare(b.listingId)).map((l, i) => ({ nr: i + 1, itemName: l.itemName })) : [];
	const people = (await c.space.readAll({ type: "Character", fields: { room: c.actor.room } })).map((e) => String(e.fields.name)).filter((n) => n !== c.actor.name);
	return { exits: (await exitsHere(c)).map((x) => ({ name: x.f.name, aliases: x.f.aliases })), listings, carried: (await inventory(c)).map((i) => i.f.name), people };
}

/** The step command, run without merging the command sets: steps are most of what players send, and a step has no
 *  lock; the sets would only cost reads (an exit a builder names "step" does not take its place). */
const STEP = DEFAULT_COMMANDS.find((cmd) => cmd.key === "step")!;

export async function execute(c: CommandCtx, line: string): Promise<void> {
	line = line.trim();
	if (!line) return;
	if (/^step\s/.test(line)) return STEP.func(c, line.slice(5).trim());
	const cmds = await commandsOf(c);
	// plain language: the rules first (free); a line they rewrite says how it was understood
	const said = c.asked ?? line;
	// talk and what pages and NPCs send by themselves (steps, walks, arriving) are never translated
	const ruled = say(line) || /^(step|move|arrive)\b/.test(line) ? null : translateRules(line, await viewFor(c));
	if (ruled) line = ruled;
	// (not for talk: the words said show it, and a line after them reads as if they were still to come)
	const understood = said !== line && !say(line) ? `„${said.slice(0, 80)}“ → ${line}` : null;
	const [verb, arg] = split(line);
	const cmd = cmds.get(verb.toLowerCase());
	if (!cmd) {
		// nothing understood it: the model process may (once; a translation that is no command is refused)
		if (llmEnabled() && !c.asked && c.account && !c.account.npc) {
			const t: TranslateFields = { reqId: randomBytes(6).toString("hex"), charId: c.actor.charId, accountId: c.account.accountId, guest: c.account.guest, line: line.slice(0, 300), room: c.actor.room, at: Date.now() };
			await c.space.write({ type: "Translate", fields: t as never }, c.txn, 60_000);
			return msg(c, c.actor.charId, "info", `„${line.slice(0, 80)}“ – einen Moment, ich versuche das zu verstehen …`);
		}
		throw new CommandError(c.asked ? `„${c.asked.slice(0, 80)}“ habe ich nicht verstanden. „help“ zeigt die Befehle.` : `Unbekannter Befehl „${verb.slice(0, 20)}“. „help“ zeigt alle Befehle.`);
	}
	try {
		if (understood) await msg(c, c.actor.charId, "info", understood);
		await cmd.func(c, arg);
	} catch (e) {
		// not understood (no thing of that name, a command without what it needs): the model reads the sentence first;
		// only what it cannot read either is refused (a translation is never sent again, `c.asked`)
		if (e instanceof NotUnderstood && llmEnabled() && !c.asked && c.account && !c.account.npc) {
			const t: TranslateFields = { reqId: randomBytes(6).toString("hex"), charId: c.actor.charId, accountId: c.account.accountId, guest: c.account.guest, line: said.slice(0, 300), room: c.actor.room, at: Date.now(), why: e.message.slice(0, 300) };
			await c.space.write({ type: "Translate", fields: t as never }, c.txn, 60_000);
			return msg(c, c.actor.charId, "info", `„${said.slice(0, 80)}“ – einen Moment, ich versuche das zu verstehen …`);
		}
		// a refusal of a translated line says what it was translated to
		if (e instanceof CommandError && understood) throw new CommandError(`${understood}: ${e.message}`);
		throw e;
	}
}

/** Talk is never translated: "sag ich gehe nach osten" says it. */
const say = (line: string) => /^(say|sag|sage|'|emote|:|channel|kanal)\b/i.test(line) || line.startsWith("'") || line.startsWith(":");
