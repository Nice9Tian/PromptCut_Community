import { actions, getState } from "../../store/project";
import { DEFAULT_CARD_DUR, DEFAULT_MEDIA_DUR } from "../../kernel/project";
import { timeOfX } from "./utils";
import { useTimelineContext } from "./TimelineContext";
import { clipAt, planDrop, planTransition, type DropPlan, type DropTarget } from "./dropPlan";
import { clearDragPayload, getDragPayload, MIME_CARD, MIME_CUT, MIME_MEDIA, type DragPayload } from "../dnd";
import { memberReadOnlyNow } from "../readOnlyCore";

/** 拖动没经过本窗口的 dragstart(跨窗口拖进来)时的兜底:只认得种类,时长用默认值 */
function fallbackPayload(types: readonly string[]): DragPayload | null {
  const list = Array.from(types);
  if (list.includes(MIME_CARD)) return { kind: "card", cardId: "", name: "卡片", duration: DEFAULT_CARD_DUR };
  if (list.includes(MIME_MEDIA)) return { kind: "media", mediaId: "", name: "素材", duration: DEFAULT_MEDIA_DUR };
  return null;
}

function samePlan(a: DropPlan | null, b: DropPlan | null) {
  if (!a || !b) return a === b;
  return (
    a.trackId === b.trackId &&
    a.newTrackIndex === b.newTrackIndex &&
    a.status === b.status &&
    a.hint === b.hint &&
    Math.abs(a.start - b.start) < 1e-6 &&
    Math.abs(a.end - b.end) < 1e-6
  );
}

/**
 * 一个「能接住左栏拖来的卡片 / 素材」的落点(一条轨,或者一条新建轨的位置)。
 * dragover 时把落点预演写进 context(轨道行 / 落区据此画预览),drop 时照着预演落。
 * 返回的 plan 只在预演正指着自己时非空。
 */
export function useDropTarget(target: DropTarget) {
  const { pxPerSec, dropPlan, setDropPlan } = useTimelineContext();

  const compute = (e: React.DragEvent, payload: DragPayload): DropPlan => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = timeOfX(e.clientX - rect.left, pxPerSec);
    const st = getState();
    return planDrop(st.project, payload, target, sec, { altKey: e.altKey, pxPerSec, t: st.t });
  };

  const onDragOver = (e: React.DragEvent) => {
    const payload = getDragPayload() ?? fallbackPayload(e.dataTransfer.types);
    if (!payload) return; // 不是左栏拖来的东西(比如轨道换序),让别人去处理
    // 只读项目(游客):不接。不 preventDefault = 浏览器按「不能放」处理,光标显示禁止
    if (memberReadOnlyNow()) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const plan = compute(e, payload);
    e.dataTransfer.dropEffect = plan.status === "forbidden" ? "none" : "copy";
    setDropPlan((prev) => (samePlan(prev, plan) ? prev : plan));
  };

  const onDragLeave = (e: React.DragEvent) => {
    // 移到自己的子元素上不算离开
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropPlan(null);
  };

  const onDrop = (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    const payload = getDragPayload() ?? fallbackPayload(dt.types);
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();
    if (memberReadOnlyNow()) {
      setDropPlan(null);
      clearDragPayload();
      return;
    }
    const plan = compute(e, payload);
    setDropPlan(null);
    clearDragPayload();
    if (plan.status === "forbidden") return;

    // 强调:给落点正下方那一段加阴影 / 描边
    if (payload.kind === "emphasis") {
      if (!plan.trackId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const sec = timeOfX(e.clientX - rect.left, pxPerSec);
      const hit = clipAt(getState().project, plan.trackId, sec);
      if (hit) actions.setClipEmphasis(hit.id, payload.emphasis);
      return;
    }

    // 转场:不放新片段,而是把落点处已有的那一 / 两段绑起来
    if (payload.kind === "transition") {
      if (!plan.trackId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const sec = timeOfX(e.clientX - rect.left, pxPerSec);
      const r = planTransition(getState().project, payload.transition, plan.trackId, sec, payload.duration);
      if (!r.plan) return;
      actions.addTransition({ kind: r.plan.kind, clipId: r.plan.aId, otherClipId: r.plan.bId, dur: r.plan.dur });
      return;
    }

    // 剪辑:在激活剪辑里放一个引用它的剪辑段(循环引用在 planDrop 里已经拦下、写明了原因)
    if (payload.kind === "cut") {
      const cutId = dt.getData(MIME_CUT) || payload.cutId;
      let seg = null;
      try {
        seg = actions.addCutSegment(cutId, plan.start, plan.trackId ? { trackId: plan.trackId } : { newTrackIndex: plan.newTrackIndex ?? undefined });
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
        return;
      }
      const st = getState();
      if (!st.playing && (st.t < seg.start || st.t >= seg.end)) actions.seek(seg.start);
      return;
    }

    // id 以 dataTransfer 为准(它才是拖放契约里的正本),模块里那份只是兜底
    const cardId = dt.getData(MIME_CARD) || (payload.kind === "card" ? payload.cardId : "");
    const mediaId = dt.getData(MIME_MEDIA) || (payload.kind === "media" ? payload.mediaId : "");

    // 素材格拖出来的卡带着填好的参数和时长(左栏 AssetCell);普通卡格两样都没有,走默认
    const cardOpts = payload.kind === "card" ? { params: payload.params, duration: payload.params ? payload.duration : undefined } : {};
    let clip = null;
    if (plan.trackId) {
      clip =
        payload.kind === "card"
          ? actions.addCardClip(cardId, plan.start, { trackId: plan.trackId, ...cardOpts })
          : actions.addMediaClip(mediaId, plan.start, { trackId: plan.trackId });
    } else {
      clip = actions.addClipOnNewTrack({
        index: plan.newTrackIndex ?? undefined,
        cardId: payload.kind === "card" ? cardId : undefined,
        mediaId: payload.kind === "media" ? mediaId : undefined,
        start: plan.start,
      });
      // 新建序列那条路不接参数,落完再补上
      if (clip && payload.kind === "card" && payload.params) {
        actions.setClipParams(clip.id, payload.params);
        if (cardOpts.duration) actions.moveClip(clip.id, { end: clip.start + cardOpts.duration });
      }
    }
    if (!clip) return;

    // 落完把播放头挪进新片段,中间的画面立刻显示它(播放中不打断)
    const st = getState();
    if (!st.playing && (st.t < clip.start || st.t >= clip.end)) actions.seek(clip.start);
  };

  const isMine =
    dropPlan != null &&
    ("trackId" in target
      ? dropPlan.trackId === target.trackId
      : dropPlan.trackId === null && dropPlan.newTrackIndex === target.newTrackIndex);

  return { onDragOver, onDragLeave, onDrop, plan: isMine ? dropPlan : null };
}
