import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sealKey, openKey, sealedKind, KEY_KINDS, SECRET_KINDS } from './runners/config-crypt.mjs';

/**
 * AI 配置(ai.json)+ 两个密钥文件。
 *
 * API Key **不再写在 ai.json 里**,而是各放各的文件,和 ai.json 同目录:
 *   keys/custom.key  —— 「自定义 API」里用户自己填的 Key,PCENC1. 那一套封装
 *   keys/router.key  —— 「PromptCut Router」分发密文导入的 Key,PCRTR1. 那一套封装
 * 两路的加密标签、AAD、前缀都不一样,拿错一路解出来是空串,不会混用。
 * ai.json 里的 `api.source` 记着**当前生效的是哪一路**("custom" / "router" / "");
 * 进程内 `api.apiKey` 永远是当前那一路解开后的明文,下游(providers、publicConfig)不用改。
 *
 * 设置窗口里的「清理密钥」就是删掉对应那个文件(clearKey);删的是当前生效的那一路时,
 * source 一并清空,等于「没设 Key」。
 *
 * 老版本把密文直接写在 ai.json 的 api.apiKey 里:读到这种就当 custom 那一路,下一次
 * 写配置时搬进 keys/custom.key,ai.json 里不再留。
 */

function getConfigPath() {
  if (process.env.PROMPTCUT_AI_CONFIG) {
    return process.env.PROMPTCUT_AI_CONFIG;
  }
  const appData = process.env.LOCALAPPDATA || os.homedir();
  return path.join(appData, 'promptcut', 'ai.json');
}

/** 某一路 Key 的文件路径(对话两路之外,各功能自己的 Key 也放这里,见文件末尾的 readSecret) */
export function keyFilePath(kind) {
  if (!SECRET_KINDS.includes(kind)) throw new Error(`密钥类型只能是 ${SECRET_KINDS.join(' / ')}`);
  return path.join(path.dirname(getConfigPath()), 'keys', `${kind}.key`);
}

function readKeyFile(kind) {
  try {
    const sealed = fs.readFileSync(keyFilePath(kind), 'utf8').trim();
    // 文件里必须是**这一路**的密文;明文或另一路的密文都不认
    if (sealedKind(sealed) !== kind) return '';
    return openKey(sealed, kind);
  } catch {
    return '';
  }
}

function writeKeyFile(kind, plain) {
  const file = keyFilePath(kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600:密文的口令是**本机**机器码,同一台机器上的另一个用户推得出来,所以别让他读到密文。
  // writeFileSync 的 mode 只在新建时生效,已存在的文件要另外 chmod 一次。
  // (Windows 上 chmod 基本是空操作,这一道是给 POSIX 的。)
  fs.writeFileSync(file, sealKey(plain, kind) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / 权限不够,不影响功能 */ }
}

function getDefaults() {
  return {
    version: 1,
    defaultProvider: null,
    toolProtocol: false,
    /**
     * 「深度自主」开着时一次运行最多跑多少轮模型往返。**0 = 不限**,
     * 那种情况下只有用户点停止、模型自己收尾、或者重复操作检测拦下来才会停。
     * 没开深度自主时这个值不起作用,走各条路自己的常规上限(harness 48 轮 / 文本协议 8 轮)。
     */
    deepAutoRounds: 300,
    /**
     * CLI 驱动(Claude Code / Codex)的额度熔断:任一用量窗口用到 thresholdPercent 就中断这一路;
     * 每新增 checkEveryBytes 字节的上下文后台重查一次。见 server/runners/quota.mjs。
     */
    quota: { enabled: true, thresholdPercent: 80, checkEveryBytes: 262144 },
    api: {
      vendor: 'anthropic',
      baseUrl: '',
      apiKey: '',
      /** 当前生效的 Key 来自哪一路:custom / router / ""(没设) */
      source: '',
      model: '',
      /** 单次输出上限的上限;0 = 按模型的最大上限(2026-10-22 用户定「默认到最大」,`server/harness/model-limits.mjs`) */
      maxTokens: 0,
      /**
       * 两路各自的连接配置:自定义 API 里自己填的、Router 分发密文导入的。
       * 以前 vendor / baseUrl / model 只有一份,导入 Router 会把自己填的冲掉,反过来也一样;
       * 现在各存各的,上面那三个字段是**当前生效那一路**的镜像(readConfig 每次同步),
       * 下游(runner、面板的模型选择器)照旧只读 api.model。model 用 | 分隔多个备选。
       */
      profiles: {
        custom: { vendor: 'anthropic', baseUrl: '', model: '' },
        router: { vendor: 'anthropic', baseUrl: '', model: '' },
      },
    },
    // 三家 CLI 各自的可选模型清单,和 api.model 同一个约定:用 | 分隔。
    // 面板上的模型选择器就读这里;留空就只有「默认」一项。
    cliModels: {
      claude: 'opus|sonnet|haiku',
      codex: 'gpt-5.6-terra|gpt-5.6-sol',
      agy: ''
    }
  };
}

/** 磁盘上那份 ai.json 原样(合并过默认值),Key 字段不解开 */
function readRaw() {
  const p = getConfigPath();
  const defs = getDefaults();
  try {
    if (!fs.existsSync(p)) return defs;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const merged = deepMerge(defs, parsed, true);
    // 老配置把 Codex 模型清单落成空串；读取时补上预设，让已有安装也能立即看到。
    if (!String(parsed?.cliModels?.codex ?? '').trim()) {
      merged.cliModels.codex = defs.cliModels.codex;
    }
    if (!merged.api || typeof merged.api !== 'object' || Array.isArray(merged.api)) {
      merged.api = defs.api;
    }
    /*
     * profiles 也要按类型兜一层,而且要连每一路单独兜。
     *
     * 本文件的原则是「ai.json 解不开也不要 500」—— 上面 try/catch 兜住的是 JSON 解析。
     * 但 profiles 写成 null、数组、或者少了 router / custom 其中一路时,JSON 是合法的,
     * 崩在后面:syncProfile 里 `cfg.api.profiles[face]` 取到 undefined,下一行读 `prof.model`
     * 就是 TypeError,而那已经在这个 try 外面了 —— 结果是整个 AI 设置接口 500,
     * 用户连进去把配置改回来的机会都没有。手改过 ai.json、或者旧版本升上来都可能撞上。
     */
    const profs = merged.api.profiles;
    if (!profs || typeof profs !== 'object' || Array.isArray(profs)) {
      merged.api.profiles = deepMerge(defs.api.profiles, {}, true);
    } else {
      for (const face of ['router', 'custom']) {
        const one = profs[face];
        if (!one || typeof one !== 'object' || Array.isArray(one)) profs[face] = { ...defs.api.profiles[face] };
      }
    }
    // 有没有写过 source:清理密钥之后 persist 写的是 "",那是「真的没设」;
    // 老版本的 ai.json 根本没这个字段,这时才允许去扫两路文件
    merged.api.hasSource = typeof parsed?.api?.source === 'string';
    if (!KEY_KINDS.includes(merged.api.source)) merged.api.source = '';
    return merged;
  } catch {
    return defs;
  }
}

/** ai.json 里遗留的 Key(老版本写在这儿)。只认 custom 那一路的密文或明文 */
function legacyKey(raw) {
  const v = raw.api.apiKey;
  if (!v || typeof v !== 'string') return '';
  const kind = sealedKind(v);
  if (kind && kind !== 'custom') return '';
  return openKey(v, 'custom');
}

export function readConfig() {
  const cfg = readRaw();
  let source = cfg.api.source;
  let key = source ? readKeyFile(source) : '';
  if (!key) {
    // 没有文件(或者文件对不上这一路):看看 ai.json 里有没有老版本留下的
    const legacy = legacyKey(cfg);
    if (legacy) { key = legacy; source = 'custom'; }
    else if (!source && !cfg.api.hasSource) {
      // source 从没写过,但某一路的文件在:custom 优先(用户自己填的那份)
      for (const kind of KEY_KINDS) {
        const k = readKeyFile(kind);
        if (k) { key = k; source = kind; break; }
      }
    }
  }
  // 落盘的是密文,进程内一律用明文:下游(providers、publicConfig)都不用改
  cfg.api.apiKey = key;
  cfg.api.source = key ? source : '';
  delete cfg.api.hasSource;
  syncProfile(cfg);
  return cfg;
}

const PROFILE_FIELDS = ['vendor', 'baseUrl', 'model'];

/**
 * 让 api.vendor / baseUrl / model 等于当前生效那一路的 profile。
 * 老版本的 ai.json 没有 profiles:那三个字段还是唯一的一份,先把它们搬进当前那一路
 * (没设 Key 就算 custom),再镜像回去 —— 老配置一个字都不丢。
 */
function syncProfile(cfg) {
  const face = cfg.api.source === 'router' ? 'router' : 'custom';
  const prof = cfg.api.profiles[face];
  const empty = !prof.model && !prof.baseUrl && prof.vendor === 'anthropic';
  if (empty && (cfg.api.model || cfg.api.baseUrl || cfg.api.vendor !== 'anthropic')) {
    for (const k of PROFILE_FIELDS) prof[k] = cfg.api[k];
  }
  for (const k of PROFILE_FIELDS) cfg.api[k] = prof[k];
}

function checkProfilePatch(patch, where) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(`${where} 必须是对象`);
  if (patch.vendor !== undefined && !['anthropic', 'openai', 'gemini'].includes(patch.vendor)) throw new Error('vendor 只能是 anthropic / openai / gemini');
  if (patch.baseUrl !== undefined) {
    if (typeof patch.baseUrl !== 'string') throw new Error(`${where}.baseUrl 必须是字符串`);
    if (patch.baseUrl !== '' && !patch.baseUrl.startsWith('http://') && !patch.baseUrl.startsWith('https://')) throw new Error('baseUrl 必须是 http(s) 地址或留空');
  }
  if (patch.model !== undefined && typeof patch.model !== 'string') throw new Error(`${where}.model 必须是字符串`);
}

function deepMerge(target, source, reading = false) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (!(key in target) && !reading) {
      continue;
    }
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key], reading);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** 把内存里的配置写回 ai.json(Key 不进去,只留 source) */
function persist(cfg) {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const onDisk = { ...cfg, api: { ...cfg.api } };
  delete onDisk.api.apiKey;
  fs.writeFileSync(p, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows / 权限不够,不影响功能 */ }
}

export function writeConfig(partial) {
  const current = readConfig();
  const newConfig = deepMerge(current, partial, false);

  /*
   * 连接配置分两路存。顶层的 vendor / baseUrl / model(老写法)写进**目标那一路**:
   * 带 source 就是那一路(Router 导入走这里),不带就是当前生效的那一路,没设 Key 算 custom。
   * profiles.custom / profiles.router 显式给的各写各的,不受 source 影响 ——
   * 设置窗口的自定义页和 Router 页都用这个写法,互不冲掉。
   */
  if (partial.api) {
    const legacy = {};
    for (const k of PROFILE_FIELDS) if (partial.api[k] !== undefined) legacy[k] = partial.api[k];
    if (Object.keys(legacy).length) {
      checkProfilePatch(legacy, 'api');
      const targetSource = partial.api.source !== undefined && partial.api.source !== '' ? partial.api.source : current.api.source;
      const face = targetSource === 'router' ? 'router' : 'custom';
      Object.assign(newConfig.api.profiles[face], legacy);
    }
    if (partial.api.profiles !== undefined) {
      const incoming = partial.api.profiles;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('api.profiles 必须是对象');
      for (const face of KEY_KINDS) {
        if (incoming[face] === undefined) continue;
        checkProfilePatch(incoming[face], `api.profiles.${face}`);
        for (const k of PROFILE_FIELDS) if (incoming[face][k] !== undefined) newConfig.api.profiles[face][k] = incoming[face][k];
      }
    }
  }

  if (partial.defaultProvider !== undefined) {
    if (!['claude', 'agy', 'codex', 'api', null].includes(partial.defaultProvider)) {
      throw new Error('defaultProvider 必须是 claude, agy, codex, api 或 null');
    }
    newConfig.defaultProvider = partial.defaultProvider;
  }

  /*
   * Key 的三种写法:
   *   apiKey: "…"   写进 source 指定的那一路(不给 source 就是 custom),并切到那一路;
   *   apiKey: null  清掉当前生效的那一路(文件一并删);
   *   apiKey: ""/缺 Key 不动,只允许单独切 source(那一路得有文件)。
   */
  let source = current.api.source;
  let key = current.api.apiKey;
  const wantSource = partial.api && partial.api.source !== undefined ? partial.api.source : undefined;
  if (wantSource !== undefined && wantSource !== '' && !KEY_KINDS.includes(wantSource)) {
    throw new Error(`api.source 只能是 ${KEY_KINDS.join(' / ')}`);
  }
  if (partial.api && partial.api.apiKey !== undefined) {
    if (partial.api.apiKey === null) {
      if (source) removeKeyFile(source);
      key = ''; source = '';
    } else if (partial.api.apiKey !== '') {
      const kind = wantSource || 'custom';
      if (typeof partial.api.apiKey !== 'string') throw new Error('apiKey 必须是字符串');
      writeKeyFile(kind, partial.api.apiKey);
      key = partial.api.apiKey; source = kind;
    }
  } else if (wantSource !== undefined && wantSource !== source) {
    const k = wantSource ? readKeyFile(wantSource) : '';
    if (wantSource && !k) throw new Error(`${wantSource} 这一路还没有保存过 Key`);
    key = k; source = wantSource;
  }
  // 老版本留在 ai.json 里的 Key:搬进文件,ai.json 里不再留
  if (source === 'custom' && key && !fs.existsSync(keyFilePath('custom'))) writeKeyFile('custom', key);
  newConfig.api.apiKey = key;
  newConfig.api.source = key ? source : '';

  if (partial.api && partial.api.maxTokens !== undefined) {
    const val = parseInt(partial.api.maxTokens, 10);
    if (!isNaN(val) && val > 0) {
      newConfig.api.maxTokens = val;
    } else {
      newConfig.api.maxTokens = current.api.maxTokens;
    }
  }

  if (partial.cliModels !== undefined) {
    const incoming = partial.cliModels;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new Error('cliModels 必须是对象');
    }
    for (const key of ['claude', 'codex', 'agy']) {
      if (incoming[key] === undefined) continue;
      if (typeof incoming[key] !== 'string') throw new Error(`cliModels.${key} 必须是字符串`);
      newConfig.cliModels[key] = incoming[key];
    }
  }

  if (partial.toolProtocol !== undefined) {
    newConfig.toolProtocol = !!partial.toolProtocol;
  }

  if (partial.deepAutoRounds !== undefined) {
    const v = Number(partial.deepAutoRounds);
    // 0 是「不限」,是有意义的取值,所以下界是 0 不是 1。上界 100000 只为挡住手滑,
    // 真跑到那儿早就被重复操作检测或者用户自己拦下来了。
    if (!Number.isFinite(v) || v < 0 || v > 100000) throw new Error('deepAutoRounds 是 0~100000 的整数(0 = 不限轮次)');
    newConfig.deepAutoRounds = Math.round(v);
  }

  if (partial.quota !== undefined) {
    const q = partial.quota;
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('quota 必须是对象');
    const next = { ...(newConfig.quota || {}) };
    if (q.enabled !== undefined) next.enabled = !!q.enabled;
    if (q.thresholdPercent !== undefined) {
      const v = Number(q.thresholdPercent);
      if (!Number.isFinite(v) || v < 1 || v > 100) throw new Error('quota.thresholdPercent 是 1~100 的百分数');
      next.thresholdPercent = Math.round(v);
    }
    if (q.checkEveryBytes !== undefined) {
      const v = Number(q.checkEveryBytes);
      if (!Number.isFinite(v) || v < 16384) throw new Error('quota.checkEveryBytes 至少 16384(16KB)');
      next.checkEveryBytes = Math.round(v);
    }
    newConfig.quota = next;
  }

  // 顶层三个字段跟着生效的那一路走
  syncProfile(newConfig);
  persist(newConfig);
  return newConfig;
}

function removeKeyFile(kind) {
  try { fs.rmSync(keyFilePath(kind), { force: true }); } catch { /* 没有就算了 */ }
}

/**
 * 「清理密钥」:删掉某一路的密钥文件。删的正是当前生效的那一路,配置就退回「没设 Key」。
 * 老版本留在 ai.json 里的 Key 也一并抹掉(清 custom 时),不然读回来又冒出来。
 */
export function clearKey(kind) {
  if (!KEY_KINDS.includes(kind)) throw new Error(`密钥类型只能是 ${KEY_KINDS.join(' / ')}`);
  const cfg = readConfig();
  removeKeyFile(kind);
  if (cfg.api.source === kind) { cfg.api.apiKey = ''; cfg.api.source = ''; }
  persist(cfg);
  return cfg;
}

/** 某一路有没有存着 Key(不解开也能看前缀,但这里顺手核一遍能不能解) */
function keyState(kind) {
  const k = readKeyFile(kind);
  return { set: k.length > 0, last4: k.length >= 4 ? k.slice(-4) : '' };
}

export function publicConfig() {
  const cfg = readConfig();
  const apiKey = cfg.api.apiKey || '';
  cfg.api.apiKey = {
    set: apiKey.length > 0,
    last4: apiKey.length >= 4 ? apiKey.slice(-4) : ''
  };
  // 两路各自的状态:设置窗口里 Router 页和自定义页各显示各的,互不影响
  cfg.keys = { custom: keyState('custom'), router: keyState('router') };
  // 老版本 Key 还在 ai.json 里、没搬家的情况:custom 页也得看得到
  if (cfg.api.source === 'custom' && !cfg.keys.custom.set) cfg.keys.custom = { ...cfg.api.apiKey };
  return cfg;
}

/*
 * 别的功能自己的 Key(比如配音用的 API Key)也走这一套:和对话 API 的 Key 同样落在
 * keys/<kind>.key、同样 0600、同样 config-crypt 封装、前缀对不上就当没设。
 * 各用各的 kind,互相解不开;它们不是对话来源,不进 api.source,clearKey 也不碰它们。
 */
export function readSecret(kind) {
  return readKeyFile(kind);
}

export function writeSecret(kind, plain) {
  writeKeyFile(kind, plain);
}

export function removeSecret(kind) {
  removeKeyFile(kind);
}

/**
 * 对话 API「自定义」那一路填的地址,只取协议 + 主机(https://example.com/v1 → https://example.com)。
 * 同一家 API 下的别的接口(配音的 /minimax/v1/…)没单独填地址时拿它当默认。读的是原始配置,不解 Key。
 */
export function apiOrigin() {
  const raw = readRaw();
  const u = raw.api?.profiles?.custom?.baseUrl || raw.api?.baseUrl || '';
  try { return u ? new URL(u).origin : ''; } catch { return ''; }
}
