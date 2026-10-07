# Anhang A: Historische Referenzen

**Version:** 1.0  
**Datum:** 2026-10-06  
**Status:** Entwurf  
**Zweck:** Dokumentation der historischen Tuple-Space-Systeme und deren Beziehung zu pi-spaces.  
**Referenz:** Ergänzt TESTBESPIELE.md.

---

## 📋 Inhaltsverzeichnis

1. [Einleitung](#1-einleitung)
2. [Linda (Carriero & Gelernter, 1989–1990)](#2-linda-carriero--gelernter-19891990)
3. [JavaSpaces Principles, Patterns, and Practice (Freeman et al., 1999)](#3-javaspaces-principles-patterns-and-practice-freeman-et-al-1999)
4. [Jini/GigaSpaces](#4-jinigigaspaces)
5. [Outrigger (Jini/Apache River) und Blitz](#5-outrigger-jiniapache-river-und-blitz)
6. [Zusammenfassung: Abbildung auf pi-spaces](#6-zusammenfassung-abbildung-auf-pi-spaces)

---

---

## 1. Einführung

Dieses Dokument beschreibt die **historischen Tuple-Space-Systeme**, auf denen die Testbeispiele basieren:
- **Linda** (1989): Ursprung des Tuple-Space-Konzepts.
- **JavaSpaces** (1999): Java-Implementierung von Tuple Spaces.
- **Jini/GigaSpaces** (1999–2000er): Service-Oriented Architecture und In-Memory Computing.
- **Outrigger/Blitz**: Test-Frameworks für Tuple-Space-Systeme.

Die Testbeispiele in diesem Projekt sind **moderne Adaptionen** dieser klassischen Patterns für pi-spaces.

---

---

## 2. Linda (Carriero & Gelernter, 1989–1990)

**Paper**: ["How to Write Parallel Programs – A Guide to the Perplexed"](https://dl.acm.org/doi/10.1145/65566.65570) (1990)  
**Implementierungen**: C-Linda, Fortran-Linda, JavaSpaces (inspiriert von Linda).  
**Kernkonzept**: **Tuple Space** als **koordinationsbasiertes Modell** für parallele Programmierung.

---

### 2.1 Prinzipien

Linda definiert ein **einfaches, aber mächtiges Modell** für verteilte und parallele Programmierung:

| **Konzept** | **Beschreibung** | **pi-spaces-Äquivalent** |
|-------------|----------------|------------------------|
| **Tuple Space** | Assoziativer Speicher (keine Adressen, nur Inhalte). | **Space** (typisierte Entries) |
| **Tuple** | Datenstruktur aus Feldern (anonym). | **Entry** (typisiert mit `type`-Feld) |
| **`out(t)`** | Schreibt Tuple `t` in den Space. | `write(entry)` |
| **`in(t)`** | Nimmt Tuple `t` aus dem Space (**blockierend**). | `take(template)` |
| **`rd(t)`** | Liest Tuple `t` (**nicht-destruktiv**). | `read(template)` |
| **`eval(t)`** | Führt Code in `t` aus und schreibt Ergebnis in den Space. | `write(entry)` mit **Agent-Code** |
| **Pattern Matching** | Tupel werden über **Templates** gesucht (z. B. `in("Task", ?id, ?data)`). | **Template-Matching** (z. B. `{type: "Task", status: "pending"}`) |

---

### 2.2 Klassische Beispiele

| **Beispiel** | **Beschreibung** | **Relevanz für pi-spaces** | **Testbeispiel** |
|--------------|----------------|-----------------------------|------------------|
| **Primzahlsieb** | Master teilt Zahlenbereich in Blöcke auf. Workers berechnen Primzahlen in jedem Block mit **Sieve of Eratosthenes**. | **Master-Worker-Pattern** mit Lastverteilung | [Master-Worker (Primzahlsieb)](../sieve.md) |
| **Matrixmultiplikation** | Matrix wird in **Zeilen/Spaltenblöcke** aufgeteilt. Jeder Worker berechnet Teilprodukte. Ergebnisse werden im Space aggregiert. | **Datenparallelismus** mit Reduktion | Ähnlich wie Master-Worker |
| **Dining Philosophers** | Philosophen (Prozesse) nehmen **Gabeln** (Tupel) aus dem Space. Problem: Deadlocks vermeiden. | **Resourcen-Allokation** mit Sperren | Inspiriert `take`-Wettläufe |
| **Master/Worker mit Task Bag** | Master schreibt alle Tasks in einen **Task-Bag** (Queue). Workers nehmen Tasks aus dem Bag. | **Queue-basiertes Workflow** | Inspiriert `expand`-Modus |

---

### 2.3 Code-Beispiele (Pseudocode)

#### Primzahlsieb in Linda
```c
// Master
for (int i = 0; i < N; i++) {
  out("Task", i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
}

// Worker
int start, end;
in("Task", ?start, ?end);
int* primes = sieve(start, end);
out("Result", start, primes);

// Collector
int start;
int* primes;
in("Result", ?start, ?primes);
// Aggregiere primes
```

#### Matrixmultiplikation in Linda
```c
// Master: Teile Matrix A und B in Blöcke auf
for (int i = 0; i < rows; i++) {
  for (int j = 0; j < cols; j++) {
    out("Block", i, j, A_block, B_block);
  }
}

// Worker: Berechne Teilprodukt
int i, j;
Matrix A_block, B_block;
in("Block", ?i, ?j, ?A_block, ?B_block);
Matrix C_block = multiply(A_block, B_block);
out("Result", i, j, C_block);
```

---

### 2.4 Unterschiede zu pi-spaces

| **Linda** | **pi-spaces** | **Begründung** |
|-----------|---------------|---------------|
| Tupel (anonym, untypisiert) | **`Entry` (typisiert mit `type`-Feld)** | Typisierung für bessere Struktur und Validierung |
| `in(t)` blockiert bis Match | `take(template)` mit **Lease** | Leases für Fehlertoleranz |
| Keine Transaktionen | **Transaktionen (`txn`)** | Atomare Operationen über mehrere Entries |
| Keine Leases | **Leases für Einträge** | Automatisches Löschen abgelaufener Einträge |
| Keine Replikation | **`expand`/`sync`-Modi** | Skalierbarkeit und Fehlertoleranz |
| Keine Sicherheit | **NetBird + Ed25519-Challenge** | Sichere Authentifizierung und Autorisierung |
| Keine Federation | **Federation mit Policy** | Verteilte Spaces über mehrere Hosts |

---

---

## 3. JavaSpaces Principles, Patterns, and Practice (Freeman et al., 1999)

**Buch**: [JavaSpaces: Principles, Patterns, and Practice](https://www.amazon.com/JavaSpaces-Principles-Patterns-Practice-Addison-Wesley/dp/0201309752)  
**Kontext**: **JavaSpaces** als **Java-Implementierung** von Tuple Spaces (Teil von **Jini**).

---

### 3.1 Kernkonzepte

JavaSpaces erweitert das Linda-Modell um **objektorientierte und verteilte Features**:

| **Konzept** | **Beschreibung** | **pi-spaces-Äquivalent** |
|-------------|----------------|------------------------|
| **Entry** | **Objekte** im Space (Java-Klassen). | **`Entry` (TypeScript-Objekte)** |
| **Template Matching** | **Feldweise Übereinstimmung** (z. B. `template.id = "123"`). | **`Template` (TypeScript-Objekte mit Feldfilter)** |
| **`write(entry)`** | Schreibt Entry in den Space. | `write(entry)` |
| **`take(template)`** | Nimmt Entry aus dem Space (**blockierend**). | `take(template)` |
| **`read(template)`** | Liest Entry (**nicht-destruktiv**). | `read(template)` |
| **`notify(template, listener)`** | Benachrichtigung bei neuen passenden Entries. | **`wait()` + `Mailbox`** (Long-Poll) |
| **Transaktionen** | Atomare Operationen über mehrere Entries. | **`txn`** |
| **Leases** | Zeitlich begrenzte Einträge (automatisches Löschen). | **`Lease`** |
| **Remote Events** | Events bei Änderungen im Space. | **`Mailbox` + `events`** |

---

### 3.2 Klassische Beispiele

| **Beispiel** | **Beschreibung** | **Relevanz für pi-spaces** | **Testbeispiel** |
|--------------|----------------|-----------------------------|------------------|
| **Hello World** | Einfaches Schreiben und Lesen von Messages. | **Grundlegende Kommunikation** | Alle Testbeispiele |
| **Geteilte Variablen** | Mehrere Prozesse inkrementieren einen **gemeinsamen Zähler**. | **Synchronisation mit Transaktionen** | [Distributed Cache](../cache.md) |
| **Verteilte Arrays** | Array wird in Einträge aufgeteilt. **Index-Entries** verwalten die Grenzen. | **Datenstruktur-Emulation** | Inspiriert komplexe Typen |
| **Kanäle/Queues** | **FIFO-Queue** mit **Head-/Tail-Index-Entries**. `enqueue`: Write Entry + Update Tail. `dequeue`: Take Head-Entry + Update Head. | **Message Queue** | Inspiriert `expand`-Modus |
| **Messenger/Chat** | Chat-Nachrichten als Entries. Jeder Client schreibt Nachrichten und liest neue (mit `notify`). | **Publish-Subscribe** | Inspiriert **Chat-Agent** in [LLM-Szenario](../arxiv.md) |
| **Generischer Compute Server** | Master schreibt **Task-Entries** mit Code und Daten. Workers führen Code aus und schreiben **Result-Entries**. | **Master-Worker** | [Master-Worker (Primzahlsieb)](../sieve.md) |
| **Brute-Force-Kryptoanalyse** | Master schreibt Tasks mit **Passwort-Hashes**. Workers testen Kombinationen. | **Embarrassingly Parallel** | Ähnlich wie Master-Worker |

---

### 3.3 Code-Beispiele (Java)

#### Geteilter Zähler
```java
// Entry
public class Counter implements Entry {
    public Integer value;
    public Counter() {}
    public Counter(Integer value) { this.value = value; }
}

// Template
Counter template = new Counter();

// Inkrementieren (mit Transaktion)
TransactionManager mgr = new TransactionManager();
try {
    mgr.begin();
    Counter counter = (Counter) space.take(template, null, Long.MAX_VALUE);
    space.write(new Counter(counter.value + 1), null, Lease.FOREVER);
    mgr.commit();
} catch (Exception e) {
    mgr.abort();
}
```

#### FIFO-Queue
```java
// Queue-Entry
public class QueueEntry implements Entry {
    public String id;
    public Object value;
    public QueueEntry() {}
    public QueueEntry(String id, Object value) {
        this.id = id;
        this.value = value;
    }
}

// Head- und Tail-Index
public class HeadIndex implements Entry {
    public String queueId;
    public String headId;
}

public class TailIndex implements Entry {
    public String queueId;
    public String tailId;
}

// Enqueue
QueueEntry entry = new QueueEntry(uuid(), value);
space.write(entry, null, Lease.FOREVER);
TailIndex tailTemplate = new TailIndex();
tailTemplate.queueId = "myQueue";
TailIndex tail = (TailIndex) space.take(tailTemplate, null, Long.MAX_VALUE);
space.write(new TailIndex("myQueue", entry.id), null, Lease.FOREVER);
if (tail == null) {
    // Erste Entry
    space.write(new HeadIndex("myQueue", entry.id), null, Lease.FOREVER);
}

// Dequeue
HeadIndex headTemplate = new HeadIndex();
headTemplate.queueId = "myQueue";
HeadIndex head = (HeadIndex) space.take(headTemplate, null, Long.MAX_VALUE);
QueueEntry entryTemplate = new QueueEntry();
entryTemplate.id = head.headId;
QueueEntry entry = (QueueEntry) space.take(entryTemplate, null, Long.MAX_VALUE);
// Update Head
QueueEntry nextEntry = (QueueEntry) space.read(new QueueEntry());
nextEntry.id = entry.id + 1; // Nächste Entry
space.write(new HeadIndex("myQueue", nextEntry.id), null, Lease.FOREVER);
```

---

### 3.4 Unterschiede zu pi-spaces

| **JavaSpaces** | **pi-spaces** | **Begründung** |
|----------------|---------------|---------------|
| `Entry` (Java-Objekte) | **`Entry` (JSON/TypeScript)** | Sprachunabhängigkeit |
| `Template` (Java-Objekte) | **`Template` (TypeScript-Objekte)** | Sprachunabhängigkeit |
| `write(entry)` | `write(entry)` | ✅ Gleich |
| `take(template)` | `take(template)` | ✅ Gleich |
| `read(template)` | `read(template)` | ✅ Gleich |
| `notify(template, listener)` | **`wait()` + `Mailbox`** | Long-Poll statt Callbacks |
| **Keine verteilten Modi** | **`expand`/`sync`-Modi** | Skalierbarkeit |
| **Keine Federation** | **Federation mit Policy** | Verteilte Spaces |
| **Java-spezifisch** | **Sprachunabhängig** | Flexibilität |

---

---

## 4. Jini/GigaSpaces

**Kontext**: **Jini** als **Service-Oriented Architecture (SOA)** für verteilte Systeme. **GigaSpaces** als **In-Memory-Computing**-Plattform.

---

### 4.1 Jini-Kernkonzepte

Jini ist ein **Framework für verteilte Systeme** in Java:

| **Konzept** | **Beschreibung** | **pi-spaces-Äquivalent** |
|-------------|----------------|------------------------|
| **Service Discovery** | **Jini Lookup Service**: Dienstverzeichnis, in dem Services registriert und gefunden werden. | **Control Space + Capability** |
| **Leasing** | **Zeitlich begrenzte Dienstnutzung** (wie Space-Leases). | **`Lease`** |
| **Distributed Events** | **Benachrichtigungen** bei Änderungen in Services. | **`Mailbox` + `events`** |
| **Java RMI** | **Remote Method Invocation** für verteilte Objekte. | **NetBird + space-gate** |
| **Transactions** | **Verteilte Transaktionen** über mehrere Services. | **`txn`** |

---

### 4.2 GigaSpaces-Kernkonzepte

GigaSpaces ist eine **In-Memory-Computing-Plattform**, die auf Jini aufbaut:

| **Konzept** | **Beschreibung** | **pi-spaces-Äquivalent** |
|-------------|----------------|------------------------|
| **In-Memory Computing** | **Hohe Performance** durch In-Memory-Datenhaltung. | **Plugable Storage (SQLite, etc.)** |
| **Processing Units** | **Verteilte Verarbeitung** (ähnlich `expand`-Modus). | **FederatedSpace + Router** |
| **Space-Based Architecture** | **Tuple Space als Kernkonzept**. | **Space + Federation** |
| **Data Grid** | **Verteilte Datenhaltung** über mehrere Knoten. | **Federation mit `expand`-Modus** |

---

### 4.3 Klassische Beispiele

| **Beispiel** | **Beschreibung** | **Relevanz für pi-spaces** | **Testbeispiel** |
|--------------|----------------|-----------------------------|------------------|
| **π-Berechnung (Monte Carlo)** | Master teilt Berechnung in **Teilbereiche** auf. Workers berechnen Teilbereiche mit **Monte-Carlo-Methode**. Ergebnisse werden aggregiert. | **Map-Reduce** | Inspiriert [Master-Worker](../sieve.md) |
| **Mandelbrot-Rendering** | Master teilt Bild in **Pixel-Blöcke** auf. Workers berechnen Farbwerte für Blöcke. Ergebnisse werden zu einem Bild zusammengesetzt. | **Datenparallelismus** | Inspiriert [IoT-Monitoring](../iot.md) (Aggregation) |
| **Order-Matching** | **Buy- und Sell-Orders** als Entries im Space. Matching-Engine nimmt passende Orders (Buy <= Sell) und führt Transaktionen aus. | **Marketplace-Pattern** | Inspiriert komplexe Transaktionen |
| **Processing Unit-Pipelines** | Daten fließen durch **mehrere Verarbeitungsstufen** (Filter → Transformation → Aggregation). Jede Stufe ist ein separater Service. | **Pipeline-Pattern** | Inspiriert [LLM-Szenario](../arxiv.md) |

---

### 4.4 Code-Beispiele (Java/Pseudocode)

#### π-Berechnung (Monte Carlo)
```java
// Master: Teile Berechnung in Blöcke auf
for (int i = 0; i < numBlocks; i++) {
    PiTask task = new PiTask(i * blockSize, (i + 1) * blockSize);
    space.write(task, null, Lease.FOREVER);
}

// Worker: Berechne Teilbereich
PiTask taskTemplate = new PiTask();
PiTask task = (PiTask) space.take(taskTemplate, null, Long.MAX_VALUE);
int hits = 0;
for (int i = task.start; i < task.end; i++) {
    double x = Math.random();
    double y = Math.random();
    if (x * x + y * y <= 1) hits++;
}
PiResult result = new PiResult(task.id, hits, task.end - task.start);
space.write(result, null, Lease.FOREVER);

// Collector: Aggregiere Ergebnisse
PiResult resultTemplate = new PiResult();
List<PiResult> results = space.readAll(resultTemplate);
int totalHits = results.stream().mapToInt(r -> r.hits).sum();
int totalSamples = results.stream().mapToInt(r -> r.samples).sum();
double pi = 4.0 * totalHits / totalSamples;
```

#### Processing Unit-Pipeline
```java
// Stufe 1: Filter
public class FilterPU implements ProcessingUnit {
    public void process(Entry entry) {
        if (entry.value > threshold) {
            space.write(new FilteredData(entry.id, entry.value));
        }
    }
}

// Stufe 2: Transformation
public class TransformPU implements ProcessingUnit {
    public void process(FilteredData data) {
        double transformed = Math.log(data.value);
        space.write(new TransformedData(data.id, transformed));
    }
}

// Stufe 3: Aggregation
public class AggregatePU implements ProcessingUnit {
    public void process(TransformedData data) {
        // Aggregiere Daten
        space.write(new AggregatedResult(data.id, avg, max, min));
    }
}
```

---

### 4.5 Unterschiede zu pi-spaces

| **Jini/GigaSpaces** | **pi-spaces** | **Begründung** |
|----------------------|---------------|---------------|
| Java-basiert | **Sprachunabhängig (JSON/CBOR)** | Flexibilität |
| Jini Lookup Service | **Control Space + Capability** | Vereinfachte Architektur |
| Java RMI | **NetBird + space-gate** | Netzwerk-Abstraktion |
| Processing Units | **FederatedSpace + Router** | Vereinfachte Architektur |
| In-Memory | **Plugable Storage (SQLite, etc.)** | Persistenz |
| Service-Oriented | **Space-Oriented** | Fokus auf Daten statt Services |

---

---

## 5. Outrigger (Jini/Apache River) und Blitz

**Kontext**: **Test-Frameworks** für JavaSpaces/Jini.

---

### 5.1 Outrigger

- **Zweck**: **Referenzimplementierung** von JavaSpaces.
- **Features**:
  - Vollständige Implementierung der JavaSpaces-Spezifikation.
  - **Transaktionen**.
  - **Leases**.
  - **Remote Events**.
- **Tests**: **Konformitätstests** (Prüfung der Spezifikationskonformität).

---

### 5.2 Blitz

- **Zweck**: **Stress-Tests** für JavaSpaces.
- **Tests**:

| **Testfall** | **Beschreibung** | **Relevanz für pi-spaces** | **Testbeispiel** |
|--------------|----------------|-----------------------------|------------------|
| **Parallele Takes** | Viele Clients versuchen **gleichzeitig**, denselben Entry zu nehmen. | **Wettlauf bei `take`** | [Master-Worker](../sieve.md) (T1.4), [Distributed Cache](../cache.md) (T2.4) |
| **Lease-Ablauf** | Testet, ob **abgelaufene Leases** korrekt gelöscht werden. | **Lease-Management** | [Distributed Cache](../cache.md) (T2.9), [IoT-Monitoring](../iot.md) (T3.8) |
| **Transaktions-Abort** | Testet **Rollback-Verhalten** bei Abort. | **Transaktionssicherheit** | [Master-Worker](../sieve.md) (T1.7) |
| **Partitionierung** | Testet Verhalten bei **Netzwerkpartitionen** (Split-Brain). | **Fehlertoleranz** | [Master-Worker](../sieve.md) (T1.6), [LLM-Szenario](../arxiv.md) (T4.8) |
| **Skalierbarkeit** | Testet Performance bei **hoher Last** (10.000+ Clients). | **Skalierbarkeit** | Alle Beispiele |

---

### 5.3 Code-Beispiel: Stress-Test mit Blitz

```java
// 1000 Clients versuchen, denselben Entry zu nehmen
for (int i = 0; i < 1000; i++) {
    new Thread(() -> {
        try {
            Entry template = new Entry();
            template.id = "shared";
            Entry entry = space.take(template, null, 5000); // Timeout: 5s
            if (entry != null) {
                System.out.println("Client " + Thread.currentThread().getId() + " hat Entry genommen");
                space.write(entry, null, Lease.FOREVER); // Zurückschreiben
            }
        } catch (Exception e) {
            System.err.println("Client " + Thread.currentThread().getId() + " fehlgeschlagen");
        }
    }).start();
}
```

---

---

## 6. Zusammenfassung: Abbildung auf pi-spaces

Die folgende Tabelle zeigt, wie die **Kernkonzepte der historischen Systeme** auf pi-spaces abgebildet werden:

| **Historisches System** | **Konzept** | **pi-spaces-Äquivalent** | **Implementiert in** |
|------------------------|------------|------------------------|---------------------|
| **Linda** | `out(t)` | `write(entry)` | ✅ Alle Beispiele |
| **Linda** | `in(t)` | `take(template)` | ✅ Alle Beispiele |
| **Linda** | `rd(t)` | `read(template)` | ✅ Alle Beispiele |
| **Linda** | `eval(t)` | `write(entry)` mit **Agent-Code** | ✅ LLM-Szenario |
| **Linda** | Pattern Matching | **Template-Matching** | ✅ Alle Beispiele |
| **JavaSpaces** | `Entry` | **`Entry` (typisiert)** | ✅ Alle Beispiele |
| **JavaSpaces** | `Template` | **`Template` (TypeScript)** | ✅ Alle Beispiele |
| **JavaSpaces** | `notify()` | **`wait()` + `Mailbox`** | ✅ Alle Beispiele |
| **JavaSpaces** | `Transaction` | **`txn`** | ✅ Master-Worker, Distributed Cache |
| **JavaSpaces** | `Lease` | **`Lease`** | ✅ Alle Beispiele |
| **Jini** | Lookup Service | **Control Space + Capability** | ✅ LLM-Szenario |
| **Jini** | Leasing | **`Lease`** | ✅ Alle Beispiele |
| **Jini** | Distributed Events | **`Mailbox` + `events`** | ✅ Alle Beispiele |
| **GigaSpaces** | Processing Units | **FederatedSpace + Router** | ✅ Alle Beispiele |
| **GigaSpaces** | In-Memory Computing | **Plugable Storage (SQLite, etc.)** | ✅ Alle Beispiele |
| **Outrigger/Blitz** | Stress-Tests | **Teststrategie (Abschnitt 12 in v3)** | ✅ Alle Beispiele |

---

### 6.1 Empfohlene Literatur

| **Titel** | **Autoren** | **Jahr** | **Link** | **Fokus** |
|-----------|------------|---------|--------|----------|
| How to Write Parallel Programs – A Guide to the Perplexed | Nicholas Carriero, David Gelernter | 1990 | [ACM DL](https://dl.acm.org/doi/10.1145/65566.65570) | Linda, Grundlagen |
| JavaSpaces: Principles, Patterns, and Practice | Eric Freeman, Susanne Hupfer, Ken Arnold | 1999 | [Amazon](https://www.amazon.com/JavaSpaces-Principles-Patterns-Practice-Addison-Wesley/dp/0201309752) | JavaSpaces, Patterns |
| The Jini Specification | Sun Microsystems | 1999 | [Oracle Docs](https://www.oracle.com/java/technologies/jini.html) | Jini |
| GigaSpaces Documentation | GigaSpaces Technologies | 2000er | [GigaSpaces](https://www.gigaspaces.com/) | In-Memory Computing |

---

---

**Ende des Dokuments** | [Zurück zu TESTBESPIELE.md](../TESTBESPIELE.md)
