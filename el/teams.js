/* insite Teams tab (PLAN P6b, 5 Nov 2026): FP and box-score stats SCORED and CONCEDED by each team, per round / GW,
   overall or by FanTeam role. SAME FILE in ryanxib/euroleague-dfs and ryanxib/nba.dfs (site/teams.js): change both.
   The page (app.js) loads data/teams.json and calls INSITE_TEAMS.render(el, data, store).

   data/teams.json (written by scripts/build_site.py, one format for both leagues):
     unit   "Round" | "GW"                      name of the time column
     stats  [[key, label], ...]                 the order of numbers in each v[] array
     roles  ["PG", "SG", "SF", "PF", "C"]       role buckets after "All" (a "?" bucket only if some player has no role)
     rows   [{g: game id, r: round/GW number, d: date, t: team, o: opponent, v: [[All stats], [role 1 stats], ...]}]
            one row per team per game = what that team's players SCORED. Conceded = the opponent's row in the same game.
   Numbers are totals for the game (sum over the team's players). The page shows per-game averages. */
(function () {
  "use strict";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f1 = v => v == null || !isFinite(v) ? "—" : Number(v).toFixed(1);
  const sgn1 = v => v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(1);
  const LAST = 5;      // 'Last 5' column: the team's last 5 games

  /* All numbers for one view. side: "for" | "against"; si: stat index; ri: 0 = All, 1.. = roles[ri - 1].
     Returns {teams: [{t, gp, avg, last, byR: {round: [values]}}], rounds: [..], lg: league per-game average, lgR: {round: avg}}. */
  function table(D, side, si, ri) {
    const byGame = new Map();
    D.rows.forEach(x => { if (!byGame.has(x.g)) byGame.set(x.g, []); byGame.get(x.g).push(x); });
    const T = new Map(), rounds = new Set(), all = [], perR = new Map();
    D.rows.forEach(x => {
      let src = x;
      if (side === "against") { src = (byGame.get(x.g) || []).find(y => y.t !== x.t); if (!src) return; }   // opponent's row
      const v = src.v[ri] ? src.v[ri][si] : null; if (v == null) return;
      const k = T.get(x.t) || { t: x.t, games: [] }; T.set(x.t, k);
      k.games.push({ r: x.r, d: x.d, o: x.o, v });
      rounds.add(x.r); all.push(v);
      if (!perR.has(x.r)) perR.set(x.r, []); perR.get(x.r).push(v);
    });
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    const teams = [...T.values()].map(k => {
      k.games.sort((a, b) => a.r - b.r || String(a.d).localeCompare(String(b.d)));
      const byR = {}; k.games.forEach(g => { (byR[g.r] = byR[g.r] || []).push(g); });
      return { t: k.t, gp: k.games.length, avg: mean(k.games.map(g => g.v)), last: mean(k.games.slice(-LAST).map(g => g.v)), byR };
    });
    const lgR = {}; perR.forEach((a, r) => { lgR[r] = mean(a); });
    return { teams, rounds: [...rounds].sort((a, b) => a - b), lg: mean(all), lgR, sd: sd(all) };
  }
  function sd(a) { if (a.length < 2) return null; const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); }

  function render(el, D, store) {
    const st = Object.assign({ side: "against", stat: 0, role: 0, show: "val", sort: "avg", dir: -1 }, store.get("teams", {}));
    const save = () => store.set("teams", st);
    const roleOpts = [["0", "All"]].concat(D.roles.map((r, i) => [String(i + 1), r]));
    const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-k="${key}" data-v="${esc(v)}" aria-pressed="${String(st[key]) === String(v)}">${esc(l)}</button>`).join("")}</div>`;
    function draw() {
      const si = Number(st.stat) || 0, ri = Number(st.role) || 0, X = table(D, st.side, si, ri);
      const stat = D.stats[si][1], role = ri ? D.roles[ri - 1] : "All", diff = st.show === "diff";
      const shade = (v, base) => {     // colour by distance from the league average, in standard deviations of one game
        if (v == null || base == null || !X.sd) return "";
        const z = (v - base) / X.sd, good = z > 0;   // above average = green on both sides: scores a lot, or gives up a lot (a weak defence = a target)
        const a = Math.min(Math.abs(z) / 1.5, 1) * 0.55;
        return a < 0.06 ? "" : ` style="background:${good ? `rgba(46,125,50,${a.toFixed(2)})` : `rgba(198,40,40,${a.toFixed(2)})`}"`;
      };
      const cell = (v, base) => `<td class="n"${shade(v, base)}>${v == null ? '<span class="dim">—</span>' : diff ? sgn1(v - base) : f1(v)}</td>`;
      const key = t => st.sort === "t" ? t.t : st.sort === "gp" ? t.gp : st.sort === "last" ? t.last : st.sort.startsWith("r") ? (t.byR[st.sort.slice(1)] ? t.byR[st.sort.slice(1)].reduce((s, g) => s + g.v, 0) / t.byR[st.sort.slice(1)].length : null) : t.avg;
      const rows = X.teams.slice().sort((a, b) => { const x = key(a), y = key(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * st.dir; });
      const th = (k, l, n) => `<th data-s="${k}"${n ? ' class="n"' : ""}${st.sort === k ? ` aria-sort="${st.dir < 0 ? "descending" : "ascending"}"` : ""}><button type="button">${l}</button></th>`;
      const minGP = Math.min(...X.teams.map(t => t.gp));
      el.querySelector("#tm-body").innerHTML = `
        <p class="sub">${st.side === "for" ? "Scored by" : "Conceded by"} each team: ${esc(stat)}${ri ? ` by ${esc(role)}s (players' current FanTeam role)` : " (all players)"}, per game. ${diff ? "Shown as the gap to the league average for that column." : ""}
          League average ${f1(X.lg)} per game. ${st.side === "against" ? "Green = gives up more than average (a weak spot to target)." : "Green = scores more than average."} Red = the reverse.</p>
        <div class="tbl-wrap"><table class="teams"><thead><tr>${th("t", "Team")}${th("gp", "GP", 1)}${th("avg", "Season", 1)}${th("last", "Last " + LAST, 1)}${X.rounds.map(r => th("r" + r, (D.unit === "GW" ? "GW" : "R") + r, 1)).join("")}</tr></thead>
        <tbody>${rows.map(t => `<tr><td class="pl">${esc(t.t)}</td><td class="n">${t.gp}</td>${cell(t.avg, X.lg)}${cell(t.last, X.lg)}${X.rounds.map(r => {
          const g = t.byR[r]; if (!g) return '<td class="n"><span class="dim">—</span></td>';
          const v = g.reduce((s, x) => s + x.v, 0) / g.length;
          return cell(v, X.lgR[r]).replace("</td>", `<span class="opp">${g.map(x => esc(x.o)).join(" ")}${g.length > 1 ? " ·" + g.length + "g" : ""}</span></td>`);
        }).join("")}</tr>`).join("")}
        <tr class="lg"><td class="pl">League</td><td class="n"></td><td class="n">${f1(X.lg)}</td><td class="n"></td>${X.rounds.map(r => `<td class="n">${f1(X.lgR[r])}</td>`).join("")}</tr></tbody></table></div>
        <p class="note">Small text under each number = the opponent that game${D.unit === "GW" ? " (·2g = two games that GW: the number is the average)" : ""}. ${minGP < 10 ? `Few games so far (${minGP}${minGP === X.teams.reduce((m, t) => Math.max(m, t.gp), 0) ? "" : "+"} per team): one blowout moves a team a lot, so most gaps are luck this early. ` : ""}A flag for your judgement, not in the projection. One game's spread (sd) for this view: ${f1(X.sd)}.</p>`;
      el.querySelectorAll("#tm-body th button").forEach(b => b.addEventListener("click", () => { const k = b.parentElement.dataset.s; if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = k === "t" ? 1 : -1; } save(); draw(); }));
    }
    el.innerHTML = `<section><div class="sec-head"><div><h1>Teams</h1>
        <p class="sub">FanTeam points and box-score stats each team scores and gives up, ${D.unit === "GW" ? "per gameweek" : "per round"}. Conceded by role answers 'which defence leaks points to centres', and so on.</p></div></div>
        <div class="toggles tm-tg">${seg("side", [["against", "Conceded"], ["for", "Scored"]])}${seg("stat", D.stats.map(([, l], i) => [String(i), l]))}${seg("role", roleOpts)}${seg("show", [["val", "Per game"], ["diff", "v league avg"]])}</div></section>
      <section id="tm-body"></section>`;
    el.querySelectorAll(".tm-tg .seg button").forEach(b => b.addEventListener("click", () => {
      st[b.dataset.k] = b.dataset.v; save();
      el.querySelectorAll(`.tm-tg .seg button[data-k="${b.dataset.k}"]`).forEach(x => x.setAttribute("aria-pressed", x.dataset.v === b.dataset.v));
      draw();
    }));
    draw();
  }
  window.INSITE_TEAMS = { render, table };
})();
