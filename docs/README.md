# pi-spaces Dokumentation

| Dokument | Inhalt | Status |
|---|---|---|
| [implementierungsstand.md](implementierungsstand.md) | implementierter Umfang, Nachweise und Grenzen | **aktuell** |
| [api.md](api.md) | TypeScript-, Dienst- und Remote-API | **aktuell** |
| [spaces-v1.md](spaces-v1.md) | lokaler Stand vom 2026-10-07 | historisch |
| [federation-plan-v3.md](federation-plan-v3.md) | Plan für föderierte Spaces, Gates, offene Fragen | **aktuell** |
| [implementierungsplan-v3.md](implementierungsplan-v3.md) | Reife, Vorab-Entscheidungen, Arbeitspakete und Fortschritt für v3 | AP 1.1–1.9 lokal umgesetzt; weitere Phasen geplant |
| [ap1-abnahme.md](ap1-abnahme.md) | AP 1.1–1.9: Implementierung, Regressionen und native pi-serverd-Abnahme | lokal geprüft |
| [testumgebung-big.md](testumgebung-big.md) | Docker-Testumgebung auf dem Server big: Skript, Container, Fehlerinjektion, Grenzen | umgesetzt, `test/testbed/` |
| [tui.md](tui.md) | Terminaloberfläche: Spaces/Objekte, Serveraktionen, Tests und Berichte | umgesetzt; geplante Backends gesperrt |
| [betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md) | Architekturdiagramme, pi-durable/Remote-Anbindung, Bootstrap, mobile Abläufe und Sieb-Beispiel | vorhandener Stand und Bedienentwurf |
| [projektstart-autoprovisionierung.md](projektstart-autoprovisionierung.md) | automatische Remote-Bereitstellung von Runtime, Spaces, Monitoring und Federation bei Projektstart | ergänzender Zielvertrag |
| [examples.md](examples.md) | Beispiele (Pipeline, Chat, arXiv-Team) im Detail — was wirklich läuft | aktuell |
| [VALIDIERUNG.md](VALIDIERUNG.md) | lokaler Prüfnachweis und seine Grenzen | Stand 2026-10-07 |
| [TESTBESPIELE.md](TESTBESPIELE.md) | Spezifikation von Ziel-Beispielen inkl. Federation-Modi | Entwurf, Zielbild |
| [examples/README.md](examples/README.md) | Index, Lernpfad, Schnellstart für alle Beispiele | aktuell |
| [examples/](examples/) | geprüfte Beispielverträge und klar getrennte Entwürfe | Sieb und lokaler Cache implementiert; Federation geplant |
| federation-plan-v1.md, federation-plan-v2.md, federation-plan-v2-summary.md | frühere Fassungen | ersetzt durch v3, nur Verlauf |

Lesereihenfolge: Implementierungsstand → API → federation-plan-v3 (Abschnitt 11 Stufenplan, 13 Gates, 14 Fragen).

Die Beispieldokumente wurden am 2026-10-07 konsolidiert: fachlich falsche Codekopien, widersprüchliche Status-
und unbelegte Leistungstabellen wurden durch aktuelle Verträge ersetzt. Nachweise unterscheiden Code,
lokale geskriptete Tests, noch offene Live-Modellprüfung und zukünftige Federation.
Die v1/v2-Archive dokumentieren frühere Entscheidungen und enthalten verworfene Entwürfe.
