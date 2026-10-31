# lww/set echt: zwei Merge-Members über NetBird — 2026-10-17

Echter Lauf der Schritte 1 bis 3 aus [ap3-replikation.md](../../../../docs/_attic/abnahme/ap3-replikation.en.md):

- **Members:** nano-test (netcup, nur IPv6) und standby-100 (Heimnetz) als Merge-Members einer gemeinsamen
  Replikation `merge-run-20261017`.
- **Regeln:** `Sensor` als `lww` mit Schlüssel `sensorId`, `Fact` als `set`. Bedient im `default`-Space beider Hosts.
- **Bündel:** `4405c749` (Stand `031ab7d`).

Geschrieben und gelesen wurde direkt über die Gates der Members, als Admin `lux27` mit Grants von host-a. Den Weg über
den Root deckt der lokale Test ab. Die Daten stehen in `report.json`.

## Ergebnis

1. **Replikation:** Ein auf nano geschriebener `Sensor` erscheint auf 100. Die Antworten tragen `replicated: true`.
2. **Partition:** Auf 100 verwarf eine nft-Regel alles von nanos Overlay-Adresse, von 16:56:53 bis 16:59:03 UTC
   (40 Pakete).
   - Beide Seiten schrieben denselben Schlüssel (100 zuletzt) und je einen `set`-Eintrag.
   - Jede Seite sah nur ihre eigenen Änderungen.
3. **Heilung:** Gut eine Minute nach dem Aufheben (17:00:01) waren beide konvergiert.
   - `s1` hat auf beiden den später geschriebenen Wert `100-2`.
   - Beide sehen beide `set`-Einträge.
4. **Löschung eines Principals:**
   - Ein markierter geheimer Eintrag stand auf beiden Hosts in der SQLite-WAL-Datei.
   - Auf nano lief der Offline-Ablauf: Dienst stoppen, Neustart-Sperre, Boot-Datensatz `fenced`, `erase-evidence`,
     `erase-local`, `erase-compact`.
   - `erase-evidence` nannte alle sechs Merge-Änderungen des Principals, auch die von 100.
   - `erase-local` meldete die Löschung lokal als vollständig.
   - Die Kompaktierung entfernte 31 alte Revisionen. Danach stand das Geheimnis in keiner Datei von nano mehr.
5. **Verteilung:** Nach dem Start von nano kam die Löschung sofort über den Strom bei 100 an; beide Sichten waren leer.
   Die Offline-Kompaktierung auf 100 entfernte 19 Revisionen; auch dort steht das Geheimnis in keiner Datei mehr.
6. **Danach:** Ein neuer Schreibvorgang auf 100 kam bei nano an, der gelöschte Wert blieb weg.

## Rücksetzung

- Die Konfigurationen beider Hosts sind ohne Merge-Replikation zurück.
- Die Boot-Datensätze stehen wieder auf ihren ursprünglichen Werten; gesperrt waren sie nur während der
  Offline-Schritte.
- Sicherungen und das Kompaktier-Werkzeug sind entfernt. Das neue Bündel bleibt.
- Die Grundprüfung danach ist grün.
- Die `EntryReplicas`-Dokumente des Laufs bleiben in den `default`-Spaces beider Hosts: geschwärzte Historie, das
  Lösch-Ereignis und ein späterer Testeintrag.

## Grenzen

- Kein Root-Routing im echten Lauf.
- Nur zwei Members.
- Die Partition entstand durch eine Firewall-Regel, nicht durch einen echten Netzausfall.
- Keine Kompaktierung von Tombstones (Schritt 4).
