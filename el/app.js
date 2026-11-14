/* insite, EuroLeague half: Home, Player, Slate, Injuries (P5a), write-back + Matrix + Optimiser + Settings (P5b).
   Lives at ryanxib.github.io/insite/el/ ; NBA is at ../ (league switch in the header).
   Reads data/meta.json, data/players.json, data/p/<id>.json, data/slates.json, data/s/<id>.json, data/injuries.json.
   Single-file preview: build_site.py --bundle sets window.INSITE = {meta, players, p, slates, s, inj} and no fetch is made.
   Write-back (P5b): overrides -> slates/<folder>/overrides.csv (model/daily_proj.py reads it), shortlist ->
   slates/<folder>/shortlist.csv (model/daily_sim.py reads it in mode 'shortlist'). Optimiser engine = site/opt.js.
   Simulator (P5c): the page commits slates/<folder>/runs/<id>/request.json; that push starts the `sim` Action
   (scripts/run_slate_request.py = news.py merge + daily_proj.py + daily_sim.py, the chat's code; never freezes), which
   commits result.json; the page polls for it. Style = NBA app.css (copied). */
(function () {
  "use strict";
  const ROLES = ["PG", "SG", "SF", "PF", "C"];
  const B = window.INSITE || null;
  const app = document.getElementById("app");
  let META = null, PLAYERS = null, SLATES = null, INJ = null;
  const cache = {};

  const store = {
    get(k, d) { try { const v = localStorage.getItem("insite.el." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("insite.el." + k, JSON.stringify(v)); } catch (e) { /* storage off: fine */ } }
  };

  /* ---------- Write-back (P5b): GitHub contents API on the private repo ryanxib/euroleague-dfs ----------
     insite is one site (one browser origin), so the token is the NBA half's: saved once under 'insite.gh'. The same
     fine-grained token needs euroleague-dfs added (Contents read + write). Sent only to api.github.com. One save = one commit. */
  const TOKEN_KEY = "insite.gh";
  const GH = {
    repo: "ryanxib/EuroLeague-DFS", branch: "main",   // exact name (GitHub reports the repo moved to this case)
    token() { try { const v = localStorage.getItem(TOKEN_KEY); return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
    setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage off */ } },
    async req(path, opt) {
      const t = this.token(); if (!t) throw new Error("no token on this device");
      return fetch("https://api.github.com/repos/" + this.repo + path, Object.assign({ cache: "no-store" }, opt, {
        headers: { Authorization: "Bearer " + t, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }));
    },
    enc: f => f.split("/").map(encodeURIComponent).join("/"),
    async get(file) {    // -> {text, sha}; text null if the file does not exist yet
      const r = await this.req("/contents/" + this.enc(file) + "?ref=" + this.branch);
      if (r.status === 404) return { text: null, sha: null };
      if (!r.ok) throw new Error(ghErr(r.status));
      const j = await r.json(), bin = atob(j.content.replace(/\n/g, ""));
      return { text: new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))), sha: j.sha };
    },
    async put(file, text, msg, sha) {    // -> new sha. 409/422 = changed elsewhere since it was read
      const u = new TextEncoder().encode(text); let bin = "";
      for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      const body = { message: msg, content: btoa(bin), branch: this.branch }; if (sha) body.sha = sha;
      const r = await this.req("/contents/" + this.enc(file), { method: "PUT", body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.status === 409 || r.status === 422 ? "the file changed on GitHub since this page read it. Reload and redo the change." : ghErr(r.status));
      return (await r.json()).content.sha;
    },
    async list(dir) {    // -> [{name, type}] ; [] if the folder does not exist yet
      const r = await this.req("/contents/" + this.enc(dir) + "?ref=" + this.branch);
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(ghErr(r.status));
      const j = await r.json(); return Array.isArray(j) ? j : [];
    },
    async json(file) { const f = await this.get(file); return f.text == null ? null : JSON.parse(f.text); }
  };
  function ghErr(code) {
    return { 401: "token rejected (expired or mistyped). Paste it again on Settings.", 403: "token has no write access to euroleague-dfs (Contents: read and write).",
             404: "token cannot see ryanxib/euroleague-dfs: add the repository to the token on GitHub (Settings → Developer settings → Fine-grained tokens)." }[code] || "GitHub error " + code;
  }
  const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";
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
  const OV_COLS = ["player", "status", "fp", "reason", "saved_utc"];     // = model/daily_proj.py load_overrides
  const ovPath = folder => "slates/" + folder + "/overrides.csv";
  const shPath = folder => "slates/" + folder + "/shortlist.csv";
  window.INSITE_EL = { toCSV, fromCSV, ovPath, shPath, OV_COLS };    // for tests

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f1 = v => v == null ? "—" : Number(v).toFixed(1);
  const f2 = v => v == null ? "—" : Number(v).toFixed(2);
  const dshort = iso => { if (!iso) return "—"; const d = new Date(String(iso).length === 10 ? iso + "T12:00:00Z" : iso); return isNaN(d) ? String(iso) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/Malta" }); };
  const mt = iso => { if (!iso) return "—"; const d = new Date(String(iso).replace(" ", "T").replace(/\+00:00$/, "Z")); return isNaN(d) ? String(iso) : d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Malta" }); };
  const sgn = v => v == null ? "" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${f1(v)}</span>`;
  const seg = (state, name, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-${name}="${esc(v)}" aria-pressed="${String(state[name]) === String(v)}">${l}</button>`).join("")}</div>`;
  const plink = r => r.id ? `<a href="#player-${esc(r.id)}">${esc(r.name)}</a>` : esc(r.name);

  async function getJSON(path) { const r = await fetch(path, { cache: "no-cache" }); if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }
  async function loadBase() {
    if (PLAYERS) return;
    if (B) { META = B.meta; PLAYERS = B.players; return; }
    [META, PLAYERS] = await Promise.all([getJSON("data/meta.json"), getJSON("data/players.json")]);
  }
  async function loadSlates() { if (!SLATES) SLATES = B ? (B.slates || []) : await getJSON("data/slates.json"); return SLATES; }
  async function loadSlate(id) { const k = "s:" + id; if (!cache[k]) cache[k] = B ? B.s[id] : await getJSON("data/s/" + encodeURIComponent(id) + ".json"); return cache[k]; }
  async function loadPlayer(id) { const k = "p:" + id; if (!cache[k]) cache[k] = B ? B.p[id] : await getJSON("data/p/" + encodeURIComponent(id) + ".json"); return cache[k]; }
  let TEAMS = null;
  async function loadTeams() { if (!TEAMS) TEAMS = B ? B.teams : await getJSON("data/teams.json"); return TEAMS; }
  async function renderTeams() {     // P6b: site/teams.js (same file in nba.dfs) draws the page
    app.innerHTML = shell("teams", "Teams") + `<main class="wrap" id="tm"><p class="loading">Loading…</p></main>`;
    const D = await loadTeams();
    if (!window.INSITE_TEAMS) { document.getElementById("tm").innerHTML = "<p>teams.js did not load.</p>"; return; }
    window.INSITE_TEAMS.render(document.getElementById("tm"), D, store); window.scrollTo(0, 0);
  }
  async function loadInj() { if (!INJ) INJ = B ? B.inj : await getJSON("data/injuries.json"); return INJ; }

  function statusChip(st) {
    if (st === "OUT") return '<span class="chip out">Out</span>';
    if (st === "GTD") return '<span class="chip dtd">GTD</span>';
    if (st === "EXPECTED") return '<span class="chip ok">Expected</span>';
    return "";
  }

  function shell(view, title) {
    const m = META;
    const fresh = m ? `Box scores to ${dshort(m.box_to)} (round ${m.rounds}) · news ${m.news_round ? "round " + m.news_round + (m.news_live ? "" : " (played)") : "none"} · built ${esc(m.built_utc)}` : "";
    const nav = [["home", "Home"], ["slate", "Slate"], ["injuries", "Injuries"], ["matrix", "Matrix"], ["opt", "Optimiser"], ["sim", "Simulator"], ["teams", "Teams"]].map(([v, l]) => `<a href="#${v}" class="${view === v ? "on" : ""}">${l}</a>`).join("");
    const soon = `<a href="#settings" class="${view === "settings" ? "on" : ""}" title="${GH.token() ? "Write-back on" : "Write-back off: add a token"}">Settings${GH.token() ? "" : "<small>no token</small>"}</a>`;
    document.title = title ? title + " · insite EL" : "insite · EuroLeague";
    return `<header class="bar"><div class="wrap">
      <a class="brand" href="#home">insite<span>.</span></a>
      <div class="seg league" role="group" aria-label="League"><a href="../" aria-pressed="false">NBA</a><a href="./" aria-pressed="true" aria-current="page">EuroLeague</a></div>
      <nav class="nav" aria-label="Main">${nav}${view === "player" ? `<a href="${esc(location.hash)}" class="on">Player</a>` : ""}${soon}</nav>
      <div class="fresh">${fresh}</div></div></header>`;
  }

  /* ---------- Home ---------- */
  const H = Object.assign({ src: "season", metric: "fp", q: "", team: "", role: "", pmin: "", pmax: "", pool: true, sort: "avg", dir: -1, price: "monthly", n: "5" }, store.get("home", {}));
  const saveH = () => store.set("home", { src: H.src, metric: H.metric, pool: H.pool, sort: H.sort, dir: H.dir, price: H.price, n: H.n });
  const TOPN = [["5", "5"], ["10", "10"], ["15", "15"], ["20", "20"]];
  /* Price shown on Home: the current monthly contest's fixed price, or the last daily pool price (switch). */
  const monthlyOn = () => H.price === "monthly" && !!(META && META.monthly);
  const pr = p => monthlyOn() ? p.mp : p.price;
  const inPool = p => monthlyOn() ? p.mp != null : p.pool;
  const valOf = p => { const v = H.src === "season" ? p.avg : H.src === "l5" ? p.l5 : p.proj; const c = pr(p); return H.metric === "fp" ? v : (v != null && c ? v / c : null); };

  function topFive() {
    const ok = PLAYERS.filter(p => inPool(p) && p.status !== "OUT" && (H.src !== "season" || p.gp >= META.min_gp) && valOf(p) != null);
    return ROLES.map(r => {
      const top = ok.filter(p => p.pos === r).sort((a, b) => valOf(b) - valOf(a)).slice(0, Number(H.n) || 5);
      const rows = top.map((p, i) => `<li><a href="#player-${esc(p.id)}"><span class="rk">${i + 1}</span>
        <span class="nm">${esc(p.name)}<small>${esc(p.team)} · ${f1(pr(p))}M · ${p.gp} GP</small></span>
        <span class="v">${H.metric === "fp" ? f1(valOf(p)) : f2(valOf(p))}</span></a></li>`).join("");
      return `<div class="col"><h3>${r}<small>${H.metric === "fp" ? "FP / game" : "FP per M"}</small></h3><ol>${rows || '<li class="empty">No player qualifies yet.</li>'}</ol></div>`;
    }).join("");
  }
  const COLS = [["name", "Player", 0], ["team", "Team", 0], ["pos", "Pos", 0], ["price", "Price", 1], ["status", "News", 0],
    ["avg", "Season (GP)", 1], ["l5", "Last 5", 1], ["fpm", "Season FP/M", 1], ["mins", "Min", 1], ["proj", "Last frozen", 1]];
  const sv = (p, k) => k === "fpm" ? (p.avg != null && pr(p) ? p.avg / pr(p) : null) : k === "price" ? pr(p) : k === "status" ? (p.status === "OUT" ? 2 : p.status === "GTD" ? 1 : 0) : p[k];
  function filtered() {
    const q = H.q.trim().toLowerCase(), n = v => v === "" ? null : Number(v), pmin = n(H.pmin), pmax = n(H.pmax);
    return PLAYERS.filter(p => (!q || p.name.toLowerCase().includes(q)) && (!H.team || p.team === H.team) && (!H.role || p.pos === H.role)
      && (!H.pool || inPool(p)) && (pmin == null || (pr(p) != null && pr(p) >= pmin)) && (pmax == null || (pr(p) != null && pr(p) <= pmax)))
      .sort((a, b) => { const x = sv(a, H.sort), y = sv(b, H.sort); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * H.dir; });
  }
  function renderTable() {
    const list = filtered();
    document.getElementById("tb").innerHTML = list.map(p => `<tr><td class="pl"><a href="#player-${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(p.team)}</td>
      <td><span class="pos">${esc(p.pos)}</span></td><td class="n">${pr(p) != null ? f1(pr(p)) : '<span class="dim">—</span>'}</td><td>${statusChip(p.status)}${p.conflict ? ' <span class="chip dtd" title="Sources disagree">conflict</span>' : ""}</td>
      <td class="n">${p.gp ? f1(p.avg) + ' <span class="dim">(' + p.gp + ")</span>" : '<span class="dim">— (0)</span>'}</td><td class="n">${f1(p.l5)}</td>
      <td class="n">${f2(sv(p, "fpm"))}</td><td class="n">${f1(p.mins)}</td>
      <td class="n">${p.proj != null ? f1(p.proj) + ' <span class="dim">' + esc(dshort(p.proj_date)) + "</span>" : '<span class="dim">—</span>'}</td></tr>`).join("");
    document.getElementById("cnt").textContent = `${PLAYERS.length} players · showing ${list.length}`;
    document.querySelectorAll("thead th").forEach(th => { if (th.dataset.k === H.sort) th.setAttribute("aria-sort", H.dir < 0 ? "descending" : "ascending"); else th.removeAttribute("aria-sort"); });
  }
  function homeSub() {
    const m = META.monthly;
    const price = monthlyOn() ? `Monthly prices (fixed): ${esc(m.name || "monthly")} #${m.id}, rounds ${m.rounds ? m.rounds.join("-") : "?"}${m.ends ? ", ends " + esc(dshort(m.ends)) : ""}. Players not in that pool are left out.`
      : H.price === "monthly" ? `Monthly prices not available (${esc(META.monthly_err || "no monthly pool")}): showing last daily price.`
      : "Last daily FanTeam price (changes every slate).";
    return `${price} Players with OUT news for the next round are hidden. "This season" needs ${META.min_gp}+ games. Last frozen = our newest pre-game projection (that slate's date).`;
  }
  function renderHome() {
    const teams = [...new Set(PLAYERS.map(p => p.team))].sort();
    app.innerHTML = shell("home") + `<main class="wrap">
      <section><div class="sec-head"><div><h1 id="top-h">Top ${esc(H.n)} by position</h1>
        <p class="sub" id="top-sub">${homeSub()}</p></div>
        <div class="toggles">${seg(H, "src", [["season", "This season"], ["l5", "Last 5"], ["proj", "Last frozen"]])}${seg(H, "metric", [["fp", "FP"], ["fpm", "FP per M"]])}${seg(H, "price", [["monthly", "Monthly price"], ["daily", "Last daily"]])}${seg(H, "n", TOPN)}</div></div>
        <div class="top5" id="top5">${topFive()}</div></section>
      <section><div class="sec-head"><h2>Players</h2><span class="count" id="cnt"></span></div>
        <form class="filters" onsubmit="return false">
          <label class="grow">Search<input type="search" id="f-q" placeholder="Player name" value="${esc(H.q)}"></label>
          <label>Team<select id="f-team"><option value="">All</option>${teams.map(t => `<option${t === H.team ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
          <label>Pos<select id="f-role"><option value="">All</option>${ROLES.map(r => `<option${r === H.role ? " selected" : ""}>${r}</option>`).join("")}</select></label>
          <label>Price (M)<span class="pair"><input type="number" id="f-pmin" step="0.5" min="0" value="${esc(H.pmin)}" aria-label="Price from"> to <input type="number" id="f-pmax" step="0.5" min="0" value="${esc(H.pmax)}" aria-label="Price to"></span></label>
          <label class="chk"><input type="checkbox" id="f-pool"${H.pool ? " checked" : ""}> <span id="f-pool-l">${monthlyOn() ? "Monthly pool only" : "FanTeam pool only"}</span></label>
          <button type="button" id="f-reset">Clear filters</button></form>
        <div class="tbl-wrap"><table><thead><tr>${COLS.map(([k, l, n]) => `<th data-k="${k}"${n ? ' class="n"' : ""}><button type="button">${l}</button></th>`).join("")}</tr></thead><tbody id="tb"></tbody></table></div>
        <p class="note">Season = FP per game played this season (games played). Last 5 = his last ${META.l5} games played. FP/M = season FP per million of the price shown (monthly or last daily, switch at the top). Few games = mostly luck: read with the GP count.</p></section></main>`;
    app.querySelectorAll(".toggles .seg button").forEach(b => b.addEventListener("click", () => {
      const [k, v] = Object.entries(b.dataset)[0]; H[k] = v; saveH();
      app.querySelectorAll(`.seg button[data-${k}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[k] === v));
      document.getElementById("top5").innerHTML = topFive();
      document.getElementById("top-h").textContent = `Top ${H.n} by position`;
      document.getElementById("top-sub").innerHTML = homeSub();
      document.getElementById("f-pool-l").textContent = monthlyOn() ? "Monthly pool only" : "FanTeam pool only";
      renderTable();
    }));
    const bind = (id, key, ev) => document.getElementById(id).addEventListener(ev || "input", e => { H[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value; saveH(); renderTable(); });
    bind("f-q", "q"); bind("f-team", "team", "change"); bind("f-role", "role", "change"); bind("f-pmin", "pmin"); bind("f-pmax", "pmax"); bind("f-pool", "pool", "change");
    document.getElementById("f-reset").addEventListener("click", () => { Object.assign(H, { q: "", team: "", role: "", pmin: "", pmax: "", pool: true }); saveH(); renderHome(); });
    app.querySelectorAll("thead th button").forEach(b => b.addEventListener("click", () => {
      const k = b.parentElement.dataset.k;
      if (H.sort === k) H.dir = -H.dir; else { H.sort = k; H.dir = ["name", "team", "pos"].includes(k) ? 1 : -1; }
      saveH(); renderTable();
    }));
    renderTable();
  }

  /* ---------- Player ---------- */
  function chart(log, proj) {
    const g = log.filter(e => e.fp != null || e.ours != null);
    if (!g.length) return "";
    const W = 340, Ht = 170, x0 = 28, x1 = W - 8, top = 8, h = Ht - 28, n = Math.max(g.length, 2);
    const yMax = Math.max(40, Math.ceil(Math.max(...g.map(e => Math.max(e.fp || 0, e.ours || 0))) / 10) * 10);
    const Y = v => top + h - (v / yMax) * h, X = i => x0 + (i / (n - 1)) * (x1 - x0);
    const ticks = []; for (let v = 0; v <= yMax; v += yMax > 60 ? 20 : 10) ticks.push(v);
    const grid = ticks.map(v => `<line class="grid" x1="${x0}" x2="${x1}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="${x0 - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`).join("");
    const xt = g.map((e, i) => `<text class="axis" x="${X(i).toFixed(1)}" y="${Ht - 6}" text-anchor="middle">${e.rd}</text>`).join("");
    const ours = g.map((e, i) => e.ours == null ? "" : `<line class="ours" x1="${(X(i) - 7).toFixed(1)}" x2="${(X(i) + 7).toFixed(1)}" y1="${Y(e.ours).toFixed(1)}" y2="${Y(e.ours).toFixed(1)}"><title>Round ${e.rd}: ours ${f1(e.ours)}</title></line>`).join("");
    const dots = g.map((e, i) => e.fp == null ? "" : `<circle class="dot cur" cx="${X(i).toFixed(1)}" cy="${Y(e.fp).toFixed(1)}" r="3.6"><title>Round ${e.rd}: ${e.fp} FP</title></circle>`).join("");
    return `<figure class="chart" style="margin:0"><h3>2026-27 by round</h3><p class="sub">Dots = FP. Bars = our frozen projection.</p>
      <svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="FP by round with our frozen projection">${grid}${xt}${ours}${dots}</svg></figure>`;
  }
  async function renderPlayer(id) {
    const p = PLAYERS.find(x => x.id === id);
    if (!p) { app.innerHTML = shell("player", "Not found") + `<main class="wrap"><p>No player "${esc(id)}". <a href="#home">Back</a></p></main>`; return; }
    app.innerHTML = shell("player", p.name) + `<main class="wrap"><p class="loading">Loading ${esc(p.name)}…</p></main>`;
    let d; try { d = await loadPlayer(id); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load (${esc(e.message)}). Reload to try again.</p>`; return; }
    if (location.hash !== "#player-" + id) return;
    const played = d.log.filter(e => e.fp != null && e.ours != null);
    const miss = played.length ? played.reduce((s, e) => s + Math.abs(e.fp - e.ours), 0) / played.length : null;
    const tiles = [["Price", f1(p.price) + "M", (p.pool ? "FanTeam daily, last seen" : "not in FanTeam pool") + (p.mp != null ? " · monthly " + f1(p.mp) + "M" : "")],
      ["Season FP/G", p.gp ? f1(p.avg) : "—", p.gp ? `${p.gp} games · ${f1(p.mins)} min` : "no games yet"],
      ["Last 5", f1(p.l5), "FP per game"], ["Last frozen", f1(p.proj), p.proj_date ? dshort(p.proj_date) : "never projected"],
      ["Our miss", miss != null ? f1(miss) : "—", played.length ? `avg over ${played.length} games he played` : "no scored games"]]
      .map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${esc(s)}</div></div>`).join("");
    const news = d.news ? `<div class="injury${d.news.st === "OUT" ? " out" : ""}"><strong>${esc(d.news.st)}</strong> · ${esc(d.news.note)}</div>` : "";
    const srows = d.seasons.map(s => `<tr class="${s.s === "2026-27" ? "cur" : ""}"><td>${esc(s.s)}</td><td>${esc(s.team)}</td><td class="n">${s.gp}</td><td class="n">${f1(s.fp)}</td><td class="n">${f1(s.min)}</td><td class="n">${f1(s.pts)}</td><td class="n">${f1(s.reb)}</td><td class="n">${f1(s.ast)}</td><td class="n">${f1(s.pir)}</td></tr>`).join("");
    const log = d.log.slice().reverse().map(e => {
      const gap = e.fp != null && e.ours != null ? e.fp - e.ours : null;
      return `<tr><td class="n">${e.rd}</td><td>${esc(dshort(e.d))}</td><td>${e.opp ? (e.home ? "v " : "@ ") + esc(e.opp) : '<span class="dim">—</span>'}</td>
        <td class="n">${e.min == null ? "—" : f1(e.min)}${e.st ? ' <span class="dim">S</span>' : ""}</td>
        <td class="n">${e.fp == null ? `<span class="dim">${esc(e.dnp || "DNP")}</span>` : f2(e.fp)}</td>
        <td class="n">${e.ours == null ? '<span class="dim">—</span>' : f1(e.ours)}</td><td class="n">${sgn(gap)}</td></tr>`;
    }).join("");
    app.querySelector("main").innerHTML = `<a class="back" href="#home">← Back</a>
      <section class="p-head"><h1>${esc(p.name)}</h1><div class="meta"><span class="pos">${esc(p.pos)}</span><span>${esc(p.team)}</span>${statusChip(p.status)}</div>${news}</section>
      <section class="tiles">${tiles}</section>
      <section><div class="sec-head"><div><h2>Season stats</h2><p class="sub">Per game played. Past seasons from EuroLeague season totals.</p></div></div>
        <div class="tbl-wrap"><table><thead><tr><th>Season</th><th>Team</th><th class="n">GP</th><th class="n">FP/G</th><th class="n">Min</th><th class="n">Pts</th><th class="n">Reb</th><th class="n">Ast</th><th class="n">PIR</th></tr></thead><tbody>${srows || '<tr><td colspan="9" class="dim">No games.</td></tr>'}</tbody></table></div></section>
      <section><div class="charts">${chart(d.log, p.proj)}</div></section>
      <section><div class="sec-head"><div><h2>2026-27 game log</h2><p class="sub">Ours = frozen pre-game projection for that round (newest slate if two). Gap = FP minus ours. S = started.</p></div></div>
        <div class="tbl-wrap"><table><thead><tr><th class="n">Rd</th><th>Date</th><th>Opp</th><th class="n">Min</th><th class="n">FP</th><th class="n">Ours</th><th class="n">Gap</th></tr></thead><tbody>${log || '<tr><td colspan="7" class="dim">No games yet.</td></tr>'}</tbody></table></div></section>`;
    window.scrollTo(0, 0);
  }

  /* ---------- shared for Slate, Matrix, Optimiser (P5b) ---------- */
  const byId = id => SLATES.find(s => s.id === id);
  const isLive = s => s.kind === "live" && !!s.folder;
  const lockMs = s => s.lock_utc ? Date.parse(s.lock_utc) : null;
  const isOpen = s => isLive(s) && (lockMs(s) == null || Date.now() < lockMs(s));    // before lock: overrides allowed
  const sLabel = s => `${s.label} · ${dshort(s.date)}${isOpen(s) ? " · LIVE" : s.kind === "live" ? " · locked" : ""}`;
  const pickSlate = (cur, id) => `<label class="pick">Slate<select id="${id}">${SLATES.map(s => `<option value="${esc(s.id)}"${s.id === cur.id ? " selected" : ""}>${esc(sLabel(s))}</option>`).join("")}</select></label>`;
  const current = () => SLATES.find(isOpen) || SLATES[0];
  // contest format as text: frozen slates carry contests.csv text; live ones the slate.json key (classic / captain / monthly)
  const fmtText = s => (window.INSITE_OPT && window.INSITE_OPT.FORMATS[s.fmt]) ? window.INSITE_OPT.FORMATS[s.fmt].label : (s.fmt || "");

  /* Used FP = what the simulator and the Optimiser use. Frozen slates: Ours. Live slates: model/daily_proj.py step 6 =
     Ryan's fp if set, else Ours; status out -> 0. If the override on screen is the one the last run applied, Used is that
     run's number (exact). Otherwise the page works it out at once (est, shown with *): an 'in' or a removed override
     keeps the model number until the projection is re-run (minutes and teammates can move then). */
  const ovKey = o => !o ? "" : [String(o.status ?? o.st ?? "").toLowerCase(), o.fp === "" || o.fp == null ? "" : Number(o.fp).toFixed(2)].join("|");
  function usedFP(r, o, live) {
    if (!live) return { v: r.q, est: false, out: r.q == null || r.q <= 0 };
    const ran = r.ov ? { status: r.ov.st || "", fp: r.ov.fp } : null;
    if (ovKey(o) === ovKey(ran)) return { v: r.used ?? r.q, est: false, out: (r.used ?? r.q) == null || (r.used ?? r.q) <= 0 };
    const st = o ? String(o.status ?? o.st ?? "").toLowerCase() : "";
    const fpo = o && o.fp !== "" && o.fp != null ? Number(o.fp) : null;
    if (st === "out") return { v: 0, est: true, out: true };
    if (fpo != null) return { v: fpo, est: true, out: fpo <= 0 };
    return { v: r.q, est: true, out: r.q == null || r.q <= 0 };
  }
  window.INSITE_USED = usedFP;    // for tests

  const OVR = {};   // per slate id: {rows: {name: row} | null, sha, err, pend: Map(name -> row | null)}
  window.addEventListener("beforeunload", e => { if (Object.values(OVR).some(o => o.pend && o.pend.size)) { e.preventDefault(); e.returnValue = ""; } });
  async function ovrLoad(info) {
    const O = OVR[info.id] || (OVR[info.id] = { rows: null, sha: null, err: null, pend: new Map() });
    if (isLive(info) && GH.token() && O.rows === null && !O.err) {
      try { const f = await GH.get(ovPath(info.folder)); O.sha = f.sha; O.rows = {}; if (f.text) fromCSV(f.text).forEach(r => { if (r.player) O.rows[r.player] = r; }); }
      catch (e) { O.err = e.message; }
    }
    return O;
  }
  // override shown per row: unsaved edit > repo file (token) > what the last run applied
  const ovIn = (O, r) => O.pend.has(r.name) ? O.pend.get(r.name) : O.rows ? (O.rows[r.name] || null) : (r.ov ? { status: r.ov.st || "", fp: r.ov.fp ?? "", reason: r.ov.why || "" } : null);
  const ovText = o => !o ? "" : [String(o.status ?? "").toLowerCase(), o.fp !== "" && o.fp != null ? f1(o.fp) : ""].filter(Boolean).join(" · ");

  const SH = {};    // shortlist per slate id: {names: Set, sha, err, can}
  const shKey = info => "short." + info.id;
  const getShort = info => new Set(store.get(shKey(info), []));
  const setShort = (info, s) => store.set(shKey(info), [...s]);
  async function shortLoad(info) {
    if (!SH[info.id]) {
      const can = !!(info.folder && GH.token());
      let names = new Set(info.short || []), sha = null, err = null;
      if (can) { try { const f = await GH.get(shPath(info.folder)); sha = f.sha; names = new Set(f.text ? fromCSV(f.text).map(r => (r.player || "").trim()).filter(Boolean) : []); } catch (e) { err = e.message; } }
      SH[info.id] = { names, sha, err, can: can && !err };
      store.set(shKey(info), [...new Set([...store.get(shKey(info), []), ...names])]);   // keep this device's stars too
    }
    return getShort(info);
  }
  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  async function shortSave(info) {    // this device's shortlist -> slates/<folder>/shortlist.csv. Throws with a plain message.
    const sh = SH[info.id]; if (!sh || !sh.can) throw new Error(GH.token() ? "slate has no folder in the repo" : "no write-back token on this device (Settings)");
    const names = [...getShort(info)].sort(), t = nowIso();
    sh.sha = await GH.put(shPath(info.folder), toCSV(["player", "saved_utc"], names.map(n => ({ player: n, saved_utc: t }))), `insite: ${info.label} shortlist (${names.length})`, sh.sha);
    sh.names = new Set(names);
  }
  /* Lock / Exclude (6a, 5 Nov): one list per slate on this device, shared by Slate, Optimiser and Simulator
     (stored with the Optimiser settings, key opt.<slate id>). Lock = in every lineup; Excl = in none. They only change
     which lineups you get; whether a player plays and his FP are overrides (✎). */
  const pickKey = info => "opt." + info.id;
  const getPicks = info => { const c = store.get(pickKey(info), {}); return { locks: c.locks || [], bans: c.bans || [] }; };
  function togglePick(info, n, what) {   // what: lock | ban. A player is never locked and excluded at once.
    const c = store.get(pickKey(info), {}); c.locks = c.locks || []; c.bans = c.bans || [];
    const on = what === "lock" ? c.locks : c.bans, off = what === "lock" ? c.bans : c.locks;
    const i = on.indexOf(n); if (i >= 0) on.splice(i, 1); else { on.push(n); const j = off.indexOf(n); if (j >= 0) off.splice(j, 1); }
    store.set(pickKey(info), c);
  }
  window.INSITE_PICKS = { getPicks, togglePick };    // for tests

  /* ---------- Slate ---------- */
  const S = Object.assign({ q: "", team: "", role: "", sort: "q", dir: -1, metric: "fp", pool: true, n: "5" }, store.get("slate", {}), { open: null });
  const saveS = () => store.set("slate", { sort: S.sort, dir: S.dir, metric: S.metric, pool: S.pool, n: S.n });
  async function renderSlate(id) {
    await loadSlates();
    if (!SLATES.length) { app.innerHTML = shell("slate", "Slate") + `<main class="wrap"><p>No slates yet.</p></main>`; return; }
    const info = id ? byId(id) : current();
    if (!info) { app.innerHTML = shell("slate", "Slate") + `<main class="wrap"><p>No slate "${esc(id)}". <a href="#slate">Current slate</a></p></main>`; return; }
    app.innerHTML = shell("slate", info.label) + `<main class="wrap"><p class="loading">Loading ${esc(info.label)}…</p></main>`;
    let d; try { d = await loadSlate(info.id); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load (${esc(e.message)}).</p>`; return; }
    const live = isLive(info), open = isOpen(info), res = info.results;
    const canEdit = open;     // 6a: ✎ shows on every open live slate; saving needs the token (said at Save)
    const PL = new Map(PLAYERS.map(p => [p.id, p]));
    const pl = (r, k) => { const p = r.id ? PL.get(r.id) : null; return p ? p[k] : null; };
    const short = await shortLoad(info);
    const O = await ovrLoad(info);
    const ovOf = r => ovIn(O, r);
    const U = r => usedFP(r, ovOf(r), live);
    const facts = [["Contest", info.contest], ["Date", dshort(info.date)], ["Players", info.n], ["With props", info.n_props]]
      .concat(live ? [["Lock", info.lock_malta ? info.lock_malta + " Malta" : "—"], ["Cap", info.cap ? info.cap + "M" : "—"], ["Overrides run", info.n_ovr || 0]].concat(info.frozen ? [["Frozen", (info.frozen.saved_at || "yes") + (info.frozen.saved_at ? " Malta" : "")]] : []) : [["Frozen", info.saved_at ? info.saved_at + " Malta" : "—"], ["Before tip", info.before_tip]])
      .concat(info.entries ? [["Field", Math.round(info.entries)]] : []).concat(info.buy_in != null ? [["Buy-in", "€" + f2(info.buy_in)]] : [])
      .concat(info.cash != null ? [["Cash line", f2(info.cash)]] : []).concat(info.mine != null ? [["Your best", f2(info.mine) + (info.my_rank ? " (#" + Math.round(info.my_rank) + ")" : "")]] : [])
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    const acc = res && info.miss != null ? `<section><div class="sec-head"><div><h2>How the projection did</h2>
        <p class="sub">Average miss in FanTeam points (lower is better). Same numbers as post_round.py.</p></div></div>
        <div class="tiles"><div class="tile"><div class="k">Played</div><div class="v">${f2(info.miss)}</div><div class="s">${info.miss_n} players who played</div></div>
        <div class="tile"><div class="k">All rows</div><div class="v">${f2(info.miss_all)}</div><div class="s">DNP counted as 0 FP</div></div>
        <div class="tile"><div class="k">Bias</div><div class="v">${sgn(info.bias)}</div><div class="s">projection minus actual, all rows</div></div></div>
        <p class="note">One slate is noise. Judge over many slates.</p></section>` : "";
    const ent = d.entries && d.entries.length ? `<section><div class="sec-head"><div><h2>Suggested entries</h2><p class="sub">daily_sim.py, chosen rule${info.fmt === "monthly" ? "" : " (sim mean)"}. Not always what was entered. Built on the Used FP of the last run.</p></div></div>
        <div class="entries">${d.entries.map(e => `<div class="entry"><h3>#${e.e}<small>${f1(e.price)}M · proj ${f1(e.q)} · sim ${f1(e.sim)} · ${e.p_t != null ? `p10–p90 ${e.p10 ?? "—"}–${e.p90 ?? "—"} · P(≥ ${e.tgt ?? "target"}) ${pct(e.p_t, 1)}` : `cash ${Math.round((e.p_cash || 0) * 100)}% · EUR ${f2(e.eur)}`}</small></h3>
          <ul>${e.players.map(n => { const r = d.rows.find(x => x.name === n) || { name: n }; return `<li><span class="nm">${plink(r)}</span><span class="dim">${esc(r.pos || "")}</span><span class="n">${f1(r.used ?? r.q)}</span></li>`; }).join("")}</ul></div>`).join("")}</div></section>` : "";
    const teams = [...new Set(d.rows.map(r => r.team))].sort();
    const cols = [["name", "Player", 0]].concat(live ? [["you", "You", 0]] : []).concat([["pick", "Pick", 0], ["team", "Team", 0], ["pos", "Pos", 0], ["price", "Price", 1], ["avg", "Season", 1], ["l5", "Last 5", 1], ["min", "Min", 1], ["model", "Model", 1], ["mkt", "Props", 1], ["q", "Ours", 1]])
      .concat(live ? [["used", "Used", 1]] : []).concat([["fpm", "/M", 1], ["news", "News", 0]]).concat(res ? [["act", "Actual", 1], ["gap", "Gap", 1]] : []);
    const how = (!live ? "Frozen pre-game projection." : !open ? "Past lock: overrides closed. The frozen file is what counts."
      : GH.token() ? `Live, before lock. Tap ✎ on a player to override. A saved override counts from the next projection run; until then Used shows it with *. <button type="button" id="s-rerun" class="primary">Re-run now</button> (about 2 min; or run it in a pre-slate chat).`
      : 'Live, before lock. Tap ✎ on a player to override. Saving needs the write-back token on this device: <a href="#settings">Settings</a>.')
      + (live && info.frozen ? " Frozen already: Ours here is the live run; the frozen file stays what is scored, and your overrides change Used (simulator, Optimiser) only." : "");
    app.querySelector("main").innerHTML = `
      <section><div class="sec-head"><div><h1>${esc(info.label)}</h1>
        <p class="sub">${how} ${res ? "Box scores are in: Actual and Gap shown." : ""}</p></div>${pickSlate(info, "s-pick")}</div>
        <dl class="facts">${facts}</dl>${info.fmt ? `<p class="note">${esc(fmtText(info))}</p>` : ""}
        ${O.err ? `<p class="note warn-t">Could not read saved overrides from the repo: ${esc(O.err)} Showing the overrides the last run applied.</p>` : ""}</section>
      <section><div class="sec-head"><div><h2 id="s-top-h">Top ${esc(S.n)} by position</h2><p class="sub">FanTeam pool players on this slate, by ${live ? "Used (* = your override, not re-run yet)" : "Ours"}.</p></div>
        <div class="toggles">${seg(S, "metric", [["fp", "FP"], ["fpm", "FP per M"]])}${seg(S, "n", TOPN)}</div></div><div class="top5" id="s-top5"></div></section>
      <section><div class="sec-head"><div><h2>Players</h2><p class="sub">Model = minutes x rates. Props = bookmaker-line FP. Ours = ${live ? "the model's number (props blend where lines exist)" : "the frozen number (props blend where lines exist)"}.${live ? " Used = your override, else Ours: what the simulator and Optimiser use." : ""} /M = ${live ? "Used" : "Ours"} per million. Season / Last 5 = FP per game played this season (games in brackets) and over the last 5, as of today's box scores${res ? " (includes games after this slate)" : ""}. Pick: ☆ shortlist, L lock (in every lineup), X exclude (in none): shared with the Optimiser and Simulator.${res ? " Gap = actual minus Ours." : ""}</p></div><span class="count" id="s-cnt"></span></div>
        <form class="filters" onsubmit="return false">
          <label class="grow">Search<input type="search" id="s-q" placeholder="Player name" value="${esc(S.q)}"></label>
          <label>Team<select id="s-team"><option value="">All</option>${teams.map(x => `<option${x === S.team ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
          <label>Pos<select id="s-role"><option value="">All</option>${ROLES.map(x => `<option${x === S.role ? " selected" : ""}>${x}</option>`).join("")}</select></label>
          <label class="chk"><input type="checkbox" id="s-pool"${S.pool ? " checked" : ""}> FanTeam pool only</label></form>
        <div id="s-bar" class="savebar" hidden></div><div id="s-shbar" class="savebar" hidden></div>
        <div class="tbl-wrap"><table><thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}"${n ? ' class="n"' : ""}>${k === "news" || k === "you" || k === "pick" ? l : `<button type="button">${l}</button>`}</th>`).join("")}</tr></thead><tbody id="s-tb"></tbody></table></div></section>
      ${ent}${acc}`;
    const val = (r, k) => k === "avg" || k === "l5" ? pl(r, k) : k === "used" ? U(r).v : k === "fpm" ? (U(r).v != null && r.price ? U(r).v / r.price : null) : k === "gap" ? (r.act != null && r.q != null ? r.act - r.q : null) : r[k];
    const usedCell = r => { const u = U(r); return u.out ? `<span class="dim">${u.est ? "out*" : "0"}</span>` : `<span class="${u.est ? "est" : ""}" title="${u.est ? "Your override, worked out on this page. Exact after the projection re-run." : ""}">${f1(u.v)}${u.est ? "*" : ""}</span>`; };
    function top5() {
      const ok = d.rows.filter(r => r.pool !== false).map(r => ({ r, u: U(r) })).filter(x => !x.u.out && x.u.v != null);
      const v = x => S.metric === "fp" ? x.u.v : (x.r.price ? x.u.v / x.r.price : null);
      document.getElementById("s-top5").innerHTML = ROLES.map(p => {
        const t = ok.filter(x => x.r.pos === p).sort((a, b) => v(b) - v(a)).slice(0, Number(S.n) || 5);
        return `<div class="col"><h3>${p}</h3><ol>${t.map((x, i) => `<li><a href="${x.r.id ? "#player-" + esc(x.r.id) : "#slate-" + esc(info.id)}"><span class="rk">${i + 1}</span><span class="nm">${esc(x.r.name)}<small>${esc(x.r.team)} · ${f1(x.r.price)}M${live && ovOf(x.r) ? " · yours" : ""}</small></span><span class="v">${S.metric === "fp" ? f1(v(x)) + (x.u.est ? "*" : "") : f2(v(x))}</span></a></li>`).join("") || '<li class="empty">—</li>'}</ol></div>`;
      }).join("");
    }
    function editor(r) {
      const o = ovOf(r) || {}, st = String(o.status ?? "").toLowerCase(), fp = o.fp ?? "";
      return `<tr class="ed"><td colspan="${cols.length}"><div class="editor" data-n="${esc(r.name)}">
        <p class="sub"><strong>${esc(r.name)}</strong> · Ours ${f1(r.q)} · ${f1(r.min)} min${r.news ? " · news: " + esc(r.news) : ""}</p>
        <label>Plays?<select data-f="status"><option value=""${st === "" ? " selected" : ""}>Model decides</option><option value="out"${st === "out" ? " selected" : ""}>Out</option><option value="in"${st === "in" ? " selected" : ""}>In (plays)</option></select></label>
        <label>FP<input type="number" inputmode="decimal" step="0.5" min="0" max="150" data-f="fp" value="${esc(fp)}" placeholder="${f1(r.q)}"></label>
        <label class="grow">Reason<input type="text" maxlength="200" data-f="reason" value="${esc(o.reason || "")}" placeholder="e.g. starts for Nunn (club site 14:10)"></label>
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
        if (a === "clear") { if (O.rows ? O.rows[n] : d.rows.find(r => r.name === n).ov) O.pend.set(n, null); else O.pend.delete(n); S.open = null; rows(); return; }
        const status = get("status"), fpS = get("fp"), reason = get("reason"), fp = fpS === "" ? "" : Number(fpS);
        if (status === "" && fp === "") { say("Set Out / In or a number, or press Remove."); return; }
        if (fp !== "" && (!isFinite(fp) || fp < 0 || fp > 150)) { say("FP must be a number from 0 to 150."); return; }
        if (status === "out" && fp !== "") { say("Out means 0 FP: leave FP blank."); return; }
        if (!reason) { say("Add a reason: every override is scored after the round."); return; }
        O.pend.set(n, { player: n, status, fp, reason });
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
        if (!isOpen(info)) { m.innerHTML = '<span class="down">Not saved:</span> lock has passed.'; return; }
        if (!GH.token()) { m.innerHTML = '<span class="down">Not saved:</span> no write-back token on this device. Add it on <a href="#settings">Settings</a> (your edits stay on this page until you leave it).'; return; }
        btn.disabled = true; m.textContent = "Saving…";
        // the repo file as base; if it could not be read, the overrides the last run applied
        const base = O.rows || Object.fromEntries(d.rows.filter(r => r.ov).map(r => [r.name, { player: r.name, status: r.ov.st || "", fp: r.ov.fp ?? "", reason: r.ov.why || "", saved_utc: "" }]));
        const merged = Object.assign({}, base), t = nowIso();
        O.pend.forEach((v, k) => { if (v === null) delete merged[k]; else merged[k] = Object.assign({}, v, { saved_utc: t }); });
        const list = Object.values(merged).sort((a, b) => a.player.localeCompare(b.player));
        try {
          O.sha = await GH.put(ovPath(info.folder), toCSV(OV_COLS, list), `insite: ${info.label} overrides (${list.length} players)`, O.sha);
          O.rows = merged; O.pend.clear(); O.err = null; rows();
          bar.hidden = false;
          bar.innerHTML = `<span class="up">Saved ${esc(t.slice(11, 16))}Z.</span> <span>${list.length} override${list.length === 1 ? "" : "s"} in slates/${esc(info.folder)}/overrides.csv. They count from the next projection run: Re-run now (top of page), or a pre-slate chat.</span>`;
        } catch (err) { btn.disabled = false; m.innerHTML = `<span class="down">Not saved:</span> ${esc(err.message)}`; }
      });
    }
    function bindPicks() {
      app.querySelectorAll("#s-tb .star-b").forEach(b => b.addEventListener("click", () => { const s = getShort(info), n = b.dataset.n; s.has(n) ? s.delete(n) : s.add(n); setShort(info, s); rows(); }));
      app.querySelectorAll("#s-tb .lk").forEach(b => b.addEventListener("click", () => { togglePick(info, b.dataset.n, b.dataset.a); rows(); }));
    }
    function shortBar() {
      const bar = document.getElementById("s-shbar"), sh = SH[info.id], P_ = getPicks(info), cur = getShort(info);
      const unsaved = sh && sh.can && !sameSet(cur, sh.names);
      const pk = `Shortlist ${cur.size} · locked ${P_.locks.length} · excluded ${P_.bans.length}`;
      if (!cur.size && !P_.locks.length && !P_.bans.length) { bar.hidden = true; bar.innerHTML = ""; return; }
      bar.hidden = false;
      bar.innerHTML = `<span>${pk}${P_.locks.length ? ' <span class="dim">· L: ' + esc(P_.locks.join(", ")) + "</span>" : ""}${P_.bans.length ? ' <span class="dim">· X: ' + esc(P_.bans.join(", ")) + "</span>" : ""}</span>`
        + (unsaved ? '<button type="button" class="primary" id="s-shsave">Save shortlist to repo</button><button type="button" id="s-shundo">Undo shortlist changes</button>' : "")
        + (P_.locks.length || P_.bans.length ? '<button type="button" id="s-pkclr">Clear locks and excludes</button>' : "")
        + `<span class="note" id="s-shmsg" role="status">${!info.folder ? "Shortlist: this device only." : !GH.token() ? 'Shortlist: this device · <a href="#settings">add token</a> to save it for the simulator.' : sh && sh.err ? "Shortlist: repo read failed." : unsaved ? "" : cur.size ? "Shortlist saved in repo." : ""} Locks / excludes: this device (Optimiser; Simulator fills them in).</span>`;
      const sv = document.getElementById("s-shsave");
      if (sv) sv.addEventListener("click", async () => { const m = document.getElementById("s-shmsg"); sv.disabled = true; m.textContent = "Saving…";
        try { await shortSave(info); rows(); } catch (e) { sv.disabled = false; m.innerHTML = `<span class="down">Not saved:</span> ${esc(e.message)}`; } });
      const un = document.getElementById("s-shundo"); if (un) un.addEventListener("click", () => { setShort(info, new Set(sh.names)); rows(); });
      const cl = document.getElementById("s-pkclr"); if (cl) cl.addEventListener("click", () => { const c = store.get(pickKey(info), {}); c.locks = []; c.bans = []; store.set(pickKey(info), c); rows(); });
    }
    function rows() {
      const q = S.q.trim().toLowerCase();
      const list = d.rows.filter(r => (!S.pool || r.pool !== false) && (!q || r.name.toLowerCase().includes(q)) && (!S.team || r.team === S.team) && (!S.role || r.pos === S.role))
        .sort((x, y) => { const u = val(x, S.sort), v = val(y, S.sort); if (u == null && v == null) return 0; if (u == null) return 1; if (v == null) return -1; return (typeof u === "string" ? u.localeCompare(v) : u - v) * S.dir; });
      document.getElementById("s-tb").innerHTML = list.map(r => {
        const o = live ? ovOf(r) : null, t = ovText(o), pend = O.pend.has(r.name);
        const you = !live ? "" : `<td class="you">${t ? `<span class="chip yours${pend ? " pend" : ""}" title="${esc((o && o.reason) || "")}">${esc(t)}</span>` : (pend ? '<span class="chip pend">removed</span>' : "")}${canEdit ? ` <button type="button" class="ed-b" data-n="${esc(r.name)}" aria-label="Override ${esc(r.name)}">✎</button>` : ""}</td>`;
        const P_ = getPicks(info), st = getShort(info).has(r.name), lk = P_.locks.includes(r.name), bn = P_.bans.includes(r.name);
        const pick = `<td class="lo pk"><button type="button" class="star-b" data-n="${esc(r.name)}" aria-pressed="${st}" aria-label="Shortlist ${esc(r.name)}">${st ? "★" : "☆"}</button><button type="button" class="lk" data-n="${esc(r.name)}" data-a="lock" aria-pressed="${lk}" title="Lock: in every lineup">L</button><button type="button" class="lk" data-n="${esc(r.name)}" data-a="ban" aria-pressed="${bn}" title="Exclude: in no lineup">X</button></td>`;
        const gp = pl(r, "gp"), av = pl(r, "avg"), l5 = pl(r, "l5");
        return `<tr class="${(live && U(r).out) || bn ? "off" : ""}"><td class="pl">${plink(r)}</td>${you}${pick}<td>${esc(r.team)}</td><td><span class="pos">${esc(r.pos)}</span></td>
        <td class="n">${f1(r.price)}</td><td class="n">${av != null ? f1(av) + ' <span class="dim">(' + gp + ")</span>" : '<span class="dim">—</span>'}</td><td class="n">${l5 != null ? f1(l5) : '<span class="dim">—</span>'}</td><td class="n">${f1(r.min)}</td><td class="n">${f1(r.model)}</td><td class="n">${r.mkt != null ? f1(r.mkt) : '<span class="dim">—</span>'}</td>
        <td class="n${live ? "" : " strong"}">${f1(r.q)}</td>${live ? `<td class="n strong">${usedCell(r)}</td>` : ""}<td class="n">${f2(val(r, "fpm"))}</td>
        <td class="why">${esc(r.news || "")}</td>
        ${res ? `<td class="n">${r.act != null ? f2(r.act) + ' <span class="dim">' + r.amin + "m</span>" : '<span class="dim">' + esc(r.dnp || "—") + "</span>"}</td><td class="n">${sgn(val(r, "gap"))}</td>` : ""}</tr>`
          + (canEdit && S.open === r.name ? editor(r) : "");
      }).join("");
      bindEditor(); bindPicks(); saveBar(); shortBar(); top5();
      document.getElementById("s-cnt").textContent = `showing ${list.length} of ${d.rows.length}`;
      app.querySelectorAll("thead th[data-k]").forEach(th => { if (th.dataset.k === S.sort) th.setAttribute("aria-sort", S.dir < 0 ? "descending" : "ascending"); else th.removeAttribute("aria-sort"); });
    }
    document.getElementById("s-pick").addEventListener("change", e => { location.hash = "slate-" + e.target.value; });
    const rr = document.getElementById("s-rerun");
    if (rr) rr.addEventListener("click", async () => {
      if (O.pend.size) { rr.insertAdjacentHTML("afterend", ' <span class="down">Save or discard your unsaved changes first.</span>'); return; }
      rr.disabled = true;
      try { const id = await simSend(info, { what: "proj" }); location.hash = "run-" + info.folder + "~" + id; }
      catch (e) { rr.disabled = false; rr.insertAdjacentHTML("afterend", ` <span class="down">Not sent: ${esc(e.message)}</span>`); }
    });
    const bind = (id, key, ev) => document.getElementById(id).addEventListener(ev || "input", e => { S[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value; saveS(); rows(); });
    bind("s-q", "q"); bind("s-team", "team", "change"); bind("s-role", "role", "change"); bind("s-pool", "pool", "change");
    app.querySelectorAll(".toggles .seg button").forEach(b => b.addEventListener("click", () => {
      const [k, v] = Object.entries(b.dataset)[0]; S[k] = v; saveS();
      app.querySelectorAll(`.toggles .seg button[data-${k}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[k] === v));
      document.getElementById("s-top-h").textContent = `Top ${S.n} by position`; top5();
    }));
    app.querySelectorAll("thead th button").forEach(b => b.addEventListener("click", () => {
      const k = b.parentElement.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = ["name", "team", "pos"].includes(k) ? 1 : -1; } saveS(); rows();
    }));
    rows(); window.scrollTo(0, 0);
  }

  /* ---------- Injuries (news log, scripts/news.py merge rules) ---------- */
  const IJ = Object.assign({ team: "", st: "" }, store.get("inj", {}));
  async function renderInjuries() {
    app.innerHTML = shell("injuries", "Injuries") + `<main class="wrap"><p class="loading">Loading news…</p></main>`;
    let J; try { J = await loadInj(); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load (${esc(e.message)}).</p>`; return; }
    if (location.hash !== "#injuries") return;
    const m = J.meta;
    if (!m) { app.querySelector("main").innerHTML = `<h1>Injuries</h1><p>${J.error ? "News build failed: " + esc(J.error) : "No news log rows yet."}</p>`; return; }
    const teams = [...new Set(J.rows.map(r => r.team))].sort();
    const facts = [["News round", m.round + (J.live ? "" : " (already played)")], ["Newest news", mt(m.newest_news) + " Malta"], ["Last read", mt(m.newest_read) + " Malta"],
      ["Out", J.rows.filter(r => r.st === "OUT").length], ["GTD", J.rows.filter(r => r.st === "GTD").length], ["Conflicts", J.rows.filter(r => r.conflict).length], ["Sources", m.sources.join(", ")]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    app.querySelector("main").innerHTML = `
      <section><div class="sec-head"><div><h1>Injuries</h1>
        <p class="sub">From the news log (scheduled news scan + Ryan's rows), merged by news.py: Ryan wins, then the official report, then tier 1, then tier 2. Conflict = another source disagrees on OUT within 48 h: check it.</p></div></div>
        <dl class="facts">${facts}</dl>
        ${J.live ? "" : `<p class="note warn-t">This news is for round ${m.round}, already played (box scores to round ${J.played_to}). Round ${J.played_to + 1} news appears after the next news scan.</p>`}
        <form class="filters" onsubmit="return false">
          <label>Team<select id="i-team"><option value="">All</option>${teams.map(t => `<option${t === IJ.team ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
          ${seg(IJ, "st", [["", "All"], ["OUT", "Out"], ["GTD", "GTD"], ["EXPECTED", "Expected"]])}</form></section>
      <section><div class="sec-head"><h2>Status by player</h2><span class="count" id="i-cnt"></span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Status</th><th class="n">Price</th><th class="n">Season (GP)</th><th>Source · time (Malta)</th></tr></thead><tbody id="i-tb"></tbody></table></div></section>
      <section><div class="sec-head"><div><h2>Changed in the newest scan</h2><p class="sub">Newest automatic run v everything known before it.</p></div></div>
        <div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Change</th></tr></thead><tbody>${J.changes.map(c => `<tr><td class="pl">${esc(c.name)}</td><td>${esc(c.team)}</td><td>${c.what === "new" ? "new: " + statusChip(c.new) : c.what === "dropped" ? "dropped (was " + esc(c.old) + ")" : esc(c.old) + " → " + statusChip(c.new)}</td></tr>`).join("") || '<tr><td colspan="3" class="dim">No automatic runs for this round yet.</td></tr>'}</tbody></table></div></section>`;
    function draw() {
      const list = J.rows.filter(r => (!IJ.team || r.team === IJ.team) && (!IJ.st || r.st === IJ.st))
        .sort((a, b) => a.team.localeCompare(b.team) || (a.st === "OUT" ? 0 : a.st === "GTD" ? 1 : 2) - (b.st === "OUT" ? 0 : b.st === "GTD" ? 1 : 2) || (b.price || 0) - (a.price || 0));
      document.getElementById("i-tb").innerHTML = list.map(r => `<tr><td class="pl">${plink(r)}</td><td>${esc(r.team)}</td><td>${statusChip(r.st)}${r.conflict ? ' <span class="chip dtd">conflict</span>' : ""}</td>
        <td class="n">${f1(r.price)}</td><td class="n">${r.gp ? f1(r.avg) + ' <span class="dim">(' + r.gp + ")</span>" : '<span class="dim">—</span>'}</td><td class="why"><details><summary>${esc(r.src)} · ${esc(mt(r.t))}</summary>${esc(r.note)}</details></td></tr>`).join("") || '<tr><td colspan="6" class="dim">Nobody for this choice.</td></tr>';
      document.getElementById("i-cnt").textContent = `${list.length} shown`;
    }
    app.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
      IJ.st = b.dataset.st; store.set("inj", { st: IJ.st }); app.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", x.dataset.st === IJ.st)); draw();
    }));
    document.getElementById("i-team").addEventListener("change", e => { IJ.team = e.target.value; draw(); });
    draw(); window.scrollTo(0, 0);
  }

  /* ---------- Matrix (P5b): price v Used FP on one slate, fair-price line, shortlist ---------- */
  const M = Object.assign({ slate: "", role: "All", view: "all" }, store.get("matrix", {}), { shown: [] });
  const saveM = () => store.set("matrix", { slate: M.slate, role: M.role, view: M.view });
  const ENDS = 20;     // 'Top 20 + worst 20' view (6a)
  function fit(pts) {   // least squares FP = a + b x price
    const n = pts.length, mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    pts.forEach(p => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; });
    const b = sxx ? sxy / sxx : 0;
    return { a: my - b * mx, b, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0 };
  }
  window.INSITE_FIT = fit;    // for tests
  const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const nice = (lo, hi, n) => { const raw = (hi - lo) / n || 1, p = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw); const out = []; for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) out.push(+v.toFixed(6)); return out; };

  async function renderMatrix() {
    await loadSlates();
    if (!SLATES.length) { app.innerHTML = shell("matrix", "Matrix") + `<main class="wrap"><p>No slates yet.</p></main>`; return; }
    if (!M.seen) { const lv = SLATES.find(isOpen); if (lv) M.slate = lv.id; M.seen = true; }    // an open live slate first, once per page load
    if (!byId(M.slate)) M.slate = current().id;
    const info = byId(M.slate), live = isLive(info);
    const d = await loadSlate(info.id), O = await ovrLoad(info);
    let pts = d.rows.filter(r => r.pool !== false && r.price).map(r => ({ r, o: ovIn(O, r) })).map(z => Object.assign(z, { u: usedFP(z.r, z.o, live) }))
      .filter(z => !z.u.out && z.u.v != null).map(z => ({ id: z.r.id, name: z.r.name, team: z.r.team, pos: z.r.pos, x: z.r.price, y: z.u.v, est: z.u.est, yours: live && !!z.o }));
    if (M.role !== "All") pts = pts.filter(p => p.pos === M.role);
    const short = await shortLoad(info), sh = SH[info.id];
    const unsaved = sh.can && !sameSet(short, sh.names);
    const shNote = !info.folder ? "this device only (slate has no folder in the repo)" : !GH.token() ? `this device · <a href="#settings">add token</a> to save` : sh.err ? "repo read failed" : unsaved ? "not saved" : "saved in repo";
    app.innerHTML = shell("matrix", "Matrix") + `<main class="wrap">
      <section><div class="sec-head"><div><h1>Price v projection</h1><p class="sub">${esc(info.label)} at that contest's prices. FanTeam pool players with ${live ? "Used FP above 0 (your override, else Ours; * = override not re-run yet)" : "Ours above 0 (frozen)"}. High FP at a low price sits top right. Tap a dot to show the name.</p></div></div>
        <div class="toggles">${pickSlate(info, "m-slate")}${seg(M, "role", ["All"].concat(ROLES).map(r => [r, r]))}${seg(M, "view", [["all", "All players"], ["ends", `Top ${ENDS} + worst ${ENDS} value`]])}</div></section>
      <section id="m-body"></section></main>`;
    const body = document.getElementById("m-body");
    if (pts.length < 3) body.innerHTML = '<p class="empty">Too few players with a projection here to fit a line.</p>';
    else {
      const f = fit(pts);
      pts.forEach(p => { p.fair = f.a + f.b * p.x; p.gap = p.y - p.fair; });
      const nAll = pts.length, byGap = pts.slice().sort((a, b) => b.gap - a.gap);
      const best = byGap.slice(0, ENDS), worst = byGap.slice(-ENDS).reverse().filter(p => !best.includes(p));
      if (M.view === "ends") pts = best.concat(worst.slice().reverse());   // line and medians stay fitted on all players
      const mp = median(byGap.map(p => p.x)), mf = median(byGap.map(p => p.y));
      const sm = window.innerWidth < 640, W = sm ? 380 : 720, Ht = sm ? 340 : 440, L = 38, Rr = 10, T = 12, Bt = 40;
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
      const dots = pts.slice().sort((a, b) => a.gap - b.gap).map(p => {
        const on = M.shown.includes(p.name), st = short.has(p.name), cx = X(p.x), cy = Y(p.y), right = cx > W * 0.55;
        return `<g class="pt${p.gap >= 0 ? " above" : ""}${st ? " star" : ""}" data-n="${esc(p.name)}" tabindex="0" role="button" aria-label="${esc(p.name)}, ${f1(p.x)}M, ${f1(p.y)} FP">
          <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${st ? 6 : 4.6}"/><circle class="hit" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="11"/>
          ${on ? `<text class="lbl" x="${(cx + (right ? -9 : 9)).toFixed(1)}" y="${(cy - 7).toFixed(1)}" text-anchor="${right ? "end" : "start"}">${esc(p.name)} · ${f1(p.x)}M · ${f1(p.y)}${p.est ? "*" : ""}</text>` : ""}</g>`;
      }).join("");
      const top = M.view === "ends" ? best : pts.filter(p => p.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 12);
      const shortList = pts.filter(p => short.has(p.name)).sort((a, b) => b.gap - a.gap);
      const item = p => `<li><button type="button" class="star-b" data-n="${esc(p.name)}" aria-pressed="${short.has(p.name)}" aria-label="Shortlist ${esc(p.name)}">${short.has(p.name) ? "★" : "☆"}</button>
        <span class="nm">${p.id ? `<a href="#player-${esc(p.id)}">${esc(p.name)}</a>` : esc(p.name)}<small>${esc(p.pos)} · ${esc(p.team)} · ${f1(p.x)}M · ${f1(p.y)}${p.est ? "*" : ""} FP${p.yours ? " · yours" : ""}</small></span><span class="v ${p.gap >= 0 ? "up" : "down"}">${p.gap >= 0 ? "+" : ""}${f1(p.gap)}</span></li>`;
      body.innerHTML = `<div class="mx">
        <figure class="chart mx-chart"><h3>${live ? "Used FP" : "Ours (frozen)"}<small>${M.view === "ends" ? `${pts.length} of ${nAll} shown (best and worst ${ENDS} by gap to the line; line fitted on all)` : `${nAll} players`} · r ${f.r.toFixed(2)} · ${f1(f.b)} FP per 1M</small></h3>
          <svg viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Price against projection, ${pts.length} players">${grid}${quad}${fl}${dots}</svg>
          <p class="legend"><span><span class="k fitk"></span>fair-price line (fit)</span><span><span class="k medk"></span>median price / median FP</span><span><span class="k dk a"></span>above the line</span><span><span class="k dk"></span>below</span><span><span class="k dk s"></span>shortlisted</span></p></figure>
        <div class="mx-side">
          <div class="col"><h3>Best value<small>${M.view === "ends" ? `top ${ENDS} by FP above the line` : "FP above the line"}</small></h3><ol>${top.map(item).join("") || '<li class="empty">Nobody above the line.</li>'}</ol></div>
          ${M.view === "ends" ? `<div class="col"><h3>Worst value<small>${worst.length} furthest below the line</small></h3><ol>${worst.map(item).join("") || '<li class="empty">—</li>'}</ol></div>` : ""}
          <div class="col"><h3>Shortlist<small>${short.size} · ${shNote}</small></h3><ol>${shortList.map(item).join("") || `<li class="empty">${short.size ? "No shortlisted player in this view (position filter)." : "Tap ☆ to shortlist."}</li>`}</ol>
            ${unsaved ? '<div class="savebar in-col"><button type="button" class="primary" id="m-save">Save shortlist to repo</button><button type="button" id="m-undo">Undo changes</button><span class="note" id="m-msg" role="status"></span></div>' : ""}
            ${sh.err ? `<p class="note warn-t">${esc(sh.err)}</p>` : ""}</div>
        </div></div>
        <p class="note">Price explains most of the projection (r = correlation, 1.00 = price explains it all), so the quadrants alone say little. The gap to the fair-price line is the signal; the line is refitted for the position shown. It is a flag, not a pick: a cheap player above the line is often a minutes guess. Overrides are set on the Slate page (✎). The shortlist feeds the Optimiser ('Shortlist only') and daily_sim.py (mode 'shortlist').</p>`;
      body.querySelectorAll("g.pt").forEach(g => { const tog = () => { const n = g.dataset.n, i = M.shown.indexOf(n); if (i >= 0) M.shown.splice(i, 1); else M.shown.push(n); renderMatrix(); };
        g.addEventListener("click", tog); g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tog(); } }); });
      body.querySelectorAll(".star-b").forEach(b => b.addEventListener("click", () => { const s = getShort(info), n = b.dataset.n; s.has(n) ? s.delete(n) : s.add(n); setShort(info, s); renderMatrix(); }));
      const sv = document.getElementById("m-save");
      if (sv) sv.addEventListener("click", async () => {
        const m = document.getElementById("m-msg"); sv.disabled = true; m.textContent = "Saving…";
        try { await shortSave(info); renderMatrix(); } catch (e) { sv.disabled = false; m.innerHTML = `<span class="down">Not saved:</span> ${esc(e.message)}`; }
      });
      const un = document.getElementById("m-undo");
      if (un) un.addEventListener("click", () => { setShort(info, new Set(sh.names)); renderMatrix(); });
    }
    app.querySelectorAll(".toggles .seg button").forEach(b => b.addEventListener("click", () => { const [k, v] = Object.entries(b.dataset)[0]; M[k] = v; M.shown = []; saveM(); renderMatrix(); }));
    document.getElementById("m-slate").addEventListener("change", e => { M.slate = e.target.value; M.shown = []; saveM(); renderMatrix(); });
  }

  /* ---------- Optimiser (P5b) ----------
     Exact best lineups by mean Used FP (override else Ours; frozen slates: Ours) for the four EuroLeague formats in
     site/opt.js (METHOD.md contest formats). Mean only: no spread, no field, so it is a planning view, not a cash or
     top-1% pick (the Simulator ranks for that: daily_sim.py). */
  const OP = Object.assign({ slate: "", pool: "all", rows: "all" }, store.get("opt", {}), { q: "" });
  const saveOP = () => store.set("opt", { slate: OP.slate, pool: OP.pool, rows: OP.rows });
  async function renderOpt(id) {
    await loadSlates();
    if (!SLATES.length) { app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap"><p>No slates yet.</p></main>`; return; }
    if (id && !byId(id)) { app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap"><p>No slate "${esc(id)}". <a href="#opt">Current slate</a></p></main>`; return; }
    const info = (id && byId(id)) || SLATES.find(isOpen) || (OP.slate && byId(OP.slate)) || SLATES[0];
    OP.slate = info.id; saveOP();
    app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap"><p class="loading">Loading ${esc(info.label)}…</p></main>`;
    let d; try { d = await loadSlate(info.id); } catch (e) { app.querySelector("main").innerHTML = `<p>Could not load (${esc(e.message)}).</p>`; return; }
    const live = isLive(info), res = info.results, OPT = window.INSITE_OPT, F = OPT.FORMATS;
    const O = await ovrLoad(info), short = await shortLoad(info);
    const games = info.games || [];
    const sk = "opt." + info.id;
    const dflt = fmt => ({ fmt, budget: (fmt === (info.ofmt || "classic") && info.cap) ? info.cap : (F[fmt].budget ?? ""), maxTeam: F[fmt].maxTeam, cm: 1.5, vm: 1.2 });
    const C = Object.assign(dflt(info.ofmt || "classic"), { topN: 10, games: games.slice(), locks: [], bans: [] }, store.get(sk, {}));
    if (!F[C.fmt]) Object.assign(C, dflt("classic"));
    C.games = C.games.filter(g => games.includes(g)); if (!C.games.length) C.games = games.slice();
    const saveC = () => store.set(sk, C);
    const all = d.rows.filter(r => r.pool !== false).map(r => { const o = ovIn(O, r); return { r, o, u: usedFP(r, o, live) }; }).filter(z => !z.u.out && z.u.v != null && z.r.price);
    const cap = () => !!F[C.fmt].captain;
    const facts = [["Contest", info.contest], ["Date", dshort(info.date)], ["Slate format", fmtText(info) || "—"],
      ["Cap", info.cap ? info.cap + "M" : "—"], ["Usable", `${all.length} of ${d.rows.length}`], ["Shortlist", short.size]]
      .concat(isOpen(info) ? [["Lock", info.lock_malta + " Malta"]] : []).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    const num = (id, l, v, st, mn, mx) => `<label>${l}<input type="number" inputmode="decimal" id="${id}" value="${esc(v)}" step="${st}" min="${mn}" max="${mx}"></label>`;
    app.innerHTML = shell("opt", "Optimiser") + `<main class="wrap">
      <section><div class="sec-head"><div><h1>Optimiser</h1>
        <p class="sub">Best lineups by mean ${live ? "Used FP (your override, else Ours)" : "Ours (frozen)"}. Exact: every lineup that could make the list is checked. Mean only: no spread, no field, so this is a planning view, not a cash or top-1% pick. The suggested entries (Slate page) come from the simulator.</p></div>
        ${pickSlate(info, "o-pick")}</div>
        <dl class="facts">${facts}</dl>
        ${O.err ? `<p class="note warn-t">Could not read saved overrides: ${esc(O.err)} Using the overrides the last run applied.</p>` : ""}
        ${res ? `<p class="note">Box scores are in: lineups show their actual score (captain multipliers applied; a DNP counts 0 here, FanTeam's auto-sub is not applied).</p>` : ""}</section>
      <section><div class="sec-head"><div><h2>Settings</h2><p class="sub">Saved on this device for this slate. Lock = in every lineup; Out = left out. Same lists as Pick L / X on the Slate page.</p></div></div>
        <form class="filters" onsubmit="return false">
          <label>Format<select id="o-fmt">${Object.entries(F).map(([k, f]) => `<option value="${k}"${k === C.fmt ? " selected" : ""}>${esc(f.label)}</option>`).join("")}</select></label>
          ${num("o-budget", "Budget (M)", C.budget, 0.5, 0, 200)}${num("o-mt", "Max per team", C.maxTeam, 1, 1, 9)}${num("o-top", "Show top", C.topN, 1, 1, 50)}
          ${cap() ? num("o-cm", "Captain ×", C.cm, 0.1, 1, 3) + num("o-vm", "Vice ×", C.vm, 0.1, 1, 3) : ""}
          <div class="seg" role="group" aria-label="Players">${[["all", "All usable"], ["short", "Shortlist only"]].map(([v, l]) => `<button type="button" data-pool="${v}" aria-pressed="${OP.pool === v}">${l}</button>`).join("")}</div>
          ${cap() ? `<div class="seg" role="group" aria-label="Rows">${[["all", "Every C/VC"], ["squad", "Best C/VC per squad"]].map(([v, l]) => `<button type="button" data-rows="${v}" aria-pressed="${OP.rows === v}">${l}</button>`).join("")}</div>` : ""}
        </form>
        ${C.fmt === "any6" ? '<p class="note warn-t">6-player any-position contest: budget and team cap not confirmed (METHOD F2). Set them from the contest screen.</p>' : ""}
        ${C.fmt === "monthly" ? '<p class="note">Monthly: one night\'s pool and prices only. The monthly contest has fixed prices and sums 7 gameweeks: use its own pool.</p>' : ""}
        ${games.length > 1 ? `<div class="games" role="group" aria-label="Games">${games.map(g => `<label class="chk"><input type="checkbox" data-g="${esc(g)}"${C.games.includes(g) ? " checked" : ""}> ${esc(g)}</label>`).join("")}</div>` : ""}
      </section>
      <section><div class="sec-head"><div><h2>Best lineups</h2><p class="sub" id="o-msg"></p></div></div><div id="o-res"></div></section>
      <section><div class="sec-head"><div><h2>Pool</h2><p class="sub">Players in the chosen games${OP.pool === "short" ? " on your shortlist (Matrix ☆)" : ""}, by FP. * = override not re-run yet.</p></div><span class="count" id="o-cnt"></span></div>
        <form class="filters" onsubmit="return false"><label class="grow">Search<input type="search" id="o-q" placeholder="Player name" value=""></label>
          <button type="button" id="o-clear">Clear locks and outs</button></form>
        <div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Pos</th><th class="n">Price</th><th class="n">FP</th><th class="n">FP/M</th><th>Lock / Out</th>${res ? '<th class="n">Actual</th>' : ""}</tr></thead><tbody id="o-tb"></tbody></table></div></section></main>`;

    const inGames = z => !games.length || !z.r.g || C.games.includes(z.r.g);
    const pool = () => all.filter(z => inGames(z) && (OP.pool !== "short" || short.has(z.r.name)));
    const byName = new Map(d.rows.map(r => [r.name, r]));
    const est = n => { const z = all.find(x => x.r.name === n); return z && z.u.est ? "*" : ""; };
    function run() {
      const P = pool(), players = P.map(z => ({ name: z.r.name, team: z.r.team, pos: z.r.pos, price: z.r.price, fp: z.u.v })), names = new Set(players.map(p => p.name));
      const lockOff = C.locks.filter(n => !names.has(n));
      const R = OPT.optimise({ format: C.fmt, players, budget: Number(C.budget), maxTeam: Number(C.maxTeam), topN: Number(C.topN),
        cm: Number(C.cm), vm: Number(C.vm), locks: C.locks.filter(n => names.has(n)), bans: C.bans, perSquad: OP.rows === "squad" });
      document.getElementById("o-msg").innerHTML = `${players.length} players · ${esc(F[C.fmt].label)} · ${R.exact ? "exact" : '<span class="down">stopped early: not guaranteed best</span>'} · ${R.ms ?? 0} ms`
        + (lockOff.length ? ` · <span class="down">locked but not in this pool: ${esc(lockOff.join(", "))}</span>` : "")
        + (OP.pool === "short" && !short.size ? ' · <span class="down">shortlist is empty: star players on the Matrix</span>' : "");
      const el = document.getElementById("o-res");
      if (!R.lineups.length) { el.innerHTML = `<p class="empty">${esc(R.error || "No lineup.")}</p>`; return; }
      const mult = s => s.slot === "C" ? Number(C.cm) : s.slot === "VC" ? Number(C.vm) : 1;
      const act = l => res ? l.slots.reduce((t, s) => { const r = byName.get(s.name); return t + (r && r.act != null ? r.act : 0) * mult(s); }, 0) : null;
      el.innerHTML = `<div class="tbl-wrap"><table class="opt"><thead><tr><th class="n">#</th><th class="n">Mean FP</th>${res ? '<th class="n">Actual</th>' : ""}<th>Lineup</th><th class="n">Cost</th><th class="n">Left</th><th>Teams</th></tr></thead><tbody>
        ${R.lineups.map(l => `<tr><td class="n">${l.rank}</td><td class="n strong">${f1(l.fp)}</td>${res ? `<td class="n">${f2(act(l))}</td>` : ""}
          <td class="why">${l.slots.map(s => `${s.slot ? `<span class="pos">${esc(s.slot === "FLEX" ? "F" : s.slot)}</span> ` : ""}${esc(s.name)}${est(s.name)} <span class="dim">${f1(s.fp)}</span>`).join(" · ")}</td>
          <td class="n">${f2(l.cost)}</td><td class="n">${f2(l.left)}</td><td class="dim">${esc(l.teams)}</td></tr>`).join("")}</tbody></table></div>
        <p class="note">F = flex (any position). Ties on mean FP: more budget left first.${cap() ? " Captain and Vice cost and score their multiplier." : ""} The best mean lineup is rarely the best entry in a big field: check ownership and the simulator before entering.</p>
        ${exposure(R.lineups)}`;
      bindExpo();
    }
    function exposure(L) {    // 6a: every player in the lineups shown, how many of them he is in
      const cnt = new Map(), cc = new Map();
      L.forEach(l => l.slots.forEach(s => { cnt.set(s.name, (cnt.get(s.name) || 0) + 1); if (s.slot === "C") cc.set(s.name, (cc.get(s.name) || 0) + 1); }));
      const rows_ = [...cnt.entries()].map(([n, c]) => ({ n, c, z: all.find(x => x.r.name === n) })).sort((a, b) => b.c - a.c || (b.z ? b.z.u.v : 0) - (a.z ? a.z.u.v : 0));
      const lk = n => C.locks.includes(n);
      return `<h3 class="sub-h">Players in these ${L.length} lineups</h3><div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Pos</th><th class="n">Price</th><th class="n">FP</th><th class="n">In</th><th class="n">Share</th>${cap() ? '<th class="n">As C</th>' : ""}<th>Lock / Out</th></tr></thead><tbody>
        ${rows_.map(x => { const r = x.z ? x.z.r : byName.get(x.n) || { name: x.n }; return `<tr><td class="pl">${plink(r)}</td><td>${esc(r.team || "")}</td><td><span class="pos">${esc(r.pos || "")}</span></td>
          <td class="n">${f1(r.price)}</td><td class="n">${x.z ? f1(x.z.u.v) + (x.z.u.est ? "*" : "") : "—"}</td><td class="n strong">${x.c}</td><td class="n">${Math.round(100 * x.c / L.length)}%</td>${cap() ? `<td class="n">${cc.get(x.n) || ""}</td>` : ""}
          <td class="lo"><button type="button" class="lk" data-n="${esc(x.n)}" data-a="lock" aria-pressed="${lk(x.n)}">Lock</button><button type="button" class="lk" data-n="${esc(x.n)}" data-a="ban" aria-pressed="false">Out</button></td></tr>`; }).join("")}</tbody></table></div>
        <p class="note">${rows_.length} different players. A player in every lineup is a core pick on mean FP; one in a single lineup is a fringe call.</p>`;
    }
    function bindExpo() { document.querySelectorAll("#o-res .lk").forEach(b => b.addEventListener("click", () => flip(b.dataset.n, b.dataset.a))); }
    function flip(n, a) { const on = a === "lock" ? C.locks : C.bans, off = a === "lock" ? C.bans : C.locks;
      const i = on.indexOf(n); if (i >= 0) on.splice(i, 1); else { on.push(n); const j = off.indexOf(n); if (j >= 0) off.splice(j, 1); }
      saveC(); table(); run(); }
    function table() {
      const q = OP.q.trim().toLowerCase();
      const P = pool().filter(z => !q || z.r.name.toLowerCase().includes(q)).sort((a, b) => b.u.v - a.u.v);
      const banned = all.filter(z => C.bans.includes(z.r.name) && inGames(z) && !P.includes(z));
      document.getElementById("o-tb").innerHTML = P.map(z => { const n = z.r.name, lk = C.locks.includes(n), bn = C.bans.includes(n);
        return `<tr class="${bn ? "off" : ""}"><td class="pl">${plink(z.r)}${live && z.o ? ' <span class="chip yours">yours</span>' : ""}</td><td>${esc(z.r.team)}</td><td><span class="pos">${esc(z.r.pos)}</span></td>
          <td class="n">${f1(z.r.price)}</td><td class="n strong">${f1(z.u.v)}${z.u.est ? "*" : ""}</td><td class="n">${f2(z.u.v / z.r.price)}</td>
          <td class="lo"><button type="button" class="lk" data-n="${esc(n)}" data-a="lock" aria-pressed="${lk}">Lock</button><button type="button" class="lk" data-n="${esc(n)}" data-a="ban" aria-pressed="${bn}">Out</button></td>
          ${res ? `<td class="n">${z.r.act != null ? f2(z.r.act) : '<span class="dim">' + esc(z.r.dnp || "—") + "</span>"}</td>` : ""}</tr>`; }).join("")
        || `<tr><td colspan="8" class="dim">${OP.pool === "short" ? "No shortlisted player in these games." : "Nobody usable in these games."}</td></tr>`;
      document.getElementById("o-cnt").textContent = `${P.length} players` + (banned.length ? ` · ${banned.length} out not shown` : "");
      document.querySelectorAll("#o-tb .lk").forEach(b => b.addEventListener("click", () => flip(b.dataset.n, b.dataset.a)));
    }
    document.getElementById("o-fmt").addEventListener("change", e => { Object.assign(C, dflt(e.target.value)); C.locks = C.locks.slice(); saveC(); renderOpt(info.id); });
    [["o-budget", "budget"], ["o-mt", "maxTeam"], ["o-top", "topN"], ["o-cm", "cm"], ["o-vm", "vm"]].forEach(([i, k]) => { const x = document.getElementById(i); if (x) x.addEventListener("change", e => { const v = e.target.value; if (v === "" || !isFinite(Number(v))) return; C[k] = Number(v); saveC(); run(); }); });
    app.querySelectorAll("form .seg button").forEach(b => b.addEventListener("click", () => {
      const [k, v] = Object.entries(b.dataset)[0]; OP[k] = v; saveOP();
      app.querySelectorAll(`.seg button[data-${k}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[k] === v));
      table(); run();
    }));
    app.querySelectorAll("input[data-g]").forEach(c => c.addEventListener("change", () => { C.games = [...app.querySelectorAll("input[data-g]:checked")].map(x => x.dataset.g); saveC(); table(); run(); }));
    document.getElementById("o-q").addEventListener("input", e => { OP.q = e.target.value; table(); });
    document.getElementById("o-clear").addEventListener("click", () => { C.locks = []; C.bans = []; saveC(); table(); run(); });
    document.getElementById("o-pick").addEventListener("change", e => { location.hash = "opt-" + e.target.value; });
    table(); run(); window.scrollTo(0, 0);
  }

  /* ---------- Simulator + Re-run now (P5c) ----------
     A run = one request file slates/<folder>/runs/<id>/request.json. Its push starts the `sim` Action, which runs
     scripts/run_slate_request.py (news.py merge -> daily_proj.py with overrides.csv -> daily_sim.py --extra <settings>),
     commits result.json and the slate's new projection / entries, then rebuilds this site. Never freezes. Refused after
     lock (page and runner both check). Settings below count for that run only: slate.json is not edited. */
  const RULE_TXT = { sim_mean: "Sim mean (the rule in use since 17 Oct)", p_cash_field: "P(cash)", eur: "Expected EUR (not proven here)", pick3: "pick3, NBA rule (not proven here)" };
  const RULE_TXT_M = { p_target: "P(GW score ≥ your target)", sim_mean: "Sim mean (best average squad)" };   // monthly GW: no field
  const ruleTxt = r => RULE_TXT[r] || RULE_TXT_M[r] || r;
  const runnable = s => !!(s.folder && s.run && s.run.lock_utc && Date.now() < Date.parse(s.run.lock_utc));
  const runDir = folder => "slates/" + folder + "/runs";
  const runId = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) + "-" + Math.random().toString(36).slice(2, 5);   // suffix: two runs in one second never share a folder
  const whenId = id => { const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id); return m ? mt(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : id; };
  const idMs = id => { const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.now(); };
  const pct = (v, d) => v == null ? "—" : (v * 100).toFixed(d || 0) + "%";
  const eurS = v => v == null ? "—" : "€" + Number(v).toFixed(2);
  const names = t => [...new Set(String(t || "").split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))];

  async function simSend(info, body) {     // -> id. One commit: the request file. Throws with a plain message.
    if (!GH.token()) throw new Error("no write-back token on this device (Settings)");
    if (!runnable(info)) throw new Error("lock has passed (or the slate has no lock time): nothing can be run");
    const id = runId();
    const req = Object.assign({ id, created_utc: nowIso(), what: "sim", merge_news: true, by: "insite" }, body);
    await GH.put(runDir(info.folder) + "/" + id + "/request.json", JSON.stringify(req, null, 1) + "\n",
      `insite run ${id}: ${info.label} (${req.what === "proj" ? "projection" : "projection + simulator"})`);
    return id;
  }
  window.INSITE_SIM = { runnable, runId, names, idMs };    // for tests

  const SIMR = {};    // folder -> {list, err, res: {id: result}}
  let RT = 0;         // render token: a newer Simulator / run render (e.g. a hash change during the first load) wins
  async function runsOf(folder, fresh) {
    const R = SIMR[folder] || (SIMR[folder] = { list: null, err: null, res: {} });
    if (R.list && !fresh) return R;
    try { R.list = (await GH.list(runDir(folder))).filter(x => x.type === "dir" && /^\d{8}-\d{6}/.test(x.name)).map(x => x.name).sort().reverse(); R.err = null; }
    catch (e) { R.list = []; R.err = e.message; }
    await Promise.all(R.list.slice(0, 8).filter(id => !R.res[id]).map(id => GH.json(runDir(folder) + "/" + id + "/result.json").then(x => { if (x) R.res[id] = x; }).catch(() => {})));
    return R;
  }

  async function renderSim(want) {
    const tok = ++RT;
    await loadSlates();
    if (tok !== RT) return;
    const open = SLATES.filter(runnable);
    app.innerHTML = shell("sim", "Simulator") + `<main class="wrap"><p class="loading">Loading…</p></main>`;
    const main = app.querySelector("main");
    const intro = `<h1>Simulator</h1><p class="sub">Re-runs the projection (with your saved overrides and the newest news) and the simulator on GitHub: the same code as a pre-slate chat, about 2 minutes. It never freezes: the frozen file (what is scored) stays a chat step.</p>`;
    if (!open.length) {
      main.innerHTML = `<section>${intro}<p class="panel">No slate is open for a run. A slate is open when a pre-slate chat has set up its folder (slate.json, pool, first projection run) and its lock has not passed. ${SLATES.some(s => s.folder) ? "" : "No slate folder exists yet this round."}</p></section>`;
      return;
    }
    if (!GH.token()) { main.innerHTML = `<section>${intro}<p class="panel">Runs are saved to the private repo euroleague-dfs, so the page needs the write-back token on this device: <a href="#settings">Settings</a>.</p></section>`; return; }
    const info = (want && open.find(s => s.folder === want)) || open[0], run = info.run, fmt = run.sim_fmt || "classic";
    const sk = "sim." + info.folder, D = Object.assign({ what: "sim", merge: true, lock: "", ban: "" }, run.sim, store.get(sk, {}));
    const PK = getPicks(info);
    if (!String(D.lock || "").trim() && !String(D.ban || "").trim() && (PK.locks.length || PK.bans.length)) { D.lock = PK.locks.join("\n"); D.ban = PK.bans.join("\n"); }   // 6a: Slate / Optimiser lists by default
    const mon = fmt === "monthly", RT_ = mon ? RULE_TXT_M : RULE_TXT;
    if (!(D.entry_rule in RT_)) D.entry_rule = mon ? "p_target" : "sim_mean";
    const autoNews = /_team_news_auto\.csv$/.test(run.news_file || "");
    const short = await shortLoad(info), O = await ovrLoad(info);
    if (tok !== RT) return;
    const nOv = O.rows ? Object.keys(O.rows).length : null;
    const facts = [["Contest", info.contest], ["Format", fmt], ["Lock", run.lock_malta + " Malta"], ["Last projection run", run.ran ? run.ran + " Malta" : "—"],
      ["Overrides saved", nOv == null ? "—" : nOv], ["Shortlist", short.size], ["News file", (run.news_file || "none").split("/").pop()]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    const num = (id, l, v, st, mn, mx, ph) => `<label>${l}<input type="number" inputmode="decimal" id="${id}" value="${esc(v ?? "")}" step="${st}" min="${mn}" max="${mx}"${ph ? ` placeholder="${esc(ph)}"` : ""}></label>`;
    main.innerHTML = `<section><div class="sec-head"><div>${intro}</div>${open.length > 1 ? `<label class="pick">Slate<select id="r-pick">${open.map(s => `<option value="${esc(s.folder)}"${s.folder === info.folder ? " selected" : ""}>${esc(sLabel(s))}</option>`).join("")}</select></label>` : ""}</div>
        <dl class="facts">${facts}</dl>
        ${info.kind === "frozen" ? '<p class="note warn-t">This slate is already frozen. A run updates the live projection and the entries, not the frozen file (that is what gets scored).</p>' : ""}
        ${O.err ? `<p class="note warn-t">Could not read saved overrides: ${esc(O.err)}</p>` : ""}</section>
      <section><form id="r-f" class="panel sim-form" onsubmit="return false">
        <div class="filters">${seg(D, "what", [["sim", "Projection + simulator"], ["proj", "Projection only"]])}
          <label class="chk"><input type="checkbox" id="r-merge"${D.merge && autoNews ? " checked" : ""}${autoNews ? "" : " disabled"}> Re-merge the news log first${autoNews ? "" : " (slate uses a fixed news file)"}</label></div>
        <div id="r-simf"${D.what === "proj" ? " hidden" : ""}>
          <div class="filters">${num("r-k", "Entries", D.n_entries, 1, 1, 20)}
            <label>Entry rule<select id="r-rule">${Object.entries(RT_).map(([k, l]) => `<option value="${k}"${k === D.entry_rule ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
            ${mon ? num("r-tg", "Target GW score (yours)", D.target, 1, 50, 400, "230")
              : num("r-fs", "Field size", D.field_size, 1, 10, 100000) + num("r-bi", "Buy-in (€)", D.buy_in, 0.01, 0, 1000) + num("r-tg", "Cash line guess", D.target, 1, 50, 400, "170")}
            ${num("r-mx", "Max entries per player", D.max_exposure, 1, 1, 20, "60% of entries")}${num("r-ms", "Max shared players", D.max_shared, 1, 0, mon ? 8 : 7, "4")}</div>
          <fieldset class="sim-rules"><legend>Players (${mon ? "your squads" : "your entries only; the simulated field uses the full pool"})</legend>
            <div class="filters">${seg(D, "mode", [["full", "Full pool"], ["shortlist", `Shortlist only (${short.size})`]])}<button type="button" id="r-optcopy">Copy Slate / Optimiser locks and excludes</button></div>
            <label class="grow">Lock (in every entry)<textarea id="r-lock" rows="2" placeholder="Names, one per line or comma separated">${esc(D.lock)}</textarea></label>
            <label class="grow">Ban (in no entry)<textarea id="r-ban" rows="2" placeholder="Names">${esc(D.ban)}</textarea></label>
            ${fmt === "captain" ? '<p class="note warn-t">Captain slate: lock, ban and shortlist are not supported by the captain simulator yet (ignored, and said so in the result).</p>' : ""}
            <p class="note">Plays / does not play and FP calls are overrides (Slate page ✎): they change the projection. Lock / ban only change which lineups you get.</p></fieldset></div>
        ${mon ? '<p class="note">Monthly GW: the whole round as one slate at the fixed monthly prices (9 players, 2/2/2/2/1, 100M, max 3 per team). The monthly pays on the month total, so there is no GW field: the run gives each squad its average, its range (p10 to p90) and the chance of reaching your target. Set the target from the standings gap you need to close. Auto-subs = the safety net (same position, same price or lower).</p>' : ""}
        <div class="filters"><button type="button" id="r-run" class="primary">Run on GitHub</button></div>
        <p id="r-msg" class="note" role="status"></p>
        <p class="note">Settings here count for this run only (slate.json is not edited) and are remembered on this device. Unknown names are reported in the result, never guessed. Entry rule: only sim mean has been the live rule; the others are saved every run for the live test (call at ~15 slates).</p>
      </form></section>
      <section><div class="sec-head"><div><h2>Runs for this slate</h2><p class="sub">Newest first. Each run is kept in slates/${esc(info.folder)}/runs/ so a chat can read it.</p></div></div><div id="r-list"><p class="loading">Loading runs…</p></div></section>`;
    const $ = id => document.getElementById(id), msg = $("r-msg");
    function read() {
      const v = (id, f) => { const x = $(id); if (!x || x.value === "") return undefined; const n = Number(x.value); return isFinite(n) ? n : NaN; };
      Object.assign(D, { merge: $("r-merge").checked, n_entries: v("r-k"), entry_rule: $("r-rule").value, field_size: mon ? undefined : v("r-fs"), buy_in: mon ? undefined : v("r-bi"),
        target: v("r-tg"), max_exposure: v("r-mx"), max_shared: v("r-ms"), lock: $("r-lock").value, ban: $("r-ban").value });
      store.set(sk, D);
    }
    app.querySelectorAll("#r-f .seg button").forEach(b => b.addEventListener("click", () => {
      const [k, v] = Object.entries(b.dataset)[0]; D[k] = v;
      app.querySelectorAll(`#r-f .seg button[data-${k}]`).forEach(x => x.setAttribute("aria-pressed", x.dataset[k] === v));
      $("r-simf").hidden = D.what === "proj"; read();
    }));
    app.querySelectorAll("#r-f input, #r-f select, #r-f textarea").forEach(x => x.addEventListener("change", read));
    $("r-optcopy").addEventListener("click", () => {
      const c = getPicks(info);
      if (!c.locks.length && !c.bans.length) { msg.textContent = "No locks or excludes set on the Slate page or Optimiser for this slate on this device."; return; }
      $("r-lock").value = (c.locks || []).join("\n"); $("r-ban").value = (c.bans || []).join("\n"); read();
      msg.textContent = `Copied ${c.locks.length} locks and ${c.bans.length} excludes from the Slate / Optimiser.`;
    });
    if ($("r-pick")) $("r-pick").addEventListener("change", e => { location.hash = "sim-" + e.target.value; });
    $("r-run").addEventListener("click", async () => {
      read();
      const sim = {}, bad = [];
      if (D.what === "sim") {
        [["n_entries", 1, 20, 1], ["field_size", 10, 100000, 1], ["buy_in", 0, 1000, 0], ["target", 50, 400, 0], ["max_exposure", 1, 20, 1], ["max_shared", 0, mon ? 8 : 7, 1]].forEach(([k, lo, hi, int]) => {
          const x = D[k]; if (x === undefined) return;
          if (!(x >= lo && x <= hi) || (int && x !== Math.round(x))) bad.push(`${k.replace("_", " ")} must be ${int ? "a whole number" : "a number"} from ${lo} to ${hi}`); else sim[k] = x;
        });
        if ((D.entry_rule === "eur" || D.entry_rule === "pick3") && (!sim.field_size || sim.buy_in == null)) bad.push("this entry rule needs field size and buy-in");
        sim.entry_rule = D.entry_rule; sim.mode = D.mode;
        const lk = names(D.lock), bn = names(D.ban);
        if (lk.length) sim.lock = lk; if (bn.length) sim.ban = bn;
        const both = lk.filter(n => bn.includes(n)); if (both.length) bad.push("locked and banned at once: " + both.join(", "));
        if (D.mode === "shortlist" && short.size < (mon ? 9 : 7)) bad.push(`shortlist has ${short.size} players: star at least ${mon ? 9 : 7} on the Matrix (and save it)`);
        if (D.mode === "shortlist" && SH[info.id] && SH[info.id].can && !sameSet(getShort(info), SH[info.id].names)) bad.push("the shortlist has unsaved changes: save it on the Matrix first (the run reads the repo file)");
      }
      if (bad.length) { msg.innerHTML = '<span class="down">Not sent:</span> ' + esc(bad.join("; ")) + "."; return; }
      const btn = $("r-run"); btn.disabled = true; msg.textContent = "Saving the run request…";
      try { const id = await simSend(info, { what: D.what, merge_news: D.merge && autoNews, sim: D.what === "sim" ? sim : {} }); location.hash = "run-" + info.folder + "~" + id; }
      catch (e) { btn.disabled = false; msg.innerHTML = `<span class="down">Not sent:</span> ${esc(e.message)}`; }
    });
    const R = await runsOf(info.folder, true);
    if (tok !== RT || !location.hash.startsWith("#sim")) return;
    $("r-list").innerHTML = (R.err ? `<p class="note warn-t">Could not list runs: ${esc(R.err)}</p>` : "")
      + (R.list.length ? `<ul class="runs">${R.list.slice(0, 20).map(id => { const x = R.res[id];
          const st = !x ? '<span class="chip dtd">running / no result</span>' : x.status === "ok" ? '<span class="chip ok">ok</span>' : '<span class="chip out">failed</span>';
          const what = x ? (x.what === "proj" ? "projection only" : `${(x.entries || []).length} entries`) : "";
          return `<li><a href="#run-${esc(info.folder)}~${esc(id)}">${esc(whenId(id))}</a> ${st} <span class="dim">${esc(what)}</span></li>`; }).join("")}</ul>` : '<p class="empty">No runs yet.</p>');
  }

  async function renderRun(arg) {
    const tok = ++RT;
    const [folder, id] = arg.split("~");
    app.innerHTML = shell("sim", "Run " + whenId(id)) + `<main class="wrap"><p class="loading">Loading run…</p></main>`;
    const main = app.querySelector("main"), back = `<p><a class="back" href="#sim-${esc(folder)}">← Simulator</a></p>`;
    if (!GH.token()) { main.innerHTML = back + '<p class="panel">Runs are in the private repo: add the write-back token on <a href="#settings">Settings</a>.</p>'; return; }
    const R = SIMR[folder] || (SIMR[folder] = { list: null, err: null, res: {} });
    let res = R.res[id] || null;
    if (!res) { try { res = await GH.json(runDir(folder) + "/" + id + "/result.json"); if (res) R.res[id] = res; } catch (e) { main.innerHTML = back + `<p>Could not read this run (${esc(e.message)}).</p>`; return; } }
    if (tok !== RT || location.hash !== "#run-" + arg) return;
    if (!res) {     // still running: check every 15 s for up to 10 min from the request time (survives a reload)
      const t0 = Math.min(idMs(id), Date.now()), el = () => (Date.now() - t0) / 60000;
      const txt = () => el() < 10 ? `Running on GitHub… ${Math.floor(el())}:${String(Math.floor((el() % 1) * 60)).padStart(2, "0")} so far (usually about 2 min). This page checks every 15 seconds; you can leave and come back.`
        : "No result after 10 minutes. Check GitHub → euroleague-dfs → Actions → sim. If the run failed there, result.json may be missing; if it never started, the request may not have been saved.";
      main.innerHTML = back + `<section><h1>Run ${esc(whenId(id))}</h1><p class="panel" id="r-wait">${txt()}</p></section>`;
      if (el() < 10) {
        const t = setInterval(async () => {
          if (location.hash !== "#run-" + arg) { clearInterval(t); return; }
          try { const x = await GH.json(runDir(folder) + "/" + id + "/result.json"); if (x) { R.res[id] = x; clearInterval(t); renderRun(arg); return; } } catch (e) { /* keep polling */ }
          const w = document.getElementById("r-wait"); if (w) w.textContent = txt();
          if (el() >= 10) clearInterval(t);
        }, 15000);
      }
      return;
    }
    const q = res.request || {}, n = res.news || {}, p = res.proj || {}, ok = res.status === "ok";
    const facts = [["Slate", res.contest || folder], ["What", res.what === "proj" || q.what === "proj" ? "projection only" : "projection + simulator"], ["Lock", res.lock_malta ? res.lock_malta + " Malta" : "—"],
      ["News", (n.file || "none").split("/").pop() + (n.merged ? " (re-merged)" : "")], ["Newest news read", n.newest_read_utc ? mt(n.newest_read_utc) : "—"],
      ["Players", p.players ?? "—"], ["With props", p.with_props ?? "—"], ["Overrides used", p.overrides ?? "—"], ["Took", res.seconds != null ? res.seconds + " s" : "—"]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    const warn = (res.warnings || []).length ? `<ul class="note warn-t sim-warn">${res.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
    let html = back + `<section><div class="sec-head"><div><h1>Run ${esc(whenId(id))}</h1>
      <p class="sub">${ok ? "Done. The Slate page shows the new Used FP and entries after the site rebuild (about 2 minutes after this). Not frozen: freezing is a chat step." : (res.proj ? "The projection was re-run (and is saved), then the simulator failed: no new entries." : "This run failed. Nothing was changed.")}</p></div></div>
      <dl class="facts">${facts}</dl>${warn}</section>`;
    if (!ok) { main.innerHTML = html + `<section class="panel"><p><strong>Why:</strong></p><ul>${(res.errors || []).map(e => `<li>${esc(e)}</li>`).join("")}</ul><p class="note">Fix it and run again from the Simulator page.</p></section>`; return; }
    const mv = res.moved || [];
    html += `<section><div class="sec-head"><div><h2>What moved</h2><p class="sub">Used FP that changed by 1+ since the projection before this run (overrides, news, props, lines).</p></div></div>
      ${mv.length ? `<div class="tbl-wrap"><table><thead><tr><th>Player</th><th>Team</th><th class="n">Before</th><th class="n">Now</th><th class="n">Change</th><th>News</th></tr></thead><tbody>
      ${mv.map(r => `<tr><td class="pl">${esc(r.name)}</td><td>${esc(r.team)}</td><td class="n">${f1(r.before)}</td><td class="n">${f1(r.after)}</td><td class="n">${sgn(r.after - r.before)}</td><td class="why wide"><span>${esc(r.news || "")}</span></td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">Nothing moved by 1 FP or more.</p>'}</section>`;
    if (res.entries) {
      const ap = res.applied || {}, E = res.entries, monR = res.format === "monthly";
      const eLine = e => monR ? `${f1(e.price)}M · mean ${f1(e.mean)} · sim ${f1(e.sim)} · p10–p90 ${e.p10 ?? "—"}–${e.p90 ?? "—"} · P(≥ ${esc(ap.target ?? "target")}) ${pct(e.p_target, 1)}`
        : `${f1(e.price)}M · mean ${f1(e.mean)} · sim ${f1(e.sim)} · cash ${pct(e.p_cash)} · top 1% ${pct(e.top1, 1)}${e.eur != null ? " · " + eurS(e.eur) : ""}`;
      const common = E.length ? E.map(e => new Set(e.players.map(x => x.name))).reduce((a, b) => new Set([...a].filter(x => b.has(x)))) : new Set();
      html += `<section><div class="sec-head"><div><h2>Suggested entries</h2><p class="sub">Rule: ${esc(ruleTxt(ap.entry_rule) || "sim mean")}. ${E.length} of ${esc(ap.n_entries ?? "?")} asked${ap.lock && ap.lock.length ? " · lock " + esc(ap.lock.join(", ")) : ""}${ap.ban && ap.ban.length ? " · ban " + esc(ap.ban.join(", ")) : ""}${ap.mode === "shortlist" ? " · shortlist only" : ""}. ${monR ? "Monthly GW: no field, so no cash or EUR. The chance of reaching the target assumes our projection is right on average: use it to rank squads, not as odds." : "Cash, top 1% and EUR are the simulator's own figures: they assume our projection beats the field's, so they run optimistic. Use them to rank, not to forecast."}</p></div></div>
        <div class="entries">${E.map(e => `<div class="entry sim"><h3>#${e.entry}<small>${eLine(e)}</small></h3>
          <ul>${e.players.map(x => `<li><span class="nm">${esc(x.name)}</span><span class="dim">${esc([x.pos, x.team].filter(Boolean).join(" "))}</span><span class="n">${x.price != null ? f1(x.price) : ""}</span><span class="n">${x.fp != null ? f1(x.fp) : ""}</span><span class="n dim">${x.own != null ? Math.round(x.own) + "%" : ""}</span></li>`).join("")}</ul></div>`).join("")}</div>
        <p class="note">Columns: price, Used FP${monR ? "" : ", simulated field ownership"}. In every entry: ${common.size ? esc([...common].join(", ")) + " (one bad night there hits every entry)" : "nobody"}.</p></section>`;
      if ((res.rules || []).length) html += `<section><div class="sec-head"><div><h2>Every rule on the same candidates</h2><p class="sub">Per entry averages. Saved each run for the live test (PLAN P3). No verdict before ~15 slates. pick3 has no per-player cap, so it can return more entries than the others when you lock a player.</p></div></div>
        <div class="tbl-wrap"><table><thead><tr><th>Rule</th><th class="n">Entries</th><th class="n">Sim mean</th><th class="n">${monR ? "P(≥ target)" : "P(cash)"}</th><th class="n">EUR</th></tr></thead><tbody>
        ${res.rules.map(r => `<tr${r.rule === ap.entry_rule ? ' class="cur"' : ""}><td>${esc(ruleTxt(r.rule))}${r.rule === ap.entry_rule ? " ← used" : ""}</td><td class="n">${r.n ?? "—"}</td><td class="n">${f1(r.sim)}</td><td class="n">${pct(monR ? r.p_target : r.p_cash, 1)}</td><td class="n">${r.eur != null ? eurS(r.eur) : "—"}</td></tr>`).join("")}</tbody></table></div></section>`;
      if ((res.top10 || []).length) html += `<section><div class="sec-head"><div><h2>Top 10 lineups</h2><p class="sub">By ${res.top10[0].eur != null ? "expected EUR" : "sim mean"}.</p></div></div>
        <div class="tbl-wrap"><table><thead><tr><th class="n">#</th><th>Players</th><th class="n">Sim</th>${monR ? '<th class="n">p10</th><th class="n">p90</th><th class="n">P(≥ target)</th>' : '<th class="n">Cash</th><th class="n">Top 1%</th><th class="n">EUR</th>'}<th class="n">Price</th></tr></thead><tbody>
        ${res.top10.map((l, i) => `<tr><td class="n">${i + 1}</td><td class="why wide"><span>${esc(l.players.join(" · "))}</span></td><td class="n">${f1(l.sim_mean)}</td>${monR ? `<td class="n">${l.p10 != null ? Math.round(l.p10) : "—"}</td><td class="n">${l.p90 != null ? Math.round(l.p90) : "—"}</td><td class="n">${pct(l.p_target, 1)}</td>` : `<td class="n">${pct(l.p_cash_field)}</td><td class="n">${pct(l.p_top1_field, 1)}</td><td class="n">${eurS(l.eur)}</td>`}<td class="n">${f1(l.price ?? l.cost)}</td></tr>`).join("")}</tbody></table></div></section>`;
      html += `<section><details class="raw"><summary>Full simulator printout</summary><pre class="sim-log">${esc(res.summary || "")}</pre></details></section>`;
    }
    main.innerHTML = html; window.scrollTo(0, 0);
  }

  /* ---------- Settings: write-back token (shared with the NBA half) ---------- */
  function renderSettings(autoTest) {
    const has = !!GH.token();
    app.innerHTML = shell("settings", "Settings") + `<main class="wrap"><section>
      <div class="sec-head"><div><h1>Write-back</h1>
        <p class="sub">Lets this page save your overrides (Slate ✎) and shortlists (Matrix ☆) to the private repo euroleague-dfs, and start projection / simulator runs (Simulator, Re-run now). Each save is one commit. A saved run request starts the sim Action on GitHub: the token needs nothing more.</p></div></div>
      <div class="panel">
        <p><strong>Status on this device:</strong> ${has ? '<span class="chip ok">token saved</span>' : '<span class="chip dtd">no token</span>'}</p>
        <form class="filters" onsubmit="return false">
          <label class="grow">GitHub token (the NBA write-back token, with euroleague-dfs added)<input type="password" id="t-in" autocomplete="off" spellcheck="false" placeholder="${has ? "saved; paste a new one to replace it" : "github_pat_…"}"></label>
          <button type="submit" id="t-save" class="primary">Save and test</button>
          ${has ? '<button type="button" id="t-test">Test again</button><button type="button" id="t-del">Remove from this device</button>' : ""}
        </form>
        <p id="t-msg" class="note" role="status"></p>
      </div>
      <p class="note">One token for both halves of insite: a token saved on the NBA Settings page works here too, and removing it here removes it there. On GitHub (Settings → Developer settings → Fine-grained tokens → the write-back token) the repository list must include <strong>euroleague-dfs</strong>, permission Contents: read and write. Not the <em>insite deploy</em> token. The token stays in this browser and is sent only to api.github.com. If a device is lost: delete the token on GitHub and make a new one.</p>
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
      GH.setToken(v); Object.keys(OVR).forEach(k => delete OVR[k]); Object.keys(SH).forEach(k => delete SH[k]); renderSettings(true);
    });
    const tb = document.getElementById("t-test"); if (tb) tb.addEventListener("click", test);
    const db = document.getElementById("t-del"); if (db) db.addEventListener("click", () => { GH.setToken(null); renderSettings(); });
    if (autoTest) test();
  }

  async function route() {
    try { await loadBase(); } catch (e) { app.innerHTML = `<main class="wrap"><h1>insite · EuroLeague</h1><p>Could not load the data (${esc(e.message)}). The build may still be running; reload in a few minutes.</p></main>`; return; }
    const h = location.hash.slice(1);
    try {
      if (h.startsWith("player-")) await renderPlayer(h.slice(7));
      else if (h === "slate" || h.startsWith("slate-")) await renderSlate(h.slice(6));
      else if (h === "injuries") await renderInjuries();
      else if (h === "matrix") await renderMatrix();
      else if (h === "opt" || h.startsWith("opt-")) await renderOpt(h.slice(4));
      else if (h === "sim" || h.startsWith("sim-")) await renderSim(h.slice(4));
      else if (h.startsWith("run-")) await renderRun(h.slice(4));
      else if (h === "settings") renderSettings();
      else if (h === "teams") await renderTeams();
      else renderHome();
    } catch (e) { app.innerHTML = shell("") + `<main class="wrap"><p>Could not load this page (${esc(e.message)}).</p></main>`; }
  }
  window.addEventListener("hashchange", route);
  let wasSm = window.innerWidth < 640;
  window.addEventListener("resize", () => { const sm = window.innerWidth < 640; if (sm !== wasSm && location.hash === "#matrix") renderMatrix(); wasSm = sm; });
  route();
})();
