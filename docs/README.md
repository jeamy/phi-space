# phi-spaces Dokumentation

| Dokument | Inhalt | Status |
|---|---|---|
| [implementierungsstand.md](implementierungsstand.md) | implementierter Umfang, Nachweise und Grenzen | **aktuell** |
| [api.md](api.md) | TypeScript-, Dienst- und Remote-API | **aktuell** |
| [Vollständige Namensumstellung](namensumstellung-2026-10-18.md) | einheitliche Namen, Speicher-/Bundle-Formatbruch, Prüfnachweise und Betriebsgrenzen | lokal umgesetzt; bestehende Stores/externes Deployment separat |
| [umstellung-ohne-pi-durable.md](umstellung-ohne-pi-durable.md) | eigenständiger Space-Host, Haltbarkeit, Datenmigration und Abnahme ohne pi-durable | detaillierter Ziel- und Arbeitsplan; nicht implementiert |
| [UI-Mockups](ui-mockups/UI-MOCKUPS.md) | Galerie der Dashboard-Entwürfe | UI-Konzept |
| [spaces-v1.md](spaces-v1.md) | lokaler Stand vom 2026-10-07 | historisch |
| [federation-plan-v3.md](federation-plan-v3.md) | Plan für föderierte Spaces, Gates, offene Fragen | **aktuell** |
| [implementierungsplan-v3.md](implementierungsplan-v3.md) | Reife, Vorab-Entscheidungen, Arbeitspakete und Fortschritt für v3 | **aktuell**: Stufen 0–2 und 2b umgesetzt, Stufe 3 begonnen |
| [ap1b-abnahme.md](ap1b-abnahme.md) | Phase 1b: Laufzeit, Grants, Rotation und Recovery-Bausteine | im F15-Modell abgenommen |
| [ap2-abnahme.md](ap2-abnahme.md) | Phase 2: Router, Delegation, Membership, Last- und Ausfallabnahmen | abgeschlossen (Ausnahme Block 4) |
| [ap2-gate4.md](ap2-gate4.md) | Gate 4: finale Betriebswerte | festgelegt |
| [ap3-replikation.md](ap3-replikation.md) | Phase 3: Replikationsbausteine, Stand und offene Schritte | begonnen, nicht abgenommen |
| [ap3-replica-control.md](ap3-replica-control.md) | Phase 3: Promotion, degradeToSingle, setStandby, Fencing-Schnittstelle | mit Simulator umgesetzt, Abnahme durch F1/Gate 2 blockiert |
| [dashboard.md](dashboard.md) | lesendes Live-Dashboard | umgesetzt |
| [ap1-abnahme.md](ap1-abnahme.md) | AP 1.1–1.9: Implementierung, Regressionen und native pi-serverd-Abnahme | lokal geprüft |
| [testumgebung-big.md](testumgebung-big.md) | Docker-Testumgebung auf dem Server big: Skript, Container, Fehlerinjektion, Grenzen | umgesetzt, `test/testbed/` |
| [tui.md](tui.md) | Terminaloberfläche: Spaces/Objekte, Serveraktionen, Tests und Berichte | umgesetzt; geplante Backends gesperrt |
| [betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md) | Betriebserweiterung: Läufe, Worker, Spaces, Bootstrap, mobile Steuerung, Abnahmefälle | **aktuell**: B1–B10 umgesetzt, Stand je Fall in §7.6 |
| [projektstart-autoprovisionierung.md](projektstart-autoprovisionierung.md) | automatische Remote-Bereitstellung von Runtime, Spaces, Monitoring und Federation bei Projektstart | ergänzender Zielvertrag |
| [examples.md](examples.md) | Beispiele (Pipeline, Chat, arXiv-Team) im Detail — was wirklich läuft | aktuell |
| [VALIDIERUNG.md](VALIDIERUNG.md) | lokaler Prüfnachweis und seine Grenzen | historisch (Stand 2026-10-07); aktuelle Nachweise im Implementierungsstand |
| [TESTBESPIELE.md](TESTBESPIELE.md) | Spezifikation von Ziel-Beispielen inkl. Federation-Modi | Entwurf, Zielbild |
| [examples/README.md](examples/README.md) | Index, Lernpfad, Schnellstart für alle Beispiele | aktuell |
| [../help-site/](../help-site/) | Interaktives Hilfesystem + Demos: Social Swarm Feed, Space-Chat Workbench (v1–v6), AdminSpaces-Portal | aktuell; Start `npm run help` |
| [Hilfesystem-/Demo-Analyse vom 18.10.2026](analyse-hilfesystem-demo-apps-2026-10-18.md) | Logikfehler, ungenutzter und doppelter Code, funktionale Lücken; Codebelege, Reproduktionen und Testnachweise | F01–F23 lokal behoben und als erledigt dokumentiert; Betriebsabnahmen getrennt |
| [Help-Corpus: Konsistenz und Abschluss](analyse-hilfecorpus-konsistenz-2026-10-18.md) | API-Abgleich, acht neue Praxisleitfäden, UI-Korrekturen, Prüfungen und offene Gates | lokale Umsetzung abgeschlossen; keine Deployment-/Großstore-Abnahme |
| [examples/](examples/) | geprüfte Beispielverträge und klar getrennte Entwürfe | Sieb und lokaler Cache implementiert; Federation geplant |
| federation-plan-v1.md, federation-plan-v2.md, federation-plan-v2-summary.md | frühere Fassungen | ersetzt durch v3, nur Verlauf |

Lesereihenfolge: Implementierungsstand → API → federation-plan-v3 (Abschnitt 11 Stufenplan, 13 Gates, 14 Fragen).

Die Beispieldokumente wurden am 2026-10-07 konsolidiert: fachlich falsche Codekopien, widersprüchliche Status-
und unbelegte Leistungstabellen wurden durch aktuelle Verträge ersetzt. Nachweise unterscheiden Code,
lokale geskriptete Tests, noch offene Live-Modellprüfung und zukünftige Federation.
Die v1/v2-Archive dokumentieren frühere Entscheidungen und enthalten verworfene Entwürfe.

- [Phase-1b-Betrieb und Recovery-Schnittstellen](ap1b-betrieb.md) – implementierte Konfiguration und verbleibende Betriebsintegration.

- [AP 2.1/2.8: Router und Simulator](ap2-router-und-simulator.md): implementierter Umfang, Recovery und Nachweise.

- [AP 2.2–2.5: Delegation, Routing und Membership](ap2-delegation-routing-membership.md): APIs, Core-Sperren und persistente/TCP-Nachweise.
