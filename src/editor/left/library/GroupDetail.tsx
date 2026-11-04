import { Masonry } from "./Masonry";
import type { GroupCategory, GroupData, GroupDef } from "./groups";
import { tr } from "../../../i18n/index.ts";

/**
 * Pill row at the top when a group is open: `All` (back to the overview), this group's category (back
 * to the overview showing only that category), and the group name pill (selected, with × to close).
 * When the section has only one category ("Animations"), the category pill is the same as "All", and
 * `showCategory={false}` does not draw it.
 */
export function DetailChips({
  def,
  showCategory = true,
  onAll,
  onCategory,
  onClose,
}: {
  def: GroupDef;
  showCategory?: boolean;
  onAll: () => void;
  onCategory: (cat: GroupCategory) => void;
  onClose: () => void;
}) {
  return (
    <div className="pc-lib-chips" role="toolbar" aria-label={tr("Category")}>
      <button type="button" className="pc-chip" data-pc-chip="all" onClick={onAll}>
        {tr("All")}
      </button>
      {showCategory && (
        <button
          type="button"
          className="pc-chip"
          data-pc-chip="category"
          title={tr("Back to the overview, showing only \"{0}\" groups", def.category)}
          onClick={() => onCategory(def.category)}
        >
          {def.category}
        </button>
      )}
      <span className="pc-chip is-on pc-lib-chip-group" data-pc-chip="group">
        <span className="pc-lib-chip-label">{def.title}</span>
        <button
          type="button"
          className="pc-chip-x pc-lib-chip-x"
          data-pc="group-close"
          title={tr("Close this group and go back to the overview")}
          aria-label={tr("Close \"{0}\"", def.title)}
          onClick={onClose}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </span>
    </div>
  );
}

/** Group detail: "N projects" + extra content above + all items laid out in the group's layout as a masonry layout + extra content below */
export function GroupDetail({ def, data, searching }: { def: GroupDef; data: GroupData; searching: boolean }) {
  const n = data.items.length;
  return (
    <div className="pc-lib-detail" data-pc={def.hook} data-pc-open-group={def.id}>
      <div className="pc-lib-count" title={def.hint}>
        {tr("{0} projects", n)}
      </div>
      {data.detailTop}
      {n > 0 ? (
        <Masonry layout={def.layout} items={data.items} />
      ) : (
        data.emptyDetail ?? <div className="pc-left-note">{searching ? tr("No matching items") : tr("This group is still empty")}</div>
      )}
      {data.detailBottom}
    </div>
  );
}
