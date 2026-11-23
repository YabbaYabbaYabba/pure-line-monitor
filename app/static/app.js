"use strict";

const $ = (id) => document.getElementById(id);
const state = { data: null, metric: "att", range: "24h", busy: false };
// EMBED: running inside the iPhone-only Scriptable app; data comes from the script, not /api
const EMBED = !!window.LM_EMBED;
const SPAN = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };
const inRange = (ts) => ts >= (state.data ? state.data.now : Date.now() / 1000) - SPAN[state.range];

// ------------------------------------------------------------ formatting
const tz = () => (state.data && state.data.tz) || undefined;
const fmt = (opts) => new Intl.DateTimeFormat("en-IE", { timeZone: tz(), ...opts });
const timeOf = (ts) => fmt({ hour: "2-digit", minute: "2-digit" }).format(ts * 1000);
const dayOf = (ts) => fmt({ weekday: "short", day: "numeric", month: "short" }).format(ts * 1000);
const dayKey = (ts) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(ts * 1000);
const num = (v, d = 1) => (v === null || v === undefined ? "–" : Number(v).toFixed(d));

function duration(s) {
  if (s === null || s === undefined) return "–";
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${timeOf(ts)}, ${dayOf(ts)}`;
}

function attQuality(v) {
  if (v === null || v === undefined) return ["–", ""];
  if (v <= 20) return ["Excellent", "good"];
  if (v <= 30) return ["Good", "good"];
  if (v <= 40) return ["Fair", "warn"];
  return ["Poor", "bad"];
}

function nmQuality(v) {
  if (v === null || v === undefined) return ["–", ""];
  if (v >= 10) return ["Excellent", "good"];
  if (v >= 6) return ["Good", "good"];
  if (v >= 3) return ["Marginal", "warn"];
  return ["Poor", "bad"];
}

function setChip(el, [text, cls]) {
  el.textContent = text;
  el.className = "chip " + cls;
}

// ------------------------------------------------------------ data
async function load(refresh = false) {
  if (EMBED) {
    if (!refresh) { if (state.data) render(); return; }
    if (state.busy) return;
    state.busy = true;
    $("refresh").classList.add("busy");
    send("refresh");
    return;
  }
  if (state.busy) return;
  state.busy = true;
  const btn = $("refresh");
  if (refresh) btn.classList.add("busy");
  try {
    const url = (refresh ? "/api/refresh" : "/api/status") + "?range=" + state.range;
    const res = await fetch(url, { method: refresh ? "POST" : "GET", cache: "no-store" });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    state.data = await res.json();
    render();
  } catch (e) {
    showBanner(`Can't reach the monitor: ${e.message}`, "bad");
    setPill("bad", "Offline");
  } finally {
    state.busy = false;
    btn.classList.remove("busy");
  }
}

// ---- bridge to the Scriptable app (EMBED only)
let bridgeCb = null, pending = null;
function send(action) {
  if (bridgeCb) { const cb = bridgeCb; bridgeCb = null; cb(action); } else { pending = action; }
}
window.LM_wait = (cb) => {
  if (pending) { const a = pending; pending = null; cb(a); } else { bridgeCb = cb; }
};
window.LM_render = (data) => {
  state.data = data;
  state.busy = false;
  $("refresh").classList.remove("busy");
  render();
};

function showBanner(text, kind) {
  const b = $("banner");
  if (!text) { b.hidden = true; return; }
  b.hidden = false;
  b.className = "banner " + (kind || "");
  b.textContent = text;
}

function setPill(cls, text) {
  $("pill").className = "pill " + cls;
  $("pill-text").textContent = text;
}

// ------------------------------------------------------------ render
function render() {
  const d = state.data;
  const c = d.current;
  const r = d.router;

  if (r.ok === false) {
    const retry = r.retry_in ? ` Next try in ${Math.round(r.retry_in / 60)} min.` : "";
    showBanner(r.error + retry + (c ? " Showing the last reading." : ""), "bad");
    setPill("bad", "Router error");
  } else if (r.log_error) {
    showBanner(r.log_error + " Drops are still detected from the line's sync time.", "warn");
  } else {
    showBanner("");
  }

  if (c) {
    const up = /^(up|showtime|connected)$/i.test(c.status || "");
    if (r.ok !== false) setPill(up ? "ok" : "bad", up ? "Line up" : `Line ${c.status || "down"}`);
    $("ds-rate").textContent = num(c.ds_rate);
    $("us-rate").textContent = num(c.us_rate);
    const pct = c.ds_max ? Math.min(100, (100 * c.ds_rate) / c.ds_max) : 0;
    $("ds-bar").style.width = pct + "%";
    $("max-text").textContent = c.ds_max
      ? `Line maximum ${num(c.ds_max)} ↓ / ${num(c.us_max)} ↑ Mbps · using ${Math.round(pct)}%`
      : "Line maximum –";
    $("ds-att").textContent = num(c.ds_att);
    setChip($("att-chip"), attQuality(c.ds_att));
    $("us-att").textContent = c.us_att ? `Up ${num(c.us_att)} dB` : "Up not reported";
    $("ds-nm").textContent = num(c.ds_nm);
    setChip($("nm-chip"), nmQuality(Math.min(c.ds_nm ?? 99, c.us_nm ?? 99)));
    $("us-nm").textContent = `Up ${num(c.us_nm)} dB`;
    const live = c.reset_ts ? d.now - c.reset_ts : c.uptime_s;
    $("uptime").textContent = up ? duration(live) : "Down";
    $("reset-at").textContent = c.reset_ts ? `Last reset ${timeOf(c.reset_ts)}, ${dayOf(c.reset_ts)}` : "Last reset –";
  } else if (r.ok !== false) {
    setPill("warn", "Waiting");
  }

  const n24 = d.counts.h24;
  $("drops-24").textContent = n24;
  $("drops-24").className = n24 ? "bad" : "good";
  $("drops-7").textContent = `7 days ${d.counts.d7} · 30 days ${d.counts.d30}`;

  const info = r.info || {};
  $("sub").textContent = [info.model_name || "Pure Telecom", "VDSL2", r.host].filter(Boolean).join(" · ");
  const auto = d.poll_seconds ? ` · auto every ${Math.round(d.poll_seconds / 60)} min` : "";
  $("updated").textContent = r.last_ok_ts ? `Updated ${ago(r.last_ok_ts)}${auto}` : "Not read yet";
  $("device").textContent = [info.software_version && `Firmware ${info.software_version}`,
    r.last_log_ts && `router log read ${ago(r.last_log_ts)}`].filter(Boolean).join(" · ");

  renderChart();
  renderDrops();
}

function renderDrops() {
  const d = state.data;
  const box = $("drops");
  const label = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" }[state.range];
  $("drops-range").textContent = label;
  box.replaceChildren();
  const drops = d.drops.filter((o) => inRange(o.down_ts || o.up_ts));
  if (!drops.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = `No drops in the ${label} 🎉`;
    box.append(e);
    return;
  }
  const groups = new Map();
  for (const o of drops) {
    const t = o.down_ts || o.up_ts;
    const k = dayKey(t);
    if (!groups.has(k)) groups.set(k, { t, items: [] });
    groups.get(k).items.push(o);
  }
  for (const { t, items } of groups.values()) {
    const g = document.createElement("div");
    g.className = "day";
    const h = document.createElement("div");
    h.className = "day-h";
    h.append(span(dayOf(t)), span(`${items.length} ${items.length === 1 ? "drop" : "drops"}`));
    g.append(h);
    for (const o of items) {
      const row = document.createElement("div");
      row.className = "drop-row";
      const dot = document.createElement("span");
      dot.className = "dot" + (o.down_ts ? "" : " resync");
      const detail = o.down_ts
        ? (o.up_ts ? `Back at ${timeOf(o.up_ts)} · offline ${duration(o.duration_s)}` : "Line went down")
        : "Line dropped and re-synced";
      row.append(dot, span(timeOf(o.down_ts || o.up_ts), "drop-time"), span(detail, "drop-detail"),
        span(o.source === "log" ? "router log" : "monitor", "src"));
      row.title = o.text || "";
      g.append(row);
    }
    box.append(g);
  }
}

function span(text, cls) {
  const s = document.createElement("span");
  s.textContent = text;
  if (cls) s.className = cls;
  return s;
}

// ------------------------------------------------------------ chart
const SVGNS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const METRICS = {
  att: { keys: ["ds_att", "us_att"], names: ["Down", "Up"], unit: "dB" },
  rate: { keys: ["ds_rate", "us_rate"], names: ["Down", "Up"], unit: "Mbps" },
  nm: { keys: ["ds_nm", "us_nm"], names: ["Down", "Up"], unit: "dB" },
};

function renderChart() {
  const d = state.data;
  const m = METRICS[state.metric];
  const box = $("chart");
  const legend = $("legend");
  legend.replaceChildren(span(`${m.names[0]} (${m.unit})`), span(`${m.names[1]}`, "s2"), span("Drop", "s3"));
  box.replaceChildren();

  // VDSL modems often report upstream attenuation as 0 ("not measured"): treat it as missing.
  const pts = d.history
    .filter((p) => p[m.keys[0]] !== null && inRange(p.ts))
    .map((p) => (state.metric === "att" && !p.us_att ? { ...p, us_att: null } : p));
  if (pts.length < 2) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "The chart fills in as readings come in.";
    box.append(e);
    return;
  }

  const W = box.clientWidth || 340, H = box.clientHeight || 200;
  const L = 34, R = 6, T = 8, B = 22;
  const span_ = SPAN[state.range];
  const x0 = Math.max(pts[0].ts, d.now - span_), x1 = d.now;
  const vals = pts.flatMap((p) => m.keys.map((k) => p[k])).filter((v) => v !== null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(1, (hi - lo) * 0.15);
  lo = Math.max(0, Math.floor(lo - pad)); hi = Math.ceil(hi + pad);
  const X = (t) => L + ((t - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / Math.max(1e-6, hi - lo)) * (H - T - B);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  const defs = el("defs");
  const grad = el("linearGradient", { id: "fade", x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(el("stop", { offset: "0%", "stop-color": getCss("--accent"), "stop-opacity": "0.28" }),
    el("stop", { offset: "100%", "stop-color": getCss("--accent"), "stop-opacity": "0" }));
  defs.append(grad);
  svg.append(defs);

  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    const y = Y(v);
    svg.append(el("line", { x1: L, x2: W - R, y1: y, y2: y, class: "grid-line" }));
    const t = el("text", { x: L - 6, y: y + 3, "text-anchor": "end", class: "axis" });
    t.textContent = v.toFixed(hi - lo < 6 ? 1 : 0);
    svg.append(t);
  }
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const ts = x0 + ((x1 - x0) * i) / ticks;
    const t = el("text", { x: X(ts), y: H - 5, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle", class: "axis" });
    t.textContent = state.range === "24h" ? timeOf(ts) : fmt({ day: "numeric", month: "short" }).format(ts * 1000);
    svg.append(t);
  }

  const path = (key) => {
    let s = "", gap = true;
    for (const p of pts) {
      if (p[key] === null) { gap = true; continue; }
      s += `${gap ? "M" : "L"}${X(p.ts).toFixed(1)},${Y(p[key]).toFixed(1)}`;
      gap = false;
    }
    return s;
  };
  const p1 = path(m.keys[0]);
  const first = pts[0], last = pts[pts.length - 1];
  svg.append(el("path", { d: `${p1}L${X(last.ts)},${H - B}L${X(first.ts)},${H - B}Z`, class: "area" }));
  svg.append(el("path", { d: path(m.keys[1]), class: "l2" }));
  svg.append(el("path", { d: p1, class: "l1" }));

  for (const o of d.drops) {
    const t = o.down_ts || o.up_ts;
    if (t < x0) continue;
    const x = X(t);
    svg.append(el("line", { x1: x, x2: x, y1: T, y2: H - B, class: "drop-line" }));
    svg.append(el("circle", { cx: x, cy: H - B, r: 3.5, class: "drop" }));
  }
  box.append(svg);
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#38bdf8";
}

// ------------------------------------------------------------ events
function wireSeg(id, attr, key, reload) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    for (const x of $(id).querySelectorAll("button")) x.classList.toggle("on", x === b);
    state[key] = b.dataset[attr];
    if (reload) load(false);
    else if (key === "range") { if (state.data) render(); }
    else renderChart();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireSeg("metric-seg", "metric", "metric", false);
  wireSeg("range-seg", "range", "range", !EMBED);
  $("refresh").addEventListener("click", () => load(true));
  if (EMBED) {
    const s = document.createElement("a");
    s.href = "#";
    s.className = "settings-link";
    s.textContent = "Settings";
    s.addEventListener("click", (e) => { e.preventDefault(); send("settings"); });
    $("device").after(s);
    if (window.LM_DATA) { state.data = window.LM_DATA; render(); }
  } else {
    load(false);
    setInterval(() => { if (!document.hidden) load(false); }, 60_000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });
  }
  let w = window.innerWidth;
  window.addEventListener("resize", () => { if (window.innerWidth !== w && state.data) { w = window.innerWidth; renderChart(); } });
});
