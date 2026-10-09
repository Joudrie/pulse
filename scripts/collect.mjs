// Takes one snapshot of Roblox's public game data and appends it to today's file.
// Run it as often as you like (the workflow runs it every 3 hours); each run adds
// one players-online sample, so a day's average and peak get better with more runs.
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
const KEEP_TRACKING_DAYS = 30; // keep following a game this long after it leaves every chart

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'pulse-trends/1.0 (+github actions)', accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(1500 * 2 ** i);
    }
  }
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
    await sleep(300);
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
  for (const batch of chunks(ids, BATCH)) {
    const d = await getJSON(`https://games.roblox.com/v1/games?universeIds=${batch.join(',')}`);
    for (const g of d.data ?? []) details[g.id] = g;
    await sleep(250);
  }
  const votes = {};
  for (const batch of chunks(ids, BATCH)) {
    const d = await getJSON(`https://games.roblox.com/v1/games/votes?universeIds=${batch.join(',')}`);
    for (const v of d.data ?? []) votes[v.id] = v;
    await sleep(250);
  }

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
    await sleep(250);
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
  console.log(`${t}: ${Object.keys(details).length} games, ${sorts.length} charts, ${online.toLocaleString('en-US')} players online on tracked games, sample ${day.samples.length} of ${date}`);
}

main().catch(err => { console.error(err); process.exit(1); });
