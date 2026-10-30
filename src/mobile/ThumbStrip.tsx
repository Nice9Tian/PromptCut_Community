/**
 * 缩略时间轴(语义 `workflow/editing.md`「手机版界面」;演示稿第四、九轮):只放主要内容,各卡等宽、标时长,
 * 正中固定一条当前帧标记,卡在下面滚动。按住左右拖 = 滚动 = 调整当前时间(手指上由浏览器原生横滑做,带惯性;鼠标走手动那条路);点卡选中(再点取消);先选中再长按拖动 = 换顺序;
 * 点转场 ◇ 和点卡同一个动作(原地选中);没有转场的「＋」打开卡片库转场分类。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Project, TrackClip } from "../kernel/project";
import { clipSpeed, isSpeedChanged, speedLabel } from "../kernel/clipTime.mjs";
import { clipMakesNoSound } from "../editor/timeline/clipSilence";
import { ThumbImg, useThumb } from "./Thumb";
import type { Transition } from "../kernel/transitions";
import { boundaryTransition, cardPosAtTime, clipKind, mainTotal, timeAtCardPos } from "./mainContent";
import { Icon } from "./icons";
import { fmtDur, tint } from "./ui";

/** 长按多久才算拿起来换顺序 */
const LIFT_MS = 350;

export function ThumbStrip(props: {
  project: Project;
  clips: TrackClip[];
  t: number;
  playing: boolean;
  /** 选中的缩略卡(片段 id)或转场(转场 id) */
  selected: string | null;
  onSelect: (sel: { clipId: string } | { transition: Transition } | null) => void;
  onReorder: (order: string[]) => void;
  onScrub: (t: number) => void;
  onAddMedia: () => void;
  onAddTransition: (a: TrackClip, b: TrackClip) => void;
  /** 只读项目(游客):长按拖动换顺序不接,点选、滚动、看都照常 */
  locked?: boolean;
}) {
  const { project, clips, selected } = props;
  const sc = useRef<HTMLDivElement>(null);
  /** 自己设的滚动位置(跟着当前时间走),滚动事件看到它就不回头改时间 */
  const progSl = useRef(0);
  /**
   * 最近一次「不是我们自己设的」滚动发生在什么时候。
   *
   * 下面那个同步 effect 没有依赖数组、每次渲染都跑，原来只在手指按着（`dragging`）时让开。
   * 交给浏览器原生横滑之后这就不够了：**松手之后的惯性那一段 `dragging` 已经是 false**，
   * 这期间只要有任何一次重渲染（卡片在测量、进度在跳、Agent 在改都会引起），
   * effect 就把 scrollLeft 弹回「当前时间」对应的位置 —— 手感上就是「怎么划都回去，白线一动不动」。
   * 所以再记一个时间戳：最近 400 毫秒内有用户自己的滚动，就别去碰它。
   */
  const userScrollAt = useRef(0);
  const suppressClick = useRef(false);
  const dragging = useRef(false);

  const blocks = () => [...(sc.current?.querySelectorAll<HTMLElement>(".mblock") ?? [])];
  /** 当前帧标记(正中)落在卡序列里的位置:整数部分第几张,小数部分卡内比例 */
  /**
   * 第 i 张卡在滚动方向上占多长：从它的左缘量到**下一张卡的左缘**（最后一张量到自己的右缘）。
   *
   * 为什么不是「卡自己的宽度」：两段之间还夹着转场标记 `.mark`（宽 24、左右各 3 的外边距，共 30px）。
   * 按卡宽算的话这 30px 不属于任何一段，于是两头都出毛病 —— 播到段边界时缩略条瞬移 30px；
   * 用户手动滚进这 30px 时 `posFromScroll` 恒回整数，时间卡在下一段开头不动。段数越多、这种死区越多。
   * 把间隙并进前一段之后，位置换算在整条上连续且可逆，白线走过转场标记时上一段正好播到尾，读着也顺。
   * （2026-10-25 查 iOS 滑不动那条时顺带发现的，用户当场说「修好」。）
   */
  const spanOf = (bl: HTMLElement[], i: number): [number, number] => {
    const l = bl[i].offsetLeft;
    return [l, i + 1 < bl.length ? bl[i + 1].offsetLeft : l + bl[i].offsetWidth];
  };
  const posFromScroll = (): number => {
    const el = sc.current!;
    const x = el.scrollLeft + el.clientWidth / 2;
    const bl = blocks();
    for (let i = 0; i < bl.length; i++) {
      const [l, r] = spanOf(bl, i);
      if (x < l) return i;
      if (x < r) return i + (x - l) / (r - l);
    }
    return bl.length;
  };
  /*
   * 这里用的 `offsetLeft` 是相对 `.mainstrip` 量的，不是相对滚动容器 ——
   * `.strip-scroll` 自己没有定位，`offsetParent` 落在外层 `.mainstrip` 上（它是 position: relative）。
   * 算出来对，只是因为 `.strip-scroll` 在 `.mainstrip` 里恰好 x = 0、没有边框。
   * **别给 `.strip-scroll` 加左边距或边框**，也别给它加 `position: relative`（那会让
   * `offsetParent` 变成滚动容器本身，`offsetLeft` 从 padding 边量起、少掉左边那段留白），
   * 两种都会让这里算错而且很难查。2026-10-25 把左右留白从占位 div 换成容器 padding 时
   * 复核过：padding 不影响 `offsetLeft`（首卡仍是 50% 处），所以那次改动是安全的。
   */
  const scrollForPos = (pos: number): number => {
    const el = sc.current!;
    const bl = blocks();
    if (!bl.length) return 0;
    const i = Math.min(Math.floor(pos), bl.length - 1);
    const f = pos >= bl.length ? 1 : pos - i;
    const [l, r] = spanOf(bl, i);
    return l + f * (r - l) - el.clientWidth / 2;
  };

  // 播放、点刻度、切换剪辑时,缩略时间轴跟着当前时间走(手指按着的时候不动)
  useLayoutEffect(() => {
    const el = sc.current;
    if (!el || !el.clientWidth || dragging.current || performance.now() - userScrollAt.current < 400) return;
    const want = scrollForPos(cardPosAtTime(clips, props.t));
    if (Math.abs(el.scrollLeft - want) < 1) return;
    el.scrollLeft = want;
    progSl.current = el.scrollLeft;
  });

  useEffect(() => {
    const el = sc.current;
    if (!el) return;
    const onScroll = () => {
      if (!el.clientWidth || Math.abs(el.scrollLeft - progSl.current) < 1.5) return;
      // 和 progSl 对不上 = 这一下不是我们自己设的，是用户在滑（手指拖、惯性、滚轮都算）
      userScrollAt.current = performance.now();
      progSl.current = el.scrollLeft;
      props.onScrub(timeAtCardPos(clips, posFromScroll()));
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    const el = sc.current!;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".mblock, .mark.has");
    const isBlock = !!target?.classList.contains("mblock");
    const id = target?.dataset.id ?? null;
    const x0 = e.clientX, sl0 = el.scrollLeft;
    /*
     * 手指划在**没选中**的地方时,横向滑动交给浏览器自己做(`.strip-scroll` 的 `touch-action: pan-x`),
     * 这边就不要再推一次 scrollLeft —— 两边一起推会滑成两倍快。
     * 选中的那张卡上关掉了原生滑动(CSS 里 `.mblock.sel { touch-action: none }`),因为它要能长按拖动换顺序,
     * 所以那一张仍然走下面手动这条路;鼠标也一直走手动这条路。
     */
    const nativePan = e.pointerType === "touch" && !(isBlock && id && selected === id);
    let mode: "pending" | "scroll" | "reorder" = "pending";
    let timer = 0;
    dragging.current = true;
    if (!props.locked && isBlock && id && selected === id) {
      timer = window.setTimeout(() => { if (mode === "pending") { mode = "reorder"; target!.classList.add("lift"); } }, LIFT_MS);
    }
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (mode === "pending" && Math.abs(dx) > 6) { window.clearTimeout(timer); mode = "scroll"; }
      if (mode === "scroll" && !nativePan) el.scrollLeft = sl0 - dx;
      else if (mode === "reorder") target!.style.transform = `translateX(${dx}px)`;
    };
    const end = (ev: PointerEvent) => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      dragging.current = false;
      if (mode !== "pending") { suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0); }
      if (mode === "reorder" && id) {
        const cx = target!.getBoundingClientRect().left + target!.offsetWidth / 2;
        target!.classList.remove("lift");
        target!.style.transform = "";
        const sibs = blocks().filter((b) => b !== target);
        let idx = 0;
        sibs.forEach((s, i) => { const r = s.getBoundingClientRect(); if (cx > r.left + r.width / 2) idx = i + 1; });
        const order = clips.map((c) => c.id).filter((x) => x !== id);
        order.splice(idx, 0, id);
        if (order.join() !== clips.map((c) => c.id).join()) props.onReorder(order);
      } else if (mode === "pending" && ev.type === "pointerup" && target && id) {
        if (isBlock) props.onSelect(selected === id ? null : { clipId: id });
        else {
          const k = Number(target.dataset.k);
          const tr = boundaryTransition(project, clips[k], clips[k + 1]);
          if (tr) props.onSelect(selected === tr.id ? null : { transition: tr });
        }
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const total = Math.round(mainTotal(clips) * 10) / 10;
  return (
    <>
      <div className="mainhead"><b>缩略时间轴</b><span data-pcm="main-sum">{clips.length ? `${clips.length} 段 · 共 ${fmtDur(total)}` : "还没有内容，点 ＋ 添加素材"}</span></div>
      <div className="mainstrip" data-pcm="main-strip">
        <div className="cf-line" title="当前帧" data-pcm="frame-line" />
        <div
          ref={sc}
          className="strip-scroll"
          onPointerDown={onPointerDown}
          onClickCapture={(e) => { if (suppressClick.current) { e.stopPropagation(); e.preventDefault(); } }}
        >
          <button type="button" className="madd" aria-label="添加素材" title="添加素材" data-pcm="main-add" onClick={props.onAddMedia}><Icon name="plus" /></button>
          {clips.map((c, i) => {
            const tr = i < clips.length - 1 ? boundaryTransition(project, c, clips[i + 1]) : null;
            // 变速段原声不出(〔裁〕,kernel/clipTime.mjs):和静音一样挂静音图标,时长后面带倍数
            const muted = !!c.audioMuted || clipMakesNoSound(project, c);
            // 补空档补进来的长段可能在几处各出现一截(同一个 id),键带上起点
            const key = `${c.id}@${c.start}`;
            return [
              <div
                key={key}
                className={selected === c.id ? "mblock sel" : "mblock"}
                data-id={c.id}
                data-kind={clipKind(project, c)}
                data-pcm="mblock"
                style={{ background: `linear-gradient(135deg, ${tint(c.mediaId ?? c.cutId ?? c.id)}, var(--shade-art))` }}
              >
                <BlockThumb project={project} clip={c} />
                <span className="no">{i + 1}</span>
                <span className="du">{fmtDur(c.end - c.start)}{isSpeedChanged(c) && c.mediaId ? ` ${speedLabel(clipSpeed(c))}` : ""}{muted && <Icon name="mute" />}</span>
              </div>,
              i < clips.length - 1 && (
                tr
                  ? <button key={`m-${key}`} type="button" className={selected === tr.id ? "mark has sel" : "mark has"} data-id={tr.id} data-k={i} data-pcm="mark" title="转场">◇</button>
                  : <button key={`m-${key}`} type="button" className="mark" data-k={i} data-pcm="mark-add" title="添加转场" onClick={() => props.onAddTransition(c, clips[i + 1])}>＋</button>
              ),
            ];
          })}
        </div>
      </div>
    </>
  );
}

const KIND_ICON = { video: "video", image: "image", cut: "clip", card: "card", audio: "audio" } as const;

/**
 * 缩略卡的画面:视频段取它入点那一帧,图片段取缩略图;垫在下面的是类型图标,卡片段、剪辑段、取不到时
 * 露出的就是取色底色 + 类型图标(+ 卡上的时长),不留空白、不出破图
 */
function BlockThumb({ project, clip }: { project: Project; clip: TrackClip }) {
  const media = clip.mediaId && !clip.cardId ? project.media.find((m) => m.id === clip.mediaId) : undefined;
  const thumb = useThumb(media, media?.kind === "video" ? clip.mediaOffset ?? 0 : 0);
  return (
    <>
      <span className="kic" data-pcm="mblock-icon"><Icon name={KIND_ICON[clipKind(project, clip)]} /></span>
      {media && media.kind !== "audio" ? <ThumbImg thumb={thumb} /> : null}
    </>
  );
}
