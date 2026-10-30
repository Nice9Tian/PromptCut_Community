import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSecret, writeSecret, removeSecret, keyFilePath, apiOrigin } from '../ai-config.mjs';
import { PROVIDERS, MINIMAX_MODELS, EMOTIONS, isVoiceIdShape } from './presets.mjs';

/**
 * 配音设置(voice.json)+ 配音用的 API Key。
 *
 * 设置和 ai.json 同目录,但**不并进 ai.json**:ai-config 的 writeConfig 按 getDefaults() 合并,
 * 顶层多一节会被悄悄丢掉。Key 走 API 那一套(ai-config 的 readSecret / writeSecret):
 * 落在 keys/voice.key,同样的 config-crypt 封装;它和对话 API 的 Key 可以不是同一把 ——
 * 同一家 API 下不同的 Key 开通的模型不一样,混用必然 401。
 *
 * API 地址留空 = 跟随 API 设置(对话「自定义」那一路的协议 + 主机)。
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
    /** 留空跟随 API 设置 */
    baseUrl: '',
    provider: 'minimax',
    minimax: { model: 'speech-2.8-hd', voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, emotion: '' },
    kling: { voiceId: 'chat1_female_new-3', speed: 1 },
    vidu: { voiceId: 'female-shaonv', speed: 1, volume: 0, pitch: 0, emotion: '' },
    /** 自己建的或手填的音色:{ provider, voiceId, name, kind: "clone"|"design"|"manual", createdAt, note } */
    customVoices: [],
  };
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const str = (v, dflt = '') => (typeof v === 'string' ? v.trim() : dflt);

/** 把任意输入整理成合法的设置;不认识的字段丢掉,越界的数值夹回范围 */
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
      // 同一个 provider + voiceId 只留第一条
      .filter((v, i, all) => all.findIndex((x) => x.provider === v.provider && x.voiceId === v.voiceId) === i),
  };
}

/**
 * 进程内用的完整设置:apiKey 是明文;effectiveBaseUrl 是实际要打的地址
 * (自己填了用自己的,没填跟随 API 设置,两边都没有就是空串,合成时会报错让人去填)。
 */
export function readVoiceConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(voiceConfigPath(), 'utf8')); } catch { /* 没有就用默认 */ }
  const cfg = normalizeVoiceConfig(raw);
  return { ...cfg, effectiveBaseUrl: cfg.baseUrl || apiOrigin(), apiKey: readSecret('voice') };
}

/**
 * 局部更新。patch.apiKey 给了非空字符串就换 Key(空串不动,清 Key 走 clearVoiceKey);
 * 其余字段按 normalizeVoiceConfig 的规矩合并。
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

/** 往「我的音色」里加一条(已存在就更新名字和备注) */
export function addCustomVoice(entry) {
  const cur = readVoiceConfig();
  const list = cur.customVoices.filter((v) => !(v.provider === entry.provider && v.voiceId === entry.voiceId));
  return writeVoiceConfig({ customVoices: [{ createdAt: new Date().toISOString().slice(0, 10), ...entry }, ...list] });
}

export function removeCustomVoice(provider, voiceId) {
  const cur = readVoiceConfig();
  return writeVoiceConfig({ customVoices: cur.customVoices.filter((v) => !(v.provider === provider && v.voiceId === voiceId)) });
}

/** 给界面和 agent 看的版本:API Key 只露后四位 */
export function publicVoiceConfig(cfg = readVoiceConfig()) {
  const { apiKey, ...rest } = cfg;
  return { ...rest, apiKey: { set: !!apiKey, last4: apiKey ? apiKey.slice(-4) : '' } };
}
