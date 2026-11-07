// What the page shows while the figure is on its way: a command that takes it to another place (an exit, a ferry, the
// boat, the train, a beam) may take a while (into another region the character is handed over), so after a
// second without the new place the page says what is happening (App.tsx). Pure, so it is tested without a browser.

/** The words for a command that moves the figure to another place, or null for any other command. `exits`: the exits
 *  of the room, by the name `go` takes, the place they lead to, and whether they cross to another island (the ferry). */
export function travelText(line: string, exits: ReadonlyArray<{ name: string; to?: string; ferry?: boolean }>): string | null {
	const [word = "", ...rest] = line.trim().toLowerCase().split(/\s+/);
	const arg = rest.join(" ");
	if (["go", "geh", "gehe"].includes(word) || (!arg && exits.some((e) => e.name.toLowerCase() === word))) {
		const exit = exits.find((e) => e.name.toLowerCase() === (arg || word));
		if (!exit) return null;
		if (exit.ferry) return `Du fährst mit dem Kahn${exit.to ? ` nach ${exit.to}` : ""} …`;
		return exit.to ? `Unterwegs nach ${exit.to} …` : "Unterwegs …";
	}
	if (["beam", "beame", "beamen"].includes(word)) return "Du wirst gebeamt …";
	if (["rudere", "rudern", "row"].includes(word)) return "Du ruderst …";
	if (["segle", "segeln", "sail"].includes(word)) return "Du segelst …";
	if (["einschiffen", "board"].includes(word)) return "Du gehst an Bord …";
	if (["ausschiffen", "disembark", "landen", "aussteigen"].includes(word)) return "Du gehst an Land …";
	// "zug" alone shows the timetable, "zug sende …" and "zug abholen" are freight
	if (["zug", "bahn", "train"].includes(word) && arg && !/^(sende|send|abholen|collect)\b/.test(arg)) return "Du fährst mit dem Zug …";
	return null;
}

/** After how long without the new place the page says the figure is on its way, and when it stops saying so anyway. */
export const TRAVEL_NOTE_MS = 1_000, TRAVEL_GIVE_UP_MS = 30_000;
