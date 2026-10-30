import { createHash } from 'node:crypto';

/**
 * 渲染节点的环境指纹与结果键(设计 2.1,契约 B.1)。
 *
 * 不同硬件上 Canvas / WebGL 的字体微调和抗锯齿有确定的像素差,不同环境渲出的连续帧
 * 拼在一起会闪。所以**不假设跨环境可以互相替用**:细任务的结果键 = 内容键 × 环境指纹。
 *
 *   envFingerprint = sha256(`${os}\n${gpuClass}\n${chromeMajor}`) 的前 16 位十六进制
 *   resultKey      = sha256(`${contentKey}\n${envFingerprint}`)     的 64 位十六进制
 *
 * 结果键和现有的共享键、本地档键、流键同形(64 位小写十六进制),路由正则不用改。
 * 节点启动时用 `describeEnvironment` 算一次,在 `node.hello` 里上报。
 *
 * 纯函数:不读环境变量、不做 I/O;缺项一律按空值计,不抛。
 */

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `process.platform`、已归一的名字或页面上报的平台串 → `windows` | `macos` | `linux` | `other`
 * (大小写不敏感)。
 *
 * 先精确匹配(`win32` / `windows`、`darwin` / `macos`、`linux`),再按前缀补三条(契约 F.2):
 * `win…` → windows、`mac…` → macos、`linux…` → linux。前缀是为了认得页面的
 * `navigator.platform`(`Win32`、`MacIntel`、`Linux x86_64`)和 `userAgentData.platform`
 * (`Windows`、`macOS`、`Linux`),这样页面和本机预渲染进程在同一台机器上算出同一个 `os`。
 */
export function normalizeOs(platform) {
  const name = String(platform ?? '').trim().toLowerCase();
  if (name === 'win32' || name === 'windows') return 'windows';
  if (name === 'darwin' || name === 'macos') return 'macos';
  if (name === 'linux') return 'linux';
  if (name.startsWith('win')) return 'windows';
  if (name.startsWith('mac')) return 'macos';
  if (name.startsWith('linux')) return 'linux';
  return 'other';
}

/*
 * GPU 基础类别的匹配表,**顺序即优先级**:软件栅格化最先(ANGLE 的 SwiftShader
 * 串里也会带厂商名),认不出的最后一律当 `software` —— 保守:没有硬件加速。
 * `ati ` 带空格,免得误中 `corporation` 之类的词。
 */
const GPU_RULES = [
  ['software', ['swiftshader', 'llvmpipe', 'software', 'microsoft basic render']],
  ['nvidia', ['nvidia', 'geforce', 'quadro', 'rtx']],
  ['amd', ['amd', 'radeon', 'ati ']],
  ['intel', ['intel']],
  ['apple', ['apple']],
];

/**
 * WebGL 的 UNMASKED_RENDERER / UNMASKED_VENDOR → `nvidia` | `amd` | `intel` | `apple` | `software`。
 * 两个串用一个空格拼起来一起匹配,大小写不敏感。
 */
export function gpuClassOf(renderer, vendor) {
  const text = `${renderer ?? ''} ${vendor ?? ''}`.toLowerCase();
  for (const [gpuClass, needles] of GPU_RULES) {
    if (needles.some(needle => text.includes(needle))) return gpuClass;
  }
  return 'software';
}

/**
 * Chrome 主版本:`'138.0.7204.49'`、`'HeadlessChrome/138.0…'`、完整 UA、`138` → 138;
 * 解析不出 → 0。串里有 `Chrome/` / `Chromium/` 就取它后面的数(完整 UA 开头是 `Mozilla/5.0`,
 * 不能取第一个数),否则取第一个数。
 */
export function chromeMajorOf(version) {
  if (typeof version === 'number') return Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
  const text = String(version ?? '');
  const match = /(?:chrome|chromium)\/(\d+)/i.exec(text) ?? /(\d+)/.exec(text);
  if (!match) return 0;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : 0;
}

/**
 * 页面报上来的 UA 是不是 Chromium 内核(M7 契约 D14:一期只在 Chromium 内核的浏览器上当纯浏览器节点)。
 * `chromeMajorOf` 对不带 `Chrome/` 的 UA 取第一个数,Firefox、Safari 都会得 5,指纹相撞、两种引擎的帧可能拼进同一层,
 * 所以这类浏览器不当节点。认的是 `Chrome/<数>`、`Chromium/<数>`、`HeadlessChrome/<数>`(Edge、Opera 等 Chromium 系都带);
 * iOS 上的 Chrome / Firefox / Edge(`CriOS`、`FxiOS`、`EdgiOS`)是 WebKit,不算。
 */
export function isChromiumUserAgent(userAgent) {
  const ua = String(userAgent ?? '');
  if (/\b(?:CriOS|FxiOS|EdgiOS)\//.test(ua) || /\bFirefox\//.test(ua)) return false;
  return /\b(?:HeadlessChrome|Chrome|Chromium)\/\d+/.test(ua);
}

/** 环境指纹:16 位小写十六进制。三项任一缺失按 `''` / `0` 计。 */
export function envFingerprintOf({ os, gpuClass, chromeMajor } = {}) {
  return sha256(`${os ?? ''}\n${gpuClass ?? ''}\n${chromeMajor ?? 0}`).slice(0, 16);
}

/** 从原始探测值一次算齐:`{ os, gpuClass, chromeMajor, fingerprint }`。 */
export function describeEnvironment({ platform, renderer, vendor, chromeVersion } = {}) {
  const os = normalizeOs(platform);
  const gpuClass = gpuClassOf(renderer, vendor);
  const chromeMajor = chromeMajorOf(chromeVersion);
  return { os, gpuClass, chromeMajor, fingerprint: envFingerprintOf({ os, gpuClass, chromeMajor }) };
}

/** 细任务的结果键:内容键(共享键 / 本地档键 / 流键)乘上环境指纹,64 位小写十六进制。 */
export function resultKeyOf(contentKey, envFingerprint) {
  return sha256(`${contentKey ?? ''}\n${envFingerprint ?? ''}`);
}

/**
 * 在线卡片运行时版本串(`src/online/cardRuntime/version.ts`,形如 `ocr1:sucrase@3.35.1:tailwindcss@4.3.3`):页面报来的原始值,
 * 只认安全字符、长度有限;不合格一律当没报(→ 没有 `cardEnvFingerprint`,浏览器节点不认领用户卡与素材效果卡)。
 */
export const CARD_RUNTIME_MAX = 128;
const CARD_RUNTIME_RE = /^[A-Za-z0-9._@:+\-]+$/;
export function cardRuntimeOf(value) {
  if (typeof value !== 'string' || value === '' || value.length > CARD_RUNTIME_MAX || !CARD_RUNTIME_RE.test(value)) return null;
  return value;
}

/**
 * 用户卡、素材效果卡的环境指纹(在线执行用户卡与素材效果卡契约 `docs/plan/online-card-exec-contract.md` 第 5、7 节,块 N):
 * 纯浏览器节点执行用户卡、素材效果卡时,画面不只取决于系统、显卡类别、Chrome 主版本,还取决于在线页面里的转译器与加载规则,
 * 所以在 `envFingerprintOf` 那三项之外再加「在线卡片运行时版本」一起取摘要。
 *
 *   cardEnvFingerprint = sha256(`${os}\n${gpuClass}\n${chromeMajor}\ncard-runtime:${cardRuntime}`) 的前 16 位十六进制
 *
 * 末尾那一行带 `card-runtime:` 前缀,摘要的原文与 `envFingerprintOf`(三行)永远不同,所以同一台机器上桌面节点(没有这一项)
 * 与浏览器节点对用户卡、素材效果卡的结果键不会相同。`envFingerprint` 与内置卡片的结果键一个字不变。
 * `cardRuntime` 不合格(`cardRuntimeOf` 回 null)时回 `null`:没有这一项就没有这个指纹。
 */
export function cardEnvFingerprintOf({ os, gpuClass, chromeMajor, cardRuntime } = {}) {
  const runtime = cardRuntimeOf(cardRuntime);
  if (runtime === null) return null;
  return sha256(`${os ?? ''}\n${gpuClass ?? ''}\n${chromeMajor ?? 0}\ncard-runtime:${runtime}`).slice(0, 16);
}

/**
 * 从原始探测值一次算齐用户卡、素材效果卡的环境指纹:`describeEnvironment` 之外多一个 `cardRuntime`;
 * 回 `{ os, gpuClass, chromeMajor, fingerprint, cardRuntime, cardEnvFingerprint }`(没有合格的 `cardRuntime` 时后两项为 `null`)。
 */
export function describeCardEnvironment({ platform, renderer, vendor, chromeVersion, cardRuntime } = {}) {
  const env = describeEnvironment({ platform, renderer, vendor, chromeVersion });
  const runtime = cardRuntimeOf(cardRuntime);
  return { ...env, cardRuntime: runtime, cardEnvFingerprint: cardEnvFingerprintOf({ os: env.os, gpuClass: env.gpuClass, chromeMajor: env.chromeMajor, cardRuntime: runtime }) };
}
