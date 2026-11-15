async function bot() {
  const first = await tools.look({});
  const book = await tools.logbook({});
  const rooms = book.days[0].rooms, n = rooms.length;
  const ids = rooms.map(r => r.room);
  const idx = r => ids.indexOf(typeof r === "object" ? r.id : r);
  const dirs = ["nord", "ost", "süd", "west"];
  const opp = [2, 3, 0, 1], dx = [0, 1, 0, -1], dy = [-1, 0, 1, 0];
  const fire = rooms.findIndex(r => r.fromFire === 0);
  const has = rooms.map(r => dirs.map(d => r.exits.includes(d)));
  const weights = new Float64Array(n), cells = Array(n).fill(null);
  let trials = 0;
  for (const day of book.days) {
    trials += day.minutes.length;
    for (const r of day.rooms) {
      const i = idx(r.room);
      if (i < 0) continue;
      weights[i] += r.pieces.length;
      if (r.pieces.length) cells[i] = r.pieces[0];
    }
  }
  for (let i = 0; i < n; i++)
    weights[i] = i === fire || !weights[i] ? 0 : (weights[i] + 0.5) / (trials + 1);

  const g = Array.from({ length: n }, () => [-1, -1, -1, -1]);
  let candidates = [];
  const tasks = [];
  for (let d = 0; d < 2; d++)
    for (let i = 0; i < n; i++) if (has[i][d]) tasks.push([i, d]);

  function validate() {
    const dist = new Int8Array(n).fill(-1);
    const xs = new Int8Array(n), ys = new Int8Array(n), q = [fire];
    dist[fire] = 0;
    for (let k = 0; k < q.length; k++) {
      const u = q[k];
      for (let d = 0; d < 4; d++) {
        const v = g[u][d];
        if (v < 0) continue;
        const x = xs[u] + dx[d], y = ys[u] + dy[d];
        if (dist[v] < 0) {
          xs[v] = x;
          ys[v] = y;
          dist[v] = dist[u] + 1;
          q.push(v);
        } else if (xs[v] !== x || ys[v] !== y) return;
      }
    }
    if (q.length !== n) return;
    for (let i = 0; i < n; i++) {
      if (dist[i] !== rooms[i].fromFire) return;
      for (let j = 0; j < i; j++)
        if (xs[i] === xs[j] && ys[i] === ys[j]) return;
      for (let d = 0; d < 4; d++)
        if (has[i][d] !== (g[i][d] >= 0)) return;
    }
    candidates.push(g.map(r => r.slice()));
  }

  function match(k) {
    if (k === tasks.length) {
      validate();
      return;
    }
    const [u, d] = tasks[k], od = opp[d];
    for (let v = 0; v < n; v++) {
      if (u === v || !has[v][od] || g[v][od] >= 0 ||
          g[u].includes(v) ||
          Math.abs(rooms[u].fromFire - rooms[v].fromFire) !== 1) continue;
      g[u][d] = v;
      g[v][od] = u;
      match(k + 1);
      g[u][d] = -1;
      g[v][od] = -1;
    }
  }
  match(0);
  if (!candidates.length) return;

  let current = idx(first.room), time = 0, at = first.at;
  let fireCell = first.fires[0] || null;
  let routeCache = new Map(), distanceCache = [];

  function distances(graph, source) {
    if (graph === candidates[0] && distanceCache[source])
      return distanceCache[source];
    const ds = new Int8Array(n).fill(99), q = [source];
    ds[source] = 0;
    for (let k = 0; k < q.length; k++)
      for (const v of graph[q[k]]) if (v >= 0 && ds[v] === 99) {
        ds[v] = ds[q[k]] + 1;
        q.push(v);
      }
    if (graph === candidates[0]) distanceCache[source] = ds;
    return ds;
  }

  async function go(d) {
    const old = current, oldGraph = candidates[0];
    const r = await tools.act({ line: "go " + dirs[d] });
    const next = idx(r.at.room);
    if (next < 0 || next === old) return false;
    current = next;
    at = r.at;
    time += 5;
    const filtered = candidates.filter(c => c[old][d] === next);
    if (filtered.length) candidates = filtered;
    if (candidates[0] !== oldGraph) {
      routeCache = new Map();
      distanceCache = [];
    }
    return true;
  }

  async function travel(target, deadline) {
    while (current !== target && time + 5 <= deadline) {
      const graph = candidates[0], ds = distances(graph, target);
      const d = graph[current].findIndex(v => v >= 0 && ds[v] === ds[current] - 1);
      if (d < 0 || !await go(d)) break;
    }
  }

  function route(start, steps, visited, final) {
    const key = (((visited * 8 + steps) * n + start) * 2) + (final ? 1 : 0);
    if (routeCache.has(key)) return routeCache.get(key);
    const graph = candidates[0], home = distances(graph, fire);
    let bestScore = -1e9, bestPath = [];
    const path = [];
    function dfs(u, left, mask, score) {
      if (!(mask & (1 << u))) {
        mask |= 1 << u;
        score += weights[u];
      }
      if ((!final || home[u] <= left) &&
          score - path.length * 0.00001 > bestScore) {
        bestScore = score - path.length * 0.00001;
        bestPath = path.slice();
      }
      if (!left) return;
      for (let d = 0; d < 4; d++) {
        const v = graph[u][d];
        if (v < 0 || (final && home[v] > left - 1)) continue;
        path.push(d);
        dfs(v, left - 1, mask, score);
        path.pop();
      }
    }
    dfs(start, steps, visited, 0);
    const result = { score: bestScore, path: bestPath };
    routeCache.set(key, result);
    return result;
  }

  async function take(item) {
    if (at.x !== item.x || at.y !== item.y) {
      const r = await tools.act({ line: "move " + item.x + " " + item.y });
      at = r.at;
    }
    const r = await tools.act({ line: "nimm treibholz" });
    at = r.at;
  }

  async function collect() {
    if (current === fire || !weights[current]) return;
    const cell = cells[current];
    if (cell && (weights[current] > 0.5 ||
        (at.x === cell.x && at.y === cell.y))) {
      await take(cell);
      return;
    }
    const view = await tools.look({});
    at = view.at;
    for (const item of view.things) {
      if (!/treibholz/i.test(item.name)) continue;
      cells[current] = item;
      await take(item);
    }
  }

  for (let hour = 0; hour < 8; hour++) {
    const tide = 30 + hour * 60, final = hour === 7;
    let guard = 0;
    while (time < tide && guard++ < 12) {
      const ds = distances(candidates[0], current);
      let target = current, value = -1e9;
      for (let s = 0; s < n; s++) {
        if (time + ds[s] * 5 > tide) continue;
        const p = route(s, 5, 0, final);
        const score = p.score - ds[s] * 0.000001;
        if (score > value) {
          value = score;
          target = s;
        }
      }
      if (target === current) break;
      const toward = distances(candidates[0], target);
      const d = candidates[0][current].findIndex(
        v => v >= 0 && toward[v] === toward[current] - 1
      );
      if (d < 0 || !await go(d)) break;
    }
    if (time < tide) {
      await tools.wait({ minutes: tide - time });
      time = tide;
    }
    let visited = 0, left = 5;
    while (true) {
      if (!(visited & (1 << current))) {
        await collect();
        visited |= 1 << current;
      }
      const p = route(current, left, visited, final);
      if (!left || !p.path.length) break;
      if (!await go(p.path[0])) break;
      left--;
    }
  }

  await travel(fire, 475);
  if (current !== fire) return;
  const view = await tools.look({});
  fireCell = view.fires[0] || fireCell;
  const carried = view.pack.reduce(
    (sum, p) => sum + (/holz/i.test(p.name) ? p.count : 0), 0
  );
  if (!fireCell || !carried) return;
  const x = fireCell.x > 0 ? fireCell.x - 1 : fireCell.x + 1;
  await tools.act({ line: "move " + x + " " + fireCell.y });
  for (let i = 0; i < carried; i++)
    await tools.act({ line: "lege holz ins feuer" });
}