import type { GroupLayout } from "./layout";
import type { GroupData, GroupDef } from "./groups";
import { tr } from "../../../i18n/index.ts";

/** How many thumbnails each layout shows in the overview: small_cube shows two rows of four columns, the others show two */
const THUMB_COUNT: Record<GroupLayout, number> = { small_cube: 8, middle_cube: 2, big_16_9: 2, big_strip: 2 };

/**
 * A group box in the overview: group name + "N items" + › arrow, with a thumbnail preview below.
 *
 * Clicking anywhere on the group box opens the group; the thumbnail preview is display only
 * (pointer-events: none) and does not trigger the card's "add to playhead". An empty media group
 * draws a dashed "Import…"; clicking it imports directly without opening the group.
 */
export function GroupBox({
  def,
  data,
  onOpen,
  onImport,
}: {
  def: GroupDef;
  data: GroupData;
  onOpen: () => void;
  onImport?: () => void;
}) {
  const count = data.items.length;
  const thumbs = (data.thumbs ?? []).slice(0, THUMB_COUNT[def.layout]);

  let body = null;
  if (count === 0) {
    if (def.empty === "import" && onImport) {
      body = (
        <button
          type="button"
          className="pc-lib-group-empty is-action"
          data-pc-add="media-empty"
          title={tr("Import media (video / audio / images, filed automatically by type)")}
          onClick={(e) => {
            // The placeholder is an import entry, not an open-group action
            e.stopPropagation();
            onImport();
          }}
        >
          {tr("Import…")}
        </button>
      );
    } else if (data.emptyHint) {
      body = <div className="pc-lib-group-empty">{data.emptyHint}</div>;
    }
  } else if (thumbs.length > 0) {
    body = (
      <div className={`pc-lib-thumbs is-${def.layout}`} aria-hidden="true">
        {thumbs.map((t) => (
          <div key={t.id} className="pc-lib-thumb">
            {t.node}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="pc-lib-group" data-pc-group={def.id} onClick={onOpen} title={def.hint}>
      {/* The header is a real button: it can take keyboard focus, and Enter / Space clicks bubble up to the group box to open the group */}
      <button type="button" className="pc-lib-group-head" aria-label={tr("Open \"{0}\", {1} items", def.title, count)}>
        <span className="pc-lib-group-text">
          <span className="pc-lib-group-name">{def.title}</span>
          <span className="pc-lib-group-count">{tr("{0} items", count)}</span>
        </span>
        <svg className="pc-lib-group-arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {body}
    </div>
  );
}
