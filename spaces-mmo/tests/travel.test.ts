// What the page says while the figure is on its way (client/travel.ts), and its English.
import { test } from "node:test";
import assert from "node:assert/strict";
import { travelText } from "../client/travel.ts";
import { toEnglish } from "../client/i18n/index.ts";

const exits = [{ name: "ost", to: "Klippenpfad" }, { name: "möwenfels", to: "Möwenfels-Strand", ferry: true }];

test("an exit, a ferry, a beam, the boat and the train say where the figure goes; other commands nothing", () => {
	assert.equal(travelText("go ost", exits), "Unterwegs nach Klippenpfad …");
	assert.equal(travelText("ost", exits), "Unterwegs nach Klippenpfad …");
	assert.equal(travelText("geh möwenfels", exits), "Du fährst mit dem Kahn nach Möwenfels-Strand …");
	assert.equal(travelText("go nirgendwo", exits), null);
	assert.equal(travelText("beam graue-bucht", exits), "Du wirst gebeamt …");
	assert.equal(travelText("rudere", exits), "Du ruderst …");
	assert.equal(travelText("zug hafen", exits), "Du fährst mit dem Zug …");
	for (const line of ["zug", "zug sende 2 mehl nach hafen", "zug abholen", "say ost", "look", "move 3 4"]) assert.equal(travelText(line, exits), null, line);
});

test("every text has its English", () => {
	for (const line of ["go ost", "go möwenfels", "beam x", "rudere", "segle", "einschiffen", "ausschiffen", "zug hafen"]) {
		const de = travelText(line, exits)!, en = toEnglish(de);
		assert.notEqual(en, de, de);
	}
});
