/**
 * `POST /api/audio/measure-js` 的主体(自定义测量 `measure_audio_js`,计划 `docs/plan/agent-workflow-plan.md` A6):
 * 按「测谁」在素材服务上找到素材 → ffmpeg 解成 PCM(`audio-pcm.mjs`)→ 交沙箱跑 Agent 写的 JS(`audio-sandbox.mjs`)→ 只回 JSON。
 *
 * 不依赖 vite:素材从哪儿读(`resolveSource`,和 `measure_audio` 同一个解析器:素材服务上的 HTTP 地址,见 `audio-source.mjs`)、
 * ffmpeg 在哪、沙箱,都由调用方注入,`server/test/custom-measure.test.mjs`、`audio-asset-path.test.mjs` 直接测它。
 * 素材服务不可达或拒绝读取时回 `kind: 'asset-service'`。
 *
 * body(由 `src/mcp/common.ts` 的 `measureAudioJs` 拼):
 *   { scope: 'clip'|'media'|'timeline', media?, offset?, duration?, entries?, total?,
 *     start?, length?, sampleRate?, mono?, code, timeoutMs?, meta? }
 * clip / media 与 `measure_audio` 相同;timeline 的 entries 同 `timelineMeasureArgs`,total 是时间轴时长;
 * start / length 是在这段声音里再截的窗口(秒)。
 */
import { execFileSync } from "node:child_process";
import { AssetSourceError, probeAudioChannelsAsync } from "./audio-source.mjs";
import { PCM_LIMITS, pcmFormat, sampleBudgetError, windowOf, filePcmArgs, timelinePcmArgs, decodePcm } from "./audio-pcm.mjs";

/** 第一条音频流的声道数;没有音频流回 0。同步版,只给单测和本地文件用;测量走 `probeAudioChannelsAsync`(输入是 HTTP 地址时同步会卡住事件循环) */
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
 * @param {(media: any) => (string | null | Promise<string | null>)} [p.resolveSource] 素材 → ffmpeg 的输入(素材服务上的 HTTP 地址);
 *   没有这份素材回 null;素材服务不可达抛 `AssetSourceError`
 * @param {(media: any) => string | null} [p.resolveFile] 旧名,同 resolveSource(单测给本地文件用)
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
  if (!body || typeof body !== "object") return bad("请求体不对");
  const code = body.code;
  if (typeof code !== "string" || !code.trim()) return bad("code 是空的:写一个函数体,收到 input(channels、sampleRate、duration……),用 return 返回结果");
  const { sampleRate, mono } = pcmFormat(body, pcmLimits);
  const notes = [];

  let args;
  let channels;
  let expected;
  let source;
  if (body.scope === "clip" || body.scope === "media") {
    const file = await resolve(body.media);
    if (!file) return bad("素材文件不存在", "no-media");
    const n = await probeChannels(file, ffprobe);
    if (!n) return bad("该文件没有音频流", "no-audio");
    channels = mono ? 1 : Math.min(pcmLimits.maxChannels, n);
    if (!mono && n > pcmLimits.maxChannels) notes.push(`源有 ${n} 个声道,混成了立体声`);
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
      if (!n) { skipped.push(e?.media?.name || e?.clipId || "未知片段"); continue; }
      if (n === 1) monoSources += 1;
      entries.push({ ...e, file });
    }
    if (skipped.length) notes.push(`有 ${skipped.length} 段没有音频流或文件不存在,已跳过:${skipped.join("、")}`);
    if (!entries.length) return bad("时间轴上没有能解码的声音", "no-audio");
    channels = mono ? 1 : 2;
    // 与导出一致(server/bakery/audio-mix.mjs 每段 -ac 2):单声道素材摊到立体声时每路低 3 dB
    if (monoSources) notes.push(`混音按导出的做法是立体声:${monoSources} 段单声道素材摊到两个声道,每路低 3 dB(ffmpeg 缺省的中置混音系数)`);
    const total = num(body.total) > 0 ? num(body.total) : undefined;
    let win;
    try { win = windowOf({ baseOffset: 0, baseDuration: total, start: body.start, duration: body.length }); } catch (e) { return bad(e.message); }
    expected = win.duration;
    args = timelinePcmArgs(entries, { total, offset: win.offset, duration: win.duration, sampleRate, channels });
    source = { scope: "timeline", start: win.offset, ...(win.duration !== undefined ? { requestedDuration: +win.duration.toFixed(3) } : null) };
  } else {
    return bad("无效的 scope");
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
  if (!frames) return bad("解码出来是空的(这一段没有声音样本)", "no-audio");
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
