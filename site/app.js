import { lineChart, barChart, sparkline, responsive, hideTip } from './charts.js';

const $ = id => document.getElementById(id);
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US');
const fmtN = (v, full) => (v == null ? '–' : full ? whole.format(Math.round(v)) : compact.format(v));
const fmtUSD = (v, full) => (v == null ? '–' : '$' + (full ? whole.format(Math.round(v)) : compact.format(v)));
const fmtPct = v => (v == null ? '–' : `${Math.abs(v * 100) < 10 ? (Math.abs(v * 100)).toFixed(1) : Math.round(Math.abs(v * 100))}%`);
const day = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLong = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const clock = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const clockLong = t => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const BOARDS = [
  { key: 'played', label: 'Most played', hint: 'Average players online over the range.', rows: rs => [...rs].sort((a, b) => b.avg - a.avg) },
  { key: 'rising', label: 'Rising fastest', hint: 'Biggest change in average players online. Games under 1,000 players are left out, since small games swing wildly.', rows: rs => rs.filter(r => r.change != null && r.avg >= 1000).sort((a, b) => b.change - a.change) },
  { key: 'earning', label: 'Top earning (est.)', hint: 'Estimated developer revenue over the range, from new visits. A rough guide; see the note at the bottom.', rows: rs => rs.filter(r => r.revenue != null).sort((a, b) => b.revenue - a.revenue) },
  { key: 'roblox', label: "Roblox's earning chart", hint: "Roblox's own Top Earning chart as of the latest update. It ranks real earnings but shows no amounts.", rows: (rs, games) => rs.filter(r => games[r.id]?.ranks['top-earning']).sort((a, b) => games[a.id].ranks['top-earning'] - games[b.id].ranks['top-earning']) },
  { key: 'new', label: 'New games', hint: 'Released in the last 120 days, by average players online.', rows: rs => rs.filter(r => r.isNew).sort((a, b) => b.avg - a.avg) },
];
const PAGE = 50;

const state = { range: '1W', board: 'played', genre: null, metric: 'players', q: '', shown: PAGE, open: null };
let S; // summary.json

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('r')) state.range = p.get('r');
  if (BOARDS.some(b => b.key === p.get('b'))) state.board = p.get('b');
  state.genre = p.get('g') || null;
  state.open = p.get('id') ? Number(p.get('id')) : null;
}
function writeHash() {
  const p = new URLSearchParams();
  p.set('r', state.range); p.set('b', state.board);
  if (state.genre) p.set('g', state.genre);
  if (state.open) p.set('id', state.open);
  history.replaceState(null, '', '#' + p);
}

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
}

function renderStatus() {
  const s = $('status');
  s.replaceChildren(`Updated ${ago(S.updated)} · collecting since ${day(S.since)}`);
  if (S.repo) {
    const a = document.createElement('a');
    a.href = `https://github.com/${S.repo}/actions/workflows/refresh.yml`;
    a.textContent = 'Refresh now';
    a.title = 'Opens GitHub Actions. Press "Run workflow"; the page updates in about two minutes.';
    s.append(' · ', a);
  }
}

function renderRange() {
  const box = $('range');
  box.replaceChildren(...Object.values(S.ranges).map(r => {
    const b = document.createElement('button');
    b.type = 'button'; b.role = 'radio'; b.textContent = r.key; b.title = r.label;
    b.setAttribute('aria-checked', String(r.key === state.range));
    b.addEventListener('click', () => { state.range = r.key; state.shown = PAGE; render(); });
    return b;
  }));
}

function renderCoverage(R) {
  const n = $('coverage');
  if (R.key === '1D' || R.coverage >= R.days) { n.hidden = true; return; }
  n.hidden = false;
  n.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = `${R.coverage} of ${R.days} days`;
  n.append('This range has ', strong, ` of data so far. Pulse started collecting on ${day(S.since)}, so longer ranges fill in day by day. Changes are measured over the days collected.`);
}

function figure(label, value, sub) {
  const d = document.createElement('div');
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  if (sub) { const s = document.createElement('small'); s.textContent = sub; dd.append(s); }
  d.append(dt, dd);
  return d;
}

function renderOverview(R) {
  $('figures').replaceChildren(
    figure('Players online, average', fmtN(R.totals.players), 'across tracked games'),
    figure(`Est. developer revenue, ${R.key === '1D' ? 'latest day' : R.label.toLowerCase()}`, fmtUSD(R.totals.revenue),
      R.totals.revenue == null ? 'needs snapshots an hour apart; check back soon' : R.totals.provisional ? 'estimate; partly extrapolated from the first day' : 'estimate from new visits'),
    figure('Games tracked', fmtN(R.totals.games, true), `${S.charts.length} Roblox charts followed`),
  );
  const intraday = R.bySample;
  $('platform-sub').textContent = intraday ? `Every snapshot in the last 24 hours, ${R.line.length} so far`
    : R.key === '1D' ? 'Last 7 days, one snapshot a day' : `Daily snapshot, ${day(R.from)} to ${day(R.to)}`;
  const box = $('platform-chart');
  responsive(box, () => lineChart(box, R.line, {
    color: cssVar('--players'), label: 'Players online',
    fmtY: fmtN, fmtX: intraday ? clock : day, fmtWhen: intraday ? clockLong : dayLong,
  }));
  tableView($('platform-table'), R.line, intraday ? clockLong : dayLong, 'Players online', v => fmtN(v, true));
}

function tableView(box, points, fmtX, head, fmtV) {
  const t = document.createElement('table');
  const hr = t.createTHead().insertRow();
  for (const h of ['When', head]) { const th = document.createElement('th'); th.textContent = h; hr.append(th); }
  const body = t.createTBody();
  for (const p of [...points].reverse()) {
    const r = body.insertRow();
    r.insertCell().textContent = fmtX(p.x);
    r.insertCell().textContent = p.y == null ? '–' : fmtV(p.y);
  }
  box.replaceChildren(t);
}

function renderGenres(R) {
  const metric = state.metric;
  const total = R.genres.reduce((a, g) => a + g[metric], 0) || 1;
  const list = [...R.genres].sort((a, b) => b[metric] - a[metric]).filter(g => g[metric] > 0);
  const top = list[0]?.[metric] || 1;
  const color = metric === 'players' ? 'var(--players)' : 'var(--revenue)';
  $('genre-bars').replaceChildren(...list.map(g => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.genre === g.name));
    const lab = document.createElement('span'); lab.className = 'label'; lab.textContent = g.name;
    const val = document.createElement('span'); val.className = 'val';
    val.textContent = `${fmtPct(g[metric] / total)} · ${metric === 'players' ? fmtN(g.players) : fmtUSD(g.revenue)}`;
    const track = document.createElement('span'); track.className = 'track';
    const fill = document.createElement('span'); fill.className = 'fill';
    fill.style.cssText = `width:${(g[metric] / top) * 100}%;--bar:${color};display:block`;
    track.append(fill);
    b.append(lab, val, track);
    b.title = `${g.games} games`;
    b.addEventListener('click', () => { state.genre = state.genre === g.name ? null : g.name; state.shown = PAGE; render(); });
    li.append(b);
    return li;
  }));
  for (const btn of $('genre-metric').querySelectorAll('button')) btn.setAttribute('aria-checked', String(btn.dataset.metric === metric));
}

function changeCell(r) {
  const td = document.createElement('td');
  td.className = 'num';
  if (r.change == null) { td.textContent = '–'; td.classList.add('dim'); td.title = 'Needs two days of data'; return td; }
  const span = document.createElement('span');
  const up = r.change >= 0;
  span.className = `chg ${up ? 'up' : 'down'}`;
  const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = up ? '▲' : '▼'; arrow.setAttribute('aria-hidden', 'true');
  span.append(arrow, `${up ? '+' : '−'}${fmtPct(r.change)}`);
  td.title = r.basis ?? '';
  td.append(span);
  return td;
}

function renderBoard(R) {
  const board = BOARDS.find(b => b.key === state.board);
  $('board-tabs').replaceChildren(...BOARDS.map(b => {
    const t = document.createElement('button');
    t.type = 'button'; t.role = 'tab'; t.textContent = b.label;
    t.setAttribute('aria-selected', String(b.key === state.board));
    t.addEventListener('click', () => { state.board = b.key; state.shown = PAGE; render(); });
    return t;
  }));
  $('board-hint').textContent = board.hint;

  const f = $('filter');
  if (state.genre) {
    f.hidden = false;
    f.replaceChildren(`Showing ${state.genre} only.`);
    const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Show all genres';
    clear.addEventListener('click', () => { state.genre = null; render(); });
    f.append(clear);
  } else f.hidden = true;

  let rows = board.rows(R.board, S.games);
  if (state.genre) rows = rows.filter(r => S.games[r.id]?.genre === state.genre);
  if (state.q) { const q = state.q.toLowerCase(); rows = rows.filter(r => S.games[r.id]?.name.toLowerCase().includes(q) || S.games[r.id]?.creator.toLowerCase().includes(q)); }

  const tbody = $('games').tBodies[0];
  const color = cssVar('--players');
  tbody.replaceChildren(...rows.slice(0, state.shown).map((r, i) => {
    const g = S.games[r.id];
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.setAttribute('aria-selected', String(state.open === r.id));
    const rank = document.createElement('td'); rank.className = 'num'; rank.textContent = i + 1;
    const name = document.createElement('td');
    const wrap = document.createElement('div'); wrap.className = 'game';
    const img = g.icon ? Object.assign(document.createElement('img'), { src: g.icon, alt: '', loading: 'lazy', width: 36, height: 36 }) : Object.assign(document.createElement('span'), { className: 'ph' });
    const text = document.createElement('div');
    const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = g.name; nm.title = g.name;
    if (r.isNew) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'NEW'; nm.append(b); }
    const by = document.createElement('div'); by.className = 'by'; by.textContent = `${g.creator} · ${g.genre}`;
    text.append(nm, by); wrap.append(img, text); name.append(wrap);
    const sp = document.createElement('td'); sp.append(sparkline(r.spark, color));
    const avg = document.createElement('td'); avg.className = 'num'; avg.textContent = fmtN(r.avg);
    const rev = document.createElement('td'); rev.className = 'num'; rev.textContent = fmtUSD(r.revenue);
    if (r.provisional) { rev.title = 'Partly extrapolated from the first day of data'; rev.classList.add('dim'); }
    const er = document.createElement('td'); er.className = 'num';
    const rk = g.ranks['top-earning'];
    er.textContent = rk ? `#${rk}` : '–'; if (!rk) er.classList.add('dim');
    tr.append(rank, name, sp, avg, changeCell(r), rev, er);
    const open = () => openGame(r.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return tr;
  }));
  if (!rows.length) {
    const tr = tbody.insertRow(); const td = tr.insertCell(); td.colSpan = 7; td.className = 'dim';
    td.textContent = state.board === 'rising' ? 'Needs two days of data per game. Check back after tomorrow\'s update.'
      : state.board === 'earning' && !state.q && !state.genre ? 'Revenue needs two visit counts at least an hour apart. Check back after the next update.' : 'No games match.';
  }
  const more = $('more');
  more.hidden = rows.length <= state.shown;
  more.textContent = `Show more (${rows.length - state.shown} left)`;
}

const slug = name => name.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function openGame(id, scroll = true) {
  state.open = id; writeHash();
  for (const tr of $('games').tBodies[0].rows) tr.setAttribute('aria-selected', 'false');
  const g = S.games[id];
  const box = $('detail');
  if (!g) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren();
  const R = S.ranges[state.range];
  const row = R.board.find(r => r.id === id);

  const head = document.createElement('div'); head.className = 'detail-head';
  if (g.icon) head.append(Object.assign(document.createElement('img'), { src: g.icon, alt: '', width: 64, height: 64 }));
  const ht = document.createElement('div');
  const h = document.createElement('h2'); h.textContent = g.name;
  const p = document.createElement('p');
  p.textContent = `${g.creator}${g.verified ? ' (verified)' : ''} · ${g.genre}${g.subgenre ? ', ' + g.subgenre : ''} · released ${g.created ? dayLong(g.created) : 'unknown'}`;
  ht.append(h, p);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'close'; close.textContent = 'Close';
  close.addEventListener('click', () => { state.open = null; box.hidden = true; writeHash(); renderBoard(S.ranges[state.range]); });
  head.append(ht, close);

  const links = document.createElement('p'); links.className = 'links';
  for (const [label, href] of [
    ['Play on Roblox', `https://www.roblox.com/games/${g.place}`],
    ['RoTrends', `https://www.rotrends.com/game/${id}`],
    ['RoMonitor', `https://romonitorstats.com/experience/${g.place}/`],
    ['RoWatcher', `https://rowatcher.com/games/${id}`],
    ['Profitable.app', `https://profitable.app/roblox/games/${slug(g.name)}`],
  ]) { const a = document.createElement('a'); a.href = href; a.textContent = label; a.rel = 'noopener'; a.target = '_blank'; links.append(a); }

  const facts = document.createElement('dl'); facts.className = 'facts';
  const fact = (k, v) => { const d = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; d.append(dt, dd); facts.append(d); };
  fact(`Avg online (${R.key})`, fmtN(row?.avg, true));
  fact(`Peak sample (${R.key})`, fmtN(row?.peak, true));
  fact('Change', row?.change == null ? '–' : `${row.change >= 0 ? '+' : '−'}${fmtPct(row.change)}`);
  fact(`Est. revenue (${R.key})`, fmtUSD(row?.revenue, true));
  fact('Total visits', fmtN(g.visits));
  fact('Favorites', fmtN(g.favorites));
  fact('Likes', g.likes == null ? '–' : `${Math.round(g.likes * 100)}%`);
  fact('Roblox earning rank', g.ranks['top-earning'] ? `#${g.ranks['top-earning']}` : 'not charted');

  const charts = document.createElement('div'); charts.className = 'detail-charts';
  const block = (title, sub) => {
    const fig = document.createElement('figure'); fig.className = 'chart-block';
    const cap = document.createElement('figcaption');
    const t = document.createElement('span'); t.className = 'chart-title'; t.textContent = title;
    const s = document.createElement('span'); s.className = 'chart-sub'; s.textContent = sub;
    cap.append(t, s);
    const c = document.createElement('div'); c.className = 'chart small';
    fig.append(cap, c); charts.append(fig);
    return c;
  };
  const intraday = R.bySample;
  const cPlayers = block('Players online', intraday ? 'Every snapshot, last 24 hours' : R.key === '1D' ? 'Last 7 days' : 'Daily snapshot');
  const cRevenue = block('Estimated revenue per day', R.key === '1D' ? 'Last 7 days' : `${R.label}`);
  box.append(head, links, facts, charts);
  if (scroll) box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

  let G;
  try { G = await (await fetch(`data/games/${id}.json`)).json(); } catch { cPlayers.textContent = 'Could not load this game.'; return; }
  if (state.open !== id) return;
  const n = R.key === '1D' ? Math.min(7, G.dates.length) : Math.min(R.days, G.dates.length);
  const from = G.dates.length - n;
  const daily = G.dates.slice(from).map((d, i) => ({ x: d, y: G.ccu[from + i] }));
  const rev = G.dates.slice(from).map((d, i) => ({ x: d, y: G.revenue[from + i], provisional: G.provisional[from + i] }));
  responsive(cPlayers, () => lineChart(cPlayers, intraday ? G.intraday : daily, {
    color: cssVar('--players'), label: 'Players online', fmtY: fmtN, fmtX: intraday ? clock : day, fmtWhen: intraday ? clockLong : dayLong,
  }));
  responsive(cRevenue, () => barChart(cRevenue, rev, {
    color: cssVar('--revenue'), label: 'Estimated revenue', fmtY: fmtUSD, fmtX: day, fmtWhen: dayLong, note: 'extrapolated from part of the day',
    emptyText: 'Revenue needs two snapshots of visits. Check back after the next update.',
  }));
}

function render() {
  const R = S.ranges[state.range] ?? S.ranges['1W'];
  state.range = R.key;
  writeHash();
  renderRange();
  renderCoverage(R);
  renderOverview(R);
  renderGenres(R);
  renderBoard(R);
  if (state.open && !$('detail').hidden) openGame(state.open, false);
}

async function main() {
  readHash();
  try {
    S = await (await fetch('data/summary.json', { cache: 'no-cache' })).json();
  } catch {
    $('status').textContent = 'Could not load data.';
    return;
  }
  $('rpv').textContent = `$${S.revenuePerVisit.toFixed(5)}`;
  renderStatus();
  $('genre-metric').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.metric = b.dataset.metric; renderGenres(S.ranges[state.range]); } });
  $('search').addEventListener('input', e => { state.q = e.target.value.trim(); state.shown = PAGE; renderBoard(S.ranges[state.range]); });
  $('more').addEventListener('click', () => { state.shown += PAGE; renderBoard(S.ranges[state.range]); });
  // A fixed tooltip goes stale once the page moves under it.
  addEventListener('wheel', hideTip, { passive: true });
  addEventListener('touchstart', hideTip, { passive: true });
  render();
  if (state.open) openGame(state.open, true);
}

main();
