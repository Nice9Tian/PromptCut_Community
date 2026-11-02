import { tr } from "../i18n.mjs";
/**
 * Message formats for render queue: inbound validation, outbound construction, task id.
 *
 * See contracts in `docs/plan/render-queue-contract.md` A.4, A.6, A.11; see F.1 for per-card
 * fingerprint lock. Inbound messages are always validated as a whole before being passed to
 * state machine: malformed messages do not take effect at all (C6), so validation must not have
 * side effects or "modify part of state halfway through validation".
 * After validation passes, a normalized, deep-cloned replica is returned: subsequent modifications
 * to the original message by caller cannot affect data stored in the queue.
 */

const KINDS = new Set(['plan', 'snapshot', 'stream']);
const TIERS = new Set(['shared', 'local']);
const RANGE_UNITS = new Set(['localFrame', 'segment']);
const WEIGHT_CLASSES = new Set(['light', 'medium', 'heavy']);
const PROFILES = new Set(['pc', 'host', 'browser']);
/** Task kinds participating in per-card fingerprint lock (F.1): plan produces no result, so not locked */
const LOCK_KINDS = new Set(['snapshot', 'stream']);

/**
 * Messages only node connections can send (A.5). `node.active` (M7 D2 supplement [ruling],
 * `claude/queue-maint`): when node holds no claim on this card, but page is still active and busy
 * with other work (generating snapshots for other cards, background stage measuring or running
 * catch-up runs), reports once per `node.welcome.activeIntervalMs`; cards locked by it are not
 * judged idle because of this; no response.
 */
export const NODE_TYPES = new Set(['queue.watch', 'task.claim', 'task.progress', 'task.complete', 'task.release', 'task.fail', 'node.active']);
/** Maximum length of `node.active`'s `busy` (what it is busy with, for diagnostics only) */
export const NODE_ACTIVE_BUSY_MAX = 32;
/**
 * Messages that only publisher connections can send (A.5). `card.lock` (F.1) is also here:
 * the document service routes messages to the queue using this set, so adding it here avoids
 * modifying the document service.
 */
export const PUBLISHER_TYPES = new Set(['task.publish', 'task.unsubscribe', 'card.lock']);

/**
 * Task priority tier (semantics: "Priority" under "Render queue" in
 * `mechanism/document-service.md`, c10a contract section 17):
 * `priority` takes `'normal'` (default; always used when published by online pages or locally after
 * classifying as heavy) or `'backfill'` (prerender retry for legacy pages; no new publishers since
 * 2026-10-07, kept only to recognize legacy pages during deployment switchover).
 * Earlier integer `priority` (50 for anchor frame segments, 10 for the rest, contract A.4) is
 * still accepted and counts as rank within the `normal` tier:
 * legacy clients without `priority` or with integers are all treated as `normal`.
 */
export const PRIORITY_BANDS = Object.freeze(['normal', 'backfill']);
/**
 * Which tier this `priority` falls into: only `'backfill'` is the prerender retry tier;
 * the rest (default, integer, `'normal'`) are all `normal`.
 */
export function priorityBand(priority) {
  return priority === 'backfill' ? 'backfill' : 'normal';
}
/**
 * Rank within tier: integers as-is, otherwise 0 (larger integers in `normal` tier claimed first,
 * contract B.3).
 */
export function priorityRank(priority) {
  return Number.isSafeInteger(priority) ? priority : 0;
}
/**
 * Number used by summary (`topPriority` in contract H.3): integers as-is, `'normal'` counts as 0,
 * `'backfill'` counts as -1: the summary only compares magnitudes, and the prerender retry tier
 * ranks below any `normal`.
 */
export function prioritySummaryValue(priority) {
  if (Number.isSafeInteger(priority)) return priority;
  return priority === 'backfill' ? -1 : 0;
}

/**
 * Suffix of prerender retry plan task (c10a contract section 17) result key:
 * `<projectId>@<projectRev>#backfill:<sig>`
 */
export const BACKFILL_KEY_MARK = '#backfill:';
const BACKFILL_SIG_RE = /^[0-9a-z]{1,32}$/;
/** Upper limit on clip manifest for prerender retry plan tasks */
export const BACKFILL_MAX_CLIPS = 1000;
/**
 * Manifest plan (C10 contract section 7, section 18 item 9 [ruling]): `plan` published by online
 * pages, with its own heavy-classified clip manifest, and `priority` as normal.
 * Result key `<projectId>@<projectRev>#clips:<sig>` (signature uses the same algorithm as
 * prerender retry). Collectively called "plan tasks with clip manifests" with prerender retry
 * plans: `host` can also claim, split by claiming node with its own fingerprint (modification
 * to M6c X4, see `queue.mjs`).
 */
export const CLIPS_KEY_MARK = '#clips:';

/**
 * Task id is determined by content (design section 2): there is only one task for the same result,
 * enabling duplicate publishes to be idempotently merged. `plan` tasks have no range, so the id is
 * `plan:<projectId>@<projectRev>` (prerender retry plan tasks use
 * `plan:<projectId>@<projectRev>#backfill:<sig>`).
 *
 * The id of a sparse stream task (`kind: 'stream'`, `input.density: 'sparse'`, see
 * `STREAM_DENSITY_SPARSE`) appends `:sparse` at the end: it is a separate task from the
 * full-density task of the same stream and same segment (each executed once in succession),
 * sharing the same result key, range, and manifest key in the content store.
 */
export function taskIdOf({ kind, resultKey, range, density }) {
  if (kind === 'plan') return `plan:${resultKey}`;
  const id = `${kind}:${resultKey}:${range.from}-${range.to}`;
  return kind === 'stream' && density === STREAM_DENSITY_SPARSE ? `${id}:${STREAM_DENSITY_SPARSE}` : id;
}

/**
 * Stream task density (`input.density`): `'sparse'` denotes a sparse stream task: capturing only
 * the first frame of each segment and repeating it for the remaining frames (semantics: "Heavy
 * pipeline: prerender" in `mechanism/rendering.md`); tasks omitting this property are full-density
 * tasks. Other values are stripped on ingress (treated as full density).
 */
export const STREAM_DENSITY_SPARSE = 'sparse';
/**
 * Whether this task is a sparse stream task. Inbound tasks, TaskView, and split tasks can all
 * be passed (summaries without `input` are recognized by id suffix).
 */
export const isSparseStreamTask = (task) => isObj(task) && task.kind === 'stream'
  && ((isObj(task.input) && task.input.density === STREAM_DENSITY_SPARSE) || (typeof task.id === 'string' && task.id.endsWith(`:${STREAM_DENSITY_SPARSE}`)));

/**
 * Lock key for per-card fingerprint lock (F.1): `<kind>:<input.contentKey>`, one lock per result
 * type per card. Only snapshots and track streams have it; tasks without a content key do not
 * participate in locking and return null. Inbound tasks, TaskView, and queue-internal tasks can all
 * be passed.
 */
export function lockKeyOf(task) {
  if (!isObj(task) || !LOCK_KINDS.has(task.kind)) return null;
  const contentKey = isObj(task.input) ? task.input.contentKey : undefined;
  return typeof contentKey === 'string' && contentKey !== '' ? `${task.kind}:${contentKey}` : null;
}

/**
 * Outbound message: type + fields + epoch (C6), response includes inbound reqId. Fields are
 * deep-copied; recipient modifications do not affect the queue.
 */
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
  if (typeof v !== 'string') bad(`${name} must be a string`);
  return v;
}
function nonEmpty(v, name) {
  if (typeof v !== 'string' || v === '') bad(`${name} must be a non-empty string`);
  return v;
}
function int(v, name) {
  if (!isInt(v)) bad(`${name} must be an integer`);
  return v;
}
function oneOf(v, set, name) {
  if (!set.has(v)) bad(`${name} must be one of ${[...set].join(' / ')}`);
  return v;
}
/** Optional field: both undefined and null count as not provided */
const absent = (v) => v === undefined || v === null;
function optStr(v, name) { return absent(v) ? null : str(v, name); }
function optInt(v, name) { return absent(v) ? null : int(v, name); }
/**
 * Optional boolean: only undefined counts as not provided; null and other types count as format
 * errors (same as retryable in task.fail).
 */
function optBool(v, name) {
  if (v !== undefined && typeof v !== 'boolean') bad(`${name} must be a boolean`);
  return v === true;
}
function optNumOrNull(v, name) {
  if (absent(v)) return null;
  if (!isNum(v)) bad(`${name} must be a number or null`);
  return v;
}
function strArray(v, name) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`${name} must be an array of strings`);
  return [...v];
}
/**
 * Object to "save as-is": deep-copied; if copy fails (functions, oddities in cycles), treated as
 * format error.
 */
function plainObject(v, name) {
  if (!isObj(v)) bad(tr("{0} must be an object", name));
  try { return structuredClone(v); } catch { return bad(`${name} cannot be cloned`); }
}

function parseRange(v, name) {
  if (!isObj(v)) bad(tr("{0} must be an object", name));
  const unit = oneOf(v.unit, RANGE_UNITS, `${name}.unit`);
  const from = int(v.from, `${name}.from`);
  const to = int(v.to, `${name}.to`);
  if (from < 0 || from > to) bad(`${name} must satisfy 0 <= from <= to`);
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
  if (!isObj(v)) bad(`${at} is not an object`);
  const id = nonEmpty(v.id, `${at}.id`);
  const kind = oneOf(v.kind, KINDS, `${at}.kind`);
  const resultKey = nonEmpty(v.resultKey, `${at}.resultKey`);
  // tier is only meaningful for snapshot: required for snapshot, ignored for others (neither
  // validated nor saved)
  const tier = kind === 'snapshot' ? oneOf(v.tier, TIERS, `${at}.tier`) : null;
  if (!isObj(v.source)) bad(`${at}.source must be an object`);
  const projectId = nonEmpty(v.source.projectId, `${at}.source.projectId`);
  const projectRev = int(v.source.projectRev, `${at}.source.projectRev`);
  const derivedFrom = optStr(v.source.derivedFrom, `${at}.source.derivedFrom`);
  let range = null;
  const priority = parsePriority(v.priority, `${at}.priority`);
  let input = absent(v.input) ? {} : plainObject(v.input, `${at}.input`);
  if (kind === 'plan') {
    if (!absent(v.range)) bad(`${at}.range: plan tasks have no range, it must be null`);
    const base = `${projectId}@${projectRev}`;
    if (resultKey.startsWith(`${base}${BACKFILL_KEY_MARK}`)) {
      // Prerender retry plan task (c10a contract section 17): with clip manifest, marked backfill;
      // different manifests yield different result keys
      if (!BACKFILL_SIG_RE.test(resultKey.slice(base.length + BACKFILL_KEY_MARK.length))) bad(`${at}.resultKey prerender retry signature must be 1-32 lowercase letters and digits`);
      if (priority !== 'backfill') bad(`${at}.priority: prerender retry plan tasks must be marked 'backfill'`);
      input = { ...input, clips: backfillClips(input.clips, `${at}.input.clips`) };
    } else if (resultKey.startsWith(`${base}${CLIPS_KEY_MARK}`)) {
      // Manifest plan (C10 contract section 18 item 9): with clip manifest, normal tier; prerender retry
      // tier uses #backfill: key instead
      if (!BACKFILL_SIG_RE.test(resultKey.slice(base.length + CLIPS_KEY_MARK.length))) bad(`${at}.resultKey manifest signature must be 1-32 lowercase letters and digits`);
      if (priorityBand(priority) !== 'normal') bad(`${at}.priority: the manifest plan is the normal tier; prerender retries use a #backfill: key`);
      input = { ...input, clips: backfillClips(input.clips, `${at}.input.clips`) };
      // Online pages' self-reported user card and media effect card runtime status (chunk N): keep only
      // valid shapes, drop invalid items entirely (tasks are still published, but the splitter does not
      // emit the user card and media effect card portion for the browser)
      const browser = browserCardsOf(input.browser);
      if (browser) input = { ...input, browser }; else delete input.browser;
      // Page sees "generate track streams" enabled for this project (see `clipsPlanTaskOf`): only accepts
      // boolean true, other values are stripped
      if (input.streams !== true) delete input.streams;
    } else if (resultKey !== base) {
      bad(`${at}.resultKey must equal the source's projectId@projectRev`);
    }
  } else {
    range = parseRange(v.range, `${at}.range`);
  }
  // Density of stream tasks only accepts `'sparse'`; other values are stripped (treated as full
  // density), and id is computed based on the stripped value as well
  if (input.density !== undefined && !(kind === 'stream' && input.density === STREAM_DENSITY_SPARSE)) {
    input = { ...input };
    delete input.density;
  }
  const expected = taskIdOf({ kind, resultKey, range, density: input.density });
  if (id !== expected) bad(`${at}.id must be ${expected}`);
  return {
    // takeover only determines how this publish handles locks (F.1); not stored in tasks, nor present
    // in TaskView
    takeover: optBool(v.takeover, `${at}.takeover`),
    id, kind, tier, resultKey, range,
    // Self-reported userId / tenantId / publisher / publishedAt in source are discarded here, populated
    // by the queue based on the connection (A.4)
    source: { projectId, projectRev, derivedFrom },
    input,
    weight: absent(v.weight) ? null : parseWeight(v.weight, `${at}.weight`),
    requires: absent(v.requires) ? {} : plainObject(v.requires, `${at}.requires`),
    priority,
  };
}

/**
 * `priority`: default 0; integer as-is (legacy shape); or `'normal'` / `'backfill'` (c10a contract
 * section 17).
 */
function parsePriority(v, name) {
  if (absent(v)) return 0;
  if (typeof v === 'string') return oneOf(v, new Set(PRIORITY_BANDS), name);
  return int(v, name);
}

/**
 * `input.browser` of manifest plan (chunk N, `docs/plan/online-card-exec-contract.md` section 7
 * item 3): online page self-reports "which user cards and media effect cards run on this page":
 *   { cardEnvFingerprint, userCards, graphCards, cardSources: { card id: code identity } }
 * Parts self-reported by the page that cannot be trusted are guarded elsewhere: pure browser
 * nodes only claim their own user's tasks, and node-side filtering (rule 1) re-checks card
 * code identity; the worst outcome of false reporting is that the splitter produces an extra
 * backup task nobody can claim (the other copy with the same lock key is claimed as usual).
 * Only shapes are normalized here: fingerprint must be 16 lowercase hex characters; card id
 * and code identity are length-capped strings, up to `BROWSER_CARDS_MAX` cards; returns null
 * if invalid. Defaults and ordering are fixed (card id ascending), so identical content always
 * yields the same object and same signature.
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
/**
 * Digest string of `browserCardsOf` result (enters manifest plan signature): verbatim matching
 * `planPublisher.ts` on the page side.
 */
export function browserCardsSig(cards) {
  return [cards.cardEnvFingerprint, cards.userCards ? 1 : 0, cards.graphCards ? 1 : 0, ...Object.keys(cards.cardSources).sort().map((id) => `${id}=${cards.cardSources[id]}`)].join('|');
}

/**
 * Clip manifest for prerender retry plan tasks: non-empty, deduplicated, ascending array of
 * non-empty strings.
 */
function backfillClips(v, name) {
  if (!Array.isArray(v) || v.length === 0 || v.length > BACKFILL_MAX_CLIPS) bad(`${name} must be 1 to ${BACKFILL_MAX_CLIPS} clip ids`);
  if (v.some((x) => typeof x !== 'string' || x === '')) bad(`Every item of ${name} must be a non-empty string`);
  return [...new Set(v)].sort();
}

/**
 * Whether this is a prerender retry plan task (inbound tasks, TaskView, and queue-internal tasks
 * can all be passed).
 */
export function isBackfillPlan(task) {
  return isObj(task) && task.kind === 'plan' && typeof task.resultKey === 'string' && task.resultKey.includes(BACKFILL_KEY_MARK);
}

/**
 * Whether this is a manifest plan (normal tier plan published by online pages, C10 contract
 * section 18 item 9).
 */
export function isClipsPlan(task) {
  return isObj(task) && task.kind === 'plan' && typeof task.resultKey === 'string' && task.resultKey.includes(CLIPS_KEY_MARK);
}

/**
 * Plan task with clip manifest (prerender retry plan or manifest plan): `host` can claim;
 * claiming node splits by manifest.
 */
export function isListPlan(task) {
  return isBackfillPlan(task) || isClipsPlan(task);
}

/**
 * Clip manifest signature (suffix of prerender retry plan task result key): after deduplicating in
 * ascending order, take base36 via FNV-1a (32-bit, two rounds with different seeds concatenated
 * into 64-bit). The same manifest always yields the same key, matching even when computed
 * independently by page and node. Pure function; the browser can copy verbatim.
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

/**
 * Prerender retry plan task (c10a contract section 17): `plan` with clip manifest, marked
 * `priority: 'backfill'`, without `requires`.
 */
export function backfillPlanTaskOf({ projectId, projectRev, clips }) {
  const list = [...new Set(clips ?? [])].map(String).filter(Boolean).sort();
  const resultKey = `${projectId}@${projectRev}${BACKFILL_KEY_MARK}${backfillSig(list)}`;
  return {
    id: taskIdOf({ kind: 'plan', resultKey, range: null }), kind: 'plan', resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list }, weight: { class: 'medium', estMs: null, frames: null },
    requires: {}, priority: 'backfill',
  };
}

/**
 * Segment in manifest plan signature for "page sees 'generate track streams' enabled" (verbatim
 * matching `planPublisher.ts` on page side).
 */
export const LIST_STREAMS_SIG = 'streams=1';
/** Separator between additional segments in signature (will not appear in card digest) */
const SIG_EXTRA_SEP = '\u0001';

/**
 * Manifest plan (C10 contract section 7, section 18 item 9): clip manifest classified as heavy by
 * the online page itself, normal tier. `requires` omits `envFingerprint` and `preferNode`: any
 * node capable of splitting (desktop app, standalone render host) can claim it, and the claiming
 * node splits it using its own fingerprint; `codeVersion` is written only when provided
 * (nodes with different versions do not claim).
 *
 * `streams: true` (task brief `docs/plan/render-refactor-task.md` "Jia-3", contract
 * `docs/plan/hosted-render-contract.md` section 3.1): the page sees "generate track streams"
 * enabled for this project. An extra segment is added to the signature, and `input.streams` is
 * true: **for the same project revision and same manifest, having this enabled makes it a distinct
 * plan**: when the creator first enables it, the plan published while that revision had it
 * disabled is already completed, and the queue will not re-split for the same result key; with a
 * different key, the host's render node will split again and produce its own share of stream
 * tasks. When not true (disabled, legacy page, or legacy document service omitting this item),
 * the result key and `input` match verbatim those without this parameter, so projects keeping this
 * disabled are unaffected. This is only the state seen by the page: whether to produce is still
 * decided by the render node according to this entry in the catalog; page self-reporting is not
 * authoritative.
 */
export function clipsPlanTaskOf({ projectId, projectRev, clips, codeVersion, browser, streams }) {
  const list = [...new Set(clips ?? [])].map(String).filter(Boolean).sort();
  const cards = browserCardsOf(browser);
  const on = streams === true;
  // When `input.browser` is present, append its digest to the signature: for the same manifest, if
  // cards runnable on this page change (one finished transpiling, generation changed), it becomes
  // another plan, and the splitter splits anew
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
  if (!Array.isArray(v)) bad('resume must be an array');
  return v.map((r, i) => {
    if (!isObj(r)) bad(`resume[${i}] is not an object`);
    return { id: str(r.id, `resume[${i}].id`), token: int(r.token, `resume[${i}].token`) };
  });
}

/** Two fields shared by token-like messages (progress / complete / release / fail) */
function tokenFields(m) {
  return { id: str(m.id, 'id'), token: int(m.token, 'token') };
}

const PARSERS = new Map([
  ['node.hello', (m) => ({
    nodeId: nonEmpty(m.nodeId, 'nodeId'),
    profile: oneOf(m.profile, PROFILES, 'profile'),
    envFingerprint: optStr(m.envFingerprint, 'envFingerprint'),
    // Environment fingerprint used by pure browser nodes to execute user cards and media effect cards
    // (chunk N): computed and passed in by document service based on runtime version reported by the
    // page; self-reported values are not accepted (`admitNodeHello`)
    cardEnvFingerprint: optStr(m.cardEnvFingerprint, 'cardEnvFingerprint'),
    capabilities: absent(m.capabilities) ? {} : plainObject(m.capabilities, 'capabilities'),
    codeVersions: absent(m.codeVersions) ? [] : strArray(m.codeVersions, 'codeVersions'),
    maxConcurrent: optInt(m.maxConcurrent, 'maxConcurrent'),
    resume: parseResume(m.resume),
  })],
  ['publisher.hello', (m) => ({ publisherId: nonEmpty(m.publisherId, 'publisherId') })],
  ['queue.watch', (m) => ({
    projects: m.projects === 'all' ? 'all' : strArray(m.projects, "projects (or 'all')"),
  })],
  ['task.publish', (m) => {
    if (!Array.isArray(m.tasks) || m.tasks.length === 0) bad('tasks must be a non-empty array');
    return { tasks: m.tasks.map(parseTaskInput) };
  }],
  ['task.unsubscribe', (m) => {
    const byIds = m.ids !== undefined;
    const byProject = m.projectId !== undefined || m.projectRev !== undefined;
    if (byIds === byProject) bad('Provide either ids or projectId(+projectRev), not both');
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
  // done can be null: when a node session renews before reporting progress, it sends done: null
  // (contract B.5)
  // step (optional): counter changing as node work advances (pushing chunks, switching stages,
  // emitting batches); changes also count as progress report (contract A.12 [ruling]); legacy nodes
  // omit this
  ['task.progress', (m) => ({ ...tokenFields(m), done: optNumOrNull(m.done, 'done'), step: optNumOrNull(m.step, 'step') })],
  ['task.complete', (m) => ({ ...tokenFields(m), result: absent(m.result) ? null : plainObject(m.result, 'result') })],
  ['task.release', (m) => ({ ...tokenFields(m), reason: optStr(m.reason, 'reason') })],
  ['task.fail', (m) => {
    if (m.retryable !== undefined && typeof m.retryable !== 'boolean') bad('retryable must be a boolean');
    return { ...tokenFields(m), error: optStr(m.error, 'error'), retryable: m.retryable !== false };
  }],
  // M7 D2 supplement [ruling]: node is still present and busy (busy is for diagnostics only: page
  // reports 'bake' / 'stage')
  ['node.active', (m) => {
    const busy = optStr(m.busy, 'busy');
    if (busy !== null && busy.length > NODE_ACTIVE_BUSY_MAX) bad(`busy must not exceed ${NODE_ACTIVE_BUSY_MAX} characters`);
    return { busy };
  }],
]);

/**
 * Validate an inbound message.
 * Success: `{ ok: true, type, reqId, body }`, where `body` is a normalized deep copy;
 * Failure: `{ ok: false, reqId, detail }`, where `reqId` is returned only when it is valid itself.
 */
export function parseInbound(message) {
  if (!isObj(message)) return { ok: false, reqId: undefined, detail: 'Message is not an object' };
  const reqId = isReqId(message.reqId) ? message.reqId : undefined;
  try {
    if (message.reqId !== undefined && reqId === undefined) bad('reqId must be a string or a number');
    const parse = typeof message.type === 'string' ? PARSERS.get(message.type) : undefined;
    if (!parse) bad(`Unknown type: ${typeof message.type === 'string' ? message.type : ` (${typeof message.type})`}`);
    return { ok: true, type: message.type, reqId, body: parse(message) };
  } catch (err) {
    if (err instanceof BadMessage) return { ok: false, reqId, detail: err.message };
    throw err;
  }
}
