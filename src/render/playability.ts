/**
 * "Can this device play this original-size asset": **local device cache** (T1a review #4; C6.6 design
 * doc Section 4 "Playability", Section 8 research conclusions).
 *
 * Whether it can play depends on the device (browser, system decoders, hardware). The same project
 * may play on this machine but fail on an iPad, so it is **not a project-level boolean**: not written
 * into project documents, not stored in `.proc`, and no fields added to `MediaAsset`. Results exist
 * only in this page origin on this device (memory + `localStorage`; falls back to memory only if
 * reading or writing fails).
 *
 * **Cache key = original-size asset hash + browser major version**: content is immutable, but
 * decoding capabilities change after browser upgrades (research conclusions item 3); when the major
 * version changes, treat it as unprobed and re-probe.
 *
 * Probing method:
 *   1. **Select MIME by actual container** and query `canPlayType`; if it returns `''`, judge as
 *      `false` (record it). QuickTime (`.mov`) is queried as `video/mp4`: Chrome's
 *      `canPlayType('video/quicktime')` always returns `''` (measured in Chrome 152), yet it plays
 *      H.264 MOVs just fine using the same ISO BMFF demuxer: querying by literal MIME would judge
 *      all phone-recorded MOVs as unplayable, permanently stuck on small-size assets. Unplayable
 *      MOVs (ProRes, DNxHD) are identified by test-playing in step 2.
 *   2. Otherwise **test-play the first frame**: attach the original-size asset to an off-screen
 *      `<video muted>`, wait for `loadeddata`, then wait for `requestVideoFrameCallback` to confirm
 *      a frame is actually submitted to the compositor before judging `true`; judge `false` on
 *      `error` (record it).
 *   3. On **timeout** (5 s for local asset service, 10 s for remote asset service), record "unknown":
 *      do not write to cache, re-probe after `RETRY_UNKNOWN_MS`. Slow network does not mean
 *      unplayable, so it cannot be permanently recorded as `false`. During the cooldown, the
 *      off-screen element continues waiting: if the first frame arrives late, record and notify based
 *      on the late conclusion; if there is still no conclusion when cooldown ends, unmount the element
 *      and notify subscribers to re-evaluate (re-probing does not hitch a ride on other re-renders;
 *      see comments in `probePlayable`).
 *   4. When probing itself cannot run (no DOM), reach no conclusion (`undefined`), and callers treat
 *      it as "unknown".
 *
 * `playbackUrl` (`mediaTier.ts`) only reads here; it decides whether to trigger a probe (probes only
 * when two tiers are genuinely available, avoiding unnecessary fetching of the original-size
 * asset's first frame). Notifies subscribers (`subscribePlayability`) when a conclusion is reached,
 * allowing the video layer to switch tiers on the fly even while paused.
 */

const STORAGE_PREFIX = "pc.playable.";
/** Original-size asset on local asset service: record "unknown" if the first frame does not appear within 5 s */
export const PROBE_TIMEOUT_LOCAL_MS = 5000;
/** Original-size asset on remote asset service (pulled on demand via local read route, or hitting remote directly): 10 s */
export const PROBE_TIMEOUT_REMOTE_MS = 10000;
/** How long after "unknown" before probing again */
export const RETRY_UNKNOWN_MS = 30000;

/** The stage takes over `setTimeout` (virtual clock, does not tick when paused); timeouts must use the real wall clock via the `__pcRealSetTimeout` hook (same as mediaDrive.ts) */
const realSetTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> =>
  ((typeof window !== "undefined" && window.__pcRealSetTimeout) ? window.__pcRealSetTimeout(fn, ms) : setTimeout(fn, ms)) as ReturnType<typeof setTimeout>;
/** Similarly, re-probe time for "unknown" uses the real wall clock (inside the stage, `Date.now` is pinned to the epoch; use the one retained by stageClock) */
const realNow = (): number => (typeof window !== "undefined" && window.__pcRealNow ? window.__pcRealNow() : Date.now());

let majorOverride: string | null = null;

/** Browser major version (half of the cache key). Returns "0" if unrecognized */
export function browserMajor(): string {
  if (majorOverride !== null) return majorOverride;
  try {
    const nav = typeof navigator === "undefined" ? null : navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } };
    const brands = nav?.userAgentData?.brands ?? [];
    const hit = brands.find((b) => /chrom/i.test(b.brand)) ?? brands.find((b) => !/not.?a.?brand/i.test(b.brand));
    if (hit?.version) return String(parseInt(hit.version, 10) || 0);
    const m = /(?:Chrome|Chromium|Firefox|Version)\/(\d+)/.exec(nav?.userAgent ?? "");
    return m ? m[1] : "0";
  } catch {
    return "0";
  }
}

/** For unit tests: pin browser major version (null = use real environment) */
export function setBrowserMajorForTest(v: string | null): void {
  majorOverride = v;
  known.clear();
}

const keyOf = (hash: string) => `${browserMajor()}:${hash.toLowerCase()}`;

const known = new Map<string, boolean>();
const probing = new Map<string, Promise<boolean | undefined>>();
/** Probed as "unknown": key → earliest re-probe time (real wall clock ms) */
const retryAt = new Map<string, number>();

let version = 0;
const listeners = new Set<() => void>();
function changed() {
  version++;
  for (const l of [...listeners]) {
    try { l(); } catch { /* Subscriber's own responsibility */ }
  }
}
/** Notify when there is a new conclusion (used by the video layer to switch tiers on the fly even while paused) */
export function subscribePlayability(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
/** Version number of conclusions, incremented on each new conclusion (`useSyncExternalStore` snapshot) */
export function playabilityVersion(): number {
  return version;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** Conclusion for this content on this device (this browser major version); `undefined` if unprobed or probed as "unknown" */
export function playableOnThisHost(hash: string | undefined | null): boolean | undefined {
  if (!hash) return undefined;
  const key = keyOf(hash);
  if (known.has(key)) return known.get(key);
  let stored: string | null = null;
  try { stored = storage()?.getItem(STORAGE_PREFIX + key) ?? null; } catch { /* Private mode, disabled */ }
  if (stored === "1" || stored === "0") {
    known.set(key, stored === "1");
    return stored === "1";
  }
  return undefined;
}

/** Record conclusion (probe result; unit tests also use it to preset) */
export function rememberPlayable(hash: string, playable: boolean): void {
  const key = keyOf(hash);
  known.set(key, playable);
  retryAt.delete(key);
  try { storage()?.setItem(STORAGE_PREFIX + key, playable ? "1" : "0"); } catch { /* Memory only */ }
  changed();
}

/** For unit tests: clear in-memory conclusions (does not touch anything outside localStorage) */
export function forgetPlayable(): void {
  known.clear();
  probing.clear();
  retryAt.clear();
}

/** Whether this hash should be probed right now: no conclusion, not probing, and not in "unknown" cooldown */
export function shouldProbe(hash: string): boolean {
  const key = keyOf(hash);
  if (playableOnThisHost(hash) !== undefined || probing.has(key)) return false;
  const at = retryAt.get(key);
  return at === undefined || realNow() >= at;
}

/**
 * MIME used to query `canPlayType` by **actual container** (`ext` is the container extension
 * recorded when stored into the library). Query `mov` as `video/mp4`, see step 1 in file header for
 * rationale. Returns null if unrecognized (skips that step and tests playback directly).
 */
const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
  avi: "video/x-msvideo", ogv: "video/ogg", mxf: "application/mxf",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/ogg",
};

export function mimeForExt(ext: string | undefined | null): string | null {
  return MIME_BY_EXT[String(ext || "").toLowerCase()] ?? null;
}

export interface ProbeOptions {
  /** Original-size asset on remote asset service (timeout 10 s); determined by address by default: absolute http(s) addresses count as remote, others count as local (5 s) */
  remote?: boolean;
  /** Specify timeout directly (unit tests) */
  timeoutMs?: number;
}

/**
 * Probe once (only probes the same hash once concurrently). `url` is the original-size asset
 * address, `ext` is used to construct MIME. Returns `true` / `false` (recorded into cache), or
 * `undefined` (no DOM, timeout: not recorded, re-probe later).
 */
export function probePlayable(hash: string, url: string, ext?: string, kind: "video" | "audio" = "video", opts: ProbeOptions = {}): Promise<boolean | undefined> {
  const key = keyOf(hash);
  const done = playableOnThisHost(hash);
  if (done !== undefined) return Promise.resolve(done);
  const running = probing.get(key);
  if (running) return running;
  const job = (async (): Promise<boolean | undefined> => {
    if (typeof document === "undefined" || !url) return undefined;
    const isVideo = kind !== "audio";
    const el = document.createElement(isVideo ? "video" : "audio") as HTMLVideoElement;
    const mime = mimeForExt(ext);
    if (mime && el.canPlayType(mime) === "") { rememberPlayable(hash, false); return false; }
    // "Remote": marked by caller (connected to remote asset service, pulled on demand via local read
    // route), or the address itself is an absolute http(s) address (Section 9 of design doc approved
    // c66-tests criteria)
    const remote = !!opts.remote || /^https?:\/\//i.test(url);
    const timeoutMs = opts.timeoutMs ?? (remote ? PROBE_TIMEOUT_REMOTE_MS : PROBE_TIMEOUT_LOCAL_MS);
    const verdict = await new Promise<boolean | undefined>((resolve) => {
      // `clearTimeout` in the stage is also virtual and cannot clear real timers, so rely on flags:
      // settled = already replied to caller, closed = off-screen element unmounted
      let settled = false;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        el.removeAttribute("src");
        try { el.load(); } catch { /* Already unmounted */ }
        el.remove();
      };
      const finish = (value: boolean) => {
        if (closed) return;
        close();
        if (!settled) { settled = true; resolve(value); return; }
        // Conclusion arrived after timeout (first frame arrived late on slow link): recorded as usual,
        // and notifies subscribers upon recording: video layer switches tiers on the fly even while paused
        rememberPlayable(hash, value);
      };
      /*
       * Timeout = did not receive in time on this attempt, record "unknown" (step 3 in file header).
       * The off-screen element is not unmounted, continuing to wait until the "unknown" cooldown ends:
       * if the first frame arrives during this period, it is a late conclusion (the second branch of
       * finish above). Unmounted only if there is still no conclusion when cooldown ends, and
       * **actively notifies** subscribers to re-evaluate once: otherwise re-probing can only hitch a ride
       * on other re-renders: while paused and the collection remains unchanged, there are no re-renders,
       * and the video remains permanently stuck on small size (cross-machine T9 `ht9a0927`,
       * `docs/archive/agent-reports/AGENT-tier-reload-seek.md`).
       */
      realSetTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(undefined);
        realSetTimeout(() => {
          if (closed) return;
          close();
          retryAt.delete(key);
          changed();
        }, RETRY_UNKNOWN_MS);
      }, timeoutMs);
      el.muted = true;
      el.preload = "auto";
      el.setAttribute("aria-hidden", "true");
      if (isVideo) {
        el.playsInline = true;
        // Frames are only submitted to the compositor once mounted into the document (frame callbacks
        // only arrive then); virtually invisible, does not block clicks
        el.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
        (document.body ?? document.documentElement).appendChild(el);
      }
      el.addEventListener("error", () => finish(false), { once: true });
      el.addEventListener("loadeddata", () => {
        if (!isVideo) return finish(true);
        if (!el.videoWidth) return finish(false);
        if (typeof el.requestVideoFrameCallback !== "function") return finish(true);
        el.requestVideoFrameCallback(() => finish(true));
        // A paused element might not submit its first frame again: nudge it gently to make it produce a frame
        try { el.currentTime = Math.min(0.001, el.duration || 0); } catch { /* If seek is not allowed, wait for timeout */ }
      }, { once: true });
      el.src = url;
    });
    if (verdict === undefined) {
      retryAt.set(key, realNow() + RETRY_UNKNOWN_MS);
      return undefined;
    }
    rememberPlayable(hash, verdict);
    return verdict;
  })().finally(() => probing.delete(key));
  probing.set(key, job);
  return job;
}
