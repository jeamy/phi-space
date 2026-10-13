# Föderierte Spaces v3 – konsolidierter Plan

Stand: 2026-10-13 (aktuelle Admission-Auflösung ergänzt; vierte Konsistenzprüfung: Nachweis für `NotCommitted`, historische Pending-Arbeit, Lauf-Recovery, Boot-Berechtigungen je Space und zu kleine Seitenbudgets präzisiert). Ersetzt `federation-plan-v1.md` (überarbeitete Fassung) und `federation-plan-v2.md`.

**Status:** Zielvertrag mit teilweise implementierten lokalen Grundlagen: Doc-Version 5, benannte Spaces,
Identitäten, lokale Request-Claims und persistente Testhilfen sind vorhanden. Der aktuelle Umfang und die offenen
Teile stehen im [Implementierungsstand](implementierungsstand.md) und im [Implementierungsfortschritt](implementierungsplan-v3.md#7-fortschritt).
Federation, Recovery und die Betriebserweiterung sind noch nicht abgenommen. Lokaler Netzwerk-RPC ist vorhanden,
ersetzt aber keine dieser Garantien. Eine Garantie gilt
erst als erfüllt, wenn ihre Abnahmekriterien (Abschnitt 11) und Gates (Abschnitt 13) erfüllt sind.

**Herkunft:** Grundlage ist die überarbeitete v1, weil sie den genaueren Vertrag enthält. Aus v2 sind die
brauchbaren Vorschläge übernommen und, wo nötig, korrigiert. Vorschläge, die Garantien der v1 brechen, sind nicht
übernommen. Die Bewertung jedes v2-Punkts steht in Anhang B, offene Fragen in Abschnitt 14.

Grundlage der Implementierung: [Implementierungsstand](implementierungsstand.md). Die historischen Kennungen B/L
sind in [spaces-v1.md](spaces-v1.md) nur noch für frühere Planverweise erhalten.

**Implementierungsnachweis 2026-10-09:** Das lokale Stufe-1-Protokoll (AP 1.1–1.9) ist implementiert
und in [ap1-abnahme.md](ap1-abnahme.md) geprüft. Gate, Schicht A/B und Replikation bleiben weitere Stufen.

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
- **Mailbox**: dauerhafte Events für Principal und Consumer, adressiert über `mailboxId`, `mailboxEpoch`, `seq`.
- **Overlay**: NetBird-Netz. Overlay-IPs sind Endpunkte, keine dauerhaften Identitäten.

### 2.1 Verbindliche Garantien und Grenzen

| Ebene | Vertrag |
|---|---|
| Lokaler Commit | Space-Mutation und RPC-Ergebnis werden atomar dauerhaft geschrieben. |
| Retry | Derselbe gültige Request liefert dasselbe Ergebnis ohne erneute Mutation, innerhalb des Fensters aus 6.2, **auch nach Prozessneustart**. |
| Take unter Txn | Höchstens eine aktive Reservierung pro Entry; Abort/Ablauf erlaubt erneute Reservierung. |
| Erfolgreicher Take | Höchstens ein erfolgreicher destruktiver Commit je Entry-Identität in expand/primary, **solange die Historie des Space ohne verlustbehafteten Restore fortgeführt wird** (Promotion nach 5.3 ist verlustfrei). Nach einem Restore aus asynchroner Kopie gilt die Garantie nur für den restaurierten Bestand unter der Quarantäne aus 5.2.2: wiederhergestellte Entries exklusiver Typen sind `restoredUnverified` und erst nach fachlicher Freigabe wieder nehmbar. |
| Fachliche Wirkung | Kein allgemeines Exactly-once für externe Effekte; das Ziel braucht Idempotenz oder gemeinsame Transaktion. |
| primary/sync | Bestätigte Operationen bleiben bei zulässiger Promotion erhalten (5.3). |
| Asynchrone Kopie | Backup/Lesekopie. Bestätigte Writes/Takes können beim Verlust des Primary fehlen. **Nie automatische und nie verlustfreie Promotion**; nur Restore mit neuer Inkarnation. |
| lww/set | Eventuelle Konvergenz nach vollständigem Austausch; keine exklusive Arbeitsvergabe. |
| Ergebnisfrist | Nach Löschung eines abgeschlossenen Ergebnisses (6.2) liefert ein Retry `ResultExpired` ohne Mutation. Ein genommener Entry, dessen Ergebnis bis dahin nie abgeholt wurde, ist für den Aufrufer verloren. |
| Restore (Data, 5.2.2) | Neue Dateninkarnation nur dieses Space bei unveränderter Control-Autorität. Alte Generationen liefern `IncarnationChanged`; abhängige Router-Arbeit und Läufe werden `needsReview`; restaurierte exklusive Entries bleiben bis `releaseRestored` gesperrt. |
| Unbekannter Request nach Promotion | `NotCommitted` nur nach dem vollständigen Nachweis und dauerhaftem Negativclaim aus 6.2: erhaltene Generation, gleiche Autorität/Dateninkarnation, verlustfreie Historie und ausgeschlossenes altes Replikat. Erst danach darf der Client mit neuer ID beginnen. Ablauf oder verlorene Historie liefern keine solche Freigabe. |
| Restore (single) | Alte Generationen erlauben keine neuen Wirkungen (`IncarnationChanged`). Erhaltene Member-Claims bleiben für neu autorisierte Auflösung nutzbar; verlorener Journal-/Claim-Zustand erfordert fachliche Klärung (`needsReview`, 5.2.1). |

Netzfehler können einen unbekannten Ausgang hinterlassen. Der Client fragt mit derselben Request-ID nach und
startet bei Unsicherheit keine neue Mutation. Dauerhaft verlorener Storage ist in expand Datenverlust.

**Autoritätsinkarnation:** `authorityId` ist eine zufällige, unveränderliche 256-Bit-ID des Control-Verbunds.
Nur ein Restore ersetzt sie, über den lokal autorisierten Übergang aus 5.2.1. Sie ist kein sortierbarer Zähler.
Grants, Router-Leases, Delegationen, Policy-Versionen und Epochen-Ankündigungen sind an sie gebunden.
Ein Member akzeptiert genau seine lokal installierte Autorität; ein höherer Zähler legitimiert keine fremde
`authorityId`. Promotion, Router-Wechsel und Single-Umschaltung behalten die Autorität bei.

**Epochen** (drei getrennte Zähler; „Epoche“ ohne Zusatz ist unzulässig): Innerhalb ihrer jeweiligen Inkarnation
steigen sie monoton. Nach einem autorisierten Restore beginnen `primaryEpoch` und `routerEpoch` in der neuen
Autorität bei 1; Werte verschiedener Autoritäten werden nie numerisch verglichen. `mailboxEpoch` wird innerhalb
derselben Mailbox-Identität nie zurückgesetzt; Restore ersetzt die Mailbox-Identität.

| Name | Gilt für | Erhöht durch |
|---|---|---|
| `primaryEpoch` | einen logischen Space mit Replikat oder Restore | Promotion (5.3), Umschaltung auf Single (5.3.1), Data-Restore (+1, 5.2.2); neuer Namensraum bei Control-Restore (5.2.1) |
| `routerEpoch` | Router-Leases einer Federation | Router-Neustart/-Wechsel und Control-Promotion; neuer Namensraum bei Restore |
| `mailboxEpoch` | eine Mailbox | Mailbox-Reset |

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

Das Diagramm fasst Standby und Data Member B verkürzt auf einem Host zusammen. Nach 4.1.1 läuft der synchrone
Standby auf einem eigenen VPS mit Koordinator-Dimensionierung; Data Members liegen auf weiteren Hosts.

- Agenten benutzen die Tools wie heute; mit `space` gehen Operationen über `RemoteSpace` bzw. `FederatedSpace`.
- Clients halten keinen zentralen Betriebszustand; Host-Worker laufen ohne Dashboard weiter. Clients behalten
  eigene Request-IDs bis zum Abschluss.
- Router-Journal und RPC-Claims liegen in internen dauerhaften Dokumenten; Agenten-Nutzdaten nie im Control Space.
- Der Router-Standby läuft passiv (kein Lease, keine Delegationen) und wird erst bei der Promotion nach 5.3
  aktiviert: `primaryEpoch` und `routerEpoch` erhöhen, alte `RouterLease` ablaufen lassen, zunächst
  `awaitingDurability`. Nach autorisierter Single-Umschaltung beginnt Router-Recovery (5.3.1).

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
gegen dessen Ausfall. Data Members dürfen auf weitere VPS verteilt werden. Der Fencing-Adapter aus 5.5 muss den
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
- Grenzen (Startwerte vor 1b festlegen, per Lasttest vor 2 bestätigen, Gate 4): Handshake ≤ 5 s; Frame ≤ 256 KiB
  (muss größer sein als `maxEntryBytes` 64 KiB plus Protokoll-Overhead); höchstens 32 gleichzeitige Verbindungen
  pro Peer; Rate-Limit für Handshakes.
- **Commit-Grenze:** Ein Commit-Batch ist unteilbar (6.1). Deshalb gilt `maxCommitBytes` ≤ Frame minus
  Protokoll-Overhead (Startwert 192 KiB, F11/Gate 4; Summe der kanonisch kodierten Deltas eines Commits einschließlich
  Claims und Metadaten). Vor jeder Txn-Erweiterung werden der zusätzliche Zustand und eine konservative Obergrenze
  für Commit **und** Abort einschließlich Ergebnis/Claims, Sperrfreigaben und interner Folgeaufträge reserviert.
  Übersteigt das einen Batch oder das Speicherbudget, scheitert diese Erweiterung vor ihrer Mutation mit
  `ResourceExhausted`; bisherige Txn-Arbeit bleibt abschließbar. Der Abschluss darf nicht erstmals am Byte-Limit
  scheitern. Task-Take und Ergebnis bleiben ein atomarer Commit. Nur fachlich zerlegbare Batch-Writes bzw.
  Run-Vorbereitungen werden vorab in idempotente Teilcommits mit Fortschrittsmanifest aufgeteilt.
  Interne Folgewirkungen folgen 6.1; auch sie dürfen das Frame-Limit nicht umgehen.
- Nur `serviceId: space`. `sessions`/`chat` bleiben auf diesem Eingang gesperrt.
- `pi-client` erhält eine TCP-Transport-Factory; Kompatibilität des Byte-/CBOR-Transports vor Umsetzung prüfen.

**Kein mTLS auf dem Space-Port in v3.** Begründung: WireGuard liefert Verschlüsselung und Peer-Bindung; die App-Challenge (4.3)
liefert Schlüsselbesitz und Bindung an die Verbindung. mTLS würde eine zweite PKI (X.509, Ausstellung, Rotation,
Widerruf) erfordern, die Node ohne `openssl` oder Zusatzbibliothek nicht erzeugen kann, ohne neue Garantie. TLS
kommt nur am Browser-Gateway zum Einsatz (Abschnitt 10). Offene Frage F3.

### 4.3 Identität

| Schicht | Vertrag |
|---|---|
| A: Overlay | Quell-IP → Management-API → unveränderliche Peer-ID und Gruppen; Cache höchstens 60 s. |
| B: App-Schlüssel | Challenge pro Verbindung (unten). Erlaubte Schlüssel sind `PeerKey`-Entries im Control Space. |

Schicht A hängt von der NetBird-Management-API ab. Fällt sie länger als die Cache-Laufzeit aus, weisen alle
Gates neue Verbindungen ab (4.6). Der Recovery-Pfad hängt deshalb weder von Schicht A noch vom Gate ab (5.4).

**Challenge (Schicht B):** Das Gate sendet `{gateHostId, observedPeerId, connNonce (32 Byte), protocol,
issuedAt}`. Der Client prüft, dass `gateHostId` dem erwarteten Host und `observedPeerId` seiner eigenen
Overlay-Identität entspricht, und signiert die kanonische Kodierung (4.4). Damit kann ein Angreifer, der selbst
Peer ist, eine Challenge nicht an ein Opfer weiterreichen: das Opfer würde eine fremde `observedPeerId` erkennen.
Die Nonce ist einmalig und höchstens 30 s gültig. Signaturen pro Request sind nicht nötig, weil WireGuard den
weiteren Verkehr der Verbindung an den Peer bindet (offene Frage F4).

- Algorithmus: Ed25519; wo der Plattform-Keystore Ed25519 nicht unterstützt, ECDSA P-256 (Gate 6).
- Schicht B ist Pflicht für Control Space, Admin, Router, Gateway, Replikation und delegierende Hosts. Einzige
  Ausnahme ist das Enrollment (4.5): Ein ungepaarter Peer beweist mit der Challenge nur den Besitz des *neuen*
  Schlüssels und erhält ausschließlich die Rolle „ungepaarter Peer“ aus Abschnitt 9. Direkte
  Data-Space-Clients dürfen nur mit A arbeiten, wenn eine explizite Peer-/Gruppenregel `member` oder `observer`
  zuweist. Ohne Regel kein Zugriff. Gruppen- und App-Rechte werden geschnitten, nie vereinigt.
- Benutzerrollen `admin`, `member`, `observer`; Dienstrollen `host`, `router`, `replicator`, `supervisor` mit
  explizit erlaubten Spaces und Operationen. Ein Host ist dadurch kein Admin.
- Autorisierung bei jedem Request und erneut vor dem entscheidenden Commit. Grants gelten höchstens 60 s;
  Invalidierungen schließen Sessions und beenden offene Polls. Ohne rechtzeitig erneuerten, autoritativen Grant
  werden neue Operationen abgewiesen; noch unversiegelte Operationen bleiben `pending`, bis
  ein gültiger Grant bzw. eine gültige Delegation vorliegt oder ihre Deadline abläuft (dann endgültig erfolglos). Replikate stellen keine Grants aus altem Zustand aus.
  Bereits versiegelte Commit-Kandidaten aus 7.2 werden nicht erneut autorisiert oder nachträglich abgebrochen;
  ihre Wirkung ist für Recovery festgelegt, auch wenn die Bestätigung noch aussteht. Vor dem Versiegeln müssen
  Rechte, Deadline und Lease gültig sein. Bestätigte Arbeit wird durch Widerruf nicht rückgängig gemacht.
- **Auflösung nach Rechteentzug:** Ein weiterhin authentifizierter und nicht widerrufener App-Schlüssel darf
  beim Control-Primary einen kurzlebigen `resolution`-Grant für eigene bereits angenommene Requests erhalten.
  Er erlaubt nur Status/Ergebnisabruf und Cancel/Abort, keine neue fachliche Wirkung oder Delegationserneuerung
  zum Commit. Ohne gültigen Grant gilt auch hier die Ausfallsperre. Nach Schlüssel-/Peer-Widerruf gibt es keinen
  Selbstzugriff; ein aktuell autorisierter Admin übernimmt die Auflösung als gesondert auditierte Dienstaktion.
  A-only-Clients ohne verbleibende authentifizierte Berechtigung benötigen ebenfalls diese Admin-Auflösung.
- **Widerruf wirkt innerhalb Grant-Laufzeit plus Zeitunsicherheit**, nicht sofort unter jeder Partition.
- Grants stellt nur der autoritative Control-Primary aus. Ist er nicht erreichbar, laufen nach Grant-Laufzeit
  **alle** entfernten Operationen auf **allen** Members aus, nicht nur Enrollment und Commands (5.2). Lokale
  Agenten, lokale Worker, Reaper und Lease-Ablauf eines Hosts laufen weiter.
- Recovery verwendet einen gesondert lokal provisionierten Admin-Schlüssel (5.3); sein Widerruf wird auf jedem
  Recovery-Host separat bestätigt. Desktop-Schlüsseldateien `0600`.

### 4.4 Delegation

Ein Host weist lokale Agenten nur im eigenen Principal-Namensraum aus. Der Router reicht diese Identität mit einem
signierten Delegationsnachweis weiter:

```ts
type RouterLease = {
  id: string;
  routerPeerId: PeerId;
  routerEpoch: number;
  controlSpaceId: SpaceId;
  authorityId: string;          // lokal installierte Control-Autorität
  controlPrimaryEpoch: number;  // primaryEpoch des Control Space beim Ausstellen
  expiresAt: number;
};
type SignedRouterLease = { lease: RouterLease; issuer: PeerId; signature: string }; // Supervisor des Control-Primary

type Delegation = {
  issuer: PeerId;               // Router; muss lease.routerPeerId sein
  routerLease: SignedRouterLease; // nicht vom Router selbst signiert (5.2)
  principal: Principal;         // ursprünglicher Aufrufer
  targetSpace: SpaceId;         // Audience
  targetPrimaryEpoch?: number;  // bei primary-Zielen: erwartete primaryEpoch
  operation: string;            // z.B. "take", "pollOperation", "cancelOperation"
  requestId: string;            // Identität DIESES Aufrufs
  requestGeneration: string;    // Generation dieses Aufrufs am Ziel (6.2)
  argumentHash: string;         // Hash der Argumente DIESES Aufrufs einschließlich targetRequest
  targetRequest?: {            // nur Folgeaufrufe; Principal und Space wie oben
    requestId: string;
    requestGeneration: string;
    method: string;
    argumentHash: string;       // unveränderlicher Hash des Ursprungsrequests
    policyVersion: number;
  };
  policyVersion: number;        // Ursprungs-Policy; bei Folgeaufrufen gleich targetRequest.policyVersion
  expiresAt: number;            // ≤ 60 s, ≤ routerLease.lease.expiresAt
};
```

Die Delegation enthält alle Bestandteile des RPC-Claim-Schlüssels aus 6.2 (Principal, Ziel-Space,
Request-Generation, Request-ID) sowie bei primary-Zielen die `primaryEpoch`.

- **Kanonische Kodierung** für Signatur und Hashes: JSON nach RFC 8785 (sortierte Schlüssel, feste Zahlenform),
  eigene kleine Implementierung ohne Abhängigkeit. `JSON.stringify` allein ist nicht deterministisch genug.
- Signatur mit dem Router-Schlüssel (`node:crypto`); der öffentliche Schlüssel steht als `PeerKey` mit Rolle
  `router` im Control Space. Die eingebettete `RouterLease` trägt eine **zweite Signatur** des Supervisors des
  Control-Primary (`PeerKey` mit Rolle `supervisor`), die er erst nach dauerhaftem Commit der Lease ausstellt
  (5.2). Ein Router kann sich so keine eigene Lease verlängern.
- Der Member prüft beide Signaturen, `issuer = lease.routerPeerId`, Audience, die lokal installierte
  `authorityId`, Ablauf mit Zeitunsicherheit, `routerEpoch` und `controlPrimaryEpoch` gegen seine dauerhaft
  gespeicherten Höchstwerte. Bei primary-Zielen muss `targetPrimaryEpoch` für **neue** Requests der eigenen
  entsprechen. Für Retries und Folgeaufrufe zu einem vorhandenen Claim genügt eine `targetPrimaryEpoch` derselben
  Autorität, die nicht größer als die eigene ist; der Claim wird dann unabhängig von der Epoche beantwortet bzw.
  fortgeführt, sofern der Claim nicht aus einem verlustbehafteten Restore stammt (5.2.2).
  Eine unbekannte ID mit älterer Epoche wird nach der Prüfreihenfolge aus 6.2 aufgelöst;
  `NotCommitted` ist keine pauschale Antwort auf einen fehlenden Claim und erzeugt keine fachliche Wirkung.
  `operation` und `argumentHash` müssen zum tatsächlichen Aufruf passen; der Scope muss ihn erlauben.
- **Neue Operationen:** Generation innerhalb der Zulassungsfrist; ältere Policy-Versionen werden abgewiesen.
  Bei einer neueren Version lädt der Member die Policy nach; ohne Erfolg wird abgewiesen.
- **Folgeaufrufe:** Poll, Ergebnisabruf, Cancel sowie Gewinner-Commit/-Abort referenzieren über `targetRequest`
  den bereits vorhandenen Claim desselben Principals. Methode, Hash und ursprüngliche Policy-Version werden
  gegen diesen Claim geprüft. Ein fehlender Claim legitimiert keine neue Mutation. Jede mutierende Folgeaktion
  besitzt eine eigene stabile Request-ID in einer zum ersten Aufruf gültigen Generation; ihr Claim wird separat
  dedupliziert. Wiederholte Polls verwenden je Aufruf eine neue ID und erzeugen keinen dauerhaften Mutationsclaim;
  sie lesen den aktuellen Zustand des Zielclaims. Ein Retry der ursprünglichen Mutation behält hingegen ihre
  ursprüngliche ID, Methode und fachlichen Argumente bei; nur der erneuerbare Rahmen (6.2) darf sich ändern.
- **Nach Policy-Änderung:** Zielbindung und Ursprungs-Policy bleiben erhalten; aktuelle Rechte entscheiden über
  die Zulässigkeit der Folgeaktion. Nach Entzug der Wirkungsrechte sind nur Auflösung und Cancel/Abort gemäß
  `resolution`-Grant aus 4.3 erlaubt. Der eigene Folgeclaim ersetzt diese Rechteprüfung nicht.
- **Generationsablauf:** Die Zulassungsfrist begrenzt neue IDs, nicht die Betreuung bekannter Claims.
  Bestehende Pending-Requests bleiben nach Generationsablauf abfragbar und mit passenden aktuellen Rechten
  entscheidbar. Dasselbe gilt für Retries bekannter mutierender Folgeaufrufe. Unbekannte IDs einer abgelaufenen
  Generation werden immer abgewiesen, auch wenn sie einen bekannten `targetRequest` nennen.
- **Lange Operationen:** Ein Poll mit gültigem Wirkungs-Grant erneuert zugleich die Autorisierung des Zielclaims.
  Die signierte `targetRequest`-Referenz bindet diese Erneuerung an Methode, Hash und ursprüngliche Generation;
  die Delegation gilt höchstens 60 s und nie länger als Router-Lease oder Grant. Ein `resolution`-Poll erneuert
  keine Wirkungsrechte. Ohne gültige Wirkungsdelegation bleibt ein unversiegelter Request pending bis zur
  Erneuerung oder Deadline; `FOREVER` bleibt zulässig. Router-Betreuung läuft serverseitig auch ohne UI-Polls.
- **Replay:** Mutierende Aufrufe treffen ihren eigenen Claim und liefern dessen gespeichertes Ergebnis;
  abweichende Methode/Argumente ergeben `RequestConflict`. Request-IDs sind nach Principal/Space/Generation
  namensraumgebunden; gleiche ID-Strings verschiedener Principals kollidieren nicht. Eine fremde Zielreferenz
  wird nie aufgrund eines gleichen ID-Strings akzeptiert.

- Gateway-Benutzer sind eigene Principals. Quoten zählen delegierten Principal und Transport-Peer. Frei übergebene
  `owner`-Felder werden ignoriert.

### 4.5 Pairing

1. Gerät tritt dem Overlay bei; ein Admin weist die Gruppe zu.
2. Der Admin-Client erzeugt den Token **lokal** und sendet nur dessen Hash im Command `createEnroll`; der
   Supervisor legt daraus `Enroll {tokenHash (SHA-256), role, scope, allowedPeerId, expiresAt = +5 min,
   attempts: 0}` an. Der Klartext-Token erscheint weder im Command noch im Result noch im Control Space.
   QR enthält Endpunkt, Control-Space-ID und Token mit **256 Bit** Zufall. Klartext-Token wird nirgends geloggt.
3. Ungepaarte Peers dürfen ausschließlich den speziellen RPC `enroll` auf `serviceId: space` und die
   Abfrage ihres eigenen Enrollment-Ergebnisses verwenden; keine allgemeinen Entry-Writes, Token-Listen,
   Control-Reads, Abos oder Takes. Das ist die einzige Ausnahme von der
   Schicht-B-Pflicht für den Control Space (4.3). Voraussetzung ist eine NetBird-Gruppenregel, die den Peer für
   das Enrollment zulässt.
4. Ablauf: Peer verbindet (Schicht A), erhält die Verbindungs-Challenge aus 4.3, signiert sie mit dem **neuen**
   Schlüssel und sendet `enroll {token, publicKey, signature, requestId, requestGeneration}`. Der Token bleibt
   ausschließlich im flüchtigen Eingabepuffer des Enrollment-Handlers; generisches Request-Logging und
   persistente Request-Queues sind für diesen Eingang gesperrt. Der Supervisor prüft in dieser Reihenfolge:
   1. Ein `Enroll` mit `sha256(token) = tokenHash` existiert. Sonst Fehler ohne Zähländerung; dieser Fall
      zählt nur gegen das Peer-Limit aus Schritt 5.
   2. `observedPeerId = allowedPeerId`. Sonst Fehler **ohne** Erhöhung des Token-Zählers, damit ein fremder Peer
      keinen Token verbrennen kann.
   3. Ablauf und Versuchszähler.
   4. Signatur und Schlüsselformat. Erst ein Fehler hier erhöht `attempts`.

   Erst nach Prüfung werden Tokenverbrauch, `PeerKey`-Anlage und bereinigter Ergebnisclaim atomar am
   Control-Primary gespeichert. Persistierbar sind `tokenHash`, Peer-ID, Schlüsselfingerprint, Methode,
   Argument-Hash und Ergebnis, niemals Token oder rohe Request-Payload. Dies gilt ebenso für Journal,
   Commit-Stream, Replikation, Snapshots und Audit. Retries mit neuem Verbindungsnachweis verwenden dieselbe
   Anfrageidentität; der semantische Hash umfasst tokenHash und neuen öffentlichen Schlüssel, nicht die
   verbindungsspezifische Challenge/Signatur. Ein vorhandener eigener Claim wird vor der Prüfung auf bereits
   verbrauchten Token aufgelöst; Identitäts- und Schlüsselbesitzprüfung bleiben Pflicht.
5. Rate-Limits: höchstens 3 Fehlversuche des gebundenen Peers pro Token (danach ungültig), höchstens 1 Versuch
   pro Peer und Minute.
6. Manuelle Eingabe verwendet denselben starken Token. Kurze Codes brauchen ein getrenntes Verfahren (PAKE,
   Versuchslimit, Admin-Bestätigung) und sind nicht Teil von v3.

Bootstrap: Der erste Host legt Control Space und einmalig einen Bootstrap-Token an; der Supervisor bearbeitet ihn
ohne Router. Auch der Bootstrap-Token ist an eine `allowedPeerId` gebunden: Das erste Admin-Gerät tritt vorher dem
Overlay bei, und seine Peer-ID wird über die Management-API ermittelt und beim Anlegen eingetragen. Weitere Hosts
erhalten gebundene Einmal-Tokens und nur die Rolle `host`; Routingziele werden sie erst nach `addMember`.
Das erste Admin-Pairing wird **vor** `createEnroll` für weitere Hosts und vor Membership-Commands abgeschlossen.
Der lokal provisionierte Supervisor darf einmalig nur den ersten gebundenen Admin-Token anlegen; diese
Bootstrap-Befugnis wird mit dessen erfolgreichem Verbrauch dauerhaft geschlossen. Ein Script sendet spätere
Commands als dieser gepairte Admin, nicht aufgrund seiner SSH-Verbindung oder Host-Rolle. Der einmalige
Bootstrap-Token wird nur flüchtig angezeigt; bei Verlust vor Verbrauch wird er lokal ersetzt und der alte Hash
ungültig. Wiederholter Bootstrap eines bereits initialisierten Hosts eröffnet die Befugnis nicht erneut.
Nach Restore gilt stattdessen ausschließlich der Recovery-Admin-Übergang aus 5.2.1.

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
| Management + Relay | 1 h | direkte Tunnel können bestehen bleiben; ohne autoritative Gate-Erneuerung wird Space-RPC nach Cache-Ablauf gesperrt |
| Peer entfernt | – | Tunnel endet; Gate weist binnen Cache-Laufzeit ab |

**Ergebnisse (Stand 2026-10-08, Testumgebung auf `big`, Einzelheiten in [testumgebung-big.md](testumgebung-big.md) Abschnitt 12).**
Aufbau (Gate 5): NetBird-Server 0.80.0 (kombinierter Container mit Management, Signal, Relay und STUN) und Dashboard hinter nginx mit
TLS auf `spacebird.eibrain.org`, eingebauter Dex als Identity Provider, Linux-Agent 0.80.0 in rootless Docker mit Kernel-WireGuard,
Android-Client 0.60.3. Management-API: ein Service-User mit der Rolle Admin genügt für Gruppen, Setup-Keys, Policies und die
Peer-Liste (`GET /api/users/current` ist für ihn gesperrt). Gemessen:

- Gruppenregeln (Policy „Default“ aus): zwischen zwei Hosts der Gruppe `space-hosts` ist nur TCP 7421 offen; TCP 8080, TCP 22 und ICMP sind
  blockiert (Hypothese bestätigt, Policy wirkt auf Port-Ebene).
- Peer aus der Gruppe entfernt: Verkehr in beide Richtungen sofort blockiert, der Peer sieht keine anderen Peers mehr, die anderen führen ihn nicht
  mehr in der Peer-Liste. Ohne Neustart der Agenten. Ankunftszeit nicht gemessen; ob die Schicht-A-Auflösung im Gate (Cache 60 s) rechtzeitig
  abweist, ist daher offen.
- Verbindungsaufbau ist verzögert (lazy): ein Peer erscheint zunächst als „Idle“, die P2P-Verbindung entsteht beim ersten Verkehr.

**Ergänzung 2026-10-11:** Ein separater administrativer Komponentenproxy begrenzt
Fehler auf die eigenen Test-Peers host-b/member-2; der produktive Endpunkt und
übrige VPN-Nutzer bleiben aktiv. Im vollständigen 5-min-Management-Fall blieben
Signal, Relay und direkter TCP-Tunnel erhalten. Nach Cache-Ablauf verweigerte das
echte Data-Gate den Objektzugriff; nach 305 Sekunden Fehlerphase und Aufhebung
des Fehlers war dieser wieder erfolgreich. Dies bestätigt die Sicherheits-
hypothese für den gezielten Erreichbarkeitsausfall dieser Peers, nicht einen
globalen Management-Serverabsturz. Messpunkte stehen in
[netbird-management-5m.json](../test/evidence/ap1b-2026-10-11/netbird-management-5m.json).

**Vollständige Abnahme vom 2026-10-11:** Management 305,3 s und 3604,3 s,
Signal 608,6 s, Relay 1807,3 s und Management + Relay 3604,0 s sind abgeschlossen.
Jeder Fall endet mit erfolgreichem Objektzugriff. Gruppenentzug und echtes
Peer-DELETE sperrten den Zugriff nach 2,895 s beziehungsweise 2,823 s.
Frische Handy-Erstkopplung, Schlüsselsteuerung, Hintergrund und kontrollierter
Doze sind ebenfalls geprüft. [Abnahme und Grenzen](ap1b-abnahme.md),
[Messungen](../test/evidence/ap1b-2026-10-11/acceptance-summary.json).

Der begrenzte Testproxy unterbrach komponentenweise die Erreichbarkeit für zwei
eigene Peers. Der globale kombinierte Server und seine Datenbank wurden dabei
nicht gestoppt. Direkter TCP-Zugriff ist kein Beweis für gültigen Space-Zugriff:
Bei Management-Ausfall blieb der Tunnel bestehen, das Gate verweigerte nach
Cache-Ablauf. Signal-Reconnect wurde durch Neustart nur des eigenen Testagenten
ausgelöst. Alle eigenen Fault-Regeln und die Desktop-Ausnahme wurden entfernt.

## 5. Control Space, Router, Supervisor, Recovery

| Typ | Schreibt | Inhalt |
|---|---|---|
| `Member` | Router nach Command | Identitäten, Endpunkte, Aufnahmezustand, Routingzuordnung |
| `FederationPolicy` | Router nach Command | validierte Policy mit `policyVersion` |
| `PeerKey` | Supervisor | Principal, öffentlicher Schlüssel, Algorithmus, Rollen, Scope, Zustand `active \| revoked` |
| `Enroll` | Supervisor nach Command `createEnroll` | 4.5 |
| Enrollment-Ergebnisclaim | Supervisor nach geprüftem `enroll`-RPC | nur bereinigte Daten nach 4.5, kein Token-Entry |
| `Command` / `Result` | admin / Router bzw. Supervisor | `{commandId, state, error?}`; Kommandos siehe unten |
| `RouterLease` | Supervisor des Control-Primary auf Anfrage des Routers | `RouterLease` aus 4.4, signiert; Erneuerung alle 20 s, Laufzeit 60 s (5.2) |
| `MemberStatus` | Router | Erreichbarkeit, Revision, Lag, Kapazität; Lease 30 s; aus Router-Sicht |
| `Capability` | Host für sich selbst | Werkzeuge, Modelle, Ressourcen, Host-Metriken; Lease 2 min |
| `RecoveryRequest` / `RecoveryResult` | Recovery-Admin / Supervisor | nur im lokalen Recovery Space |

Admins schreiben ausschließlich `Command`-Entries; alle übrigen Steuerdaten entstehen durch deren Verarbeitung.

| Command | verarbeitet von | Wirkung |
|---|---|---|
| `createEnroll` | Supervisor (Control-Primary) | `Enroll` anlegen (4.5); funktioniert ohne Router |
| `revokePeer` | Supervisor (Control-Primary) | `PeerKey` auf `revoked`; Grants laufen nach 4.3 aus |
| `rotateKey` | Supervisor (Control-Primary) | neuen Schlüssel per Challenge mit altem und neuem Schlüssel aufnehmen, alten widerrufen |
| `setLimits`, `drain`, `addMember`, `removeMember`, `setPolicy` | Router | 5.1, 7.1 |
| `restoreDataSpace` | Supervisor (Control-Primary) mit Supervisor des Zielhosts | Restore eines einzelnen Data Space nach 5.2.2 |
| `releaseRestored` | Supervisor (Control-Primary) mit Supervisor des Zielhosts | restaurierte `restoredUnverified`-Entries im angegebenen Scope freigeben (5.2.2); funktioniert ohne Router |
| `setStandby` | Router mit Supervisor beider Hosts | festen Standby eines primary-Space einrichten oder wechseln, nur bei pausierten Writes (7.2) |

Supervisor-Commands sind ebenso idempotent und journalisiert wie Router-Commands (5.1). Weitere
Lebenszyklus-Kommandos (Space anlegen/löschen, Lauf- und Workersteuerung) sind in
[betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md) als Erweiterung vorgeschlagen und nicht Teil von v3.

### 5.1 Kommandos und Router-Journal

Command-Verarbeitung ist eine dauerhafte Zustandsmaschine
`accepted → applying → completed | failed | needsReview`. `failed` bedeutet nachgewiesenen endgültigen Fehler;
`needsReview` bedeutet Ende der automatischen Auflösung ohne gesichertes fachliches Ergebnis.

- Vor jeder entfernten Wirkung speichert der Router Ziel, Argument-Hash und eine stabile **Unterrequest-ID**.
- Die entfernte Operation wird mit genau dieser Unterrequest-ID als RPC-`requestId` ausgeführt. Das Ziel speichert
  Wirkung und Deduplizierung atomar (RPC-Claim, 6.2). Nach einem Absturz fragt der Router denselben Unterrequest
  ab oder wiederholt ihn; eine zweite Wirkung ist ausgeschlossen.
- Journal plus Deduplizierung liefert Wiederaufnahme und Atomarität **je Zieloperation**, keine atomare Änderung
  mehrerer Spaces. Ein unbekannter Ausgang wird nie als `failed` verbucht. Teilwirkungen bleiben sichtbar und
  werden anhand der journalisierten Schritte weiterbehandelt.
- Operationen ohne idempotentes Zielprotokoll sind keine zulässigen Commands.
- Nach Neustart ist der Router `recovering`: Er rekonstruiert Zielbindungen, Gewinner, Claims und reservierte
  Budgets und richtet die Betreuung offener Arbeit wieder ein. Danach nimmt er unabhängige neue Arbeit an;
  er wartet nicht auf den fachlichen Abschluss aller Requests. Ein rekonstruierter `FOREVER`-Waiter darf durch
  einen neuen Write bedient werden. Nicht erreichbare Ziele sperren nur die von ihnen abhängigen Operationen;
  noch ungeklärte Policy-/Membership-Änderungen sperren ihren betroffenen Routingbereich.
- Nach `ResultExpired`, fehlender Historie oder `IncarnationChanged` wird eine nicht mehr automatisch
  auflösbare Operation dauerhaft `needsReview` mit Ziel, IDs und vorhandenem Nachweis. Ein Admin dokumentiert
  die fachliche Entscheidung separat; er schreibt den historischen Ausgang nicht in einen erfundenen Erfolg
  um. Kein automatischer Ersatzrequest und kein zweiter Gewinner. Unabhängige Arbeit bleibt möglich;
  notwendige abhängige Ressourcen bleiben bis zur dokumentierten Klärung gesperrt.
- Eine Aufteilung in feste Journal-Partitionen muss Anzahl, Router-IDs und ID-Zuordnung dauerhaft binden.
  Alle Kinder eines Parents behalten ihren Router; bekannte IDs dürfen durch Umkonfiguration nicht unsichtbar
  werden. Einzel- und Gesamtbudgets sind endlich. Restore und Remove prüfen sämtliche Partitionen;
  ein unvollständiger partitionenübergreifender Restore hält eine dauerhafte Sperre bis zur Wiederaufnahme.
  Eine Migration oder Größenänderung verlangt ein eigenes Verfahren, keine automatische Neuverteilung.
- Journal und Deduplizierung haben dieselbe Schutz- und Replikationsklasse wie der Control Space; ihre Bytes
  werden getrennt budgetiert. Mailbox-ACKs erst nach dauerhafter Übernahme des Events.

### 5.2 Verfügbarkeit des Control Space

| Stufe | Betrieb | Garantie bei Ausfall des Primary |
|---|---|---|
| 1b–2 | **single** plus regelmäßiger asynchroner Snapshot auf einen zweiten Host | Nach Ablauf von Grants (60 s) und Router-Lease stehen **alle entfernten Operationen** der Federation, nicht nur Enrollment und Commands. Lokale Arbeit je Host läuft weiter. Fortsetzung erst nach Rückkehr oder **Restore** nach 5.2.1. Keine automatische Übernahme. |
| ab 3 | **primary/sync** mit festem Standby | manuelle Promotion nach 5.3 ohne Verlust bestätigter Operationen. Bis zur Promotion stehen entfernte Operationen wie oben; nach der Promotion bis zur ausdrücklichen Umschaltung nach 5.3.1 ebenfalls. Erst danach kann `setStandby` einen Ersatz einrichten; ohne sync-Commit oder autorisierte Umschaltung keine neue Lease. |

Ein Ausfall des Control-Primary oder seines synchronen Standbys hält damit die ganze Federation an, sobald
Grants und Router-Lease ablaufen. Das ist der Preis dafür, dass Rechte und Router-Fencing nur aus autoritativem
Zustand stammen.

**Router-Lease (Software-Fencing des Routers):** Der Router darf Delegationen nur innerhalb einer gültigen
`RouterLease` ausstellen. Er beantragt die Erneuerung beim Supervisor des Control-Primary; dieser committet die
Lease im Control Space und signiert sie erst danach (4.4). Im Modus primary/sync braucht jeder Commit die
Standby-Bestätigung. Ein abgeschnittener alter Primary kann daher keine Lease mehr erhalten, und eine selbst
ausgestellte Lease scheitert an der Supervisor-Signatur. Members weisen seine Delegationen nach Ablauf zurück.
Ein neuer Router startet frühestens nach Ablauf der alten Lease plus maximaler Zeitunsicherheit und erhält eine
höhere `routerEpoch`.

**Epochen-Ankündigung:** Nach Promotion, Single-Umschaltung des Control Space oder Router-Wechsel sendet der
Supervisor eine signierte `EpochNotice {kind: "promotion" | "degrade" | "routerChange", authorityId,
controlSpaceId, controlPrimaryEpoch, routerEpoch}` an jeden Member. Sie gilt nur innerhalb der bereits lokal
installierten Autorität. Jeder Member speichert die höchsten Zähler dauerhaft und weist kleinere Werte ab.
Ohne Zustellung schützt der Ablauf alter Leases/Grants. Das erhaltene Journal wird mit denselben Unterrequests
fortgeführt. Ein Restore benötigt stattdessen den separat autorisierten Autoritätswechsel aus 5.2.1;
eine gewöhnliche `EpochNotice` darf ihn niemals auslösen.

#### 5.2.1 Restore im Single-Betrieb (Stufe 1b–2)

Restore ist keine Promotion, braucht aber dieselben Schutzschritte gegen einen zurückkehrenden alten Primary:

1. **Alten Primary sperren:** Fencing nach 5.5. Vor Abnahme eines realen Adapters (Gate 2) genügt für einen
   Restore im Single-Betrieb ausnahmsweise ein vom Recovery-Admin dokumentiertes Abschalten mit Neustartsperre
   über die Anbieterkonsole, mit Screenshot oder API-Auszug im Audit (F15). Für Promotion gilt diese Ausnahme
   nie. Ohne Sperre kein Restore.
2. **Neue Autorität:** Ein beim Bootstrap festgelegtes Recovery-Register auf dem unabhängigen Recovery-Admin-
   System hält die aktuelle Autorität und die einzige zulässige Nachfolgeentscheidung je Control Space.
   Es liegt außerhalb der Host-/Space-Snapshots und ist über den Out-of-Band-Pfad erreichbar. Der Recovery-Admin
   reserviert darin atomar per Compare-and-Set die erwartete alte Autorität, eine eindeutige `recoveryId`, die
   zufällig neue `authorityId`, den Zielhost und dessen Supervisor-Schlüssel. Erst nach diesem dauerhaften
   Register-Commit wird der Übergang signiert. Alle autorisierten Recovery-Admins verwenden dasselbe Register;
   ist es verloren oder unerreichbar, bleibt Restore gesperrt. Eine zweite Nachfolgeentscheidung zur selben
   Autorität ist ausgeschlossen, auch wenn sie andere Members erreichen würde. Retries verwenden denselben
   Übergang; ein Register-Backup darf keinen bereits vergebenen Nachfolger zurückrollen. Der Snapshot erhält eine neue Dateninkarnation;
   Control-`primaryEpoch`, `routerEpoch` und `policyVersion` beginnen im neuen Autoritätsnamensraum bei 1.
   Es gibt keinen numerischen Sicherheitsabstand und keinen Vergleich mit alten Autoritätszählern.
3. **Zugang zunächst sperren:** Alle restaurierten `PeerKey`-Berechtigungen, Gruppenregeln für A-only-Zugang,
   Grants und unverbrauchten Enrollment-Tokens werden für die neue Autorität deaktiviert. Ein verlorenes
   Widerrufsprotokoll kann dadurch keine Rechte wiederbeleben. Der lokal provisionierte Recovery-Admin bestätigt
   über den Out-of-Band-Zugang den ersten neuen Admin und die erforderlichen Dienstschlüssel; weitere Rollen
   werden ausdrücklich neu freigegeben/gepairt. Alte aktive Einträge sind nur Auditmaterial, keine Freigabequelle.
4. **Members umstellen:** Der Recovery-Admin installiert denselben signierten
   `AuthorityTransition {recoveryId, expectedAuthorityId, newAuthorityId, controlSpaceId, targetHostId,
   supervisorKey}` über den lokalen Recovery-Socket jedes teilnehmenden Members. Dieser prüft den lokal
   provisionierten Recovery-Schlüssel und tauscht die akzeptierte Autorität atomar per Compare-and-Set aus;
   derselbe Übergang ist idempotent, ein konkurrierender oder zurückrollender Übergang scheitert. Der Member
   speichert den Übergang außerhalb restaurierbarer Space-Snapshots und bestätigt ihn dauerhaft. Vor dem
   Austausch werden lokale Mutationen angehalten und alte versiegelte Kandidaten nach 7.2 aufgelöst. Bei
   replizierten Data Spaces bestätigen alle zugelassenen Replikate den Übergang, oder ein fehlendes Replikat
   wird nach 5.3.1 gefenct und ausgeschlossen; bis dahin kein Member-ACK. Daten-Primary-Epochen beginnen im
   neuen Namensraum bei 1; vorhandene Daten/Claims bleiben erhalten. Vor dem Member-ACK wird auch dessen externe
   Boot-Berechtigung nach 5.5 auf die neue Autorität und die bestätigte lokale Konfiguration abgeglichen.
   Auf dem restaurierten Control Space gilt
   derselbe Übergang; seine alten Pending-Requests werden nie automatisch neu ausgesendet.
   Offline-Members bleiben `recoveryBlocked`, erhalten keine neuen Grants und werden nicht aus Suchmengen
   entfernt: vollständige Abfragen melden weiterhin Unverfügbarkeit. Erst nach lokalem Übergang und ACK werden
   sie freigegeben. Ein Snapshot allein darf diese Sperre oder die akzeptierte Autorität nicht zurücksetzen.
5. **Journal-Lücke und Requests:** Beim Autoritätswechsel invalidiert jeder Member alte Generationen für neue
   IDs (`IncarnationChanged`). Bekannte Ergebnisse bleiben gemäß Frist für neu autorisierte Auflösung lesbar.
   Unversiegelte alte Router-Operationen werden lokal storniert; versiegelte Kandidaten werden nach 7.2 geklärt,
   niemals pauschal abgebrochen. Entschiedene Wirkungen bleiben bestehen und werden als `orphanedAfterRestore`
   mit Principal, Request-ID und verfügbarem Ergebnis bzw. `ResultExpired` auditiert. Im Snapshot vorhandene
   Journalreferenzen werden anhand dieser Claims abgeglichen; fehlende Historie wird `needsReview` (5.1).
   Ein erneuter fachlicher Auftrag benötigt bewusste Klärung und eine neue ID, kein automatisches Replay.
6. **Freigabe:** Nach Fencing mindestens die maximale Restlaufzeit alter Grants/Router-Leases plus
   Zeitunsicherheit abwarten; dann Router mit neuer Autorität in `recovering` starten. Freigabe nur für bestätigte
   Members und neu autorisierte Principals. Der alte Host kehrt ausschließlich nach Neuaufbau als Snapshot-
   Empfänger zurück. Ausstehende Members und Auditfälle bleiben sichtbar, blockieren aber nicht unabhängige Arbeit.

#### 5.2.2 Restore eines einzelnen Data Space

Verliert ein Data Member seinen Storage, während Control Space und andere Members gesund sind, wechselt **nicht**
die Control-Autorität. Nur dieser Space erhält eine neue Dateninkarnation. Der Ablauf ist ein Supervisor-Command
`restoreDataSpace {space, snapshotRef, recoveryId, targetHostId, expectedDataIncarnation,
expectedPrimaryEpoch, expectedReplicaConfigVersion?}` des Control-Primary mit Ausführung am Zielhost.
Der Supervisor journalisiert und serialisiert den Übergang je Space gegen Policy-/Replikatwechsel; dieselbe
Recovery-ID mit denselben Argumenten setzt ihn fort, andere Argumente ergeben `RequestConflict`.

1. **Alten Host sperren:** Fencing nach 5.5 bzw. F15; ohne Sperre kein Restore. Der Member ist bis Schritt 6
   `recoveryBlocked`; vollständige Abfragen melden ihn als fehlend. Bei einem primary/sync-Member ist zuerst
   der feste Standby zu prüfen: Eine intakte synchrone Historie wird per Promotion fortgeführt, nicht durch einen
   älteren Snapshot ersetzt. Sind alle synchronen Kopien verloren, werden alle bisherigen Replikate gefenct
   und ausgeschlossen; der Restore startet ausdrücklich in primary/single. F15 gilt nur für Single-Restore
   vor Gate 2, nicht als Ersatz für das Fencing einer bestehenden sync-Konfiguration.
2. **Neue Dateninkarnation:** Der Snapshot wird unter geschlossener Admission mit neuer Inkarnation installiert.
   `primaryEpoch` steigt über den letzten bestätigten Wert aus Control und externem Boot-Nachweis, nicht bloß
   über den älteren Snapshot-Wert. Fehlende oder widersprüchliche Versionsnachweise blockieren den Übergang.
   Der Restore erhält eine neue, höhere lokale Replikatkonfigurationsversion, sofern der Space eine solche hat.
   Neue lokale IDs verwenden die neue Inkarnation; restaurierte Entries behalten ihre IDs.
3. **Generationen und Claims:** Alle Request-Generationen der alten Inkarnation werden für neue IDs ungültig
   (`IncarnationChanged`). Im Snapshot enthaltene Claims bleiben gemäß Frist abrufbar, sind aber als
   `restoredHistory` markiert und nur historisch abfragbar. Ein darin bereits entschiedenes Ergebnis bleibt als
   Ergebnis zum Snapshot-Zeitpunkt erkennbar; ein dort noch offener Request hat heute einen unbekannten Ausgang.
   **Keine alte Pending-Arbeit wird fortgeführt:** Pending-Claims, Waiter, Registrierungen, Folgeaufträge,
   Txns und versiegelte Kandidaten des Snapshots sind Auditmaterial, keine ausführbaren Aufträge. Offene Claims
   erhalten eine Auflösungssperre `needsReview`, ohne ihren historischen Ausgang als `cancelled` oder `failed`
   umzuschreiben. Die neue aktive Kopie löst alte Reservierungen/Lesesperren lokal, verwirft unsichtbare
   Txn-Writes und installiert keine alten Waiter, Registrierungen oder Folgeaufträge. Das ist Bereinigung einer
   restaurierten Kopie, kein Abort auf dem verlorenen Original. Auch ein kopierter CommitIntent wird nie erneut
   angewendet; 7.2 gilt für die intakt fortgeführte Historie, nicht für einen verlustbehafteten Snapshot-Restore.
   Historische Mailbox-Inhalte werden entsprechend markiert; ihre alte Mailbox-Identität wird nicht wieder
   aktiviert. Neue Mailboxes erhalten neue Identitäten. Bereinigung und Audit erfolgen crashfest in budgetierten
   Schritten bei gesperrter Admission; Freigabe erst nach vollständigem Abschluss. `releaseRestored` gibt nur
   Entries frei, niemals alte Claims oder Aufträge. Ein neuer fachlicher Auftrag braucht eine bewusste Klärung
   und eine neue Request-ID.
4. **Quarantäne restaurierter Entries:** Alle restaurierten Nutz-Entries von Typen mit exklusiver Vergabe
   (local, expand und primary; nicht lww/set) erhalten `restoredUnverified`. Interne Steuerdaten, etwa RunGates,
   werden über ihren geschützten Recovery-Pfad abgeglichen, nicht als frei nehmbarer Nutzbestand installiert.
   Die Nutz-Entries sind lesbar, aber weder nehmbar noch in Txns
   verwendbar. Freigabe nur per Admin-Command `releaseRestored {space, recoveryId, scope}` mit `scope` als
   Typ, Lauf oder Entry-Liste. Der Admin entscheidet damit fachlich, dass erneute Verarbeitung zulässig ist
   (z.B. idempotente Sieb-Tasks); für nicht idempotente Aufgaben bleibt die Löschung oder manuelle Klärung.
5. **Router und Läufe** (sobald ein Router existiert, ab Stufe 2): Der Router markiert alle Unterrequests auf diesen Member,
   deren Claims im Snapshot offen sind, nach dem Snapshot-Stand liegen oder fehlen, als `needsReview` (5.1).
   Historische Ergebnisse werden nur als entsprechend markierte Nachweise übernommen. Zielbindungen bleiben erhalten; es gibt keine
   Neuplatzierung auf andere Members. Lauf-Manifeste mit Tasks auf diesem Member werden `needsReview`, bis ihr
   Controller die vollständigen Recovery-Views abgeglichen hat ([Betrieb 6](betrieb-und-mobile-steuerung.md)).
   Schritt 5 persistiert diese Sperren; er wartet nicht auf die spätere fachliche Entscheidung. Begrenzte
   Status-/Recovery-Aufrufe bleiben schon während `recoveryBlocked` für die vorgesehene Dienstrolle zugänglich.
6. **Freigabe:** Die Supervisoren gleichen die neue Dateninkarnation, Ziel-Replika, Epoche und Durability mit
   dem Control Space und der externen Boot-Berechtigung nach 5.5 ab. Unklarer Ausgang bleibt `recoveryBlocked`;
   ein Snapshot darf die alte Routing-/Replikatkonfiguration nicht eigenmächtig reaktivieren. Erst nach
   Schritt 1–5, diesem Abgleich und Ablauf der Restlaufzeit alter Grants nimmt der Member wieder entfernte Arbeit
   an. Der alte Host kehrt nur nach Neuaufbau zurück.

Ein Data-Restore ist damit immer verlustbehaftet; 2.1 begrenzt die Take-Garantie entsprechend.

### 5.3 Manuelle Promotion (ab Stufe 3)

Keine automatische Wahl bei bloßem Timeout. Pro primary-Space ein fester Standby; Supervisor auf beiden Hosts.

1. Recovery-Admin schreibt einen signierten Request in den Recovery Space **des Standbys**: `authorityId`,
   erwartete `primaryEpoch` und `replicaConfigVersion`, Ziel, Recovery-ID. Wiederholung ist idempotent;
   konkurrierende Übergänge werden per lokalem Compare-and-Set serialisiert.
2. **Fencing-Nachweis** nach 5.5. Netzwerk-Timeout oder bloße Admin-Behauptung genügen nicht.
3. Nur der feste synchrone Standby übernimmt; er prüft Historie und Replikationsvertrag (7.2) sowie sein
   Host-Zustand `active` und seine gültige Boot-Berechtigung als Standby für genau diesen Space (5.5).
   Lücken oder abweichende Berechtigung → Abbruch.
4. Supervisor erhöht `primaryEpoch` des Space atomar. Normale Mutationen bleiben gesperrt, bis seine externe
   Boot-Berechtigung die neue Epoche und Rolle Primary bestätigt (5.5). Ist es der Control Space, wartet er den
   Ablauf der alten `RouterLease` ab, erhöht `routerEpoch`, sendet die `EpochNotice` (5.2) und startet den Router
   zunächst im Zustand `awaitingDurability` ohne neue Lease. Dieser lokale Promotions-/Recovery-Commit ist
   durch Fencing autorisiert und benötigt den ausgeschlossenen alten Primary nicht. Mutierende Requests tragen Autorität und
   `primaryEpoch`; neue Requests mit alten Werten werden abgewiesen, Retries bekannter Claims nach 4.4
   beantwortet; unbekannte IDs alter Epoche werden ausschließlich nach 6.2 aufgelöst. Eine erforderliche
   Negativentscheidung bleibt bis zur Wiederherstellung schreibbarer Durability pending.
   Router-Recovery mit neuer Lease beginnt erst nach Schritt 6.
5. Der alte Host bleibt gefenct. `release` hebt die Sperre nur in den **Quarantänemodus** auf (5.5): Der Host
   bootet, sein Supervisor startet die betroffenen Spaces ausschließlich als Replikat-Empfänger ohne Gate-Zugang
   für Clients, ohne Agenten und ohne Router. Erst nach vollständiger Synchronisierung über Snapshot plus Stream
   wird er nach Schritt 6 per `setStandby` neuer Standby. Freigabe in Quarantäne erfolgt erst nach Abschluss
   der Single-Umschaltung, damit deren Fencing-Nachweis gültig bleibt. Ein Prozessneustart stellt keine
   Primary-Berechtigung wieder her.
6. Ohne bestätigungsfähigen Standby bleiben sync-Writes gesperrt. Für die Wiederinbetriebnahme des Control
   Space ist zuerst die ausdrücklich autorisierte Umschaltung nach 5.3.1 nötig; erst im schreibbaren Single-
   Betrieb kann der Router `setStandby` verarbeiten. Wer die vorübergehende Single-Garantie nicht akzeptiert,
   bleibt offline. Es gibt keinen impliziten Recovery-`setStandby` und keinen zirkulären Command-Aufruf.

#### 5.3.1 Standby-Ausfall und Umschaltung auf Single

Fällt der synchrone Standby aus, im Normalbetrieb oder nach einer Promotion, kann der Primary nichts mehr
bestätigen. Weil dann auch Commands nicht committbar sind, läuft die Umschaltung über den Recovery-Pfad **des
Primary**:

1. Recovery-Admin schreibt `RecoveryRequest {kind: "degradeToSingle", recoveryId, authorityId, space,
   expectedPrimaryEpoch, expectedReplicaConfigVersion}` in den lokalen Recovery Space des Primary. Neue
   Mutationen und Reaper-Commits dieses Space werden für den Übergang angehalten.
2. **Fencing-Nachweis für den bisherigen Standby** nach 5.5. Nach Promotion ist der ausgeschlossene alte Primary
   das zu sperrende Gegenreplikat; dessen bereits verifizierter, weiterhin gültiger Nachweis wird verwendet.
   Ohne Sperre keine Umschaltung und keine Replikatfreigabe.
3. **Pending-Präfix abschließen:** Der Primary prüft seine lokale geordnete Historie und den höchstens einen
   versiegelten Commit-Kandidaten aus 7.2. Dieser wird unabhängig vom verlorenen Standby-ACK genau einmal mit
   seinen gespeicherten Deltas und Claims angewendet und als `recoveredCommitted` journalisiert. Auch ein vor
   dem Senden unterbrochener versiegelter Kandidat wird so abgeschlossen; er darf nicht nachträglich als Miss,
   Cancel oder Lease-Ablauf umgedeutet werden. Ein beschädigter/fehlender Kandidat oder eine Präfixlücke blockiert
   die Umschaltung. Neu angenommene Arbeit darf ihn nicht überholen.
4. **Lokaler atomarer Übergang:** Der Supervisor erhöht im betroffenen Space `primaryEpoch` und
   `replicaConfigVersion`, setzt dessen autoritative lokale Replikatkonfiguration auf `durability: "single"`,
   schließt das Gegenreplikat aus und speichert Recovery-ID/Result in demselben lokalen Commit. Recovery-ID und
   erwartete Versionen sichern Wiederholung und Konkurrenz ab. Das ist ein ausdrücklich durch Fencing
   autorisierter lokaler Recovery-Commit ohne Standby; keine Transaktion mit dem Control Space.
   Vor Freigabe lokaler Arbeit wird die externe Boot-Berechtigung des Primary auf die neuen Versionen
   und Durability abgeglichen (5.5); unklarer Ausgang hält die Admission gesperrt.
5. **Control-Policy abgleichen:** Der Supervisor hält eine signierte `ReplicaConfigNotice` mit Space,
   Autorität, neuen Versionen, Durability und Recovery-ID dauerhaft zur Abholung bereit. Der Router übernimmt
   sie idempotent in einem separaten Control-Commit und erhöht `policyVersion`; diese Übernahme darf ausschließlich
   die belegte Replikatkonfiguration ändern. Bis dahin sind entfernte fachliche Aufrufe auf diesen Member mit
   `ReplicaConfigPending` gesperrt; Status/Recovery-Abgleich sind über die begrenzte Dienstrolle möglich.
   Lokale Arbeit darf nach Schritt 4 gemäß Single-Garantie weiterlaufen. Alte Policy darf die lokale Durability
   nie zurücksetzen. Bei unerreichbarem Control Space wird später abgeglichen, nicht lokal fremde Policy geschrieben.
6. **Sonderfall Control Space:** Seine eigene Policy liegt im selben lokalen Storage und wird bereits in
   Schritt 4 atomar mit erhöhtem `policyVersion` angepasst. Der Supervisor kann danach Grants und eine neue
   Router-Lease ausstellen; Router-Wechsel wartet zusätzlich den alten Lease-Ablauf ab und erhöht `routerEpoch`.
   Er sendet eine `EpochNotice` und übernimmt beim Start weitere ausstehende ReplicaConfigNotices.
7. Ab Schritt 4 gilt primary/single; ab Schritt 5 bzw. 6 ist entfernte Nutzung wieder möglich. Rückkehr zu sync
   nur über `setStandby`: Ziel im Quarantänemodus synchronisieren, sämtliche Schreibquellen inklusive Reaper
   kurz sperren und vorhandene versiegelte Kandidaten klären, die Historie bis zum letzten entschiedenen
   Commit bestätigen lassen, dann die neue
   Replikatkonfiguration mit höherer Version und `primaryEpoch` dauerhaft auf beiden Replikaten installieren.
   Das Ziel bestätigt diese Konfiguration vor ihrer Aktivierung am Primary; unklarer Ausgang bleibt gesperrt und
   wird über dieselbe Command-/Unterrequest-ID geklärt. Nach beidseitiger Bestätigung setzt der ausführende
   Supervisor die externen Boot-Berechtigungen **beider** Replikate auf die neue Konfiguration, Epoche und
   jeweilige Rolle (5.5). Erst danach darf der Zielhost von `quarantine` auf `active` wechseln. Danach Policy
   wie oben abgleichen und Writes freigeben. Auch der bisherige Primary braucht die aktualisierte Berechtigung;
   ein Neustart zwischen lokalem Commit und externem Abgleich setzt ausschließlich diesen Übergang fort.
   Ein Standby-Wechsel bei noch intakter sync-Konfiguration hält den alten Standby bis zur bestätigten neuen
   Konfiguration gebunden; anschließend darf nur der neue Standby als Promotionsziel gelten. Das alte Replikat
   muss seinen Ausschluss dauerhaft bestätigen oder vor Freigabe der neuen Konfiguration gefenct werden.
   Während der Sperre sind ausschließlich die journalisierten Konfigurations-/Recovery-Schritte dieses
   Übergangs erlaubt, keine fachlichen Writes oder Lease-Erneuerungen. Die beteiligten Supervisoren führen
   den bereits gespeicherten Auftrag auch ohne laufende Router-Lease zu Ende; ihr Scope erlaubt keine
   anderen Commands. So hängt der Control-eigene Standby-Wechsel nicht von einer Lease-Erneuerung während
   der Schreibsperre ab. `completed` erst nach Konfigurations- und Policy-Abgleich.

### 5.4 Recovery Space bleibt lokal

Der Recovery Space wird nicht repliziert. Das unabhängige Recovery-Register aus 5.2.1 serialisiert nur
Autoritätswechsel; es enthält weder den Recovery Space noch Space-Daten und ersetzt keine Replikation. Er ist der Steuerpfad, der funktionieren muss, wenn Control Space oder
Router ausgefallen sind, und liegt auf dem Host, der handeln soll: für Promotion auf dem Standby, für die
Umschaltung nach 5.3.1 auf dem Primary. Ist dieser Host selbst ausgefallen, gibt es nichts zu befördern. Eine
Replikation würde den Recovery-Pfad von genau der Infrastruktur abhängig machen, deren Ausfall er behandelt, und
eigene Split-Brain-Fälle schaffen.

**Zugang unabhängig von Overlay und Gate:** Der Recovery Space ist nur über den lokalen Unix-Socket des
Supervisors erreichbar, nicht über `space-gate`. Der Recovery-Admin erreicht ihn über einen Out-of-Band-Zugang:
die Konsole des Anbieters bzw. Hypervisors oder SSH über die öffentliche Adresse mit eigenem Schlüssel, der nur
den Recovery-Befehl erlaubt (`command=`-Restriktion). Die Anfrage selbst ist mit dem lokal provisionierten
Recovery-Admin-Schlüssel signiert (4.3). So funktioniert Recovery auch bei ausgefallenem NetBird-Management, bei
abgelaufenem Schicht-A-Cache und ohne Control Space. Dieser Zugang ist der Nachweis für Gate 1.

### 5.5 Fencing

Fencing hat zwei Ebenen:

1. **Daten (immer wirksam in primary/sync):** Der alte Primary kann ohne Standby-Bestätigung nichts bestätigen,
   und der beförderte Standby bestätigt keine alte `primaryEpoch` mehr. Bestätigte Doppelwirkungen auf replizierten
   Daten sind damit ausgeschlossen, solange es keinen stillen Rückfall auf asynchronen Betrieb gibt.
2. **Prozesse (Pflicht für Promotion):** Der alte Primary könnte weiter veraltete Reads ausliefern, Agenten
   betreiben und externe Wirkungen auslösen. Deshalb ist ein Nachweis nötig, dass er gestoppt und gegen
   automatischen Neustart gesperrt ist.

```ts
interface FencingAdapter {
  readonly kind: "power" | "hypervisor" | "cloud" | "container";
  fence(hostId: string, reason: string): Promise<FenceProof>;     // stoppen UND Neustart sperren
  verify(proof: FenceProof): Promise<boolean>;                     // vom Supervisor unabhängig nachgeprüft
  release(hostId: string, mode: "quarantine"): Promise<void>;      // nur in den Quarantänemodus (5.3 Schritt 5)
  readBootState(hostId: string): Promise<HostBootState>;
  compareAndSetBootState(hostId: string, expectedVersion: number, next: HostBootState): Promise<HostBootState>;
}
type FenceProof = { hostId: string; kind: string; observedAt: number; evidence: Json; restartLocked: boolean };
type SpaceBootPermit = {
  state: "active" | "revoked";
  authorityId: string; dataIncarnation: string;
  role: "local" | "primary" | "standby" | "entryReplica";
  primaryEpoch?: number; replicaConfigVersion?: number;
  durability?: "single" | "sync";
  transitionId: string;
};
type HostBootState = {
  hostId: string; version: number; state: "active" | "fenced" | "quarantine";
  spaces: Record<string, SpaceBootPermit>; // Schlüssel ist die stabile spaceId
};
```

- Zulässig sind nur Adapter, deren Zustand der Supervisor selbst über eine unabhängige Schnittstelle abfragt:
  schaltbare Steckdose/PDU, IPMI/BMC, Hypervisor- oder Cloud-API, Container-Runtime auf einem *anderen* Host.
- `restartLocked` muss erfüllt sein (z.B. Steckdose bleibt aus, VM deaktiviert, Restart-Policy entfernt). „Power
  off“ allein genügt nicht.
- `release` ist nicht zirkulär: Es gibt keine allgemeine Freigabe, sondern nur den Quarantänemodus.
- **Boot-Merkmal:** Jeder Host hat einen außerhalb des Hosts gespeicherten, versionierten `HostBootState`
  (z.B. Cloud-Metadaten oder Recovery-Register mit unabhängiger API). Die Host-Sperre ist global; Autorität,
  Dateninkarnation, Rolle und Replikatversion werden **je Space** in `spaces` geführt. `version` schützt den
  atomaren Compare-and-Set dieses Registers, ist keine `replicaConfigVersion`. Änderungen an Space A erhalten
  die bestätigten Berechtigungen von Space B; konkurrierende Übergänge lesen nach CAS-Konflikt neu.
  Der Supervisor liest und prüft den Zustand bei jedem Boot:

  | Zustand | gesetzt durch | Boot-Verhalten |
  |---|---|---|
  | `active` | Provisionierung; nach bestätigter Synchronisierung durch `setStandby` | jeder Space startet nur mit exakt passender eigener Boot-Berechtigung und lokaler Konfiguration |
  | `fenced` | `fence` (Promotion, 5.2.1, 5.2.2, 5.3.1) | Host bleibt aus; startet er dennoch, kein Space und kein Gate; alle bisherigen Space-Berechtigungen sind widerrufen |
  | `quarantine` | `release(…, "quarantine")` | nur Replikat-Empfang ohne Gate-Zugang, Agenten und Router (5.3 Schritt 5) |

  Fencing setzt auch jede bisherige Space-Berechtigung auf `revoked`; die letzten Versionswerte bleiben im
  unabhängigen Register/Audit erhalten und dürfen nicht durch einen Snapshot oder ein älteres Register-Backup
  zurückgerollt werden. Nur ein neuer bestätigter Übergang installiert wieder eine `active`-Berechtigung.
  Der globale Host-Zustand `active` allein hebt keinen Space-Widerruf auf.

  Fehlt der Host-Zustand oder ist er unlesbar, startet kein Space schreibend. Bei gültigem `active` blockiert
  eine fehlende oder abweichende Space-Berechtigung nur diesen Space; andere bestätigte Spaces bleiben nutzbar.
  Für Erststart und Anlage weiterer Spaces installiert die autorisierte Provisionierung vor Aufnahme normaler
  Arbeit die zur lokal vorbereiteten Konfiguration passende Berechtigung. Bloßer Prozessneustart oder erneuter
  Script-Apply darf keine widerrufene Berechtigung wiederherstellen.

  `release` erhält den Host in Quarantäne; alte Berechtigungen werden nicht wiederbelebt. `quarantine → active`
  ist nur am Ende von `setStandby` zulässig, nach bestätigter Synchronisierung und Installation der neuen
  Berechtigungen. Andere Spaces eines gefencten Hosts brauchen jeweils einen eigenen bestätigten Übergang;
  die Freigabe eines Standbys reaktiviert keine anderen alten Primaries.

  **Alle Rollen-/Versionswechsel** (Promotion, Single-Umschaltung, `setStandby`, Control-/Data-Restore)
  journalisieren vorab erwarteten Registerstand, Zielkonfiguration und stabile Übergangs-ID. Sie gleichen die
  externen Berechtigungen aller weiter zugelassenen Replikate ab; ein ausgeschlossenes Replikat bestätigt den
  Widerruf oder bleibt gefenct. Vor normaler Schreibfreigabe müssen lokale Konfiguration und externer Nachweis
  exakt übereinstimmen und die Space-Berechtigung muss `active` sein, einschließlich Autorität,
  Dateninkarnation, Rolle und vorhandener Versionsfelder. Bei primary/standby sind Epoche, Replikatversion
  und Durability Pflichtfelder, keine optional weglassbaren Prüfungen.
  Es gibt keine atomare Transaktion mit der Anbieter-API: Nach Absturz oder ACK-Verlust wird derselbe Übergang
  über lokale und externe Nachweise geklärt. Bis dahin keine fachlichen Mutationen, Grants oder Lease-Erneuerungen
  des betroffenen Space. Der lokale Recovery-Zugang bleibt offen; eng begrenzte, bereits journalisierte
  Konfigurations-/Recovery-Schritte dürfen den Abgleich fortsetzen, nie unabhängige Arbeit. Ein Promotionsziel
  braucht vorher eine passende Standby-Berechtigung; vor Aktivierung braucht es die passende Primary-Berechtigung.
- Ein Marker-Datei-Adapter ist **nur im Simulator** zulässig; er ist eine Behauptung, kein Nachweis.
- Welcher Adapter eingesetzt wird, hängt von der Hardware der Hosts ab (offene Frage F1, Gate 2).

## 6. Bausteine

### 6.1 Core-Erweiterungen (Doc-Version 5)

1. **Revision** pro dauerhaftem Commit; ein Batch enthält alle Deltas eines Commits; Cursor nur zwischen Batches.
   Jeder Batch ist durch `maxCommitBytes` (4.2) kleiner als ein Frame; das Byte-Limit von `changes` beendet eine
   Antwort nur zwischen Batches, mindestens ein Batch wird immer geliefert.
   Stream-ID = Space + Historien-Inkarnation (+ `primaryEpoch` bei primary); Revisionen verschiedener Streams sind nicht
   vergleichbar.
2. **Zwei Replikationszwecke:** Entry-Strom (Put/Delete, Lease-Änderungen, Konfliktmetadaten) für lww/set;
   vollständige atomare Commit-Historie (Txns, Sperren, Waiter, Mailbox, RPC-Claims, Router-Dokumente) für
   primary. Anwenden auf Replikaten erzeugt keine zweite Geschäftsoperation und keine Events.
3. **Snapshot:** unveränderlich mit Token, Stream-ID, Revision R; alle Seiten gehören zu R und sind bytebegrenzt
   (6.2, Seitengrößen); `changes` beginnt nach R.
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
8. **Interne Folgewirkungen:** Reaper/Settle verarbeitet Ablaufereignisse in deterministischer Reihenfolge
   mit dauerhaftem Fortschrittscursor und Batches unter `maxCommitBytes`. Überfällige Arbeit wird vor einer
   davon abhängigen öffentlichen Operation vollständig aufgeholt; diese liefert solange `pending`, keine
   fachlich falsche Momentaufnahme. Ein einzelner Txn-Abort/-Commit bleibt unteilbar und muss bereits durch
   das Budget aus 4.2 gedeckt sein. Größere Notify-/Waiter-Fanouts werden durch einen atomar mit der Ursache
   gespeicherten Folgeauftrag in begrenzten, idempotenten Schritten verarbeitet. Dessen Cursor, Nutzdaten und
   Ergebnis-/Mailbox-Reservierungen werden vor Annahme budgetiert. Spätere Konfliktoperationen dürfen einen
   erforderlichen früheren Schritt nicht überholen; Reservierung und Take-Ergebnis entstehen weiterhin atomar.
   Wartung besitzt reservierten Platz für Abschluss/Abort; normale Writes dürfen diesen nicht verbrauchen.
   Bei erschöpftem Folgearbeitsbudget werden neue verursachende Operationen vor Annahme abgewiesen.
9. **Vorbedingungen:** B1 (ID-Templates), L7 (Gesamtbytes), L13 (Cursor), L11 (Meter pro Space).

### 6.2 Dienst `space`

Jeder Aufruf nennt die stabile Space-ID (Alias vorher auflösen). Argumente werden validiert. Mutationen tragen
`requestId`, Request-Generation, `authorityId` und bei primary die `primaryEpoch`. Relative Zeiten werden beim ersten angenommenen
Aufruf einmalig in eine serverseitige Deadline übersetzt.

| Methode | Wesentliche Argumente | Antwort |
|---|---|---|
| `hello` | Protokollversion, Features | IDs, `primaryEpoch`, Limits, Rolle, Features |
| `write` | Entry, Lease, Txn?, Request | Entry-ID, Lease |
| `read` / `take` | Template, Gesamt-Timeout, `ifExists?`, Txn?, Request | `pending` oder dauerhaftes `done(entry \| null)` |
| `pollOperation` | eigene Aufrufidentität, `targetRequest`, `waitMs ≤ 25000` | aktueller Operationszustand; Erneuerung nur gemäß 4.4 |
| `cancelOperation` | `targetRequest`, eigener Mutationsrequest | Cancel-Ergebnis oder bereits versiegelter/entschiedener Zustand |
| `readAll` | Template, Snapshot-Token?, Cursor?, Limit, `maxBytes` | Entries, Next, Token, Stream-ID, Revision |
| `count` / `stats` | Template? | Wert plus Revision; föderiert plus Vollständigkeit (7.1) |
| `txn` / `lease` | Aktion, ID?, Dauer?, Request | Zustand/Lease |
| `wait` / `notify` | Template, Laufzeiten, Consumer, Handback, Request | ID, Lease |
| `events` | Mailbox, `mailboxEpoch`, Cursor, `waitMs ≤ 25000`, `maxBytes` | Events, Next oder explizite Lücke |
| `ack` | Mailbox, `mailboxEpoch`, `upTo` | idempotent |
| `changes` | Stream-ID, `afterRev`, `waitMs ≤ 25000`, Byte-Limit | Commit-Batches oder `resync` |

**Fachliche Argumente und Rahmen:** Ein Request besteht aus unveränderlichen **fachlichen Argumenten**
(Methode, Template/Entry, Lease, Timeout, Txn-ID, Zielreferenz) und einem **erneuerbaren Rahmen** aus
`authorityId`, `primaryEpoch`, Delegation, Grant, Transport- und Poll-Parametern. Nur die fachlichen Argumente
gehen in den `argumentHash` ein. Ein Retry mit aktualisiertem Rahmen trifft daher denselben Claim; eine
geänderte fachliche Komponente ergibt `RequestConflict`. Der Rahmen wird bei jedem Aufruf neu geprüft, ein
bekannter Claim aber auch nach Promotion beantwortet (4.4).

**RPC-Claims:** Schlüssel `(principal, spaceId, requestGeneration, requestId)`; gespeichert werden Methode,
kanonischer **Argument-Hash** der fachlichen Argumente (keine Klartext-Argumente), einmalige Deadline, Zustand `pending | done | cancelled`
und das **Ergebnis dauerhaft** im selben Commit wie die Operation. Abweichende Wiederverwendung → `RequestConflict`.
Ein Retry liefert das gespeicherte Ergebnis, ohne erneut zu mutieren. Generationen sind neben Principal/Space
an Autoritäts- und Dateninkarnation gebunden; der Claim-Namensraum bleibt damit nach Restore eindeutig.
Historische Restore-Claims sind nur nach 5.2.2 auflösbar, nie als aktive Pending-Arbeit fortführbar. Vor dem eigentlichen sync-
Commit kann ein Claim als `pending/commitSealed` markiert sein (7.2); Cancel kann dann keine erfolglose
Entscheidung mehr erzwingen. Transport-Timeout ist niemals eine solche Entscheidung.

Das Ergebnis muss dauerhaft gespeichert werden: Ein Take entfernt den Entry; läge das Ergebnis nur im Speicher,
wäre der Entry nach einem Neustart verloren (Abnahme Stufe 1). Datenschutz wird über Minimierung und Fristen
erreicht, nicht über Weglassen:

- Argumente nur als Hash; Ergebnisse enthalten nur, was der Aufrufer ohnehin erhält (z.B. den genommenen Entry).
- Abgeschlossene Ergebnisse mindestens 24 h, höchstens 7 Tage (Startwert 24 h), danach gelöscht; nur der
  Hash-Eintrag bleibt mindestens bis zum Ende von Zulassungs- und Ergebnisfrist (unten). Ein Retry mit bekannter ID nach Ergebnislöschung
  liefert `ResultExpired` (Ausgang war entschieden, Inhalt nicht mehr abrufbar), eine unbekannte ID nach Ablauf
  der Generation `RequestExpired`; keiner der beiden Fälle mutiert. Die Generationslaufzeit ist deshalb höchstens
  so lang, dass ihre Hash-Einträge ins Claim-Budget passen (Gate 4).
- Interne Claim-/Journal-Dokumente sind ausschließlich für eng berechtigte Dienstrollen lesbar. Principals
  erhalten über Operations- und Mailbox-Endpunkte nur ihren eigenen erlaubten Status/Inhalt; auch ein Observer
  darf eigene Read-/Notify-Ergebnisse abrufen, aber keine internen Dokumente oder fremden Ergebnisse.
  Nach Rechteentzug gelten die `resolution`-Regeln aus 4.3.
- Löschanfrage für Inhalte eines Principals erfasst Entries, Claims und Mailbox-Events gemeinsam (offene Frage F9).

**Poll-Semantik:** Die Transportwartezeit von 25 s beendet nur den Poll, erzeugt keinen Miss und verlängert keine
Deadline. `null` ist endgültig, sobald die Operation nach ihrer Semantik erfolglos endet; ein neuer Versuch erhält
eine neue ID. Das erhält auch die `ifExists`-Semantik.

**Request-Generationen:** serverseitig signiert, an Principal/Space gebunden, feste Zulassungsfrist. Nach Ablauf
werden darin unbekannte IDs mit `RequestExpired` abgewiesen, auch nach Claim-Bereinigung. Bekannte Claims
bleiben für Retry, Poll, Cancel und autorisierte Fortführung zugänglich; Delegationen prüfen diese Ausnahme
explizit (4.4). Pending-Claims werden durch Generationsablauf nie gelöscht. Ergebnisfristen beginnen erst mit
Abschluss; Hash-Einträge bleiben mindestens bis zum Ende von Zulassungsfrist und Ergebnisfrist erhalten.
Danach ist `RequestExpired` statt `ResultExpired` zulässig, niemals eine neue Wirkung. Neue mutierende
Folgeaufrufe beziehen eine aktuelle eigene Generation; die referenzierte Ursprungsgeneration darf abgelaufen sein.

**Admission-Auflösung beim unveränderten Primary (`resolveOperation`):** Der
Router kann einen eigenen journalisierten Request anhand von Generation,
Request-ID, ursprünglicher Methode und Argument-Hash auflösen. Bekannte Claims
werden erst nach Prüfung dieser Bindung zurückgegeben; Pending-Claims behalten
ihre bisherige Deadline-/Autorisierungsprüfung. Ein fehlender Claim darf nur
`notAdmitted` liefern, wenn die signierte Generation noch gültig ist, zum
Principal, Space, Autorität und zur Dateninkarnation gehört und auf genau die
aktuelle Primary-Epoche ausgestellt wurde. Generationen ohne diese historische
Epochenbindung, Restore-/Authority-Transition und verlorene oder abgelaufene
Generationen liefern keinen Nachweis. Rechte, aktuelle Policy und Router-/
Control-Epochen werden bei Delegation und im serialisierten Host-Zugriff erneut
geprüft. Der bestehende Boot-/Fencing-Vertrag bleibt Voraussetzung des Hosts.

Die Antwort bindet Space, Autorität, Inkarnation, Primary-Epoche, Generation,
Request-ID, Methode und Argument-Hash. Der Router prüft alle Felder gegen
seinen unveränderten Child-Journal-Eintrag und darf nur diesen Request mit
**derselben ID, Generation, Argumenten und demselben Ziel** erneut senden.
Ein verspäteter Originalaufruf kann weiterhin zuerst ankommen; beide treffen
dann denselben atomaren Claim. Deshalb ist `notAdmitted` kein terminaler
Negativclaim, kein `NotCommitted` und keine Erlaubnis für eine neue ID oder
einen anderen Member. Insbesondere beweist diese Antwort nichts über alte
Primary-Epochen. Dafür gilt ausschließlich der nachstehende Promotionsnachweis.

**Auflösung unbekannter IDs nach Promotion:** Nach Authentifizierung, aktueller Rechteprüfung und Prüfung der
Zielreferenz gilt diese Reihenfolge; ein Fehler ermächtigt nie allein zum automatischen Ersatzrequest:

1. Andere Autorität/Dateninkarnation oder verlustbehafteter Restore: `IncarnationChanged`; ein vorhandener
   historischer Claim bleibt ausschließlich als Nachweis lesbar, offener/verlorener Ausgang wird `needsReview`.
2. Passender bekannter Claim, einschließlich Claims eines versiegelten Kandidaten: Methode/Argument-Hash prüfen,
   dann gespeichertes Ergebnis, `ResultExpired` oder Pending-Zustand liefern. Generationsablauf löscht einen
   vorhandenen Nachweis nicht; er erlaubt aber keine neue fachliche Mutation unter einer unbekannten ID.
3. Fehlender Claim und unbekannte oder abgelaufene Zulassungsgeneration: `RequestExpired`, nicht `NotCommitted`.
   Ein fehlender Hash nach zulässiger Bereinigung beweist keinen erfolglosen Ausgang.
4. Fehlender Claim in einer erhaltenen, noch gültigen Generation und ältere `primaryEpoch`: `NotCommitted` nur,
   wenn die Historie seit Ausgabe der Generation verlustfrei fortgeführt wurde, alle angenommenen Claims und
   entschiedenen Wirkungen dieser Generation erhalten sind, sämtliche versiegelten Kandidaten geprüft wurden
   und alle früheren Replikate als mögliche Schreibquellen ausgeschlossen sind. Der Promotionsnachweis bindet
   diese Abdeckung an Space, Autorität, Dateninkarnation, Generation und frühere Epochen. Nachweis fehlt oder
   ist unvollständig: `OutcomeUnknown`, zugehörige Router-Arbeit `needsReview`, kein automatischer Ersatz.

Vor Rückgabe von `NotCommitted` persistiert der aktuelle Primary einen terminalen **Negativclaim** für den
ursprünglichen Claim-Schlüssel, Methode und Argument-Hash, mit Ergebnis `NotCommitted` und Promotionsnachweis.
Er unterliegt denselben Durability-, Budget- und Aufbewahrungsregeln wie andere entschiedene Claims. Prüfung und
Negativclaim entstehen serialisiert gegen Annahme/Versiegelung desselben Requests. Ein verspäteter Original-
Aufruf, auch mit aktualisiertem Rahmen, trifft diesen Claim und kann keine Wirkung mehr erzeugen. Ohne
bestätigungsfähige Durability bleibt diese Auflösung pending; ein bloßer Lese-Miss ist keine Negativentscheidung.
Erst dieses dauerhaft entschiedene Ergebnis erlaubt dem Client einen neuen Request. Ein nur lokal versiegelter,
nie am Standby angenommener Kandidat kann bei Verlust des Primary-Storage fehlen; Fencing verhindert seine
spätere Wirkung. Alle am Standby angenommenen und alle bestätigten Wirkungen bleiben dagegen erhalten.

**Seitengrößen:** Snapshot-Seiten, `readAll`, `events` und `changes` sind nach **kodierten Bytes** begrenzt,
nicht nur nach Anzahl. Die Grenze ist `min(maxBytes des Aufrufers, Frame minus Protokoll-Overhead)` und umfasst
Elemente, Metadaten, Cursor und Token. Eine Seite endet nur zwischen ganzen Elementen; `next` zeigt hinter das
letzte gelieferte Element. Weil `readAll` an ein Snapshot-Token (Revision R) und `events`/`changes` an
Sequenz bzw. Revision gebunden sind, entstehen beim Weiterblättern weder Lücken noch Dubletten. Jede nicht leere
Seite liefert mindestens ein Element. Ein einzelnes Element passt immer: Entries sind durch `maxEntryBytes`,
Commit-Batches durch `maxCommitBytes` und Events durch `maxEventBytes` (Entry plus Event-Metadaten, kleiner als
ein Frame) begrenzt; ein Write, Notify oder Take, dessen Event diese Grenze überschritte, wird vor Annahme mit
`ResourceExhausted` abgewiesen.

`maxBytes` muss eine positive ganze Zahl sein; ohne Angabe gilt das Frame-Budget. Reicht das effektive Budget
nicht für das nächste ganze Element einschließlich Metadaten, Cursor und Token, kommt
`ResponseBudgetTooSmall {requiredBytes}` statt einer leeren Fortschrittsseite. Cursor, ACK-Stand und fachlicher
Operationszustand bleiben unverändert. Der Client wiederholt mit größerem Budget und demselben Snapshot-Token
bzw. Cursor; ist der Snapshot inzwischen abgelaufen, gilt `SnapshotExpired`. `requiredBytes` überschreitet
das Frame-Budget nicht: Die Elementgrenzen reservieren auch den vollständigen Antwort-Overhead. Andernfalls
liegt ein Protokoll-/Konfigurationsfehler vor, der nicht durch Überschreiten des Frame-Limits umgangen wird.

**Mailbox:** ACK nur für den authentifizierten Consumer, passende `mailboxEpoch` und bereits ausgelieferte Sequenzen; nur
zusammenhängende Präfixe. Alte ACKs löschen nach Reset keine neuen Events. TTL-Verlust wird als Lücke gemeldet.
ACK bestätigt Transportübernahme, keinen Take-Commit.

**Rückstau:** getrennte Byte-/Anzahllimits für Entries, Claims, Journal, Mailbox, Snapshots, Stream; maximale
Pending-Operationen pro Principal und Transport-Peer; Platz für Ergebnis/Claim vor der Mutation reservieren.
Überlast → `ResourceExhausted` vor Annahme. Mailbox höchstens 7 Tage plus Byte-Limit; bei Erreichen werden neue
betroffene Operationen abgelehnt statt aktive Take-Ergebnisse zu verlieren. Replikationsrückstau blockiert
synchrone Writes. Rate-Limits auch für Enrollment, Reads, Polls, Txns, ACKs.

**Lokale Umsetzung und Recovery (Stufe 1):** Der Claim speichert weiterhin nur den Argument-Hash,
Frist und reservierten Ergebnisplatz. Ein separat persistierter RPC-Waiter speichert Template, Take/Read,
Txn und feste Deadline als Ausführungszustand. So kann der Host nach Reopen entscheiden, ohne einen
noch laufenden ursprünglichen Aufrufer zu benötigen; dies ist keine Speicherung roher Argumente im Claim.
Unveränderliche Snapshot-Tokens sind in Stufe 1 hostlokal, an Strom/Query/Owner gebunden und begrenzt
(TTL 60 s, 16 Snapshots und 64 MiB je Space). Reopen oder Verdrängung ergibt `SnapshotExpired`.
`count`/`stats` und die mitgelieferte Revision stammen aus einem gemeinsamen Snapshot.

Bei Mailbox-TTL-Verlust entsteht eine neue `mailboxEpoch` mit Gap zum verlorenen Präfix. Der erhaltene
Suffix behält seine Sequenznummern; der Server liefert den Startcursor der neuen Epoche mit. Ein altes
ACK kann keine neuen Events löschen. Nicht bestätigte verlorene Take-Events stellen die Take-Txn in eine
dauerhafte, budgetbegrenzt verarbeitete Freigabequeue; bestätigte Zustellungen bleiben von ihrer separaten
Txn-Entscheidung abhängig. Physisches Löschen eines bereits geACKten Präfixes erfolgt in begrenzten
Wartungscommits. ACK bestätigt Empfang, niemals Task-Abschluss.

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
  | { type: string; mode: "sync"; variant: "primary"; member: string; primaryReplica: string; replicaConfigVersion: number;
      durability: "single"; backupReplica?: string }          // optional asynchroner Snapshot, nie Promotion
  | { type: string; mode: "sync"; variant: "primary"; member: string; primaryReplica: string; replicaConfigVersion: number;
      durability: "sync"; standbyReplica: string }            // Standby Pflicht
  | { type: string; mode: "sync"; variant: "lww"; members: string[]; keyFields: string[]; semantics: "state" }
  | { type: string; mode: "sync"; variant: "set"; members: string[]; semantics: "facts" };
type CompletionProfile = {
  taskType: string; resultTypes: string[]; equalFields: string[];
  maxResultBytes: number; maxResultCount: number; maxLeaseMs: number;
};
type Policy = {
  authorityId: string; policyVersion: number; rules: Rule[];
  completionProfiles: CompletionProfile[]; // erzwungene Task-Abschlüsse, immer und auch während drain
  default: { mode: "local"; member: string };
};
```

- **Abschlussprofile:** In Stufe 1 (ohne Policy) wird ein `CompletionProfile` als lokale Konfiguration des Space
  hinterlegt; ab Stufe 2 ersetzt das Profil aus der Policy diese Übergangskonfiguration. Hat ein Task-Typ ein `CompletionProfile`, prüft der Member **jeden** Commit einer Txn,
  die einen solchen Task destruktiv nimmt: Pro genommenem Task müssen zwischen 1 und `maxResultCount`
  Ergebnisse der `resultTypes` mit gleichen `equalFields` in derselben Txn geschrieben sein, innerhalb von
  `maxResultBytes`; profilbezogene Validierungen (beim Sieb genau ein `SieveResult` mit `rangeStart`/`rangeEnd`
  des Tasks) gelten ebenfalls. Sonst scheitert der Commit mit `CompletionViolation`, und die Txn bleibt
  abbrechbar. Ein Take ohne Ergebnis ist nur über einen gesonderten Admin-Command `purgeTasks` (eigener Scope,
  Audit) zulässig. So ist „atomarer Task-/Ergebnisabschluss“ eine Servereigenschaft, nicht nur eine Eigenschaft
  korrekt geschriebener Worker.
- `semantics` ist ein Pflichtfeld zur ausdrücklichen Bestätigung: lww nur für Zustand (Sensorwerte,
  Konfiguration, Status), set nur für Fakten/Beobachtungen. Für Jobs, einmalige Aktionen oder Zahlungen sind
  beide unzulässig; dort gilt expand oder primary.
- `primaryEpoch` pro logischem Space. In v3 umfasst primary den ganzen Member einschließlich interner Dokumente;
  alle Typregeln eines Members haben dieselbe Replikatkonfiguration. Control-Daten inklusive Capability bleiben
  einheitlich primary.
- **Modusgrenzen pro Member:** Ein Member mit primary-Replikation darf in v3 nur in `local`- und
  primary-Regeln vorkommen. Steht er zusätzlich in einer expand-Regel, wäre das der RAID-10-Fall (7.3). Steht er
  in einer lww/set-Regel, würden dieselben Entries über zwei Replikationspfade laufen. Beides weist die
  Policy-Validierung ab. Members von expand- und lww/set-Regeln haben keine primary-Replikate.
- Pro Typ genau eine Regel; Supertypen im Template erweitern die Suche auf alle betroffenen Regeln.
  Verwaltete Regeln deklarieren dafür optional `supertypes: string[]`; der Router bildet die azyklische
  transitive Hülle. Verwaltete Entries dürfen keine nicht deklarierte Supertypen einschleusen. Writes tragen die
  vollständige deklarierte Hülle; Member prüfen sie ebenfalls. Die Hierarchie vorhandener Typen bleibt
  wie deren Platzierung unveränderlich, damit Suchen keinen bereits vorhandenen Bestand übersehen. `local` meint
  den explizit benannten Member, nie implizit den Host des Clients.
- Direkte Member-Zugriffe prüfen dieselben Modus-, Rechte- und Routinggrenzen; verwaltete expand-Typen dürfen
  außerhalb ihres Members nicht direkt geschrieben werden.

**Router-Journal:** vor dem ersten Remote-Aufruf: logischer Request, Principal, Policy-Version, Ziele,
Unterrequest-IDs, Request-Generationen der Ziele, Deadline. Eine begonnene Operation wechselt bei Timeout weder
Member noch Policy; ihre Folgeoperationen tragen die ursprüngliche Policy-Version (4.4). Entfernte
Ergebnisse werden dauerhaft übernommen, bevor Client-Antwort oder ACK erfolgt.

**Waiter-Wettlauf:** alle Registrierungs-IDs und eine Generation pro Versuch werden journalisiert. Die erste noch
aktive Reservierung wird atomar Gewinner; Verlierer werden storniert/abgebrochen, auch bei späten Events. Replay
ändert den Gewinner nicht. Ohne Nutzer-Txn committet der Router die Gewinner-Txn mit stabiler Unterrequest-ID.
Mit Nutzer-Txn wird nur auf deren Member gearbeitet; eine von `space_wait` zurückgegebene Txn gehört explizit dem
ursprünglichen Principal. Nach Neustart werden offene Zustände über dieselben Unterrequests aufgelöst; ein
unklarer Commit wird aufgelöst, nie durch einen zweiten Gewinner ersetzt.

## 7. Modi

### 7.1 expand

- **write:** Typ → fester Member; Feld → HRW über die festgelegte Member-Menge. Eingabe des HRW-Hashes ist nur
  die kanonische Kodierung des Feldwerts, nicht der Typ. Regeln mit demselben Feld und derselben Member-Menge
  legen gleiche Werte daher auf denselben Member (z.B. Task und Ergebnis mit gleicher `taskId`); capacity/capability → Auswahl vor
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

**Aufnahme eines Space mit Bestand:** `addMember` prüft vor der Aufnahme den Inhalt des Space einschließlich
unsichtbarer Txn-Writes, Waiter und Claims. Enthält er Entries eines Typs, den die Policy einem anderen Member
oder einer HRW-Menge ohne diesen Member zuordnet, wird das Command mit `RoutingConflict` und der Liste der
betroffenen Typen abgewiesen. Erlaubt sind nur Bestände ungeregelter Typen (die dann eine neue Regel mit genau
diesem Member erhalten) und leere Spaces.

**HRW-Members:** Da die HRW-Menge unveränderlich ist, kann ein HRW-Member weder entfernt noch durch einen anderen
ersetzt werden. `drain` auf einem HRW-Member weist neue Platzierungen für seinen Schlüsselanteil mit `MemberDrained` ab
(gebundene Abschluss-Writes nach dem folgenden Drain-Vertrag bleiben erlaubt),
statt sie anderswo zu platzieren; `removeMember` wird für ihn mit `MigrationRequired` abgewiesen. Entfernbar
sind in v3 nur Members mit fester Typzuordnung (nach Leerung) und Members von capacity/capability-Regeln.

**capacity/capability-Mengen:** `setPolicy` darf die Memberliste einer capacity/capability-Regel **erweitern**,
weil dort die Auswahl journalisiert und nicht aus dem Schlüssel berechnet wird; frühere Standorte bleiben in der
Suchmenge. Verkleinern nur über drain plus Leerung.

**drain:** Der Member persistiert `draining` und eine Admission-Grenze. Neue unabhängige Platzierungen sind
gesperrt, bestehende Reads und Takes bleiben erreichbar. Bereits angenommene Operationen behalten ihr Ziel.
Eine vor der Grenze begonnene Txn darf innerhalb ihres reservierten Abschlussbudgets Folge-Writes auf demselben
Member ausführen. Ein nach der Grenze begonnener Take-Txn darf vorhandene Aufgaben abarbeiten; dazu erteilt der
Member beim erfolgreichen Take eine an Principal/Txn/Task gebundene Abschlussberechtigung mit endlicher Lease,
erlaubten Ergebnistypen und Byte-/Anzahllimit. Diese Abschlussprofile sind Teil der validierten Typ-Policy, gelten
nach 6.4 ohnehin für jeden Abschluss und müssen vor drain feststehen; beim Sieb nur `SieveResult` mit derselben runId/taskId, keine neuen `SieveTask`.
Ohne passendes Profil darf während drain keine neue verarbeitende Take-Txn starten; reine destruktive Takes
zum autorisierten Leeren bleiben möglich. Freie Writes oder unbegrenzte Lease-Verlängerungen sind keine
Abschlussarbeit. Direkte Zugriffe und lokale Worker unterliegen derselben Admission-Grenze.

Ein Abbruch geschieht über `cancelOperation` **am Member**; das tatsächliche Resultat wird übernommen.
Ein Journal wird bei unbekanntem Ausgang nie einseitig `cancelled`. Bei capacity/capability bleiben frühere
Standorte bis zur Entfernung in der Suchmenge.

**Abschließende Entfernung:** `removeMember` führt nach drain zunächst `freezeForRemoval` am Member aus
(interner idempotenter Schritt, keine allgemeine Admin-Shell). `removing` sperrt alle neuen fachlichen
Mutationen, Take-Claims, Txns und Registrierungen auch lokal; laufende Arbeit muss zuvor entschieden oder
abgebrochen werden. Nur begrenzte Wartung, Status und Ergebnisabruf bleiben erlaubt. Der Member bestätigt
`EmptyProof {spaceId, authorityId, removalId, admissionVersion, revision}` erst bei fehlenden Entries inklusive
unsichtbarer Writes, Txns/Sperren, Waitern, **aktiven Notify-Registrierungen**, Folgeaufträgen und offenen
Operationen. `freezeForRemoval` beendet bestehende Notify-Registrierungen geordnet: Jede erhält als letztes
Event `registrationClosed {reason: "removing"}` in ihrer Mailbox und gilt dann als beendet. Ausstehende
Mailbox-Events einschließlich dieses Abschlussevents bleiben bis ACK oder TTL über die gespeicherte Space-ID
abrufbar; sie zählen nicht als aktive Registrierung. Geschützte abgeschlossene
Claims/Auditdaten dürfen gemäß Frist verbleiben. Der Router prüft zusätzlich seine offenen Unterrequests,
Worker-/Run-Bindungen und Routingreferenzen und entfernt dann Membership und betroffene leere Regeln in einem
Control-Commit; die Default-Regel braucht dabei ein gültiges verbleibendes Ziel. Erst danach bestätigt er dem
Member `detached`. Bei Absturz bleibt die lokale Sperre erhalten; Retry benutzt dieselbe removalId.
Eine Rücknahme der Sperre ist nur nach autoritativem Nachweis erlaubt, dass die Entfernung nicht committed
wurde. Bei unbekanntem Ausgang keine lokale Freigabe. Ergebnisabruf über die gespeicherte Space-ID bleibt
bis Fristende möglich; Archivierung/Löschung darf diese Frist nicht stillschweigend verkürzen.
Für Aufnahme eines vorhandenen Space gilt dieselbe lokale Sperre während Bestandsprüfung und Aktivierung;
konkurrierende lokale Writes dürfen die Prüfung aus 7.1 nicht überholen.

**Migration** bestehender Bestände ist ein späteres Feature (versionierte Routingtabellen, Transferjournal,
Übergangslesen, Eigentumsübergabe). `take A → write B` ist kein sicheres Verfahren. Bis dahin werden Änderungen
mit Migrationsbedarf abgewiesen.

### 7.2 sync

| Variante | Anwendung | Garantie |
|---|---|---|
| primary/sync | Control Space (ab Stufe 3), Jobs mit HA | ein aktiver Primary; ohne Standby keine Bestätigung; Promotion nach 5.3 |
| primary/single | Einzelhost, optional asynchroner Snapshot | lokal atomar; verlustbehafteter Restore nach 5.2.1/5.2.2 statt Failover |
| lww | Zustand mit Schlüssel | deterministische Konvergenz inklusive versionierter Löschungen |
| set | Fakten/Beobachtungen | Observed-Remove-Set, Add-Wins; keine exklusive Vergabe |

**primary:** Pro Space gibt es eine vollständige geordnete Commit-Historie und höchstens einen noch nicht
lokal angewendeten versiegelten Kandidaten. Vor dem Versiegeln prüft der Primary Rechte, Deadlines, Leases,
Konflikte und sämtliche Abschlussbudgets. Er persistiert dann `CommitIntent {authorityId, primaryEpoch,
revision, previousHash, batchHash, deltas, claims, validatedAt}` atomar und dauerhaft **vor** dem Senden.
Versiegeln legt den Inhalt unwiderruflich fest, ist aber noch keine sichtbare Erfolgsbestätigung; spätere
Mutationen, Cancel, Widerruf oder Reaper dürfen diesen Kandidaten nicht verändern/überholen. Clients sehen
`pending/commitSealed` und müssen den Ausgang weiter abfragen.

Der Standby nimmt nur das lückenlose nächste Intent derselben Konfiguration an und persistiert den Batch vor
dem ACK. Dort angenommene Batches gelten als entschieden und werden bei Promotion angewendet. Am Primary
wird ein Commit erst sichtbar/beantwortet, wenn der Standby bestätigt und der Primary lokal angewendet hat.
Die Historie des Standbys enthält alle dort angenommenen Batches und damit alle bestätigten Wirkungen.
Ein nur lokal versiegelter, noch nicht angenommener Kandidat kann bei Verlust des Primary-Storage fehlen.
Unbekannte IDs älterer `primaryEpoch` werden nur nach dem Nachweis, der Prüfreihenfolge und dem dauerhaften
Negativclaim aus 6.2 mit `NotCommitted` beantwortet; Claim-Bereinigung oder Restore erlauben diesen Schluss nicht.
Nach Neustart fragt der Primary den Standby nach Revision/Hash: identisch vorhanden → lokal anwenden;
noch nicht vorhanden → denselben Kandidaten senden; Konflikt/Lücke → blockieren. Ohne Standby keine normale
Bestätigung. Nur nach verifiziertem Fencing darf 5.3.1 den gespeicherten Kandidaten lokal zu Ende führen.
Das ist Recovery der bereits versiegelten Wirkung, keine neue Geschäftsoperation mit erneut geprüfter Deadline.
Vor dem Versiegeln bleiben Deadline-Ablauf und Cancel reguläre mögliche Entscheidungen.

Replikate liefern nur als veraltbar markierte Reads; konsistente Reads und Takes gehen zum Primary. Kein stiller
Rückfall auf asynchron. Snapshot plus Stream und der Konfigurationsübergang aus 5.3.1 richten Standbys ein.
Die lokale versionierte Replikatkonfiguration ist autoritativ für Commit/Promotion; die FederationPolicy ist
deren Routing-Abbild und darf sie bei einem Versionsrückstand nicht überschreiben.

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
gelöscht wird. Sichtbar ist bei lww immer nur die gewinnende Version; ist sie abgelaufen, gilt der Schlüssel als
nicht vorhanden. Ältere, noch nicht abgelaufene Versionen werden **nie** wieder sichtbar, sonst lebte überholter
Zustand auf. Erst eine neuere Version (Put oder Renewal) macht den Schlüssel wieder sichtbar. Ablauf kann innerhalb der Zeitunsicherheit unterschiedlich sichtbar sein; bei überschrittener
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
| supervisor | Enrollment, Supervisor-Commands (5), Signatur der `RouterLease`, Recovery, Promotion, Umschaltung (5.3.1) | nur vorgesehene atomare Übergänge |
| ungepaarter Peer | eigenes Enrollment | sonst nichts |

Geschützte Typen sind auch gegen Take, Lease-Eingriff und Txn-Mutation geschützt; Templates mit Supertypen oder
ohne Typ umgehen das nicht. Lesen/Listen/Notify filtern nach Leserechten. Enroll-Hashes, Schlüsselverwaltung,
interne Claim-/Journal-Dokumente werden nie an member/observer ausgeliefert. Eigene Operationsresultate und
Mailbox-Inhalte sind über die gefilterten Endpunkte aus 6.2 zugänglich; nach Rechteentzug gilt 4.3.
Inhalte anderer Hosts bleiben untrusted;
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

### Stufe 0 – Core-Voraussetzungen
- Erledigt laut [Implementierungsstand](implementierungsstand.md): `SpaceLike`, kanonische JSON-Kodierung,
  globale IDs, Revisionen/Changes, bytebegrenzte Seiten und interne Budgets.
- pi-serverd-Einbindung und lokale Mailboxes sind mit AP 1 abgenommen; server.mjs-/Handy-UI, Gate und
  Federation-Bausteine bleiben separat.
- **Abnahme:** bestehende Suite und Regressionstests grün; lokale Worker koordinieren sich; Tests unterscheiden
  Reservierung, Commit und externe Wirkung; Budgets und pi-serverd-Einbindung nachgewiesen.

### Stufe 1 – Benannte Spaces und lokales Protokoll
- Doc-Version 5 und Migration 4 → 5; IDs, Rechte-Grundmodell, Meter pro Space, Byte-Limits, Revisionen.
- RPC-Claims (dauerhaft, Argument-Hash, Fristen), Generationen, Pending-Ops, `cancelOperation`, Mailboxes/ACKs,
  Snapshot-Pagination, `RemoteSpace` mit Client-Wartegrenze.
- **Abnahme:** zwei Spaces ohne ID-Kollision; Take-Commit mit verlorener Antwort liefert nach Prozessneustart
  dasselbe Ergebnis ohne zweiten Take; RPC-Claims enthalten keine kopierten Klartext-Argumente (Entry-Daten
  und benötigter Pending-Operationszustand bleiben regulär persistent); lange Polls, Claim-Ablauf,
  `RequestExpired`, falsche Argumente, alte ACKs geprüft; Migrationsfixtures erhalten Entries, Txns, Outbox.

### Stufe 1b – Overlay, Autorisierung, Enrollment
- Gate mit Grenzen, `maxCommitBytes` und Dienst-Allowlist; Schicht A/B mit verbindungsgebundener Challenge;
  vollständige Typ-/Operations-ACLs.
- Control Space single plus asynchroner Snapshot und Restore nach 5.2.1; Data-Restore nach 5.2.2 mit
  `restoredUnverified` und `releaseRestored`; Supervisor, lokaler Recovery Space mit
  Out-of-Band-Zugang (5.4); Enrollment ohne Router mit Rate-Limits; Supervisor-Commands `createEnroll`,
  `revokePeer`, `rotateKey`.
- NetBird-Testmatrix (4.6), Schlüsselablage auf Zielplattformen, Widerruf und Grant-Ablauf.
- **Abnahme:** Handy und ein Test-Client auf dem Desktop (Testtreiber, nicht das Paket aus Stufe 4) gepairt;
  ungepaarter Peer nur Enrollment; Fehlversuchslimit greift; ein fremder Peer kann den Token nicht verbrennen;
  weitergereichte Challenge (fremde `observedPeerId`) scheitert; gefälschtes zweites Hello und fremde Dienste
  abgewiesen; geschützte Typen weder nehmbar noch über Lease/Txn löschbar; `revokePeer` wirkt innerhalb der
  Grenze; Restore mit neuer Daten- und Autoritätsinkarnation, alte unbekannte Request-IDs ergeben
  `IncarnationChanged`, bekannte Ergebnisse bleiben für neu autorisierte Auflösung zugänglich;
  Recovery-Request bei gesperrtem NetBird-Management über den Out-of-Band-Zugang möglich; zu großer Commit wird
  abgewiesen.

### Stufe 2 – Router und expand
- Journal mit Unterrequest-Deduplizierung und Recovery; feste Policy-Versionen; Regeln 7.1; drain;
  `readAll` mit `allowPartial`/`waitForComplete`; Capability-Verzeichnis.
- Delegation nach 4.4: vom Supervisor signierte `RouterLease`, `routerEpoch`/`EpochNotice`, Policy-Versionsprüfung
  mit Folgeoperationen, Delegationserneuerung für lange Operationen.
- **Abnahme:** 1000 Jobs, 3 Members, 6 Worker: höchstens ein destruktiver Commit je Entry; Absturz nach jeder
  Journal-/RPC-/ACK-Grenze auf persistentem Storage ohne Doppelwirkung; Retries ändern die Zielbindung nicht;
  drain mit laufenden Takes verliert und verdoppelt nichts.
- Delegationen scheitern bei:
  - alter Policy-Version für neue Operationen,
  - falscher Audience, Generation oder abgelaufener Router-Lease,
  - selbst signierter Lease oder Lease mit alter `routerEpoch`,
  - falschem Argument-Hash.
- Ebenfalls abgenommen:
  - Poll und Cancel einer begonnenen Operation funktionieren nach `setPolicy`.
  - Ein `space_wait` über mehrere Minuten wird korrekt entschieden.
  - `addMember` mit Bestand eines verwalteten Typs wird abgewiesen.
  - `removeMember` auf einem HRW-Member wird abgewiesen.
  - Idempotenz-Beispiel und Gegenbeispiel dokumentieren die Grenze externer Wirkungen.

### Stufe 3 – Replikation und kontrollierte Übernahme
- Snapshot-/Stream-Import, lww/set mit versionierten Deletes, Leases, Deduplizierung, Offline-Rejoin.
- primary/sync mit festem Standby und `setStandby`; Control Space wechselt auf primary/sync; Router-Lease über
  sync-Commits; Fencing-Adapter nach 5.5 mit Quarantänemodus; Promotion nach 5.3; Umschaltung nach 5.3.1;
  Policy-Validierung der Modusgrenzen (6.4).
- **Abnahme:** 10-min-Partition mit konkurrierenden Writes/Deletes/Erneuerungen konvergiert; alter Put belebt
  keinen Tombstone wieder; natürlicher Ablauf löscht keine neuere Erneuerung; Snapshot unter Last verliert nichts;
  ohne Standby keine Bestätigung; Promotion ohne verifizierten Fencing-Nachweis, mit Marker-Adapter oder auf
  falschem Standby verweigert; alter Router kann nach Lease-Ablauf nichts mehr delegieren; bestätigte Ergebnisse
  bleiben nach Promotion erhalten; alter Primary startet nach `release` nur in Quarantäne; ältere lww-Version
  wird nach Ablauf der Gewinnerversion nicht sichtbar; Standby-Ausfall sperrt Bestätigungen, `degradeToSingle`
  ohne Standby-Fencing wird verweigert; Policy mit primary-Member in expand- oder lww-Regel wird abgewiesen.

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

### 12.1 Zusätzliche verpflichtende Abnahmefälle der Konsistenzprüfung

Die folgenden Fälle sind noch auszuführen; ihre Aufnahme ist keine Implementierungs- oder Testabnahme.

| Stufe | Fehlerablauf / Nachweis | Erwartung |
|---|---|---|
| 1 | Bekannter Pending-Request überlebt Generationsende; neue ID derselben Generation | Poll/Retry/zulässige Fortführung funktionieren; neue ID wird abgewiesen; Ergebnisfrist erst ab Abschluss |
| 1b | Token als Markierungswert im Enrollment, Reopen und Snapshot-/Stream-Inspektion | kein Klartext-Token in irgendeinem persistenten Kanal; Retry nach verbrauchtem Token liefert eigenes Ergebnis |
| 1b | Erstinstallation, Abbruch vor/nach Admin-Pairing, erneuter Script-Apply | kein Host-Enrollment/Command vor Admin-Autorisierung; Bootstrap-Recht nach Verbrauch dauerhaft geschlossen |
| 1b | Restore bei offline Member mit beliebig hohen alten Epochen; konkurrierender Restore | nur lokal bestätigte neue Autorität wird akzeptiert; offline Member bleibt gesperrt; zweiter Übergang scheitert |
| 1b | Schlüsselwiderruf nach Snapshot, dann Restore | restaurierter Schlüssel und A-only-Regel gewähren keine Rechte ohne neue explizite Freigabe |
| 1b | Rechteentzug versus Peer-/Schlüsselwiderruf | resolution-Grant erlaubt nur eigene Auflösung; widerrufener Schlüssel keinen Selbstzugriff; Admin-Auflösung auditiert |
| 1b | Große Txn, massenhafter Ablauf und Notify-/Waiter-Fanout an Budgetgrenzen | Erweiterung wird rechtzeitig abgewiesen; bestehende Txn bleibt abschließbar; begrenzte Batches erhalten Reihenfolge/Atomarität |
| 2 | Router-Neustart mit FOREVER-Waiter und mit offline Member | unabhängiger neuer Write möglich; Waiter wird später bedient; nur abhängige Arbeit blockiert |
| 2 | Remote-Ergebnis abgelaufen, Router-Journal noch offen | needsReview ohne Ersatzwirkung; unabhängige Arbeit läuft weiter; abhängige Sperren sichtbar |
| 2 | Poll, Cancel, Commit und Abort nach Policy-/Generationswechsel; Hash-/Methodentausch | getrennte Folgeclaims und gebundene Zielreferenz; keine Rechteausweitung oder RequestConflict bei korrektem Retry |
| 2 | drain zwischen Task-Take und Result-Write; neuer Worker während drain | erlaubtes Ergebnis atomar abschließbar; neue Tasks/fremde Ergebnisse abgewiesen |
| 1b | Data-Space-Restore mit genommenem Entry nach Snapshot; neuer Take-Request | restaurierter Entry ist `restoredUnverified`, kein zweiter Take vor `releaseRestored`; alte IDs `IncarnationChanged`; Control-Autorität unverändert |
| 1 | `readAll`/`events` mit fünf Entries nahe 64 KiB; Weiterblättern unter gleichzeitigen Writes | jede Antwort passt in einen Frame; Snapshot-Seiten ohne Lücke/Dublette; übergroßes Event vor Annahme abgewiesen |
| 2 | Commit einer Sieb-Take-Txn ohne Ergebnis, mit zwei Ergebnissen oder falschen Grenzen | `CompletionViolation`; Txn bleibt abbrechbar; nur `purgeTasks` leert ohne Ergebnis |
| 2 | removeMember mit aktiver Notify-Registrierung und ungelesenen Events | Registrierung endet mit `registrationClosed`; EmptyProof erst danach; Events bis ACK/TTL abrufbar |
| 2 | Lokaler Write zwischen Leerungsprüfung und removeMember; Absturz an jedem Übergang | lokale Sperre verhindert Nachfüllen; gleicher Entfernungsvorgang wird fortgesetzt; Claims bleiben abrufbar |
| 3 | Standby persistiert Batch, ACK verloren; Primary stirbt; danach degradeToSingle | Kandidat und Ergebnis genau einmal erhalten, kein nachträglicher Miss/Abort |
| 3 | Primary-**Prozess** stirbt nach Versiegeln vor Send, Reopen des **ursprünglichen** Storage; Standby nicht erreichbar; Fencing und Single-Umschaltung | derselbe Kandidat wird lokal abgeschlossen; beschädigtes Präfix blockiert |
| 3 | Primary-**Storage** geht nach Versiegeln vor Send verloren; Standby lebt; Fencing und Promotion; Generation noch gültig | Kandidat war nie bestätigt; nach 6.2 dauerhaft entschiedener Negativclaim erlaubt `NotCommitted`; alle bestätigten Operationen bleiben erhalten |
| 3 | Take bestätigt, Antwort verloren, dann Promotion; Retry mit aktualisiertem Rahmen | gespeichertes Ergebnis ohne zweiten Take; geänderte fachliche Argumente → `RequestConflict` |
| 3 | Erststart ohne Boot-Berechtigung, veralteter Nachweis nach `setStandby`, Promotion in Quarantäne | Erststart nur mit passender Provisionierungsberechtigung; beide Replikate nach `setStandby` abgeglichen; Promotion in Quarantäne verweigert |
| 3 | Entfernten Data Space auf Single umstellen, Control dabei offline | nur lokaler Konfigurationscommit; Remote-Nutzung bis Policy-Abgleich gesperrt; kein vorgetäuschter verteilter Commit |
| 3 | Control-Promotion ohne verfügbaren Standby, danach Ersatz einrichten | erst Recovery-Single, dann Router/setStandby; Ablehnung von Single lässt System offline |
| 3 | ACK-Verlust und Neustart während setStandby; altes Replikat kehrt zurück | keine neue Schreibfreigabe bei unklarem Übergang; ausgeschlossenes Replikat kann nicht promovieren |
| 3 | Erfolgreicher Request, Claim und Generation bereinigt, dann Promotion und alter Retry | `RequestExpired`, niemals `NotCommitted` oder automatische Ersatzwirkung |
| 3 | Unbekannter alter Request gegen verspäteten Original-Aufruf mit neuem Rahmen; Absturz nach Negativclaim | entweder Originalwirkung mit bekanntem Claim oder dauerhafter Negativclaim; niemals Wirkung nach `NotCommitted` |
| 1b | Snapshot enthält wartenden Take; Original nahm danach X; Data-Restore, anschließend neuer Write Y | alter Claim nur historische Auflösung/needsReview; kein alter Waiter nimmt Y; auch nach releaseRestored keine Fortführung des alten Requests |
| 1 | maxBytes kleiner als Antwort-Overhead bzw. nächstes Element; erneut mit requiredBytes | `ResponseBudgetTooSmall`, unveränderter Cursor/ACK; vollständiges Element passt ohne Lücke oder Frame-Überschreitung |
| 3 | Zwei Spaces auf einem Host mit verschiedenen Replikatversionen; setStandby/degrade eines Space, danach Reboot beider Hosts | passende Berechtigung je Space; beide weiter zugelassenen Replikate abgeglichen; anderer Space unverändert |
| 3 | Abbruch zwischen lokaler Promotion/degrade/setStandby und externem Boot-Abgleich | nur derselbe Recovery-Übergang darf fortsetzen; vor bestätigtem Abgleich keine fachlichen Writes/Grants |

Pause-, Run- und Worker-Garantien der Erweiterung werden zusätzlich nach
[Betrieb, Abschnitt 7.4](betrieb-und-mobile-steuerung.md#74-abnahme-der-betriebserweiterung) geprüft.

## 13. Festgelegte Entscheidungen und Gates

Festgelegt in v3:

1. Grundlage ist der Vertrag aus 2.1; kein allgemeines Exactly-once für externe Wirkungen.
2. Kein mTLS auf dem Space-Port; WireGuard plus verbindungsgebundene App-Challenge (4.2, 4.3) – vorbehaltlich F3.
3. Control Space in 1b–2 single mit asynchronem Snapshot und Restore nach 5.2.1 (Fencing, neue Autorität, erneute Rechtefreigabe, Generationsende); primary/sync ab Stufe 3.
4. Keine automatische Promotion; manuelle Promotion nur nach verifiziertem Fencing (Marker nur im Simulator).
   Einzige Ausnahme: Restore im Single-Betrieb (5.2.1, 5.2.2) vor Gate 2 mit dokumentierter Konsolensperre (F15).
5. Recovery Space lokal, nicht repliziert.
6. RPC-Ergebnisse dauerhaft, Argumente nur als Hash, Fristen 24 h bis 7 Tage.
7. Delegation signiert, kanonisch kodiert, an Audience/Request/Argument-Hash/Policy-Version/Router-Lease gebunden.
8. Pairing: 256-Bit-Token, Peer-Bindung, Schlüsselbesitz, 3 Fehlversuche, 1 Versuch pro Peer und Minute.
9. Keine Migration bestehender HRW-Bestände; `addMember` ändert keine Zuordnung; drain bricht nur über den Member ab.
10. lww/set nur mit ausdrücklicher `semantics`; Deletes versioniert, natürlicher Ablauf ohne Tombstone.
11. Mailbox höchstens 7 Tage plus Byte-Limit; 24 h Mindestspeicherung abgeschlossener Ergebnisse.

Gates (vor der jeweiligen Stufe nachzuweisen):

1. Koordinator-Host, unabhängiges dauerhaftes Recovery-Register, externes Boot-Register mit CAS und
   Out-of-Band-Recovery-Zugang nach 5.4/5.5, getestet bei gesperrtem NetBird einschließlich konkurrierender
   Autoritätswechsel und Space-Berechtigungsupdates ohne Überschreiben anderer Spaces (vor 1b).
2. Konkreter Fencing-Adapter mit Neustartsperre, real getestet (vor 3).
3. Zulässige Uhrunsicherheit, HLC-Zukunftsgrenze, Sperrverhalten; gelten auch für Grants und Router-Lease (vor 1b).
4. Startwerte für Frame, `maxCommitBytes`, Verbindungen und Handshake festgelegt (vor 1b, F11); konkrete
   Byte-/Anzahl-Limits, Snapshot- und Generationslaufzeiten aus Lasttests bestätigt (vor 2).
5. NetBird-Version, Deployment, Lizenzen, Management-API-Rechte, Ergebnisse der Testmatrix 4.6 (vor 1b).
6. Schlüsselablage auf Zielplattformen (Android-Keystore: Ed25519 oder P-256), WebCrypto für Browser (vor 1b/4).

## 14. Offene Fragen

Fragen, die ohne Entscheidung des Betreibers nicht beantwortbar sind. F2–F8, F10–F15 sind entschieden (Empfehlung übernommen; F2–F7 und F11 am 2026-10-08). F11 gilt für die Startwerte; die finalen Werte bestimmt der Lasttest vor Stufe 2 (Gate 4). Empfehlungen sind Vorschläge.

| # | Frage | Empfehlung | blockiert |
|---|---|---|---|
| F1 | Auf welcher Infrastruktur laufen die Hosts? Davon hängt der Fencing-Adapter ab. | Bei VPS nach 4.1.1: Cloud-Adapter über die Anbieter-API (Server stoppen, Neustart sperren, Quarantäne-Merkmal setzen). Nur für Heimgeräte: schaltbare Steckdose/PDU mit API | Stufe 3 |
| F2 | Welcher Host ist Koordinator, welcher Standby? Läuft der Koordinator getrennt von der NetBird-VM? | Koordinator und Standby als VPS nach 4.1.1 auf getrennten physischen Hosts/Zonen in naher Region; NetBird-VM getrennt. Für 1b genügt die Wahl des Koordinators | 1b (Standby: 3) |
| F3 | Reicht WireGuard plus App-Challenge, oder gibt es eine Anforderung (Compliance, Audit) für TLS/mTLS auf dem Space-Port? | kein mTLS | 1b |
| F4 | Challenge pro Verbindung (v3) oder Signatur pro Request (v2)? | pro Verbindung; Delegation ohnehin pro Request signiert | 1b |
| F5 | Ist für den Control Space in 1b–2 ein Restore mit möglichem Verlust der letzten Minuten akzeptabel? | ja, mit neuer Autorität und expliziter Rechtefreigabe; verwaiste Wirkungen nach 5.2.1 Schritt 5 werden geprüft | 1b |
| F6 | Welche Uhrunsicherheit ist zulässig (NTP auf allen Hosts)? | 2 s, Sperre ab 5 s; HLC-Zukunftsgrenze 60 s | 1b |
| F7 | Grant-Laufzeit 60 s und Router-Lease 60 s/20 s, jeweils zuzüglich Zeitunsicherheit: akzeptabel als maximale Widerrufsverzögerung? | ja | 1b |
| F8 | Werden RPC-Ergebnisse 24 h oder bis 7 Tage aufbewahrt? | 24 h | 1 |
| F9 | Welche Inhalte gelten als personenbezogen, und braucht es eine Löschfunktion pro Principal über Entries, Claims und Mailboxes? | ja, als Admin-Command in Stufe 2 | 2 |
| F10 | Ist Teilergebnis-Lesen (`allowPartial`) für Dashboards Standard oder nur explizit? | nur explizit; Dashboard setzt es | 2 |
| F11 | Startwerte für Frame (256 KiB), `maxCommitBytes` (192 KiB), Verbindungen pro Peer (32), Handshake (5 s) passend? | bis Lasttest übernehmen | 1 (Startwerte), 2 (final) |
| F12 | Wird das Browser-Gateway gebraucht, oder genügen Handy-App und CLI? | zurückstellen | 4 |
| F13 | Wird automatische Migration (HRW-Erweiterung) gebraucht? Sie ist nicht in v3. | erst bei konkretem Bedarf | – |
| F14 | Sollen die v2-Dokumente (`federation-plan-v2*.md`, `.DOCS-UPDATE.md`) archiviert oder gelöscht und `README.md` auf v3 umgestellt werden? Sie verweisen auf nicht existierende Dateien und erklären die gründlichere v1 für veraltet. | README auf v3 umstellen, v2 als „ersetzt“ markieren | – |
| F15 | Darf vor Abnahme eines realen Fencing-Adapters (Gate 2) ein dokumentiertes Abschalten mit Neustartsperre über die Anbieterkonsole als Fencing-Nachweis für einen Restore in 1b–2 gelten? Das lockert „bloße Admin-Behauptung genügt nicht“ (5.3, Entscheidung 4). | ja, nur für Restore im Single-Betrieb, mit Screenshot/API-Auszug im Audit; nie für Promotion | 1b |

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
