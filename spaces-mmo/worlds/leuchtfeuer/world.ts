// Leuchtfeuer, the first world on spaces-mmo (docs/spielidee.md): an archipelago in the fog. Phase 1: the grey bay
// where every character starts, the cliff path east of it, driftwood and shells on the sand. Graphics:
// assets/CREDITS.md; items are drawn as glyphs until licensed item graphics exist.
import type { WorldDef } from "../../server/engine/world.ts";

const ITEM_LOCKS = "get:all();drop:all();give:not guest()";

export const world: WorldDef = {
	id: "leuchtfeuer",
	title: "Leuchtfeuer",
	version: 5,
	tileSize: 32,
	tiles: {
		// water against sand: the autotile blocks 3..5 of the first row are the three frames of its waves
		"~": { sheet: "tilesets/Autotiles_Water.png", x: 208, y: 48, walk: false, auto: { blocks: [{ x: 192, y: 0 }, { x: 256, y: 0 }, { x: 320, y: 0 }], frameMs: 700 } },
		".": { sheet: "tilesets/Ground.png", x: 128, y: 224, walk: true }, // sand
		",": { sheet: "tilesets/Ground.png", x: 32, y: 32, walk: true }, // grass
		":": { sheet: "tilesets/Ground.png", x: 320, y: 128, walk: true }, // cobbles
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
		{
			roomId: "klippenpfad",
			name: "Klippenpfad",
			desc: "Ein gepflasterter Pfad zieht sich über das Gras an den Klippen entlang. Im Norden rauscht die See, irgendwo im Nebel schreit eine Möwe.",
			spawn: { x: 2, y: 8 },
			ground: [
				"~~~~~~~~~~~~~~~~~~~~~~~~",
				"~~~~~~~~~~~~~~~~~~~~~~~~",
				"~~~~~~~~~~~~~~~~~~~~~~~~",
				"~~~~~~~~~~~~~~~~~~~~~~~~",
				"~~~~~~~~~~...~~~~~~~~~~~",
				"~~~~~~~~.......~~~~~~~~~",
				"~~~~~,,,,,,,,,,,,~~~~~~~",
				",,,,,,,,,,,,,,,,,,,,,,,,",
				"::::::::::::::::::::,,,,",
				",,,,,,,,,,,,,,,,,,::,,,,",
				",,,,,,,,,,,,,,,,,,::,,,,",
				",,,,,,,,,,,,,,,,,,::,,,,",
				",,,,,,,,,,,,,,,,,,::,,,,",
				",,,,,,,,,,,,,,,,,,,,,,,,",
				",,,,,,,,,,,,,,,,,,,,,,,,",
				",,,,,,,,,,,,,,,,,,,,,,,,",
			],
		},
	],
	start: "graue-bucht",
	guestName: "Strandläufer",
	typeclasses: { Driftwood: "Item", Coin: "Item", Shell: "Item", Bundle: "Driftwood", Tool: "Item" },
	prototypes: [
		{ key: "ding", parent: null, typeclass: "Item", name: "Ding", desc: "Etwas, das jemand verloren hat.", aliases: ["thing"], glyph: { shape: "square", color: "#9aa3ad" }, locks: ITEM_LOCKS },
		{ key: "treibholz", parent: "ding", typeclass: "Driftwood", name: "Treibholz", desc: "Ein Stück Holz, von der See glatt geschliffen. Es würde gut brennen.", aliases: ["holz", "driftwood", "wood"], glyph: { shape: "square", color: "#8a5a2b" }, locks: ITEM_LOCKS },
		{ key: "muenze", parent: "ding", typeclass: "Coin", name: "Münze", desc: "Eine alte Münze mit einem Leuchtturm darauf.", aliases: ["muenze", "geld", "coin"], glyph: { shape: "circle", color: "#e4c13a" }, locks: ITEM_LOCKS },
		{ key: "holzbuendel", parent: "ding", typeclass: "Bundle", name: "Holzbündel", desc: "Drei Scheite, mit Tang zusammengeschnürt. Brennt lange.", aliases: ["buendel", "bündel", "bundle"], glyph: { shape: "square", color: "#5e3a1a" }, locks: ITEM_LOCKS },
		{ key: "muschelmesser", parent: "ding", typeclass: "Tool", name: "Muschelmesser", desc: "Eine scharf geschliffene Muschel an einem Holzgriff. Stumpft mit der Zeit ab.", aliases: ["messer", "knife"], glyph: { shape: "diamond", color: "#c8d0d8" }, locks: ITEM_LOCKS, wear: 5 },
		{ key: "muschel", parent: "ding", typeclass: "Shell", name: "Muschel", desc: "Eine rosa Muschel. Hält man sie ans Ohr, hört man die Flut.", aliases: ["shell"], glyph: { shape: "diamond", color: "#f0a6c0" }, locks: ITEM_LOCKS },
	],
	objects: [
		{ itemId: "treibholz-1", proto: "treibholz", room: "graue-bucht", x: 5, y: 7 },
		{ itemId: "treibholz-2", proto: "treibholz", room: "graue-bucht", x: 17, y: 9 },
		{ itemId: "muschel-1", proto: "muschel", room: "graue-bucht", x: 14, y: 5 },
		{ itemId: "muschel-2", proto: "muschel", room: "klippenpfad", x: 12, y: 5 },
	],
	exits: [
		{ exitId: "bucht-ost", name: "ost", aliases: ["o", "osten", "east", "e", "klippenpfad"], desc: "Der Strand wird zum Pfad, der auf die Klippen führt.", room: "graue-bucht", destination: "klippenpfad", x: 23, y: 8, arrive: { x: 1, y: 8 }, fogMax: 2 },
		{ exitId: "pfad-west", name: "west", aliases: ["w", "westen", "bucht"], desc: "Hinunter zur Grauen Bucht.", room: "klippenpfad", destination: "graue-bucht", x: 0, y: 8, arrive: { x: 22, y: 8 }, fogMax: 2 },
	],
	help: [
		{ key: "intro", category: "Allgemein", text: "Willkommen im Archipel. Sieh dich mit „look“ (schau) um, sprich mit „say“ (sag), geh mit Klicks auf die Karte, den Pfeiltasten oder „go <richtung>“ (geh). Was am Strand liegt, hebst du mit „get <ding>“ (nimm) auf. Alle Befehle gelten auf Englisch und Deutsch." },
		{ key: "leuchtfeuer", category: "Welt", text: "Wo ein Leuchtfeuer brennt, ist der Nebel licht. Das erste steht im Kopfsteinring der Grauen Bucht. Treibholz ins Feuer legen (put treibholz in feuer, oder: lege holz ins feuer) hält es am Brennen; jedes Scheit gibt zehn Minuten. Ohne Feuer steigt der Nebel, bis er die Wege verschluckt. „ruf“ zeigt, was du beigetragen hast; „kanal hafen <text>“ hören alle." },
		{ key: "handel", category: "Welt", text: "Tauschen: offer <dinge> an <person> [für <dinge>] (z. B. offer treibholz, muschel an Bert für münze); die andere Seite nimmt mit accept an oder lehnt mit decline ab. Markt (an der Grauen Bucht): markt zeigt die Angebote, markt biete <ding> für <n>, markt kaufe <nr>, markt zurück <nr>. Handwerk: craft zeigt die Rezepte, craft <rezept> stellt her. Aufträge: auftrag, auftrag nimm <nr>, auftrag liefere. Gäste können nicht tauschen oder handeln." },
		{ key: "bauen", category: "Bauen", text: "Builder formen die Welt: dig/grabe, open/öffne, create/erschaffe, spawn/erzeuge, set/setze, tag/markiere, lock/sperre, examine/untersuche, destroy/vernichte. Jeder Befehl gilt auf Englisch und Deutsch. „help <befehl>“ erklärt jeden. Lock-Strings: zugriff:ausdruck;… mit all(), none(), perm(Stufe), id(figur), holds(ding), guest(), not, and, or." },
	],
	beacons: [
		{ beaconId: "feuer-bucht", name: "Leuchtfeuer", aliases: ["feuer", "fire", "beacon", "leuchtturm"], room: "graue-bucht", x: 9, y: 10, covers: ["graue-bucht", "klippenpfad"] },
	],
	fire: { fuel: { treibholz: 10 * 60_000, holzbuendel: 40 * 60_000 }, maxMs: 2 * 3600_000 },
	fog: { max: 3, start: 2, stepMs: 2 * 60_000 },
	flood: { everyMs: 60_000, lifetimeMs: 5 * 60_000, rooms: [{ room: "graue-bucht", tile: ".", max: 4 }], protos: [{ proto: "treibholz", weight: 3 }, { proto: "muschel", weight: 1 }] },
	channels: ["hafen"],
	npcs: [
		{ npcId: "ines", name: "Ines", skin: 4, room: "graue-bucht", x: 10, y: 9, script: "waerter", beacon: "feuer-bucht" },
		{ npcId: "bo", name: "Bo", skin: 0, room: "graue-bucht", x: 20, y: 8, script: "faehrmann" },
	],
	currency: "muenze",
	market: { room: "graue-bucht", listMs: 24 * 3600_000 },
	recipes: [
		{ key: "muschelmesser", name: "Muschelmesser", needs: [{ proto: "muschel", count: 2 }, { proto: "treibholz", count: 1 }], makes: "muschelmesser" },
		{ key: "holzbuendel", name: "Holzbündel", needs: [{ proto: "treibholz", count: 3 }], tool: "muschelmesser", makes: "holzbuendel" },
	],
	orders: {
		room: "graue-bucht", max: 3, everyMs: 5 * 60_000, leaseMs: 30 * 60_000,
		kinds: [
			{ key: "holz", text: "Ines braucht 2 Treibholz für die Nacht.", needs: [{ proto: "treibholz", count: 2 }], reward: { proto: "muenze", count: 1 } },
			{ key: "muscheln", text: "Bo sammelt Muscheln für Netzgewichte: 2 Stück.", needs: [{ proto: "muschel", count: 2 }], reward: { proto: "muenze", count: 1 } },
			{ key: "buendel", text: "Für das Leuchtfeuer: ein Holzbündel.", needs: [{ proto: "holzbuendel", count: 1 }], reward: { proto: "muenze", count: 2 } },
		],
	},
	dig: {
		desc: "Ein neu entdecktes Stück Land im Nebel.",
		spawn: { x: 12, y: 8 },
		ground: [
			"~~~~~~~~~~~~~~~~~~~~~~~~",
			"~~~~~~~~~~~~~~~~~~~~~~~~",
			"~~~~~~~~~~~~~~~~~~~~~~~~",
			"~~~~~~..........~~~~~~~~",
			"~~~~................~~~~",
			"~~~..,,,,,,,,,,,,,...~~~",
			"~~..,,,,,,,,,,,,,,,,..~~",
			"~...,,,,,,,,,,,,,,,,,..~",
			"....,,,,,,,,,,,,,,,,,...",
			"~...,,,,,,,,,,,,,,,,,..~",
			"~~..,,,,,,,,,,,,,,,,..~~",
			"~~~..,,,,,,,,,,,,,,...~~",
			"~~~~................~~~~",
			"~~~~~~..........~~~~~~~~",
			"~~~~~~~~~~~~~~~~~~~~~~~~",
			"~~~~~~~~~~~~~~~~~~~~~~~~",
		],
	},
};
