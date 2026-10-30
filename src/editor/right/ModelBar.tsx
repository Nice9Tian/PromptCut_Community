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

/**
 * 输入区底部工具条上的一组:模型下拉 + 「⋯」运行选项(推理强度 / 加速 / 深度自主 / 参数兼容)。
 *
 * 这几样都是「这一次要怎么跑」,所以贴着输入框放,不进 AI 设置 —— 设置里管的是
 * 「有哪些可选」,这里管的是「现在用哪个」。选择按 provider 分开记在本地,
 * 从 Claude 切到 Codex 不会把对面不存在的模型名带过去。
 *
 * 模型常换,留在工具条上;其余几样不常动,收进「⋯」弹层,有非默认值时按钮上挂个点。
 * 两块读写同一份 choice,所以写在同一个组件里,渲染成工具条上的两个兄弟节点。
 *
 * 某一家不支持的就灰掉并说明原因,不做点了没反应的假开关:
 * 加速只有 Claude Code 有(设置项 fastMode),推理强度 API 直连还没接。
 */
export function ModelBar(props: {
  provider: AiProvider | null;
  config: PublicAiConfig | null;
  disabled?: boolean;
  /** 这一页的 id:创造力等级按页存(不传 = 主页) */
  tabId?: string;
}): JSX.Element | null {
  const { provider, config, disabled } = props;
  const tabId = props.tabId ?? MAIN_TAB;
  /*
   * 创造力等级(user-workflow.md「创造力等级」):这个对话默认跟项目,可以单独改。
   * 覆盖值存在本机页签里(agentTabs.ts),随每条消息带给服务端,服务端的闸门按它判越级调用。
   * 和模型、思考档不同,它按页存、不按驱动存:换驱动不改变这个对话能改到多深。
   */
  const { tabs } = useAgentTabs();
  const tabCreativity = tabs.find((t) => t.id === tabId)?.creativity ?? null;
  const projectLevel = useStore((s) => projectCreativity(s.project));
  const [choice, setChoice] = useState(() => ({ model: "", effort: "" as EffortLevel, fast: false, deepAuto: false, schemaCompat: "auto" as SchemaCompat }));
  const pop = usePopover();

  // 换 provider 就把那一家自己的选择读出来
  useEffect(() => {
    if (provider) setChoice(readChoice(provider));
  }, [provider]);

  if (!provider) return null;
  const cap = capabilityOf(provider);

  // 和 useAiChat 发请求时用的是同一个函数 —— 下拉框显示什么,请求里就得是什么
  const models = modelsFor(provider, config);

  /*
   * 设置里把某个模型删掉之后,别再拿一个已经不存在的名字去跑。
   * agy 还要多一道:清单已经折成基名了(见 agyGroups),而 localStorage 里可能存着
   * 早先那种带 -low 后缀的写法 —— 先折回基名再对清单,否则用户明明选过,
   * 下拉框却显示成「默认」。
   */
  const paired = pairModelEffort(provider, choice.model, choice.effort, config);
  const model = normalizeModel(paired.model, models);

  /*
   * 这个模型支持哪几档思考。agy 是**按模型算**的:gemini-3.1-pro 只有低 / 高(没有中),
   * claude-sonnet-4-6 一档都没有。别的驱动还是各家那张固定表。
   */
  const efforts = effortsFor(provider, model, config);
  /*
   * 存着的档位这个模型没有时,下拉框直接显示实际会发出去的那一档,别让屏幕和请求对不上。
   *
   * 认不出来时降级成 `""`(默认),**不能回退到存着的那个值** —— 原来没选模型时就是那样,
   * 于是浏览器里存的旧档位照样发出去。用户诊断报告里那个 400 就有这一层:
   * codex 的清单里去掉了 `minimal`,可存着 `minimal` 的人没选模型时还是会把它发出去。
   * 清单里没有的值一律不发,让上游用自己的默认 —— 宁可少一档,不要发一个必然被拒的值。
   */
  const effort = efforts.includes(choice.effort) ? choice.effort
    // paired.effort 也可能是清单里没有的(存着 codex 的 minimal 之类),
    // 受控 select 的 value 找不到对应 option 时 selectedIndex 变 -1,框里**显示空白**
    : (model && efforts.includes(paired.effort) ? paired.effort : "");

  const update = (patch: Partial<typeof choice>) => {
    writeChoice(provider, patch);
    setChoice((prev) => ({ ...prev, ...patch }));
  };

  // 参数兼容:Claude / GPT 锁关、Gemini 锁开,别家让用户点
  const compat = compatPolicy(provider, model, config?.api?.vendor, choice.schemaCompat);
  const compatHint = compat.locked
    ? compat.reason
    : `参数兼容模式(${compat.on ? "开" : "关"}):把工具参数的 schema 按 Gemini 那套最窄子集清洗。${compat.reason}`;

  /*
   * 深度自主:轮次上限换成设置里的「自主轮次」(默认 300,填 0 就是不限),
   * 并且不再往模型手里塞任何关于轮次的话。
   *
   * 每家驱动都支持 —— 这道闸是 PromptCut 自己的循环在管的,不是各家 CLI 的能力,
   * 所以不进 CAPABILITIES,也不会因为换了驱动就灰掉。
   */
  const rounds = config?.deepAutoRounds;
  const deepHint = choice.deepAuto
    ? (rounds === 0
        ? "深度自主：不限轮次，会一直跑到它自己认为做完或你点停止。想改成有限轮次去「AI 设置 → 更多 → 自主轮次」"
        : `深度自主：轮次上限放宽到 ${rounds ?? 300} 轮，且不给模型任何轮次提示。在「AI 设置 → 更多 → 自主轮次」里改`)
    : `深度自主：把轮次上限放宽到 ${rounds === 0 ? "不限" : `${rounds ?? 300} 轮`}，并且不给模型任何轮次提示。常规上限是用来拦住跑偏的运行的，长任务再开`;

  const fastHint = cap.fast
    ? "加速：出字更快，不换模型"
    : provider === "codex" ? "Codex 没有加速档"
      : provider === "agy" ? "Antigravity 没有加速档"
      : "API 直连没有加速档";

  // 「⋯」收起来之后看不见里面开了什么:思考档、加速、深度自主有一样不是默认,按钮上就挂个点
  const tuned = effort !== "" || (cap.fast && choice.fast) || choice.deepAuto || tabCreativity !== null;
  const creativityNow: CreativityLevel = tabCreativity ?? projectLevel;
  const optionsTitle = [
    "运行选项",
    `思考 ${EFFORT_LABEL[effort] ?? effort}`,
    `创造力 ${CREATIVITY_LABEL[creativityNow]}${tabCreativity ? "" : "(跟项目)"}`,
    cap.fast && choice.fast ? "Fast" : "",
    choice.deepAuto ? "深度自主" : "",
    compat.applies && compat.on ? "参数兼容" : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <select
        className="ai-bar-select ai-model-select"
        data-pc="ai-model"
        aria-label="模型"
        value={model}
        disabled={disabled || models.length === 0}
        title={models.length === 0 ? `还没配可选模型：${cap.modelsHint}` : `这次用哪个模型${model ? `:${model}` : ""}`}
        onChange={(e) => update({ model: e.target.value })}
      >
        <option value="">默认</option>
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
          aria-label="运行选项"
          title={optionsTitle}
          onClick={pop.toggle}
        >
          <IconMore size={16} />
          {tuned && <i className="ai-bar-dot" aria-hidden="true" />}
        </button>
        <div className="ai-pop ai-modelbar" role="group" aria-label="运行选项" data-pop style={{ display: pop.open ? undefined : "none" }}>
          <label className="ai-modelbar-item">
            <span className="ai-modelbar-label">思考强度</span>
            <select
              className="ai-modelbar-select"
              value={effort}
              disabled={disabled || efforts.length === 0}
              title={
                efforts.length === 0
                  ? (provider === "agy" ? `${model} 不支持调思考档` : "API 直连这边还没接推理强度")
                  : provider === "agy" && model
                    ? `推理强度：越高想得越久。agy 把档位编在模型名里，这里选好就会发 --model ${model} --effort <档>`
                    : "推理强度：越高想得越久"
              }
              onChange={(e) => update({ effort: e.target.value as EffortLevel })}
            >
              {efforts.length === 0
                ? <option value="">不支持</option>
                : efforts.map((lv) => (
                    <option key={lv} value={lv}>{EFFORT_LABEL[lv]}</option>
                  ))}
            </select>
          </label>

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
              {CREATIVITY_LEVELS.map((lv) => (
                <option key={lv} value={lv}>{CREATIVITY_LABEL[lv]}</option>
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
              深度自主
            </button>

            {/* 这条路上这个开关不经手(比如 agy 走 MCP,压根不过 sanitizeSchema)就别显示 ——
                摆一个按下去什么也不会发生的按钮,比没有这个按钮更误导 */}
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
                参数兼容
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
