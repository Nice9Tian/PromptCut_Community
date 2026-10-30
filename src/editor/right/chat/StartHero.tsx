import { useEffect, useState } from "react";
import { commitDraft, useAgentTabs } from "../../../ai/agentTabs";
import { useReadOnly } from "../../readOnly";
import "./startHero.css";

/**
 * AI 栏的「开始页」(2026-10-22 用户定,`workflow/editing.md`「AI 栏的 Agent 标签」):本项目一个 Agent 会话都没有时,
 * 那一页占位页(`agentTabs` 的 `draft`)显示它,而不是消息列表。页面下半部分还是平常的输入框(Composer),
 * 这里只负责消息区那一块:一句话说明 + 一个预设按钮。
 *
 *   - 刚进项目、本项目没被用户手动关光过会话:带引导动画(呼吸的光点 + 指向输入框的箭头,输入框描边脉动);
 *   - 用户手动关光过会话:不放动画,只有预设和输入框;
 *   - 点预设:把预设那句话放进输入框,发送按钮闪一下,引导用户点发送(两种情况都这样);
 *   - 用户点发送:占位页才变成第一个真会话(`commitDraft`),在这之前不建会话、不发请求。
 *
 * `prefers-reduced-motion` 下动画都关掉,只留静态描边。
 */
export const START_PRESET = "做一个动画告诉我使用软件可以干什么";

export type StartGuide = "input" | "send" | null;

/**
 * 面板(本机 AiPanel / 云端 CloudAiPanel)里和开始页有关的状态:
 * 这一页是不是开始页、要不要放引导动画、输入框和发送按钮此刻该引导哪一个、点预设和点发送时各做什么。
 */
export function useStartPage(tabId: string, inputText: string, setInputText: (v: string | ((prev: string) => string)) => void, focus?: () => void, hasMessages = false) {
  const { tabs, cleared } = useAgentTabs();
  const draft = tabs.find((t) => t.id === tabId)?.draft === true;
  // 这一页里已经有对话了(从历史列表点开了一段旧对话、点了「接上看看」之类,不是点发送):它就已经是个会话,占位页变真页,免得对话被开始页盖住
  useEffect(() => { if (draft && hasMessages) commitDraft(tabId); }, [draft, hasMessages, tabId]);
  const animated = draft && !cleared;
  const [picked, setPicked] = useState(false);
  const has = inputText.trim().length > 0;
  // 输入框清空了就不再催发送(预设那一下的提示失效)
  useEffect(() => { if (!has) setPicked(false); }, [has]);
  const guide: StartGuide = !draft ? null : has ? (picked || animated ? "send" : null) : animated ? "input" : null;
  return {
    draft,
    animated,
    guide,
    /** 点预设:放进输入框(框里已经有这句就不重复加),并催发送 */
    pickPreset: () => {
      setInputText((prev) => (prev.includes(START_PRESET) ? prev : prev.trim() ? `${prev.replace(/\s+$/, "")}\n${START_PRESET}` : START_PRESET));
      setPicked(true);
      focus?.();
    },
    /** 点发送、真要发了:占位页变成第一个会话。不是开始页时什么都不做 */
    commit: () => { if (draft) commitDraft(tabId); },
  };
}

export function StartHero(props: { animated: boolean; onPickPreset: () => void }) {
  // 这个项目只给了只读权限(游客):不能给 Agent 发话,不放「在下面输入」的引导动画和预设,只说明为什么
  const ro = useReadOnly();
  const { onPickPreset } = props;
  const animated = props.animated && !ro.locked;
  if (ro.locked) {
    return (
      <div className="ai-messages pc-start" data-pc="ai-start" data-pc-start-animated="0" data-pc-readonly="1">
        <div className="pc-start-title">只能查看</div>
        <div className="pc-start-hint">{ro.why}</div>
        <button type="button" className="pc-start-preset" data-pc="ai-start-preset" disabled title={ro.why}>
          {START_PRESET}
        </button>
      </div>
    );
  }
  return (
    <div className={`ai-messages pc-start${animated ? " is-animated" : ""}`} data-pc="ai-start" data-pc-start-animated={animated ? "1" : "0"}>
      {animated && (
        <div className="pc-start-orb" data-pc="ai-start-orb" aria-hidden="true">
          <span className="pc-start-orb-ring" />
          <span className="pc-start-orb-ring pc-start-orb-ring--2" />
          <span className="pc-start-orb-core">✦</span>
        </div>
      )}
      <div className="pc-start-title">{animated ? "从这里开始" : "开始"}</div>
      <div className="pc-start-hint">
        {animated ? "在下面的输入框里写下你想做的片子,或者点这一句:" : "在下面的输入框里写下你想做的,或者点这一句:"}
      </div>
      <button type="button" className="pc-start-preset" data-pc="ai-start-preset" onClick={onPickPreset}>
        {START_PRESET}
      </button>
      {animated && <div className="pc-start-cue" data-pc="ai-start-cue" aria-hidden="true">⌄</div>}
    </div>
  );
}
