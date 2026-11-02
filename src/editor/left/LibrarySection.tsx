import { useCallback, useRef, useState } from "react";
import { IconImport } from "../../ui/icons";
import { KIND_LABEL, MEDIA_ACCEPT, importMediaFiles, type AssetKind } from "./importAssets";
import { SearchBox } from "./SearchBox";
import { SectionHead } from "./SectionHead";
import { FlashBar, useFlash } from "./useFlash";
import { useOpenGroup } from "./stored";
import { KIND_GROUP, LIBRARY_GROUPS, LIBRARY_GROUP_IDS, type GroupData } from "./library/groups";
import { GroupBrowser } from "./library/GroupBrowser";
import { useMediaGroup, useMediaMenu } from "./library/mediaGroups";
import { useCutsGroup } from "./library/cutsGroup";
import { IMPORT_OFFLINE_TEXT, useImportOffline } from "../sync/useImportOffline";
import { StorageImportButton } from "./StorageImportButton";
import { useReadOnly } from "../readOnly";
import { useUploadRejectedNotice } from "./uploadRejectedNotice";
import { tr } from "../../i18n/index.ts";

/**
 * "Media library" section: import media → search → category pills → groups (video / image / audio).
 * Cards and parts are in the "Animations" section (AnimationsSection).
 *
 * The context menu, delete confirm dialog and bottom hint bar are all mounted and rendered
 * persistently at this level,
 * not following the detail of some group: right-clicking in the overview, group detail and search
 * results all pops them up.
 * pc.left.group.library used to store card group ids: ones not in LIBRARY_GROUP_IDS are read by
 * useOpenGroup as the overview.
 */
export function LibrarySection() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q !== "";
  const [openGroup, setOpenGroup] = useOpenGroup("library", LIBRARY_GROUP_IDS);
  const [msg, flash] = useFlash();
  const mediaInputRef = useRef<HTMLInputElement>(null);
  // Online upload rejected by a quota (a guest's 4th video, for example): say so clearly in the bottom hint bar, and stay a bit longer
  const showRejected = useCallback((text: string) => flash(text, 8000), [flash]);
  useUploadRejectedNotice(showRejected);

  // The three media groups share one context menu
  const mediaMenu = useMediaMenu(flash);
  const videos = useMediaGroup("video", q, mediaMenu.openMenu);
  const images = useMediaGroup("image", q, mediaMenu.openMenu);
  const music = useMediaGroup("audio", q, mediaMenu.openMenu);

  const cuts = useCutsGroup(q, flash);

  const data: Record<string, GroupData> = { videos, images, music, cuts: cuts.data };

  // When the online browser is offline, importing media is greyed out with the hint "Currently offline" (desktop app imports as usual and uploads once connected; 2026-10-22 user decision)
  const importOffline = useImportOffline();
  // This project only grants read-only access (guest): import is a write, so the button is greyed out
  // and the "Import…" placeholder in an empty group is not shown either
  const ro = useReadOnly();
  const importMedia = useCallback(() => { if (!importOffline && !ro.locked) mediaInputRef.current?.click(); }, [importOffline, ro.locked]);

  const handleMediaFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const { counts, skipped, firstKind, rejected } = await importMediaFiles(files);
      // After an import, take the user to the group where the media landed, so they can see it came in
      if (firstKind) setOpenGroup(KIND_GROUP[firstKind]);
      if (skipped.length > 0) {
        const done = (Object.keys(counts) as AssetKind[])
          .filter((k) => counts[k] > 0)
          .map((k) => `${KIND_LABEL[k]} ${counts[k]}`)
          .join(tr(", "));
        const details = rejected.length ? `\n\n${rejected.join("\n")}` : "";
        alert(tr("{0}These files are not video / audio / images and were skipped:\n{1}{2}", done ? tr("Imported: {0}.\n\n", done) : "", skipped.join("\n"), details));
      }
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      alert(tr("Failed to import media: {0}", m));
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div data-pc="library" className="pc-left-section">
      <SectionHead title={tr("Media library")}>
        {/* Always-visible import: selected files are sorted by type into the video / image / audio groups */}
        <button
          type="button"
          className="pc-btn-primary is-block pc-left-primary"
          data-pc-add="media"
          title={ro.locked ? ro.why : importOffline ? IMPORT_OFFLINE_TEXT : tr("Import media (video / audio / images, filed automatically by type)")}
          disabled={importOffline || ro.locked}
          data-offline={importOffline ? "" : undefined}
          onClick={importMedia}
        >
          <IconImport size={16} />
          <span>{importOffline ? tr("Import media ({0})", IMPORT_OFFLINE_TEXT) : tr("Import media")}</span>
        </button>
        {/* Import from the user's own cloud drive: bytes do not pass through the page, the editor process
   pulls them directly (StorageImportButton) */}
        <StorageImportButton
          disabled={importOffline || ro.locked}
          disabledTitle={ro.locked ? ro.why : IMPORT_OFFLINE_TEXT}
          onImported={(kind) => setOpenGroup(KIND_GROUP[kind])}
          flash={flash}
        />
        <SearchBox value={search} onChange={setSearch} placeholder={tr("Search media…")} dataPc="search" />
      </SectionHead>

      <GroupBrowser
        groups={LIBRARY_GROUPS}
        data={data}
        searching={searching}
        openId={openGroup}
        onOpen={setOpenGroup}
        onImport={ro.locked ? undefined : importMedia}
        noMatch={tr("No matching media")}
      />

      <FlashBar msg={msg} />

      {mediaMenu.overlay}
      {cuts.overlay}

      <input ref={mediaInputRef} type="file" accept={MEDIA_ACCEPT} multiple style={{ display: "none" }} onChange={handleMediaFileChange} />
    </div>
  );
}
