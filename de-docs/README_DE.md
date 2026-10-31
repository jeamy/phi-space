# phi-spaces

[English](../README.md) · [Deutsch](README_DE.md)

> **Experimentelle Software — Verwendung auf eigenes Risiko.** APIs, Speicherformate und Betriebsverhalten können
> sich ändern. Für Produktion oder unersetzliche Daten sind unabhängige Validierung, geprüfte Backups und ein
> Wiederherstellungsplan erforderlich. Tests decken bestimmte Szenarien ab, nicht alle Fehlerfälle; lauffähige
> Demos belegen keine Produktionsreife. Bereitstellung ohne Gewährleistung gemäß [MIT-Lizenz](../LICENSE).

> **Namespace-Umstellung:** Persistente Dokumenttypen verwenden jetzt `phi-spaces.*`, das Runtime-Bundle heißt
> `phi-spaces.mjs`. Dies ist ein inkompatibler Speicher-/Integrationswechsel. Bestehende Stores benötigen
> vor Verwendung dieser Version eine gesondert geprüfte Offline-Migration. Dokumentversion 5 migriert
> keinen Dokumenttyp-Namespace; ein neuer leerer Namespace bedeutet nicht, dass die bisherigen Daten gelöscht sind.

phi-spaces ist eine TypeScript-Space-Bibliothek mit eigenem Speicher (SQLite im Besitz eines Prozesses oder Arbeitsspeicher).
Sie braucht kein Agenten-Framework; das optionale Paket `agent/` gibt
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable)-Agenten die Space-Werkzeuge.
Stores, die ältere Versionen über pi-durable geschrieben haben, werden verworfen, nicht übernommen. Es ist ein
Space für beliebige Daten, die ausgetauscht werden sollen: Aufträge, Nachrichten, Messwerte, Ergebnisse,
Zustände, Dateien oder Ereignisse. Agenten (Conversations) sind ein typischer Teilnehmer, aber nicht der
einzige; Programme, Dienste, Geräte und Menschen können ebenso in einen Space schreiben und daraus lesen.

Das Modell stammt von Linda-Tuple-Spaces und JavaSpaces, bei denen es um entkoppelte Koordination über gemeinsame
Daten geht, nicht um Agentenkommunikation. Der lokale phi-spaces-Client heißt
`PhiSpaces`; die Implementierung verwendet TypeScript und JSON und ist kein JavaSpaces-kompatibles Java-/RMI-Laufzeitsystem.

**Stand.** Die Bibliothek bietet einen lokalen dauerhaften Space, benannte Spaces, Request-Claims, Revisionen und einen
RPC-Dienst für einen Host (`SpaceService`, `RemoteSpace`, Unix-/TCP-Sockets), dauerhafte Mailboxen und einen
zusammengesetzten Föderations-Host mit Overlay-Identität, Schlüsselnachweis, Enrollment, signierten Grants und
Schlüsselrotation. Föderationsrouting, Membership, Lauf-/Worker-/Space-Verwaltung und mobile Steuerung sind umgesetzt.
Merge-Replikation, primary/sync-Replikation, Promotion und Recovery besitzen ebenfalls Implementierungen und
dokumentierte Tests, aber **Phase 3 ist noch nicht vollständig abgenommen**. Eine Implementierung ist keine Produktions-
oder Fehlermodell-Garantie: siehe [Implementierungsstand](../docs/implementierungsstand.en.md) und die
[Phase-3-Abnahmematrix](../docs/_attic/abnahme/ap3-abnahme.en.md).
Dieses README wurde am 30.10.2026 gegen das Checkout geprüft; jene Dokumente tragen die detaillierten Nachweise und offenen Gates.

## Tuple Spaces: Koordination über Daten

Ein Tuple Space ist eine gemeinsame, assoziativ durchsuchbare Sammlung: Teilnehmer veröffentlichen Daten und
finden sie über deren Inhalt, nicht über die Adresse eines Empfängers. Man kann es sich als gemeinsame Tafel
vorstellen, auf der ein Producer einen Auftrag hinterlässt und ein Worker später einen passenden Auftrag übernimmt.
Der Worker muss nicht wissen, wer ihn veröffentlicht hat, und der Producer muss nicht wählen, welcher Worker ihn
ausführt. Linda führte diese Form der generativen Kommunikation ein; Tupel überdauern die Interaktion, die sie
erzeugt hat, und ermöglichen so Kommunikation über Prozess- und Zeitgrenzen hinweg.
[Quelle: Gelernter, *Generative Communication in Linda*](https://www.cs.tufts.edu/comp/150FP/archive/david-gelernter/generative-linda.pdf).

JavaSpaces überträgt das Prinzip auf typisierte Java-Objekte namens **Entries**, mit Template-basierter Suche,
Leases und Transaktionen. Ein Template legt einen Entry-Typ und Feldwerte fest; nicht festgelegte Felder sind
Wildcards. Entries werden als Kopien ausgetauscht, nicht als gemeinsame lebende Objektreferenzen. Das
Anwendungsprotokoll ist ein Datenfluss durch den Space statt direkter Methodenaufrufe zwischen Producer und Consumer.
[Quelle: Oracles Einführung zu JavaSpaces](https://www.oracle.com/technical-resources/articles/javase/javaspaces.html).

### Die Grundoperationen

| Operation | Bedeutung in phi-spaces |
|---|---|
| `write(entry)` | Neuen Entry veröffentlichen; erneutes Schreiben erzeugt normalerweise einen weiteren Entry, keine Aktualisierung. |
| `read(template)` | Eine passende Entry-Kopie liefern, ohne sie zu verbrauchen. |
| `take(template)` | Einen passenden Entry exklusiv übernehmen; unter einer Transaktion wird die Entfernung erst beim Commit endgültig. |
| `notify(template, ...)` | Interesse an passenden künftigen Writes registrieren; das ist eine Benachrichtigung, keine exklusive Auftragsübernahme. |

Diese Namen folgen JavaSpaces. Linda nennt die entsprechenden Veröffentlichungs-/Entnahmeoperationen `out` und `in`.
Ein Space ist nicht von sich aus eine FIFO-Warteschlange, und Matching ist keine SQL-Abfragesprache.
[Quelle: JavaSpaces-Spezifikation, JS.1.3–1.4 und JS.2](https://river.apache.org/release-doc/current/specs/html/js-spec.html).

### Vier Dimensionen loser Kopplung

- **Zeitliche Entkopplung:** Ein Producer kann jetzt veröffentlichen und ein Consumer später handeln, ohne dass sich
  ihre Laufzeiten überlappen. In phi-spaces hängt das von der Lease des Entries und der weiteren Verfügbarkeit des
  Spaces beziehungsweise Storages ab. Ein persistenter Store kann Neustarts des Host-Prozesses überstehen; der
  Store im Arbeitsspeicher nicht.
- **Ortsentkopplung:** Producer und Consumer müssen ihre gegenseitigen Netzwerkadressen nicht kennen. Sie müssen
  den passenden Space-Zugang weiterhin finden beziehungsweise konfigurieren und mit Berechtigung erreichen.
  Ortsunabhängigkeit beseitigt weder Service-Discovery noch Routing oder Netzfehler.
- **Referenzentkopplung:** Teilnehmer einigen sich auf Entry-Schemata und Templates statt direkte Objektreferenzen
  aufeinander zu halten. Die Kopplung an diesen Datenvertrag bleibt. RPC **zum Space** ist weiterhin möglich:
  JavaSpaces nutzt RMI; phi-spaces bietet `SpaceService`/`RemoteSpace` über unterstützte Transporte.
- **Synchronisationsentkopplung:** Das Veröffentlichen eines Auftrags setzt nicht voraus, dass sein Consumer bereit
  ist oder ihn abschließt. Das heißt **nicht**, dass jede API-Operation asynchron wäre. JavaSpaces-Aufrufe sind
  synchron, und `read`/`take` können bis zu einem Treffer oder Timeout warten. phi-spaces liefert Promises: Ein
  `await` auf eine ausstehende Operation blockiert den JavaScript-Event-Loop nicht, aber der Aufrufer wartet
  weiterhin auf sein Ergebnis. Je nach Ablauf `NO_WAIT`, Benachrichtigungen oder dauerhafte Waiter verwenden;
  CPU-Arbeit und Serialisierung können den Event-Loop trotzdem belegen.

Linda beschreibt die zeitliche und prozessuale Trennung in der
[Originalarbeit](https://www.cs.tufts.edu/comp/150FP/archive/david-gelernter/generative-linda.pdf).
Die blockierenden Aufrufe und RMI-Ausnahmen stehen ausdrücklich in der
[JavaSpace-API](https://river.apache.org/release-doc/current/api/net/jini/space/JavaSpace.html).
Das phi-spaces-spezifische Verhalten ist in [unserer API](../docs/api.en.md) dokumentiert.

### Asynchrone Interaktion, wie sie in phi-spaces tatsächlich umgesetzt ist

`PhiSpaces` und die gemeinsame Remote-Schnittstelle `SpaceLike` bieten Promise-basierte Operationen. Ihre
Abschlusspunkte unterscheiden sich:

- `write` endet nach Abschluss seiner Storage-Mutation, nicht erst nach der Verarbeitung des Entries durch einen
  Consumer. Es ist nicht Fire-and-forget: Commit-Latenz und Fehler bleiben für den Producer sichtbar.
- `read`/`take` enden mit einem Treffer oder `null` beim Timeout. Mit `NO_WAIT` warten sie nicht auf einen
  künftigen Treffer, brauchen aber weiterhin Zeit für die Operation. `await` hält den Aufrufer an, nicht den
  gesamten Event-Loop.
- `wait` persistiert eine einmalige Registrierung und endet mit deren Wait-ID, statt den Aufruf bis zu einem
  Treffer offen zu halten. `notify` persistiert ein geleastes Abonnement auf passende Writes. Der Dienst stellt
  Ereignisse später an die Ziel-Conversation oder die konfigurierte Consumer-Mailbox zu; `startService` führt
  lokale Wartung und Zustellung aus.
- Die Agent-Tools `space_read`/`space_take` halten den aktuellen Turn während des Wartens an (maximal 60 Sekunden).
  `space_wait` gibt den Turn nach der Registrierung frei und kann mit persistentem Storage Prozessneustarts überstehen.
  Transaktionale Take-Waiter liefern eine geleaste Reservierung, keinen endgültig verbrauchten Auftrag.

Damit setzt phi-spaces sowohl auf den Aufrufer wartende asynchrone Operationen als auch dauerhafte, ereignisgesteuerte
Interaktion um. Es macht synchrone Serialisierungs-/CPU-Arbeit nicht nicht-blockierend und hebt endliche
Space-Budgets nicht auf. Siehe [`src/client.ts`](../src/client.ts), [`src/index.ts`](../src/index.ts) und die [Waiter-API](../docs/api.en.md).

### Was phi-spaces ergänzt und was es nicht verspricht

phi-spaces stellt einen Entry als `{ type, types?, fields }` mit JSON-Daten dar. Es behält die
Koordinationsprimitive bei und ergänzt persistente Request-Identitäten/Replay, benannte Spaces, revisionsbasiertes
Paging, Mailboxen, Completion-Profile und Betriebssteuerung. Das Matching verwendet tiefe JSON-Gleichheit, nicht
Javas Vergleich serialisierter Felder. Eine Transaktion kann einen Task reservieren und sein Ergebnis atomar im
zuständigen Space veröffentlichen. Transaktionen sind keine allgemeine hostübergreifende Two-Phase-Commit-API.

Mehrere Worker können um Aufgaben konkurrieren, ohne dass der Producer einen Worker zuweist. Geleaste Reservierungen
geben unfertige Arbeit nach Abort/Ablauf zurück, sofern nicht auch die Lease der Aufgabe selbst abgelaufen ist.
Eine Anwendung kann `CompletionProfile` nutzen, um vor dem Commit ihrer Task-Transaktion ein passendes Ergebnis zu
verlangen. Das macht einen externen HTTP-Aufruf, eine Zahlung oder einen Dateischreibzugriff nicht exactly-once:
Diese Wirkungen brauchen eigene Idempotenz oder Transaktion.

Die Tafel ist ein **logisches** gemeinsames Repository; ihre physische Umsetzung kann lokal, remote oder föderiert sein.
Das Muster allein bietet weder unbegrenzte Skalierung noch Replikation, Failover oder Partitionstoleranz. In dieser
Implementierung ist jeder Space ein Dokument; große Dokumente, Scans und Serialisierung bleiben echte Kosten.
Eine asynchrone API ist keine CPU-Parallelität, und eine logische Space-Transaktion ist nicht automatisch ein
einziger Storage-Commit. Der Social-Swarm-Worker bündelt ausdrücklich bis zu vier Tasks in zwei Storage-Commits; siehe
den [Betriebsvertrag des Hilfesystems](../help-site/README.md#demo-vertrag-und-wiederanlauf).

## Minimalbeispiel: veröffentlichen, lesen, reservieren, abschließen

Im Repository-Root mit den bereits vorhandenen Abhängigkeiten ausführen: den Block als `tuple-demo.ts` speichern
und `node --experimental-strip-types tuple-demo.ts` starten. Modellaufrufe und Server sind nicht nötig.

```ts
import { BACKGROUND_CONTEXT as ctx, FOREVER, NO_WAIT, PhiSpaces, openOwnMemoryHost } from "./src/index.ts";

const harness = openOwnMemoryHost(); // or openSqliteHost("space.sqlite") to keep it
try {
  const producer = new PhiSpaces(harness, ctx);
  await producer.write({ type: "Job", fields: { jobId: "square-7", value: 7 } }, null, FOREVER);
  // The producer need not wait for or address a particular worker.
  const worker = new PhiSpaces(harness, ctx);
  const template = { type: "Job", fields: { jobId: "square-7" } };
  console.log("inspect:", (await worker.read(template, NO_WAIT))?.fields);

  const txn = await worker.createTransaction(30_000);
  try {
    const job = await worker.take(template, NO_WAIT, { txn: txn.id });
    if (!job) throw new Error("No matching job");
    await worker.write({ type: "Result", fields: {
      jobId: job.fields.jobId, squared: Number(job.fields.value) ** 2,
    } }, txn.id, FOREVER);
    await worker.commit(txn.id);
  } catch (error) {
    await worker.abort(txn.id);
    throw error;
  }
  console.log("result:", (await producer.read({ type: "Result" }, NO_WAIT))?.fields);
  console.log("job remaining:", await producer.count(template));
} finally {
  await harness.close(ctx);
}
```

Das Ergebnis ist `squared: 49` und `job remaining: 0`. `read` lässt den Auftrag verfügbar; das transaktionale `take`
und das Schreiben des Results werden gemeinsam verbindlich. Dieses kleine Beispiel führt zwei Clients in einem Prozess
aus und nutzt flüchtigen Arbeitsspeicher: Es zeigt Koordination, **keine** Persistenz oder Netzwerk-Ausfallsicherheit.
`openSqliteHost` ermöglicht das Überstehen von Neustarts, `RemoteSpace` einen separaten Worker-Prozess; siehe
[Beispiele](../docs/examples.en.md) und [API](../docs/api.en.md).

## Schichten

| Datei | Aufgabe |
|---|---|
| `src/core.ts` | Reine Spezifikationssemantik über einen JSON-Zustand: Entries, Templates, Leases, Transaktionen, Notify |
| `src/doc.ts` | Das `Space`-Dokument des Default-Spaces (von Client und Meter gemeinsam genutzt, damit sie sich nicht gegenseitig importieren) |
| `src/spaces.ts` | Benannte Spaces: Registry (Host-ID, Alias → Space-ID), `createSpace`, `listSpaces`, `snapshotSpace` |
| `src/claims.ts` | Dauerhafte Request-Claims und Request-Generationen (idempotente Mutationen, `pollOperation`, `cancelOperation`) |
| `src/client.ts` | `PhiSpaces`: `write`, `read`, `readIfExists`, `take`, `takeIfExists`, `notify`, `snapshot`, Transaktionen, Lease `renew`/`cancel` |
| `src/index.ts` | Die öffentlichen Exporte; der Hintergrunddienst eines Spaces: Notify-Zustellung, Reaper (`startService`) |
| `agent/` | Das optionale Agentenpaket (eigene Abhängigkeiten): die `spaces`-Extension eines pi-durable-Agenten (Tools `space_write/read/take/wait/notify/txn/lease`, Prompt-Abschnitt) über einen separaten Space-Host, der Mobil-Einstieg, Agentenbeispiele und Tests |
| `src/context.ts` | Der Aufrufkontext (Abbruchsignal, Werte) |
| `src/standalone.ts`, `src/dashboard.ts` | Der eigenständige Space-Dienst (`npm run space-server`) und das lesende Live-Dashboard |
| `src/store/` | Speichergrenze: `types.ts` (StoreHost, StoreTx, Dokumente), `documents.ts` (`defineDoc`), `host.ts` / `sqlite.ts` (der eigene Store, docs/umstellung-ohne-pi-durable.en.md) |
| `src/meter.ts` | Prozesslokale Zähler und Raten |
| `src/canonical.ts` | Kanonisches JSON (RFC 8785) für Feldvergleich und Hashes |
| `src/stream.ts` | Begrenztes Revisionslog und Änderungsstapel sichtbarer Entries |
| `src/service.ts` | Authentifizierter, rollengeprüfter Space-RPC für einen Host |
| `src/remote.ts`, `src/socket.ts` | Wiederholender Remote-Client und Unix-/TCP-Transport |
| `src/federated-space.ts`, `src/router.ts` | Policy-basiertes Föderationsrouting und journalisierte Koordination |
| `src/entry-replication.ts`, `src/primary-sync.ts`, `src/replica-control.ts` | Merge-Replikation, synchrone Commit-Replikation und abgesicherte Übergänge; Abnahmegrenzen beachten |
| `src/run-controller.ts`, `src/workers.ts`, `src/space-lifecycle.ts` | Lauf-, Worker- und Space-Verwaltung |
| `help-site/` | Zweisprachige Hilfe, Social Swarm, Space-Chat-Stufen und authentifiziertes Web Admin |
| `codemode-chat/` | Agenten und Menschen lösen Programmieraufgaben gemeinsam um einen Space; jede Rolle ist ein eigener Prozess |
| `spaces-mmo/` | Online-Rollenspiel-Engine auf Spaces, erste Welt Leuchtfeuer |
| `rust/` | Rust-Portierung von Kern, Store und Dienst, in Arbeit ([docs/rust-portierung.en.md](../docs/rust-portierung.en.md)); maßgeblich bleibt der TypeScript-Code |

Ein Space ist ein Dokument; Commits des eigenen Stores (`src/store/`) sorgen für atomare Zustandsänderungen. Das Überstehen
von Neustarts setzt den SQLite-Store voraus,
und Strom-/Hostausfallgarantien hängen von den Storage-Einstellungen und dem Replikations-/Recovery-Modell des Betriebs ab.
Der Default-Space ist das Dokument
`phi-spaces.space` (Version 5); weitere benannte Spaces liegen in der Familie `phi-spaces.named-space`, adressiert über eine
unveränderliche, generierte `spaceId`. Das Registry-Dokument ordnet Aliase Ids zu und hält die Id dieses Hosts.

**Storage-Kompatibilität.** Der Store hat ein eigenes Dateiformat; über pi-durable geschriebene Stores werden nicht übernommen
(Entscheidung D6, [docs/umstellung-u0-bestand.en.md](../docs/umstellung-u0-bestand.en.md)). Agenten-Conversations behalten ihren eigenen
pi-durable-Speicher: 1.4.0 migriert ihn unumkehrbar auf Schema 2, siehe [docs/upgrade-pi-1.4.0.en.md](../docs/upgrade-pi-1.4.0.en.md).

## Zuordnung zur Spezifikation

- **Entries** `{type, types, fields}`; `types` (Typ, dann Supertypen) steht beim Schreiben fest. Templates: ein fehlender oder
  `null`-Typ/-Feldwert ist ein Wildcard, ein `null`-Template passt auf alles, Subtypen passen, Felder werden per tiefer Gleichheit verglichen.
  Wie bei Jini lässt sich nicht nach einem Feld mit dem Wert null suchen.
- **take**: Ein bestätigtes destruktives Take entfernt einen Entry genau einmal. Ein Take unter einer Transaktion ist eine Reservierung;
  Abort/Ablauf macht ihn wieder verfügbar. Tool-Replays liefern ihr gespeichertes Ergebnis, ohne die Mutation zu wiederholen.
  Das garantiert keine Exactly-once-Wirkung nach außen.
- **read vs readIfExists** (ebenso take): `*IfExists` wartet nur, solange jeder Treffer durch eine andere Transaktion gesperrt ist;
  einfaches `read`/`take` wartet bis zum Timeout darauf, dass ein Treffer erscheint. `NO_WAIT = 0`.
- **Leases**: wie angefragt gewährt. `ANY` bekommt 1 Stunde, `FOREVER` läuft nie ab (Tools: `"forever"`), negative Werte oder NaN
  werfen einen Fehler, abgelaufene Entries sind unsichtbar. Auch Waits und Timeouts akzeptieren `FOREVER`; Agenten können monatelang warten.
- **Transaktionen**: Writes sind außen bis zum Commit unsichtbar, Takes sperren, Reads sperren gegen Takes, Abort macht rückgängig,
  Lease-Ablauf bricht ab. Ein Worker, der unter einer Transaktion ein Take macht und stirbt, gibt seinen Auftrag zurück, wenn die Lease abläuft.
  Abläufe werden in Zeitreihenfolge angewendet, auch wenn länger niemand nachgesehen hat.
- **Besitz**: Tools handeln als ihre Conversation. Sie besitzt die Transaktionen, die sie beginnt (und die ein `space_wait` ihr übergibt),
  die Entries, die sie schreibt, sowie ihre Waits und Registrierungen, und darf nur ihre eigenen verwenden, committen, verlängern oder abbrechen.
  Besitzerlose Transaktionen und Leases gehören dem Host-Code, der uneingeschränkt ist.
- **notify**: Registrierung mit Lease, Handback und je Registrierung streng steigenden Sequenznummern. Ein Listener ist eine
  Conversation: Ereignisse werden als Eingabe mit `requestId = phi-spaces:eventId:seq` übergeben, sodass erneute Zustellung unschädlich ist.
  Best effort.
- **Waiter (nicht blockierendes wait)**: `space_wait` / `PhiSpaces.wait` parkt ein Read oder Take für eine Conversation und kehrt
  sofort zurück. Sobald ein Treffer erscheint (oder der Timeout abläuft), schickt der Space der Conversation eine Nachricht. Ein Take-Waiter nimmt den
  Entry unter einer frischen Transaktion, sodass eine verlorene Zustellung kein verlorener Auftrag ist: Der Empfänger committet ihn mit `space_txn`,
  andernfalls kehrt er in den Space zurück, wenn die Transaktions-Lease abläuft, oder sofort, wenn die Conversation nicht mehr existiert oder
  die Zustellung aufgibt. Waiter leben im Dokument und überstehen Neustarts; `space_wait` wartet standardmäßig ewig.
- **snapshot**: nur eine eingefrorene Kopie (der Snapshot von JavaSpaces ist ein Serialisierungscache).
- **Benannte Spaces**: `await harness.commit((tx) => createSpace(tx, "sieve-a", Date.now()), ctx)` legt einen Space an (idempotent je
  Alias; der Alias ist ein Name, die `spaceId` wird generiert und ändert sich nie). `new PhiSpaces(h, ctx, Date.now, meter, as,
  { space: "sieve-a" })` arbeitet darauf (Alias oder Id); ohne `space` nutzt der Client den Default-Space, bestehender Code bleibt also
  unverändert. `listSpaces(h, ctx)` listet sie. `startService` bedient auch später angelegte Spaces.
- **Ids**: Lokale Ids tragen die Inkarnation des Spaces, `e<incarnation>-<n>`, und jede Entry-Sicht hat eine globale Id
  `gid = <spaceId>/<lokale Id>`. Vor der Registrierung eines Spaces geschriebene Ids behalten ihre alte Form `e<n>`.
- **Request-Claims** (idempotente Mutationen): `write`, `notify`, `wait`, Transaktionen, Leases und blockierende `read`/`take` akzeptieren
  `request: { principal, generation, requestId }`. Der Claim, die Wirkung und ihr Ergebnis werden im selben Commit gespeichert, mit
  nur einem Hash der Argumente. Ein Retry mit gleicher Identität und gleichen Argumenten liefert das gespeicherte Ergebnis, auch nach einem
  Absturz und Neustart; eine ausstehende Anfrage läuft mit ihrer ersten Deadline weiter; andere Argumente ergeben `RequestConflict`.
  `issueGeneration(principal)` öffnet eine Generation, die neue Request-Ids für `generationAdmitMs` (1 h) zulässt; bekannte Requests bleiben
  danach beantwortbar. Ergebnisse werden `claimResultMs` (24 h) nach der Entscheidung behalten, danach `ResultExpired`; unbekannte Ids einer
  geschlossenen Generation ergeben `RequestExpired`, nie eine neue Mutation. `pollOperation` liest einen Request, `cancelOperation` beendet einen
  ausstehenden (`OperationCancelled`). Generationstokens sind HMAC-authentifiziert und an ihren aufgezeichneten Kontext gebunden;
  Claims haben ein eigenes Bytebudget
  (`maxClaimBytes`).

Die Reihenfolge ist wie in der Spezifikation unspezifiziert; nicht auf FIFO verlassen. Die lokale API kennt keine `RemoteException`; Remote-Aufrufer
erhalten stattdessen ein Transportergebnis oder `OutcomeUnknown` und müssen dieselbe Request-Identität abfragen.

## Grenzen und Besitz

- **Besitz**: Eine Conversation besitzt, was sie erzeugt (Entries, Transaktionen, Abonnements, Waits), und kann nur ihre eigenen verwenden,
  committen, abbrechen, verlängern oder beenden. Was Host-Code erzeugt (ohne Besitzer), gehört dem Host: Agenten können
  Host-Entries lesen und nehmen, sie aber nie beenden oder verlängern und auch keine Host-Transaktionen verwenden. Host-Code (`PhiSpaces` ohne `as`) ist
  uneingeschränkt.
- **Quoten** für Conversations (Host-Code ist ausgenommen), bei jedem Write, Notify, Wait und jeder Transaktion geprüft:
  Entry oder Handback bis 64 KiB JSON, Typnamen bis 128 Zeichen und 16 Typen,
  20 Abonnements, 20 Waits und 20 offene Transaktionen je Conversation. Die Entry-Anzahl hat keine Standardgrenze
  (beide Anzahl-Einstellungen nutzen den JSON-sicheren Wert `FOREVER`); Byte- und Storage-Budgets gelten weiterhin. Explizite Quoten werfen
  `LimitError`. Setzen mit `new PhiSpaces(harness, ctx).setLimits({ maxEntries: 50_000 })`; die Werte werden
  im Space-Dokument gespeichert.

- **Abonnements** (`space_notify`) einer Conversation brauchen einen Typ oder mindestens ein Feld und senden höchstens ein Ereignis
  je `notifyIntervalMs` (Standard 1 s). Dazwischen liegende Writes werden gezählt und kommen als ein gebündeltes Ereignis mit `count`
  an, wenn das Intervall vorbei ist (auch wenn das Abonnement abläuft). Host-Abonnements sind nicht begrenzt.
- **Nicht vertrauenswürdiger Inhalt**: Entries stammen von anderen Agenten. Jede Entry-Sicht trägt ihren `owner` (Conversation-Id, `null`
  für Host-Code), Nachrichten kennzeichnen Inhalt als Daten, und Ereignisnachrichten kürzen die Felder eines Entries auf 1 KiB (der Rest ist ein
  `space_read` entfernt). Der Prompt weist das Modell an, Entry-Inhalt nie als Anweisung zu behandeln. Das mindert
  Prompt-Injection, schließt sie aber nicht aus.
- Besitzverletzungen werfen `PermissionError`; Quotenverletzungen `LimitError`.
- **Blockierte Reads/Takes** warten nach einer Änderung mit Jitter 20–40 ms, bevor sie erneut prüfen, sodass eine Welle von Writes eine einzige
  Runde kostet und viele Waiter nicht im selben Moment prüfen (`WAKE_DEBOUNCE_MS`).
- **Metering je Harness**: Die Standard-`spaces`-Extension zählt in den prozessweiten `meter`; für einen eigenen
  `createSpaces(new Meter())` und `new PhiSpaces(h, ctx, Date.now, thatMeter)` verwenden.

- **Nach Id**: Ein Template darf eine `id` tragen (eine Entry-Id aus einer Ereignisnachricht); `space_read/take/list` nehmen ebenfalls `id`.
- **Space-Größe**: `maxSpaceBytes` (Standard 64 MiB Entry-Felder) begrenzt den gesamten Space, Host-Writes eingeschlossen.

## Geltungsbereich

Ein Prozess besitzt einen persistenten Store und kann ihn als Space-Dienst anbieten. Benannte Spaces teilen sich diesen
Speicher; sie sind keine getrennten Hosts. `SpaceService` und `RemoteSpace` lassen Clients in anderen Prozessen diesen Host erreichen;
die Föderations-Runtime (Gate, Enrollment, Grants, Router, `FederatedSpace`, Membership) setzt mehrere Hosts zusammen
gemäß [docs/federation-plan-v3.en.md](../docs/federation-plan-v3.en.md) — die Stufen 1b und 2 haben Abnahmenachweise
innerhalb ihrer dokumentierten Profile und Ausnahmen. Stufe 3 hat funktionierende Replikations-/Promotionsbausteine, aber
verbleibende Systemabnahme-Gates in [der aktuellen Matrix](../docs/_attic/abnahme/ap3-abnahme.en.md). Die Betriebserweiterung (Läufe, Worker, Space-Lebenszyklus, Deployment-
Bootstrap, mobile Steuerung) ist in [docs/betrieb-und-mobile-steuerung.en.md](../docs/betrieb-und-mobile-steuerung.en.md) beschrieben.
`space_take`/`space_read` mit `timeoutMs` blockieren den Turn und sind auf 60 s begrenzt; für lange Waits `space_wait` verwenden.

## Ausführung

```ts
const stop = await startService(harness, ctx); // reaper + event delivery; stateless, start again after a restart
```
Der Reaper entfernt abgelaufene Entries und Leases, bricht abgelaufene Transaktionen ab und beendet Waiter, wenn sie ablaufen. Ohne
ihn verhält sich weiterhin alles korrekt (jede Operation gleicht zuerst ab), der Space wird im Leerlauf nur nicht aufgeräumt.
Timer sind auf ~24,8 Tage begrenzt (`MAX_TIMER_MS`, die Grenze von setTimeout); längere Waits wachen schrittweise auf und prüfen erneut,
sodass monatelange und `FOREVER`-Waits weder im Leerlauf drehen noch verloren gehen.

## Monitoring

- `PhiSpaces.count(tmpl)` / `stats()` (rein `core.count`/`core.stats`): Kennzahlen aus einem Snapshot, ohne Commit, ohne jemanden zu wecken.
  Sie beurteilen einen unbereinigten Snapshot so, wie es ein Read nach dem Abgleich täte (die Takes einer abgelaufenen Transaktion sind zurück, ihre
  Writes weg, abgelaufene Waits warten nicht mehr). `returned` ist eine dauerhafte Summe der Entries, die abgebrochene oder
  abgelaufene Transaktionen zurückgegeben haben.
- `meter` (`src/meter.ts`): prozesslokale Zähler und Raten (Writes, Reads, Takes, Misses, zugestellte Ereignisse, Failures =
  nicht zustellbare Ereignisse, Retries = fehlgeschlagene Zustellversuche); nach Neustart zurückgesetzt. Tool-Aufrufe zählen einmal:
  `space_read`/`space_take` erfassen ihr Ergebnis (Entry oder Miss) zusammen mit der Änderung, sodass ein Replay weder erneut zählt noch
  seine Antwort ändert. Raten umfassen nur abgeschlossene Sekunden (bis zu 1 s Verzögerung, kein Sägezahn). Ops, die ein `space_wait` ausgeführt hat, werden bei
  Zustellung gezählt (braucht `startService`/`deliverEvents`); ein später durch Abort rückgängig gemachtes Take zählt weiterhin als Take und erscheint
  in `returned`.
- `watchLive(harness, ctx, cb)` tastet beides ab; `formatStatus` / `formatWidget` stellen es dar.

## Entwicklung

`npm run bundle` baut die Bibliothek und aktualisiert automatisch die benachbarte pi-termux-mobile-Runtime,
einschließlich kompilierter Beispielmodule. `PHI_SPACES_MOBILE_ROOT` setzen für ein anderes Mobile-Checkout.
Die Android-Pre-Build-Aufgabe baut aus den phi-spaces-Quellen neu und paketiert die aktualisierten Assets;
dort `PHI_SPACES_SOURCE` setzen, falls dieses Quell-Checkout woanders liegt.

```
npm run typecheck
npm test        # core spec, integration, persistence (SQLite crash/reopen with injected faults),
                # named spaces, request claims, the mobile sieve scenario
npm run typecheck:agent && npm run test:agent   # the optional agent package
npm run example
```

`npm run space-server -- --store DATEI|memory --listen unix:/pfad.sock|tcp:HOST:PORT` betreibt einen Space als eigenen
Dienst, ohne pi-durable; `npm run dashboard -- --dir <store>` zeigt Spaces live ([docs/dashboard.en.md](../docs/dashboard.en.md)).
Der Dienst authentifiziert selbst niemanden: Wer seinen Socket erreicht, nutzt ihn unter dessen statischer Identität.

Crash- und Recovery-Tests nutzen `test/support/persistent.ts`: Hosts auf dem echten SQLite-Store, die wie ein
beendeter Prozess aufgegeben werden können, mit einem Schalter, der den nächsten Commit scheitern lässt oder dessen Antwort verliert, nachdem er
dauerhaft wurde. Ein Store allein im Arbeitsspeicher beweist nichts über Durabilität.

### Remote-Testbed

`npm run testbed -- <command>` prüft das **gebaute Artefakt** (das Bundle `phi-spaces.mjs`, kompilierte Beispiele und Szenarien; kein
Quellcode) in Docker-Containern auf einem Server statt auf diesem Rechner: `check`, `up`, `test`, `scenario`, `status`, `kill`,
`partition`, `heal`, `down`. Server, Verzeichnis und Zugangsdaten kommen aus Umgebungsvariablen oder einer von Git ignorierten
`test/testbed/testbed.env`. Siehe [test/testbed/README.md](../test/testbed/README.md) und
[docs/testumgebung-big.en.md](../docs/testumgebung-big.en.md) (Deutsch). Das Szenario `sieve-mobile` lässt ein Primzahlsieb laufen, das von einem
simulierten Telefon gesteuert wird: verlorene Aufrufe und Antworten mit Retries unter derselben Request-Id, App im Hintergrund, Worker, die mit einer
reservierten Aufgabe sterben, ein Host-Neustart; die Auswertung vergleicht den gespeicherten Zustand mit Probedivision.

`npm run tui` öffnet ein Terminal-Dashboard mit Spaces, Objektdetails, Container-Steuerung, Tests und Berichten.
Mit `--dry-run` lassen sich Aktionen ohne Serverzugriff vorab ansehen. Siehe [docs/tui.en.md](../docs/tui.en.md).

## Beispiele

| Datei | Inhalt | Voraussetzung |
|---|---|---|
| `agent/examples/workers.ts` | Eine Conversation veröffentlicht einen Job, eine andere übernimmt ihn | – (geskriptetes Modell) |
| `agent/examples/blocking-tool.ts` | `space_take` mit Timeout, der Entry trifft später ein | – |
| `examples/sensor-pipeline.ts` | Collectors → konkurrierende Analysten (Take unter Txn, Fork/Join auf `Done`) → Presenter; auch von den Pipeline-Tests genutzt | – (Host-Code als Conversations) |
| `agent/examples/chat.ts` | Drei Agenten chatten im Ring; jeder hat ein Notify-Abonnement für an ihn adressierte Nachrichten | – geskriptet; `--live` nutzt ein echtes Modell |
| `agent/examples/arxiv-research.ts` | Collectors durchsuchen arXiv und versuchen Read-before-write-Deduplizierung; Task-Ausgaben verlangen eine passende Transaktion; frisches State-Verzeichnis oder `--resume --dir`, um einen Lauf fortzusetzen | echtes Modell, Netz |
| `examples/sieve.ts` | Begrenztes segmentiertes Sieb mit transaktionalen Tasks, Referenztests und SQLite-Recovery; `--remote` führt es über einen Space-Dienst aus | – (Host-Code) |
| `examples/cache.ts` | Atomarer lokaler Cache-Austausch, TTL und persistente Compare-and-set-Versionen; `--remote` wie oben | – (Host-Code; keine Replikation) |
| `examples/golomb.ts` | Lokale kooperative DFS mit transaktionalen Tasks und isolierten Läufen; persistente abgeschlossene Tasks werden fortgesetzt; `--checkpoint` schreibt Abschlussquittungen, keine partiellen DFS-Cursor | – (Host-Code) |
| `examples/codemode-evolve.ts` | Zufällige Code-Kandidaten werden über Generationen in einer Sandbox bewertet; `agent/examples/codemode-evolve-live.ts` lässt sie ein Modell schreiben | – (Generatoren mit Seed); live: echtes Modell |
| `agent/examples/dark-energy-research.ts` | 7-stufige Recherche-Pipeline (crawl → classify → summarize → analyse → present → optionaler `--query`-Chat); hostseitiger Monitor schreibt `SystemStatus`; `--resume --dir` setzt einen Lauf fort | echtes Modell, Netz |
| [`help-site/`](../help-site/README.md) | PHI-SPACES / HELP: zweisprachige Hilfe, gebündelter Social-Swarm-Feed, 6-stufige Space-Chat-Workbench und AdminSpaces | `npm run help` → http://localhost:3500 (Standard; konfigurierbar) |
| [`codemode-chat/`](../codemode-chat/README.md) | Agenten und Menschen schreiben gemeinsam Code; eine Sandbox bewertet jeden Beitrag | `npm --prefix codemode-chat run dev` → Port 3700 |
| [`spaces-mmo/`](../spaces-mmo/docs/README.en.md) | Rollenspielwelt auf Spaces | `npm --prefix spaces-mmo run build`, dann `npm --prefix spaces-mmo start` → Port 3900 |

Live-Beispiele wählen das Modell über `PI_PROVIDER`/`PI_MODEL`, sonst das erste verfügbare über Umgebungs-
API-Schlüssel oder `~/.pi/agent/auth.json` (`agent/src/live-models.ts`). Sie kosten Modell-Tokens. Entry-Typen, Muster,
Tests und Grenzen jedes Beispiels: [docs/examples.en.md](../docs/examples.en.md) und [docs/examples/](../docs/examples/).

Die eigentlichen Recherche-Runner werden mit geskripteten Modellen und persistentem Storage getestet. Die Qualität echter Modelle und die Netzwerk-
Integration werden durch diese Tests nicht validiert. Ein neuer Recherchelauf braucht ein frisches Verzeichnis; `--resume --dir` öffnet einen
kompatiblen Lauf ausdrücklich wieder, von selbst wird nichts fortgesetzt. Zitationsmetriken sind aus arXiv-Metadaten nicht verfügbar und bleiben null. Beispieltests belegen
keine allgemeine Produktionsskalierung: Komponenten-/Lastmessungen haben ihren eigenen dokumentierten Geltungsbereich. Mehrere asynchrone Worker
bieten keine CPU-Parallelität.

```
npm run test:examples    # test/examples/ suite (node:test + compat shim, no vitest)
npm run example:golomb -- 7 --workers 4
npm run example:sieve -- 1001 4
npm run example:cache
```

```
node --experimental-strip-types agent/examples/chat.ts --live "Was war der wichtigste Schritt zu heutigen LLMs?"
node --experimental-strip-types agent/examples/arxiv-research.ts --out /tmp/llm-history.md
```

## Dokumentation

Deutsche Dokumente in [docs/](../docs/README.en.md) (die Links führen auf die englischen Fassungen):

| Dokument | Inhalt |
|---|---|
| [implementierungsstand.md](../docs/implementierungsstand.en.md) | Umgesetzter Umfang, Nachweise und Grenzen |
| [api.md](../docs/api.en.md) | Referenz der TypeScript-, Dienst- und Remote-API |
| [vergleich-pi-durable.md](../docs/vergleich-pi-durable.en.md) | phi-spaces und pi-durable im Vergleich, und wo jedes hier eingesetzt wird |
| [upgrade-pi-1.4.0.md](../docs/upgrade-pi-1.4.0.en.md) | Das Upgrade der Agenten-Runtime auf 1.4.0, Daten- und Rollback-Grenzen |
| [rust-portierung.md](../docs/rust-portierung.en.md) | Die Rust-Portierung: Plan und Abschnitte |
| [ap1b-abnahme.md](../docs/_attic/abnahme/ap1b-abnahme.en.md) | Integrationsnachweise Phase 1b |
| [ap2-abnahme.md](../docs/_attic/abnahme/ap2-abnahme.en.md) | Abnahme Phase 2 |
| [ap3-replikation.md](../docs/_attic/abnahme/ap3-replikation.en.md) | Replikationsarchitektur Phase 3 |
| [ap3-abnahme.md](../docs/_attic/abnahme/ap3-abnahme.en.md) | Abnahmekriterien, Nachweise und verbleibende Gates Phase 3 |
| [spaces-v1.md](../docs/_attic/spaces-v1.en.md) | Historischer lokaler Stand (2026-10-07) |
| [federation-plan-v3.md](../docs/federation-plan-v3.en.md) | Der Vertrag für föderierte Spaces (Stufen 0–2 umgesetzt, 3 in Arbeit) |
| [implementierungsplan-v3.md](../docs/_attic/implementierungsplan-v3.en.md) | Bereitschaft, Entscheidungen, Arbeitspakete und Fortschritt |
| [betrieb-und-mobile-steuerung.md](../docs/betrieb-und-mobile-steuerung.en.md) | Betriebserweiterung: Läufe, Worker, Spaces, Bootstrap, mobile Steuerung, Abnahmestand |
| [testumgebung-big.md](../docs/testumgebung-big.en.md) | Das entfernte Docker-Testbed |
| [VALIDIERUNG.md](../docs/_attic/VALIDIERUNG.en.md) | Was lokal verifiziert wurde, und Messungen |
