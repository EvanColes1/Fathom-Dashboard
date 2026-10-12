/* Fathom risk engine.
   One file, used two ways: the dashboard loads it in the browser, and the daily GitHub run
   loads it in Node (score.js) to save every country's score, so the two can never disagree.
   Everything here is plain JavaScript with no libraries. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FathomRisk = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;
  const HOT_THEMES = new Set(["sanctions", "maritime", "conflict", "nuclear"]);
  const BANDS = [[80, "Severe", "b-severe"], [65, "High", "b-high"], [45, "Elevated", "b-elevated"], [25, "Guarded", "b-guarded"], [0, "Low", "b-low"]];
  const bandOf = (s) => BANDS.find(([min]) => s >= min);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const sum = (a, f = (x) => x) => a.reduce((t, x) => t + f(x), 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a, (x) => (x - m) ** 2) / (a.length - 1)); };
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);

  /* ---------- what the coverage says ---------- */
  const ESCALATION = ["airstrike", "air strike", "air raid", "missile", "drone strike", "drone attack", "shelling", "bombard", "offensive", "invasion", "invade",
    "mobilis", "mobiliz", "martial law", "state of emergency", "coup", "assassinat", "massacre", "killed", "casualties", "seize", "seized", "blockade", "escalat",
    "retaliat", "clashes", "explosion", "hostage", "sabotage", "ultimatum", "nuclear test", "ballistic", "ceasefire collapse", "ceasefire violat", "breaks ceasefire", "troops mass"];
  const DEESCALATION = ["truce", "peace talks", "peace deal", "peace agreement", "peace plan", "ceasefire agreed", "ceasefire deal", "ceasefire holds", "agreement reached",
    "de-escalat", "prisoner exchange", "prisoner swap", "talks resume", "withdraws troops", "troop withdrawal", "lifts sanctions", "eases sanctions", "sanctions relief"];
  const termRe = (list) => new RegExp("(?:^|[^a-z])((?:" + list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")[a-z-]*)", "gi");
  const ESC_RE = termRe(ESCALATION), DE_RE = termRe(DEESCALATION);
  const escCache = new Map();
  function escOf(i) {
    const key = i.id || i.url;
    if (escCache.has(key)) return escCache.get(key);
    const text = `${i.title} ${i.summary || ""}`;
    const r = { esc: [...text.matchAll(ESC_RE)].map((m) => m[1].toLowerCase()), de: [...text.matchAll(DE_RE)].map((m) => m[1].toLowerCase()) };
    escCache.set(key, r);
    return r;
  }
  function intensityOf(i) {
    const hot = i.themes.some((t) => HOT_THEMES.has(t)), e = escOf(i);
    return clamp((hot ? 0.55 : 0.15) + (e.esc.length ? 0.35 : 0) - (e.de.length ? 0.2 : 0), 0, 1);
  }

  /* ---------- sources: specialists and think tanks count for more than general wires ---------- */
  const GROUP_WEIGHT = { "Think tank": 1.6, Sanctions: 1.6, Nuclear: 1.4, Maritime: 1.4, Energy: 1.3, Cyber: 1.4, Migration: 1.3, Regional: 1.2, "World news": 1.0 };
  const weightOf = (i) => GROUP_WEIGHT[i.group] || 1.0;

  /* ---------- events: the same story from many outlets becomes one event ---------- */
  const STOP = new Set(("the and for with from that this into over after amid says said will have has are was were its their they them about against than more most new news live update "
    + "latest report reports what who why how when where week year day days could would should may can not but out off his her him she you your our").split(" "));
  function tokens(title) {
    const out = new Set();
    for (let w of (title || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/)) {
      if (w.length < 3 || STOP.has(w)) continue;
      if (w.length > 4 && w.endsWith("s")) w = w.slice(0, -1);
      out.add(w);
    }
    return out;
  }
  function clusterEvents(list, { windowHours = 36, threshold = 0.3 } = {}) {
    const sorted = list.slice().sort((a, b) => a.published.localeCompare(b.published));
    const events = [], index = new Map();
    for (const it of sorted) {
      const tk = tokens(it.title), t = Date.parse(it.published);
      const cands = new Set();
      for (const w of tk) for (const ev of index.get(w) || []) if (t - ev.last <= windowHours * 3600000) cands.add(ev);
      let best = null, bestJ = 0;
      for (const ev of cands) {
        let inter = 0; for (const w of tk) if (ev.tokens.has(w)) inter++;
        const j = inter / (tk.size + ev.tokens.size - inter || 1);
        const sharesPlace = !it.countries.length || !ev.countries.size || it.countries.some((c) => ev.countries.has(c));
        if (inter >= 2 && j >= threshold && sharesPlace && j > bestJ) { best = ev; bestJ = j; }
      }
      if (!best) {
        best = { items: [], tokens: tk, countries: new Set(), themes: new Set(), sources: new Map(), first: t, last: t };
        events.push(best);
        for (const w of tk) { if (!index.has(w)) index.set(w, []); index.get(w).push(best); }
      }
      best.items.push(it); best.last = Math.max(best.last, t);
      it.countries.forEach((c) => best.countries.add(c)); it.themes.forEach((x) => best.themes.add(x));
      best.sources.set(it.source, Math.max(best.sources.get(it.source) || 0, weightOf(it)));
    }
    for (const ev of events) {
      ev.weight = Math.log2(1 + sum([...ev.sources.values()]));
      ev.lead = ev.items.slice().sort((a, b) => weightOf(b) - weightOf(a) || a.published.localeCompare(b.published))[0];
      ev.intensity = Math.max(...ev.items.map(intensityOf));
      ev.countries = [...ev.countries]; ev.themes = [...ev.themes]; ev.outlets = ev.sources.size;
    }
    return events.sort((a, b) => b.weight - a.weight || b.last - a.last);
  }

  /* ---------- pillars: a professional-style risk profile ---------- */
  const PILLARS = {
    political: { label: "Political stability", themes: ["politics"] },
    conflict: { label: "Conflict and security", themes: ["conflict", "nuclear"] },
    sanctions: { label: "Sanctions", themes: ["sanctions"] },
    energy: { label: "Energy and trade", themes: ["energy", "trade"] },
    maritime: { label: "Maritime", themes: ["maritime"] },
    cyber: { label: "Cyber", themes: ["cyber"] },
  };

  const MODELS = {
    v2: {
      name: "Fathom Depth Index",
      weights: { attention: 0.35, severity: 0.30, sanctions: 0.20, momentum: 0.15, conflict: 0 },
      label: { attention: "Attention", severity: "Severity", sanctions: "Sanctions", momentum: "Momentum", conflict: "Conflict" },
      text: {
        attention: "Attention against the country's own normal: this week's daily coverage compared with its average over up to 90 earlier days, blended with its share of all coverage (counted in events, not articles) while the history builds.",
        severity: "Severity: how serious the coverage is. Stories on conflict, sanctions, shipping or nuclear issues count more, escalatory language (airstrikes, mobilisation, blockades) raises a story's weight and de-escalatory language (truce, peace talks) lowers it.",
        sanctions: "Sanctions exposure: new listings naming the country in 30 days, sanctioned vessels under its flag, UK sanctions laws that name it, and the share of its coverage about sanctions.",
        momentum: "Momentum: this week against last week, capped at double or half.",
        conflict: "Conflict: ACLED events and reported deaths in the last 7 days.",
      },
    },
    v1: {
      name: "Surface Index",
      weights: { volume: 0.45, severity: 0.35, momentum: 0.20, conflict: 0 },
      label: { volume: "Volume", severity: "Severity", momentum: "Momentum", conflict: "Conflict" },
      text: {
        volume: "News volume: stories naming the country this week, on a log scale against the most covered country.",
        severity: "Severity: the share of those stories about conflict, sanctions, shipping or nuclear issues.",
        momentum: "Momentum: change on the previous week, capped at double or half.",
        conflict: "Conflict: ACLED events and reported deaths in the last 7 days, on a log scale.",
      },
    },
  };

  /* ---------- scoring ----------
     input: { items, history, sanctions, ukLaws, conflict, countries (name -> region), isoOf, asOf, model }
     asOf lets the daily run score any recent day using only what was known by then. */
  function score(input) {
    const model = input.model || "v2";
    const asOf = input.asOf ? Date.parse(input.asOf) : Date.now();
    const age = (iso) => (asOf - Date.parse(iso)) / DAY;
    const known = input.items.filter((i) => age(i.published) >= 0);
    const week = known.filter((i) => age(i.published) <= 7);
    const prev = known.filter((i) => age(i.published) > 7 && age(i.published) <= 14);
    const regionOf = (c) => input.countries?.[c];
    const countIn = (list) => { const m = new Map(); for (const i of list) for (const c of i.countries) m.set(c, (m.get(c) || 0) + 1); return m; };
    const cw = countIn(week), cp = countIn(prev);
    const conf = new Map();
    for (const e of input.conflict || []) {
      const a = age(e.date); if (a < 0 || a > 7.5) continue;
      const r = conf.get(e.country) || { ev: 0, fat: 0 }; r.ev++; r.fat += e.fatalities || 0; conf.set(e.country, r);
    }
    const hasConf = conf.size > 0;
    const confScore = (r) => (r ? r.ev + r.fat / 2 : 0);
    const maxConf = Math.max(1, ...[...conf.values()].map(confScore));
    const events = clusterEvents(week);
    const evW = new Map(); for (const ev of events) for (const c of ev.countries) evW.set(c, (evW.get(c) || 0) + ev.weight);
    const maxVol = Math.max(1, ...cw.values()), maxEv = Math.max(1, ...evW.values());
    const names = new Set([...cw.keys(), ...conf.keys()]);
    const rows = [];

    if (model === "v1") {
      const M = MODELS.v1, t = 1 - M.weights.conflict;
      const w = hasConf ? M.weights : { volume: M.weights.volume / t, severity: M.weights.severity / t, momentum: M.weights.momentum / t, conflict: 0 };
      for (const c of names) {
        if (c === "European Union" || (!regionOf(c) && !conf.has(c))) continue;
        const n = cw.get(c) || 0, p = cp.get(c) || 0; if (n < 2 && !conf.has(c)) continue;
        const mine = week.filter((i) => i.countries.includes(c));
        const parts = { volume: Math.log1p(n) / Math.log1p(maxVol), severity: n ? mine.filter((i) => i.themes.some((x) => HOT_THEMES.has(x))).length / n : 0,
          momentum: (clamp((n - p) / Math.max(p, 3), -1, 1) + 1) / 2, conflict: hasConf ? Math.log1p(confScore(conf.get(c))) / Math.log1p(maxConf) : 0 };
        rows.push({ c, n, p, parts, score: Math.round(100 * sum(Object.keys(parts), (k) => parts[k] * w[k])), conf: conf.get(c) || { ev: 0, fat: 0 } });
      }
      return finish(rows, { model, weights: w, label: M.label, text: M.text, hasConf, baseDays: 0, events });
    }

    const M = MODELS.v2;
    const w = hasConf ? { attention: 0.30, severity: 0.25, sanctions: 0.15, momentum: 0.10, conflict: 0.20 } : M.weights;
    const listBy = new Map(), vesselBy = new Map();
    for (const r of input.sanctions?.recent || []) {
      if (r.first_seen && age(r.first_seen) < -0.5) continue;
      for (const cc of (r.countries || "").toUpperCase().split(/[;,]/)) if (cc.trim()) listBy.set(cc.trim(), (listBy.get(cc.trim()) || 0) + 1);
    }
    for (const v of input.sanctions?.vessels || []) { const cc = (v.countries || "").toUpperCase().split(/[;,]/)[0]?.trim(); if (cc) vesselBy.set(cc, (vesselBy.get(cc) || 0) + 1); }
    const maxL = Math.max(1, ...listBy.values()), maxV = Math.max(1, ...vesselBy.values());
    const hdays = input.history?.days || {}, hkeys = Object.keys(hdays).sort();
    const today = ymd(asOf), weekStart = ymd(asOf - 6 * DAY);
    const baseKeys = hkeys.filter((k) => k < weekStart).slice(-90), curKeys = hkeys.filter((k) => k >= weekStart && k <= today);
    // pillar maxima, so each pillar is scaled against the most exposed country this week
    const pillarW = {}; for (const p in PILLARS) pillarW[p] = new Map();
    for (const ev of events) for (const p in PILLARS) if (ev.themes.some((t) => PILLARS[p].themes.includes(t))) for (const c of ev.countries) pillarW[p].set(c, (pillarW[p].get(c) || 0) + ev.weight);
    // a floor on the scale means a pillar needs real volume, not one or two stories, to score high
    const pillarMax = {}; for (const p in PILLARS) pillarMax[p] = Math.max(8, ...pillarW[p].values());

    for (const c of names) {
      if (c === "European Union" || (!regionOf(c) && !conf.has(c))) continue;
      const n = cw.get(c) || 0, p = cp.get(c) || 0; if (n < 2 && !conf.has(c)) continue;
      const mine = week.filter((i) => i.countries.includes(c));
      const vol = 0.5 * Math.log1p(n) / Math.log1p(maxVol) + 0.5 * Math.log1p(evW.get(c) || 0) / Math.log1p(maxEv);
      const base = baseKeys.map((k) => hdays[k].c?.[c] || 0), cur = curKeys.map((k) => hdays[k].c?.[c] || 0);
      let z = null, attention = vol;
      if (base.length >= 7 && cur.length) {
        const lb = base.map(Math.log1p);
        z = (mean(cur.map(Math.log1p)) - mean(lb)) / Math.max(sd(lb), 0.25);
        const wb = Math.min(1, base.length / 28);
        attention = wb * (0.6 / (1 + Math.exp(-(z - 0.5) * 1.2)) + 0.4 * vol) + (1 - wb) * vol;
      }
      let escN = 0, deN = 0; const escTerms = new Map();
      const intens = mine.map((i) => { const e = escOf(i); if (e.esc.length) { escN++; e.esc.forEach((t) => escTerms.set(t, (escTerms.get(t) || 0) + 1)); } if (e.de.length) deN++; return intensityOf(i); });
      const severity = mean(intens);
      const code = input.isoOf ? input.isoOf(c) : null, L = code ? listBy.get(code) || 0 : 0, V = code ? vesselBy.get(code) || 0 : 0;
      const laws = (input.ukLaws || []).filter((l) => l.countries.includes(c) && l.themes.includes("sanctions") && age(l.published) >= 0).length;
      const sancShare = n ? mine.filter((i) => i.themes.includes("sanctions")).length / n : 0;
      const sanctions = 0.35 * Math.log1p(L) / Math.log1p(maxL) + 0.30 * Math.log1p(V) / Math.log1p(maxV) + 0.15 * Math.min(1, laws / 2) + 0.20 * Math.min(1, sancShare * 3);
      const momentum = (clamp((n - p) / Math.max(p, 3), -1, 1) + 1) / 2;
      const parts = { attention, severity, sanctions, momentum, conflict: hasConf ? Math.log1p(confScore(conf.get(c))) / Math.log1p(maxConf) : 0 };
      const s = Math.round(100 * sum(Object.keys(parts), (k) => parts[k] * (w[k] || 0)));
      // six pillars, 0-100: how much of the country's coverage falls in each area, and how serious it is
      const pillars = {};
      for (const pk in PILLARS) {
        const ps = mine.filter((i) => i.themes.some((t) => PILLARS[pk].themes.includes(t)));
        const pv = Math.log1p(pillarW[pk].get(c) || 0) / Math.log1p(pillarMax[pk]);
        const pi = ps.length ? mean(ps.map(intensityOf)) : 0;
        let v = ps.length ? (0.55 * pv + 0.45 * pi) * Math.sqrt(Math.min(1, ps.length / 6)) : 0;
        if (pk === "sanctions") v = 0.4 * pv + 0.15 * pi + 0.45 * sanctions;
        if (pk === "conflict" && hasConf) v = 0.5 * v + 0.5 * parts.conflict;
        pillars[pk] = Math.round(100 * clamp(v, 0, 1));
      }
      const sources = new Set(mine.map((i) => i.source)).size;
      const pts = (sources >= 10 ? 2 : sources >= 5 ? 1 : 0) + (base.length >= 28 ? 2 : base.length >= 7 ? 1 : 0) + (n >= 20 ? 1 : 0);
      const confidence = pts >= 4 ? "High" : pts >= 2 ? "Medium" : "Low";
      const evs = events.filter((ev) => ev.countries.includes(c));
      rows.push({ c, iso: code, n, p, parts, score: s, pillars, confidence, conf: conf.get(c) || { ev: 0, fat: 0 },
        ev: { z, baseDays: base.length, sources, events: evs.length, escN, deN, escTerms: [...escTerms].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t), L, V, laws } });
    }
    return finish(rows, { model, weights: w, label: M.label, text: M.text, hasConf, baseDays: baseKeys.length, events });
  }
  function finish(rows, meta) {
    rows.sort((a, b) => b.score - a.score || b.n - a.n);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { ...meta, rows, byName: new Map(rows.map((r) => [r.c, r])) };
  }

  /* ---------- early warning: rising fast for several days, before reaching High ---------- */
  function warnings(series, { minRise = 8, days = 3 } = {}) {
    const out = [];
    for (const [c, pts] of Object.entries(series)) {
      const ok = pts.filter((p) => !p.partial);
      if (ok.length < days + 1) continue;
      const last = ok.slice(-(days + 1)), rise = last[last.length - 1].s - last[0].s;
      let up = 0; for (let i = 1; i < last.length; i++) if (last[i].s > last[i - 1].s) up++;
      const now = last[last.length - 1].s;
      if ((up >= days && rise >= minRise) || rise >= minRise * 1.5) out.push({ c, now, rise, from: last[0].s, days, approaching: now < 65 && now >= 45 });
    }
    return out.sort((a, b) => b.rise - a.rise);
  }

  /* ---------- track record: did High or Severe come before a sanctions burst or an escalation spike? ---------- */
  function trackRecord(scoreDays, { horizon = 7, high = 65 } = {}) {
    const keys = Object.keys(scoreDays).filter((k) => !scoreDays[k].partial).sort();
    if (keys.length < horizon + 7) return { ready: false, days: keys.length, need: horizon + 7 };
    let flagged = 0, flaggedHit = 0, other = 0, otherHit = 0;
    const examples = [];
    for (let d = 7; d < keys.length - horizon; d++) {
      const day = scoreDays[keys[d]].c || {};
      for (const [c, r] of Object.entries(day)) {
        const pastE = keys.slice(Math.max(0, d - 14), d).map((k) => scoreDays[k].c?.[c]?.e || 0);
        const baseE = Math.max(2, mean(pastE) * 2);
        const future = keys.slice(d + 1, d + 1 + horizon).map((k) => scoreDays[k].c?.[c] || {});
        const hit = future.some((f) => (f.e || 0) >= baseE + 1) || sum(future, (f) => f.l || 0) >= 3;
        if (r.s >= high) { flagged++; if (hit) { flaggedHit++; if (examples.length < 5) examples.push({ c, day: keys[d], s: r.s }); } }
        else { other++; if (hit) otherHit++; }
      }
    }
    const hitRate = flagged ? flaggedHit / flagged : 0, baseRate = other ? otherHit / other : 0;
    return { ready: true, days: keys.length, flagged, hitRate, baseRate, lift: baseRate ? hitRate / baseRate : null, examples };
  }

  /* ---------- a compact daily snapshot for the stored history ---------- */
  function snapshot(result, items, sanctions, asOf) {
    const day = ymd(asOf), out = {};
    const todays = items.filter((i) => i.published.slice(0, 10) === day);
    const listings = new Map();
    for (const r of sanctions?.recent || []) if (r.first_seen === day) for (const cc of (r.countries || "").toUpperCase().split(/[;,]/)) if (cc.trim()) listings.set(cc.trim(), (listings.get(cc.trim()) || 0) + 1);
    for (const r of result.rows) {
      const e = todays.filter((i) => i.countries.includes(r.c) && escOf(i).esc.length).length;
      out[r.c] = { s: r.score, p: Object.values(r.pillars || {}), k: r.confidence?.[0] || "", e, l: r.iso ? listings.get(r.iso) || 0 : 0 };
    }
    return out;
  }

  return { score, clusterEvents, warnings, trackRecord, snapshot, escOf, intensityOf, weightOf, bandOf, BANDS, MODELS, PILLARS, HOT_THEMES, GROUP_WEIGHT };
});
