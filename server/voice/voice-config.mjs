import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSecret, writeSecret, removeSecret, keyFilePath, apiOrigin } from '../ai-config.mjs';
import { PROVIDERS, MINIMAX_MODELS, EMOTIONS, isVoiceIdShape } from './presets.mjs';

/**
 * Voiceover settings (voice.json) + API Key used for voiceover.
 *
 * Settings share the directory with ai.json, but are **not merged into ai.json**: writeConfig in
 * ai-config merges against getDefaults(), so extra top-level sections are silently dropped. Keys
 * use the API pattern (readSecret / writeSecret in ai-config): saved to keys/voice.key with the
 * same config-crypt wrapper; it does not need to be the same as the chat API Key: different keys
 * from the same API may activate different models, and mixing them inevitably causes 401.
 *
 * Leaving API URL empty = follow API settings (protocol + host from the chat "Custom" path).
 */

function configDir() {
  if (process.env.PROMPTCUT_AI_CONFIG) return path.dirname(process.env.PROMPTCUT_AI_CONFIG);
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'promptcut');
}

export function voiceConfigPath() {
  return path.join(configDir(), 'voice.json');
}

export function voiceKeyPath() {
  return keyFilePath('voice');
}

export function voiceDefaults() {
  return {
    version: 1,
    /** Leave empty to follow API settings */
    baseUrl: '',
    provider: 'minimax',
    minimax: { model: 'speech-2.8-hd', voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, emotion: '' },
    kling: { voiceId: 'chat1_female_new-3', speed: 1 },
    vidu: { voiceId: 'female-shaonv', speed: 1, volume: 0, pitch: 0, emotion: '' },
    /** Custom or manual voices: { provider, voiceId, name, kind: "clone"|"design"|"manual", createdAt, note } */
    customVoices: [],
  };
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const str = (v, dflt = '') => (typeof v === 'string' ? v.trim() : dflt);

/** Normalize arbitrary input into valid settings: drop unknown fields, clamp out-of-bounds values */
export function normalizeVoiceConfig(raw) {
  const d = voiceDefaults();
  const r = raw && typeof raw === 'object' ? raw : {};
  const mm = { ...d.minimax, ...(r.minimax || {}) };
  const kl = { ...d.kling, ...(r.kling || {}) };
  const vd = { ...d.vidu, ...(r.vidu || {}) };
  let baseUrl = str(r.baseUrl).replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = '';
  return {
    version: 1,
    baseUrl,
    provider: PROVIDERS.includes(r.provider) ? r.provider : d.provider,
    minimax: {
      model: MINIMAX_MODELS.includes(mm.model) ? mm.model : d.minimax.model,
      voiceId: isVoiceIdShape(mm.voiceId) ? mm.voiceId : d.minimax.voiceId,
      speed: clamp(mm.speed, 0.5, 2, 1),
      vol: clamp(mm.vol, 0.1, 10, 1),
      pitch: Math.round(clamp(mm.pitch, -12, 12, 0)),
      emotion: EMOTIONS.includes(mm.emotion) ? mm.emotion : '',
    },
    kling: {
      voiceId: isVoiceIdShape(kl.voiceId) ? kl.voiceId : d.kling.voiceId,
      speed: clamp(kl.speed, 0.8, 2, 1),
    },
    vidu: {
      voiceId: isVoiceIdShape(vd.voiceId) ? vd.voiceId : d.vidu.voiceId,
      speed: clamp(vd.speed, 0.5, 2, 1),
      volume: clamp(vd.volume, 0, 10, 0),
      pitch: Math.round(clamp(vd.pitch, -12, 12, 0)),
      emotion: EMOTIONS.includes(vd.emotion) ? vd.emotion : '',
    },
    customVoices: (Array.isArray(r.customVoices) ? r.customVoices : [])
      .filter((v) => v && PROVIDERS.includes(v.provider) && isVoiceIdShape(v.voiceId))
      .map((v) => ({
        provider: v.provider,
        voiceId: v.voiceId,
        name: str(v.name).slice(0, 40) || v.voiceId,
        kind: ['clone', 'design', 'manual'].includes(v.kind) ? v.kind : 'manual',
        createdAt: str(v.createdAt),
        note: str(v.note).slice(0, 200),
      }))
      // For the same provider + voiceId, keep only the first entry
      .filter((v, i, all) => all.findIndex((x) => x.provider === v.provider && x.voiceId === v.voiceId) === i),
  };
}

/**
 * Full in-process settings: apiKey is plaintext; effectiveBaseUrl is the actual target address
 * (uses own if filled, follows API settings if empty; if both empty, errors on synthesis asking
 * the user to fill it).
 */
export function readVoiceConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(voiceConfigPath(), 'utf8')); } catch { /* Use default if not present */ }
  const cfg = normalizeVoiceConfig(raw);
  return { ...cfg, effectiveBaseUrl: cfg.baseUrl || apiOrigin(), apiKey: readSecret('voice') };
}

/**
 * Partial update. If patch.apiKey is a non-empty string, replace Key (empty string leaves it
 * untouched, clearing Key uses clearVoiceKey); other fields are merged per normalizeVoiceConfig
 * rules.
 */
export function writeVoiceConfig(patch = {}) {
  const cur = readVoiceConfig();
  const { apiKey, ...rest } = patch && typeof patch === 'object' ? patch : {};
  const merged = normalizeVoiceConfig({
    ...cur,
    ...rest,
    minimax: { ...cur.minimax, ...(rest.minimax || {}) },
    kling: { ...cur.kling, ...(rest.kling || {}) },
    vidu: { ...cur.vidu, ...(rest.vidu || {}) },
    customVoices: rest.customVoices ?? cur.customVoices,
  });
  const file = voiceConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  if (typeof apiKey === 'string' && apiKey.trim()) writeSecret('voice', apiKey.trim());
  return readVoiceConfig();
}

export function clearVoiceKey() {
  removeSecret('voice');
  return readVoiceConfig();
}

/** Add an entry to "My voices" (updates name and note if it already exists) */
export function addCustomVoice(entry) {
  const cur = readVoiceConfig();
  const list = cur.customVoices.filter((v) => !(v.provider === entry.provider && v.voiceId === entry.voiceId));
  return writeVoiceConfig({ customVoices: [{ createdAt: new Date().toISOString().slice(0, 10), ...entry }, ...list] });
}

export function removeCustomVoice(provider, voiceId) {
  const cur = readVoiceConfig();
  return writeVoiceConfig({ customVoices: cur.customVoices.filter((v) => !(v.provider === provider && v.voiceId === voiceId)) });
}

/** Version for UI and agent: only reveal the last four digits of API Key */
export function publicVoiceConfig(cfg = readVoiceConfig()) {
  const { apiKey, ...rest } = cfg;
  return { ...rest, apiKey: { set: !!apiKey, last4: apiKey ? apiKey.slice(-4) : '' } };
}
