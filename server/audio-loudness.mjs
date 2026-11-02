/**
 * `POST /api/audio/measure` 的主体(测响度 `measure_audio`)。原来写在 `vite-plugin-audio.ts` 里,搬出来是为了
 * 不依赖 vite 就能测(`server/test/audio-asset-path.test.mjs`)。回包的形状、状态码、报错文字与搬之前一致,
 * 只多了一种:素材服务不可达或拒绝读取(`AssetSourceError`)回 502 与写明原因的错。
 *
 * 素材从哪儿读由调用方注入(`resolveSource`,见 `audio-source.mjs`):素材服务上的 HTTP 地址,ffmpeg 自己按 Range 取。
 */
import { spawn } from "node:child_process";
import { measureArgs, timelineMeasureArgs, parseEbur128 } from "./audio-measure.mjs";
import { AssetSourceError, hasAudioStreamAsync } from "./audio-source.mjs";
import { tr } from "./i18n.mjs";

/**
 * @param {object} p
 * @param {any} p.body
 * @param {(media: any) => (string | null | Promise<string | null>)} p.resolveSource 素材 → ffmpeg 的输入;没有这份素材回 null;素材服务不可达抛 AssetSourceError
 * @param {string} p.ffmpeg
 * @param {string} p.ffprobe
 * @param {(src: string, ffprobe: string) => (boolean | Promise<boolean>)} [p.hasAudio]
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function measureLoudness({ body, resolveSource, ffmpeg, ffprobe, hasAudio = hasAudioStreamAsync, timeoutMs = 50000, spawnImpl = spawn }) {
  let args = [];
  const notes = [];
  let seriesRequested = !!body.series;
  try {
    if (body.scope === "media" || body.scope === "clip") {
      const file = await resolveSource(body.media);
      if (!file) return { status: 400, body: { ok: false, error: tr("Media file does not exist") } };
      if (!(await hasAudio(file, ffprobe))) return { status: 400, body: { ok: false, error: tr("This file has no audio stream") } };
      args = measureArgs({
        file,
        offset: body.scope === "clip" ? body.offset : undefined,
        duration: body.scope === "clip" ? body.duration : undefined,
      });
    } else if (body.scope === "timeline") {
      seriesRequested = true;
      const validEntries = [];
      let skipped = 0;
      const skippedNames = [];
      for (const e of body.entries) {
        const file = await resolveSource(e.media);
        if (!file || !(await hasAudio(file, ffprobe))) {
          skipped++;
          skippedNames.push(e.media?.name || e.clipId || tr("Unknown clip"));
          continue;
        }
        validEntries.push({ ...e, file });
      }
      if (skipped > 0) {
        notes.push(tr("Skipped ") + skipped + tr(" clips with no audio stream or missing file: ") + skippedNames.join(", "));
      }
      if (validEntries.length === 0) {
        return {
          status: 200,
          body: {
            ok: true,
            duration: body.duration,
            integrated: null, truePeak: null, lra: null, lraLow: null, lraHigh: null, threshold: null,
            series: [],
            ...(notes.length ? { notes } : {}),
          },
        };
      }
      args = timelineMeasureArgs(validEntries, Number(body.duration) > 0 ? Number(body.duration) : undefined);
    } else {
      return { status: 400, body: { ok: false, error: tr("Invalid scope") } };
    }
  } catch (e) {
    if (e instanceof AssetSourceError) return { status: 502, body: { ok: false, error: e.message } };
    throw e;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const done = (status, b) => { if (!settled) { settled = true; resolve({ status, body: b }); } };
    const child = spawnImpl(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done(500, { ok: false, error: tr("Failed to start ffmpeg: ") + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return done(500, { ok: false, error: tr("Analysis timed out") });
      if (code !== 0 && !stderr.includes("Parsed_ebur128")) {
        return done(500, { ok: false, error: tr("ffmpeg failed to run: ") + stderr.slice(-300) });
      }
      try {
        const parsed = parseEbur128(stderr);
        if (!seriesRequested) delete parsed.series;
        if (notes.length > 0) parsed.notes = (parsed.notes || []).concat(notes);
        done(200, { ok: true, ...parsed });
      } catch (err) {
        done(500, { ok: false, error: tr("Failed to parse output: ") + String(err) });
      }
    });
  });
}
