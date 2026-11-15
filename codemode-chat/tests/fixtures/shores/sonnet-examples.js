async function bot() {
  const lb = await tools.logbook({});
  const days = lb.days, D = days.length;
  const info = days[0].rooms;
  const exits = {}, rate = {}, cell = {};
  let fireId = info[0].room;
  for (const r of info) { exits[r.room] = r.exits; rate[r.room] = 0; if (r.fromFire === 0) fireId = r.room; }
  const tides = days[0].minutes, nT = tides.length;
  for (const d of days) for (const r of d.rooms) for (const p of r.pieces) { rate[r.room] += 1 / (D * nT); cell[r.room] = [p.x, p.y]; }
  const opp = { nord: "süd", "süd": "nord", ost: "west", west: "ost" };
  const N = info.length;
  const graph = {};
  for (const r of info) graph[r.room] = {};
  const lk = await tools.look({});
  let cur = lk.room.id, t = 0;
  let px = lk.at.x, py = lk.at.y;
  const seenR = {}; seenR[cur] = 1;
  let seen = 1, done = seen >= N;
  async function dfs(r) {
    for (const dir of exits[r]) {
      if (graph[r][dir]) continue;
      const res = await tools.act({ line: "go " + dir });
      t += 5;
      const n = res.at.room;
      cur = n; px = res.at.x; py = res.at.y;
      graph[r][dir] = n;
      graph[n][opp[dir]] = r;
      let fresh = false;
      if (!seenR[n]) { seenR[n] = 1; seen++; fresh = true; }
      if (seen >= N) { done = true; return; }
      if (fresh) { await dfs(n); if (done) return; }
      const b = await tools.act({ line: "go " + opp[dir] });
      px = b.at.x; py = b.at.y;
      t += 5; cur = r;
    }
  }
  await dfs(cur);
  const fd = {}; fd[fireId] = 0;
  const q = [fireId];
  for (let h = 0; h < q.length; h++) {
    for (const d in graph[q[h]]) { const v = graph[q[h]][d]; if (!(v in fd)) { fd[v] = fd[q[h]] + 1; q.push(v); } }
  }
  for (let ti = 0; ti < nT; ti++) {
    const T = tides[ti];
    if (t > T + 25) continue;
    const last = ti === nT - 1;
    let best = { v: 0, len: 99, steps: null };
    const rec = (room, a, vis, val, steps) => {
      let col = false, a2 = a, v2 = val, vis2 = vis;
      if (rate[room] > 0 && !vis[room] && a <= T + 25) {
        col = true; a2 = Math.max(a, T); v2 = val + rate[room];
        vis2 = Object.assign({}, vis); vis2[room] = 1;
      }
      const st = steps.concat([{ room, col }]);
      const ok = !last || (fd[room] !== undefined && a2 + 5 * fd[room] <= 478);
      if (ok && (v2 > best.v + 1e-9 || (Math.abs(v2 - best.v) < 1e-9 && v2 > 0 && st.length < best.len))) {
        best = { v: v2, len: st.length, steps: st };
      }
      if (a2 + 5 <= T + 25) {
        for (const d in graph[room]) rec(graph[room][d], a2 + 5, vis2, v2, st);
      }
    };
    rec(cur, t, {}, 0, []);
    if (!best.steps) continue;
    const p = best.steps;
    for (let i = 0; i < p.length; i++) {
      if (i > 0) {
        let dir = null;
        for (const d in graph[p[i - 1].room]) if (graph[p[i - 1].room][d] === p[i].room) { dir = d; break; }
        const r = await tools.act({ line: "go " + dir });
        px = r.at.x; py = r.at.y;
        t += 5; cur = p[i].room;
      }
      if (p[i].col) {
        if (t < T) { await tools.wait({ minutes: T - t }); t = T; }
        const c = cell[p[i].room];
        if (px !== c[0] || py !== c[1]) {
          await tools.act({ line: "move " + c[0] + " " + c[1] });
          px = c[0]; py = c[1];
        }
        await tools.act({ line: "nimm treibholz" });
      }
    }
  }
  if (cur !== fireId) {
    const prev = {}; prev[cur] = null;
    const qq = [cur];
    for (let h = 0; h < qq.length; h++) {
      for (const d in graph[qq[h]]) { const v = graph[qq[h]][d]; if (!(v in prev)) { prev[v] = [qq[h], d]; qq.push(v); } }
    }
    const path = [];
    let x = fireId;
    while (prev[x]) { path.unshift(prev[x][1]); x = prev[x][0]; }
    for (const d of path) await tools.act({ line: "go " + d });
  }
  const L = await tools.look({});
  const f = L.fires[0];
  const pk = L.pack.find(k => /holz/i.test(k.name));
  const n = pk ? pk.count : 0;
  if (f && n > 0) {
    await tools.act({ line: "move " + f.x + " " + (f.y + 1) });
    for (let i = 0; i < n; i++) await tools.act({ line: "lege holz ins feuer" });
  }
}