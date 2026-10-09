# Historische Einordnung

Stand: 2026-10-07. Hintergrund, keine Zusage implementierter Federation oder JavaSpaces-Kompatibilität.

Linda beschreibt Koordination über einen assoziativen Tuple Space: out schreibt, in nimmt destruktiv,
rd liest ohne Entfernen. eval erzeugt aktive Tupel durch Ausführung; ein Write mit „Agent-Code“ ist
im heutigen pi-spaces **kein** eval-Äquivalent. Verwendete Operationen sind JavaSpaces-inspirierte
write/read/take mit Templates. pi-spaces nutzt JSON-Entries statt Java-Objekten und Remote-RMI.

Primärquelle: Carriero/Gelernter, [Linda in Context](https://doi.org/10.1145/63334.63337), 1989.
Historische Patterns können moderne Beispiele motivieren; der lokale Code ist keine historische
Referenzimplementierung und kein Leistungsnachweis für Linda, Outrigger, Blitz oder GigaSpaces.

JavaSpaces ergänzt Entries, Templates, Leases, Transaktionen und Benachrichtigungen.
Die aktuelle Abbildung im Projekt ist im [Implementierungsstand](../implementierungsstand.md) beschrieben;
die frühere Momentaufnahme bleibt in [spaces-v1.md](../spaces-v1.md). JavaSpace05-Funktionen wie
Batch-Operationen und Availability-Events sind nicht vollständig implementiert.
Eine konzeptionelle API-Nähe ist kein Zertifikat für vollständige Spezifikationskonformität.

| Pattern | Lokales Beispiel | Grenze |
|---|---|---|
| Task Bag | [Master/Worker](sieve.md) | segmentiertes Sieb; lokale transaktionale Tasks |
| Workflow | [IoT](iot.md) | atomare lokale Schritte |
| Publish/Subscribe | [Chat](chat.md) | best-effort Events in einem Harness |
| Suchaufteilung | [Golomb](golomb.md) | lokale Worker, keine CPU-/Host-Skalierungsabnahme |
| Rechercheteam | [arXiv](arxiv.md) | modellgesteuerte Interpretation mit Quellenlimits |
| Replizierter Zustand | [Cache](cache.md) | lokaler Cache implementiert; Replikation fehlt |

Weitere historische Bibliografie ist von aktuellen Implementierungsnachweisen zu trennen.
[Zur Übersicht](README.md).
