# Architektur

## Prozesse

Wie in codemode-chat ist jede Rolle ein eigener Prozess rund um einen Space (vgl. `codemode-chat/server/launch.ts`,
`space-host.ts`):

| Prozess | Aufgabe | Vorlage |
| --- | --- | --- |
| `space` | Hält den Space (eigener SQLite-Store `openSqliteHost`, im Test `openOwnMemoryHost`), bedient ihn über `serveSpace` (Unix-Socket/TCP) | `codemode-chat/server/space-host.ts`, `src/standalone.ts` |
| `world` | Nimmt `Intent`s, führt Befehle aus, Welt-Ticks (Flut, Feuer, Nebel), Spawner | `codemode-chat/server/judge-host.ts` (take unter Transaktion) |
| `npc` | Skript-NPCs, später Modell-NPCs; schreiben nur `Intent`s | `codemode-chat/server/agent-host.ts`, `model-host.ts` |
| `automaton` | Spielerprogramme im Sandbox (Phase 6); schreiben nur `Intent`s | `codemode-chat/server/judge-host.ts` |
| `web` | Next.js-App, HTTP-API, WebSocket-Gateway, Login, Sessions, Kontingente | `codemode-chat/server/index.ts`, `hub.ts`, `ws.ts`, `quota.ts` |

Alle außer `space` sprechen über `RemoteSpace` + `socketTransport` mit dem Space. `world` und `npc` lassen sich
mehrfach starten. Der Browser lädt keinen Space-Code; `src/` bleibt reiner Server-Code.

```
Browser ──WebSocket──▶ web ──RemoteSpace──▶ space ◀──RemoteSpace── world (1..n)
                                              ▲
                                              └────RemoteSpace──── npc (0..n)
```

## Datenfluss zum Browser

- **Rein:** Der Browser schickt nur Befehle (`{t:"cmd", line}`), Bewegungsklicks werden im Client zu Textbefehlen.
  Das Gateway schreibt daraus `Intent`-Entries und erzwingt Kontingente pro Session und IP (Muster `quota.ts`,
  `CODEMODE_REQ_PER_MIN`).
- **Raus:** `changes(afterRev)` liefert einen globalen Strom aller Commits. Das Gateway liest ihn einmal und filtert pro
  Session nach Interessensbereich (aktueller Raum, Inventar, abonnierte Kanäle). Ein neu verbundener Client bekommt
  zuerst einen Snapshot des Raums (`readAll({fields:{location}})`), danach nur Deltas.
- **Rahmengröße:** `ws.ts` begrenzt Frames auf 1 MiB; das Gateway schickt Räume klein (Kachelkarte komprimiert,
  Beschreibungen nachladbar), wie `hub.ts` bei Code-Snapshots.
- Läuft der `changes`-Cursor hinter die Aufbewahrung, startet das Gateway mit Snapshot neu (wie der Feed-Hub der
  help-site, Commit b85073d).

## Takt

- Bewegung auf einem Raster, ein Schritt pro Befehl, serverseitig geprüft. Der Client interpoliert die Animation
  zwischen zwei Positionen; er sagt nichts voraus, was der Server verwerfen könnte, außer einer optimistischen
  Anzeige der eigenen Figur.
- Welt-Ticks um 1 Hz für Zustand mit sichtbarer Zeit (Nebel, Flut), alles Langsamere über Leases und OnDemand-Rechnung.
- Ziel für Phase 3: Befehl bis Anzeige < 150 ms im LAN, < 400 ms über das Netz.

## Skalierung

- **Phase 0–5:** ein Space für die ganze Welt. Für einige hundert gleichzeitige Spieler reicht ein Space mit einem
  Gateway, das den Strom filtert.
- **Später:** Zonen als benannte Spaces (`src/spaces.ts`, Registry). Ein Wechsel zwischen Zonen ist keine
  gemeinsame Transaktion mehr, weil Transaktionen nur innerhalb eines Spaces gelten. Lösung: zweistufige Übergabe mit
  einem `Travel`-Entry (in Zone A nehmen, in Zone B schreiben, Quittung zurück), idempotent über eine Reise-ID.
- Föderation und Replikation (`src/runtime.ts`, `primary-sync.ts`) stehen bereit, sind aber für das Spiel nicht
  vor Phase 7 nötig.

## Rechte

- Gateway, Welt und NPC melden sich mit eigenen Rollen beim Space an. `Policy` (`src/service.ts`): `world` darf
  alle Typen, `npc` und `web` dürfen nur `Intent`, `Session`, `ChannelMsg` schreiben und lesen alles Öffentliche.
- Spieler haben keinen direkten Zugang zum Space; ihre Identität kennt nur das Gateway.
- Builder- und Admin-Rechte sind Weltrecht (`perms` am Account, Locks), keine Space-Rollen.

## Konten und Login

Ab Phase 0 gibt es beides: sofort als Gast spielen oder mit Konto. Ein Gast kann sich jederzeit registrieren und
behält dabei seinen Fortschritt (siehe [Gastzugang](#gastzugang)). Login gebaut nach dem Muster von
`help-site/server/admin/admin-controller.ts`, aber für viele Konten statt eines Admin-Passworts, ohne neue
Abhängigkeit (`node:crypto`):

- **Registrieren:** Benutzername + Passwort; gespeichert wird `scrypt(passwort, salt)`, Vergleich mit
  `timingSafeEqual`. Benutzernamen sind eindeutig: ein `Credential`-Entry pro Name, geschrieben unter einer
  Transaktion, die vorher per `readIfExists` prüft (zwei gleichzeitige Registrierungen desselben Namens: eine
  scheitert).
- **Getrennter Space für Zugangsdaten:** `Credential`- und `WebSession`-Entries liegen im Space `accounts`. Der
  Space-Prozess bedient ihn aus einem **eigenen Store auf einem eigenen Socket** (`SPACES_MMO_ACCOUNTS`), dessen Adresse
  nur der Web-Prozess bekommt. (Ein benannter Space im selben Store wäre über den Welt-Socket erreichbar gewesen; der
  Dienst grenzt Rollen nicht pro Space ab.) Welt, NPCs und Automaten sehen nur `Account{accountId, name, guest, admin}`
  im Welt-Space, nie einen Hash.
- **Eindeutige Namen:** Jede Registrierung nimmt in einer Transaktion den einen `Lock{name:"names"}`-Entry, prüft den
  Namen (wartet dabei auf einen gerade gehaltenen Credential) und schreibt den Anspruch; danach legt sie den Lock zurück.
- **Sitzung:** HttpOnly-Cookie (`SameSite=Strict`, `Secure` hinter HTTPS). Statt eines CSRF-Tokens verlangt jeder POST
  den Header `x-mmo: 1`, den ein fremdes Formular nicht setzen kann (wie codemode-chat). Die WebSocket prüft beim
  Upgrade Cookie und `Origin`. Serverseitig ein `WebSession`-Entry mit Lease (12 h, bei Nutzung erneuert), damit ein
  Neustart des Web-Prozesses niemanden abmeldet.
- **Schutz:** Login-Versuche pro IP und pro Konto begrenzt (wie `#loginAttempts`), Registrierungen pro IP und Tag
  begrenzt, Mindestlänge für Passwörter.
- **Rollen:** `perms` am Account (`Player`, `Builder`, `Admin`); der erste Admin wird über eine Umgebungsvariable oder
  einen einmaligen Einrichtungstoken angelegt (wie der Enroll-Token der help-site).
- **Später:** Passkeys (WebAuthn) sind möglich, aber nicht geplant.

### Gastzugang

- **Sofort spielen:** „Als Gast spielen“ legt ohne Eingabe ein Konto `Account{id, name, guest: true}` an, mit
  zufälligem Namen („Strandläufer-4821“), und setzt dasselbe Sitzungs-Cookie wie ein Login. Der Gast bekommt einen
  normalen Charakter; Welt, NPCs und Automaten-Worker behandeln ihn wie jedes Konto.
- **Lebensdauer:** Das Gastkonto hat eine Lease (7 Tage), die bei jeder Aktivität erneuert wird. Läuft sie ab, räumt
  ein Aufräum-Worker in der Welt auf: Charakter und Inventar werden entfernt, getragene Rohstoffe gehen als
  Strandgut an den Strand zurück. Ob der Worker das Ablaufen am `changes`-Strom erkennt oder per periodischem Abgleich
  (`readAll({type:"Character", fields:{guest:true}})` gegen vorhandene Accounts), wird beim Einbau festgelegt; der
  Abgleich ist der sichere Rückfall.
- **Ein Gerät:** Der Gast hängt am Cookie. Cookie gelöscht oder anderes Gerät → neuer Gast. Die Oberfläche zeigt bei
  Gästen dauerhaft „Registrieren, um den Fortschritt zu behalten“.
- **Einschränkungen gegen Missbrauch** (sonst ließen sich mit vielen Gästen Rohstoffe auf ein Hauptkonto schaufeln):
  - Gäste können Gegenstände weder an andere geben noch handeln oder auf dem Markt anbieten (`give`, `offer` und der
    Markt sind per Lock `perm(Player) and not guest()` gesperrt). Nachlegen ins gemeinsame Leuchtfeuer dürfen sie.
  - Höchstens ein Automat statt zwei, kein Modell-NPC-Zugriff.
  - Gastanlage pro IP begrenzt (z. B. 5 pro Stunde, 20 pro Tag), engere Befehlskontingente und Kanal-Schreibrate.
  - Der Ruf von Gästen zählt, wird aber erst nach der Registrierung öffentlich angezeigt.

### Fortschritt bei der Registrierung übernehmen

Ein Gast registriert sich aus der laufenden Sitzung heraus (Benutzername + Passwort). Dabei wird **dasselbe Konto**
umgewandelt, nicht ein neues angelegt: Account-ID, Charakter, Inventar, Ruf, Automaten und Verlauf bleiben, weil
alles an der Account- bzw. Charakter-ID hängt und nichts kopiert werden muss.

Weil Zugangsdaten (Space `accounts`) und Konto (Welt-Space) in zwei Spaces liegen und Transaktionen nur innerhalb eines
Spaces gelten, läuft die Umwandlung in drei idempotenten Schritten:

1. `accounts`: `Credential{name, hash, accountId, state: "pending"}` mit kurzer Lease schreiben, nachdem
   `readIfExists` gezeigt hat, dass der Name frei ist (in einer Transaktion; der Name ist damit reserviert).
2. Welt-Space, eine Transaktion: `take Account{id, guest: true}` → `write Account{id, name, guest: false}` ohne Lease;
   Charakter-Feld `guest` ebenso umschreiben.
3. `accounts`: Credential auf `state: "active"` ohne Lease umschreiben.

Bricht der Ablauf ab, heilt der nächste Login: Ein `pending`-Credential, dessen Account schon `guest: false` ist, wird
aktiv; eines, dessen Account noch Gast ist, läuft mit seiner Lease ab und gibt den Namen frei. Der Gast spielt in
beiden Fällen ungestört weiter.

Meldet sich ein Gast stattdessen bei einem **bestehenden** Konto an, wird nichts zusammengeführt (das öffnete das
Rohstoff-Schaufeln wieder): Die Oberfläche warnt, dass der Gastfortschritt verfällt, und das Gastkonto läuft mit
seiner Lease ab.

## Grafik

Ziel: Hybrid-Oberfläche. Links Kachelkarte des Raums, rechts oder unten Textlog und Befehlszeile. Ohne Grafik (Screen
Reader, schwaches Gerät, Agent) bleibt das Spiel voll spielbar.

**Modell:** Ein Raum hat ein kleines Raster (z. B. 24×16 Kacheln, `grid`-Feld: Bodenlayer als Zeichenkette,
Kachel-IDs aus einem Tileset). Objekte im Raum haben `x`, `y`. Ausgänge liegen am Rand oder auf Türkacheln.
Weltkarte = Graph der Räume, kein endloses Gebiet.

**Renderer: PixiJS** (entschieden; Paket `pixi.js`, exakt `8.22.0`, nur in `spaces-mmo/package.json`). Das ist die
aktuelle stabile Version (erschienen 2026-10-01). Sie wird ohne `^` festgelegt, wie `next`/`react` in help-site und
codemode-chat, damit Docker-Builds reproduzierbar bleiben; ein Update ist ein eigener Schritt mit Test. PixiJS ist nur Renderer: keine eigene Spielschleife oder Physik, die mit dem Server als
Wahrheit konkurrieren würde.

- **Einbindung in Next.js:** Eine Client-Komponente `MapView` lädt `pixi.js` per dynamischem `import()` erst im
  Browser (kein SSR), erzeugt eine `Application` an einem `<canvas>` und räumt sie beim Unmount ab. React steuert
  Rahmen, Textlog und Befehlszeile; PixiJS nur die Karte.
- **Szene:** Container pro Ebene: Boden (aus `grid`, einmal pro Raum als Kachel-Sprites oder ein vorgerendertes
  Textur-Bild), Objekte (`Sprite` pro Entry, nach `y` sortiert), Figuren, Nebel (halbtransparente Ebene mit Maske
  nach Nebelstufe), Markierungen (Ziel, Auswahl).
- **Deltas:** Das Gateway schickt `{t:"delta"}` mit hinzugekommenen, entfernten und bewegten Objekten; `MapView`
  hält eine `Map<entryId, Sprite>`, Bewegungen werden über ~200 ms interpoliert (Ticker von PixiJS).
- **Eingabe:** Klick/Tippen auf die Karte → **ein Schritt** in diese Richtung (längere Achse zuerst, sonst die andere; belegte Kacheln weicht der Client aus), genau wie eine Pfeiltaste; daraus wird `step dx dy`. **Leertaste** hebt das nächste Ding in Reichweite auf (die eigene Kachel zuerst), ohne Ding legt sie Brennholz ins nahe Feuer. **Enter** springt in die Befehlszeile, **Esc** zurück zur Karte; eine **Pfeiltaste** in der Befehlszeile geht ebenfalls zurück zur Karte und macht den Schritt (hoch/runter immer, links/rechts nur bei leerer Zeile, sonst bewegen sie den Cursor). Auf ein Objekt (ab Phase 1) → Kontextmenü mit Textbefehlen
  (`get`, `look`, `talk`). Alles wird ein Textbefehl; der getippte Befehl `move x y` geht dagegen den ganzen Weg.
- **Darstellung:** `scaleMode: "nearest"` für scharfe Pixel, ganzzahlige Zoomstufen (1×–3×, die Kamera folgt der eigenen
  Figur, Ziehen verschiebt den Blick), `resolution` = `devicePixelRatio`, Schrift in dreifacher Auflösung. Statt eines
  Atlas werden die Blätter einmal geladen und ihre Ausschnitte zwischengespeichert.
- **Autotiles:** Eine Kachel mit `auto` (Wasser) wird nach dem RPG-Maker-VX-Schema aus vier Viertelkacheln je Zelle
  zusammengesetzt (Mitte, Innenecke, Kante, Außenecke, je nach den Nachbarn). Jeder Block der Liste ist ein Bild der
  Wellenanimation; außerhalb des Raums zählt als gleiche Kachel (die See geht weiter).
- **Bewegung und Leben:** Figuren gleiten in etwa 140 ms von Kachel zu Kachel und zeigen dabei ihre vier Laufbilder,
  das Feuer flackert, der Nebel spart die eigene Figur und brennende Feuer aus.
- **Kontextmenü:** langes Drücken oder Rechtsklick auf eine Kachel; die Einträge (ansehen, aufheben, nachlegen,
  hingehen) sind Textbefehle.

### Grafiken: Intersect-Assets

Für Leuchtfeuer werden die Tilesets aus [Intersect-Assets](https://github.com/AscensionGameDev/Intersect-Assets)
(Zweig `main_full`, Ordner `resources/`) genommen. Das ist ein Paket für ein 2D-Fantasy-MMORPG: Tilesets, Figuren,
Animationen, Gegenstände, Oberfläche, Klänge und Musik, alles in einem Stil.

- **Warum dieses:** Wasser-Autotiles mit Uferkanten zu Sand, Gras und Fels, dazu Höhlen und Oberwelt. Das ist der
  Archipel von Leuchtfeuer fast ohne eigene Grafik. Figuren (`resources/entities/`, 112 Dateien) und Ausrüstungsebenen
  (`paperdolls`) passen dazu.
- **Format:** Kacheln 32×32 px. Wasser und Boden liegen als Autotiles im RPG-Maker-VX-Format vor (Block 2×3 Kacheln,
  aus Viertelkacheln je nach Nachbarn zusammengesetzt). `MapView` braucht dafür eine kleine Autotile-Logik (Nachbarmaske
  → vier Viertelkacheln); berechnet wird einmal pro Raum beim Laden, nicht pro Bild.
- **Lizenz:** Die gewählten Tilesets stehen laut Commit-Verlauf unter CC BY 4.0 (Zetasis, George, Murdoc; z. B.
  `Ground.png`, `Terrain.png`, `Autotiles_Water.png`, `Overworld.png`, `Caves Etc.png`). Kommerzielle Nutzung ist
  erlaubt, Namensnennung ist Pflicht. Die meisten Gegenstands-Icons (Joe Williamson) stehen unter CC BY-SA 3.0 und
  werden nicht übernommen, solange niemand die Share-Alike-Pflicht für geänderte Bilder will. Das Repo hat keine
  Gesamtlizenz; die Lizenz jeder übernommenen Datei wird einzeln im Commit-Verlauf geprüft.
- **Übernahme:** Nur ausgewählte Dateien (wenige MB) nach `spaces-mmo/worlds/leuchtfeuer/assets/`, kein Submodul und
  keine Kopie des ganzen Repos (~120 MB). Daneben `CREDITS.md` mit Datei, Autor, Lizenz und Quell-Commit; die
  Oberfläche zeigt die Namensnennung unter „Über“.
- **Ausweichweg:** Kenney-Pakete (CC0, keine Namensnennung) für Testszenen oder wenn eine Kachel fehlt; im selben Raum
  werden die Stile nicht gemischt.
- **Ausweichweg:** Kein WebGL verfügbar → PixiJS-Canvas-Fallback bzw. Textmodus. Der Umschalter „nur Text“ bleibt
  immer da (Barrierefreiheit, schwache Geräte, Agenten).
- Sichtfeld und Wegfindung rechnet der Server (Welt-Worker), nicht der Renderer.

### 3D-Ausblick: Three.js

Soll die Karte später räumlich dargestellt werden, ist die Wahl **Three.js** (MIT; die Version wird wie
`pixi.js` exakt gepinnt). Das erste Ziel ist ausdrücklich eine **2,5D-Ansicht der bestehenden Rasterwelt**, kein
neues dreidimensionales Welt- oder Bewegungsmodell. Three.js rendert und interpoliert im Client; es bringt keine
autoritative Spielsimulation oder Physik mit. Der Client braucht trotzdem einen Renderloop
(`WebGLRenderer.setAnimationLoop`). Einbindung nach demselben Muster: Client-Komponente, dynamisches `import()`,
`Map<entryId, Object3D>` statt der Sprite-Map und Deltas aus `changes`. Godot oder Bevy wären dagegen kein Einbau,
sondern ein Plattformwechsel, weil ihr Export das ganze Canvas übernimmt.

Autoritative Erzeugung und Darstellung sind zwei getrennte Wege:

```
Bauanweisung → serverseitiger Generator/Prüfer → persistiertes ground-Raster → Spielregeln
                                                        ├───────────────→ 2D-Renderer
                                                        └───────────────→ 3D-Renderer
```

Das `ground`-Raster, `TileDef.walk` sowie die `x`/`y`-Positionen der Entries bleiben die einzige Wahrheit. Höhe,
Beleuchtung und rein visuelle Deko dürfen weder Begehbarkeit noch Reichweite, Sichtlinie oder Kollision verändern.
Brücken, übereinanderliegende Flächen, Sprünge und vertikale Wege wären eine spätere Änderung des Servermodells und
sind von diesem Ausblick ausdrücklich nicht umfasst.

**3D-Darstellungsvertrag:** Three.js erzeugt keinen neuen Weltzustand, sondern baut eine Ansicht des persistierten
Rasters:

- **Koordinaten:** Eine Rasterzelle entspricht einer festgelegten Welteinheit. `x` wird zur horizontalen X-Achse,
  `y` zur horizontalen Z-Achse; die vertikale Y-Position liefert genau eine versionierte Funktion
  `terrainHeight(roomId, ground, x, y)`. Figuren, Gegenstände, Ausgänge und Effekte verwenden dieselbe Funktion.
- **Terrain:** Eine Welt definiert die visuelle Basishöhe je Kacheltyp. Gestuftes Gelände verwendet wenige
  `InstancedMesh`-Gruppen je Geometrie und Material; geglättetes Gelände verwendet ein gemeinsames Höhenfeld. Kleine
  Höhenabweichungen dürfen nur innerhalb festgelegter visueller Grenzen liegen, damit eine serverseitig begehbare
  Kachel nicht wie eine unüberwindbare Wand aussieht.
- **Determinismus:** Ein stabiler String-Hash und ein festgelegter PRNG erzeugen Rauschen aus `roomId`,
  Darstellungs-Seed und `terrainRendererVersion`. `Math.random()` ist dafür unzulässig. Eine zusätzliche Bibliothek
  wie `simplex-noise` ist eine eigene Abhängigkeitsentscheidung, nicht Voraussetzung dieses Entwurfs.
- **Wasser:** Wasser ist eine eigene Ebene. Der `Water`-Effekt ist ein explizit importiertes Three.js-Addon und an
  den `WebGLRenderer` gebunden; Normalmap, Renderer und ein einfacherer Fallback werden zusammen mit dem Asset
  versioniert.
- **Figuren und Objekte:** Zunächst Billboards, später optional Low-Poly-glTF-Modelle (`GLTFLoader`), z. B. aus
  CC0-Baukästen. Modelle werden je Asset geladen und wiederverwendet; GPU-Ressourcen werden beim Raumwechsel
  freigegeben. Der Fußpunkt liegt auf `terrainHeight(...)`, nicht auf einer unabhängig geschätzten Höhe.
- **Deko:** Gras, Büsche und Steine dürfen deterministisch gestreut werden, sind aber nicht auswählbar, begehbar oder
  Teil der Spielphysik. Alles Spielrelevante bleibt ein Entry.
- **Umfang:** Kleine Räume brauchen kein Chunking oder LOD, aber mehrere gebatchte Meshes bzw. InstancedMeshes pro
  Raum (Terrainmaterialien, Wasser, Deko, Figuren) sind normal. Ein Mesh pro Kachel wird vermieden. Chunking und LOD
  werden erst für ein späteres durchgängiges Gelände benötigt.

## Prozedurale Räume: Wave Function Collapse (Option)

Für Räume, die nicht von Hand gezeichnet sind (v. a. die Inseln der Götter, siehe
[goetter.md](goetter.md)): **Wave Function Collapse** im Tiled-Modell — ein Constraint-Löser, der aus
Kacheln und ausdrücklich definierten Nachbarschaftsregeln ein `ground`-Raster erzeugt. Ein RPG-Maker-Autotile
beschreibt, wie eine vorhandene Geländekachel abhängig von ihren Nachbarn gezeichnet wird; es ist noch keine
vollständige WFC-Grammatik. Jede Domänenpalette definiert deshalb separat ihre Kachelgewichte und zulässigen
Nachbarn, etwa Wasser ↔ Ufer ↔ Sand ↔ Gras ↔ Fels.

- **Ort und Zeitpunkt:** Der Generator läuft serverseitig beim Erstellen eines Entwurfs oder vor der ersten
  Veröffentlichung einer statischen Welt, nie im Client und nie erneut bei jedem Neustart. Das fertige `ground` wird
  als Serverzustand gespeichert; Textmodus, 2D- und 3D-Client erhalten dasselbe Raster.
- **Reproduktion:** Der Entwurf speichert `algorithm`, `generatorVersion`, `palette`, `seed` und den erzeugten Output.
  Ein stabiler Hash und ein eigener festgelegter PRNG machen denselben Versuch bytegleich wiederholbar. Die Metadaten
  dienen Diagnose und Test, nicht der Regeneration eines bereits veröffentlichten Raums.
- **Ablauf:** Vorbelegte Ausgänge, Spawnzellen, Feuerstellen und Ankerplätze schränken die Möglichkeiten ein. Danach
  propagiert der Löser alle Einschränkungen und kollabiert eine noch offene Zelle mit minimaler Entropie. Nur Zellen
  neben bereits belegten Zellen zu wählen ist keine Garantie für Zusammenhang.
- **Grenze von WFC:** WFC garantiert nur lokale Kachelkompatibilität. Ein nachgeschalteter Prüfer kontrolliert per BFS
  begehbare Wege zwischen Spawn, allen Ausgängen und besonderen Stellen sowie Rückweg und Mindestflächen.
- **Fehlschlag:** Widerspruch oder eine global unspielbare Karte führen nur bis zu einer festen Höchstzahl zu einem
  deterministischen Folgeversuch (`seed` plus Versuchsnummer). Danach verwendet der Entwurfsweg einen geprüften
  Fallback-Grundriss oder lehnt den Entwurf ab; er läuft niemals unbegrenzt.
- **Implementierung:** Ein eigener Tiled-Löser vermeidet eine Laufzeitabhängigkeit. Der erwartete Umfang ist keine
  Architekturgarantie: Backtracking, Grenzen, Diagnose und Tests gehören zur Implementierung.

**Abnahme:** Gleicher Seed, gleiche Palette und gleiche Generatorversion liefern bytegleiches `ground`; jede
Nachbarschaft ist erlaubt; Spawn, Ausgänge und besondere Stellen sind erreichbar. Ein Neustart ändert keinen
veröffentlichten Raum. 2D- und 3D-Client adressieren dieselben Rasterzellen, und keine 3D-Höhe oder Deko verändert die
serverseitige Begehbarkeit. Für die 3D-Ansicht kommen zusätzlich ein FPS- und Speicherziel auf dem Zieltelefon hinzu.

## Verzeichnisaufbau (geplant)

```
spaces-mmo/
  package.json          Paket phi-spaces-mmo (next, react, react-dom, pixi.js, phi-spaces: "file:..")
  tsconfig.json         eigene; nicht Teil des Root-`tsc`; moduleResolution "bundler" wie codemode-chat
  server/               die Engine
    launch.ts           startet space, world, npc, automaton, web (Entwicklung)
    space-host.ts       Space-Prozess (Welt-Space + Space `accounts`)
    world-host.ts       Befehle, Ticks, Spawner
    npc-host.ts         Skript-NPCs (später Agenten)
    automaton-host.ts   Automaten im Sandbox (Phase 6)
    index.ts            Web-Prozess, Gateway, Login
    ws.ts               eigene Kopie des Gateways (wie help-site und codemode-chat)
    engine/             typeclasses/, commands/, cmdsets.ts, locks.ts, prototypes.ts, funcparser.ts, combat/ (optional)
  client/               React-Oberfläche, MapView (PixiJS), Textlog, Login
  app/                  Next.js-Routen
  worlds/
    leuchtfeuer/        Räume, Prototypen, Typklassen-Erweiterungen, Hilfe, Automaten-Vorlagen, assets/
  tests/                node:test, starten die Prozesse wie test:codemode-chat
  docs/                 dieses Verzeichnis
```

Die Engine lädt genau eine Welt (`SPACES_MMO_WORLD=leuchtfeuer`). Eine Welt bringt Daten (Räume, Prototypen, Hilfe,
Grafiken) und kann Typklassen und Befehle ergänzen, aber keine Engine-Regeln (Transaktionen, Locks, Rechte) ändern.

**Getrennt von phi-spaces:** In `src/` kommt kein Spiel- und kein Webcode. Hilfscode, den auch codemode-chat hat
(`ws.ts`, Helfer wie `keepAlive`, `takeExisting` aus `codemode-chat/server/space.ts`), bekommt spaces-mmo als eigene
Kopie; help-site und codemode-chat machen es heute genauso.

## Einbindung von phi-spaces

Als Paket: `"phi-spaces": "file:.."` und `import { RemoteSpace, socketTransport } from "phi-spaces"`, ohne Build und
ohne besondere Node-Flags (siehe [paket.md](paket.md)). `npm run check:durable` gilt auch hier, also kein pi-durable, chord oder pi-ai im
Spiel. Modell-NPCs gehen über das `agent/`-Paket als eigener Prozess.
