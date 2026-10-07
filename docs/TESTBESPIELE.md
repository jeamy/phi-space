# examples für pi-spaces v1

**Version:** 1.1  
**Datum:** 2026-10-07  
**Status:** Entwurf  
**Zweck:** Detaillierte Spezifikation von examplesn für Validierung und Demonstration.  
**Referenz:** Ergänzt `federation-plan-v3.md`.  

> **Wichtig:** Dieses Dokument spezifiziert Ziel-Beispiele inklusive Federation-Modi (`expand`/`sync`),
> die erst ab Stufe 2 des Föderationsplans existieren. Implementierungsstand und tatsächlich
> lauffähige Beispiele: siehe [examples/README.md](./examples/README.md) und [examples.md](./examples.md).

---

## 📋 Inhaltsverzeichnis

1. [Einleitung](#1-einleitung)
2. [Allgemeine Testziele und Metriken](#2-allgemeine-testziele-und-metriken)
3. [examples](#3-examples)
4. [Historische Referenzen](#4-historische-referenzen)
5. [Teststrategie und Tools](#5-teststrategie-und-tools)

**Detaillierte Dokumente:**
- [🔢 Master-Worker (Primzahlsieb)](./examples/sieve.md)
- [💾 Distributed Cache](./examples/cache.md)
- [🌡️ IoT-Monitoring](./examples/iot.md)
- [🤖 LLM-Agenten (arXiv)](./examples/arxiv.md)
- [📏 Golomb-Lineal](./examples/golomb.md)
- [📜 Historische Referenzen](./examples/HISTORISCHE-REFERENZEN.md)
- [📋 Implementierungsanalyse](./examples/IMPLEMENTIERUNGS-ANALYSE-V2.md) – Analyse aller implementierten Beispiele

---

---

## 1. Einführung

### 1.1 Zweck
Dieses Dokument definiert **sechs detaillierte Beispiel-Spezifikationen**, die:
- **Funktionalität** der pi-spaces-Implementierung validieren,
- **Skalierbarkeit, Fehlertoleranz und Konsistenz** nachweisen,
- **Anwendungsfälle** aus historischen Tuple-Space-Systemen (Linda, JavaSpaces, Jini) abbilden,
- **Moderne Szenarien** (z. B. LLM-Agenten, kombinatorische Suche) abdecken.

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
Die examples basieren auf **klassischen Tuple-Space-Patterns** aus:
- **Linda** (1989): Master/Worker, Dining Philosophers, Matrixmultiplikation.
- **JavaSpaces** (1999): Hello World, geteilte Variablen, Messenger/Chat, Brute-Force-Krypto.
- **Jini/GigaSpaces**: π-Berechnung, Mandelbrot-Rendering, Order-Matching, Processing Pipelines.
- **Outrigger/Blitz**: Stress-Tests (parallele Takes, Lease-Ablauf, Transaktions-Abort).
- **Golomb-2025**: Verteilte kombinatorische Suche (DFS + Branch-and-Bound).

→ Siehe [Historische Referenzen](./examples/HISTORISCHE-REFERENZEN.md) für Details.

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
| Latenz (p99) | ms | ≤ 100 (Cache), ≤ 5000 (LLM), ≤ 600000 (Golomb n=15) | Zeit von Request bis Response |
| Verfügbarkeit | % | ≥ 99,9% | (Up-Time / Gesamtzeit) * 100 |
| Datenverlust | % | 0% (sync), ≤ 0,1% (expand) | Vergleich mit Referenzdaten |
| Speicherverbrauch | MB/GB | ≤ Budget (z. B. 10GB pro Space) | `df -h`, Process Metrics |
| CPU-Auslastung | % | ≤ 80% | `htop`, Prometheus |

---

---

## 3. examples

### 3.1 Übersicht

| Beispiel | Zweck | Modus* | Historische Referenz | Komplexität | Dokument | Implementierung |
|----------|-------|-------|-----------------------|-------------|----------|------------------|
| **🔢 Master-Worker (Primzahlsieb)** | Lastverteilung, Fehlertoleranz | `expand` | Linda, JavaSpaces | ⭐⭐ | [sieve.md](./examples/sieve.md) | ⚠️ nur einfache Variante: `workers.ts` |
| **💾 Distributed Cache** | Konsistenz, Verfügbarkeit | `sync` (lww) | JavaSpaces | ⭐⭐⭐ | [cache.md](./examples/cache.md) | ❌ keine |
| **🌡️ IoT-Monitoring** | Echtzeit-Verarbeitung, Skalierbarkeit | `expand` + `sync` | Jini, GigaSpaces | ⭐⭐⭐ | [iot.md](./examples/iot.md) | ✅ `sensor-pipeline.ts` (abweichende Typen) |
| **🤖 LLM-Agenten (arXiv)** | LLM-Integration, komplexe Workflows | `expand` + `sync` + `local` | JavaSpaces (Compute Server) | ⭐⭐⭐⭐ | [arxiv.md](./examples/arxiv.md) | ✅ `arxiv-research.ts`, `dark-energy-research.ts`, `arxiv-tool.ts`, `chat.ts` |
| **📏 Golomb-Lineal** | Verteilte kombinatorische Suche (Backtracking) | `expand` | golomb-2025 (C, DFS) | ⭐⭐⭐⭐ | [golomb.md](./examples/golomb.md) | ✅ `golomb.ts` |

\* Die Modi `expand`/`sync` sind Federation-Modi und beschreiben das Zielbild. Die heutigen
Implementierungen laufen alle lokal auf einem Host (`local`); Federation existiert noch nicht
(siehe [federation-plan-v3.md](../federation-plan-v3.md), Stufe 2–3).

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
- **Space-Typen (Spezifikation)**: `SensorReading`, `AggregatedData`, `Alert`, `DashboardData`.
  Die implementierte Variante `sensor-pipeline.ts` verwendet stattdessen `Window`, `Reading`, `Done`,
  `Summary`, `Report` (Alert/Dashboard sind dort nicht umgesetzt). Details: [iot.md](./examples/iot.md).
- **Testfokus**: Echtzeit-Latenz, Skalierbarkeit, Fehlertoleranz, Alert-Korrektheit.
- **Historisch**: Entspricht Jinis **Processing Unit-Pipelines** und GigaSpaces' **Mandelbrot-Rendering**.

#### 🤖 LLM-Agenten (arXiv)
- **Anwendungsfall**: Automatisierte Auswertung von arXiv-Papern zu Dunkler Energie/Dunkler Materie.
- **Pattern**: Pipeline (Crawl → Classify → Summarize → Analyze → Present → Chat).
- **Agenten**: Crawler, Classifier, Summarizer, Analysis, Presenter, Chat, Monitor.
- **Space-Typen**: `PaperMetadata`, `ClassifiedPaper`, `PaperSummary`, `AnalysisResult`, `Presentation`, `UserQuery`, `QueryResponse`.
- **Testfokus**: Vollständigkeit, Klassifikationsgenauigkeit, Performance, Fehlertoleranz.
- **Historisch**: Entspricht JavaSpaces' **Generischem Compute Server** und **Messenger/Chat**.

#### 🤖 Dunkle Energie-Forschung
- **Anwendungsfall**: **Automatisierte Auswertung von arXiv-Papern** zum Thema **Dunkle Energie/Dunkle Materie** mit erweiterter Pipeline.
- **Pattern**: **Erweiterte Pipeline** (Crawl → Classify → Summarize → Analyze → Present) + **Chat** + **Monitor**
- **Agenten**: Crawler, Classifier, Summarizer, Analyst, Presenter, Chat, Monitor.
- **Space-Typen**: `PaperMetadata`, `ClassifiedPaper`, `PaperSummary`, `AnalysisResult`, `UserQuery`, `QueryResponse`, `SystemStatus`, plus Task-Typen.
- **Testfokus**: Vollständigkeit, Klassifikationsgenauigkeit, Zusammenfassungsqualität, Performance, Fehlertoleranz, Monitoring.
- **Historisch**: Entspricht **JavaSpaces (Generischer Compute Server + Messenger/Chat)** und **Jini (Processing Pipelines)**.
- **Besonderheit**: **Vollständige LLM-Integration** mit statistischen Analysen (Netzwerke, Cluster, Zeitreihen) + interaktiver Chat.
- **Implementierung**: [`examples/dark-energy-research.ts`](../examples/dark-energy-research.ts)

#### 📏 Golomb-Lineal
- **Anwendungsfall**: Verteilte Suche nach **optimalen Golomb-Linealen** (kombinatorisches Suchproblem).
- **Pattern**: Master-Worker mit **Branch-and-Bound DFS** und Checkpointing.
- **Agenten**: Master (erstellt Suchaufträge), Worker (DFS-Suche), Validator, Monitor.
- **Space-Typen**: `GolombSearchTask`, `GolombRuler`, `GolombBestKnown`, `GolombSearchProgress`, `GolombSummary`.
- **Testfokus**: Korrektheit, Optimalität, Fehlertoleranz, Checkpointing, Performance.
- **Historisch**: Entspricht der **C-Implementierung golomb-2025** (DFS + OpenMP + SIMD).
- **Besonderheit**: Echtes **NP-schwaches Problem** mit praktischer Relevanz (Astronomie, Kryptographie).

---

---

## 4. Historische Referenzen

**Vollständige Dokumentation**: [HISTORISCHE-REFERENZEN.md](./examples/HISTORISCHE-REFERENZEN.md)

### 4.1 Übersicht
| System | Jahr | Kernkonzept | Relevanz für pi-spaces |
|--------|------|--------------|-----------------------------|
| **Linda** | 1989 | Tuple Space | Grundlage für alle Tuple-Space-Systeme |
| **JavaSpaces** | 1999 | Java-Implementierung von Tuple Spaces | Inspiriert Space-Typen und Operationen |
| **Jini** | 1999 | Service-Oriented Architecture | Inspiriert Federation und Control Space |
| **GigaSpaces** | 2000er | In-Memory Computing | Inspiriert Performance-Optimierungen |
| **Outrigger/Blitz** | 2000er | Test-Frameworks | Inspiriert Teststrategie |
| **golomb-2025** | 2025 | Verteilte kombinatorische Suche | Inspiriert Golomb-Lineal-Beispiel |

### 4.2 Abbildung auf pi-spaces
| Historisches Konzept | pi-spaces-Äquivalent | Status |
|------------------------|------------------------|---------------------|
| Linda `out(t)` | `write(entry)` | ✅ implementiert |
| Linda `in(t)` | `take(template)` | ✅ implementiert |
| Linda `rd(t)` | `read(template)` | ✅ implementiert |
| JavaSpaces `Entry` | `EntryDraft` `{type, fields}` | ✅ implementiert |
| JavaSpaces `Template` | `Template` `{type?, fields?, id?}` | ✅ implementiert |
| JavaSpaces `notify()` | `space_notify` / `space_wait` (Conversation-Events) | ✅ implementiert |
| JavaSpaces `Transaction` | `space_txn` (begin/commit/abort) | ✅ implementiert |
| JavaSpaces `Lease` | `Lease` (`ttlMs`, `forever`) | ✅ implementiert |
| Jini Lookup Service | Control Space + Capability | ❌ geplant (v3, Stufe 1b–2) |
| GigaSpaces Processing Units | FederatedSpace + Router | ❌ geplant (v3, Stufe 2) |
| golomb-2025 DFS | Branch-and-Bound in Worker | ✅ `golomb.ts` |

> Hinweis zur Schreibweise: Einträge werden stets als `{type, fields: {...}}` geschrieben und gelesen.
> Die `interface`-Deklarationen in den Spezifikationen beschreiben nur den Inhalt von `fields` plus den
> Typnamen — sie sind **kein** wörtlich schreibbares Entry-Objekt.

---

---

## 5. Teststrategie und Tools

### 5.1 Testkategorien und Tools
| Kategorie | Tools | Beispiele |
|-----------|-------|-----------|
| **Korrektheit** | Jepsen, Hypothesis | Linearizability-Tests (Cache), Konsistenz-Tests (alle) |
| **Konsistenz** | Jepsen, custom Checks | lww-Konfliktlösung (Cache), Transaktionen (Master-Worker, Golomb) |
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
| Golomb-Lineal | Ordnung 8–20 (bekannte Lösungen), 21+ (Forschung) |

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

| Beispiel | Dokument | Ziel-Modus | Historische Referenz | Komplexität | Hauptfokus | Implementiert |
|----------|----------|-------|-----------------------|-------------|------------|----------------|
| Master-Worker (Primzahlsieb) | [sieve.md](./examples/sieve.md) | `expand` | Linda, JavaSpaces | ⭐⭐ | Lastverteilung, Fehlertoleranz | ⚠️ nur `workers.ts` |
| Distributed Cache | [cache.md](./examples/cache.md) | `sync` (lww) | JavaSpaces | ⭐⭐⭐ | Konsistenz, Verfügbarkeit | ❌ |
| IoT-Monitoring | [iot.md](./examples/iot.md) | `expand` + `sync` | Jini, GigaSpaces | ⭐⭐⭐ | Echtzeit, Skalierbarkeit | ✅ `sensor-pipeline.ts` |
| LLM-Agenten (arXiv) | [arxiv.md](./examples/arxiv.md) | `expand` + `sync` + `local` | JavaSpaces, Jini | ⭐⭐⭐⭐ | LLM-Integration, Workflows | ✅ `arxiv-research.ts` |
| Dunkle Energie-Forschung | [arxiv.md](./examples/arxiv.md) | `expand` + `sync` + `local` | JavaSpaces, Jini | ⭐⭐⭐⭐⭐ | LLM + Statistische Analysen | ✅ `dark-energy-research.ts` |
| Golomb-Lineal | [golomb.md](./examples/golomb.md) | `expand` | golomb-2025 (C) | ⭐⭐⭐⭐ | Verteilte Suche, Backtracking | ✅ `golomb.ts` |

---

### 📝 Dokumentenhistorie

| Version | Datum | Autor | Änderungen |
|---------|-------|-------|-----------|
| 1.0 | 2026-10-06 | Mistral Vibe | Erste Version: 5 examples + historische Referenzen |

---

### 🔗 Verweise
- [federation-plan-v3.md](../federation-plan-v3.md) – Hauptdokument mit Architektur und Lösungen.
- [spaces-v1.md](../spaces-v1.md) – Basis-Implementierung der Spaces.
- [examples.md](../examples.md) – Dokumentation der tatsächlich implementierten Beispiele.
- [golomb-2025 GitHub](https://github.com/lux/golomb-2025) – Referenzimplementierung für Golomb-Lineal.

---

**Ende des Dokuments**
