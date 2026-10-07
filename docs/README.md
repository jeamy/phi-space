# pi-spaces Dokumentation

| Dokument | Inhalt | Status |
|---|---|---|
| [spaces-v1.md](spaces-v1.md) | aktuelle Implementierung, Lücken, Optimierungen | aktuell |
| [federation-plan-v3.md](federation-plan-v3.md) | Plan für föderierte Spaces, Gates, offene Fragen | **aktuell** |
| [implementierungsplan-v3.md](implementierungsplan-v3.md) | Reife, Vorab-Entscheidungen, Arbeitspakete und Reihenfolge für v3 | Plan, nichts umgesetzt |
| [betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md) | Architekturdiagramme, pi-durable/Remote-Anbindung, Bootstrap, mobile Abläufe und Sieb-Beispiel | vorhandener Stand und Bedienentwurf |
| [projektstart-autoprovisionierung.md](projektstart-autoprovisionierung.md) | automatische Remote-Bereitstellung von Runtime, Spaces, Monitoring und Federation bei Projektstart | ergänzender Zielvertrag |
| [examples.md](examples.md) | Beispiele (Pipeline, Chat, arXiv-Team) im Detail — was wirklich läuft | aktuell |
| [VALIDIERUNG.md](VALIDIERUNG.md) | lokaler Prüfnachweis und seine Grenzen | Stand 2026-10-07 |
| [TESTBESPIELE.md](TESTBESPIELE.md) | Spezifikation von Ziel-Beispielen inkl. Federation-Modi | Entwurf, Zielbild |
| [examples/README.md](examples/README.md) | Index, Lernpfad, Schnellstart für alle Beispiele | aktuell |
| [examples/](examples/) | geprüfte Beispielverträge und klar getrennte Entwürfe | Sieb und lokaler Cache implementiert; Federation geplant |
| federation-plan-v1.md, federation-plan-v2.md, federation-plan-v2-summary.md | frühere Fassungen | ersetzt durch v3, nur Verlauf |

Lesereihenfolge: spaces-v1 → federation-plan-v3 (Abschnitt 11 Stufenplan, 13 Gates, 14 Fragen).

Die Beispieldokumente wurden am 2026-10-07 konsolidiert: fachlich falsche Codekopien, widersprüchliche Status-
und unbelegte Leistungstabellen wurden durch aktuelle Verträge ersetzt. Nachweise unterscheiden Code,
lokale geskriptete Tests, noch offene Live-Modellprüfung und zukünftige Federation.
Die v1/v2-Archive dokumentieren frühere Entscheidungen und enthalten verworfene Entwürfe.
