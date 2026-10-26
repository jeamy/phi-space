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
5. **Erkunden:** Von einem brennenden Feuer aus lassen sich weitere Orte im Nebel erreichen. Was dort liegt, wird mit der Welt größer.

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
5. **Explore:** from a burning beacon further places in the fog can be reached. What lies there grows with the world.

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

1. **Losspielen:** Auf der Startseite „Als Gast spielen“ wählen. Du erscheinst in der **Grauen Bucht**, einem Strand mit einem Steinring in der Mitte.
2. **Umsehen:** Tippe \`look\` (oder \`schau\`). Rechts im Seitenfeld steht, was neben dir liegt.
3. **Treibholz aufheben:** Geh zu einem braunen Quadrat auf dem Sand (Klick auf die Karte oder Pfeiltasten) und drücke die **Leertaste** oder den Knopf „Aufheben“.
4. **Feuer anzünden:** Geh neben das Leuchtfeuer im Steinring und drücke wieder die Leertaste. Das Scheit brennt zehn Minuten. Der Nebel weicht.
5. **Weiter:** Sammle mehr Holz, sag Ines Hallo (\`say Hallo\`), nimm den Pfad nach **Osten** zum Klippenpfad (\`go ost\` oder einfach \`ost\`).

> Du hast dich verlaufen? \`help\` zeigt alle Befehle, diese Hilfe erklärt den Rest. Mit \`who\` siehst du, wer sonst da ist.

## Als Gast {#guest}

Gäste können sofort spielen, aber noch nicht tauschen oder handeln, und ihre Figur verfällt nach einigen Tagen ohne Spiel. Oben in der Kopfzeile kannst du dich registrieren und behältst alles ([Gast und Konto](help.game.account)).`,
			en: `## How to begin {#start}

1. **Play:** on the start page choose “Play as guest”. You appear in the **Grey Bay**, a beach with a stone ring in the middle.
2. **Look around:** type \`look\` (or \`schau\`). The side panel shows what lies next to you.
3. **Pick up driftwood:** walk to a brown square on the sand (click the map or use the arrow keys) and press the **space bar** or the “Pick up” button.
4. **Light the fire:** stand next to the beacon in the stone ring and press space again. One log burns ten minutes. The fog retreats.
5. **Go on:** collect more wood, talk to Ines (\`say Hello\`), take the path **east** to the cliff path (\`go east\` or just \`east\`).

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
| Rechtsklick oder langes Drücken | Menü zu diesem Feld: ansehen, aufheben, nachlegen … |
| Klick auf ein Ausgangsfeld | Zum Ausgang gehen; im Menü des Feldes steht „Nach … gehen“ (\`go\`, von überall im Raum) |
| 2D: Ziehen (gezoomt) | Die Ansicht verschieben |
| 2D: zwei Finger auseinander oder zusammen | Eine Zoomstufe vor oder zurück (1×, 2×, 3×) |
| 3D: Mausrad oder zwei Finger | Näher heran und weiter weg (Zoom) |
| 3D: Ziehen mit Maus oder Finger | Die Ansicht nach links oder rechts drehen (die Knöpfe ↶ ↷ drehen in Achtelschritten) |

## Am Handy und Tablet {#touch}

Unten rechts auf der Karte liegt ein **Steuerkreuz**: Solange du eine Richtung hältst, gehst du Schritt für Schritt (wie die Pfeiltasten); **✋** in der Mitte hebt auf oder legt nach (wie die Leertaste). Es erscheint nur auf Geräten, die man mit dem Finger bedient. Ein Tipp auf ein Feld geht weiterhin direkt dorthin.

Ein Tablet im Hochformat zeigt die Karte oben und das Seitenfeld darunter, im Querformat beide nebeneinander. Über „Zum Startbildschirm hinzufügen“ öffnet sich das Spiel ohne die Leisten des Browsers.

## Tastatur {#keys}

| Taste | Wirkung |
| --- | --- |
| Pfeiltasten | Einen Schritt gehen (\`step dx dy\`) |
| Leertaste | Aufheben, was neben dir liegt; sonst das Feuer neben dir nachlegen |
| Enter | In die Befehlszeile springen |
| Pfeiltasten in der Befehlszeile | Zurück zur Karte und einen Schritt gehen: hoch und runter immer, links und rechts, solange die Zeile leer ist (mit Text bewegen sie den Cursor) |
| Esc | Aus der Befehlszeile zurück zur Karte; schließt Menüs und diese Hilfe |

Die Tasten gelten, solange die Befehlszeile nicht den Fokus hat.

## Seitenfeld {#side}

Rechts (auf dem Handy und dem Tablet im Hochformat unter der Karte) stehen **Neben dir**, **Du trägst** und das **Leuchtfeuer** mit Restzeit, jeweils mit Knöpfen. Darunter das **Protokoll** mit allem, was du siehst und hörst, und die **Befehlszeile**.

## Kopfzeile {#bar}

- **?** öffnet diese Hilfe.
- Der Punkt zeigt, ob du verbunden bist (grün) oder nicht (rot).
- **Nur Text** blendet die Karte aus: für Screenreader, schwache Geräte oder wer es lieber wie ein MUD mag. Alles bleibt spielbar.
- **Abmelden** beendet die Sitzung.`,
			en: `## On the map {#map}

| Input | Effect |
| --- | --- |
| Click or tap a cell | Walk there (\`move x y\`), the server finds the way |
| Right click or long press | Menu for that cell: look, pick up, add fuel … |
| Click an exit cell | Walk to the exit; the cell's menu has “Go to …” (\`go\`, from anywhere in the room) |
| 2D: drag (zoomed in) | Move the view |
| 2D: two fingers apart or together | One zoom step in or out (1×, 2×, 3×) |
| 3D: mouse wheel or two fingers | Zoom in and out |
| 3D: drag with mouse or finger | Turn the view left or right (the ↶ ↷ buttons turn in eighths) |

## On a phone or tablet {#touch}

A **pad** lies at the bottom right of the map: while you hold a direction you walk step by step (like the arrow keys); **✋** in its middle picks up or adds fuel (like the space bar). It appears only on devices used with a finger. A tap on a cell still walks straight there.

A tablet held upright shows the map on top and the side panel below it, held sideways both next to each other. “Add to Home Screen” opens the game without the browser's bars.

## Keyboard {#keys}

| Key | Effect |
| --- | --- |
| Arrow keys | Take one step (\`step dx dy\`) |
| Space | Pick up what lies next to you; otherwise feed the fire next to you |
| Enter | Jump to the command line |
| Arrow keys in the command line | Back to the map and one step: up and down always, left and right while the line is empty (with text they move the cursor) |
| Esc | Leave the command line back to the map; closes menus and this help |

The keys work as long as the command line does not have the focus.

## Side panel {#side}

On the right (below the map on a phone and an upright tablet) you find **Next to you**, **You carry** and the **beacon** with its time left, each with buttons. Below that the **log** with everything you see and hear, and the **command line**.

## Header bar {#bar}

- **?** opens this help.
- The dot shows whether you are connected (green) or not (red).
- **Text only** hides the map: for screen readers, weak devices or if you prefer a MUD feel. Everything stays playable.
- **Log out** ends the session.`,
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

Tippe sie in die Befehlszeile (Enter). Jeder Befehl gilt **auf Englisch und auf Deutsch**, ohne Umschalter: \`get treibholz\` und \`nimm holz\` sind dasselbe. Dinge findest du über Name oder Kurzname (\`holz\`, \`wood\`). Den Namen eines Ausgangs kannst du allein tippen (\`ost\`). \`help <befehl>\` erklärt einen Befehl, \`help\` listet alle.

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
| \`help [befehl oder thema]\` (auch \`hilfe\`, \`?\`) | Hilfe im Spiel; Themen wie \`help leuchtfeuer\`, \`help handel\`, \`help bauen\` |

## Für Builder {#builder}

Wer die Stufe *Builder* hat, formt die Welt: \`dig\`/\`grabe\`, \`open\`/\`öffne\`, \`create\`/\`erschaffe\`, \`spawn\`/\`erzeuge\`, \`set\`/\`setze\`, \`tag\`/\`markiere\`, \`lock\`/\`sperre\`, \`examine\`/\`untersuche\`, \`destroy\`/\`vernichte\`. Die Befehle erscheinen nur in der \`help\` dieser Figuren; \`help bauen\` erklärt sie.`,
			en: `## How commands work {#how}

Type them into the command line (Enter). Every command works **in English and in German**, with no switch: \`get driftwood\` and \`nimm holz\` are the same. Things are found by name or short name (\`wood\`, \`holz\`). You can type an exit's name alone (\`east\`). \`help <command>\` explains one command, \`help\` lists all.

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
| \`help [command or topic]\` (also \`hilfe\`, \`?\`) | In-game help; topics such as \`help leuchtfeuer\`, \`help handel\`, \`help bauen\` |

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
		id: "help.game.account",
		section: "play",
		title: { de: "Gast und Konto", en: "Guest and account" },
		short: {
			de: "Was ein Gast darf, wie man sich registriert und was dabei erhalten bleibt.",
			en: "What a guest may do, how to register and what is kept.",
		},
		body: {
			de: `## Gast {#guest}

Als **Gast** spielst du sofort, ohne Konto. Du kannst laufen, sammeln, das Feuer nachlegen, reden und alles ansehen. **Nicht möglich:** tauschen, handeln, Dinge weitergeben. Eine Gastfigur verfällt nach einigen Tagen ohne Spiel.

## Konto {#account}

Mit **„Registrieren, um den Fortschritt zu behalten“** in der Kopfzeile legst du ein Konto an (Benutzername und Passwort). Dabei bleiben **Figur, Gegenstände und Ruf** erhalten, du fängst nicht von vorn an. Danach kannst du dich jederzeit mit denselben Daten anmelden, auch an einem anderen Gerät.

## Abmelden {#logout}

„Abmelden“ beendet die Sitzung. Als Gast fragt das Spiel vorher, ob du dich erst registrieren möchtest, weil du sonst nicht zu dieser Figur zurückkommst.

## Datenschutz {#privacy}

Das Spiel speichert nur, was es braucht: Benutzername, ein gesalzener Passwort-Hash, deine Figur und ihren Fortschritt. Alle Texte der Welt werden als reiner Text angezeigt, nie als Code ausgeführt.`,
			en: `## Guest {#guest}

As a **guest** you play at once, without an account. You can walk, collect, feed the fire, talk and look at everything. **Not possible:** swapping, trading, handing things on. A guest character lapses after some days without play.

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
