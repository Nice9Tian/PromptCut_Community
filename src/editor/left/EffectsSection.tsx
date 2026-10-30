import { useState } from "react";
import { SearchBox } from "./SearchBox";
import { SectionHead } from "./SectionHead";
import { FlashBar, useFlash } from "./useFlash";
import { useOpenGroup } from "./stored";
import { EFFECTS_GROUPS, EFFECTS_GROUP_IDS, type GroupData } from "./library/groups";
import { GroupBrowser } from "./library/GroupBrowser";
import { useTransitionsGroup } from "./library/transitionsGroup";
import { useFiltersGroup } from "./library/filtersGroup";
import { useEmphasisGroup } from "./library/emphasisGroup";
import { useThemesGroup } from "./library/themesGroup";
import { useAudioFxGroup, useAudioPresetsGroup } from "./library/audioFxGroups";

/**
 * 「特效」分区:搜索 → 分类胶囊(所有 / 视觉 / 音频)→ 转场、滤镜、强调、全局风格、音频效果、音频预设。
 * 视觉和音频不再分两页,靠分类胶囊筛。各组操作的结果提示统一走分区底部的提示条。
 */
export function EffectsSection() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const [openGroup, setOpenGroup] = useOpenGroup("effects", EFFECTS_GROUP_IDS);
  const [msg, flash] = useFlash();

  const transitions = useTransitionsGroup(q, flash);
  const filters = useFiltersGroup(q, flash);
  const emphasis = useEmphasisGroup(q, flash);
  const themes = useThemesGroup(q);
  const audiofx = useAudioFxGroup(q, flash);
  const audioPresets = useAudioPresetsGroup(q, flash);

  const data: Record<string, GroupData> = {
    transitions,
    filters,
    emphasis,
    themes,
    audiofx,
    "audio-presets": audioPresets,
  };

  return (
    <div data-pc="effects" className="pc-left-section">
      <SectionHead title="特效">
        <SearchBox value={search} onChange={setSearch} placeholder="搜索特效…" dataPc="effects-search" />
      </SectionHead>

      <GroupBrowser
        groups={EFFECTS_GROUPS}
        data={data}
        searching={q !== ""}
        openId={openGroup}
        onOpen={setOpenGroup}
        noMatch="没有匹配的特效"
      />

      <FlashBar msg={msg} />
    </div>
  );
}
