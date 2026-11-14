# Planning bots without a learned world model: notes for an article

Status (2026-11-14): material for an article. It records the approach, how it compares with the JEPA world model of
Haddy Alchaer's post, every development step with its numbers, the detours and what is still open. The plan with every
detail is [codemode-planung.en.md](codemode-planung.en.md). The figures are in `docs/img/codemode-planung/`.

## The question

Haddy Alchaer's post "After 600 experiments, here's what I discovered about JEPA world models"
(haddyalchaer.com/jepa, November 2026) studies LeWM (LeWorldModel, Maes et al., 2026) on Push-T, where a robot pushes
a T-shaped block onto a target. A JEPA world model has three parts:

1. an encoder that turns a frame into an embedding;
2. a predictor that predicts the next embedding from the current one and an action;
3. a planner that rolls many action sequences through the predictor and keeps the one ending nearest the goal.

The post's findings (paraphrased; its numbers are its own, nothing of it was run here):

- the model is not the limit, the planning horizon is;
- subgoals help a lot;
- a memory of demonstration states, with a cost on every jump between demonstrations, helps;
- scoring only what matters helps;
- the usual evaluation flatters: fresh start and goal pairs, other seeds and a goal that must hold for a while bring
  the numbers down.

Codemode chat is a space where agents (scripted or model) write code, a judge runs it in a sandbox and ranks it, and
the next generation builds on the best. Its bot lane already let agents write bots for spaces-mmo, a small online game
whose arena opens a fresh world for every contribution. The question was: what of the post carries over to
bots written as code, and does such a bot need a learned world model at all?

## The approach in one paragraph

The agents do not train a model. They write a bot, a JavaScript function that plays a figure through three tools:

- `look()` shows the room, its exits, the things in it and the fires;
- `act({ line })` types a command as a player would;
- `wait({ minutes })` lets world time pass.

Every call costs one point. The judge plays each bot in several episodes, each a world of its own: three shown, six
hidden, one or three seeds each, and the goal must still hold some minutes after the bot is done. What the bot learns,
it learns while it plays: its map of the rooms it has seen, and, in the last step, the law of the tide fitted to
observations that earlier generations collected. What the agents learn, they learn as code: the next generation reads
the verdicts, the case lines and the frozen memory, and writes a better bot.

![LeWM and codemode side by side](img/codemode-planung/lewm-vs-codemode.svg)

*Figure 1. Left: LeWM, a model of one world learned offline. Right: a codemode bot. Its map and its model of the tide
are built from what it sees and from the frozen observations; its goal is a predicate the world checks.*

![The two loops](img/codemode-planung/loops.svg)

*Figure 2. Two loops. Across generations the agents learn, as code. Within an episode the bot learns, as data.*

## The mapping, part by part

| LeWM | Codemode | Same or different |
|---|---|---|
| Encoder: pixels → embedding | `look()` returns symbols already | Different: no perception is learned |
| Predictor: (state, action) → next state, a neural net trained on demonstrations | The bot's map: "room A, exit ost → room B", built during one episode. Since step 7 also a model of the tide, fitted to observations | Same role. Different form: code and data, exact where the rules are exact, fitted where they are hidden |
| Planner: CEM or MPC over hundreds of rolled-out sequences | Breadth-first route over the map, timing against the clock, calibration on the first piece seen; since step 8 a search over rounds by their expected pieces | Same role. Simpler, because the model is small and its odds are known once estimated |
| Goal: an image of the target state | A predicate the world checks (`beacon:island` held 5 minutes, `feed:island:3`) | The post's own advice: score what matters |
| Horizon as the limit; subgoals | Goals several rooms away; subgoals as data in a plan (step 4) | Carried over |
| Memory graph with a jump cost | `recall` over the frozen paths of earlier generations, a jump between paths costing 10 cells (step 3) | Carried over |
| Fresh episodes, seeds, a held goal | 3 shown and 6 hidden episodes, 1 or 3 seeds, `hold`; since step 6 hidden islands no shown episode enters | Carried over and pushed further: hidden worlds, not only hidden start and goal pairs |
| Learning: gradient descent on weights, offline | Agents rewrite code across generations; the bot fits a small hypothesis space at run time | Different |

## Why no learned model

A bot has to find its way in worlds it has not seen. A model trained on one island learns that island: its rooms, its
exits, where its fire stands. On another island that is the mistake of a bot that carries the first island's map, and
step 6 measures it: such a bot reaches 0 of 9 episodes on made islands. What carries over to a new world is a way of
searching:

1. look;
2. remember what was seen;
3. plan over that.

The judge's worlds are exact simulators, so nothing needs to be predicted that the rules already say. A learned
predictor would pay off only for planners that roll out many sequences in a world too slow to simulate. A neural
model would also need Python or ONNX, weights that are not published, and a GPU that neither of the project's
servers has.

What a bot cannot see has to be learned, though. Step 7 adds such a dynamic, the tide, and the bot learns it from data,
as code. That is the part of a world model that carries over.

## What carries over, what does not

**Codemode is stronger where:**
- the model is exact and readable: the map, the route, the subgoals and the fitted law can be printed and drawn;
- no training data, no GPU and no weights are needed;
- generalisation is tested on worlds the bot has never seen, not only on new start and goal pairs in one world;
- the evaluation lessons are a task of their own: "Rate planners" asks agents to write a judge that is not fooled.

**LeWM can do what codemode does not:**
- perception from raw pixels: codemode's world is already cut into symbols;
- dynamics nobody can write down, such as contact and friction: codemode's rules are discrete and known, except the
  one law step 7 hides;
- continuous control and uncertainty: the bots assume a deterministic world. The tide's seed is the only chance they
  meet, and they handle it by calibration, not by a distribution.

**Honest limits of what was shown:**
- The scripted agents are fixed hypotheses. They demonstrate that the judge, the data and the tasks separate good bots
  from bad ones, not that agents learn. The model runs (Haiku, Sonnet and Opus 5.5, GPT-6.1 Sol, 2026-11-14, below)
  show learning across generations. Before the observations were in the prompt, Opus solved "Learn the tide" with a
  statistic of them, not the law. With them in the prompt, Opus read the law off the data in one generation and wrote
  it into its bot; Sonnet, Opus and GPT solved "Odds of the tide", only GPT with the odds, which that task turned out
  not to require. Haiku came past neither task's rules of the game.
- The learner of step 7 fits a hypothesis space its author wrote. It finds which hypothesis the data support; it does
  not invent new ones. An agent reading the observations can: Opus 5.5 found the law of step 7 that way (below), n = 1.
- The toy islands are small: 5 to 8 rooms, one fire, four exit directions.

## Development log

All steps were built on 2026-11-14 after the plan of 2026-11-13. The commits are on master. The numbers are the
scripted variants' results, judged as in the tests.

| Step | Commit | What was built | Measured |
|---|---|---|---|
| Plan | cd17ffe, 385b95b | The plan after the post, the values (3 + 6 episodes, seeds 1 or 3, hold 5 minutes) | — |
| 1. Evaluation | 13d818f | Episodes with sample and holdout, seeds, `hold`; the arena's `start`, `seed`, `setup`; the progress curve and the episode matrix; the task "Island bot" | Hidden episodes run only when a shown one was reached |
| 2. Paths on the map | 5db6a5a | The arena records every cell; `path`, `map`; paths in `BotEpisode`; the atlas with paths | A test: no hidden episode lies on a shown one's way |
| 3. Memory | 03395d3 | `PlanMemory`, `MemoryFreeze` per generation, `recall` with a jump cost, coverage, the memory view | Real arena: the first generation covers no hidden start, later ones 1 of 6; a replayer reaches the shown episodes and no hidden one |
| 4. Subgoals | 49e9fb6 | Plans name subgoals as data; the arena marks where each was reached; the subgoal chain; the task "Light the fire of Anleger" | Real arena: the search plan 9/9 (152 points), the Dünen plan 1/9, the fire-first plan 9/9 (195) |
| 5. Rate planners | 7d50eea | A harness task: agents write `rate()`, which must rank good island bots above bad ones; played on a toy copy of the island in the judge | Two correct harnesses; four blind ones, each misranking exactly the bot of its lesson |
| 6. New worlds | e44f11d | Islands made from a number; the toy arena in the judge; the task "New islands" without a map; "Rate planners" on made islands | Mapless explorer 9/9 (163), the Graue Insel's map 0/9, the shown islands by heart 3/9; real arena: the mapless explorer 9/9 (111) |
| 7. The tide | 2412979 | A hidden law of the tide; walking takes time; observations logged into the memory and frozen; the task "Learn the tide" | The law in code 9/9 (2253); the learner 9/9 with observations, 6/9 without; no model 6/9 (4603); without calibration 0/9; by room ids 3/9 |
| 8. Odds of the tide | 0ea9172 | Each dead end draws a piece every hour by odds that grow with its distance from the fire; the verdict asks the mean over 8 seeds against a target per episode; one observation per observed day, every room with its pieces; the task "Odds of the tide" | The law in code and the learner with observations 9/9; counts instead of rates 2/9; the most likely place 0/9; every dead end every hour 2/9; step 7's law 0/9; by room ids 3/9; the learner without observations 1/9 |
| 9. Shores of the tide | (uncommitted) | Every room but the fire's draws by odds of its own, drawn per island and room; a logbook tool with 6 earlier days of the bot's own island; no observations; the task "Shores of the tide" | The learner with the logbook 9/9; step 8's law, the sweep, dead ends only, the most likely room, every room alike 0/9; the three model winners of step 8 0/9 |

### The detours worth telling

- **A seed did not fix a world (step 1).** The game's ticks draw chance at moments of real time. The same seed gave
  the same world once and another the next time, so a task with `wait` can see two seeds disagree.
- **Fog made a test flaky (step 4).** A fire gone out lets dense fog close the ways leading away from it. A test that
  crossed into the next room after the judge's hold failed whenever the fog was dense.
- **Not the arena for harnesses (step 5).** A harness plays each bot dozens of times. Real worlds cost seconds each
  and are not fixed by a seed after a wait, so the bots play on a toy copy of the island in the judge.
- **The learned model was dropped (step 6).** It had been planned as step 6, "only with a decision". The question
  "does a bot need a learned model to find its way in new worlds?" turned it into new worlds without one.
- **Rooms stored after the verdict (step 6).** The page could see a verdict before all the rooms its paths cross were
  stored. A test with 21 rooms caught it; the judge now stores the rooms first.
- **The near searcher became a far searcher (step 6).** Made mapless, the bot that searches only near its start also
  stopped finding the fire. It now limits only its search for wood, so it still fails only by its lesson.

## Step 7 in detail: a world model from observations

**The law**, which no prompt states:
- on a made island the tide washes up one piece an hour, in the island's dead ends in turn, by their number;
- a dead end is a room with one exit, the fire's room left out;
- each piece lands 3 cells in from the room's exit;
- the first piece lands at minute 30 + 10·(seed mod 3), the j-th 60·j minutes later;
- a piece lies 30 minutes;
- an exit takes 5 minutes, and the day ends after 480.

**The data.** In every shown episode, under all three seeds, the judge logs each landing: island, seed, piece,
minute, room, cell, the room's exits and its distance from the fire. These go into the block's memory, are frozen when
a generation begins, and a bot reads them with `observations()`. They are facts about the world, like the
demonstrations a JEPA model is trained on, not the law.

**What the learner does with them.** It holds a few hypotheses:
- do pieces land only in rooms with one exit, never in the fire's room?
- in which order: by room number up or down, checked against each logged world's sequence of pieces?
- how far in from the exit?
- at which minutes of the hour?

It keeps the hypotheses the data support, explores its island, and plays the model. It goes to the next dead end
before the earliest minute the data allow, and waits in 10-minute steps until the piece comes. The first piece it sees
tells it its world's minute, and from then on it arrives on time. Without observations, or when no hypothesis fits, it
falls back to searching.

**What the variants show.**
- The model needs the data. Without them the learner is a searcher: 6 of 9, at twice the points.
- The model must speak of shape, not names. Replaying the observed room ids reaches the three shown islands and none
  of the hidden ones.
- The model must hold for every seed. The law without calibration assumes minute 30 and reaches nothing, since every
  episode runs three seeds.
- A model that is learned and one that is written are equally good. The law written by hand (9/9, 2253 points) and the
  law fitted to the data (9/9, 2280 points) differ by the one `observations()` call per run.

## Step 8 in detail: odds, not a law

**What changes from step 7.** In step 7 the tide was a law: who knew it knew where every piece would land. In step 8
only the odds follow a law. Every hour at half past, each dead end draws for itself. It gets a piece with odds 0.15 for
each exit between it and the fire, at most 0.9. The prompt names the hours, not the odds.

**What a plan must reckon with.** A piece lies 30 minutes and an exit takes 5. In one hour a bot reaches only the dead
ends at most 5 exits apart. The expected pieces of such a round are the sum of their odds. The most likely dead end
is the farthest from the fire and often far from the others too. Two nearer ones together are worth more. "Where is a
piece most likely?" and "which round brings the most pieces?" are different questions, and the task asks the second.

**What is judged.** The mean over 8 seeds, not "every seed". What a good round brings varies from 2.6 to 10.5 pieces
on the candidate islands, so each episode has its own target: 90 % of what the law bot brings there on average. The
law bot passes by construction; the learner and the wrong bots are the informative rows. The draws are a hash of island, seed,
hour and room, so every bot meets the same pieces.

**What the data must contain.** One observation per observed day: the hours the tide came and every room of the island
with its exits, its distance from the fire and the pieces it got. Rooms that got nothing are in it too, because
estimating odds needs the chances as well as the hits.

**What the variants show.** The six hidden islands were chosen with the wrong bots' results in view, so that each
fails at least once; over all 97 candidates that are not shown, the share below the target is given in brackets.
- **Rates, not counts.** The shown islands have many dead ends at distance 2, two at 4, none at 3. A bot that counts
  landings per distance thinks 2 is better than 4 and has no number for 3, 5 or 6. It passes the two shown islands
  where that does not matter and none of the hidden ones. The learner divides by the chances, fits a slope, and its
  law carries to distances it never saw: 9/9 (counts below target on 64 % of the candidates, the learner on none).
- **The expected count, not the most likely place.** Waiting every hour at the dead end with the best odds brings a
  third to two thirds of what the law bot's round brings: 0/9 (82 %).
- **Within the time the piece lies.** Visiting every dead end every hour in a fixed order is too slow wherever they lie
  far apart: 2/9 (34 %). A greedy sweep that skips what it cannot reach is not; Sonnet 5.5 wrote one, and it passes
  without the odds (see the runs after the four changes below).
- **Data, then a model.** Without observations the learner does not even know that only dead ends get pieces: 1/9.
  With them, 9/9. Over all candidates the gap is smaller (27 % below target without observations): on many islands a
  round over all rooms happens to cover the good dead ends.

**Where it stands against the post.** LeWM's planner rolls its learned predictor out over many sampled action
sequences and keeps the best. Here the predictor is the estimated odds, and the planner searches the rounds of one
hour exactly. That is possible because the model is small. The point the post makes about a world model holds here
too: what is learned is how the world behaves, here how likely it is, and the plan is made against that model, not
against the data directly.

## A run with model agents on "Learn the tide" (2026-11-14)

**Setup.** One run, so n = 1:
- 3 agents, all `anthropic/claude-haiku-5-5`, 5 generations at most, 2 improvement rounds, 1 $ cap;
- no scripted agents, because their variants include the law in code, which would solve the task in generation 1;
- one model call per contribution, judged as usual (`CODEMODE_DURABLE_AGENT=0`, see the detours below);
- the prompt names `observations()`, its fields and its cost, and states no law.

**Result.** Not solved: 15 contributions, all 0 of 9, 86,733 tokens, 0.017 $.

| Generation | What failed |
|---|---|
| 1 | Two waited past the 480-minute day; one went over the 300 tool calls (1954 looks). |
| 2–3 | The same limits, with the looks cut from about 1000 to about 300. |
| 4–5 | Every bot within the limits, every one with 0 of 3 pieces in the fire. |

**What the team learned, by its notes:**
- the rules of the game (one look per decision, exits and waits share the day, stop near 455 minutes);
- not the law.

**Where the observations came in:**
- Generation 1's bots waited past minute 30, so the judge logged landings, and generation 2 had observations.
- One note of generation 1 says the right thing ("cluster landing rooms by fromFire/exit distance to predict where to
  wait"), but no later bot does it.
- Three of the 15 bots called `observations()` (one in generation 1, where it is empty, and two later), and none fitted
  anything to the result. Generations 4 and 5 no longer called it.

**Why, as far as one run shows.** A model sees its team's attempts as code, failures and points. It never sees what
`observations()` returned. To read the law off the data, it would have to write a bot that fits hypotheses at run time
(the scripted learner does), without having seen a single observation. The JEPA model in the post sees its
demonstrations; these agents see only their effect.

**Next experiment.** Show the frozen observations in the prompt as well, as data the agent reads before it writes. That
separates "can the model see the law in the data" from "can it write a bot that finds the law blind".

**Detours of this run:**
- **The model list outgrew its entry.** With every provider's catalog (about 500 models) the model process's
  ModelInfo entry was 65,550 bytes, over the space's 64 KiB, so the page saw no models. It now carries the admin list
  packed (provider, id, name when it differs), about 32 KB.
- **The scripted stand-in.** A model call that fails (Mistral answered 429 for codestral) is replaced by a scripted
  agent. For a measurement that is a contamination, so the first run, with codestral and haiku, was stopped after a
  generation.
- **The durable agent path ran out of requests.** By default a model contribution gets 4 requests of 1500 tokens
  and tests itself with `verify_code`. On this task the bot never passes, the fourth request ends in "Agent model request
  budget exhausted", no code is handed in, and the scripted agent stands in. The measured run used the plain path.

## A run with Claude Opus 5.5 on both tide tasks (2026-11-14)

**Setup.** As for haiku, n = 1 per task:
- 3 agents, all `anthropic/claude-opus-5-5`, 5 generations at most, 2 improvement rounds, 5 $ cap;
- the plain path (`CODEMODE_DURABLE_AGENT=0`), no scripted agents, the same prompts;
- one run on "Learn the tide" (`tide-law`), one on "Odds of the tide" (`tide-odds`), side by side.

**Result.**

| Task | Solved | Passes by generation | Cost |
|---|---|---|---|
| Learn the tide | generation 5 | 0, 0, 6 · 6, 5, 6 · 6, 6, 6 · 6, 7, 5 · 7, 7, **9** of 9 | 1.24 $ |
| Odds of the tide | no | every contribution 0 of 9; the best mean 2.93 pieces against a target of 6.19 on average (generation 5), generation 1's blind bot 2.40 | 1.37 $ |

**What the winner does.** It did not find the law (dead ends by number, 3 cells in, the calibrated minute). It
patrols: it scores each room by how long it has not been seen, weighted by how often the room's distance from the fire
appears in the observations, and collects up to three pieces before it goes to the fire. Judged again afterwards
(no model calls):

| Bot | Without observations | With the law bot's observations | Points with observations |
|---|---|---|---|
| The law in code (scripted) | 9 of 9 | 9 of 9 | 2253 |
| Opus's winner | 7 of 9 | 9 of 9 | 3258 |

So the observations helped measurably (7 → 9), but as a statistic, not as a law, and the task let that pass:
"Learn the tide" asks for the goal on every episode, not for a cost near the law's. A good searcher with a coarse prior
is enough. That is the post's warning about flattering evaluations, found by a model in this project's own task. A
cost limit per episode closes it (next section); the winner spends 1.45 times the law's points.

**On "Odds of the tide"** Opus went the way haiku went on step 7: generations 1 and 2 learned the game's limits
(`bot()` takes no arguments, `tools` is global, `wait` takes 1 to 120 minutes, at most 300 calls), and later bots read
`observations()` for the mean pieces by distance from the fire, but none reached half the target.

**Detour: every answer empty.** The first pair of runs measured nothing: every Opus answer came back without text, and
the scripted stand-in played every contribution (1.29 $ for the thinking). Opus 5.5 cannot turn its thinking off
(adaptive thinking, the "off" level is absent), and a call without a thinking level is marked effort "high" by pi-ai;
the thinking used the whole 1500 tokens. Raising the limit to 13,500 tokens did not help (158 s, all thinking).
`guardedCall` (`server/llm.ts`) now asks such a model for effort "low" and gives it 4000 tokens and 180 s on top: the
same prompt then answers in 21 s with code, for 0.04 $.

## After four changes: four models on both tide tasks (2026-11-14)

**Why the Opus runs left questions.** Each model call starts without a conversation: the model process rebuilds its
prompt from the space (`server/context.ts`): the task, the team's best attempt with its case results, up to three other
attempts, up to three rejected ones, every note of the team, the chosen plan. That is how a generation builds on the
last. Four gaps came out of the Opus runs:
1. **The model never saw the observations.** Only the bot read them, at run time, through `observations()`. An agent had
   to find a law in data it had never seen.
2. **Bots were cut in half.** The prompt showed at most 4000 characters of the attempt worked on and 1500 of the others,
   limits set on 2026-10-19 for small function tasks to keep a call at a few thousand input tokens. Opus's winner had
   4129 characters. And a bot answer had 1500 output tokens, about 4500 characters.
3. **A failure said little.** A bot that brought nothing got "goal not reached", with no hint of what it saw or took.
4. **"Learn the tide" let a searcher pass** (above).

**What changed, all four at once** (so their effects cannot be told apart):
1. The team's prompt and the plan's prompt show what `observations()` returns to this generation's bots, from the
   same freeze: one line per landing (step 7) or per day (step 8), at most 12,000 characters.
2. A bot, tool program or harness is shown with up to 12,000 characters (the others 6000, rejected ones 3000), and its
   answer may have 3000 output tokens.
3. The toy world counts the pieces a look showed and the pieces picked up; the failure says so ("0 of 3 pieces in the
   fire (3 seen in a look, 2 picked up)"), and a task that scores the mean says what its first seed did.
4. Every episode of "Learn the tide" has a point limit, 1.3 times what the law in code spends there over its seeds
   (`TIDE_LAW_COST`); the episode text names it. The learner, which fits the law, spends 3 points more than the law per
   episode and passes. Opus's winner now passes at most 1 of 9 (a test holds it, `tests/fixtures/opus-tide-patrol.js`).

**Setup.** The same for every model: 3 agents of one model, 5 generations at most, 2 improvement rounds, 1
contribution per agent and generation, a 5 $ cap, the plan step on, the German task text, the plain path
(`CODEMODE_DURABLE_AGENT=0`), no scripted agents, no daily token allowance (`CODEMODE_TOKENS_PER_IP_DAY=0`). One run per
model and task, so n = 1 each: a run says what a model can do here, not how often. Costs are the list prices of pi-ai's
model catalog (Haiku 5.5: 0.10 $ per million input tokens, 0.50 $ per million output tokens), not an invoice.

| Model | Learn the tide | Odds of the tide | Cost (law + odds) |
|---|---|---|---|
| Haiku 5.5 | not solved; all 15 contributions 0 of 9 | not solved; all 15 contributions 0 of 9 | 0.03 $ + 0.03 $ |
| Sonnet 5.5 | not solved; best 3 of 9 (generation 5) | **solved in generation 4**, 6493 points | 0.57 $ + 0.88 $ |
| Opus 5.5 | **solved in generation 3**, 1371 points | **solved in generation 3**, 6304 points | 1.47 $ + 1.68 $ |
| GPT-6.1 Sol | not solved; best 7 of 9 (generations 4 and 5) | **solved in generation 4**, 6305 points | 0.64 $ + 0.78 $ |

For scale, the law in code spends 2253 points on "Learn the tide" and 7627 on "Odds of the tide".

Passes per generation (three contributions each; a number in brackets is the points of a contribution that passed all):

| Run | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Haiku, law | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |
| Haiku, odds | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |
| Sonnet, law | 0, 0, 0 | 0, 0, 0 | 0, 1, 1 | 2, 0, 0 | 3, 3, 3 |
| Sonnet, odds | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 9 (7947), 0, 9 (6493) | 0, 9 (6493), 9 (7947) |
| Opus, law | 0, 0, 0 | 7, 0, 7 | 7, 7, 9 (1371) | 9, 9, 9 (1371 each) | 9 (1371), 8, 8 |
| Opus, odds | 0, 0, 0 | 0, 0, 0 | 0, 9 (8636), 9 (6304) | 0, 9 (8480), 0 | 0, 0, 0 |
| GPT, law | 0, 0, 0 | 0, 0, 0 | 6, 0, 6 | 7, 7, 0\* | 7, 6, 7 |
| GPT, odds | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 9 (6305), 9 (6627), 9 (8401) | 9 (6507), 9 (6305), 9 (6337) |
| GPT (2nd run), law | 0, 0, 0 | 0, 0, 0 | 2, 2, 1 | 2, 2, 2 | 1, 2, 2 |
| GPT (2nd run), odds | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 9 (8071), 7, 0 |

\* One GPT answer broke off ("Stream ended before a terminal response event", OpenRouter) and the scripted agent
played that contribution; it is the only stand-in in the eight runs. GPT-6.1 Sol ran through OpenRouter
(`openrouter/openai/gpt-6.1-sol`): the direct OpenAI route failed with an expired login (`invalid_grant`). It is a model
that must think, like Opus and Sonnet, and gets the same effort "low" with 4000 tokens on top.

**A second GPT-6.1 Sol run** went the direct way, `openai/gpt-6.1-sol` through the pi CLI's login, once that login
had been renewed; every one of its 30 contributions was the model's own. Same conditions, other results: "Learn the
tide" 2 of 9 at best (0.50 $), against 7 of 9 in the first run; "Odds of the tide" solved in generation 5 (8071 points,
0.58 $), against generation 4 (6305). Its winner again reads `observations()` at run time. One run per pair says what a
model can reach, not what it reaches on average.

An earlier pair of Haiku runs on the same day ended in generation 5 when the daily token allowance per address ran out
(13 and 12 contributions, all 0 of 9); the runs above repeat them without the allowance.

**The data in the prompt are read.** Sonnet's notes of generation 2, the first that saw observations:
- on "Odds of the tide": "Driftwood only washes up in dead-end rooms (one exit), at the exit-side spot …, about 0.5 per
  tide". The task text does not say that only dead ends get pieces;
- on "Learn the tide": "Landings alternate between two dead-end rooms every 60 min, first at minute 30-50". That is
  most of the law (the order by number and the three cells in are missing).

Haiku read patterns too ("every 60 min at fixed rooms per island", "the fire room itself rarely gets any"), but took
the distance from the fire for the key, not the dead ends.

**Sonnet's winner on "Odds of the tide".** It does not call `observations()`: what it learned is in its code. Every hour
at half past it walks to the nearest dead end it can still reach before the piece is gone, then the next nearest, picks
up what lies there, and puts everything into the fire at the end of the day. It never estimates the odds. The
improvement rounds brought it down to 6493 points; the law in code spends 7627. On the 91 islands that are neither shown
nor hidden it stays below the target on 8 % (the scripted sweep of step 8 on 32 %), and it brings 1.07 times what the
law bot brings in the median.

**What that corrects in step 8.** "Visiting every dead end every hour is too slow" held for the scripted sweep, which
goes in the order of the names and gives up the day once the whole round no longer fits. A greedy sweep that skips what
it cannot reach is not too slow, and it beats the reference plan (the best round of one hour by expected pieces) on
most islands, because it does not have to commit to one round. So "Odds of the tide" asks for where and when the tide
comes, not for its odds; a target that only a plan with the odds can reach would need a reference plan that is optimal
or a world where the sweep cannot keep up.

**What stopped Sonnet on "Learn the tide".** Not the law but the craft and the new limit: bots that waited past the
480-minute day, and bots that reached the goal dearer than the limit ("3 of 3 pieces in the fire …; 359 points, over the
limit of 316"). Without the limit, several of them would have passed more episodes; with it, a bot has to use the law,
and none did within 5 generations.

**Opus 5.5 on "Learn the tide": the law, written into the code.** Generation 1 had no observations in the prompt (the
first freeze is empty) and patrolled; its notes asked the next generation to read the observations. Generation 2, the
first that saw them, wrote down the law: "landings only in 1-exit rooms, alternating between 2 of them every 60 min,
first at minute 30-50 (seed); each piece lasts 30 min". Generation 3 turned that into a schedule: at minute 55 + 60k
exactly one piece lies somewhere, so the bot looks once per hour, in a dead end chosen by the hour's parity, and an
empty look rules that room out for that parity. The winner never calls `observations()`; the law is in its code, the
search for which dead end belongs to which parity is the only thing it learns per island. It spends 1371 points over the nine episodes, less
than the law in code (2253), because it waits instead of looking (`wait` of up to 120 minutes costs one point) and
does not have to know the order by number or the three cells in. The improvement rounds tried to save the mapping
(stop once two dead ends are known) and lost an episode each (8 of 9).

**Opus 5.5 on "Odds of the tide".** Generation 2 read the days: "wood only lands in dead-end rooms (1 exit), … more
often the further the room is from the fire". The winner of generation 3 maps the island, weighs every dead end by its
distance from the fire (the true law: the odds are 0.15 per exit from the fire), and before every tide searches the
round of up to six dead ends with the highest weight it can reach between half past and the piece's end. It does not
call `observations()` either. 6304 points against the law's 7627. Generations 4 and 5 tried to save the look before
taking ("nimm without look"); their notes guess that the figure lands on the piece when it enters, which it does not,
and every such bot brought nothing. The run keeps generation 3's winner.

**GPT-6.1 Sol: the craft first, then the data.** For three generations its bots picked up wood and put none into the
fire: they walked onto the fire's own square, which is not walkable. Its notes, often empty, name the fix only in
generation 3 ("approaches adjacent tiles"). After that:
- on "Odds of the tide" every contribution of generations 4 and 5 passed. Its winner is the only one of the eight runs
  that estimates the odds: it calls `observations()` and counts, for every pair of exits and distance from the fire,
  how many pieces the logged days had per tide; then it plans with those rates (6305 points);
- on "Learn the tide" its bots read the landing times from `observations()`, take the period from them and "camp a
  confirmed landing site at 120-minute intervals". Seven of nine episodes; two hidden islands fail, where the parity of
  the dead ends did not match its guess ("Hidden-island leaf numbering cannot safely predict tidal parity").

**Haiku 5.5: the rules of the game, not the tide.** On "Learn the tide" the first contributions waited past the
480-minute day; the later ones ended the day with nothing seen ("0 seen in a look, 0 picked up"); one of 15 picked up
three pieces and did not bring them to the fire. On "Odds of the tide" 9 of 15 contributions declared `bot(tools)` and
crashed on `tools.look` (the prompt writes `await tools.look()`: `tools` is global), every generation again. Its notes saw
patterns in the observations, but no bot came far enough for a law to matter. Each contribution cost about 0.002 $.

**What the comparison shows.**
- The step from the data to the code works, when the model gets there. Opus wrote the law of "Learn the tide" into code
  one generation after it first saw the observations; Sonnet's notes held most of it too. Showing the observations in
  the prompt is what made that possible: before the change, Opus's winner was a patrol (7 of 9 without observations).
- Where the law lands differs: Opus and Sonnet put what they learned into the code as constants, GPT reads it from `observations()` at
  run time. Both pass the hidden islands; only the second would follow a tide that changes between generations.
- The ceiling is the craft, not the model of the world. Haiku never came past the game's rules; GPT lost three
  generations on one square; Sonnet's bots on "Learn the tide" waited too long or spent too much. What a model knows
  about the tide shows only once its bot can walk, take and lay.
- The point limit does its job. Opus's law bot passes it with room (about 150 points per episode over three seeds, against
  limits of 248 to 417); what it stops are the patrol that passed before (Opus's first winner) and Sonnet's bots that
  reached the goal too dearly.
- "Odds of the tide" does not separate the models that can walk: all three pass, and only GPT uses the odds. The
  greedy sweep is enough (above), so the task needed a harder target before it said anything about planning under
  chance: step 9 (below).
- Cost and result go together, but not linearly: Opus solved both for 3.15 $, GPT one for 1.42 $, Sonnet one for 1.45 $,
  Haiku none for 0.06 $. With n = 1 per pair, a second run could move any single row, and for GPT it did (7 of 9 on
  "Learn the tide" in the first run, 2 of 9 in the second).

## Step 9 in detail: odds every island has its own

**Why.** "Odds of the tide" did not separate the three models that could walk. Two of them passed with a prior in the
code: Sonnet's winner sweeps the dead ends, Opus's weighs them by their distance from the fire; only GPT's estimates
odds, from `observations()`. All three priors hold because the law is the same on every island. A point limit, which
closed the gap on "Learn the tide", does not help here: the sweeps spent fewer points (6304 to 6493) than the law in
code (7627).

**What changed.** The task "Shores of the tide" keeps step 8's world and verdict, and takes away what the priors live
on:
- every room but the fire's may get pieces, each with odds of its own, drawn once per island and room (0 on about
  half of them, else 0.1, 0.35 or 0.7). No shape, distance or name tells them, so no law carries from one island to
  the next;
- a logbook (`logbook()`, 1 point) lists 6 earlier days of the tide on the bot's own island, every room with its
  pieces; the episode's own days never appear in it;
- no observations of other islands and no memory: what a bot can learn, it learns at run time, from its island's data;
- the target is 90 % of a reference plan that knows the true odds; no point limit, because no failing bot spends more
  points than the reference.

This is the setting of the post's world model in small: data of one world, gathered before, and a plan made from a
model fitted to them. Here the model is a table of rates the bot fills itself.

**Result** (scripted bots and the three model winners of step 8, on the nine episodes and on 95 islands not chosen):

| Bot | Episodes | Below the target, of 95 |
|---|---|---|
| The learner: the logbook's rate per room, then the round with the most expected pieces | 9 of 9 | 1 % |
| No logbook, every room alike | 0 of 9 | 41 % |
| Every room, every hour | 0 of 9 | 88 % |
| Step 8's law (dead ends by distance) | 0 of 9 | 97 % |
| The logbook, but dead ends only (step 8's prior) | 0 of 9 | 97 % |
| The most likely room only | 0 of 9 | 100 % |
| Sonnet 5.5's winner of step 8 | 0 of 9 | 97 % |
| Opus 5.5's winner of step 8 | 0 of 9 | 97 % |
| GPT-6.1 Sol's winner of step 8 | 0 of 9 | 100 % (it calls `observations()`, which this task does not have) |

The nine islands were chosen where every wrong bot fails, so the 0 of 9 is by construction; the last column is not.
Without its tool, GPT's winner fails at once; with the tool renamed it would read the logbook as it read the
observations, and that is the bot this step asks for. Sonnet's and Opus's winners fail for the reason the step was
built for: their prior is wrong on almost every island. The learner brings 0.87 to 1.0 times the reference plan's
mean on the 95 islands (median 1.0).

## Figures

The diagrams are hand-drawn SVG that follow the reader's light or dark theme. The screenshots come from a local run
with scripted agents under a neutral judge name, with no addresses and no machine data in view (dark theme, German
interface); figures 8 to 15 show model runs. All paths are relative to `docs/`.

![Island bot: curve, matrix and paths](img/codemode-planung/step1-2-island.jpg)

*Figure 3 (steps 1 and 2), "Island bot". The progress curve shows the share of hidden episodes reached per
generation. The matrix shows each episode, shown (S) and hidden (H). The right column draws the best contribution's
sample paths on the Graue Insel, one colour per episode, with the fire ringed.*

![Anleger: subgoals](img/codemode-planung/step4-anleger.jpg)

*Figure 4 (step 4), "Light the fire of Anleger". The team's plans, and the paths with the numbered marks where each
subgoal was reached. Two of the three contributions reached all nine episodes (152 points); one reached none.*

![New islands](img/codemode-planung/step6-new-islands.jpg)

*Figure 5 (step 6), "New islands". Three made islands in the atlas, one under the other, with the explorer's paths. On
the cards: the explorer reaches 9/9 (163 points), the walker without a memory 5/9, and the Graue Insel's map 0/9.*

![Learn the tide](img/codemode-planung/step7-tide.jpg)

*Figure 6 (step 7), "Learn the tide".*
- *Generation 1: the tour without a model (6/9, yellow where only some seeds worked) and the camper (0/9).*
- *Generation 2: the law in code (9/9, 2253 points).*
- *The card "lerner": the learner handed in afterwards. It read the observations the run had logged and reached 9/9
  (2280 points). The page counts a contribution handed in by hand as generation 0, so it is the top row of the
  matrix.*

![Odds of the tide](img/codemode-planung/step8-odds.jpg)

*Figure 7 (step 8), "Odds of the tide". In this task a cell shows the mean number of pieces over the 8 seeds; green
where it reaches the episode's target. The detail line below says the mean, the seeds and the target.*
- *Generation 1: the law in code reaches every target.*
- *Generation 2: the observed room ids. They reach the three shown islands and bring nothing on the hidden ones.*
- *Generation 3: the law again, from another agent.*
- *Generation 0 (top row): the learner, handed in afterwards. It estimated the odds from the 24 days the run had
  logged and reached every target (7714 points).*

The model runs of 2026-11-14 (figures 8 to 15) all ran under the same conditions, after the four changes; they are
shown with the English interface, and the same view in German lies beside each as `*-de.jpg`. Each shows the run's
summary, the curve of hidden episodes reached and the matrix of every episode per generation (the best contribution of
each generation); the detail line below is the cell with the white frame.

![Haiku 5.5 on Learn the tide](img/codemode-planung/haiku-law-en.jpg)

*Figure 8. Haiku 5.5 on "Learn the tide": no shown episode in five generations, so no hidden one ran.*

![Sonnet 5.5 on Learn the tide](img/codemode-planung/sonnet-law-en.jpg)

*Figure 9. Sonnet 5.5 on "Learn the tide": single episodes from generation 3 on, 3 of 9 at most; yellow where only some
seeds were reached.*

![Opus 5.5 on Learn the tide](img/codemode-planung/opus-law-en.jpg)

*Figure 10. Opus 5.5 on "Learn the tide": 7 of 9 in generation 2, the first that saw the observations; 9 of 9 from
generation 3 on, with the law in its code (1371 points).*

![GPT-6.1 Sol on Learn the tide](img/codemode-planung/gpt-law-en.jpg)

*Figure 11. GPT-6.1 Sol on "Learn the tide": nothing until generation 3 (the bots stood on the fire's square), then 6
and 7 of 9; the hidden H4 and H5 stay red.*

![Haiku 5.5 on Odds of the tide](img/codemode-planung/haiku-odds-en.jpg)

*Figure 12. Haiku 5.5 on "Odds of the tide": a cell is the mean pieces over 8 seeds; every shown episode 0. The detail
line shows the most frequent failure, `bot(tools)` with `tools` undefined.*

![Sonnet 5.5 on Odds of the tide](img/codemode-planung/sonnet-odds-en.jpg)

*Figure 13. Sonnet 5.5 on "Odds of the tide": nothing in generations 1 to 3 (the bots failed the game's limits and the
exit command), every target from generation 4 on.*

![Opus 5.5 on Odds of the tide](img/codemode-planung/opus-odds-en.jpg)

*Figure 14. Opus 5.5 on "Odds of the tide": every target in generations 3 and 4; generation 5's bots dropped the look
before taking and brought nothing. The run's winner is generation 3's (6304 points, the framed cell).*

![GPT-6.1 Sol on Odds of the tide](img/codemode-planung/gpt-odds-en.jpg)

*Figure 15. GPT-6.1 Sol on "Odds of the tide": every target from generation 4 on, with the odds counted from
`observations()` (6305 points).*

## Open

- Model runs on "Shores of the tide" (step 9): does a team write the estimator, or a prior again?
- Repeats: every model and task ran once, GPT twice (7 and 2 of 9 on "Learn the tide"). Opus's two solutions and
  Haiku's two failures look stable from their curves; the rest needs more runs.
- A law that changes between generations: then only a bot that reads `observations()` at run time (GPT's way) keeps
  passing, and a law written into the code as constants (Opus's and Sonnet's way) fails.
- The effect of each of the four changes alone (observations in the prompt, longer code, richer failures, the limit).
- The durable agent path on a task its own check never passes: hand in the last code instead of failing.
- Goals as sets ("any fire of the island burns") and goals against the usual direction. The post leaves both open too.
- Risk beyond the mean: a target that also bounds the bad days (a quantile, not only the mean), so a plan must weigh
  variance as well.
