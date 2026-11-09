// Help articles of the game, German and English. Markdown with explicit {#anchor} ids on H2/H3 and `help.<topic>#anchor`
// links between articles (resolved by HelpPanel). Trusted text, authored here; the in-game `help` command and the
// world's HelpEntry topics (worlds/leuchtfeuer/world.ts) are the text-mode counterpart.

export type Lang = "de" | "en";

export interface Article {
	id: string;
	section: "start" | "play" | "reference";
	title: Record<Lang, string>;
	short: Record<Lang, string>;
	body: Record<Lang, string>;
}

export const SECTIONS: Record<Article["section"], Record<Lang, string>> = {
	start: { de: "Einstieg", en: "Getting started" },
	play: { de: "Spielen", en: "Playing" },
	reference: { de: "Referenz", en: "Reference" },
};

export const DEFAULT_ARTICLE = "help.game.overview";

export const ARTICLES: Article[] = [
	{
		id: "help.game.overview",
		section: "start",
		title: { de: "Was ist Leuchtfeuer?", en: "What is Leuchtfeuer?" },
		short: {
			de: "Ein Archipel im Nebel, in dem viele Leute gemeinsam Leuchtfeuer am Brennen halten.",
			en: "An archipelago in the fog where many people keep beacons burning together.",
		},
		body: {
			de: `## Überblick {#overview}

Leuchtfeuer ist ein Spiel im Browser, das viele Leute zugleich spielen. Ihr lebt auf kleinen Inseln im Nebel und haltet gemeinsam die Feuer am Brennen. Wo Licht ist, kann man sammeln, handeln, bauen und Gärten anlegen. Du musst nichts installieren und kannst sofort als Gast anfangen.

Der Archipel hat acht Inseln mit 37 Orten und neun Leuchtfeuern. Wo ein Feuer brennt, ist der Nebel licht. Wo es erlischt, rückt der Nebel vor und verschluckt die Wege.

Du spielst eine Figur auf einer **Karte**, flach in 2D oder als Modell in 3D, oder nur mit **Text**, wie in einem MUD. Alles, was du tust, ist ein Textbefehl: ein Klick auf die Karte ist ein \`step\`, „Hierhin gehen“ im Menü ist \`move x y\`, ein Druck auf die Leertaste ist \`get …\`. Wer lieber tippt, kommt mit denselben Befehlen zum selben Ergebnis.

## Was die Welt besonders macht {#idea}

Hier arbeitet niemand für sich allein. Was einer sammelt, hilft allen, und was ihr aufbaut, bleibt stehen, solange ihr es pflegt.

- **Gemeinsam statt allein:** Kein Spieler kann ein Feuer auf Dauer allein halten. Die Welt lebt davon, dass viele sich gegenseitig zuarbeiten.
- **Jeder darf mitmachen:** Du kannst sofort als **Gast** losspielen. Wer sich registriert, behält Figur und Fortschritt ([Gast und Konto](help.game.account)).
- **Echtzeit:** Andere Spieler siehst du live auf der Karte, auch Figuren des Spiels wie Ines und Bo sind unterwegs ([Figuren der Welt](help.game.fire#people)).
- **Aufbau:** Hütten, Beete, Äcker, Mühlen und Tiere machen aus einer Insel mit der Zeit ein Dorf ([Dorf und Siedlung](help.game.village)).
- **Eine Welt auf phi-spaces:** Strandgut, das nur einer aufheben kann, ein Feuer, das von allein erlischt, ein Tausch, der ganz oder gar nicht gilt: Die Regeln sind die Eigenschaften des Space.

Weiter: [Spielziel](help.game.goal), [Erste Schritte](help.game.start), [Steuerung](help.game.controls), [Befehle](help.game.commands).

## Wie die Welt läuft {#tech}

Für dich ist es eine einzige Welt. Im Hintergrund arbeiten mehrere Programme zusammen, damit das Spiel auch mit vielen Leuten schnell bleibt.

Die Welt ist in **vier Regionen** geteilt, jede mit eigenem Space und eigenen Prozessen: West (Graue Insel, Nebelholm), Nord (Möwenfels, Schären), Ost (Kupferhafen, Tangriff, Rauchholm) und Süd (Krabbensand). Nur Fähren führen von einer Region in die andere; dabei wechselt die Figur den Space. Jede Region hat eine eigene Startbucht. Im Betrieb laufen die Regionen und der Web-Prozess auf dem Rechner *big*, die Konten und der Chat in einem eigenen Space auf *nano*. Die Leiste unter dem Spiel zeigt, welche Rechner gerade mitarbeiten.`,
			en: `## Overview {#overview}

Leuchtfeuer is a browser game that many people play at once. You live on small islands in the fog and keep the fires burning together. Where there is light you can gather, trade, build and lay out gardens. You install nothing and can start at once as a guest.

The archipelago has eight islands with 37 places and nine beacons. Where a beacon burns, the fog lifts. Where it goes out, the fog advances and swallows the paths.

You play a character on a **map**, flat in 2D or as models in 3D, or with **text** only, like a MUD. Everything you do is a text command: a click on the map is a \`step\`, "Hierhin gehen" in the menu is \`move x y\`, the space bar is \`get …\`. If you prefer typing, the same commands lead to the same result.

## What makes the world special {#idea}

Nobody works alone here. What one person gathers helps everyone, and what you build stays as long as you look after it.

- **Together, not alone:** nobody can keep a beacon burning alone for long. The world lives on many people working for each other.
- **Anyone can join:** you can start at once as a **guest**. Registering keeps your character and progress ([Guest and account](help.game.account)).
- **Real time:** you see other players live on the map; characters of the game, like Ines and Bo, walk around too ([Characters of the world](help.game.fire#people)).
- **Building up:** huts, beds, fields, mills and animals turn an island into a village over time ([Village and settlement](help.game.village)).
- **A world on phi-spaces:** driftwood that only one can pick up, a fire that goes out by itself, a trade that happens wholly or not at all: the rules are properties of the space.

Next: [Goal](help.game.goal), [First steps](help.game.start), [Controls](help.game.controls), [Commands](help.game.commands).

## How the world runs {#tech}

To you it is one world. Behind it several programs work together so the game stays fast with many people.

The world is divided into **four regions**, each with a space and processes of its own: West (Graue Insel, Nebelholm), North (Möwenfels, Schären), East (Kupferhafen, Tangriff, Rauchholm) and South (Krabbensand). Only ferries lead from one region to another; a figure changes space on the way. Each region has a starting bay of its own. In production the regions and the web process run on the machine *big*, accounts and chat in a space of their own on *nano*. The bar below the game shows which machines are working.`,
		},
	},
	{
		id: "help.game.goal",
		section: "start",
		title: { de: "Spielziel und Spielschleife", en: "Goal and game loop" },
		short: {
			de: "Feuer halten, Wege offen halten, gemeinsam Neues erreichen.",
			en: "Keep the fires, keep the paths open, reach new things together.",
		},
		body: {
			de: `## Das Ziel {#goal}

Es gibt keinen Endstand und keine festen Klassen. Dein Ziel: **die Leuchtfeuer am Brennen halten** und damit die Wege, Märkte und Orte, die im Licht liegen. Rolle und Ruf ergeben sich aus dem, was du tust: Strandläufer, Händler, Bootsmann oder Wärter.

Wer viel ins Feuer legt, steht im **Ruf** (\`ruf\` zeigt, was du beigetragen hast). Ruf bringt auch, was der Gemeinschaft dient: am Gemeinschaftsbeet pflanzen, gießen, jäten oder ernten, den Bau eines anderen ausbessern, fremde Tiere füttern, einen Park pflegen. Jedes Feuer zeigt öffentlich, wer wie viel eingebracht hat.

## Die Spielschleife {#loop}

Ein Spieltag besteht aus wenigen Schritten, die sich wiederholen. Was du sammelst, nährt das Feuer, und das Feuer schützt, was ihr aufbaut.

1. **Bergen:** Die Flut spült Treibholz, Tang und Muscheln als **Strandgut** an die Strände. Es bleibt nur eine Weile liegen, dann trägt die See es wieder fort. Wer zuerst ankommt, bekommt es, auch wenn zehn gleichzeitig zugreifen.
2. **Verarbeiten:** Aus Strandgut wird Brennstoff und Werkzeug (\`craft\`, siehe [Handel und Handwerk](help.game.trade)).
3. **Feuer halten:** Brennholz ins Leuchtfeuer legen verlängert, wie lange es brennt. Brennt es nicht, steigt der Nebel Stufe für Stufe ([Feuer, Nebel, Flut](help.game.fire)).
4. **Handeln:** Mit anderen tauschen, am Marktbrett kaufen und verkaufen, Aufträge der Auftragstafel erfüllen.
5. **Aufbauen:** Im Licht eines Feuers baut ihr gemeinsam [Hütten](help.game.build), legt [Gärten](help.game.garden) und [Äcker](help.game.fields) an und haltet [Tiere](help.game.animals). So wird eine Insel zum [Dorf](help.game.village). Absprechen geht im [Chat](help.game.chat), auch über die Inseln.
6. **Erkunden:** Fähren verbinden die acht Inseln, solange der Nebel nicht zu dicht ist. \`help inseln\` nennt die Wege.

## Zielkonflikt {#conflict}

Brennholz kannst du **selbst verbrauchen** (Werkzeug bauen, Handel) oder **ins gemeinsame Feuer legen**. Das ist die Entscheidung, um die das Spiel kreist.`,
			en: `## The goal {#goal}

There is no end state and there are no fixed classes. Your goal: **keep the beacons burning**, and with them the paths, markets and places that lie in the light. Role and reputation come from what you do: beachcomber, trader, boatman or keeper.

Whoever puts a lot into the fire gains **reputation** (\`reputation\` shows what you contributed). Whatever serves the community counts as well: planting, watering, weeding or harvesting at the community bed, repairing someone else's building, feeding someone else's animals, tending a park. Every beacon shows publicly who put in how much.

## The game loop {#loop}

A day in the game is a few steps that repeat. What you gather feeds the fire, and the fire protects what you build.

1. **Salvage:** the tide washes driftwood, kelp and shells ashore as **flotsam**. It lies only a while before the sea carries it off again. Whoever arrives first gets it, even if ten reach for it at once.
2. **Process:** flotsam becomes fuel and tools (\`craft\`, see [Trade and crafting](help.game.trade)).
3. **Keep the fire:** putting fuel into a beacon extends how long it burns. If it does not burn, the fog rises step by step ([Fire, fog, tide](help.game.fire)).
4. **Trade:** swap with others, buy and sell at the market board, fulfil jobs from the job board.
5. **Build up:** in a fire's light you build [huts](help.game.build) together, lay out [gardens](help.game.garden) and [fields](help.game.fields) and keep [animals](help.game.animals). That way an island becomes a [village](help.game.village). Agree on it in the [chat](help.game.chat), also across the islands.
6. **Explore:** ferries join the eight islands as long as the fog is not too thick. \`help inseln\` names the ways.

## The conflict {#conflict}

You can **use fuel yourself** (build tools, trade) or **put it into the shared fire**. That is the decision the game revolves around.`,
		},
	},
	{
		id: "help.game.start",
		section: "start",
		title: { de: "Erste Schritte in 3 Minuten", en: "First steps in 3 minutes" },
		short: {
			de: "Als Gast losspielen, Treibholz aufheben, das Feuer anzünden.",
			en: "Start as a guest, pick up driftwood, light the fire.",
		},
		body: {
			de: `## So fängst du an {#start}

Du brauchst kein Konto und keine Vorkenntnisse. In drei Minuten hast du dein erstes Feuer entzündet.

1. **Losspielen:** Auf der Startseite „Als Gast spielen“ wählen. Du erscheinst in einer der vier Buchten, an denen Neue ankommen: **Graue Bucht**, **Schärenhafen**, **Rauchhafen** oder **Krabbenbucht**, jede mit einem Leuchtfeuer im Steinring.
2. **Umsehen:** Tippe \`look\` (oder \`schau\`). Rechts im Seitenfeld steht, was neben dir liegt.
3. **Treibholz aufheben:** Geh zu einem braunen Quadrat auf dem Sand (Klick auf die Karte oder Pfeiltasten) und drücke die **Leertaste** oder den Knopf „Aufheben“, oder doppelklicke einfach darauf.
4. **Feuer anzünden:** Geh neben das Leuchtfeuer im Steinring und drücke wieder die Leertaste. Das Scheit brennt zehn Minuten. Der Nebel weicht.
5. **Weiter:** Sammle mehr Holz, sag Hallo (\`say Hallo\`; in jeder Bucht hütet jemand das Feuer), und nimm einen Weg hinaus: \`look\` zeigt sie, \`go <name>\` oder der Name allein nimmt einen (in der Grauen Bucht etwa \`ost\` zum Klippenpfad).

> Du hast dich verlaufen? \`help\` zeigt alle Befehle, diese Hilfe erklärt den Rest. Mit \`who\` siehst du, wer sonst da ist.

## Als Gast {#guest}

Gäste können sofort spielen, aber noch nicht tauschen oder handeln, und ihre Figur verfällt nach einigen Tagen ohne Spiel. Oben in der Kopfzeile kannst du dich registrieren und behältst alles ([Gast und Konto](help.game.account)).`,
			en: `## How to begin {#start}

You need no account and no experience. In three minutes you will have lit your first fire.

1. **Play:** on the start page choose “Play as guest”. You appear in one of the four bays where newcomers arrive: **Graue Bucht**, **Schärenhafen**, **Rauchhafen** or **Krabbenbucht**, each with a beacon in a stone ring.
2. **Look around:** type \`look\` (or \`schau\`). The side panel shows what lies next to you.
3. **Pick up driftwood:** walk to a brown square on the sand (click the map or use the arrow keys) and press the **space bar** or the “Pick up” button, or simply double-click it.
4. **Light the fire:** stand next to the beacon in the stone ring and press space again. One log burns ten minutes. The fog retreats.
5. **Go on:** collect more wood, say hello (\`say Hello\`; in every bay someone keeps the fire), and take a way out: \`look\` lists them, \`go <name>\` or the name alone takes one (in Graue Bucht for instance \`east\` to the cliff path).

> Lost? \`help\` lists all commands, this help explains the rest. \`who\` shows who else is there.

## As a guest {#guest}

Guests can play at once, but cannot swap or trade yet, and their character lapses after some days without play. You can register in the header bar and keep everything ([Guest and account](help.game.account)).`,
		},
	},
	{
		id: "help.game.controls",
		section: "play",
		title: { de: "Steuerung", en: "Controls" },
		short: {
			de: "Karte, Tastatur, Menü, Befehlszeile und Nur-Text-Modus.",
			en: "Map, keyboard, menu, command line and text-only mode.",
		},
		body: {
			de: `## Auf der Karte {#map}

Die Karte zeigt den Ort, an dem du gerade bist. Ein Klick lässt deine Figur dorthin gehen. Die rechte Maustaste öffnet ein Menü mit dem, was an dieser Stelle möglich ist.

| Eingabe | Wirkung |
| --- | --- |
| Klick auf ein Feld | Einen Schritt in diese Richtung (\`step dx dy\`) |
| Rechtsklick → **Hierhin gehen** | Den ganzen Weg dorthin |
| Tipp auf ein Feld | Am Handy den ganzen Weg dorthin, Schritt für Schritt; ein neuer Tipp ändert das Ziel |
| Doppelklick auf ein Ding | Hingehen und aufheben, wenn es nahe liegt (Holz, Muschel, Tang …); am Handy reicht ein Tipp, auch von weit |
| Rechtsklick oder langes Drücken | Menü zu diesem Feld (siehe unten) |
| Klick auf ein Ausgangsfeld | Zum Ausgang gehen; im Menü des Feldes steht „Nach … gehen“ (\`go\`, von überall im Raum) |
| 2D: Ziehen (gezoomt) | Die Ansicht verschieben |
| 2D: zwei Finger auseinander oder zusammen | Eine Zoomstufe vor oder zurück (1×, 2×, 3×) |
| 3D: Mausrad oder zwei Finger | Näher heran und weiter weg (Zoom): ganz weit draußen die ganze Insel als Blöcke mit Namen, ganz nah die Figuren mit Sprechblasen; ein Tipp auf eine Sprechblase öffnet die Aktionen der Figur, bei einem Tauschangebot mit „accept“ und „decline“. Nachts wird es dunkel, und die Fenster leuchten |
| 3D: Ziehen mit Maus oder Finger | Die Ansicht verschieben (links, rechts, hoch, runter) |
| 3D: Ziehen mit gedrücktem Mausrad oder mit Umschalttaste, Knöpfe ↶ ↷ | Die Ansicht drehen (die Knöpfe in Achtelschritten) |
| 3D: Alt+Mausrad, am Handy zwei Finger hoch/runter | Die Kamera neigen, ohne zu zoomen oder zu drehen (siehe [Ansicht in 3D](help.game.controls#view3d)) |

Das Menü bietet an, was zum Feld passt:

- **Ding oder Feuer:** ansehen, aufheben, nachlegen.
- **Figur:** ansehen, „Chat mit …“, Tausch anbieten. Tauschen geht mit jedem am selben Ort, nicht nur direkt neben dir: auch über ein Ding im Gepäck („… anbieten …“) und unter **Aktionen → Markt** („Tausch anbieten …“).
- **Baustelle:** liefern und mitarbeiten. Deine eigene ist auf der Karte hervorgehoben und heißt „Deine Baustelle“.
- **Freies Feld:** **Bauen …** (Plan wählen, dann OK: die Baustelle beginnt an diesem Feld nach rechts unten), mit Spaten ein Beet umgraben.
- **Beet oder Acker:** **ansehen** zeigt nur dieses eine Beet oder diesen einen Acker (nicht die der Nachbarn), dazu gießen, jäten, ernten, pflanzen, bestellen und zäunen, je nachdem, was gerade geht.
- **Eigene Figur:** Umsehen, Inventar, wer spielt, Uhrzeit, Ruf, Baupläne, Samen sammeln (nur, wo etwas Wildes wächst, und nicht, solange du ruhst).

Am Handy steht im Blatt zu einem Bau, Beet, Acker, Feuer oder Ausgang **Was ist das?**: Das öffnet den passenden Hilfeartikel.

## Ansicht in 3D {#view3d}

Neue Gäste und frisch registrierte Konten starten in **3D** mit einem Blick von vorn auf den ganzen Raum. Wer schon einmal gespielt hat, behält die zuletzt gewählte Ansicht: Text, 2D oder 3D samt Zoom, Drehung und Neigung sind beim nächsten Mal so, wie sie verlassen wurden.

**Neigen:** Beim Zoomen legt sich die Kamera von selbst flacher oder steiler. **Alt+Mausrad** neigt zusätzlich von Hand, höchstens ±25°, ohne Zoom und Drehung zu verändern; am Handy und Tablet **zwei Finger gemeinsam nach oben** (flacher) **oder unten** (steiler) ziehen. Mausrad und zwei Finger zoomen weiterhin, Ziehen dreht oder verschiebt wie oben.

**FPS messen:** In 3D steht oben links neben der Statistik der Knopf **FPS**. Er misst die Bildrate: 2 Sekunden Anlauf, dann 30 Sekunden Messung; der Knopf zählt die Sekunden herunter und zeigt danach das Ergebnis, etwa **58 FPS**. Ein weiterer Tipp misst neu. Wird der Tab versteckt oder die 3D-Ansicht neu gestartet, bricht die Messung ab. Nichts wird hochgeladen. Für ein ehrliches Ergebnis misst du auf dem Gerät selbst – die Handy-Nachbildung im Browser zählt nicht.

## Kulissen abräumen {#scenery}

Hütten, Netzgestelle, Boote und Fässer, die schon in der Welt stehen, sind Kulisse. Man läuft nicht hindurch und baut dort nicht. Stege und Anleger bleiben fest. Alles andere räumst du mit **räume** ab (oder über **Hier möglich**): Arbeit für Arbeit, wie auf einer Baustelle. Wer die letzte Arbeit tut, bekommt das Material darin, und das Land ist für immer frei für Bau, Beet oder Acker.

## Aushang {#orders}

Ein Aushang gehört immer zu einer Baustelle. Ihr Besitzer bietet dort Lohn für das, was fehlt. Baustellen mit Aushang sind auf der Karte markiert. Unter **Tasche → Aushang** stehen alle Aushänge des Raums: Mit **Hingehen** läufst du hin, neben der Baustelle (bis zwei Felder) lieferst du oder arbeitest mit und bekommst sofort den Lohn. An deiner eigenen Baustelle hängst du dort aus, was fehlt, und nimmst den Aushang wieder ab. Der Lohn liegt schon beim Aushang, was nicht verdient wird, kommt zurück.

## Alias {#alias}

Mit **Alias** (am Handy unter **⋯**) wählst du, unter welchem Namen dich alle im Spiel sehen. Angemeldet wirst du weiter mit deinem bisherigen Namen und Passwort. Was dir gehört, bleibt deins. Ein Alias ist einmalig: Einen Namen, den schon jemand nutzt oder zum Anmelden hat, gibt es kein zweites Mal.

## Figur {#avatar}

Unter **Figur** (am Handy unter **⋯**) wählst du, wie deine Figur auf der 3D-Karte aussieht: eine von vier Figuren (Wanderer, Seefahrerin, Kräftig, Schlaksig), die Farbe der Kleidung, Haarfarbe und Haut, dazu Hut, Mütze oder Kapitänsmütze, Brille und Handschuhe. Eine Vorschau dreht sich dabei; **Übernehmen** zeigt sie allen. Getippt geht es auch: \`avatar figur 2 farbe 5 hut 4 brille ja\` (Zahlen ab 1, nur was sich ändern soll), \`avatar\` allein sagt, wie die Figur jetzt aussieht, \`avatar zurück\` macht sie wieder wie zu Beginn. Die 2D-Karte zeigt weiter das Bild der Figur.

## Statistik {#stats}

Der Knopf mit den drei Balken links neben **?** öffnet die Statistik: wie viele spielen (registriert, Gäste, gerade online), wie oft gebeamt und mit dem Großen Schiff, dem Segelboot, dem Ruderboot und dem Zug gefahren wurde, und wie viele Häuser, Bauten, Felder, Beete, Baustellen und Siedlungen es gibt. Darunter stehen alle Spieler, dann die Siedler und die Figuren, die ein Sprachmodell spielt (KI-Figuren); ein Tipp auf einen Namen zeigt, wo die Figur steht (wer gerade nicht spielt: wo sie zuletzt stand; wer auf dem Großen Schiff fährt: nur „an Bord“), seit wann sie registriert ist, ihren Ruf über alle Leuchtfeuer, ihre Reisen und was ihr gehört. Gezählt werden Reisen seit Einführung der Statistik; die Zahlen sind höchstens eine halbe Minute alt.

## Am Handy und Tablet {#touch}

Am Handy steuerst du alles mit dem Finger. Das Spiel braucht dafür keine App.

Die Karte füllt den Bildschirm, im Browser am Rechner genauso, und die Kamera folgt deiner Figur. **Tippe auf ein Feld**, und sie geht den ganzen Weg dorthin. **Tippe auf eine Figur, ein Gebäude oder ein Beet**, und von unten öffnet sich, was du dort tun kannst; langes Drücken öffnet das für jedes Feld, auch ein freies zum Bauen. **Tippe auf ein Ding**, und du gehst hin und hebst es auf. Zwei Finger zoomen und drehen die Karte in 3D, Ziehen sieht sich um. Der Knopf **Zoom** wechselt die Stufe auch ohne zwei Finger.

Das **Steuerkreuz** geht Schritt für Schritt, solange du eine Richtung hältst. Unter **⋯** schaltest du es zusammen mit den Knöpfen für Zoom und Drehen ab oder legst es nach links. Über der Karte liegt ein Chip mit dem, was du gerade tun kannst, zum Beispiel **Treibholz nachlegen**; gibt es mehr, steht **+3** daneben, und ein Tipp klappt die Liste **Hier möglich** auf (ein Tipp auf die Karte klappt sie zu). Ausgänge außerhalb des Bilds stehen als Schild am Rand. Oben stehen Raumname und Uhrzeit; Epoche, Jahreszeit und Wind siehst du auf der Weltkarte. Nach drei Sekunden ohne Berührung werden Leiste, Chip und Steuerkreuz blass, damit du die Welt siehst; jede Berührung holt sie zurück.

Unten liegt ein **Blatt** mit [Aktionen, Ereignisse und Chats](help.game.controls#side). Zu ist es nur der Griff und die letzte Meldung; ein Tipp darauf öffnet die Ereignisse, und die Reiter erscheinen. Zieh es am Griff auf die Höhe und, wo es schmaler als die Seite ist, nach links oder rechts, dorthin, wo du es möchtest, es bleibt so; ein Tipp auf den Griff oder die Karte schließt es, der nächste Tipp öffnet es wieder auf dieser Höhe. Im Querformat ist es zu ein schmaler Streifen rechts unten und offen eine Lade über die ganze Höhe neben der Karte, und das Spiel geht beim ersten Tipp ins Vollbild, ohne Adressleiste (abschaltbar unter **⋯**; auf dem iPhone geht das nur vom Home-Bildschirm). Die Zurück-Taste schließt immer die oberste Ebene.

In der 3D-Karte wird es nachts dunkel; deine Figur trägt dann eine Laterne, die den Weg um sie herum erhellt. Dauert ein Weg an einen anderen Ort länger als eine Sekunde (mit dem Kahn, beim Beamen, mit dem Zug), steht über der Karte, dass du unterwegs bist. Ein Tipp auf den **Raumnamen** oben öffnet die Weltkarte. Dort zeigt der grüne Punkt, wo du bist, und farbige Quadrate zeigen, wo deine Bauten, Baustellen, Beete und Äcker liegen. Auf dem Home-Bildschirm wird das Spiel zu einer eigenen App ohne Adressleiste: am iPhone **Teilen → Zum Home-Bildschirm**, am Android-Handy **Browser-Menü ⋮ → Zum Startbildschirm hinzufügen**. Dann öffnest du es von dort.

## Weltkarte {#atlas}

Die Weltkarte zeigt alle Orte des Archipels. Am Rechner liegt sie klein am Rand; ein Klick vergrößert sie, dann wählst du einen Ort mit einem Klick. Am Handy öffnet ein Tipp auf den Raumnamen sie als Seite. Der grüne Punkt bist du, farbige Quadrate sind deine Bauten, Baustellen, Beete und Äcker, brennende Feuer sind markiert, ein roter Punkt unten rechts in einem Ort zeigt einen Markt mit Marktbrett. Die Legende unter der Karte sagt, welche Farbe was bedeutet, und wie viele Bauten, Baustellen, Beete, Äcker und Ruinen du hast.

Wählst du einen Ort, zieht die Karte eine gestrichelte Linie von dir dorthin und zeigt, ob sein Feuer brennt. Brennt es und erlaubt deine Insel das Beamen, steht dort **Hierher beamen** mit dem Preis ([Beamen](help.game.village#travel)).

## Tastatur {#keys}

Mit der Tastatur geht vieles schneller. Die Pfeiltasten laufen, die Leertaste hebt auf oder legt nach.

| Taste | Wirkung |
| --- | --- |
| Pfeiltasten | Einen Schritt gehen (\`step dx dy\`) |
| Leertaste | Aufheben, was neben dir liegt; sonst das Feuer neben dir nachlegen |
| Enter | In die Befehlszeile springen |
| Buchstaben, Ziffern | Einfach lostippen: der Text geht in die Befehlszeile |
| Pfeiltasten in der Befehlszeile | Zurück zur Karte und einen Schritt gehen: hoch und runter immer, links und rechts, solange die Zeile leer ist (mit Text bewegen sie den Cursor) |
| Esc | Aus der Befehlszeile zurück zur Karte; schließt Menüs und diese Hilfe |

Die Tasten gelten, solange die Befehlszeile nicht den Fokus hat.

## Seitenfeld {#side}

Das Seitenfeld zeigt, was gerade wichtig ist: was neben dir liegt, was du trägst und wie lange das Feuer noch brennt. Darunter steht alles, was du siehst und hörst.

Rechts (auf dem Handy und dem Tablet im Hochformat im Blatt, dort im Reiter **Aktionen**) stehen unter **Bei dir** **Neben dir** und **Du trägst**, unter **Hier** das **Leuchtfeuer** mit Restzeit und alles, was an deinem Platz möglich ist (eine Zahl am Reiter sagt, wie viel), jeweils mit Knöpfen; ein Tipp auf etwas, das du trägst, zeigt, was du gerade damit tun kannst. **Tipps** sagen, was aus deinen Dingen werden kann: was du jetzt herstellen kannst (aus 3 Tang ein Tangseil), welches Werkzeug dir noch fehlt (das Muschelmesser für Holzbündel), wo etwas weitergeht (Weizen zur Windmühle, das Mehl ins Backhaus; eine Ziege ins Gehege, ihre Milch zu Käse) und was nur ein Stück fehlt. Alle Tipps stehen in den Ereignissen im Reiter **Tipps**; eine Zahl daran zählt die neuen, die dort markiert sind. Beim angetippten Ding stehen seine. Unter **⋯** schaltest du sie aus. Unter **Du trägst** die **Befehlszeile** mit der letzten Antwort. Darunter (am Handy: Reiter **Ereignisse**) die **Ereignisse** mit allem, was du siehst und hörst, daneben die Reiter des [Chats](help.game.chat) (je Gespräch einer, „Chats“ als Übersicht). Die Ereignisse haben Reiter wie die Aktionen: **An dich** mit den Antworten auf deine Befehle, Fehlern, was dir allein gesagt oder angeboten wird, was dich nennt (auch wenn dir jemand etwas gibt); **Allgemein** mit dem, was um dich herum geschieht; **Tipps** mit allen Tipps zu dem, was du trägst; **Aufgaben** mit dem, was deine Dinge gerade von dir wollen: ein reifer Acker oder ein reifes Beet zum Ernten, ein trockenes Beet zum Gießen, Unkraut, eine Baustelle, der noch etwas fehlt, hungrige Tiere oder Eier, Milch und Wolle zum Einsammeln, Mehl an der Mühle zum Abholen, jeweils mit Ort und Feld. Hat ein Ort mehrere Aufgaben, stehen sie gebündelt unter seinem Namen mit ihrer Zahl; ein Tipp darauf klappt sie auf. Eine Zahl am Reiter zeigt, wie viel dort neu ist (bei **An dich**, was andere dir gesagt oder angeboten haben; dieselbe Zahl steht oben am Reiter **Ereignisse**); bei den Aufgaben, wie viele jetzt dran sind. Unter „Allgemein“ blendet „Kommen und Gehen“ die Meldungen ein, wer kommt und geht. Gibt ein Befehl etwas aus, öffnet sich am Rechner das Ereignisfenster zwei Zeilen hoch, damit du die Antwort siehst (nicht beim Aufheben von Dingen); am Handy bleibt das Blatt zu, die Antwort steht in seinem Streifen, und ein Tipp darauf öffnet die Ereignisse.

## Kopfzeile {#bar}

Die Kopfzeile zeigt, wo du bist und wie spät es in der Welt ist. Dort stellst du auch die Ansicht um.

- **?** öffnet diese Hilfe.
- Der Punkt zeigt, ob du verbunden bist (grün) oder nicht (rot).
- Daneben stehen der **Raum**, in dem du bist, und die **Weltzeit** (Tag und Uhrzeit; ⏸, wenn die Welt angehalten ist), rechts dein Name. Zwischen Raum und Weltzeit steht **Epoche: x**, die Stufe deiner Insel (1 Fischerdorf bis 4 Netz, siehe [Epochen](help.game.village#epochs)).
- **Text / 2D / 3D** wählt die Darstellung. **Text** blendet die Karte aus: für Screenreader, schwache Geräte oder wer es lieber wie ein MUD mag; alles bleibt spielbar. **2D** ist die Kachelkarte, **3D** eine Ansicht derselben Welt von schräg oben.
- **Admin** (nur für Admins) öffnet das Fenster für Modelle und Grenzen.
- **Abmelden** beendet die Sitzung.
- Am Handy gibt es keine Kopfzeile: Raum, Punkt und Weltzeit stehen oben links über der Karte, **?** und **⋯** rechts. Darstellung, Steuerkreuz, Abmelden und die Nachweise liegen hinter **⋯**.`,
			en: `## On the map {#map}

The map shows the place you are in. A click sends your figure there. The right mouse button opens a menu with what you can do at that spot.

| Input | Effect |
| --- | --- |
| Click a cell | One step that way (\`step dx dy\`) |
| Right click → **Hierhin gehen** | The whole way there |
| Tap a cell | On a phone the whole way there, step by step; a new tap changes the goal |
| Double click on a thing | Walk there and pick it up when it lies close (wood, shell, kelp …); on a phone one tap is enough, from afar too |
| Right click or long press | Menu for that cell (see below) |
| Click an exit cell | Walk to the exit; the cell's menu has “Go to …” (\`go\`, from anywhere in the room) |
| 2D: drag (zoomed in) | Move the view |
| 2D: two fingers apart or together | One zoom step in or out (1×, 2×, 3×) |
| 3D: mouse wheel or two fingers | Zoom in and out: far out the whole island as blocks with names, close up the figures with speech bubbles; a tap on a bubble opens the figure's actions, with „accept“ and „decline“ when it offers a trade. At night it gets dark and the windows light up |
| 3D: drag with mouse or finger | Move the view (left, right, up, down) |
| 3D: drag with the mouse wheel held down or with Shift, ↶ ↷ buttons | Turn the view (the buttons in eighths) |
| 3D: Alt+mouse wheel, on a phone two fingers up/down | Tilt the camera without zooming or turning (see [The 3D view](help.game.controls#view3d)) |

The menu offers what fits the cell:

- **Thing or fire:** look, pick up, add fuel.
- **Figure:** look, “Chat with …”, offer a swap. You can trade with anyone in the same place, not only right next to you: also from a thing in your pack (“… offer …”) and under **Actions → Market** (“Offer a swap …”).
- **Site:** deliver and help. Your own is highlighted on the map and called “Deine Baustelle”.
- **Free cell:** **Build …** (pick a plan, then OK: the site starts at that cell towards the bottom right), dig a bed with a spade.
- **Bed or field:** **look** shows only that one bed or field (not those of the neighbours), plus water, weed, harvest, plant, sow and fence, whatever is possible right now.
- **Your own figure:** look, inventory, who plays, time, reputation, plans, gather seeds (only where something wild grows, and not while you rest).

On a phone the sheet for a building, bed, field, fire or exit has **Was ist das?**: it opens the fitting help article.

## The 3D view {#view3d}

New guests and freshly registered accounts start in **3D** with a front view of the whole room. Anyone who has played before keeps the view they last chose: text, 2D or 3D, with zoom, turn and tilt as they left them.

**Tilting:** While you zoom, the camera flattens or steepens on its own. **Alt+mouse wheel** tilts it by hand on top, up to ±25°, without changing zoom or turn; on a phone or tablet **drag two fingers up together** (flatter) **or down** (steeper). Wheel and two fingers still zoom, dragging turns or moves as above.

**FPS messen:** In 3D the top bar has an **FPS** button left of the statistics. It measures the frame rate: 2 seconds of warm-up, then 30 seconds of measuring; the button counts the seconds down and then shows the result, such as **58 FPS**. Another tap measures again. If the tab is hidden or the 3D view restarts, the measurement stops. Nothing is uploaded. For an honest number measure on the device itself – browser phone emulation does not count.

## Clearing scenery {#scenery}

Huts, net racks, boats and barrels that already stand in the world are scenery. You do not walk through them and cannot build there. Jetties stay. Everything else you clear with **räume** (or through **Hier möglich**): work by work, like on a site. Whoever does the last work gets the material in it, and the land is free for good for a building, a bed or a field.

## Site orders {#orders}

An order ("Aushang") always belongs to a site. Its owner offers a wage there for what is missing. Sites with an order are marked on the map. Under **Tasche → Aushang** you find all orders of the room: **Hingehen** walks you there, and beside the site (up to two cells) you deliver or work and are paid at once. At your own site you hang out what is missing there, and take it down again. The wage already lies with the order; what is not earned comes back.

## Alias {#alias}

**Alias** (on a phone under **⋯**) sets the name everyone sees in the game. You keep logging in with your name and password as before, and what you own stays yours. An alias is unique: a name someone already uses or logs in with cannot be taken.

## Figure {#avatar}

**Figure** (on a phone under **⋯**) sets how your figure looks on the 3D map: one of four figures (Wanderer, Seafarer, Sturdy, Lanky), the colour of the clothes, hair and skin, and a hat, cap or captain's cap, glasses and gloves. A preview turns while you choose; **Apply** shows it to everyone. Typed it works too: \`avatar figure 2 color 5 hat 4 glasses yes\` (numbers from 1, only what should change), \`avatar\` alone says how the figure looks now, \`avatar reset\` makes it as at the start again. The 2D map keeps showing the figure's picture.

## Statistics {#stats}

The button with three bars left of **?** opens the statistics: how many play (registered, guests, online now), how often people beamed and rode the large ship, a sailing boat, a rowing boat and the train, and how many houses, buildings, fields, beds, sites and settlements there are. Below are all players, then the settlers and the figures a language model plays (AI figures); tapping a name shows where the figure stands (someone not playing right now: where it last stood; someone on the large ship: only "aboard"), since when it is registered, its reputation over all beacons, its journeys and what it owns. Journeys count from when the statistics were introduced; the numbers are at most half a minute old.

## On a phone or tablet {#touch}

On a phone you steer everything with your finger. The game needs no app for it.

The map fills the screen, in a desktop browser too, and the camera follows your figure. **Tap a cell** and it walks the whole way there. **Tap a figure, a building or a bed** and what you can do there opens from below; a long press opens that for any cell, a free one for building too. **Tap a thing** and you walk there and pick it up. Two fingers zoom, and turn the map in 3D; dragging looks around. The **Zoom** button changes the step without two fingers.

The **D-pad** walks step by step while you hold a direction. Under **⋯** you switch it off, together with the zoom and turn buttons, or move it to the left. Above the map a chip shows what you can do right now, for example **Treibholz nachlegen**; with more to do, **+3** stands beside it, and a tap unfolds the list **Hier möglich** (a tap on the map folds it). Exits outside the picture stand as signs at its edge. At the top stand the room's name and the time; epoch, season and wind are on the world map. After three seconds without a touch the bar, the chip and the D-pad fade so that you see the world; any touch brings them back.

At the bottom lies a **sheet** with [actions, events and chats](help.game.controls#side). Closed, it is its handle and the last message alone; a tap on it opens the events, and the tabs appear. Drag its handle to the height you like and, where it is narrower than the page, left or right, and it stays there; a tap on the handle or the map closes it, the next tap opens it at that height again. On its side it is, closed, a narrow strip at the bottom right and, open, a drawer over the whole height beside the map, and the game goes to full screen at the first tap, without the address bar (off under **⋯**; on an iPhone only from the home screen). The back button always closes the topmost layer.

In the 3D map it grows dark at night; your figure then carries a lantern that lights the way round it. When getting to another place takes longer than a second (by ferry, beaming, by train), the map says that you are on your way. A tap on the **room name** at the top opens the world map. The green dot shows where you are, coloured squares where your buildings, sites, beds and fields lie. On the home screen the game becomes an app of its own without an address bar: on an iPhone **Share → Add to Home Screen**, on an Android phone **browser menu ⋮ → Add to Home screen**. Then open it from there.

## World map {#atlas}

The world map shows every place of the archipelago. On a desktop it sits small at the edge; a click enlarges it, and then a click picks a place. On a phone a tap on the room name opens it as a page. The green dot is you, coloured squares are your buildings, sites, beds and fields, burning fires are marked, and a red dot in the lower right of a place shows a market with its board. The legend below the map says what each colour means, and how many buildings, sites, beds, fields and ruins you have.

If you pick a place, the map draws a dashed line from you to it and shows whether its fire burns. If it burns and your island allows beaming, **Hierher beamen** appears there with the price ([Beaming](help.game.village#travel)).

## Keyboard {#keys}

The keyboard makes many things quicker. The arrow keys walk, the space bar picks up or adds fuel.

| Key | Effect |
| --- | --- |
| Arrow keys | Take one step (\`step dx dy\`) |
| Space | Pick up what lies next to you; otherwise feed the fire next to you |
| Enter | Jump to the command line |
| Letters, digits | Just start typing: the text goes to the command line |
| Arrow keys in the command line | Back to the map and one step: up and down always, left and right while the line is empty (with text they move the cursor) |
| Esc | Leave the command line back to the map; closes menus and this help |

The keys work as long as the command line does not have the focus.

## Side panel {#side}

The side panel shows what matters right now: what lies next to you, what you carry and how long the fire still burns. Below it stands everything you see and hear.

On the right (below the map on a phone and an upright tablet) you find, under **With you**, **Next to you** and **You carry**, and under **Here** the **beacon** with its time left and everything you can do where you stand (a number on the tab says how much), each with buttons; a tap on something you carry shows what you can do with it right now. **Tips** say what your things can become: what you can make now (a kelp rope from 3 kelp), which tool you still lack (the shell knife for wood bundles), where something goes on (wheat to the windmill, the flour to the bakehouse; a goat into a pen, its milk to cheese) and what lacks a single piece. All tips stand in the events' tab **Tips**; a number on it counts the new ones, which are marked there. A tapped thing shows its own. Under **⋯** you turn them off. Under **You carry** the **command line** with its last answer. Below that the **events** with everything you see and hear, beside it the tabs of the [chat](help.game.chat) (one per talk, “Chats” as the overview). The events have tabs like the actions: **To you** with the answers to your commands, errors, what is said or offered to you alone, what names you (also someone giving you something); **General** with what happens around you; **Tips** with every tip about what you carry; **Tasks** with what your things want of you right now: a ripe field or bed to harvest, a dry bed to water, weeds, a site that still lacks something, hungry animals or eggs, milk and wool to collect, flour to pick up at the mill, each with its place and cell. Several tasks in one place stand together under its name with their number; a tap opens them. A number on a tab shows how much is new there (on **To you**, what others said or offered to you; the same number stands on the **Events** tab above); on the tasks, how many are due now. Under “General”, “Kommen und Gehen” shows the lines about who comes and goes.

## Header bar {#bar}

The header bar shows where you are and what time it is in the world. You also switch the view there.

- **?** opens this help.
- The dot shows whether you are connected (green) or not (red).
- Next to it the **room** you are in and the **world time** (day and hour; ⏸ while the world is paused), on the right your name. Between the room and the world time stands **Epoche: x**, the stage of your island (1 fishing village to 4 network, see [Epochs](help.game.village#epochs)).
- **Text / 2D / 3D** picks the view. **Text** hides the map: for screen readers, weak devices or if you prefer a MUD feel; everything stays playable. **2D** is the tile map, **3D** a view of the same world from above at an angle.
- **Admin** (admins only) opens the window for models and limits.
- **Log out** ends the session.
- A phone has no header bar: room, dot and world time stand top left over the map, **?** and **⋯** on the right. View, D-pad, logging out and the credits sit behind **⋯**.`,
		},
	},
	{
		id: "help.game.commands",
		section: "reference",
		title: { de: "Befehle", en: "Commands" },
		short: {
			de: "Alle Befehle, auf Deutsch und Englisch.",
			en: "All commands, in German and English.",
		},
		body: {
			de: `## So funktionieren Befehle {#how}

Ein Befehl ist ein kurzes Wort, das deine Figur etwas tun lässt. Tippe einfach los, die Buchstaben landen in der Befehlszeile. Jeder Befehl gilt **auf Englisch und auf Deutsch**, ohne Umschalter: \`get treibholz\` und \`nimm holz\` sind dasselbe.

Dinge findest du über Name oder Kurzname (\`holz\`, \`wood\`). Den Namen eines Ausgangs kannst du allein tippen (\`ost\`). \`help <befehl>\` erklärt einen Befehl, \`help\` listet alle. Auch kurze Sätze wie \`lege 3 hölzer ins feuer\` versteht das Spiel.

## Bewegen und umsehen {#move}

Hiermit gehst du durch die Welt und siehst dich um. Auf der Karte erledigen Klicks und Pfeiltasten dasselbe.

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`look [ding]\` | \`schau\`, \`l\` | Umsehen, oder ein Ding, einen Ausgang, eine Person ansehen |
| \`move <x> <y>\` | \`laufe\` | Zu einer Stelle gehen, den ganzen Weg |
| \`step <dx> <dy>\` | \`schritt\` | Einen Schritt gehen |
| \`go <richtung>\` | \`geh\`, \`gehe\` | Einen Ausgang nehmen |
| \`who\` | \`wer\` | Wer gerade spielt |
| \`time\` | \`zeit\` | Tag und Uhrzeit in der Welt (steht auch oben in der Kopfzeile) |

## Dinge {#things}

Hiermit nimmst du Dinge auf, gibst sie weiter und nährst das Feuer. Die Leertaste erledigt das Häufigste davon.

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`get <ding>\` | \`nimm\`, \`heb\`, \`take\` | Etwas aufheben, das neben dir liegt |
| \`drop <ding>\` | \`leg\`, \`lege\`, \`lass\` | Etwas ablegen |
| \`give [anzahl] <ding> an <person>\` | \`gib\` | Jemandem etwas geben, auch mehrere: give 6 münzen an Bert (nicht als Gast) |
| \`inventory\` | \`inventar\`, \`i\` | Was du trägst |
| \`put [anzahl] <ding> in <feuer>\` | \`nachlegen\`, \`wirf\`, \`feed\` | Brennholz ins Leuchtfeuer legen (auch: \`lege 3 hölzer ins feuer\`) |

## Reden {#talk}

So sprichst du mit anderen. \`say\` hört der Raum, ein Kanal hört alle, der Chat nur, wen du ansprichst.

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`say <text>\` | \`sag\`, \`'text\` | Etwas sagen; alle im Raum hören es |
| \`emote <tut etwas>\` | \`geste\`, \`:winkt\` | Eine Handlung zeigen |
| \`channel <name> <text>\` | \`kanal\` | Auf einem Kanal sprechen, den alle hören (z. B. \`kanal hafen Hallo\`); ohne Text listet er die Kanäle |
| \`chat <name> <text>\` | \`tell\`, \`flüstere\` | Verschlüsseltes Gespräch zu zweit, auch über Inseln ([Chat](help.game.chat)) |
| \`gruppe …\` | \`group\` | Gruppen: gründen, einladen, schreiben, verlassen ([Chat](help.game.chat#groups)) |
| \`ignoriere <name>\` / \`erlaube <name>\` | \`ignore\` / \`unignore\` | Einen Spieler im Chat sperren oder wieder zulassen |

## Bauen {#buildcmds}

Bauen geht nur im Licht eines Feuers. Ausführlich unter [Bauen](help.game.build).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`bau <plan> [x y]\` | \`build\`, \`errichte\` | Im Licht eines Feuers eine Baustelle abstecken; ohne Plan die Baupläne |
| \`liefere [n] <ding>\` | \`deliver\` | An die Baustelle liefern (bis zwei Felder entfernt) |
| \`arbeite\` | \`work\` | An der Baustelle mitarbeiten (bis zwei Felder entfernt) |
| \`baustelle [x y]\` | \`site\` | Was hier gebaut wird und was fehlt (mit x y: nur auf diesem Feld) |
| \`aushang <n> <ding\|arbeit> je <münzen>\` | \`hire\` | An deiner Baustelle Lohn aushängen; \`aushang ab\` nimmt ihn zurück |
| \`truhe\`, \`verstaue\`, \`entnimm\` | \`chest\`, \`store\`, \`retrieve\` | Die Truhe deiner Hütte |
| \`lager\`, \`lager log\` | \`warehouse\` | Das Lagerhaus neben dir und wer zuletzt etwas bewegt hat |
| \`breche\` | \`quarry\` | Am Steinbruch mit Spitzhacke Stein brechen |
| \`steche\` | \`clay\` | An der Lehmgrube mit Spaten Lehm stechen |
| \`harke\` | \`salz\`, \`salt\` | Am Salzgarten Salz harken, ohne Werkzeug ([Salz](help.game.animals#salt)) |
| \`opfere <ding>\` | \`sacrifice\` | An einer Kapelle opfern: einen Tag lang kürzere Ruhe |
| \`antrag <zu\|offen\|text>\` | \`motion\` | Am Rathaus einen Antrag stellen; allein: den laufenden zeigen |
| \`antrag grünzone\`, \`antrag wegerecht\`, \`antrag zone frei\` | | Über die Fläche um dich abstimmen lassen |
| \`antrag steuer <n>\` | | Münzen je Stück für Entnahmen aus dem Lager und Käufe im Kaufhaus |
| \`antrag abriss\` | | Über den Abriss des Baus neben dir abstimmen lassen; was bleibt, gehört dem Besitzer als Nachlass |
| \`stimme ja\|nein\` | \`vote\` | Als Siedler über den Antrag abstimmen |
| \`repariere\` | \`repair\` | Einen Bau ausbessern |
| \`abriss\` | \`demolish\`, \`reiße … ab\` | Deinen Bau oder deine Baustelle abreißen |
| \`nachlass\` | \`estate\` | Den Nachlass an der Ruine deines Baus abholen |

## Gärten {#gardencmds}

Gärten brauchen einen Spaten, Wasser und Licht. Ausführlich unter [Gärten](help.game.garden).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`umgraben [zier/gemeinschaft] [x y]\` | \`beet anlegen\` | Mit einem Spaten im Licht ein Beet anlegen, ein Zierbeet oder ein Gemeinschaftsbeet |
| \`beet\` | \`bed\`, \`beete\` | Die Beete hier; \`beet aufgeben\` macht deins wieder zu Gras |
| \`sammle samen\` | \`samen\` | In der wilden Flora nach Samen suchen |
| \`pflanze [anzahl] <samen> [x y]\` | \`säe\`, \`plant\` | Samen in dein Beet setzen, z. B. \`pflanze 3 strandnelken\` |
| \`schöpfe\` | \`fill\` | An der Regentonne eine Kanne Wasser füllen |
| \`gieße\` | \`water\` | Ein Beet gießen (deins oder als Pate) |
| \`jäte\` | \`weed\` | Unkraut und Welkes herausziehen |
| \`ernte\` | \`harvest\`, \`pflücke\` | Reifes ernten, mit Samen; an einem reifen Acker ein Arbeitspunkt und dein Anteil |
| \`pate <name>\` | \`sponsor\` | Jemanden dein Beet pflegen lassen; \`pate weg <name>\` beendet es |
| \`benenne <name>\` | \`taufe\` | Deiner Kreuzung einen Namen geben (\`benenne 2 <name>\`, wenn du mehrere trägst) |

## Äcker {#fieldcmds}

Ein Acker ist ein großes Feld für viele Hände. Ausführlich unter [Äcker](help.game.fields).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`flur anlegen [x y]\` | \`acker anlegen\`, \`field\` | Mit einem Spaten im Licht einen Acker umbrechen (4×4); \`flur\` zeigt die Äcker hier, \`flur offen\`/\`flur zu\`, \`flur aufgeben\` |
| \`bestelle [frucht]\` | \`pflüge\`, \`plough\` | Den Acker bestellen: Frucht wählen, Saatgut und einen Arbeitspunkt bringen |
| \`dünge\` | \`duenge\`, \`fertilise\` | Den wachsenden Acker neben dir mit 2 Knochenmehl düngen: einmal je Frucht, die Hälfte mehr Ernte ([Knochenmehl](help.game.animals#bonemeal)) |

## Mühle und Backhaus {#millcmds}

Aus Korn wird Mehl, aus Mehl wird Brot. Ausführlich unter [Mühle und Backhaus](help.game.fields#mill).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`mahle [n oder alle] <korn>\` | \`mühle\`, \`grind\` | An einer Windmühle neben dir Korn zu Mehl mahlen lassen; \`mahle\` allein: wie lange sie noch mahlt |
| \`abholen\` | \`pickup\` | Dein fertiges Mehl an der Mühle abholen |
| \`backe [brot]\` | \`bake\` | Am Backhaus neben dir Brot backen (2 Mehl, 1 Kanne Wasser, 1 Treibholz) |

## Tiere {#animalcmds}

Tiere wollen gefüttert werden und geben dafür Eier, Milch, Wolle, Daunen oder Honig. Ausführlich unter [Tiere](help.game.animals).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`stall\` | \`coop\`, \`pen\` | Wie es den Tieren im Hühnerstall oder Gehege neben dir geht |
| \`einstallen <tier>\` | \`stalle\` | Ein Huhn, Schaf oder eine Ziege in deinen Stall bringen, einen Hund oder eine Katze an einem deiner Bauten wachen lassen |
| \`ausstallen [tier]\` | \`ausstellen\` | Ein Tier aus deinem Stall nehmen, auch \`ausstallen hund\` |
| \`füttere [futter]\` | \`futter\` | Die Tiere neben dir füttern (jeder darf; ein Futter macht ein Tier einen Tag satt) |
| \`einsammeln\` | \`sammle eier\`, \`melke\`, \`schere\` | Eier, Milch oder Wolle deiner Tiere einsammeln |
| \`schlachte [tier]\` | \`schlachten\` | Ein Tier aus deinem Stall oder Gehege schlachten, an der Metzgerei auch eins, das du trägst, mit einem Schlachtmesser oder Muschelmesser; das letzte Paar bleibt ([Schlachten](help.game.animals#slaughter)) |

## Wild und Wache {#wildcmds}

Wo kein Feuer brennt, kommen Tiere aus dem Nebel. Ausführlich unter [Wild](help.game.wild).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`scheuche hase\` | \`scare\` | Einen Hasen (auch \`reh\`, \`fuchs\`, \`maus\`, \`möwe\`) bis drei Schritte von dir in den Nebel zurückjagen |
| \`zäune\` | \`fence\` | Einen Zaun um ein Beet (2 Treibholz, 1 Tangseil), deinen Acker (6 Treibholz, 2 Tangseil) oder deinen Hühnerstall (3 Treibholz, 1 Tangseil) neben dir setzen |
| \`wache\` | \`guards\` | Wer im Raum vor dem Wild wacht (Hund, Katze, Gänse) und ob sie satt sind |

## Dorf und Siedlung {#villagecmds}

Eine Insel wächst durch das, was auf ihr steht. Ausführlich unter [Dorf und Siedlung](help.game.village).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`siedlung rang\` | | Die Siedlungen der Gegend nach ihrem Bestand; ein Park wiegt am meisten, wer ihn zuletzt pflegte, zählt dazu |
| \`laden\` | \`shop\` | Regal und Preise des Kaufhauses; \`laden kaufe\`, \`laden verkaufe\`, \`laden einlegen\`, \`laden entnehme\`; Lieferaufträge mit \`laden bestelle\`, \`laden liefere\`, \`laden storniere\` |
| \`kredit <n> gegen <ding>\`, \`tilge\` | \`credit\`, \`repay\` | Am Kontor gegen ein Pfand leihen und zurückzahlen |
| \`wechsel <n>\`, \`wechsel einlösen\` | \`bill\` | Am Kontor Münzen in einen Wechsel legen, den man weitergeben kann; jedes Kontor zahlt ihn aus |
| \`zug <ort>\` | \`train\` | Mit der Inselbahn von Bahnhof zu Bahnhof derselben Insel, wenn der Zug laut Fahrplan steht; \`zug sende [n\|alle] <ding> nach <ort>\` gibt Fracht auf, \`zug abholen\` holt sie am Ziel |
| \`signalfeuer\` | \`signal fires\` | Die Ketten der Signalfeuer deiner Insel: welche Feuer sie verbinden, ob sie brennen, und welche Insel dieser Gegend ihre Kette am längsten brennen ließ |
| \`beam [ort]\` | \`beame\`, \`beamen\` | Ab Netz zu einem brennenden Feuer springen (kostet Münzen, danach Pause); allein: die Ziele zeigen |
| \`karren\` | \`cart\` | Deine Karren; \`karren stelle\`, \`karren lade\`, \`karren entlade\`, \`karren fahre <ort>\`, \`karren pendel <ort> [mit <ding>]\`, \`karren halt\`, \`karren nimm\` |
| \`rudere <ort>\` | \`row\` | Mit dem Ruderboot von Steg zu Steg einer Insel |
| \`fahrplan\`, \`einschiffen <insel>\`, \`ausschiffen nächster\` | \`timetable\`, \`board\`, \`disembark next\` | Das große Schiff nach Fahrplan, ab den Buchten; beim nächsten Halt aussteigen |
| \`segle <insel>\` | \`sail\` | Mit dem Segelboot vom Steg zu einer anderen Insel |
| \`luke\` | \`hatch\` | Was in der Luke deines Boots liegt; am Steg \`luke lade [n\|alle] <ding>\`, \`luke entlade alle\` |
| \`schaufle\` | | Am Strand Sand graben |
| \`iss <ding>\` | \`eat\` | Etwas essen: Satt ruhst du nach der Arbeit kürzer (ein Drittel), Brot 12 Stunden, ein Festessen 24; Hunger gibt es nicht. Ein Klick auf Essbares unter „Bei dir“ bietet „Essen“ an |
| \`wirf netz\` | \`fish\` | An einem Steg das Netz auswerfen |
| \`wetter\` | \`weather\`, \`wind\` | Wie der Wind steht und wie dicht der Nebel ist; der Wind treibt die Mühlen |
| \`pflege\` | \`tend\` | Einmal am Tag eine Blume in den Park neben dir setzen: Ruf für dich, Rang für die Siedlung |
| \`fest blumen\`, \`fest ernte\`, \`fest regatta\` | \`festival\` | Als Siedler am Park eine Blumenschau oder ein Erntefest, am Steg eine Regatta eröffnen; allein: das laufende zeigen |
| \`zeige <ding>\` | \`exhibit\` | Am Park eine Blume zur Schau oder Ernte zum Fest geben; der Preis wartet im \`nachlass\` |
| \`siedlung\` | \`settlement\` | Die Siedlung hier; \`siedlung gründen <name>\`, \`aufnehmen <name> [helfer]\`, \`entlassen <name>\`, \`zu\`, \`offen\` |
| \`epoche\` | \`stufe\` | Auf welcher Stufe die Insel steht (Fischerdorf, Dorf, Stadt, Netz), ihre Punkte und was die nächste freischaltet |

## Handel und Ruf {#tradecmds}

Handel braucht ein Konto. Ausführlich unter [Handel und Handwerk](help.game.trade).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`offer <dinge> an <person> [für <dinge>]\` | \`biete\`, \`tausche\` | Tausch anbieten |
| \`accept [person]\` / \`decline [person]\` | \`annehmen\` / \`ablehnen\` | Tausch annehmen oder ablehnen |
| \`market\` | \`markt\` | Marktbrett: Angebote ansehen, einstellen, kaufen |
| \`craft [rezept]\` | \`baue\`, \`herstellen\` | Etwas herstellen; ohne Rezept die Liste; \`craft hier\`: was der Bau neben dir herstellt ([Alle Gebäude](help.game.buildings)) |
| \`order\` | \`auftrag\`, \`aufträge\` | Auftragstafel: ansehen, nehmen, liefern, zurückgeben |
| \`reputation\` | \`ruf\` | Was du in die Leuchtfeuer gelegt, an Parks gepflegt und für die Gemeinschaft getan hast |
| \`avatar\` | \`aussehen\` | Wie deine Figur in 3D aussieht (siehe Figur) |

## Hilfe {#helpcmds}

Die Hilfe gibt es auch im Spiel als Text. \`help\` zeigt alle Befehle und Themen.

| Befehl | Wirkung |
| --- | --- |
| \`help [befehl oder thema]\` (auch \`hilfe\`, \`?\`) | Hilfe im Spiel; Themen wie \`help leuchtfeuer\`, \`help handel\`, \`help siedeln\`, \`help garten\`, \`help ackerbau\`, \`help brot\`, \`help tiere\`, \`help wild\`, \`help epochen\`, \`help siedlungen\`, \`help chat\`, \`help inseln\`, \`help sturmflut\` |

## Für Builder und Admins {#builder}

Diese Befehle sind nicht für das normale Spiel. Sie stehen nur Figuren mit besonderen Rechten offen.

Wer die Stufe *Builder* hat, formt die Welt: \`dig\`/\`grabe\`, \`open\`/\`öffne\`, \`create\`/\`erschaffe\`, \`spawn\`/\`erzeuge\`, \`set\`/\`setze\`, \`tag\`/\`markiere\`, \`lock\`/\`sperre\`, \`examine\`/\`untersuche\`, \`destroy\`/\`vernichte\`. Die Befehle erscheinen nur in der \`help\` dieser Figuren; \`help bauen\` erklärt sie.

Admins stellen außerdem die Weltuhr: \`clock\` (\`uhr\`) zeigt sie, \`clock pause\`, \`clock weiter\` und \`clock rate <n>\` halten sie an, lassen sie weiterlaufen oder ändern ihr Tempo.`,
			en: `## How commands work {#how}

A command is a short word that makes your figure do something. Just start typing, the letters go to the command line. Every command works **in English and in German**, with no switch: \`get driftwood\` and \`nimm holz\` are the same.

Things are found by name or short name (\`wood\`, \`holz\`). You can type an exit's name alone (\`east\`). \`help <command>\` explains one command, \`help\` lists all. The game also understands short German sentences like \`lege 3 hölzer ins feuer\`.

## Moving and looking {#move}

These take you through the world and let you look around. On the map clicks and arrow keys do the same.

| Command | Also | Effect |
| --- | --- | --- |
| \`look [thing]\` | \`schau\`, \`l\` | Look around, or at a thing, an exit, a person |
| \`move <x> <y>\` | \`laufe\` | Walk to a spot, all the way |
| \`step <dx> <dy>\` | \`schritt\` | Take one step |
| \`go <direction>\` | \`geh\`, \`gehe\` | Take an exit |
| \`who\` | \`wer\` | Who is playing right now |
| \`time\` | \`zeit\` | Day and time of day in the world (also shown in the header bar) |

## Things {#things}

These pick things up, hand them on and feed the fire. The space bar does the most common of them.

| Command | Also | Effect |
| --- | --- | --- |
| \`get <thing>\` | \`nimm\`, \`heb\`, \`take\` | Pick up something next to you |
| \`drop <thing>\` | \`leg\`, \`lege\`, \`lass\` | Put something down |
| \`give [count] <thing> an <person>\` | \`gib\` | Give someone something, several too: give 6 münzen an Bert (not as a guest) |
| \`inventory\` | \`inventar\`, \`i\` | What you carry |
| \`put [count] <thing> in <fire>\` | \`nachlegen\`, \`wirf\`, \`feed\` | Put fuel into a beacon |

## Talking {#talk}

This is how you talk to others. The room hears \`say\`, everyone hears a channel, and the chat reaches only whom you address.

| Command | Also | Effect |
| --- | --- | --- |
| \`say <text>\` | \`sag\`, \`'text\` | Say something; everyone in the room hears it |
| \`emote <does something>\` | \`geste\`, \`:waves\` | Show an action |
| \`channel <name> <text>\` | \`kanal\` | Speak on a channel everyone hears (e.g. \`channel hafen Hello\`); without text it lists the channels |
| \`chat <name> <text>\` | \`tell\`, \`whisper\` | Encrypted talk between two, also across islands ([Chat](help.game.chat)) |
| \`group …\` | \`group\` | Groups: found, invite, write, leave ([Chat](help.game.chat#groups)) |
| \`ignoriere <name>\` / \`erlaube <name>\` | \`ignore\` / \`unignore\` | Block a player in the chat or allow them again |

## Building {#buildcmds}

Building works only in a fire's light. In detail under [Building](help.game.build).

| Command | Also | Effect |
| --- | --- | --- |
| \`bau <plan> [x y]\` | \`build\`, \`errichte\` | Stake out a site in a fire's light; without a plan the list of plans |
| \`liefere [n] <thing>\` | \`deliver\` | Deliver to the site (up to two cells away) |
| \`arbeite\` | \`work\` | Help build (up to two cells away) |
| \`baustelle [x y]\` | \`site\` | What is being built here and what is missing (with x y: on that cell only) |
| \`truhe\`, \`verstaue\`, \`entnimm\` | \`chest\`, \`store\`, \`retrieve\` | Your hut's chest |
| \`lager\`, \`lager log\` | \`warehouse\` | The warehouse beside you and who last moved something |
| \`breche\` | \`quarry\` | Break stone at a quarry with a pickaxe |
| \`steche\` | \`clay\` | Cut clay at a clay pit with a spade |
| \`harke\` | \`salz\`, \`salt\` | Rake salt at a salt garden, without a tool ([salt](help.game.animals#salt)) |
| \`opfere <ding>\` | \`sacrifice\` | Make an offering at a chapel: shorter rest for a day |
| \`antrag <zu\|offen\|text>\` | \`motion\` | Put a motion at a town hall; alone: show the open one |
| \`antrag grünzone\`, \`antrag wegerecht\`, \`antrag zone frei\` | | Put the ground around you to a vote |
| \`antrag steuer <n>\` | | Coins per thing taken from the warehouse or bought at the department store |
| \`antrag abriss\` | | Put the building beside you to a vote; what is left is the owner's estate |
| \`stimme ja\|nein\` | \`vote\` | Vote on the motion as a settler |
| \`repariere\` | \`repair\` | Repair a building |
| \`abriss\` | \`demolish\`, \`reiße … ab\` | Tear down your building or site |
| \`nachlass\` | \`estate\` | Collect the estate at your building's ruin |

## Gardens {#gardencmds}

Gardens need a spade, water and light. In detail under [Gardens](help.game.garden).

| Command | Also | Effect |
| --- | --- | --- |
| \`umgraben [zier/gemeinschaft] [x y]\` | \`beet anlegen\` | Dig a bed in the light with a spade, a flower bed or a community bed |
| \`beet\` | \`bed\`, \`beete\` | The beds here; \`beet aufgeben\` turns yours back into grass |
| \`sammle samen\` | \`samen\` | Look for seeds in the wild flora |
| \`pflanze [count] <seed> [x y]\` | \`säe\`, \`plant\` | Put seeds into your bed, e.g. \`pflanze 3 strandnelken\` |
| \`schöpfe\` | \`fill\` | Fill a can of water at the rain barrel |
| \`gieße\` | \`water\` | Water a bed (yours or as a sponsor) |
| \`jäte\` | \`weed\` | Pull weeds and what has wilted |
| \`ernte\` | \`harvest\`, \`pflücke\` | Harvest what is ripe, with seeds; at a ripe field a work point and your share |
| \`pate <name>\` | \`sponsor\` | Let someone tend your bed; \`pate weg <name>\` ends it |
| \`benenne <name>\` | \`taufe\` | Give your crossing a name (\`benenne 2 <name>\` when you carry several) |

## Fields {#fieldcmds}

A field is a large plot for many hands. In detail under [Fields](help.game.fields).

| Command | Also | Effect |
| --- | --- | --- |
| \`flur anlegen [x y]\` | \`acker anlegen\`, \`field\` | Break a field (4×4) with a spade in the light; \`flur\` shows the fields here, \`flur offen\`/\`flur zu\`, \`flur aufgeben\` |
| \`bestelle [crop]\` | \`pflüge\`, \`plough\` | Sow the field: choose the crop, bring seed and a work point |
| \`dünge\` | \`duenge\`, \`fertilise\` | Fertilise the growing field beside you with 2 bone meal: once a crop, half again as much harvest ([bone meal](help.game.animals#bonemeal)) |

## Mill and bakery {#millcmds}

Grain becomes flour, flour becomes bread. In detail under [Mill and bakery](help.game.fields#mill).

| Command | Also | Effect |
| --- | --- | --- |
| \`mahle [n or alle] <grain>\` | \`mühle\`, \`grind\` | Have grain ground to flour at a windmill beside you; \`mahle\` alone: how long it still grinds |
| \`abholen\` | \`pickup\` | Fetch your flour at the mill |
| \`backe [brot]\` | \`bake\` | Bake bread at a bakery beside you (2 flour, 1 can of water, 1 driftwood) |

## Animals {#animalcmds}

Animals want feeding and give eggs, milk, wool, down or honey for it. In detail under [Animals](help.game.animals).

| Command | Also | Effect |
| --- | --- | --- |
| \`stall\` | \`coop\`, \`pen\` | How the animals in the coop or pen beside you are |
| \`einstallen <animal>\` | \`stalle\` | Put a hen, sheep or goat into your coop or pen, leave a dog or cat on guard at a building of yours |
| \`ausstallen [animal]\` | \`ausstellen\` | Take an animal out of your coop or pen, also \`ausstallen hund\` |
| \`füttere [feed]\` | \`futter\` | Feed the animals beside you (anyone may; one feed keeps one animal fed a day) |
| \`einsammeln\` | \`sammle eier\`, \`melke\`, \`schere\` | Collect your animals' eggs, milk or wool |
| \`schlachte [animal]\` | \`slaughter\` | Slaughter an animal of your coop or pen, at the butcher's shop also one you carry, with a butcher's knife or a shell knife; the last pair stays ([slaughtering](help.game.animals#slaughter)) |

## Wild animals and guards {#wildcmds}

Where no fire burns, animals come out of the fog. In detail under [Wild animals](help.game.wild).

| Command | Also | Effect |
| --- | --- | --- |
| \`scheuche hase\` | \`scare\` | Chase a hare (also \`reh\`, \`fuchs\`, \`maus\`, \`möwe\`) up to three cells from you back into the fog |
| \`zäune\` | \`fence\` | Put a fence round a bed (2 driftwood, 1 kelp rope), your field (6 driftwood, 2 kelp rope) or your coop (3 driftwood, 1 kelp rope) beside you |
| \`wache\` | \`guards\` | Who keeps watch against the wild in this room (dog, cat, geese) and whether they are fed |

## Village and settlement {#villagecmds}

An island grows by what stands on it. In detail under [Village and settlement](help.game.village).

| Command | Also | Effect |
| --- | --- | --- |
| \`siedlung rang\` | | The settlements of the region by what they hold; a park weighs most, and whoever tended it lately counts too |
| \`laden\` | \`shop\` | Shelf and prices of the department store; \`laden kaufe\`, \`laden verkaufe\`, \`laden einlegen\`, \`laden entnehme\`; delivery orders with \`laden bestelle\`, \`laden liefere\`, \`laden storniere\` |
| \`kredit <n> gegen <ding>\`, \`tilge\` | \`credit\`, \`repay\` | Borrow against a pledge at a counting house and pay it back |
| \`wechsel <n>\`, \`wechsel einlösen\` | \`bill\` | Put coins into a bill of exchange at a counting house, to pass on; any counting house pays it out |
| \`zug <ort>\` | \`train\` | By island railway from station to station of the same island, while the timetable has the train there; \`zug sende [n\|alle] <ding> nach <ort>\` sends freight, \`zug abholen\` fetches it at the other end |
| \`signalfeuer\` | \`signal fires\` | The chains of signal fires on your island: which fires they link, whether they burn, and which island of this region kept its chain burning longest |
| \`beam [place]\` | \`beame\`, \`beamen\` | From the network on, jump to a burning fire (costs coins, then a rest); alone: list the destinations |
| \`karren\` | \`cart\` | Your carts; \`karren stelle\`, \`karren lade\`, \`karren entlade\`, \`karren fahre <ort>\`, \`karren pendel <ort> [mit <ding>]\`, \`karren halt\`, \`karren nimm\` |
| \`rudere <ort>\` | \`row\` | By rowing boat from jetty to jetty of an island |
| \`fahrplan\`, \`einschiffen <insel>\`, \`ausschiffen nächster\` | \`timetable\`, \`board\`, \`disembark next\` | The large ship on its timetable, from the bays; leave at the next stop |
| \`segle <insel>\` | \`sail\` | By sailing boat from a jetty to another island |
| \`luke\` | \`hatch\` | What lies in your boat's hatch; at a jetty \`luke lade [n\|alle] <ding>\`, \`luke entlade alle\` |
| \`schaufle\` | | Dig sand on the beach |
| \`iss <ding>\` | \`eat\` | Eat something: sated, you rest less after work (a third), bread 12 hours, a feast 24; there is no hunger. A click on something edible under „Bei dir“ offers „Essen“ |
| \`wirf netz\` | \`fish\` | Cast the net at a jetty |
| \`wetter\` | \`weather\`, \`wind\` | How the wind stands and how thick the fog is; the wind drives the mills |
| \`pflege\` | \`tend\` | Once a day set a flower in the park beside you: reputation for you, rank for the settlement |
| \`fest blumen\`, \`fest ernte\`, \`fest regatta\` | \`festival\` | As a settler at a park, open a flower show or a harvest festival, at a jetty a regatta; alone: show the running one |
| \`zeige <ding>\` | \`exhibit\` | Give a flower to the show or crops to the festival at the park; the prize waits in \`nachlass\` |
| \`siedlung\` | \`settlement\` | The settlement here; \`siedlung gründen <name>\`, \`aufnehmen <name> [helfer]\`, \`entlassen <name>\`, \`zu\`, \`offen\` |
| \`epoche\` | \`stufe\` | The island's epoch (fishing village, village, town, net), its points and what the next unlocks |

## Trade and reputation {#tradecmds}

Trade needs an account. In detail under [Trade and crafting](help.game.trade).

| Command | Also | Effect |
| --- | --- | --- |
| \`offer <things> an <person> [für <things>]\` | \`biete\`, \`tausche\` | Offer a swap |
| \`accept [person]\` / \`decline [person]\` | \`annehmen\` / \`ablehnen\` | Accept or decline a swap |
| \`market\` | \`markt\` | Market board: see, post and buy offers |
| \`craft [recipe]\` | \`baue\`, \`herstellen\` | Make something; without a recipe the list; \`craft hier\`: what the building beside you makes ([all buildings](help.game.buildings)) |
| \`order\` | \`auftrag\`, \`aufträge\` | Job board: see, take, deliver, give back |
| \`reputation\` | \`ruf\` | What you put into the beacons, the parks you tended and what you did for the community |
| \`avatar\` | \`aussehen\` | How your figure looks in 3D (see Figure) |

## Help {#helpcmds}

The help also exists as text inside the game. \`help\` shows all commands and topics.

| Command | Effect |
| --- | --- |
| \`help [command or topic]\` (also \`hilfe\`, \`?\`) | In-game help; topics such as \`help leuchtfeuer\`, \`help handel\`, \`help siedeln\`, \`help garten\`, \`help ackerbau\`, \`help brot\`, \`help tiere\`, \`help wild\`, \`help epochen\`, \`help siedlungen\`, \`help chat\`, \`help inseln\`, \`help sturmflut\` |

## For builders and admins {#builder}

These commands are not part of normal play. Only figures with special rights have them.

Characters with the *Builder* level shape the world: \`dig\`, \`open\`, \`create\`, \`spawn\`, \`set\`, \`tag\`, \`lock\`, \`examine\`, \`destroy\` (German: \`grabe\`, \`öffne\`, \`erschaffe\`, \`erzeuge\`, \`setze\`, \`markiere\`, \`sperre\`, \`untersuche\`, \`vernichte\`). They show up only in the \`help\` of those characters; \`help bauen\` explains them.

Admins also set the world clock: \`clock\` (\`uhr\`) shows it, \`clock pause\`, \`clock weiter\` and \`clock rate <n>\` stop it, let it run on or change its speed.`,
		},
	},
	{
		id: "help.game.fire",
		section: "play",
		title: { de: "Feuer, Nebel und Flut", en: "Fire, fog and tide" },
		short: {
			de: "Wie lange ein Feuer brennt, was der Nebel tut und warum Strandgut verschwindet.",
			en: "How long a fire burns, what the fog does and why flotsam vanishes.",
		},
		body: {
			de: `Die Feuer halten die Welt zusammen. Solange eines brennt, bleibt der Nebel fern und die Wege sind offen. Geht es aus, wird es Stufe für Stufe dunkler. Die Flut bringt das Holz, das ihr dafür braucht.

Alle Zeiten sind Weltzeit. Sie läuft normalerweise so schnell wie die echte Uhr; der Betreiber kann sie anders einstellen.

## Das Leuchtfeuer {#beacon}

Ein Leuchtfeuer brennt, solange es **Brennstoff** hat. Jeder Brennstoff verlängert die Brenndauer:

| Brennstoff | Brenndauer |
| --- | --- |
| Treibholz | 10 Minuten |
| Holzbündel | 40 Minuten |
| Tran | 60 Minuten |

Ein Feuer brennt höchstens zwei Stunden im Voraus, mehr nimmt es nicht an. Tran verkauft Marta in Kupferhafen, und manchmal spült ihn eine Sturmflut an. Im Seitenfeld siehst du die Restzeit. Du legst nach mit der Leertaste, dem Knopf „Nachlegen“ oder \`put treibholz in feuer\`. Niemand läuft in ein brennendes Feuer: Auf Feuerfeldern kann man nicht stehen.

## Der Nebel {#fog}

Der Nebel kommt, wenn kein Feuer brennt. Er wird langsam dichter, bis man die Wege nicht mehr findet. Ein brennendes Feuer lässt ihn wieder weichen.

Er hat vier Stufen (0 bis 3). Brennt das Feuer eines Ortes nicht, steigt er alle zwei Minuten um eine Stufe; brennt es, sinkt er ebenso. Bei **Stufe 3 („undurchdringlich“) findest du die meisten Ausgänge nicht mehr**, und kein Kahn fährt. Nur der Weg zu dem Feuer, das diesen Ort erhellt, bleibt zu finden, damit niemand im Nebel gefangen ist. \`look\` beschreibt den Nebel in Worten, die Karte zeigt ihn mit.

## Die Flut {#tide}

Die Flut bringt das **Strandgut**, von dem alle leben. Sie kommt jede Minute und legt neue Stücke an die Strände aller Inseln. Wer zuerst da ist, bekommt sie.

Kommen zwei gleichzeitig, bekommt ein Stück genau einer, der andere sieht eine Meldung. An 22 Orten landet etwas, an jedem bis zu einer festen Zahl (eins bis vier, in der Grauen Bucht vier). Je drei Leute auf einer Insel lassen ein Stück mehr je Strand liegen. Meist ist es Treibholz, seltener Muscheln; manche Strände bringen vor allem Tang oder Muscheln, wenige auch Bernstein und Perlen. Ein Stück liegt fünf Minuten, dann ist es fort.

**Holz, Tang und Muscheln gehen nie aus:** Liegen auf den Stränden einer Insel weniger als 8 Treibholz, 6 Tang oder 3 Muscheln (mehr, wenn mehr Leute dort sind), bringt jede Flut bis zu zwei Stück davon nach. Sie bleiben 30 Minuten liegen.

## Sturmflut {#storm}

Ab und zu wirft ein Sturm viel Strandgut auf einen einzelnen Strand. Der Kanal \`hafen\` meldet, wo. Wer schnell ist, findet am meisten.

Alle 20 Minuten trifft es einen von zehn Stränden mit sechs Stücken, die zehn Minuten liegen. Dabei sind auch Bernstein, Perlen und Tran. Eine Sturmflut füllt außerdem die Regentonnen ihrer Insel und treibt ihre Windmühlen an ([Mühle und Backhaus](help.game.fields#mill)).

## Figuren der Welt {#people}

Auf den Inseln leben Figuren, die das Spiel selbst führt. Sie sammeln, handeln und hüten Feuer wie alle anderen. Am Namen auf der Karte erkennst du, wer kein Mensch ist.

- **Hüter:** Fast jedes Feuer hat jemanden, der nachlegt und für Holz zahlt: Hinnerk in der Grauen Bucht, Mats, Svea, Greta, Nele, Arne, Frida und Thies. Auf Nebelholm hütet niemand das Feuer.
- **Ines** ist tagsüber (6 bis 22 Uhr) in der Grauen Bucht. Sie sagt, wenn das Feuer schwach wird, ausgeht oder wieder brennt, und begrüßt, wer „Hallo“ sagt.
- **Bo** ist der Fährmann und läuft zwischen Grauer Bucht und Klippenpfad hin und her.
- **Händler, Sammler und Handwerker** wie Marta, Kalle oder Piet kaufen und verkaufen. Sprich sie an, sie nennen dir ihre Preise.
- **(KI)** hinter dem Namen heißt: Hier antwortet ein Sprachmodell, etwa bei Ines, Merle, Hark und dem Fremden, der bei dichtem Nebel auftaucht. Ohne Modell dösen sie und sprechen feste Sätze.
- **(Siedler)** hinter dem Namen heißt: Ein Skript spielt diese Figur, kein Mensch. Siedler sammeln, bauen, säen und handeln wie Spieler. Standardmäßig sind immer mindestens 30 Figuren unterwegs; für jeden Menschen in der Region geht ein Siedler.

Andere Spieler erkennst du an ihrem Namen; mit \`who\` siehst du alle.`,
			en: `The fires hold the world together. While one burns, the fog stays away and the paths stay open. If it goes out, it gets darker step by step. The tide brings the wood you need for it.

All times are world time. It normally runs as fast as the real clock; the operator can set it otherwise.

## The beacon {#beacon}

A beacon burns as long as it has **fuel**. Each kind of fuel extends the burn time:

| Fuel | Burn time |
| --- | --- |
| Driftwood | 10 minutes |
| Wood bundle | 40 minutes |
| Tran (fish oil) | 60 minutes |

A fire accepts at most two hours ahead; more is not taken. Marta in Kupferhafen sells tran, and a storm surge sometimes washes it ashore. The side panel shows the time left. Add fuel with the space bar, the “Add fuel” button or \`put driftwood in fire\`. Nobody walks into a burning fire: you cannot stand on fire cells.

## The fog {#fog}

The fog comes when no fire burns. It slowly thickens until you can no longer find the paths. A burning fire pushes it back.

It has four levels (0 to 3). If a place's fire does not burn, it rises one level every two minutes; if it burns, it sinks just as fast. At **level 3 (“impenetrable”) you no longer find most exits**, and no ferry runs. Only the way to the fire that lights this place can still be found, so nobody is trapped in the fog. \`look\` describes the fog in words, the map shows it too.

## The tide {#tide}

The tide brings the **flotsam** everyone lives on. It comes every minute and lays new pieces on the beaches of all islands. Whoever arrives first gets them.

If two reach for a piece together, exactly one gets it and the other sees a message. Things land in 22 places, each up to a fixed number (one to four, four in Graue Bucht). Every three people on an island let one more piece lie per beach. Mostly it is driftwood, less often shells; some beaches bring chiefly kelp or shells, a few also amber and pearls. A piece lies five minutes, then it is gone.

**Wood, kelp and shells never run out:** when fewer than 8 driftwood, 6 kelp or 3 shells lie on an island's beaches (more with more people there), each tide brings up to two more. They lie 30 minutes.

## Storm surge {#storm}

Now and then a storm throws a lot of flotsam onto a single beach. The channel \`hafen\` says where. Whoever is quick finds the most.

Every 20 minutes it hits one of ten beaches with six pieces that lie ten minutes. Amber, pearls and tran are among them. A storm surge also fills the rain barrels of its island and drives its windmills ([Mill and bakery](help.game.fields#mill)).

## Characters of the world {#people}

The islands are home to figures the game runs itself. They gather, trade and keep fires like everyone else. The name on the map tells you who is not a person.

- **Keepers:** nearly every fire has someone who feeds it and pays for wood: Hinnerk in Graue Bucht, Mats, Svea, Greta, Nele, Arne, Frida and Thies. On Nebelholm nobody keeps the fire.
- **Ines** is in Graue Bucht by day (6 to 22 o'clock). She says when the fire gets weak, goes out or burns again, and greets whoever says “hello”.
- **Bo** is the ferryman and walks back and forth between Graue Bucht and Klippenpfad.
- **Traders, gatherers and craftspeople** like Marta, Kalle or Piet buy and sell. Speak to them and they name their prices.
- **(KI)** after a name means a language model answers here, as with Ines, Merle, Hark and the stranger who turns up in dense fog. Without a model they doze and speak fixed lines.
- **(Siedler)** after a name means a script plays this figure, not a person. Settlers gather, build, sow and trade like players. By default at least 30 figures are always about; for every person in the region one settler leaves.

You recognise other players by name; \`who\` shows everyone.`,
		},
	},
	{
		id: "help.game.trade",
		section: "play",
		title: { de: "Handel und Handwerk", en: "Trade and crafting" },
		short: {
			de: "Tauschen, Marktbrett, Rezepte und Aufträge.",
			en: "Swapping, market board, recipes and jobs.",
		},
		body: {
			de: `Auf den Inseln tauscht man direkt oder kauft am Marktbrett. Bezahlt wird in Münzen. Aus Strandgut stellst du Werkzeug und Waren her, und an den Tafeln warten Aufträge. Zum Tauschen, Handeln und Weitergeben brauchst du ein Konto ([Gast und Konto](help.game.account)).

## Tauschen {#swap}

Ein Tausch geht zwischen zwei Leuten am selben Ort. Du nennst, was du gibst und was du dafür willst. Die andere Seite sagt ja oder nein.

\`offer 3 treibholz, muschel an Bert für 2 münzen\`: Du bietest Bert drei Treibholz und eine Muschel für zwei Münzen. Dinge nennst du nach Art und Anzahl; ohne \`für …\` ist es ein Geschenk. Bert nimmt mit \`accept\` an oder lehnt mit \`decline\` ab. **Alles wechselt auf einmal oder gar nicht**: Es gibt keinen halben Tausch und kein Verdoppeln.

Ein Angebot gilt zwei Minuten und endet, wenn einer den Ort verlässt. Mit \`offer zurück\` nimmst du es zurück. Bequemer geht es im Seitenfeld oder im Menü einer Figur: **Tausch anbieten** listet, was du trägst, je Art eine Zeile mit Anzahl; ein Klick legt eins zu „Du gibst“. Auch die Leute der Inseln tauschen: Sprich sie an, sie nennen dir ihre Preise.

## Marktbrett {#market}

Am Marktbrett kaufst und verkaufst du, auch wenn der andere gerade nicht da ist. Die Ware wartet am Brett, bis jemand sie kauft. Die Preise sind auf jeder Insel andere.

Marktbretter stehen an sechs Orten: Graue Bucht, Markt von Kupferhafen, Riffdorf, Schärenhafen, Rauchhafen und Krabbenbucht. Preise in **Münzen**:

- \`markt\`: Angebote ansehen
- \`markt biete <ding> für <n>\`: etwas für n Münzen einstellen; \`markt biete 10 muscheln für 15\` stellt zehn Muscheln zusammen für 15 Münzen ein (auch „verkaufe 10 muscheln um 15 münzen“), wer kauft, bekommt alle zehn
- \`markt biete <ding> aus truhe [nr] für <n>\`: dasselbe direkt aus einer deiner Truhen in dieser Gegend, egal wo sie steht (\`markt biete 10 muscheln aus truhe 2 für 15\`, auch „aus der hütte“); nimmst du es zurück oder läuft es ab, kommt es in deinen Rucksack
- \`markt kaufe <ding>\`: das billigste Angebot dieser Sache kaufen (\`markt kaufe gans\`); \`markt kaufe 10 muscheln für 15\` nimmt genau diese Menge zu diesem Preis, so schickt es auch der Knopf „Kaufen“; \`markt kaufe <nr>\` kauft Angebot Nummer nr
- \`markt zurück <nr>\`: eigenes Angebot zurücknehmen

Ein Angebot bleibt einen Tag stehen, dann kommt die Ware zurück.

Suchst du etwas, das gerade niemand anbietet, hängst du ein **Gesuch** aus. Deine Münzen liegen dann am Brett, und wer das Ding bringt, bekommt sie:

- \`markt suche <ding> für <n>\`: zum Beispiel \`markt suche ziege für 5\` (auch einfach „suche ziege für 5“); \`markt suche 3 ziegen für 12\` sucht drei zusammen
- \`markt liefere <nr>\`: ein Gesuch erfüllen; das Ding geht an den Suchenden, die Münzen an dich
- \`markt liefere <nr> für <n>\`: für weniger liefern, als geboten ist; den Rest bekommt der Suchende zurück
- \`markt antworte <nr> ab <n>\`: einem Gesuch, das zu wenig bietet, sagen, ab wie viel du lieferst
- \`markt antworte <nr> keins\`: sagen, dass du das Ding gerade nicht hast
- \`markt suche zurück <nr>\`: dein Gesuch zurücknehmen, die Münzen kommen zurück

Auch die **Händler** lesen die Gesuche, wenn sie am Brett stehen (Gesa in Kupferhafen, die Händler auf ihren Wegen). Bietet ein Gesuch mindestens ihren Preis und haben sie das Ding dabei, liefern sie und nehmen nur ihren Preis; den Rest bekommst du zurück. Bietet es zu wenig, antworten sie einmal mit ihrem Preis, etwa „Gesa: ab 8“. Das steht dann unter dem Gesuch, und du bekommst es als Nachricht. Bietet es genug, haben sie das Ding aber gerade nicht, sagen sie das einmal („Gesa: gerade keins“) und liefern, sobald wieder eins da ist: Händler bekommen jeden Welttag (eine Stunde) ein Stück von dem zurück, womit sie angefangen haben. Führt an diesem Brett kein Händler das Ding, hörst du gleich beim Aushängen, wer es wo verkauft, und am Gesuch steht „kein Händler führt es“: dann kann hier nur ein Spieler liefern. Läuft ein Gesuch ab, ohne dass jemand liefert, bekommst du eine Nachricht und deine Münzen zurück.

Unter **Aktionen → Markt** stehen die Gesuche mit „Liefern“, den Antworten und der Zeit, die sie noch hängen, und ein Feld zum Suchen. Ein Gesuch bleibt wie ein Angebot einen Tag stehen; danach bekommst du deine Münzen zurück. Du kannst an jedem Brett bis zu fünf Gesuche aushängen.

## Handwerk {#craft}

Aus wenigen Dingen machst du Nützliches. Manches braucht ein Werkzeug, manches eine Werkstatt. Werkzeug nutzt sich ab und zerbricht irgendwann.

\`craft\` ohne Rezept zeigt die Liste, \`craft <rezept>\` stellt etwas her:

| Rezept | Man braucht | Ergebnis |
| --- | --- | --- |
| Tangseil | 3 Tang | Ein Seil, das fast jeder Bau braucht |
| Muschelmesser | 2 Muscheln, 1 Treibholz | Werkzeug, stumpft nach einigen Einsätzen ab |
| Holzbündel | 3 Treibholz und ein Muschelmesser | Brennt vier Mal so lange wie ein Scheit |
| Spaten | 2 Treibholz, 1 Tangseil | Gräbt Beete und Äcker um |
| Netz | 2 Tangseil und ein Muschelmesser | Handelsware |
| Bernsteinkette | 1 Bernstein, 2 Muscheln, 1 Tangseil und ein Muschelmesser | Handelsware |
| Spindel | 1 Treibholz, 1 Muschel | Werkzeug zum Spinnen, nutzt sich ab |
| Leinen | 3 Flachs und eine Spindel | Ein Ballen Leinen ([Äcker](help.game.fields#mill)) |
| Brot | 2 Mehl, 1 Kanne Wasser, 1 Treibholz, nur am Backhaus | 3 Brote |
| Tuch | 3 Wolle und eine Spindel, nur am Webstuhl | Ein Stück Wolltuch ([Tiere](help.game.animals#products)) |
| Daunendecke | 2 Tuch, 3 Daunen, nur am Webstuhl | Eine Decke |
| Käse | 3 Milch, 1 Treibholz, nur an einer Hütte | Ein Käse |
| Mausefalle | 1 Treibholz, 2 Muscheln, 1 Tangseil | In der Truhe fängt sie die Mäuse ([Wild](help.game.wild#shelter)) |

## Auftragstafel {#orders}

An den Auftragstafeln suchen Leute Dinge gegen Lohn. Du nimmst einen Auftrag, besorgst, was fehlt, und lieferst ab. Der Lohn wird in Münzen gezahlt.

Tafeln hängen an denselben sechs Orten wie die Marktbretter. \`auftrag\` zeigt die Tafel, \`auftrag nimm <nr>\` übernimmt einen Auftrag, \`auftrag liefere\` gibt die geforderten Dinge ab, an jeder Tafel. \`auftrag aufgeben\` gibt deinen Auftrag an die Tafel zurück. Du hast immer nur einen, und er gilt 30 Minuten. Beispiele: Ines braucht 2 Treibholz für die Nacht, Bo sammelt 2 Muscheln für Netzgewichte; beides bringt eine Münze.`,
			en: `On the islands you swap directly or buy at the market board. You pay in coins. You make tools and goods from flotsam, and jobs wait on the boards. To swap, trade and hand things on you need an account ([Guest and account](help.game.account)).

## Swapping {#swap}

A swap happens between two people in the same place. You name what you give and what you want for it. The other side says yes or no.

\`offer 3 driftwood, shell to Bert for 2 coins\`: you offer Bert three driftwood and a shell for two coins. You name things by kind and count; without \`for …\` it is a gift. Bert accepts with \`accept\` or declines with \`decline\`. **Everything changes hands at once or not at all**: no half swaps and no duplicating.

An offer lasts two minutes and ends when one of you leaves the place. \`offer withdraw\` takes it back. It is easier in the side panel or a figure's menu: **Tausch anbieten** lists what you carry, one line per kind with its count; a click adds one to “Du gibst”. The people of the islands swap too: speak to them and they name their prices.

## Market board {#market}

At the market board you buy and sell even when the other person is away. The goods wait at the board until someone buys them. Prices differ from island to island.

Market boards stand in six places: Graue Bucht, the market of Kupferhafen, Riffdorf, Schärenhafen, Rauchhafen and Krabbenbucht. Prices in **coins**:

- \`market\`: see the offers
- \`market sell <thing> for <n>\`: post something for n coins; \`market sell 10 shells for 15\` posts ten shells together for 15 coins, and whoever buys gets all ten
- \`market sell <thing> from chest [nr] for <n>\`: the same straight from one of your chests in this region, wherever it stands (\`market sell 10 shells from chest 2 for 15\`); taken back or lapsed, it comes into your pack
- \`market buy <thing>\`: buy the cheapest offer of that thing (\`market buy gans\`); \`market buy 10 muscheln for 15\` takes exactly that count at that price, which is what the Buy button sends; \`market buy <nr>\` buys offer number nr
- \`market withdraw <nr>\`: take your own offer back

An offer stays up for a day, then the goods come back.

If you are looking for something nobody offers right now, post a **wanted notice**. Your coins then wait at the board, and whoever brings the thing gets them:

- \`market want <thing> for <n>\`: for example \`market want goat for 5\` (also just „want goat for 5“); \`market want 3 goats for 12\` seeks three together
- \`market deliver <nr>\`: fill a notice; the thing goes to the one who seeks it, the coins to you
- \`market deliver <nr> for <n>\`: deliver for less than offered; the one who seeks gets the rest back
- \`market answer <nr> from <n>\`: tell a notice that offers too little from how much you would deliver
- \`market answer <nr> none\`: say that you have none right now
- \`market want withdraw <nr>\`: take your notice back, the coins come back

The **traders** read the notices too when they stand at the board (Gesa in Kupferhafen, the traders on their routes). If a notice offers at least their price and they carry the thing, they deliver and take only their price; you get the rest back. If it offers too little, they answer once with their price, say „Gesa: ab 8“. That stands under the notice, and you get it as a message. If it offers enough but they have none right now, they say so once („Gesa: gerade keins“) and deliver as soon as one is back: a trader gets back one piece of what it started with every world day (one hour). If no trader at this board deals in the thing, you hear at once when you post who sells it where, and the notice says „kein Händler führt es“: then only a player can deliver here. If a notice lapses without a delivery, you get a message and your coins back.

Under **Actions → Market** the notices stand with „Deliver“, their answers and the time they still hang, and a field to seek something. A notice stays up for a day like an offer; then your coins come back. You can post up to five notices at each board.

## Crafting {#craft}

You turn a few things into useful ones. Some recipes need a tool, some a workshop. Tools wear and break in the end.

\`craft\` without a recipe shows the list, \`craft <recipe>\` makes something:

| Recipe | You need | Result |
| --- | --- | --- |
| Kelp rope | 3 kelp | A rope nearly every building needs |
| Shell knife | 2 shells, 1 driftwood | A tool; it blunts after a few uses |
| Wood bundle | 3 driftwood and a shell knife | Burns four times as long as one log |
| Spade | 2 driftwood, 1 kelp rope | Digs beds and fields |
| Net | 2 kelp rope and a shell knife | Trade goods |
| Amber necklace | 1 amber, 2 shells, 1 kelp rope and a shell knife | Trade goods |
| Spindle | 1 driftwood, 1 shell | A tool for spinning; it wears |
| Linen | 3 flax and a spindle | A bolt of linen ([fields](help.game.fields#mill)) |
| Bread | 2 flour, 1 can of water, 1 driftwood, only at a bakery | 3 loaves |
| Cloth | 3 wool and a spindle, only at a loom | A piece of woollen cloth ([animals](help.game.animals#products)) |
| Down blanket | 2 cloth, 3 down, only at a loom | A blanket |
| Cheese | 3 milk, 1 driftwood, only at a hut | A cheese |
| Mousetrap | 1 driftwood, 2 shells, 1 kelp rope | In a chest it catches the mice ([wild](help.game.wild#shelter)) |

## Job board {#orders}

On the job boards people look for things in return for pay. You take a job, get what is missing and deliver. The reward is paid in coins.

Boards hang in the same six places as the market boards. \`order\` shows the board, \`order take <nr>\` takes a job, \`order deliver\` hands in the demanded things, at any board. \`order abandon\` gives your job back to the board. You hold one at a time, and it lasts 30 minutes. Examples: Ines needs 2 driftwood for the night, Bo collects 2 shells for net weights; each pays one coin.`,
		},
	},
	{
		id: "help.game.build",
		section: "play",
		title: { de: "Bauen: Hütte und Baustelle", en: "Building: hut and site" },
		short: {
			de: "Im Licht eines Feuers gemeinsam eine Hütte bauen, mit Truhe, Ausbessern und Abriss.",
			en: "Build a hut together in a fire's light, with a chest, repairs and demolition.",
		},
		body: {
			de: `Im Licht eines Feuers könnt ihr gemeinsam bauen. Einer steckt eine Baustelle ab, alle bringen Material und packen mit an. Was fertig ist, steht auf der Karte und gehört dem, der es begonnen hat. Ein Bau will gepflegt werden, sonst verfällt er.

Wo kein Feuer brennt, steckt niemand eine Baustelle ab. Jedes Feuer hat **20 Lichtpunkte**, und jeder Bau nimmt ihm einen bis drei davon. Jeder, der dort in den letzten sieben Tagen gebaut hat, gibt 5 mehr (bis 40), und mit jeder **Epoche** der Insel trägt jedes Feuer 20 mehr: im Dorf 40, in der Stadt 60, im Netz 80, so reicht es auch mit wenigen Spielern für Werkstatt, Steinbruch und Lehmgrube. Der Betreiber kann beides höher stellen. Abstecken und besitzen braucht ein Konto; mitbauen dürfen auch Gäste ([Gast und Konto](help.game.account)). Wer hier wen bauen lässt, kann eine [Siedlung](help.game.village#settlement) regeln.

## Baustelle abstecken {#stake}

Du wählst einen Plan und einen freien Platz. Das geht mit einem Befehl oder mit der rechten Maustaste auf einem freien Feld. Danach wartet die Baustelle auf Material und Hände.

\`bau hütte\` steckt neben dir eine Baustelle ab, \`bau hütte <x> <y>\` an einer bestimmten Stelle. \`bau\` allein zeigt die Baupläne. Du hast höchstens eine offene Baustelle. Wie viele Bauten und Baustellen du zusammen haben darfst, wächst mit der Insel: 10 im Fischerdorf, 15 im Dorf, 18 in der Stadt, 20 im Netz (der Betreiber kann es ändern). Regentonne, Vogelscheuche, Hühnerstall, Gehege, Bienenstock, Straße und Signalfeuer zählen nicht mit; für Ställe, Gehege und Bienenstöcke gilt eine eigene Grenze von fünf.

| Plan | Felder | Material | Arbeit | Licht | ab Stufe |
| --- | --- | --- | --- | --- | --- |
| Bienenstock | 1×1 | 2 Treibholz, 2 Tangseil | 4 | 1 | Fischerdorf |
| Hühnerstall | 2×1 | 4 Treibholz, 1 Tangseil | 6 | 1 | Fischerdorf |
| Hütte | 2×2 | 6 Treibholz, 2 Tangseil | 20 | 1 | Fischerdorf |
| Räucherei | 2×2 | 10 Treibholz, 2 Tangseil | 12 | 2 | Fischerdorf |
| Regentonne | 1×1 | 3 Treibholz, 1 Tangseil | 4 | 1 | Fischerdorf |
| Steg | 2×1 | 6 Treibholz | 6 | 1 | Fischerdorf |
| Vogelscheuche | 1×1 | 2 Treibholz, 1 Tangseil | 3 | 1 | Fischerdorf |
| Backhaus | 2×2 | 6 Treibholz, 6 Muschel, 1 Tangseil | 12 | 2 | Dorf |
| Gehege | 3×3 | 8 Treibholz, 4 Tangseil | 8 | 2 | Dorf |
| Kapelle | 3×2 | 10 Stein, 12 Ziegel, 4 Bohle | 30 | 3 | Dorf |
| Lagerhaus | 3×2 | 12 Treibholz, 4 Tangseil, 6 Muschel | 20 | 3 | Dorf |
| Lehmgrube | 2×2 | 6 Treibholz, 2 Tangseil, 2 Stein | 12 | 2 | Dorf |
| Metzgerei | 2×2 | 6 Stein, 4 Bohle, 4 Treibholz | 20 | 2 | Dorf |
| Salzgarten | 2×2 | 4 Stein, 4 Lehm, 2 Treibholz | 12 | 2 | Dorf |
| Steinbruch | 2×2 | 8 Treibholz, 3 Tangseil, 4 Stein | 16 | 3 | Dorf |
| Straße | 1×1 | 4 Stein, 2 Treibholz | 6 | 1 | Dorf |
| Webstuhl | 2×1 | 6 Treibholz, 2 Tangseil | 8 | 1 | Dorf |
| Werkstatt | 3×2 | 10 Treibholz, 8 Stein, 4 Tangseil | 24 | 3 | Dorf |
| Windmühle | 2×2 | 8 Treibholz, 2 Tangseil, 2 Leinen | 16 | 2 | Dorf |
| Ziegelei | 2×2 | 8 Stein, 6 Treibholz, 6 Lehm | 20 | 3 | Dorf |
| Brauerei | 3×2 | 8 Ziegel, 6 Bohle | 24 | 3 | Stadt |
| Gerberei | 2×2 | 8 Stein, 6 Bohle, 4 Ziegel | 28 | 3 | Stadt |
| Gewächshaus | 3×2 | 8 Glas, 6 Bohle | 20 | 2 | Stadt |
| Glashütte | 3×2 | 12 Ziegel, 6 Stein | 28 | 3 | Stadt |
| Kaufhaus | 4×3 | 14 Ziegel, 8 Bohle, 6 Stein | 36 | 5 | Stadt |
| Kontor | 3×2 | 10 Ziegel, 6 Stein | 24 | 4 | Stadt |
| Leuchtturm | 2×2 | 16 Stein, 10 Ziegel, 2 Tran | 40 | 3 | Stadt |
| Park | 4×4 | 10 Ziegel, 6 Stein, 6 Strandnelke, 4 Dünenrose | 30 | 9 | Stadt |
| Rathaus | 4×3 | 16 Ziegel, 10 Stein, 6 Bohle | 40 | 6 | Stadt |
| Werft | 4×3 | 14 Bohle, 4 Tauwerk, 6 Stein | 36 | 4 | Stadt |
| Bahnhof | 3×2 | 12 Ziegel, 10 Bohle, 8 Stein, 2 Tauwerk | 32 | 4 | Netz |
| Signalfeuer | 1×1 | 6 Stein, 2 Ziegel, 1 Tran | 10 | 2 | Netz |

Die Regentonne gibt Wasser für die [Gärten](help.game.garden), die Vogelscheuche hält [Hasen und Rehe](help.game.wild#shelter) fern. Windmühle und Backhaus machen aus Korn Mehl und Brot ([Mühle und Backhaus](help.game.fields#mill)), Hühnerstall und Gehege halten [Tiere](help.game.animals), am Webstuhl wird aus Wolle [Tuch](help.game.animals#products). Was jeder andere Bau kann und wie lange er hält, steht unter [Alle Gebäude](help.game.buildings).

Nicht gebaut wird auf gepflasterten Wegen und Plätzen, auf Ausgängen und Türen, direkt am Feuer, auf Dingen oder Personen. Ausgänge, der Startplatz und eine Seite jedes Feuers bleiben immer erreichbar. In einen Bau läuft niemand hinein.

## Liefern und mitarbeiten {#help}

Jeder darf an einer Baustelle mithelfen, auch ohne Konto. Du bringst Material oder arbeitest ein Stück mit.

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`liefere [n] <ding>\` | \`deliver\` | Liefern, was die Baustelle braucht; zu viel bleibt bei dir |
| \`arbeite\` | \`work\` | Einen Arbeitspunkt beitragen; danach ruhst du eine Weile (standardmäßig 15 Weltminuten; Essen und Segen kürzen es, der Betreiber stellt es ein) |
| \`baustelle\` | \`site\` | Was hier gebaut wird und was noch fehlt |

Liefern und arbeiten geht **aus bis zu zwei Feldern Abstand**, so haben viele um eine Baustelle Platz. Das Menü der rechten Maustaste auf einer Baustelle bietet Liefern und Mitarbeiten an. Höchstens die Hälfte darf von NPCs oder Automaten kommen. Fehlt nichts mehr, steht der Bau; an ihm steht, wer mitgebaut hat. Eine Baustelle ohne Fortschritt verfällt nach einer Woche.

## Die Truhe {#chest}

Eine Hütte hat eine Truhe für deine Sachen. Was darin liegt, trägst du nicht mehr mit dir herum.

Die Hütte hat eine Truhe, die **nur dir** gehört: \`truhe\` zeigt sie, \`verstaue 3 muscheln\` (oder „leg die muscheln in die truhe“) legt etwas hinein, \`entnimm 2 muscheln\` (oder „nimm … aus der truhe“) holt es heraus. Herausnehmen kannst du nur direkt neben der Hütte, hineinlegen **von überall**: Neben einer deiner Hütten geht es in diese, sonst in deine einzige. Hast du mehrere, sagst du welche, mit ihrer Nummer oder ihrem Ort: \`verstaue 3 muscheln in 2\`, \`verstaue 3 muscheln in die hütte am anleger\` (oder „leg 3 muscheln in die truhe 2“). Ohne Angabe nennt \`verstaue\` die Nummern. Unter „Bei dir“ legst du ein gewähltes Ding in die gewählte Truhe: eine Zahl und „Stück verstauen“ (etwa 300), oder „Alle … verstauen“. Liegt die Hütte in einer anderen Gegend, bringt ein Bote die Sachen hin, das dauert einen Moment.

## Last {#load}

Eine Figur trägt höchstens **1000 Last** (der Betreiber stellt es ein). Jedes Ding wiegt nach seiner Art:

| Last | Dinge |
|---|---|
| 0 | Münzen |
| ½ | Muscheln, Samen, Perlen, Bernstein, Wachs, Kerzen, Daunen |
| 1 | Tang, Fisch, Eier, Honig, Milch, Werkzeug, Ernte, Brot und alles andere |
| 2 | Treibholz, Tangseil, Stein, Kohl, Ziegel, Bohlen, Lehm, Hund, Katze |
| 4 | Holzbündel, Huhn, Ente, Gans, Schaf, Ziege, Schwein, Bienenvolk, Ruderboot, Karren |
| 8 | Rind, Segelboot |

Unter „Bei dir“ steht, wie viel du trägst. Was dich über die Grenze brächte (aufheben, sammeln, ernten, kaufen, herstellen, aus der Truhe nehmen), geht nicht, bis du etwas in eine Truhe legst oder ablegst. Was dir andere bringen (eine Lieferung, ein Geschenk, Münzen für dein Angebot), kommt trotzdem an. Wer schon mehr trägt, verliert nichts, nimmt aber nichts mehr auf. Eine Truhe nimmt dagegen alles auf, ohne Grenze: verteile, was du nicht tragen kannst, auf deine Truhen.

## Verfall, Ruine und Nachlass {#decay}

Nichts hält ewig. Wer einen Bau nicht ausbessert, verliert ihn, aber nicht seine Sachen.

Ein Bau hält **40 bis 60 Tage**: Hütte, Ställe, Gehege, Bienenstock, Regentonne, Vogelscheuche, Steg, Räucherei und die ersten Bauten des Dorfs 40 Tage, Werkstatt, Lager und die Bauten der Stadt 45, Kapelle und Leuchtturm 60, ein Park sogar 120. Es sind Tage des Verfallstakts, standardmäßig echte Tage (der Betreiber kann ihn ändern). \`repariere\` kostet ein Stück Material (meist 1 Treibholz, beim Backhaus 1 Muschel, bei der Vogelscheuche 1 Tang), jeder darf helfen, und die Frist beginnt neu. Wer ihn verfallen lässt, hat eine **Ruine**: Sie steht noch zehn Tage und gibt das Licht des Feuers frei. Was in der Truhe lag, wartet einen Monat als **Nachlass**; \`nachlass\` an der Ruine holt es ab. Eine Ruine muss nicht stehen bleiben: Jeder registrierte Spieler räumt sie von nebenan ab (\`abriss ruine\` oder „Ruine abräumen“ auf der Karte), die Fläche ist dann frei; der Nachlass wartet trotzdem weiter auf seinen Besitzer.

## Abriss {#demolish}

Du kannst jederzeit abreißen, was dir gehört. Einen Teil des Materials bekommst du zurück.

\`abriss\` (oder „reiß die hütte ab“) an deinem Bau gibt die Fläche und das Licht frei, die Hälfte des Materials und den Inhalt der Truhe zurück. Eine aufgegebene Baustelle gibt alles Gelieferte zurück.`,
			en: `In a fire's light you can build together. One person stakes out a site, everyone brings material and lends a hand. What is finished stands on the map and belongs to whoever started it. A building wants looking after, or it decays.

Where no fire burns, nobody stakes out a site. Every fire has **20 light points**, and each building takes one to three of them. Everyone who built there in the last seven days adds 5 (up to 40), and with each **epoch** of the island every fire carries 20 more: 40 in the village, 60 in the town, 80 in the net, so even few players have light for a workshop, a quarry and a clay pit. The operator can set both higher. Staking out and owning need an account; guests may help build ([Guest and account](help.game.account)). A [settlement](help.game.village#settlement) can rule who builds where.

## Staking out a site {#stake}

You choose a plan and a free spot. You do it with a command or with the right mouse button on a free cell. Then the site waits for material and hands.

\`bau hütte\` (or \`build hut\`) stakes out a site next to you, \`bau hütte <x> <y>\` at a given spot. \`bau\` alone lists the plans. You hold at most one open site. How many buildings and sites you may have together grows with the island: 10 in the fishing village, 15 in the village, 18 in the town, 20 in the network (the operator can change it). Rain barrel, scarecrow, hen house, pen, hive, road and signal fire do not count; coops, pens and hives have their own limit of five.

| Plan | Cells | Material | Work | Light | from stage |
| --- | --- | --- | --- | --- | --- |
| Bienenstock (hive) | 1×1 | 2 driftwood, 2 kelp rope | 4 | 1 | fishing village |
| Hühnerstall (chicken coop) | 2×1 | 4 driftwood, 1 kelp rope | 6 | 1 | fishing village |
| Hütte (hut) | 2×2 | 6 driftwood, 2 kelp rope | 20 | 1 | fishing village |
| Räucherei (smokehouse) | 2×2 | 10 driftwood, 2 kelp rope | 12 | 2 | fishing village |
| Regentonne (rain barrel) | 1×1 | 3 driftwood, 1 kelp rope | 4 | 1 | fishing village |
| Steg (jetty) | 2×1 | 6 driftwood | 6 | 1 | fishing village |
| Vogelscheuche (scarecrow) | 1×1 | 2 driftwood, 1 kelp rope | 3 | 1 | fishing village |
| Backhaus (bakehouse) | 2×2 | 6 driftwood, 6 shell, 1 kelp rope | 12 | 2 | village |
| Gehege (pen) | 3×3 | 8 driftwood, 4 kelp rope | 8 | 2 | village |
| Kapelle (chapel) | 3×2 | 10 stone, 12 brick, 4 plank | 30 | 3 | village |
| Lagerhaus (warehouse) | 3×2 | 12 driftwood, 4 kelp rope, 6 shell | 20 | 3 | village |
| Lehmgrube (clay pit) | 2×2 | 6 driftwood, 2 kelp rope, 2 stone | 12 | 2 | village |
| Metzgerei (butcher's shop) | 2×2 | 6 stone, 4 plank, 4 driftwood | 20 | 2 | village |
| Salzgarten (salt garden) | 2×2 | 4 stone, 4 clay, 2 driftwood | 12 | 2 | village |
| Steinbruch (quarry) | 2×2 | 8 driftwood, 3 kelp rope, 4 stone | 16 | 3 | village |
| Straße (road) | 1×1 | 4 stone, 2 driftwood | 6 | 1 | village |
| Webstuhl (loom) | 2×1 | 6 driftwood, 2 kelp rope | 8 | 1 | village |
| Werkstatt (workshop) | 3×2 | 10 driftwood, 8 stone, 4 kelp rope | 24 | 3 | village |
| Windmühle (windmill) | 2×2 | 8 driftwood, 2 kelp rope, 2 linen | 16 | 2 | village |
| Ziegelei (brickworks) | 2×2 | 8 stone, 6 driftwood, 6 clay | 20 | 3 | village |
| Brauerei (brewery) | 3×2 | 8 brick, 6 plank | 24 | 3 | town |
| Gerberei (tannery) | 2×2 | 8 stone, 6 plank, 4 brick | 28 | 3 | town |
| Gewächshaus (greenhouse) | 3×2 | 8 glass, 6 plank | 20 | 2 | town |
| Glashütte (glassworks) | 3×2 | 12 brick, 6 stone | 28 | 3 | town |
| Kaufhaus (department store) | 4×3 | 14 brick, 8 plank, 6 stone | 36 | 5 | town |
| Kontor (counting house) | 3×2 | 10 brick, 6 stone | 24 | 4 | town |
| Leuchtturm (lighthouse) | 2×2 | 16 stone, 10 brick, 2 fish oil | 40 | 3 | town |
| Park (park) | 4×4 | 10 brick, 6 stone, 6 sea pink, 4 dune rose | 30 | 9 | town |
| Rathaus (town hall) | 4×3 | 16 brick, 10 stone, 6 plank | 40 | 6 | town |
| Werft (shipyard) | 4×3 | 14 plank, 4 cordage, 6 stone | 36 | 4 | town |
| Bahnhof (station) | 3×2 | 12 brick, 10 plank, 8 stone, 2 cordage | 32 | 4 | net |
| Signalfeuer (signal fire) | 1×1 | 6 stone, 2 brick, 1 fish oil | 10 | 2 | net |

The rain barrel gives water for the [gardens](help.game.garden), the scarecrow keeps [hares and deer](help.game.wild#shelter) away. The windmill and the bakery turn grain into flour and bread ([Mill and bakery](help.game.fields#mill)), the hen house and the pen keep [animals](help.game.animals), the loom turns wool into [cloth](help.game.animals#products). What every other building does and how long it lasts is under [All buildings](help.game.buildings).

Nothing is built on cobbled paths and squares, on exits and doors, right at a fire, on things or people. Exits, the starting place and one side of every fire always stay reachable. Nobody walks into a building.

## Delivering and helping {#help}

Anyone may help at a site, even without an account. You bring material or work on it for a while.

| Command | Also | Effect |
| --- | --- | --- |
| \`liefere [n] <thing>\` | \`deliver\` | Deliver what the site needs; anything extra stays with you |
| \`arbeite\` | \`work\` | Add one point of work; afterwards you rest a while (by default 15 world minutes; food and a blessing shorten it, the operator sets it) |
| \`baustelle\` | \`site\` | What is being built here and what is still missing |

Delivering and working work **from up to two cells away**, so many fit around a site. The right-click menu on a site offers delivering and helping. At most half may come from NPCs or automata. When nothing is missing, the building stands, naming who helped. A site without progress lapses after a week.

## The chest {#chest}

A hut has a chest for your things. What lies in it you no longer carry around.

The hut has a chest that is **yours alone**: \`truhe\` (\`chest\`) shows it, \`verstaue 3 muscheln\` (\`store\`, or “leg die muscheln in die truhe”) puts something in, \`entnimm 2 muscheln\` (\`retrieve\`) takes it out. You take things out only right next to the hut; you put them in **from anywhere**: beside one of your huts into that one, else into your only one. With several you say which, by its number or its place: \`verstaue 3 muscheln in 2\`, \`verstaue 3 muscheln in die hütte am anleger\` (or “leg 3 muscheln in die truhe 2”). Without it, \`verstaue\` names the numbers. Under “Bei dir” you put a chosen thing into the chosen chest: a number and “Stück verstauen” (say 300), or “Alle … verstauen”. If the hut lies in another region, a courier brings the things there; that takes a moment.

## Load {#load}

A figure carries at most **1000 load** (the operator sets it). Each thing weighs by its kind:

| Load | Things |
|---|---|
| 0 | coins |
| ½ | shells, seeds, pearls, amber, wax, candles, down |
| 1 | kelp, fish, eggs, honey, milk, tools, crops, bread and everything else |
| 2 | driftwood, kelp rope, stone, cabbage, bricks, planks, clay, dog, cat |
| 4 | bundle of wood, hen, duck, goose, sheep, goat, pig, bee colony, rowing boat, cart |
| 8 | cow, sailing boat |

“Bei dir” shows how much you carry. Whatever would take you over the limit (picking up, gathering, harvesting, buying, crafting, taking from a chest) does not work until you put something in a chest or drop it. What others bring you (a delivery, a gift, coins for your listing) arrives anyway. Whoever already carries more loses nothing but takes nothing more. A chest, on the other hand, takes everything, without a limit: spread what you cannot carry over your chests.

## Decay, ruin and estate {#decay}

Nothing lasts for ever. If you do not repair a building you lose it, but not your things.

A building lasts **40 to 60 days**: hut, coops, pen, hive, rain barrel, scarecrow, jetty, smokehouse and the village's first buildings 40 days, workshop, warehouse and the town's buildings 45, chapel and lighthouse 60, a park even 120. They are days of the decay rate, real days by default (the operator can change it). \`repariere\` (\`repair\`) costs one piece of material (mostly 1 driftwood, 1 shell for a bakery, 1 kelp for a scarecrow), anyone may help, and the time starts anew. Let it decay and it becomes a **ruin**: it stands ten more days and frees the fire's light. What lay in the chest waits a month as an **estate**; \`estate\` (\`estate\`) at the ruin collects it. A ruin need not stay: any registered player clears it from beside it (\`demolish ruin\` or „Clear the ruin“ on the map), and the ground is free; the estate still waits for its owner.

## Demolition {#demolish}

You can tear down what is yours at any time. You get part of the material back.

\`abriss\` (\`demolish\`, or “reiß die hütte ab”) at your building frees the land and the light and gives back half the material and the chest's contents. A site given up gives back everything delivered.`,
		},
	},
	{
		id: "help.game.buildings",
		section: "play",
		title: { de: "Alle Gebäude", en: "All buildings" },
		short: {
			de: "Jeder Bau auf einen Blick: ab welcher Epoche, was er kostet, wie viel Licht er nimmt, wie lange er hält und was man dort macht.",
			en: "Every building at a glance: from which epoch, what it costs, how much light it takes, how long it lasts and what one does there.",
		},
		body: {
			de: `Jeder Bau entsteht mit \`bau <name>\` im Licht eines Feuers ([Bauen](help.game.build)). Die rechte Maustaste (am Handy langes Tippen) auf einen Bau zeigt, was du dort tun kannst; neben einem Bau mit Rezepten zeigt **„Was man hier herstellen kann“** (\`craft hier\`) alle seine Rezepte mit dem, was sie brauchen, und bietet an, was du schon dabeihast. Hergestellt wird an jedem Bau dieser Art, auch an dem eines anderen; die Zutaten kommen aus deiner Tasche.

| Bau | ab | Größe und Material | Licht | hält Tage | wozu |
| --- | --- | --- | --- | --- | --- |
| Bienenstock (\`bau bienenstock\`) | Fischerdorf | 1×1, 2 Treibholz, 2 Tangseil, 4 Arbeit | 1 | 40 | bis 3 Bienenvölker: Honig und Wachs |
| Hühnerstall (\`bau hühnerstall\`) | Fischerdorf | 2×1, 4 Treibholz, 1 Tangseil, 6 Arbeit | 1 | 40 | bis 6 Hühner oder Küken |
| Hütte (\`bau hütte\`) | Fischerdorf | 2×2, 6 Treibholz, 2 Tangseil, 20 Arbeit | 1 | 40 | Truhe für dich; am Herd kochen (Käse, Kerzen, alle Braten und Suppen, Festessen) |
| Räucherei (\`bau räucherei\`) | Fischerdorf | 2×2, 10 Treibholz, 2 Tangseil, 12 Arbeit | 2 | 40 | räuchert Fisch und Fleisch; Truhe als Räuchergestell |
| Regentonne (\`bau regentonne\`) | Fischerdorf | 1×1, 3 Treibholz, 1 Tangseil, 4 Arbeit | 1 | 40 | Wasser für die Beete (\`schöpfe\`) |
| Steg (\`bau steg\`) | Fischerdorf | 2×1, 6 Treibholz, 6 Arbeit | 1 | 40 | Boote legen an, Regatta (\`rudere\`, \`segle\`, \`luke\`) |
| Vogelscheuche (\`bau vogelscheuche\`) | Fischerdorf | 1×1, 2 Treibholz, 1 Tangseil, 3 Arbeit | 1 | 40 | hält Hasen drei Felder weit von den Beeten |
| Backhaus (\`bau backhaus\`) | Dorf | 2×2, 6 Treibholz, 6 Muschel, 1 Tangseil, 12 Arbeit | 2 | 40 | backt Brot (\`backe brot\`) |
| Gehege (\`bau gehege\`) | Dorf | 3×3, 8 Treibholz, 4 Tangseil, 8 Arbeit | 2 | 40 | bis 4 Tiere einer Art (Schafe, Ziegen, Enten, Gänse, Schweine, Ferkel, ab der Stadt Rinder) |
| Kapelle (\`bau kapelle\`) | Dorf | 3×2, 10 Stein, 12 Ziegel, 4 Bohle, 30 Arbeit | 3 | 60 | opfern für kürzere Ruhe (\`opfere\`) |
| Lagerhaus (\`bau lagerhaus\`) | Dorf | 3×2, 12 Treibholz, 4 Tangseil, 6 Muschel, 20 Arbeit | 3 | 45 | Lager der Siedlung für alle (\`lager\`) |
| Lehmgrube (\`bau lehmgrube\`) | Dorf | 2×2, 6 Treibholz, 2 Tangseil, 2 Stein, 12 Arbeit | 2 | 45 | Lehm stechen mit Spaten (\`steche\`) |
| Metzgerei (\`bau metzgerei\`) | Dorf | 2×2, 6 Stein, 4 Bohle, 4 Treibholz, 20 Arbeit | 2 | 40 | schlachtet ein Tier, das du trägst; ein Stück Fleisch mehr beim Schlachten im Ort; Bratwurst mit Salz, Pökelfleisch |
| Salzgarten (\`bau salzgarten\`) | Dorf | 2×2, 4 Stein, 4 Lehm, 2 Treibholz, 12 Arbeit | 2 | 40 | Salz harken (\`harke\`) |
| Steinbruch (\`bau steinbruch\`) | Dorf | 2×2, 8 Treibholz, 3 Tangseil, 4 Stein, 16 Arbeit | 3 | 45 | Stein brechen mit Spitzhacke (\`breche\`) |
| Straße (\`bau straße\`) | Dorf | 1×1, 4 Stein, 2 Treibholz, 6 Arbeit | 1 | 45 | verbindet zwei Räume für den Karren |
| Webstuhl (\`bau webstuhl\`) | Dorf | 2×1, 6 Treibholz, 2 Tangseil, 8 Arbeit | 1 | 40 | webt Tuch, näht Daunendecken |
| Werkstatt (\`bau werkstatt\`) | Dorf | 3×2, 10 Treibholz, 8 Stein, 4 Tangseil, 24 Arbeit | 3 | 45 | Bohlen, Tauwerk, Gehäuse, Karren, Ruderboot, Schlachtmesser, Ledertasche, Lederstiefel; Werkzeug nutzt sich daneben nur halb so schnell ab |
| Windmühle (\`bau windmühle\`) | Dorf | 2×2, 8 Treibholz, 2 Tangseil, 2 Leinen, 16 Arbeit | 2 | 40 | mahlt Korn zu Mehl, Knochen zu Knochenmehl (\`mahle\`) |
| Ziegelei (\`bau ziegelei\`) | Dorf | 2×2, 8 Stein, 6 Treibholz, 6 Lehm, 20 Arbeit | 3 | 45 | brennt Ziegel aus Lehm |
| Brauerei (\`bau brauerei\`) | Stadt | 3×2, 8 Ziegel, 6 Bohle, 24 Arbeit | 3 | 45 | braut Bier |
| Gerberei (\`bau gerberei\`) | Stadt | 2×2, 8 Stein, 6 Bohle, 4 Ziegel, 28 Arbeit | 3 | 45 | gerbt Felle mit Salz zu Leder |
| Gewächshaus (\`bau gewächshaus\`) | Stadt | 3×2, 8 Glas, 6 Bohle, 20 Arbeit | 2 | 45 | Beete bis drei Felder daneben wachsen im Winter durch |
| Glashütte (\`bau glashütte\`) | Stadt | 3×2, 12 Ziegel, 6 Stein, 28 Arbeit | 3 | 45 | bläst Glas aus Sand |
| Kaufhaus (\`bau kaufhaus\`) | Stadt | 4×3, 14 Ziegel, 8 Bohle, 6 Stein, 36 Arbeit | 5 | 45 | Laden mit festen Preisen (\`laden\`) |
| Kontor (\`bau kontor\`) | Stadt | 3×2, 10 Ziegel, 6 Stein, 24 Arbeit | 4 | 45 | leiht gegen ein Pfand, stellt Wechsel aus (\`kredit\`, \`wechsel\`) |
| Leuchtturm (\`bau leuchtturm\`) | Stadt | 2×2, 16 Stein, 10 Ziegel, 2 Tran, 40 Arbeit | 3 | 60 | 20 Licht mehr für sein Feuer, Licht in die Nachbarräume |
| Park (\`bau park\`) | Stadt | 4×4, 10 Ziegel, 6 Stein, 6 Strandnelke, 4 Dünenrose, 30 Arbeit | 9 | 120 | pflegen, Feste feiern (\`pflege\`, \`fest\`) |
| Rathaus (\`bau rathaus\`) | Stadt | 4×3, 16 Ziegel, 10 Stein, 6 Bohle, 40 Arbeit | 6 | 45 | Anträge und Abstimmungen, Steuer (\`antrag\`, \`stimme\`) |
| Werft (\`bau werft\`) | Stadt | 4×3, 14 Bohle, 4 Tauwerk, 6 Stein, 36 Arbeit | 4 | 45 | baut Segelboote |
| Bahnhof (\`bau bahnhof\`) | Netz | 3×2, 12 Ziegel, 10 Bohle, 8 Stein, 2 Tauwerk, 32 Arbeit | 4 | 45 | Inselbahn (\`zug\`) |
| Signalfeuer (\`bau signalfeuer\`) | Netz | 1×1, 6 Stein, 2 Ziegel, 1 Tran, 10 Arbeit | 2 | 45 | ein Feuer der Signalkette |

**Licht** sind die Lichtpunkte, die der Bau seinem Feuer nimmt; **hält** ist die Zeit bis zum Verfall ohne Ausbessern (\`repariere\`). Die **Werkstatt** ist der Bau des Handwerks: Bohlen und Tauwerk für die größeren Bauten, Gehäuse, Karren und Ruderboot, das Schlachtmesser und die Lederwaren; neben ihr nutzt sich Werkzeug nur halb so schnell ab.`,
			en: `Every building rises with \`bau <name>\` in a fire's light ([building](help.game.build)). The right mouse button (a long tap on a phone) on a building shows what you can do there; beside a building with recipes **"What can be made here"** (\`craft hier\`) lists all its recipes with what they need and offers what you already carry. You make things at any building of that kind, someone else's too; the ingredients come from your pack.

| Building | from | size and material | light | lasts days | what for |
| --- | --- | --- | --- | --- | --- |
| Hive (\`bau bienenstock\`) | Fishing Village | 1×1, 2 driftwood, 2 kelp rope, 4 work | 1 | 40 | up to 3 bee colonies: honey and wax |
| Chicken Coop (\`bau hühnerstall\`) | Fishing Village | 2×1, 4 driftwood, 1 kelp rope, 6 work | 1 | 40 | up to 6 hens or chicks |
| Hut (\`bau hütte\`) | Fishing Village | 2×2, 6 driftwood, 2 kelp rope, 20 work | 1 | 40 | a chest of your own; cooking at the hearth (cheese, candles, every roast and soup, the feast) |
| Smokehouse (\`bau räucherei\`) | Fishing Village | 2×2, 10 driftwood, 2 kelp rope, 12 work | 2 | 40 | smokes fish and meat; its chest is the rack |
| Rain Barrel (\`bau regentonne\`) | Fishing Village | 1×1, 3 driftwood, 1 kelp rope, 4 work | 1 | 40 | water for the beds (\`schöpfe\`) |
| Jetty (\`bau steg\`) | Fishing Village | 2×1, 6 driftwood, 6 work | 1 | 40 | boats land, regatta (\`rudere\`, \`segle\`, \`luke\`) |
| Scarecrow (\`bau vogelscheuche\`) | Fishing Village | 1×1, 2 driftwood, 1 kelp rope, 3 work | 1 | 40 | keeps hares three cells away from the beds |
| Bakehouse (\`bau backhaus\`) | Village | 2×2, 6 driftwood, 6 shell, 1 kelp rope, 12 work | 2 | 40 | bakes bread (\`backe brot\`) |
| Pen (\`bau gehege\`) | Village | 3×3, 8 driftwood, 4 kelp rope, 8 work | 2 | 40 | up to 4 animals of one kind (sheep, goats, ducks, geese, pigs, piglets, cattle from the town on) |
| Chapel (\`bau kapelle\`) | Village | 3×2, 10 stone, 12 brick, 4 plank, 30 work | 3 | 60 | offerings for a shorter rest (\`opfere\`) |
| Warehouse (\`bau lagerhaus\`) | Village | 3×2, 12 driftwood, 4 kelp rope, 6 shell, 20 work | 3 | 45 | the settlement's store for everyone (\`lager\`) |
| Clay Pit (\`bau lehmgrube\`) | Village | 2×2, 6 driftwood, 2 kelp rope, 2 stone, 12 work | 2 | 45 | cut clay with a spade (\`steche\`) |
| Butcher's Shop (\`bau metzgerei\`) | Village | 2×2, 6 stone, 4 plank, 4 driftwood, 20 work | 2 | 40 | slaughters an animal you carry; one more piece of meat when slaughtering in the room; salted sausage, cured meat |
| Salt Garden (\`bau salzgarten\`) | Village | 2×2, 4 stone, 4 clay, 2 driftwood, 12 work | 2 | 40 | rake salt (\`harke\`) |
| Quarry (\`bau steinbruch\`) | Village | 2×2, 8 driftwood, 3 kelp rope, 4 stone, 16 work | 3 | 45 | break stone with a pickaxe (\`breche\`) |
| Road (\`bau straße\`) | Village | 1×1, 4 stone, 2 driftwood, 6 work | 1 | 45 | joins two rooms for the cart |
| Loom (\`bau webstuhl\`) | Village | 2×1, 6 driftwood, 2 kelp rope, 8 work | 1 | 40 | weaves cloth, sews down quilts |
| Workshop (\`bau werkstatt\`) | Village | 3×2, 10 driftwood, 8 stone, 4 kelp rope, 24 work | 3 | 45 | planks, rope, casings, cart, rowing boat, butcher's knife, leather bag, leather boots; beside it tools wear only half as fast |
| Windmill (\`bau windmühle\`) | Village | 2×2, 8 driftwood, 2 kelp rope, 2 linen, 16 work | 2 | 40 | grinds grain to flour, bones to bone meal (\`mahle\`) |
| Brickworks (\`bau ziegelei\`) | Village | 2×2, 8 stone, 6 driftwood, 6 clay, 20 work | 3 | 45 | fires bricks from clay |
| Brewery (\`bau brauerei\`) | Town | 3×2, 8 brick, 6 plank, 24 work | 3 | 45 | brews beer |
| Tannery (\`bau gerberei\`) | Town | 2×2, 8 stone, 6 plank, 4 brick, 28 work | 3 | 45 | tans skins into leather with salt |
| Greenhouse (\`bau gewächshaus\`) | Town | 3×2, 8 glass, 6 plank, 20 work | 2 | 45 | beds up to three cells beside it grow on through winter |
| Glassworks (\`bau glashütte\`) | Town | 3×2, 12 brick, 6 stone, 28 work | 3 | 45 | blows glass from sand |
| Department store (\`bau kaufhaus\`) | Town | 4×3, 14 brick, 8 plank, 6 stone, 36 work | 5 | 45 | a shop with fixed prices (\`laden\`) |
| Counting house (\`bau kontor\`) | Town | 3×2, 10 brick, 6 stone, 24 work | 4 | 45 | lends against a pledge, issues bills (\`kredit\`, \`wechsel\`) |
| Lighthouse (\`bau leuchtturm\`) | Town | 2×2, 16 stone, 10 brick, 2 fish oil, 40 work | 3 | 60 | 20 more light for its fire, light in the rooms next to it |
| Park (\`bau park\`) | Town | 4×4, 10 brick, 6 stone, 6 sea pink, 4 dune rose, 30 work | 9 | 120 | tend it, hold festivals (\`pflege\`, \`fest\`) |
| Town Hall (\`bau rathaus\`) | Town | 4×3, 16 brick, 10 stone, 6 plank, 40 work | 6 | 45 | motions and votes, tax (\`antrag\`, \`stimme\`) |
| Shipyard (\`bau werft\`) | Town | 4×3, 14 plank, 4 cordage, 6 stone, 36 work | 4 | 45 | builds sailing boats |
| Station (\`bau bahnhof\`) | Net | 3×2, 12 brick, 10 plank, 8 stone, 2 cordage, 32 work | 4 | 45 | the island railway (\`zug\`) |
| Signal fire (\`bau signalfeuer\`) | Net | 1×1, 6 stone, 2 brick, 1 fish oil, 10 work | 2 | 45 | a fire of the signal chain |

**Light** is the light points the building takes from its fire; **lasts** is the time until it decays without repair (\`repariere\`). The **workshop** is the building of the crafts: planks and rope for the larger buildings, casings, the cart and the rowing boat, the butcher's knife and the leather goods; beside it tools wear only half as fast.`,
		},
	},
	{
		id: "help.game.garden",
		section: "play",
		title: { de: "Gärten: Beet, Samen, Gießen, Ernte", en: "Gardens: bed, seeds, watering, harvest" },
		short: {
			de: "Beet anlegen, Samen pflanzen, gießen, jäten und ernten; neue Sorten kreuzen.",
			en: "Dig a bed, plant seeds, water, weed and harvest; cross new sorts.",
		},
		body: {
			de: `Ein Garten wächst mit der Zeit und will gepflegt werden. Du gräbst ein Beet um, pflanzt Samen, gießt und erntest. Gärten bringen eine Insel genauso voran wie Bauten. Dafür brauchst du einen Spaten, Wasser und das Licht eines Feuers.

Ein Beet belegt einen Lichtpunkt des Feuers. Anlegen braucht ein Konto; als **Pate** gießen und ernten dürfen auch Gäste. Größer sind die [Äcker](help.game.fields), und was im Nebel an den Beeten frisst, steht unter [Wild](help.game.wild).

## Spaten und Beet {#bed}

Ein Beet ist ein kleines Stück Land, das dir gehört. Zuerst brauchst du einen Spaten.

\`craft spaten\` macht aus **2 Treibholz und 1 Tangseil** einen Spaten. Damit gräbt \`umgraben\` neben dir ein Beet um (2×2 Felder), \`umgraben <x> <y>\` an einer bestimmten Stelle. Jeder hat höchstens drei Beete. Wie bei Bauten bleiben Ausgänge, Türen und der Platz am Feuer frei, und niemand läuft durch ein Beet.

\`beet\` zeigt die Beete hier: was wächst, wann zuletzt gegossen wurde, ob Unkraut darin ist. \`beet aufgeben\` macht deins wieder zu Gras. Ein Beet, das zwei Wochen niemand pflegt, wächst von selbst zu.

## Samen {#seeds}

Samen findest du in der wilden Natur der Inseln, oder du kaufst sie bei Gesa. Nicht jede Sorte wächst überall.

\`sammle samen\` sucht in der wilden Flora des Ortes nach Samen; das klappt nicht jedes Mal, danach wartest du an diesem Ort zehn Weltminuten; anderswo kannst du gleich weitersuchen.

| Sorte | Wo sie wild wächst | Ernte |
| --- | --- | --- |
| Strandnelke | wo Blumen blühen, überall | Strandnelke |
| Dünenrose | Graue Insel, Krabbensand, Möwenfels | Dünenrose |
| Nebelblume | nur Nebelholm | Nebelblume (selten) |
| Strandkohl | wo Kräuter wachsen, überall | 2 Kohl |
| Möhre | Graue Insel, Kupferhafen, Rauchholm, Krabbensand | 2 Möhren |

\`pflanze strandnelke\` setzt einen Samen in dein Beet, eine Pflanze je Feld (\`pflanze kohl <x> <y>\` in ein bestimmtes). Jede Ernte gibt neue Samen, manchmal zwei.

## Wasser und Pflege {#care}

Pflanzen brauchen Wasser, sonst welken sie. Du holst es aus einer Regentonne und gießt damit das ganze Beet.

Wasser kommt aus der **Regentonne** (\`bau regentonne\`: 3 Treibholz, 1 Tangseil, 4 Arbeit). \`schöpfe\` neben der Tonne füllt eine **Kanne Wasser**; die Tonne fasst sechs, bekommt alle acht Weltstunden eine dazu und ist nach einer Sturmflut auf ihrer Insel voll. \`gieße\` gießt mit einer Kanne das ganze Beet.

Eine Pflanze wächst in Stufen: **Saat**, **Keim**, **reif**, **welk**. Steht sie beim nächsten Schritt länger als 16 Weltstunden ohne Wasser, welkt sie. Eine reife Pflanze welkt nach ein bis drei Tagen. **Nebel** und **Unkraut** lassen sie langsamer wachsen: ein brennendes Feuer hilft auch dem Garten. \`jäte\` zieht Unkraut und Welkes heraus.

## Ernten {#harvest}

Reife Pflanzen gehören in die Tasche, bevor sie welken. Dabei bekommst du auch neue Samen.

\`ernte\` holt alles Reife des Beets in deine Tasche, mit Samen. Stehen mehrere am Beet, bekommt jede Pflanze genau einer.

## Zierbeet und Gemeinschaftsbeet {#kinds}

Es gibt drei Arten von Beeten. Das Gartenbeet nimmt alles, das Zierbeet nur Blumen, und das Gemeinschaftsbeet gehört allen.

\`umgraben\` legt ein **Gartenbeet** an, in dem Gemüse und Blumen wachsen. \`umgraben zier\` gräbt ein **Zierbeet** um: Dort wachsen nur Blumen (Strandnelke, Dünenrose, Nebelblume), und nur dort kreuzen sie sich. Es zählt wie jedes Beet zu deinen dreien.

\`umgraben gemeinschaft\` legt ein **Gemeinschaftsbeet** an: 3×3 Felder, zwei Lichtpunkte, **eins je Feuer**. Es zählt nicht zu deinen Beeten. Pflanzen darf darin jeder mit Konto, gießen, jäten und ernten alle, auch Gäste. Was du erntest, kommt in deine Tasche, aber jeder nimmt nur einen Teil: Wer es nicht angelegt hat, erntet auf einmal **höchstens 2 Pflanzen und höchstens die Hälfte** des Reifen (mit ihren Samen), wer es angelegt hat, höchstens **zwei Drittel**; eine einzelne reife Pflanze darf jeder nehmen. Aufgeben kann es nur, wer es angelegt hat.

## Kreuzen und Benennen {#breeding}

Blumen können sich kreuzen und eine ganz neue Sorte ergeben. Wer sie zieht, darf ihr einen Namen geben.

Reift im Zierbeet eine Blume, neben der (nicht über Eck) eine Blume einer anderen Sorte steht, ist bei der Ernte manchmal ein **Kreuzungssamen** dabei. Was daraus wächst, hat eine eigene Farbe zwischen den Farben seiner Eltern. Eine Kreuzung kreuzt sich weiter, auch mit ihrer eigenen Ausgangssorte.

Wer sie gezogen hat, gibt ihr mit \`benenne <name>\` einen Namen, einmal und für immer: Dann heißen ihre Samen „<Name>-Samen“ und ihre Blumen wie die Sorte, und wer sie erntet oder geschenkt bekommt, trägt den Namen weiter. Ein Name hat 3 bis 24 Buchstaben, ist noch nicht vergeben und bezeichnet nichts, was es in der Welt oder als Befehl schon gibt.

## Die Gärtnerin {#gardener}

Gesa hilft allen, die anfangen. Bei ihr gibt es Samen, Saatgut und Tiere.

**Gesa** in Kupferhafen sammelt selbst Samen in der Flora des Hafens und verkauft sie am Markt; sie kauft Blumen und Gemüse. Ihre Suchaufträge hängen an der Tafel („Gesa sucht eine Nebelblume“). Wer sie anspricht, erfährt ihre Preise.

## Patenschaft {#sponsor}

Du musst nicht jeden Tag da sein. Ein Pate kümmert sich um dein Beet, solange du fort bist.

\`pate <name>\` lässt jemanden dein Beet gießen, jäten und ernten, ohne dass es ihm gehört; auch einen Gast. So bleibt es gepflegt, wenn du ein paar Tage nicht spielst. \`pate weg <name>\` beendet es, \`pate\` allein zeigt die Paten.

Gießen, jäten, ernten und pflanzen gehen aus bis zu **zwei Feldern** Abstand. Die rechte Maustaste auf einem Beet bietet an, was du dort tun kannst.`,
			en: `A garden grows over time and wants looking after. You dig a bed, plant seeds, water and harvest. Gardens move an island forward just as buildings do. You need a spade, water and a fire's light.

A bed takes one of the fire's light points. Digging one needs an account; as a **sponsor** guests may water and harvest too. Larger plots are the [fields](help.game.fields), and what eats at the beds in the fog is under [wild animals](help.game.wild).

## Spade and bed {#bed}

A bed is a small piece of land that is yours. First you need a spade.

\`craft spaten\` makes a spade from **2 driftwood and 1 kelp rope**. With it \`umgraben\` digs a bed next to you (2×2 cells), \`umgraben <x> <y>\` at a given spot. Everyone has at most three beds. As with buildings, exits, doors and the place at the fire stay free, and nobody walks through a bed.

\`beet\` (\`bed\`) shows the beds here: what grows, when they were last watered, whether weeds grow. \`beet aufgeben\` turns yours back into grass. A bed nobody tends for two weeks grows over by itself.

## Seeds {#seeds}

You find seeds in the wild plants of the islands, or you buy them from Gesa. Not every sort grows everywhere.

\`sammle samen\` looks for seeds in the place's wild flora; it does not work every time, and afterwards you wait ten world minutes at this place; elsewhere you can go on looking at once.

| Sort | Where it grows wild | Harvest |
| --- | --- | --- |
| Strandnelke (thrift) | where flowers grow, everywhere | thrift |
| Dünenrose (dune rose) | Graue Insel, Krabbensand, Möwenfels | dune rose |
| Nebelblume (fog flower) | Nebelholm only | fog flower (rare) |
| Strandkohl (sea kale) | where herbs grow, everywhere | 2 cabbages |
| Möhre (carrot) | Graue Insel, Kupferhafen, Rauchholm, Krabbensand | 2 carrots |

\`pflanze strandnelke\` (\`plant\`) puts a seed into your bed, one plant per cell (\`pflanze kohl <x> <y>\` into a given one). Every harvest gives new seeds, sometimes two.

## Water and care {#care}

Plants need water or they wilt. You fetch it from a rain barrel and water the whole bed with it.

Water comes from the **rain barrel** (\`bau regentonne\`: 3 driftwood, 1 kelp rope, 4 work). \`schöpfe\` (\`fill\`) next to the barrel fills a **can of water**; the barrel holds six, gains one every eight world hours and is full after a storm surge on its island. \`gieße\` (\`water\`) waters the whole bed with one can.

A plant grows in stages: **seed**, **sprout**, **ripe**, **wilted**. If it has gone without water for more than 16 world hours at its next step, it wilts. A ripe plant wilts after one to three days. **Fog** and **weeds** slow it down: a burning fire helps the garden too. \`jäte\` (\`weed\`) pulls weeds and what has wilted.

## Harvest {#harvest}

Ripe plants belong in your pack before they wilt. You also get new seeds.

\`ernte\` (\`harvest\`) takes everything ripe in the bed into your pack, with seeds. If several stand at the bed, each plant goes to exactly one.

## Flower bed and community bed {#kinds}

There are three kinds of bed. A garden bed takes everything, a flower bed only flowers, and a community bed belongs to everyone.

\`umgraben\` digs a **garden bed**, where vegetables and flowers grow. \`umgraben zier\` digs a **flower bed**: only flowers grow there (thrift, dune rose, fog flower), and only there do they cross. It counts towards your three like any bed.

\`umgraben gemeinschaft\` lays out a **community bed**: 3×3 cells, two light points, **one per fire**. It does not count towards your beds. Everyone with an account may plant in it, and everyone, guests too, may water, weed and harvest. What you harvest goes into your pack, but each takes only a part: whoever did not lay it out harvests **at most 2 plants and at most half** of what is ripe at once (with their seeds), whoever laid it out at most **two thirds**; a single ripe plant anyone may take. Only whoever laid it out can give it up.

## Crossing and naming {#breeding}

Flowers can cross and give a completely new sort. Whoever breeds it may name it.

When a flower ripens in a flower bed with a flower of another sort beside it (not across a corner), the harvest sometimes brings a **seed of a crossing** (\`Kreuzungssamen\`). What grows from it has a colour of its own, between its parents' colours. A crossing crosses again, with its own parent sort too.

Whoever bred it names it with \`benenne <name>\`, once and for good. Its seeds are then called "<Name>-Samen" and its flowers like the sort, and whoever harvests them or is given them carries the name on. A name has 3 to 24 letters, is not yet taken, and means nothing the world or its commands already mean.

## The gardener {#gardener}

Gesa helps everyone who is starting out. She has seeds, seed grain and animals.

**Gesa** in Kupferhafen gathers seeds herself in the harbour's flora and sells them at the market; she buys flowers and vegetables. Her search orders hang on the board ("Gesa sucht eine Nebelblume"). Speak to her to learn her prices.

## Sponsorship {#sponsor}

You need not be there every day. A sponsor looks after your bed while you are away.

\`pate <name>\` (\`sponsor\`) lets someone water, weed and harvest your bed without it being theirs, a guest too. That keeps it tended while you do not play for a few days. \`pate weg <name>\` ends it, \`pate\` alone shows the sponsors.

Watering, weeding, harvesting and planting work from up to **two cells** away. The right-click menu on a bed offers what you can do there.`,
		},
	},
	{
		id: "help.game.fields",
		section: "play",
		title: { de: "Äcker, Mühle und Backhaus", en: "Fields, mill and bakery" },
		short: {
			de: "Große Felder für viele Hände, Fruchtfolge, aus Korn wird Mehl und Brot.",
			en: "Large fields for many hands, crop rotation, grain becomes flour and bread.",
		},
		body: {
			de: `Ein Acker ist ein großes Feld, das viele Hände braucht. Man sät gemeinsam, wartet ein paar Tage und bringt die Ernte zusammen ein. Aus dem Korn wird in der Mühle Mehl und im Backhaus Brot. Äcker, Mühle und Backhaus gibt es erst, wenn die Insel ein [Dorf](help.game.village#epochs) ist.

## Äcker {#fields}

Ein Acker ist ein Feld, das eine einzige Frucht trägt. Sie braucht kaum tägliche Pflege, dafür zweimal viel Arbeit.

Der **Acker** hat 4×4 Felder, einerr je Konto, im Licht eines Feuers (zwei Lichtpunkte). Mit einem Spaten bricht \`flur anlegen\` sie neben dir um, \`flur anlegen <x> <y>\` an einer bestimmten Stelle. Anlegen braucht ein Konto.

## Bestellen {#sow}

Zuerst wird der Acker bestellt. Wer ihn angelegt hat, wählt die Frucht, dann bringen alle Saatgut und Arbeit.

Wer den Acker anlegte, wählt die Frucht mit \`bestelle gerste\`. Dann braucht sie **4 Saatgut und 2 Arbeit**: Jedes \`bestelle\` bringt, was du an Saatgut trägst, und einen Arbeitspunkt; danach ruhst du wie an der Baustelle (standardmäßig 15 Weltminuten).

| Frucht | Saatgut | Woher | Art | Ertrag |
| --- | --- | --- | --- | --- |
| Weizen | Weizen | Gesa | Getreide | 16 Weizen |
| Gerste | Gerste | wild, wo Kräuter wachsen | Getreide | 16 Gerste |
| Hafer | Hafer | wild: Graue Insel, Nebelholm, Schären | Getreide | 16 Hafer |
| Kartoffeln | Kartoffel | Gesa | Hackfrucht | 24 Kartoffeln |
| Rüben | Rübensamen | wild: Graue Insel, Kupferhafen, Krabbensand | Rüben | 16 Rüben, 8 Rübensamen |
| Flachs | Leinsamen | wild, wo Blumen blühen | Flachs | 16 Flachs, 8 Leinsamen |

## Ernteeinsatz {#gang}

Ist der Acker reif, kommt es auf viele Hände an. Jeder bekommt sofort, was er selbst einbringt.

Nach zwei bis drei Tagen ist der Acker reif und bleibt es zwei Tage. Jedes \`ernte\` an ihr (\`ernte flur\`, wenn auch ein Beet nah ist) ist ein Arbeitspunkt (8 für einen Acker) und gibt dir deinen Anteil sofort in die Tasche. Allein dauert das acht Stunden; acht Hände bringen sie in einer ein, und jedes Korn bekommt genau einer. Danach ist der Acker **überreif**, jeder Anteil nur noch halb so groß, und noch zwei Tage später ist die Frucht verdorben.

\`flur offen\` lässt jeden mitsäen und miternten, auch Gäste, und jeder behält seinen Anteil; \`flur zu\` schließt sie wieder.

## Fruchtfolge {#rotation}

Der Boden wird müde, wenn immer dasselbe auf ihm wächst. Wechselt die Frucht, gibt er wieder mehr.

Dieselbe Art zweimal hintereinander macht den Boden müde, er gibt nur noch 60 %, beim dritten Mal 35 %. Eine andere Art oder drei Tage Brache heilen ihn: Getreide, dann Kartoffeln, dann Rüben oder Ruhe. \`flur\` zeigt den Boden. Ein Acker, an dem zwei Wochen niemand arbeitet, verwildert.

## Mühle und Backhaus {#mill}

Aus der Ernte lässt sich mehr machen. Wer Korn mahlt und Brot bäckt, verdient besser als mit dem Korn allein. Beide Bauten darf jeder benutzen, egal wem sie gehören.

Aus der Ernte wird mehr: **Korn → Mehl → Brot** und **Flachs → Leinen**.

**Windmühle** (\`bau windmühle\`: 2×2 Felder, 8 Treibholz, 2 Tangseil, **2 Leinen** für die Flügel, 16 Arbeit). Mahlen darf jeder an jeder Mühle: \`mahle alle weizen\` schüttet dein Korn hinein (Weizen, Gerste oder Hafer, auch Knochen zu Knochenmehl, bis 12 auf einmal, höchstens drei Säcke je Figur). Sie mahlt eine Weltstunde je Handvoll, was vor dir kam, zuerst. \`mahle\` allein sagt, wie lange sie noch zu tun hat; ist dein Mehl fertig, holt \`abholen\` es (bis zwei Felder Abstand). Bei **Sturmflut** auf ihrer Insel dreht sie schneller und mahlt sechs Stunden voraus. Fällt die Mühle, bevor dein Korn gemahlen ist, holst du an ihrer Stelle dein Korn zurück. Was zwei Wochen niemand abholt, ist verloren.

**Backhaus** (\`bau backhaus\`: 2×2 Felder, 6 Treibholz, 6 Muscheln, 1 Tangseil, 12 Arbeit). Daneben bäckt \`backe brot\` aus **2 Mehl, einer Kanne Wasser und einem Scheit Treibholz** drei Brote, an jedem Backhaus, wem es auch gehört.

**Leinen** spinnt man aus Flachs: \`craft spindel\` (1 Treibholz, 1 Muschel), dann \`craft leinen\` (3 Flachs). Leinen braucht die Mühle für ihre Flügel; die Werft zahlt dafür.

Brot, Mehl und Leinen kauft Marta am Markt von Kupferhafen, und die Auftragstafeln fragen danach. Was man vermahlt, sät man nicht: Korn ist Brot und Saatgut zugleich.`,
			en: `A field is a large plot that needs many hands. You sow together, wait a few days and bring the harvest in together. At the mill the grain becomes flour, at the bakery bread. Fields, mill and bakery exist only once the island is a [village](help.game.village#epochs).

## Fields {#fields}

A field carries one single crop. It needs little daily care, but two bursts of work.

The **field** has 4×4 cells, one per account, in a fire's light (two light points). With a spade \`field new\` breaks one beside you, \`field new <x> <y>\` at a given spot. Breaking one needs an account.

## Sowing {#sow}

First the field is sown. Whoever made it chooses the crop, then everyone brings seed and work.

Whoever made the field chooses the crop with \`plough gerste\` (\`plough\`). Then it needs **4 seed and 2 work**: every \`plough\` brings what seed you carry and one work point; then you rest as at a building site (by default 15 world minutes).

| Crop | Seed | From | Kind | Yield |
| --- | --- | --- | --- | --- |
| Wheat | wheat | Gesa | grain | 16 wheat |
| Barley | barley | wild, where herbs grow | grain | 16 barley |
| Oats | oats | wild: Grey Island, Nebelholm, Skerries | grain | 16 oats |
| Potatoes | potato | Gesa | root crop | 24 potatoes |
| Beets | beet seed | wild: Grey Island, Kupferhafen, Krabbensand | beets | 16 beets, 8 beet seed |
| Flax | linseed | wild, where flowers bloom | flax | 16 flax, 8 linseed |

## Harvest gang {#gang}

When the field is ripe, many hands count. Everyone gets at once what they bring in themselves.

After two to three days the field is ripe and stays so for two days. Every \`ernte\` at it (\`ernte flur\` when a bed is near too) is a work point (8 for a field) and puts your share in your pack at once. Alone it takes eight hours; eight hands bring it in in one, and every grain goes to exactly one. After that the field is **overripe**, each share only half, and two days later the crop is lost.

\`field offen\` lets anyone sow and harvest along, guests too, and each keeps their share; \`field zu\` closes it again.

## Crop rotation {#rotation}

The soil tires when the same thing keeps growing on it. Change the crop and it gives more again.

The same kind twice in a row tires the soil, it gives only 60 %, the third time 35 %. Another kind or three days of rest heal it: grain, then potatoes, then beets or rest. \`field\` shows the soil. A field nobody works for two weeks runs wild.

## Mill and bakery {#mill}

The harvest can become more. Grinding grain and baking bread earns more than the grain alone. Anyone may use both buildings, whoever owns them.

The harvest becomes more: **grain → flour → bread** and **flax → linen**.

**Windmill** (\`bau windmühle\`: 2×2 cells, 8 driftwood, 2 kelp rope, **2 linen** for the sails, 16 work). Anyone may grind at any mill: \`mahle alle weizen\` (\`grind\`) pours your grain in (wheat, barley or oats, bones into bone meal too, up to 12 at once, at most three sacks per figure). It grinds a world hour per handful, what came before you first. \`mahle\` alone says how long it still has to go; when your flour is ready, \`abholen\` (\`pickup\`) fetches it (from up to two cells away). In a **storm surge** on its island it turns faster and grinds six hours ahead. If the mill falls before your grain is ground, you fetch your grain back at its place. What nobody fetches in two weeks is lost.

**Bakery** (\`bau backhaus\`: 2×2 cells, 6 driftwood, 6 shells, 1 kelp rope, 12 work). Beside it \`backe brot\` (\`bake\`) bakes three loaves from **2 flour, a can of water and a log of driftwood**, at any bakery, whoever owns it.

**Linen** is spun from flax: \`craft spindel\` (1 driftwood, 1 shell), then \`craft leinen\` (3 flax). The mill needs linen for its sails; the shipyard pays for it.

Marta at the Kupferhafen market buys and sells bread, flour and linen, and the job boards ask for them. What you grind you do not sow: grain is bread and seed at once.`,
		},
	},
	{
		id: "help.game.animals",
		section: "play",
		title: { de: "Tiere", en: "Animals" },
		short: {
			de: "Alle Tiere des Spiels: Hühner, Enten, Gänse, Schafe, Ziegen, Schweine, Rinder (Kühe) und Bienen halten, füttern und schlachten, was Herd, Räucherei, Metzgerei und Gerberei daraus machen, Salz, Verderb, Küken und Ferkel, Hund und Katze als Wächter, und das Wild aus dem Nebel.",
			en: "Every animal of the game: keep, feed and slaughter hens, ducks, geese, sheep, goats, pigs, cows and bees, what the hearth, the smokehouse, the butcher's shop and the tannery make of them, salt, spoiling, chicks and piglets, dogs and cats as guards, and the wild animals from the fog.",
		},
		body: {
			de: `Tiere leben in einem Stall, Gehege oder Bienenstock, der dir gehört. Du fütterst sie, und sie geben dir Eier, Milch, Wolle, Daunen, Trüffel oder Honig. Daraus entstehen Waren, die gut bezahlt werden. Hühner und Bienen gehen von Anfang an, das Gehege erst im [Dorf](help.game.village#epochs), Rinder erst in der Stadt.

## Alle Tiere {#all}

Es gibt drei Arten von Tieren: Hoftiere, die du hältst, Wächter, die deinen Ort schützen, und Wild, das aus dem Nebel kommt.

| Tier | Art | wo | ab | gibt |
| --- | --- | --- | --- | --- |
| [Huhn](help.game.animals#hen) | Hoftier | Hühnerstall | Anfang | Eier |
| [Ente](help.game.animals#duck) | Hoftier | Gehege | Dorf | Eier |
| [Gans](help.game.animals#goose) | Hoftier | Gehege | Dorf | Daunen, hält Wache |
| [Schaf](help.game.animals#sheep) | Hoftier | Gehege | Dorf | Wolle |
| [Ziege](help.game.animals#goat) | Hoftier | Gehege | Dorf | Milch |
| [Schwein](help.game.animals#pig) | Hoftier | Gehege | Dorf | Trüffel |
| [Rind (Kuh)](help.game.animals#cow) | Hoftier | Gehege | Stadt | Milch, Leder |
| [Bienenvolk](help.game.animals#bees) | Hoftier | Bienenstock | Anfang | Honig, Wachs |
| [Hund](help.game.animals#guards) | Wächter | an einem deiner Bauten | Anfang | hält Hasen, Rehe und Füchse fern |
| [Katze](help.game.animals#guards) | Wächter | an einem deiner Bauten | Anfang | hält Mäuse fern |
| [Hase, Reh, Fuchs, Maus, Möwe](help.game.animals#wild) | Wild | kommen aus dem Nebel | – | fressen, was du anbaust und hältst |

Alle Hoftiere, Hund und Katze verkauft Gesa am Markt von Kupferhafen. Ein Tier trägst du wie ein Ding (Last 4, ein Rind 8, Hund und Katze 2) und kannst es tauschen und handeln.

## Stall und Gehege {#house}

Jedes Hoftier braucht ein Zuhause, das dir gehört. Stall, Gehege und Bienenstock baust du wie jeden anderen Bau.

| Bau | Befehl | Felder | Material | Arbeit | Platz |
| --- | --- | --- | --- | --- | --- |
| Hühnerstall | \`bau hühnerstall\` | 2×1 | 4 Treibholz, 1 Tangseil | 6 | 6 Hühner |
| Gehege | \`bau gehege\` | 3×3 | 8 Treibholz, 4 Tangseil | 8 | 4 Tiere einer Art |
| Bienenstock | \`bau bienenstock\` | 1×1 | 2 Treibholz, 2 Tangseil | 4 | 3 Völker |

In einem Gehege lebt immer nur eine Art: Schafe, Ziegen, Enten, Gänse, Schweine oder Rinder. \`einstallen huhn\` bringt ein Tier, das du trägst, in deinen Stall, \`ausstallen\` nimmt eins heraus. \`stall\` zeigt, wie es ihnen geht. Du hältst bis zu fünf Ställe, Gehege und Bienenstöcke zusammen (der Betreiber kann es ändern).

## Füttern {#feed}

Tiere fressen, was auf Feldern und Beeten wächst. Füttern darf jeder, nicht nur der Besitzer.

\`füttere\` gibt Futter aus deiner Tasche (\`füttere 3 hafer\` mehrere auf einmal). Ein Futter macht ein Tier einen Tag satt, bis zu drei Tage im Voraus.

| Tier | frisst | gibt, wenn es satt ist |
| --- | --- | --- |
| Huhn | Tang, Kohl, Möhren, Weizen, Gerste, Hafer | ein Ei am Tag |
| Ente | Tang, Kohl, Weizen, Gerste, Hafer | ein Ei am Tag |
| Gans | Gerste, Hafer, Kohl, Rüben, Tang | Daunen alle drei Tage |
| Schaf | Rüben, Hafer, Gerste, Kohl, Tang | Wolle alle zwei Tage |
| Ziege | Rüben, Hafer, Gerste, Kohl, Möhren, Tang | Milch am Tag |
| Schwein | Kartoffeln, Rüben, Möhren, Kohl, Hafer, Gerste | eine Trüffel alle drei Tage |
| Rind | Hafer, Gerste, Rüben, Kohl | Milch zweimal am Tag, auf vier Kannen ein Leder |
| Bienenvolk | Strandnelke, Dünenrose, Nebelblume, Hopfen | Honig alle zwei Tage, auf drei Töpfe ein Wachs |

## Was Tiere geben {#yield}

Satte Tiere geben regelmäßig etwas. Abholen darf das nur, wem sie gehören.

Hungrige Tiere geben nichts, bis wieder gefüttert wird, aber sie verlieren nichts. Bis zu drei je Tier warten im Stall; \`einsammeln\` (auch \`sammle eier\`, \`melke\`, \`schere\`) holt sie, nur der Besitzer. Zwei satte Tiere einer Art bekommen ab und zu ein Junges, bis der Stall voll ist. Reißt du den Stall ab, kommen die Tiere in deine Tasche zurück; verfällt er, warten sie im Nachlass. Wer Fleisch will, schlachtet ([Schlachten und Küche](help.game.animals#slaughter)).

## Huhn {#hen}

Das **Huhn** ist das erste Hoftier: Der Hühnerstall geht schon im Fischerdorf. Satt legt jedes Huhn ein **Ei** am Tag. Eier machen satt (\`iss ei\`), Gesa kauft sie, und die Schenke im Hafenviertel fragt an der Auftragstafel nach ihnen. Füchse holen nachts ein Huhn aus dem Stall, nie das letzte; ein Zaun um den Stall, satte Gänse oder ein Hund halten sie fern ([Wild](help.game.wild#shelter)).

## Ente {#duck}

Die **Ente** lebt im Gehege und legt wie das Huhn ein **Ei** am Tag. Sie frisst Tang und Korn und ist ein guter Anfang, wenn du kein Getreide für ein Schaf hast.

## Gans {#goose}

Die **Gans** gibt alle drei Tage **Daunen**. Am Webstuhl näht \`craft decke\` aus 2 Tuch und 3 Daunen eine Daunendecke, die Marta gut bezahlt. Satte **Gänse** halten Wache: In ihrem Raum kommt kein Hase an die Beete und kein Fuchs in den Stall, sie schnattern ihn fort.

## Schaf {#sheep}

Das **Schaf** gibt alle zwei Tage **Wolle**. Am **Webstuhl** (\`bau webstuhl\`: 2×1 Felder, 6 Treibholz, 2 Tangseil, 8 Arbeit) webt \`craft tuch\` aus 3 Wolle mit einer Spindel ein Tuch.

## Ziege {#goat}

Die **Ziege** gibt jeden Tag **Milch** und frisst fast alles, auch Möhren und Tang. Am Herd einer **Hütte** macht \`craft käse\` aus 3 Milch und einem Scheit Treibholz einen Käse.

## Schwein {#pig}

Das **Schwein** lebt im Gehege und frisst vor allem **Kartoffeln** und Rüben, dazu Möhren, Kohl und Korn. Es wühlt den Boden um und bringt alle drei Tage eine **Trüffel** heraus. Trüffel sind selten und teuer: Marta kauft sie, und der Koch der Schenke im Hafenviertel fragt an der Auftragstafel danach. Schweine vermehren sich schnell, ein volles Gehege hast du bald.

## Rind (Kuh) {#cow}

Das **Rind** (auch \`kuh\`) kommt erst, wenn deine Insel eine Stadt ist. Es ist schwer (Last 8) und will Hafer, Gerste, Rüben oder Kohl. Dafür gibt es zweimal am Tag **Milch**, doppelt so viel wie eine Ziege, und auf vier Kannen kommt ein Stück **Leder** dazu. Junge bekommt ein Rind nur selten.

## Bienen {#bees}

Bienen leben im **Bienenstock**, von Anfang an. Ein **Bienenvolk** kaufst du bei Gesa; \`einstallen bienenvolk\` setzt es in deinen Stock.

Bienen fressen **Blumen**: Strandnelke, Dünenrose, Nebelblume und Hopfen, die im [Zierbeet](help.game.garden#bed) wachsen. \`füttere\` gibt sie ihnen wie jedem Tier, eine Blume macht ein Volk einen Tag satt. Satt gibt jedes Volk alle zwei Tage einen Topf **Honig**, und auf drei Töpfe kommt ein Klumpen **Wachs** dazu; \`einsammeln\` holt beides. Ein starkes Volk schwärmt ab und zu, dann zieht ein neues ein, bis der Stock voll ist.

Honig macht satt (\`iss honig\`). Am Herd einer **Hütte** zieht \`craft kerze\` aus 2 Wachs und 1 Leinen zwei Kerzen. Gesa kauft Honig und Wachs, Marta Honig und Kerzen, und die Schenke im Hafenviertel fragt an der Auftragstafel nach Honig.

## Schlachten und Küche {#slaughter}

Hoftiere kannst du schlachten. Das Fleisch kochst du am Herd einer Hütte oder räucherst es in der Räucherei.

\`schlachte\` (oder \`schlachte schwein\`) schlachtet ein Tier aus deinem Stall oder Gehege neben dir. Das darf nur, wem der Stall gehört, und du brauchst ein Messer, das dabei stumpfer wird: ein **Schlachtmesser** (\`craft schlachtmesser\` in der Werkstatt aus 2 Stein, 1 Bohle und 1 Tangseil, hält 20 Tiere) oder ein **Muschelmesser** (\`craft muschelmesser\`, hält 5); trägst du beide, nimmst du das Schlachtmesser. Steht im Ort eine **Metzgerei** (ab dem Dorf: 6 Stein, 4 Bohlen, 4 Treibholz), gibt jedes Tier ein Stück Fleisch mehr. **An der Metzgerei** schlachtest du auch ein Tier, das du trägst (aus dem Stall geholt mit \`ausstallen\` oder gekauft): \`schlachte huhn\` direkt daneben, oder rechte Maustaste auf die Metzgerei; dort bleibt kein Paar zurück, es ist ja schon aus der Herde. Das **letzte Paar** einer Art bleibt immer im Stall, damit die Herde weiterlebt: Schlachten kannst du erst, wenn ein Junges dazugekommen ist. Bienen, Hund und Katze werden nicht geschlachtet.

| Tier | gibt beim Schlachten |
| --- | --- |
| Huhn | 1 Hähnchen, 2 Federn |
| Ente | 1 Entenfleisch, 2 Federn |
| Gans | 2 Gänsefleisch, 2 Daunen, 1 Schmalz |
| Schaf | 3 Lammfleisch, 1 Schaffell, 1 Talg, 1 Knochen |
| Ziege | 2 Ziegenfleisch, 1 Ziegenfell, 1 Knochen |
| Schwein | 3 Schweinefleisch, 2 Speckseiten, 1 Schmalz, 1 Borsten, 1 Knochen |
| Rind | 4 Rindfleisch, 1 Rinderfilet, 2 Leder, 2 Talg, 2 Knochen |

Was daraus wird (\`craft <name>\`):

| Gericht | aus | wo | macht satt |
| --- | --- | --- | --- |
| Grillhähnchen | 1 Hähnchen, 1 Treibholz | Hütte | 8 Stunden |
| 2 Hühnersuppen | 1 Hähnchen, 1 Möhre, 1 Kohl, 1 Kanne Wasser | Hütte | 8 Stunden |
| Entenbraten | 1 Entenfleisch, 1 Treibholz | Hütte | 10 Stunden |
| Gänsebraten | 2 Gänsefleisch, 1 Treibholz | Hütte | 14 Stunden |
| Lammbraten | 2 Lammfleisch, 1 Treibholz | Hütte | 12 Stunden |
| 3 Eintöpfe | 1 Ziegenfleisch, 2 Kartoffeln, 1 Rübe, 1 Kanne Wasser | Hütte | 10 Stunden |
| Schweinebraten | 2 Schweinefleisch, 1 Treibholz | Hütte | 12 Stunden |
| 3 Bratwürste | 2 Schweinefleisch, mit Muschelmesser | Hütte | 6 Stunden |
| 2 Steaks | 1 Rinderfilet, 1 Treibholz | Hütte | 10 Stunden |
| Rinderbraten | 2 Rindfleisch, 1 Treibholz | Hütte | 14 Stunden |
| 2 Schmalzbrote | 1 Schmalz, 1 Brot | Hütte | 6 Stunden |
| Speck | 1 Speckseite, 1 Treibholz | Räucherei | 6 Stunden |
| Schinken | 2 Schweinefleisch, 1 Treibholz | Räucherei | 10 Stunden |
| 2 Räucherwürste | 2 Bratwürste, 1 Treibholz | Räucherei | 8 Stunden |
| 5 Bratwürste (\`craft metzgerwurst\`) | 2 Schweinefleisch, 1 Salz, mit Schlachtmesser | Metzgerei | 6 Stunden |
| 2 Pökelfleisch | 2 Schweinefleisch, 1 Salz | Metzgerei | 8 Stunden |
| 2 Trockenfleisch | 2 Rindfleisch, 1 Salz, 1 Treibholz | Räucherei | 8 Stunden |
| Festessen | 1 Gänsebraten, 1 Schweinebraten, 2 Brot, 2 Bier | Hütte | 24 Stunden |
| 2 Talgkerzen (Kerzen) | 2 Talg, 1 Leinen | Hütte | – |

\`iss grillhähnchen\` isst es; wer satt ist, ruht nach der Arbeit kürzer.

**Wer kauft:** **Wilma**, die Fleischerin am Markt von Kupferhafen, kauft rohes Fleisch, Felle, Leder, Talg, Schmalz und Knochen und verkauft Bratwurst, Speck, Schinken, Räucherwurst, Grillhähnchen, Pökelfleisch und Salz. Marta kauft Schinken, Speck, Räucherwurst, Pökel- und Trockenfleisch, Ledertaschen und Lederstiefel, Gesa Federn, Felle, Borsten und Talg, das Kaufhaus Bratwurst, Speck, Schinken, Grillhähnchen, Salz, Pökel- und Trockenfleisch und Ledertaschen. An den Auftragstafeln fragt die Schenke im Hafenviertel nach Grillhähnchen, Bratwürsten und einem Gänsebraten fürs Fest, die Riffischer nach Schinken und Speck oder Pökelfleisch als Proviant, die Fähre nach Trockenfleisch, ein Lotse nach Lederstiefeln, und fürs Erntefest im Park wird ein Festessen gesucht.

## Verderb {#spoil}

Frisches verdirbt: **rohes Fleisch** nach drei Tagen, **Gekochtes** (Braten, Suppen, Bratwurst, Steak, Schmalzbrot, Festessen) nach fünf, gerechnet in echter Zeit ab dem Schlachten oder Kochen, wo immer es liegt, in der Tasche wie in der Truhe. Dann ist es fort, und wer es trägt, hört es. **Geräuchertes** (Speck, Schinken, Räucherwurst, Trockenfleisch) und **Gepökeltes** hält, ebenso Felle, Leder, Talg und Knochen. Was am Marktbrett hängt, verdirbt nicht.

## Salz und Salzgarten {#salt}

Salz macht Fleisch haltbar und gerbt Felle. Es kommt aus einem **Salzgarten** (ab dem Dorf: 2×2, 4 Stein, 4 Lehm, 2 Treibholz): Daneben harkt \`harke\` (auch \`salz\`) 3 Salz aus den Becken, ohne Werkzeug; danach ruhst du eine Weile wie nach jeder Arbeit. Wilma verkauft auch Salz.

## Gerberei und Lederwaren {#leather}

Die **Gerberei** (ab der Stadt: 2×2, 8 Stein, 6 Bohlen, 4 Ziegel) gerbt Felle mit Salz zu Leder: \`craft leder\` aus 1 Schaffell und 1 Salz, \`craft ziegenleder\` aus 1 Ziegenfell und 1 Salz. Rinder geben ihr Leder schon beim Schlachten und beim Melken. In der Werkstatt wird daraus:

| Ware | aus | wozu |
| --- | --- | --- |
| Ledertasche | 2 Leder, 1 Tangseil, mit Muschelmesser | trägst du sie, nimmst du 250 Last mehr mit (eine zählt, auch wenn du mehrere trägst) |
| Lederstiefel | 3 Leder, mit Muschelmesser | eine Ware für Marta und den Lotsen an der Auftragstafel |

## Knochenmehl als Dünger {#bonemeal}

Knochen vom Schlachten mahlt die **Windmühle** zu **Knochenmehl**, wie Korn zu Mehl (\`mahle knochen\`). \`dünge\` streut 2 Knochenmehl über deinen Acker, solange die Frucht wächst: Die Ernte wird um die Hälfte größer. Einmal je Frucht; nach der Ernte ist der Boden wieder ungedüngt.

## Küken und Ferkel {#young}

Gesa verkauft **Küken** und **Ferkel**, billiger als ausgewachsene Tiere. \`einstallen küken\` bringt eines in deinen Hühnerstall, \`einstallen ferkel\` ins Gehege (zu Schweinen oder in ein leeres). Dort wächst es in **drei Tagen** zu einem Huhn oder Schwein heran und gibt bis dahin nichts; es braucht aber einen Platz im Stall. \`stall\` zeigt, wie viele heranwachsen.

## Festessen und Opfergaben {#feast}

Ein **Festessen** (\`craft festessen\` am Herd einer Hütte aus einem Gänsebraten, einem Schweinebraten, 2 Brot und 2 Bier) macht einen ganzen Tag satt; fürs Erntefest im Park zahlt die Auftragstafel 40 Münzen dafür. An einer **Kapelle** kannst du einen Braten (Gänse-, Lamm-, Schweine- oder Rinderbraten) oder ein Festessen opfern (\`opfere gänsebraten\`), wie eine Perle oder ein Brot: einen Tag lang ruhst du nach der Arbeit nur halb so lange.

## Hund und Katze {#guards}

**Hund** und **Katze** leben nicht im Stall: \`einstallen hund\` lässt ihn an einem deiner Bauten wachen. Satt schützen sie den ganzen Ort, auch die Beete der Nachbarn. Der Hund hält Hasen, Rehe und Füchse fern und frisst Eier, Brot, Käse oder Milch, die Katze hält die Mäuse von den Truhen fern und frisst Milch, Eier oder Käse. Mehr dazu unter [Wild, Zäune und Wächter](help.game.wild#guards).

## Wild aus dem Nebel {#wild}

Wo kein Feuer brennt, kommen **Hasen** an die Beete, **Rehe** an die Äcker, **Füchse** an den Hühnerstall, **Mäuse** an die Truhen und **Möwen** an die Räucherei. \`scheuche hase\` (oder \`reh\`, \`fuchs\`, \`maus\`, \`möwe\`) jagt sie fort, bevor sie fressen. Wie du dich dauerhaft schützt, steht unter [Wild, Zäune und Wächter](help.game.wild).

## Was daraus wird {#products}

Aus Wolle, Daunen, Milch und Wachs werden teurere Waren. Dafür brauchst du den Webstuhl oder eine Hütte.

| Ware | aus | wo |
| --- | --- | --- |
| Tuch (\`craft tuch\`) | 3 Wolle, mit einer Spindel | Webstuhl |
| Daunendecke (\`craft decke\`) | 2 Tuch, 3 Daunen | Webstuhl |
| Käse (\`craft käse\`) | 3 Milch, 1 Treibholz | Hütte |
| 2 Kerzen (\`craft kerze\`) | 2 Wachs, 1 Leinen | Hütte |

Gesa kauft Eier, Wolle, Milch, Daunen, Leder, Honig und Wachs, Marta Tuch, Decken, Käse, Honig, Kerzen und Trüffel.`,
			en: `Animals live in a coop, pen or hive that belongs to you. You feed them, and they give you eggs, milk, wool, down, truffles or honey. These make goods that sell well. Hens and bees work from the start, a pen only in a [village](help.game.village#epochs), cows only in a town.

## All animals {#all}

There are three sorts of animals: farm animals you keep, guards that protect your place, and wild animals that come out of the fog.

| Animal | sort | where | from | gives |
| --- | --- | --- | --- | --- |
| [Hen](help.game.animals#hen) | farm animal | hen house | start | eggs |
| [Duck](help.game.animals#duck) | farm animal | pen | village | eggs |
| [Goose](help.game.animals#goose) | farm animal | pen | village | down, keeps watch |
| [Sheep](help.game.animals#sheep) | farm animal | pen | village | wool |
| [Goat](help.game.animals#goat) | farm animal | pen | village | milk |
| [Pig](help.game.animals#pig) | farm animal | pen | village | truffles |
| [Cow](help.game.animals#cow) | farm animal | pen | town | milk, leather |
| [Bee colony](help.game.animals#bees) | farm animal | hive | start | honey, wax |
| [Dog](help.game.animals#guards) | guard | at one of your buildings | start | keeps hares, deer and foxes away |
| [Cat](help.game.animals#guards) | guard | at one of your buildings | start | keeps mice away |
| [Hare, deer, fox, mouse, gull](help.game.animals#wild) | wild | come out of the fog | – | eat what you grow and keep |

Gesa at the Kupferhafen market sells every farm animal, dogs and cats. You carry an animal like a thing (load 4, a cow 8, dog and cat 2) and can trade it.

## Coop and pen {#house}

Every farm animal needs a home that belongs to you. You build a coop, pen or hive like any other building.

| Building | command | cells | material | work | room for |
| --- | --- | --- | --- | --- | --- |
| hen house | \`bau hühnerstall\` | 2×1 | 4 driftwood, 1 kelp rope | 6 | 6 hens |
| pen | \`bau gehege\` | 3×3 | 8 driftwood, 4 kelp rope | 8 | 4 of one kind |
| hive | \`bau bienenstock\` | 1×1 | 2 driftwood, 2 kelp rope | 4 | 3 colonies |

A pen holds one kind only: sheep, goats, ducks, geese, pigs or cows. \`stable huhn\` puts an animal you carry into your house, \`unstall\` takes one out. \`stall\` shows how they are. You keep up to five coops, pens and hives together (the operator can change it).

## Feeding {#feed}

Animals eat what grows on fields and beds. Anyone may feed them, not just the owner.

\`fodder\` gives feed from your pack (\`fodder 3 oats\` several at once). One feed keeps one animal fed for a day, up to three days ahead.

| Animal | eats | gives while fed |
| --- | --- | --- |
| Hen | kelp, cabbage, carrots, wheat, barley, oats | an egg a day |
| Duck | kelp, cabbage, wheat, barley, oats | an egg a day |
| Goose | barley, oats, cabbage, beets, kelp | down every three days |
| Sheep | beets, oats, barley, cabbage, kelp | wool every other day |
| Goat | beets, oats, barley, cabbage, carrots, kelp | milk a day |
| Pig | potatoes, beets, carrots, cabbage, oats, barley | a truffle every three days |
| Cow | oats, barley, beets, cabbage | milk twice a day, a piece of leather for every four jugs |
| Bee colony | sea pink, dune rose, fog flower, hops | honey every other day, a lump of wax for every three pots |

## What animals give {#yield}

Fed animals give something regularly. Only their owner may collect it.

Hungry animals give nothing until fed again, but they lose nothing. Up to three per animal wait in the house; \`collect\` fetches them, the owner only. Two fed animals of a kind now and then get a young one, until the house is full. If you tear the house down, the animals come back into your pack; if it falls, they wait in the estate. Whoever wants meat slaughters ([slaughtering and cooking](help.game.animals#slaughter)).

## Hen {#hen}

The **hen** is the first farm animal: the hen house is open from the fishing village on. Fed, each hen lays an **egg** a day. Eggs are food (\`eat egg\`), Gesa buys them, and the inn in the harbour quarter asks for them at the job board. Foxes take a hen from the coop at night, never the last; a fence round the coop, fed geese or a dog keep them away ([wild animals](help.game.wild#shelter)).

## Duck {#duck}

The **duck** lives in the pen and lays an **egg** a day like a hen. It eats kelp and grain, a good start when you have no grain for a sheep.

## Goose {#goose}

The **goose** gives **down** every three days. At the loom \`craft decke\` sews a down blanket from 2 cloth and 3 down, which Marta pays well for. Fed **geese** keep watch: in their room no hare gets to the beds and no fox into the coop, they cackle it away.

## Sheep {#sheep}

The **sheep** gives **wool** every other day. At the **loom** (\`bau webstuhl\`: 2×1 cells, 6 driftwood, 2 kelp rope, 8 work) \`craft tuch\` weaves cloth from 3 wool with a spindle.

## Goat {#goat}

The **goat** gives **milk** every day and eats almost anything, carrots and kelp too. At a **hut's** hearth \`craft käse\` makes a cheese from 3 milk and a log of driftwood.

## Pig {#pig}

The **pig** lives in the pen and eats **potatoes** and beets above all, carrots, cabbage and grain as well. It roots up the ground and turns up a **truffle** every three days. Truffles are rare and dear: Marta buys them, and the cook of the inn in the harbour quarter asks for them at the job board. Pigs breed quickly; your pen is soon full.

## Cow {#cow}

The **cow** (\`rind\` or \`kuh\`) comes only once your island is a town. It is heavy (load 8) and wants oats, barley, beets or cabbage. In return it gives **milk** twice a day, twice as much as a goat, and a piece of **leather** comes with every four jugs. A cow rarely has a calf.

## Bees {#bees}

Bees live in a **hive**, from the start. You buy a **bee colony** from Gesa; \`stable bienenvolk\` puts it into your hive.

Bees eat **flowers**: sea pink, dune rose, fog flower and hops, which grow in the [ornamental bed](help.game.garden#bed). \`fodder\` gives them flowers like any animal its feed; one flower keeps a colony fed for a day. Fed, each colony gives a pot of **honey** every other day, and a lump of **wax** comes with every three pots; \`collect\` fetches both. Now and then a strong colony swarms, and a new one moves in until the hive is full.

Honey is food (\`eat honey\`). At a **hut's** hearth \`craft kerze\` makes two candles from 2 wax and 1 linen. Gesa buys honey and wax, Marta honey and candles, and the inn in the harbour quarter asks for honey at the job board.

## Slaughtering and cooking {#slaughter}

You can slaughter farm animals. You cook the meat at a hut's hearth or smoke it in the smokehouse.

\`schlachte\` (or \`schlachte schwein\`) slaughters an animal of your coop or pen beside you. Only the owner of the house may, and you need a knife, which gets blunter each time: a **butcher's knife** (\`craft schlachtmesser\` at the workshop from 2 stone, 1 plank and 1 kelp rope, lasts 20 animals) or a **shell knife** (\`craft muschelmesser\`, lasts 5); carrying both, you use the butcher's knife. With a **butcher's shop** in the place (from the village on: 6 stone, 4 planks, 4 driftwood) every animal gives one piece of meat more. **At the butcher's shop** you also slaughter an animal you carry (taken out with \`unstall\` or bought): \`schlachte huhn\` right beside it, or the right mouse button on the shop; no pair stays there, it has left the herd already. The **last pair** of a kind always stays in the house so the herd lives on: you can slaughter only once a young one has come. Bees, dogs and cats are not slaughtered.

| Animal | gives when slaughtered |
| --- | --- |
| Hen | 1 chicken meat, 2 feathers |
| Duck | 1 duck meat, 2 feathers |
| Goose | 2 goose meat, 2 down, 1 lard |
| Sheep | 3 lamb, 1 sheepskin, 1 tallow, 1 bones |
| Goat | 2 goat meat, 1 goatskin, 1 bones |
| Pig | 3 pork, 2 pork belly, 1 lard, 1 bristles, 1 bones |
| Cow | 4 beef, 1 beef fillet, 2 leather, 2 tallow, 2 bones |

What becomes of it (\`craft <name>\`):

| Dish | from | where | keeps you fed |
| --- | --- | --- | --- |
| roast chicken | 1 chicken meat, 1 driftwood | hut | 8 hours |
| 2 chicken soups | 1 chicken meat, 1 carrot, 1 cabbage, 1 can of water | hut | 8 hours |
| roast duck | 1 duck meat, 1 driftwood | hut | 10 hours |
| roast goose | 2 goose meat, 1 driftwood | hut | 14 hours |
| roast lamb | 2 lamb, 1 driftwood | hut | 12 hours |
| 3 stews | 1 goat meat, 2 potatoes, 1 beet, 1 can of water | hut | 10 hours |
| roast pork | 2 pork, 1 driftwood | hut | 12 hours |
| 3 sausages | 2 pork, with a shell knife | hut | 6 hours |
| 2 steaks | 1 beef fillet, 1 driftwood | hut | 10 hours |
| roast beef | 2 beef, 1 driftwood | hut | 14 hours |
| 2 dripping breads | 1 lard, 1 bread | hut | 6 hours |
| bacon | 1 pork belly, 1 driftwood | smokehouse | 6 hours |
| ham | 2 pork, 1 driftwood | smokehouse | 10 hours |
| 2 smoked sausages | 2 sausages, 1 driftwood | smokehouse | 8 hours |
| 5 sausages (\`craft metzgerwurst\`) | 2 pork, 1 salt, with a butcher's knife | butcher's shop | 6 hours |
| 2 cured meat | 2 pork, 1 salt | butcher's shop | 8 hours |
| 2 dried meat | 2 beef, 1 salt, 1 driftwood | smokehouse | 8 hours |
| feast | 1 roast goose, 1 roast pork, 2 bread, 2 beer | hut | 24 hours |
| 2 tallow candles (candles) | 2 tallow, 1 linen | hut | – |

\`eat roast chicken\` eats it; whoever is fed rests less after work.

**Who buys:** **Wilma**, the butcher at the Kupferhafen market, buys raw meat, skins, leather, tallow, lard and bones and sells sausage, bacon, ham, smoked sausage, roast chicken, cured meat and salt. Marta buys ham, bacon, smoked sausage, cured and dried meat, leather bags and leather boots, Gesa feathers, skins, bristles and tallow, the department store sausage, bacon, ham, roast chicken, salt, cured and dried meat and leather bags. At the job boards the inn in the harbour quarter asks for roast chickens, sausages and a roast goose for a feast, the reef fishers for ham and bacon or cured meat as provisions, the ferry for dried meat, a pilot for leather boots, and the harvest festival in the park wants a feast.

## Spoiling {#spoil}

Fresh food spoils: **raw meat** after three days, **cooked food** (roasts, soups, sausages, steak, dripping bread, the feast) after five, counted in real time from the slaughtering or cooking, wherever it lies, in the pack or in a chest. Then it is gone, and whoever carries it hears so. **Smoked** food (bacon, ham, smoked sausage, dried meat) and **cured** meat keep, and so do skins, leather, tallow and bones. What hangs on a market board does not spoil.

## Salt and the salt garden {#salt}

Salt makes meat keep and tans skins. It comes from a **salt garden** (from the village on: 2×2, 4 stone, 4 clay, 2 driftwood): beside it \`harke\` (also \`salz\`, \`salt\`) rakes 3 salt from the basins, without a tool; then you rest a while as after any work. Wilma sells salt too.

## Tannery and leather goods {#leather}

The **tannery** (from the town on: 2×2, 8 stone, 6 planks, 4 bricks) tans skins with salt into leather: \`craft leder\` from 1 sheepskin and 1 salt, \`craft ziegenleder\` from 1 goatskin and 1 salt. Cows give their leather already when slaughtered and milked. At the workshop it becomes:

| Ware | from | what for |
| --- | --- | --- |
| leather bag | 2 leather, 1 kelp rope, with a shell knife | carrying it, you take 250 load more (one counts, however many you carry) |
| leather boots | 3 leather, with a shell knife | a ware for Marta and the pilot at the job board |

## Bone meal as fertiliser {#bonemeal}

The **windmill** grinds bones from slaughtering into **bone meal**, as it grinds grain into flour (\`mahle knochen\`). \`dünge\` scatters 2 bone meal over your field while its crop grows: the harvest grows by half. Once a crop; after the harvest the soil is unfertilised again.

## Chicks and piglets {#young}

Gesa sells **chicks** and **piglets**, cheaper than grown animals. \`einstallen küken\` puts one in your hen house, \`einstallen ferkel\` in the pen (with pigs or in an empty one). There it grows into a hen or a pig in **three days** and gives nothing until then; but it takes a place in the house. \`stall\` shows how many are growing up.

## Feasts and offerings {#feast}

A **feast** (\`craft festessen\` at a hut's hearth from a roast goose, a roast pork, 2 bread and 2 beer) keeps you fed for a whole day; for the harvest festival in the park the job board pays 40 coins for one. At a **chapel** you can offer a roast (goose, lamb, pork or beef) or a feast (\`opfere gänsebraten\`), like a pearl or a loaf: for one day you rest only half as long after work.

## Dog and cat {#guards}

**Dogs** and **cats** do not live in a coop: \`stable hund\` sets a dog to watch at one of your buildings. Fed, they protect the whole place, the neighbours' beds too. The dog keeps hares, deer and foxes away and eats eggs, bread, cheese or milk; the cat keeps the mice from the chests and eats milk, eggs or cheese. More under [wild animals, fences and guards](help.game.wild#guards).

## Wild animals from the fog {#wild}

Where no fire burns, **hares** come to the beds, **deer** to the fields, **foxes** to the hen house, **mice** to the chests and **gulls** to the smokehouse. \`scare hare\` (or deer, fox, mouse, gull) chases them off before they eat. How to protect yourself for good is under [wild animals, fences and guards](help.game.wild).

## What becomes of it {#products}

Wool, down, milk and wax become dearer goods. For that you need the loom or a hut.

| Good | from | where |
| --- | --- | --- |
| cloth (\`craft tuch\`) | 3 wool, with a spindle | loom |
| down blanket (\`craft decke\`) | 2 cloth, 3 down | loom |
| cheese (\`craft käse\`) | 3 milk, 1 driftwood | hut |
| 2 candles (\`craft kerze\`) | 2 wax, 1 linen | hut |

Gesa buys eggs, wool, milk, down, leather, honey and wax, Marta cloth, blankets, cheese, honey, candles and truffles.`,
		},
	},
	{
		id: "help.game.wild",
		section: "play",
		title: { de: "Wild, Zäune und Wächter", en: "Wild animals, fences and guards" },
		short: {
			de: "Was aus dem Nebel kommt, wie man es verscheucht und wer dauerhaft schützt.",
			en: "What comes out of the fog, how to chase it off and what protects for good.",
		},
		body: {
			de: `Wo kein Feuer brennt, kommen Tiere aus dem Nebel an das, was ihr anbaut und haltet. Sie fressen erst nach einer Weile, du hast also Zeit, sie zu verscheuchen. Dauerhaft helfen Zäune, Vogelscheuchen, Fallen und wachsame Tiere. Das beste Mittel bleibt ein brennendes Feuer.

## Hasen aus dem Nebel {#hares}

Hasen knabbern an den Beeten. Sie kommen nur, wenn das Feuer aus ist.

Wo das Feuer nicht brennt, kommen aus dem Nebel **Hasen** an die Beete: je dichter der Nebel, desto öfter, nachts doppelt so oft, nie mehr als zwei auf einmal in einem Ort. Solange das Feuer brennt, bleibt jeder Hase fort. Ein Hase sitzt eine halbe Weltstunde am Beet, dann frisst er: Eine Pflanze fällt eine Stufe zurück, ein Setzling ist weg. Die letzte lebende Pflanze eines Beets lässt er stehen.

\`scheuche hase\` jagt ihn aus bis zu drei Schritten fort, bevor er frisst; das darf jeder, auch ein Gast, und wer zuerst kommt, rettet das Beet. Dauerhaft schützt ein **Zaun**: \`zäune\` setzt neben dem Beet für **2 Treibholz und 1 Tangseil** einen um dein Beet (oder eins, das du pflegen darfst). Auch eine **Vogelscheuche** (\`bau vogelscheuche\`: 2 Treibholz, 1 Tangseil, 3 Arbeit) hält die Hasen von allen Beeten in bis zu drei Feldern ab; sie steht 40 Tage, dann will sie ausgebessert werden (1 Tang).

## Rehe, Füchse, Mäuse, Möwen {#wild}

Auch größeres Wild kommt aus dem Nebel. Jedes Tier hat sein eigenes Ziel.

- **Rehe** fressen sich an einem wachsenden Acker satt. Jeder Besuch kostet einen Teil der Ernte, aber sie gibt immer gut die Hälfte.
- **Füchse** holen fast nur nachts ein Tier aus dem Hühnerstall, nie das letzte.
- **Mäuse** nagen an Korn, Mehl, Brot, Käse, Bratwurst, Speck, Schinken und Räucherwurst in der Truhe einer Hütte, nie am letzten Stück.
- **Möwen** holen sich bei Tag Fisch, Speck, Schinken, Räucherwurst und Trockenfleisch vom Gestell einer Räucherei (ihrer Truhe), nie das letzte Stück.

Wie die Hasen fressen sie erst nach einer Weile; \`scheuche reh\`, \`scheuche fuchs\`, \`scheuche maus\` oder \`scheuche möwe\` aus bis zu drei Schritten jagt sie fort.

## Schutz {#shelter}

Gegen jedes Tier hilft etwas anderes. Die Tabelle zeigt, was wogegen schützt.

| Schutz | wogegen |
| --- | --- |
| Zaun um den Acker (\`zäune\`: 6 Treibholz, 2 Tangseil) | Rehe |
| Zaun mit Tür um den Hühnerstall (\`zäune\`: 3 Treibholz, 1 Tangseil) | Füchse |
| Vogelscheuche (Beete und Äcker in drei Feldern) | Hasen, Rehe |
| Mausefalle in der Truhe (\`craft mausefalle\`) | Mäuse |
| ein Netz auf dem Gestell der Räucherei (\`verstaue netz\`) | Möwen |
| satte Gänse im Raum | Hasen, Füchse |
| ein satter Hund im Raum | Hasen, Rehe, Füchse |
| eine satte Katze im Raum | Mäuse |

## Hund und Katze {#guards}

Hund und Katze wachen an einem deiner Bauten. Sie schützen den ganzen Ort, auch die Nachbarn.

**Hund und Katze** verkauft Gesa. \`einstallen hund\` lässt ihn an einem deiner Bauten wachen (einer je Bau), \`ausstallen hund\` nimmt ihn wieder mit. Satt hält er sein Wild aus dem ganzen Raum fern, also auch von den Beeten und Fluren der Nachbarn. \`füttere hund\` (jeder darf) macht ihn mit einem Ei, Brot, Käse oder Milch einen Tag satt, bis zu drei Tage im Voraus; eine Katze frisst Milch, Eier und Käse. \`wache\` zeigt, wer im Raum wacht.`,
			en: `Where no fire burns, animals come out of the fog to what you grow and keep. They eat only after a while, so you have time to chase them off. Fences, scarecrows, traps and watchful animals help for good. A burning fire remains the best means.

## Hares from the fog {#hares}

Hares nibble at the beds. They come only while the fire is out.

Where the fire does not burn, **hares** come out of the fog to the beds: the thicker the fog, the more often, twice as often at night, never more than two at once in one place. While the fire burns, every hare stays away. A hare sits at the bed for half a world hour, then it eats: one plant falls back a stage, a seedling is gone. It leaves the bed's last living plant standing.

\`scheuche hase\` (\`scare\`) chases it off from up to three cells before it eats; anyone may, a guest too, and whoever comes first saves the bed. A **fence** protects for good: \`zäune\` (\`fence\`) beside the bed puts one round your bed (or one you may tend) for **2 driftwood and 1 kelp rope**. A **scarecrow** (\`bau vogelscheuche\`: 2 driftwood, 1 kelp rope, 3 work) keeps the hares from every bed within three cells too; it stands 40 days, then it wants repairing (1 kelp).

## Deer, foxes, mice, gulls {#wild}

Bigger wild animals come out of the fog too. Each has a target of its own.

- **Deer** graze a growing field. Each visit costs part of the harvest, but it always gives a good half.
- **Foxes** take an animal from a coop, almost only at night, never the last.
- **Mice** gnaw at grain, flour, bread, cheese, sausage, bacon, ham and smoked sausage in a hut's chest, never the last piece.
- **Gulls** take fish, bacon, ham, smoked sausage and dried meat from a smokehouse's rack (its chest) by day, never the last piece.

Like the hares they eat only after a while; \`scheuche reh\`, \`scheuche fuchs\`, \`scheuche maus\` or \`scheuche möwe\` from up to three cells chases them off.

## Shelter {#shelter}

Each animal has its own remedy. The table shows what protects against what.

| Shelter | against |
| --- | --- |
| A fence round the field (\`zäune\`: 6 driftwood, 2 kelp rope) | deer |
| A fence with a door round the coop (\`zäune\`: 3 driftwood, 1 kelp rope) | foxes |
| A scarecrow (beds and fields within three cells) | hares, deer |
| A mousetrap in the chest (\`craft mausefalle\`) | mice |
| A net on the smokehouse's rack (\`verstaue netz\`) | gulls |
| Fed geese in the room | hares, foxes |
| A fed dog in the room | hares, deer, foxes |
| A fed cat in the room | mice |

## Dog and cat {#guards}

A dog or cat keeps watch at one of your buildings. They protect the whole place, the neighbours too.

Gesa sells **dogs and cats**. \`stable hund\` leaves one on guard at a building of yours (one per building), \`unstall hund\` takes it along again. Fed, it keeps its wild from the whole room, the neighbours' beds and fields too. \`fodder hund\` (anyone may) feeds it for a day with an egg, bread, cheese or milk, up to three days ahead; a cat eats milk, eggs and cheese. \`wache\` shows who keeps watch in the room.`,
		},
	},
	{
		id: "help.game.village",
		section: "play",
		title: { de: "Dorf und Siedlung", en: "Village and settlement" },
		short: {
			de: "Wie eine Insel zum Dorf und zur Stadt wird, wie Nachbarn eine Siedlung gründen und wie man reist.",
			en: "How an island becomes a village and a town, how neighbours found a settlement and how to travel.",
		},
		body: {
			de: `Eine Insel wächst durch das, was auf ihr steht. Sind genug Hütten, Beete und Felder da, wird aus dem Fischerdorf ein Dorf, und neue Baupläne öffnen sich. Nachbarn können außerdem eine Siedlung gründen. Sie bestimmen dann gemeinsam, wer an ihrem Ort bauen darf.

## Epochen {#epochs}

Jede Insel hat eine eigene Stufe. Es zählt, was noch steht und gepflegt wird. Du siehst die Stufe mit \`epoche\` und in der Kopfzeile als „Epoche: x“.

Jede Insel steht auf einer Stufe: **Fischerdorf**, **Dorf**, **Stadt**, **Netz**. Sie zählt ihren gehaltenen Bestand, jeden Bau, jedes Beet und jeden Acker, die noch stehen, mit so vielen Punkten, wie sie vom Licht eines Feuers nehmen. Beete zählen so viel wie Bauten: Hütte, Beet, Hühnerstall, Regentonne, Vogelscheuche und Webstuhl je 1 Punkt, Acker, Gemeinschaftsbeet, Windmühle, Backhaus und Gehege je 2.

| Stufe | ab Punkten | neu |
| --- | --- | --- |
| Fischerdorf | 0 | Hütte, Hühnerstall, Regentonne, Vogelscheuche, Steg, Räucherei, Beete |
| Dorf | 15 | Windmühle, Backhaus, Gehege, Webstuhl, Lagerhaus, Steinbruch, Lehmgrube, Ziegelei, Werkstatt, Kapelle, Straße, Äcker, Metzgerei, Salzgarten |
| Stadt | 40 | Rathaus, Park, Kaufhaus, Kontor, Leuchtturm, Brauerei, Glashütte, Werft, Gewächshaus, Gerberei, Rinder |
| Netz | 80 | Bahnhof, Signalfeuer, Beamen |

Die Schwellen kann der Betreiber ändern, etwa für einen Server mit wenigen Spielern. Gezählt wird jede Weltstunde; ändert sich die Stufe, hören es alle Räume der Insel. Verfällt zu viel, fällt die Insel zurück: was steht, arbeitet weiter (die Mühle mahlt, das Backhaus backt), nur neue Pläne der höheren Stufe warten, bis der Bestand wieder reicht. \`epoche\` zeigt Stufe und Punkte der Insel, auf der du stehst.

## Siedlung gründen {#settlement}

Eine Siedlung ist eine Gemeinschaft an einem Ort, mit Namen und eigenen Regeln. Sie entsteht, wenn dort genug Nachbarn Hütten gebaut haben. Der Boden gehört weiter niemandem, und jeder Bau bleibt bei seinem Besitzer.

Stehen in einem Raum **drei Hütten von mindestens zwei Besitzern**, gründet \`siedlung gründen <name>\` eine Siedlung. Das darf, wer dort eine Hütte hat; Gäste nicht. Der Name hat 2 bis 30 Buchstaben und darf noch nicht vergeben sein. Je Raum gibt es eine Siedlung. \`siedlung\` zeigt die Siedlung hier, ihre Hütten und wer dazugehört; wo keine ist, wie viele Hütten noch fehlen.

Stehen zu wenige Hütten, endet die Siedlung von selbst, und ihr Name ist wieder frei. Was dort steht, bleibt.

## Ränge {#ranks}

In einer Siedlung hat jeder einen Rang. Wer dort eine Hütte hat, ist von selbst Siedler. Alle anderen können aufgenommen werden.

| Rang | Wer | darf, wenn die Siedlung geschlossen ist |
| --- | --- | --- |
| Siedler | Hüttenbesitzer, und wen ein Siedler aufnimmt | bauen, Beete und Äcker anlegen, liefern, mitarbeiten |
| Helfer | wen ein Siedler als Helfer aufnimmt; ein Gast ist höchstens Helfer | liefern, mitarbeiten |
| Fremder | alle anderen | nichts davon |

\`siedlung aufnehmen <name>\` nimmt jemanden als Siedler auf, \`siedlung aufnehmen <name> helfer\` als Helfer, \`siedlung entlassen <name>\` nimmt das zurück. Das entscheiden nur Siedler. Hüttenbesitzer lassen sich nicht entlassen.

## Offen oder zu {#door}

Eine neue Siedlung ist offen, jeder darf dort bauen und helfen. Sie kann ihre Tür aber schließen. Dann gelten die Ränge.

\`siedlung zu\` schließt die Siedlung, \`siedlung offen\` öffnet sie wieder; beides dürfen nur Siedler. Was schon steht, bleibt, wem es gehört, und betreten darf den Ort jeder. Die Regeln betreffen neue Baustellen, Beete und Äcker sowie Liefern und Mitarbeiten an Baustellen.

## Rathaus und Steuer {#townhall}

Steht ein Rathaus (ab Stadt) in der Siedlung, entscheiden die Siedler gemeinsam. Am Rathaus stellt ein Siedler mit \`antrag\` einen Antrag, je Raum einer auf einmal; jeder Siedler stimmt mit \`stimme ja\` oder \`stimme nein\`, die letzte Stimme zählt. Nach einem Welttag gilt der Antrag, wenn mehr Ja als Nein kamen. Mit Rathaus gehen \`siedlung zu\` und \`offen\` nur noch über einen Antrag.

\`antrag grünzone\` und \`antrag wegerecht\` gelten für 7×7 Felder um dich: In einer Grünzone stehen nur Beete und Parks, auf einem Wegerecht nichts Neues. \`antrag abriss\` stimmt über den Bau neben dir ab; die Hälfte des Materials wartet als Nachlass auf den Besitzer. \`antrag steuer <n>\` (höchstens 5) setzt die Münzen je Stück, die man aus dem Lagerhaus nimmt und im Kaufhaus der Siedlung kauft; sie gehen ins Lagerhaus.

## Kaufhaus und Kontor {#store}

Ein Kaufhaus (ab Stadt) handelt auch, wenn niemand am Marktbrett steht. \`laden\` zeigt Regal und Preise: Leeres ist teuer, bei zehn Stück kostet es die Hälfte. \`laden kaufe <ding>\` und \`laden verkaufe <ding>\` handeln, das Kaufhaus zahlt 70 % aus seiner Kasse. Der Besitzer füllt sie mit \`laden einlegen <n>\` und nimmt mit \`laden entnehme <n>\`. Sein Umsatz zählt im Rang der Siedlung, ein Punkt je 20 Münzen.

Mit \`laden bestelle <n> <ding> für <m>\` bestellt der Besitzer Ware, höchstens 3 Bestellungen zu je 20 Stück. Sie stehen auf allen Auftragstafeln der Gegend. Jeder andere bringt sie mit \`laden liefere <ding>\` und bekommt m Münzen je Stück aus der Kasse; \`laden storniere <ding>\` zieht eine Bestellung zurück. Die versprochenen Münzen sind reserviert.

Im Kontor leiht \`kredit <n> gegen <ding>\` Münzen gegen ein Pfand, bis zum doppelten Grundpreis. \`tilge\` zahlt binnen sieben Tagen mit einem Zehntel Zinsen zurück, sonst gehört das Pfand dem Kontor. \`wechsel <n>\` legt dort n Münzen in einen **Wechsel** (eine Münze behält das Kontor): Die Münzen liegen im Papier selbst, es lässt sich weitergeben, verkaufen und in andere Regionen mitnehmen, und jedes Kontor zahlt es mit \`wechsel einlösen\` aus.

## Boote, Schiff, Bahn, Karren, Beamen {#travel}

- **Ruderboot** (Werkstatt): \`rudere <ort>\` fährt von Steg zu Steg einer Insel.
- **Segelboot** (Werft, ab Stadt): \`segle <insel>\` fährt vom Steg in die Bucht jeder Insel, auch in eine andere Gegend.
- **Luke**: Jedes Boot hat eine. Am Steg lädt \`luke lade [n|alle] <ding>\` ein, 8 Dinge im Ruderboot, 20 im Segelboot; \`luke entlade alle\` holt sie heraus. Die Ladung fährt mit dem Boot.
- **Großes Schiff**: Es fährt nur von Insel zu Insel, von Bucht zu Bucht, und es ist eines: eine Runde über alle Inseln, in jeder Bucht liegt es eine Weile. Du siehst es einlaufen und ablegen; auf der [Weltkarte](help.game.controls#atlas) zeigen eine gestrichelte Linie seine Route und eine Marke, wo es gerade fährt. \`fahrplan\` sagt, wo es ist und wann es hier liegt. \`einschiffen <insel>\` geht für 3 Münzen an Bord, solange es hier liegt: Du fährst mit, bis es die Insel erreicht hat, und gehst dort von Bord. Du musst nicht bis zum Ende fahren: Oben steht an Bord **Beim nächsten Halt aussteigen** mit dem Namen der nächsten Insel auf der Fahrt und wann das Schiff dort liegt (oder \`ausschiffen nächster\`); liegt es gerade dort, heißt es **Hier aussteigen**. An Bord gehst du nicht umher, du kannst dich aber umsehen und reden.
- **Inselbahn** (ab Netz): Ein Raum hat höchstens einen Bahnhof. Neben ihm fährt \`zug <ort>\` für eine Münze zu jedem anderen Bahnhof derselben Insel. Zwischen den Bahnhöfen liegen Gleise, die du auf der Karte siehst; sie versperren niemandem den Weg. Alle 20 Weltminuten steht der Zug zehn Minuten am Bahnsteig, nur dann fährt er. \`zug sende [n|alle] <ding> nach <ort>\` gibt bis zu 20 Dinge für eine Münze als Fracht auf, \`zug abholen\` holt sie am Ziel; was sieben Tage liegt oder dessen Bahnhof fällt, wird dein Nachlass. Die Bahn verlässt ihre Insel nicht.
- **Signalfeuer** (ab Netz): ein kleiner Bau, einer je Raum. Signalfeuer in Räumen nebeneinander, auch über eine Fähre zur Nachbarinsel, die im Licht von wenigstens zwei Feuern stehen, bilden eine Kette. Solange jedes dieser Feuer brennt, teilen sie ihr Licht: du baust im Licht jedes Feuers der Kette, wo immer eines von ihnen hinreicht. Geht eines aus, ist die Kette unterbrochen. \`signalfeuer\` zeigt die Ketten deiner Insel und welche Insel dieser Gegend ihre Kette am längsten ohne Unterbrechung brennen ließ.
- **Straße und Karren** (ab Dorf): Eine Straße nahe einem Ausgang verbindet seine beiden Räume. Einen **Karren** stellst du direkt neben einer Werkstatt her (\`craft karren\`): aus 4 Bohlen und 1 Tauwerk, also 8 Treibholz und 9 Tang mit einem Muschelmesser; kaufen kann man ihn nicht. Mit \`karren stelle\` steht er auf der Straße. Ein Karren fährt auf Straßen allein mit bis zu 20 Stück, einen Raum je Weltstunde: \`karren lade\`, \`karren fahre <ort>\`, \`karren entlade\`. \`karren pendel <ort> [mit <ding>]\` lässt ihn von selbst zwischen zwei Orten fahren, an denen dir ein Bau mit Truhe gehört: Hier lädt er aus deiner Truhe, dort legt er alles in deine Truhe und kommt zurück, leer fährt er nicht; \`karren halt\` beendet es. Über das Wasser kommt ein Karren nur als Ding (\`karren nimm\`).
- **Beamen** (ab Netz): \`beam <ort>\` springt von jedem Ort zu einem brennenden Feuer, ohne die Wege zu laufen. Nur das Ziel braucht ein brennendes Feuer, dein Standort nicht. Es kostet Münzen nach der Entfernung auf der [Weltkarte](help.game.controls#atlas), standardmäßig eine je Feld (mindestens eine); danach ruhst du 10 Weltminuten, bevor du wieder beamst. \`beam\` allein zeigt die Ziele und die Pause. Auf der Weltkarte tippst du das Feuer an, die Linie und der Preis erscheinen, **Hierher beamen** springt. Betreiber ändern Preis, Pause und Stufe.

Ein **Leuchtturm** (ab Stadt) gibt seinem Feuer 20 Lichtpunkte mehr, über die Grenze von 40 hinaus, und trägt dessen Licht in die Räume gleich neben seinem, auf derselben Insel: Dort baut man dann im Licht beider Feuer, und der Nebel weicht, solange eines brennt.`,
			en: `An island grows by what stands on it. With enough huts, beds and fields the fishing village becomes a village, and new building plans open up. Neighbours can also found a settlement. Together they then decide who may build in their place.

## Epochs {#epochs}

Every island has a stage of its own. What counts is what still stands and is looked after. \`epoche\` and the header (“Epoche: x”) show the stage.

Every island stands at a stage: **fishing village**, **village**, **town**, **net**. It counts its held stock, every building, bed and field still standing, with as many points as each takes of a fire's light. Beds count as much as buildings: hut, bed, hen house, rain barrel, scarecrow and loom 1 point each, field, community bed, windmill, bakery and pen 2 each.

| Stage | from points | new |
| --- | --- | --- |
| Fishing village | 0 | hut, coop, rain barrel, scarecrow, jetty, smokehouse, beds |
| Village | 15 | windmill, bakery, pen, loom, warehouse, quarry, clay pit, brickworks, workshop, chapel, road, fields, butcher's shop, salt garden |
| Town | 40 | town hall, park, department store, counting house, lighthouse, brewery, glassworks, shipyard, greenhouse, tannery, cattle |
| Net | 80 | station, signal fire, beaming |

The operator can change the thresholds, say for a server with few players. The count runs every world hour; when the stage changes, every room of the island hears it. If too much decays, the island falls back: what stands goes on working (the mill grinds, the bakery bakes), only new plans of the higher stage wait until the stock is enough again. \`epoche\` shows the stage and points of the island you stand on.

## Founding a settlement {#settlement}

A settlement is a community in one place, with a name and rules of its own. It comes about when enough neighbours have built huts there. The ground still belongs to nobody, and every building stays with its owner.

When **three huts of at least two owners** stand in a room, \`settlement gründen <name>\` founds a settlement. Whoever has a hut there may do it; guests may not. The name has 2 to 30 letters and must not be taken yet. Each room has one settlement. \`settlement\` shows the settlement here, its huts and who belongs; where there is none, how many huts are still missing.

If too few huts stand, the settlement ends by itself and its name is free again. What stands there stays.

## Ranks {#ranks}

In a settlement everyone has a rank. Whoever has a hut there is a settler by themselves. Everyone else can be taken in.

| Rank | Who | may, when the settlement is closed |
| --- | --- | --- |
| Settler | hut owners, and whom a settler takes in | build, lay out beds and fields, deliver, help |
| Helper | whom a settler takes in as a helper; a guest is a helper at most | deliver, help |
| Stranger | everyone else | none of that |

\`settlement aufnehmen <name>\` takes someone in as a settler, \`settlement aufnehmen <name> helfer\` as a helper, \`settlement entlassen <name>\` reverses it. Only settlers decide that. Hut owners cannot be dismissed.

## Open or closed {#door}

A new settlement is open: anyone may build and help there. But it can close its door. Then the ranks count.

\`settlement zu\` closes the settlement, \`settlement offen\` opens it again; only settlers may do either. What already stands stays with its owner, and anyone may enter the place. The rules cover new sites, beds and fields, and delivering and working at sites.

## Town hall and tax {#townhall}

When a town hall (from the town on) stands in the settlement, the settlers decide together. At the town hall a settler puts a motion with \`antrag\`, one per room at a time; every settler votes with \`stimme ja\` or \`stimme nein\`, and the last vote counts. After a world day the motion carries if there were more yes than no. With a town hall, \`siedlung zu\` and \`offen\` go only through a motion.

\`antrag grünzone\` and \`antrag wegerecht\` cover 7×7 cells around you: a green zone holds only beds and parks, a right of way nothing new. \`antrag abriss\` puts the building beside you to the vote; half of its material waits for the owner as an estate. \`antrag steuer <n>\` (5 at most) sets the coins per piece taken from the warehouse and bought at the settlement's department store; they go into the warehouse.

## Department store and counting house {#store}

A department store (from the town on) trades even when nobody stands at the market board. \`laden\` shows shelf and prices: what is scarce is dear, at ten pieces a thing costs half. \`laden kaufe <ding>\` and \`laden verkaufe <ding>\` trade, and the store pays 70 % from its till. The owner fills it with \`laden einlegen <n>\` and takes from it with \`laden entnehme <n>\`. Its turnover counts in the settlement's rank, a point per 20 coins.

With \`laden bestelle <n> <ding> für <m>\` the owner orders goods, 3 orders of up to 20 pieces at most. They appear on every order board of the region. Anyone else brings them with \`laden liefere <ding>\` and gets m coins a piece from the till; \`laden storniere <ding>\` withdraws an order. The coins promised are reserved.

In a counting house \`kredit <n> gegen <ding>\` lends coins against a pledge, up to twice its base price. \`tilge\` pays back within seven days with a tenth of interest; otherwise the pledge goes to the house. \`wechsel <n>\` puts n coins into a **bill of exchange** there (the house keeps one coin): the coins lie in the paper itself, it can be passed on, sold and taken to other regions, and any counting house pays it out with \`wechsel einlösen\`.

## Boats, ship, railway, carts, beaming {#travel}

- **Rowing boat** (workshop): \`rudere <ort>\` goes from jetty to jetty of an island.
- **Sailing boat** (shipyard, from the town on): \`segle <insel>\` goes from a jetty to the bay of any island, to another region too.
- **Hatch**: every boat has one. At a jetty \`luke lade [n|alle] <ding>\` loads it, 8 things in a rowing boat, 20 in a sailing boat; \`luke entlade alle\` takes them out. The cargo goes with the boat.
- **Large ship**: it sails only from island to island, from bay to bay, and there is one: a loop over all islands, it lies a while in each bay. You see it run in and cast off; on the [world map](help.game.controls#atlas) a dashed line shows its route and a mark where it is now. \`fahrplan\` says where it is and when it lies here. \`einschiffen <island>\` boards for 3 coins while it lies here: you sail with it until it reaches the island and go ashore there. You need not sail to the end: aboard, **Beim nächsten Halt aussteigen** at the top names the next island on the way and when the ship lies there (or \`ausschiffen nächster\`); while it lies there, it says **Hier aussteigen**. Aboard you do not walk about, but you can look around and talk.
- **Island railway** (from the network on): a room has one station at most. Beside it \`zug <ort>\` goes for a coin to any other station of the same island. Tracks lie between the stations, and you see them on the map; they block nobody's way. Every 20 world minutes the train stands at the platform for ten minutes, and only then does it go. \`zug sende [n|alle] <ding> nach <ort>\` sends up to 20 things for a coin as freight, \`zug abholen\` fetches them at the other end; what lies seven days, or whose station falls, becomes your estate. The railway does not leave its island.
- **Signal fire** (from the network on): a small building, one to a room. Signal fires in rooms next to each other, also across a ferry to the next island, that stand in the light of at least two fires form a chain. While each of those fires burns, they share their light: you build in the light of any fire of the chain wherever one of them reaches. When one goes out, the chain is broken. \`signalfeuer\` shows the chains of your island and which island of this region kept its chain burning longest without a break.
- **Road and cart** (from the village on): a road near an exit links its two rooms. You make a **cart** right beside a workshop (\`craft karren\`): from 4 planks and 1 rope, so 8 driftwood and 9 kelp with a shell knife; nobody sells one. \`karren stelle\` puts it on the road. A cart goes alone on roads with up to 20 pieces, a room per world hour: \`karren lade\`, \`karren fahre <ort>\`, \`karren entlade\`. \`karren pendel <ort> [mit <ding>]\` sends it back and forth by itself between two places where you own a building with a chest: here it loads from your chest, there it puts everything into your chest and comes back, never empty; \`karren halt\` ends it. A cart crosses the water only as a thing (\`karren nimm\`).
- **Beaming** (from the network on): \`beam <place>\` jumps from anywhere to a burning fire without walking the paths. Only the destination needs a burning fire, not where you stand. It costs coins by the distance on the [world map](help.game.controls#atlas), by default one per cell (at least one); afterwards you rest 10 world minutes before you beam again. \`beam\` alone lists the destinations and the rest. On the world map you tap the fire, the line and the price appear, **Hierher beamen** jumps. Operators change price, rest and stage.

A **lighthouse** (from the town on) gives its fire 20 more light points, above the limit of 40, and carries its light into the rooms right beside its own on the same island: there one builds in the light of both fires, and the fog gives way while either burns.`,
		},
	},
	{
		id: "help.game.chat",
		section: "play",
		title: { de: "Chat zwischen Spielern", en: "Chat between players" },
		short: {
			de: "Gespräche zu zweit und in Gruppen, Ende-zu-Ende verschlüsselt, über alle Inseln.",
			en: "Talks between two and in groups, end-to-end encrypted, across all islands.",
		},
		body: {
			de: `Im Chat schreibst du mit einzelnen Leuten oder einer kleinen Gruppe, auch über die Inseln hinweg. Nur ihr könnt mitlesen. Vor dem ersten Gespräch richtest du einmal ein eigenes Passwort ein.

\`say\` hört nur der Raum, \`kanal hafen\` alle. Der **Chat** ist das Gespräch zu zweit oder in einer Gruppe, auch mit jemandem auf einer anderen Insel.

## Einrichten {#setup}

Im Reiter **„Chats“** neben den Ereignissen richtest du den Chat mit einem eigenen **Chat-Passwort** ein. Es ist nicht dein Login-Passwort und geht nie an den Server; mit ihm entsperrst du den Chat auch an einem anderen Gerät.

**Vergisst du das Chat-Passwort, sind deine Verläufe verloren.** Niemand kann sie wiederherstellen. Schreibt dir jemand, bevor du den Chat eingerichtet hast, sagt dir das Spiel Bescheid; die Nachrichten kommen an, sobald du ihn eingerichtet hast und die Seite des Absenders einmal entsperrt offen war. Sie warten bis zu 7 Tage. **„Verlauf sichern“** speichert die geöffneten Gespräche als Textdatei. Das Passwort lässt sich ändern, solange du es kennst.

## Zu zweit {#two}

Ein Gespräch zu zweit beginnt mit einem Befehl oder einem Rechtsklick auf eine Figur. Der andere muss dafür nicht in deiner Nähe sein.

\`chat <name> <text>\` (auch \`tell\`, \`flüstere\`) schreibt jemandem; \`chat <name>\` öffnet nur das Gespräch. Oder die rechte Maustaste (langes Tippen) auf eine Figur, auf einen Namen in den Ereignissen oder in der Liste von \`who\`: **„Chat mit …“**. Jedes Gespräch hat einen eigenen Reiter mit Zähler für Ungelesenes.

Ist der andere nicht da, wartet die Nachricht **sieben Tage** und erscheint bei seinem nächsten Anmelden (die letzten 50 je Gespräch). Mit NPCs sprichst du mit \`say\`, nicht im Chat.

## Gruppen {#groups}

Eine Gruppe ist ein gemeinsames Gespräch für mehrere Leute. Wer sie gründet, verwaltet sie.

| Befehl | Wirkung |
| --- | --- |
| \`gruppe neu <name>\` | Eine Gruppe gründen; du verwaltest sie |
| \`gruppe lade <spieler> in <gruppe>\` | Einladen (jedes Mitglied darf; die Einladung gilt 24 Stunden) |
| \`gruppe annehmen <gruppe>\` / \`gruppe ablehnen <gruppe>\` | Eine Einladung annehmen oder ablehnen (auch im Reiter „Chats“) |
| \`gruppe <gruppe> <text>\` | In die Gruppe schreiben (oder im Reiter der Gruppe) |
| \`gruppe verlasse <gruppe>\` | Austreten |
| \`gruppe entferne <spieler> aus <gruppe>\` | Jemanden entfernen (nur wer verwaltet) |
| \`gruppe\` | Deine Gruppen |

Höchstens 20 Mitglieder je Gruppe, höchstens zehn gegründete Gruppen je Konto. Gäste chatten, gründen aber keine Gruppe und laden niemanden ein.

## Verschlüsselung {#e2e}

Nur die Mitglieder eines Gesprächs können es lesen, nicht der Server und kein Admin. Jede Nachricht wird im Browser für jeden Leser einzeln versiegelt. Jedes Gespräch zeigt den **Fingerabdruck** beider Schlüssel: Vergleicht ihr sie außerhalb des Spiels, wisst ihr, dass niemand dazwischen sitzt. Der Server sieht trotzdem, wer mit wem wann schreibt, und Gruppennamen und Mitglieder.

## Schutz {#safety}

Du entscheidest, wer dich erreicht. Wer stört, lässt sich sperren oder melden.

\`ignoriere <name>\` sperrt Nachrichten und Einladungen eines Spielers, \`erlaube <name>\` hebt es auf, \`ignoriere\` allein listet die Gesperrten. **Melden** an einer Nachricht schickt ihren Text mit Absender an die Admins (sie bleibt dort 30 Tage); sonst sehen Admins keine Gespräche. Gespräche erscheinen nie in den Ereignissen des Raums.`,
			en: `In the chat you write with single people or a small group, also across the islands. Only you can read along. Before the first talk you set up a password of its own once.

\`say\` is heard by the room only, \`channel hafen\` by everyone. The **chat** is the talk between two or in a group, also with someone on another island.

## Setting up {#setup}

In the **“Chats”** tab beside the log you set up the chat with a **chat password** of its own. It is not your login password and never reaches the server; with it you unlock the chat on another device too.

**Forget the chat password and your history is lost.** Nobody can restore it. **“Save history”** stores the open talks as a text file. You can change the password as long as you know it.

## Between two {#two}

A talk between two starts with a command or a right click on a figure. The other person need not be near you.

\`chat <name> <text>\` (also \`tell\`, \`whisper\`) writes to someone; \`chat <name>\` only opens the talk. Or right-click (long press) a figure, a name in the events or in the list of \`who\`: **“Chat with …”**. Every talk has its own tab with a count of unread lines.

If the other is away, the message waits **seven days** and appears at their next sign-in (the last 50 per talk). You talk to NPCs with \`say\`, not in the chat.

## Groups {#groups}

A group is a shared talk for several people. Whoever founds it manages it.

| Command | Effect |
| --- | --- |
| \`group neu <name>\` (\`group\`) | Found a group; you manage it |
| \`group lade <player> in <group>\` | Invite (any member may; the invitation lasts 24 hours) |
| \`group annehmen <group>\` / \`group ablehnen <group>\` | Accept or decline an invitation (also in the “Chats” tab) |
| \`group <group> <text>\` | Write to the group (or in the group's tab) |
| \`group verlasse <group>\` | Leave |
| \`group entferne <player> aus <group>\` | Remove someone (only who manages it) |
| \`group\` | Your groups |

At most 20 members per group, at most ten groups founded per account. Guests chat but found no group and invite nobody.

## Encryption {#e2e}

Only the members of a talk can read it, not the server and no admin. Each message is sealed in the browser for every reader separately. Every talk shows the **fingerprint** of both keys: compare them outside the game and you know nobody sits in between. The server still sees who writes to whom and when, and group names and members.

## Safety {#safety}

You decide who reaches you. Anyone who bothers you can be blocked or reported.

\`ignoriere <name>\` (\`ignore\`) blocks a player's messages and invitations, \`erlaube <name>\` (\`unignore\`) lifts it, \`ignoriere\` alone lists whom you block. **Report** on a message sends its text with the sender to the admins (it stays there 30 days); otherwise admins see no talks. Talks never appear in the room's log.`,
		},
	},
	{
		id: "help.game.account",
		section: "play",
		title: { de: "Gast und Konto", en: "Guest and account" },
		short: {
			de: "Was ein Gast darf, wie man sich registriert und was dabei erhalten bleibt.",
			en: "What a guest may do, how to register and what is kept.",
		},
		body: {
			de: `## Gast {#guest}

Als **Gast** spielst du sofort, ohne Konto. Vieles geht schon, manches braucht ein Konto.

Du kannst laufen, sammeln, das Feuer nachlegen, reden, chatten, an Baustellen mitbauen und alles ansehen. Auch als Pate, am Gemeinschaftsbeet und auf offenen Äckern darfst du helfen. **Nicht möglich:** tauschen, handeln, Dinge weitergeben, selbst bauen oder besitzen, Aufträge nehmen, Chat-Gruppen oder Siedlungen gründen. In einer Siedlung bist du höchstens Helfer. Eine Gastfigur verfällt nach einigen Tagen ohne Spiel.

## Konto {#account}

Mit **„Registrieren, um den Fortschritt zu behalten“** in der Kopfzeile legst du ein Konto an (Benutzername und Passwort). Dabei bleiben **Figur, Gegenstände und Ruf** erhalten, du fängst nicht von vorn an. Danach kannst du dich jederzeit mit denselben Daten anmelden, auch an einem anderen Gerät.

## Abmelden {#logout}

Abmelden beendet nur die Sitzung. Mit einem Konto kommst du jederzeit zurück.

„Abmelden“ beendet die Sitzung. Als Gast fragt das Spiel vorher, ob du dich erst registrieren möchtest, weil du sonst nicht zu dieser Figur zurückkommst.

## Datenschutz {#privacy}

Das Spiel speichert nur, was es braucht. Dein Passwort liegt nie im Klartext vor.

Gespeichert sind Benutzername, ein gesalzener Passwort-Hash, deine Figur und ihr Fortschritt. Für den Chat kommen dein öffentlicher Schlüssel, eine mit dem Chat-Passwort versiegelte Sicherung des privaten Schlüssels und versiegelte Nachrichten (sieben Tage) dazu. Der Server sieht dabei, wer mit wem wann schreibt, aber keinen Text; nur eine gemeldete Nachricht geht lesbar an die Admins ([Verschlüsselung](help.game.chat#e2e)). Alle Texte der Welt werden als reiner Text angezeigt, nie als Code ausgeführt.`,
			en: `## Guest {#guest}

As a **guest** you play at once, without an account. Much works already, some things need an account.

You can walk, collect, feed the fire, talk, chat, help at building sites and look at everything. You may also help as a sponsor, at a community bed and on open fields. **Not possible:** swapping, trading, handing things on, building or owning yourself, taking jobs, founding chat groups or settlements. In a settlement you are a helper at most. A guest character lapses after some days without play.

## Account {#account}

With **“Register to keep your progress”** in the header bar you create an account (user name and password). Your **character, items and reputation** are kept; you do not start over. Afterwards you can sign in with the same details at any time, also on another device.

## Logging out {#logout}

Logging out only ends the session. With an account you can come back at any time.

“Log out” ends the session. As a guest the game asks first whether you want to register, because otherwise you will not get back to that character.

## Privacy {#privacy}

The game stores only what it needs. Your password is never kept in plain text.

It stores your user name, a salted password hash, your character and its progress. The chat adds your public key, a backup of your private key sealed with the chat password, and sealed messages (seven days). The server sees who writes to whom and when, but no text; only a reported message reaches the admins readable ([Encryption](help.game.chat#e2e)). All text of the world is shown as plain text and never executed as code.`,
		},
	},
];

export const articleById = (id: string): Article | undefined => ARTICLES.find((a) => a.id === id);

export function tocOf(markdown: string): { id: string; title: string }[] {
	return [...markdown.matchAll(/^##\s+(.+?)\s+\{#([a-z0-9._-]+)\}\s*$/gm)].map((m) => ({ title: m[1]!, id: m[2]! }));
}
