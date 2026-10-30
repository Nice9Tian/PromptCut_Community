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

/**
 * 「素材库」分区:导入媒体 → 搜索 → 分类胶囊 → 分组(视频 / 图片 / 音频)。
 * 卡片、部件在「动画」分区(AnimationsSection)。
 *
 * 右键菜单、删除确认框、底部提示条都挂在这一级常驻渲染,
 * 不跟着某个组的详情走 —— 在总览、组详情、搜索结果里右键都弹得出来。
 * 以前 pc.left.group.library 里存过卡片组的 id:不在 LIBRARY_GROUP_IDS 里,useOpenGroup 读出来就是总览。
 */
export function LibrarySection() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q !== "";
  const [openGroup, setOpenGroup] = useOpenGroup("library", LIBRARY_GROUP_IDS);
  const [msg, flash] = useFlash();
  const mediaInputRef = useRef<HTMLInputElement>(null);
  // 在线上传被限额拒掉的（游客第 4 条视频之类）：在底部提示条说清楚，多停一会儿
  const showRejected = useCallback((text: string) => flash(text, 8000), [flash]);
  useUploadRejectedNotice(showRejected);

  // 素材三组共用一份右键菜单
  const mediaMenu = useMediaMenu(flash);
  const videos = useMediaGroup("video", q, mediaMenu.openMenu);
  const images = useMediaGroup("image", q, mediaMenu.openMenu);
  const music = useMediaGroup("audio", q, mediaMenu.openMenu);

  const cuts = useCutsGroup(q, flash);

  const data: Record<string, GroupData> = { videos, images, music, cuts: cuts.data };

  // 在线浏览器断网时导入媒体置灰、提示「当前离线」(桌面版照常导入,连上后再上传;2026-10-22 用户定)
  const importOffline = useImportOffline();
  // 这个项目只给了只读权限(游客):导入是写,按钮置灰、空组里的「导入…」占位也不出
  const ro = useReadOnly();
  const importMedia = useCallback(() => { if (!importOffline && !ro.locked) mediaInputRef.current?.click(); }, [importOffline, ro.locked]);

  const handleMediaFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const { counts, skipped, firstKind, rejected } = await importMediaFiles(files);
      // 导入完成后把用户带到素材落地的那个组,让他看见东西进来了
      if (firstKind) setOpenGroup(KIND_GROUP[firstKind]);
      if (skipped.length > 0) {
        const done = (Object.keys(counts) as AssetKind[])
          .filter((k) => counts[k] > 0)
          .map((k) => `${KIND_LABEL[k]} ${counts[k]}`)
          .join("、");
        const details = rejected.length ? `\n\n${rejected.join("\n")}` : "";
        alert(`${done ? `已导入:${done}。\n\n` : ""}这些文件不是视频 / 音频 / 图片,已跳过:\n${skipped.join("\n")}${details}`);
      }
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      alert(`导入素材失败: ${m}`);
    } finally {
      e.target.value = "";
    }
  };

  return (
    <div data-pc="library" className="pc-left-section">
      <SectionHead title="素材库">
        {/* 常驻的导入:选进来的文件按类型自动落到视频 / 图片 / 音频组 */}
        <button
          type="button"
          className="pc-btn-primary is-block pc-left-primary"
          data-pc-add="media"
          title={ro.locked ? ro.why : importOffline ? IMPORT_OFFLINE_TEXT : "导入素材(视频 / 音频 / 图片,按类型自动归位)"}
          disabled={importOffline || ro.locked}
          data-offline={importOffline ? "" : undefined}
          onClick={importMedia}
        >
          <IconImport size={16} />
          <span>{importOffline ? `导入媒体（${IMPORT_OFFLINE_TEXT}）` : "导入媒体"}</span>
        </button>
        {/* 从用户自己的网盘导入:字节不经过页面,由编辑器进程直接拉(StorageImportButton) */}
        <StorageImportButton
          disabled={importOffline || ro.locked}
          disabledTitle={ro.locked ? ro.why : IMPORT_OFFLINE_TEXT}
          onImported={(kind) => setOpenGroup(KIND_GROUP[kind])}
          flash={flash}
        />
        <SearchBox value={search} onChange={setSearch} placeholder="搜索素材…" dataPc="search" />
      </SectionHead>

      <GroupBrowser
        groups={LIBRARY_GROUPS}
        data={data}
        searching={searching}
        openId={openGroup}
        onOpen={setOpenGroup}
        onImport={ro.locked ? undefined : importMedia}
        noMatch="没有匹配的素材"
      />

      <FlashBar msg={msg} />

      {mediaMenu.overlay}
      {cuts.overlay}

      <input ref={mediaInputRef} type="file" accept={MEDIA_ACCEPT} multiple style={{ display: "none" }} onChange={handleMediaFileChange} />
    </div>
  );
}
