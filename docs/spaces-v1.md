# pi-spaces v1 – Dokumentation und Bestandsaufnahme

Stand: Commit `b16792a` (readAll / space_list). Dieses Dokument beschreibt, was die Implementierung heute tut, wo
ihre Grenzen liegen und was als Nächstes sinnvoll ist. Der Föderationsplan (mehrere Hosts, Handy als Steuerung) steht
in [federation-plan-v1.md](federation-plan-v1.md) und baut auf den Lücken hier auf.

## 1. Architektur

```
 Agent (LLM)                Host-Code (TS)
     │ space_* Tools             │ new JavaSpace(harness, ctx[, …, as])
     ▼                           ▼
 src/index.ts  ──────────►  src/client.ts  (JavaSpace: blockierendes read/take, Watch, Debounce, once-Hook)
 (Tools, Prompt-Section,        │
  Delivery, Reaper)             ▼
                           src/core.ts    (reine Semantik über SpaceState; keine pi-Imports)
                                │
                           src/doc.ts     (Space = ein Session-Dokument "pi-spaces.space", Version 4)
                                │
                           pi-durable Harness (SQLite / JSONL), ein Prozess pro Storage
```

- **Ein Space = ein Session-Dokument.** Jede Operation ist ein `harness.commit`, der das ganze Dokument liest,
  `core.*` darauf anwendet und es atomar zurückschreibt. Daraus folgen Atomarität, Crash-Sicherheit und
  Restart-Festigkeit, aber auch die Skalierungsgrenzen (Abschnitt 5).
- **`core.ts` ist rein**: jede Funktion bekommt `now` explizit, mutiert den Draft und wirft bei Fehlern. Alle Tests der
  Spec-Semantik laufen ohne Harness.
- **Zeit**: absolute Deadlines in ms seit Epoch (`Date.now`). `FOREVER = Number.MAX_SAFE_INTEGER` bleibt als
  absolute Zeit unverändert (`until`). Timer werden auf `MAX_TIMER_MS` (≈24,8 Tage) gekappt und erneut gestellt.

## 2. Datenmodell (`SpaceState`)

| Feld | Inhalt |
|---|---|
| `nextId` | Zähler für alle IDs (`e…` Entry, `t…` Txn, `n…` Registrierung, `w…` Waiter) |
| `entries` | `EntryRec`: `type`, `types` (Typ + Supertypen), `fields`, `expires`, `writtenUnder`, `takenBy`, `readBy[]`, `owner` |
| `txns` | `TxnRec`: `expires`, `owner` |
| `regs` | Notify-Registrierungen: Template, Lease, Txn, Handback, Ziel, `seq`, Rate-Limit-Zustand (`pending`, `pendingEntry`) |
| `waiters` | geparkte read/take für eine Conversation: Template, `take`, Deadline, `txnLeaseMs`, Handback |
| `outbox` | noch zuzustellende Events (`entry`, `waiter`, `timeout`) mit `tries`/`retryAt` |
| `returned` | dauerhafter Zähler zurückgegebener Takes |
| `limits` | überschriebene Quoten |

## 3. Semantik

### Operationen
- **write**: Entry mit Lease, optional unter Txn (dann unsichtbar bis Commit). Lease 0 → nie sichtbar, kein Event.
- **read / take** (blockierend, Client): ein Commit pro Runde (probe + Ergebnis + `nextExpiry`). Ein Doc-Watch wird
  *vor* der ersten Probe angelegt; `dirty` verhindert verlorene Wakeups. Nach einem Wake durch Änderung 20–40 ms
  Debounce mit Jitter.
- **readIfExists / takeIfExists**: warten nur, solange alle Treffer von fremden Txns gesperrt sind.
- **readAll / space_list**: Snapshot ohne Commit, ohne Sperre, max. 1000, älteste zuerst.
- **count / stats**: rein auf Snapshot, beurteilen ungesettelte Zustände so, wie ein `read` nach `settle` sie sähe.
- **notify**: Registrierung mit Lease; Events pro Registrierung mit streng steigender `seq`. Für Conversations
  Rate-Limit (`notifyIntervalMs`, Default 1 s) mit Bündelung (`count`).
- **wait** (`space_wait`): geparkter read/take, nicht-blockierend. Take-Waiter nehmen unter einer neuen Txn, die dem
  Empfänger gehört; nicht zustellbar → Txn wird sofort freigegeben.
- **Transaktionen**: Writes unsichtbar bis Commit, Takes sperren, Reads sperren gegen Takes, Abort/Ablauf macht
  rückgängig. Abläufe werden in `settle` chronologisch nachgespielt.

### Ownership und Quoten
- `as` (Conversation-ID) besitzt, was es erzeugt. Fremde und hosteigene (`owner: null`) Txns/Leases sind tabu
  (`PermissionError`). Lesen und Nehmen fremder Entries ist erlaubt.
- Host-Code (`as` undefined) ist unbeschränkt und quotenfrei.
- Quoten (`LimitError`): 64 KiB pro Entry/Handback, 128 Zeichen Typname, 16 Typen, 1000 Entries pro Owner, 10 000
  global, je 20 Registrierungen/Waits/Txns pro Owner.

### Exactly-once
- `space_write`, `space_wait`, `space_notify`: Claim-Dokument (Task-Scope) im selben Commit.
- `space_read`, `space_take`: `once`-Hook speichert Entry *oder* Miss (`null`) im entscheidenden Commit.
- Delivery: `requestId = pi-spaces:<eventId>:<seq>`; pi-durable dedupliziert pro Conversation.
- `space_txn`, `space_lease`: `replay: "unsafe"` (kein Claim).

### Hintergrunddienste
- `startMaintenance` (Reaper): settle beim nächsten Ablauf, getriggert durch Watch und Timer, serialisiert.
- `startDelivery`: Outbox → `conversation.submit`, Backoff `retryMs * tries`, Aufgabe nach 5 Versuchen,
  serialisiert. Nicht-numerische Ziele werden **verworfen** (wichtig für die Föderation, siehe Lücke L1).
- Monitoring: `Meter` (prozesslokal, Raten über abgeschlossene Sekunden), `watchLive`, `formatStatus/Widget`.

## 4. Gefundene Fehler und Lücken

Nach Schwere sortiert. Mit **[Bug]** markierte Punkte sind echte Fehlverhalten, der Rest Lücken oder Design-Grenzen.

| # | Punkt | Wo | Auswirkung |
|---|---|---|---|
| B1 | **[Bug]** Event-Text sagt „read it with space_read, id eX“, aber Templates können nicht nach ID matchen. | `index.ts` `shown()` | Ein abgeschnittener Entry ist für den Agenten oft nicht gezielt lesbar (nur wenn seine Felder eindeutig sind). Fix: `id` als Template-Parameter in `space_read/take/list` (exakte ID-Suche, O(1) mit Index). |
| B2 | **[Bug, klein]** `cancel` einer Registrierung mit gebündeltem Rest schickt das Bündel noch (`expire` emittiert `pending`, auch bei `cancel` über `l.set(now)`). | `core.ts` `cancel`/`expire` | Nach explizitem Abbestellen kommt noch ein Event. Fix: bei `cancel` `pending` vorher löschen; nur bei natürlichem Ablauf senden. |
| B3 | **[Bug, klein]** `notifyIntervalMs` wird bei Registrierung kopiert; spätere `setLimits` wirken nicht auf bestehende Registrierungen. | `core.notify` | Drosselung lässt sich für laufende Abos nicht nachschärfen. Fix: Intervall zur Laufzeit aus `limitsOf(s)` lesen, Feld nur als Marker „ist Conversation-Abo“. |
| L1 | Delivery kennt nur Conversations im eigenen Harness; String-Ziele werden verworfen. | `deliverEvents` | Kein Weg, Events an Remote-Peers, Handy oder andere Spaces zu leiten. Voraussetzung für Föderation. |
| L2 | Keine Änderungsrevision im Dokument (`rev`) und kein Änderungsstrom. | `SpaceState` | Replikation, inkrementelle Dashboards und Long-Poll „seit Revision X“ sind nicht möglich. |
| L3 | IDs sind lokal fortlaufend (`e5`, `t3`). | `newId` | Über Hosts nicht eindeutig; erratbar (durch Ownership entschärft, aber Informationsleck über Aktivität). |
| L4 | Kein Notify bei *Verfügbarkeit* (Entry kommt nach Abort zurück, Txn-Write wird committed: Letzteres geht, Ersteres nicht). | `finish` | JavaSpace05 `registerForAvailabilityEvent` fehlt; Agenten, die auf Rückläufer warten, sehen sie nur über `space_wait`. |
| L5 | Keine Batch-Operationen (JavaSpace05 `write(List)`, `take(Collection, max)`, `contents`). | client/tools | Ein Agent, der 50 Jobs verteilt, braucht 50 Tool-Calls und 50 Commits. |
| L6 | `space_txn begin` ist nicht exactly-once. | `index.ts` | Nach Replay bleibt eine zweite, verwaiste Txn bis zum Lease-Ende (zählt gegen Quote). Fix: Claim wie bei `space_write`. |
| L7 | Kein Gesamtgrößenlimit, Host-Writes sind quotenfrei. | `limits` | Worst Case 10 000 × 64 KiB ≈ 640 MiB in *einem* Dokument, das bei jedem Commit komplett geschrieben wird. Fix: `maxSpaceBytes` (auch für Host, abschaltbar) und laufend gepflegte Bytesumme. |
| L8 | Templates nur mit Gleichheit; keine Bereiche, `in`, Präfix, Existenz. | `matches` | Spec-konform, aber für Agenten oft zu schwach (z.B. „prio ≥ 5“, „region in [a,b]“). |
| L9 | Keine Reihenfolgegarantie / Priorität. | `find` | Spec-konform. In der Praxis ist es Array-Reihenfolge (FIFO-ähnlich), das sollte dokumentiert *oder* explizit gemacht werden (Option `order: "oldest"`). |
| L10 | Delivery stellt Events sequentiell zu. | `deliverEvents` | Eine langsame `submit` hält alle anderen auf. Fix: parallel pro Ziel, begrenzt (z.B. 8). |
| L11 | Meter ist prozesslokal; nicht pro Space, nicht dauerhaft. | `meter.ts` | Bei mehreren Spaces/Hosts nicht aggregierbar. Für Föderation: Meter pro Space + `stats` per RPC. |
| L12 | `stats.byType` zählt nur den eigenen Typ, keine Supertypen. | `core.stats` | Dokumentieren oder `byTypeIncl` ergänzen. |
| L13 | `readAll` zählt `reads` im Meter und hat keinen Cursor. | client | Mehr als 1000 Entries sind nicht durchblätterbar. Fix: `after: entryId`-Cursor. |
| L14 | Die Extension läuft heute nirgends produktiv: `pi-serverd.mjs` und `server.mjs` (pi-termux-mobile) laden nur `Subagent`, kein `spaces`, kein `startService`. | pi-termux-mobile | Stufe 0 des Föderationsplans. |

## 5. Performance und Optimierung

Die Kosten wachsen mit Entries *N*, Waitern *W*, Registrierungen *R*.

| Stelle | Heute | Problem | Vorschlag |
|---|---|---|---|
| Jeder Commit | ganzes Dokument lesen/schreiben | O(Größe) pro Operation, auch für `NO_WAIT`-Miss | Größenlimit (L7); mittelfristig Sharding: ein Dokument pro Typ-Präfix oder pro Hash-Bucket, Metadaten (Txns, Waiter, Regs) separat |
| `settle` | läuft in *jeder* Operation, `serve` prüft alle Waiter gegen alle Entries | O(W·N) pro Probe | Waiter nur bei Änderungen bedienen (Dirty-Flag im State: neue/zurückgekommene Entries seit letztem `serve`), Index Typ → Entries |
| `find` | lineare Suche | O(N) | Index nach `types[i]` (Map Typ → IDs), optional nach einem deklarierten Schlüsselfeld |
| Quoten | `entries.filter(ownedBy)` pro Write | O(N) | Zähler pro Owner im State pflegen |
| `nextExpiry` | Scan über alles | O(N+R+W) | Bei Sharding: Min-Wert pro Shard; ansonsten unkritisch |
| Blockierte Clients | jeder Doc-Watch weckt alle Wartenden | Thundering Herd (durch Debounce gemildert) | Wartende Clients durch In-Prozess-Waiter ersetzen: Client registriert Template lokal, ein zentraler Watch prüft einmal und weckt nur passende |
| `space_wait` | Event per `submit` als neuer Turn | Kosten pro Event = ein LLM-Turn | Ist gewollt; Bündelung wie bei Notify optional auch für Read-Waiter |

Faustregel für den heutigen Stand: bis einige tausend Entries und einige Dutzend Waiter unproblematisch. Darüber
zuerst L7 und den `serve`-Dirty-Flag umsetzen, dann Indizes.

## 6. Erweiterungen (ohne Föderation)

Priorisiert nach Nutzen für Agenten.

1. **ID-Zugriff** (B1): `space_read/take {id}`; behebt den Bug und erlaubt „nimm genau diesen Job“.
2. **Batch**: `space_write {entries:[…]}`, `space_take {max: n}` (JavaSpace05). Ein Commit, ein Tool-Call.
3. **Erweiterte Templates** (opt-in, nicht Spec): `{"prio": {"$gte": 5}}`, `$in`, `$prefix`, `$exists`. Getrennt von
   Gleichheit halten, damit bestehende Templates unverändert matchen.
4. **Availability-Events** (L4): Notify auch für Rückläufer nach Abort und für `txnLeaseMs`-Ablauf.
5. **Priorität / Reihenfolge**: deklariertes Feld `prio` oder Option `order`, ohne die Spec-Semantik zu brechen
   (Default bleibt „unspezifiziert“).
6. **Schema pro Typ** (optional): Host registriert JSON-Schema für einen Typ; Writes von Agenten werden validiert.
   Reduziert Müll im Space und Prompt-Injection-Fläche.
7. **Read-only-Typen**: Host markiert Typen, die nur Host (oder bestimmte Owner) schreiben dürfen (z.B. `Config`,
   `Capability`). Wird für die Föderation gebraucht.
8. **Benannte Spaces lokal**: mehrere Dokumente (`kind: pi-spaces.space`, Instanzschlüssel = Name) in einem Harness,
   Tool-Parameter `space`. Erster Schritt zur Föderation und zugleich Sharding-Mechanismus.
9. **Agenten-Rezepte im Prompt**: kurze Muster (Worker-Loop mit `space_wait` + Commit, Fork/Join, Lock mit Lease,
   Heartbeat) statt nur Tool-Beschreibungen.

## 7. Testabdeckung

80 Tests (Core-Spec, Meter, Integration mit Crash/Reopen, Ownership, Quoten, Notify-Bündelung, Debounce, Replay).
Es fehlen:
- Lasttests (N = 10 000, W = 500) mit Messung der Commit-Dauer, als Grundlage für Abschnitt 5.
- Tests für B1–B3 (zuerst rot, dann Fix).
- Property-basierte Tests für `settle` (zufällige Abfolgen von Writes/Takes/Txns/Uhrsprüngen gegen ein einfaches
  Referenzmodell).
