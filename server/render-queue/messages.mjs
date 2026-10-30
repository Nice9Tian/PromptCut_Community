/**
 * 渲染任务队列的消息格式：入站校验、出站构造、任务 id。
 *
 * 契约见 `docs/plan/render-queue-contract.md` A.4、A.6、A.11，卡片级指纹锁见 F.1。入站消息一律先整体校验再交给状态机：
 * 格式不对的整条不生效（C6），所以校验不能有副作用，也不能「校验到一半先改一部分状态」。
 * 校验通过后返回的是规范化、深拷贝过的副本：之后调用方再改原消息，影响不到队列里存的东西。
 */

const KINDS = new Set(['plan', 'snapshot', 'stream']);
const TIERS = new Set(['shared', 'local']);
const RANGE_UNITS = new Set(['localFrame', 'segment']);
const WEIGHT_CLASSES = new Set(['light', 'medium', 'heavy']);
const PROFILES = new Set(['pc', 'host', 'browser']);
/** 参与卡片级指纹锁的任务种类（F.1）：plan 不产结果，不锁 */
const LOCK_KINDS = new Set(['snapshot', 'stream']);

/**
 * 只有节点连接能发的消息（A.5）。`node.active`（M7 D2 补充〔裁〕，`claude/queue-maint`）：节点手里没有这张卡的认领、
 * 但页面还在、在忙别的（生成别的卡的快照、后台舞台在测量或补跑）时按 `node.welcome.activeIntervalMs` 报一次，
 * 它锁着的卡不因此被判闲置；不回包。
 */
export const NODE_TYPES = new Set(['queue.watch', 'task.claim', 'task.progress', 'task.complete', 'task.release', 'task.fail', 'node.active']);
/** `node.active` 的 `busy`（忙什么，只作诊断）的长度上限 */
export const NODE_ACTIVE_BUSY_MAX = 32;
/**
 * 只有发布连接能发的消息（A.5）。`card.lock`（F.1）也在这里：文档服务按这个集合把消息路由给队列，
 * 加进来就不用改文档服务。
 */
export const PUBLISHER_TYPES = new Set(['task.publish', 'task.unsubscribe', 'card.lock']);

/**
 * 任务的优先级档（语义 `mechanism/document-service.md`「渲染任务队列」的「优先级」，c10a 契约第 17 节）：
 * `priority` 取 `'normal'`（缺省；在线页面与本机判重而发布的一律是它）或 `'backfill'`（旧页面的预渲染重试；2026-10-07 起没有新的发布方，
 * 留着只为认部署切换期间的老页面）。
 * 早先的整数 `priority`（锚帧段 50、其余 10，契约 A.4）照旧收，算 `normal` 档里的名次：
 * 没带 `priority` 或带整数的旧客户端一律按 `normal` 处理。
 */
export const PRIORITY_BANDS = Object.freeze(['normal', 'backfill']);
/** 这个 `priority` 落在哪一档：只有 `'backfill'` 是预渲染重试档，其余（缺省、整数、`'normal'`）都是 `normal` */
export function priorityBand(priority) {
  return priority === 'backfill' ? 'backfill' : 'normal';
}
/** 档内名次：整数原样，其余 0（`normal` 档里整数大的先认领，契约 B.3） */
export function priorityRank(priority) {
  return Number.isSafeInteger(priority) ? priority : 0;
}
/**
 * 摘要（契约 H.3 的 `topPriority`）用的数：整数原样、`'normal'` 算 0、`'backfill'` 算 -1 ——
 * 摘要只比大小，预渲染重试档排在任何 `normal` 之下。
 */
export function prioritySummaryValue(priority) {
  if (Number.isSafeInteger(priority)) return priority;
  return priority === 'backfill' ? -1 : 0;
}

/** 预渲染重试计划任务（c10a 契约第 17 节）结果键的后缀：`<projectId>@<projectRev>#backfill:<sig>` */
export const BACKFILL_KEY_MARK = '#backfill:';
const BACKFILL_SIG_RE = /^[0-9a-z]{1,32}$/;
/** 预渲染重试计划任务的片段清单上限 */
export const BACKFILL_MAX_CLIPS = 1000;
/**
 * 清单计划(C10 契约第 7 节、第 18 节第 9 条〔裁〕):在线页面发布的 `plan`,带它自己判重的片段清单,`priority` 为 normal。
 * 结果键 `<projectId>@<projectRev>#clips:<sig>`(签名与预渲染重试同一个算法)。与预渲染重试计划合称「带片段清单的计划任务」:
 * `host` 也能认领、由认领的节点用自己的指纹切分(对 M6c X4 的修改,见 `queue.mjs`)。
 */
export const CLIPS_KEY_MARK = '#clips:';

/**
 * 任务 id 由内容决定（设计第 2 节）：同一个结果只会有一个任务，重复发布才能幂等合并。
 * `plan` 任务没有范围，id 就是 `plan:<projectId>@<projectRev>`（预渲染重试计划任务是 `plan:<projectId>@<projectRev>#backfill:<sig>`）。
 *
 * 稀疏流任务（`kind: 'stream'`、`input.density: 'sparse'`，见 `STREAM_DENSITY_SPARSE`）的 id 在末尾多一段 `:sparse`：
 * 它和同一条流、同一段的满密度任务是两个任务（先后各做一次），结果键、范围、内容库里的清单键都相同。
 */
export function taskIdOf({ kind, resultKey, range, density }) {
  if (kind === 'plan') return `plan:${resultKey}`;
  const id = `${kind}:${resultKey}:${range.from}-${range.to}`;
  return kind === 'stream' && density === STREAM_DENSITY_SPARSE ? `${id}:${STREAM_DENSITY_SPARSE}` : id;
}

/**
 * 流任务的密度（`input.density`）：`'sparse'` 是稀疏流任务——每个分段只截分段的第一帧、其余帧重复它
 * （语义 `mechanism/rendering.md`「重管线：预渲染」）；不带这一项的是满密度任务。别的值在入站时去掉（当满密度）。
 */
export const STREAM_DENSITY_SPARSE = 'sparse';
/** 这个任务是不是稀疏流任务。入站任务、TaskView、切分出来的任务都能传(没带 `input` 的摘要按 id 的结尾认) */
export const isSparseStreamTask = (task) => isObj(task) && task.kind === 'stream'
  && ((isObj(task.input) && task.input.density === STREAM_DENSITY_SPARSE) || (typeof task.id === 'string' && task.id.endsWith(`:${STREAM_DENSITY_SPARSE}`)));

/**
 * 卡片级指纹锁的锁键（F.1）：`<kind>:<input.contentKey>`，一张卡的一种结果一把锁。
 * 只有快照和轨道流有；没有内容键的任务不参与锁，返回 null。入站任务、TaskView、队列内部的任务都能传。
 */
export function lockKeyOf(task) {
  if (!isObj(task) || !LOCK_KINDS.has(task.kind)) return null;
  const contentKey = isObj(task.input) ? task.input.contentKey : undefined;
  return typeof contentKey === 'string' && contentKey !== '' ? `${task.kind}:${contentKey}` : null;
}

/** 出站消息：类型 + 字段 + epoch（C6），回包再带上入站的 reqId。字段深拷贝，收件方改它不影响队列。 */
export function makeMessage(epoch, type, fields, reqId) {
  const msg = { type, ...structuredClone(fields ?? {}), epoch };
  if (reqId !== undefined) msg.reqId = reqId;
  return msg;
}

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isReqId = (v) => typeof v === 'string' || isNum(v);

function str(v, name) {
  if (typeof v !== 'string') bad(`${name} 必须是字符串`);
  return v;
}
function nonEmpty(v, name) {
  if (typeof v !== 'string' || v === '') bad(`${name} 必须是非空字符串`);
  return v;
}
function int(v, name) {
  if (!isInt(v)) bad(`${name} 必须是整数`);
  return v;
}
function oneOf(v, set, name) {
  if (!set.has(v)) bad(`${name} 必须是 ${[...set].join(' / ')} 之一`);
  return v;
}
/** 可选字段：undefined 与 null 都算没给 */
const absent = (v) => v === undefined || v === null;
function optStr(v, name) { return absent(v) ? null : str(v, name); }
function optInt(v, name) { return absent(v) ? null : int(v, name); }
/** 可选的布尔：只有 undefined 算没给，null 和其它类型都算格式错误（同 task.fail 的 retryable） */
function optBool(v, name) {
  if (v !== undefined && typeof v !== 'boolean') bad(`${name} 必须是布尔值`);
  return v === true;
}
function optNumOrNull(v, name) {
  if (absent(v)) return null;
  if (!isNum(v)) bad(`${name} 必须是数或 null`);
  return v;
}
function strArray(v, name) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`${name} 必须是字符串数组`);
  return [...v];
}
/** 「原样保存」的对象：深拷贝一份，拷不了（函数、循环里的怪东西）就当格式错误 */
function plainObject(v, name) {
  if (!isObj(v)) bad(`${name} 必须是对象`);
  try { return structuredClone(v); } catch { return bad(`${name} 无法复制`); }
}

function parseRange(v, name) {
  if (!isObj(v)) bad(`${name} 必须是对象`);
  const unit = oneOf(v.unit, RANGE_UNITS, `${name}.unit`);
  const from = int(v.from, `${name}.from`);
  const to = int(v.to, `${name}.to`);
  if (from < 0 || from > to) bad(`${name} 须满足 0 <= from <= to`);
  return { unit, from, to };
}

function parseWeight(v, name) {
  const w = plainObject(v, name);
  oneOf(w.class, WEIGHT_CLASSES, `${name}.class`);
  optNumOrNull(w.estMs, `${name}.estMs`);
  optNumOrNull(w.frames, `${name}.frames`);
  return w;
}

function parseTaskInput(v, i) {
  const at = `tasks[${i}]`;
  if (!isObj(v)) bad(`${at} 不是对象`);
  const id = nonEmpty(v.id, `${at}.id`);
  const kind = oneOf(v.kind, KINDS, `${at}.kind`);
  const resultKey = nonEmpty(v.resultKey, `${at}.resultKey`);
  // tier 只对 snapshot 有意义：snapshot 必填，其余忽略（不校验也不保存）
  const tier = kind === 'snapshot' ? oneOf(v.tier, TIERS, `${at}.tier`) : null;
  if (!isObj(v.source)) bad(`${at}.source 必须是对象`);
  const projectId = nonEmpty(v.source.projectId, `${at}.source.projectId`);
  const projectRev = int(v.source.projectRev, `${at}.source.projectRev`);
  const derivedFrom = optStr(v.source.derivedFrom, `${at}.source.derivedFrom`);
  let range = null;
  const priority = parsePriority(v.priority, `${at}.priority`);
  let input = absent(v.input) ? {} : plainObject(v.input, `${at}.input`);
  if (kind === 'plan') {
    if (!absent(v.range)) bad(`${at}.range：plan 任务没有范围，必须是 null`);
    const base = `${projectId}@${projectRev}`;
    if (resultKey.startsWith(`${base}${BACKFILL_KEY_MARK}`)) {
      // 预渲染重试计划任务（c10a 契约第 17 节）：带片段清单、标 backfill；不同的清单是不同的结果键
      if (!BACKFILL_SIG_RE.test(resultKey.slice(base.length + BACKFILL_KEY_MARK.length))) bad(`${at}.resultKey 的预渲染重试签名只能是 1～32 位小写字母与数字`);
      if (priority !== 'backfill') bad(`${at}.priority：预渲染重试计划任务必须标 'backfill'`);
      input = { ...input, clips: backfillClips(input.clips, `${at}.input.clips`) };
    } else if (resultKey.startsWith(`${base}${CLIPS_KEY_MARK}`)) {
      // 清单计划（C10 契约第 18 节第 9 条）：带片段清单、normal 档；预渲染重试档另用 #backfill: 的键
      if (!BACKFILL_SIG_RE.test(resultKey.slice(base.length + CLIPS_KEY_MARK.length))) bad(`${at}.resultKey 的清单签名只能是 1～32 位小写字母与数字`);
      if (priorityBand(priority) !== 'normal') bad(`${at}.priority：清单计划是 normal 档，预渲染重试用 #backfill: 的键`);
      input = { ...input, clips: backfillClips(input.clips, `${at}.input.clips`) };
      // 在线页面自报的用户卡、素材效果卡运行情况(块 N):只留合格的形状,不合格的整项去掉(任务照发,只是切分方不给浏览器出用户卡、素材效果卡的那一份)
      const browser = browserCardsOf(input.browser);
      if (browser) input = { ...input, browser }; else delete input.browser;
      // 页面看到这个项目的「生成轨道流」开着(见 `clipsPlanTaskOf`):只认布尔 true,别的值去掉
      if (input.streams !== true) delete input.streams;
    } else if (resultKey !== base) {
      bad(`${at}.resultKey 必须等于 source 的 projectId@projectRev`);
    }
  } else {
    range = parseRange(v.range, `${at}.range`);
  }
  // 流任务的密度只认 `'sparse'`;别的值去掉(当满密度),id 也照去掉之后的算
  if (input.density !== undefined && !(kind === 'stream' && input.density === STREAM_DENSITY_SPARSE)) {
    input = { ...input };
    delete input.density;
  }
  const expected = taskIdOf({ kind, resultKey, range, density: input.density });
  if (id !== expected) bad(`${at}.id 必须是 ${expected}`);
  return {
    // takeover 只决定这一次发布怎么处理锁（F.1），不存进任务，TaskView 里也没有
    takeover: optBool(v.takeover, `${at}.takeover`),
    id, kind, tier, resultKey, range,
    // source 里自报的 userId / tenantId / publisher / publishedAt 在这里就丢掉，由队列按连接填（A.4）
    source: { projectId, projectRev, derivedFrom },
    input,
    weight: absent(v.weight) ? null : parseWeight(v.weight, `${at}.weight`),
    requires: absent(v.requires) ? {} : plainObject(v.requires, `${at}.requires`),
    priority,
  };
}

/** `priority`：缺省 0；整数原样（旧形状）；或 `'normal'` / `'backfill'`（c10a 契约第 17 节） */
function parsePriority(v, name) {
  if (absent(v)) return 0;
  if (typeof v === 'string') return oneOf(v, new Set(PRIORITY_BANDS), name);
  return int(v, name);
}

/**
 * 清单计划的 `input.browser`(块 N,`docs/plan/online-card-exec-contract.md` 第 7 节第 3 条):在线页面自报「本页能运行哪些用户卡、素材效果卡」——
 *   { cardEnvFingerprint, userCards, graphCards, cardSources: { 卡片 id: 代码身份 } }
 * 页面自报的,不作数的部分由别处把关:纯浏览器节点只认领本人的任务,节点侧过滤(规则 1)还要再核卡片代码身份;
 * 谎报最坏的结果是切分方多出一份谁也认领不了的备份任务(同锁键的另一份会照旧被认领)。
 * 这里只规整形状:指纹必须是 16 位小写十六进制,卡片 id、代码身份是有长度上限的字符串,最多 `BROWSER_CARDS_MAX` 张;
 * 不合格回 null。缺省值与顺序固定(卡片 id 升序),同一份内容一定得到同一个对象与同一个签名。
 */
export const BROWSER_CARDS_MAX = 500;
const HEX16_RE = /^[0-9a-f]{16}$/;
export function browserCardsOf(v) {
  if (!isObj(v) || typeof v.cardEnvFingerprint !== 'string' || !HEX16_RE.test(v.cardEnvFingerprint)) return null;
  const cardSources = {};
  if (isObj(v.cardSources)) {
    for (const id of Object.keys(v.cardSources).sort().slice(0, BROWSER_CARDS_MAX)) {
      const version = v.cardSources[id];
      if (id === '' || id.length > 256 || typeof version !== 'string' || version === '' || version.length > 128) continue;
      cardSources[id] = version;
    }
  }
  return { cardEnvFingerprint: v.cardEnvFingerprint, userCards: v.userCards === true, graphCards: v.graphCards === true, cardSources };
}
/** `browserCardsOf` 的结果的摘要串(进清单计划的签名):与页面一侧 `planPublisher.ts` 的写法逐字相同 */
export function browserCardsSig(cards) {
  return [cards.cardEnvFingerprint, cards.userCards ? 1 : 0, cards.graphCards ? 1 : 0, ...Object.keys(cards.cardSources).sort().map((id) => `${id}=${cards.cardSources[id]}`)].join('|');
}

/** 预渲染重试计划任务的片段清单：非空、去重、升序的非空字符串数组 */
function backfillClips(v, name) {
  if (!Array.isArray(v) || v.length === 0 || v.length > BACKFILL_MAX_CLIPS) bad(`${name} 必须是 1～${BACKFILL_MAX_CLIPS} 个片段 id`);
  if (v.some((x) => typeof x !== 'string' || x === '')) bad(`${name} 的每一项都必须是非空字符串`);
  return [...new Set(v)].sort();
}

/** 这是不是预渲染重试计划任务（入站任务、TaskView、队列内部的任务都能传） */
export function isBackfillPlan(task) {
  return isObj(task) && task.kind === 'plan' && typeof task.resultKey === 'string' && task.resultKey.includes(BACKFILL_KEY_MARK);
}

/** 这是不是清单计划（在线页面发布的 normal 档 plan，C10 契约第 18 节第 9 条） */
export function isClipsPlan(task) {
  return isObj(task) && task.kind === 'plan' && typeof task.resultKey === 'string' && task.resultKey.includes(CLIPS_KEY_MARK);
}

/** 带片段清单的计划任务（预渲染重试计划或清单计划）：`host` 能认领，认领的节点按清单切分 */
export function isListPlan(task) {
  return isBackfillPlan(task) || isClipsPlan(task);
}

/**
 * 片段清单的签名（预渲染重试计划任务结果键的后缀）：升序去重后按 FNV-1a（32 位，两轮不同种子拼成 64 位）取 base36。
 * 同一份清单一定得到同一个键，页面与节点各算各的也对得上。纯函数，浏览器可以照抄。
 */
export function backfillSig(clips, extra) {
  const text = [...new Set(clips ?? [])].map(String).sort().join('\n') + (extra ? `\n\u0000${extra}` : '');
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  return fnv(0x811c9dc5).toString(36) + fnv(0x2f4a7c15).toString(36);
}

/** 预渲染重试计划任务（c10a 契约第 17 节）：带片段清单的 `plan`，标 `priority: 'backfill'`，不带 `requires` */
export function backfillPlanTaskOf({ projectId, projectRev, clips }) {
  const list = [...new Set(clips ?? [])].map(String).filter(Boolean).sort();
  const resultKey = `${projectId}@${projectRev}${BACKFILL_KEY_MARK}${backfillSig(list)}`;
  return {
    id: taskIdOf({ kind: 'plan', resultKey, range: null }), kind: 'plan', resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list }, weight: { class: 'medium', estMs: null, frames: null },
    requires: {}, priority: 'backfill',
  };
}

/** 清单计划的签名里「页面看到『生成轨道流』开着」的那一段(与页面一侧 `planPublisher.ts` 的写法逐字相同) */
export const LIST_STREAMS_SIG = 'streams=1';
/** 签名里几段附加内容之间的分隔(不会出现在卡片摘要里) */
const SIG_EXTRA_SEP = '\u0001';

/**
 * 清单计划（C10 契约第 7 节、第 18 节第 9 条）：在线页面自己判重的片段清单，normal 档。
 * `requires` 里不写 `envFingerprint`、不写 `preferNode`：任何能切分的节点（桌面版、独立渲染主机）都认领得了，
 * 由认领的节点用自己的指纹切分；`codeVersion` 给了才写（版本不同的节点不认领）。
 *
 * `streams: true`（任务书 `docs/plan/render-refactor-task.md`「甲三」，契约 `docs/plan/hosted-render-contract.md` 第 3.1 节）：页面看到这个项目的
 * 「生成轨道流」开着。这时签名里多一段、`input.streams` 为 true —— **同一版项目、同一份清单，这一项开着是另一个计划**：创建者刚打开时，
 * 那一版关着时发的计划已经做完，同一个结果键队列不会重切；换了键，托管方的渲染节点才会再切一次、出它自己的那一份流任务。
 * 不是 true（关着、旧页面、旧文档服务不报这一项）时结果键与 `input` 和没有这个参数时逐字相同，所以这一项一直关着的项目不受影响。
 * 这只是页面看到的状态：产不产仍由渲染节点照目录里的这一项定，页面自报的不作数。
 */
export function clipsPlanTaskOf({ projectId, projectRev, clips, codeVersion, browser, streams }) {
  const list = [...new Set(clips ?? [])].map(String).filter(Boolean).sort();
  const cards = browserCardsOf(browser);
  const on = streams === true;
  // 带 `input.browser` 时,签名里再加它的摘要:同一份清单,本页能运行的卡变了(转译好一张、换了代)就是另一个计划,切分方重新切
  const extra = [cards ? browserCardsSig(cards) : null, on ? LIST_STREAMS_SIG : null].filter((x) => x !== null).join(SIG_EXTRA_SEP);
  const resultKey = `${projectId}@${projectRev}${CLIPS_KEY_MARK}${backfillSig(list, extra || undefined)}`;
  return {
    id: taskIdOf({ kind: 'plan', resultKey, range: null }), kind: 'plan', resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list, ...(cards ? { browser: cards } : {}), ...(on ? { streams: true } : {}) }, weight: { class: 'medium', estMs: null, frames: null },
    requires: typeof codeVersion === 'string' && codeVersion ? { codeVersion } : {}, priority: 'normal',
  };
}

function parseResume(v) {
  if (absent(v)) return [];
  if (!Array.isArray(v)) bad('resume 必须是数组');
  return v.map((r, i) => {
    if (!isObj(r)) bad(`resume[${i}] 不是对象`);
    return { id: str(r.id, `resume[${i}].id`), token: int(r.token, `resume[${i}].token`) };
  });
}

/** 令牌类消息（progress / complete / release / fail）共有的两个字段 */
function tokenFields(m) {
  return { id: str(m.id, 'id'), token: int(m.token, 'token') };
}

const PARSERS = new Map([
  ['node.hello', (m) => ({
    nodeId: nonEmpty(m.nodeId, 'nodeId'),
    profile: oneOf(m.profile, PROFILES, 'profile'),
    envFingerprint: optStr(m.envFingerprint, 'envFingerprint'),
    // 纯浏览器节点执行用户卡、素材效果卡用的环境指纹(块 N):由文档服务按页面报的运行时版本算好再交进来,自报的不作数(`admitNodeHello`)
    cardEnvFingerprint: optStr(m.cardEnvFingerprint, 'cardEnvFingerprint'),
    capabilities: absent(m.capabilities) ? {} : plainObject(m.capabilities, 'capabilities'),
    codeVersions: absent(m.codeVersions) ? [] : strArray(m.codeVersions, 'codeVersions'),
    maxConcurrent: optInt(m.maxConcurrent, 'maxConcurrent'),
    resume: parseResume(m.resume),
  })],
  ['publisher.hello', (m) => ({ publisherId: nonEmpty(m.publisherId, 'publisherId') })],
  ['queue.watch', (m) => ({
    projects: m.projects === 'all' ? 'all' : strArray(m.projects, "projects（或 'all'）"),
  })],
  ['task.publish', (m) => {
    if (!Array.isArray(m.tasks) || m.tasks.length === 0) bad('tasks 必须是非空数组');
    return { tasks: m.tasks.map(parseTaskInput) };
  }],
  ['task.unsubscribe', (m) => {
    const byIds = m.ids !== undefined;
    const byProject = m.projectId !== undefined || m.projectRev !== undefined;
    if (byIds === byProject) bad('ids 与 projectId(+projectRev) 二选一');
    if (byIds) return { ids: strArray(m.ids, 'ids'), projectId: null, projectRev: null };
    return { ids: null, projectId: nonEmpty(m.projectId, 'projectId'), projectRev: optInt(m.projectRev, 'projectRev') };
  }],
  ['card.lock', (m) => ({
    kind: oneOf(m.kind, LOCK_KINDS, 'kind'),
    contentKey: nonEmpty(m.contentKey, 'contentKey'),
    envFingerprint: nonEmpty(m.envFingerprint, 'envFingerprint'),
    takeover: optBool(m.takeover, 'takeover'),
  })],
  ['task.claim', (m) => ({ id: str(m.id, 'id'), expectVersion: int(m.expectVersion, 'expectVersion') })],
  // done 可以是 null：节点会话在还没报过进度时续约，发的就是 done: null（契约 B.5）
  // step(可选):随节点的工作推进而变的计数(推块、换阶段、出批),变了也算报了进度(契约 A.12〔裁〕);旧节点不带
  ['task.progress', (m) => ({ ...tokenFields(m), done: optNumOrNull(m.done, 'done'), step: optNumOrNull(m.step, 'step') })],
  ['task.complete', (m) => ({ ...tokenFields(m), result: absent(m.result) ? null : plainObject(m.result, 'result') })],
  ['task.release', (m) => ({ ...tokenFields(m), reason: optStr(m.reason, 'reason') })],
  ['task.fail', (m) => {
    if (m.retryable !== undefined && typeof m.retryable !== 'boolean') bad('retryable 必须是布尔值');
    return { ...tokenFields(m), error: optStr(m.error, 'error'), retryable: m.retryable !== false };
  }],
  // M7 D2 补充〔裁〕:节点还在、在忙(busy 只作诊断:页面报 'bake' / 'stage')
  ['node.active', (m) => {
    const busy = optStr(m.busy, 'busy');
    if (busy !== null && busy.length > NODE_ACTIVE_BUSY_MAX) bad(`busy 不能超过 ${NODE_ACTIVE_BUSY_MAX} 个字符`);
    return { busy };
  }],
]);

/**
 * 校验一条入站消息。
 * 成功：`{ ok: true, type, reqId, body }`，`body` 是规范化的深拷贝；
 * 失败：`{ ok: false, reqId, detail }`，`reqId` 只在它本身合法时带回。
 */
export function parseInbound(message) {
  if (!isObj(message)) return { ok: false, reqId: undefined, detail: '消息不是对象' };
  const reqId = isReqId(message.reqId) ? message.reqId : undefined;
  try {
    if (message.reqId !== undefined && reqId === undefined) bad('reqId 只能是字符串或数字');
    const parse = typeof message.type === 'string' ? PARSERS.get(message.type) : undefined;
    if (!parse) bad(`未知的 type：${typeof message.type === 'string' ? message.type : `（${typeof message.type}）`}`);
    return { ok: true, type: message.type, reqId, body: parse(message) };
  } catch (err) {
    if (err instanceof BadMessage) return { ok: false, reqId, detail: err.message };
    throw err;
  }
}
