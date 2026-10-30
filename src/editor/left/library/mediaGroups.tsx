import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actions, useStore } from "../../../store/project";
import { DEFAULT_MEDIA_DUR, type MediaAsset } from "../../../kernel/project";
import { clearDragPayload, MIME_MEDIA, setDragPayload } from "../../dnd";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu";
import { ConfirmDialog } from "../ConfirmDialog";
import { PreviewCard } from "../PreviewCard";
import { requestCaptions } from "../captionsBus";
import { AudioStrip } from "./AudioStrip";
import { useMediaTierPolicy, usePreviewMediaUrl } from "../../media/previewUrl";
import { mediaTierPolicy, originalMediaUrl, previewMediaUrl } from "../../../render/mediaTier";
import { ThumbTile } from "./ThumbTile";
import type { GroupData, GroupItem } from "./groups";
import { onlinePage, onlineUnsupported } from "../../../online/pageFlag";
import { useReadOnly } from "../../readOnly";

/**
 * 素材库的视频 / 图片 / 音频三个组:导入进来的素材。
 * 视频和图片是按素材比例排的预览卡(瀑布流),音频是一条条带波形的音频条。
 * 拖到时间轴、右键菜单(转写字幕 / 创建为声音 / 取比例 / 删除素材 + 确认框)都保留;
 * 右键菜单和确认框由分区这一级常驻渲染(useMediaMenu 的 overlay),在总览、详情、搜索结果里都能弹出来。
 */

async function measureVideoDimensions(url: string): Promise<{ width: number; height: number }> {
  if (!url) {
    throw new Error("视频 URL 为空");
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.style.display = "none";
    document.body.appendChild(video);

    let finished = false;
    const cleanup = () => {
      if (!finished) {
        finished = true;
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("读取视频元数据超时"));
    }, 5000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      const width = video.videoWidth;
      const height = video.videoHeight;
      cleanup();
      if (width > 0 && height > 0) {
        resolve({ width, height });
      } else {
        reject(new Error("未能读取到有效的视频尺寸"));
      }
    };

    video.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("加载视频元数据失败"));
    };

    video.src = url;
  });
}

async function measureImageDimensions(url: string): Promise<{ width: number; height: number }> {
  if (!url) {
    throw new Error("图片 URL 为空");
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("读取图片尺寸超时")), 5000);
    img.onload = () => {
      clearTimeout(timer);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      } else {
        reject(new Error("未能读取到有效的图片尺寸"));
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("加载图片失败"));
    };
    img.src = url;
  });
}

/** 空态和「没有匹配的…」里的称呼跟着组走,免得音频组也说「视频」 */
const KIND_NOUN: Record<MediaAsset["kind"], string> = { video: "视频", audio: "配乐", image: "图片" };

/** 时长写成 m:ss(0:13),角标和音频条都用它 */
export function fmtDur(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 高 / 宽;没量到尺寸就给 undefined,排版按 9/16 兜底 */
const aspectOf = (m: MediaAsset): number | undefined =>
  m.width && m.height && m.width > 0 && m.height > 0 ? m.height / m.width : undefined;

const transcriptNote = (m: MediaAsset): string | undefined =>
  m.transcript ? `字幕 ${m.transcript.segments.length} 段` : undefined;

function startMediaDrag(e: React.DragEvent, m: MediaAsset) {
  e.dataTransfer.setData(MIME_MEDIA, m.id);
  e.dataTransfer.effectAllowed = "copy";
  setDragPayload({ kind: "media", mediaId: m.id, name: m.name, duration: m.duration ?? DEFAULT_MEDIA_DUR });
}

/**
 * 视频 / 图片的预览卡。视频:平时停在首帧,悬停时静音循环播,底边一条强调色
 * 进度条跟着播放位置走(只看不拖),左下角是时长;图片:整张按比例裁切铺满,底下写尺寸。
 */
function MediaTile({ m, onContextMenu }: { m: MediaAsset; onContextMenu: (e: React.MouseEvent) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hot, setHot] = useState(false);
  // 桌面是 m.url;在线浏览器模式换成远程素材服务的地址(只用小尺寸的素材只给小尺寸),没就绪时不挂 src
  const src = usePreviewMediaUrl(m) || undefined;
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hot) {
      v.currentTime = 0;
      // 自动播放被浏览器拒了就算了,首帧还在
      v.play().catch(() => {});
    } else {
      v.pause();
      // 回到首帧:下次悬停从头看,不悬停时卡上也是可辨认的一帧
      try { v.currentTime = 0; } catch { /* 还没加载出元数据 */ }
      setProgress(null);
    }
  }, [hot]);

  const preview =
    m.kind === "image" ? (
      <img src={src} alt="" draggable={false} />
    ) : (
      <video
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload="metadata"
        draggable={false}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (hot && el.duration > 0) setProgress(el.currentTime / el.duration);
        }}
      />
    );

  const subtitle =
    m.kind === "image" ? (m.width && m.height ? `${m.width}×${m.height}` : undefined) : transcriptNote(m);

  return (
    <PreviewCard
      attrs={{ "data-pc-media": m.id }}
      title={m.name}
      subtitle={subtitle}
      badge={m.kind === "video" ? fmtDur(m.duration) : undefined}
      preview={preview}
      progress={m.kind === "video" && hot ? (progress ?? 0) : null}
      onHover={setHot}
      draggable
      edits
      onDragStart={(e) => startMediaDrag(e, m)}
      onDragEnd={clearDragPayload}
      onContextMenu={onContextMenu}
      titleAttr={m.kind === "video" ? "悬停预览;拖动 = 拖到时间轴;右键 = 更多" : "拖动 = 拖到时间轴;右键 = 更多"}
      fill
    />
  );
}

/**
 * 总览里的缩略:图片 / 视频首帧 + 时长角标。
 * 视频:指针停在这一格上时静音从头循环播,移开就停下、回到首帧(只有悬停的那一格在播);
 * 除此之外不接任何交互,点下去照样冒泡到组框上打开组。
 * 格子被整块藏起来时(点开了组、切走分区、收起抽屉)不一定收得到 mouseleave,
 * 所以播放中每次 timeupdate 顺手看一眼自己还有没有布局盒,没有就停。
 */
function MediaThumb({ m }: { m: MediaAsset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const src = usePreviewMediaUrl(m) || undefined;

  const stop = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    try { v.currentTime = 0; } catch { /* 还没加载出元数据 */ }
  }, []);

  const onHover = useCallback(
    (hot: boolean) => {
      const v = videoRef.current;
      if (!v) return;
      if (!hot) {
        stop();
        return;
      }
      try { v.currentTime = 0; } catch { /* 还没加载出元数据 */ }
      // 自动播放被浏览器拒了、或者还没播起来就移开了(play 被 pause 打断)都算了,首帧还在
      v.play().catch(() => {});
    },
    [stop],
  );

  if (m.kind === "image") {
    return <ThumbTile preview={<img src={src} alt="" draggable={false} />} />;
  }
  return (
    <ThumbTile
      badge={fmtDur(m.duration)}
      onHover={onHover}
      preview={
        <video
          ref={videoRef}
          src={src}
          muted
          loop
          playsInline
          preload="metadata"
          draggable={false}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (!v.paused && v.getClientRects().length === 0) stop();
          }}
        />
      }
    />
  );
}

const audioSub = (m: MediaAsset) => [fmtDur(m.duration), transcriptNote(m)].filter(Boolean).join(" · ");

/** 音频一条:名字 + 时长(+ 已有字幕的段数),背景是整段波形。转写入口在右键菜单里 */
function AudioRow({ m, onContextMenu }: { m: MediaAsset; onContextMenu: (e: React.MouseEvent) => void }) {
  const url = usePreviewMediaUrl(m) || undefined;
  return (
    <AudioStrip
      attrs={{ "data-pc-media": m.id }}
      className="is-grab"
      name={m.name}
      sub={audioSub(m)}
      url={url}
      draggable
      edits
      onDragStart={(e) => startMediaDrag(e, m)}
      onDragEnd={clearDragPayload}
      onContextMenu={onContextMenu}
      title="拖动 = 拖到时间轴;右键 = 转写字幕 / 删除"
    />
  );
}

function EmptyMedia({ noun }: { noun: string }) {
  return (
    <div className="pc-left-empty">
      <div>
        <div className="pc-left-empty-icon" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M10 9l5 3-5 3z" />
          </svg>
        </div>
        <div className="pc-left-empty-text">
          还没有导入的{noun}。
          <br />
          点上面的导入按钮加进来。
        </div>
      </div>
    </div>
  );
}

/**
 * 素材的右键菜单 + 删除确认框。分区调一次,把 overlay 放在分区根节点里常驻渲染。
 * 菜单项:转写 / 查看字幕(有声音的才有)、创建为声音(视频才有)、取比例(有画面的才有)、删除。
 */
export function useMediaMenu(flash: (text: string, ms?: number) => void) {
  const [ctx, setCtx] = useState<{ x: number; y: number; media: MediaAsset } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ mediaId: string; name: string } | null>(null);
  // 这个项目只给了只读权限(游客):右键里只留「查看字幕」,别的(转写、创建为声音、改项目比例、删除)都是写,置灰并说明
  const ro = useReadOnly();

  const openMenu = useCallback((e: React.MouseEvent, m: MediaAsset) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, media: m });
  }, []);
  const closeMenu = useCallback(() => setCtx(null), []);

  const guardMenu = (items: ContextMenuItem[]): ContextMenuItem[] =>
    ro.locked ? items.map((it) => (it.label === "查看字幕" ? it : { ...it, disabled: true, title: ro.why })) : items;

  const handleApplyAspectRatio = async (m: MediaAsset) => {
    try {
      let width = m.width;
      let height = m.height;
      if (!width || !height || width <= 0 || height <= 0) {
        // 图片得用 <img> 量,拿 <video> 读它只会报「加载视频元数据失败」
        // 量的必须是原尺寸(量小尺寸会把画幅设小):桌面原样 m.url,在线页面走远程素材服务上的原尺寸。
        // 最低一档平时不拉原尺寸:素材没记下宽高就不量,照实说
        const policy = mediaTierPolicy();
        const url = policy.smallOnly ? "" : originalMediaUrl(m, policy);
        if (!url) { alert("这份素材没有记下分辨率，在这台设备上量不了"); return; }
        const measured = m.kind === "image" ? await measureImageDimensions(url) : await measureVideoDimensions(url);
        width = measured.width;
        height = measured.height;
      }
      if (width > 0 && height > 0) {
        actions.setProjectMeta({ width, height });
      } else {
        alert("未能获取视频的有效分辨率");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`获取视频分辨率失败: ${msg}`);
    }
  };

  const menuItems = (m: MediaAsset): ContextMenuItem[] => guardMenu([
    ...(m.kind === "image"
      ? []
      : [
          {
            label: m.transcript ? "查看字幕" : "转写字幕",
            hint: m.transcript ? `${m.transcript.segments.length} 段` : undefined,
            // 在线浏览器模式没有语音识别(C10 契约第 10 节):没有字幕的只能转写,置灰;已有字幕的照常查看
            ...(!m.transcript && onlinePage() ? { disabled: true, title: onlineUnsupported("语音识别") } : {}),
            // 走全局入口:左栏切到「字幕」分区、展开抽屉、聚焦这份素材
            onClick: () => requestCaptions(m.id),
          },
        ]),
    // 视频派生出「只要声音」的一份:同一个文件、不转码,拖到时间轴上就是纯音频段
    ...(m.kind === "video"
      ? [
          {
            label: "创建为声音",
            hint: "音频组",
            onClick: () => {
              const r = actions.audioFromVideo(m.id);
              flash(
                r.ok
                  ? r.created
                    ? `已创建「${r.media.name}」,在「音频」组`
                    : `「${r.media.name}」早就建过了,在「音频」组`
                  : r.error,
                3000,
              );
            },
          },
        ]
      : []),
    ...(m.kind === "audio"
      ? []
      : [
          {
            label: m.kind === "image" ? "以图片比例作为项目比例" : "以视频比例作为项目比例",
            hint: m.width && m.height && m.width > 0 && m.height > 0 ? `${m.width}x${m.height}` : undefined,
            onClick: () => handleApplyAspectRatio(m),
          },
        ]),
    {
      label: "删除素材",
      danger: true,
      onClick: () => setConfirmDelete({ mediaId: m.id, name: m.name }),
    },
  ]);

  const overlay = (
    <>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={menuItems(ctx.media)} onClose={closeMenu} />}
      {confirmDelete && (
        <ConfirmDialog
          open={true}
          title="删除素材"
          message={`确定删除「${confirmDelete.name}」?\n时间轴上引用它的片段会一起删除。`}
          onConfirm={() => {
            actions.removeMedia(confirmDelete.mediaId);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  );

  return { openMenu, overlay };
}

/** 一种素材的组内容。q 是已经 trim + 小写的搜索词 */
export function useMediaGroup(
  kind: MediaAsset["kind"],
  q: string,
  openMenu: (e: React.MouseEvent, m: MediaAsset) => void,
): GroupData {
  const allMedia = useStore((s) => s.project.media);
  const tierPolicy = useMediaTierPolicy();
  return useMemo(() => {
    const list = allMedia.filter((m) => m.kind === kind);
    const hits = q ? list.filter((m) => m.name.toLowerCase().includes(q)) : list;
    const noun = KIND_NOUN[kind];
    const items: GroupItem[] = hits.map((m) =>
      kind === "audio"
        ? { id: m.id, node: <AudioRow m={m} onContextMenu={(e) => openMenu(e, m)} /> }
        : { id: m.id, aspect: aspectOf(m), node: <MediaTile m={m} onContextMenu={(e) => openMenu(e, m)} /> },
    );
    const thumbs: GroupItem[] = hits.slice(0, 2).map((m) => ({
      id: m.id,
      node: kind === "audio" ? <AudioStrip name={m.name} sub={audioSub(m)} url={previewMediaUrl(m, tierPolicy) || undefined} /> : <MediaThumb m={m} />,
    }));
    return {
      items,
      thumbs,
      emptyDetail: list.length === 0 ? <EmptyMedia noun={noun} /> : <div className="pc-left-note">没有匹配的{noun}</div>,
    };
  }, [allMedia, kind, q, openMenu, tierPolicy]);
}
