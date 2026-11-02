/**
 * 这台设备的图形能力够不够跑素材效果卡(`docs/plan/online-card-exec-contract.md` 4.3)。舞台第一次要挂素材效果卡时判一次,
 * 结果随运行状态报给编辑页面。满足任一条就算不够,这台舞台本次会话的素材效果卡全部退回原做法:
 *
 *   - 拿不到 WebGL2 上下文,或带 `failIfMajorPerformanceCaveat: true` 时拿不到;
 *   - `UNMASKED_RENDERER_WEBGL` 是软件渲染(`swiftshader`、`llvmpipe`、`software`、`basic render`);
 *   - `MAX_TEXTURE_SIZE` 小于项目画幅的长边;
 *   - 运行中丢过一次 WebGL 上下文。
 *
 * 判定是纯函数(`judgeGraphCapability`,单测逐条核);探测(`probeGraphFacts`)建一个 1×1 的离屏画布,探完立刻放掉上下文。
 */
import type { StageGraphCapability } from "../../render/stageRpc.ts";
import { tr } from "../../i18n/index.ts";

export interface GraphFacts {
  /** 带 `failIfMajorPerformanceCaveat: true` 拿到了 WebGL2 上下文 */
  webgl2: boolean;
  /** `UNMASKED_RENDERER_WEBGL`;读不到为空串 */
  renderer: string;
  maxTextureSize: number;
}

export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render/i;

export function judgeGraphCapability(facts: GraphFacts | null, opts: { longSide: number; contextLost?: boolean }): Exclude<StageGraphCapability, "unknown"> {
  if (opts.contextLost) return "context-lost";
  if (!facts || !facts.webgl2) return "no-webgl2";
  if (SOFTWARE_RENDERER.test(facts.renderer)) return "software";
  if (!(facts.maxTextureSize >= Math.max(1, opts.longSide))) return "texture";
  return "ok";
}

/** 给参数面板的细节(状态是 `gpu`) */
export function graphCapabilityDetail(cap: StageGraphCapability): string {
  switch (cap) {
    case "no-webgl2": return tr("WebGL2 is unavailable");
    case "software": return tr("Only software rendering is available");
    case "texture": return tr("Max texture size is smaller than the aspect ratio");
    case "context-lost": return tr("Graphics context was lost while running");
    default: return "";
  }
}

export function probeGraphFacts(): GraphFacts | null {
  try {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null;
    if (!gl) return { webgl2: false, renderer: "", maxTextureSize: 0 };
    let renderer = "";
    try {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch { renderer = ""; }
    const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { webgl2: true, renderer, maxTextureSize };
  } catch {
    return null;
  }
}
