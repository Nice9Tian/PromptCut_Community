import { useId, useMemo, useState } from "react";
import { actions, useStore } from "../../../store/project";
import type { MediaAsset, Project, TrackClip } from "../../../kernel/project";
import {
  describeTransition, transitionsOf, transitionsOfClip, TRANSITION_LABEL,
  type TransitionKind,
} from "../../../kernel/transitions";
import { clearDragPayload, MIME_TRANSITION, setDragPayload } from "../../dnd";
import { PreviewCard } from "../PreviewCard";
import { useReadOnly } from "../../readOnly";
import { usePreviewMediaUrl } from "../../media/previewUrl";
import { ThumbTile } from "./ThumbTile";
import type { GroupData, GroupItem } from "./groups";

/**
 * 特效 → 转场组。
 *
 * 转场是**对象**:加一处就在项目里落一条记录,把它引用的片段绑成一组 —— 那几段的相对
 * 时间关系锁住,想单独挪、改长度、切开,得先删转场(规矩在 kernel/transitions.ts)。
 *
 * 这个组三件事:
 *   1. 三张卡是转场本身,拖到时间轴上 —— 拖到两段首尾相接处 = 交叉溶解,
 *      拖到一段的开头 / 结尾 = 淡入 / 淡出。选中片段时点一下也能直接加;
 *   2. 下面列出**已有的转场**,每条都能删(删完那几段就解锁);
 *   3. 再下面列出时间轴上首尾相接的接缝,一键接成交叉溶解。
 *
 * 同一条序列内不允许重叠,所以交叉溶解会把后一段往前拉、必要时挪到另一条序列;
 * 删转场时再尽量放回去。
 */

const DURATIONS = [0.3, 0.5, 1, 1.5, 2];
const KINDS = ["crossfade", "fadeIn", "fadeOut"] as const;
/** 示意图卡的高宽比:图形都在中间一条带里,用不着正方形 */
const GLYPH_ASPECT = 0.75;

type Pair = { a: TrackClip; aTrack: string; b: TrackClip; bTrack: string };

/** 时间上相邻(或已重叠)的两段素材,按先后给出 */
function findPairs(p: Project): Pair[] {
  const all: Array<{ clip: TrackClip; trackId: string }> = [];
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      if (!c.mediaId) continue;
      const m = p.media.find((x) => x.id === c.mediaId);
      if (!m) continue;
      // 声音也算:两段音乐重叠 + 各自淡化就是听得见的交叉淡入淡出,和画面同一套做法
      all.push({ clip: c, trackId: tr.id });
    }
  }
  all.sort((x, y) => x.clip.start - y.clip.start);
  const pairs: Pair[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    // 只认「首尾相接」或已经重叠的:差得太远就不是一个转场点
    if (b.clip.start - a.clip.end > 0.001) continue;
    pairs.push({ a: a.clip, aTrack: a.trackId, b: b.clip, bTrack: b.trackId });
  }
  return pairs;
}

/** 一段素材的静态画面:图片直接放,视频取首帧,声音没有画面就给一块底色(转场卡只看溶解,不播) */
function Still({ media, style }: { media: MediaAsset | undefined; style?: React.CSSProperties }) {
  // 桌面是 media.url;在线浏览器模式换成远程素材服务的地址(只用小尺寸的素材只给小尺寸),没就绪时不挂 src
  const src = usePreviewMediaUrl(media) || undefined;
  if (!media) return <div style={{ ...style, background: "var(--ui-panel-2)" }} />;
  if (media.kind === "audio") {
    return (
      <div style={{ ...style, background: "var(--ui-panel-2)", display: "grid", placeItems: "center", color: "var(--ui-fg-faint)", fontSize: 10 }}>
        声音
      </div>
    );
  }
  if (media.kind === "image") return <img src={src} alt="" draggable={false} style={style} />;
  return <video src={src} muted playsInline preload="metadata" draggable={false} style={style} />;
}

const layer: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };

/**
 * 三张转场卡的示意图:两块色带 + 渐变,一眼看出是「叠着化过去」还是「从黑里出来」。
 * 渐变 id 每个实例各用一份:总览缩略和详情卡同时在 DOM 里(总览只是隐藏),
 * 重名的话 url(#id) 会指到隐藏的那一份上,渐变就画不出来。
 */
function TransitionGlyph({ kind }: { kind: TransitionKind }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const A = "var(--ui-accent)";
  const B = "var(--ui-track-video, #4FB3C9)";
  if (kind === "crossfade") {
    const id = `pc-xf-${uid}`;
    return (
      <svg viewBox="0 0 100 100" style={{ ...layer }} aria-hidden="true">
        <rect x="6" y="26" width="52" height="48" rx="4" fill={B} opacity="0.85" />
        <rect x="42" y="26" width="52" height="48" rx="4" fill={A} opacity="0.85" />
        <defs>
          <linearGradient id={id} x1="0" x2="1">
            <stop offset="0%" stopColor="#000" stopOpacity="0.55" />
            <stop offset="50%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <rect x="42" y="26" width="16" height="48" fill={`url(#${id})`} />
      </svg>
    );
  }
  const id = `pc-${kind}-${uid}`;
  const dir = kind === "fadeIn" ? { x1: "0", x2: "1" } : { x1: "1", x2: "0" };
  return (
    <svg viewBox="0 0 100 100" style={{ ...layer }} aria-hidden="true">
      <defs>
        <linearGradient id={id} {...dir}>
          <stop offset="0%" stopColor={A} stopOpacity="0.05" />
          <stop offset="100%" stopColor={A} stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <rect x="6" y="26" width="88" height="48" rx="4" fill={`url(#${id})`} />
    </svg>
  );
}

const KIND_HINT: Record<TransitionKind, string> = {
  crossfade: "拖到两段首尾相接的地方;两段会绑成一组",
  fadeIn: "拖到一段的开头(或选中片段后点一下)",
  fadeOut: "拖到一段的结尾(或选中片段后点一下)",
};

/** q 是已经 trim + 小写的搜索词;flash 是分区底部的提示条 */
export function useTransitionsGroup(q: string, flash: (text: string, ms?: number) => void): GroupData {
  // 这个项目只给了只读权限(游客):加转场 / 删转场都是写
  const ro = useReadOnly();
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [dur, setDur] = useState(0.5);
  const [hotIndex, setHotIndex] = useState<number | null>(null);

  const pairs = useMemo(() => findPairs(project), [project]);
  const transitions = transitionsOf(project);
  const mediaOf = (c: TrackClip) => project.media.find((m) => m.id === c.mediaId);
  const nameOf = (c: TrackClip) => mediaOf(c)?.name ?? "素材";

  const apply = (pair: Pair) => {
    const r = actions.addTransition({ kind: "crossfade", clipId: pair.a.id, otherClipId: pair.b.id, dur });
    flash(r.ok ? `已加 ${dur}s 交叉溶解,这两段现在是一组` : r.error);
  };

  /** 点卡片:淡入淡出加在选中的片段上;交叉溶解要两段,让用户去拖或用下面的接缝列表 */
  const clickKind = (kind: TransitionKind) => {
    if (kind === "crossfade") {
      flash("交叉溶解要两段:把这张卡拖到时间轴上两段相接的地方,或用下面的接缝列表");
      return;
    }
    const clipId = selection[0];
    if (!clipId) {
      flash(`先在时间轴上选中一个片段,再点${TRANSITION_LABEL[kind]};也可以直接把卡拖到片段的${kind === "fadeIn" ? "开头" : "结尾"}`);
      return;
    }
    const r = actions.addTransition({ kind, clipId, dur });
    flash(r.ok ? `已加 ${dur}s ${TRANSITION_LABEL[kind]}` : r.error);
  };

  const drag = (kind: TransitionKind) => (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_TRANSITION, kind);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "transition", transition: kind, name: TRANSITION_LABEL[kind], duration: dur });
  };

  const kinds = KINDS.filter((k) => !q || TRANSITION_LABEL[k].toLowerCase().includes(q) || KIND_HINT[k].includes(q));

  const items: GroupItem[] = kinds.map((kind) => ({
    id: kind,
    aspect: GLYPH_ASPECT,
    node: (
      <PreviewCard
        attrs={{ "data-pc-transition": kind }}
        title={TRANSITION_LABEL[kind]}
        subtitle={`${dur}s`}
        preview={<TransitionGlyph kind={kind} />}
        draggable
        edits
        onDragStart={drag(kind)}
        onDragEnd={clearDragPayload}
        onClick={() => clickKind(kind)}
        titleAttr={KIND_HINT[kind]}
        fill
      />
    ),
  }));

  const thumbs: GroupItem[] = kinds.map((kind) => ({
    id: kind,
    node: <ThumbTile title={TRANSITION_LABEL[kind]} preview={<TransitionGlyph kind={kind} />} />,
  }));

  const detailTop = (
    <div className="pc-lib-block">
      <div className="pc-lib-label">转场时长</div>
      <div className="pc-lib-seg">
        {DURATIONS.map((d) => (
          <button key={d} type="button" className={`pc-chip${dur === d ? " is-on" : ""}`} aria-pressed={dur === d} onClick={() => setDur(d)}>
            {d}s
          </button>
        ))}
      </div>
    </div>
  );

  const detailBottom = (
    <>
      {/* 已经加上的转场:每条都能删,删完那几段就解锁 */}
      {transitions.length > 0 && (
        <div className="pc-lib-block">
          <div className="pc-lib-label">
            <span>已有转场</span>
            <span>({transitions.length})</span>
          </div>
          <div className="pc-lib-rows">
            {transitions.map((tr) => (
              <div key={tr.id} className="pc-lib-row">
                <span className="pc-lib-row-text" title={describeTransition(project, tr)}>
                  {describeTransition(project, tr)}
                </span>
                <button
                  type="button"
                  className="pc-left-btn"
                  disabled={ro.locked}
                  title={ro.title("删掉这处转场,相关片段解锁")}
                  onClick={() => {
                    const r = actions.removeTransition(tr.id);
                    flash(r.ok ? `已删掉转场${r.note ? `(${r.note})` : ",相关片段解锁了"}` : r.error);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 时间轴上首尾相接的接缝:一键接成交叉溶解 */}
      <div className="pc-lib-block">
        <div className="pc-lib-label">相接的两段</div>
        {pairs.length === 0 ? (
          <div className="pc-left-note">
            没有找到相接的两段素材。
            <br />
            把两段视频前后接在时间轴上,这里就会列出它们的衔接点。
          </div>
        ) : (
          <div className="pc-lib-grid">
            {pairs.map((pair, i) => {
              const has = transitionsOfClip(project, pair.a.id).some((tr) => tr.kind === "crossfade" && tr.bId === pair.b.id);
              const hot = hotIndex === i;
              // 悬停时后一段在前一段上来回淡入淡出,周期 = 当前选的转场时长(往返各一次)
              const fadeStyle: React.CSSProperties = hot
                ? { ...layer, animation: `pc-xfade ${Math.max(0.3, dur) * 2}s ease-in-out infinite` }
                : { ...layer, opacity: 0 };
              return (
                <PreviewCard
                  key={`${pair.a.id}-${pair.b.id}`}
                  title={`${nameOf(pair.a)} → ${nameOf(pair.b)}`}
                  subtitle={has ? `已是一组 · ${pair.a.end.toFixed(1)}s` : `衔接于 ${pair.a.end.toFixed(1)}s`}
                  onHover={(v) => setHotIndex(v ? i : (cur) => (cur === i ? null : cur))}
                  preview={
                    <>
                      <Still media={mediaOf(pair.a)} style={layer} />
                      <Still media={mediaOf(pair.b)} style={fadeStyle} />
                    </>
                  }
                  titleAttr={has ? "这两段已经用交叉溶解绑成一组" : "悬停预览交叉溶解;点下面的按钮加上"}
                  footer={
                    <div className="pc-lib-card-foot">
                      <button type="button" className="pc-left-btn is-block" disabled={has || ro.locked} title={ro.title()} onClick={() => apply(pair)}>
                        {has ? "已加转场" : "加交叉溶解"}
                      </button>
                    </div>
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </>
  );

  return { items, thumbs, detailTop, detailBottom, emptyDetail: <div className="pc-left-note">没有匹配的转场</div> };
}
