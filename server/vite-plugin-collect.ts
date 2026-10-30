/**
 * 素材收集:从网页链接(B 站等)把视频抓成本地文件,落到素材目录,供编辑台导入。
 *
 * 真正干活的是 python/promptcut_collect(yt-dlp 的封装),这边只做四件事:
 *   - 探拓展装没装(/status)、装拓展(/install,SSE 回 pip 日志);
 *   - 同步探测一条链接(/probe,几秒钟,拿标题时长清晰度);
 *   - 起下载作业(/download 立刻回 jobId,/job/<id> 轮询进度,DELETE 取消);
 *   - 文件先下到这一个作业自己的临时目录,进程退出后逐个经素材服务的入库接口送进内容库
 *     (`server/media-ingest.mjs`,和用户导入素材走同一条路;`docs/semantics/product/asset-service.md`
 *     「入库这一步不能省」),作业结果里给入库后的 /@media/<hash> 与入库回包,前端按它登记成素材;临时目录随后删掉。
 *     原来是直接下进素材目录、再由前端请服务端就地补算哈希,绕过了入库。
 *
 * 登录态(/login、/login/check、/cookies)走 server/web/ 那个给 agent 用的浏览器:
 * 把登录页挪到用户面前扫码,扫完从 CDP 取 cookie 存成 cookies.txt,之后探测和下载
 * 自动带上。判定和读写在 collect-cookies.mjs(纯逻辑,可单测)。
 *
 * 作业只在内存里:服务重启就没了,前端轮到 404 会说明「可能服务已重启」。
 */
import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { buildEnv, dataDir, findPython, pipeToSse, readBody, spawnPython, PYTHON_MISSING } from "./vite-plugin-stt";
import { assetServiceOrigin } from "./asset-client";
import { ingestFile } from "./media-ingest.mjs";
import { findBundledChrome } from "./vite-plugin-web";
import {
  SITES, siteNames, assessLogin, saveCookies, savedCookieStatus, forgetCookies, pickCookies,
} from "./collect-cookies.mjs";
import { qrLogin } from "./collect-qr-login.mjs";
import { isInside } from "./http-guard.mjs";

/** ingest:文件都下好了,正在经素材服务的入库接口送进内容库 */
export type CollectStage = "starting" | "video" | "audio" | "merge" | "transcode" | "ingest" | "done";

/** 素材服务入库接口的回包(`server/media-ingest.mjs` 的 ingestFile),前端按它登记素材 */
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
  /** 入库后的地址 /@media/<hash>,前端用它取文件登记成素材 */
  url: string;
  /** 内容哈希 */
  hash?: string;
  /** 入库回包 */
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
  /** 整体进度 0~100 */
  percent: number;
  /** 当前阶段自己的进度 */
  stagePercent?: number;
  speed?: number | null;
  eta?: number | null;
  downloaded?: number;
  total?: number | null;
  /** 探到的标题 / 时长,下载开始前就有 */
  info?: Record<string, unknown>;
  items: CollectItem[];
  /** 出错时的人话;取消也走这里 */
  message?: string;
  /** 412 之类的重试记录,给界面和 agent 看 */
  notes: string[];
  /** 这次带没带登录态 */
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
  } catch { /* 已经退了 */ }
}

/** 跑一个子命令到结束,把 stdout 的 JSONL 逐行交给 onLine,返回退出码和 stderr 尾巴 */
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
      if (buf.trim()) { try { onLine(JSON.parse(buf.trim())); } catch { /* 半行,丢 */ } }
      resolve(code ?? -1);
    });
  });
}

function bootstrap(root: string): Promise<{ python: string; env: NodeJS.ProcessEnv } | null> {
  const python = findPython(root);
  if (!python) return Promise.resolve(null);
  return buildEnv(root, python).then((env) => ({ python, env }));
}

/** 把 Python 报错里最有用的那句挑出来 */
function pickError(obj: Record<string, unknown> | undefined, stderrTail: string[], code: number): string {
  const msg = typeof obj?.message === "string" ? obj.message : "";
  if (msg) return msg;
  const useful = [...stderrTail].reverse().find((l) => /error|失败|找不到|not found/i.test(l));
  return useful || `下载进程退出码 ${code}`;
}

/**
 * 调用方显式传的 cookies 文件:只认 <dataDir>/cookies/ 底下的。
 * yt-dlp 会把这个文件的内容当 cookie 发给远端站点 —— 让模型随便指一个磁盘路径,
 * 等于给了一条「把任意本地文件发到外站」的路(评审抓到的)。范围外的一律当没传。
 */
function explicitCookies(root: string, raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const dir = path.resolve(dataDir(root), "cookies");
  const target = path.resolve(raw);
  // 用 isInside 而不是自己写 startsWith:Windows 的路径大小写不敏感,自己比会把
  // `C:\Users\...` 和 `c:\users\...` 判成两个地方。判错的方向虽然是安全的(把合法文件
  // 当越界忽略),但表现是「登录态明明存了、下载却不带 cookie」,还不报错。
  return isInside(target, dir) ? target : undefined;
}

/** 各站点存盘登录态的现状,status 和 cookies 两个接口都回它 */
function cookieOverview(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of siteNames()) {
    const st = savedCookieStatus(dataDir(root), id);
    out[id] = {
      name: SITES[id as keyof typeof SITES].name,
      loggedIn: st.loggedIn, expired: st.expired, userId: st.userId,
      expiresAt: st.expiresAt ? new Date(st.expiresAt).toISOString() : null,
      path: st.exists ? st.path : null,
    };
  }
  return out;
}

async function runDownload(root: string, job: CollectJob, body: Record<string, unknown>): Promise<void> {
  const boot = await bootstrap(root);
  if (!boot) { job.status = "error"; job.message = PYTHON_MISSING; job.finishedAt = Date.now(); return; }
  // 这一个作业自己的临时目录:yt-dlp 落在这里,入库之后连目录一起删(见文件头)
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
  /** Python 报上来的文件,进程退出后逐个入库 */
  const staged: Record<string, unknown>[] = [];

  const code = await runLines(child, (ev) => {
    const type = ev.event;
    if (type === "info") {
      // 只留给人看的几项:description 几百字、thumbnail 链接之类对轮询方没用,还占上下文
      const { id, title, duration, uploader, webpage_url } = ev as Record<string, unknown>;
      job.info = { id, title, duration, uploader, webpage_url };
    } else if (type === "retry") {
      job.notes.push(`第 ${ev.attempt} 次遇到临时错误,${ev.wait}s 后重试:${String(ev.message ?? "").slice(0, 160)}`);
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
      // 先记下,等进程退出后和 finishedAt 一起改:轮询方看到 done 时 finishedAt 必须已经有了,进程也已经退出
      sawDone = true;
    } else if (type === "error") {
      lastError = ev;
    }
  }, job.stderrTail);

  procs.delete(job.id);
  if (job.status === "running" && sawDone) {
    // 入库:只认临时目录里这一层的文件(按 Python 报的文件名取最后一段),别处的路径一概不传
    job.stage = "ingest";
    for (const ev of staged) {
      if (job.status !== "running") break; // 入库期间被取消
      const filename = path.basename(String(ev.filename ?? "") || String(ev.path ?? ""));
      const file = path.join(outDir, filename);
      if (!filename || !fs.existsSync(file)) {
        job.status = "error";
        job.message = `下载进程报了文件「${filename || "(没有文件名)"}」,临时目录里却没有它`;
        break;
      }
      try {
        const media = await ingestFile({ file, name: filename, origin: assetServiceOrigin }) as IngestedMedia;
        const { path: _staged, ...rest } = ev as Record<string, unknown>;
        job.items.push({ ...(rest as Partial<CollectItem>), filename, url: media.url, hash: media.hash, bytes: media.bytes, media });
      } catch (e) {
        job.status = "error";
        job.message = `下载好了但没能送进素材库:${e instanceof Error ? e.message : String(e)}`;
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
    if (lastError?.notInstalled) job.message += "(用 collect_install 装上再试)";
  }
}

export function collectPlugin(): Plugin {
  return {
    name: "vite-plugin-collect",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;

      // 登录要用 agent 那个浏览器。动态 import:不登录的会话不该为 puppeteer 付启动成本
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

        // GET /api/collect/status —— yt-dlp 装没装、ffmpeg 在不在、有哪些预设、各站登录态
        if (req.method === "GET" && url === "/api/collect/status") {
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 200, { ok: true, ready: false, python: false, reason: PYTHON_MISSING, cookies: cookieOverview(root) });
          const tail: string[] = [];
          let info: Record<string, unknown> = {};
          const code = await runLines(spawnPython(boot.python, ["-m", "promptcut_collect", "status"], boot.env),
            (ev) => { if (ev.event === "status") info = ev; }, tail);
          if (code !== 0 && !info.event) {
            return sendJson(res, 200, { ok: true, ready: false, python: true, reason: tail.slice(-3).join(" | "), cookies: cookieOverview(root) });
          }
          return sendJson(res, 200, { ok: true, python: true, ...info, cookies: cookieOverview(root) });
        }

        // POST /api/collect/install —— pip 装 yt-dlp,SSE 流式回日志
        if (req.method === "POST" && url === "/api/collect/install") {
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 400, { ok: false, error: PYTHON_MISSING });
          return pipeToSse(spawnPython(boot.python, ["-m", "promptcut_collect", "install"], boot.env), res);
        }

        // GET /api/collect/cookies —— 各站存盘登录态;DELETE ?site=x 退出登录
        if (url === "/api/collect/cookies") {
          if (req.method === "GET") return sendJson(res, 200, { ok: true, cookies: cookieOverview(root) });
          if (req.method === "DELETE") {
            const site = new URLSearchParams(query).get("site") ?? "";
            if (!(site in SITES)) return sendJson(res, 400, { ok: false, error: `site 只能是 ${siteNames().join(" / ")}` });
            const removed = forgetCookies(dataDir(root), site);
            return sendJson(res, 200, { ok: true, removed, cookies: cookieOverview(root) });
          }
          return sendJson(res, 405, { ok: false, error: "只支持 GET / DELETE" });
        }

        // POST /api/collect/login —— 把登录页挪到用户面前;用户扫完码再调 /login/check
        if (req.method === "POST" && url === "/api/collect/login") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          const site = typeof body.site === "string" ? body.site : "bilibili";
          if (!(site in SITES)) return sendJson(res, 400, { ok: false, error: `site 只能是 ${siteNames().join(" / ")}` });
          const def = SITES[site as keyof typeof SITES];
          // 已经登录且没过期就不用再麻烦用户
          const saved = savedCookieStatus(dataDir(root), site);
          if (saved.loggedIn && body.force !== true) {
            return sendJson(res, 200, { ok: true, alreadyLoggedIn: true, site, userId: saved.userId, expiresAt: saved.expiresAt ? new Date(saved.expiresAt).toISOString() : null });
          }
          try {
            const { session } = await web();
            const result = await session.enqueue(async () => {
              const it = await webInst();
              await it.page.goto(def.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
              return session.handoff(it, { reason: `${def.name}登录` });
            });
            return sendJson(res, 200, { ok: true, site, loginUrl: def.loginUrl, ...result });
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        // POST /api/collect/login/check —— 从浏览器取 cookie,登录了就存盘、把窗口藏回去
        if (req.method === "POST" && url === "/api/collect/login/check") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          const site = typeof body.site === "string" ? body.site : "bilibili";
          if (!(site in SITES)) return sendJson(res, 400, { ok: false, error: `site 只能是 ${siteNames().join(" / ")}` });
          // 先看存盘的:扫码登录(接口版)成功后登录态已经在文件里,不用碰浏览器
          const savedNow = savedCookieStatus(dataDir(root), site);
          if (savedNow.loggedIn) {
            return sendJson(res, 200, {
              ok: true, loggedIn: true, site, userId: savedNow.userId, source: "saved",
              expiresAt: savedNow.expiresAt ? new Date(savedNow.expiresAt).toISOString() : null, path: savedNow.path,
            });
          }
          try {
            const { session, browser } = await web();
            // 浏览器没开着就别为了查一眼把它拉起来。热重启后模块里的实例会丢,但 profile 里
            // 有活着的调试端点时 getBrowser 会接管而不是新起,所以两样都看
            if (!browser.peekBrowser() && !browser.existingEndpoint(dataDir(root))) {
              return sendJson(res, 200, { ok: true, loggedIn: false, site, missing: SITES[site as keyof typeof SITES].required, expired: savedNow.expired, hint: savedNow.expired ? "存盘的登录态已过期,重新登录一次" : "还没有登录态:先 user_interface_collect_login(扫码或浏览器)" });
            }
            const result = await session.enqueue(async () => {
              const it = await webInst();
              const { cookies } = await it.cdp.send("Network.getAllCookies") as { cookies: Record<string, unknown>[] };
              const a = assessLogin(site, cookies);
              if (!a.loggedIn) {
                return {
                  ok: true, loggedIn: false, site, missing: a.missing, expired: a.expired,
                  hint: a.expired ? "浏览器里的登录态已过期,请在窗口里重新登录" : "浏览器里还没有登录态,请在窗口里完成登录后再查一次",
                };
              }
              const file = saveCookies(dataDir(root), site, a.cookies);
              if (body.hide !== false) { try { await browser.hideWindow(it); } catch { /* 窗口可能已被用户关掉 */ } }
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

        // ── 扫码登录(接口版,不开浏览器):start 拿 key → svg 显示 → poll 等扫码 ──
        if (req.method === "POST" && url === "/api/collect/qr/start") {
          let body: Record<string, unknown> = {};
          try { const raw = (await readBody(req)).toString("utf-8"); if (raw) body = JSON.parse(raw); }
          catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
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
          if (!svg) return sendJson(res, 404, { ok: false, error: "这张二维码不存在或服务已重启" });
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(svg);
        }
        if (req.method === "GET" && url === "/api/collect/qr/poll") {
          const key = new URLSearchParams(query).get("key") ?? "";
          if (!key) return sendJson(res, 400, { ok: false, error: "缺 key" });
          try {
            const r = await qrLogin().poll(key, { dataDir: dataDir(root) });
            return sendJson(res, 200, { ok: true, ...r });
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        // POST /api/collect/search —— 站内搜索,回候选视频列表(每条要单独探测,limit ≤ 10)
        if (req.method === "POST" && url === "/api/collect/search") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          const query = typeof body.query === "string" ? body.query.trim() : "";
          if (!query) return sendJson(res, 400, { ok: false, error: "缺 query" });
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 503, { ok: false, error: PYTHON_MISSING });
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
            const message = err ? pickError(err, tail, code) : (code === -1 || code === 1 ? pickError(undefined, tail, code) : "搜索超时(55 秒),把 limit 调小再试");
            return sendJson(res, 200, { ok: false, error: message, notInstalled: !!err?.notInstalled, notes });
          }
          return sendJson(res, 200, { ok: true, notes, cookiesUsed: !!ck.path, ...done });
        }

        // POST /api/collect/probe —— 同步探测:标题、时长、可选清晰度、分 P
        if (req.method === "POST" && url === "/api/collect/probe") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          const link = typeof body.url === "string" ? body.url.trim() : "";
          if (!link) return sendJson(res, 400, { ok: false, error: "缺 url" });
          const boot = await bootstrap(root);
          if (!boot) return sendJson(res, 503, { ok: false, error: PYTHON_MISSING });
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
            const message = err ? pickError(err, tail, code) : (code === -1 || code === 1 ? pickError(undefined, tail, code) : "探测超时(50 秒)");
            return sendJson(res, 200, { ok: false, error: message, notInstalled: !!err?.notInstalled, notes });
          }
          return sendJson(res, 200, { ok: true, notes, cookiesUsed: !!ck.path, ...done });
        }

        // POST /api/collect/download —— 起一个后台作业
        if (req.method === "POST" && url === "/api/collect/download") {
          let body: Record<string, unknown>;
          try { body = JSON.parse((await readBody(req)).toString("utf-8") || "{}"); }
          catch { return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          const link = typeof body.url === "string" ? body.url.trim() : "";
          if (!link) return sendJson(res, 400, { ok: false, error: "缺 url" });
          const quality = typeof body.quality === "number" && QUALITIES.has(body.quality) ? body.quality : 1080;
          const site = typeof body.site === "string" && SITE_PRESETS.has(body.site) ? body.site : "auto";
          // 同一条链接正在下就别再起一个:两个进程写同一个文件名会互相踩
          const dup = [...jobs.values()].find((j) => j.status === "running" && j.url === link);
          if (dup) return sendJson(res, 200, { ok: true, jobId: dup.id, reused: true });
          const job: CollectJob = {
            id: randomUUID().slice(0, 8), url: link, site, quality,
            status: "running", stage: "starting", percent: 0,
            items: [], notes: [], cookiesUsed: false, stderrTail: [], startedAt: Date.now(),
          };
          // 作业表只在内存里,别越攒越多:跑完超过一小时的顺手清掉(轮询方早就拿走结果了)
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

        // GET /api/collect/jobs —— 全部作业(界面列表用)
        if (req.method === "GET" && url === "/api/collect/jobs") {
          return sendJson(res, 200, { ok: true, jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt) });
        }

        // GET / DELETE /api/collect/job/<id>
        const jobMatch = url.match(/^\/api\/collect\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: "作业不存在,可能服务已重启" });
          if (req.method === "GET") return sendJson(res, 200, { ok: true, job });
          if (req.method === "DELETE") {
            const child = procs.get(job.id);
            if (child) { killTree(child); procs.delete(job.id); }
            if (job.status === "running") {
              job.status = "error";
              job.message = "已取消";
              job.finishedAt = Date.now();
            }
            return sendJson(res, 200, { ok: true, job });
          }
          return sendJson(res, 405, { ok: false, error: "只支持 GET / DELETE" });
        }

        return sendJson(res, 404, { ok: false, error: `没有这个接口:${url}` });
      });
    },
  };
}
