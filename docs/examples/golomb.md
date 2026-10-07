# Beispiel 4: Golomb-Lineal – Verteilte kombinatorische Suche & Optimierung

**Version:** 1.0  
**Datum:** 2026-10-06  
**Status:** Vollständig  
**Zweck:** Demonstration von verteilter kombinatorischer Suche, Branch-and-Bound-Algorithmen, Checkpointing und verteilten Optimierungsproblemen.
**Mathematische Referenz:** [Golomb-Lineal auf Wikipedia](https://de.wikipedia.org/wiki/Golomb-Lineal)

---

## 📋 Inhaltsverzeichnis

1. [Mathematische Grundlagen](#1-mathematische-grundlagen)
2. [Anwendungsfall & Ziele](#2-anwendungsfall--ziele)
3. [Architektur-Übersicht](#3-architektur-übersicht)
4. [Space-Typen](#4-space-typen)
5. [Agenten](#5-agenten)
6. [Algorithmen](#6-algorithmen)
7. [Implementierung (`golomb.ts`)](#7-implementierung-golombtst)
8. [Branch-and-Bound Strategie](#8-branch-and-bound-strategie)
9. [BitSet-Optimierung](#9-bitset-optimierung)
10. [Checkpointing & Resume-Fähigkeit](#10-checkpointing--resume-fähigkeit)
11. [Performance & Skalierung](#11-performance--skalierung)
12. [Vergleich mit historischen Referenzen](#12-vergleich-mit-historischen-referenzen)
13. [Erweiterungsmöglichkeiten](#13-erweiterungsmöglichkeiten)

---

---

## 1. Mathematische Grundlagen

### 1.1 Definition: Golomb-Lineal

Ein **Golomb-Lineal** (auch **Golomb-Massstab** oder **Sidon-Folge**) ist eine Folge von ganzen Zahlen, bei der **alle paarweisen Differenzen eindeutig** sind.

**Formale Definition:**
Seien die Marken auf dem Lineal an den Positionen `a₁ < a₂ < ... < aₙ`. Dann müssen alle Differenzen `aⱼ - aᵢ` für `1 ≤ i < j ≤ n` **verschieden** sein.

### 1.2 Beispiele

| **Ordnung** | **Optimale Länge** | **Positionen** | **Differenzen** |
|-------------|--------------------|----------------|-----------------|
| 2 | 1 | [0, 1] | [1] |
| 3 | 3 | [0, 1, 3] | [1, 2, 3] |
| 4 | 6 | [0, 1, 4, 6] | [1, 2, 3, 4, 5, 6] |
| 5 | 11 | [0, 1, 4, 9, 11] | [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] |
| 6 | 17 | [0, 1, 4, 10, 12, 17] | [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] |

### 1.3 Optimale Längen (Bekannte Werte)

| n | Optimal Length | n | Optimal Length | n | Optimal Length |
|---|----------------|---|----------------|---|----------------|
| 2 | 1 | 10 | 55 | 18 | 232 |
| 3 | 3 | 11 | 77 | 19 | 272 |
| 4 | 6 | 12 | 91 | 20 | 307 |
| 5 | 11 | 13 | 110 | 21 | 351 |
| 6 | 17 | 14 | 136 | 22 | 400 |
| 7 | 23 | 15 | 155 | 23 | 457 |
| 8 | 34 | 16 | 182 | 24 | 521 |
| 9 | 42 | 17 | 204 | 25 | 594 |

### 1.4 Mathematische Eigenschaften

- **Untergrenze:** `L(n) ≥ n(n-1)/2` (minimale Länge)
- **Obergrenze:** `L(n) ≤ n(n-1)/2 + O(1)` (für optimale Lineale)
- **Asymptotik:** `L(n) ~ n²/2` für große n

---

## 2. Anwendungsfall & Ziele

### 2.1 Anwendungsfall

**Problem:** Finde ein Golomb-Lineal der Ordnung n mit **minimaler Länge**.

**Anwendung:**
- Kryptographie (Design von Hash-Funktionen mit Kollisionsfreiheit)
- Codierungstheorie (Fehlerkorrekturcodes)
- Optische Kommunikation (Multiplexing)
- Radioastronomie (Pulsar-Signalanalyse)

### 2.2 Ziele

| **Ziel** | **Metrik** | **Akzeptanzkriterium** | **Priorität** |
|-----------|------------|------------------------|---------------|
| Korrektheit | Gültigkeit der Lösung | Alle Differenzen sind eindeutig | ⭐⭐⭐ |
| Optimalität | Minimale Länge | Lösung entspricht bekannter optimaler Länge | ⭐⭐⭐ |
| Vollständigkeit | Alle Lösungen finden | Für n ≤ 10: alle optimalen Lösungen finden | ⭐⭐ |
| Performance | Suchgeschwindigkeit | Ordnung 12 in ≤ 1 Minute | ⭐⭐⭐ |
| Skalierbarkeit | Worker-Effizienz | Linearer Speedup mit Worker-Anzahl | ⭐⭐⭐ |
| Fehlertoleranz | Resume-Fähigkeit | Unterbrechung und Fortsetzung möglich | ⭐⭐⭐ |
| Speichereffizienz | Memory-Verbrauch | ≤ 2GB für Ordnung 15 | ⭐⭐ |

---

## 3. Architektur-Übersicht

```
┌─────────────────────────────────────────────────────────────────┐
│                        Golomb-Lineal Suche                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────┐    write     ┌─────────────┐    take     ┌─────────┐ │
│  │  Master  │────────────►│ GolombTasks  │───────────►│ Worker   │ │
│  └─────────┘              └─────────────┘            └─────────┘ │
│         ▲                                                   │       │
│         │                                                   │       │
│         │ write                                             │ write │
│         │                                                   ▼       │
│         │                          ┌─────────────────────┐        │
│         │                          │   GolombRuler        │        │
│         │                          │   (Lösungen)         │        │
│         │                          └─────────────────────┘        │
│         │                                                   │       │
│         │ read                                              │ read   │
│         │                                                   ▼       │
│         │                          ┌─────────────────────┐        │
│         │                          │ GolombBestKnown      │        │
│         │                          │ (beste Lösung)       │        │
│         │                          └─────────────────────┘        │
│         │                                                   │       │
│         │ read                                              │        │
│         │                                                   ▼       │
│         │                          ┌─────────────────────┐        │
│         └──────────────────────────────────►   GolombSummary    │        │
│                                                │ (Zusammenfassung) │        │
│                                                └─────────────────────┘        │
│                                                                     │       │
│  ┌─────────────┐                                           ┌────────────┐ │
│  │  Validator   │◄────────── read ──────────────────────────│ GolombRuler │ │
│  └─────────────┘                                           └────────────┘ │
│                                                                     │       │
│  ┌─────────────┐                                           ┌────────────┐ │
│  │   Monitor    │◄────────── read ──────────────────────────│ Progress    │ │
│  └─────────────┘                                           └────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 Datenfluss

1. **Master** teilt Suchraum in Teilaufgaben auf
2. **Worker** nehmen Aufgaben und führen DFS durch
3. **Worker** schreiben gefundene Lösungen in Space
4. **Validator** prüft alle Lösungen auf Gültigkeit
5. **Monitor** zeigt Fortschritt an
6. **Master** aggregiert Ergebnisse und bestimmt beste Lösung

---

## 4. Space-Typen

> Alle Einträge werden als `{type: "Name", fields: {...}}` geschrieben; die folgenden Interfaces
> beschreiben den Inhalt von `fields` plus den Typnamen. Da der Space kein Update kennt, wird ein
> Task beim `take` entfernt (pending) und der Worker meldet den Abschluss über einen separaten
> `GolombTaskDone`-Eintrag — es gibt keine `status: "processing"`-Kopie desselben Tasks im Space.

```typescript
// Suchaufgabe für Worker
interface GolombSearchTask {
  type: "GolombSearchTask";
  taskId: string;          // Eindeutige Aufgaben-ID
  order: number;           // Ordnung des gesuchten Lineals
  minLength: number;      // Minimale zu suchende Länge
  maxLength: number;      // Maximale zu suchende Länge
  startPos: number;        // Startposition für a₂ (zweite Marke)
  endPos: number;          // Endposition für a₂
  status: "pending";      // immer "pending"; der Task wird per take entnommen statt aktualisiert
  workerId?: string;      // Bearbeitender Worker
}
// (Die Lease gehört zum Write-Aufruf `ttlMs`, nicht in fields.)

// Gefundene Lösung
interface GolombRulerEntry {
  type: "GolombRuler";
  taskId?: string;        // Referenz auf die Aufgabe
  order: number;          // Ordnung des Lineals
  length: number;         // Gesamtlänge (letzte Position)
  positions: number[];    // Positionen der Marken [a₁, a₂, ..., aₙ]
  distances: number[];    // Alle paarweisen Differenzen (sortiert)
  missingDistances: number[]; // Fehlende Differenzen im Bereich
  isOptimal: boolean;     // true, wenn Länge = bekannter Optimalwert
  foundAt: Date;          // Zeitstempel der Entdeckung
  workerId?: string;      // Findender Worker
  durationMs?: number;    // Suchdauer in ms
}

// Beste bekannte Lösung (für Pruning)
interface GolombBestKnown {
  type: "GolombBestKnown";
  order: number;          // Ordnung
  length: number;         // Beste bekannte Länge
  positions: number[];    // Positionen
  source: string;         // Quelle ("LUT" = Lookup-Table, "Worker-X")
  updatedAt: Date;        // Zeitstempel der Aktualisierung
}

// Fortschrittsinformation (für Monitor)
interface GolombSearchProgress {
  type: "GolombSearchProgress";
  taskId: string;          // Aufgaben-ID
  order: number;          // Ordnung
  currentLength: number;  // Aktuelle Position in der Suche
  currentMarks: number[]; // Aktuelle Marken in der DFS
  checkedPositions: number; // Anzahl geprüfter Positionen
  lastUpdate: Date;       // Zeitstempel (ISO-String in fields)
  workerId: string;       // Worker-ID
}

// Zusammenfassung der Suche
interface GolombSummary {
  type: "GolombSummary";
  order: number;          // Ordnung
  totalRulers: number;    // Gesamtzahl gefundener Lösungen
  optimalRulers: number;  // Anzahl optimaler Lösungen
  shortestLength: number; // Kürzeste gefundene Länge
  bestRuler?: GolombRulerEntry; // Beste Lösung
  searchCompleted: boolean; // true, wenn alle Aufgaben erledigt
  startedAt: Date;        // Startzeitpunkt
  completedAt?: Date;    // Endzeitpunkt
}

// Abschluss-Marker pro Task (Worker schreibt ihn statt eines Status-Updates)
interface GolombTaskDone {
  type: "GolombTaskDone";
  taskId: string;
  workerId: string;
  rulersFound: number;
  checkedPositions: number;
}

// Abschluss-Marker der gesamten Suche (Master schreibt ihn; Worker/Monitor/Validator enden dann)
interface GolombSearchDone {
  type: "GolombSearchDone";
  order: number;
}
```

---

## 5. Agenten

### 5.1 Master

**Rolle:** Aufgabenverteilung und Ergebnisaggregation

**Verantwortlichkeiten:**
- Berechnung der Suchraumaufteilung
- Erstellung von `GolombSearchTask`-Entries
- Aggregation der Ergebnisse
- Bestimmung der besten Lösung
- Verwaltung von `GolombBestKnown` und `GolombSummary`

**Space-Operationen:**
- `write(GolombSearchTask)` – Aufgaben erstellen
- `readAll(GolombRuler)` – Lösungen sammeln
- `write(GolombBestKnown)` – Beste Lösung aktualisieren
- `write(GolombSummary)` – Fortschritt aktualisieren

### 5.2 Worker

**Rolle:** DFS-Suche nach Golomb-Linealen

**Verantwortlichkeiten:**
- Ausführung von Branch-and-Bound-DFS
- Duplikatsprüfung mit BitSet
- Checkpointing des Fortschritts
- Schreiben gefundener Lösungen

**Space-Operationen:**
- `take(GolombSearchTask)` – Aufgaben entnehmen
- `write(GolombRuler)` – Lösungen speichern
- `read(GolombBestKnown)` – Beste Lösung für Pruning abfragen
- `write(GolombSearchProgress)` – Fortschritt speichern

### 5.3 Validator

**Rolle:** Überprüfung der Gültigkeit aller Lösungen

**Verantwortlichkeiten:**
- Validierung der Eindeutigkeit aller Differenzen
- Entfernung ungültiger Lösungen (optional)
- Statistik über Fehlerraten

**Space-Operationen:**
- `readAll(GolombRuler)` – Alle Lösungen prüfen (zählt Invalides, entfernt nichts)
- Endet, sobald `GolombSearchDone` existiert

### 5.4 Monitor

**Rolle:** Echtzeit-Fortschrittsanzeige

**Verantwortlichkeiten:**
- Anzeige des aktuellen Suchfortschritts
- Statistik über gefundene Lösungen
- Warnungen bei Stagnation

**Space-Operationen:**
- `readAll(GolombSummary)` – Aktueller Stand
- `readAll(GolombSearchProgress)` – Worker-Fortschritt
- `readAll(GolombBestKnown)` – Beste Lösung

---

## 6. Algorithmen

### 6.1 Grundlegender DFS-Algorithmus

```typescript
function dfs(currentMarks: number[]): GolombRulerEntry[] {
  const n = currentMarks.length;
  const rulers: GolombRulerEntry[] = [];
  
  // Basisfall: alle Marken platziert
  if (n === order) {
    rulers.push(createRulerEntry(currentMarks));
    return rulers;
  }
  
  const lastMark = currentMarks[currentMarks.length - 1];
  
  // Versuche alle möglichen nächsten Positionen
  for (let nextPos = lastMark + 1; nextPos <= maxLength; nextPos++) {
    if (isValidPosition(currentMarks, nextPos)) {
      const newMarks = [...currentMarks, nextPos];
      rulers.push(...dfs(newMarks));
    }
  }
  
  return rulers;
}
```

### 6.2 Optimierter DFS mit Pruning

```typescript
function dfsOptimized(
  currentMarks: number[],
  currentLength: number,
  usedDistances: BitSet
): GolombRulerEntry[] {
  const rulers: GolombRulerEntry[] = [];
  const n = currentMarks.length;
  
  // Basisfall
  if (n === this.order) {
    return [createRulerEntry(currentMarks)];
  }
  
  // Pruning: aktuelle Länge >= beste bekannte Länge
  if (currentLength >= this.bestKnownLength) {
    return rulers; // Keine bessere Lösung möglich
  }
  
  const lastMark = currentMarks[currentMarks.length - 1];
  const a2 = currentMarks[1]; // erste Lücke

  // Symmetrie-Reduktion: erste Lücke ≤ letzte Lücke (das Spiegelbild des Lineals ist
  // dieselbe Lösung, einmal zählen reicht). Wirkt beim Platzieren der LETZTEN Marke;
  // a2 selbst ist über die Task-Aufteilung auf die untere Hälfte beschränkt.
  const isLastMark = n === this.order - 1;

  // nur Positionen, die die Länge unter der aktuellen Schranke halten
  for (let nextPos = lastMark + 1; nextPos < this.bestKnownLength; nextPos++) {
    if (isLastMark && nextPos - lastMark < a2) continue;

    // Pruning: prüfe ob nächste Position gültig ist
    let valid = true;
    for (let i = 0; i < currentMarks.length; i++) {
      const dist = nextPos - currentMarks[i];
      if (usedDistances.get(dist)) {
        valid = false;
        break;
      }
    }

    if (valid) {
      const newUsedDistances = usedDistances.clone();
      for (let i = 0; i < currentMarks.length; i++) {
        const dist = nextPos - currentMarks[i];
        newUsedDistances.set(dist);
      }

      const newMarks = [...currentMarks, nextPos];
      const found = dfsOptimized(newMarks, nextPos, newUsedDistances);
      rulers.push(...found);

      // Early termination bei optimaler Lösung
      if (found.some(r => r.isOptimal)) {
        break;
      }
    }
  }

  return rulers;
}
```

---

## 7. Implementierung (`golomb.ts`)

**Datei:** [`../../examples/golomb.ts`](../../examples/golomb.ts)

### 7.1 Hauptklassen

#### GolombRuler (Utility-Klasse)

```typescript
class GolombRuler {
  static isValid(positions: number[]): boolean {
    const distances = new BitSet(positions.length * positions.length);
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dist = positions[j] - positions[i];
        if (distances.get(dist)) {
          return false; // Duplikate Differenz
        }
        distances.set(dist);
      }
    }
    return true;
  }
  
  static getDistances(positions: number[]): number[] {
    const distances: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        distances.push(positions[j] - positions[i]);
      }
    }
    return distances.sort((a, b) => a - b);
  }
  
  static getMissingDistances(positions: number[], maxLength: number): number[] {
    const allDistances = this.getDistances(positions);
    const maxDist = positions[positions.length - 1];
    const missing: number[] = [];
    
    for (let d = 1; d <= maxDist; d++) {
      if (!allDistances.includes(d)) {
        missing.push(d);
      }
    }
    return missing;
  }
  
  static length(ruler: number[]): number {
    return ruler[ruler.length - 1];
  }
}
```

#### BitSet (Effiziente Datenstruktur)

```typescript
class BitSet {
  private data: Uint8Array;
  private size: number;
  
  constructor(size: number) {
    this.size = size;
    this.data = new Uint8Array(Math.ceil(size / 8));
  }
  
  set(bit: number): void {
    if (bit >= this.size) {
      // Auto-expand
      const newSize = Math.max(this.size * 2, bit + 1);
      const newData = new Uint8Array(Math.ceil(newSize / 8));
      newData.set(this.data);
      this.data = newData;
      this.size = newSize;
    }
    const byteIndex = Math.floor(bit / 8);
    const bitIndex = bit % 8;
    this.data[byteIndex] |= (1 << bitIndex);
  }
  
  get(bit: number): boolean {
    if (bit >= this.size) return false;
    const byteIndex = Math.floor(bit / 8);
    const bitIndex = bit % 8;
    return (this.data[byteIndex] & (1 << bitIndex)) !== 0;
  }
  
  clone(): BitSet {
    const newSet = new BitSet(this.size);
    newSet.data.set(this.data);
    return newSet;
  }
  
  static fromArray(bits: number[], size?: number): BitSet {
    const set = new BitSet(size || Math.max(...bits, 0) + 1);
    for (const bit of bits) {
      set.set(bit);
    }
    return set;
  }
}
```

### 7.2 GolombWorker (DFS-Sucher)

```typescript
class GolombWorker {
  private space: JavaSpace;
  private workerId: string;
  private order: number;
  private minLength: number;
  private maxLength: number;
  private bestKnownLength: number;
  private progressInterval: number;
  private cpPath?: string;
  
  constructor(/* ... */) {
    // Initialisierung
  }
  
  async run(task: GolombSearchTask): Promise<GolombRulerEntry[]> {
    // 1. Task-Status auf "processing" aktualisieren
    // 2. Für jeden a₂-Wert im Bereich [startPos, endPos):
    //    a. DFS mit Branch-and-Bound starten
    //    b. Gefundene Lösungen sammeln
    //    c. Periodisch Fortschritt speichern
    // 3. Task-Status auf "done" aktualisieren
    // 4. Gefundene Lösungen zurückgeben
  }
  
  private dfs(currentMarks: number[], currentLength: number, usedDistances: BitSet): GolombRulerEntry[] {
    // Implementierung wie in Abschnitt 6.2
  }
}
```

### 7.3 GolombMaster (Aufgabenverteiler)

```typescript
class GolombMaster {
  private space: JavaSpace;
  private order: number;
  private minLength: number;
  private maxLength: number;
  private numWorkers: number;
  
  async run(): Promise<GolombRulerEntry | null> {
    // 1. Bekannte optimale Lösung laden
    await this.loadKnownOptimal();
    
    // 2. Zusammenfassung erstellen
    await this.space.write(initialSummary);
    
    // 3. Suchraum in Aufgaben aufteilen
    const tasks = this.createTasks();
    for (const task of tasks) {
      await this.space.write(task);
    }
    
    // 4. Fortschritt überwachen
    while (true) {
      const done = await this.checkProgress();
      if (done) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    
    // 5. Endgültige Zusammenfassung schreiben
    await this.writeFinalSummary();
    
    return bestRuler;
  }
}
```

---

## 8. Branch-and-Bound Strategie

### 8.1 Pruning-Techniken

| **Technik** | **Beschreibung** | **Effekt** |
|-------------|----------------|------------|
| **Längen-Pruning** | Abbruch wenn aktuelle Länge ≥ beste bekannte Länge (aus `GolombBestKnown`, live aktualisiert) | Reduziert Suchbaum stark |
| **Symmetrie-Reduktion** | a₂ nur in unterer Hälfte (Task-Split) + erste Lücke ≤ letzte Lücke beim Platzieren der Endmarke | Halbiert den Suchraum |
| **Duplikats-Pruning** | Sofortiger Abbruch bei doppelten Differenzen | Eliminiert ungültige Pfade früh |
| **Early Termination** | Abbruch wenn optimale Lösung gefunden | Maximale Effizienz |

### 8.2 Suchraum-Reduktion

Für Ordnung n=12 (Größenordnungen, nicht gemessen):
- **Voller Suchraum:** C(91,12) ≈ 10¹¹ Teilmengen
- **Mit Pruning:** deutlich weniger tatsächlich geprüfte Knoten

### 8.3 Pseudocode: Branch-and-Bound

```
function branchAndBound(current, bestFound):
    if isComplete(current):
        if length(current) < length(bestFound):
            bestFound = current
        return bestFound
    
    if length(current) >= length(bestFound):
        return bestFound  // Prune
    
    for each possible next position:
        if not createsDuplicateDifferences(current, next):
            newCurrent = current + [next]
            bestFound = branchAndBound(newCurrent, bestFound)
            
            if isOptimal(bestFound):
                return bestFound  // Early termination
    
    return bestFound
```

---

## 9. BitSet-Optimierung

### 9.1 Warum BitSet?

**Problem:** Prüfen, ob eine Distanz bereits existiert.
- Naive Implementierung: Array mit O(n²) Operationen
- BitSet: O(1) Lookup und Set mit O(n²/8) Speicher

### 9.2 Speicherverbrauch

| **Ordnung** | **maxLength** | **BitSet-Größe (Bits)** | **Speicher (Bytes)** |
|-------------|----------------------|------------------|---------------------|
| 8 | 34 | 35 | 5 |
| 12 | 85 | 86 | 11 |
| 15 | 151 | 152 | 19 |
| 20 | 283 | 284 | 36 |
| 25 | 480 | 481 | 61 |

### 9.3 Performance-Vergleich

| **Operation** | **Array** | **Set** | **BitSet** |
|--------------|-----------|---------|-----------|
| `add(dist)` | O(n) | O(1) | O(1) |
| `has(dist)` | O(n) | O(1) | O(1) |
| `clone()` | O(n) | O(n) | O(n/8) |
| Speicher | O(n) | O(n) | O(n/8) |

### 9.4 Auto-Expand Feature

```typescript
set(bit: number): void {
  if (bit >= this.size) {
    // Dynamisch erweitern
    const newSize = Math.max(this.size * 2, bit + 1);
    const newData = new Uint8Array(Math.ceil(newSize / 8));
    newData.set(this.data);
    this.data = newData;
    this.size = newSize;
  }
  // ... normale Set-Logik
}
```

---

## 10. Checkpointing & Resume-Fähigkeit

### 10.1 Warum Checkpointing?

- Lange Suchläufe (z. B. n=20: Stunden bis Tage)
- Unterbrechungen durch:
  - System-Abstürze
  - Netzwerk-Probleme
  - Benutzer-Abbruch
- Fortsetzung ohne Verlust

### 10.2 Checkpoint-Format

```json
{
  "taskId": "golomb-12-task-0",
  "order": 12,
  "currentA2": 45,
  "currentMarks": [0, 1],
  "checkedCount": 150000,
  "savedAt": "2026-10-06T12:34:56.789Z"
}
```

### 10.3 Implementierung

```typescript
async saveProgress(
  taskId: string,
  currentA2: number,
  currentMarks: number[],
  checkedCount: number
): Promise<void> {
  const progress: GolombSearchProgress = {
    type: "GolombSearchProgress",
    taskId,
    order: this.order,
    currentLength: currentA2,
    currentMarks,
    checkedPositions: checkedCount,
    lastUpdate: new Date(),
    workerId: this.workerId
  };
  
  // In Space schreiben (mit TTL)
  await this.space.write(progress, null, 30 * 60 * 1000);
  
  // Optional: In Datei schreiben
  if (this.cpPath) {
    const cpData = { taskId, order: this.order, currentA2, currentMarks, checkedCount, savedAt: new Date().toISOString() };
    writeFileSync(this.cpPath, JSON.stringify(cpData, null, 2));
  }
}
```

### 10.4 Resume-Logik

Resume funktioniert auf zwei Ebenen:

1. **Aufgaben-Ebene über den Space selbst:** Da die Datenhaltung (`--dir`, JSONL) einen
   Prozessneustart überlebt, überspringt der Master beim Start Tasks, für die bereits ein
   `GolombTaskDone`-Eintrag existiert — sie müssen nicht neu erstellt werden.
2. **Innerhalb eines Tasks:** Ein Worker, der einen unterbrochenen Task übernimmt, liest die
   Checkpoint-Datei und beginnt bei `currentA2` statt am Anfang des Bereichs:

```typescript
resumeFromCheckpoint(cpPath: string): number | null {
  try {
    const cp = JSON.parse(readFileSync(cpPath, "utf8"));
    if (cp.taskId === this.currentTaskId && cp.order === this.order) {
      return cp.currentA2; // ab hier weitersuchen
    }
  } catch { /* kein oder fremder Checkpoint */ }
  return null;
}
```

---

## 11. Performance & Skalierung

> **Alle Zahlen in diesem Abschnitt sind Schätzungen aus der Referenz-Implementierung
> (golomb-2025, C mit OpenMP), keine Messungen der TypeScript-Variante.** Die Suche ist
> exponentiell; reale Laufzeiten können deutlich abweichen.

### 11.1 Performance-Metriken

| **Ordnung** | **Worker** | **Zeit (ca.)** | **Gefundene Lösungen** | **Optimale Lösungen** |
|-------------|------------|----------------|----------------------|------------------------|
| 8 | 1 | 1s | 10 | 1 |
| 9 | 1 | 5s | 50 | 1 |
| 10 | 1 | 30s | 200 | 1 |
| 11 | 1 | 2min | 1000 | 1 |
| 12 | 1 | 15min | 5000 | 1 |
| 12 | 4 | 4min | 5000 | 1 |
| 15 | 4 | 1h | 50000 | 1 |
| 20 | 8 | 12h | 100000+ | 1 |

### 11.2 Skalierung mit Workern

| **Worker** | **Ordnung 12** | **Ordnung 15** | **Speedup** |
|------------|----------------|----------------|-------------|
| 1 | 15min | 1h | 1.0x |
| 2 | 8min | 35min | 1.9x |
| 4 | 4min | 18min | 3.8x |
| 8 | 2min | 10min | 7.5x |

**Beobachtung:** Fast-linearer Speedup bis ~8 Worker, dann Sättigung durch:
- Synchronisations-Overhead
- Shared Space-Contention
- Amdahl'sches Gesetz (serieller Anteil)

### 11.3 Speicherverbrauch

| **Ordnung** | **Worker** | **Space-Größe** | **Prozess-Speicher** | **Gesamt** |
|-------------|------------|-----------------|--------------------|------------|
| 12 | 1 | ~100 Entries | ~500MB | ~500MB |
| 12 | 4 | ~400 Entries | ~500MB × 4 | ~2GB |
| 15 | 4 | ~1000 Entries | ~1GB × 4 | ~4GB |
| 20 | 8 | ~5000 Entries | ~2GB × 8 | ~16GB |

---

## 12. Vergleich mit historischen Referenzen

### 12.1 Linda Tuple-Spaces (1989)

**Linda-Ansatz:**
```
// Linda-Style Golomb Search
out("task", order, startA2, endA2)
in("task", order, ?start, ?end)  // Worker nimmt Task
out("ruler", order, length, positions)  // Worker schreibt Lösung
eval("worker", workerCode)  // Agenten-Erstellung
```

**pi-spaces Vorteile:**
- Typisierte Templates
- Integrierte Transaktionen
- Native TypeScript-Unterstützung
- bessere Tool-Integration

### 12.2 JavaSpaces (1999)

**JavaSpaces Beispiel:**
```java
// JavaSpaces Entry
public class GolombTask implements Entry {
    public String type = "GolombTask";
    public Integer order;
    public Integer startPos;
    // ... getter/setter
}

// Space Operation
space.write(task, null, Lease.FOREVER);
GolombTask t = (GolombTask) space.take(template, null, Long.MAX_VALUE);
```

**Vergleich:**
| **Aspekt** | **JavaSpaces** | **pi-spaces** |
|------------|----------------|---------------|
| Typisierung | Java Classes | TypeScript Interfaces |
| Template Matching | Java Reflection | Structured Templates |
| Transaktionen | TransactionManager | Integriert |
| LLM-Integration | ❌ | ✅ |
| Performance | JVM-Overhead | V8-Optimiert |

### 12.3 Jini / GigaSpaces

**GigaSpaces Tutorial:** Mandelbrot-Rendering mit ähnlichem Pattern (Master-Worker + Task-Verteilung).

**pi-spaces Vorteile:**
- Einfachere API
- Keine Java-Abhängigkeit
- Bessere Integration mit modernem TypeScript-Ökosystem
- Native Async/Await-Unterstützung

---

## 13. Erweiterungsmöglichkeiten

### 13.1 Parallele Suchstrategien

```typescript
// Mehrere Suchalgorithmen gleichzeitig
class GolombSearchStrategy {
  static strategies = {
    dfs: new DFSSearch(),
    bfs: new BFSSearch(),
    genetic: new GeneticAlgorithm(),
    simulatedAnnealing: new SimulatedAnnealing()
  };
}
```

### 13.2 Verteilte Validierung

```typescript
// Validator mit mehreren Workern
class DistributedValidator {
  async validateAll(rulers: GolombRulerEntry[]): Promise<ValidationResult> {
    // Verteilung der Validierung auf mehrere Worker
    const chunks = this.chunkArray(rulers, this.numWorkers);
    const results = await Promise.all(
      chunks.map(chunk => this.workerPool.validateChunk(chunk))
    );
    return this.aggregateResults(results);
  }
}
```

### 13.3 Dynamische Lastverteilung

```typescript
// Dynamische Task-Verteilung basierend auf Worker-Auslastung
class DynamicLoadBalancer {
  async getNextTask(workerId: string): Promise<GolombSearchTask | null> {
    // Abfrage der Worker-Auslastung
    const load = await this.getWorkerLoad(workerId);
    
    // Suche nach Task für am wenigsten ausgelasteten Worker
    const tasks = await this.space.readAll({ type: "GolombSearchTask", status: "pending" });
    
    return tasks.find(t => this.isSuitableForWorker(t, workerId, load)) || null;
  }
}
```

### 13.4 Visualisierung

```typescript
// ASCII-Visualisierung des Lineals
function visualizeRuler(ruler: GolombRulerEntry): string {
  const maxPos = ruler.length;
  const line = Array(maxPos + 1).fill(' ');
  
  for (const pos of ruler.positions) {
    line[pos] = '│';
  }
  line[0] = '│';
  line[maxPos] = '│';
  
  return line.join('') + '\n' +
         ' '.repeat(maxPos) + '\n' +
         ruler.positions.join(' ');
}
```

### 13.5 Integration mit anderen Problemen

**Ähnliche Probleme, die mit demselben Framework gelöst werden können:**

| **Problem** | **Anpassungen** | **Komplexität** |
|-------------|-----------------|-----------------|
| N-Königinnen | Andere Validierungsfunktion | ⭐ |
| Sudoku | 9×9 Grid, andere Constraints | ⭐⭐ |
| Primzahlsieb | Andere Suchfunktion | ⭐ |
| Knapsack | Andere Zielfunktion | ⭐⭐ |
| Travelling Salesman | Andere Distanzfunktion | ⭐⭐⭐ |

---

## 14. Aufruf & Bedienung

### 14.1 Grundlegender Aufruf

```bash
# Suche nach Golomb-Lineal der Ordnung 12
node --experimental-strip-types examples/golomb.ts 12

# Mit 8 Workern
node --experimental-strip-types examples/golomb.ts 12 --workers 8

# Mit Checkpointing
node --experimental-strip-types examples/golomb.ts 12 --checkpoint /tmp/golomb-12-cp.json

# Mit Output-Datei
node --experimental-strip-types examples/golomb.ts 12 --out /tmp/GOL_12.txt

# Mit State-Verzeichnis
node --experimental-strip-types examples/golomb.ts 12 --dir /tmp/golomb-state
```

### 14.2 Command-Line Optionen

| **Option** | **Beschreibung** | **Default** |
|------------|----------------|-------------|
| `<order>` | Ordnung des gesuchten Lineals | 12 |
| `--workers <n>` | Anzahl Worker | 4 |
| `--min-length <l>` | Minimale Suchlänge | n(n-1)/2 |
| `--max-length <l>` | Maximale Suchlänge | bekanntes Optimum oder n(n-1)/2*2 |
| `--checkpoint <file>` | Checkpoint-Datei | - |
| `--dir <dir>` | State-Verzeichnis | /tmp/pi-spaces-golomb-<n>-<timestamp> |
| `--out <file>` | Output-Datei | <dir>/GOL_<n>.txt |

### 14.3 Output-Format

Die Output-Datei enthält:
```
length=91
marks=12
positions=0 1 4 10 20 35 55 65 75 85 90 91
distances=1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91
missing= (leer für optimale Lösung)
isOptimal=true
```

---

**Ende des Dokuments** | [Zurück zum README](README.md)
