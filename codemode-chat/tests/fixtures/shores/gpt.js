async function bot() {
  const dirs = ["nord", "ost", "süd", "west"], opp = [2, 3, 0, 1];
  const rooms = [], ids = Object.create(null);
  let current = 0, fire = -1, now = 0, calls = 0, position = null;
  let needExit = false, carried = null;

  function key(v) {
    if (v && typeof v === "object") return key(v.id ?? v.room ?? v.name);
    return String(v);
  }
  function direction(v) {
    if (v && typeof v === "object") v = v.name ?? v.direction ?? v.dir;
    v = String(v || "").toLowerCase().replace(/^go /, "");
    if (v === "sued") v = "süd";
    return dirs.indexOf(v);
  }
  function node(v) {
    const k = key(v);
    if (ids[k] !== undefined) return ids[k];
    const i = rooms.length;
    ids[k] = i;
    rooms.push({
      edge: [-1, -1, -1, -1], exits: [], count: 0,
      cell: null, view: null, raw: null, path: null, viewedAt: -1
    });
    return i;
  }
  function link(a, d, b) {
    if (d < 0 || a === b) return;
    rooms[a].edge[d] = b;
    rooms[b].edge[opp[d]] = a;
  }
  async function act(line) {
    calls++;
    const r = await tools.act({ line });
    if (r.at) position = r.at;
    return r;
  }
  function absorb(v) {
    current = node(v.room);
    position = v.at;
    carried = 0;
    for (const p of v.pack || [])
      if (/holz/i.test(p.name || "")) carried += p.count || 0;
    const r = rooms[current];
    r.view = v;
    r.viewedAt = now;
    r.visibleWood = null;
    for (const e of v.exits || []) {
      const d = direction(e);
      if (d >= 0) r.exits[d] = e;
    }
    if (v.fires && v.fires.length) {
      fire = current;
      r.flame = v.fires[0];
    }
    for (const t of v.things || []) {
      if (/treibholz/i.test(t.name || "")) {
        r.cell = { x: t.x, y: t.y };
        if (!r.visibleWood) r.visibleWood = t;
      }
    }
    return v;
  }
  async function look() {
    calls++;
    return absorb(await tools.look({}));
  }
  async function move(x, y) {
    if (!position || position.x !== x || position.y !== y)
      await act("move " + x + " " + y);
  }
  async function waitUntil(t) {
    while (now < t) {
      const m = Math.min(120, t - now);
      calls++;
      await tools.wait({ minutes: m });
      now += m;
    }
  }

  calls++;
  const book = await tools.logbook({});
  const days = book.days || [];
  for (const day of days) {
    for (const r of day.rooms || []) {
      const i = node(r.room), a = rooms[i];
      a.count += (r.pieces || []).length;
      if (r.pieces && r.pieces.length) a.cell = r.pieces[0];
      a.raw = r.exits;
      if (r.fromFire === 0) fire = i;
      if (Array.isArray(r.fromFire)) {
        const p = r.fromFire.map(direction);
        if (p.every(d => d >= 0)) {
          a.path = p;
          if (!p.length) fire = i;
        }
      }
    }
  }
  const prefixes = Object.create(null);
  rooms.forEach((r, i) => {
    if (r.path) prefixes[r.path.join(",")] = i;
  });
  rooms.forEach((r, i) => {
    if (r.path && r.path.length) {
      const p = r.path, a = prefixes[p.slice(0, -1).join(",")];
      if (a !== undefined) link(a, p[p.length - 1], i);
    }
    const raw = r.raw;
    if (!raw) return;
    const entries = Array.isArray(raw)
      ? raw.map(e => [direction(e), e])
      : Object.keys(raw).map(d => [direction(d), raw[d]]);
    for (const [d, e] of entries) {
      if (d < 0) continue;
      const target = e && typeof e === "object"
        ? e.to ?? e.target ?? e.destination ?? e.room : e;
      const j = ids[key(target)];
      if (j !== undefined) link(i, d, j);
    }
  });
  await look();

  function path(a, b) {
    if (a === b) return [];
    const q = [a], prev = new Int16Array(rooms.length).fill(-1);
    const pd = new Int8Array(rooms.length);
    prev[a] = a;
    for (let k = 0; k < q.length; k++) {
      const u = q[k];
      for (let d = 0; d < 4; d++) {
        const v = rooms[u].edge[d];
        if (v < 0 || prev[v] >= 0) continue;
        prev[v] = u;
        pd[v] = d;
        q.push(v);
        if (v === b) {
          const out = [];
          for (let z = b; z !== a; z = prev[z]) out.push(pd[z]);
          return out.reverse();
        }
      }
    }
    return null;
  }
  async function step(d) {
    const old = current;
    if (needExit) {
      if (!rooms[old].view) await look();
      const e = rooms[old].exits[d];
      if (e) await move(e.x, e.y);
    }
    let a = await act(dirs[d]);
    let next = a.at && a.at.room !== undefined ? node(a.at.room) : old;
    if (next === old && !needExit) {
      needExit = true;
      if (!rooms[old].view) await look();
      const e = rooms[old].exits[d];
      if (!e) return false;
      await move(e.x, e.y);
      a = await act(dirs[d]);
      next = a.at && a.at.room !== undefined ? node(a.at.room) : old;
    }
    if (next === old) return false;
    current = next;
    now += 5;
    link(old, d, next);
    if (!rooms[next].view) await look();
    return true;
  }
  async function go(target) {
    const p = path(current, target);
    if (!p) return false;
    for (const d of p) if (!await step(d)) return false;
    return true;
  }

  for (let k = 0; k < 22 && now < 85 && calls < 90; k++) {
    let best = null, cost = 100;
    for (let i = 0; i < rooms.length; i++) {
      const p = path(current, i);
      if (!p) continue;
      if (!rooms[i].view) {
        if (p.length < cost) {
          best = [i, -1];
          cost = p.length;
        }
      } else {
        for (let d = 0; d < 4; d++) {
          if (rooms[i].exits[d] && rooms[i].edge[d] < 0 && p.length < cost) {
            best = [i, d];
            cost = p.length;
          }
        }
      }
    }
    if (!best) break;
    await go(best[0]);
    if (best[1] < 0) {
      if (!rooms[current].view) await look();
    } else if (!await step(best[1])) {
      rooms[current].exits[best[1]] = null;
    }
  }
  if (fire < 0) return;

  const n = rooms.length;
  const dist = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const p = path(i, j);
      return p ? p.length : 999;
    }));
  const weight = rooms.map((r, i) => i === fire ? 0 :
    (r.count + 0.5) / (8 * Math.max(1, days.length) + 1));

  async function collect() {
    if (current === fire || calls > 278) return;
    const r = rooms[current];
    let cell = r.cell;
    if (r.viewedAt === now) {
      cell = r.visibleWood;
      if (!cell) return;
    } else {
      const alreadyThere = cell && position &&
        position.x === cell.x && position.y === cell.y;
      if (!cell || (!alreadyThere && weight[current] < 0.5)) {
        await look();
        cell = r.visibleWood;
        if (!cell) return;
      }
    }
    const confirmed = r.viewedAt === now && r.visibleWood !== null;
    await move(cell.x, cell.y);
    await act("nimm treibholz");
    if (confirmed && carried !== null) carried++;
    else carried = null;
    r.viewedAt = now;
    r.visibleWood = null;
  }

  for (let tide = 30; tide <= 450 && calls < 265; tide += 60) {
    if (now > tide + 25) continue;
    let best = null, score = -1e9;
    for (let start = 0; start < n; start++) {
      const arrival = now + 5 * dist[current][start];
      const begin = Math.max(tide, arrival);
      if (begin > tide + 25) continue;
      const maxDepth = Math.floor((tide + 25 - begin) / 5);
      const route = [];
      function search(u, depth, mask, value) {
        const finish = begin + depth * 5;
        if (finish + dist[u][fire] * 5 > 480) return;
        const s = value - 0.001 * (dist[current][start] + depth)
          - (tide === 450 ? 0.001 * dist[u][fire] : 0);
        if (s > score) {
          score = s;
          best = { start, route: route.slice(), begin };
        }
        if (depth === maxDepth) return;
        for (let d = 0; d < 4; d++) {
          const v = rooms[u].edge[d];
          if (v < 0) continue;
          route.push(d);
          search(v, depth + 1, mask | (1 << v),
            value + ((mask & (1 << v)) ? 0 : weight[v]));
          route.pop();
        }
      }
      search(start, 0, 1 << start, weight[start]);
    }
    if (!best) continue;
    await go(best.start);
    await waitUntil(best.begin);
    let mask = 1 << current;
    await collect();
    for (const d of best.route) {
      if (calls > 274) break;
      if (!await step(d)) break;
      if (!(mask & (1 << current))) await collect();
      mask |= 1 << current;
    }
  }

  await go(fire);
  if (carried === null || !rooms[fire].flame) await look();
  const f = rooms[fire].flame;
  if (!f) return;
  await move(f.x > 0 ? f.x - 1 : f.x + 1, f.y);
  for (let i = 0; i < carried && calls < 300; i++)
    await act("lege holz ins feuer");
}