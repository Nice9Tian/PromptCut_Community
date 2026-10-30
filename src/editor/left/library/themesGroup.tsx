import { useStore, actions } from "../../../store/project";
import { themes, type Theme } from "../../../themes";
import type { GroupData, GroupItem } from "./groups";
import { useReadOnly } from "../../readOnly";

/** 色块卡的高宽比:上面一排色块,下面名字和一句描述 */
const TILE_ASPECT = 0.75;

/** 配色预览:主色占两份,文字 / 玻璃底 / 边线各一份 */
function ThemeSwatch({ th }: { th: Theme }) {
  const accent = th.vars.accent || "#3b82f6";
  const fg = th.vars.fg || "#ffffff";
  const glassBg = th.vars["glass-bg"] || "rgba(255,255,255,0.1)";
  const glassBorder = th.vars["glass-border"] || "rgba(255,255,255,0.2)";
  return (
    <span className="pc-lib-theme-swatch">
      <span className="is-wide" style={{ backgroundColor: accent }} title={`主色: ${accent}`} />
      <span style={{ backgroundColor: fg }} title={`文字: ${fg}`} />
      <span style={{ backgroundColor: glassBg }} title={`玻璃底: ${glassBg}`} />
      <span style={{ backgroundColor: glassBorder }} title={`边线: ${glassBorder}`} />
    </span>
  );
}

function ThemeBody({ th, current }: { th: Theme; current: boolean }) {
  return (
    <span className="pc-lib-theme-body">
      <span className="pc-lib-theme-name">
        <span className="pc-lib-ellipsis">{th.name}</span>
        {current && <span className="pc-lib-tag is-accent">当前</span>}
      </span>
      <span className="pc-lib-theme-desc">{th.description}</span>
    </span>
  );
}

/**
 * 特效 → 全局风格组:主题做成色块卡,点一下切换项目全局主题(setProjectMeta({ themeId })),
 * 当前主题有强调色选中轮廓。
 */
export function useThemesGroup(q: string): GroupData {
  // 这个项目只给了只读权限(游客):换全局主题是写
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

  // 缩略先放当前主题,一眼看到现在用的是哪套
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

  return { items, thumbs, emptyDetail: <div className="pc-left-note">没有匹配的主题</div> };
}
