# AP 2.2–2.5: Delegation, Routing und Membership

Stand: 2026-10-11. Die serverseitigen Bausteine sind implementiert und auf JSONL
und SQLite geprüft, einschließlich echter TCP-Verbindungen mit Schlüsselbeweis.
Die vollständige Phase-2-Abnahme mit Drei-Member-Sieb und Lasttest bleibt separat.

## Verwendung

`createFederationController` verbindet Policy, Router-Journal, `FederatedSpace`,
den produktiven `FederationRpc` und `MembershipController`. Die Komposition
prüft vor Journalzugriffen sowohl die externe Boot-/Control-Berechtigung als auch
die signierte, noch aktuelle RouterLease. Sie prüft offene Referenzen zusätzlich
im atomaren Control-Commit einer Entfernung. Ein Journal hat einen Eigentümer;
gleichzeitige Aufrufe desselben `FederatedSpace` werden serialisiert.

Der Betreiber stellt die tatsächlichen Member-Transporte und Schlüssel-Pins,
den Control-Signer, den separaten Router-App-Schlüssel und einen Provider für
**Grants des ursprünglichen Principals** bereit. Ein Grant des Router-Peers
ersetzt keinen Benutzer-Grant. `renewableRouterLease(controlRemote)` erneuert
nach 20 Sekunden; nach Prozessneustart wird eine neue Epoche angefordert.

Dies ist eine serverseitige API mit expliziten Request-IDs und Principals.
Der bestehende `RemoteSpace` bleibt der Client eines physischen Member-Spaces.
Ein neuer öffentlicher virtueller Space-Endpunkt oder eine TUI für die neuen
Admin-Kommandos ist mit diesem Paket nicht eingeführt.

## 2.2: RouterLease und Delegation

`routerLease` am Control-Gate verlangt einen bewiesenen aktiven Router-Schlüssel
und einen aktuellen Control-Grant. Die Supervisor-Signatur wird erst nach dem
dauerhaften Lease-Commit erzeugt. Erneuerung hält die Epoche; Übernahme erhöht sie.
`routingPolicy` liefert nur bewiesenen Service-Peers die signierte Policy.

Delegation bindet Original-Principal, aktiven Original-App-Schlüssel, Space-ID,
Methode, fachlichen Hash, Generation, Request-ID, Policy und Ziel-Epoche.
Supervisor und Router signieren getrennt. Nur der erneuerbare Rahmen ändert
sich bei Wiederholungen. Folgeaktionen nennen ihren ursprünglichen Claim;
Waiter-Transaktionen behalten die Ursprungsreferenz auch nach Mailbox-ACK.

Höchste Epochen werden im Member persistent gespeichert. Alias und stabile
Space-ID treffen denselben Schutz. Epoch-Notices sperren alte Pending-Effekte.
Delegierte Mailbox-Polls verlängern ausschließlich den referenzierten Waiter.
Quoten zählen Original-Principal und physischen Router-Peer. Ein bewiesener
Host darf ausschließlich `agentId`s unter seiner eigenen Peer-ID verwenden;
Rollen und Scope werden dadurch nicht erweitert.

## 2.3: FederationPolicy

Die Policy und der Control-Zähler `policyVersion` wechseln atomar. Regeln nennen
registrierte Member; Default, vorhandene Typ-Platzierungen und HRW-Mengen sind
unveränderlich. Capacity-/Capability-Suchmengen dürfen erweitert und nur nach
bewiesener Entfernung verkleinert werden. Veraltete Kapazitätsdaten und fehlende
Fähigkeiten führen zu Fehlern; ein gewählter Write wird nicht umplatziert.

HRW benutzt kanonische Feldwerte und stabile Member-IDs. Bekannte Schlüssel
engen Suchziele ein; Wildcards und deklarierte Supertypen erweitern sie.
`supertypes` bilden einen unveränderlichen, zyklenfreien Typkatalog. Der Router
vervollständigt ihn beim Schreiben; verwaltete Member prüfen ihn auch lokal.

Die Schema-Prüfung kennt spätere Primary-/Merge-Varianten und deren
Unverträglichkeiten. Ihre Aktivierung ist bis Phase 3 gesperrt. Änderungen
vorhandener Abschlussprofile brauchen den kontrollierten Übergang aus AP 2.6.

## 2.4: FederatedSpace

Vor der ersten Wirkung stehen Principal, Policy, vollständige Zielmenge,
Argumente, absolute Waiting-Deadline und zukünftige Unterrequest-Budgets im
Journal. Targets, Generationen und Request-IDs bleiben bei Wiederholung erhalten.

- `write(entry, request, leaseMs?)` bindet genau eine Platzierung.
- `read(template, request)` und `take(template, request)` suchen ohne Warten.
  Ein Take wechselt erst nach bestätigtem Miss zum nächsten Member. Ein unklarer
  Ausgang ergibt `FederationPending` und bleibt über `resume(id)` auflösbar.
  Ein Read darf einen erreichbaren Treffer liefern; ein globaler Miss verlangt
  die Ergebnisse aller Suchziele.
- `readAll` und `count` verlangen standardmäßig alle Member. `allowPartial`
  liefert `complete`, `missingMembers` und Revisionen je Member.
  `waitForCompleteMs` wiederholt die vollständige Abfrage höchstens 60 Sekunden.
  Die Revisionen behaupten keinen global konsistenten Snapshot.
- `createTransaction(member, leaseMs, request)` liefert Member und `originId`
  zusätzlich zur Lease. Folgeoperationen verwenden diese Bindung unter demselben
  Principal. `finishTransaction(originId, action, request)` journalisiert Commit
  oder Abort. Eine andere Route oder ein fremder Principal ergibt `RoutingConflict`.
- `readWaiting(template, timeoutMs, request)` betreut wartende Reads ohne
  Reservierung oder Verbrauch des gelieferten Eintrags.
- `takeWaiting(template, timeoutMs, txnLeaseMs, request)` registriert begrenzte
  Waiter und journalisiert Ereignisse vor ACK. Die erste noch aktive Reservierung
  wird dauerhaft zum Gewinner. Dessen Commit und Verlierer-Aborts haben eigene
  stabile IDs. Späte Verlierer werden nach der Stornierung erneut eingesammelt.
  Eine verlorene Gewinner-Antwort löst keine zweite Gewinnerwahl aus.
  Mit Benutzertransaktion wird nur der gebundene Member betreut; dessen Commit
  bleibt beim Benutzer.

Ereignisse anderer Federation-Operationen desselben Principals werden vor dem ACK
in deren eigenes Journal weitergegeben. Unbekannte fremde Mailbox-Ereignisse
blockieren das ACK und verlangen den zuständigen Dispatcher.

Der produktive RPC-Pfad wertet dauerhafte Claims aus. Bei fehlender oder
abgelaufener Historie liefert er konservativ `needsReview`; er erfindet keinen
`notAdmitted`-Nachweis. Der Simulator kann diesen Nachweis anhand des echten
Member-Dokuments und einer noch gültigen Generation liefern.

## 2.5: Membership

`MemberLifecycle` nimmt ausschließlich signierte Anweisungen des gepinnten
Control-Supervisors an. Im provisionierten Start wird er mit
`membership: {memberId, spaceId}` aktiviert. Nach verwalteter Aufnahme installiert
der Member aktuelle signierte Policies vor normalen RPC-Effekten. Direkte lokale
Worker benutzen dieselben Core-Sperren.

`MembershipController.execute(commandId, kind, member, newDefault?)` behandelt
`add`, `drain` und `remove` außerhalb von Control-Commits. Der Supervisor verbindet
diese Operationen mit `addMember`, `drain` und `removeMember`, wenn die
Root-Komposition in `control.membership` eingesetzt wird. Sein eigenes Journal
behält unklare Remote-Ausgänge und wiederholt sie nach Neustart.

Aufnahme sperrt lokale Admission **vor** der Bestandsprüfung. Alle physischen
Entries zählen; nicht sichtbare Transaktionen und Pending-Arbeit verhindern die
Aufnahme. Unbekannte Bestandstypen erhalten feste Regeln für diesen Member.
Ein falscher Bestand wird vor dem Policy-Commit mit einer signierten Ablehnung
freigegeben. Nach unklarem oder bereits erfolgtem Control-Commit gibt es keine
lokale Freigabe. Wiederholung verwendet dieselbe Übergangsidentität.

Drain setzt eine dauerhafte Admission-Grenze. Neue unabhängige Writes und neue
Tasks sind gesperrt. Vor der Grenze eröffnete Transaktionen bekommen ein
begrenztes Abschlussfenster. Danach genommene profilierte Tasks dürfen nur ihre
gebundenen Results mit passenden Feldern, Mengen-, Byte- und Lease-Grenzen
schreiben. Unbegrenzte Lease-Verlängerung ist gesperrt.

Entfernung verlangt Nullbestand einschließlich unsichtbarer Entries, Transaktionen,
Waiter, Fanout-Jobs und Pending-Claims. Notify-Registrierungen werden mit
`registrationClosed(reason: "removing")` geschlossen. Erst danach entsteht das
signierte `EmptyProof` mit Space, Autorität, Übergangs-ID, Admission-Version und
Revision. Root prüft offene Unterrequests, Federation-Operationen, Transaktionen
und weitere Kontrollreferenzen erneut im Entfernen-Commit. Policy und Membership
wechseln gemeinsam; ein verbleibender Default ist Pflicht. HRW-/Typ-Mengen
werden mit `MigrationRequired` abgewiesen. Mailbox-ACKs und aufbewahrte Ergebnisse
bleiben über die alte Space-ID erreichbar.

## Grenzen und Nachweise

Die Budgets sind konservative vorläufige Werte: höchstens acht Ziele und
16 aufbewahrte logische Federation-Operationen; pro Operation 128 KiB reservierte
Metadaten/Ergebnisse. Das Router-Journal reserviert zukünftige Kinder vor Wirkung
und wirft historische IDs nicht weg. Finale Lastwerte folgen in AP 2.9.

Die automatischen Tests umfassen Signaturfälschung, Widerruf, Epochenwechsel,
Policy-Wechsel, verlorene Antworten, echte TCP-Gates, JSONL-/SQLite-Neustart,
sequenzielle Takes, Teilabfragen, konkurrierende Reservierungen, Txn-Bindung,
Drain, falschen Bestand, Notify-Schlussereignisse und atomare Referenz-Races.
Die abschließenden Zählwerte und Build-Nachweise stehen in
[checks.json](../test/evidence/ap2-2026-10-11/checks.json).

Offen bleiben AP 2.6 (weitere Admin-Kommandos und kontrollierte Profilwechsel),
2.7 (automatisches Capability-/MemberStatus-Verzeichnis), 2.9 (Lastabnahme) und
die vollständige Phase-2-Systemabnahme. RunGate und Replikation folgen später.

Die finale Prüfung umfasst 345 Gesamttests, 158 Beispieltests, vier Mobile-Tests
und [65 kompilierte Tests auf big](../test/evidence/ap2-2026-10-11/server-built-phase2.json).
Der isolierte Container verwendet kontrollierte Management-Verzeichnisse und
echtes Loopback-TCP; dies ist keine vollständige Phase-2-Overlay-Abnahme.
Das normale Android-APK ist offline gebaut. Sein abschließendes Update auf dem
Handy steht aus, da WLAN-ADB und der NetBird-Peer aktuell nicht erreichbar sind.
