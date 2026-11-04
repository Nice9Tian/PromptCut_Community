/**
 * Tuning constants for render queue (baseline values from design section 8 Q4).
 *
 * M1 / M2 use only baseline values and export future env var names without reading env vars:
 * reading env vars is the job of the adapter layer attached to document service (M5);
 * the queue itself remains pure logic, and tests are covered via `createRenderQueue({ constants })`.
 */

export const QUEUE_DEFAULTS = Object.freeze({
  LEASE_MS: 30_000, RENEW_INTERVAL_MS: 10_000, SWEEP_INTERVAL_MS: 5_000,
  RECONNECT_GRACE_MS: 10_000, STALL_MS: 120_000, MAX_ATTEMPTS: 3,
  DONE_TTL: 600_000, MAX_TASKS_PER_PROJECT: 5000,
  SNAPSHOT_SPAN: 60, STREAM_SEGMENTS: 8, PICK_K: 4,
  // Switch for pre-filtering by node fingerprint (contract I.1); when false, behavior is identical
  // to before adding this item, acting as control group. The only non-numeric entry
  PREFILTER: true,
  // If card-locked rejections exceed this count within one sweep cycle, subsequent claims on this
  // connection return throttled until the next tick (I.5)
  THROTTLE_REJECTS: 20,
  // Exclusive window for nearby claim of plan (M6c X4): for this duration after publishing a plan
  // with requires.preferNode, only that node can claim
  PLAN_PREFER_MS: 5_000,
});

/** Names to use when extracted into env vars later (table in design section 8), keys map 1:1 to QUEUE_DEFAULTS */
export const QUEUE_ENV = Object.freeze({
  LEASE_MS: 'PROMPTCUT_QUEUE_LEASE_MS', RENEW_INTERVAL_MS: 'PROMPTCUT_QUEUE_RENEW_MS',
  SWEEP_INTERVAL_MS: 'PROMPTCUT_QUEUE_SWEEP_MS', RECONNECT_GRACE_MS: 'PROMPTCUT_QUEUE_GRACE_MS',
  STALL_MS: 'PROMPTCUT_QUEUE_STALL_MS', MAX_ATTEMPTS: 'PROMPTCUT_QUEUE_MAX_ATTEMPTS',
  DONE_TTL: 'PROMPTCUT_QUEUE_DONE_TTL_MS', MAX_TASKS_PER_PROJECT: 'PROMPTCUT_QUEUE_MAX_TASKS',
  SNAPSHOT_SPAN: 'PROMPTCUT_QUEUE_SNAPSHOT_SPAN', STREAM_SEGMENTS: 'PROMPTCUT_QUEUE_STREAM_SEGMENTS',
  PICK_K: 'PROMPTCUT_QUEUE_PICK_K',
  PREFILTER: 'PROMPTCUT_QUEUE_PREFILTER', THROTTLE_REJECTS: 'PROMPTCUT_QUEUE_THROTTLE_REJECTS',
  PLAN_PREFER_MS: 'PROMPTCUT_QUEUE_PLAN_PREFER_MS',
});

/**
 * How long a queue lock can stay idle before splitter takes over (M7 contract D2, section 13
 * ruling): strictly exceeding this duration without output (claim, renew, complete) while this
 * card is not yet finished by the locking party, pc and standalone render host resend with
 * takeover under their own fingerprint upon split (`idleLockTakeover` in
 * `render-node/local-node.mjs`). Same number as `CARD_LOCK_IDLE_MS` in local lock store
 * `server/card-lock.mjs` (tier-3 number); that side imports filesystem which node side cannot
 * import, so recorded separately here, with unit tests checking both sides match. Not an entry
 * in QUEUE_DEFAULTS: render queue itself does not use it.
 */
export const LOCK_IDLE_TAKEOVER_MS = 30_000;

/**
 * Interval for node to report "still here, busy" (`node.active`, M7 D2 supplement [ruling],
 * `claude/queue-maint`): queue informs node via `activeIntervalMs` in `node.welcome`, and node
 * reports according to it when busy (generating snapshots for other cards, background stage
 * measuring or running catch-up runs) without holding a claim on this card.
 * Must be significantly less than `LOCK_IDLE_TAKEOVER_MS`: lock idleness between two reports
 * grows at most to this duration, far below the takeover gate (tier-3 number, reusing renewal
 * interval). Not an entry in QUEUE_DEFAULTS (keys in that table are strictly fixed by contract A.2).
 */
export const NODE_ACTIVE_INTERVAL_MS = 10_000;
