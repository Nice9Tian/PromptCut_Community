/**
 * Three cloud voice synthesis providers + MiniMax voice design / clone. All go through the same
 * API (endpoint and API Key in voiceover settings), with Bearer authentication.
 *
 * Pure logic: does not touch disk, does not read settings; fetch can be injected (mocked for
 * testing).
 *
 * Billing key points (MiniMax pay-as-you-go page): voice design and fast clone are ¥9.9 each,
 * **deducted only on first synthesis with this voice**, so the voice_clone / voice_design step
 * itself shows ¥0, and the first t2a incurs an extra charge. Cloned voices not called formally
 * within 7 days are deleted by the system.
 */
import { TEXT_LIMITS, isCloneIdShape } from './presets.mjs';
import { tr } from '../i18n.mjs';

const TIMEOUT_MS = 45_000;

export class VoiceError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** Translate API errors into plain language. Exhausted quota is most common, explain it separately */
function apiError(status, text) {
  const quotaGone = /quota exhausted|quota|额度/i.test(text); // i18n-allow: the provider's reply may be Chinese
  if (quotaGone) return new VoiceError(tr("The API key has run out of quota (API returned 401). Top up in the API console and try again."), { status, detail: text });
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
 * Synthesize a voice clip. opts is already the complete parameters merged with default values:
 *   { provider, text, voiceId, model?, speed?, vol?, pitch?, emotion?, volume? }
 * Returns { buf, ext, provider, model, voiceId, chars }.
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

  // vidu: API parameters are all strings
  const body = { text, voice_setting_voice_id: opts.voiceId, voice_setting_speed: String(opts.speed ?? 1) };
  if (opts.volume) body.voice_setting_volume = String(opts.volume);
  if (opts.pitch) body.voice_setting_pitch = String(opts.pitch);
  if (opts.emotion) body.voice_setting_emotion = opts.emotion;
  const j = await call(ctx, 'POST', '/ent/v2/audio-tts', body);
  if (j?.state !== 'success' || !j?.file_url) throw new VoiceError(tr("Vidu synthesis failed: {0}", j?.err_code || j?.message || JSON.stringify(j).slice(0, 200)));
  return { buf: await download(ctx, j.file_url), ext: 'mp3', provider: 'vidu', model: 'vidu-tts', voiceId: opts.voiceId, chars: [...text].length };
}

/** MiniMax voice design: prompt → new voice id + preview (preview billed by chars, voice fee on 1st synthesis) */
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
 * MiniMax fast clone: first upload audio with purpose=voice_clone (mp3/m4a/wav, 10s~5 min, <20MB),
 * then create the voice with the resulting file_id. voiceId is a custom name (see isCloneIdShape).
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
