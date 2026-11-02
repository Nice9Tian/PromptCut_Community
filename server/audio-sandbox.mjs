/**
 * 自定义测量的沙箱(计划 `docs/plan/agent-workflow-plan.md` A6;语义 `user-workflow.md`「创造力等级」高档「可以写自定义测量代码」)。
 *
 * 模型写的 JS **绝不在 Node 里跑**。这里另起一个专用的无头 Chrome(chrome-headless-shell),每次测量:
 *   1. 开一个全新的浏览器上下文(无痕,互不相通,跑完即关)和一页,页面地址是一个不存在的域名
 *      `http://sandbox.promptcut.invalid/`,内容由 puppeteer 拦截请求就地给(不走网络);
 *   2. 页面(我们写的,可信)按块取回 PCM,开一个 Worker,把代码和 PCM 交进去;
 *   3. Worker 里先把联网的口子换成会抛错的函数,再用 AsyncFunction 编译代码、调用、`JSON.stringify` 结果、量大小;
 *   4. 页面到点 `worker.terminate()`(死循环也掐得断);Node 这边另有看门狗,页面本身没反应就整个杀掉 Chrome、下次重开。
 *
 * **不能联网**靠四道,任一道都单独挡得住:
 *   - 内容安全策略 `connect-src` 只放行本页的 PCM 地址(Worker 从 blob 地址起,继承页面的策略),其余 fetch / XHR / WebSocket /
 *     EventSource 一律被浏览器拒;`script-src` 不放行任何外部地址,`importScripts` 外部脚本同样被拒;
 *   - puppeteer 请求拦截:除了页面本身和一次性的 PCM 块,所有请求都 abort;
 *   - 启动参数 `--proxy-server` 指向一个没人听的本机端口、`--proxy-bypass-list=<-loopback>`(连本机也走这个代理),
 *     即使前两道都漏了也连不出去,也摸不到编辑器自己的 `/api`(只影响这个 Chrome,不动宿主机的网络设置);
 *   - Worker 里 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`importScripts`、`Worker` 等换成抛错的函数,报错文字写明「沙箱里不能联网」。
 *
 * **为什么另起一个 Chrome、不用预渲染的那个**〔裁〕:计划写的是「在预渲染 Chrome 的隔离页面里跑」。预渲染的 Chrome 为逐帧确定性
 * 调过一整套启动参数、有常驻的备用页,内存上限(`--js-flags=--max-old-space-size`)是整个浏览器进程的启动参数,给预渲染设低了会伤渲染,
 * 设高了又限不住模型写的内存炸弹;内存炸弹把渲染进程拖垮时,预渲染正在跑的页面会被一起带走。专用的 Chrome 只为这件事调参,
 * 崩了只丢这一次测量,下次按需重开;空闲 `idleCloseMs` 后自己关掉,不常驻占内存。
 *
 * 数字〔裁〕见 `SANDBOX_LIMITS`。
 */
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { tr } from "./i18n.mjs";

/**
 * 仅做 V8 语法解析（绝不执行），提取语法错误在函数体 `code` 内的精确行号与列号（1-based）。
 * @param {string} code
 * @returns {{ line: number, column: number, message: string } | null}
 */
export function syntaxLocationOf(code) {
  if (typeof code !== "string") return null;
  try {
    // 仅编译语法树，不调 runInContext / runInNewContext，一行业务代码都不会执行
    new vm.Script(`(async function(input) {\n${code}\n})`, { filename: "<measure>" });
    return null;
  } catch (err) {
    const stack = String(err?.stack || "");
    const lines = stack.split(/\r?\n/);
    const locMatch = /^<measure>:(\d+)/.exec(lines[0] || "");
    const rawLine = locMatch ? Number(locMatch[1]) : 2;
    const line = Math.max(1, rawLine - 1);
    let column = 1;
    for (let i = 1; i < Math.min(lines.length, 6); i++) {
      const caret = lines[i].indexOf("^");
      if (caret >= 0) {
        column = caret + 1;
        break;
      }
    }
    return { line, column, message: `${err?.name || "SyntaxError"}: ${err?.message || tr("Syntax error")}` };
  }
}

export const SANDBOX_LIMITS = Object.freeze({
  /** 代码的时限:缺省 / 最长 */
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  /** 代码长度上限(字符) */
  maxCodeChars: 20_000,
  /** 结果 JSON 的上限(UTF-8 字节) */
  maxResultBytes: 256 * 1024,
  /** Chrome 的 V8 老生代上限(MB,每个 isolate) */
  heapMb: 256,
  /** 页面到点没回话,Node 再多等这么久就杀掉整个 Chrome */
  graceMs: 5_000,
  /** 空闲多久关掉 Chrome */
  idleCloseMs: 60_000,
  /** 排队的测量最多几个(含正在跑的) */
  maxQueue: 4,
  /** 心跳:每隔多久问一次页面、每次等多久、连续几次没回话判卡死 */
  heartbeatEveryMs: 1_000,
  heartbeatTimeoutMs: 2_000,
  heartbeatMisses: 3,
  /** PCM 按块交给页面,每块字节数 */
  chunkBytes: 4 * 1024 * 1024,
});

export const SANDBOX_ORIGIN = "http://sandbox.promptcut.invalid";

/** 专用 Chrome 的启动参数 */
export function sandboxChromeArgs(limits = SANDBOX_LIMITS) {
  return [
    "--no-first-run", "--no-default-browser-check",
    "--window-position=-32000,-32000",
    "--disable-gpu", "--disable-extensions", "--disable-sync", "--disable-default-apps",
    "--disable-background-networking", "--disable-component-update", "--no-pings", "--metrics-recording-only",
    // 所有流量(连本机回环也算)都走一个没人听的代理:拦截与内容安全策略都漏了也连不出去
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
    `--js-flags=--max-old-space-size=${limits.heapMb}`,
  ];
}

/** 页面的内容安全策略:脚本只有页内的和 blob(Worker),连接只有 PCM 块 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src blob:",
  `connect-src ${SANDBOX_ORIGIN}/pcm/`,
].join("; ");

/**
 * Worker 的源码。只在 Chrome 里执行(以字符串交出去),Node 从不 eval 它。
 * 传进来的 input:{ channels: Float32Array[], sampleRate, duration, frames, numberOfChannels, ...meta }。
 */
const WORKER_SOURCE = String.raw`
"use strict";
(() => {
  const post = self.postMessage.bind(self);
  const blocked = (name) => function () { throw new Error("No network access in the sandbox: " + name + " is unavailable"); };
  const NET = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker", "BroadcastChannel", "RTCPeerConnection"];
  for (const name of NET) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        try { Object.defineProperty(o, name, { value: blocked(name), writable: false, configurable: false }); } catch (e) { /* what cannot be redefined is blocked by the content security policy */ }
      }
    }
  }
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    if (Object.prototype.hasOwnProperty.call(o, "postMessage")) {
      try { Object.defineProperty(o, "postMessage", { value: function () { throw new Error("Return the result with return, not with postMessage"); }, writable: false, configurable: false }); } catch (e) { /* same as above */ }
    }
  }
  const describe = (err) => {
    if (err && typeof err === "object") {
      const head = (err.name || "Error") + ": " + (err.message || "");
      const m = String(err.stack || "").match(/<anonymous>:(\d+):(\d+)/);
      return m ? head + " (line " + Math.max(1, Number(m[1]) - 2) + ", column " + m[2] + ")" : head;
    }
    return "Threw a value that is not an Error: " + String(err);
  };
  const AsyncFunction = (async () => {}).constructor;
  self.onmessage = async (e) => {
    self.onmessage = null;
    const { code, buf, frames, numberOfChannels, sampleRate, duration, meta, maxResultBytes } = e.data;
    const channels = [];
    for (let c = 0; c < numberOfChannels; c++) channels.push(new Float32Array(buf, c * frames * 4, frames));
    let fn;
    try { fn = new AsyncFunction("input", code); }
    catch (err) { post({ ok: false, kind: "syntax", error: "The code has a syntax error: " + describe(err) }); return; }
    let value;
    try {
      value = await fn(Object.freeze({ ...meta, channels: Object.freeze(channels), sampleRate, duration, frames, numberOfChannels }));
    } catch (err) { post({ ok: false, kind: "exception", error: "The code threw while running: " + describe(err) }); return; }
    let json;
    try { json = JSON.stringify(value); }
    catch (err) { post({ ok: false, kind: "unserializable", error: "The return value cannot be converted to JSON: " + describe(err) }); return; }
    if (json === undefined) { post({ ok: false, kind: "unserializable", error: "The return value is undefined (or a function / Symbol) and cannot be converted to JSON; return an object, an array, a number, a string or a boolean" }); return; }
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > maxResultBytes) { post({ ok: false, kind: "too-large", error: "The return value is " + bytes + " bytes as JSON, over the limit of " + maxResultBytes + "; return only a summary (statistics, a few points per second), not the raw samples" }); return; }
    post({ ok: true, json });
  };
})();
`;

/** 页面:可信的外壳,取 PCM、起 Worker、到点掐断 */
const HARNESS_HTML = `<!doctype html><meta charset="utf-8"><title>sandbox</title><script>\r\nconst WORKER_SOURCE = ${JSON.stringify(WORKER_SOURCE)};\r\nwindow.__runMeasure = async (o) => {\r\n  const parts = [];\r\n  for (let i = 0; i < o.chunks; i++) {\r\n    const r = await fetch(\"/pcm/\" + o.token + \"/\" + i);\r\n    if (!r.ok) return { ok: false, kind: \"internal\", error: \"Sandbox failed to fetch PCM (chunk \" + i + \")\" };\r\n    parts.push(new Uint8Array(await r.arrayBuffer()));\r\n  }\r\n  const total = parts.reduce((n, p) => n + p.length, 0);\r\n  const all = new Uint8Array(total);\r\n  let at = 0;\r\n  for (const p of parts) { all.set(p, at); at += p.length; }\r\n  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: \"text/javascript\" }));\r\n  const w = new Worker(url);\r\n  URL.revokeObjectURL(url);\r\n  const t0 = performance.now();\r\n  return await new Promise((resolve) => {\r\n    let done = false;\r\n    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); w.terminate(); resolve({ ...v, elapsedMs: Math.round(performance.now() - t0) }); };\r\n    const timer = setTimeout(() => finish({ ok: false, kind: \"timeout\", error: \"Code ran longer than \" + (o.timeoutMs / 1000) + \" s and was terminated (infinite loop, or too slow to compute; narrow the range to measure, lower the sample rate, or raise timeoutMs, up to \" + (o.maxTimeoutMs / 1000) + \" s)\" }), o.timeoutMs);\r\n    w.onmessage = (e) => finish(e.data && typeof e.data === \"object\" ? e.data : { ok: false, kind: \"internal\", error: \"Sandbox sent an unexpected message\" });\r\n    w.onerror = (e) => { e.preventDefault(); finish({ ok: false, kind: e.message ? \"exception\" : \"crashed\", error: e.message ? \"Code failed to run: \" + e.message : \"Code in the sandbox exited abnormally (no error text, most likely memory over the limit of \" + o.heapMb + \" MB)\" }); };\r\n    w.onmessageerror = () => finish({ ok: false, kind: \"unserializable\", error: \"Return value could not be passed out of the sandbox\" });\r\n    w.postMessage({ code: o.code, buf: all.buffer, frames: o.frames, numberOfChannels: o.numberOfChannels, sampleRate: o.sampleRate, duration: o.duration, meta: o.meta, maxResultBytes: o.maxResultBytes }, [all.buffer]);\r\n  });\r\n};\r\n</script>`;

/** 不挡进程退出的等待(兜底用的上限,不该让编辑器进程或测试多挂几秒) */
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** 规整时限:缺省 / 夹到 [1 秒, 最长] */
export function clampTimeout(ms, limits = SANDBOX_LIMITS) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return limits.defaultTimeoutMs;
  return Math.round(Math.min(limits.maxTimeoutMs, Math.max(1000, n)));
}

/** 默认的启动方式:puppeteer 的 chrome-headless-shell(预渲染用的同一份),没有就退到完整 Chrome 的新无头模式 */
async function defaultLaunch(limits) {
  const { default: puppeteer } = await import("puppeteer");
  const args = sandboxChromeArgs(limits);
  try {
    return await puppeteer.launch({ headless: "shell", protocolTimeout: 60_000, args });
  } catch (e) {
    if (!/could not find/i.test(String(e?.message || e))) throw e;
    return await puppeteer.launch({ headless: true, protocolTimeout: 60_000, args });
  }
}

class SandboxError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/**
 * 建一个沙箱。进程里通常只要一个(`getAudioSandbox()`)。
 * @param {{ launch?: (limits) => Promise<import('puppeteer').Browser>, limits?: Partial<typeof SANDBOX_LIMITS> }} [opts]
 */
export function createAudioSandbox({ launch = defaultLaunch, limits: override = {} } = {}) {
  const limits = Object.freeze({ ...SANDBOX_LIMITS, ...override });
  let browserP = null;
  let idleTimer = null;
  let queued = 0;
  let chain = Promise.resolve();

  function killBrowser(b) {
    try { b?.process?.()?.kill("SIGKILL"); } catch { /* 已经没了 */ }
    b?.close?.().catch(() => {});
  }
  async function ensureBrowser() {
    if (!browserP) {
      const p = launch(limits).then((b) => {
        b.on?.("disconnected", () => { if (browserP === p) browserP = null; });
        return b;
      });
      browserP = p;
      p.catch(() => { if (browserP === p) browserP = null; });
    }
    try {
      return await browserP;
    } catch (e) {
      throw new SandboxError("no-chrome", "The custom measurement sandbox could not start (Chrome not found or failed to launch): " + (e?.message || e));
    }
  }
  function resetBrowser() {
    const p = browserP;
    browserP = null;
    p?.then(killBrowser, () => {});
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (queued === 0) resetBrowser(); }, limits.idleCloseMs);
    idleTimer.unref?.();
  }

  async function runOnce({ code, channels, sampleRate, duration, meta, timeoutMs, signal }) {
    if (signal?.aborted) throw new SandboxError("cancelled", "Custom measurement cancelled");
    const browser = await ensureBrowser();
    const frames = channels[0]?.length ?? 0;
    const pcm = Buffer.alloc(frames * channels.length * 4);
    channels.forEach((ch, c) => Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength).copy(pcm, c * frames * 4));
    const chunks = Math.max(1, Math.ceil(pcm.length / limits.chunkBytes));
    const token = randomUUID();
    const served = new Set();
    const blocked = [];

    const ctx = await browser.createBrowserContext();
    let crashed;
    const crash = new Promise((r) => { crashed = r; });
    let watchdog = null;
    let heartbeat = null;
    let onAbort = null;
    try {
      const page = await ctx.newPage();
      page.on("error", (e) => crashed(e));
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const url = req.url();
        if (url === `${SANDBOX_ORIGIN}/`) {
          req.respond({ status: 200, contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": SANDBOX_CSP }, body: HARNESS_HTML }).catch(() => {});
          return;
        }
        const m = url.startsWith(`${SANDBOX_ORIGIN}/pcm/${token}/`) ? Number(url.slice(`${SANDBOX_ORIGIN}/pcm/${token}/`.length)) : NaN;
        if (Number.isInteger(m) && m >= 0 && m < chunks && !served.has(m)) {
          served.add(m); // 每块只给一次
          req.respond({ status: 200, contentType: "application/octet-stream", body: pcm.subarray(m * limits.chunkBytes, (m + 1) * limits.chunkBytes) }).catch(() => {});
          return;
        }
        blocked.push(url);
        req.abort("blockedbyclient").catch(() => {});
      });
      await page.goto(`${SANDBOX_ORIGIN}/`, { waitUntil: "load", timeout: 15_000 });
      const races = [
        page.evaluate((o) => window.__runMeasure(o), {
          token, chunks, code, frames, numberOfChannels: channels.length, sampleRate, duration, meta: meta ?? {},
          timeoutMs, maxTimeoutMs: limits.maxTimeoutMs, maxResultBytes: limits.maxResultBytes, heapMb: limits.heapMb,
        }),
        crash.then(() => ({ ok: false, kind: "crashed", error: `Sandbox page crashed (most likely memory over the limit of ${limits.heapMb} MB); narrow the range to measure and do not build huge arrays at once` })),
        /*
         * 心跳:Worker 里的死循环不挡页面主线程,页面照样应答;内存炸弹不一样 —— 实测 Worker 堆到上限后整个渲染进程卡死
         * (页面主线程不再跑定时器,也不报 crash 事件),只能等看门狗。所以每秒问页面一次,连续 heartbeatMisses 次没回话
         * 就判「内存超限卡死」,不必等满时限。
         */
        new Promise((_, reject) => {
          let misses = 0;
          heartbeat = setInterval(() => {
            let t;
            Promise.race([page.evaluate(() => 1), new Promise((r) => { t = setTimeout(() => r("miss"), limits.heartbeatTimeoutMs); })])
              .catch(() => "miss")
              .then((v) => {
                clearTimeout(t);
                misses = v === 1 ? 0 : misses + 1;
                if (misses >= limits.heartbeatMisses) reject(new SandboxError("crashed", `Sandbox hung (most likely memory over the limit of ${limits.heapMb} MB) and was restarted; narrow the range to measure and do not build huge arrays at once`));
              });
          }, limits.heartbeatEveryMs);
          heartbeat.unref?.();
        }),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new SandboxError("hung", `Sandbox did not respond within ${(timeoutMs + limits.graceMs) / 1000} s and was restarted`)), timeoutMs + limits.graceMs + chunks * 1000);
          watchdog.unref?.();
        }),
      ];
      if (signal) {
        races.push(new Promise((_, reject) => {
          onAbort = () => reject(new SandboxError("cancelled", "Custom measurement cancelled"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }));
      }
      const verdict = await Promise.race(races);
      return { verdict, blocked };
    } catch (e) {
      // 页面 / 浏览器已经不对劲(崩溃、没回话、协议断了、被取消):整个 Chrome 重开,只丢这一次
      resetBrowser();
      if (e instanceof SandboxError) throw e;
      const msg = String(e?.message || e);
      if (/Target closed|crash|Session closed|detached|Protocol error/i.test(msg)) {
        throw new SandboxError("crashed", `Sandbox crashed (most likely memory over the limit of ${limits.heapMb} MB): ${msg.slice(0, 200)}`);
      }
      throw new SandboxError("internal", "Sandbox internal error: " + msg.slice(0, 300));
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      let t;
      await Promise.race([ctx.close().catch(() => {}), new Promise((r) => { t = setTimeout(r, 5_000); t.unref?.(); })]);
      clearTimeout(t);
    }
  }

  /**
   * 跑一段测量代码。回 `{ ok: true, value, elapsedMs }` 或 `{ ok: false, kind, error, line?, column? }`,不抛错。
   * kind:syntax | exception | timeout | unserializable | too-large | crashed | hung | no-chrome | busy | invalid | cancelled | internal
   */
  async function run({ code, channels, sampleRate, duration, meta, timeoutMs, signal }) {
    if (signal?.aborted) return { ok: false, kind: "cancelled", error: "Custom measurement cancelled" };
    if (typeof code !== "string" || !code.trim()) return { ok: false, kind: "invalid", error: "code is empty: write a function body and return the result with return" };
    if (code.length > limits.maxCodeChars) return { ok: false, kind: "invalid", error: `code has ${code.length} characters, over the limit of ${limits.maxCodeChars}` };
    if (!Array.isArray(channels) || !channels.length || !channels.every((c) => c instanceof Float32Array)) {
      return { ok: false, kind: "invalid", error: "Sandbox did not receive PCM" };
    }
    if (queued >= limits.maxQueue) return { ok: false, kind: "busy", error: `${queued} custom measurements already queued, try again later` };
    const limit = clampTimeout(timeoutMs, limits);
    queued++;
    clearTimeout(idleTimer);
    const job = chain.then(async () => {
      try {
        if (signal?.aborted) return { ok: false, kind: "cancelled", error: "Custom measurement cancelled" };
        const { verdict, blocked } = await runOnce({ code, channels, sampleRate, duration, meta, timeoutMs: limit, signal });
        const netNote = blocked.length ? { blockedRequests: blocked.slice(0, 5) } : null;
        if (!verdict || typeof verdict !== "object") return { ok: false, kind: "internal", error: "Sandbox returned an unexpected result" };
        if (!verdict.ok) {
          const kind = verdict.kind || "exception";
          let error = String(verdict.error || "Error in the sandbox");
          let loc = null;
          if (kind === "syntax") {
            loc = syntaxLocationOf(code);
            if (loc && !/line \d+/.test(error)) {
              error = `${error} (line ${loc.line}, column ${loc.column})`;
            }
          }
          return {
            ok: false,
            kind,
            error,
            ...(loc ? { line: loc.line, column: loc.column } : null),
            ...netNote,
          };
        }
        const json = String(verdict.json);
        if (Buffer.byteLength(json, "utf8") > limits.maxResultBytes) {
          return { ok: false, kind: "too-large", error: `Return value exceeds the limit of ${limits.maxResultBytes} bytes` };
        }
        return { ok: true, value: JSON.parse(json), elapsedMs: verdict.elapsedMs, ...netNote };
      } catch (e) {
        return { ok: false, kind: e?.kind || "internal", error: String(e?.message || e) };
      }
    });
    chain = job.catch(() => {});
    try {
      return await job;
    } finally {
      queued--;
      armIdle();
    }
  }

  return {
    run,
    limits,
    /** 关掉 Chrome(测试与进程退出用) */
    async close() {
      clearTimeout(idleTimer);
      const p = browserP;
      browserP = null;
      const b = await p?.catch(() => null);
      if (b) {
        const proc = b.process?.();
        const exited = proc && proc.exitCode === null && proc.signalCode === null
          ? new Promise((r) => { proc.once("exit", r); proc.once("close", r); })
          : Promise.resolve();
        await Promise.race([b.close().catch(() => {}), sleep(5_000)]).then(() => killBrowser(b));
        await Promise.race([exited, sleep(3_000)]);
      }
      await Promise.race([chain, sleep(3_000)]);
    },
    /** 现在有没有开着的 Chrome(测试用) */
    get alive() { return !!browserP; },
  };
}

let shared = null;
/** 进程里共用的那一个沙箱(编辑器进程用) */
export function getAudioSandbox() {
  if (!shared) {
    shared = createAudioSandbox();
    process.once("exit", () => { shared?.close(); });
  }
  return shared;
}
