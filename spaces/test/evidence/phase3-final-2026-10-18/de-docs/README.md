# Letzter Abnahmelauf Phase 3 — 2026-10-18

Echter Lauf zu den offenen Zeilen der [Abnahme-Matrix](../../../../docs/_attic/abnahme/ap3-abnahme.en.md) auf nanoi (`nano-test`),
Host 100 (`standby-100`) und host-a (Control und nativer Root). Treiber:
`test/testbed/scenarios/phase3-final.ts` (Teil A) und `phase3-final-root.ts` (Teil B). Die Daten stehen in
`report.json`.

## Teil A (bestanden, Bündel `3b562462`, Stand `44a924a`)

| Zeile | Ablauf | Ergebnis |
|---|---|---|
| S1 | Merge-Replikation (`Sensor` lww, `Fact` set) im `default`-Space beider Hosts, nft-Partition 656 s | Beide Sichten gleich. Älterer Put belebt den Tombstone nicht; die Erneuerung überlebt den Ablauf der ersten Version; nach Ablauf der Gewinnerversion bleibt die ältere unsichtbar; Remove gegen Renew: add-wins; der gemeinsame Schlüssel konvergiert. Löschen und Erneuern liefen über `lease` (Entscheidung von heute). |
| B4 | SIGKILL des Daemons auf 100, dann auf nanoi, während Writes auf `jobs-a` | Der neu gestartete Daemon räumte die Sperre selbst (`staleOwnerLockCleared`, `processGone`, gleicher Boot). 57 Writes, alle genau einmal. |
| B2 | NetBird-Agent auf 100 für 120 s gestoppt (transiente Unit, SSH über LAN) | Ein Write blieb 141 s offen (51 `CommitSealed`-Antworten) und wurde danach entschieden. Der Daemon auf 100 lief ohne Neustart und Fehler weiter; sein Gate antwortete danach wieder. 102 Writes, alle genau einmal. |
| B3 | `jobs-full` mit 1 MiB Journal, Writes zu 8 KB | Nach 57 Writes `ResourceExhausted` vor dem Versiegeln; Lesen geht weiter, Journal-Köpfe gleich, anderer Space beschreibbar. Ein voller Datenträger (ENOSPC) wurde nicht geprüft. |

Grenze von B4: Der Treiber wartete nach dem SIGKILL auf den Neustart, bevor er weiterschrieb; ein Write im Flug
während des Abbruchs gab es hier nicht (den deckt der Lauf vom 2026-10-17 ab).

## Teil B (Root auf host-a, Member auf primary/sync)

Erster Versuch mit `jobs-root`/`final-member`: aufgegeben. Der „Fork“ war die Generationsvergabe des Routers, nicht
der Write; sein später angelegter Kind-Schritt scheiterte an der alten Policy-Version. Daraus folgten die Korrekturen
unten und ein Neuaufbau (host-a aus der Sicherung, neuer Space `jobs-root2`, Member `final-member-2`).

| Schritt | Ergebnis |
|---|---|
| Geroutete Writes, nft-Partition 3 min | Ein Write blieb 196 s offen und wurde mit derselben Request-ID entschieden. |
| Fork | Write einer gerouteten Transaktion (nutzt deren Generation); der versiegelte Kandidat auf nanoi ist nachweislich der Write. |
| Promotion von 100 mit netcup-Fencing, Degrade, Übernahme der Notice | bestanden |
| Klärung des Fork beim Nachfolger | **Befund:** Der Member wies die Klärung mit `StalePolicyVersion` ab, weil die Übernahme die Policy-Version erhöht hatte; Schritt in Prüfung, ohne Wirkung. Behoben in `91e24c1`, lokal bewiesen; real nicht wiederholt (siehe unten). |
| Rückweg mit `set-standby` bei laufendem Root | Writes währenddessen ohne Prüfung entschieden; einer 141 s offen (Übergangssperre). |
| B5: Degrade ohne Fencing-Adapter (`revokeStandbySpace`) | Kandidat lokal abgeschlossen (Revision 39), nanoi blieb aktiv, nur seine Berechtigung für den Space widerrufen. Der Root klärte den gerouteten Write **beim Nachfolger** (gleicher Host, Epoche 4) mit dem ursprünglichen Ergebnis. |
| Rückweg nach B5 | nanoi geleert, normal gestartet, per `set-standby` wieder Standby; 14 entschiedene Writes genau einmal, keiner der abgelehnten mit Wirkung. |

Der Treiberzustand wurde von Hand ergänzt: `not-committed` als Befund, `release` vom Operator vor dem Fortsetzen,
`revokeCandidate` aus `recoveredCommitted` nach dem unterbrochenen Schritt. Gebündelt liefen nacheinander
`58bd80cd` (`0f7e280`), `e6b15996` (`91e24c1`), `8469912f` (`6a13da7`) und `ebb87f58` (`275924a`) auf allen drei
Hosts.

Das `ReplicaConfigPending`-Fenster ist im Lauf nicht unterscheidbar aufgetreten: Kein Write meldete „not adopted by
the router yet“; drei meldeten „bound child outcome is unresolved“, was auch das Fenster sein kann. Es gilt als lokal
nachgewiesen (`test-delegation`).

**`NotCommitted` über den Root (bestanden, Bündel `ebb87f58`, Stand `275924a`):** host-a wurde dafür zuerst auf den
Stand vor dem Lauf zurückgesetzt (Abgleich der Control-Einträge: nur Einträge dieses Laufs). Ein frischer Root mit
nur `final-member-4` (`jobs-root4`, nanoi Primary): Fork als Write einer gerouteten Transaktion, versiegelt nur auf
nanoi; Promotion von 100 mit netcup-Fencing, Degrade, Übernahme der Notice; der Root klärte den Fork-Schritt beim
beförderten Primary mit der gebundenen Epoche als `NotCommitted`; der Fork wirkte nirgends.

Ein vorheriger Zyklus (`jobs-root3`, `final-member-3`) blieb stecken:
`addMember` steht in Phase `committed` (Policy-Version 6, Member `adding`), ohne Ergebnis; weder ein neuer Befehl
noch ein Neustart von host-a setzten fort. Auslöser war vermutlich die `policy`-Anweisung an `final-member-2`, die auf
100 versiegelt blieb, solange nanoi (gesperrt, siehe unten) nicht erreichbar war. Das ist ein eigener Befund.

## Gefundene und behobene Fehler

| Commit | Fehler |
|---|---|
| `9a74630` | Ein volles Sync-Journal sperrte die ganze Session (jedes Lesen scheiterte bis zum Neustart). |
| `f93bd67` | Der Router konnte offene Schritte nach Promotion/Degrade nicht klären; `ReplicaConfigPending` beendete Writes endgültig (Entscheidung: Klärung beim Nachfolger). |
| `91e24c1` | Die Klärung eines unbekannten Requests scheiterte an der von der Übernahme erhöhten Policy-Version. |
| `6a13da7` | host-a schrieb ab 11:48 UTC nichts mehr: Ein Space über einem Journal-Commit erzwang nach 500 Deltas eine Basis, die nicht passte (latent seit 3.8). |
| `275924a` | Ein geleertes Replikat, das die Genesis als Primary nennt, schloss ohne Berechtigung seinen Listener. |

## Vorfälle

- big startete um 09:56 UTC neu; host-a hing danach in einem veralteten Netzwerk-Namespace seines Sidecars
  (Container-Neustart behob es; member-2 und host-b ebenso betroffen, nicht angefasst).
- vpsc startete gegen 13:10 UTC neu; Register und Fencing waren dazwischen nicht erreichbar.
- Fail2Ban auf big sperrte nanoi (IPv6, `ufw-scan`); nanoi erreichte das NetBird-Management nicht (`DirectoryDown`).
  Die Regel wurde mit Zustimmung entfernt; Fail2Ban kann erneut sperren.
- Docker auf nanoi wurde um 11:21 UTC nach zwei `daemon-reload` einer fremden SSH-Sitzung gestoppt.
- Die Notice des alten Space `jobs-part` (Lauf vom 2026-10-17) liegt noch auf dem Notice-Brett und wird bei jedem
  Heartbeat abgewiesen.
- Auf 100 steht `iifname "wt0" accept` vor den Regeln aus `/etc/nftables-pi-host.nft` (nicht aus diesem Lauf).

## Rückbau

- host-a aus der Sicherung vor Teil B (Harness, `installed.sqlite`, Journal des Hauptstores, Konfiguration,
  `private/`, `pki/`), Root-Drop-in entfernt, Boot-Datensatz zurückgeschrieben. Der Abgleich der Control-Einträge vor
  jeder Rücksetzung zeigte nur Einträge dieses Laufs (Enrollments, `addMember`, `auditLog`, Router- und
  Host-Schlüssel). Im Control Space stehen wieder 13 Schlüssel, es gibt keinen Root und keine Policy.
- nanoi freigegeben; Konfigurationen beider Hosts aus `federation.json.before-final-20261018`; Boot-Datensätze auf
  die Werte vor dem Lauf.
- nft-Freigabe und Partitionsregeln auf 100 entfernt, Steuerzertifikat auf 100 gelöscht; NetBird-Gruppe und -Policy
  `final-20261018` gelöscht.
- Grundprüfung danach grün.
- Behalten: das Bündel `ebb87f58` auf allen drei Hosts, die Sicherungen (`/data/phase1b-backup-final` auf host-a,
  `*.before-final-20261018` auf nanoi und 100) und die Sync-Verzeichnisse als Beleg.
- Offen beim Operator: die befristeten Rechte des Steuerzertifikats auf vpsc zurücknehmen (`tls.json` und
  `fencing.json` aus `*.before-final-20261018`).
