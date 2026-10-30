/**
 * 片段里的「叠加带」:把挂在这一段上的东西(滤镜、像素映射、音频效果、素材效果卡)画出来。
 *
 * 在这之前,时间轴上一个字都看不出一个片段挂没挂东西,只能到左栏检查器里翻。
 *
 * # 这一格在每个片段上都留着
 *
 * 没挂东西时透明、不画底也不画分隔线。只给挂了东西的片段留的话,同一行里的名字会一高一低。
 *
 * # 点哪儿出什么
 *
 * 点一张卡片 → 这一张能做的事;点 `+N` → 这一段挂的全部。两处出的都是片段右键菜单里
 * 「叠加卡」那一支,只是入口不同(菜单本身在 `ClipView.tsx` 里拼)。
 * 带里的按钮都吃掉 pointerdown:不吃的话这一下会被片段的拖动接走,点不出菜单。
 */
import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import type { OverlayItem } from "./overlays";
import { BAND_H, OVERLAY_KIND_NAME, overlayGlyph, planBand } from "./overlays";
import type { RowSize } from "./utils";

export interface OverlayBandProps {
  items: OverlayItem[];
  rowSize: RowSize;
  /** 带里留给卡片的宽度(planClipLayout 给) */
  avail: number;
  /** 片段太窄:不摆卡片,带里只放一个 `+N` */
  countOnly: boolean;
  /** 只读项目不给「＋」 */
  frozen: boolean;
  /** 打开这一张能做的事 */
  onOpenOne: (index: number, at: { x: number; y: number }) => void;
  /** 打开这一段挂的全部 */
  onOpenAll: (at: { x: number; y: number }) => void;
}

const at = (e: MouseEvent) => ({ x: e.clientX, y: e.clientY });

/**
 * 带里的按钮左键右键是同一件事:点哪儿就从哪儿开始。
 * 右键必须自己接住 —— 不接的话事件冒到片段上,出的是片段的右键菜单,
 * 用户明明点的是某一张卡,却得从「叠加卡」那一项再走一遍。
 */
function press(run: (at: { x: number; y: number }) => void) {
  const fire = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    run(at(e));
  };
  return { onClick: fire, onContextMenu: fire };
}

/**
 * 带里的按钮自己把 pointerdown 吃掉。
 *
 * 片段的拖动(`useDrag`)挂的是**原生**监听、而且一按下就 `setPointerCapture`:
 * React 的 `onPointerDown` 在根上代理,轮到它时片段那一下早跑完了,指针也已经被片段捕获 ——
 * 这一次点击的 `click` 会派到片段身上,带里的按钮根本收不到。
 * 所以这里挂一个真的 DOM 监听:按钮是后代,冒泡先经过它,拦住就不会进片段。
 */
function useOwnPointerDown<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDown = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.("button")) e.stopPropagation();
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, []);
  return ref;
}

export function OverlayBand({ items, rowSize, avail, countOnly, frozen, onOpenOne, onOpenAll }: OverlayBandProps) {
  const bandRef = useOwnPointerDown<HTMLDivElement>();
  const h = BAND_H[rowSize];
  if (!h) return null;
  const empty = items.length === 0;
  const plan = empty || countOnly ? { shown: [], hidden: items.length } : planBand(items, avail);
  return (
    <div ref={bandRef} className={`pc-ov-band${empty ? " is-empty" : ""}`} style={{ height: h }} data-pc-overlays={items.length || undefined}>
      {plan.shown.map((it, i) => (
        <button
          key={it.kind + it.refId}
          type="button"
          className={`pc-ov-chip${it.off ? " is-off" : ""}`}
          title={it.off
            ? `${OVERLAY_KIND_NAME[it.kind]}：${it.name} —— 已停用，这一段上不生效`
            : `${OVERLAY_KIND_NAME[it.kind]}：${it.name}${it.value ? `（${it.value}）` : ""}`}
          data-pc-overlay={it.kind}
          {...press((p) => onOpenOne(i, p))}
        >
          <span className="g">{overlayGlyph(it)}</span>
          <span className="n">{it.name}</span>
        </button>
      ))}
      {plan.hidden > 0 && (
        <button
          type="button"
          className="pc-ov-more"
          title={`${items.length} 张叠加卡，点开挑`}
          data-pc-overlay-more={plan.hidden}
          {...press(onOpenAll)}
        >
          {`+${plan.hidden}`}
        </button>
      )}
      {!countOnly && !frozen && (
        <button
          type="button"
          className="pc-ov-add"
          title="这一段挂着什么"
          aria-label="叠加卡"
          {...press(onOpenAll)}
        >
          ⋯
        </button>
      )}
    </div>
  );
}

/**
 * 小行高那一档没有带:`+N` 排在名字后面靠右,再短就只剩它。
 * 和带里的 `+N` 同一个动作,样子也照着来。
 */
export function OverlayPill({ count, onOpenAll }: { count: number; onOpenAll: (at: { x: number; y: number }) => void }) {
  const ref = useOwnPointerDown<HTMLButtonElement>();
  return (
    <button
      ref={ref}
      type="button"
      className="pc-ov-pill"
      title={`${count} 张叠加卡，点开挑`}
      data-pc-overlay-more={count}
      {...press(onOpenAll)}
    >
      {`+${count}`}
    </button>
  );
}
