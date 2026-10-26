# Weltzeit

## Status

**Entwurf, noch nicht implementiert.** Heute besitzt spaces-mmo skalierte **Spieldauern** über
`SPACES_MMO_TIME_SCALE`: Feuer, Nebel, Flut und NPC-Pausen laufen dadurch in Tests schneller. Es gibt aber noch
keine persistierte Uhr mit Weltstunde, Welttag oder Kalender. Alle aktuellen Termine beruhen letztlich auf
`Date.now()` des Servers. Der Implementierungsstand in [modell-npcs.md](modell-npcs.md#stand) ist maßgeblich.

Dieses Dokument legt den Vertrag für eine echte Weltzeit fest. Sie ermöglicht insbesondere NPC-Pläne wie „Ines ist
von 6 bis 22 Uhr da“, das Ereignis `evening`, nach Weltzeit geplante Werke der Götter und narrative Tagesbudgets.

## Ziele und Grenzen

- Die Weltzeit ist nach Neustarts reproduzierbar und läuft standardmäßig während eines Serverausfalls weiter.
- Sie kann angehalten und beschleunigt werden, ohne dass fachliche Termine neu geschrieben werden müssen.
- Mehrere Welt-Worker lösen einen fälligen Termin zusammen genau einmal aus.
- Server und Client zeigen dieselbe Weltstunde; Entscheidungen trifft ausschließlich der Server.
- Die Welt hat einen eigenen Kalender ohne Zeitzone, Sommerzeit oder Schaltsekunden.
- Sessions, Transaktionen, Rollen-Leases, Netzwerk- und Modell-Timeouts bleiben **Echtzeit**. Eine pausierte Welt darf
  weder Sperren festhalten noch einen ausgefallenen Prozess künstlich am Leben halten.

Nicht Teil dieses Vertrags sind eine astronomische Simulation, unterschiedliche Zeitzonen je Insel oder ein
beliebiges Zurückdrehen der Welt. Rückwärts laufende Zeit würde bereits ausgelöste Ereignisse und Budgetschlüssel
mehrdeutig machen und ist deshalb verboten.

## Zeitarten

| Zeitart | Beispiele | Grundlage |
| --- | --- | --- |
| Weltzeit | Tageszeit, NPC-Pläne, Feuer, Nebel, Flut, Weltgeschichten | persistierte `WorldClock` |
| Betriebliche Echtzeit | Sessions, Transaktionen, `NpcOwner`, Healthchecks | Lease des Space / Serverzeit |
| Externe Echtzeit | Modell-Timeout, gemeinsames Kostenlimit pro UTC-Tag und Minute | Serverzeit |

Ein NPC darf also wegen pausierter Welt länger wach bleiben, seine Prozessrolle muss aber weiterhin als kurze
Echtzeit-Lease erneuert werden. Das globale LLM-Kostenlimit bleibt ein harter UTC-Echtzeitschutz; zusätzlich kann
eine Rolle ein narratives Kontingent je **Welttag** besitzen.

## Persistiertes Uhrenmodell

Im Welt-Space liegt genau ein Eintrag je Welt:

```ts
type WorldClockFields = {
  worldId: string;
  epoch: number;
  realAnchorMs: number;
  worldAnchorMs: number;
  rate: number;
  paused: boolean;
  version: number;
};
```

- `realAnchorMs` ist ein Unix-Zeitstempel aus `Date.now()` beim letzten Uhrenwechsel.
- `worldAnchorMs` ist die Weltzeit am selben Moment, gemessen ab Welttag 0, 00:00 Uhr.
- `rate` gibt Weltmillisekunden je realer Millisekunde an. `1` bedeutet Echtzeit, `60` lässt eine Weltminute in einer
  Echtzeitsekunde vergehen.
- `epoch` trennt Zeitlinien nach einer ausdrücklich inkompatiblen administrativen Neuinitialisierung.
- `version` versioniert Berechnung und Kalenderformat, nicht den laufenden Tag.

Die Weltzeit wird abgeleitet und nicht sekündlich hochgezählt:

```ts
function worldNow(clock: WorldClockFields, realNow = Date.now()): number {
  if (clock.paused) return clock.worldAnchorMs;
  return clock.worldAnchorMs + (realNow - clock.realAnchorMs) * clock.rate;
}
```

Beim Pausieren, Fortsetzen oder Ändern von `rate` nimmt ein Admin-Befehl den `WorldClock`-Eintrag in einer
Transaktion, materialisiert zuerst `worldNow`, setzt beide Anker auf den aktuellen Stand und schreibt dann Rate und
Pausezustand. Dadurch gibt es keinen Sprung. `rate` muss endlich und größer als null sein; Pause wird ausschließlich
über `paused` dargestellt.

### Bezug zu `SPACES_MMO_TIME_SCALE`

Der bestehende Wert beschreibt reale Dauer je Spieldauer: `0.002` lässt eine Spielstunde in 7,2 Echtzeitsekunden
vergehen. Beim erstmaligen Anlegen einer Uhr wird deshalb `rate = 1 / SPACES_MMO_TIME_SCALE` verwendet. Danach ist
die im `WorldClock` gespeicherte Rate maßgeblich; ein Neustart mit einem anderen Environment-Wert verändert eine
bestehende Welt nicht.

## Kalender

Der Kalender verwendet gleich lange Tage zu je 24 Stunden:

```ts
const WORLD_DAY_MS = 24 * 60 * 60 * 1000;
const WORLD_HOUR_MS = 60 * 60 * 1000;

const day = Math.floor(worldMs / WORLD_DAY_MS);
const millisOfDay = worldMs % WORLD_DAY_MS;
const hour = Math.floor(millisOfDay / WORLD_HOUR_MS);
```

Es gibt keine Bindung an die lokale Zeitzone des Hosts. Die Weltdefinition legt nur die anfängliche Weltstunde einer
neuen Welt fest, beispielsweise Welttag 0 um 08:00 Uhr. Anzeigen dürfen daraus Namen für Wochentage oder Jahreszeiten
ableiten; Persistenz und Vergleiche verwenden weiterhin die Zahl `worldMs`.

## Termine und Ablauf

Weltzeitabhängige Termine dürfen nicht allein als phi-spaces-Lease gespeichert werden: Eine Echtzeit-Lease kann eine
Pause oder nachträgliche Geschwindigkeitsänderung nicht abbilden. Fachliche Wahrheit ist deshalb ein eigener Entry:

```ts
type WorldScheduleFields = {
  scheduleId: string;
  clockEpoch: number;
  dueWorldMs: number;
  kind: string;
  payload: Record<string, unknown>;
  missed: "once" | "coalesce" | "replay-bounded";
};
```

Der Weltzeit-Scheduler liest Uhr und Termine. Für jeden fälligen Eintrag eröffnet er eine Transaktion und nimmt den
`WorldSchedule`-Entry. Nur der Worker, dem das gelingt, führt die Zustandsänderung aus und schreibt gegebenenfalls den
nächsten Termin in derselben Transaktion. Deterministische fachliche Schlüssel wie `evening:tag-183` verhindern
Duplikate auch nach verlorenen Antworten.

Wiederkehrende Termine werden vom bisherigen Solltermin aus weitergerechnet, damit langsame Ausführung nicht driftet.
Die Nachholregel steht am Termin:

- `once`: einmaliger Termin wird beim nächsten Start nachgeholt.
- `coalesce`: beliebig viele verpasste Perioden ergeben höchstens ein aktuelles Ereignis; danach folgt die nächste
  zukünftige Periode. Das ist der Standard für Flut, Nebel und Tagesereignisse.
- `replay-bounded`: höchstens eine festgelegte kleine Zahl wird nachgeholt; nur für fachlich notwendige Simulation.

Eine Echtzeit-Lease oder ein Timer darf den Scheduler effizient zum voraussichtlichen Realzeitpunkt wecken. Vor der
Ausführung muss er aber immer erneut `dueWorldMs <= worldNow(clock)` prüfen.

## Neustart und Ausfall

`WorldClock` und `WorldSchedule` liegen wie die übrige Welt standardmäßig in `world.sqlite`. Nur
`SPACES_MMO_MEM=1` macht sie flüchtig. Bei einem Neustart wird nichts aus Prozessspeicher rekonstruiert:

1. Der Worker liest die persistierte Uhr.
2. `worldNow` enthält die seit dem letzten Lauf vergangene Echtzeit.
3. Der Scheduler verarbeitet fällige Termine nach ihrer Nachholregel.
4. Eine pausierte Uhr bleibt über den Neustart hinweg pausiert.

Geplantes Verhalten ist damit: Die Welt läuft während eines ungeplanten Ausfalls weiter. Soll eine Wartung die Welt
anhalten, pausiert der Betreiber sie vor dem Herunterfahren ausdrücklich.

## Serverzeit und mehrere Hosts

`Date.now()` ist nur der Träger der Fortschreibung, nicht die fachliche Weltzeit. Die Hosts müssen ihre
Betriebssystemuhren per NTP/chrony synchronisieren. spaces-mmo darf eine auffällige Uhr nicht stillschweigend
akzeptieren:

- Der Scheduler speichert seinen zuletzt akzeptierten Real- und Weltzeitstand als Diagnosezustand.
- Ein Rücksprung der Systemzeit oder eine Abweichung über einer konfigurierten Toleranz stoppt neue
  Weltzeitereignisse fail-closed und erzeugt einen Betriebsalarm.
- Bereits ausgelöste Ereignisse werden niemals zurückgenommen.
- Nur der Inhaber einer kurzen Echtzeit-Lease `WorldClockOwner` plant aktiv; die Transaktion am Termin bleibt trotzdem
  der Schutz gegen Doppelverarbeitung bei Übernahme oder Lease-Ablauf.

Die erste Implementierung darf auf einem Host laufen, muss aber dieselben Prüfungen und den genau-einmal-Vertrag
behalten, damit eine spätere Verteilung das Zeitmodell nicht ändert.

## Verwendung

### NPC-Pläne

Eine Rolle erhält einen Plan in Weltstunden:

```ts
plan: { presentFromHour: 6, presentUntilHour: 22 }
```

Der NPC-Prozess erzeugt aus den nächsten Grenzen Termine. Beim Termin wird die Figur serverseitig ein- oder
ausgeblendet. Ein Neustart oder eine Übernahme der Rolle prüft zusätzlich direkt den aktuellen Plan, sodass ein
verpasster Anzeige-Termin keine falsche Anwesenheit hinterlässt. Über Mitternacht laufende Pläne, etwa 20 bis 2 Uhr,
werden ausdrücklich unterstützt.

`evening` ist ein deterministisches Ereignis je Welttag. Es wird nur erzeugt, wenn die Weltdefinition es verwendet;
ob der Erzähler tatsächlich spricht, hängt weiterhin von anwesenden Spielern und seinen Modellgrenzen ab.

### Feuer, Nebel, Flut und Markt

- Feuer speichert künftig `untilWorldMs`; die bestehende Echtzeit-Lease ist höchstens Cache beziehungsweise
  Aufweckhilfe. Die Prüfung gegen Weltzeit entscheidet, ob es brennt.
- Nebel und Flut verwenden `WorldSchedule` statt eines endgültig in Echtzeit berechneten `Ticker.due`.
- Gegenstände mit weltzeitlicher Lebensdauer speichern `expiresWorldMs`. Beim Aufheben wird diese Frist wie heute
  entfernt.
- Direkte Tauschangebote und andere Interaktionen zwischen gerade anwesenden Menschen dürfen bewusst Echtzeit bleiben;
  diese Entscheidung wird je Entry-Typ dokumentiert.

### Modellbudgets

Der Schlüssel für das narrative Rollenbudget enthält `clockEpoch` und `worldDay`, beispielsweise
`npc:ines:e2:d183`. Das globale Betreiberlimit pro UTC-Tag und Minute bleibt zusätzlich bestehen und kann durch hohe
Weltrate oder administrative Zeitsprünge nicht zurückgesetzt werden.

### Gateway und Client

Das `hello`-Frame enthält eine Uhrenansicht:

```ts
worldTime: {
  epoch: number;
  worldMs: number;
  rate: number;
  paused: boolean;
  serverNowMs: number;
}
```

Der Browser darf daraus die Anzeige zwischen Frames interpolieren. Bei Sichtbarkeit, Reconnect und regelmäßigem
Server-Update synchronisiert er neu. Kein Client entscheidet anhand seiner interpolierten Uhr über Anwesenheit,
Ablauf oder Ereignisse.

## Migration

1. `WorldClock` und reine Berechnungsfunktionen einführen; bestehende Welt initialisiert mit konfigurierter
   Startstunde und `rate = 1 / timeScale`.
2. Uhr im Gateway anzeigen und Adminbefehle für Status, Pause, Fortsetzung und Rate ergänzen.
3. NPC-Pläne und `evening` auf `WorldSchedule` umstellen.
4. Narrative NPC-Tagesbudgets ergänzen, ohne die realen Kostenlimits zu ersetzen.
5. Feuer, Nebel, Flut und weitere fachliche Spieldauern auf Weltfristen migrieren.
6. Erst wenn kein fachlicher Timer mehr direkt von `gameMs()` abhängt, wird `SPACES_MMO_TIME_SCALE` zum reinen
   Initialwert herabgestuft.

Während einer Migration darf derselbe Mechanismus nicht gleichzeitig von altem Echtzeit-Ticker und neuem
Weltzeit-Scheduler ausgelöst werden. Die Weltversion schaltet jeden Typ atomar auf genau einen Besitzer um.

## Abnahme

- Gleiche Uhrdaten und gleiche Serverzeit liefern bytegleich dieselbe Weltzeit und Kalenderzerlegung.
- Pause hält Weltzeit und fachliche Termine an, während Sessions und Rollen-Leases weiter ablaufen.
- Ratewechsel verursachen keinen Sprung; bestehende Welttermine behalten ihre fachliche Fälligkeit.
- Ein Neustart erhält Uhr, Pause, Rate und Termine. Die gewählte Nachholregel wird eingehalten.
- Zwei Welt-Worker lösen denselben fälligen Termin genau einmal aus; Prozessabbruch vor Commit lässt ihn wiederkommen.
- Ein Plan 6–22 Uhr und ein Plan 20–2 Uhr verhalten sich an allen vier Grenzen korrekt.
- `evening` entsteht höchstens einmal je `clockEpoch` und Welttag.
- Weltbudgets wechseln an der Welttagsgrenze; reale Minuten- und UTC-Tageslimits bleiben davon unberührt.
- Rückwärts laufende oder unplausibel springende Hostzeit stoppt den Scheduler und erzeugt einen Alarm.
- Clientanzeige und Serverentscheidung stimmen nach Reconnect und Ratewechsel überein.

