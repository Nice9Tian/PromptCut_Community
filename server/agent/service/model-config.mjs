/**
 * 托管档的模型配置(契约 `docs/plan/cloud-agent-contract.md` 第 8 节)。
 *
 *   <数据目录>/config/ai.json           厂商、接口地址、模型清单(`a|b|c`)、maxTokens(单次输出上限的上限;0 或不写 = 按模型),0600
 *   <数据目录>/config/keys/custom.key   模型 Key 的密文(`server/runners/config-crypt.mjs` 的 PCENC1 封装),0600
 *
 * 路径只由数据目录定,不读 `PROMPTCUT_AI_CONFIG`、不读这台机器上用户自己的 `ai.json`——同一台机器上装着桌面版时两边互不相干。
 * Key 的明文只在调用方的内存里;本文件不打印它、不把它写进任何别的文件。每一轮开始时现读,所以录入或换 Key 之后不用重启服务。
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openKey, sealKey, sealedKind } from '../../runners/config-crypt.mjs';
export const RUN_EFFORTS = Object.freeze(['low', 'medium', 'high']);
export const RUN_CREATIVITY = Object.freeze(['low', 'medium', 'high']);
const RUN_OPTION_KEYS = ['model', 'effort', 'creativity'];
export const RUN_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function defaultNormalizeRunOptions(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !RUN_OPTION_KEYS.includes(key))) return undefined;
  const out = {};
  for (const key of RUN_OPTION_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    const ok = key === 'model' ? typeof value === 'string' && RUN_MODEL_ID_RE.test(value)
      : key === 'effort' ? RUN_EFFORTS.includes(value) : RUN_CREATIVITY.includes(value);
    if (!ok) return undefined;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

let customRunOptionsPolicy = null;
export function registerRunOptionsPolicy(fn) {
  customRunOptionsPolicy = typeof fn === 'function' ? fn : null;
}

export function normalizeRunOptions(raw) {
  return customRunOptionsPolicy ? customRunOptionsPolicy(raw) : defaultNormalizeRunOptions(raw);
}

export const MODEL_VENDORS = Object.freeze(['anthropic', 'openai', 'gemini', 'mock']);

export function modelConfigPaths(dataDir) {
  const dir = path.join(dataDir, 'config');
  return { dir, file: path.join(dir, 'ai.json'), keyFile: path.join(dir, 'keys', 'custom.key') };
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 上基本是空操作 */ }
  fs.renameSync(tmp, file);
}

/**
 * 读出这一轮用的模型配置。没有配置文件回 `{}`;Key 文件没有或解不开时 `apiKey` 是空串。
 * @returns {{ vendor?: string, baseUrl?: string, model?: string, maxTokens?: number, apiKey?: string }}
 */
export function readModelConfig(dataDir) {
  const { file, keyFile } = modelConfigPaths(dataDir);
  let api = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    api = parsed && typeof parsed === 'object' && parsed.api && typeof parsed.api === 'object' ? parsed.api : null;
  } catch {
    return {};
  }
  if (!api || !MODEL_VENDORS.includes(api.vendor)) return {};
  let apiKey = '';
  if (api.vendor !== 'mock') {
    try {
      const sealed = fs.readFileSync(keyFile, 'utf8').trim();
      if (sealedKind(sealed) === 'custom') apiKey = openKey(sealed, 'custom') || '';
    } catch { /* 还没录入 */ }
  }
  return {
    vendor: api.vendor,
    baseUrl: typeof api.baseUrl === 'string' ? api.baseUrl : '',
    model: typeof api.model === 'string' ? api.model : '',
    // 0 = 没配,单次输出上限按模型定(harness/model-limits.mjs,A07 2026-10-22);配了就是上限的上限
    maxTokens: Number.isSafeInteger(api.maxTokens) && api.maxTokens > 0 ? api.maxTokens : 0,
    apiKey,
  };
}

/** 写配置;`key` 给了(非空字符串)就封装后写进 Key 文件,`null` 表示不动 Key 文件 */
export function writeModelConfig(dataDir, { vendor, baseUrl = '', model = '', maxTokens = 0 }, key = null) {
  if (!MODEL_VENDORS.includes(vendor)) throw new Error(`厂商只能是 ${MODEL_VENDORS.join(' / ')}`);
  const { file, keyFile } = modelConfigPaths(dataDir);
  if (typeof key === 'string' && key) writePrivate(keyFile, `${sealKey(key, 'custom')}\n`);
  writePrivate(file, `${JSON.stringify({ v: 1, api: { vendor, baseUrl: String(baseUrl || ''), model: String(model || ''), maxTokens } }, null, 2)}\n`);
}

/** 删掉 Key 文件(配置留着) */
export function clearModelKey(dataDir) {
  try { fs.rmSync(modelConfigPaths(dataDir).keyFile, { force: true }); } catch { /* 本来就没有 */ }
}

/** 模型清单(`a|b|c` 拆开) */
export function modelListOf(cfg) {
  return String(cfg?.model || '').split('|').map((s) => s.trim()).filter(Boolean);
}

/** 这一轮实际会用哪个模型(与 `server/runners/api.mjs` 的挑法相同:请求点名且在清单里就用它,否则清单第一个) */
export function pickModel(cfg, asked) {
  const list = modelListOf(cfg);
  return typeof asked === 'string' && list.includes(asked) ? asked : (list[0] || '');
}

/** 能不能起一轮:模拟提供方不要 Key,别的要 */
export function modelReady(cfg) {
  if (!cfg || !MODEL_VENDORS.includes(cfg.vendor)) return false;
  return cfg.vendor === 'mock' || !!cfg.apiKey;
}

/** 给页面看的那一部分(`GET /v1/info`):不含地址与 Key。`efforts` 是页面可点的思考强度(不含「默认」) */
export function publicModelInfo(cfg, configured = modelReady(cfg)) {
  const models = modelListOf(cfg);
  return { models, defaultModel: models[0] ?? null, configured, efforts: [...RUN_EFFORTS], ...(cfg?.vendor === 'mock' ? { mock: true } : {}) };
}

/**
 * 同 `publicModelInfo(readModelConfig(dir))`,但不解 Key:账号模式的主服务报 `GET /v1/info` 用。
 * Key 只看文件在不在,不打开(主服务不需要 Key 的明文;解不解得开由任务进程起一轮时报 `no-model-key`)。
 */
export function readPublicModelInfo(dataDir) {
  const { file, keyFile } = modelConfigPaths(dataDir);
  let api = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    api = parsed && typeof parsed === 'object' && parsed.api && typeof parsed.api === 'object' ? parsed.api : null;
  } catch { /* 还没配 */ }
  if (!api || !MODEL_VENDORS.includes(api.vendor)) return publicModelInfo({}, false);
  const cfg = { vendor: api.vendor, model: typeof api.model === 'string' ? api.model : '' };
  return publicModelInfo(cfg, api.vendor === 'mock' || fs.existsSync(keyFile));
}
