/**
 * Sandbox for custom measurement (plan `docs/plan/agent-workflow-plan.md` A6; semantics
 * `user-workflow.md` "creativity level" high tier "can write custom measurement code").
 *
 * Model-written JS is **never run in Node**. A dedicated headless Chrome (chrome-headless-shell)
 * is launched here. For each measurement:
 *   1. Opens a brand-new browser context (incognito, isolated from each other, closed immediately
 *      after run) and a page; page URL is a non-existent domain `http://sandbox.promptcut.invalid/`,
 *      with content served in-place by puppeteer request interception (no network);
 *   2. The page (written by us, trusted) retrieves PCM in chunks, spawns a Worker, and passes the
 *      code and PCM in;
 *   3. Inside the Worker, network entry points are first replaced with error-throwing functions;
 *      code is then compiled with AsyncFunction, invoked, results serialized with `JSON.stringify`,
 *      and size measured;
 *   4. On timeout the page calls `worker.terminate()` (can interrupt even infinite loops); on the
 *      Node side there is a separate watchdog: if the page itself becomes unresponsive, the entire
 *      Chrome instance is killed and reopened on the next call.
 *
 * **No network access** is enforced by four lines of defense, any single one of which is sufficient:
 *   - Content Security Policy `connect-src` only allows the page's own PCM URL (Worker starts from
 *     a blob URL and inherits page policy); all other fetch / XHR / WebSocket / EventSource are
 *     blocked by the browser; `script-src` allows no external URLs, so `importScripts` for external
 *     scripts is likewise rejected;
 *   - puppeteer request interception: all requests are aborted except for the page itself and
 *     one-off PCM chunks;
 *   - Launch arguments: `--proxy-server` points to an unlistened local port,
 *     `--proxy-bypass-list=<-loopback>` (even localhost routes through this proxy); even if the
 *     first two lines fail, outgoing connections cannot escape and cannot touch the editor's own
 *     `/api` (affects only this Chrome, without modifying host machine network settings);
 *   - Inside the Worker, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
 *     `Worker`, etc. are replaced with error-throwing functions, with error message stating "Network
 *     access is not allowed in sandbox".
 *
 * **Why launch a separate Chrome instead of reusing the prerender one** [ruling]: The plan
 * originally stated "run in an isolated page of the prerender Chrome". Prerender Chrome has its
 * launch arguments tuned for frame-by-frame determinism and keeps resident standby pages; the memory
 * limit (`--js-flags=--max-old-space-size`) is a launch flag for the entire browser process. Setting
 * it too low degrades rendering, while setting it too high fails to contain model-written memory
 * bombs; if a memory bomb crashes the render process, active prerender pages are dragged down with
 * it. A dedicated Chrome is tuned exclusively for this purpose: crashing loses only the current
 * measurement and restarts on demand next time; after idling for `idleCloseMs`, it shuts down
 * automatically without consuming resident memory.
 *
 * Numeric [ruling] see `SANDBOX_LIMITS`.
 */
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { tr } from "./i18n.mjs";

/**
 * Performs V8 syntax parsing only (never executed), extracting exact line and column numbers
 * (1-based) of syntax errors within function body `code`.
 * @param {string} code
 * @returns {{ line: number, column: number, message: string } | null}
 */
export function syntaxLocationOf(code) {
  if (typeof code !== "string") return null;
  try {
    // Only compiles the AST without calling runInContext / runInNewContext; not a single line of business code is executed
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
  /** Code execution timeout: default / maximum */
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  /** Maximum code length (characters) */
  maxCodeChars: 20_000,
  /** Maximum result JSON size (UTF-8 bytes) */
  maxResultBytes: 256 * 1024,
  /** Chrome V8 old generation limit (MB, per isolate) */
  heapMb: 256,
  /** Extra time Node waits before killing the entire Chrome instance if the page fails to respond on timeout */
  graceMs: 5_000,
  /** Idle time before shutting down Chrome */
  idleCloseMs: 60_000,
  /** Maximum queued measurements (including the currently running one) */
  maxQueue: 4,
  /** Heartbeat: interval to query page, timeout per check, consecutive misses before classifying as hung */
  heartbeatEveryMs: 1_000,
  heartbeatTimeoutMs: 2_000,
  heartbeatMisses: 3,
  /** PCM delivered to page in chunks, byte count per chunk */
  chunkBytes: 4 * 1024 * 1024,
});

export const SANDBOX_ORIGIN = "http://sandbox.promptcut.invalid";

/** Launch arguments for dedicated Chrome */
export function sandboxChromeArgs(limits = SANDBOX_LIMITS) {
  return [
    "--no-first-run", "--no-default-browser-check",
    "--window-position=-32000,-32000",
    "--disable-gpu", "--disable-extensions", "--disable-sync", "--disable-default-apps",
    "--disable-background-networking", "--disable-component-update", "--no-pings", "--metrics-recording-only",
    // All traffic (including localhost loopback) routes through an unlistened proxy: prevents outbound
    // connections even if both interception and Content Security Policy fail
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
    `--js-flags=--max-old-space-size=${limits.heapMb}`,
  ];
}

/** Page Content Security Policy: scripts restricted to inline and blob (Worker), connections restricted to PCM chunks */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src blob:",
  `connect-src ${SANDBOX_ORIGIN}/pcm/`,
].join("; ");

/**
 * Worker source code. Executed only in Chrome (passed as string); Node never evals it.
 * Passed-in input: { channels: Float32Array[], sampleRate, duration, frames, numberOfChannels, ...meta }.
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

/** Page: trusted shell, fetches PCM, starts Worker, and terminates on timeout */
const HARNESS_HTML = `<!doctype html><meta charset="utf-8"><title>sandbox</title><script>
const WORKER_SOURCE = ${JSON.stringify(WORKER_SOURCE)};
window.__runMeasure = async (o) => {
  const parts = [];
  for (let i = 0; i < o.chunks; i++) {
    const r = await fetch("/pcm/" + o.token + "/" + i);
    if (!r.ok) return { ok: false, kind: "internal", error: "Sandbox failed to fetch PCM (chunk " + i + ")" };
    parts.push(new Uint8Array(await r.arrayBuffer()));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  const t0 = performance.now();
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); w.terminate(); resolve({ ...v, elapsedMs: Math.round(performance.now() - t0) }); };
    const timer = setTimeout(() => finish({ ok: false, kind: "timeout", error: "Code ran longer than " + (o.timeoutMs / 1000) + " s and was terminated (infinite loop, or too slow to compute; narrow the range to measure, lower the sample rate, or raise timeoutMs, up to " + (o.maxTimeoutMs / 1000) + " s)" }), o.timeoutMs);
    w.onmessage = (e) => finish(e.data && typeof e.data === "object" ? e.data : { ok: false, kind: "internal", error: "Sandbox sent an unexpected message" });
    w.onerror = (e) => { e.preventDefault(); finish({ ok: false, kind: e.message ? "exception" : "crashed", error: e.message ? "Code failed to run: " + e.message : "Code in the sandbox exited abnormally (no error text, most likely memory over the limit of " + o.heapMb + " MB)" }); };
    w.onmessageerror = () => finish({ ok: false, kind: "unserializable", error: "Return value could not be passed out of the sandbox" });
    w.postMessage({ code: o.code, buf: all.buffer, frames: o.frames, numberOfChannels: o.numberOfChannels, sampleRate: o.sampleRate, duration: o.duration, meta: o.meta, maxResultBytes: o.maxResultBytes }, [all.buffer]);
  });
};
</script>`;

/** Non-blocking wait for process exit (fallback upper limit, avoids hanging editor process or tests for extra seconds) */
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Normalize timeout: default / clamped to [1 second, maximum] */
export function clampTimeout(ms, limits = SANDBOX_LIMITS) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return limits.defaultTimeoutMs;
  return Math.round(Math.min(limits.maxTimeoutMs, Math.max(1000, n)));
}

/**
 * Default launch method: puppeteer chrome-headless-shell (same copy used by prerender);
 * falls back to full Chrome new headless mode if missing
 */
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
 * Creates a sandbox. Typically only one is needed per process (`getAudioSandbox()`).
 * @param {{ launch?: (limits) => Promise<import('puppeteer').Browser>, limits?: Partial<typeof SANDBOX_LIMITS> }} [opts]
 */
export function createAudioSandbox({ launch = defaultLaunch, limits: override = {} } = {}) {
  const limits = Object.freeze({ ...SANDBOX_LIMITS, ...override });
  let browserP = null;
  let idleTimer = null;
  let queued = 0;
  let chain = Promise.resolve();

  function killBrowser(b) {
    try { b?.process?.()?.kill("SIGKILL"); } catch { /* Already gone */ }
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
          served.add(m); // Deliver each chunk only once
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
         * Heartbeat: infinite loops in the Worker do not block the page main thread, so the page still
         * responds; memory bombs are different: empirical testing shows that once Worker heap reaches its
         * limit, the entire render process hangs (page main thread stops running timers and fires no crash
         * event), leaving only the watchdog. Therefore, the page is polled every second; if it fails to
         * respond for heartbeatMisses consecutive times, it is classified as "out-of-memory hang" without
         * having to wait out the full timeout.
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
      // Page/browser is in a bad state (crashed, no response, protocol disconnected, cancelled):
      // restart the entire Chrome instance, dropping only this one
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
   * Run a snippet of measurement code. Return `{ ok: true, value, elapsedMs }` or
   * `{ ok: false, kind, error, line?, column? }`, without throwing.
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
    /** Shut down Chrome (for testing and process exit) */
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
    /** Whether Chrome is currently open (for testing) */
    get alive() { return !!browserP; },
  };
}

let shared = null;
/** The shared sandbox in the process (for the editor process) */
export function getAudioSandbox() {
  if (!shared) {
    shared = createAudioSandbox();
    process.once("exit", () => { shared?.close(); });
  }
  return shared;
}
