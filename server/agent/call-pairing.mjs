/**
 * Tool call pairing for both codex and agy: allows calls coming in via MCP to get the same `callId`
 * as the one in chat history.
 *
 * Claude Code directly carries the model-side id in `_meta["claudecode/toolUseId"]` of MCP
 * `tools/call`, and its output stream uses this same id, so both sides match naturally. codex and agy
 * do not carry it (for actual measurements see `docs/archive/agent-reports/AGENT-runner-callid.md`):
 *   - codex's `_meta` has `threadId` (= thread_id of `thread.started` in output stream) and its own
 *     `callId` ("exec-<uuid>"), but the id of tool entries in the output stream is like `item_0`,
 *     `item_1`, which does not match `_meta.callId`;
 *   - agy's `_meta` has `antigravity.google/conversation_id` (= conversation_id of output stream) and
 *     `progressToken: "<uuid>:<step_number>"`, where step_number is step_index of step_update in
 *     the output stream (the step number keeps increasing when continuing the same chat).
 *
 * So when the runner sees a tool call start in the output stream, it "checks in" (`announce`: scope,
 * tool name, args, the callId it sent to the page), and calls coming from MCP "claim" (`claim`) by
 * (scope, tool name, args). The scope is codex's thread or agy's chat, which is narrower than an
 * Agent page: successive rounds within the same page will not collide.
 *
 * Rules (better to leave unpaired than pair incorrectly: if pairing fails, fall back to original
 * behavior: events do not carry callId, and can only be undone in Agent operation history):
 *   - Those with a hint (`hint`, callId calculated by agy from step number) only accept that single
 *     one: paired only if present in check-in and both tool name and args match;
 *   - Those without a hint (codex) look within the same scope for an unclaimed check-in with matching
 *     tool name and args: paired only if exactly one; not paired if two or more (parallel calls with
 *     same name and args);
 *   - No check-in yet (MCP arrived first): wait briefly; if a second claimant arrives for the same
 *     key while waiting, treated as ambiguous and neither is paired;
 *   - When the runner sees this call end, it "settles" (`settle`) this check-in: unclaimed ones are
 *     also deleted to avoid blocking subsequent calls with same name and args;
 *   - When a runner run ends (`close`), delete all check-ins it announced.
 */

/** Canonical representation of args: JSON with sorted keys. Both sides parse from the same JSON, differing only in key order */
export function argsKey(args) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  try { return JSON.stringify(norm(args ?? {})); } catch { return null; }
}

/**
 * @param {object} [o]
 * @param {number} [o.waitMs] When scope is known (runner is running), max wait time for a check-in
 *   when claiming
 * @param {number} [o.unknownWaitMs] How long to wait when scope is unknown (CLI was not launched by
 *   this server, or runner has not read the first line yet)
 */
export function createCallPairing({ waitMs = 2000, unknownWaitMs = 300 } = {}) {
  /** callId → { scope, key, claimed } */
  const entries = new Map();
  /** Running scope → open count */
  const scopes = new Map();
  /** Claimants waiting for check-in: { scope, key, hint, resolve, timer } */
  const waiters = new Set();

  const keyOf = (tool, args) => {
    const a = argsKey(args);
    return a === null ? null : `${tool}\u0000${a}`;
  };

  function finish(w, callId) {
    clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve(callId);
  }

  /** Unclaimed check-ins on the same key */
  function openEntries(scope, key) {
    const out = [];
    for (const [callId, e] of entries) if (e.scope === scope && e.key === key && !e.claimed) out.push(callId);
    return out;
  }

  /** Finds matching check-in by rules; returns null if none yet, false if pairing impossible (ambiguous, or tool name/args do not match hint) */
  function pick(scope, key, hint) {
    if (hint) {
      // Those with a hint only match that hinted one: if hint format ever changes, better to fail pairing than guess by parameters
      const e = entries.get(hint);
      if (!e) return null;
      return e.scope === scope && e.key === key && !e.claimed ? hint : false;
    }
    const open = openEntries(scope, key);
    if (open.length === 1) return open[0];
    if (open.length > 1) return false;
    return null;
  }

  function take(callId) {
    const e = entries.get(callId);
    if (e) e.claimed = true;
    return callId;
  }

  return {
    /** Opens the scope when runner starts and reads thread / chat id; returns a close function */
    open(scope) {
      if (!scope) return () => {};
      scopes.set(scope, (scopes.get(scope) || 0) + 1);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const n = (scopes.get(scope) || 1) - 1;
        if (n > 0) scopes.set(scope, n); else scopes.delete(scope);
      };
    },

    /** runner: a PromptCut tool call started in the output stream. callId is the one it sent to the page */
    announce(scope, tool, args, callId) {
      const key = keyOf(tool, args);
      if (!scope || !key || !callId || entries.has(callId)) return;
      entries.set(callId, { scope, key, claimed: false });
      const same = [...waiters].filter((w) => w.scope === scope && w.key === key);
      // Claimant waiting with this hint: this is it
      const exact = same.find((w) => w.hint === callId);
      if (exact) return finish(exact, take(callId));
      // Claimants without a hint: paired only if exactly one; if two or more wait on same key, ambiguous, so none are paired
      const loose = same.filter((w) => !w.hint);
      if (loose.length === 1) return finish(loose[0], take(callId));
      for (const w of loose) finish(w, undefined);
    },

    /** runner: this call ended (success or failure) */
    settle(callId) {
      entries.delete(callId);
    },

    /** Runner run ended: delete everything it announced that is still left */
    forget(callIds) {
      for (const id of callIds) entries.delete(id);
    },

    /**
     * A call comes in from the MCP side, claims its callId. Returns undefined if pairing fails.
     * @returns {Promise<string | undefined>}
     */
    claim(scope, tool, args, hint) {
      const key = keyOf(tool, args);
      if (!scope || !key) return Promise.resolve(undefined);
      const hit = pick(scope, key, hint);
      if (hit) return Promise.resolve(take(hit));
      if (hit === false) return Promise.resolve(undefined);
      // Not checked in yet: wait. Someone is already waiting on same key (parallel calls with same name and args), cannot distinguish
      const rival = hint ? null : [...waiters].find((w) => w.scope === scope && w.key === key && !w.hint);
      if (rival) {
        finish(rival, undefined);
        return Promise.resolve(undefined);
      }
      const ms = scopes.has(scope) ? waitMs : unknownWaitMs;
      return new Promise((resolve) => {
        const w = { scope, key, hint, resolve, timer: null };
        w.timer = setTimeout(() => finish(w, undefined), ms);
        w.timer.unref?.();
        waiters.add(w);
      });
    },

    /** For diagnostics and testing */
    stats() {
      return { entries: entries.size, waiters: waiters.size, scopes: scopes.size };
    },
  };
}

/**
 * Small handle for a runner run: records callIds it announced, and deletes them all when run ends.
 * When `pairing` is not provided (tests, callers not connected to the editor), each method is a no-op.
 */
export function pairingSession(pairing) {
  const mine = new Set();
  const closers = new Map();
  return {
    open(scope) {
      if (!pairing || !scope || closers.has(scope)) return;
      closers.set(scope, pairing.open(scope));
    },
    announce(scope, tool, args, callId) {
      if (!pairing) return;
      mine.add(callId);
      pairing.announce(scope, tool, args, callId);
    },
    settle(callId) {
      if (!pairing) return;
      mine.delete(callId);
      pairing.settle(callId);
    },
    close() {
      if (!pairing) return;
      pairing.forget(mine);
      mine.clear();
      for (const c of closers.values()) c();
      closers.clear();
    },
  };
}
