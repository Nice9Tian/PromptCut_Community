import type { JSX } from "react";
import type { CloudInfo } from "../../ai/chatTypes";
import { setTabCreativity, useAgentTabs } from "../../ai/agentTabs";
import { MAIN_TAB } from "../../ai/liveChat";
import { useStore } from "../../store/project";
import { CREATIVITY_HINT, CREATIVITY_LABEL, CREATIVITY_LEVELS, normalizeCreativity, projectCreativity } from "../../kernel/creativity.mjs";
import { IconMore } from "../../ui/icons";
import { EFFORT_LABEL, type EffortLevel } from "../../ai/modelOptions";
import { usePopover } from "./chat/usePopover";
import "./ModelBar.css";

/** 「云端」下深度自主与审查环路为什么不可选(契约 9.3,2026-10-06 主会话裁定) */
export const CLOUD_NO_DEEP_AUTO = "云端 Agent 暂不支持深度自主与审查环路:云端用的是托管方的模型额度,目前没有上限";

/**
 * 「云端」接入方式下输入区底部工具条上的一组:模型下拉(托管方配置了多个模型才出现)+ 思考强度下拉(云端报了档位才出现)
 * +「⋯」运行选项(创造力,以及置灰的深度自主)。
 * 与本机的 `ModelBar` 同一套样式;加速、参数兼容这些是本机各驱动自己的,云端没有。
 */
export function CloudModelBar(props: {
  info: CloudInfo | null;
  model: string;
  onModel: (m: string) => void;
  effort?: string;
  onEffort?: (e: string) => void;
  disabled?: boolean;
  tabId?: string;
}): JSX.Element {
  const { info, model, onModel, disabled } = props;
  const tabId = props.tabId ?? MAIN_TAB;
  const { tabs } = useAgentTabs();
  const tabCreativity = tabs.find((t) => t.id === tabId)?.creativity ?? null;
  const projectLevel = useStore((s) => projectCreativity(s.project));
  const creativityNow = tabCreativity ?? projectLevel;
  const pop = usePopover();
  const models = info?.models ?? [];
  const shown = model && models.some((m) => m.id === model) ? model : "";
  const efforts = props.onEffort ? info?.efforts ?? [] : [];
  const effortShown = props.effort && efforts.includes(props.effort) ? props.effort : "";
  const effortLabel = (e: string) => EFFORT_LABEL[e as EffortLevel] ?? e;
  return (
    <>
      {models.length > 1 && (
        <select
          className="ai-bar-select ai-model-select"
          data-pc="ai-cloud-model"
          aria-label="模型"
          value={shown}
          disabled={disabled}
          title={`云端这次用哪个模型${shown ? `:${shown}` : ""}`}
          onChange={(e) => onModel(e.target.value)}
        >
          <option value="">默认{info?.defaultModel ? `(${info.defaultModel})` : ""}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
        </select>
      )}
      {efforts.length > 0 && (
        <select
          className="ai-bar-select"
          data-pc="ai-cloud-effort"
          aria-label="思考强度"
          value={effortShown}
          disabled={disabled}
          title={`思考强度:越高想得越久、用的额度越多 · ${effortLabel(effortShown)}`}
          onChange={(e) => props.onEffort?.(e.target.value)}
        >
          <option value="">思考 {EFFORT_LABEL[""]}</option>
          {efforts.map((e) => <option key={e} value={e}>思考 {effortLabel(e)}</option>)}
        </select>
      )}
      <div className="ai-pop-anchor" ref={pop.anchorRef}>
        <button
          type="button"
          className="pc-icon-btn ai-bar-btn"
          data-pc="ai-run-options"
          aria-haspopup="true"
          aria-expanded={pop.open}
          aria-label="运行选项"
          title={`运行选项 · 创造力 ${CREATIVITY_LABEL[creativityNow]}${tabCreativity ? "" : "(跟项目)"}`}
          onClick={pop.toggle}
        >
          <IconMore size={16} />
          {tabCreativity !== null && <i className="ai-bar-dot" aria-hidden="true" />}
        </button>
        <div className="ai-pop ai-modelbar" role="group" aria-label="运行选项" data-pop style={{ display: pop.open ? undefined : "none" }}>
          <label className="ai-modelbar-item">
            <span className="ai-modelbar-label">创造力</span>
            <select
              className="ai-modelbar-select"
              data-pc="ai-creativity"
              value={tabCreativity ?? ""}
              disabled={disabled}
              title={`创造力等级「${CREATIVITY_LABEL[creativityNow]}」:${CREATIVITY_HINT[creativityNow]}。只管这个对话;项目的默认等级在项目设置里改`}
              onChange={(e) => setTabCreativity(tabId, normalizeCreativity(e.target.value))}
            >
              <option value="">跟项目({CREATIVITY_LABEL[projectLevel]})</option>
              {CREATIVITY_LEVELS.map((lv) => <option key={lv} value={lv}>{CREATIVITY_LABEL[lv]}</option>)}
            </select>
          </label>
          <div className="ai-modelbar-toggles">
            <button type="button" data-pc="deep-auto" className="ai-modelbar-fast" disabled title={CLOUD_NO_DEEP_AUTO} aria-pressed={false}>
              深度自主
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
