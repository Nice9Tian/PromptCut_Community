import { useEffect, useRef, useState } from "react";
import {
  ALL_GROUPS, GROUP_LABEL, readVisibility, writeVisibility,
  type BaseGroup, type CardVisibility,
} from "../cardScope";
import { tr } from "../../i18n/index.ts";

/**
 * The row of filter buttons in the "Animations" section's "card filter" popover: **Basic / Custom / Project**.
 *
 * These three buttons correspond to the three source tiers of cards (see editor/cardScope.ts):
 *   Basic   the three built-in groups (built-in library / third-party / Lottie·particles), shipped with the package, always present
 *   Custom  custom cards marked "shared", visible across projects
 *   Project custom cards that belong only to the current project
 *
 * The "Basic" button can also open a small panel to toggle the three groups under it individually, e.g.
 * "this video uses only the built-in library".
 * Whichever tier you turn off, **it takes effect on both the card library and the Agent's list_cards**: the
 * panel is for people, but what the Agent sees is the real problem this whole thing is meant to solve
 * (custom cards leaking over from the previous project).
 */
export function CardScopeBar({ onChange }: { onChange: (v: CardVisibility) => void }) {
  const [v, setV] = useState<CardVisibility>(() => readVisibility());
  const [groupsOpen, setGroupsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const apply = (next: CardVisibility) => {
    setV(next);
    writeVisibility(next);
    onChange(next);
  };

  // Clicking outside the panel closes it: a small popover like this would block the cards below if it stayed open
  useEffect(() => {
    if (!groupsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setGroupsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [groupsOpen]);

  const enabledGroups = ALL_GROUPS.filter((g) => v.groups[g] !== false).length;

  const chip = (on: boolean) => `pc-lib-scope-chip${on ? " is-on" : ""}`;

  return (
    <div ref={wrapRef} className="pc-lib-scope" data-pc="card-scope-bar">
      <button
        type="button"
        data-pc="scope-base"
        className={chip(v.base)}
        aria-pressed={v.base}
        title={v.base ? tr("Base media: on ({0}/3 groups). Click again to turn off; right-click or long-press to pick groups", enabledGroups) : tr("Base media: off")}
        onClick={() => apply({ ...v, base: !v.base })}
        onContextMenu={(e) => { e.preventDefault(); setGroupsOpen((o) => !o); }}
      >
        {tr("Base{0}", v.base && enabledGroups < ALL_GROUPS.length ? ` ${enabledGroups}/3` : "")}
      </button>

      {/* The group toggles are hidden behind a small triangle: the three groups are not frequently used toggles and shouldn't take up space normally */}
      <button
        type="button"
        data-pc="scope-groups"
        className="pc-lib-scope-caret"
        aria-expanded={groupsOpen}
        title={tr("Choose which groups of base media to show")}
        onClick={() => setGroupsOpen((o) => !o)}
      >
        ▾
      </button>

      <button
        type="button"
        data-pc="scope-custom"
        className={chip(v.custom)}
        aria-pressed={v.custom}
        title={tr("Custom media: custom cards marked as shared, visible across projects")}
        onClick={() => apply({ ...v, custom: !v.custom })}
      >
        {tr("Custom")}
      </button>

      <button
        type="button"
        data-pc="scope-project"
        className={chip(v.project)}
        aria-pressed={v.project}
        title={tr("Project media: custom cards that belong only to the current project")}
        onClick={() => apply({ ...v, project: !v.project })}
      >
        {tr("Project")}
      </button>

      {groupsOpen && (
        <div className="pc-lib-scope-panel" data-pc="scope-groups-panel">
          <div className="pc-lib-scope-panel-title">{tr("Base media groups to show")}</div>
          {ALL_GROUPS.map((g: BaseGroup) => (
            <label key={g} className="pc-lib-scope-option">
              <input
                type="checkbox"
                checked={v.groups[g] !== false}
                onChange={(e) => apply({ ...v, groups: { ...v.groups, [g]: e.target.checked } })}
              />
              {GROUP_LABEL[g]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
