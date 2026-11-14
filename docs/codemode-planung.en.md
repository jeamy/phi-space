# Codemode chat: planning bots, after the JEPA experiments (plan)

Status (2026-11-13): plan only, nothing built. It extends the bot lane (B in
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
would need Python or ONNX, weights that are not published and a GPU that neither big nor nano has (step 6).

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
   - The test that no hidden episode lies on a sample path waits for step 2, where paths are recorded.
2. **Paths on the map.** The arena's `map`, paths in `BotEpisode`, the room map with paths.
3. **Memory.** `PlanMemory`, `MemoryFreeze`, `recall`, the coverage figure and the memory view.
4. **Subgoals.** The board role, `Subgoals`, the `subgoals` tool, the subgoal chain, and the task "Light the fire of
   Anleger".
5. **Harness task "Rate planners".**
6. **A learned world model (only with a decision).** A process of its own, like the model process. It takes
   `Predict` entries and writes the answers, and the judge only replays recorded ones, as for Jev. It needs a new
   dependency (Python or ONNX), weights and probably a GPU. It pays off only if the arena turns out too slow for
   planners that roll out many sequences.

## Tests

- `spaces-mmo/tests/arena.test.ts`: `start`, `seed`, `setup`, `map`, `hold`; the same seed gives the same world after
  a wait.
- `codemode-chat/tests/bots.test.ts` with `tests/fake-arena.ts`: episodes and seeds in the verdict, the holdout
  without paths, the same verdict on two judges, `recall` answering from the freeze and not from later paths, coverage.
- A test that a hidden episode never lies on a sample path, run over every planning task in the catalog.
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
| Retention | best of each generation + newest 50 | Enough for the curve, the matrix and the map. |

Still open: step 6 at all.
