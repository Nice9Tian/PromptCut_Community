import { mergeRanges } from './snapshot-store.mjs';

/**
 * C3 就绪索引:**按层**记「这一层现在有哪些本地帧」,并把变化推给页面。
 *
 * 一层 = (片段 clipId, 档位 kind)。同一张重卡的 `stream` 表和 `html` 表并存、
 * 互不覆盖 —— 播放贴流、拖动贴快照,两条路各查各的。
 *
 * # 档位名的三处同义
 *
 *   目录 `controls-html`  ↔ `snapshotTier()` 的 `'shared'` ↔ 线上 `kind: 'html'`
 *   目录 `controls-local` ↔ `snapshotTier()` 的 `'local'`  ↔ 线上 `kind: 'local'`
 *   轨道流(R8)                                            ↔ 线上 `kind: 'stream'`
 *
 * `snapshotTier` 的返回值由调用方用 `kindOfTier` 映射成 `kind`。K1 记录里的
 * `kind: 'random' | 'stepped'` 是探针方法,同字不同物。
 *
 * # 消息三种(格式定死,C3)
 *
 *   { type: 'reset', localRev }                       项目版本换了,页面清表
 *   { type: 'layer', clipId, kind, key, ranges, groupClipIds?, originFrame?, streamKind?, inputSig? }
 *                                                     该层当前**全部**就绪的本地帧
 *                                                     闭区间,**每次发全量、不发增量**
 *                                                     `stream` 层的区间单位是分段号,另带 `originFrame`:
 *                                                     这条流自己的第一帧(项目帧号),页面按它把帧号换成
 *                                                     分段号(`src/render/streamSegments.mjs`);不带的
 *                                                     `stream` 层页面不贴
 *   { type: 'done', localRev }                        锚帧全部就绪(C2 的门槛)
 *
 * 全量语义是刻意的:一条消息丢了不会让页面的表永远缺一段,下一条同层消息就补回来;
 * 重连时服务端先发 `reset` 再发全量 `layer`,所以不需要轮询端点(J3 / F5 共用这条路)。
 *
 * # 为什么 `layer` 要等项目到位(F5)
 *
 * 扫盘只得到「键 → 区间」:目录名是剥掉 clipId 的共享键,而 `layer` 和页面的
 * `readyIndex` 都按 clipId 索引。所以重启后先把区间挂在键上(`stageByKey`),
 * 等 card plan 算出来(`control.clipId` ↔ `control.snapshotKey`)再反查、
 * 全量 `layer`。项目没到之前一条 `layer` 都不发。
 *
 * # 按会话分片(Item 4)
 *
 * 预渲染进程里是 `createReadyHub`:每个页面会话一份索引,会话的当前版本只由页面的 preload 设定,
 * 发层按 entry 过闸。见文件末尾 `createReadyHub` 的说明。
 */

/** `snapshotTier()` → 线上的 `kind`;不产快照的档回 null */
export function kindOfTier(tier) {
  if (tier === 'shared') return 'html';
  if (tier === 'local') return 'local';
  return null;
}

export const READY_KINDS = ['html', 'local', 'stream'];

/**
 * 线上的 `key`(C3 / J3):共享档就是共享键;本地档**自带一个斜杠** ——
 * `<entry.key>/<共享键>`,因为同一个共享键在不同项目下各有一棵本地档子树。
 * 目录形状(`snapshot-store.mjs` 的两层目录)和线上的键在这里对齐,只此一处。
 */
export function wireSnapshotKey(tier, entryKey, snapshotKey) {
  if (!snapshotKey) return null;
  if (tier === 'shared') return snapshotKey;
  if (tier === 'local') return entryKey ? `${entryKey}/${snapshotKey}` : null;
  return null;
}

const layerId = (clipId, kind) => `${kind}:${clipId}`;
/** `stream` 层带的第一帧(非负整数才带);别的档位不带这一项 */
const originOf = (kind, originFrame) => (kind === 'stream' && Number.isInteger(originFrame) && originFrame >= 0 ? { originFrame } : {});
/**
 * 依赖下层的流的层另带的两项(`server/frame-stream.mjs` 的 `belowLayerMark`):`streamKind: 'below'`(页面按舞台坐标贴)和
 * `inputSig`(产这条流的那一版项目的输入签名,页面对不上就不贴)。别的层、别的档位不带,发出去的消息一个字不变。
 */
const belowOf = (kind, item) => (kind === 'stream' && item?.streamKind === 'below'
  ? { streamKind: 'below', ...(typeof item.inputSig === 'string' && item.inputSig ? { inputSig: item.inputSig } : {}) } : {});

/**
 * `staged`:还没认领的「键 → 区间」。缺省每个索引自带一份;按会话分片时(`createReadyHub`)
 * 所有会话共用 hub 的那一份 —— 扫盘和轨道流挂上去的区间是内容寻址的,和哪个会话无关。
 */
export function createReadyIndex({ staged: shared = null } = {}) {
  const staged = shared ?? new Map();
  /** layerId -> { clipId, kind, key, ranges, groupClipIds?, originFrame?, streamKind?, inputSig? } */
  const layers = new Map();
  const subscribers = new Set();
  let localRev = 0;
  let done = false;

  function emit(message) {
    for (const send of subscribers) { try { send(message); } catch { /* 一个订阅者断了不影响别人 */ } }
  }

  /** 项目版本换了:清表、通知页面清表。`layer` 从这一刻起重新长。 */
  function reset(rev = localRev) {
    localRev = Number(rev) || 0;
    layers.clear();
    done = false;
    emit({ type: 'reset', localRev });
  }

  /**
   * 把这一批新帧并进某一层,并发一条**全量** `layer`。
   * `frames` 可以是帧号、闭区间,或两者混排(`mergeRanges` 的口径)。
   */
  function addFrames({ clipId, kind, key, frames, groupClipIds = undefined, originFrame = undefined, streamKind = undefined, inputSig = undefined }) {
    if (!clipId || !READY_KINDS.includes(kind) || !key) return null;
    const id = layerId(clipId, kind);
    const before = layers.get(id);
    // 换了键(卡的参数变了)就从头记:旧键的区间和新键没有关系
    const base = before && before.key === key ? before.ranges : [];
    const ranges = mergeRanges([...base, ...(frames ?? [])]);
    const layer = { clipId, kind, key, ranges, ...(groupClipIds ? { groupClipIds } : {}), ...originOf(kind, originFrame), ...belowOf(kind, { streamKind, inputSig }) };
    layers.set(id, layer);
    emit({ type: 'layer', ...layer });
    return layer;
  }

  /** 整层直接给一份区间表(F5 的重建路);和 `addFrames` 一样发全量 `layer`。 */
  function setLayer({ clipId, kind, key, ranges, groupClipIds = undefined, originFrame = undefined, streamKind = undefined, inputSig = undefined }) {
    if (!clipId || !READY_KINDS.includes(kind) || !key) return null;
    const layer = { clipId, kind, key, ranges: mergeRanges(ranges), ...(groupClipIds ? { groupClipIds } : {}), ...originOf(kind, originFrame), ...belowOf(kind, { streamKind, inputSig }) };
    layers.set(layerId(clipId, kind), layer);
    emit({ type: 'layer', ...layer });
    return layer;
  }

  /** 锚帧全部就绪(C2 的门槛)。重复调只发一次。 */
  function markDone() {
    if (done) return;
    done = true;
    emit({ type: 'done', localRev });
  }

  /** 扫盘得到的「键 → 区间」:先挂着,等 card plan 到位再认领(F5) */
  function stageByKey({ kind, key, ranges }) {
    if (!READY_KINDS.includes(kind) || !key) return;
    const id = `${kind}:${key}`;
    const before = staged.get(id);
    staged.set(id, { kind, key, ranges: mergeRanges([...(before?.ranges ?? []), ...(ranges ?? [])]) });
  }

  /**
   * card plan 到位:用 `control.clipId` ↔ `control.snapshotKey` 把挂着的区间认领成层。
   * `layers` = [{ clipId, kind, key, originFrame? }],`key` 已经是**线上的键**(本地档是
   * `<entry.key>/<共享键>`,C3),由调用方用 `wireSnapshotKey` 拼好;`stream` 层的 `originFrame` 由调用方按这一版的
   * 流计划给(挂着的「键 → 区间」里没有它:它是这条流在这一版项目里的位置,不是流库里的东西)。返回认领了几层。
   *
   * 认领是**全量重发**:先 `reset`(页面清表),再对每一层发一条 `layer`。这和 C3
   * 的语义一致,所以不需要新端点。
   */
  function claim(layers_, rev = localRev) {
    const claimed = [];
    for (const item of layers_ ?? []) {
      if (!READY_KINDS.includes(item?.kind) || !item.clipId || !item.key) continue;
      const hit = staged.get(`${item.kind}:${item.key}`);
      if (!hit?.ranges?.length) continue;
      claimed.push({ clipId: item.clipId, kind: item.kind, key: item.key, ranges: hit.ranges, ...originOf(item.kind, item.originFrame), ...belowOf(item.kind, item) });
    }
    if (!claimed.length) return 0;
    localRev = Number(rev) || 0;
    layers.clear();
    done = false;
    emit({ type: 'reset', localRev });
    for (const layer of claimed) {
      layers.set(layerId(layer.clipId, layer.kind), layer);
      emit({ type: 'layer', ...layer });
    }
    return claimed.length;
  }

  /**
   * 按会话分片之后的认领(`createReadyHub().claim`):**不 reset**,把挂着的区间并进已有的层
   * (同一层同一个键时取并集,键不同就以挂着的为准),只对真的变了的层发全量 `layer`。
   * 会话换版本时的清表由 `reset` 单独做(hub 的 `adopt`),认领只负责「补」。返回变了几层。
   */
  function absorb(layers_) {
    let changed = 0;
    for (const item of layers_ ?? []) {
      if (!READY_KINDS.includes(item?.kind) || !item.clipId || !item.key) continue;
      const hit = staged.get(`${item.kind}:${item.key}`);
      if (!hit?.ranges?.length) continue;
      const id = layerId(item.clipId, item.kind);
      const before = layers.get(id);
      const ranges = mergeRanges([...(before?.key === item.key ? before.ranges : []), ...hit.ranges]);
      const origin = originOf(item.kind, item.originFrame ?? (before?.key === item.key ? before.originFrame : undefined));
      // 依赖下层的流的两项:认领表带了就用它的(这一版计划给的),没带、键又没变就留着原来那一层的
      const below = belowOf(item.kind, item.streamKind ? item : (before?.key === item.key ? before : null));
      if (before?.key === item.key && JSON.stringify(before.ranges) === JSON.stringify(ranges) && before.originFrame === origin.originFrame
        && before.streamKind === below.streamKind && before.inputSig === below.inputSig) continue;
      const layer = { clipId: item.clipId, kind: item.kind, key: item.key, ranges,
        ...(before?.key === item.key && before.groupClipIds ? { groupClipIds: before.groupClipIds } : {}), ...origin, ...below };
      layers.set(id, layer);
      emit({ type: 'layer', ...layer });
      changed++;
    }
    return changed;
  }

  /** 连上 SSE 时先灌的那一份:`reset` + 每层一条全量 `layer`(+ 已经 done 的话再一条) */
  function backlog() {
    const out = [{ type: 'reset', localRev }];
    for (const layer of layers.values()) out.push({ type: 'layer', ...layer });
    if (done) out.push({ type: 'done', localRev });
    return out;
  }

  function subscribe(send) {
    subscribers.add(send);
    for (const message of backlog()) { try { send(message); } catch { /* 刚连上就断了 */ } }
    return () => subscribers.delete(send);
  }

  return {
    reset, addFrames, setLayer, markDone, stageByKey, claim, absorb, backlog, subscribe,
    get localRev() { return localRev; },
    set localRev(value) { localRev = Number(value) || 0; },
    get done() { return done; },
    /** 测试 / 探针用 */
    list: () => [...layers.values()].map(layer => ({ ...layer })),
    stagedKeys: () => [...staged.values()].map(item => ({ ...item })),
    subscriberCount: () => subscribers.size,
    // 共用的 `staged` 属于 hub,一个会话清不掉别的会话要认领的东西
    clear: () => { layers.clear(); if (!shared) staged.clear(); done = false; },
  };
}

/** 不带 session 的调用方(脚本、探针、迁移期带整份 `project` 的页面)共用的那个会话 */
export const DEFAULT_READY_SESSION = '';
/** 没有订阅者、也这么久没发过 preload 的会话被回收 */
export const READY_SESSION_IDLE_MS = 10 * 60 * 1000;
/** 同时记着的会话上限;超了先回收最久没动静、又没有订阅者的 */
export const READY_SESSION_MAX = 64;
/** 共用 `staged` 里最多挂这么多个键(一个键一小段区间表) */
export const READY_STAGED_MAX = 20000;
/** 会话 id 的长度上限(`/ready` 和 `/preload` 共用一个校验) */
export const READY_SESSION_ID_MAX = 200;

/** 页面带来的 session 参数:缺省 / 空 = 缺省会话;超长或不是字符串 = null(调用方回 400) */
export function readySessionOf(value) {
  if (value === undefined || value === null) return DEFAULT_READY_SESSION;
  if (typeof value !== 'string' || value.length > READY_SESSION_ID_MAX) return null;
  return value;
}

/**
 * 按会话分片的就绪索引(Item 4,`docs/reports/REPORT-item4-session-isolation.md`)。
 *
 * 每个页面会话(镜像的 `session`)一份 `createReadyIndex`,`/api/frames/ready?session=` 只订阅自己那份。
 * 会话的「当前版本」(`entryKey`)**只由页面发起的 `preload` 设定**(`adopt`),别的渲染
 * (Agent 查询、导出、交互帧)不认领、不 reset 任何会话的索引。
 *
 * 发布一律带上它属于的 entry(`publish(entryKey, layer)`):只写进当前版本正是这个 entry 的会话,
 * 其余丢弃 —— 旧版本晚到的批次、别的会话 / 后台任务渲的版本都进不来。
 *
 * 扫盘(F5)和轨道流挂上去的「键 → 区间」是内容寻址的,所有会话共用一份 `staged`。
 */
export function createReadyHub({ now = () => Date.now(), idleMs = READY_SESSION_IDLE_MS, maxSessions = READY_SESSION_MAX, maxStaged = READY_STAGED_MAX } = {}) {
  const staged = new Map();
  /** id -> { id, index, entryKey, localRev, seenAt, ticket } */
  const sessions = new Map();
  let tickets = 0;

  const norm = id => (typeof id === 'string' ? id : id == null ? DEFAULT_READY_SESSION : String(id));

  function session(id) {
    id = norm(id);
    let record = sessions.get(id);
    if (!record) {
      record = { id, index: createReadyIndex({ staged }), entryKey: undefined, localRev: undefined, seenAt: now(), ticket: 0,
        pendingReset: false, pendingRev: undefined };
      sessions.set(id, record);
      prune(id);
    }
    return record;
  }

  /**
   * 回收:没有订阅者、`idleMs` 内没动静的会话删掉;还超上限就按最久没动静的顺序删(同样只删没有订阅者的)。
   * `keep` 是正在用的那个会话,不删。
   */
  function prune(keep) {
    const t = now();
    for (const [id, record] of sessions) {
      if (id === keep || record.index.subscriberCount() > 0) continue;
      if (t - record.seenAt > idleMs) sessions.delete(id);
    }
    if (sessions.size <= maxSessions) return;
    const idle = [...sessions.values()].filter(r => r.id !== keep && r.index.subscriberCount() === 0).sort((a, b) => a.seenAt - b.seenAt);
    for (const record of idle) {
      if (sessions.size <= maxSessions) break;
      sessions.delete(record.id);
    }
  }

  /**
   * 页面的 preload 刚到:先领一张号。`adopt` 只认最新一张号 —— 两个 preload 在 `await entry()`
   * 那一段交错完成时,晚发出的那个版本赢,不是晚算完的那个。
   */
  function request(id) {
    const record = session(id);
    record.seenAt = now();
    record.ticket = ++tickets;
    return record.ticket;
  }

  /**
   * 这张号 / 这个 localRev 已经被更新的 preload 取代了吗(取代了就既不认领、也不该再排后台活)。
   * 会话在领号之后被回收、又重建了(`ticket === 0`)时不算取代 —— 没有更新的请求。
   */
  function stale(id, ticket, localRev) {
    const record = sessions.get(norm(id));
    if (!record) return false;
    if (ticket !== undefined && record.ticket !== 0 && ticket !== record.ticket) return true;
    const rev = Number(localRev);
    return localRev != null && Number.isFinite(rev) && Number.isFinite(record.localRev) && rev < record.localRev;
  }

  /**
   * 设定会话的当前版本(**只有页面的 preload 调**)。版本换了就 reset 这个会话的索引(页面清表);
   * 版本没换只记新的 `localRev`,不清表。回 `true` = 换了版本。
   *
   * 过期的号(`ticket` 不是这个会话最新的那张)或更旧的 `localRev` 一律不认。
   */
  function adopt(id, entryKey, localRev, ticket, { defer = false } = {}) {
    const record = session(id);
    record.seenAt = now();
    if (stale(id, ticket, localRev)) return false;
    const rev = localRev == null ? NaN : Number(localRev);
    if (Number.isFinite(rev)) record.localRev = rev;
    if (record.entryKey === entryKey) {
      if (Number.isFinite(rev) && !record.pendingReset) record.index.localRev = rev;
      if (Number.isFinite(rev) && record.pendingReset) record.pendingRev = rev;
      return false;
    }
    // 闸门当场换到新版本:从这一刻起旧版本的发布一律进不来
    record.entryKey = entryKey;
    const target = Number.isFinite(rev) ? rev : record.index.localRev;
    if (defer) {
      // 新版本的计划还没算出来,这时清表页面只会空等几秒(重卡一路退到占位符)。表先留着
      // (「沿用旧的预渲染结果」),等这一版第一次往这个会话里写东西(认领 / 发层 / done)时再 reset,
      // reset 和补回来的层是紧挨着的一串消息
      record.pendingReset = true;
      record.pendingRev = target;
    } else {
      record.pendingReset = false;
      record.index.reset(target);
    }
    return true;
  }

  /** 挂着的 reset 在这一版第一次写进会话之前补上 */
  function flush(record) {
    if (!record.pendingReset) return;
    record.pendingReset = false;
    record.index.reset(record.pendingRev ?? record.index.localRev);
  }

  function sessionsOn(entryKey) {
    if (!entryKey) return [];
    return [...sessions.values()].filter(record => record.entryKey === entryKey);
  }

  /**
   * 发一层:只写进当前版本是 `entryKey` 的会话。回写进了几个会话(0 = 丢弃)。
   *
   * 不论有没有会话收下,区间都挂进 `staged`:键是内容寻址的(本地档的键自带 entry.key),
   * 挂着不会串到别的版本 —— 只有 card plan 里同一个键的片段才认领得到。这样会话换回某一版
   * (撤销、页面刷新成新会话)时 `adopt` + 认领当场就能把这一版已有的层全补回来,不必等后台重跑。
   */
  function publish(entryKey, layer) {
    stageByKey(layer);
    let n = 0;
    for (const record of sessionsOn(entryKey)) { flush(record); if (record.index.setLayer(layer)) n++; }
    return n;
  }

  /** 当前版本是 `entryKey` 的会话都清一次表(版本没换、只是这一版要撤掉某些层时用),localRev 不变 */
  function resetOn(entryKey) {
    for (const record of sessionsOn(entryKey)) {
      if (record.pendingReset) { flush(record); continue; }
      record.index.reset(record.index.localRev);
    }
  }

  function markDone(entryKey) {
    for (const record of sessionsOn(entryKey)) { flush(record); record.index.markDone(); }
  }

  /**
   * card plan 到位:把挂着的区间认领进当前版本是 `entryKey` 的会话。已经在这一版上的会话不 reset
   * (见 `absorb`);刚换过来、reset 还挂着的会话先 reset 再补 —— 页面看到的是紧挨着的一串。
   */
  function claim(entryKey, layers) {
    let n = 0;
    for (const record of sessionsOn(entryKey)) { flush(record); n += record.index.absorb(layers); }
    return n;
  }

  /** 挂着的键按最近使用排序,超过 `maxStaged` 丢最久没动的(Map 的插入顺序就是 LRU 顺序) */
  function stageByKey({ kind, key, ranges }) {
    if (!READY_KINDS.includes(kind) || !key) return;
    const id = `${kind}:${key}`;
    const before = staged.get(id);
    staged.delete(id);
    staged.set(id, { kind, key, ranges: mergeRanges([...(before?.ranges ?? []), ...(ranges ?? [])]) });
    while (staged.size > maxStaged) staged.delete(staged.keys().next().value);
  }

  /**
   * 摘掉挂着的键(帧库淘汰删了它的目录之后,`frame-library-storage.mjs`):`key` 摘一个,`prefix` 摘这一族里
   * 键以它开头的全部(本地档的键是 `<entry.key>/<共享键>`)。已经发进会话的层不动 —— 被删的只会是没开着的版本。
   */
  function unstage({ kind, key, prefix } = {}) {
    if (!READY_KINDS.includes(kind)) return 0;
    let n = 0;
    if (key) { if (staged.delete(`${kind}:${key}`)) n++; }
    else if (prefix) for (const [id, item] of staged) if (item.kind === kind && item.key.startsWith(prefix)) { staged.delete(id); n++; }
    return n;
  }

  /** `/api/frames/ready?session=` 的订阅。退订后这个会话按 `idleMs` 回收 */
  function subscribe(id, send) {
    const record = session(id);
    record.seenAt = now();
    const off = record.index.subscribe(send);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      record.seenAt = now();
      prune();
    };
  }

  return {
    session: id => session(id),
    peek: id => sessions.get(norm(id)),
    current: id => sessions.get(norm(id))?.entryKey,
    request, stale, adopt, publish, resetOn, markDone, claim, stageByKey, unstage, subscribe, prune, sessionsOn,
    drop: id => sessions.delete(norm(id)),
    sessionCount: () => sessions.size,
    stagedKeys: () => [...staged.values()].map(item => ({ ...item })),
    /** 诊断读口 */
    describe: () => [...sessions.values()].map(r => ({ session: r.id, entryKey: r.entryKey ?? null, localRev: r.localRev ?? null, pendingReset: r.pendingReset,
      subscribers: r.index.subscriberCount(), layers: r.index.list().length, done: r.index.done, seenAt: r.seenAt })),
  };
}
