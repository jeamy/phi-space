# pi-spaces

[English](README.md) · [Deutsch](README_DE.md)

pi-spaces ist eine TypeScript-Space-Bibliothek als Erweiterung für
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable).
Mehrere Agenten beziehungsweise Conversations koordinieren sich über gemeinsame Daten: Sie veröffentlichen
Aufträge, reservieren passende Arbeit und schreiben Ergebnisse zurück.

Das Modell baut auf Linda-Tuple-Spaces und JavaSpaces auf. Der lokale Client heißt `PiSpaces`.
Die Implementierung verwendet TypeScript und JSON; sie ist kein kompatibler Java-/RMI-Laufzeitersatz für JavaSpaces.

**Stand: 18. Oktober 2026.** Lokale und benannte Spaces, dauerhafte Request-Claims, Revisionen, RPC über Unix/TCP,
Mailboxen, Overlay-Identität, Enrollment, Grants und Schlüsselrotation sind implementiert. Gleiches gilt für
Föderationsrouting, Membership, Lauf-/Worker-/Space-Verwaltung und mobile Betriebsbausteine.
Merge-Replikation, primary/sync-Replikation, Promotion und Recovery besitzen Implementierungen und Nachweise;
**Phase 3 ist noch nicht vollständig abgenommen**. Maßgeblich sind
[Implementierungsstand](docs/implementierungsstand.md) und [Phase-3-Abnahmematrix](docs/ap3-abnahme.md), nicht
eine pauschale Ableitung von Garantien aus dem Vorhandensein einzelner Komponenten.

## Tuple Spaces: Koordination über Daten

Ein Tuple Space ist eine gemeinsame, assoziativ durchsuchbare Sammlung. Teilnehmer adressieren Daten über
Inhalte statt einen konkreten Empfänger. Auf einer gemeinsamen „Tafel“ kann ein Producer einen Auftrag
hinterlassen, den später ein passender Worker übernimmt. Der Producer muss keinen bestimmten Worker kennen,
der Worker nicht den Erzeuger. Linda beschreibt diese generative Kommunikation über Prozess- und Zeitgrenzen.
[Primärquelle: Gelernter, *Generative Communication in Linda*](https://www.cs.tufts.edu/comp/150FP/archive/david-gelernter/generative-linda.pdf).

JavaSpaces überträgt das Prinzip auf typisierte Java-Objekte namens **Entries**, ergänzt um Templates, Leases
und Transaktionen. Ein Template legt Typ und gesuchte Feldwerte fest; nicht festgelegte Felder sind Wildcards.
Teilnehmer tauschen Kopien aus, keine gemeinsam veränderlichen Objektreferenzen. Das Protokoll besteht aus
einem Datenfluss durch den Space statt direkten Methodenaufrufen zwischen Producer und Consumer.
[Primärquelle: Oracle-Einführung zu JavaSpaces](https://www.oracle.com/technical-resources/articles/javase/javaspaces.html).

### Grundoperationen

| Operation | Bedeutung in pi-spaces |
|---|---|
| `write(entry)` | Neuen Entry veröffentlichen; erneutes Schreiben ist normalerweise keine Aktualisierung des alten Entries. |
| `read(template)` | Passende Kopie lesen, ohne den Entry zu verbrauchen. |
| `take(template)` | Passenden Entry exklusiv übernehmen; unter einer Transaktion wird die Entfernung erst beim Commit endgültig. |
| `notify(template, ...)` | Interesse an passenden künftigen Writes registrieren; eine Benachrichtigung reserviert keinen Auftrag. |

Linda nennt die entsprechenden Veröffentlichungs-/Entnahmeoperationen `out` und `in`.
Ein Space garantiert nicht automatisch FIFO; Template-Matching ist keine allgemeine SQL-Abfragesprache.
[Primärquelle: JavaSpaces-Spezifikation, JS.1.3–1.4 und JS.2](https://river.apache.org/release-doc/current/specs/html/js-spec.html).

### Vier Dimensionen loser Kopplung

- **Zeitliche Entkopplung:** Producer und Consumer müssen nicht gleichzeitig aktiv sein. In pi-spaces müssen
  Entry-Lease, Space-Verfügbarkeit und Storage den Zwischenraum überdauern. Ein persistenter Store kann
  Prozessneustarts überstehen; `MemoryStorage` nicht.
- **Ortsentkopplung:** Teilnehmer müssen ihre gegenseitigen Netzwerkadressen nicht kennen. Sie benötigen
  weiterhin einen erreichbaren, korrekt konfigurierten Space-Zugang und Berechtigungen. Discovery,
  Routing und Netzfehler verschwinden dadurch nicht.
- **Referenzentkopplung:** Teilnehmer einigen sich auf Entry-Schemata und Templates statt direkte
  Objektreferenzen auf Kommunikationspartner zu halten. Die Kopplung an den Datenvertrag bleibt.
  RPC **zum Space** ist möglich: bei JavaSpaces RMI, bei pi-spaces `SpaceService`/`RemoteSpace`.
- **Synchronisationsentkopplung:** Das Veröffentlichen eines Auftrags setzt keinen bereiten Consumer voraus
  und wartet nicht auf dessen fertiges Ergebnis. Das heißt nicht, dass jede Space-Operation sofort zurückkehrt:
  JavaSpaces besitzt synchrone Aufrufe und wartende Reads/Takes. In pi-spaces sind Aufrufe Promise-basiert;
  ein `await` wartet im aufrufenden Ablauf, ohne deshalb den gesamten Event-Loop zu blockieren.

Die zeitliche Trennung beschreibt die
[Linda-Originalarbeit](https://www.cs.tufts.edu/comp/150FP/archive/david-gelernter/generative-linda.pdf);
das Warteverhalten der Java-Aufrufe die
[JavaSpace-API](https://river.apache.org/release-doc/current/api/net/jini/space/JavaSpace.html).
Für das tatsächliche pi-spaces-Verhalten gilt die [eigene API-Referenz](docs/api.md).

### Was davon in pi-spaces tatsächlich implementiert ist

`PiSpaces` und der gemeinsame Remote-Basisvertrag `SpaceLike` liefern Promises. Entscheidend ist, **worauf**
der jeweilige Aufruf wartet:

| Aufruf | Abschluss und Warteverhalten |
|---|---|
| `write` | Promise endet nach der Storage-Mutation, nicht erst nach Verarbeitung durch einen Consumer. Keine Fire-and-forget-Zusage: Commit-Latenz und Fehler bleiben sichtbar. |
| `read` / `take` | Promise endet mit Treffer oder `null` beim Timeout. `NO_WAIT` wartet nicht auf einen zukünftigen Treffer; die Operation selbst braucht weiterhin Zeit. |
| `wait` | Persistiert eine einmalige Warte-Registrierung und liefert deren ID; der Treffer beziehungsweise Timeout wird später als Ereignis zugestellt. |
| `notify` | Persistiert eine geleaste Subscription für passende Writes und liefert die Registrierungsinformationen; Ereignisse folgen später. |
| Agent-Tools `space_read` / `space_take` | Halten den aktuellen Agent-Turn während des Wartens an, maximal 60 Sekunden. |
| Agent-Tool `space_wait` | Gibt nach Registrierung den Turn frei; der Waiter kann mit persistentem Storage einen Neustart überstehen. |

`startService` führt lokale Wartung und Ereigniszustellung aus. Ereignisse gehen an die Ziel-Conversation
oder die konfigurierte Consumer-Mailbox. Take-Waiter liefern eine geleaste Transaktionsreservierung,
keinen endgültig verbrauchten Auftrag.

Damit sind sowohl wartende asynchrone Aufrufe als auch persistente, ereignisgesteuerte Interaktionen umgesetzt.
Synchrone CPU-Arbeit und Dokumentserialisierung können trotzdem den Event-Loop belegen. Nachlesbar in
[`src/client.ts`](src/client.ts), [`src/index.ts`](src/index.ts) und der [API](docs/api.md).

### Ergänzungen und Grenzen gegenüber der Grundlage

pi-spaces verwendet `{ type, types?, fields }` mit JSON-Feldern. Neben den Koordinationsoperationen gibt es
Request-Identitäten mit dauerhaftem Replay, benannte Spaces, Revisionsseiten, Mailboxen, CompletionProfile
und Betriebssteuerung. Feldvergleich ist tiefe JSON-Gleichheit, nicht Javas Vergleich serialisierter Felder.
Eine Transaktion reserviert Tasks und veröffentlicht Ergebnisse atomar im zuständigen Space; sie ist keine
allgemeine hostübergreifende Two-Phase-Commit-API.

Mehrere Worker können um Arbeit konkurrieren, ohne dass der Producer einen auswählen muss. Nach Abort oder
Ablauf der Transaktionslease wird reservierte Arbeit wieder verfügbar, sofern ihre eigene Entry-Lease
nicht ebenfalls abgelaufen ist. Ein `CompletionProfile` kann ein passendes Ergebnis vor Task-Commit erzwingen.
Externe HTTP-Aufrufe, Zahlungen und Dateischreibzugriffe werden dadurch nicht Exactly-once; sie brauchen
eigene Idempotenz oder eine gemeinsame Transaktion.

Die gemeinsame Tafel ist **logisch** geteilt; physisch kann sie lokal, remote oder föderiert realisiert sein.
Das Muster allein garantiert weder beliebige Skalierung noch Replikation, Failover oder Partitionstoleranz.
Hier ist jeder Space ein Dokument: Scans und Serialisierung großer Dokumente bleiben Kostenfaktoren.
Asynchronität ist keine CPU-Parallelität, und eine logische Space-Transaktion ist nicht automatisch ein
Storage-Commit. Der Social-Swarm-Worker bündelt explizit bis zu vier Tasks in zwei Durable-Commits;
siehe [Betriebsvertrag des Hilfesystems](help-site/README_DE.md#demo-vertrag-und-wiederanlauf).

## Minimalbeispiel: veröffentlichen, lesen, reservieren, abschließen

Im Repository-Root als `tuple-demo.ts` speichern und mit
`node --experimental-strip-types tuple-demo.ts` ausführen. Vorhandene Abhängigkeiten genügen;
keine Modellaufrufe und kein Server nötig.

```ts
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { FOREVER, NO_WAIT, PiSpaces, spaces } from "./src/index.ts";

const registry = createRegistry();
registry.install(spaces);
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
try {
  const producer = new PiSpaces(harness, ctx);
  await producer.write({ type: "Job", fields: { jobId: "square-7", value: 7 } }, null, FOREVER);
  // The producer need not wait for or address a particular worker.
  const worker = new PiSpaces(harness, ctx);
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

Erwartet werden `squared: 49` und `job remaining: 0`. Das Lesen lässt den Auftrag unverändert;
Taskentnahme und Ergebnis werden gemeinsam verbindlich. Zwei Clients im selben Prozess mit
`MemoryStorage` zeigen die Koordination, **keine** Persistenz oder Netzwerk-Ausfallsicherheit.
Ein persistenter Backend-Store ermöglicht Wiederanlauf, `RemoteSpace` einen separaten Worker-Prozess.

## Schichten und Storage

| Datei/Bereich | Aufgabe |
|---|---|
| `src/core.ts` | Reine Space-Semantik über JSON: Entries, Templates, Leases, Transaktionen, Notify, Limits. |
| `src/doc.ts`, `src/spaces.ts` | Default-Space, benannte Spaces, Registry, Aliase und unveränderliche Space-IDs. |
| `src/claims.ts` | Dauerhafte Request-Claims, Generationen, Replay, Poll und Cancel. |
| `src/client.ts` | Lokaler Client `PiSpaces`. |
| `src/index.ts` | Extension, Agent-Tools, Reaper und Ereigniszustellung. |
| `src/meter.ts` | Prozesslokale Zähler und Raten. |
| `src/canonical.ts`, `src/stream.ts` | Kanonisches JSON und begrenztes Revisionslog. |
| `src/service.ts`, `src/remote.ts`, `src/socket.ts` | Dienst, Remote-Client und Unix-/TCP-Transport. |
| `src/federated-space.ts`, `src/router.ts` | Policy-Routing und journalisierte Föderationsoperationen. |
| `src/entry-replication.ts`, `src/primary-sync.ts`, `src/replica-control.ts` | Merge-/Sync-Replikation und abgesicherte Übergänge; Abnahmegrenzen beachten. |
| `src/run-controller.ts`, `src/workers.ts`, `src/space-lifecycle.ts` | Läufe, Worker und Space-Verwaltung. |
| `help-site/` | Zweisprachige Hilfe, Demos und Web Admin. |

Durable-Commits machen State-Änderungen atomar. Wiederanlaufpersistenz setzt einen persistenten Backend-Store
voraus; Strom-/Hostausfallgarantien hängen von dessen Einstellungen und dem Replikations-/Recovery-Betrieb ab.
Der Default-Space ist das sessionweite Dokument `pi-spaces.space`, benannte Spaces liegen in der Familie
`pi-spaces.named-space`, jeweils Dokumentversion 5. Die Registry ordnet Aliase festen `spaceId`s zu.
Version 5 migriert Version 4 vorwärts; ein altes Bundle mit ausschließlich Version 4 kann den migrierten
Store nicht mehr öffnen. Ein Storage hat einen besitzenden Harness-Prozess; benannte Spaces sind nicht
automatisch unabhängige Hosts.

## Semantik, Requests und Zugriffsgrenzen

- Templates können Typ, Felder und Entry-ID angeben. Haupt-/Supertypen stehen beim Schreiben fest.
  Fehlende oder `null`-Felder im Template sind Wildcards; eine Suche ausdrücklich nach einem Nullwert ist
  so nicht möglich. Auswahlreihenfolge ist nicht als FIFO definiert.
- `readIfExists`/`takeIfExists` warten nur bei Transaktionssperren vorhandener Treffer;
  normale Reads/Takes können auf einen künftigen Treffer bis zum Timeout warten.
- `ANY` gewährt standardmäßig eine Stunde, `FOREVER` läuft nicht ab; Leases werden wie angefragt gewährt.
  Negative Werte außer `ANY` sowie NaN werden abgelehnt. Abgelaufene Entries sind unsichtbar.
- Transaktionale Writes bleiben außen unsichtbar; Reads sperren gegen fremde Takes,
  Takes reservieren exklusiv. Abort/Lease-Ablauf nimmt die Transaktion zurück.
- Eine Conversation besitzt ihre eigenen Entries, Leases, Transaktionen, Registrierungen und Waiter.
  Host-Code ohne `as` besitzt den privilegierten lokalen Zugang; dies ist kein Remote-Authentifizierungsersatz.
- Request-Claims binden Argumente, Wirkung und Ergebnis an `{ principal, generation, requestId }`.
  Gleicher Retry liefert das gespeicherte Ergebnis, abweichende Argumente `RequestConflict`.
  Generationstokens sind HMAC-authentifiziert und kontextgebunden. Standardmäßig werden neue IDs eine Stunde
  zugelassen und entschiedene Ergebnisse 24 Stunden behalten; nach Ablauf wird keine alte Wirkung neu ausgeführt.
- Bei unklarem Remote-Ausgang dieselbe Request-Identität über `pollOperation` klären oder mit
  `cancelOperation` beenden. `OutcomeUnknown` bedeutet nicht „sicher fehlgeschlagen“.
- Notify-Registrierungen besitzen Lease, Handback und steigende Sequenznummern. Conversation-Ereignisse
  nutzen stabile Zustell-IDs; Consumer-Mailboxen ergänzen Events/ACK. Das ersetzt keinen exklusiven Take.
- `snapshot(entry)` liefert eine eingefrorene Kopie, keinen JavaSpaces-Serialisierungscache.

Die vollständigen Signaturen, Besitz-/Rollenregeln und Fehlerklassen stehen in [docs/api.md](docs/api.md).
Voreinstellungen liegen in `DEFAULT_LIMITS`: unter anderem 64 KiB je Entry-Felder/Handback, 64 MiB
Entry-Felder insgesamt, 128 MiB Gesamtdokument, 192 KiB Commit und 256 KiB Frame.
Owner-Quoten begrenzen zusätzlich Entries, Registrierungen, Waiter und offene Transaktionen.
`setLimits` speichert Änderungen pro Space. Globale Bytegrenzen gelten auch für Host-Writes.

Entry-Inhalte sind fremde Daten und keine vertrauenswürdigen Anweisungen an Agenten.
Owner-Markierung, gekürzte Ereignisvorschauen und Prompt-Hinweise vermindern Prompt-Injection-Risiken,
beseitigen sie aber nicht.

## Wartung und Monitoring

```ts
const stop = await startService(harness, ctx); // reaper + event delivery
```

Der Reaper entfernt abgelaufene Entries/Leases, bricht abgelaufene Transaktionen ab und beendet fällige Waiter.
Auch ohne Hintergrundwartung wird die Semantik beim nächsten Zugriff abgeglichen; eine ungenutzte Instanz
wird dann nicht im Hintergrund aufgeräumt. Lange Timer werden in begrenzten Schritten erneut geprüft.

`count`/`stats` lesen Snapshot-Kennzahlen ohne Commit oder neue Aufweckereignisse.
`meter` enthält prozesslokale Zähler/Raten und beginnt nach Neustart neu;
`returned` ist dagegen der dauerhafte Zähler zurückgegebener reservierter Entries.
`watchLive`, `formatStatus` und `formatWidget` stellen diese Informationen dar.

## Entwicklung und Ausführung

```bash
npm run typecheck
npm test -- --test-concurrency=4
npm run example
npm run test:examples -- --test-concurrency=1
```

Tests benötigen keine echten Modelle. Persistenz-/Recovery-Tests nutzen echte JSONL-/SQLite-Stores mit
injizierten Fehlern; ein `MemoryStorage`-Test allein belegt keine Durabilität.
Serielle Beispieltests vermeiden zusätzliche gegenseitige Last bei zeitabhängigen Performance-Prüfungen.

`npm run bundle` baut die Bibliothek **und aktualisiert standardmäßig das benachbarte Mobile-Runtime-Checkout**
einschließlich kompilierter Beispiele; `PI_SPACES_MOBILE_ROOT` wählt ein anderes Ziel.
Der Android-Prebuild übernimmt die pi-spaces-Quellen über `PI_SPACES_SOURCE`.

Das entfernte Docker-Testbed prüft gebaute Artefakte mit `npm run testbed -- <command>`.
Ziele/Zugang kommen aus Umgebung beziehungsweise ignorierter Testbed-Konfiguration. Zuerst `--dry-run`
verwenden; Start, Deployment und Fehlertests auf einem geteilten Server separat freigeben.
Siehe [Testbed](test/testbed/README.md), [Betrieb](docs/testumgebung-big.md) und
[Terminal-UI](docs/tui.md). `npm run tui` besitzt auch einen Dry-run-Modus.

## Beispiele und Hilfesystem

| Beispiel | Inhalt | Voraussetzung |
|---|---|---|
| `examples/workers.ts` | Ein Agent veröffentlicht einen Job, ein anderer übernimmt ihn. | Geskriptete Modelle. |
| `examples/blocking-tool.ts` | Wartender Take mit später eintreffendem Entry. | Kein Live-Modell. |
| `examples/sensor-pipeline.ts` | Collector, konkurrierende Analysten, Fork/Join und Ausgabe. | Host-Code. |
| `examples/chat.ts` | Agenten-Ring mit Notify. | Geskriptet; `--live` kostenpflichtig/netzabhängig. |
| `examples/arxiv-research.ts` | Recherche-Pipeline mit Aufgabenabschluss. | Echtes Modell, Netz, frischer State-Pfad. |
| `examples/sieve.ts` | Segmentiertes Sieb, transaktionale Tasks, JSONL-Wiederanlauf. | Host-Code. |
| `examples/cache.ts` | Atomarer lokaler Cache, TTL und persistentes Compare-and-set. | Keine Replikation. |
| `examples/golomb.ts` | Kooperative DFS, isolierte Läufe, Wiederaufnahme abgeschlossener Tasks. | Keine partiellen DFS-Checkpoints. |
| `examples/dark-energy-research.ts` | Mehrstufige Recherche mit optionalem Dialog. | Echtes Modell, Netz, frischer State-Pfad. |
| [`help-site/`](help-site/README_DE.md) | Hilfe, Social Swarm, sechs Chat-Stufen und Web Admin. | `npm run help`, Standardport 3500. |

```bash
npm run example:golomb -- 7 --workers 4
npm run example:sieve -- 1001 4
npm run example:cache
HELP_BIND=127.0.0.1 PI_SPACES_LLM=0 npm run help
```

Live-Beispiele wählen Modelle über `PI_PROVIDER`/`PI_MODEL` oder verfügbare Credentials und verursachen
Modellkosten; nur bewusst ausführen. Geskriptete Tests belegen keine reale Modellqualität.
Automatische Wiederaufnahme der Rechercheläufe ist nicht unterstützt; neue State-Verzeichnisse verwenden.
Zitationsmetriken fehlen in arXiv-Metadaten und bleiben null. Mehrere asynchrone Schleifen sind keine
CPU-Parallelität; die Worker-Commit-Zählung ist kein allgemeiner Produktivbenchmark.

## Weiterführende Dokumentation

- [Implementierungsstand](docs/implementierungsstand.md): tatsächliche Komponenten, Nachweise und Grenzen.
- [API](docs/api.md): lokaler, Dienst- und Remote-Vertrag.
- [Beispiele](docs/examples.md) und [Einzeldokumente](docs/examples/).
- [Phase 1b](docs/ap1b-abnahme.md), [Phase 2](docs/ap2-abnahme.md) und [Phase 3](docs/ap3-abnahme.md): Abnahmen getrennt nach Nachweisart.
- [Föderationsvertrag v3](docs/federation-plan-v3.md) und [Implementierungsplan](docs/implementierungsplan-v3.md).
- [Replikation](docs/ap3-replikation.md): Architektur; keine alleinige Betriebsfreigabe.
- [Betrieb/mobile Steuerung](docs/betrieb-und-mobile-steuerung.md).
- [Hilfesystem-Betriebsvertrag](help-site/README_DE.md#demo-vertrag-und-wiederanlauf) und
  [Analyse der Hilfesystem-/Demo-Fixes](docs/analyse-hilfesystem-demo-apps-2026-10-18.md).
- [Dokumentenindex](docs/README.md), [Validierung](docs/VALIDIERUNG.md) und
  [historischer lokaler Stand](docs/spaces-v1.md).
