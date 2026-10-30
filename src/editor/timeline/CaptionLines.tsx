import { useMemo, useRef, useState } from "react";
import { useTimelineContext } from "./TimelineContext";
import { actions } from "../../store/project";
import { useDrag } from "./useDrag";
import { useUserEditing } from "../userEditing";
import { ContextMenu } from "./ContextMenu";
import { captionsOf, captionBounds, MIN_CAPTION_DUR, type CaptionLine } from "../../kernel/captions";
import type { TrackClip } from "../../kernel/project";
import { useReadOnly } from "../readOnly";

/**
 * 字幕卡内部的一条条字幕。
 *
 * 字幕的内容存在卡片的 `lines` 参数里,所以时间轴上它一直只是一个大色块 ——
 * 哪句话几秒出、压在哪个镜头上,全看不见。这里把每条字幕画成色块里的一小格:
 * 点一下跳过去、拖着挪、拽边改时长、双击改字、右键删。改完写回同一个 lines 字符串,
 * 画面那边(caption-track 卡)一个字都不用动。
 *
 * 拖动全部限制在这张卡内、且不越过左右邻居(kernel/captions 的 captionBounds 说了算),
 * 所以不会出现两条字幕抢同一秒的情况。
 */
export function CaptionLines({ clip, height }: { clip: TrackClip; height: number }) {
  const { pxPerSec } = useTimelineContext();
  const lines = useMemo(() => captionsOf(clip), [clip.params?.lines]);
  const dur = clip.end - clip.start;
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const ro = useReadOnly();

  // 行太矮(小号行高)就只画色块不写字:塞不下的字只会糊成一团
  const showText = height >= 40;

  return (
    <>
      <div className="absolute inset-0 pointer-events-none">
        {lines.map((l, i) => (
          <CaptionBlock
            key={`${i}-${l.start}`}
            clipId={clip.id}
            clipStart={clip.start}
            line={l}
            index={i}
            lines={lines}
            dur={dur}
            pxPerSec={pxPerSec}
            showText={showText}
            editing={editing === i}
            onEdit={() => setEditing(i)}
            onEditDone={() => setEditing(null)}
            onMenu={(x, y) => setMenu({ x, y, index: i })}
          />
        ))}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={ro.locked ? [{ label: ro.why, disabled: true, action: () => {} }] : [
            { label: "改文字", action: () => setEditing(menu.index) },
            {
              label: "在这里加一条",
              action: () => {
                // 从当前这条的末尾开始塞;塞不下 addCaption 会返回 -1,那就什么都不做
                const after = lines[menu.index];
                actions.addCaption(clip.id, { start: after ? after.end : 0, zh: "新字幕" });
              },
            },
            { label: "删除这条字幕", action: () => actions.removeCaption(clip.id, menu.index) },
          ]}
        />
      )}
    </>
  );
}

function CaptionBlock({
  clipId,
  clipStart,
  line,
  index,
  lines,
  dur,
  pxPerSec,
  showText,
  editing,
  onEdit,
  onEditDone,
  onMenu,
}: {
  clipId: string;
  clipStart: number;
  line: CaptionLine;
  index: number;
  lines: CaptionLine[];
  dur: number;
  pxPerSec: number;
  showText: boolean;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  /*
   * 拖动中的临时时段:不写 store,松手才提交。
   *
   * 同一份值同时放在 state(要重画)和 ref(松手时要读准)里 —— 松手的回调是
   * useDrag 存下来的闭包,直接读 state 可能读到上一帧的值,所以以 ref 为准。
   */
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const dragRef = useRef<{ start: number; end: number } | null>(null);
  /** 这一次按下之后有没有真的动过:没动就当成「点一下」 */
  const movedRef = useRef(false);
  /*
   * 双击自己数,不用浏览器的 dblclick。
   *
   * 这块在 pointerdown 里 setPointerCapture(拖动要用),指针一被捕获,浏览器就不再
   * 把连着的两下算成一次双击 —— 实测原生 dblclick 根本不触发。所以记一下上次点的
   * 时间,够快的第二下就进改字模式。
   */
  const lastClick = useRef(0);

  const setBoth = (v: { start: number; end: number } | null) => {
    dragRef.current = v;
    setDrag(v);
  };

  // 字幕条拖动中 / 双击改字中:告诉 Agent 用户正在编辑这个字幕片段(A2)
  useUserEditing(`caption-drag:${clipId}:${index}`, drag ? clipId : null, "drag");
  useUserEditing(`caption-text:${clipId}:${index}`, editing ? clipId : null, "text");

  const start = drag ? drag.start : line.start;
  const end = drag ? drag.end : line.end;

  // 这个项目只给了只读权限(游客):点一下照样跳过去看,但不能拖、拽边、双击改字
  const ro = useReadOnly();

  const bodyRef = useDrag(
    () => {
      movedRef.current = false;
      actions.select([clipId]);
    },
    (_e, delta) => {
      if (ro.locked) return;
      const dt = delta.x / pxPerSec;
      if (Math.abs(delta.x) > 2) movedRef.current = true;
      const { min, max } = captionBounds(lines, index, dur);
      const len = line.end - line.start;
      const s = Math.max(min, Math.min(line.start + dt, Math.max(min, max - len)));
      setBoth({ start: s, end: Math.min(max, s + len) });
    },
    () => {
      const prev = dragRef.current;
      setBoth(null);
      if (ro.locked) {
        // 只读:只有「点一下 = 把播放头挪过去」
        actions.seek(clipStart + line.start + 0.01);
        return;
      }
      if (movedRef.current) {
        // 真拖过:只给 start,长度不变(editCaption 把「只给起点」理解成整条平移)
        if (prev) actions.editCaption(clipId, index, { start: prev.start });
        return;
      }
      const now = Date.now();
      if (now - lastClick.current < 450) {
        lastClick.current = 0;
        onEdit();
      } else {
        lastClick.current = now;
        // 点一下 = 把播放头挪到这条字幕上(加一点点,免得正好卡在边界上什么都不显示)
        actions.seek(clipStart + line.start + 0.01);
      }
    },
  );

  /** 修边:两头的把手各一套,松手时把起止一起写回去 */
  const commitTrim = () => {
    const prev = dragRef.current;
    setBoth(null);
    if (ro.locked) return;
    if (prev) actions.editCaption(clipId, index, { start: prev.start, end: prev.end });
  };

  const leftRef = useDrag(
    () => { movedRef.current = true; },
    (_e, delta) => {
      if (ro.locked) return;
      const dt = delta.x / pxPerSec;
      const { min } = captionBounds(lines, index, dur);
      const s = Math.max(min, Math.min(line.start + dt, line.end - MIN_CAPTION_DUR));
      setBoth({ start: s, end: line.end });
    },
    commitTrim,
  );

  const rightRef = useDrag(
    () => { movedRef.current = true; },
    (_e, delta) => {
      if (ro.locked) return;
      const dt = delta.x / pxPerSec;
      const { max } = captionBounds(lines, index, dur);
      const e2 = Math.min(max, Math.max(line.end + dt, line.start + MIN_CAPTION_DUR));
      setBoth({ start: line.start, end: e2 });
    },
    commitTrim,
  );

  const width = Math.max(2, (end - start) * pxPerSec);
  const geom = { left: `${start * pxPerSec}px`, width: `${width}px` };

  /*
   * 改字时整块换成一个不带拖动的壳。
   *
   * useDrag 挂的是**原生** pointerdown 并且会 setPointerCapture,输入框上那句
   * React 的 stopPropagation 拦不住它 —— 留着拖动的话,点进输入框想放光标会被
   * 指针捕获抢走,拖一下还会顺手把这条字幕挪了。
   */
  if (editing) {
    return (
      <div className="pc-cap-line absolute pointer-events-auto" style={geom}>
        <input
          autoFocus
          defaultValue={line.zh}
          className="pc-cap-input"
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== line.zh) actions.editCaption(clipId, index, { zh: v });
            onEditDone();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onEditDone();
            e.stopPropagation();
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={bodyRef}
      data-pc-caption-line={index}
      className="pc-cap-line absolute pointer-events-auto"
      style={geom}
      title={`${line.start.toFixed(2)}–${line.end.toFixed(2)}s · ${line.zh || line.en}${ro.locked ? `（${ro.why}）` : "（双击改字，右键更多）"}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div ref={leftRef} className="pc-cap-grip is-left" />
      {showText && <span className="pc-cap-text">{line.zh || line.en}</span>}
      <div ref={rightRef} className="pc-cap-grip is-right" />
    </div>
  );
}
