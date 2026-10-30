/**
 * 音频测量(`measure_audio`、`measure_audio_js`)从哪儿读素材:**只经素材服务的 HTTP 接口**
 * (`docs/semantics/product/agent.md`「工具」的「素材与产物」;`product/asset-service.md`「职责」第三条)。
 * 编辑器进程不再按素材目录找文件,ffmpeg / ffprobe 直接拿素材服务上的 HTTP 地址当输入,自己按 Range 分段取。
 *
 * 地址怎么拼由调用方注入(`vite-plugin-audio.ts` 用 `vision/ffmpeg-frames.ts` 的 `mediaSourceOf`,与看画面的素材层同一条),
 * 本文件不 import vite、不认目录,`server/test/audio-asset-path.test.mjs` 直接测它。
 *
 * 三种结果要分清,Agent 才知道该怎么办:
 * - 取到地址、素材服务答了 2xx → 用这个地址;
 * - 素材服务答 404 / 拼不出地址 → 回 null,调用方照旧说「素材文件不存在」(时间轴档跳过这一段);
 * - 素材服务不可达(取不到基址、连不上、超时)或拒绝(401 / 403 / 5xx)→ 抛 `AssetSourceError`,
 *   调用方回一句写明素材服务地址与原因的错,不当成「文件不存在」「没有音频流」。
 */
import { spawn } from "node:child_process";

export class AssetSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssetSourceError";
  }
}

/** 探一下素材服务答不答这份素材的时限 */
export const SOURCE_CHECK_TIMEOUT_MS = 10_000;

/**
 * 做一个解析器:素材记录 → 素材服务上的 HTTP 地址(给 ffmpeg / ffprobe 的 `-i`)。
 * @param {object} p
 * @param {() => (string | null)} p.origin 素材服务的源(每次解析时取,基址可能变);null = 不可达
 * @param {(m: any, origin: string) => (string | null)} p.toUrl 素材记录 → 地址;拼不出回 null
 * @param {typeof fetch} [p.fetchImpl]
 * @param {number} [p.timeoutMs]
 * @returns {(m: any) => Promise<string | null>}
 */
export function createAssetSourceResolver({ origin, toUrl, fetchImpl = globalThis.fetch, timeoutMs = SOURCE_CHECK_TIMEOUT_MS }) {
  return async (m) => {
    const base = origin();
    if (!base) throw new AssetSourceError("素材服务不可达:编辑器进程取不到素材服务的地址");
    const url = toUrl(m, base);
    if (!url) return null;
    let res;
    try {
      // 只要 1 个字节:看素材服务答不答、有没有这份素材。共享项目里本地没有的,这一下同时让本地素材服务开始向远程拉
      res = await fetchImpl(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const why = e?.name === "TimeoutError" ? `${timeoutMs / 1000} 秒没有应答` : String(e?.cause?.code || e?.message || e);
      throw new AssetSourceError(`素材服务不可达(${base}):${why}`);
    }
    try { await res.body?.cancel(); } catch { /* 已经读完 */ }
    if (res.status === 404) return null;
    if (res.status >= 200 && res.status < 300) return url;
    throw new AssetSourceError(`素材服务拒绝了读取(${base},HTTP ${res.status})`);
  };
}

/**
 * 异步跑 ffprobe 取文本输出;失败、超时回 null。
 * 必须是异步的:单进程形态里素材服务就在编辑器进程自己身上,同步的 execFileSync 会卡住事件循环,
 * ffprobe 发来的 HTTP 请求没人答,只能等到超时。
 */
export function ffprobeText(ffprobe, args, { timeoutMs = 15_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = spawnImpl(ffprobe, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } finish(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
  });
}

/** 有没有音频流(与原来 `vite-plugin-audio.ts` 的 hasAudioStream 同一组 ffprobe 参数) */
export async function hasAudioStreamAsync(src, ffprobe) {
  const out = await ffprobeText(ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src]);
  return !!out && out.trim().length > 0;
}

/** 第一条音频流的声道数;没有音频流回 0(与 `audio-measure-js.mjs` 的 probeAudioChannels 同一组参数) */
export async function probeAudioChannelsAsync(src, ffprobe) {
  const out = await ffprobeText(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", src]);
  const n = parseInt(String(out ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
