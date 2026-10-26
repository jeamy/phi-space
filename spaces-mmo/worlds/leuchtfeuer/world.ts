// Leuchtfeuer, the first world on spaces-mmo (docs/spielidee.md): an archipelago in the fog. Five islands of 25 rooms:
// the Graue Insel where every character starts (the grey bay and the cliff path are drawn by hand, the other rooms by
// the seeded generator in islands.ts), Möwenfels in the north, the trading town Kupferhafen in the east, Tangriff with
// its wrecks and pearls in the south, and Nebelholm in the west, where nobody keeps the fire. Ferries join the islands;
// every island has a beacon, three have a market and an order board, and its people gather, keep fires, craft and
// trade (server/npc/economy.ts). Graphics: assets/CREDITS.md; items are drawn as glyphs until licensed item graphics
// exist.
import type { ExitDef, NpcDef, RoomDef, WorldDef } from "../../server/engine/world.ts";
import { ARRIVE, DOOR, land, OPPOSITE, plants, scatter, spot, type Cell, type Flora, type LandSpec, type Side } from "./islands.ts";

const ITEM_LOCKS = "get:all();drop:all();give:not guest()";

// `flora`: what grows on the island's grass (a place may say otherwise): no tree on the windy Möwenfels or on the reef
// ("Auf dem Riff wächst kein Baum"), birches and bushes on Nebelholm
const ISLANDS: Record<string, { name: string; ferry: string; aliases: string[]; flora: Flora }> = {
	grau: { name: "Graue Insel", ferry: "graue-insel", aliases: ["grau", "graueinsel", "heim"], flora: { flowers: 1, bushes: 1, trees: 0.6 } },
	moewe: { name: "Möwenfels", ferry: "möwenfels", aliases: ["moewenfels", "möwen", "moewen"], flora: { flowers: 0.6, bushes: 0.5, trees: 0 } },
	kupfer: { name: "Kupferhafen", ferry: "kupferhafen", aliases: ["kupfer", "hafen"], flora: { flowers: 0.5, bushes: 0.4, trees: 0.3 } },
	tang: { name: "Tangriff", ferry: "tangriff", aliases: ["riff", "tang"], flora: { flowers: 0.4, bushes: 0.3, trees: 0 } },
	nebel: { name: "Nebelholm", ferry: "nebelholm", aliases: ["holm", "nebel"], flora: { flowers: 0.3, bushes: 1, trees: 2 } },
};

type Place = { roomId: string; name: string; island: keyof typeof ISLANDS; at: [number, number]; desc: string; sea?: Side[]; beach?: number; soil?: LandSpec["soil"]; plaza?: LandSpec["plaza"]; ground?: string[]; spawn?: Cell; flora?: Flora };

const PLACES: Place[] = [
	// Graue Insel
	{
		roomId: "graue-bucht", name: "Graue Bucht", island: "grau", at: [1, 1],
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
		roomId: "klippenpfad", name: "Klippenpfad", island: "grau", at: [2, 1],
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
	{ roomId: "fischerdorf", name: "Fischerdorf", island: "grau", at: [0, 1], sea: ["n", "w"], plaza: { x: 15, y: 11, r: 2 }, desc: "Ein paar schiefe Hütten, Netze auf Gestellen, der Geruch von Teer und Salz. Ein Steg führt nach Westen in den Nebel, wo Nebelholm liegen soll." },
	{ roomId: "torfmoor", name: "Torfmoor", island: "grau", at: [0, 2], sea: ["w", "s"], beach: 1, flora: { flowers: 0.4, bushes: 0.6, trees: 0.3 }, desc: "Weicher, federnder Boden, braune Tümpel, Wollgras. Am Ufer liegt Tang in dicken Wülsten." },
	{ roomId: "duenen", name: "Dünen", island: "grau", at: [1, 2], soil: ".", flora: { flowers: 0.3, bushes: 0.3, trees: 0 }, desc: "Sandhügel mit Strandhafer, der im Wind flüstert. Von hier sieht man bei klarem Wetter alle Wege der Insel." },
	{ roomId: "salzwiesen", name: "Salzwiesen", island: "grau", at: [2, 2], sea: ["e", "s"], flora: { flowers: 1.3, bushes: 0.4, trees: 0 }, desc: "Flache Wiesen, die die Springflut überschwemmt. Zwischen den Prielen bleibt allerlei hängen." },
	{ roomId: "klippenkopf", name: "Klippenkopf", island: "grau", at: [3, 1], sea: ["n", "e", "s"], desc: "Das Ende der Klippen. Zwei Stege hängen über der Brandung: nach Norden zum Möwenfels, nach Osten nach Kupferhafen." },
	{ roomId: "anleger", name: "Anleger", island: "grau", at: [1, 3], sea: ["w", "e", "s"], plaza: { x: 7, y: 5, r: 2 }, desc: "Der alte Anleger der Insel, Pfähle voller Muscheln. Von hier setzt der Kahn nach Süden zum Tangriff über; ein Feuerkorb soll den Booten leuchten." },
	// Möwenfels
	{ roomId: "moewenfels-strand", name: "Möwenstrand", island: "moewe", at: [3, -1], sea: ["w", "s"], desc: "Ein Kiesstrand unter einem Felsen voller Möwen. Ihr Geschrei übertönt fast die Brandung." },
	{ roomId: "vogelklippen", name: "Vogelklippen", island: "moewe", at: [4, -1], sea: ["e", "s"], desc: "Steile Klippen, weiß von Vogelmist. In den Spalten liegen Muscheln, die die Möwen fallen ließen." },
	{ roomId: "moewennest", name: "Möwennest", island: "moewe", at: [3, -2], sea: ["n", "w"], desc: "Eine windige Hochfläche mit niedrigen Steinmauern. Eier, Federn, und ein Blick über das ganze Nebelmeer." },
	{ roomId: "alte-warte", name: "Alte Warte", island: "moewe", at: [4, -2], sea: ["n", "e"], plaza: { x: 7, y: 10, r: 2 }, desc: "Der Stumpf eines alten Leuchtturms. Sein Feuer ist das nördlichste des Archipels; brennt es, sehen es die Schiffe von weit her." },
	// Kupferhafen
	{ roomId: "kupferhafen-kai", name: "Kai von Kupferhafen", island: "kupfer", at: [5, 1], sea: ["w", "n", "s"], beach: 1, desc: "Ein gemauerter Kai mit Pollern und Kränen. Fässer, Kisten, Rufe. Ein Steg führt nach Westen zum Klippenkopf." },
	{ roomId: "kupferhafen-markt", name: "Markt von Kupferhafen", island: "kupfer", at: [6, 1], plaza: { x: 12, y: 8, r: 5 }, desc: "Ein großer Pflasterplatz mit Ständen unter Segeltuch. Hier wird alles gehandelt, was das Meer hergibt; das Marktbrett ist das größte im Archipel." },
	{ roomId: "werft", name: "Werft", island: "kupfer", at: [6, 0], sea: ["n", "w", "e"], desc: "Ein halbfertiger Rumpf auf Böcken, Späne, der Geruch von Pech. Die Werft braucht Seile und Netze, immer." },
	{ roomId: "speicher", name: "Speicher", island: "kupfer", at: [7, 1], sea: ["n", "e", "s"], desc: "Lagerhäuser mit Ladeluken, die ins Wasser gehen. Hier warten Waren auf ein Schiff, das vielleicht nie kommt." },
	{ roomId: "hafenviertel", name: "Hafenviertel", island: "kupfer", at: [6, 2], sea: ["w", "e", "s"], desc: "Enge Gassen, Schenken, Wäsche zwischen den Häusern. Ein Steg im Süden führt zum Kahn nach Tangriff." },
	// Tangriff
	{ roomId: "tang-strand", name: "Tangstrand", island: "tang", at: [1, 5], sea: ["n", "w"], beach: 3, desc: "Ein Strand, an dem der Tang knietief liegt. Ein Steg im Norden: der Kahn zum Anleger der Grauen Insel." },
	{ roomId: "riffdorf", name: "Riffdorf", island: "tang", at: [2, 5], sea: ["n", "e"], plaza: { x: 8, y: 11, r: 3 }, desc: "Pfahlhäuser über dem Riff, ein Platz mit Marktbrett und Feuer. Ein Steg im Osten: der Kahn nach Kupferhafen." },
	{ roomId: "wrackbucht", name: "Wrackbucht", island: "tang", at: [1, 6], sea: ["w", "s"], beach: 3, desc: "Das Gerippe eines Schiffs ragt aus dem Sand. Nach jedem Sturm liegt neues Strandgut zwischen den Spanten, manchmal Bernstein." },
	{ roomId: "perlengrund", name: "Perlengrund", island: "tang", at: [2, 6], sea: ["e", "s"], beach: 3, desc: "Flaches, klares Wasser über weißem Sand. Wer Glück hat, findet hier eine Perle in einer Muschel." },
	// Nebelholm
	{ roomId: "nebelholm-ufer", name: "Ufer von Nebelholm", island: "nebel", at: [-2, 1], sea: ["n", "e"], desc: "Grauer Sand, grauer Himmel, graues Wasser. Ein morscher Steg im Osten führt zurück zum Fischerdorf." },
	{ roomId: "moorwald", name: "Moorwald", island: "nebel", at: [-3, 1], sea: ["n", "w"], flora: { flowers: 0.2, bushes: 1, trees: 3 }, desc: "Krumme Birken im Moor, Flechten wie Bärte. Man hört Schritte, wo keine sind." },
	{ roomId: "steinkreis", name: "Steinkreis", island: "nebel", at: [-2, 2], sea: ["e", "s"], plaza: { x: 8, y: 5, r: 2 }, desc: "Ein Kreis aus hohen Steinen um eine alte Feuerstelle. Niemand hütet sie; wer sie entzündet, vertreibt den Nebel von ganz Nebelholm." },
	{ roomId: "verlorener-hain", name: "Verlorener Hain", island: "nebel", at: [-3, 2], sea: ["w", "s"], flora: { flowers: 0.6, bushes: 1, trees: 3 }, desc: "Ein Hain, der auf keiner Karte steht. Zwischen den Wurzeln liegt, was andere verloren haben." },
];

/** Ferries (a pier on each side): [room, side of its pier, room, side of its pier]. */
const FERRIES: Array<[string, Side, string, Side]> = [
	["klippenkopf", "n", "moewenfels-strand", "s"],
	["klippenkopf", "e", "kupferhafen-kai", "w"],
	["anleger", "s", "tang-strand", "n"],
	["fischerdorf", "w", "nebelholm-ufer", "e"],
	["hafenviertel", "s", "riffdorf", "e"],
];

const STEP: Record<Side, [number, number]> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const WAY: Record<Side, { name: string; aliases: string[] }> = {
	n: { name: "nord", aliases: ["n", "norden", "north"] },
	e: { name: "ost", aliases: ["o", "osten", "east", "e"] },
	s: { name: "süd", aliases: ["s", "sued", "süden", "sueden", "south"] },
	w: { name: "west", aliases: ["w", "westen"] },
};
const byId = new Map(PLACES.map((p) => [p.roomId, p]));
/** The neighbour on the same island one step to `side` on the overview. */
const neighbour = (p: Place, side: Side) => PLACES.find((q) => q.island === p.island && q.at[0] === p.at[0] + STEP[side][0] && q.at[1] === p.at[1] + STEP[side][1]);
const ferriesOf = (roomId: string) => FERRIES.flatMap(([a, sa, b, sb]) => (a === roomId ? [{ side: sa, to: b, toSide: sb }] : b === roomId ? [{ side: sb, to: a, toSide: sa }] : []));

const ROOMS: RoomDef[] = PLACES.map((p) => {
	const doors = [...(["n", "e", "s", "w"] as Side[]).filter((s) => neighbour(p, s)), ...ferriesOf(p.roomId).map((f) => f.side)];
	const ground = p.ground ?? land({ seed: p.roomId, sea: p.sea ?? [], doors, ...(p.beach !== undefined ? { beach: p.beach } : {}), ...(p.soil ? { soil: p.soil } : {}), ...(p.plaza ? { plaza: p.plaza } : {}) });
	return { roomId: p.roomId, name: p.name, desc: p.desc, ground, spawn: p.spawn ?? spot(ground, { x: 12, y: 8 }, ".,:"), map: { x: p.at[0], y: p.at[1] }, island: ISLANDS[p.island]!.name };
});
const ground = (roomId: string) => ROOMS.find((r) => r.roomId === roomId)!.ground;
/** A free cell of grass or sand near (x, y) in a room: for NPCs and things. */
const near = (roomId: string, x: number, y: number) => spot(ground(roomId), { x, y });

const EXITS: ExitDef[] = [
	// the first two ways, as they always were
	{ exitId: "bucht-ost", name: "ost", aliases: ["o", "osten", "east", "e", "klippenpfad"], desc: "Der Strand wird zum Pfad, der auf die Klippen führt.", room: "graue-bucht", destination: "klippenpfad", x: 23, y: 8, arrive: { x: 1, y: 8 }, fogMax: 2 },
	{ exitId: "pfad-west", name: "west", aliases: ["w", "westen", "bucht"], desc: "Hinunter zur Grauen Bucht.", room: "klippenpfad", destination: "graue-bucht", x: 0, y: 8, arrive: { x: 22, y: 8 }, fogMax: 2 },
	...PLACES.flatMap((p) => (["n", "e", "s", "w"] as Side[]).flatMap((side): ExitDef[] => {
		const q = neighbour(p, side);
		if (!q || (p.roomId === "graue-bucht" && side === "e") || (p.roomId === "klippenpfad" && side === "w")) return [];
		return [{ exitId: `${p.roomId}-${WAY[side].name}`, name: WAY[side].name, aliases: [...WAY[side].aliases, q.roomId], desc: `Nach ${q.name}.`, room: p.roomId, destination: q.roomId, ...DOOR[side], arrive: ARRIVE[OPPOSITE[side]], fogMax: 2 }];
	})),
	...PLACES.flatMap((p) => {
		const fs = ferriesOf(p.roomId);
		return fs.map((f): ExitDef => {
			const isl = ISLANDS[byId.get(f.to)!.island]!;
			return { exitId: `${p.roomId}-faehre-${f.to}`, name: isl.ferry, aliases: [...isl.aliases, f.to, ...(fs.length === 1 ? ["fähre", "faehre", "ferry", "kahn"] : [])], desc: `Ein Kahn setzt über nach ${isl.name} (${byId.get(f.to)!.name}).`, room: p.roomId, destination: f.to, ...DOOR[f.side], arrive: ARRIVE[f.toSide], fogMax: 2 };
		});
	}),
];

const FIRE_ALIASES = ["feuer", "fire", "beacon", "leuchtfeuer", "feuerkorb"];
const plazaOf = (roomId: string) => byId.get(roomId)!.plaza!;

const NPCS: NpcDef[] = [
	{
		npcId: "ines", name: "Ines", skin: 4, room: "graue-bucht", x: 10, y: 9, script: "waerter", beacon: "feuer-bucht",
		plan: { presentFromHour: 6, presentUntilHour: 22 }, // she goes home for the night (docs/weltzeit.md)
		model: {
			persona: "Ines hütet seit Jahren das Leuchtfeuer der Grauen Bucht. Sie ist ruhig, praktisch und ein wenig spöttisch, kennt jede Boje und jeden Stammgast und sorgt sich um das Licht. Sie bittet um Treibholz, wenn das Feuer schwach wird, und erklärt Neuen kurz, wie man es nährt. Sie weiß, dass man in Kupferhafen am besten handelt und dass auf Nebelholm niemand das Feuer hütet. Das Feuer brennt mit Treibholz (zehn Minuten je Stück), Holzbündeln (vierzig Minuten; Jorin im Fischerdorf macht sie aus drei Treibholz) oder Tran (eine Stunde; Marta verkauft ihn auf dem Markt von Kupferhafen, und manchmal spült ein Sturm ein Fass an). Kohle oder Torf gibt es im Archipel nicht, und das sagt sie auch so, statt etwas zu erfinden.",
			wake: ["fire.low", "fire.out", "spoken", "person.enters", "offer"], budgetDay: 40,
			dozing: ["Ines flickt ein Netz.", "Ines schaut in die Glut.", "Ines summt ein altes Lied."],
		},
	},
	{ npcId: "bo", name: "Bo", skin: 0, room: "graue-bucht", x: 20, y: 8, script: "faehrmann", route: ["graue-bucht", "klippenpfad"] },
	{
		npcId: "fremder", name: "Fremder", skin: 3, room: "klippenpfad", x: 14, y: 10, script: "wanderer",
		model: { persona: "Ein Fremder, der sich im dichten Nebel verlaufen hat. Er ist müde, misstrauisch und will nur wissen, wo das nächste Licht brennt. Er erzählt bruchstückhaft von einer Insel, die im Nebel verschwunden ist.", wake: ["fog.dense", "spoken"], budgetDay: 20, dozing: ["Der Fremde starrt in den Nebel."] },
		wanderer: { event: "fog.dense", cooldownMs: 30 * 60_000, stayMs: 10 * 60_000 },
	},
	// Graue Insel
	{ npcId: "hanne", name: "Hanne", skin: 1, room: "salzwiesen", ...near("salzwiesen", 8, 6), script: "sammler", home: ["salzwiesen", "anleger", "torfmoor"], market: "graue-bucht",
		prices: { treibholz: [0, 2], muschel: [0, 2], tang: [0, 1] },
		lines: ["Die Springflut bringt mehr als die Ebbe nimmt.", "Wer früh am Strand ist, findet das beste Holz.", "In Kupferhafen zahlen sie mehr, aber der Weg ist weit."] },
	{ npcId: "jorin", name: "Jorin", skin: 2, room: "fischerdorf", ...near("fischerdorf", 15, 8), script: "handwerker", home: ["fischerdorf"], market: "graue-bucht", crafts: ["holzbuendel", "muschelmesser", "tangseil"],
		prices: { treibholz: [1, 0], muschel: [1, 0], tang: [1, 0], holzbuendel: [0, 4], muschelmesser: [0, 5], tangseil: [0, 3] }, carry: [{ proto: "muschelmesser", count: 1 }, { proto: "muenze", count: 8 }],
		lines: ["Ein gutes Bündel brennt die halbe Nacht.", "Bring mir Holz, ich zahle in Münzen.", "Ohne scharfes Messer kein Bündel."] },
	{ npcId: "kalle", name: "Kalle", skin: 0, room: "graue-bucht", x: 4, y: 12, script: "haendler", route: ["graue-bucht", "kupferhafen-markt"],
		prices: { treibholz: [2, 3], muschel: [1, 3], holzbuendel: [4, 6], tangseil: [3, 5], perle: [4, 7], bernstein: [3, 6], netz: [8, 11] }, carry: [{ proto: "muenze", count: 12 }],
		lines: ["Kaufen, wo es reichlich ist, verkaufen, wo es fehlt.", "Die Fähre ist mein zweites Zuhause.", "Hast du was für mich? Ich zahle bar."] },
	{ npcId: "mats", name: "Mats", skin: 3, room: "anleger", ...near("anleger", 9, 7), script: "huter", beacon: "feuer-anleger", home: ["anleger", "salzwiesen"],
		prices: { treibholz: [2, 0], holzbuendel: [5, 0], tran: [6, 0] }, carry: [{ proto: "treibholz", count: 2 }, { proto: "muenze", count: 4 }],
		lines: ["Ohne den Feuerkorb findet kein Kahn den Anleger.", "Bringst du Holz, bekommst du Münzen."] },
	{ npcId: "tilde", name: "Tilde", skin: 4, room: "fischerdorf", ...near("fischerdorf", 6, 11), script: "plauderer", home: ["fischerdorf", "graue-bucht"],
		lines: ["Auf Nebelholm soll ein Feuer stehen, das keiner hütet.", "Mein Mann fuhr einmal nach Möwenfels und kam mit Eiern zurück, so groß wie Fäuste.", "Im Riffdorf finden sie Perlen. Sagen sie.", "Hast du schon die Wrackbucht gesehen? Nach Stürmen liegt da Bernstein."] },
	// Möwenfels
	{ npcId: "svea", name: "Svea", skin: 1, room: "alte-warte", ...near("alte-warte", 9, 11), script: "huter", beacon: "feuer-warte", home: ["alte-warte", "vogelklippen", "moewenfels-strand"],
		prices: { treibholz: [2, 0], holzbuendel: [5, 0], tran: [6, 0] }, carry: [{ proto: "treibholz", count: 2 }, { proto: "muenze", count: 4 }],
		lines: ["Die Warte war einst der höchste Turm des Archipels.", "Holz ist hier oben selten. Jedes Scheit zählt."] },
	{ npcId: "henning", name: "Henning", skin: 2, room: "moewenfels-strand", ...near("moewenfels-strand", 14, 6), script: "sammler", home: ["moewenfels-strand", "vogelklippen", "moewennest"], market: "kupferhafen-markt",
		prices: { muschel: [0, 2], treibholz: [0, 2], tang: [0, 1] },
		lines: ["Die Möwen lassen die schönsten Muscheln fallen.", "Einmal die Woche fahre ich nach Kupferhafen."] },
	// Kupferhafen
	{ npcId: "greta", name: "Greta", skin: 4, room: "kupferhafen-markt", ...near("kupferhafen-markt", 6, 4), script: "huter", beacon: "feuer-kai", home: ["kupferhafen-markt", "kupferhafen-kai", "speicher"],
		prices: { treibholz: [2, 0], holzbuendel: [5, 0], tran: [6, 0] }, carry: [{ proto: "treibholz", count: 3 }, { proto: "muenze", count: 8 }],
		lines: ["Der Markt lebt vom Licht. Ohne Feuer kommt kein Händler.", "Holz kaufe ich immer."] },
	{ npcId: "marta", name: "Marta", skin: 1, room: "kupferhafen-markt", ...near("kupferhafen-markt", 18, 12), script: "haendler", route: ["kupferhafen-markt"],
		prices: { perle: [5, 8], bernstein: [4, 7], tangseil: [3, 5], netz: [8, 12], muschel: [1, 2], holzbuendel: [4, 6], kette: [10, 15], tran: [4, 6] }, carry: [{ proto: "muenze", count: 20 }, { proto: "holzbuendel", count: 1 }, { proto: "tran", count: 4 }],
		lines: ["Perlen, Bernstein, Netze – ich zahle den besten Preis im Archipel.", "Was das Meer gibt, kaufe ich.", "Feilschen ist erlaubt. Biete mir etwas an."] },
	{ npcId: "piet", name: "Piet", skin: 0, room: "werft", ...near("werft", 12, 11), script: "handwerker", home: ["werft"], market: "kupferhafen-markt", crafts: ["tangseil", "netz", "kette"],
		prices: { tang: [1, 0], tangseil: [2, 0], muschel: [1, 0], bernstein: [3, 0], netz: [0, 10], kette: [0, 14] }, carry: [{ proto: "muschelmesser", count: 1 }, { proto: "muenze", count: 10 }, { proto: "tang", count: 2 }],
		lines: ["Ein Netz braucht zwei Seile und ein scharfes Messer.", "Tang! Ich brauche immer Tang.", "Eine Bernsteinkette bringt in Kupferhafen ein Vermögen."] },
	{ npcId: "ruben", name: "Ruben", skin: 3, room: "hafenviertel", ...near("hafenviertel", 8, 6), script: "haendler", route: ["kupferhafen-markt", "riffdorf"],
		prices: { perle: [4, 7], bernstein: [3, 6], tang: [1, 2], netz: [8, 11], treibholz: [1, 3], muschel: [1, 2] }, carry: [{ proto: "muenze", count: 12 }],
		lines: ["Zwischen Riff und Hafen bin ich zu Hause.", "Im Riffdorf ist Holz knapp, in Kupferhafen Perlen."] },
	{ npcId: "lotte", name: "Lotte", skin: 2, room: "hafenviertel", ...near("hafenviertel", 16, 6), script: "plauderer", home: ["hafenviertel", "kupferhafen-markt", "speicher"],
		lines: ["In der Schenke erzählen sie, der Fremde sei von einer versunkenen Insel.", "Wer die Alte Warte entzündet, dem winken die Schiffe.", "Mein Vetter hat einmal drei Perlen an einem Tag gefunden."] },
	// Tangriff
	{ npcId: "nele", name: "Nele", skin: 4, room: "riffdorf", ...near("riffdorf", 5, 9), script: "huter", beacon: "feuer-riff", home: ["riffdorf", "tang-strand"],
		prices: { treibholz: [3, 0], holzbuendel: [6, 0], tran: [7, 0] }, carry: [{ proto: "treibholz", count: 2 }, { proto: "muenze", count: 6 }],
		lines: ["Auf dem Riff wächst kein Baum. Holz kommt mit der Flut oder mit dem Kahn.", "Ich zahle gut für Holz."] },
	{ npcId: "jan", name: "Jan", skin: 0, room: "wrackbucht", ...near("wrackbucht", 14, 6), script: "sammler", home: ["wrackbucht", "perlengrund", "tang-strand"], market: "riffdorf",
		prices: { perle: [0, 5], bernstein: [0, 4], tang: [0, 1], muschel: [0, 1], treibholz: [0, 3] },
		lines: ["Nach dem Sturm ist die beste Zeit am Wrack.", "Perlen finde ich nur im flachen Wasser."] },
	{ npcId: "kaspar", name: "Kaspar", skin: 1, room: "tang-strand", ...near("tang-strand", 16, 9), script: "plauderer", home: ["tang-strand", "riffdorf"],
		lines: ["Der Kahn zur Grauen Insel fährt nur, wenn man den Weg sieht.", "Mein Großvater sagt, das Wrack war ein Schiff aus Kupferhafen.", "Tang stinkt, aber Piet in der Werft zahlt dafür."] },
	// Nebelholm
	{ npcId: "eske", name: "Eske", skin: 3, room: "moorwald", ...near("moorwald", 12, 10), script: "plauderer", home: ["moorwald", "verlorener-hain"],
		lines: ["Der Nebel hat Ohren.", "Im Steinkreis brannte einst ein Feuer, das nie ausging.", "Wer im Verlorenen Hain sucht, findet, was andere verloren haben."] },
];

export const world: WorldDef = {
	id: "leuchtfeuer",
	title: "Leuchtfeuer",
	version: 12,
	startHour: 8, // the world's clock starts at 08:00 of day 0 (docs/weltzeit.md)
	evening: { hour: 20 }, // a daily evening event
	tileSize: 32,
	tiles: {
		// water against sand: the autotile blocks 3..5 of the first row are the three frames of its waves
		"~": { sheet: "tilesets/Autotiles_Water.png", x: 208, y: 48, walk: false, auto: { blocks: [{ x: 192, y: 0 }, { x: 256, y: 0 }, { x: 320, y: 0 }], frameMs: 700 } },
		".": { sheet: "tilesets/Ground.png", x: 128, y: 224, walk: true }, // sand
		",": { sheet: "tilesets/Ground.png", x: 32, y: 32, walk: true }, // grass
		":": { sheet: "tilesets/Ground.png", x: 320, y: 128, walk: true }, // cobbles
	},
	// plants over the grass (islands.ts `plants`): white flowers, three of them tinted, herbs, two bushes, two small trees
	decor: {
		"*": { sheet: "tilesets/Plants.png", x: 0, y: 0, w: 32, h: 32 },
		"+": { sheet: "tilesets/Plants.png", x: 32, y: 0, w: 32, h: 32, tint: 0xffd54a },
		"o": { sheet: "tilesets/Plants.png", x: 64, y: 0, w: 32, h: 32, tint: 0xff9ec4 },
		"x": { sheet: "tilesets/Plants.png", x: 0, y: 0, w: 32, h: 32, tint: 0xc7a6ff },
		"i": { sheet: "tilesets/Plants.png", x: 96, y: 0, w: 32, h: 32 },
		"w": { sheet: "tilesets/Plants.png", x: 128, y: 0, w: 32, h: 32 },
		"v": { sheet: "tilesets/Plants.png", x: 160, y: 0, w: 32, h: 32 },
		"r": { sheet: "tilesets/Plants.png", x: 192, y: 0, w: 32, h: 32, upright: true },
		"b": { sheet: "tilesets/Plants.png", x: 224, y: 0, w: 32, h: 32, upright: true },
		"T": { sheet: "tilesets/Plants.png", x: 0, y: 32, w: 32, h: 64, upright: true },
		"A": { sheet: "tilesets/Plants.png", x: 32, y: 32, w: 32, h: 64, upright: true },
	},
	skins: ["Misc_George", "Misc_PixelFox", "Misc_Zetasis", "Misc_jcsnider", "Misc_Kibbelz"].map((n) => ({ sheet: `entities/${n}.png`, frameW: 32, frameH: 48 })),
	rooms: ROOMS,
	start: "graue-bucht",
	guestName: "Strandläufer",
	typeclasses: { Driftwood: "Item", Coin: "Item", Shell: "Item", Bundle: "Driftwood", Tool: "Item", Weed: "Item", Gem: "Item", Gear: "Item", Fuel: "Item" },
	prototypes: [
		{ key: "ding", parent: null, typeclass: "Item", name: "Ding", desc: "Etwas, das jemand verloren hat.", aliases: ["thing"], glyph: { shape: "square", color: "#9aa3ad" }, locks: ITEM_LOCKS },
		{ key: "treibholz", parent: "ding", typeclass: "Driftwood", name: "Treibholz", desc: "Ein Stück Holz, von der See glatt geschliffen. Es würde gut brennen.", aliases: ["holz", "driftwood", "wood"], glyph: { shape: "square", color: "#8a5a2b" }, icon: "items/treibholz.png", locks: ITEM_LOCKS },
		{ key: "muenze", parent: "ding", typeclass: "Coin", name: "Münze", desc: "Eine alte Münze mit einem Leuchtturm darauf.", aliases: ["muenze", "geld", "coin"], glyph: { shape: "circle", color: "#e4c13a" }, icon: "items/muenze.png", locks: ITEM_LOCKS },
		{ key: "holzbuendel", parent: "ding", typeclass: "Bundle", name: "Holzbündel", desc: "Drei Scheite, mit Tang zusammengeschnürt. Brennt lange.", aliases: ["buendel", "bündel", "bundle"], glyph: { shape: "square", color: "#5e3a1a" }, icon: "items/holzbuendel.png", locks: ITEM_LOCKS },
		{ key: "muschelmesser", parent: "ding", typeclass: "Tool", name: "Muschelmesser", desc: "Eine scharf geschliffene Muschel an einem Holzgriff. Stumpft mit der Zeit ab.", aliases: ["messer", "knife"], glyph: { shape: "diamond", color: "#c8d0d8" }, icon: "items/muschelmesser.png", locks: ITEM_LOCKS, wear: 5 },
		{ key: "muschel", parent: "ding", typeclass: "Shell", name: "Muschel", desc: "Eine rosa Muschel. Hält man sie ans Ohr, hört man die Flut.", aliases: ["shell"], glyph: { shape: "diamond", color: "#f0a6c0" }, icon: "items/muschel.png", locks: ITEM_LOCKS },
		{ key: "tang", parent: "ding", typeclass: "Weed", name: "Tang", desc: "Ein nasses Büschel Seetang. Getrocknet gibt er zähe Fasern.", aliases: ["seetang", "seaweed"], glyph: { shape: "circle", color: "#3f7d4a" }, icon: "items/tang.png", locks: ITEM_LOCKS },
		{ key: "tangseil", parent: "ding", typeclass: "Gear", name: "Tangseil", desc: "Ein Seil aus gedrehten Tangfasern, fest und salzig.", aliases: ["seil", "rope"], glyph: { shape: "square", color: "#6b8f4e" }, icon: "items/tangseil.png", locks: ITEM_LOCKS },
		{ key: "netz", parent: "ding", typeclass: "Gear", name: "Netz", desc: "Ein Fischernetz aus Tangseil. Die Werft und die Fischer zahlen gut dafür.", aliases: ["fischernetz", "net"], glyph: { shape: "diamond", color: "#9bb87a" }, icon: "items/netz.png", locks: ITEM_LOCKS },
		{ key: "perle", parent: "ding", typeclass: "Gem", name: "Perle", desc: "Eine milchweiße Perle, kaum größer als eine Erbse.", aliases: ["pearl"], glyph: { shape: "circle", color: "#f4f1e8" }, icon: "items/perle.png", locks: ITEM_LOCKS },
		{ key: "bernstein", parent: "ding", typeclass: "Gem", name: "Bernstein", desc: "Ein honigfarbener Stein, warm in der Hand. In ihm schläft ein Insekt.", aliases: ["amber"], glyph: { shape: "diamond", color: "#e89a2c" }, icon: "items/bernstein.png", locks: ITEM_LOCKS },
		{ key: "tran", parent: "ding", typeclass: "Fuel", name: "Tran", desc: "Ein kleines Fass Tran aus den Speichern von Kupferhafen. Er brennt lange und hell, riecht aber nach Fisch.", aliases: ["tranfass", "fass", "oel", "öl", "oil"], glyph: { shape: "circle", color: "#b8862b" }, icon: "items/tran.png", locks: ITEM_LOCKS },
		{ key: "kette", parent: "ding", typeclass: "Gem", name: "Bernsteinkette", desc: "Bernstein und Muscheln an einem Tangseil. Ein Schmuckstück für Kupferhafen.", aliases: ["halskette", "necklace"], glyph: { shape: "diamond", color: "#ffb347" }, icon: "items/kette.png", locks: ITEM_LOCKS },
	],
	objects: [
		{ itemId: "treibholz-1", proto: "treibholz", room: "graue-bucht", x: 5, y: 7 },
		{ itemId: "treibholz-2", proto: "treibholz", room: "graue-bucht", x: 17, y: 9 },
		{ itemId: "muschel-1", proto: "muschel", room: "graue-bucht", x: 14, y: 5 },
		{ itemId: "muschel-2", proto: "muschel", room: "klippenpfad", x: 12, y: 5 },
		// a few things in every other room, so a first walk finds something
		...ROOMS.filter((r) => r.roomId !== "graue-bucht" && r.roomId !== "klippenpfad").flatMap((r) => {
			const protos = r.island === "Tangriff" ? ["tang", "muschel", "treibholz"] : r.island === "Kupferhafen" ? ["muschel"] : ["treibholz", "muschel", "tang"];
			return scatter(r.ground, `${r.roomId}/things`, protos.length, ".,", [r.spawn]).map((c, i) => ({ itemId: `${r.roomId}-${i + 1}`, proto: protos[i]!, room: r.roomId, x: c.x, y: c.y }));
		}),
		{ itemId: "hain-bernstein", proto: "bernstein", room: "verlorener-hain", ...near("verlorener-hain", 6, 6) },
		{ itemId: "perlengrund-perle", proto: "perle", room: "perlengrund", ...near("perlengrund", 16, 10) },
	],
	exits: EXITS,
	help: [
		{ key: "intro", category: "Allgemein", text: "Willkommen im Archipel. Sieh dich mit „look“ (schau) um, sprich mit „say“ (sag), geh mit Klicks auf die Karte, den Pfeiltasten oder „go <richtung>“ (geh). Was am Strand liegt, hebst du mit „get <ding>“ (nimm) auf. Alle Befehle gelten auf Englisch und Deutsch. Oben links zeigt die Übersichtskarte alle Inseln." },
		{ key: "inseln", category: "Welt", text: "Fünf Inseln liegen im Nebel: die Graue Insel (hier beginnt jeder), Möwenfels im Norden, die Handelsstadt Kupferhafen im Osten, Tangriff mit Wrack und Perlen im Süden und Nebelholm im Westen, wo niemand das Feuer hütet. Fähren (Kähne) verbinden sie: am Klippenkopf nach Möwenfels und Kupferhafen, am Anleger nach Tangriff, im Fischerdorf nach Nebelholm, im Hafenviertel nach Tangriff. Ist der Nebel zu dicht, fährt kein Kahn – brennende Feuer halten die Wege offen." },
		{ key: "leuchtfeuer", category: "Welt", text: "Wo ein Leuchtfeuer brennt, ist der Nebel licht. Jede Insel hat eines; das erste steht im Kopfsteinring der Grauen Bucht. Treibholz ins Feuer legen (put treibholz in feuer, oder: lege holz ins feuer) hält es am Brennen; jedes Scheit gibt zehn Minuten, ein Holzbündel vierzig, ein Fass Tran eine Stunde (Tran gibt es bei Marta auf dem Markt von Kupferhafen). Ohne Feuer steigt der Nebel, bis er die Wege verschluckt; nur den Weg zum Feuer der eigenen Insel findet man immer. Die Hüterinnen und Hüter zahlen für Holz. „ruf“ zeigt, was du beigetragen hast; „kanal hafen <text>“ hören alle." },
		{ key: "handel", category: "Welt", text: "Tauschen: offer <dinge> an <person> [für <dinge>] (z. B. offer treibholz an Jorin für münze); die andere Seite nimmt mit accept an oder lehnt mit decline ab. Auch die Leute der Inseln tauschen: sprich sie an, sie sagen dir, was sie kaufen und verkaufen, und manche bieten dir von selbst etwas an. Märkte stehen an der Grauen Bucht, in Kupferhafen und im Riffdorf: markt zeigt die Angebote, markt biete <ding> für <n>, markt kaufe <nr>, markt zurück <nr>; die Preise sind auf jeder Insel andere. Handwerk: craft zeigt die Rezepte, craft <rezept> stellt her. Aufträge hängen an denselben Orten: auftrag, auftrag nimm <nr>, auftrag liefere. Gäste können nicht tauschen oder handeln." },
		{ key: "sturmflut", category: "Welt", text: "Ab und zu wirft eine Sturmflut viel Strandgut auf einen Strand, manchmal Bernstein und Perlen. Der Hafenkanal meldet, wo; wer schnell ist, findet am meisten." },
		{ key: "bauen", category: "Bauen", text: "Builder formen die Welt: dig/grabe, open/öffne, create/erschaffe, spawn/erzeuge, set/setze, tag/markiere, lock/sperre, examine/untersuche, destroy/vernichte. Jeder Befehl gilt auf Englisch und Deutsch. „help <befehl>“ erklärt jeden. Lock-Strings: zugriff:ausdruck;… mit all(), none(), perm(Stufe), id(figur), holds(ding), guest(), not, and, or." },
	],
	beacons: [
		{ beaconId: "feuer-bucht", name: "Leuchtfeuer", aliases: ["feuer", "fire", "beacon", "leuchtturm"], room: "graue-bucht", x: 9, y: 10, covers: ["graue-bucht", "klippenpfad"] },
		{ beaconId: "feuer-anleger", name: "Feuerkorb am Anleger", aliases: FIRE_ALIASES, room: "anleger", x: plazaOf("anleger").x, y: plazaOf("anleger").y, covers: ["anleger", "duenen", "salzwiesen", "torfmoor", "fischerdorf", "klippenkopf"] },
		{ beaconId: "feuer-warte", name: "Feuer der Alten Warte", aliases: FIRE_ALIASES, room: "alte-warte", x: plazaOf("alte-warte").x, y: plazaOf("alte-warte").y, covers: ["alte-warte", "moewennest", "moewenfels-strand", "vogelklippen"] },
		{ beaconId: "feuer-kai", name: "Hafenfeuer", aliases: FIRE_ALIASES, room: "kupferhafen-markt", x: 9, y: 6, covers: ["kupferhafen-markt", "kupferhafen-kai", "werft", "speicher", "hafenviertel"] },
		{ beaconId: "feuer-riff", name: "Rifffeuer", aliases: FIRE_ALIASES, room: "riffdorf", x: plazaOf("riffdorf").x, y: plazaOf("riffdorf").y, covers: ["riffdorf", "tang-strand", "wrackbucht", "perlengrund"] },
		{ beaconId: "feuer-steinkreis", name: "Feuer im Steinkreis", aliases: FIRE_ALIASES, room: "steinkreis", x: plazaOf("steinkreis").x, y: plazaOf("steinkreis").y, covers: ["steinkreis", "nebelholm-ufer", "moorwald", "verlorener-hain"] },
	],
	fire: { fuel: { treibholz: 10 * 60_000, holzbuendel: 40 * 60_000, tran: 60 * 60_000 }, maxMs: 2 * 3600_000 },
	fog: { max: 3, start: 2, stepMs: 2 * 60_000 },
	flood: {
		everyMs: 60_000, lifetimeMs: 5 * 60_000,
		rooms: [
			{ room: "graue-bucht", tile: ".", max: 4 },
			{ room: "fischerdorf", tile: ".", max: 2 },
			{ room: "torfmoor", tile: ".", max: 2, protos: [{ proto: "tang", weight: 3 }, { proto: "treibholz", weight: 1 }] },
			{ room: "salzwiesen", tile: ".", max: 3 },
			{ room: "anleger", tile: ".", max: 2 },
			{ room: "klippenkopf", tile: ".", max: 2 },
			{ room: "moewenfels-strand", tile: ".", max: 3, protos: [{ proto: "muschel", weight: 3 }, { proto: "treibholz", weight: 2 }, { proto: "tang", weight: 1 }] },
			{ room: "vogelklippen", tile: ".", max: 2, protos: [{ proto: "muschel", weight: 1 }] },
			{ room: "kupferhafen-kai", tile: ".", max: 1 },
			{ room: "tang-strand", tile: ".", max: 3, protos: [{ proto: "tang", weight: 4 }, { proto: "treibholz", weight: 1 }] },
			{ room: "wrackbucht", tile: ".", max: 3, protos: [{ proto: "treibholz", weight: 4 }, { proto: "tang", weight: 2 }, { proto: "bernstein", weight: 1 }] },
			{ room: "perlengrund", tile: ".", max: 2, protos: [{ proto: "muschel", weight: 5 }, { proto: "perle", weight: 1 }] },
			{ room: "nebelholm-ufer", tile: ".", max: 2 },
			{ room: "verlorener-hain", tile: ".", max: 1, protos: [{ proto: "treibholz", weight: 3 }, { proto: "bernstein", weight: 1 }] },
		],
		protos: [{ proto: "treibholz", weight: 3 }, { proto: "muschel", weight: 1 }],
	},
	storm: {
		everyMs: 20 * 60_000, count: 6, channel: "hafen",
		rooms: ["wrackbucht", "tang-strand", "moewenfels-strand", "salzwiesen", "nebelholm-ufer", "fischerdorf", "perlengrund"],
		protos: [{ proto: "treibholz", weight: 5 }, { proto: "tang", weight: 3 }, { proto: "muschel", weight: 3 }, { proto: "bernstein", weight: 1 }, { proto: "perle", weight: 1 }, { proto: "tran", weight: 1 }],
	},
	channels: ["hafen"],
	npcs: NPCS,
	currency: "muenze",
	market: { rooms: ["graue-bucht", "kupferhafen-markt", "riffdorf"], listMs: 24 * 3600_000 },
	recipes: [
		{ key: "muschelmesser", name: "Muschelmesser", needs: [{ proto: "muschel", count: 2 }, { proto: "treibholz", count: 1 }], makes: "muschelmesser" },
		{ key: "holzbuendel", name: "Holzbündel", needs: [{ proto: "treibholz", count: 3 }], tool: "muschelmesser", makes: "holzbuendel" },
		{ key: "tangseil", name: "Tangseil", needs: [{ proto: "tang", count: 3 }], makes: "tangseil" },
		{ key: "netz", name: "Netz", needs: [{ proto: "tangseil", count: 2 }], tool: "muschelmesser", makes: "netz" },
		{ key: "kette", name: "Bernsteinkette", needs: [{ proto: "bernstein", count: 1 }, { proto: "muschel", count: 2 }, { proto: "tangseil", count: 1 }], tool: "muschelmesser", makes: "kette" },
	],
	orders: {
		rooms: ["graue-bucht", "kupferhafen-markt", "riffdorf"], max: 3, everyMs: 5 * 60_000, leaseMs: 30 * 60_000,
		kinds: [
			{ key: "holz", text: "Ines braucht 2 Treibholz für die Nacht.", needs: [{ proto: "treibholz", count: 2 }], reward: { proto: "muenze", count: 1 }, rooms: ["graue-bucht"] },
			{ key: "muscheln", text: "Bo sammelt Muscheln für Netzgewichte: 2 Stück.", needs: [{ proto: "muschel", count: 2 }], reward: { proto: "muenze", count: 1 }, rooms: ["graue-bucht"] },
			{ key: "buendel", text: "Für das Leuchtfeuer: ein Holzbündel.", needs: [{ proto: "holzbuendel", count: 1 }], reward: { proto: "muenze", count: 2 }, rooms: ["graue-bucht"] },
			{ key: "seile", text: "Die Werft braucht 2 Tangseile.", needs: [{ proto: "tangseil", count: 2 }], reward: { proto: "muenze", count: 4 }, rooms: ["kupferhafen-markt"] },
			{ key: "perle", text: "Ein Kaufmann aus dem Süden sucht eine Perle.", needs: [{ proto: "perle", count: 1 }], reward: { proto: "muenze", count: 6 }, rooms: ["kupferhafen-markt"] },
			{ key: "kaiholz", text: "Holz für die Kräne am Kai: 3 Treibholz.", needs: [{ proto: "treibholz", count: 3 }], reward: { proto: "muenze", count: 3 }, rooms: ["kupferhafen-markt"] },
			{ key: "kette", text: "Eine Braut in Kupferhafen wünscht sich eine Bernsteinkette.", needs: [{ proto: "kette", count: 1 }], reward: { proto: "muenze", count: 16 }, rooms: ["kupferhafen-markt"] },
			{ key: "netz", text: "Nele braucht ein Netz für die Riffischer.", needs: [{ proto: "netz", count: 1 }], reward: { proto: "muenze", count: 10 }, rooms: ["riffdorf"] },
			{ key: "riffholz", text: "Holz für das Rifffeuer: 2 Treibholz.", needs: [{ proto: "treibholz", count: 2 }], reward: { proto: "muenze", count: 3 }, rooms: ["riffdorf"] },
			{ key: "warte", text: "Für die Alte Warte: ein Fass Tran, das die ganze Nacht brennt.", needs: [{ proto: "tran", count: 1 }], reward: { proto: "muenze", count: 8 }, rooms: ["kupferhafen-markt"] },
			{ key: "bernstein", text: "Ein Sammler sucht Bernstein.", needs: [{ proto: "bernstein", count: 1 }], reward: { proto: "muenze", count: 5 }, rooms: ["riffdorf"] },
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

// The plants come last: they keep clear of everything placed above (the spawn, the ways in and out, people, fires,
// things). Ground stays as it is, the hand-drawn rooms included.
for (const r of world.rooms) {
	const p = byId.get(r.roomId)!;
	const keep: Cell[] = [r.spawn, ...world.npcs.filter((n) => n.room === r.roomId), ...world.beacons.filter((b) => b.room === r.roomId),
		...world.objects.filter((o) => o.room === r.roomId), ...world.exits.filter((e) => e.room === r.roomId),
		...world.exits.filter((e) => e.destination === r.roomId).map((e) => e.arrive)];
	r.decor = plants(r.ground, r.roomId, p.flora ?? ISLANDS[p.island]!.flora, keep);
}
