/**
 * 汇总一份 Chrome trace 里页面主线程上的长任务:每个长任务里有哪些时间线事件、V8 采样落在哪些函数上。
 * 配合 `tiers-probe.mjs --trace <文件>` 用(也能读 DevTools Performance 面板导出的 trace)。
 *
 *   node scripts/probes/longtask-stacks.mjs <trace.json> [--min-ms 50] [--url-part "?editor"] [--top 15]
 *
 * - 页面进程:按 `TracingStartedInBrowser` 里 url 含 `--url-part` 的帧找 processId;找不到就取长任务最多的渲染进程。
 * - 长任务:该进程 `CrRendererMain` 线程上 `RunTask` 且时长 ≥ `--min-ms`。
 * - 每个长任务输出:起点(相对 trace 开头,ms)、时长、线程 CPU 时间(cpuMs,远小于时长说明主线程被抢了 CPU);任务里的时间线事件按名字累计(FunctionCall、TimerFire、
 *   Layout、UpdateLayoutTree、MinorGC 等);V8 采样的自身时间最多的函数;包含时间最多的调用栈(自顶向下,截到 12 层)。
 * 输出一行 JSON。
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d/.test(a));
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const MIN_MS = Number(arg('--min-ms', 50));
const URL_PART = arg('--url-part', '?editor');
const TOP = Number(arg('--top', 15));
if (!file) { console.error('用法:node scripts/probes/longtask-stacks.mjs <trace.json>'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;
const t0 = events.reduce((m, e) => (e.ts > 0 && e.ts < m ? e.ts : m), Infinity);

// ---- 找页面进程与主线程 ----
const mainTid = new Map(); // pid -> tid
for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') mainTid.set(e.pid, e.tid);
let pagePid = null;
for (const e of events) {
  if (e.name !== 'TracingStartedInBrowser') continue;
  for (const f of e.args?.data?.frames ?? []) if (String(f.url ?? '').includes(URL_PART) && f.processId) pagePid = f.processId;
}
const isRun = (e) => e.ph === 'X' && (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && mainTid.get(e.pid) === e.tid;
if (pagePid === null) {
  const count = new Map();
  for (const e of events) if (isRun(e) && e.dur >= MIN_MS * 1000) count.set(e.pid, (count.get(e.pid) ?? 0) + 1);
  pagePid = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
const tid = mainTid.get(pagePid);
const onMain = events.filter((e) => e.pid === pagePid && e.tid === tid);
const longs = onMain.filter((e) => isRun(e) && e.dur >= MIN_MS * 1000).sort((a, b) => a.ts - b.ts);

// ---- V8 采样(Profile / ProfileChunk,按 id 拼) ----
const profiles = new Map(); // id -> { nodes: Map, samples: [{ts, node}] }
for (const e of events) {
  if (e.pid !== pagePid) continue;
  if (e.name === 'Profile') profiles.set(e.id, { start: e.args.data.startTime, last: e.args.data.startTime, nodes: new Map(), samples: [] });
  if (e.name === 'ProfileChunk') {
    const p = profiles.get(e.id);
    if (!p) continue;
    const cp = e.args.data.cpuProfile ?? {};
    for (const n of cp.nodes ?? []) p.nodes.set(n.id, n);
    const deltas = e.args.data.timeDeltas ?? [];
    (cp.samples ?? []).forEach((s, i) => { p.last += deltas[i] ?? 0; p.samples.push({ ts: p.last, node: s }); });
  }
}
const frameName = (n) => {
  const c = n?.callFrame ?? {};
  const url = String(c.url ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  return `${c.functionName || '(anon)'}${url ? ` ${url}:${(c.lineNumber ?? 0) + 1}` : ''}`;
};
const stackOf = (p, id) => {
  const out = [];
  for (let n = p.nodes.get(id); n; n = n.parent ? p.nodes.get(n.parent) : null) out.push(frameName(n));
  return out.reverse().filter((f) => !/^\((root|program)\)/.test(f));
};

const report = longs.map((L) => {
  const a = L.ts, b = L.ts + L.dur;
  const inside = onMain.filter((e) => e.ph === 'X' && e !== L && e.ts >= a && e.ts + (e.dur ?? 0) <= b);
  const byName = {};
  for (const e of inside) byName[e.name] = (byName[e.name] ?? 0) + (e.dur ?? 0) / 1000;
  const events = Object.entries(byName).sort((x, y) => y[1] - x[1]).slice(0, TOP).map(([k, v]) => `${k} ${v.toFixed(1)}`);
  const first = inside.filter((e) => ['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'v8.callFunction', 'RunMicrotasks', 'EvaluateScript', 'XHRReadyStateChange', 'ParseHTML'].includes(e.name))
    .slice(0, 6).map((e) => ({ name: e.name, ms: +((e.dur ?? 0) / 1000).toFixed(1), data: e.args?.data ? { fn: e.args.data.functionName, url: String(e.args.data.url ?? '').replace(/^https?:\/\/[^/]+/, ''), line: e.args.data.lineNumber, type: e.args.data.type, timerId: e.args.data.timerId } : undefined }));
  const self = new Map(), incl = new Map(), app = new Map(), appInner = new Map();
  let n = 0;
  for (const p of profiles.values()) {
    for (let i = 0; i < p.samples.length; i++) {
      const s = p.samples[i];
      if (s.ts < a || s.ts > b) continue;
      const w = ((p.samples[i + 1]?.ts ?? s.ts) - s.ts) / 1000;
      n++;
      const st = stackOf(p, s.node);
      const top = st.at(-1) ?? '(idle/native)';
      self.set(top, (self.get(top) ?? 0) + w);
      const key = st.slice(0, 12).join(' > ');
      incl.set(key, (incl.get(key) ?? 0) + w);
      // 本仓库的帧(/src/ 下):最外层那个(React 里就是被渲染的组件或 effect)与最内层那个,各自计包含时间
      const mine = st.filter((f) => f.includes(' /src/'));
      if (mine.length) {
        app.set(mine[0], (app.get(mine[0]) ?? 0) + w);
        const inner = mine.at(-1);
        appInner.set(inner, (appInner.get(inner) ?? 0) + w);
      }
    }
  }
  const sorted = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, TOP).map(([k, v]) => `${v.toFixed(1)} ms  ${k}`);
  return { atMs: +((a - t0) / 1000).toFixed(1), ms: +(L.dur / 1000).toFixed(1), cpuMs: L.tdur === undefined ? null : +(L.tdur / 1000).toFixed(1), samples: n, events, entry: first, selfTop: sorted(self), appOuter: sorted(app), appInner: sorted(appInner), stacksTop: sorted(incl).slice(0, 8) };
});
console.log(JSON.stringify({ file, pagePid, mainTid: tid, minMs: MIN_MS, longtasks: report }, null, 1));
