import { useStore, actions } from "../../../store/project";
import { themes, type Theme } from "../../../themes";
import type { GroupData, GroupItem } from "./groups";
import { useReadOnly } from "../../readOnly";
import { tr } from "../../../i18n/index.ts";

/** Aspect ratio of the swatch card: a row of swatches on top, the name and a one-line description below */
const TILE_ASPECT = 0.75;

/** Color scheme preview: the primary color takes two parts; text / glass background / border take one part each */
function ThemeSwatch({ th }: { th: Theme }) {
  const accent = th.vars.accent || "#3b82f6";
  const fg = th.vars.fg || "#ffffff";
  const glassBg = th.vars["glass-bg"] || "rgba(255,255,255,0.1)";
  const glassBorder = th.vars["glass-border"] || "rgba(255,255,255,0.2)";
  return (
    <span className="pc-lib-theme-swatch">
      <span className="is-wide" style={{ backgroundColor: accent }} title={tr("Accent: {0}", accent)} />
      <span style={{ backgroundColor: fg }} title={tr("Text: {0}", fg)} />
      <span style={{ backgroundColor: glassBg }} title={tr("Glass background: {0}", glassBg)} />
      <span style={{ backgroundColor: glassBorder }} title={tr("Border: {0}", glassBorder)} />
    </span>
  );
}

function ThemeBody({ th, current }: { th: Theme; current: boolean }) {
  return (
    <span className="pc-lib-theme-body">
      <span className="pc-lib-theme-name">
        <span className="pc-lib-ellipsis">{th.name}</span>
        {current && <span className="pc-lib-tag is-accent">{tr("Current")}</span>}
      </span>
      <span className="pc-lib-theme-desc">{th.description}</span>
    </span>
  );
}

/**
 * Effects → global style group: themes are made into swatch cards, one click switches the project's
 * global theme (setProjectMeta({ themeId })),
 * and the current theme has an accent-color selection outline.
 */
export function useThemesGroup(q: string): GroupData {
  // This project only has read-only permission (guest): switching the global theme is a write
  const ro = useReadOnly();
  const currentThemeId = useStore((s) => s.project.themeId);
  const hits = themes.filter(
    (th) => !q || th.name.toLowerCase().includes(q) || th.description.toLowerCase().includes(q) || th.id.toLowerCase().includes(q),
  );

  const items: GroupItem[] = hits.map((th) => {
    const current = currentThemeId === th.id;
    return {
      id: th.id,
      aspect: TILE_ASPECT,
      node: (
        <button
          type="button"
          data-pc-theme={th.id}
          className={`pc-lib-theme${current ? " is-on" : ""}`}
          aria-pressed={current}
          disabled={ro.locked}
          title={ro.title(th.description)}
          onClick={() => actions.setProjectMeta({ themeId: th.id })}
        >
          <ThemeSwatch th={th} />
          <ThemeBody th={th} current={current} />
        </button>
      ),
    };
  });

  // Put the current theme first in the thumbnails, so you can see at a glance which one is in use
  const ordered = [...hits].sort((a, b) => Number(b.id === currentThemeId) - Number(a.id === currentThemeId));
  const thumbs: GroupItem[] = ordered.slice(0, 2).map((th) => ({
    id: th.id,
    node: (
      <div className={`pc-lib-theme is-static${currentThemeId === th.id ? " is-on" : ""}`}>
        <ThemeSwatch th={th} />
        <ThemeBody th={th} current={currentThemeId === th.id} />
      </div>
    ),
  }));

  return { items, thumbs, emptyDetail: <div className="pc-left-note">{tr("No matching themes")}</div> };
}
