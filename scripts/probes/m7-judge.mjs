/**
 * Pure criterion for the D1-D2-D12 item in the M7 acceptance probe (`m7-browser-probe.mjs`):
 * starts no process, connects to no network, unit test in `server/test/m7-judge.test.mjs`.
 *
 * A card's "output key" = environment fingerprint required by the task (pc or page). The splitter
 * produces one copy for each of the two output keys for cards doable by the browser (D1); the first
 * to claim gets the card, and the other copy is invalidated in its entirety. When the page holds
 * locks for multiple cards simultaneously and works on only one segment at a time, card locks not
 * yet reached that stay idle for over 30 s are taken over by the splitter with its own output key
 * per D2: completed segments of the taken-over copy remain valid, unrendered segments are invalidated,
 * and the taking-over side's output key outputs a full set from scratch. Therefore evaluate grouped
 * by output key (lead session, 2026-09-28):
 *   - One group has "exactly one valid copy per segment" covering all segments (the group that won the card);
 *   - Remaining groups are either invalidated in their entirety (normal case where first claimer gets
 *     the card) or partially invalidated (taken over midway by D2: informational only, not a failure);
 *   - Both groups are among this layer's candidates in layer table v3, and this layer ultimately points
 *     to a single fingerprint (one of the candidates).
 * The old criterion (exactly one valid copy per segment across all output keys combined) would judge
 * segments like 0-59 that are valid in both groups as `0-59:2` during midway takeovers; that is D2's
 * designed behavior.
 */

/**
 * @param {{ groups: Record<string, Array<{ range: string, live: boolean }>>, candidates?: string[], layerFp?: string | null }} clip
 *   `groups`: output key name ('pc' / 'page' or fingerprint) → whether each segment under this
 *   output key is valid (not invalidated); `candidates`: output key names of candidates for this
 *   layer in the layer table;
 *   `layerFp`: output key name ultimately pointed to by this layer in the layer table
 *   (`envFingerprint` on the layer replaced with output key name)
 * @returns {{ ok: boolean, winner: string | null, fullySuperseded: string[], takenOverMidway: string[], badRanges: string[], reasons: string[] }}
 */
export function judgeDualClip({ groups, candidates = [], layerFp = null }) {
  const reasons = [];
  const names = Object.keys(groups ?? {}).filter((k) => (groups[k] ?? []).length > 0);
  const allRanges = [...new Set(names.flatMap((k) => groups[k].map((t) => t.range)))].sort();
  const liveCount = (k, r) => groups[k].filter((t) => t.range === r && t.live).length;
  // Group under the same output key with exactly one valid copy per segment and covering all segments
  const full = names.filter((k) => allRanges.every((r) => liveCount(k, r) === 1));
  const fullySuperseded = names.filter((k) => groups[k].every((t) => !t.live));
  const takenOverMidway = names.filter((k) => !full.includes(k) && groups[k].some((t) => t.live) && groups[k].some((t) => !t.live));
  const badRanges = [];
  for (const k of names) for (const r of allRanges) if (liveCount(k, r) > 1) badRanges.push(`${k}:${r}:${liveCount(k, r)}`);
  if (names.length < 2) reasons.push('There are not two kinds of result keys');
  if (full.length !== 1) reasons.push(full.length === 0 ? 'No result-key group has exactly one valid copy per segment' : 'Both result-key groups are fully valid (none invalidated)');
  const others = names.filter((k) => !full.includes(k));
  if (others.some((k) => !fullySuperseded.includes(k) && !takenOverMidway.includes(k))) reasons.push('The other group was neither fully superseded nor taken over midway');
  if (badRanges.length) reasons.push('Under the same result key some segment has more than one valid copy');
  if (!names.every((k) => candidates.includes(k))) reasons.push('The layer table candidates are missing a group');
  if (!layerFp || !names.includes(layerFp)) reasons.push('This layer of the layer table does not point to either group');
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
