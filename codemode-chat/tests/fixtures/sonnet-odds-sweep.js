async function bot() {
  const OPP = { nord: 'süd', süd: 'nord', ost: 'west', west: 'ost' };
  const tm = (t) => {
    const m = /(\d+):(\d+)/.exec(String(t));
    return m ? (+m[1]) * 60 + (+m[2]) - 480 : 0;
  };
  const rooms = {};
  let cur = null, fireId = null, fire = null, now = 0;
  const reg = (s) => {
    cur = s.room.id;
    now = tm(s.time);
    if (!rooms[cur]) rooms[cur] = { exits: s.exits, to: {} };
    if (s.fires && s.fires.length) { fireId = cur; fire = s.fires[0]; }
  };
  const pick = async (s) => {
    for (const w of s.things.filter((x) => /treibholz/i.test(x.name))) {
      await tools.act({ line: 'move ' + w.x + ' ' + w.y });
      await tools.act({ line: 'nimm treibholz' });
    }
  };
  const go = async (dir) => {
    await tools.act({ line: dir });
    let s = await tools.look({});
    if (s.room.id === cur) {
      const e = rooms[cur].exits.find((x) => x.name === dir);
      await tools.act({ line: 'move ' + e.x + ' ' + e.y });
      await tools.act({ line: dir });
      s = await tools.look({});
    }
    return s;
  };
  const dfs = async (id) => {
    for (const e of rooms[id].exits.slice()) {
      if (rooms[id].to[e.name] !== undefined) continue;
      const s = await go(e.name);
      const isNew = !rooms[s.room.id];
      reg(s);
      const nid = cur;
      rooms[id].to[e.name] = nid;
      rooms[nid].to[OPP[e.name]] = id;
      if (isNew) { await pick(s); await dfs(nid); }
      const b = await go(OPP[e.name]);
      reg(b);
    }
  };
  const bfs = (src) => {
    const dist = { [src]: 0 }, path = { [src]: [] }, q = [src];
    for (let i = 0; i < q.length; i++) {
      const u = q[i];
      for (const d in rooms[u].to) {
        const v = rooms[u].to[d];
        if (dist[v] === undefined) { dist[v] = dist[u] + 1; path[v] = path[u].concat(d); q.push(v); }
      }
    }
    return { dist, path };
  };
  const walk = async (p) => {
    let s = null;
    for (const d of p) { s = await go(d); reg(s); }
    return s;
  };

  const s0 = await tools.look({});
  reg(s0);
  await pick(s0);
  await dfs(cur);
  if (fireId === null) return 0;
  const df = bfs(fireId).dist;
  const dead = Object.keys(rooms).filter((id) => Object.keys(rooms[id].to).length === 1 && id !== fireId);
  for (let T = 30; T <= 450; T += 60) {
    if (now > T + 25) continue;
    const vis = {};
    let first = true;
    for (let k = 0; k < dead.length; k++) {
      const { dist, path } = bfs(cur);
      let best = null, bd = 1e9;
      for (const id of dead) {
        if (vis[id] || dist[id] === undefined) continue;
        const arr = Math.max(now + 5 * dist[id], T + 1);
        if (arr <= T + 29 && arr + 5 * df[id] <= 475 && dist[id] < bd) { bd = dist[id]; best = id; }
      }
      if (best === null) break;
      vis[best] = 1;
      if (first) {
        first = false;
        const w = T + 1 - now - 5 * bd;
        if (w >= 1) { const r = await tools.wait({ minutes: Math.min(120, Math.ceil(w)) }); now = tm(r.time); }
      }
      const s = await walk(path[best]);
      const sv = s || (await tools.look({}));
      await pick(sv);
    }
  }
  await walk(bfs(cur).path[fireId]);
  const sv = await tools.look({});
  const p = sv.pack.find((x) => /treibholz/i.test(x.name));
  const n = p ? p.count : 0;
  if (n > 0) {
    await tools.act({ line: 'move ' + (fire.x + 1) + ' ' + fire.y });
    for (let i = 0; i < n; i++) await tools.act({ line: 'lege holz ins feuer' });
  }
  return 0;
}