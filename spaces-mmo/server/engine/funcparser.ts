// Inline functions in messages (Evennia's FuncParser, the basic form of docs/evennia-abbildung.md): a message written
// with an actor is rendered for each reader. German verbs are irregular, so $conj takes both forms.
//   $you()          "du"/"Du" for the actor, the actor's name for everyone else
//   $conj(a|b)      a for the actor ("hebst"), b for everyone else ("hebt")
// Anything else that looks like $name(...) stays as written.

export type View = { viewer: string; actor: string; actorName: string };

export function render(text: string, v: View): string {
	const self = v.viewer === v.actor;
	return text.replace(/\$(you|conj)\(([^()]*)\)/g, (whole, fn: string, arg: string, at: number) => {
		if (fn === "you") {
			if (!self) return v.actorName;
			// capitalised at the start of a sentence
			return /(^|[.!?:]\s+)$/.test(text.slice(0, at)) ? "Du" : "du";
		}
		const [mine, theirs] = arg.split("|");
		if (mine === undefined || theirs === undefined) return whole;
		return self ? mine : theirs;
	});
}
