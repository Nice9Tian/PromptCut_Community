/**
 * The **sole adaptation point** for the M7 acceptance probe (`m7-browser-probe.mjs`) reading page
 * node diagnostics.
 *
 * Section 7 of contract `docs/plan/m7-contract.md` only lists "which metrics exist" for page
 * diagnostics, without specifying field names or shapes; implementation is also invisible before
 * the page node branch (`claude/rq-m7-node`) is merged. The probe is written against the contract
 * without looking at implementation; all readings where "shape is not specified in the contract"
 * are collected in this file: during integration, verify against real page node shapes and
 * **modify only here**, leaving the probe body untouched. Probe criteria rely as little as possible
 * on this: claim, renew lease, release, completion, check in, etc. are all determined from wire
 * messages (WebSocket frames captured via CDP) and document service `describe()`; values read here
 * serve only for comparison and supplementation (frame-by-frame elapsed time, how many chunks were
 * pushed, release reasons recorded by the page itself).
 *
 * List of assumptions (`ASSUMPTIONS`, listed verbatim in the report): each item states "what is
 * assumed" and "which function to modify on mismatch".
 */

/** Assumptions of adapter functions (included in both report and result JSON) */
export const ASSUMPTIONS = Object.freeze([
  'A-1 The page diagnostic hook is `window.__pcBrowserNode()` on the editor page (top-level document), returning synchronously an object that can be structured-cloned (section 7 of the contract gives only the name); no such function = the page node code is not there. Change `readNodeDiag`.',
  "A-2 `state` takes the values `off` / `idle` / `busy` / `baking` (original wording of contract section 7), plus `reason` (a string explaining why it is off); `nodeId`, `envFingerprint` and `codeVersion` are flat at the top level. Change `normalizeNodeDiag`.",
  'A-3 The tasks held are in `held` (or `tasks`, `holding`): an array whose elements are task id strings or objects with an `id`. Change `heldOf` in `normalizeNodeDiag`.',
  'A-4 [after reconciliation, section "diagnostic shape" of the rq-m7-node 9774eda report] The counts are in `counters`: `claims completed dedup failed lost bakedFrames`; releases are in `counters.released`, keyed by the original on-the-wire cause text (`yield-play` `yield-drag` `yield-urgent` `yield-hidden` `no-snapshot` `offline` `unsupported`), classified by `releaseCauseOf`; items blocked by the node-side filter are in `counters.blocked` ("rule number:cause"); pushes are in `upload`: `pushed skipped bytes failed reauth recheck`; the small-size frame count is in `stage.smallFrames`. The old guessed names (`counts`, `stats`, flat) still serve as a fallback. Change `countsOf`.',
  'A-5 [after reconciliation] The page-side time per frame (including the push) is in `counters.frameMs { n, p50, p95 }`; the stage side is in `stage.frameMs` and `stage.pausedMs` (time blocked by the gate, not counted in the timing). Change `countsOf`.',
  'A-6 The most recent error is in `lastError` (a string or `{ message }`). Change `normalizeNodeDiag`.',
  'A-7 The stage-side snapshot generation diagnostics are in `window.__pcStageDiag().bake` of the stage document (C10 already has `__pcStageDiag`; the `bake` entry is an assumption): `{ frames, frameMs: { p50, p95 }, pausedMs }`. Change `readStageBakeDiag`.',
  "A-8 Release causes of `task.release` (contract sections 2 and 4.2 spell out only `no-snapshot`): yielding (drag / play) is recognized by `yield` `busy` `interaction` `drag` `play`, page hidden by `hidden` `visibility`, more urgent background jobs by `urgent` `preempt` `measure` `catch-up`, failing to get the project by `no-snapshot`. Anything unrecognized is recorded as `other`; the criterion \"released once\" ignores the cause. Change `releaseCauseOf`.",
  'A-9 The diagnostics that C10 already has stay readable as before: `__pcPreviewDiag()` (`dual`, `frontId`, `backWork`), `__pcOnlineSnapshots()` (`tier`, `layers[].{clipId, resultKey, envFingerprint, ready}`), `__pcPlanPublisher()` (`log`); these are not assumptions of this adapter, but if the page node changes their shape, the probe reads from the functions of the same names.',
]);

/** Fetch diagnostics in the page (perform structuredClone once, stripping functions and cycles) */
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
  // Release: keys are verbatim wire reasons (yield-play …), categorized by releaseCauseOf;
  // legacy guessed categorized keys (yield, hidden …) are recognized as-is
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

/**
 * Raw page diagnostics → fixed shape used by the probe; `available` false indicates this hook is
 * absent on the page (page node code not present)
 */
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

/** Read page node diagnostics from the editor page (Section 7, "Page") */
export async function readNodeDiag(page) {
  return normalizeNodeDiag(await cloneIn(page, '__pcBrowserNode'));
}

/**
 * Read generate snapshots diagnostics from background stage (Section 7, "Stage"); reads both
 * stages, returning `{ A: …, B: … }` (null if unreadable)
 */
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
 * `task.release` reason → probe categorization (A-8). Wire messages are specified by contract
 * (`{ type: 'task.release', id, token, reason }`), while the contract only specifies `no-snapshot`
 * for the reason string.
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
