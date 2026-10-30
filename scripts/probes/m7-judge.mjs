/**
 * M7 验收探针（`m7-browser-probe.mjs`）里 D1-D2-D12 那一项的纯判据：不起进程、不连网络，单测在 `server/test/m7-judge.test.mjs`。
 *
 * 一张卡的「出键」= 任务要求的环境指纹（pc 的、页面的）。切分方对浏览器可做的卡按两种出键各出一份（D1），先认领者得卡、
 * 另一份整份作废。页面同时持几张卡的锁、一次只做一段时，没轮到的卡锁闲置超过 30 s 会被切分方按 D2 用自己的出键接手：
 * 被接手那份已做完的段留着有效、没做的段作废，接手方的出键从头出全一份。所以按出键分组判（主会话 2026-09-28）：
 *   - 有一组「每段恰好一份有效」覆盖全部段（得卡的那一组）；
 *   - 其余组要么整份作废（先认领者得卡的常规情形），要么部分作废（中途被 D2 接手：只作说明，不算失败）；
 *   - 层表 v3 这一层的候选里两组都在，这一层最终指向单一指纹（候选之一）。
 * 旧判据（所有出键合起来每段恰好一份有效）在中途接手时会把 0-59 这类两组都有效的段判成 `0-59:2`，那是 D2 的设计行为。
 */

/**
 * @param {{ groups: Record<string, Array<{ range: string, live: boolean }>>, candidates?: string[], layerFp?: string | null }} clip
 *   `groups`：出键名（'pc' / 'page' 或指纹）→ 这一出键下的每段是否有效（没被作废）；`candidates`：层表这一层候选的出键名；
 *   `layerFp`：层表这一层最终指向的出键名（层上的 `envFingerprint` 换成出键名）
 * @returns {{ ok: boolean, winner: string | null, fullySuperseded: string[], takenOverMidway: string[], badRanges: string[], reasons: string[] }}
 */
export function judgeDualClip({ groups, candidates = [], layerFp = null }) {
  const reasons = [];
  const names = Object.keys(groups ?? {}).filter((k) => (groups[k] ?? []).length > 0);
  const allRanges = [...new Set(names.flatMap((k) => groups[k].map((t) => t.range)))].sort();
  const liveCount = (k, r) => groups[k].filter((t) => t.range === r && t.live).length;
  // 同一出键下每段恰好一份有效、且覆盖全部段的组
  const full = names.filter((k) => allRanges.every((r) => liveCount(k, r) === 1));
  const fullySuperseded = names.filter((k) => groups[k].every((t) => !t.live));
  const takenOverMidway = names.filter((k) => !full.includes(k) && groups[k].some((t) => t.live) && groups[k].some((t) => !t.live));
  const badRanges = [];
  for (const k of names) for (const r of allRanges) if (liveCount(k, r) > 1) badRanges.push(`${k}:${r}:${liveCount(k, r)}`);
  if (names.length < 2) reasons.push('没有两种出键');
  if (full.length !== 1) reasons.push(full.length === 0 ? '没有哪一组出键每段恰好一份有效' : '两组出键都整份有效（没有作废）');
  const others = names.filter((k) => !full.includes(k));
  if (others.some((k) => !fullySuperseded.includes(k) && !takenOverMidway.includes(k))) reasons.push('另一组既不是整份作废也不是中途被接手');
  if (badRanges.length) reasons.push('同一出键下有段不止一份有效');
  if (!names.every((k) => candidates.includes(k))) reasons.push('层表候选里缺一组');
  if (!layerFp || !names.includes(layerFp)) reasons.push('层表这一层没有指向其中一组');
  return { ok: reasons.length === 0, winner: full.length === 1 ? full[0] : null, fullySuperseded, takenOverMidway, badRanges, reasons };
}

/** Current describe wins over history. A vanished task is not evidence of success:
 * require both the publisher's explicit superseded reason and the watcher's latest
 * failed event. Reopening clears that terminal event in the probe. */
export function observedSuperseded({ current, closed, publisher, history }) {
  if (current) return current.state === 'failed' && current.lastError === 'superseded';
  return publisher?.type === 'task.failed' && publisher.error === 'superseded'
    && closed?.state === 'failed' && history?.state === 'failed'
    && history.completeFirstGeneration === true && typeof history.epoch === 'string'
    && publisher.epoch === history.epoch;
}

/** Missing records can use history only when the entire first publication was
 * observed on one uninterrupted stream. Versions reset to 1 after recreation;
 * neither a snapshot nor a repeated version proves that this is the same task. */
export function createTaskObservationHistory() {
  const records = new Map();
  let continuous = true, epoch = null, seq = 0;
  const invalidate = () => { continuous = false; };
  const record = (id, type, state, version, isOpen) => {
    let item = records.get(id);
    if (!item) {
      item = { generation: type === 'task.opened' ? 1 : null, firstType: type, state: null, gap: false, timeline: [] };
      records.set(id, item);
    } else if (isOpen && ['failed', 'done', 'removed', 'hidden'].includes(item.state)) {
      item.generation = item.generation === null ? null : item.generation + 1;
    } else if (type === 'task.taken' && ['failed', 'done', 'removed', 'hidden'].includes(item.state)) {
      item.gap = true; // a reopen was not observed
    }
    if (state === 'hidden') item.gap = true;
    item.state = state;
    item.timeline.push({ seq, type, state, version: version ?? null });
    if (item.timeline.length > 16) item.timeline.shift();
  };
  return {
    invalidate,
    note(message) {
      seq++;
      if (typeof message.epoch === 'string') {
        if (epoch !== null && epoch !== message.epoch) invalidate();
        epoch = message.epoch;
      }
      if (message.type === 'queue.snapshot') {
        for (const task of message.tasks ?? []) record(task.id, message.type, task.state ?? 'open', task.version, true);
      } else if (message.type === 'task.opened' && message.task?.id) {
        record(message.task.id, message.type, 'open', message.task.version, true);
      } else if (message.id && message.type === 'task.closed') {
        record(message.id, message.type, message.state, message.version, false);
      } else if (message.id && message.type === 'task.taken') {
        record(message.id, message.type, 'claimed', message.version, false);
      }
    },
    proof(id) {
      const item = records.get(id);
      return item ? { ...item, timeline: item.timeline.map(e => ({ ...e })), continuous, epoch,
        completeFirstGeneration: continuous && !item.gap && item.firstType === 'task.opened' && item.generation === 1 } : null;
    },
  };
}

/** Observe the page's actual chosen layers, preserving the first (possibly stale)
 * sample. The existing A4 deadline bounds this wait; no elapsed time implies pass. */
export async function observeLayerEnvironments(read, { clips, fingerprint, timeoutMs, pollMs = 250,
  now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const started = now();
  const pick = value => (value?.layers ?? []).map(l => ({ clip: l.clipId, fp: l.envFingerprint, ready: l.ready }));
  const matches = layers => !!fingerprint && clips.every(c => layers.find(l => l.clip === c)?.fp === fingerprint);
  const first = pick(await read());
  let layers = first, samples = 1;
  while (!matches(layers) && now() - started < timeoutMs) {
    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - (now() - started))));
    layers = pick(await read());
    samples++;
  }
  return { ok: matches(layers), first, layers, samples, waitedMs: now() - started };
}
