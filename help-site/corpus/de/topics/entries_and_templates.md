---
standard: help_topic
id: help.topic.entries_and_templates
title: "Entries, Subtypen und Template-Matching"
short: "Aufbau von Entries ({type, types?, fields}), globale Identitäten (gid), hierarchische Subtypen und exakte Wildcard-Regeln beim Template-Matching."
tags: [entries, templates, wildcards, subtypes, gid, matching]
owner: core
related: [help.topic.leases_and_transactions, help.api.phispaces_write, help.api.phispaces_read]
since: 0.0.1
---

# Entries, Subtypen und Template-Matching

## Überblick {#overview}

Ein Entry ist wie ein Zettel mit einer Überschrift und ein paar Angaben darauf. Ein Template beschreibt, was du suchst, zum Beispiel alle Zettel mit der Überschrift „Auftrag“ für ein bestimmtes Projekt. Angaben, die du offen lässt, passen auf alles. So finden Programme Daten über ihren Inhalt statt über eine Adresse.

### Technische Details {#technical-details}

Alle Nutz- und Koordinationsdaten in `phi-spaces` werden als **Entries** abgelegt und über **Templates** abgefragt. Das Matching arbeitet über strukturelle Typprüfung und tiefe JSON-Gleichheit auf oberster Feldebene.

## Begriffs- und Systemmodell {#concept-model}

### Entry-Aufbau und Supertypen {#entry-structure}

```ts
type EntryDraft = {
  type: string;
  types?: string[];
  fields: Record<string, Json>;
};
```

- `type` ist der primäre Typname (z.B. `"ChatTask"`).
- `types` ist eine optionale Liste mit dem Haupttyp und seinen Supertypen (z.B. `["ChatTask", "Task", "Auditable"]`). Ein Template mit `type: "Task"` findet auch jeden Entry, dessen `types`-Array `"Task"` enthält.
- Ein gespeicherter `EntryView` enthält zusätzlich `id` (lokale ID `e<incarnation>-<n>`), `gid` (`<spaceId>/<localId>`), `owner`; `expires` steht auf der zurückgegebenen `Lease`.
- Text in einem Entry ist wohlgeformt: Über den Dienst wird ein unpaariges Surrogat zu U+FFFD. Wer Text selbst kürzt, nimmt `cutText(text, max)`, das kein halbes Emoji stehen lässt.

### Schreiboptionen {#write-options}

- **`unique: ["feld"]`**: `write` prüft atomar, ob schon ein Entry desselben konkreten Typs dieselben Schlüsselfelder trägt, auch reserviert oder noch uncommitted. Sonst folgt `UniqueConflict`. Das ist eine Prüfung dieses einen Writes, kein dauerhafter Index, und sie gilt je Space.
- **`transient: true`**: Es entsteht kein Entry. Der Änderungsstrom trägt den Wert als `put` mit `transient: true`, aber kein `read`, `take`, `wait`, `count` oder Abo sieht ihn. Gedacht für Ausgaben, die nur Leser des Stroms brauchen. Nicht zusammen mit `unique`.

### Template-Matching und Wildcards {#template-matching}

```ts
type Template = {
  type?: string | null;
  fields?: Record<string, Json>;
  id?: string | null;
} | null;
```

- `null` oder `{}` als Template matcht **jeden** sichtbaren Entry.
- Ist `template.type` gesetzt, muss `entry.types` diesen Typ enthalten.
- Ist `template.id` gesetzt, muss `entry.id` exakt übereinstimmen.
- Für jedes Feld `k` in `template.fields`:
  - Ist `template.fields[k] === null` oder `undefined`, wirkt das Feld als **Wildcard** (jeder Wert oder auch ein fehlendes Feld im Entry matcht).
  - Andernfalls muss `entry.fields[k]` per tiefer kanonischer JSON-Gleichheit mit `template.fields[k]` übereinstimmen.
  - **Konsequenz**: Da `null` im Template als Wildcard reserviert ist, kann nicht gezielt nach einem gespeicherten JSON-`null`-Feldwert gefiltert werden; verwende stattdessen explizite Statusstrings wie `"none"` oder `"root"`.

## Beispiele {#examples}

```ts
// Schreibt eine Chat-Nachricht im Thread "main"
await space.write({
  type: "Msg",
  types: ["Msg", "TimelineItem"],
  fields: { threadId: "main", seq: 1, author: "alice", text: "Hallo Space!" }
});

// Findet eine Nachricht im Thread "main", unabhängig von seq oder author
const msg = await space.read({
  type: "Msg",
  fields: { threadId: "main", author: null } // author: null ist ein Wildcard
}, 0);
```

## Siehe auch {#see-also}

- [Leases, Transaktionen und Sichtbarkeit](help.topic.leases_and_transactions#overview)
- [write – Entry schreiben](help.api.phispaces_write)
