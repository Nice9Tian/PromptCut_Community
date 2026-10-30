import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import { findClip } from "../../kernel/project";
import { addPart } from "../../kernel/parts";
import { getPart } from "../../kernel/partRegistry";
import type { PartDef } from "../../kernel/partTypes";
import type { PartInstance } from "../../kernel/types";
import { COMPOSITE_CARD_ID } from "../../cards/native/composite";
import { isComposite } from "../../kernel/envelope";
import { AnimClock } from "../../kernel/AnimClock";
import { PartTree } from "../../render/PartTree";
import { themeStyle } from "../../themes";
import { PreviewCard } from "./PreviewCard";
import { usePreviewZoom, zoomFor } from "./previewZoom";

/**
 * 左栏「部件库」里的一格:和卡片格(CardCell)同一个壳(PreviewCard)、同一套悬停预览。
 *
 * 预览的做法:把这个部件按它的 defaultFrame 放进一张 1920×1080 的组合卡画布,用舞台上
 * 真正渲染组合卡的 PartTree 跑一遍 —— 预览里看到的就是加到时间轴上会看到的。悬停期间
 * t 按时钟往前走,跟着 t 走的部件(Lottie、打字机、章节条)也动得起来。
 * 缩放按动效跑完整段时的最大包围盒,量一次缓存(previewZoom.ts)。
 *
 * 点一下:当前选中的是组合卡就把部件加进去;否则在播放头新建一张组合卡,里面就这一个部件。
 * 部件不能单独上时间轴,它一定住在组合卡里。
 */
export function PartCell({ def, fill, aspect }: { def: PartDef<any>; fill?: boolean; aspect?: number }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [t, setT] = useState(0);
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const project = useStore((s) => s.project);

  const flash = (text: string) => { setMsg(text); setTimeout(() => setMsg(null), 1800); };

  // 预览用的实例:默认参数 + 默认框,和 add_part 不传参数时加出来的一模一样
  const preview = useMemo<PartInstance[]>(
    () => [{ id: "preview", partId: def.id, params: { ...def.defaults }, ...(def.defaultFrame ? { frame: { ...def.defaultFrame } } : {}) }],
    [def],
  );

  const animMs = animMsOf(def);
  const zoom = usePreviewZoom(`part:${def.id}`, stageRef, hot, animMs);

  useLayoutEffect(() => {
    if (hot && viewRef.current) {
      const rect = viewRef.current.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    }
  }, [hot]);

  // 悬停期间 t 跟着时钟走:PartTree 靠 t 决定挂载和跟时间轴走的部件的进度(测量跑期间按 t = 0 量)
  useEffect(() => {
    if (!hot || zoom.measuring) { setT(0); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => { setT((performance.now() - t0) / 1000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hot, zoom.token, zoom.measuring]);

  const onClick = () => {
    try {
      const st = getState();
      const sel = st.selection[0] ? findClip(st.project, st.selection[0]) : null;
      if (sel && isComposite(sel.clip)) {
        const { tree } = addPart(sel.clip.parts ?? [], { partId: def.id }, getPart);
        actions.setClipParts(sel.clip.id, tree);
        flash("已加进选中的组合卡");
        return;
      }
      const tt = Math.round(st.t * 10) / 10;
      const { tree } = addPart([], { partId: def.id }, getPart);
      const clip = actions.addCardClip(COMPOSITE_CARD_ID, tt, { parts: tree });
      if (!clip) { flash("没有动效轨,先在时间轴新建一条"); return; }
      actions.select([clip.id]);
      flash("新建了一张组合卡");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  const { scale, left, top } = zoomFor(zoom.box, box, project);

  const view = (
    <div ref={viewRef} className="absolute inset-0">
      {!hot && (
        <div className="pc-lib-card-text">
          <div className="pc-lib-card-name">{def.name}</div>
          <div className="pc-lib-card-desc">{def.description}</div>
        </div>
      )}
      {hot && box.w > 0 && box.h > 0 && (
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
              // 测量跑藏起来要用 opacity 而不是 visibility:visibility 会继承到每个子元素,量包围盒的人看谁都是 hidden,什么都量不到
              opacity: zoom.measuring ? 0 : 1,
            }}
          >
            <div ref={stageRef} className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }} key={zoom.token}>
              <AnimClock speed={1}>
                <PartTree parts={preview} size={{ width: project.width, height: project.height }} t={t} playToken={zoom.token} />
              </AnimClock>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <PreviewCard
      attrs={{ "data-pc-part-cell": def.id }}
      title={def.name}
      subtitle={def.role}
      caption="hover"
      preview={view}
      hoverDelayMs={180}
      onHover={setHot}
      edits
      onClick={onClick}
      error={msg}
      titleAttr={`${def.description}\n点击 = 加进选中的组合卡;没选中组合卡就在播放头新建一张`}
      fill={fill}
      aspect={aspect}
    />
  );
}

/** 部件的动画时长(毫秒):settleMs 按默认参数算,没有就 1500 */
function animMsOf(def: PartDef<any>): number {
  try {
    const v = def.settleMs?.(def.defaults);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  } catch { /* 算炸了按默认 */ }
  return 1500;
}
