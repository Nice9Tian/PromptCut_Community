import { useRef, useState } from "react";
import { importSrtFile } from "../io";
import { IconImport } from "../../ui/icons";
import { SearchBox } from "./SearchBox";
import { SectionHead } from "./SectionHead";
import { CaptionsTab } from "./CaptionsTab";
import { useReadOnly } from "../readOnly";

/**
 * 「字幕」分区:导入 .srt / .vtt → 搜索 → 字幕树(CaptionsTab)。
 * 当前聚焦的素材(mediaId)由 LeftPanel 持有:时间轴 / 素材库右键「转写字幕」会把它设成那份素材,
 * 它同时决定导入的字幕挂到谁身上(没有就挂第一条)。
 */
export function CaptionsSection({
  mediaId,
  onPick,
  revealToken,
  onGoImport,
}: {
  mediaId: string | null;
  onPick: (id: string | null) => void;
  /** 每次外部请求聚焦一份素材就 +1:字幕树据此展开并滚到那一项 */
  revealToken: number;
  /** 空态里「前往导入」:切到素材库分区 */
  onGoImport: () => void;
}) {
  const [search, setSearch] = useState("");
  const srtInputRef = useRef<HTMLInputElement>(null);
  // 这个项目只给了只读权限(游客):导入字幕是写
  const ro = useReadOnly();

  const handleSrtFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      await importSrtFile(files[0], { mediaId: mediaId ?? undefined });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`导入字幕失败: ${msg}`);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div data-pc="captions" className="pc-left-section">
      <SectionHead title="字幕">
        <button
          type="button"
          className="pc-btn-primary is-block pc-left-primary"
          data-pc-add="captions"
          title={ro.title("导入字幕 (.srt / .vtt)")}
          disabled={ro.locked}
          onClick={() => srtInputRef.current?.click()}
        >
          <IconImport size={16} />
          <span>导入 .srt / .vtt</span>
        </button>
        <SearchBox value={search} onChange={setSearch} placeholder="搜索字幕…" dataPc="caption-search" />
      </SectionHead>

      <div className="pc-left-pane" style={{ display: "flex" }}>
        <CaptionsTab search={search} mediaId={mediaId} onPick={onPick} onGoImport={onGoImport} revealToken={revealToken} />
      </div>

      <input ref={srtInputRef} type="file" accept=".srt,.vtt" style={{ display: "none" }} onChange={handleSrtFileChange} />
    </div>
  );
}
