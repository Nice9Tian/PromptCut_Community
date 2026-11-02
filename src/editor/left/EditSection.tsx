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
  { key: "code", label: tr("Code") },
  { key: "nodes", label: tr("Nodes") },
];
const EDIT_TAB_KEYS = EDIT_TABS.map((t) => t.key);
const EDIT_TAB_STORE = "pc.left.editTab";

/**
 * The "Edit" section: pill tabs Parameters / Code / Nodes (remembered in pc.left.editTab).
 * Parameters and Code are the Inspector (internally it keeps both tabs mounted, so switching away doesn't lose uncommitted drafts in the code box); Nodes is NodeGraphTab.
 * All three tabs stay mounted and are shown or hidden only with inline display.
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
