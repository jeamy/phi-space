# Testbeispiel 1: Master-Worker für verteilte Berechnung (Primzahlsieb)

**Version:** 1.0  
**Datum:** 2026-10-06  
**Status:** Entwurf  
**Zweck:** Validierung von Lastverteilung, Fehlertoleranz und Konsistenz im `expand`-Modus.  
**Historische Referenz:** Linda (Primzahlsieb), JavaSpaces (Generischer Compute Server).

---

## 📋 Inhaltsverzeichnis

1. [Übersicht](#1-übersicht)
2. [Ziele](#2-ziele)
3. [Space-Typen](#3-space-typen)
4. [Agenten](#4-agenten)
5. [Ablauf](#5-ablauf)
6. [Testfälle](#6-testfälle)
7. [Federation Policy](#7-federation-policy)
8. [Performance-Metriken](#8-performance-metriken)
9. [Abhängigkeiten zu federation-plan-v3.md](#9-abhängigkeiten-zu-federation-plan-v3md)

---

---

## 1. Übersicht

| **Aspekt** | **Wert** |
|------------|----------|
| **Anwendungsfall** | Verteilte Berechnung von Primzahlen in einem großen Zahlenbereich (z. B. 1 bis 10⁹). |
| **Pattern** | Master-Worker mit Task-Bag |
| **Historische Referenz** | Linda (Primzahlsieb), JavaSpaces (Generischer Compute Server) |
| **Modus** | `expand` (Verteilung der Tasks auf Members) |
| **Ziel** | Demonstration von **Lastverteilung**, **Fehlertoleranz** und **Konsistenz**. |

---

## 2. Ziele

| **Ziel** | **Metrik** | **Akzeptanzkriterium** | **Priorität** |
|-----------|------------|------------------------|---------------|
| Korrektheit | Alle Primzahlen im Bereich werden gefunden. | Keine falschen Positiv/Negativ (validiert mit Sieve of Eratosthenes). | ⭐⭐⭐ |
| Skalierbarkeit | Durchsatz bei wachsender Worker-Anzahl. | Linearer Speedup bis 10 Worker (amortisiert). | ⭐⭐⭐ |
| Fehlertoleranz | Verhalten bei Worker-Absturz. | Kein Datenverlust; Tasks werden neu vergeben. | ⭐⭐⭐ |
| Konsistenz | Keine doppelten Ergebnisse. | Jede Primzahl wird **genau einmal** in der finalen Liste. | ⭐⭐⭐ |
| Lastverteilung | Gleichmäßige Auslastung der Worker. | Maximale Differenz der verarbeiteten Blöcke ≤ 10%. | ⭐⭐ |
| Performance | Latenz pro Task. | ≤ 1s (p99) für Blöcke der Größe 10⁶. | ⭐⭐ |

---

## 3. Space-Typen

```typescript
// Task: Ein Block des Zahlenbereichs für die Primzahlsuche
interface SieveTask {
  type: "SieveTask";
  taskId: string;          // UUID (z. B. "550e8400-e29b-41d4-a716-446655440000")
  rangeStart: number;     // Anfang des Blocks (inkl., z. B. 1)
  rangeEnd: number;       // Ende des Blocks (exkl., z. B. 1000001)
  status: "pending" | "processing" | "done" | "failed";
  workerId?: string;      // ID des aktuell bearbeitenden Workers (wenn "processing")
  lease: Lease;            // Lease für den Worker (TTL: 30s)
  retries: number;        // Anzahl der Wiederholungsversuche (Default: 3)
}

// Ergebnis: Primzahlen in einem Block
interface SieveResult {
  type: "SieveResult";
  taskId: string;          // Referenz auf den zugehörigen Task
  primes: number[];       // Gefundene Primzahlen im Block (sortiert)
  workerId: string;       // ID des Workers, der das Ergebnis berechnet hat
  durationMs: number;     // Bearbeitungsdauer in Millisekunden
}

// Finales Ergebnis (aggregiert)
interface SieveSummary {
  type: "SieveSummary";
  totalPrimes: number;    // Gesamtzahl der Primzahlen im gesamten Bereich
  range: [number, number]; // Gesamter Bereich (z. B. [1, 1000000])
  completed: boolean;     // true, wenn alle Tasks "done" oder "failed" sind
  startedAt: Date;         // Startzeitpunkt der Berechnung
  completedAt?: Date;     // Zeitstempel der Fertigstellung
}

// Lease für Tasks (Standardwert: 30s)
interface Lease {
  id: string;              // Eindeutige Lease-ID
  expiresAt: Date;         // Ablaufzeitpunkt
  owner: string;           // Besitzer (Worker-ID)
}
```

---

## 4. Agenten

| **Agent** | **Rolle** | **Space-Operationen** | **Modus** | **Host-Anforderungen** |
|-----------|-----------|-----------------------|-----------|------------------------|
| **Master** | Erstellt Tasks und aggregiert Ergebnisse. | `write(SieveTask)`, `read(SieveResult)`, `write(SieveSummary)` | `local` | CPU: 1 Kern, RAM: 1GB |
| **Worker** | Berechnet Primzahlen in einem Block. | `take(SieveTask, {status: "pending"})`, `write(SieveResult)` | `expand` (by: capacity) | CPU: 2+ Kerne, RAM: 2GB |
| **Collector** | Aggregiert Ergebnisse (optional, kann im Master integriert sein). | `readAll(SieveResult)`, `take(SieveSummary)`, `write(SieveSummary)` | `local` | CPU: 1 Kern, RAM: 1GB |

---

## 5. Ablauf

### 5.1 Initialisierung
1. **Master** berechnet die **Blockgröße** (z. B. `blockSize = 10⁶` für 10⁹).
2. **Master** teilt den Bereich in `N` Blöcke auf (z. B. `N = 1000` für 10⁹).
3. **Master** schreibt `N` `SieveTask`-Entries in den Space:
   ```typescript
   for (let i = 0; i < N; i++) {
     const task: SieveTask = {
       type: "SieveTask",
       taskId: uuidv4(),
       rangeStart: i * blockSize,
       rangeEnd: (i + 1) * blockSize,
       status: "pending",
       lease: createLease(30_000) // 30s TTL
     };
     space.write(task);
   }
   ```
4. **Master** schreibt den initialen `SieveSummary`:
   ```typescript
   space.write({
     type: "SieveSummary",
     totalPrimes: 0,
     range: [0, N * blockSize],
     completed: false,
     startedAt: new Date()
   });
   ```

### 5.2 Verarbeitung (Worker)
1. **Worker** nimmt einen `SieveTask` mit `take`:
   ```typescript
   const task = await space.take({
     type: "SieveTask",
     status: "pending"
   });
   ```
2. **Worker** aktualisiert den Task-Status auf `"processing"` und setzt `workerId` (in einer **Transaktion**):
   ```typescript
   await space.txn(async (tx) => {
     await tx.take({
       type: "SieveTask",
       taskId: task.taskId
     });
     await tx.write({
       ...task,
       status: "processing",
       workerId: workerId
     });
   });
   ```
3. **Worker** berechnet Primzahlen im Block (z. B. mit **Sieve of Eratosthenes**):
   ```typescript
   const startTime = Date.now();
   const primes = sieveOfEratosthenes(task.rangeStart, task.rangeEnd);
   const durationMs = Date.now() - startTime;
   ```
4. **Worker** schreibt das `SieveResult`:
   ```typescript
   await space.write({
     type: "SieveResult",
     taskId: task.taskId,
     primes,
     workerId: workerId,
     durationMs
   });
   ```
5. **Worker** aktualisiert den Task-Status auf `"done"`:
   ```typescript
   await space.txn(async (tx) => {
     await tx.take({
       type: "SieveTask",
       taskId: task.taskId
     });
     await tx.write({
       ...task,
       status: "done"
     });
   });
   ```

### 5.3 Aggregation (Master/Collector)
1. **Master** pollt regelmäßig auf neue `SieveResult`-Entries:
   ```typescript
   const results = await space.readAll({
     type: "SieveResult"
   });
   ```
2. **Master** aggregiert die `primes`-Arrays und aktualisiert `SieveSummary`:
   ```typescript
   const allPrimes = results.flatMap(r => r.primes);
   await space.txn(async (tx) => {
     const summary = await tx.read({
       type: "SieveSummary"
     });
     await tx.take({
       type: "SieveSummary",
       range: summary.range
     });
     await tx.write({
       ...summary,
       totalPrimes: allPrimes.length,
       completed: results.length === N // Alle Tasks erledigt?
     });
   });
   ```

---

## 6. Testfälle

| **ID** | **Testfall** | **Schritte** | **Erwartetes Ergebnis** | **Modus** | **Priorität** |
|---------|--------------|--------------|-------------------------|-----------|---------------|
| T1.1 | Grundlegender Durchlauf | 1 Master, 1 Worker, Bereich 1–1000. | Alle 168 Primzahlen werden gefunden. `SieveSummary.completed = true`. | `local` | ⭐⭐⭐ |
| T1.2 | Skalierbarkeit (10 Worker) | 1 Master, 10 Worker, Bereich 1–10⁶. | Lineare Beschleunigung (ca. 10x schneller als 1 Worker). Durchsatz ≥ 100 Tasks/s. | `expand` | ⭐⭐⭐ |
| T1.3 | Worker-Absturz | 1 Master, 2 Worker, Bereich 1–10⁴. Worker 1 stürzt nach 50% der Tasks ab. | Worker 2 übernimmt restliche Tasks (Lease-Ablauf). Alle Primzahlen werden gefunden. | `expand` | ⭐⭐⭐ |
| T1.4 | Doppelte Task-Verarbeitung | 2 Worker versuchen, denselben Task zu nehmen. | Nur **ein** Worker erhält den Task (atomares `take`). | `expand` | ⭐⭐⭐ |
| T1.5 | Task-Timeout | Worker nimmt Task, berechnet nicht (simulierter Absturz). | Task-Lease läuft nach 30s ab → Task wird wieder `"pending"`. Ein anderer Worker nimmt den Task. | `expand` | ⭐⭐⭐ |
| T1.6 | Netzwerkpartition | 2 Worker auf Host1/Host2, Netzwerk wird für 1 Minute geteilt. | Worker in Partition 1 verarbeiten Tasks; Worker in Partition 2 warten. Nach Reconnect: alle Tasks werden verfolgt. | `expand` | ⭐⭐⭐ |
| T1.7 | Transaktionssicherheit | Worker schreiben `SieveResult`, aber nicht Task-Status (`"done"`). | `SieveResult` wird **nicht** in `SieveSummary` aggregiert (Transaktions-Rollback). | `local` | ⭐⭐⭐ |
| T1.8 | Lastverteilung | 10 Worker, ungleiche Blockgrößen. | Alle Worker verarbeiten **etwa gleich viele Blöcke** (Differenz ≤ 10%). | `expand` | ⭐⭐ |
| T1.9 | Retry-Mechanismus | Worker scheitert bei Task (z. B. OOM). Task hat `retries: 3`. | Task wird **3x neu vergeben**, dann Status `"failed"`. | `expand` | ⭐⭐ |
| T1.10 | Performance (10.000 Tasks) | 10 Worker, 10.000 Tasks (Bereich 1–10⁷). | Durchsatz ≥ 100 Tasks/s, Latenz (p99) ≤ 500ms. | `expand` | ⭐⭐ |

---

## 7. Federation Policy

```yaml
# docs/testbeispiele/sieve-policy.yaml
policyVersion: 1
rules:
  # SieveTask: Verteilung nach Kapazität (CPU)
  - type: "SieveTask"
    mode: "expand"
    members: ["host1", "host2", "host3"]
    by: "capacity"  # Verteilung basierend auf Host-Kapazität
    
  # SieveResult: Verteilung nach Kapazität (Speicher)
  - type: "SieveResult"
    mode: "expand"
    members: ["host1", "host2", "host3"]
    by: "capacity"
    
  # SieveSummary: Nur auf Master-Host (Host1)
  - type: "SieveSummary"
    mode: "local"
    member: "host1"
    
  # Lease: Synchrone Replikation (für Konsistenz)
  - type: "Lease"
    mode: "sync"
    variant: "primary"
    member: "host1"
    primaryReplica: "host2"
    durability: "sync"
    
default:
  mode: "local"
  member: "host1"
```

---

## 8. Performance-Metriken

| **Metrik** | **Zielwert** | **Messmethode** | **Tool** |
|------------|--------------|------------------|----------|
| Durchsatz (Tasks/s) | ≥ 100 (10 Worker) | Zeit für 10.000 Tasks / 10.000 | Locust |
| Latenz (Task → Result) | ≤ 1s (p99) | Zeit von `take(SieveTask)` bis `write(SieveResult)` | custom Timer |
| Speichernutzung | ≤ 1GB pro Host | Maximaler RAM-Verbrauch während Test | `htop` |
| CPU-Auslastung | ≤ 80% pro Worker | Durchschnittliche CPU-Auslastung | Prometheus |
| Network Traffic | ≤ 100MB für 10⁶ Bereich | Summe aller gesendeten Bytes (Tasks + Results) | `iftop` |

---

## 9. Abhängigkeiten zu federation-plan-v3.md

| **Anforderung** | **Abschnitt in v3** | **Status** |
|----------------|----------------------|------------|
| `expand`-Modus | 7.1 | ✅ Implementiert |
| `take` mit Lease | 6.1 | ✅ Implementiert |
| Transaktionen | 6.1 | ✅ Implementiert |
| Atomare Operationen | 2.1 | ✅ Garantiert |
| HRW-Verteilung | 7.1 | ✅ Implementiert |
| Byte-Limits | 6.2 | ✅ Konfiguriert |

---

---

**Ende des Dokuments** | [Zurück zu TESTBESPIELE.md](../TESTBESPIELE.md)
