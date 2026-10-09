# Pulse

A daily trend tracker for Roblox games: who's playing, who's growing, and roughly
who's earning, over a day, week, month, 3 months, 6 months or a year.

## How it works

```
collect (every 3 h)  →  data/days/YYYY-MM-DD.json  →  build  →  static site on GitHub Pages
```

| Step | Script | What it does |
|---|---|---|
| Collect | `scripts/collect.mjs` | Reads Roblox's own charts (Top Earning, Up-and-Coming, Top Trending, per-genre trending and more), then players online, visits, favorites and votes for every game on them. Appends one sample to today's file. |
| Build | `scripts/build.mjs` | Turns the daily files into per-range leaderboards, genre shares, the platform line and one history file per game, then copies `site/` into `dist/`. |

All data comes from Roblox's public API (no key). Games stay tracked for 30 days
after they drop off every chart, so their trend lines don't just stop.

**Revenue is an estimate.** Roblox doesn't publish earnings. Each day's new visits
× 0.02 × 150 Robux × 70% × $0.0038 (Profitable.app's published formula). Roblox's
own Top Earning chart is shown beside it as a real, if amount-free, signal.

**History starts on the first run.** Longer ranges fill in day by day; until
then, each game links to RoTrends, RoMonitor, RoWatcher and Profitable.app for
older history.

## Run it locally

```bash
npm run refresh   # one snapshot + build
npm run serve     # build and open the site
```

Node 20+, no dependencies.

## Set up on GitHub

1. Push this folder to a new public repo.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Actions → Refresh → Run workflow** for the first snapshot. After that it runs every 3 hours.
   The site's "Refresh now" link opens the same button.
