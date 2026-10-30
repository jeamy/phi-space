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

Leuchtfeuer ist eine **Mehrspielerwelt im Browser**: ein Archipel kleiner Inseln, dauerhaft im Nebel. Wo ein Leuchtfeuer brennt, ist der Nebel licht, und man kann sich frei bewegen, sammeln und handeln. Wo es erlischt, rückt der Nebel vor und verschluckt die Wege.

Du spielst eine Figur auf einer **Karte** (oder nur mit **Text**, wie in einem MUD). Alles, was du tust, ist ein Textbefehl: ein Klick auf die Karte ist \`move x y\`, ein Druck auf die Leertaste ist \`get …\`. Wer lieber tippt, kommt mit denselben Befehlen zum selben Ergebnis.

## Was die Welt besonders macht {#idea}

- **Gemeinsam statt allein:** Kein Spieler kann ein Feuer auf Dauer allein halten. Die Welt lebt davon, dass viele sich gegenseitig zuarbeiten.
- **Jeder darf mitmachen:** Du kannst sofort als **Gast** losspielen. Wer sich registriert, behält Figur und Fortschritt ([Gast und Konto](help.game.account)).
- **Echtzeit:** Andere Spieler siehst du live auf der Karte, auch Figuren des Spiels wie Ines und Bo sind unterwegs.
- **Eine Welt auf phi-spaces:** Strandgut, das nur einer aufheben kann, ein Feuer, das von allein erlischt, ein Tausch, der ganz oder gar nicht gilt: Die Regeln sind die Eigenschaften des Space.

Weiter: [Spielziel](help.game.goal), [Erste Schritte](help.game.start), [Steuerung](help.game.controls), [Befehle](help.game.commands).`,
			en: `## Overview {#overview}

Leuchtfeuer is a **multiplayer world in the browser**: an archipelago of small islands, permanently in the fog. Where a beacon burns, the fog lifts and you can move, collect and trade freely. Where it goes out, the fog advances and swallows the paths.

You play a character on a **map** (or with **text** only, like a MUD). Everything you do is a text command: a click on the map is \`move x y\`, the space bar is \`get …\`. If you prefer typing, the same commands lead to the same result.

## What makes the world special {#idea}

- **Together, not alone:** nobody can keep a beacon burning alone for long. The world lives on many people working for each other.
- **Anyone can join:** you can start at once as a **guest**. Registering keeps your character and progress ([Guest and account](help.game.account)).
- **Real time:** you see other players live on the map; characters of the game, like Ines and Bo, walk around too.
- **A world on phi-spaces:** driftwood that only one can pick up, a fire that goes out by itself, a trade that happens wholly or not at all: the rules are properties of the space.

Next: [Goal](help.game.goal), [First steps](help.game.start), [Controls](help.game.controls), [Commands](help.game.commands).`,
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

Wer viel ins Feuer legt, steht im **Ruf** (\`ruf\` zeigt, was du beigetragen hast). Jedes Feuer zeigt öffentlich, wer wie viel eingebracht hat.

## Die Spielschleife {#loop}

1. **Bergen:** Die Flut spült Treibholz und Muscheln als **Strandgut** an den Strand. Es bleibt nur einige Minuten liegen, dann trägt die See es wieder fort. Wer zuerst ankommt, bekommt es, auch wenn zehn gleichzeitig zugreifen.
2. **Verarbeiten:** Aus Strandgut wird Brennstoff und Werkzeug (\`craft\`, siehe [Handel und Handwerk](help.game.trade)).
3. **Feuer halten:** Brennholz ins Leuchtfeuer legen verlängert, wie lange es brennt. Brennt es nicht, steigt der Nebel Stufe für Stufe ([Feuer, Nebel, Flut](help.game.fire)).
4. **Handeln:** Mit anderen tauschen, am Marktbrett kaufen und verkaufen, Aufträge der Auftragstafel erfüllen.
5. **Bauen:** Im Licht eines Feuers baut ihr gemeinsam Hütten, jede mit einer Truhe ([Bauen](help.game.build)). Absprechen geht im [Chat](help.game.chat), auch über die Inseln.
6. **Erkunden:** Von einem brennenden Feuer aus lassen sich weitere Orte im Nebel erreichen. Was dort liegt, wird mit der Welt größer.

## Zielkonflikt {#conflict}

Brennholz kannst du **selbst verbrauchen** (Werkzeug bauen, Handel) oder **ins gemeinsame Feuer legen**. Das ist die Entscheidung, um die das Spiel kreist.`,
			en: `## The goal {#goal}

There is no end state and there are no fixed classes. Your goal: **keep the beacons burning**, and with them the paths, markets and places that lie in the light. Role and reputation come from what you do: beachcomber, trader, boatman or keeper.

Whoever puts a lot into the fire gains **reputation** (\`reputation\` shows what you contributed). Every beacon shows publicly who put in how much.

## The game loop {#loop}

1. **Salvage:** the tide washes driftwood and shells ashore as **flotsam**. It lies only a few minutes before the sea carries it off again. Whoever arrives first gets it, even if ten reach for it at once.
2. **Process:** flotsam becomes fuel and tools (\`craft\`, see [Trade and crafting](help.game.trade)).
3. **Keep the fire:** putting fuel into a beacon extends how long it burns. If it does not burn, the fog rises step by step ([Fire, fog, tide](help.game.fire)).
4. **Trade:** swap with others, buy and sell at the market board, fulfil jobs from the job board.
5. **Build:** in a fire's light you build huts together, each with a chest ([Building](help.game.build)). Agree on it in the [chat](help.game.chat), also across the islands.
6. **Explore:** from a burning beacon further places in the fog can be reached. What lies there grows with the world.

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

1. **Losspielen:** Auf der Startseite „Als Gast spielen“ wählen. Du erscheinst in einer der vier Buchten, an denen Neue ankommen: **Graue Bucht**, **Schärenhafen**, **Rauchhafen** oder **Krabbenbucht**, jede mit einem Leuchtfeuer im Steinring.
2. **Umsehen:** Tippe \`look\` (oder \`schau\`). Rechts im Seitenfeld steht, was neben dir liegt.
3. **Treibholz aufheben:** Geh zu einem braunen Quadrat auf dem Sand (Klick auf die Karte oder Pfeiltasten) und drücke die **Leertaste** oder den Knopf „Aufheben“, oder doppelklicke einfach darauf.
4. **Feuer anzünden:** Geh neben das Leuchtfeuer im Steinring und drücke wieder die Leertaste. Das Scheit brennt zehn Minuten. Der Nebel weicht.
5. **Weiter:** Sammle mehr Holz, sag Hallo (\`say Hallo\`; in jeder Bucht hütet jemand das Feuer), und nimm einen Weg hinaus: \`look\` zeigt sie, \`go <name>\` oder der Name allein nimmt einen (in der Grauen Bucht etwa \`ost\` zum Klippenpfad).

> Du hast dich verlaufen? \`help\` zeigt alle Befehle, diese Hilfe erklärt den Rest. Mit \`who\` siehst du, wer sonst da ist.

## Als Gast {#guest}

Gäste können sofort spielen, aber noch nicht tauschen oder handeln, und ihre Figur verfällt nach einigen Tagen ohne Spiel. Oben in der Kopfzeile kannst du dich registrieren und behältst alles ([Gast und Konto](help.game.account)).`,
			en: `## How to begin {#start}

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

| Eingabe | Wirkung |
| --- | --- |
| Klick oder Tipp auf ein Feld | Dorthin gehen (\`move x y\`), der Server findet den Weg |
| Rechtsklick oder langes Drücken | Menü zu diesem Feld: ansehen, aufheben, nachlegen, auf einer Figur „Chat mit …“, auf einer Baustelle liefern und mitarbeiten, auf einem freien Feld **Bauen …** (Plan wählen, dann OK: die Baustelle beginnt an diesem Feld nach rechts unten) oder mit Spaten ein Beet umgraben; auf der eigenen Figur Umsehen, Inventar, wer spielt, Uhrzeit, Ruf, Baupläne, Samen sammeln |
| Klick auf ein Ausgangsfeld | Zum Ausgang gehen; im Menü des Feldes steht „Nach … gehen“ (\`go\`, von überall im Raum) |
| 2D: Ziehen (gezoomt) | Die Ansicht verschieben |
| 2D: zwei Finger auseinander oder zusammen | Eine Zoomstufe vor oder zurück (1×, 2×, 3×) |
| 3D: Mausrad oder zwei Finger | Näher heran und weiter weg (Zoom) |
| 3D: Ziehen mit Maus oder Finger | Die Ansicht verschieben (links, rechts, hoch, runter) |
| 3D: Ziehen mit gedrücktem Mausrad oder mit Umschalttaste, Knöpfe ↶ ↷ | Die Ansicht drehen (die Knöpfe in Achtelschritten) |

## Am Handy und Tablet {#touch}

Unten rechts auf der Karte liegt ein **Steuerkreuz**: Solange du eine Richtung hältst, gehst du Schritt für Schritt (wie die Pfeiltasten); **✋** in der Mitte hebt auf oder legt nach (wie die Leertaste). Es erscheint nur auf Geräten, die man mit dem Finger bedient. Ein Tipp auf ein Feld geht weiterhin direkt dorthin.

Ein Tablet im Hochformat zeigt die Karte oben und das Seitenfeld darunter, im Querformat beide nebeneinander. Über „Zum Startbildschirm hinzufügen“ öffnet sich das Spiel ohne die Leisten des Browsers.

## Tastatur {#keys}

| Taste | Wirkung |
| --- | --- |
| Pfeiltasten | Einen Schritt gehen (\`step dx dy\`) |
| Leertaste | Aufheben, was neben dir liegt; sonst das Feuer neben dir nachlegen |
| Doppelklick auf ein Ding | Hingehen und aufheben (Holz, Muschel, Tang …); auf dem Handy Doppeltippen |
| Enter | In die Befehlszeile springen |
| Buchstaben, Ziffern | Einfach lostippen: der Text geht in die Befehlszeile |
| Pfeiltasten in der Befehlszeile | Zurück zur Karte und einen Schritt gehen: hoch und runter immer, links und rechts, solange die Zeile leer ist (mit Text bewegen sie den Cursor) |
| Esc | Aus der Befehlszeile zurück zur Karte; schließt Menüs und diese Hilfe |

Die Tasten gelten, solange die Befehlszeile nicht den Fokus hat.

## Seitenfeld {#side}

Rechts (auf dem Handy und dem Tablet im Hochformat unter der Karte) stehen **Neben dir**, **Du trägst** und das **Leuchtfeuer** mit Restzeit, jeweils mit Knöpfen. Darunter das **Protokoll** mit allem, was du siehst und hörst, daneben die Reiter des [Chats](help.game.chat) (je Gespräch einer, „Chats“ als Übersicht), und die **Befehlszeile**. „Kommen und Gehen“ blendet die Meldungen ein, wer kommt und geht.

## Kopfzeile {#bar}

- **?** öffnet diese Hilfe.
- Der Punkt zeigt, ob du verbunden bist (grün) oder nicht (rot).
- Daneben stehen der **Raum**, in dem du bist, und die **Weltzeit** (Tag und Uhrzeit; ⏸, wenn die Welt angehalten ist), rechts dein Name.
- **Text / 2D / 3D** wählt die Darstellung. **Text** blendet die Karte aus: für Screenreader, schwache Geräte oder wer es lieber wie ein MUD mag; alles bleibt spielbar. **2D** ist die Kachelkarte, **3D** eine Ansicht derselben Welt von schräg oben.
- **Abmelden** beendet die Sitzung.
- Auf dem Handy liegen Darstellung und Abmelden hinter **⋯**.`,
			en: `## On the map {#map}

| Input | Effect |
| --- | --- |
| Click or tap a cell | Walk there (\`move x y\`), the server finds the way |
| Right click or long press | Menu for that cell: look, pick up, add fuel, on a figure “Chat with …”, on a site deliver and help, on a free cell **Build …** (pick a plan, then OK: the site starts at that cell towards the bottom right) or dig a bed with a spade; on your own figure look, inventory, who plays, time, reputation, plans, gather seeds |
| Click an exit cell | Walk to the exit; the cell's menu has “Go to …” (\`go\`, from anywhere in the room) |
| 2D: drag (zoomed in) | Move the view |
| 2D: two fingers apart or together | One zoom step in or out (1×, 2×, 3×) |
| 3D: mouse wheel or two fingers | Zoom in and out |
| 3D: drag with mouse or finger | Move the view (left, right, up, down) |
| 3D: drag with the mouse wheel held down or with Shift, ↶ ↷ buttons | Turn the view (the buttons in eighths) |

## On a phone or tablet {#touch}

A **pad** lies at the bottom right of the map: while you hold a direction you walk step by step (like the arrow keys); **✋** in its middle picks up or adds fuel (like the space bar). It appears only on devices used with a finger. A tap on a cell still walks straight there.

A tablet held upright shows the map on top and the side panel below it, held sideways both next to each other. “Add to Home Screen” opens the game without the browser's bars.

## Keyboard {#keys}

| Key | Effect |
| --- | --- |
| Arrow keys | Take one step (\`step dx dy\`) |
| Space | Pick up what lies next to you; otherwise feed the fire next to you |
| Double click on a thing | Walk there and pick it up (wood, shell, kelp …); on a phone double tap |
| Enter | Jump to the command line |
| Letters, digits | Just start typing: the text goes to the command line |
| Arrow keys in the command line | Back to the map and one step: up and down always, left and right while the line is empty (with text they move the cursor) |
| Esc | Leave the command line back to the map; closes menus and this help |

The keys work as long as the command line does not have the focus.

## Side panel {#side}

On the right (below the map on a phone and an upright tablet) you find **Next to you**, **You carry** and the **beacon** with its time left, each with buttons. Below that the **log** with everything you see and hear, beside it the tabs of the [chat](help.game.chat) (one per talk, “Chats” as the overview), and the **command line**. “Kommen und Gehen” shows the lines about who comes and goes.

## Header bar {#bar}

- **?** opens this help.
- The dot shows whether you are connected (green) or not (red).
- Next to it the **room** you are in and the **world time** (day and hour; ⏸ while the world is paused), on the right your name.
- **Text / 2D / 3D** picks the view. **Text** hides the map: for screen readers, weak devices or if you prefer a MUD feel; everything stays playable. **2D** is the tile map, **3D** a view of the same world from above at an angle.
- **Log out** ends the session.
- On a phone the view and logging out sit behind **⋯**.`,
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

Tippe sie einfach los, sie landen in der Befehlszeile (oder Enter). Jeder Befehl gilt **auf Englisch und auf Deutsch**, ohne Umschalter: \`get treibholz\` und \`nimm holz\` sind dasselbe. Dinge findest du über Name oder Kurzname (\`holz\`, \`wood\`). Den Namen eines Ausgangs kannst du allein tippen (\`ost\`). \`help <befehl>\` erklärt einen Befehl, \`help\` listet alle.

## Bewegen und umsehen {#move}

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`look [ding]\` | \`schau\`, \`l\` | Umsehen, oder ein Ding, einen Ausgang, eine Person ansehen |
| \`move <x> <y>\` | \`laufe\` | Zu einer Stelle gehen, den ganzen Weg |
| \`step <dx> <dy>\` | \`schritt\` | Einen Schritt gehen |
| \`go <richtung>\` | \`geh\`, \`gehe\` | Einen Ausgang nehmen |
| \`who\` | \`wer\` | Wer gerade spielt |
| \`time\` | \`zeit\` | Tag und Uhrzeit in der Welt (steht auch oben in der Kopfzeile) |

## Dinge {#things}

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`get <ding>\` | \`nimm\`, \`heb\`, \`take\` | Etwas aufheben, das neben dir liegt |
| \`drop <ding>\` | \`leg\`, \`lege\`, \`lass\` | Etwas ablegen |
| \`give <ding> an <person>\` | \`gib\` | Jemandem etwas geben (nicht als Gast) |
| \`inventory\` | \`inventar\`, \`i\` | Was du trägst |
| \`put <ding> in <feuer>\` | \`nachlegen\`, \`wirf\` | Brennholz ins Leuchtfeuer legen (auch: \`lege holz ins feuer\`) |

## Reden {#talk}

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`say <text>\` | \`sag\`, \`'text\` | Etwas sagen; alle im Raum hören es |
| \`emote <tut etwas>\` | \`geste\`, \`:winkt\` | Eine Handlung zeigen |
| \`channel <name> <text>\` | \`kanal\` | Auf einem Kanal sprechen, den alle hören (z. B. \`kanal hafen Hallo\`); ohne Text listet er die Kanäle |
| \`chat <name> <text>\` | \`tell\`, \`flüstere\` | Verschlüsseltes Gespräch zu zweit, auch über Inseln ([Chat](help.game.chat)) |
| \`gruppe …\` | \`group\` | Gruppen: gründen, einladen, schreiben, verlassen ([Chat](help.game.chat#groups)) |
| \`ignoriere <name>\` / \`erlaube <name>\` | \`ignore\` / \`unignore\` | Einen Spieler im Chat sperren oder wieder zulassen |

## Bauen {#buildcmds}

Ausführlich unter [Bauen](help.game.build).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`bau <plan> [x y]\` | \`build\`, \`errichte\` | Im Licht eines Feuers eine Baustelle abstecken; ohne Plan die Baupläne |
| \`liefere [n] <ding>\` | \`deliver\` | An die Baustelle liefern (bis zwei Felder entfernt) |
| \`arbeite\` | \`work\` | An der Baustelle mitarbeiten (bis zwei Felder entfernt) |
| \`baustelle\` | \`site\` | Was hier gebaut wird und was fehlt |
| \`truhe\`, \`verstaue\`, \`entnimm\` | \`chest\`, \`store\`, \`retrieve\` | Die Truhe deiner Hütte |
| \`repariere\` | \`repair\` | Einen Bau ausbessern |
| \`abriss\` | \`demolish\`, \`reiße … ab\` | Deinen Bau oder deine Baustelle abreißen |
| \`nachlass\` | \`estate\` | Den Nachlass an der Ruine deines Baus abholen |

## Gärten {#gardencmds}

Ausführlich unter [Gärten](help.game.garden).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`umgraben [zier/gemeinschaft] [x y]\` | \`beet anlegen\` | Mit einem Spaten im Licht ein Beet anlegen, ein Zierbeet oder ein Gemeinschaftsbeet |
| \`beet\` | \`bed\`, \`beete\` | Die Beete hier; \`beet aufgeben\` macht deins wieder zu Gras |
| \`sammle samen\` | \`samen\` | In der wilden Flora nach Samen suchen |
| \`pflanze <samen> [x y]\` | \`säe\`, \`plant\` | Einen Samen in dein Beet setzen |
| \`schöpfe\` | \`fill\` | An der Regentonne eine Kanne Wasser füllen |
| \`gieße\` | \`water\` | Ein Beet gießen (deins oder als Pate) |
| \`jäte\` | \`weed\` | Unkraut und Welkes herausziehen |
| \`ernte\` | \`harvest\`, \`pflücke\` | Reifes ernten, mit Samen; an einer reifen Flur ein Arbeitspunkt und dein Anteil |
| \`pate <name>\` | \`sponsor\` | Jemanden dein Beet pflegen lassen; \`pate weg <name>\` beendet es |
| \`benenne <name>\` | \`taufe\` | Deiner Kreuzung einen Namen geben (\`benenne 2 <name>\`, wenn du mehrere trägst) |
| \`scheuche hase\` | \`scare\` | Einen Hasen bis drei Schritte von dir in den Nebel zurückjagen |
| \`zäune\` | \`fence\` | Einen Zaun um ein Beet neben dir setzen (2 Treibholz, 1 Tangseil) |
| \`flur anlegen [x y]\` | \`acker anlegen\` | Mit einem Spaten im Licht eine Flur umbrechen (4×4); \`flur\` zeigt die Fluren hier, \`flur offen\`/\`flur zu\`, \`flur aufgeben\` |
| \`bestelle [frucht]\` | \`pflüge\`, \`plough\` | Die Flur bestellen: Frucht wählen, Saatgut und einen Arbeitspunkt bringen |

## Handel und Ruf {#tradecmds}

Ausführlich unter [Handel und Handwerk](help.game.trade).

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`offer <dinge> an <person> [für <dinge>]\` | \`biete\`, \`tausche\` | Tausch anbieten |
| \`accept [person]\` / \`decline [person]\` | \`annehmen\` / \`ablehnen\` | Tausch annehmen oder ablehnen |
| \`market\` | \`markt\` | Marktbrett: Angebote ansehen, einstellen, kaufen |
| \`craft [rezept]\` | \`baue\`, \`herstellen\` | Etwas herstellen; ohne Rezept die Liste |
| \`order\` | \`auftrag\` | Auftragstafel |
| \`reputation\` | \`ruf\` | Was du in die Leuchtfeuer gelegt hast |

## Hilfe {#helpcmds}

| Befehl | Wirkung |
| --- | --- |
| \`help [befehl oder thema]\` (auch \`hilfe\`, \`?\`) | Hilfe im Spiel; Themen wie \`help leuchtfeuer\`, \`help handel\`, \`help siedeln\`, \`help garten\`, \`help ackerbau\`, \`help chat\` |

## Für Builder {#builder}

Wer die Stufe *Builder* hat, formt die Welt: \`dig\`/\`grabe\`, \`open\`/\`öffne\`, \`create\`/\`erschaffe\`, \`spawn\`/\`erzeuge\`, \`set\`/\`setze\`, \`tag\`/\`markiere\`, \`lock\`/\`sperre\`, \`examine\`/\`untersuche\`, \`destroy\`/\`vernichte\`. Die Befehle erscheinen nur in der \`help\` dieser Figuren; \`help bauen\` erklärt sie.`,
			en: `## How commands work {#how}

Just start typing, they go to the command line (or Enter). Every command works **in English and in German**, with no switch: \`get driftwood\` and \`nimm holz\` are the same. Things are found by name or short name (\`wood\`, \`holz\`). You can type an exit's name alone (\`east\`). \`help <command>\` explains one command, \`help\` lists all.

## Moving and looking {#move}

| Command | Also | Effect |
| --- | --- | --- |
| \`look [thing]\` | \`schau\`, \`l\` | Look around, or at a thing, an exit, a person |
| \`move <x> <y>\` | \`laufe\` | Walk to a spot, all the way |
| \`step <dx> <dy>\` | \`schritt\` | Take one step |
| \`go <direction>\` | \`geh\`, \`gehe\` | Take an exit |
| \`who\` | \`wer\` | Who is playing right now |
| \`time\` | \`zeit\` | Day and time of day in the world (also shown in the header bar) |

## Things {#things}

| Command | Also | Effect |
| --- | --- | --- |
| \`get <thing>\` | \`nimm\`, \`heb\`, \`take\` | Pick up something next to you |
| \`drop <thing>\` | \`leg\`, \`lege\`, \`lass\` | Put something down |
| \`give <thing> an <person>\` | \`gib\` | Give someone something (not as a guest) |
| \`inventory\` | \`inventar\`, \`i\` | What you carry |
| \`put <thing> in <fire>\` | \`nachlegen\`, \`wirf\` | Put fuel into a beacon |

## Talking {#talk}

| Command | Also | Effect |
| --- | --- | --- |
| \`say <text>\` | \`sag\`, \`'text\` | Say something; everyone in the room hears it |
| \`emote <does something>\` | \`geste\`, \`:waves\` | Show an action |
| \`channel <name> <text>\` | \`kanal\` | Speak on a channel everyone hears (e.g. \`channel hafen Hello\`); without text it lists the channels |
| \`chat <name> <text>\` | \`tell\`, \`whisper\` | Encrypted talk between two, also across islands ([Chat](help.game.chat)) |
| \`gruppe …\` | \`group\` | Groups: found, invite, write, leave ([Chat](help.game.chat#groups)) |
| \`ignoriere <name>\` / \`erlaube <name>\` | \`ignore\` / \`unignore\` | Block a player in the chat or allow them again |

## Building {#buildcmds}

In detail under [Building](help.game.build).

| Command | Also | Effect |
| --- | --- | --- |
| \`bau <plan> [x y]\` | \`build\`, \`errichte\` | Stake out a site in a fire's light; without a plan the list of plans |
| \`liefere [n] <thing>\` | \`deliver\` | Deliver to the site (up to two cells away) |
| \`arbeite\` | \`work\` | Help build (up to two cells away) |
| \`baustelle\` | \`site\` | What is being built here and what is missing |
| \`truhe\`, \`verstaue\`, \`entnimm\` | \`chest\`, \`store\`, \`retrieve\` | Your hut's chest |
| \`repariere\` | \`repair\` | Repair a building |
| \`abriss\` | \`demolish\`, \`reiße … ab\` | Tear down your building or site |
| \`nachlass\` | \`estate\` | Collect the estate at your building's ruin |

## Gardens {#gardencmds}

In detail under [Gardens](help.game.garden).

| Command | Also | Effect |
| --- | --- | --- |
| \`umgraben [zier/gemeinschaft] [x y]\` | \`beet anlegen\` | Dig a bed in the light with a spade, a flower bed or a community bed |
| \`beet\` | \`bed\`, \`beete\` | The beds here; \`beet aufgeben\` turns yours back into grass |
| \`sammle samen\` | \`samen\` | Look for seeds in the wild flora |
| \`pflanze <seed> [x y]\` | \`säe\`, \`plant\` | Put a seed into your bed |
| \`schöpfe\` | \`fill\` | Fill a can of water at the rain barrel |
| \`gieße\` | \`water\` | Water a bed (yours or as a sponsor) |
| \`jäte\` | \`weed\` | Pull weeds and what has wilted |
| \`ernte\` | \`harvest\`, \`pflücke\` | Harvest what is ripe, with seeds; at a ripe field a work point and your share |
| \`pate <name>\` | \`sponsor\` | Let someone tend your bed; \`pate weg <name>\` ends it |
| \`benenne <name>\` | \`taufe\` | Give your crossing a name (\`benenne 2 <name>\` when you carry several) |
| \`scheuche hase\` | \`scare\` | Chase a hare up to three cells from you back into the fog |
| \`zäune\` | \`fence\` | Put a fence round a bed beside you (2 driftwood, 1 kelp rope) |
| \`flur anlegen [x y]\` | \`acker anlegen\`, \`field\` | Break a field (4×4) with a spade in the light; \`flur\` shows the fields here, \`flur offen\`/\`flur zu\`, \`flur aufgeben\` |
| \`bestelle [crop]\` | \`pflüge\`, \`plough\` | Sow the field: choose the crop, bring seed and a work point |

## Trade and reputation {#tradecmds}

In detail under [Trade and crafting](help.game.trade).

| Command | Also | Effect |
| --- | --- | --- |
| \`offer <things> an <person> [für <things>]\` | \`biete\`, \`tausche\` | Offer a swap |
| \`accept [person]\` / \`decline [person]\` | \`annehmen\` / \`ablehnen\` | Accept or decline a swap |
| \`market\` | \`markt\` | Market board: see, post and buy offers |
| \`craft [recipe]\` | \`baue\`, \`herstellen\` | Make something; without a recipe the list |
| \`order\` | \`auftrag\` | Job board |
| \`reputation\` | \`ruf\` | What you put into the beacons |

## Help {#helpcmds}

| Command | Effect |
| --- | --- |
| \`help [command or topic]\` (also \`hilfe\`, \`?\`) | In-game help; topics such as \`help leuchtfeuer\`, \`help handel\`, \`help siedeln\`, \`help garten\`, \`help ackerbau\`, \`help chat\` |

## For builders {#builder}

Characters with the *Builder* level shape the world: \`dig\`, \`open\`, \`create\`, \`spawn\`, \`set\`, \`tag\`, \`lock\`, \`examine\`, \`destroy\` (German: \`grabe\`, \`öffne\`, \`erschaffe\`, \`erzeuge\`, \`setze\`, \`markiere\`, \`sperre\`, \`untersuche\`, \`vernichte\`). They show up only in the \`help\` of those characters; \`help bauen\` explains them.`,
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
			de: `## Das Leuchtfeuer {#beacon}

Ein Leuchtfeuer brennt, solange es **Brennstoff** hat. Jeder Brennstoff verlängert die Brenndauer:

| Brennstoff | Brenndauer |
| --- | --- |
| Treibholz | 10 Minuten |
| Holzbündel | 40 Minuten |

Ein Feuer brennt höchstens zwei Stunden im Voraus, mehr nimmt es nicht an. Im Seitenfeld siehst du die Restzeit. Du legst nach mit der Leertaste, dem Knopf „Nachlegen“ oder \`put treibholz in feuer\`. Niemand läuft in ein brennendes Feuer: Auf Feuerfeldern kann man nicht stehen.

## Der Nebel {#fog}

Er hat vier Stufen (0 bis 3). Brennt kein Feuer, steigt er alle zwei Minuten um eine Stufe; ein brennendes Feuer lässt ihn in den Räumen, die es beleuchtet, wieder weichen. Bei **Stufe 3 („undurchdringlich“) sind die Wege nicht mehr passierbar**: Du findest den Ausgang nicht, bis das Feuer wieder brennt. \`look\` beschreibt den Nebel in Worten, die Karte zeigt ihn mit.

## Die Flut {#tide}

Die Flut bringt etwa jede Minute neues **Strandgut** an den Strand der Grauen Bucht (höchstens vier Stücke gleichzeitig): meist Treibholz, seltener Muscheln. Es liegt fünf Minuten, dann ist es fort. Wer schneller ist, bekommt es; kommen zwei gleichzeitig, bekommt es genau einer, der andere sieht eine Meldung.

## Figuren der Welt {#people}

Ines und Bo sind Figuren des Spiels. **Ines** hütet das Feuer: Sie sagt, wenn es schwach wird, ausgeht oder wieder brennt, und begrüßt, wer „Hallo“ sagt. **Bo** ist der Fährmann und läuft zwischen den Orten hin und her. Andere Spieler erkennst du an ihrem Namen; mit \`who\` siehst du alle.`,
			en: `## The beacon {#beacon}

A beacon burns as long as it has **fuel**. Each kind of fuel extends the burn time:

| Fuel | Burn time |
| --- | --- |
| Driftwood | 10 minutes |
| Wood bundle | 40 minutes |

A fire accepts at most two hours ahead; more is not taken. The side panel shows the time left. Add fuel with the space bar, the “Add fuel” button or \`put driftwood in fire\`. Nobody walks into a burning fire: you cannot stand on fire cells.

## The fog {#fog}

It has four levels (0 to 3). With no burning fire it rises one level every two minutes; a burning fire pushes it back in the rooms it lights. At **level 3 (“impenetrable”) the paths can no longer be passed**: you do not find the exit until the fire burns again. \`look\` describes the fog in words, the map shows it too.

## The tide {#tide}

About every minute the tide brings new **flotsam** to the beach of the Grey Bay (at most four pieces at a time): mostly driftwood, less often shells. It lies five minutes, then it is gone. Whoever is faster gets it; if two reach for it together, exactly one gets it and the other sees a message.

## Characters of the world {#people}

Ines and Bo are characters of the game. **Ines** keeps the fire: she says when it gets weak, goes out or burns again, and greets whoever says “hello”. **Bo** is the ferryman and walks back and forth between the places. You recognise other players by name; \`who\` shows everyone.`,
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
			de: `Handel steht Gästen nicht offen: Zum Tauschen, Handeln und Weitergeben brauchst du ein Konto ([Gast und Konto](help.game.account)).

## Tauschen {#swap}

\`offer treibholz, muschel an Bert für münze\`: Du bietest \`Bert\` Treibholz und eine Muschel für eine Münze. Bert nimmt mit \`accept\` an oder lehnt mit \`decline\` ab. **Alles wechselt auf einmal oder gar nicht**: Es gibt keinen halben Tausch und kein Verdoppeln. Mit \`offer zurück\` nimmst du dein Angebot zurück.

## Marktbrett {#market}

An der Grauen Bucht gibt es ein Marktbrett, Preise in **Münzen**:

- \`markt\`: Angebote ansehen
- \`markt biete <ding> für <n>\`: etwas für n Münzen einstellen
- \`markt kaufe <nr>\`: Angebot Nummer nr kaufen
- \`markt zurück <nr>\`: eigenes Angebot zurücknehmen

## Handwerk {#craft}

\`craft\` ohne Rezept zeigt die Liste, \`craft <rezept>\` stellt etwas her:

| Rezept | Man braucht | Ergebnis |
| --- | --- | --- |
| Muschelmesser | 2 Muscheln, 1 Treibholz | Werkzeug, stumpft nach einigen Einsätzen ab |
| Holzbündel | 3 Treibholz und ein Muschelmesser | Brennt vier Mal so lange wie ein Scheit |

## Auftragstafel {#orders}

\`auftrag\` zeigt die Tafel, \`auftrag nimm <nr>\` übernimmt einen Auftrag, \`auftrag liefere\` gibt die geforderten Dinge ab, \`auftrag aufgeben\` stellt einen eigenen ein. Der Lohn wird in Münzen gezahlt. Beispiele: Ines braucht 2 Treibholz für die Nacht, Bo sammelt 2 Muscheln für Netzgewichte; beides bringt eine Münze.`,
			en: `Trade is not open to guests: to swap, trade and hand things on you need an account ([Guest and account](help.game.account)).

## Swapping {#swap}

\`offer treibholz, muschel an Bert für münze\`: you offer \`Bert\` driftwood and a shell for a coin. Bert accepts with \`accept\` or declines with \`decline\`. **Everything changes hands at once or not at all**: no half swaps and no duplicating. \`offer zurück\` takes your offer back. (The words \`an\` and \`für\` stay as they are in the command.)

## Market board {#market}

The Grey Bay has a market board, prices in **coins**:

- \`market\`: see the offers
- \`market biete <thing> für <n>\`: post something for n coins
- \`market kaufe <nr>\`: buy offer number nr
- \`market zurück <nr>\`: take your own offer back

## Crafting {#craft}

\`craft\` without a recipe shows the list, \`craft <recipe>\` makes something:

| Recipe | You need | Result |
| --- | --- | --- |
| Shell knife | 2 shells, 1 driftwood | A tool; it blunts after a few uses |
| Wood bundle | 3 driftwood and a shell knife | Burns four times as long as one log |

## Job board {#orders}

\`order\` shows the board, \`order nimm <nr>\` takes a job, \`order liefere\` hands in the demanded things, \`order aufgeben\` posts your own. The reward is paid in coins. Examples: Ines needs 2 driftwood for the night, Bo collects 2 shells for net weights; each pays one coin.`,
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
			de: `Bauen geht nur im **Licht eines Leuchtfeuers**: Wo kein Feuer brennt, steckt niemand eine Baustelle ab. Jedes Feuer trägt nur so viele Bauten, wie sein Licht reicht. Abstecken und besitzen braucht ein Konto; mitbauen dürfen auch Gäste ([Gast und Konto](help.game.account)).

## Baustelle abstecken {#stake}

\`bau hütte\` steckt neben dir eine Baustelle ab, \`bau hütte <x> <y>\` an einer bestimmten Stelle. \`bau\` allein zeigt die Baupläne. Eine Hütte braucht 2×2 Felder, **6 Treibholz, 2 Tangseil und 20 Arbeit**. Die **Regentonne** (1 Feld, 3 Treibholz, 1 Tangseil, 4 Arbeit) gibt Wasser für die [Gärten](help.game.garden), die **Vogelscheuche** (1 Feld, 2 Treibholz, 1 Tangseil, 3 Arbeit) hält die Hasen von ihnen fern.

Nicht gebaut wird auf Ausgängen und Türen, direkt am Feuer, auf Dingen oder Personen. Wege bleiben frei: Ausgänge, der Startplatz und eine Seite jedes Feuers bleiben erreichbar. In einen Bau läuft niemand hinein.

## Liefern und mitarbeiten {#help}

| Befehl | Auch | Wirkung |
| --- | --- | --- |
| \`liefere [n] <ding>\` | \`deliver\` | Liefern, was die Baustelle braucht; zu viel bleibt bei dir |
| \`arbeite\` | \`work\` | Einen Arbeitspunkt beitragen; danach ruhst du eine Stunde Weltzeit |
| \`baustelle\` | \`site\` | Was hier gebaut wird und was noch fehlt |

Liefern und arbeiten geht **aus bis zu zwei Feldern Abstand**, so haben viele um eine Baustelle Platz. Das Menü der rechten Maustaste auf einer Baustelle bietet Liefern und Mitarbeiten an. Höchstens die Hälfte darf von NPCs oder Automaten kommen. Fehlt nichts mehr, steht der Bau; an ihm steht, wer mitgebaut hat. Eine Baustelle ohne Fortschritt verfällt nach zwei Welttagen.

## Die Truhe {#chest}

Die Hütte hat eine Truhe mit 12 Plätzen, die **nur dir** gehört: \`truhe\` zeigt sie, \`verstaue 3 muscheln\` (oder „leg die muscheln in die truhe“) legt etwas hinein, \`entnimm 2 muscheln\` (oder „nimm … aus der truhe“) holt es heraus. Dafür stehst du direkt neben der Hütte.

## Verfall, Ruine und Nachlass {#decay}

Ein Bau hält **eine Woche**. \`repariere\` (1 Treibholz, jeder darf helfen) setzt die Frist neu. Wer ihn verfallen lässt, hat eine **Ruine**: Sie steht noch zehn Welttage und gibt das Licht des Feuers frei. Was in der Truhe lag, wartet einen Monat als **Nachlass**; \`nachlass\` an der Ruine holt es ab.

## Abriss {#demolish}

\`abriss\` (oder „reiß die hütte ab“) an deinem Bau gibt die Fläche und das Licht frei, die Hälfte des Materials und den Inhalt der Truhe zurück. Eine aufgegebene Baustelle gibt alles Gelieferte zurück.`,
			en: `Building is possible only in a **beacon's light**: where no fire burns, nobody stakes out a site. Each fire carries only as many buildings as its light reaches. Staking out and owning need an account; guests may help build ([Guest and account](help.game.account)).

## Staking out a site {#stake}

\`bau hütte\` (or \`build hut\`) stakes out a site next to you, \`bau hütte <x> <y>\` at a given spot. \`bau\` alone lists the plans. A hut takes 2×2 cells, **6 driftwood, 2 kelp rope and 20 work**. The **rain barrel** (1 cell, 3 driftwood, 1 kelp rope, 4 work) gives water for the [gardens](help.game.garden), the **scarecrow** (1 cell, 2 driftwood, 1 kelp rope, 3 work) keeps the hares from them.

Nothing is built on exits and doors, right at a fire, on things or people. Ways stay open: exits, the starting place and one side of every fire stay reachable. Nobody walks into a building.

## Delivering and helping {#help}

| Command | Also | Effect |
| --- | --- | --- |
| \`liefere [n] <thing>\` | \`deliver\` | Deliver what the site needs; anything extra stays with you |
| \`arbeite\` | \`work\` | Add one point of work; afterwards you rest for a world hour |
| \`baustelle\` | \`site\` | What is being built here and what is still missing |

Delivering and working work **from up to two cells away**, so many fit around a site. The right-click menu on a site offers delivering and helping. At most half may come from NPCs or automata. When nothing is missing, the building stands, naming who helped. A site without progress lapses after two world days.

## The chest {#chest}

The hut has a chest with 12 places that is **yours alone**: \`truhe\` (\`chest\`) shows it, \`verstaue 3 muscheln\` (\`store\`, or “leg die muscheln in die truhe”) puts something in, \`entnimm 2 muscheln\` (\`retrieve\`) takes it out. You stand right next to the hut for that.

## Decay, ruin and estate {#decay}

A building lasts **a week**. \`repariere\` (\`repair\`; 1 driftwood, anyone may help) sets the time anew. Let it decay and it becomes a **ruin**: it stands ten more world days and frees the fire's light. What lay in the chest waits a month as an **estate**; \`nachlass\` (\`estate\`) at the ruin collects it.

## Demolition {#demolish}

\`abriss\` (\`demolish\`, or “reiß die hütte ab”) at your building frees the land and the light and gives back half the material and the chest's contents. A site given up gives back everything delivered.`,
		},
	},
	{
		id: "help.game.garden",
		section: "play",
		title: { de: "Gärten: Beet, Samen, Gießen, Ernte", en: "Gardens: bed, seeds, watering, harvest" },
		short: {
			de: "Mit einem Spaten im Licht ein Beet anlegen, Samen aus der wilden Flora pflanzen, gießen, jäten und ernten; im Zierbeet neue Sorten kreuzen, am Gemeinschaftsbeet mit allen gärtnern.",
			en: "Dig a bed in the light with a spade, plant seeds from the wild flora, water, weed and harvest; cross new sorts in a flower bed, garden with everyone at a community bed.",
		},
		body: {
			de: `Gärten zählen so viel wie Bauten. Ein Beet braucht wie eine Hütte das **Licht eines Leuchtfeuers** und belegt einen Lichtpunkt des Feuers. Anlegen braucht ein Konto; als **Pate** gießen und ernten dürfen auch Gäste.

## Spaten und Beet {#bed}

\`craft spaten\` macht aus **2 Treibholz und 1 Tangseil** einen Spaten. Damit gräbt \`umgraben\` neben dir ein Beet um (2×2 Felder), \`umgraben <x> <y>\` an einer bestimmten Stelle. Jeder hat höchstens drei Beete. Wie bei Bauten bleiben Ausgänge, Türen und der Platz am Feuer frei, und niemand läuft durch ein Beet.

\`beet\` zeigt die Beete hier: was wächst, wann zuletzt gegossen wurde, ob Unkraut darin ist. \`beet aufgeben\` macht deins wieder zu Gras. Ein Beet, das zwei Wochen niemand pflegt, wächst von selbst zu.

## Samen {#seeds}

\`sammle samen\` sucht in der wilden Flora des Ortes nach Samen; das klappt nicht jedes Mal, danach wartest du eine Weltstunde.

| Sorte | Wo sie wild wächst | Ernte |
| --- | --- | --- |
| Strandnelke | wo Blumen blühen, überall | Strandnelke |
| Dünenrose | Graue Insel, Krabbensand, Möwenfels | Dünenrose |
| Nebelblume | nur Nebelholm | Nebelblume (selten) |
| Strandkohl | wo Kräuter wachsen, überall | 2 Kohl |
| Möhre | Graue Insel, Kupferhafen, Rauchholm, Krabbensand | 2 Möhren |

\`pflanze strandnelke\` setzt einen Samen in dein Beet, eine Pflanze je Feld (\`pflanze kohl <x> <y>\` in ein bestimmtes). Jede Ernte gibt neue Samen, manchmal zwei.

## Wasser und Pflege {#care}

Wasser kommt aus der **Regentonne** (\`bau regentonne\`: 3 Treibholz, 1 Tangseil, 4 Arbeit). \`schöpfe\` neben der Tonne füllt eine **Kanne Wasser**; die Tonne fasst sechs, bekommt alle acht Weltstunden eine dazu und ist nach einer Sturmflut auf ihrer Insel voll. \`gieße\` gießt mit einer Kanne das ganze Beet.

Eine Pflanze wächst in Stufen: **Saat**, **Keim**, **reif**, **welk**. Steht sie beim nächsten Schritt länger als 16 Weltstunden ohne Wasser, welkt sie. Eine reife Pflanze welkt nach ein bis drei Tagen. **Nebel** und **Unkraut** lassen sie langsamer wachsen: ein brennendes Feuer hilft auch dem Garten. \`jäte\` zieht Unkraut und Welkes heraus.

## Ernten {#harvest}

\`ernte\` holt alles Reife des Beets in deine Tasche, mit Samen. Stehen mehrere am Beet, bekommt jede Pflanze genau einer.

## Zierbeet und Gemeinschaftsbeet {#kinds}

\`umgraben\` legt ein **Gartenbeet** an, in dem Gemüse und Blumen wachsen. \`umgraben zier\` gräbt ein **Zierbeet** um: Dort wachsen nur Blumen (Strandnelke, Dünenrose, Nebelblume), und nur dort kreuzen sie sich. Es zählt wie jedes Beet zu deinen dreien.

\`umgraben gemeinschaft\` legt ein **Gemeinschaftsbeet** an: 3×3 Felder, zwei Lichtpunkte, **eins je Feuer**. Es zählt nicht zu deinen Beeten. Pflanzen darf darin jeder mit Konto, gießen, jäten und ernten alle, auch Gäste. Was du erntest, kommt in deine Tasche. Aufgeben kann es nur, wer es angelegt hat.

## Kreuzen und Benennen {#breeding}

Reift im Zierbeet eine Blume, neben der (nicht über Eck) eine Blume einer anderen Sorte steht, ist bei der Ernte manchmal ein **Kreuzungssamen** dabei. Was daraus wächst, hat eine eigene Farbe zwischen den Farben seiner Eltern. Eine Kreuzung kreuzt sich weiter, auch mit ihrer eigenen Ausgangssorte.

Wer sie gezogen hat, gibt ihr mit \`benenne <name>\` einen Namen, einmal und für immer: Dann heißen ihre Samen „<Name>-Samen“ und ihre Blumen wie die Sorte, und wer sie erntet oder geschenkt bekommt, trägt den Namen weiter. Ein Name hat 3 bis 24 Buchstaben, ist noch nicht vergeben und bezeichnet nichts, was es in der Welt oder als Befehl schon gibt.

## Die Gärtnerin {#gardener}

**Gesa** in Kupferhafen sammelt selbst Samen in der Flora des Hafens und verkauft sie am Markt; sie kauft Blumen und Gemüse. Ihre Suchaufträge hängen an der Tafel („Gesa sucht eine Nebelblume“). Wer sie anspricht, erfährt ihre Preise.

## Hasen aus dem Nebel {#hares}

Wo das Feuer nicht brennt, kommen aus dem Nebel **Hasen** an die Beete: je dichter der Nebel, desto öfter, nachts doppelt so oft, nie mehr als zwei auf einmal in einem Ort. Solange das Feuer brennt, bleibt jeder Hase fort. Ein Hase sitzt eine halbe Weltstunde am Beet, dann frisst er: Eine Pflanze fällt eine Stufe zurück, ein Setzling ist weg. Die letzte lebende Pflanze eines Beets lässt er stehen.

\`scheuche hase\` jagt ihn aus bis zu drei Schritten fort, bevor er frisst; das darf jeder, auch ein Gast, und wer zuerst kommt, rettet das Beet. Dauerhaft schützt ein **Zaun**: \`zäune\` setzt neben dem Beet für **2 Treibholz und 1 Tangseil** einen um dein Beet (oder eins, das du pflegen darfst). Auch eine **Vogelscheuche** (\`bau vogelscheuche\`: 2 Treibholz, 1 Tangseil, 3 Arbeit) hält die Hasen von allen Beeten in bis zu drei Feldern ab; sie steht drei Tage, dann will sie ausgebessert werden (1 Tang).

## Patenschaft {#sponsor}

\`pate <name>\` lässt jemanden dein Beet gießen, jäten und ernten, ohne dass es ihm gehört; auch einen Gast. So bleibt es gepflegt, wenn du ein paar Tage nicht spielst. \`pate weg <name>\` beendet es, \`pate\` allein zeigt die Paten.

Gießen, jäten, ernten und pflanzen gehen aus bis zu **zwei Feldern** Abstand. Die rechte Maustaste auf einem Beet bietet an, was du dort tun kannst.

## Äcker {#fields}

Größer als ein Beet ist die **Flur**: 4×4 Felder, eine je Konto, im Licht eines Feuers (zwei Lichtpunkte). Mit einem Spaten bricht \`flur anlegen\` sie neben dir um, \`flur anlegen <x> <y>\` an einer bestimmten Stelle. Eine Flur trägt **eine** Frucht, braucht kaum tägliche Pflege, aber zwei Stöße Arbeit.

**Bestellen:** Wer die Flur anlegte, wählt die Frucht mit \`bestelle gerste\`. Dann braucht sie **4 Saatgut und 2 Arbeit**: Jedes \`bestelle\` bringt, was du an Saatgut trägst, und einen Arbeitspunkt; danach ruhst du eine Weltstunde, wie an der Baustelle.

| Frucht | Saatgut | Woher | Art | Ertrag |
| --- | --- | --- | --- | --- |
| Weizen | Weizen | Gesa | Getreide | 16 Weizen |
| Gerste | Gerste | wild, wo Kräuter wachsen | Getreide | 16 Gerste |
| Hafer | Hafer | wild: Graue Insel, Nebelholm, Schären | Getreide | 16 Hafer |
| Kartoffeln | Kartoffel | Gesa | Hackfrucht | 24 Kartoffeln |
| Rüben | Rübensamen | wild: Graue Insel, Kupferhafen, Krabbensand | Rüben | 16 Rüben, 8 Rübensamen |
| Flachs | Leinsamen | wild, wo Blumen blühen | Flachs | 16 Flachs, 8 Leinsamen |

**Ernteeinsatz:** Nach zwei bis drei Tagen ist die Flur reif und bleibt es zwei Tage. Jedes \`ernte\` an ihr ist ein Arbeitspunkt (8 für eine Flur) und gibt dir deinen Anteil sofort in die Tasche. Allein dauert das acht Stunden; acht Hände bringen sie in einer ein, und jedes Korn bekommt genau einer. Danach ist die Flur **überreif**, jeder Anteil nur noch halb so groß, und noch zwei Tage später ist die Frucht verdorben.

\`flur offen\` lässt jeden mitsäen und miternten, auch Gäste, und jeder behält seinen Anteil; \`flur zu\` schließt sie wieder.

**Fruchtfolge:** Dieselbe Art zweimal hintereinander macht den Boden müde, er gibt nur noch 60 %, beim dritten Mal 35 %. Eine andere Art oder drei Tage Brache heilen ihn: Getreide, dann Kartoffeln, dann Rüben oder Ruhe. \`flur\` zeigt den Boden. Eine Flur, an der zwei Wochen niemand arbeitet, verwildert.`,
			en: `Gardens count as much as buildings. Like a hut, a bed needs a **beacon's light** and takes one of the fire's light points. Digging one needs an account; as a **sponsor** guests may water and harvest too.

## Spade and bed {#bed}

\`craft spaten\` makes a spade from **2 driftwood and 1 kelp rope**. With it \`umgraben\` digs a bed next to you (2×2 cells), \`umgraben <x> <y>\` at a given spot. Everyone has at most three beds. As with buildings, exits, doors and the place at the fire stay free, and nobody walks through a bed.

\`beet\` (\`bed\`) shows the beds here: what grows, when they were last watered, whether weeds grow. \`beet aufgeben\` turns yours back into grass. A bed nobody tends for two weeks grows over by itself.

## Seeds {#seeds}

\`sammle samen\` looks for seeds in the place's wild flora; it does not work every time, and afterwards you wait a world hour.

| Sort | Where it grows wild | Harvest |
| --- | --- | --- |
| Strandnelke (thrift) | where flowers grow, everywhere | thrift |
| Dünenrose (dune rose) | Graue Insel, Krabbensand, Möwenfels | dune rose |
| Nebelblume (fog flower) | Nebelholm only | fog flower (rare) |
| Strandkohl (sea kale) | where herbs grow, everywhere | 2 cabbages |
| Möhre (carrot) | Graue Insel, Kupferhafen, Rauchholm, Krabbensand | 2 carrots |

\`pflanze strandnelke\` (\`plant\`) puts a seed into your bed, one plant per cell (\`pflanze kohl <x> <y>\` into a given one). Every harvest gives new seeds, sometimes two.

## Water and care {#care}

Water comes from the **rain barrel** (\`bau regentonne\`: 3 driftwood, 1 kelp rope, 4 work). \`schöpfe\` (\`fill\`) next to the barrel fills a **can of water**; the barrel holds six, gains one every eight world hours and is full after a storm surge on its island. \`gieße\` (\`water\`) waters the whole bed with one can.

A plant grows in stages: **seed**, **sprout**, **ripe**, **wilted**. If it has gone without water for more than 16 world hours at its next step, it wilts. A ripe plant wilts after one to three days. **Fog** and **weeds** slow it down: a burning fire helps the garden too. \`jäte\` (\`weed\`) pulls weeds and what has wilted.

## Harvest {#harvest}

\`ernte\` (\`harvest\`) takes everything ripe in the bed into your pack, with seeds. If several stand at the bed, each plant goes to exactly one.

## Flower bed and community bed {#kinds}

\`umgraben\` digs a **garden bed**, where vegetables and flowers grow. \`umgraben zier\` digs a **flower bed**: only flowers grow there (thrift, dune rose, fog flower), and only there do they cross. It counts towards your three like any bed.

\`umgraben gemeinschaft\` lays out a **community bed**: 3×3 cells, two light points, **one per fire**. It does not count towards your beds. Everyone with an account may plant in it, and everyone, guests too, may water, weed and harvest. What you harvest goes into your pack. Only whoever laid it out can give it up.

## Crossing and naming {#breeding}

When a flower ripens in a flower bed with a flower of another sort beside it (not across a corner), the harvest sometimes brings a **seed of a crossing** (\`Kreuzungssamen\`). What grows from it has a colour of its own, between its parents' colours. A crossing crosses again, with its own parent sort too.

Whoever bred it names it with \`benenne <name>\`, once and for good. Its seeds are then called "<Name>-Samen" and its flowers like the sort, and whoever harvests them or is given them carries the name on. A name has 3 to 24 letters, is not yet taken, and means nothing the world or its commands already mean.

## The gardener {#gardener}

**Gesa** in Kupferhafen gathers seeds herself in the harbour's flora and sells them at the market; she buys flowers and vegetables. Her search orders hang on the board ("Gesa sucht eine Nebelblume"). Speak to her to learn her prices.

## Hares from the fog {#hares}

Where the fire does not burn, **hares** come out of the fog to the beds: the thicker the fog, the more often, twice as often at night, never more than two at once in one place. While the fire burns, every hare stays away. A hare sits at the bed for half a world hour, then it eats: one plant falls back a stage, a seedling is gone. It leaves the bed's last living plant standing.

\`scheuche hase\` (\`scare\`) chases it off from up to three cells before it eats; anyone may, a guest too, and whoever comes first saves the bed. A **fence** protects for good: \`zäune\` (\`fence\`) beside the bed puts one round your bed (or one you may tend) for **2 driftwood and 1 kelp rope**. A **scarecrow** (\`bau vogelscheuche\`: 2 driftwood, 1 kelp rope, 3 work) keeps the hares from every bed within three cells too; it stands three days, then it wants repairing (1 kelp).

## Sponsorship {#sponsor}

\`pate <name>\` (\`sponsor\`) lets someone water, weed and harvest your bed without it being theirs, a guest too. That keeps it tended while you do not play for a few days. \`pate weg <name>\` ends it, \`pate\` alone shows the sponsors.

Watering, weeding, harvesting and planting work from up to **two cells** away. The right-click menu on a bed offers what you can do there.

## Fields {#fields}

Bigger than a bed is the **field**: 4×4 cells, one per account, in a fire's light (two light points). With a spade \`flur anlegen\` breaks one beside you, \`flur anlegen <x> <y>\` at a given spot. A field carries **one** crop, needs little daily care but two bursts of work.

**Sowing:** whoever made the field chooses the crop with \`bestelle gerste\` (\`plough\`). Then it needs **4 seed and 2 work**: every \`bestelle\` brings what seed you carry and one work point; then you rest a world hour, as at a building site.

| Crop | Seed | From | Kind | Yield |
| --- | --- | --- | --- | --- |
| Wheat | wheat | Gesa | grain | 16 wheat |
| Barley | barley | wild, where herbs grow | grain | 16 barley |
| Oats | oats | wild: Grey Island, Nebelholm, Skerries | grain | 16 oats |
| Potatoes | potato | Gesa | root crop | 24 potatoes |
| Beets | beet seed | wild: Grey Island, Kupferhafen, Krabbensand | beets | 16 beets, 8 beet seed |
| Flax | linseed | wild, where flowers bloom | flax | 16 flax, 8 linseed |

**Harvest gang:** after two to three days the field is ripe and stays so for two days. Every \`ernte\` at it is a work point (8 for a field) and puts your share in your pack at once. Alone it takes eight hours; eight hands bring it in in one, and every grain goes to exactly one. After that the field is **overripe**, each share only half, and two days later the crop is lost.

\`flur offen\` lets anyone sow and harvest along, guests too, and each keeps their share; \`flur zu\` closes it again.

**Rotation:** the same kind twice in a row tires the soil, it gives only 60 %, the third time 35 %. Another kind or three days of rest heal it: grain, then potatoes, then beets or rest. \`flur\` shows the soil. A field nobody works for two weeks runs wild.`,
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
			de: `\`say\` hört nur der Raum, \`kanal hafen\` alle. Der **Chat** ist das Gespräch zu zweit oder in einer kleinen Gruppe, auch mit jemandem auf einer anderen Insel.

## Einrichten {#setup}

Im Reiter **„Chats“** neben dem Protokoll richtest du den Chat mit einem eigenen **Chat-Passwort** ein. Es ist nicht dein Login-Passwort und geht nie an den Server; mit ihm entsperrst du den Chat auch an einem anderen Gerät.

**Vergisst du das Chat-Passwort, sind deine Verläufe verloren.** Niemand kann sie wiederherstellen. **„Verlauf sichern“** speichert die geöffneten Gespräche als Textdatei. Das Passwort lässt sich ändern, solange du es kennst.

## Zu zweit {#two}

\`chat <name> <text>\` (auch \`tell\`, \`flüstere\`) schreibt jemandem; \`chat <name>\` öffnet nur das Gespräch. Oder die rechte Maustaste (langes Tippen) auf eine Figur, auf einen Namen im Protokoll oder in der Liste von \`who\`: **„Chat mit …“**. Jedes Gespräch hat einen eigenen Reiter mit Zähler für Ungelesenes.

Ist der andere nicht da, wartet die Nachricht **sieben Tage** und erscheint bei seinem nächsten Anmelden (die letzten 50 je Gespräch). Mit NPCs sprichst du mit \`say\`, nicht im Chat.

## Gruppen {#groups}

| Befehl | Wirkung |
| --- | --- |
| \`gruppe neu <name>\` | Eine Gruppe gründen; du verwaltest sie |
| \`gruppe lade <spieler> in <gruppe>\` | Einladen (jedes Mitglied darf; die Einladung gilt einen Welttag) |
| \`gruppe annehmen <gruppe>\` / \`gruppe ablehnen <gruppe>\` | Eine Einladung annehmen oder ablehnen (auch im Reiter „Chats“) |
| \`gruppe <gruppe> <text>\` | In die Gruppe schreiben (oder im Reiter der Gruppe) |
| \`gruppe verlasse <gruppe>\` | Austreten |
| \`gruppe entferne <spieler> aus <gruppe>\` | Jemanden entfernen (nur wer verwaltet) |
| \`gruppe\` | Deine Gruppen |

Höchstens 20 Mitglieder je Gruppe, höchstens zehn Gruppen je Konto. Gäste chatten, gründen aber keine Gruppe und laden niemanden ein.

## Verschlüsselung {#e2e}

Nur die Mitglieder eines Gesprächs können es lesen, nicht der Server und kein Admin. Jede Nachricht wird im Browser für jeden Leser einzeln versiegelt. Jedes Gespräch zeigt den **Fingerabdruck** beider Schlüssel: Vergleicht ihr sie außerhalb des Spiels, wisst ihr, dass niemand dazwischen sitzt. Der Server sieht trotzdem, wer mit wem wann schreibt, und Gruppennamen und Mitglieder.

## Schutz {#safety}

\`ignoriere <name>\` sperrt Nachrichten und Einladungen eines Spielers, \`erlaube <name>\` hebt es auf, \`ignoriere\` allein listet die Gesperrten. **Melden** an einer Nachricht schickt ihren Text mit Absender an die Admins; sonst sehen Admins keine Gespräche. Gespräche erscheinen nie im Protokoll des Raums.`,
			en: `\`say\` is heard by the room only, \`channel hafen\` by everyone. The **chat** is the talk between two or in a small group, also with someone on another island.

## Setting up {#setup}

In the **“Chats”** tab beside the log you set up the chat with a **chat password** of its own. It is not your login password and never reaches the server; with it you unlock the chat on another device too.

**Forget the chat password and your history is lost.** Nobody can restore it. **“Save history”** stores the open talks as a text file. You can change the password as long as you know it.

## Between two {#two}

\`chat <name> <text>\` (also \`tell\`, \`whisper\`) writes to someone; \`chat <name>\` only opens the talk. Or right-click (long press) a figure, a name in the log or in the list of \`who\`: **“Chat with …”**. Every talk has its own tab with a count of unread lines.

If the other is away, the message waits **seven days** and appears at their next sign-in (the last 50 per talk). You talk to NPCs with \`say\`, not in the chat.

## Groups {#groups}

| Command | Effect |
| --- | --- |
| \`gruppe neu <name>\` (\`group\`) | Found a group; you manage it |
| \`gruppe lade <player> in <group>\` | Invite (any member may; the invitation lasts a world day) |
| \`gruppe annehmen <group>\` / \`gruppe ablehnen <group>\` | Accept or decline an invitation (also in the “Chats” tab) |
| \`gruppe <group> <text>\` | Write to the group (or in the group's tab) |
| \`gruppe verlasse <group>\` | Leave |
| \`gruppe entferne <player> aus <group>\` | Remove someone (only who manages it) |
| \`gruppe\` | Your groups |

At most 20 members per group, at most ten groups per account. Guests chat but found no group and invite nobody.

## Encryption {#e2e}

Only the members of a talk can read it, not the server and no admin. Each message is sealed in the browser for every reader separately. Every talk shows the **fingerprint** of both keys: compare them outside the game and you know nobody sits in between. The server still sees who writes to whom and when, and group names and members.

## Safety {#safety}

\`ignoriere <name>\` (\`ignore\`) blocks a player's messages and invitations, \`erlaube <name>\` (\`unignore\`) lifts it, \`ignoriere\` alone lists whom you block. **Report** on a message sends its text with the sender to the admins; otherwise admins see no talks. Talks never appear in the room's log.`,
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

Als **Gast** spielst du sofort, ohne Konto. Du kannst laufen, sammeln, das Feuer nachlegen, reden, chatten, an Baustellen mitbauen und alles ansehen. **Nicht möglich:** tauschen, handeln, Dinge weitergeben, selbst bauen oder besitzen, Chat-Gruppen gründen. Eine Gastfigur verfällt nach einigen Tagen ohne Spiel.

## Konto {#account}

Mit **„Registrieren, um den Fortschritt zu behalten“** in der Kopfzeile legst du ein Konto an (Benutzername und Passwort). Dabei bleiben **Figur, Gegenstände und Ruf** erhalten, du fängst nicht von vorn an. Danach kannst du dich jederzeit mit denselben Daten anmelden, auch an einem anderen Gerät.

## Abmelden {#logout}

„Abmelden“ beendet die Sitzung. Als Gast fragt das Spiel vorher, ob du dich erst registrieren möchtest, weil du sonst nicht zu dieser Figur zurückkommst.

## Datenschutz {#privacy}

Das Spiel speichert nur, was es braucht: Benutzername, ein gesalzener Passwort-Hash, deine Figur und ihren Fortschritt. Alle Texte der Welt werden als reiner Text angezeigt, nie als Code ausgeführt.`,
			en: `## Guest {#guest}

As a **guest** you play at once, without an account. You can walk, collect, feed the fire, talk, chat, help at building sites and look at everything. **Not possible:** swapping, trading, handing things on, building or owning yourself, founding chat groups. A guest character lapses after some days without play.

## Account {#account}

With **“Register to keep your progress”** in the header bar you create an account (user name and password). Your **character, items and reputation** are kept; you do not start over. Afterwards you can sign in with the same details at any time, also on another device.

## Logging out {#logout}

“Log out” ends the session. As a guest the game asks first whether you want to register, because otherwise you will not get back to that character.

## Privacy {#privacy}

The game stores only what it needs: user name, a salted password hash, your character and its progress. All text of the world is shown as plain text and never executed as code.`,
		},
	},
];

export const articleById = (id: string): Article | undefined => ARTICLES.find((a) => a.id === id);

export function tocOf(markdown: string): { id: string; title: string }[] {
	return [...markdown.matchAll(/^##\s+(.+?)\s+\{#([a-z0-9._-]+)\}\s*$/gm)].map((m) => ({ title: m[1]!, id: m[2]! }));
}
