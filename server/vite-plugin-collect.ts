/**
 * Media collection: captures videos from web links (Bilibili, etc.) into local files and places
 * them into the asset catalog for the editor to import.
 *
 * The actual work is done by python/promptcut_collect (a yt-dlp wrapper); this side only does four
 * things:
 *   - Check if extension is installed (/status), install extension (/install,
 *     SSE streams pip logs);
 *   - Synchronously probe a link (/probe, a few seconds, gets title, duration, resolution);
 *   - Start download jobs (/download immediately returns jobId, /job/<id> polls progress, DELETE
 *     cancels);
 *   - Files first download into this job's own temp directory; after process exits, they are fed
 *     into the content store one by one via the asset service storage API
 *     (`server/media-ingest.mjs`, the same path as user media imports; see
 *     `docs/semantics/product/asset-service.md` "The storage step cannot be omitted"). The job
 *     result returns the stored /@media/<hash> and storage response, and the frontend registers
 *     it as media accordingly; the temp directory is deleted afterward.
 *     Originally, files were downloaded directly into the asset catalog, and the frontend asked
 *     the server to compute hashes on the spot, bypassing storage.
 *
 * Login state (/login, /login/check, /cookies) uses the agent browser in server/web/:
 * it moves the login page in front of the user to scan the QR code, extracts cookies from CDP after
 * scanning to save as cookies.txt, and subsequent probes and downloads automatically include them.
 * Decision and read/write logic live in collect-cookies.mjs (pure logic, unit-testable).
 *
 * Jobs exist only in memory: gone once service restarts; when frontend polls 404, it explains
 * "Service may have restarted".
 */
import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { buildEnv, dataDir, findPython, pipeToSse, readBody, spawnPython, pythonMissing } from "./vite-plugin-stt";
import { assetServiceOrigin } from "./asset-client";
import { ingestFile } from "./media-ingest.mjs";
import { findBundledChrome } from "./vite-plugin-web";
import {
  SITES, siteNames, assessLogin, saveCookies, savedCookieStatus, forgetCookies, pickCookies,
} from "./collect-cookies.mjs";
import { qrLogin } from "./collect-qr-login.mjs";
import { isInside } from "./http-guard.mjs";
import { tr } from "./i18n.mjs";

/**
 * ingest: all files downloaded, currently being sent into the content store via the asset
 * service storage API
 */
export type CollectStage = "starting" | "video" | "audio" | "merge" | "transcode" | "ingest" | "done";

/**
 * Response from asset service storage API (ingestFile in `server/media-ingest.mjs`), used by the
 * frontend to register media
 */
export interface IngestedMedia {
  hash: string;
  ext: string;
  name: string;
  url: string;
  bytes: number;
  deduped: boolean;
  path?: string;
  tiers?: { original: string; small: string | null };
  small?: string;
}

export interface CollectItem {
  id?: string;
  title?: string;
  filename: string;
  /** Stored address /@media/<hash>, used by frontend to fetch files and register as media */
  url: string;
  /** Content hash */
  hash?: string;
  /** Storage response */
  media?: IngestedMedia;
  bytes?: number;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  transcoded?: boolean;
  audio_only?: boolean;
  uploader?: string;
  webpage_url?: string;
}

export interface CollectJob {
  id: string;
  url: string;
  site?: string;
  quality: number;
  status: "running" | "done" | "error";
  stage: CollectStage;
  /** Overall progress 0~100 */
  percent: number;
  /** Progress of current stage itself */
  stagePercent?: number;
  speed?: number | null;
  eta?: number | null;
  downloaded?: number;
  total?: number | null;
  /** Probed title / duration, available before download starts */
  info?: Record<string, unknown>;
  items: CollectItem[];
  /** Human-readable error message; cancellation also goes here */
  message?: string;
  /** Retry records such as 412, for UI and agent inspection */
  notes: string[];
  /** Whether login state was included this time */
  cookiesUsed: boolean;
  stderrTail: string[];
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, CollectJob>();
const procs = new Map<string, ChildProcess>();

const QUALITIES = new Set([2160, 1440, 1080, 720, 480, 360]);
const SITE_PRESETS = new Set(["auto", "bilibili", "generic"]);

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  } catch { /* Already exited */ }
}

/**
 * Runs a subcommand to completion, passes stdout JSONL line by line to onLine, returns exit code
 * and stderr tail
 */
function runLines(
  child: ChildProcess,
  onLine: (obj: Record<string, unknown>) => void,
  stderrTail: string[],
): Promise<number> {
  return new Promise((resolve) => {
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch { stderrTail.push(line); }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString("utf-8").split(/\r?\n/)) {
        if (line.trim()) stderrTail.push(line.trim());
      }
      if (stderrTail.length > 30) stderrTail.splice(0, stderrTail.length - 30);
    });
    child.on("error", (e) => { stderrTail.push(String(e)); resolve(-1); });
    child.on("close", (code) => {
      if (buf.trim()) { try { onLine(JSON.parse(buf.trim())); } catch { /* Partial line, discard */ } }
      resolve(code ?? -1);
    });
  });
}

function bootstrap(root: string): Promise<{ python: string; env: NodeJS.ProcessEnv } | null> {
  const python = findPython(root);
  if (!python) return Promise.resolve(null);
  return buildEnv(root, python).then((env) => ({ python, env }));
}

/** Extracts the most useful line from the Python error */
function pickError(obj: Record<string, unknown> | undefined, stderrTail: string[], code: number): string {
  const msg = typeof obj?.message === "string" ? obj.message : "";
  if (msg) return msg;
  const useful = [...stderrTail].reverse().find((l) => /error|失败|找不到|failed|cannot find|not found/i.test(l)); // i18n-allow
  return useful || tr("Download process exit code {0}", code);
}

/**
 * Cookies file explicitly passed by caller: only accept those under <dataDir>/cookies/.
 * yt-dlp sends the contents of this file as cookies to remote sites: letting the model specify
 * an arbitrary disk path equals providing a path to "send arbitrary local files to external
 * sites" (caught in review). Anything out of scope is treated as not passed.
 */
function explicitCookies(root: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const dir = path.resolve(dataDir(root), "cookies");
  const target = path.resolve(raw);
  // Use isInside instead of custom startsWith: Windows paths are case-insensitive, and manual
  // comparison would treat `C:\Users\...` and `c:\users\...` as two different locations. Although
  // misjudging in this direction is safe (ignoring valid files as out-of-bounds), the symptom is
  // "login state is clearly saved, yet download carries no cookie", without any error.
  return isInside(target, dir) ? target : undefined;
}

/**
 * Current status of persisted login state across sites, returned by both status and cookies
 * endpoints
 */
function cookieOverview(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of siteNames()) {
    const st = savedCookieStatus(dataDir(root), id);
    out[id] = {
      name: tr(SITES[id as keyof typeof SITES].name),
      loggedIn: st.loggedIn, expired: st.expired, userId: st.userId,
      expiresAt: st.expiresAt ? new Date(st.expiresAt).toISOString() : null,
      path: st.exists ? st.path : null,
    };
  }
  return out;
}

async function runDownload(root: string, job: CollectJob, body: Record<string, unknown>): Promise<void> {
  const boot = await bootstrap(root);
  if (!boot) { job.status = "error"; job.message = pythonMissing(); job.finishedAt = Date.now(); return; }
  // Temp directory for this job itself: yt-dlp lands here, deleted along with the directory after
  // storing (see file header)
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-collect-"));
  try {
    await downloadInto(boot, outDir, job, body, root);
  } finally {
    fs.rm(outDir, { recursive: true, force: true }, () => {});
  }
}

async function downloadInto(
  boot: { python: string; env: NodeJS.ProcessEnv },
  outDir: string,
  job: CollectJob,
  body: Record<string, unknown>,
  root: string,
): Promise<void> {
  const args = [
    "-m", "promptcut_collect", "download",
    "--url", job.url,
    "--out-dir", outDir,
    "--quality", String(job.quality),
  ];
  if (job.site && job.site !== "auto") args.push("--site", job.site);
  if (body.audioOnly === true) args.push("--audio-only");
  if (body.allParts === true) args.push("--all-parts");
  if (body.keepCodec === true) args.push("--keep-codec");
  const ck = pickCookies(dataDir(root), job.url, explicitCookies(root, body.cookies));
  if (ck.path) { args.push("--cookies", ck.path); job.cookiesUsed = true; }
  if (ck.reason) job.notes.push(ck.reason);
  if (typeof body.cookiesFromBrowser === "string" && /^[a-z]+$/.test(body.cookiesFromBrowser)) {
    args.push("--cookies-from-browser", body.cookiesFromBrowser);
  }

  const child = spawnPython(boot.python, args, boot.env);
  procs.set(job.id, child);
  let lastError: Record<string, unknown> | undefined;
  let sawDone = false;
  /** Files reported by Python, stored one by one after process exits */
  const staged: Record<string, unknown>[] = [];

  const code = await runLines(child, (ev) => {
    const type = ev.event;
    if (type === "info") {
      // Keep only items meant for human display: hundreds of words in description and thumbnail links
      // are useless to polling callers and waste context
      const { id, title, duration, uploader, webpage_url } = ev as Record<string, unknown>;
      job.info = { id, title, duration, uploader, webpage_url };
    } else if (type === "retry") {
      job.notes.push(`Temporary error on attempt ${ev.attempt}, retrying in ${ev.wait}s: ${String(ev.message ?? "").slice(0, 160)}`);
    } else if (type === "progress") {
      const stage = String(ev.stage ?? "video") as CollectStage;
      const p = typeof ev.percent === "number" ? ev.percent : undefined;
      job.stage = stage;
      job.stagePercent = p;
      job.speed = typeof ev.speed === "number" ? ev.speed : null;
      job.eta = typeof ev.eta === "number" ? ev.eta : null;
      if (typeof ev.downloaded === "number") job.downloaded = ev.downloaded;
      if (typeof ev.total === "number") job.total = ev.total;
      if (stage === "transcode") job.percent = Math.round(97 + (p ?? 0) * 0.03);
      else if (stage === "merge") job.percent = p && p >= 100 ? 99 : 97;
      else if (typeof ev.overall === "number") job.percent = Math.round(ev.overall);
      else if (p != null) job.percent = Math.round(p * 0.9);
      if (typeof ev.note === "string") job.notes.push(ev.note);
    } else if (type === "item") {
      staged.push(ev);
    } else if (type === "done") {
      // Record first, and update together with finishedAt after process exits: when pollers see done,
      // finishedAt must already be present and the process must have exited
      sawDone = true;
    } else if (type === "error") {
      lastError = ev;
    }
  }, job.stderrTail);

  procs.delete(job.id);
  if (job.status === "running" && sawDone) {
    // Storage: only recognize files at this level of temp directory (take the last segment of the
    // filename reported by Python); never pass paths from elsewhere
    job.stage = "ingest";
    for (const ev of staged) {
      if (job.status !== "running") break; // Cancelled during storage
      const filename = path.basename(String(ev.filename ?? "") || String(ev.path ?? ""));
      const file = path.join(outDir, filename);
      if (!filename || !fs.existsSync(file)) {
        job.status = "error";
        job.message = tr("The download process reported the file \"{0}\", but it is not in the temp directory", filename || tr("(no file name)"));
        break;
      }
      try {
        const media = await ingestFile({ file, name: filename, origin: assetServiceOrigin }) as IngestedMedia;
        const { path: _staged, ...rest } = ev as Record<string, unknown>;
        job.items.push({ ...(rest as Partial<CollectItem>), filename, url: media.url, hash: media.hash, bytes: media.bytes, media });
      } catch (e) {
        job.status = "error";
        job.message = tr("Download finished but could not be added to the media library: {0}", e instanceof Error ? e.message : String(e));
        break;
      }
    }
  }
  job.finishedAt = Date.now();
  if (job.status === "running" && sawDone) {
    job.status = "done";
    job.stage = "done";
    job.percent = 100;
  } else if (job.status === "running") {
    job.status = "error";
    job.message = job.message ?? pickError(lastError, job.stderrTail, code);
    if (lastError?.notInstalled) job.message += tr("(install it with collect_install and try again)");
  }
}

export function collectPlugin(): Plugin {
  return {
    name: "vite-plugin-collect",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;

      // Login requires the agent browser. Dynamic import: sessions that do not log in should not pay
      // puppeteer startup costs
      const web = async () => ({
        browser: await import("./web/browser.mjs"),
        session: await import("./web/session.mjs"),
      });
      const webInst = async () => {
        const { browser } = await web();
        return browser.getBrowser({ dataDir: dataDir(root), executablePath: findBundledChrome(root) });
      };

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/collect")) return next();
        const [url, query = ""] = req.url.split("?");

        // GET /api/collect/status: whether yt-dlp is installed, ffmpeg exists, available presets, and
        // site login states
        if (req.method === "GET" && url === "/api/collect/status") {
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 200, { ok: true, ready: false, python: false, reason: pythonMissing(), cookies: cookieOverview(root) });
          const tail: string[] = [];
          let info: Record<string, unknown> = {};
          const code = await runLines(spawnPython(boot.python, ["-m", "promptcut_collect", "status"], boot.env),
            (ev) => { if (ev.event === "status") info = ev; }, tail);
          if (code !== 0 && !info.event) {
            return sendJson(res, 200, { ok: true, ready: false, python: true, reason: tail.slice(-3).join(" | "), cookies: cookieOverview(root) });
          }
          return sendJson(res, 200, { ok: true, python: true, ...info, cookies: cookieOverview(root) });
        }

        // POST /api/collect/install: pip installs yt-dlp, SSE streams logs back
        if (req.method === "POST" && url === "/api/collect/install") {
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 400, { ok: false, error: pythonMissing() });
          return pipeToSse(spawnPython(boot.python, ["-m", "promptcut_collect", "install"], boot.env), res);
        }

        // GET /api/collect/cookies: persisted login states across sites; DELETE ?site=x logs out
        if (url === "/api/collect/cookies") {
          if (req.method === "GET") return sendJson(res, 200, { ok: true, cookies: cookieOverview(root) });
          if (req.method === "DELETE") {
            const site = new URLSearchParams(query).get("site") ?? "";
            if (!(site in SITES)) return sendJson(res, 400, { ok: false, error: `site must be one of ${siteNames().join(" / ")}` });
            const removed = forgetCookies(dataDir(root), site);
            return sendJson(res, 200, { ok: true, removed, cookies: cookieOverview(root) });
          }
          return sendJson(res, 405, { ok: false, error: "Only GET / DELETE are supported" });
        }

        // POST /api/collect/login: brings login page to the user; user calls /login/check after scanning
        // QR code
        if (req.method === "POST" && url === "/api/collect/login") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "Request body is not valid JSON" }); }
          const site = typeof body.site === "string" ? body.site : "bilibili";
          if (!(site in SITES)) return sendJson(res, 400, { ok: false, error: `site must be one of ${siteNames().join(" / ")}` });
          const def = SITES[site as keyof typeof SITES];
          // If already logged in and not expired, no need to bother the user
          const saved = savedCookieStatus(dataDir(root), site);
          if (saved.loggedIn && body.force !== true) {
            return sendJson(res, 200, { ok: true, alreadyLoggedIn: true, site, userId: saved.userId, expiresAt: saved.expiresAt ? new Date(saved.expiresAt).toISOString() : null });
          }
          try {
            const { session } = await web();
            const result = await session.enqueue(async () => {
              const it = await webInst();
              await it.page.goto(def.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
              return session.handoff(it, { reason: `${def.name} login` });
            });
            return sendJson(res, 200, { ok: true, site, loginUrl: def.loginUrl, ...result });
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        // POST /api/collect/login/check: gets cookies from browser; if logged in, saves to disk and hides
        // the window
        if (req.method === "POST" && url === "/api/collect/login/check") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "Request body is not valid JSON" }); }
          const site = typeof body.site === "string" ? body.site : "bilibili";
          if (!(site in SITES)) return sendJson(res, 400, { ok: false, error: `site must be one of ${siteNames().join(" / ")}` });
          // Check persisted first: after successful QR code login (API version), login state is already in
          // the file, no need to touch the browser
          const savedNow = savedCookieStatus(dataDir(root), site);
          if (savedNow.loggedIn) {
            return sendJson(res, 200, {
              ok: true, loggedIn: true, site, userId: savedNow.userId, source: "saved",
              expiresAt: savedNow.expiresAt ? new Date(savedNow.expiresAt).toISOString() : null, path: savedNow.path,
            });
          }
          try {
            const { session, browser } = await web();
            // Do not launch the browser just for a quick check if it is not open. Instances in the module are
            // lost after hot restart, but getBrowser will take over rather than spawn anew when an active
            // debugging endpoint exists in profile, so check both
            if (!browser.peekBrowser() && !browser.existingEndpoint(dataDir(root))) {
              return sendJson(res, 200, { ok: true, loggedIn: false, site, missing: SITES[site as keyof typeof SITES].required, expired: savedNow.expired, hint: savedNow.expired ? tr("The saved login state has expired, log in again") : tr("No login state yet: run user_interface_collect_login first (scan the QR code or use the browser)") });
            }
            const result = await session.enqueue(async () => {
              const it = await webInst();
              const { cookies } = await it.cdp.send("Network.getAllCookies") as { cookies: Record<string, unknown>[] };
              const a = assessLogin(site, cookies);
              if (!a.loggedIn) {
                return {
                  ok: true, loggedIn: false, site, missing: a.missing, expired: a.expired,
                  hint: a.expired ? tr("The login state in the browser has expired, log in again in the window") : tr("No login state in the browser yet, finish logging in in the window and check again"),
                };
              }
              const file = saveCookies(dataDir(root), site, a.cookies);
              if (body.hide !== false) { try { await browser.hideWindow(it); } catch { /* Window may have been closed by user */ } }
              return {
                ok: true, loggedIn: true, site, userId: a.userId,
                expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
                path: file, count: a.cookies.length,
              };
            });
            return sendJson(res, 200, result);
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        // ── QR code login (API version, browserless): start gets key → svg display → poll waits for QR scan ──
        if (req.method === "POST" && url === "/api/collect/qr/start") {
          let body: Record<string, unknown> = {};
          try { const raw = (await readBody(req)).toString("utf-8"); if (raw) body = JSON.parse(raw); }
          catch { return sendJson(res, 400, { ok: false, error: "Request body is not valid JSON" }); }
          const site = typeof body.site === "string" ? body.site : "bilibili";
          try {
            const s = await qrLogin().start(site);
            return sendJson(res, 200, { ok: true, ...s, svgUrl: `/api/collect/qr/svg?key=${encodeURIComponent(s.key)}` });
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (req.method === "GET" && url === "/api/collect/qr/svg") {
          const key = new URLSearchParams(query).get("key") ?? "";
          const svg = key ? qrLogin().svg(key, { scale: 6 }) : null;
          if (!svg) return sendJson(res, 404, { ok: false, error: tr("This QR code does not exist or the service has restarted") });
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(svg);
        }
        if (req.method === "GET" && url === "/api/collect/qr/poll") {
          const key = new URLSearchParams(query).get("key") ?? "";
          if (!key) return sendJson(res, 400, { ok: false, error: "Missing key" });
          try {
            const r = await qrLogin().poll(key, { dataDir: dataDir(root) });
            return sendJson(res, 200, { ok: true, ...r });
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        // POST /api/collect/search: in-site search, returns candidate video list (each must be probed
        // individually, limit ≤ 10)
        if (req.method === "POST" && url === "/api/collect/search") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "Request body is not valid JSON" }); }
          const query = typeof body.query === "string" ? body.query.trim() : "";
          if (!query) return sendJson(res, 400, { ok: false, error: "Missing query" });
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 503, { ok: false, error: pythonMissing() });
          const site = typeof body.site === "string" && SITE_PRESETS.has(body.site) && body.site !== "auto" ? body.site : "bilibili";
          const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.max(1, Math.min(10, Math.round(body.limit))) : 5;
          const args = ["-m", "promptcut_collect", "search", "--query", query, "--site", site, "--limit", String(limit)];
          const ck = pickCookies(dataDir(root), site === "bilibili" ? "https://www.bilibili.com/" : "", undefined);
          if (ck.path) args.push("--cookies", ck.path);
          const child = spawnPython(boot.python, args, boot.env);
          const timer = setTimeout(() => killTree(child), 55_000);
          const tail: string[] = [];
          const notes: string[] = [];
          let done: Record<string, unknown> | undefined;
          let err: Record<string, unknown> | undefined;
          const code = await runLines(child, (ev) => {
            if (ev.event === "done") done = ev;
            else if (ev.event === "error") err = ev;
            else if (ev.event === "retry") notes.push(String(ev.message ?? "").slice(0, 160));
          }, tail);
          clearTimeout(timer);
          if (!done) {
            const message = err ? pickError(err, tail, code) : (code === -1 || code === 1 ? pickError(undefined, tail, code) : tr("Search timed out (55 seconds), lower limit and try again"));
            return sendJson(res, 200, { ok: false, error: message, notInstalled: !!err?.notInstalled, notes });
          }
          return sendJson(res, 200, { ok: true, notes, cookiesUsed: !!ck.path, ...done });
        }

        // POST /api/collect/probe: synchronous probe: title, duration, available resolutions, parts
        if (req.method === "POST" && url === "/api/collect/probe") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "Request body is not valid JSON" }); }
          const link = typeof body.url === "string" ? body.url.trim() : "";
          if (!link) return sendJson(res, 400, { ok: false, error: "Missing url" });
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 503, { ok: false, error: pythonMissing() });
          const args = ["-m", "promptcut_collect", "probe", "--url", link];
          if (typeof body.site === "string" && SITE_PRESETS.has(body.site) && body.site !== "auto") args.push("--site", body.site);
          if (typeof body.quality === "number" && QUALITIES.has(body.quality)) args.push("--quality", String(body.quality));
          const ck = pickCookies(dataDir(root), link, explicitCookies(root, body.cookies));
          if (ck.path) args.push("--cookies", ck.path);
          const child = spawnPython(boot.python, args, boot.env);
          const timer = setTimeout(() => killTree(child), 50_000);
          const tail: string[] = [];
          const notes: string[] = ck.reason ? [ck.reason] : [];
          let done: Record<string, unknown> | undefined;
          let err: Record<string, unknown> | undefined;
          const code = await runLines(child, (ev) => {
            if (ev.event === "done") done = ev;
            else if (ev.event === "error") err = ev;
            else if (ev.event === "retry") notes.push(String(ev.message ?? "").slice(0, 160));
          }, tail);
          clearTimeout(timer);
          if (!done) {
            const message = err ? pickError(err, tail, code) : (code === -1 || code === 1 ? pickError(undefined, tail, code) : tr("Probe timed out (50 s)"));
            return sendJson(res, 200, { ok: false, error: message, notInstalled: !!err?.notInstalled, notes });
          }
          return sendJson(res, 200, { ok: true, notes, cookiesUsed: !!ck.path, ...done });
        }

        // POST /api/collect/download: start a background job
        if (req.method === "POST" && url === "/api/collect/download") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "Request body is not valid JSON" }); }
          const link = typeof body.url === "string" ? body.url.trim() : "";
          if (!link) return sendJson(res, 400, { ok: false, error: "Missing url" });
          const quality = typeof body.quality === "number" && QUALITIES.has(body.quality) ? body.quality : 1080;
          const site = typeof body.site === "string" && SITE_PRESETS.has(body.site) ? body.site : "auto";
          // If the same link is already downloading, do not start another: two processes writing to the same
          // filename will collide
          const dup = [...jobs.values()].find((j) => j.status === "running" && j.url === link);
          if (dup) return sendJson(res, 200, { ok: true, jobId: dup.id, reused: true });
          const job: CollectJob = {
            id: randomUUID().slice(0, 8), url: link, site, quality,
            status: "running", stage: "starting", percent: 0,
            items: [], notes: [], cookiesUsed: false, stderrTail: [], startedAt: Date.now(),
          };
          // The job table is only in memory, avoid letting it accumulate: clean up jobs finished over an hour
          // ago (pollers have long since retrieved the results)
          const cutoff = Date.now() - 60 * 60 * 1000;
          for (const [id, j] of jobs) if (j.status !== "running" && (j.finishedAt ?? j.startedAt) < cutoff) jobs.delete(id);
          jobs.set(job.id, job);
          void runDownload(root, job, body).catch((e) => {
            job.status = "error";
            job.message = e instanceof Error ? e.message : String(e);
            job.finishedAt = Date.now();
          });
          return sendJson(res, 200, { ok: true, jobId: job.id });
        }

        // GET /api/collect/jobs: all jobs (used by UI list)
        if (req.method === "GET" && url === "/api/collect/jobs") {
          return sendJson(res, 200, { ok: true, jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt) });
        }

        // GET / DELETE /api/collect/job/<id>
        const jobMatch = url.match(/^\/api\/collect\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: tr("Job not found, the service may have restarted") });
          if (req.method === "GET") return sendJson(res, 200, { ok: true, job });
          if (req.method === "DELETE") {
            const child = procs.get(job.id);
            if (child) { killTree(child); procs.delete(job.id); }
            if (job.status === "running") {
              job.status = "error";
              job.message = "Cancelled";
              job.finishedAt = Date.now();
            }
            return sendJson(res, 200, { ok: true, job });
          }
          return sendJson(res, 405, { ok: false, error: "Only GET / DELETE are supported" });
        }

        return sendJson(res, 404, { ok: false, error: `No such endpoint: ${url}` });
      });
    },
  };
}
