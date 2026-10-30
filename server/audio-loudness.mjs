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
      if (!file) return { status: 400, body: { ok: false, error: "素材文件不存在" } };
      if (!(await hasAudio(file, ffprobe))) return { status: 400, body: { ok: false, error: "该文件没有音频流" } };
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
          skippedNames.push(e.media?.name || e.clipId || "未知片段");
          continue;
        }
        validEntries.push({ ...e, file });
      }
      if (skipped > 0) {
        notes.push("有 " + skipped + " 段没有音频流或文件不存在，已跳过：" + skippedNames.join("、"));
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
      return { status: 400, body: { ok: false, error: "无效的 scope" } };
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
      done(500, { ok: false, error: "启动 ffmpeg 失败: " + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return done(500, { ok: false, error: "分析超时" });
      if (code !== 0 && !stderr.includes("Parsed_ebur128")) {
        return done(500, { ok: false, error: "ffmpeg 运行失败: " + stderr.slice(-300) });
      }
      try {
        const parsed = parseEbur128(stderr);
        if (!seriesRequested) delete parsed.series;
        if (notes.length > 0) parsed.notes = (parsed.notes || []).concat(notes);
        done(200, { ok: true, ...parsed });
      } catch (err) {
        done(500, { ok: false, error: "解析输出失败: " + String(err) });
      }
    });
  });
}
