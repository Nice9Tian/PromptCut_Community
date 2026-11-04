/**
 * Media gate (semantics: `product/platforms.md` "Online browser" - "Media gate"; implementation:
 * `mechanism/platforms.md` "Three gates" - "Media gate").
 *
 * Two sub-gates:
 *
 * - **Decoding** (this file, editor page side): tests once on open what asset size this device can
 *   decode, unchanged during this session; subsequent imported assets compare against this limit
 *   without retesting (user confirmation, 2026-10-08). Limit is tiered by resolution (`DECODE_LADDER`):
 *   queries browser from high to low (`navigator.mediaCapabilities.decodingInfo`, requiring `supported`
 *   and `smooth`; if unavailable, queries `VideoDecoder.isConfigSupported`; defaults to 1080p if
 *   neither is available), and the first decodable tier becomes this device's limit.
 *   If loading original size previously crashed the page (crashed at "load original-size asset" in
 *   crash records), each crash lowers the limit by one tier (recorded in device record by `stageGate.ts`).
 *   Video assets whose width × height exceeds the limit use small size only (`render/mediaTier.ts`
 *   `smallOnlyFor`, determined per asset, not a blanket rule for the entire device); those within limit
 *   proceed as normal.
 *   **Concurrent channels not tested separately** [ruling]: concurrent on-screen decoding channels are
 *   governed by existing warming slots (`VideoTrack.tsx` `MAX_WARMING`) and track stream decoder
 *   budget; upper limit is only tiered by single-channel resolution.
 * - **Network speed** (stage side, `render/netSpeed.ts`): inspects actual media download speed, adjusts
 *   dynamically, and only decides whether to fetch small size first.
 *
 * Logs crash record before loading original size: records "load original-size asset" before passing
 * "allow original size" tier selection policy to stage or when project assets change (newly imported),
 * returning to previous step after `MEDIA_MARK_MS` (crashes during this window are attributed to the asset).
 *
 * Does not import `mode.ts`; browser capabilities are injected, directly usable by Node unit tests.
 */

/** Decoding limit tiers (high to low). `pixels` is width × height; asset is decodable if width × height <= limit */
export const DECODE_LADDER: readonly { name: string; width: number; height: number; pixels: number }[] = Object.freeze([
  { name: "2160p", width: 3840, height: 2160, pixels: 3840 * 2160 },
  { name: "1440p", width: 2560, height: 1440, pixels: 2560 * 1440 },
  { name: "1080p", width: 1920, height: 1080, pixels: 1920 * 1080 },
  { name: "720p", width: 1280, height: 720, pixels: 1280 * 720 },
  { name: "480p", width: 854, height: 480, pixels: 854 * 480 },
]);
/** Used when query yields no result (1080p) */
export const DECODE_FALLBACK_INDEX = 2;
/** Codec used to query browser (H.264 High, level 5.1: sufficient for 4K30) */
export const DECODE_PROBE_CODEC = "avc1.640033";
/** Bitrate (bps) reported when querying browser for each tier: common bitrate of phone-shot H.264 at same resolution */
export const DECODE_PROBE_BITRATE: Readonly<Record<string, number>> = Object.freeze({ "2160p": 45e6, "1440p": 24e6, "1080p": 16e6, "720p": 8e6, "480p": 3e6 });
/** Duration to log "load original-size asset" step (crashes during this window attributed to asset) [ruling] */
export const MEDIA_MARK_MS = 15_000;
/** Maximum wait time when measuring decoding limit; uses `DECODE_FALLBACK_INDEX` if query yields no result */
export const DECODE_PROBE_TIMEOUT_MS = 3_000;

export type DecodeAsk = (level: (typeof DECODE_LADDER)[number]) => Promise<boolean | null>;

interface CapsLike {
  mediaCapabilities?: { decodingInfo?: (cfg: unknown) => Promise<{ supported?: boolean; smooth?: boolean }> };
  VideoDecoder?: { isConfigSupported?: (cfg: unknown) => Promise<{ supported?: boolean }> };
}

/** Default query: mediaCapabilities first (requires supported and smooth), then VideoDecoder; returns null (unknown) if neither works */
export function browserDecodeAsk(env?: CapsLike): DecodeAsk {
  const g = globalThis as unknown as { navigator?: { mediaCapabilities?: CapsLike["mediaCapabilities"] }; VideoDecoder?: CapsLike["VideoDecoder"] };
  env ??= { mediaCapabilities: g.navigator?.mediaCapabilities, VideoDecoder: g.VideoDecoder };
  return async (level) => {
    const mc = env!.mediaCapabilities;
    if (mc && typeof mc.decodingInfo === "function") {
      try {
        const r = await mc.decodingInfo({
          type: "file",
          video: { contentType: `video/mp4; codecs="${DECODE_PROBE_CODEC}"`, width: level.width, height: level.height, bitrate: DECODE_PROBE_BITRATE[level.name] ?? 8e6, framerate: 30 },
        });
        return r?.supported === true && r.smooth === true;
      } catch { /* Cannot query: try next one */ }
    }
    const vd = env!.VideoDecoder;
    if (vd && typeof vd.isConfigSupported === "function") {
      try {
        const r = await vd.isConfigSupported({ codec: DECODE_PROBE_CODEC, codedWidth: level.width, codedHeight: level.height });
        return r?.supported === true;
      } catch { return false; }
    }
    return null;
  };
}

export interface DecodeLimit {
  /** Measured tier (index in `DECODE_LADDER`; `DECODE_FALLBACK_INDEX` if query yields no result) */
  measured: number;
  /** How many times loading original size crashed, and how many tiers it was downgraded */
  lowered: number;
  /** Effective tier */
  index: number;
  name: string;
  /** Width × height upper limit */
  maxPixels: number;
  /** How it was measured */
  by: "browser" | "fallback";
  /** Measurement duration (milliseconds, logging only) */
  ms: number;
}

/** Measure decoding limit: query high to low, first decodable tier wins; defaults to 1080p if all null. `lowered` drops tiers (down to the last tier) */
export async function measureDecodeLimit(ask: DecodeAsk, lowered = 0, now: () => number = () => Date.now()): Promise<DecodeLimit> {
  const t0 = now();
  let measured = -1;
  let known = false;
  for (let i = 0; i < DECODE_LADDER.length; i++) {
    let ok: boolean | null = null;
    try { ok = await ask(DECODE_LADDER[i]); } catch { ok = null; }
    if (ok !== null) known = true;
    if (ok === true) { measured = i; break; }
  }
  if (measured < 0) measured = known ? DECODE_LADDER.length - 1 : DECODE_FALLBACK_INDEX;
  const index = Math.min(DECODE_LADDER.length - 1, measured + Math.max(0, Math.floor(lowered)));
  return { measured, lowered: Math.max(0, Math.floor(lowered)), index, name: DECODE_LADDER[index].name, maxPixels: DECODE_LADDER[index].pixels, by: known ? "browser" : "fallback", ms: now() - t0 };
}

/* ------------------------------------------------------------------ The single instance for this page */

let limit: DecodeLimit | null = null;
let measuring: Promise<DecodeLimit> | null = null;
const listeners = new Set<() => void>();

/** Decoding limit used for this page session (measured once on open; null while measurement is pending) */
export function decodeLimit(): DecodeLimit | null {
  return limit;
}

/** Measured once on open; subsequent calls return the same result (unchanged during this session) */
export function ensureDecodeLimit(opts: { ask?: DecodeAsk; lowered?: number; timeoutMs?: number } = {}): Promise<DecodeLimit> {
  measuring ??= (async () => {
    const ask = opts.ask ?? browserDecodeAsk();
    const timed: DecodeAsk = (lv) => Promise.race([ask(lv), new Promise<null>((r) => setTimeout(() => r(null), opts.timeoutMs ?? DECODE_PROBE_TIMEOUT_MS))]);
    const r = await measureDecodeLimit(timed, opts.lowered ?? 0);
    limit = r;
    for (const l of [...listeners]) { try { l(); } catch { /* The subscriber is broken */ } }
    return r;
  })();
  return measuring;
}

export function subscribeDecodeLimit(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Signatures of project video assets needing original size (hash set; change means new assets to load in original size, logging another crash record) */
export function originalLoadSignature(media: readonly { kind?: string; hash?: string; width?: number; height?: number }[], maxPixels: number | null): string {
  const keys: string[] = [];
  for (const m of media) {
    if (m.kind !== "video" || !m.hash) continue;
    const px = Number(m.width) * Number(m.height);
    if (maxPixels !== null && px > maxPixels) continue;
    keys.push(m.hash);
  }
  return keys.sort().join(",");
}

/** For tests */
export function resetMediaGateForTest(): void {
  limit = null;
  measuring = null;
  listeners.clear();
}
