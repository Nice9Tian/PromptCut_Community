/**
 * 素材闸门(语义 `product/platforms.md`「在线浏览器」的「素材闸门」;做法 `mechanism/platforms.md`「三道闸门」的「素材闸门」)。
 *
 * 两个子闸门:
 *
 * - **解码**(本文件,编辑器页一侧):打开时测一次这台设备解得动多大的素材,这次使用期间不变;之后导入的素材拿它和这个上限比,不重新测
 *   (2026-10-08 用户确认)。上限按分辨率分级(`DECODE_LADDER`):从高往低问浏览器(`navigator.mediaCapabilities.decodingInfo`,
 *   要 `supported` 且 `smooth`;没有它就问 `VideoDecoder.isConfigSupported`;两样都没有按 1080p),第一个解得动的就是这台设备的上限。
 *   载入原尺寸把页面撑崩过的(崩溃记录里崩在「载入素材原尺寸」),每崩一次上限往下调一级(`stageGate.ts` 记在设备记录里)。
 *   宽 × 高超过上限的视频素材只用小尺寸(`render/mediaTier.ts` 的 `smallOnlyFor`,按素材判,不是整台设备一刀切);没超过的照常。
 *   **同时几路不另测**〔裁〕:同屏解码路数由已有的预热名额(`VideoTrack.tsx` 的 `MAX_WARMING`)与轨道流解码器预算管,上限只按单路分辨率分级。
 * - **网速**(舞台一侧,`render/netSpeed.ts`):看素材实际下载的快慢,随时调整,只决定要不要先拉小尺寸。
 *
 * 载入原尺寸之前留崩溃记录:把「允许原尺寸」的取档策略交给舞台之前、项目里的素材换了一批(新导入)时,记「载入素材原尺寸」,
 * `MEDIA_MARK_MS` 之后回到原来那一步(这段时间里崩了算在素材头上)。
 *
 * 不引 `mode.ts`;浏览器能力经注入,Node 单测直接用。
 */

/** 解码上限的几级(从高到低)。`pixels` 是宽 × 高;素材的宽 × 高不超过它就算解得动 */
export const DECODE_LADDER: readonly { name: string; width: number; height: number; pixels: number }[] = Object.freeze([
  { name: "2160p", width: 3840, height: 2160, pixels: 3840 * 2160 },
  { name: "1440p", width: 2560, height: 1440, pixels: 2560 * 1440 },
  { name: "1080p", width: 1920, height: 1080, pixels: 1920 * 1080 },
  { name: "720p", width: 1280, height: 720, pixels: 1280 * 720 },
  { name: "480p", width: 854, height: 480, pixels: 854 * 480 },
]);
/** 问不出来时按这一级(1080p) */
export const DECODE_FALLBACK_INDEX = 2;
/** 问浏览器用的编码(H.264 High,level 5.1:够 4K30) */
export const DECODE_PROBE_CODEC = "avc1.640033";
/** 每一级问浏览器时报的码率(比特每秒):手机拍的同分辨率 H.264 的常见码率 */
export const DECODE_PROBE_BITRATE: Readonly<Record<string, number>> = Object.freeze({ "2160p": 45e6, "1440p": 24e6, "1080p": 16e6, "720p": 8e6, "480p": 3e6 });
/** 「载入素材原尺寸」这一步记多久(这段时间里崩了算在素材头上)〔裁〕 */
export const MEDIA_MARK_MS = 15_000;
/** 测解码上限最多等多久;问不出来按 `DECODE_FALLBACK_INDEX` */
export const DECODE_PROBE_TIMEOUT_MS = 3_000;

export type DecodeAsk = (level: (typeof DECODE_LADDER)[number]) => Promise<boolean | null>;

interface CapsLike {
  mediaCapabilities?: { decodingInfo?: (cfg: unknown) => Promise<{ supported?: boolean; smooth?: boolean }> };
  VideoDecoder?: { isConfigSupported?: (cfg: unknown) => Promise<{ supported?: boolean }> };
}

/** 缺省的问法:先 mediaCapabilities(要 supported 且 smooth),再 VideoDecoder,都没有回 null(不知道) */
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
      } catch { /* 问不了:试下一种 */ }
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
  /** 测出来的那一级(在 `DECODE_LADDER` 里的下标;问不出来是 `DECODE_FALLBACK_INDEX`) */
  measured: number;
  /** 载入原尺寸撑崩过几次,往下调了几级 */
  lowered: number;
  /** 生效的那一级 */
  index: number;
  name: string;
  /** 宽 × 高的上限 */
  maxPixels: number;
  /** 怎么测出来的 */
  by: "browser" | "fallback";
  /** 测了多久(毫秒,只记录) */
  ms: number;
}

/** 测解码上限:从高往低问,第一个解得动的就是;都问不出(null)按 1080p。`lowered` 往下调几级(最低到最后一级) */
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

/* ------------------------------------------------------------------ 本页的那一份 */

let limit: DecodeLimit | null = null;
let measuring: Promise<DecodeLimit> | null = null;
const listeners = new Set<() => void>();

/** 本页这次使用的解码上限(打开时测一次;还没测完为 null) */
export function decodeLimit(): DecodeLimit | null {
  return limit;
}

/** 打开时测一次;之后再调回同一个结果(这次使用期间不变) */
export function ensureDecodeLimit(opts: { ask?: DecodeAsk; lowered?: number; timeoutMs?: number } = {}): Promise<DecodeLimit> {
  measuring ??= (async () => {
    const ask = opts.ask ?? browserDecodeAsk();
    const timed: DecodeAsk = (lv) => Promise.race([ask(lv), new Promise<null>((r) => setTimeout(() => r(null), opts.timeoutMs ?? DECODE_PROBE_TIMEOUT_MS))]);
    const r = await measureDecodeLimit(timed, opts.lowered ?? 0);
    limit = r;
    for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
    return r;
  })();
  return measuring;
}

export function subscribeDecodeLimit(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 项目里要载入原尺寸的视频素材的签名(哈希集合;变了说明有新素材要载入原尺寸,再留一次崩溃记录) */
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

/** 测试用 */
export function resetMediaGateForTest(): void {
  limit = null;
  measuring = null;
  listeners.clear();
}
