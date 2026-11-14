// Learn the tide (docs/codemode-planung.en.md, step 7): a planning task on made islands under TIDE_RULES (toyisland.ts).
// The tide follows a law the prompt does not tell: where it lands, in which order, at which minute. The judge logs every
// landing of the shown episodes as an observation in the block's memory (PlanMemory, goal "tide"); a bot of a later
// generation reads them with `observations()` and may fit its model of the tide to them. The hidden episodes lie on
// islands no shown episode enters, so only a law that speaks of an island's shape (not of its room ids) carries over.
import type { BotEpisode } from "./bottask.ts";
import { deadEnds, genIsland } from "./toyisland.ts";

/** Islands with at least two dead ends (rooms with one exit, the fire's room left out), from `from` on. */
export function tideIslands(from: number, n: number): number[] {
	const out: number[] = [];
	for (let i = from; out.length < n; i++) if (deadEnds(genIsland(i)).length >= 2) out.push(i);
	return out;
}
export const TIDE_SAMPLES = tideIslands(21, 3), TIDE_HIDDEN = tideIslands(TIDE_SAMPLES.at(-1)! + 1, 6);

const ep = (id: string, kind: BotEpisode["kind"], n: number): BotEpisode => {
	const w = genIsland(n), { start } = w.episode;
	return {
		id, kind, island: n, start,
		text: {
			de: `${w.name}: Start ${w.rooms[start.room]!.name} (${start.room}) (${start.x},${start.y}), kein Treibholz auf der Insel`,
			en: `${w.name}: start ${w.rooms[start.room]!.name} (${start.room}) (${start.x},${start.y}), no driftwood on the island`,
		},
	};
};
export const TIDE_EPISODES: BotEpisode[] = [
	...TIDE_SAMPLES.map((n, i) => ep(`S${i + 1}`, "sample", n)),
	...TIDE_HIDDEN.map((n, i) => ep(`H${i + 1}`, "holdout", n)),
];

// ---- the scripted bots ------------------------------------------------------------------------------------------
// What they share: the rooms seen and the exits crossed (G), each room's exits (EX), the exit cells (EC), the fire, the
// clock (`now`, world minutes, from look's and wait's time), a depth-first `explore`, a breadth-first `goTo`, `waitUntil`.
const BASE = `const OPP={nord:"süd","süd":"nord",ost:"west",west:"ost"};const G={},EX={},EC={};let fire=null,now=0,s=null;const clock=(t)=>{const m=/(\\d+):(\\d+)/.exec(t||"");if(m)now=(Number(m[1])-8)*60+Number(m[2])};const look=async()=>{s=await tools.look();clock(s.time);const r=s.room.id;G[r]??={};EX[r]=s.exits.map(e=>e.name);for(const e of s.exits)EC[e.name]={x:e.x,y:e.y};const f=s.fires.find(f=>f.name==="Leuchtfeuer");if(f)fire={room:r,x:f.x,y:f.y};return s};const here=()=>s.room.id;const cross=async(d)=>{const from=here(),known=new Set(Object.keys(G));await tools.act({line:d});await look();if(here()===from)return false;G[from][d]=here();if(OPP[d])G[here()][OPP[d]]=from;return !known.has(here())};const explore=async()=>{const r=here();for(const e of [...s.exits]){const d=e.name;if(!OPP[d]||G[r][d])continue;if(await cross(d))await explore();if(here()!==r)await cross(OPP[d])}};const route=(a,b)=>{const prev={[a]:null},q=[a];while(q.length){const r=q.shift();if(r===b)break;for(const [d,t] of Object.entries(G[r]||{}))if(!(t in prev)){prev[t]=[r,d];q.push(t)}}if(!(b in prev))return null;const out=[];for(let r=b;prev[r];r=prev[r][0])out.unshift(prev[r][1]);return out};const goTo=async(r)=>{for(const d of route(here(),r)||[])await cross(d)};const waitUntil=async(t)=>{t=Math.min(t,DAY);while(now<t){const w=await tools.wait({minutes:Math.min(120,t-now)});clock(w.time)}};const DAY=480,WALK=5,LIFE=30;const num=(id)=>Number((/-(\\d+)$/.exec(id)||[0,0])[1]);const feed=async()=>{await goTo(fire.room);await tools.act({line:"move "+fire.x+" "+(fire.y-1)});await tools.act({line:"lege holz ins feuer"})};const wood=()=>s.things.find(t=>t.name==="Treibholz");const take=async(w)=>{await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"})};`;

/** Plays a model of the tide: `rooms` (the rooms it lands in, in turn), `cellOf(room)` where, `offs` the minutes of the
 *  first piece it may come at (the seed picks one). Calibrated: it waits at the cell in 10-minute steps from the
 *  earliest to the latest and learns the world's minute from the first piece it sees; `calibrate: false` looks once at
 *  the earliest minute and goes on. */
const PLAY = (calibrate: boolean) => `const play=async(rooms,cellOf,offs)=>{if(!fire||!rooms.length)return;const lo=Math.min(...offs),hi=Math.max(...offs),k=rooms.length;let off=null,fed=0;for(let j=0;fed<3&&j<20;j++){const r=rooms[j%k],steps=(route(here(),r)||[]).length,arrive=now+steps*WALK;const first=(off??lo)+60*j,last=(off??hi)+60*j+LIFE-1;if(arrive>last)continue;if(first>DAY)break;await goTo(r);const c=cellOf(r);await tools.act({line:"move "+c.x+" "+c.y});let got=null;if(off!==null){await waitUntil(off+60*j);await look();got=wood()}else{${calibrate ? `for(let t=Math.max(lo+60*j,now);t<=hi+60*j&&t<=DAY;t+=10){await waitUntil(t);await look();got=wood();if(got){off=now-60*j;break}}` : `await waitUntil(lo+60*j);await look();got=wood()`}}if(!got)continue;await take(got);await feed();fed++}};`;
/** The law as an agent could write it after reading the observations: dead ends by number, 3 cells in from the exit. */
const LAW = `const inFrom=(r,n)=>{const e=EX[r][0],c=EC[e],d={nord:[0,-1],"süd":[0,1],ost:[1,0],west:[-1,0]}[e];return {x:c.x-d[0]*n,y:c.y-d[1]*n}};const dead=()=>Object.keys(EX).filter(r=>r!==fire?.room&&EX[r].length===1).sort((a,b)=>num(a)-num(b));`;

/** The law in code (an agent fitted it to the observations and wrote it down): correct on any island, any seed. */
const lawBot = `async function bot(){${BASE}${PLAY(true)}${LAW}await look();await explore();await play(dead(),(r)=>inFrom(r,3),[30,40,50])}`;
/** The same without calibration: it takes the first minute it saw for the only one (the lesson of several seeds). */
const lawNoCalibration = `async function bot(){${BASE}${PLAY(false)}${LAW}await look();await explore();await play(dead(),(r)=>inFrom(r,3),[30])}`;
/** Without a model: tours the island again and again and takes what it finds. */
const SEARCH = `let fed=0;const tour=[];const seen=new Set();const walk=(r)=>{seen.add(r);for(const [d,t] of Object.entries(G[r]||{}))if(!seen.has(t)){tour.push(d);walk(t);tour.push(OPP[d])}};walk(here());if(!tour.length)return;await waitUntil(30);for(let round=0;fed<3&&now<DAY&&round<12;round++)for(const d of tour){if(fed>=3||now+WALK>DAY)break;const w=wood();if(w){await take(w);await feed();fed++;break}await cross(d)}`;
/** Fits its model to the frozen observations: which rooms (one exit? never the fire's?), in which order (by number up
 *  or down, within each world's pieces), how far in from the exit, at which minutes. Without observations, or when
 *  none of its hypotheses fits, it does what the searcher does. */
const learnerBot = `async function bot(){${BASE}${PLAY(true)}const DIR={nord:[0,-1],"süd":[0,1],ost:[1,0],west:[-1,0]};const obs=(await tools.observations()).observations||[];await look();await explore();const fit=()=>{if(obs.length<2)return null;const one=obs.every(o=>o.exits.length===1),away=obs.every(o=>o.fromFire>0);if(!one)return null;const ns=new Set(obs.filter(o=>EC[o.exits[0]]).map(o=>{const c=EC[o.exits[0]];return Math.abs(o.x-c.x)+Math.abs(o.y-c.y)}));if(ns.size!==1)return null;const n=[...ns][0];const offs=[...new Set(obs.map(o=>o.minute-60*o.piece))];const worlds={};for(const o of obs)(worlds[o.island+"/"+o.seed]??=[]).push(o);const orderOk=(dir)=>Object.values(worlds).every(l=>{const rooms=[...new Set(l.map(o=>o.room))].sort((a,b)=>dir*(num(a)-num(b)));return l.every(o=>o.room===rooms[o.piece%rooms.length])||rooms.length<2});const dir=orderOk(1)?1:orderOk(-1)?-1:0;if(!dir)return null;const rooms=Object.keys(EX).filter(r=>EX[r].length===1&&(!away||r!==fire?.room)).sort((a,b)=>dir*(num(a)-num(b)));return {rooms,n,offs}};const m=fit();if(m){const cellOf=(r)=>{const e=EX[r][0],c=EC[e],d=DIR[e];return {x:c.x-d[0]*m.n,y:c.y-d[1]*m.n}};await play(m.rooms,cellOf,m.offs);return}${SEARCH}}`;
const searchBot = `async function bot(){${BASE}await look();await explore();${SEARCH}}`;
/** Remembers the observed rooms by their id: right on the shown islands, lost on any other. */
const replayBot = `async function bot(){${BASE}${PLAY(true)}const obs=(await tools.observations()).observations||[];await look();await explore();const rooms=[...new Set(obs.filter(o=>EX[o.room]).sort((a,b)=>a.piece-b.piece).map(o=>o.room))];const at={};for(const o of obs)at[o.room]={x:o.x,y:o.y};await play(rooms,(r)=>at[r],[...new Set(obs.map(o=>o.minute-60*o.piece))])}`;
/** Waits by the fire for what the tide brings there (as on the Graue Insel with seed 0). */
const camperBot = `async function bot(){${BASE}await look();await explore();if(!fire)return;await goTo(fire.room);let fed=0;while(fed<3&&now+30<=DAY){await waitUntil(now+30);await look();const w=wood();if(w){await take(w);await feed();fed++}}}`;

/** The scripted contributions: the learner first (it needs the observations of an earlier generation), the law in
 *  code, and the wrong ones. */
export const TIDE_VARIANTS: string[] = [
	// fits its model to the observations: from the second generation on, correct everywhere
	learnerBot,
	// the law in code: correct everywhere, from the first generation on
	lawBot,
	// wrong: the law without calibration (one seed's minute)
	lawNoCalibration,
	// wrong: the observed rooms by their id (the shown islands only)
	replayBot,
	// wrong: no model, tours the island
	searchBot,
	// wrong: waits by the fire
	camperBot,
];
