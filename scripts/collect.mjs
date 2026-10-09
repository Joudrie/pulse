// Takes one snapshot of Roblox's public game data and appends it to today's file.
// The workflow runs it once a day; a manual run adds another sample to the same
// day, so that day's average and peak use both.
//
// Sources (all public, no key):
//   apis.roblox.com/explore-api   Roblox's own charts (Top Earning, Up-and-Coming, ...)
//   games.roblox.com/v1/games     players online, visits, favorites, genre
//   games.roblox.com/v1/games/votes
//   thumbnails.roblox.com         game icons
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const DATA = new URL('../data/', import.meta.url);
const DAYS = new URL('days/', DATA);
const BATCH = 50;            // games.roblox.com refuses more than 50 ids per call
const MAX_SORT_PAGES = 12;
const KEEP_TRACKING_DAYS = 30;
const PACE = 1200;           // ms between API calls // keep following a game this long after it leaves every chart

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GitHub's runners share IP addresses, so Roblox rate-limits them far sooner than a
// home connection. On a 429 wait it out (honouring Retry-After), up to ~3 minutes in all.
const BACKOFF = [5, 10, 20, 30, 45, 60]; // seconds
async function getJSON(url) {
  for (let i = 0; ; i++) {
    let wait;
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'pulse-trends/1.0 (+github actions)', accept: 'application/json' } });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true });
      wait = Math.max(Number(res.headers.get('retry-after')) || 0, BACKOFF[i] ?? 0);
      if (i >= BACKOFF.length) throw new Error(`HTTP ${res.status} after ${BACKOFF.length} retries`);
      console.warn(`HTTP ${res.status}, waiting ${wait}s (${new URL(url).hostname})`);
    } catch (err) {
      if (err.fatal || i >= BACKOFF.length) throw err;
      wait ??= BACKOFF[i];
    }
    await sleep(wait * 1000);
  }
}

// One batch failing shouldn't cost the whole day: skip it and keep the rest.
async function batched(ids, url, onItem) {
  let failed = 0;
  for (const batch of chunks(ids, BATCH)) {
    try {
      const d = await getJSON(url(batch));
      for (const item of d.data ?? []) onItem(item);
    } catch (err) {
      failed += batch.length;
      console.warn(`Skipped ${batch.length} games: ${err.message}`);
    }
    await sleep(PACE);
  }
  return failed;
}

async function readJSON(url, fallback) {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch { return fallback; }
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// Roblox's charts page, every sort, in display order.
async function fetchCharts() {
  const session = randomUUID();
  const sorts = [];
  let token = '';
  for (let page = 0; page < MAX_SORT_PAGES; page++) {
    const url = `https://apis.roblox.com/explore-api/v1/get-sorts?sessionId=${session}` + (token ? `&sortsPageToken=${encodeURIComponent(token)}` : '');
    const d = await getJSON(url);
    for (const s of d.sorts ?? []) {
      const games = s.games ?? [];
      if (!games.length) continue;
      sorts.push({ id: s.sortId, name: s.sortDisplayName || s.sortId, ids: games.filter(g => !g.isSponsored).map(g => g.universeId) });
    }
    token = d.nextSortsPageToken;
    if (!token) break;
    await sleep(PACE);
  }
  return sorts;
}

async function main() {
  await mkdir(DAYS, { recursive: true });
  const now = new Date();
  const t = now.toISOString().slice(0, 16) + 'Z';
  const date = t.slice(0, 10);

  const meta = await readJSON(new URL('meta.json', DATA), { games: {} });
  const sorts = await fetchCharts();
  const charted = new Set(sorts.flatMap(s => s.ids));

  // Follow everything on a chart today, plus anything that was on one recently,
  // so a game that drops off the charts still has a complete trend line.
  const cutoff = new Date(now - KEEP_TRACKING_DAYS * 864e5).toISOString().slice(0, 10);
  const recent = Object.entries(meta.games).filter(([, g]) => g.lastCharted >= cutoff).map(([id]) => Number(id));
  const ids = [...new Set([...charted, ...recent])];

  const details = {};
  const missed = await batched(ids, b => `https://games.roblox.com/v1/games?universeIds=${b.join(',')}`, g => { details[g.id] = g; });
  if (!Object.keys(details).length) throw new Error('Roblox returned no game data; nothing saved.');
  const votes = {};
  await batched(ids, b => `https://games.roblox.com/v1/games/votes?universeIds=${b.join(',')}`, v => { votes[v.id] = v; });

  // Metadata: names change (seasonal emoji prefixes), so refresh them every run.
  for (const id of ids) {
    const g = details[id];
    if (!g) continue;
    const m = meta.games[id] ?? (meta.games[id] = { firstSeen: date });
    Object.assign(m, {
      name: g.name,
      creator: g.creator?.name ?? '',
      verified: !!g.creator?.hasVerifiedBadge,
      genre: !g.genre_l1 || g.genre_l1 === 'All' ? 'Unlabeled' : g.genre_l1, // Roblox reports "All" when a creator never picked one
      subgenre: g.genre_l2 || '',
      created: g.created?.slice(0, 10),
      place: g.rootPlaceId,
      maxPlayers: g.maxPlayers,
    });
    if (charted.has(id)) m.lastCharted = date;
  }

  const needIcons = ids.filter(id => meta.games[id] && !meta.games[id].icon);
  for (const batch of chunks(needIcons, BATCH)) {
    try {
      const d = await getJSON(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${batch.join(',')}&returnPolicy=PlaceHolder&size=150x150&format=Webp&isCircular=false`);
      for (const im of d.data ?? []) if (im.state === 'Completed' && meta.games[im.targetId]) meta.games[im.targetId].icon = im.imageUrl;
    } catch (err) { console.warn('icons:', err.message); }
    await sleep(PACE);
  }

  // Today's file. `ids` only ever grows during a day; every per-game array lines up with it.
  const dayUrl = new URL(`${date}.json`, DAYS);
  const day = await readJSON(dayUrl, { date, ids: [], samples: [], first: { s: [], visits: [] }, last: { s: [], visits: [], favorites: [], up: [], down: [] }, sorts: [] });
  const index = new Map(day.ids.map((id, i) => [id, i]));
  const s = day.samples.length; // index of the sample this run adds; first.s / last.s point at samples[]
  for (const id of ids) {
    if (!details[id] || index.has(id)) continue;
    index.set(id, day.ids.length);
    day.ids.push(id);
    day.first.s.push(s);
    day.first.visits.push(details[id].visits);
    for (const k of Object.keys(day.last)) day.last[k].push(null);
  }
  const ccu = new Array(day.ids.length).fill(null);
  for (const [id, i] of index) {
    const g = details[id];
    if (!g) continue;
    ccu[i] = g.playing ?? 0;
    day.last.s[i] = s;
    day.last.visits[i] = g.visits;
    day.last.favorites[i] = g.favoritedCount;
    day.last.up[i] = votes[id]?.upVotes ?? day.last.up[i];
    day.last.down[i] = votes[id]?.downVotes ?? day.last.down[i];
  }
  // Older samples in the day are shorter than ids when games were added later; readers pad with null.
  day.samples.push({ t, ccu });
  day.sorts = sorts; // latest chart positions of the day

  await writeFile(dayUrl, JSON.stringify(day));
  meta.updated = t;
  await writeFile(new URL('meta.json', DATA), JSON.stringify(meta, null, 1));
  const online = ccu.reduce((a, b) => a + (b ?? 0), 0);
  console.log(`${t}: ${Object.keys(details).length} games, ${sorts.length} charts, ${online.toLocaleString('en-US')} players online on tracked games, sample ${day.samples.length} of ${date}${missed ? `, ${missed} skipped after rate limits` : ''}`);
}

main().catch(err => { console.error(err); process.exit(1); });
