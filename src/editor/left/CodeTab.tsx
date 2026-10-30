import { useState, useRef, useEffect, useMemo } from "react";
import { actions, getState, useStore } from "../../store/project";
import { getCard } from "../../kernel/registry";
import type { TrackClip } from "../../kernel/project";
import { applyEnvelope, describeLifecycle, envelopeOf, type ClipEnvelope } from "../../kernel/envelope";
import { useReadOnly } from "../readOnly";

/**
 * 编辑 → 代码:显示并编辑这张卡的**约定封装**(kernel/envelope.ts),不是原始代码。
 *
 * 以前这里是 `{ cardId, start, end, params }` 一坨扁平参数 —— 位置、淡入淡出、部件结构、
 * 生命周期都不在里面,看不出「动画 1 秒就落定了后面都是静止」「能不能加淡出」「哪个参数管哪块」。
 * 现在显示的是封装:card(含 lifecycle)/ time / frame(local 可写,world 只读)/ blend / motion /
 * parts(部件树,每个部件带自己的参数)/ params。改完 Ctrl+Enter 或失焦应用,只写有差异的段,
 * 和 Agent 的 set_clip 走同一个 applyEnvelope。
 */
export function CodeTab({ clip }: { clip: TrackClip }) {
  const project = useStore((s) => s.project);
  const card = getCard(clip.cardId);
  const envelope = useMemo(
    () => envelopeOf(project, clip, card, { width: project.width, height: project.height }),
    [project, clip, card],
  );
  const current = useMemo(() => JSON.stringify(envelope, null, 2), [envelope]);
  const lastCurrent = useRef(current);

  const [draft, setDraft] = useState(current);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  // 这个项目只给了只读权限(游客):代码照常看、能选中复制,但不能改、不能应用、不能重置
  const ro = useReadOnly();

  const missing = envelope.missingParams ?? [];
  /** 刚应用过:下一份 current(带重新算出的 world 等只读段)到了就直接采用,别把用户改过的草稿留成「未应用」 */
  const adoptNext = useRef(false);

  useEffect(() => {
    if (current !== lastCurrent.current) {
      if (draft === lastCurrent.current || adoptNext.current) {
        setDraft(current);
        adoptNext.current = false;
      }
      lastCurrent.current = current;
      setErrorMsg(null);
    }
  }, [current, draft]);

  const dirty = draft !== current;

  const apply = () => {
    if (ro.locked) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e: any) {
      setErrorMsg(`JSON 不合法: ${e.message}`);
      return;
    }
    try {
      const report = applyEnvelope(
        getState().project,
        clip.id,
        parsed,
        card,
        { width: project.width, height: project.height },
        {
          setClipCard: (id, cardId) => actions.setClipCard(id, cardId),
          setClipParams: (id, params, opts) => actions.setClipParams(id, params, opts),
          moveClip: (id, patch) => actions.moveClip(id, patch),
          setClipFrame: (id, frame) => actions.setClipFrame(id, frame),
          updateClip: (id, patch) => actions.updateClip(id, patch),
          setClipParts: (id, parts) => actions.setClipParts(id, parts),
        },
        getCard,
      );
      setErrorMsg(null);
      if (report.changed.length) adoptNext.current = true;
      else setDraft(current);
      setApplied(report.changed.length ? `已应用:${report.changed.join(" / ")}` : "没有改动");
      setTimeout(() => setApplied(null), 2000);
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ro.locked) return; // 只读:Tab 照常移焦点,不往草稿里插空格
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      apply();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const val = el.value;
      const nextVal = val.substring(0, start) + "  " + val.substring(end);
      setDraft(nextVal);
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      }, 0);
    }
  };

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const handleReset = () => {
    if (ro.locked) return;
    // 写回整套默认值,而不是清空成 {} —— 清空会让 clip 退回「靠兜底渲染」的隐式状态,
    // 正是这次要消灭的东西。
    const defaults = { ...(card?.defaults ?? {}) };
    actions.setClipParams(clip.id, defaults, { merge: false });
    setErrorMsg(null);
  };

  const lifecycleLine = describeLifecycle(envelope);

  return (
    <div className="flex-1 min-h-0 flex flex-col p-3">
      <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
        <span className="text-[11px] pc-left-muted" title={ENVELOPE_TITLE}>约定封装</span>
        <button type="button" onClick={handleCopy} className="pc-left-btn">
          {copied ? "✓ 已复制" : "复制"}
        </button>
        <button type="button" onClick={handleReset} className="pc-left-btn" disabled={ro.locked} title={ro.title()}>
          参数重置为默认
        </button>
        {missing.length > 0 && (
          <button
            type="button"
            onClick={handleReset}
            disabled={ro.locked}
            title={ro.locked ? ro.why : `这张卡后来新增了参数,当前 clip 里没有:${missing.join(", ")}。点「参数重置为默认」把它们补齐(会一并丢掉已有的改动)`}
            className="text-[11px] px-2 py-1 bg-amber-950 hover:bg-amber-900 text-amber-400 rounded border border-amber-800"
          >
            缺 {missing.length} 项参数
          </button>
        )}
        {applied && <span className="text-[11px] text-green-500 ml-auto">{applied}</span>}
      </div>

      <div data-pc="code-lifecycle" className="mb-1 shrink-0 text-[10px] pc-left-faint truncate" title={lifecycleLine}>
        {lifecycleLine}
      </div>

      {/*
        frame.local 收哪些键要**常驻**写出来,不能塞进下面那条状态栏 ——
        那一行是 h-4 单行,而且只在「没报错、没未应用改动、不缺参数」时才出现,
        平时根本看不到。而三维那三项没设过的时候 JSON 里压根不出现,
        光看这段 JSON 是不知道它们存在的,这一页偏偏正是给想直接写值的人用的。
      */}
      <div className="mb-2 shrink-0 text-[10px] leading-relaxed pc-left-faint">
        frame.local:x / y / w / h / anchor / scale / rotate,以及三维的{" "}
        <span className="pc-left-muted">rotateX / rotateY / translateZ</span>
        (三维要在「参数」页打开透视相机才有近大远小,否则只是斜切)
      </div>

      <textarea
        data-pc="code-editor"
        value={draft}
        readOnly={ro.locked}
        title={ro.title()}
        onChange={e => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={onKeyDown}
        spellCheck={false}
        className={`pc-left-code flex-1 min-h-0 w-full${errorMsg ? " is-error" : ""}`}
      />

      <div data-pc="code-status" className="mt-2 shrink-0 h-4">
        {errorMsg ? (
          <div className="text-[10px] text-red-500 truncate" title={errorMsg}>{errorMsg}</div>
        ) : dirty ? (
          <div className="text-[10px] pc-left-muted">有未应用的修改 · Ctrl+Enter 应用 / 失焦应用</div>
        ) : missing.length > 0 ? (
          <div className="text-[10px] text-amber-500 truncate" title={missing.join(", ")}>
            缺 {missing.length} 项参数,正靠默认值兜底渲染:{missing.join(", ")}
          </div>
        ) : (
          <div className="text-[10px] pc-left-faint">可改:card.id / time / frame.local / blend / parts(组合卡整棵可增删改)/ params;world、motion、lifecycle 只读</div>
        )}
      </div>
    </div>
  );
}

const ENVELOPE_TITLE = "这张卡对外唯一的样子:card(含生命周期)、time、frame(位置)、blend(淡入淡出)、parts(部件树)、params。Agent 的 get_clip / set_clip 看到和改的也是它。";

// 让未使用的类型导入不报 lint(类型只在注释里提到)
export type { ClipEnvelope };
