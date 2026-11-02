/**
 * Pins down all "system time" and "true randomness" readable by cards (including third-party
 * libraries).
 *
 * # Why it is needed
 *
 * exportClock has long pinned performance.now / rAF / Math.random, but left three loopholes:
 *   1. `Date.now()` / `new Date()`: reads the wall clock, differing on every export;
 *   2. `crypto.getRandomValues` / `crypto.randomUUID`: true randomness;
 *   3. `Math.random` falls back to true randomness before the timeline is ready, and it was
 *      installed inside the ExportView module's **function body**: ESM evaluates all imports first,
 *      and `import "./cards"` had already loaded third-party libraries, which captured the
 *      **original** Math.random at module evaluation time.
 *
 * What actually hit this was lottie-web: at module load time it sets `BMMath.random = Math.random`
 * (lottie.js:202), and uses `crypto.getRandomValues` + `+new Date()` to auto-seed its built-in
 * seedrandom (lines 13967~13978). Expressions like `wiggle()` / `random()` in AE rely on it:
 * for a Lottie with one wiggle box + one random box, the current export pipeline exported twice
 * with **differing 89/90 and 90/90 frames**. Particles written by cards themselves are unaffected
 * (particles.tsx seeds itself using the seed in params); what is affected are things like this
 * that "covertly draw randomness inside libraries".
 *
 * # What it is pinned to
 *
 * - `Math.random`: seeded mulberry32, active **from the moment of installation** (no longer waiting
 *   for the timeline to be ready). Initial state and algorithm are identical to the one in
 *   exportClock; not a single number changed in the sequence after `__pcResetRandom(1)`, so visuals
 *   after remount match the old baseline; only the few calls **before** remount (during module
 *   load) changed.
 * - `Date.now()`, parameterless `new Date()` / `Date()`: fixed epoch + current frame milliseconds
 *   (export page uses `__pcExportMs`, render plane uses stage clock; before the clock is ready,
 *   it is the fixed epoch itself). Parameterized `new Date(x)`, `Date.parse`, `Date.UTC` remain
 *   untouched: those are calculations, not clock reads. Time advances with frames rather than
 *   freezing completely: some libraries use `Date.now()` for timeouts (Lottie's font loading
 *   polling), and freezing would cause them to wait indefinitely.
 * - `crypto.getRandomValues` / `crypto.randomUUID`: fill bytes using the same seed stream.
 *
 * # Why it must be installed first
 *
 * Libraries capture references during module evaluation and cannot see patches installed later.
 * It is therefore called by render/stageClockEntry.ts, which is the **first** import in
 * main.tsx / proto-main.tsx.
 *
 * Only pins randomness and the wall clock, **leaving performance.now and rAF untouched**:
 * installing those early would prematurely swap the timestamp source received by Motion (see the
 * "DOM mutation count" section in exportClock.ts), which is a different matter.
 *
 * Installed only in export view and render plane. It must not be installed in the editor main
 * document: its own ids and timestamps must be real.
 *
 * # Executing a function with a specified seed (`withSeededRandom`, prototype, 2026-10-12)
 *
 * A page-wide shared state means "who fetches first and how many times" shifts numbers received by
 * everyone downstream. `withSeededRandom(seed, fn)` runs fn in a sequence of its **own** random
 * numbers (starting from seed), restoring page-wide state afterwards to how it was before fn
 * started: however many times fn drew numbers, nothing is visible outside. It only governs the
 * synchronously executed portion; timers and Promise callbacks scheduled in fn are not included.
 *
 * Used by `src/cards/native/lottie.tsx` (disabled by default). Note that it is **only the second
 * layer there**: Lottie player expressions use their own internal stream (the aforementioned
 * `BMMath.random`); only when no expression on the page has seeded that stream yet does that stream
 * equal `Math.random` here. Thus what actually takes effect there is directly seeding the player's
 * internal stream; what is handled here are "numbers drawn from the page-wide stream when the first
 * Lottie on the page creates layers" and the few places in the player library calling
 * `Math.random()` directly.
 */

/**
 * Fixed epoch. Any "what time is it" reading counts from here; set to an exact hour mark just
 * to be recognizable.
 */
export const PINNED_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * Target object containing items to be pinned. In browsers this is window; unit tests pass in a
 * sandbox.
 */
export interface EntropyHost {
  Math: Math;
  Date: DateConstructor;
  crypto?: { getRandomValues: <T extends ArrayBufferView | null>(a: T) => T; randomUUID?: () => string };
  __pcExportMs?: number;
  __pcStageClock?: { now(): number };
  __pcResetRandom?: (seed?: number) => void;
  /**
   * Runs fn with specified seed, restoring page-wide random state to before fn started (see file
   * header).
   */
  __pcWithRandomSeed?: <T>(seed: number, fn: () => T) => T;
  __pcEntropyPinned?: boolean;
  /**
   * Real `Date.now` before takeover (E4b escape hatch; stage-side stageClock saves it earlier, not
   * overwritten here).
   */
  __pcRealDateNow?: () => number;
}

export function installPinnedEntropy(host: EntropyHost = window as unknown as EntropyHost): void {
  if (host.__pcEntropyPinned) return;
  host.__pcEntropyPinned = true;

  // ── Math.random: mulberry32, bit-for-bit identical to the one in exportClock ──
  let rngState = 1;
  const seeded = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  host.__pcResetRandom = (seed = 1) => {
    rngState = seed | 0;
  };
  host.__pcWithRandomSeed = <T>(seed: number, fn: () => T): T => {
    const saved = rngState;
    rngState = seed | 0;
    try {
      return fn();
    } finally {
      rngState = saved;
    }
  };
  host.Math.random = seeded;

  // ── Wall clock: fixed epoch + current frame ms ──
  const pageMs = () => {
    if (typeof host.__pcExportMs === "number") return host.__pcExportMs;
    if (host.__pcStageClock) return host.__pcStageClock.now();
    return 0;
  };
  const pinnedNow = () => PINNED_EPOCH_MS + Math.round(pageMs());
  const RealDate = host.Date;
  // E4b escape hatch: after takeover Date.now() is virtual time; places measuring real wall clock need
  // access to the original
  host.__pcRealDateNow ??= RealDate.now.bind(RealDate);
  // Shared prototype: `x instanceof Date` and methods on `Date.prototype` remain unchanged
  function PinnedDate(this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(pinnedNow()).toString();          // Date() called as a function = read clock
    if (args.length === 0) return new RealDate(pinnedNow());                // new Date() = read clock
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args); // With arguments = calculation, unchanged
  }
  PinnedDate.prototype = RealDate.prototype;
  const P = PinnedDate as unknown as DateConstructor & { now: () => number };
  P.now = pinnedNow;
  P.parse = RealDate.parse;
  P.UTC = RealDate.UTC;
  host.Date = P;

  // ── crypto: same seed stream as Math.random ──
  const c = host.crypto;
  if (c) {
    const fill = (u8: Uint8Array) => {
      for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(seeded() * 256);
    };
    c.getRandomValues = <T extends ArrayBufferView | null>(a: T): T => {
      if (a) fill(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      return a;
    };
    c.randomUUID = () => {
      const b = new Uint8Array(16);
      fill(b);
      b[6] = (b[6] & 0x0f) | 0x40; // Version 4
      b[8] = (b[8] & 0x3f) | 0x80; // Variant 10
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
  }
}

/**
 * Executes fn with a specified seed: `Math.random` in fn (and `crypto.getRandomValues` on pinned
 * pages) generates numbers from seed, restoring the random state afterwards to before fn started;
 * how many times fn draws numbers has no effect externally. Can be nested.
 *
 * On pinned pages (export view, render plane), the single shared state is swapped; on unpinned
 * pages (editor main document), `Math.random` is temporarily swapped to a seeded version of the
 * same algorithm, reverting to the original true randomness upon exit.
 *
 * Only covers the synchronously executed portion (see file header).
 */
export function withSeededRandom<T>(seed: number, fn: () => T, host: EntropyHost = globalThis as unknown as EntropyHost): T {
  if (host.__pcWithRandomSeed) return host.__pcWithRandomSeed(seed, fn);
  const real = host.Math.random;
  let state = seed | 0;
  host.Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    host.Math.random = real;
  }
}
