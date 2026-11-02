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
import { tr } from "../../i18n/index.ts";

/** Why deep autonomy and the review loop cannot be selected under "Cloud" (contract 9.3, ruling by the lead session, 2026-10-06) */
export const CLOUD_NO_DEEP_AUTO = tr("Cloud Agent does not support deep autonomy and review loops yet: the cloud uses the host's model quota, which currently has no limit");

/**
 * The group on the toolbar at the bottom of the input area under the "Cloud" connection type: the model
 * dropdown (only shown when the host has configured several models) + the thinking effort dropdown (only
 * shown when the cloud reports tiers) + the "⋯" run options (creativity, and the greyed-out deep autonomy).
 * Same styles as the local `ModelBar`; acceleration and parameter compatibility belong to the local
 * drivers and do not exist in the cloud.
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
          aria-label={tr("Model")}
          value={shown}
          disabled={disabled}
          title={tr("Model the cloud uses this time{0}", shown ? `:${shown}` : "")}
          onChange={(e) => onModel(e.target.value)}
        >
          <option value="">{tr("Default{0}", info?.defaultModel ? `(${info.defaultModel})` : "")}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
        </select>
      )}
      {efforts.length > 0 && (
        <select
          className="ai-bar-select"
          data-pc="ai-cloud-effort"
          aria-label={tr("Thinking effort")}
          value={effortShown}
          disabled={disabled}
          title={tr("Thinking effort: higher means longer thinking and more quota used · {0}", effortLabel(effortShown))}
          onChange={(e) => props.onEffort?.(e.target.value)}
        >
          <option value="">{tr("Thinking {0}", EFFORT_LABEL[""])}</option>
          {efforts.map((e) => <option key={e} value={e}>{tr("Thinking {0}", effortLabel(e))}</option>)}
        </select>
      )}
      <div className="ai-pop-anchor" ref={pop.anchorRef}>
        <button
          type="button"
          className="pc-icon-btn ai-bar-btn"
          data-pc="ai-run-options"
          aria-haspopup="true"
          aria-expanded={pop.open}
          aria-label={tr("Run options")}
          title={tr("Run options · creativity {0}{1}", tr(CREATIVITY_LABEL[creativityNow]), tabCreativity ? "" : tr(" (follows project)"))}
          onClick={pop.toggle}
        >
          <IconMore size={16} />
          {tabCreativity !== null && <i className="ai-bar-dot" aria-hidden="true" />}
        </button>
        <div className="ai-pop ai-modelbar" role="group" aria-label={tr("Run options")} data-pop style={{ display: pop.open ? undefined : "none" }}>
          <label className="ai-modelbar-item">
            <span className="ai-modelbar-label">{tr("Creativity")}</span>
            <select
              className="ai-modelbar-select"
              data-pc="ai-creativity"
              value={tabCreativity ?? ""}
              disabled={disabled}
              title={tr("Creativity level \"{0}\": {1}. Applies to this chat only; change the project's default level in project settings", tr(CREATIVITY_LABEL[creativityNow]), tr(CREATIVITY_HINT[creativityNow]))}
              onChange={(e) => setTabCreativity(tabId, normalizeCreativity(e.target.value))}
            >
              <option value="">{tr("Follow project ({0})", tr(CREATIVITY_LABEL[projectLevel]))}</option>
              {CREATIVITY_LEVELS.map((lv) => <option key={lv} value={lv}>{tr(CREATIVITY_LABEL[lv])}</option>)}
            </select>
          </label>
          <div className="ai-modelbar-toggles">
            <button type="button" data-pc="deep-auto" className="ai-modelbar-fast" disabled title={CLOUD_NO_DEEP_AUTO} aria-pressed={false}>
              {tr("Deep autonomy")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
