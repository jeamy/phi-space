async function bot(tt){
  const T=tt||(typeof tools!=="undefined"?tools:globalThis.tools);
  const opp={nord:"süd",süd:"nord",ost:"west",west:"ost"};
  function pt(v,old){
    if(typeof v==="number"&&isFinite(v))return v;
    if(typeof v==="string"){const m=v.match(/(\d+):(\d+)/);if(m)return (+m[1]-8)*60+(+m[2]);
      const n=parseFloat(v);if(isFinite(n))return n;}
    return old;
  }
  const G={},V={};let fireRoom=null,fire=null,held=0;
  let L=await T.look();let cur=L.room.id,time=pt(L.time,0);
  V[cur]=L;G[cur]={};
  if(L.fires&&L.fires.length){fireRoom=cur;fire=L.fires[0];}
  async function go(e){
    const r=await T.act({line:"go "+e});time+=5;
    const nr=r.at.room;G[cur][e]=nr;if(!G[nr])G[nr]={};G[nr][opp[e]]=cur;cur=nr;
  }
  async function grab(v){
    let x=v.at.x,y=v.at.y;
    for(const th of v.things||[]){if(!/treibholz/i.test(th.name))continue;
      if(th.x!==x||th.y!==y){await T.act({line:"move "+th.x+" "+th.y});x=th.x;y=th.y;}
      await T.act({line:"nimm treibholz"});held++;}
  }
  async function dfs(){
    const r=cur;
    for(const ex of V[r].exits){
      if(G[r][ex.name]!==undefined)continue;
      await go(ex.name);
      if(!V[cur]){const v=await T.look();V[cur]=v;time=pt(v.time,time);
        if(v.fires&&v.fires.length){fireRoom=cur;fire=v.fires[0];}
        await grab(v);await dfs();}
      await go(opp[ex.name]);
    }
  }
  await dfs();
  function bfs(from){const d={[from]:0},p={[from]:[]},q=[from];
    for(let i=0;i<q.length;i++){const r=q[i];for(const e in G[r]){const t=G[r][e];if(t!=null&&d[t]===undefined){d[t]=d[r]+1;p[t]=p[r].concat(e);q.push(t);}}}return {d,p};}
  const B={};for(const r in G)B[r]=bfs(r);
  async function walk(to){for(const e of B[cur].p[to]||[])await go(e);}
  const fd=fireRoom!=null?B[fireRoom].d:{};
  const W={},D=[];
  for(const r in G){if(r===fireRoom)continue;if(V[r].exits.length===1){W[r]=(fd[r]||1);D.push(r);}}
  for(let tide=30;tide<480;tide+=60){
    if(time>tide+25)continue;
    let best=null,bv=0,bc=1e9;
    const seq=[],used={};
    (function rec(pos,t,val,cost){
      if(seq.length&&(val>bv||(val===bv&&cost<bc))){bv=val;bc=cost;best=seq.slice();}
      if(seq.length>=6)return;
      for(const r of D){if(used[r])continue;const dd=B[pos].d[r];if(dd===undefined)continue;
        let a=t+dd*5;if(seq.length===0&&a<tide)a=tide;
        if(a>tide+29)continue;
        if(a+(fd[r]||0)*5>=480)continue;
        used[r]=1;seq.push(r);rec(r,a,val+W[r],cost+dd);seq.pop();used[r]=0;}
    })(cur,time,0,0);
    if(!best)continue;
    for(let i=0;i<best.length;i++){
      await walk(best[i]);
      if(time<tide){let w=tide-time;while(w>0){const m=Math.min(120,w);await T.wait({minutes:m});w-=m;}time=tide;}
      const v=await T.look();time=pt(v.time,time);
      if(time>tide+29)break;
      await grab(v);
    }
  }
  if(fireRoom!=null&&held>0){
    await walk(fireRoom);
    await T.act({line:"move "+fire.x+" "+(fire.y+1)});
    for(;held>0;held--)await T.act({line:"lege holz ins feuer"});
  }
}