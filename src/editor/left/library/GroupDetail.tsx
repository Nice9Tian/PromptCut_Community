import { Masonry } from "./Masonry";
import type { GroupCategory, GroupData, GroupDef } from "./groups";

/**
 * 打开一个组时顶部的胶囊行:`所有`(回总览)、这个组的分类(回总览并只看这一类)、
 * 组名胶囊(选中态,带 × 关闭)。
 * 分区里只有一种分类时(「动画」)分类那颗和「所有」是一回事,`showCategory={false}` 不画它。
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
    <div className="pc-lib-chips" role="toolbar" aria-label="分类">
      <button type="button" className="pc-chip" data-pc-chip="all" onClick={onAll}>
        所有
      </button>
      {showCategory && (
        <button
          type="button"
          className="pc-chip"
          data-pc-chip="category"
          title={`回到总览,只看「${def.category}」类的组`}
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
          title="关闭这个组,回到总览"
          aria-label={`关闭「${def.title}」`}
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

/** 组详情:「N 个项目」+ 上方附加内容 + 按组的 layout 瀑布流排的全部项目 + 下方附加内容 */
export function GroupDetail({ def, data, searching }: { def: GroupDef; data: GroupData; searching: boolean }) {
  const n = data.items.length;
  return (
    <div className="pc-lib-detail" data-pc={def.hook} data-pc-open-group={def.id}>
      <div className="pc-lib-count" title={def.hint}>
        {n} 个项目
      </div>
      {data.detailTop}
      {n > 0 ? (
        <Masonry layout={def.layout} items={data.items} />
      ) : (
        data.emptyDetail ?? <div className="pc-left-note">{searching ? "没有匹配的项目" : "这个组还是空的"}</div>
      )}
      {data.detailBottom}
    </div>
  );
}
