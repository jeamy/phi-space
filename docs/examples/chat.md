# Space-Chat

Stand: 2026-10-07. Implementierung: [chat.ts](../../examples/chat.ts).

Drei Conversations alice → bob → carol kommunizieren über Msg-Entries
`{room, from, to, n, text}`. Der Host erzeugt pro Empfänger ein Notify-Template nach room und to.
Entries bleiben als Verlauf im Space. Geskriptete Antworten sind deterministisch; im Live-Modus sind
inhaltliche Qualität, genaue Rundenzahl und Modellkonformität keine gesicherten Eigenschaften.

`runChat` ist ohne Seiteneffekte importierbar und mit maxTurns/timeoutMs konfigurierbar.
Die CLI verwendet geskriptet neun, live sechs Schritte. Der Host wartet auf die Nachrichtenzahl oder Deadline,
kündigt Abos, stoppt Delivery und bricht verbliebene Conversation-Arbeit ab, statt unbegrenzt auf Idle zu warten.
Abort/Shutdown benötigt weiterhin funktionierende Cancellation in Harness/Provider; dies ist keine harte
Betriebssystem-Frist für einen unkooperativen Prozess. Bereits zugestellte Events können bis zum Stop
noch Antworten auslösen. Notify ist best effort, keine allgemeine Exactly-once-Chat-Garantie.

```bash
npm run example:chat
# Real model: requires approval under AGENTS.md
node --experimental-strip-types examples/chat.ts --live "Thema"
```

Der Faux-Dispatcher ignoriert Systemnachrichten bei der Prüfung des letzten Tool-Resultats.
Nach dem Tool-Aufruf beendet er den Turn. Es handelt sich um Conversations in einem Prozess, nicht um
verteilte Hosts. MemoryStorage verliert den Verlauf bei Prozessende.

`recovery.test.ts` führt runChat selbst aus und prüft den Ring 0–3.
Die ältere chat.test.ts prüft eigene Skripte mit dem echten Space. Live-Modell-, Langzeit- und
Mehrhost-Nachweise fehlen. [Zur Übersicht](README.md).
