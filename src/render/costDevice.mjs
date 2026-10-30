/**
 * 成本记录的 `device` 串（K1 / J4）：**一处拼，两条路共用。**
 *
 * `costs-store.mjs` 的去重键是 `${identityKey} ${device}`，所以这个串的每一个字节都在
 * 决定「谁和谁是同一条成绩」。今天有两条路会写成本记录：
 *
 *   - 离线探针 `scripts/probe-card-costs.mjs`（Node + 一张宿主页）；
 *   - 常驻探针 `src/editor/probeRunner.ts`（编辑器主文档，`ProbeGate` 遮罩下跑）。
 *
 * 两条路各拼一遍的话，任何一处顺序、空格、`true` / `false` 的写法不一致，测出来的记录
 * 就互相看不见：常驻探针每次开项目都会把离线探针刚测完的 62 张卡再测一遍，而且两套记录
 * 同时躺在 `out/card-costs.json` 里谁也用不上谁（R4a 报告 §8 第 10 条点名要抽出来）。
 * 所以拼法只留这一份，两端都 `import` 它。
 *
 * # 串里有什么、为什么
 *
 *   `<UA> | <GPU renderer> | lowMemory=<bool> | offscreenGl=<bool> | glRoute=<路线> | mode=<dev|build> | stepP=<百分位> | stepN=<最少样本>`
 *
 *   第三段的字段名是历史名（2026-10-07 撤销的旧档位），**只为旧记录的键一个字节不变**留着（桌面版恒为 `false`，
 *   改名会让每台桌面版升级后把项目里的卡全部重测一遍）；现在它的值是「只有一个舞台」（`compact`：在线页面舞台闸门停在第一级、
 *   最低一档），同一台设备单舞台与双舞台测出来的数不混。
 *
 * - **UA + GPU renderer**：换机器、换显卡，同一张卡的耗时完全不是一回事（K1）。
 * - **`compact` / `offscreenGl` / `glRoute`**（J4）：共享 WebGL 渲染器走哪条路线会改变
 *   canvas 卡的成本；`glRoute` 取**生效值**（在线页面按舞台闸门，桌面按项目选项、缺省路线 1，3.6）。
 * - **`mode`**（3.1）：桌面版跑的就是 vite dev server，dev 的数才是真实运行环境；
 *   build 的数是给将来的在线浏览器模式的。不拼进去两组会互相覆盖。
 * - **`stepP` / `stepN`**（K2「可调系数」）：它们决定 `stepMs` 怎么从样本里取，
 *   改了它们等于**换了量法**，旧成绩不该再用 —— 拼进去旧记录自然不命中、会被重测。
 *   **`COST_SCALE` 不拼**：它只影响怎么用这些数（判重和权重），不影响量出来的数本身。
 *
 * # 纯函数
 *
 * `costDeviceString` 不读文件、不看环境变量、不碰 DOM，输入一样输出就一样 ——
 * Node 和浏览器各调一次必然逐字节相同。要摸 DOM 的那两样（GPU 串、UA）单独拿出来，
 * 由调用方在自己那一侧读好再传进来。
 */

import { resolveTuning } from './pipelineTuning.mjs';

/** 字段之间的分隔符。改它等于让全部旧记录失效，所以单独拎出来当常量提醒一下 */
export const COST_DEVICE_SEPARATOR = ' | ';

/** 第三段的字段名（历史名，见文件头）。改它等于让全部旧记录失效 */
export const COST_DEVICE_COMPACT_FIELD = 'lowMemory';

/**
 * 共享 WebGL 渲染器的两条路线（3.6 / M2）：给了合法的路线就用它，否则用 `fallback`（缺省路线 1 `perDocument`）。
 * 桌面版：项目选项优先、缺省路线 1；在线页面：调用方把舞台闸门定的路线当 `glRoute` 传进来（`online/onlineTier.ts` 的 `tierGlRoute`）。
 */
export function resolveGlRoute(glRoute, fallback = 'perDocument') {
  if (glRoute === 'perDocument' || glRoute === 'shared') return glRoute;
  return fallback === 'shared' ? 'shared' : 'perDocument';
}

/**
 * 拼一条 `device` 串。
 *
 * @param {object} parts
 * @param {string} parts.ua           `navigator.userAgent`
 * @param {string} parts.renderer     WebGL 的 `UNMASKED_RENDERER_WEBGL`（读不出来给 `'unknown'`）
 * @param {boolean} parts.compact     J4 的宿主能力：只有一个舞台（写在历史字段名下，见文件头）
 * @param {boolean} parts.offscreenGl J4 的宿主能力
 * @param {string} [parts.glRoute]    生效路线；不给就是路线 1
 * @param {string} parts.mode         `'dev' | 'build'`；别的值一律当 `'dev'`（R1 之前的记录就是 dev）
 * @param {object} [parts.tuning]     K2 系数（已解析或裸覆盖值都收，`resolveTuning` 幂等）
 */
export function costDeviceString(parts) {
  const p = parts && typeof parts === 'object' ? parts : {};
  const tuning = resolveTuning(p.tuning);
  const compact = !!p.compact;
  return [
    String(p.ua ?? ''),
    String(p.renderer ?? 'unknown'),
    `${COST_DEVICE_COMPACT_FIELD}=${compact}`,
    `offscreenGl=${!!p.offscreenGl}`,
    `glRoute=${resolveGlRoute(p.glRoute)}`,
    `mode=${p.mode === 'build' ? 'build' : 'dev'}`,
    `stepP=${tuning.STEP_PERCENTILE}`,
    `stepN=${tuning.STEP_MIN_SAMPLES}`,
  ].join(COST_DEVICE_SEPARATOR);
}

/**
 * 读本机 GPU 的 `UNMASKED_RENDERER_WEBGL`。**在调用方那个文档里开一张一次性画布**，
 * 不碰舞台自己那个共享 WebGL 上下文（M2 的路线 1 每个文档只许有一个）；读完立刻
 * `WEBGL_lose_context` 还回去，免得占着一个上下文名额（Chrome 每个文档 16 个封顶）。
 *
 * 读不出来回 `'unknown'` —— 软件渲染、`--disable-gpu`、扩展被关掉都会走到这一支，
 * 那时 `device` 串里就是 `unknown`，同一台机器上仍然自洽。
 */
export function readGpuRenderer(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return 'unknown';
  try {
    const canvas = doc.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'unknown';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const value = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* 还不回去也不算失败 */ }
    return value;
  } catch {
    return 'unknown';
  }
}
