# Fathom

*Geopolitical risk, sounded daily.* Built by Evan Coles.

Fathom is a free, self-updating tracker of geopolitical risk. It pulls news, sanctions, energy and conflict data from open sources, tags every story by region and theme, and shows it all on one dashboard.

**What it tracks**

- **News from 35 sources**, including world news, regional outlets, think tanks and specialist maritime, energy, cyber, migration and nuclear publications.
- **6 regions:** Europe & Eurasia, Middle East & North Africa, Asia-Pacific, Americas, Sub-Saharan Africa, and Global / multilateral.
- **10 themes:** sanctions, energy, shipping, conflict, political stability, trade, cyber, migration, climate, and nuclear and arms control.
- **New sanctions listings and sanctioned vessels,** from OpenSanctions.
- **Oil and gas prices,** from the US EIA.
- **Conflict and unrest events,** from ACLED.
- **Home Desk:** how the UK is responding, from GOV.UK (eight departments), legislation.gov.uk and Hansard, tagged with the same countries and themes.

It runs entirely on free GitHub services. News refreshes every 3 hours, and the sanctions, energy and conflict data refresh once a day.

---

## Setup guide

You only do this once. It takes about 20 minutes.

### 1. Put the code on GitHub
1. Create a free account at [github.com](https://github.com).
2. Create a new **public** repository called `fathom`.
3. Upload every file and folder from this project into it. Choose **Add file → Upload files**, then drag everything in, including the hidden `.github` folder.

### 2. Switch on the website
1. In your repository, go to **Settings → Pages**.
2. Under **Source**, choose **GitHub Actions**.

### 3. Add your free data keys (optional, but recommended)
Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Where to get it | What it unlocks |
|---|---|---|
| `EIA_API_KEY` | [eia.gov/opendata/register.php](https://www.eia.gov/opendata/register.php) | Energy price charts |
| `ACLED_EMAIL` | The email you register with at [acleddata.com](https://acleddata.com) | Conflict map |
| `ACLED_PASSWORD` | Your ACLED account password | Conflict map |

Keys stored as secrets are never shown to anyone, and they aren't part of the public code. Never paste them into a file.

### 4. Run it for the first time
1. Go to the **Actions** tab and choose **Update Fathom**.
2. Click **Run workflow**.
3. After 2–3 minutes your dashboard is live at `https://YOUR-USERNAME.github.io/fathom/`.

From then on it updates itself.

---

## Looking after it

- **A source shows as "Failing" in the Source status panel.** Publishers sometimes move their RSS feed. Find the new feed link on their website and update the `url` for that source in `sources.json`.
- **You want to add a source.** Add a line to `sources.json` with its name, group and RSS link.
- **You want to change how stories are tagged.** Edit the keywords in `themes.json`, or the country names in `regions.json`.
- **A banner says you're looking at sample data.** That part of the dashboard hasn't been filled with live data yet. Check the Source status panel to see why. Usually a key is missing.

## How it works

| Part | File |
|---|---|
| Collector: fetches, removes duplicates and tags | `collect.py` |
| Settings: sources, themes and regions | `sources.json`, `themes.json`, `regions.json` |
| Dashboard: a static web page | `index.html`, `app.js`, `style.css` |
| Automation: the schedule and publishing | `.github/workflows/update.yml` |

## Data and credits
- **Headlines** link to their original publishers.
- **Sanctions data:** [OpenSanctions](https://www.opensanctions.org), CC BY-NC 4.0. Free for non-commercial use.
- **Energy data:** [US Energy Information Administration](https://www.eia.gov).
- **Conflict data:** [ACLED](https://acleddata.com). Follow ACLED's terms of use when you publish anything based on it.
- **Map:** Natural Earth, via the world-atlas package. Charts and maps are drawn with D3.
