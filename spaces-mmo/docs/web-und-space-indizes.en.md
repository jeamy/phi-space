# In-memory indexes and web performance after the 2026-11-13 load test (plan)

Status: plan (2026-11-14), following [lasttest-2026-11-13.en.md](lasttest-2026-11-13.en.md).

## Context and what remains after the first two fixes

In the 2026-11-13 load test (`tests/perf/play-load.ts`, 200 registered players, all four epochs, 1–3 s between
commands), the driver placed each activity's required items into the region Spaces. Over 15–30 minutes each region grew
from 2,600–7,000 entries to 15,000–40,000 entries (mostly `Item` records).

Two bottlenecks were fixed during that session:
1. **`mmo-web` (94 % → 28 % busy):** `atlas_shared` now computes the shared overview state once per broadcast instead of
   scanning all world objects twice per client and reading three settings per client (600 RPCs per broadcast at 200
   players); `named_in` caches the compiled per-viewer regex.
2. **`phi-space-server` (93 % → 68 % CPU in `ost`, median latency in minutes 12–15 from 8.8 s → 3.6 s):** `Space::find`
   now walks the type bucket (`Entries::of_type`) instead of every record in the Space, and `SpaceHost::plan` derives
   touched positions from the commit undo log.

What still limits response times and web throughput as the world fills with items:
- **In `phi-space-server` (`ost` at 68 % CPU):**
  - `read_all` (`Space::list_page` / `Space::list` / `Space::count`) takes **29 %** of the Space process's time:
    `candidates(tmpl)` narrows by `type`, but when a region holds 30,000 `Item` entries, every
    `readAll({ type: "Item", fields: { location } })` scans all 30,000 `Item` records against `Template::matches`.
  - `phi_json::Object::position` takes **7 %** of the Space process's time: `Object` builds its `HashMap<String, usize>`
    key index only at `>= 32` keys, so every field lookup on game records (6–18 keys) scans `Vec<(String, Json)>`
    linearly.
- **In `mmo-web` (28 % CPU, plus extra load placed on the home Space):**
  - `Gateway::inbound` reads `cmd.burst` and `cmd.perSec` from the home Space via two sequential RPCs (`setting(...)`)
    on **every command and chat frame** before checking the rate limit (~200–300 extra `readAll` calls/s at 200 players).
  - `Gateway::flush` calls `self.atlas_shared()` **inside** the per-client loop (`while let Some(c) = deferred`), so
    when $k$ players change rooms in the same batch, `mmo-web` scans all 40,000–100,000 objects $k$ times and spawns
    $3k$ setting reads.
  - `Gateway::hello` (run on every room change) scans all `st.objs.values()` across all four regions, all
    `st.chars.values()` and all `st.notices.values()`, and rebuilds the static `world` payload (`plans_of`, `uses_of`,
    `fuels`, `icons`, `liner`, `rail`) from scratch on every room transition.
  - `Gateway::atlas_shared` and `stops` still scan all `st.objs.values()` (including tens of thousands of `Item` entries
    that never appear in `owned`, `tasks` or `stops`) once per second.
  - `WsConn::send` serializes `v.to_json_text()` per recipient on broadcasts (`broadcast_time`, `atlas`, `announce`,
    `announce_obj`).
  - `Web::route` reads static files (`out/`) and `/assets/` via synchronous `std::fs::read` on the single-threaded
    `LocalSet`.
- **In `mmo-engine` (`mmo-world` rose to 30–50 % CPU once the Spaces answered faster):**
  - `Mirror::read_all` narrows by `by_type`, then linearly scans all 30,000 `Item` entries in the region's mirror copy
    and sorts matches by `seq_of(id)` on every read.

---

## How indexes are managed in memory

Data lives in memory in three places, each with its own lifetime and mutation model:

### 1. `phi-core`: `Entries` and `Memo` (`rust/phi-core/src/state.rs`)

- **Primary storage:** `Entries { items: Vec<EntryRec>, log: Option<Vec<EntryUndo>>, memo: RefCell<Memo> }`.
  `items` stays in insertion order so `find`, `list` and `list_page` preserve the exact oldest-first semantics of
  `src/core.ts`.
- **Key invariant:** After an `EntryRec` is pushed into `Entries`, its `id`, `type_`, `types` and `fields` **never
  mutate**. `Entries::get_mut(i)` only ever changes `expires`, `written_under`, `taken_by` or `read_by` (because in
  phi-spaces an entry's payload is updated only by `take` + `write`).
- **How `Memo` works today:**
  - `types: HashMap<String, Rc<[usize]>>` maps a type name to the ordered slice of positions in `items` whose `types`
    include that type.
  - Built lazily on the first `of_type(t)` call.
  - On `push(e)`: positions of existing entries do not move; only cached buckets for `e.types` are invalidated (or
    extended).
  - On `remove(i)`: existing buckets shift positions `p > i` down by `1` and drop `p == i` without rescanning `items`.
  - On `retain` / `undo`: `Memo` is cleared (`changed()`).
- **How the new field and id indexes in `Memo` are managed:**
  - **ID index (`by_id: Option<HashMap<String, usize>>`):**
    - Built lazily on the first lookup by `id` (`Template::Of { id: Some(_), .. }`, `leased`, `read_chain`).
    - On `push(e)`: if `by_id` is `Some`, insert `(e.id.clone(), new_idx)`.
    - On `remove(i)`: if `by_id` is `Some`, remove `items[i].id` and decrement values `> i` (or drop `by_id` if batch
      expiring).
  - **Type + field index (`fields: HashMap<(String, String), HashMap<ScalarKey, Rc<[usize]>>>`):**
    - `ScalarKey` represents indexable scalar JSON values in template fields:
      - `ScalarKey::Str(String)`
      - `ScalarKey::Num(u64)` (canonical `f64` bit pattern, with `-0.0` normalized to `+0.0`)
      - `ScalarKey::Bool(bool)`
    - Built **lazily per `(type_name, field_name)` pair** when `candidates(tmpl)` or `find(tmpl)` is called with a
      template that specifies `type_: Some(Json::String(t))` and at least one non-null scalar field `(k, v)`:
      1. If `(t, k)` is not yet in `memo.fields`, walk `self.of_type(t)` once (only the entries of type `t`, already in
         index order), extract `e.fields.get(k)` as a `ScalarKey`, group positions into `Vec<usize>` per value, and
         store `HashMap<ScalarKey, Rc<[usize]>>`.
      2. Look up `val` in that inner map; if absent, return an empty slice `&[]` (`O(1)` miss).
      3. When a template names multiple scalar fields (e.g. `{ type: "Item", fields: { location: "r1", proto: "holz" } }`),
         query `of_type_field` for each scalar field and pick the **shortest** `Rc<[usize]>` slice as the candidate
         positions. Because each slice is already in ascending `items` order, the first match and the list order are
         identical to a full scan.
    - **Invalidation on mutation:**
      - `get_mut(i)`: does **nothing** to `memo.fields` or `memo.by_id` because `id`, `types` and `fields` never change
        in place.
      - `push(e)`: `m.fields.retain(|(t, _), _| !e.types.iter().any(|x| x == t))` (only the pushed entry's types are
        invalidated; other types' field indexes stay warm).
      - `remove(i)`: for the removed entry's `e.types`, either drop those types' entries from `m.fields` or shift
        positions `p > i` down by `1` just like `m.types`. Note: because a transaction `take` marks `taken_by = Some(txn)`
        via `get_mut(i)` and only removes the entry at `commit` (`finish`), reads during a transaction do not even
        trigger `remove(i)`!

### 2. `mmo-engine`: `Mirror` (`rust/mmo-engine/src/mirror.rs`)

- **How `Copy` works today:**
  - `by_id: HashMap<String, Json>` and `by_type: HashMap<String, HashSet<String>>`.
  - Every `read_all` collects all entries of `by_type[ty]`, filters with `matches(t, e)`, and sorts the result by
    `seq_of(id)`.
- **How the new index in `Copy` is managed:**
  - Replace `by_type: HashMap<String, HashSet<String>>` with ordered vectors or maintain
    `by_type_field: HashMap<(String, String), HashMap<String, Vec<String>>>` for string fields (or lazy memoization
    invalidated per type on `put`/`del` in `apply`).
  - Keep each bucket's IDs ordered by `seq_of(id)` on insert (since space entry IDs grow monotonically, `put` almost
    always appends to the end; an update in place keeps its position), eliminating both the 30,000-entry scan and the
    per-call `sort_by` in `Mirror::read_all`.

### 3. `mmo-web`: `Gateway::State` (`rust/mmo-web/src/gateway.rs`)

- **How `State` works today:**
  - Uses `OMap<Json>` (insertion-ordered map backed by `Vec<Option<(String, V)>>` + `HashMap<String, usize>`) for
    `chars`, `rooms`, `objs`, `notices`, etc.
  - `objs` holds the view objects of all four regions combined.
- **How the new indexes in `State` are managed:**
  - **`objs_by_loc: HashMap<String, OMap<()>>`:** maintained in `set_obj` and `del`. When `set_obj(id, o)` overwrites an
    object whose `location` changed, remove `oid` from the old location's `OMap` and insert into the new location's
    `OMap`.
  - **`atlas_objs: OMap<()>`:** maintained in `set_obj` and `del` for objects whose `kind` is one of
    `"site" | "building" | "bed" | "field" | "ruin" | "road" | "beacon"`. `atlas_shared()`, `stops()` and `atlas()`
    iterate `atlas_objs` instead of `st.objs`, skipping all `Item`, `Exit` and `Scenery` records completely.
  - **`notices_by_char: HashMap<String, OMap<()>>`:** maintained when `Notice` entries are put/deleted so `hello` and
    `tell` look up a player's notices in `O(1)` instead of scanning all notices in the world.
  - **`clients_by_room: HashMap<String, Vec<Rc<Client>>>`:** updated whenever `*c.room.borrow_mut()` changes or a
    client closes, so room-scoped broadcasts (`announce`, `announce_obj`, room messages, fog) only visit clients in
    that room.

---

## Can dedicated Spaces or LUTs in Spaces help?

### 1. Lookup tables (LUTs) stored as entries inside a Space: **No (counter-productive)**

Storing index entries (such as `RoomItems { room, itemIds: [...] }` or `PackItems { charId, itemIds: [...] }`) inside a
Space hurts performance and scalability in phi-spaces for four reasons:
1. **Write contention (`StillHeld`):** Every command that picks up, drops, crafts or moves an item would have to `take`
   and `write` the room's or character's LUT entry inside its transaction. Two players picking up driftwood in the same
   room would contend on the same `RoomItems` entry and serialize or fail with `StillHeld`.
2. **Double commit budget and SQLite row writes:** Every mutation to a LUT entry counts against `maxCommitBytes`
   (192 KiB), writes an extra row to SQLite, and logs a larger `put` operation in the change stream.
3. **Change-stream amplification:** `mmo-web` and `mmo-world` follow the change stream of every region. Rewriting a
   `RoomItems` array on every drop/pickup would stream the entire ID list to all followers on every item change.
4. **Still requires an RPC:** Reading a LUT from a Space still costs a socket roundtrip plus `Space::settle`, whereas an
   in-memory index inside `Entries::memo` (in `phi-core`), `Mirror` (in `mmo-engine`) and `State` (in `mmo-web`) is
   updated in RAM at zero disk, wire and lock cost.

**Conclusion:** LUTs belong in memory inside each process (`Entries::memo`, `Mirror`, `Gateway::State`), derived
automatically from the entries, never persisted as Space entries.

### 2. Additional Spaces: **Where they help vs. where they do not**

`spaces-mmo` already partitions state across **five Spaces**: four region Spaces (`west`, `nord`, `ost`, `sued`) and
the `accounts` Space (credentials, web sessions, encrypted chat).

- **A dedicated Space for LUTs or caches:** Does not help; adds network hops and cross-Space consistency issues (phi-spaces
  transactions do not span multiple Spaces).
- **A separate Space for `Intent` / `Session` entries:** Does not help; an `Intent` must be taken atomically in the
  **same transaction** that mutates the character and room state in the region Space, otherwise commands lose their
  at-most-once transactional guarantee.
- **Splitting into more than 4 region Spaces:** On `big` (8 cores, running 4 region Space processes, 4 world workers,
  `mmo-web` and other services), 4 regions already match the core count, and `mmo-web` still holds the union of all
  regions in memory.
- **What *does* help at the data-model level (Item stacking / cleanup):**
  - The reason the load test slowed down over 30 minutes is that 200 players generated 15,000–40,000 individual `Item`
    entries per region. Every plank, stone, ore or flour sack in a pack, chest or warehouse is a separate `Item` entry.
  - While Phase 1–3 make 40,000+ entries fast via `O(1)` in-memory field indexes, **stacking identicalfungible items**
    (`count: n` on `Item` entries without custom `variety`/properties inside packs, chests and warehouses, or expiring
    abandoned driver items) reduces the total entry count in SQLite, in the Space, in `Mirror` and in `mmo-web` by an
    order of magnitude.

---

## Implementation Plan

Each phase is self-contained, keeps wire frames and store files 100 % compatible, and is verified by the existing Rust
and TypeScript test suites.

### Phase 1: In-memory field & ID indexes in `phi-core` and key-index threshold in `phi-json`

**Goal:** Eliminate the 29 % `read_all` scan and 7 % `Object::position` overhead in `phi-space-server`.

1. **`rust/phi-core/src/state.rs` (`Entries` & `Memo`):**
   - Define `ScalarKey` (`Str(String)`, `Num(u64)`, `Bool(bool)`) with `ScalarKey::from_json(&Json) -> Option<Self>`.
   - Extend `Memo` with:
     - `by_id: Option<HashMap<String, usize>>`
     - `fields: HashMap<(String, String), HashMap<ScalarKey, Rc<[usize]>>>`
   - Add `Entries::of_id(&self, id: &str) -> Option<usize>`: builds `by_id` lazily on first call, returns the index in
     `items`.
   - Add `Entries::of_type_field(&self, type_: &str, field: &str, key: &ScalarKey) -> Rc<[usize]>`: builds the
     `HashMap<ScalarKey, Rc<[usize]>>` for `(type_, field)` lazily by iterating `self.of_type(type_)` once, and returns
     the matching ordered slice (or an empty `Rc<[usize]>`).
   - Maintain `Memo` in `push` and `remove`:
     - `push(e)`: update `by_id` if present; invalidate `m.types` and `m.fields` only for types in `e.types`.
     - `remove(i)`: update `by_id` and `m.fields` (shift indices `> i` down by `1` or drop affected type entries).
     - `get_mut(i)`: leave `types`, `by_id` and `fields` untouched (since `id`, `types` and `fields` do not change).
     - In debug builds (`debug_assert!`), verify `of_type_field` against a linear filter of `of_type`.
2. **`rust/phi-core/src/space.rs` (`candidates`, `find`, `leased`, `read_chain`):**
   - Update `candidates(&self, tmpl: &Template)` and `find(&self, tmpl: &Template, ...)`:
     - If `tmpl` has `id: Some(Json::String(id))`, look up the single candidate via `entries.of_id(id)`.
     - Else if `tmpl` has `type_: Some(Json::String(t))`, inspect `fields` for scalar `(k, v)` pairs; if present, fetch
       `entries.of_type_field(t, k, &scalar)` for each and iterate the shortest `Rc<[usize]>` slice.
   - Use `entries.of_id(id)` in `leased` and `read_chain` (replacing the per-call `HashMap` build over all entries in
     `read_chain`).
3. **`rust/phi-json/src/lib.rs` (`Object`):**
   - Lower the `HashMap` index threshold in `Object` from `32` to `12` keys so `Character`, `Building` and `Room`
     objects use `O(1)` lookup, while tiny objects (2–11 keys) avoid the `HashMap` allocation.
4. **Verification:**
   - `cd rust && cargo test -p phi-json -p phi-core -p phi-store -p phi-service && cargo clippy --all-targets`

### Phase 2: `mmo-web` gateway indexes, settings cache, `flush` fix and broadcast serialization

**Goal:** Remove the 2 Space RPCs per command, eliminate `O(N_objs)` scans on room transitions and atlas ticks, and
avoid repeated JSON serialization on broadcasts.

1. **`rust/mmo-web/src/gateway.rs` – Cache `cmd.burst` and `cmd.perSec`:**
   - Add `cmd_burst: Cell<f64>` (initialized to `20.0`) and `cmd_per_sec: Cell<f64>` (initialized to `5.0`) to
     `Gateway`.
   - Refresh them asynchronously alongside `beam.cost`, `epoch.force` and `pack.max` in `atlas_shared` (and once at
     startup in `Gateway::new`).
   - Use `self.cmd_burst.get()` and `self.cmd_per_sec.get()` synchronously in `attach` and `inbound`.
2. **`rust/mmo-web/src/gateway.rs` – Fix `flush()`:**
   - In `Gateway::flush`, return early if `self.deferred.borrow().is_empty()`. Otherwise compute
     `let shared = self.atlas_shared();` **once** before the `loop` and pass `&shared` to `self.atlas_state(c, &shared)`.
3. **`rust/mmo-web/src/gateway.rs` – Secondary indexes in `State` and cached static `world` view:**
   - Precompute the static parts of the `hello.world` object (`id`, `title`, `tileSize`, `tiles`, `skins`, `decor`,
     `fuels`, `icons`, `plans`, `uses`, `rail`, and `liner` template) once in `Gateway::new`.
   - Maintain `objs_by_loc: HashMap<String, OMap<()>>`, `atlas_objs: OMap<()>` (non-item/exit/scenery objects) and
     `notices_by_char: HashMap<String, OMap<()>>` in `State` (`set_obj`, `put`, `del`, `reset`).
   - Use `atlas_objs` in `atlas_shared`, `stops` and `atlas` so `Item` entries are never scanned there.
   - Use `objs_by_loc` and `notices_by_char` in `hello` and `tell`.
4. **`rust/mmo-web/src/ws.rs` & `gateway.rs` – Serialize once per broadcast and cache static assets:**
   - Add `WsConn::send_text(&self, text: &str)` and pre-serialize shared frames in `broadcast_time`, `atlas_changed`,
     `announce` and `announce_obj`.
   - Cache static files from `out/` and `/assets/` in memory on first read in `Web`.
5. **Verification:**
   - `cd rust && cargo test -p mmo-web && cargo clippy --all-targets`
   - Run `spaces-mmo/tests/r8/web-cross.ts` against the TypeScript oracle to verify byte-identical WebSocket frames.

### Phase 3: Ordered type and field index in `mmo-engine`'s `Mirror`

**Goal:** Reduce `mmo-world` CPU (30–50 % under high item counts) by making `Mirror::read_all` `O(matches)` instead of
`O(N_type * log N_type)`.

1. **`rust/mmo-engine/src/mirror.rs`:**
   - Keep `by_type` entries in ascending `seq_of(id)` order (using an ordered structure or lazy sorted slice) and add a
     secondary index `by_field: HashMap<(String, String), HashMap<ScalarKey, Vec<String>>>` (maintained on `put`/`del`
     or lazily per `(type, field)`).
   - In `Mirror::read_all`, use the most selective `(type, field, value)` bucket and return matches directly without
     scanning all `Item` records or re-sorting on every call.
2. **Verification:**
   - `cd rust && cargo test -p mmo-engine && cargo clippy --all-targets`
   - `npm --prefix spaces-mmo test`
