/**
 * 素材闸门的网速子闸门(语义 `product/platforms.md`「在线浏览器」的「素材闸门」:网速不单独测,看素材实际下载的快慢,使用中随时调整;
 * 它只决定要不要先拉小尺寸)。在线页面的舞台里跑(素材是舞台自己读的),结果写进舞台的取档策略 `smallFirst`(`mediaTier.ts`)。
 *
 * 量法:看浏览器的资源计时(`PerformanceObserver` 的 `resource`;Chrome 对 `<video>` 的分段请求也记,`initiatorType: "video"`,实测见报告),
 * 只看素材服务的请求(地址里有 `/media`),一段至少 `MIN_SAMPLE_BYTES` 字节、下载时长(`responseEnd − responseStart`)至少 `MIN_SAMPLE_MS`
 * 才算一个样本(太短的是缓存命中或只有响应头,算不准);速度 = 字节 × 8 / 下载时长,按指数滑动平均(`EWMA_ALPHA`)。
 *
 * 界线〔裁〕(数字的依据见报告「数字与依据」):滑动平均低于 `SLOW_BELOW_MBPS` 改成先拉小尺寸、再拉原尺寸替换;高于 `FAST_ABOVE_MBPS`
 * 只拉原尺寸;中间那一段维持原状(防来回抖)。还没有样本时先小后大(和 C6.6 原来一样)。
 *
 * 浏览器不报资源计时(老 Safari)就一直没有样本:照先小后大,和以前一样。
 */

export const SLOW_BELOW_MBPS = 8;
export const FAST_ABOVE_MBPS = 12;
export const EWMA_ALPHA = 0.3;
export const MIN_SAMPLE_BYTES = 256 * 1024;
export const MIN_SAMPLE_MS = 50;

export interface NetSpeedState {
  /** 滑动平均(兆比特每秒);没有样本为 null */
  mbps: number | null;
  samples: number;
  /** 先拉小尺寸(慢、还没样本)/ 只拉原尺寸(快) */
  smallFirst: boolean;
}

export interface ResourceSample { name: string; initiatorType?: string; encodedBodySize?: number; transferSize?: number; responseStart?: number; responseEnd?: number }

/** 一个资源计时条目能不能当样本、算出来多快(兆比特每秒);不能回 null */
export function sampleMbps(e: ResourceSample): number | null {
  if (!/\/media/.test(String(e.name || ""))) return null;
  const bytes = Number(e.encodedBodySize) || Number(e.transferSize) || 0;
  const ms = Number(e.responseEnd) - Number(e.responseStart);
  if (!(bytes >= MIN_SAMPLE_BYTES) || !(ms >= MIN_SAMPLE_MS)) return null;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

/** 加一个样本:回新的状态(纯函数) */
export function addSample(s: NetSpeedState, mbps: number): NetSpeedState {
  const avg = s.mbps === null ? mbps : s.mbps + EWMA_ALPHA * (mbps - s.mbps);
  let smallFirst = s.smallFirst;
  if (avg < SLOW_BELOW_MBPS) smallFirst = true;
  else if (avg > FAST_ABOVE_MBPS) smallFirst = false;
  return { mbps: avg, samples: s.samples + 1, smallFirst };
}

let state: NetSpeedState = { mbps: null, samples: 0, smallFirst: true };
let observer: { disconnect(): void } | null = null;

export function netSpeedState(): NetSpeedState {
  return state;
}

/** 开始看(在线页面的舞台调一次);`onChange` 在先小后大与只拉原尺寸之间切换时叫。回停止的函数 */
export function startNetSpeed(onChange: (s: NetSpeedState) => void): () => void {
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof PO !== "function" || observer) return () => {};
  try {
    const po = new PO((list) => {
      for (const e of list.getEntries() as unknown as ResourceSample[]) {
        const m = sampleMbps(e);
        if (m === null) continue;
        const prev = state;
        state = addSample(state, m);
        if (prev.smallFirst !== state.smallFirst) { try { onChange(state); } catch { /* 调用方坏了 */ } }
      }
    });
    po.observe({ type: "resource", buffered: true });
    observer = po;
  } catch {
    observer = null;
  }
  return () => { observer?.disconnect(); observer = null; };
}

/** 测试用 */
export function resetNetSpeedForTest(next: Partial<NetSpeedState> = {}): void {
  state = { mbps: null, samples: 0, smallFirst: true, ...next };
  observer?.disconnect();
  observer = null;
}
