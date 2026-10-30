/**
 * K1 探针记录的本机存档(`out/card-costs.json`)。
 *
 * 存储本体在这里,HTTP 面在 `server/vite-plugin-costs.ts`。拆开是为了
 * `server/test/costs.test.mjs` 能直接测「按 (identityKey, device) 去重 / 旗标保留」这件事,
 * 不用起 dev server。
 *
 * # 键
 *
 * `(identityKey, device)`。`identityKey` 已经把 fps、卡片参数、源码版本、审阅表、片段长度
 * 都吃进去了(`src/render/cardCostKey.mjs`),所以这里只补一个 `device` —— 换机器、换 GPU、
 * 换共享 WebGL 路线之后同一张卡的耗时完全不是一回事,必须重测(目标 K/K1)。
 * `device` 由页面侧算(UA + WebGL `UNMASKED_RENDERER_WEBGL` + 只有一个舞台(历史字段名,见 `src/render/costDevice.mjs`)/ `offscreenGl` / `glRoute`),
 * 服务端只当不透明字符串用,不解析。
 *
 * # 为什么 `demoted` / `pinnedHeavy` 要粘住
 *
 * 这两面旗不是探针写的:`demoted` 是 K6 的实时降级(播放中累计超时把一张轻卡打成重卡),
 * `pinnedHeavy` 是人工钉死。探针复测同一张卡时上报的记录里根本没有这两个字段,
 * 照字面覆盖就等于每次重测都把降级记录抹掉 —— K1 的「已有记录且 demoted !== true 才跳过」
 * 会因此永远命中,被降级的卡再也测不出新成绩。所以:**新记录没有显式带这个字段,就沿用旧的**;
 * 显式带了(哪怕是 `false`)就以新的为准。
 *
 * # 写法
 *
 * 先写同目录的临时文件再 rename —— 两个进程(编辑器 + 预渲染)各写各的副本,
 * 但同一个进程里 PUT 可能并发,半截 JSON 会让下一次 `loadCosts` 整份读空。
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveTuning } from '../src/render/pipelineTuning.mjs';

const FILE_NAME = 'card-costs.json';
const TUNING_FILE_NAME = 'pipeline-tuning.json';

/** 记录落在哪。开发期 dataDir 就是 `<root>/out`;正式包里 PROMPTCUT_DATA_DIR 指向 %LOCALAPPDATA% */
export function costsDir(root) {
  return process.env.PROMPTCUT_DATA_DIR || path.join(root, 'out');
}
export function costsPath(root) {
  return path.join(costsDir(root), FILE_NAME);
}

/**
 * K2 可调系数的覆盖值(`out/pipeline-tuning.json`)。**没有这个文件 = 全用缺省。**
 *
 * 为什么和成本记录同一条路回:`planPipelines` 在页面和预渲染进程各算一次,两端必须用
 * **同一份系数**,否则算不出同一张表(任务书 K2「可调系数」)。而两端本来就都要拉 `costs`,
 * 再开一个端点只会多一次「一端拿到新系数、另一端还是旧的」的窗口。
 *
 * 回出去的是**夹取之后**的一份,不是文件里的原话:夹取规则住在 `pipelineTuning.mjs` 里,
 * 两端各夹一次结果当然一样,但先夹好再发能少一层「某一端忘了夹」的可能。
 */
export function tuningPath(root) {
  return path.join(costsDir(root), TUNING_FILE_NAME);
}

/** 读覆盖值并夹取。文件不存在 / 坏了 / 不是对象都当「没有覆盖」,回缺省——不该让编辑器起不来 */
export function loadTuning(root) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(tuningPath(root), 'utf8'));
  } catch {
    return resolveTuning(null);
  }
  return resolveTuning(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
}

/**
 * 写覆盖值(`PUT /api/data/costs/tuning`)。R4a 只做了读 —— 改系数要人手编辑这个文件,
 * 而「不改代码就能调」少了写入口就只剩半条(K2「可调系数」)。
 *
 * **落盘的是夹取之后的一份**,不是请求里的原话:`loadTuning` 回的也是夹取后的,
 * 两边一致才不会出现「文件里写着 100、回出去的是 4」这种对不上的账。
 * 写法和成本记录一样先写临时文件再 rename(半截 JSON 会让下一次 `loadTuning` 整份读空)。
 *
 * 传 `null`(或不是对象)= **清掉覆盖、全用缺省**:删文件,而不是写一份缺省值进去 ——
 * 「没有这个文件 = 全用缺省」是 K2 明写的,留一份等值的文件只会让人以为有人调过。
 */
export function saveTuning(root, overrides) {
  const file = tuningPath(root);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    try { fs.rmSync(file, { force: true }); } catch { /* 删不掉就算了,下一次写会覆盖 */ }
    return resolveTuning(null);
  }
  const tuning = resolveTuning(overrides);
  writeAtomic(file, JSON.stringify(tuning, null, 2));
  return tuning;
}

const keyOf = (record) => `${record.identityKey}\u0000${record.device}`;

/** 至少要有键的两半才存得住;其余字段由页面侧负责,服务端不校验数值 */
export function validRecord(record) {
  return !!record && typeof record === 'object'
    && typeof record.identityKey === 'string' && record.identityKey !== ''
    && typeof record.device === 'string' && record.device !== '';
}

/** 探针不知道、只能沿用的旗标(K6 的降级 / 人工钉死) */
export const STICKY_FLAGS = ['demoted', 'pinnedHeavy'];

/** 读全部记录。文件不存在 / 坏了都当空表 —— 探针重测一遍就有了,不该让编辑器起不来 */
export function loadCosts(root) {
  let text;
  try {
    text = fs.readFileSync(costsPath(root), 'utf8');
  } catch {
    return [];
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.costs) ? data.costs : [];
  return list.filter(validRecord);
}

/** 纯函数的 upsert:给 `existing` 打上 `incoming`,返回新表。不碰磁盘,给测试和插件共用 */
export function mergeCosts(existing, incoming) {
  const byKey = new Map();
  for (const record of existing ?? []) if (validRecord(record)) byKey.set(keyOf(record), record);
  let added = 0, updated = 0;
  for (const record of incoming ?? []) {
    if (!validRecord(record)) continue;
    const key = keyOf(record);
    const old = byKey.get(key);
    const next = { ...record };
    if (old) {
      for (const flag of STICKY_FLAGS) {
        if (!Object.prototype.hasOwnProperty.call(record, flag) && Object.prototype.hasOwnProperty.call(old, flag)) next[flag] = old[flag];
      }
      updated++;
    } else {
      added++;
    }
    byKey.set(key, next);
  }
  return { costs: [...byKey.values()], added, updated };
}

/**
 * 改名遇到这几种错误时退避重试:Windows 上目标文件正被别的进程读着(编辑器与预渲染进程都读这份成本记录),
 * `rename` 会偶发 EPERM / EBUSY / EACCES(T9 第 2 轮实测:创建方写钉死记录时 `EPERM: rename card-costs.json.*.tmp`)。
 * 其它错误不重试。
 */
export const RENAME_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
/** 重试次数上限与每次的等待(毫秒,第 n 次重试等 n × 步长;上限合计约 0.9 s) */
export const RENAME_RETRIES = 8;
export const RENAME_BACKOFF_MS = 25;

/** 同步短等:存储接口是同步的,只在改名重试时用 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRIES || !RENAME_RETRY_CODES.includes(err?.code)) throw err;
      pause(RENAME_BACKOFF_MS * (attempt + 1));
    }
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉不算失败 */ }
    throw err;
  }
}

/** 落盘的 upsert。返回 `{ costs, added, updated, count }` */
export function upsertCosts(root, records) {
  const merged = mergeCosts(loadCosts(root), records);
  writeAtomic(costsPath(root), JSON.stringify({ version: 1, costs: merged.costs }));
  return { ...merged, count: merged.costs.length };
}

/**
 * `GET /api/data/costs?device=&mode=` 的过滤:两个条件各自可选,不给就不筛
 * (给调试和审计脚本看全表)。
 *
 * `mode`(`'dev' | 'build'`,R1 加的)是记录**在哪种服务端上量的**。任务书 3.1:桌面版跑的
 * 就是 vite dev server、根本不读 `dist/`,所以分派用**当前运行模式**的记录 —— dev 的应用只看
 * dev 记录,将来的在线浏览器模式(构建产物)只看 build 记录。R1 之前的记录没有这个字段,
 * 它们全是 dev 模式量的,所以**缺字段一律当 `'dev'`**。
 *
 * 去重键仍然只有 `(identityKey, device)`(见文件头),而 `mode` 也被探针拼进了 `device` 串,
 * 所以两种模式的成绩各占一条、互不覆盖,两组都留得住。
 */
export function filterCosts(costs, device, mode) {
  let list = costs ?? [];
  if (device) list = list.filter((record) => record.device === device);
  if (mode) list = list.filter((record) => (record.mode ?? 'dev') === mode);
  return list;
}
