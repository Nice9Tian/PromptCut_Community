/**
 * voice_generate 的服务端主体:按设置补齐参数、校验音色、调服务商、落盘到素材目录。
 *
 * 音色只许用「系统音色」或「我的音色」里登记过的 —— agent 随手传一个没见过的 id,
 * 万一恰好是账号里一个没用过的新音色,第一次合成就会多扣 ¥9.9。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { synthesize, VoiceError } from './providers.mjs';
import { PROVIDERS, SYSTEM_VOICES, EMOTIONS } from './presets.mjs';

/** 这个音色在不在允许列表里 */
export function voiceAllowed(cfg, provider, voiceId) {
  if ((SYSTEM_VOICES[provider] || []).some((v) => v.voiceId === voiceId)) return true;
  return cfg.customVoices.some((v) => v.provider === provider && v.voiceId === voiceId);
}

/** 按设置补齐一次合成的完整参数;args 里给了的覆盖设置里的 */
export function resolveOptions(cfg, args = {}) {
  const provider = args.provider ?? cfg.provider;
  if (!PROVIDERS.includes(provider)) throw new VoiceError(`provider 只能是 ${PROVIDERS.join(' / ')}`);
  const base = cfg[provider];
  const voiceId = args.voiceId || base.voiceId;
  if (!voiceAllowed(cfg, provider, voiceId)) {
    throw new VoiceError(`音色 ${voiceId} 不在 ${provider} 的可用列表里。只能用系统音色或「配音设置 → 我的音色」里登记过的；新音色要用户自己在配音设置里建。`);
  }
  if (args.emotion !== undefined && !EMOTIONS.includes(args.emotion)) throw new VoiceError(`emotion 只能是 ${EMOTIONS.filter(Boolean).join(' / ')}，或不传`);
  const speedRange = provider === 'kling' ? [0.8, 2] : [0.5, 2];
  const speed = args.speed === undefined ? base.speed : Number(args.speed);
  if (!Number.isFinite(speed) || speed < speedRange[0] || speed > speedRange[1]) throw new VoiceError(`${provider} 的语速范围是 ${speedRange[0]}~${speedRange[1]}`);
  return { ...base, provider, voiceId, speed, emotion: args.emotion ?? base.emotion, text: args.text };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 文件名里用得上的一小段文字:只留字母和数字(中英文都算),标点一律去掉,最多 12 个字 */
function slug(text) {
  return [...String(text).replace(/[^\p{L}\p{N}]+/gu, '')].slice(0, 12).join('') || 'voice';
}

/**
 * 合成并写进 outDir。preview 为真时写固定文件名(覆盖上一次试听),不进素材库。
 * 返回 { name, path, url, bytes, provider, model, voiceId, chars, ms }。
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
