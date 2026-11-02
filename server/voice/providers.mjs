/**
 * 三家云端语音合成 + MiniMax 的音色设计 / 复刻。全部走同一个 API(配音设置里的地址和 API Key),Bearer 鉴权。
 *
 * 纯逻辑:不碰磁盘、不读设置,fetch 可以注入(测试用假的)。
 *
 * 计费要点(MiniMax 按量计费页):音色设计、快速复刻各 ¥9.9 一个,**首次用这个音色合成时才扣**,
 * 所以 voice_clone / voice_design 那一步本身显示 0 元,第一次 t2a 会多出一笔。
 * 复刻出来的音色 7 天内没被正式调用会被系统删除。
 */
import { TEXT_LIMITS, isCloneIdShape } from './presets.mjs';
import { tr } from "../i18n.mjs";

const TIMEOUT_MS = 45_000;

export class VoiceError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** API 报错翻成人话。额度用完是最常见的,单独说清楚 */
function apiError(status, text) {
  const quotaGone = /quota exhausted|quota|额度/i.test(text); // i18n-allow: the provider's reply may be Chinese
  if (quotaGone) return new VoiceError('API Key 的额度用完了（API 返回 401）。去 API 后台充值后再试。', { status, detail: text });
  if (status === 401 || status === 403) return new VoiceError(tr("The API key is invalid or does not have access to this model (HTTP {0}). Check the API key in \"Voiceover settings\".", status), { status, detail: text });
  if (status === 429) return new VoiceError(tr("Too many requests, rate limited (HTTP 429). Wait a minute or two and try again."), { status, detail: text });
  return new VoiceError(tr("API returned HTTP {0}: {1}", status, text.slice(0, 200)), { status, detail: text });
}

async function call(ctx, method, urlPath, body, { raw = false } = {}) {
  const { baseUrl, apiKey, fetch: f = globalThis.fetch } = ctx;
  if (!apiKey) throw new VoiceError(tr("No API key for voiceover yet. Enter it in \"Voiceover settings\" (open it from the voiceover card on the start page or the editor top bar)."));
  if (!baseUrl) throw new VoiceError(tr("No API address. Enter it in \"Voiceover settings\", or first set the custom API address in the API settings."));
  const headers = { Authorization: `Bearer ${apiKey}` };
  let payload = body;
  if (body && !raw) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await f(`${baseUrl}${urlPath}`, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new VoiceError(tr("Cannot connect to API address {0}: {1}", baseUrl, e?.message || e));
  }
  const text = await res.text();
  if (!res.ok) throw apiError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new VoiceError(tr("API did not return JSON: {0}", text.slice(0, 200)));
  }
}

async function download(ctx, url) {
  const f = ctx.fetch || globalThis.fetch;
  const res = await f(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new VoiceError(tr("Audio file download failed (HTTP {0})", res.status));
  return Buffer.from(await res.arrayBuffer());
}

function minimaxOk(j, what) {
  const code = j?.base_resp?.status_code;
  if (code !== 0) throw new VoiceError(tr("MiniMax {0} failed: {1} ({2})", what, j?.base_resp?.status_msg || JSON.stringify(j).slice(0, 200), code));
}

/**
 * 合成一段语音。opts 已经是合并好默认值的完整参数:
 *   { provider, text, voiceId, model?, speed?, vol?, pitch?, emotion?, volume? }
 * 返回 { buf, ext, provider, model, voiceId, chars }。
 */
export async function synthesize(ctx, opts) {
  const text = String(opts.text ?? '').trim();
  if (!text) throw new VoiceError(tr("The text to voice is empty."));
  const limit = TEXT_LIMITS[opts.provider];
  if (!limit) throw new VoiceError(tr("Unknown voiceover service: {0} (only minimax / kling / vidu)", opts.provider));
  if ([...text].length > limit) throw new VoiceError(tr("Text too long ({0} chars). {1} allows at most {2} chars per request; split it into several parts and voice them separately.", [...text].length, opts.provider, limit));

  if (opts.provider === 'minimax') {
    const voice_setting = { voice_id: opts.voiceId, speed: opts.speed ?? 1, vol: opts.vol ?? 1, pitch: opts.pitch ?? 0 };
    if (opts.emotion) voice_setting.emotion = opts.emotion;
    const j = await call(ctx, 'POST', '/minimax/v1/t2a_v2', {
      model: opts.model || 'speech-2.8-hd',
      text,
      stream: false,
      voice_setting,
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      output_format: 'hex',
    });
    minimaxOk(j, tr("synthesis"));
    if (!j?.data?.audio) throw new VoiceError(tr("MiniMax returned no audio."));
    return { buf: Buffer.from(j.data.audio, 'hex'), ext: 'mp3', provider: 'minimax', model: opts.model || 'speech-2.8-hd', voiceId: opts.voiceId, chars: j.extra_info?.usage_characters ?? [...text].length };
  }

  if (opts.provider === 'kling') {
    const j = await call(ctx, 'POST', '/kling/v1/audio/tts', {
      text, voice_id: opts.voiceId, voice_language: 'zh', voice_speed: opts.speed ?? 1,
    });
    const url = j?.data?.task_result?.audios?.[0]?.url;
    if (j?.code !== 0 || !url) throw new VoiceError(tr("Kling synthesis failed: {0}. Kling only accepts official voice ids.", j?.message || JSON.stringify(j).slice(0, 200)));
    return { buf: await download(ctx, url), ext: 'mp3', provider: 'kling', model: 'kling-audio', voiceId: opts.voiceId, chars: [...text].length };
  }

  // vidu:接口参数全是字符串
  const body = { text, voice_setting_voice_id: opts.voiceId, voice_setting_speed: String(opts.speed ?? 1) };
  if (opts.volume) body.voice_setting_volume = String(opts.volume);
  if (opts.pitch) body.voice_setting_pitch = String(opts.pitch);
  if (opts.emotion) body.voice_setting_emotion = opts.emotion;
  const j = await call(ctx, 'POST', '/ent/v2/audio-tts', body);
  if (j?.state !== 'success' || !j?.file_url) throw new VoiceError(tr("Vidu synthesis failed: {0}", j?.err_code || j?.message || JSON.stringify(j).slice(0, 200)));
  return { buf: await download(ctx, j.file_url), ext: 'mp3', provider: 'vidu', model: 'vidu-tts', voiceId: opts.voiceId, chars: [...text].length };
}

/** MiniMax 音色设计:一句话描述 → 新音色 id + 一段试听(试听按字数计费,音色费首次合成时扣) */
export async function designVoice(ctx, { prompt, previewText }) {
  const p = String(prompt ?? '').trim();
  const t = String(previewText ?? '').trim();
  if (!p) throw new VoiceError(tr("Enter a voice description, for example \"young male voice, film narration style, fairly fast pace\"."));
  if (!t) throw new VoiceError(tr("Provide a preview text."));
  const j = await call(ctx, 'POST', '/minimax/v1/voice_design', { prompt: p, preview_text: t, aigc_watermark: false });
  minimaxOk(j, tr("voice design"));
  if (!j.voice_id) throw new VoiceError(tr("Voice design returned no voice_id."));
  return { voiceId: j.voice_id, trial: j.trial_audio ? Buffer.from(j.trial_audio, 'hex') : null };
}

/**
 * MiniMax 快速复刻:先按 purpose=voice_clone 上传音频(mp3/m4a/wav,10 秒~5 分钟,<20MB),
 * 再用拿到的 file_id 建音色。voiceId 是自己起的名字(见 isCloneIdShape)。
 */
export async function cloneVoice(ctx, { audio, filename, voiceId, previewText, model = 'speech-2.8-hd' }) {
  if (!isCloneIdShape(voiceId)) throw new VoiceError(tr("Voice id must be 8~256 characters, start with a letter, contain only letters, digits, - and _, and must not end with - or _."));
  if (!audio?.length) throw new VoiceError(tr("No audio to clone was received."));
  if (audio.length > 20 * 1024 * 1024) throw new VoiceError(tr("The audio for cloning must be smaller than 20MB."));

  const form = new FormData();
  form.append('purpose', 'voice_clone');
  form.append('file', new Blob([audio]), filename || 'voice.wav');
  const up = await call(ctx, 'POST', '/minimax/v1/files', form, { raw: true });
  minimaxOk(up, tr("clone audio upload"));
  const fileId = up?.file?.file_id;
  if (!fileId) throw new VoiceError(tr("No file_id was received after uploading the clone audio."));

  const body = {
    file_id: fileId, voice_id: voiceId, model,
    need_noise_reduction: true, need_volume_normalization: true, aigc_watermark: false,
  };
  const t = String(previewText ?? '').trim();
  if (t) body.text = t;
  const j = await call(ctx, 'POST', '/minimax/v1/voice_clone', body);
  minimaxOk(j, 'clone');
  let demo = null;
  if (typeof j.demo_audio === 'string' && j.demo_audio) {
    demo = /^https?:/i.test(j.demo_audio) ? await download(ctx, j.demo_audio) : Buffer.from(j.demo_audio, 'hex');
  }
  return { voiceId, demo };
}
