# Weltzeit

## Status

**Alle sechs Schritte der [Migration](#migration) sind implementiert** (2026-10-26). Die Uhr bestimmt, wann etwas fällig ist:
Feuer, Nebel, Flut, Strandgut, Aufträge, Marktangebote und die eigenen Timer der NPC-Rollen (Wachzeit, Wanderer-Fristen,
Grußsperren, Geplauder) laufen in Weltzeit, und eine pausierte Welt hält sie an. `SPACES_MMO_TIME_SCALE` ist nur noch der
Anfangswert der Rate einer **neuen** Uhr (`rate = 1 / Wert`); `gameMs` gibt es nicht mehr. Offen sind nur die beiden Punkte
des Abschnitts „Serverzeit“ (siehe die letzten Zeilen der Tabelle).

| Teil | Stand | Wo |
| --- | --- | --- |
| `WorldClock`-Eintrag, Berechnung, Kalender, Pläne in Weltstunden (rein) | fertig | `server/engine/worldtime.ts`, `model.ts` |
| Uhr beim Anlegen der Welt (eine je Welt, ein Neustart behält sie) | fertig | `engine/loader.ts` unter dem Welt-Lock |
| Anzeige: `worldTime` im `hello`, Frame `time` bei Änderung und alle 30 s, Kopfzeile des Clients | fertig | `gateway.ts`, `client/App.tsx` |
| Befehle `time`/`zeit` (alle), `clock`/`uhr` (Admin: Stand, `pause`, `weiter`, `rate <n>`) | fertig | `engine/commands/clock.ts` |
| `WorldSchedule`, Scheduler (`once`, `coalesce`; `replay-bounded` wird abgelehnt), Fail-closed-Wächter für die Hostzeit | fertig | `engine/schedule.ts`, `world-host.ts` |
| `evening`: ein Termin je Welt (`WorldDef.evening`), ein `WorldEvent` je Welttag und Epoche (`evening:e1:d183`) | fertig | `engine/worldevents.ts`, `engine/loader.ts` |
| NPC-Pläne (`NpcDef.plan`, auch über Mitternacht; Ines 6–22 Uhr) | fertig, anders als im Entwurf (siehe unten) | `npc-host.ts`, `engine/clockcache.ts` |
| Narrative Tagesbudgets: der Schlüssel der Rolle trägt Epoche und Welttag (`npc:ines:e1:d183`); die Limits je UTC-Tag und Minute bleiben | fertig | `engine/clockcache.ts` (`worldDayKey`), `llm.ts`, `npc/minds.ts` |
| Feuer in Weltzeit (`Flame.until` in Weltmillisekunden, ohne Lease; brennt, solange `until > Weltzeit`; ein Feuer in Echtzeit-Form wird beim Laden gelöscht) | fertig | `engine/fire.ts`, `engine/loader.ts` |
| Die wiederkehrenden Aufgaben `fire`, `fog`, `flood`, `storm`, `orders`, `market` und `sweep` als `WorldSchedule` (Art `tick`, `payload: { job, everyMs }`); der Echtzeit-Ticker (`engine/ticker.ts`) ist entfernt | fertig | `engine/worldevents.ts` (`tickJobs`, `tickHandler`), `world-host.ts` |
| Fristen als `expiresWorldMs` (Strandgut, Aufträge, Marktangebote); `sweep` (alle 10 Weltsekunden) nimmt Abgelaufenes; `get` löscht die Frist | fertig | `engine/sweep.ts`, `engine/commands/default.ts`, `trade.ts` |
| Gateway: `ObjView.until` bleibt Echtzeit des Browsers (aus Weltzeit gerechnet, bei Uhrwechsel neu gesendet), Brenndauer in Weltminuten | fertig | `gateway.ts`, `fire.ts` (`burnText`) |
| `WorldClockOwner`-Lease und gespeicherter Diagnosezustand der Hostzeit (Abschnitt „Serverzeit“) | offen (jeder Welt-Worker plant; der Schutz gegen Doppelverarbeitung ist die Transaktion am Termin) | |
| NPC-Rollen: eigene Timer in Weltzeit (`Npc.now()`: Wachzeit `NpcAwake.untilWorldMs` ohne Lease, die Sperre nach einem Besuch `NpcVisit.untilWorldMs`, Grußsperren, Gossip, Geplauder, Aufenthalt von Wanderern); der Rhythmus einer Runde folgt der Rate der Uhr (`Npc.pace`), die Runden laufen auch in einer pausierten Welt (die Rollen hören weiter zu); `sweep` räumt abgelaufene `NpcAwake` | fertig | `npc/scripts.ts`, `npc/economy.ts`, `npc/minds.ts`, `npc-host.ts`, `engine/clockcache.ts` |
| `SPACES_MMO_TIME_SCALE` nur noch Anfangswert der Rate (Schritt 6); `gameMs` entfernt | fertig | `engine/time.ts`, `engine/loader.ts` |

**Abweichung beim NPC-Plan:** Der Entwurf lässt den NPC-Prozess aus den Planrändern Termine erzeugen. Umgesetzt ist stattdessen
ein Abgleich vor jeder Runde der Rolle: Die Figur ist da, wenn `presentAt(plan, Weltzeit)` es sagt, sonst geht sie (mit
„geht nach Hause.“) und ihr Skript läuft nicht. Die Weltzeit kommt aus einem Zwischenspeicher der Uhr (alle 15 s gelesen,
dazwischen gerechnet). Das deckt Neustart und Übernahme der Rolle von selbst ab und braucht keinen Termin, weil das Ein- und
Ausblenden vom Prozess der Rolle abhängt (ihre Session hält nur er); Termine bleiben für Ereignisse, die ein Welt-Worker
auslöst. Der Plan gilt nicht für Wanderer.

**Nachholen:** `once` setzt den nächsten Termin vom verpassten aus, `coalesce` von jetzt aus (ein Ereignis für alle verpassten
Tage). Der Wächter (`ClockGuard`, Toleranz `SPACES_MMO_CLOCK_TOLERANCE_MS`, Standard 5 Minuten) stoppt bei einer Hostzeit, die
zurückspringt oder zu weit vorspringt, für zehn Sekunden alle neuen Weltzeit-Ereignisse und meldet das im Log
(`clock alarm`); bereits ausgelöste Ereignisse bleiben.

**Beim Einführen von Schritt 5:** Ein Feuer, das vorher als Echtzeit-Eintrag mit Lease lief, wird beim Laden der Welt gelöscht
(sein `until` läge in Weltzeit Jahrzehnte voraus); die Hüter legen nach. Strandgut, Aufträge und Angebote aus der Zeit davor
laufen mit ihrer Lease aus (sie haben kein `expiresWorldMs`). Alles ist in einem Schritt umgestellt: Es gibt keinen
Echtzeit-Ticker mehr, der dieselbe Aufgabe doppelt auslösen könnte.

**Anmerkung zur Rate:** Dauern in der Weltdefinition (Brennstoff, Nebelschritt, Gezeiten, Lebensdauer von Strandgut) und die Timer der
NPC-Rollen sind Weltmillisekunden ohne Umrechnung. Mit `SPACES_MMO_TIME_SCALE=0.002` (Rate 500) legt eine neue Welt ihre Uhr
beschleunigt an; eine bestehende Welt behält ihre gespeicherte Rate, und `clock rate <n>` ändert sie für alles zugleich
(auch den Rhythmus der Rollen). Der Zwischenspeicher der Uhr in den Prozessen der Rollen (15 s) lässt eine Änderung dort
spätestens nach dieser Zeit wirken.

Tests: `tests/weltzeit.test.ts`, `tests/weltzeit-budget.test.ts` (der Schlüssel wechselt an der Welttagsgrenze, die realen Limits zählen weiter) (Berechnung, Pause und Rate ohne Sprung, Kalender, Pläne 6–22 und 20–2 an allen vier Grenzen,
Browser-Interpolation, die Uhr im Spiel mit Admin-Befehlen, Termine, der Wächter, eine pausierte Welt hält Feuer, Nebel und Gezeiten an, die Aufräumrunde). Der Implementierungsstand in
[modell-npcs.md](../modell-npcs.en.md#status) bleibt für die NPCs maßgeblich.

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

