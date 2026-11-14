// The island bot (docs/codemode-planung.en.md, step 1): the first planning task. Its episodes start the figure in the
// rooms of the Graue Insel of spaces-mmo's world Leuchtfeuer and lay out the island's only piece of driftwood; the goal
// is always the beacon of the Graue Bucht. The rooms, exits and cells are those of spaces-mmo/worlds/leuchtfeuer
// (world.json); spaces-mmo/tests/arena.test.ts opens the episodes in the real world.
import type { BotEpisode } from "./bottask.ts";
import type { Subgoal } from "./subgoals.ts";
import type { HarnessSpec } from "./harnesstask.ts";

/** The island's rooms and their exits on the island (exits that leave it are left out). */
export const ISLAND_ROOMS: Record<string, { name: string; exits: Record<string, string> }> = {
	"graue-bucht": { name: "Graue Bucht", exits: { ost: "klippenpfad", "süd": "duenen", west: "fischerdorf" } },
	klippenpfad: { name: "Klippenpfad", exits: { west: "graue-bucht", ost: "klippenkopf", "süd": "salzwiesen" } },
	fischerdorf: { name: "Fischerdorf", exits: { ost: "graue-bucht", "süd": "torfmoor" } },
	torfmoor: { name: "Torfmoor", exits: { nord: "fischerdorf", ost: "duenen" } },
	duenen: { name: "Dünen", exits: { nord: "graue-bucht", ost: "salzwiesen", "süd": "anleger", west: "torfmoor" } },
	salzwiesen: { name: "Salzwiesen", exits: { nord: "klippenpfad", west: "duenen" } },
	klippenkopf: { name: "Klippenkopf", exits: { west: "klippenpfad" } },
	anleger: { name: "Anleger", exits: { nord: "duenen" } },
};

export const ISLAND_MAP = Object.entries(ISLAND_ROOMS).map(([id, r]) => `- ${r.name} (${id}): ${Object.entries(r.exits).map(([ex, to]) => `${ex} → ${ISLAND_ROOMS[to]!.name} (${to})`).join(", ")}`).join("\n");

/** Everything that feeds a fire, taken off the ground of every room before an episode's piece is laid out. */
const FUEL = ["treibholz", "holzbuendel", "tran"];
const ep = (id: string, kind: BotEpisode["kind"], start: [string, number, number], wood: [string, number, number]): BotEpisode => ({
	id, kind,
	start: { room: start[0], x: start[1], y: start[2] },
	setup: { clear: FUEL, items: [{ proto: "treibholz", room: wood[0], x: wood[1], y: wood[2] }] },
	text: {
		de: `Start ${ISLAND_ROOMS[start[0]]!.name} (${start[1]},${start[2]}), Treibholz ${ISLAND_ROOMS[wood[0]]!.name} (${wood[1]},${wood[2]})`,
		en: `start ${ISLAND_ROOMS[start[0]]!.name} (${start[1]},${start[2]}), driftwood ${ISLAND_ROOMS[wood[0]]!.name} (${wood[1]},${wood[2]})`,
	},
});

/** Three shown, six hidden. Five hidden ones start in rooms no shown one starts in; H3 and H6 need driftwood from a
 *  room that is neither the start nor on the shortest way to the fire. */
export const ISLAND_EPISODES: BotEpisode[] = [
	ep("S1", "sample", ["graue-bucht", 10, 8], ["graue-bucht", 5, 7]),
	ep("S2", "sample", ["fischerdorf", 12, 8], ["fischerdorf", 5, 5]),
	ep("S3", "sample", ["klippenpfad", 2, 8], ["graue-bucht", 17, 9]),
	ep("H1", "holdout", ["duenen", 12, 8], ["duenen", 20, 5]),
	ep("H2", "holdout", ["torfmoor", 12, 8], ["torfmoor", 9, 2]),
	ep("H3", "holdout", ["salzwiesen", 12, 8], ["duenen", 20, 5]),
	ep("H4", "holdout", ["klippenkopf", 12, 8], ["klippenkopf", 13, 11]),
	ep("H5", "holdout", ["anleger", 12, 8], ["anleger", 15, 1]),
	ep("H6", "holdout", ["graue-bucht", 14, 9], ["torfmoor", 9, 2]),
];

/** The shown episodes for the prompt, one line each. */
export const episodeList = (eps: BotEpisode[], lang: "de" | "en"): string => eps.filter((e) => e.kind === "sample").map((e) => `- ${e.id}: ${e.text[lang]}`).join("\n");

// The scripted variants. MAP is the island as the prompt gives it; route() walks it breadth first.
const MAP = JSON.stringify(Object.fromEntries(Object.entries(ISLAND_ROOMS).map(([id, r]) => [id, r.exits])));
const ROUTE = `const MAP=${MAP};const route=(a,b)=>{const prev={[a]:null},q=[a];while(q.length){const r=q.shift();if(r===b)break;for(const [ex,d] of Object.entries(MAP[r]||{}))if(!(d in prev)){prev[d]=[r,ex];q.push(d)}}const out=[];for(let r=b;prev[r];r=prev[r][0])out.unshift(prev[r][1]);return out};`;
const FEED = `s=await tools.look();const f=s.fires[0];await tools.act({line:"move "+f.x+" "+(f.y-1)});return (await tools.act({line:"lege holz ins feuer"})).said`;

export const ISLAND_VARIANTS: string[] = [
	// searches the island room by room, nearest first, then walks to the fire: correct everywhere
	`async function bot(){${ROUTE}let s=await tools.look();let here=s.room.id;const order=[here];for(let i=0;i<order.length;i++)for(const d of Object.values(MAP[order[i]]||{}))if(!order.includes(d))order.push(d);for(const r of order){if(r!==here){for(const ex of route(here,r))await tools.act({line:ex});here=r;s=await tools.look()}const w=s.things.find(t=>t.name==="Treibholz");if(w){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"});break}}for(const ex of route(here,"graue-bucht"))await tools.act({line:ex});${FEED}}`,
	// the same, and it looks after every step: correct, more points
	`async function bot(){${ROUTE}let s=await tools.look();let here=s.room.id;const order=[here];for(let i=0;i<order.length;i++)for(const d of Object.values(MAP[order[i]]||{}))if(!order.includes(d))order.push(d);for(const r of order){if(r!==here){for(const ex of route(here,r)){await tools.act({line:ex});await tools.look()}here=r;s=await tools.look()}const w=s.things.find(t=>t.name==="Treibholz");if(w){await tools.act({line:"move "+w.x+" "+w.y});await tools.look();await tools.act({line:"nimm treibholz"});await tools.look();break}}for(const ex of route(here,"graue-bucht")){await tools.act({line:ex});await tools.look()}${FEED}}`,
	// knows the three shown episodes by heart: all of them, none of the hidden ones
	`async function bot(){${ROUTE}let s=await tools.look();const known={"graue-bucht":["graue-bucht",5,7],fischerdorf:["fischerdorf",5,5],klippenpfad:["graue-bucht",17,9]};const k=known[s.room.id]||["graue-bucht",5,7];let here=s.room.id;for(const ex of route(here,k[0]))await tools.act({line:ex});here=k[0];await tools.act({line:"move "+k[1]+" "+k[2]});await tools.act({line:"nimm treibholz"});for(const ex of route(here,"graue-bucht"))await tools.act({line:ex});${FEED}}`,
	// looks only in the room it starts in and in the Graue Bucht: misses wood elsewhere
	`async function bot(){${ROUTE}let s=await tools.look();let here=s.room.id,w=s.things.find(t=>t.name==="Treibholz");if(w){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"})}for(const ex of route(here,"graue-bucht"))await tools.act({line:ex});if(!w){s=await tools.look();w=s.things.find(t=>t.name==="Treibholz");if(w){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"})}}${FEED}}`,
	// wrong: goes to the fire without wood
	`async function bot(){${ROUTE}let s=await tools.look();for(const ex of route(s.room.id,"graue-bucht"))await tools.act({line:ex});${FEED}}`,
];

// The variants of the island bot with memory (docs/codemode-planung.en.md, step 3). WALK follows a recall answer: a
// `move` onto every step in the figure's room (a step onto an exit changes the room), TAKE picks up driftwood on the
// way when asked to.
const WALK = `const walk=async(r,take)=>{let s=await tools.look();let room=s.room.id,at=s.at;for(const st of [r.from,...r.steps]){if(st[0]!==room||(st[1]===at.x&&st[2]===at.y))continue;const a=await tools.act({line:"move "+st[1]+" "+st[2]});room=a.at.room;at=a.at;if(take)await tools.act({line:"nimm treibholz"})}return room};`;
export const ISLAND_MEMORY_VARIANTS: string[] = [
	// searches the island for the driftwood (as the island bot does) and never recalls: correct, no memory needed
	ISLAND_VARIANTS[0]!,
	// searches for the driftwood, then recalls the way to the fire from there and walks it, the room route when the
	// memory has none: correct, and it learns the way once a generation reached it
	`async function bot(){${ROUTE}${WALK}let s=await tools.look();let here=s.room.id;const order=[here];for(let i=0;i<order.length;i++)for(const d of Object.values(MAP[order[i]]||{}))if(!order.includes(d))order.push(d);for(const r of order){if(r!==here){for(const ex of route(here,r))await tools.act({line:ex});here=r;s=await tools.look()}const w=s.things.find(t=>t.name==="Treibholz");if(w){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"});break}}const m=await tools.recall();if(m.found&&m.distance<=3)here=await walk(m,false);for(const ex of route(here,"graue-bucht"))await tools.act({line:ex});${FEED}}`,
	// only replays the memory from where it starts, picking up what lies on the way: nothing in the first generation,
	// then the shown episodes whose way passes their driftwood, never a hidden one
	`async function bot(){${WALK}const m=await tools.recall();if(!m.found)return;await walk(m,true);let s;${FEED}}`,
	// wrong: goes to the fire without wood
	ISLAND_VARIANTS[4]!,
];

// ---- the fire of the Anleger (docs/codemode-planung.en.md, step 4) ---------------------------------------------
// The Feuerkorb am Anleger lies at the island's south end, behind the Dünen: from most rooms a way of several rooms. The
// episodes start the figure elsewhere each time and lay the driftwood out in another room; a plan names the subgoals on
// the way (driftwood, the Dünen, the fire's side, the fire burning).
export const ANLEGER_FIRE = { room: "anleger", x: 7, y: 5 };
export const ANLEGER_EPISODES: BotEpisode[] = [
	ep("S1", "sample", ["graue-bucht", 10, 8], ["duenen", 6, 4]),
	ep("S2", "sample", ["fischerdorf", 12, 8], ["torfmoor", 18, 3]),
	ep("S3", "sample", ["klippenkopf", 12, 8], ["salzwiesen", 5, 9]),
	ep("H1", "holdout", ["torfmoor", 12, 8], ["fischerdorf", 5, 5]),
	ep("H2", "holdout", ["salzwiesen", 12, 8], ["klippenpfad", 2, 8]),
	ep("H3", "holdout", ["anleger", 12, 8], ["graue-bucht", 5, 7]),
	ep("H4", "holdout", ["klippenpfad", 2, 8], ["klippenkopf", 13, 11]),
	ep("H5", "holdout", ["duenen", 12, 8], ["anleger", 15, 1]),
	ep("H6", "holdout", ["graue-bucht", 14, 9], ["torfmoor", 9, 2]),
];

/** The plans scripted agents pick from: one that finds the wood wherever it lies, one that expects it in the Dünen, one
 *  that goes to the fire first and fetches the wood after. */
export const ANLEGER_PLANS: Array<{ text: string; subgoals: Subgoal[] }> = [
	{ text: "Search the island for driftwood, nearest rooms first; then through the Dünen to the Anleger, next to the Feuerkorb, and feed it.", subgoals: [{ holds: "pack:treibholz" }, { room: "duenen" }, { room: "anleger", near: { x: 7, y: 5 } }, { room: "anleger", holds: "beacon:feuer-anleger" }] },
	{ text: "The driftwood washes up in the Dünen: take it there, go south to the Anleger and feed the Feuerkorb.", subgoals: [{ room: "duenen", holds: "pack:treibholz" }, { room: "anleger", near: { x: 7, y: 5 } }, { room: "anleger", holds: "beacon:feuer-anleger" }] },
	{ text: "Go to the Feuerkorb first to know the way, then search the island for driftwood and come back to feed it.", subgoals: [{ room: "anleger", near: { x: 7, y: 5 } }, { holds: "pack:treibholz" }, { room: "anleger", holds: "beacon:feuer-anleger" }] },
];

// FOLLOW walks a plan's subgoals in turn: to a subgoal's room by the island's route, next to its `near` cell, driftwood
// picked up where it says (in its room, or searched for room by room when it names none), the fire fed.
const SEARCH = `const take=async()=>{const s=await tools.look();const w=s.things.find(t=>t.name==="Treibholz");if(!w)return false;await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"});return true};const go=async(r)=>{for(const ex of route(here,r))await tools.act({line:ex});here=r};const search=async()=>{const order=[here];for(let i=0;i<order.length;i++)for(const d of Object.values(MAP[order[i]]||{}))if(!order.includes(d))order.push(d);for(const r of order){await go(r);if(await take())return true}return false};`;
const FEED_HERE = `const feed=async()=>{const s=await tools.look();const f=s.fires[0];if(!f)return;await tools.act({line:"move "+f.x+" "+(f.y-1)});await tools.act({line:"lege holz ins feuer"})};`;
export const ANLEGER_VARIANTS: string[] = [
	// follows the plan's subgoals; how far it gets is the plan's doing (no plan: to the fire without wood)
	`async function bot(){${ROUTE}let here=(await tools.look()).room.id;${SEARCH}${FEED_HERE}const {subgoals}=await tools.subgoals();if(!subgoals.length){await go("anleger");return feed()}for(const g of subgoals){if(g.room&&g.room!==here)await go(g.room);if(g.holds==="pack:treibholz"){if(g.room)await take();else await search();continue}if(g.holds&&g.holds.startsWith("beacon:")){await feed();continue}if(g.near)await tools.act({line:"move "+g.near.x+" "+(g.near.y-1)})}}`,
	// searches the island for the driftwood and goes to the Anleger, whatever the plan says: correct
	`async function bot(){${ROUTE}let here=(await tools.look()).room.id;${SEARCH}${FEED_HERE}await search();await go("anleger");await feed()}`,
	// wrong: goes to the fire without wood
	`async function bot(){${ROUTE}let here=(await tools.look()).room.id;${SEARCH}${FEED_HERE}await go("anleger");await feed()}`,
];

// ---- rate planners (docs/codemode-planung.en.md, step 5) ----------------------------------------------------------
// A harness task on the toy island (toyisland.ts): the contribution rates island bots by playing them. Each bad bot
// reaches every shown episode with seed 0 and no hold, so only a harness that runs fresh episodes, several seeds and a
// hold ranks it below the good ones; the hidden bad ones fail more narrowly still.
const FEED2 = `s=await tools.look();const f=s.fires[0];await tools.act({line:"move "+f.x+" "+(f.y-1)});await tools.act({line:"lege holz ins feuer"});`;
/** A bot that searches the rooms up to `depth` exits from its start, nearest first, then feeds the fire; `after` runs last. */
const searchBot = (depth: number, after = "", reverse = false) => `async function bot(){${ROUTE}let s=await tools.look();let here=s.room.id;const order=[here],dist={[here]:0};for(let i=0;i<order.length;i++)for(const d of Object.values(MAP[order[i]]||{})${reverse ? ".reverse()" : ""})if(!(d in dist)){dist[d]=dist[order[i]]+1;if(dist[d]<=${depth})order.push(d)}for(const r of order){if(r!==here){for(const ex of route(here,r))await tools.act({line:ex});here=r;s=await tools.look()}const w=s.things.find(t=>t.name==="Treibholz");if(w){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"});break}}for(const ex of route(here,"graue-bucht"))await tools.act({line:ex});${FEED2}${after}}`;
/** A bot that waits for the tide in the Graue Bucht instead of searching: `take` picks the piece up. */
const tideBot = (take: string) => `async function bot(){${ROUTE}let s=await tools.look();for(const ex of route(s.room.id,"graue-bucht"))await tools.act({line:ex});await tools.wait({minutes:60});${take}${FEED2}}`;

export const PLANNER_HARNESS: HarnessSpec = {
	target: "bot", runMs: 3000, world: "island",
	good: [{ label: "the reference (searches the whole island)", source: searchBot(99) }],
	bad: [
		{ label: "knows the shown episodes by heart", source: ISLAND_VARIANTS[2]! },
		{ label: "looks only in its start room and the next ones", source: searchBot(1) },
		{ label: "lets the fire go out right after", source: searchBot(99, `await tools.wait({minutes:9})`) },
		{ label: "waits for the tide where it lands with seed 0", source: tideBot(`await tools.act({line:"move 8 10"});await tools.act({line:"nimm treibholz"});`) },
	],
	hiddenGood: [
		{ label: "hidden good 1", source: ISLAND_VARIANTS[1]! },
		{ label: "hidden good 2", source: searchBot(99, "", true) },
	],
	hiddenBad: [
		{ label: "hidden bad 1", source: searchBot(2) },
		{ label: "hidden bad 2", source: searchBot(99, `await tools.wait({minutes:7})`) },
		{ label: "hidden bad 3", source: tideBot(`s=await tools.look();const w=s.things[0];if(w){await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"})}`) },
	],
};

// The scripted harnesses: two correct ones (every room's farthest piece with three seeds and a hold; the same with one
// seed per start, cheaper), and one blind to each lesson.
const FAR = `${ROUTE}const far=(a)=>{let best=a,n=0;for(const r of Object.keys(MAP)){const k=route(a,r).length;if(k>n){n=k;best=r}}return best};`;
const RATE = (episodes: string, seeds: string, hold: number) => `async function rate(){${FAR}let n=0;const eps=${episodes};for(const [i,e] of eps.entries())for(const seed of ${seeds}){const r=await tools.run({...e,seed,hold:${hold}});if(r.reached)n++}return n}`;
const FAR_EPS = `Object.keys(MAP).map(r=>({start:{room:r,x:12,y:8},wood:{room:far(r),x:5,y:5}}))`;
export const PLANNER_RATERS: string[] = [
	// correct: every start room, the wood in the room farthest from it, seeds 0 to 2, hold 5 (24 runs)
	RATE(FAR_EPS, "[0,1,2]", 5),
	// correct and cheaper: the same episodes, one seed each, in turn 0, 1, 2 (8 runs)
	`async function rate(){${FAR}let n=0;for(const [i,r] of Object.keys(MAP).entries()){const x=await tools.run({start:{room:r,x:12,y:8},wood:{room:far(r),x:5,y:5},seed:i%3,hold:5});if(x.reached)n++}return n}`,
	// wrong: only the shown episodes (the bot that knows them by heart, the one that looks near its start pass)
	RATE(`[{start:{room:"graue-bucht",x:10,y:8},wood:{room:"graue-bucht",x:5,y:7}},{start:{room:"fischerdorf",x:12,y:8},wood:{room:"fischerdorf",x:5,y:5}},{start:{room:"klippenpfad",x:2,y:8},wood:{room:"graue-bucht",x:17,y:9}}]`, "[0,1,2]", 5),
	// wrong: one seed (the tide waiter passes)
	RATE(FAR_EPS, "[0]", 5),
	// wrong: no hold (the bot that lets the fire go out passes)
	RATE(FAR_EPS, "[0,1,2]", 0),
	// wrong: the wood always in the start room (the near searcher passes)
	RATE(`Object.keys(MAP).map(r=>({start:{room:r,x:12,y:8},wood:{room:r,x:5,y:5}}))`, "[0,1,2]", 5),
];
