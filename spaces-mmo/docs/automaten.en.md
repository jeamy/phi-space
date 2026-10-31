# Automata (phase 6)

Players build small machines that act on their own in the world: gathering, tending fires, carrying goods. An automaton
is a program that runs in the pi-codemode sandbox (QuickJS, like the contributions in codemode-chat,
`codemode-chat/server/judge.ts`), and a game figure that uses exactly the same commands as a human.

**Status 2026-10-31: plan, not yet implemented.** There is no automaton worker, no templates, no `automat` commands and
no help system for them; only the section "Einstellungen für Betreiber" is implemented, for the models and the limits
named there as existing.

Nobody has to start from zero: there is a **selection of finished example automata** to adopt and adapt, and a **small
help system** that shows the same texts in the game and in the editor.

## In the game

- An automaton is an item (prototype `Automat`, built from rope, gear, housing). When set up it becomes a figure
  `["Object","Character","Automaton"]` with `owner`.
- It runs on **oil**. Filling in oil extends the lease of its `Fuel` entry; when the oil is used up, it stops. So the
  computing budget is a game item and not a configuration value.
- Each character may run at most 2 automata at the same time (initially; more later through reputation), guests 1.
  On registration, the automata of a guest are kept.

## Programming model

An automaton is **one function per tick**. It sees what its figure sees and returns commands. It has no access to the
Space, no network, no clock except the tick it is given (`tools: []` in the sandbox, as with the judge).

```js
// Called once every 5 s.
function schritt(sicht, merk) {
  // sicht: what the figure currently perceives (see below), read-only
  // merk:  what the last step returned (initially {})
  return { tue: ["look"], merk };
}
```

**`sicht`** (built by the world worker, JSON):

```js
{
  takt: 1834,                                   // consecutive, replaces the clock
  ich:   { name: "Klapper", x: 4, y: 7, inventar: [{ name: "treibholz", anzahl: 2 }], oel: 0.62 },
  raum:  { name: "Graue Bucht", nebel: 1,       // 0 clear … 3 dense
           ausgaenge: [{ richtung: "nord", ziel: "Klippenpfad" }],
           dinge:  [{ name: "treibholz", typ: "Flotsam", x: 9, y: 11 }],
           leute:  [{ name: "Mira", x: 5, y: 7, automat: false }],
           feuer:  { stand: 0.18, brennstoff: "oel" } },   // only in rooms with a beacon
  hoerte: [{ von: "Mira", text: "hallo klapper" }],         // since the last step
  fehler: "Zu spät – jemand anderes war schneller."         // result of the last command, if it failed
}
```

**Return value:** `{ tue: string[], merk: object }`

- `tue`: at most 2 commands per step, in the same language as the command line (`go nord`, `move 9 11`,
  `get treibholz`, `put öl in feuer`, `say …`). Builder and admin commands are blocked for automata (cmdset
  `AutomatonCmdSet` replaces the default cmdset).
- `merk`: free-form, at most 4 KiB as JSON; stored as an `AutomatonMemory` entry and passed in the next step. This way
  an automaton survives restarts.

**Limits:** source ≤ 8,000 characters, 50 ms and 8 MiB per step, one step every 5 s. Whoever exceeds the limit gets
nothing executed for that step and a line in the automaton log; after 5 errors in a row the automaton stops.

## Flow in the system

```
Welt-Ticker  ── alle 5 s: fällige Automaten (Fuel-Lease lebt, nicht pausiert)
Automaten-Worker ── take AutomatonDue{id} ──▶ Sicht bauen ──▶ Sandbox: schritt(sicht, merk)
                 ── write Intent{actor: automat, line} je Befehl, write AutomatonMemory, write AutomatonLog (Lease 1 h)
Welt-Worker     ── nimmt die Intents wie von Menschen (Locks, Cmdsets, Transaktionen gelten unverändert)
```

The automaton worker is a process of its own (`automaton-host.ts`), just as the judges in codemode-chat are a process of
their own: foreign code never runs in the world or web process. It may only write `Intent`, `AutomatonMemory` and
`AutomatonLog` (`Policy`).

## Example automata (selection)

In the game: `automat vorlagen` lists them, `automat vorlage <name>` loads one into the editor. In the browser: a list
with difficulty, short description and "Übernehmen" (adopt). They are ordered by difficulty and build on each other.

| Name | Level | What you learn | What it does |
| --- | --- | --- | --- |
| **Grüßer** | 1 | `schritt`, `tue`, `sicht.leute` | Greets every person who newly enters the room |
| **Strandläufer** | 1 | `sicht.dinge`, `move`, `get` | Walks to the nearest flotsam and picks it up |
| **Feuerwärter** | 2 | Thresholds, inventory | Adds oil as soon as the fire drops below 25 % |
| **Bote** | 2 | `merk`, exits, routes | Carries goods back and forth between two rooms |
| **Nebelboje** | 2 | `say` on channels, detecting changes | Reports in the channel *hafen* when the fog changes |
| **Händler** | 3 | Market commands, evaluating `fehler` | Posts offers when enough goods are there, and withdraws them in fog |

### Grüßer

```js
function schritt(sicht, merk) {
  const kannte = merk.kannte ?? [];
  const neu = sicht.raum.leute.filter((p) => !p.automat && !kannte.includes(p.name));
  return {
    tue: neu.slice(0, 2).map((p) => `say Willkommen in ${sicht.raum.name}, ${p.name}!`),
    merk: { kannte: sicht.raum.leute.map((p) => p.name) },
  };
}
```

### Strandläufer

```js
function schritt(sicht, merk) {
  const gut = sicht.raum.dinge.filter((d) => d.typ === "Flotsam");
  if (gut.length === 0) return { tue: [], merk };
  const nah = (d) => Math.abs(d.x - sicht.ich.x) + Math.abs(d.y - sicht.ich.y);
  const ziel = gut.sort((a, b) => nah(a) - nah(b))[0];
  if (nah(ziel) === 0) return { tue: [`get ${ziel.name}`], merk };
  return { tue: [`move ${ziel.x} ${ziel.y}`], merk };   // the server takes one step and finds the path
}
```

### Feuerwärter

```js
function schritt(sicht, merk) {
  const feuer = sicht.raum.feuer;
  const oel = sicht.ich.inventar.find((i) => i.name === "öl");
  if (feuer && feuer.stand < 0.25 && oel) return { tue: ["put öl in feuer"], merk };
  if (!oel) return { tue: ["say Mir geht das Öl aus."], merk: { ...merk, gewarnt: sicht.takt } };
  return { tue: [], merk };
}
```

### Bote

```js
// Route: from "Graue Bucht" to "Kontor" and back; carries driftwood.
const WEG = { "Graue Bucht": "nord", "Klippenpfad": "ost", "Kontor": null };
const ZURUECK = { "Kontor": "west", "Klippenpfad": "süd", "Graue Bucht": null };
function schritt(sicht, merk) {
  const traegt = sicht.ich.inventar.some((i) => i.name === "treibholz");
  const hin = traegt;
  const richtung = (hin ? WEG : ZURUECK)[sicht.raum.name];
  if (richtung) return { tue: [`go ${richtung}`], merk };
  if (hin) return { tue: ["drop treibholz"], merk };
  return { tue: ["get treibholz"], merk };
}
```

Nebelboje and Händler are given in full in the templates (`spaces-mmo/worlds/leuchtfeuer/automata/*.js`), only
described here.

### Templates are tested

Every template has **scenes**, like the cases of a codemode task: a fixed `sicht`, a `merk`, and the expected commands.

```js
// spaces-mmo/worlds/leuchtfeuer/automata/feuerwaerter.cases.js
[{ sicht: { raum: { feuer: { stand: 0.1 } }, ich: { inventar: [{ name: "öl", anzahl: 1 }] } }, erwartet: ["put öl in feuer"] },
 { sicht: { raum: { feuer: { stand: 0.9 } }, ich: { inventar: [{ name: "öl", anzahl: 1 }] } }, erwartet: [] }]
```

The tests run in the real sandbox (like `judgeInSlot`). A template that does not pass its scenes is not shipped.

## Language: German and English

Each user chooses the language (`de` or `en`, default by the interface). The examples in this document are the German
version.

- **Commands always work in both languages.** Every command has `key` and `aliases` (`go`/`gehe`, `get`/`nimm`,
  `say`/`sage`); no switch is needed, and automata, humans and agents can mix. Items are found by `name` and `aliases`
  (`get treibholz` and `get driftwood`).
- **Display names:** prototypes, items and rooms get `names: { de, en }` next to `name`. Output uses the language of the
  recipient; `name` remains the key and the fallback language.
- **Code per automaton:** the field `lang` on the automaton (`de`/`en`, set from the user's language on
  `automat vorlage`, changeable with `automat sprache en`) determines the names of the interface. The source is stored
  as it was written.

| German | English |
| --- | --- |
| `schritt(sicht, merk)` | `step(view, memo)` |
| `{ tue, merk }` | `{ do, memo }` |
| `sicht.takt`, `.ich`, `.raum`, `.hoerte`, `.fehler` | `view.tick`, `.me`, `.room`, `.heard`, `.error` |
| `raum.ausgaenge`, `.dinge`, `.leute`, `.feuer`, `.nebel` | `room.exits`, `.items`, `.people`, `.fire`, `.fog` |
| `ich.inventar`, `.oel`; `anzahl`, `richtung`, `ziel`, `stand`, `brennstoff` | `me.inventory`, `.oil`; `count`, `direction`, `target`, `level`, `fuel` |

The complete mapping is in a table `automata/keys.ts` (one source for worker, editor completion, reference articles and
assistant). The worker renames the keys of `sicht` before the call and renames the return value back after the call. The
sandbox sees only the names of the chosen language. `do` is a keyword in JavaScript but allowed as an object key;
templates use `{ do: [...] }` and never a variable `do`.

Unchanged in both languages: type identifiers (`Flotsam`, `Automaton`), command arguments that name items (both
languages are understood), and the JavaScript words (`if`, `const`, `return`). "Everything in German" therefore applies
to this interface, not to the language itself.

What must exist for both languages:

- **Templates:** a German and an English version of each template (`feuerwaerter.js`/`fire-keeper.js`) with the same
  scenes; a test runs both against the same scenes and compares the commands.
- **Help articles and error messages** in both languages (`help automat` and the reference in the editor show the
  user's language).
- **Assistant and rule builder:** write in the language of the automaton.
- **Model NPCs:** their automaton takes the language of the NPC (default `en`, because models write English code more
  reliably).

## Getting started without programming skills

Whoever has never programmed should still have an automaton of their own. There are four ways for this, which produce
the same `schritt` function; which one to choose is a matter of taste, and one can switch to the next at any time.

1. **Template with fields.** Every template names its adjusting screws (Feuerwärter: "add oil below [25] %", Bote:
   "goods [treibholz], from [Graue Bucht] to [Kontor]"). One fills in fields, the editor inserts them into the code.
   The fields are given as a comment line `// @param schwelle: Zahl 0..1 = 0.25` in the template, so the code remains
   the only source.
2. **Rule builder.** A list "If <condition>, then <command>", conditions and commands from selection lists that come from
   the schema of `sicht` and the command list of the `AutomatonCmdSet`. The rules are data and are translated to code;
   "Show as code" shows the result and leads to the code editor.
3. **Showing how.** `automat aufnehmen` remembers one's own commands (they are `Intent` entries in the Space),
   `automat aufnehmen ende` offers a routine from them ("These 4 commands in a loop?") and generates the code.
4. **Describing (assistant).** One writes in one sentence what the automaton should do. An agent generates `schritt`
   (see below). Part of this phase from the start, not only later.

In the code editor itself, a **completion from the schema** helps: `sicht.raum.` offers `dinge`, `leute`, `feuer`, `tue`
knows the allowed commands. Without a model, from a type declaration for `sicht`, which also feeds the reference "What
an automaton sees". The editor is CodeMirror 6 (new dependency, to be approved before it is built in; until then a
simple text field).

### Trial run against the past

The automaton worker keeps the last 20 `sicht` values per automaton in the `AutomatonLog` (lease 1 h). The trial run can
run the code against these real views and shows what it would have done, next to what the old code did. This is the test
bench for all four ways.

### Assistant: description to code

Flow like task and judge in codemode-chat: an agent writes, the sandbox checks.

```
Spielerin: "Bring Treibholz zum Kontor und warte bei Nebel"
Assistent (Agent, Prozess npc/assistant)
   1. schreibt schritt(sicht, merk) und 2-4 Szenen (sicht, erwartet) dazu
   2. lässt beides im Sandbox laufen (Grenzen wie oben); scheitert es, bekommt er die Fehlermeldung und
      versucht es erneut (höchstens 3 Versuche)
   3. liefert Code, Szenen und eine Erklärung in einem Satz je Block zurück
Spielerin: sieht Code + Probelauf, ändert oder übernimmt ("automat code übernehmen")
```

- The model runs only while writing. The finished automaton is an ordinary function and in operation costs only oil.
- Tokens: a quota of its own per account and day (like `CODEMODE_LLM_PER_DAY`/`_PER_MIN`, variable
  `SPACES_MMO_ASSISTANT_PER_DAY`), off by default (`SPACES_MMO_LLM=0`); the templates, the rule builder and showing how
  work without it.
- The assistant sees only the description, the reference articles, the templates and the code of the player's own
  automaton, never data of other players. Its result is never executed before the player has adopted it.
- Tests with scripted models (filter out system messages before checking the last message, see `docs/examples.en.md`); a
  live run only on explicit approval.

### Agents as owners of automata

Model NPCs (phase 5) may build and program automata, under the same rules as humans:

- The NPC is a figure with the `owner` role; the limit of 2 automata and the oil apply to it in the same way.
- It uses the same commands: `automat vorlage <name>`, then `automat code`, `automat probe`, `automat start`. There is no
  special access. The source (≤ 8,000 characters, also multi-line) is not in the command line but in the field `payload`
  of the `Intent` entry; the line stays `automat code`. The browser editor and agents use the same field, only the pure
  text mode needs the multi-line input mode.
- For writing, the same loop applies as for the assistant (write, trial run, improve), and the tokens count against the
  quota of the NPC (`SPACES_MMO_LLM`), not against that of a player.
- Against uncontrolled growth: at most 1 automaton per model NPC, one code change per 10 minutes (adjustable by the admin
  in the configuration window, see [Einstellungen für Betreiber](#settings-for-operators)), and the automata of an
  NPC carry the marker `von: "npc"` in the name and in `sicht`, so that players can tell them from human ones.

## Small help system

Three parts, one source:

1. **Help articles** in a file `spaces-mmo/worlds/leuchtfeuer/help/automaten.ts`, in the format of
   `codemode-chat/client/help/articles.ts` (`id`, `section`, `title`, `short`, `body` as Markdown with `{#anker}`). A
   loader script additionally writes them as `HelpEntry` entries into the Space, so that `help` in the game shows the
   same texts.
2. **In the game:** `help automat` (overview), `help automat sicht`, `help automat tue`, `help automat merk`,
   `help automat grenzen`, `help automat befehle`, `help automat vorlagen`. Short texts, each with an example.
3. **In the editor (browser):**
   - Next to the code a collapsible area "Referenz" with the same articles.
   - A "?" on every field and button (pattern `codemode-chat/client/HelpTip.tsx`).
   - **Trial run:** runs `schritt` against the scenes of the chosen template or against the current view of the player's
     own figure and shows which commands would result, without executing them. Error messages of the sandbox are
     translated into game language ("`sicht.raum.feuer` ist hier leer – in diesem Raum brennt kein Feuer").

Article list (kept small):

| id | Title |
| --- | --- |
| `help.automat.start` | Your first automaton in 3 minutes (adopt Grüßer, fill in oil, start) |
| `help.automat.sicht` | What an automaton sees |
| `help.automat.tue` | Returning commands, and which are allowed |
| `help.automat.merk` | Remembering something |
| `help.automat.grenzen` | Tick, time, memory, oil; what happens when it hangs |
| `help.automat.fehler` | Common errors and what they mean |
| `help.automat.vorlagen` | The example automata and in which order to read them |

## Commands

| Command | Effect |
| --- | --- |
| `automat vorlagen` | Lists the example automata |
| `automat vorlage <name>` | Loads a template into the editor of the player's own automaton |
| `automat zeige [<automat>]` | Shows code, oil level, status |
| `automat start` / `automat stop` | Starts or pauses |
| `automat log` | The last 20 lines: executed commands, errors, limit violations |
| `automat probe` | Trial run against the current view or the last 20 stored ones, without executing |
| `automat aufnehmen` / `automat aufnehmen ende` | Record one's own commands and generate a routine from them |
| `automat beschreibe <Satz>` | The assistant writes code for the description (quota) |
| `automat code [übernehmen]` | Sets the source; `übernehmen` takes the assistant's proposal |

The code itself is edited in the browser editor. In pure text mode this goes through a multi-line input mode (the
EvEditor equivalent).

## Settings for operators

**Status 2026-10-27: implemented** for the models and the limits that already exist (`client/AdminPanel.tsx`,
`server/settings.ts`, `tests/admin.test.ts`): an admin sees "Admin" in the header of the game (on the phone behind "⋯").
At the top are the **models**, as in the admin panel of codemode-chat and in the feed of the help system: model NPCs and
translation on/off, all models with credentials grouped by provider (one checkbox per provider, filter), plus the model
that is used; "Standard" returns to the newest model for `SPACES_MMO_LLM_MODEL` (otherwise Haiku). The list of models is
published by the model process as a `ModelInfo` entry, because only it has credentials. Model calls cannot be enabled
from the window: without `SPACES_MMO_LLM=1` in the `.env` they stay off, the window can only switch them off in
addition. Below that the **limits**:

| Field | Environment variable | Default |
| --- | --- | --- |
| Model calls per minute (all processes) | `SPACES_MMO_LLM_PER_MIN` | 20 |
| Model calls per day (all processes) | `SPACES_MMO_LLM_PER_DAY` | 500 |
| Translations per account and day | `SPACES_MMO_TRANSLATE_PER_DAY` | 200 |
| Translations per guest and day | `SPACES_MMO_TRANSLATE_GUEST_PER_DAY` | 20 |
| Awake model NPCs at the same time | `SPACES_MMO_NPC_MAX` | 10 |
| Model calls per NPC and world day (−1: the budget of the role) | `SPACES_MMO_NPC_BUDGET_DAY` | −1 |
| Typed commands at once per account | `SPACES_MMO_CMD_BURST` | 20 |
| Typed commands per second per account | `SPACES_MMO_CMD_PER_SEC` | 5 |
| Figures that always play (settlers fill up, [siedeln.en.md](siedeln.en.md)) | `SPACES_MMO_SETTLERS_MIN` | 30 |
| Points of an island for the village (epoch 2, [siedeln.en.md](siedeln.en.md)) | `SPACES_MMO_EPOCH_DORF` | 15 |
| Points of an island for the town (epoch 3) | `SPACES_MMO_EPOCH_STADT` | 40 |
| Points of an island for the network (epoch 4) | `SPACES_MMO_EPOCH_NETZ` | 80 |

Every process reads the `Setting` entries at most every `SPACES_MMO_SETTINGS_MS` (5 s). Still open from the draft below:
the fields of the automata and the assistant (which do not exist yet), the limits of the web process for requests and
guests, and the admin log.

Draft: the admin logs in in the browser and opens the **configuration window**. There the limits and quotas appear as
form fields with label, unit, default value and "?" help, no command needed. "Speichern" (save) writes them as
`Setting` entries into the Space; they thus survive restarts and apply on every process that uses the Space without a
restart (the processes read them at the next step or via `watch`).

Order of precedence: **stored value in the Space → environment variable (`.env`) → built-in default.** So the `.env`
supplies the initial values, the window overrides them; "Zurücksetzen" (reset) deletes the entry in the Space, and the
`.env` applies again. For each field the window shows where the value currently comes from.

| Field | Environment variable | Default |
| --- | --- | --- |
| Model NPCs allowed | `SPACES_MMO_LLM` | off |
| Assistant: runs per account and day | `SPACES_MMO_ASSISTANT_PER_DAY` | 10 |
| Model NPCs **awake** at the same time (maximum) | `SPACES_MMO_NPC_MAX` | 10 |
| Automata at the same time in the whole world (maximum) | `SPACES_MMO_AUTOMATA_MAX` | 100 |
| Code change of a model NPC: waiting time (minutes) | `SPACES_MMO_NPC_CODE_COOLDOWN_MIN` | 10 |
| Requests per minute and connection | `SPACES_MMO_REQ_PER_MIN` | 120 |
| Guests per hour | `SPACES_MMO_GUESTS_PER_HOUR` | 5 |
| Registrations per day | `SPACES_MMO_REGISTRATIONS_PER_DAY` | 20 |
| Lifetime of guests | `SPACES_MMO_GUEST_TTL_MS` | 7 days |

The maximums count the running figures; when the limit is reached, a further model NPC is not started and `automat start`
is rejected ("Die Welt ist voll, versuche es später"), and the window shows how many are currently running. The limits
per owner (2 automata, guests 1) are not affected.

Not in the window, only in the `.env`: everything that concerns the process itself (addresses, paths, `SPACES_MMO_SPACE`,
`SPACES_MMO_LISTEN`, `SPACES_MMO_DATA`) and all secrets (`SPACES_MMO_SETUP_TOKEN`, passwords). The window never shows or
stores a secret. Every change appears with who and when in the admin log.

Only an admin session may write (the same login as otherwise); the server checks type and limits of every field (a
waiting time under 1 minute or a quota above the maximum is rejected, the window shows the reason).

## Security and fairness

- Foreign code runs only in the automaton worker in the sandbox, never in the world or web process. The code is a data
  value that the wrapper executes by indirect `eval` (as in `judge.ts`); builtins that the wrapper relies on are secured
  beforehand.
- Automata are subject to the same locks and quotas as their owner, but do not count as humans (`automat: true` in every
  view). A room can lock out automata (lock `enter:not automaton()`).
- Against farming: flotsam is spawned in limited amounts per room and tick; automata have a small delay on `get`
  compared to humans (one tick).
- Reputation through automata counts half.

## Acceptance

- All six templates pass their scenes in the real sandbox.
- A Strandläufer and a human grabbing the same driftwood at the same time: exactly one gets it, the other sees the error
  message (automaton in `sicht.fehler`).
- An automaton with an infinite loop stops after 5 steps, without delaying other automata.
- A restart of the automaton worker: all running automata continue with their `merk`.
- `help automat` in the game and the reference in the editor show the same text (a test compares both outputs).
- An assistant run with a scripted model delivers code that passes its own scenes; a run that fails three times delivers
  no code and consumes only the quota, not the owner slot.
- A model NPC builds an automaton through the same commands; the second is rejected (1 per NPC), as is a code change
  within the configured waiting time; a waiting time changed and saved in the window applies from the next attempt and
  continues after a restart.
- A human without code gets to a running automaton via template + fields (a test plays through the path).
- The same template in `de` and `en` passes the same scenes and yields the same commands; an automaton with
  `lang: "en"` sees only English keys (the test accesses `sicht.raum` and gets `undefined`).
- Two users in different languages play in the same room; each sees rooms, items and help in their language, and
  `get treibholz` and `get driftwood` find the same item.
