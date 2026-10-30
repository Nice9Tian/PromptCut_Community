import { useEffect, useRef, useState } from "react";
import { setScript, useScript } from "../../../ai/script";
import { useDockSide } from "../../dock/dockSide";
import { CollapsePanelButton } from "./CollapsePanelButton";
import "./chat.css";

/**
 * 剧本页:rail 上独立的一项(原来是一个弹窗),默认在右侧,也可以拖到左侧。
 *
 * 编辑期间只改本地草稿,点保存才写进 store —— 中途改了一半就被 AI 读走是更糟的体验。
 *
 * 页面常驻挂载(不在前台时 display:none),所以没有「每次打开都从 store 取最新」那一刻,
 * 改成:手上没有没保存的修改时,store 一变(AI 在上一轮里改过剧本)草稿直接跟上;
 * 有没保存的修改就不动它,只提示一句,由用户决定保存覆盖还是撤销换成新的那一版。
 */
export function ScriptPage(props: { active: boolean }) {
  const { active } = props;
  const side = useDockSide("right");
  const saved = useScript();
  const [draft, setDraft] = useState(saved);
  /** 草稿是从哪一版改起的。和草稿相同 = 用户没动过 */
  const [base, setBase] = useState(saved);
  const [justSaved, setJustSaved] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== base;
  /** 用户在改的这段时间里,store 里的剧本被别处(AI)换掉了 */
  const stale = saved !== base;

  useEffect(() => {
    if (saved === base || dirty) return;
    setDraft(saved);
    setBase(saved);
    // 只跟 store 走;dirty / base 在这一刻读到的就是最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  // 从别的页切过来时把焦点放进编辑区。首次挂载不抢焦点:刷新回来正好停在剧本页时,焦点该留在原处
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) textRef.current?.focus();
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const save = () => {
    setScript(draft);
    setBase(draft);
    setJustSaved(true);
  };
  const revert = () => {
    setDraft(saved);
    setBase(saved);
  };

  return (
    <section className="pc-script-page" data-pc="script-page" aria-label="剧本" style={{ display: active ? undefined : "none" }}>
      {/* 顶栏和助手分页的 ChatHeader 同高、同内边距:切页时「收起面板」停在同一个位置。
          收起钮跟着所在一侧走:在右侧放最左边,在左侧放最右边 */}
      <div className={`pc-script-head${side === "left" ? " is-left" : ""}`}>
        <CollapsePanelButton placement="start" />
        <span className="pc-section-title">剧本</span>
        <span className="pc-script-count">{draft.length} 字</span>
        <CollapsePanelButton placement="end" />
      </div>
      <div className="pc-script-body">
        <p className="pc-script-hint">
          写清这条片子要讲什么、按什么顺序讲。它会<b>每一轮</b>都附在 AI 的系统提示里，
          用来把多轮执行拉回主线；留空就不附加。
        </p>
        {stale && dirty && (
          <div className="pc-script-note" role="status">
            剧本刚被 AI 改过。保存会用你手上这一版覆盖它;点「撤销修改」换成新的那一版。
          </div>
        )}
        <textarea
          ref={textRef}
          className="pc-script-text"
          data-pc="script-text"
          aria-label="剧本内容"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter 保存,和别处的输入框一致
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (dirty) save();
            }
          }}
          spellCheck={false}
          placeholder={"例：\n1. 开场 5 秒讲清痛点，用金句卡\n2. 中段按「问题 → 数据 → 方案」推进，数据段配趋势图\n3. 结尾回扣开头那句话"}
        />
        <div className="pc-script-actions">
          {justSaved && <span className="pc-script-saved" role="status">已保存</span>}
          <button type="button" className="pc-script-btn" disabled={!draft} onClick={() => setDraft("")}>清空</button>
          <button type="button" className="pc-script-btn" disabled={!dirty} onClick={revert}>撤销修改</button>
          <button type="button" className="pc-btn-primary pc-script-save" data-pc="script-save" disabled={!dirty} title="Ctrl+Enter" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </section>
  );
}
