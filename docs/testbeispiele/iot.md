# Testbeispiel 3: IoT-Monitoring

**Version:** 1.0  
**Datum:** 2026-10-06  
**Status:** Entwurf  
**Zweck:** Validierung von Echtzeit-Verarbeitung, Skalierbarkeit und Fehlertoleranz in einer Pipeline-Architektur.  
**Historische Referenz:** Jini (Processing Unit-Pipelines), GigaSpaces (Mandelbrot-Rendering).

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
| **Anwendungsfall** | Echtzeit-**Monitoring von IoT-Sensoren** (z. B. Temperatur, Luftfeuchtigkeit, Druck). |
| **Pattern** | Pipeline (Sensor → Aggregator → Alert → Dashboard) |
| **Historische Referenz** | Jini (Processing Unit-Pipelines), Outrigger (Stress-Tests) |
| **Modus** | `expand` für Sensor-Daten, `sync` (lww) für Alarme |
| **Ziel** | Demonstration von **Echtzeit-Verarbeitung**, **Skalierbarkeit** und **Fehlertoleranz**. |

---

## 2. Ziele

| **Ziel** | **Metrik** | **Akzeptanzkriterium** | **Priorität** |
|-----------|------------|------------------------|---------------|
| Echtzeit-Datenverarbeitung | Latenz von Sensor-Daten bis zur Anzeige. | ≤ 1s (p99). | ⭐⭐⭐ |
| Skalierbarkeit | Anzahl unterstützter Sensoren. | ≥ 10.000 Sensoren (simuliert). | ⭐⭐⭐ |
| Fehlertoleranz | Verhalten bei Sensor-/Host-Absturz. | Kein Datenverlust; Alarme werden ausgelöst. | ⭐⭐⭐ |
| Konsistenz | Aggregierte Daten sind korrekt. | Durchschnitt/Max/Min stimmen mit den Rohdaten überein. | ⭐⭐⭐ |
| Alert-Korrektheit | Alarme werden bei Grenzwertüberschreitung ausgelöst. | Alarm wird ausgelöst, wenn `value > threshold`. | ⭐⭐⭐ |

---

## 3. Space-Typen

```typescript
// Sensor-Daten (Rohdaten)
interface SensorReading {
  type: "SensorReading";
  sensorId: string;         // Eindeutige Sensor-ID (z. B. "temp:room1")
  timestamp: Date;         // Zeitstempel der Messung
  value: number;           // Messwert (z. B. 23.5 für Temperatur)
  unit: string;            // Einheit (z. B. "°C", "%", "hPa")
  metadata: {
    location?: string;     // Standort (z. B. "Raum 101")
    deviceType?: string;   // Gerätetyp (z. B. "DHT22")
    battery?: number;      // Akkustand (0–100%)
  };
  lease: Lease;            // Lease für den Eintrag (TTL: 5min)
}

// Aggregierte Daten (z. B. pro Sensor/Zeitfenster)
interface AggregatedData {
  type: "AggregatedData";
  sensorId: string;        // Sensor-ID
  window: [Date, Date];    // Zeitfenster (z. B. [2026-10-06T00:00:00Z, 2026-10-06T01:00:00Z])
  avg: number;            // Durchschnitt
  max: number;            // Maximum
  min: number;            // Minimum
  count: number;          // Anzahl Messungen
  stdDev?: number;        // Standardabweichung (optional)
}

// Alarm
interface Alert {
  type: "Alert";
  alertId: string;         // Eindeutige Alarm-ID (UUID)
  sensorId: string;       // Sensor-ID
  timestamp: Date;        // Zeitstempel des Alarms
  value: number;           // Auslösender Wert
  threshold: number;      // Schwellenwert
  severity: "low" | "medium" | "high";
  status: "open" | "acknowledged" | "closed";
  message: string;         // Alarmnachricht (z. B. "Temperatur > 30°C")
  lease: Lease;            // Lease für den Alarm (TTL: 1h)
}

// Dashboard-Daten
interface DashboardData {
  type: "DashboardData";
  lastUpdate: Date;
  sensors: Array<{
    sensorId: string;
    currentValue: number;
    currentUnit: string;
    avg: number;
    max: number;
    min: number;
    lastReading: Date;
  }>;
  alerts: Alert[];
  stats: {
    totalSensors: number;
    totalReadings: number;
    avgLatencyMs: number;
  };
}

// Alert-Schwellenwert
interface AlertThreshold {
  type: "AlertThreshold";
  sensorId: string;        // Sensor-ID (oder `"*"` für alle Sensoren)
  metric: "value" | "avg" | "max" | "min"; // Welche Metrik überwachen?
  threshold: number;      // Schwellenwert
  severity: "low" | "medium" | "high";
  condition: ">" | "<" | "==" | ">=" | "<="; // Bedingung
}
```

---

## 4. Agenten

| **Agent** | **Rolle** | **Space-Operationen** | **Modus** | **Host-Anforderungen** |
|-----------|-----------|-----------------------|-----------|------------------------|
| **Sensor-Agent** | Liest Daten von IoT-Geräten und schreibt sie in den Space. | `write(SensorReading)` | `expand` (by: capacity) | CPU: 1 Kern, RAM: 512MB |
| **Aggregator** | Berechnet Statistiken für Sensor-Daten. | `readAll(SensorReading, {sensorId: S, timestamp: { $gte: windowStart } })`, `write(AggregatedData)` | `expand` (by: sensorId) | CPU: 2 Kerne, RAM: 2GB |
| **Alert-Agent** | Überwacht auf kritische Werte. | `readAll(SensorReading, {value: { $gt: threshold } })`, `readAll(AggregatedData, {avg: { $gt: threshold } })`, `write(Alert)` | `sync` (lww) | CPU: 1 Kern, RAM: 1GB |
| **Dashboard-Agent** | Zeigt aktuelle Werte und Alarme an. | `readAll(AggregatedData)`, `readAll(Alert)`, `write(DashboardData)` | `local` | CPU: 1 Kern, RAM: 1GB |
| **Threshold-Agent** | Verwaltet Alarm-Schwellenwerte. | `write(AlertThreshold)`, `readAll(AlertThreshold)` | `local` | CPU: 1 Kern, RAM: 512MB |

---

## 5. Ablauf

### 5.1 Daten-Erfassung (Sensor-Agent)
1. **Sensor-Agent** liest Daten von einem IoT-Gerät (z. B. alle 1s):
   ```typescript
   const reading: SensorReading = {
     type: "SensorReading",
     sensorId: "temp:room1",
     timestamp: new Date(),
     value: 23.5,
     unit: "°C",
     metadata: {
       location: "Raum 101",
       deviceType: "DHT22",
       battery: 85
     },
     lease: createLease(300_000) // 5 Minuten
   };
   ```
2. **Sensor-Agent** schreibt das `SensorReading`:
   ```typescript
   await space.write(reading);
   ```

### 5.2 Aggregation (Aggregator)
1. **Aggregator** berechnet für jedes **Zeitfenster** (z. B. 1 Minute) die Statistiken:
   ```typescript
   const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
   const windowEnd = new Date(windowStart.getTime() + 60_000);
   
   const readings = await space.readAll({
     type: "SensorReading",
     sensorId: "temp:room1",
     timestamp: { $gte: windowStart, $lt: windowEnd }
   });
   ```
2. **Aggregator** berechnet `avg`, `max`, `min`:
   ```typescript
   const values = readings.map(r => r.value);
   const avg = values.reduce((a, b) => a + b, 0) / values.length;
   const max = Math.max(...values);
   const min = Math.min(...values);
   ```
3. **Aggregator** schreibt `AggregatedData`:
   ```typescript
   await space.write({
     type: "AggregatedData",
     sensorId: "temp:room1",
     window: [windowStart, windowEnd],
     avg,
     max,
     min,
     count: values.length
   });
   ```

### 5.3 Alerting (Alert-Agent)
1. **Alert-Agent** lädt `AlertThreshold`-Konfigurationen:
   ```typescript
   const thresholds = await space.readAll({
     type: "AlertThreshold"
   });
   ```
2. **Alert-Agent** durchsucht `SensorReading` und `AggregatedData` nach Grenzwertüberschreitungen:
   ```typescript
   const readings = await space.readAll({
     type: "SensorReading"
   });
   
   for (const reading of readings) {
     const threshold = thresholds.find(t =>
       (t.sensorId === reading.sensorId || t.sensorId === "*") &&
       t.metric === "value"
     );
     if (threshold && evaluateCondition(reading.value, threshold.threshold, threshold.condition)) {
       await triggerAlert(reading, threshold);
     }
   }
   ```
3. **Alert-Agent** erstellt `Alert`:
   ```typescript
   async function triggerAlert(reading: SensorReading, threshold: AlertThreshold) {
     const alert: Alert = {
       type: "Alert",
       alertId: uuidv4(),
       sensorId: reading.sensorId,
       timestamp: new Date(),
       value: reading.value,
       threshold: threshold.threshold,
       severity: threshold.severity,
       status: "open",
       message: `Sensor ${reading.sensorId}: ${reading.value} ${reading.unit} ${getConditionText(threshold.condition)} ${threshold.threshold} ${reading.unit}`,
       lease: createLease(3600_000) // 1 Stunde
     };
     await space.write(alert);
   }
   ```

### 5.4 Dashboard (Dashboard-Agent)
1. **Dashboard-Agent** sammelt aktuelle Daten:
   ```typescript
   const [sensors, aggregated, alerts] = await Promise.all([
     space.readAll({ type: "SensorReading" }),
     space.readAll({ type: "AggregatedData" }),
     space.readAll({ type: "Alert", status: "open" })
   ]);
   ```
2. **Dashboard-Agent** berechnet Dashboard-Daten:
   ```typescript
   const sensorData = sensors.map(s => ({
     sensorId: s.sensorId,
     currentValue: s.value,
     currentUnit: s.unit,
     lastReading: s.timestamp
   }));
   
   const dashboard: DashboardData = {
     type: "DashboardData",
     lastUpdate: new Date(),
     sensors: sensorData,
     alerts,
     stats: {
       totalSensors: new Set(sensors.map(s => s.sensorId)).size,
       totalReadings: sensors.length,
       avgLatencyMs: 0 // Wird später gemessen
     }
   };
   ```
3. **Dashboard-Agent** schreibt `DashboardData`:
   ```typescript
   await space.write(dashboard);
   ```

---

## 6. Testfälle

| **ID** | **Testfall** | **Schritte** | **Erwartetes Ergebnis** | **Modus** | **Priorität** |
|---------|--------------|--------------|-------------------------|-----------|---------------|
| T3.1 | Grundlegende Datenverarbeitung | 1 Sensor-Agent schreibt 10 `SensorReading`. 1 Aggregator berechnet Statistiken. | `AggregatedData` enthält korrekte `avg`, `max`, `min`. | `expand` | ⭐⭐⭐ |
| T3.2 | Echtzeit-Latenz | 1 Sensor-Agent schreibt alle 100ms ein `SensorReading`. | Dashboard zeigt neue Daten innerhalb von ≤ 1s. | `expand` + `local` | ⭐⭐⭐ |
| T3.3 | Skalierbarkeit (1000 Sensoren) | 1000 Sensor-Agenten schreiben gleichzeitig Daten. | Alle Daten werden verarbeitet. Durchsatz ≥ 1000 readings/s. | `expand` | ⭐⭐⭐ |
| T3.4 | Aggregations-Korrektheit | 10 Sensor-Agenten schreiben Daten für 1 Sensor. Aggregator berechnet Statistiken. | `AggregatedData.avg` = Durchschnitt aller `SensorReading.value`. | `expand` | ⭐⭐⭐ |
| T3.5 | Alert-Auslösung | Sensor-Agent schreibt `value: 35` (threshold=30). | `Alert` wird ausgelöst (`status: "open"`). | `sync` (lww) | ⭐⭐⭐ |
| T3.6 | Host-Absturz | Sensor-Agent auf Host1 schreibt Daten. Host1 stürzt ab. | Daten werden auf Host2 repliziert. Dashboard zeigt alle Daten. | `expand` | ⭐⭐⭐ |
| T3.7 | Netzwerkpartition | 2 Hosts, Netzwerk wird geteilt. Sensor-Agent auf Host1 schreibt Daten. | Nach Reconnect: Daten werden auf Host2 synchronisiert. | `expand` | ⭐⭐⭐ |
| T3.8 | Lease-Ablauf (Sensor-Daten) | `SensorReading` hat Lease von 5min. Kein Update für 10min. | `SensorReading` wird automatisch gelöscht (TTL-Ablauf). | `expand` | ⭐⭐ |
| T3.9 | Alert-Acknowledgment | Alert wird ausgelöst. Dashboard markiert Alert als `acknowledged`. | `Alert.status = "acknowledged"`. | `sync` (lww) | ⭐⭐ |
| T3.10 | Performance (10.000 Sensoren) | 10.000 Sensor-Agenten schreiben gleichzeitig Daten. | Durchsatz ≥ 5.000 readings/s, Latenz (p99) ≤ 500ms. | `expand` | ⭐⭐ |
| T3.11 | Aggregation-Fenster | Aggregator berechnet Statistiken für 1-Minuten-Fenster. | `AggregatedData.window` enthält korrektes Zeitfenster. | `expand` | ⭐⭐ |

---

## 7. Federation Policy

```yaml
# docs/testbeispiele/iot-policy.yaml
policyVersion: 1
rules:
  # SensorReading: expand nach Kapazität
  - type: "SensorReading"
    mode: "expand"
    members: ["host1", "host2", "host3"]
    by: "capacity"  # Verteilung nach Host-Kapazität
    
  # AggregatedData: expand nach Sensor-ID (alle Daten eines Sensors auf einem Member)
  - type: "AggregatedData"
    mode: "expand"
    members: ["host1", "host2", "host3"]
    by: { field: "sensorId" }
    
  # Alert: sync (lww) für Konsistenz
  - type: "Alert"
    mode: "sync"
    variant: "lww"
    members: ["host1", "host2"]
    keyFields: ["alertId"]
    
  # DashboardData: local (nur ein Agent)
  - type: "DashboardData"
    mode: "local"
    member: "host1"
    
  # AlertThreshold: sync (lww)
  - type: "AlertThreshold"
    mode: "sync"
    variant: "lww"
    members: ["host1", "host2"]
    keyFields: ["sensorId", "metric"]
    
default:
  mode: "local"
  member: "host1"
```

---

## 8. Performance-Metriken

| **Metrik** | **Zielwert** | **Messmethode** | **Tool** |
|------------|--------------|------------------|----------|
| Latenz (Sensor → Dashboard) | ≤ 1s (p99) | Zeit von `write(SensorReading)` bis Anzeige im Dashboard | custom Timer |
| Durchsatz (Sensor-Daten) | ≥ 5.000 readings/s | Zeit für 10.000 `SensorReading` / 10.000 | Locust |
| Durchsatz (Aggregation) | ≥ 1.000 aggregations/s | Zeit für 1.000 `AggregatedData` / 1.000 | custom Benchmark |
| Speicherverbrauch | ≤ 2GB pro Host | Maximaler RAM-Verbrauch während Test | `htop` |
| CPU-Auslastung | ≤ 70% | Durchschnittliche CPU-Auslastung | Prometheus |

---

## 9. Abhängigkeiten zu federation-plan-v3.md

| **Anforderung** | **Abschnitt in v3** | **Status** |
|----------------|----------------------|------------|
| `expand`-Modus | 7.1 | ✅ Implementiert |
| `sync`-Modus (lww) | 7.2 | ✅ Implementiert |
| Leases | 6.1 | ✅ Implementiert |
| Template-Matching | 6.1 | ✅ Implementiert |
| Replikation | 7.2 | ✅ Implementiert |

---

---

**Ende des Dokuments** | [Zurück zu TESTBESPIELE.md](../TESTBESPIELE.md)
