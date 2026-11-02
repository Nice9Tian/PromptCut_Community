import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { AiProvider, PublicAiConfig } from "../../ai/types";
import {
  capabilityOf,
  EFFORT_LABEL,
  modelsFor,
  effortsFor,
  pairModelEffort,
  readChoice,
  writeChoice,
  normalizeModel,
  compatPolicy,
  type EffortLevel,
  type SchemaCompat,
} from "../../ai/modelOptions";
import { IconMore } from "../../ui/icons";
import { MAIN_TAB } from "../../ai/liveChat";
import { setTabCreativity, useAgentTabs } from "../../ai/agentTabs";
import { useStore } from "../../store/project";
import { CREATIVITY_HINT, CREATIVITY_LABEL, CREATIVITY_LEVELS, normalizeCreativity, projectCreativity, type CreativityLevel } from "../../kernel/creativity.mjs";
import { usePopover } from "./chat/usePopover";
import "./ModelBar.css";
import { tr } from "../../i18n/index.ts";

/**
 * The group on the toolbar at the bottom of the input area: model dropdown + the "⋯" run options (reasoning
 * effort / acceleration / deep autonomy / parameter compatibility).
 *
 * All of these are "how to run this time", so they sit next to the input box and are not in the AI
 * settings: settings manage "what is available to choose", and this manages "which one to use now". The
 * choice is stored locally per provider, so switching from Claude to Codex does not carry over a model name
 * that does not exist on the other side.
 *
 * Models change often and stay on the toolbar; the rest rarely change and are tucked into the "⋯" popup,
 * with a dot on the button when there is a non-default value. Both parts read and write the same choice,
 * so they are written in one component, rendered as two sibling nodes on the toolbar.
 *
 * If a provider does not support something, grey it out and explain why, with no fake switches that do
 * nothing when clicked: acceleration exists only in Claude Code (setting fastMode), and reasoning effort is
 * not yet wired up for direct API.
 */
export function ModelBar(props: {
  provider: AiProvider | null;
  config: PublicAiConfig | null;
  disabled?: boolean;
  /** The id of this page: the creativity level is stored per page (not passed = home page) */
  tabId?: string;
}): JSX.Element | null {
  const { provider, config, disabled } = props;
  const tabId = props.tabId ?? MAIN_TAB;
  /*
   * Creativity level (user-workflow.md "Creativity level"): this chat follows the project by default and can be
   * changed on its own. The override is stored in the local tab (agentTabs.ts) and sent to the server with every
   * message, and the server's gate uses it to judge out-of-level calls.
   * Unlike the model and thinking tier, it is stored per page, not per driver: switching drivers does not
   * change how deep this chat can edit.
   */
  const { tabs } = useAgentTabs();
  const tabCreativity = tabs.find((t) => t.id === tabId)?.creativity ?? null;
  const projectLevel = useStore((s) => projectCreativity(s.project));
  const [choice, setChoice] = useState(() => ({ model: "", effort: "" as EffortLevel, fast: false, deepAuto: false, schemaCompat: "auto" as SchemaCompat }));
  const pop = usePopover();

  // When the provider changes, read out that provider's own choice
  useEffect(() => {
    if (provider) setChoice(readChoice(provider));
  }, [provider]);

  if (!provider) return null;
  const cap = capabilityOf(provider);

  // The same function useAiChat uses when sending requests: whatever the dropdown shows is what the request must have
  const models = modelsFor(provider, config);

  /*
   * After a model is deleted in settings, do not keep running with a name that no longer exists.
   * agy needs one more step: the manifest has already been folded to base names (see agyGroups), while
   * localStorage may hold the earlier form with a -low suffix: fold back to the base name first and then
   * check against the manifest, otherwise the user clearly chose one but the dropdown shows "Default".
   */
  const paired = pairModelEffort(provider, choice.model, choice.effort, config);
  const model = normalizeModel(paired.model, models);

  /*
   * Which thinking tiers this model supports. For agy it is **computed per model**: gemini-3.1-pro only has
   * low / high (no medium), and claude-sonnet-4-6 has no tier at all. Other drivers still use each vendor's
   * fixed table.
   */
  const efforts = effortsFor(provider, model, config);
  /*
   * When the stored tier does not exist for this model, the dropdown directly shows the tier that will
   * actually be sent, so the screen and the request do not disagree.
   *
   * When it cannot be recognized, downgrade to `""` (default), **do not fall back to the stored value**: that
   * is how it used to work when no model was selected, so the old tier stored in the browser was sent anyway.
   * The 400 in the user's diagnostic report had this layer: `minimal` was removed from codex's manifest, but
   * someone with `minimal` stored would still send it when no model was selected.
   * Any value not in the manifest is never sent, so upstream uses its own default: better to have one tier
   * fewer than to send a value that is bound to be rejected.
   */
  const effort = efforts.includes(choice.effort) ? choice.effort
    // paired.effort may also be something not in the manifest (a stored codex minimal, for example);
    // when a controlled select's value finds no matching option, selectedIndex becomes -1 and the box **shows blank**
    : (model && efforts.includes(paired.effort) ? paired.effort : "");

  const update = (patch: Partial<typeof choice>) => {
    writeChoice(provider, patch);
    setChoice((prev) => ({ ...prev, ...patch }));
  };

  // Parameter compatibility: locked off for Claude / GPT, locked on for Gemini, other vendors let the user click
  const compat = compatPolicy(provider, model, config?.api?.vendor, choice.schemaCompat);
  const compatHint = compat.locked
    ? compat.reason
    : tr("Parameter compatibility mode ({0}): sanitizes tool parameter schemas down to the narrowest Gemini-compatible subset. {1}", compat.on ? tr("on") : tr("off"), compat.reason);

  /*
   * Deep autonomy: the round limit is replaced by the "Autonomy rounds" setting (default 300, 0 means
   * unlimited), and nothing about rounds is stuffed into the model's prompt any more.
   *
   * Every driver supports it: this gate is enforced by PromptCut's own loop, not a capability of each
   * CLI, so it is not in CAPABILITIES and does not get greyed out when the driver changes.
   */
  const rounds = config?.deepAutoRounds;
  const deepHint = choice.deepAuto
    ? (rounds === 0
        ? tr("Deep autonomy: no round limit; it keeps running until it decides it is done or you click stop. To switch to a limited number of rounds, go to \"AI settings → More → Autonomy rounds\"")
        : tr("Deep autonomy: the round limit is raised to {0} rounds, and the model gets no round hints. Change it in \"AI settings → More → Autonomy rounds\"", rounds ?? 300))
    : tr("Deep autonomy: raises the round limit to {0} and gives the model no round hints. The normal limit exists to stop runaway runs; turn this on only for long tasks", rounds === 0 ? tr("unlimited") : tr("{0} rounds", rounds ?? 300));

  const fastHint = cap.fast
    ? tr("Speed-up: faster output, same model")
    : provider === "codex" ? tr("Codex has no speed-up tier")
      : provider === "agy" ? tr("Antigravity has no speed-up tier")
      : tr("Direct API has no speed-up tier");

  // Once "⋯" is collapsed you can't see what is switched on inside: if any of thinking tier, speed-up
  // or deep autonomy is not at its default, the button gets a dot
  const tuned = effort !== "" || (cap.fast && choice.fast) || choice.deepAuto || tabCreativity !== null;
  const creativityNow: CreativityLevel = tabCreativity ?? projectLevel;
  const optionsTitle = [
    tr("Run options"),
    tr("thinking {0}", EFFORT_LABEL[effort] ?? effort),
    tr("Creativity {0}{1}", tr(CREATIVITY_LABEL[creativityNow]), tabCreativity ? "" : tr(" (follows project)")),
    cap.fast && choice.fast ? "Fast" : "",
    choice.deepAuto ? tr("deep autonomy") : "",
    compat.applies && compat.on ? tr("Param compat") : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <select
        className="ai-bar-select ai-model-select"
        data-pc="ai-model"
        aria-label={tr("Model")}
        value={model}
        disabled={disabled || models.length === 0}
        title={models.length === 0 ? tr("No selectable models configured: {0}", cap.modelsHint) : tr("Model for this run{0}", model ? `:${model}` : "")}
        onChange={(e) => update({ model: e.target.value })}
      >
        <option value="">{tr("Default")}</option>
        {models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      <div className="ai-pop-anchor" ref={pop.anchorRef}>
        <button
          type="button"
          className="pc-icon-btn ai-bar-btn"
          data-pc="ai-run-options"
          aria-haspopup="true"
          aria-expanded={pop.open}
          aria-label={tr("Run options")}
          title={optionsTitle}
          onClick={pop.toggle}
        >
          <IconMore size={16} />
          {tuned && <i className="ai-bar-dot" aria-hidden="true" />}
        </button>
        <div className="ai-pop ai-modelbar" role="group" aria-label={tr("Run options")} data-pop style={{ display: pop.open ? undefined : "none" }}>
          <label className="ai-modelbar-item">
            <span className="ai-modelbar-label">{tr("Thinking effort")}</span>
            <select
              className="ai-modelbar-select"
              value={effort}
              disabled={disabled || efforts.length === 0}
              title={
                efforts.length === 0
                  ? (provider === "agy" ? tr("{0} does not support thinking tiers", model) : tr("Direct API does not support reasoning effort yet"))
                  : provider === "agy" && model
                    ? tr("Reasoning effort: higher thinks longer. agy encodes the tier in the model name; once you pick one here, it sends --model {0} --effort <tier>", model)
                    : tr("Reasoning effort: higher thinks longer")
              }
              onChange={(e) => update({ effort: e.target.value as EffortLevel })}
            >
              {efforts.length === 0
                ? <option value="">{tr("Not supported")}</option>
                : efforts.map((lv) => (
                    <option key={lv} value={lv}>{EFFORT_LABEL[lv]}</option>
                  ))}
            </select>
          </label>

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
              {CREATIVITY_LEVELS.map((lv) => (
                <option key={lv} value={lv}>{tr(CREATIVITY_LABEL[lv])}</option>
              ))}
            </select>
          </label>

          <div className="ai-modelbar-toggles">
            <button
              type="button"
              className={`ai-modelbar-fast${choice.fast && cap.fast ? " is-on" : ""}`}
              disabled={disabled || !cap.fast}
              title={fastHint}
              aria-pressed={cap.fast && choice.fast}
              onClick={() => update({ fast: !choice.fast })}
            >
              Fast
            </button>

            <button
              type="button"
              data-pc="deep-auto"
              className={`ai-modelbar-fast${choice.deepAuto ? " is-on" : ""}`}
              disabled={disabled}
              title={deepHint}
              aria-pressed={choice.deepAuto}
              onClick={() => update({ deepAuto: !choice.deepAuto })}
            >
              {tr("Deep autonomy")}
            </button>

            {/* If this switch is not handled on this path (e.g. agy uses MCP and bypasses sanitizeSchema entirely),
                don't show it: having a button where clicking does nothing is more misleading than having no button */}
            {compat.applies && (
              <button
                type="button"
                data-pc="schema-compat"
                className={`ai-modelbar-fast${compat.on ? " is-on" : ""}`}
                disabled={disabled || compat.locked}
                title={compatHint}
                aria-pressed={compat.on}
                onClick={() => update({ schemaCompat: compat.on ? "off" : "on" })}
              >
                {tr("Param compat")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
