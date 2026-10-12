/* Fathom dashboard. Reads the JSON files in data/ and draws every panel with D3. */
(function () {
  "use strict";

  const state = { region: "", theme: "", country: "", days: 7, q: "", limit: 20, energyDays: 90, layer: "coverage" };
  const D = {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const DAY = 86400000;
  const nf = (n) => Number(n || 0).toLocaleString("en-GB");
  const fmtDate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const ageDays = (iso) => (Date.now() - new Date(iso)) / DAY;
  const within = (iso, days) => ageDays(iso) <= days;
  const HOT_THEMES = new Set(["sanctions", "maritime", "conflict", "nuclear"]);
  let regionNames;
  try { regionNames = new Intl.DisplayNames(["en-GB"], { type: "region" }); } catch (e) { regionNames = null; }
  const flagName = (code) => {
    const c = (code || "").trim().toUpperCase();
    if (!c) return "Unknown";
    try { return (c.length === 2 && regionNames && regionNames.of(c)) || c; } catch (e) { return c; }
  };

  /* Country names in the map file that differ from the names used for tagging */
  const ATLAS_NAME = {
    "United States": "United States of America", "DR Congo": "Dem. Rep. Congo", "Republic of Congo": "Congo",
    "Central African Republic": "Central African Rep.", "South Sudan": "S. Sudan", "Bosnia and Herzegovina": "Bosnia and Herz.",
    "Dominican Republic": "Dominican Rep.", "Ivory Coast": "C\u00f4te d'Ivoire", "Equatorial Guinea": "Eq. Guinea", "North Macedonia": "Macedonia",
  };
  const FROM_ATLAS = Object.fromEntries(Object.entries(ATLAS_NAME).map(([k, v]) => [v, k]));

  async function load(name) {
    try {
      const r = await fetch(`${name}.json`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) { return null; }
  }

  function ago(iso) {
    if (!iso) return "\u2013";
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 60) return `${Math.max(mins, 1)} min ago`;
    const h = Math.round(mins / 60);
    if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  /* ------------------------------------------------------------ tooltip */
  const tip = $("tip");
  function showTip(html, ev) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  /* ------------------------------------------------------------ data helpers */
  const items = () => D.news?.items || [];
  function filtered(skip = []) {
    return items().filter((i) =>
      within(i.published, state.days) &&
      (skip.includes("region") || !state.region || i.regions.includes(state.region)) &&
      (skip.includes("theme") || !state.theme || i.themes.includes(state.theme)) &&
      (skip.includes("country") || !state.country || i.countries.includes(state.country)) &&
      (!state.q || `${i.title} ${i.summary} ${i.source} ${i.countries.join(" ")}`.toLowerCase().includes(state.q)));
  }
  function countBy(list, fn) {
    const m = new Map();
    for (const x of list) for (const k of [].concat(fn(x))) if (k) m.set(k, (m.get(k) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  /* ------------------------------------------------------------ bar lists */
  function drawBars(el, rows, { onClick, active, limit = 8, empty = "Nothing to show yet." } = {}) {
    rows = rows.slice(0, limit);
    if (!rows.length) { el.innerHTML = `<li class="bars-empty">${esc(empty)}</li>`; return; }
    const max = rows[0][1];
    el.innerHTML = rows.map(([k, n, label]) => `
      <li class="${onClick ? "clickable" : ""} ${active === k ? "on" : ""}" ${onClick ? `tabindex="0" role="button" data-k="${esc(k)}" aria-pressed="${active === k}"` : ""}>
        <span class="lbl" title="${esc(label || k)}">${esc(label || k)}</span>
        <span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span>
        <span class="val">${nf(n)}</span>
      </li>`).join("");
    if (onClick) {
      el.onclick = (e) => { const li = e.target.closest("li[data-k]"); if (li) onClick(li.dataset.k); };
      el.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.dataset.k) { e.preventDefault(); onClick(e.target.dataset.k); } };
    }
  }

  /* ------------------------------------------------------------ overview */
  function drawOverview() {
    const week = items().filter((i) => within(i.published, 7));
    const prev = items().filter((i) => ageDays(i.published) > 7 && ageDays(i.published) <= 14);
    $("hero-count").textContent = nf(week.length);
    const s = D.status || {};
    $("updated").textContent = `Updated ${ago(s.updated || D.news?.updated)}`;
    const feeds = s.feeds || [];
    $("sources-ok").textContent = feeds.length ? `${feeds.filter((f) => f.ok).length}/${feeds.length}` : "\u2013";
    $("hero-sub").textContent = `Tracking ${D.meta.feed_count || feeds.length || 35} sources across six regions and ten themes.`;
    if (prev.length) {
      const pct = ((week.length - prev.length) / prev.length) * 100;
      $("hero-change").innerHTML = `<span class="${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "\u25b2" : "\u25bc"} ${Math.abs(pct).toFixed(0)}%</span>`;
    } else $("hero-change").textContent = "\u2013";
    $("hero-sanc").textContent = D.sanctions ? nf(D.sanctions.recent_total) : "\u2013";
    
    drawHotList();
  }

  function drawHotList() {
    const week = items().filter((i) => within(i.published, 7));
    const top = countBy(week, (i) => i.countries).filter(([c]) => c !== "European Union").slice(0, 6);
    const max = top[0]?.[1] || 1;
    $("hot-list").innerHTML = top.map(([c, n], idx) => `
      <li><button type="button" data-c="${esc(c)}" aria-pressed="${state.country === c}">
        <span class="hot-rank">${idx + 1}</span><span>${esc(c)}</span><span class="hot-n">${nf(n)}</span>
        <span class="hot-bar"><i style="width:${(n / max) * 100}%"></i></span>
      </button></li>`).join("") || `<li class="board-sub">No stories yet.</li>`;
    $("hot-list").onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); };
  }

  /* ------------------------------------------------------------ world map */
  let worldFeatures = null;
  function features() {
    if (!worldFeatures && D.world && window.topojson) {
      worldFeatures = topojson.feature(D.world, D.world.objects.countries).features.filter((f) => f.properties.name !== "Antarctica");
    }
    return worldFeatures;
  }

  function drawWorld() {
    const el = $("world"); el.innerHTML = "";
    const feats = features();
    if (!feats || !window.d3) { el.innerHTML = `<p class="board-sub">The map couldn't load. Reload the page to try again.</p>`; return; }
    const w = el.clientWidth || 800, h = Math.round(w / 1.9);
    const proj = d3.geoNaturalEarth1().fitExtent([[4, 4], [w - 4, h - 4]], { type: "Sphere" });
    const path = d3.geoPath(proj);
    const conflictLayer = state.layer === "conflict" && (D.conflict?.events || []).length;
    const week = items().filter((i) => within(i.published, 7));
    let counts, unit;
    if (conflictLayer) {
      counts = new Map([...conflictByCountry(14)].map(([c, r]) => [c, r.ev])); unit = ["event", "events", "in 14 days"];
    } else {
      counts = new Map(countBy(week, (i) => i.countries)); unit = ["story", "stories", "this week"];
    }
    $("key-low").textContent = conflictLayer ? "Fewer events" : "Fewer stories";
    const themeTop = (c) => countBy(week.filter((i) => i.countries.includes(c)), (i) => i.themes)[0]?.[0];
    const max = d3.max(counts.values()) || 1;
    const ramp = ["--b1", "--b2", "--b3", "--b4", "--b5"].map(css);
    const colour = (n) => (n ? ramp[Math.min(4, Math.floor(Math.sqrt(n / max) * 4.999))] : css("--land"));

    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("aria-hidden", "true");
    svg.append("path").attr("class", "sphere").attr("d", path({ type: "Sphere" }));
    svg.append("path").attr("class", "graticule").attr("d", path(d3.geoGraticule10()));
    svg.append("g").selectAll("path").data(feats).join("path")
      .attr("class", (f) => `country${state.country && (ATLAS_NAME[state.country] || state.country) === f.properties.name ? " sel" : ""}`)
      .attr("d", path)
      .style("fill", (f) => colour(counts.get(FROM_ATLAS[f.properties.name] || f.properties.name) || 0))
      .on("mousemove", (ev, f) => {
        const name = FROM_ATLAS[f.properties.name] || f.properties.name, n = counts.get(name) || 0;
        const r = RISK?.byName.get(name), t = !conflictLayer && n && themeTop(name);
        showTip(`<strong>${esc(name)}</strong>${n ? `${nf(n)} ${n === 1 ? unit[0] : unit[1]} ${unit[2]}` : `No ${unit[1]} ${unit[2]}`}${t ? `<br>Mostly ${esc(D.meta.themes[t]?.label || t)}` : ""}${r ? `<br>Depth Index ${r.score}, ${bandOf(r.score)[1]}` : ""}`, ev);
      })
      .on("mouseleave", hideTip)
      .on("click", (ev, f) => { hideTip(); openDossier(FROM_ATLAS[f.properties.name] || f.properties.name); });
    svg.selectAll(".country.sel").raise();

    if ($("show-choke").checked) {
      const stats = chokeStats();
      const g = svg.append("g");
      const size = d3.scaleSqrt().domain([0, Math.max(1, d3.max(stats, (c) => c.cur))]).range([3.5, 9]);
      for (const c of stats) {
        const [x, y] = proj([c.lon, c.lat]), s = size(c.cur);
        g.append("path").attr("class", "choke-mark").attr("d", `M${x},${y - s}L${x + s},${y}L${x},${y + s}L${x - s},${y}Z`)
          .style("opacity", c.cur ? 1 : 0.45)
          .on("mousemove", (ev) => showTip(`<strong>${esc(c.name)}</strong>${nf(c.cur)} stories in 7 days${c.prev ? `, ${nf(c.prev)} the week before` : ""}`, ev))
          .on("mouseleave", hideTip)
          .on("click", () => { hideTip(); state.q = c.kw[0]; $("f-search").value = c.kw[0]; state.days = 14; $("f-days").value = "14"; refresh(); showView("news"); });
        if (c.cur && w > 560) g.append("text").attr("class", "choke-label").attr("x", x + s + 3).attr("y", y + 3.5).text(nf(c.cur));
      }
    }
  }

  function toggleCountry(c, scroll) {
    state.country = state.country === c ? "" : c;
    if (state.country && state.days < 7) { state.days = 7; $("f-days").value = "7"; }
    refresh();
    if (scroll && state.country) showView("news");
  }

  /* ------------------------------------------------------------ theme pulse */
  function drawPulse() {
    const el = $("pulse");
    const today = new Date(); today.setHours(23, 59, 59, 999);
    const dayIdx = (iso) => Math.floor((today - new Date(iso)) / DAY); // 0 = today
    el.innerHTML = "";
    for (const [tk, t] of Object.entries(D.meta.themes)) {
      const daily = new Array(14).fill(0);
      for (const i of items()) if (i.themes.includes(tk)) { const d = dayIdx(i.published); if (d >= 0 && d < 14) daily[13 - d]++; }
      const cur = daily.slice(7).reduce((a, b) => a + b, 0), prev = daily.slice(0, 7).reduce((a, b) => a + b, 0);
      const pct = prev ? ((cur - prev) / prev) * 100 : cur ? 100 : 0;
      const cls = Math.abs(pct) < 5 ? "flat" : pct > 0 ? "rise" : "fall";
      const card = document.createElement("button");
      card.type = "button"; card.className = "pulse-card"; card.dataset.t = tk;
      card.setAttribute("aria-pressed", String(state.theme === tk));
      card.setAttribute("aria-label", `${t.label}: ${cur} stories this week, ${cls === "flat" ? "level with" : `${Math.abs(pct).toFixed(0)}% ${pct > 0 ? "up on" : "down on"}`} the week before`);
      card.innerHTML = `<span class="pulse-name">${esc(t.label)}</span>
        <span class="pulse-row"><span class="pulse-n">${nf(cur)}<small>this week</small></span>
        <span class="chg ${cls}">${cls === "flat" ? "Level" : `${pct > 0 ? "\u25b2" : "\u25bc"} ${Math.abs(pct).toFixed(0)}%`}</span></span>`;
      el.appendChild(card);
      const W = 200, H = 40, gap = 2, bw = (W - gap * 13) / 14, max = Math.max(1, ...daily);
      const svg = d3.select(card).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "none").attr("aria-hidden", "true");
      svg.selectAll("rect").data(daily.map((v, i) => ({ v, i }))).join("rect")
        .attr("x", (d) => d.i * (bw + gap)).attr("width", bw)
        .attr("y", (d) => H - Math.max(1.5, (d.v / max) * H)).attr("height", (d) => Math.max(1.5, (d.v / max) * H))
        .attr("rx", 1.5).style("fill", (d) => css(d.i >= 7 ? "--bar" : "--bar-soft"))
        .on("mousemove", (ev, d) => {
          const date = new Date(today - (13 - d.i) * DAY);
          showTip(`<strong>${fmtDate(date)}</strong>${nf(d.v)} ${d.v === 1 ? "story" : "stories"} on ${esc(t.label)}`, ev);
        })
        .on("mouseleave", hideTip);
    }
    el.onclick = (e) => {
      const b = e.target.closest(".pulse-card"); if (!b) return;
      state.theme = state.theme === b.dataset.t ? "" : b.dataset.t; $("f-theme").value = state.theme; refresh();
    };
  }

  /* ------------------------------------------------------------ matrix */
  function drawMatrix() {
    const { regions, themes } = D.meta;
    const week = items().filter((i) => within(i.published, 7));
    const count = {};
    let max = 0;
    for (const i of week) for (const r of i.regions) for (const t of i.themes) {
      const k = `${r}|${t}`; count[k] = (count[k] || 0) + 1; max = Math.max(max, count[k]);
    }
    const q = (n) => (n === 0 ? 0 : Math.min(5, Math.ceil((n / max) * 5)));
    let h = `<thead><tr><th scope="col">Region</th>${Object.values(themes).map((t) => `<th scope="col">${esc(t.label)}</th>`).join("")}<th scope="col" class="total">All</th></tr></thead><tbody>`;
    for (const [rk, r] of Object.entries(regions)) {
      h += `<tr><th scope="row">${esc(r.label)}</th>`;
      for (const [tk, t] of Object.entries(themes)) {
        const n = count[`${rk}|${tk}`] || 0;
        h += `<td><button type="button" class="cell" data-q="${q(n)}" data-r="${rk}" data-t="${tk}" aria-pressed="${state.region === rk && state.theme === tk}"
          aria-label="${esc(r.label)}, ${esc(t.label)}: ${n} ${n === 1 ? "story" : "stories"}">${n || "\u00b7"}</button></td>`;
      }
      h += `<td class="total">${week.filter((i) => i.regions.includes(rk)).length}</td></tr>`;
    }
    $("matrix").innerHTML = h + "</tbody>";
  }

  /* ------------------------------------------------------------ filters + feed */
  function setupFilters() {
    const fr = $("f-region"), ft = $("f-theme");
    for (const [k, r] of Object.entries(D.meta.regions)) fr.add(new Option(r.label, k));
    for (const [k, t] of Object.entries(D.meta.themes)) ft.add(new Option(t.label, k));
    fr.onchange = () => { state.region = fr.value; refresh(); };
    ft.onchange = () => { state.theme = ft.value; refresh(); };
    $("f-days").onchange = (e) => { state.days = +e.target.value; refresh(); };
    let timer;
    $("f-search").oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); refresh(); }, 200); };
    $("f-clear").onclick = clearAll;
    $("matrix").addEventListener("click", (e) => {
      const b = e.target.closest(".cell"); if (!b) return;
      const same = state.region === b.dataset.r && state.theme === b.dataset.t;
      state.region = same ? "" : b.dataset.r; state.theme = same ? "" : b.dataset.t;
      fr.value = state.region; ft.value = state.theme;
      if (state.days < 7) { state.days = 7; $("f-days").value = "7"; }
      refresh();
      if (!same) showView("news");
    });
    $("feed").addEventListener("click", (e) => {
      const b = e.target.closest(".tag"); if (!b) return;
      if (b.dataset.r) { state.region = b.dataset.r; fr.value = b.dataset.r; }
      if (b.dataset.t) { state.theme = b.dataset.t; ft.value = b.dataset.t; }
      if (b.dataset.c) state.country = b.dataset.c;
      refresh();
    });
    $("active-filters").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      const k = b.dataset.k;
      state[k] = ""; if (k === "region") fr.value = ""; if (k === "theme") ft.value = ""; if (k === "q") $("f-search").value = "";
      refresh();
    });
    $("more").onclick = () => { state.limit += 20; drawFeed(); };
  }
  function clearAll() {
    Object.assign(state, { region: "", theme: "", country: "", q: "", days: 7 });
    $("f-region").value = $("f-theme").value = $("f-search").value = ""; $("f-days").value = "7";
    refresh();
  }

  function refresh() {
    state.limit = 20;
    drawMatrix(); drawFeed(); drawHotList(); drawWorld();
    document.querySelectorAll(".pulse-card").forEach((c) => c.setAttribute("aria-pressed", String(state.theme === c.dataset.t)));
  }

  function drawFeed() {
    const { regions, themes } = D.meta;
    const list = filtered();
    const chips = [];
    if (state.country) chips.push(["country", state.country]);
    if (state.region) chips.push(["region", regions[state.region].label]);
    if (state.theme) chips.push(["theme", themes[state.theme].label]);
    if (state.q) chips.push(["q", `\u201c${state.q}\u201d`]);
    $("active-filters").innerHTML = chips.map(([k, l]) => `<button type="button" class="chip" data-k="${k}" aria-label="Remove filter ${esc(l)}">${esc(l)}<span aria-hidden="true">\u00d7</span></button>`).join("");
    $("feed-count").textContent = `${nf(list.length)} ${list.length === 1 ? "story" : "stories"} in the last ${state.days === 1 ? "24 hours" : `${state.days} days`}${chips.length ? ", filtered" : ""}.`;

    drawBars($("top-countries"), countBy(filtered(["country"]), (i) => i.countries), {
      active: state.country, onClick: (c) => toggleCountry(c, false), empty: "No countries named in these stories.",
    });
    drawBars($("top-sources"), countBy(list, (i) => i.source), { limit: 6, empty: "No stories match." });

    if (!list.length) {
      $("feed").innerHTML = `<li class="empty">No stories match these filters. Try a longer period or remove a filter.</li>`;
      $("more").hidden = true; return;
    }
    $("feed").innerHTML = list.slice(0, state.limit).map((i) => `
      <li class="story">
        <span class="story-stripe ${i.themes.some((t) => HOT_THEMES.has(t)) ? "hot" : ""}" aria-hidden="true"></span>
        <div>
          <div class="story-meta"><span class="src">${esc(i.source)}</span><time datetime="${esc(i.published)}">${ago(i.published)}</time></div>
          <h3><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></h3>
          ${i.summary ? `<p>${esc(i.summary)}</p>` : ""}
          <div class="tags">
            ${i.themes.map((t) => themes[t] ? `<button class="tag" data-t="${t}" type="button">${esc(themes[t].label)}</button>` : "").join("")}
            ${i.regions.map((r) => regions[r] ? `<button class="tag region" data-r="${r}" type="button">${esc(regions[r].label)}</button>` : "").join("")}
            ${i.countries.slice(0, 3).map((c) => `<button class="tag country" data-c="${esc(c)}" type="button">${esc(c)}</button>`).join("")}
          </div>
        </div>
      </li>`).join("");
    $("more").hidden = list.length <= state.limit;
  }

  /* ------------------------------------------------------------ sanctions */
  function lists(p) {
    const s = (p || "").toUpperCase(), out = [];
    if (/OFAC|\bUS\b|UNITED STATES/.test(s)) out.push("US");
    if (/OFSI|\bUK\b|HM TREASURY|FCDO|UNITED KINGDOM/.test(s)) out.push("UK");
    if (/\bEU\b|EUROPEAN/.test(s)) out.push("EU");
    if (/\bUN\b|UNITED NATIONS|SECURITY COUNCIL/.test(s)) out.push("UN");
    return out.length ? out : ["Other"];
  }
  const typeName = (t) => ({ LegalEntity: "Entity", Organization: "Organisation" }[t] || t);

  function drawSanctions() {
    const s = D.sanctions;
    if (!s) {
      $("sanc-kpis").innerHTML = `<p class="hint">Sanctions data hasn't loaded yet. It appears after the first daily update.</p>`;
      return;
    }
    const recentVessels = s.recent.filter((r) => r.type === "Vessel").length;
    const flags = countBy(s.vessels, (v) => (v.countries || "").split(/[;,]/)[0]?.trim()).map(([k, n]) => [k, n, flagName(k)]);
    $("sanc-kpis").innerHTML = [
      ["New listings, 30 days", nf(s.recent_total)],
      ["Of which vessels", nf(recentVessels)],
      ["Sanctioned vessels in total", nf(s.vessel_total)],
      ["Most common vessel flag", flags[0] ? esc(flags[0][2]) : "\u2013"],
    ].map(([k, v]) => `<dl class="kpi"><dt>${k}</dt><dd>${v}</dd></dl>`).join("");

    $("sanctions-table").innerHTML = `<thead><tr><th>Added</th><th>Name</th><th>Type</th><th>Lists</th></tr></thead><tbody>` +
      s.recent.slice(0, 12).map((r) => `<tr><td class="num">${fmtDate(r.first_seen)}</td><td>${esc(r.name)}</td><td>${esc(typeName(r.type))}</td>
        <td>${lists(r.programs).map((l) => `<span class="pill">${l}</span>`).join("")}</td></tr>`).join("") + "</tbody>";
    drawBars($("sanc-by-list"), countBy(s.recent, (r) => lists(r.programs)), { limit: 5 });
    drawBars($("sanc-by-type"), countBy(s.recent, (r) => typeName(r.type)), { limit: 5 });
    drawBars($("fleet-flags"), flags, { limit: 8 });
    drawFleet();
    $("fleet-search").oninput = drawFleet;
  }

  function drawFleet() {
    const s = D.sanctions; if (!s) return;
    const q = $("fleet-search").value.trim().toLowerCase();
    const rows = s.vessels.filter((v) => !q || `${v.name} ${v.imo} ${v.countries} ${flagName((v.countries || "").split(/[;,]/)[0])}`.toLowerCase().includes(q));
    $("fleet").innerHTML = `<thead><tr><th>Listed</th><th>Vessel</th><th>IMO</th><th>Flag</th><th>Lists</th></tr></thead><tbody>` +
      (rows.length ? rows.slice(0, 15).map((v) => `<tr><td class="num">${fmtDate(v.first_seen)}</td><td>${esc(v.name)}</td><td class="num">${esc(v.imo || "\u2013")}</td>
        <td>${esc(flagName((v.countries || "").split(/[;,]/)[0]))}</td><td>${lists(v.programs).map((l) => `<span class="pill">${l}</span>`).join("")}</td></tr>`).join("")
        : `<tr><td colspan="5" class="hint">No vessels match \u201c${esc(q)}\u201d.</td></tr>`) + "</tbody>" +
      (rows.length > 15 ? `<caption class="hint" style="caption-side:bottom;text-align:left;padding-top:8px">Showing 15 of ${nf(rows.length)}. Search to narrow the list.</caption>` : "");
  }

  /* ------------------------------------------------------------ energy */
  function drawEnergy() {
    const el = $("energy-charts"); el.innerHTML = "";
    const series = D.energy?.series;
    if (!series || !Object.keys(series).length) {
      el.innerHTML = `<p class="hint">Energy prices appear once an EIA key is added. See the setup guide.</p>`; return;
    }
    const cards = [];
    for (const [label, all] of Object.entries(series)) {
      if (!all.length) continue;
      const cutoff = new Date(all[all.length - 1].date) - state.energyDays * DAY;
      const pts = all.filter((p) => new Date(p.date) >= cutoff).map((p) => ({ date: new Date(p.date), value: p.value }));
      const [name, unit] = label.match(/^(.*?)\s*\((.*)\)$/)?.slice(1) || [label, ""];
      const first = pts[0], last = pts[pts.length - 1];
      const diff = last.value - first.value, pct = (diff / first.value) * 100;
      const card = document.createElement("div");
      card.className = "echart";
      card.innerHTML = `<div class="echart-top"><span class="echart-name">${esc(name)}</span><span class="echart-val">${last.value.toFixed(2)}</span></div>
        <div class="echart-sub"><span>${esc(unit)}, ${fmtDate(last.date)}</span>
        <span class="${diff >= 0 ? "rise" : "fall"}">${diff >= 0 ? "\u25b2" : "\u25bc"} ${Math.abs(pct).toFixed(1)}% over ${state.energyDays >= 180 ? "6 months" : state.energyDays >= 90 ? "3 months" : "1 month"}</span></div>`;
      el.appendChild(card);
      cards.push([card, pts, name, unit, first, last]);
    }
    // measure after every card is in the grid, so each chart gets its real width
    for (const [card, pts, name, unit, first, last] of cards) {
      const W = Math.max(240, card.clientWidth - 32), H = 160, m = { t: 8, r: 40, b: 20, l: 2 };
      const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.date)).range([m.l, W - m.r]);
      const y = d3.scaleLinear().domain(d3.extent(pts, (p) => p.value)).nice(4).range([H - m.b, m.t]);
      const svg = d3.select(card).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
        .attr("aria-label", `${name}, ${pts.length} daily prices from ${fmtDate(first.date)} to ${fmtDate(last.date)}, latest ${last.value.toFixed(2)} ${unit}`);
      const gid = `g${Math.random().toString(36).slice(2, 8)}`;
      const grad = svg.append("defs").append("linearGradient").attr("id", gid).attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", 1);
      grad.append("stop").attr("offset", "0%").attr("stop-color", css("--series-1")).attr("stop-opacity", 0.22);
      grad.append("stop").attr("offset", "100%").attr("stop-color", css("--series-1")).attr("stop-opacity", 0);
      svg.append("g").selectAll("line").data(y.ticks(4)).join("line").attr("class", "gridline")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
      svg.append("g").attr("class", "axis").attr("transform", `translate(${W - m.r + 6},0)`).call(d3.axisRight(y).ticks(4).tickSize(0));
      svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
        .call(d3.axisBottom(x).ticks(4).tickSize(0).tickPadding(6).tickFormat(d3.timeFormat("%-d %b")));
      svg.append("path").datum(pts).attr("fill", `url(#${gid})`)
        .attr("d", d3.area().x((p) => x(p.date)).y0(H - m.b).y1((p) => y(p.value)).curve(d3.curveMonotoneX));
      svg.append("path").datum(pts).attr("fill", "none").attr("stroke", css("--series-1")).attr("stroke-width", 2)
        .attr("d", d3.line().x((p) => x(p.date)).y((p) => y(p.value)).curve(d3.curveMonotoneX));
      svg.append("circle").attr("cx", x(last.date)).attr("cy", y(last.value)).attr("r", 4)
        .style("fill", css("--series-1")).style("stroke", css("--panel")).style("stroke-width", 2);
      const hover = svg.append("g").style("display", "none");
      hover.append("line").attr("y1", m.t).attr("y2", H - m.b).style("stroke", css("--ink-2")).style("stroke-dasharray", "3 3");
      hover.append("circle").attr("r", 4.5).style("fill", css("--series-1")).style("stroke", css("--panel")).style("stroke-width", 2);
      const bis = d3.bisector((p) => p.date).center;
      svg.append("rect").attr("x", m.l).attr("y", 0).attr("width", W - m.l - m.r).attr("height", H).style("fill", "transparent")
        .on("mousemove", (ev) => {
          const [mx] = d3.pointer(ev), p = pts[bis(pts, x.invert(mx))];
          hover.style("display", null).select("line").attr("x1", x(p.date)).attr("x2", x(p.date));
          hover.select("circle").attr("cx", x(p.date)).attr("cy", y(p.value));
          showTip(`<strong>${p.value.toFixed(2)} ${esc(unit)}</strong>${fmtDate(p.date)}`, ev);
        })
        .on("mouseleave", () => { hover.style("display", "none"); hideTip(); });
    }
  }
  function setupEnergyRange() {
    $("energy-range").onclick = (e) => {
      const b = e.target.closest("button[data-days]"); if (!b) return;
      state.energyDays = +b.dataset.days;
      document.querySelectorAll("#energy-range button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      drawEnergy();
    };
  }

  /* ------------------------------------------------------------ status */
  function drawStatus() {
    const s = D.status; if (!s) return;
    const feeds = s.feeds || [], data = s.data || [];
    const bad = feeds.filter((f) => !f.ok).length + data.filter((d) => !d.ok).length;
    $("status-summary").textContent = bad ? `${bad} ${bad === 1 ? "source needs" : "sources need"} attention. Failing sources are listed first.` : "All sources are working.";
    const names = { sanctions: "OpenSanctions", energy: "US EIA energy prices", conflict: "ACLED conflict events", uk: "UK government and Parliament" };
    $("status").innerHTML = `<thead><tr><th>Source</th><th>Type</th><th>State</th><th>Detail</th></tr></thead><tbody>` +
      [...data.map((d) => ({ name: names[d.name] || d.name, group: "Data", ok: d.ok, note: d.note })),
       ...feeds.map((f) => ({ ...f, note: f.ok ? `${f.new} new on last run` : f.note }))]
        .sort((a, b) => a.ok - b.ok)
        .map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.group)}</td><td class="${f.ok ? "ok" : "fail"}">${f.ok ? "Working" : "Failing"}</td><td>${esc(f.note)}</td></tr>`).join("") + "</tbody>";
  }

  /* ------------------------------------------------------------ nav highlight */
  /* ------------------------------------------------------------ views: one screen per job, switched from the rail */
  const VIEWS = {
    overview: { desk: "world", title: "Overview", draw: () => [drawWorld, drawSignals, drawGlance, drawWarnings, drawDevelopments] },
    risk: { desk: "world", title: "Risk monitor", draw: () => [drawRisk, drawNetwork, drawChokepoints, drawPulse, drawPillarMap, drawTrack] },
    news: { desk: "world", title: "News", draw: () => [] },
    sanctions: { desk: "world", title: "Sanctions", draw: () => [] },
    energy: { desk: "world", title: "Energy", draw: () => [drawEnergy] },
    home: { desk: "home", title: "UK response", draw: () => [drawUKTimeline] },
    politics: { desk: "home", title: "Politics and elections", draw: () => [drawPolitics] },
    tax: { desk: "home", title: "Tax and economy", draw: () => [drawTax] },
    weekly: { desk: "about", title: "Weekly summary", draw: () => [drawWeekly] },
    method: { desk: "about", title: "Method and sources", draw: () => [] },
  };
  let currentView = "overview", currentDesk = "";
  const DESK_NAME = { world: "World Desk", home: "Home Desk", about: "About" };
  const lastByDesk = { world: "overview", home: "politics" };
  /* each desk has its own colour, label, wire and backdrop, so it is always clear which one you are reading */
  function setDesk(d) {
    if (d === currentDesk) return;
    currentDesk = d;
    document.documentElement.dataset.desk = d;
    $("crumb-desk").textContent = DESK_NAME[d];
    document.querySelectorAll("#desk-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.desk === d)));
    drawTicker();
  }
  const drawn = new Set(["overview"]);
  function showView(v, { keepScroll = false } = {}) {
    if (!VIEWS[v]) return;
    const changed = v !== currentView;
    currentView = v;
    document.querySelectorAll(".view").forEach((el) => { el.hidden = el.dataset.view !== v; });
    document.querySelectorAll(".rail-link").forEach((a) => a.setAttribute("aria-current", a.dataset.view === v ? "page" : "false"));
    $("view-title").textContent = VIEWS[v].title;
    setDesk(VIEWS[v].desk); lastByDesk[VIEWS[v].desk] = v;
    if (matchMedia("(max-width: 900px)").matches) {  // on phones, bring the open tab into the strip
      const nav = document.querySelector(".rail nav"), link = document.querySelector(`.rail-link[data-view="${v}"]`);
      if (nav && link) nav.scrollTo({ left: Math.max(0, link.offsetLeft - nav.clientWidth / 2 + link.offsetWidth / 2), behavior: "smooth" });
    }
    document.title = v === "overview" ? "Fathom" : `${VIEWS[v].title} | Fathom`;
    // charts measure their container, so draw a view the first time it is actually on screen
    if (!drawn.has(v) || changed) { for (const fn of VIEWS[v].draw()) { try { fn(); } catch (e) { console.error(e); } } drawn.add(v); }
    if (!$("dossier").hidden) return;
    if (location.hash.slice(1) !== v) setHash(v === "overview" ? "" : v);
    if (changed && !keepScroll) window.scrollTo({ top: 0 });
  }
  function route() {
    let t = decodeURIComponent(location.hash.slice(1));
    if (t === "uk") t = "home"; // older links
    if (VIEWS[t]) { if (!$("dossier").hidden) closeDossier(true); showView(t); }
    else if (t.startsWith("c-")) openFromHash();
    else if (!t) showView("overview");
  }
  function setupNav() {
    document.querySelectorAll(".rail-link").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      if (!$("dossier").hidden) closeDossier(true);
      showView(a.dataset.view);
      setHash(a.dataset.view === "overview" ? "" : a.dataset.view);
    }));
    document.querySelector(".brand").addEventListener("click", (e) => { e.preventDefault(); showView("overview"); setHash(""); });
    window.addEventListener("hashchange", route);
    const t = decodeURIComponent(location.hash.slice(1)).replace(/^uk$/, "home");
    if (VIEWS[t]) showView(t);
    // rail badges: what needs a look in each view
    const badge = (v, n, label) => { const b = $(`badge-${v}`); if (!b) return; b.textContent = n ? nf(n) : ""; b.title = n ? label : ""; };
    const hot = (RISK || computeRisk()).rows.filter((r) => r.score >= 65).length;
    badge("risk", hot, "Countries rated High or Severe");
    badge("news", items().filter((i) => within(i.published, 1)).length, "Stories in the last 24 hours");
    if (D.sanctions) badge("sanctions", D.sanctions.recent_total, "New listings, 30 days");
    if (D.home) {
      badge("politics", D.home.elections.filter((e) => e.level === "ballot" && dayDiff(e.date) >= 0 && dayDiff(e.date) <= 7).length, "Contests in the next 7 days");
      const b = (D.home.key_dates || []).find((d) => /budget/i.test(d.label) && dayDiff(d.date) >= 0);
      if (b) badge("tax", 0, ""), $("badge-tax").textContent = `${dayDiff(b.date)}d`, $("badge-tax").title = "Days to the Budget";
    }
    if (D.uk) badge("home", D.uk.whitehall.filter((w) => within(w.published, 7)).length, "UK publications, 7 days");
    const feeds = D.status?.feeds || [];
    $("rail-feeds").textContent = feeds.length ? `${feeds.filter((f) => f.ok).length}/${feeds.length}` : "\u2013";
    tickRail(); setInterval(tickRail, 15000);
    if (!currentDesk) setDesk("world"); else drawTicker();
    $("desk-switch").onclick = (e) => {
      const b = e.target.closest("button[data-desk]"); if (!b) return;
      if (!$("dossier").hidden) closeDossier(true);
      const v = lastByDesk[b.dataset.desk]; showView(v); setHash(v === "overview" ? "" : v);
    };
  }
  function tickRail() {
    const t = (tz) => { try { return new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }); } catch (e) { return "\u2013"; } };
    $("rail-utc").textContent = t("UTC"); $("rail-lon").textContent = t("Europe/London");
  }
  /* the newest headlines run across the command bar; one copy is duplicated so the loop is seamless */
  function drawTicker() {
    const home = currentDesk === "home" && D.home;
    $("wire-label").textContent = home ? "Home wire" : "World wire";
    const pool = home ? D.home.articles.filter((a) => a.group !== "Government") : items();
    const latest = pool.slice().sort((a, b) => b.published.localeCompare(a.published)).slice(0, 14);
    if (!latest.length) { $("ticker").hidden = true; return; }
    const row = latest.map((i) => `<a href="${esc(i.url)}" target="_blank" rel="noopener" tabindex="-1"><b>${esc(i.source)}</b>${esc(i.title)}<time>${ago(i.published)}</time></a>`).join("");
    $("ticker-track").innerHTML = `<div class="ticker-run">${row}</div><div class="ticker-run" aria-hidden="true">${row}</div>`;
    $("ticker-track").style.setProperty("--dur", `${Math.max(60, latest.length * 7)}s`);
  }

  /* ============================================================ Home Desk (UK) */
  const KIND = {
    travel_advice: "Travel advice", speech: "Speech", press_release: "Press release", government_response: "Government response",
    news_story: "News", guidance: "Guidance", statutory_guidance: "Statutory guidance", detailed_guide: "Guide",
    document_collection: "Collection", notice: "Notice", policy_paper: "Policy paper", consultation_outcome: "Consultation",
    open_consultation: "Consultation", written_statement: "Written statement", correspondence: "Correspondence",
  };
  const kindName = (k) => KIND[k] || (k || "Publication").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const UK_GROUPS = {
    all: () => true,
    sanctions: (w) => w.themes.includes("sanctions"),
    statements: (w) => ["speech", "press_release", "government_response", "news_story", "written_statement"].includes(w.kind),
    travel: (w) => w.kind === "travel_advice",
  };
  const ukState = { group: "all" };
  const sinceLabel = () => D.uk?.since ? new Date(D.uk.since).toLocaleDateString("en-GB", { day: "numeric", month: "long" }) : "";
  const shortDate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: new Date(d).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

  /* Everything the UK has published or legislated about one country, newest first */
  function ukActions(c) {
    if (!D.uk) return [];
    const w = D.uk.whitehall.filter((x) => x.countries.includes(c)).map((x) => ({ ...x, label: kindName(x.kind) }));
    const l = D.uk.laws.filter((x) => x.countries.includes(c)).map((x) => ({ ...x, label: "Law", orgs: ["legislation.gov.uk"] }));
    return [...w, ...l].sort((a, b) => b.published.localeCompare(a.published));
  }

  function drawUK() {
    const u = D.uk;
    if (!u) {
      $("uk-kpis").innerHTML = `<p class="hint">UK data appears after the first daily update.</p>`;
      document.querySelector(".uk-body").hidden = true;
      return;
    }
    $("uk-preview").hidden = !u.preview; $("uk-preview").textContent = u.preview || "";
    const travel = u.whitehall.filter((w) => w.kind === "travel_advice" && within(w.published, 7));
    const watch = u.issues.find((i) => i.term === "shadow fleet") || u.issues[0];
    $("uk-kpis").innerHTML = [
      ["Whitehall publications, 30 days", nf(u.whitehall.length)],
      ["Travel advice changes, 7 days", nf(travel.length)],
      [`Sanctions laws made in ${new Date(u.updated).getFullYear()}`, nf(u.laws.filter((l) => l.themes.includes("sanctions")).length)],
      watch ? [`\u201c${esc(watch.term)}\u201d in Parliament since ${sinceLabel()}`, nf(watch.contributions)] : null,
    ].filter(Boolean).map(([k, v]) => `<dl class="kpi"><dt>${k}</dt><dd>${v}</dd></dl>`).join("");

    /* the bridge: each country's share of global coverage against its share of Westminster's attention */
    const rows = attentionRows();
    const max = d3.max(rows, (r) => Math.max(r.ns, r.ws)) || 1;
    const pct = (x) => `${Math.round(x * 100)}%`;
    const gap = (r) => r.ratio >= 1.5 ? ["more", "More in Westminster"] : r.ratio <= 0.67 ? ["less", "Less in Westminster"] : ["even", "In step"];
    $("uk-attention").innerHTML = rows.length ? `
      <div class="att-head" aria-hidden="true"><span>Country</span><span>Share of attention</span><span>Gap</span><span>Latest UK action</span></div>
      ${rows.map((r) => {
        const act = ukActions(r.country)[0], [g, gl] = gap(r);
        return `<div class="att-row">
          <button type="button" class="att-name" data-c="${esc(r.country)}">${esc(r.country)}</button>
          <div class="att-bars" role="img" aria-label="${esc(r.country)}: ${pct(r.ns)} of global coverage, ${pct(r.ws)} of Westminster attention">
            <span class="att-bar global"><i style="width:${(r.ns / max) * 100}%"></i><b>${pct(r.ns)}</b></span>
            <span class="att-bar wm"><i style="width:${(r.ws / max) * 100}%"></i><b>${pct(r.ws)}</b></span>
          </div>
          <span class="att-gap ${g}">${gl}</span>
          <span class="att-act">${act ? `<a href="${esc(act.url)}" target="_blank" rel="noopener">${esc(act.title)}</a><small>${esc(act.label)}, ${shortDate(act.published)}</small>` : `<small>No UK publication in the last 30 days</small>`}</span>
        </div>`;
      }).join("")}` : `<p class="hint">No Parliament data yet.</p>`;
    $("uk-attention").onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); };
    $("uk-att-note").textContent = `Global coverage is this week's Fathom stories. Westminster attention is spoken contributions in Hansard since ${sinceLabel()}. Shares are within the countries shown.`;

    drawUKFeed();
    drawUKTimeline();
    $("uk-filter").onclick = (e) => {
      const b = e.target.closest("button[data-g]"); if (!b) return;
      ukState.group = b.dataset.g;
      $("uk-filter").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      drawUKFeed();
    };

    $("uk-laws").innerHTML = u.laws.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <span>SI ${esc(l.number)}, made ${shortDate(l.published)}</span></li>`).join("") || `<li class="hint">No matching laws this year.</li>`;
    $("uk-speech-title").textContent = watch ? `In Parliament: ${watch.term}` : "In Parliament";
    $("uk-speeches").innerHTML = u.speeches.slice(0, 6).map((p) => `<li><blockquote>${esc(p.text)}</blockquote>
      <span><b>${esc(p.member)}</b>${p.party ? ` (${esc(p.party)})` : ""}, ${esc(p.house)}, ${shortDate(p.date)}. <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.debate)}</a></span></li>`).join("")
      || `<li class="hint">No recent contributions.</li>`;
  }

  function drawUKFeed() {
    const list = D.uk.whitehall.filter(UK_GROUPS[ukState.group]);
    $("uk-feed").innerHTML = list.slice(0, 12).map((w) => `<li class="story">
      <span class="story-stripe ${w.themes.includes("sanctions") ? "hot" : ""}"></span>
      <div>
        <div class="story-meta"><span class="src">${esc(w.orgs[0] || "GOV.UK")}</span><span>${esc(kindName(w.kind))}</span><span>${ago(w.published)}</span></div>
        <h3><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a></h3>
        <div class="tags">${w.countries.filter((c) => c !== "United Kingdom").map((c) => `<button type="button" class="tag country" data-c="${esc(c)}">${esc(c)}</button>`).join("")}
          ${w.themes.map((t) => `<span class="tag static">${esc(D.meta.themes[t]?.label || t)}</span>`).join("")}</div>
      </div></li>`).join("") || `<li class="empty">Nothing in this group in the last 30 days.</li>`;
    $("uk-feed").onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); };
    $("uk-feed-count").textContent = `${nf(Math.min(list.length, 12))} of ${nf(list.length)}`;
  }



  /* ============================================================ Home Desk: politics, elections, tax and economy */
  const H = () => D.home;
  const partyColour = (name) => {
    const p = (H()?.parties || []).find((x) => x.name === name);
    const c = d3.color(p?.colour && p.colour !== "#null" ? p.colour : "#8a96a0");
    return c ? c.brighter(0.35).formatHex() : "#8a96a0";
  };
  const homeArts = (groups, days = 7) => (H()?.articles || []).filter((a) => (!groups || groups.includes(a.group)) && within(a.published, days));
  const dayDiff = (iso) => Math.round((d3.timeDay.floor(new Date(iso)) - d3.timeDay.floor(new Date())) / DAY);
  const inDays = (n) => n === 0 ? "today" : n === 1 ? "tomorrow" : n < 0 ? `${-n} days ago` : `in ${n} days`;
  const longDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const homeState = { wf: "all", tf: "all", elecAll: false };

  function homePreviewNote() {
    document.querySelectorAll(".home-preview").forEach((el) => { el.hidden = !H()?.preview; el.textContent = H()?.preview || ""; });
  }

  function drawPolitics() {
    const h = H();
    if (!h) { $("pol-kpis").innerHTML = `<p class="hint">Politics data appears after the next update.</p>`; return; }
    homePreviewNote();
    const seats = h.parties || [], total = d3.sum(seats, (p) => p.seats);
    const gov = seats.find((p) => p.name === h.government);
    const nonVoting = d3.sum(seats.filter((p) => p.name === "Speaker" || p.name === "Sinn F\u00e9in"), (p) => p.seats);
    const majority = gov ? gov.seats - (total - gov.seats - nonVoting) : null;
    const soon = h.elections.filter((e) => e.level === "ballot" && dayDiff(e.date) >= 0 && dayDiff(e.date) <= 30);
    $("pol-kpis").innerHTML = [
      [`${esc(h.government || "Government")} working majority`, majority != null ? nf(majority) : "\u2013", "Excludes the Speaker and Sinn F\u00e9in, who don't vote"],
      ["Seats held by the government", gov ? `${nf(gov.seats)}<small> of ${nf(total)}</small>` : "\u2013", ""],
      ["Contests in the next 30 days", nf(soon.length), "Council by-elections and full councils"],
      ["Petitions past 100,000", nf(h.petitions.filter((p) => p.signatures >= 100000).length), "Considered for a debate"],
    ].map(([k, v, t]) => `<dl class="kpi" ${t ? `title="${esc(t)}"` : ""}><dt>${k}</dt><dd>${v}</dd></dl>`).join("");
    drawHemicycle();
    $("seats-note").textContent = `Seats held by each party today. ${nf(Math.floor(total / 2) + 1)} are needed for a majority of ${nf(total)}.`;

    // party attention: mentions in news and analysis (party-aligned sites left out)
    const arts = homeArts(["News", "Analysis", "Economy news"]);
    const att = countBy(arts, (a) => a.parties);
    const max = att[0]?.[1] || 1, sum = d3.sum(att, (x) => x[1]) || 1;
    $("party-attn").innerHTML = att.length ? att.slice(0, 8).map(([p, n]) => `<li>
        <span class="lbl">${esc(p)}</span>
        <span class="track"><span class="fill" style="width:${(n / max) * 100}%;background:${partyColour(p)}"></span></span>
        <span class="val">${nf(n)}<small> ${Math.round((n / sum) * 100)}%</small></span></li>`).join("")
      : `<li class="bars-empty">No party mentions in the last 7 days yet.</li>`;
    drawBars($("pol-topics"), countBy(homeArts(["News", "Analysis", "Party voices"]), (a) => a.topics), { limit: 7, empty: "No topics yet." });

    drawElections();
    $("elec-more").onclick = () => { homeState.elecAll = !homeState.elecAll; drawElections(); };

    const pmax = Math.max(100000, ...h.petitions.map((p) => p.signatures));
    $("petitions").innerHTML = h.petitions.slice(0, 8).map((p) => `<li>
      <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <span class="pet-bar" role="img" aria-label="${nf(p.signatures)} signatures"><i style="width:${(p.signatures / pmax) * 100}%"></i><b style="left:${(100000 / pmax) * 100}%" title="100,000: considered for debate"></b></span>
      <span class="pet-meta"><b>${nf(p.signatures)}</b> signatures
        ${p.debate ? `<span class="chip-s ok">Debate threshold reached</span>` : ""}${p.responded ? `<span class="chip-s">Government responded</span>` : `<span class="chip-s warn">Awaiting response</span>`}</span>
    </li>`).join("") || `<li class="hint">No petitions loaded.</li>`;

    drawWestminsterFeed();
    $("wf-filter").onclick = (e) => { const b = e.target.closest("button[data-g]"); if (!b) return; homeState.wf = b.dataset.g;
      $("wf-filter").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawWestminsterFeed(); };
    const lib = (h.articles || []).filter((a) => a.source === "House of Commons Library").slice(0, 7);
    $("library").innerHTML = lib.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a><span>Research briefing, ${ago(a.published)}</span></li>`).join("") || `<li class="hint">No new briefings this fortnight.</li>`;
  }

  function drawHemicycle() {
    const el = $("hemicycle"); el.innerHTML = "";
    const parties = (H()?.parties || []).filter((p) => p.seats > 0);
    const total = d3.sum(parties, (p) => p.seats); if (!total) return;
    // seats sit on concentric arcs; each row holds seats in proportion to its length, then all seats are read left to right
    const W = 520, R = 250, r0 = 92, rows = Math.max(6, Math.round(Math.sqrt(total / 4.6)));
    const radii = d3.range(rows).map((i) => r0 + (R - r0) * (i / (rows - 1)));
    const len = d3.sum(radii);
    let left = total;
    const pos = [];
    radii.forEach((r, i) => {
      const n = i === rows - 1 ? left : Math.round(total * (r / len)); left -= n;
      for (let k = 0; k < n; k++) { const a = Math.PI * (1 - (n === 1 ? 0.5 : k / (n - 1))); pos.push({ a, x: W / 2 + r * Math.cos(a), y: R + 6 - r * Math.sin(a) }); }
    });
    pos.sort((p, q) => q.a - p.a);
    const order = parties.slice().sort((a, b) => (a.name === "Speaker") - (b.name === "Speaker") || b.seats - a.seats);
    let i = 0; for (const p of order) for (let k = 0; k < p.seats; k++) pos[i++].party = p;
    const rad = Math.min(5.2, ((R - r0) / rows) * 0.42);
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${R + 14}`).attr("role", "img")
      .attr("aria-label", order.map((p) => `${p.name} ${p.seats}`).join(", "));
    svg.append("g").selectAll("circle").data(pos).join("circle").attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("r", rad)
      .style("fill", (d) => partyColour(d.party.name))
      .on("mousemove", (ev, d) => showTip(`<strong>${esc(d.party.name)}</strong>${nf(d.party.seats)} seats, ${((d.party.seats / total) * 100).toFixed(1)}%`, ev))
      .on("mouseleave", hideTip);
    const gov = order.find((p) => p.name === H().government);
    svg.append("text").attr("class", "hemi-n").attr("x", W / 2).attr("y", R - 20).attr("text-anchor", "middle").text(gov ? nf(gov.seats) : nf(total));
    svg.append("text").attr("class", "hemi-l").attr("x", W / 2).attr("y", R + 2).attr("text-anchor", "middle").text(gov ? `${gov.name} seats` : "MPs");
    $("party-legend").innerHTML = order.map((p) => `<li><span class="sw" style="background:${partyColour(p.name)}"></span>${esc(p.name)}<b>${nf(p.seats)}</b></li>`).join("");
  }

  function drawElections() {
    const h = H();
    const ballots = h.elections.filter((e) => e.level === "ballot" && dayDiff(e.date) >= 0);
    const byDate = d3.groups(ballots, (e) => e.date).sort((a, b) => a[0].localeCompare(b[0]));
    const show = homeState.elecAll ? byDate : byDate.slice(0, 5);
    const councils = new Set(ballots.map((e) => e.org)).size;
    $("elec-note").textContent = `${nf(ballots.length)} contests across ${nf(councils)} councils, from Democracy Club.`;
    const label = (e) => e.title.replace(`${e.org} local election `, "").replace(/ by-election$/, "") || e.title;
    $("elec-list").innerHTML = show.map(([d, list]) => {
      const n = dayDiff(d);
      return `<li><div class="elec-date ${n <= 7 ? "soon" : ""}"><b>${longDate(d)}</b><span>${inDays(n)}</span></div>
        <ul>${list.map((e) => `<li><span class="elec-org">${esc(e.org)}</span><a class="elec-ward" href="https://whocanivotefor.co.uk/elections/${esc(e.id)}/" target="_blank" rel="noopener">${esc(e.by ? `${label(e)} by-election` : e.title)}</a></li>`).join("")}</ul></li>`;
    }).join("") || `<li class="hint">No upcoming contests listed.</li>`;
    $("elec-more").hidden = byDate.length <= 5;
    $("elec-more").textContent = homeState.elecAll ? "Show fewer" : `Show all ${nf(byDate.length)} polling days`;
  }

  function homeStory(a) {
    const voice = a.party_voice ? `<span class="pill voice" style="border-color:${partyColour(a.party_voice)}">${esc(a.party_voice)} voice</span>` : "";
    return `<li class="story"><span class="story-stripe ${a.tax?.length ? "hot" : ""}"></span><div>
      <div class="story-meta"><span class="src">${esc(a.source)}</span><span>${esc(a.group)}</span><span>${a.dateonly ? shortDate(a.published) : ago(a.published)}</span>${voice}</div>
      <h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
      <div class="tags">${[...a.parties.map((p) => `<span class="tag static" style="border-color:${partyColour(p)}">${esc(p)}</span>`), ...a.topics.slice(0, 3).map((t) => `<span class="tag static">${esc(t)}</span>`), ...(a.tax || []).map((t) => `<span class="tag static tax">${esc(t)}</span>`)].join("")}${worldChips(a.countries)}</div>
    </div></li>`;
  }
  function drawWestminsterFeed() {
    const groups = homeState.wf === "all" ? ["News", "Party voices", "Analysis"] : [homeState.wf];
    const list = homeArts(groups, 14).filter((a) => a.source !== "House of Commons Library");
    $("wf-list").innerHTML = list.slice(0, 14).map(homeStory).join("") || `<li class="empty">Nothing in this group in the last 14 days.</li>`;
    $("wf-count").textContent = `${nf(list.length)} articles in the last 14 days from ${nf(new Set(list.map((a) => a.source)).size)} sources. Party-aligned sites are labelled.`;
  }

  /* ---------- tax and economy ---------- */
  function fmtInd(ind, v) {
    if (v == null) return "\u2013";
    if (ind.unit === "\u00a3bn") return `\u00a3${v.toFixed(1)}<small>bn</small>`;
    if (ind.unit === "% of GDP") return `${v.toFixed(1)}<small>% of GDP</small>`;
    return `${v.toFixed(ind.key === "bank" ? 2 : 1)}<small>%</small>`;
  }
  function drawTax() {
    const h = H();
    if (!h) { $("indicators").innerHTML = `<p class="hint">Tax and economy data appears after the next update.</p>`; return; }
    homePreviewNote();
    const dates = (h.key_dates || []).filter((d) => dayDiff(d.date) >= 0).sort((a, b) => a.date.localeCompare(b.date));
    const budget = dates.find((d) => /budget/i.test(d.label));
    $("countdown").innerHTML = budget ? `<a href="${esc(budget.url)}" target="_blank" rel="noopener" class="cd">
        <span class="cd-n">${nf(dayDiff(budget.date))}</span><span class="cd-l">days to the Autumn Budget</span>
        <span class="cd-d">${new Date(budget.date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}, with the OBR forecast</span></a>` : "";
    $("indicators").innerHTML = h.indicators.map((ind) => {
      const s = ind.series || [], last = s[s.length - 1], prev = s[s.length - 2];
      const ch = last && prev ? last.v - prev.v : null;
      const good = ch == null || !ind.good || Math.abs(ch) < 1e-9 ? "flat" : (ch > 0) === (ind.good === "up") ? "good" : "bad";
      const chTxt = ch == null ? "" : `<span class="ind-ch ${good}">${ch > 0 ? "\u25b2" : ch < 0 ? "\u25bc" : "\u25cf"} ${Math.abs(ch).toFixed(ind.unit === "\u00a3bn" ? 1 : 1)}${ind.unit === "\u00a3bn" ? "bn" : "pt"} on ${esc(prev.d)}</span>`;
      return `<a class="ind" href="${esc(ind.url)}" target="_blank" rel="noopener">
        <span class="ind-l">${esc(ind.label)}</span><span class="ind-v">${fmtInd(ind, last?.v)}</span>
        <span class="ind-d">${esc(last?.d || "")} \u00b7 ${esc(ind.source)}</span>${chTxt}
        ${ind.note ? `<span class="ind-note">${esc(ind.note)}</span>` : ""}
        <span class="ind-spark" data-k="${esc(ind.key)}"></span></a>`;
    }).join("");
    for (const ind of h.indicators) if ((ind.series || []).length >= 3) spark(document.querySelector(`.ind-spark[data-k="${ind.key}"]`), ind.series.map((x) => x.v));

    drawTaxFeed();
    $("tf-filter").onclick = (e) => { const b = e.target.closest("button[data-g]"); if (!b) return; homeState.tf = b.dataset.g;
      $("tf-filter").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawTaxFeed(); };
    drawBars($("tax-issues"), countBy(homeArts(null, 14), (a) => a.tax), { limit: 9, empty: "No taxes named in the last 14 days." });
    $("key-dates").innerHTML = [...dates.map((d) => ({ date: d.date, label: d.label, kind: d.kind, url: d.url })),
      ...d3.groups(h.elections.filter((e) => e.level === "ballot" && dayDiff(e.date) >= 0), (e) => e.date).slice(0, 3).map(([d, l]) => ({ date: d, label: `${l.length} council ${l.length === 1 ? "contest" : "contests"}`, kind: "Elections" }))]
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6)
      .map((d) => `<li><span class="kd-date"><b>${longDate(d.date)}</b>${inDays(dayDiff(d.date))}</span><span class="kd-l">${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}</a>` : esc(d.label)}<small>${esc(d.kind)}</small></span></li>`).join("");
  }
  function drawTaxFeed() {
    const groups = homeState.tf === "all" ? ["Government", "Tax and fiscal", "Economy news"] : [homeState.tf];
    const list = homeArts(groups, 45);
    $("tf-list").innerHTML = list.slice(0, 14).map(homeStory).join("") || `<li class="empty">Nothing in this group yet.</li>`;
    $("tf-count").textContent = `${nf(list.length)} items from ${nf(new Set(list.map((a) => a.source)).size)} sources.`;
  }
  function spark(el, vals) {
    if (!el) return;
    const W = 120, Hh = 30, x = d3.scaleLinear().domain([0, vals.length - 1]).range([2, W - 4]), y = d3.scaleLinear().domain(d3.extent(vals)).nice().range([Hh - 3, 3]);
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${Hh}`).attr("aria-hidden", "true");
    svg.append("path").attr("class", "sp-area").attr("d", d3.area().x((v, i) => x(i)).y0(Hh).y1((v) => y(v))(vals));
    svg.append("path").attr("class", "sp-line").attr("d", d3.line().x((v, i) => x(i)).y((v) => y(v))(vals));
    svg.append("circle").attr("class", "sp-end").attr("cx", x(vals.length - 1)).attr("cy", y(vals[vals.length - 1])).attr("r", 2.6);
  }


  /* ============================================================ across the desks */
  const go = (v) => { if (!$("dossier").hidden) closeDossier(true); showView(v); setHash(v === "overview" ? "" : v); };
  const worldChips = (cs) => (cs || []).filter((c) => c !== "United Kingdom" && c !== "European Union").slice(0, 4)
    .map((c) => `<button type="button" class="tag world-link" data-c="${esc(c)}" title="Open the World Desk dossier">${esc(c)}</button>`).join("");
  function wireWorldLinks(el) { el.addEventListener("click", (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); }); }

  /* ---------- Home Desk at a glance, on the Overview ---------- */
  function drawGlance() {
    const h = D.home, el = $("glance"); if (!el) return;
    if (!h) { el.innerHTML = `<p class="hint">The Home Desk appears after its first update.</p>`; return; }
    const tiles = [];
    const b = (h.key_dates || []).find((d) => /budget/i.test(d.label) && dayDiff(d.date) >= 0);
    if (b) tiles.push(["tax", "Autumn Budget", `${nf(dayDiff(b.date))}<small> days</small>`, longDate(b.date) + ", with the OBR forecast"]);
    const next = d3.groups(h.elections.filter((e) => e.level === "ballot" && dayDiff(e.date) >= 0), (e) => e.date).sort((x, y) => x[0].localeCompare(y[0]))[0];
    if (next) tiles.push(["politics", "Next polling day", longDate(next[0]), `${nf(next[1].length)} ${next[1].length === 1 ? "contest" : "contests"}: ${next[1].slice(0, 3).map((e) => esc(e.org)).join(", ")}${next[1].length > 3 ? "\u2026" : ""}`]);
    const seats = h.parties || [], total = d3.sum(seats, (p) => p.seats), gov = seats.find((p) => p.name === h.government);
    const nonVoting = d3.sum(seats.filter((p) => p.name === "Speaker" || p.name === "Sinn F\u00e9in"), (p) => p.seats);
    if (gov) tiles.push(["politics", `${esc(gov.name)} working majority`, nf(gov.seats - (total - gov.seats - nonVoting)), `${nf(gov.seats)} of ${nf(total)} seats`]);
    const att = countBy(homeArts(["News", "Analysis", "Economy news"]), (a) => a.parties)[0];
    if (att) tiles.push(["politics", "Most-covered party this week", esc(att[0]), `${nf(att[1])} mentions in news and analysis`]);
    const tax = countBy(homeArts(null, 14), (a) => a.tax)[0];
    if (tax) tiles.push(["tax", "Tax in the news", esc(tax[0]), `Named in ${nf(tax[1])} ${tax[1] === 1 ? "story" : "stories"} over 14 days`]);
    const story = homeArts(["News", "Analysis"], 3)[0] || homeArts(["Party voices"], 3)[0];
    el.innerHTML = tiles.map(([v, k, val, sub]) => `<button type="button" class="g-tile" data-go="${v}"><span class="g-k">${k}</span><span class="g-v">${val}</span><span class="g-s">${sub}</span></button>`).join("") +
      (story ? `<a class="g-story" href="${esc(story.url)}" target="_blank" rel="noopener"><span class="g-k">Latest from Westminster</span><span class="g-t">${esc(story.title)}</span><span class="g-s">${esc(story.source)}, ${ago(story.published)}</span></a>` : "");
    el.onclick = (e) => { const t = e.target.closest("[data-go]"); if (t) go(t.dataset.go); };
    document.querySelector(".desk-home-panel .desk-jump").onclick = (e) => { e.preventDefault(); go("politics"); };
  }

  /* ---------- weekly summary ---------- */
  const strip = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.textContent.replace(/\s+/g, " ").trim(); };
  function buildWeekly() {
    const week = items().filter((i) => within(i.published, 7)), prev = items().filter((i) => ageDays(i.published) > 7 && ageDays(i.published) <= 14);
    const world = [], home = [];
    const top = countBy(week, (i) => i.countries).filter(([c]) => c !== "European Union").slice(0, 5);
    if (top.length) world.push(["Coverage", `Most covered: ${top.map(([c, n]) => `${cLink(c)} (${nf(n)})`).join(", ")}.`]);
    if (!RISK) computeRisk();
    const r3 = RISK.rows.slice(0, 3);
    if (r3.length) world.push(["Risk", `Highest Depth Index: ${r3.map((r) => `${cLink(r.c)} ${r.score} (${bandOf(r.score)[1]})`).join(", ")}.`]);
    const th = countBy(week, (i) => i.themes).slice(0, 3);
    if (th.length) world.push(["Themes", `Busiest themes: ${th.map(([k, n]) => {
      const p = prev.filter((i) => i.themes.includes(k)).length;
      return `<b>${esc(D.meta.themes[k]?.label || k)}</b> (${nf(n)}${p ? `, ${n >= p ? "up" : "down"} ${Math.round(Math.abs(n - p) / p * 100)}% on last week` : ""})`; }).join("; ")}.`]);
    if (D.sanctions) {
      const wk = D.sanctions.recent.filter((r) => within(r.first_seen, 7));
      world.push(["Sanctions", `<b>${nf(wk.length)}</b> new listings this week${wk.filter((r) => r.type === "Vessel").length ? `, ${nf(wk.filter((r) => r.type === "Vessel").length)} of them vessels` : ""}; ${nf(D.sanctions.recent_total)} in 30 days.`]);
    }
    const ch = chokeStats().sort((a, b) => b.cur - a.cur)[0];
    if (ch && ch.cur) world.push(["Shipping", `<b>${esc(ch.name)}</b> was the most-mentioned chokepoint, in ${nf(ch.cur)} stories.`]);
    const brent = D.energy?.series?.["Brent crude ($/bbl)"];
    if (brent?.length > 5) { const a = brent[brent.length - 1], b = brent.find((p) => p.date >= d3.timeFormat("%Y-%m-%d")(d3.timeDay.offset(new Date(a.date), -7))) || brent[brent.length - 6];
      world.push(["Energy", `Brent crude at <b>$${a.value.toFixed(2)}</b>, ${a.value >= b.value ? "up" : "down"} ${Math.abs((a.value - b.value) / b.value * 100).toFixed(1)}% on the week (to ${fmtDate(a.date)}).`]); }
    const h = D.home;
    if (h) {
      const seats = h.parties || [], total = d3.sum(seats, (p) => p.seats), gov = seats.find((p) => p.name === h.government);
      const nv = d3.sum(seats.filter((p) => p.name === "Speaker" || p.name === "Sinn F\u00e9in"), (p) => p.seats);
      if (gov) home.push(["Commons", `${esc(gov.name)} holds ${nf(gov.seats)} of ${nf(total)} seats, a working majority of <b>${nf(gov.seats - (total - gov.seats - nv))}</b>.`]);
      const att = countBy(homeArts(["News", "Analysis", "Economy news"]), (a) => a.parties).slice(0, 3);
      if (att.length) home.push(["Parties", `Most covered: ${att.map(([p, n]) => `<b>${esc(p)}</b> (${nf(n)})`).join(", ")}.`]);
      const tp = countBy(homeArts(["News", "Analysis", "Party voices"]), (a) => a.topics).slice(0, 3);
      if (tp.length) home.push(["Westminster", `Talking about: ${tp.map(([t]) => esc(t.toLowerCase())).join(", ")}.`]);
      const ballots = h.elections.filter((e) => e.level === "ballot");
      const soon = ballots.filter((e) => dayDiff(e.date) >= 0 && dayDiff(e.date) <= 7);
      if (soon.length) home.push(["Elections", `<b>${nf(soon.length)}</b> council ${soon.length === 1 ? "contest" : "contests"} in the next 7 days, including ${soon.slice(0, 3).map((e) => esc(`${e.org}`)).join(", ")}.`]);
      const b = (h.key_dates || []).find((d) => /budget/i.test(d.label) && dayDiff(d.date) >= 0);
      const tx = countBy(homeArts(null, 7), (a) => a.tax).slice(0, 3);
      if (b || tx.length) home.push(["Tax", `${b ? `Autumn Budget <b>${inDays(dayDiff(b.date))}</b>. ` : ""}${tx.length ? `Taxes in the news: ${tx.map(([t]) => esc(t.toLowerCase())).join(", ")}.` : ""}`]);
      const cpi = h.indicators.find((i) => i.key === "cpi"), bank = h.indicators.find((i) => i.key === "bank");
      const cl = cpi?.series?.[cpi.series.length - 1], bl = bank?.series?.[bank.series.length - 1];
      if (cl || bl) home.push(["Economy", `${cl ? `CPI inflation ${cl.v.toFixed(1)}% (${esc(cl.d)})` : ""}${cl && bl ? "; " : ""}${bl ? `Bank Rate ${bl.v.toFixed(2)}%` : ""}.`]);
      const pet = h.petitions[0];
      if (pet) home.push(["Petitions", `Most signed: \u201c${esc(pet.title)}\u201d, ${nf(pet.signatures)} signatures.`]);
    }
    if (D.uk) {
      const acts = D.uk.whitehall.filter((w) => within(w.published, 7) && w.kind !== "travel_advice");
      if (acts.length) home.push(["UK response", `${nf(acts.length)} Whitehall publications on foreign, security and energy policy this week, latest: <a href="${esc(acts[0].url)}" target="_blank" rel="noopener">${esc(acts[0].title)}</a>.`]);
    }
    const distinct = (list, n) => { const seen = new Set(), out = []; for (const x of list) { if (seen.has(x.source)) continue; seen.add(x.source); out.push(x); if (out.length === n) break; } return out; };
    const heads = R_.clusterEvents(week).filter((e) => e.themes.some((t) => HOT_THEMES.has(t))).slice(0, 6).map((e) => ({ ...e.lead, source: `${e.lead.source}${e.outlets > 1 ? ` and ${e.outlets - 1} more` : ""}` }));
    const hheads = h ? distinct(homeArts(["News", "Analysis", "Tax and fiscal"], 7), 6) : [];
    return { world, home, heads, hheads };
  }
  function drawWeekly() {
    const w = buildWeekly();
    const end = new Date(), start = d3.timeDay.offset(end, -6);
    const period = `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} to ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
    $("wk-period").textContent = `The seven days ${period}, written from Fathom's data on both desks.`;
    const li = ([k, t]) => `<li><span class="brief-kind">${k}</span><span>${t}</span></li>`;
    $("wk-world").innerHTML = w.world.map(li).join("") || `<li class="hint">Not enough data yet.</li>`;
    $("wk-home").innerHTML = w.home.map(li).join("") || `<li class="hint">Not enough data yet.</li>`;
    const st = (i) => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a><span>${esc(i.source)}, ${ago(i.published)}</span></li>`;
    $("wk-heads-world").innerHTML = w.heads.map(st).join("");
    $("wk-heads-home").innerHTML = w.hheads.map(st).join("");
    [$("wk-world"), $("wk-home")].forEach((el) => { el.onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); }; });
    const text = [`Fathom weekly: ${period}`, "", "WORLD DESK", ...w.world.map(([k, t]) => `\u2022 ${k}: ${strip(t)}`), "", "HOME DESK", ...w.home.map(([k, t]) => `\u2022 ${k}: ${strip(t)}`),
      "", "Headlines", ...w.heads.slice(0, 4).map((i) => `\u2022 ${i.title} (${i.source})`), "", "Fathom, geopolitical risk sounded daily. Built by Evan Coles."].join("\n");
    $("wk-text").value = text;
    $("wk-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(text); $("wk-copy").textContent = "Copied"; setTimeout(() => { $("wk-copy").textContent = "Copy as text"; }, 2000); }
      catch (e) { $("wk-text").hidden = false; $("wk-text").focus(); $("wk-text").select(); $("wk-note").hidden = false; $("wk-note").textContent = "Your browser blocked copying. The text is selected below: press Ctrl+C (or \u2318C)."; }
    };
  }


  /* ============================================================ early warning, events, profiles, track record */
  const fullDays = () => Object.values(D.scores?.days || {}).filter((d) => !d.partial).length;
  function drawWarnings() {
    const el = $("ew-list"); if (!el) return;
    const series = scoreSeries(), warn = R_.warnings(series);
    const have = fullDays();
    if (!warn.length) {
      el.innerHTML = `<li class="ew-empty">${have < 4 ? `Swell warnings start once Fathom has stored 4 full days of scores. It has ${nf(have)} so far, and adds one every day.` : "No country is rising unusually fast right now."}</li>`;
      badgeOverview(0); return;
    }
    el.innerHTML = warn.slice(0, 6).map((w) => {
      const [, band, cls] = bandOf(w.now);
      return `<li><button type="button" data-c="${esc(w.c)}">
        <span class="ew-name">${esc(w.c)}${w.approaching ? `<small>Approaching High</small>` : ""}</span>
        <span class="ew-spark" data-s="${esc(w.c)}"></span>
        <span class="ew-num"><b class="band ${cls}">${w.now}</b><small>+${w.rise} in ${w.days} days</small></span></button></li>`;
    }).join("");
    el.querySelectorAll("[data-s]").forEach((sp) => lineSpark(sp, series[sp.dataset.s].slice(-8).map((p) => p.s)));
    el.onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); };
    badgeOverview(warn.length);
  }
  function badgeOverview(n) { const b = $("badge-overview"); if (b) { b.textContent = n ? nf(n) : ""; b.title = n ? "Early warnings" : ""; } }

  function drawDevelopments() {
    const el = $("dev-list"); if (!el) return;
    const ev = events().filter((e) => (e.outlets >= 2 || e.intensity >= 0.7) && e.countries.some((c) => c !== "United Kingdom") && e.themes.length).slice(0, 8);
    el.innerHTML = ev.map((e) => {
      const lead = e.lead, escal = R_.escOf(lead).esc.length > 0;
      const srcs = [...e.sources.keys()];
      return `<li><span class="dev-weight" title="Event weight from ${nf(e.outlets)} outlets"><b>${nf(e.outlets)}</b>${e.outlets === 1 ? "outlet" : "outlets"}</span>
        <div><a href="${esc(lead.url)}" target="_blank" rel="noopener">${esc(lead.title)}</a>
        <span class="dev-meta">${esc(srcs.slice(0, 3).join(", "))}${srcs.length > 3 ? ` and ${nf(srcs.length - 3)} more` : ""} \u00b7 ${ago(new Date(e.last).toISOString())}${escal ? ` <span class="chip-s warn">Escalation</span>` : ""}</span>
        <span class="tags">${worldChips(e.countries)}</span></div></li>`;
    }).join("") || `<li class="hint">Not enough stories in the last 48 hours yet.</li>`;
    el.onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); };
  }

  function drawPillarMap() {
    const t = $("pillar-map"); if (!t) return;
    const R = RISK && RISK.model === "v2" ? RISK : R_.score(riskInput({ model: "v2" }));
    const keys = Object.keys(PILLARS), rows = R.rows.slice(0, 15);
    const q = (v) => v >= 80 ? 5 : v >= 65 ? 4 : v >= 45 ? 3 : v >= 25 ? 2 : v > 0 ? 1 : 0;
    t.innerHTML = `<thead><tr><th>Country</th><th>Index</th>${keys.map((k) => `<th>${esc(PILLARS[k].label)}</th>`).join("")}</tr></thead><tbody>` +
      rows.map((r) => `<tr tabindex="0" data-c="${esc(r.c)}"><th>${esc(r.c)}</th><td class="pm-index">${r.score}</td>${keys.map((k) => { const v = r.pillars[k]; return `<td class="q${q(v)}" title="${esc(PILLARS[k].label)}: ${v}">${v || "\u2013"}</td>`; }).join("")}</tr>`).join("") + "</tbody>";
    t.onclick = (e) => { const tr = e.target.closest("tr[data-c]"); if (tr) openDossier(tr.dataset.c); };
  }

  function drawTrack() {
    const el = $("track"); if (!el) return;
    const tr = R_.trackRecord(D.scores?.days || {});
    if (!tr.ready) {
      el.innerHTML = `<div class="track-building"><span class="tb-n">${nf(tr.days)}<small> of ${nf(tr.need)} days</small></span>
        <p>The Logbook opens once ${nf(tr.need)} full days of scores are stored. Fathom will then report how often a High or Severe rating was followed within 7 days by a burst of sanctions listings or a spike in escalatory coverage, and compare that with countries rated below High. Scores are saved every day by the free GitHub run.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="kpis">
      <dl class="kpi"><dt>High or Severe ratings logged</dt><dd>${nf(tr.flagged)}</dd></dl>
      <dl class="kpi"><dt>Followed by trouble within 7 days</dt><dd>${Math.round(tr.hitRate * 100)}<small>%</small></dd></dl>
      <dl class="kpi"><dt>Same rate for other countries</dt><dd>${Math.round(tr.baseRate * 100)}<small>%</small></dd></dl>
      <dl class="kpi"><dt>Lift</dt><dd>${tr.lift ? tr.lift.toFixed(1) + "\u00d7" : "\u2013"}</dd></dl></div>
      <p class="hint">Over ${nf(tr.days)} stored days. "Trouble" means 3 or more new sanctions listings, or escalatory coverage at least double the country's recent normal. ${tr.examples.length ? `Recent hits: ${tr.examples.map((x) => `${esc(x.c)} (${x.s} on ${fmtDate(x.day)})`).join(", ")}.` : ""}</p>`;
  }

  /* ---------- small charts ---------- */
  function lineSpark(el, vals) {
    if (!el || vals.length < 2) return;
    const W = 90, Hh = 26, x = d3.scaleLinear().domain([0, vals.length - 1]).range([2, W - 4]), y = d3.scaleLinear().domain(d3.extent(vals)).nice().range([Hh - 3, 3]);
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${Hh}`).attr("aria-hidden", "true");
    svg.append("path").attr("class", "sp-line warm").attr("d", d3.line().x((v, i) => x(i)).y((v) => y(v))(vals));
    svg.append("circle").attr("class", "sp-end warm").attr("cx", x(vals.length - 1)).attr("cy", y(vals[vals.length - 1])).attr("r", 2.6);
  }
  function radar(el, r) {
    const keys = Object.keys(PILLARS), n = keys.length, W = 360, Hh = 250, cx = W / 2, cy = 124, R = 82;
    const pt = (i, v) => { const a = -Math.PI / 2 + (i / n) * 2 * Math.PI; return [cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v]; };
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${Hh}`).attr("role", "img")
      .attr("aria-label", keys.map((k) => `${PILLARS[k].label} ${r.pillars[k]}`).join(", "));
    [0.25, 0.5, 0.75, 1].forEach((f) => svg.append("polygon").attr("class", "rd-grid").attr("points", keys.map((k, i) => pt(i, f).join(",")).join(" ")));
    keys.forEach((k, i) => { const [x, y] = pt(i, 1); svg.append("line").attr("class", "rd-axis").attr("x1", cx).attr("y1", cy).attr("x2", x).attr("y2", y); });
    svg.append("polygon").attr("class", "rd-shape").attr("points", keys.map((k, i) => pt(i, r.pillars[k] / 100).join(",")).join(" "));
    keys.forEach((k, i) => {
      const [x, y] = pt(i, r.pillars[k] / 100); svg.append("circle").attr("class", "rd-dot").attr("cx", x).attr("cy", y).attr("r", 3);
      const [lx, ly] = pt(i, 1.2), anchor = Math.abs(lx - cx) < 8 ? "middle" : lx > cx ? "start" : "end";
      const g = svg.append("text").attr("class", "rd-label").attr("x", lx).attr("y", ly + (ly < cy ? -2 : 8)).attr("text-anchor", anchor);
      g.append("tspan").text(PILLARS[k].label.split(" ")[0]);
      g.append("tspan").attr("class", "rd-val").attr("dx", 5).text(r.pillars[k]);
    });
  }
  function scoreHistory(el, c) {
    const pts = (scoreSeries()[c] || []).slice(-60);
    if (pts.length < 2) { el.innerHTML = `<p class="hint">The depth chart starts today and grows by one point a day.</p>`; return; }
    const W = 420, Hh = 130, m = { t: 8, r: 30, b: 20, l: 4 };
    const x = d3.scalePoint().domain(pts.map((p) => p.d)).range([m.l, W - m.r]), y = d3.scaleLinear().domain([0, 100]).range([Hh - m.b, m.t]);
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${Hh}`).attr("role", "img").attr("aria-label", `${c} Depth Index over ${pts.length} days, now ${pts[pts.length - 1].s}`);
    [[45, "Elevated"], [65, "High"], [80, "Severe"]].forEach(([v, l]) => { svg.append("line").attr("class", "gridline").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(v)).attr("y2", y(v)); svg.append("text").attr("class", "lane-label").attr("x", W - m.r + 4).attr("y", y(v) + 3).text(v); });
    svg.append("path").attr("class", "sh-line").attr("d", d3.line().x((p) => x(p.d)).y((p) => y(p.s))(pts));
    svg.append("g").selectAll("circle").data(pts).join("circle").attr("class", (p) => `sh-dot ${p.partial ? "partial" : ""}`).attr("cx", (p) => x(p.d)).attr("cy", (p) => y(p.s)).attr("r", 3)
      .on("mousemove", (ev, p) => showTip(`<strong>${fmtDate(p.d)}</strong>Depth Index ${p.s}${p.partial ? "<br>Partial week of data" : ""}${p.live ? "<br>Live score" : ""}`, ev)).on("mouseleave", hideTip);
    const ticks = pts.filter((p, i) => i === 0 || i === pts.length - 1 || i % Math.ceil(pts.length / 4) === 0);
    svg.append("g").attr("class", "axis").selectAll("text").data(ticks).join("text").attr("x", (p) => x(p.d)).attr("y", Hh - 4).attr("text-anchor", "middle").text((p) => fmtDate(p.d));
  }


  /* ============================================================ masthead: waterline and signal lock */
  /* "FATHOM" decodes out of noise onto a waterline, its reflection ripples, a sounding lead drops in
     every few seconds, and a console types out today's readings from both desks. */
  function drawMasthead() {
    const word = $("mh-word"), refl = $("mh-refl"), con = $("mh-console"); if (!word || !con) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const WORD = "FATHOM", GLYPH = "#%&@$*+=<>/\\|01AEKMQRXZ";
    const NS = "http://www.w3.org/2000/svg";
    const mk = (parent) => [...WORD].map(() => { const t = document.createElementNS(NS, "tspan"); parent.appendChild(t); return t; });
    word.textContent = ""; refl.textContent = "";
    const A = mk(word), B = mk(refl);

    // the readings, from the live data
    const R = RISK || computeRisk(), top = R.rows[0];
    const feeds = D.status?.feeds || [], ok = feeds.filter((f) => f.ok).length;
    const week = items().filter((i) => within(i.published, 7)).length;
    const swell = (() => { try { return R_.warnings(scoreSeries()).length; } catch (e) { return 0; } })();
    const budget = (D.home?.key_dates || []).find((d) => /budget/i.test(d.label) && dayDiff(d.date) >= 0);
    const lines = [
      [`sounding ${ok || feeds.length || 35} sources`, ""],
      [`${nf(week)} stories tagged this week`, ""],
      [`${nf(R.rows.length)} countries scored`, ""],
      top ? ["deepest reading  ", `hi:${top.c.toUpperCase()} ${top.score} ${bandOf(top.score)[1].toUpperCase()}`] : null,
      ["swell warnings   ", swell ? `hi:${swell}` : "mut:none"],
      budget ? ["home desk        ", `wm:BUDGET IN ${dayDiff(budget.date)} DAYS`] : null,
      ["signal locked ", "ok:\u2713"],
    ].filter(Boolean);
    const fmt = ([t, x]) => `<span class="p">&gt;</span> ${esc(t)}${x ? `<span class="${x.split(":")[0]}">${esc(x.split(":").slice(1).join(":"))}</span>` : ""}`;

    const settle = () => { A.forEach((t, i) => { t.textContent = WORD[i]; t.removeAttribute("class"); }); B.forEach((t, i) => { t.textContent = WORD[i]; }); };
    if (reduce) { settle(); con.innerHTML = lines.map(fmt).join("\n"); return; }

    // 1. decode the name, letter by letter
    let f = 0; const lockAt = A.map((_, i) => 10 + i * 6);
    (function tick() {
      A.forEach((t, i) => {
        const ch = f >= lockAt[i] ? WORD[i] : GLYPH[(Math.random() * GLYPH.length) | 0];
        t.textContent = ch; B[i].textContent = ch;
        if (f >= lockAt[i]) t.removeAttribute("class"); else t.setAttribute("class", "scr");
      });
      f++;
      if (f <= lockAt[lockAt.length - 1]) setTimeout(tick, 45); else { settle(); typeLine(0, 0); }
    })();
    // 2. type the readings
    function typeLine(li, ci) {
      const done = lines.slice(0, li).map(fmt).join("\n");
      if (li >= lines.length) { con.innerHTML = done + '\n<span class="p">&gt;</span> <span class="cur">&nbsp;</span>'; return; }
      const [txt] = lines[li];
      if (ci <= txt.length) { con.innerHTML = (done ? done + "\n" : "") + `<span class="p">&gt;</span> ${esc(txt.slice(0, ci))}<span class="cur">&nbsp;</span>`; setTimeout(() => typeLine(li, ci + 1), 20); }
      else setTimeout(() => typeLine(li + 1, 0), 180);
    }
    // 3. the water: a slow ripple, and a sounding lead every 9 seconds
    const turb = $("mh-turb"), rings = $("mh-rings"), lead = $("mh-lead"), cord = $("mh-cord");
    let t = 0, drop = -1;
    (function frame() {
      if (!document.hidden && currentView === "overview") {
        t++;
        turb.setAttribute("baseFrequency", `${(0.012 + Math.sin(t / 90) * 0.002).toFixed(4)} ${(0.09 + Math.sin(t / 60) * 0.02).toFixed(4)}`);
        if (t % 540 === 150) drop = 0;
        if (drop >= 0) {
          drop++;
          const y = Math.min(99, -10 + drop * 3.2);
          lead.setAttribute("transform", `translate(0 ${y + 10})`); cord.setAttribute("y2", y); lead.style.opacity = 1; cord.style.opacity = 1;
          if (y >= 99 && !rings.childNodes.length) for (let k = 0; k < 3; k++) { const e = document.createElementNS(NS, "ellipse"); e.setAttribute("class", "mh-ring"); e.setAttribute("cx", 560); e.setAttribute("cy", 99); e.dataset.k = k; rings.appendChild(e); }
          rings.querySelectorAll("ellipse").forEach((e) => { const age = drop - 34 - e.dataset.k * 10; if (age < 0) return; e.setAttribute("rx", age * 1.5); e.setAttribute("ry", age * 0.3); e.setAttribute("opacity", Math.max(0, 1 - age / 70).toFixed(2)); });
          if (drop > 150) { drop = -1; rings.textContent = ""; lead.style.opacity = 0; cord.style.opacity = 0; lead.setAttribute("transform", "translate(0 0)"); cord.setAttribute("y2", 0); }
        }
      }
      requestAnimationFrame(frame);
    })();
  }

  /* ============================================================ analyst tools */
  /* ---------- per-viewer memory (watchlist, last visit); every access may fail in private windows ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(`fathom.${k}`); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(`fathom.${k}`, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const VISIT = { prev: null };
  let watch = [];
  const isWatched = (c) => watch.includes(c);
  function toggleWatch(c) {
    watch = isWatched(c) ? watch.filter((x) => x !== c) : [...watch, c];
    store.set("watch", watch);
    drawWatch(); syncWatchButton(c);
  }
  function syncWatchButton(c) {
    const b = $("dossier-watch"); if (!b) return;
    const on = isWatched(c);
    b.setAttribute("aria-pressed", String(on));
    b.innerHTML = `<span aria-hidden="true">${on ? "\u2605" : "\u2606"}</span> ${on ? "Watching" : "Watch"}`;
  }

  /* ---------- daily brief: the headline facts, written from the data ---------- */
  function drawBrief() {
    if (!RISK) computeRisk();
    const week = items().filter((i) => within(i.published, 7));
    const lines = [];
    const top = RISK.rows[0];
    if (top) {
      const [, band] = bandOf(top.score);
      lines.push(["Risk", `${cLink(top.c)} leads the Depth Index at <b>${top.score}</b> (${band}), named in ${nf(top.n)} stories this week.`]);
    }
    const sig = computeSignals()[0];
    if (sig) lines.push(["Spike", `${sig.kind === "Country" ? cLink(sig.key) : `<b>${esc(sig.label)}</b>`} coverage is <b>${sig.ratio.toFixed(1)}\u00d7</b> its usual level, with ${nf(sig.c)} stories in the last 24 hours.`]);
    const th = countBy(week, (i) => i.themes)[0];
    if (th && week.length) lines.push(["Theme", `<b>${esc(D.meta.themes[th[0]]?.label || th[0])}</b> is the busiest theme, in ${Math.round((th[1] / week.length) * 100)}% of this week's stories.`]);
    if (D.sanctions) {
      const v = D.sanctions.recent.filter((r) => r.type === "Vessel").length;
      lines.push(["Sanctions", `<b>${nf(D.sanctions.recent_total)}</b> new sanctions listings in the last 30 days${v ? `, ${nf(v)} of them vessels` : ""}.`]);
    }
    if (D.uk) {
      const act = D.uk.whitehall.find((w) => w.kind !== "travel_advice");
      if (act) lines.push(["UK", `Latest UK action: <a href="${esc(act.url)}" target="_blank" rel="noopener">${esc(act.title)}</a> <span class="muted">(${esc(act.orgs[0] || "GOV.UK")}, ${ago(act.published)})</span>.`]);
      const g = attentionRows().filter((r) => r.ns >= 0.05).sort((a, b) => a.ratio - b.ratio)[0];
      if (g && g.ratio < 0.67) lines.push(["Gap", `${cLink(g.country)} has ${Math.round(g.ns * 100)}% of global coverage but only ${Math.round(g.ws * 100)}% of Westminster's attention.`]);
    }
    if (D.home) {
      const b = (D.home.key_dates || []).find((d) => /budget/i.test(d.label) && dayDiff(d.date) >= 0);
      const next = d3.groups(D.home.elections.filter((e) => e.level === "ballot" && dayDiff(e.date) >= 0), (e) => e.date).sort((x, y) => x[0].localeCompare(y[0]))[0];
      const bits = [];
      if (b) bits.push(`the Autumn Budget is <b>${inDays(dayDiff(b.date))}</b>`);
      if (next) bits.push(`${nf(next[1].length)} council ${next[1].length === 1 ? "contest" : "contests"} ${inDays(dayDiff(next[0]))}`);
      if (bits.length) lines.push(["Home", `${bits.join("; ").replace(/^./, (c) => c.toUpperCase())}.`]);
    }
    $("brief-list").innerHTML = lines.map(([k, t]) => `<li><span class="brief-kind">${k}</span><span>${t}</span></li>`).join("") || `<li class="hint">The brief appears once there is a week of data.</li>`;
    $("brief-time").textContent = `Written from data updated ${ago(D.status?.updated || D.news?.updated)}`;
    $("brief").onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) openDossier(b.dataset.c); };
    drawWatch();
  }
  const cLink = (c) => `<button type="button" class="inline-link" data-c="${esc(c)}">${esc(c)}</button>`;

  function drawWatch() {
    const el = $("watch-list"); if (!el) return;
    const since = VISIT.prev ? new Date(VISIT.prev) : new Date(Date.now() - DAY);
    $("watch-since").textContent = VISIT.prev ? `New since your last visit, ${ago(VISIT.prev)}` : "New in the last 24 hours";
    if (!watch.length) {
      el.innerHTML = `<li class="watch-empty">Open a country and choose <b>\u2606 Watch</b> to follow it here. Your list stays in this browser.</li>`;
      return;
    }
    el.innerHTML = watch.map((c) => {
      const mine = items().filter((i) => i.countries.includes(c));
      const fresh = mine.filter((i) => new Date(i.published) > since).length;
      const uk = ukActions(c).filter((a) => new Date(a.published) > since).length;
      const r = RISK?.byName.get(c);
      return `<li><button type="button" data-c="${esc(c)}">
        <span class="w-name">${esc(c)}</span>
        <span class="w-score">${r ? `${r.score} <small>${bandOf(r.score)[1]}</small>` : "<small>Not scored</small>"}</span>
        <span class="w-new ${fresh ? "on" : ""}">${fresh ? `${nf(fresh)} new ${fresh === 1 ? "story" : "stories"}` : "No new stories"}${uk ? `, ${nf(uk)} UK` : ""}</span>
      </button></li>`;
    }).join("");
  }

  /* ---------- response timeline: daily global coverage with UK actions on top ---------- */
  function drawTimeline(el, c, { W: Wd, H = 150, days = 14 } = {}) {
    el.innerHTML = "";
    const W = Math.max(280, Wd || el.clientWidth || 600), lane = 26, m = { t: 6, r: 34, b: 22, l: 0 };
    const counts = dailySeries((i) => i.countries.includes(c), days);
    const end = d3.timeDay.floor(new Date());
    const dayList = d3.range(days).map((i) => d3.timeDay.offset(end, i - days + 1));
    const x = d3.scaleBand().domain(d3.range(days)).range([m.l, W - m.r]).padding(0.2);
    const y = d3.scaleLinear().domain([0, Math.max(4, d3.max(counts))]).nice(3).range([H - m.b, m.t + lane + 6]);
    const acts = ukActions(c).map((a) => ({ ...a, d: days - 1 - Math.floor((end - d3.timeDay.floor(new Date(a.published))) / DAY) })).filter((a) => a.d >= 0 && a.d < days);
    const byDay = d3.group(acts, (a) => a.d);
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", `${c}: global stories per day over ${days} days, with ${acts.length} UK actions marked`);
    svg.append("g").selectAll("line").data(y.ticks(3)).join("line").attr("class", "gridline")
      .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
    svg.append("g").attr("class", "axis").attr("transform", `translate(${W - m.r + 6},0)`).call(d3.axisRight(y).ticks(3).tickSize(0));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(d3.range(days).filter((i) => (days - 1 - i) % 3 === 0)).tickSize(0).tickPadding(7).tickFormat((i) => d3.timeFormat("%-d %b")(dayList[i])));
    svg.append("text").attr("class", "lane-label").attr("x", m.l).attr("y", m.t + 10).text("UK actions");
    svg.append("line").attr("class", "lane-rule").attr("x1", m.l).attr("x2", W - m.r).attr("y1", m.t + lane).attr("y2", m.t + lane);
    const bw = x.bandwidth(), r0 = Math.min(4, bw / 2);
    svg.append("g").selectAll("path").data(counts.map((v, i) => ({ v, i }))).join("path")
      .attr("class", "tl-bar")
      .attr("d", (d) => { const x0 = x(d.i), y0 = y(d.v), h = y(0) - y0; if (h <= 0) return ""; const r = Math.min(r0, h); return `M${x0},${y(0)}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${y(0)}Z`; });
    const marks = [];
    for (const [d, list] of byDay) list.slice(0, 3).forEach((a, k) => marks.push({ d, k, list }));
    svg.append("g").selectAll("path").data(marks).join("path").attr("class", "tl-mark")
      .attr("d", (mk) => { const cx = x(mk.d) + bw / 2 + (mk.k - (Math.min(3, mk.list.length) - 1) / 2) * 9, cy = m.t + lane / 2 + 2, s = 5.5; return `M${cx},${cy - s}L${cx + s},${cy}L${cx},${cy + s}L${cx - s},${cy}Z`; });
    // one wide hover target per day: bigger than the marks, shows both measures together
    svg.append("g").selectAll("rect").data(d3.range(days)).join("rect")
      .attr("x", (i) => x(i) - (x.step() - bw) / 2).attr("width", x.step()).attr("y", m.t).attr("height", H - m.b - m.t).style("fill", "transparent")
      .on("mousemove", (ev, i) => {
        const list = byDay.get(i) || [];
        showTip(`<strong>${fmtDate(dayList[i])}</strong>${nf(counts[i])} ${counts[i] === 1 ? "story" : "stories"} naming ${esc(c)}` +
          (list.length ? `<br>${list.slice(0, 4).map((a) => `\u25c6 ${esc(a.label)}: ${esc(a.title.length > 70 ? a.title.slice(0, 68) + "\u2026" : a.title)}`).join("<br>")}${list.length > 4 ? `<br>+${list.length - 4} more` : ""}` : ""), ev);
      })
      .on("mouseleave", hideTip);
    return acts.length;
  }

  function drawUKTimeline() {
    if (!D.uk) return;
    const sel = $("tl-country");
    const rows = attentionRows();
    if (!rows.length) { $("uk-timeline-wrap").hidden = true; return; }
    if (!sel.options.length) {
      const best = rows.slice().sort((a, b) => ukActions(b.country).filter((x) => within(x.published, 14)).length - ukActions(a.country).filter((x) => within(x.published, 14)).length)[0];
      sel.innerHTML = rows.map((r) => `<option value="${esc(r.country)}" ${r === best ? "selected" : ""}>${esc(r.country)}</option>`).join("");
      sel.onchange = drawUKTimeline;
    }
    const n = drawTimeline($("uk-timeline"), sel.value);
    $("tl-note").textContent = `${nf(n)} UK ${n === 1 ? "action" : "actions"} on ${sel.value} in the last 14 days. Hover a day for details.`;
  }

  /* ---------- finder: one search over countries, stories and UK documents ---------- */
  const finder = { hits: [], at: 0 };
  function openFinder() {
    $("finder").hidden = false; document.body.style.overflow = "hidden";
    const q = $("finder-q"); q.value = ""; runFinder(); q.focus();
  }
  function closeFinder() { $("finder").hidden = true; if ($("dossier").hidden) document.body.style.overflow = ""; }
  function runFinder() {
    const q = $("finder-q").value.trim().toLowerCase();
    const countries = [...new Set([...items().flatMap((i) => i.countries), ...(D.uk?.attention || []).map((a) => a.country)])]
      .filter((c) => c !== "European Union" && (!q || c.toLowerCase().includes(q)))
      .map((c) => ({ c, n: items().filter((i) => i.countries.includes(c) && within(i.published, 7)).length }))
      .sort((a, b) => (q && b.c.toLowerCase().startsWith(q)) - (q && a.c.toLowerCase().startsWith(q)) || b.n - a.n).slice(0, q ? 5 : 6);
    const stories = q.length < 2 ? [] : items().filter((i) => `${i.title} ${i.source}`.toLowerCase().includes(q)).slice(0, 5);
    const docs = q.length < 2 ? [] : [...(D.uk?.whitehall || []).map((w) => ({ ...w, label: kindName(w.kind) })), ...(D.uk?.laws || []).map((l) => ({ ...l, label: "Law" })),
      ...(D.home?.articles || []).map((a) => ({ ...a, label: a.source })), ...(D.home?.elections || []).filter((e) => e.level === "ballot").map((e) => ({ title: e.title, published: e.date, label: "Election", url: `https://whocanivotefor.co.uk/elections/${e.id}/` }))]
      .filter((w) => w.title.toLowerCase().includes(q)).slice(0, 6);
    finder.hits = [
      ...countries.map((r) => ({ kind: "Country", title: r.c, sub: `${nf(r.n)} stories this week`, act: () => { closeFinder(); openDossier(r.c); } })),
      ...stories.map((i) => ({ kind: "Story", title: i.title, sub: `${i.source}, ${ago(i.published)}`, url: i.url })),
      ...docs.map((w) => ({ kind: "UK", title: w.title, sub: `${w.label}, ${shortDate(w.published)}`, url: w.url })),
    ];
    finder.at = 0;
    const hl = (t) => { const s = esc(t); if (!q) return s; const i = t.toLowerCase().indexOf(q); return i < 0 ? s : esc(t.slice(0, i)) + `<mark>${esc(t.slice(i, i + q.length))}</mark>` + esc(t.slice(i + q.length)); };
    $("finder-results").innerHTML = finder.hits.length ? finder.hits.map((h, i) => `<li role="option" id="fh-${i}" aria-selected="${i === 0}">
        ${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener" tabindex="-1">` : `<button type="button" tabindex="-1" data-i="${i}">`}
        <span class="f-kind">${h.kind}</span><span class="f-title">${hl(h.title)}</span><span class="f-sub">${esc(h.sub)}</span>
        ${h.url ? "</a>" : "</button>"}</li>`).join("")
      : `<li class="f-empty">Nothing matches \u201c${esc(q)}\u201d. Try a country, a vessel or a department.</li>`;
    $("finder-q").setAttribute("aria-activedescendant", finder.hits.length ? "fh-0" : "");
  }
  function moveFinder(d) {
    if (!finder.hits.length) return;
    finder.at = (finder.at + d + finder.hits.length) % finder.hits.length;
    $("finder-results").querySelectorAll("li[role=option]").forEach((li, i) => li.setAttribute("aria-selected", String(i === finder.at)));
    $(`fh-${finder.at}`)?.scrollIntoView({ block: "nearest" });
    $("finder-q").setAttribute("aria-activedescendant", `fh-${finder.at}`);
  }
  function setupFinder() {
    $("finder-open").onclick = openFinder;
    $("finder").onclick = (e) => {
      if (e.target === $("finder")) return closeFinder();
      const b = e.target.closest("button[data-i]"); if (b) finder.hits[+b.dataset.i].act();
      if (e.target.closest("a")) closeFinder();
    };
    $("finder-q").oninput = runFinder;
    $("finder-q").onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveFinder(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveFinder(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const h = finder.hits[finder.at]; if (!h) return;
        if (h.act) h.act(); else { $(`fh-${finder.at}`).querySelector("a").click(); closeFinder(); }
      } else if (e.key === "Escape") closeFinder();
    };
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); openFinder(); }
    });
  }

  /* ---------- shareable dossier links: #c-Saudi_Arabia ---------- */
  const tokenOf = (c) => /^[A-Za-z][A-Za-z .-]*$/.test(c) ? `c-${c.replace(/ /g, "_")}` : "";
  const countryOfToken = (t) => (t || "").startsWith("c-") ? t.slice(2).replace(/_/g, " ") : "";
  function setHash(t) { try { history.replaceState(null, "", t ? `#${t}` : location.pathname + location.search); } catch (e) { /* sandboxed */ } }
  async function copyDossierLink(c) {
    const t = tokenOf(c), framed = window.top !== window;
    const text = framed ? `#${t}` : `${location.href.split("#")[0]}#${t}`;
    const b = $("dossier-link");
    try { await navigator.clipboard.writeText(text); b.textContent = framed ? `Copied #${t}` : "Link copied"; }
    catch (e) { b.textContent = `#${t}`; }
    $("dossier-link-note").hidden = !framed;
    $("dossier-link-note").textContent = `Add #${t} to the end of this page's address to open ${c} directly.`;
    setTimeout(() => { b.textContent = "Copy link"; }, 2400);
  }
  function openFromHash() {
    const c = countryOfToken(decodeURIComponent(location.hash.slice(1)));
    if (c && items().some((i) => i.countries.includes(c))) openDossier(c);
  }

  function attentionRows() {
    const rows = (D.uk?.attention || []).map((r) => ({ ...r }));
    const nTot = d3.sum(rows, (r) => r.news_7d) || 1, wTot = d3.sum(rows, (r) => r.contributions) || 1;
    rows.forEach((r) => { r.ns = r.news_7d / nTot; r.ws = r.contributions / wTot; r.ratio = (r.ws + 0.01) / (r.ns + 0.01); });
    return rows.sort((a, b) => b.ns - a.ns);
  }

  /* ============================================================ advanced layer */

  /* ---------- shared helpers ---------- */
  function dailySeries(pred, days = 14) {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const arr = new Array(days).fill(0);
    for (const i of items()) if (pred(i)) {
      const d = Math.floor((end - new Date(i.published)) / DAY);
      if (d >= 0 && d < days) arr[days - 1 - d]++;
    }
    return arr;
  }
  function sparkBars(container, arr, { W = 200, H = 30, split = 7, label = "stories", lastHot = false } = {}) {
    const end = new Date(); end.setHours(12, 0, 0, 0);
    const gap = 2, bw = (W - gap * (arr.length - 1)) / arr.length, max = Math.max(1, ...arr);
    const svg = d3.select(container).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "none").attr("aria-hidden", "true");
    svg.selectAll("rect").data(arr.map((v, i) => ({ v, i }))).join("rect")
      .attr("x", (d) => d.i * (bw + gap)).attr("width", bw)
      .attr("y", (d) => H - Math.max(1.5, (d.v / max) * H)).attr("height", (d) => Math.max(1.5, (d.v / max) * H)).attr("rx", 1.2)
      .style("fill", (d) => css(lastHot && d.i === arr.length - 1 ? "--signal" : d.i >= arr.length - split ? "--bar" : "--bar-soft"))
      .on("mousemove", (ev, d) => showTip(`<strong>${fmtDate(new Date(end - (arr.length - 1 - d.i) * DAY))}</strong>${nf(d.v)} ${label}`, ev))
      .on("mouseleave", hideTip);
    return svg;
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const regionOf = (c) => D.meta.countries?.[c];
  const regionLabel = (c) => D.meta.regions[regionOf(c)]?.label || "";

  /* ---------- clocks ---------- */
  const CLOCKS = [["UTC", "UTC"], ["London", "Europe/London"], ["Washington", "America/New_York"], ["Brussels", "Europe/Brussels"],
    ["Kyiv", "Europe/Kyiv"], ["Moscow", "Europe/Moscow"], ["Tehran", "Asia/Tehran"], ["Beijing", "Asia/Shanghai"], ["Tokyo", "Asia/Tokyo"]];
  function drawClocks() {
    const now = new Date();
    $("clocks").innerHTML = CLOCKS.map(([city, tz]) => {
      let t; try { t = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }); } catch (e) { t = "\u2013"; }
      return `<div class="clock ${city === "UTC" ? "utc" : ""}"><span>${city}</span><b>${t}</b></div>`;
    }).join("");
  }

  /* ---------- signals (spike detection) ---------- */
  function computeSignals() {
    const now = Date.now();
    const out = [];
    const test = (kind, key, label, pred) => {
      let c = 0, b = 0;
      for (const i of items()) {
        if (!pred(i)) continue;
        const a = (now - new Date(i.published)) / DAY;
        if (a <= 1) c++; else if (a <= 14) b++;
      }
      const avg = b / 13, ratio = (c + 1) / (avg + 1);
      if (c >= 3 && ratio >= 1.6) out.push({ kind, key, label, c, avg, ratio, pred });
    };
    for (const [k, t] of Object.entries(D.meta.themes)) test("Theme", k, t.label, (i) => i.themes.includes(k));
    for (const [k, r] of Object.entries(D.meta.regions)) test("Region", k, r.label, (i) => i.regions.includes(k));
    const names = new Set(items().flatMap((i) => i.countries));
    for (const c of names) test("Country", c, c, (i) => i.countries.includes(c));
    return out.sort((a, b) => b.ratio - a.ratio).slice(0, 5);
  }
  function drawSignals() {
    const el = $("signals"); el.innerHTML = "";
    const sigs = computeSignals();
    if (!sigs.length) { el.innerHTML = `<p class="signals-empty">No unusual spikes in the last 24 hours. Coverage is close to its normal level everywhere.</p>`; return; }
    for (const s of sigs) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "signal";
      b.setAttribute("aria-label", `${s.kind} ${s.label}: ${s.ratio.toFixed(1)} times usual volume, ${s.c} stories in 24 hours`);
      b.innerHTML = `<span class="signal-kind">${s.kind} spike</span><span class="signal-name">${esc(s.label)}</span>
        <span class="signal-ratio">${s.ratio.toFixed(1)}\u00d7<small>usual volume</small></span>
        <span class="signal-detail">${nf(s.c)} stories in 24 hours, against ${s.avg.toFixed(1)} on an average day</span>`;
      el.appendChild(b);
      sparkBars(b, dailySeries(s.pred), { W: 220, H: 28, split: 1, lastHot: true });
      b.onclick = () => {
        if (s.kind === "Country") return openDossier(s.key);
        if (s.kind === "Theme") { state.theme = s.key; $("f-theme").value = s.key; }
        if (s.kind === "Region") { state.region = s.key; $("f-region").value = s.key; }
        state.days = 1; $("f-days").value = "1"; refresh(); showView("news");
      };
    }
  }

  /* ---------- risk index ----------
     The scoring itself lives in risk.js, shared with the daily GitHub run (score.js), so the
     dashboard and the stored history always agree. */
  const R_ = window.FathomRisk;
  const MODELS = R_.MODELS, PILLARS = R_.PILLARS;
  const WEIGHTS = MODELS.v2.weights;
  const ACLED_TO_NAME = { "Democratic Republic of Congo": "DR Congo", "Republic of Congo": "Republic of Congo", "Cote d'Ivoire": "Ivory Coast", "C\u00f4te d'Ivoire": "Ivory Coast", "eSwatini": "Eswatini" };
  const BANDS = R_.BANDS;
  const bandOf = R_.bandOf;
  let RISK = null;
  let riskModel = "v2";

  function conflictByCountry(days) {
    const m = new Map();
    for (const e of D.conflict?.events || []) {
      if (!within(e.date, days + 0.5)) continue;
      const c = ACLED_TO_NAME[e.country] || e.country;
      const r = m.get(c) || { ev: 0, fat: 0 };
      r.ev++; r.fat += e.fatalities || 0; m.set(c, r);
    }
    return m;
  }
  function riskInput(extra = {}) {
    return { items: items(), history: D.history, sanctions: D.sanctions, ukLaws: D.uk?.laws || [], countries: D.meta.countries || {}, isoOf,
      conflict: (D.conflict?.events || []).map((e) => ({ ...e, country: ACLED_TO_NAME[e.country] || e.country })), ...extra };
  }
  function computeRisk() {
    RISK = R_.score(riskInput({ model: riskModel }));
    return RISK;
  }
  let EVENTS = null;
  const events = () => EVENTS || (EVENTS = R_.clusterEvents(items().filter((i) => within(i.published, 2))));

  /* daily score series per country: stored days from scores.json, with today's live score on the end */
  let SERIES = null;
  function scoreSeries() {
    if (SERIES) return SERIES;
    const out = {}, days = D.scores?.days || {};
    for (const k of Object.keys(days).sort()) for (const [c, r] of Object.entries(days[k].c || {})) (out[c] = out[c] || []).push({ d: k, s: r.s, p: r.p, partial: !!days[k].partial });
    const today = d3.timeFormat("%Y-%m-%d")(new Date()), live = riskModel === "v2" ? RISK || computeRisk() : R_.score(riskInput({ model: "v2" }));
    for (const r of live.rows) {
      const arr = out[r.c] = out[r.c] || [];
      const last = arr[arr.length - 1];
      const pt = { d: today, s: r.score, p: Object.values(r.pillars || {}), partial: last ? last.partial : true, live: true };
      if (last && last.d === today) arr[arr.length - 1] = pt; else arr.push(pt);
    }
    return (SERIES = out);
  }

  function deltaHtml(n, p) {
    if (!p && !n) return `<span class="delta flat">\u2013</span>`;
    if (!p) return `<span class="delta rise">New</span>`;
    const pct = p ? ((n - p) / p) * 100 : 100;
    const cls = Math.abs(pct) < 5 ? "flat" : pct > 0 ? "rise" : "fall";
    return `<span class="delta ${cls}">${cls === "flat" ? "Level" : `${pct > 0 ? "\u25b2" : "\u25bc"} ${Math.abs(pct).toFixed(0)}%`}</span>`;
  }

  const CONF_CLS = { High: "ok", Medium: "", Low: "warn" };
  function drawRisk() {
    const R = computeRisk(), { rows } = R;
    const top = rows.slice(0, 15), v2 = R.model === "v2";
    const keys = Object.keys(R.weights).filter((k) => R.weights[k] > 0);
    const t = $("risk-table");
    t.innerHTML = `<thead><tr><th>#</th><th>Country</th><th>Index</th><th>Band</th>${v2 ? "<th>Confidence</th><th>Drivers</th>" : "<th>Change</th>"}<th>Stories, 7 days</th><th>14-day trend</th></tr></thead><tbody>` +
      (top.length ? top.map((r) => {
        const [, band, cls] = bandOf(r.score);
        const drivers = keys.map((k) => `<span class="drv" title="${esc(R.label[k])}: ${Math.round(r.parts[k] * 100)}"><i style="height:${Math.max(6, Math.round(r.parts[k] * 100))}%"></i><b>${esc(R.label[k].slice(0, 3).toUpperCase())}</b></span>`).join("");
        return `<tr tabindex="0" data-c="${esc(r.c)}" aria-label="${esc(r.c)}, ${v2 ? "Depth" : "Surface"} Index ${r.score}, ${band}${v2 ? `, ${r.confidence} confidence` : ""}. Open dossier.">
          <td class="risk-rank">${r.rank}</td>
          <td class="risk-name">${esc(r.c)}<small>${esc(regionLabel(r.c))}</small></td>
          <td><span class="score"><b>${r.score}</b><span class="score-track"><i class="${cls}" style="width:${r.score}%;background:var(--sev-${cls.slice(2)})"></i></span></span></td>
          <td><span class="band ${cls}">${band}</span></td>
          ${v2 ? `<td><span class="chip-s ${CONF_CLS[r.confidence]}">${r.confidence}</span></td><td><span class="drivers">${drivers}</span></td>` : `<td>${deltaHtml(r.n, r.p)}</td>`}
          <td class="num">${nf(r.n)}</td>
          <td class="trend-cell" data-trend="${esc(r.c)}"></td></tr>`;
      }).join("") : `<tr><td colspan="8" class="hint">Not enough stories yet to score countries.</td></tr>`) + "</tbody>";
    t.querySelectorAll("[data-trend]").forEach((td) => sparkBars(td, dailySeries((i) => i.countries.includes(td.dataset.trend)), { W: 90, H: 24 }));
    t.onclick = (e) => { const tr = e.target.closest("tr[data-c]"); if (tr) openDossier(tr.dataset.c); };
    t.onkeydown = (e) => { const tr = e.target.closest("tr[data-c]"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDossier(tr.dataset.c); } };
    $("risk-model-note").textContent = v2
      ? `${MODELS.v2.name}. Baselines: ${nf(Math.min(90, R.baseDays))} of 90 days of history collected${R.baseDays < 28 ? ", so attention leans on share of coverage until a month has built up" : ""}. Drivers: ${keys.map((k) => `${R.label[k].slice(0, 3).toUpperCase()} ${R.label[k].toLowerCase()}`).join(", ")}.`
      : `${MODELS.v1.name}: Fathom's original score, built only from how much coverage a country gets.`;
    $("risk-model").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === R.model)));
    $("risk-model").onclick = (e) => {
      const b = e.target.closest("button[data-m]"); if (!b || b.dataset.m === riskModel) return;
      riskModel = b.dataset.m; SERIES = null; drawRisk(); drawWorld();
    };
    $("weights").innerHTML = keys.map((k) => `<li><b>${Math.round(R.weights[k] * 100)}%</b><span>${R.text[k]}</span></li>`).join("");
    const mv = $("method-model"); if (mv) mv.textContent = `${keys.length} parts`;
  }

  /* ---------- co-mention network ---------- */
  function drawNetwork() {
    const el = $("network"); el.innerHTML = ""; el.classList.remove("focus");
    const week = items().filter((i) => within(i.published, 7));
    const counts = countBy(week, (i) => i.countries).filter(([c]) => c !== "European Union").slice(0, 26);
    if (counts.length < 3) { el.innerHTML = `<p class="hint" style="padding:16px">Not enough stories yet to draw connections.</p>`; return; }
    const keep = new Set(counts.map(([c]) => c));
    const pair = new Map();
    for (const i of week) {
      const cs = [...new Set(i.countries.filter((c) => keep.has(c)))].sort();
      for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
        const k = `${cs[a]}|${cs[b]}`; pair.set(k, (pair.get(k) || 0) + 1);
      }
    }
    const nodes = counts.map(([c, n]) => ({ id: c, n }));
    const links = [...pair.entries()].map(([k, w]) => { const [s, t] = k.split("|"); return { source: s, target: t, w }; });
    const linked = new Set(links.flatMap((l) => [l.source, l.target]));
    const use = nodes.filter((n) => linked.has(n.id) || n.n >= counts[Math.min(8, counts.length - 1)][1]);
    const W = Math.max(300, el.clientWidth || 460), H = Math.round(W / 1.15);
    const r = d3.scaleSqrt().domain([1, d3.max(use, (d) => d.n)]).range([4, 17]);
    const sim = d3.forceSimulation(use)
      .force("link", d3.forceLink(links).id((d) => d.id).distance((l) => 70 - Math.min(35, l.w * 6)).strength((l) => Math.min(0.9, 0.12 + l.w * 0.12)))
      .force("charge", d3.forceManyBody().strength(-170))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("x", d3.forceX(W / 2).strength(0.06)).force("y", d3.forceY(H / 2).strength(0.08))
      .force("collide", d3.forceCollide((d) => r(d.n) + 12))
      .stop();
    for (let k = 0; k < 320; k++) sim.tick();
    for (const n of use) { n.x = clamp(n.x, 24, W - 24); n.y = clamp(n.y, 20, H - 20); }
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("aria-hidden", "true");
    const linkSel = svg.append("g").selectAll("line").data(links.filter((l) => typeof l.source === "object")).join("line")
      .attr("class", "net-link").attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y).attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y)
      .attr("stroke-width", (l) => 1 + Math.sqrt(l.w) * 1.4);
    const nodeSel = svg.append("g").selectAll("circle").data(use).join("circle")
      .attr("class", "net-node").attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("r", (d) => r(d.n));
    const labelled = W < 520 ? new Set(use.slice().sort((a, b) => b.n - a.n).slice(0, 10).map((d) => d.id)) : null;
    const labelSel = svg.append("g").selectAll("text").data(labelled ? use.filter((d) => labelled.has(d.id)) : use).join("text")
      .attr("class", "net-label").attr("y", (d) => d.y + 4).text((d) => d.id)
      .attr("text-anchor", (d) => (d.x > W * 0.68 ? "end" : "start"))
      .attr("x", (d) => (d.x > W * 0.68 ? d.x - r(d.n) - 4 : d.x + r(d.n) + 4));
    const neighbours = (id) => new Set([id, ...links.filter((l) => l.source.id === id || l.target.id === id).flatMap((l) => [l.source.id, l.target.id])]);
    nodeSel
      .on("mouseenter", (ev, d) => {
        const nb = neighbours(d.id); el.classList.add("focus");
        nodeSel.classed("on", (n) => nb.has(n.id)); labelSel.classed("on", (n) => nb.has(n.id));
        linkSel.classed("on", (l) => l.source.id === d.id || l.target.id === d.id);
        const top = links.filter((l) => l.source.id === d.id || l.target.id === d.id).sort((a, b) => b.w - a.w).slice(0, 3)
          .map((l) => `${esc(l.source.id === d.id ? l.target.id : l.source.id)} (${l.w})`).join(", ");
        showTip(`<strong>${esc(d.id)}</strong>${nf(d.n)} stories this week${top ? `<br>Most often with ${top}` : ""}`, ev);
      })
      .on("mousemove", (ev) => { tip.style.left = `${ev.clientX + 14}px`; tip.style.top = `${ev.clientY + 14}px`; })
      .on("mouseleave", () => { el.classList.remove("focus"); nodeSel.classed("on", false); labelSel.classed("on", false); linkSel.classed("on", false); hideTip(); })
      .on("click", (ev, d) => { hideTip(); openDossier(d.id); });
  }

  /* ---------- chokepoints ---------- */
  const CHOKE = [
    { name: "Strait of Hormuz", lat: 26.6, lon: 56.4, kw: ["hormuz"] },
    { name: "Bab el-Mandeb and Red Sea", lat: 12.6, lon: 43.3, kw: ["bab el-mandeb", "red sea", "houthi", "houthis"] },
    { name: "Suez Canal", lat: 30.6, lon: 32.3, kw: ["suez"] },
    { name: "Turkish Straits and Black Sea", lat: 41.1, lon: 29.05, kw: ["bosporus", "bosphorus", "dardanelles", "turkish straits", "black sea"] },
    { name: "Baltic and Danish Straits", lat: 55.6, lon: 12.7, kw: ["baltic", "danish straits", "great belt", "oresund"] },
    { name: "Strait of Malacca", lat: 2.6, lon: 101.2, kw: ["malacca", "singapore strait"] },
    { name: "Taiwan Strait", lat: 24.3, lon: 119.6, kw: ["taiwan strait"] },
    { name: "South China Sea", lat: 13, lon: 114, kw: ["south china sea", "spratly", "scarborough shoal", "second thomas shoal"] },
    { name: "Panama Canal", lat: 9.1, lon: -79.7, kw: ["panama canal"] },
    { name: "Cape of Good Hope", lat: -34.4, lon: 18.5, kw: ["cape of good hope", "around the cape", "via the cape"] },
  ];
  for (const c of CHOKE) c.re = new RegExp(`(?<![\\w-])(${c.kw.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "i");
  const chokeHit = (c) => (i) => c.re.test(`${i.title} ${i.summary}`);
  function chokeStats() {
    return CHOKE.map((c) => {
      const s = dailySeries(chokeHit(c));
      return { ...c, series: s, cur: s.slice(7).reduce((a, b) => a + b, 0), prev: s.slice(0, 7).reduce((a, b) => a + b, 0) };
    });
  }
  function drawChokepoints() {
    const el = $("chokepoints"); el.innerHTML = "";
    const stats = chokeStats().sort((a, b) => b.cur - a.cur);
    for (const c of stats) {
      const card = document.createElement("button");
      card.type = "button"; card.className = `choke pulse-card ${c.cur ? "" : "quiet"}`;
      card.innerHTML = `<span class="choke-name">${esc(c.name)}</span>
        <span class="choke-row"><span class="choke-n">${nf(c.cur)}</span>${c.cur || c.prev ? deltaHtml(c.cur, c.prev) : `<span class="delta flat">Quiet</span>`}</span>
        <span class="choke-sub">stories in 7 days</span>`;
      el.appendChild(card);
      sparkBars(card, c.series, { W: 200, H: 30 });
      card.onclick = () => { state.q = c.kw[0]; $("f-search").value = c.kw[0]; state.days = 14; $("f-days").value = "14"; refresh(); showView("news"); };
    }
  }

  /* ---------- dossier ---------- */
  let lastFocus = null;
  let ISO = null;
  function isoOf(name) {
    if (!ISO) {
      ISO = new Map(Object.entries({ "United States": "US", "DR Congo": "CD", "Republic of Congo": "CG", "Ivory Coast": "CI", "Palestine": "PS", "Kosovo": "XK" }));
      if (regionNames) for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        try { const n = regionNames.of(code); if (n && n !== code && !ISO.has(n)) ISO.set(n, code); } catch (e) { /* not a region */ }
      }
    }
    return ISO.get(name);
  }

  function openDossier(c) {
    if (!RISK) computeRisk();
    const r = RISK.byName.get(c);
    const mine = items().filter((i) => i.countries.includes(c));
    const week = mine.filter((i) => within(i.published, 7));
    const prev = mine.filter((i) => ageDays(i.published) > 7 && ageDays(i.published) <= 14);
    const conf14 = conflictByCountry(14).get(c) || { ev: 0, fat: 0 };
    const code = isoOf(c);
    const flagged = code && D.sanctions ? D.sanctions.vessels.filter((v) => (v.countries || "").toUpperCase().split(/[;,]/).map((x) => x.trim()).includes(code)).length : 0;
    $("dossier-region").textContent = regionLabel(c) || "Country dossier";
    $("dossier-title").textContent = c;
    syncWatchButton(c);
    $("dossier-watch").onclick = () => toggleWatch(c);
    $("dossier-link").hidden = !tokenOf(c); $("dossier-link-note").hidden = true;
    $("dossier-link").onclick = () => copyDossierLink(c);
    setHash(tokenOf(c));
    const body = $("dossier-body");
    const band = r ? bandOf(r.score) : null;
    body.innerHTML = `
      ${r ? `<div class="dossier-score"><span class="big">${r.score}</span><span><span class="band ${band[2]}">${band[1]}</span><br><span class="of">${RISK.model === "v2" ? "Depth" : "Surface"} Index out of 100, ranked ${r.rank} of ${RISK.rows.length}</span></span></div>
      ${r.confidence ? `<p class="conf-line"><span class="chip-s ${CONF_CLS[r.confidence]}">${r.confidence} confidence</span> ${nf(r.ev.sources)} independent ${r.ev.sources === 1 ? "source" : "sources"} this week, ${nf(r.ev.baseDays)} days of baseline</p>` : ""}
      <ul class="parts">${Object.keys(RISK.weights).filter((k) => RISK.weights[k] > 0).map((k) => `<li><span>${esc(RISK.label[k])}</span><span class="track"><i style="width:${Math.round(r.parts[k] * 100)}%"></i></span><b>${Math.round(r.parts[k] * 100)}</b></li>`).join("")}</ul>`
        : `<p class="hint">Not enough coverage this week to score ${esc(c)}.</p>`}
      ${r?.ev ? `<ul class="evidence">
        <li><b>Attention</b>${r.ev.z == null ? `Baseline still building (${nf(r.ev.baseDays)} of 7 days needed), so this uses share of all coverage.` : `${r.ev.z >= 0 ? "+" : ""}${r.ev.z.toFixed(1)} standard deviations against its own normal over ${nf(r.ev.baseDays)} days.`}</li>
        <li><b>Severity</b>${nf(r.ev.escN)} of ${nf(r.n)} stories use escalatory language${r.ev.escTerms.length ? ` (${r.ev.escTerms.map(esc).join(", ")})` : ""}; ${nf(r.ev.deN)} use de-escalatory language.</li>
        <li><b>Sanctions</b>${nf(r.ev.L)} new listings name ${esc(c)} in 30 days, ${nf(r.ev.V)} sanctioned ${r.ev.V === 1 ? "vessel lists" : "vessels list"} it as their flag state${r.ev.laws ? `, and ${nf(r.ev.laws)} UK sanctions ${r.ev.laws === 1 ? "law names" : "laws name"} it` : ""}.</li>
      </ul>` : ""}
      ${r?.pillars ? `<div class="dossier-twin"><div><h3 class="mini-title">Soundings</h3><div class="radar" id="dossier-radar"></div></div>
        <div><h3 class="mini-title">Depth chart</h3><div class="score-hist" id="dossier-hist"></div></div></div>` : ""}
      <div class="kpis">
        <dl class="kpi"><dt>Stories, 7 days</dt><dd>${nf(week.length)}</dd></dl>
        <dl class="kpi"><dt>Change</dt><dd>${deltaHtml(week.length, prev.length)}</dd></dl>
        <dl class="kpi"><dt>Stories, 14 days</dt><dd>${nf(mine.length)}</dd></dl>
        <dl class="kpi"><dt>Sanctioned vessels linked here</dt><dd>${D.sanctions ? nf(flagged) : "\u2013"}</dd></dl>
      </div>
      <h3 class="mini-title">Stories per day, 14 days</h3><div class="daily" id="dossier-daily"></div>
      <h3 class="mini-title">Main themes</h3><ol class="bars" id="dossier-themes"></ol>
      <h3 class="mini-title">Named alongside</h3><ol class="bars" id="dossier-with"></ol>
      ${D.uk || D.home ? ukDossier(c) : ""}
      <h3 class="mini-title">Latest stories</h3>
      <ol class="dossier-stories">${mine.slice(0, 6).map((i) => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a><span>${esc(i.source)}, ${ago(i.published)}</span></li>`).join("") || `<li class="hint">No stories in the last 14 days.</li>`}</ol>
      <button type="button" class="btn" id="dossier-filter">Show all ${nf(mine.length)} stories in the news feed</button>`;
    sparkBars($("dossier-daily"), dailySeries((i) => i.countries.includes(c)), { W: 420, H: 90 });
    if ($("dossier-timeline")) drawTimeline($("dossier-timeline"), c, { W: 420, H: 120 });
    if ($("dossier-radar") && r) radar($("dossier-radar"), r);
    if ($("dossier-hist")) scoreHistory($("dossier-hist"), c);
    if ($("dossier-home")) $("dossier-home").onclick = () => go("home");
    drawBars($("dossier-themes"), countBy(week, (i) => i.themes).map(([k, n]) => [k, n, D.meta.themes[k]?.label || k]), { limit: 6, empty: "No themes this week." });
    drawBars($("dossier-with"), countBy(week, (i) => i.countries.filter((x) => x !== c && x !== "European Union")), { limit: 6, onClick: (x) => openDossier(x), empty: "No other countries named." });
    $("dossier-filter").onclick = () => { closeDossier(); state.country = c; state.days = 14; $("f-days").value = "14"; refresh(); showView("news"); };
    if ($("dossier").hidden) lastFocus = document.activeElement;
    $("dossier").hidden = false; $("scrim").hidden = false;
    document.body.style.overflow = "hidden";
    $("dossier-body").scrollTop = 0;
    $("dossier-close").focus();
  }
  function ukDossier(c) {
    const att = (D.uk?.attention || []).find((a) => a.country === c);
    const acts = ukActions(c).slice(0, 4);
    const press = (D.home?.articles || []).filter((a) => (a.countries || []).includes(c) && within(a.published, 14)).slice(0, 3);
    if (!att && !acts.length && !press.length) return "";
    return `<div class="home-angle"><p class="kicker kicker-home">Home Desk</p><h3 class="mini-title">The UK angle</h3>
      <div class="timeline small" id="dossier-timeline"></div>
      ${att ? `<p class="hint" style="margin:0 0 6px">${nf(att.contributions)} spoken contributions in Parliament mention ${esc(c)} since ${sinceLabel()}, across ${nf(att.debates)} debate${att.debates === 1 ? "" : "s"} named for it.</p>` : ""}
      <ol class="dossier-stories uk">${acts.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a><span>${esc(a.label)}, ${esc(a.orgs[0] || "")}, ${shortDate(a.published)}</span></li>`).join("") || `<li class="hint">No UK publications on ${esc(c)} in the last 30 days.</li>`}</ol>
      ${press.length ? `<h3 class="mini-title">In UK politics coverage</h3><ol class="dossier-stories uk">${press.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a><span>${esc(a.source)}, ${ago(a.published)}</span></li>`).join("")}</ol>` : ""}
      <button type="button" class="desk-jump home" id="dossier-home">Open the Home Desk</button></div>`;
  }
  function closeDossier(silent) {
    if (!silent) setHash(currentView === "overview" ? "" : currentView);
    $("dossier").hidden = true; $("scrim").hidden = true; document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function setupDossier() {
    $("dossier-close").onclick = closeDossier;
    $("scrim").onclick = closeDossier;
    document.addEventListener("keydown", (e) => {
      if ($("dossier").hidden) return;
      if (e.key === "Escape") closeDossier();
      if (e.key === "Tab") { // keep focus inside the panel
        const f = [...$("dossier").querySelectorAll("button, a[href], [tabindex='0']")];
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
  }

  /* ------------------------------------------------------------ start */
  async function start() {
    const names = ["meta", "news", "history", "scores", "sanctions", "energy", "uk", "home", "status", "world"];
    const res = await Promise.all(names.map(load));
    names.forEach((n, i) => { D[n] = res[i]; });
    // Sample files are only for previewing: never show them as if they were live figures
    for (const n of ["sanctions", "energy"]) if (D[n]?.sample && !D.news?.sample) D[n] = null;
    D.conflict = null;
    VISIT.prev = store.get("lastVisit", null); store.set("lastVisit", new Date().toISOString());
    watch = store.get("watch", []).filter((c) => typeof c === "string");
    if (!D.meta) { document.querySelector("main").innerHTML = `<p class="empty">The dashboard data hasn't been created yet. Run the collector once, then reload.</p>`; return; }
    const safe = (fn) => { try { fn(); } catch (e) { console.error(e); } };
    safe(drawClocks); setInterval(() => safe(drawClocks), 30000);
    safe(drawOverview); safe(setupFilters); safe(setupDossier); $("show-choke").onchange = () => safe(drawWorld); safe(drawWorld);
    safe(drawSignals); safe(drawRisk); safe(drawNetwork); safe(drawChokepoints); safe(drawPulse); safe(drawMatrix); safe(drawFeed);
    safe(drawSanctions); safe(setupEnergyRange); safe(drawEnergy); safe(drawUK); safe(drawStatus); safe(setupNav);
    safe(drawBrief); safe(setupFinder); safe(openFromHash); safe(drawGlance); safe(drawWarnings); safe(drawDevelopments); safe(drawMasthead);
    ["wf-list", "tf-list"].forEach((id) => $(id) && wireWorldLinks($(id)));

    let lastW = window.innerWidth, t;
    window.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(() => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; safe(drawWorld); safe(drawNetwork); safe(drawEnergy); safe(drawUKTimeline); } }, 200);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { safe(drawWorld); safe(drawPulse); safe(drawSignals); safe(drawRisk); safe(drawNetwork); safe(drawChokepoints); safe(drawEnergy); safe(drawUKTimeline); });
  }
  start();
})();
