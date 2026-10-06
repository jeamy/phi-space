# Föderierte Spaces v1 – Analyse und Plan

Ziel: Jeder erreichbare Host (pi-serverd) stellt Agenten einen Space bereit. Mehrere Spaces lassen sich verbinden
und von beliebigen Clients (Handy, Desktop, CLI, Browser) steuern und beobachten. Zwei Verbundmodi: **expand**
(verteilen, ähnlich RAID 0) und **sync** (spiegeln, ähnlich RAID 1). Die Steuerung ist selbst ein Space (**Control
Space**), der Router ein Worker darin. Das Netz ist ein selbst gehostetes **NetBird**-Overlay (WireGuard).

Grundlage ist die bestehende Implementierung, siehe [spaces-v1.md](spaces-v1.md); deren Lücken L1–L3, L7 und B1 sind
hier Voraussetzungen.

Überarbeitet nach Konsistenzprüfung am 2026-10-06. Dieses Dokument beschreibt den Zielvertrag, nicht bereits
implementierte oder getestete Garantien. Die Abnahmekriterien in Abschnitt 11 und 12 sind noch zu erfüllen.

## 1. Bewertung des ursprünglichen Entwurfs

Der Entwurf (vier Schichten, Modus pro Typ, Primär/Replikat, Verzeichnis, Stern zuerst) ist im Kern richtig.
Folgende Punkte waren unvollständig oder so nicht umsetzbar; die rechte Spalte nennt die Lösung in diesem Plan:

| Aussage im Entwurf | Bewertung → Lösung |
|---|---|
| „Identität kommt von der Verbindung (host:handy)“ | Über `ssh -L` sieht pi-serverd nur einen lokalen Unix-Socket desselben Users; pi-server authentifiziert Peers nicht. → NetBird-Peer-Identität plus signierte Challenge in der App (Abschnitt 4). |
| „requestId wie der Claim pro Tool-Aufruf“ | Der Claim ist ein Task-Dokument und existiert nur innerhalb eines Tool-Tasks. → eigener Session-Speicher `(peer, requestId) → Ergebnis` mit Ablauf (6.2). |
| „Blockierender Take legt Waiter auf allen Mitgliedern an“ | Richtig, aber Waiter liefern heute nur an lokale Conversations; String-Ziele werden verworfen (L1). → Peer-Postfach (Mailbox) mit Long-Poll und Quittung (6.1). |
| „Replikate bekommen einen nummerierten Änderungsstrom“ | Es gibt keine Revision und keinen Strom (L2). → `rev` + Delta-Ring im Core (6.1). |
| „Last-Writer-Wins für Location/Weather“ | Tuple Spaces haben keine Schlüssel. → deklarierte Schlüsselfelder pro gespiegeltem Typ (6.1). |
| „Es gewinnt der neuere asOf“ | Uhren verschiedener Hosts driften. → Leases mit begrenzter Zeitunsicherheit; HLC ordnet Versionen, garantiert keine fachlich neueste Messung (7.2). |
| „Transaktionen auf ein Mitglied beschränken“ | Richtig; IDs müssen das Mitglied tragen (L3). → globale IDs `spaceId/localId`; Host-, Space- und Replikatidentität getrennt (Abschnitt 2). |
| „Verzeichnis mit Capability-Entries“ | Richtig (Jini Lookup Service); braucht schreibgeschützte Typen. |
| Router auf dem Handy, Stern über das Handy | Handy schläft oder wird beendet (MIUI, Phantom-Process-Killer). → Router als Worker im Control Space auf einem Host; Clients steuern nur (Abschnitt 5). |
| Verbindungen per SSH, Schlüssel pro Host-Paar | Funktioniert, aber TOFU, Schlüsselverteilung und NAT sind Handarbeit. → NetBird übernimmt Schlüsselaustausch, Verschlüsselung, NAT-Traversal und Netz-ACLs (Abschnitt 4). SSH-CA bleibt als Alternative (Anhang A). |

Ergänzt gegenüber dem Entwurf: Owner über Hosts, Quoten pro Peer, Schleifen-Vermeidung beim Spiegeln,
Protokollversionierung, Rückstau, Simulator-Tests mit Partitionen, Migration des Dokuments (Version 4 → 5).

## 2. Begriffe

- **Host**: pi-serverd mit stabiler, ungekürzter `hostId`; kann mehrere Spaces halten.
- **Space**: logischer Bestand mit unveränderlicher `spaceId`. Namen sind veränderbare Aliase.
- **Member**: ein logischer Data Space in einer Federation; `memberId = spaceId`. Im Modus expand allein
  zuständig für seine Entries, Txns, Waiter und Outbox. Im Modus primary kann er physische Replikate besitzen.
- **Replikat**: physische Kopie mit eigener `replicaId`; übernimmt bei Promotion dieselbe logische `spaceId`.
- **Control Space**: geschützte Steuerdaten; primary mit optionalem, später verbindlichem synchronem Standby.
- **Router**: Worker auf dem Koordinator; betreibt `FederatedSpace`, Replikatoren und Kommandos.
- **Supervisor**: lokaler Dienst je Host, unabhängig vom Router; bearbeitet Enrollment und lokale Recovery-Requests.
- **Recovery Space**: lokaler, nicht replizierter Space pro Host für autorisierte Recovery-Requests und Ergebnisse.
- **Client**: Handy, Desktop, CLI oder Browser über Gateway.
- **Peer**: authentifizierte Gegenstelle mit unveränderlicher `peerId`; Anzeigenamen sind keine Identität.
- **Owner**: strukturierter Principal `{peerId, agentId?}`; Darstellung als String ist nur Ausgabeformat.
- **Federation**: benannte Menge von Members plus versionierte Policy.
- **Global ID**: `<spaceId>/<localId>`. Lokale IDs werden auch nach Restore nicht wiederverwendet, etwa durch
  Inkarnations-ID plus Zähler; nach Restore wird vor neuen Writes eine neue Inkarnation vergeben.
  Replikation erhält vorhandene logische Entry-IDs. Restore ist keine reguläre verlustfreie Promotion.
- **Mailbox**: dauerhafte Events für einen Principal und Consumer, identifiziert durch `mailboxId`, `epoch`, `seq`.
- **Overlay**: NetBird-Netz; IPs dienen als Endpunkte, nicht als dauerhafte Identitäten.

### 2.1 Verbindliche Garantien und Grenzen

| Ebene | Vertrag |
|---|---|
| Lokaler Commit | Space-Mutation und RPC-Ergebnis werden atomar dauerhaft geschrieben. |
| Retry | Derselbe gültige Request liefert dasselbe Ergebnis ohne erneute Mutation; begrenztes Fenster (6.2). |
| Take unter Txn | Höchstens eine aktive Reservierung pro Entry; Abort/Ablauf erlaubt erneute Reservierung. |
| Erfolgreicher Take | Höchstens ein erfolgreicher destruktiver Commit je Entry-Identität in expand/primary. |
| Fachliche Wirkung | Keine allgemeine Exactly-once-Garantie für externe Effekte; Zielsystem braucht Idempotenz oder gemeinsame Transaktion. |
| primary mit synchronem Standby | Bestätigte Operationen bleiben bei zulässiger Promotion erhalten (7.2). |
| Asynchrone Kopie | Backup/Lesekopie; bestätigte Writes oder Takes können beim Verlust des Primary fehlen. Keine sichere automatische Promotion. |
| lww/set | Eventuelle Konvergenz nach vollständigem Austausch unter den Regeln aus 7.2; keine exklusive Arbeitsvergabe. |

Netzfehler können ein unbekanntes Ergebnis hinterlassen. Ein Client fragt mit derselben Request-ID nach und
startet bei Unsicherheit keine neue Mutation. Dauerhaft verlorener Storage ist im Modus expand Datenverlust.

## 3. Zielarchitektur

```
   Handy        Desktop/CLI      Browser
     │              │               │ (WebSocket/TLS)
     │              │          ┌────▼─────┐
     │              │          │ Gateway  │  (auf einem Host)
     │              │          └────┬─────┘
 ════╪══════════════╪═══════════════╪═══════════ NetBird-Overlay (WireGuard, ACL-Gruppen) ═══
     │              │               │
     ▼              ▼               ▼
 ┌──────────────────────────────────────────┐      ┌───────────────────┐
 │ Koordinator-Host                         │      │ Host B            │
 │  space-gate (TCP, nur Overlay-IP)        │      │  space-gate       │
 │  pi-serverd                              │◄────►│  pi-serverd       │
 │   ├ Control Space (primary)              │      │   ├ Control-Replik│
 │   ├ Router-Worker (FederatedSpace,       │      │   ├ Data Space B  │
 │   │   Replikatoren, Kommandos)           │      │   └ Agenten       │
 │   ├ Data Space A                         │      └───────────────────┘
 │   └ Agenten                              │               ▲
 └──────────────────────────────────────────┘               │ … weitere Hosts
                    ▲
          NetBird Management/Signal/Relay (selbst gehostet, öffentliche VM)
```

- Agenten benutzen die Tools wie heute. Mit dem Parameter `space` (Member- oder Federation-Name) gehen Operationen
  über `RemoteSpace` bzw. `FederatedSpace`.
- Clients halten keinen zentralen Betriebszustand. Host-Worker laufen ohne verbundenes Dashboard weiter.
  Clients müssen eigene Request-IDs bis zum Abschluss behalten; extern gestartete Arbeit braucht eigene Recovery.
- Jeder Host betreibt zusätzlich den Supervisor und einen lokalen Recovery Space. Router-Journal und RPC-Claims
  liegen in internen dauerhaften Dokumenten; Agenten-Nutzdaten werden nicht als Control-Entries abgelegt.

## 4. Netz und Vertrauen

### 4.1 NetBird als Netzschicht

Geplant ist ein selbst gehostetes Deployment auf einer Linux-VM mit Domain und Docker Compose. Konkrete
Ressourcen, Ports und Benutzerverwaltung werden für die ausgewählte Version vor Stufe 1b verifiziert (4.5).

| Aufgabe | Wer erledigt sie |
|---|---|
| Schlüsselpaare, Austausch der Public Keys, Rotation | NetBird (jeder Peer erzeugt seinen WireGuard-Schlüssel; Management verteilt nur Public Keys) |
| Verschlüsselung | WireGuard |
| Erreichbarkeit hinter NAT/Mobilfunk | NetBird (ICE/STUN direkt, sonst Relay) |
| Beitritt Server/Hosts | Setup-Key (unbeaufsichtigt, bei der Provisionierung) |
| Beitritt Handy/Desktop | Login über NetBird (lokale Benutzer oder SSO) |
| Netz-ACLs | NetBird-Policies über Gruppen |
| Rechte im Space | **pi-spaces** (4.3), nicht NetBird |

Gruppen und Policies (Vorschlag):

| Gruppe | Mitglieder | darf erreichen |
|---|---|---|
| `space-hosts` | alle Hosts | `space-hosts` auf Space-Port (Host-zu-Host) |
| `space-admin` | Handy, Admin-Desktop | `space-hosts` auf Space-Port + SSH |
| `space-observer` | Dashboards | Koordinator auf Space-Port |

Auf dem Handy läuft die NetBird-App als System-VPN; die eingebettete Node-Runtime erreicht Overlay-IPs ohne eigene
Installation. Einschränkung: Android erlaubt nur ein aktives VPN.

### 4.2 `space-gate`: Eintrittspunkt pro Host

- TCP nur auf der Overlay-IP; der interne Unix-Socket bleibt `0600`.
- Das Gate authentifiziert die Verbindung und übergibt einen vom Client nicht überschreibbaren Kontext an
  pi-serverd. Der Server akzeptiert diesen Kontext genau einmal beim Verbindungsaufbau. Das öffentliche `hello`
  handelt nur Protokollmerkmale aus; es kann keine Identität oder Rolle setzen.
- Die Integration benötigt eine explizite Authentifizierungsgrenze in pi-serverd. Bloßes Voranstellen eines Frames
  mit anschließend ungeprüftem Durchreichen genügt nicht. Frame-Größe, Handshake-Zeit und Verbindungen sind begrenzt.
- Auf diesem Eingang ist nur `serviceId: space` erlaubt. `sessions`/`chat` bleiben gesperrt, bis eigene
  Autorisierungsregeln implementiert und getestet sind.
- Lokale Prozesse desselben Users bleiben innerhalb der Vertrauensgrenze (direkter Storage-Zugriff).
- `pi-client` erhält eine TCP-Transport-Factory. Kompatibilität des vorhandenen Byte-/CBOR-Transports wird vor
  Umsetzung geprüft; Browser verwenden den Gateway aus Abschnitt 10.

### 4.3 Identität, Delegation und Widerruf

| Schicht | Vertrag |
|---|---|
| A: Overlay | Quell-IP wird über Management auf unveränderliche Peer-ID und Gruppen abgebildet; Cache maximal 60 s. |
| B: App | Ed25519-Challenge mit frischer Einmal-Nonce, kurzer Gültigkeit und Bindung an Gate-ID, Protokoll und Verbindung. |

Schicht B ist für Control Space, Admin, Router, Gateway, Replikation und delegierende Hosts Pflicht. Direkte
Data-Space-Clients dürfen nur mit A arbeiten, wenn eine explizite Peer-/Gruppenregel `member` oder `observer`
zuweist. Ohne Regel kein Zugriff. Gruppen- und App-Rechte werden geschnitten, nie vereinigt.

Benutzerrollen sind `admin`, `member`, `observer`; Dienstrollen `host`, `router`, `replicator`, `supervisor`
werden explizit mit erlaubten Spaces und Operationen vergeben. Ein Host ist dadurch kein Admin.

Ein registrierter Host darf lokale Agenten nur innerhalb seines eigenen Principal-Namensraums ausweisen.
Der Router darf diese Identität mit signiertem, kurzlebigem Delegationsnachweis weiterreichen: Aussteller,
ursprünglicher Principal, Ziel-Space, erlaubte Operation, Request-ID und Ablauf sind gebunden. Der Member prüft
Aussteller und Scope. Gateway-Benutzer bleiben getrennte Principals. Quoten zählen delegierten Principal und
Transport-Peer; frei übergebene `owner`-Felder werden bei normalen Writes ignoriert.

Autorisierung wird bei jedem Request und vor dem entscheidenden Commit geprüft. Grants sind höchstens 60 s gültig;
Invalidierungen schließen Sessions und beenden offene Polls früher. Ohne rechtzeitig erneuerten, autoritativen
Grant werden neue und noch nicht entschiedene Operationen abgewiesen. Replikate dürfen keine frischen Grants aus
beliebig altem Zustand ausstellen. Bereits bestätigte Arbeit wird durch Widerruf nicht rückgängig gemacht.

Damit gilt **Widerruf innerhalb der Grant-Laufzeit plus festgelegter Zeitunsicherheit**, nicht sofort unter jeder
Partition. Recovery benötigt einen gesondert lokal provisionierten Admin-Schlüssel (5.2), dessen Widerruf auf
jedem Recovery-Host separat bestätigt werden muss. Schlüsselablage und Ed25519-Unterstützung des Android-Keystores
sind vor Stufe 1b praktisch zu prüfen; Desktop-Schlüsseldateien erhalten `0600`.

### 4.4 Pairing eines neuen Clients

1. Gerät tritt dem Overlay bei; ein Admin weist die zulässige Gruppe zu.
2. Admin erstellt `Enroll` mit Token-Hash, Rolle, erlaubter Peer-ID und Ablauf nach 5 min. QR enthält Endpunkt,
   Control-Space-ID und ein zufälliges Token mit mindestens 128 Bit Entropie. Das Klartext-Token wird nicht geloggt.
3. Ungepaarte Peers dürfen ausschließlich `EnrollRequest` schreiben und ihr eigenes Enrollment-Ergebnis lesen.
   Sie dürfen weder Tokens auflisten noch Control-Daten lesen, abonnieren oder nehmen. Diese Ausnahme ist Teil
   der Autorisierung, kein allgemeiner Control-Zugriff.
4. Der bereits in Stufe 1b laufende Supervisor prüft Token, Peer-Bindung und Besitz des neuen Schlüssels durch
   Challenge. Tokenverbrauch und Anlage von `PeerKey` erfolgen atomar am Control-Primary; Retry ist dedupliziert.
5. Manuelle Eingabe verwendet denselben starken Token. Ein tatsächlich kurzer Code erfordert zusätzlich ein
   getrenntes Verfahren mit Versuchslimit und Admin-Bestätigung; das ist nicht Teil des v1-Pairings.

Bootstrap: Der erste Host legt den Control Space und einmalig einen Bootstrap-Token an. Der lokale Supervisor
bearbeitet ihn auch ohne Router. Provisionierung weiterer Hosts verwendet gebundene Einmal-Tokens und vergibt
nur die Dienstrolle `host`. Neue Hosts werden erst nach `addMember` Routingziele.

### 4.5 Ausfall und Betrieb von NetBird

Management-, Signal- und Relay-Ausfälle werden vor Stufe 1b getrennt getestet: bestehende direkte/relayed
Verbindungen, Neuverbindung, Peer-Auflösung und Widerruf. Lokaler Storage bleibt erhalten, die Verfügbarkeit
remote ausgeführter Operationen hängt aber von Transport und gültigen Auth-Grants ab. Nach Ablauf des Caches
wird ohne autoritative Erneuerung geschlossen abgewiesen; lokale Wartung und Lease-Ablauf laufen weiter.

Version, Portbedarf, Benutzerverwaltung, Lizenz der konkret eingesetzten Komponenten und Upgrade-/Backup-Pfad
werden vor Deployment anhand der offiziellen Dokumentation geprüft. Die Angaben in 4.1 sind Planungsannahmen.

## 5. Control Space und Router

Die normale Steuerung verwendet geschützte Entries. Der lokale Recovery Space ist ein gesonderter, bereits vor
Router-Start erreichbarer Steuerpfad und bleibt auch bei ausgefallenem Control-Primary beschreibbar.

| Typ | Schreibt | Inhalt / Wirkung |
|---|---|---|
| `Member` | Router nach Admin-Command | Identitäten, Endpunkte, Aufnahmezustand und festgelegte Routingzuordnung |
| `FederationPolicy` | Router nach Admin-Command | validierte Policy mit `policyVersion` |
| `PeerKey` | Supervisor nach Enrollment/Admin-Änderung | Principal, Schlüssel, Rollen und Scope |
| `Enroll` / `EnrollRequest` | admin / eingeschränkter neuer Peer | Pairing nach 4.4 |
| `Command` | admin | `{id, op: setLimits / drain / addMember / removeMember / setPolicy, args}` |
| `Result` | Router | `{commandId, state, error?}` |
| `MemberStatus` | Router | Erreichbarkeit, Revision, Lag, freie Kapazität; Lease 30 s |
| `Capability` | authentifizierter Host für sich selbst | Werkzeuge, Modelle, Ressourcen; Lease 2 min |
| `RecoveryRequest` / `RecoveryResult` | Recovery-Admin / Supervisor | nur lokaler Recovery Space; Promotion nach 5.2 |

### 5.1 Kommandos und dauerhafter Router-Zustand

Command-Verarbeitung ist eine dauerhafte Zustandsmaschine: `accepted → applying → completed/failed`.
Vor jeder entfernten Wirkung werden Ziel, Argument-Hash und stabile Unterrequest-ID gespeichert. Das Ziel
speichert Wirkung und Deduplizierung atomar; nach einem Absturz wird derselbe Unterrequest abgefragt/wiederholt.
Ein lokales `Result` allein schließt das Fenster zwischen entfernter Wirkung und Ergebnis-Commit nicht.
Operationen ohne idempotentes Zielprotokoll sind als solche nicht zulässige Commands.

Der Router startet nach Neustart erst Recovery offener Commands und Requests, dann neue Arbeit. Vor abgeschlossener
Recovery ist sein Status `recovering`. Journal und Deduplizierung unterliegen demselben Schutz und, bei HA,
derselben synchronen Replikation wie der Control Space. Das interne Journal kann begrenzte Ergebnisdaten enthalten;
seine Bytes werden getrennt budgetiert. Mailbox-ACKs erfolgen erst nach dauerhafter Übernahme des Events.

### 5.2 Manuelle, abgesicherte Promotion in v1

Es gibt **keine automatische Wahl bei bloßem Timeout**. Pro logischem primary-Space ist ein konkreter Standby
festgelegt. Der Supervisor läuft auf beiden Hosts unabhängig vom Router.

1. Recovery-Admin schreibt einen signierten Request in den Recovery Space des festgelegten Standbys, mit
   erwarteter Epoche, Ziel und eindeutiger Recovery-ID. Ein lokal provisionierter Schlüssel ermöglicht dies
   unabhängig vom ausgefallenen Control Space.
2. Der bisherige Primary einschließlich Router wird nachweislich gestoppt und gegen automatischen Neustart
   gesperrt, etwa durch einen kontrollierten Infrastruktur-Fencing-Mechanismus. Ein Netzwerk-Timeout oder eine
   bloße Admin-Behauptung genügt nicht. Ohne überprüfbaren Nachweis verweigert der Supervisor die Promotion.
3. Nur der festgelegte synchrone Standby darf regulär übernehmen. Er prüft seine persistente Historie und den
   Replikationsvertrag aus 7.2. Fehlende oder beschädigte Historie führt zum Abbruch.
4. Supervisor erhöht die Epoche atomar, aktiviert den Space und startet gegebenenfalls den Router in Recovery.
   Mutierende Requests einschließlich Txn/Lease/Command tragen die Epoche; bekannte alte Epochen werden abgewiesen.
5. Der alte Host darf erst nach Rejoin und vollständiger Synchronisierung als Replikat starten. Seine alte
   Primary-Berechtigung darf ein Prozessneustart nicht wiederherstellen.

Das sichere Abschalten schützt während einer Partition; die Epoche schützt nach Wiederverbindung vor alten
Requests. Gleichzeitige Promotions werden durch genau einen zulässigen Standby und lokale atomare Prüfung
verhindert. Ein Wechsel des Standbys benötigt einen geplanten Stopp der Writes und eine synchronisierte Übergabe.
Für erneute Ausfallsicherheit muss nach Promotion zunächst ein neuer synchroner Standby eingerichtet werden.
Ein expliziter Single-Host-Betrieb kann anschließend separat aktiviert werden, besitzt dann keine HA-Garantie.

Der konkrete Fencing-Adapter ist eine Pflichtentscheidung vor Stufe 3. Ohne ihn bleibt das Replikat Lesekopie.
Quorum-basierte automatische HA ist ein späterer Entwurf und wird durch eine bloße Epoche nicht ersetzt.

## 6. Bausteine

### 6.1 Core-Erweiterungen (pi-spaces, Doc-Version 5)

1. **Revision**: jede dauerhafte Zustandsänderung erhöht `rev` einmal pro Commit. Ein Batch enthält alle Deltas
   dieses Commits atomar; Cursor stehen nur zwischen Batches. Stream-ID enthält Space, Historien-Inkarnation und
   bei primary die Epoche. Revisionen verschiedener Streams sind nicht vergleichbar.
2. **Zwei Replikationszwecke**: der autorisierte Entry-Strom enthält Put/Delete, Lease-Änderungen und deren
   Konfliktmetadaten. Primary-Replikation benötigt zusätzlich Txns, Sperren, Waiter, Mailbox, RPC-Claims und
   interne Router-Dokumente in einer atomaren Commit-Historie. Ein Strom nur sichtbarer Entries genügt dafür nicht.
   Anwendung auf Replikaten löst keine zweite lokale Geschäftsoperation oder Event-Erzeugung aus.
3. **Snapshot**: `readAll` erstellt einen unveränderlichen Snapshot mit Token, Stream-ID und Revision R. Alle
   Seiten gehören zu R. Danach beginnt `changes` strikt nach R. Snapshot und benötigte Folge-Batches werden
   begrenzt vorgehalten; bei Ablauf/Lücke muss der Client neu beginnen. Replikations-Snapshots umfassen den zum
   Modus gehörenden Gesamtzustand, einschließlich Tombstones und Deduplizierung. Installation erfolgt atomar.
4. **Identitäten**: `hostId`, `spaceId`, `replicaId`, Historien-Inkarnation; `view()` liefert `gid`.
5. **Peer-Ziele**: strukturierte Principals und Consumer-Mailboxes neben lokalen Conversations. Events bleiben
   bis ACK/TTL dauerhaft. Ein abgelaufener Take-Txn wird freigegeben; ein später zugestelltes Event verleiht keine
   neue Reservierung. Empfänger prüfen Txn-Zustand vor Bearbeitung.
6. **Rechte**: zentraler Check für jede Operation und jeden betroffenen Typ einschließlich Supertypen,
   Lease-Manipulation, Take, Snapshot und Stream (Abschnitt 9). Host-Zugriff ist am Remote-Eingang nicht quotenfrei.
7. **Schlüssel**: pro lww-Typ Pflicht, kanonische Kodierung von `type + keyFields`; fehlende Felder werden
   abgewiesen. Upsert nur bei explizit deklarierter Semantik. Upsert-Konflikte mit aktiven Txns werden abgewiesen.
8. **Vorbedingungen**: ID-Templates (B1), Gesamtbytes (L7), Cursor (L13), Meter pro Space (L11).

### 6.2 Dienst `space` in pi-serverd

Jeder Aufruf nennt die stabile Space-ID; Aliasauflösung erfolgt vor Request-Erstellung. JSON-Argumente werden
validiert. Mutationen tragen `requestId`, Request-Generation und, bei primary, Epoche. Relative Operationszeiten
werden beim ersten angenommenen Aufruf einmalig in eine serverseitige Deadline übersetzt.

| Methode | Wesentliche Argumente | Antwort |
|---|---|---|
| `hello` | Protokollversion, benötigte Features | IDs, Epoche, Limits, Rolle, unterstützte Features |
| `write` | Entry, Lease, Txn?, Request | Entry-ID und Lease |
| `read` / `take` | Template, Gesamt-Timeout, `ifExists?`, Txn?, Request | `pending` oder dauerhaftes `done(entry/null)` |
| `pollOperation` | Request, `waitMs ≤ 25000` | derselbe Operationszustand |
| `readAll` | Template, Snapshot-Token?, Cursor?, Limit | Entries, Next, Token, Stream-ID, Snapshot-Revision |
| `count` / `stats` | Template? | Wert plus Revision; föderiert zusätzlich Vollständigkeit |
| `txn` / `lease` | Aktion, ID?, Dauer?, Request | Zustand/Lease/Ergebnis |
| `wait` / `notify` | Template, Laufzeiten, Consumer, Handback, Request | Wait-/Registrierungs-ID, Lease |
| `cancelOperation` | Zielrequest, eigener Request | dauerhaftes Cancel-Ergebnis oder bereits entschiedener Zustand |
| `events` | Mailbox-ID, Epoche, Cursor, `waitMs ≤ 25000` | Events, Next oder explizite Lücke |
| `ack` | Mailbox-ID, Epoche, `upTo` | idempotentes Ergebnis |
| `changes` | Stream-ID, `afterRev`, `waitMs ≤ 25000`, Byte-Limit | vollständige Commit-Batches oder `resync` |

**RPC-Claims:** Schlüssel `(Principal, spaceId, requestGeneration, requestId)`, dazu Methode, kanonischer
Argument-Hash, einmalige Deadline und `pending/done/cancelled`. Abweichende Wiederverwendung ist
`RequestConflict`. Registrierung eines Pending-Requests sowie endgültige Entscheidung werden dauerhaft
serialisiert; Operation und Endergebnis liegen im selben Commit. Ein erfolgreicher Retry darf das gespeicherte
Ergebnis erneut liefern, führt die Mutation aber nicht erneut aus.

Die Transportwartezeit von 25 s beendet nur den Poll. Sie erzeugt keinen fachlichen Miss und verlängert keine
Gesamt-Deadline. `null` ist endgültig, sobald die Operation nach ihrer Semantik erfolglos beendet ist. Ein neuer
fachlicher Versuch erhält eine neue ID. Dies erhält auch die besondere `ifExists`-Semantik.

**Aufbewahrung:** abgeschlossene Ergebnisse bleiben mindestens 24 h; Pending-Operationen werden nicht allein
wegen dieses Fensters gelöscht. Request-Generationen haben eine serverseitig signierte, feste Zulassungsfrist.
Nach deren Ablauf werden darin unbekannte IDs mit `RequestExpired` abgewiesen, auch nach Claim-Bereinigung;
noch vorhandene Ergebnisse bleiben abfragbar. Alte unbekannte Requests werden niemals als neue Writes behandelt.
Die Generation ist an Principal/Space gebunden. Ein unbekanntes Ergebnis nach Ablauf erfordert fachliche Klärung.

**Mailbox:** ACK nur für den authentifizierten Consumer, passende Epoche und bereits ausgelieferte Sequenzen.
Ein Consumer verarbeitet geordnet oder quittiert nur den zusammenhängend übernommenen Präfix. Alte ACKs können
nach Reset keine neuen Events löschen. TTL-Verlust wird als Lücke gemeldet; Dashboard lädt Snapshot, Worker
rekonstruiert offene Operationen aus dem Journal. ACK bestätigt Transportübernahme, keinen Take-Commit.

**Rückstau:** getrennte Byte-/Anzahllimits für Entries, Claims, Journal, Mailbox, Snapshots und Stream; maximale
Pending-Operationen pro Principal und Transport-Peer. Platz für Ergebnis/Claim wird vor Mutation reserviert.
Überlast liefert `ResourceExhausted` vor Annahme. Ungeklärte Mutationen/Claims dürfen nicht still verworfen werden.
Stream-Verdrängung erzwingt Resync; abgelaufene Snapshots `SnapshotExpired`. Mailbox standardmäßig höchstens
7 Tage, zusätzlich Byte-Limit; bei Erreichen Annahme betroffener neuer Operationen stoppen, statt aktive
Take-Ergebnisse zu verlieren. Replikationsrückstau blockiert synchrone Writes. Rate-Limits gelten auch für
Enrollment, Reads, Polls, Txns und ACKs; Streams sind privilegiert.

### 6.3 `RemoteSpace` (Client)

Gemeinsames `SpaceLike`-Interface mit expliziten Capability-Flags für Modusgrenzen. `RemoteSpace` hält Request-ID
und Argumente bis zum Abschluss, wiederholt Transportversuche und pollt dieselbe logische Operation. Es verlängert
keine Deadline automatisch. Unbekannter Ausgang wird als solcher ausgegeben. Browser verwenden den Gateway.

### 6.4 `FederatedSpace` (im Router)

Policy ist eine validierte Vereinigung zulässiger Regeln; unpassende Feldkombinationen werden abgewiesen:

```ts
type Rule =
  | { type: string; mode: "local"; member: string }
  | { type: string; mode: "expand"; members: string[];
      by: "type" | { field: string } | "capacity" | "capability" }
  | { type: string; mode: "sync"; variant: "primary"; member: string;
      primaryReplica: string; standbyReplica?: string; durability: "single" | "sync" }
  | { type: string; mode: "sync"; variant: "lww"; members: string[]; keyFields: string[] }
  | { type: string; mode: "sync"; variant: "set"; members: string[] };
type Policy = {
  policyVersion: number;
  rules: Rule[];
  default: { mode: "local"; member: string };
};
```

Primary-Epochen werden separat pro logischem Space geführt. In v1 umfasst primary den ganzen Member einschließlich
seiner internen Dokumente; alle Typregeln dieses Members müssen dieselbe Replikatkonfiguration haben. lww/set
laufen auf anderen Members. Control-Daten einschließlich Capability bleiben dadurch einheitlich primary.
Pro Typ genau eine Regel; Supertypen in Suchtemplates erweitern die Suche auf alle betroffenen Regeln.
`local` meint den explizit benannten Member, niemals implizit den Host des Clients oder Routers.

Agenten mit `space: fed` sprechen mit dem Router; direkte Member-Zugriffe müssen dieselben Modus-, Rechte- und
Routinggrenzen prüfen. Verwaltete expand-Typen dürfen außerhalb des zuständigen Members nicht direkt geschrieben
werden. Regeländerungen unterliegen 7.1.

**Router-Journal:** vor dem ersten Remote-Aufruf persistiert der Router logischen Request, Principal, Policy-Version,
gewählte Ziele, Unterrequest-IDs und Deadline. Eine einmal begonnene Operation wechselt bei Timeout weder Member
noch Policy. Entfernte Ergebnisse werden dauerhaft übernommen, bevor Client-Antwort oder Event-ACK erfolgt.

Beim Waiter-Wettlauf werden alle Registrierungs-IDs und pro Versuch eine Generation gespeichert. Die erste noch
aktive Reservierung wird atomar als Gewinner vermerkt; Verlierer werden storniert/abgebrochen, auch wenn Events
später eintreffen. Replay derselben Events verändert den Gewinner nicht. Ohne Nutzer-Txn committet der Router die
Gewinner-Txn mit stabiler Unterrequest-ID und speichert das Ergebnis. Mit expliziter Nutzer-Txn wird ausschließlich
auf deren Member gearbeitet; `space_wait` darf eine neue reservierende Txn zurückgeben, deren Owner/Proxy-Rechte
explizit dem ursprünglichen Principal zugeordnet sind. Kein fremder Agent kann sie committen.

Nach Neustart rekonstruiert der Router offene Zustände über dieselben Unterrequests. Ist ein Gewinner vor Commit
abgelaufen, wird dieser Versuch als abgelaufen protokolliert; ein weiterer Versuch ist nur innerhalb derselben
noch offenen logischen Operation zulässig. Ein unklarer Commit wird zunächst aufgelöst, niemals durch Auswahl
eines zweiten Gewinners ersetzt. Ein zurückgeliefertes Ergebnis mit Txn enthält deren aktuellen Gültigkeitsstatus.

## 7. Modi

### 7.1 expand (verteilen)

- **write**: Typ → fester Member; Feld → HRW über die festgelegte Member-Menge; capacity/capability → Auswahl
  vor dem ersten Versuch und dauerhafte Bindung im Journal. Veraltete Kapazitätsdaten können zu einer Ablehnung
  führen, nicht zu einer stillen zweiten Platzierung. Neuplanung nur nach eindeutig abgewiesenem Versuch.
- **read**: erster Treffer; Miss erst nach Miss aller relevanten Members. Bei Ausfall ohne Treffer `Unavailable`
  statt `null`. `readAll`/`count` liefern standardmäßig Fehler bei fehlenden Members; explizit erlaubte Teilergebnisse
  enthalten `complete: false`, fehlende Members und Revision pro Member. Es gibt keinen globalen Snapshot.
- **take ohne Warten**: sequenzielle Member-Suche; bei unbekanntem Ausgang eines Takes erst diesen auflösen.
  Erst ein bestätigter Miss erlaubt den nächsten Member. Ergebnis und Suchfortschritt sind journalisiert.
- **wartender Take**: Wettlauf reservierender Txns nach 6.4; freigegebene Verlierer dürfen erneut reserviert werden.
- **Transaktionen**: vor Beginn explizit an Member gebunden; alle Reads/Takes/Writes bleiben dort. Ein Write,
  dessen Regel einen anderen Member verlangt, wird mit `RoutingConflict` abgewiesen. Keine stillen Fehlplatzierungen.
- **Ausfall**: Bestand vorübergehend nicht erreichbar; bei dauerhaft verlorenem Storage ohne Backup verloren.

**Membership und Policy:** In v1 sind HRW-Menge, Schlüsselfeld und feste Typzuordnung für einen vorhandenen Bestand
unveränderlich. `addMember` registriert Hosts und erlaubt neue, leere Partitionen/Regeln; es ändert keine bestehende
Hash-Zuordnung. Entfernen eines Members erfordert nachgewiesene Leerung einschließlich offener Operationen.
`drain` stoppt neue Platzierungen, bestehende Requests und Reads behalten ihre Ziele. Bei capacity/capability
bleiben frühere Datenstandorte bis zur Leerung Teil der Suchmenge.

Automatische Migration ist ein späteres Feature mit versionierten Routingtabellen, dauerhaftem Transferjournal,
Übergangslesen und klarer Eigentumsübergabe. `take A → write B → commit B → commit A` allein ist kein sicheres
Migrationsverfahren. Bis dahin werden Änderungen mit Migrationsbedarf abgewiesen.

### 7.2 sync (spiegeln)

| Variante | Anwendung | Partition / Garantie |
|---|---|---|
| primary / sync | Control Space, Jobs | Ein aktiver Primary; Writes blockieren ohne festen Standby; manuelle Übernahme nach 5.2. |
| primary / single | Einzelhost mit optionalem asynchronem Backup | Lokal atomar; keine verlustfreie Failover-Garantie. |
| lww | Zustand mit Schlüssel | Beide Seiten schreibbar; deterministische Konvergenz einschließlich versionierter Löschungen. |
| set | Fakten/Beobachtungen | Observed-Remove-Set mit Add-Wins bei konkurrierendem Add; keine exklusive Jobvergabe. |

**primary:** der feste Standby übernimmt die komplette geordnete Commit-Historie einschließlich RPC-Ergebnissen,
Txns und Router-Journal. Im synchronen Modus wird ein Commit erst sichtbar und beantwortet, nachdem der Standby
seinen vollständigen Batch dauerhaft angenommen hat und der Primary lokal angewendet hat. Vor dem Senden
  persistiert der Primary Batch und Pending-Zustand; nach Neustart klärt er diesen mit dem festen Standby, bevor
  weitere Mutationen zugelassen werden. Ein auf dem Standby
dauerhaft angenommener Batch gilt bei Recovery als entschieden, auch wenn die Antwort verloren ging. Ein Primary
mit unklarem Replikationsausgang löst diesen vor weiterer Arbeit auf. Replikate geben nur vollständige angewendete
Batches als veraltbar gekennzeichnete Reads aus; konsistente Reads und Takes gehen zum Primary.

Kein stiller Rückfall auf asynchronen Betrieb. Der Standby wird über Snapshot plus anschließenden Stream zunächst
synchronisiert und erst dann als fester Partner aktiviert. Beide Seiten prüfen Epoche und Replikatidentität.
Standby-Wechsel erfolgen bei pausierten Writes mit atomarer Konfigurationsaktivierung auf den beteiligten Hosts;
bei unklarer Übergabe bleibt der Betrieb gesperrt. Nach Promotion ohne neuen Standby bleiben synchrone Writes
gesperrt. Alte Requests behalten ihren Deduplizierungsschlüssel über die Promotion hinweg.

**Entry-Replikation für lww/set:** jede Änderung hat eine unveränderliche ID
`(originReplicaId, incarnation, sequence)`. Weiterleitung erhält ID, Owner und Konfliktmetadaten; sie erzeugt
keine neue Änderung. Dedup-/Kausalzustand wird dauerhaft gespeichert und beim Snapshot übertragen. Replikatoren
haben einen eng begrenzten Importpfad; gewöhnliche Host-Writes können diese Metadaten nicht fälschen.

**lww:** pro Schlüssel gewinnt lexikografisch `(hlc.physical, hlc.logical, replicaId)`. HLC-Zustand bleibt über
Neustarts erhalten und wird beim Empfang fortgeschrieben. Delete ist ein gleichberechtigter versionierter
Tombstone; ältere Puts werden nicht wieder sichtbar. Ein erneutes bewusstes Write benötigt eine neue Version.
HLC garantiert Ordnung, nicht die physikalisch neueste Messung. `asOf` bleibt separate Fachdateninformation.
Unplausibel weit zukünftige Uhren werden mit konfigurierter Grenze abgewiesen und diagnostiziert.

**set:** jedes Add erzeugt einen eindeutigen Tag. Remove/Take entfernt nur die beobachteten Tags; konkurrierende,
noch unbekannte Adds bleiben bestehen (Add-Wins). Take ist hier eine beobachtete Entfernung, keine exklusive
Reservierung; `SpaceLike` weist exklusive Txns für solche Regeln ab. Logs verwenden vorzugsweise append-only.

**Leases:** für lww/set wird Ablauf als unveränderliche, mit der Version verbundene Origin-Deadline übertragen.
Replays/Weiterleitung erneuern die Lease nicht; Renewal erzeugt eine neue Version. Es gilt eine konfigurierte
maximale Uhrunsicherheit; Ablauf kann innerhalb dieses Fensters verschieden sichtbar sein. Bei überschrittener
Unsicherheit werden neue zeitkritische Operationen gesperrt. Natürlicher Ablauf versteckt nur die betroffene
Version bzw. den Tag und darf keine neuere Erneuerung löschen. Primary übernimmt bestehende Deadlines unverändert;
bei Promotion werden Zeitunsicherheit und bereits abgelaufene Txns vor neuer Vergabe geprüft. Lease-Ablauf stoppt
keinen extern weiterlaufenden Worker: dessen Wirkungsziel braucht Idempotenz oder Fencing.

**Tombstones und Offline-Replikate:** v1 behält Konflikt-/Remove-Metadaten dauerhaft innerhalb eines eigenen
Budgets; bei Erreichen werden neue Änderungen abgewiesen. Keine zeitbasierte, unsichere Bereinigung.
Spätere Kompaktierung setzt bestätigten gemeinsamen Kausalstand aller aktiven Replikate voraus. Dauerhaft entfernte
Replikate dürfen nur nach vollständigem Neuaufbau mit neuer Inkarnation wieder teilnehmen; alte Offline-Änderungen
werden dann nicht automatisch eingespielt. Snapshot/Resync folgt 6.1 und umfasst diese Metadaten.

### 7.3 RAID-10-Fall

expand nach Feld, pro Partition primary + Replikat. Erst nach stabilen 7.1 und 7.2.

### 7.4 Bewusste Grenzen

- Kein globales FIFO, keine globale Reihenfolge.
- Keine Transaktionen über Members (kein 2PC).
- Garantien gelten nur im Umfang aus 2.1; externe Wirkungen sind nicht allgemein exactly-once.
- Keine automatische Primary-Wahl und keine automatische Migration in v1.
- `count`/`readAll` über eine Federation sind Momentaufnahmen ohne globale Konsistenz.

## 8. Verzeichnis und Selbsterweiterung

- Jeder Host schreibt `Capability` in seinen Data Space und in den Control Space (Lease 2 min, Heartbeat 1 min);
  der Control Space repliziert sie mit seiner einheitlichen primary-Historie. Nur der zugeordnete Host darf
  seine Capability erneuern; der Server prüft `memberId` gegen den Principal.
- Agenten finden Hosts mit `space_list {type: "Capability", fields: {gpu: true}}` und adressieren sie mit `space`.
- Ein neuer Host erscheint automatisch, sobald er provisioniert ist (4.4) und seine Capability schreibt; der admin
  bestätigt ihn per `Command addMember`.
- „Arbeit folgt Fähigkeit“: `Job {needs: "browser"}` mit Regel `by: capability` landet auf einem passenden Member;
  fehlt einer, antwortet v1 mit `NoCapableMember` ohne Write. Der Aufrufer kann später einen neuen Versuch
  starten. Eine dauerhaft geparkte Dispatch-Warteschlange mit erneuter Planung wäre ein separates Feature.

## 9. Sicherheit und Berechtigungen

NetBird begrenzt Erreichbarkeit; die Space-Autorisierung gilt zusätzlich für jeden RPC, jedes Poll-Ergebnis und
jede Mutation. Unbekannte Rollen/Typen/Operationen werden geschlossen abgewiesen.

| Principal | Erlaubt | Zusätzliche Grenzen |
|---|---|---|
| observer | freigegebene Daten und Status lesen/abonnieren | kein Take, Write, Lease-Eingriff oder interner Stream |
| member | normale Data-Entries lesen/schreiben/nehmen; eigene Txns/Leases | keine Steuerdatenmutation; Peer-/Agent-Quoten |
| admin | Commands, Enrollment, freigegebene Steuerdaten lesen | Änderungen über validierte Commands; kein freies Überschreiben interner Claims |
| host | eigene Capability melden, lokale Agenten delegieren | nur eigener Namensraum und zugewiesene Spaces |
| router | Commands verarbeiten und gebundene Requests delegieren | geprüfter Scope, geschütztes Journal |
| replicator | autorisierte Replikations-Snapshots/Streams importieren | nur zugewiesene Quelle/Ziel/Modus; keine beliebigen Host-Writes |
| supervisor | Enrollment/Recovery verarbeiten | nur vorgesehene atomare Zustandsübergänge |
| ungepaarter Peer | eigenes Enrollment nach 4.4 | kein allgemeines Lesen/Listen/Take/Notify |

Geschützte Typen sind auch gegen Take, Lease-Cancel/-Renew und Mutation über Txns geschützt. Templates mit
Supertypen oder ohne Typ umgehen die Prüfung nicht. Lesen/Listen/Notify filtern nach expliziten Leserechten;
Replikations-Streams bleiben Dienstrollen vorbehalten. Enroll-Hashes, Schlüsselverwaltung, Claims und Journale
werden nicht an gewöhnliche Member/Observer ausgeliefert. Fremde normale Data-Entries bleiben gemäß Space-Semantik
les-/nehmbar, sofern die Typ-ACL dies gestattet.

Inhalte anderer Hosts bleiben untrusted; verifizierte Herkunft ist keine Vertrauenszusage zum Inhalt.
`[data, not instructions]` bleibt. Widerruf folgt der begrenzten Grant-Laufzeit aus 4.3. Rate-/Byte-Limits gelten
auch für privilegierte Remote-Dienste, mit separaten Budgets. Audit protokolliert Principal, Operation und Ergebnis,
aber keine Tokens oder privaten Schlüssel.

## 10. Clients

Alle Clients sprechen dasselbe Space-Protokoll; es gibt keine client-spezifische API.

- **Handy (pi-termux-mobile)**:
  - `remoteState` wird zu einer Verbindungsliste (Map `hostId → RemoteConnection`, mit separater Space-/Replikat-Auflösung); Chat bleibt an eine Session
    gebunden.
  - Seite **Spaces** (`spaces.html`, eigene CSS-Datei, Endpunkte in `constants.js`): Members und Status, Policy-Editor,
    Statistik pro Member und summiert, Inhalte (`readAll`), Kommandos mit Ergebnis, Pairing (QR anzeigen/scannen).
  - Endpunkte (Vorschlag): `/api/spaces/{members,status,policy,command,result,list,entry,enroll,pair}`.
  - Long-Polls nur, solange die Seite sichtbar ist; das System braucht das Handy nicht.
- **Desktop / CLI**: Node-Paket `pi-spaces-client` (RemoteSpace + TCP-Transport + Pairing), z.B. `pi-spaces status`,
  `pi-spaces policy set …`, `pi-spaces pair`.
- **Browser**: Gateway auf einem Host übersetzt WebSocket/TLS auf das Space-Protokoll; Anmeldung per App-Schlüssel
  (WebCrypto-Unterstützung vorab prüfen). NetBird-SSO allein ersetzt keine App-Autorisierung. Das Gateway
  bindet Browser-Sessions an einzelne Principals, prüft Origin/CSRF und darf keine allgemeinen Host-Rechte
  weiterreichen. Umsetzung in Stufe 4.

## 11. Stufenplan

Jede Stufe implementiert ihre Voraussetzungen vor der Abnahme. Simulatorprüfungen ergänzen persistente Tests;
NetBird-, Plattform- und Fencing-Annahmen benötigen zusätzlich reale Integrationsnachweise.

### Stufe 0 – Bestehender Core

- B1–B3, L6, L7, L10; Interface `SpaceLike`; Einbindung in pi-serverd und server.mjs (L14).
- **Abnahme:** bestehende Suite und gezielte Regressionstests grün; lokale Worker koordinieren sich; Tests
  unterscheiden Reservierung, Commit und externe Wirkung.

### Stufe 1 – Benannte Spaces und lokales Protokoll

- Doc-Version 5 und Migration 4 → 5; IDs, Rechte-Grundmodell, pro Space Meter, Byte-Limits und Revisionen.
- RPC-Claims mit Generationen, dauerhafte Pending-Ops, Mailboxes/ACKs, Snapshot-Pagination und `RemoteSpace`.
- **Abnahme:** zwei Spaces auf einem Host ohne ID-Kollision; Take-Commit mit verlorener Antwort liefert nach
  Prozessneustart dasselbe Ergebnis ohne zweiten Take. Lange Polls, Claim-Ablauf, falsche Argumente und alte ACKs
  sind geprüft. Migrationsfixtures erhalten Entries, Txns und Outbox. Der lokale Unix-Zugang ist weiterhin eine
  lokale Vertrauensgrenze; SSH-Tunnel allein liefern keine differenzierte Peer-Identität.

### Stufe 1b – Overlay, Autorisierung und Enrollment

- Gate, Dienst-Allowlist, A/B-Authentifizierung, Delegation und vollständige Typ-/Operations-ACLs.
- Control Space zunächst single; Supervisor und Recovery Space; Enrollment ohne Router; starke Tokens.
- NetBird-Ausfalltests, Schlüsselablage auf Zielplattformen, begrenzter Widerruf und Grant-Ablauf.
- **Abnahme:** Handy/Desktop gepairt; ungepaarter Peer nur Enrollment; gefälschtes zweites Hello und fremde Dienste
  abgewiesen. Geschützte Typen weder nehmbar noch über Lease/Txn löschbar. Widerruf schließt Zugriff innerhalb
  der spezifizierten Grenze; nach Autoritätsausfall werden Grants nicht unbegrenzt verlängert.

### Stufe 2 – Router und expand

- Dauerhaftes Request-/Command-Journal und Recovery; feste Policy-Versionen; Regeln und Suchsemantik aus 7.1.
- Capability-Verzeichnis am Control-Primary; fehlende Fähigkeit gibt `NoCapableMember`.
- Handy-Seite mit Status, Policy und nachvollziehbaren Fehler-/Teilergebnissen.
- **Abnahme:** 1000 Jobs, 3 Members, 6 Worker: höchstens ein erfolgreicher destruktiver Commit je Entry, Retries
  verändern die Zielbindung nicht. Abstürze nach jeder Journal-/RPC-/ACK-Grenze auf persistentem Storage testen.
  Abort/Ablauf erlaubt Wiedervergabe. Ein Test-Wirkungsziel mit Idempotenzschlüssel zeigt eine fachliche Wirkung;
  ein Gegenbeispiel ohne diesen Schutz dokumentiert die Garantiegrenze. Unzulässige Routingänderungen scheitern.

### Stufe 3 – Replikation und kontrollierte Übernahme

- Zuerst Snapshot-/Stream-Import und lww/set-Merge inklusive Deletes, Leases, Deduplizierung und Offline-Rejoin.
- Danach vollständige primary-Commit-Historie, fester synchroner Standby und Supervisor-Recovery nach 5.2.
- Fencing-Adapter mit verifizierbarem Stop-/Neustartschutz; Control Space und Router-Journal gemeinsam sichern.
- **Abnahme:** 10-min-Partition mit konkurrierenden Writes/Deletes/Erneuerungen konvergiert nach Austausch;
  Snapshot unter parallelen Writes verliert keine Änderung. Ohne Standby werden synchrone Mutationen nicht
  bestätigt. Promotion ohne Fencing-Nachweis oder auf falschem Standby wird verweigert. Nach zulässiger Promotion
  bleiben bestätigte Ergebnisse erhalten; verlorene Antworten lassen sich dedupliziert auflösen. Alter Primary
  startet nicht selbstständig schreibend, alte Epochen werden nach Rejoin abgewiesen. Ohne neuen Standby bleibt
  sync-Schreibbetrieb gesperrt.

### Stufe 4 – Weitere Clients

- Desktop/CLI-Paket und optional Browser-Gateway mit getrennten Benutzeridentitäten.
- **Abnahme:** Steuerung ohne Handy; Wiederverbindung rekonstruiert Status per Snapshot/Events; keine
  Identitätsvermischung zwischen Browser-Sessions; Poll-Unterbrechung beeinflusst laufende Host-Worker nicht.

## 12. Teststrategie

- **Simulator:** mehrere Harnesses, deterministische Latenz, Verlust, Duplikate, Partitionen, Uhrsprünge und
  Neustarts. Gegenmodell für Reservierungen, Requestzustände und Merge-Regeln.
- **Persistenz:** echte Harness-Storage-Backends, Prozessabbruch/Reopen an Commit-, Replikations- und Antwortgrenzen.
  MemoryStorage allein ist kein Nachweis für Dauerhaftigkeit.
- **Invarianten:** höchstens eine aktive Reservierung und ein erfolgreicher destruktiver Commit pro Entry in
  expand/primary; Abort erlaubt erneutes Nehmen; pro gültigem Request ein Ergebnis; kein Zielwechsel bei unklarem
  Ausgang; vollständige Batches; keine Wiederbelebung durch alte Deletes/Puts; lww/set konvergieren nach Austausch.
- **Recovery:** Router nach Gewinnerwahl/Commit/ACK unterbrechen; verspätete Verlierer, abgelaufene Txns, verlorene
  Antworten, doppelte Commands, zwei Recovery-Versuche, Standby-Ausfall und alte Primary-Neustarts prüfen.
- **Zeit:** Lease-Ablauf macht Reservierungen beim nächsten Settle unbrauchbar, auch wenn der Reaper verzögert ist.
  Ein gestoppter Prozess garantiert keine aktive Bereinigung; vor Wiederaufnahme wird gesettelt. Worker-Wirkungen
  nach Lease-Ablauf separat mit Idempotenz/Fencing testen.
- **Routing:** HRW-Mengenänderung wird abgelehnt; neue leere Regeln funktionieren; drain erhält Suchbarkeit;
  Txn-Zielkonflikte und unzulässige direkte Writes scheitern. Teilantworten sind ausdrücklich markiert.
- **Sicherheit:** Rollen-/Operationsmatrix, Supertypen, Enrollment-Replay, Delegationsfälschung, Token-Limits,
  Stream-Zugriff, Widerruf bei Partition, alte Grants und Gateway-Principal-Trennung.
- **Integration:** zwei pi-serverd/Gates auf localhost mit Test-Identitätsadapter; danach echte NetBird-Umgebung
  und Zielplattformen. Simulator kann Overlay-Identität und Infrastruktur-Fencing nicht abnehmen.
- **Last:** 10 000 Entries, 3 Members, vollständige Dokumentbytes inklusive Claims/Stream/Tombstones; p95/p99
  Commit-/Poll-Latenz, Speicher, Journalwachstum, Replikationsrückstand und Verhalten bei jedem Budgetlimit.

## 13. Festgelegte Entscheidungen und verbleibende Gates

Für v1 festgelegt: expliziter lokaler Default-Member; manuelle Promotion nur nach überprüftem Fencing; genau ein
fester synchroner Standby pro HA-Space; keine Migration bestehender HRW-Bestände; starke Enrollment-Tokens;
kein allgemeines Exactly-once für externe Wirkungen; 24 h Mindestspeicherung abgeschlossener RPC-Ergebnisse;
Mailbox maximal 7 Tage plus Byte-Limit; Dienstdelegation und Admin-Zugriff immer mit App-Schlüssel.

Vor den jeweiligen Stufen noch festzulegen bzw. nachzuweisen:

1. Stets laufender Koordinator-Host und unabhängig erreichbarer Recovery-Zugang.
2. Konkreter Fencing-Adapter, überprüfbare Bestätigung und dauerhafter Neustartschutz (Gate für Stufe 3).
3. Zulässige Uhrunsicherheit, HLC-Zukunftsgrenze und Mess-/Sperrverhalten; diese Werte gelten auch für Grants.
4. Konkrete Byte-/Anzahllimits und Snapshot-/Request-Generationslaufzeiten anhand der Lasttests.
5. NetBird-Version, Deployment, Komponentenlizenzen, Transport bei Ausfällen und Management-API-Rechte.
6. Zielplattform-Schlüsselablage sowie Bedarf und Scope des Browser-Gateways.

Ohne Erfüllung eines Gates wird die davon abhängige Garantie nicht als implementiert oder abgenommen bezeichnet.

## Anhang A – Alternative ohne Overlay: SSH-Zertifikate

Wenn kein NetBird betrieben werden soll und alle Hosts per SSH erreichbar sind:

- Eine CA (auf dem Handy oder Koordinator) signiert Host- und Client-Schlüssel (`ssh-keygen -s`). Clients vertrauen
  der CA (`@cert-authority` in `known_hosts`) statt einzelnen Host-Schlüsseln (kein TOFU).
- Zertifikate tragen Principals (`peer:hostB`, `admin:handy`), gelten kurz (z.B. 7 Tage) und werden über den
  Control Space erneuert; Widerruf per KRL oder Nicht-Erneuern.
- Identität im Space: pro Rolle eine Zeile `cert-authority,principals="peer:hostB",restrict,command="space-gate --peer
  hostB" <CA-pub>` in `authorized_keys`; `space-gate` spricht dann über stdin/stdout. Zu verifizieren: ob sshd bei
  mehreren `cert-authority`-Zeilen mit verschiedenen `principals` die passende Zeile wählt.
- Pairing erfordert einen authentifizierten verschlüsselten Kanal: etwa PAKE für einen Kurzcode oder SSH mit
  per QR geprüftem CA-Fingerprint und starkem Einmal-Token. Ein Klartextkanal mit Token allein genügt nicht.
- Die Autorisierungs-, Delegations- und Recovery-Regeln dieses Plans gelten auch hier. KRL/kurze Zertifikate
  allein ersetzen nicht die Grant-Prüfung für laufende Space-Sessions.
- Nachteil gegenüber NetBird: kein NAT-Traversal, Schlüssel- und Zertifikatsverwaltung liegt vollständig bei uns.
