// Runs "scriptable/Line Monitor.js" in Node with stand-ins for Scriptable's iPhone APIs.
//   node tests/scriptable_harness.js <scenario.json>
// Scenario: { dir, widget, family, alert: {index, fields}, actions: ["refresh", ...], keychain: {...} }
// Prints a JSON summary: store contents, renders, widget texts, errors.

const fs = require("fs");
const path = require("path");

const sc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dir = sc.dir;
fs.mkdirSync(dir, { recursive: true });
const kcFile = path.join(dir, "keychain.json");
const kc = fs.existsSync(kcFile) ? JSON.parse(fs.readFileSync(kcFile, "utf8")) : (sc.keychain || {});
const out = { renders: 0, lastRender: null, alerts: 0, widgetTexts: [], html: null };

global.Keychain = {
  contains: (k) => k in kc,
  get: (k) => kc[k],
  set: (k, v) => { kc[k] = v; fs.writeFileSync(kcFile, JSON.stringify(kc)); },
  remove: (k) => { delete kc[k]; },
};

global.FileManager = {
  local: () => ({
    documentsDirectory: () => dir,
    joinPath: (a, b) => path.join(a, b),
    fileExists: (p) => fs.existsSync(p),
    readString: (p) => fs.readFileSync(p, "utf8"),
    writeString: (p, s) => fs.writeFileSync(p, s),
  }),
};

global.Request = class {
  constructor(url) { this.url = url; this.method = "GET"; this.headers = {}; this.body = null; }
  async loadString() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), (this.timeoutInterval || 15) * 1000);
    try {
      const r = await fetch(this.url, { method: this.method, headers: this.headers, body: this.body, signal: ctl.signal });
      this.response = { statusCode: r.status };
      return await r.text();
    } finally { clearTimeout(t); }
  }
};

global.Alert = class {
  constructor() { this.fields = []; }
  addTextField(p, v) { this.fields.push(v); }
  addSecureTextField(p, v) { this.fields.push(v); }
  addAction() {} addDestructiveAction() {} addCancelAction() {}
  async presentAlert() {
    out.alerts += 1;
    const a = sc.alert || { index: -1 };
    this.values = a.fields || this.fields;
    return a.index;
  }
  textFieldValue(i) { return this.values[i]; }
};

const actions = (sc.actions || []).slice();
global.WebView = class {
  async loadHTML(html) { out.html = html; }
  present() { return new Promise((res) => { this._close = res; }); }
  async evaluateJavaScript(code, useCallback) {
    if (code.startsWith("window.LM_render(")) {
      out.renders += 1;
      out.lastRender = JSON.parse(code.slice("window.LM_render(".length, -1));
      return null;
    }
    if (useCallback && code.includes("LM_wait")) {
      await new Promise((r) => setTimeout(r, 20));
      if (actions.length) return actions.shift();
      this._close(); // user closes the app
      return new Promise(() => {});
    }
    return null;
  }
};

// Widget stand-ins: record text so the test can check what the widget shows
const node = () => new Proxy({}, {
  get: (o, k) => {
    if (k === "addText") return (t) => { out.widgetTexts.push(t); return node(); };
    if (k === "addStack" || k === "addDate") return () => node();
    if (k in o) return o[k];
    return () => node();
  },
  set: (o, k, v) => { o[k] = v; return true; },
});
global.ListWidget = function () { return node(); };
global.LinearGradient = function () { return {}; };
global.Color = function (h) { return { h }; };
global.Color.white = () => ({ h: "#fff" });
global.Font = new Proxy({}, { get: () => () => ({}) });
global.config = { runsInWidget: !!sc.widget, widgetFamily: sc.family || "medium" };
global.Script = { setWidget: () => { out.widgetSet = true; }, complete: () => {} };

const code = fs.readFileSync(path.join(__dirname, "..", "scriptable", "Line Monitor.js"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction(code)()
  .then(() => {
    const store = JSON.parse(fs.readFileSync(path.join(dir, "line-monitor-data.json"), "utf8"));
    if (sc.htmlOut && out.html) {
      const data = out.lastRender ? `<script>window.addEventListener("load",()=>window.LM_render(${JSON.stringify(out.lastRender)}))</script>` : "";
      fs.writeFileSync(sc.htmlOut, out.html.replace("</body>", data + "</body>"));
    }
    console.log(JSON.stringify({ meta: store.meta, samples: store.samples.length, events: store.events.length,
      last: store.samples[store.samples.length - 1] || null, renders: out.renders, alerts: out.alerts,
      error: out.lastRender && out.lastRender.router.error, widget: out.widgetSet ? out.widgetTexts : undefined }));
    process.exit(0);
  })
  .catch((e) => { console.log("SCRIPT ERROR", e && e.stack); process.exit(1); });
