# 📁 pi-spaces Federation-Dokumentation

**Stand:** 2026-10-06  
**Aktuelle Version:** v2.0

---

## 📚 Dokumentenübersicht

| Dokument | Beschreibung | Version | Status |
|----------|--------------|---------|--------|
| **[federation-plan-v2.md](./federation-plan-v2.md)** | **Hauptdokument** – Vollständiger Plan mit allen Lösungen | 2.0 | ✅ **Aktuell** |
| **[federation-plan-v2-summary.md](./federation-plan-v2-summary.md)** | **Kompakte Übersicht** – Schnelle Referenz aller Änderungen | 2.0 | ✅ **Aktuell** |
| [federation-plan-v1.md](./federation-plan-v1.md) | Ursprünglicher Plan (veraltet) | 1.0 | ⚠️ **Veraltet** |
| [spaces-v1.md](./spaces-v1.md) | Grundlegende Space-Implementierung | 1.0 | ✅ **Referenz** |

---

## 🎯 Wichtigste Änderungen in v2

### ✅ **6 Kritische Blocker gelöst** (müssen vor Implementation behoben werden)

| # | Problem | Lösung | Abschnitt |
|---|--------|--------|-----------|
| **1** | Kein Fencing-Adapter (5.2) | Modularer Adapter mit IPMI/AWS/Docker/File | [v2 §14.1](federation-plan-v2.md#141-fencing-adapter-für-sichere-promotion) |
| **2** | Pairing-Token unsicher (4.4) | Challenge-Response + peerId-Bindung + Rate-Limiting | [v2 §14.2](federation-plan-v2.md#142-sicheres-pairing-protokoll) |
| **3** | LWW/Set Datenverlust (7.2) | Tombstones + nur für idempotente Daten | [v2 §14.3](federation-plan-v2.md#143-lwwset-konsistenz) |
| **4** | Router-Journal nicht atomar (6.2) | 2-Phase-Commit + Idempotente Writes | [v2 §14.4](federation-plan-v2.md#144-atomare-router-journal--entry-mutation) |
| **5** | Delegation unsicher (4.3) | Signierte Tokens mit Policy-Version + Replay-Schutz | [v2 §14.5](federation-plan-v2.md#145-sichere-delegationsnachweise) |
| **6** | Control Space Single-PoF (5.1) | Asynchroner Standby bereits in Stufe 1b | [v2 §14.6](federation-plan-v2.md#146-control-space-mit-asynchroner-replikation) |

### ⚠️ **9 Hohe Risiken gelöst** (sollten vor Abnahme adressiert werden)

| # | Problem | Lösung | Abschnitt |
|---|--------|--------|-----------|
| **7** | NetBird-IPs ohne Identität (4.1) | mTLS + Ed25519-Challenge für space-gate | [v2 §14.7](federation-plan-v2.md#147-mtls--ed25519-challenge-für-space-gate) |
| **8** | readAll/count inkonsistent (7.1) | Blockieren oder Snapshot-basiert | [v2 §14.8](federation-plan-v2.md#148-konsistente-readallcount-ergebnisse) |
| **9** | RPC-Claims mit Klartext (6.2) | Nur Hashes speichern + In-Memory-Cache | [v2 §14.9](federation-plan-v2.md#149-dsgvo-konforme-rpc-claims) |
| **10** | drain ignoriert laufende Requests (7.1) | Requests für drainende Members abbrechen | [v2 §14.10](federation-plan-v2.md#1410-drain-mit-abbruch-laufender-requests) |
| **11** | Recovery Space lokal (5.2) | Replikation wie Control Space | [v2 §14.11](federation-plan-v2.md#1411-recovery-space-mit-replikation) |
| **12** | pollOperation ohne Deadline (6.2) | Client-seitige Gesamt-Deadline | [v2 §14.12](federation-plan-v2.md#1412-gesamte-deadline-für-polloperation) |
| **13** | addMember + HRW-Zuordnung (7.1) | Neue Regel für neue Daten + Dokumentation | [v2 §14.13](federation-plan-v2.md#1413-addmember--hrw-zuordnung) |
| **14** | RAID-10-Unterstützung (7.3) | Für v3 geplant | [v2 §14.14](federation-plan-v2.md#1414-raid-10-unterstützung) |
| **15** | NetBird-Ausfalltests unvollständig (4.5) | Komplette Testmatrix | [v2 §14.15](federation-plan-v2.md#1415-netbird-ausfalltest-suite) |

---

## 📖 Lesereihenfolge

### 🔹 **Für schnelle Orientierung**
1. **[federation-plan-v2-summary.md](./federation-plan-v2-summary.md)** – Alle Änderungen auf einen Blick
2. **Tabelle oben** – Übersicht der wichtigsten Probleme und Lösungen

### 🔹 **Für detaillierte Implementation**
1. **[federation-plan-v2.md](./federation-plan-v2.md)** – Vollständiger Plan mit:
   - allen aktualisierten Abschnitten
   - **Abschnitt 14**: Detaillierte Lösungen für alle 15 identifizierten Probleme
   - Code-Beispielen und Testkriterien
2. **Spezifische Abschnitte in v2:**
   - [§14.1 Fencing-Adapter](federation-plan-v2.md#141-fencing-adapter-für-sichere-promotion)
   - [§14.2 Sicheres Pairing](federation-plan-v2.md#142-sicheres-pairing-protokoll)
   - [§14.3 LWW/Set-Konsistenz](federation-plan-v2.md#143-lwwset-konsistenz)
   - [§14.4 Router-Journal](federation-plan-v2.md#144-atomare-router-journal--entry-mutation)
   - [§14.5 Sichere Delegation](federation-plan-v2.md#145-sichere-delegationsnachweise)
   - [§14.6 Control Space HA](federation-plan-v2.md#146-control-space-mit-asynchroner-replikation)

### 🔹 **Für Hintergrundwissen**
- **[spaces-v1.md](./spaces-v1.md)** – Grundlegende Space-Implementierung
- **[federation-plan-v1.md](./federation-plan-v1.md)** – Ursprünglicher Plan (urspüngliche Version)

---

## 🎯 Implementierungsroadmap

### **Phase 1: Kritische Blocker (1-2 Wochen)**
- [ ] **Fencing-Adapter** implementieren ([v2 §14.1](federation-plan-v2.md#141-fencing-adapter-für-sichere-promotion))
- [ ] **Sicheres Pairing** implementieren ([v2 §14.2](federation-plan-v2.md#142-sicheres-pairing-protokoll))
- [ ] **Router-Journal atomar** machen ([v2 §14.4](federation-plan-v2.md#144-atomare-router-journal--entry-mutation))
- [ ] **Sichere Delegation** implementieren ([v2 §14.5](federation-plan-v2.md#145-sichere-delegationsnachweise))
- [ ] **Control Space HA** einrichten ([v2 §14.6](federation-plan-v2.md#146-control-space-mit-asynchroner-replikation))

### **Phase 2: Hohe Risiken (1-2 Wochen)**
- [ ] **mTLS + Challenge** für space-gate ([v2 §14.7](federation-plan-v2.md#147-mtls--ed25519-challenge-für-space-gate))
- [ ] **Konsistente readAll** implementieren ([v2 §14.8](federation-plan-v2.md#148-konsistente-readallcount-ergebnisse))
- [ ] **DSGVO-konforme RPC-Claims** ([v2 §14.9](federation-plan-v2.md#149-dsgvo-konforme-rpc-claims))
- [ ] **Drain mit Abbruch** ([v2 §14.10](federation-plan-v2.md#1410-drain-mit-abbruch-laufender-requests))
- [ ] **Recovery Space replizieren** ([v2 §14.11](federation-plan-v2.md#1411-recovery-space-mit-replikation))
- [ ] **Gesamt-Deadline für pollOperation** ([v2 §14.12](federation-plan-v2.md#1412-gesamte-deadline-für-polloperation))
- [ ] **NetBird-Ausfalltests** ([v2 §14.15](federation-plan-v2.md#1415-netbird-ausfalltest-suite))

### **Phase 3: Tests & Dokumentation (1 Woche)**
- [ ] Alle Unit-Tests schreiben
- [ ] Integrationstests mit Docker
- [ ] End-to-End-Tests für kritische Pfade
- [ ] Dokumentation aktualisieren

---

## 🔍 Suchhilfe

| Stichwort | Abschnitt |
|----------|-----------|
| Fencing | [v2 §14.1](federation-plan-v2.md#141-fencing-adapter-für-sichere-promotion) |
| Pairing, Token, Challenge | [v2 §14.2](federation-plan-v2.md#142-sicheres-pairing-protokoll) |
| LWW, Set, Tombstone | [v2 §14.3](federation-plan-v2.md#143-lwwset-konsistenz) |
| Router, Journal, Atomarität | [v2 §14.4](federation-plan-v2.md#144-atomare-router-journal--entry-mutation) |
| Delegation, Signatur | [v2 §14.5](federation-plan-v2.md#145-sichere-delegationsnachweise) |
| Control Space, HA | [v2 §14.6](federation-plan-v2.md#146-control-space-mit-asynchroner-replikation) |
| mTLS, Authentifizierung | [v2 §14.7](federation-plan-v2.md#147-mtls--ed25519-challenge-für-space-gate) |
| readAll, count, Konsistenz | [v2 §14.8](federation-plan-v2.md#148-konsistente-readallcount-ergebnisse) |
| DSGVO, RPC, Claims | [v2 §14.9](federation-plan-v2.md#149-dsgvo-konforme-rpc-claims) |
| drain | [v2 §14.10](federation-plan-v2.md#1410-drain-mit-abbruch-laufender-requests) |
| Recovery | [v2 §14.11](federation-plan-v2.md#1411-recovery-space-mit-replikation) |
| pollOperation, Deadline | [v2 §14.12](federation-plan-v2.md#1412-gesamte-deadline-für-polloperation) |
| addMember, HRW | [v2 §14.13](federation-plan-v2.md#1413-addmember--hrw-zuordnung) |
| NetBird, Tests | [v2 §14.15](federation-plan-v2.md#1415-netbird-ausfalltest-suite) |

---

## 📌 Wichtige Hinweise

### 🔴 **Blocker für Stufe 3**
- **Fencing-Adapter muss vor Stufe 3 implementiert und getestet sein** ([v2 §14.1](federation-plan-v2.md#141-fencing-adapter-für-sichere-promotion))
- Ohne Fencing-Adapter: **Keine sichere Promotion möglich**

### 🔴 **Blocker für Stufe 1b**
- **Sicheres Pairing muss vor Stufe 1b implementiert sein** ([v2 §14.2](federation-plan-v2.md#142-sicheres-pairing-protokoll))
- **Control Space mit async Standby muss vor Stufe 1b implementiert sein** ([v2 §14.6](federation-plan-v2.md#146-control-space-mit-asynchroner-replikation))
- Ohne diese: **Kein sicheres Enrollment/Commands möglich**

### ⚠️ **Wichtige Sicherheitshinweise**
- **LWW/Set nur für idempotente Daten/Fakten verwenden** ([v2 §14.3](federation-plan-v2.md#143-lwwset-konsistenz))
- **Alle Verbindungen über space-gate mit mTLS + Challenge** ([v2 §14.7](federation-plan-v2.md#147-mtls--ed25519-challenge-für-space-gate))
- **Delegationstokens immer signieren und Policy-Version prüfen** ([v2 §14.5](federation-plan-v2.md#145-sichere-delegationsnachweise))

---

## 💬 Feedback & Fragen

Für Feedback zu den Dokumenten:
- **Issues oder Verbesserungsvorschläge** bitte als PR oder Issue im Repository melden
- **Fragen zur Implementation** an das Team richten

---

**Letzte Aktualisierung:** 2026-10-06  
**Verantwortlich:** [Team pi-spaces](mailto:team@pi-spaces.local)  
**Version:** 2.0