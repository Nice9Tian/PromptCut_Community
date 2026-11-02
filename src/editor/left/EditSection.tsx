import { useState } from "react";
import { Inspector } from "./Inspector";
import { NodeGraphTab } from "../nodes/NodeGraphTab";
import { readStored, writeStored } from "./stored";
import { SectionHead } from "./SectionHead";
import { SoundGenerationControls } from "./SoundEffectForm";
import { ReadOnlyFence } from "../ReadOnlyFence";
import { tr } from "../../i18n/index.ts";

type EditTab = "form" | "code" | "nodes";

const EDIT_TABS: { key: EditTab; label: string }[] = [
  { key: "form", label: tr("Parameters") },
  { key: "code", label: tr("code") },
  { key: "nodes", label: tr("Nodes") },
];
const EDIT_TAB_KEYS = EDIT_TABS.map((t) => t.key);
const EDIT_TAB_STORE = "pc.left.editTab";

/**
 * 「编辑」分区:胶囊分页 参数 / 代码 / 节点(记在 pc.left.editTab)。
 * 参数、代码是 Inspector(它在内部把两页都常驻挂着,切过去不丢代码框里没提交的草稿);节点是 NodeGraphTab。
 * 三页都常驻挂载,只用行内 display 显隐。
 */
export function EditSection() {
  const [tab, setTab] = useState<EditTab>(() => readStored(EDIT_TAB_STORE, EDIT_TAB_KEYS, "form"));
  const pick = (next: EditTab) => {
    setTab(next);
    writeStored(EDIT_TAB_STORE, next);
  };

  return (
    <div data-pc="inspector" className="pc-left-section">
      <SectionHead title={tr("Edit")}>
        <div className="pc-lib-chips" role="tablist" aria-label={tr("Edit tabs")}>
          {EDIT_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              data-pc-tab={t.key}
              className={`pc-chip${tab === t.key ? " is-on" : ""}`}
              onClick={() => pick(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </SectionHead>

      <ReadOnlyFence><SoundGenerationControls /></ReadOnlyFence>
      <div className="pc-left-pane" style={{ display: tab === "nodes" ? "none" : "flex" }}>
        <Inspector tab={tab === "code" ? "code" : "form"} />
      </div>
      <div className="pc-left-pane" style={{ display: tab === "nodes" ? "flex" : "none" }}>
        <NodeGraphTab />
      </div>
    </div>
  );
}
