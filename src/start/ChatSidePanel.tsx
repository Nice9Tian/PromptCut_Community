/**
 * 聊天页右边的拓展栏(用户 2026-10-23 定):标题栏右上角那颗按钮开关它。
 *
 * 段落都能折叠 —— 形式参考用户给的那张 IDE 面板图(分段标题 + 段里一行行),内容按软件里已有的说法来:
 *   1. **画面**:这个项目的真画面(`VibeStage.tsx`,即编辑界面的预览),播放条叠在画面里;段头右上角是「详细编辑」;
 *   2. **这次改动**:用户要求先归档(见下面的 `SHOW_CHANGES`);
 *   2b. **聊天**(用户 2026-10-26 定,issue #4):只在「详细编辑」展开时**新建**出来的一张卡
 *      (`ExtChatPanel.tsx`)。详细编辑要占满整个聊天区(连输入框一起),聊天就搬到这条栏里来;
 *      它吃掉这条栏剩下的高度,上面两段照常摊开。收起详细编辑,这张卡跟着消失。
 *   3. **修改前 / 修改后**:这条对话里带前后画面的改动(Agent 每次建卡、改卡、删卡留下的画面记录,
 *      `src/editor/right/ToolVisual.tsx` 的 `useVisualRecord`,经云端 Agent 服务按当前对话的权限取),选一条切着看。
 *      两个标签的叫法照 `src/editor/right/chat/OpDetailPreview.tsx` 的「修改前」「修改后」。
 *
 * 2026-10-23 接上业务层(`docs/reports/AGENT-claude-vibe-wire.md`)。取不到画面记录时如实写原因,不放占位图。
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import type { ChatMessage } from "../ai/types";
import { actions, useStore } from "../store/project";
import { useVisualRecord, visualIdOf } from "../editor/right/ToolVisual";
import { KIND_LABEL, bareToolName, toolKind } from "../editor/right/chat/iconRuns";
import { partsOf } from "../mobile/agentView";
import { ExtChatPanel } from "./ExtChatPanel";
import { EXT_WIDTH } from "./sideWidth";
import { VibeStage, mmss } from "./VibeStage";
import { WidthGrip } from "./WidthGrip";

/**
 * 「这次改动」那一段先归档,默认不显示 —— **这是用户 2026-10-23 要求的**,
 * 用户给的理由:改动已经显示在每次聊天的气泡里了(Agent 消息下面那一块「Agent 操作」),右边再列一遍是重复。
 * 记录另见 `docs/plan/user-decisions-2026-10-23.md`。接业务层时这一段没有接(它本来就不显示),要加回来先问用户。
 */
const SHOW_CHANGES = false;

function section(key: string, title: string, open: boolean, toggle: () => void, body: JSX.Element, right?: JSX.Element): JSX.Element {
  return (
    // 钩子名带 `sec-`:不带的话「画面」这一段会和里面那颗播放键(`start-ext-play`)撞同一个名字
    <section className="ps-ext-sec" data-pc={`start-ext-sec-${key}`} data-open={open}>
      <div className="ps-card-head">
        <button type="button" className="ps-card-toggle" aria-expanded={open} onClick={toggle}>
          <span className="ps-card-caret" data-open={open} aria-hidden="true">›</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="ps-ext-body">{body}</div>}
    </section>
  );
}

/** 这条对话里留了画面记录的改动(新增 / 删除 / 修改三类),从新到旧 */
interface DiffEntry {
  key: string;
  visualId: string;
  kind: string;
  tool: string;
}
function diffEntries(messages: readonly ChatMessage[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    partsOf(m).forEach((p, i) => {
      if (p.kind !== "tool" || p.ok !== true) return;
      const k = toolKind(p.name);
      if (k !== "add" && k !== "remove" && k !== "edit") return;
      const vid = visualIdOf(p.summary);
      if (vid) out.push({ key: `${m.id}:${i}`, visualId: vid, kind: KIND_LABEL[k], tool: bareToolName(p.name) });
    });
  }
  return out.reverse();
}

function DiffView(props: { entry: DiffEntry }): JSX.Element {
  const { rec, err } = useVisualRecord(props.entry.visualId);
  const [side, setSide] = useState<"before" | "after">("after");
  if (err) return <p className="ps-ext-todo" title={err}>取不到这一步的画面：{err}</p>;
  if (!rec) return <p className="ps-ext-todo">正在取这一步的画面…</p>;
  const before = rec.before?.gif ?? null;
  const after = rec.after?.gif ?? null;
  if (!before && !after) return <p className="ps-ext-todo">这一步只改了参数，没有前后画面。</p>;
  const src = side === "before" ? before : after;
  return (
    <>
      <div className="ps-ext-seg" role="group" aria-label="看改前还是改后">
        {(["before", "after"] as const).map((s) => (
          <button key={s} type="button" className="ps-ext-seg-btn" data-pc={`start-ext-${s}`} aria-pressed={side === s}
            disabled={!(s === "before" ? before : after)} onClick={() => setSide(s)}>
            {s === "before" ? "修改前" : "修改后"}
          </button>
        ))}
      </div>
      <div className="ps-ext-frame ps-ext-frame-img">
        {src ? <img src={src} alt={side === "before" ? "修改前" : "修改后"} /> : <span className="ps-muted">{side === "before" ? "新加的，没有修改前" : "删掉了，没有修改后"}</span>}
        <span className="ps-ext-frame-tag">{side === "before" ? "修改前" : "修改后"}</span>
      </div>
      {rec.diff && rec.diff.length > 0 && (
        <p className="ps-ext-note" title={rec.diff.map((d) => `${d.key}: ${d.from} → ${d.to}`).join("\n")}>
          {rec.diff.slice(0, 3).map((d) => `${d.key}：${d.from} → ${d.to}`).join("；")}
        </p>
      )}
    </>
  );
}

export function ChatSidePanel(props: {
  /** 这条对话的消息:修改前 / 修改后从这里找带画面记录的改动 */
  messages: readonly ChatMessage[];
  /** 「详细编辑」展开着:舞台在那边,这里不再挂第二份 */
  detailOpen: boolean;
  /**
   * 详细编辑展开、这条栏又开着时,在这里新建一块聊天面板(`ExtChatPanel.tsx`);
   * 人把这条栏收了就是 `null`,输入框掉回聊天列底部(用户 2026-10-26 定)。
   */
  chatPanel: { composer: JSX.Element; whyNot: string | null; onBack: () => void } | null;
  onNote: (text: string) => void;
  /** 「画面」段头那颗「详细编辑」:展开占满聊天区的编辑视图(`DetailEdit.tsx`) */
  onDetail: () => void;
  /** 宽度:和左边那栏一样能拖、记在本机 */
  width: number;
  onWidth: (px: number) => void;
  onWidthCommit: (px: number) => void;
  onWidthNudge: (delta: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState({ play: true, changes: true, diff: true });
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const duration = useStore((s) => s.project.duration);
  const diffs = useMemo(() => diffEntries(props.messages), [props.messages]);
  const [picked, setPicked] = useState<string | null>(null);
  const pickedEntry = diffs.find((d) => d.key === picked) ?? diffs[0] ?? null;

  return (
    <aside className="ps-ext" data-pc="start-ext" style={{ flexBasis: `${props.width}px` }}>
      {/* 左边那条缝:平时不画线,鼠标压上来才亮 */}
      <WidthGrip spec={EXT_WIDTH} side="left" width={props.width} label="拓展栏宽度" pc="start-ext-grip"
        onWidth={props.onWidth} onWidthCommit={props.onWidthCommit} onWidthNudge={props.onWidthNudge} />
      {section(
        "play",
        "画面",
        open.play,
        () => setOpen((o) => ({ ...o, play: !o.play })),
        props.detailOpen ? (
          <p className="ps-ext-todo">画面正在「详细编辑」里显示。</p>
        ) : (
          // 播放条叠在画面里(用户 2026-10-23 定):省掉画框下面那一条的高度
          <VibeStage className="ps-ext-frame" pc="start-ext-stage">
            <div className="ps-stage-over">
              <button type="button" className="ps-ext-play" data-pc="start-ext-play" aria-label={playing ? "暂停" : "播放"} onClick={() => actions.togglePlay()}>
                {playing ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
                )}
              </button>
              <div className="ps-ext-transport">
                <input type="range" className="ps-ext-scrub" data-pc="start-ext-scrub" min={0} max={Math.max(0.1, duration)} step={0.05}
                  value={Math.min(t, duration)} aria-label="进度" onPointerDown={() => window.getSelection()?.removeAllRanges()} onChange={(e) => actions.seek(Number(e.target.value))} />
                <span className="ps-ext-time">{mmss(t)} / {mmss(duration)}</span>
              </div>
            </div>
          </VibeStage>
        ),
        // 段头右上角那颗:原来这儿是画框里的全屏键,用户 2026-10-23 换成这个
        <button type="button" className="ps-ext-action" data-pc="start-ext-detail" onClick={props.onDetail}>详细编辑</button>,
      )}

      {SHOW_CHANGES && section("changes", "这次改动", open.changes, () => setOpen((o) => ({ ...o, changes: !o.changes })),
        <p className="ps-ext-todo">（这一段归档了，见文件头）</p>)}

      {section(
        "diff",
        "修改前 / 修改后",
        open.diff,
        () => setOpen((o) => ({ ...o, diff: !o.diff })),
        pickedEntry ? (
          <>
            {diffs.length > 1 && (
              <div className="ps-ext-rows" role="listbox" aria-label="带前后画面的改动">
                {diffs.slice(0, 12).map((d) => (
                  <button key={d.key} type="button" className="ps-ext-row-main" data-pc="start-ext-change" data-picked={d.key === pickedEntry.key || undefined}
                    aria-selected={d.key === pickedEntry.key} onClick={() => setPicked(d.key)}>
                    <span className="ps-ext-row-top"><span className="ps-ext-kind">{d.kind}</span><span className="ps-ext-tool">{d.tool}</span></span>
                  </button>
                ))}
              </div>
            )}
            <DiffView key={pickedEntry.key} entry={pickedEntry} />
          </>
        ) : (
          <p className="ps-ext-todo" data-pc="start-ext-diff-empty">这条对话还没有带前后画面的改动。</p>
        ),
      )}

      {/* 详细编辑展开时新建出来的那一块:摆在最后,吃掉这条栏剩下的高度 */}
      {props.chatPanel && (
        <ExtChatPanel
          messages={props.messages}
          composer={props.chatPanel.composer}
          whyNot={props.chatPanel.whyNot}
          onBack={props.chatPanel.onBack}
        />
      )}
    </aside>
  );
}
