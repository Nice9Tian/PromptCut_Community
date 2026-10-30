import type { GroupLayout } from "./layout";
import type { GroupData, GroupDef } from "./groups";

/** 总览里每种 layout 露几个缩略:small_cube 两行四列,其余两个 */
const THUMB_COUNT: Record<GroupLayout, number> = { small_cube: 8, middle_cube: 2, big_16_9: 2, big_strip: 2 };

/**
 * 总览里的一个组框:组名 + 「N 个项」+ › 箭头,下面是缩略预览。
 *
 * 点组框任意位置都是打开这个组;缩略预览是纯展示(pointer-events: none),
 * 不会触发卡片的「加到播放头」。空的素材类组画一个虚线「导入…」,点它直接导入,不打开组。
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
          title="导入素材(视频 / 音频 / 图片,按类型自动归位)"
          onClick={(e) => {
            // 占位是导入入口,不是打开组
            e.stopPropagation();
            onImport();
          }}
        >
          导入…
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
      {/* 头部是个真按钮:键盘能聚焦,回车 / 空格的点击冒泡到组框上打开组 */}
      <button type="button" className="pc-lib-group-head" aria-label={`打开「${def.title}」,${count} 个项`}>
        <span className="pc-lib-group-text">
          <span className="pc-lib-group-name">{def.title}</span>
          <span className="pc-lib-group-count">{count} 个项</span>
        </span>
        <svg className="pc-lib-group-arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {body}
    </div>
  );
}
