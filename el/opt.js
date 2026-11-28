/* insite EuroLeague Optimiser engine (PLAN P5b, 3 Nov 2026). Exact best lineups by MEAN projection for the four
   FanTeam EuroLeague formats (METHOD.md "Contest formats"):
     F1 classic  7 players: 1 each PG / SG / SF / PF / C + 2 any (flex). Budget 80M. Max 3 per team (model/simulate.py rule).
     F2 any      6 players, any position. Budget and team cap not confirmed: the page asks.
     F3 captain  6 players, any position, max 5 per team, budget 67M. Captain scores AND costs x1.5, vice x1.2.
     F4 monthly  9 players: 2 PG / 2 SG / 2 SF / 2 PF / 1 C, no flex. Budget 100M. Max 3 per team.
   Ranked list of distinct lineups (captain: distinct squad + C + VC). Ties on mean FP: more budget left first
   (FanTeam's tie-break on F3; used for all formats here).

   Method = branch and bound, the same idea as nba.dfs site/opt.js (the captain part is that code, unchanged in logic):
   players sorted by FP high to low; a branch is dropped only when even its best possible finish cannot reach the
   current top N, or when even its cheapest finish breaks the budget, or when the positions it still needs cannot be
   filled. Same answer as trying every lineup; it only skips lineups that cannot make the list. maxNodes stops a run
   that would take too long: the result then says exact: false.

   Works in the browser (window.INSITE_OPT) and in Node (module.exports) for tests. */
(function (root) {
  "use strict";
  const POS = ["PG", "SG", "SF", "PF", "C"];
  const FORMATS = {
    classic: { label: "Classic 7 (PG/SG/SF/PF/C + 2 any)", slots: { PG: 1, SG: 1, SF: 1, PF: 1, C: 1 }, flex: 2, budget: 80, maxTeam: 3 },
    any6:    { label: "6 players, any position", slots: {}, flex: 6, budget: null, maxTeam: 6 },
    captain: { label: "Captain (6 any, C x1.5, VC x1.2)", captain: true, n: 6, budget: 67, maxTeam: 5, cm: 1.5, vm: 1.2 },
    monthly: { label: "Monthly 9 (2 PG / 2 SG / 2 SF / 2 PF / 1 C)", slots: { PG: 2, SG: 2, SF: 2, PF: 2, C: 1 }, flex: 0, budget: 100, maxTeam: 3 }
  };

  function prep(o, n) {
    const bans = new Set(o.bans || []), lockN = new Set((o.locks || []).filter(x => !bans.has(x)));
    const all = (o.players || []).filter(p => p && p.name && !bans.has(p.name) && isFinite(p.price) && p.price > 0 && p.fp != null && isFinite(p.fp));
    const missing = [...lockN].filter(x => !all.some(p => p.name === x));
    if (missing.length) return { error: "Locked but not in the pool (out, no projection, or filtered): " + missing.join(", ") };
    const B = Number(o.budget);
    if (!isFinite(B) || B <= 0) return { error: "Set a budget." };
    const locks = all.filter(p => lockN.has(p.name));
    const free = all.filter(p => !lockN.has(p.name)).sort((a, b) => b.fp - a.fp || a.price - b.price || (a.name < b.name ? -1 : 1));
    const need = n - locks.length;
    if (need < 0) return { error: `${locks.length} players locked, lineup has ${n}.` };
    if (need > free.length) return { error: `Only ${all.length} players in the pool; a lineup needs ${n}.` };
    return { all, locks, free, need, B };
  }
  const fail = (e) => ({ error: e, lineups: [], exact: true, nodes: 0, pool: 0 });
  const teamText = set => [...set.reduce((m, p) => m.set(p.team, (m.get(p.team) || 0) + 1), new Map())].map(([t, c]) => t + " " + c).join(", ");

  // Top-K store shared by both engines: sorted by pts desc, then cost asc
  function topK(K) {
    const best = [];
    return {
      best,
      thr: () => best.length < K ? -Infinity : best[K - 1].pts,
      add(pts, cost, payload) {
        if (best.length >= K && (pts < best[K - 1].pts - 1e-9 || (Math.abs(pts - best[K - 1].pts) <= 1e-9 && cost >= best[K - 1].cost))) return;
        const it = Object.assign({ pts, cost }, payload);
        let i = best.length; while (i > 0 && (best[i - 1].pts < pts - 1e-9 || (Math.abs(best[i - 1].pts - pts) <= 1e-9 && best[i - 1].cost > cost))) i--;
        best.splice(i, 0, it); if (best.length > K) best.pop();
      }
    };
  }

  /* ---------- positional (F1, F2, F4) ---------- */
  function positional(o) {
    const slots = Object.assign({}, o.slots || {}), flex = Math.max(0, Number(o.flex || 0));
    POS.forEach(p => { slots[p] = Math.max(0, Number(slots[p] || 0)); });
    const n = POS.reduce((s, p) => s + slots[p], 0) + flex;
    if (n < 1) return fail("Lineup has no players.");
    const K = Math.max(1, o.topN || 10), maxTeam = Math.max(1, o.maxTeam || n), maxNodes = o.maxNodes || 4e7;
    const P = prep(o, n); if (P.error) return fail(P.error);
    const { all, locks, free, need, B } = P;
    const bad = all.filter(p => !POS.includes(p.pos));
    if (bad.length && flex === 0) return fail("No position for: " + bad.map(p => p.name).join(", "));

    const pi = p => POS.indexOf(p.pos);   // -1 = unknown position: flex only
    const needA = POS.map(p => slots[p]), cnt = new Int32Array(5);
    let over = 0;   // players beyond their position's slots (or with no position) = flex used
    const takes = i => (i < 0 || cnt[i] >= needA[i]) ? 1 : 0;
    for (const p of locks) { const i = pi(p); over += takes(i); if (i >= 0) cnt[i]++; }
    if (over > flex) return fail("Locked players do not fit the positions.");
    const teams = new Map(); [...locks, ...free].forEach(p => { if (!teams.has(p.team)) teams.set(p.team, teams.size); });
    const tc = new Int32Array(teams.size);
    for (const p of locks) if (++tc[teams.get(p.team)] > maxTeam) return fail(`More than ${maxTeam} locked players from ${p.team}.`);

    const N = free.length, fp = free.map(p => p.fp), pr = free.map(p => p.price), tm = free.map(p => teams.get(p.team)), ps = free.map(pi);
    const pre = new Float64Array(N + 1); for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + fp[i];
    // cheapest prices from index i on (the `need` smallest, as prefix sums), and players left per position from i on
    const cheap = []; { let w = []; for (let i = N - 1; i >= 0; i--) { w.push(pr[i]); w.sort((a, b) => a - b); if (w.length > need) w.pop(); const s = [0]; w.forEach(v => s.push(s[s.length - 1] + v)); cheap[i] = s; } cheap[N] = [0]; }
    const left = []; { const c = [0, 0, 0, 0, 0]; left[N] = c.slice(); for (let i = N - 1; i >= 0; i--) { if (ps[i] >= 0) c[ps[i]]++; left[i] = c.slice(); } }
    const lockFp = locks.reduce((s, p) => s + p.fp, 0), lockPr = locks.reduce((s, p) => s + p.price, 0);
    const T = topK(K), sq = locks.slice();
    let nodes = 0, stopped = false;
    const t0 = Date.now();

    // i = next free index, k = players still to add
    function dfs(i, k, fpSum, prSum) {
      if (++nodes > maxNodes) { stopped = true; return; }
      if (k === 0) { T.add(fpSum, prSum, { set: sq.slice() }); return; }
      if (N - i < k) return;
      if (prSum + cheap[i][k] > B + 1e-6) return;
      // positions still empty must be fillable from what is left
      let req = 0; for (let x = 0; x < 5; x++) { const r = needA[x] - cnt[x]; if (r > 0) { if (left[i][x] < r) return; req += r; } }
      if (req > k) return;
      for (let j = i; j <= N - k; j++) {
        if (stopped) return;
        if (fpSum + pre[j + k] - pre[j] < T.thr() - 1e-9) return;   // FP sorted high to low: the bound only falls from here
        const t = tm[j]; if (tc[t] >= maxTeam) continue;
        const x = ps[j], f = takes(x);
        if (over + f > flex) continue;
        if (prSum + pr[j] > B + 1e-6) continue;
        tc[t]++; over += f; if (x >= 0) cnt[x]++; sq.push(free[j]);
        dfs(j + 1, k - 1, fpSum + fp[j], prSum + pr[j]);
        sq.pop(); if (x >= 0) cnt[x]--; over -= f; tc[t]--;
      }
    }
    dfs(0, need, lockFp, lockPr);

    const lineups = T.best.map((x, r) => {
      // show players in slot order: each position's slots first (highest FP), the rest as flex
      const by = POS.map(p => x.set.filter(q => q.pos === p).sort((a, b) => b.fp - a.fp));
      const rows = [], fl = [];
      POS.forEach((p, i) => by[i].forEach((q, j) => (j < slots[p] ? rows : fl).push({ slot: j < slots[p] ? p : "FLEX", name: q.name, pos: q.pos, team: q.team, price: q.price, fp: q.fp })));
      x.set.filter(q => !POS.includes(q.pos)).forEach(q => fl.push({ slot: "FLEX", name: q.name, pos: q.pos || "?", team: q.team, price: q.price, fp: q.fp }));
      return { rank: r + 1, fp: x.pts, cost: x.cost, left: B - x.cost, slots: rows.concat(fl.sort((a, b) => b.fp - a.fp)), players: x.set.map(q => q.name), teams: teamText(x.set) };
    });
    return { lineups, exact: !stopped, nodes, ms: Date.now() - t0, pool: all.length, n,
             error: lineups.length ? null : stopped ? "Stopped before finding a lineup: lock players, pick fewer games or use the shortlist." : "No lineup fits the budget and positions with these settings." };
  }

  /* ---------- captain (F3): nba.dfs site/opt.js logic ---------- */
  function captain(o) {
    const n = o.n || 6, K = Math.max(1, o.topN || 10), maxTeam = o.maxTeam || n;
    const cm = Math.max(1, o.cm == null ? 1.5 : Number(o.cm)), vm = Math.max(1, o.vm == null ? 1.2 : Number(o.vm));
    const hiX = Math.max(cm, vm) - 1, loX = Math.min(cm, vm) - 1;
    const maxNodes = o.maxNodes || 4e7;
    const P = prep(o, n); if (P.error) return fail(P.error);
    const { all, locks, free, need, B } = P;
    const teams = new Map(); [...locks, ...free].forEach(p => { if (!teams.has(p.team)) teams.set(p.team, teams.size); });
    const cnt = new Int32Array(teams.size);
    for (const p of locks) if (++cnt[teams.get(p.team)] > maxTeam) return fail(`More than ${maxTeam} locked players from ${p.team}.`);
    const N = free.length, fp = free.map(p => p.fp), pr = free.map(p => p.price), tm = free.map(p => teams.get(p.team));
    const pre = new Float64Array(N + 1); for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + fp[i];
    const cheap = [], sufMin = new Float64Array(N + 1).fill(Infinity);
    { let w = []; for (let i = N - 1; i >= 0; i--) { w.push(pr[i]); w.sort((a, b) => a - b); if (w.length > need) w.pop(); const s = [0]; w.forEach(v => s.push(s[s.length - 1] + v)); cheap[i] = s; sufMin[i] = Math.min(sufMin[i + 1], pr[i]); } cheap[N] = [0]; }
    const lockFp = locks.reduce((s, p) => s + p.fp, 0), lockPr = locks.reduce((s, p) => s + p.price, 0);
    const lockTop = locks.map(p => p.fp).sort((a, b) => b - a), lockMin = locks.reduce((m, p) => Math.min(m, p.price), Infinity);
    const T = topK(K), sq = locks.slice();
    let nodes = 0, stopped = false;
    const t0 = Date.now();

    function leaf(fpSum, prSum) {
      let bp = null;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const cost = prSum + (cm - 1) * sq[a].price + (vm - 1) * sq[b].price;
        if (cost > B + 1e-6) continue;
        const pts = fpSum + (cm - 1) * sq[a].fp + (vm - 1) * sq[b].fp;
        if (o.perSquad) { if (!bp || pts > bp.pts + 1e-9 || (Math.abs(pts - bp.pts) <= 1e-9 && cost < bp.cost)) bp = { pts, cost, a, b }; }
        else T.add(pts, cost, { set: sq.slice(), c: sq[a], v: sq[b] });
      }
      if (bp) T.add(bp.pts, bp.cost, { set: sq.slice(), c: sq[bp.a], v: sq[bp.b] });
    }
    function bound(j, k, fpSum, top1, top2) {
      let a = top1, b = top2;
      for (const x of k >= 2 ? [fp[j], fp[j + 1]] : [fp[j]]) { if (x > a) { b = a; a = x; } else if (x > b) b = x; }
      return fpSum + pre[j + k] - pre[j] + hiX * (isFinite(a) ? a : 0) + loX * (isFinite(b) ? b : 0);
    }
    function dfs(i, k, fpSum, prSum, top1, top2, minPr) {
      if (++nodes > maxNodes) { stopped = true; return; }
      if (k === 0) { leaf(fpSum, prSum); return; }
      if (N - i < k) return;
      const mp = Math.min(minPr, sufMin[i]);
      if (prSum + cheap[i][k] + (cm - 1 + vm - 1) * mp > B + 1e-6) return;
      for (let j = i; j <= N - k; j++) {
        if (stopped) return;
        if (bound(j, k, fpSum, top1, top2) < T.thr() - 1e-9) return;
        const t = tm[j]; if (cnt[t] >= maxTeam) continue;
        cnt[t]++; sq.push(free[j]);
        let n1 = top1, n2 = top2; if (fp[j] > n1) { n2 = n1; n1 = fp[j]; } else if (fp[j] > n2) n2 = fp[j];
        dfs(j + 1, k - 1, fpSum + fp[j], prSum + pr[j], n1, n2, Math.min(minPr, pr[j]));
        sq.pop(); cnt[t]--;
      }
    }
    dfs(0, need, lockFp, lockPr, lockTop[0] ?? -Infinity, lockTop[1] ?? -Infinity, lockMin);

    const lineups = T.best.map((x, r) => ({
      rank: r + 1, fp: x.pts, cost: x.cost, left: B - x.cost, C: x.c.name, VC: x.v.name,
      slots: [{ slot: "C", name: x.c.name, pos: x.c.pos, team: x.c.team, price: x.c.price, fp: x.c.fp }, { slot: "VC", name: x.v.name, pos: x.v.pos, team: x.v.team, price: x.v.price, fp: x.v.fp }]
        .concat(x.set.filter(p => p !== x.c && p !== x.v).sort((p, q) => q.fp - p.fp).map(p => ({ slot: "", name: p.name, pos: p.pos, team: p.team, price: p.price, fp: p.fp }))),
      players: x.set.map(p => p.name), teams: teamText(x.set)
    }));
    return { lineups, exact: !stopped, nodes, ms: Date.now() - t0, pool: all.length, n,
             error: lineups.length ? null : stopped ? "Stopped before finding a lineup: lock players, pick fewer games or use the shortlist." : "No lineup fits the budget with these settings." };
  }

  // o.format picks the defaults; any of slots / flex / budget / maxTeam / n / cm / vm given in o wins
  function optimise(o) {
    const f = FORMATS[o.format || "classic"];
    if (!f) return fail("Unknown format " + o.format);
    const x = Object.assign({}, f, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")));
    return f.captain ? captain(x) : positional(x);
  }

  const api = { optimise, FORMATS, POS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.INSITE_OPT = api;
})(typeof window !== "undefined" ? window : this);
