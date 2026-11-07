/* insite app: Home, Player (PLAN 5.1), Slate and Matrix (PLAN 5.2), write-back (5.4), Simulator (5.5), Optimiser (Build C; engine site/opt.js).
   Reads data/meta.json, data/players.json, data/p/<id>.json, data/slates.json, data/s/<folder>.json.
   Single-file preview: build_site.py --bundle sets window.INSITE = {meta, players, p, slates, s} and no fetch is made. */
(function () {
  "use strict";
  const ROLES = ["PG", "SG", "SF", "PF", "C"];
  const B = window.INSITE || null;
  const app = document.getElementById("app");
  let META = null, PLAYERS = null, SLATES = null;
  const cache = {};

  const store = {
    get(k, d) { try { const v = localStorage.getItem("insite." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("insite." + k, JSON.stringify(v)); } catch (e) { /* storage off: fine */ } }
  };

  /* ---------- Write-back (PLAN 5.4): GitHub contents API on the private repo ryanxib/nba.dfs ----------
     Token = fine-grained, nba.dfs only, Contents read + write (5.5 needs nothing more: a pushed request starts the sim Action). Pasted once per device on #settings,
     kept in this browser's storage, sent only to api.github.com. Each save = one commit on main. */
  const GH = {
    repo: "ryanxib/nba.dfs", branch: "main",
    token() { return store.get("gh", null); },
    async req(path, opt) {
      const t = this.token(); if (!t) throw new Error("no token on this device");
      const r = await fetch("https://api.github.com/repos/" + this.repo + path, Object.assign({ cache: "no-store" }, opt, {
        headers: { Authorization: "Bearer " + t, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }));
      return r;
    },
    async get(file) {    // -> {text, sha}; text null if the file does not exist yet
      const r = await this.req("/contents/" + file.split("/").map(encodeURIComponent).join("/") + "?ref=" + this.branch);
      if (r.status === 404) return { text: null, sha: null };
      if (!r.ok) throw new Error(ghErr(r.status));
      const j = await r.json();
      const bin = atob(j.content.replace(/\n/g, ""));
      return { text: new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))), sha: j.sha };
    },
    async list(dir) {    // -> [{name, type, path}] ; [] if the folder does not exist yet
      const r = await this.req("/contents/" + dir.split("/").map(encodeURIComponent).join("/") + "?ref=" + this.branch);
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(ghErr(r.status));
      return r.json();
    },
    async put(file, text, msg, sha) {    // -> new sha. 409/422 = changed elsewhere since it was read
      return this.putBytes(file, new TextEncoder().encode(text), msg, sha);
    },
    async putBytes(file, u, msg, sha) {  // u = Uint8Array (5.5: pool .xlsx from the phone)
      let bin = ""; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      const body = { message: msg, content: btoa(bin), branch: this.branch }; if (sha) body.sha = sha;
      const r = await this.req("/contents/" + file.split("/").map(encodeURIComponent).join("/"), { method: "PUT", body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.status === 409 || r.status === 422 ? "the file changed on GitHub since this page read it. Reload and redo the change." : ghErr(r.status));
      return (await r.json()).content.sha;
    }
  };
  function ghErr(code) {
    return { 401: "token rejected (expired or mistyped). Paste it again on Settings.", 403: "token has no write access to nba.dfs (Contents: read and write).",
             404: "token cannot see ryanxib/nba.dfs (repository not selected on the token)." }[code] || "GitHub error " + code;
  }
  const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";
  // CSV: small files we write ourselves, with quotes where needed
  const csvCell = v => { const t = v == null ? "" : String(v); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const toCSV = (cols, rows) => [cols.join(",")].concat(rows.map(r => cols.map(c => csvCell(r[c])).join(","))).join("\n") + "\n";
  function fromCSV(text) {
    const out = [], rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift() || [];
    rows.filter(r => r.length > 1 || r[0] !== "").forEach(r => { const o = {}; head.forEach((h, j) => { o[h] = r[j] ?? ""; }); out.push(o); });
    return out;
  }
  window.INSITE_CSV = { toCSV, fromCSV };    // for tests
  const OV_COLS = ["player", "status", "fp", "reason", "saved_utc"];
  const ovPath = id => "analysis/" + id + "/overrides.csv";
  const shPath = key => key === "s1" ? "data/raw/fanteam/s1_shortlist.csv" : "analysis/" + key + "/shortlist.csv";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f1 = v => v == null ? "—" : Number(v).toFixed(1);
  const f2 = v => v == null ? "—" : Number(v).toFixed(2);
  const fpm = p => p.proj != null && p.price ? p.proj / p.price : null;
  const spm = p => p.avg != null && p.price ? p.avg / p.price : null;
  const dshort = iso => { if (!iso) return "—"; const d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso); return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }); };

  async function getJSON(path) {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  }
  async function loadBase() {
    if (PLAYERS) return;
    if (B) { META = B.meta; PLAYERS = B.players; return; }
    [META, PLAYERS] = await Promise.all([getJSON("data/meta.json"), getJSON("data/players.json")]);
  }
  async function loadSlates() {
    if (SLATES) return SLATES;
    SLATES = B ? (B.slates || []) : await getJSON("data/slates.json");
    return SLATES;
  }
  async function loadSlate(id) {
    const k = "s:" + id;
    if (cache[k]) return cache[k];
    cache[k] = B ? B.s[id] : await getJSON("data/s/" + encodeURIComponent(id) + ".json");
    return cache[k];
  }
  let TEAMS = null;
  async function loadTeams() { if (!TEAMS) TEAMS = B ? B.teams : await getJSON("data/teams.json"); return TEAMS; }
  async function renderTeams() {     // P6d: site/teams.js (SAME FILE as euroleague-dfs) draws the page
    app.innerHTML = shell("teams", "Teams") + `<main class="wrap" id="tm"><p class="loading">Loading…</p></main>`;
    let D; try { D = await loadTeams(); } catch (e) { document.getElementById("tm").innerHTML = `<p>Could not load team totals (${esc(e.message)}). Reload to try again.</p>`; return; }
    if (!window.INSITE_TEAMS) { document.getElementById("tm").innerHTML = "<p>teams.js did not load.</p>"; return; }
    window.INSITE_TEAMS.render(document.getElementById("tm"), D, store);
    if (D.roles.includes("?")) document.getElementById("tm").insertAdjacentHTML("beforeend", '<p class="note">Role ? = players who are in no FanTeam pool saved in the repo (ESPN box scores have only G / F / C). Never guessed.</p>');
    window.scrollTo(0, 0);
  }
  let INJ = null;
  async function loadInjuries() {
    if (INJ) return INJ;
    INJ = B ? B.inj : await getJSON("data/injuries.json");
    return INJ;
  }
  async function loadPlayer(id) {
    if (cache[id]) return cache[id];
    cache[id] = B ? B.p[id] : await getJSON("data/p/" + encodeURIComponent(id) + ".json");
    return cache[id];
  }

  function statusChip(p) {
    if (p.status === "Out") return `<span class="chip out">Out${p.ret ? " · " + esc(dshort(p.ret)) : ""}</span>`;
    if (p.status) return `<span class="chip dtd">${esc(p.status)}</span>`;
    return `<span class="chip ok">Available</span>`;
  }

  function shell(view, title) {
    const m = META;
    const fresh = m ? `Box scores to ${dshort(m.box_to)} · S1 prices ${dshort(m.pool_date)} · injuries ${esc(m.injuries_updated ? dshort(m.injuries_updated) + " " + m.injuries_updated.slice(11, 16) + "Z" : "—")} · built ${esc(m.built_utc)}` : "";
    const soon = ["Tracker"].map(n => `<span aria-disabled="true">${n}<small>soon</small></span>`).join("");
    const nav = [["home", "Home"], ["slate", "Slate"], ["injuries", "Injuries"], ["matrix", "Matrix"], ["opt", "Optimiser"], ["sim", "Simulator"], ["teams", "Teams"]].map(([v, l]) => `<a href="#${v}" class="${view === v ? "on" : ""}">${l}</a>`).join("");
    const gear = `<a href="#settings" class="${view === "settings" ? "on" : ""}" title="${GH.token() ? "Write-back on" : "Write-back off: add a token"}">Settings${GH.token() ? "" : "<small>no token</small>"}</a>`;
    document.title = title ? title + " · insite" : "insite";
    return `<header class="bar"><div class="wrap">
      <a class="brand" href="#home">insite<span>.</span></a>
      <div class="seg league" role="group" aria-label="League"><a href="./" aria-pressed="true" aria-current="page">NBA</a><a href="el/" aria-pressed="false">EuroLeague</a></div>
      <nav class="nav" aria-label="Main">${nav}${view === "player" ? `<a href="${esc(location.hash)}" class="on">Player</a>` : ""}${soon}${gear}</nav>
      <div class="fresh">${fresh}</div></div></header>`;
  }

  /* ---------- Home ---------- */
  const H = Object.assign({ src: "season", metric: "fp", q: "", team: "", role: "", pmin: "", pmax: "", fmin: "", fmax: "", avail: true, sort: "proj", dir: -1 },
                          store.get("home", {}));
  const save = () => store.set("home", { src: H.src, metric: H.metric, avail: H.avail, sort: H.sort, dir: H.dir });

  function topFive() {
    const minGp = META.min_gp_season || 3;
    const val = p => H.src === "season" ? (H.metric === "fp" ? p.avg : spm(p)) : (H.metric === "fp" ? p.proj : fpm(p));
    const ok = PLAYERS.filter(p => p.avail && (H.src !== "season" || p.gp >= minGp) && val(p) != null);
    return ROLES.map(r => {
      const top = ok.filter(p => p.pos === r).sort((a, b) => val(b) - val(a)).slice(0, 5);
      const rows = top.map((p, i) => `<li><a href="#player-${esc(p.id)}"><span class="rk">${i + 1}</span>
        <span class="nm">${esc(p.name)}<small>${esc(p.team)} · ${f1(p.price)}M${H.src === "season" ? " · " + p.gp + " GP" : ""}</small></span>
        <span class="v">${H.metric === "fp" ? f1(val(p)) : f2(val(p))}</span></a></li>`).join("");
      return `<div class="col"><h3>${r}<small>${H.metric === "fp" ? "FP / game" : "FP per M"}</small></h3><ol>${rows || '<li class="empty">No player qualifies yet.</li>'}</ol></div>`;
    }).join("");
  }

  const COLS = [
    ["name", "Player", 0], ["team", "Team", 0], ["pos", "Role", 0], ["price", "Price", 1], ["status", "Status", 0],
    ["proj", "Proj FP", 1], ["fpm", "Proj FP/M", 1], ["avg", "Season avg (GP)", 1], ["props", "Props FP next", 1]
  ];
  function sortVal(p, k) { return k === "fpm" ? fpm(p) : k === "status" ? (p.status === "Out" ? 2 : p.status ? 1 : 0) : p[k]; }
  function filtered() {
    const q = H.q.trim().toLowerCase(), n = v => v === "" ? null : Number(v);
    const [pmin, pmax, fmin, fmax] = [n(H.pmin), n(H.pmax), n(H.fmin), n(H.fmax)];
    const rows = PLAYERS.filter(p => (!q || p.name.toLowerCase().includes(q)) && (!H.team || p.team === H.team) && (!H.role || p.pos === H.role)
      && (!H.avail || p.avail) && (pmin == null || p.price >= pmin) && (pmax == null || p.price <= pmax)
      && (fmin == null || (p.proj != null && p.proj >= fmin)) && (fmax == null || (p.proj != null && p.proj <= fmax)));
    return rows.sort((a, b) => {
      const x = sortVal(a, H.sort), y = sortVal(b, H.sort);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * H.dir;
    });
  }
  function tableRows() {
    return filtered().map(p => `<tr><td class="pl"><a href="#player-${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(p.team)}</td>
      <td><span class="pos">${esc(p.pos)}</span></td><td class="n">${f1(p.price)}</td><td>${statusChip(p)}</td>
      <td class="n">${f1(p.proj)}</td><td class="n">${f2(fpm(p))}</td>
      <td class="n">${p.gp ? f1(p.avg) + ' <span class="dim">(' + p.gp + ")</span>" : '<span class="dim">— (0)</span>'}</td>
      <td class="n">${p.props != null ? f1(p.props) : '<span class="dim">—</span>'}</td></tr>`).join("");
  }
  function renderTable() {
    const list = filtered();
    document.getElementById("tb").innerHTML = tableRows();
    document.getElementById("cnt").textContent = `${PLAYERS.length} in pool · ${META.n_proj} with a projection · showing ${list.length}`;
    document.querySelectorAll("thead th").forEach(th => {
      if (th.dataset.k === H.sort) th.setAttribute("aria-sort", H.dir < 0 ? "descending" : "ascending"); else th.removeAttribute("aria-sort");
    });
  }

  function renderHome() {
    const teams = [...new Set(PLAYERS.map(p => p.team))].sort();
    const seg = (name, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${H[name] === v}">${l}</button>`).join("")}</div>`;
    app.innerHTML = shell("home") + `<main class="wrap">
      <section>
        <div class="sec-head"><div><h1>Top 5 by role</h1>
          <p class="sub">Season-game pool and S1 prices. Available players only (ESPN injury report: Out is hidden). This season needs ${META.min_gp_season}+ games played.</p></div>
          <div class="toggles">${seg("src", [["season", "This season"], ["proj", "Projected"]])}${seg("metric", [["fp", "Avg FP"], ["fpm", "FP per M"]])}</div></div>
        <div class="top5" id="top5">${topFive()}</div>
      </section>
      <section>
        <div class="sec-head"><h2>Player roster</h2><span class="count" id="cnt"></span></div>
        <form class="filters" id="flt" onsubmit="return false">
          <label class="grow">Search<input type="search" id="f-q" placeholder="Player name" value="${esc(H.q)}"></label>
          <label>Team<select id="f-team"><option value="">All</option>${teams.map(t => `<option${t === H.team ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
          <label>Role<select id="f-role"><option value="">All</option>${ROLES.map(r => `<option${r === H.role ? " selected" : ""}>${r}</option>`).join("")}</select></label>
          <label>Price (M)<span class="pair"><input type="number" id="f-pmin" step="0.5" min="0" value="${esc(H.pmin)}" aria-label="Price from"> to <input type="number" id="f-pmax" step="0.5" min="0" value="${esc(H.pmax)}" aria-label="Price to"></span></label>
          <label>Proj FP<span class="pair"><input type="number" id="f-fmin" step="1" min="0" value="${esc(H.fmin)}" aria-label="Projected FP from"> to <input type="number" id="f-fmax" step="1" min="0" value="${esc(H.fmax)}" aria-label="Projected FP to"></span></label>
          <label class="chk"><input type="checkbox" id="f-avail"${H.avail ? " checked" : ""}> Available only</label>
          <button type="button" id="f-reset">Clear filters</button>
        </form>
        <div class="tbl-wrap"><table><thead><tr>${COLS.map(([k, l, n]) => `<th data-k="${k}"${n ? ' class="n"' : ""}><button type="button">${l}</button></th>`).join("")}</tr></thead><tbody id="tb"></tbody></table></div>
        <p class="note">Proj FP = preseason consensus FP per game (FantasyPros, 16 Oct). Our own model replaces it only once it beats consensus. Proj FP/M = Proj FP per million of S1 price.
        Season avg = FP per game played this season. Props FP shows only where a bookmaker line exists for a game that has not started (points, rebounds, assists, 3s; the rest from consensus). ${META.props_games ? META.props_games + " game(s) with props now." : "No upcoming games with props right now."}</p>
      </section></main>`;

    app.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
      const [k, v] = Object.entries(b.dataset)[0]; H[k] = v; save();
      app.querySelectorAll(`.seg button[data-${k}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[k] === v));
      document.getElementById("top5").innerHTML = topFive();
    }));
    const bind = (id, key, ev) => document.getElementById(id).addEventListener(ev || "input", e => { H[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value; if (key === "avail") save(); renderTable(); });
    bind("f-q", "q"); bind("f-team", "team", "change"); bind("f-role", "role", "change");
    ["pmin", "pmax", "fmin", "fmax"].forEach(k => bind("f-" + k, k)); bind("f-avail", "avail", "change");
    document.getElementById("f-reset").addEventListener("click", () => { Object.assign(H, { q: "", team: "", role: "", pmin: "", pmax: "", fmin: "", fmax: "", avail: true }); save(); renderHome(); });
    app.querySelectorAll("thead th button").forEach(b => b.addEventListener("click", () => {
      const k = b.parentElement.dataset.k;
      if (H.sort === k) H.dir = -H.dir; else { H.sort = k; H.dir = ["name", "team", "pos", "status"].includes(k) ? 1 : -1; }
      save(); renderTable();
    }));
    renderTable();
  }

  /* ---------- Player ---------- */
  function scatter(season, yMax, proj) {
    const W = 340, Ht = 190, x0 = 30, x1 = W - 8, top = 8, h = Ht - 30, maxN = 82;
    const Y = v => top + h - (v / yMax) * h, X = i => x0 + (i / (maxN - 1)) * (x1 - x0);
    const step = yMax > 100 ? 50 : 25, ticks = [];
    for (let v = 0; v <= yMax; v += step) ticks.push(v);
    const cur = season.s === "2026-27";
    const grid = ticks.map(v => `<line class="grid" x1="${x0}" x2="${x1}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="${x0 - 5}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`).join("");
    const xt = [1, 20, 40, 60, 82].map(n => `<text class="axis" x="${X(n - 1).toFixed(1)}" y="${Ht - 8}" text-anchor="middle">${n}</text>`).join("");
    const dots = season.g.map((v, i) => `<circle class="dot${cur ? " cur" : ""}" cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${cur ? 3.6 : 2.6}"><title>Game ${i + 1}: ${v} FP</title></circle>`).join("");
    const avg = `<line class="avg" x1="${x0}" x2="${x1}" y1="${Y(season.fp).toFixed(1)}" y2="${Y(season.fp).toFixed(1)}"/>`;
    const pl = cur && proj ? `<line class="proj" x1="${x0}" x2="${x1}" y1="${Y(proj).toFixed(1)}" y2="${Y(proj).toFixed(1)}"/>` : "";
    return `<figure class="chart" style="margin:0"><h3>${season.s}<small>avg ${f1(season.fp)} · ${season.gp} games</small></h3>
      <svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="${season.s}: ${season.gp} games, average ${f1(season.fp)} FP">${grid}${xt}${avg}${pl}${dots}</svg></figure>`;
  }

  async function renderPlayer(id) {
    const p = PLAYERS.find(x => x.id === id);
    if (!p) { app.innerHTML = shell("player", "Not found") + `<main class="wrap"><p>No player with id "${esc(id)}" in the S1 pool. <a href="#home">Back to the roster</a></p></main>`; return; }
    app.innerHTML = shell("player", p.name) + `<main class="wrap"><p class="loading">Loading ${esc(p.name)}…</p></main>`;
    let d;
    try { d = await loadPlayer(id); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load this player's games (${esc(e.message)}). Reload the page to try again.</p>`; return; }
    if (location.hash !== "#player-" + id) return;

    const inj = d.inj ? `<div class="injury${d.inj.status === "Out" ? " out" : ""}"><strong>${esc(d.inj.status)}</strong>${d.inj.injury ? " · " + esc(d.inj.injury) : ""}${d.inj.ret ? " · ESPN return date " + esc(dshort(d.inj.ret)) : ""}${d.inj.comment ? "<br>" + esc(d.inj.comment) : ""}${d.inj.updated ? ` <span class="dim">(ESPN, ${esc(dshort(d.inj.updated))})</span>` : ""}</div>` : "";
    const tiles = [
      ["S1 price", f1(p.price) + "M", ""],
      ["Projected FP/G", f1(p.proj), p.proj != null ? "consensus" : "no projection"],
      ["Season avg FP/G", p.gp ? f1(p.avg) : "—", p.gp ? `${p.gp} games · ${f1(p.mins)} min` : "no games yet"],
      ["GW1-10 outlook", p.outlook != null ? Math.round(p.outlook) : "—", "expected FP, best game per GW"],
      ["Props FP next game", f1(p.props), p.props != null ? "bookmaker lines" : "no line pulled"]
    ].map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");

    const row = (label, r, cls) => `<tr class="${cls || ""}"><td>${label}</td><td class="n">${r.gp}</td><td class="n">${f1(r.tot)}</td><td class="n">${f1(r.fp)}</td><td class="n">${f1(r.min)}</td><td class="n">${f1(r.pts)}</td><td class="n">${f1(r.reb)}</td><td class="n">${f1(r.ast)}</td><td class="n">${f1(r.tpm)}</td><td class="n">${f1(r.stl)}</td><td class="n">${f1(r.blk)}</td><td class="n">${f2(r.dd)}</td><td class="n">${f2(r.td)}</td></tr>`;
    const seasonRows = d.seasons.map(s => row(s.s, s, s.s === "2026-27" ? "cur" : "")).join("") + (d.proj ? row("2026-27 projection", d.proj, "proj") : "");

    const allG = d.seasons.flatMap(s => s.g);
    const yMax = Math.max(75, Math.ceil(Math.max(...allG, p.proj || 0) / 25) * 25);
    const charts = d.seasons.length ? d.seasons.map(s => scatter(s, yMax, p.proj)).join("") : '<p class="empty">No NBA games in 2024-25 to 2026-27.</p>';

    const log = d.log.slice().reverse().map(e => {
      const diff = e.fp != null && e.ours != null ? e.fp - e.ours : null;
      return `<tr><td>${esc(dshort(e.d))}</td><td>${esc(e.opp)}</td><td class="n">${e.min == null ? "—" : e.min}</td>
        <td class="n">${e.fp == null ? `<span class="dim">${esc(e.dnp === "COACH'S DECISION" ? "DNP coach" : e.dnp || "DNP")}</span>` : f2(e.fp)}</td>
        <td class="n">${e.ours == null ? '<span class="dim">—</span>' : f1(e.ours)}</td>
        <td class="n">${diff == null ? "" : `<span class="${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : ""}${f1(diff)}</span>`}</td></tr>`;
    }).join("");

    app.querySelector("main").innerHTML = `
      <a class="back" href="#home">← Back to roster</a>
      <section class="p-head"><h1>${esc(p.name)}</h1>
        <div class="meta"><span class="pos">${esc(p.pos)}</span><span>${esc(p.team)}</span>${statusChip(p)}${p.swing && p.swing !== "normal" ? `<span class="chip dtd">${esc(p.swing)} swing</span>` : ""}</div>${inj}</section>
      <section class="tiles">${tiles}</section>
      <section><div class="sec-head"><div><h2>Season stats</h2><p class="sub">Per game played. DD/G and TD/G = share of games with a double-double or triple-double (DD includes TD games). FanTeam does not pay the DD bonus on top of a TD. Projection row = consensus.</p></div></div>
        <div class="tbl-wrap"><table><thead><tr><th>Season</th><th class="n">Games</th><th class="n">Total FP</th><th class="n">FP/G</th><th class="n">Min</th><th class="n">Pts</th><th class="n">Reb</th><th class="n">Ast</th><th class="n">3s</th><th class="n">Stl</th><th class="n">Blk</th><th class="n">DD/G</th><th class="n">TD/G</th></tr></thead><tbody>${seasonRows || '<tr><td colspan="13" class="dim">No games.</td></tr>'}</tbody></table></div></section>
      <section><div class="sec-head"><div><h2>Every game, by season</h2><p class="sub">Across = game number (games played). Up = FanTeam points. Dashed line = season average${p.proj != null ? "; dotted line on 2026-27 = projection" : ""}. Same scale on all charts.</p></div></div>
        <div class="charts">${charts}</div></section>
      <section><div class="sec-head"><div><h2>2026-27 game log</h2><p class="sub">Ours = our frozen daily projection for that night (only nights with a daily slate from 25 Oct, when slates started saving their date). Gap = FP minus ours.</p></div></div>
        <div class="tbl-wrap"><table><thead><tr><th>Date (US)</th><th>Opp</th><th class="n">Min</th><th class="n">FP</th><th class="n">Ours</th><th class="n">Gap</th></tr></thead><tbody>${log || '<tr><td colspan="6" class="dim">No games yet this season.</td></tr>'}</tbody></table></div></section>`;
    window.scrollTo(0, 0);
  }

  /* ---------- shared for Slate + Matrix ---------- */
  const seg = (state, name, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-${name}="${esc(v)}" aria-pressed="${String(state[name]) === String(v)}">${l}</button>`).join("")}</div>`;
  const isLive = s => !!(s.live && s.live.state === "live" && s.live.lock && Date.now() < Date.parse(s.live.lock));
  const slateLabel = s => `${s.label} · ${dshort(s.us_date)} · ${s.n_games ? s.n_games + " game" + (s.n_games === 1 ? "" : "s") : s.n_usable + " usable"}${s.fmt === "captain" ? " · C/VC" : ""}${isLive(s) ? " · LIVE" : ""}`;
  const mt = iso => iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Malta" }) : "—";
  const byLabel = lab => SLATES.find(s => s.label.toLowerCase() === String(lab).toLowerCase());
  const plink = r => r.id ? `<a href="#player-${esc(r.id)}">${esc(r.name)}</a>` : esc(r.name);
  const sgn = v => v == null ? "" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${f1(v)}</span>`;

  /* ---------- Used FP (Build B) ----------
     Used = what the simulator will use: Ryan's override, else Ours (model). Same rules as model/daily_proj.py +
     model/overrides.py: status out -> excluded; in -> plays (p_play 1, eligible); fp = his FP IF HE PLAYS, the safety
     net still applies: used = p_play x fp + (1 - p_play) x sub's FP. If the override on screen is the one the last run
     applied, Used = that run's number (exact). Otherwise the page works it out at once = estimate (est): exact after
     the re-run (another player's sub can shift when someone is made out or in). Returns {v, est, out}. */
  const ovKey = o => !o ? "" : [(o.status ?? o.st ?? "").toLowerCase(), o.fp === "" || o.fp == null ? "" : Number(o.fp).toFixed(2)].join("|");
  function usedFP(r, o) {
    const ran = r.ov ? { status: r.ov.st, fp: r.ov.fp } : null;
    if (ovKey(o) === ovKey(ran)) return { v: r.out ? null : r.q, est: false, out: !!r.out };
    const st = o ? String(o.status ?? o.st ?? "").toLowerCase() : "";
    const fpo = o && o.fp !== "" && o.fp != null ? Number(o.fp) : null;
    if (st === "out") return { v: null, est: true, out: true };
    // undoing a status the last run applied: the model's own p_play is not saved -> best guess, re-run gives the truth
    let pp = r.pp == null ? 1 : r.pp, el = r.el !== false;
    if (ran && ran.status === "out" && st !== "in") pp = 1;
    if (st === "in") { pp = 1; el = true; }
    const fp = fpo != null ? fpo : (r.pm ?? r.pick);
    if (!el || pp === 0 || fp == null) return { v: null, est: true, out: true };
    const v = pp >= 1 ? fp : pp * fp + (1 - pp) * (r.sp ?? 0);
    return { v, est: true, out: false };
  }
  window.INSITE_USED = usedFP;    // for tests

  /* Lock / Exclude (P6d, 5 Nov; same as EuroLeague 6a): one list per slate on this device, shared by Slate, Optimiser
     and Simulator. Stored with the Optimiser settings (key opt.<slate folder>). Lock = in every lineup; Excl = in none.
     They change which lineups you get only; whether a player plays and his FP are overrides (✎). */
  const pickKey = info => "opt." + info.id;
  const getPicks = info => { const c = store.get(pickKey(info), {}); return { locks: c.locks || [], bans: c.bans || [] }; };
  function togglePick(info, n, what) {   // what: lock | ban. A player is never locked and excluded at once.
    const c = store.get(pickKey(info), {}); c.locks = c.locks || []; c.bans = c.bans || [];
    const on = what === "lock" ? c.locks : c.bans, off = what === "lock" ? c.bans : c.locks;
    const i = on.indexOf(n); if (i >= 0) on.splice(i, 1); else { on.push(n); const j = off.indexOf(n); if (j >= 0) off.splice(j, 1); }
    store.set(pickKey(info), c);
  }
  window.INSITE_PICKS = { getPicks, togglePick };    // for tests
  // a daily slate's shortlist: this device key short.<label> (same as Matrix daily + Optimiser), repo analysis/<folder>/shortlist.csv
  const slShortKey = info => "short." + info.label;
  async function slShortSave(info) {    // throws with a plain message
    if (!GH.token()) throw new Error("no write-back token on this device (Settings)");
    const sh = SH[info.id]; if (!sh || sh.names === null) throw new Error("could not read the saved shortlist from the repo; reload and try again");
    const names = [...new Set(store.get(slShortKey(info), []))].sort(), t = nowIso();
    sh.sha = await GH.put(shPath(info.id), toCSV(["player", "saved_utc"], names.map(n => ({ player: n, saved_utc: t }))), `insite: ${info.label} shortlist (${names.length})`, sh.sha);
    sh.names = new Set(names);
  }

  /* ---------- Slate ---------- */
  const S = Object.assign({ q: "", team: "", role: "", all: false, sort: "used", dir: -1, metric: "fp", pmin: "", pmax: "" }, store.get("slate", {}), { open: null });
  const OVR = {};   // per slate id: {rows: {name: row}, sha, err, pend: Map(name -> row | null)}
  window.addEventListener("beforeunload", e => { if (Object.values(OVR).some(o => o.pend && o.pend.size)) { e.preventDefault(); e.returnValue = ""; } });
  const ovText = o => !o ? "" : [o.st === "out" || o.status === "out" ? "out" : o.st === "in" || o.status === "in" ? "in" : "", (o.fp ?? "") !== "" && o.fp != null ? f1(o.fp) : ""].filter(Boolean).join(" · ");
  const saveS = () => store.set("slate", { all: S.all, sort: S.sort, dir: S.dir, metric: S.metric });
  // Build C: one override source for Slate, Matrix and Optimiser (unsaved edits made on the Slate page count too)
  async function ovrLoad(info) {
    const O = OVR[info.id] || (OVR[info.id] = { rows: null, sha: null, err: null, pend: new Map() });
    if (GH.token() && O.rows === null) {
      try { const f = await GH.get(ovPath(info.id)); O.sha = f.sha; O.rows = {}; if (f.text) fromCSV(f.text).forEach(r => { O.rows[r.player] = r; }); O.err = null; }
      catch (e) { O.err = e.message; O.rows = null; }
    }
    return O;
  }
  // override shown per row: unsaved edit > repo file (live, with token) > what the frozen run applied
  const ovIn = (O, r) => O.pend.has(r.name) ? O.pend.get(r.name) : O.rows ? (O.rows[r.name] || null) : (r.ov ? { status: r.ov.st, fp: r.ov.fp, reason: r.ov.why } : null);

  function slateFlags(r) {
    const f = [];
    if (r.out) f.push(`<span class="chip out">${r.pp === 0 ? "Out" : r.el === false ? "Not eligible" : "Excluded"}</span>`);
    else if (r.pp != null && r.pp < 1) f.push(`<span class="chip dtd" title="Valued with the safety net: ${esc(r.sub || "")}">${esc(r.tag || r.espn || "listed")} · plays ${Math.round(r.pp * 100)}%</span>`);
    if (!r.out && (r.boost || 0) >= META.upside_boost) f.push(`<span class="chip up-chip" title="${esc(r.why || "")}">upside +${f1(r.boost)}</span>`);
    if (r.src === "hist") f.push('<span class="chip mute" title="No consensus line: base = his history">hist</span>');
    return f.join(" ");
  }

  async function renderSlate(lab) {
    await loadSlates();
    if (!SLATES.length) { app.innerHTML = shell("slate", "Slate") + `<main class="wrap"><p>No frozen daily slates yet.</p></main>`; return; }
    const info = lab ? byLabel(lab) : (SLATES.find(isLive) || SLATES[0]);   // Build B: the current slate first
    if (!info) { app.innerHTML = shell("slate", "Slate") + `<main class="wrap"><p>No slate "${esc(lab)}". <a href="#slate">Newest slate</a></p></main>`; return; }
    app.innerHTML = shell("slate", info.label) + `<main class="wrap"><p class="loading">Loading ${esc(info.label)}…</p></main>`;
    let d;
    try { d = await loadSlate(info.id); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load this slate (${esc(e.message)}). Reload the page to try again.</p>`; return; }
    const res = info.results;
    const L = info.live, lockAt = (L && L.lock) || info.lock_utc, live = isLive(info);
    const locked = !!(lockAt && Date.now() >= Date.parse(lockAt));
    const canEdit = !res && !locked;   // P6d: ✎ on every slate before lock, token or not; Save asks for the token
    const O = await ovrLoad(info);
    await shortLoad(info.id, slShortKey(info));
    const ovOf = r => ovIn(O, r);
    const picker = `<label class="pick">Slate<select id="s-pick">${SLATES.map(s => `<option value="${esc(s.label)}"${s.id === info.id ? " selected" : ""}>${esc(slateLabel(s))}</option>`).join("")}</select></label>`;
    const facts = [
      ["Contest", info.contest || "—"], ["US date", dshort(info.us_date)], ["Budget", info.budget != null ? info.budget + "M" : "—"],
      ["Field", info.field ?? "—"], ["Buy-in", info.buy_in != null ? "€" + Number(info.buy_in).toFixed(2) : "—"], ["Paid", info.paid ?? "—"],
      ["Usable", `${info.n_usable} of ${info.n_pool}`], ["Props lines", info.n_props]
    ].concat(info.fmt === "captain" ? [["Format", "C ×1.5 · VC ×1.2"]] : [])
     .concat(lockAt ? [["First tip", mt(lockAt) + " Malta"]] : []).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");

    const a = d.acc;
    const acc = a ? `<section><div class="sec-head"><div><h2>How the projection did</h2>
        <p class="sub">Average miss in FanTeam points (MAE) for players we kept who played. Lower is better. Same players in each column. Ours = frozen mean if he plays; Base = consensus (or history where no consensus line).</p></div></div>
        <div class="tiles">
          <div class="tile"><div class="k">Ours</div><div class="v">${f2(a.ours)}</div><div class="s">${a.n} players</div></div>
          <div class="tile"><div class="k">Base</div><div class="v">${f2(a.base)}</div><div class="s">${a.ours != null && a.base != null ? (a.ours < a.base ? "Ours better by " + f2(a.base - a.ours) : a.ours > a.base ? "Base better by " + f2(a.ours - a.base) : "tie") : ""}</div></div>
          <div class="tile"><div class="k">Props (subset)</div><div class="v">${a.n_props ? f2(a.props) : "—"}</div><div class="s">${a.n_props ? `${a.n_props} players · ours ${f2(a.ours_p)} · base ${f2(a.base_p)}` : "no props this slate"}</div></div>
          <div class="tile"><div class="k">Kept but DNP</div><div class="v">${a.dnp}</div><div class="s">not in the averages</div></div>
        </div><p class="note">One slate is noise. The verdict comes from many slates together (mid-December check).</p></section>` : "";

    const ups = d.rows.filter(r => !r.out && (r.boost || 0) >= META.upside_boost).sort((x, y) => y.boost - x.boost);
    const upside = `<section><div class="sec-head"><div><h2>Injury upside</h2>
        <p class="sub">Teammates of players who were out. Boost = his average FP change in past games without that teammate (2024-27 box scores). A flag, not added to Ours: boost ${META.upside_boost}+ beat Ours by 10+ FP in 26% of cases v 12% normally.</p></div></div>
        ${ups.length ? `<div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Role</th><th class="n">Price</th><th class="n">Ours</th><th class="n">Boost</th><th class="n">Upside FP</th>${res ? '<th class="n">Actual</th>' : ""}<th>Because out</th></tr></thead><tbody>
        ${ups.map(r => `<tr><td class="pl">${plink(r)}</td><td>${esc(r.team)}</td><td><span class="pos">${esc(r.pos)}</span></td><td class="n">${f1(r.price)}</td><td class="n">${f1(r.q)}</td><td class="n up">+${f1(r.boost)}</td><td class="n">${f1(r.q + r.boost)}</td>${res ? `<td class="n">${r.act != null ? f1(r.act) : '<span class="dim">' + esc(r.dnp ? "DNP" : "—") + "</span>"}</td>` : ""}<td class="why">${esc((r.why || "").split(";").join(" · "))}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="empty">${info.us_date < "2026-10-29" ? "The upside flag started on D13 (29 Oct). Earlier slates have none." : "No player with a boost of " + META.upside_boost + "+ on this slate."}</p>`}</section>`;

    const liveNote = !L ? "" : L.state === "missed" ? `<p class="note warn-t">Live slate missed: no run before first tip, so no frozen projection.</p>`
      : `<p class="note ${live ? "live-t" : ""}">${live ? `<strong>LIVE.</strong> Re-run after every injuries or props run and every override save. Last update ${mt(L.updated)} Malta (run ${L.runs}). Freezes at first tip, ${mt(lockAt)} Malta.`
        : `<strong>Frozen at first tip</strong> (${mt(lockAt)} Malta). Last update before lock: ${mt(L.frozen || L.updated)} Malta.`} Props lines for this date: ${L.n_props ?? "—"}.</p>`
      + (L.error ? `<p class="note warn-t">Last refresh failed, previous projection kept: ${esc(L.error)}</p>` : "")
      + (L.own_failed ? `<p class="note warn-t">Own projection failed on the last run: Ours fell back to the old method (base2).</p>` : "")
      + (L.warn || []).map(w => `<p class="note warn-t">${esc(w)}</p>`).join("");
    const capSec = info.fmt === "captain" ? `<section><div class="sec-head"><div><h2>Best lineups by mean (captain format)</h2>
        <p class="sub">Exact best 6-player lineups by Ours: Captain scores and costs ×1.5, Vice ×1.2. Mean only: no spread, no field, so not a cash or top-1% pick. Max 5 per team.</p></div></div>
        ${d.cap && d.cap.length ? `<div class="tbl-wrap"><table><thead><tr><th class="n">#</th><th>Captain</th><th>Vice</th><th>Other four</th><th class="n">Cost</th><th class="n">Mean FP</th></tr></thead><tbody>
        ${d.cap.map(c => `<tr><td class="n">${c.rank}</td><td class="pl">${esc(c.C)}</td><td>${esc(c.VC)}</td><td class="why">${esc(c.rest.join(" · "))}</td><td class="n">${f1(c.cost)}</td><td class="n">${f1(c.fp)}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="empty">No captain lineups saved for this slate.</p>`}</section>` : "";
    const ent = d.entries.length ? `<section><div class="sec-head"><div><h2>Suggested entries</h2>
        <p class="sub">What the pipeline suggested before lock. Not always what was entered: the ledger (Tracker, later) holds what was played.</p></div></div>
        <div class="entries">${d.entries.map(e => `<div class="entry"><h3>${esc(e.e)}<small>${f1(e.price)}M · proj ${f1(e.q)}${e.act != null ? " · actual " + f2(e.act) : ""}</small></h3>
          <ul>${e.players.map(n => { const r = d.rows.find(x => x.name === n) || { name: n }; return `<li><span class="nm">${plink(r)}</span><span class="dim">${esc(r.pos || "")}</span><span class="n">${f1(r.q)}</span>${res ? `<span class="n">${r.act != null ? f1(r.act) : '<span class="dim">' + esc(r.dnp ? "DNP" : "—") + "</span>"}</span>` : ""}</li>`; }).join("")}</ul></div>`).join("")}</div></section>` : "";

    const teams = [...new Set(d.rows.map(r => r.team))].sort();
    const cols = [["name", "Player", 0], ["you", "You", 0], ["pick", "Pick", 0], ["team", "Team", 0], ["pos", "Role", 0], ["price", "Price", 1], ["sa", "Season (GP)", 1], ["l5", "Last 5", 1], ["base", "Base", 1], ["form", "Form (G)", 1], ["props", "Props FP", 1], ["q", "Ours", 1], ["used", "Used", 1], ["fpm", "Used/M", 1], ["flags", "Flags", 0]]
      .concat(res ? [["act", "Actual", 1], ["gap", "Gap", 1]] : []);
    app.querySelector("main").innerHTML = `
      <section><div class="sec-head"><div><h1>${esc(info.label)} slate</h1>
        <p class="sub">${live ? "Live projection, not frozen yet." : "Frozen before first tip."} ${res ? "Box scores are in: Actual and Gap shown. Overrides are closed for finished slates." : locked ? "Past first tip: overrides closed." : (live ? "Tap ✎ on a player to override. A saved override re-runs the projection (about 2-3 minutes, then reload)." : "Tap ✎ on a player to override. Saved overrides apply when the projection is re-run.") + (GH.token() ? "" : ' Saving needs the write-back token on this device: <a href="#settings">Settings</a>.')}</p></div>${picker}</div>
        ${liveNote}
        <dl class="facts">${facts}</dl>
        ${/assum|not seen/i.test(info.note) ? '<p class="note warn-t">Some contest settings were assumed before lock (budget, field, buy-in or paid places). The note below says which. The ledger holds the real figures.</p>' : ""}
        ${info.news_out.length || info.news_in.length ? `<p class="note">News applied by hand: ${info.news_out.length ? "out " + esc(info.news_out.join(", ")) : ""}${info.news_out.length && info.news_in.length ? "; " : ""}${info.news_in.length ? "in " + esc(info.news_in.join(", ")) : ""}.</p>` : ""}
        <details class="raw"><summary>Pre-slate note (as frozen)</summary><p>${esc(info.note)}</p></details></section>
      <section><div class="sec-head"><div><h2>Top 5 by role</h2>
          <p class="sub">Usable players on this slate, by Used FP (your override, else Ours). * = worked out on this page from an override not yet re-run.</p></div>
          <div class="toggles">${seg(S, "metric", [["fp", "Used FP"], ["fpm", "FP per M"]])}</div></div>
        <div class="top5" id="s-top5"></div></section>
      <section><div class="sec-head"><div><h2>Player roster</h2><p class="sub">Base = consensus, or history where there is no consensus line. Form = our recent average (games). Ours = model projection, including the safety net for doubtful players. Used = your override, else Ours: this is what the simulator uses. Used/M = Used per million. Season (GP) = FanTeam points per game played this season (games in brackets); Last 5 = average of his last 5 games; both from today's box scores${res ? ", so they include games after this slate" : ""}. Pick: ☆ shortlist, L lock (in every lineup), X exclude (in none): the same lists as the Optimiser, and the Simulator fills its lock / ban boxes from them.${res ? " Gap = actual minus Ours." : ""}</p></div><span class="count" id="s-cnt"></span></div>
        <form class="filters" onsubmit="return false">
          <label class="grow">Search<input type="search" id="s-q" placeholder="Player name" value="${esc(S.q)}"></label>
          <label>Team<select id="s-team"><option value="">All</option>${teams.map(x => `<option${x === S.team ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
          <label>Role<select id="s-role"><option value="">All</option>${ROLES.map(x => `<option${x === S.role ? " selected" : ""}>${x}</option>`).join("")}</select></label>
          <label>Price (M)<span class="pair"><input type="number" id="s-pmin" step="0.5" min="0" value="${esc(S.pmin)}" aria-label="Price from"> to <input type="number" id="s-pmax" step="0.5" min="0" value="${esc(S.pmax)}" aria-label="Price to"></span></label>
          <label class="chk"><input type="checkbox" id="s-all"${S.all ? " checked" : ""}> Show excluded (out, not eligible)</label>
        </form>
        ${O.err ? `<p class="note warn-t">Could not read saved overrides from the repo: ${esc(O.err)}</p>` : ""}
        <div id="s-bar" class="savebar" hidden></div><div id="s-shbar" class="savebar" hidden></div>
        <div class="tbl-wrap"><table><thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}"${n ? ' class="n"' : ""}>${k === "flags" || k === "you" || k === "pick" ? l : `<button type="button">${l}</button>`}</th>`).join("")}</tr></thead><tbody id="s-tb"></tbody></table></div></section>
      ${upside}${capSec}${ent}${acc}`;

    const U = r => usedFP(r, ovOf(r));
    const val = (r, k) => k === "used" ? U(r).v : k === "fpm" ? (U(r).v != null && r.price ? U(r).v / r.price : null) : k === "gap" ? (r.act != null && r.q != null && !r.out ? r.act - r.q : null) : r[k];
    const usedCell = r => { const u = U(r); return u.out ? `<span class="dim">${u.est ? "out*" : "—"}</span>` : `<span class="${u.est ? "est" : ""}" title="${u.est ? "Worked out on this page from your override. Exact after the re-run." : ""}">${f1(u.v)}${u.est ? "*" : ""}</span>`; };
    function top5() {
      const el = document.getElementById("s-top5"); if (!el) return;
      const ok = d.rows.map(r => ({ r, u: U(r) })).filter(x => !x.u.out && x.u.v != null);
      const v = x => S.metric === "fp" ? x.u.v : (x.r.price ? x.u.v / x.r.price : null);
      el.innerHTML = ROLES.map(role => {
        const top = ok.filter(x => x.r.pos === role && v(x) != null).sort((a, b) => v(b) - v(a)).slice(0, 5);
        const li = top.map((x, i) => `<li><a href="${x.r.id ? "#player-" + esc(x.r.id) : "#slate-" + esc(info.label.toLowerCase())}"><span class="rk">${i + 1}</span>
          <span class="nm">${esc(x.r.name)}<small>${esc(x.r.team)} · ${f1(x.r.price)}M${ovOf(x.r) ? " · yours" : ""}${(x.r.boost || 0) >= META.upside_boost ? " · upside +" + f1(x.r.boost) : ""}</small></span>
          <span class="v">${S.metric === "fp" ? f1(v(x)) + (x.u.est ? "*" : "") : f2(v(x))}</span></a></li>`).join("");
        return `<div class="col"><h3>${role}<small>${S.metric === "fp" ? "Used FP" : "Used per M"}</small></h3><ol>${li || '<li class="empty">Nobody usable.</li>'}</ol></div>`;
      }).join("");
    }
    function editor(r) {
      const o = ovOf(r) || {};
      const st = o.status ?? o.st ?? "", fp = o.fp ?? "";
      return `<tr class="ed"><td colspan="${cols.length}"><div class="editor" data-n="${esc(r.name)}">
        <p class="sub"><strong>${esc(r.name)}</strong> · model if he plays ${f1(r.pm ?? r.pick)} · plays ${r.pp != null ? Math.round(r.pp * 100) + "%" : "—"}${r.out ? " · now excluded" : ""}</p>
        <label>Plays?<select data-f="status"><option value=""${st === "" ? " selected" : ""}>Model decides</option><option value="out"${st === "out" ? " selected" : ""}>Out</option><option value="in"${st === "in" ? " selected" : ""}>In (plays)</option></select></label>
        <label>FP if he plays<input type="number" inputmode="decimal" step="0.5" min="0" max="150" data-f="fp" value="${esc(fp)}" placeholder="${f1(r.pm ?? r.pick)}"></label>
        <label class="grow">Reason<input type="text" maxlength="200" data-f="reason" value="${esc(o.reason || o.why || "")}" placeholder="e.g. starts for Brown (ESPN 20:10Z)"></label>
        <div class="btns"><button type="button" class="primary" data-a="apply">Apply</button>${ovOf(r) ? '<button type="button" data-a="clear">Remove override</button>' : ""}<button type="button" data-a="cancel">Cancel</button></div>
        <p class="note ed-msg" role="status"></p></div></td></tr>`;
    }
    function bindEditor() {
      app.querySelectorAll(".ed-b").forEach(b => b.addEventListener("click", () => { S.open = S.open === b.dataset.n ? null : b.dataset.n; rows(); }));
      const ed = app.querySelector(".editor"); if (!ed) return;
      const n = ed.dataset.n, get = f => ed.querySelector(`[data-f="${f}"]`).value.trim(), say = t => { ed.querySelector(".ed-msg").textContent = t; };
      ed.querySelectorAll("button[data-a]").forEach(b => b.addEventListener("click", () => {
        const a = b.dataset.a;
        if (a === "cancel") { S.open = null; rows(); return; }
        if (a === "clear") { if (O.rows && O.rows[n]) O.pend.set(n, null); else O.pend.delete(n); S.open = null; rows(); return; }
        const status = get("status"), fpS = get("fp"), reason = get("reason");
        const fp = fpS === "" ? "" : Number(fpS);
        if (status === "" && fp === "") { say("Set Out/In or a number, or press Remove."); return; }
        if (fp !== "" && (!isFinite(fp) || fp < 0 || fp > 150)) { say("FP must be a number from 0 to 150."); return; }
        if (status === "out" && fp !== "") { say("Out means he scores nothing here; leave FP blank."); return; }
        if (!reason) { say("Add a reason: every override is scored after the round."); return; }
        O.pend.set(n, { player: n, status, fp: fp === "" ? "" : fp, reason });
        S.open = null; rows();
      }));
    }
    function saveBar() {
      const bar = document.getElementById("s-bar"); if (!bar) return;
      if (!O.pend.size) { bar.hidden = true; bar.innerHTML = ""; return; }
      bar.hidden = false;
      bar.innerHTML = `<span><strong>${O.pend.size}</strong> change${O.pend.size === 1 ? "" : "s"} not saved</span><button type="button" class="primary" id="s-save">Save to repo</button><button type="button" id="s-undo">Discard</button><span class="note" id="s-msg" role="status"></span>`;
      document.getElementById("s-undo").addEventListener("click", () => { O.pend.clear(); rows(); });
      document.getElementById("s-save").addEventListener("click", async e => {
        const btn = e.target, m = document.getElementById("s-msg");
        if (!GH.token()) { m.innerHTML = '<span class="down">Not saved:</span> no write-back token on this device. Add it on <a href="#settings">Settings</a> (your edits stay on this page until you leave it).'; return; }
        if (lockAt && Date.now() >= Date.parse(lockAt)) { m.innerHTML = '<span class="down">Not saved:</span> first tip has passed.'; return; }
        btn.disabled = true; m.textContent = "Saving…";
        const merged = Object.assign({}, O.rows || {}), t = nowIso();
        O.pend.forEach((v, k) => { if (v === null) delete merged[k]; else merged[k] = Object.assign({}, v, { saved_utc: t }); });
        const list = Object.values(merged).sort((a, b) => a.player.localeCompare(b.player));
        try {
          O.sha = await GH.put(ovPath(info.id), toCSV(OV_COLS, list), `insite: ${info.label} overrides (${list.length} players)`, O.sha);
          O.rows = merged; O.pend.clear(); rows();
          const m2 = document.getElementById("s-bar"); m2.hidden = false;
          m2.innerHTML = `<span class="up">Saved ${esc(t.slice(11, 16))}Z.</span> <span>${list.length} override${list.length === 1 ? "" : "s"} in the repo. They change Ours when the projection is re-run (pre-slate chat now; Run button in 5.5).</span>`;
        } catch (err) { btn.disabled = false; m.innerHTML = `<span class="down">Not saved:</span> ${esc(err.message)}`; }
      });
    }
    function bindPicks() {
      app.querySelectorAll("#s-tb .star-b").forEach(b => b.addEventListener("click", () => { const s = new Set(store.get(slShortKey(info), [])), n = b.dataset.n; s.has(n) ? s.delete(n) : s.add(n); store.set(slShortKey(info), [...s]); rows(); }));
      app.querySelectorAll("#s-tb .lk").forEach(b => b.addEventListener("click", () => { togglePick(info, b.dataset.n, b.dataset.a); rows(); }));
    }
    function shortBar() {     // shortlist + lock / exclude summary under the filters; save the shortlist to the repo from here
      const bar = document.getElementById("s-shbar"); if (!bar) return;
      const sh = SH[info.id], P_ = getPicks(info), cur = new Set(store.get(slShortKey(info), []));
      const repo = sh && sh.names, unsaved = repo ? !sameSet(cur, repo) : false;
      if (!cur.size && !P_.locks.length && !P_.bans.length) { bar.hidden = true; bar.innerHTML = ""; return; }
      bar.hidden = false;
      bar.innerHTML = `<span>Shortlist ${cur.size} · locked ${P_.locks.length} · excluded ${P_.bans.length}${P_.locks.length ? ' <span class="dim">· L: ' + esc(P_.locks.join(", ")) + "</span>" : ""}${P_.bans.length ? ' <span class="dim">· X: ' + esc(P_.bans.join(", ")) + "</span>" : ""}</span>`
        + (unsaved || (!GH.token() && cur.size) ? '<button type="button" class="primary" id="s-shsave">Save shortlist to repo</button>' : "")
        + (unsaved ? '<button type="button" id="s-shundo">Undo shortlist changes</button>' : "")
        + (P_.locks.length || P_.bans.length ? '<button type="button" id="s-pkclr">Clear locks and excludes</button>' : "")
        + `<span class="note" id="s-shmsg" role="status">${!GH.token() ? 'Shortlist: this device only · <a href="#settings">add the token</a> to save it for the Simulator.' : sh && sh.err ? "Shortlist: repo read failed (" + esc(sh.err) + ")." : unsaved ? "" : cur.size ? "Shortlist saved in repo." : ""} Locks / excludes: this device (Optimiser; Simulator fills them in).</span>`;
      const sv = document.getElementById("s-shsave");
      if (sv) sv.addEventListener("click", async () => { const m = document.getElementById("s-shmsg"); sv.disabled = true; m.textContent = "Saving…";
        try { await slShortSave(info); rows(); } catch (e) { sv.disabled = false; m.innerHTML = `<span class="down">Not saved:</span> ${esc(e.message)}${GH.token() ? "" : ' <a href="#settings">Settings</a>'}`; } });
      const un = document.getElementById("s-shundo"); if (un) un.addEventListener("click", () => { store.set(slShortKey(info), [...sh.names]); rows(); });
      const cl = document.getElementById("s-pkclr"); if (cl) cl.addEventListener("click", () => { const c = store.get(pickKey(info), {}); c.locks = []; c.bans = []; store.set(pickKey(info), c); rows(); });
    }
    function rows() {
      const q = S.q.trim().toLowerCase();
      const pn = v => v === "" || v == null ? null : Number(v), pmin = pn(S.pmin), pmax = pn(S.pmax);
      const list = d.rows.filter(r => (S.all || !U(r).out) && (!q || r.name.toLowerCase().includes(q)) && (!S.team || r.team === S.team) && (!S.role || r.pos === S.role)
          && (pmin == null || r.price >= pmin) && (pmax == null || r.price <= pmax))
        .sort((x, y) => { const u = val(x, S.sort), v = val(y, S.sort); if (u == null && v == null) return 0; if (u == null) return 1; if (v == null) return -1; return (typeof u === "string" ? u.localeCompare(v) : u - v) * S.dir; });
      const P_ = getPicks(info), SL = new Set(store.get(slShortKey(info), []));
      const pickCell = r => { const st = SL.has(r.name), lk = P_.locks.includes(r.name), bn = P_.bans.includes(r.name);
        return `<td class="lo pk"><button type="button" class="star-b" data-n="${esc(r.name)}" aria-pressed="${st}" aria-label="Shortlist ${esc(r.name)}">${st ? "★" : "☆"}</button><button type="button" class="lk" data-n="${esc(r.name)}" data-a="lock" aria-pressed="${lk}" title="Lock: in every lineup" aria-label="Lock ${esc(r.name)}">L</button><button type="button" class="lk" data-n="${esc(r.name)}" data-a="ban" aria-pressed="${bn}" title="Exclude: in no lineup" aria-label="Exclude ${esc(r.name)}">X</button></td>`; };
      document.getElementById("s-tb").innerHTML = list.map(r => `<tr class="${U(r).out || P_.bans.includes(r.name) ? "off" : ""}"><td class="pl">${plink(r)}</td><td class="you">${(() => { const o = ovOf(r), t = ovText(o); return (t ? `<span class="chip yours${O.pend.has(r.name) ? " pend" : ""}" title="${esc(o.reason || o.why || "")}">${esc(t)}</span>` : (O.pend.has(r.name) ? '<span class="chip pend">removed</span>' : "")) + (canEdit ? ` <button type="button" class="ed-b" data-n="${esc(r.name)}" aria-label="Override ${esc(r.name)}">✎</button>` : ""); })()}</td>${pickCell(r)}<td>${esc(r.team)}</td><td><span class="pos">${esc(r.pos)}</span></td>
        <td class="n">${f1(r.price)}</td><td class="n">${r.sa != null ? f1(r.sa) + ' <span class="dim">(' + r.sg + ")</span>" : '<span class="dim">—</span>'}</td><td class="n">${r.l5 != null ? f1(r.l5) : '<span class="dim">—</span>'}</td><td class="n">${f1(r.base)}</td><td class="n">${r.form != null ? f1(r.form) + ' <span class="dim">(' + (r.fg ?? 0) + ")</span>" : '<span class="dim">—</span>'}</td>
        <td class="n">${r.props != null ? f1(r.props) : '<span class="dim">—</span>'}</td><td class="n">${r.out ? '<span class="dim">' + f1(r.q) + "</span>" : f1(r.q)}</td>
        <td class="n strong">${usedCell(r)}</td><td class="n">${f2(val(r, "fpm"))}</td><td>${slateFlags(r)}</td>
        ${res ? `<td class="n">${r.act != null ? f2(r.act) + ' <span class="dim">' + r.amin + "m</span>" : '<span class="dim">' + esc(r.dnp ? (r.dnp === "COACH'S DECISION" ? "DNP coach" : "DNP") : "no game") + "</span>"}</td><td class="n">${sgn(val(r, "gap"))}</td>` : ""}</tr>`
        + (canEdit && S.open === r.name ? editor(r) : "")).join("");
      bindEditor();
      bindPicks();
      saveBar();
      shortBar();
      top5();
      document.getElementById("s-cnt").textContent = `showing ${list.length} of ${d.rows.length}`;
      app.querySelectorAll("thead th[data-k]").forEach(th => { if (th.dataset.k === S.sort) th.setAttribute("aria-sort", S.dir < 0 ? "descending" : "ascending"); else th.removeAttribute("aria-sort"); });
    }
    document.getElementById("s-pick").addEventListener("change", e => { location.hash = "slate-" + e.target.value.toLowerCase(); });
    const bind = (id, key, ev) => document.getElementById(id).addEventListener(ev || "input", e => { S[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value; saveS(); rows(); });
    bind("s-q", "q"); bind("s-team", "team", "change"); bind("s-role", "role", "change"); bind("s-all", "all", "change"); bind("s-pmin", "pmin"); bind("s-pmax", "pmax");
    app.querySelectorAll(".toggles .seg button[data-metric]").forEach(b => b.addEventListener("click", () => {
      S.metric = b.dataset.metric; saveS();
      app.querySelectorAll(".toggles .seg button[data-metric]").forEach(x => x.setAttribute("aria-pressed", x.dataset.metric === S.metric));
      top5();
    }));
    app.querySelectorAll("thead th button").forEach(b => b.addEventListener("click", () => {
      const k = b.parentElement.dataset.k;
      if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = ["name", "team", "pos"].includes(k) ? 1 : -1; }
      saveS(); rows();
    }));
    rows();
    window.scrollTo(0, 0);
  }

  /* ---------- Injuries (Build B) ----------
     ESPN report only (Ryan 1 Nov): Out / Day-To-Day, no Q/D status invented. 'Gains' = model/onoff.py upside flag. */
  const IJ = Object.assign({ scope: "slate", team: "", st: "" }, store.get("inj", {}));
  const saveIJ = () => store.set("inj", { scope: IJ.scope, st: IJ.st });
  const ago = iso => { if (!iso) return ""; const h = (Date.now() - Date.parse(iso)) / 36e5; return h < 1 ? Math.max(0, Math.round(h * 60)) + " min ago" : h < 48 ? Math.round(h) + " h ago" : Math.round(h / 24) + " days ago"; };
  async function renderInjuries() {
    app.innerHTML = shell("injuries", "Injuries") + `<main class="wrap"><p class="loading">Loading injuries…</p></main>`;
    let J;
    try { J = await loadInjuries(); await loadSlates(); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load the injury report (${esc(e.message)}). Reload to try again.</p>`; return; }
    if (location.hash !== "#injuries") return;
    // current slate = an open live slate; its teams are the default scope
    const lv = SLATES.find(isLive);
    let slTeams = null;
    if (lv) { try { const d = await loadSlate(lv.id); slTeams = new Set(d.rows.map(r => r.team)); } catch (e) { slTeams = null; } }
    if (!slTeams && IJ.scope === "slate") IJ.scope = "all";
    const stale = J.pulled && (Date.now() - Date.parse(J.pulled)) > 6 * 36e5;
    const teams = [...new Set(J.rows.map(r => r.team))].sort();
    const facts = [["Last ESPN pull", J.pulled ? mt(J.pulled) + " Malta · " + ago(J.pulled) : "—"], ["Newest ESPN note", J.espn_newest ? mt(J.espn_newest) + " Malta" : "—"],
                   ["Out", J.n_out], ["Day-To-Day", J.n_dtd]].concat(lv ? [["Live slate", lv.label + " · first tip " + mt((lv.live && lv.live.lock) || lv.lock_utc)]] : [])
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    app.querySelector("main").innerHTML = `
      <section><div class="sec-head"><div><h1>Injuries</h1>
        <p class="sub">ESPN injury report, pulled by the injuries Action (08, 14, 17, 20, 23 UTC, and by hand). ESPN gives only Out and Day-To-Day; doubtful or questionable is only in the note text. Return dates are ESPN placeholders, often loose.</p></div></div>
        <dl class="facts">${facts}</dl>
        ${stale ? `<p class="note warn-t">Last pull is over 6 hours old. GitHub runs scheduled jobs late at times: run the injuries Action by hand before a deadline.</p>` : ""}
        <form class="filters" onsubmit="return false">
          ${slTeams ? `<div class="seg" role="group" aria-label="Teams">${[["slate", lv.label + " teams"], ["all", "All teams"]].map(([v, l]) => `<button type="button" data-scope="${v}" aria-pressed="${IJ.scope === v}">${esc(l)}</button>`).join("")}</div>` : `<p class="note">No live slate open: showing all teams.</p>`}
          <label>Team<select id="i-team"><option value="">All</option>${teams.map(t => `<option${t === IJ.team ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
          <div class="seg" role="group" aria-label="Status">${[["", "Both"], ["Out", "Out"], ["Day-To-Day", "Day-To-Day"]].map(([v, l]) => `<button type="button" data-st="${v}" aria-pressed="${IJ.st === v}">${l}</button>`).join("")}</div>
        </form></section>
      <section><div class="sec-head"><div><h2>Who gains (upside flag)</h2>
        <p class="sub">Teammates of Out players. Boost = his average FP change in past games without them (2024-27 box scores, small samples pulled toward 0), summed over all his Out teammates, capped at ${f1(J.cap)}. Shown from ${f1(J.boost_min)}+. A flag, not a forecast: boost 6+ beat our projection by 10+ FP in 26% of games v 12% normally, but on average it does not add to the projection.</p></div><span class="count" id="i-ucnt"></span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Player</th><th class="n">Boost</th><th>Team</th><th>Role</th><th class="n">S1 price</th><th class="n">Proj</th><th>Because out</th></tr></thead><tbody id="i-up"></tbody></table></div></section>
      <section><div class="sec-head"><div><h2>Changes, last 48 hours</h2><p class="sub">From each ESPN pull: new on the report, off the report, status or return date changed. Note-only edits left out.</p></div><span class="count" id="i-ccnt"></span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Seen (Malta)</th><th>Player</th><th>Team</th><th>Change</th></tr></thead><tbody id="i-chg"></tbody></table></div></section>
      <section><div class="sec-head"><div><h2>Out or Day-To-Day</h2><p class="sub">Gains = his teammates with the biggest boost when he is out (top 3, 2+ FP). Tap the injury for ESPN's note.</p></div><span class="count" id="i-cnt"></span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Status</th><th>Return</th><th>Injury / note</th><th class="n">S1 price</th><th class="n">Proj</th><th>Gains</th><th>ESPN</th></tr></thead><tbody id="i-tb"></tbody></table></div></section>`;
    const lnk = (n, id) => id ? `<a href="#player-${esc(id)}">${esc(n)}</a>` : esc(n);
    function draw() {
      const keep = t => (IJ.scope !== "slate" || !slTeams || slTeams.has(t)) && (!IJ.team || t === IJ.team);
      const rows = J.rows.filter(r => keep(r.team) && (!IJ.st || r.st === IJ.st))
        .sort((a, b) => a.team.localeCompare(b.team) || (a.st === "Out" ? 0 : 1) - (b.st === "Out" ? 0 : 1) || (b.price || 0) - (a.price || 0));
      document.getElementById("i-tb").innerHTML = rows.map(r => {
        const g = (J.by_out[r.team + "|" + r.name] || []).filter(x => x.b >= 2).slice(0, 3);
        return `<tr><td class="pl">${lnk(r.name, r.id)}</td><td>${esc(r.team)}</td>
          <td><span class="chip ${r.st === "Out" ? "out" : "dtd"}">${esc(r.st)}</span></td><td>${esc(dshort(r.ret))}</td>
          <td class="why">${r.note ? `<details><summary>${esc(r.injury || "note")}</summary>${esc(r.note)}</details>` : esc(r.injury || "")}</td>
          <td class="n">${f1(r.price)}</td><td class="n">${f1(r.proj)}</td>
          <td class="why">${r.st === "Out" ? (g.map(x => `${lnk(x.name, x.id)} <span class="up">+${f1(x.b)}</span>`).join(" · ") || '<span class="dim">—</span>') : '<span class="dim">Out only</span>'}</td>
          <td class="dim">${esc(r.upd ? dshort(r.upd) : "—")}</td></tr>`;
      }).join("") || `<tr><td colspan="9" class="dim">Nobody on the report for this choice.</td></tr>`;
      document.getElementById("i-cnt").textContent = `${rows.length} shown`;
      const ch = J.changes.filter(c => keep(c.team));
      const txt = c => c.what === "new" ? `new: <span class="chip ${c.new === "Out" ? "out" : "dtd"}">${esc(c.new)}</span>`
        : c.what === "back" ? `off the report (was ${esc(c.old || "listed")})`
        : c.what === "status" ? `${esc(c.old || "—")} → <span class="chip ${c.new === "Out" ? "out" : "dtd"}">${esc(c.new)}</span>`
        : `return date now ${esc(dshort(c.ret))}`;
      document.getElementById("i-chg").innerHTML = ch.map(c => `<tr><td>${esc(mt(c.seen))}</td><td class="pl">${lnk(c.name, c.id)}</td><td>${esc(c.team)}</td><td>${txt(c)}</td></tr>`).join("")
        || `<tr><td colspan="4" class="dim">No changes for this choice.</td></tr>`;
      document.getElementById("i-ccnt").textContent = `${ch.length} change${ch.length === 1 ? "" : "s"}`;
      const up = J.upside.filter(u => keep(u.team));
      document.getElementById("i-up").innerHTML = up.map(u => `<tr><td class="pl">${lnk(u.name, u.id)}</td><td class="n up">+${f1(u.boost)}</td><td>${esc(u.team)}</td><td>${u.pos ? `<span class="pos">${esc(u.pos)}</span>` : '<span class="dim">—</span>'}</td>
          <td class="n">${f1(u.price)}</td><td class="n">${f1(u.proj)}</td><td class="why">${esc(u.why.map(w => w.out + " " + (w.b >= 0 ? "+" : "") + f1(w.b)).join(" · "))}</td></tr>`).join("")
        || `<tr><td colspan="7" class="dim">No teammate with a boost of ${f1(J.boost_min)}+ for this choice.</td></tr>`;
      document.getElementById("i-ucnt").textContent = `${up.length} player${up.length === 1 ? "" : "s"}`;
    }
    app.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
      const [k, v] = Object.entries(b.dataset)[0]; IJ[k] = v; saveIJ();
      app.querySelectorAll(`.seg button[data-${k}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[k] === v));
      draw();
    }));
    document.getElementById("i-team").addEventListener("change", e => { IJ.team = e.target.value; draw(); });
    draw();
    window.scrollTo(0, 0);
  }

  /* ---------- Matrix ---------- */
  const M = Object.assign({ mode: "s1", slate: "", role: "All", y: "outlook", view: "all", shown: [] }, store.get("matrix", {}), { shown: [] });
  const saveM = () => store.set("matrix", { mode: M.mode, slate: M.slate, role: M.role, y: M.y, view: M.view });
  const ENDS = 20;     // P6d 'Top 20 + worst 20 value' view
  const shortKey = () => "short." + (M.mode === "s1" ? "s1" : M.slate);
  const getShort = () => new Set(store.get(shortKey(), []));
  const setShort = s => store.set(shortKey(), [...s]);
  const SH = {};   // repo shortlist per key ('s1' or slate folder): {names: Set, sha, err}
  const repoKey = () => M.mode === "s1" ? "s1" : (byLabel(M.slate) || {}).id;
  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  // shortlist: rk = repo key ('s1' or slate folder), lk = this device's key. First load per page merges the repo file in.
  async function shortLoad(rk, lk) {
    if (GH.token() && rk && !SH[rk]) {
      try {
        const f = await GH.get(shPath(rk));
        SH[rk] = { names: new Set(f.text ? fromCSV(f.text).map(r => r.player).filter(Boolean) : []), sha: f.sha, err: null };
        store.set(lk, [...new Set([...store.get(lk, []), ...SH[rk].names])]);   // keep local stars too
      } catch (e) { SH[rk] = { names: null, sha: null, err: e.message }; }
    }
    return new Set(store.get(lk, []));
  }

  function fit(pts) {   // least squares FP = a + b x price
    const n = pts.length, mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    pts.forEach(p => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; });
    const b = sxx ? sxy / sxx : 0;
    return { a: my - b * mx, b, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0 };
  }
  const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const nice = (lo, hi, n) => { const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw); const out = []; for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) out.push(+v.toFixed(6)); return out; };

  async function renderMatrix() {
    await loadSlates();
    if (!M.slate || !byLabel(M.slate)) M.slate = SLATES.length ? SLATES[0].label : "";
    const lv = SLATES.find(isLive);   // Build A: an open live slate beats a remembered finished one (once per page load)
    if (lv && !M.liveSeen && !isLive(byLabel(M.slate) || {})) { M.slate = lv.label; }
    M.liveSeen = true;
    if (M.mode === "daily" && !SLATES.length) M.mode = "s1";
    let pts, yLab, sub, extra = "";
    if (M.mode === "s1") {
      const yk = M.y === "outlook" ? "outlook" : "proj";
      // no projection = outlook is pure safety-net value (gw_value no_proj): leave those players out
      pts = PLAYERS.filter(p => p.avail && p.proj != null && p[yk] != null && p.price).map(p => ({ id: p.id, name: p.name, team: p.team, pos: p.pos, x: p.price, y: p[yk] }));
      yLab = M.y === "outlook" ? "GW1-10 outlook (expected FP)" : "Projected FP per game";
      sub = `Season game (S1) pool at S1 prices (${dshort(META.pool_date)}). Projection = consensus. Out players and players with no projection hidden. Squads are picked on the GW1-10 outlook.`;
      extra = seg(M, "y", [["outlook", "GW1-10 outlook"], ["fp", "FP per game"]]);
    } else {
      const info = byLabel(M.slate);
      const d = await loadSlate(info.id);
      const O = await ovrLoad(info);   // Build C: y = Used FP (override else Ours), same as the Slate page
      pts = d.rows.map(r => ({ r, u: usedFP(r, ovIn(O, r)), o: ovIn(O, r) })).filter(z => !z.u.out && z.u.v != null && z.r.price)
        .map(({ r, u, o }) => ({ id: r.id, name: r.name, team: r.team, pos: r.pos, x: r.price, y: u.v, est: u.est, yours: !!o, act: r.act }));
      yLab = "Used FP (your override, else Ours)";
      sub = `${info.label} daily pool at that contest's prices${isLive(info) ? " (live slate)" : ""}. Usable players only. FP = your override where you set one, else Ours; * = override not re-run yet. Daily prices differ from S1 prices.`;
      extra = `<label class="pick">Slate<select id="m-slate">${SLATES.map(s => `<option value="${esc(s.label)}"${s.label === M.slate ? " selected" : ""}>${esc(slateLabel(s))}</option>`).join("")}</select></label>`;
    }
    if (M.role !== "All") pts = pts.filter(p => p.pos === M.role);
    const rk = repoKey();
    const short = await shortLoad(rk, shortKey());
    const repo = rk && SH[rk] && SH[rk].names;
    const unsaved = repo ? !sameSet(short, repo) : false;
    const shNote = !GH.token() ? `this device · <a href="#settings">add token</a> to save` : SH[rk] && SH[rk].err ? "repo read failed" : unsaved ? "not saved" : "saved in repo";
    app.innerHTML = shell("matrix", "Matrix") + `<main class="wrap">
      <section><div class="sec-head"><div><h1>Price v projection</h1><p class="sub">${sub} High FP at a low price sits top right. Tap a dot to show the name; tap again to hide.</p></div></div>
        <div class="toggles">${seg(M, "mode", [["s1", "Season game"], ["daily", "Daily slate"]])}${extra}${seg(M, "role", ["All"].concat(ROLES).map(r => [r, r]))}${seg(M, "view", [["all", "All players"], ["ends", `Top ${ENDS} + worst ${ENDS} value`]])}</div></section>
      <section id="m-body"></section></main>`;

    const body = document.getElementById("m-body");
    if (pts.length < 3) { body.innerHTML = '<p class="empty">Too few players with a projection here to fit a line.</p>'; }
    else {
      const f = fit(pts);
      pts.forEach(p => { p.fair = f.a + f.b * p.x; p.gap = p.y - p.fair; });
      const mp = median(pts.map(p => p.x)), mf = median(pts.map(p => p.y));   // line and medians: always on all players
      const nAll = pts.length, byGap = pts.slice().sort((a, b) => b.gap - a.gap);
      const best = byGap.slice(0, ENDS), worst = byGap.slice(-ENDS).reverse().filter(p => !best.includes(p));
      if (M.view === "ends") pts = best.concat(worst);
      const sm = window.innerWidth < 640, W = sm ? 380 : 720, Ht = sm ? 340 : 440, L = 38, Rr = 10, T = 12, Bt = 40;   // smaller viewBox on phones keeps labels readable
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const xlo = Math.floor(Math.min(...xs)), xhi = Math.ceil(Math.max(...xs)), ylo = 0, yhi = Math.max(...ys) * 1.06;
      const X = v => L + (xhi - v) / (xhi - xlo || 1) * (W - L - Rr);    // high price left, cheap right
      const Y = v => T + (1 - (v - ylo) / (yhi - ylo)) * (Ht - T - Bt);
      const yt = nice(ylo, yhi, 5), xt = nice(xlo, xhi, sm ? 4 : 6).filter(v => v >= xlo && v <= xhi);
      const grid = yt.map(v => `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="${L - 6}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`).join("")
        + xt.map(v => `<text class="axis" x="${X(v).toFixed(1)}" y="${Ht - Bt + 16}" text-anchor="middle">${v}</text>`).join("")
        + `<text class="axis lab" x="${(L + W - Rr) / 2}" y="${Ht - 6}" text-anchor="middle">Price (M), high → low</text>`;
      const quad = `<line class="med" x1="${X(mp).toFixed(1)}" x2="${X(mp).toFixed(1)}" y1="${T}" y2="${Ht - Bt}"/><line class="med" x1="${L}" x2="${W - Rr}" y1="${Y(mf).toFixed(1)}" y2="${Y(mf).toFixed(1)}"/>`;
      const fl = `<line class="fitl" x1="${X(xhi).toFixed(1)}" y1="${Y(f.a + f.b * xhi).toFixed(1)}" x2="${X(xlo).toFixed(1)}" y2="${Y(f.a + f.b * xlo).toFixed(1)}"/>`;
      const dots = pts.slice().sort((a, b) => a.gap - b.gap).map((p, i) => {
        const on = M.shown.includes(p.name), st = short.has(p.name);
        const cx = X(p.x), cy = Y(p.y), right = cx > W * 0.55;
        return `<g class="pt${p.gap >= 0 ? " above" : ""}${st ? " star" : ""}" data-n="${esc(p.name)}" tabindex="0" role="button" aria-label="${esc(p.name)}, ${f1(p.x)}M, ${f1(p.y)} FP">
          <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${st ? 6 : 4.6}"/><circle class="hit" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="11"/>
          ${on ? `<text class="lbl" x="${(cx + (right ? -9 : 9)).toFixed(1)}" y="${(cy - 7).toFixed(1)}" text-anchor="${right ? "end" : "start"}">${esc(p.name)} · ${f1(p.x)}M · ${f1(p.y)}${p.est ? "*" : ""}</text>` : ""}</g>`;
      }).join("");
      const top = M.view === "ends" ? best : pts.filter(p => p.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 12);
      const shortList = pts.filter(p => short.has(p.name)).sort((a, b) => b.gap - a.gap);
      const item = p => `<li><button type="button" class="star-b" data-n="${esc(p.name)}" aria-pressed="${short.has(p.name)}" aria-label="Shortlist ${esc(p.name)}">${short.has(p.name) ? "★" : "☆"}</button>
        <span class="nm">${p.id ? `<a href="#player-${esc(p.id)}">${esc(p.name)}</a>` : esc(p.name)}<small>${esc(p.pos)} · ${esc(p.team)} · ${f1(p.x)}M · ${f1(p.y)}${p.est ? "*" : ""} FP${p.yours ? " · yours" : ""}</small></span><span class="v ${p.gap >= 0 ? "up" : "down"}">${p.gap >= 0 ? "+" : ""}${f1(p.gap)}</span></li>`;
      body.innerHTML = `<div class="mx">
        <figure class="chart mx-chart"><h3>${esc(yLab)}<small>${M.view === "ends" ? `${pts.length} of ${nAll} shown (best and worst ${ENDS} by gap to the line; line fitted on all)` : `${nAll} players`} · r ${f.r.toFixed(2)} · ${f1(f.b)} FP per 1M</small></h3>
          <svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Price against projection, ${pts.length} players">${grid}${quad}${fl}${dots}</svg>
          <p class="legend"><span><span class="k fitk"></span>fair-price line (fit)</span><span><span class="k medk"></span>median price / median FP</span><span><span class="k dk a"></span>above the line</span><span><span class="k dk"></span>below</span><span><span class="k dk s"></span>shortlisted</span></p></figure>
        <div class="mx-side">
          <div class="col"><h3>Best value<small>${M.view === "ends" ? `top ${ENDS} by FP above the line` : "FP above the line"}</small></h3><ol>${top.map(item).join("") || '<li class="empty">Nobody above the line.</li>'}</ol></div>
          ${M.view === "ends" ? `<div class="col"><h3>Worst value<small>${worst.length} furthest below the line</small></h3><ol>${worst.map(item).join("") || '<li class="empty">—</li>'}</ol></div>` : ""}
          <div class="col"><h3>Shortlist<small>${short.size} · ${shNote}</small></h3><ol>${shortList.map(item).join("") || `<li class="empty">${short.size ? "No shortlisted player in this view (role filter)." : "Tap ☆ to shortlist."}</li>`}</ol>
            ${unsaved ? '<div class="savebar in-col"><button type="button" class="primary" id="m-save">Save shortlist to repo</button><button type="button" id="m-undo">Undo changes</button><span class="note" id="m-msg" role="status"></span></div>' : ""}
            ${SH[rk] && SH[rk].err ? `<p class="note warn-t">${esc(SH[rk].err)}</p>` : ""}</div>
        </div></div>
        <p class="note">Price explains most of the projection (r = correlation, 1.00 = price explains it all), so the quadrants alone say little. The gap to the fair-price line is the signal. The line is refitted for the role shown. ${M.mode === "s1" ? "Projection is preseason consensus, not our own model yet." : "Ours includes the safety net for doubtful players; the on/off injury upside is not in it (see the Slate page). Overrides are set on the Slate page (✎). The shortlist feeds the Optimiser ('Shortlist only')."}</p>`;
      body.querySelectorAll("g.pt").forEach(g => { const tog = () => { const n = g.dataset.n, i = M.shown.indexOf(n); if (i >= 0) M.shown.splice(i, 1); else M.shown.push(n); renderMatrix(); };
        g.addEventListener("click", tog); g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tog(); } }); });
      body.querySelectorAll(".star-b").forEach(b => b.addEventListener("click", () => { const s = getShort(), n = b.dataset.n; s.has(n) ? s.delete(n) : s.add(n); setShort(s); renderMatrix(); }));
      const sv = document.getElementById("m-save");
      if (sv) sv.addEventListener("click", async () => {
        const m = document.getElementById("m-msg"); sv.disabled = true; m.textContent = "Saving…";
        const names = [...getShort()].sort(), t = nowIso();
        const label = M.mode === "s1" ? "S1" : M.slate;
        try {
          SH[rk].sha = await GH.put(shPath(rk), toCSV(["player", "saved_utc"], names.map(n => ({ player: n, saved_utc: t }))), `insite: ${label} shortlist (${names.length})`, SH[rk].sha);
          SH[rk].names = new Set(names); renderMatrix();
        } catch (e) { sv.disabled = false; m.innerHTML = `<span class="down">Not saved:</span> ${esc(e.message)}`; }
      });
      const un = document.getElementById("m-undo");
      if (un) un.addEventListener("click", () => { setShort(new Set(SH[rk].names)); renderMatrix(); });
    }
    app.querySelectorAll(".toggles .seg button").forEach(b => b.addEventListener("click", () => { const [k, v] = Object.entries(b.dataset)[0]; M[k] = v; M.shown = []; saveM(); renderMatrix(); }));
    const ms = document.getElementById("m-slate");
    if (ms) ms.addEventListener("change", e => { M.slate = e.target.value; M.shown = []; saveM(); renderMatrix(); });
  }


  /* ---------- Optimiser (Build C, 1 Nov) ----------
     Last season's captain optimiser (optimizer_2025.jsx) on a slate's own pool: 6 players, any role, C x1.5 / VC x1.2
     points and price, max 5 per team (METHOD D4), budget, chosen games, lock / out, top N. FP = Used FP (override else
     Ours, same as Slate and Matrix). Engine = site/opt.js (exact; same answers as model/captain.py). Mean only. */
  const OP = Object.assign({ slate: "", rows: "all", pool: "all", q: "" }, store.get("opt", {}), { q: "" });
  const saveOP = () => store.set("opt", { slate: OP.slate, rows: OP.rows, pool: OP.pool });
  async function renderOpt(lab) {
    await loadSlates();
    if (!SLATES.length) { app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap"><p>No slate yet. A pre-slate chat commits the pool and creates one.</p></main>`; return; }
    // slate: the one in the address, else an open live slate, else the last one used, else the newest
    const info = (lab && byLabel(lab)) || SLATES.find(isLive) || (OP.slate && byLabel(OP.slate)) || SLATES[0];
    if (lab && !byLabel(lab)) { app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap"><p>No slate "${esc(lab)}". <a href="#opt">Current slate</a></p></main>`; return; }
    OP.slate = info.label; saveOP();
    app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap"><p class="loading">Loading ${esc(info.label)}…</p></main>`;
    let d;
    try { d = await loadSlate(info.id); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load this slate (${esc(e.message)}). Reload to try again.</p>`; return; }
    const O = await ovrLoad(info);
    const short = await shortLoad(info.id, "short." + info.label);
    const res = info.results, cap = info.fmt === "captain";
    const games = info.games && info.games.length ? info.games : [];
    const sk = "opt." + info.id;
    const C = Object.assign({ budget: info.budget ?? "", n: cap ? (info.n_players || 6) : 6, cm: 1.5, vm: 1.2, maxTeam: info.max_team || 5, topN: 10, games: games.slice(), locks: [], bans: [] }, store.get(sk, {}));
    C.games = C.games.filter(g => games.includes(g));
    if (!C.games.length) C.games = games.slice();
    const saveC = () => store.set(sk, C);
    // pool on Used FP
    const all = d.rows.map(r => { const o = ovIn(O, r), u = usedFP(r, o); return { r, u, o }; }).filter(z => !z.u.out && z.u.v != null && z.r.price);
    const facts = [["Contest", info.contest || "—"], ["US date", dshort(info.us_date)], ["Format", cap ? "Captain (C ×1.5 · VC ×1.2)" : "Classic pool"],
                   ["Slate budget", info.budget != null ? info.budget + "M" : "—"], ["Usable", `${all.length} of ${d.rows.length}`], ["Shortlist", short.size]]
      .concat(isLive(info) ? [["First tip", mt((info.live && info.live.lock) || info.lock_utc) + " Malta"]] : [])
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    const num = (id, l, v, st, mn, mx) => `<label>${l}<input type="number" inputmode="decimal" id="${id}" value="${esc(v)}" step="${st}" min="${mn}" max="${mx}"></label>`;
    app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap">
      <section><div class="sec-head"><div><h1>Optimiser</h1>
        <p class="sub">Best lineups by mean projection for a captain contest: ${esc(C.n)} players, any role, Captain scores and costs ×${esc(C.cm)}, Vice ×${esc(C.vm)}. Exact: every lineup that could make the list is checked. FP = Used FP (your override, else Ours). Mean only: no spread, no field, so it is not a cash or top-1% pick.</p></div>
        <label class="pick">Slate<select id="o-pick">${SLATES.map(s => `<option value="${esc(s.label)}"${s.id === info.id ? " selected" : ""}>${esc(slateLabel(s))}</option>`).join("")}</select></label></div>
        <dl class="facts">${facts}</dl>
        ${cap ? "" : `<p class="note warn-t">This is a classic slate's pool. Captain contests have their own prices (Ryan, 1 Nov): for a captain contest, send its pool to a pre-slate chat. Classic lineups (7 players, positions) come from the Simulator, not here.</p>`}
        ${O.err ? `<p class="note warn-t">Could not read saved overrides from the repo: ${esc(O.err)}. Using the overrides the last run applied.</p>` : ""}
        ${res ? `<p class="note">Box scores are in: lineups show their actual score (C/VC multipliers applied; a DNP counts 0 here, the safety net is not applied).</p>` : ""}</section>
      <section><div class="sec-head"><div><h2>Settings</h2><p class="sub">Saved on this device for this slate. Lock = must be in every lineup; Out = left out. Same lists as Pick L / X on the Slate page.</p></div></div>
        <form class="filters" onsubmit="return false">
          ${num("o-budget", "Budget (M)", C.budget, 0.5, 0, 200)}${num("o-n", "Players", C.n, 1, 2, 9)}${num("o-cm", "Captain ×", C.cm, 0.1, 1, 3)}${num("o-vm", "Vice ×", C.vm, 0.1, 1, 3)}
          ${num("o-mt", "Max per team", C.maxTeam, 1, 1, 9)}${num("o-top", "Show top", C.topN, 1, 1, 50)}
          <div class="seg" role="group" aria-label="Players">${[["all", "All usable"], ["short", "Shortlist only"]].map(([v, l]) => `<button type="button" data-pool="${v}" aria-pressed="${OP.pool === v}">${l}</button>`).join("")}</div>
          <div class="seg" role="group" aria-label="Rows">${[["all", "Every C/VC"], ["squad", "Best C/VC per squad"]].map(([v, l]) => `<button type="button" data-rows="${v}" aria-pressed="${OP.rows === v}">${l}</button>`).join("")}</div>
        </form>
        ${games.length > 1 ? `<div class="games" role="group" aria-label="Games">${games.map(g => `<label class="chk"><input type="checkbox" data-g="${esc(g)}"${C.games.includes(g) ? " checked" : ""}> ${esc(g)}</label>`).join("")}</div>` : ""}
      </section>
      <section><div class="sec-head"><div><h2>Best lineups</h2><p class="sub" id="o-msg"></p></div></div><div id="o-res"></div></section>
      <section><div class="sec-head"><div><h2>Pool</h2><p class="sub">Players in the chosen games${OP.pool === "short" ? " on your shortlist (Matrix ☆)" : ""}, by Used FP. * = override not re-run yet.</p></div><span class="count" id="o-cnt"></span></div>
        <form class="filters" onsubmit="return false"><label class="grow">Search<input type="search" id="o-q" placeholder="Player name" value=""></label>
          <button type="button" id="o-clear">Clear locks and outs</button></form>
        <div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Role</th><th class="n">Price</th><th class="n">Used FP</th><th class="n">FP/M</th><th>Lock / Out</th>${res ? '<th class="n">Actual</th>' : ""}</tr></thead><tbody id="o-tb"></tbody></table></div></section></main>`;

    const inGames = z => !games.length || C.games.some(g => g.split("@").includes(z.r.team));
    const pool = () => all.filter(z => inGames(z) && (OP.pool !== "short" || short.has(z.r.name)));
    const byName = new Map(d.rows.map(r => [r.name, r]));
    const nm = n => { const z = all.find(x => x.r.name === n); return esc(n) + (z && z.u.est ? "*" : ""); };
    function run() {
      const P = pool();
      const players = P.map(z => ({ name: z.r.name, team: z.r.team, price: z.r.price, fp: z.u.v }));
      const names = new Set(players.map(p => p.name));
      const lockOff = C.locks.filter(n => !names.has(n));
      const t0 = performance.now();
      const R = window.INSITE_OPT.optimise({ players, budget: Number(C.budget), n: Number(C.n), cm: Number(C.cm), vm: Number(C.vm), maxTeam: Number(C.maxTeam),
        topN: Number(C.topN), locks: C.locks.filter(n => names.has(n)), bans: C.bans, perSquad: OP.rows === "squad" });
      const ms = Math.round(performance.now() - t0);
      const msg = document.getElementById("o-msg");
      msg.innerHTML = `${players.length} players · ${R.exact ? "exact" : '<span class="down">stopped early: not guaranteed best</span>'} · ${ms} ms`
        + (lockOff.length ? ` · <span class="down">locked but not in this pool: ${esc(lockOff.join(", "))}</span>` : "")
        + (OP.pool === "short" && !short.size ? ' · <span class="down">shortlist is empty: star players on the Matrix</span>' : "");
      const el = document.getElementById("o-res");
      if (R.error && !R.lineups.length) { el.innerHTML = `<p class="empty">${esc(R.error)}</p>`; return; }
      const act = l => { if (!res) return null; let s = 0; for (const n of l.players) { const r = byName.get(n), a = r && r.act != null ? r.act : 0; s += a * (n === l.C ? Number(C.cm) : n === l.VC ? Number(C.vm) : 1); } return s; };
      el.innerHTML = `<div class="tbl-wrap"><table class="opt"><thead><tr><th class="n">#</th><th class="n">Mean FP</th>${res ? '<th class="n">Actual</th>' : ""}<th>Captain</th><th>Vice</th><th>Other ${Number(C.n) - 2}</th><th class="n">Cost</th><th class="n">Left</th><th>Teams</th></tr></thead><tbody>
        ${R.lineups.map(l => `<tr><td class="n">${l.rank}</td><td class="n strong">${f1(l.fp)}</td>${res ? `<td class="n">${f2(act(l))}</td>` : ""}<td class="pl">${nm(l.C)}</td><td>${nm(l.VC)}</td><td class="why">${l.rest.map(nm).join(" · ")}</td>
          <td class="n">${f2(l.cost)}</td><td class="n">${f2(l.left)}</td><td class="dim">${esc(l.teams)}</td></tr>`).join("")}</tbody></table></div>
        <p class="note">Ties on mean FP: more budget left ranks first (FanTeam's tie-break). Assumed (TBC): a C or VC who sits passes his multiplier to the safety-net sub.</p>
        ${exposure(R.lineups)}`;
      document.querySelectorAll("#o-res .lk").forEach(b => b.addEventListener("click", () => flip(b.dataset.n, b.dataset.a)));
    }
    function exposure(L) {    // P6d: every player in the lineups shown, how many of them he is in, how often as Captain
      if (!L.length) return "";
      const cnt = new Map(), cc = new Map();
      L.forEach(l => { l.players.forEach(n => cnt.set(n, (cnt.get(n) || 0) + 1)); cc.set(l.C, (cc.get(l.C) || 0) + 1); });
      const zOf = n => all.find(x => x.r.name === n);
      const rs = [...cnt.entries()].map(([n, c]) => ({ n, c, z: zOf(n) })).sort((a, b) => b.c - a.c || (b.z ? b.z.u.v : 0) - (a.z ? a.z.u.v : 0));
      return `<h3 class="sub-h">Players in these ${L.length} lineups</h3><div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Role</th><th class="n">Price</th><th class="n">Used FP</th><th class="n">In</th><th class="n">Share</th><th class="n">As C</th><th>Lock / Out</th></tr></thead><tbody>
        ${rs.map(x => { const r = x.z ? x.z.r : byName.get(x.n) || { name: x.n }, lk = C.locks.includes(x.n);
          return `<tr><td class="pl">${plink(r)}</td><td>${esc(r.team || "")}</td><td><span class="pos">${esc(r.pos || "")}</span></td><td class="n">${f1(r.price)}</td>
          <td class="n">${x.z ? f1(x.z.u.v) + (x.z.u.est ? "*" : "") : "—"}</td><td class="n strong">${x.c}</td><td class="n">${Math.round(100 * x.c / L.length)}%</td><td class="n">${cc.get(x.n) || ""}</td>
          <td class="lo"><button type="button" class="lk" data-n="${esc(x.n)}" data-a="lock" aria-pressed="${lk}">Lock</button><button type="button" class="lk" data-n="${esc(x.n)}" data-a="ban" aria-pressed="false">Out</button></td></tr>`; }).join("")}</tbody></table></div>
        <p class="note">${rs.length} different players. A player in every lineup is a core pick on mean FP; one in a single lineup is a fringe call. ${OP.rows === "all" ? "'Every C/VC' lists the same squad more than once (other Captain / Vice), so counts lean to that squad: switch to 'Best C/VC per squad' for one row per squad." : ""} Lock / Out here = the Slate page's L / X.</p>`;
    }
    function flip(n, a) { const on = a === "lock" ? C.locks : C.bans, off = a === "lock" ? C.bans : C.locks;
      const i = on.indexOf(n); if (i >= 0) on.splice(i, 1); else { on.push(n); const j = off.indexOf(n); if (j >= 0) off.splice(j, 1); }
      saveC(); table(); run(); }
    function table() {
      const q = OP.q.trim().toLowerCase();
      const P = pool().filter(z => !q || z.r.name.toLowerCase().includes(q)).sort((a, b) => b.u.v - a.u.v);
      const banned = all.filter(z => C.bans.includes(z.r.name) && inGames(z) && !P.includes(z));
      document.getElementById("o-tb").innerHTML = P.map(z => { const n = z.r.name, lk = C.locks.includes(n), bn = C.bans.includes(n);
        return `<tr class="${bn ? "off" : ""}"><td class="pl">${plink(z.r)}${z.o ? ' <span class="chip yours">yours</span>' : ""}</td><td>${esc(z.r.team)}</td><td><span class="pos">${esc(z.r.pos)}</span></td>
          <td class="n">${f1(z.r.price)}</td><td class="n strong">${f1(z.u.v)}${z.u.est ? "*" : ""}</td><td class="n">${f2(z.u.v / z.r.price)}</td>
          <td class="lo"><button type="button" class="lk" data-n="${esc(n)}" data-a="lock" aria-pressed="${lk}">Lock</button><button type="button" class="lk" data-n="${esc(n)}" data-a="ban" aria-pressed="${bn}">Out</button></td>
          ${res ? `<td class="n">${z.r.act != null ? f2(z.r.act) : '<span class="dim">' + (z.r.dnp ? "DNP" : "—") + "</span>"}</td>` : ""}</tr>`; }).join("")
        || `<tr><td colspan="8" class="dim">${OP.pool === "short" ? "No shortlisted player in these games." : "Nobody usable in these games."}</td></tr>`;
      document.getElementById("o-cnt").textContent = `${P.length} players` + (banned.length ? ` · ${banned.length} out not shown` : "");
      document.querySelectorAll("#o-tb .lk").forEach(b => b.addEventListener("click", () => flip(b.dataset.n, b.dataset.a)));
    }
    [["o-budget", "budget"], ["o-n", "n"], ["o-cm", "cm"], ["o-vm", "vm"], ["o-mt", "maxTeam"], ["o-top", "topN"]].forEach(([id, k]) =>
      document.getElementById(id).addEventListener("change", e => { const v = e.target.value; if (v === "" || !isFinite(Number(v))) return; C[k] = Number(v); saveC(); run(); }));
    app.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
      const [k, v] = Object.entries(b.dataset)[0]; OP[k] = v; saveOP();
      app.querySelectorAll(`.seg button[data-${k}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[k] === v));
      table(); run();
    }));
    app.querySelectorAll("input[data-g]").forEach(c => c.addEventListener("change", () => {
      C.games = [...app.querySelectorAll("input[data-g]:checked")].map(x => x.dataset.g); saveC(); table(); run();
    }));
    document.getElementById("o-q").addEventListener("input", e => { OP.q = e.target.value; table(); });
    document.getElementById("o-clear").addEventListener("click", () => { C.locks = []; C.bans = []; saveC(); table(); run(); });
    document.getElementById("o-pick").addEventListener("change", e => { location.hash = "opt-" + e.target.value.toLowerCase(); });
    table(); run();
    window.scrollTo(0, 0);
  }

  /* ---------- Simulator (PLAN 5.5) ----------
     Run: page commits analysis/sims/<id>/pool.xlsx (if a new file) then request.json. That push starts the `sim` Action
     (scripts/run_sim_request.py = model/daily_proj.py + model/daily_sim.py, same as a chat). The page polls for
     result.json. Classic 7-player format only. History = folders under analysis/sims (private repo: token needed).
     Build D (1 Nov): pool from a chat-committed slate ('slate:<folder>', settings prefilled) or a past run; mode full /
     shortlist (names prefilled from that slate's Matrix ☆); construction rules as switches (model/daily_sim.py RULES:
     defaults below MUST match it); underdogs 'auto' = teams getting 7+ on the spread (props Action game lines). */
  const SIM_DIR = "analysis/sims";
  const SIM_RULES = [   // [key, label, value when ON, default ON?]  (defaults = daily_sim.RULES, replay analysis/2026-11-01_build_d)
    ["cheap_max", "At most 1 player under 8M", 1, false],
    ["chalk_star", "At least 1 chalk star (13M+, field own 30%+)", 1, false],
    ["inj_role", "At least 1 injury-role player (on/off boost 6+)", 1, false],
    ["game_cap", "Max 2 from one game (slates of 5+ games)", 2, false],
    ["small_stack", "3+ from one game (slates of 4 games or fewer)", 3, false],
    ["stack_total", "…the stack from the highest-total game (needs game lines)", true, false]];
  const SIMF = Object.assign({ label: "", us_date: "", budget: 90, n_entries: 3, field_size: 730, buy_in: 2.3, paid_places: 124, max_per_team: "",
    out: "", in: "", lock: "", ban: "", underdogs: "", ud_auto: true, inj: true, props: true, hours: 12, pool_src: "",
    mode: "full", shortlist: "", rules: Object.fromEntries(SIM_RULES.map(r => [r[0], r[3]])) }, store.get("sim", {}));
  if (!SIMF.rules) SIMF.rules = Object.fromEntries(SIM_RULES.map(r => [r[0], r[3]]));
  const SIMS = { list: null, err: null, res: {}, poll: null };
  const usDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const names = t => String(t || "").split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  const simId = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const pct = (v, d) => v == null ? "—" : (v * 100).toFixed(d == null ? 0 : d) + "%";
  const eur = v => v == null ? "—" : "€" + Number(v).toFixed(2);

  async function simList() {
    if (!GH.token()) return [];
    try {
      const l = await GH.list(SIM_DIR);
      SIMS.list = l.filter(x => x.type === "dir" && /^\d{8}-\d{6}/.test(x.name)).map(x => x.name).sort().reverse(); SIMS.err = null;
    } catch (e) { SIMS.err = e.message; SIMS.list = []; }
    return SIMS.list;
  }
  async function simGet(id, file) {
    const f = await GH.get(SIM_DIR + "/" + id + "/" + file);
    return f.text == null ? null : JSON.parse(f.text);
  }
  const whenId = id => { const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(id); return m ? `${+m[3]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m[2] - 1]} ${m[4]}:${m[5]}Z` : id; };

  async function renderSim(id) {
    if (SIMS.poll && !id) { clearInterval(SIMS.poll.t); SIMS.poll = null; }
    if (!GH.token()) {
      app.innerHTML = shell("sim", "Simulator") + `<main class="wrap"><section><div class="sec-head"><div><h1>Simulator</h1>
        <p class="sub">Runs the daily simulator (the same scripts as a pre-slate chat) on a FanTeam pool you upload, and shows the suggested entries.</p></div></div>
        <p class="panel">The simulator saves a run request to the private repo nba.dfs, so it needs the write-back token on this device: <a href="#settings">Settings</a>.</p></section></main>`;
      return;
    }
    if (id) return renderSimResult(id);
    app.innerHTML = shell("sim", "Simulator") + `<main class="wrap"><p class="loading">Loading runs…</p></main>`;
    await simList();
    if (location.hash !== "#sim") return;
    const F = SIMF; if (!F.us_date || F.us_date < usDate()) F.us_date = usDate();
    const pools = [];
    for (const r of (SIMS.list || []).slice(0, 8)) {   // pools of recent runs, to re-run the same contest without a new upload
      const q = SIMS.res[r] ? SIMS.res[r].request : null;
      pools.push({ id: r, label: q ? (q.label || "") + " · " + (q.us_date || "") : "" });
    }
    await loadSlates();   // Build D: chat-committed slates (live first) with their own pool + contest settings
    const slPools = SLATES.filter(x => x.pool && x.fmt !== "captain" && !x.results).slice(0, 6);
    // 1 Nov fix: the form remembered the last pool (D16) and ran it on D17's date. Open on the live classic slate
    // (once per page load, like Matrix), drop a remembered slate that is gone, and say which slate is current.
    const liveSl = slPools.find(isLive);
    let autoFill = false;
    if (F.pool_src.startsWith("slate:") && !slPools.some(x => "slate:" + x.id === F.pool_src)) F.pool_src = "";
    if (liveSl && !SIMS.liveSeen) { SIMS.liveSeen = true; if (F.pool_src !== "slate:" + liveSl.id || F.us_date !== liveSl.us_date) { F.pool_src = "slate:" + liveSl.id; autoFill = true; } }
    const lockT = liveSl && liveSl.lock_utc ? new Date(liveSl.lock_utc).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    const ta = (k, l, hint) => `<label class="grow">${l}<textarea id="f-${k}" rows="2" placeholder="${hint}" spellcheck="false">${esc(F[k])}</textarea></label>`;
    const nb = (k, l, step, extra) => `<label>${l}<input type="number" id="f-${k}" step="${step}" value="${esc(F[k])}"${extra || ""}></label>`;
    app.querySelector("main").innerHTML = `<section><div class="sec-head"><div><h1>Simulator</h1>
        <p class="sub">Upload the FanTeam pool, set the contest, add your news calls, Run. GitHub runs the same projection and simulator as a pre-slate chat (about 3-4 minutes) and the entries appear here. Classic 7-player contests only; captain single-game slates still go through a chat. A run here is not a frozen slate: freeze in the pre-slate chat.</p></div></div>
      ${liveSl ? `<p class="panel live-note"><strong>Current slate: ${esc(liveSl.label)} LIVE</strong> · ${esc(dshort(liveSl.us_date))}${lockT ? " · locks " + esc(lockT) + " your time" : ""}. Its pool is selected below; pick another pool only on purpose.</p>` : ""}
      <form id="sim-f" class="panel sim-form" onsubmit="return false">
        <div class="filters">
          <label class="grow">Label<input id="f-label" value="${esc(F.label)}" placeholder="e.g. D16 9 games"></label>
          <label>US date of games<input type="date" id="f-us_date" value="${esc(F.us_date)}"></label>
        </div>
        <div class="filters">
          <label class="grow">FanTeam pool (.xlsx export)<input type="file" id="f-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
          ${pools.length || slPools.length ? `<label class="grow">or use the pool of<select id="f-pool_src"><option value="">— new file —</option>
            ${slPools.length ? `<optgroup label="Slates (from a chat)">${slPools.map(x => `<option value="slate:${esc(x.id)}"${"slate:" + x.id === F.pool_src ? " selected" : ""}>${esc(x.label)}${isLive(x) ? " LIVE" : ""} · ${esc(dshort(x.us_date))}${x.budget ? " · " + x.budget + "M" : ""}</option>`).join("")}</optgroup>` : ""}
            ${pools.length ? `<optgroup label="Past runs">${pools.map(p => `<option value="${esc(p.id)}"${p.id === F.pool_src ? " selected" : ""}>${esc(whenId(p.id))}${p.label ? " · " + esc(p.label) : ""}</option>`).join("")}</optgroup>` : ""}</select></label>` : ""}
        </div>
        <div class="filters">
          ${nb("budget", "Budget (M)", "0.1", ' min="40" max="200"')}${nb("n_entries", "Entries", "1", ' min="1" max="15"')}${nb("field_size", "Field size", "1", ' min="2"')}
          ${nb("buy_in", "Buy-in € (incl. fee)", "0.01", ' min="0"')}${nb("paid_places", "Paid places", "1", ' min="1"')}${nb("max_per_team", "Max per team", "1", ' min="1" placeholder="none"')}
        </div>
        <div class="filters">
          ${ta("out", "Out (news: will not play)", "names, comma or new line")}${ta("in", "In (will play)", "names")}
        </div>
        <div class="filters">
          ${ta("lock", "Lock (in every entry)", "names")}${ta("ban", "Ban (in no entry)", "names")}
        </div>
        <div class="filters"><button type="button" id="sim-pkcopy">Copy Slate / Optimiser locks and excludes</button></div>
        <div class="filters">
          <label class="chk"><input type="checkbox" id="f-ud_auto"${F.ud_auto ? " checked" : ""}> Underdogs from the spread (+7 or more)</label>
          <label>or by hand (max 1 per entry)<input id="f-underdogs" value="${esc(F.underdogs)}" placeholder="team codes, e.g. BKN"${F.ud_auto ? " disabled" : ""}></label>
        </div>
        <fieldset class="sim-rules"><legend>Players</legend>
          <div class="filters">
            <label>Use<select id="f-mode"><option value="full"${F.mode !== "shortlist" ? " selected" : ""}>Full pool</option><option value="shortlist"${F.mode === "shortlist" ? " selected" : ""}>Shortlist only</option></select></label>
            ${ta("shortlist", "Shortlist (your entries pick only from these)", "names; filled from the slate's Matrix ☆")}
          </div>
          <p class="note" id="f-sl-note">${F.mode === "shortlist" ? "Shortlist only: your entries use these players (and any locks). The simulated field still uses the full pool." : "Full pool: the shortlist box is ignored."}</p>
        </fieldset>
        <fieldset class="sim-rules"><legend>Construction rules (your entries only)</legend>
          ${SIM_RULES.map(([k, l]) => `<label class="chk"><input type="checkbox" id="r-${k}"${F.rules[k] ? " checked" : ""}> ${esc(l)}</label>`).join("")}
          <p class="note">From the dvern / Calculated11 study. Replayed on 10 slates (Build D): none beat no rule. Max 1 under 8M and 1 chalk star change nothing (our lineups already do it); max 2 per game lost 11 FP a slate; the injury-role rule is boom or bust (worse on 8 of 10). So all start off: use them as judgement calls. A rule that cannot apply to this slate is skipped and the result says so.</p>
        </fieldset>
        <div class="filters">
          <label class="chk"><input type="checkbox" id="f-inj"${F.inj ? " checked" : ""}> Refresh ESPN injuries first (free)</label>
          <label class="chk"><input type="checkbox" id="f-props"${F.props ? " checked" : ""}> Pull fresh props (about 5 Odds API credits a game)</label>
          ${nb("hours", "Props: games within (hours)", "1", ' min="1" max="36"')}
        </div>
        <div class="filters"><button type="button" id="sim-run" class="primary">Run simulator</button><button type="button" id="sim-clear">Clear news calls</button></div>
        <p id="sim-msg" class="note" role="status"></p>
        <p class="note">Names: as on FanTeam; accents and dots do not matter. Unknown names are reported in the result, never guessed. Locks and bans change only your entries, not the simulated field. They start from the slate's Pick L / X (Slate page) when both boxes are empty. Settings are remembered on this device.</p>
      </form></section>
      <section><div class="sec-head"><div><h2>Runs</h2><p class="sub">Newest first. Each run is kept in nba.dfs (analysis/sims), so a chat can read it.</p></div></div>
        ${SIMS.err ? `<p class="note warn-t">Could not list runs: ${esc(SIMS.err)}</p>` : ""}
        ${SIMS.list && SIMS.list.length ? `<ul class="runs">${SIMS.list.slice(0, 30).map(r => `<li><a href="#sim-${esc(r)}">${esc(whenId(r))}</a>${SIMS.res[r] ? ` <span class="dim">${esc(SIMS.res[r].request.label || "")} · ${esc(SIMS.res[r].status)}</span>` : ""}</li>`).join("")}</ul>` : `<p class="empty">No runs yet.</p>`}
      </section>`;
    const msg = document.getElementById("sim-msg");
    const read = () => {
      const v = k => document.getElementById("f-" + k);
      ["label", "us_date", "out", "in", "lock", "ban", "underdogs", "shortlist"].forEach(k => { F[k] = v(k).value.trim(); });
      ["budget", "n_entries", "field_size", "buy_in", "paid_places", "max_per_team", "hours"].forEach(k => { F[k] = v(k).value === "" ? "" : Number(v(k).value); });
      F.inj = v("inj").checked; F.props = v("props").checked; F.pool_src = v("pool_src") ? v("pool_src").value : "";
      F.ud_auto = v("ud_auto").checked; v("underdogs").disabled = F.ud_auto; F.mode = v("mode").value;
      document.getElementById("f-sl-note").textContent = F.mode === "shortlist" ? "Shortlist only: your entries use these players (and any locks). The simulated field still uses the full pool." : "Full pool: the shortlist box is ignored.";
      SIM_RULES.forEach(([k]) => { F.rules[k] = document.getElementById("r-" + k).checked; });
      store.set("sim", F);
    };
    // Build D: picking a chat slate fills its contest settings and its shortlist (Matrix ☆ for that slate)
    const slateOf = src => src && src.startsWith("slate:") ? SLATES.find(x => x.id === src.slice(6)) : null;
    const fillFromSlate = async () => {
      const x = slateOf(F.pool_src); if (!x) return;
      const v = k => document.getElementById("f-" + k);
      v("us_date").value = x.us_date || ""; if (x.budget) v("budget").value = x.budget; if (x.field) v("field_size").value = x.field;
      if (x.buy_in) v("buy_in").value = x.buy_in; if (x.paid) v("paid_places").value = x.paid; if (x.n_entries) v("n_entries").value = x.n_entries;
      v("max_per_team").value = x.max_team || ""; v("label").value = x.label;
      const sh = await shortLoad(x.id, "short." + x.label);
      if (sh.size) v("shortlist").value = [...sh].join("\n");
      const pk = fillPicks(x);
      read();
      msg.textContent = `Settings from ${x.label}` + (sh.size ? `; shortlist ${sh.size} players` : "; no shortlist saved for it (Slate or Matrix ☆)") + (pk ? `; ${pk}` : "") + ".";
    };
    // P6d: lock / ban boxes start from the slate's Pick L / X (Slate page, Optimiser) when both are empty
    function fillPicks(x) {
      const v = k => document.getElementById("f-" + k), P_ = getPicks(x);
      if (v("lock").value.trim() || v("ban").value.trim() || (!P_.locks.length && !P_.bans.length)) return "";
      v("lock").value = P_.locks.join("\n"); v("ban").value = P_.bans.join("\n");
      return `lock ${P_.locks.length} / ban ${P_.bans.length} from the Slate page`;
    }
    app.querySelectorAll("#sim-f input, #sim-f textarea, #sim-f select").forEach(el => el.addEventListener("change", read));
    if (document.getElementById("f-pool_src")) document.getElementById("f-pool_src").addEventListener("change", fillFromSlate);
    if (autoFill) fillFromSlate();
    else if (slateOf(F.pool_src)) { const pk = fillPicks(slateOf(F.pool_src)); if (pk) { read(); msg.textContent = `Filled ${pk} (${slateOf(F.pool_src).label}).`; } }
    document.getElementById("sim-pkcopy").addEventListener("click", () => {
      const x = slateOf(F.pool_src); if (!x) { msg.textContent = "Pick a slate under 'or use the pool of' first: locks and excludes are kept per slate."; return; }
      const P_ = getPicks(x); if (!P_.locks.length && !P_.bans.length) { msg.textContent = `No locks or excludes set for ${x.label} on this device (Slate page Pick L / X, or Optimiser).`; return; }
      document.getElementById("f-lock").value = P_.locks.join("\n"); document.getElementById("f-ban").value = P_.bans.join("\n"); read();
      msg.textContent = `Copied ${P_.locks.length} locks and ${P_.bans.length} excludes from ${x.label}.`;
    });
    document.getElementById("sim-clear").addEventListener("click", () => { ["out", "in", "lock", "ban", "underdogs"].forEach(k => { document.getElementById("f-" + k).value = ""; }); read(); });
    document.getElementById("sim-run").addEventListener("click", async () => {
      read();
      const file = document.getElementById("f-file").files[0];
      const bad = [];
      if (!file && !F.pool_src) bad.push("choose the pool file (or a previous run's pool)");
      if (file && !/\.xlsx$/i.test(file.name)) bad.push("the pool must be the .xlsx export");
      if (file && file.size > 5e6) bad.push("pool file is over 5 MB: wrong file?");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(F.us_date)) bad.push("US date");
      [["budget", 40, 200], ["n_entries", 1, 15], ["field_size", 2, 1e5], ["buy_in", 0, 1e4], ["paid_places", 1, 1e5]]
        .forEach(([k, lo, hi]) => { if (F[k] === "" || !(F[k] >= lo && F[k] <= hi)) bad.push(k.replace("_", " ") + ` (${lo}-${hi})`); });
      if (F.paid_places > F.field_size) bad.push("paid places is more than the field");
      if (F.mode === "shortlist" && names(F.shortlist).length < 7) bad.push("shortlist mode needs 7+ names");
      if (bad.length) { msg.innerHTML = '<span class="down">Fix first:</span> ' + esc(bad.join("; ")); return; }
      const id = simId(), dir = SIM_DIR + "/" + id, btn = document.getElementById("sim-run"); btn.disabled = true;
      try {
        let pool;
        if (file) {
          msg.textContent = "Uploading the pool…";
          await GH.putBytes(dir + "/pool.xlsx", new Uint8Array(await file.arrayBuffer()), `insite sim ${id}: pool ${file.name}`);
          pool = dir + "/pool.xlsx";
        } else if (slateOf(F.pool_src)) {
          pool = slateOf(F.pool_src).pool;
        } else {
          const r0 = SIMS.res[F.pool_src], q = (r0 && r0.request) || await simGet(F.pool_src, "request.json") || {};
          pool = (r0 && r0.pool) || q.pool || SIM_DIR + "/" + F.pool_src + "/pool.xlsx";   // runner default when request has none
        }
        const req = { id, created_utc: nowIso(), label: F.label, pool, pool_name: file ? file.name : (slateOf(F.pool_src) ? "slate " + slateOf(F.pool_src).label : "reused from " + F.pool_src), us_date: F.us_date,
          budget: F.budget, n_entries: F.n_entries, field_size: F.field_size, buy_in: F.buy_in, paid_places: F.paid_places,
          out: names(F.out), in: names(F.in), lock: names(F.lock), ban: names(F.ban),
          underdogs: F.ud_auto ? "auto" : names(F.underdogs).map(x => x.toUpperCase()),
          mode: F.mode, rules: Object.fromEntries(SIM_RULES.map(([k, , on]) => [k, F.rules[k] ? (on === true ? true : on) : (on === true ? false : 0)])),
          refresh_injuries: F.inj, props_hours: F.props ? (F.hours || 12) : 0 };
        if (F.mode === "shortlist") req.shortlist = names(F.shortlist);
        if (F.max_per_team !== "") req.max_per_team = F.max_per_team;
        msg.textContent = "Saving the run request…";
        await GH.put(dir + "/request.json", JSON.stringify(req, null, 1) + "\n", `insite sim ${id}: request ${F.label || ""}`.trim());
        SIMS.list = null; SIMS.poll = null;
        location.hash = "sim-" + id;
      } catch (e) { msg.innerHTML = '<span class="down">Failed:</span> ' + esc(e.message); btn.disabled = false; }
    });
    // fill run labels in the background (one small read each, newest 8 only)
    for (const r of (SIMS.list || []).slice(0, 8)) {
      if (SIMS.res[r]) continue;
      simGet(r, "result.json").then(x => { if (x) { SIMS.res[r] = x; } }).catch(() => {});
    }
  }

  async function renderSimResult(id) {
    app.innerHTML = shell("sim", "Run " + whenId(id)) + `<main class="wrap"><p class="loading">Loading run ${esc(whenId(id))}…</p></main>`;
    let res = SIMS.res[id] || null, err = null;
    if (!res) { try { res = await simGet(id, "result.json"); if (res) SIMS.res[id] = res; } catch (e) { err = e.message; } }
    if (location.hash !== "#sim-" + id) return;
    const main = app.querySelector("main");
    if (err) { main.innerHTML = `<p><a class="back" href="#sim">← Simulator</a></p><p>Could not read this run (${esc(err)}).</p>`; return; }
    if (!res) {   // still running: poll every 15 s for up to 10 min
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);   // start = request time in the id (UTC), survives a reload
      const t0 = m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.now();
      const P = SIMS.poll && SIMS.poll.id === id ? SIMS.poll : (SIMS.poll = { id, start: Math.min(t0, Date.now()), t: null });
      const mins = (Date.now() - P.start) / 60000;
      main.innerHTML = `<p><a class="back" href="#sim">← Simulator</a></p><section><h1>Run ${esc(whenId(id))}</h1>
        <p class="panel" id="sim-wait">${mins < 10 ? `Running on GitHub… ${Math.floor(mins)}:${String(Math.floor((mins % 1) * 60)).padStart(2, "0")} so far (usually 3-4 min). This page checks every 15 seconds; you can leave and come back.`
          : "No result after 10 minutes. Check GitHub → nba.dfs → Actions → sim. If the run failed there, result.json may be missing; if it never started, the request may not have been saved."}</p></section>`;
      if (!P.t && mins < 10) P.t = setInterval(async () => {
        if (location.hash !== "#sim-" + id) { clearInterval(P.t); P.t = null; return; }
        try { const r = await simGet(id, "result.json"); if (r) { SIMS.res[id] = r; clearInterval(P.t); P.t = null; renderSimResult(id); return; } } catch (e) { /* keep polling */ }
        const w = document.getElementById("sim-wait"), m2 = (Date.now() - P.start) / 60000;
        if (m2 >= 10) { clearInterval(P.t); P.t = null; renderSimResult(id); return; }
        if (w) w.firstChild.textContent = `Running on GitHub… ${Math.floor(m2)}:${String(Math.floor((m2 % 1) * 60)).padStart(2, "0")} so far (usually 3-4 min). This page checks every 15 seconds; you can leave and come back.`;
      }, 15000);
      return;
    }
    const q = res.request || {}, c = res.counts || {};
    const facts = [["US date", dshort(q.us_date)], ["Budget", q.budget + "M"], ["Entries", q.n_entries], ["Field", q.field_size], ["Buy-in", eur(q.buy_in)],
      ["Paid", q.paid_places], ["Usable", c.usable != null ? `${c.usable} of ${c.pool}` : "—"], ["Props lines", c.with_props ?? "—"]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    const warn = (res.warnings || []).length ? `<ul class="note warn-t sim-warn">${res.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
    const ap = res.applied || {};
    const calls = ["out", "in", "lock", "ban", "underdogs"].filter(k => (ap[k] || []).length).map(k => `${k} ${esc(ap[k].join(", "))}`)
      .concat(ap.mode === "shortlist" ? [`shortlist only (${(ap.shortlist || []).length} players)`] : [])
      .concat(ap.rules && ap.rules !== "none" ? [`rules ${esc(ap.rules)}`] : []).join("; ");
    const head = `<p><a class="back" href="#sim">← Simulator</a></p><section><div class="sec-head"><div><h1>${esc(q.label || "Run")} <small class="dim">${esc(whenId(id))}</small></h1>
      <p class="sub">${res.status === "ok" ? `Done in ${res.seconds ?? "?"} s. Pool: ${esc(q.pool_name || q.pool || "")}.` : "This run failed. Nothing was simulated."}</p></div></div>
      <dl class="facts">${facts}</dl>${calls ? `<p class="note">Calls applied: ${calls}.</p>` : ""}${warn}</section>`;
    if (res.status !== "ok") {
      main.innerHTML = head + `<section class="panel"><p><strong>Why:</strong></p><ul>${(res.errors || []).map(e => `<li>${esc(e)}</li>`).join("")}</ul>
        <p class="note">Fix the setting and run again from the Simulator page.</p></section>`;
      return;
    }
    const ent = `<section><div class="sec-head"><div><h2>Suggested entries</h2>
      <p class="sub">pick3 rule: full budget, at most 4 players shared between any two entries${ap.mode === "shortlist" ? ", shortlisted players only" : ""}. EUR, cash and top 1% are the simulator's own figures: they assume our projection beats the field's, so they run optimistic. Proj = our mean incl. the safety net; Own = simulated field ownership.</p></div></div>
      <div class="entries">${res.entries.map(e => `<div class="entry sim"><h3>E${e.entry}<small>${f1(e.price)}M · proj ${f1(e.proj)} · ${eur(e.eur)} · cash ${pct(e.cash)} · top1% ${pct(e.top1, 1)}</small></h3>
        <ul>${e.players.map(p => `<li><span class="nm">${esc(p.player)}${p.p_play < 1 ? ` <span class="chip dtd">${pct(p.p_play)}</span>` : ""}${(p.boost || 0) >= 6 ? ' <span class="chip up-chip">upside</span>' : ""}</span><span class="dim">${esc(p.pos)} ${esc(p.team)}</span><span class="n">${f1(p.price)}</span><span class="n">${f1(p.proj)}</span><span class="n dim">${f1(p.own)}%</span></li>`).join("")}</ul></div>`).join("")}</div>
      <p class="note">Players in every entry: ${(() => { const s = res.entries.map(e => new Set(e.players.map(p => p.player))); const all = [...s[0] || []].filter(n => s.every(x => x.has(n))); return all.length ? esc(all.join(", ")) + " (one bad night there hits every entry)" : "none"; })()}.</p></section>`;
    const top = `<section><div class="sec-head"><div><h2>Top 10 lineups by sim EUR</h2></div></div>
      <div class="tbl-wrap"><table><thead><tr><th class="n">#</th><th class="n">EUR</th><th class="n">Cash</th><th class="n">Top 1%</th><th class="n">Proj</th><th class="n">Own sum</th><th class="n">Price</th><th>Players</th></tr></thead><tbody>
      ${res.top10.map((l, i) => `<tr><td class="n">${i + 1}</td><td class="n">${eur(l.eur)}</td><td class="n">${pct(l.cash)}</td><td class="n">${pct(l.top1, 1)}</td><td class="n">${f1(l.proj)}</td><td class="n">${f1(l.own_sum)}</td><td class="n">${f1(l.price)}</td><td class="why">${esc(l.players.join(" · "))}</td></tr>`).join("")}
      </tbody></table></div></section>`;
    const up = res.upside && res.upside.length ? `<section><div class="sec-head"><div><h2>Injury upside</h2><p class="sub">Boost 6+ from past games without the teammate. Flag only, not in Proj.</p></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th class="n">Price</th><th class="n">Proj</th><th class="n">Boost</th><th>Because out</th></tr></thead><tbody>
      ${res.upside.map(r => `<tr><td>${esc(r.player)}</td><td>${esc(r.team)}</td><td class="n">${f1(r.price)}</td><td class="n">${f1(r.proj)}</td><td class="n up">+${f1(r.boost)}</td><td class="why">${esc(r.why.split(";").join(" · "))}</td></tr>`).join("")}
      </tbody></table></div></section>` : "";
    const ls = res.listed && res.listed.length ? `<section><div class="sec-head"><div><h2>Doubtful players kept</h2><p class="sub">Valued with the safety net: chance he plays x his score + the rest x his sub's.</p></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Tag</th><th class="n">Plays</th><th>Sub</th><th class="n">Proj</th></tr></thead><tbody>
      ${res.listed.map(r => `<tr><td>${esc(r.player)}</td><td>${esc(r.team)}</td><td>${esc(r.tag)}</td><td class="n">${pct(r.p_play)}</td><td>${esc(r.sub)}</td><td class="n">${f1(r.proj)}</td></tr>`).join("")}
      </tbody></table></div></section>` : "";
    const own = `<section><details class="raw"><summary>Simulated field ownership (top 15)</summary><p>${esc((res.field_own || []).map(([p, v]) => `${p} ${Math.round(v)}%`).join(" · "))}</p></details>
      <details class="raw"><summary>Full simulator printout</summary><pre class="sim-log">${esc(res.summary || "")}</pre></details></section>`;
    main.innerHTML = head + ent + top + up + ls + own;
  }

  /* ---------- Settings: token for write-back ---------- */
  function renderSettings(autoTest) {
    const has = !!GH.token();
    app.innerHTML = shell("settings", "Settings") + `<main class="wrap"><section>
      <div class="sec-head"><div><h1>Write-back</h1>
        <p class="sub">Lets this page save your overrides (Slate), shortlists (Matrix) and simulator runs to the private repo nba.dfs. Each save is one commit. The model reads overrides the next time the projection runs.</p></div></div>
      <div class="panel">
        <p><strong>Status on this device:</strong> ${has ? '<span class="chip ok">token saved</span>' : '<span class="chip dtd">no token</span>'}</p>
        <form id="t-form" class="filters" onsubmit="return false">
          <label class="grow">GitHub token (fine-grained, nba.dfs only)<input type="password" id="t-in" autocomplete="off" spellcheck="false" placeholder="${has ? "saved; paste a new one to replace it" : "github_pat_…"}"></label>
          <button type="submit" id="t-save" class="primary">Save and test</button>
          ${has ? '<button type="button" id="t-test">Test again</button><button type="button" id="t-del">Remove from this device</button>' : ""}
        </form>
        <p id="t-msg" class="note" role="status"></p>
      </div>
      <p class="note">Safety: the token stays in this browser only and is sent only to api.github.com. Anyone holding this device can use it. It needs repository <strong>nba.dfs</strong> only, permission Contents (read and write). The simulator needs nothing more: saving a run request starts the sim Action. Not the <em>insite deploy</em> token. If a device is lost: delete the token on GitHub (Settings → Developer settings → Fine-grained tokens) and make a new one.</p>
    </section></main>`;
    const msg = document.getElementById("t-msg");
    async function test() {
      msg.textContent = "Testing…";
      try {
        const r = await GH.req("");
        if (!r.ok) throw new Error(ghErr(r.status));
        const j = await r.json();
        const w = j.permissions ? (j.permissions.push ? "write access confirmed" : "READ ONLY: saving will fail. Give the token Contents: read and write.") : "read works; write is checked on the first save";
        msg.innerHTML = `<span class="up">OK:</span> token sees ${esc(j.full_name)} (${j.private ? "private" : "public"}), ${esc(w)}.`;
      } catch (e) { msg.innerHTML = `<span class="down">Failed:</span> ${esc(e.message)}`; }
    }
    document.getElementById("t-save").addEventListener("click", () => {
      const v = document.getElementById("t-in").value.trim();
      if (!v) { msg.textContent = "Paste the token first."; return; }
      if (!/^(github_pat_|ghp_)/.test(v)) { msg.innerHTML = '<span class="down">That does not look like a GitHub token</span> (starts with github_pat_).'; return; }
      store.set("gh", v); renderSettings(true);
    });
    const tb = document.getElementById("t-test"); if (tb) tb.addEventListener("click", test);
    const db = document.getElementById("t-del"); if (db) db.addEventListener("click", () => { try { localStorage.removeItem("insite.gh"); } catch (e) { /* fine */ } renderSettings(); });
    if (autoTest) test();
  }

  async function route() {
    try { await loadBase(); } catch (e) {
      app.innerHTML = `<main class="wrap"><h1>insite</h1><p>Could not load the data files (${esc(e.message)}). The nightly build may still be running; reload in a few minutes.</p></main>`;
      return;
    }
    const h = location.hash.slice(1);
    try {
      if (h.startsWith("player-")) await renderPlayer(h.slice(7));
      else if (h === "slate" || h.startsWith("slate-")) await renderSlate(h.slice(6));
      else if (h === "matrix") await renderMatrix();
      else if (h === "opt" || h.startsWith("opt-")) await renderOpt(h.slice(4));
      else if (h === "sim" || h.startsWith("sim-")) await renderSim(h.slice(4));
      else if (h === "settings") renderSettings();
      else if (h === "injuries") await renderInjuries();
      else if (h === "teams") await renderTeams();
      else renderHome();
    } catch (e) {
      app.innerHTML = shell("") + `<main class="wrap"><p>Could not load this page (${esc(e.message)}). Reload to try again.</p></main>`;
    }
  }
  window.addEventListener("hashchange", route);
  let wasSm = window.innerWidth < 640;
  window.addEventListener("resize", () => { const sm = window.innerWidth < 640; if (sm !== wasSm && location.hash === "#matrix") renderMatrix(); wasSm = sm; });
  route();
})();
