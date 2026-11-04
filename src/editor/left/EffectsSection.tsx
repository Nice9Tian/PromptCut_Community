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
import { tr } from "../../i18n/index.ts";

/**
 * The "Effects" section: search → category pills (All / Visual / Audio) → transitions, filters, emphasis, global style, audio effects, audio presets.
 * Visual and audio are no longer split into two tabs; the category pills do the filtering. Result notices for each group's actions all go through the notice bar at the bottom of the section.
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
      <SectionHead title={tr("Effects")}>
        <SearchBox value={search} onChange={setSearch} placeholder={tr("Search effects…")} dataPc="effects-search" />
      </SectionHead>

      <GroupBrowser
        groups={EFFECTS_GROUPS}
        data={data}
        searching={q !== ""}
        openId={openGroup}
        onOpen={setOpenGroup}
        noMatch={tr("No matching effects")}
      />

      <FlashBar msg={msg} />
    </div>
  );
}
