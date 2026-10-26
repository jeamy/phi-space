# Spielwelt: Leuchtfeuer

Die erste Welt auf der Engine spaces-mmo (`spaces-mmo/worlds/leuchtfeuer/`).

## Kernidee

Ein Archipel kleiner Inseln, dauerhaft im Nebel. Wo ein Leuchtfeuer brennt, ist der Nebel licht: dort kann man
sicher fahren, handeln und bauen. Wo es erlischt, rückt der Nebel vor, Wege verschwinden und Nebelwesen tauchen auf.
Kein Spieler kann ein Feuer allein dauerhaft halten; die Welt lebt davon, dass viele Leute (und Agenten) sich
gegenseitig zuarbeiten.

Spielerinnen und Spieler sind Strandläufer, Bootsleute, Händler oder Wärter. Es gibt keine festen Klassen, die Rolle
ergibt sich aus dem, was man tut.

## Warum gerade diese Idee

Die Spielmechaniken *sind* die Space-Semantik. Dadurch zeigt das Spiel phi-spaces, statt es nur zu benutzen:

| Spielmechanik | Space-Operation | Was das garantiert |
| --- | --- | --- |
| Strandgut aufheben | `take` auf ein `Flotsam`-Entry | Genau einer bekommt es, auch wenn zehn gleichzeitig „get“ tippen |
| Flut spült Strandgut fort | Lease des Entries läuft ab | Kein Aufräum-Job, der Space entfernt es selbst |
| Leuchtfeuer nachfüllen | `renew` auf die Lease des `Beacon`-Fuel-Entries | Erlischt von allein, wenn niemand nachlegt |
| Handel zwischen zwei Spielern | `take` beider Waren + `write` beider Ergebnisse in **einer** Transaktion | Kein Duplizieren, kein halber Tausch |
| Auftragstafel (Bauaufträge) | Master-Worker: `Order`-Entries, Arbeiter `take`n sie | Last verteilt sich auf alle, die gerade Lust haben |
| Nebelwesen tauchen auf | Welt-Worker reagiert auf `changes`, wenn Feuer erlischt | Ereignisgetrieben, kein Polling über die ganze Welt |
| Zauber/Buff „Laterne“ | Entry mit 10-Minuten-Lease | Ablauf = Wirkung endet |

## Spielschleife

1. **Bergen:** Die Flut (Welt-Tick, etwa alle 30 s pro Strandabschnitt) schreibt `Flotsam`-Entries mit kurzer Lease
   (2–5 min). Treibholz, Tang, Muscheln, selten Fundstücke mit Geschichte.
2. **Verarbeiten:** Aus Rohstoffen werden Brennstoff, Bootsteile und Werkzeug (Rezepte als Prototypen).
3. **Feuer halten:** Brennstoff in ein Leuchtfeuer legen verlängert dessen Lease. Jedes Feuer zeigt öffentlich, wer
   wie viel beigetragen hat (Ruf).
4. **Erkunden:** Nur von einem brennenden Feuer aus lassen sich neue Inseln im Nebel anlaufen. Neue Inseln = neue
   Räume, später von Buildern oder generiert.
5. **Handeln:** Markt (Angebote als Entries) und direkter Tausch. Das Marktbrett ist ein Space-Muster ohne
   Sonderlogik.

Zielkonflikt, der das Spiel trägt: Brennstoff selbst verbrennen (für das eigene Boot, die eigene Hütte) oder ins
gemeinsame Feuer legen.

## Agenten als Mitspieler

Weil jede Aktion ein Textbefehl ist, der als `Intent`-Entry in den Space geht, können Agenten aus `agent/` genau
dieselbe Schnittstelle benutzen wie Menschen:

- **Skript-NPCs** (ohne Modell): Fährmann, Händlerin, Leuchtturmwärter mit festen Routinen. Laufen als Worker.
- **Modell-NPCs** (kosten Tokens, nur mit ausdrücklicher Freigabe, Kontingente wie in codemode-chat
  `quota.ts`/`limits.ts`): Erzähler, Gerüchteküche, Wärter, die um Brennstoff bitten.
- **Automaten** (späte Phase): Spieler schreiben kleine Programme („Bojen“, „Sammelroboter“), die im
  pi-codemode-Sandbox laufen, wie die Beiträge in codemode-chat. Ein Automat hat ein Befehlsbudget pro Minute.

## Rahmen

- Rundenarm, nicht zuckend: Bewegung auf einem Raster, Welt-Ticks um 1 Hz. Ein Space-Roundtrip ist kein
  60-Hz-Spielschleifen-Takt.
- Gewaltarm im Kern; Nebelwesen sind in den meisten Zonen Hindernis, nicht Gegner. **Kampf ist optional:** ein
  abschaltbares Modul, das nur in eigens markierten Nebelzonen gilt, rundenbasiert und nur gegen Nebelwesen (siehe
  [phasen.md](phasen.md#modul-k--kampf-optional)).
- Gäste können sofort spielen; wer sich registriert, behält alles, was er als Gast erreicht hat (Charakter, Ruf,
  Automaten). Handeln und Weitergeben ist erst mit Konto möglich.
