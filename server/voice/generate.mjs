/**
 * Server-side body of voice_generate: fills parameters from settings, validates voice, calls
 * provider, and writes to disk in asset catalog.
 *
 * Only voices registered under "System voices" or "My voices" are permitted: if an agent casually
 * passes an unseen id that happens to be an unused new voice in the account, the first synthesis
 * deducts an extra ¥9.9.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { synthesize, VoiceError } from './providers.mjs';
import { PROVIDERS, SYSTEM_VOICES, EMOTIONS } from './presets.mjs';
import { tr } from '../i18n.mjs';

/** Whether this voice is in the allowlist */
export function voiceAllowed(cfg, provider, voiceId) {
  if ((SYSTEM_VOICES[provider] || []).some((v) => v.voiceId === voiceId)) return true;
  return cfg.customVoices.some((v) => v.provider === provider && v.voiceId === voiceId);
}

/** Fill full params for a synthesis from settings; those provided in args override settings */
export function resolveOptions(cfg, args = {}) {
  const provider = args.provider ?? cfg.provider;
  if (!PROVIDERS.includes(provider)) throw new VoiceError(tr("provider must be one of {0}", PROVIDERS.join(' / ')));
  const base = cfg[provider];
  const voiceId = args.voiceId || base.voiceId;
  if (!voiceAllowed(cfg, provider, voiceId)) {
    throw new VoiceError(`Voice ${voiceId} is not in the available list for ${provider}. Only system voices or voices registered under "Voiceover settings → My voices" can be used; the user must create new voices themselves in voiceover settings.`);
  }
  if (args.emotion !== undefined && !EMOTIONS.includes(args.emotion)) throw new VoiceError(`emotion must be ${EMOTIONS.filter(Boolean).join(' / ')}, or omitted`);
  const speedRange = provider === 'kling' ? [0.8, 2] : [0.5, 2];
  const speed = args.speed === undefined ? base.speed : Number(args.speed);
  if (!Number.isFinite(speed) || speed < speedRange[0] || speed > speedRange[1]) throw new VoiceError(`The speech rate range for ${provider} is ${speedRange[0]}~${speedRange[1]}`);
  return { ...base, provider, voiceId, speed, emotion: args.emotion ?? base.emotion, text: args.text };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Short text for filenames: keep alphanumeric only (Chinese and English), no punctuation, max 12 chars */
function slug(text) {
  return [...String(text).replace(/[^\p{L}\p{N}]+/gu, '')].slice(0, 12).join('') || 'voice';
}

/**
 * Synthesize and write into outDir. When preview is true, write to a fixed filename (overwriting
 * previous preview) without adding to media library.
 * Returns { name, path, url, bytes, provider, model, voiceId, chars, ms }.
 */
export async function generateVoice({ cfg, args, outDir, fetch, preview = false }) {
  const opts = resolveOptions(cfg, args);
  const t0 = Date.now();
  const out = await synthesize({ baseUrl: cfg.effectiveBaseUrl ?? cfg.baseUrl, apiKey: cfg.apiKey, fetch }, opts);
  fs.mkdirSync(outDir, { recursive: true });
  const name = preview
    ? `voice-preview-${opts.provider}.${out.ext}`
    : `voice-${stamp()}-${slug(args.name || opts.text)}-${randomBytes(2).toString('hex')}.${out.ext}`;
  const file = path.join(outDir, name);
  fs.writeFileSync(file, out.buf);
  return {
    name, path: file, url: `/@media/${encodeURIComponent(name)}`, bytes: out.buf.length,
    provider: out.provider, model: out.model, voiceId: out.voiceId, chars: out.chars, ms: Date.now() - t0,
  };
}
