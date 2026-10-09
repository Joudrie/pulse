// Small hand-rolled SVG charts. One y-axis each, 2px lines, thin rounded bars,
// recessive grid, crosshair + tooltip on lines, per-bar tooltip on bars.
const NS = 'http://www.w3.org/2000/svg';
const tip = () => document.getElementById('tip');

const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// 1-2-5 steps so ticks land on round numbers.
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + step);
  return ticks;
}

export function showTip(evt, when, rows) {
  const t = tip();
  t.replaceChildren();
  const w = document.createElement('div');
  w.className = 'when'; w.textContent = when;
  t.append(w);
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'row';
    const key = document.createElement('span'); key.className = 'key'; key.style.background = r.color;
    const v = document.createElement('strong'); v.textContent = r.value;
    const l = document.createElement('span'); l.textContent = r.label;
    row.append(key, v, l);
    t.append(row);
  }
  t.hidden = false;
  const pad = 14, bw = t.offsetWidth, bh = t.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY - bh - pad;
  if (x + bw > innerWidth - 8) x = evt.clientX - bw - pad;
  if (y < 8) y = evt.clientY + pad;
  t.style.left = `${x}px`; t.style.top = `${y}px`;
}
export const hideTip = () => { tip().hidden = true; };

// Coalesce pointer events to one DOM update per frame.
function perFrame(fn) {
  let queued = null;
  return evt => {
    const first = queued === null;
    queued = { clientX: evt.clientX, clientY: evt.clientY };
    if (first) requestAnimationFrame(() => { const e = queued; queued = null; fn(e); });
  };
}

function frame(container) {
  const w = container.clientWidth, h = container.clientHeight;
  const m = { top: 8, right: 8, bottom: 24, left: 48 };
  return { w, h, m, iw: Math.max(10, w - m.left - m.right), ih: Math.max(10, h - m.top - m.bottom) };
}

function empty(container, message) {
  const d = document.createElement('div');
  d.className = 'empty'; d.textContent = message;
  container.replaceChildren(d);
}

function axes(svg, f, ticks, fmtY, xTicks) {
  const g = el('g', { class: 'axis' });
  for (const t of ticks.values) {
    const y = f.m.top + f.ih - (t / ticks.max) * f.ih;
    g.append(el('line', { class: t === 0 ? 'baseline' : 'gridline', x1: f.m.left, x2: f.m.left + f.iw, y1: y, y2: y }));
    const lab = el('text', { x: f.m.left - 8, y: y + 4, 'text-anchor': 'end' });
    lab.textContent = fmtY(t);
    g.append(lab);
  }
  for (const xt of xTicks) {
    const lab = el('text', { x: xt.x, y: f.h - 6, 'text-anchor': xt.anchor ?? 'middle' });
    lab.textContent = xt.label;
    g.append(lab);
  }
  svg.append(g);
}

// Up to ~6 evenly spaced x labels, first and last pinned to the edges.
function pickXTicks(points, xAt, fmtX, width) {
  const n = points.length, want = Math.max(2, Math.min(6, Math.floor(width / 90)));
  if (n === 1) return [{ x: xAt(0), label: fmtX(points[0].x) }];
  const idx = [...new Set(Array.from({ length: want }, (_, i) => Math.round((i * (n - 1)) / (want - 1))))];
  return idx.map((i, k) => ({ x: xAt(i), label: fmtX(points[i].x), anchor: k === 0 ? 'start' : k === idx.length - 1 ? 'end' : 'middle' }));
}

export function lineChart(container, points, { color, label, fmtY, fmtX, fmtWhen, emptyText }) {
  const valid = points.filter(p => p.y != null);
  if (!valid.length) return empty(container, emptyText || 'No data yet');
  const f = frame(container);
  const max = Math.max(...valid.map(p => p.y));
  const values = niceTicks(max);
  const ticks = { values, max: values.at(-1) };
  const n = points.length;
  const xAt = i => f.m.left + (n === 1 ? f.iw / 2 : (i / (n - 1)) * f.iw);
  const yAt = v => f.m.top + f.ih - (v / ticks.max) * f.ih;

  const svg = el('svg', { viewBox: `0 0 ${f.w} ${f.h}`, role: 'img', 'aria-label': label });
  axes(svg, f, ticks, fmtY, pickXTicks(points, xAt, fmtX, f.iw));

  // Line breaks at gaps instead of bridging missing days.
  let d = '', pen = false;
  points.forEach((p, i) => {
    if (p.y == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.y).toFixed(1)}`;
    pen = true;
  });
  svg.append(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  // A lone point (or a short run) still needs a visible mark.
  if (valid.length <= 2) valid.forEach(p => svg.append(el('circle', { cx: xAt(points.indexOf(p)), cy: yAt(p.y), r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 })));

  const cross = el('line', { class: 'crosshair', y1: f.m.top, y2: f.m.top + f.ih, visibility: 'hidden' });
  const dot = el('circle', { r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  const hit = el('rect', { x: f.m.left, y: f.m.top, width: f.iw, height: f.ih, fill: 'transparent', tabindex: 0 });
  svg.append(cross, dot, hit);
  const at = i => {
    const p = points[i];
    cross.setAttribute('x1', xAt(i)); cross.setAttribute('x2', xAt(i)); cross.setAttribute('visibility', 'visible');
    if (p.y == null) dot.setAttribute('visibility', 'hidden');
    else { dot.setAttribute('cx', xAt(i)); dot.setAttribute('cy', yAt(p.y)); dot.setAttribute('visibility', 'visible'); }
    return p;
  };
  const move = evt => {
    const r = svg.getBoundingClientRect();
    const x = ((evt.clientX - r.left) / r.width) * f.w;
    const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((x - f.m.left) / f.iw) * (n - 1))));
    const p = at(i);
    showTip(evt, fmtWhen(p.x), [{ color, value: p.y == null ? 'no data' : fmtY(p.y, true), label }]);
  };
  const leave = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
  hit.addEventListener('pointermove', perFrame(move));
  hit.addEventListener('pointerleave', leave);
  hit.addEventListener('blur', leave);
  hit.addEventListener('focus', () => {
    const i = n - 1, p = at(i), r = svg.getBoundingClientRect();
    showTip({ clientX: r.left + (xAt(i) / f.w) * r.width, clientY: r.top + (yAt(p.y ?? 0) / f.h) * r.height }, fmtWhen(p.x), [{ color, value: p.y == null ? 'no data' : fmtY(p.y, true), label }]);
  });
  container.replaceChildren(svg);
}

export function barChart(container, points, { color, label, fmtY, fmtX, fmtWhen, emptyText, note }) {
  const valid = points.filter(p => p.y != null);
  if (!valid.length) return empty(container, emptyText || 'No data yet');
  const f = frame(container);
  const max = Math.max(...valid.map(p => p.y));
  const values = niceTicks(max);
  const ticks = { values, max: values.at(-1) };
  const n = points.length, slot = f.iw / n;
  const bw = Math.max(2, Math.min(28, slot - 2)); // 2px surface gap between bars
  const xAt = i => f.m.left + slot * i + slot / 2;
  const svg = el('svg', { viewBox: `0 0 ${f.w} ${f.h}`, role: 'img', 'aria-label': label });
  axes(svg, f, ticks, fmtY, pickXTicks(points, xAt, fmtX, f.iw));
  points.forEach((p, i) => {
    if (p.y == null) return;
    const h = Math.max(1, (p.y / ticks.max) * f.ih), x = xAt(i) - bw / 2, y = f.m.top + f.ih - h;
    const r = Math.min(4, bw / 2, h);
    // Rounded at the data end, square on the baseline.
    const d = `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + bw - r}Q${x + bw} ${y} ${x + bw} ${y + r}V${y + h}Z`;
    const bar = el('path', { d, fill: color, 'fill-opacity': p.provisional ? 0.45 : 1 });
    const hit = el('rect', { x: xAt(i) - slot / 2, y: f.m.top, width: slot, height: f.ih, fill: 'transparent', tabindex: 0 });
    const show = evt => { bar.setAttribute('fill-opacity', p.provisional ? 0.6 : 0.8); showTip(evt, fmtWhen(p.x) + (p.provisional ? ` (${note})` : ''), [{ color, value: fmtY(p.y, true), label }]); };
    const hide = () => { bar.setAttribute('fill-opacity', p.provisional ? 0.45 : 1); hideTip(); };
    hit.addEventListener('pointermove', perFrame(show));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => { const r = svg.getBoundingClientRect(); show({ clientX: r.left + (xAt(i) / f.w) * r.width, clientY: r.top + (y / f.h) * r.height }); });
    hit.addEventListener('blur', hide);
    svg.append(bar, hit);
  });
  container.replaceChildren(svg);
}

export function sparkline(values, color) {
  const svg = el('svg', { class: 'spark', viewBox: '0 0 96 24', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  const v = values.filter(x => x != null);
  if (v.length < 2) {
    if (v.length === 1) svg.append(el('circle', { cx: 92, cy: 12, r: 2.5, fill: color }));
    return svg;
  }
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1, n = values.length;
  let d = '', pen = false;
  values.forEach((x, i) => {
    if (x == null) { pen = false; return; }
    const px = 2 + (i / (n - 1)) * 92, py = 21 - ((x - lo) / span) * 18;
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
    pen = true;
  });
  svg.append(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
  return svg;
}

// Re-draw a chart whenever its box changes size.
export function responsive(container, draw) {
  draw();
  if (container._ro) container._ro.disconnect();
  let last = container.clientWidth;
  container._ro = new ResizeObserver(() => { if (container.clientWidth !== last) { last = container.clientWidth; draw(); } });
  container._ro.observe(container);
}
