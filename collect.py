"""Fathom collector.

Pulls news feeds and open data, tags every item by region and theme,
and writes JSON files that the dashboard reads.

Run:  python collect.py
Each part fails independently, so one broken source never stops the rest.
"""
from __future__ import annotations

import csv
import hashlib
import html
import io
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import requests

# Everything lives in one folder: settings, data files and the web page sit side by side
ROOT = Path(__file__).resolve().parent
CONFIG = ROOT
OUT = ROOT

NOW = datetime.now(timezone.utc)
KEEP_DAYS = 14          # how long news items stay on the dashboard
MAX_ITEMS = 4000        # cap on stored news items (enough for 14 full days)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Fathom/1.0",
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    "Accept-Language": "en-GB,en;q=0.8",
}
TIMEOUT = 25

# Short names that only count when written in capitals (so "us" the word is not the United States)
ACRONYMS = {
    "us", "uk", "eu", "uae", "idf", "drc", "pla", "rsf", "imf", "wto", "irgc", "dprk",
    "npt", "iaea", "ais", "wti", "lng", "opec", "ofac", "ofsi", "iom", "unhcr", "icbm",
    "nato", "brics", "pdvsa", "m23", "g7", "g20", "5g", "p&i",
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(name: str, data) -> None:
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- tagging
def build_matcher(terms: list[str]):
    """One regex per group of terms. Acronyms match in capitals only."""
    plain = [t for t in terms if t.lower() not in ACRONYMS]
    caps = [t for t in terms if t.lower() in ACRONYMS]
    parts = []
    if plain:
        parts.append(re.compile(r"(?<![\w-])(" + "|".join(re.escape(t) for t in sorted(plain, key=len, reverse=True)) + r")(?![\w-])", re.I))
    if caps:
        parts.append(re.compile(r"(?<![\w-])(" + "|".join(re.escape(t.upper()) for t in caps) + r")(?![\w-])"))
    return parts


def count_hits(matchers, text: str) -> int:
    return sum(len(m.findall(text)) for m in matchers)


class Tagger:
    def __init__(self):
        themes = load_json(CONFIG / "themes.json", {})
        regions = load_json(CONFIG / "regions.json", {})
        self.themes = {k: build_matcher(v["keywords"]) for k, v in themes.items()}
        self.regions = {}
        self.countries = {}
        for rkey, r in regions.items():
            all_terms = []
            for country, aliases in r["places"].items():
                self.countries[country] = (rkey, build_matcher(aliases))
                all_terms += aliases
            self.regions[rkey] = build_matcher(all_terms)

    def tag(self, title: str, summary: str, feed: dict) -> dict:
        # Title counts double: it is the clearest signal of what the story is about
        text = f"{title} {title} {summary}"
        themes = [k for k, m in self.themes.items() if count_hits(m, text) >= (1 if count_hits(m, title) else 2)]
        if feed.get("theme_hint") and feed["theme_hint"] not in themes:
            themes.append(feed["theme_hint"])

        region_scores = {k: count_hits(m, text) for k, m in self.regions.items()}
        regions = [k for k, s in region_scores.items() if s > 0]
        if not regions and feed.get("region_hint"):
            regions = [feed["region_hint"]]
        if not regions:
            regions = ["global"]
        countries = [c for c, (_, m) in self.countries.items() if count_hits(m, title + " " + summary)]
        return {"themes": themes, "regions": regions, "countries": countries[:6]}


# ---------------------------------------------------------------- news feeds
def clean(text: str, limit: int = 400) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(re.sub(r"\s+", " ", text)).strip()
    return text[:limit].rsplit(" ", 1)[0] + "…" if len(text) > limit else text


def entry_time(e) -> datetime:
    for key in ("published_parsed", "updated_parsed"):
        t = e.get(key)
        if t:
            return min(datetime.fromtimestamp(time.mktime(t), tz=timezone.utc), NOW)  # some feeds post future dates
    return NOW


def collect_news(tagger: Tagger) -> tuple[list, list]:
    sources = load_json(CONFIG / "sources.json", {}).get("feeds", [])
    previous = load_json(OUT / "news.json", {})
    # Sample stories are only for previewing; never mix them with real news
    existing = {} if previous.get("sample") else {i["id"]: i for i in previous.get("items", [])}
    status = []
    cutoff = NOW - timedelta(days=KEEP_DAYS)
    seen_titles = {re.sub(r"\W+", "", i["title"].lower())[:80] for i in existing.values()}

    for feed in sources:
        new = 0
        try:
            parsed, note = None, ""
            for url in [feed["url"]] + ([feed["fallback"]] if feed.get("fallback") else []):
                try:
                    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
                    resp.raise_for_status()
                    parsed = feedparser.parse(resp.content)
                    if not parsed.entries:
                        raise ValueError("feed returned no articles")
                    note = "" if url == feed["url"] else "via backup feed"
                    break
                except Exception as exc:  # noqa: BLE001 - try the backup before giving up
                    parsed, last_error = None, exc
            if parsed is None:
                raise last_error
            for e in parsed.entries[:60]:
                title = clean(e.get("title", ""), 220)
                if "news.google.com" in (e.get("link") or ""):
                    title = re.sub(r"\s+-\s+[^-]{2,60}$", "", title)  # Google News adds " - Publisher"
                link = e.get("link", "")
                if not title or not link:
                    continue
                published = entry_time(e)
                if published < cutoff:
                    continue
                uid = hashlib.sha1(link.encode()).hexdigest()[:16]
                key = re.sub(r"\W+", "", title.lower())[:80]
                if uid in existing or key in seen_titles:
                    continue
                summary = clean(e.get("summary", "") or e.get("description", ""))
                existing[uid] = {
                    "id": uid,
                    "title": title,
                    "summary": summary,
                    "url": link,
                    "source": feed["name"],
                    "group": feed["group"],
                    "published": published.isoformat(),
                    **tagger.tag(title, summary, feed),
                }
                seen_titles.add(key)
                new += 1
            status.append({"name": feed["name"], "group": feed["group"], "ok": True, "new": new, "note": note})
            log(f"  ok   {feed['name']}: {new} new")
        except Exception as exc:  # noqa: BLE001 - one bad feed must not stop the run
            status.append({"name": feed["name"], "group": feed["group"], "ok": False, "new": 0, "note": str(exc)[:160]})
            log(f"  FAIL {feed['name']}: {exc}")

    items = [i for i in existing.values() if i["published"] >= cutoff.isoformat()]
    items.sort(key=lambda i: i["published"], reverse=True)
    return items[:MAX_ITEMS], status


# ---------------------------------------------------------------- sanctions + vessels
def collect_sanctions() -> dict | None:
    """Recent designations and the sanctioned-vessel list from OpenSanctions."""
    url = load_json(CONFIG / "sources.json", {})["data_sources"]["opensanctions"]["url"]
    recent_cutoff = (NOW - timedelta(days=30)).date().isoformat()
    vessels, recent = [], []
    with requests.get(url, headers=HEADERS, timeout=120, stream=True) as resp:
        resp.raise_for_status()
        lines = (line.decode("utf-8", "replace") for line in resp.iter_lines())
        for row in csv.DictReader(lines):
            schema = row.get("schema", "")
            first_seen = (row.get("first_seen") or "")[:10]
            entry = {
                "name": row.get("name", ""),
                "type": schema,
                "countries": row.get("countries", ""),
                "programs": clean(row.get("sanctions", ""), 160),
                "datasets": row.get("dataset", ""),
                "first_seen": first_seen,
                "id": row.get("id", ""),
            }
            if schema == "Vessel":
                ident = row.get("identifiers", "")
                imo = re.search(r"IMO\s?(\d{7})", ident) or re.search(r"\b(\d{7})\b", ident)
                entry["imo"] = imo.group(1) if imo else ""
                vessels.append(entry)
            if first_seen >= recent_cutoff and schema in {"Person", "Company", "Organization", "LegalEntity", "Vessel"}:
                recent.append(entry)
    vessels.sort(key=lambda v: v["first_seen"], reverse=True)
    recent.sort(key=lambda v: v["first_seen"], reverse=True)
    return {"updated": NOW.isoformat(), "recent": recent[:500], "recent_total": len(recent),
            "vessels": vessels[:2000], "vessel_total": len(vessels)}


# ---------------------------------------------------------------- energy prices
def collect_energy() -> dict | None:
    key = os.environ.get("EIA_API_KEY")
    if not key:
        raise RuntimeError("EIA_API_KEY not set (add it as a GitHub Secret)")
    series = load_json(CONFIG / "sources.json", {})["data_sources"]["eia"]["series"]
    out = {"updated": NOW.isoformat(), "series": {}}
    for label, sid in series.items():
        r = requests.get(f"https://api.eia.gov/v2/seriesid/{sid}", params={"api_key": key}, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        rows = r.json().get("response", {}).get("data", [])
        points = sorted(((d["period"], float(d["value"])) for d in rows if d.get("value") not in (None, "")), key=lambda p: p[0])
        out["series"][label] = [{"date": p, "value": v} for p, v in points[-180:]]
    return out


# ---------------------------------------------------------------- Home Desk (UK)
# Free, keyless UK sources: GOV.UK search, legislation.gov.uk and Hansard.
GOVUK_SKIP = {"employment_tribunal_decision", "employment_appeal_tribunal_decision", "transparency", "statistics"}


def party_of(attributed: str) -> str:
    """'Jane Smith (Bath) (LD)' -> 'LD'. Ministers are listed by office, so they have none."""
    m = re.search(r"\(([A-Za-z ]{1,12})\)\s*$", attributed or "")
    return m.group(1) if m and not re.search(r"\bthe\b", m.group(1), re.I) else ""


def hansard_link(c: dict) -> str:
    day = (c.get("SittingDate") or "")[:10]
    ext = c.get("DebateSectionExtId") or ""
    return f"https://hansard.parliament.uk/{c.get('House', 'Commons')}/{day}/debates/{ext}" if ext and day else "https://hansard.parliament.uk"


def collect_uk() -> dict:
    cfg = load_json(CONFIG / "sources.json", {})["data_sources"]["uk"]
    tagger = Tagger()
    since = (NOW - timedelta(days=cfg.get("window_days", 30))).date().isoformat()

    # Whitehall: latest publications from the departments that shape foreign, security and energy policy
    whitehall, seen = [], set()
    for org in cfg["govuk_organisations"]:
        r = requests.get("https://www.gov.uk/api/search.json", headers=HEADERS, timeout=TIMEOUT, params={
            "filter_organisations": org, "order": "-public_timestamp", "count": 40,
            "fields": "title,link,public_timestamp,content_store_document_type,organisations,description"})
        r.raise_for_status()
        for d in r.json().get("results", []):
            kind = d.get("content_store_document_type", "")
            if d["link"] in seen or kind in GOVUK_SKIP or d.get("public_timestamp", "") < since:
                continue
            seen.add(d["link"])
            title, desc = clean(d.get("title", ""), 220), clean(d.get("description", ""), 300)
            whitehall.append({
                "title": title, "url": "https://www.gov.uk" + d["link"], "published": d["public_timestamp"],
                "kind": kind, "orgs": [o.get("acronym") or o.get("title") for o in d.get("organisations", [])][:3],
                **tagger.tag(title, desc, {}),
            })
        time.sleep(0.5)
    whitehall.sort(key=lambda x: x["published"], reverse=True)

    # Legislation: statutory instruments made this year whose titles match the watch list (sanctions, export control…)
    laws = []
    for term in cfg["legislation_terms"]:
        r = requests.get(f"https://www.legislation.gov.uk/uksi/{NOW.year}/data.feed", headers=HEADERS, timeout=TIMEOUT, params={"title": term})
        r.raise_for_status()
        for e in feedparser.parse(r.content).entries:
            link = e.get("link") or e.get("id", "")
            if any(l["url"] == link for l in laws):
                continue
            title = clean(e.get("title", ""), 220)
            laws.append({"title": title, "url": link, "published": entry_time(e).isoformat(),
                         "number": re.sub(r".*/uksi/", "", e.get("id", "")), **tagger.tag(title, "", {})})
        time.sleep(0.5)
    laws.sort(key=lambda x: x["published"], reverse=True)

    # Parliament: how often each country and issue is raised, and the latest contributions on watched issues
    def hansard(term: str, take: int = 1) -> dict:
        q = f'"{term}"' if " " in term else term
        for attempt in (1, 2, 3):  # Hansard search is busy at times; a short pause usually clears it
            try:
                r = requests.get("https://hansard-api.parliament.uk/search.json", headers=HEADERS, timeout=60, params={
                    "queryParameters.searchTerm": q, "queryParameters.startDate": since, "queryParameters.take": take,
                    "queryParameters.orderBy": "SittingDateDesc"})
                r.raise_for_status()
                time.sleep(0.6)
                return r.json()
            except Exception:  # noqa: BLE001
                if attempt == 3:
                    raise
                time.sleep(4 * attempt)

    previous = load_json(OUT / "news.json", {}).get("items", [])
    week = [i for i in previous if i["published"] >= (NOW - timedelta(days=7)).isoformat()]
    counts: dict[str, int] = {}
    for i in week:
        for c in i["countries"]:
            counts[c] = counts.get(c, 0) + 1
    countries = [c for c, _ in sorted(counts.items(), key=lambda x: -x[1]) if c not in cfg.get("skip_countries", [])][: cfg.get("country_count", 12)]

    attention = []
    for c in countries:
        try:
            j = hansard(cfg.get("hansard_aliases", {}).get(c, c))
            attention.append({"country": c, "news_7d": counts[c], "contributions": j.get("TotalContributions", 0),
                              "debates": j.get("TotalDebates", 0), "statements": j.get("TotalWrittenStatements", 0)})
        except Exception as exc:  # noqa: BLE001 - one slow search shouldn't sink the rest
            log(f"uk: Hansard search for {c} failed - {exc}")

    issues, speeches = [], []
    for issue in cfg["hansard_issues"]:
        try:
            j = hansard(issue["term"], take=8)
        except Exception as exc:  # noqa: BLE001
            log(f"uk: Hansard search for {issue['term']} failed - {exc}")
            continue
        issues.append({"term": issue["term"], "theme": issue.get("theme", ""),
                       "contributions": j.get("TotalContributions", 0), "debates": j.get("TotalDebates", 0)})
        for c in j.get("Contributions", []):
            speeches.append({
                "issue": issue["term"], "member": c.get("MemberName", ""), "party": party_of(c.get("AttributedTo", "")),
                "house": c.get("House", ""), "date": (c.get("SittingDate") or "")[:10], "debate": c.get("DebateSection", ""),
                "text": clean(c.get("ContributionTextFull") or c.get("ContributionText", ""), 260), "url": hansard_link(c),
            })
    speeches = sorted({(s["url"], s["member"]): s for s in speeches}.values(), key=lambda s: s["date"], reverse=True)[:30]

    return {"updated": NOW.isoformat(), "since": since, "whitehall": whitehall[:150], "laws": laws,
            "attention": attention, "issues": issues, "speeches": speeches}


# ---------------------------------------------------------------- Home Desk: UK politics, elections, tax and economy
GOVUK_TAX_SKIP = GOVUK_SKIP | {"hmrc_manual", "hmrc_manual_section", "form", "statistics_announcement", "corporate_report", "foi_release"}


def _matchers(groups: dict) -> dict:
    return {k: build_matcher(v) for k, v in groups.items()}


def parse_cards(content: bytes, pattern: str) -> list[dict]:
    """Some publishers wrap their whole listing as HTML inside a single feed item.
    Pull out each article link, its title and the first date written after it."""
    text = html.unescape(content.decode("utf-8", "replace"))
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="(' + pattern + r')"[^>]*>(.*?)</a>', text, re.S):
        link, title = m.group(1), clean(m.group(2), 220)
        if link in seen or len(title) < 12:
            continue
        seen.add(link)
        d = re.search(r"(\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4})", text[m.end(): m.end() + 600])
        when = datetime.strptime(d.group(1), "%d %B %Y").replace(tzinfo=timezone.utc) if d else NOW
        out.append({"title": title, "link": link, "published": min(when, NOW), "summary": "", "dateonly": True})
    return out


def ons_series(path: str, freq: str, scale: float = 1.0, keep: int = 25) -> list[dict]:
    r = requests.get(f"https://www.ons.gov.uk{path}/data", headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    rows = [x for x in r.json().get(freq, []) if x.get("value") not in (None, "")]
    return [{"d": x["date"], "v": round(float(x["value"]) * scale, 2)} for x in rows[-keep:]]


def bank_rate() -> list[dict]:
    r = requests.get("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp", headers=HEADERS, timeout=TIMEOUT, params={
        "csv.x": "yes", "Datefrom": (NOW - timedelta(days=760)).strftime("%d/%b/%Y"), "Dateto": "now",
        "SeriesCodes": "IUDBEDR", "CSVF": "TN", "UsingCodes": "Y", "VPD": "Y", "VFD": "N"})
    r.raise_for_status()
    rows = [row for row in csv.reader(io.StringIO(r.text)) if len(row) >= 2]
    out = []
    for d, v in rows[1:]:
        try:
            out.append({"d": datetime.strptime(d.strip(), "%d %b %Y").strftime("%Y-%m-%d"), "v": float(v)})
        except ValueError:
            continue
    # keep the points where the rate changed, plus the latest day
    steps = [p for i, p in enumerate(out) if i == 0 or p["v"] != out[i - 1]["v"]]
    return steps + ([out[-1]] if out and steps[-1] is not out[-1] else [])


def collect_home() -> dict:
    cfg = load_json(CONFIG / "sources.json", {})["data_sources"]["home"]
    parties_m, topics_m, tax_m = _matchers(cfg["parties"]), _matchers(cfg["topics"]), _matchers(cfg["tax_terms"])
    world = Tagger()  # the World Desk's country rules, so UK stories can link to country dossiers
    cutoff = NOW - timedelta(days=14)
    slow_cutoff = NOW - timedelta(days=45)  # watchdogs, think tanks and HMRC publish less often than newspapers
    slow = {"Tax and fiscal", "Analysis", "Government"}
    keep_from = lambda group: (slow_cutoff if group in slow else cutoff)  # noqa: E731
    status, problems = [], []

    def tag(title: str, summary: str) -> dict:
        text = f"{title} {summary}"
        return {"parties": [k for k, m in parties_m.items() if count_hits(m, text)],
                "topics": [k for k, m in topics_m.items() if count_hits(m, text)],
                "tax": [k for k, m in tax_m.items() if count_hits(m, text)],
                "countries": [c for c in world.tag(title, summary, {})["countries"] if c not in ("United Kingdom", "European Union")]}

    # 1. Feeds: national politics and business news, party voices, analysis, and tax and fiscal bodies
    old = load_json(OUT / "home.json", {})
    articles = {} if old.get("preview") else {i["id"]: i for i in old.get("articles", [])}
    for feed in cfg["feeds"]:
        try:
            r = requests.get(feed["url"], headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            if feed.get("parse") == "cards":
                entries = parse_cards(r.content, feed["link_pattern"])
            else:
                entries = [{"title": clean(e.get("title", ""), 220), "link": e.get("link", ""), "published": entry_time(e),
                            "summary": clean(e.get("summary", "") or e.get("description", ""), 300)} for e in feedparser.parse(r.content).entries[:40]]
            if not entries:
                raise ValueError("feed returned no articles")
            new = 0
            for e in entries:
                if not e["title"] or not e["link"] or e["published"] < keep_from(feed["group"]):
                    continue
                uid = hashlib.sha1(e["link"].encode()).hexdigest()[:16]
                new += uid not in articles
                articles[uid] = {"id": uid, "title": e["title"], "summary": e["summary"], "url": e["link"], "source": feed["name"],
                                 "group": feed["group"], "party_voice": feed.get("party", ""), "published": e["published"].isoformat(), "dateonly": e.get("dateonly", False), **tag(e["title"], e["summary"])}
            status.append({"name": feed["name"], "group": feed["group"], "ok": True, "new": new, "note": ""})
        except Exception as exc:  # noqa: BLE001
            status.append({"name": feed["name"], "group": feed["group"], "ok": False, "new": 0, "note": str(exc)[:160]})
        time.sleep(0.3)

    # GOV.UK tax announcements (HMRC, Treasury), without internal manuals and forms
    for org in cfg["govuk_tax_organisations"]:
        try:
            r = requests.get("https://www.gov.uk/api/search.json", headers=HEADERS, timeout=TIMEOUT, params={
                "filter_organisations": org, "order": "-public_timestamp", "count": 40,
                "fields": "title,link,public_timestamp,content_store_document_type,organisations,description"})
            r.raise_for_status()
            for d in r.json().get("results", []):
                if d.get("content_store_document_type") in GOVUK_TAX_SKIP or d.get("public_timestamp", "") < slow_cutoff.isoformat():
                    continue
                url = "https://www.gov.uk" + d["link"]
                uid = hashlib.sha1(url.encode()).hexdigest()[:16]
                title, desc = clean(d.get("title", ""), 220), clean(d.get("description", ""), 300)
                org_name = (d.get("organisations") or [{}])[0]
                articles[uid] = {"id": uid, "title": title, "summary": desc, "url": url, "source": org_name.get("acronym") or org_name.get("title", "GOV.UK"),
                                 "group": "Government", "kind": d.get("content_store_document_type", ""), "party_voice": "", "published": d["public_timestamp"], **tag(title, desc)}
            status.append({"name": f"GOV.UK {org}", "group": "Government", "ok": True, "new": 0, "note": ""})
        except Exception as exc:  # noqa: BLE001
            status.append({"name": f"GOV.UK {org}", "group": "Government", "ok": False, "new": 0, "note": str(exc)[:160]})
    arts = sorted((a for a in articles.values() if a["published"] >= keep_from(a["group"]).isoformat()), key=lambda a: a["published"], reverse=True)[:900]

    # 2. Commons: seats by party today
    parties = []
    try:
        r = requests.get(f"https://members-api.parliament.uk/api/Parties/StateOfTheParties/1/{NOW.date().isoformat()}", headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        for it in r.json().get("items", []):
            v = it["value"]
            parties.append({"name": v["party"]["name"], "abbr": v["party"].get("abbreviation", ""), "colour": "#" + (v["party"].get("backgroundColour") or "8a96a0"), "seats": v["total"]})
    except Exception as exc:  # noqa: BLE001
        problems.append(f"seats: {exc}")

    # 3. Elections: every upcoming council election and by-election (Democracy Club)
    elections = []
    try:
        url, pages = "https://elections.democracyclub.org.uk/api/elections/", 0
        params = {"future": 1, "limit": 100}
        while url and pages < 6:
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, params=params)
            r.raise_for_status()
            j = r.json()
            for e in j.get("results", []):
                if e.get("cancelled") or e.get("group_type") not in (None, "organisation"):
                    continue
                elections.append({"id": e["election_id"], "title": e.get("election_title", ""), "date": e.get("poll_open_date", ""),
                                  "type": (e.get("election_type") or {}).get("name", ""), "level": "ballot" if e.get("group_type") is None else "organisation",
                                  "by": ".by." in e["election_id"], "org": (e.get("organisation") or {}).get("official_name", "")})
            url, params, pages = j.get("next"), None, pages + 1
        elections.sort(key=lambda e: (e["date"], e["id"]))
    except Exception as exc:  # noqa: BLE001
        problems.append(f"elections: {exc}")

    # 4. Petitions: the most-signed open petitions
    petitions = []
    try:
        r = requests.get("https://petition.parliament.uk/petitions.json", headers=HEADERS, timeout=TIMEOUT, params={"state": "open"})
        r.raise_for_status()
        for p in r.json().get("data", [])[:12]:
            a = p["attributes"]
            petitions.append({"id": p["id"], "title": a["action"], "signatures": a["signature_count"], "created": a["created_at"],
                              "responded": bool(a.get("government_response_at")), "debate": bool(a.get("debate_threshold_reached_at")),
                              "url": f"https://petition.parliament.uk/petitions/{p['id']}"})
    except Exception as exc:  # noqa: BLE001
        problems.append(f"petitions: {exc}")

    # 5. Indicators: ONS series and Bank Rate
    indicators = []
    for ind in cfg["indicators"]:
        try:
            series = ons_series(ind["path"], ind["freq"], ind.get("scale", 1.0))
            indicators.append({**{k: ind[k] for k in ("key", "label", "unit", "good", "source")}, "series": series,
                               "url": f"https://www.ons.gov.uk{ind['path']}"})
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{ind['key']}: {exc}")
        time.sleep(0.3)
    try:
        indicators.append({"key": "bank", "label": "Bank Rate", "unit": "%", "good": "", "source": "Bank of England", "series": bank_rate(),
                           "url": "https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate"})
    except Exception as exc:  # noqa: BLE001
        problems.append(f"bank rate: {exc}")

    if not (arts or parties or elections):
        raise RuntimeError("; ".join(problems) or "no Home Desk data")
    for p in problems:
        log(f"home: {p}")
    return {"updated": NOW.isoformat(), "government": cfg.get("government_party", ""), "articles": arts, "feeds": status,
            "parties": parties, "elections": elections[:400], "petitions": petitions, "indicators": indicators,
            "key_dates": [d for d in cfg.get("key_dates", []) if d["date"] >= NOW.date().isoformat()], "problems": problems}


# ---------------------------------------------------------------- daily history (for the risk index baselines)
HISTORY_DAYS = 120


def update_history(items: list) -> dict:
    """Per-country daily story and source counts. The last 14 days are rebuilt from the
    news window on every run, so late-arriving stories are counted; older days are kept."""
    old = load_json(OUT / "history.json", {}).get("days", {})
    fresh: dict[str, dict] = {}
    for i in items:
        day = i["published"][:10]
        d = fresh.setdefault(day, {"total": 0, "c": {}, "s": {}})
        d["total"] += 1
        for c in i["countries"]:
            d["c"][c] = d["c"].get(c, 0) + 1
            d["s"].setdefault(c, set()).add(i["source"])
    for d in fresh.values():
        d["s"] = {c: len(v) for c, v in d["s"].items()}
    window_start = (NOW - timedelta(days=KEEP_DAYS)).date().isoformat()
    days = {k: v for k, v in old.items() if k < window_start}
    days.update({k: v for k, v in fresh.items() if k >= window_start})
    keep_from = (NOW - timedelta(days=HISTORY_DAYS)).date().isoformat()
    days = {k: days[k] for k in sorted(days) if k >= keep_from and k <= NOW.date().isoformat()}
    return {"updated": NOW.isoformat(), "days": days}

# ---------------------------------------------------------------- main
def run_part(name: str, fn, status: list):
    try:
        data = fn()
        save_json(f"{name}.json", data)
        status.append({"name": name, "ok": True, "note": ""})
        log(f"{name}: saved")
    except Exception as exc:  # noqa: BLE001
        status.append({"name": name, "ok": False, "note": str(exc)[:200]})
        log(f"{name}: skipped - {exc}")


def save_meta() -> None:
    """Region and theme names for the dashboard (copied from the config files)."""
    themes = load_json(CONFIG / "themes.json", {})
    regions = load_json(CONFIG / "regions.json", {})
    save_json("meta.json", {
        "themes": {k: {"label": v["label"]} for k, v in themes.items()},
        "regions": {k: {"label": v["label"]} for k, v in regions.items()},
        "countries": {c: k for k, v in regions.items() for c in v["places"]},
        "feed_count": len(load_json(CONFIG / "sources.json", {}).get("feeds", [])),
    })


def main(parts: list[str]) -> None:
    save_meta()
    status = {"updated": NOW.isoformat(), "feeds": [], "data": []}
    if "news" in parts:
        log("Collecting news feeds…")
        items, feed_status = collect_news(Tagger())
        save_json("news.json", {"updated": NOW.isoformat(), "items": items})
        save_json("history.json", update_history(items))
        status["feeds"] = feed_status
        log(f"news: {len(items)} items stored")
    for name, fn in (("sanctions", collect_sanctions), ("energy", collect_energy), ("uk", collect_uk), ("home", collect_home)):
        if name in parts:
            run_part(name, fn, status["data"])
    old = load_json(OUT / "status.json", {})
    if "news" not in parts:
        status["feeds"] = old.get("feeds", [])
    kept = {d["name"]: d for d in old.get("data", []) if d["name"] in ("sanctions", "energy", "uk", "home")}
    kept.update({d["name"]: d for d in status["data"]})
    status["data"] = list(kept.values())
    save_json("status.json", status)


if __name__ == "__main__":
    main(sys.argv[1:] or ["news", "sanctions", "energy", "uk", "home"])
