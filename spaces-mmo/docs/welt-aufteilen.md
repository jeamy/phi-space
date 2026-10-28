# Die Welt aufteilen (Entwurf)

Stand 2026-10-28, nach dem [Lasttest](lasttest-2026-10-28.md) und den Änderungen in [betrieb.md](betrieb.md)
(„Last und Latenz“). Noch nicht gebaut: erst messen, was Index, `batch`, transiente Nachrichten und der Umzug des
Space auf big bringen; dieser Entwurf lohnt erst, wenn ein Kern auch danach nicht reicht.

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
