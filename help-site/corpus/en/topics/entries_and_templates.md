---
standard: help_topic
id: help.topic.entries_and_templates
title: "Entries, Subtypes, and Template Matching"
short: "Structure of entries ({type, types?, fields}), global identities (gid), hierarchical subtypes, and exact wildcard rules during template matching."
tags: [entries, templates, wildcards, subtypes, gid, matching]
owner: core
related: [help.topic.leases_and_transactions, help.api.phispaces_write, help.api.phispaces_read]
since: 0.0.1
---

# Entries, Subtypes, and Template Matching

## Overview {#overview}

An entry is like a note with a heading and a few details on it. A template describes what you are looking for, for example every note headed "job" for a certain project. Details you leave open match anything. This way programs find data by its content rather than by an address.

### Technical Details {#technical-details}

All application and coordination state in `phi-spaces` is stored as **entries** and queried using **templates**. Matching combines structural type checks with deep JSON equality across top-level fields.

## Concept And System Model {#concept-model}

### Entry Shape And Supertypes {#entry-structure}

```ts
type EntryDraft = {
  type: string;
  types?: string[];
  fields: Record<string, Json>;
};
```

- `type` is the primary type name (e.g. `"ChatTask"`).
- `types` is an optional array containing the primary type and any supertypes (e.g. `["ChatTask", "Task", "Auditable"]`). A template asking for `type: "Task"` matches any entry whose `types` array includes `"Task"`.
- A returned `EntryView` adds `id` (local ID `e<incarnation>-<n>`), `gid` (`<spaceId>/<localId>`), `owner`; `expires` is returned on the `Lease`.
- Text in an entry is well-formed: through the service, an unpaired surrogate becomes U+FFFD. If you cut text yourself, use `cutText(text, max)`, which never leaves half an emoji.

### Write Options {#write-options}

- **`unique: ["field"]`**: `write` checks atomically whether an entry of the same concrete type already carries the same key fields, even if reserved or still uncommitted. If so, it fails with `UniqueConflict`. This is a check of this one write, not a lasting index, and it holds per space.
- **`transient: true`**: No entry is created. The change stream carries the value as a `put` with `transient: true`, but no `read`, `take`, `wait`, `count` or subscription ever sees it. It is meant for output only stream readers need. It cannot be combined with `unique`.

### Template Matching And Wildcards {#template-matching}

```ts
type Template = {
  type?: string | null;
  fields?: Record<string, Json>;
  id?: string | null;
} | null;
```

- Passing `null` or `{}` matches **every** visible entry.
- If `template.type` is specified, `entry.types` must include that type.
- If `template.id` is specified, `entry.id` must match exactly.
- For each key `k` in `template.fields`:
  - If `template.fields[k] === null` or `undefined`, it acts as a **wildcard** (matches any value or even a missing key).
  - Otherwise `entry.fields[k]` must equal `template.fields[k]` under deep canonical JSON equality.
  - **Consequence**: Because `null` in a template is a wildcard, you cannot filter specifically for a stored JSON `null`; use explicit string states such as `"none"` or `"root"` instead.

## Examples {#examples}

```ts
// Write a chat message in thread "main"
await space.write({
  type: "Msg",
  types: ["Msg", "TimelineItem"],
  fields: { threadId: "main", seq: 1, author: "alice", text: "Hello Space!" }
});

// Find one message in thread "main" regardless of seq or author
const msg = await space.read({
  type: "Msg",
  fields: { threadId: "main", author: null } // author: null is a wildcard
}, 0);
```

## See Also {#see-also}

- [Leases, Transactions, and Visibility](help.topic.leases_and_transactions#overview)
- [write – Write an Entry](help.api.phispaces_write)
