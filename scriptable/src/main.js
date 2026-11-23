// Line Monitor for iPhone (Scriptable). Pure Telecom VDSL line stats and drops,
// read straight from the Pure box over home Wi-Fi. No server needed.
// https://github.com/YabbaYabbaYabba/pure-line-monitor
//
// The box's password is kept in the iPhone Keychain, never in this file.
// Be gentle with the box: one login per read with a proper logout, at most one read a
// minute, a pause after any error, and no log download (it upset the box's web page).

const VERSION = "1.0.0";
const DEFAULTS = { host: "192.168.1.254", user: "admin" };
const KC = { pass: "pure-line-monitor.password", host: "pure-line-monitor.host", user: "pure-line-monitor.user" };
const MIN_READ_GAP = 60;          // seconds between real reads of the box
const BACKOFF = [600, 1200, 1800]; // pause after 1, 2, 3+ errors in a row
const RESYNC_GAP = 90;             // a sync time this much later = the line re-synced
const KEEP_DAYS = 30;
const MAX_SAMPLES = 3000;

/*__CRYPTO__*/

// ---------------------------------------------------------------- settings

function kcGet(k, dflt) {
  try { return Keychain.contains(k) ? Keychain.get(k) : dflt; } catch (e) { return dflt; }
}
function settings() {
  return { host: kcGet(KC.host, DEFAULTS.host), user: kcGet(KC.user, DEFAULTS.user), pass: kcGet(KC.pass, null) };
}

async function askSettings(first) {
  const s = settings();
  const a = new Alert();
  a.title = first ? "Connect to your Pure box" : "Settings";
  a.message = "The password is stored in your iPhone Keychain. It is only sent to the Pure box, hashed.";
  a.addTextField("Router address", s.host);
  a.addTextField("Username", s.user);
  a.addSecureTextField(s.pass ? "Password (leave blank to keep)" : "Password", "");
  a.addAction("Save");
  if (!first) a.addDestructiveAction("Clear history");
  a.addCancelAction("Cancel");
  const i = await a.presentAlert();
  if (i === -1) return false;
  if (!first && i === 1) {
    const st = loadStore();
    st.samples = []; st.events = []; st.meta.last_reset_ts = null;
    saveStore(st);
    return true;
  }
  const host = a.textFieldValue(0).trim() || DEFAULTS.host;
  const user = a.textFieldValue(1).trim() || DEFAULTS.user;
  const pass = a.textFieldValue(2);
  Keychain.set(KC.host, host);
  Keychain.set(KC.user, user);
  if (pass) Keychain.set(KC.pass, pass);
  const st = loadStore();
  st.meta.auth_method = null; st.meta.fails = 0; st.meta.next_try = 0;
  saveStore(st);
  return !!(pass || s.pass);
}

// ---------------------------------------------------------------- storage

const FM = FileManager.local();
const STORE = FM.joinPath(FM.documentsDirectory(), "line-monitor-data.json");

function loadStore() {
  try {
    if (FM.fileExists(STORE)) {
      const s = JSON.parse(FM.readString(STORE));
      s.meta = s.meta || {};
      s.samples = s.samples || [];
      s.events = s.events || [];
      return s;
    }
  } catch (e) { /* start fresh */ }
  return { samples: [], events: [], meta: {} };
}

function saveStore(st) {
  const cutoff = Date.now() / 1000 - KEEP_DAYS * 86400;
  st.samples = st.samples.filter((x) => x.ts >= cutoff).slice(-MAX_SAMPLES);
  st.events = st.events.filter((x) => x.ts >= cutoff - 86400);
  FM.writeString(STORE, JSON.stringify(st));
}

function addEvent(st, ts, kind, source, text) {
  ts = Math.round(ts);
  if (st.events.some((e) => e.kind === kind && Math.abs(e.ts - ts) <= 20)) return;
  st.events.push({ ts, kind, source, text });
}

// ---------------------------------------------------------------- Sagemcom JSON-req client

const API = "/cgi/json-req";
const OK = ["XMO_REQUEST_NO_ERR", "Ok"];

class BoxError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

function quoteXpath(x) {
  return encodeURIComponent(x).replace(/%2F/g, "/").replace(/%3D/g, "=").replace(/%5B/g, "[")
    .replace(/%5D/g, "]").replace(/%40/g, "@").replace(/%22/g, '"');
}

class Box {
  constructor(host, user, pass, method) {
    this.host = host; this.user = user; this.method = method;
    this.passHash = this.hash(pass);
    this.sessionId = 0; this.serverNonce = ""; this.requestId = -1;
  }
  hash(s) { return this.method === "SHA512" ? sha512(s) : md5(s); }

  async request(actions, priority = false) {
    this.requestId += 1;
    const cnonce = Math.floor(Math.random() * 500000);
    const cred = this.hash(`${this.user}:${this.serverNonce}:${this.passHash}`);
    const authKey = this.hash(`${cred}:${this.requestId}:${cnonce}:JSON:${API}`);
    const payload = { request: { id: this.requestId, "session-id": this.sessionId, priority, actions, cnonce, "auth-key": authKey } };
    const r = new Request(`http://${this.host}${API}`);
    r.method = "POST";
    r.timeoutInterval = 15;
    r.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    r.body = "req=" + encodeURIComponent(JSON.stringify(payload));
    let text;
    try {
      text = await r.loadString();
    } catch (e) {
      throw new BoxError("UNREACHABLE", `Can't reach the Pure box at ${this.host}. Are you on home Wi-Fi?`);
    }
    const status = r.response && r.response.statusCode;
    if (status && status !== 200) throw new BoxError("HTTP" + status, `The Pure box returned HTTP ${status}.`);
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new BoxError("BADREPLY", "The Pure box sent an unexpected reply."); }
    const top = json.reply && json.reply.error && json.reply.error.description;
    if (OK.includes(top)) return json;
    if (top === "XMO_REQUEST_ACTION_ERR") {
      for (const a of json.reply.actions || []) {
        const d = a.error && a.error.description;
        if (d && d !== "XMO_NO_ERR") throw new BoxError(d);
      }
      return json;
    }
    throw new BoxError(top || "UNKNOWN");
  }

  async login() {
    const action = { id: 0, method: "logIn", parameters: {
      user: this.user, persistent: true,
      "session-options": {
        nss: [{ name: "gtw", uri: "http://sagemcom.com/gateway-data" }],
        language: "ident",
        "context-flags": { "get-content-name": true, "local-time": true },
        "capability-depth": 2,
        "capability-flags": { name: true, "default-value": false, restriction: true, description: false },
        "time-format": "ISO_8601",
        "write-only-string": "_XMO_WRITE_ONLY_",
        "undefined-write-only-string": "_XMO_UNDEFINED_WRITE_ONLY_",
      },
    } };
    const json = await this.request([action], true);
    const p = json.reply.actions[0].callbacks[0].parameters;
    if (p.id === undefined || p.id === null || !p.nonce) throw new BoxError("XMO_AUTHENTICATION_ERR");
    this.sessionId = p.id;
    this.serverNonce = String(p.nonce);
  }

  async getValue(xpath) {
    const json = await this.request([{ id: 0, method: "getValue", xpath: quoteXpath(xpath), options: {} }]);
    const cb = json.reply.actions[0].callbacks[0];
    return cb && cb.parameters ? cb.parameters.value : null;
  }

  async logout() {
    try { await this.request([{ id: 0, method: "logOut" }]); } catch (e) { /* session ends anyway */ }
  }
}

const AUTH_ERRORS = ["XMO_AUTHENTICATION_ERR", "XMO_ACCESS_RESTRICTION_ERR"];

async function loginBox(cfg, st) {
  const methods = st.meta.auth_method ? [st.meta.auth_method] : ["MD5", "SHA512"];
  let last;
  for (const m of methods) {
    const box = new Box(cfg.host, cfg.user, cfg.pass, m);
    try {
      await box.login();
      st.meta.auth_method = m;
      return box;
    } catch (e) {
      last = e;
      if (!AUTH_ERRORS.includes(e.code)) throw e; // network/500: don't keep trying
    }
  }
  if (st.meta.auth_method) st.meta.auth_method = null; // try detection again next time
  throw last;
}

// ---------------------------------------------------------------- parsing (same rules as the NAS app)

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

function walk(obj, path, out) {
  if (Array.isArray(obj)) obj.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") walk(v, `${path}/${k}`, out);
      else out.push([`${path}/${k}`, k, v]);
    }
  }
  return out;
}

function find(obj, names, prefer) {
  const wanted = names.map(norm);
  let hits = walk(obj, "", []).filter(([, k, v]) => wanted.includes(norm(k)) && v !== null && v !== "")
    .map(([p, k, v]) => [wanted.indexOf(norm(k)), p, v]);
  if (!hits.length) return null;
  if (prefer) {
    const pref = hits.filter((h) => h[1].toLowerCase().includes(prefer));
    if (pref.length) hits = pref;
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits[0][2];
}

function container(tree, name) {
  if (Array.isArray(tree)) { for (const v of tree) { const r = container(v, name); if (r) return r; } }
  else if (tree && typeof tree === "object") {
    for (const [k, v] of Object.entries(tree)) if (norm(k) === name) return v;
    for (const v of Object.values(tree)) { const r = container(v, name); if (r) return r; }
  }
  return null;
}

function first(obj) {
  if (Array.isArray(obj)) return obj.length ? obj[0] : {};
  if (obj && typeof obj === "object") {
    const vals = Object.values(obj);
    if (vals.length === 1 && vals[0] && typeof vals[0] === "object") return first(vals[0]);
  }
  return obj || {};
}

function n(v) {
  if (v === null || v === undefined) return null;
  const x = parseFloat(String(v).trim().split(/\s+/)[0]);
  return Number.isFinite(x) ? x : null;
}
function dB(v) {
  let x = n(v);
  if (x === null) return null;
  if (Number.isInteger(x) && Math.abs(x) > 70) x /= 10; // tenths of a dB
  return Math.round(x * 10) / 10;
}
function mbps(v) {
  let x = n(v);
  if (x === null) return null;
  if (x > 5000000) x /= 1000;
  return Math.round(x / 100) / 10;
}

function parseDsl(tree, now) {
  const line = first(container(tree, "lines") || tree);
  const chan = first(container(tree, "channels") || tree);
  const s = { ts: now };
  const st = find(line, ["status", "link_status"]);
  s.status = st === null ? null : String(st);
  s.ds_rate = mbps(find(chan, ["downstream_curr_rate", "downstream_current_rate"])) ?? mbps(find(line, ["downstream_curr_rate"]));
  s.us_rate = mbps(find(chan, ["upstream_curr_rate", "upstream_current_rate"])) ?? mbps(find(line, ["upstream_curr_rate"]));
  s.ds_max = mbps(find(line, ["downstream_max_bit_rate", "downstream_max_rate", "downstream_attainable_rate"]));
  s.us_max = mbps(find(line, ["upstream_max_bit_rate", "upstream_max_rate", "upstream_attainable_rate"]));
  s.ds_att = dB(find(line, ["downstream_attenuation", "downstream_line_attenuation"]));
  s.us_att = dB(find(line, ["upstream_attenuation", "upstream_line_attenuation"]));
  s.ds_nm = dB(find(line, ["downstream_noise_margin", "downstream_snr_margin"]));
  s.us_nm = dB(find(line, ["upstream_noise_margin", "upstream_snr_margin"]));
  let up = n(find(line, ["showtime_start"], "stats"));
  if (up === null) up = n(find(line, ["last_change", "uptime"]));
  s.uptime_s = up !== null && up >= 0 ? Math.round(up) : null;
  s.reset_ts = s.uptime_s !== null ? Math.round(now - s.uptime_s) : null;
  return s;
}

const isUp = (s) => /^(up|showtime|connected)$/i.test(s.status || "");

// ---------------------------------------------------------------- one gentle read

async function readBox(cfg, st, manual) {
  const now = Date.now() / 1000;
  const m = st.meta;
  if (m.last_try && now - m.last_try < MIN_READ_GAP) return "skipped";
  if (m.fails && m.next_try && now < m.next_try) return "backoff";
  m.last_try = now;
  let box;
  try {
    box = await loginBox(cfg, st);
    if (!m.model) {
      try {
        const di = await box.getValue("Device/DeviceInfo/ModelName");
        if (di) m.model = String(di);
      } catch (e) { m.model = m.model || null; }
    }
    const tree = await box.getValue("Device/DSL");
    const s = parseDsl(tree, Date.now() / 1000);
    record(st, s);
    m.fails = 0; m.next_try = 0; m.error = null; m.last_ok = s.ts;
    return "ok";
  } catch (e) {
    m.fails = (m.fails || 0) + 1;
    m.next_try = now + BACKOFF[Math.min(m.fails, BACKOFF.length) - 1];
    m.error = friendly(e, cfg);
    return "error";
  } finally {
    if (box) await box.logout(); // never leave a session open on the box
  }
}

function record(st, s) {
  const m = st.meta;
  if (s.reset_ts) {
    if (m.last_reset_ts && s.reset_ts - m.last_reset_ts > RESYNC_GAP) {
      addEvent(st, s.reset_ts, "resync", "poll", "Line re-synced (seen by the app)");
    }
    m.last_reset_ts = s.reset_ts;
  }
  if (!isUp(s) && m.was_up !== false) addEvent(st, s.ts, "down", "poll", `Line status: ${s.status}`);
  m.was_up = isUp(s);
  st.samples.push(s);
}

function friendly(e, cfg) {
  const c = e.code || "";
  if (c === "UNREACHABLE") return e.message;
  if (AUTH_ERRORS.includes(c)) return "Login to the Pure box failed. Check the password in Settings.";
  if (c === "XMO_LOGIN_RETRY_ERR") return "The Pure box has locked logins after too many attempts.";
  if (c === "XMO_MAX_SESSION_COUNT_ERR") return "The Pure box has too many open sessions. Log out of its web page.";
  if (c.startsWith("HTTP5")) return "The Pure box's web interface returned an error.";
  return `Pure box error: ${e.message || c}`;
}

// ---------------------------------------------------------------- data for the dashboard

function view(st, cfg) {
  const now = Date.now() / 1000;
  const downs = st.events.filter((e) => e.kind === "down").sort((a, b) => a.ts - b.ts);
  const resyncs = st.events.filter((e) => e.kind === "resync").sort((a, b) => a.ts - b.ts);
  const used = new Set();
  const drops = [];
  for (const d of downs) {
    const r = resyncs.find((x) => !used.has(x) && x.ts > d.ts && x.ts <= d.ts + 600);
    if (r) used.add(r);
    drops.push({ down_ts: d.ts, up_ts: r ? r.ts : null, duration_s: r ? r.ts - d.ts : null, source: d.source, text: d.text });
  }
  for (const r of resyncs) if (!used.has(r)) drops.push({ down_ts: null, up_ts: r.ts, duration_s: null, source: r.source, text: r.text });
  drops.sort((a, b) => (b.down_ts || b.up_ts) - (a.down_ts || a.up_ts));
  const t = (o) => o.down_ts || o.up_ts;
  const m = st.meta;
  let error = m.error || null;
  if (error && m.fails && m.next_try > now) error += ` Trying again after ${new Date(m.next_try * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  return {
    now,
    tz: null,
    poll_seconds: null,
    router: {
      host: cfg.host, info: { model_name: m.model || "Pure Telecom" },
      ok: m.error ? false : (m.last_ok ? true : null), error, retry_in: null,
      last_ok_ts: m.last_ok || null, last_try_ts: m.last_try || null, last_log_ts: null, log_error: null,
    },
    current: st.samples.length ? st.samples[st.samples.length - 1] : null,
    history: thin(st.samples, 600),
    drops: drops.filter((o) => t(o) >= now - 30 * 86400),
    counts: {
      h24: drops.filter((o) => t(o) >= now - 86400).length,
      d7: drops.filter((o) => t(o) >= now - 7 * 86400).length,
      d30: drops.filter((o) => t(o) >= now - 30 * 86400).length,
    },
    range: "30d",
  };
}

function thin(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

// ---------------------------------------------------------------- dashboard (WebView)

const CSS = /*__CSS__*/"";
const APPJS = /*__APPJS__*/"";
const BODY = /*__BODY__*/"";

function page(data) {
  const safe = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${CSS}</style></head><body>${BODY}
<script>window.LM_EMBED = true; window.LM_DATA = ${safe(data)};</script>
<script>${APPJS}</script></body></html>`;
}

async function runApp() {
  let cfg = settings();
  if (!cfg.pass) {
    if (!(await askSettings(true))) return;
    cfg = settings();
  }
  const st = loadStore();
  const wv = new WebView();
  await wv.loadHTML(page(view(st, cfg)));
  let open = true;
  const closed = wv.present(true).then(() => { open = false; });
  const push = async () => {
    try { await wv.evaluateJavaScript(`window.LM_render(${JSON.stringify(view(st, cfg))})`, false); } catch (e) { /* closed */ }
  };
  // Read the box once on open (respects the 1-minute gap and any backoff)
  await readBox(cfg, st, false);
  saveStore(st);
  await push();

  while (open) {
    const action = await Promise.race([wv.evaluateJavaScript("LM_wait(completion)", true), closed]);
    if (!open || !action) break;
    if (action === "refresh") {
      await readBox(cfg, st, true);
      saveStore(st);
      await push();
    } else if (action === "settings") {
      if (await askSettings(false)) {
        cfg = settings();
        Object.assign(st, loadStore());
        st.meta.last_try = 0;
        await readBox(cfg, st, true);
        saveStore(st);
      }
      await push();
    }
  }
}

// ---------------------------------------------------------------- home-screen widget

function fmtDur(s) {
  if (s === null || s === undefined) return "–";
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

async function runWidget() {
  const cfg = settings();
  const st = loadStore();
  if (cfg.pass) {
    await readBox(cfg, st, false);
    saveStore(st);
  }
  const v = view(st, cfg);
  const c = v.current;
  const fam = config.widgetFamily || "medium";
  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  const accent = new Color("#38bdf8"), muted = new Color("#8a94a6"), bad = new Color("#f87171"), good = new Color("#34d399");

  if (fam.startsWith("accessory")) {
    const t = w.addText(c ? `↓${c.ds_rate ?? "–"} · ${c.ds_att ?? "–"} dB` : "Line –");
    t.font = Font.boldSystemFont(14);
    const t2 = w.addText(`Drops 24h: ${v.counts.h24}`);
    t2.font = Font.systemFont(12);
    Script.setWidget(w);
    return;
  }

  const g = new LinearGradient();
  g.colors = [new Color("#111827"), new Color("#0b0f17")];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 16, 14, 16);

  const head = w.addStack();
  head.centerAlignContent();
  const dot = head.addText("●");
  const up = c && isUp(c) && v.router.ok !== false;
  dot.textColor = !c ? muted : up ? good : bad;
  dot.font = Font.systemFont(10);
  head.addSpacer(5);
  const title = head.addText(!cfg.pass ? "Tap to set up" : v.router.ok === false ? "Can't read box" : up ? "Line up" : c ? "Line down" : "No reading yet");
  title.font = Font.semiboldSystemFont(12);
  title.textColor = Color.white();
  head.addSpacer();
  if (v.router.last_ok_ts) {
    const when = head.addDate(new Date(v.router.last_ok_ts * 1000));
    when.applyTimeStyle();
    when.font = Font.systemFont(11);
    when.textColor = muted;
  }
  w.addSpacer(6);

  const big = w.addStack();
  big.bottomAlignContent();
  const ds = big.addText(c && c.ds_rate !== null ? c.ds_rate.toFixed(1) : "–");
  ds.font = Font.boldRoundedSystemFont(fam === "small" ? 30 : 34);
  ds.textColor = Color.white();
  big.addSpacer(4);
  const unit = big.addText("Mbps ↓");
  unit.font = Font.mediumSystemFont(12);
  unit.textColor = accent;
  w.addSpacer(6);

  const row = (label, value, color) => {
    const s = w.addStack();
    const l = s.addText(label);
    l.font = Font.systemFont(12);
    l.textColor = muted;
    s.addSpacer();
    const r = s.addText(value);
    r.font = Font.semiboldSystemFont(12);
    r.textColor = color || Color.white();
  };
  row("Attenuation", c && c.ds_att !== null ? `${c.ds_att.toFixed(1)} dB` : "–");
  row("Drops 24h", String(v.counts.h24), v.counts.h24 ? bad : good);
  if (fam !== "small") {
    row("Up for", c && up ? fmtDur(v.now - c.reset_ts) : "–");
    row("Upload · margin", c ? `${c.us_rate ?? "–"} Mbps · ${c.ds_nm ?? "–"} dB` : "–");
  }
  Script.setWidget(w);
}

// ---------------------------------------------------------------- start

if (config.runsInWidget) {
  await runWidget();
} else {
  await runApp();
}
Script.complete();
