/**
 * Nodes filter claimable tasks by capability (Design 4.3, Contract B.2).
 *
 * The document service pushes summaries of visible `open` tasks to nodes, and nodes decide for
 * **themselves** whether to accept: the document service only keeps records, without estimating
 * compute or assigning tasks. Checked in rule number order, returns on the first failure:
 *
 *   0  Browser-only only claims tasks from its own user (the server already checks credentials;
 *      blocked again here)
 *   1  Environment fingerprint, code version, and card source version match (`plan` tasks only check
 *      code version: whichever node claims it sets the fingerprint for this version; `plan` with
 *      `requires.preferNode` additionally checks fingerprint, M6c X4; when a browser-only node claims
 *      tasks for user cards or media effect cards, it compares `node.cardEnvFingerprint`: the three
 *      environment items plus online card runtime version, Block N); if `requires.localMedia` is
 *      provided, it must equal this node's `nodeId` (M6c X2 local-tier capability gate, `node.nodeId`
 *      filled in by session)
 *   2  Tasks requiring `capabilities.streams` (stream tasks from M6c X1 onward) require the node to
 *      report `streams: true` (legacy shapes omitting this field are evaluated by `transcode`);
 *      tasks explicitly specifying `requires.transcode: true` require transcoding capability. Only
 *      this field on the task is checked, no longer uniformly requiring transcoding because it
 *      "is a stream task" (`docs/plan/browser-stream-task.md` second place): the splitter's own stream
 *      tasks already specify `transcode: true`, behavior unchanged; the copy of single-card streams
 *      sent to browsers specifies `transcode: false` (browser compresses using its built-in encoder),
 *      claimed solely via `capabilities.streams`
 *   3  User cards and media effect cards require corresponding capabilities
 *   4  Weight policy (see `DEFAULT_WEIGHT_POLICY`)
 *   5  Memory requirement does not exceed available memory on this machine
 *   6  `plan` tasks require Chrome and server-side card-cache; browser-only does not accept them;
 *      standalone render hosts (`host`) do not accept `plan` without a clip manifest: desktop `plan`
 *      is left to the publisher's own node (M6b, `docs/plan/render-host-contract.md` sections 3 and 4);
 *      `plan` with a clip manifest (manifest plans for online pages, prerender retry plans for old
 *      pages) is accepted by `host` and split using its own fingerprint (C10 Contract section 18,
 *      item 9, modifying M6c X4)
 *   7  Browser-only snapshot tasks only accept standalone cards (`input.compositing === 'independent'`,
 *      written by the splitter in the browser copy) for the shared tier (`tier: 'shared'`): M7 Contract
 *      section 3.2 and D4 (desktop only treats page measurement frames of standalone cards as prerender
 *      output; local tier requires rendering the whole scene). Does not rely solely on the splitter
 *      marking local tier as heavy.
 *      Canvas cards (`input.canvasHeavy`) are also not accepted: the browser generates snapshots by
 *      sequential frame-by-frame forward pass, and results for canvas cards are not equivalent to
 *      desktop batches of 4 frames (M7 probe P2, lead session ruling).
 *      Tasks for user cards and media effect cards (Block N) additionally require non-empty
 *      `requires.cardSources`: user cards always have a code identity; if empty, the splitter provided
 *      no identity to verify.
 *      Likewise, browser-only stream tasks only accept single-card streams emitted by the splitter in
 *      browser shape: `input.stream` is `{ kind: 'card', plane: 'local' }`, has `input.bake`, is a
 *      standalone card, and is not a canvas card (group streams must be drawn together with layout,
 *      which this browser path cannot render); not blocked solely by Rule 2.
 *      Below-dependent streams (stream tasks with `requires.belowDependent: true`,
 *      `docs/plan/prerender-products-contract.md` section 5.1) require lower layers and assets for the
 *      whole scene; browser-only never accepts them (`below-dependent`); desktop apps and render hosts
 *      accept them per Rules 1-5
 *   8  Test only (M7 Contract D15): When node description includes `planOnly: true`, only claims
 *      `plan` and does not claim fine-grained tasks: during acceptance checks, the splitter only
 *      splits and does not compete with browser-only nodes for the same batch of cards. Set by caller
 *      (`testPlanOnly`) only when test environment variable `PROMPTCUT_TEST_PLAN_ONLY=1`, not set in
 *      production
 *
 * Pure function, does not mutate arguments.
 */
import { isListPlan } from '../render-queue/messages.mjs';

/**
 * Weight policy table for each node type. Allowed values for each entry:
 *
 *   'all'                        Accept all
 *   ['light', 'medium', …]       Only accept listed weights
 *   'own-or-light'               Accept all for own projects (`ownProjectIds`), only `light` for others
 *   { editing, idle }            Pick one by `node.editing === true`, interpret per the three above
 *
 * When a node provides `weightPolicy`, any missing category is filled from this table.
 */
export const DEFAULT_WEIGHT_POLICY = Object.freeze({
  browser: Object.freeze(['light', 'medium']),
  pc: Object.freeze({ editing: 'own-or-light', idle: 'all' }),
  host: 'all',
});

const pass = Object.freeze({ ok: true });
const reject = (rule, reason) => ({ ok: false, rule, reason });

function weightAllowed(rule, weightClass, task, node) {
  if (rule === 'all') return true;
  if (Array.isArray(rule)) return rule.includes(weightClass);
  if (rule === 'own-or-light') {
    return weightClass === 'light' || (node.ownProjectIds ?? []).includes(task.source?.projectId);
  }
  if (rule && typeof rule === 'object') {
    return weightAllowed(node.editing === true ? rule.editing : rule.idle, weightClass, task, node);
  }
  // Unrecognized policy: conservative, do not accept
  return false;
}

/** → `{ ok: true }` | `{ ok: false, rule: 0..8, reason }`. */
export function checkClaimable(task, node) {
  const requires = task?.requires ?? {};
  const capabilities = node?.capabilities ?? {};
  const browser = node?.profile === 'browser';
  const host = node?.profile === 'host';
  const plan = task?.kind === 'plan';

  // 0
  if (browser && task?.source?.userId !== node.userId) return reject(0, 'other-user');

  // 1
  // A plan with preferNode (M6c X4) is given to "pc with matching fingerprint" after the window, so
  // check the fingerprint too; legacy shapes without it still skip the check as before
  const checksFingerprint = !plan || requires.preferNode != null;
  // Block N: When a browser-only node executes tasks for user cards and media effect cards,
  // fingerprints are compared by "three environment items + online card runtime version"; built-in
  // cards and other nodes still compare envFingerprint as before.
  // When a browser lacks cardEnvFingerprint (did not report runtime version), it compares
  // envFingerprint, which naturally will not match the fingerprint for such tasks
  const runsCardCode = requires.userCards === true || requires.graphCards === true;
  const nodeFingerprint = browser && runsCardCode && typeof node?.cardEnvFingerprint === 'string' && node.cardEnvFingerprint !== ''
    ? node.cardEnvFingerprint : node?.envFingerprint;
  if (checksFingerprint && requires.envFingerprint != null && requires.envFingerprint !== nodeFingerprint) {
    return reject(1, 'env-fingerprint');
  }
  // Local tier capability gate (M6c X2): input contains assets that exist only on publisher's local
  // machine (no content hash); only that node accepts them
  if (requires.localMedia != null && requires.localMedia !== node?.nodeId) return reject(1, 'local-media');
  if (requires.codeVersion != null && !(node?.codeVersions ?? []).includes(requires.codeVersion)) {
    return reject(1, 'code-version');
  }
  if (!plan && requires.cardSources && typeof requires.cardSources === 'object') {
    for (const [cardId, version] of Object.entries(requires.cardSources)) {
      if (!(node?.cardSourceVersions?.[cardId] ?? []).includes(version)) return reject(1, 'card-source');
    }
  }

  // 2(M6c X1: When a task requires `capabilities.streams`, node must report `streams: true`,
  //   meaning an encoder was probed on this machine; nodes that did not report `streams`
  //   (pre-M6c shape) are evaluated by transcoding capability; those reporting `false` are never accepted)
  if (requires.capabilities?.streams === true && (capabilities.streams ?? capabilities.transcode) !== true) return reject(2, 'streams');
  // Transcoding only checks the task's own `requires.transcode` (second place in
  // `browser-stream-task.md`): the browser copy of a single-card stream sets it to false
  if (requires.transcode === true && !capabilities.transcode) return reject(2, 'transcode');

  // 3
  if (requires.userCards === true && !capabilities.userCards) return reject(3, 'user-cards');
  if (requires.graphCards === true && !capabilities.graphCards) return reject(3, 'graph-cards');

  // 4
  const policy = node?.weightPolicy ?? DEFAULT_WEIGHT_POLICY;
  const rule = policy[node?.profile] ?? DEFAULT_WEIGHT_POLICY[node?.profile];
  const weightClass = task?.weight?.class ?? 'medium';
  if (!weightAllowed(rule, weightClass, task ?? {}, node ?? {})) return reject(4, 'weight');

  // 5
  if (Number.isFinite(requires.memoryMB) && Number.isFinite(capabilities.memoryMB) && requires.memoryMB > capabilities.memoryMB) {
    return reject(5, 'memory');
  }

  // 6
  if (plan && browser) return reject(6, 'plan-on-browser');
  if (plan && host && !isListPlan(task)) return reject(6, 'plan-on-host');

  // 7(M7 D4): Browser-only only handles shared tier standalone cards; canvas card (`canvasHeavy`)
  // sequential frame-by-frame forward pass is not equivalent to desktop (probe P2); weight already
  // blocks it, blocked again here
  if (browser && task?.kind === 'snapshot') {
    if (task.tier !== 'shared') return reject(7, 'tier');
    if (task.input?.compositing !== 'independent') return reject(7, 'not-independent');
    if (task.input?.canvasHeavy === true) return reject(7, 'canvas-heavy');
    // Block N: User cards and media effect cards always have a code identity; having none
    // (`cardSources` is empty) means the splitter provided no identity to match against; browser
    // does not accept them
    if (runsCardCode && Object.keys(requires.cardSources ?? {}).length === 0) return reject(7, 'card-source-missing');
  }

  // 7 (cont.): Browser-only stream tasks only accept browser-shaped single-card streams (splitter
  // writes `input.stream`, `input.bake`, and `input.compositing` in the browser copy)
  if (browser && task?.kind === 'stream') {
    // Below-dependent streams: requires lower layers and assets for the whole scene; browser nodes
    // do not produce them (regardless of whether they carry browser-shaped inputs)
    if (requires.belowDependent === true) return reject(7, 'below-dependent');
    if (task.input?.stream?.kind !== 'card' || task.input.stream.plane !== 'local') return reject(7, 'not-card-stream');
    if (!task.input.bake || typeof task.input.bake !== 'object') return reject(7, 'no-bake-input');
    if (task.input.compositing !== 'independent') return reject(7, 'not-independent');
    if (task.input.canvasHeavy === true) return reject(7, 'canvas-heavy');
    if (runsCardCode && Object.keys(requires.cardSources ?? {}).length === 0) return reject(7, 'card-source-missing');
  }

  // 8(M7 D15, test only): Only split, do not claim fine-grained tasks
  if (node?.planOnly === true && !plan) return reject(8, 'plan-only');

  return pass;
}

/**
 * Test only (M7 Contract D15): Returns true when test environment variable
 * `PROMPTCUT_TEST_PLAN_ONLY` is `1`; caller uses this to add `planOnly: true` to node description
 * (Rule 8). Follows `PROMPTCUT_TEST_ENV_FINGERPRINT` pattern: only takes effect when this variable
 * exists, unset in production. Pure function; environment variable passed by caller.
 */
export function testPlanOnly(env) {
  return String(env?.PROMPTCUT_TEST_PLAN_ONLY ?? '') === '1';
}

/** Filters tasks that this node can claim, preserving the original order. */
export function filterClaimable(tasks, node) {
  return (tasks ?? []).filter(task => checkClaimable(task, node).ok);
}
