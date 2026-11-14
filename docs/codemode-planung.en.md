# Codemode chat: planning bots, after the JEPA experiments (plan)

Status (2026-11-14): steps 1 to 7 built; the account for an article is [codemode-planning-article.en.md](codemode-planning-article.en.md). It extends the bot lane (B in
[codemode-anwendungen.en.md](codemode-anwendungen.en.md)) and the eval harnesses (C there). It needs no new
dependency and no model call in the judge.

## Source

The plan follows Haddy Alchaer's blog post "After 600 experiments, here's what I discovered about JEPA world models"
(haddyalchaer.com/jepa, November 2026). The figures below are the post's own; it links no code, and nothing of it was
run here.

The post studies LeWM (LeWorldModel, Maes et al., 2026), a JEPA world model, on Push-T, where a robot pushes a T-shaped
block onto a target. A JEPA world model has three parts. An encoder turns a frame into an embedding. A predictor
predicts the next embedding from the current one and an action. A planner rolls hundreds of action sequences through
the predictor and keeps the one that ends nearest the goal's embedding.

What it finds, without training anything new:

- **The model is not the limit, the horizon is.** With the simulator's exact physics in place of the predictor the
  results barely change (78 % against 77 %). Goals 25 steps away are reached about 90 % of the time, goals 75 steps
  away 22 % of the time (42 % with exact physics).
- **Subgoals** every 25 steps: 22 % → 80 %. The subgoals came from an expert demonstration.
- **A memory graph** of about 460,000 demonstration states, linked in time and by nearness. A cost on every jump
  from one demonstration to another raised success from 62 % to 85 %.
- **Transformed segments** (shifted, rotated, mirrored) fill gaps in the memory. With the states near the goal deleted,
  success fell from 93 % to 32 % and came back to 85 % with the fills.
- **Scoring only what matters** (the block, not the pusher): exact physics went from 9 to 39 of 50 hard tasks.
- **The usual evaluation flatters.** 84 % of the standard goals had a near-identical state in the memory. 68 % on the
  official 50 episodes became 44 % on 250 fresh ones. Changing the planner's seed alone flipped 38 of 250 episodes.
  The harder test pairs start and goal from different demonstrations and wants the goal held for the last 10 steps.
  The best planner reaches 56 % there.
- **Open:** who proposes subgoals beyond the demonstrations, and goals as sets of acceptable end states instead of one
  image.

## What carries over

Codemode already has what the post had to build around its model. The arena is an exact simulator: the world clock
stands still unless a bot waits, and every contribution gets a world of its own. Bot goals are predicates checked by
the arena (`beacon:feuer-bucht`, `feed:feuer-bucht:6`), which is what the post asks for in place of a goal image.

What the post shows applies to the bots without any neural network:

| From the post | In codemode |
|---|---|
| The horizon is the limit | Goals several rooms away, not one walk on the spawn's beach |
| Subgoals | A board role that proposes subgoals; the bot follows them one by one |
| Memory graph with a jump cost | Paths of earlier bots in the space, offered to a bot through a `recall` tool |
| Scoring what matters | Goals stay predicates over the world, never "the figure stands on cell x, y" |
| Evaluation flatters | Hidden start/goal pairs, several seeds, the goal held for a while, coverage reported |
| Model agents are not in the post | Model agents propose the subgoals and write the bots; the post's open question is their job |

What does not carry over: a learned predictor. The judge needs none, since the arena is exact. A neural JEPA model
would need Python or ONNX, weights that are not published and a GPU that neither big nor nano has. Nor would it help a
bot find its way in a world it has not seen: step 6 tests that with made islands instead.

## Entries

| Entry | Written by | Purpose |
|---|---|---|
| `BotEpisode` | the judge, in the verdict's transaction | One episode of one contribution: episode id, seed, sample or holdout, reached, points, the subgoals reached, the path as room-and-cell steps (capped, see below). Holdout episodes keep no path and no subgoals. |
| `PlanMemory` | the judge, after a sample episode was reached | One path that reached a goal: task, start, goal, the steps, author, generation. Only sample episodes go in, never holdout ones. |
| `MemoryFreeze` | the run, at each generation's start | The `PlanMemory` revision that generation's bots may recall. A candidate carries the freeze it was written under, and the judge answers `recall` from that freeze only. |
| `Subgoals` | a board agent | A list of subgoals as data (`[{ room, near?: {x, y}, holds?: predicate }]`) with the plan it belongs to. |

A path is a list of `[room, x, y]` for each cell where the figure changed room or direction, at most 200 steps
(`move x y` walks the whole way, so most bots need few). Longer paths keep every n-th step and the last one, and say
so. `BotEpisode` entries are kept for the best contribution of each generation and the newest 50 others. The rest go
with the run's retention, as `CodeCandidate` entries do.

## The arena (spaces-mmo side)

- `open` takes `{ start?: { room, x, y }, seed?, setup? }`. `start` places the guest (today: always the spawn cell),
  `seed` seeds the world's chance (`withSource(seeded(seed, clock), …)`, server/engine/source.ts), `setup` puts named
  fixtures in place (driftwood here, the fire out there). Without them it behaves as today.
- `map { room }` returns a room's ground and decor rows, its exits and fires, and its place on the atlas. That is the
  geometry the page draws (below); codemode imports nothing from spaces-mmo.
- `score` stays a predicate and gains `hold { goal, minutes }`: the judge waits the world on by that much and asks
  again. This is the post's "on target for the last 10 steps".
- Game changes go into Rust and TypeScript in the same commit (as for every game change since 2026-11-11), when the
  arena's world worker is the Rust one.

## The judge

**Episodes.** A planning task brings a set of episodes. An episode is a start, a goal predicate, a setup and a seed.
Some are shown (the sample), the rest are hidden (the holdout), as for tools tasks.

- A hidden episode's start and goal never both lie on one path of the sample. The task checks this when it is written,
  not the judge.
- An episode runs with one seed when the task allows no `wait`, with three when it does. The clock stands still unless
  a bot waits, so without waiting the world is the same for every seed and a second seed only costs time; chance (tide,
  storm, wind) comes only after a wait. An episode counts as reached only when every seed reaches it. The post's 38 of
  250 flips are the reason for the three.
- The verdict is the holdout's share of reached episodes, then points, then time. A contribution that reaches no
  sample episode is not run on the holdout.
- Of a hidden episode the verdict says only reached or not, as for the hidden implementations of a harness task.

**Coverage.** For each hidden episode the judge reports whether the frozen memory already holds a path from a cell
near its start to its goal. The share is shown next to the score as "covered by the memory". A high score with a high
coverage means the bots recall; with a low coverage it means they plan. The post's 84 % is this figure.

**Tools in the sandbox:** `look`, `act`, `wait` as today, and new:

| Tool | What it does | Cost |
|---|---|---|
| `recall({ goal, from? })` | From the frozen memory: the path from the nearest remembered cell to a state where `goal` held, the distance to that cell, and how many jumps between paths it needs. Each jump costs extra in the ranking of paths. | 1 point |
| `subgoals()` | The `Subgoals` the contribution's plan named, or none. | 0 |

**Determinism.** The same contribution gets the same verdict on every judge: fixed seeds, the frozen memory and the
standing clock. A test judges it twice, on two judges.

## The agents

- **A subgoal role on the board.** In the planning phase one agent writes a `Subgoals` entry for the plan: the rooms
  and conditions to pass on the way, as data. The implementation writes a bot that walks them in turn. Critique sees
  the episode matrix (below) as text: which subgoal broke in which episode.
- **Generations learn from the memory.** Each generation's bots can recall the paths of the generations before. The
  freeze keeps a bot from recalling its own judging.
- **Scripted agents** do the same in the tests, with no model call, as for the other tasks.

## Tasks

- **First:** "Light the fire of Anleger". It lies behind fog, rooms away from the spawn, so a bot needs subgoals: the
  ferry or a path, driftwood on the way, the fire. Episodes vary the start room and where the driftwood lies.
- **Then:** goals as sets ("any fire of the island burns"), and goals against the usual direction (from the fire back
  to the harbour with something in the pack). The post's remaining failures were of this kind.
- **Harness task (C):** "Rate planners". Good and bad bots come with the task: one without subgoals, one that only
  replays the memory, one that holds the goal for no time at all, one that only works with one seed. A harness ranks
  them right only if it runs fresh episodes and several seeds. This turns the post's evaluation lessons into a task.

## Showing the progress

All of it is drawn by the page in SVG from the snapshot, with no chart library. It sits on the run card and in a
contribution's panel, beside the tiles, lineage and trace that exist today.

1. **Progress curve** (run card). Per generation, the holdout share of reached episodes of the generation's best, with
   a band from the worst to the best seed. A second line shows the coverage. When the score rises and the coverage
   does not, the bots learned to plan. When both rise together, they learned to recall. Below it the best's points.
2. **Episode matrix** (run card, unfolded). Rows: the best contribution of each generation. Columns: the episodes,
   sample then holdout, grouped by goal. A cell is green when all seeds reached it, half when some did, red when none
   did. A column that stays red down all generations is a goal nobody reaches; that is where a new subgoal or task is
   needed.
3. **Room map with paths** (contribution panel). The room's ground from the arena's `map`, the episode's path as a
   line, its subgoals as numbered marks (filled when reached), the cells where the goal holds shaded. A path that stops
   short ends in a cross. Several rooms are drawn on the atlas, side by side as on the game's minimap. Sample episodes
   only; holdout ones have no path.
4. **Memory view** (run card). The same atlas with every remembered path, coloured by generation, and the jumps that
   recalled paths make between them as dashed lines. Hidden goals are drawn as rings: filled when the memory covers
   them. It shows how far the memory reaches and where it does not.
5. **Subgoal chain** (lineage). For each step of a contribution's lineage, its subgoals as a row of marks, one per
   subgoal, with the share of episodes that got past it. A chain that always breaks at the same mark shows where to
   work.

The progress curve and the episode matrix come with step 1, the rest with the steps that bring their data.

## Steps

1. **Evaluation.** Episodes with sample and holdout, seeds (1 or 3), `hold`, the arena's `start`/`seed`/`setup`,
   `BotEpisode` entries, the progress curve and the episode matrix. The two existing bot tasks get episodes of their
   own (other start cells, other driftwood).

   *Done 2026-11-14*, with these differences:
   - A new task "Island bot" (`beacon-insel`, `codemode-chat/server/island.ts`) carries the episodes; the two existing
     bot tasks are unchanged. Its nine episodes start on the eight rooms of the Graue Insel, the one piece of driftwood
     lies elsewhere each time (the arena's `setup` clears every fuel first), and the fire must hold 5 world minutes. It
     allows no `wait`, so one seed per episode.
   - The episodes' results are kept in the verdict (`Verdict.episodes`, carried into the `CodeScore` entry and the
     snapshot), not as `BotEpisode` entries. Those come in step 2, when they carry paths.
   - The time limit is 30 s per episode, not 60: the scripted variants need 3 to 7 s an episode in the real arena.
   - A seed narrows the world but does not fix it after a wait: the world's ticks draw at moments of real time, so the
     same seed gave the same world once and another world the next time. The world worker takes `SPACES_MMO_SEED`
     (`server/world-host.ts`), the arena passes `open`'s `seed` to it; a task with `wait` may still see two seeds
     disagree on the same contribution. Fixing that needs ticks counted in world time, not real time.
   - The test that no hidden episode lies on a sample path waits for step 2, where paths are recorded (done there).
2. **Paths on the map.** The arena's `map`, paths in `BotEpisode`, the room map with paths.

   *Done 2026-11-14:*
   - The arena records every cell the figure goes over (a `move` as the shortest walk around fires, a change of room as
     the walk to the exit and the cell it arrives on), and `path { world }` gives the start, the turns and the room
     changes, at most 200 steps. `map { room }` needs no world and adds a `rev` that changes with the geometry.
   - The judge asks `path` for the first seed of each sample episode, before its own `hold` wait, and `map` for the
     rooms those paths cross (remembered for 10 minutes). `judge-host.ts` writes one `BotEpisode` entry per sample path
     in the verdict's transaction (`episode`, `reached`, `cost`, `path`, `cut`); the `CodeScore` entry keeps no path.
     The rooms become `BotRoom` entries (`world`, `room`, `rev`, `geo`), one per room, after the commit.
   - Retention is simpler than the table below: a `BotEpisode` carries its block and the verdict's lease and goes
     when the block is deleted, like `CodeScore` (at most 1000 contributions a room, three sample paths each). Picking
     the best of each generation is only worth it if rooms grow beyond that.
   - The contribution's panel draws the rooms on the atlas, every sample path in its own colour from its start (a dot
     with the episode's id) to its end (✕ when the goal was missed), the fire ringed, the episode's driftwood a square;
     a chip shows one episode alone. The snapshot's task carries the sample episodes' start and items for these marks.
   - The test that no hidden episode lies on a sample path runs over the catalog: a hidden piece of driftwood is never
     within 3 cells of a sample start or piece, and on the island no sample's shortest way enters a room a hidden piece
     lies in.
3. **Memory.** `PlanMemory`, `MemoryFreeze`, `recall`, the coverage figure and the memory view.

   *Done 2026-11-14* (`codemode-chat/server/memory.ts`):
   - A second island task, "Island bot with memory" (`beacon-insel-memory`), has the same episodes and `bot.memory`;
     the plain island task stays without, so the two curves can be compared.
   - `judge-host.ts` writes a `PlanMemory` entry for every sample path reached with every seed (not cut), once per
     path and block (its id is a hash of goal and path), at most 300 a block, the oldest giving way. Hidden episodes
     never go in.
   - The run writes a `MemoryFreeze` when a generation begins (`<runId>-g<gen>`, the ids of the block's paths), and a
     candidate carries the freeze it was written under. One handed in by hand or on the work board gets a freeze of
     its own, of the memory as it stands. The judge reads the freeze's paths before judging and answers `recall` from
     them only.
   - `recall({ goal?, from? })` starts at the remembered cell nearest to the figure (or `from`) in its room and takes the
     cheapest way from there to the end of a path: along a path cell by cell, a room change counting 1, a jump to
     another path within 3 cells counting 10 cells plus the distance. It answers `from`, `distance`, `steps`, `jumps`
     and `cost`; the steps are walkable with `move x y` (a step onto an exit changes the room). 1 point.
   - Coverage is the share of hidden episodes whose start is within 3 cells of a remembered way to the goal. It is in
     the verdict and drawn as a dotted line in the progress curve. In the real arena the first generation covers
     nothing, every later one H6 (it starts 3 cells from where S3's driftwood lay), 1 of 6.
   - The memory view (run card, loaded when unfolded) draws every remembered path on the atlas in a blue ramp by
     generation and the jumps recall took (kept with the sample paths' `BotEpisode` entries) dashed. Hidden goals are
     not drawn as rings: the goal of the island tasks is the fire, the same for every episode, and drawing the hidden
     starts would show them; the coverage line says what the rings would.
   - The scripted variants: the explorer (never recalls), one that searches the driftwood and then recalls the way to
     the fire (correct, more points: it walks the remembered turns one `move` at a time), one that only replays the
     memory from its start (nothing in the first generation, then the three shown episodes and no hidden one), one
     without wood.
4. **Subgoals.** The board role, `Subgoals`, the `subgoals` tool, the subgoal chain, and the task "Light the fire of
   Anleger".

   *Done 2026-11-14* (`codemode-chat/server/subgoals.ts`):
   - A subgoal is `{ room?, near?: { x, y }, holds? }`: the figure in `room` (any room without one), within 3 cells of
     `near`, and `holds` true: a goal as `score` takes it (`beacon:<id>`, `feed:<id>:<n>`) or the new `pack:<proto>`.
     It names a room or a predicate; at most 12 a plan. The room is optional, unlike the entry's sketch above: "carry
     driftwood" belongs to no room.
   - The arena's `open` takes `subgoals` and checks them as it does a start; after `open`, every `act` and `wait` it
     marks the next one when it holds (several at once when they all do), and `path` gives the cells where each was
     reached. The judge hands them over only for a sample episode's first seed, the one whose path is kept: hidden
     episodes run without them and keep none.
   - `Subgoals { session, blockId, runId, proposalId, author, via, subgoals }` belongs to the plan with the same
     `proposalId` (a `CodeProposal`). On the work board the planning round's `propose` asks a task with subgoals for a
     ```` ```subgoals ```` block (a JSON list) after the plan; the run writes it when it is valid, and the implementing
     contributions follow it by their lineage's `proposalId`. In a run of generations every turn plans first: a model
     agent with the same `propose` call, a scripted one with one of the task's plans (`bot.plans`), and the turn's
     contribution follows that plan. So scripted agents plan in the tests without opening the board to them.
   - `subgoals()` gives the bot its plan's subgoals for 0 points. The judge host reads them by the candidate's
     `proposalId`. A sample episode reports `subgoals` (how many its first seed reached in turn) in the verdict, and its
     `BotEpisode` entry also has `subgoalAt`, the cells. The case line reads "subgoals 1 of 3, stuck before 2 (in
     duenen, pack:treibholz holds)": that is how critique sees which subgoal broke in which episode.
   - The task "Light the fire of Anleger" (`beacon-anleger`) has nine episodes: the figure starts elsewhere on the
     Graue Insel each time and the driftwood lies in another room. The Feuerkorb at 7,5 must hold 5 world minutes. The
     prompt keeps the island's map. Fog does not block the way there: the way toward a fire that covers a room stays
     open. It does block a search for wood away from it.
   - Its scripted plans: one that searches the island for the wood (4 subgoals), one that expects it in the Dünen, and
     one that goes to the fire first. Its variants: a follower that walks the plan's subgoals, a searcher that ignores
     the plan, and one without wood. Results in the real arena:

     | Variant and plan | Result | Points |
     |---|---|---|
     | Follower, search plan | 9/9 | 152 |
     | Follower, Dünen plan | 1/9; S2 and S3 stuck before subgoal 1 | — |
     | Follower, fire first | 9/9 | 195 |
     | Searcher | 9/9 | 141 |
   - View 5: the lineage of a contribution that followed subgoals shows a row of marks, one per subgoal, filled as far
     as the share of sample episodes that got past it. Contributions of scripted agents now open their lineage too,
     when they followed a plan. The panel's map draws each reached subgoal as a numbered mark in the path's colour. A
     ring marks the plan's cell, where a subgoal names one.
   - A fire gone out lets dense fog close the ways that lead away from it. The arena test of step 2 crossed into the
     next room after the judge's hold had let the fire go out, and failed whenever the fog was dense. It now crosses
     before the hold.
5. **Harness task "Rate planners".**

   *Done 2026-11-14* (`harness-planners`, `codemode-chat/server/toyisland.ts`), with one difference: the bots do not
   play in the arena but on a copy of the Graue Insel in the judge.
   - **Why not the arena.** A harness plays each bot dozens of times. In the arena every world costs seconds to start,
     so a verdict would take minutes. A seed also does not fix the arena's world after a wait (step 1), and the bot
     that only works with one seed would be judged differently from one judge to the next.
   - **The toy island.** It has the island's rooms and exits, every room 24 × 16 cells of ground, the fire of the
     Graue Bucht at 9,10, and the same commands as the arena (`move`, exit names, `nimm treibholz`,
     `lege holz ins feuer`). A piece of driftwood burns 10 world minutes. The seed decides where the tide washes a
     piece up after every hour waited: with seeds 0 and 1 beside the fire, with every other seed in another room. The
     same episode and seed give the same world on every judge, and the task needs no arena, so every judge takes it.
   - **The harness's `run`.** `HarnessSpec.world: "island"` turns `run` into
     `{ start, wood, seed?, hold? } → { reached, points }`: one episode of the bot under test, in a fresh toy world
     and a fresh sandbox. A bot that throws or runs past 3 s did not reach it; an invalid episode answers `{ error }`.
     The rest is the harness judge as for "rate sort functions": every good bot must score strictly higher than every
     bad one, the hidden ones show only "ordered right" or "ordered wrong", and points count the shown bots.
   - **The bots.** Each bad bot reaches the three shown episodes of the island task with seed 0 and no hold, so only
     a careful harness catches it:

     | Bad bot (shown) | Caught by |
     |---|---|
     | Knows the shown episodes by heart (the memory lesson) | fresh episodes |
     | Looks only in its start room and the rooms next to it (no subgoals) | wood far from the start |
     | Lets the fire go out right after feeding it (waits 9 minutes) | a `hold` |
     | Waits for the tide where it lands with seed 0 | several seeds |

     The good ones are the reference (searches the whole island) and two hidden ones (a careful searcher, one
     searching in another order). The hidden bad ones fail more narrowly: one searches two rooms deep, one waits 7
     minutes, and one takes whatever the tide brings to the Graue Bucht (it fails only with seeds from 2 on).
   - **Scripted harnesses.** Two are correct: every start room with the wood in the room farthest from it, three
     seeds and `hold: 5` (24 runs a bot); and the same with one seed per start, cycling 0, 1, 2 (8 runs, cheaper).
     Four are blind, each to one lesson: shown episodes only, one seed, no hold, wood always in the start room. Each
     misranks exactly the bot of its lesson; the tests check this, and that the same verdict comes out twice.
6. **New worlds (made islands).**

   *Done 2026-11-14* (`beacon-neuland`, `codemode-chat/server/toyisland.ts`, `toyarena.ts`, `neuland.ts`,
   `explorer.ts`). This step replaces the learned world model planned here before.
   - **Why no learned model.** A bot has to find its way on islands it has never seen. A model trained on the Graue
     Insel learns that island: its rooms, its exits, where its fire stands. On a new island this is the same mistake
     as a bot that carries the Graue Insel's map. What carries over to a new world is a way of searching: look,
     remember what was seen, plan over that. Agents write it as code, and the judge's simulator is exact, so it needs
     no prediction. A learned predictor would pay off only for planners that roll out many sequences in a world too
     slow to simulate. The toy islands are not slow.
   - **Made islands.** `genIsland(n)` makes island "Neuland n" (0 to 999999) from its number with a small fixed
     generator, so every judge gets the same island:
     - 5 to 8 rooms grown from one on a 4 × 3 grid, and further links with chance 0.3, so some islands have loops;
     - room names shuffled from a list, room ids `n<n>-<k>`;
     - exits nord, ost, süd, west, each leading to the grid neighbour, with the opposite exit leading back;
     - one fire, the Leuchtfeuer;
     - an episode of its own: the start is one of the two rooms farthest from the fire, and the driftwood lies in
       another room.

     As on the Graue Insel, the tide lays a piece beside the fire with seeds 0 and 1 (west and east of it), and
     somewhere else with every other seed.
   - **Played in the judge.** `toyarena.ts` answers the arena's JSON-line protocol (`open`, `look`, `act`, `wait`,
     `path`, `score`, `map`, `close`) over toy islands in the judge's own process. `open` takes the episode's `island`,
     and the goal `beacon:island` is that island's fire. A planning task with `bot.toy` is judged there:
     - `needsArena` is false for it;
     - it takes the code lane;
     - it is offered without `CODEMODE_ARENA`, and every judge takes it.

     ▶ still does not run bots.
   - **The task "New islands".** The prompt names no map. It says what every made island has (5 to 8 rooms, the four
     exits, one fire) and that `look` shows a room only once the figure stands in it. The three shown episodes lie on
     Neuland 1, 2 and 3. The six hidden ones lie on Neuland 4 to 9, which no shown episode enters, so no hidden island
     ever reaches a prompt. No wait, `hold: 5`. The scripted variants:

     | Variant | Reached | Points |
     |---|---|---|
     | Explorer: depth first, takes the wood where it sees it, feeds the fire over the exits it crossed as soon as it knows both | 9/9 | 163 |
     | Surveyor: explores the whole island, then plans | 9/9 | 355 |
     | The Graue Insel's map (the island task's searcher) | 0/9 | 6 |
     | The three shown islands by heart | 3/9 (none hidden) | 36 |
     | Walks without a memory: the first exit it did not come in by | 5/9 (fails S1) | 315 |
     | No wood | 0/9 | 55 |
   - **The atlas.** Rooms are grouped by their `island` and laid out island under island, each with its own grid
     place and its name above it. A single island keeps the layout it had.
   - **"Rate planners" on new worlds.** The harness's `run` also takes `island` (start and wood may then be left out:
     the island's own episode), and the bot must now work on any made island too. The changes:
     - The reference is the explorer.
     - The bad bots are mapless where their lesson is not the map, so each still fails only by its lesson: the near
       searcher looks at most one room deep for the wood, then explores on for the fire.
     - A fifth shown bad bot knows only the Graue Insel's map. It is step 5's reference.
     - The hidden good ones are the surveyor and an explorer that takes the exits in the other order.
     - The hidden bad ones are an explorer two rooms deep, one that waits 7 minutes, a tide waiter that takes whatever
       lies in the fire's room, and the reverse searcher with the Graue Insel's map.
     - The two correct harnesses add Neuland 11, 12 and 13 with their own episodes: 33 runs a bot, and 11 for the
       cheaper one.
     - A seventh, blind harness plays only the Graue Insel and misranks exactly the map bot. The shown-only harness
       now also passes it.
     - The time limit is 60 s, since the 33 runs take about 15 s alone.
   - **Counter-check in the real arena.** The mapless bots know no island, so they also play the real Graue Insel. The real
     arena has other fires as well and exits other than the four directions; the bots take only the compass exits,
     feed only the fire named Leuchtfeuer, and do not count an exit that left them where they were. On the island
     task's nine episodes in the real arena, the explorer reached 9/9 with 111 points and the surveyor 9/9 with 399.
     Neither knows the Graue Insel's map.

7. **A world model from observations (the tide).**

   *Done 2026-11-14* (`tide-law`, `codemode-chat/server/tides.ts`, the law in `toyisland.ts`). Step 6 replaced a
   learned model by exact rules a bot can see. This step adds a dynamic the bot cannot see and nobody tells: the tide.
   The bot learns it from data the judge collected, which is the part of a JEPA world model step 6 left out.
   - **The law.** On a made island the tide washes up one piece an hour, in the island's dead ends in turn, by their
     number. A dead end is a room with one exit, the fire's room left out. Each piece lands 3 cells in from the room's
     exit. The first piece lands at minute 30 + 10·(seed mod 3), the j-th 60·j minutes later. The law is the same on
     every island and speaks only of an island's shape, so it carries over to islands no episode showed.
   - **The rules** (`TIDE_RULES`, only for this task; steps 5 and 6 keep theirs):
     - an exit takes 5 world minutes;
     - a washed-up piece lies 30 minutes, then the sea takes it back;
     - the day ends after 480 minutes;
     - the goal is `feed:island:3`, three pieces put into the island's fire by the bot.

     Time now passes when the bot walks, so a wrong guess costs pieces, not only points.
   - **Observations.** In every sample episode, all three seeds, the toy arena logs each landing: island, seed,
     piece, minute, room, cell, the room's exits and its distance from the fire. These are the facts a learner needs,
     not the law. They go into the block's memory as `PlanMemory` entries with goal `tide` (once each, reached or
     not), frozen per generation as the paths of step 3 are. A bot reads its freeze with `observations()` (1 point).
     Hidden episodes log nothing. Its verdict entry carries no observations.
   - **The task "Learn the tide".** The episodes start on Neuland 21, 23 and 26 (shown) and 28 to 33 (hidden). Each
     of these islands has at least two dead ends. There is no driftwood at the start, and every episode runs with
     3 seeds. The prompt describes the rules and the observations, not the law. The scripted variants (judged in the
     judge, no arena):

     | Variant | Reached | Points |
     |---|---|---|
     | The law in code (as an agent would write it after reading the observations), calibrated | 9/9 | 2253 |
     | The learner: fits a small hypothesis space to the frozen observations (one exit? away from the fire? order by number up or down? how far in? which minutes?), then plays that model | 9/9 with observations (2280), 6/9 without (it falls back to the searcher) | |
     | The law without calibration: assumes minute 30 always | 0/9 | |
     | The observed rooms by their id | 3/9 with observations (the shown islands only), 0/9 without | |
     | No model: tours the island again and again | 6/9 | 4603 |
     | Waits by the fire | 0/9 | |

     On a server the learner fails while the memory is empty and reaches 9/9 once a verdict's observations are in it
     (`tests/bots.test.ts`).
   - **What is learned where.** The model of the tide can be learned by the bot from data at run time (the learner),
     or by an agent who reads the observations and writes the law as code (the law bot). The scripted agents of the
     tests do not learn; they are fixed hypotheses. Model agents could do the second, but that costs tokens and has not
     been run.

## Tests

- `spaces-mmo/tests/arena.test.ts`: `start`, `seed`, `setup`, `map`, `hold`; the same seed gives the same world after
  a wait.
- `codemode-chat/tests/bots.test.ts` with `tests/fake-arena.ts`: episodes and seeds in the verdict, the holdout
  without paths, the same verdict on two judges, `recall` answering from the freeze and not from later paths, coverage.
- A test that a hidden episode never lies on a sample path, run over every planning task in the catalog (step 2,
  `tests/bots.test.ts`).
- The page: the snapshot carries the curve's and matrix's figures; a test checks them against the `BotEpisode` entries.

## Values (decided 2026-11-13)

A clickable mockup of the views, with example data on the real map of the Graue Insel, computes with these values.

| Point | Value | Why |
|---|---|---|
| Episodes per task | 3 sample + 6 hidden | Three visible ones are enough to work on a path; six hidden ones make learning by heart expensive. The hidden ones run only when at least one sample episode was reached. |
| Seeds per episode | 1 without `wait`, 3 with `wait` | See the judge above. |
| Worlds per contribution | at most 9 or 27 | Episodes times seeds, fewer when the sample fails. Every one is an arena world of its own. |
| Arena worlds at a time | 2, later 4 | `SPACES_MMO_ARENA_WORLDS`; raised only after the memory of one arena world is measured. |
| Time limit | 60 s per episode (30 s for the island bot) | As for the beacon bot today. The judge's lease must cover all episodes of a contribution. |
| `hold` | 5 world minutes | A piece of driftwood burns 10 world minutes (`fire.fuel` in world.json); 5 check that the goal holds without asking for a second piece. The judge waits with the episode's fixed seed. |
| `recall` | two variants of one task | "With memory" and "without", the same episodes. The distance between their curves measures what the memory brings. |
| Cost of `recall` | 1 point; a jump counts as 10 cells | Like every tool one point. When paths are chained, each jump from one remembered path to another counts as 10 cells of detour. |
| "Near" for coverage | same room, at most 3 cells | Manhattan distance; a bot walks with `move x y`, and 3 cells are a short step. |
| Freeze | at the start of every generation | A contribution sees only the paths of earlier generations. |
| Path in `BotEpisode` | at most 200 steps | Only room and direction changes. |
| Retention | with the block (step 2), see there | Planned: best of each generation + newest 50. Step 2 keeps every sample path as long as its verdict, which the room cap already bounds. |

Step 6 needs no learned model (see there). Step 7 learns one dynamic, the tide, as code and data. The account for an article is [codemode-planning-article.en.md](codemode-planning-article.en.md).
