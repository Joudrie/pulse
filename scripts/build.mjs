// Turns data/days/*.json into what the site reads:
//   dist/data/summary.json     every time range, pre-computed (leaderboards, genres, platform line)
//   dist/data/games/<id>.json  one game's full history, loaded when you open it
// and copies site/ into dist/.
import { readFile, writeFile, readdir, mkdir, cp, rm } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const DATA = new URL('data/', ROOT);
const DIST = new URL('dist/', ROOT);

// Roblox doesn't publish what a game earns. This is the visits-based estimate
// Profitable.app publishes: 2% of visits spend, 150 Robux average spend,
// 70% developer share, $0.0038 per Robux (the DevEx rate). Rough by design.
const REVENUE_PER_VISIT = 0.02 * 150 * 0.7 * 0.0038;

const RANGES = [
  { key: '1D', label: 'Day', days: 1 },
  { key: '1W', label: 'Week', days: 7 },
  { key: '1M', label: 'Month', days: 30 },
  { key: '3M', label: '3 months', days: 91 },
  { key: '6M', label: '6 months', days: 182 },
  { key: '1Y', label: 'Year', days: 365 },
];
const BOARD_SIZE = 300;      // games kept per range (by players), plus new ones below
const NEW_GAME_DAYS = 120;   // "new" = created within this many days of the range's end
const SPARK_POINTS = 30;

const readJSON = async url => JSON.parse(await readFile(url, 'utf8'));
const round = (n, d = 0) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const mean = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sum = xs => xs.reduce((a, b) => a + (b ?? 0), 0);
// Like sum, but null when there's nothing to add (so the site shows "–", not a fake $0).
const total = xs => (xs.some(x => x != null) ? sum(xs) : null);
// Fraction of a revenue figure that comes from extrapolated (first-day) values.
const share = (rev, prov) => { const all = sum(rev); return all > 0 ? sum(rev.map((r, i) => (prov[i] ? r : 0))) / all : prov.some(Boolean) ? 1 : 0; };

// Average neighbouring points down to at most n, keeping the shape of the line.
function downsample(xs, n) {
  if (xs.length <= n) return xs.map(x => round(x));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * xs.length) / n), b = Math.floor(((i + 1) * xs.length) / n);
    out.push(round(mean(xs.slice(a, b))));
  }
  return out;
}

async function main() {
  const meta = await readJSON(new URL('meta.json', DATA));
  const files = (await readdir(new URL('days/', DATA))).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
  if (!files.length) throw new Error('No data yet: run `npm run collect` first.');
  const days = [];
  for (const f of files) days.push(await readJSON(new URL(`days/${f}`, DATA)));
  const dates = days.map(d => d.date);

  // Per game, per day: average and peak players, visits, favorites, new visits, revenue estimate.
  const games = new Map();
  const game = id => {
    if (!games.has(id)) games.set(id, { ccu: [], peak: [], visits: [], favorites: [], newVisits: [], provisional: [], up: null, down: null });
    return games.get(id);
  };
  days.forEach((day, di) => {
    day.ids.forEach((id, i) => {
      const g = game(id);
      const series = day.samples.map(s => s.ccu[i] ?? null);
      g.ccu[di] = mean(series);
      g.peak[di] = series.reduce((m, x) => (x != null && x > (m ?? -1) ? x : m), null);
      g.visits[di] = day.last.visits[i];
      g.favorites[di] = day.last.favorites[i];
      g.up = day.last.up[i] ?? g.up;
      g.down = day.last.down[i] ?? g.down;
      const prev = di > 0 ? games.get(id)?.visits[di - 1] : null;
      let nv = null, provisional = false;
      if (prev != null && g.visits[di] != null && g.visits[di] >= prev) nv = g.visits[di] - prev;
      else {
        // First day we've seen this game: extrapolate today's visit rate to 24 hours.
        const t0 = Date.parse(day.samples[day.first.s[i]]?.t), t1 = Date.parse(day.samples[day.last.s[i]]?.t);
        const hours = (t1 - t0) / 36e5;
        if (hours >= 1 && day.last.visits[i] >= day.first.visits[i]) { nv = ((day.last.visits[i] - day.first.visits[i]) / hours) * 24; provisional = true; }
      }
      g.newVisits[di] = nv;
      g.provisional[di] = provisional;
    });
  });
  for (const g of games.values()) g.revenue = g.newVisits.map(v => (v == null ? null : v * REVENUE_PER_VISIT));

  // Roblox's own chart positions, from the latest day.
  const latest = days.at(-1);
  const sortRank = {};
  for (const s of latest.sorts) s.ids.forEach((id, i) => { (sortRank[id] ??= {})[s.id] = i + 1; });
  const charts = latest.sorts.map(s => ({ id: s.id, name: s.name }));

  // Intraday samples for the Day view: everything in the last 24 hours across the last two files.
  const lastT = Date.parse(latest.samples.at(-1).t);
  const intraday = [];
  for (const day of days.slice(-2)) {
    for (const s of day.samples) {
      const t = Date.parse(s.t);
      if (lastT - t <= 24 * 36e5) intraday.push({ t: s.t, ids: day.ids, ccu: s.ccu });
    }
  }

  const growth = (cur, prev) => (cur != null && prev != null && prev > 0 ? (cur - prev) / prev : null);

  const ranges = {};
  for (const r of RANGES) {
    const n = Math.min(r.days, dates.length);
    const from = dates.length - n;
    const span = dates.slice(from);
    const prevFrom = Math.max(0, from - r.days), prevSpan = from - prevFrom;
    const endDate = dates.at(-1);
    const rows = [];

    for (const [id, g] of games) {
      const m = meta.games[id];
      if (!m) continue;
      const ccu = g.ccu.slice(from, dates.length);
      const avg = mean(ccu);
      if (avg == null) continue;
      const revenueDays = g.revenue.slice(from, dates.length);
      let change = null, basis = null, spark;

      if (r.key === '1D') {
        const pts = intraday.map(s => { const i = s.ids.indexOf(id); return i < 0 ? null : s.ccu[i] ?? null; });
        spark = downsample(pts, SPARK_POINTS);
        if (dates.length >= 2 && g.ccu.at(-2) != null) { change = growth(g.ccu.at(-1), g.ccu.at(-2)); basis = 'vs previous day'; }
        else { const v = pts.filter(x => x != null); if (v.length >= 2) { change = growth(v.at(-1), v[0]); basis = 'since first sample'; } }
      } else {
        spark = downsample(ccu, SPARK_POINTS);
        const prevAvg = prevSpan >= Math.ceil(r.days / 2) ? mean(g.ccu.slice(prevFrom, from)) : null;
        if (prevAvg != null) { change = growth(avg, prevAvg); basis = `vs previous ${r.label.toLowerCase()}`; }
        else {
          const v = ccu.filter(x => x != null);
          if (v.length >= 2) { change = growth(v.at(-1), v[0]); basis = 'first to last day'; }
        }
      }

      const created = m.created ?? null;
      const ageDays = created ? Math.round((Date.parse(endDate) - Date.parse(created)) / 864e5) : null;
      rows.push({
        id,
        avg: round(avg),
        peak: (pk => (pk.length ? Math.max(...pk) : null))(g.peak.slice(from).filter(x => x != null)),
        change: round(change, 4),
        basis,
        revenue: round(total(revenueDays)),
        // Flag only when extrapolated days are a real share of the figure, not one day in ninety.
        provisional: share(g.revenue.slice(from), g.provisional.slice(from)) > 0.25,
        newVisits: round(total(g.newVisits.slice(from))),
        favGain: g.favorites.at(-1) != null && g.favorites[from] != null ? g.favorites.at(-1) - g.favorites[from] : null,
        isNew: ageDays != null && ageDays <= NEW_GAME_DAYS,
        spark,
      });
    }

    rows.sort((a, b) => b.avg - a.avg);
    const keep = new Set(rows.slice(0, BOARD_SIZE).map(x => x.id));
    rows.filter(x => x.isNew && x.avg >= 300).slice(0, 80).forEach(x => keep.add(x.id));
    const board = rows.filter(x => keep.has(x.id));

    // Platform line: total players online on tracked games, per sample (Day) or per day.
    let line;
    if (r.key === '1D') line = intraday.map(s => ({ x: s.t, y: sum(s.ccu) }));
    else line = span.map((d, k) => ({ x: d, y: round(sum([...games.values()].map(g => g.ccu[from + k]))) }));
    const revenueLine = span.map((d, k) => ({ x: d, y: round(total([...games.values()].map(g => g.revenue[from + k]))) }));

    // Genres: share of players and of estimated revenue across all tracked games.
    const genres = {};
    for (const x of rows) {
      const name = meta.games[x.id].genre || 'Other';
      const g = (genres[name] ??= { name, players: 0, revenue: 0, games: 0 });
      g.players += x.avg; g.revenue += x.revenue ?? 0; g.games += 1;
    }

    ranges[r.key] = {
      key: r.key, label: r.label, days: r.days,
      from: span[0], to: endDate, coverage: n, // days of data inside the range
      totals: {
        players: round(mean(line.map(p => p.y))), revenue: round(total(revenueLine.map(p => p.y))), games: rows.length,
        provisional: share([...games.values()].flatMap(g => g.revenue.slice(from)), [...games.values()].flatMap(g => g.provisional.slice(from))) > 0.05,
      },
      line, revenueLine,
      genres: Object.values(genres).map(g => ({ ...g, players: round(g.players), revenue: round(g.revenue) })).sort((a, b) => b.players - a.players),
      board,
    };
  }

  // Only the games that appear on some board need a detail file and metadata.
  const shown = new Set(Object.values(ranges).flatMap(r => r.board.map(x => x.id)));
  const gameMeta = {};
  for (const id of shown) {
    const m = meta.games[id], g = games.get(id);
    gameMeta[id] = {
      name: m.name, creator: m.creator, verified: m.verified, genre: m.genre, subgenre: m.subgenre,
      created: m.created, place: m.place, icon: m.icon ?? null,
      likes: g.up != null && g.up + g.down > 0 ? round(g.up / (g.up + g.down), 3) : null,
      visits: g.visits.at(-1), favorites: g.favorites.at(-1),
      ranks: sortRank[id] ?? {},
    };
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(new URL('data/games/', DIST), { recursive: true });
  await cp(new URL('site/', ROOT), DIST, { recursive: true });

  const repo = process.env.GITHUB_REPOSITORY || '';
  await writeFile(new URL('data/summary.json', DIST), JSON.stringify({
    updated: meta.updated, since: dates[0], days: dates.length, repo,
    revenuePerVisit: REVENUE_PER_VISIT, charts, ranges, games: gameMeta,
  }));

  for (const id of shown) {
    const g = games.get(id);
    const pts = intraday.map(s => { const i = s.ids.indexOf(id); return { x: s.t, y: i < 0 ? null : s.ccu[i] ?? null }; });
    await writeFile(new URL(`data/games/${id}.json`, DIST), JSON.stringify({
      id, dates,
      ccu: g.ccu.map(x => round(x)), peak: g.peak, revenue: g.revenue.map(x => round(x)),
      provisional: g.provisional, favorites: g.favorites, intraday: pts,
    }));
  }
  console.log(`Built ${dates.length} day(s), ${games.size} games, ${shown.size} on boards.`);
}

main().catch(err => { console.error(err); process.exit(1); });
