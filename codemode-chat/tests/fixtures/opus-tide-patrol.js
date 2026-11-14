async function bot(){
  const T=tools;const opp={nord:'süd','süd':'nord',ost:'west',west:'ost'};
  const rid=x=>(x&&typeof x==='object')?x.id:x;
  let calls=0,cur,fireRoom=null,fire=null,held=0,put=0,time=0;const G={};
  const tm=t=>{if(typeof t==='number')return t;const m=/(\d+):(\d+)/.exec(String(t));return m?(+m[1]-8)*60+(+m[2]):time;};
  const cnt=l=>{let c=0;for(const p of (l.pack||[]))if(/holz/i.test(p.name))c+=p.count||1;return c;};
  const look=async()=>{calls++;return await T.look({});};
  const act=async s=>{calls++;return await T.act({line:s});};
  const hist=new Float64Array(16);
  try{calls++;const o=await T.observations({});for(const r of (o.observations||[])){let d=r.fromFire;d=Array.isArray(d)?d.length:(typeof d==='number'?d:-1);if(d>=0&&d<16)hist[d]++;}}catch(e){}
  let hs=0;for(let i=0;i<16;i++)hs+=hist[i];
  function rec(l){cur=rid(l.room);if(!G[cur])G[cur]={ex:{},seen:-99};G[cur].exits=l.exits;
    for(const e of l.exits)if(!(e.name in G[cur].ex))G[cur].ex[e.name]=null;
    if(l.fires&&l.fires.length){fireRoom=cur;fire=l.fires[0];}time=tm(l.time);G[cur].seen=time;held=cnt(l);}
  async function scan(){let L=await look();rec(L);let got=false;
    for(const t of L.things)if(/treibholz/i.test(t.name)&&held+put<3){await act('move '+t.x+' '+t.y);await act('nimm treibholz');got=true;held++;}
    if(got){L=await look();rec(L);}}
  async function go(d){const from=cur;const e=(G[from].exits||[]).find(x=>x.name==d);
    let r=await act(d);
    if(rid(r.at.room)==from&&e){await act('move '+e.x+' '+e.y);r=await act(d);}
    const to=rid(r.at.room);
    if(to!=from){time+=5;G[from].ex[d]=to;if(!G[to])G[to]={ex:{},seen:-99};G[to].ex[opp[d]]=from;cur=to;return true;}
    G[from].ex[d]='x';return false;}
  function bfs(src){const prev={};prev[src]=null;const q=[src];let i=0;
    while(i<q.length){const u=q[i++];const n=G[u];if(!n)continue;for(const d in n.ex){const v=n.ex[d];
      if(v==null||v==='x'||v in prev)continue;prev[v]=[u,d];q.push(v);}}return prev;}
  function path(prev,t){if(!(t in prev))return null;const p=[];let v=t;while(prev[v]){p.unshift(prev[v][1]);v=prev[v][0];}return p;}
  function homeCost(){if(fireRoom==null)return 0;const p=path(bfs(cur),fireRoom);return p?p.length*5:0;}
  async function deliver(){
    if(fireRoom==null||held<=0)return;
    const p=path(bfs(cur),fireRoom);if(!p)return;
    for(const d of p){if(!(await go(d)))return;}
    const L=await look();rec(L);if(!fire)return;
    const sq=[[1,0],[0,1],[-1,0],[0,-1]];
    for(const [dx,dy] of sq){if(held<=0||calls>292)break;
      await act('move '+(fire.x+dx)+' '+(fire.y+dy));
      while(held>0&&calls<294){await act('lege holz ins feuer');const l=await look();const h=cnt(l);
        if(h<held){put+=held-h;held=h;}else break;}
    }
  }
  await scan();
  // explore
  for(let guard=0;guard<60&&calls<200&&put<3;guard++){
    if(held+put>=3){await deliver();continue;}
    if(time+homeCost()>470){await deliver();break;}
    let target=null,dir=null;
    if(G[cur].ex)for(const d in G[cur].ex)if(G[cur].ex[d]===null){dir=d;break;}
    if(dir){if(await go(dir))await scan();continue;}
    const prev=bfs(cur);let best=null,bl=1e9;
    for(const r in prev){const n=G[r];for(const d in n.ex)if(n.ex[d]===null){const p=path(prev,r);if(p&&p.length<bl){bl=p.length;best=p;}}}
    if(!best)break;
    for(const d of best){if(!(await go(d)))break;await scan();}
  }
  // distances from fire
  const fd={};if(fireRoom!=null){const pr=bfs(fireRoom);for(const r in pr)fd[r]=path(pr,r).length;}
  while(put<3&&calls<285){
    if(held+put>=3){await deliver();continue;}
    if(time+homeCost()>465){await deliver();break;}
    const prev=bfs(cur);let best=null,bs=-1;
    for(const r in prev){if(r==cur)continue;const p=path(prev,r);const d=fd[r];
      const w=hs>0?(0.15+(d!=null&&d<16?hist[d]:0)/hs):1;
      const s=w*(time-G[r].seen+1)/p.length;if(s>bs){bs=s;best=p;}}
    if(!best){calls++;const w=await T.wait({minutes:10});time=tm(w.time);await scan();continue;}
    for(const d of best){if(!(await go(d)))break;await scan();if(held+put>=3)break;}
  }
  if(held>0&&put<3)await deliver();
  return put;
}