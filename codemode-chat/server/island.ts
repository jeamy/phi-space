// The island bot (docs/codemode-planung.en.md, step 1): the first planning task. Its episodes start the figure in the
// rooms of the Graue Insel of spaces-mmo's world Leuchtfeuer and lay out the island's only piece of driftwood; the goal
// is always the beacon of the Graue Bucht. The rooms, exits and cells are those of spaces-mmo/worlds/leuchtfeuer
// (world.json); spaces-mmo/tests/arena.test.ts opens the episodes in the real world.
import type { BotEpisode } from "./bottask.ts";

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
