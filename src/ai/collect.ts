/**
 * 素材收集的前端胶水：探拓展、装拓展、探链接、起下载作业、轮询。
 *
 * 下载跑在服务端（python/promptcut_collect，yt-dlp 封装），文件先落服务端的临时目录、再经素材服务的入库接口进内容库，
 * 这边只负责等；等到 done 之后由调用方用 importVideoFromServer 按入库回来的标识把它登记成素材。
 */
import { readSseStream } from "../editor/io/stt";
import type { UploadedMedia } from "../editor/io/mediaUpload";

/** 某个站点存盘的登录态 */
export interface SiteCookieStatus {
  name: string;
  loggedIn: boolean;
  expired: boolean;
  userId: string | null;
  /** ISO 时间;会话 cookie 没有过期时间时为 null */
  expiresAt: string | null;
  path: string | null;
}

export interface CollectStatus {
  ok: boolean;
  /** 内置 Python 在不在 */
  python?: boolean;
  /** yt-dlp 装了且 ffmpeg 找得到 */
  ready: boolean;
  ytdlp?: { installed: boolean; version: string | null; error: string | null };
  ffmpeg?: string | null;
  presets?: { name: string; notes: string }[];
  /** 各站登录态,键是站点 id(bilibili) */
  cookies?: Record<string, SiteCookieStatus>;
  reason?: string;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  site?: string;
  /** 已经登录且没过期,窗口没弹 */
  alreadyLoggedIn?: boolean;
  userId?: string | null;
  expiresAt?: string | null;
  /** 窗口已经挪到用户面前 */
  visible?: boolean;
  /** 桌面壳模式:浏览器是主窗口里的子 webview,要由前端 invoke 壳的命令摆到位 */
  shell?: boolean;
  message?: string;
}

export interface LoginCheck {
  ok: boolean;
  error?: string;
  site?: string;
  loggedIn?: boolean;
  missing?: string[];
  expired?: boolean;
  userId?: string | null;
  expiresAt?: string | null;
  path?: string;
  count?: number;
  hint?: string;
}

export interface QrStartResult {
  key: string;
  site: string;
  /** 二维码里的内容 */
  url: string;
  /** 有效期(秒) */
  expiresIn: number;
  /** 二维码图片的站内地址(SVG) */
  svgUrl: string;
}

export interface QrPollResult {
  state: "waiting" | "scanned" | "expired" | "ok";
  message?: string;
  loggedIn?: boolean;
  userId?: string | null;
  expiresAt?: string | null;
  path?: string | null;
}

/** 扫码登录(接口版):拿一张二维码。图片用返回的 svgUrl 直接 <img> */
export async function qrStart(site = "bilibili"): Promise<QrStartResult> {
  const r = await fetch("/api/collect/qr/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || `/api/collect/qr/start 返回 ${r.status}`);
  return data as QrStartResult;
}

/** 扫码登录:问一次扫没扫。ok 时登录态已经存盘 */
export async function qrPoll(key: string): Promise<QrPollResult> {
  const r = await fetch(`/api/collect/qr/poll?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || `/api/collect/qr/poll 返回 ${r.status}`);
  return data as QrPollResult;
}

/** 把站点登录页挪到用户面前。已登录且没过期时不弹窗,直接回 alreadyLoggedIn */
export async function collectLogin(site = "bilibili", force = false): Promise<LoginResult> {
  const r = await fetch("/api/collect/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site, force }),
    signal: AbortSignal.timeout(58_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `/api/collect/login 返回 ${r.status}`);
  return data as LoginResult;
}

/** 用户扫完码之后调:从浏览器取 cookie,登录了就存盘并把窗口藏回去 */
export async function collectLoginCheck(site = "bilibili", hide = true): Promise<LoginCheck> {
  const r = await fetch("/api/collect/login/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site, hide }),
    signal: AbortSignal.timeout(58_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `/api/collect/login/check 返回 ${r.status}`);
  return data as LoginCheck;
}

export async function cookieStatus(): Promise<Record<string, SiteCookieStatus>> {
  const r = await fetch("/api/collect/cookies");
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "查不到登录态");
  return data.cookies as Record<string, SiteCookieStatus>;
}

/** 退出登录:删掉存盘的 cookies.txt */
export async function collectLogout(site = "bilibili"): Promise<{ removed: boolean; cookies: Record<string, SiteCookieStatus> }> {
  const r = await fetch(`/api/collect/cookies?site=${encodeURIComponent(site)}`, { method: "DELETE" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "退出登录失败");
  return { removed: !!data.removed, cookies: data.cookies };
}

export interface CollectProbe {
  ok: boolean;
  error?: string;
  notInstalled?: boolean;
  notes?: string[];
  id?: string;
  title?: string;
  duration?: number;
  uploader?: string;
  extractor?: string;
  webpage_url?: string;
  site?: string;
  url?: string;
  /** 可选的清晰度（像素高度），从高到低 */
  heights?: number[];
  /** 多 P 稿件的分 P 列表；单个视频为 null */
  parts?: { index: number; id: string; title: string; duration?: number }[] | null;
  subtitles?: string[];
  warnings?: string[];
}

export interface CollectItem {
  id?: string;
  title?: string;
  filename: string;
  /** 入库后的地址 /@media/<hash> */
  url: string;
  /** 内容哈希 */
  hash?: string;
  /** 素材服务入库接口的回包(和用户导入拿到的是同一种) */
  media?: UploadedMedia;
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
  /** ingest:都下好了,正在送进素材库 */
  stage: "starting" | "video" | "audio" | "merge" | "transcode" | "ingest" | "done";
  percent: number;
  stagePercent?: number;
  speed?: number | null;
  eta?: number | null;
  downloaded?: number;
  total?: number | null;
  info?: { title?: string; duration?: number; uploader?: string };
  items: CollectItem[];
  message?: string;
  notes: string[];
  startedAt: number;
  finishedAt?: number;
}

export interface DownloadOptions {
  site?: string;
  quality?: number;
  audioOnly?: boolean;
  allParts?: boolean;
  keepCodec?: boolean;
  cookies?: string;
  cookiesFromBrowser?: string;
}

export interface CollectSearchHit {
  id?: string;
  title?: string;
  url: string;
  duration?: number;
  uploader?: string;
  view_count?: number | null;
  like_count?: number | null;
  upload_date?: string;
  description?: string;
  max_height?: number | null;
  /** 单条探测失败时只有 url 和 error */
  error?: string;
}

export interface CollectSearch {
  ok: boolean;
  error?: string;
  notInstalled?: boolean;
  notes?: string[];
  cookiesUsed?: boolean;
  query?: string;
  site?: string;
  results?: CollectSearchHit[];
  warnings?: string[];
}

/** 站内搜索(B 站 / YouTube),给 agent 挑素材。每条要单独探测,limit 别超过 10 */
export async function searchVideos(query: string, opts: { site?: string; limit?: number } = {}): Promise<CollectSearch> {
  const r = await fetch("/api/collect/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, ...opts }),
    signal: AbortSignal.timeout(58_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `/api/collect/search 返回 ${r.status}`);
  return data as CollectSearch;
}

export async function collectStatus(): Promise<CollectStatus> {
  const r = await fetch("/api/collect/status");
  if (!r.ok) throw new Error("查不到素材收集拓展的状态");
  return r.json();
}

/** 装 yt-dlp（纯 Python 轮子，约 3 MB）。流式读 pip 日志，和 installShots 一个路数。 */
export async function installCollect(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; log: string[]; status?: CollectStatus }> {
  const res = await fetch("/api/collect/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `/api/collect/install 返回 ${res.status}`);
  }
  const log: string[] = [];
  let ok = true;
  let status: CollectStatus | undefined;
  await readSseStream(res.body, (ev) => {
    if (ev.event === "log") {
      const line = ev.line ?? ev.data ?? "";
      log.push(line);
      onLog?.(line);
    } else if (ev.event === "installed") {
      status = ev as unknown as CollectStatus;
    } else if (ev.event === "error") {
      ok = false;
      const msg = ev.message ?? "安装失败";
      const detail = typeof ev.stderr === "string" ? ev.stderr.trim() : "";
      const full = detail ? `${msg}\n${detail}` : msg;
      log.push("[error] " + full);
      onLog?.("[error] " + full);
    }
  });
  return { ok, log, status };
}

export async function probeLink(url: string, opts: { site?: string; quality?: number } = {}): Promise<CollectProbe> {
  const r = await fetch("/api/collect/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...opts }),
    signal: AbortSignal.timeout(58_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `/api/collect/probe 返回 ${r.status}`);
  return data as CollectProbe;
}

export async function startDownload(url: string, opts: DownloadOptions = {}): Promise<{ jobId: string; reused?: boolean }> {
  const r = await fetch("/api/collect/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...opts }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "下载没能启动");
  return { jobId: data.jobId as string, reused: !!data.reused };
}

export async function pollDownload(jobId: string): Promise<CollectJob> {
  const r = await fetch(`/api/collect/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "查不到这个下载作业");
  return data.job as CollectJob;
}

export async function cancelDownload(jobId: string): Promise<void> {
  await fetch(`/api/collect/job/${jobId}`, { method: "DELETE" }).catch(() => {});
}

/** 等一个下载作业跑完。几十 MB 的视频通常几十秒，轮询间隔 1 秒。 */
export async function waitForDownload(
  jobId: string,
  onProgress?: (job: CollectJob) => void,
  signal?: AbortSignal,
): Promise<CollectJob> {
  for (;;) {
    if (signal?.aborted) throw new Error("已取消");
    const job = await pollDownload(jobId);
    onProgress?.(job);
    if (job.status === "error") throw new Error(job.message || "下载失败");
    if (job.status === "done") return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function listDownloads(): Promise<CollectJob[]> {
  const r = await fetch("/api/collect/jobs");
  const data = await r.json().catch(() => ({}));
  return (data.jobs ?? []) as CollectJob[];
}
