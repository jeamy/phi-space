# Föderierte Spaces v3 – konsolidierter Plan

Stand: 2026-10-06. Ersetzt `federation-plan-v1.md` (überarbeitete Fassung) und `federation-plan-v2.md`.

**Status:** Zielvertrag. Nichts davon ist implementiert oder abgenommen. Eine Garantie gilt erst als erfüllt, wenn
die zugehörigen Abnahmekriterien (Abschnitt 11) und Gates (Abschnitt 13) erfüllt sind.

**Herkunft:** Grundlage ist die überarbeitete v1, weil sie den genaueren Vertrag enthält. Aus v2 sind die
brauchbaren Vorschläge übernommen und, wo nötig, korrigiert. Vorschläge, die Garantien der v1 brechen, sind nicht
übernommen. Die Bewertung jedes v2-Punkts steht in Anhang B, offene Fragen in Abschnitt 14.

Grundlage der Implementierung: [spaces-v1.md](spaces-v1.md). Voraussetzungen von dort: B1–B3, L1–L3, L6, L7, L10,
L11, L13, L14.

## 1. Ziel und Ausgangslage

Jeder erreichbare Host (pi-serverd) stellt Agenten Spaces bereit. Spaces lassen sich zu Federations verbinden und
von beliebigen Clients (Handy, Desktop, CLI, Browser über Gateway) steuern und beobachten. Verbundmodi:
**expand** (verteilen, ähnlich RAID 0) und **sync** (spiegeln, ähnlich RAID 1). Die Steuerung ist selbst ein Space
(Control Space), der Router ein Worker darin. Netz: selbst gehostetes NetBird-Overlay (WireGuard).

Bewertung des ursprünglichen Entwurfs (unverändert gültig):

| Aussage im Entwurf | Lösung in diesem Plan |
|---|---|
| Identität kommt von der Verbindung | Overlay-Identität plus an die Verbindung gebundene App-Challenge (4.3) |
| requestId wie Tool-Claim | dauerhafte RPC-Claims pro Principal/Space/Generation (6.2) |
| Take-Waiter auf allen Members | Consumer-Mailboxes mit ACK und journalisierter Waiter-Wettlauf (6.2, 6.4) |
| nummerierter Änderungsstrom | Revision pro Commit, Batches, Snapshot plus Stream (6.1) |
| Last-Writer-Wins | Pflicht-Schlüsselfelder, HLC-Versionen, versionierte Tombstones (7.2) |
| neuerer `asOf` gewinnt | HLC ordnet Versionen; `asOf` bleibt Fachdatum (7.2) |
| Txns auf ein Member | globale IDs `spaceId/localId`, Txn-Bindung, `RoutingConflict` (7.1) |
| Capability-Verzeichnis | geschützte Typen, nur der Host selbst schreibt (8) |
| Router auf dem Handy | Router als Worker auf dem Koordinator-Host (5) |
| SSH-Schlüssel pro Host-Paar | NetBird für Netz und Schlüsselaustausch; SSH-CA als Alternative (Anhang A) |

## 2. Begriffe

- **Host**: pi-serverd mit stabiler, ungekürzter `hostId`; kann mehrere Spaces halten.
- **Space**: logischer Bestand mit unveränderlicher `spaceId`; Namen sind veränderbare Aliase.
- **Member**: logischer Data Space in einer Federation; `memberId = spaceId`. In expand allein zuständig für seine
  Entries, Txns, Waiter und Outbox; in primary mit physischen Replikaten.
- **Replikat**: physische Kopie mit eigener `replicaId`; übernimmt bei Promotion dieselbe `spaceId`.
- **Control Space**: geschützte Steuerdaten (Members, Policy, Schlüssel, Kommandos, Status).
- **Router**: Worker auf dem Koordinator; betreibt `FederatedSpace`, Replikatoren und Kommandos.
- **Supervisor**: lokaler Dienst je Host, unabhängig vom Router; Enrollment, Recovery, Promotion.
- **Recovery Space**: lokaler, **nicht replizierter** Space je Host für Recovery-Requests (Begründung 5.4).
- **Peer**: authentifizierte Gegenstelle mit unveränderlicher `peerId`; Anzeigenamen sind keine Identität.
- **Owner/Principal**: strukturiert `{peerId, agentId?}`; Strings sind nur Ausgabeformat.
- **Federation**: benannte Menge von Members plus versionierte Policy.
- **Global ID**: `<spaceId>/<localId>`. Lokale IDs bestehen aus Inkarnations-ID plus Zähler und werden nie
  wiederverwendet; nach Restore wird vor neuen Writes eine neue Inkarnation vergeben. Replikation erhält
  vorhandene IDs. Restore ist keine verlustfreie Promotion.
- **Mailbox**: dauerhafte Events für Principal und Consumer, adressiert über `mailboxId`, `epoch`, `seq`.
- **Overlay**: NetBird-Netz. Overlay-IPs sind Endpunkte, keine dauerhaften Identitäten.

### 2.1 Verbindliche Garantien und Grenzen

| Ebene | Vertrag |
|---|---|
| Lokaler Commit | Space-Mutation und RPC-Ergebnis werden atomar dauerhaft geschrieben. |
| Retry | Derselbe gültige Request liefert dasselbe Ergebnis ohne erneute Mutation, innerhalb des Fensters aus 6.2, **auch nach Prozessneustart**. |
| Take unter Txn | Höchstens eine aktive Reservierung pro Entry; Abort/Ablauf erlaubt erneute Reservierung. |
| Erfolgreicher Take | Höchstens ein erfolgreicher destruktiver Commit je Entry-Identität in expand/primary. |
| Fachliche Wirkung | Kein allgemeines Exactly-once für externe Effekte; das Ziel braucht Idempotenz oder gemeinsame Transaktion. |
| primary/sync | Bestätigte Operationen bleiben bei zulässiger Promotion erhalten (5.3). |
| Asynchrone Kopie | Backup/Lesekopie. Bestätigte Writes/Takes können beim Verlust des Primary fehlen. **Nie automatische und nie verlustfreie Promotion**; nur Restore mit neuer Inkarnation. |
| lww/set | Eventuelle Konvergenz nach vollständigem Austausch; keine exklusive Arbeitsvergabe. |

Netzfehler können einen unbekannten Ausgang hinterlassen. Der Client fragt mit derselben Request-ID nach und
startet bei Unsicherheit keine neue Mutation. Dauerhaft verlorener Storage ist in expand Datenverlust.

## 3. Zielarchitektur

Ergänzende [Architekturdiagramme und Bedienabläufe](betrieb-und-mobile-steuerung.md) zeigen die heutige
pi-durable/SSH-Anbindung und das mobile Zielbild am Primzahlsieb. Dort vorgeschlagene Space-Lebenszyklus-
und Lauf-/Workerkommandos sind zusätzliche offene Verträge, keine bereits implementierten v3-Kommandos.

```
   Handy        Desktop/CLI      Browser
     │              │               │ WebSocket/TLS (Stufe 4)
     │              │          ┌────▼─────┐
     │              │          │ Gateway  │
     │              │          └────┬─────┘
 ════╪══════════════╪═══════════════╪══════════ NetBird-Overlay (WireGuard, ACL-Gruppen) ══════
     ▼              ▼               ▼
 ┌────────────────────────────────────────┐        ┌────────────────────────────┐
 │ Koordinator-Host                       │        │ Host B                     │
 │  space-gate (TCP, nur Overlay-IP)      │        │  space-gate                │
 │  Supervisor + Recovery Space (lokal)   │        │  Supervisor + Recovery     │
 │  pi-serverd                            │◄──────►│  pi-serverd                │
 │   ├ Control Space (primary)            │        │   ├ Control-Standby (St. 3)│
 │                                        │        │   ├ Router-Standby (inakt.)│
 │   ├ Router (Journal, FederatedSpace)   │        │   ├ Data Space B           │
 │   ├ Data Space A                       │        │   └ Agenten                │
 │   └ Agenten                            │        └────────────────────────────┘
 └────────────────────────────────────────┘
            NetBird Management/Signal/Relay (selbst gehostet, eigene VM)
```

- Agenten benutzen die Tools wie heute; mit `space` gehen Operationen über `RemoteSpace` bzw. `FederatedSpace`.
- Clients halten keinen zentralen Betriebszustand; Host-Worker laufen ohne Dashboard weiter. Clients behalten
  eigene Request-IDs bis zum Abschluss.
- Router-Journal und RPC-Claims liegen in internen dauerhaften Dokumenten; Agenten-Nutzdaten nie im Control Space.
- Der Router-Standby läuft passiv (kein Lease, keine Delegationen) und wird erst bei der Promotion nach 5.2
  aktiv: Epoche erhöhen, alte `RouterLease` ablaufen lassen, dann in `recovering` starten.

## 4. Netz und Vertrauen

### 4.1 NetBird als Netzschicht

Geplant: selbst gehostetes NetBird auf eigener Linux-VM mit Domain und Docker Compose. Version, Ports, Ressourcen,
Benutzerverwaltung (eingebaut oder externer IdP), Lizenz und Upgrade-/Backup-Pfad werden für die eingesetzte
Version vor Stufe 1b anhand der offiziellen Dokumentation festgestellt (Gate 5).

| Aufgabe | Zuständig |
|---|---|
| WireGuard-Schlüssel, Austausch, NAT-Traversal, Relay | NetBird |
| Beitritt Hosts / Clients | Setup-Key / Login |
| Erreichbarkeit (Netz-ACL über Gruppen) | NetBird-Policies |
| Identität, Rechte, Quoten im Space | pi-spaces (4.3, 9) |

Gruppen (Vorschlag): `space-hosts`, `space-admin`, `space-observer`; Policies erlauben nur den Space-Port und SSH
für Admins. WireGuard bindet die Quell-IP eines Pakets kryptografisch an den Peer-Schlüssel (Cryptokey Routing);
IP-Spoofing durch *fremde* Peers ist im Overlay daher ausgeschlossen. Prozesse *auf* einem Peer teilen dessen
Overlay-Identität; deshalb gibt es Schicht B (4.3).

### 4.1.1 Ressourcenplanung bei mehreren VPS

Planungswerte ohne Benchmark-Abnahme: Die folgenden Größen umfassen Space-Dienst und genannte Nebenprozesse.
Lokale Modellinferenz, große Browserflotten und CPU-Suchaufgaben benötigen ein zusätzliches eigenes Budget.
Shared-vCPU-Angebote können schwankende Leistung liefern; CPU-Zahl allein garantiert keinen Durchsatz.

Die Dimensionierung gilt pro VPS und dessen Rolle, nicht pro Federation. `expand` verteilt Data-Entries; ein
Data Member hält daher nicht automatisch den Bestand aller anderen Members im RAM. Die Hauptkosten sind in v3
zunächst persistente Commits, Snapshots, Streams, Mailboxes, Tombstones und Router-Journal. NVMe/SSD mit
verlässlichen IOPS ist deshalb wichtiger als eine hohe Zahl CPU-Kerne.

| Rolle | Startempfehlung | Storage | Begründung |
|---|---:|---:|---|
| Data Member, leichte Agentenlast | 2 vCPU, 4 GB RAM | 30–50 GB NVMe | eigener Data Space, lokale Worker und Gate |
| Data Member, viele Worker oder Browser-Automation | 4 vCPU, 8 GB RAM | 50–80 GB NVMe | zusätzliche Prozesse, Waiter und lokaler Rückstau |
| Koordinator: Router und Control Primary | 4 vCPU, 8–16 GB RAM | 80 GB NVMe | Router-Journal, Control Space, Long-Polls und Replikation |
| Fester synchroner Standby | wie Koordinator: 4 vCPU, 8–16 GB RAM | 80 GB NVMe | muss komplette Commit-Historie und Recovery tragen |
| NetBird Management/Signal/Relay, getrennt | 2 vCPU, 2–4 GB RAM | 20–40 GB SSD | Management-Dienste; nicht zugleich Koordinator |

Eine kleine Federation kann damit aus drei Data VPS mit je 2 vCPU, 4 GB RAM und 40 GB NVMe, einem Koordinator
und einem synchronen Standby mit je 4 vCPU, 8 GB RAM und 80 GB NVMe sowie einer getrennten NetBird-VM bestehen.
Die Werte sind Startgrößen; die Lasttests aus Abschnitt 12 bestimmen vor Stufe 2 die endgültigen Budgets für
Entries, Journal, Snapshots und Replikationsrückstau.

Koordinator und Standby müssen eine Fehlerdomäne trennen: mindestens verschiedene physische Hosts und nach
Möglichkeit verschiedene Availability Zones oder Anbieter. Zwei VPS desselben physischen Hosts schützen nicht
gegen dessen Ausfall. Data Members dürfen auf weitere VPS verteilt werden. Der Fencing-Adapter aus 5.3 muss den
jeweiligen Anbieter und dessen Verwaltungs-API tatsächlich kontrollieren können.

Bei `primary/sync` liegt auf jedem bestätigten Write der zusätzliche Roundtrip zum Standby. Koordinator und
Standby gehören deshalb in nahe Regionen mit stabiler, niedriger Latenz. Geografisch weit entfernte VPS erhöhen
unmittelbar Commit-Latenz und Timeout-Risiko; sie eignen sich besser für asynchrone Backups oder Data Members
ohne synchrone Bestätigung. Monitoring erfasst CPU, RAM, freien Speicher, IOPS/Latenz, Commit-p95/p99,
Replikationslag und Mailbox-/Journal-Budgets pro VPS.

### 4.2 `space-gate`

- TCP nur auf der Overlay-IP; interner Unix-Socket `0600`.
- Das Gate authentifiziert die Verbindung (4.3) und übergibt pi-serverd einen vom Client nicht überschreibbaren
  Kontext, den der Server genau einmal beim Verbindungsaufbau akzeptiert. Das öffentliche `hello` handelt nur
  Protokollmerkmale aus und setzt weder Identität noch Rolle.
- pi-serverd erhält dafür eine explizite Authentifizierungsgrenze; bloßes Voranstellen eines Frames mit
  ungeprüftem Durchreichen genügt nicht.
- Grenzen (Startwerte, per Lasttest bestätigen, Gate 4): Handshake ≤ 5 s; Frame ≤ 256 KiB (muss größer sein als
  `maxEntryBytes` 64 KiB plus Protokoll-Overhead); höchstens 32 gleichzeitige Verbindungen pro Peer;
  Rate-Limit für Handshakes.
- Nur `serviceId: space`. `sessions`/`chat` bleiben auf diesem Eingang gesperrt.
- `pi-client` erhält eine TCP-Transport-Factory; Kompatibilität des Byte-/CBOR-Transports vor Umsetzung prüfen.

**Kein mTLS in v3.** Begründung: WireGuard liefert Verschlüsselung und Peer-Bindung; die App-Challenge (4.3)
liefert Schlüsselbesitz und Bindung an die Verbindung. mTLS würde eine zweite PKI (X.509, Ausstellung, Rotation,
Widerruf) erfordern, die Node ohne `openssl` oder Zusatzbibliothek nicht erzeugen kann, ohne neue Garantie. TLS
kommt nur am Browser-Gateway zum Einsatz (Abschnitt 10). Offene Frage F3.

### 4.3 Identität

| Schicht | Vertrag |
|---|---|
| A: Overlay | Quell-IP → Management-API → unveränderliche Peer-ID und Gruppen; Cache höchstens 60 s. |
| B: App-Schlüssel | Challenge pro Verbindung (unten). Erlaubte Schlüssel sind `PeerKey`-Entries im Control Space. |

**Challenge (Schicht B):** Das Gate sendet `{gateHostId, observedPeerId, connNonce (32 Byte), protocol,
issuedAt}`. Der Client prüft, dass `gateHostId` dem erwarteten Host und `observedPeerId` seiner eigenen
Overlay-Identität entspricht, und signiert die kanonische Kodierung (4.4). Damit kann ein Angreifer, der selbst
Peer ist, eine Challenge nicht an ein Opfer weiterreichen: das Opfer würde eine fremde `observedPeerId` erkennen.
Die Nonce ist einmalig und höchstens 30 s gültig. Signaturen pro Request sind nicht nötig, weil WireGuard den
weiteren Verkehr der Verbindung an den Peer bindet (offene Frage F4).

- Algorithmus: Ed25519; wo der Plattform-Keystore Ed25519 nicht unterstützt, ECDSA P-256 (Gate 6).
- Schicht B ist Pflicht für Control Space, Admin, Router, Gateway, Replikation und delegierende Hosts. Direkte
  Data-Space-Clients dürfen nur mit A arbeiten, wenn eine explizite Peer-/Gruppenregel `member` oder `observer`
  zuweist. Ohne Regel kein Zugriff. Gruppen- und App-Rechte werden geschnitten, nie vereinigt.
- Benutzerrollen `admin`, `member`, `observer`; Dienstrollen `host`, `router`, `replicator`, `supervisor` mit
  explizit erlaubten Spaces und Operationen. Ein Host ist dadurch kein Admin.
- Autorisierung bei jedem Request und erneut vor dem entscheidenden Commit. Grants gelten höchstens 60 s;
  Invalidierungen schließen Sessions und beenden offene Polls. Ohne rechtzeitig erneuerten, autoritativen Grant
  werden neue und unentschiedene Operationen abgewiesen. Replikate stellen keine Grants aus altem Zustand aus.
  Bestätigte Arbeit wird durch Widerruf nicht rückgängig gemacht.
- **Widerruf wirkt innerhalb Grant-Laufzeit plus Zeitunsicherheit**, nicht sofort unter jeder Partition.
- Recovery verwendet einen gesondert lokal provisionierten Admin-Schlüssel (5.3); sein Widerruf wird auf jedem
  Recovery-Host separat bestätigt. Desktop-Schlüsseldateien `0600`.

### 4.4 Delegation

Ein Host weist lokale Agenten nur im eigenen Principal-Namensraum aus. Der Router reicht diese Identität mit einem
signierten Delegationsnachweis weiter:

```ts
type Delegation = {
  issuer: PeerId;               // Router
  routerLease: { id: string; epoch: number; expiresAt: number }; // aus dem Control Space (5.2)
  principal: Principal;         // ursprünglicher Aufrufer
  targetSpace: SpaceId;         // Audience
  operation: string;            // z.B. "take"
  requestId: string;            // Unterrequest-ID des Routers
  argumentHash: string;         // kanonischer Hash der Argumente
  policyVersion: number;
  expiresAt: number;            // ≤ 60 s, ≤ routerLease.expiresAt
};
```

- **Kanonische Kodierung** für Signatur und Hashes: JSON nach RFC 8785 (sortierte Schlüssel, feste Zahlenform),
  eigene kleine Implementierung ohne Abhängigkeit. `JSON.stringify` allein ist nicht deterministisch genug.
- Signatur mit dem Router-Schlüssel (`node:crypto`); der öffentliche Schlüssel steht als `PeerKey` mit Rolle
  `router` im Control Space.
- Der Member prüft: Signatur, Audience = eigener Space, Ablauf (mit Zeitunsicherheit), Router-Lease gültig und
  Epoche nicht kleiner als die zuletzt bekannte, `argumentHash` passt zum Request, Scope erlaubt die Operation.
- **Policy-Version:** ist sie *kleiner* als die dem Member bekannte, wird abgewiesen (Rechte könnten entzogen
  worden sein). Ist sie größer, lädt der Member die Policy nach; gelingt das nicht, wird abgewiesen.
- **Replay:** Der Nachweis ist an `requestId` und `argumentHash` gebunden; ein Replay trifft den vorhandenen
  RPC-Claim und liefert nur dasselbe Ergebnis. Zusätzlich verwirft der Member Nachweise, deren `requestId` er
  für einen anderen Principal kennt.
- Gateway-Benutzer sind eigene Principals. Quoten zählen delegierten Principal und Transport-Peer. Frei übergebene
  `owner`-Felder werden ignoriert.

### 4.5 Pairing

1. Gerät tritt dem Overlay bei; ein Admin weist die Gruppe zu.
2. Admin erstellt `Enroll {tokenHash (SHA-256), role, scope, allowedPeerId, expiresAt = +5 min, attempts: 0}`.
   QR enthält Endpunkt, Control-Space-ID und Token mit **256 Bit** Zufall. Klartext-Token wird nirgends geloggt.
3. Ungepaarte Peers dürfen ausschließlich `EnrollRequest` schreiben und ihr eigenes Ergebnis lesen; weder Tokens
   listen noch Control-Daten lesen, abonnieren oder nehmen.
4. Ablauf: Peer verbindet (Schicht A), erhält die Verbindungs-Challenge aus 4.3, signiert sie mit dem **neuen**
   Schlüssel und sendet `EnrollRequest {token, publicKey, signature}`. Der Supervisor prüft
   `sha256(token) = tokenHash`, `observedPeerId = allowedPeerId`, Ablauf, Versuchszähler und Signatur.
   Tokenverbrauch und `PeerKey`-Anlage erfolgen atomar am Control-Primary; Retry ist über die Request-ID
   dedupliziert.
5. Rate-Limits: höchstens 3 Fehlversuche pro Token (danach ungültig), höchstens 1 Versuch pro Peer und Minute.
6. Manuelle Eingabe verwendet denselben starken Token. Kurze Codes brauchen ein getrenntes Verfahren (PAKE,
   Versuchslimit, Admin-Bestätigung) und sind nicht Teil von v3.

Bootstrap: Der erste Host legt Control Space und einmalig einen Bootstrap-Token an; der Supervisor bearbeitet ihn
ohne Router. Weitere Hosts erhalten gebundene Einmal-Tokens und nur die Rolle `host`; Routingziele werden sie erst
nach `addMember`.

### 4.6 NetBird-Betrieb und Ausfalltests

Lokaler Storage bleibt bei Ausfällen erhalten; die Verfügbarkeit entfernter Operationen hängt von Transport und
gültigen Grants ab. Nach Cache-Ablauf ohne autoritative Erneuerung wird geschlossen abgewiesen; lokale Wartung
und Lease-Ablauf laufen weiter.

Testmatrix vor Stufe 1b. Die rechte Spalte enthält **Hypothesen**, die der Test bestätigt oder widerlegt; das
Ergebnis wird in diesem Abschnitt nachgetragen.

| Ausfall | Dauer | Zu prüfende Hypothese |
|---|---|---|
| Management | 5 min, 1 h | bestehende Tunnel bleiben; neue Peers/Policy-Änderungen nicht möglich; Schicht-A-Cache läuft ab → Zugriff wird abgewiesen |
| Signal | 10 min | bestehende Tunnel bleiben; Neuverbindungen nach Tunnelabbruch scheitern |
| Relay | 30 min | direkte Verbindungen bleiben; relayed Verbindungen brechen ab |
| Management + Relay | 1 h | nur direkt erreichbare Peers kommunizieren |
| Peer entfernt | – | Tunnel endet; Gate weist binnen Cache-Laufzeit ab |

## 5. Control Space, Router, Supervisor, Recovery

| Typ | Schreibt | Inhalt |
|---|---|---|
| `Member` | Router nach Command | Identitäten, Endpunkte, Aufnahmezustand, Routingzuordnung |
| `FederationPolicy` | Router nach Command | validierte Policy mit `policyVersion` |
| `PeerKey` | Supervisor | Principal, öffentlicher Schlüssel, Algorithmus, Rollen, Scope |
| `Enroll` / `EnrollRequest` | admin / ungepaarter Peer | 4.5 |
| `Command` / `Result` | admin / Router | `setLimits`, `drain`, `addMember`, `removeMember`, `setPolicy`; `{commandId, state, error?}` |
| `RouterLease` | Router | `{id, epoch, expiresAt}`, Erneuerung alle 20 s, Laufzeit 60 s (5.2) |
| `MemberStatus` | Router | Erreichbarkeit, Revision, Lag, Kapazität; Lease 30 s |
| `Capability` | Host für sich selbst | Werkzeuge, Modelle, Ressourcen; Lease 2 min |
| `RecoveryRequest` / `RecoveryResult` | Recovery-Admin / Supervisor | nur im lokalen Recovery Space |

### 5.1 Kommandos und Router-Journal

Command-Verarbeitung ist eine dauerhafte Zustandsmaschine `accepted → applying → completed | failed`.

- Vor jeder entfernten Wirkung speichert der Router Ziel, Argument-Hash und eine stabile **Unterrequest-ID**.
- Die entfernte Operation wird mit genau dieser Unterrequest-ID als RPC-`requestId` ausgeführt. Das Ziel speichert
  Wirkung und Deduplizierung atomar (RPC-Claim, 6.2). Nach einem Absturz fragt der Router denselben Unterrequest
  ab oder wiederholt ihn; eine zweite Wirkung ist ausgeschlossen.
- Das ist **kein Zwei-Phasen-Commit** und braucht keinen: Atomarität entsteht durch Journal plus Deduplizierung am
  Ziel. Ein unbekannter Ausgang wird nie als `failed` verbucht, sondern aufgelöst.
- Operationen ohne idempotentes Zielprotokoll sind keine zulässigen Commands.
- Nach Neustart ist der Router `recovering`, löst offene Commands/Requests auf und nimmt erst dann neue Arbeit an.
- Journal und Deduplizierung haben dieselbe Schutz- und Replikationsklasse wie der Control Space; ihre Bytes
  werden getrennt budgetiert. Mailbox-ACKs erst nach dauerhafter Übernahme des Events.

### 5.2 Verfügbarkeit des Control Space

| Stufe | Betrieb | Garantie bei Ausfall des Primary |
|---|---|---|
| 1b–2 | **single** plus regelmäßiger asynchroner Snapshot auf einen zweiten Host | kein Enrollment/keine Commands bis Rückkehr oder **Restore**. Restore = neue Inkarnation, letzte Änderungen können fehlen (Enrollments ggf. wiederholen). Keine automatische Übernahme. |
| ab 3 | **primary/sync** mit festem Standby | manuelle Promotion nach 5.3 ohne Verlust bestätigter Operationen |

**Router-Lease (Software-Fencing des Routers):** Der Router darf Delegationen nur innerhalb einer gültigen
`RouterLease` ausstellen. Die Lease wird per Commit im Control Space erneuert; im Modus primary/sync braucht jeder
Commit die Standby-Bestätigung. Ein abgeschnittener alter Primary kann seine Lease daher nicht erneuern, und
Members weisen seine Delegationen nach Ablauf zurück. Ein neuer Router startet frühestens nach Ablauf der alten
Lease plus maximaler Zeitunsicherheit.

### 5.3 Manuelle Promotion (ab Stufe 3)

Keine automatische Wahl bei bloßem Timeout. Pro primary-Space ein fester Standby; Supervisor auf beiden Hosts.

1. Recovery-Admin schreibt einen signierten Request in den Recovery Space **des Standbys**: erwartete Epoche,
   Ziel, Recovery-ID.
2. **Fencing-Nachweis** nach 5.5. Netzwerk-Timeout oder bloße Admin-Behauptung genügen nicht.
3. Nur der feste synchrone Standby übernimmt; er prüft Historie und Replikationsvertrag (7.2). Lücken → Abbruch.
4. Supervisor erhöht die Epoche atomar, aktiviert den Space, startet den Router in `recovering` erst nach Ablauf
   der alten `RouterLease`. Mutierende Requests tragen die Epoche; alte Epochen werden abgewiesen.
5. Der alte Host startet erst nach Rejoin und vollständiger Synchronisierung als Replikat; ein Prozessneustart
   stellt keine Primary-Berechtigung wieder her.
6. Bis ein neuer synchroner Standby eingerichtet ist, bleiben sync-Writes gesperrt. Single-Betrieb nur nach
   ausdrücklicher Umschaltung, dann ohne HA-Garantie.

### 5.4 Recovery Space bleibt lokal

Der Recovery Space wird nicht repliziert. Er ist der Steuerpfad, der funktionieren muss, wenn Control Space oder
Router ausgefallen sind, und liegt auf dem Host, der handeln soll (dem Standby). Ist dieser Host selbst
ausgefallen, gibt es nichts zu befördern. Eine Replikation würde den Recovery-Pfad von genau der Infrastruktur
abhängig machen, deren Ausfall er behandelt, und eigene Split-Brain-Fälle schaffen.

### 5.5 Fencing

Fencing hat zwei Ebenen:

1. **Daten (immer wirksam in primary/sync):** Der alte Primary kann ohne Standby-Bestätigung nichts bestätigen,
   und der beförderte Standby bestätigt keine alte Epoche mehr. Bestätigte Doppelwirkungen auf replizierten
   Daten sind damit ausgeschlossen, solange es keinen stillen Rückfall auf asynchronen Betrieb gibt.
2. **Prozesse (Pflicht für Promotion):** Der alte Primary könnte weiter veraltete Reads ausliefern, Agenten
   betreiben und externe Wirkungen auslösen. Deshalb ist ein Nachweis nötig, dass er gestoppt und gegen
   automatischen Neustart gesperrt ist.

```ts
interface FencingAdapter {
  readonly kind: "power" | "hypervisor" | "cloud" | "container";
  fence(hostId: string, reason: string): Promise<FenceProof>;     // stoppen UND Neustart sperren
  verify(proof: FenceProof): Promise<boolean>;                     // vom Supervisor unabhängig nachgeprüft
  release(hostId: string): Promise<void>;                          // nur nach Rejoin (5.3 Schritt 5)
}
type FenceProof = { hostId: string; kind: string; observedAt: number; evidence: Json; restartLocked: boolean };
```

- Zulässig sind nur Adapter, deren Zustand der Supervisor selbst über eine unabhängige Schnittstelle abfragt:
  schaltbare Steckdose/PDU, IPMI/BMC, Hypervisor- oder Cloud-API, Container-Runtime auf einem *anderen* Host.
- `restartLocked` muss erfüllt sein (z.B. Steckdose bleibt aus, VM deaktiviert, Restart-Policy entfernt). „Power
  off“ allein genügt nicht.
- Ein Marker-Datei-Adapter ist **nur im Simulator** zulässig; er ist eine Behauptung, kein Nachweis.
- Welcher Adapter eingesetzt wird, hängt von der Hardware der Hosts ab (offene Frage F1, Gate 2).

## 6. Bausteine

### 6.1 Core-Erweiterungen (Doc-Version 5)

1. **Revision** pro dauerhaftem Commit; ein Batch enthält alle Deltas eines Commits; Cursor nur zwischen Batches.
   Stream-ID = Space + Historien-Inkarnation (+ Epoche bei primary); Revisionen verschiedener Streams sind nicht
   vergleichbar.
2. **Zwei Replikationszwecke:** Entry-Strom (Put/Delete, Lease-Änderungen, Konfliktmetadaten) für lww/set;
   vollständige atomare Commit-Historie (Txns, Sperren, Waiter, Mailbox, RPC-Claims, Router-Dokumente) für
   primary. Anwenden auf Replikaten erzeugt keine zweite Geschäftsoperation und keine Events.
3. **Snapshot:** unveränderlich mit Token, Stream-ID, Revision R; alle Seiten gehören zu R; `changes` beginnt nach R.
   Begrenzt vorgehalten; Ablauf → `SnapshotExpired`. Replikations-Snapshots enthalten Tombstones und
   Deduplizierung; Installation atomar.
4. **Identitäten:** `hostId`, `spaceId`, `replicaId`, Inkarnation; `view()` liefert `gid`.
5. **Peer-Ziele:** strukturierte Principals und Consumer-Mailboxes neben Conversations. Events bleiben bis ACK/TTL.
   Ein abgelaufener Take-Txn wird freigegeben; ein später zugestelltes Event verleiht keine Reservierung.
   Empfänger prüfen den Txn-Zustand vor Bearbeitung.
6. **Rechte:** zentraler Check pro Operation und Typ inklusive Supertypen, Lease-Eingriff, Take, Snapshot, Stream.
   Remote-Host-Zugriff ist nicht quotenfrei.
7. **Schlüssel:** pro lww-Typ Pflicht, kanonische Kodierung `type + keyFields`; fehlende Felder → Fehler.
   Upsert-Konflikte mit aktiven Txns → Fehler.
8. **Vorbedingungen:** B1 (ID-Templates), L7 (Gesamtbytes), L13 (Cursor), L11 (Meter pro Space).

### 6.2 Dienst `space`

Jeder Aufruf nennt die stabile Space-ID (Alias vorher auflösen). Argumente werden validiert. Mutationen tragen
`requestId`, Request-Generation und bei primary die Epoche. Relative Zeiten werden beim ersten angenommenen
Aufruf einmalig in eine serverseitige Deadline übersetzt.

| Methode | Wesentliche Argumente | Antwort |
|---|---|---|
| `hello` | Protokollversion, Features | IDs, Epoche, Limits, Rolle, Features |
| `write` | Entry, Lease, Txn?, Request | Entry-ID, Lease |
| `read` / `take` | Template, Gesamt-Timeout, `ifExists?`, Txn?, Request | `pending` oder dauerhaftes `done(entry \| null)` |
| `pollOperation` | Request, `waitMs ≤ 25000` | Operationszustand |
| `cancelOperation` | Zielrequest, eigener Request | Cancel-Ergebnis oder bereits entschiedener Zustand |
| `readAll` | Template, Snapshot-Token?, Cursor?, Limit | Entries, Next, Token, Stream-ID, Revision |
| `count` / `stats` | Template? | Wert plus Revision; föderiert plus Vollständigkeit (7.1) |
| `txn` / `lease` | Aktion, ID?, Dauer?, Request | Zustand/Lease |
| `wait` / `notify` | Template, Laufzeiten, Consumer, Handback, Request | ID, Lease |
| `events` | Mailbox, Epoche, Cursor, `waitMs ≤ 25000` | Events, Next oder explizite Lücke |
| `ack` | Mailbox, Epoche, `upTo` | idempotent |
| `changes` | Stream-ID, `afterRev`, `waitMs ≤ 25000`, Byte-Limit | Commit-Batches oder `resync` |

**RPC-Claims:** Schlüssel `(principal, spaceId, requestGeneration, requestId)`; gespeichert werden Methode,
kanonischer **Argument-Hash** (keine Klartext-Argumente), einmalige Deadline, Zustand `pending | done | cancelled`
und das **Ergebnis dauerhaft** im selben Commit wie die Operation. Abweichende Wiederverwendung → `RequestConflict`.
Ein Retry liefert das gespeicherte Ergebnis, ohne erneut zu mutieren.

Das Ergebnis muss dauerhaft gespeichert werden: Ein Take entfernt den Entry; läge das Ergebnis nur im Speicher,
wäre der Entry nach einem Neustart verloren (Abnahme Stufe 1). Datenschutz wird über Minimierung und Fristen
erreicht, nicht über Weglassen:

- Argumente nur als Hash; Ergebnisse enthalten nur, was der Aufrufer ohnehin erhält (z.B. den genommenen Entry).
- Abgeschlossene Ergebnisse mindestens 24 h, höchstens 7 Tage (Startwert 24 h), danach gelöscht; nur der
  Hash-Eintrag bleibt bis zum Ende der Request-Generation, damit alte IDs `RequestExpired` statt einer neuen
  Mutation ergeben.
- Claims, Journale und Mailboxes sind nur für den eigenen Principal und Dienstrollen lesbar, nie für Observer.
- Löschanfrage für Inhalte eines Principals erfasst Entries, Claims und Mailbox-Events gemeinsam (offene Frage F9).

**Poll-Semantik:** Die Transportwartezeit von 25 s beendet nur den Poll, erzeugt keinen Miss und verlängert keine
Deadline. `null` ist endgültig, sobald die Operation nach ihrer Semantik erfolglos endet; ein neuer Versuch erhält
eine neue ID. Das erhält auch die `ifExists`-Semantik.

**Request-Generationen:** serverseitig signiert, an Principal/Space gebunden, feste Zulassungsfrist. Nach Ablauf
werden darin unbekannte IDs mit `RequestExpired` abgewiesen, auch nach Claim-Bereinigung. Alte unbekannte Requests
werden nie als neue Writes behandelt.

**Mailbox:** ACK nur für den authentifizierten Consumer, passende Epoche und bereits ausgelieferte Sequenzen; nur
zusammenhängende Präfixe. Alte ACKs löschen nach Reset keine neuen Events. TTL-Verlust wird als Lücke gemeldet.
ACK bestätigt Transportübernahme, keinen Take-Commit.

**Rückstau:** getrennte Byte-/Anzahllimits für Entries, Claims, Journal, Mailbox, Snapshots, Stream; maximale
Pending-Operationen pro Principal und Transport-Peer; Platz für Ergebnis/Claim vor der Mutation reservieren.
Überlast → `ResourceExhausted` vor Annahme. Mailbox höchstens 7 Tage plus Byte-Limit; bei Erreichen werden neue
betroffene Operationen abgelehnt statt aktive Take-Ergebnisse zu verlieren. Replikationsrückstau blockiert
synchrone Writes. Rate-Limits auch für Enrollment, Reads, Polls, Txns, ACKs.

### 6.3 `RemoteSpace`

Gemeinsames `SpaceLike`-Interface mit Capability-Flags für Modusgrenzen. `RemoteSpace` hält Request-ID und
Argumente bis zum Abschluss, wiederholt Transportversuche und pollt dieselbe Operation.

- **Client-Wartegrenze** (`maxClientWaitMs`, optional): beendet nur das *Warten* des Aufrufers mit
  `OutcomeUnknown {requestId}`. Die Operation läuft serverseitig bis zu ihrer eigenen Deadline weiter und bleibt
  über die Request-ID abfragbar oder per `cancelOperation` abbrechbar. Es gibt keinen pauschalen Default, weil
  `space_wait`/`FOREVER` legitime lange Operationen sind.
- Keine automatische Verlängerung von Deadlines. Browser nutzen das Gateway.

### 6.4 `FederatedSpace`

```ts
type Rule =
  | { type: string; mode: "local"; member: string }
  | { type: string; mode: "expand"; members: string[]; by: "type" | { field: string } | "capacity" | "capability" }
  | { type: string; mode: "sync"; variant: "primary"; member: string; primaryReplica: string;
      standbyReplica?: string; durability: "single" | "sync" }
  | { type: string; mode: "sync"; variant: "lww"; members: string[]; keyFields: string[]; semantics: "state" }
  | { type: string; mode: "sync"; variant: "set"; members: string[]; semantics: "facts" };
type Policy = { policyVersion: number; rules: Rule[]; default: { mode: "local"; member: string } };
```

- `semantics` ist ein Pflichtfeld zur ausdrücklichen Bestätigung: lww nur für Zustand (Sensorwerte,
  Konfiguration, Status), set nur für Fakten/Beobachtungen. Für Jobs, einmalige Aktionen oder Zahlungen sind
  beide unzulässig; dort gilt expand oder primary.
- Primary-Epochen pro logischem Space. In v3 umfasst primary den ganzen Member einschließlich interner Dokumente;
  alle Typregeln eines Members haben dieselbe Replikatkonfiguration. Control-Daten inklusive Capability bleiben
  einheitlich primary.
- Pro Typ genau eine Regel; Supertypen im Template erweitern die Suche auf alle betroffenen Regeln. `local` meint
  den explizit benannten Member, nie implizit den Host des Clients.
- Direkte Member-Zugriffe prüfen dieselben Modus-, Rechte- und Routinggrenzen; verwaltete expand-Typen dürfen
  außerhalb ihres Members nicht direkt geschrieben werden.

**Router-Journal:** vor dem ersten Remote-Aufruf: logischer Request, Principal, Policy-Version, Ziele,
Unterrequest-IDs, Deadline. Eine begonnene Operation wechselt bei Timeout weder Member noch Policy. Entfernte
Ergebnisse werden dauerhaft übernommen, bevor Client-Antwort oder ACK erfolgt.

**Waiter-Wettlauf:** alle Registrierungs-IDs und eine Generation pro Versuch werden journalisiert. Die erste noch
aktive Reservierung wird atomar Gewinner; Verlierer werden storniert/abgebrochen, auch bei späten Events. Replay
ändert den Gewinner nicht. Ohne Nutzer-Txn committet der Router die Gewinner-Txn mit stabiler Unterrequest-ID.
Mit Nutzer-Txn wird nur auf deren Member gearbeitet; eine von `space_wait` zurückgegebene Txn gehört explizit dem
ursprünglichen Principal. Nach Neustart werden offene Zustände über dieselben Unterrequests aufgelöst; ein
unklarer Commit wird aufgelöst, nie durch einen zweiten Gewinner ersetzt.

## 7. Modi

### 7.1 expand

- **write:** Typ → fester Member; Feld → HRW über die festgelegte Member-Menge; capacity/capability → Auswahl vor
  dem ersten Versuch, dauerhaft im Journal gebunden. Veraltete Kapazitätsdaten führen zu Ablehnung, nicht zu
  stiller Zweitplatzierung. Neuplanung nur nach eindeutig abgewiesenem Versuch.
- **read:** erster Treffer; Miss erst nach Miss aller relevanten Members; bei Ausfall ohne Treffer `Unavailable`.
- **readAll/count:** Standard: Fehler, wenn ein relevanter Member fehlt. Option `allowPartial`: Ergebnis mit
  `complete: false`, `missingMembers` und Revision pro Member. Option `waitForComplete {timeoutMs}`: wiederholt
  mit begrenztem Backoff bis vollständig oder Timeout. **Es gibt keinen federationsweiten konsistenten Snapshot**;
  die Revisionen pro Member machen sichtbar, welcher Stand gelesen wurde.
- **take ohne Warten:** sequenzielle Suche; unbekannten Ausgang erst auflösen, erst ein bestätigter Miss erlaubt
  den nächsten Member. Fortschritt journalisiert.
- **wartender Take:** Waiter-Wettlauf (6.4).
- **Transaktionen:** vor Beginn an einen Member gebunden; abweichende Regel → `RoutingConflict`.
- **Ausfall:** Bestand vorübergehend nicht erreichbar; ohne Backup bei Storage-Verlust verloren.

**Membership:** HRW-Menge, Schlüsselfeld und feste Typzuordnung eines vorhandenen Bestands sind in v3
unveränderlich. `addMember` registriert Hosts und erlaubt neue, leere Regeln; es ändert keine bestehende
Zuordnung, auch nicht „nur für neue Daten“, weil gezielte Reads nach Feld sonst den falschen Member fragen.
`removeMember` erfordert nachgewiesene Leerung einschließlich offener Operationen.

**drain:** stoppt neue Platzierungen auf dem Member. Bereits begonnene Operationen behalten ihr Ziel und laufen zu
Ende oder werden über `cancelOperation` **am Member** abgebrochen; das Ergebnis (abgebrochen oder bereits
entschieden) wird übernommen. Ein Journal-Eintrag wird nie einseitig auf `cancelled` gesetzt, solange der Ausgang
am Member unbekannt ist. Bei capacity/capability bleiben frühere Standorte bis zur Leerung in der Suchmenge.

**Migration** bestehender Bestände ist ein späteres Feature (versionierte Routingtabellen, Transferjournal,
Übergangslesen, Eigentumsübergabe). `take A → write B` ist kein sicheres Verfahren. Bis dahin werden Änderungen
mit Migrationsbedarf abgewiesen.

### 7.2 sync

| Variante | Anwendung | Garantie |
|---|---|---|
| primary/sync | Control Space (ab Stufe 3), Jobs mit HA | ein aktiver Primary; ohne Standby keine Bestätigung; Promotion nach 5.3 |
| primary/single | Einzelhost, optional asynchroner Snapshot | lokal atomar; Restore statt Failover |
| lww | Zustand mit Schlüssel | deterministische Konvergenz inklusive versionierter Löschungen |
| set | Fakten/Beobachtungen | Observed-Remove-Set, Add-Wins; keine exklusive Vergabe |

**primary:** Der Standby übernimmt die komplette geordnete Commit-Historie. Ein Commit wird erst sichtbar und
beantwortet, wenn der Standby den Batch dauerhaft angenommen und der Primary ihn lokal angewendet hat. Der Primary
persistiert Batch und Pending-Zustand vor dem Senden und klärt sie nach Neustart mit dem Standby, bevor er weitere
Mutationen zulässt. Ein auf dem Standby angenommener Batch gilt als entschieden. Replikate liefern nur als veraltbar
markierte Reads; konsistente Reads und Takes gehen zum Primary. Kein stiller Rückfall auf asynchron. Standby wird
über Snapshot plus Stream synchronisiert, dann aktiviert; Standby-Wechsel nur bei pausierten Writes.

**Entry-Replikation (lww/set):** jede Änderung hat die unveränderliche ID `(originReplicaId, incarnation, seq)`.
Weiterleitung erhält ID, Owner und Metadaten und erzeugt keine neue Änderung. Dedup-/Kausalzustand ist dauerhaft
und Teil des Snapshots. Replikatoren haben einen eng begrenzten Importpfad; normale Writes können diese
Metadaten nicht setzen.

**lww:** pro Schlüssel gewinnt lexikografisch `(hlc.physical, hlc.logical, replicaId)`. HLC-Zustand überlebt
Neustarts. **Delete ist ein Tombstone mit eigener, regulär vergebener HLC-Version**; er gewinnt gegen ältere Puts
und verliert gegen neuere. Ein Tombstone mit fester Minimalversion wäre falsch, weil jeder alte Put ihn
überschreiben würde. HLC garantiert Ordnung, nicht die physikalisch neueste Messung; `asOf` bleibt Fachdatum.
Zu weit zukünftige Uhren werden abgewiesen und gemeldet.

**set:** jedes Add erzeugt einen eindeutigen Tag; Remove/Take entfernt nur beobachtete Tags; konkurrierende Adds
bleiben (Add-Wins). `SpaceLike` weist exklusive Txns für solche Regeln ab.

**Leases bei lww/set:** Ablauf wird als unveränderliche Origin-Deadline der jeweiligen Version übertragen;
Weiterleitung erneuert nicht, Renewal erzeugt eine neue Version. **Natürlicher Ablauf versteckt nur die
abgelaufene Version** und erzeugt keinen Tombstone, damit eine neuere Erneuerung auf einem anderen Replikat nicht
gelöscht wird. Ablauf kann innerhalb der Zeitunsicherheit unterschiedlich sichtbar sein; bei überschrittener
Unsicherheit werden zeitkritische Operationen gesperrt. Lease-Ablauf stoppt keinen extern weiterlaufenden Worker.

**Tombstones und Offline-Replikate:** Konflikt-/Remove-Metadaten bleiben in eigenem Budget dauerhaft; bei
Erreichen werden neue Änderungen abgewiesen. Keine zeitbasierte Bereinigung. Kompaktierung erst nach bestätigtem
gemeinsamen Kausalstand aller aktiven Replikate. Dauerhaft entfernte Replikate nur nach Neuaufbau mit neuer
Inkarnation; alte Offline-Änderungen werden nicht automatisch eingespielt.

### 7.3 RAID-10-Fall

expand nach Feld, pro Partition primary/sync. Nicht in v3; erst nach stabilen 7.1 und 7.2.

### 7.4 Bewusste Grenzen

- Kein globales FIFO; keine Txns über Members; keine automatische Primary-Wahl; keine automatische Migration.
- Garantien nur im Umfang von 2.1; externe Wirkungen nicht allgemein exactly-once.
- `readAll`/`count` über eine Federation sind Momentaufnahmen pro Member ohne globale Konsistenz.

## 8. Verzeichnis

- Jeder Host schreibt `Capability` in seinen Data Space und den Control Space (Lease 2 min, Heartbeat 1 min); nur
  der zugeordnete Host darf sie erneuern (Server prüft Principal).
- Agenten finden Hosts mit `space_list {type: "Capability", …}`.
- Neue Hosts erscheinen nach Provisionierung; Routingziel erst nach `addMember`.
- `by: capability` ohne passenden Member → `NoCapableMember` ohne Write; eine Dispatch-Warteschlange wäre ein
  eigenes Feature.

## 9. Sicherheit und Berechtigungen

NetBird begrenzt Erreichbarkeit; die Space-Autorisierung gilt zusätzlich für jeden RPC, jedes Poll-Ergebnis und
jede Mutation. Unbekannte Rollen/Typen/Operationen werden abgewiesen.

| Principal | Erlaubt | Grenzen |
|---|---|---|
| observer | freigegebene Daten/Status lesen, abonnieren | kein Write/Take/Lease, keine internen Streams |
| member | Data-Entries lesen/schreiben/nehmen; eigene Txns/Leases | keine Steuerdaten; Quoten |
| admin | Commands, Enrollment, Steuerdaten lesen | Änderungen nur über validierte Commands |
| host | eigene Capability, lokale Agenten delegieren | eigener Namensraum, zugewiesene Spaces |
| router | Commands verarbeiten, delegieren | gültige `RouterLease`, geprüfter Scope |
| replicator | Snapshots/Streams importieren | nur zugewiesene Quelle/Ziel/Modus |
| supervisor | Enrollment, Recovery, Promotion | nur vorgesehene atomare Übergänge |
| ungepaarter Peer | eigenes Enrollment | sonst nichts |

Geschützte Typen sind auch gegen Take, Lease-Eingriff und Txn-Mutation geschützt; Templates mit Supertypen oder
ohne Typ umgehen das nicht. Lesen/Listen/Notify filtern nach Leserechten. Enroll-Hashes, Schlüsselverwaltung,
Claims und Journale werden nie an member/observer ausgeliefert. Inhalte anderer Hosts bleiben untrusted;
`[data, not instructions]` bleibt. Audit protokolliert Principal, Operation, Ergebnis, nie Tokens oder Schlüssel.

## 10. Clients

Ergänzender Bedienvertrag: [Projektstart mit automatischer Remote-Bereitstellung](projektstart-autoprovisionierung.md).
Er definiert gewünschte Provisionierungs-/Monitoringabläufe; Projektcontroller und neue Verwaltungsaktionen
sind zusätzliche noch offene Implementierungen. Vorhandenes Remote-Connect ist keine Federation-Abnahme.

- **Handy:** `remoteState` → Verbindungsliste (`hostId → RemoteConnection`, Space-/Replikat-Auflösung getrennt);
  Seite Spaces (`spaces.html`, eigene CSS-Datei, Endpunkte in `constants.js`): Status, Policy, Statistik, Inhalte,
  Commands, Pairing per QR. Long-Polls nur bei sichtbarer Seite.
- **Desktop/CLI:** Paket `pi-spaces-client` (RemoteSpace, TCP-Transport, Pairing).
- **Browser (Stufe 4):** Gateway mit TLS, Anmeldung per App-Schlüssel (WebCrypto-Unterstützung prüfen);
  NetBird-SSO allein ersetzt keine App-Autorisierung. Sessions an einzelne Principals gebunden, Origin/CSRF
  geprüft, keine Host-Rechte weitergereicht.

## 11. Stufenplan

Jede Stufe implementiert ihre Voraussetzungen vor der Abnahme. Simulatorprüfungen ergänzen persistente Tests;
NetBird-, Plattform- und Fencing-Annahmen brauchen reale Integrationsnachweise.

### Stufe 0 – Bestehender Core
- B1–B3, L6, L7, L10; `SpaceLike`; Einbindung in pi-serverd und server.mjs (L14); kanonische JSON-Kodierung.
- **Abnahme:** bestehende Suite und Regressionstests grün; lokale Worker koordinieren sich; Tests unterscheiden
  Reservierung, Commit und externe Wirkung.

### Stufe 1 – Benannte Spaces und lokales Protokoll
- Doc-Version 5 und Migration 4 → 5; IDs, Rechte-Grundmodell, Meter pro Space, Byte-Limits, Revisionen.
- RPC-Claims (dauerhaft, Argument-Hash, Fristen), Generationen, Pending-Ops, `cancelOperation`, Mailboxes/ACKs,
  Snapshot-Pagination, `RemoteSpace` mit Client-Wartegrenze.
- **Abnahme:** zwei Spaces ohne ID-Kollision; Take-Commit mit verlorener Antwort liefert nach Prozessneustart
  dasselbe Ergebnis ohne zweiten Take; Storage enthält keine Klartext-Argumente; lange Polls, Claim-Ablauf,
  `RequestExpired`, falsche Argumente, alte ACKs geprüft; Migrationsfixtures erhalten Entries, Txns, Outbox.

### Stufe 1b – Overlay, Autorisierung, Enrollment
- Gate mit Grenzen und Dienst-Allowlist; Schicht A/B mit verbindungsgebundener Challenge; Delegation mit
  `RouterLease`; vollständige Typ-/Operations-ACLs.
- Control Space single plus asynchroner Snapshot und dokumentiertes Restore; Supervisor und lokaler Recovery
  Space; Enrollment ohne Router mit Rate-Limits.
- NetBird-Testmatrix (4.6), Schlüsselablage auf Zielplattformen, Widerruf und Grant-Ablauf.
- **Abnahme:** Handy/Desktop gepairt; ungepaarter Peer nur Enrollment; Fehlversuchslimit greift; weitergereichte
  Challenge (fremde `observedPeerId`) scheitert; gefälschtes zweites Hello und fremde Dienste abgewiesen;
  geschützte Typen weder nehmbar noch über Lease/Txn löschbar; Widerruf innerhalb der Grenze; Restore aus
  Snapshot mit neuer Inkarnation funktioniert.

### Stufe 2 – Router und expand
- Journal mit Unterrequest-Deduplizierung und Recovery; feste Policy-Versionen; Regeln 7.1; drain;
  `readAll` mit `allowPartial`/`waitForComplete`; Capability-Verzeichnis; Delegation mit Policy-Versionsprüfung.
- **Abnahme:** 1000 Jobs, 3 Members, 6 Worker: höchstens ein destruktiver Commit je Entry; Absturz nach jeder
  Journal-/RPC-/ACK-Grenze auf persistentem Storage ohne Doppelwirkung; Retries ändern die Zielbindung nicht;
  drain mit laufenden Takes verliert und verdoppelt nichts; Delegation mit alter Policy-Version, falscher
  Audience, abgelaufener Router-Lease oder falschem Argument-Hash scheitert; Idempotenz-Beispiel und
  Gegenbeispiel dokumentieren die Grenze externer Wirkungen.

### Stufe 3 – Replikation und kontrollierte Übernahme
- Snapshot-/Stream-Import, lww/set mit versionierten Deletes, Leases, Deduplizierung, Offline-Rejoin.
- primary/sync mit festem Standby; Control Space wechselt auf primary/sync; Router-Lease über sync-Commits;
  Fencing-Adapter nach 5.5; Promotion nach 5.3.
- **Abnahme:** 10-min-Partition mit konkurrierenden Writes/Deletes/Erneuerungen konvergiert; alter Put belebt
  keinen Tombstone wieder; natürlicher Ablauf löscht keine neuere Erneuerung; Snapshot unter Last verliert nichts;
  ohne Standby keine Bestätigung; Promotion ohne verifizierten Fencing-Nachweis, mit Marker-Adapter oder auf
  falschem Standby verweigert; alter Router kann nach Lease-Ablauf nichts mehr delegieren; bestätigte Ergebnisse
  bleiben nach Promotion erhalten; alter Primary startet nicht schreibend.

### Stufe 4 – Weitere Clients
- Desktop/CLI-Paket, optional Browser-Gateway.
- **Abnahme:** Steuerung ohne Handy; Wiederverbindung rekonstruiert Status per Snapshot/Events; keine
  Identitätsvermischung zwischen Browser-Sessions; Client-Abbruch beeinflusst Host-Worker nicht.

## 12. Teststrategie

- **Simulator:** mehrere Harnesses, deterministische Latenz, Verlust, Duplikate, Partitionen, Uhrsprünge,
  Neustarts; Gegenmodell für Reservierungen, Requestzustände und Merge-Regeln.
- **Persistenz:** echte Storage-Backends, Prozessabbruch/Reopen an Commit-, Replikations- und Antwortgrenzen.
  MemoryStorage allein ist kein Nachweis.
- **Invarianten:** eine aktive Reservierung und ein destruktiver Commit pro Entry (expand/primary); Abort erlaubt
  erneutes Nehmen; ein Ergebnis pro gültigem Request; kein Zielwechsel bei unklarem Ausgang; vollständige Batches;
  keine Wiederbelebung durch alte Deletes/Puts; lww/set konvergieren.
- **Recovery:** Router nach Gewinnerwahl/Commit/ACK unterbrechen; späte Verlierer, abgelaufene Txns, verlorene
  Antworten, doppelte Commands, zwei Recovery-Versuche, Standby-Ausfall, alte Primary-Neustarts.
- **Zeit:** Lease-Ablauf beim nächsten Settle wirksam, auch bei verzögertem Reaper; Router-Lease mit Uhrversatz;
  Worker-Wirkungen nach Lease-Ablauf mit Idempotenz/Fencing.
- **Routing:** HRW-Änderung abgelehnt; neue leere Regeln funktionieren; drain erhält Suchbarkeit; Teilantworten
  markiert.
- **Sicherheit:** Rollenmatrix, Supertypen, Enrollment-Replay und -Ratenlimit, Challenge-Relay, Delegationsfälschung
  (Signatur, Audience, Policy-Version, Argument-Hash, Router-Lease), Stream-Zugriff, Widerruf bei Partition,
  Gateway-Principal-Trennung, keine Geheimnisse im Log.
- **Integration:** zwei pi-serverd/Gates auf localhost mit Test-Identitätsadapter; dann echte NetBird-Umgebung,
  Zielplattformen und echter Fencing-Adapter. Der Simulator kann Overlay-Identität und Fencing nicht abnehmen.
- **Last:** 10 000 Entries, 3 Members, vollständige Dokumentbytes inklusive Claims/Stream/Tombstones; p95/p99,
  Speicher, Journalwachstum, Replikationsrückstand, Verhalten an jedem Budgetlimit.

## 13. Festgelegte Entscheidungen und Gates

Festgelegt in v3:

1. Grundlage ist der Vertrag aus 2.1; kein allgemeines Exactly-once für externe Wirkungen.
2. Kein mTLS; WireGuard plus verbindungsgebundene App-Challenge (4.2, 4.3) – vorbehaltlich F3.
3. Control Space in 1b–2 single mit asynchronem Snapshot und Restore; primary/sync ab Stufe 3.
4. Keine automatische Promotion; manuelle Promotion nur nach verifiziertem Fencing (Marker nur im Simulator).
5. Recovery Space lokal, nicht repliziert.
6. RPC-Ergebnisse dauerhaft, Argumente nur als Hash, Fristen 24 h bis 7 Tage.
7. Delegation signiert, kanonisch kodiert, an Audience/Request/Argument-Hash/Policy-Version/Router-Lease gebunden.
8. Pairing: 256-Bit-Token, Peer-Bindung, Schlüsselbesitz, 3 Fehlversuche, 1 Versuch pro Peer und Minute.
9. Keine Migration bestehender HRW-Bestände; `addMember` ändert keine Zuordnung; drain bricht nur über den Member ab.
10. lww/set nur mit ausdrücklicher `semantics`; Deletes versioniert, natürlicher Ablauf ohne Tombstone.
11. Mailbox höchstens 7 Tage plus Byte-Limit; 24 h Mindestspeicherung abgeschlossener Ergebnisse.

Gates (vor der jeweiligen Stufe nachzuweisen):

1. Koordinator-Host und unabhängig erreichbarer Recovery-Zugang (vor 1b).
2. Konkreter Fencing-Adapter mit Neustartsperre, real getestet (vor 3).
3. Zulässige Uhrunsicherheit, HLC-Zukunftsgrenze, Sperrverhalten; gelten auch für Grants und Router-Lease (vor 1b).
4. Konkrete Byte-/Anzahl-/Frame-Limits, Snapshot- und Generationslaufzeiten aus Lasttests (vor 2).
5. NetBird-Version, Deployment, Lizenzen, Management-API-Rechte, Ergebnisse der Testmatrix 4.6 (vor 1b).
6. Schlüsselablage auf Zielplattformen (Android-Keystore: Ed25519 oder P-256), WebCrypto für Browser (vor 1b/4).

## 14. Offene Fragen

Fragen, die ohne Entscheidung des Betreibers nicht beantwortbar sind. F8, F10, F12, F13, F14 sind entschieden (Empfehlung übernommen). Hinweis zu F1/F2: Abschnitt 4.1.1 plant VPS; dann gilt für F1 Fencing über die Anbieter-API (Server stoppen, Neustart sperren) und für F2 Koordinator und Standby bei verschiedenen Anbietern/Zonen. Empfehlungen sind Vorschläge.

| # | Frage | Empfehlung | blockiert |
|---|---|---|---|
| F1 | Auf welcher Infrastruktur laufen die Hosts (Bare Metal mit BMC, VMs, Container, Raspberry Pi o.ä.)? Davon hängt der Fencing-Adapter ab. | Für Heimgeräte: schaltbare Steckdose/PDU mit API; für VMs: Hypervisor-API | Stufe 3 |
| F2 | Welcher Host ist Koordinator, welcher Standby? Läuft der Koordinator getrennt von der NetBird-VM? | stets laufender Heimserver als Koordinator; NetBird-VM getrennt | 1b |
| F3 | Reicht WireGuard plus App-Challenge, oder gibt es eine Anforderung (Compliance, Audit) für TLS/mTLS auf dem Space-Port? | kein mTLS | 1b |
| F4 | Challenge pro Verbindung (v3) oder Signatur pro Request (v2)? | pro Verbindung; Delegation ohnehin pro Request signiert | 1b |
| F5 | Ist für den Control Space in 1b–2 ein Restore mit möglichem Verlust der letzten Minuten akzeptabel? | ja; Steuerdaten sind klein, Enrollments wiederholbar | 1b |
| F6 | Welche Uhrunsicherheit ist zulässig (NTP auf allen Hosts)? | 2 s, Sperre ab 5 s; HLC-Zukunftsgrenze 60 s | 1b |
| F7 | Grant-Laufzeit 60 s und Router-Lease 60 s/20 s: akzeptabel als maximale Widerrufsverzögerung? | ja | 1b |
| F8 | Werden RPC-Ergebnisse 24 h oder bis 7 Tage aufbewahrt? | 24 h | 1 |
| F9 | Welche Inhalte gelten als personenbezogen, und braucht es eine Löschfunktion pro Principal über Entries, Claims und Mailboxes? | ja, als Admin-Command in Stufe 2 | 2 |
| F10 | Ist Teilergebnis-Lesen (`allowPartial`) für Dashboards Standard oder nur explizit? | nur explizit; Dashboard setzt es | 2 |
| F11 | Startwerte für Frame (256 KiB), Verbindungen pro Peer (32), Handshake (5 s) passend? | bis Lasttest übernehmen | 1b |
| F12 | Wird das Browser-Gateway gebraucht, oder genügen Handy-App und CLI? | zurückstellen | 4 |
| F13 | Wird automatische Migration (HRW-Erweiterung) gebraucht? Sie ist nicht in v3. | erst bei konkretem Bedarf | – |
| F14 | Sollen die v2-Dokumente (`federation-plan-v2*.md`, `.DOCS-UPDATE.md`) archiviert oder gelöscht und `README.md` auf v3 umgestellt werden? Sie verweisen auf nicht existierende Dateien und erklären die gründlichere v1 für veraltet. | README auf v3 umstellen, v2 als „ersetzt“ markieren | – |

## Anhang A – Alternative ohne Overlay: SSH-Zertifikate

Wenn kein NetBird betrieben werden soll und alle Hosts per SSH erreichbar sind:

- Eine CA signiert Host- und Client-Schlüssel (`ssh-keygen -s`); Clients vertrauen der CA (`@cert-authority`).
- Zertifikate mit Principals, kurzer Laufzeit, Erneuerung über den Control Space; Widerruf per KRL oder
  Nicht-Erneuern.
- Identität: pro Rolle `cert-authority,principals="…",restrict,command="space-gate --peer …" <CA-pub>` in
  `authorized_keys`; `space-gate` über stdin/stdout. Zu verifizieren: Auswahl der passenden Zeile bei mehreren
  `cert-authority`-Zeilen mit verschiedenen Principals.
- Pairing braucht einen authentifizierten verschlüsselten Kanal (PAKE für Kurzcodes oder SSH mit per QR geprüftem
  CA-Fingerprint plus starkem Token).
- Autorisierung, Delegation, Router-Lease und Recovery gelten unverändert. Nachteil: kein NAT-Traversal,
  Schlüsselverwaltung vollständig bei uns.

## Anhang B – Bewertung der v2-Vorschläge

| v2 | Vorschlag | Entscheidung in v3 | Begründung |
|---|---|---|---|
| 14.1 | Fencing-Adapter | **korrigiert übernommen** (5.5) | Interface sinnvoll. Korrigiert: `fence` muss Neustart sperren, der Supervisor prüft unabhängig; Marker-Datei ist eine Behauptung und nur im Simulator zulässig. Ergänzt: Daten-Fencing durch sync-Bestätigung, Router-Lease. |
| 14.2 | Pairing mit Challenge, Rate-Limit | **übernommen** (4.5) | 256 Bit und Rate-Limits übernommen. Im v2-Code fehlte der Vergleich des Token-Hashs, und die Nonce war nicht definiert; v3 nutzt die Verbindungs-Challenge. |
| 14.3 | LWW nur Zustand, Set nur Fakten, Tombstones | **teilweise** (6.4, 7.2) | `semantics`-Pflichtfeld übernommen. Tombstone mit Version −1 abgelehnt: jeder alte Put würde ihn überschreiben. Tombstone bei natürlichem Lease-Ablauf abgelehnt: er könnte eine neuere Erneuerung löschen. |
| 14.4 | „2-Phase-Commit“ im Router | **ersetzt** (5.1) | Der v2-Code führt die entfernte Wirkung ohne Unterrequest-ID aus und markiert Fehler mit unbekanntem Ausgang als `failed`: Doppelwirkung möglich. Der v1-Mechanismus (Journal plus Deduplizierung am Ziel) löst das Problem bereits. |
| 14.5 | Signierte Delegation | **korrigiert übernommen** (4.4) | v2 akzeptierte *ältere* Policy-Versionen und wies neuere ab (falsche Richtung), nutzte nicht-kanonisches JSON und eine nicht vorhandene Bibliothek (`verify.detached`), Replay-Schutz nur behauptet. v3: kanonische Kodierung, `node:crypto`, Argument-Hash, Audience, Router-Lease. |
| 14.6 | Async Standby mit automatischer Promotion in 1b | **abgelehnt**, Ziel anders erreicht (5.2) | Widerspricht 2.1 (async ist nie sichere Promotion) und 5.3 (keine automatische Wahl). Der v2-Code repliziert nur Enroll-Writes, nicht die Commit-Historie. v3: single plus asynchroner Snapshot und Restore in 1b, primary/sync ab 3. |
| 14.7 | mTLS + Challenge | **abgelehnt** (4.2, F3) | Die Begründung „IP-Spoofing“ trifft im WireGuard-Overlay nicht zu. NetBird stellt keine X.509-Zertifikate aus; selbstsignierte Zertifikate ohne CA prüfen nichts. Zweite PKI ohne neue Garantie. Die Challenge im v2-Code war nicht an die Verbindung gebunden; v3 bindet sie an `observedPeerId` und Gate. |
| 14.8 | Federationsweiter Snapshot | **abgelehnt**; `waitForComplete` übernommen (7.1) | Nacheinander gelesene Member-Stände sind kein konsistenter Snapshot; unbegrenzter In-Memory-Cache. |
| 14.9 | Ergebnisse nur im Speicher, nur Hashes dauerhaft | **abgelehnt**; Datenminimierung übernommen (6.2) | Nach Neustart wäre das Ergebnis eines Takes verloren und der Entry mit ihm; bricht 2.1 und die Abnahme von Stufe 1. Argument-Hash und Fristen bleiben. |
| 14.10 | drain bricht laufende Requests im Journal ab | **abgelehnt**; Abbruch über `cancelOperation` am Member (7.1) | Einseitiges `cancelled` bei unbekanntem Ausgang kann Takes verlieren oder verdoppeln. `$in`-Abfragen gibt es im Core nicht. |
| 14.11 | Recovery Space replizieren | **abgelehnt** (5.4) | Löst kein reales Problem und macht den Recovery-Pfad von der ausgefallenen Infrastruktur abhängig. |
| 14.12 | Client-Gesamt-Deadline 60 s | **korrigiert übernommen** (6.3) | Als reine Client-Wartegrenze mit `OutcomeUnknown`; kein Default, weil `space_wait`/FOREVER legitim lange laufen. Im v2-Code wurde eine Dauer mit `Date.now()` verglichen. |
| 14.13 | `addMember` verteilt neue Daten neu, manuelle Migration | **abgelehnt** (7.1) | Gezielte Reads nach Feld fänden alte Daten nicht mehr; `write C, take A` ist nicht atomar. |
| 14.14 | RAID 10 später | **übernommen** (7.3) | – |
| 14.15 | NetBird-Testmatrix | **übernommen als Hypothesen** (4.6) | Erwartetes Verhalten ist zu messen, nicht vorauszusetzen. |
| 4.2 | Frame 64 KB, 100 Verbindungen, Handshake 5 s | **angepasst** (4.2) | 64 KB Frames fassen keinen Entry an der 64-KiB-Grenze; Startwert 256 KiB. |
| Doku | Verweise auf `federation-limitations.md` u.a., Team-Adresse, Aufwandsschätzungen | **nicht übernommen** | Dateien existieren nicht; Schätzungen ohne Grundlage. |
