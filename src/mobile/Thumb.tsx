/**
 * 素材格子、缩略卡上的真画面(规则见 `thumbs.ts` 文件头)。取到之前、取不到时什么都不画,外层的取色底色照旧露着。
 */
import { useEffect, useRef, useState } from "react";
import type { MediaAsset } from "../kernel/project";
import { usePreviewMediaUrl } from "../editor/media/previewUrl";
import { useTierHashes } from "../editor/media/assetTiers";
import { originalHashOf } from "../render/mediaTier";
import { createThumbLoader, fetchableNow, grabFrame, thumbKey, type ThumbKind } from "./thumbs";

const loader = createThumbLoader({ grab: grabFrame });

/** 进了视口附近(上下左右各多看一屏的一小截)才去取 */
const NEAR = "120px";
/**
 * 取不到时隔一会儿再试(刚导入的素材还在上传,素材服务先答 404):2、4、8、15、15、15 秒,试满就停,
 * 等格子下次出现(面板重开)或素材上传完(`pending` 变了)再从头试。只为不让刚导入的格子一直是底色。
 */
const RETRY_MS = [2000, 4000, 8000, 15000, 15000, 15000];

/**
 * 给一个素材(和取帧时刻)拿缩略图。返回挂到 <img> 上的 ref 与地址:地址为 null 时别显示。
 * 声音、没有素材、预览地址是 ""(在线页面远程地址还没就绪、确认缺失)时一律 null,不发请求。
 */
export function useThumb(media: MediaAsset | null | undefined, t = 0): { ref: React.RefObject<HTMLImageElement | null>; src: string | null } {
  const kind: ThumbKind | null = media?.kind === "video" ? "video" : media?.kind === "image" ? "image" : null;
  const url = usePreviewMediaUrl(kind ? media : null);
  const ref = useRef<HTMLImageElement | null>(null);
  const key = kind && url ? thumbKey(url, kind, t) : "";
  const [attempt, setAttempt] = useState(0);
  const pending = !!media?.pending;
  // 素材服务还没收全这份就先不取(否则刚导入时控制台一串 404);收全了轮询结果一变就开始取
  const tiers = useTierHashes();
  const canFetch = !!url && fetchableNow(url, tiers, pending, media ? originalHashOf(media) : null);
  useEffect(() => setAttempt(0), [key, pending]);
  useEffect(() => (key ? loader.watch(key, (v) => setGot({ key, src: v })) : undefined), [key]);
  const [got, setGot] = useState<{ key: string; src: string } | null>(() => (key ? (() => { const s = loader.peek(key); return s ? { key, src: s } : null; })() : null));

  useEffect(() => {
    if (!key || !kind || !canFetch) return;
    const hit = loader.peek(key);
    if (hit) { setGot({ key, src: hit }); return; }
    const el = ref.current;
    let cancel: (() => void) | null = null;
    let retry = 0;
    const start = () => {
      if (cancel) return;
      cancel = loader.request(url, kind, t, (v) => {
        if (v) { setGot({ key, src: v }); return; }
        if (attempt < RETRY_MS.length) retry = window.setTimeout(() => setAttempt((n) => n + 1), RETRY_MS[attempt]);
      });
    };
    const stop = () => { cancel?.(); cancel = null; window.clearTimeout(retry); };
    if (!el || typeof IntersectionObserver === "undefined") { start(); return stop; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) start();
      else stop();
    }, { rootMargin: NEAR });
    io.observe(el);
    return () => { io.disconnect(); stop(); };
    // url 里的票据会轮换,key 不变就不重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, pending, canFetch]);

  return { ref, src: got && got.key === key ? got.src : null };
}

/** 盖在格子 / 缩略卡底色上的那张图;没取到时透明占位(留着让视口观察器量得到它) */
export function ThumbImg({ thumb }: { thumb: { ref: React.RefObject<HTMLImageElement | null>; src: string | null } }) {
  return <img ref={thumb.ref} className="thumb-img" alt="" draggable={false} data-pcm="thumb-img" data-ready={thumb.src ? "1" : undefined}
    src={thumb.src ?? undefined} style={thumb.src ? undefined : { opacity: 0 }} />;
}
