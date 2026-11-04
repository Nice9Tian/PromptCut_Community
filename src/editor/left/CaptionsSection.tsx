import { useRef, useState } from "react";
import { importSrtFile } from "../io";
import { IconImport } from "../../ui/icons";
import { SearchBox } from "./SearchBox";
import { SectionHead } from "./SectionHead";
import { CaptionsTab } from "./CaptionsTab";
import { useReadOnly } from "../readOnly";
import { tr } from "../../i18n/index.ts";

/**
 * The "Captions" section: import .srt / .vtt → search → caption tree (CaptionsTab).
 * The currently focused media (mediaId) is held by LeftPanel: right-click "Transcribe captions" on the
 * timeline / media library sets it to that media.
 * It also decides which media imported captions attach to (the first one if none is set).
 */
export function CaptionsSection({
  mediaId,
  onPick,
  revealToken,
  onGoImport,
}: {
  mediaId: string | null;
  onPick: (id: string | null) => void;
  /** Incremented each time something outside asks to focus a media: the caption tree expands and scrolls to that item */
  revealToken: number;
  /** "Go to import" in the empty state: switch to the media library section */
  onGoImport: () => void;
}) {
  const [search, setSearch] = useState("");
  const srtInputRef = useRef<HTMLInputElement>(null);
  // This project only grants read-only access (guest): importing captions is a write
  const ro = useReadOnly();

  const handleSrtFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      await importSrtFile(files[0], { mediaId: mediaId ?? undefined });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(tr("Failed to import captions: {0}", msg));
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div data-pc="captions" className="pc-left-section">
      <SectionHead title={tr("Captions")}>
        <button
          type="button"
          className="pc-btn-primary is-block pc-left-primary"
          data-pc-add="captions"
          title={ro.title(tr("Import captions (.srt / .vtt)"))}
          disabled={ro.locked}
          onClick={() => srtInputRef.current?.click()}
        >
          <IconImport size={16} />
          <span>{tr("Import .srt / .vtt")}</span>
        </button>
        <SearchBox value={search} onChange={setSearch} placeholder={tr("Search captions…")} dataPc="caption-search" />
      </SectionHead>

      <div className="pc-left-pane" style={{ display: "flex" }}>
        <CaptionsTab search={search} mediaId={mediaId} onPick={onPick} onGoImport={onGoImport} revealToken={revealToken} />
      </div>

      <input ref={srtInputRef} type="file" accept=".srt,.vtt" style={{ display: "none" }} onChange={handleSrtFileChange} />
    </div>
  );
}
