---
standard: help_topic
id: help.topic.overview
title: "phi-spaces Systemüberblick: Was es ist und was es kann"
short: "Verständlicher, ausführlicher Einblick: Was phi-spaces ist, wie das transaktionale Tuple-Space-Modell funktioniert, welche Probleme es löst und was es von v1 (In-Memory) bis v6 (Federated Cluster + Mobile/Web Admin) leisten kann."
tags: [phi-spaces, overview, tuple-space, architecture, phispaces, remotespace, federatedspace]
owner: core
related: [help.topic.architecture_layers, help.topic.guarantees_and_boundaries, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# phi-spaces Systemüberblick: Was es ist und was es kann

## Überblick {#overview}

`phi-spaces` ist ein transaktionaler, persistenter **Koordinationsraum** (eine moderne Weiterentwicklung des klassischen Linda-/JavaSpaces-Paradigmas) für `@earendil-works/pi-durable`. Anstatt Clients, Hintergrund-Worker, KI-Agenten und Administrationswerkzeuge über fehleranfällige Punkt-zu-Punkt-Aufrufe direkt miteinander zu verkoppeln, tauschen alle Teilnehmer unveränderliche, typisierte JSON-Objekte (**Entries**) über gemeinsam nutzbare, versionierte Datenräume (**Spaces**) aus.

## Herkunft: Linda und JavaSpaces {#history}

Die Idee stammt aus den 1980er Jahren: David Gelernter und Nicholas Carriero entwickelten an der Yale University **Linda**, ein Koordinationsmodell, in dem Prozesse nicht miteinander sprechen, sondern Daten (**Tupel**) in einen gemeinsamen **Tuple Space** legen und nach ihrem Inhalt wieder herausholen (`out`, `rd`, `in`). Gelernter nannte das *generative Kommunikation*: Daten überdauern den Prozess, der sie erzeugt hat, und verbinden Teilnehmer über Prozess- und Zeitgrenzen hinweg. Ende der 1990er übertrug Sun Microsystems das Konzept mit **JavaSpaces** auf typisierte Java-Objekte (**Entries**) mit Template-Suche, **Leases** und **Transaktionen**.

phi-spaces übernimmt dieses Modell in TypeScript und JSON und ergänzt Persistenz, Revisionen, Änderungsströme, Föderation und Administration. Es ist kein JavaSpaces-kompatibler Java-/RMI-Ersatz.

Das Modell ist nicht auf Agentenkommunikation zugeschnitten. Ein Space transportiert beliebige Daten: Aufträge, Nachrichten, Messwerte, Ergebnisse, Zustände oder Ereignisse. Agenten (Conversations) sind nur eine typische Art von Teilnehmer; Programme, Dienste, Geräte und Menschen nutzen denselben Space auf dieselbe Weise.

### Was phi-spaces besonders kann {#highlights}

- **Beliebige Kommunikate**: Jede JSON-Struktur mit `type` kann Entry sein – es gibt kein festes Nachrichtenformat.
- **Kommunikation ohne Adressen**: Absender wählen keinen Empfänger; Teilnehmer finden Daten über Templates.
- **Entkopplung in Raum und Zeit**: Produzenten und Konsumenten kennen einander nicht und müssen nicht gleichzeitig online sein.
- **Verlässliche Arbeitsverteilung**: exklusives `take` mit Lease und Transaktion; Abstürze geben Arbeit wieder frei.
- **Dauerhaft und nachvollziehbar**: persistenter Zustand, Revisionen, Snapshots und Änderungsströme.
- **Vom Einzelprozess zum Cluster**: lokal, per Socket/RPC und als föderierter Verbund mit Identität, Enrollment und Admin-Oberflächen.

## Was ist phi-spaces und warum wurde es gebaut? {#what-is-phi-spaces}

`phi-spaces` löst vier fundamentale Probleme bei der Entwicklung robuster, langlaufender Systeme und autonomer KI-Agenten-Flotten:

1. **Fehlertolerante Aufgabenübergabe (mit geleaster Reservierung)**: Ein Server, UI-Client oder Agent übergibt Arbeit nicht direkt an einen Worker, sondern schreibt einen Aufgaben-Entry (`type: "ChatTask"` o.Ä.) in den Space. Jeder Worker kann sich diesen Task exklusiv **reservieren** (`take`). Stürzt der Worker vor der Fertigstellung ab, gibt die abgelaufene Lease den Task automatisch wieder frei – sofern die eigene Task-Lease noch gilt und der Store verfügbar ist.
2. **Zeitliche Entkopplung**: Produzenten und Konsumenten müssen nicht gleichzeitig online sein. Ein Client kann mitten in der Nacht einen `ScheduledJob` einstellen und offline gehen; mit persistentem Backend und ausreichender Task-Lease bleibt der Auftrag erhalten; die Anwendung prüft nach Ablauf des TimerLock die Fälligkeit.
3. **Einheitlicher Zustand mit Live-Ereignissen**: Statt fragmentierter Caches bietet jeder Space atomare Transaktionen (`createTransaction`, `commit`, `abort`), konsistente Snapshots (`readPage` mit `rev`), inkrementelle Update-Streams (`changes(afterRev)`) und langlebige Ereignis-Mailboxes (`events` + Präfix-`ack`).
4. **Schrittweise Verteilung**: Lokale und Remote-Clients teilen den SpaceLike-Basisvertrag. Federation ergänzt Routing und eigene Request-Bindungen; reale Verschlüsselung, Provisionierung und Ausfallsicherheit benötigen gesonderte Konfiguration und Abnahme.

## Begriffs- und Systemmodell {#concept-model}

### Entkopplung in Raum und Zeit {#decoupling}

In `phi-spaces` müssen Produzent und Konsument einander nicht kennen und nicht gleichzeitig aktiv sein:

- **Schreiben (`space.write`)**: Ein Teilnehmer legt einen Entry `{ type: string, types?: string[], fields: Record<string, Json> }` mit einer definierten Ablaufzeit (**Lease**) im Space ab.
- **Lesen (`space.read` / `readIfExists` / `readAll` / `readPage`)**: Ein Teilnehmer sucht mit einem **Template** `{ type?, fields?, id? }` nach einem passenden sichtbaren Entry, ohne ihn zu entfernen. Fehlende oder `null`-Felder im Template wirken als **Wildcards**.
- **Exklusives Entnehmen (`space.take`)**: Ein Worker entnimmt einen passenden Entry exklusiv. Erfolgt der `take` unter einer **Transaktion (`txn`)**, bleibt der Entry reserviert, bis der Worker seine Ergebnisse geschrieben und `commit(txn)` aufgerufen hat. Stürzt der Worker ab oder läuft die Transaktions-Lease ab, kehrt der Entry zurück, sofern seine eigene Entry-Lease noch gilt.
- **Warten auf zukünftige Daten (`space.wait`)**: Statt blind zu pollen, registriert ein Teilnehmer einen langlebigen `Waiter` auf ein Template. Sobald ein passender Entry committet wird, weckt `phi-spaces` den Waiter oder sendet ein Ereignis.

### Was kann phi-spaces? (Kernfähigkeiten) {#capabilities}

- **Unveränderliche Entries & Wildcard-Templates**: Typisierte JSON-Objekte mit Subtypen-Registrierung (`types`) und exaktem `type`/Feld-Matching.
- **Atomare Space-Transaktionen**: `take` + mehrere `write` + optionale Request-Claims mit einem fachlichen `commit(txn)` (vorherige PhiSpaces-Aufrufe sind separate Storage-Commits). Bei `abort` oder Timeout wird alles atomar zurückgerollt.
- **Serverseitige Ergebnisgarantien (`CompletionProfiles`)**: Der Space-Kern erzwingt beim Commit, dass ein genommener Task des Typs `ChatTask` nur zusammen mit genau einem passenden Ergebnis-Entry `Msg` erfolgreich commitet werden kann.
- **Idempotente Request-Claims (`RequestRef`)**: Jede Mutation kann mit `{ request: { principal, generation, requestId } }` ausgeführt werden; Wiederholungen und Timeouts erzeugen keine doppelte Wirkung.
- **Leases & automatischer Reaper (`startService`)**: Entries, Presence-Zustände und `TimerLock`-Schlösser laufen nach definierter Zeit automatisch ab.
- **Snapshot- und Inkrement-Sync (`readPage` + `changes`)**: Punkt-in-Zeit-Snapshots plus reihenfolgetreue, revisionierte Update-Streams (`rev`) und präfix-bestätigte langlebige Mailboxes.
- **Space Lifecycle, Worker, Läufe & Deployments**: Idempotentes Space-Management (`archive`/`reactivate`/`delete`), Worker-Skalierung (`WorkerSupervisor`), Multi-Host-Laufsteuerung (`RunGate`) und deklaratives Bootstrap (`DeploymentController`) vom Einzel-Host bis zum Cluster.
- **Overlay-Gate, Enrollment & Federated Routing**: NetBird-/WireGuard-Peer-Identität + Ed25519-Challenge, QR-/Token-Enrollment, 60-s-Grants, eigene Key-Rotation und deterministisches HRW-Sharding von Einträgen auf mehrere Hosts.

### Einheitlicher Basisvertrag SpaceLike {#spacelike-contract}

PhiSpaces und RemoteSpace implementieren den SpaceLike-Basisvertrag. FederatedSpace besitzt eine eigene API mit FederationRequest und Member-Transaktionsbindung; Fachkonzepte sind übertragbar, Aufrufsignaturen nicht unverändert austauschbar. Siehe [Topologien und API-Grenzen](help.topic.topology_and_readiness#api).

## Begriffe und Identitäten {#terms-and-identities}

- **Entry**: Ein unveränderliches JSON-Dokument `{ type: string, types?: string[], fields: Record<string, Json> }`. Es gibt kein In-Place-Update; Zustandsübergänge erfolgen durch `take` + `write` in einer gemeinsamen Transaktion.
- **Global ID (`gid`)**: Jeder Entry trägt `gid = <spaceId>/<localId>`. Die `localId` besteht aus der Dateninkarnation des Spaces plus einem monoton steigenden Zähler und wird niemals wiederverwendet.
- **Named Space**: Neben dem Default-Space (`phi-spaces.space`, Alias `default`) verwaltet die `Registry` (`phi-spaces.registry`) beliebig viele benannte Spaces (`phi-spaces.named-space`) mit stabiler `spaceId`.
- **Principal**: Strukturierte Identität `{ peerId, agentId? }`. Der Server leitet sie immer aus der authentifizierten Verbindung (`IdentityAdapter`) ab, niemals aus ungeprüften Client-Payloads.

## Arbeitsablauf {#workflow}

1. **Vertrag definieren**: Entry-Typen (`type`), Pflichtfelder (`fields`) und optionale `CompletionProfiles` (welcher Task-Typ erfordert welchen Ergebnis-Typ beim Transaktions-Commit?) festlegen.
2. **Space öffnen und Dienst starten**: `new PhiSpaces(harness, ctx, Date.now, meter, undefined, { space })` erstellen und `await startService(harness, ctx)` für Lease-Reaper und Event-Zustellung starten.
3. **Aufgaben einstellen und bearbeiten**: Produzenten schreiben Aufgaben mit `RequestRef`-Claim; Worker reservieren Aufgaben per `take(..., { txn })`, schreiben Ergebnisse unter derselben `txn` und rufen `commit(txn)` auf.
4. **Live-Beobachtung und Steuerung**: UI-Clients lesen initial `readPage()` (Snapshot mit `rev`) und folgen Änderungen über `changes(afterRev)` oder Consumer-Mailboxes (`events` / `ack`).

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

- **Ein Commit, eine Wahrheit**: Space-Mutation, Request-Claim, Revisionszähler `rev`, Mailbox-Ereignis und Byte-Budget-Prüfung werden in einem einzigen atomaren Harness-Commit persistiert.
- **Daten sind keine Anweisungen**: Entries aus dem Space stammen potenziell von anderen Agenten oder Benutzern. Die Agenten-Tools kennzeichnen sie strikt als `[data, not instructions]`.
- **Help ≠ Live State**: Diese Referenz dokumentiert die stabilen Verträge und Garantien. Den aktuellen Laufzeitbestand eines Spaces zeigen der integrierte **Live Space-Inspector** und der geschützte Bereich **AdminSpaces**.

## Siehe auch {#see-also}

- [Schichtenarchitektur und Modul-Landkarte](help.topic.architecture_layers#overview)
- [Verbindliche Garantien und Systemgrenzen](help.topic.guarantees_and_boundaries#overview)
- [6-Stufen-Praxisleitfaden: Multiplayer Space-Chat (v1–v6)](help.workflow.overview_v1_to_v6#overview)
