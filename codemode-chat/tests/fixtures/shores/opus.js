async function bot(){
  const OPP={nord:'süd','süd':'nord',ost:'west',west:'ost'};
  const rid=r=>r&&typeof r==='object'?(r.id||r.name):r;
  const nm=e=>typeof e==='string'?e:(e&&(e.name||e.dir||e.exit))||'';
  const arr=x=>Array.isArray(x)?x:(typeof x==='string'?x.split(/[^a-zäöüß]+/i).filter(s=>s):[]);
  let L=await tools.logbook({});
  const days=(L&&L.days)||[];
  const P={},cell={},adj={},exs={};let fire=null;
  const addE=(a,d,b)=>{if(!adj[a])adj[a]=[];if(b==null||adj[a].some(x=>x.d===d))return;adj[a].push({d,to:b});};
  const paths={};
  for(const D of days)for(const R of (D.rooms||[])){
    const id=rid(R.room);
    if(!(id in P))P[id]=0;if(!adj[id])adj[id]=[];
    const pc=Array.isArray(R.pieces)?R.pieces:[];
    if(pc.length){P[id]++;cell[id]=[pc[0].x,pc[0].y];}
    const ffr=R.fromFire;
    if(Array.isArray(ffr)||typeof ffr==='string'){const ff=arr(ffr).map(nm);paths[id]=ff;if(!ff.length)fire=id;}
    else if(ffr===0)fire=id;
    const E=R.exits;
    if(Array.isArray(E)){exs[id]=E.map(nm).filter(s=>OPP[s]);
      for(const e of E)if(e&&typeof e==='object'){const to=e.to||e.room||e.target||e.dest;if(to!=null)addE(id,nm(e),rid(to));}}
    else if(E&&typeof E==='object'){exs[id]=Object.keys(E);for(const k in E)if(OPP[k])addE(id,k,rid(E[k]));}
    else if(typeof E==='string')exs[id]=arr(E).filter(s=>OPP[s]);
  }
  const nd=days.length||1;for(const k in P)P[k]/=nd;
  const key=p=>p.join('/');const byPath={};
  for(const id in paths)byPath[key(paths[id])]=id;
  for(const id in paths){const p=paths[id];if(!p.length)continue;const par=byPath[key(p.slice(0,-1))];
    if(par!==undefined){addE(par,p[p.length-1],id);addE(id,OPP[p[p.length-1]],par);}}
  let lk=await tools.look({});let cur=rid(lk.room),t=lk.time|0;
  if(fire==null&&lk.fires&&lk.fires.length)fire=cur;
  const ids0=Object.keys(P);
  let need=!ids0.length;
  for(const id of ids0){const ex=exs[id]||[];if(!ex.length||ex.some(d=>!adj[id].some(a=>a.d===d)))need=true;}
  if(need){
    const seen={};
    const go1=async d=>{const r=await tools.act({line:'go '+d});t+=5;return r&&r.at?rid(r.at.room):null;};
    const visit=async u=>{
      seen[u]=1;if(!(u in P))P[u]=0;if(!adj[u])adj[u]=[];
      let ex=exs[u];
      if(!ex||!ex.length){const l=await tools.look({});ex=(l.exits||[]).map(nm).filter(s=>OPP[s]);if(l.fires&&l.fires.length)fire=u;}
      for(const d of ex){if(adj[u].some(a=>a.d===d))continue;
        const v=await go1(d);if(v==null||v===u)continue;
        addE(u,d,v);addE(v,OPP[d],u);
        if(!seen[v])await visit(v);
        await go1(OPP[d]);
      }
    };
    await visit(cur);
  }
  if(fire!==null)P[fire]=0;
  const ids=Object.keys(P);
  function bfs(s){const dist={},prev={};dist[s]=0;const q=[s];
    for(let i=0;i<q.length;i++){const u=q[i];for(const e of adj[u]||[])if(!(e.to in dist)){dist[e.to]=dist[u]+1;prev[e.to]=[u,e.d];q.push(e.to);}}
    return {dist,prev};}
  const B={};for(const id of ids)B[id]=bfs(id);
  const dist=(a,b)=>{const d=B[a]&&B[a].dist[b];return d===undefined?99:d;};
  async function goTo(target){
    let guard=12;
    while(cur!==target&&guard--){
      const pc=B[cur];if(!pc||!(target in pc.dist))return;
      let x=target;while(pc.prev[x][0]!==cur)x=pc.prev[x][0];
      const r=await tools.act({line:'go '+pc.prev[x][1]});t+=5;
      if(r&&r.at&&r.at.room!=null)cur=rid(r.at.room);else cur=x;
    }
  }
  const bad=r=>/nicht|kein|zu weit/i.test(((r&&r.said)||[]).join(' '));
  let got=0;
  for(let k=0;k<8;k++){
    const tide=30+60*k;if(t>tide+25)continue;
    const last=k===7;
    let best=null,bv=0.0001;
    for(const s of ids){
      const dd=dist(cur,s);if(dd>=99)continue;
      const start=Math.max(t+dd*5,tide+1);
      if(start>tide+5)continue;
      const maxLen=Math.min(5,Math.floor((tide+29-start)/5));
      const walk=[s];
      const dfs=(u,len,val,seen)=>{
        if(!last||start+5*len+5*dist(u,fire)<=479){if(val>bv){bv=val;best={s,w:walk.slice()};}}
        if(len>=maxLen)return;
        for(const e of adj[u]||[]){walk.push(e.to);const n=!seen.includes(e.to);
          dfs(e.to,len+1,val+(n?P[e.to]:0),n?seen.concat(e.to):seen);walk.pop();}
      };
      dfs(s,0,P[s],[s]);
    }
    if(!best)continue;
    await goTo(best.s);
    if(t<tide+1){await tools.wait({minutes:tide+1-t});t=tide+1;}
    const done={};
    for(let i=0;i<best.w.length;i++){
      const r=best.w[i];
      if(i>0)await goTo(r);
      if(cur!==r)break;
      if(done[r]||!(P[r]>0)||!cell[r])continue;done[r]=1;
      let cx=cell[r][0],cy=cell[r][1];
      if(P[r]<0.5){
        const l=await tools.look({});
        const th=(l.things||[]).find(x=>/holz/i.test(x.name));
        if(!th)continue;cx=th.x;cy=th.y;
      }
      await tools.act({line:'move '+cx+' '+cy});
      const rr=await tools.act({line:'nimm treibholz'});
      if(!bad(rr))got++;
    }
  }
  if(!got||fire===null)return;
  await goTo(fire);
  lk=await tools.look({});
  let n=0;for(const p of lk.pack||[])if(/holz/i.test(p.name))n+=p.count;
  if(!n||!lk.fires||!lk.fires.length)return;
  const f=lk.fires[0];
  const nb=[[0,1],[1,0],[0,-1],[-1,0],[1,1],[-1,-1],[1,-1],[-1,1]];
  for(const [dx,dy] of nb){
    await tools.act({line:'move '+(f.x+dx)+' '+(f.y+dy)});
    let r=await tools.act({line:'lege holz ins feuer'});
    if(bad(r))continue;
    n--;
    while(n>0){r=await tools.act({line:'lege holz ins feuer'});if(bad(r))break;n--;}
    if(n<=0)return;
  }
}