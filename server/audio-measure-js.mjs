/**
 * Main body of `POST /api/audio/measure-js` (custom measurement `measure_audio_js`, plan
 * `docs/plan/agent-workflow-plan.md` A6): finds asset on the asset service by "target to measure" →
 * ffmpeg decodes into PCM (`audio-pcm.mjs`) → hands over to sandbox to run Agent-written JS
 * (`audio-sandbox.mjs`) → returns JSON only.
 *
 * Does not depend on vite: where to read assets (`resolveSource`, same resolver as `measure_audio`:
 * an HTTP URL on the asset service, see `audio-source.mjs`), where ffmpeg is, and sandbox are all
 * injected by caller; `server/test/custom-measure.test.mjs` and `audio-asset-path.test.mjs` test it
 * directly. Returns `kind: 'asset-service'` when asset service is unreachable or refuses to read.
 *
 * body (assembled by `measureAudioJs` in `src/mcp/common.ts`):
 *   { scope: 'clip'|'media'|'timeline', media?, offset?, duration?, entries?, total?,
 *     start?, length?, sampleRate?, mono?, code, timeoutMs?, meta? }
 * clip / media are the same as `measure_audio`; timeline's entries is the same as
 * `timelineMeasureArgs`, total is the timeline duration; start / length is the sub-window (in
 * seconds) sliced within this audio.
 */
import { execFileSync } from "node:child_process";
import { AssetSourceError, probeAudioChannelsAsync } from "./audio-source.mjs";
import { PCM_LIMITS, pcmFormat, sampleBudgetError, windowOf, filePcmArgs, timelinePcmArgs, decodePcm } from "./audio-pcm.mjs";
import { tr } from "./i18n.mjs";

/**
 * Channel count of the first audio stream; returns 0 if there are no audio streams. Synchronous
 * version, for unit tests and local files only; measurements use `probeAudioChannelsAsync`
 * (synchronous calls block the event loop when input is an HTTP URL).
 */
export function probeAudioChannels(file, ffprobe) {
  try {
    const out = execFileSync(
      ffprobe,
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * @param {object} p
 * @param {object} p.body
 * @param {(media: any) => (string | null | Promise<string | null>)} [p.resolveSource] Asset → ffmpeg
 *   input (HTTP address on asset service); returns null if asset is missing; throws
 *   `AssetSourceError` if asset service is unreachable
 * @param {(media: any) => string | null} [p.resolveFile] Old name, same as resolveSource
 *   (used for local files in unit tests)
 * @param {string} p.ffmpeg
 * @param {string} p.ffprobe
 * @param {{ run: Function }} p.sandbox
 * @param {typeof PCM_LIMITS} [p.pcmLimits]
 * @param {(src: string, ffprobe: string) => (number | Promise<number>)} [p.probeChannels]
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function measureJs({ body, resolveSource, resolveFile, ffmpeg, ffprobe, sandbox, pcmLimits = PCM_LIMITS, probeChannels = probeAudioChannelsAsync, spawnImpl, signal }) {
  const resolve = resolveSource ?? resolveFile;
  try {
    return await measureJsInner({ body, resolve, ffmpeg, ffprobe, sandbox, pcmLimits, probeChannels, spawnImpl, signal });
  } catch (e) {
    if (e instanceof AssetSourceError) return { status: 200, body: { ok: false, kind: "asset-service", error: e.message } };
    throw e;
  }
}

async function measureJsInner({ body, resolve, ffmpeg, ffprobe, sandbox, pcmLimits, probeChannels, spawnImpl, signal }) {
  const bad = (error, kind = "invalid") => ({ status: 200, body: { ok: false, kind, error } });
  if (!body || typeof body !== "object") return bad(tr("Invalid request body"));
  const code = body.code;
  if (typeof code !== "string" || !code.trim()) return bad(tr("code is empty: write a function body that receives input (channels, sampleRate, duration, ...) and returns the result with return"));
  const { sampleRate, mono } = pcmFormat(body, pcmLimits);
  const notes = [];

  let args;
  let channels;
  let expected;
  let source;
  if (body.scope === "clip" || body.scope === "media") {
    const file = await resolve(body.media);
    if (!file) return bad(tr("Media file does not exist"), "no-media");
    const n = await probeChannels(file, ffprobe);
    if (!n) return bad(tr("This file has no audio stream"), "no-audio");
    channels = mono ? 1 : Math.min(pcmLimits.maxChannels, n);
    if (!mono && n > pcmLimits.maxChannels) notes.push(tr("Source has {0} channels, mixed down to stereo", n));
    let win;
    try {
      win = windowOf({
        baseOffset: body.scope === "clip" ? num(body.offset) ?? 0 : 0,
        baseDuration: body.scope === "clip" ? num(body.duration) : undefined,
        start: body.start, duration: body.length,
      });
    } catch (e) { return bad(e.message); }
    expected = win.duration;
    args = filePcmArgs({ file, offset: win.offset, duration: win.duration, sampleRate, channels, sourceChannels: n });
    source = { scope: body.scope, start: win.offset, ...(win.duration !== undefined ? { requestedDuration: +win.duration.toFixed(3) } : null) };
  } else if (body.scope === "timeline") {
    const entries = [];
    const skipped = [];
    let monoSources = 0;
    for (const e of Array.isArray(body.entries) ? body.entries : []) {
      const file = await resolve(e?.media);
      const n = file ? await probeChannels(file, ffprobe) : 0;
      if (!n) { skipped.push(e?.media?.name || e?.clipId || tr("Unknown clip")); continue; }
      if (n === 1) monoSources += 1;
      entries.push({ ...e, file });
    }
    if (skipped.length) notes.push(tr("Skipped {0} clips with no audio stream or missing file: {1}", skipped.length, skipped.join(", ")));
    if (!entries.length) return bad(tr("No decodable audio on the timeline"), "no-audio");
    channels = mono ? 1 : 2;
    // Consistent with export (server/bakery/audio-mix.mjs -ac 2 per clip): mono asset spread to
    // stereo is 3 dB lower per channel
    if (monoSources) notes.push(tr("The mix is stereo, as in export: {0} mono media clips are spread across both channels, each 3 dB lower (ffmpeg's default center mix coefficient)", monoSources));
    const total = num(body.total) > 0 ? num(body.total) : undefined;
    let win;
    try { win = windowOf({ baseOffset: 0, baseDuration: total, start: body.start, duration: body.length }); } catch (e) { return bad(e.message); }
    expected = win.duration;
    args = timelinePcmArgs(entries, { total, offset: win.offset, duration: win.duration, sampleRate, channels });
    source = { scope: "timeline", start: win.offset, ...(win.duration !== undefined ? { requestedDuration: +win.duration.toFixed(3) } : null) };
  } else {
    return bad(tr("Invalid scope"));
  }

  const over = sampleBudgetError({ duration: expected, sampleRate, channels }, pcmLimits);
  if (over) return bad(over, "too-many-samples");

  let pcm;
  try {
    pcm = await decodePcm(ffmpeg, args, { channels, sampleRate, limits: pcmLimits, ...(spawnImpl ? { spawnImpl } : null) });
  } catch (e) {
    return bad(String(e?.message || e), "decode");
  }
  const frames = pcm[0]?.length ?? 0;
  if (!frames) return bad(tr("Decoded output is empty (this segment has no audio samples)"), "no-audio");
  const duration = +(frames / sampleRate).toFixed(6);

  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  const r = await sandbox.run({ code, channels: pcm, sampleRate, duration, meta: { ...meta, scope: source.scope, start: source.start }, timeoutMs: body.timeoutMs, signal });
  const input = { sampleRate, numberOfChannels: channels, frames, duration, ...source };
  if (!r.ok) {
    return {
      status: 200,
      body: {
        ok: false,
        kind: r.kind,
        error: r.error,
        ...(Number.isInteger(r.line) ? { line: r.line, column: r.column } : null),
        input,
        ...(r.blockedRequests ? { blockedRequests: r.blockedRequests } : null),
        ...(notes.length ? { notes } : null),
      },
    };
  }
  return { status: 200, body: { ok: true, value: r.value, elapsedMs: r.elapsedMs, input, ...(r.blockedRequests ? { blockedRequests: r.blockedRequests } : null), ...(notes.length ? { notes } : null) } };
}
