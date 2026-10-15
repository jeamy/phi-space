# pi-spaces API

Stand: 2026-10-11. Diese Referenz dokumentiert die öffentliche TypeScript-API
des lokalen Clients `PiSpaces`, des Remote-Clients `RemoteSpace` und den
Servicevertrag. Sie beschreibt keine Federation-Garantie; dafür ist
[federation-plan-v3.md](federation-plan-v3.md) maßgeblich.

## Gemeinsame Typen

```ts
type EntryDraft = { type: string; types?: string[]; fields: Fields };
type Template = { type?: string | null; fields?: Fields; id?: string | null } | null;
type Lease = { id: string; expires: number };
type RequestRef = { principal: Principal; generation: string; requestId: string };
```

`fields` und `handback` müssen JSON sein. `null` als Template matcht jeden
Entry. Fehlende oder `null`-Templatefelder sind Wildcards; daher lässt sich
nicht nach einem gespeicherten JSON-`null` suchen. `id` ist die lokale ID aus
einem Entry-View; `gid` ist nur die globale Anzeigeform.

Zeitangaben sind Millisekunden. `NO_WAIT` (`0`) wartet nicht,
`ANY` (`-1`) überlässt die Lease-Dauer dem Space und `FOREVER` steht für eine
unbefristete Dauer. Über den Wire-Vertrag werden `ANY` als `null` und `FOREVER`
als `"forever"` übertragen.

## `PiSpaces`

```ts
const space = new PiSpaces(harness, ctx, Date.now, meter, conversationId, {
  space: "optional-alias-or-spaceId",
});
```

Ohne `space` verwendet der Client den Default-Space. Ein gesetztes
`conversationId` aktiviert Ownership-Prüfungen; Host-Code lässt es weg.
`PiSpaces` erfüllt `SpaceLike`.

| Methode | Ergebnis | Semantik |
|---|---|---|
| `write(entry, txn?, lease?, { request? })` | `Lease` | Schreibt einen neuen Entry; unter `txn` zunächst unsichtbar. |
| `read(template, timeout, options?)` | `EntryView \| null` | Wartet auf einen sichtbaren Treffer. |
| `readIfExists(template, timeout, options?)` | `EntryView \| null` | Wartet nur auf die Auflösung kollidierender Transaktionen. |
| `take(template, timeout, options?)` | `EntryView \| null` | Entfernt sofort oder reserviert unter `txn`. |
| `takeIfExists(template, timeout, options?)` | `EntryView \| null` | Nichtblockierende Take-Variante, außer bei Locks. |
| `notify(template, options)` | `{ eventId, lease }` | Registriert lokale Zustellung oder Principal-Mailbox-Events. |
| `wait(template, options)` | `waiterId` | Parkt Read/Take für Conversation- oder Consumer-Zustellung. |
| `readAll(template?, options?)` | `EntryView[]` | Snapshot-Liste, älteste zuerst, alle Treffer, optionales Limit. |
| `readPage(template?, options?)` | `Page` | Bytebegrenzte Snapshot-Seite; mit `next` fortsetzen. |
| `changes(afterRev, options?)` | `Changes` | Sichtbare Commit-Batches nach einer Revision. |
| `count(template?, txn?)` | `number` | Sichtbare Treffer ohne Commit oder Warten. |
| `stats()` | `SpaceStats` | Punkt-in-Zeit-Gauges einschließlich Byte-Aufteilung. |
| `createTransaction(lease?, { request? })` | `Lease` | Erzeugt eine Transaktion. |
| `commit(txn, { request? })` / `abort(...)` | `void` | Schließt eine eigene Transaktion ab. |
| `renew(leaseId, ms, { request? })` / `cancel(...)` | Ablaufzeit / `void` | Erneuert bzw. beendet eigene Leases. |
| `issueGeneration(principal)` | Generation | Öffnet eine Claim-Generation. |
| `pollOperation(request)` / `cancelOperation(request)` | Claim-Status | Liest bzw. beendet eine bekannte Claim-Operation. |
| `resolveOperation(request, method, argumentHash, primaryEpoch)` | `AdmissionResolution` | Prüft bekannte Claim-Bindungen oder erlaubt bei gültiger Generation derselben Epoche ausschließlich Retry derselben ID. |
| `events(principal, options?)` / `ack(principal, epoch, upTo, options?)` | Mailbox-Seite / ACK-Stand | Eigene Consumer-Mailbox, Präfix-ACK ist kein Txn-Commit. |
| `setCompletionProfiles(profiles)` | `void` | Nur Host-Code; Ergebnisvertrag vor Arbeit installieren. |
| `setLimits(partialLimits)` | `Limits` | Nur Host-Code: setzt Grenzen dieses Space. |

`read`/`take` akzeptieren zusätzlich `OpOptions`: `txn`, eine absolute
`deadline`, eine durable `request` und lokal einen `once`-Hook. Eine Request-ID
ist für robuste Wiederholung über Neustarts gedacht: Gleiche Identität und
gleiche Argumente liefern dasselbe gespeicherte Ergebnis; abweichende Argumente
führen zu `RequestConflict`.

`notify` braucht `{ target, txn?, lease?, handback?, request? }`. `wait` nimmt
`{ take?, target, timeout, txnLeaseMs?, handback?, request? }`; ein bedienter
Take-Waiter hält den Entry in einer frischen Transaktion, bis der Empfänger
committet oder deren Lease abläuft. Beide Methoden benötigen `startService`,
damit Delivery und Reaper im Leerlauf laufen.

## Benannte Spaces und Hintergrunddienst

`createSpace(tx, alias, now)` erzeugt einen benannten Space im Harness-Commit;
`listSpaces(host, ctx)` listet Alias, `spaceId`, Inkarnation und Erzeugungszeit.
`startService(harness, ctx, { space? })` startet Reaper und lokale Event-
Zustellung. Ohne `space` überwacht es auch später erzeugte benannte Spaces.

## Revisionen und Seiten

`Page` enthält `{ items, next, token?, rev, streamId }`. Der opake Cursor `next` wird in
`readPage(..., { after: next })` eingesetzt; optional kann `token` explizit mitgegeben werden.
Alle Seiten lesen denselben unveränderlichen Snapshot, auch bei konkurrierenden Writes oder Lease-Ablauf.
Token-Bindung: Space/Strom, Owner, Template und Txn. TTL/Eviction/Host-Reopen → `SnapshotExpired`;
danach neue erste Seite lesen. Änderungen nach der Snapshot-Revision werden über `changes` aufgeholt.
`Changes` enthält `{ streamId, batches, next, rev, more }`, mit vollständigen Batches je Seite.
`ResponseBudgetTooSmall {requiredBytes}` verändert weder Cursor noch ACK-Stand.

## `RemoteSpace` und `SpaceService`

`RemoteSpace` implementiert die selben Kernmethoden über einen `Transport`.
`inProcessTransport(service, connection)` ist für lokale Tests;
`socketTransport({ path })` und `socketTransport({ host, port })` stellen
Unix- bzw. TCP-Verbindungen her. Der Server wird mit
`serveSpace(service, { listen: target, connection })` gestartet.
Mit `identifyOnConnect: true` beginnt die Identitätsauflösung schon bei TCP-Annahme;
ohne diese Option beginnt sie beim ersten Frame. `startGate` setzt die Option
immer und begrenzt die Peer-Erkennung auf standardmäßig fünf Sekunden. Damit
verbrauchen auch stumme identifizierte Sockets die Peer-Quota; ein hängendes
Directory schließt sie nach Ablauf. Die Schicht-B-Challenge gilt separat 30 Sekunden.
Die [finalen Betriebsgrenzen](ap2-gate4.md) gelten für das geprüfte Lastprofil.

Vor der Nutzung ruft `RemoteSpace` `hello` auf, eröffnet eine Generation und
gibt jeder Mutation eine Request-ID. Bei verlorener Antwort wiederholt er mit
derselben Identität. `OutcomeUnknown` heißt deshalb nicht, dass die Wirkung
fehlgeschlagen ist: mit `pollOperation` dieselbe Request-ID weiter verfolgen
oder gezielt `cancelOperation` verwenden.

Der Service akzeptiert die Methoden `hello`, `generation`, `write`, `read`,
`take`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `txn`,
`lease` und `changes`. Mutationen benötigen `{ generation, requestId }`.
`read` und `take` können `{ state: "pending" }` zurückgeben und werden über
`pollOperation` fortgesetzt. `readAll` ist der paginierte Seitenaufruf.

`wait`, `notify`, `events` und `ack` sind implementiert und richten sich an die eigene
Consumer-Mailbox (`target: "self"` oder eigener `hello.principal`). `events({ mailboxEpoch?, after?, maxBytes?, waitMs? })` liefert
`{ mailboxEpoch, events, next, more, gap? }`; `ack(epoch, upTo)` bestätigt einen
ausgelieferten Präfix. Nach Epochwechsel mit dem gelieferten neuen Cursor fortsetzen.
Ein zugestellter Take trägt eine eigene Txn; sie wird ausdrücklich committet/abgebrochen.

`withSpaceService(existingServerServices, service, trustedConnection)` erweitert den vorhandenen
pi-server um `serviceId: "space"`. Der Client verwendet
`piServerTransport(call => client.request({ serverId }, call))`. Im Nachbarprojekt
wird Space-RPC mit `PI_SERVERD_SPACE_PRINCIPAL` und `PI_SERVERD_SPACE_ROLES` ausdrücklich aktiviert.
Eine vom Client geschickte Identität überschreibt den vertrauenswürdigen Connection-Kontext nicht.

Der Dienst authentisiert über `IdentityAdapter`, nicht über vom Client
übermittelte Principals. `Policy` beschränkt Methoden und Entry-Typen je Rolle.
`StaticIdentity` ist ein lokaler Konfigurations-/Testadapter. TCP allein bietet keine
Föderationsauthentisierung; die verbindungsgebundene Overlay-/Challenge-Schicht
bleibt offen.

## Fehler und Grenzen

`IllegalArgumentError`, `PermissionError`, `TransactionError`, `LimitError`
`CompletionViolation`, `MailboxEpochMismatch`, `InvalidAck`, `ResponseBudgetTooSmall`
und `ResourceExhausted` beschreiben lokale Semantik bzw. Budgetverletzungen.
Der Dienst serialisiert sie als Fehlercodes; der Remote-Client rekonstruiert
bekannte Fehlerklassen als `RemoteError` oder die spezielle lokale Klasse.
Ein maximaler Client-Wartezeitraum löst `OutcomeUnknown` aus, lässt die
Host-Operation aber weiterlaufen.

Die API garantiert keine FIFO-Auswahl und keine Exactly-once-Ausführung
außerhalb atomarer Space-Mutationen. Anwendungen müssen externe Effekte über
eine eigene Idempotenz-ID oder eine gemeinsame Transaktion absichern.

## Phase-1b-Laufzeit und Grants

`startFederationHost(harness, context, options)` startet die persistente Komposition
von Gate, Schicht A/B, Control-Berechtigungen, Enrollment, Rotation, Supervisor und
Wartung. `options` enthält `hostId`, `authorityId`, `keys`, `verifier`, Gate-Konfiguration
und `boot: { external, installed }`. Nur die Control-Seite setzt
`control: { host: harness, authority }`. Ohne Boot-Register/Installation scheitert
der Start; `unsafeSkipBootGuardForTests` ist ausschließlich für Fixtures.

`GrantAuthority.issue(connection, purpose)` benötigt eine frische Overlay-Identität,
einen provisionierten Signer und das aktuelle Schlüsselverzeichnis. `purpose` ist
`effect` oder `resolution`. `GrantVerifier.check(token, identity, call, connection)`
prüft Signatur, Principal, bewiesenen App-Schlüssel, Scope, Authority und Frist.

Ein `RemoteSpace` erhält über `grantProvider(call)` vor jedem fachlichen Aufruf
und jedem Retry einen aktuellen Grant; dieser Frame verändert weder fachliche
Argumente noch Request-Identität. Die Control-Verbindung bietet:

- `requestGrant(purpose = "effect")`
- `lookupPeerKey(peerId, keyId)` für bewiesene Hosts/Admins
- `rotationChallenge(algorithm, publicKey)`
- `rotateKey(challenge, replacementSigner)` mit alter und neuer Signatur
- `rotationStatus(commandId)` für das eigene Ergebnis

Eigene Rotation verwendet einen eigenen Generation-Aufruf und funktioniert auch
bei einem auf Data-Spaces beschränkten Schlüssel; dadurch werden keine Control-
Entries freigegeben. Alte Schlüssel werden atomar widerrufen, Rollen und Scope
übernommen. Grants und eine erfolgreiche Rotation sind keine Nachweise externer
Exactly-once-Wirkung.

Die Recovery-Exporte (`SqliteRecoveryRegister`, `RecoveryCoordinator`,
`installAuthorityTransition`, `installBootGuard`, `beginRestore`, `restoreBatch`,
`completeRestore`, `releaseRestored`) sind Bausteine für einen administrativen
Pfad. Fencing, Admission-Sperre, Registry-Update, Control-ACK und Boot-Installation
muss der aufrufende Dienst nachweisen. Näheres und offene Verdrahtung stehen in
[ap1b-abnahme.md](ap1b-abnahme.md).

## Provisionierter Betrieb und privater Recovery-Zugang

`startConfiguredFederation(host, ctx, privateConfigFile)` prüft private
Schlüssel-/Konfigurationsdateien, den Besitz der Listen-IP laut NetBird,
externe Autorität und Boot-Berechtigung. Die zurückgegebene `service` dient dem
nativen pi-server-Adapter: ihre Peer-ID und Gruppen werden serverseitig pro
Aufruf neu bestimmt. `trustedConnection()` erzeugt den zugehörigen Kontext;
`close()` beendet Gate, Supervisor, Wartung und eigene Register-Verbindungen.
Konfiguration und SSH-Endpunkte sind in [ap1b-betrieb.md](ap1b-betrieb.md) erklärt.

- `provisionFileSigner(path, algorithm)` erzeugt einmalig einen privaten
  Desktop-/Dienstschlüssel; `loadFileSigner(path)` lädt ihn ohne Ersatzidentität.
- `serveRegister(register, socket, { writable })` trennt Reader und Operator;
  `SocketRecoveryRegister` und `SshRecoveryRegister` erlauben Member-Lesezugriff.
- `serveRecovery({ path, hostId, operator, supervisor?, handle })` verlangt
  signierte, zeitlich begrenzte Anfragen für das festgelegte Host-Ziel.
  `RecoveryClient.call(method, args, requestId?)` sendet diese Anfragen.
- `RecoveryController.submit(request)`, `advance(recoveryId)`,
  `status(recoveryId)` und `release({ commandId, recoveryId, scope })`
  bilden einen journalisierten Data-Restore. `dataRecoveryHandler(controller)`
  bindet ausschließlich diese Methoden an den privaten Dienst.
- `verifySshFence(register, hostId, targets)` verlangt über einen fest
  provisionierten SSH-Zugang einen gestoppten Dienst und eine dauerhafte
  Wiederanlaufsperre; Sync-/Replikat-Konfigurationen werden verweigert.

Der Recovery-Controller benötigt privilegierte `commit`-/`snapshot`-Funktionen
desselben Harness, die vor Installation des normalen Boot-Guards gebunden
werden. Ein zweiter gleichzeitig geöffneter Harness ist dafür kein Ersatz.
Diese Funktionen und die schreibende Register-Capability bleiben ausschließlich
im privaten Recovery-Dienst. Der Snapshot-Lader und der tatsächliche dauerhafte
Control-ACK-Kanal werden ausdrücklich administrativ bereitgestellt. `ControlRecoveryController` und `MemberTransitionInstaller` implementieren den
Control-/Member-Ablauf; `startRecoveryOnly` bindet ihn an einen eigenen privaten
Dienst unter exklusivem Harness-Besitz, ohne normalen Gate-/Agentenstart.
Die verteilte Live-Restore-Abnahme ist weiterhin offen.

- `TlsRecoveryRegister` / `serveTlsRegister`: unabhängiges Register mit gepinntem
  CA-Vertrauen und freigegebenen Client-Zertifikaten; Reader, explizit begrenzte
  `writeKeys` und Operator-CAS werden serverseitig getrennt.
- `ControlAckService.acknowledge(tuple, requireHostKey?)`: dauerhafter Receipt für
  die registrierte Data-Transition; aktuelle Authority-/Boot-/Transition-Versionen
  und bei Host-Signatur der weiterhin aktive eingeschriebene Schlüssel werden im
  Commit erneut geprüft.
- `MemberTransitionInstaller.advance(proof)`: gestoppter Normalbetrieb mit
  Neustartsperre, begrenzte Bereinigung, historische Pending-Claims, ungültige
  Generationen, `orphanedAfterRestore`, Epoche 1 und lokales/externes ACK. Ein nach
  lokalem ACK verlorener externer ACK wird beim Retry erneut veröffentlicht.
- `ControlRecoveryController.submit(request)`, `advance(recoveryId)`,
  `authorizeKey(recoveryId, key)` und `status(recoveryId)`: Import mit neuer
  Authority, geschlossenen alten Rechten, erster expliziter Admin-Freigabe,
  bestätigten Member-ACKs und Ablauf der alten Grant-/Lease-Frist.
- `controlRecoveryHandler(controller, member)` akzeptiert nur den gepinnten
  Recovery-Operator. `startRecoveryOnly(host, ctx, configFile, assertQuiesced)`
  startet dafür ausschließlich den privaten Socket.
- `startMemberRecoveryOnly(host, ctx, configFile, assertQuiesced)` startet den
  ausschließlich für OP-signiertes `installAuthority` vorgesehenen Member-Socket.
  Die Konfiguration enthält einen öffentlichen `operator`-Pin und einen
  `registerTls`-Zugang mit Schreibrechten nur für den eigenen Boot-/ACK-Eintrag;
  private OP-/Control-Signierschlüssel sind nicht erforderlich. Normalbetrieb
  muss gestoppt und persistent gegen Wiederanlauf gesperrt sein.

## `RouterController` (AP 2.1)

```ts
const router = new RouterController({
  host: harness, ctx, routerId, authorityId,
  target: idempotentRpcTarget,
  assertAuthority: verifyCurrentRouterOwnership,
});
await router.recover();
await router.submit({ id, area, blocksArea: false, steps });
const state = await router.advance(id);
```

`steps` enthalten unveränderliches Ziel `{hostId, spaceId, authorityId,
dataIncarnation, primaryEpoch}`, Principal, Generation, RPC-Methode, Argumente
und optional `resultBudgetBytes`. Der Controller vergibt stabile Unterrequest-IDs;
Zieladapter müssen sie unverändert als RPC-`requestId` verwenden.

| Methode | Wirkung |
|---|---|
| `recover()` | Rekonstruiert Bindings und Reservierungen; löst alte Unterrequests auf, sendet keine neue Wirkung |
| `submit(spec)` | Persistiert einen Command; dieselbe ID mit anderen Argumenten ist `RouterConflict` |
| `advance(id)` | Führt gebundene Schritte weiter; ungelöste Transporte bleiben `applying` |
| `get(id)` | Liefert aktuellen Command einschließlich Teilresultaten und Review-Nachweisen |
| `ingest(spec, ack)` | Dauerhafte deduplizierte Aufnahme vor Mailbox-ACK |
| `reconcileDataRestore({hostId, spaceId, oldIncarnation, recoveryId})` | Persistiert Restore-Reviews unter Beibehaltung historischer Resultate |
| `review(id, admin, note, releaseArea, authorize)` | Separater autorisierter Audit; verändert `needsReview` nicht in Erfolg |

`RouterBlocked` sperrt fehlende Rekonstruktion/Autorität oder abhängige Bereiche;
`RouterBudgetExceeded` verweigert neue Arbeit vor Wirkung. `RouterTarget` ist
bewusst ein Adaptervertrag. Produktive RouterLease/Delegation ist AP 2.2.
Details und Simulator: [AP 2.1/2.8](ap2-router-und-simulator.md).

## Federation-Controller (AP 2.2–2.5)

`createFederationController` verbindet `RouterController`, `FederationRpc`,
`FederatedSpace`, `FederationPolicyAuthority` und `MembershipController`.
`renewableRouterLease` betreut den signierten Lease. Die Root-Komposition
führt den `lease`-Callback außerhalb von Journal-Commits aus; dort darf eine
Erneuerung den Control-Host selbst verwenden. Innerhalb eines Journal-Commits
prüft sie den bereits bezogenen Lease und die aktuellen Control-Zähler erneut.
Ein abgelaufener oder ersetzter Lease wird weiterhin abgelehnt. Der separat
injektierte `assertAuthority` bleibt eine reine Autoritätsprüfung; er darf
keinen verschachtelten Commit auf demselben Host anfordern. `MemberLifecycle` installiert
signierte Control-Anweisungen; `startConfiguredFederation` aktiviert dies mit
`membership: {memberId, spaceId}`. Diese APIs gehören zum serverseitigen Router;
sie ersetzen nicht die Signaturen des bestehenden `RemoteSpace`.

Optional provisioniert `journalPartitions` (1 bis 1024, Standard 1) feste,
persistente Parent-/Router-Partitionen. Die Rückgabe enthält zusätzlich
`partitionRouters`; `router` bleibt der gemeinsame Control-Router. Die Anzahl
und IDs sind nach Initialisierung unveränderlich. Bestehende Historie wird
nicht automatisch migriert, und alte Request-IDs werden nicht verworfen.
Jede Partition behält die bisherigen Einzelbudgets; die Gesamtreservierung
wächst mit der festgelegten Anzahl. Der Default bleibt kompatibel mit alten
Ein-Journal-Beständen. Direkte `FederatedSpace`-Komposition verlangt passend
viele unterschiedliche `partitionRouters` sowie `initializeJournals()` vor dem
Betrieb; alle Router müssen vorher rekonstruiert sein. Die Factory übernimmt
die Initialisierung und Rekonstruktion vor ihrer Rückgabe. Cross-Partition-
Transaktionen lesen ihre ursprüngliche Child-Bindung aus der Ursprungspartition.

Restore setzt vor dem ersten Abgleich eine persistente Gesamtsperre und hebt
sie erst nach allen Partitionen auf. Ein unterbrochener Abgleich wird mit
demselben Restore-Tupel fortgesetzt. Die Mitgliedsentfernung berücksichtigt
das Manifest und sämtliche zugehörigen Router-/Parent-Referenzen.

Parameter, Rückgaben, Rechte, Budgets und Grenzen:
[Delegation, Routing und Membership](ap2-delegation-routing-membership.md).

## Directory und lokale Admin-Bausteine (AP 2.6/2.7)

`RemoteSpace.publishCapability(report)` veröffentlicht einen `CapabilityReport`
über den geschützten Control-RPC `capabilityHeartbeat`. Der Report enthält
`hostId`, `resources`, `tools`, `models` und `metrics`. Aktueller Host-Key,
Host-Rolle, Grant und eine passende Peer/Host-Bindung sind erforderlich.
Lease und Zeitstempel legt der Empfänger fest: 120 Sekunden bzw. seine Uhr.
Normales `write`, Take, Txn-Locking und Lease-Änderungen an Directory-Entries
stehen Clients nicht zur Verfügung, auch nicht über Supertypes.

`CapabilityDirectory.heartbeat(report, authenticatedIdentity)` ist die interne
Host-API; ihre Identität muss vom bewiesenen Verbindungszustand stammen.
`MemberStatusDirectory.refresh()` übernimmt aktuelle, an den Ziel-Tupel
gebundene Probes. `start()` erneuert sie alle 15 Sekunden und liefert einen
asynchronen Stopper. Status-Lease: 30 Sekunden. Fehlgeschlagene oder veraltete
Probes entfernen Kapazitäts-/Capability-Beobachtungen aus der Routing-Tabelle.
Directory-Veröffentlichung registriert keinen Routing-Member.

Die provisionierte Runtime-Konfiguration `capabilities` kann `dataSpaces`,
`tools`, `models` und im Control `hostBindings` enthalten. Letzteres ordnet
technische Peer-IDs den eigenen Host-IDs zu. Die Runtime veröffentlicht nur
bei dieser expliziten Konfiguration automatisch, im Abstand von 60 Sekunden.
Lesen erfolgt über `readAll({type:"Capability"})` bzw. das vorhandene
`space_list`, innerhalb des eigenen Space-Scopes.

`DataAdminController.execute(commandId, kind, spaceId, admin, input)` akzeptiert
`kind = "purgeTasks" | "deletePrincipal"`. Input ist ein Task-Template bzw.
ein strukturierter Principal. Die vom Betreiber bereitgestellte `authorize`
prüft den gesonderten Scope pro Kind/Space; `assertAuthority` prüft die aktuelle
Autorität. `spaceId` muss die unveränderliche Space-ID sein; Aliasnamen werden
abgelehnt. Beide Prüfungen laufen erneut im Commit. Jeder erfolgreiche Batch und
sein Fortschritt sind atomar; dieselbe Command-ID mit verändertem Inhalt wird abgelehnt.
Ein im Control-Runtime provisionierter `dataAdmin` bindet die Supervisor-
Commands mit `args.spaceId` und `args.template` bzw. `args.principal` ein.

`purgeTasks` akzeptiert nur profilierte, unreservierte Tasks. `deletePrincipal`
setzt zunächst einen ruhenden lokalen Space voraus. `execute` verarbeitet
den Löschlauf in begrenzten Commits bis zum Abschluss. Alternativ starten
`startDeletion(commandId, spaceId, admin, principal)` und
`advanceDeletion(commandId, spaceId, admin, principal)` einen Lauf bzw. genau
einen Batch; das Ergebnis enthält Phase und Batch-Anzahl. Derselbe Command
setzt nach Neustart oder verlorener Antwort fort. Währenddessen blockiert
eine persistente Space-Sperre neue Wirkungen und Objektabfragen. Ein geänderter
Ziel-Tupel verlangt Review. Remote-Members und Router-Historien werden damit
noch nicht gelöscht.

`FederatedSpace.reconcileDataRestore({hostId,spaceId,oldIncarnation,recoveryId})`
markiert Child-Requests und Parents `needsReview`, ohne neue Wirkungen.
Es muss als Reconciliation-Hook vor der Control-Restore-Bestätigung eingebunden
werden. Verwaltete Spaces erhalten ohne diesen Hook kein Control-Receipt.
[Abnahmestand und Grenzen](ap2-abnahme.md).

`PiSpaces.resolveOperation` erhält einen `RequestRef` einschließlich Principal;
`RemoteSpace.resolveOperation` erhält `{generation, requestId}` und verwendet
die authentifizierte Identität. Methode und Hash bezeichnen die ursprünglichen
normalisierten Claim-Argumente (`write`, `take`, `txn.begin` usw.). Der neue
Wire-Aufruf verlangt bei Delegation eine signierte `targetRequest`-Referenz
mit denselben Bindungen. Die lokalen Kontroll-/Admin-Prüfungen werden auch bei
der Auflösung wiederholt. Eine signierte Generation enthält jetzt ihre
Ausstellungs-Primary-Epoche; ältere Generationen bleiben für vorhandene Claims
kompatibel, erlauben aber keinen neuen Fehl-Claim-Nachweis.

`AdmissionResolution.state === "notAdmitted"` bedeutet ausschließlich, dass
der identische Request beim unveränderten Primary erneut gesendet werden
kann. Die Antwort ist kein terminales `NotCommitted` und erlaubt keine
Ersatz-ID. Bekannte Claims liefern weiterhin `pending`, `done` oder `cancelled`
mit bisherigen Retention-/Restore-Markierungen. Für alte Members ohne
`resolveOperation` fällt der Router auf `pollOperation` für bekannte Claims
zurück; ein unbekannter Ausgang bleibt dort konservativ `needsReview`.


### Native Root- und Verwaltungsbausteine (2026-10-14)

`startConfiguredFederation` akzeptiert im Control-Modus optional `root` mit
festem Root-ID, getrennten `keyFile`/`hostKeyFile`, privatem `leaseFile`,
`journalPartitions` und provisionierten `members`. Ein Member bindet sein
Zieltupel, Peer-ID, App-Key-Pin und seine Overlay-Adresse. `createConfiguredRoot`
prüft die unabhängige Boot-/Control-Autorisierung und aktive Schlüssel; es liefert
die serverseitigen Federation-Controller sowie `close()`. Mit
`allowMembershipCommands` und `adminPeer` verarbeiten die echten Supervisor-
Handler Membership- und Profilbefehle im autorisierten Admin-Kontext.
Dies erzeugt keinen öffentlichen virtuellen Root-Space-RPC-Endpunkt.

`ProfileTransitionController.execute(id, nextPolicy)` ersetzt ausschließlich
Abschlussprofile bei um eins erhöhter Policy-Version. Offene Root-Aufträge,
Transaktionen und Membership-Wechsel verhindern den Start. `start` und `advance`
erlauben einzelnen, dauerhaft journalisierten Fortschritt; dieselbe ID bindet
dieselbe Policy. Members werden eingefroren, umgestellt und erst nach
Veröffentlichung der neuen Policy aktiviert. Der Supervisor-Command heißt
`migrateProfiles`, mit `args.policy`; der Controller muss provisioniert sein.
Gewöhnliche `setPolicy`-Änderungen bestehender Profile bleiben gesperrt.

`RootHistoryErasure` entfernt unter separater Operator-Autorisierung und
nachgewiesenem exklusiven Fencing Principal-Inhalte aus Root-Parent-/Child-
Historien. Erfasste Entry-Digests schließen betroffene fremde gecachte Ergebnisse
ein. Alte Request-IDs bleiben gebunden und liefern `ResultExpired`; sie werden
nicht für neue Wirkungen freigegeben. `DataAdminController` bleibt für die
lokalen Data-Inhalte zuständig. Ein vollständiger verteilter Löschlauf entsteht
nicht allein durch diese beiden Bausteine.

`ErasureArchiveController` verlangt Operator-Autorisierung, eine
`destroy`-Funktion und eine unabhängige `verifyDeletion`-Prüfung. Es registriert
Archive, beginnt eine Lösch-Epoche, quarantänisiert ältere Archive, verarbeitet
Löschfristen und versiegelt die Epoche nach geprüftem lokalem Abschluss.
`assertRestore(spaceId, artifactId)` prüft Katalog und aktuelle Epoche; der
Restore-Aufrufer muss zusätzlich die tatsächlichen Archivbytes an den
registrierten Hash binden. Unvollständige Löschungen, alte Snapshot-Epochen und
überfällige Archive sperren normale Dienste durch den unabhängigen Register-
Eintrag. `SqliteRecoveryRegister` prüft Lösch-Epoche und Archivkatalog atomar
innerhalb des CAS-Commits, auch hinter mTLS: Epochen beginnen bei eins, steigen
nur nach abgeschlossenem vorherigem Löschlauf einschließlich Archivlöschung,
und behalten Command-Hash und Löschfrist. Archiv-IDs, Hashes, Epochen und Arten
sind unveränderlich; Quarantäne und Zerstörung sind nicht rücksetzbar. Eine
verspätete Registrierung eines alten Backups scheitert am aktuellen Floor.
Die vollständige Backup-/Restore-Betriebsintegration steht noch aus.
Andere `RecoveryRegister`-Implementierungen müssen dieselben atomaren
Constraints garantieren; reine Aufruferprüfungen reichen dafür nicht aus.


### Frische Prüfungen und gebundene Claim-Antworten

`RecoveryRegister.getMany(keys)` ist optional. TLS-Clients aktivieren den bounded
Batch-Aufruf ausdrücklich mit `batchReads: true`; höchstens 32 eindeutige Schlüssel
werden pro Batch gelesen. Jeder Batch eröffnet eine neue gegenseitig authentifizierte
TLS-Verbindung. Ohne Opt-in bleiben Einzelabfragen erhalten. Ein `unixPath`-Transport
verlangt einen absoluten Socketpfad und einen explizit gepinnten TLS-Servernamen.

`SpaceKeyDirectory.findMany(keys)` und `inspect(keys)` lesen jedes Mal einen normalen,
geschützten Control-Snapshot. `inspect` liefert dessen Zustand und daraus abgeleitete
Schlüssel gemeinsam; es speichert weder Zustand noch Authentifizierung für Folgeaufrufe.

`RemoteSpace.requestBoundWithClaim(call)` verlangt zusätzlich zum normalen Ergebnis
optional einen gebundenen Claim-Beleg. Der Dienst löst dafür den tatsächlich gespeicherten
ursprünglichen Claim auf; der Router prüft Host, Space, Authority, Incarnation, Epoche,
Principal, Generation, Request-ID, Methode und Argumenthash. Das rohe RPC-Ergebnis
ersetzt diesen Beleg nicht. Fehlt er bei einem älteren Dienst, bleibt eine getrennte
Claim-Auflösung erforderlich. Wiederhergestellte, abgelaufene oder widersprüchliche
Ergebnisse führen weiterhin zu Review.

`RouterStepSpec.generationAdmitUntil` hält die bestätigte Zulassungsfrist fest. Eine
Transaktionsfolge darf die ursprüngliche Generation nur innerhalb dieser Frist und
bei identischer Bindung verwenden. Das ersetzt keinen App-Key-Beweis, Grant oder
Delegationsnachweis. Fehlende Fristen in älteren Journaleinträgen führen zum bisherigen
frischen Generation-Aufruf.

### Verteilte Principal-Löschung und SQLite-Historien

`DistributedPrincipalErasure({register, archives, driver, authorize})` besitzt
`advance(plan)` und `execute(plan)`. Ein Plan bindet `id`, `principal`, bis zu
32 eindeutige Space-Zieltupel mit genau einem Root und `retentionMs` (maximal
24 Stunden). Die Fortschrittsadresse lautet `erasure-command:<id>` im
unabhängigen Register. Geänderte Argumente unter derselben ID werden
abgewiesen. Die aktuelle Sammelgrenze beträgt 4096 Entry-IDs (je höchstens 256 Zeichen);
eine Überschreitung stoppt den Command unter den bestehenden Sperren.
Driver-Aufrufe müssen für dieselbe Command-Bindung wiederholbar
sein und exklusiv gestoppte Writer nachweisen. Vor jedem Wartungsschritt
werden alle Sperren geprüft; Freigabe setzt alle versiegelten Floors voraus.
Die CLI [run-distributed-erasure.ts](../test/testbed/run-distributed-erasure.ts)
bindet dies für den eigenen Testverbund an echte Prozesse, lokale Löschbelege,
Archivdateien und die unabhängigen mTLS-Registereinträge.

`compactErasedSqlite(path, assertExclusiveFenced)` bereinigt alte Revisionen
der sessionweiten pi-spaces-Dokumente in einem gestoppten SQLite-Store mit
pi-durable-Schema 1. Es bewahrt aktuelle Dokumentwerte und die letzte Sequenz
und Version, entfernt überholte Revisionen, führt Secure-Delete, Checkpoints,
VACUUM und Integrity-Check aus. Symlink-Dateien und andere Schema-Versionen
werden abgewiesen. Der Aufrufer muss die logische Principal-Löschung bereits
abgeschlossen haben und den exklusiven unabhängigen Fence während des
gesamten Aufrufs halten. Es ersetzt keine Löschregel für externe Kopien.


## Entry-Replikation: administrativer Phase-3-Baustein

`EntryReplicationController` verwendet ein eigenes Dokument, keine automatische
Replikation bestehender `PiSpaces`-Entries. Konfiguration, Aufrufmethoden,
Vertrauensgrenze und Betriebsbeschränkungen stehen in
[Phase 3](ap3-replikation.md). Die exportierten HLC-Funktionen sind
`advanceHybridClock`, `compareHybridClock` und `validateHybridClock`. Die Uhr
muss atomar mit der Änderung gespeichert werden; der Controller übernimmt dies.
`EntryReplicas` ist eine interne administrative Dokumentfamilie und kein
unautorisierter RPC-Importpfad. Der öffentliche Dienst bietet dafür noch keine
Methoden an. Primary/Standby und Promotion werden dadurch nicht bereitgestellt.


### Gepagter Snapshot-Import

`EntryReplicationController.startSnapshot` und `snapshotPage` exportieren eine
bei R eingefrorene Historie. `beginSnapshotImport`, `importSnapshotPage`,
`snapshotImportStatus`, `finishSnapshotImport` und `abortSnapshotImport`
verwalten dauerhafte Seiten und den Import-Cursor. Erst der Abschluss macht alle
Seiten atomar sichtbar. `sourceRevision` im Abschlussresultat nennt den Startpunkt
für danach entstandene Änderungen. Grenzen, Wiederaufnahme, Abbruch und
Vertrauensbereich: [Snapshot-Transfer](ap3-snapshot-transfer.md).
