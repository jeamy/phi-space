// Odds of the tide (docs/codemode-planung.en.md, step 8): a planning task on made islands under CHANCE_RULES
// (toyisland.ts). Every hour at half past, each dead end of the island gets a piece of driftwood or not, by odds that
// follow the island's shape (chanceOf); the prompt does not tell the odds. A piece lies 30 minutes, so a bot can reach
// only a few dead ends in an hour: the best it can do is the round whose expected number of pieces is highest. The
// verdict asks the mean over 8 seeds per episode, against a target of 90 % of what the law bot's round brings there.
// The judge logs each day of the tide in the shown episodes (every room, with the pieces it got) as observations; a bot
// reads them with `observations()` and may estimate the odds from them.
import type { BotEpisode } from "./bottask.ts";
import { genIsland } from "./toyisland.ts";

/** The seeds an episode runs with: enough that the mean says more than luck. */
export const CHANCE_SEEDS = 8;

const ep = (id: string, kind: BotEpisode["kind"], n: number, target: number): BotEpisode => {
	const w = genIsland(n), { start } = w.episode, num = (x: number) => String(x).replace(".", ",");
	return {
		id, kind, island: n, start, target,
		text: {
			de: `${w.name}: Start ${w.rooms[start.room]!.name} (${start.room}) (${start.x},${start.y}), Ziel: im Mittel mindestens ${num(target)} Stück im Feuer`,
			en: `${w.name}: start ${w.rooms[start.room]!.name} (${start.room}) (${start.x},${start.y}), goal: at least ${target} pieces in the fire on average`,
		},
	};
};

// ---- the scripted bots ------------------------------------------------------------------------------------------
// What they share: the rooms seen and the exits crossed (G), each room's exits (EX), the exit cells (EC), the fire, the
// clock (`now`, world minutes since 8:00), a depth-first `explore`, a breadth-first `goTo`, `waitUntil`, `take` (the
// piece at a room's landing cell, if one lies there), `feedAll` (every piece carried into the fire at the end). A
// crossing is one `act`; the clock goes on 5 minutes by itself, and only a room never seen is looked at.
const BASE = `const OPP={nord:"süd","süd":"nord",ost:"west",west:"ost"},DIR={nord:[0,-1],"süd":[0,1],ost:[1,0],west:[-1,0]};const G={},EX={},EC={};let fire=null,now=0,cur=null,held=0;const DAY=480,WALK=5,LIFE=30;const clock=(t)=>{const m=/(\\d+):(\\d+)/.exec(t||"");if(m)now=(Number(m[1])-8)*60+Number(m[2])};const look=async()=>{const s=await tools.look();clock(s.time);cur=s.room.id;G[cur]??={};EX[cur]=s.exits.map(e=>e.name);for(const e of s.exits)EC[e.name]={x:e.x,y:e.y};const f=s.fires.find(f=>f.name==="Leuchtfeuer");if(f)fire={room:cur,x:f.x,y:f.y};return s};const go=async(d)=>{const from=cur;const a=await tools.act({line:d});if(!a.at||a.at.room===from)return false;now+=WALK;cur=a.at.room;if(!(cur in G))await look();G[from][d]=cur;if(OPP[d])G[cur][OPP[d]]??=from;return true};const explore=async()=>{const r=cur;for(const d of [...EX[r]]){if(!OPP[d]||G[r][d])continue;const known=new Set(Object.keys(G));if(!(await go(d)))continue;if(!known.has(cur))await explore();if(cur!==r)await go(OPP[d])}};const route=(a,b)=>{const prev={[a]:null},q=[a];while(q.length){const r=q.shift();if(r===b)break;for(const [d,t] of Object.entries(G[r]||{}))if(!(t in prev)){prev[t]=[r,d];q.push(t)}}if(!(b in prev))return null;const out=[];for(let r=b;prev[r];r=prev[r][0])out.unshift(prev[r][1]);return out};const dist=(a,b)=>{const r=route(a,b);return r?r.length:99};const goTo=async(r)=>{for(const d of route(cur,r)||[])if(!(await go(d)))return};const waitUntil=async(t)=>{t=Math.min(t,DAY);while(now<t){const w=await tools.wait({minutes:Math.min(120,t-now)});clock(w.time)}};const cellIn=(r,n)=>{const e=EX[r][0],c=EC[e],d=DIR[e];return {x:c.x-d[0]*n,y:c.y-d[1]*n}};let IN=3;const take=async(r)=>{const c=cellIn(r,IN);await tools.act({line:"move "+c.x+" "+c.y});const a=await tools.act({line:"nimm treibholz"});if((a.said||[]).some(x=>/hebst/.test(x)))held++};const feedAll=async()=>{if(!fire||!held)return;await goTo(fire.room);await tools.act({line:"move "+fire.x+" "+(fire.y-1)});while(held>0){await tools.act({line:"lege holz ins feuer"});held--}};const dead=()=>Object.keys(EX).filter(r=>r!==fire?.room&&EX[r].length===1).sort();`;

/** The round with the most expected pieces: dead ends in an order whose walk from the first to the last takes at most
 *  `reach` exits (a piece lies 30 minutes, an exit takes 5), valued by `val`; on a tie the shorter one. */
const TOUR = `const bestTour=(rooms,val,reach=5)=>{let best=null;const rec=(t,len)=>{if(t.length){const v=t.reduce((a,r)=>a+val(r),0);if(!best||v>best.v+1e-9||(Math.abs(v-best.v)<1e-9&&len<best.len))best={t:[...t],len,v}}for(const r of rooms)if(!t.includes(r)){const l=t.length?len+dist(t[t.length-1],r):0;if(l<=reach)rec([...t,r],l)}};rec([],0);return best};`;

/** Plays a round every hour: at the first room when the tide comes, then on to the others while the pieces lie; the
 *  last round the day still allows to carry its pieces home, then every piece into the fire. */
const PLAY = `const play=async(tour,minutes)=>{if(!fire||!tour||!tour.t.length){await feedAll();return}const T=tour.t;for(const land of minutes){const back=dist(T[T.length-1],fire.room)*WALK;if(land+tour.len*WALK+back>DAY)break;if(now+dist(cur,T[0])*WALK>land+LIFE-1){await goTo(T[0]);continue}await goTo(T[0]);await waitUntil(land);for(const [k,r] of T.entries()){if(k)await goTo(r);if(now>land+LIFE-1)break;await take(r)}}await feedAll()};`;

/** The odds as the law gives them: 0.15 for each exit between a dead end and the fire, at most 0.9. */
const LAW = `const odds=(r)=>Math.min(0.9,0.15*dist(r,fire.room));const MINUTES=[30,90,150,210,270,330,390,450];`;

/** The law in code: the round with the most expected pieces, on any island. */
const lawBot = `async function bot(){${BASE}${TOUR}${PLAY}${LAW}await look();await explore();if(!fire)return;await play(bestTour(dead(),odds),MINUTES)}`;

/** Estimates the odds from the observations: per kind of room (one exit or more, how far from the fire) the pieces it
 *  got over the times the tide came; then which law fits better, the same odds for every dead end or odds that grow
 *  with the distance from the fire (fitted by its slope), and how far in from the exit pieces lie. Without
 *  observations it knows nothing of the odds and takes every room alike, at half past every hour. */
const learnerBot = `async function bot(){${BASE}${TOUR}${PLAY}const obs=((await tools.observations()).observations||[]).filter(o=>o&&Array.isArray(o.rooms));await look();await explore();if(!fire)return;const near=(r)=>dist(r,fire.room);if(!obs.length){const all=Object.keys(EX).filter(r=>r!==fire.room);await play(bestTour(all,()=>1),[30,90,150,210,270,330,390,450]);return}let hitsD=0,oppD=0,hitsO=0,oppO=0,sumDO=0;const by={};const ins=[];for(const o of obs){const n=o.minutes.length;for(const r of o.rooms){const isDead=r.exits.length===1&&r.fromFire>0,h=r.pieces.length;if(isDead){hitsD+=h;oppD+=n;sumDO+=r.fromFire*n;const k=r.fromFire;by[k]??={h:0,n:0};by[k].h+=h;by[k].n+=n}else{hitsO+=h;oppO+=n}for(const p of r.pieces){const e=r.exits[0],c=EC[e];if(c)ins.push(Math.abs(p.x-c.x)+Math.abs(p.y-c.y))}}}const c=hitsD/Math.max(1,oppD),k=hitsD/Math.max(1,sumDO);const ll=(p)=>Object.entries(by).reduce((a,[d,b])=>{const q=Math.min(0.999,Math.max(0.001,p(Number(d))));return a+b.h*Math.log(q)+(b.n-b.h)*Math.log(1-q)},0);const lin=(d)=>Math.min(0.9,k*d),flat=()=>c;const law=ll(lin)>=ll(flat)?lin:flat;if(ins.length)IN=Math.round(ins.reduce((a,b)=>a+b,0)/ins.length);const others=hitsO/Math.max(1,oppO);const odds=(r)=>EX[r].length===1&&r!==fire.room?law(near(r)):others;const minutes=[...new Set(obs.flatMap(o=>o.minutes))].sort((a,b)=>a-b);const rooms=Object.keys(EX).filter(r=>r!==fire.room&&odds(r)>0.01);await play(bestTour(rooms,odds),minutes)}`;

/** Counts instead of rates: values a dead end by how many pieces rooms of its distance got in the observations, not
 *  by how often they got one. A distance many rooms share looks better than it is, one never observed looks empty. */
const countsBot = `async function bot(){${BASE}${TOUR}${PLAY}const obs=((await tools.observations()).observations||[]).filter(o=>o&&Array.isArray(o.rooms));await look();await explore();if(!fire)return;const count={};for(const o of obs)for(const r of o.rooms)if(r.exits.length===1&&r.fromFire>0)count[r.fromFire]=(count[r.fromFire]||0)+r.pieces.length;const odds=(r)=>count[dist(r,fire.room)]||0;await play(bestTour(dead(),odds),[30,90,150,210,270,330,390,450])}`;

/** The most likely dead end, every hour: it maximises the chance of a piece, not the number of pieces. */
const modeBot = `async function bot(){${BASE}${TOUR}${PLAY}${LAW}await look();await explore();if(!fire)return;const d=dead();if(!d.length)return;const top=d.reduce((a,b)=>odds(b)>odds(a)?b:a);await play({t:[top],len:0},MINUTES)}`;

/** Every dead end, every hour, in the order of their names: the round is longer than a piece lies. */
const sweepBot = `async function bot(){${BASE}${TOUR}${PLAY}${LAW}await look();await explore();if(!fire)return;const T=dead();let len=0;for(let i=1;i<T.length;i++)len+=dist(T[i-1],T[i]);await play({t:T,len},MINUTES)}`;

/** The law of step 7: one dead end an hour, in turn by number. */
const rotationBot = `async function bot(){${BASE}${LAW}await look();await explore();if(!fire)return;const num=(id)=>Number((/-(\\d+)$/.exec(id)||[0,0])[1]);const T=dead().sort((a,b)=>num(a)-num(b));if(!T.length)return;for(const [j,land] of MINUTES.entries()){const r=T[j%T.length];if(land+dist(r,fire.room)*WALK>DAY)break;if(now+dist(cur,r)*WALK>land+LIFE-1)continue;await goTo(r);await waitUntil(land);await take(r)}await feedAll()}`;

/** Remembers the rooms where pieces lay in the observations, by their id: right on the shown islands, lost on others. */
const replayBot = `async function bot(){${BASE}${TOUR}${PLAY}const obs=((await tools.observations()).observations||[]).filter(o=>o&&Array.isArray(o.rooms));await look();await explore();if(!fire)return;const got={};for(const o of obs)for(const r of o.rooms)got[r.room]=(got[r.room]||0)+r.pieces.length;const rooms=Object.keys(EX).filter(r=>got[r]);await play(bestTour(rooms,(r)=>got[r]),[30,90,150,210,270,330,390,450])}`;

/** The scripted contributions: the learner first (it needs the observations of an earlier generation), the law in
 *  code, and the wrong ones, each wrong for one reason. */
export const CHANCE_VARIANTS: string[] = [
	// estimates the odds from the observations: from the second generation on, near the best everywhere
	learnerBot,
	// the law in code: near the best everywhere, from the first generation on
	lawBot,
	// wrong: counts landings instead of rates
	countsBot,
	// wrong: the most likely dead end only
	modeBot,
	// wrong: every dead end every hour
	sweepBot,
	// wrong: step 7's law, one dead end an hour in turn
	rotationBot,
	// wrong: the observed rooms by their id
	replayBot,
];
export const CHANCE_BOTS = { learnerBot, lawBot, countsBot, modeBot, sweepBot, rotationBot, replayBot };

/** The episodes of the given islands and targets. */
export function chanceEpisodes(samples: Array<[number, number]>, hidden: Array<[number, number]>): BotEpisode[] {
	return [...samples.map(([n, t], i) => ep(`S${i + 1}`, "sample", n, t)), ...hidden.map(([n, t], i) => ep(`H${i + 1}`, "holdout", n, t))];
}

/** The shown and the hidden islands with their targets: 90 % of the law bot's mean over the 8 seeds, rounded down to
 *  an eighth. The shown three have dead ends 1, 2 and 4 exits from the fire, many at 2 and none at 3, so counting
 *  landings misleads and only a rate per chance carries to distances never shown. Of 100 islands from 34 to 160 with
 *  two dead ends or more, the learner with these observations reached the target on every one; the six hidden ones are
 *  those on which every wrong bot fails at least once (tests/bots.test.ts holds this). */
export const CHANCE_SAMPLES: Array<[number, number]> = [[36, 4.875], [154, 4.25], [77, 6.375]];
export const CHANCE_HIDDEN: Array<[number, number]> = [[40, 4.875], [60, 4.125], [78, 7.625], [151, 8.375], [38, 6.75], [47, 8.5]];
export const CHANCE_EPISODES: BotEpisode[] = chanceEpisodes(CHANCE_SAMPLES, CHANCE_HIDDEN);
