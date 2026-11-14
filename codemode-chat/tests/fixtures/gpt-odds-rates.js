async function bot() {
  const opposite = { nord: "süd", süd: "nord", ost: "west", west: "ost" };
  const rooms = {};
  let here, pos, fireRoom, minute = 0, calls = 0, carried = 0;
  let mode = null;
  const stats = {};
  calls++;
  const data = await tools.observations({});
  for (const day of data.observations || []) {
    for (const r of day.rooms || []) {
      const key = r.exits.length + ":" + r.fromFire;
      const a = stats[key] || (stats[key] = [0, 0]);
      a[0] += (r.pieces || []).length;
      a[1] += 8;
    }
  }

  function direction(s) {
    s = String(s).toLowerCase();
    if (/nord/.test(s)) return "nord";
    if (/süd|sued/.test(s)) return "süd";
    if (/west/.test(s)) return "west";
    if (/ost/.test(s)) return "ost";
    return s;
  }
  async function act(line) {
    calls++;
    const a = await tools.act({ line });
    if (a.at) pos = { x: a.at.x, y: a.at.y };
    return a;
  }
  async function move(p) {
    if (!pos || pos.x !== p.x || pos.y !== p.y)
      return await act("move " + p.x + " " + p.y);
  }
  async function look() {
    calls++;
    const s = await tools.look({});
    here = s.room.id;
    pos = s.at;
    if (!rooms[here]) rooms[here] = { links: {}, last: -1 };
    rooms[here].exits = (s.exits || []).map(e => ({
      name: direction(e.name), x: e.x, y: e.y
    }));
    if ((s.fires || []).length) {
      fireRoom = here;
      rooms[here].fire = s.fires[0];
    }
    return s;
  }
  async function gather(s) {
    if (minute % 60 < 30) return;
    const r = rooms[here];
    const tide = Math.floor(minute / 60);
    if (r.last === tide) return;
    r.last = tide;
    for (const p of s.things || []) {
      if (!/treibholz/i.test(p.name) || calls + carried > 275) continue;
      await move(p);
      const a = await act("nimm treibholz");
      if (!(a.said || []).some(x => /zu weit|kein treibholz|nicht hier/i.test(x)))
        carried++;
    }
  }
  function nearExit(e, d) {
    return {
      x: e.x + (d === "west" ? 1 : d === "ost" ? -1 : 0),
      y: e.y + (d === "nord" ? 1 : d === "süd" ? -1 : 0)
    };
  }
  async function step(d, collect) {
    const old = here, r = rooms[old], known = r.links[d];
    const e = r.exits.find(x => x.name === d);
    if (!e || minute + 5 > 480 || calls >= 285) return false;
    let s;
    if (mode === null) {
      await act(d);
      s = await look();
      if (here !== old) mode = "direct";
      else {
        await move(e);
        s = await look();
        if (here !== old) mode = "move";
        else {
          await act(d);
          s = await look();
          if (here === old) return false;
          mode = "near";
        }
      }
    } else {
      if (mode === "move") await move(e);
      else {
        if (mode === "near") await move(nearExit(e, d));
        await act(d);
      }
      if (!known) s = await look();
      else here = known;
    }
    if (here === old) return false;
    minute += 5;
    r.links[d] = here;
    rooms[here].links[opposite[d]] = old;
    if (collect && minute % 60 >= 30 &&
        rooms[here].exits.length === 1 &&
        rooms[here].last !== Math.floor(minute / 60))
      await gather(s || await look());
    return true;
  }
  function path(a, b) {
    const q = [a], prev = { [a]: null };
    for (let i = 0; i < q.length; i++) {
      const v = q[i];
      if (v === b) {
        const p = [];
        while (prev[b]) {
          p.push(prev[b][1]);
          b = prev[b][0];
        }
        return p.reverse();
      }
      for (const d in rooms[v].links) {
        const w = rooms[v].links[d];
        if (Object.prototype.hasOwnProperty.call(prev, w)) continue;
        prev[w] = [v, d];
        q.push(w);
      }
    }
    return null;
  }
  async function travel(to, collect) {
    const p = path(here, to);
    if (!p) return false;
    for (const d of p) if (!await step(d, collect)) return false;
    return true;
  }
  async function waitUntil(t) {
    while (minute < t) {
      const n = Math.min(120, t - minute);
      calls++;
      await tools.wait({ minutes: n });
      minute += n;
    }
  }

  await look();
  while (minute < 100 && calls < 85) {
    let best;
    for (const id of Object.keys(rooms)) {
      const p = path(here, id);
      for (const e of rooms[id].exits) {
        if (rooms[id].links[e.name]) continue;
        if (!best || p.length < best.length)
          best = { id, d: e.name, length: p.length };
      }
    }
    if (!best) break;
    if (!await travel(best.id, true)) break;
    if (!await step(best.d, true)) break;
  }
  if (!fireRoom) return;

  const ids = Object.keys(rooms), index = {}, paths = {}, weights = {};
  ids.forEach((id, i) => index[id] = i);
  for (const a of ids) {
    paths[a] = {};
    for (const b of ids) paths[a][b] = path(a, b);
  }
  for (const id of ids) {
    const depth = paths[id][fireRoom].length;
    const degree = rooms[id].exits.length;
    const sample = stats[degree + ":" + depth];
    weights[id] = degree === 1
      ? sample ? sample[0] / sample[1] : Math.min(0.75, 0.13 * depth + 0.025)
      : 0;
  }

  for (let tide = 30; tide <= 450; tide += 60) {
    if (minute >= tide + 30 || calls + carried > 265) continue;
    let best;
    for (const start of ids) {
      const approach = paths[here][start].length;
      const arrival = Math.max(tide, minute + approach * 5);
      if (arrival >= tide + 30) continue;
      const route = [];
      function search(id, mask, score) {
        const finish = arrival + route.length * 5;
        const home = paths[id][fireRoom].length;
        if (finish + home * 5 > 475) return;
        if (calls + 2 * (approach + route.length + home) + carried + 15 >= 299)
          return;
        const value = score - 0.002 * (approach + route.length) -
          (tide === 450 ? 0.002 * home : 0);
        if (!best || value > best.value)
          best = { start, route: route.slice(), value };
        if (finish + 5 >= tide + 30) return;
        for (const d in rooms[id].links) {
          const to = rooms[id].links[d], bit = 1 << index[to];
          const fresh = !(mask & bit) &&
            rooms[to].last !== Math.floor(tide / 60);
          route.push(d);
          search(to, mask | bit, score + (fresh ? weights[to] : 0));
          route.pop();
        }
      }
      search(start, 1 << index[start],
        rooms[start].last === Math.floor(tide / 60) ? 0 : weights[start]);
    }
    if (!best) continue;
    if (!await travel(best.start, false)) break;
    await waitUntil(Math.max(minute, tide));
    async function harvest() {
      if (weights[here] && rooms[here].last !== Math.floor(tide / 60) &&
          calls + carried + paths[here][fireRoom].length * 2 + 12 < 298)
        await gather(await look());
    }
    await harvest();
    for (const d of best.route) {
      if (calls + carried + paths[here][fireRoom].length * 2 + 16 >= 298) break;
      if (!await step(d, false)) break;
      await harvest();
    }
  }

  await travel(fireRoom, false);
  if (here !== fireRoom || !carried) return;
  const f = rooms[fireRoom].fire;
  // The beacon occupies its own tile: stand beside it, not on it.
  const adjacent = [
    { x: f.x - 1, y: f.y },
    { x: f.x + 1, y: f.y },
    { x: f.x, y: f.y - 1 },
    { x: f.x, y: f.y + 1 }
  ];
  for (const p of adjacent) {
    await move(p);
    if (pos && Math.abs(pos.x - f.x) + Math.abs(pos.y - f.y) <= 1) break;
  }
  while (carried > 0 && calls < 300) {
    const a = await act("lege holz ins feuer");
    if ((a.said || []).some(x => /zu weit|nicht.*nähe/i.test(x))) break;
    carried--;
  }
}