# Götter: Agenten, die die Welt erweitern (nach Phase 5)

Ein Gott ist ein Modell-NPC ([modell-npcs.md](modell-npcs.md)) mit Domäne und Befugnis zum Bauen. Er erweitert die laufende
Welt nach Regeln; ob etwas live geht, entscheidet eine **Prüfung**, nicht eine Freigabe durch den Admin. Der Admin kann
Götter und einzelne Befugnisse abschalten und alles zurückrollen.

## Wer ein Gott ist

Feste Rolle in der Weltdatei (`worlds/<welt>/goetter.ts`), wie die anderen Modell-NPCs, mit eigenem Gedächtnis
(`NpcMemory`), Kennzeichen `von: "npc"` und zusätzlich einer **Domäne** und einer Liste von **Befugnissen**:

```ts
{ id: "nebel", name: "Die Nebelmutter", domaene: "Nebel, Inseln im Dunst, Wanderer",
  befugnisse: ["insel", "auftrag", "ereignis"], plan: { inselnTag: 1 }, budgetTag: 60 }
```

Er hat ein eigenes Cmdset `GodCmdSet`: eine Teilmenge der Builder-Befehle (`engine/commands/builder.ts`), die nur auf
Entwürfe und Zonen des Gottes wirken. Standard-Builder- und Adminbefehle bleiben gesperrt.

## Was Götter erschaffen können

| Befugnis | Was entsteht | Stufe |
| --- | --- | --- |
| `insel` | neue Insel: Räume, Ausgänge, Strandgut, Feuerstelle; erreichbar erst von einem brennenden Feuer aus | 1 |
| `auftrag` | Aufträge an der Auftragstafel („Bring drei Bündel Treibholz zur Wärterin“) mit Belohnung aus dem Vorrat der Welt | 1 |
| `ereignis` | Wetter und Welt-Ereignisse: dichter Nebel, Sturmflut, Fähre, Wanderer ([Ereignisse](modell-npcs.md#ereignisse-die-wecken-oder-wanderer-bringen)) | 1 |
| `geschichte` | Texte: Raumbeschreibungen, Gerüchte, Briefe, Namen, Chronik der Welt | 1 |
| `gegenstand` | neue Gegenstände und Rezepte (Prototypen) mit begrenztem Wert | 2 |
| `wesen` | Nebelwesen und Skript-NPCs mit einfachem Verhalten (kein Modell, nur Skript) | 2 |
| `markt` | Angebote und Händler-Skripte am Marktbrett | 2 |
| `welt` | **Entwurf einer neuen Welt** (eigene Weltdatei); geht nur mit Freigabe des Admins live, weil es einen Prozess und einen Space braucht | 3 |

Nicht erlaubt, nie: Engine-Regeln ändern, Konten, Ruf und Besitz von Spielern anfassen, vorhandene Räume oder
Gegenstände ändern oder löschen, Befehle außerhalb des `GodCmdSet`, Automaten anderer.

## Wann sie erschaffen

- **Auf Anlass:** Spieler legen Öl oder Strandgut als Gabe ins Feuer, der Gott „erhört“ sie und baut (die Gabe bezahlt
  zugleich die Grenze der Kosten).
- **Von sich aus:** nach Plan (`inselnTag` je Gott, geplante [Weltzeit](weltzeit.md)) und bei Ereignissen, etwa nach `fire.out` einen Auftrag,
  oder wenn viele Spieler Fortschritt haben und das Ziel „unerforschte Inseln“ unter einem Schwellwert fällt. Er wacht
  dafür auf wie ein Modell-NPC und zählt auf `SPACES_MMO_NPC_MAX`.
- **Bei Bedarf statt auf Vorrat:** Eine Insel wird erst gebaut, wenn Spieler sie anlaufen können (oder ein freier
  Tagesplatz bleibt), nicht fünfzig im Voraus.

## Wie ein Gott baut: Generator statt Freihand

Ein Gott muss keine `grid`-Strings schreiben. Er liefert im Entwurf je Raum eine **Bauanweisung**:
Größe, Biom (Strand, Fels, Sumpf, Lichtung …), Lage der Ausgänge, besondere Stellen (Feuerstelle,
Ankerplatz), dazu die Texte. Ein **Generator** (Skript, kein Modell, im selben Sandbox wie der Prüfer)
baut daraus die `ground`-Zeichenkette mit **Wave Function Collapse** im Tiled-Modell. Jede Domäne besitzt eine
versionierte Palette mit ausdrücklich definierten Kachelgewichten und Nachbarschaftsregeln — diese werden nicht aus
den Autotile-Bildern abgeleitet. Die Nebelmutter kann daher eine andere Palette als ein Feuergott verwenden. Ein
stabiler Hash und ein festgelegter PRNG leiten den Seed aus Entwurfs-, Raum- und Versuchsschlüssel ab. Die
Bauanweisung wirkt als *Vorseed*: Ausgänge, Spawn, Feuerstelle und Ankerplatz sind festgelegte Zellen, deren
Einschränkungen vor dem ersten Kollaps über das ganze Raster propagiert werden.

Der Entwurf enthält neben dem fertigen `ground` auch `algorithm`, `generatorVersion`, `palette` und `seed`. Das Raster
wird geprüft und beim Veröffentlichen gespeichert; ein Neustart erzeugt es nicht noch einmal. Damit bleiben bereits
veröffentlichte Räume auch nach Änderungen am Generator unverändert. Die genaue Trennung zwischen autoritativem
Raster und einer optionalen 3D-Darstellung beschreibt [architektur.md](architektur.md#3d-ausblick-threejs).

Das teilt die Arbeit dort, wo sie zuverlässig ist:

- **Das Modell** liefert Sinn: Thema, Namen, Beschreibungen, Auftragshaken, wohin Ausgänge führen.
- **Der Generator** liefert Form und garantiert lokale Kachelkompatibilität. Er kann trotzdem in einen Widerspruch
  laufen oder eine lokal gültige, aber global unspielbare Karte erzeugen. Das Modell muss keine vollständige
  24×16-Zeichenkette erfinden, was Tokens und syntaktische Fehler spart.
- **Der Prüfer** bleibt die Grenze (siehe unten): Er prüft den fertigen Entwurf genau wie einen
  handgeschriebenen (Erreichbarkeit, Budget, Texte). Widerspruch oder fehlende Erreichbarkeit führen bis zu einer
  festen Höchstzahl zu deterministischen Folgeversuchen. Danach wird ein geprüfter Fallback-Grundriss verwendet oder
  der Entwurf abgelehnt; der Generator läuft niemals unbegrenzt.

Handgezeichnete Räume bleiben erlaubt (feste Orte der Domäne, besondere Bauten); der Generator ist für
die Geländeräume gedacht, die sonst alle gleich aussehen müssten. Das Modell *kann* auch selbst ein
`grid` liefern — der Generator füllt dann nur die freien Flächen auf.

## Prüfung (statt Freigabe)

Ein Gott schreibt sein Werk als **Entwurf** (`Draft`-Entry im Format der Weltdateien). Der Prüfer (kein Modell, ein
Skript, im Sandbox wie der Judge) lässt ihn nur durch, wenn alle Punkte stimmen:

- Format gültig, Größe unter dem Höchstwert, alle Räume erreichbar, mindestens ein Rückweg;
- keine unbekannten Befehle, Locks oder Typen; Namen kollidieren nicht mit vorhandenen;
- Erhaltungsprüfung: die Gegenstände des Entwurfs sind nicht größer als das Tagesbudget für Neues (Inflationsgrenze);
- Texte: Länge, keine URLs, keine Namen realer Personen, Sprache de/en vollständig (`names: {de, en}`);
- das Werk berührt nur die eigene Zone (`zone: "gott:nebel:<id>"`), nichts Vorhandenes.

Besteht der Entwurf, wird er in **einer** Transaktion live geschrieben; sonst bekommt der Gott die Fehlermeldung und darf
es bis zu 3 Mal verbessern, danach wird er für diese Gelegenheit verworfen. Der Prüfer ist Teil des Spiels und hat
eigene Tests; ein Gott kann ihn nicht umgehen, weil `GodCmdSet` nur Entwürfe schreiben darf.

## Rückgängig und abschalten

- Jedes Werk trägt `zone` und `by` (Gott, Entwurf, Zeit). Der Admin kann im Konfigurationsfenster eine Zone **entfernen**
  (Räume, Gegenstände und Aufträge der Zone verschwinden, Spieler darin werden in den Hafen gebracht, ihre Sachen
  bleiben bei ihnen) oder einen ganzen Gott „zurückrollen“.
- Der Admin kann **Götter insgesamt**, **einen Gott** oder **eine Befugnis** abschalten; bereits gebaute Werke bleiben,
  es entstehen keine neuen.

## Einstellungen (Konfigurationsfenster, `.env` für die Anfangswerte)

| Feld | Umgebungsvariable | Standard |
| --- | --- | --- |
| Götter erlaubt (braucht `SPACES_MMO_LLM=1`) | `SPACES_MMO_GODS` | aus |
| Neue Inseln je Tag (alle Götter) | `SPACES_MMO_ISLANDS_PER_DAY` | 1 |
| Inseln gesamt (von Göttern) | `SPACES_MMO_ISLANDS_MAX` | 20 |
| Größe einer Insel (Räume) | `SPACES_MMO_ISLAND_ROOMS_MAX` | 12 |
| Aufträge von Göttern gleichzeitig | `SPACES_MMO_GOD_QUESTS_MAX` | 10 |
| Entwürfe, die ein Gott je Tag abgeben darf (Versuche zählen) | `SPACES_MMO_GOD_DRAFTS_PER_DAY` | 6 |

Dazu das Tagesbudget je Gott (`budgetTag`) und die gemeinsamen Modellkontingente. Ist ein Limit erreicht, wartet der
Gott bis zum nächsten Tag und zeigt eine Skriptzeile.

## Abnahme

- Ein Entwurf mit unerreichbarem Raum, einem unbekannten Befehl, zu vielen Gegenständen oder einem Eingriff in eine
  fremde Zone wird abgelehnt; ein gültiger geht in einer Transaktion live.
- Gleicher Seed, gleiche Palette und gleiche Generatorversion ergeben bytegleiches `ground`; alle Nachbarschaften
  entsprechen der Palette. Spawn, alle Ausgänge und besonderen Stellen sind per BFS gegenseitig erreichbar.
- Ein Neustart regeneriert keinen veröffentlichten Raum; ein späteres Generator-Update verändert nur neue Entwürfe.
- Ein geskripteter Gott kann mit dem `GodCmdSet` keinen vorhandenen Raum ändern oder löschen.
- Mit `SPACES_MMO_GODS=0` oder abgeschalteter Befugnis entsteht nichts Neues; Bestehendes bleibt.
- „Zone entfernen“ löscht alle Entries der Zone und lässt Spieler und ihre Sachen heil.
- Tageslimits (Inseln, Entwürfe) halten auch bei vielen Gaben; Gaben ohne freien Platz bleiben als Opfergabe im Feuer
  und zählen für den nächsten Tag.
- Neustart: laufende Entwürfe gehen nicht verloren und werden nicht doppelt live geschrieben (Lease je Entwurf).
- Live-Lauf mit echtem Modell nur auf ausdrückliche Freigabe.
