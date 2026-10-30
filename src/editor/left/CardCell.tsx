import { useState, useRef, useLayoutEffect } from "react";
import { useStore, actions, getState } from "../../store/project";
import { AnimClock } from "../../kernel/AnimClock";
import { themeStyle } from "../../themes";
import type { CardDef } from "../../kernel/types";
import { DEFAULT_CARD_DUR } from "../../kernel/project";
import { clearDragPayload, MIME_CARD, setDragPayload } from "../dnd";
import { PreviewCard } from "./PreviewCard";
import { usePreviewZoom, zoomFor } from "./previewZoom";

/**
 * 卡片库里的一格:方形预览卡(PreviewCard)。不悬停显示名字和说明,悬停 180ms 后
 * 在卡里跑一遍动画;点一下加到播放头,拖动拖到时间轴。
 *
 * 预览的缩放不按整个画幅,按**动效跑完整段时内容最大的包围盒**(previewZoom.ts):
 * 第一次悬停先藏着舞台倍速跑一遍量出盒子并缓存,再一步到位推近、从头正常播;
 * 之后每次悬停直接用缓存,不再量、不再晃。1920×1080 的画幅里一个 400px 的标题,
 * 按整幅缩进 130px 的卡只剩一粒,按盒子缩就能看清。
 */
export function CardCell({ def, fill, aspect }: { def: CardDef<any>; fill?: boolean; aspect?: number }) {
  const [hot, setHot] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [error, setError] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const project = useStore((s) => s.project);

  // 动画多长:卡片声明的落定时刻(按默认参数算),没有就按 1.5s
  const animMs = animMsOf(def);
  /*
   * 素材效果卡(`card` / `audio`)没有 React 组件,库里跑不起来:悬停不换成动画预览,
   * 一直显示名字 + 说明那张静态占位。量包围盒也一并跳过(没有 DOM 可量)。
   */
  const live = hot && typeof def.Component === "function";
  // `live` 为真时它必然是函数;JSX 里写不了非空断言,所以在这里取一次
  const Live = def.Component!;
  const zoom = usePreviewZoom(`card:${def.id}`, stageRef, live, animMs);

  useLayoutEffect(() => {
    if (hot && viewRef.current) {
      const rect = viewRef.current.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    }
  }, [hot]);

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_CARD, def.id);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "card", cardId: def.id, name: def.name, duration: DEFAULT_CARD_DUR });
    (e.target as HTMLElement).classList.add("opacity-50");
  };

  const onDragEnd = (e: React.DragEvent) => {
    (e.target as HTMLElement).classList.remove("opacity-50");
    clearDragPayload();
  };

  const onClick = () => {
    const t = Math.round(getState().t * 10) / 10;
    const clip = actions.addCardClip(def.id, t, {});
    if (!clip) {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  const { scale, left, top } = zoomFor(zoom.box, box, project);

  const preview = (
    <div ref={viewRef} className="absolute inset-0">
      {!live && (
        <div className="pc-lib-card-text">
          <div className="pc-lib-card-name">{def.name}</div>
          <div className="pc-lib-card-desc">{def.description}</div>
        </div>
      )}
      {live && box.w > 0 && box.h > 0 && (
        <div data-pc="preview" className="absolute inset-0 overflow-hidden bg-black/60 pointer-events-none" style={{ ...themeStyle(project.themeId) }}>
          <div
            style={{
              position: "absolute",
              left,
              top,
              width: project.width,
              height: project.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              // 测量跑的时候不给人看:那一遍是倍速的,量完再从头正常播。
              // 藏起来要用 opacity 而不是 visibility:visibility 会继承到每个子元素,量包围盒的人看谁都是 hidden,什么都量不到
              opacity: zoom.measuring ? 0 : 1,
            }}
          >
            <div ref={stageRef} className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }} key={zoom.token}>
              <AnimClock speed={1}>
                <Live params={def.defaults} playToken={zoom.token} />
              </AnimClock>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <PreviewCard
      attrs={{ "data-pc-card": def.id }}
      title={def.name}
      // 不悬停时名字已经在画面区里,标题条只在动画跑起来之后压在底边
      caption="hover"
      preview={preview}
      hoverDelayMs={180}
      onHover={setHot}
      draggable
      edits
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      error={error ? "没有动效轨,先在时间轴新建一条" : null}
      titleAttr="点击 = 加到播放头;拖动 = 拖到时间轴的位置"
      fill={fill}
      aspect={aspect}
    />
  );
}

/** 卡片的动画时长(毫秒):timing 按默认参数算 > lifecycle 静态值 > 1500 */
function animMsOf(def: CardDef<any>): number {
  try {
    const dyn = def.timing?.(def.defaults)?.settleMs;
    if (typeof dyn === "number" && Number.isFinite(dyn)) return dyn;
  } catch { /* 算炸了按静态值 */ }
  const st = def.lifecycle?.settleMs;
  return typeof st === "number" && Number.isFinite(st) ? st : 1500;
}
