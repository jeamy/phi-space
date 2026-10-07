# Testbeispiel 2: Distributed Cache

**Version:** 1.0  
**Datum:** 2026-10-06  
**Status:** Entwurf — **keine Implementierung vorhanden** (`examples/cache.ts` existiert nicht)  
**Zweck:** Validierung von Konsistenz, Verfügbarkeit und Performance im `sync` (lww)-Modus.  
**Historische Referenz:** JavaSpaces (geteilte Variablen, Kanäle/Queues).

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
| **Anwendungsfall** | Verteilter **Key-Value-Cache** mit TTL (Time-To-Live) und automatischem Ablauf. |
| **Pattern** | Client-Server mit Replikation |
| **Historische Referenz** | JavaSpaces (geteilte Variablen), Jini (Service Discovery) |
| **Modus** | `sync` (lww-Variante) für Konsistenz |
| **Ziel** | Demonstration von **Konsistenz**, **Verfügbarkeit** und **Performance**. |

---

## 2. Ziele

| **Ziel** | **Metrik** | **Akzeptanzkriterium** | **Priorität** |
|-----------|------------|------------------------|---------------|
| Konsistenz | Alle Clients sehen denselben Wert für einen Schlüssel. | Keine inkonsistenten Reads (validiert mit Linearizability-Tests). | ⭐⭐⭐ |
| Verfügbarkeit | Cache bleibt verfügbar bei Host-Absturz. | 99,9% Verfügbarkeit (≤ 8,76h Downtime/Jahr). | ⭐⭐⭐ |
| Performance | Latenz für `get`/`set`. | `get`: ≤ 10ms, `set`: ≤ 20ms (p99). | ⭐⭐⭐ |
| Skalierbarkeit | Durchsatz bei wachsender Cache-Größe. | ≥ 10.000 `get`/`set`-Operationen pro Sekunde. | ⭐⭐⭐ |
| TTL-Korrektheit | Einträge werden nach TTL gelöscht. | Kein Entry mit abgelaufenem TTL bleibt länger als `maxClockSkew` (10s) im Cache. | ⭐⭐⭐ |
| Konfliktlösung | Gleichzeitige `set`-Operationen. | Deterministische Konfliktlösung (lww: höhere `version` gewinnt). | ⭐⭐ |

---

## 3. Space-Typen

```typescript
// Cache-Eintrag
interface CacheEntry {
  type: "CacheEntry";
  key: string;              // Eindeutiger Schlüssel (z. B. "user:123")
  value: Uint8Array;       // Wert (binär, z. B. JSON-serialisiert)
  ttl: number;             // Time-To-Live in ms (ab `createdAt`)
  version: number;         // Versionsnummer (für lww-Konfliktlösung)
  createdAt: Date;         // Erstellungszeitpunkt
  updatedAt: Date;         // Letzte Aktualisierung
  lease: Lease;            // Lease für den Eintrag (TTL: 1h)
}

// Cache-Statistiken
interface CacheStats {
  type: "CacheStats";
  hits: number;             // Anzahl erfolgreicher Reads
  misses: number;          // Anzahl fehlgeschlagener Reads
  evictions: number;       // Anzahl gelöschter Einträge (TTL-Ablauf)
  size: number;            // Aktuelle Anzahl Einträge
  lastReset: Date;         // Letzter Reset der Statistiken
}

// Cache-Operation (für Tests)
interface CacheOp {
  type: "CacheOp";
  opId: string;            // Eindeutige Operations-ID
  op: "get" | "set" | "delete";
  key: string;
  value?: Uint8Array;
  ttl?: number;
  status: "pending" | "done" | "failed";
  startTime: Date;
  endTime?: Date;
}

// Tombstone für gelöschte Einträge (für Resync)
interface CacheTombstone {
  type: "CacheTombstone";
  key: string;              // Schlüssel des gelöschten Eintrags
  deletedAt: Date;         // Löschzeitpunkt
  version: number;         // Version zum Zeitpunkt der Löschung
}
```

---

## 4. Agenten

| **Agent** | **Rolle** | **Space-Operationen** | **Modus** | **Host-Anforderungen** |
|-----------|-----------|-----------------------|-----------|------------------------|
| **Cache-Writer** | Schreibt Daten in den Cache. | `write(CacheEntry)`, `take(CacheEntry) + write(CacheEntry)` (Upsert) | `sync` (lww) | CPU: 1 Kern, RAM: 1GB |
| **Cache-Reader** | Liest Daten aus dem Cache. | `read(CacheEntry, {key: K})` | `sync` (lww) | CPU: 1 Kern, RAM: 1GB |
| **Cache-Manager** | Verwaltet Leases und löscht abgelaufene Einträge. | `readAll(CacheEntry, {ttl: { $lt: now } })`, `take(CacheEntry)` | `local` | CPU: 1 Kern, RAM: 512MB |
| **Cache-Tester** | Führt Performance-Tests durch. | `write(CacheOp)`, `read(CacheOp)` | `local` | CPU: 2 Kerne, RAM: 2GB |

---

## 5. Ablauf

### 5.1 Schreiben (`set`)
1. **Cache-Writer** erstellt ein `CacheEntry`:
   ```typescript
   const entry: CacheEntry = {
     type: "CacheEntry",
     key: "user:123",
     value: new TextEncoder().encode(JSON.stringify({ name: "Alice" })),
     ttl: 3600_000, // 1 Stunde
     version: Date.now(), // oder sequenzielle Versionsnummer
     createdAt: new Date(),
     updatedAt: new Date(),
     lease: createLease(3600_000) // 1 Stunde
   };
   ```
2. **Cache-Writer** schreibt das Entry mit `write`:
   ```typescript
   await space.write(entry);
   ```
3. **Falls `key` bereits existiert** → **lww-Konfliktlösung**:
   - Das Entry mit der **höheren `version`** gewinnt.
   - Bei gleicher `version` gewinnt das Entry mit der **niedrigeren `replicaId`** (deterministisch).

### 5.2 Lesen (`get`)
1. **Cache-Reader** liest das Entry mit `read`:
   ```typescript
   const entry = await space.read({
     type: "CacheEntry",
     key: "user:123"
   });
   ```
2. **Falls Entry nicht existiert** → **Cache Miss** (`null`).
3. **Falls Entry existiert** → **Cache Hit** (Entry wird zurückgegeben).

### 5.3 TTL-Ablauf
1. **Cache-Manager** durchsucht regelmäßig `CacheEntry` mit `ttl < now`:
   ```typescript
   const expiredEntries = await space.readAll({
     type: "CacheEntry",
     ttl: { $lt: Date.now() }
   });
   ```
2. **Cache-Manager** löscht abgelaufene Einträge mit `take`:
   ```typescript
   for (const entry of expiredEntries) {
     await space.take({
       type: "CacheEntry",
       key: entry.key
     });
     // Optional: Tombstone für Resync schreiben
     await space.write({
       type: "CacheTombstone",
       key: entry.key,
       deletedAt: new Date(),
       version: entry.version
     });
   }
   ```
3. **Cache-Manager** aktualisiert `CacheStats`:
   ```typescript
   await space.txn(async (tx) => {
     const stats = await tx.read({ type: "CacheStats" });
     await tx.take({ type: "CacheStats" });
     await tx.write({
       ...stats,
       evictions: stats.evictions + expiredEntries.length,
       size: stats.size - expiredEntries.length
     });
   });
   ```

### 5.4 Upsert
1. **Cache-Writer** liest das bestehende Entry (falls vorhanden):
   ```typescript
   const existing = await space.read({
     type: "CacheEntry",
     key: "user:123"
   });
   ```
2. **Cache-Writer** erstellt ein neues Entry mit **höherer `version`**:
   ```typescript
   const newEntry: CacheEntry = {
     ...existing,
     value: newValue,
     version: existing ? existing.version + 1 : Date.now(),
     updatedAt: new Date()
   };
   ```
3. **Cache-Writer** schreibt das Entry mit `write` (atomar):
   ```typescript
   await space.write(newEntry);
   ```

---

## 6. Testfälle

| **ID** | **Testfall** | **Schritte** | **Erwartetes Ergebnis** | **Modus** | **Priorität** |
|---------|--------------|--------------|-------------------------|-----------|---------------|
| T2.1 | Grundlegendes Set/Get | Setze `key1: "value1"`, lese `key1`. | `value1` wird zurückgegeben. | `sync` (lww) | ⭐⭐⭐ |
| T2.2 | TTL-Ablauf | Setze `key1: "value1"` mit `ttl: 1s`. Warte 2s. | `read(key1)` gibt `null` zurück. | `sync` (lww) | ⭐⭐⭐ |
| T2.3 | Upsert (lww) | Setze `key1: "value1"` (version=1). Setze `key1: "value2"` (version=2). | `read(key1)` gibt `"value2"` zurück (version=2 gewinnt). | `sync` (lww) | ⭐⭐⭐ |
| T2.4 | Gleichzeitiges Set (Konflikt) | 2 Writer setzen `key1` mit gleicher `version`. | Ein Entry gewinnt (deterministisch, z. B. niedrigere `replicaId`). | `sync` (lww) | ⭐⭐⭐ |
| T2.5 | Cache-Miss | Lese nicht existierenden `key1`. | `read(key1)` gibt `null` zurück. | `sync` (lww) | ⭐⭐⭐ |
| T2.6 | Skalierbarkeit (1000 Keys) | 10 Writer setzen 1000 Keys, 10 Reader lesen alle Keys. | Alle Keys werden korrekt gelesen. Durchsatz ≥ 1000 ops/s. | `sync` (lww) | ⭐⭐⭐ |
| T2.7 | Host-Absturz | Setze `key1: "value1"` auf Host1. Host1 stürzt ab. | `read(key1)` auf Host2 gibt `"value1"` zurück (Replikation). | `sync` (lww) | ⭐⭐⭐ |
| T2.8 | Netzwerkpartition | 2 Hosts, Netzwerk wird geteilt. Setze `key1` auf Host1. | Nach Reconnect: `read(key1)` auf Host2 gibt `"value1"` zurück (Konvergenz). | `sync` (lww) | ⭐⭐⭐ |
| T2.9 | Lease-Ablauf | Setze `key1` mit Lease. Lease läuft ab. | `key1` wird automatisch gelöscht (TTL-Ablauf). | `sync` (lww) | ⭐⭐ |
| T2.10 | Performance (10.000 ops) | 10 Writer setzen 10.000 Keys, 10 Reader lesen alle Keys. | Durchsatz ≥ 10.000 ops/s, Latenz (p99) ≤ 20ms. | `sync` (lww) | ⭐⭐ |
| T2.11 | Konsistenz-Test (Linearizability) | 100 Clients führen `get`/`set` auf 10 Keys durch. | Keine inkonsistenten Reads (validiert mit Jepsen). | `sync` (lww) | ⭐⭐ |

---

## 7. Federation Policy

```yaml
# docs/testbeispiele/cache-policy.yaml
policyVersion: 1
rules:
  # CacheEntry: lww für Konsistenz
  - type: "CacheEntry"
    mode: "sync"
    variant: "lww"
    members: ["host1", "host2", "host3"]
    keyFields: ["key"]  # Schlüssel für lww-Konfliktlösung
    
  # CacheStats: lww (nur ein Entry)
  - type: "CacheStats"
    mode: "sync"
    variant: "lww"
    members: ["host1", "host2", "host3"]
    keyFields: ["type"]  # Nur ein Stats-Entry
    
  # CacheTombstone: lww (für Resync)
  - type: "CacheTombstone"
    mode: "sync"
    variant: "lww"
    members: ["host1", "host2", "host3"]
    keyFields: ["key"]
    
  # CacheOp: local (nur für Tests)
  - type: "CacheOp"
    mode: "local"
    member: "host1"
    
default:
  mode: "local"
  member: "host1"
```

---

## 8. Performance-Metriken

| **Metrik** | **Zielwert** | **Messmethode** | **Tool** |
|------------|--------------|------------------|----------|
| Durchsatz (`get`/`set`) | ≥ 10.000 ops/s | Zeit für 100.000 Operationen / 100.000 | wrk, Vegeta |
| Latenz (`get`, p99) | ≤ 10ms | Zeit von `read` bis Antwort | custom Timer |
| Latenz (`set`, p99) | ≤ 20ms | Zeit von `write` bis Bestätigung | custom Timer |
| Verfügbarkeit | ≥ 99,9% | (Up-Time / Gesamtzeit) * 100 | Prometheus |
| Datenverlust | 0% | Vergleich mit Referenzdaten | custom Check |

---

## 9. Abhängigkeiten zu federation-plan-v3.md

| **Anforderung** | **Abschnitt in v3** | **Status** |
|----------------|----------------------|------------|
| `sync`-Modus (lww) | 7.2 | ❌ Geplant (Stufe 3) |
| Leases | 6.1 | ✅ Implementiert |
| Tombstones | 6.1 | ❌ Geplant (Stufe 3, nur für `sync` nötig) |
| Atomare Operationen | 2.1 | ✅ Implementiert |
| Replikation | 7.2 | ❌ Geplant (Stufe 3) |

---

---

**Ende des Dokuments** | [Zurück zu TESTBESPIELE.md](../TESTBESPIELE.md)
