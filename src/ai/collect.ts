/**
 * Frontend glue for media collection: probe extensions, install extensions, probe links, start
 * download jobs, poll.
 *
 * Downloads run on the server (python/promptcut_collect, wrapping yt-dlp); files first land in the
 * server's temp directory, then enter the content store via the asset service store API. The
 * client only waits; once done, the caller uses importVideoFromServer to register it as an asset
 * using the returned identifier.
 */
import { readSseStream } from "../editor/io/stt";
import type { UploadedMedia } from "../editor/io/mediaUpload";
import { tr } from "../i18n/index.ts";

/** Saved login state for a site */
export interface SiteCookieStatus {
  name: string;
  loggedIn: boolean;
  expired: boolean;
  userId: string | null;
  /** ISO time; null when session cookie has no expiration time */
  expiresAt: string | null;
  path: string | null;
}

export interface CollectStatus {
  ok: boolean;
  /** Whether built-in Python is present */
  python?: boolean;
  /** yt-dlp is installed and ffmpeg is found */
  ready: boolean;
  ytdlp?: { installed: boolean; version: string | null; error: string | null };
  ffmpeg?: string | null;
  presets?: { name: string; notes: string }[];
  /** Login state for each site, keyed by site id (bilibili) */
  cookies?: Record<string, SiteCookieStatus>;
  reason?: string;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  site?: string;
  /** Already logged in and not expired; window not popped up */
  alreadyLoggedIn?: boolean;
  userId?: string | null;
  expiresAt?: string | null;
  /** Window has been moved in front of the user */
  visible?: boolean;
  /** Desktop shell mode: browser is a child webview in main window, positioned by frontend invoking shell commands */
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
  /** QR code content */
  url: string;
  /** Validity period (seconds) */
  expiresIn: number;
  /** In-site address of QR code image (SVG) */
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

/** QR code login (API version): fetch a QR code. Image renders directly via <img> with returned svgUrl */
export async function qrStart(site = "bilibili"): Promise<QrStartResult> {
  const r = await fetch("/api/collect/qr/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("/api/collect/qr/start returned {0}", r.status));
  return data as QrStartResult;
}

/** QR code login: poll once to check if scanned. On ok, login state is saved to disk */
export async function qrPoll(key: string): Promise<QrPollResult> {
  const r = await fetch(`/api/collect/qr/poll?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("/api/collect/qr/poll returned {0}", r.status));
  return data as QrPollResult;
}

/** Bring site login page to front. If logged in and not expired, skip dialog and return alreadyLoggedIn */
export async function collectLogin(site = "bilibili", force = false): Promise<LoginResult> {
  const r = await fetch("/api/collect/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site, force }),
    signal: AbortSignal.timeout(58_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || tr("/api/collect/login returned {0}", r.status));
  return data as LoginResult;
}

/** Called after user scans QR code: fetch cookies from browser; if logged in, save to disk and hide window */
export async function collectLoginCheck(site = "bilibili", hide = true): Promise<LoginCheck> {
  const r = await fetch("/api/collect/login/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site, hide }),
    signal: AbortSignal.timeout(58_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || tr("/api/collect/login/check returned {0}", r.status));
  return data as LoginCheck;
}

export async function cookieStatus(): Promise<Record<string, SiteCookieStatus>> {
  const r = await fetch("/api/collect/cookies");
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Can't get the login state"));
  return data.cookies as Record<string, SiteCookieStatus>;
}

/** Log out: delete saved cookies.txt */
export async function collectLogout(site = "bilibili"): Promise<{ removed: boolean; cookies: Record<string, SiteCookieStatus> }> {
  const r = await fetch(`/api/collect/cookies?site=${encodeURIComponent(site)}`, { method: "DELETE" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Logout failed"));
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
  /** Available resolutions (pixel height), from high to low */
  heights?: number[];
  /** Part list for multi-part video; null for single video */
  parts?: { index: number; id: string; title: string; duration?: number }[] | null;
  subtitles?: string[];
  warnings?: string[];
}

export interface CollectItem {
  id?: string;
  title?: string;
  filename: string;
  /** Address after storing: /@media/<hash> */
  url: string;
  /** Content hash */
  hash?: string;
  /** Response from asset service store API (same as what user import receives) */
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
  /** ingest: all downloaded, currently sending into media library */
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
  /** When single probe fails, only url and error are present */
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

/** In-site search (Bilibili / YouTube) for agent to pick media. Each item probed separately; keep limit <= 10 */
export async function searchVideos(query: string, opts: { site?: string; limit?: number } = {}): Promise<CollectSearch> {
  const r = await fetch("/api/collect/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, ...opts }),
    signal: AbortSignal.timeout(58_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || tr("/api/collect/search returned {0}", r.status));
  return data as CollectSearch;
}

export async function collectStatus(): Promise<CollectStatus> {
  const r = await fetch("/api/collect/status");
  if (!r.ok) throw new Error(tr("Can't get the status of the media collection extension"));
  return r.json();
}

/** Install yt-dlp (pure Python wheel, ~3 MB). Streams pip logs, same pattern as installShots. */
export async function installCollect(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; log: string[]; status?: CollectStatus }> {
  const res = await fetch("/api/collect/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || tr("/api/collect/install returned {0}", res.status));
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
      const msg = ev.message ?? tr("Install failed");
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
  if (!r.ok) throw new Error(data.error || tr("/api/collect/probe returned {0}", r.status));
  return data as CollectProbe;
}

export async function startDownload(url: string, opts: DownloadOptions = {}): Promise<{ jobId: string; reused?: boolean }> {
  const r = await fetch("/api/collect/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, ...opts }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("The download could not start"));
  return { jobId: data.jobId as string, reused: !!data.reused };
}

export async function pollDownload(jobId: string): Promise<CollectJob> {
  const r = await fetch(`/api/collect/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Can't find this download job"));
  return data.job as CollectJob;
}

export async function cancelDownload(jobId: string): Promise<void> {
  await fetch(`/api/collect/job/${jobId}`, { method: "DELETE" }).catch(() => {});
}

/** Wait for a download job to finish. Dozens of MB typically take tens of seconds; polling interval is 1s. */
export async function waitForDownload(
  jobId: string,
  onProgress?: (job: CollectJob) => void,
  signal?: AbortSignal,
): Promise<CollectJob> {
  for (;;) {
    if (signal?.aborted) throw new Error(tr("Cancelled"));
    const job = await pollDownload(jobId);
    onProgress?.(job);
    if (job.status === "error") throw new Error(job.message || tr("Download failed"));
    if (job.status === "done") return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function listDownloads(): Promise<CollectJob[]> {
  const r = await fetch("/api/collect/jobs");
  const data = await r.json().catch(() => ({}));
  return (data.jobs ?? []) as CollectJob[];
}
