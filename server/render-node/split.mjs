import { QUEUE_DEFAULTS, taskIdOf, lockKeyOf, backfillPlanTaskOf, isBackfillPlan, clipsPlanTaskOf, isClipsPlan, isListPlan, STREAM_DENSITY_SPARSE } from '../render-queue/index.mjs';
import { snapshotTier } from '../snapshot-tier.mjs';
import { resultKeyOf } from './fingerprint.mjs';
import { isStreamOrigin, streamSegmentFrameCount, STREAM_SEGMENT_FRAMES } from '../../src/render/streamSegments.mjs';
import { EXPORT_FRAMES_PRIORITY } from './export-plan.mjs';
import { reviewedCard } from '../../src/kernel/frameMode.mjs';
import { frame3d } from '../../src/render/streamPlanRules.mjs';

/**
 * `plan` task → fine-grained tasks (design section 2, Q1, contract B.4).
 *
 * The page only sends the coarse task "make a plan for this project version"; the first node to
 * claim it computes the card plan in Chrome, uses `card-cache.mjs` to calculate result keys and
 * the prerender set, then uses `splitPlan` here to split it into fine-grained tasks and publish
 * them back to the queue (`source.derivedFrom` points to that `plan` task).
 *
 *   Snapshots: local frames 0 .. count-1 of each control are segmented by SNAPSHOT_SPAN (default 60
 *     frames); controls in the local tier missing entryKey are skipped.
 *   Track streams: firstSegment .. lastSegment are split by STREAM_SEGMENTS (default 8 segments, 15
 *     frames each); streams without streamKey are skipped.
 *     The segment number belongs to this stream itself: starting from its first frame
 *     `originFrame`, 15 frames per segment (`src/render/streamSegments.mjs`), so firstSegment is
 *     always 0.
 *     Stream tasks have `requires.capabilities = { streams: true }` (M6c X1): given only to nodes
 *     reporting that they can produce streams.
 *
 * Result key = content key × splitting node's **own** environment fingerprint (design 2.1; when a
 * card is locked by another environment, see "per-card fingerprint lock" below): the node claiming
 * `plan` determines this project version's fingerprint, written into each fine-grained task's
 * `requires.envFingerprint`, and only nodes with the same fingerprint can claim it. Snapshot
 * segments containing anchor frames have priority 50, others 10. `input.canvasHeavy` for snapshot
 * tasks takes `control.capabilities?.canvasHeavy === true` (contract J.3).
 *
 * Content key (contract E.5): starting from M4, the card plan's `snapshotKey` and stream's
 * `streamKey` have already been multiplied by the fingerprint, so here we take their **content
 * key** (`control.contentKey` / `stream.contentKey`) and multiply by the fingerprint again: when the
 * fingerprint matches the plan, `resultKey` for shared-tier tasks equals `control.snapshotKey`
 * exactly, for stream tasks equals `spec.streamKey` exactly, and outputs of fine-grained tasks are
 * written to the same directory as the local prerender process. Inputs without a content key field
 * (old shape from M2 fixtures) treat `snapshotKey` / `streamKey` as the content key as before.
 *
 * # Per-card fingerprint lock (contract F.2, design 2.1 "who determines the fingerprint")
 *
 * The unit of locking is "one result for one card", with lock key `<kind>:<contentKey>`;
 * `contentKey` is the fine-grained task's `input.contentKey` (local tier includes `<entryKey>/`
 * prefix). Callers can pass `cardLocks` (lock key → lock fingerprint) and `takeover` (which locks
 * to take over), and keys are emitted for each card and stream according to one of the three cases
 * below:
 *
 *   Unlocked, or locked to this node's fingerprint: emit keys with this node's fingerprint,
 *     without the takeover field (i.e. the rule above).
 *   Locked to another fingerprint X, and taken over: emit keys with this node's fingerprint,
 *     adding `takeover: true` to each task; when publishing, the lock transfers to this node, and
 *     X's unfinished tasks are invalidated (superseded).
 *   Locked to another fingerprint X, not taken over: use X for both `resultKey` and
 *     `requires.envFingerprint`: remaining frames are only given to nodes with the same
 *     fingerprint as the locker; this layer does not mix environments.
 *
 * # Local tier capability gate (M6c X2, `docs/plan/m6c-contract.md`)
 *
 * Assets without a content hash exist only on the publisher's local machine (other machines cannot
 * obtain their bytes; asset fallback only recognizes hashes). Callers provide `localMedia` (the
 * publisher's nodeId) and `usesLocalMedia(control)`; every task evaluated as true writes
 * `localMedia` into `requires`, and only that node can claim it (guarded jointly by node-side
 * filter rule 1, queue pre-filtering, and claim checks). When `localMedia` is not provided, task
 * shapes remain unchanged.
 *
 * # Emit two copies for cards doable purely in browser (M7 contract D1, section 3.3)
 *
 * When callers provide `browserFingerprints` (fingerprints of pure browser nodes for this project
 * online on the document service belonging to the same user as plan, provided by the queue in
 * plan's `task.claimed`, see `browserFingerprintsFor` in `render-queue/queue.mjs`), cards that are
 * **unlocked** and can be handled purely by browsers (shared tier, standalone card, built-in card,
 * empty `cardSources`, weight light / medium, not using assets exclusive to the publisher's local
 * machine), besides emitting one copy with its own fingerprint as before, also emit one copy for
 * each browser fingerprint:
 *
 *   resultKey = contentKey × browserFingerprint, `requires.envFingerprint` = browserFingerprint,
 *     remaining requires identical;
 *   both carry `input.dual: true` and neither carries `takeover`; the browser copy additionally
 *     carries `input.compositing` and `input.bake` (`start`, `end`, `count`, `sampling` required
 *     for isolated single-card projects; the page does not compute cardSampling).
 *
 * Whichever claims any segment of this card first obtains the lock, and when establishing the
 * lock, the queue invalidates the other copy (`dual`, still open tasks with differing
 * fingerprints). Locked cards emit one copy according to the lock as before (when locked to a
 * browser fingerprint, that copy likewise carries bake / compositing); when browser fingerprints
 * match its own or no browser fingerprints are provided, splitting is completely identical to
 * before.
 *
 * # User cards and media effect cards can also be given to browser (chunk N, `docs/plan/online-card-exec-contract.md` section 7 item 3, user changed semantics 2026-10-06)
 *
 * For cards where task `requires.userCards` or `requires.graphCards` is true (the online page
 * transpiles and executes synced user cards and media effect cards inside the stage), when callers
 * provide `browserCards` (reported by the page in the manifest plan's `input.browser` as
 * `{ cardEnvFingerprint, userCards, graphCards, cardSources }`, normalized via `browserCardsOf`)
 * and `browserCardEnvFingerprints` (confirmed by the document service: "this project has online
 * browser nodes from the same user carrying these `cardEnvFingerprint`"), the browser copy is
 * emitted only if both sides match:
 *   - The page declared the corresponding capability (`userCards` / `graphCards`), and the code
 *     identity of every item in this card's `requires.cardSources` is present in
 *     `browserCards.cardSources`;
 *   - The fingerprint and result key for the browser copy use `cardEnvFingerprint` (not the page's
 *     `envFingerprint`): result key = content key × cardEnvFingerprint, so desktop nodes and
 *     browser nodes on the same machine produce different, unconflicted result keys for the same
 *     user card / media effect card.
 * When `browserCards` is not provided or does not match, user cards and media effect cards do not
 * emit the browser copy, and splitting is identical to before. Splitting and result keys for
 * built-in cards remain verbatim unchanged.
 *
 * # Also emit a copy of single-card track streams for browser (`docs/plan/browser-stream-task.md` first occurrence)
 *
 * Besides stream keys and segment ranges, each stream provided by the caller can also carry the
 * stream's shape (`kind`, `plane`, `clipIds`, `fps`, `bound`, `offset`, `firstFrame`, `total`
 * computed by `planStreams`). For **single-card streams** (`kind: 'card'`, `plane: 'local'`,
 * exactly one member card), and where that member card is judged doable by browsers under the
 * snapshot rules above (shared tier, standalone card, light / medium, not a canvas card, not using
 * assets exclusive to the publisher's local machine; user cards and media effect cards require this
 * page to declare runnable capability with matching code identity), an additional copy is emitted
 * with the browser fingerprint:
 *
 *   resultKey = stream's content key × browser fingerprint (user cards and media effect cards use
 *     page's cardEnvFingerprint), and `requires.envFingerprint` matches it;
 *   `requires.transcode: false` (browser compresses using its built-in encoder, no local
 *     transcoding needed), still requiring `capabilities.streams`;
 *   `requires.cardSources`, `userCards`, and `graphCards` are written matching this card's
 *     snapshot task (drawing only this single card);
 *   `input` carries `compositing`, `bake` (same as the snapshot copy) and `stream`:
 *     `{ kind: 'card', plane: 'local', clipIds, fps, bound, offset, firstFrame, count, total }`: the
 *     page does not compute these itself.
 *
 * Locking rules are identical to snapshots: lock key `stream:<contentKey>`; two copies are emitted
 * only when unlocked (or locked to its own fingerprint without takeover), both carrying
 * `input.dual`; when locked to another fingerprint, only one copy is emitted according to the
 * lock, and when locked to a browser fingerprint, that copy has the browser shape. Group streams,
 * streams whose member cards are not in the card plan, and streams lacking shape fields (old
 * callers) only emit the splitter's own copy, verbatim identical to before. When browser
 * fingerprints match the splitter's own, no additional copy is emitted (task ids of the two
 * copies would be identical, whereas the splitter's copy requires local transcoding which browsers
 * cannot perform).
 *
 * When a stream is marked `browserOnly: true`, the splitter's own copy is not emitted (used by
 * manifest plans sent by online pages, see `listPlanOverrides` in `local-node.mjs`): only copies
 * that browsers can handle are emitted; if unable to handle, none are emitted.
 *
 * # Sparse stream tasks (semantics `mechanism/rendering.md` "heavy pipeline: prerender": each stream has sparse and full-density versions with the same key; sparse version is queued ahead of full-density version)
 *
 * When the queue recognizes sparse stream tasks (`sparseStreams: true`, brought by `node.welcome`;
 * older queues do not provide this and only emit full-density tasks as before), for each copy of a
 * stream, in addition to full-density tasks, an extra set of **sparse stream tasks** is emitted:
 * ranges match full-density tasks one-by-one (so manifest keys in the content store are
 * identical), `input.density: 'sparse'`, task id ends with `:sparse` (`taskIdOf` in
 * `messages.mjs`), `priority` is `SPARSE_STREAM_PRIORITY` (higher than full-density stream tasks
 * and normal snapshot tasks, lower than anchor frames), and other fields (result key, `requires`,
 * `input.dual`, lock key) match the full-density task of the same copy. Sparse tasks are sent
 * ahead of full-density tasks for this stream.
 *
 * When a stream is marked `ownSparseOnly: true` (host's render node, and "generate track streams"
 * for this project is turned off, see `listPlanOverrides`), the splitter's own copy **only emits
 * sparse stream tasks**. In this case, if there is a browser copy to emit (unlocked), its own is
 * not emitted: a stream is produced under only one fingerprint (the same lock); if its own copy
 * only has the sparse version, winning the lock would prevent browsers from catching up with full
 * density; its own sparse version is emitted only when no browser can produce this stream, or the
 * lock is already on its own fingerprint.
 *
 * # Below-dependent streams (`docs/plan/prerender-products-contract.md` section 5.1)
 *
 * Streams with `kind: 'below'` (`planStreams` in `frame-stream.mjs` emits them only when the switch
 * is enabled) require lower layers and assets for the whole scene, produced only by desktop apps
 * and render hosts:
 *   - Emits only the splitter's own copy, not the browser copy (`browserStreamInputOf` only
 *     recognizes single-card streams); if marked `browserOnly`, none are emitted;
 *   - `requires.transcode: true`, `requires.belowDependent: true`, `capabilities.streams` as before;
 *     `cardSources` remains all custom cards as before;
 *   - Weight is always recorded as `heavy` (whole-scene render);
 *   - Local tier capability gate: the item received by `usesLocalMedia` additionally carries
 *     `streamKind: 'below'` and `belowClipIds` (lower layers factored into the key), and the check
 *     must factor in lower-layer assets (already included since `queue-local-media.mjs` now
 *     evaluates to true for all stream tasks).
 * When callers do not supply such streams, splitting is verbatim identical to before.
 *
 * # Frame-by-frame bitmaps dedicated to export (`../export-frames.mjs`; semantics "Export" under "Online browser" in `product/platforms.md`)
 *
 * When callers provide `exportStreams` (present only in manifest plans for export,
 * `listPlanOverrides` in `local-node.mjs`; each item is the result of `exportStreamOf`), for each
 * stream an additional set of **export bitmap tasks** is emitted: inheriting the stream task's
 * kind and range (`kind: 'stream'`, segment numbers 0 .. lastSegment split by STREAM_SEGMENTS),
 * `input.exportFrames: true`, `input.exportKey` (content key of export bitmaps), `input.stream`
 * (shape of this stream), result key = `exportKey × own fingerprint`.
 *   - Emits only the splitter's own copy, not given to browsers (pure browser nodes only accept
 *     browser-shaped stream tasks with `input.bake`, rule 7 in `filter.mjs`; it does not accept this
 *     task); does not require local transcoding, does not require `capabilities.streams`
 *     (retrieving bitmaps does not use ffmpeg or encoders; standalone render hosts without
 *     `--streams` can also handle it);
 *   - `input` **does not carry `contentKey`**: does not participate in per-card fingerprint locks
 *     (this output is used only for this single export, and is not the same key as this card's
 *     track stream);
 *   - Priority `EXPORT_FRAMES_PRIORITY`, queued ahead of all other fine-grained tasks (the user
 *     is waiting for export).
 * When `exportStreams` is not provided, splitting is verbatim identical to before.
 *
 * Pure function: does not read environment variables, performs no I/O.
 */

/** Frame count per track stream segment (G2 segmentation rule; taken from `src/render/streamSegments.mjs`, no separate number). */
const SEGMENT_FRAMES = STREAM_SEGMENT_FRAMES;
const ANCHOR_PRIORITY = 50;
const NORMAL_PRIORITY = 10;
/** Priority of sparse stream tasks: ahead of full-density stream tasks and normal snapshot tasks (`NORMAL_PRIORITY`), behind anchor frames (`ANCHOR_PRIORITY`) */
export const SPARSE_STREAM_PRIORITY = 30;

/**
 * Coarse task for this project version (the one published by the publisher).
 * When `codeVersion` / `envFingerprint` are provided, they are written into `requires` (contract J.3);
 * only nodes with matching code version and fingerprint can claim this plan; unprovided fields are
 * omitted, with `requires` identical to B.4. id and resultKey do not vary with them.
 */
export function planTaskOf({ projectId, projectRev, priority = 0, codeVersion, envFingerprint, preferNode }) {
  const resultKey = `${projectId}@${projectRev}`;
  const requires = {};
  if (codeVersion !== undefined) requires.codeVersion = codeVersion;
  if (envFingerprint !== undefined) requires.envFingerprint = envFingerprint;
  // M6c X4: the publisher's own node claims preferentially (exclusive window PLAN_PREFER_MS); after
  // the window, given to any PC with a matching fingerprint
  if (preferNode !== undefined) requires.preferNode = preferNode;
  return {
    id: taskIdOf({ kind: 'plan', resultKey, range: null }), kind: 'plan', resultKey, range: null,
    source: { projectId, projectRev }, input: {}, weight: { class: 'medium', estMs: null, frames: null },
    requires, priority,
  };
}

/**
 * Prerender retry plan task (c10a contract section 17) (`backfill` tier of old pages; starting from
 * 2026-10-07 online pages always send normal-priority manifest plans, so this tier has no new
 * publishers and is kept only to recognize legacy pages during deployment cutover): published when
 * legacy pages find layers classified as heavy have no outputs in the asset service, carrying a
 * clip manifest (`input.clips`), marked with `priority: 'backfill'`. The node claiming it computes
 * keys treating clips in the manifest as heavy cards and splits out fine-grained tasks, which are
 * likewise marked with `backfill` (`lane` in `splitPlan`). Shape and validation reside on the queue
 * side (`messages.mjs`).
 */
export { backfillPlanTaskOf, isBackfillPlan, clipsPlanTaskOf, isClipsPlan, isListPlan };

/** `[from, to]` closed-interval sequence: first .. last in segments of span, with the last segment to last; if minSpan is given and the tail segment is under minSpan, merged into the previous segment. */
function spans(first, last, span, minSpan = 1) {
  const out = [];
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return out;
  for (let from = first; from <= last; from += span) out.push([from, Math.min(last, from + span - 1)]);
  if (minSpan > 1 && out.length > 1) {
    const lastSpan = out[out.length - 1];
    if (lastSpan[1] - lastSpan[0] + 1 < minSpan) {
      out[out.length - 2][1] = lastSpan[1];
      out.pop();
    }
  }
  return out;
}

const stepOf = value => Math.max(1, Math.floor(Number(value) || 0));

/** Task lock key (contract F.1): only one implementation exists on the queue side; re-exported here, with the node side obtaining it from the split module as before. */
export { lockKeyOf };

/** Lock fingerprint only recognizes non-empty strings; other values (`null`, empty string, non-string) are always treated as unlocked. */
const fingerprintOr = value => (typeof value === 'string' && value !== '' ? value : null);

/** `cardLocks` (Map or plain object) → `(lockKey) => lock fingerprint | null`. Plain objects check own properties only. */
function lockLookup(cardLocks) {
  if (cardLocks == null) return () => null;
  if (typeof cardLocks.get === 'function') return key => fingerprintOr(cardLocks.get(key));
  if (typeof cardLocks === 'object') {
    return key => (Object.prototype.hasOwnProperty.call(cardLocks, key) ? fingerprintOr(cardLocks[key]) : null);
  }
  return () => null;
}

/** `takeover` (boolean / Set / function) → `(lockKey) => boolean`. Other values are treated as not taking over. */
function takeoverTest(takeover) {
  if (takeover === true) return () => true;
  if (typeof takeover === 'function') return key => takeover(key) === true;
  if (takeover != null && typeof takeover.has === 'function') return key => takeover.has(key) === true;
  return () => false;
}

/** Weights claimable by pure browsers (`DEFAULT_WEIGHT_POLICY.browser` in filter.mjs) */
const BROWSER_WEIGHTS = new Set(['light', 'medium']);

/**
 * Determines whether the card corresponding to the stream is motion-style (as opposed to
 * remotion-style).
 * Basis: writing, frameMode on control / stream, or review table capabilities.
 */
export function isMotionCard(control, stream) {
  const writing = control?.writing ?? control?.capabilities?.writing ?? stream?.writing;
  if (writing === 'remotion') return false;
  if (writing === 'motion') return true;

  const cardId = control?.cardId ?? stream?.cardId;
  if (cardId) {
    const rev = reviewedCard(cardId);
    if (rev?.writing === 'remotion') return false;
    if (rev?.writing === 'motion') return true;
  }

  const frameMode = control?.frameMode ?? control?.capabilities?.frameMode ?? stream?.frameMode;
  if (frameMode === 'direct') return false;
  if (frameMode === 'stateful') return true;

  return false;
}


/**
 * Which cards are inside this control (card ids, deduplicated). `cardIds` provided by
 * `planForQueue` via `withInnerCards` takes precedence; for callers without this field (old
 * callers, unit tests only providing `cardId`), it is that single `cardId`, or empty if absent.
 */
export function cardIdsOf(control) {
  const list = Array.isArray(control?.cardIds) ? control.cardIds : [control?.cardId];
  return [...new Set(list.filter(id => typeof id === 'string' && id !== ''))];
}

/**
 * Whether tasks for this control need to execute user card code (`isUserCard` passed by
 * `planForQueue` to split): counts as true if the source version of any card inside starts with
 * `user:`. When unsure what is inside (`cardIdsUnsure`), counts as true as long as this version has
 * any user cards: prefer requiring an extra capability rather than letting nodes lacking it claim
 * the task.
 */
export function isUserCardControl(control, sourceVersions = {}) {
  const user = cardId => String(sourceVersions?.[cardId] ?? '').startsWith('user:');
  if (control?.cardIdsUnsure === true) return Object.keys(sourceVersions ?? {}).some(user);
  return cardIdsOf(control).some(user);
}

/**
 * "Which cards are inside" a node in the card graph: the node's own `cardId` comes first, then
 * gathered upstream layer-by-layer along `inputs` (inputs sorted by name, deduplicated). When a
 * clip has emphasis, filters, or sound effects attached, the output node is the outer layer
 * (`@clip/<id>/emphasis`, etc., without `cardId`), with cards behind its `inputs.source`; traversed
 * all the way down through however many layers are wrapped. Returns
 * `(nodeId) => { cardIds, unsure, canvasHeavy }`:
 * `unsure` is true: this node or one of its upstream nodes cannot be found in the graph (or forms a
 * cycle), so what is inside is uncertain;
 * `canvasHeavy` is true: this node or one of its upstream nodes is a canvas card (capability table
 * `canvasHeavy`).
 */
export function innerCardIds(graph) {
  const byId = new Map((graph?.nodes ?? []).filter(node => node?.id != null).map(node => [node.id, node]));
  const memo = new Map();
  const walk = (nodeId, path) => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    const node = byId.get(nodeId);
    if (!node || path.has(nodeId)) return { cardIds: [], unsure: true, canvasHeavy: false };
    path.add(nodeId);
    const ids = typeof node.cardId === 'string' && node.cardId ? [node.cardId] : [];
    let unsure = false;
    // The outer layer's capability table is derived from upstream, with only two entries: "whether to
    // prerender" and "whether below-dependent" (`projectCardGraph`), while the canvas card entry is on
    // the inner card's node
    let canvasHeavy = node.capabilities?.canvasHeavy === true;
    for (const name of Object.keys(node.inputs ?? {}).sort()) {
      const input = node.inputs[name];
      const up = walk(typeof input === 'string' ? input : input?.nodeId, path);
      if (up.unsure) unsure = true;
      if (up.canvasHeavy) canvasHeavy = true;
      for (const id of up.cardIds) if (!ids.includes(id)) ids.push(id);
    }
    path.delete(nodeId);
    const out = { cardIds: ids, unsure, canvasHeavy };
    // When a cycle forms, nodes along the path are only partially evaluated and not recorded; normal
    // graphs (which passed `validateCardGraph`) are acyclic and all recorded
    if (!unsure) memo.set(nodeId, out);
    return out;
  };
  return nodeId => walk(nodeId, new Set());
}

/**
 * Fills in the inner cards for each control in the card plan (used by `FramePipeline.planForQueue`;
 * controls in the card plan only have `nodeId`). [ruling] Policy:
 *
 *   - `cardIds`: card ids in the output node and all its upstream nodes (`innerCardIds`). Split
 *     uses this to determine "which cards' code is needed", "whether it is a user card", and
 *     "whether to give to browser".
 *   - `cardId` (written into task `input.cardId`): if the output node itself is a card, it is that
 *     card (verbatim identical to before); if the output node is not a card and there is exactly
 *     one card inside, it is that single card (clips with attached emphasis or filters); if there
 *     are no cards inside, more than one card (an outer layer connecting a two-clip transition), or
 *     uncertain, it is null.
 *   - `cardIdsUnsure: true`: what is inside is uncertain. Split calculates conservatively: requires
 *     code for all custom cards in this version, and does not give to browser nodes.
 *   - `innerCanvasHeavy: true`: the control's own capability table did not mark canvas card, but
 *     there is a canvas card inside (canvas cards with attached emphasis or filters). Split treats
 *     it as a canvas card: does not give to browser nodes, records weight as "heavy". Handles only
 *     these two matters; task `input.canvasHeavy` (size upper bound for manifest) does not change
 *     along with it: it must match the same value computed on the push side from the control
 *     capability table, and that side is not here.
 *
 * For controls where the output node itself is a card with no other cards upstream (normal card
 * clips), the filled-in `cardId` is identical to before, `cardIds` has only that single card, and
 * split tasks remain field-by-field unchanged.
 */
export function withInnerCards(cardPlan, graph) {
  const inner = innerCardIds(graph);
  const own = new Map((graph?.nodes ?? []).map(node => [node?.id, typeof node?.cardId === 'string' && node.cardId ? node.cardId : null]));
  return (cardPlan ?? []).map(control => {
    const { cardIds, unsure, canvasHeavy } = inner(control?.nodeId);
    const given = typeof control?.cardId === 'string' && control.cardId ? control.cardId : null;
    const all = given && !cardIds.includes(given) ? [given, ...cardIds] : cardIds;
    const cardId = given ?? own.get(control?.nodeId) ?? (all.length === 1 && !unsure ? all[0] : null);
    const out = { ...control, cardId, cardIds: [...all] };
    if (unsure) out.cardIdsUnsure = true;
    if (canvasHeavy && control?.capabilities?.canvasHeavy !== true) out.innerCanvasHeavy = true;
    return out;
  });
}

/**
 * Whether pure browsers can handle this card (M7 contract D1, D4): shared tier, standalone card,
 * light / medium, does not use media located only on the publisher's local machine;
 * built-in cards must not have modified source code (`cardSources` is empty); user cards and media
 * effect cards (block N) require that this page declares execution capability (`pageCards`) and
 * that this page has all code identities required by this card;
 * also not a canvas card (`canvasHeavy`: frame-by-frame forward pass is not equivalent to desktop),
 * (Lottie media cards are no longer excluded: measured on 2026-10-14 during render refactor
 * "Gui-2", the size and elapsed time when the browser generates snapshots on the fly and renders
 * them to bitmaps are in the same order of magnitude as other built-in heavy cards, see the Lottie
 * section in `docs/plan/render-standard.md`),
 * contains at most one card and it can be identified (`cardIdsOf`, `cardIdsUnsure`; never grant if
 * unsure),
 * caller did not flag that its frames exceed the size limit (`control.snapshotOversize`, provided
 * by the executor based on content keys already recorded as oversized in the local snapshot store).
 * `requires` is the requires of this card's own copy (already contains localMedia).
 */
function browserEligible({ tier, compositing, requires, weight, control, pageCards = null }) {
  return tier === 'shared' && compositing === 'independent'
    && cardCodeAllowed(requires, pageCards)
    && !('localMedia' in requires)
    && BROWSER_WEIGHTS.has(weight?.class)
    && control?.capabilities?.canvasHeavy !== true && control?.innerCanvasHeavy !== true
    && cardIdsOf(control).length <= 1 && control?.cardIdsUnsure !== true
    && control?.snapshotOversize !== true;
}

/** Whether tasks for this card need to execute user card or media effect card code in the node */
const runsCardCode = requires => requires.userCards === true || requires.graphCards === true;

/**
 * Card code condition (part of `browserEligible`):
 *   Built-in cards: `cardSources` is empty (source code has not been modified);
 *   User cards and media effect cards: page declared corresponding capability, `cardSources`
 *   is non-empty (user cards always have code identities; empty means splitter has no
 *   identity to match against),
 *   every item's code identity is in `pageCards.cardSources` on the page (a mismatch for the
 *   same card means the page holds a different version, so do not grant).
 */
function cardCodeAllowed(requires, pageCards) {
  const sources = Object.entries(requires.cardSources ?? {});
  if (!runsCardCode(requires)) return requires.userCards === false && requires.graphCards === false && sources.length === 0;
  if (!pageCards) return false;
  if (requires.userCards === true && !pageCards.userCards) return false;
  if (requires.graphCards === true && !pageCards.graphCards) return false;
  if (sources.length === 0) return false;
  return sources.every(([cardId, version]) => pageCards.cardSources?.[cardId] === version);
}

/**
 * Isolated single-card project parameters required for the browser copy (M7 contract section 4.3):
 * the page loads following desktop `isolatedCardProject` transformations, excluding cardSampling
 */
function bakeInputOf(control) {
  const out = { start: control.start, end: control.end, count: control.count };
  if (control.sampling != null) out.sampling = structuredClone(control.sampling);
  return out;
}

const isInt = Number.isInteger;
const isNum = Number.isFinite;

/**
 * `input.stream` for the browser copy of a stream task: only recognizes single-card streams
 * (`kind: 'card'`, `plane: 'local'`, member is exactly this card), provided only when fields are
 * complete and shape is correct;
 * otherwise returns null (group streams, and streams from legacy callers that only gave stream keys
 * and segment ranges, do not produce a browser copy). `count` takes the frame count of the member
 * card: frames outside local frames 0 .. count-1 are fully transparent.
 * `originFrame` / `lastFrame`: the very first and last frames of this stream itself (project frame
 * numbers). The page converts segment numbers into frames according to them (`streamSegments.mjs`),
 * without computing them itself;
 * if the stream plan does not provide these two items (callers before the segment rule change), the
 * browser copy is not produced.
 * Streams flagged with `solo` (streams for source-dependent cards: need to decode assets and
 * execute media effect cards; streams for standalone cards whose frame uses 3D: the browser pixel
 * extraction path has not been verified) are also not produced:
 * these two categories are produced only by the desktop app and render hosts; browser nodes do not
 * receive such tasks (the splitter's own copy requires local transcoding, which `filter.mjs` rule 2
 * blocks anyway).
 * The exception is those with planar outer frames among `solo: 'flat'` (standalone cards flattened
 * out of cut segments): [ruling] R02 (user decision, 2026-10-22 "online browsers also produce
 * streams for heavy cards in cut segments"),
 * which produce a copy for the browser just like top-level planar standalone cards. The browser
 * identifies it as a virtual clip by the task's clip id, and builds the isolated project with the
 * cut segment chain
 * (`isolatedBakeProject` in `src/online/bakeTask.ts`), and the background stage extracts this
 * card's wrapper layer in the nested scene (`bakeFrame` in `src/StageView.tsx`).
 * Those with 3D outer frames (`control.appearance.frame`) are still produced only by the desktop
 * app and render hosts, same as top-level `'spatial'`.
 */
function browserStreamInputOf(stream, control) {
  if (stream?.kind !== 'card' || stream.plane !== 'local') return null;
  // The two categories of cards that stream independently (`soloStreamKind` in `frame-stream.mjs`:
  // source-dependent cards, standalone cards whose frames use 3D) only produce the splitter's own copy;
  // standalone cards with planar outer frames in cut segments (`'flat'`) are an exception
  // ([ruling] R02, see above)
  if (stream.solo && !(stream.solo === 'flat' && !frame3d(control?.appearance?.frame ?? control?.frame))) return null;
  const ids = stream.clipIds;
  if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== stream.topClipId || control?.clipId !== ids[0]) return null;
  const { bound, offset } = stream;
  const fps = Number(stream.fps), firstFrame = stream.firstFrame, total = stream.total, count = Number(control.count);
  const { originFrame, lastFrame } = stream;
  if (!(fps > 0) || !isInt(firstFrame) || !isInt(total) || total < 1 || !isInt(count) || count < 1) return null;
  if (!isStreamOrigin(originFrame) || !isInt(lastFrame) || lastFrame < originFrame) return null;
  if (!bound || !isInt(bound.x) || !isInt(bound.y) || !isInt(bound.w) || !isInt(bound.h) || bound.w < 2 || bound.h < 2 || bound.w % 2 || bound.h % 2) return null;
  if (!offset || !isNum(offset.x) || !isNum(offset.y)) return null;
  return { kind: 'card', plane: 'local', clipIds: [ids[0]], fps, bound: { x: bound.x, y: bound.y, w: bound.w, h: bound.h },
    offset: { x: offset.x, y: offset.y }, firstFrame, count, total, originFrame, lastFrame };
}

/**
 * → TaskInput[]: snapshots first (in cardPlan order, segment ascending), then track streams
 * (in streams order, segment ascending); keep only the first for the same id.
 */
export function splitPlan({
  planTask,
  entryKey,
  cardPlan,
  prerenderSet,
  streams = [],
  envFingerprint,
  codeVersion,
  cardSourceVersions = {},
  streamCardSources = null, // (stream) => Record<cardId, version>: custom cards used in the subset expanded from a stream (see `streamSources`); if omitted, all are required
  anchorFrames = [],
  weightOf = () => ({ class: 'heavy', estMs: null }),
  isUserCard = () => false,
  isGraphCard = () => false,
  constants = {},
  cardLocks = {},           // Map | Record<lockKey, envFingerprint> (contract F.2)
  takeover = false,         // boolean | Set<lockKey> | (lockKey) => boolean
  localMedia = null,        // Publisher's nodeId (M6c X2): if provided, write into requires.localMedia for tasks where usesLocalMedia evaluates to true
  usesLocalMedia = () => true,   // (control) => boolean; stream tasks pass { clipId: topClipId, kind: 'stream' }
  lane = 'normal',          // 'backfill': fine-grained tasks split from prerender retry plan tasks have priority always marked as 'backfill' (c10a contract section 17)
  sparseStreams = false,    // Whether the queue accepts sparse stream tasks (`node.welcome.sparseStreams`): only split sparse stream tasks when true, see "Sparse stream tasks" in the file header
  browserFingerprints = [], // Fingerprints of pure browser nodes online in this project for the same user (M7 contract D1): cards that are browser-eligible and unlocked produce an additional copy for each of these fingerprints
  browserCards = null,      // Block N: user cards and media effect cards that can run on this page (result of `browserCardsOf(planTask.input.browser)`), see "User cards and media effect cards can also be provided to the browser" above
  browserCardEnvFingerprints = [], // Block N: cardEnvFingerprint of online browser nodes confirmed by document service; if `browserCards.cardEnvFingerprint` is not in it, do not produce the browser copy for user cards and media effect cards
  exportStreams = [],       // Frame-by-frame bitmaps dedicated to export (only present for manifest plans for export), see "Frame-by-frame bitmaps dedicated to export" in the file header
  browser = null,           // Alternative notation for the above: `{ nodeId, envFingerprint }` or an array of it (shape in contract section 3.3).
                            // Note: the splitter does not read `planTask.input.browser` (self-reported by page); browser
                            // fingerprints provided by the document service prevail
}) {
  /**
   * Priority of fine-grained tasks: prerender retry tier is always 'backfill'; normal tier gives
   * integer rank by anchor frame as before
   */
  const priorityOf = anchored => (lane === 'backfill' ? 'backfill' : anchored ? ANCHOR_PRIORITY : NORMAL_PRIORITY);
  const snapshotSpan = stepOf(constants.SNAPSHOT_SPAN ?? QUEUE_DEFAULTS.SNAPSHOT_SPAN);
  const streamSegments = stepOf(constants.STREAM_SEGMENTS ?? QUEUE_DEFAULTS.STREAM_SEGMENTS);
  const { projectId, projectRev } = planTask?.source ?? {};
  const derivedFrom = planTask?.id ?? null;
  const anchors = [...(anchorFrames ?? [])];
  const lockOf = lockLookup(cardLocks);
  const takesOver = takeoverTest(takeover);
  /**
   * Browser fingerprint: non-empty string, deduplicated, not equal to own fingerprint (no separate
   * copy needed if identical)
   */
  const browserAlias = (Array.isArray(browser) ? browser : browser != null ? [browser] : []).map(b => b?.envFingerprint);
  /**
   * Browser fingerprints (non-empty string, deduplicated); those equal to own fingerprint do not
   * produce a separate copy, but own copy must also include the two items for page snapshot generation
   */
  const browserSet = new Set([...(Array.isArray(browserFingerprints) ? browserFingerprints : []), ...browserAlias]
    .filter(fp => typeof fp === 'string' && fp !== ''));
  const browserFps = [...browserSet].filter(fp => fp !== envFingerprint);
  /**
   * Runtime status of user cards and media effect cards on this page: self-reported by the page and
   * only counts if document service confirms that such an online node exists
   */
  const cardEnvSet = new Set((Array.isArray(browserCardEnvFingerprints) ? browserCardEnvFingerprints : []).filter(fp => typeof fp === 'string' && fp !== ''));
  const pageCards = browserCards && typeof browserCards.cardEnvFingerprint === 'string' && cardEnvSet.has(browserCards.cardEnvFingerprint) ? browserCards : null;
  const mediaOwner = typeof localMedia === 'string' && localMedia !== '' ? localMedia : null;
  /**
   * Local tier capability gate (M6c X2): when the input of this item uses media located only on the
   * publisher's local machine, add `localMedia` to requires
   */
  const gateLocalMedia = (requires, control) => {
    if (mediaOwner !== null && usesLocalMedia(control) === true) requires.localMedia = mediaOwner;
    return requires;
  };
  /**
   * Which fingerprint is used to generate keys at this layer: `{ fingerprint, takeover }`. `takeover`
   * is true only when truly taking over another fingerprint; tasks omit this field if unlocked or
   * having the same fingerprint (contract F.2).
   */
  const keyingOf = lockKey => {
    const locked = lockOf(lockKey);
    if (locked == null || locked === envFingerprint) return { fingerprint: envFingerprint, takeover: false };
    if (takesOver(lockKey)) return { fingerprint: envFingerprint, takeover: true };
    return { fingerprint: locked, takeover: false };
  };
  /**
   * Card code requirements (c66-host-cards, contract B.4 [revised for c66-host-cards]):
   * `cardSourceVersions` is the code identity of custom cards (user cards, cards modified in the
   * overlay layer) used in this revision. The shared tier only renders this single card and requires
   * only its own; the local tier and streams render the whole scene (the content key of the local tier
   * contains entry.key, and the whole-scene key carries the identities of all custom cards), requiring
   * all of them.
   */
  const allCardSources = () => {
    const out = {};
    for (const [cardId, version] of Object.entries(cardSourceVersions ?? {})) if (typeof version === 'string' && version) out[cardId] = version;
    return out;
  };
  /**
   * Code identities required by a stream (the splitter's own copy) (0.7.19 multi-project mode:
   * calculated according to the subset expanded from this stream, `streamNeed` / `subsetCardSources` in
   * `render-node/expand.mjs`; nodes producing streams build isolated projects following the same
   * subset). When caller does not provide `streamCardSources` (legacy executor, test double) or cannot
   * compute it, all are required as before
   */
  const streamSources = stream => {
    if (typeof streamCardSources !== 'function') return allCardSources();
    let got = null;
    try { got = streamCardSources(stream); } catch { got = null; }
    if (!got || typeof got !== 'object') return allCardSources();
    const out = {};
    for (const [cardId, version] of Object.entries(got)) if (typeof version === 'string' && version && cardSourceVersions?.[cardId] === version) out[cardId] = version;
    return out;
  };
  /**
   * Heaviness of a card: provided by the caller; if it contains a canvas card but the control itself
   * did not flag it (`innerCanvasHeavy`), it is recorded as "heavy" following canvas cards
   */
  const cardWeightOf = control => (control?.innerCanvasHeavy === true ? { ...weightOf(control), class: 'heavy' } : weightOf(control));
  /**
   * Code identities required by tasks that only render this single clip (shared tier snapshots,
   * browser copy of single-card streams): one entry for each custom card inside the clip (`cardIdsOf`:
   * clips with emphasis or filters attached take the card inside); if unsure what is inside
   * (`cardIdsUnsure`), require all of them.
   */
  const ownCardSources = control => {
    if (control?.cardIdsUnsure === true) return allCardSources();
    const out = {};
    for (const cardId of cardIdsOf(control)) {
      const version = cardSourceVersions?.[cardId];
      if (version) out[cardId] = version;
    }
    return out;
  };
  /**
   * Which copies of results for this card are produced by browsers (M7 D1, block N; shared by
   * snapshots and single-card streams): `eligible`: whether it can be handled; `copyFps`: which
   * additional fingerprints to produce (user cards and media effect cards use the page's
   * cardEnvFingerprint; built-in cards use the browser's envFingerprint); `browserOf`: which
   * fingerprints' copies must include inputs required by the page.
   */
  const browserPlanOf = ({ tier, compositing, requires, weight, control }) => {
    const cardTask = runsCardCode(requires);
    const eligible = (cardTask ? pageCards !== null : browserSet.size > 0) && browserEligible({ tier, compositing, requires, weight, control, pageCards });
    const copyFps = cardTask ? (pageCards ? [pageCards.cardEnvFingerprint] : []) : browserFps;
    const browserOf = cardTask ? new Set(copyFps) : browserSet;
    return { eligible, copyFps, browserOf };
  };
  const out = [];
  const seen = new Set();
  const emit = task => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    out.push(task);
  };

  for (const control of cardPlan ?? []) {
    const { snapshotKey, clipId } = control ?? {};
    if (!snapshotKey || !clipId) continue;
    if (prerenderSet && !prerenderSet.has(clipId)) continue;
    const tier = control.tier ?? snapshotTier(control.capabilities);
    if (tier !== 'shared' && tier !== 'local') continue;
    // Content key for local tier requires entry.key; skip if not provided, avoiding keys like
    // `undefined/<sharedKey>` (contract A.10a)
    if (tier === 'local' && (entryKey == null || entryKey === '')) continue;
    const baseKey = control.contentKey ?? snapshotKey;
    const contentKey = tier === 'shared' ? baseKey : `${entryKey}/${baseKey}`;
    const lockKey = `snapshot:${contentKey}`;
    const keying = keyingOf(lockKey);
    const cardId = control.cardId ?? null;
    // Determines manifest size limit; must be consistent across push and pull sides (C6.2 section 11
    // item 2, J.3)
    const canvasHeavy = control.capabilities?.canvasHeavy === true;
    const compositing = control.compositing ?? control.capabilities?.compositing;
    // Anchor frame is a global frame number; convert to this card's local frame before comparing;
    // cannot determine without firstFrame, treated as ordinary segment throughout
    const firstFrame = Number(control.sampling?.firstFrame);
    const requires = {
      envFingerprint: keying.fingerprint, codeVersion,
      cardSources: tier === 'local' ? allCardSources() : ownCardSources(control),
      transcode: false,
      userCards: !!isUserCard(control),
      graphCards: !!isGraphCard(control),
      belowDependent: compositing === 'belowDependent',
    };
    gateLocalMedia(requires, control);
    const weight = cardWeightOf(control);
    // M7 D1: Which copies to produce for this card. If unlocked (or locked to own fingerprint) and
    // browser-eligible, produce additional copies for browser fingerprints; if locked elsewhere,
    // produce only one copy following the lock
    // The browser copy for user cards and media effect cards (block N) uses the page's
    // cardEnvFingerprint; built-in cards use the browser's envFingerprint as before
    const { eligible, copyFps, browserOf } = browserPlanOf({ tier, compositing, requires, weight, control });
    const fingerprints = eligible && lockOf(lockKey) == null && keying.fingerprint === envFingerprint ? [keying.fingerprint, ...copyFps] : [keying.fingerprint];
    const dual = fingerprints.length > 1;
    for (const fingerprint of fingerprints) {
      const resultKey = resultKeyOf(contentKey, fingerprint);
      // The browser copy (or the copy produced according to the lock when locked to a browser
      // fingerprint) carries the two items required by the page to generate snapshots
      const forBrowser = eligible && browserOf.has(fingerprint);
      const inputOf = () => {
        const input = { clipId, cardId, entryKey: tier === 'local' ? entryKey : null, contentKey, canvasHeavy };
        if (dual) input.dual = true;
        if (forBrowser) Object.assign(input, { compositing, bake: bakeInputOf(control) });
        return input;
      };
      for (const [from, to] of spans(0, Number(control.count) - 1, snapshotSpan)) {
        const range = { unit: 'localFrame', from, to };
        const anchored = anchors.some(a => from <= a - firstFrame && a - firstFrame <= to);
        const task = {
          id: taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier, resultKey, range,
          source: { projectId, projectRev, derivedFrom },
          input: inputOf(),
          weight: { ...weight, frames: to - from + 1 },
          requires: { ...requires, envFingerprint: fingerprint, cardSources: { ...requires.cardSources } },
          priority: priorityOf(anchored),
        };
        if (keying.takeover) task.takeover = true;
        emit(task);
      }
    }
  }

  /**
   * Member cards of a stream: clipId → control (the item in card plan, with cardId and
   * snapshotOversize flagged by the executor)
   */
  const controlOf = new Map();
  for (const control of cardPlan ?? []) if (control?.clipId && !controlOf.has(control.clipId)) controlOf.set(control.clipId, control);

  for (const stream of streams ?? []) {
    const { streamKey, topClipId, firstSegment, lastSegment } = stream ?? {};
    if (!streamKey) continue;
    const contentKey = stream.contentKey ?? streamKey;
    const lockKey = `stream:${contentKey}`;
    const keying = keyingOf(lockKey);
    // Below-dependent streams: rendered as whole scene, only producing the splitter's own copy (not
    // recognized by `browserStreamInputOf` below, `browser` is always null)
    const belowStream = stream.kind === 'below';
    const weight = belowStream ? { ...weightOf(controlOf.get(topClipId) ?? { clipId: topClipId }), class: 'heavy' } : weightOf(controlOf.get(topClipId) ?? { clipId: topClipId });
    // Browser copy (single-card stream): member card eligibility is determined following snapshot
    // task rules, and requires is also written following that card's snapshot task (only renders this
    // single card)
    const control = controlOf.get(topClipId) ?? null;
    const streamInput = control ? browserStreamInputOf(stream, control) : null;
    let browser = null;
    if (streamInput) {
      const caps = control.capabilities ?? {};
      const isStateful = control.tier === 'shared' || caps.frameMode === 'stateful' || caps.need_prerendering === true || caps.needPrerendering === true || control.needPrerendering === true;
      if (isStateful) {
        const tier = 'shared';
        const compositing = control.compositing ?? caps.compositing;
        const requires = gateLocalMedia({
          envFingerprint: keying.fingerprint, codeVersion,
          cardSources: ownCardSources(control),
          transcode: false,
          userCards: !!isUserCard(control),
          graphCards: !!isGraphCard(control),
          belowDependent: compositing === 'belowDependent',
          capabilities: { streams: true },
        }, control);
        const cardWeight = cardWeightOf(control);
        const plan = browserPlanOf({ tier, compositing, requires, weight: cardWeight, control });
        if (plan.eligible) {
          // Browser copy of stream does not include splitter's own fingerprint: with same fingerprint, task
          // ids for both copies would be identical, whereas the splitter copy requires local transcoding
          const copyFps = plan.copyFps.filter(fp => fp !== envFingerprint);
          browser = { copyFps, browserOf: new Set(copyFps), requires, weight: cardWeight, compositing, control, input: streamInput };
        }
      }
    }
    // Which copies to produce: if unlocked (or locked to own fingerprint without takeover), one copy
    // for splitter and one for each browser; if locked elsewhere, produce only one copy following the lock
    const wantsOwn = stream.browserOnly !== true;
    // Own copy only produces the sparse version (see "Sparse stream tasks" in file header); if the
    // queue does not accept sparse stream tasks, this copy is effectively omitted
    const ownSparseOnly = stream.ownSparseOnly === true;
    const copies = [];
    if (browser && lockOf(lockKey) == null && keying.fingerprint === envFingerprint) {
      if (wantsOwn && !(ownSparseOnly && browser.copyFps.length > 0)) copies.push({ fingerprint: keying.fingerprint, forBrowser: false });
      for (const fingerprint of browser.copyFps) copies.push({ fingerprint, forBrowser: true });
    } else {
      const forBrowser = !!browser && browser.browserOf.has(keying.fingerprint);
      if (forBrowser || wantsOwn) copies.push({ fingerprint: keying.fingerprint, forBrowser });
    }
    const isMotion = isMotionCard(control, stream);
    const streamFps = Number(stream?.fps) > 0 ? Number(stream.fps) : 30;
    const motionSpan = Math.ceil(30 * streamFps / SEGMENT_FRAMES);
    const dual = copies.length > 1;
    for (const { fingerprint, forBrowser } of copies) {
      const resultKey = resultKeyOf(contentKey, fingerprint);
      // Sparse first, then full density (sparse tasks are dispatched first within the same stream); if
      // own copy is flagged with `ownSparseOnly`, full density is not produced
      const densities = [...(sparseStreams === true ? [STREAM_DENSITY_SPARSE] : []), ...(!forBrowser && ownSparseOnly ? [] : [null])];
      for (const density of densities) {
        const span = density === STREAM_DENSITY_SPARSE
          ? Math.max(1, lastSegment - firstSegment + 1)
          : isMotion
            ? motionSpan
            : streamSegments;
        const minSpan = (!density && isMotion) ? motionSpan : 1;
        for (const [from, to] of spans(firstSegment, lastSegment, span, minSpan)) {
        const range = { unit: 'segment', from, to };
        // Frame count for this segment task: calculated according to actual values when stream plan
        // includes firstFrame and lastFrame (final segment of a stream can have fewer than 15 frames),
        // estimated as a full segment if omitted
        let frames = (to - from + 1) * SEGMENT_FRAMES;
        if (isStreamOrigin(stream.originFrame) && isInt(stream.lastFrame)) {
          frames = 0;
          for (let n = from; n <= to; n++) frames += streamSegmentFrameCount(n, stream.originFrame, stream.lastFrame);
        }
        const input = forBrowser
          ? { clipId: topClipId, cardId: browser.control.cardId ?? null, entryKey: null, contentKey, canvasHeavy: false }
          : { clipId: topClipId, cardId: null, entryKey: null, contentKey };
        if (dual) input.dual = true;
        if (density) input.density = density;
        if (forBrowser) Object.assign(input, { compositing: browser.compositing, bake: bakeInputOf(browser.control), stream: structuredClone(browser.input) });
        const task = {
          id: taskIdOf({ kind: 'stream', resultKey, range, density }), kind: 'stream', resultKey, range,
          source: { projectId, projectRev, derivedFrom },
          input,
          weight: forBrowser ? { ...browser.weight, frames } : { ...weight, frames },
          requires: forBrowser
            ? { ...browser.requires, envFingerprint: fingerprint, cardSources: { ...browser.requires.cardSources }, capabilities: { streams: true } }
            : gateLocalMedia({
              envFingerprint: fingerprint, codeVersion, cardSources: streamSources(stream),
              transcode: true, userCards: false, graphCards: false, belowDependent: belowStream,
              // M6c X1: only nodes reporting `capabilities.streams: true` (encoder detected) can claim
              // (filter.mjs rule 2)
              capabilities: { streams: true },
            }, belowStream
              ? { clipId: topClipId, kind: 'stream', streamKind: 'below', belowClipIds: Array.isArray(stream.belowClipIds) ? [...stream.belowClipIds] : [] }
              : { clipId: topClipId, kind: 'stream' }),
          priority: density && lane !== 'backfill' ? SPARSE_STREAM_PRIORITY : priorityOf(false),
        };
        // Takeover belongs only to the splitter's own copy; omitted for the browser copy following
        // snapshot rules
        if (keying.takeover && !forBrowser) task.takeover = true;
        emit(task);
      }
    }
  }
}

  // Frame-by-frame bitmaps dedicated to export: one group per track, producing only its own copy
  // (see file header)
  for (const stream of exportStreams ?? []) {
    const { clipId, exportKey, lastSegment } = stream ?? {};
    if (typeof clipId !== 'string' || !clipId || typeof exportKey !== 'string' || !exportKey || !isInt(lastSegment) || lastSegment < 0) continue;
    if (typeof envFingerprint !== 'string' || !envFingerprint) continue;
    const resultKey = resultKeyOf(exportKey, envFingerprint);
    const belowStream = stream.kind === 'below';
    const control = controlOf.get(clipId) ?? { clipId };
    const weight = belowStream ? { ...weightOf(control), class: 'heavy' } : weightOf(control);
    for (const [from, to] of spans(0, lastSegment, streamSegments)) {
      const range = { unit: 'segment', from, to };
      let frames = (to - from + 1) * SEGMENT_FRAMES;
      if (isStreamOrigin(stream.originFrame) && isInt(stream.lastFrame)) {
        frames = 0;
        for (let n = from; n <= to; n++) frames += streamSegmentFrameCount(n, stream.originFrame, stream.lastFrame);
      }
      emit({
        id: taskIdOf({ kind: 'stream', resultKey, range }), kind: 'stream', resultKey, range,
        source: { projectId, projectRev, derivedFrom },
        input: { clipId, cardId: null, entryKey: null, exportFrames: true, exportKey, ...(stream.salt ? { exportSalt: stream.salt } : {}),
          stream: { clipId, kind: stream.kind, plane: stream.plane, fps: stream.fps, originFrame: stream.originFrame, lastFrame: stream.lastFrame,
            rect: stream.rect ? { ...stream.rect } : null, offset: stream.offset ? { ...stream.offset } : null } },
        weight: { ...weight, frames },
        requires: gateLocalMedia({
          envFingerprint, codeVersion, cardSources: allCardSources(),
          transcode: false, userCards: false, graphCards: false, belowDependent: belowStream,
        }, belowStream
          ? { clipId, kind: 'stream', streamKind: 'below', belowClipIds: Array.isArray(stream.belowClipIds) ? [...stream.belowClipIds] : [] }
          : { clipId, kind: 'stream' }),
        priority: EXPORT_FRAMES_PRIORITY,
      });
    }
  }
  return out;
}
