/* Fathom daily scoring: runs on the free GitHub runner after collect.py.
   It scores every country with the same engine the dashboard uses (risk.js) and saves a compact
   daily snapshot to scores.json, so the site can show score history, early warnings and a track record.
   Run: node score.js */
"use strict";
const fs = require("fs");
const path = require("path");
const Risk = require("./risk.js");

const DIR = __dirname;
const KEEP_DAYS = 180;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { return d; } };

// country name -> ISO code, the same way the dashboard does it
const ISO = new Map(Object.entries({ "United States": "US", "DR Congo": "CD", "Republic of Congo": "CG", "Ivory Coast": "CI", "Palestine": "PS", "Kosovo": "XK" }));
try {
  const names = new Intl.DisplayNames(["en-GB"], { type: "region" });
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    try { const n = names.of(code); if (n && n !== code && !ISO.has(n)) ISO.set(n, code); } catch (e) { /* not a region */ }
  }
} catch (e) { /* no ICU data: sanctions matching falls back to none */ }

const news = read("news.json", {}), meta = read("meta.json", {}), history = read("history.json", {}),
  sanctions = read("sanctions.json", null), uk = read("uk.json", null), conflict = read("conflict.json", null);
const items = news.items || [];
if (!items.length) { console.log("score: no news yet, nothing to score"); process.exit(0); }
const old = read("scores.json", {});
const days = old.preview ? {} : old.days || {};

const earliest = items.reduce((m, i) => (i.published < m ? i.published : m), items[0].published).slice(0, 10);
const dayMs = 86400000, now = Date.now();
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const complete = (day) => ymd(Date.parse(day) - 6 * dayMs) >= earliest; // a full 7-day window of news exists

function scoreDay(day, asOf) {
  const r = Risk.score({ items, history, sanctions, ukLaws: uk?.laws || [], conflict: conflict?.events || [], countries: meta.countries || {}, isoOf: (c) => ISO.get(c), asOf: new Date(asOf).toISOString() });
  days[day] = { c: Risk.snapshot(r, items, sanctions, asOf), ...(complete(day) ? {} : { partial: true }) };
}

// backfill any finished day inside the news window that has not been scored yet, then score today
for (let t = Date.parse(earliest); ymd(t) < ymd(now); t += dayMs) {
  const day = ymd(t);
  if (!days[day] || days[day].partial) scoreDay(day, Date.parse(`${day}T23:59:59Z`));
}
scoreDay(ymd(now), now);

const keepFrom = ymd(now - KEEP_DAYS * dayMs);
const kept = Object.fromEntries(Object.keys(days).sort().filter((k) => k >= keepFrom).map((k) => [k, days[k]]));
fs.writeFileSync(path.join(DIR, "scores.json"), JSON.stringify({ updated: new Date(now).toISOString(), pillars: Object.keys(Risk.PILLARS), days: kept }));
console.log(`score: ${Object.keys(kept).length} days stored, ${Object.keys(kept[ymd(now)].c).length} countries today`);
