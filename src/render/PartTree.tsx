import { frameCss, frameBox, type Size } from "../kernel/layout";
import { getPart } from "../kernel/partRegistry";
import type { PartInstance } from "../kernel/types";

/**
 * 组合卡的渲染:把部件实例树逐级挂到画布上。
 *
 *   - 每个实例一层 <div data-pc-part>,位置用和卡片一样的 frameCss(相对父框,绕锚点缩放旋转);
 *   - enterMs 之前不挂载,到点才挂 —— 进场动画就从那一刻开始,和卡片按 clip.start 挂载是同一个道理;
 *   - 部件拿到的 t 已经扣掉自己的 enterMs,拿到的 width / height 是自己框的尺寸;
 *   - 子实例挂在父实例的框里,父框的尺寸就是子实例的父坐标系。
 * 没注册的部件 id 画一个看得见的占位,不让整张卡空掉。
 */
export function PartTree({ parts, size, t, playToken }: { parts: PartInstance[]; size: Size; t: number; playToken: number }) {
  return (
    <>
      {parts.map((inst) => {
        const enter = (inst.enterMs ?? 0) / 1000;
        // 和 Stage 的 LEAD 一样提前一点点挂,让进场第一帧正卡在 enterMs 上
        if (t < enter - 0.05) return null;
        const def = getPart(inst.partId);
        const box = frameBox(inst.frame, size);
        const inner: Size = { width: box.width, height: box.height };
        return (
          <div key={`${inst.id}:${playToken}`} data-pc-part={inst.id} data-pc-part-def={inst.partId} style={frameCss(inst.frame, size)}>
            {def ? (
              <def.Component params={{ ...def.defaults, ...inst.params }} t={Math.max(0, t - enter)} playToken={playToken} width={inner.width} height={inner.height} />
            ) : (
              <div style={{ position: "absolute", inset: 0, border: "2px dashed #f87171", color: "#f87171", font: "20px system-ui", padding: 12 }}>
                没有部件 {inst.partId}
              </div>
            )}
            {inst.children?.length ? <PartTree parts={inst.children} size={inner} t={Math.max(0, t - enter)} playToken={playToken} /> : null}
          </div>
        );
      })}
    </>
  );
}
