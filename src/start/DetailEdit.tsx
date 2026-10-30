/**
 * 「详细编辑」:拓展栏「画面」那一段的段头按钮点开它,展开占满整个聊天区(用户 2026-10-23 定)。
 *
 * **连输入框一起占掉**(用户 2026-10-26 改定,issue #4):输入框原来留在时间轴正下方,用户说那个位置
 * 「感觉怪怪的」,改成搬去右侧拓展栏里新建的那块聊天面板(`ExtChatPanel.tsx`)。它的用处没变 ——
 * 在这儿右键一张卡引用进输入框,接着跟 Agent 说「这一张怎么怎么改」;`onQuote` 填的就是此刻
 * 那个输入框,人把拓展栏收了它又回到聊天列底部,两种情况这里都不用管。
 *
 * 形状:上面是舞台和一排传输控件,下面是时间轴。**两者之间那条缝能拖**(用户 2026-10-26 提,issue #40):
 * 原来时间轴那一框高度写死在 CSS 里,看一段长片时想把时间轴拉高、或者想把画面放大都做不到。
 * 现在它和传统式编辑台时间轴上面那一根是同一个拖杆(`src/editor/ResizeHandle.tsx`),拖出来的高度记在本机。
 *
 * 舞台是这个项目的真画面(`VibeStage.tsx`);时间轴**就是编辑界面那条真时间轴**(`src/editor/timeline/`),
 * 不是另画一条只能看的 —— 拖动、裁剪、跨序列、吸附、分割、删除、剪辑标签都在。
 * 这对应 `user-workflow.md`「工作方式」那一行:氛围式里「主要是 Agent 动手；用户也能自己调——
 * 从右侧拓展栏的「画面」进详细编辑，那里的时间轴可调」。要整套编辑界面(素材库、特效、AI 栏)才「进入传统式」。
 *
 * 2026-10-23 先做的那一版是自己画的只读轨道(拖不动、改不了),和上面那句语义对不上,同日换成了真时间轴。
 * 真时间轴的右键菜单在这一页多一项「引用到输入框」(`TimelineView` 的 `quoteClip`,只这一页传),
 * 写法和编辑器「引用到 AI」同一个(`@卡片 名字(片段 id)`,`src/mobile/agentView.ts` 的 `quoteToken`),Agent 认得。
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { actions, useStore } from "../store/project";
import { TimelineView } from "../editor/timeline";
import { ResizeHandle } from "../editor/ResizeHandle";
import { quoteToken } from "../mobile/agentView";
import { overlayQuoteId } from "../editor/timeline/overlayActions";
import { VibeStage } from "./VibeStage";

const secs = (t: number) => `${t.toFixed(2)} s`;

/** 时间轴那一框最矮多高(px):再矮工具条和一条序列行就挤不下 */
const TL_MIN_H = 160;
/** 最多吃掉这一页的七成:上面总要留得下一眼能看清的画面(和 `start.css` 里 `.ps-detail-tl` 的 max-height 一致) */
const TL_MAX_RATIO = 0.7;
/**
 * 拖出来的高度记在本机,下次打开还是这个高度 —— 和两条侧栏的宽度同一个道理(`sideWidth.ts` 开头那段)。
 * 没存过就不写行内高度,用 CSS 给的那个随窗口走的默认值;双击复位也是退回这一种。
 */
const TL_H_KEY = "pc.start.detailTlH";

function readTlH(): number | null {
  try {
    const saved = localStorage.getItem(TL_H_KEY);
    if (saved === null) return null;
    const n = Number(saved);
    // 存坏了(手改过、旧版本写的别的东西)就当没存过,退回 CSS 的默认高,不要把 NaN 写进样式
    return Number.isFinite(n) && n >= TL_MIN_H ? Math.round(n) : null;
  } catch {
    return null;
  }
}

function writeTlH(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(TL_H_KEY);
    else localStorage.setItem(TL_H_KEY, String(Math.round(px)));
  } catch {
    // 无痕窗口、禁了站点数据的浏览器会直接抛;存不了就只在这一次打开期间生效,不报错
  }
}

export function DetailEdit(props: {
  /**
   * 切到**传统式**:打开编辑界面(左栏 + 预览 + 时间轴 + AI 栏,`workflow/editing.md`「编辑界面」)。
   * 用户 2026-10-23 裁定:不另起「专业模式」这个名字,就用语义里已有的「传统式」。
   */
  onPro: () => void;
  onClose: () => void;
  /** 把一张卡引用进输入框 */
  onQuote: (text: string) => void;
}): JSX.Element {
  const duration = useStore((s) => Math.max(0.1, s.project.duration));
  const total = useStore((s) => s.project.duration);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);

  const rootRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<HTMLDivElement>(null);
  const [tlH, setTlH] = useState<number | null>(() => readTlH());
  /**
   * 此刻的高度。拖动期间 `ResizeHandle` 调的是按下去那一刻捕获的那几个闭包,读 state 读到的是旧值,
   * 所以松手写本机、键盘连发都走这个 ref(同 `Editor.tsx` 的 `usePanelSize`)。
   */
  const latestH = useRef(tlH);
  latestH.current = tlH;

  // 没存过高度时量一眼 CSS 给的默认高:拖杆得有个数当起点,不然第一下会从别处跳起来
  useLayoutEffect(() => {
    if (tlH === null && tlRef.current) setTlH(tlRef.current.clientHeight);
  }, [tlH]);

  const maxTlH = () => Math.max(TL_MIN_H, (rootRef.current?.clientHeight ?? window.innerHeight) * TL_MAX_RATIO);
  const sizeTl = (px: number) => {
    const next = Math.round(Math.max(TL_MIN_H, Math.min(maxTlH(), px)));
    latestH.current = next;
    setTlH(next);
    return next;
  };

  return (
    <div className="ps-detail" data-pc="start-detail" ref={rootRef}>
      <header className="ps-detail-head">
        <span className="ps-detail-title">详细编辑</span>
        <span className="ps-detail-sub">时间轴可调；右键一张卡可以引用进输入框</span>
        <span className="ps-rail-spacer" />
        {/*
          这一页属于氛围式 —— 对着 Agent 说话、在这儿看一眼、顺手调一下;
          点这个切到「传统式」,也就是打开整套编辑界面(`user-workflow.md`「工作方式」)。
        */}
        <button type="button" className="ps-mode-btn" data-pc="start-enter-traditional" title="打开编辑界面自己动手：左栏 + 预览 + 时间轴 + AI 栏" onClick={props.onPro}>
          进入传统式
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-close" onClick={props.onClose}>
          收起
        </button>
      </header>

      <div className="ps-detail-stage">
        <VibeStage className="ps-detail-screen" pc="start-detail-stage" />
      </div>

      <div className="ps-detail-transport">
        <button type="button" className="ps-detail-play" data-pc="start-detail-play" aria-label={playing ? "暂停" : "播放"} onClick={() => actions.togglePlay()}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
          )}
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-rewind" onClick={() => { actions.pause(); actions.seek(0); }}>
          回到开头
        </button>
        <input type="range" className="ps-detail-scrub" data-pc="start-detail-scrub" min={0} max={duration} step={0.05}
          value={Math.min(t, duration)} aria-label="进度" onChange={(e) => actions.seek(Number(e.target.value))} />
        <span className="ps-detail-time">{secs(t)} / {secs(total)}</span>
      </div>

      {/*
       * 舞台和时间轴之间那条缝(issue #40):平时一条线都不画,鼠标压上来才亮一条,拖它改时间轴的高度 ——
       * 时间轴拿多少是拖出来的,上面的舞台拿剩下的。双击回默认高;Tab 得到、方向键也能调(Shift 走大步、Home 复位)。
       *
       * 用的就是传统式编辑台时间轴上面那一根(`src/editor/ResizeHandle.tsx`):舞台是 iframe,鼠标一滑进去
       * 就收不到 pointermove 了,那一根拖动期间会让 iframe 这会儿不吃鼠标事件,自己另写一根就得把这个坑再踩一遍。
       */}
      <ResizeHandle
        axis="y"
        pc="start-detail-grip"
        value={tlH ?? TL_MIN_H}
        min={TL_MIN_H}
        max={maxTlH}
        invert
        onChange={sizeTl}
        onCommit={() => writeTlH(latestH.current)}
        onReset={() => { latestH.current = null; setTlH(null); writeTlH(null); }}
        onNudge={(delta) => writeTlH(sizeTl((latestH.current ?? TL_MIN_H) + delta))}
        title="拖动调整时间轴高度,双击复位"
      />

      {/*
       * 真时间轴。它自己是 `h-full`,所以这一框要有确定的高度(没拖过就是 CSS 里 `.ps-detail-tl` 那一截),
       * 上面的舞台拿剩下的。行高、缩放、剪辑标签都在它自带的那一条工具栏里,这里不再另给一套。
       */}
      <div className="ps-detail-tl" data-pc="start-detail-tl" ref={tlRef} style={tlH === null ? undefined : { flexBasis: `${tlH}px` }}>
        <TimelineView
          quoteClip={(clip, label) => props.onQuote(quoteToken({ id: clip.id, label }))}
          // 叠加卡比片段细一级:一段上挂两张同名的压暗很常见,不指明哪一张 Agent 只能反问
          quoteOverlay={(clip, item) => props.onQuote(quoteToken({ id: overlayQuoteId(clip, item), label: item.name, kind: "叠加卡" }))}
        />
      </div>
    </div>
  );
}
