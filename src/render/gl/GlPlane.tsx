import { useLayoutEffect, useRef } from "react";
import type { CanvasContract } from "./CanvasCardProgram";
import { glPlanes } from "./planes";

/**
 * canvas 卡的 gl 平面(R9 M1):E7 的第五种兄弟平面 `[data-pc-gl-plane]`。
 *
 * - 尺寸 = 片段实体框,上下文是 `bitmaprenderer`(由 `glHost` 在收到 `done` 时取);
 * - **不加 `data-pc-clip`**:`solid.ts` 的 `isSolid` 把带它的元素当包裹层跳过,加了整类 canvas 卡点不中;
 * - 它是活渲的一部分,**不进**四条平面选择器的放过名单:藏子树时它和子树一起被藏。
 *
 * 画面不在这里画:每次提交只把「这一拍要画什么」登记进 `glPlanes`,由宿主经 `glHost.beat()` 发给 Worker。
 */
export function GlPlane(props: {
  clipId: string;
  cardId: string;
  contract: CanvasContract;
  w: number;
  h: number;
  t: number;
  frame: number;
  params: Record<string, unknown>;
  gen: number;
  skip: boolean;
  stage: { width: number; height: number; camera3dFov?: number };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(1, Math.round(props.w));
  const h = Math.max(1, Math.round(props.h));
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { contract, params } = props;
    const textures: Array<{ name: string; url: string }> = [];
    for (const spec of contract.textures ?? []) {
      const raw = spec.param ? params[spec.param] : spec.url;
      if (typeof raw !== "string" || !raw.trim()) continue;
      // Worker 的基址是它自己的脚本地址:这里先解析成绝对地址
      textures.push({ name: spec.name, url: new URL(raw.trim(), document.baseURI).href });
    }
    glPlanes.set(props.clipId, {
      clipId: props.clipId,
      canvas,
      kind: contract.kind as "gl" | "three" | "2d",
      programId: contract.programId ?? props.cardId,
      w, h,
      t: props.t,
      frame: props.frame,
      params,
      paramsKey: JSON.stringify(params),
      gen: props.gen,
      skip: props.skip,
      textures,
      stage: props.stage,
    });
    return () => {
      if (glPlanes.get(props.clipId)?.canvas === canvas) glPlanes.delete(props.clipId);
    };
  });
  return (
    <canvas
      ref={ref}
      data-pc-gl-plane={props.clipId}
      width={w}
      height={h}
      style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
    />
  );
}
