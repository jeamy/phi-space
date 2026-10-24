// Leuchtfeuer, the first world on spaces-mmo (docs/spielidee.md): an archipelago in the fog. Phase 0 has one room, the
// grey bay where every character starts. Graphics: assets/CREDITS.md.
import type { WorldDef } from "../../server/engine/world.ts";

export const world: WorldDef = {
	id: "leuchtfeuer",
	title: "Leuchtfeuer",
	tileSize: 32,
	tiles: {
		"~": { sheet: "tilesets/Autotiles_Water.png", x: 16, y: 48, walk: false }, // the inner water of the first autotile
		".": { sheet: "tilesets/Ground.png", x: 128, y: 224, walk: true }, // sand
		",": { sheet: "tilesets/Ground.png", x: 32, y: 32, walk: true }, // grass
		":": { sheet: "tilesets/Ground.png", x: 320, y: 128, walk: true }, // cobbles where the beacon will stand
	},
	skins: ["Misc_George", "Misc_PixelFox", "Misc_Zetasis", "Misc_jcsnider", "Misc_Kibbelz"].map((n) => ({ sheet: `entities/${n}.png`, frameW: 32, frameH: 48 })),
	rooms: [
		{
			roomId: "graue-bucht",
			name: "Graue Bucht",
			desc: "Ein flacher Strand unter tiefem Nebel. Die Flut leckt am Sand, und auf dem Kopfsteinplatz in der Mitte ist noch kein Feuer entzündet.",
			spawn: { x: 10, y: 8 },
			ground: [
				"~~~~~~~~~~~~~~~~~~~~~~~~",
				"~~~~~~~~~~~~~~~~~~~~~~~~",
				"~~~~~~~~~~~~~~~~~~~~~~~~",
				"~~~~~~~~~...~~~~~~~~~~~~",
				"~~~~~.........~~~~~~~~~~",
				"~~~..............~~~~~~~",
				"~~.................~~~~~",
				"~.......................",
				"........................",
				"........::::............",
				",,,.....:..:....,,,,,,,,",
				",,,,,,..:..:..,,,,,,,,,,",
				",,,,,,,,::::,,,,,,,,,,,,",
				",,,,,,,,,,,,,,,,,,,,,,,,",
				",,,,,,,,,,,,,,,,,,,,,,,,",
				",,,,,,,,,,,,,,,,,,,,,,,,",
			],
		},
	],
	start: "graue-bucht",
	guestName: "Strandläufer",
	help: [
		"Befehle:",
		"  look            sich umsehen: Ort, Beschreibung, wer hier ist",
		"  say <text>      etwas sagen; alle hier hören es (kurz: '<text>)",
		"  who             wer gerade spielt",
		"  move <x> <y>    zu einer Stelle gehen; Klick auf die Karte oder Pfeiltaste: ein Schritt",
		"  help            diese Hilfe",
	],
};
