// Shores of the tide (docs/codemode-planung.en.md, step 9): the chance tide of step 8, but the odds belong to each room
// of each island (toyisland.ts shoreOf), not to the island's shape: no law carries from one island to the next. What
// carries is a way to learn them: the harbour master's logbook (`logbook()`) lists earlier days of the tide on the
// bot's own island, so a bot that estimates each room's odds from it, at run time, can plan the round with the most
// expected pieces on any island; a bot that brings a law or a prior of its own cannot. The verdict asks the mean over 8
// seeds per episode against a target of 90 % of what the reference plan brings (the same round, with the true odds).
import type { BotEpisode } from "./bottask.ts";
import { BASE, TOUR } from "./chance.ts";
import { genIsland, shoreCell, shoreOf, shoreRooms } from "./toyisland.ts";

/** The seeds an episode runs with, as in step 8. */
export const SHORE_SEEDS = 8;

const ep = (id: string, kind: BotEpisode["kind"], n: number, target: number, maxCost?: number): BotEpisode => {
	const w = genIsland(n), { start } = w.episode, num = (x: number) => String(x).replace(".", ",");
	return {
		id, kind, island: n, start, target, ...(maxCost !== undefined ? { maxCost } : {}),
		text: {
			de: `${w.name}: Start ${w.rooms[start.room]!.name} (${start.room}) (${start.x},${start.y}), Ziel: im Mittel mindestens ${num(target)} Stück im Feuer${maxCost !== undefined ? `, höchstens ${maxCost} Punkte über alle Seeds` : ""}`,
			en: `${w.name}: start ${w.rooms[start.room]!.name} (${start.room}) (${start.x},${start.y}), goal: at least ${target} pieces in the fire on average${maxCost !== undefined ? `, at most ${maxCost} points over all seeds` : ""}`,
		},
	};
};

// ---- the scripted bots ------------------------------------------------------------------------------------------
// Step 8's BASE and TOUR (explore, goTo, waitUntil, feedAll, bestTour), and a round that takes a piece with `grab`:
// `grabAt` walks to the cell the logbook named for the room, `grabLook` looks and takes what it sees.
const MINUTES = `const MINUTES=[30,90,150,210,270,330,390,450];const CELL={};`;
const GRAB = `const nimm=async()=>{const a=await tools.act({line:"nimm treibholz"});if((a.said||[]).some(x=>/hebst/.test(x)))held++};const grabLook=async(r)=>{const s=await tools.look();clock(s.time);for(const t of (s.things||[]).filter(t=>/treibholz/i.test(t.name))){await tools.act({line:"move "+t.x+" "+t.y});await nimm()}};const grabAt=async(r)=>{const c=CELL[r];if(!c)return grabLook(r);await tools.act({line:"move "+c.x+" "+c.y});await nimm()};`;
const PLAY = `const play=async(tour,minutes,grab)=>{if(!fire||!tour||!tour.t.length){await feedAll();return}const T=tour.t;for(const land of minutes){const back=dist(T[T.length-1],fire.room)*WALK;if(land+tour.len*WALK+back>DAY)break;if(now+dist(cur,T[0])*WALK>land+LIFE-1){await goTo(T[0]);continue}await goTo(T[0]);await waitUntil(land);for(const [k,r] of T.entries()){if(k)await goTo(r);if(now>land+LIFE-1)break;await grab(r)}}await feedAll()};`;
/** Reads the logbook: each room's hits over the times the tide came (a rate, not a count), and the cell its pieces lay on. */
const LOG = `const readLog=async()=>{const days=((await tools.logbook())||{}).days||[];const H={};let n=0;for(const d of days){n+=(d.minutes||[]).length;for(const r of d.rooms||[])for(const p of r.pieces||[]){H[r.room]=(H[r.room]||0)+1;CELL[r.room]={x:p.x,y:p.y}}}return (r)=>(H[r]||0)/Math.max(1,n)};`;
const HEAD = `${BASE}${TOUR}${MINUTES}${GRAB}${PLAY}`;

/** Learns from the logbook: every room's odds as its rate over the logged days, then the round with the most expected pieces. */
const learnerBot = `async function bot(){${HEAD}${LOG}const rate=await readLog();await look();await explore();if(!fire)return;const rooms=Object.keys(EX).filter(r=>r!==fire.room&&rate(r)>0.01);await play(bestTour(rooms,rate),MINUTES,grabAt)}`;

/** The reference plan of an island: the same round, with the true odds and cells written in (the judge's yardstick). */
export function referenceBot(n: number): string {
	const w = genIsland(n), odds = Object.fromEntries(shoreRooms(w).map((r) => [r, shoreOf(w, r)])), cells = Object.fromEntries(shoreRooms(w).map((r) => [r, shoreCell(w, r)]));
	return `async function bot(){${HEAD}const ODDS=${JSON.stringify(odds)};Object.assign(CELL,${JSON.stringify(cells)});await look();await explore();if(!fire)return;const rooms=Object.keys(EX).filter(r=>(ODDS[r]||0)>0);await play(bestTour(rooms,(r)=>ODDS[r]||0),MINUTES,grabAt)}`;
}

/** The learner's round with Jev as the estimator: each room's odds as Jev read them from the logbook
 *  (server/data/fetch-shore-jev.ts records them, the bot carries them written in); the cells from the logbook. */
export function jevShoreBot(odds: Record<string, number>): string {
	return `async function bot(){${HEAD}${LOG}const ODDS=${JSON.stringify(odds)};await readLog();await look();await explore();if(!fire)return;const rooms=Object.keys(EX).filter(r=>r!==fire.room&&(ODDS[r]||0)>0);await play(bestTour(rooms,(r)=>ODDS[r]||0),MINUTES,grabAt)}`;
}

/** Wrong: step 8's law, the dead ends by their distance from the fire. */
const lawOfStep8Bot = `async function bot(){${HEAD}await look();await explore();if(!fire)return;await play(bestTour(dead(),(r)=>Math.min(0.9,0.15*dist(r,fire.room))),MINUTES,grabLook)}`;
/** Wrong: every room but the fire's, every hour, in the order of their names. */
const sweepBot = `async function bot(){${HEAD}await look();await explore();if(!fire)return;const T=Object.keys(EX).filter(r=>r!==fire.room).sort();let len=0;for(let i=1;i<T.length;i++)len+=dist(T[i-1],T[i]);await play({t:T,len},MINUTES,grabLook)}`;
/** Wrong: reads the logbook, but keeps step 8's prior that only dead ends get pieces. */
const deadOnlyBot = `async function bot(){${HEAD}${LOG}const rate=await readLog();await look();await explore();if(!fire)return;await play(bestTour(dead().filter(r=>rate(r)>0.01),rate),MINUTES,grabAt)}`;
/** Wrong: the most likely room only, every hour. */
const modeBot = `async function bot(){${HEAD}${LOG}const rate=await readLog();await look();await explore();if(!fire)return;const rooms=Object.keys(EX).filter(r=>r!==fire.room);if(!rooms.length)return;const top=rooms.reduce((a,b)=>rate(b)>rate(a)?b:a);await play({t:[top],len:0},MINUTES,grabAt)}`;
/** Wrong: no logbook, every room alike. */
const uniformBot = `async function bot(){${HEAD}await look();await explore();if(!fire)return;await play(bestTour(Object.keys(EX).filter(r=>r!==fire.room),()=>1),MINUTES,grabLook)}`;

/** The scripted contributions: the learner, and the wrong ones, each wrong for one reason. */
export const SHORE_VARIANTS: string[] = [learnerBot, lawOfStep8Bot, sweepBot, deadOnlyBot, modeBot, uniformBot];
export const SHORE_BOTS = { learnerBot, lawOfStep8Bot, sweepBot, deadOnlyBot, modeBot, uniformBot };

/** The episodes of the given islands, targets and point limits. */
export function shoreEpisodes(samples: Array<[number, number, number?]>, hidden: Array<[number, number, number?]>): BotEpisode[] {
	return [...samples.map(([n, t, c], i) => ep(`S${i + 1}`, "sample", n, t, c)), ...hidden.map(([n, t, c], i) => ep(`H${i + 1}`, "holdout", n, t, c))];
}
/** The shown and the hidden islands with their targets: 90 % of the reference plan's mean over the 8 seeds, rounded
 *  down to an eighth. Of 104 islands from 34 to 233 with two rooms of odds 0.35 or more, the learner reached the target
 *  on 103; the scripted wrong bots on 0 to 56, the three model winners of step 8 on 0 to 3. These nine are islands on
 *  which every wrong bot and every winner fails and the learner passes with a margin (tests/bots.test.ts holds it).
 *  No point limit: the bots that fail spend no more points than the reference, most of them fewer. */
export const SHORE_SAMPLES: Array<[number, number, number?]> = [[52, 5.5], [64, 12.875], [148, 8]];
export const SHORE_HIDDEN: Array<[number, number, number?]> = [[72, 11.75], [75, 9.875], [105, 6.75], [140, 13.375], [176, 8.875], [222, 5.5]];
export const SHORE_EPISODES: BotEpisode[] = shoreEpisodes(SHORE_SAMPLES, SHORE_HIDDEN);
