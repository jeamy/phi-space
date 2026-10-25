// Commands and command sets as in Evennia (docs/evennia-abbildung.md, "Befehle"). A command set comes from the
// character, its permission level and its room (one command per exit); for each command line the sets are merged by
// priority: a Union adds its commands (a higher priority wins a name both have), a Replace drops everything below it,
// a Remove takes its names out. A command's `cmd` lock decides whether it is offered at all.
import type { CommandCtx } from "./context.ts";

export type Command = {
	key: string;
	aliases?: string[];
	/** Lock string; its `cmd` access decides whether the command exists for the actor. */
	locks?: string;
	/** Not listed by help (internal commands such as `arrive`). */
	hidden?: boolean;
	/** One line for the command list, then details. */
	help: string;
	func: (c: CommandCtx, args: string) => Promise<void>;
};
export type CmdSet = { key: string; priority: number; mergeType: "Union" | "Replace" | "Remove"; commands: Command[] };

/** The merged commands by every name they answer to (lower case). */
export function merge(sets: CmdSet[]): Map<string, Command> {
	const out = new Map<string, Command>();
	for (const s of [...sets].sort((a, b) => a.priority - b.priority)) {
		if (s.mergeType === "Replace") out.clear();
		for (const cmd of s.commands) for (const name of [cmd.key, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase())) {
			if (s.mergeType === "Remove") out.delete(name);
			else out.set(name, cmd);
		}
	}
	return out;
}

/** The distinct commands of a merged map, in key order. */
export const distinct = (m: Map<string, Command>): Command[] => [...new Set(m.values())].sort((a, b) => a.key.localeCompare(b.key));
