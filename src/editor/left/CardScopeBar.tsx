import { useEffect, useRef, useState } from "react";
import {
  ALL_GROUPS, GROUP_LABEL, readVisibility, writeVisibility,
  type BaseGroup, type CardVisibility,
} from "../cardScope";
import { tr } from "../../i18n/index.ts";

/**
 * 「动画」分区「卡片筛选」浮层里那一行筛选钮:**基础 / 自定义 / 项目**。
 *
 * 这三个钮对应卡片的三档来源(见 editor/cardScope.ts):
 *   基础   内置的三组(自家库 / 第三方 / Lottie·粒子),随包发,永远在
 *   自定义 标了「共享」的定制卡,跨项目可见
 *   项目   只属于当前项目的定制卡
 *
 * 「基础」这一钮还能点开一个小面板,单独开关它下面那三组 —— 比如「这条片子只用自家库」。
 * 关掉哪一档,**卡库和 Agent 的 list_cards 同时生效**:面板是给人看的,
 * 而 Agent 看到什么才是这套东西真正要解决的问题(定制卡从上个项目串过来)。
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

  // 点面板外面就收起来:这种小浮层不收会挡住下面的卡
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

      {/* 分组开关藏在一个小三角里:三组不是常用开关,平时不该占位置 */}
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
