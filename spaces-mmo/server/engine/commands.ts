// Runs one command line (docs/evennia-abbildung.md, "Ablauf eines Befehls"): the actor's command sets are merged
// (defaults, builder commands, one command per exit of the room), commands whose `cmd` lock the actor fails are
// dropped, and the command the first word names runs inside the intent's transaction.
import { distinct, merge, type CmdSet, type Command } from "./cmdsets.ts";
import { BUILDER_COMMANDS } from "./commands/builder.ts";
import { DEFAULT_COMMANDS, exitCmdSet, helpCommand } from "./commands/default.ts";
import { TRADE_COMMANDS } from "./commands/trade.ts";
import { CommandError, lockCtx, type CommandCtx } from "./context.ts";
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
		{ key: "default", priority: 0, mergeType: "Union", commands: offered([...DEFAULT_COMMANDS, ...TRADE_COMMANDS, help]) },
		{ key: "builder", priority: 1, mergeType: "Union", commands: offered(BUILDER_COMMANDS) },
		exits,
	];
	all = merge(sets);
	return all;
}

export async function execute(c: CommandCtx, line: string): Promise<void> {
	line = line.trim();
	if (!line) return;
	// "'text" and ":text" are say and emote without a space
	const short = /^(['":])(.*)$/s.exec(line);
	const [verb, arg] = short ? [short[1] === ":" ? "emote" : "say", short[2]!.trim()] : [line.split(/\s+/)[0]!, line.slice(line.split(/\s+/)[0]!.length).trim()];
	const cmd = (await commandsOf(c)).get(verb.toLowerCase());
	if (!cmd) throw new CommandError(`Unbekannter Befehl „${verb.slice(0, 20)}“. „help“ zeigt alle Befehle.`);
	await cmd.func(c, arg);
}
