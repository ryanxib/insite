/* insite Optimiser engine (Build C, 1 Nov 2026). Exact best lineups by MEAN projection, captain rules (METHOD D4):
   n players (6), no positions, one Captain (points and price x cm, 1.5) and one Vice (x vm, 1.2), max per team (5),
   budget. Ranked list of distinct (squad, C, VC) triples, the same as model/captain.py top_lineups and last season's
   optimiser (optimizer_2025.jsx). perSquad = keep only the best C/VC for each squad.

   Last season's version tried every lineup. That is fine for one game (~25 players) but not for a full slate
   (9 games ~ 10^11 lineups). This is branch and bound: players sorted by FP, and a branch is dropped only when even its
   best possible finish (ignoring the budget) cannot reach the current top N, or when even its cheapest finish breaks the
   budget. Same answer as trying everything; it only skips lineups that cannot make the list. maxNodes stops a run that
   would take too long: the result then says exact: false.

   Works in the browser (window.INSITE_OPT) and in Node (module.exports) for tests. */
(function (root) {
  "use strict";

  function optimise(o) {
    const n = o.n || 6, B = Number(o.budget), K = Math.max(1, o.topN || 10), maxTeam = o.maxTeam || n;
    const cm = Math.max(1, o.cm == null ? 1.5 : Number(o.cm)), vm = Math.max(1, o.vm == null ? 1.2 : Number(o.vm));
    const hiX = Math.max(cm, vm) - 1, loX = Math.min(cm, vm) - 1;     // extra share for the bigger and smaller multiplier
    const maxNodes = o.maxNodes || 4e7;
    const bans = new Set(o.bans || []), lockN = new Set((o.locks || []).filter(x => !bans.has(x)));
    const all = (o.players || []).filter(p => p && p.name && !bans.has(p.name) && isFinite(p.price) && p.price > 0 && p.fp != null && isFinite(p.fp));
    const missing = [...lockN].filter(x => !all.some(p => p.name === x));
    if (missing.length) return { error: "Locked but not in the pool (out, no projection, or filtered): " + missing.join(", "), lineups: [], exact: true, nodes: 0 };
    if (!isFinite(B) || B <= 0) return { error: "Set a budget.", lineups: [], exact: true, nodes: 0 };
    const locks = all.filter(p => lockN.has(p.name));
    const free = all.filter(p => !lockN.has(p.name)).sort((a, b) => b.fp - a.fp || a.price - b.price || (a.name < b.name ? -1 : 1));
    const need = n - locks.length;
    if (need < 0) return { error: `${locks.length} players locked, lineup has ${n}.`, lineups: [], exact: true, nodes: 0 };
    if (need > free.length) return { error: `Only ${all.length} players in the pool; a lineup needs ${n}.`, lineups: [], exact: true, nodes: 0 };

    const teams = new Map(); [...locks, ...free].forEach(p => { if (!teams.has(p.team)) teams.set(p.team, teams.size); });
    const cnt = new Int32Array(teams.size);
    for (const p of locks) if (++cnt[teams.get(p.team)] > maxTeam) return { error: `More than ${maxTeam} locked players from ${p.team}.`, lineups: [], exact: true, nodes: 0 };
    const N = free.length, fp = free.map(p => p.fp), pr = free.map(p => p.price), tm = free.map(p => teams.get(p.team));
    const pre = new Float64Array(N + 1); for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + fp[i];
    // cheapest prices from index i on: cheap[i] = the `need` smallest, sorted, as prefix sums
    const cheap = [], sufMin = new Float64Array(N + 1).fill(Infinity);
    { let w = []; for (let i = N - 1; i >= 0; i--) { w.push(pr[i]); w.sort((a, b) => a - b); if (w.length > need) w.pop(); const ps = [0]; w.forEach(v => ps.push(ps[ps.length - 1] + v)); cheap[i] = ps; sufMin[i] = Math.min(sufMin[i + 1], pr[i]); } cheap[N] = [0]; }
    const lockFp = locks.reduce((s, p) => s + p.fp, 0), lockPr = locks.reduce((s, p) => s + p.price, 0);
    const lockTop = locks.map(p => p.fp).sort((a, b) => b - a), lockMin = locks.reduce((m, p) => Math.min(m, p.price), Infinity);

    const best = [];     // top K, sorted by pts desc then cost asc
    const thr = () => best.length < K ? -Infinity : best[K - 1].pts;
    const add = (pts, cost, set, c, v) => {
      if (best.length >= K && (pts < best[K - 1].pts - 1e-9 || (Math.abs(pts - best[K - 1].pts) <= 1e-9 && cost >= best[K - 1].cost))) return;
      const it = { pts, cost, set, c, v };
      let i = best.length; while (i > 0 && (best[i - 1].pts < pts - 1e-9 || (Math.abs(best[i - 1].pts - pts) <= 1e-9 && best[i - 1].cost > cost))) i--;
      best.splice(i, 0, it); if (best.length > K) best.pop();
    };
    const sq = locks.slice();   // current squad (player objects)
    let nodes = 0, stopped = false;
    const t0 = Date.now();

    function leaf(fpSum, prSum) {
      // every ordered C/VC pair; perSquad keeps only the best one
      let bp = null;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const cost = prSum + (cm - 1) * sq[a].price + (vm - 1) * sq[b].price;
        if (cost > B + 1e-6) continue;
        const pts = fpSum + (cm - 1) * sq[a].fp + (vm - 1) * sq[b].fp;
        if (o.perSquad) { if (!bp || pts > bp.pts + 1e-9 || (Math.abs(pts - bp.pts) <= 1e-9 && cost < bp.cost)) bp = { pts, cost, a, b }; }
        else add(pts, cost, sq.slice(), sq[a], sq[b]);
      }
      if (bp) add(bp.pts, bp.cost, sq.slice(), sq[bp.a], sq[bp.b]);
    }

    // Upper bound on the final score if the next k free players come from index j on (ignoring the budget):
    // current FP + the next k FPs in sorted order + captain extras on the two best FPs the squad could hold.
    function bound(j, k, fpSum, top1, top2) {
      let a = top1, b = top2;
      for (const x of k >= 2 ? [fp[j], fp[j + 1]] : [fp[j]]) { if (x > a) { b = a; a = x; } else if (x > b) b = x; }
      return fpSum + pre[j + k] - pre[j] + hiX * (isFinite(a) ? a : 0) + loX * (isFinite(b) ? b : 0);
    }

    // i = next free index to consider, k = free players still to add
    function dfs(i, k, fpSum, prSum, top1, top2, minPr) {
      if (++nodes > maxNodes) { stopped = true; return; }
      if (k === 0) { leaf(fpSum, prSum); return; }
      if (N - i < k) return;
      // cheapest finish: k cheapest from i on, captain extras at least the squad's lowest price
      const mp = Math.min(minPr, sufMin[i]);
      if (prSum + cheap[i][k] + (cm - 1 + vm - 1) * mp > B + 1e-6) return;
      for (let j = i; j <= N - k; j++) {
        if (stopped) return;
        // FP is sorted high to low, so the bound only falls as j moves on: stop once it cannot reach the list
        if (bound(j, k, fpSum, top1, top2) < thr() - 1e-9) return;
        const t = tm[j]; if (cnt[t] >= maxTeam) continue;
        cnt[t]++; sq.push(free[j]);
        let n1 = top1, n2 = top2; if (fp[j] > n1) { n2 = n1; n1 = fp[j]; } else if (fp[j] > n2) n2 = fp[j];
        dfs(j + 1, k - 1, fpSum + fp[j], prSum + pr[j], n1, n2, Math.min(minPr, pr[j]));
        sq.pop(); cnt[t]--;
      }
    }
    dfs(0, need, lockFp, lockPr, lockTop[0] ?? -Infinity, lockTop[1] ?? -Infinity, lockMin);

    const lineups = best.map((x, r) => ({
      rank: r + 1, fp: x.pts, cost: x.cost, left: B - x.cost, C: x.c.name, VC: x.v.name,
      rest: x.set.filter(p => p !== x.c && p !== x.v).sort((p, q) => q.fp - p.fp).map(p => p.name),
      players: x.set.map(p => p.name),
      teams: [...x.set.reduce((m, p) => m.set(p.team, (m.get(p.team) || 0) + 1), new Map())].map(([t, c]) => t + " " + c).join(", ")
    }));
    return { lineups, exact: !stopped, nodes, ms: Date.now() - t0, pool: all.length,
             error: lineups.length ? null : stopped ? "Stopped before finding a lineup: lock players, pick fewer games or use the shortlist." : "No lineup fits the budget with these settings." };
  }

  const api = { optimise };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.INSITE_OPT = api;
})(typeof window !== "undefined" ? window : this);
