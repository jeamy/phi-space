# Die Welt aufteilen

Stand 2026-10-28 (abends): **gebaut**, nach dem dritten [Lasttest](lasttest-2026-10-28.md) mit 200 Figuren, bei dem ein
Kern nicht mehr reichte. Was davon wie gebaut ist, steht im Abschnitt [So ist es gebaut](#so-ist-es-gebaut); der Entwurf
darunter ist die Überlegung davor.

## So ist es gebaut

- **Vier Regionen** in `worlds/leuchtfeuer/world.ts` (`regions`): West (Graue Insel, Nebelholm), Nord (Möwenfels,
  Schären), Ost (Kupferhafen, Tangriff, Rauchholm), Süd (Krabbensand). Nur Fähren führen von einer in die andere
  (`tests/regions.test.ts` prüft das). Jede Region hat eine Startbucht mit Feuer und Hüter.
- **Ein Space je Region**, jeder in seinem eigenen Space-Prozess (`SPACES_MMO_REGION`, Datei `world-<region>.sqlite`),
  also auf einem eigenen Kern; dazu je Region ein Welt-Worker, ein NPC- und ein Modell-Prozess. Ohne
  `SPACES_MMO_REGIONS` ist die Welt ein Space wie bisher.
- **Der Teil der Welt einer Region** (`regionWorld` in `server/engine/regions.ts`): ihre Räume, die Ausgänge aus ihnen
  (auch die Fähren hinaus), ihre Dinge, Feuer, Strände, Märkte und Tafeln. Prototypen, Rezepte, Hilfe und die Uhr hat
  jede Region ganz. Die NPCs kennt jede Region alle (ein Händler fährt über die Grenze); angelegt wird ein NPC nur in
  der Region, in der er beginnt, mit einer Geburtsmarke (`NpcBorn`), damit keine Region ihn ein zweites Mal macht.
- **Übergabe an der Fähre** (`server/engine/handover.ts`), in Schritten wie unten im Entwurf: in der Transaktion
  des Befehls nimmt Region A die Figur, ihre Zelle und ihr Konto und schreibt eine `Handover`; das Gepäck bleibt
  zunächst in A. Ein Welt-Worker von A nimmt die `Handover` in einer Transaktion und bringt zuerst das Gepäck hinüber,
  je 40 Dinge in einem Paar Transaktionen (erst in B schreiben, dann in A nehmen; ein voller Rucksack passt nicht in
  eine Transaktion). Danach schreibt er die Figur in einer Transaktion von B (freie Zelle am Steg, Konto, Token) und
  schreibt die Transaktion von A fest. Stirbt er dazwischen, kommt die `Handover` zurück; ein Ding oder eine Figur, die
  B schon hat, wird nicht noch einmal geschrieben.
- **Der Web-Prozess** folgt dem Änderungsstrom jeder Region (Einträge als „Region:ID“), schreibt Befehle und die
  Sitzung einer Figur in die Region, in der sie steht (nach einer Überfahrt sofort), und verteilt neue Gäste reihum auf
  die Startbuchten (`server/region-spaces.ts`). Einstellungen und Modellwahl schreibt er in jede Region.
- **Umzug einer Welt aus einem Space** in die Regionen: `server/migrate-regions.ts` (jeder Eintrag in die Region seines
  Raums; `tests/migrate-regions.test.ts`: jede Figur genau einmal, keine Münze verloren).
- **Betrieb:** Compose-Profil `big` (`npm --prefix spaces-mmo run docker:big:up`), [betrieb.md](betrieb.md),
  „Regionen“.

Noch offen: `wer` zeigt nur die eigene Region; die Tageszähler der Übersetzungen gelten je Region; ein Befehl, der
während der Überfahrt getippt wird, wartet bis zu 3 s auf die Ankunft.

## Entwurf (vor dem Bau)

## Warum

Ein Space ist ein Prozess, und sein Kern (Kernlogik, Commit, Store) läuft auf einem Thread. Die ganze Welt ist heute ein
Space: alle Befehle aller Figuren gehen durch diesen einen Thread, gleich wie viele Welt-Worker es gibt. Mehr Kerne nutzt
das Spiel erst, wenn die Welt aus mehreren Spaces besteht, jeder mit eigenem Prozess (auf demselben oder einem anderen
Rechner).

## Schnitt

- **Ein Space je Region.** Eine Region ist eine Inselgruppe (`RoomDef.island` gibt es schon): ihre Räume, Ausgänge,
  Nebel, Feuer, Dinge, Zellen (`Spot`) und die Figuren, die gerade dort sind, mit ihren Tokens und Befehlen. Fast jeder
  Befehl bleibt in einer Region (Schritte, Aufheben, Nachlegen, Reden im Raum).
- **Ein globaler Space** für das, was alle Regionen teilen: Konten und Charaktere als Datensatz (wo eine Figur gerade
  ist: `CharacterHome { charId, region }`), Weltuhr und Termine, Kanäle, Marktbrett und Aufträge, Prototypen, Einstellungen,
  `Process`. Er wird selten geschrieben.
- Der Konten-Store bleibt, wie er ist.

## Übergabe zwischen Regionen

phi-spaces hat keine Transaktion über zwei Spaces. Ein Wechsel (ein Ausgang, eine Fähre in eine andere Inselgruppe) ist
deshalb eine Übergabe in Schritten, jeder für sich atomar und wiederholbar:

1. In Region A, in einer Transaktion: die Figur nehmen (`Character`, Token, Zelle), eine `Handover`-Entry schreiben
   (`{ charId, from: A, to: B, character: …, id }`), Commit. Die Figur ist jetzt in keiner Region sichtbar.
2. In Region B, mit `unique` auf `charId`: die Figur schreiben, ihr Token, ihre Zelle am Ankunftsort. Ein zweiter
   Versuch nach einem Absturz scheitert an `unique` und ist damit erledigt.
3. Im globalen Space `CharacterHome` auf B setzen, dann in A die `Handover`-Entry nehmen.

Ein Prozess, der die `Handover`-Entries von A liest, setzt eine liegengebliebene Übergabe fort (Schritt 2 und 3 sind
wiederholbar). Was die Figur trägt, wandert mit (Dinge mit `location = charId` gehören zur Figur, nicht zum Raum).

## Prozesse

- **Space-Prozesse:** einer je Region und einer für den globalen Space (`space-host.ts` bedient heute schon zwei Stores
  auf zwei Sockets; mehrere sind dieselbe Schleife). Verteilt auf die Kerne eines Rechners oder auf mehrere Rechner.
- **Welt-Worker:** je Region (nehmen nur die Befehle ihrer Region), Termine und Aufräumen im globalen Space.
- **Web:** folgt dem Änderungsstrom jeder Region und dem globalen (heute einer); eine Verbindung bekommt die Frames der
  Region ihrer Figur. Ein `Intent` geht in die Region, in der die Figur gerade ist (`CharacterHome`).
- **NPCs:** je Region, wo sie leben; ein wandernder NPC wechselt wie eine Figur.

## Was es kostet

- Ein Befehl über die Grenze kostet drei Commits in zwei Spaces statt einem; das ist selten (Fähren, Ränder).
- Die Weltkarte oben links (Atlas) und `wer` lesen alle Regionen: aus dem Cache des Web-Prozesses, nicht mit einem Aufruf
  je Region.
- Die Engine braucht für jeden Lesezugriff die Region (heute `c.space`): die meisten Befehle lesen nur den Raum der
  Figur, die Region ergibt sich daraus. Befehle mit globalen Daten (Markt, Aufträge, Kanäle) lesen den globalen Space.
- Tests: jeder Test einer Übergabe braucht zwei Spaces; die vorhandenen Tests laufen mit einer Region weiter.

## Schritte

1. Messen nach dem Umzug auf big: reicht ein Kern für die erwartete Zahl an Spielern (Befehle je Sekunde mal CPU-ms je
   Befehl aus `tests/perf/space-cost.ts`)?
2. Wenn nicht: den globalen Space abtrennen (Konten, Uhr, Markt, Kanäle). Das entlastet schon und braucht noch keine
   Übergabe.
3. Dann Regionen mit Übergabe, zuerst zwei, mit einem Test, der eine Figur hin und her schickt und einen Absturz in jedem
   Schritt übersteht.
