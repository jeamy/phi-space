# Testbeispiele für pi-spaces v1

**Version:** 1.0  
**Datum:** 2026-10-06  
**Status:** Entwurf  
**Zweck:** Detaillierte Spezifikation von Testbeispielen für Validierung und Demonstration.  
**Referenz:** Ergänzt `federation-plan-v3.md`.  

---

## 📋 Inhaltsverzeichnis

1. [Einleitung](#1-einleitung)
2. [Allgemeine Testziele und Metriken](#2-allgemeine-testziele-und-metriken)
3. [Testbeispiele](#3-testbeispiele)
4. [Historische Referenzen](#4-historische-referenzen)
5. [Teststrategie und Tools](#5-teststrategie-und-tools)

**Detaillierte Dokumente:**
- [🔢 Master-Worker (Primzahlsieb)](./testbeispiele/sieve.md)
- [💾 Distributed Cache](./testbeispiele/cache.md)
- [🌡️ IoT-Monitoring](./testbeispiele/iot.md)
- [🤖 LLM-Agenten (arXiv)](./testbeispiele/arxiv.md)
- [📜 Historische Referenzen](./testbeispiele/HISTORISCHE-REFERENZEN.md)

---

---

## 1. Einführung

### 1.1 Zweck
Dieses Dokument definiert **vier detaillierte Testbeispiele**, die:
- **Funktionalität** der pi-spaces-Implementierung validieren,
- **Skalierbarkeit, Fehlertoleranz und Konsistenz** nachweisen,
- **Anwendungsfälle** aus historischen Tuple-Space-Systemen (Linda, JavaSpaces, Jini) abbilden,
- **Moderne Szenarien** (z. B. LLM-Agenten) abdecken.

Die Beispiele sind **kein Code**, sondern **detaillierte Spezifikationen** für:
- Space-Typen,
- Agenten-Rollen,
- Abläufe,
- Testfälle mit Akzeptanzkriterien,
- Federation-Policy-Konfigurationen.

### 1.2 Zielgruppe
| Rolle | Nutzung | Fokus |
|-------|---------|-------|
| **Entwickler** | Implementierung der Beispiele | Space-Typen, Agenten, Abläufe |
| **Tester** | Validierung der Implementierung | Testfälle, Akzeptanzkriterien, Metriken |
| **Architekten** | Design-Entscheidungen | Modus-Wahl (expand/sync), Policy-Konfiguration |
| **Betreiber** | Deployment-Planung | Skalierbarkeit, Fehlertoleranz |

### 1.3 Beziehung zu historischen Systemen
Die Testbeispiele basieren auf **klassischen Tuple-Space-Patterns** aus:
- **Linda** (1989): Master/Worker, Dining Philosophers, Matrixmultiplikation.
- **JavaSpaces** (1999): Hello World, geteilte Variablen, Messenger/Chat, Brute-Force-Krypto.
- **Jini/GigaSpaces**: π-Berechnung, Mandelbrot-Rendering, Order-Matching, Processing Pipelines.
- **Outrigger/Blitz**: Stress-Tests (parallele Takes, Lease-Ablauf, Transaktions-Abort).

→ Siehe [Historische Referenzen](./testbeispiele/HISTORISCHE-REFERENZEN.md) für Details.

### 1.4 Beziehung zu `federation-plan-v3.md`
| Konzept | `federation-plan-v3.md` | Dieses Dokument |
|---------|--------------------------|------------------|
| **Modi (expand/sync)** | Definition der Semantik (Abschnitt 7) | **Anwendung** in konkreten Beispielen |
| **Space-Typen** | Technische Spezifikation (Abschnitt 6.1) | **Beispiel-Typen** mit Feldern |
| **Agenten** | Architektur (Abschnitt 3) | **Rollen und Abläufe** |
| **Teststrategie** | Allgemeine Richtlinien (Abschnitt 12) | **Konkrete Testfälle** mit Metriken |
| **Federation Policy** | Syntax (Abschnitt 6.4) | **Beispiel-Konfigurationen** |

---

---

## 2. Allgemeine Testziele und Metriken

### 2.1 Gemeinsame Testkategorien
Alle Beispiele müssen folgende Kategorien abdecken:

| Kategorie | Ziel | Metriken | Tools |
|-----------|------|----------|-------|
| **Korrektheit** | Ergebnisse sind fachlich richtig. | Übereinstimmung mit deterministischen Referenzimplementierungen | Jepsen, Hypothesis |
| **Konsistenz** | Daten sind über alle Members hinweg konsistent. | Linearizability, Eventual Consistency | Jepsen, custom Checks |
| **Skalierbarkeit** | System skaliert mit wachsender Last. | Durchsatz (ops/s), Latenz (p50/p99), Ressourcenverbrauch | Locust, k6, Vegeta |
| **Fehlertoleranz** | System überlebt Host-/Netzwerkfehler. | Datenverlust, Verfügbarkeit (%) | Chaos Mesh, custom Simulator |
| **Performance** | Antwortzeiten sind akzeptabel. | Latenz (ms), Durchsatz (ops/s) | Hyperfine, custom Benchmarks |
| **Robustheit** | System behält Stabilität unter Last. | Speicherverbrauch, CPU-Auslastung, Fehlerrate | Prometheus, Grafana |

### 2.2 Gemeinsame Metriken
| Metrik | Einheit | Zielwert (Beispiele) | Messmethode |
|--------|---------|----------------------|---------------|
| Durchsatz | ops/s | ≥ 100 (Master-Worker), ≥ 10.000 (Cache) | Zeit für N Operationen / N |
| Latenz (p99) | ms | ≤ 100 (Cache), ≤ 5000 (LLM) | Zeit von Request bis Response |
| Verfügbarkeit | % | ≥ 99,9% | (Up-Time / Gesamtzeit) * 100 |
| Datenverlust | % | 0% (sync), ≤ 0,1% (expand) | Vergleich mit Referenzdaten |
| Speicherverbrauch | MB/GB | ≤ Budget (z. B. 10GB pro Space) | `df -h`, Process Metrics |
| CPU-Auslastung | % | ≤ 80% | `htop`, Prometheus |

---

---

## 3. Testbeispiele

### 3.1 Übersicht

| Beispiel | Zweck | Modus | Historische Referenz | Komplexität | Dokument |
|----------|-------|-------|-----------------------|-------------|----------|
| **🔢 Master-Worker (Primzahlsieb)** | Lastverteilung, Fehlertoleranz | `expand` | Linda, JavaSpaces | ⭐⭐ | [sieve.md](./testbeispiele/sieve.md) |
| **💾 Distributed Cache** | Konsistenz, Verfügbarkeit | `sync` (lww) | JavaSpaces | ⭐⭐⭐ | [cache.md](./testbeispiele/cache.md) |
| **🌡️ IoT-Monitoring** | Echtzeit-Verarbeitung, Skalierbarkeit | `expand` + `sync` | Jini, GigaSpaces | ⭐⭐⭐ | [iot.md](./testbeispiele/iot.md) |
| **🤖 LLM-Agenten (arXiv)** | LLM-Integration, komplexe Workflows | `expand` + `sync` + `local` | JavaSpaces (Compute Server) | ⭐⭐⭐⭐ | [arxiv.md](./testbeispiele/arxiv.md) |

### 3.2 Kurzbeschreibungen

#### 🔢 Master-Worker (Primzahlsieb)
- **Anwendungsfall**: Verteilte Berechnung von Primzahlen in einem großen Zahlenbereich.
- **Pattern**: Master-Worker mit Task-Bag.
- **Agenten**: Master (erstellt Tasks), Worker (berechnen Primzahlen), Collector (aggregiert Ergebnisse).
- **Space-Typen**: `SieveTask`, `SieveResult`, `SieveSummary`.
- **Testfokus**: Korrektheit, Skalierbarkeit, Fehlertoleranz, Lastverteilung.
- **Historisch**: Entspricht Lindas **Primzahlsieb** und JavaSpaces' **Generischem Compute Server**.

#### 💾 Distributed Cache
- **Anwendungsfall**: Verteilter Key-Value-Cache mit TTL und automatischem Ablauf.
- **Pattern**: Client-Server mit Replikation.
- **Agenten**: Cache-Writer, Cache-Reader, Cache-Manager.
- **Space-Typen**: `CacheEntry`, `CacheStats`, `CacheTombstone`.
- **Testfokus**: Konsistenz (lww), Verfügbarkeit, TTL-Korrektheit, Performance.
- **Historisch**: Entspricht JavaSpaces' **geteilten Variablen** und **Kanälen/Queues**.

#### 🌡️ IoT-Monitoring
- **Anwendungsfall**: Echtzeit-Monitoring von IoT-Sensoren (Temperatur, Luftfeuchtigkeit).
- **Pattern**: Pipeline (Sensor → Aggregator → Alert → Dashboard).
- **Agenten**: Sensor-Agent, Aggregator, Alert-Agent, Dashboard-Agent.
- **Space-Typen**: `SensorReading`, `AggregatedData`, `Alert`, `DashboardData`.
- **Testfokus**: Echtzeit-Latenz, Skalierbarkeit, Fehlertoleranz, Alert-Korrektheit.
- **Historisch**: Entspricht Jinis **Processing Unit-Pipelines** und GigaSpaces' **Mandelbrot-Rendering**.

#### 🤖 LLM-Agenten (arXiv)
- **Anwendungsfall**: Automatisierte Auswertung von arXiv-Papern zu Dunkler Energie/Dunkler Materie.
- **Pattern**: Pipeline (Crawl → Classify → Summarize → Analyze → Present → Chat).
- **Agenten**: Crawler, Classifier, Summarizer, Analysis, Presenter, Chat, Monitor.
- **Space-Typen**: `PaperMetadata`, `ClassifiedPaper`, `PaperSummary`, `AnalysisResult`, `Presentation`, `UserQuery`, `QueryResponse`.
- **Testfokus**: Vollständigkeit, Klassifikationsgenauigkeit, Performance, Fehlertoleranz.
- **Historisch**: Entspricht JavaSpaces' **Generischem Compute Server** und **Messenger/Chat**.

---

---

## 4. Historische Referenzen

**Vollständige Dokumentation**: [HISTORISCHE-REFERENZEN.md](./testbeispiele/HISTORISCHE-REFERENZEN.md)

### 4.1 Übersicht
| System | Jahr | Kernkonzept | Relevanz für pi-spaces |
|--------|------|--------------|-----------------------------|
| **Linda** | 1989 | Tuple Space | Grundlage für alle Tuple-Space-Systeme |
| **JavaSpaces** | 1999 | Java-Implementierung von Tuple Spaces | Inspiriert Space-Typen und Operationen |
| **Jini** | 1999 | Service-Oriented Architecture | Inspiriert Federation und Control Space |
| **GigaSpaces** | 2000er | In-Memory Computing | Inspiriert Performance-Optimierungen |
| **Outrigger/Blitz** | 2000er | Test-Frameworks | Inspiriert Teststrategie |

### 4.2 Abbildung auf pi-spaces
| Historisches Konzept | pi-spaces-Äquivalent | Implementiert in |
|------------------------|------------------------|---------------------|
| Linda `out(t)` | `write(entry)` | ✅ Alle Beispiele |
| Linda `in(t)` | `take(template)` | ✅ Alle Beispiele |
| Linda `rd(t)` | `read(template)` | ✅ Alle Beispiele |
| JavaSpaces `Entry` | `Entry` (typisiert) | ✅ Alle Beispiele |
| JavaSpaces `Template` | `Template` (TypeScript) | ✅ Alle Beispiele |
| JavaSpaces `notify()` | `wait()` + `Mailbox` | ✅ Alle Beispiele |
| JavaSpaces `Transaction` | `txn` | ✅ Master-Worker, Distributed Cache |
| JavaSpaces `Lease` | `Lease` | ✅ Alle Beispiele |
| Jini Lookup Service | Control Space + Capability | ✅ LLM-Szenario |
| GigaSpaces Processing Units | FederatedSpace + Router | ✅ Alle Beispiele |

---

---

## 5. Teststrategie und Tools

### 5.1 Testkategorien und Tools
| Kategorie | Tools | Beispiele |
|-----------|-------|-----------|
| **Korrektheit** | Jepsen, Hypothesis | Linearizability-Tests (Cache), Konsistenz-Tests (alle) |
| **Konsistenz** | Jepsen, custom Checks | lww-Konfliktlösung (Cache), Transaktionen (Master-Worker) |
| **Skalierbarkeit** | Locust, k6, Vegeta | Lasttests (alle Beispiele) |
| **Fehlertoleranz** | Chaos Mesh, custom Simulator | Host-Absturz, Netzwerkpartition (alle) |
| **Performance** | Hyperfine, custom Benchmarks | Latenz-/Durchsatz-Messungen (alle) |
| **Robustheit** | Prometheus, Grafana | Speicher-/CPU-Monitoring (alle) |

### 5.2 Empfohlene Testumgebung

#### 5.2.1 Hardware
| Komponente | Empfehlung | Zweck |
|------------|-------------|-------|
| **Hosts** | 5–10 Raspberry Pi 5 oder x86-Server | pi-spaces-Knoten |
| **GPU-Hosts** | 2× Host mit NVIDIA GPU (z. B. RTX 4090) | LLM-Agenten (Summarizer, Chat) |
| **Storage** | SSD (NVMe) für jeden Host | Schnelle I/O für Space-Daten |
| **Netzwerk** | 1Gbps+ LAN | Niedrige Latenz zwischen Hosts |

#### 5.2.2 Software
| Komponente | Version | Zweck |
|------------|---------|-------|
| **pi-serverd** | latest | Space-Implementierung |
| **NetBird** | 1.2.0 | Overlay-Netzwerk |
| **Docker** | 24.x | Containerisierung |
| **Node.js** | 20.x | pi-client, Agenten |
| **Python** | 3.11 | Analysis-Agent, LLM-Integration |
| **LLM Runtime** | vLLM, Ollama | LLM-Inference |

### 5.3 Test-Daten
| Beispiel | Daten |
|----------|-------|
| Master-Worker | Bereich 1–10⁶ (Grundtests), 1–10⁹ (Skalierbarkeit) |
| Distributed Cache | 1.000–100.000 Schlüssel, TTL 1s–1h |
| IoT-Monitoring | 1.000–10.000 Sensoren, 1–10 Messungen/s |
| LLM-Agenten | 10–1.000 arXiv-Papers (astro-ph.CO, gr-qc) |

---

### 5.4 Validierung

| Validierungstyp | Methode | Tool | Beispiele |
|----------------|---------|------|-----------|
| **Korrektheit** | Vergleich mit Referenz | custom Script | Alle |
| **Konsistenz** | Linearizability, Eventual Consistency | Jepsen | Cache, LLM |
| **Skalierbarkeit** | Durchsatz/Latenz-Messung | Locust | Alle |
| **Fehlertoleranz** | Crash-Tests, Partitionierung | Chaos Mesh | Alle |
| **Performance** | Latenz/Durchsatz | Hyperfine | Alle |

---

---

## 📌 Zusammenfassung

| Beispiel | Dokument | Modus | Historische Referenz | Komplexität | Hauptfokus |
|----------|----------|-------|-----------------------|-------------|------------|
| Master-Worker (Primzahlsieb) | [sieve.md](./testbeispiele/sieve.md) | `expand` | Linda, JavaSpaces | ⭐⭐ | Lastverteilung, Fehlertoleranz |
| Distributed Cache | [cache.md](./testbeispiele/cache.md) | `sync` (lww) | JavaSpaces | ⭐⭐⭐ | Konsistenz, Verfügbarkeit |
| IoT-Monitoring | [iot.md](./testbeispiele/iot.md) | `expand` + `sync` | Jini, GigaSpaces | ⭐⭐⭐ | Echtzeit, Skalierbarkeit |
| LLM-Agenten (arXiv) | [arxiv.md](./testbeispiele/arxiv.md) | `expand` + `sync` + `local` | JavaSpaces, Jini | ⭐⭐⭐⭐ | LLM-Integration, Workflows |

---

### 📝 Dokumentenhistorie

| Version | Datum | Autor | Änderungen |
|---------|-------|-------|-----------|
| 1.0 | 2026-10-06 | Mistral Vibe | Erste Version: Übersicht + Verweise auf detaillierte Dokumente |

---

### 🔗 Verweise
- [federation-plan-v3.md](../federation-plan-v3.md) – Hauptdokument mit Architektur und Lösungen.
- [spaces-v1.md](../spaces-v1.md) – Basis-Implementierung der Spaces.
- [.DOCS-UPDATE.md](../.DOCS-UPDATE.md) – Übersicht über Dokumentationsänderungen.

---

**Ende des Dokuments**
