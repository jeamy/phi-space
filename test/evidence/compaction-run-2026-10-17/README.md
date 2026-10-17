# Kompaktierung echt: zwei Merge-Members über NetBird — 2026-10-17

Echter Lauf von Schritt 4 aus [ap3-replikation.md](../../../docs/ap3-replikation.md) mit nano-test und standby-100.
Die Daten stehen in `report.json`.

## Aufbau

- **Bündel:** `0b114dd5` (Stand `db827bb`) auf beiden Hosts.
- **Replikation:** dieselbe wie im [Merge-Lauf](../merge-run-2026-10-17/README.md) (`merge-run-20261017`, `Sensor` als
  `lww`, `Fact` als `set`), zusätzlich `compactEveryMs: 60000`.
- **Historie:** Die Members setzten ihre Historie aus dem Merge-Lauf fort. Diese war vor Schritt 4 geschrieben worden
  (Positionen ohne Lücken, kein Vektor, eine Löschung mit geschwärzten Änderungen). So war die Übernahme alter
  Historien Teil des Laufs.

## Ergebnis

1. **Start:** Beide Hosts waren bereit, und ihre Sichten waren gleich.
2. **Schreiben:** Um 18:30:02 UTC schrieb nano viermal `s8` und standby-100 viermal `s9`. Beide zeigten danach die
   jeweils letzte Version.
3. **Kompaktierung:** Beide Hosts kompaktierten periodisch, ohne Fehler:
   - standby-100 entfernte 7 Änderungen in drei Läufen;
   - nano-test entfernte 4.
   Entfernt wurden überholte Versionen und alte Änderungen des jeweils anderen Hosts. Eigene Änderungen bleiben
   24 Stunden.
4. **Sichten:** Nach der Kompaktierung waren sie auf beiden Hosts gleich und unverändert.
5. **Danach:** Ein neuer Put auf standby-100 und ein neues `Fact` auf nano kamen über die Ströme mit Lücken beim
   jeweils anderen an.

## Rücksetzung

- Beide Konfigurationen sind wieder ohne Merge-Replikation, die Dienste laufen.
- Die Grundprüfung danach war grün; die Sicherungen sind entfernt.
- Das neue Bündel bleibt. Die `EntryReplicas`-Dokumente bleiben in den `default`-Spaces, jetzt teilweise kompaktiert.

## Grenzen

- Nur zwei Members, keine Partition während der Kompaktierung.
- Die Zahl der entfernten Änderungen stammt aus den Logs. Den Speicher gibt erst die Offline-Kompaktierung frei;
  sie lief hier nicht.
- Kein Retry einer kompaktierten Anfrage, kein Ablauf und keine Löschung während des Laufs; diese Fälle decken die
  lokalen Tests ab.
