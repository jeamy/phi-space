# Siedeln, Bauen und Gärtnern (Entwurf)

Stand 2026-10-28, überarbeitet 2026-10-29 (Logikfehler und Lücken der ersten Fassung). Gebaut sind der Chat zwischen
Spielern, Schritt 1 (Hütte und Baustelle) und Schritt 2 in drei Teilen (Beete, Samen, Gießen, Ernte,
Patenschaft; Zier- und Gemeinschaftsbeete, Kreuzen und Benennen, die Gärtnerin; Hasen, Zaun und Vogelscheuche; siehe
„Reihenfolge“); alles Weitere ist ein Vorschlag, wie Leuchtfeuer über Sammeln, Feuer und Handel hinaus wächst:
Gärten, Häuser, Werkstätten, Straßen, Kirchen, Kaufhäuser, später Eisenbahn. Er baut auf [spielidee.md](spielidee.md),
[welt.md](welt.md), [goetter.md](goetter.md) und [automaten.md](automaten.md) auf.

**Vorschlag: eine gemeinsame Aufbausimulation.** Am nächsten liegen Siedler- und Anno-artige Warenketten, die viele
gemeinsam bedienen. Von Civilization kommen nur die **Epochen**, als Fortschritt der ganzen Welt, nicht eines Spielers:
wenn genug gebaut und erhalten ist, schaltet die Welt die nächste Stufe frei. Von Age of Empires kommt nichts außer
dem Gefühl, dass Arbeit sichtbar die Karte verändert.

Der Zielkonflikt bleibt derselbe: was man sammelt, kann man ins eigene Haus stecken oder in das, was allen gehört
(Feuer, Straße, Kirche).

Zwei **gleichwertige** Wege tragen den Aufbau: **Bauten**, die bleiben und viele Hände brauchen, und **Gärten**, die
wachsen und tägliche Pflege fordern. Beide zählen gleichermaßen zum Fortschritt einer Insel — eine Siedlung erreicht
Dorf und Stadt aus Gärten ebenso wie aus Häusern, und die schönsten Orte des Archipels sind eher Gärten als
Prunkbauten. Die einen sind das große gemeinsame Werk, die anderen der leise Dauerrhythmus, der auch mit zwei, drei
Spielern die Welt lebendig hält.

## Chat zwischen Spielern (zuerst, gebaut)

Gemeinsam bauen heißt sich absprechen, auch über Inseln hinweg und mit jemandem, der gerade woanders steht. `say`
hört nur der Raum, ein Kanal (`channel hafen`) alle. Was fehlte, war das Gespräch zu zweit und in einer kleinen Gruppe.
Es kam deshalb **vor** allem anderen (Reihenfolge, Schritt 0). Gebaut seit 2026-10-29: `server/chat.ts`,
`client/chatcrypto.ts`, `client/useChat.ts`, `client/ChatPanel.tsx`, Test `tests/chat.test.ts`.

**Zu zweit**

- Befehl `chat <name> <text>` (auch `tell`, `flüstere`). `chat <name>` ohne Text öffnet nur das Gespräch.
- Auf der Karte öffnet die rechte Maustaste (auf dem Telefon langes Tippen) über einer Figur ein Menü: **Chat mit …**
  und **… in „Gruppe“ einladen** (je Gruppe, in der man ist), dazu Anschauen und Handel anbieten. NPCs haben keinen
  Chat-Eintrag.
- Die Seite zeigt jedes Gespräch als eigenen Reiter neben dem Log, mit Zähler für Ungelesenes (was gelesen ist, merkt
  sich der Browser). Der Reiter „Chats“ ist die Übersicht: Verschlüsselung, Einladungen, Gruppen, neues Gespräch,
  Ignorierte. Ein geschlossener Reiter kommt mit der nächsten Nachricht wieder.
- Ein Gespräch geht über Regionen hinweg. Ist der andere nicht online, bleibt die Nachricht liegen (Lease sieben Tage,
  je Leser die letzten 50 eines Gesprächs) und erscheint beim nächsten Anmelden; jede Seite bekommt den Verlauf.

**In der Gruppe**

- `gruppe neu <name>` gründet eine Gruppe; wer gründet, verwaltet sie (höchstens zehn je Konto).
- `gruppe lade <spieler> in <name>` (oder das Kartenmenü) schreibt eine Einladung mit Lease (ein Welttag; einladen darf
  jedes Mitglied). Der Eingeladene sieht sie im Log und im Reiter „Chats“ mit **Annehmen** und **Ablehnen**
  (`gruppe annehmen <name>`, `gruppe ablehnen <name>`); ohne Antwort läuft sie ab.
- Weitere Befehle: `gruppe verlasse <name>` (die Verwaltung geht an das älteste Mitglied, die letzte löst die Gruppe
  auf), `gruppe entferne <spieler> aus <name>` (nur wer verwaltet), `gruppe <name> <text>` oder der Reiter der Gruppe;
  `gruppe` allein zeigt die eigenen Gruppen. Beitritt, Austritt und Entfernen erscheinen als Hinweis in der Gruppe.
- Höchstens 20 Mitglieder.
- Eine Siedlung hat später ihre Gruppe von selbst: wer Siedler wird, ist Mitglied, wer es nicht mehr ist, nicht mehr.

**Ende-zu-Ende verschlüsselt**

- Nur die Mitglieder eines Gesprächs können es lesen, nicht der Server und nicht sein Betreiber.
- Jedes Konto hat ein Schlüsselpaar (ECDH P-256), im Browser erzeugt. Der private Schlüssel verlässt den Browser nur
  versiegelt mit dem **Chat-Passwort** (PBKDF2-SHA-256 mit 600 000 Runden, dann AES-GCM); der Server hält diese
  Sicherung und den öffentlichen Schlüssel (`ChatKey`), damit ein anderes Gerät denselben Schlüssel mit demselben
  Passwort entsperrt. Das Chat-Passwort ist nicht das Login-Passwort und geht nie an den Server. Auf dem Gerät liegt
  der Schlüssel nicht exportierbar in IndexedDB; Abmelden vergisst ihn.
- Eine Nachricht wird für jeden Leser einzeln versiegelt (AES-GCM, Schlüssel aus ECDH zwischen Absender und Leser über
  HKDF); die Zusatzdaten binden die Kopie an Nachricht, Absender, Leser und Gruppe. Der Server prüft nur, wer lesen
  darf, und speichert die versiegelten Kopien. Eine getippte Zeile `chat <name> <text>` versiegelt die Seite; eine
  unverschlüsselte Nachricht nimmt der Server nicht an.
- **Chat-Passwort vergessen heißt: die Verläufe sind verloren.** Niemand kann sie wiederherstellen. Ein neuer Schlüssel
  liest nichts, was für den alten versiegelt wurde. Die Seite sagt das beim Einrichten und bietet **Verlauf sichern**
  (eine Textdatei der geöffneten Gespräche) an; das Chat-Passwort lässt sich ändern, solange man es kennt.
- Jedes Gespräch zeigt den **Fingerabdruck** des eigenen und des fremden Schlüssels. Wer sie außerhalb des Spiels
  vergleicht, weiß, dass niemand einen anderen Schlüssel dazwischengeschoben hat.
- Was der Server trotzdem sieht: wer mit wem wann schreibt, Gruppennamen und Mitglieder, die Hinweise der Gruppen
  (Beitritt, Austritt). Und er liefert den Code der Seite aus: ein Betreiber, der ihn heimlich ändert, könnte mitlesen —
  das gilt für jede Verschlüsselung im Browser. WebCrypto braucht HTTPS (oder `localhost`).

**Wo es liegt**

- Im **Konten-Space** (nano), als eigene Typen (`ChatMsg`, `ChatKey`, `ChatGroup`, `ChatMember`, `ChatInvite`,
  `ChatBlock`, `ChatReport`): er gilt über alle Regionen, nur der Web-Prozess erreicht ihn, und das Dashboard lässt ihn
  bewusst aus. Ein eigener Space `social` hätte einen dritten Socket, Port und Tunnel gebraucht, ohne mehr Schutz.
- Chat geht nicht über den Welt-Worker: das Gateway fängt Chat-Zeilen und -Frames ab, bevor sie zur Welt gingen.
  Zugestellt wird über den Änderungsstrom des Konten-Space (auch Einladungen und Mitgliedschaften).

**Schutz**

- `ignoriere <name>` sperrt Nachrichten und Einladungen eines Spielers (auch in Gruppen bekommt er keine Kopie mehr);
  `ignoriere` allein listet die Gesperrten, `erlaube <name>` hebt es auf.
- Für Chat-Zeilen und -Frames gelten dieselben Grenzen je Konto wie für getippte Befehle (Gateway). Gäste dürfen
  chatten, aber niemanden in eine Gruppe einladen und keine Gruppe gründen.
- Gespräche erscheinen nicht im Log des Raums. Kein NPC und kein Modell liest sie, die Übersetzung sieht sie nie.
- **Melden** an einer Nachricht schickt ihren Text, wie der Leser ihn entschlüsselt hat, mit Absender an die Admins
  (Admin-Fenster, „Gemeldete Nachrichten“, 30 Tage). Der Server kann den Text nicht gegen die versiegelte Kopie prüfen;
  Admins sehen sonst keine Gespräche.

## Licht ist Bauland

Gebaut wird nur, wo ein Feuer den Nebel fernhält. Ein Bau braucht Licht, und jeder Bau verbraucht etwas davon:

- Ein **Feuer** deckt Räume ([welt.md](welt.md)); ein **Leuchtturm** (Ausbau eines Feuers) deckt mehr Räume oder
  brennt länger je Brennstoff.
- Erlischt das Feuer, verfallen die Bauten in seinem Licht nicht sofort, aber sie **arbeiten nicht** (keine Ware, kein
  Markt), und der Nebel nagt an ihnen (Verfall, unten).
- **Licht reicht für eine bestimmte Menge Bauten.** Jedes Feuer trägt **Lichtpunkte** (Beispiel: 20, ein Leuchtturm 50),
  verteilt über alle Räume, die es deckt. Jeder Bau und jeder Garten belegt davon so viele, wie er zum Bestand der Epoche
  zählt (unten, „Epochen“); deckt ein Raum zwei Feuer, zählen beide zusammen. Ist das Licht voll, nimmt `bau` dort
  keinen neuen Plan an, bis ein Leuchtturm oder ein weiteres Feuer dazukommt. Der Brennstoff des Feuers wird davon
  nicht schneller verbraucht: der Preis des Bauens ist die Grenze, nicht ein schnelleres Feuer.
- Damit bleibt die Kernidee tragend: Wer baut, hat einen Grund, das Feuer zu halten — und, wer mehr bauen will, einen
  Grund für den Leuchtturm.

## Was man baut und anlegt

Nach Epochen; jede Stufe setzt die vorige voraus. Bauten und Gärten stehen in denselben Tabellen, weil sie
gleichwertig sind — die Gartenzeilen führt der Abschnitt „Gärten“ weiter unten aus.

### Epoche 1: Hütten (Fischerdorf)

| Bau | Kosten (Beispiel) | Wirkung |
| --- | --- | --- |
| **Hütte** | 6 Treibholz, 2 Tangseile | eigener Ort: Truhe (Lager), Ausloggen ohne Verlust, Rückkehrpunkt |
| **Trockengestell** | 4 Holz | macht aus Tang langsam Tangseil |
| **Räucherei** | 8 Holz, 4 Steine | Fisch → Räucherfisch (Ware, Nahrung für Arbeiter) |
| **Steg** | 6 Holz | eine Anlegestelle am Ufer des Raums (kein neuer Raum und kein Ausgang): Boote legen dort an, von dort wird gefischt |
| **Regentonne** | 3 Holz, 1 Tangseil | Wasser zum Gießen: füllt sich jeden Welttag um eine Kanne, bei Sturmflut ganz; ohne sie gibt es vor dem Brunnen kein Wasser |
| **Nutzgarten** | eine freie Fläche, ein Spaten (Rezept: 2 Treibholz, 1 Tangseil) | das erste Beet: Gemüse und Kräuter, Pflege in Stufen |
| **Hühnerstall** | 4 Holz | ein paar Hühner: Eier jeden Welttag; fressen Tang und Gemüsereste aus dem Nutzgarten, ab Epoche 2 auch Körner |

### Epoche 2: Dorf (Werkstätten und Wege)

| Bau | Wirkung |
| --- | --- |
| **Werkstatt** (Tischlerei, Seilerei, Schmiede) | Rezepte, die es ohne sie nicht gibt; ein Werkzeug hält dort länger |
| **Steinbruch** (an Felsen), **Lehmgrube**, **Ziegelei** | Stein, Lehm und Ziegel in Menge — Grundstoff der Bauten ab hier |
| **Pflasterweg** | Zellen, die man schneller begeht (ein Schritt kostet die Hälfte der Zeit) |
| **Lagerhaus** | gemeinsames Lager eines Dorfs: alle mit Recht legen ein und entnehmen (Treuhand wie beim Markt) |
| **Brunnen, Backhaus** | Wasser in Menge für Gärten und Ställe; Brot (unten, „Nahrung“) |
| **Äcker** | gemeinsame Fluren am Siedlungsrand: Getreide, Mais, Kartoffeln, Flachs — Bestellen und Ernte in Stößen |
| **Windmühle** | mahlt Korn zu Mehl für das Backhaus, in festem Takt, an Sturmtagen schneller (Wind als Wetter kommt erst mit den Jahreszeiten) |
| **Gemeinschaftsgarten, Obstwiese** | Beete für alle mit Recht; Bäume, die über viele Spieltage wachsen |
| **Gehege, Stall** | Schafe (Wolle → Tuch), Ziegen (Milch), Enten und Gänse (Eier, Daunen); fressen Heu und Rüben von den Fluren |
| **Kapelle** | sichtbarer Ort der Götter ([goetter.md](goetter.md)): Opfergaben, Segen (Lease), Fest — freiwillig, die Götter wirken auch ohne |

### Epoche 3: Stadt (Handel und Verwaltung)

| Bau | Wirkung |
| --- | --- |
| **Kaufhaus** | ein Laden mit Vorrat und eigenen Preisen (unten, „Siedlungen und Besitz“), Lieferaufträge an die Tafel |
| **Kontor, Bank** | Wechsel, Kredit mit Frist (eine Schuld ist ein Entry mit Lease, das Pfand liegt in Treuhand beim Kontor: wird zurückgezahlt, geht es an den Schuldner zurück; läuft die Frist ab, geht es an den Gläubiger) |
| **Kirche, Glockenturm** | Fest der ganzen Insel; die Glocke ruft (Nachricht an alle Räume, ein Termin der Weltuhr); kann man bauen, muss man nicht |
| **Rathaus** | Regeln einer Siedlung: Zonen und Baurecht, Steuern ins Lagerhaus, Abstimmungen (Vorschläge und Stimmen wie auf der Arbeitstafel von codemode-chat) |
| **Werft** | größere Boote: mehr Ladung, neue Fahrten in den Nebel ([spielidee.md](spielidee.md), „Erkunden“) |
| **Taubenschlag** | Brieftauben tragen kleine Briefe zwischen den Inseln — Post vor der Fahrplan-Fähre |
| **Brauhaus** | Bier aus Malz und Hopfen — Festgetränk, Handelsware |
| **Glashütte** | Glas aus Sand — Fenster, und das Gewächshaus der Gärtner |
| **Park, Gewächshaus** | Ruf der Siedlung, Platz für Feste; ganzjähriges Wachsen hinter Glas |
| **Leuchtturm** | Ausbau eines Feuers (oben) |

### Epoche 4: Netz (Infrastruktur)

| Bau | Wirkung |
| --- | --- |
| **Straße** | verbindet Räume über Inselgrenzen nicht, aber innerhalb einer Insel; Karren fahren darauf |
| **Karren, Fuhrwerk** | ein Automat ([automaten.md](automaten.md)) mit Ladung, der eine Route fährt |
| **Fährlinie mit Fahrplan** | Fähren fahren zu Zeiten, die Überfahrt ist ein eigener Raum ([welt.md](welt.md), „Noch offen“) |
| **Inselbahn** | Gleise sind Zellen, ein Zug ist ein Automat mit Fahrplan; Bahnhöfe sind Ausgänge; Ladung wie ein Lagerhaus auf Rädern |
| **Signalfeuer-Kette** | Feuer, die sich gegenseitig sehen, teilen ihr Licht: eine Kette brennt nur, solange jedes Glied brennt |
| **Botanischer Garten** | Sammelort seltener Sorten, Saatgut-Archiv aller Inseln, Ort der Züchter |

Eisenbahn passt zum Ton (Inseln, Nebel, Holz und Kohle), aber erst spät: sie lohnt erst, wenn es viele Waren gibt, die
weit müssen. Kohle (aus dem Torfmoor, später Bergbau) wäre ihr Brennstoff und ein neuer Zielkonflikt mit dem Feuer.

### Rohstoffe und woher sie kommen

Jede Epoche braucht ihre Grundstoffe, und einige liegen nur dort, wo erst erschlossen werden muss — so bleibt Bauen
mit dem Erkunden verzahnt:

| Stoff | Quelle | Ab wann |
| --- | --- | --- |
| Treibholz, Tang, Muscheln | Strände (heute) | Start |
| Steine | Geröll an Klippen und Felsküsten sammeln (wie Strandgut, spärlich), ab Epoche 2 der Steinbruch in Menge | Epoche 1 |
| Lehm, Ziegel | Lehmgrube am Moor oder Ufer, Ziegelei brennt Ziegel (braucht Brennstoff) | Epoche 2 |
| Torf, Kohle | Torfstich im Torfmoor — Brennstoff wie Baustoff; später Bergbau auf einer Nebeninsel | Epoche 2/4 |
| Eisenerz | selten in Klippen und alten Wracks; eine Mine ist ein Bau auf einer späteren Insel | Epoche 3 |
| Sand → Glas | Sand sammeln an Dünen, Glashütte schmilzt ihn | Epoche 3 |
| Fisch | am Steg mit dem Netz (neues Rezept: 3 Tangseile; heute ist das Netz nur Handelsware) | Epoche 1 |
| Samen, Setzlinge | die wilde Flora der Räume (`flora`: Blumen, Büsche, Bäume) gibt beim Sammeln selten Samen; dazu Gärtnerin und Handel | Epoche 1 |

Was knapp ist, wandert durch den Handel: Kupferhafen bleibt arm an Holz, eine Bergbau-Insel arm an Nahrung —
Warenketten laufen über Märkte und Fähren, nicht über Lager aus dem Nichts.

### Boote und Fischerei

- Am **Steg** wird gefischt (`wirf netz`): das Netz (Rezept oben) holt in Weltzeit-Takten Fisch,
  selten einen Fund — kleiner, leiser Ertrag neben dem Strandgut.
- Ein **Ruderboot** ist ein Ding (Epoche 2, Werkstatt), das von jedem Steg der Insel zu jedem anderen fährt (ein
  Ausgang, den nur ein Boot öffnet, wie eine Fähre ohne Fahrplan);
  die **Werft** (Epoche 3) baut Segelboote für weiter und schwerer. Ein Boot hat Besitz wie eine Hütte und eine
  eigene kleine Ladeluke.

## Epochen: was die Stufe freischaltet

Eine Epoche gilt **je Insel** — nicht je Siedlung oder Raum — und zählt den **gehaltenen Bestand** der ganzen Insel:
Bauten mit gepflegtem Zustand und bezahltem Unterhalt, gewichtet nach Größe. Bauten und Gärten zählen
**gleichermaßen**. Beispielwerte (Weltkonfiguration):

| Punkte | Bauten | Gärten |
| --- | --- | --- |
| 1 | Hütte, Trockengestell, Regentonne, Steg, Hühnerstall | gepflegtes Beet, bestellte Flur |
| 2 | Räucherei, Brunnen, Backhaus, Windmühle, Gehege | Obstwiese, Hecke, Kräutergarten |
| 3 | Werkstatt, Steinbruch, Lehmgrube, Ziegelei, Lagerhaus, Kapelle, Taubenschlag | Gemeinschaftsgarten, Park |
| 5 | Kaufhaus, Kontor, Kirche, Rathaus, Werft, Brauhaus, Glashütte, Leuchtturm | Gewächshaus, Botanischer Garten |

Eine Insel kann die Stadtstufe aus Gärten allein erreichen — ein Archipel aus Gartensiedlungen ist ein legitimer
Weg. Beispiel-Schwellen je Insel: Dorf ab 15 Punkten, Stadt ab 40, Netz ab 80. Eine Siedlung ist dafür keine
Voraussetzung (sie entsteht aus Hütten, unten); die Epoche zählt, was auf der Insel steht und gepflegt wird.

- Ein `Epoch`-Entry je Insel hält die Stufe; Baupläne und Rezepte prüfen sie.
- **Rückfall von selbst:** Weil nur gehaltener Bestand zählt, verliert eine Insel die Stufe wieder, wenn zu viel
  verfällt — ohne zweite Mechanik. Bauten der höheren Stufe bleiben stehen und arbeiten weiter, solange ihr Zustand
  und ihr Unterhalt reichen; gesperrt sind nur neue Pläne dieser Stufe, bis der Bestand wieder reicht. So reißt ein
  Rückfall keine Warenkette ab, er hält nur das Wachsen an.
- Die Zählung läuft als Ticker im Welt-Worker (einmal je Welttag und nach jedem fertigen oder verfallenen Bau) und
  schreibt den `Epoch`-Entry nur, wenn sich die Stufe ändert.
- Die Schwellen stehen in den `Setting`-Entries (Konfigurationsfenster wie in
  [automaten.md](automaten.md#einstellungen-für-betreiber)) und lassen sich je Server an die Spielerzahl anpassen.

## Bebauung: Baurecht, Fußabdruck, Abriss

- **Sperrzellen:** Ausgänge, die Zelle eines Feuers, Wege, Stege und Marktplätze sind nie bebaubar; `bau` prüft das,
  bevor es die Fläche belegt. Niemand kann eine Tür, ein Feuer oder den Weg zubauen.
- **Fußabdruck:** Jeder Plan hat eine Form (Hütte 2×2, Kaufhaus 4×3, Kirche 3×5 …) und eine Ausrichtung — die Tür
  zeigt auf Weg oder Platz, wenn einer grenzt. `bau` belegt alle Zellen der Form in einer Transaktion; ein
  Teilstück gibt es nie.
- **Baurecht vor dem Rathaus:** Wer auf freier, lichter, ungesperrter Fläche baut, bebaut sie (Claim per `unique`).
  Das Rathaus (Epoche 3) kann später Zonen setzen — bebaubar, Grünzone, Wegerecht — und gegen Stimmen auch den
  Abriss einer Fehlstellung anordnen. Bis dahin gilt: bauen, wo es nicht sperrt.
- **Abriss:** Besitzer (oder Rathaus-Beschluss) reißt ab; ein Teil des Materials geht zurück ins Lager oder an den
  Abrissenden, und die Fläche ist in derselben Transaktion frei (keine Ruine: die gibt es nur beim Verfall). Ein
  Inhalt (Truhe) geht an den Besitzer oder, fehlt der Platz, in einen Nachlass wie beim Verfall.
- **Hütte innen oder außen:** Kleine Bauten (Hütte, Gartenhaus, Schuppen) sind Fläche, kein eigener Raum: Truhe und
  Rückkehrpunkt hängen am Bau (`oeffne truhe`, `ruhe`). Erst Bauten mit Publikum — Kaufhaus, Kirche, Rathaus,
  Werfthalle — bekommen einen eigenen Raum hinter einer Tür mit Lock. Sonst hätte jede Insel Dutzende fast leerer
  Räume.
- **Besitz wechselt:** `uebergib`/`verkaufe` auf eine Fläche ist eine Transaktion wie `offer`: Grund und Bau gehen
  gemeinsam, Mitbewohner laufen über Rechte (Locks). Was verfällt, wird frei — der Claim läuft mit dem Bau.
- **Räume wachsen, neue entstehen:** Ist ein Raum voll, wächst er um einen Streifen Zellen — die Welt legt neues
  Bauland an denselben Raum, die Claims bleiben; der Streifen kommt an eine Seite ohne Ausgang und ohne Strand,
  Ausgänge, Feuer und Strände der Weltdatei bleiben, wo sie sind. Und es entstehen neue Räume: die Weltdatei oder ein Gott
  (Befugnis `insel`, [goetter.md](goetter.md)) schafft neues Bauland, erreichbar von einem brennenden Feuer aus.
  Ein voller Raum ist also beides: Signal zum Wachsen und Signal zum Erweitern.

## Gärten

Gärten stehen den Bauten gleich — kein Beiwerk, sondern der zweite, ebenso tragende Weg des Aufbaus. Sie sind der
leiseste, häufigste Bau, für Gäste wie für Siedler: Wer noch keine Hütte hat und nichts besitzen darf, kann schon gießen und ernten helfen. Ein Garten
macht Zeit sichtbar, und Zeit ist das, was der Space mit Leases ohnehin trägt. Und er macht Geschmack sichtbar:
Zwei Dörfer mit denselben Hütten unterscheiden sich in ihren Beeten, ihren Bäumen und ihren Parks mehr als in
jedem Bau. Sie reichen vom Fensterkasten über den Nutzgarten bis zur gemeinsamen Flur, die eine ganze Siedlung
ernährt.

### Arten von Gärten

| Art | Wo | Was wächst |
| --- | --- | --- |
| **Nutzgarten** | vor der Hütte, hinter dem Haus | Gemüse (Kartoffel, Kohl, Bohnen, Möhren, Kürbis), Kräuter |
| **Ziergarten** | Hof, Fensterkasten, Wegrand | Blumen (Tulpe, Rose, Strandnelke, Dünenrose, Nebelblume nur auf Nebelholm) |
| **Gemeinschaftsgarten** | Dorfplatz, Kapelle | Gemüse und Blumen für alle mit Recht; Gießdienst geteilt |
| **Obstwiese** | größere Flächen am Ortsrand | Apfel-, Birnen-, Quittenbäume; wachsen über viele Spieltage |
| **Acker** | Fluren am Rand der Siedlung | Getreide (Weizen, Roggen, Hafer, Gerste), Mais, Kartoffeln, Rüben, Flachs, Hopfen — eine Frucht je Flur |
| **Park** | Stadt, Epoche 3 | Alleen, Beete, Brunnen und Bänke: Ruf der Siedlung, Platz für Feste |
| **Hecke, Gehölz** | an Küsten und Wegen | bricht den Wind der Sturmflut, schützt Beete und Bauten dahinter |
| **Kräutergarten** | an der Kapelle | Heilkräuter (Heiltrank), Opferkräuter, Farbkräuter |
| **Gewächshaus** | ab Epoche 3, braucht Glas | wächst unabhängig von der Jahreszeit, kostet etwas Brennstoff |

### Wie ein Garten lebt

- **Beet anlegen**: eine Fläche im Licht umgraben (Spaten, `grabe`), mit `unique` auf die Zellen wie jeder Bau. Kleine
  Beete vor der Hütte, Gemeinschaftsgärten an Dorfplatz und Kapelle, Obstwiesen, Parks in der Stadt.
- **Säen und pflanzen**: Samen, Zwiebeln, Setzlinge und junge Bäume sind Dinge (die ersten aus der wilden Flora der
  Räume, Rohstoffe oben); `pflanze tulpe` setzt sie in eine
  freie Zelle des Beets. Daraus wird eine **Pflanze**, die in Stufen wächst (Saat, Keim, Blüte oder Frucht, verwelkt),
  jede Stufe eine Frist in Weltzeit ([weltzeit.md](weltzeit.md)).
- **Pflege**: Gießen (`gieße`, Wasser aus Regentonne oder Brunnen; Meerwasser taugt nicht) und Jäten erneuern die Lease
  der Pflanze; wer sie
  vergisst, lässt sie welken. Nebel lässt Pflanzen langsamer wachsen, Licht schneller: Gärten sind ein weiterer Grund,
  das Feuer zu halten. Ein Garten ist Teamarbeit wie ein Feuer (Gießdienst, Beiträge sichtbar).
- **Patenschaft**: `pate` auf einem Beet erlaubt einer anderen Figur — einem Mitspieler oder dem Dorfgärtner
  (Skript-NPC) — das Gießen und Jäten dort; sichtbar am Beet-Schild, jederzeit kündbar. So bleibt ein Beet gepflegt,
  wenn der Besitzer Tage aussetzt: asynchrone Hilfe, ohne dass Besitz wandert.
- **Ernten**: Ernte ist ein `take`: zehn Leute am selben Apfelbaum, jeder Apfel geht an genau einen. Ein privates Beet
  ernten Besitzer und Pate in die eigene Tasche. Ein Gemeinschaftsbeet ernten alle mit Recht, aber in die Truhe des
  Beets; aus ihr nimmt jeder nach der Quote des Lagerhauses (unten, „Siedlungen und Besitz“).
- **Vermehren und züchten**: Blühende Pflanzen geben Samen; zwei Sorten nebeneinander kreuzen sich manchmal zu einer
  neuen Farbe oder Form (seltene Sorten, Züchtung). Wer eine neue Sorte kreuzt, darf sie benennen — ihr Name und der
  des Züchters bleiben im Prototyp. Bäume wachsen über viele Spieltage und bleiben lange; ein alter Baum steht im
  Ruf seiner Pflanzer.
- **Kaufen und tauschen**: Samenhändler auf den Märkten (ein neuer NPC, Gärtnerin), Blumen am Marktbrett, Tausch von
  Ablegern zwischen Spielern (`offer` wie heute). Seltene Sorten haben Preise; die Gärtnerin hängt selbst Aufträge
  aus („suche eine Nebelblume“) und ist so eine Quest-Quelle ohne Modellkosten. Sträuße sind Geschenke an NPCs und
  Opfer an der Kapelle.
- **Wozu**: Gemüse ist Nahrung (Räucherei, Backhaus, Arbeiter), Kräuter sind Zutaten (Heiltrank, **Farbstoffe** für
  Banner und Feste), Obstbäume liefern Holz, wenn man sie fällt (Zielkonflikt: Holz jetzt oder Äpfel jede Reifezeit),
  Blumen schmücken (Ruf einer Siedlung, Feste, Blumenschau mit Preis der Tafel), Hecken und Bäume brechen den Wind
  der Sturmflut.

### Äcker und Getreide

Äcker sind die große Schwester der Beete: dieselben Stufen, dieselbe Pflege — aber über Fluren statt Zellen, in
Stößen statt täglich, und als Gemeinschaftswerk wie eine Baustelle.

- **Flur anlegen**: ein Acker ist eine zusammenhängende Fläche am Rand der Siedlung (z. B. 4×4 bis 8×8 Zellen),
  `unique` wie jeder Bau, aber **eine** Entry über die ganze Flur — nicht je Zelle. So bleiben hundert Ackerzellen
  so billig wie ein Beet. Eine Flur trägt **eine** Frucht: Weizen, Roggen, Hafer, Gerste, Mais, Kartoffel, Rübe,
  Flachs oder Hopfen.
- **Bestellen und ernten**: Ein Acker braucht wenig tägliche Pflege, aber zwei Stöße Arbeit: `bestelle` (pflügen,
  säen — Saatgut von der Gärtnerin oder der eigenen Ernte) und die **Ernte** im Erntefenster weniger Spieltage.
  Bis es Jahreszeiten gibt, öffnet das Erntefenster eine feste Frist nach dem Bestellen (je Frucht).
  Beides sind Arbeitspunkte wie an der Baustelle: der Ernteeinsatz ist ein Gemeinschaftsereignis — Schwengernte,
  bei der zehn Hände in einer Stunde einbringen, was einer Tage bräuchte. Wer das Fenster verpasst, verliert einen
  Teil des Ertrags an die Flur. Tagelöhner und Automaten helfen mit (Arbeitspunkte, derselbe Fremdarbeits-Deckel).
- **Fruchtfolge**: Dieselbe Frucht zweimal hintereinander auf einer Flur gibt einen müden Boden und wenig Ertrag;
  Getreide – Kartoffel – Brache (oder Rübe) bleibt gesund. Der Zähler steht an der Flur, ein Blick genügt.
- **Warenketten**: Getreide → **Windmühle** → Mehl → **Backhaus** → Brot (macht satt, unten „Nahrung“).
  Flachs → Leinen → Segel für die Werft und Netze für die Fischerei. Gerste und Hopfen → **Brauhaus** → Bier
  (Fest, Handelsware). Rüben und Heu → Futter für Schafe und Ziegen, Körner für die Hühner. Die Mühle mahlt in festem
  Takt und an Sturmtagen schneller; Flauten gibt es erst mit dem Wetter der Jahreszeiten.
- **Zielkonflikt**: Korn ist Brot, Saatgut und Bier zugleich — was man vermahlt, sät man nicht.

### Tiere auf dem Hof

Tiere kommen früh, nicht erst spät: schon der Hühnerstall des Fischerdorfs. Ein Tier ist eine kleine Figur mit
Gehege (eigene Zelle oder Fläche), einer **Futter-Lease** — frisst es nichts, gibt es nichts mehr (Eier, Milch,
Wolle), bis wieder gefüttert wird — und einem Ertrag, den man wie eine Ernte `take`n darf.

- **Hühner** (Epoche 1): Eier jeden Welttag, fressen Tang und Gemüsereste, ab Epoche 2 Körner von den Äckern — der
  erste Schritt vom Sammeln zum Halten.
- **Enten, Gänse** (Epoche 2, Gehege): Eier und Daunen (warmes Bettzeug, später Kleidung); die Gänse schnattern bei
  Fremden und Nebelwesen — die lebende Wache des Hofes.
- **Katze** (Epoche 2): fängt Mäuse in Haus und Lager — Getreide und Vorrat verderben langsamer, wo eine Katze jagt.
  Sie gehört keinem Gehege, sondern dem Hof: sie streunt selbstständig und bleibt bei der Figur, die sie füttert.
  Gesellschaft wie der Hund.
- **Schafe, Ziegen** (Epoche 2, Gehege): Wolle → Tuch am Webstuhl in der Werkstatt, Milch → Käse; fressen Heu und
  Rüben von den Fluren — die Äcker füttern den Hof.
- **Hund** (Epoche 2): folgt einer Figur, warnt vor Nebelwesen — Gesellschaft statt Nutzen.
- **Tauben** (Epoche 3, Taubenschlag): Brieftauben tragen kleine Briefe zwischen Siedlungen und Inseln — Post lange
  vor der Fahrplan-Fähre. Eine Taube fliegt immer heim zu ihrem Schlag; wer schreiben will, trägt sie mit.
- **Singvogel** (selten, ab Epoche 3): eine Drossel oder ein Kanarienvogel im Käfig singt im Haus — kein Nutzen
  außer Leben und Ruf; ein Geschenk der Vogelhändlerin am Markt.
- **Falke** (selten, ab Epoche 3): folgt einer Figur und holt Kleines aus dem Nebelrand zurück — ein Begleiter für
  Strandläufer.
- **Ochse, später Pferd** (Epoche 3/4): Zugtier für Karren — ein lebendes Fuhrwerk vor dem mechanischen.

Wilde Vögel gehören nicht in den Stall, sondern in die Welt: **Möwen** kreisen dort, wo die Flut gerade Strandgut
brachte (ein Hinweis statt einer Karte), **Reiher** stehen in den Salzwiesen, **Papageientaucher** nisten auf
Nebelholm, und mit den Jahreszeiten ziehen Schwärme — der Herbstflug ist Kalender und Ankündigung des Erntefests.

Tiere sind keine Kämpfer und kein Viehmarkt im Großen; sie halten den Hof lebendig und geben den Äckern einen
zweiten Abnehmer. Ein „Stallknecht“-Automat (füttern, sammeln) ist eine naheliegende Vorlage.

### Parks und was sie der Siedlung geben

Ein Park ist ein öffentlicher Garten: Alleen aus Bäumen, Beete, ein Brunnen, Bänke. Er arbeitet nichts her, aber er
zählt dreifach zum gehaltenen Bestand der Epoche, gibt Rufpunkte an die Pflegenden und ist der Platz für Feste —
die **Blumenschau** (seltene Sorten werden gezeigt, die Tafel vergibt einen Preis), das **Erntefest** (nach der Ernte
der Fluren einer Insel, mit den Jahreszeiten im Herbst),
Hochzeiten und Markttage. Zwischen Siedlungen ist der schönste Park der gewaltfreie Wettbewerb, den der Archipel
verträgt.

### Jahreszeiten (später)

Was wann blüht, Frost im Winter, Ernte im Herbst; ein Erntefest der Insel an der Kirche. Ein Saatkalender der
Gärtnerin sagt, was sich jetzt lohnt — siehe [weltzeit.md](weltzeit.md).

### Automaten im Garten

Ein Gießroboter ist ein naheliegender erster Automat ([automaten.md](automaten.md)), mit Wasser als Budget; ein
„Beethelfer“-Vorlage (gieße, jate, ernte in die Beet-Truhe) gehört zu den Beispielen.

| Gartenmechanik | Space-Operation |
| --- | --- |
| Pflanze wächst | Stufe als Entry, nächste Stufe ein Termin der Weltuhr |
| Gießen, Jäten | `renew` der Lease der Pflanze |
| Welken | Lease läuft ab, die Welt schreibt eine welke Pflanze (oder Kompost) |
| Ernte | `take` jeder Frucht: genau einer bekommt sie |
| Kreuzung | Ticker liest Nachbarn im Beet, schreibt selten eine neue Sorte als Samen |
| Patenschaft | `locks` auf dem Beet erlaubt `renew` durch den Paten |
| Neue Sorte | Prototyp-Entry mit Name und Züchter, `unique` auf den Namen |
| Park-Ruf | Siedlungszähler liest gepflegte Beete des Parks |
| Gewächshaus | Bau mit eigenem Brennstoff-Lease wie ein Feuer, nur kleiner |
| Acker (Flur) | eine Entry über den Zellbereich, `unique` wie ein Bau — nicht eine Entry je Zelle |
| Bestellen, Ernte | Arbeitspunkte wie an der Baustelle; Erntefenster als Termin der Weltuhr |
| Fruchtfolge | Zähler an der Flur-Entry (letzte Frucht, letzter Ertrag) |
| Windmühle | Ticker mahlt im festen Takt, schneller während einer Sturmflut |
| Tier im Gehege | kleine Figur mit Futter-Lease; Ertrag als `take` mit Frist |
| Fest, Regatta | Termin der Weltuhr; Wertung und Rang als Entries an der Tafel |
| Automat (Körper) | `craft` aus drei Teilen; Programm läuft im Sandbox, Öl-Lease als Tank |

Viele Gärten heißen viele Entries mit Lease und Termin. Eine Pflanze schreibt nur, wenn sie die Stufe wechselt oder
gegossen wird (das Gießen ist ein `renew`, also auch ein Schreiben), nie je Tick; die Stufen eines Beets laufen über
**einen** Termin je Beet, nicht je Pflanze. So belasten 10 000 Pflanzen den Space nicht stärker als ein paar Dutzend
Figuren — gezählt werden muss das Gießen trotzdem (Abnahme unten).

## Wild im Nebel: Mäuse, Hasen, Rehe, Füchse

Der Nebel bedroht nicht nur die Wege. Aus ihm kommt das Wild, das an dem nagt, was eine Siedlung anbaut und hält. Es
ist kein Gegner, gegen den man kämpft: man vertreibt es, zäunt ein, hält Hund und Katze und vor allem das Feuer. So
bleibt die Kernidee tragend: **wer das Feuer hält, schützt Hof und Felder.**

| Tier | Ziel | Schaden | Schutz |
| --- | --- | --- | --- |
| **Mäuse** | Getreidespeicher, Lagerhaus, Truhen mit Korn oder Mehl | fressen einen Teil des Vorrats (je Besuch wenige Stück) | Katze im Bau, Mausefalle (Rezept), Speicher aus Stein |
| **Hasen** | Beete, Gemüse, junge Pflanzen | fressen eine Pflanze an: sie fällt eine Wachstumsstufe zurück, ein Setzling ist weg | Zaun, Hecke, Hund |
| **Rehe** | Felder (Getreide, Rüben), Obstwiese | fressen sich an einer Flur satt: ihr Ertrag sinkt; junge Bäume werden verbissen | Zaun um die Flur, Vogelscheuche (hält eine Weile), Hund |
| **Füchse** | Hühnerstall | holen ein Huhn (es ist weg, der Stall gibt weniger Eier) | Stall mit Tür und Zaun, Hund, nachts das Feuer |
| **Möwen** (an der Küste) | Räucherei, Fisch am Steg | stehlen Fisch | Netz über dem Gestell |

- **Der Nebel macht es ihnen leicht.** Wie oft Wild kommt, hängt an der Nebelstufe des Raums: bei Stufe 0 (das Feuer
  brennt) bleibt es fern, bei 1 kommt es selten, bei 2 öfter, bei 3 oft. Nachts (Weltuhr) mehr als am Tag; Füchse fast
  nur nachts. Ein erloschenes Feuer kostet also nicht nur den Weg, sondern auch die Ernte.
- **Sichtbar und verscheuchbar.** Ein Tier ist eine kleine Figur auf der Karte (Skript, kein Modell, kein Konto). Es
  kommt vom Rand des Raums, läuft zu seinem Ziel und frisst dort nach einer kurzen Frist. Wer vorher bei ihm ist,
  verscheucht es (`scheuche <tier>`, oder ein Klick auf das Tier): es flieht in den Nebel, nichts ist verloren. Wer
  zuschaut, kann es retten; wer nicht da ist, braucht Zaun, Hund, Katze oder Licht.
- **Kein Kampf, keine Strafe für Abwesende über das Maß.** Je Besuch geht wenig verloren, je Raum ist die Zahl der
  Tiere gedeckelt, und ein geschützter Hof verliert nichts. Ein Tier frisst nie das Letzte (der letzte Setzling, das
  letzte Huhn bleibt), damit niemand bei Rückkehr vor dem Nichts steht.
- **Schutzbauten** kommen damit in die Pläne: Zaun und Vogelscheuche (Epoche 1, Holz und Tangseil), Mausefalle
  (Rezept), Katze und Hund (Tiere, Epoche 2, aus dem Handel oder vom Hof). Ein Zaun ist eine Reihe von Zellen wie ein
  Weg, mit einer Pforte (Durchgang für Menschen, nicht für Wild).
- **Die Nebelwesen** ([spielidee.md](spielidee.md)) bleiben das Fernere: in Räumen ohne jedes Feuer bei Stufe 3,
  nachts, als Hindernis auf den Wegen; Kampf gegen sie nur im optionalen Modul K ([phasen.md](phasen.md)). Das Wild ist
  der Alltag, die Nebelwesen sind die Ausnahme.
- **Technik:** Ein Wild-Ticker im Welt-Worker sieht nur Räume mit Gärten, Fluren, Ställen oder Speichern (sonst keine
  Last) und würfelt je Raum nach Nebelstufe und Tageszeit. Ein Tier ist ein Entry mit Lease (es geht von selbst, wenn
  niemand es sieht); sein Fressen ist eine Transaktion wie jede Ernte (`take` der Pflanze, des Korns, des Huhns), also
  nie doppelt und nie halb. Verscheuchen ist ein `take` des Tiers: wer zuerst kommt, rettet.

## Nahrung (später)

Backhaus, Räucherei, Brot und Eier versprechen einen Nutzen; ohne ihn wären sie nur Handelsware. Vorschlag, bewusst
klein: **Sattsein** ist ein Entry mit Lease an der Figur (essen erneuert ihn, Brot länger als ein Ei). Wer satt ist,
dessen Arbeitspunkte an Baustelle und Flur zählen anderthalbfach und klingen schneller ab. Hunger gibt es nicht:
niemand verliert etwas, wer nicht isst, arbeitet nur im Grundtakt. Eine Tragegrenze, die Essen anhebt, gibt es heute
nicht und kommt dafür nicht dazu.

## Wie ein Bau entsteht: die Baustelle

Kein Spieler baut allein ein Haus in einem Befehl. Eine Baustelle ist ein Ort, an dem viele zuarbeiten:

1. `bau hütte` auf freier, lichter Fläche legt eine **Baustelle** an: eine Entry mit dem Plan (was fehlt) und einer
   Lease (bleibt sie leer, verschwindet sie).
2. Jeder kann liefern (`liefere 3 treibholz an baustelle`) oder Arbeit leisten (`arbeite an baustelle`), auch aus zwei
   Zellen Abstand, damit eine Menge um die Baustelle Platz hat. Lieferung und
   Fortschritt sind eine Transaktion: die Ware ist weg, der Fortschritt steht, nie halb. **Arbeit ist eine Ressource
   wie Material:** `arbeite` setzt Arbeitspunkte (mit Abklingzeit je Figur und Spieltag); eine Hütte braucht etwa
   zwanzig — eine einzelne Figur schafft sie in Tagen, viele Hände in Stunden.
3. Was **zu viel** geliefert wird, geht an den Liefernden zurück (nichts geht verloren, nichts bleibt halb hängen).
4. Fehlt nichts mehr, wird aus der Baustelle der **Bau** (in derselben Transaktion). Wer beigetragen hat, steht auf
   einer Tafel am Bau (wie heute die Beiträge an einem Feuer: Ruf).
5. **Aufträge**: Eine Baustelle kann ihre fehlenden Teile und fehlende Arbeitspunkte an die Auftragstafel hängen
   ([phasen.md](phasen.md), Phase 4) — mit einem Lohn aus dem Lager der Siedlung oder dem Vorrat des Bauherrn.
   Sammler-NPCs, Tagelöhner und Automaten liefern dann zu (siehe „Wenige Spieler“).
6. **Abbruch**: `reisse baustelle ab` gibt das bisher Gelieferte ins Lagerhaus der Siedlung (oder an den Bauherrn,
   wenn es keine gibt). Eine verlassene Baustelle verfällt mit ihrer Lease.

## Verfall und Unterhalt

Ohne Senken wächst die Welt nur noch (mehr Entries, mehr Last, keine Ziele mehr). Deshalb verfällt, was niemand pflegt:

- Jeder Bau hat einen **Zustand** mit Lease. Nebel, Sturmflut und Zeit verringern ihn; `repariere` mit Material
  erneuert ihn (`renew`, wie das Nachlegen am Feuer).
- „Steht still“ heißt je Bau: keine Ware, kein Markt, keine Wirkung — aber der Bau bleibt begehbar und reparierbar.
  Ein stiller Pflasterweg ist wieder Weg wie jede Zelle.
- Ein verfallener Bau wird zur **Ruine** (gibt einen Teil des Materials zurück, kann wieder aufgebaut werden) und
  verschwindet nach einer Frist (Beispiel: zehn Welttage) ganz; mit ihr erlischt der Claim auf die Fläche.
- **Inhalt bleibt geschützt:** Verfällt ein Bau mit Inhalt (die Truhe der Hütte, das Lager eines Beets), wandert der
  Inhalt in ein `Nachlass`-Paket, das nur der Besitzer an der Ruine abholen kann — mit langer Lease, danach verfällt
  auch das. Verfall ist spürbar, aber kein Verlust auf einen Schlag.
- Gemeinsame Bauten (Straße, Kirche, Kaufhaus) kosten **Unterhalt** aus dem Lagerhaus ihrer Siedlung; fehlt er, hören
  sie auf zu arbeiten. Wiederauffüllen ist die leise Daueraufgabe einer Siedlung — wie das Feuer, nur im Monatstakt.

## Siedlungen und Besitz

- Eine **Siedlung** entsteht, wenn in einem Raum genug Hütten stehen (Beispiel: drei Hütten von mindestens zwei
  Besitzern); sie hat einen Namen und Regeln. Ihr erster gemeinsamer Bau ist meist das Lagerhaus (Epoche 2) — die
  Epoche zählt je Insel, eine Siedlung ist für sie keine Voraussetzung, und das Lagerhaus keine für die Siedlung.
- **Besitz** ist eine Entry mit `unique` auf die Fläche: zwei Spieler können nie dieselbe Zelle bebauen, auch wenn sie
  zugleich `bau` tippen.
- **Rechte** (wer im Haus etwas nehmen, auf der Fläche bauen, im Lagerhaus entnehmen darf) sind Locks wie heute an
  Ausgängen (`locks`, [phasen.md](phasen.md), Phase 1) und haben Stufen: **Fremder**, **Helfer** (darf liefern,
  arbeiten, Gemeinschaftsbeete gießen und in ihre Truhe ernten), **Siedler** (darf bauen und aus dem Lagerhaus
  entnehmen). Ein Gastkonto (ohne Registrierung) ist höchstens Helfer.
- Das **Lagerhaus** hält Treuhand, aber nicht blind: `lager log` zeigt die letzten Entnahmen (wer, was, wann — kurze
  Lease je Zeile), und je Recht-Stufe gilt eine Entnahme-Quote je Welttag. Ein Fremder kann das Dorflager nicht
  leerräumen; ein neuer Siedler nur wenig.
- **Steuern:** Das Rathaus setzt eine kleine Gebühr auf Umsätze des Kaufhauses und auf Entnahmen aus dem Lagerhaus.
  So fließt, was der Unterhalt frisst — Währungs- und Materialsenke zugleich.
- **Kaufhaus gegen Marktbrett:** Das Marktbrett bleibt, was es ist — Treuhand-Angebote zwischen Figuren, die
  ablaufen. Das Kaufhaus ist ein Laden: Es kauft aus dem Spielerangebot in seinen Vorrat und verkauft daraus, zu
  Preisen, die ein Verwalter setzt oder die eine einfache Regel führt (leerer Vorrat → teurer, voller → billiger).
  Fehlender Vorrat wird über Lieferaufträge an der Tafel gefüllt. Der Laden schließt die Lücke, wenn gerade niemand
  am Brett steht — wichtig mit wenigen Spielern.
- Gastkonten können zuarbeiten (liefern, arbeiten, als Helfer gießen), aber nichts besitzen; Besitz braucht ein
  registriertes Konto (wie Handel heute).

## Feste und Wettbewerb ohne Gewalt

Wettbewerb gibt es — um Schönheit, Menge und Geschick, nie um Kampf:

- **Blumenschau** und **Erntefest**: die Tafel vergibt Preise — seltenste Sorte, größter Kürbis, ergiebigste Flur.
- **Regatta**: ein Bootsrennen um Bojen, sobald Boote segeln; die Strecke ist ein Termin der Weltuhr.
- **Ruf der Siedlungen**: die Tafel zeigt einen Rang — gehaltener Bestand, Warenumschlag am Kaufhaus, gepflegte
  Parks. Keinem wird etwas weggenommen; der Vergleich selbst ist der Antrieb.
- **Feuerkette**: welche Insel hält ihre Signalfeuer am längsten ohne Erlöschen — ein stehender Zähler, kein
  Ereignis.

## Wenige Spieler: die Welt packt mit an

Die gemeinsame Bauweise setzt eigentlich viele Hände voraus. Die Gärten sind dabei der Strang, der von Anfang an
mit wenigen Händen trägt: ein einziger Spieler hält einen Garten allein — die Hilfe unten gilt vor allem für die
Bauten. Spielen nur zwei, drei Leute, helfen Mechanismen, die größtenteils schon existieren — alle über dieselben
Befehle und die Auftragstafel, nie durch unsichtbare Eingriffe:

- **Baustellen-Aufträge werden angenommen.** Die Skript-NPCs ([welt.md](welt.md), „Die Bewohner“) nehmen Lieferaufträge
  von Baustellen an wie jeden anderen Auftrag — gegen den Lohn, den die Baustelle aushängt. Der Sammler sammelt, was
  fehlt; der Händler kauft es zu. Nichts entsteht aus dem Nichts.
- **Tagelöhner.** Eine neue Skript-Rolle `bauhelfer`: kann `liefere` und `arbeite`, wird über
  `heuere <name> an baustelle` oder einen Tafel-Auftrag mit Lohn angeheuert. Material besorgen reicht nicht — die
  Arbeitsleistung ist der Engpass, und genau den füllt der Tagelöhner — auf den Fluren ist er der Erntehelfer.
- **Automaten als zweite Hände.** `liefere` und `arbeite` kommen ins `AutomatonCmdSet`
  ([automaten.md](automaten.md)); eine Vorlage „Baustellenhelfer“ (hole aus Lagerhaus oder eigener Truhe, liefere,
  arbeite) gehört zu den Beispielen. Zwei Spieler mit je zwei Automaten stellen sechs Figuren — der Deckel unten lässt
  die vier Automaten aber höchstens so viel beitragen wie die beiden Menschen: doppelt so schnell, nicht dreifach.
- **Siedlungsbevölkerung.** Je fünf fertige Bauten kommt ein dösender Dorfbewohner (Skript, kein Modell) dazu: gießt
  die Gemeinschaftsbeete, legt am Feuer nach, redet auf dem Platz. Siedlungen werden sichtbar lebendiger, je mehr
  gebaut ist — auch wenn nur zwei Menschen spielen.
- **Götter und Wanderer.** Ein Gott darf mit der Befugnis `auftrag` ([goetter.md](goetter.md)) Baustellen bedienen
  („Bringt zehn Holz zur Baustelle an der Grauen Bucht“, Belohnung aus dem Weltvorrat). Auf `construction.stalled`
  (Baustelle einige Tage ohne Fortschritt) schickt die Welt einen Wanderer ([modell-npcs.md](modell-npcs.md)): den
  ziehenden Zimmermann, der gegen Lohn mitarbeitet — ohne Modell ein Skript-NPC mit zwei, drei Zeilen.
- **Baumeisterin (optional, Tokens).** Eine Modellrolle, die auf `construction.stalled` und Ansprache reagiert: ruft
  im Kanal *hafen* um Material und Hände, erklärt Gästen das Bauen, schlägt vor, was als Nächstes fehlt. Sie
  koordiniert — bauen darf sie nicht, wie alle Modell-NPCs.
- **Gieß-Patenschaften** (oben bei den Gärten): der Dorfgärtner oder ein Mitspieler pflegt Beete Abwesender.

Grenzen, damit die KI nicht das Spiel spielt:

- Hilfe gibt es nur gegen **Auftrag oder Anheuerung**, bezahlt aus Lager oder Tasche. Kein NPC beginnt je selbst eine
  Baustelle; der Anstoß bleibt menschlich (oder Rathaus-Beschluss).
- Höchstens die **Hälfte** der Lieferungen und der Arbeit je Baustelle darf von Nicht-Menschen stammen; der
  Baustellen-Eintrag führt beide Zähler. Nicht-Menschen sind NPCs und Automaten, auch die eines Spielers. Ein Bau der
  Spieler bleibt ein Bau der Spieler.
- Hüter- und Dorf-NPCs pflegen Feuer und Gemeinschaftsbauten (Lagerhaus, Wege, Parks, Gemeinschaftsbeete), **nie
  private** Hütten und private Beete — sonst wäre Verfall tot und Abwesenheit folgenlos.
- Bauten zählen zum gehaltenen Bestand der Epoche, egal wer mithalf — der Halbe-Hände-Deckel sorgt dafür, dass
  Menschen immer die Hauptlast trugen. Die Schwellen sind Weltkonfiguration (oben).

## Automaten: ab wann und wie

Automaten ([automaten.md](automaten.md)) sind hier ein Handwerksprodukt, kein Menüpunkt. Der Prototyp `Automat`
entsteht aus **Tauwerk** (Seilerei), **Zahnrad** (Schmiede) und **Gehäuse** (Tischlerei) — frühestens in
**Epoche 2**, wenn die Werkstätten stehen, und noch kostbar, weil Zahnräder Eisen brauchen und Erz vor der Mine
nur als seltene Wrack- und Klippenfunde kommt. Üblich werden Automaten in **Epoche 3**: eine Mine liefert Eisen in
Menge, und wer einen Automaten will, baut ihn — oder kauft ihn von einem Handwerker oder am Kaufhaus. Bis dahin
bleibt die Welt handgemacht; das ist gewollt, denn Automaten sind die Belohnung einer Wirtschaft, die schon steht.

Wer den Körper hat, entwickelt den Automaten wie in [automaten.md](automaten.md): Vorlage mit Feldern,
Regelbaukasten, Vormachen oder der Assistent — das Programm läuft im Sandbox, kostet im Betrieb nur **Öl** (die
Lease ist der Tank) und benutzt dieselben Befehle wie ein Mensch; höchstens zwei je Charakter. Neue Vorlagen aus
diesem Konzept: „Baustellenhelfer“, „Beethelfer“, „Erntehelfer“ (arbeitet im Erntefenster), „Stallknecht“
(füttert, sammelt) — und in Epoche 4 das **Fuhrwerk**, ein fahrender Automat mit Ladung auf einer Route, als
Vorstufe der Inselbahn.

## Was die Space-Semantik trägt

| Spielmechanik | Space-Operation |
| --- | --- |
| Baustelle beliefern | `take` der Ware + `write` des Fortschritts in einer Transaktion |
| Arbeit leisten | Arbeitspunkt-Entry je Figur mit Abkling-Lease + Fortschritt `write` |
| Fertigstellen | Baustelle `take`, Bau `write`, Beiträge `write`, eine Transaktion |
| Fläche belegen | `write` mit `unique` auf (Raum, Zelle); Fußabdruck = alle Zellen der Form in einer Transaktion |
| Baurecht/Zone | Siedlungs-Entry mit `locks`; `bau` prüft Sperrzellen und Zone vor dem Belegen |
| Verfall | Lease des Zustands läuft ab; `renew` beim Reparieren |
| Nachlass | `take` Truhe + `write` Nachlass mit `unique` auf (Besitzer, Bau), lange Lease — mehrere Nachlässe je Besitzer möglich |
| Lichtpunkte | Zähler je Feuer (belegte Punkte); `bau` liest ihn und schreibt ihn neu in derselben Transaktion |
| Sattsein | Entry mit Lease an der Figur; essen ist `renew` oder neues `write` |
| Unterhalt | Ticker nimmt aus dem Lagerhaus, sonst setzt er den Bau auf „steht still“ |
| Entnahmelog/Quote | `take` mit Tageszähler je Recht-Stufe; Logzeilen mit kurzer Lease |
| Karren, Zug, Fähre | Automaten mit Fahrplan (Termine der Weltuhr, [weltzeit.md](weltzeit.md)) |
| Abstimmung im Rathaus | Vorschläge und Stimmen als Entries, Ende mit Lease |
| Epoche erreicht | `Epoch`-Entry je Insel, geschrieben vom Zähl-Ticker; Rezepte und Baupläne prüfen sie |
| Tagelöhner | NPC-`Intent` wie bei Menschen; Auftrag und Lohn an der Tafel |
| Fremdarbeits-Deckel | zwei Zähler an der Baustelle (eigene/fremde Beiträge) |
| Chat-Nachricht | eine versiegelte Kopie je Leser als `ChatMsg` mit Lease im Konten-Space; zugestellt über dessen Strom |
| Gruppe, Einladung | Gruppe und Mitglied als Entries im Konten-Space; Einladung mit Lease wie ein Angebot, annehmen ist `take` + `write` |
| Sperre | `ChatBlock` (wer, wen); das Web gibt Gesperrten keine Kopie |
| Chat-Schlüssel | `ChatKey`: öffentlicher Schlüssel und der mit dem Chat-Passwort versiegelte private |

## Regionen

Die Welt läuft seit 2026-10-28 als vier Spaces, je Region eine Inselgruppe ([welt-aufteilen.md](welt-aufteilen.md)).
Fast alles hier bleibt in einer Insel und damit in einem Space: Bauten, Gärten, Fluren, Siedlung, Lagerhaus, Epoche,
Straße, Karren und Inselbahn. Was Regionen kreuzt, braucht die Übergabe oder einen eigenen Weg:

- **Rückkehrpunkt:** Die Hütte ist Rückkehrpunkt nur innerhalb ihrer Region; wer anderswo ausloggt, kehrt zur Hütte
  zurück, wenn sie in der Region der Figur steht, sonst an die Bucht der Region. Eine Rückkehr über Regionen ginge über
  die Übergabe (`handover.ts`) und ist vorerst nicht vorgesehen.
- **Fähren** sind die einzigen Wege zwischen Regionen. Fahrplan-Fähren und Boote (Werft) übergeben die Figur samt
  Ladung wie heute; ein Boot, das zu einer anderen Region fährt, ist eine Fähre.
- **Glocke, Rang, Feste:** Die Glocke ruft in alle Räume ihrer Insel. Der Rang der Siedlungen und die Feuerkette der
  Tafel zählen über alle Regionen: jeder Region-Space schreibt seine Zahlen, die Tafel liest alle (wie die Systemleiste
  die Prozesse aller Regionen).
- **Kaufhaus und Kontor** handeln in ihrer Region; Waren gehen per Fähre, nicht per Lager über Spaces hinweg. Eine
  Schuld bleibt in der Region des Kontors.

## Was das für den Betrieb heißt

- **Mehr Entries, die bleiben.** Bauten sind dauerhaft; jede Insel mit einer Stadt hat Hunderte. Lesen nach Typ ist
  indiziert ([lasttest-2026-10-28.md](lasttest-2026-10-28.md)), aber ein Raum mit vielen Bauten braucht einen
  Index nach Raum oder eigene Typen je Bauart. Äcker bleiben trotz ihrer Fläche einzelne Entries (eine je Flur).
- **Mehr Ticker** (Verfall, Unterhalt, Werkstätten, Züge, Pflanzen-Stufen). Sie gehören in Welt-Worker, nicht in den
  Space-Prozess; ein Ticker, der nichts ändert, schreibt nichts (wie `fireTick`).
- **Mehr Skript-NPCs**: Tagelöhner, Dorfbewohner, Gärtnerin. Sie kosten keinen Modellaufruf, aber CPU; die Zahl je
  Siedlung ist gedeckelt (Bevölkerung wächst mit den Bauten).
- **Die Welt ist aufgeteilt** (oben, „Regionen“): Siedlungen wirtschaften je Insel und damit in einem Space; die
  Fähre ist die einzige Übergabe zwischen Spaces, die Inselbahn bleibt in ihrer Insel. Wird eine Region mit Städten
  zu voll, lässt sie sich weiter teilen (eine Insel je Space).
- **Karte**: Bauten brauchen Grafik (Sprites je Bauart und Zustand: Baustelle, fertig, verfallen, Ruine), Gärten eine
  Darstellung je Stufe (Saat bis verwelkt); im Client ein Bauplan-Wähler, ein Baustellen-Fortschritt und die Zonen
  des Rathauses als Overlay.

## Reihenfolge

0. **Chat zwischen Spielern** (oben, gebaut): `chat`, das Menü der rechten Maustaste auf der Karte, Reiter je
   Gespräch, liegengebliebene Nachrichten, Gruppen mit Einladung, `ignoriere`, Ende-zu-Ende-Verschlüsselung mit
   Chat-Passwort, Melden.
   Abnahme:
   - Zwei Spieler in verschiedenen Regionen schreiben sich.
   - Eine Nachricht an einen Abwesenden erscheint bei seinem nächsten Anmelden.
   - Eine Einladung wird angenommen, eine andere läuft ab.
   - Ein Gesperrter erreicht niemanden mehr, der ihn sperrt.
   - Ein Gast kann keine Gruppe gründen.
   - Kein Gespräch erscheint im Log des Raums.
1. **Hütte und Baustelle** (Epoche 1, ohne Siedlung): Bauplan als Prototyp, `bau`, `liefere`, `arbeite`, Fertigstellen,
   Truhe, Verfall, Nachlass. Dazu die Grundregeln: Sperrzellen, Fußabdruck, Claim, Abriss, Lichtpunkte der Feuer.
   Abnahme: 20 Spieler
   beliefern dieselbe Baustelle gleichzeitig, sie wird genau einmal fertig, kein Teil geht verloren oder doppelt;
   Überlieferung geht zurück; eine Hütte auf einem Ausgang wird abgelehnt; ein abgerissener Bau gibt die Fläche frei;
   ist das Licht eines Feuers voll, nimmt `bau` keinen Plan mehr an.
   - **Teil 1, gebaut 2026-10-29** (`server/engine/commands/build.ts`, Test `tests/build.test.ts`): Bauplan „Hütte“
     in der Weltdatei (`building.plans`), `bau` (neben sich oder `bau hütte <x> <y>`), `liefere`, `arbeite` (eine
     Weltstunde Ruhe danach), `baustelle`, Fertigstellen in derselben Transaktion; Flächen als `Plot` mit `unique` auf
     Raum und Zelle, niemand läuft hinein (`blockedIn` in `occupancy.ts`, auch Strandgut, Ankunft und die Seite);
     Sperrzellen (Ausgang und Tür, Feuer und seine Nachbarzellen, Dinge, Personen) und die Prüfung, dass Ausgänge,
     Spawn und eine Seite jedes Feuers erreichbar bleiben; Lichtpunkte je Feuer (`LightUse`, 20 je Feuer, die Hütte
     1); höchstens die Hälfte von Nicht-Menschen; eine Baustelle ohne Fortschritt verfällt nach zwei Welttagen. Die
     Karte zeigt Baustelle (mit Fortschritt) und Haus in 2D und 3D, die rechte Maustaste bietet Liefern und
     Mitarbeiten an. Liefern und Mitarbeiten gehen aus bis zu zwei Zellen Abstand (`SITE_REACH`): direkt neben einer
     2×2-Hütte liegen nur zwölf Zellen, mit einer Figur je Zelle zu wenig für zwanzig; im Abstand zwei sind es 32.
     Truhe, Ausbessern und Abriss bleiben direkt am Bau. Hält gerade eine andere Lieferung die Baustelle (sie ist in
     deren Transaktion genommen und darum nicht lesbar), wartet `liefere` auf sie über ihre Zellen, statt „keine
     Baustelle“ zu melden. Abnahme: zwanzig liefern gleichzeitig, genau sechs Treibholz werden genommen, der Rest
     bleibt in den Taschen, niemand hört „keine Baustelle“; einundzwanzig Hände bauen sie genau einmal fertig; aus drei
     Zellen Abstand heißt es „Geh näher“.
   - **Teil 2, gebaut 2026-10-29:** die **Truhe** der Hütte (12 Plätze, nur der Besitzer: `truhe`, `verstaue`,
     `entnimm`, auch „leg … in die truhe“, „nimm … aus der truhe“); **Verfall**: ein Bau hält eine Woche, `repariere`
     (1 Treibholz, jeder darf) setzt die Frist neu; ein nicht gehaltener Bau wird zur **Ruine** (zehn Welttage, deckt
     ihre Zellen weiter, gibt das Licht frei), was in der Truhe lag, wartet als **Nachlass** einen Monat auf den
     Besitzer (`nachlass` an der Ruine); **Abriss** (`abriss`, „reiß die hütte ab“): Fläche und Licht frei, die Hälfte
     des Materials und die Truhe zurück, eine aufgegebene Baustelle gibt alles Gelieferte zurück. Die Karte zeigt die
     Ruine, das Zellmenü bietet Ausbessern, Truhe und Nachlass an. Noch nicht: schnellerer Verfall im Nebel (kommt mit
     dem Wild), Wiederaufbau einer Ruine, die Hütte als Rückkehrpunkt.
2. **Gärten** (der gleichwertige Strang, parallel zu allen Bauten): Spaten, Regentonne, Beet-Arten (Nutz, Zier,
   Gemeinschaft), Samen aus der wilden Flora, Pflanzen mit Wachstumsstufen, Gießen und Jäten,
   Patenschaft, Ernte, Kreuzen und Benennen, Gärtnerin mit Samenhandel und Suchaufträgen. Abnahme: 1 000 Pflanzen
   wachsen einen Spieltag lang und werden zweimal gegossen, der Space schreibt nur bei Stufenwechseln und beim Gießen
   (gemessen: Schreibvorgänge je Spieltag); eine Patenschaft gießt ein fremdes Beet, ohne es zu besitzen.
   Dazu das erste **Wild**: Hasen in den Beeten, der Wild-Ticker nach Nebelstufe, `scheuche`, Zaun und Vogelscheuche.
   Abnahme: bei brennendem Feuer kommt kein Hase; bei Stufe 3 kommen welche, ein verscheuchter frisst nichts, ein
   umzäuntes Beet verliert nichts, das letzte Pflänzchen bleibt.
   - **Teil 1, gebaut 2026-10-29** (`server/engine/commands/garden.ts`, Test `tests/garden.test.ts`): **Spaten** (Rezept
     2 Treibholz, 1 Tangseil), **Regentonne** als Bauplan (1×1, 3 Treibholz, 1 Tangseil, 4 Arbeit; `schöpfe` füllt eine
     Kanne Wasser), **Beete** 2×2 im Licht (`umgraben`, Flächen als `Plot` wie Bauten, ein Lichtpunkt, höchstens drei
     je Konto, `beet aufgeben`), **Samen** aus der wilden Flora (`sammle samen`: in Räumen mit Blumen oder Kräutern im
     Dekor, einmal je Weltstunde, jedes zweite Mal ein Fund), fünf Sorten (Strandnelke, Dünenrose, Nebelblume nur auf
     Nebelholm, Strandkohl, Möhre), `pflanze`, **Stufen** Saat, Keim, reif, welk in Weltzeit, `gieße` (eine Kanne
     für das ganze Beet), `jäte` (Unkraut und Welkes), `ernte` (Ertrag und ein bis zwei Samen, jede Pflanze genau
     einmal), **Patenschaft** (`pate <name>`, auch für Gäste; `pate weg`). Die Pflanzen liegen im Eintrag ihres Beets,
     das Beet trägt einen Termin: den nächsten Stufenwechsel seiner Pflanzen. Der Garten-Ticker (alle 60
     Weltsekunden) schreibt nur Beete, deren Termin gekommen ist; Nebel (jede Nebelstufe macht eine Stufe um die Hälfte
     länger: bei Stufe 3 dauert sie 2,5-mal so lang) und Unkraut (1,5-mal so lang) verlangsamen das Wachsen und werden gelesen, wenn das Beet ohnehin geschrieben wird. Wer beim nächsten Schritt
     länger als 16 Weltstunden ohne Wasser steht, welkt; ein Beet, das zwei Wochen niemand pflegt, wächst zu.
     Karte: Beete mit ihren Pflanzen je Stufe in 2D und 3D, das Zellmenü bietet Gießen, Jäten, Ernten, Pflanzen und
     an der Tonne das Schöpfen an. Hilfe: Artikel „Gärten“, Thema `help garten`.
     Abnahme gemessen: 250 Beete mit 1 000 Pflanzen wachsen einen Welttag und werden zweimal gegossen; der Space
     schreibt die Beete 750-mal, 500-mal beim Gießen und 250-mal beim Stufenwechsel (in einem Beet wechseln die
     zusammen gesetzten Pflanzen zusammen), und keinmal, solange kein Termin kommt. Eine Patenschaft gießt ein fremdes
     Beet, ohne es zu besitzen; zwei ernten zugleich, jede reife Pflanze geht an genau einen.
     Abweichungen vom Entwurf: der Befehl heißt `umgraben`, nicht `grabe` (das ist der Builder-Befehl `dig`); es gibt
     eine Beet-Art für Gemüse und Blumen zugleich; die Regentonne füllt sich alle acht Weltstunden um eine Kanne (bis
     sechs), nicht einmal am Tag, sonst reichte eine Tonne nicht für ein Beet, das zweimal am Tag Wasser braucht.
   - **Teil 2, gebaut 2026-10-29** (dieselben Dateien, Weltversion 18): drei Arten von Beeten. Das **Gartenbeet**
     (`umgraben`) trägt Gemüse und Blumen. Das **Zierbeet** (`umgraben zier`) trägt nur Blumen, und nur dort
     **kreuzen** sie sich: Reift eine Blume, neben der (nicht über Eck) eine andere Sorte steht, gibt die Ernte mit
     einem Viertel Wahrscheinlichkeit statt eines Samens einen **Kreuzungssamen**. Er trägt eine eigene Farbe zwischen
     denen der Eltern und den Züchter. Wer ihn gezogen hat, **benennt** die Sorte einmal (`benenne <name>`); dann heißen
     ihre Samen „<Name>-Samen“ und ihre Blumen „<Name>“. Ein Name hat 3 bis 24 Buchstaben. Er darf nichts sein, was
     die Welt schon meint (kein Prototyp, keine Sorte, kein Befehl), damit `give kohl` nie eine Blume findet, die
     jemand „Kohl“ nannte. Er ist `unique` (`Variety`-Entry). Das **Gemeinschaftsbeet** (`umgraben gemeinschaft`) ist
     3×3 groß, belegt zwei Lichtpunkte und liegt höchstens einmal je Feuer (`BedCommons`, `unique` auf dem Feuer). Es
     zählt zu niemandes drei Beeten. Pflanzen darf darin jeder mit Konto, gießen, jäten und ernten alle, auch Gäste;
     aufgeben kann es nur, wer es anlegte. Die **Gärtnerin Gesa** (Skript `gaertnerin`, Kupferhafen) sammelt wie jeder
     mit `sammle samen` und verkauft die Samen am Markt. Sie kauft Blumen und Gemüse. Ihre **Suchaufträge** hängen an
     den Tafeln: eine Nebelblume, Dünenrosen, Kohl und Möhren, Strandnelken. Die Karte färbt Pflanzen einer Kreuzung
     in deren Farbe, das Zellmenü bietet am Gemeinschaftsbeet allen das Gießen, Jäten und Ernten an und mit Konto das
     Pflanzen. Abnahme (`tests/garden.test.ts`):
     - Kohl wird im Zierbeet abgelehnt.
     - Vier reife Blumen zweier Sorten kreuzen sich bei der Ernte.
     - Der Züchter benennt die Kreuzung. „Kohl“ und „ernte“ werden als Namen abgelehnt, ein vergebener Name ebenso.
     - Aus den Samen wächst die Sorte unter ihrem Namen und in ihrer Farbe, und sie gibt eine Blume dieses Namens.
     - Ein zweites Gemeinschaftsbeet am selben Feuer wird abgelehnt.
     - Ein Gast pflanzt dort nicht, gießt aber.
     - Der Messtest schreibt weiter 750-mal und bei angehaltener Uhr keinmal.

     Abweichungen vom Entwurf:
     - Die Ernte des Gemeinschaftsbeets geht in die eigene Tasche statt in eine Beet-Truhe mit der Quote des
       Lagerhauses; beides kommt erst mit Schritt 5. Pflanzen darf jeder mit Konto statt jeder „mit Recht“, denn
       Rechte gibt es erst mit der Siedlung in Schritt 4.
     - Gekreuzt wird bei der Ernte, nicht beim Reifen: Die Ernte schreibt das Beet ohnehin, so bleibt die Zahl der
       Schreibvorgänge gleich.
     - Eine Kreuzung ist kein neuer Prototyp. Sie lebt als `variety` an Samen, Pflanze und Blume, behält den Prototyp
       ihrer Ausgangssorte und reist so mit ihrem Träger in andere Regionen.
     - Der Name ist nur je Region `unique`, denn es gibt keinen weltweiten Space dafür. Eine Pflanze, die vor dem
       Benennen gesetzt wurde, erhält den Namen bei ihrer Ernte.

   - **Teil 3, gebaut 2026-10-29** (`server/engine/commands/wild.ts`, Test `tests/wild.test.ts`, Weltversion 19): das
     erste **Wild**, die **Hasen**. Der Wild-Ticker (Job `wild`, alle 20 Weltminuten) sieht nur Räume mit Beeten. Nach
     ihrer Nebelstufe würfelt er für einen Hasen: Stufe 0 (das Feuer brennt) nie, sonst 4, 12 oder 25 Prozent, nachts
     doppelt, höchstens zwei je Raum. Ein Hase ist ein `Animal`-Entry neben einem Beet. Nach einer halben Weltstunde
     frisst er: Eine Pflanze fällt eine Stufe zurück, ein Setzling ist weg, die letzte lebende Pflanze bleibt. Dann geht
     er. `scheuche hase` nimmt ihn aus bis zu drei Feldern weg: Wer zuerst kommt, rettet das Beet, und ein
     verscheuchter Hase frisst nichts. Dauerhaften Schutz geben der **Zaun** (`zäune`, 2 Treibholz, 1 Tangseil, für ein
     Beet, das man pflegen darf) und die **Vogelscheuche** (Bauplan 1×1, 2 Treibholz, 1 Tangseil, 3 Arbeit, schützt
     die Beete in bis zu drei Feldern, hält drei Tage). Schreibvorgänge gibt es nur, wenn ein Hase kommt oder frisst.
     Die Karte zeigt den Hasen (Icon von `items-src/garden.py`) und den Zaun in 2D und 3D; das Zellmenü bietet
     Verscheuchen und Zaunsetzen an.
     Abnahme (`tests/wild.test.ts`):
     - Bei brennendem Feuer kommt kein Hase, bei Stufe 3 kommt einer an jedes Beet.
     - Ein verscheuchter Hase frisst nichts.
     - Ein umzäuntes Beet und eins bei der Vogelscheuche verlieren nichts.
     - Das letzte Pflänzchen bleibt.
     - Nur das offene Beet verliert eine Stufe.
     - Es sind nie mehr als zwei Hasen je Raum.

     Abweichungen vom Entwurf:
     - Der Zaun ist keine Zellenreihe mit Pforte, sondern gehört zum Beet: Er steht um dessen Rand und kostet
       einmal Material. Zäune um ganze Fluren kommen mit den Äckern (Schritt 3).
     - Der Hase erscheint gleich am Beet, statt vom Rand des Raums zu laufen.
     - Ein Klick auf den Hasen öffnet das Zellmenü mit „Verscheuchen“.

     Noch nicht: Hecke und Hund als Schutz, Sträuße als Geschenke und Opfer, die Blumenschau.
3. **Äcker und Mühlen** (der große Strang der Gärten): Flur-Entries über Zellbereiche, eine Frucht je Flur,
   Bestellen und Ernteeinsatz als Arbeitspunkte, Fruchtfolge, Windmühle und die Kette Korn → Mehl → Brot,
   Flachs → Leinen; **erste Tiere** (Hühnerstall mit Tang und Resten schon vorher, Gehege, Futter von den Fluren);
   **Rehe** an den Fluren, **Füchse** am Hühnerstall, **Mäuse** im Speicher, Hund und Katze als Schutz.
   Abnahme: zehn Figuren im
   Ernteeinsatz bringen eine Flur genau einmal ein; müder Boden gibt weniger.
4. **Epochen und Siedlung**: Punkte je Bau und Garten, der Zähl-Ticker, `Epoch` je Insel, Schwellen in den
   `Setting`-Entries, Rückfall; die Siedlung aus Hütten in einem Raum (Name, Rechte-Stufen Fremder, Helfer, Siedler).
   Abnahme: eine Insel erreicht das Dorf aus Beeten allein; verfällt genug, fällt sie zurück, ihre Bauten arbeiten weiter,
   neue Pläne der Stufe sind gesperrt. Ohne diesen Schritt gibt es keine Epoche 2 für Schritt 5.
5. **Werkstätten, Steinbruch, Lagerhaus** (mit Entnahmelog und Quote), neue Rezepte, Aufträge der Baustellen an der
   Tafel; Skript-NPCs nehmen sie an, die Rolle `bauhelfer` kommt dazu, und `liefere`/`arbeite` ziehen ins
   `AutomatonCmdSet` samt Vorlage „Baustellenhelfer“. **Automaten-Körper** als Werkstatt-Rezept (Tauwerk, Zahnrad,
   Gehäuse).
6. **Rathaus, Kapelle** (Zonen, Steuern, Abstimmungen, Feste mit den Göttern), **Siedlungsbevölkerung**, erste
   **Parks** und die Blumenschau.
7. **Kaufhaus** (Laden mit Vorrat), **Kontor**, **Leuchtturm**, **Brauhaus**, **Glashütte und Gewächshaus**,
   Fischerei (Netz-Rezept, Steg) und Boote; **Nahrung** (Sattsein), wenn Brot und Räucherfisch da sind.
8. **Straßen, Karren, Fahrplan-Fähren**, dann die **Inselbahn** als Automat.

## Offene Fragen

Entschieden: Räume wachsen **und** neue entstehen; Kirchen sind freiwillig (die Götter wirken ohne sie); Wettbewerb
ist gewaltfrei (Feste, Ruf, Regatta); Tiere kommen früh. Offen bleibt:

- Wie weit wächst ein Raum, bevor ein neuer entsteht — und wächst er in ganzen Zellstreifen oder abgestuft?
- Wie viel Vieh verträgt der Ton — Hühner, Schafe und Ziegen auf dem Hof, oder auch Viehhandel und Zucht als eigene
  Kette?
- Wie viele Lichtpunkte trägt ein Feuer, und reicht eine feste Zahl, oder wächst sie mit der Zahl der Spieler einer
  Insel (wie das Strandgut, `flood.perPlayers`)?
- Kommt Wind als Wetter mit den Jahreszeiten, oder bleibt die Sturmflut das einzige Wetter (dann mahlt die Mühle immer
  im festen Takt)?
