/**
 * M7 验收探针（`m7-browser-probe.mjs`）读页面节点诊断的**唯一适配处**。
 *
 * 契约 `docs/plan/m7-contract.md` 第 7 节只列了页面诊断「有哪些量」，没定字段名与形状；页面节点分支（`claude/rq-m7-node`）
 * 合入之前也看不到实现。探针照契约写、不看实现，凡是「契约没定形状」的读法都收在本文件：集成时对一遍页面节点的真实形状，
 * **只改这里**，探针主体不动。探针的判据尽量不靠这里：认领、续约、放回、完成、报到等一律从线上消息（CDP 抓的 WebSocket 帧）
 * 与文档服务的 `describe()` 判；这里读到的只作对照与补充（逐帧耗时、推了几块、页面自己记的放回原因）。
 *
 * 假设清单（`ASSUMPTIONS`，报告里原样列出）：每条写「假设什么」与「对不上时改哪一个函数」。
 */

/** 适配函数的假设（报告与结果 JSON 都带上） */
export const ASSUMPTIONS = Object.freeze([
  'A-1 页面诊断钩子是编辑器页（顶层文档）上的 `window.__pcBrowserNode()`，同步回一个可结构化克隆的对象（契约第 7 节只给了名字）；没有这个函数 = 页面节点代码不在。改 `readNodeDiag`。',
  "A-2 `state` 取值 `off` / `idle` / `busy` / `baking`（契约第 7 节原文），另有 `reason`（字符串，说明为什么 off）；`nodeId`、`envFingerprint`、`codeVersion` 平铺在顶层。改 `normalizeNodeDiag`。",
  'A-3 持有的任务在 `held`（或 `tasks`、`holding`）：数组，元素是任务 id 字符串或带 `id` 的对象。改 `normalizeNodeDiag` 的 `heldOf`。',
  'A-4 〔对账后，rq-m7-node 9774eda 报告「诊断形状」一节〕计数在 `counters`：`claims completed dedup failed lost bakedFrames`；放回在 `counters.released`，键是线上原因原文（`yield-play` `yield-drag` `yield-urgent` `yield-hidden` `no-snapshot` `offline` `unsupported`），按 `releaseCauseOf` 归类；节点侧过滤挡掉的在 `counters.blocked`（「规则号:原因」）；推送在 `upload`：`pushed skipped bytes failed reauth recheck`；小尺寸帧数在 `stage.smallFrames`。旧的猜测名（`counts`、`stats`、平铺）仍兜底。改 `countsOf`。',
  'A-5 〔对账后〕页面侧一帧（含推送）的耗时在 `counters.frameMs { n, p50, p95 }`；舞台侧在 `stage.frameMs`、`stage.pausedMs`（被门挡住的时长，不进耗时）。改 `countsOf`。',
  'A-6 最近一次错误在 `lastError`（字符串或 `{ message }`）。改 `normalizeNodeDiag`。',
  'A-7 舞台侧的生成快照诊断在舞台文档的 `window.__pcStageDiag().bake`（C10 已有 `__pcStageDiag`，`bake` 这一项是假设）：`{ frames, frameMs: { p50, p95 }, pausedMs }`。改 `readStageBakeDiag`。',
  "A-8 `task.release` 的放回原因（契约第 2 节、第 4.2 节只有 `no-snapshot` 一个写明了）：让路（拖动 / 播放）认 `yield` `busy` `interaction` `drag` `play`，页面隐藏认 `hidden` `visibility`，更急的后台活认 `urgent` `preempt` `measure` `catch-up`，取不到项目认 `no-snapshot`。认不出的记 `other`，判据里「放回 1 次」不看原因。改 `releaseCauseOf`。",
  'A-9 C10 已有的诊断照旧可读：`__pcPreviewDiag()`（`dual`、`frontId`、`backWork`）、`__pcOnlineSnapshots()`（`tier`、`layers[].{clipId, resultKey, envFingerprint, ready}`）、`__pcPlanPublisher()`（`log`）；这些不是本适配处的假设，但页面节点若改了它们的形状，探针在同名函数里读。',
]);

/** 在页面里取诊断（结构化克隆一遍，去掉函数与循环） */
const cloneIn = (page, name) => page.evaluate((fn) => {
  try {
    const f = window[fn];
    if (typeof f !== 'function') return { __missing: true };
    return JSON.parse(JSON.stringify(f() ?? null));
  } catch (error) {
    return { __error: String(error?.message ?? error).slice(0, 200) };
  }
}, name).catch((error) => ({ __error: String(error?.message ?? error).slice(0, 200) }));

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

function heldOf(raw) {
  const list = pick(raw, 'held', 'tasks', 'holding', 'holds');
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'string' ? x : x?.id ?? null)).filter((x) => typeof x === 'string');
}

function countsOf(raw) {
  const c = pick(raw, 'counters', 'counts', 'stats') ?? raw ?? {};
  const up = pick(raw, 'upload') ?? c;
  const st = pick(raw, 'stage') ?? {};
  const relRaw = pick(c, 'released', 'releases') ?? {};
  // 放回：键是线上原因原文（yield-play …），按 releaseCauseOf 归类；旧猜测的已归类键（yield、hidden …）原样认
  const released = { yield: 0, hidden: 0, urgent: 0, noSnapshot: 0, other: 0, raw: typeof relRaw === 'object' ? { ...relRaw } : relRaw };
  if (relRaw && typeof relRaw === 'object') {
    for (const [k, v] of Object.entries(relRaw)) {
      const cause = ['yield', 'hidden', 'urgent', 'noSnapshot'].includes(k) ? k : releaseCauseOf(k);
      released[cause in released ? cause : 'other'] += Number(v) || 0;
    }
  }
  released.total = released.yield + released.hidden + released.urgent + released.noSnapshot + released.other;
  const ms = pick(c, 'frameMs', 'bakeMs', 'bakeFrameMs') ?? {};
  const sms = pick(st, 'frameMs') ?? {};
  return {
    claimed: num(pick(c, 'claims', 'claimed')),
    completed: num(pick(c, 'completed', 'done')),
    dedup: num(pick(c, 'dedup', 'deduped')),
    failed: num(pick(c, 'failed', 'failures')),
    lost: num(pick(c, 'lost', 'leaseLost')),
    released,
    blocked: pick(c, 'blocked') ?? null,
    bakeFrames: num(pick(c, 'bakedFrames', 'bakeFrames', 'frames')),
    bakeMs: { n: num(pick(ms, 'n')), p50: num(pick(ms, 'p50')), p95: num(pick(ms, 'p95')) },
    stageMs: { p50: num(pick(sms, 'p50')), p95: num(pick(sms, 'p95')), pausedMs: num(pick(st, 'pausedMs')) },
    chunksPushed: num(pick(up, 'pushed', 'chunksPushed')),
    chunksSkipped: num(pick(up, 'skipped', 'chunksSkipped')),
    bytesPushed: num(pick(up, 'bytes', 'bytesPushed')),
    uploadFailed: num(pick(up, 'failed')),
    smallFrames: num(pick(st, 'smallFrames') ?? pick(c, 'smallFrames')),
  };
}

/** 页面诊断原样 → 探针用的固定形状；`available` 为假表示页面上没有这个钩子（页面节点代码不在） */
export function normalizeNodeDiag(raw) {
  if (!raw || raw.__missing) return { available: false, reason: 'no-hook' };
  if (raw.__error) return { available: false, reason: `hook-error: ${raw.__error}` };
  const err = pick(raw, 'lastError', 'error');
  return {
    available: true,
    state: typeof raw.state === 'string' ? raw.state : null,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : null,
    envFingerprint: typeof raw.envFingerprint === 'string' ? raw.envFingerprint : null,
    codeVersion: typeof raw.codeVersion === 'string' ? raw.codeVersion : null,
    held: heldOf(raw),
    counts: countsOf(raw),
    lastError: err == null ? null : String(typeof err === 'object' ? err.message ?? JSON.stringify(err) : err).slice(0, 300),
  };
}

/** 读编辑器页的页面节点诊断（第 7 节「页面」） */
export async function readNodeDiag(page) {
  return normalizeNodeDiag(await cloneIn(page, '__pcBrowserNode'));
}

/** 读后台舞台的生成快照诊断（第 7 节「舞台」）；两个舞台都读，回 `{ A: …, B: … }`（读不到的是 null） */
export async function readStageBakeDiag(page) {
  const out = {};
  for (const f of page.frames()) {
    let id = null;
    try { const u = new URL(f.url()); if (u.searchParams.get('stage') !== '1') continue; id = u.searchParams.get('id') ?? '?'; } catch { continue; }
    out[id] = await f.evaluate(() => {
      try {
        const d = window.__pcStageDiag?.();
        const b = d?.bake;
        if (!b) return null;
        return JSON.parse(JSON.stringify({ role: d.role ?? null, frames: b.frames ?? null, frameMs: b.frameMs ?? b.ms ?? null, pausedMs: b.pausedMs ?? null }));
      } catch { return null; }
    }).catch(() => null);
  }
  return out;
}

/**
 * `task.release` 的原因 → 探针的分类（A-8）。线上消息是契约定的（`{ type: 'task.release', id, token, reason }`），
 * 原因字符串契约只写了 `no-snapshot`。
 */
export function releaseCauseOf(reason) {
  const r = String(reason ?? '').toLowerCase();
  if (!r) return 'other';
  if (/no-?snapshot|no-?project/.test(r)) return 'noSnapshot';
  if (/hidden|visib|pagehide|frozen|freeze/.test(r)) return 'hidden';
  if (/urgent|preempt|measure|catch-?up|probe|backfill/.test(r)) return 'urgent';
  if (/yield|busy|interact|drag|scrub|play|seek/.test(r)) return 'yield';
  if (/stop|leave|offline|shutdown|close/.test(r)) return 'stop';
  return 'other';
}
