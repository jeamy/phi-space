// Leuchtfeuer, the first world on spaces-mmo (docs/spielidee.md): an archipelago in the fog. Eight islands of 37 rooms:
// the Graue Insel where every character starts (the grey bay and the cliff path are drawn by hand, the other rooms by
// the seeded generator in islands.ts), Möwenfels in the north, the trading town Kupferhafen in the east, Tangriff with
// its wrecks and pearls in the south, and Nebelholm in the west, where nobody keeps the fire; beyond them the Schären,
// Rauchholm and Krabbensand, each with a bay where newcomers can start. Ferries join the islands;
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
	schaer: { name: "Schären", ferry: "schären", aliases: ["schaeren", "schaer", "robben"], flora: { flowers: 0.5, bushes: 0.3, trees: 0 } },
	rauch: { name: "Rauchholm", ferry: "rauchholm", aliases: ["rauch", "koehler", "köhler"], flora: { flowers: 0.3, bushes: 0.8, trees: 1.5 } },
	krabbe: { name: "Krabbensand", ferry: "krabbensand", aliases: ["krabben", "krabbe", "watt"], flora: { flowers: 0.8, bushes: 0.4, trees: 0.2 } },
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
	// Schären (north-east, beyond the Alte Warte): every new island group has a bay where newcomers can start, with its
	// own fire, keeper, market and board
	{ roomId: "schaerenhafen", name: "Schärenhafen", island: "schaer", at: [6, -2], sea: ["w", "s"], plaza: { x: 9, y: 9, r: 2 }, desc: "Ein kleiner Hafen zwischen glatt geschliffenen Felsen. Ein Feuerring auf dem Platz, ein Marktbrett, und im Westen ein Steg zur Alten Warte." },
	{ roomId: "robbenbank", name: "Robbenbank", island: "schaer", at: [7, -2], sea: ["e", "s"], beach: 3, desc: "Eine flache Sandbank, auf der Robben dösen. Sie schauen jedem nach, der vorbeigeht." },
	{ roomId: "leuchtklippe", name: "Leuchtklippe", island: "schaer", at: [6, -3], sea: ["n", "w"], desc: "Ein kahler Fels hoch über dem Wasser. Von hier sieht man die Feuer von Möwenfels." },
	{ roomId: "seehundstrand", name: "Seehundstrand", island: "schaer", at: [7, -3], sea: ["n", "e"], beach: 3, desc: "Ein Kiesstrand voller Muscheln. Was die Robben übrig lassen, holt die Flut." },
	// Rauchholm (east, beyond the Speicher of Kupferhafen)
	{ roomId: "rauchhafen", name: "Rauchhafen", island: "rauch", at: [9, 1], sea: ["n", "w"], plaza: { x: 9, y: 9, r: 2 }, desc: "Ein rußiger Hafen, über dem immer eine Rauchfahne steht. Köhler bringen hier ihr Holz zum Markt; ein Steg im Westen führt nach Kupferhafen." },
	{ roomId: "koehlerwald", name: "Köhlerwald", island: "rauch", at: [10, 1], sea: ["n", "e"], flora: { flowers: 0.2, bushes: 1, trees: 3 }, desc: "Dichter Wald mit Meilern, die schwelen. Hier ist Holz nicht knapp." },
	{ roomId: "schwarzer-strand", name: "Schwarzer Strand", island: "rauch", at: [9, 2], sea: ["w", "s"], beach: 3, desc: "Schwarzer Sand, warm unter den Füßen. Zwischen den Steinen glänzt manchmal Bernstein." },
	{ roomId: "kraterhang", name: "Kraterhang", island: "rauch", at: [10, 2], sea: ["e", "s"], desc: "Ein alter Krater, mit Heidekraut bewachsen. Aus Spalten steigt warme Luft." },
	// Krabbensand (south, beyond the Perlengrund of Tangriff)
	{ roomId: "krabbenbucht", name: "Krabbenbucht", island: "krabbe", at: [2, 8], sea: ["n", "e"], plaza: { x: 9, y: 9, r: 2 }, desc: "Eine Bucht mit Pfahlhütten und Krabbenkörben. Auf dem Platz ein Feuerring und ein Marktbrett; im Norden der Kahn zum Perlengrund." },
	{ roomId: "salzgarten", name: "Salzgarten", island: "krabbe", at: [1, 8], sea: ["n", "w"], soil: ".", flora: { flowers: 1, bushes: 0.3, trees: 0 }, desc: "Flache Becken, in denen das Meerwasser verdunstet. Weiße Krusten, rosa Strandnelken." },
	{ roomId: "watt", name: "Watt", island: "krabbe", at: [1, 9], sea: ["w", "s"], beach: 4, desc: "Bei Ebbe ein weites, glänzendes Watt. Es knistert, wenn die Krabben graben." },
	{ roomId: "muschelbank", name: "Muschelbank", island: "krabbe", at: [2, 9], sea: ["e", "s"], beach: 3, desc: "Eine Bank aus Miesmuscheln, schwarz und blau. Manchmal steckt eine Perle darin." },
];

/** Ferries (a pier on each side): [room, side of its pier, room, side of its pier]. */
const FERRIES: Array<[string, Side, string, Side]> = [
	["klippenkopf", "n", "moewenfels-strand", "s"],
	["klippenkopf", "e", "kupferhafen-kai", "w"],
	["anleger", "s", "tang-strand", "n"],
	["fischerdorf", "w", "nebelholm-ufer", "e"],
	["hafenviertel", "s", "riffdorf", "e"],
	["alte-warte", "e", "schaerenhafen", "w"],
	["speicher", "e", "rauchhafen", "w"],
	["perlengrund", "s", "krabbenbucht", "n"],
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
	// Ines is a model role (she feeds nothing without the model, and goes home at night): Hinnerk keeps the bay's fire,
	// so the bay where people start does not lie in the fog when nobody plays (docs/lasttest-2026-10-28.md)
	{ npcId: "hinnerk", name: "Hinnerk", skin: 2, room: "graue-bucht", x: 7, y: 12, script: "huter", beacon: "feuer-bucht", home: ["graue-bucht", "klippenpfad"],
		prices: { treibholz: [2, 0], holzbuendel: [5, 0], tran: [6, 0] }, carry: [{ proto: "treibholz", count: 2 }, { proto: "muenze", count: 4 }],
		lines: ["Hier fangen alle an. Also muss hier Licht sein.", "Ein Scheit für das Feuer, eine Münze für dich."] },
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
		prices: { perle: [5, 8], bernstein: [4, 7], tangseil: [3, 5], netz: [8, 12], muschel: [1, 2], holzbuendel: [4, 6], kette: [10, 15], tran: [4, 6], mehl: [1, 3], brot: [2, 4], leinen: [4, 7], tuch: [6, 10], decke: [14, 22], kaese: [3, 6] }, carry: [{ proto: "muenze", count: 20 }, { proto: "holzbuendel", count: 1 }, { proto: "tran", count: 4 }],
		lines: ["Perlen, Bernstein, Netze – ich zahle den besten Preis im Archipel.", "Was das Meer gibt, kaufe ich.", "Feilschen ist erlaubt. Biete mir etwas an."] },
	{ npcId: "piet", name: "Piet", skin: 0, room: "werft", ...near("werft", 12, 11), script: "handwerker", home: ["werft"], market: "kupferhafen-markt", crafts: ["tangseil", "netz", "kette"],
		prices: { tang: [1, 0], tangseil: [2, 0], muschel: [1, 0], bernstein: [3, 0], netz: [0, 10], kette: [0, 14] }, carry: [{ proto: "muschelmesser", count: 1 }, { proto: "muenze", count: 10 }, { proto: "tang", count: 2 }],
		lines: ["Ein Netz braucht zwei Seile und ein scharfes Messer.", "Tang! Ich brauche immer Tang.", "Eine Bernsteinkette bringt in Kupferhafen ein Vermögen."] },
	{ npcId: "ruben", name: "Ruben", skin: 3, room: "hafenviertel", ...near("hafenviertel", 8, 6), script: "haendler", route: ["kupferhafen-markt", "riffdorf"],
		prices: { perle: [4, 7], bernstein: [3, 6], tang: [1, 2], netz: [8, 11], treibholz: [1, 3], muschel: [1, 2] }, carry: [{ proto: "muenze", count: 12 }],
		lines: ["Zwischen Riff und Hafen bin ich zu Hause.", "Im Riffdorf ist Holz knapp, in Kupferhafen Perlen."] },
	// the gardener (docs/siedeln.md "Gärten"): seeds from the flora of Kupferhafen, flowers and vegetables bought and sold
	{ npcId: "gesa", name: "Gesa", skin: 1, room: "hafenviertel", ...near("hafenviertel", 4, 10), script: "gaertnerin", home: ["kupferhafen-markt", "hafenviertel", "kupferhafen-kai"], market: "kupferhafen-markt",
		prices: { "samen-strandnelke": [1, 3], "samen-strandkohl": [1, 2], "samen-moehre": [1, 2], "samen-duenenrose": [2, 4], "samen-nebelblume": [4, 8], strandnelke: [2, 4], duenenrose: [3, 5], nebelblume: [6, 10], kohl: [1, 2], moehre: [1, 2],
			weizen: [1, 2], gerste: [1, 2], hafer: [1, 2], kartoffel: [1, 2], ruebe: [1, 2], "samen-ruebe": [1, 2], leinsamen: [1, 2], flachs: [1, 3],
			huhn: [2, 5], schaf: [5, 10], ziege: [4, 8], ei: [1, 2], wolle: [2, 4], milch: [1, 2], ente: [3, 6], gans: [4, 8], daunen: [2, 4], hund: [6, 12], katze: [3, 6] },
		carry: [{ proto: "muenze", count: 10 }, { proto: "samen-strandnelke", count: 2 }, { proto: "samen-strandkohl", count: 1 }, { proto: "weizen", count: 8 }, { proto: "kartoffel", count: 8 }, { proto: "huhn", count: 4 }, { proto: "schaf", count: 2 }, { proto: "ziege", count: 2 }, { proto: "ente", count: 3 }, { proto: "gans", count: 2 }, { proto: "hund", count: 2 }, { proto: "katze", count: 2 }],
		lines: ["Wer Samen will, muss erst Blumen wachsen lassen.", "Zwei Blumen nebeneinander im Zierbeet, und manchmal kommt etwas ganz Neues heraus.", "Auf Nebelholm blüht, was nirgends sonst wächst."] },
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
	// two more model roles, always there (Ines in the west; these in the east and the north): someone to talk with and
	// ask in every busy region. Without model calls they doze and speak their lines.
	{
		npcId: "merle", name: "Merle", skin: 1, room: "kupferhafen-markt", ...near("kupferhafen-markt", 14, 4), script: "waerter",
		model: {
			persona: "Merle zeichnet Seekarten in Kupferhafen und kennt jeden Weg im Archipel: welche Fähre wohin fährt (am Klippenkopf nach Möwenfels und Kupferhafen, am Anleger nach Tangriff, im Fischerdorf nach Nebelholm, im Hafenviertel nach Tangriff, an der Alten Warte zu den Schären, am Speicher nach Rauchholm, am Perlengrund nach Krabbensand), wo welches Strandgut liegt (Holz im Köhlerwald, Tang am Torfmoor und Tangstrand, Bernstein in der Wrackbucht und am Schwarzen Strand, Perlen im Perlengrund und an der Muschelbank) und wer was kauft (Marta zahlt für Perlen und Bernstein am besten, die Hüter für Holz). Sie ist freundlich, neugierig und tauscht gern Geschichten gegen Neuigkeiten. Sie erfindet keine Orte, die es nicht gibt.",
			wake: ["spoken", "person.enters", "offer"], budgetDay: 40,
			dozing: ["Merle zeichnet an einer Küstenlinie.", "Merle misst mit dem Zirkel eine Entfernung.", "Merle rollt eine Karte zusammen."],
		},
	},
	{
		npcId: "hark", name: "Hark", skin: 3, room: "schaerenhafen", ...near("schaerenhafen", 15, 11), script: "waerter",
		model: {
			persona: "Hark ist ein alter Kapitän, der nicht mehr fährt und in Schärenhafen auf der Kaimauer sitzt. Er hat den Nebel kommen sehen, kennt die Schären, Möwenfels und die Alte Warte, und erzählt gern, knapp und bärbeißig, von Stürmen, verlorenen Booten und davon, dass nur ein brennendes Feuer die Wege offen hält. Wer ihm zuhört, bekommt Rat: wo Holz zu finden ist, dass Arne das Schärenfeuer hütet und für Holz zahlt, dass Hauke am Markt kauft. Er erfindet keine Orte, die es nicht gibt.",
			wake: ["spoken", "person.enters", "offer"], budgetDay: 40,
			dozing: ["Hark stopft seine Pfeife.", "Hark schaut aufs Wasser.", "Hark brummt ein altes Seemannslied."],
		},
	},
	// Schären
	{ npcId: "arne", name: "Arne", skin: 0, room: "schaerenhafen", ...near("schaerenhafen", 11, 11), script: "huter", beacon: "feuer-schaeren", home: ["schaerenhafen", "leuchtklippe"],
		prices: { treibholz: [2, 0], holzbuendel: [5, 0], tran: [6, 0] }, carry: [{ proto: "treibholz", count: 2 }, { proto: "muenze", count: 4 }],
		lines: ["Zwischen den Schären verliert man sich schnell, wenn das Feuer aus ist.", "Holz kommt hier nur mit der Flut."] },
	{ npcId: "wiebke", name: "Wiebke", skin: 1, room: "robbenbank", ...near("robbenbank", 10, 6), script: "sammler", home: ["robbenbank", "seehundstrand", "leuchtklippe"], market: "schaerenhafen",
		prices: { muschel: [0, 2], treibholz: [0, 2], tang: [0, 1] },
		lines: ["Die Robben wissen, wo die Flut am meisten bringt.", "Auf dem Seehundstrand liegen die schönsten Muscheln."] },
	{ npcId: "hauke", name: "Hauke", skin: 3, room: "schaerenhafen", ...near("schaerenhafen", 16, 6), script: "haendler", route: ["schaerenhafen"],
		prices: { treibholz: [2, 3], muschel: [1, 3], tangseil: [3, 5], perle: [4, 7], netz: [8, 11] }, carry: [{ proto: "muenze", count: 10 }],
		lines: ["Was die Schären hergeben, kaufe ich.", "Nach Möwenfels ist es nur ein Kahn weit."] },
	// Rauchholm
	{ npcId: "frida", name: "Frida", skin: 4, room: "rauchhafen", ...near("rauchhafen", 11, 11), script: "huter", beacon: "feuer-rauch", home: ["rauchhafen", "koehlerwald"],
		prices: { treibholz: [1, 0], holzbuendel: [4, 0], tran: [5, 0] }, carry: [{ proto: "treibholz", count: 3 }, { proto: "muenze", count: 4 }],
		lines: ["Holz haben wir genug. Hände, die es tragen, nicht.", "Der Rauch hält den Nebel nicht ab, nur das Feuer."] },
	{ npcId: "okke", name: "Okke", skin: 2, room: "schwarzer-strand", ...near("schwarzer-strand", 12, 6), script: "sammler", home: ["schwarzer-strand", "kraterhang", "koehlerwald"], market: "rauchhafen",
		prices: { treibholz: [0, 2], bernstein: [0, 4], muschel: [0, 1] },
		lines: ["Am schwarzen Strand findet man Bernstein, wenn man Geduld hat.", "Im Köhlerwald liegt mehr Holz als irgendwo sonst."] },
	{ npcId: "bente", name: "Bente", skin: 1, room: "rauchhafen", ...near("rauchhafen", 16, 6), script: "haendler", route: ["rauchhafen"],
		prices: { treibholz: [1, 2], holzbuendel: [3, 5], bernstein: [3, 6], tran: [4, 6], muschel: [1, 2] }, carry: [{ proto: "muenze", count: 10 }, { proto: "holzbuendel", count: 1 }],
		lines: ["Holzbündel aus dem Köhlerwald, die besten im Archipel.", "In Kupferhafen zahlen sie für Holz das Doppelte."] },
	// Krabbensand
	{ npcId: "thies", name: "Thies", skin: 0, room: "krabbenbucht", ...near("krabbenbucht", 11, 11), script: "huter", beacon: "feuer-krabbe", home: ["krabbenbucht", "salzgarten"],
		prices: { treibholz: [3, 0], holzbuendel: [6, 0], tran: [7, 0] }, carry: [{ proto: "treibholz", count: 2 }, { proto: "muenze", count: 6 }],
		lines: ["Ohne Feuer finden die Krabbenkutter nicht heim.", "Holz ist hier so selten wie auf dem Riff."] },
	{ npcId: "imke", name: "Imke", skin: 4, room: "watt", ...near("watt", 12, 6), script: "sammler", home: ["watt", "muschelbank", "salzgarten"], market: "krabbenbucht",
		prices: { muschel: [0, 1], perle: [0, 5], tang: [0, 1], treibholz: [0, 3] },
		lines: ["Bei Ebbe gehört das Watt den Sammlern.", "In der Muschelbank stecken Perlen, aber selten."] },
	{ npcId: "momme", name: "Momme", skin: 3, room: "krabbenbucht", ...near("krabbenbucht", 16, 6), script: "haendler", route: ["krabbenbucht"],
		prices: { muschel: [1, 2], perle: [4, 7], tang: [1, 2], tangseil: [3, 5], treibholz: [2, 4] }, carry: [{ proto: "muenze", count: 10 }],
		lines: ["Krabben gegen Münzen, Muscheln gegen Holz.", "Der Kahn zum Perlengrund fährt, solange das Feuer brennt."] },
];

export const world: WorldDef = {
	id: "leuchtfeuer",
	title: "Leuchtfeuer",
	version: 26,
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
		"r": { sheet: "tilesets/Plants.png", x: 192, y: 0, w: 32, h: 32, upright: true, model: "berrybush" },
		"b": { sheet: "tilesets/Plants.png", x: 224, y: 0, w: 32, h: 32, upright: true, model: "bush" },
		"T": { sheet: "tilesets/Plants.png", x: 0, y: 32, w: 32, h: 64, upright: true, model: "tree" },
		"A": { sheet: "tilesets/Plants.png", x: 32, y: 32, w: 32, h: 64, upright: true, model: "conifer" },
	},
	skins: ["Misc_George", "Misc_PixelFox", "Misc_Zetasis", "Misc_jcsnider", "Misc_Kibbelz"].map((n) => ({ sheet: `entities/${n}.png`, frameW: 32, frameH: 48 })),
	rooms: ROOMS,
	start: "graue-bucht",
	// with SPACES_MMO_REGIONS each region is a space of its own (server/engine/regions.ts): only ferries cross between
	// them, and each has a bay where newcomers start
	regions: [
		{ regionId: "west", islands: ["Graue Insel", "Nebelholm"], start: "graue-bucht" },
		{ regionId: "nord", islands: ["Möwenfels", "Schären"], start: "schaerenhafen" },
		{ regionId: "ost", islands: ["Kupferhafen", "Tangriff", "Rauchholm"], start: "rauchhafen" },
		{ regionId: "sued", islands: ["Krabbensand"], start: "krabbenbucht" },
	],
	guestName: "Strandläufer",
	typeclasses: { Driftwood: "Item", Coin: "Item", Shell: "Item", Bundle: "Driftwood", Tool: "Item", Weed: "Item", Gem: "Item", Gear: "Item", Fuel: "Item", Seed: "Item", Produce: "Item", Livestock: "Item", Flower: "Item", Water: "Item" },
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
		// gardens (docs/siedeln.md "Gärten"): the spade, a can of water, seeds from the wild flora and what grows from them
		{ key: "spaten", parent: "ding", typeclass: "Tool", name: "Spaten", desc: "Ein Spaten aus Treibholz, das Blatt mit Tangseil festgezurrt. Damit gräbt man ein Beet um.", aliases: ["schaufel", "spade"], glyph: { shape: "diamond", color: "#a07850" }, icon: "items/spaten.png", locks: ITEM_LOCKS },
		{ key: "wasserkanne", parent: "ding", typeclass: "Water", name: "Kanne Wasser", desc: "Regenwasser aus der Tonne, genug für ein Beet.", aliases: ["kanne", "wasser", "water", "can"], glyph: { shape: "circle", color: "#5aa0d8" }, icon: "items/wasserkanne.png", locks: ITEM_LOCKS },
		{ key: "samen-strandnelke", parent: "ding", typeclass: "Seed", name: "Strandnelkensamen", desc: "Winzige Samen einer Strandnelke, in ein Blatt gewickelt.", aliases: ["nelkensamen", "strandnelke", "nelke"], glyph: { shape: "circle", color: "#c98aa0" }, icon: "items/samen-strandnelke.png", locks: ITEM_LOCKS },
		{ key: "samen-duenenrose", parent: "ding", typeclass: "Seed", name: "Dünenrosensamen", desc: "Harte Kerne aus einer Hagebutte der Dünenrose.", aliases: ["rosensamen", "dünenrose", "duenenrose", "rose"], glyph: { shape: "circle", color: "#b0485e" }, icon: "items/samen-duenenrose.png", locks: ITEM_LOCKS },
		{ key: "samen-nebelblume", parent: "ding", typeclass: "Seed", name: "Nebelblumensamen", desc: "Blasse, fast durchsichtige Samen. Sie wachsen nur, wo Nebel war.", aliases: ["nebelblume"], glyph: { shape: "circle", color: "#9fb0d0" }, icon: "items/samen-nebelblume.png", locks: ITEM_LOCKS },
		{ key: "samen-strandkohl", parent: "ding", typeclass: "Seed", name: "Strandkohlsamen", desc: "Runde Samen des wilden Strandkohls.", aliases: ["kohlsamen", "strandkohl", "kohl"], glyph: { shape: "circle", color: "#7a9a66" }, icon: "items/samen-strandkohl.png", locks: ITEM_LOCKS },
		{ key: "samen-moehre", parent: "ding", typeclass: "Seed", name: "Möhrensamen", desc: "Stachelige Samen der wilden Möhre.", aliases: ["moehrensamen", "möhre", "moehre", "karotte"], glyph: { shape: "circle", color: "#c88a3c" }, icon: "items/samen-moehre.png", locks: ITEM_LOCKS },
		{ key: "strandnelke", parent: "ding", typeclass: "Flower", name: "Strandnelke", desc: "Ein Büschel rosa Strandnelken. Hält sich lange.", aliases: ["nelken", "blume", "flower"], glyph: { shape: "diamond", color: "#e88fb0" }, icon: "items/strandnelke.png", locks: ITEM_LOCKS },
		{ key: "duenenrose", parent: "ding", typeclass: "Flower", name: "Dünenrose", desc: "Eine dornige Dünenrose, tiefrot und duftend.", aliases: ["rosen", "rose"], glyph: { shape: "diamond", color: "#d9476b" }, icon: "items/duenenrose.png", locks: ITEM_LOCKS },
		{ key: "nebelblume", parent: "ding", typeclass: "Flower", name: "Nebelblume", desc: "Eine blasse blaue Blüte, die im Halbdunkel leuchtet. Selten.", aliases: ["nebelblüte"], glyph: { shape: "diamond", color: "#9fb6e8" }, icon: "items/nebelblume.png", locks: ITEM_LOCKS },
		{ key: "kohl", parent: "ding", typeclass: "Produce", name: "Kohl", desc: "Ein fester Kopf Strandkohl, salzig und gut.", aliases: ["kohlkopf", "cabbage"], glyph: { shape: "circle", color: "#7fae6a" }, icon: "items/kohl.png", locks: ITEM_LOCKS },
		{ key: "moehre", parent: "ding", typeclass: "Produce", name: "Möhre", desc: "Eine krumme, süße Möhre mit Erde dran.", aliases: ["möhren", "moehren", "karotte", "carrot"], glyph: { shape: "circle", color: "#e8902c" }, icon: "items/moehre.png", locks: ITEM_LOCKS },
		// field crops (docs/siedeln.md "Äcker und Getreide"): grain is its own seed
		{ key: "weizen", parent: "ding", typeclass: "Produce", name: "Weizen", desc: "Eine Handvoll goldener Weizenkörner. Mehl daraus, oder Saatgut für die nächste Flur.", aliases: ["weizenkorn", "korn", "wheat"], glyph: { shape: "circle", color: "#d9b44a" }, icon: "items/weizen.png", locks: ITEM_LOCKS },
		{ key: "gerste", parent: "ding", typeclass: "Produce", name: "Gerste", desc: "Gerstenkörner mit langen Grannen. Wächst auch wild an den Rändern der Dünen.", aliases: ["gerstenkorn", "barley"], glyph: { shape: "circle", color: "#c8b06a" }, icon: "items/gerste.png", locks: ITEM_LOCKS },
		{ key: "hafer", parent: "ding", typeclass: "Produce", name: "Hafer", desc: "Lockere Haferrispen. Genügsam, er wächst auch im Nebel.", aliases: ["haferkorn", "oats"], glyph: { shape: "circle", color: "#cdbf8a" }, icon: "items/hafer.png", locks: ITEM_LOCKS },
		{ key: "kartoffel", parent: "ding", typeclass: "Produce", name: "Kartoffel", desc: "Eine Kartoffel mit Erde dran. Man isst sie, oder man legt sie als Saatkartoffel.", aliases: ["kartoffeln", "erdapfel", "potato"], glyph: { shape: "circle", color: "#b08a5a" }, icon: "items/kartoffel.png", locks: ITEM_LOCKS },
		{ key: "ruebe", parent: "ding", typeclass: "Produce", name: "Rübe", desc: "Eine dicke Rübe, rot im Schnitt. Futter für den Hof, süß im Winter.", aliases: ["rüben", "rueben", "runkelrübe", "beet"], glyph: { shape: "circle", color: "#9a3a5a" }, icon: "items/ruebe.png", locks: ITEM_LOCKS },
		{ key: "samen-ruebe", parent: "ding", typeclass: "Seed", name: "Rübensamen", desc: "Knubbelige Samenknäuel der wilden Strandrübe.", aliases: ["ruebensamen", "strandrübe", "strandruebe"], glyph: { shape: "circle", color: "#8a5a4a" }, icon: "items/samen-ruebe.png", locks: ITEM_LOCKS },
		{ key: "flachs", parent: "ding", typeclass: "Produce", name: "Flachs", desc: "Ein Bündel Flachsstängel. Daraus wird Leinen, für Segel und Netze.", aliases: ["lein", "flax"], glyph: { shape: "diamond", color: "#c9b88a" }, icon: "items/flachs.png", locks: ITEM_LOCKS },
		{ key: "leinsamen", parent: "ding", typeclass: "Seed", name: "Leinsamen", desc: "Glatte braune Samen des Flachses, der blau blüht.", aliases: ["flachssamen", "linseed"], glyph: { shape: "circle", color: "#8a6a3a" }, icon: "items/leinsamen.png", locks: ITEM_LOCKS },
		// what the mill, the bakery and the spindle make of them (docs/siedeln.md "Warenketten")
		{ key: "mehl", parent: "ding", typeclass: "Produce", name: "Mehl", desc: "Ein kleiner Sack Mehl aus der Windmühle. Im Backhaus wird Brot daraus.", aliases: ["flour", "mehlsack"], glyph: { shape: "square", color: "#e8e0cc" }, icon: "items/mehl.png", locks: ITEM_LOCKS },
		{ key: "brot", parent: "ding", typeclass: "Produce", name: "Brot", desc: "Ein runder Laib, die Kruste noch warm. Die Schenken und die Fischer zahlen gut dafür.", aliases: ["brote", "laib", "bread"], glyph: { shape: "circle", color: "#c88a3a" }, icon: "items/brot.png", locks: ITEM_LOCKS },
		{ key: "spindel", parent: "ding", typeclass: "Tool", name: "Spindel", desc: "Ein Holzstab mit einer Muschel als Wirtel. Damit spinnt man Flachs zu Garn.", aliases: ["handspindel", "spindle"], glyph: { shape: "diamond", color: "#b5674f" }, icon: "items/spindel.png", locks: ITEM_LOCKS, wear: 5 },
		{ key: "leinen", parent: "ding", typeclass: "Gear", name: "Leinen", desc: "Ein Ballen Leinen aus gesponnenem Flachs. Segel für Mühle und Werft werden daraus.", aliases: ["leinenballen", "tuch", "linen"], glyph: { shape: "square", color: "#e8e0cc" }, icon: "items/leinen.png", locks: ITEM_LOCKS },
		// animals on the farm (docs/siedeln.md "Tiere auf dem Hof"): carried as things, kept in a coop or pen, and what they give
		{ key: "huhn", parent: "ding", typeclass: "Livestock", name: "Huhn", desc: "Ein braunes Huhn, das empört gluckst, wenn man es trägt. Im Hühnerstall legt es jeden Tag ein Ei.", aliases: ["henne", "hühner", "huehner", "hen", "chicken"], glyph: { shape: "circle", color: "#b0703a" }, icon: "items/huhn.png", locks: ITEM_LOCKS },
		{ key: "schaf", parent: "ding", typeclass: "Livestock", name: "Schaf", desc: "Ein Inselschaf mit dichter Wolle. Es frisst sogar Tang vom Strand.", aliases: ["schafe", "sheep"], glyph: { shape: "circle", color: "#e8e4d8" }, icon: "items/schaf.png", locks: ITEM_LOCKS },
		{ key: "ziege", parent: "ding", typeclass: "Livestock", name: "Ziege", desc: "Eine neugierige Ziege mit Bart. Sie gibt jeden Tag Milch und frisst fast alles.", aliases: ["ziegen", "geiß", "geiss", "goat"], glyph: { shape: "circle", color: "#a89a80" }, icon: "items/ziege.png", locks: ITEM_LOCKS },
		{ key: "ei", parent: "ding", typeclass: "Produce", name: "Ei", desc: "Ein braunes Ei, noch warm aus dem Nest.", aliases: ["eier", "egg", "eggs"], glyph: { shape: "circle", color: "#e8d0a8" }, icon: "items/ei.png", locks: ITEM_LOCKS },
		{ key: "wolle", parent: "ding", typeclass: "Produce", name: "Wolle", desc: "Ein Knäuel geschorener Wolle, fettig und warm.", aliases: ["schafwolle", "wool"], glyph: { shape: "circle", color: "#f0ece0" }, icon: "items/wolle.png", locks: ITEM_LOCKS },
		{ key: "milch", parent: "ding", typeclass: "Produce", name: "Milch", desc: "Ein Krug Ziegenmilch.", aliases: ["ziegenmilch", "krug", "milk"], glyph: { shape: "square", color: "#f4f1e8" }, icon: "items/milch.png", locks: ITEM_LOCKS },
		{ key: "ente", parent: "ding", typeclass: "Livestock", name: "Ente", desc: "Eine schnatternde Ente mit grünem Spiegel. Sie legt Eier und frisst Tang wie ein Huhn.", aliases: ["enten", "duck"], glyph: { shape: "circle", color: "#6a8a5a" }, icon: "items/ente.png", locks: ITEM_LOCKS },
		{ key: "gans", parent: "ding", typeclass: "Livestock", name: "Gans", desc: "Eine weiße Gans, wachsam und laut. Wo Gänse sind, kommt kein Hase unbemerkt an die Beete.", aliases: ["gänse", "gaense", "goose"], glyph: { shape: "circle", color: "#f0ece0" }, icon: "items/gans.png", locks: ITEM_LOCKS },
		{ key: "daunen", parent: "ding", typeclass: "Produce", name: "Daunen", desc: "Eine Handvoll weicher Gänsedaunen.", aliases: ["daune", "federn", "down"], glyph: { shape: "circle", color: "#f4f1e8" }, icon: "items/daunen.png", locks: ITEM_LOCKS },
		{ key: "tuch", parent: "ding", typeclass: "Gear", name: "Tuch", desc: "Ein Stück gewebtes Wolltuch, dicht und warm.", aliases: ["wolltuch", "stoff", "cloth"], glyph: { shape: "square", color: "#8a6a9a" }, icon: "items/tuch.png", locks: ITEM_LOCKS },
		{ key: "decke", parent: "ding", typeclass: "Gear", name: "Daunendecke", desc: "Eine Decke aus Wolltuch, mit Daunen gefüllt. Ein Schatz für jede Aussteuer.", aliases: ["bettdecke", "blanket"], glyph: { shape: "square", color: "#c8b0d8" }, icon: "items/decke.png", locks: ITEM_LOCKS },
		{ key: "kaese", parent: "ding", typeclass: "Produce", name: "Käse", desc: "Ein kleiner Laib Ziegenkäse, am Herd der Hütte gemacht.", aliases: ["käse", "ziegenkäse", "cheese"], glyph: { shape: "circle", color: "#e8c870" }, icon: "items/kaese.png", locks: ITEM_LOCKS },
		{ key: "hund", parent: "ding", typeclass: "Livestock", name: "Hund", desc: "Ein zotteliger Hofhund. Satt und an einem Bau gelassen, schlägt er an, wenn Hase, Reh oder Fuchs aus dem Nebel kommen.", aliases: ["hunde", "hofhund", "dog"], glyph: { shape: "circle", color: "#8a6a4a" }, icon: "items/hund.png", locks: ITEM_LOCKS },
		{ key: "katze", parent: "ding", typeclass: "Livestock", name: "Katze", desc: "Eine getigerte Katze. Satt und an einem Bau gelassen, hält sie die Mäuse von jeder Truhe im Raum fern.", aliases: ["katzen", "kater", "cat"], glyph: { shape: "circle", color: "#c8904a" }, icon: "items/katze.png", locks: ITEM_LOCKS },
		{ key: "mausefalle", parent: "ding", typeclass: "Gear", name: "Mausefalle", desc: "Ein Brettchen mit Bügel aus Muschelschale. In einer Truhe fängt sie jede Maus, die an das Korn will.", aliases: ["falle", "mousetrap", "trap"], glyph: { shape: "square", color: "#a08060" }, icon: "items/mausefalle.png", locks: ITEM_LOCKS },
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
		{ key: "siedeln", category: "Allgemein", text: "Bauen im Licht: wo ein Leuchtfeuer brennt, steckt „bau hütte“ neben dir eine Baustelle ab (registrierte Spieler; „bau“ zeigt die Pläne). Alle können liefern („liefere 3 treibholz“, zu viel bleibt bei dir) und mitarbeiten („arbeite“, danach ruhst du eine Stunde Weltzeit), aus bis zu zwei Schritten Entfernung. Fehlt nichts mehr, steht der Bau, und an ihm steht, wer mitgebaut hat. „baustelle“ zeigt, was hier fehlt; die rechte Maustaste auf einer Baustelle bietet Liefern und Mitarbeiten an. Wege, Ausgänge und der Platz am Feuer werden nie zugebaut, und jedes Feuer trägt nur so viele Bauten, wie sein Licht reicht. Eine Baustelle ohne Fortschritt verfällt nach zwei Tagen. Die Hütte hat eine Truhe, die nur dir gehört („truhe“, „verstaue 3 muscheln“ oder „leg die muscheln in die truhe“, „entnimm 2 muscheln“). Ein Bau hält eine Woche; „repariere“ (1 Treibholz, jeder darf helfen) bessert ihn aus. Wer ihn verfallen lässt, hat eine Ruine; was in der Truhe lag, holt „nachlass“ an der Ruine ab (einen Monat lang). „reiß die hütte ab“ gibt die Fläche frei und die Hälfte des Materials zurück, eine aufgegebene Baustelle alles Gelieferte." },
		{ key: "garten", category: "Allgemein", text: "Gärten im Licht: mit einem Spaten („craft spaten“: 2 Treibholz, 1 Tangseil) gräbt „umgraben“ neben dir ein Beet um (2×2, registrierte Spieler, höchstens drei, wo ein Feuer brennt). Samen findet „sammle samen“ in der wilden Flora (nicht immer; Strandnelke und Strandkohl fast überall, Dünenrose, Möhre und die Nebelblume nur auf manchen Inseln). „pflanze strandnelke“ setzt einen Samen ins Beet. Wasser gibt die Regentonne („bau regentonne“; „schöpfe“ füllt eine Kanne, sie füllt sich alle acht Stunden um eine, bei Sturmflut ganz); „gieße“ gießt das ganze Beet. Was zu lange trocken steht, welkt; Nebel und Unkraut lassen es langsamer wachsen, „jäte“ zieht Unkraut und Welkes. Reifes holt „ernte“ in die Tasche, mit neuen Samen. „pate <name>“ lässt jemanden – auch einen Gast – dein Beet gießen, jäten und ernten; „pate weg <name>“ beendet es. „beet“ zeigt die Beete hier, „beet aufgeben“ macht deins wieder zu Gras. Ein Beet, das zwei Wochen niemand pflegt, wächst zu. „umgraben zier“ gräbt ein Zierbeet (nur Blumen): reifen dort zwei Sorten nebeneinander, ist bei der Ernte manchmal ein Kreuzungssamen dabei, eine neue Sorte mit eigener Farbe, der ihr Züchter mit „benenne <name>“ einen Namen gibt. „umgraben gemeinschaft“ legt ein Gemeinschaftsbeet an (3×3, eins je Feuer): pflanzen darf jeder mit Konto, gießen, jäten und ernten alle. Samen verkauft die Gärtnerin Gesa am Markt von Kupferhafen. Wo kein Feuer brennt, kommen Hasen aus dem Nebel an die Beete und fressen nach einer Weile: „scheuche hase“ jagt sie fort, ein Zaun („zäune“: 2 Treibholz, 1 Tangseil) oder eine Vogelscheuche („bau vogelscheuche“) schützt dauerhaft. Größer als ein Beet ist die Flur: „help ackerbau“." },
		{ key: "brot", category: "Allgemein", text: "Mehl und Brot, Flachs und Leinen: eine Windmühle (erst wenn die Insel ein Dorf ist, „help epochen“; „bau windmühle“: 8 Treibholz, 2 Tangseil, 2 Leinen für die Flügel, 16 Arbeit) mahlt Weizen, Gerste und Hafer zu Mehl, eine Stunde je Handvoll. „mahle alle weizen“ schüttet dein Korn hinein (bis 12 auf einmal, drei Säcke je Figur), egal wessen Mühle; was andere vor dir brachten, wird zuerst gemahlen. „mahle“ allein sagt, wie lange sie noch zu tun hat, „abholen“ holt dein fertiges Mehl. Bei Sturmflut auf ihrer Insel dreht sie schneller und mahlt sechs Stunden voraus. Fällt eine Mühle, bevor dein Korn gemahlen ist, holst du es an ihrer Stelle zurück. Im Backhaus („bau backhaus“: 6 Treibholz, 6 Muscheln, 1 Tangseil, 12 Arbeit) bäckt „backe brot“ aus 2 Mehl, einer Kanne Wasser und einem Scheit Treibholz drei Brote; backen darf jeder an jedem Backhaus. Aus Flachs spinnt man mit einer Spindel („craft spindel“: 1 Treibholz, 1 Muschel) Leinen: „craft leinen“ (3 Flachs). Brot, Mehl und Leinen kauft Marta am Markt von Kupferhafen, die Auftragstafeln fragen danach." },
		{ key: "ackerbau", category: "Allgemein", text: "Äcker: mit einem Spaten bricht „flur anlegen“ neben dir eine Flur um (4×4, eine je Konto, im Licht eines Feuers, zwei Lichtpunkte). Wer sie anlegte, wählt die Frucht: „bestelle gerste“ (auch Weizen, Hafer, Kartoffeln, Rüben, Flachs). Dann braucht sie Saatgut (4 Stück: Korn ist sein eigenes Saatgut, für Rüben Rübensamen, für Flachs Leinsamen) und 2 Arbeit: jedes „bestelle“ bringt, was du davon trägst, und einen Arbeitspunkt (danach ruhst du eine Stunde, wie an der Baustelle). Gerste, Hafer, Rüben- und Leinsamen findet „sammle samen“ in der wilden Flora, Weizen und Kartoffeln verkauft Gesa am Markt von Kupferhafen. Nach zwei bis drei Tagen ist die Flur reif und bleibt es zwei Tage: jedes „ernte“ an ihr ist ein Arbeitspunkt (8 für eine Flur) und gibt dir deinen Anteil; viele Hände bringen sie in einer Stunde ein. Danach wird sie überreif, und jeder Anteil ist nur noch halb so groß; noch zwei Tage später ist die Frucht verdorben. „flur offen“ lässt jeden mitsäen und -ernten (jeder behält seinen Anteil), „flur zu“ schließt sie wieder. Fruchtfolge: dieselbe Art (Getreide, Hackfrucht, Rüben, Flachs) zweimal hintereinander macht den Boden müde, er gibt weniger; eine andere Frucht oder drei Tage Brache heilen ihn. „flur“ zeigt die Fluren hier und ihren Boden, „flur aufgeben“ macht deine wieder zu Gras; eine Flur, an der zwei Wochen niemand arbeitet, verwildert. Fluren legt man erst an, wenn die Insel ein Dorf ist („help epochen“). Was man aus Korn und Flachs macht: „help brot“; wen die Fluren noch füttern: „help tiere“; wer sonst an ihnen frisst: „help wild“." },
		{ key: "tiere", category: "Allgemein", text: "Tiere auf dem Hof: Hühner wohnen im Hühnerstall („bau hühnerstall“: 2×1, 4 Treibholz, 1 Tangseil, 6 Arbeit, bis 6 Hühner), Schafe, Ziegen, Enten oder Gänse im Gehege („bau gehege“, erst im Dorf: 3×3, 8 Treibholz, 4 Tangseil, 8 Arbeit, bis 4 Tiere einer Art). Tiere verkauft Gesa am Markt von Kupferhafen; „einstallen huhn“ bringt eines, das du trägst, in deinen Stall, „ausstallen“ holt eins heraus. „füttere“ (jeder darf) gibt Futter aus deiner Tasche: ein Futter macht ein Tier einen Tag satt, bis zu drei Tage im Voraus. Hühner und Enten fressen Tang, Kohl und Korn, Schafe, Ziegen und Gänse Rüben, Hafer, Gerste, Kohl und Tang. Satt legen Hühner und Enten jeden Tag ein Ei, eine Ziege gibt jeden Tag Milch, ein Schaf alle zwei Tage Wolle, eine Gans alle drei Tage Daunen; hungrige geben nichts, bis wieder gefüttert wird. Satte Gänse halten Wache: in ihrem Raum kommt kein Hase an die Beete und kein Fuchs in den Stall. Was sonst aus dem Nebel kommt und wer davor schützt: „help wild“. Bis zu drei je Tier warten im Stall: „einsammeln“ (auch „sammle eier“, „melke“, „schere“) holt sie. Zwei satte Tiere einer Art bekommen ab und zu ein Junges, bis der Stall voll ist. „stall“ zeigt, wie es den Tieren neben dir geht. Was daraus wird: am Webstuhl („bau webstuhl“: 2×1, 6 Treibholz, 2 Tangseil, 8 Arbeit) webt „craft tuch“ aus 3 Wolle mit einer Spindel ein Tuch, „craft decke“ aus 2 Tuch und 3 Daunen eine Daunendecke; am Herd einer Hütte macht „craft käse“ aus 3 Milch und einem Scheit Treibholz einen Käse. Eier, Wolle, Milch und Daunen kauft Gesa, Tuch, Decken und Käse Marta; die Auftragstafeln fragen danach." },
		{ key: "wild", category: "Allgemein", text: "Wild aus dem Nebel: wo kein Feuer brennt, kommt es an das, was eine Siedlung anbaut und hält, mehr im dichten Nebel und nachts. Hasen knabbern an den Beeten, Rehe fressen sich an einer wachsenden Flur satt (sie gibt dann weniger, aber nie weniger als gut die Hälfte), Füchse holen fast nur nachts ein Huhn aus dem Stall (nie das letzte), Mäuse nagen an Korn, Mehl, Brot und Käse in der Truhe einer Hütte (nie am letzten Stück). Jedes Tier frisst erst nach einer Weile: wer vorher bis drei Schritte herankommt, jagt es mit „scheuche hase“ (auch reh, fuchs, maus) fort, und nichts ist verloren. Dauerhaft schützen ein Zaun („zäune“ neben einem Beet: 2 Treibholz, 1 Tangseil; neben deiner Flur: 6 Treibholz, 2 Tangseil; neben deinem Hühnerstall: 3 Treibholz, 1 Tangseil), die Vogelscheuche (Beete und Fluren in drei Feldern) und die Mausefalle in der Truhe („craft mausefalle“: 1 Treibholz, 2 Muscheln, 1 Tangseil). Und Wächter, solange sie satt sind: Gänse halten Hasen und Füchse aus dem ganzen Raum fern, ein Hund Hasen, Rehe und Füchse, eine Katze die Mäuse. Hund und Katze verkauft Gesa; „einstallen hund“ lässt ihn an einem deiner Bauten wachen, „füttere hund“ (jeder darf; Hunde fressen Eier, Brot, Käse und Milch, Katzen Milch, Eier und Käse) macht ihn einen Tag satt, „ausstallen hund“ nimmt ihn wieder mit. „wache“ zeigt, wer im Raum wacht." },
		{ key: "epochen", category: "Allgemein", text: "Epochen: jede Insel steht auf einer Stufe, erst Fischerdorf, dann Dorf, Stadt und Netz. Sie zählt ihren gehaltenen Bestand: jeder Bau, jedes Beet und jede Flur, die noch stehen, mit so vielen Punkten, wie sie vom Licht eines Feuers nehmen (Hütte, Beet, Hühnerstall, Regentonne je 1; Flur, Gemeinschaftsbeet, Windmühle, Backhaus, Gehege je 2). Ab 15 Punkten wird die Insel ein Dorf, ab 40 eine Stadt, ab 80 ein Netz (der Betreiber kann die Schwellen ändern). Erst im Dorf lassen sich Windmühle, Backhaus, Gehege, Webstuhl und neue Fluren anlegen. Verfällt zu viel, fällt die Insel zurück: was steht, arbeitet weiter, nur neue Pläne der höheren Stufe warten. Ein Dorf baut man also gemeinsam, und Beete zählen so viel wie Bauten. „epoche“ zeigt die Stufe und die Punkte dieser Insel." },
		{ key: "chat", category: "Allgemein", text: "Chat zwischen Spielern, Ende-zu-Ende verschlüsselt: nur die Mitglieder eines Gesprächs können es lesen, auch kein Admin. Richte ihn im Reiter „Chats“ neben dem Log mit einem eigenen Chat-Passwort ein (nicht dein Login-Passwort); vergisst du es, sind deine Verläufe verloren – „Verlauf sichern“ speichert sie als Datei. Ein Gespräch beginnt mit „chat <name> <text>“ (tell, flüstere) oder per rechter Maustaste (langes Tippen) auf eine Figur: „Chat mit …“. Gruppen: „gruppe neu <name>“, „gruppe lade <spieler> in <gruppe>“, „gruppe annehmen <gruppe>“ oder „gruppe ablehnen <gruppe>“, „gruppe verlasse <gruppe>“, „gruppe entferne <spieler> aus <gruppe>“, „gruppe <gruppe> <text>“; „gruppe“ allein zeigt deine Gruppen. „ignoriere <name>“ sperrt Nachrichten und Einladungen, „erlaube <name>“ hebt es auf. Gäste können chatten, aber keine Gruppe gründen oder einladen." },
		{ key: "inseln", category: "Welt", text: "Acht Inseln liegen im Nebel: die Graue Insel, Möwenfels im Norden und dahinter die Schären, die Handelsstadt Kupferhafen im Osten und dahinter Rauchholm mit seinem Köhlerwald, Tangriff mit Wrack und Perlen im Süden und dahinter Krabbensand mit dem Watt, und Nebelholm im Westen, wo niemand das Feuer hütet. Fähren (Kähne) verbinden sie: am Klippenkopf nach Möwenfels und Kupferhafen, am Anleger nach Tangriff, im Fischerdorf nach Nebelholm, im Hafenviertel nach Tangriff, an der Alten Warte zu den Schären, am Speicher nach Rauchholm, am Perlengrund nach Krabbensand. Ist der Nebel zu dicht, fährt kein Kahn – brennende Feuer halten die Wege offen." },
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
		{ beaconId: "feuer-schaeren", name: "Schärenfeuer", aliases: FIRE_ALIASES, room: "schaerenhafen", x: plazaOf("schaerenhafen").x, y: plazaOf("schaerenhafen").y, covers: ["schaerenhafen", "robbenbank", "leuchtklippe", "seehundstrand"] },
		{ beaconId: "feuer-rauch", name: "Feuer von Rauchhafen", aliases: FIRE_ALIASES, room: "rauchhafen", x: plazaOf("rauchhafen").x, y: plazaOf("rauchhafen").y, covers: ["rauchhafen", "koehlerwald", "schwarzer-strand", "kraterhang"] },
		{ beaconId: "feuer-krabbe", name: "Feuer der Krabbenbucht", aliases: FIRE_ALIASES, room: "krabbenbucht", x: plazaOf("krabbenbucht").x, y: plazaOf("krabbenbucht").y, covers: ["krabbenbucht", "salzgarten", "watt", "muschelbank"] },
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
			{ room: "schaerenhafen", tile: ".", max: 3 },
			{ room: "robbenbank", tile: ".", max: 3, protos: [{ proto: "treibholz", weight: 2 }, { proto: "muschel", weight: 2 }] },
			{ room: "seehundstrand", tile: ".", max: 3, protos: [{ proto: "muschel", weight: 3 }, { proto: "treibholz", weight: 2 }, { proto: "tang", weight: 1 }] },
			{ room: "rauchhafen", tile: ".", max: 3 },
			{ room: "schwarzer-strand", tile: ".", max: 3, protos: [{ proto: "treibholz", weight: 4 }, { proto: "bernstein", weight: 1 }] },
			{ room: "krabbenbucht", tile: ".", max: 3 },
			{ room: "watt", tile: ".", max: 3, protos: [{ proto: "muschel", weight: 3 }, { proto: "tang", weight: 2 }, { proto: "treibholz", weight: 2 }] },
			{ room: "muschelbank", tile: ".", max: 2, protos: [{ proto: "muschel", weight: 5 }, { proto: "perle", weight: 1 }] },
		],
		protos: [{ proto: "treibholz", weight: 3 }, { proto: "muschel", weight: 1 }],
	},
	storm: {
		everyMs: 20 * 60_000, count: 6, channel: "hafen",
		rooms: ["wrackbucht", "tang-strand", "moewenfels-strand", "salzwiesen", "nebelholm-ufer", "fischerdorf", "perlengrund", "seehundstrand", "schwarzer-strand", "watt"],
		protos: [{ proto: "treibholz", weight: 5 }, { proto: "tang", weight: 3 }, { proto: "muschel", weight: 3 }, { proto: "bernstein", weight: 1 }, { proto: "perle", weight: 1 }, { proto: "tran", weight: 1 }],
	},
	channels: ["hafen"],
	npcs: NPCS,
	currency: "muenze",
	market: { rooms: ["graue-bucht", "kupferhafen-markt", "riffdorf", "schaerenhafen", "rauchhafen", "krabbenbucht"], listMs: 24 * 3600_000 },
	// docs/siedeln.md: building, first the hut (step 1)
	building: {
		lightPoints: 20, siteWorldMs: 2 * 24 * 3600_000, restWorldMs: 3600_000, maxSites: 1, maxBuildings: 5, ruinWorldMs: 10 * 24 * 3600_000, estateWorldMs: 30 * 24 * 3600_000,
		plans: [
			{ key: "huette", name: "Hütte", dative: "einer Hütte", aliases: ["hütte", "hut"], w: 2, h: 2, needs: [{ proto: "treibholz", count: 6 }, { proto: "tangseil", count: 2 }], work: 20, points: 1, keepWorldMs: 7 * 24 * 3600_000, color: "#8a6a44", chest: 12, repair: [{ proto: "treibholz", count: 1 }] },
			// water for the beds (garden below): it gains a can every eight world hours, up to six, and is full after a storm surge
			// keeps the hares from the beds within three cells (wild below); it stands only three days without repair
			{ key: "vogelscheuche", name: "Vogelscheuche", aliases: ["strohmann", "scarecrow"], w: 1, h: 1, needs: [{ proto: "treibholz", count: 2 }, { proto: "tangseil", count: 1 }], work: 3, points: 1, keepWorldMs: 3 * 24 * 3600_000, color: "#b08a4a", repair: [{ proto: "tang", count: 1 }] },
			// step 3 part 2: the windmill grinds grain to flour (mill below), its sails are linen; the bakery's oven bakes it
			{ key: "windmuehle", epoch: 2, name: "Windmühle", aliases: ["windmühle", "mühle", "muehle", "windmill", "mill"], w: 2, h: 2, needs: [{ proto: "treibholz", count: 8 }, { proto: "tangseil", count: 2 }, { proto: "leinen", count: 2 }], work: 16, points: 2, keepWorldMs: 7 * 24 * 3600_000, color: "#c8b48a", repair: [{ proto: "treibholz", count: 1 }] },
			{ key: "backhaus", epoch: 2, name: "Backhaus", aliases: ["bäckerei", "baeckerei", "ofen", "bakery", "bakehouse"], w: 2, h: 2, needs: [{ proto: "treibholz", count: 6 }, { proto: "muschel", count: 6 }, { proto: "tangseil", count: 1 }], work: 12, points: 2, keepWorldMs: 7 * 24 * 3600_000, color: "#b0604a", repair: [{ proto: "muschel", count: 1 }] },
			// step 3 part 3: hens in the coop, sheep or goats in the pen (animals below)
			{ key: "huehnerstall", name: "Hühnerstall", aliases: ["hühnerstall", "stall", "coop", "henhouse"], w: 2, h: 1, needs: [{ proto: "treibholz", count: 4 }, { proto: "tangseil", count: 1 }], work: 6, points: 1, keepWorldMs: 7 * 24 * 3600_000, color: "#a0784a", repair: [{ proto: "treibholz", count: 1 }] },
			{ key: "gehege", epoch: 2, name: "Gehege", aliases: ["koppel", "pferch", "pen", "paddock"], w: 3, h: 3, needs: [{ proto: "treibholz", count: 8 }, { proto: "tangseil", count: 4 }], work: 8, points: 2, keepWorldMs: 7 * 24 * 3600_000, color: "#8a7a4a", repair: [{ proto: "treibholz", count: 1 }] },
			// the loom: wool to cloth, cloth and down to a blanket (recipes "at" it)
			{ key: "webstuhl", epoch: 2, name: "Webstuhl", aliases: ["webhütte", "webhuette", "loom"], w: 2, h: 1, needs: [{ proto: "treibholz", count: 6 }, { proto: "tangseil", count: 2 }], work: 8, points: 1, keepWorldMs: 7 * 24 * 3600_000, color: "#7a5a8a", repair: [{ proto: "treibholz", count: 1 }] },
			{ key: "regentonne", name: "Regentonne", aliases: ["tonne", "barrel", "rain-barrel"], w: 1, h: 1, needs: [{ proto: "treibholz", count: 3 }, { proto: "tangseil", count: 1 }], work: 4, points: 1, keepWorldMs: 7 * 24 * 3600_000, color: "#5e7a8a", repair: [{ proto: "treibholz", count: 1 }] },
		],
	},
	// docs/siedeln.md "Gärten", step 2: beds of 2×2 in the light (and one community bed of 3×3 per fire), five sorts
	// from the wild flora; flowers side by side in a flower bed cross now and then
	garden: {
		bed: { w: 2, h: 2, points: 1, keepWorldMs: 14 * 24 * 3600_000 }, commons: { w: 3, h: 3, points: 2 }, crossChance: 0.25, maxBeds: 3, spade: "spaten", can: "wasserkanne", barrel: "regentonne", barrelCap: 6, barrelFillWorldMs: 8 * 3600_000,
		thirstWorldMs: 16 * 3600_000, seedRestWorldMs: 3600_000, seedChance: 0.5,
		decor: { flowers: ["*", "+", "o", "x"], herbs: ["i", "w", "v"] },
		sorts: [
			{ key: "strandnelke", name: "Strandnelke", aliases: ["nelke"], kind: "zier", seed: "samen-strandnelke", grow: [6 * 3600_000, 18 * 3600_000], ripeWorldMs: 2 * 24 * 3600_000, yields: { proto: "strandnelke", count: 1 }, color: "#e88fb0", wild: { decor: "flowers" } },
			{ key: "duenenrose", name: "Dünenrose", aliases: ["rose"], kind: "zier", seed: "samen-duenenrose", grow: [8 * 3600_000, 24 * 3600_000], ripeWorldMs: 2 * 24 * 3600_000, yields: { proto: "duenenrose", count: 1 }, color: "#d9476b", wild: { decor: "flowers", islands: ["Graue Insel", "Krabbensand", "Möwenfels"] } },
			{ key: "nebelblume", name: "Nebelblume", aliases: [], kind: "zier", seed: "samen-nebelblume", grow: [12 * 3600_000, 36 * 3600_000], ripeWorldMs: 3 * 24 * 3600_000, yields: { proto: "nebelblume", count: 1 }, color: "#9fb6e8", wild: { decor: "flowers", islands: ["Nebelholm"] } },
			{ key: "strandkohl", name: "Strandkohl", aliases: ["kohl"], kind: "nutz", seed: "samen-strandkohl", grow: [6 * 3600_000, 24 * 3600_000], ripeWorldMs: 24 * 3600_000, yields: { proto: "kohl", count: 2 }, color: "#7fae6a", wild: { decor: "herbs" } },
			{ key: "moehre", name: "Möhre", aliases: ["wilde möhre"], kind: "nutz", seed: "samen-moehre", grow: [6 * 3600_000, 18 * 3600_000], ripeWorldMs: 24 * 3600_000, yields: { proto: "moehre", count: 2 }, color: "#e8902c", wild: { decor: "herbs", islands: ["Graue Insel", "Kupferhafen", "Rauchholm", "Krabbensand"] } },
		],
	},
	// docs/siedeln.md "Äcker und Getreide", step 3 part 1: fields of 4×4 in the light, sown and brought in by many hands;
	// barley, oats, beet and flax grow wild (their seed from "sammle samen"), wheat and potatoes come from Gesa
	fields: {
		epoch: 2, w: 4, h: 4, points: 2, maxFields: 1, keepWorldMs: 14 * 24 * 3600_000, seedPerCells: 4, sowPerCells: 8, harvestPerCells: 2,
		windowWorldMs: 2 * 24 * 3600_000, lateLoss: 0.5, tired: [1, 0.6, 0.35], fallowWorldMs: 3 * 24 * 3600_000,
		crops: [
			{ key: "weizen", name: "Weizen", aliases: ["wheat"], group: "Getreide", seed: "weizen", growWorldMs: 3 * 24 * 3600_000, yields: [{ proto: "weizen", perCell: 1 }], color: "#d9b44a" },
			{ key: "gerste", name: "Gerste", aliases: ["barley"], group: "Getreide", seed: "gerste", growWorldMs: 60 * 3600_000, yields: [{ proto: "gerste", perCell: 1 }], color: "#c8b06a", wild: { decor: "herbs" } },
			{ key: "hafer", name: "Hafer", aliases: ["oats"], group: "Getreide", seed: "hafer", growWorldMs: 2 * 24 * 3600_000, yields: [{ proto: "hafer", perCell: 1 }], color: "#cdbf8a", wild: { decor: "herbs", islands: ["Graue Insel", "Nebelholm", "Schären"] } },
			{ key: "kartoffel", name: "Kartoffeln", aliases: ["kartoffel", "potato", "potatoes"], group: "Hackfrucht", seed: "kartoffel", growWorldMs: 3 * 24 * 3600_000, yields: [{ proto: "kartoffel", perCell: 1.5 }], color: "#6f8f3a" },
			{ key: "ruebe", name: "Rüben", aliases: ["rübe", "ruebe", "rueben", "beet"], group: "Rüben", seed: "samen-ruebe", growWorldMs: 2 * 24 * 3600_000, yields: [{ proto: "ruebe", perCell: 1 }, { proto: "samen-ruebe", perCell: 0.5 }], color: "#9a3a5a", wild: { decor: "herbs", islands: ["Graue Insel", "Kupferhafen", "Krabbensand"] } },
			{ key: "flachs", name: "Flachs", aliases: ["lein", "flax"], group: "Flachs", seed: "leinsamen", growWorldMs: 60 * 3600_000, yields: [{ proto: "flachs", perCell: 1 }, { proto: "leinsamen", perCell: 0.5 }], color: "#6a8fd0", wild: { decor: "flowers" } },
		],
	},
	// docs/siedeln.md "Epochen", step 4 part 1: an island's held stock (by light points) reaches the village at 15 points,
	// the town at 40, the net at 80 (settings epoch.dorf, epoch.stadt, epoch.netz); mill, bakery, pen, loom and fields
	// are village plans
	epochs: { names: ["Fischerdorf", "Dorf", "Stadt", "Netz"], a: ["ein Fischerdorf", "ein Dorf", "eine Stadt", "ein Netz"], checkWorldMs: 3600_000 },
	// docs/siedeln.md "Wild im Nebel", step 2 part 3: hares at the beds of rooms in fog, none while the fire burns
	wild: {
		checkWorldMs: 20 * 60_000, chance: [0, 0.04, 0.12, 0.25], nightFactor: 2, maxPerRoom: 2, eatAfterWorldMs: 30 * 60_000, scareReach: 3,
		hare: { name: "Hase", icon: "items/hase.png" }, fence: [{ proto: "treibholz", count: 2 }, { proto: "tangseil", count: 1 }], scarecrow: "vogelscheuche", scarecrowReach: 3,
		// step 3 part 4: deer graze the growing fields, foxes take a hen at night, mice eat grain and flour from the chests
		prey: [
			{ key: "reh", name: "Reh", aliases: ["rehe", "deer"], nom: "ein Reh", the: "das Reh", acc: "das Reh", none: "kein Reh", goes: "zieht", to: "an die Flur von {owner}", icon: "items/reh.png",
				chance: [0, 0.03, 0.08, 0.16], nightFactor: 2, eatAfterWorldMs: 45 * 60_000, bite: 0.15, keep: 0.55 },
			{ key: "fuchs", name: "Fuchs", aliases: ["füchse", "fuechse", "fox"], nom: "ein Fuchs", the: "der Fuchs", acc: "den Fuchs", none: "kein Fuchs", goes: "schleicht", to: "an den Stall von {owner}", icon: "items/fuchs.png",
				chance: [0, 0.03, 0.08, 0.15], nightFactor: 2, dayFactor: 0.1, eatAfterWorldMs: 30 * 60_000, houses: ["huehnerstall"] },
			{ key: "maus", name: "Maus", aliases: ["mäuse", "maeuse", "mouse"], nom: "eine Maus", the: "die Maus", acc: "die Maus", none: "keine Maus", goes: "huscht", to: "an die Truhe von {owner}", icon: "items/maus.png",
				chance: [0, 0.04, 0.1, 0.2], nightFactor: 2, eatAfterWorldMs: 30 * 60_000, eats: ["weizen", "gerste", "hafer", "mehl", "brot", "kaese"], take: 2, trap: "mausefalle" },
		],
		// fed, the geese keep hares and foxes from their room, a dog hares, deer and foxes, a cat the mice
		guards: [
			{ by: "gans", kinds: ["hase", "fuchs"], says: "Die Gänse schnattern los" },
			{ by: "hund", kinds: ["hase", "reh", "fuchs"], says: "Der Hund schlägt an" },
			{ by: "katze", kinds: ["maus"], says: "Die Katze springt" },
		],
		keepers: [
			{ key: "hund", proto: "hund", name: "Hund", the: "der Hund", acc: "den Hund", none: "kein Hund", feed: ["ei", "brot", "kaese", "milch"] },
			{ key: "katze", proto: "katze", name: "Katze", the: "die Katze", acc: "die Katze", none: "keine Katze", feed: ["milch", "ei", "kaese"] },
		],
		fieldFence: [{ proto: "treibholz", count: 6 }, { proto: "tangseil", count: 2 }], coopFence: [{ proto: "treibholz", count: 3 }, { proto: "tangseil", count: 1 }],
	},
	// docs/siedeln.md "Warenketten", step 3 part 2: grain to flour at the mill (an hour a handful, a storm surge on its
	// island grinds six hours ahead); flour to bread in the bakery's oven, flax to linen with a spindle
	mill: { plan: "windmuehle", grinds: [{ from: "weizen", to: "mehl" }, { from: "gerste", to: "mehl" }, { from: "hafer", to: "mehl" }], unitWorldMs: 3600_000, maxLoad: 12, maxLoads: 3, stormWorldMs: 6 * 3600_000, keepWorldMs: 14 * 24 * 3600_000 },
	// docs/siedeln.md "Tiere auf dem Hof", step 3 part 3: one thing of feed keeps one animal a day; fed, a hen lays an egg a
	// day, a sheep gives wool every other day, a goat milk a day; two fed ones now and then get a young one
	animals: {
		houses: { huehnerstall: 6, gehege: 4 }, feedWorldMs: 24 * 3600_000, fedMaxWorldMs: 3 * 24 * 3600_000, nestMax: 3,
		kinds: [
			{ key: "huhn", proto: "huhn", name: "Huhn", plural: "Hühner", plan: "huehnerstall", yields: "ei", everyWorldMs: 24 * 3600_000, feed: ["tang", "kohl", "moehre", "weizen", "gerste", "hafer"], breedWorldMs: 4 * 24 * 3600_000 },
			{ key: "schaf", proto: "schaf", name: "Schaf", plural: "Schafe", plan: "gehege", yields: "wolle", everyWorldMs: 2 * 24 * 3600_000, feed: ["ruebe", "hafer", "gerste", "kohl", "tang"], breedWorldMs: 6 * 24 * 3600_000 },
			{ key: "ente", proto: "ente", name: "Ente", plural: "Enten", plan: "gehege", yields: "ei", everyWorldMs: 24 * 3600_000, feed: ["tang", "kohl", "weizen", "gerste", "hafer"], breedWorldMs: 4 * 24 * 3600_000 },
			// the geese keep watch: fed, they keep the hares from every bed of their room (wild.guard)
			{ key: "gans", proto: "gans", name: "Gans", plural: "Gänse", plan: "gehege", yields: "daunen", everyWorldMs: 3 * 24 * 3600_000, feed: ["gerste", "hafer", "kohl", "ruebe", "tang"], breedWorldMs: 6 * 24 * 3600_000 },
			{ key: "ziege", proto: "ziege", name: "Ziege", plural: "Ziegen", plan: "gehege", yields: "milch", everyWorldMs: 24 * 3600_000, feed: ["ruebe", "hafer", "gerste", "kohl", "moehre", "tang"], breedWorldMs: 5 * 24 * 3600_000 },
		],
	},
	recipes: [
		{ key: "muschelmesser", name: "Muschelmesser", needs: [{ proto: "muschel", count: 2 }, { proto: "treibholz", count: 1 }], makes: "muschelmesser" },
		{ key: "holzbuendel", name: "Holzbündel", needs: [{ proto: "treibholz", count: 3 }], tool: "muschelmesser", makes: "holzbuendel" },
		{ key: "tangseil", name: "Tangseil", needs: [{ proto: "tang", count: 3 }], makes: "tangseil" },
		{ key: "spaten", name: "Spaten", needs: [{ proto: "treibholz", count: 2 }, { proto: "tangseil", count: 1 }], makes: "spaten" },
		{ key: "spindel", name: "Spindel", needs: [{ proto: "treibholz", count: 1 }, { proto: "muschel", count: 1 }], makes: "spindel" },
		{ key: "leinen", name: "Leinen", needs: [{ proto: "flachs", count: 3 }], tool: "spindel", makes: "leinen" },
		// what the farm gives, made on: wool to cloth at the loom, a blanket of cloth and down, cheese at a hut's hearth
		{ key: "tuch", name: "Tuch", needs: [{ proto: "wolle", count: 3 }], tool: "spindel", makes: "tuch", at: "webstuhl" },
		{ key: "decke", name: "Daunendecke", needs: [{ proto: "tuch", count: 2 }, { proto: "daunen", count: 3 }], makes: "decke", at: "webstuhl" },
		{ key: "kaese", name: "Käse", needs: [{ proto: "milch", count: 3 }, { proto: "treibholz", count: 1 }], makes: "kaese", at: "huette" },
		{ key: "mausefalle", name: "Mausefalle", needs: [{ proto: "treibholz", count: 1 }, { proto: "muschel", count: 2 }, { proto: "tangseil", count: 1 }], makes: "mausefalle" },
		{ key: "brot", name: "Brot", needs: [{ proto: "mehl", count: 2 }, { proto: "wasserkanne", count: 1 }, { proto: "treibholz", count: 1 }], makes: "brot", count: 3, at: "backhaus" },
		{ key: "netz", name: "Netz", needs: [{ proto: "tangseil", count: 2 }], tool: "muschelmesser", makes: "netz" },
		{ key: "kette", name: "Bernsteinkette", needs: [{ proto: "bernstein", count: 1 }, { proto: "muschel", count: 2 }, { proto: "tangseil", count: 1 }], tool: "muschelmesser", makes: "kette" },
	],
	orders: {
		rooms: ["graue-bucht", "kupferhafen-markt", "riffdorf", "schaerenhafen", "rauchhafen", "krabbenbucht"], max: 3, everyMs: 5 * 60_000, leaseMs: 30 * 60_000,
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
			{ key: "schaerenholz", text: "Arne braucht 2 Treibholz für das Schärenfeuer.", needs: [{ proto: "treibholz", count: 2 }], reward: { proto: "muenze", count: 2 }, rooms: ["schaerenhafen"] },
			{ key: "schaerenmuscheln", text: "Für die Netzgewichte der Robbenfänger: 3 Muscheln.", needs: [{ proto: "muschel", count: 3 }], reward: { proto: "muenze", count: 2 }, rooms: ["schaerenhafen"] },
			{ key: "rauchbuendel", text: "Kupferhafen bestellt 2 Holzbündel aus dem Köhlerwald.", needs: [{ proto: "holzbuendel", count: 2 }], reward: { proto: "muenze", count: 5 }, rooms: ["rauchhafen"] },
			{ key: "rauchbernstein", text: "Ein Händler aus Kupferhafen sucht Bernstein vom Schwarzen Strand.", needs: [{ proto: "bernstein", count: 1 }], reward: { proto: "muenze", count: 5 }, rooms: ["rauchhafen"] },
			{ key: "krabbenholz", text: "Holz für das Feuer der Krabbenbucht: 2 Treibholz.", needs: [{ proto: "treibholz", count: 2 }], reward: { proto: "muenze", count: 3 }, rooms: ["krabbenbucht"] },
			{ key: "nebelblume", text: "Gesa sucht eine Nebelblume von Nebelholm.", needs: [{ proto: "nebelblume", count: 1 }], reward: { proto: "muenze", count: 9 }, rooms: ["kupferhafen-markt"] },
			{ key: "rosen", text: "Für den Brautstrauß: 2 Dünenrosen.", needs: [{ proto: "duenenrose", count: 2 }], reward: { proto: "muenze", count: 7 }, rooms: ["kupferhafen-markt"] },
			{ key: "gemuese", text: "Die Schenke im Hafenviertel braucht 2 Kohl und 2 Möhren.", needs: [{ proto: "kohl", count: 2 }, { proto: "moehre", count: 2 }], reward: { proto: "muenze", count: 5 }, rooms: ["kupferhafen-markt"] },
			{ key: "nelken", text: "Ein Kapitän will seiner Liebsten 3 Strandnelken mitbringen.", needs: [{ proto: "strandnelke", count: 3 }], reward: { proto: "muenze", count: 6 }, rooms: ["graue-bucht"] },
			{ key: "brot", text: "Die Schenke im Hafenviertel braucht 3 Brote.", needs: [{ proto: "brot", count: 3 }], reward: { proto: "muenze", count: 9 }, rooms: ["kupferhafen-markt"] },
			{ key: "mehl", text: "Ines will selbst backen: 2 Säcke Mehl.", needs: [{ proto: "mehl", count: 2 }], reward: { proto: "muenze", count: 4 }, rooms: ["graue-bucht"] },
			{ key: "segel", text: "Die Werft näht ein Segel: 2 Ballen Leinen.", needs: [{ proto: "leinen", count: 2 }], reward: { proto: "muenze", count: 12 }, rooms: ["kupferhafen-markt"] },
			{ key: "riffbrot", text: "Die Riffischer fahren lange hinaus: 2 Brote für die Fahrt.", needs: [{ proto: "brot", count: 2 }], reward: { proto: "muenze", count: 6 }, rooms: ["riffdorf"] },
			{ key: "eier", text: "Die Schenke im Hafenviertel braucht 4 Eier.", needs: [{ proto: "ei", count: 4 }], reward: { proto: "muenze", count: 6 }, rooms: ["kupferhafen-markt"] },
			{ key: "wolle", text: "Für warme Netzhandschuhe: 2 Knäuel Wolle.", needs: [{ proto: "wolle", count: 2 }], reward: { proto: "muenze", count: 6 }, rooms: ["graue-bucht", "riffdorf"] },
			{ key: "milch", text: "Momme will Milch für die Kinder: 2 Krüge.", needs: [{ proto: "milch", count: 2 }], reward: { proto: "muenze", count: 4 }, rooms: ["krabbenbucht"] },
			{ key: "tuch", text: "Der Schneider am Kai braucht 2 Stück Wolltuch.", needs: [{ proto: "tuch", count: 2 }], reward: { proto: "muenze", count: 16 }, rooms: ["kupferhafen-markt"] },
			{ key: "decke", text: "Für eine Aussteuer: eine Daunendecke.", needs: [{ proto: "decke", count: 1 }], reward: { proto: "muenze", count: 24 }, rooms: ["kupferhafen-markt"] },
			{ key: "kaese", text: "Die Fischer im Riffdorf wollen Käse für die Fahrt: 2 Laibe.", needs: [{ proto: "kaese", count: 2 }], reward: { proto: "muenze", count: 9 }, rooms: ["riffdorf"] },
			{ key: "krabbenseil", text: "Momme braucht ein Tangseil für die Krabbenkörbe.", needs: [{ proto: "tangseil", count: 1 }], reward: { proto: "muenze", count: 4 }, rooms: ["krabbenbucht"] },
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

// The settlers (docs/siedeln.md "Wenige Spieler", server/npc/settlers.ts): figures that play like people where too few
// people play. Each lives in a room of one fire's light,
// spread over the nine fires. How many play at once is the setting settlers.min, less the people online.
const SETTLER_NAMES = ["Fenna", "Tjark", "Swantje", "Frauke", "Talea", "Ubbo", "Gesche", "Enno", "Neele", "Tomke", "Lüder", "Femke", "Keno", "Rieke", "Harm", "Anke",
	"Jelto", "Hilke", "Sönke", "Telse", "Wübbo", "Ebba", "Fiete", "Thees", "Inken", "Broder", "Hayo", "Silke", "Antje", "Folkert", "Gerda", "Heike", "Tamme", "Mareike", "Remmer", "Dörte",
	"Eilert", "Hedda", "Onno", "Wenke"];
// a quarter of the light stays free for people: three quarters of 20 is the 15 points of a village
world.settlers = { reserve: 0.25, maxBeds: 2 };
const settlers: NpcDef[] = [];
world.npcs.push(...SETTLER_NAMES.map((name, i): NpcDef => {
	const fire = world.beacons[i % world.beacons.length]!, room = fire.covers[Math.floor(i / world.beacons.length) % fire.covers.length]!;
	const r = world.rooms.find((x) => x.roomId === room)!;
	// a cell of its own near the room's spawn: nobody and nothing stands there from the start
	const taken = new Set([...world.npcs, ...settlers, ...world.objects, ...world.beacons, ...world.exits, r.spawn].filter((o) => !("room" in o) || o.room === room).map((o) => `${o.x},${o.y}`));
	let at = near(room, r.spawn.x, r.spawn.y + 1);
	for (let d = 1; taken.has(`${at.x},${at.y}`); d++) at = near(room, r.spawn.x + (d % 7) - 3, r.spawn.y + 1 + Math.floor(d / 7));
	const s: NpcDef = { npcId: `siedler-${i + 1}`, name, skin: i % 5, room, ...at, script: "siedler", beacon: fire.beaconId, home: fire.covers, settler: true };
	settlers.push(s);
	return s;
}));

// The plants come last: they keep clear of everything placed above (the spawn, the ways in and out, people, fires,
// things). Ground stays as it is, the hand-drawn rooms included.
for (const r of world.rooms) {
	const p = byId.get(r.roomId)!;
	const keep: Cell[] = [r.spawn, ...world.npcs.filter((n) => n.room === r.roomId), ...world.beacons.filter((b) => b.room === r.roomId),
		...world.objects.filter((o) => o.room === r.roomId), ...world.exits.filter((e) => e.room === r.roomId),
		...world.exits.filter((e) => e.destination === r.roomId).map((e) => e.arrive)];
	r.decor = plants(r.ground, r.roomId, p.flora ?? ISLANDS[p.island]!.flora, keep);
}
