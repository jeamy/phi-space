async function bot(){
  const OPP={nord:"süd",süd:"nord",ost:"west",west:"ost"};
  const pt=s=>{const m=/(\d+):(\d+)/.exec(s);return (+m[1]-8)*60+(+m[2]);};
  const lb=await tools.logbook({});
  const days=lb.days, nd=days.length||1, nt=(days[0]&&days[0].minutes.length)||8;
  const info={},ff={};let fire=null;
  for(const d of days)for(const r of d.rooms){
    if(!info[r.room])info[r.room]={exits:r.exits.slice(),cnt:0,pos:null};
    ff[r.room]=r.fromFire;
    if(r.fromFire===0)fire=r.room;
    for(const p of r.pieces){info[r.room].cnt++;if(!info[r.room].pos)info[r.room].pos={x:p.x,y:p.y};}
  }
  const P={};for(const k in info)P[k]=info[k].cnt/(nd*nt);
  const adj={};for(const k in info)adj[k]={};
  const rooms=Object.keys(info);
  let ch=true;
  while(ch){ch=false;
    for(const a of rooms)for(const e of info[a].exits){if(e in adj[a])continue;const oe=OPP[e];
      const c=rooms.filter(b=>b!==a&&info[b].exits.includes(oe)&&!(oe in adj[b])&&Math.abs(ff[b]-ff[a])===1);
      if(c.length!==1)continue;const b=c[0];
      const back=rooms.filter(x=>x!==b&&info[x].exits.includes(e)&&!(e in adj[x])&&Math.abs(ff[x]-ff[b])===1);
      if(back.length!==1||back[0]!==a)continue;
      adj[a][e]=b;adj[b][oe]=a;ch=true;}}
  let cur=null,now=0,carried=0;
  const st=await tools.look({});cur=st.room.id;now=pt(st.time);
  let px=st.at.x,py=st.at.y;
  if(!info[cur]){info[cur]={exits:st.exits.map(e=>e.name),cnt:0,pos:null};adj[cur]={};P[cur]=0;}
  const got={};
  async function collect(){
    const i=info[cur];if(!i||!i.pos||P[cur]<=0)return;
    if(now>=480)return;const key=cur+":"+Math.floor(now/60);
    if(now%60<30||got[key])return;got[key]=1;
    if(px!==i.pos.x||py!==i.pos.y){const m=await tools.act({line:"move "+i.pos.x+" "+i.pos.y});px=m.at.x;py=m.at.y;}
    const r=await tools.act({line:"nimm treibholz"});
    if(!/kein/i.test((r.said||[]).join(" ")))carried++;
  }
  async function go(d){
    const from=cur;const r=await tools.act({line:"go "+d});
    const to=r.at.room;px=r.at.x;py=r.at.y;
    if(to!==from){now+=5;
      const old=adj[from][d];if(old&&old!==to&&adj[old])delete adj[old][OPP[d]];
      adj[from][d]=to;if(!adj[to])adj[to]={};adj[to][OPP[d]]=from;cur=to;}
    else{ delete adj[from][d]; if(info[from])info[from].exits=info[from].exits.filter(x=>x!==d);}
  }
  function bfs(src){const dist={},prev={};dist[src]=0;const q=[src];
    for(let k=0;k<q.length;k++){const u=q[k];for(const d in adj[u]){const v=adj[u][d];if(dist[v]===undefined){dist[v]=dist[u]+1;prev[v]=[u,d];q.push(v);}}}
    return {dist,prev};}
  function pathTo(src,t,prev){const ds=[];let v=t;while(v!==src){const [u,d]=prev[v];ds.unshift(d);v=u;}return ds;}
  async function goTo(t){for(let g=0;g<20&&cur!==t;g++){const {dist,prev}=bfs(cur);if(dist[t]===undefined)return;await go(pathTo(cur,t,prev)[0]);}}
  while(now<400){
    const {dist,prev}=bfs(cur);let best=null;
    for(const r in dist){const i=info[r];if(!i)continue;
      if(i.exits.some(e=>!(e in adj[r]))&&(best===null||dist[r]<dist[best]))best=r;}
    if(best===null)break;
    await goTo(best);if(cur!==best)continue;
    const e=info[cur].exits.find(e=>!(e in adj[cur]));
    if(e)await go(e);
  }
  for(let T=30;T<=450;T+=60){
    if(now>=T+30)continue;
    const fd=bfs(fire).dist;
    const last=T+60>450;
    const {dist}=bfs(cur);
    let bv=-1,bw=null;
    for(const r0 in dist){
      if(now+dist[r0]*5>T+25)continue;
      const rec=(w)=>{
        const arr=Math.max(T,now+dist[r0]*5)+5*(w.length-1);
        if(arr>=T+30)return;
        const endR=w[w.length-1];
        if(!last||(fd[endR]!==undefined&&arr+5*fd[endR]<=480)){
          const s=new Set();let v=0;
          for(let i=0;i<w.length;i++){if(!s.has(w[i])){s.add(w[i]);v+=P[w[i]]||0;}}
          v-=w.length*1e-6;
          if(v>bv){bv=v;bw=w.slice();}
        }
        if(w.length>5)return;
        for(const d in adj[endR]){w.push(adj[endR][d]);rec(w);w.pop();}
      };
      rec([r0]);
    }
    if(!bw||bv<=0)continue;
    await goTo(bw[0]);if(cur!==bw[0])continue;
    if(now<T){const r=await tools.wait({minutes:T-now});now=pt(r.time);}
    await collect();
    for(let i=1;i<bw.length;i++){
      const u=cur;const d=Object.keys(adj[u]).find(k=>adj[u][k]===bw[i]);
      if(!d)break;await go(d);if(cur!==bw[i])break;await collect();
    }
  }
  if(carried>0&&cur!==fire){for(let g=0;g<20&&cur!==fire;g++){const {prev,dist}=bfs(cur);if(dist[fire]===undefined||now+5>480)break;await go(pathTo(cur,fire,prev)[0]);}}
  if(cur===fire&&carried>0){
    const l=await tools.look({});const f=l.fires[0];
    if(f){
      if(Math.max(Math.abs(l.at.x-f.x),Math.abs(l.at.y-f.y))!==1){
        const x=f.x<23?f.x+1:f.x-1;await tools.act({line:"move "+x+" "+f.y});}
      for(let i=0;i<carried;i++){const r=await tools.act({line:"lege holz ins feuer"});
        if(/kein|nicht/i.test((r.said||[]).join(" ")))break;}}
  }
  return carried;
}