/**
 * Where audio measurement (`measure_audio`, `measure_audio_js`) reads assets: **only via the asset
 * service HTTP interface** (`docs/semantics/product/agent.md` "Tools" under "Media and artifacts";
 * `product/asset-service.md` "Responsibilities" item 3).
 * The editor process no longer looks up files by the asset catalog; ffmpeg / ffprobe directly takes
 * the HTTP URL on the asset service as input, fetching segments via Range by itself.
 *
 * How the URL is constructed is injected by the caller (`vite-plugin-audio.ts` uses `mediaSourceOf`
 * from `vision/ffmpeg-frames.ts`, the same line as the asset layer for viewing frames); this file
 * does not import vite, does not recognize directories, and
 * `server/test/audio-asset-path.test.mjs` tests it directly.
 *
 * Distinguish the three outcomes clearly so the Agent knows what to do:
 * - URL resolved and asset service responds with 2xx -> use this URL;
 * - Asset service responds with 404 / cannot construct URL -> return null, caller says "Asset file
 *   does not exist" as before (timeline tier skips this segment);
 * - Asset service is unreachable (cannot get base URL, connection failed, timeout) or rejects
 *   (401 / 403 / 5xx) -> throw `AssetSourceError`, caller returns an error stating the asset
 *   service URL and reason, not treating it as "File does not exist" or "No audio stream".
 */
import { spawn } from "node:child_process";
import { tr } from "./i18n.mjs";

export class AssetSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssetSourceError";
  }
}

/** Timeout for probing whether the asset service responds for this asset */
export const SOURCE_CHECK_TIMEOUT_MS = 10_000;

/**
 * Create a resolver: asset record -> HTTP URL on the asset service (passed to `-i` of ffmpeg / ffprobe).
 * @param {object} p
 * @param {() => (string | null)} p.origin Asset service origin (fetched on each resolution, base URL may change); null = unreachable
 * @param {(m: any, origin: string) => (string | null)} p.toUrl Asset record -> URL; returns null if cannot be constructed
 * @param {typeof fetch} [p.fetchImpl]
 * @param {number} [p.timeoutMs]
 * @returns {(m: any) => Promise<string | null>}
 */
export function createAssetSourceResolver({ origin, toUrl, fetchImpl = globalThis.fetch, timeoutMs = SOURCE_CHECK_TIMEOUT_MS }) {
  return async (m) => {
    const base = origin();
    if (!base) throw new AssetSourceError(tr("Asset service unreachable: the editor process cannot get the asset service address"));
    const url = toUrl(m, base);
    if (!url) return null;
    let res;
    try {
      // Only need 1 byte: see if the asset service responds and has this asset. In a shared project,
      // if not present locally, this also prompts the local asset service to start pulling from remote
      res = await fetchImpl(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const why = e?.name === "TimeoutError" ? tr("No response after {0} s", timeoutMs / 1000) : String(e?.cause?.code || e?.message || e);
      throw new AssetSourceError(tr("Asset service unreachable ({0}): {1}", base, why));
    }
    try { await res.body?.cancel(); } catch { /* Finished reading */ }
    if (res.status === 404) return null;
    if (res.status >= 200 && res.status < 300) return url;
    throw new AssetSourceError(tr("Asset service refused the read ({0}, HTTP {1})", base, res.status));
  };
}

/**
 * Run ffprobe asynchronously to get text output; return null on failure or timeout.
 * Must be asynchronous: in single-process mode, the asset service is on the editor process itself;
 * a synchronous execFileSync blocks the event loop, leaving HTTP requests from ffprobe unanswered
 * and forcing it to wait until timeout.
 */
export function ffprobeText(ffprobe, args, { timeoutMs = 15_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = spawnImpl(ffprobe, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* Already exited */ } finish(null); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
  });
}

/** Whether an audio stream exists (same ffprobe parameters as hasAudioStream in original `vite-plugin-audio.ts`) */
export async function hasAudioStreamAsync(src, ffprobe) {
  const out = await ffprobeText(ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src]);
  return !!out && out.trim().length > 0;
}

/** Channel count of the first audio stream; returns 0 if none (same parameters as probeAudioChannels in `audio-measure-js.mjs`) */
export async function probeAudioChannelsAsync(src, ffprobe) {
  const out = await ffprobeText(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", src]);
  const n = parseInt(String(out ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
